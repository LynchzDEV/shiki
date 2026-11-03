import { z } from 'zod'

export const SUPPORTED_PLUGIN_APIS = [1, 2]

export const CONTRIBUTIONS_PLUGIN_API = 2

export const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/

export const NETWORK_HOST_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

const WILDCARD_PREFIX = '*.'

export function isNetworkPermission(entry: string): boolean {
  const host = entry.startsWith(WILDCARD_PREFIX) ? entry.slice(WILDCARD_PREFIX.length) : entry
  return NETWORK_HOST_PATTERN.test(host)
}

export function networkPermissionText(entry: string): string {
  return entry.startsWith(WILDCARD_PREFIX) ? `Reach any address ending in ${entry.slice(1)}` : `Reach ${entry}`
}

export type SettingFieldType = 'text' | 'secret' | 'toggle'

export type SettingField = { key: string; label: string; type: SettingFieldType; help?: string }

export type PluginRuntime = 'trusted' | 'isolated'

export type SessionKind = 'chat' | 'terminal'

export type PluginPermissions = {
  network?: string[]
  sessions?: SessionKind[]
  settings?: boolean
}

export type PluginContributions = { agents?: string[]; skills?: string[]; flows?: string[] }

export type PluginRequirement = { id: string; version?: string }

export const MAX_REQUIREMENTS = 10

export const REQUIREMENT_VERSION_PATTERN = /^\d+(\.\d+){0,2}$/

export type PluginManifest = {
  id: string
  name: string
  version: string
  description: string
  pluginApi: number
  runtime: PluginRuntime
  icon?: string
  server?: string
  screen?: string
  queueSource?: boolean
  permissions: PluginPermissions
  settings?: SettingField[]
  contributes?: PluginContributions
  requires?: PluginRequirement[]
}

export type ParseManifestResult = { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] }

const settingFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['text', 'secret', 'toggle']),
  help: z.string().optional(),
})

const manifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  pluginApi: z.number(),
  runtime: z.enum(['trusted', 'isolated']),
  icon: z.string().optional(),
  server: z.string().optional(),
  screen: z.string().optional(),
  queueSource: z.boolean().optional(),
  permissions: z.object({
    network: z.array(z.string()).optional(),
    sessions: z.array(z.enum(['chat', 'terminal'])).optional(),
    settings: z.boolean().optional(),
  }),
  settings: z.array(settingFieldSchema).optional(),
  contributes: z.object({
    agents: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    flows: z.array(z.string()).optional(),
  }).optional(),
  requires: z.array(z.object({ id: z.string(), version: z.string().optional() })).optional(),
})

function insideRepoPath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.includes('\\')) return false
  return !value.split('/').includes('..')
}

export function parseManifest(raw: unknown): ParseManifestResult {
  const errors: string[] = []
  const add = (message: string) => { errors.push(message) }

  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.')
      add(path === '' ? issue.message : `${path}: ${issue.message}`)
    }
    return { ok: false, errors }
  }
  const value = parsed.data

  if (!PLUGIN_ID_PATTERN.test(value.id)) add('id must be 3-40 characters of lowercase letters, digits and dashes')
  if (!SUPPORTED_PLUGIN_APIS.includes(value.pluginApi)) {
    add(value.pluginApi > Math.max(...SUPPORTED_PLUGIN_APIS)
      ? 'This plugin needs a newer Shikidan'
      : `pluginApi ${value.pluginApi} is not supported`)
  }
  for (const field of ['icon', 'server', 'screen'] as const) {
    const path = value[field]
    if (path !== undefined && !insideRepoPath(path)) add(`${field} must be a path inside the plugin folder`)
  }
  for (const host of value.permissions.network ?? []) {
    if (!isNetworkPermission(host)) add(`network permission "${host}" must be a plain host name like api.example.com, or *. and a host like *.example.com`)
  }
  for (const error of contributionErrors(value.contributes, value.pluginApi)) add(error)
  for (const error of requirementErrors(value.requires, value.id)) add(error)
  const settingKeys = new Set<string>()
  for (const field of value.settings ?? []) {
    if (settingKeys.has(field.key)) add(`settings: the key "${field.key}" is declared more than once`)
    settingKeys.add(field.key)
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, manifest: value }
}

function requirementErrors(requires: PluginRequirement[] | undefined, selfId: string): string[] {
  if (requires === undefined) return []
  const errors: string[] = []
  if (requires.length > MAX_REQUIREMENTS) errors.push(`requires can list at most ${MAX_REQUIREMENTS} plugins`)
  const seen = new Set<string>()
  for (const entry of requires) {
    if (!PLUGIN_ID_PATTERN.test(entry.id)) errors.push(`requires: "${entry.id}" is not a valid plugin id`)
    else if (entry.id === selfId) errors.push('requires: a plugin cannot require itself')
    else if (seen.has(entry.id)) errors.push(`requires: ${entry.id} is listed more than once`)
    if (entry.version !== undefined && !REQUIREMENT_VERSION_PATTERN.test(entry.version)) errors.push(`requires: the version "${entry.version}" for ${entry.id} must look like 1.7 or 1.7.0`)
    seen.add(entry.id)
  }
  return errors
}

const CONTRIBUTION_KINDS = [
  { key: 'agents', shape: '.md file', fits: (path: string) => path.endsWith('.md') },
  { key: 'skills', shape: 'folder', fits: (path: string) => !path.endsWith('.md') && !path.endsWith('/') },
  { key: 'flows', shape: '.json file', fits: (path: string) => path.endsWith('.json') },
] as const

function contributionErrors(contributes: PluginContributions | undefined, pluginApi: number): string[] {
  if (contributes === undefined) return []
  const errors: string[] = []
  if (pluginApi < CONTRIBUTIONS_PLUGIN_API) errors.push('contributes needs pluginApi 2')
  for (const kind of CONTRIBUTION_KINDS) {
    for (const path of contributes[kind.key] ?? []) {
      if (!insideRepoPath(path) || !kind.fits(path)) errors.push(`contributes.${kind.key}: ${path} must be a ${kind.shape} inside the plugin folder`)
    }
  }
  const paths = CONTRIBUTION_KINDS.flatMap(kind => contributes[kind.key] ?? [])
  if (paths.length === 0) errors.push('contributes must list at least one agent, skill or flow')
  if (new Set(paths).size !== paths.length) errors.push('contributes must not repeat a path')
  return errors
}

const CONTRIBUTION_LABEL = {
  agents: (path: string) => `Add the agent ${path} to your engines`,
  skills: (path: string) => `Add the skill ${path} to your engines`,
  flows: (path: string) => `Add the Studio flow ${path}`,
}

export function contributionsAdded(old: PluginContributions | undefined, next: PluginContributions | undefined): string[] {
  return CONTRIBUTION_KINDS.flatMap(kind => {
    const before = new Set(old?.[kind.key] ?? [])
    return (next?.[kind.key] ?? []).filter(path => !before.has(path)).map(CONTRIBUTION_LABEL[kind.key])
  })
}

const SESSION_KIND_LABEL: Record<SessionKind, string> = { chat: 'Start chats', terminal: 'Start terminals' }

export function permissionsAdded(old: PluginPermissions, next: PluginPermissions): string[] {
  const oldHosts = new Set(old.network ?? [])
  const hosts = (next.network ?? []).filter(host => !oldHosts.has(host)).map(networkPermissionText)
  const oldKinds = new Set(old.sessions ?? [])
  const kinds = (next.sessions ?? []).filter(kind => !oldKinds.has(kind)).map(kind => SESSION_KIND_LABEL[kind])
  const settings = old.settings !== true && next.settings === true ? ['Keep its own settings'] : []
  return [...hosts, ...kinds, ...settings]
}
