import type { PluginContributions, PluginManifest, PluginPermissions, PluginRequirement, PluginRuntime } from './manifest'
import type { InstallStep } from './installer'
import { listInstalled, type InstalledPlugin } from './store'

function versionParts(version: string): number[] {
  const numeric = version.match(/^[\d.]*/)?.[0] ?? ''
  return numeric.split('.').filter(part => part !== '').map(Number)
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export function satisfies(version: string, min?: string): boolean {
  return min === undefined || compareVersions(version, min) >= 0
}

export type RequirementListing = { repo: string; ref: string; marketplace: string }

export type RequirementPreview = {
  manifest: { id: string; name: string; version: string }
  commit: string
  permissions: PluginPermissions
  runtime: PluginRuntime
  contributes?: PluginContributions
}

type StepHead = { id: string; minVersion?: string }

export type RequirementStep =
  | (StepHead & { status: 'ok'; installedVersion: string })
  | (StepHead & { status: 'enable'; installedVersion: string; name: string })
  | (StepHead & { status: 'install' | 'update'; installedVersion?: string; listing: RequirementListing; preview: RequirementPreview })
  | (StepHead & { status: 'unavailable'; reason: string })

export type CheckoutPreview =
  | { ok: true; manifest: PluginManifest; commit: string; permissions: PluginPermissions; runtime: PluginRuntime }
  | { ok: false; error: string }

export type ResolverPorts = {
  getInstalled: (id: string) => Promise<InstalledPlugin | null>
  findListing: (id: string, marketplace?: string) => Promise<RequirementListing | null>
  previewCheckout: (repo: string, ref: string) => Promise<CheckoutPreview>
}

const MAX_DEPTH = 3

type Resolved = { step: RequirementStep; manifest?: PluginManifest }

const headOf = (requirement: PluginRequirement): StepHead => ({ id: requirement.id, ...(requirement.version !== undefined ? { minVersion: requirement.version } : {}) })

const unavailable = (requirement: PluginRequirement, reason: string): Resolved => ({ step: { ...headOf(requirement), status: 'unavailable', reason } })

async function resolveListed(requirement: PluginRequirement, installed: InstalledPlugin | undefined, origin: string | undefined, ports: ResolverPorts): Promise<Resolved> {
  const listing = await ports.findListing(requirement.id, installed?.source.marketplace ?? origin)
  if (listing === null) return unavailable(requirement, `${requirement.id} is not in your marketplaces. Add the marketplace that has it, or install it first.`)
  if (installed !== undefined && listing.repo !== installed.source.repo) return unavailable(requirement, `The marketplace copy of ${requirement.id} comes from a different repo`)
  const checkout = await ports.previewCheckout(listing.repo, listing.ref)
  if (!checkout.ok) return unavailable(requirement, checkout.error)
  const { manifest } = checkout
  if (manifest.id !== requirement.id) return unavailable(requirement, `The marketplace entry for ${requirement.id} is a different plugin (${manifest.id})`)
  if (!satisfies(manifest.version, requirement.version)) return unavailable(requirement, `The marketplace has ${requirement.id} v${manifest.version}; this needs v${requirement.version} or newer`)
  return {
    manifest,
    step: {
      ...headOf(requirement),
      status: installed === undefined ? 'install' : 'update',
      ...(installed !== undefined ? { installedVersion: installed.version } : {}),
      listing,
      preview: {
        manifest: { id: manifest.id, name: manifest.name, version: manifest.version },
        commit: checkout.commit,
        permissions: checkout.permissions,
        runtime: checkout.runtime,
        ...(manifest.contributes !== undefined ? { contributes: manifest.contributes } : {}),
      },
    },
  }
}

async function resolveOne(requirement: PluginRequirement, origin: string | undefined, ports: ResolverPorts): Promise<Resolved> {
  const installed = (await ports.getInstalled(requirement.id)) ?? undefined
  if (installed === undefined || !satisfies(installed.version, requirement.version)) return resolveListed(requirement, installed, origin, ports)
  const head = headOf(requirement)
  return { step: installed.enabled ? { ...head, status: 'ok', installedVersion: installed.version } : { ...head, status: 'enable', installedVersion: installed.version, name: installed.name } }
}

async function resolveLevel(manifest: PluginManifest, origin: string | undefined, depth: number, visited: Set<string>, ports: ResolverPorts): Promise<RequirementStep[]> {
  const steps: RequirementStep[] = []
  for (const requirement of manifest.requires ?? []) {
    if (visited.has(requirement.id)) continue
    visited.add(requirement.id)
    if (depth > MAX_DEPTH) {
      steps.push(unavailable(requirement, 'Requirements nest too deep').step)
      continue
    }
    const { step, manifest: required } = await resolveOne(requirement, origin, ports)
    if (required !== undefined && (step.status === 'install' || step.status === 'update')) {
      steps.push(...await resolveLevel(required, step.listing.marketplace, depth + 1, visited, ports))
    }
    steps.push(step)
  }
  return steps
}

export function resolveRequirements(manifest: PluginManifest, origin: string | undefined, ports: ResolverPorts): Promise<RequirementStep[]> {
  return resolveLevel(manifest, origin, 1, new Set([manifest.id]), ports)
}

export type RequirementConsent = { id: string; action: 'install' | 'update' | 'enable'; commit?: string }

export type ActionOutcome = { ok: true } | { ok: false; status: number; error: string; step?: InstallStep }

export type RequirementActions = {
  install: (input: { repo: string; ref: string; commit: string; trust: boolean; marketplace: string }) => Promise<ActionOutcome>
  update: (id: string, input: { ref: string; commit: string; accept: true; trust: boolean }) => Promise<ActionOutcome>
  setEnabled: (id: string, enabled: boolean) => Promise<ActionOutcome>
  uninstall: (id: string) => Promise<ActionOutcome>
}

export type NeedsRequirementsFailure = { ok: false; status: 409; needsRequirements: true; requirements: RequirementStep[]; error?: undefined; step?: undefined }

export type RequirementFailure = { ok: false; status: number; error: string; step: InstallStep; requirement?: string }

export function outcomeOf(result: { ok: true } | { ok: false; status: number; error?: string; step?: InstallStep }): ActionOutcome {
  if (result.ok) return { ok: true }
  return { ok: false, status: result.status, error: result.error ?? 'This change needs your approval', ...(result.step !== undefined ? { step: result.step } : {}) }
}

export type RequirementContext = {
  steps: RequirementStep[]
  given: RequirementConsent[] | undefined
  trust: boolean
  actions: RequirementActions
  mainName: string
  verb: 'installed' | 'updated'
}

type ActionableStep = Extract<RequirementStep, { status: 'install' | 'update' | 'enable' }>

const isActionable = (step: RequirementStep): step is ActionableStep => step.status === 'install' || step.status === 'update' || step.status === 'enable'

const stepName = (step: ActionableStep): string => (step.status === 'enable' ? step.name : step.preview.manifest.name)

const needsTrust = (step: ActionableStep): boolean => step.status !== 'enable' && (step.preview.runtime === 'trusted' || step.preview.contributes !== undefined)

function consented(step: ActionableStep, given: RequirementConsent[]): boolean {
  return given.some(entry => entry.id === step.id && entry.action === step.status && (step.status === 'enable' || entry.commit === step.preview.commit))
}

function gateFailure(context: RequirementContext): NeedsRequirementsFailure | RequirementFailure | null {
  const blocked = context.steps.find(step => step.status === 'unavailable')
  if (blocked?.status === 'unavailable') return { ok: false, status: 409, error: `${context.mainName} needs ${blocked.id}: ${blocked.reason}`, step: 'requirements' }
  const actionable = context.steps.filter(isActionable)
  if (!actionable.every(step => consented(step, context.given ?? []))) return { ok: false, status: 409, needsRequirements: true, requirements: context.steps }
  const trusting = actionable.find(needsTrust)
  if (trusting !== undefined && !context.trust) return { ok: false, status: 400, error: `${stepName(trusting)} needs trust: true`, step: 'requirements' }
  return null
}

function runStep(step: ActionableStep, context: RequirementContext): Promise<ActionOutcome> {
  if (step.status === 'enable') return context.actions.setEnabled(step.id, true)
  if (step.status === 'update') return context.actions.update(step.id, { ref: step.listing.ref, commit: step.preview.commit, accept: true, trust: context.trust })
  return context.actions.install({ repo: step.listing.repo, ref: step.listing.ref, commit: step.preview.commit, trust: context.trust, marketplace: step.listing.marketplace })
}

async function undoStep(step: ActionableStep, actions: RequirementActions): Promise<string> {
  const name = stepName(step)
  if (step.status === 'update') return `${name} was updated to v${step.preview.manifest.version}`
  if (step.status === 'enable') {
    const outcome = await actions.setEnabled(step.id, false)
    return outcome.ok ? `${name} was turned back off` : `${name} is still turned on: ${outcome.error}`
  }
  const outcome = await actions.uninstall(step.id)
  return outcome.ok ? `${name} was removed again` : `${name} was installed and could not be removed: ${outcome.error}`
}

async function undoAll(done: ActionableStep[], actions: RequirementActions): Promise<string[]> {
  const notes = new Map<string, string>()
  for (const step of [...done].reverse()) notes.set(step.id, await undoStep(step, actions))
  return done.map(step => notes.get(step.id)!)
}

async function failAfterRollback(context: RequirementContext, done: ActionableStep[], failure: { status: number; error: string; step?: InstallStep }, requirement?: ActionableStep): Promise<RequirementFailure> {
  const notes = await undoAll(done, context.actions)
  const reason = requirement === undefined ? failure.error : `${stepName(requirement)}: ${failure.error}`
  return {
    ok: false,
    status: failure.status,
    error: [...notes, `${context.mainName} was not ${context.verb}: ${reason}`].join('; '),
    step: failure.step ?? 'requirements',
    ...(requirement !== undefined ? { requirement: requirement.id } : {}),
  }
}

type Succeeded = { ok: true }
type Failed = { ok: false; status: number; error?: string; step?: InstallStep }
export type WithRequirements<R> = (R extends Succeeded ? R & { installedRequirements: string[] } : R) | NeedsRequirementsFailure | RequirementFailure

const withApplied = <R extends Succeeded | Failed>(result: R, ids: string[]): WithRequirements<R> =>
  (result.ok ? { ...result, installedRequirements: ids } : result) as WithRequirements<R>

export async function withRequirements<R extends Succeeded | Failed>(context: RequirementContext, main: () => Promise<R>): Promise<WithRequirements<R>> {
  if (context.steps.length === 0) return withApplied(await main(), [])
  const refused = gateFailure(context)
  if (refused !== null) return refused
  const done: ActionableStep[] = []
  for (const step of context.steps.filter(isActionable)) {
    const outcome = await runStep(step, context)
    if (!outcome.ok) return failAfterRollback(context, done, outcome, step)
    done.push(step)
  }
  const result = await main()
  if (result.ok) return withApplied(result, done.map(step => step.id))
  const failed = result as Failed
  return failAfterRollback(context, done, { status: failed.status, error: failed.error ?? 'The change needs your approval', step: failed.step })
}

export type Dependent = { id: string; name: string }

export async function dependentsOf(id: string): Promise<Dependent[]> {
  const installed = await listInstalled()
  return installed.filter(plugin => plugin.id !== id && (plugin.requires ?? []).some(requirement => requirement.id === id)).map(plugin => ({ id: plugin.id, name: plugin.name }))
}
