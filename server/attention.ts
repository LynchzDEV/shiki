import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { JobRecord } from './jobs'
import type { RunEvents } from './run-events'
import { configDir } from './secrets'
import { atomicJson } from './workflows'

export const ATTENTION_FILE = 'attention.json'

export type AttentionKind = 'permission' | 'needs' | 'loop' | 'queue'

export type AttentionItem = {
  key: string
  kind: AttentionKind
  title: string
  detail: string
  command: string | null
  chatId: string | null
  jobId: string | null
  requestId: string | null
  createdAt: number
}

export type AttentionStore = RunEvents & {
  list(): AttentionItem[]
  raise(item: Omit<AttentionItem, 'createdAt'>): Promise<void>
  resolve(key: string): Promise<boolean>
  resolveWhere(match: (item: AttentionItem) => boolean): Promise<number>
  prune(isRunning: (jobId: string) => boolean): Promise<void>
}

export const attentionKey = {
  permission: (jobId: string, requestId: string) => `perm:${jobId}:${requestId}`,
  needs: (chatId: string) => `needs:${chatId}`,
  loop: (jobId: string) => `loop:${jobId}`,
  queue: (itemId: string) => `queue:${itemId}`,
  queueSync: (itemId: string) => `queue-sync:${itemId}`,
  queueLimit: (itemId: string) => `queue-limit:${itemId}`,
}

export function chatOfJob(record: Pick<JobRecord, 'purpose' | 'threadRoot' | 'chatId'>): string | null {
  if (record.purpose === 'chat') return record.threadRoot
  return record.chatId ?? null
}

export function attentionPath(): string {
  return join(configDir(), ATTENTION_FILE)
}

const KINDS = new Set<string>(['permission', 'needs', 'loop', 'queue'])
const isText = (value: unknown): value is string => typeof value === 'string'
const isTextOrNull = (value: unknown): boolean => value === null || typeof value === 'string'

function isItem(value: unknown): value is AttentionItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return isText(item.key) && KINDS.has(item.kind as string) && isText(item.title) && isText(item.detail)
    && isTextOrNull(item.command) && isTextOrNull(item.chatId) && isTextOrNull(item.jobId) && isTextOrNull(item.requestId)
    && typeof item.createdAt === 'number'
}

function load(path: string): AttentionItem[] {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return [] }
  try {
    const parsed = JSON.parse(raw) as { items?: unknown }
    return Array.isArray(parsed.items) ? parsed.items.filter(isItem) : []
  } catch (error) {
    console.error(`attention list unreadable, starting empty: ${path}`, error)
    return []
  }
}

export function createAttentionStore(path = attentionPath(), clock: () => number = Date.now): AttentionStore {
  let items = load(path)
  const listeners = new Set<() => void>()
  let writing: Promise<void> = Promise.resolve()

  const changed = () => { for (const listener of listeners) listener() }
  const save = (next: AttentionItem[]): Promise<void> => {
    items = next
    changed()
    const snapshot = items
    writing = writing
      .then(async () => { await mkdir(dirname(path), { recursive: true }); await atomicJson(path, { items: snapshot }) })
      .catch(error => console.error('attention list save failed', error))
    return writing
  }

  return {
    changed,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    list: () => items,
    raise: async item => {
      const existing = items.find(entry => entry.key === item.key)
      const next = { ...item, createdAt: existing?.createdAt ?? clock() }
      await save(existing ? items.map(entry => (entry.key === item.key ? next : entry)) : [...items, next])
    },
    resolve: async key => {
      if (!items.some(item => item.key === key)) return false
      await save(items.filter(item => item.key !== key))
      return true
    },
    resolveWhere: async match => {
      const kept = items.filter(item => !match(item))
      const removed = items.length - kept.length
      if (removed > 0) await save(kept)
      return removed
    },
    prune: async isRunning => {
      const kept = items.filter(item => item.kind === 'needs' || item.kind === 'queue' || (item.jobId !== null && isRunning(item.jobId)))
      if (kept.length !== items.length) await save(kept)
    },
  }
}
