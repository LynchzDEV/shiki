import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { chatProfileDirs } from '../chat-profile'
import { draftRevision, validateWorkflow, type WorkflowRevision } from '../workflows'
import { workerProfileDirs } from '../worker-profile'
import { errorMessage } from './errors'
import { PluginBusyError, withPluginLock } from './locks'
import type { PluginContributions, SettingField } from './manifest'
import { getSetting } from './settings'
import { getInstalled, listInstalled, pluginFolder, saveInstalled, type InstalledPlugin } from './store'
import { legacyNamed } from '../legacy-name'

const SKILL_MARKER_FILE = '.mc-plugin'
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/
// ponytail: {{mc:mctl}} is the published plugin template placeholder, rename it together with skd-plugin-sdk
const PLACEHOLDER = /\{\{(setting|mc):([^}]*)\}\}/g

export type ContributionSource = {
  pluginId: string
  folder: string
  contributes: PluginContributions
  settingsFields: SettingField[]
  settings: Record<string, string>
  shiki: string
}

export type FillContext = Pick<ContributionSource, 'settingsFields' | 'settings' | 'shiki'>
export type FillResult = { ok: true; text: string } | { ok: false; error: string }
export type ApplyResult = { ok: true; written: string[] } | { ok: false; error: string }
export type PluginFlow = WorkflowRevision & { plugin: string }

type PlannedFile = { path: string; content: string | Buffer }
type PlannedItem = { target: string; files: PlannedFile[]; skill: boolean }

export function contributionTargets(): string[] {
  return [join(homedir(), '.claude'), workerProfileDirs().claude, chatProfileDirs().claude]
}

export function cliCommand(): string {
  return `bun ${resolve(import.meta.dir, '..', '..', 'cli', 'shiki.ts')}`
}

function agentMarker(pluginId: string): string {
  return `<!-- installed by shikidan plugin ${pluginId} -->`
}

export function fillTemplate(text: string, path: string, context: FillContext): FillResult {
  const fields = new Map(context.settingsFields.map(field => [field.key, field]))
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const [placeholder, kind, key] of line.matchAll(PLACEHOLDER)) {
      const where = `${path}:${index + 1}: ${placeholder}`
      if (kind === 'mc' && key !== 'mctl') return { ok: false, error: `${where} is not a value Shikidan fills` }
      if (kind === 'setting' && !fields.has(key!)) return { ok: false, error: `${where} is not a declared setting` }
      if (kind === 'setting' && fields.get(key!)!.type === 'secret') return { ok: false, error: `${where} is a secret setting and is never written into a file` }
    }
  }
  const filled = text.replace(PLACEHOLDER, (placeholder, kind: string, key: string) => {
    if (kind === 'mc') return context.shiki
    const value = context.settings[key]
    return value === undefined || value === '' ? placeholder : value
  })
  return { ok: true, text: filled }
}

function frontmatterName(text: string): string | null {
  const block = FRONTMATTER.exec(text)?.[1]
  return block === undefined ? null : /^name:\s*([A-Za-z0-9_.-]+)\s*$/m.exec(block)?.[1] ?? null
}

async function filesIn(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    const path = join(folder, entry.name)
    return entry.isDirectory() ? filesIn(path) : Promise.resolve(entry.isFile() ? [path] : [])
  }))
  return nested.flat()
}

async function planAgent(source: ContributionSource, path: string, targets: string[]): Promise<PlannedItem[] | string> {
  const text = await readFile(join(source.folder, path), 'utf8')
  const name = frontmatterName(text)
  if (name === null) return `${path} has no name: in its frontmatter`
  const filled = fillTemplate(text, path, source)
  if (!filled.ok) return filled.error
  const content = filled.text.replace(FRONTMATTER, match => `${match}${agentMarker(source.pluginId)}\n`)
  return targets.map(target => {
    const file = join(target, 'agents', `${name}.md`)
    return { target: file, files: [{ path: file, content }], skill: false }
  })
}

async function planSkill(source: ContributionSource, path: string, targets: string[]): Promise<PlannedItem[] | string> {
  const folder = join(source.folder, path)
  const skillFile = join(path, 'SKILL.md')
  const skillText = await readFile(join(source.folder, skillFile), 'utf8').catch(() => null)
  if (skillText === null) return `${skillFile} is missing`
  const name = frontmatterName(skillText)
  if (name === null) return `${skillFile} has no name: in its frontmatter`
  const contents: Array<{ relativePath: string; content: string | Buffer }> = []
  for (const file of await filesIn(folder)) {
    const relativePath = relative(folder, file)
    if (!file.endsWith('.md')) {
      contents.push({ relativePath, content: await readFile(file) })
      continue
    }
    const filled = fillTemplate(await readFile(file, 'utf8'), join(path, relativePath), source)
    if (!filled.ok) return filled.error
    contents.push({ relativePath, content: filled.text })
  }
  contents.push({ relativePath: SKILL_MARKER_FILE, content: `${source.pluginId}\n` })
  return targets.map(target => {
    const skillDir = join(target, 'skills', name)
    return { target: skillDir, files: contents.map(item => ({ path: join(skillDir, item.relativePath), content: item.content })), skill: true }
  })
}

async function ownedBy(pluginId: string, path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null)
  if (info === null) return false
  if (info.isDirectory()) return (await readFile(join(path, SKILL_MARKER_FILE), 'utf8').catch(() => '')).trim() === pluginId
  if (!info.isFile()) return false
  const text = await readFile(path, 'utf8')
  return text.includes(agentMarker(pluginId)) || text.includes(legacyNamed(agentMarker(pluginId)))
}

export async function applyContributions(source: ContributionSource, targets: string[], previous: string[]): Promise<ApplyResult> {
  const planned: PlannedItem[] = []
  for (const path of source.contributes.agents ?? []) {
    const items = await planAgent(source, path, targets)
    if (typeof items === 'string') return { ok: false, error: items }
    planned.push(...items)
  }
  for (const path of source.contributes.skills ?? []) {
    const items = await planSkill(source, path, targets)
    if (typeof items === 'string') return { ok: false, error: items }
    planned.push(...items)
  }
  for (const item of planned) {
    const present = await lstat(item.target).then(() => true, () => false)
    if (present && !await ownedBy(source.pluginId, item.target)) {
      return { ok: false, error: `${item.target} already exists and was not installed by this plugin` }
    }
  }
  for (const item of planned) {
    if (item.skill) await rm(item.target, { recursive: true, force: true })
    for (const file of item.files) {
      await mkdir(resolve(file.path, '..'), { recursive: true })
      await writeFile(file.path, file.content)
    }
  }
  const written = planned.map(item => item.target)
  await removeContributions(source.pluginId, previous.filter(path => !written.includes(path)))
  return { ok: true, written }
}

export async function removeContributions(pluginId: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    if (await ownedBy(pluginId, path)) await rm(path, { recursive: true, force: true })
  }
}

export async function checkFlows(folder: string, paths: string[]): Promise<string[]> {
  const errors: string[] = []
  for (const path of paths) {
    let value: unknown
    try {
      value = JSON.parse(await readFile(join(folder, path), 'utf8'))
    } catch (error) {
      errors.push(`${path}: ${errorMessage(error)}`)
      continue
    }
    errors.push(...validateWorkflow(value).map(error => `${path}: ${error}`))
  }
  return errors
}

const MAX_ATTEMPTS = /^(10|[1-9])$/

async function maxAttemptsOf(pluginId: string, setting: (id: string, key: string) => Promise<string | null>): Promise<number | null> {
  const value = (await setting(pluginId, 'maxAttempts').catch(() => null))?.trim() ?? ''
  return MAX_ATTEMPTS.test(value) ? Number(value) : null
}

export async function pluginFlows(plugins: InstalledPlugin[], folderOf: (id: string) => string = pluginFolder, setting: (id: string, key: string) => Promise<string | null> = getSetting): Promise<PluginFlow[]> {
  const flows: PluginFlow[] = []
  for (const plugin of plugins) {
    if (!plugin.enabled) continue
    const maxVisits = await maxAttemptsOf(plugin.id, setting)
    for (const path of plugin.contributes?.flows ?? []) {
      try {
        const graph = JSON.parse(await readFile(join(folderOf(plugin.id), path), 'utf8'))
        const nodes = maxVisits === null || !Array.isArray(graph.nodes) ? graph.nodes : graph.nodes.map((node: Record<string, unknown>) => ({ ...node, maxVisits }))
        const named = { ...graph, nodes, id: `${plugin.id}--${graph.id}`, name: `${plugin.name}: ${graph.name}`.slice(0, 120) }
        flows.push({ ...draftRevision(named), createdAt: 0, plugin: plugin.id })
      } catch (error) {
        console.error(`[plugins] ${plugin.id} flow ${path} is not usable:`, errorMessage(error))
      }
    }
  }
  return flows
}

export type RefreshOptions = { targets?: string[]; shiki?: string; sync?: () => Promise<unknown> }

async function settingsOf(plugin: InstalledPlugin): Promise<Record<string, string>> {
  const values: Record<string, string> = {}
  for (const field of plugin.settingsFields) {
    if (field.type !== 'text') continue
    const value = await getSetting(plugin.id, field.key)
    if (value !== null) values[field.key] = value
  }
  return values
}

export async function syncContributions(plugin: InstalledPlugin, options: RefreshOptions = {}): Promise<ApplyResult> {
  const previous = plugin.contributedPaths ?? []
  if (!plugin.enabled || plugin.contributes === undefined) {
    await removeContributions(plugin.id, previous)
    return { ok: true, written: [] }
  }
  return applyContributions({
    pluginId: plugin.id,
    folder: pluginFolder(plugin.id),
    contributes: plugin.contributes,
    settingsFields: plugin.settingsFields,
    settings: await settingsOf(plugin),
    shiki: options.shiki ?? cliCommand(),
  }, options.targets ?? contributionTargets(), previous)
}

export async function refreshContributions(id: string, options: RefreshOptions = {}): Promise<ApplyResult> {
  try {
    return await withPluginLock(id, async () => {
      const plugin = await getInstalled(id)
      if (plugin === null) return { ok: false as const, error: 'That plugin is not installed' }
      if (plugin.contributes === undefined && (plugin.contributedPaths ?? []).length === 0) return { ok: true as const, written: [] }
      const result = await syncContributions(plugin, options)
      if (result.ok) await saveInstalled({ ...plugin, contributedPaths: result.written })
      await options.sync?.()
      return result
    })
  } catch (error) {
    if (error instanceof PluginBusyError) return { ok: false, error: error.message }
    throw error
  }
}

export async function refreshAllContributions(options: RefreshOptions = {}): Promise<string[]> {
  const problems: string[] = []
  for (const plugin of await listInstalled()) {
    if (plugin.contributes === undefined) continue
    const result = await refreshContributions(plugin.id, options)
    if (!result.ok) problems.push(`${plugin.id}: ${result.error}`)
  }
  return problems
}

export async function listedPluginFlows(): Promise<PluginFlow[]> {
  return pluginFlows(await listInstalled())
}
