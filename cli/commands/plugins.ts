import { ApiError, segment, type Client } from '../client'
import { arg, emit, flag, records, stringOpt, textArg, UsageError, type Command, type Context } from '../command'
import { cell, keyValue, table } from '../format'

type Json = Record<string, unknown>

const pluginPath = (id: string, suffix = ''): string => `/api/plugins/${segment(id)}${suffix}`

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function callPlugin(client: Client, id: string, method: string, params: unknown = {}): Promise<unknown> {
  try {
    const body = await client.post(pluginPath(id, '/call'), { method, params })
    return isRecord(body) ? body.result : body
  } catch (error) {
    if (error instanceof ApiError && error.message === `No method ${method}`) throw new UsageError(`${id} is too old for this (it has no ${method}); update it with: shiki plugin update ${id} --yes`)
    if (error instanceof ApiError && error.status === 404 && error.message === 'That plugin is not installed') throw new UsageError(`${id} is not installed; see: shiki plugin catalog`)
    throw error
  }
}

const networkLine = (entry: string): string => (entry.startsWith('*.') ? `Reach any address ending in ${entry.slice(1)}` : `Reach ${entry}`)

function permissionLines(permissions: unknown): string[] {
  if (!isRecord(permissions)) return []
  const network = Array.isArray(permissions.network) ? permissions.network.map(String) : []
  const sessions = Array.isArray(permissions.sessions) ? permissions.sessions.map(String) : []
  return [
    ...network.map(networkLine),
    ...(sessions.includes('chat') ? ['Start chats'] : []),
    ...(sessions.includes('terminal') ? ['Start terminals'] : []),
    ...(permissions.settings === true ? ['Keep its own settings'] : []),
  ]
}

function pluginsText(value: unknown): string {
  const plugins = records(value, 'plugins')
  if (plugins.length === 0) return 'No plugins installed. Add one with: shiki plugin add <link>\n'
  return table(plugins, [
    { header: 'ID', value: (plugin) => cell(plugin.id) },
    { header: 'VERSION', value: (plugin) => cell(plugin.version) },
    { header: 'RUNTIME', value: (plugin) => cell(plugin.runtime) },
    { header: 'STATE', value: (plugin) => (plugin.enabled === false ? 'off' : plugin.restartRequired === true ? 'restart to finish update' : cell(plugin.state ?? 'on')) },
    { header: 'NAME', value: (plugin) => cell(plugin.name) },
  ])
}

function catalogText(value: unknown): string {
  const entries = records(value, 'entries')
  if (entries.length === 0) return 'No marketplaces yet. Add one with: shiki plugin add <marketplace link>\n'
  return entries.map((entry) => {
    if (typeof entry.error === 'string') return `${cell(entry.marketplace)}\n  ${entry.error}\n`
    const plugins = Array.isArray(entry.plugins) ? entry.plugins.filter(isRecord) : []
    const head = `${cell(entry.name ?? entry.marketplace)} (${cell(entry.marketplace)})\n`
    if (plugins.length === 0) return `${head}  (no plugins)\n`
    return head + table(plugins, [
      { header: '  ID', value: (plugin) => `  ${cell(plugin.id)}` },
      { header: 'REF', value: (plugin) => cell(plugin.ref) },
      { header: 'RUNTIME', value: (plugin) => cell(plugin.runtime) },
      { header: 'DESCRIPTION', value: (plugin) => cell(plugin.description) },
    ])
  }).join('\n')
}

const CONTRIBUTION_LINES = [
  { key: 'agents', line: (path: string) => `Add the agent ${path} to your engines` },
  { key: 'skills', line: (path: string) => `Add the skill ${path} to your engines` },
  { key: 'flows', line: (path: string) => `Add the Studio flow ${path}` },
] as const

function contributionLines(preview: Json): string[] {
  const manifest = isRecord(preview.manifest) ? preview.manifest : {}
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : {}
  return CONTRIBUTION_LINES.flatMap((kind) => {
    const paths = contributes[kind.key]
    return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string').map(kind.line) : []
  })
}

function needsTrust(preview: Json): boolean {
  return preview.runtime === 'trusted' || contributionLines(preview).length > 0
}

function previewText(preview: Json): string {
  const manifest = isRecord(preview.manifest) ? preview.manifest : {}
  const contributions = contributionLines(preview)
  const lines = [
    `${cell(manifest.name)} ${cell(manifest.version)} (${cell(preview.runtime)})`,
    ...(preview.runtime === 'trusted'
      ? ['Trusted: runs inside Shikidan with full access to your files, tokens and the internet.']
      : ['Isolated. It will be able to:', ...permissionLines(preview.permissions).map((line) => `  - ${line}`)]),
    ...(contributions.length > 0
      ? ['It adds work to your engines, which runs with your full access:', ...contributions.map((line) => `  - ${line}`)]
      : []),
  ]
  return `${lines.join('\n')}\n`
}

async function installFromPreview(ctx: Context, repo: string, ref: string, preview: Json): Promise<void> {
  if (preview.runtime === 'trusted' && !flag(ctx, 'trust')) throw new UsageError('this plugin is trusted (full access); add --trust to install it')
  if (contributionLines(preview).length > 0 && !flag(ctx, 'trust')) throw new UsageError('this plugin adds agents, skills or flows that run with your access; add --trust to install it')
  const body = { repo, ref, commit: String(preview.commit ?? ''), ...(needsTrust(preview) ? { trust: true } : {}) }
  const installed = await ctx.client.post('/api/plugins/install', body)
  emit(ctx, installed, (value) => {
    const plugin = isRecord(value) && isRecord(value.plugin) ? value.plugin : {}
    return `Installed ${cell(plugin.name)} ${cell(plugin.version)}.\n`
  })
}

async function addFromLink(ctx: Context): Promise<void> {
  const url = arg(ctx, 'link')
  const ref = stringOpt(ctx, 'ref')
  const result = await ctx.client.post('/api/plugins/add-link', { url, ...(ref === undefined ? {} : { ref }) })
  if (!isRecord(result)) throw new Error('Shikidan answered without a result')
  if (result.kind === 'marketplace') {
    emit(ctx, result, () => 'Marketplace added. List its plugins with: shiki plugin catalog\n')
    return
  }
  if (!flag(ctx, 'yes')) {
    emit(ctx, result, (value) => `${previewText(value as Json)}Version ${cell(result.ref)}. Run again with --yes${needsTrust(result as Json) ? ' --trust' : ''} to install.\n`)
    return
  }
  await installFromPreview(ctx, url, String(result.ref), result)
}

async function targetRef(client: Client, plugin: Json): Promise<string> {
  const source = isRecord(plugin.source) ? plugin.source : {}
  const marketplace = typeof source.marketplace === 'string' ? source.marketplace : undefined
  if (marketplace === undefined) return String(source.ref ?? '')
  await client.post('/api/plugins/marketplaces', { url: marketplace })
  const catalog = await client.get('/api/plugins/catalog')
  const listing = records(catalog, 'entries')
    .flatMap((entry) => (Array.isArray(entry.plugins) ? entry.plugins.filter(isRecord) : []))
    .find((candidate) => candidate.id === plugin.id)
  return String(listing?.ref ?? source.ref ?? '')
}

async function updatePlugin(ctx: Context): Promise<void> {
  const id = arg(ctx, 'id')
  const plugin = records(await ctx.client.get('/api/plugins'), 'plugins').find((candidate) => candidate.id === id)
  if (plugin === undefined) throw new UsageError(`no installed plugin ${id}`)
  const source = isRecord(plugin.source) ? plugin.source : {}
  const ref = await targetRef(ctx.client, plugin)
  const preview = await ctx.client.post('/api/plugins/preview', { repo: source.repo, ref })
  if (!isRecord(preview)) throw new Error('Shikidan answered without a preview')
  if (preview.commit === plugin.commit) {
    emit(ctx, { upToDate: true, version: plugin.version }, () => `${cell(plugin.name)} ${cell(plugin.version)} is up to date.\n`)
    return
  }
  const manifest = isRecord(preview.manifest) ? preview.manifest : {}
  if (!flag(ctx, 'yes')) {
    emit(ctx, preview, () => `${cell(plugin.name)} ${cell(plugin.version)} → ${cell(manifest.version)} (${ref}). Run again with --yes to update.\n`)
    return
  }
  try {
    const updated = await ctx.client.post(pluginPath(id, '/update'), { ref, commit: preview.commit, ...(flag(ctx, 'accept') ? { accept: true } : {}), ...(flag(ctx, 'trust') ? { trust: true } : {}) })
    const next = isRecord(updated) && isRecord(updated.plugin) ? updated.plugin : {}
    emit(ctx, updated, () => `Updated ${cell(next.name)} to ${cell(next.version)}.${next.restartRequired === true ? ' Restart Shikidan to finish updating.' : ''}\n`)
  } catch (error) {
    if (!(error instanceof ApiError) || !isRecord(error.body)) throw error
    if (error.body.needsConsent === true) {
      const added = Array.isArray(error.body.added) ? error.body.added.map(String) : []
      throw new UsageError(`this update asks for more:\n${added.map((line) => `  - ${line}`).join('\n')}\nrun again with --yes --accept to allow it`)
    }
    if (error.body.needsTrust === true) throw new UsageError('this update needs your trust (it runs trusted, or adds agents, skills or flows); run again with --yes --trust')
    throw error
  }
}

async function readParams(ctx: Context): Promise<unknown> {
  const raw = stringOpt(ctx, 'params')
  if (raw === undefined) return {}
  const text = raw === '-' ? await ctx.stdin() : raw
  try {
    return JSON.parse(text)
  } catch {
    throw new UsageError('--params must be JSON (or - to read JSON from stdin)')
  }
}

function settingsText(value: unknown): string {
  if (!isRecord(value)) return keyValue(value)
  const fields = Array.isArray(value.fields) ? value.fields.filter(isRecord) : []
  const values = isRecord(value.values) ? value.values : {}
  const configured = isRecord(value.configured) ? value.configured : {}
  if (fields.length === 0) return 'This plugin declares no settings.\n'
  return table(fields, [
    { header: 'KEY', value: (field) => cell(field.key) },
    { header: 'LABEL', value: (field) => cell(field.label) },
    { header: 'VALUE', value: (field) => (field.type === 'secret' ? (configured[String(field.key)] === true ? '(set)' : '(not set)') : cell(values[String(field.key)] ?? (field.type === 'toggle' ? 'false' : '-'))) },
  ])
}

export const pluginCommands: Command[] = [
  { path: ['plugin', 'list'], summary: 'List installed plugins', run: async (ctx) => emit(ctx, await ctx.client.get('/api/plugins'), pluginsText) },
  {
    path: ['plugin', 'catalog'],
    options: { refresh: { type: 'boolean', description: 'fetch the latest listing from every marketplace first' } },
    summary: 'List the plugins your marketplaces offer',
    run: async (ctx) => {
      if (flag(ctx, 'refresh')) {
        for (const market of records(await ctx.client.get('/api/plugins/marketplaces'), 'marketplaces')) {
          await ctx.client.post('/api/plugins/marketplaces', { url: market.url }).catch((error: unknown) => ctx.err(`${String(market.url)}: ${error instanceof Error ? error.message : String(error)}\n`))
        }
      }
      emit(ctx, await ctx.client.get('/api/plugins/catalog'), catalogText)
    },
  },
  {
    path: ['plugin', 'add'],
    args: ['link'],
    options: {
      ref: { type: 'string', description: 'version, tag or branch (default: newest version tag)', placeholder: 'REF' },
      yes: { type: 'boolean', description: 'install the plugin the link points to (without it: show what it asks for)' },
      trust: { type: 'boolean', description: 'confirm a trusted plugin may have full access' },
    },
    summary: 'Add a plugin or a marketplace from a git link',
    run: addFromLink,
  },
  {
    path: ['plugin', 'update'],
    args: ['id'],
    options: {
      yes: { type: 'boolean', description: 'apply the update (without it: check only)' },
      accept: { type: 'boolean', description: 'allow the extra permissions the update asks for' },
      trust: { type: 'boolean', description: 'allow an update that runs trusted or adds agents, skills or flows' },
    },
    summary: 'Check for and apply a plugin update',
    run: updatePlugin,
  },
  {
    path: ['plugin', 'remove'],
    args: ['id'],
    options: { 'delete-data': { type: 'boolean', description: 'also delete its settings and files' } },
    summary: 'Uninstall a plugin (keeps its data unless --delete-data)',
    run: async (ctx) => emit(ctx, await ctx.client.del(pluginPath(arg(ctx, 'id')), { keepData: !flag(ctx, 'delete-data') }), () => `Removed ${arg(ctx, 'id')}.\n`),
  },
  { path: ['plugin', 'enable'], args: ['id'], summary: 'Turn a plugin on', run: async (ctx) => emit(ctx, await ctx.client.patch(pluginPath(arg(ctx, 'id')), { enabled: true }), () => `${arg(ctx, 'id')} is on.\n`) },
  { path: ['plugin', 'disable'], args: ['id'], summary: 'Turn a plugin off', run: async (ctx) => emit(ctx, await ctx.client.patch(pluginPath(arg(ctx, 'id')), { enabled: false }), () => `${arg(ctx, 'id')} is off.\n`) },
  { path: ['plugin', 'settings'], args: ['id'], summary: "Show a plugin's settings (secrets show only set or not set)", run: async (ctx) => emit(ctx, await ctx.client.get(pluginPath(arg(ctx, 'id'), '/settings')), settingsText) },
  {
    path: ['plugin', 'set'],
    args: ['id', 'key', 'value'],
    summary: 'Set a plugin setting (value - reads stdin, keeps secrets out of shell history)',
    run: async (ctx) => emit(ctx, await ctx.client.put(pluginPath(arg(ctx, 'id'), '/settings'), { key: arg(ctx, 'key'), value: await textArg(ctx, 'value') }), () => `Saved ${arg(ctx, 'key')}.\n`),
  },
  {
    path: ['plugin', 'unset'],
    args: ['id', 'key'],
    summary: 'Clear a plugin setting',
    run: async (ctx) => emit(ctx, await ctx.client.put(pluginPath(arg(ctx, 'id'), '/settings'), { key: arg(ctx, 'key'), value: null }), () => `Cleared ${arg(ctx, 'key')}.\n`),
  },
  {
    path: ['plugin', 'call'],
    args: ['id', 'method'],
    options: { params: { type: 'string', description: 'JSON params, or - to read them from stdin', placeholder: 'JSON' } },
    summary: "Call one of a plugin's own server methods",
    run: async (ctx) => emit(ctx, await callPlugin(ctx.client, arg(ctx, 'id'), arg(ctx, 'method'), await readParams(ctx)), keyValue),
  },
  { path: ['marketplace', 'list'], summary: 'List added marketplaces', run: async (ctx) => emit(ctx, await ctx.client.get('/api/plugins/marketplaces'), keyValue) },
  { path: ['marketplace', 'add'], args: ['url'], summary: 'Add (or refresh) a marketplace', run: async (ctx) => emit(ctx, await ctx.client.post('/api/plugins/marketplaces', { url: arg(ctx, 'url') }), () => 'Marketplace added.\n') },
  { path: ['marketplace', 'remove'], args: ['url'], summary: 'Remove a marketplace', run: async (ctx) => emit(ctx, await ctx.client.del('/api/plugins/marketplaces', { url: arg(ctx, 'url') }), () => 'Marketplace removed.\n') },
]
