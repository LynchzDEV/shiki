import { attentionKey, type AttentionItem, type AttentionStore } from './attention'
import type { QueueItem, QueueStore } from './queue-store'

const NEEDS_PERSON = new Set<QueueItem['state']>(['ready', 'failed', 'waiting-info', 'waiting-pick', 'awaiting-stage', 'landed'])

export function raiseQueueAlert(attention: AttentionStore, item: QueueItem, reason: string): Promise<void> {
  return attention.raise({ key: attentionKey.queue(item.id), kind: 'queue', title: item.title, detail: reason, command: null, chatId: null, jobId: null, requestId: null })
}

export type QueueNeedsYou = (item: QueueItem, reason: string, options?: { webhook?: boolean }) => void

export function queueNeedsYou(attention: AttentionStore, notifyQueue: (item: QueueItem, reason: string) => void): QueueNeedsYou {
  return (item, reason, options) => {
    void raiseQueueAlert(attention, item, reason).catch(error => console.error('Queue alert failed', error))
    if (options?.webhook !== false) notifyQueue(item, reason)
  }
}

export function raiseLimitAlert(attention: AttentionStore, item: QueueItem, reason: string): Promise<void> {
  return attention.raise({ key: attentionKey.queueLimit(item.id), kind: 'queue', title: item.title, detail: reason, command: `shiki queue limits reset ${item.id}`, chatId: null, jobId: null, requestId: null })
}

export function raiseSyncAlert(attention: AttentionStore, item: QueueItem, error: unknown): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error)
  return attention.raise({ key: attentionKey.queueSync(item.id), kind: 'queue', title: item.title, detail: `ClickUp status sync failed: ${reason}`, command: null, chatId: null, jobId: null, requestId: null })
}

const markedDone = (item: QueueItem): boolean => item.state === 'landed' && item.land?.stages[item.land.stage]?.status === 'skipped'

const SYNC_PREFIX = attentionKey.queueSync('')
const LIMIT_PREFIX = attentionKey.queueLimit('')
const QUEUE_PREFIX = attentionKey.queue('')

function needsNoPerson(store: QueueStore, alert: AttentionItem): boolean {
  if (alert.kind !== 'queue') return false
  if (alert.key.startsWith(SYNC_PREFIX)) return store.get(alert.key.slice(SYNC_PREFIX.length)) === undefined
  if (alert.key.startsWith(LIMIT_PREFIX)) return store.get(alert.key.slice(LIMIT_PREFIX.length)) === undefined
  if (!alert.key.startsWith(QUEUE_PREFIX)) return false
  const item = store.get(alert.key.slice(QUEUE_PREFIX.length))
  return item === undefined || !NEEDS_PERSON.has(item.state) || markedDone(item)
}

export function sweepQueueAlerts(store: QueueStore, attention: AttentionStore): Promise<number> {
  return attention.resolveWhere(alert => needsNoPerson(store, alert))
}

export function watchQueueAlerts(store: QueueStore, attention: AttentionStore): () => void {
  return store.subscribe(() => { void sweepQueueAlerts(store, attention).catch((error: unknown) => console.error('Queue alert sweep failed', error)) })
}
