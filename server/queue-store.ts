import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { isRepoList } from './repo-names'
import type { RunEvents } from './run-events'
import { configDir } from './secrets'
import { atomicJson, type LandStage } from './workflows'

export const QUEUE_FILE = 'queue.json'

export type QueueState = 'queued' | 'building' | 'waiting-info' | 'waiting-pick' | 'ready' | 'failed' | 'landing' | 'awaiting-stage' | 'landed'

export type QueuePick = { options: string[]; path: string; recommended: string | null; tester: string | null; summary: string }
export type LandStageState = {
  status: 'running' | 'ok' | 'failed' | 'waiting' | 'skipped'
  startedAt?: number; endedAt?: number; exitCode?: number | null; posted?: string; warning?: string
  preflight?: { exitCode: number; markdown: string }
}
export type LandRecover = { stage: string; attempts: number; runId?: string; reason: string; asked?: true; answers?: string }
export type LandProgress = { stage: string; stages: Record<string, LandStageState>; message?: string; plan: LandStage[]; plugin?: string; runId?: string; recover?: LandRecover }
export type BuildRecover = { runId: string; attempts: number; recoveryRunId?: string; asked?: true; openBiz?: string[]; addedRepos?: string[]; note?: string }

export type QueueItem = {
  id: string; source: string; externalId: string; title: string; url: string; repo: string; flowId: string | null
  state: QueueState; worktree: string | null; contextPath: string | null; answerPaths: string[]
  runIds: string[]; currentRunId: string | null; questions: string[]; lastSeenId: string | null; error: string | null
  createdAt: number; updatedAt: number; repos?: string[]; repoReruns?: number
  realBaseline?: Record<string, string>; realChanged?: string[]; pick?: QueuePick; land?: LandProgress; autoPicks?: number; resumeRunId?: string
  askedIn?: 'shikidan'; recoverRebuilds?: number; recoverBuild?: BuildRecover
}

export type NewQueueItem = Pick<QueueItem, 'source' | 'externalId' | 'title' | 'url' | 'repo' | 'flowId' | 'repos'>
export type QueuePatch = Partial<Omit<QueueItem, 'id' | 'createdAt' | 'updatedAt'>>

export type QueueStore = RunEvents & {
  list(): QueueItem[]
  get(id: string): QueueItem | undefined
  add(item: NewQueueItem, position: 'end' | 'next'): Promise<QueueItem>
  update(id: string, patch: QueuePatch): Promise<QueueItem>
  remove(id: string): Promise<boolean>
  move(id: string, to: number): Promise<boolean>
  toFront(id: string): Promise<void>
}

const STATES = new Set<string>(['queued', 'building', 'waiting-info', 'waiting-pick', 'ready', 'failed', 'landing', 'awaiting-stage', 'landed'])
const RESUMABLE: ReadonlySet<QueueState> = new Set(['queued', 'failed'])
const isText = (value: unknown): value is string => typeof value === 'string'
const isTextOrNull = (value: unknown): boolean => value === null || typeof value === 'string'
const isTexts = (value: unknown): boolean => Array.isArray(value) && value.every(isText)
const isTextRecord = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isText)

function isPick(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const pick = value as Record<string, unknown>
  return isTexts(pick.options) && isText(pick.path) && isText(pick.summary) && isTextOrNull(pick.recommended) && isTextOrNull(pick.tester)
}

function isItem(value: unknown): value is QueueItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return [item.id, item.source, item.externalId, item.title, item.url, item.repo].every(isText)
    && STATES.has(item.state as string)
    && [item.flowId, item.worktree, item.contextPath, item.currentRunId, item.lastSeenId, item.error].every(isTextOrNull)
    && isTexts(item.answerPaths) && isTexts(item.runIds) && isTexts(item.questions)
    && typeof item.createdAt === 'number' && typeof item.updatedAt === 'number'
    && (item.repos === undefined || isRepoList(item.repos))
    && (item.realBaseline === undefined || isTextRecord(item.realBaseline))
    && (item.realChanged === undefined || isTexts(item.realChanged))
    && (item.pick === undefined || isPick(item.pick))
    && (item.land === undefined || isLand(item.land))
    && (item.repoReruns === undefined || (Number.isInteger(item.repoReruns) && (item.repoReruns as number) >= 0))
    && (item.resumeRunId === undefined || isText(item.resumeRunId))
    && (item.askedIn === undefined || item.askedIn === 'shikidan')
    && (item.recoverRebuilds === undefined || isCount(item.recoverRebuilds))
    && (item.recoverBuild === undefined || isStoredBuild(item.recoverBuild))
}

const isCount = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0
const isRecord = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value)
const isLand = (value: unknown): boolean => isRecord(value) && isText((value as Record<string, unknown>).stage) && ((value as Record<string, unknown>).runId === undefined || isText((value as Record<string, unknown>).runId)) && isRecord((value as Record<string, unknown>).stages) && Array.isArray((value as Record<string, unknown>).plan) && isStoredRecover((value as Record<string, unknown>).recover)

const isStoredBuild = (value: unknown): boolean => isRecord(value) && isCount((value as Record<string, unknown>).attempts) && ((value as Record<string, unknown>).note === undefined || isText((value as Record<string, unknown>).note))
const isStoredRecover = (value: unknown): boolean => value === undefined || (isRecord(value) && isCount((value as Record<string, unknown>).attempts))

const isMissingFile = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

function load(path: string): QueueItem[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { items?: unknown }
    if (!Array.isArray(parsed.items)) return []
    return parsed.items.filter((entry: unknown) => {
      if (isItem(entry)) return true
      console.error(`queue item ${String((entry as { id?: unknown } | null)?.id ?? '?')} in ${path} is not valid and was left out`)
      return false
    })
  } catch (error) {
    if (!isMissingFile(error)) console.error(`queue list unreadable, starting empty: ${path}`, error)
    return []
  }
}

const definedFields = (patch: QueuePatch): QueuePatch =>
  Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))

export function queuePath(): string {
  return join(configDir(), QUEUE_FILE)
}

export function createQueueStore(path: string, clock: () => number = Date.now): QueueStore {
  let items = load(path)
  let writes: Promise<void> = Promise.resolve()
  const listeners = new Set<() => void>()
  const changed = () => { for (const listener of listeners) listener() }

  const save = (next: QueueItem[]): Promise<void> => {
    items = next
    changed()
    const snapshot = { items }
    const write = writes.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await atomicJson(path, snapshot)
    })
    writes = write.catch(error => console.error('queue write failed', error))
    return write
  }

  const reorder = (id: string, to: number): QueueItem[] | null => {
    const from = items.findIndex(item => item.id === id)
    if (from === -1) return null
    const rest = items.filter(item => item.id !== id)
    const at = Math.max(0, Math.min(to, rest.length))
    return [...rest.slice(0, at), items[from]!, ...rest.slice(at)]
  }

  return {
    changed,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    list: () => items,
    get: id => items.find(item => item.id === id),
    async add(input, position) {
      const now = clock()
      const item: QueueItem = { ...input, id: crypto.randomUUID(), state: 'queued', worktree: null, contextPath: null, answerPaths: [], runIds: [], currentRunId: null, questions: [], lastSeenId: null, error: null, createdAt: now, updatedAt: now }
      await save(position === 'next' ? [item, ...items] : [...items, item])
      return item
    },
    async update(id, patch) {
      const current = items.find(item => item.id === id)
      if (current === undefined) throw new Error(`No queue item ${id}`)
      const next: QueueItem = { ...current, ...definedFields(patch), updatedAt: clock() }
      if ('pick' in patch && patch.pick === undefined) delete next.pick
      if ('land' in patch && patch.land === undefined) delete next.land
      if ('recoverBuild' in patch && patch.recoverBuild === undefined) delete next.recoverBuild
      if (next.state !== 'waiting-info' || ('askedIn' in patch && patch.askedIn === undefined)) delete next.askedIn
      if (('resumeRunId' in patch && patch.resumeRunId === undefined) || !RESUMABLE.has(next.state)) delete next.resumeRunId
      await save(items.map(item => (item.id === id ? next : item)))
      return next
    },
    async remove(id) {
      const rest = items.filter(item => item.id !== id)
      if (rest.length === items.length) return false
      await save(rest)
      return true
    },
    async move(id, to) {
      const next = reorder(id, to)
      if (next === null) return false
      await save(next)
      return true
    },
    async toFront(id) {
      const next = reorder(id, 0)
      if (next !== null) await save(next)
    },
  }
}
