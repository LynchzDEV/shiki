import { join, resolve } from 'node:path'

import { Elysia } from 'elysia'

import { requireLocal, type GuardContext } from '../auth'
import { peerAddress, trustedHostRequest } from '../local-access'
import { validateWorkspaceCwd } from '../workspace'
import { ContextTooLarge, writeContextFile } from '../plugins/context-files'
import { createInstaller, type Installer } from '../plugins/installer'
import { addFromLink } from '../plugins/link'
import { addMarketplace, catalog, listMarketplaces, removeMarketplace } from '../plugins/marketplaces'
import type { RequirementConsent } from '../plugins/requirements'
import { defaultRuntimes, type Runtimes } from '../plugins/runtimes'
import { setSetting, settingsView } from '../plugins/settings'
import { refreshContributions } from '../plugins/contributions'
import { syncEngineAssets } from '../engine-assets'
import { getInstalled, listInstalled, pluginFolder } from '../plugins/store'

function failureBody(result: { ok: false; status: number }): Record<string, unknown> {
  const { ok: _ok, status: _status, ...body } = result
  return body
}

function successBody<T extends { ok: true }>(result: T): Record<string, unknown> {
  const { ok: _ok, ...body } = result
  return body
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const optionalText = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

const CONSENT_ACTIONS: RequirementConsent['action'][] = ['install', 'update', 'enable']

function consentList(value: unknown): RequirementConsent[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((entry): RequirementConsent[] => {
    const record = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {}
    const action = CONSENT_ACTIONS.find(candidate => candidate === record.action)
    if (typeof record.id !== 'string' || action === undefined) return []
    return [{ id: record.id, action, ...(typeof record.commit === 'string' ? { commit: record.commit } : {}) }]
  })
}

const PUBLIC_DIR = resolve(import.meta.dir, '..', '..', 'public')

// ponytail: legacy window.__MC_PLUGIN__ and MC_PLUGIN_* env, drop after plugins move to skd-plugin-sdk
function frameHtml(id: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/plugin-frame/${id}/ui.css"></head><body><div id="root"></div><script>window.__SKD_PLUGIN__=window.__MC_PLUGIN__={id:"${id}",runtime:"isolated"}</script><script src="/plugin-frame/${id}/screen.js"></script></body></html>`
}

function frameCsp(host: string): string {
  const origin = `http://${host}`
  return `default-src 'none'; script-src ${origin} 'unsafe-inline'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:; connect-src 'none'; frame-ancestors ${origin}`
}

async function isolatedScreenPlugin(id: string): Promise<boolean> {
  const installed = await getInstalled(id)
  return installed !== null && installed.enabled && installed.runtime === 'isolated'
}

// A sandboxed plugin frame has an opaque origin, so its asset requests look cross-site to requireLocal; the handlers still 404 anything but an enabled isolated plugin's own assets.
const FRAME_ASSET_PATH = /^\/plugin-frame\/[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])\/(?:screen\.js|ui\.css)?$/

async function requireLocalExceptFrameAssets(context: GuardContext): Promise<void | { error: string }> {
  const request = context.request
  if (request.method === 'GET'
    && FRAME_ASSET_PATH.test(new URL(request.url).pathname)
    && trustedHostRequest(request, peerAddress(context.server, request))) return
  return requireLocal(context)
}

export function pluginsRoutes(deps: { installer?: Installer; runtimes?: Runtimes } = {}) {
  const installer = deps.installer ?? createInstaller()
  const runtimesPromise = deps.runtimes === undefined ? defaultRuntimes() : Promise.resolve(deps.runtimes)
  return new Elysia()
    .onBeforeHandle(requireLocalExceptFrameAssets)
    .get('/api/plugins', async () => {
      const pool = await runtimesPromise
      const plugins = await listInstalled()
      return { plugins: plugins.map(plugin => ({ ...plugin, state: pool.stateOf(plugin) })) }
    })
    .get('/api/plugins/marketplaces', async () => ({ marketplaces: await listMarketplaces() }))
    .post('/api/plugins/marketplaces', async ({ body, set }) => {
      const result = await addMarketplace(text((body as Record<string, unknown> | null)?.url))
      if (!result.ok) { set.status = result.status; return { error: result.error } }
      return { marketplaces: await listMarketplaces() }
    })
    .delete('/api/plugins/marketplaces', async ({ body, set }) => {
      const result = await removeMarketplace(text((body as Record<string, unknown> | null)?.url))
      if (!result.ok) { set.status = result.status; return { error: result.error } }
      return { marketplaces: await listMarketplaces() }
    })
    .get('/api/plugins/catalog', async () => ({ entries: await catalog() }))
    .post('/api/plugins/preview', async ({ body, set }) => {
      const parsed = (body ?? {}) as Record<string, unknown>
      const result = await installer.preview({ repo: text(parsed.repo), ref: text(parsed.ref), marketplace: optionalText(parsed.marketplace) })
      if (!result.ok) { set.status = result.status; return failureBody(result) }
      return successBody(result)
    })
    .post('/api/plugins/add-link', async ({ body, set }) => {
      const parsed = (body ?? {}) as Record<string, unknown>
      const result = await addFromLink(installer, text(parsed.url).trim(), optionalText(parsed.ref)?.trim())
      if (!result.ok) { set.status = result.status; return { error: result.error, ...(result.step ? { step: result.step } : {}) } }
      if (result.kind === 'marketplace') return { kind: 'marketplace' }
      return { kind: 'plugin', ref: result.ref, ...successBody(result.preview) }
    })
    .post('/api/plugins/install', async ({ body, set }) => {
      const parsed = (body ?? {}) as Record<string, unknown>
      const result = await installer.install({
        repo: text(parsed.repo),
        ref: text(parsed.ref),
        commit: text(parsed.commit),
        trust: parsed.trust === true,
        marketplace: optionalText(parsed.marketplace),
        requirements: consentList(parsed.requirements),
      })
      if (!result.ok) { set.status = result.status; return failureBody(result) }
      return successBody(result)
    })
    .post('/api/plugins/:id/update', async ({ params, body, set }) => {
      const parsed = (body ?? {}) as Record<string, unknown>
      const result = await installer.update(params.id, {
        ref: optionalText(parsed.ref),
        commit: text(parsed.commit),
        accept: parsed.accept === true,
        trust: parsed.trust === true,
        repo: optionalText(parsed.repo),
        requirements: consentList(parsed.requirements),
      })
      if (!result.ok) { set.status = result.status; return failureBody(result) }
      return successBody(result)
    })
    .delete('/api/plugins/:id', async ({ params, body, set }) => {
      const { keepData, force } = (body ?? {}) as Record<string, unknown>
      if (keepData !== undefined && typeof keepData !== 'boolean') {
        set.status = 400
        return { error: 'keepData must be true or false' }
      }
      const result = await installer.uninstall(params.id, { keepData: keepData === undefined ? undefined : keepData, force: force === true })
      if (!result.ok) { set.status = result.status; return failureBody(result) }
      return { ok: true, keptData: result.keptData }
    })
    .patch('/api/plugins/:id', async ({ params, body, set }) => {
      const { enabled, force } = (body ?? {}) as Record<string, unknown>
      if (typeof enabled !== 'boolean') { set.status = 400; return { error: 'enabled must be true or false' } }
      const result = await installer.setEnabled(params.id, enabled, { force: force === true })
      if (!result.ok) { set.status = result.status; return failureBody(result) }
      return successBody(result)
    })
    .get('/api/plugins/:id/settings', async ({ params, set }) => {
      const result = await settingsView(params.id)
      if (!result.ok) { set.status = result.status; return { error: result.error } }
      return result.value
    })
    .put('/api/plugins/:id/settings', async ({ params, body, set }) => {
      const parsed = (body ?? {}) as Record<string, unknown>
      if (typeof parsed.key !== 'string' || parsed.key === '') { set.status = 400; return { error: 'key is required' } }
      if (parsed.value !== null && typeof parsed.value !== 'string') { set.status = 400; return { error: 'value must be a string or null' } }
      const result = await setSetting(params.id, parsed.key, parsed.value)
      if (!result.ok) { set.status = result.status; return { error: result.error } }
      const refreshed = await refreshContributions(params.id, { sync: syncEngineAssets })
      if (!refreshed.ok) { set.status = 409; return { error: `Setting saved, but the plugin's agents and skills could not be updated: ${refreshed.error}` } }
      return result.value
    })
    .post('/api/plugins/:id/context', async ({ params, body, set }) => {
      const installed = await getInstalled(params.id)
      if (installed === null) { set.status = 404; return { error: 'That plugin is not installed' } }
      if (!installed.enabled) { set.status = 409; return { error: 'This plugin is turned off' } }
      if ((installed.permissions.sessions ?? []).length === 0) { set.status = 403; return { error: 'This plugin did not ask to start sessions' } }
      const parsed = (body ?? {}) as Record<string, unknown>
      if (typeof parsed.name !== 'string' || parsed.name === '') { set.status = 400; return { error: 'name is required' } }
      if (typeof parsed.markdown !== 'string') { set.status = 400; return { error: 'markdown is required' } }
      if (typeof parsed.cwd !== 'string' || parsed.cwd === '') { set.status = 400; return { error: 'cwd is required' } }
      const folder = await validateWorkspaceCwd(parsed.cwd, undefined, { requireGit: false })
      if (!folder.ok) { set.status = 400; return { error: folder.error } }
      try {
        return { path: await writeContextFile(params.id, { name: parsed.name, markdown: parsed.markdown }, new Date(), folder.path) }
      } catch (error) {
        if (error instanceof ContextTooLarge) { set.status = 400; return { error: error.message } }
        throw error
      }
    })
    .post('/api/plugins/:id/call', async ({ params, body, set }) => {
      const installed = await getInstalled(params.id)
      if (installed === null) { set.status = 404; return { error: 'That plugin is not installed' } }
      if (!installed.enabled) { set.status = 409; return { error: 'This plugin is turned off' } }
      const parsed = (body ?? {}) as Record<string, unknown>
      if (typeof parsed.method !== 'string' || parsed.method === '') { set.status = 400; return { error: 'method is required' } }
      const pool = await runtimesPromise
      const runtime = await pool.getRuntime(installed)
      if (!runtime.ok) { set.status = runtime.status; return { error: runtime.error } }
      const outcome = await runtime.runtime.call(parsed.method, parsed.params)
      if (!outcome.ok) { set.status = outcome.status; return { error: outcome.error } }
      return { result: outcome.result }
    })
    .get('/api/plugins/:id/icon', async ({ params, set }) => {
      const installed = await getInstalled(params.id)
      if (installed === null || !installed.enabled || installed.icon === undefined) { set.status = 404; return { error: 'not found' } }
      const type = installed.icon.endsWith('.svg') ? 'image/svg+xml' : installed.icon.endsWith('.png') ? 'image/png' : null
      if (type === null) { set.status = 404; return { error: 'not found' } }
      const file = Bun.file(join(pluginFolder(params.id), installed.icon))
      if (!await file.exists()) { set.status = 404; return { error: 'not found' } }
      return new Response(file, { headers: { 'content-type': type } })
    })
    .get('/plugin-module/:id/screen.js', async ({ params, set }) => {
      const installed = await getInstalled(params.id)
      if (installed === null || !installed.enabled || installed.runtime !== 'trusted') {
        set.status = 404
        return { error: 'not found' }
      }
      const file = Bun.file(join(pluginFolder(params.id), '.mc-build', 'screen.js'))
      if (!await file.exists()) { set.status = 404; return { error: 'not found' } }
      return new Response(file, { headers: { 'content-type': 'text/javascript' } })
    })
    .get('/plugin-frame/:id/', async ({ params, request }) => {
      if (!await isolatedScreenPlugin(params.id)) return new Response('not found', { status: 404 })
      const host = request.headers.get('host') ?? '127.0.0.1:7777'
      return new Response(frameHtml(params.id), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': frameCsp(host) },
      })
    })
    .get('/plugin-frame/:id/screen.js', async ({ params }) => {
      if (!await isolatedScreenPlugin(params.id)) return new Response('not found', { status: 404 })
      const file = Bun.file(join(pluginFolder(params.id), '.mc-build', 'screen.js'))
      if (!await file.exists()) return new Response('not found', { status: 404 })
      return new Response(file, { headers: { 'content-type': 'text/javascript' } })
    })
    .get('/plugin-frame/:id/ui.css', async ({ params }) => {
      if (!await isolatedScreenPlugin(params.id)) return new Response('not found', { status: 404 })
      const file = Bun.file(join(PUBLIC_DIR, 'plugin-ui.css'))
      if (!await file.exists()) return new Response('not found', { status: 404 })
      return new Response(file, { headers: { 'content-type': 'text/css' } })
    })
}
