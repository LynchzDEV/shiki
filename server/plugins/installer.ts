import { settingsFile } from './settings'
import { mkdir, mkdtemp, readdir, rename as fsRename, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { syncEngineAssets } from '../engine-assets'
import { gitTimed } from '../job-worktrees'
import { DIR_MODE, configDir, ensureConfigDir } from '../secrets'
import { applyPrivateModes, findEscapingLink } from './checkout-tree'
import { errorMessage } from './errors'
import { PluginBusyError, withPluginLock } from './locks'
import { checkFlows, contributionTargets, cliCommand, removeContributions, syncContributions } from './contributions'
import { catalog } from './marketplaces'
import { contributionsAdded, parseManifest, permissionsAdded, type PluginManifest } from './manifest'
import { isAllowedRepoUrl } from './repo-url'
import { outcomeOf, resolveRequirements, withRequirements, type CheckoutPreview, type NeedsRequirementsFailure, type RequirementActions, type RequirementConsent, type RequirementListing, type RequirementStep, type ResolverPorts } from './requirements'
import { invalidateRuntime } from './runtimes'
import { getInstalled, pluginFolder, pluginsRoot, removeInstalled, saveInstalled, type InstalledPlugin } from './store'

const GIT_TIMEOUT = 120_000

export type InstallStep = 'clone' | 'manifest' | 'dependencies' | 'build' | 'move' | 'contributions' | 'requirements'

export type StepFailure = { ok: false; status: number; error: string; step: InstallStep; requirement?: string }
export type MessageFailure = { ok: false; status: number; error: string; step?: undefined }
export type ConsentFailure = { ok: false; status: 409; needsConsent: true; added: string[]; error?: undefined; step?: undefined }
export type TrustFailure = { ok: false; status: 409; needsTrust: true; error?: undefined; step?: undefined }
export type PreviewInput = { repo: string; ref: string; marketplace?: string }
type CheckoutPreviewResult = Extract<CheckoutPreview, { ok: true }>
type RawPreviewResult = CheckoutPreviewResult | StepFailure | MessageFailure
export type PreviewResult = (CheckoutPreviewResult & { requires: RequirementStep[] }) | StepFailure | MessageFailure

export type InstallInput = { repo: string; ref: string; commit: string; trust?: boolean; marketplace?: string; requirements?: RequirementConsent[] }
type PluginOk = { ok: true; plugin: InstalledPlugin }
type InstallFailure = StepFailure | MessageFailure
export type InstallResult = (PluginOk & { installedRequirements: string[] }) | InstallFailure | NeedsRequirementsFailure

export type UpdateInput = { ref?: string; commit: string; accept?: boolean; trust?: boolean; repo?: string; requirements?: RequirementConsent[] }
type UpdateFailure = InstallFailure | ConsentFailure | TrustFailure
export type UpdateResult = (PluginOk & { installedRequirements: string[] }) | UpdateFailure | NeedsRequirementsFailure

export type UninstallResult = { ok: true; keptData: boolean } | MessageFailure
export type SetEnabledResult = { ok: true; plugin: InstalledPlugin } | MessageFailure

export type MarketplaceListing = { repo: string; ref: string }

export type InstallerDeps = {
  git: (cwd: string, args: string[]) => Promise<string>
  runBunInstall: (dir: string) => Promise<void>
  build: (options: { entry: string; outdir: string; format: 'iife' | 'esm'; target?: 'browser' | 'bun'; naming?: string; minify?: boolean }) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  saveInstalled: (plugin: InstalledPlugin) => Promise<void>
  marketplaceListing: (marketplace: string, pluginId: string) => Promise<MarketplaceListing | null>
  findListing: (pluginId: string, marketplace?: string) => Promise<RequirementListing | null>
  contributionTargets: () => string[]
  cliCommand: () => string
  syncEngineAssets: () => Promise<unknown>
}

const CONTRIBUTIONS_NEED_TRUST = 'Plugins that add agents, skills or flows need trust: true'

const defaultGit = (cwd: string, args: string[]): Promise<string> => gitTimed(cwd, GIT_TIMEOUT, args)

async function defaultFindListing(pluginId: string, marketplace?: string): Promise<RequirementListing | null> {
  for (const entry of await catalog()) {
    if ('error' in entry) continue
    if (marketplace !== undefined && entry.marketplace !== marketplace) continue
    const found = entry.plugins.find(plugin => plugin.id === pluginId)
    if (found !== undefined) return { repo: found.repo, ref: found.ref, marketplace: entry.marketplace }
  }
  return null
}

async function defaultMarketplaceListing(marketplace: string, pluginId: string): Promise<MarketplaceListing | null> {
  const found = await defaultFindListing(pluginId, marketplace)
  return found === null ? null : { repo: found.repo, ref: found.ref }
}

function linkFailure(link: string, step: InstallStep): StepFailure {
  return { ok: false, status: 400, error: `The plugin contains a link pointing outside its folder: ${link}`, step }
}

async function checkSourceLinks(checkout: string): Promise<StepFailure | null> {
  const link = await findEscapingLink(checkout)
  return link === null ? null : linkFailure(link, 'manifest')
}

async function defaultRunBunInstall(dir: string): Promise<void> {
  const proc = Bun.spawn(['bun', 'install', '--production', '--ignore-scripts'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(stderr.trim() || 'bun install failed')
}

async function defaultBuild(options: { entry: string; outdir: string; format: 'iife' | 'esm'; target?: 'browser' | 'bun'; naming?: string; minify?: boolean }): Promise<void> {
  try {
    const result = await Bun.build({
      entrypoints: [options.entry],
      target: options.target ?? 'browser',
      format: options.format,
      outdir: options.outdir,
      naming: options.naming ?? { entry: 'screen.[ext]', chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' },
      minify: options.minify ?? true,
    })
    if (!result.success) throw new Error(result.logs.map(String).join('\n'))
  } catch (error) {
    throw new Error(errorMessage(error))
  }
}

export function createInstaller(overrides: Partial<InstallerDeps> = {}) {
  const deps: InstallerDeps = {
    git: defaultGit,
    runBunInstall: defaultRunBunInstall,
    build: defaultBuild,
    rename: (from, to) => fsRename(from, to),
    saveInstalled,
    marketplaceListing: defaultMarketplaceListing,
    findListing: defaultFindListing,
    contributionTargets,
    cliCommand,
    syncEngineAssets,
    ...overrides,
  }
  const contributionOptions = () => ({ targets: deps.contributionTargets(), shiki: deps.cliCommand() })

  async function contributionFailure(folder: string, manifest: PluginManifest): Promise<StepFailure | null> {
    const errors = await checkFlows(folder, manifest.contributes?.flows ?? [])
    return errors.length > 0 ? { ok: false, status: 400, error: errors.join('\n'), step: 'contributions' } : null
  }

  function checkedRepoRef(body: { repo?: unknown; ref?: unknown }): MessageFailure | null {
    if (typeof body.repo !== 'string' || body.repo === '') return { ok: false, status: 400, error: 'repo is required' }
    if (!isAllowedRepoUrl(body.repo)) return { ok: false, status: 400, error: 'The repo url must be https://, git@host:path or file://' }
    if (typeof body.ref !== 'string' || body.ref === '') return { ok: false, status: 400, error: 'ref is required' }
    return null
  }

  function checkedCommit(commit: unknown): MessageFailure | null {
    if (typeof commit !== 'string' || commit === '') return { ok: false, status: 400, error: 'commit is required — preview the plugin first' }
    return null
  }

  async function cloneAt(repo: string, ref: string, dest: string): Promise<StepFailure | null> {
    try {
      await deps.git(configDir(), ['clone', '--depth', '1', '--branch', ref, repo, dest])
      return null
    } catch {
      await rm(dest, { recursive: true, force: true })
    }
    try {
      await deps.git(configDir(), ['clone', repo, dest])
      await deps.git(dest, ['checkout', ref])
      return null
    } catch (error) {
      return { ok: false, status: 400, error: errorMessage(error), step: 'clone' }
    }
  }

  async function loadManifest(checkout: string): Promise<{ ok: true; manifest: PluginManifest } | StepFailure> {
    const file = join(checkout, 'mc-plugin.json')
    let raw: string
    try {
      raw = await Bun.file(file).text()
    } catch {
      return { ok: false, status: 400, error: 'mc-plugin.json is missing', step: 'manifest' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, status: 400, error: 'mc-plugin.json is not valid JSON', step: 'manifest' }
    }
    const result = parseManifest(parsed)
    if (!result.ok) return { ok: false, status: 400, error: result.errors.join('\n'), step: 'manifest' }
    return result
  }

  async function headSha(checkout: string): Promise<string> {
    return deps.git(checkout, ['rev-parse', 'HEAD'])
  }

  async function prepareBuild(checkout: string, manifest: PluginManifest): Promise<StepFailure | null> {
    if (await Bun.file(join(checkout, 'package.json')).exists()) {
      try {
        await deps.runBunInstall(checkout)
      } catch (error) {
        return { ok: false, status: 400, error: errorMessage(error), step: 'dependencies' }
      }
    }
    const dependencyLink = await findEscapingLink(checkout)
    if (dependencyLink !== null) return linkFailure(dependencyLink, 'build')
    if (manifest.screen !== undefined) {
      try {
        await deps.build({
          entry: join(checkout, manifest.screen),
          outdir: join(checkout, '.mc-build'),
          format: manifest.runtime === 'isolated' ? 'iife' : 'esm',
          minify: true,
        })
      } catch (error) {
        return { ok: false, status: 400, error: errorMessage(error), step: 'build' }
      }
    }
    if (manifest.runtime === 'isolated' && manifest.server !== undefined) {
      try {
        await deps.build({
          entry: join(checkout, manifest.server),
          outdir: join(checkout, '.mc-build'),
          format: 'esm',
          target: 'bun',
          naming: 'server.js',
        })
      } catch (error) {
        return { ok: false, status: 400, error: errorMessage(error), step: 'build' }
      }
    }
    try {
      await applyPrivateModes(checkout)
    } catch (error) {
      return { ok: false, status: 500, error: errorMessage(error), step: 'move' }
    }
    return null
  }

  async function removeStaleOldFolders(id: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(pluginsRoot())
    } catch {
      return
    }
    const prefix = `${id}.old-`
    await Promise.all(entries
      .filter(entry => entry.startsWith(prefix) && /^\d+$/.test(entry.slice(prefix.length)))
      .map(entry => rm(join(pluginsRoot(), entry), { recursive: true, force: true })))
  }

  function recordOf(manifest: PluginManifest, source: InstalledPlugin['source'], commit: string, installedAt: string): InstalledPlugin {
    const now = new Date().toISOString()
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      runtime: manifest.runtime,
      source,
      commit,
      permissions: manifest.permissions,
      settingsFields: manifest.settings ?? [],
      ...(manifest.icon !== undefined ? { icon: manifest.icon } : {}),
      ...(manifest.server !== undefined ? { server: manifest.server } : {}),
      ...(manifest.screen !== undefined ? { screen: manifest.screen } : {}),
      ...(manifest.queueSource === true ? { queueSource: true as const } : {}),
      ...(manifest.contributes !== undefined ? { contributes: manifest.contributes } : {}),
      ...(manifest.requires !== undefined ? { requires: manifest.requires } : {}),
      enabled: true,
      installedAt,
      updatedAt: now,
    }
  }

  async function previewCheckout(body: { repo: string; ref: string }): Promise<RawPreviewResult> {
    const invalid = checkedRepoRef(body)
    if (invalid !== null) return invalid
    await ensureConfigDir()
    const tmp = await mkdtemp(join(configDir(), 'plugins-tmp-'))
    try {
      const cloned = await cloneAt(body.repo, body.ref, tmp)
      if (cloned !== null) return cloned
      const manifest = await loadManifest(tmp)
      if (!manifest.ok) return manifest
      const unsafe = await checkSourceLinks(tmp)
      if (unsafe !== null) return unsafe
      return {
        ok: true,
        manifest: manifest.manifest,
        commit: await headSha(tmp),
        permissions: manifest.manifest.permissions,
        runtime: manifest.manifest.runtime,
      }
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  const resolverPorts: ResolverPorts = {
    getInstalled,
    findListing: (id, marketplace) => deps.findListing(id, marketplace),
    previewCheckout: (repo, ref) => previewCheckout({ repo, ref }),
  }

  async function preview(body: PreviewInput): Promise<PreviewResult> {
    const checkout = await previewCheckout(body)
    if (!checkout.ok) return checkout
    return { ...checkout, requires: await resolveRequirements(checkout.manifest, body.marketplace, resolverPorts) }
  }

  const requirementActions: RequirementActions = {
    install: async input => outcomeOf(await installCore(input)),
    update: async (id, input) => outcomeOf(await updateCore(id, input)),
    setEnabled: async (id, enabled) => outcomeOf(await setEnabled(id, enabled)),
    uninstall: async id => outcomeOf(await uninstall(id, { keepData: false })),
  }

  async function installLocked(manifest: PluginManifest, body: InstallInput, tmp: string, sha: string): Promise<InstallResult> {
    if (await getInstalled(manifest.id) !== null) return { ok: false, status: 409, error: 'Already installed; use Update' }
    const prepared = await prepareBuild(tmp, manifest)
    if (prepared !== null) return prepared
    await mkdir(pluginsRoot(), { recursive: true, mode: DIR_MODE })
    const target = pluginFolder(manifest.id)
    const fresh = recordOf(manifest, { repo: body.repo, ref: body.ref, ...(body.marketplace !== undefined ? { marketplace: body.marketplace } : {}) }, sha, new Date().toISOString())
    const badFlow = await contributionFailure(tmp, manifest)
    if (badFlow !== null) return badFlow
    try {
      await deps.rename(tmp, target)
    } catch (error) {
      await rm(target, { recursive: true, force: true })
      return { ok: false, status: 500, error: errorMessage(error), step: 'move' }
    }
    const applied = await syncContributions(fresh, contributionOptions())
    if (!applied.ok) {
      await rm(target, { recursive: true, force: true })
      return { ok: false, status: 409, error: applied.error, step: 'contributions' }
    }
    const record: InstalledPlugin = manifest.contributes !== undefined ? { ...fresh, contributedPaths: applied.written } : fresh
    try {
      await deps.saveInstalled(record)
    } catch (error) {
      await removeContributions(manifest.id, applied.written)
      await rm(target, { recursive: true, force: true })
      return { ok: false, status: 500, error: errorMessage(error), step: 'move' }
    }
    if (manifest.contributes !== undefined) await deps.syncEngineAssets()
    return { ok: true, plugin: record }
  }

  async function installFrom<R>(
    body: InstallInput,
    around: (manifest: PluginManifest, run: () => Promise<PluginOk | InstallFailure>) => Promise<R>,
  ): Promise<R | InstallFailure> {
    const invalid = checkedRepoRef(body)
    if (invalid !== null) return invalid
    const badCommit = checkedCommit(body.commit)
    if (badCommit !== null) return badCommit
    await ensureConfigDir()
    const tmp = await mkdtemp(join(configDir(), 'plugins-tmp-'))
    try {
      const cloned = await cloneAt(body.repo, body.ref, tmp)
      if (cloned !== null) return cloned
      const manifest = await loadManifest(tmp)
      if (!manifest.ok) return manifest
      const unsafe = await checkSourceLinks(tmp)
      if (unsafe !== null) return unsafe
      if (manifest.manifest.contributes !== undefined && body.trust !== true) {
        return { ok: false, status: 400, error: CONTRIBUTIONS_NEED_TRUST }
      }
      if (manifest.manifest.runtime === 'trusted' && body.trust !== true) {
        return { ok: false, status: 400, error: 'Trusted plugins need trust: true' }
      }
      const sha = await headSha(tmp)
      if (sha !== body.commit) return { ok: false, status: 409, error: 'The plugin changed since you reviewed it; preview again' }
      const run = async (): Promise<PluginOk | InstallFailure> => {
        try {
          return await withPluginLock(manifest.manifest.id, () => installLocked(manifest.manifest, body, tmp, sha))
        } catch (error) {
          if (error instanceof PluginBusyError) return { ok: false, status: 409, error: error.message }
          throw error
        }
      }
      return await around(manifest.manifest, run)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  const installCore = (body: InstallInput) => installFrom(body, (_manifest, run) => run())

  async function install(body: InstallInput): Promise<InstallResult> {
    return installFrom(body, async (manifest, run): Promise<InstallResult> => {
      if (await getInstalled(manifest.id) !== null) return { ok: false, status: 409, error: 'Already installed; use Update' }
      const steps = await resolveRequirements(manifest, body.marketplace, resolverPorts)
      return withRequirements({ steps, given: body.requirements, trust: body.trust === true, actions: requirementActions, mainName: manifest.name, verb: 'installed' }, run)
    })
  }

  async function replaceInstalled(id: string, tmp: string, record: InstalledPlugin): Promise<StepFailure | null> {
    const target = pluginFolder(id)
    const backup = `${target}.old-${Date.now()}`
    try {
      await deps.rename(target, backup)
    } catch (error) {
      return { ok: false, status: 500, error: errorMessage(error), step: 'move' }
    }
    try {
      await deps.rename(tmp, target)
      await deps.saveInstalled(record)
    } catch (error) {
      await rm(target, { recursive: true, force: true })
      try {
        await deps.rename(backup, target)
      } catch (restoreError) {
        console.error(`[plugins] could not restore ${backup}:`, restoreError)
      }
      return { ok: false, status: 500, error: errorMessage(error), step: 'move' }
    }
    try {
      await rm(backup, { recursive: true, force: true })
    } catch (cleanupError) {
      console.error(`[plugins] could not remove ${backup}:`, cleanupError)
    }
    return null
  }

  async function applyUpdate(installed: InstalledPlugin, manifest: PluginManifest, source: { repo: string; ref: string; tmp: string; sha: string }): Promise<PluginOk | InstallFailure> {
    const id = installed.id
    const prepared = await prepareBuild(source.tmp, manifest)
    if (prepared !== null) return prepared
    const badFlow = await contributionFailure(source.tmp, manifest)
    if (badFlow !== null) return badFlow
    const replacement: InstalledPlugin = {
      ...recordOf(manifest, { repo: source.repo, ref: source.ref, ...(installed.source.marketplace !== undefined ? { marketplace: installed.source.marketplace } : {}) }, source.sha, installed.installedAt),
      enabled: installed.enabled,
      ...(installed.runtime === 'trusted' && manifest.runtime === 'trusted' ? { restartRequired: true } : {}),
    }
    const replaced = await replaceInstalled(id, source.tmp, replacement)
    if (replaced !== null) return replaced
    await invalidateRuntime(id)
    if (installed.contributes === undefined && replacement.contributes === undefined) return { ok: true, plugin: replacement }
    const applied = await syncContributions({ ...replacement, contributedPaths: installed.contributedPaths ?? [] }, contributionOptions())
    if (!applied.ok) return { ok: false, status: 409, error: applied.error, step: 'contributions' }
    const record: InstalledPlugin = { ...replacement, contributedPaths: applied.written }
    await deps.saveInstalled(record)
    await deps.syncEngineAssets()
    return { ok: true, plugin: record }
  }

  async function updateFrom<R>(
    id: string,
    body: UpdateInput,
    around: (manifest: PluginManifest, installed: InstalledPlugin, run: () => Promise<PluginOk | InstallFailure>) => Promise<R>,
  ): Promise<R | UpdateFailure> {
    const badCommit = checkedCommit(body.commit)
    if (badCommit !== null) return badCommit
    try {
      return await withPluginLock(id, async () => {
        const installed = await getInstalled(id)
        if (installed === null) return { ok: false, status: 404, error: 'That plugin is not installed' }
        const repo = body.repo ?? installed.source.repo
        if (repo !== installed.source.repo) return { ok: false, status: 409, error: 'The update comes from a different repo' }
        if (!isAllowedRepoUrl(repo)) return { ok: false, status: 400, error: 'The repo url must be https://, git@host:path or file://' }
        let ref = body.ref
        if (ref === undefined && installed.source.marketplace !== undefined) {
          const listing = await deps.marketplaceListing(installed.source.marketplace, id)
          if (listing !== null) {
            if (listing.repo !== installed.source.repo) return { ok: false, status: 409, error: 'The update comes from a different repo' }
            ref = listing.ref
          }
        }
        if (ref === undefined) ref = installed.source.ref
        await removeStaleOldFolders(id)
        await ensureConfigDir()
        const tmp = await mkdtemp(join(configDir(), 'plugins-tmp-'))
        try {
          const cloned = await cloneAt(repo, ref, tmp)
          if (cloned !== null) return cloned
          const manifest = await loadManifest(tmp)
          if (!manifest.ok) return manifest
          const unsafe = await checkSourceLinks(tmp)
          if (unsafe !== null) return unsafe
          if (manifest.manifest.id !== id) return { ok: false, status: 409, error: 'The update changed the plugin id' }
          if (manifest.manifest.runtime === 'trusted' && installed.runtime === 'isolated' && body.trust !== true) {
            return { ok: false, status: 409, needsTrust: true }
          }
          if (manifest.manifest.contributes !== undefined && installed.contributes === undefined && body.trust !== true) {
            return { ok: false, status: 409, needsTrust: true }
          }
          const added = [
            ...permissionsAdded(installed.permissions, manifest.manifest.permissions),
            ...contributionsAdded(installed.contributes, manifest.manifest.contributes),
          ]
          if (added.length > 0 && body.accept !== true) return { ok: false, status: 409, needsConsent: true, added }
          const sha = await headSha(tmp)
          if (sha !== body.commit) return { ok: false, status: 409, error: 'The plugin changed since you reviewed it; preview again' }
          return await around(manifest.manifest, installed, () => applyUpdate(installed, manifest.manifest, { repo, ref, tmp, sha }))
        } finally {
          await rm(tmp, { recursive: true, force: true })
        }
      })
    } catch (error) {
      if (error instanceof PluginBusyError) return { ok: false, status: 409, error: error.message }
      throw error
    }
  }

  const updateCore = (id: string, body: UpdateInput) => updateFrom(id, body, (_manifest, _installed, run) => run())

  async function update(id: string, body: UpdateInput): Promise<UpdateResult> {
    return updateFrom(id, body, async (manifest, installed, run): Promise<UpdateResult> => {
      const steps = await resolveRequirements(manifest, installed.source.marketplace, resolverPorts)
      return withRequirements({ steps, given: body.requirements, trust: body.trust === true, actions: requirementActions, mainName: manifest.name, verb: 'updated' }, run)
    })
  }

  async function uninstall(id: string, options: { keepData?: boolean } = {}): Promise<UninstallResult> {
    try {
      return await withPluginLock(id, async () => {
        const installed = await getInstalled(id)
        if (installed === null) return { ok: false, status: 404, error: 'That plugin is not installed' }
        await removeContributions(id, installed.contributedPaths ?? [])
        await removeStaleOldFolders(id)
        await rm(pluginFolder(id), { recursive: true, force: true })
        await removeInstalled(id)
        if (installed.contributes !== undefined) await deps.syncEngineAssets()
        await invalidateRuntime(id)
        const keepData = options.keepData !== false
        if (!keepData) {
          await rm(join(configDir(), 'plugin-data', id), { recursive: true, force: true })
          await rm(join(configDir(), settingsFile(id)), { force: true })
        }
        return { ok: true, keptData: keepData }
      })
    } catch (error) {
      if (error instanceof PluginBusyError) return { ok: false, status: 409, error: error.message }
      throw error
    }
  }

  async function setEnabled(id: string, enabled: boolean): Promise<SetEnabledResult> {
    try {
      return await withPluginLock(id, async () => {
        const installed = await getInstalled(id)
        if (installed === null) return { ok: false, status: 404, error: 'That plugin is not installed' }
        const toggled: InstalledPlugin = { ...installed, enabled, updatedAt: new Date().toISOString() }
        const applied = installed.contributes === undefined ? null : await syncContributions(toggled, contributionOptions())
        if (applied !== null && !applied.ok) return { ok: false, status: 409, error: applied.error }
        const record: InstalledPlugin = applied === null ? toggled : { ...toggled, contributedPaths: applied.written }
        await deps.saveInstalled(record)
        if (applied !== null) await deps.syncEngineAssets()
        if (!enabled) await invalidateRuntime(id)
        return { ok: true, plugin: record }
      })
    } catch (error) {
      if (error instanceof PluginBusyError) return { ok: false, status: 409, error: error.message }
      throw error
    }
  }

  return { preview, install, update, uninstall, setEnabled }
}

export type Installer = ReturnType<typeof createInstaller>
