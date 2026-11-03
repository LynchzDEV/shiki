import { join } from 'node:path'

import { atomicJson } from '../workflows'
import { configDir, ensureConfigDir, readJsonFile } from '../secrets'
import type { PluginContributions, PluginManifest, PluginPermissions, PluginRequirement, SettingField } from './manifest'

export const PLUGINS_FILE = 'plugins.json'

export type InstalledPlugin = {
  id: string
  name: string
  version: string
  description: string
  runtime: PluginManifest['runtime']
  source: { repo: string; ref: string; marketplace?: string }
  commit: string
  permissions: PluginPermissions
  settingsFields: SettingField[]
  icon?: string
  server?: string
  screen?: string
  queueSource?: true
  contributes?: PluginContributions
  contributedPaths?: string[]
  requires?: PluginRequirement[]
  enabled: boolean
  restartRequired?: boolean
  installedAt: string
  updatedAt: string
}

export function pluginsRoot(): string {
  return join(configDir(), 'plugins')
}

export function pluginFolder(id: string): string {
  return join(pluginsRoot(), id)
}

function readRegistryRaw(): Promise<Record<string, unknown>> {
  return readJsonFile(PLUGINS_FILE)
}

let writes: Promise<unknown> = Promise.resolve(undefined)

function exclusive<T>(action: () => Promise<T>): Promise<T> {
  const next = writes.then(action)
  writes = next.catch(() => {})
  return next
}

function toInstalledList(raw: unknown): InstalledPlugin[] {
  if (typeof raw !== 'object' || raw === null) return []
  const plugins = (raw as Record<string, unknown>).plugins
  if (!Array.isArray(plugins)) return []
  return plugins.filter((entry): entry is InstalledPlugin =>
    typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).id === 'string')
}

async function writeRegistry(plugins: InstalledPlugin[]): Promise<void> {
  await ensureConfigDir()
  await atomicJson(join(configDir(), PLUGINS_FILE), { plugins })
}

export async function listInstalled(): Promise<InstalledPlugin[]> {
  return toInstalledList(await readRegistryRaw())
}

export async function getInstalled(id: string): Promise<InstalledPlugin | null> {
  return (await listInstalled()).find(plugin => plugin.id === id) ?? null
}

export async function saveInstalled(plugin: InstalledPlugin): Promise<void> {
  await exclusive(async () => {
    const current = toInstalledList(await readRegistryRaw())
    const without = current.filter(entry => entry.id !== plugin.id)
    await writeRegistry([...without, plugin])
  })
}

export async function removeInstalled(id: string): Promise<void> {
  await exclusive(async () => {
    const current = toInstalledList(await readRegistryRaw())
    await writeRegistry(current.filter(entry => entry.id !== id))
  })
}

export async function clearRestartFlags(): Promise<void> {
  await exclusive(async () => {
    const current = toInstalledList(await readRegistryRaw())
    if (!current.some(plugin => plugin.restartRequired === true)) return
    await writeRegistry(current.map(plugin => {
      if (plugin.restartRequired !== true) return plugin
      const { restartRequired: _flag, ...rest } = plugin
      return rest
    }))
  })
}
