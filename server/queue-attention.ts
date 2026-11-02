import { attentionKey, type AttentionItem, type AttentionStore } from './attention'
import type { QueueItem, QueueStore } from './queue-store'

const NEEDS_PERSON = new Set<QueueItem['state']>(['ready', 'failed', 'waiting-info', 'waiting-pick', 'awaiting-stage', 'landed'])

export function raiseQueueAlert(attention: AttentionStore, item: QueueItem, reason: string): Promise<void> {
  return attention.raise({ key: attentionKey.queue(item.id), kind: 'queue', title: item.title, detail: reason, command: null, chatId: null, jobId: null, requestId: null })
}

function needsNoPerson(store: QueueStore, alert: AttentionItem): boolean {
  if (alert.kind !== 'queue') return false
  const item = store.get(alert.key.slice('queue:'.length))
  return item === undefined || !NEEDS_PERSON.has(item.state)
}

export function sweepQueueAlerts(store: QueueStore, attention: AttentionStore): Promise<number> {
  return attention.resolveWhere(alert => needsNoPerson(store, alert))
}

export function watchQueueAlerts(store: QueueStore, attention: AttentionStore): () => void {
  return store.subscribe(() => { void sweepQueueAlerts(store, attention).catch((error: unknown) => console.error('Queue alert sweep failed', error)) })
}
