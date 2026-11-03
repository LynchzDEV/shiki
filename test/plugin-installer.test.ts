import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rename as fsRename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addMarketplace, syncMarketplace, type CatalogPlugin } from '../server/plugins/marketplaces'

import { createInstaller } from '../server/plugins/installer'
import { catalog } from '../server/plugins/marketplaces'
import { getSetting, setSetting, settingsView } from '../server/plugins/settings'
import { configPath } from '../server/secrets'
import { getInstalled, listInstalled, pluginFolder, saveInstalled } from '../server/plugins/store'
import { marketplaceSlug } from '../server/plugins/repo-url'
import { commitFixture, createPluginRepo, fileUrl, fixtureSha, isolatedManifest, linkFixture, TRIVIAL_SCREEN, trustedManifest } from './support/plugin-fixtures'

let configDir: string
let fixtureRoot: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-plugin-install-'))
  process.env.SKD_CONFIG_DIR = configDir
  fixtureRoot = await mkdtemp(join(tmpdir(), 'mc-plugin-repos-'))
})

afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(fixtureRoot, { recursive: true, force: true })
})

const installer = () => createInstaller()

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

async function tmpLeftovers(): Promise<string[]> {
  try {
    return (await readdir(configDir)).filter(entry => entry.startsWith('plugins-tmp-'))
  } catch {
    return []
  }
}

async function assertNothingInstalled(id: string): Promise<void> {
  expect(await pathExists(pluginFolder(id))).toBe(false)
  expect(await tmpLeftovers()).toEqual([])
  expect(await listInstalled()).toEqual([])
}

async function repo(name: string, manifest: Record<string, unknown>, files: Record<string, string>, tag = 'v1.0.0'): Promise<string> {
  return createPluginRepo(join(fixtureRoot, name), manifest, { files, tag })
}

async function expectPrivateTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = join(root, entry.name)
    const mode = (await stat(path)).mode & 0o777
    if (entry.isDirectory()) {
      expect(mode, path).toBe(0o700)
      await expectPrivateTree(path)
    } else {
      expect(mode, path).toBe(0o600)
    }
  }
}

function listing(repoUrl: string, ref: string): Record<string, unknown> {
  return {
    name: 'Fixture marketplace',
    plugins: [{ id: 'fixture-plugin', repo: repoUrl, ref, name: 'Fixture', description: '', runtime: 'isolated' }],
  }
}

async function installOk(repoUrl: string, sha: string, extra: Record<string, unknown> = {}) {
  const ref = typeof extra.ref === 'string' ? extra.ref : 'v1.0.0'
  const result = await installer().install({ repo: repoUrl, ref, commit: sha, ...extra })
  if (!result.ok) throw new Error(`install failed: ${JSON.stringify(result)}`)
  return result.plugin
}

describe('install', () => {
  test('records the plugin, builds the screen and enables it', async () => {
    const source = await repo('isolated', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    const plugin = await installOk(fileUrl(source), await fixtureSha(source))

    expect(plugin.enabled).toBe(true)
    expect(plugin.id).toBe('fixture-plugin')
    expect(plugin.source).toEqual({ repo: fileUrl(source), ref: 'v1.0.0' })
    expect(await getInstalled('fixture-plugin')).toEqual(plugin)
    expect(await pathExists(join(pluginFolder('fixture-plugin'), '.mc-build', 'screen.js'))).toBe(true)
  })

  test('records queueSource when the manifest declares it true', async () => {
    const source = await repo('queue-source', isolatedManifest({ queueSource: true }), { 'src/screen.ts': TRIVIAL_SCREEN })
    expect((await installOk(fileUrl(source), await fixtureSha(source))).queueSource).toBe(true)
  })

  test('leaves queueSource off the record when the manifest says false', async () => {
    const source = await repo('queue-source-off', isolatedManifest({ queueSource: false }), { 'src/screen.ts': TRIVIAL_SCREEN })
    expect('queueSource' in await installOk(fileUrl(source), await fixtureSha(source))).toBe(false)
  })

  test('a screen that imports a stylesheet builds to screen.js and screen.css', async () => {
    const source = await repo('styled', isolatedManifest(), {
      'src/screen.ts': "import './look.css'\nexport default { mount() {} }\n",
      'src/look.css': '.x { color: red }\n',
    })
    await installOk(fileUrl(source), await fixtureSha(source))
    expect(await pathExists(join(pluginFolder('fixture-plugin'), '.mc-build', 'screen.js'))).toBe(true)
    expect(await pathExists(join(pluginFolder('fixture-plugin'), '.mc-build', 'screen.css'))).toBe(true)
  })

  test('plugins.json is written at mode 0600', async () => {
    const source = await repo('isolated', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    await installOk(fileUrl(source), await fixtureSha(source))
    expect((await stat(configPath('plugins.json'))).mode & 0o777).toBe(0o600)
  })

  test('installed files are 0600 and folders 0700', async () => {
    const source = await repo('private-modes', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    await installOk(fileUrl(source), await fixtureSha(source))
    await expectPrivateTree(pluginFolder('fixture-plugin'))
  })

  test('trusted installs need trust: true', async () => {
    const source = await repo('trusted', trustedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    const sha = await fixtureSha(source)
    const refused = await installer().install({ repo: fileUrl(source), ref: 'v1.0.0', commit: sha })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.status).toBe(400)
      expect(refused.error).toBe('Trusted plugins need trust: true')
    }
    expect((await installOk(fileUrl(source), sha, { trust: true })).runtime).toBe('trusted')
  })

  test('a duplicate install is refused', async () => {
    const source = await repo('isolated', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    const sha = await fixtureSha(source)
    await installOk(fileUrl(source), sha)
    const again = await installer().install({ repo: fileUrl(source), ref: 'v1.0.0', commit: sha })
    expect(again.ok).toBe(false)
    if (!again.ok) {
      expect(again.status).toBe(409)
      expect(again.error).toBe('Already installed; use Update')
    }
  })

  test('two concurrent installs of the same plugin yield one success and one 409', async () => {
    const source = await repo('isolated', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    const sha = await fixtureSha(source)
    const results = await Promise.allSettled([
      installer().install({ repo: fileUrl(source), ref: 'v1.0.0', commit: sha }),
      installer().install({ repo: fileUrl(source), ref: 'v1.0.0', commit: sha }),
    ])
    const statuses = results.map(result => result.status === 'fulfilled' && result.value.ok ? 200 : 409)
    expect(statuses.sort()).toEqual([200, 409])
    expect((await listInstalled()).length).toBe(1)
  })

  test('a reviewed-commit mismatch is refused with 409', async () => {
    const source = await repo('isolated', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    const result = await installer().install({ repo: fileUrl(source), ref: 'v1.0.0', commit: '0'.repeat(40) })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.error).toBe('The plugin changed since you reviewed it; preview again')
    }
    await assertNothingInstalled('fixture-plugin')
  })
})

describe('install failures leave nothing behind', () => {
  test('clone: a missing repo', async () => {
    const result = await installer().install({ repo: fileUrl(join(fixtureRoot, 'nope')), ref: 'v1.0.0', commit: '0'.repeat(40) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.step).toBe('clone')
    await assertNothingInstalled('fixture-plugin')
  })

  test('clone: a ref that does not exist', async () => {
    const source = await repo('isolated', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    const result = await installer().install({ repo: fileUrl(source), ref: 'v9.9.9', commit: '0'.repeat(40) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.step).toBe('clone')
    await assertNothingInstalled('fixture-plugin')
  })

  test('manifest: mc-plugin.json is missing', async () => {
    const source = await createPluginRepo(join(fixtureRoot, 'empty'), { note: 'not a plugin' }, { files: {}, tag: 'v1.0.0', manifestName: 'README.md' })
    const result = await installer().install({ repo: fileUrl(source), ref: 'v1.0.0', commit: await fixtureSha(source) })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.step).toBe('manifest')
      expect(result.error).toContain('mc-plugin.json is missing')
    }
    await assertNothingInstalled('fixture-plugin')
  })

  test('manifest: an invalid manifest reports its errors', async () => {
    const source = await repo('bad-manifest', isolatedManifest({ pluginApi: 3 }), { 'src/screen.ts': TRIVIAL_SCREEN })
    const result = await installer().install({ repo: fileUrl(source), ref: 'v1.0.0', commit: await fixtureSha(source) })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.step).toBe('manifest')
      expect(result.error).toContain('This plugin needs a newer Shikidan')
    }
    await assertNothingInstalled('fixture-plugin')
  })

  test('dependencies: a failing bun install stops at the dependencies step', async () => {
    const source = await repo(
      'with-deps',
      isolatedManifest(),
      { 'src/screen.ts': TRIVIAL_SCREEN, 'package.json': JSON.stringify({ name: 'with-deps', dependencies: { 'definitely-not-a-real-pkg-mc': '1.0.0' } }) },
    )
    const failing = createInstaller({ runBunInstall: () => Promise.reject(new Error('registry unreachable')) })
    const result = await failing.install({ repo: fileUrl(source), ref: 'v1.0.0', commit: await fixtureSha(source) })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.step).toBe('dependencies')
      expect(result.error).toContain('registry unreachable')
    }
    await assertNothingInstalled('fixture-plugin')
  })

  test('build: a screen with a syntax error stops at the build step', async () => {
    const source = await repo('broken-screen', isolatedManifest(), { 'src/screen.ts': 'const x = = = broken\n' })
    const result = await installer().install({ repo: fileUrl(source), ref: 'v1.0.0', commit: await fixtureSha(source) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.step).toBe('build')
    await assertNothingInstalled('fixture-plugin')
  })

  test('move: a failing rename stops at the move step', async () => {
    const source = await repo('isolated', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    const failing = createInstaller({ rename: () => Promise.reject(new Error('device full')) })
    const result = await failing.install({ repo: fileUrl(source), ref: 'v1.0.0', commit: await fixtureSha(source) })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.step).toBe('move')
      expect(result.error).toContain('device full')
    }
    await assertNothingInstalled('fixture-plugin')
  })
})

describe('checkout safety', () => {
  test('a link pointing outside the checkout never reaches the build', async () => {
    const outside = join(fixtureRoot, 'outside')
    await mkdir(outside, { recursive: true })
    const source = await repo('escape-link', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    await linkFixture(source, '.mc-build', outside, { tag: 'v1.1.0' })
    const sha = await fixtureSha(source)

    const previewed = await installer().preview({ repo: fileUrl(source), ref: 'v1.1.0' })
    expect(previewed.ok).toBe(false)
    if (!previewed.ok) {
      expect(previewed.step).toBe('manifest')
      expect(previewed.error).toContain('link pointing outside its folder')
    }

    const result = await installer().install({ repo: fileUrl(source), ref: 'v1.1.0', commit: sha })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.step).toBe('manifest')
    await assertNothingInstalled('fixture-plugin')
    expect(await pathExists(join(outside, 'screen.js'))).toBe(false)
  })

  test('a chained link reaching outside the checkout never reaches the build', async () => {
    const outside = join(configDir, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'screen.js'), 'sentinel\n')
    const source = await repo('chain-escape', isolatedManifest(), {
      'src/screen.ts': TRIVIAL_SCREEN,
      'other/keep.txt': 'kept\n',
    })
    await linkFixture(source, 'deep/a', '../other')
    await linkFixture(source, '.mc-build', 'deep/a/../../outside', { tag: 'v1.1.0' })
    const sha = await fixtureSha(source)

    const previewed = await installer().preview({ repo: fileUrl(source), ref: 'v1.1.0' })
    expect(previewed.ok).toBe(false)
    if (!previewed.ok) {
      expect(previewed.step).toBe('manifest')
      expect(previewed.error).toContain('link pointing outside its folder')
    }

    const result = await installer().install({ repo: fileUrl(source), ref: 'v1.1.0', commit: sha })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.step).toBe('manifest')
    await assertNothingInstalled('fixture-plugin')
    expect(await readFile(join(outside, 'screen.js'), 'utf8')).toBe('sentinel\n')
  })

  test('a link that stays inside the checkout is allowed', async () => {
    const source = await repo('inside-link', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    await linkFixture(source, 'vendor', 'src', { tag: 'v1.1.0' })
    expect((await installOk(fileUrl(source), await fixtureSha(source), { ref: 'v1.1.0' })).id).toBe('fixture-plugin')
  })

  test('a link created while installing dependencies is refused at the build step', async () => {
    const outside = join(fixtureRoot, 'dep-outside')
    await mkdir(outside, { recursive: true })
    const source = await repo('dep-link', isolatedManifest({ screen: undefined }), { 'package.json': '{"name":"dep-link"}\n' })
    const sneaky = createInstaller({
      runBunInstall: async dir => { await symlink(outside, join(dir, 'node_modules')) },
    })
    const result = await sneaky.install({ repo: fileUrl(source), ref: 'v1.0.0', commit: await fixtureSha(source) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.step).toBe('build')
    await assertNothingInstalled('fixture-plugin')
    expect(await pathExists(join(outside, 'screen.js'))).toBe(false)
  })
})

describe('update', () => {
  test('new permissions need consent, then accept lands the update', async () => {
    const source = await repo('grow', isolatedManifest({ permissions: { network: ['a.example.com'], sessions: ['chat'] } }), { 'src/screen.ts': TRIVIAL_SCREEN })
    await installOk(fileUrl(source), await fixtureSha(source))
    await commitFixture(source, {
      'mc-plugin.json': `${JSON.stringify(isolatedManifest({ version: '2.0.0', permissions: { network: ['a.example.com', 'b.example.com'], sessions: ['chat'] } }), null, 2)}\n`,
    }, { tag: 'v2.0.0' })
    const v2sha = await fixtureSha(source)

    const asked = await installer().update('fixture-plugin', { ref: 'v2.0.0', commit: v2sha })
    expect(asked.ok).toBe(false)
    if (!asked.ok && 'needsConsent' in asked) {
      expect(asked.needsConsent).toBe(true)
      expect(asked.added).toEqual(['Reach b.example.com'])
    } else {
      throw new Error('expected needsConsent')
    }
    expect((await getInstalled('fixture-plugin'))!.version).toBe('1.0.0')

    const landed = await installer().update('fixture-plugin', { ref: 'v2.0.0', commit: v2sha, accept: true })
    expect(landed.ok).toBe(true)
    if (landed.ok) {
      expect(landed.plugin.version).toBe('2.0.0')
      expect(landed.plugin.installedAt).toBe((await getInstalled('fixture-plugin'))!.installedAt)
    }
    expect(await readFile(join(pluginFolder('fixture-plugin'), 'mc-plugin.json'), 'utf8')).toContain('2.0.0')
  })

  test('an update may not change the plugin id', async () => {
    const source = await repo('change-id', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    await installOk(fileUrl(source), await fixtureSha(source))
    await commitFixture(source, {
      'mc-plugin.json': `${JSON.stringify(isolatedManifest({ id: 'other-plugin' }), null, 2)}\n`,
    }, { tag: 'v2.0.0' })
    const result = await installer().update('fixture-plugin', { ref: 'v2.0.0', commit: await fixtureSha(source) })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.error).toBe('The update changed the plugin id')
    }
    expect((await getInstalled('fixture-plugin'))!.version).toBe('1.0.0')
  })

  test('an update may not come from a different repo', async () => {
    const first = await repo('original', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    const second = await repo('imposter', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    await installOk(fileUrl(first), await fixtureSha(first))
    const result = await installer().update('fixture-plugin', { repo: fileUrl(second), ref: 'v1.0.0', commit: await fixtureSha(second) })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.error).toBe('The update comes from a different repo')
    }
  })

  test('moving from isolated to trusted needs trust', async () => {
    const source = await repo('upgrade-runtime', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    await installOk(fileUrl(source), await fixtureSha(source))
    await commitFixture(source, {
      'mc-plugin.json': `${JSON.stringify(trustedManifest(), null, 2)}\n`,
    }, { tag: 'v2.0.0' })
    const sha = await fixtureSha(source)
    const asked = await installer().update('fixture-plugin', { ref: 'v2.0.0', commit: sha })
    expect(asked.ok).toBe(false)
    if (!asked.ok && 'needsTrust' in asked) expect(asked.needsTrust).toBe(true)
    else throw new Error('expected needsTrust')
    const trusted = await installer().update('fixture-plugin', { ref: 'v2.0.0', commit: sha, trust: true })
    expect(trusted.ok).toBe(true)
    if (trusted.ok) expect(trusted.plugin.runtime).toBe('trusted')
  })

  test('an update without a ref follows the marketplace listing', async () => {
    const pluginRepo = await repo('listed', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    const marketRepo = await createPluginRepo(join(fixtureRoot, 'listed-market'), listing(fileUrl(pluginRepo), 'v1.0.0'), { manifestName: 'marketplace.json' })
    const marketUrl = fileUrl(marketRepo)
    expect((await addMarketplace(marketUrl)).ok).toBe(true)
    await installOk(fileUrl(pluginRepo), await fixtureSha(pluginRepo), { marketplace: marketUrl })

    await commitFixture(pluginRepo, {
      'mc-plugin.json': `${JSON.stringify(isolatedManifest({ version: '2.0.0' }), null, 2)}\n`,
    }, { tag: 'v2.0.0' })
    await commitFixture(marketRepo, { 'marketplace.json': `${JSON.stringify(listing(fileUrl(pluginRepo), 'v2.0.0'))}\n` })
    await syncMarketplace(marketUrl)

    const result = await installer().update('fixture-plugin', { commit: await fixtureSha(pluginRepo) })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plugin.version).toBe('2.0.0')
      expect(result.plugin.source).toEqual({ repo: fileUrl(pluginRepo), ref: 'v2.0.0', marketplace: marketUrl })
    }
  })

  test('a listing that moves the plugin to another repo is refused', async () => {
    const first = await repo('stays', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    const second = await repo('moves', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    const marketRepo = await createPluginRepo(join(fixtureRoot, 'move-market'), listing(fileUrl(first), 'v1.0.0'), { manifestName: 'marketplace.json' })
    const marketUrl = fileUrl(marketRepo)
    expect((await addMarketplace(marketUrl)).ok).toBe(true)
    await installOk(fileUrl(first), await fixtureSha(first), { marketplace: marketUrl })

    await commitFixture(marketRepo, { 'marketplace.json': `${JSON.stringify(listing(fileUrl(second), 'v1.0.0'))}\n` })
    await syncMarketplace(marketUrl)

    const result = await installer().update('fixture-plugin', { commit: await fixtureSha(second) })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.error).toBe('The update comes from a different repo')
    }
    expect((await getInstalled('fixture-plugin'))!.source.repo).toBe(fileUrl(first))
  })

  test.each([
    ['the first rename fails', 1],
    ['the second rename fails', 2],
  ] as const)('rollback when %s', async (_label, failingCall) => {
    const source = await repo('rollback', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    await installOk(fileUrl(source), await fixtureSha(source))
    await commitFixture(source, {
      'mc-plugin.json': `${JSON.stringify(isolatedManifest({ version: '2.0.0' }), null, 2)}\n`,
    }, { tag: 'v2.0.0' })

    let calls = 0
    const failing = createInstaller({
      rename: (from, to) => {
        calls += 1
        if (calls === failingCall) return Promise.reject(new Error('injected rename failure'))
        return fsRename(from, to)
      },
    })
    const result = await failing.update('fixture-plugin', { ref: 'v2.0.0', commit: await fixtureSha(source) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.step).toBe('move')

    const installed = await getInstalled('fixture-plugin')
    expect(installed!.version).toBe('1.0.0')
    expect(await readFile(join(pluginFolder('fixture-plugin'), 'mc-plugin.json'), 'utf8')).toContain('1.0.0')
    const stale = (await readdir(join(configDir, 'plugins'))).filter(entry => entry.startsWith('fixture-plugin.old-'))
    expect(stale).toEqual([])
  })

  test('rollback when saving plugins.json fails', async () => {
    const source = await repo('rollback-save', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    await installOk(fileUrl(source), await fixtureSha(source))
    const before = await readFile(configPath('plugins.json'), 'utf8')
    await commitFixture(source, {
      'mc-plugin.json': `${JSON.stringify(isolatedManifest({ version: '2.0.0' }), null, 2)}\n`,
    }, { tag: 'v2.0.0' })

    const failing = createInstaller({ saveInstalled: () => Promise.reject(new Error('registry write failed')) })
    const result = await failing.update('fixture-plugin', { ref: 'v2.0.0', commit: await fixtureSha(source) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.step).toBe('move')

    expect(await readFile(configPath('plugins.json'), 'utf8')).toBe(before)
    expect((await getInstalled('fixture-plugin'))!.version).toBe('1.0.0')
    expect(await readFile(join(pluginFolder('fixture-plugin'), 'mc-plugin.json'), 'utf8')).toContain('1.0.0')
  })

  test('a stale .old- folder is removed by the next lifecycle call', async () => {
    const source = await repo('stale-old', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    await installOk(fileUrl(source), await fixtureSha(source))
    const stale = join(configDir, 'plugins', 'fixture-plugin.old-1')
    await mkdir(stale, { recursive: true })

    await commitFixture(source, {
      'mc-plugin.json': `${JSON.stringify(isolatedManifest({ version: '2.0.0' }), null, 2)}\n`,
    }, { tag: 'v2.0.0' })
    const result = await installer().update('fixture-plugin', { ref: 'v2.0.0', commit: await fixtureSha(source) })
    expect(result.ok).toBe(true)
    expect(await pathExists(stale)).toBe(false)
  })
})

describe('uninstall and enable', () => {
  test('uninstall keeps plugin-data by default and removes it on request', async () => {
    const source = await repo('isolated', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    await installOk(fileUrl(source), await fixtureSha(source))
    await setSetting('fixture-plugin', 'token', 'pk-secret-value')

    const kept = await installer().uninstall('fixture-plugin')
    expect(kept.ok && kept.keptData).toBe(true)
    expect(await pathExists(pluginFolder('fixture-plugin'))).toBe(false)
    expect(await getInstalled('fixture-plugin')).toBeNull()
    expect(await getSetting('fixture-plugin', 'token')).toBe('pk-secret-value')

    await installOk(fileUrl(source), await fixtureSha(source))
    const wiped = await installer().uninstall('fixture-plugin', { keepData: false })
    expect(wiped.ok && wiped.keptData).toBe(false)
    expect(await pathExists(join(configDir, 'plugin-data', 'fixture-plugin'))).toBe(false)
  })

  test('uninstall refuses an unknown plugin', async () => {
    const result = await installer().uninstall('nope')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  test('setEnabled flips the flag and keeps the rest', async () => {
    const source = await repo('isolated', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    const plugin = await installOk(fileUrl(source), await fixtureSha(source))
    const result = await installer().setEnabled('fixture-plugin', false)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plugin.enabled).toBe(false)
      expect(result.plugin.installedAt).toBe(plugin.installedAt)
    }
    expect((await getInstalled('fixture-plugin'))!.enabled).toBe(false)
  })
})

describe('settings', () => {
  test('the view masks secrets and reports which fields are configured', async () => {
    const source = await repo('settings', isolatedManifest({
      settings: [
        { key: 'token', label: 'Token', type: 'secret' },
        { key: 'note', label: 'Note', type: 'text' },
      ],
    }), { 'src/screen.ts': TRIVIAL_SCREEN })
    await installOk(fileUrl(source), await fixtureSha(source))
    await setSetting('fixture-plugin', 'token', 'pk-secret-value')
    await setSetting('fixture-plugin', 'note', 'hello')

    const view = await settingsView('fixture-plugin')
    expect(view.ok).toBe(true)
    if (view.ok) {
      expect(view.value.values).toEqual({ note: 'hello' })
      expect(view.value.configured).toEqual({ token: true, note: true })
      expect(JSON.stringify(view.value)).not.toContain('pk-secret-value')
    }
  })

  test('setting an undeclared key is refused and null deletes', async () => {
    const source = await repo('settings', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    await installOk(fileUrl(source), await fixtureSha(source))

    const refused = await setSetting('fixture-plugin', 'nope', 'x')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.status).toBe(400)

    await setSetting('fixture-plugin', 'token', 'pk-1')
    expect(await getSetting('fixture-plugin', 'token')).toBe('pk-1')
    await setSetting('fixture-plugin', 'token', null)
    expect(await getSetting('fixture-plugin', 'token')).toBeNull()
  })

  test('a key declared as both secret and text never leaks its value', async () => {
    const source = await repo('dup-key', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
    await installOk(fileUrl(source), await fixtureSha(source))
    const installed = await getInstalled('fixture-plugin')
    await saveInstalled({ ...installed!, settingsFields: [
      { key: 'token', label: 'Token', type: 'secret' },
      { key: 'token', label: 'Token again', type: 'text' },
    ] })
    await setSetting('fixture-plugin', 'token', 'pk-dup-secret')

    const view = await settingsView('fixture-plugin')
    expect(view.ok).toBe(true)
    if (view.ok) {
      expect(view.value.values).toEqual({})
      expect(JSON.stringify(view.value)).not.toContain('pk-dup-secret')
    }
  })
})

describe('marketplaces', () => {
  test('catalog merges listings and skips invalid entries with a reason', async () => {
    const valid: CatalogPlugin = { id: 'fixture-plugin', repo: 'https://github.com/LynchzDEV/mc-plugin-fixture', ref: 'v1.0.0', name: 'Fixture', description: 'd', runtime: 'isolated' }
    const listing = {
      name: 'Fixture marketplace',
      plugins: [
        valid,
        { id: 'no-repo', ref: 'v1.0.0', name: 'No repo', runtime: 'isolated' },
      ],
    }
    const source = await createPluginRepo(join(fixtureRoot, 'market'), listing, { tag: 'v1.0.0', manifestName: 'marketplace.json' })
    const added = await addMarketplace(fileUrl(source))
    expect(added.ok).toBe(true)

    const entries = await catalog()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      marketplace: fileUrl(source),
      name: 'Fixture marketplace',
      plugins: [valid],
      skipped: [{ id: 'no-repo', reason: 'missing repo' }],
    })
  })

  test('a malformed marketplace.json reports an error entry', async () => {
    const source = await createPluginRepo(join(fixtureRoot, 'broken-market'), { note: 'x' }, { manifestName: 'README.md' })
    await commitFixture(source, { 'marketplace.json': '{ not json' }, { tag: 'v1.0.0' })
    expect((await addMarketplace(fileUrl(source))).ok).toBe(true)

    const entries = await catalog()
    expect(entries[0]).toEqual({ marketplace: fileUrl(source), error: 'marketplace.json is not valid JSON' })
  })

  test('re-syncing fetches new listings and the clone folder is 0700', async () => {
    const repoDir = await createPluginRepo(join(fixtureRoot, 'resync'), { name: 'First', plugins: [] }, { manifestName: 'marketplace.json' })
    const url = fileUrl(repoDir)
    expect((await addMarketplace(url)).ok).toBe(true)
    expect((await catalog())[0]).toMatchObject({ name: 'First', plugins: [] })
    expect((await stat(join(configDir, 'marketplaces'))).mode & 0o777).toBe(0o700)

    await commitFixture(repoDir, { 'marketplace.json': `${JSON.stringify({ name: 'Second', plugins: [] })}\n` })
    await syncMarketplace(url)
    expect((await catalog())[0]).toMatchObject({ name: 'Second' })
  })

  test('an unreachable marketplace is refused', async () => {
    const result = await addMarketplace(fileUrl(join(fixtureRoot, 'nope')))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  test('marketplace clone files are private', async () => {
    const source = await createPluginRepo(join(fixtureRoot, 'private-market'), { name: 'Private', plugins: [] }, { manifestName: 'marketplace.json' })
    expect((await addMarketplace(fileUrl(source))).ok).toBe(true)
    await expectPrivateTree(join(configDir, 'marketplaces', marketplaceSlug(fileUrl(source))))
  })
})

describe('contributed agents, skills and flows', () => {
  const AGENT = '---\nname: biz-gate\ndescription: Gate a card.\n---\nRepos in {{setting:reposRoot}}.\n'
  const SKILL = '---\nname: card-refine\ndescription: Refine.\n---\nRun {{mc:mctl}}.\n'
  const FLOW = JSON.stringify({ id: 'card-pipeline', name: 'Card pipeline', entry: 'gate', nodes: [{ id: 'gate', title: 'Gate', instructions: 'Run it.', kind: 'task' }], edges: [] })
  let targets: string[]
  let syncs: number

  const contributingManifest = (overrides: Record<string, unknown> = {}) => isolatedManifest({
    pluginApi: 2,
    settings: [{ key: 'reposRoot', label: 'Repos', type: 'text' }],
    contributes: { agents: ['agents/biz-gate.md'], skills: ['skills/card-refine'], flows: ['flows/card-pipeline.json'] },
    ...overrides,
  })
  const contributingFiles = { 'src/screen.ts': TRIVIAL_SCREEN, 'agents/biz-gate.md': AGENT, 'skills/card-refine/SKILL.md': SKILL, 'flows/card-pipeline.json': FLOW }
  const contributingInstaller = () => createInstaller({ contributionTargets: () => targets, cliCommand: () => 'shiki', syncEngineAssets: async () => { syncs += 1 } })

  beforeEach(() => {
    targets = [join(configDir, 'home-claude'), join(configDir, 'worker-claude')]
    syncs = 0
  })

  async function installContributing(manifest = contributingManifest(), files: Record<string, string> = contributingFiles, trust = true) {
    const source = await repo('contributing', manifest, files)
    return contributingInstaller().install({ repo: fileUrl(source), ref: 'v1.0.0', commit: await fixtureSha(source), trust })
  }

  test('needs trust even when the runtime is isolated', async () => {
    const result = await installContributing(contributingManifest(), contributingFiles, false)
    expect(result).toEqual({ ok: false, status: 400, error: 'Plugins that add agents, skills or flows need trust: true' })
    await assertNothingInstalled('fixture-plugin')
  })

  test('install copies the agent and skill into every profile and records what it wrote', async () => {
    const result = await installContributing()
    if (!result.ok) throw new Error(JSON.stringify(result))
    for (const target of targets) {
      expect(await readFile(join(target, 'agents', 'biz-gate.md'), 'utf8')).toContain('<!-- installed by shikidan plugin fixture-plugin -->')
      expect(await readFile(join(target, 'skills', 'card-refine', 'SKILL.md'), 'utf8')).toContain('Run shiki.')
    }
    const saved = await getInstalled('fixture-plugin')
    expect(saved?.contributes).toEqual({ agents: ['agents/biz-gate.md'], skills: ['skills/card-refine'], flows: ['flows/card-pipeline.json'] })
    expect(saved?.contributedPaths?.length).toBe(4)
    expect(syncs).toBe(1)
  })

  test('install stops on an agent the user already has and leaves nothing behind', async () => {
    await mkdir(join(targets[0]!, 'agents'), { recursive: true })
    await writeFile(join(targets[0]!, 'agents', 'biz-gate.md'), 'mine\n')
    const result = await installContributing()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.step).toBe('contributions')
    expect(await readFile(join(targets[0]!, 'agents', 'biz-gate.md'), 'utf8')).toBe('mine\n')
    await assertNothingInstalled('fixture-plugin')
  })

  test('install refuses a broken flow', async () => {
    const result = await installContributing(contributingManifest(), { ...contributingFiles, 'flows/card-pipeline.json': '{"id":"x"}' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.step).toBe('contributions')
    await assertNothingInstalled('fixture-plugin')
  })

  test('disable removes the files, enable puts them back, uninstall removes them', async () => {
    const result = await installContributing()
    if (!result.ok) throw new Error(JSON.stringify(result))
    const agent = join(targets[1]!, 'agents', 'biz-gate.md')
    await contributingInstaller().setEnabled('fixture-plugin', false)
    expect(await pathExists(agent)).toBe(false)
    await contributingInstaller().setEnabled('fixture-plugin', true)
    expect(await pathExists(agent)).toBe(true)
    await contributingInstaller().uninstall('fixture-plugin')
    expect(await pathExists(agent)).toBe(false)
    expect(await pathExists(join(targets[1]!, 'skills', 'card-refine'))).toBe(false)
  })

  test('an update that adds an agent asks for consent', async () => {
    const source = await repo('contributing', contributingManifest({ contributes: { agents: ['agents/biz-gate.md'] } }), contributingFiles)
    const first = await contributingInstaller().install({ repo: fileUrl(source), ref: 'v1.0.0', commit: await fixtureSha(source), trust: true })
    if (!first.ok) throw new Error(JSON.stringify(first))
    await commitFixture(source, { 'mc-plugin.json': `${JSON.stringify(contributingManifest(), null, 2)}\n` }, { tag: 'v1.1.0' })
    const result = await contributingInstaller().update('fixture-plugin', { ref: 'v1.1.0', commit: await fixtureSha(source) })
    expect(result).toEqual({ ok: false, status: 409, needsConsent: true, added: ['Add the skill skills/card-refine to your engines', 'Add the Studio flow flows/card-pipeline.json'] })
  })
})

describe('plugin requirements', () => {
  const REQUIRED = 'board-core'

  const needing = (id: string, requires: Array<{ id: string; version?: string }>, overrides: Record<string, unknown> = {}) =>
    isolatedManifest({ id, name: `Plugin ${id}`, requires, ...overrides })

  async function pluginAt(id: string, overrides: Record<string, unknown> = {}, tag = 'v1.0.0'): Promise<string> {
    return createPluginRepo(join(fixtureRoot, id), isolatedManifest({ id, name: `Plugin ${id}`, ...overrides }), { files: { 'src/screen.ts': TRIVIAL_SCREEN }, tag })
  }

  async function release(source: string, id: string, version: string, overrides: Record<string, unknown> = {}): Promise<void> {
    await commitFixture(source, { 'mc-plugin.json': `${JSON.stringify(isolatedManifest({ id, name: `Plugin ${id}`, version, ...overrides }), null, 2)}\n` }, { tag: `v${version}` })
  }

  async function marketplaceOf(name: string, entries: Array<{ id: string; source: string; ref?: string }>): Promise<string> {
    const plugins = entries.map(entry => ({ id: entry.id, repo: fileUrl(entry.source), ref: entry.ref ?? 'v1.0.0', name: entry.id, description: '', runtime: 'isolated' }))
    const market = await createPluginRepo(join(fixtureRoot, `market-${name}`), { name, plugins }, { manifestName: 'marketplace.json' })
    const url = fileUrl(market)
    expect((await addMarketplace(url)).ok).toBe(true)
    return url
  }

  async function mainNeeding(requires: Array<{ id: string; version?: string }>, id = 'main-plugin'): Promise<{ source: string; url: string; sha: string }> {
    const source = await createPluginRepo(join(fixtureRoot, id), needing(id, requires), { files: { 'src/screen.ts': TRIVIAL_SCREEN }, tag: 'v1.0.0' })
    return { source, url: fileUrl(source), sha: await fixtureSha(source) }
  }

  async function previewRequires(main: { url: string }, marketplace?: string) {
    const result = await installer().preview({ repo: main.url, ref: 'v1.0.0', ...(marketplace === undefined ? {} : { marketplace }) })
    if (!result.ok) throw new Error(`preview failed: ${JSON.stringify(result)}`)
    return result.requires
  }

  describe('preview', () => {
    test('a missing requirement is an install step with its version, commit and permissions', async () => {
      const dependency = await pluginAt(REQUIRED, { version: '1.0.0' })
      const market = await marketplaceOf('main', [{ id: REQUIRED, source: dependency }])
      const main = await mainNeeding([{ id: REQUIRED, version: '1.0.0' }])

      const requires = await previewRequires(main)
      expect(requires).toEqual([{
        id: REQUIRED,
        minVersion: '1.0.0',
        status: 'install',
        listing: { repo: fileUrl(dependency), ref: 'v1.0.0', marketplace: market },
        preview: { manifest: { id: REQUIRED, name: `Plugin ${REQUIRED}`, version: '1.0.0' }, commit: await fixtureSha(dependency), permissions: { network: ['api.example.com'], sessions: ['chat'], settings: true }, runtime: 'isolated' },
      }])
    })

    test('a plugin without requires previews with an empty list', async () => {
      const source = await repo('plain', isolatedManifest(), { 'src/screen.ts': TRIVIAL_SCREEN })
      expect(await previewRequires({ url: fileUrl(source) })).toEqual([])
    })

    test('contributions in a required plugin are shown on its step', async () => {
      const dependency = await createPluginRepo(join(fixtureRoot, REQUIRED), isolatedManifest({ id: REQUIRED, pluginApi: 2, contributes: { skills: ['skills/card-refine'] } }), { files: { 'src/screen.ts': TRIVIAL_SCREEN, 'skills/card-refine/SKILL.md': '---\nname: card-refine\ndescription: x\n---\n' }, tag: 'v1.0.0' })
      await marketplaceOf('main', [{ id: REQUIRED, source: dependency }])
      const [step] = await previewRequires(await mainNeeding([{ id: REQUIRED }]))
      expect(step?.status === 'install' && step.preview.contributes).toEqual({ skills: ['skills/card-refine'] })
    })

    test('reports ok, enable, update and the two unavailable cases', async () => {
      const okRepo = await pluginAt('dep-ok')
      const offRepo = await pluginAt('dep-off')
      const staleRepo = await pluginAt('dep-stale')
      await release(staleRepo, 'dep-stale', '2.0.0')
      const youngRepo = await pluginAt('dep-young')
      const market = await marketplaceOf('main', [
        { id: 'dep-stale', source: staleRepo, ref: 'v2.0.0' },
        { id: 'dep-young', source: youngRepo },
      ])
      await installOk(fileUrl(okRepo), await fixtureSha(okRepo))
      await installOk(fileUrl(offRepo), await fixtureSha(offRepo))
      await installer().setEnabled('dep-off', false)
      const staleOld = await installer().install({ repo: fileUrl(staleRepo), ref: 'v1.0.0', commit: (await Bun.$`git -C ${staleRepo} rev-parse v1.0.0`.text()).trim(), marketplace: market })
      expect(staleOld.ok).toBe(true)

      const main = await mainNeeding([
        { id: 'dep-ok', version: '1.0.0' },
        { id: 'dep-off' },
        { id: 'dep-stale', version: '2.0.0' },
        { id: 'dep-gone' },
        { id: 'dep-young', version: '3.0.0' },
      ])
      const byId = Object.fromEntries((await previewRequires(main)).map(step => [step.id, step]))

      expect(byId['dep-ok']).toEqual({ id: 'dep-ok', minVersion: '1.0.0', status: 'ok', installedVersion: '1.0.0' })
      expect(byId['dep-off']).toEqual({ id: 'dep-off', status: 'enable', installedVersion: '1.0.0', name: 'Plugin dep-off' })
      expect(byId['dep-stale']).toMatchObject({ status: 'update', installedVersion: '1.0.0', listing: { ref: 'v2.0.0' }, preview: { manifest: { version: '2.0.0' } } })
      expect(byId['dep-gone']).toEqual({ id: 'dep-gone', status: 'unavailable', reason: 'dep-gone is not in your marketplaces. Add the marketplace that has it, or install it first.' })
      expect(byId['dep-young']).toEqual({ id: 'dep-young', minVersion: '3.0.0', status: 'unavailable', reason: 'The marketplace has dep-young v1.0.0; this needs v3.0.0 or newer' })
    })

    test('an installed plugin whose marketplace now lists a different repo cannot be updated', async () => {
      const installedFrom = await pluginAt('dep-moved')
      await installOk(fileUrl(installedFrom), await fixtureSha(installedFrom))
      const elsewhere = await createPluginRepo(join(fixtureRoot, 'dep-moved-elsewhere'), isolatedManifest({ id: 'dep-moved', version: '2.0.0' }), { files: { 'src/screen.ts': TRIVIAL_SCREEN }, tag: 'v1.0.0' })
      const market = await marketplaceOf('main', [{ id: 'dep-moved', source: elsewhere }])
      await saveInstalled({ ...(await getInstalled('dep-moved'))!, source: { repo: fileUrl(installedFrom), ref: 'v1.0.0', marketplace: market } })

      const [step] = await previewRequires(await mainNeeding([{ id: 'dep-moved', version: '2.0.0' }]))
      expect(step).toEqual({ id: 'dep-moved', minVersion: '2.0.0', status: 'unavailable', reason: 'The marketplace copy of dep-moved comes from a different repo' })
    })

    test('a listing that points at a different plugin is unavailable', async () => {
      const impostor = await pluginAt('someone-else')
      await marketplaceOf('main', [{ id: REQUIRED, source: impostor }])
      const [step] = await previewRequires(await mainNeeding([{ id: REQUIRED }]))
      expect(step?.status).toBe('unavailable')
    })

    test('a listing that cannot be cloned is unavailable with the clone error', async () => {
      const dependency = await pluginAt(REQUIRED)
      await marketplaceOf('main', [{ id: REQUIRED, source: dependency, ref: 'v9.9.9' }])
      const [step] = await previewRequires(await mainNeeding([{ id: REQUIRED }]))
      expect(step?.status).toBe('unavailable')
      expect(step?.status === 'unavailable' && step.reason.length).toBeGreaterThan(0)
    })

    test('with a marketplace given only that marketplace is searched; without one the first match wins', async () => {
      const first = await pluginAt('dep-first')
      const second = await pluginAt('dep-second')
      const firstMarket = await marketplaceOf('first', [{ id: 'dep-first', source: first }])
      const secondMarket = await marketplaceOf('second', [{ id: 'dep-second', source: second }, { id: 'dep-first', source: second }])
      const main = await mainNeeding([{ id: 'dep-first' }, { id: 'dep-second' }])

      const scoped = await previewRequires(main, firstMarket)
      expect(scoped.map(step => step.status)).toEqual(['install', 'unavailable'])

      const open = await previewRequires(main)
      expect(open.map(step => step.status === 'install' && step.listing.marketplace)).toEqual([firstMarket, secondMarket])
    })

    test('requirements of requirements come first, once each, and a cycle stops', async () => {
      const top = await pluginAt('dep-top')
      const middle = await pluginAt('dep-middle')
      const bottom = await pluginAt('dep-bottom')
      await release(top, 'dep-top', '1.0.1', { requires: [{ id: 'dep-middle' }, { id: 'dep-bottom' }] })
      await release(middle, 'dep-middle', '1.0.1', { requires: [{ id: 'dep-bottom' }, { id: 'main-plugin' }] })
      await marketplaceOf('main', [
        { id: 'dep-top', source: top, ref: 'v1.0.1' },
        { id: 'dep-middle', source: middle, ref: 'v1.0.1' },
        { id: 'dep-bottom', source: bottom },
      ])
      const requires = await previewRequires(await mainNeeding([{ id: 'dep-top' }]))
      expect(requires.map(step => step.id)).toEqual(['dep-bottom', 'dep-middle', 'dep-top'])
    })

    test('requirements nested deeper than three levels are unavailable', async () => {
      const chain = ['dep-one', 'dep-two', 'dep-three', 'dep-four']
      const sources: Array<{ id: string; source: string }> = []
      for (const [index, id] of chain.entries()) {
        const next = chain[index + 1]
        sources.push({ id, source: await pluginAt(id, next === undefined ? {} : { requires: [{ id: next }] }) })
      }
      await marketplaceOf('main', sources)
      const requires = await previewRequires(await mainNeeding([{ id: 'dep-one' }]))
      expect(requires.map(step => [step.id, step.status])).toEqual([['dep-four', 'unavailable'], ['dep-three', 'install'], ['dep-two', 'install'], ['dep-one', 'install']])
      const deep = requires[0]
      expect(deep?.status === 'unavailable' && deep.reason).toBe('Requirements nest too deep')
    })
  })
})
