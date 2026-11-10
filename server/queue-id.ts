import type { QueueItem } from './queue-store'

export const MIN_ID_PREFIX = 4

export type ResolvedId = { id: string } | { status: 404 | 409; error: string }

export function resolveQueueId(items: readonly Pick<QueueItem, 'id'>[], given: string): ResolvedId {
  if (items.some(item => item.id === given)) return { id: given }
  const matches = given.length < MIN_ID_PREFIX ? [] : items.filter(item => item.id.startsWith(given))
  if (matches.length === 1) return { id: matches[0]!.id }
  if (matches.length > 1) return { status: 409, error: `${given} matches ${matches.length} queue items; use more of the id` }
  return { status: 404, error: `No queue item ${given}` }
}
