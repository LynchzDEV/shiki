import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import { marketplaceDir } from '../server/plugins/marketplaces'
import { pickRef } from '../server/plugins/link'
import { pluginsRoutes } from '../server/routes/plugins'
import { readConfig, writeConfig } from '../server/secrets'
import { commitFixture, createPluginRepo, fileUrl, fixtureSha, isolatedManifest, TRIVIAL_SCREEN } from './support/plugin-fixtures'

let configDir: string
let fixtureRoot: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-plugins-routes-'))
  process.env.SKD_CONFIG_DIR = configDir
  fixtureRoot = await mkdtemp(join(tmpdir(), 'mc-plugins-repos-'))
})

afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(fixtureRoot, { recursive: true, force: true })
})

const app = () => new Elysia().use(pluginsRoutes())
const local = (init: RequestInit = {}) => ({ headers: { host: '127.0.0.1:7777', ...(init.headers ?? {}) }, ...init })
const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => app().handle(new Request(`http://127.0.0.1:7777${path}`, local({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})))

async function makeFixture(name: string, manifest: Record<string, unknown> = isolatedManifest()): Promise<{ url: string; sha: string }> {
  const repo = await createPluginRepo(join(fixtureRoot, name), manifest, { files: { 'src/screen.ts': TRIVIAL_SCREEN }, tag: 'v1.0.0' })
  return { url: fileUrl(repo), sha: await fixtureSha(repo) }
}

describe('access', () => {
  test('a request from outside this machine is refused', async () => {
    const response = await app().handle(new Request('http://evil.example/api/plugins', { headers: { host: 'evil.example' } }))
    expect(response.status).toBe(403)
  })

  test('a Bearer-token request from a non-local host is refused', async () => {
    const response = await app().handle(new Request('http://evil.example/api/plugins', { headers: { host: 'evil.example', authorization: 'Bearer mct_whatever' } }))
    expect(response.status).toBe(403)
  })
})

describe('installed plugins', () => {
  test('starts empty and lists after an install', async () => {
    expect(await (await json('GET', '/api/plugins')).json()).toEqual({ plugins: [] })
    const fixture = await makeFixture('isolated')
    const installed = await json('POST', '/api/plugins/install', { repo: fixture.url, ref: 'v1.0.0', commit: fixture.sha })
    expect(installed.status).toBe(200)
    expect((await (await json('GET', '/api/plugins')).json()).plugins).toHaveLength(1)
  })

  test('install requires the reviewed commit', async () => {
    const fixture = await makeFixture('isolated')
    const response = await json('POST', '/api/plugins/install', { repo: fixture.url, ref: 'v1.0.0' })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('commit is required')
  })

  test('preview returns what the install prompt shows', async () => {
    const fixture = await makeFixture('isolated')
    const response = await json('POST', '/api/plugins/preview', { repo: fixture.url, ref: 'v1.0.0' })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.commit).toBe(fixture.sha)
    expect(body.runtime).toBe('isolated')
    expect(body.manifest.id).toBe('fixture-plugin')
    expect(body.permissions).toEqual({ network: ['api.example.com'], sessions: ['chat'], settings: true })
  })

  test('preview of an unsupported pluginApi reports the manifest errors', async () => {
    const fixture = await makeFixture('future', isolatedManifest({ pluginApi: 3 }))
    const response = await json('POST', '/api/plugins/preview', { repo: fixture.url, ref: 'v1.0.0' })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('This plugin needs a newer Shikidan')
  })

  test('PATCH flips enabled, DELETE keeps data by default', async () => {
    const fixture = await makeFixture('isolated')
    await json('POST', '/api/plugins/install', { repo: fixture.url, ref: 'v1.0.0', commit: fixture.sha })

    const off = await json('PATCH', '/api/plugins/fixture-plugin', { enabled: false })
    expect(off.status).toBe(200)
    expect((await off.json()).plugin.enabled).toBe(false)

    const removed = await json('DELETE', '/api/plugins/fixture-plugin', { keepData: false })
    expect(removed.status).toBe(200)
    expect((await removed.json()).keptData).toBe(false)
    expect(stat(join(configDir, 'plugin-data', 'fixture-plugin')).then(() => true, () => false)).resolves.toBe(false)
  })

  test('update asks for consent when permissions grow', async () => {
    const repo = await createPluginRepo(join(fixtureRoot, 'grow'), isolatedManifest({ permissions: { network: ['a.example.com'], sessions: ['chat'] } }), { files: { 'src/screen.ts': TRIVIAL_SCREEN }, tag: 'v1.0.0' })
    const url = fileUrl(repo)
    await json('POST', '/api/plugins/install', { repo: url, ref: 'v1.0.0', commit: await fixtureSha(repo) })
    await commitFixture(repo, {
      'mc-plugin.json': `${JSON.stringify(isolatedManifest({ version: '2.0.0', permissions: { network: ['a.example.com', 'b.example.com'], sessions: ['chat'] } }), null, 2)}\n`,
    }, { tag: 'v2.0.0' })

    const asked = await json('POST', '/api/plugins/fixture-plugin/update', { ref: 'v2.0.0', commit: await fixtureSha(repo) })
    expect(asked.status).toBe(409)
    expect(await asked.json()).toEqual({ needsConsent: true, added: ['Reach b.example.com'] })

    const accepted = await json('POST', '/api/plugins/fixture-plugin/update', { ref: 'v2.0.0', commit: await fixtureSha(repo), accept: true })
    expect(accepted.status).toBe(200)
    expect((await accepted.json()).plugin.version).toBe('2.0.0')
  })
})

describe('plugin requirements', () => {
  async function setUpPair() {
    const dependency = await createPluginRepo(join(fixtureRoot, 'board-core'), isolatedManifest({ id: 'board-core', name: 'Board core', version: '1.8.0' }), { files: { 'src/screen.ts': TRIVIAL_SCREEN }, tag: 'v1.8.0' })
    const market = await createPluginRepo(join(fixtureRoot, 'req-market'), { name: 'Req market', plugins: [{ id: 'board-core', repo: fileUrl(dependency), ref: 'v1.8.0', name: 'Board core', description: '', runtime: 'isolated' }] }, { manifestName: 'marketplace.json' })
    expect((await json('POST', '/api/plugins/marketplaces', { url: fileUrl(market) })).status).toBe(200)
    const main = await createPluginRepo(join(fixtureRoot, 'needs-core'), isolatedManifest({ id: 'needs-core', name: 'Needs core', requires: [{ id: 'board-core', version: '1.7.0' }] }), { files: { 'src/screen.ts': TRIVIAL_SCREEN }, tag: 'v1.0.0' })
    return { market: fileUrl(market), dependencySha: await fixtureSha(dependency), main: { url: fileUrl(main), sha: await fixtureSha(main) } }
  }

  test('preview returns requires, searching the given marketplace', async () => {
    const { market, main, dependencySha } = await setUpPair()
    const response = await json('POST', '/api/plugins/preview', { repo: main.url, ref: 'v1.0.0', marketplace: market })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.requires).toHaveLength(1)
    expect(body.requires[0]).toMatchObject({ id: 'board-core', minVersion: '1.7.0', status: 'install', listing: { marketplace: market }, preview: { commit: dependencySha } })

    const other = await (await json('POST', '/api/plugins/preview', { repo: main.url, ref: 'v1.0.0', marketplace: 'file:///nowhere' })).json()
    expect(other.requires[0]).toMatchObject({ id: 'board-core', status: 'unavailable' })
  })

  test('a plugin without requirements previews with an empty list, also from a link', async () => {
    const fixture = await makeFixture('isolated')
    expect((await (await json('POST', '/api/plugins/preview', { repo: fixture.url, ref: 'v1.0.0' })).json()).requires).toEqual([])
    expect((await (await json('POST', '/api/plugins/add-link', { url: fixture.url })).json()).requires).toEqual([])
  })

  test('install asks for the steps, then installs them when they are sent back', async () => {
    const { main, dependencySha } = await setUpPair()
    const asked = await json('POST', '/api/plugins/install', { repo: main.url, ref: 'v1.0.0', commit: main.sha })
    expect(asked.status).toBe(409)
    const askedBody = await asked.json()
    expect(askedBody.needsRequirements).toBe(true)
    expect(askedBody.requirements[0]).toMatchObject({ id: 'board-core', status: 'install' })

    const junk = await json('POST', '/api/plugins/install', { repo: main.url, ref: 'v1.0.0', commit: main.sha, requirements: 'yes please' })
    expect(junk.status).toBe(409)

    const landed = await json('POST', '/api/plugins/install', { repo: main.url, ref: 'v1.0.0', commit: main.sha, requirements: [{ id: 'board-core', action: 'install', commit: dependencySha, extra: 1 }, 7, null] })
    expect(landed.status).toBe(200)
    const body = await landed.json()
    expect(body.plugin.id).toBe('needs-core')
    expect(body.installedRequirements).toEqual(['board-core'])
    expect((await (await json('GET', '/api/plugins')).json()).plugins.map((plugin: { id: string }) => plugin.id).sort()).toEqual(['board-core', 'needs-core'])
  })

  test('update takes requirements the same way', async () => {
    const { dependencySha } = await setUpPair()
    const plain = await createPluginRepo(join(fixtureRoot, 'grows'), isolatedManifest({ id: 'grows' }), { files: { 'src/screen.ts': TRIVIAL_SCREEN }, tag: 'v1.0.0' })
    await json('POST', '/api/plugins/install', { repo: fileUrl(plain), ref: 'v1.0.0', commit: await fixtureSha(plain) })
    await commitFixture(plain, { 'mc-plugin.json': `${JSON.stringify(isolatedManifest({ id: 'grows', version: '2.0.0', requires: [{ id: 'board-core' }] }), null, 2)}\n` }, { tag: 'v2.0.0' })
    const sha = await fixtureSha(plain)

    const asked = await json('POST', '/api/plugins/grows/update', { ref: 'v2.0.0', commit: sha })
    expect(asked.status).toBe(409)
    expect((await asked.json()).needsRequirements).toBe(true)

    const landed = await json('POST', '/api/plugins/grows/update', { ref: 'v2.0.0', commit: sha, requirements: [{ id: 'board-core', action: 'install', commit: dependencySha }] })
    expect(landed.status).toBe(200)
    expect((await landed.json()).installedRequirements).toEqual(['board-core'])
  })

  test('DELETE and PATCH name the plugins that need it, and force goes ahead', async () => {
    const { main, dependencySha } = await setUpPair()
    await json('POST', '/api/plugins/install', { repo: main.url, ref: 'v1.0.0', commit: main.sha, requirements: [{ id: 'board-core', action: 'install', commit: dependencySha }] })

    const refusedRemove = await json('DELETE', '/api/plugins/board-core', {})
    expect(refusedRemove.status).toBe(409)
    expect(await refusedRemove.json()).toEqual({ error: 'Needs core need this plugin', dependents: [{ id: 'needs-core', name: 'Needs core' }] })

    const refusedOff = await json('PATCH', '/api/plugins/board-core', { enabled: false })
    expect(refusedOff.status).toBe(409)
    expect((await refusedOff.json()).dependents).toEqual([{ id: 'needs-core', name: 'Needs core' }])

    expect((await json('PATCH', '/api/plugins/board-core', { enabled: false, force: true })).status).toBe(200)
    expect((await json('DELETE', '/api/plugins/board-core', { force: true })).status).toBe(200)
  })
})

describe('settings', () => {
  test('secrets never come back and unknown keys are refused', async () => {
    const fixture = await makeFixture('isolated')
    await json('POST', '/api/plugins/install', { repo: fixture.url, ref: 'v1.0.0', commit: fixture.sha })
    await json('PUT', '/api/plugins/fixture-plugin/settings', { key: 'token', value: 'pk-route-secret' })

    const view = await (await json('GET', '/api/plugins/fixture-plugin/settings')).json()
    expect(view.values).toEqual({})
    expect(view.configured).toEqual({ token: true })
    expect(JSON.stringify(view)).not.toContain('pk-route-secret')

    const refused = await json('PUT', '/api/plugins/fixture-plugin/settings', { key: 'unknown', value: 'x' })
    expect(refused.status).toBe(400)

    const cleared = await json('PUT', '/api/plugins/fixture-plugin/settings', { key: 'token', value: null })
    expect((await cleared.json()).configured).toEqual({ token: false })
  })

  test('an unknown plugin 404s', async () => {
    expect((await json('GET', '/api/plugins/nope/settings')).status).toBe(404)
  })
})

describe('marketplaces', () => {
  test('add lists and remove, preserving the rest of config.json', async () => {
    const roles = { plan: { engine: 'codex', model: 'gpt-5.1' }, execute: { engine: 'glm', model: null }, review: { engine: 'claude', model: null } }
    await writeConfig({ roles, chatHome: '/Users/me/work' })
    const listing = {
      name: 'Fixture marketplace',
      plugins: [{ id: 'fixture-plugin', repo: 'https://github.com/LynchzDEV/mc-plugin-fixture', ref: 'v1.0.0', name: 'Fixture', description: '', runtime: 'isolated' }],
    }
    const source = await createPluginRepo(join(fixtureRoot, 'market'), listing, { tag: 'v1.0.0', manifestName: 'marketplace.json' })
    const url = fileUrl(source)

    const added = await json('POST', '/api/plugins/marketplaces', { url })
    expect(added.status).toBe(200)
    const config = await readConfig()
    expect(config.roles).toEqual(roles)
    expect(config.chatHome).toBe('/Users/me/work')
    expect(config.marketplaces).toEqual([{ url }])

    const catalogView = await (await json('GET', '/api/plugins/catalog')).json()
    expect(catalogView.entries[0].plugins).toEqual(listing.plugins)

    const removed = await json('DELETE', '/api/plugins/marketplaces', { url })
    expect(removed.status).toBe(200)
    expect((await readConfig()).marketplaces).toEqual([])

    const missing = await json('DELETE', '/api/plugins/marketplaces', { url })
    expect(missing.status).toBe(404)
  })

  test('a refresh fetches updates and an unreachable source keeps the cached catalog', async () => {
    const listing = {
      name: 'Fixture marketplace',
      plugins: [{ id: 'fixture-plugin', repo: 'https://github.com/LynchzDEV/mc-plugin-fixture', ref: 'v1.0.0', name: 'Fixture', description: '', runtime: 'isolated' }],
    }
    const source = await createPluginRepo(join(fixtureRoot, 'market-refresh'), listing, { tag: 'v1.0.0', manifestName: 'marketplace.json' })
    const url = fileUrl(source)
    expect((await json('POST', '/api/plugins/marketplaces', { url })).status).toBe(200)

    const updated = { ...listing, plugins: [{ ...listing.plugins[0]!, ref: 'v1.1.0' }] }
    await writeFile(join(source, 'marketplace.json'), JSON.stringify(updated))
    Bun.spawnSync(['git', '-C', source, 'commit', '-qam', 'bump'])
    expect((await json('POST', '/api/plugins/marketplaces', { url })).status).toBe(200)
    expect((await (await json('GET', '/api/plugins/catalog')).json()).entries[0].plugins[0].ref).toBe('v1.1.0')

    await rm(source, { recursive: true, force: true })
    expect((await json('POST', '/api/plugins/marketplaces', { url })).status).toBe(400)
    expect((await (await json('GET', '/api/plugins/catalog')).json()).entries[0].plugins[0].ref).toBe('v1.1.0')
  })

  test('a plugin repo added as a marketplace is refused with a pointer to Install from a link', async () => {
    const plugin = await createPluginRepo(join(fixtureRoot, 'plugin-as-market'), isolatedManifest(), { tag: 'v1.0.0', files: { 'src/screen.ts': TRIVIAL_SCREEN } })
    const url = fileUrl(plugin)
    const response = await json('POST', '/api/plugins/marketplaces', { url })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'This link is a plugin, not a marketplace. Use Install from a link to install it.' })
    expect((await readConfig()).marketplaces).toEqual([])
    expect(await stat(marketplaceDir(url)).then(() => true, () => false)).toBe(false)
  })

  test('a repo without marketplace.json is refused and not kept', async () => {
    const plain = await createPluginRepo(join(fixtureRoot, 'plain-repo'), { hello: 'world' }, { manifestName: 'something.json' })
    const url = fileUrl(plain)
    const response = await json('POST', '/api/plugins/marketplaces', { url })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'This repo has no marketplace.json, so it is not a marketplace.' })
    expect((await readConfig()).marketplaces).toEqual([])
  })

  test('a bad marketplace url is refused', async () => {
    const response = await json('POST', '/api/plugins/marketplaces', { url: 'http://example.com/market' })
    expect(response.status).toBe(400)
  })
})

describe('plugin icons', () => {
  const svgIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>\n'
  const localGet = (id: string): Promise<Response> => app().handle(new Request(`http://127.0.0.1:7777/api/plugins/${id}/icon`, { headers: { host: '127.0.0.1:7777' } }))

  async function installIconFixture(id: string, manifest: Record<string, unknown>, files: Record<string, string>): Promise<void> {
    const repo = await createPluginRepo(join(fixtureRoot, `icon-${id}-${crypto.randomUUID().slice(0, 6)}`), isolatedManifest({ id, ...manifest }), { files, tag: 'v1.0.0' })
    const url = fileUrl(repo)
    const preview = await (await json('POST', '/api/plugins/preview', { repo: url, ref: 'v1.0.0' })).json()
    const installed = await json('POST', '/api/plugins/install', { repo: url, ref: 'v1.0.0', commit: preview.commit })
    expect(installed.status).toBe(200)
  }

  test('serves the manifest icon for an enabled plugin, svg only', async () => {
    await installIconFixture('icon-svg', { icon: 'assets/icon.svg' }, { 'assets/icon.svg': svgIcon, 'src/screen.ts': TRIVIAL_SCREEN })
    const icon = await localGet('icon-svg')
    expect(icon.status).toBe(200)
    expect(icon.headers.get('content-type')).toBe('image/svg+xml')
    expect(await icon.text()).toBe(svgIcon)
  })

  test('a disabled plugin, a missing icon, other file types and unknown ids all miss', async () => {
    await installIconFixture('icon-png', { icon: 'assets/icon.png' }, { 'assets/icon.png': 'fake png', 'src/screen.ts': TRIVIAL_SCREEN })
    expect((await localGet('icon-png')).headers.get('content-type')).toBe('image/png')

    await json('PATCH', '/api/plugins/icon-png', { enabled: false })
    expect((await localGet('icon-png')).status).toBe(404)
    await json('PATCH', '/api/plugins/icon-png', { enabled: true })

    await installIconFixture('icon-none', {}, { 'src/screen.ts': TRIVIAL_SCREEN })
    expect((await localGet('icon-none')).status).toBe(404)

    await installIconFixture('icon-txt', { icon: 'assets/icon.txt' }, { 'assets/icon.txt': 'nope', 'src/screen.ts': TRIVIAL_SCREEN })
    expect((await localGet('icon-txt')).status).toBe(404)

    expect((await localGet('unknown-plugin')).status).toBe(404)
  })
})

describe('add from a link', () => {
  test('a plugin repo opens the install preview at its newest version tag', async () => {
    const source = await createPluginRepo(join(fixtureRoot, 'link-plugin'), isolatedManifest(), { tag: 'v1.0.0', files: { 'src/screen.ts': TRIVIAL_SCREEN } })
    await commitFixture(source, { 'src/screen.ts': `${TRIVIAL_SCREEN}// v1.10\n` }, { tag: 'v1.10.0' })
    const newest = await fixtureSha(source)
    await commitFixture(source, { 'src/screen.ts': `${TRIVIAL_SCREEN}// v1.9\n` }, { tag: 'v1.9.0' })
    const response = await json('POST', '/api/plugins/add-link', { url: fileUrl(source) })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ kind: 'plugin', ref: 'v1.10.0', commit: newest, runtime: 'isolated' })
    expect(body.manifest.id).toBe('fixture-plugin')
  })

  test('a plugin repo without version tags uses its default branch, and a typed version wins', async () => {
    const source = await createPluginRepo(join(fixtureRoot, 'link-untagged'), isolatedManifest(), { files: { 'src/screen.ts': TRIVIAL_SCREEN } })
    expect(await (await json('POST', '/api/plugins/add-link', { url: fileUrl(source) })).json()).toMatchObject({ kind: 'plugin', ref: 'main' })
    await commitFixture(source, { 'notes.md': 'x' }, { tag: 'v2.0.0' })
    await commitFixture(source, { 'notes.md': 'y' }, { tag: 'v3.0.0' })
    expect(await (await json('POST', '/api/plugins/add-link', { url: fileUrl(source), ref: 'v2.0.0' })).json()).toMatchObject({ kind: 'plugin', ref: 'v2.0.0' })
  })

  test('a marketplace repo is added as a marketplace', async () => {
    const listing = { name: 'Linked market', plugins: [] }
    const source = await createPluginRepo(join(fixtureRoot, 'link-market'), listing, { tag: 'v1.0.0', manifestName: 'marketplace.json' })
    const response = await json('POST', '/api/plugins/add-link', { url: fileUrl(source) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ kind: 'marketplace' })
    expect((await readConfig()).marketplaces).toEqual([{ url: fileUrl(source) }])
  })

  test('a repo that is neither says so and keeps nothing', async () => {
    const source = await createPluginRepo(join(fixtureRoot, 'link-neither'), { hello: 'world' }, { manifestName: 'something.json' })
    const response = await json('POST', '/api/plugins/add-link', { url: fileUrl(source) })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "This repo isn't a Shikidan plugin or marketplace." })
    expect((await readConfig()).marketplaces).toEqual([])
  })

  test('an unreachable or unsupported link is refused plainly', async () => {
    expect(await (await json('POST', '/api/plugins/add-link', { url: 'http://example.com/x' })).json()).toEqual({ error: 'The link must be https://, git@host:path or file://' })
    expect(await (await json('POST', '/api/plugins/add-link', { url: `file://${join(fixtureRoot, 'does-not-exist')}` })).json()).toEqual({ error: "Couldn't reach this repo" })
  })
})

describe('pickRef', () => {
  test('prefers the highest version tag over the default branch and ignores peeled tags', () => {
    const lsRemote = ['ref: refs/heads/trunk\tHEAD', 'aaa\tHEAD', 'bbb\trefs/tags/v1.9.0', 'ccc\trefs/tags/v1.10.0', 'ccc\trefs/tags/v1.10.0^{}', 'ddd\trefs/tags/nightly'].join('\n')
    expect(pickRef(lsRemote)).toBe('v1.10.0')
    expect(pickRef('ref: refs/heads/trunk\tHEAD\naaa\tHEAD')).toBe('trunk')
    expect(pickRef('')).toBeNull()
  })
})
