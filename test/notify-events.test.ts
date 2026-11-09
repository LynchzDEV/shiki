import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createNotifyEvents, itemOfRun, QUEUE_EVENT } from '../server/notify-events'
import { createNotifier, type NotifyInput } from '../server/notify'
import type { QueueItem, QueueState } from '../server/queue-store'
import type { WorkflowRun } from '../server/workflow-runner'

const item = (patch: Partial<QueueItem> = {}): QueueItem => ({
  id: 'item-1', source: 'clickup', externalId: 'T1', title: 'Card', url: 'https://app.clickup.com/t/T1', repo: '/repo', flowId: null,
  state: 'ready', worktree: '/wt', contextPath: null, answerPaths: [], runIds: ['run-1'], currentRunId: 'run-1', questions: [], lastSeenId: null, error: null,
  createdAt: 1, updatedAt: 1, ...patch,
})

type Run = Pick<WorkflowRun, 'id' | 'status' | 'currentNodeId' | 'error' | 'attempts'>
const tries = (count: number) => Array.from({ length: count }, () => ({})) as WorkflowRun['attempts']
const run = (patch: Partial<Run> = {}): Run => ({ id: 'run-1', status: 'running', currentNodeId: 'implement', error: null, attempts: tries(1), ...patch })

function setup(items: QueueItem[], runs = [run()]) {
  const emitted: NotifyInput[] = []
  const events = createNotifyEvents({
    notifier: { emit: async input => { emitted.push(input) } },
    items: () => items,
    run: id => runs.find(entry => entry.id === id),
  })
  return { events, emitted }
}

describe('queue events', () => {
  const cases: Array<[QueueState, string | null]> = [
    ['waiting-pick', 'pick'], ['waiting-info', 'question'], ['failed', 'failed'], ['awaiting-stage', 'stage-ready'], ['ready', 'ready'], ['landed', 'landed'],
    ['queued', null], ['building', null], ['landing', null],
  ]
  test.each(cases)('needsYou in %s sends %s', (state, expected) => {
    const { events, emitted } = setup([])
    events.queue(item({ state }), 'because')
    expect(emitted.map(entry => entry.event)).toEqual(expected === null ? [] : [expected])
  })

  test('the table covers exactly the six person states', () => {
    expect(Object.keys(QUEUE_EVENT).sort()).toEqual(['awaiting-stage', 'failed', 'landed', 'ready', 'waiting-info', 'waiting-pick'])
  })

  test('carries the item, run, node and the synced clickup status', () => {
    const { events, emitted } = setup([], [run({ currentNodeId: 'review' })])
    events.queue({ ...item({ state: 'ready' }), syncedStatus: 'in progress' } as QueueItem, 'Run done')
    expect(emitted[0]).toMatchObject({ queueItemId: 'item-1', runId: 'run-1', taskId: 'T1', taskUrl: 'https://app.clickup.com/t/T1', title: 'Card', node: 'review', itemState: 'ready', runStatus: 'running', clickupStatus: 'in progress', detail: 'Run done', fingerprintKey: 'item-1:queue' })
  })

  test('clickupStatus is null without a synced status', () => {
    const { events, emitted } = setup([])
    events.queue(item(), 'Run done')
    expect(emitted[0]!.clickupStatus).toBeNull()
  })

  test('a pick sends options, recommendation and the render paths of each option', () => {
    const { events, emitted } = setup([])
    events.queue(item({ state: 'waiting-pick', pick: { options: ['A', 'B'], path: 'visualizer/x', recommended: 'B', tester: null, summary: 's' } }), 'Pick a design')
    expect(emitted[0]).toMatchObject({ options: ['A', 'B'], recommended: 'B' })
    expect(emitted[0]!.mockups).toEqual([
      { option: 'A', root: '/wt', relative: 'visualizer/x/renders/a.png' },
      { option: 'B', root: '/wt', relative: 'visualizer/x/renders/b.png' },
    ])
  })

  test('a question carries the question lines', () => {
    const { events, emitted } = setup([])
    events.queue(item({ state: 'waiting-info', questions: ['Which repo?', 'By when?'] }), 'Question posted to ClickUp')
    expect(emitted[0]!.questions).toEqual(['Which repo?', 'By when?'])
  })

  test('landStage is the current land stage', () => {
    const { events, emitted } = setup([])
    events.queue(item({ state: 'awaiting-stage', land: { stage: 'uat', stages: {}, plan: [] } }), 'Ready for UAT')
    expect(emitted[0]!.landStage).toBe('uat')
  })
})

describe('blocked', () => {
  test.each(['blocked', 'failed'] as const)('a %s run of a queue item sends blocked with the run error', status => {
    const { events, emitted } = setup([item({ state: 'building' })])
    events.runSettled(run({ status, error: 'tests failed' }))
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ event: 'blocked', queueItemId: 'item-1', runId: 'run-1', detail: 'tests failed', runStatus: status, node: 'implement' })
  })

  test('a done run, or a run of no queue item, sends nothing', () => {
    const { events, emitted } = setup([item()])
    events.runSettled(run({ status: 'done' }))
    events.runSettled(run({ id: 'other', status: 'blocked', error: 'x' }))
    expect(emitted).toEqual([])
  })

  test('finds the item through its recovery runs too', () => {
    const rebuilt = item({ currentRunId: null, runIds: [], recoverBuild: { runId: 'run-0', attempts: 1, recoveryRunId: 'rec-1' } })
    const landing = item({ id: 'item-2', currentRunId: null, runIds: [], land: { stage: 'uat', stages: {}, plan: [], recover: { stage: 'uat', attempts: 1, runId: 'rec-2', reason: 'x' } } })
    expect(itemOfRun([rebuilt, landing], 'rec-1')?.id).toBe('item-1')
    expect(itemOfRun([rebuilt, landing], 'rec-2')?.id).toBe('item-2')
    expect(itemOfRun([rebuilt, landing], 'nope')).toBeUndefined()
  })
})

describe('job events', () => {
  const record = { id: 'job-1', label: 'Build card', turns: 12, startedAt: 0, slowAt: 600_000, workflowRunId: 'run-1' }

  test('a permission request of a queue run carries the item fields', () => {
    const { events, emitted } = setup([item({ state: 'building' })])
    events.permission(record, { requestId: 'r1', title: 'Run rm -rf?' })
    expect(emitted[0]).toMatchObject({ event: 'permission', title: 'Build card', queueItemId: 'item-1', taskId: 'T1', runId: 'run-1', detail: 'Run rm -rf?', fingerprintKey: 'job-1:r1:permission' })
  })

  test('a slow job with no queue item has null item fields', () => {
    const { events, emitted } = setup([])
    events.slow({ ...record, workflowRunId: undefined })
    expect(emitted[0]).toMatchObject({ event: 'slow', title: 'Build card', detail: 'May be stuck: 12 turns in 10 min', fingerprintKey: 'job-1:slow' })
    expect(emitted[0]!.queueItemId).toBeUndefined()
    expect(emitted[0]!.runId).toBeNull()
  })

  test('slow for a queue run is tied to the item', () => {
    const { events, emitted } = setup([item({ state: 'building' })])
    events.slow(record)
    expect(emitted[0]).toMatchObject({ queueItemId: 'item-1', itemState: 'building' })
  })
})

describe('sync-failed', () => {
  test('exposes emit for the status sync callback', () => {
    const { events, emitted } = setup([])
    events.syncFailed(item({ state: 'building' }), 'hold', 'no such status')
    expect(emitted[0]).toMatchObject({ event: 'sync-failed', queueItemId: 'item-1', detail: 'ClickUp status sync to hold failed: no such status' })
  })
})

describe('dedupe through the outbox', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'skd-notify-events-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  function wired(runs: Run[]) {
    const sent: Array<Record<string, unknown>> = []
    const emits: Promise<void>[] = []
    const notifier = createNotifier({
      path: join(dir, 'outbox.json'),
      config: async () => ({ url: 'https://bot.example/hook', key: null }),
      fetch: async (_url, init) => { sent.push(JSON.parse(init!.body as string)); return new Response('') },
      schedule: () => {},
    })
    const events = createNotifyEvents({ notifier: { emit: input => { const emitted = notifier.emit(input); emits.push(emitted); return emitted } }, items: () => [parked()], run: id => runs.find(entry => entry.id === id) })
    const settle = async () => { await Promise.all(emits); await notifier.drain() }
    return { events, sent, settle }
  }

  const parked = (patch: Partial<QueueItem> = {}) => item({ currentRunId: null, ...patch })

  test('a second technical question is sent after the run retried, even in the same words', async () => {
    const current = run()
    const h = wired([current])
    h.events.queue(parked({ state: 'waiting-info', questions: ['Which DB?'] }), 'Technical question')
    await h.settle()
    current.attempts = tries(2)
    h.events.queue(parked({ state: 'waiting-info', questions: ['Which DB?'] }), 'Technical question')
    await h.settle()
    h.events.queue(parked({ state: 'waiting-info', questions: ['Which port?'] }), 'Technical question')
    await h.settle()
    expect(h.sent.map(event => event.questions)).toEqual([['Which DB?'], ['Which DB?'], ['Which port?']])
  })

  test('the same failure after a resume of the same run is sent again', async () => {
    const current = run()
    const h = wired([current])
    h.events.queue(parked({ state: 'failed', resumeRunId: 'run-1' }), 'tests failed')
    await h.settle()
    current.attempts = tries(3)
    h.events.queue(parked({ state: 'failed', resumeRunId: 'run-1' }), 'tests failed')
    await h.settle()
    expect(h.sent.map(event => event.detail)).toEqual(['tests failed', 'tests failed'])
  })

  test('a card that goes pick, question, then pick again sends all three', async () => {
    const h = wired([run()])
    const pick = { options: ['A', 'B'], path: 'visualizer/x', recommended: 'A', tester: null, summary: 's' }
    h.events.queue(parked({ state: 'waiting-pick', pick }), 'Pick a design variant')
    h.events.queue(parked({ state: 'waiting-info', questions: ['Which repo?'] }), 'Question posted to ClickUp')
    h.events.queue(parked({ state: 'waiting-pick', pick }), 'Pick a design variant')
    await h.settle()
    expect(h.sent.map(event => event.event)).toEqual(['pick', 'question', 'pick'])
  })

  test('a repeated alert with nothing new is sent once', async () => {
    const h = wired([run()])
    h.events.queue(parked({ state: 'failed' }), 'Could not read the ClickUp replies')
    await h.settle()
    h.events.queue(parked({ state: 'failed' }), 'Could not read the ClickUp replies')
    await h.settle()
    expect(h.sent).toHaveLength(1)
  })

  test('a rebuild that reaches the same state for the same reason is sent again', async () => {
    const h = wired([run(), run({ id: 'run-2' })])
    h.events.queue(parked({ state: 'ready' }), 'Built and ready for review')
    h.events.queue(parked({ state: 'ready', runIds: ['run-1', 'run-2'] }), 'Built and ready for review')
    await h.settle()
    expect(h.sent).toHaveLength(2)
  })

  test('a land retry that reaches the same stage again is sent', async () => {
    const h = wired([run()])
    const land = (startedAt: number) => ({ stage: 'uat', stages: { uat: { status: 'waiting' as const, startedAt } }, plan: [] })
    h.events.queue(parked({ state: 'awaiting-stage', land: land(1) }), 'uat is ready')
    h.events.queue(parked({ state: 'awaiting-stage', land: land(1) }), 'uat is ready')
    h.events.queue(parked({ state: 'awaiting-stage', land: land(2) }), 'uat is ready')
    await h.settle()
    expect(h.sent.map(event => event.landStage)).toEqual(['uat', 'uat'])
  })

  test('a run blocked again after a retry sends blocked again', async () => {
    const h = wired([])
    h.events.runSettled(run({ status: 'blocked', error: 'tests failed' }))
    h.events.runSettled(run({ status: 'blocked', error: 'tests failed' }))
    h.events.runSettled(run({ status: 'blocked', error: 'tests failed', attempts: tries(2) }))
    await h.settle()
    expect(h.sent.map(event => event.event)).toEqual(['blocked', 'blocked'])
  })
})
