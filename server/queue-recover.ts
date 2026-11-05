import type { QueueEngineDeps } from './queue-engine'
import type { QueueItem } from './queue-store'

export async function askOwner(deps: Pick<QueueEngineDeps, 'store' | 'needsYou'>, item: QueueItem, questions: string[]): Promise<void> {
  const parked = await deps.store.update(item.id, { state: 'waiting-info', questions, askedIn: 'shikidan', currentRunId: null, error: null })
  deps.needsYou(parked, 'Technical question')
}
