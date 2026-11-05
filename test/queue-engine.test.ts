import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { writeQueueContext } from '../server/queue-files'
import { createQueueEngine, QueueRefusal, type QueueEngineDeps, type QueueRunner } from '../server/queue-engine'
import type { RunView } from '../server/queue-prompts'
import type { QueueSource } from '../server/queue-source'
import { createQueueStore, type QueueItem } from '../server/queue-store'
import type { WorkflowAttempt } from '../server/workflow-runner'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-engine-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const blockedWith = (evidence: string[]): WorkflowAttempt => ({ nodeId: 'plan', number: 1, jobId: 'j', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: { outcome: 'blocked', summary: 'Need info', evidence }, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [] })

function harness(over: Partial<QueueEngineDeps> = {}, sourceOver: Partial<QueueSource> = {}) {
  const store = createQueueStore(join(dir, 'queue.json'))
  const runs = new Map<string, RunView>()
  const started: Array<{ cwd: string; request: string; label: string; workflowId?: string }> = []
  const posted: Array<{ id: string; kind: string; lines: string[] }> = []
  const alerts: Array<{ title: string; reason: string; state: string }> = []
  let next = 0
  const runner: QueueRunner = {
    start: async input => { started.push(input); const id = `run-${++next}`; runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } },
    get: id => runs.get(id),
  }
  const source: QueueSource = {
    item: async ({ id }) => ({ title: `Task ${id}`, url: `https://x/t/${id}`, contextMarkdown: `# ${id}` }),
    post: async input => { posted.push(input); return { commentId: 'c1' } },
    replies: async () => ({ replies: [], lastId: null }),
    ...sourceOver,
  }
  const deps: QueueEngineDeps = {
    store, runner,
    source: () => source,
    prepareWorktree: async (repo, label) => ({ worktree: join(repo, '.worktree', label) }),
    writeContext: async (pluginId, context, cwd) => join(cwd, '.shikidan', 'queue', pluginId, `${context.name}.md`),
    pluginFiles: pluginId => join(dir, 'plugin-data', pluginId, 'files'),
    backupDir: itemId => join(dir, 'queue-files', itemId),
    needsYou: (item, reason) => { alerts.push({ title: item.title, reason, state: item.state }) },
    ...over,
  }
  const settle = (id: string, run: Partial<RunView>) => { const done = { ...runs.get(id)!, ...run }; runs.set(id, done); return done }
  return { engine: createQueueEngine(deps), store, runs, started, posted, alerts, settle }
}

const add = { source: 'clickup-board', externalId: '1', repo: '/repo' }
const states = (items: QueueItem[]) => items.map(item => `${item.externalId}:${item.state}`)

test('adding an item fetches its title and starts building it in its own worktree', async () => {
  const h = harness()
  const item = await h.engine.add({ ...add, flowId: 'wf-1' })
  expect(item.title).toBe('Task 1')
  const built = h.store.get(item.id)!
  expect(built).toMatchObject({ state: 'building', currentRunId: 'run-1', runIds: ['run-1'], worktree: '/repo/.worktree/queue-task-1-1-a8c0' })
  expect(built.contextPath).toBe('/repo/.worktree/queue-task-1-1-a8c0/.shikidan/queue/clickup-board/item-1.md')
  expect(h.started).toEqual([{ cwd: '/repo/.worktree/queue-task-1-1-a8c0', request: expect.stringContaining('Work on "Task 1"'), label: 'Task 1', workflowId: 'wf-1' }])
})

test('adding in the background returns the queued item before its slow build finishes', async () => {
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const h = harness({ prepareWorktree: async (repo, label) => { await gate; return { worktree: join(repo, '.worktree', label) } } })
  const item = await h.engine.add(add, { background: true })
  expect(item).toMatchObject({ state: 'queued', title: 'Task 1' })
  expect(h.started).toEqual([])
  release()
  await h.engine.kick()
  expect(h.store.get(item.id)).toMatchObject({ state: 'building', currentRunId: 'run-1' })
})

test('while its workspace is being prepared the engine says which item it is preparing, and tells listeners', async () => {
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const h = harness({ prepareWorktree: async (repo, label) => { await gate; return { worktree: join(repo, '.worktree', label) } } })
  let told = 0
  h.engine.subscribeChecks(() => { told += 1 })
  expect(h.engine.preparing()).toBeNull()
  const item = await h.engine.add(add, { background: true })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(h.engine.preparing()).toBe(item.id)
  expect(told).toBe(1)
  release()
  await h.engine.kick()
  expect(h.engine.preparing()).toBeNull()
  expect(told).toBe(2)
})

test('a background build that fails marks the item failed without a stray rejection', async () => {
  const h = harness({ prepareWorktree: async () => { throw new Error('worktree add failed') } })
  const item = await h.engine.add(add, { background: true })
  await h.engine.kick()
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: 'worktree add failed' })
})

test('two adds at once build only the first; the second waits queued', async () => {
  const h = harness()
  await Promise.all([h.engine.add(add), h.engine.add({ ...add, externalId: '2' })])
  expect(states(h.store.list())).toEqual(['1:building', '2:queued'])
  expect(h.started).toHaveLength(1)
})

test('a passed run makes the item ready, tells you, and starts the next', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  expect(states(h.store.list())).toEqual(['1:ready', '2:building'])
  expect(h.alerts).toEqual([{ title: 'Task 1', reason: 'Built and ready for review', state: 'ready' }])
})

test('a run blocked with questions posts them, parks the item and frees the slot', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', attempts: [blockedWith(['biz: Which page?'])] }))
  expect(h.posted).toEqual([{ id: '1', kind: 'ask', lines: ['Which page?'] }])
  expect(h.store.list()[0]).toMatchObject({ state: 'waiting-info', questions: ['Which page?'], lastSeenId: 'c1', currentRunId: null })
  expect(h.store.list()[1]!.state).toBe('building')
})

test('a blocked run without questions, a failed or a stopped run fails the item and tells you', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', error: 'Visit cap reached', attempts: [] }))
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.onRunSettled(h.settle('run-2', { status: 'failed', error: 'Agent crashed' }))
  await h.engine.add({ ...add, externalId: '3' })
  await h.engine.onRunSettled(h.settle('run-3', { status: 'stopped', error: null }))
  expect(h.store.list().map(item => [item.state, item.error])).toEqual([['failed', 'Visit cap reached'], ['failed', 'Agent crashed'], ['failed', 'Run stopped']])
  expect(h.alerts).toEqual([
    { title: 'Task 1', reason: 'Visit cap reached', state: 'failed' },
    { title: 'Task 2', reason: 'Agent crashed', state: 'failed' },
    { title: 'Task 3', reason: 'Run stopped', state: 'failed' },
  ])
})

test('posting the questions failing fails the item with the reason', async () => {
  const h = harness({}, { post: async () => { throw new Error('ClickUp is down') } })
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', attempts: [blockedWith(['biz: Which page?'])] }))
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'Could not post the questions: ClickUp is down' })
})

test('a settle for an unknown or already settled run changes nothing', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled({ id: 'other', status: 'done', error: null, attempts: [] })
  const done = h.settle('run-1', { status: 'done' })
  await h.engine.onRunSettled(done)
  await h.engine.onRunSettled(done)
  expect(h.alerts).toHaveLength(1)
})

test('a run that settles before start returns still settles its item', async () => {
  const h = harness()
  const instant: QueueRunner = { start: async () => { h.runs.set('run-x', { id: 'run-x', status: 'failed', error: 'No agent for plan', attempts: [] }); return { id: 'run-x' } }, get: id => h.runs.get(id) }
  const fast = harness({ runner: instant, store: h.store })
  await fast.engine.add(add)
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'No agent for plan' })
})

test('a start error fails that item and moves on to the next', async () => {
  let calls = 0
  const h = harness({ prepareWorktree: async (repo, label) => { calls += 1; if (calls === 1) throw new Error('not a git repo'); return { worktree: join(repo, '.worktree', label) } } })
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  expect(states(h.store.list())).toEqual(['1:failed', '2:building'])
  expect(h.store.list()[0]!.error).toBe('not a git repo')
})

test('requeue puts a failed item back at the end and builds it when free', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  const again = await h.engine.requeue(h.store.list()[0]!.id)
  expect(again.state).toBe('building')
  expect(again.error).toBeNull()
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(h.engine.requeue('nope')).rejects.toThrow('No queue item nope')
  } finally { quiet.mockRestore() }
})

test('requeue moves the item behind the others', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  await h.engine.requeue(h.store.list()[0]!.id)
  expect(states(h.store.list())).toEqual(['2:building', '1:queued'])
})

test('requeue builds a ready item again', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  const again = await h.engine.requeue(h.store.list()[0]!.id)
  expect(again).toMatchObject({ state: 'building', currentRunId: 'run-2', runIds: ['run-1', 'run-2'] })
})

test('requeue refuses an item that is still building and leaves it alone', async () => {
  const h = harness()
  const item = await h.engine.add(add)
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(h.engine.requeue(item.id)).rejects.toThrow('It is building now')
  } finally { quiet.mockRestore() }
  expect(h.store.get(item.id)).toMatchObject({ state: 'building', currentRunId: 'run-1' })
  expect(h.started).toHaveLength(1)
})

test('recover settles an item whose run finished while MC was down', async () => {
  const h = harness()
  await h.engine.add(add)
  h.settle('run-1', { status: 'done' })
  await h.engine.recover()
  expect(h.store.list()[0]!.state).toBe('ready')
})

test('recover fails an item whose run is gone', async () => {
  const h = harness()
  await h.engine.add(add)
  h.runs.delete('run-1')
  await h.engine.recover()
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'Its run is gone' })
})

test('recover leaves an item whose run is still running', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.recover()
  expect(h.store.list()[0]).toMatchObject({ state: 'building', currentRunId: 'run-1' })
  expect(h.started).toHaveLength(1)
})

function heldRunner(h: ReturnType<typeof harness>) {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const inStart = new Promise<void>(resolve => { entered = resolve })
  const runner: QueueRunner = {
    start: async () => { entered(); await gate; h.runs.set('run-held', { id: 'run-held', status: 'running', error: null, attempts: [] }); return { id: 'run-held' } },
    get: id => h.runs.get(id),
  }
  return { runner, release, inStart }
}

function stoppableHarness() {
  const h = harness()
  const stopped: string[] = []
  const runner: QueueRunner = {
    start: async () => { const id = `run-${stopped.length + h.runs.size + 1}`; h.runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } },
    get: id => h.runs.get(id),
    stop: async (id) => { stopped.push(id); h.runs.set(id, { ...h.runs.get(id)!, status: 'stopped', error: 'Stopped by user' }) },
  }
  return { ...h, stopped, engine: harness({ runner, store: h.store }).engine }
}

test('remove waits for a build in progress, then stops its run and deletes the item', async () => {
  const h = harness()
  const held = heldRunner(h)
  const stopped: string[] = []
  const runner: QueueRunner = { ...held.runner, stop: async (id) => { stopped.push(id) } }
  const engine = harness({ runner, store: h.store }).engine
  const adding = engine.add(add)
  await held.inStart
  const id = h.store.list()[0]!.id
  const removing = engine.remove(id)
  held.release()
  await adding
  await removing
  expect(stopped).toEqual(['run-held'])
  expect(h.store.list()).toEqual([])
})

test('stop ends a building item\'s run and the settled run leaves it failed with a run to resume', async () => {
  const h = stoppableHarness()
  const item = await h.engine.add(add)
  expect(h.store.get(item.id)).toMatchObject({ state: 'building', currentRunId: 'run-1' })
  await h.engine.stop(item.id)
  expect(h.stopped).toEqual(['run-1'])
  await h.engine.onRunSettled(h.runs.get('run-1')!)
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: 'Stopped by user', currentRunId: null, resumeRunId: 'run-1' })
})

test('stop does not call the runner again for a run that already settled', async () => {
  const h = stoppableHarness()
  const item = await h.engine.add(add)
  h.settle('run-1', { status: 'failed', error: 'boom' })
  await h.engine.stop(item.id)
  expect(h.stopped).toEqual([])
})

test('stop refuses an item that is not building or shipping, and an unknown id', async () => {
  const h = stoppableHarness()
  await h.engine.add(add)
  const queued = await h.engine.add({ ...add, externalId: '2' })
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(h.engine.stop(queued.id)).rejects.toThrow('It is queued now')
    await expect(h.engine.stop('nope')).rejects.toThrow('No queue item nope')
  } finally { quiet.mockRestore() }
  expect(h.stopped).toEqual([])
})

test('move waits for a build in progress and never starts a second build', async () => {
  const h = harness()
  const held = heldRunner(h)
  const engine = harness({ runner: held.runner, store: h.store }).engine
  const adding = engine.add(add)
  await held.inStart
  await h.store.add({ source: 'clickup-board', externalId: '2', title: 'Task 2', url: 'u', repo: '/repo', flowId: null }, 'end')
  const id = h.store.list()[1]!.id
  const moving = engine.move(id, 0)
  held.release()
  await Promise.all([adding, moving])
  expect(states(h.store.list())).toEqual(['2:queued', '1:building'])
})

test('remove deletes an item that is not building and refuses an unknown id', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  const id = h.store.list()[0]!.id
  await h.engine.remove(id)
  expect(h.store.list()).toEqual([])
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(h.engine.remove(id)).rejects.toThrow(`No queue item ${id}`)
    await expect(h.engine.move(id, 0)).rejects.toThrow(`No queue item ${id}`)
  } finally { quiet.mockRestore() }
})

test('move refuses an item that is not queued', async () => {
  const h = harness()
  await h.engine.add(add)
  const id = h.store.list()[0]!.id
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(h.engine.move(id, 0)).rejects.toThrow('It is building now')
    await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
    await expect(h.engine.move(id, 0)).rejects.toThrow('It is failed now')
  } finally { quiet.mockRestore() }
})

test('adding an item already in the queue is refused in any state', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  await expect(h.engine.add({ ...add, repo: '/other' })).rejects.toThrow('Already in the queue')
  await h.engine.add({ ...add, source: 'other-board' })
  expect(h.store.list()).toHaveLength(2)
})

test('two adds of the same item at once keep only one', async () => {
  const h = harness()
  const results = await Promise.allSettled([h.engine.add(add), h.engine.add(add)])
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(h.store.list()).toHaveLength(1)
  expect(h.started).toHaveLength(1)
})

test('requeue rebuilds a waiting item on the same worktree with its answers', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', attempts: [blockedWith(['biz: Which page?'])] }))
  const parked = h.store.list()[0]!
  const answers = join(dir, 'answers-1.md')
  await writeFile(answers, '# answers')
  await h.store.update(parked.id, { answerPaths: [answers] })
  const again = await h.engine.requeue(parked.id)
  expect(again).toMatchObject({ state: 'building', worktree: parked.worktree, questions: [], runIds: ['run-1', 'run-2'] })
  expect(h.started[1]).toMatchObject({ cwd: parked.worktree, request: expect.stringContaining(`read ${answers}`) })
})

const retried = (run: RunView, change: Partial<RunView>): RunView => ({ ...run, ...change, attempts: [...run.attempts, blockedWith([]), ...(change.attempts ?? [])] })

test('a run retried in Studio that passes makes the failed item ready and tells you', async () => {
  const h = harness()
  await h.engine.add(add)
  const failed = h.settle('run-1', { status: 'failed', error: 'boom' })
  await h.engine.onRunSettled(failed)
  await h.engine.onRunSettled(h.settle('run-1', retried(failed, { status: 'done', error: null })))
  expect(h.store.list()[0]).toMatchObject({ state: 'ready', error: null, currentRunId: null })
  expect(h.alerts.at(-1)).toEqual({ title: 'Task 1', reason: 'Built and ready for review', state: 'ready' })
})

test('a run retried in Studio that is blocked with questions posts them and parks the item', async () => {
  const h = harness()
  await h.engine.add(add)
  const failed = h.settle('run-1', { status: 'failed', error: 'boom' })
  await h.engine.onRunSettled(failed)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', error: null, attempts: [blockedWith(['biz: Which page?'])] }))
  expect(h.posted).toEqual([{ id: '1', kind: 'ask', lines: ['Which page?'] }])
  expect(h.store.list()[0]).toMatchObject({ state: 'waiting-info', questions: ['Which page?'], lastSeenId: 'c1' })
})

test('a run retried in Studio that fails again fails the item with the new reason', async () => {
  const h = harness()
  await h.engine.add(add)
  const failed = h.settle('run-1', { status: 'failed', error: 'boom' })
  await h.engine.onRunSettled(failed)
  await h.engine.onRunSettled(h.settle('run-1', retried(failed, { status: 'failed', error: 'boom again' })))
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'boom again' })
  expect(h.alerts.map(alert => alert.reason)).toEqual(['boom', 'boom again'])
})

test('a settled run that is not the item\'s last run, or an item queued again, is left alone', async () => {
  const h = harness()
  await h.engine.add(add)
  const first = h.settle('run-1', { status: 'failed', error: 'boom' })
  await h.engine.onRunSettled(first)
  await h.engine.requeue(h.store.list()[0]!.id)
  await h.engine.onRunSettled(h.settle('run-2', { status: 'failed', error: 'second' }))
  await h.engine.onRunSettled(retried(first, { status: 'done', error: null }))
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'second' })
})

test('requeue refuses while the item\'s last run is running again in Studio', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  h.settle('run-1', { status: 'running', error: null })
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(h.engine.requeue(h.store.list()[0]!.id)).rejects.toThrow('It is running in Studio now')
  } finally { quiet.mockRestore() }
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', runIds: ['run-1'] })
  expect(h.started).toHaveLength(1)
})

test('asking again keeps the reply cursor so replies written meanwhile are still read', async () => {
  let comment = 0
  const h = harness({}, { post: async () => ({ commentId: `c${++comment}` }) })
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', attempts: [blockedWith(['biz: Which page?'])] }))
  const item = h.store.list()[0]!
  expect(item.lastSeenId).toBe('c1')
  await h.store.update(item.id, { lastSeenId: 'r1' })
  await h.engine.requeue(item.id)
  await h.engine.onRunSettled(h.settle('run-2', { status: 'blocked', attempts: [blockedWith(['biz: Which button?'])] }))
  expect(h.store.get(item.id)).toMatchObject({ state: 'waiting-info', questions: ['Which button?'], lastSeenId: 'r1' })
})

test('the engine\'s own refusals carry 404 for an unknown item and 409 for its state', async () => {
  const h = harness()
  const item = await h.engine.add(add)
  const refusals: unknown[] = []
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (const attempt of [h.engine.requeue('nope'), h.engine.remove('nope'), h.engine.move('nope', 0), h.engine.requeue(item.id), h.engine.remove(item.id), h.engine.move(item.id, 0), h.engine.add(add)]) {
      refusals.push(await attempt.then(() => null, (error: unknown) => error))
    }
  } finally { quiet.mockRestore() }
  expect(refusals.every(error => error instanceof QueueRefusal)).toBe(true)
  expect(refusals.map(error => (error as QueueRefusal).status)).toEqual([404, 404, 404, 409, 409, 409, 409])
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  h.settle('run-1', { status: 'running', error: null })
  const muted = spyOn(console, 'error').mockImplementation(() => {})
  const studio = await h.engine.requeue(item.id).then(() => null, (error: unknown) => error).finally(() => muted.mockRestore())
  expect(studio).toBeInstanceOf(QueueRefusal)
  expect(studio).toMatchObject({ status: 409, message: 'It is running in Studio now' })
})

async function cardWith(images: Array<{ name: string; path: string }>, files: Record<string, string>) {
  const pluginFiles = join(dir, 'plugin-data', 'clickup-board', 'files')
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(pluginFiles, path)), { recursive: true })
    await writeFile(join(pluginFiles, path), bytes)
  }
  const h = harness({
    prepareWorktree: async (repo, label) => { const worktree = join(dir, 'wt', repo.replaceAll('/', '_'), label); await mkdir(worktree, { recursive: true }); return { worktree } },
    writeContext: (pluginId, context, cwd) => writeQueueContext(pluginId, context, cwd),
  }, { item: async ({ id }) => ({ title: `Task ${id}`, url: 'u', contextMarkdown: '# card', images }) })
  const item = await h.engine.add(add)
  const stored = h.store.get(item.id)!
  return { stored, context: await readFile(stored.contextPath!, 'utf8'), folder: join(stored.worktree!, '.shikidan', 'queue', 'clickup-board', 'card-images') }
}

test('downloaded card images are copied into the workspace and listed with absolute paths', async () => {
  const { context, folder } = await cardWith(
    [{ name: 'one.png', path: 'card/one.png' }, { name: 'two.png', path: 'card/two.png' }],
    { 'card/one.png': 'bytes-one', 'card/two.png': 'bytes-two' },
  )
  expect(context).toBe(`# card\n\n## Downloaded images\n\n- one.png: ${join(folder, '0-one.png')}\n- two.png: ${join(folder, '1-two.png')}\n`)
  expect(await readFile(join(folder, '0-one.png'), 'utf8')).toBe('bytes-one')
  expect(await readFile(join(folder, '1-two.png'), 'utf8')).toBe('bytes-two')
})

test('a card image outside the plugin files folder is listed as not copied and the item still builds', async () => {
  await writeFile(join(dir, 'secret'), 'do not copy')
  const { stored, context, folder } = await cardWith([{ name: 'key', path: '../../../secret' }, { name: 'ok.png', path: 'ok.png' }], { 'ok.png': 'fine' })
  expect(stored.state).toBe('building')
  expect(context).toContain('- key: not copied (outside the plugin folder:')
  expect(context).toContain(`- ok.png: ${join(folder, '1-ok.png')}`)
  expect(await readdir(folder)).toEqual(['1-ok.png'])
})

test('a card without images keeps its context unchanged and makes no image folder', async () => {
  const { context, folder } = await cardWith([], {})
  expect(context).toBe('# card')
  await expect(readdir(folder)).rejects.toThrow()
})

const unavailable = { engine: 'glm', reason: 'glm needs a z.ai token (Settings · GLM)', until: null }
const MINUTE = 60_000

function resumable(over: Partial<QueueEngineDeps> = {}, retryFails = false) {
  const retried: string[] = []
  let next = 0
  const h = harness({ ...over, runner: {
    start: async input => { if (input.graph !== undefined) throw new Error('no recovery in this harness'); h.started.push(input); const id = `run-${++next}`; h.runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } },
    get: id => h.runs.get(id),
    retry: async id => {
      retried.push(id)
      if (retryFails) throw new Error('Workspace still has running work')
      h.runs.set(id, { ...h.runs.get(id)!, status: 'running', error: null })
      return { id }
    },
  } })
  return { ...h, retried }
}

test('a failed card resumes its last run instead of starting a new one', async () => {
  const h = resumable()
  const item = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'Implement reached its 3-visit limit from Review' }))
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', resumeRunId: 'run-1' })
  const again = await h.engine.requeue(item.id)
  expect(h.retried).toEqual(['run-1'])
  expect(h.started).toHaveLength(1)
  expect(again).toMatchObject({ state: 'building', currentRunId: 'run-1', runIds: ['run-1'], error: null })
  expect(again.resumeRunId).toBeUndefined()
})

test('start over ignores the last run', async () => {
  const h = resumable()
  const item = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  const again = await h.engine.requeue(item.id, { fresh: true })
  expect(h.retried).toEqual([])
  expect(again).toMatchObject({ state: 'building', currentRunId: 'run-2', runIds: ['run-1', 'run-2'] })
  expect(again.resumeRunId).toBeUndefined()
})

test('a paused card resumes the same run when the pause ends', async () => {
  let now = 1_000_000
  const h = resumable({ now: () => now })
  const item = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', unavailable }))
  expect(h.store.get(item.id)).toMatchObject({ state: 'queued', resumeRunId: 'run-1' })
  now += 6 * MINUTE
  await h.engine.kick()
  expect(h.retried).toEqual(['run-1'])
  expect(h.started).toHaveLength(1)
  expect(h.store.get(item.id)).toMatchObject({ state: 'building', currentRunId: 'run-1', runIds: ['run-1'] })
})

test('a failed retry falls back to a fresh start', async () => {
  const h = resumable({}, true)
  const item = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const again = await h.engine.requeue(item.id)
    expect(again).toMatchObject({ state: 'building', currentRunId: 'run-2', runIds: ['run-1', 'run-2'] })
    expect(again.resumeRunId).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('Workspace still has running work')
  } finally { warn.mockRestore() }
  expect(h.retried).toEqual(['run-1'])
})

test('a picked card always starts a fresh run', async () => {
  const h = resumable({ prepareWorktree: async (_repo, label) => { const worktree = join(dir, 'wt', label); await mkdir(worktree, { recursive: true }); return { worktree } } })
  const item = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  const picking = { ...blockedWith(['pick: A,B | visualizer/login | A | Ploy']), nodeId: 'mockups' }
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', error: null, attempts: [picking] }))
  expect(h.store.get(item.id)!.state).toBe('waiting-pick')
  expect(h.store.get(item.id)!.resumeRunId).toBeUndefined()
  const picked = await h.engine.pick(item.id, { option: 'A' })
  expect(h.retried).toEqual([])
  expect(picked).toMatchObject({ state: 'building', currentRunId: 'run-2', runIds: ['run-1', 'run-2'] })
})

test('a card failed before its run started keeps no run to resume', async () => {
  const h = resumable({ prepareWorktree: async () => { throw new Error('not a git repo') } })
  const item = await h.engine.add(add)
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: 'not a git repo' })
  expect(h.store.get(item.id)!.resumeRunId).toBeUndefined()
})

test('an unavailable run puts the card back first in line and pauses the queue instead of failing it', async () => {
  let now = 1_000_000
  const h = harness({ now: () => now })
  const first = await h.engine.add(add)
  const second = await h.engine.add({ ...add, externalId: '2' })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', error: 'glm unavailable: glm needs a z.ai token (Settings · GLM)', unavailable }))
  expect(h.store.get(first.id)).toMatchObject({ state: 'queued', currentRunId: null, error: null, runIds: ['run-1'] })
  expect(h.store.list().map(item => item.id)).toEqual([first.id, second.id])
  expect(h.started).toHaveLength(1)
  expect(h.engine.paused()).toEqual({ reason: 'glm unavailable: glm needs a z.ai token (Settings · GLM)', until: now + 5 * MINUTE })
  expect(h.alerts.filter(alert => alert.reason.startsWith('Queue paused'))).toEqual([{ title: 'Task 1', reason: 'Queue paused: glm unavailable: glm needs a z.ai token (Settings · GLM)', state: 'queued' }])
  await h.engine.kick()
  expect(h.started).toHaveLength(1)
  expect(states(h.store.list())).toEqual(['1:queued', '2:queued'])
})

test('the queue resumes by itself after the pause time', async () => {
  let now = 1_000_000
  const h = harness({ now: () => now })
  const item = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', unavailable: { ...unavailable, until: now + 30 * MINUTE } }))
  expect(h.engine.paused()?.until).toBe(now + 30 * MINUTE)
  now += 29 * MINUTE
  await h.engine.kick()
  expect(h.started).toHaveLength(1)
  now += 2 * MINUTE
  await h.engine.kick()
  expect(h.engine.paused()).toBeNull()
  expect(h.started).toHaveLength(2)
  expect(h.store.get(item.id)).toMatchObject({ state: 'building', currentRunId: 'run-2', runIds: ['run-1', 'run-2'] })
})

test('a run that is already unavailable when it starts pauses the queue after one build instead of looping', async () => {
  let builds = 0
  const looping = harness({ runner: { start: async () => { builds += 1; const id = `run-${builds}`; looping.runs.set(id, { id, status: 'blocked', error: 'glm unavailable', attempts: [], unavailable }); return { id } }, get: id => looping.runs.get(id) } })
  await looping.engine.add(add)
  expect(builds).toBe(1)
  expect(looping.engine.paused()?.reason).toContain('glm unavailable')
  expect(looping.store.list()[0]!.state).toBe('queued')
})

test('an expired pause tells stream listeners even when no card is waiting', async () => {
  let now = 1_000_000
  const h = harness({ now: () => now })
  const item = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', unavailable: { ...unavailable, until: now + 5 * MINUTE } }))
  await h.engine.remove(item.id)
  let told = 0
  h.engine.subscribeChecks(() => { told += 1 })
  now += 6 * MINUTE
  await h.engine.kick()
  expect(h.engine.paused()).toBeNull()
  expect(told).toBe(1)
})

test('pause backoff grows 5, 15, 60 minutes and resets after a normal settle', async () => {
  let now = 1_000_000
  const h = harness({ now: () => now })
  const item = await h.engine.add(add)
  const waits: number[] = []
  for (let run = 1; run <= 4; run++) {
    await h.engine.onRunSettled(h.settle(`run-${run}`, { status: 'blocked', unavailable }))
    waits.push((h.engine.paused()!.until - now) / MINUTE)
    now = h.engine.paused()!.until
    await h.engine.kick()
  }
  expect(waits).toEqual([5, 15, 60, 60])
  expect(h.alerts.filter(alert => alert.reason.startsWith('Queue paused'))).toHaveLength(4)
  await h.engine.onRunSettled(h.settle('run-5', { status: 'done' }))
  expect(h.store.get(item.id)!.state).toBe('ready')
  await h.engine.requeue(item.id)
  await h.engine.onRunSettled(h.settle('run-6', { status: 'blocked', unavailable }))
  expect((h.engine.paused()!.until - now) / MINUTE).toBe(5)
})

test('with parallel 2, two cards build at once and a third waits', async () => {
  const h = harness({ parallel: async () => 2 })
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.add({ ...add, externalId: '3' })
  expect(h.started).toHaveLength(2)
  expect(states(h.store.list())).toEqual(['1:building', '2:building', '3:queued'])
})

test('when one of two building cards settles, the next card starts', async () => {
  const h = harness({ parallel: async () => 2 })
  for (const externalId of ['1', '2', '3']) await h.engine.add({ ...add, externalId })
  await h.engine.onRunSettled(h.settle('run-2', { status: 'done' }))
  expect(states(h.store.list())).toEqual(['1:building', '2:ready', '3:building'])
  expect(h.started).toHaveLength(3)
})

test('a paused queue starts nothing even below the limit', async () => {
  let now = 1_000_000
  const h = harness({ now: () => now, parallel: async () => 3 })
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', unavailable }))
  await h.engine.add({ ...add, externalId: '3' })
  await h.engine.kick()
  expect(h.started).toHaveLength(2)
  expect(states(h.store.list())).toEqual(['1:queued', '2:building', '3:queued'])
})

test('parallel 1 keeps one at a time', async () => {
  const h = harness({ parallel: async () => 1 })
  await Promise.all([h.engine.add(add), h.engine.add({ ...add, externalId: '2' })])
  expect(states(h.store.list())).toEqual(['1:building', '2:queued'])
  expect(h.started).toHaveLength(1)
})

test('a landing card does not count against the limit', async () => {
  const h = harness({ parallel: async () => 2 })
  const first = await h.engine.add(add)
  await h.store.update(first.id, { state: 'landing', currentRunId: null })
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.add({ ...add, externalId: '3' })
  expect(states(h.store.list())).toEqual(['1:landing', '2:building', '3:building'])
})
