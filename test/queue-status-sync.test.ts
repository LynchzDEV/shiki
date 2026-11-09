import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SourceStatusMap, StatusRun } from '../server/queue-status'
import { createStatusSync, SYNC_RETRY_MS, type StatusSyncDeps } from '../server/queue-status-sync'
import { createQueueStore, type NewQueueItem, type QueueStore } from '../server/queue-store'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-status-sync-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const task = (externalId: string): NewQueueItem => ({ source: 'clickup-board', externalId, title: `Task ${externalId}`, url: 'u', repo: '/repo', flowId: 'fixstack--fixstack' })
const map: SourceStatusMap = { states: { queued: 'Open', failed: 'hold', ready: 'in progress' }, nodes: { route: 'pipeline', implement: 'in progress' } }
type Timer = { retry: () => Promise<void>; ms: number; cancelled: boolean }

function harness(over: Partial<StatusSyncDeps> = {}, store: QueueStore = createQueueStore(join(dir, 'queue.json'))) {
  const calls: Array<{ id: string; status: string }> = []
  const synced: string[] = []
  const failed: Array<{ id: string; status: string; error: string }> = []
  const timers: Timer[] = []
  const runs = new Map<string, StatusRun>()
  const lookups: Array<string | null> = []
  let answer: (status: string) => Promise<{ status: string }> = async status => ({ status })
  const deps: StatusSyncDeps = {
    store,
    run: id => runs.get(id),
    map: async flowId => { lookups.push(flowId); return map },
    source: () => ({ status: input => { calls.push(input); return answer(input.status) } }),
    onSynced: item => { synced.push(item.id) },
    onFailed: (item, status, error) => { failed.push({ id: item.id, status, error: (error as Error).message }) },
    schedule: (retry, ms) => { const timer = { retry, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true } },
    ...over,
  }
  return { sync: createStatusSync(deps), store, calls, synced, failed, timers, runs, lookups, answerWith: (next: typeof answer) => { answer = next } }
}

function gate() {
  let release!: () => void
  const opened = new Promise<void>(resolve => { release = resolve })
  return { opened, release }
}

test('a change is sent once, stored as synced, and not sent again', async () => {
  const h = harness()
  const item = await h.store.add(task('1'), 'end')
  await Promise.all([h.sync.reconcile(), h.sync.reconcile()])
  expect(h.calls).toEqual([{ id: '1', status: 'Open' }])
  expect(h.store.get(item.id)!.syncedStatus).toBe('Open')
  expect(h.synced).toEqual([item.id])
  await h.sync.reconcile()
  await h.store.update(item.id, { state: 'failed' })
  await h.sync.reconcile()
  await h.sync.reconcile()
  expect(h.calls.map(call => call.status)).toEqual(['Open', 'hold'])
})

test('after a restart a card already at its status is not sent again', async () => {
  const first = harness()
  await first.store.add(task('1'), 'end')
  await first.sync.reconcile()
  expect(first.calls).toHaveLength(1)
  const restarted = harness({}, createQueueStore(join(dir, 'queue.json')))
  await restarted.sync.reconcile()
  expect(restarted.calls).toEqual([])
})

test('reconciles during a call wait for it, and a change made mid-flight is sent after it lands', async () => {
  const h = harness()
  const item = await h.store.add(task('1'), 'end')
  const { opened, release } = gate()
  h.answerWith(async status => { await opened; return { status } })
  const pass = h.sync.reconcile()
  await Promise.resolve()
  const second = h.sync.reconcile()
  await h.store.update(item.id, { state: 'failed' })
  const third = h.sync.reconcile()
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(h.calls).toEqual([{ id: '1', status: 'Open' }])
  release()
  await Promise.all([pass, second, third])
  expect(h.calls.map(call => call.status)).toEqual(['Open', 'hold'])
  expect(h.store.get(item.id)!.syncedStatus).toBe('hold')
})

test('a failing call retries on the ladder, then reports once and stops until the status changes', async () => {
  const h = harness()
  const item = await h.store.add(task('1'), 'end')
  h.answerWith(async () => { throw new Error('No status "Open" on this list') })
  await h.sync.reconcile()
  for (let retry = 0; retry < SYNC_RETRY_MS.length; retry += 1) {
    await h.sync.reconcile()
    await h.timers[retry]!.retry()
  }
  expect([...SYNC_RETRY_MS]).toEqual([10_000, 60_000, 300_000])
  expect(h.timers.map(timer => timer.ms)).toEqual([...SYNC_RETRY_MS])
  expect(h.calls).toHaveLength(4)
  expect(h.failed).toEqual([{ id: item.id, status: 'Open', error: 'No status "Open" on this list' }])
  await h.sync.reconcile()
  await h.sync.reconcile()
  expect(h.calls).toHaveLength(4)
  expect(h.timers).toHaveLength(3)
  expect(h.store.get(item.id)!.syncedStatus).toBeUndefined()
  h.answerWith(async status => ({ status }))
  await h.store.update(item.id, { state: 'failed' })
  await h.sync.reconcile()
  expect(h.calls.at(-1)).toEqual({ id: '1', status: 'hold' })
  expect(h.store.get(item.id)!.syncedStatus).toBe('hold')
  expect(h.synced).toEqual([item.id])
  expect(h.failed).toHaveLength(1)
})

test('a retry waiting on an old status is dropped when the status changes', async () => {
  const h = harness()
  const item = await h.store.add(task('1'), 'end')
  h.answerWith(async () => { throw new Error('down') })
  await h.sync.reconcile()
  expect(h.timers).toHaveLength(1)
  h.answerWith(async status => ({ status }))
  await h.store.update(item.id, { state: 'failed' })
  await h.sync.reconcile()
  expect(h.timers[0]!.cancelled).toBe(true)
  expect(h.calls.map(call => call.status)).toEqual(['Open', 'hold'])
  expect(h.store.get(item.id)!.syncedStatus).toBe('hold')
})

test('a building item follows the step its run is heading to, and a recovery run leaves the card alone', async () => {
  const h = harness()
  const item = await h.store.update((await h.store.add(task('1'), 'end')).id, { state: 'building', currentRunId: 'r1' })
  h.runs.set('r1', { id: 'r1', status: 'running', currentNodeId: 'route', workflow: { id: 'fixstack--fixstack', plugin: 'fixstack' } })
  await h.sync.reconcile()
  h.runs.set('r1', { id: 'r1', status: 'running', currentNodeId: 'implement', workflow: { id: 'fixstack--fixstack', plugin: 'fixstack' } })
  await h.sync.reconcile()
  await h.store.update(item.id, { currentRunId: 'r2' })
  h.runs.set('r2', { id: 'r2', status: 'running', currentNodeId: 'route', workflow: { id: 'recover' } })
  await h.sync.reconcile()
  expect(h.calls.map(call => call.status)).toEqual(['pipeline', 'in progress'])
})

test('a card with no wanted status is never sent, and a removed item drops its pending retry', async () => {
  const h = harness()
  const item = await h.store.add(task('1'), 'end')
  await h.store.update((await h.store.add(task('3'), 'end')).id, { state: 'landed' })
  h.answerWith(async () => { throw new Error('down') })
  await h.sync.reconcile()
  expect(h.calls).toEqual([{ id: '1', status: 'Open' }])
  await h.store.remove(item.id)
  await h.timers[0]!.retry()
  expect(h.calls).toHaveLength(1)
  expect(h.failed).toEqual([])
})

test('one pass looks up each flow once', async () => {
  const h = harness()
  await h.store.add(task('1'), 'end')
  await h.store.add(task('2'), 'end')
  await h.store.add({ ...task('3'), flowId: null }, 'end')
  await h.sync.reconcile()
  expect(h.lookups.slice(0, 2).sort()).toEqual(['fixstack--fixstack', null])
})

const fixstackRun = (id: string, currentNodeId: string): StatusRun => ({ id, status: 'running', currentNodeId, workflow: { id: 'fixstack--fixstack', plugin: 'fixstack' } })

test('the first pass adopts the status of settled cards without sending, and sends queued and building ones', async () => {
  const h = harness({ map: async () => ({ ...map, states: { ...map.states, landed: 'done' } }) })
  const states = ['landed', 'failed', 'ready'] as const
  const settled = []
  for (let index = 0; index < 10; index += 1) settled.push(await h.store.update((await h.store.add(task(`s${index}`), 'end')).id, { state: states[index % 3]! }))
  const building = await h.store.update((await h.store.add(task('b'), 'end')).id, { state: 'building', currentRunId: 'r1' })
  h.runs.set('r1', fixstackRun('r1', 'implement'))
  await h.sync.reconcile()
  expect(h.calls).toEqual([{ id: 'b', status: 'in progress' }])
  expect(settled.map(item => h.store.get(item.id)!.syncedStatus)).toEqual(settled.map(item => ({ landed: 'done', failed: 'hold', ready: 'in progress' })[item.state as 'landed' | 'failed' | 'ready']))
  expect(h.synced).toEqual([building.id])
  await h.store.update(settled[1]!.id, { state: 'queued' })
  await h.store.update((await h.store.add(task('later'), 'end')).id, { state: 'landed' })
  await h.sync.reconcile()
  expect(h.calls.slice(1).sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: 'later', status: 'done' }, { id: 's1', status: 'Open' }])
})

test('a pass never has more than four status calls in flight', async () => {
  const h = harness()
  for (let index = 0; index < 10; index += 1) await h.store.add(task(`${index}`), 'end')
  const { opened, release } = gate()
  let inFlight = 0
  let most = 0
  h.answerWith(async status => { inFlight += 1; most = Math.max(most, inFlight); await opened; inFlight -= 1; return { status } })
  const pass = h.sync.reconcile()
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(h.calls).toHaveLength(4)
  release()
  await pass
  expect(most).toBe(4)
  expect(h.calls).toHaveLength(10)
})

test('a status write leaves the card updatedAt alone', async () => {
  let tick = 0
  const h = harness({}, createQueueStore(join(dir, 'queue.json'), () => ++tick))
  const item = await h.store.add(task('1'), 'end')
  const adopted = await h.store.update((await h.store.add(task('2'), 'end')).id, { state: 'failed' })
  await h.sync.reconcile()
  expect(h.store.get(item.id)!.syncedStatus).toBe('Open')
  expect(h.store.get(adopted.id)!.syncedStatus).toBe('hold')
  expect(h.store.get(item.id)!.updatedAt).toBe(item.updatedAt)
  expect(h.store.get(adopted.id)!.updatedAt).toBe(adopted.updatedAt)
})

async function giveUp(h: ReturnType<typeof harness>): Promise<void> {
  h.answerWith(async () => { throw new Error('down') })
  await h.sync.reconcile()
  for (let retry = 0; retry < SYNC_RETRY_MS.length; retry += 1) await h.timers.at(-1)!.retry()
  expect(h.failed).toHaveLength(1)
  h.answerWith(async status => ({ status }))
}

test('a give-up resolves its alert once the card no longer wants a status', async () => {
  const h = harness()
  const item = await h.store.add(task('1'), 'end')
  await giveUp(h)
  await h.store.update(item.id, { state: 'landed' })
  await h.sync.reconcile()
  await h.sync.reconcile()
  expect(h.synced).toEqual([item.id])
  expect(h.calls).toHaveLength(4)
})

test('a give-up resolves its alert once the card is back at its synced status', async () => {
  const h = harness()
  const item = await h.store.add(task('1'), 'end')
  await h.sync.reconcile()
  await h.store.update(item.id, { state: 'failed' })
  await giveUp(h)
  await h.store.update(item.id, { state: 'queued' })
  await h.sync.reconcile()
  expect(h.synced).toEqual([item.id, item.id])
  expect(h.calls.map(call => call.status)).toEqual(['Open', 'hold', 'hold', 'hold', 'hold'])
})

test('a removed card has its waiting retry cancelled by the next pass', async () => {
  const h = harness()
  const item = await h.store.add(task('1'), 'end')
  h.answerWith(async () => { throw new Error('down') })
  await h.sync.reconcile()
  await h.store.remove(item.id)
  await h.sync.reconcile()
  expect(h.timers[0]!.cancelled).toBe(true)
})
