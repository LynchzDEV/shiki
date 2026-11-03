import type { PluginContributions, PluginManifest, PluginPermissions, PluginRequirement, PluginRuntime } from './manifest'
import type { InstalledPlugin } from './store'

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
