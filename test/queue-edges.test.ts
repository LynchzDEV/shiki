import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QueueRefusal, type QueueEngineDeps, type QueueRunner } from '../server/queue-engine'
import type { QueueSource } from '../server/queue-source'
import { add, blockedWith, parkedItem, queueHarness, refusal, reply, states } from './support/queue-harness'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-edges-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const harness = (over: Partial<QueueEngineDeps> = {}, sourceOver: Partial<QueueSource> = {}) => queueHarness(dir, over, sourceOver)

test('requeue refuses an item that is already queued and leaves it in line', async () => {
  const h = harness()
  await h.engine.add(add)
  const second = await h.engine.add({ ...add, externalId: '2' })
  const refused = await refusal(h.engine.requeue(second.id))
  expect(refused).toBeInstanceOf(QueueRefusal)
  expect(refused).toMatchObject({ status: 409, message: 'It is queued now' })
  expect(states(h.store.list())).toEqual(['1:building', '2:queued'])
})

test('remove deletes a queued, a waiting and a ready item', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  const built = await h.engine.add({ ...add, externalId: '2' })
  const queued = await h.engine.add({ ...add, externalId: '3' })
  await h.engine.onRunSettled(h.settle('run-2', { status: 'done' }))
  expect(states(h.store.list())).toEqual(['1:waiting-info', '2:ready', '3:building'])
  await h.engine.add({ ...add, externalId: '4' })
  for (const id of [parked.id, built.id]) await h.engine.remove(id)
  expect(states(h.store.list())).toEqual(['3:building', '4:queued'])
  await h.engine.remove(h.store.list()[1]!.id)
  expect(h.store.list().map(item => item.id)).toEqual([queued.id])
})

test('a removed item can be added again', async () => {
  const h = harness()
  const first = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  await h.engine.remove(first.id)
  const again = await h.engine.add(add)
  expect(again.id).not.toBe(first.id)
  expect(h.store.list()).toMatchObject([{ id: again.id, state: 'building', runIds: ['run-2'] }])
})

test('a queued item removed while another build is starting is never built', async () => {
  const h = harness()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const inStart = new Promise<void>(resolve => { entered = resolve })
  const held: QueueRunner = { start: async input => { h.started.push(input); entered(); await gate; h.runs.set('run-held', { id: 'run-held', status: 'running', error: null, attempts: [] }); return { id: 'run-held' } }, get: id => h.runs.get(id) }
  const engine = harness({ runner: held, store: h.store }).engine
  const adding = engine.add(add)
  await inStart
  const waiting = await h.store.add({ source: 'clickup-board', externalId: '2', title: 'Task 2', url: 'u', repo: '/repo', flowId: null }, 'end')
  const removing = engine.remove(waiting.id)
  release()
  await Promise.all([adding, removing])
  expect(states(h.store.list())).toEqual(['1:building'])
  h.runs.set('run-held', { id: 'run-held', status: 'done', error: null, attempts: [] })
  await engine.onRunSettled(h.runs.get('run-held')!)
  expect(states(h.store.list())).toEqual(['1:ready'])
  expect(h.started).toHaveLength(1)
})

test('items for two different repos still share the one build slot', async () => {
  const h = harness()
  await h.engine.add({ ...add, repo: '/repo-a' })
  await h.engine.add({ ...add, externalId: '2', repo: '/repo-b' })
  expect(states(h.store.list())).toEqual(['1:building', '2:queued'])
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  expect(states(h.store.list())).toEqual(['1:ready', '2:building'])
  expect(h.started.map(start => start.cwd)).toEqual([expect.stringContaining('_repo_a'), expect.stringContaining('_repo_b')])
})

test('an empty queue checks, recovers and kicks without starting anything', async () => {
  const h = harness({ now: () => 77 })
  expect(await h.engine.checkReplies()).toEqual({ checked: 0, resumed: 0 })
  expect(h.engine.checkedAt()).toBe(77)
  await h.engine.recover()
  await h.engine.kick()
  expect(h.started).toEqual([])
  expect(h.sinceIds).toEqual([])
})

test('an interrupted run fails the item instead of asking its leftover evidence', async () => {
  const h = harness()
  await h.engine.add(add)
  const interrupted = blockedWith(['half a question'], { interrupted: true })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', error: 'Interrupted transition or acceptance check', attempts: [interrupted] }))
  expect(h.posted).toEqual([])
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'Interrupted transition or acceptance check' })
})

test('a join conflict fails the item with the conflict as its reason instead of asking', async () => {
  const h = harness()
  await h.engine.add(add)
  const join = blockedWith(['Joined: p1', 'Conflicts in p2: a.ts'], { nodeId: 'join', jobId: null, endedAt: 9 })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', error: 'Paths could not be joined: a.ts', attempts: [join] }))
  expect(h.posted).toEqual([])
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'Paths could not be joined: a.ts', questions: [] })
})

test('a parallel step interrupted as the run blocks does not hide the questions of the blocked step', async () => {
  const h = harness()
  await h.engine.add(add)
  const sibling = blockedWith([], { nodeId: 'plan-b', interrupted: true, endedAt: 10 })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', attempts: [blockedWith(['biz: Which page?'], { nodeId: 'plan-a', number: 2, endedAt: 9 }), sibling] }))
  expect(h.posted).toEqual([{ id: '1', kind: 'ask', lines: ['Which page?'] }])
  expect(h.store.list()[0]).toMatchObject({ state: 'waiting-info', questions: ['Which page?'] })
})

test('a stopped run whose last step asked questions still fails rather than asks', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'stopped', error: null, attempts: [blockedWith(['biz: Which page?'])] }))
  expect(h.posted).toEqual([])
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'Run stopped' })
})

test('a source turned off between add and build fails the queued item and moves on', async () => {
  let off = false
  const h = harness({}, { item: async ({ id }) => { if (off && id === '2') throw new Error('clickup-board is turned off'); return { title: `Task ${id}`, url: 'u', contextMarkdown: '# t' } } })
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.add({ ...add, externalId: '3' })
  off = true
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  expect(states(h.store.list())).toEqual(['1:ready', '2:failed', '3:building'])
  expect(h.store.list()[1]!.error).toBe('clickup-board is turned off')
  expect(h.alerts.map(alert => alert.reason)).toEqual(['Built and ready for review', 'clickup-board is turned off'])
})

test('a Studio retry of a waiting item\'s run that passes makes it ready and tells you', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  const blocked = h.runs.get('run-1')!
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done', attempts: [...blocked.attempts, blockedWith([], { number: 2, endedAt: 3 })] }))
  expect(h.store.get(parked.id)).toMatchObject({ state: 'ready', currentRunId: null, error: null })
  expect(h.alerts.at(-1)).toEqual({ title: 'Task 1', reason: 'Built and ready for review', state: 'ready' })
})

test('a Studio retry that makes a waiting item ready clears its questions', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  const blocked = h.runs.get('run-1')!
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done', attempts: [...blocked.attempts, blockedWith([], { number: 2, endedAt: 3 })] }))
  expect(h.store.get(parked.id)).toMatchObject({ state: 'ready', questions: [] })
})

test('a Studio retry of a waiting item\'s run that fails fails it and stops reading its replies', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  const blocked = h.runs.get('run-1')!
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom', attempts: [...blocked.attempts, blockedWith([], { number: 2, endedAt: 3 })] }))
  expect(h.store.get(parked.id)).toMatchObject({ state: 'failed', error: 'boom', questions: [] })
  expect(await h.engine.checkReplies()).toEqual({ checked: 0, resumed: 0 })
})

test('two reply checks at once resume the item once', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  h.answer(async () => reply('r1', 'The login page'))
  const [first, second] = await Promise.all([h.engine.checkReplies(), h.engine.checkReplies()])
  expect(first.resumed + second.resumed).toBe(1)
  expect(h.store.get(parked.id)).toMatchObject({ state: 'building', runIds: ['run-1', 'run-2'], lastSeenId: 'r1' })
  expect(h.store.get(parked.id)!.answerPaths).toHaveLength(1)
  expect(h.started).toHaveLength(2)
})

test('a reply read for an item removed meanwhile is dropped', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { entered = resolve })
  h.answer(async () => { entered(); await gate; return reply('r1', 'The login page') })
  const checking = h.engine.checkReplies()
  await reading
  await h.engine.remove(parked.id)
  release()
  expect(await checking).toEqual({ checked: 1, resumed: 0 })
  expect(h.store.list()).toEqual([])
  expect(h.started).toHaveLength(1)
})

test('a reply with empty text still counts as an answer', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  h.answer(async () => reply('r1', ''))
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
  expect(await readFile(h.store.get(parked.id)!.answerPaths[0]!, 'utf8')).toContain('### Ploy\n\n')
})

test('a reply image given as an absolute path outside the plugin folder is skipped', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  await writeFile(join(dir, 'secret'), 'do not copy')
  h.answer(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'shot.png', path: join(dir, 'secret') }] }], lastId: 'r1' }))
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
    expect(errors).toHaveBeenCalledTimes(1)
  } finally { errors.mockRestore() }
  const worktree = h.store.get(parked.id)!.worktree!
  expect(existsSync(join(worktree, '.shikidan', 'queue', 'clickup-board', 'r1-0-shot.png'))).toBe(false)
})

test('a malformed-reply failure from the source keeps the item waiting with its cursor', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  h.answer(async () => { throw new Error('clickup-board returned an unexpected source.replies result') })
  for (let i = 0; i < 4; i += 1) expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 0 })
  expect(h.store.get(parked.id)).toMatchObject({ state: 'waiting-info', lastSeenId: 'c1', answerPaths: [] })
  expect(h.alerts.filter(alert => alert.reason.startsWith('Could not read replies'))).toEqual([{ title: 'Task 1', reason: 'Could not read replies: clickup-board returned an unexpected source.replies result', state: 'waiting-info' }])
})

test('replies without a cursor count as a failed read and are never applied', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  h.answer(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [] }], lastId: null }))
  for (let i = 0; i < 3; i += 1) expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 0 })
  expect(h.store.get(parked.id)).toMatchObject({ state: 'waiting-info', lastSeenId: 'c1', answerPaths: [] })
  expect(h.started).toHaveLength(1)
  expect(h.alerts.filter(alert => alert.reason.startsWith('Could not read replies'))).toEqual([{ title: 'Task 1', reason: 'Could not read replies: clickup-board returned replies without a lastId', state: 'waiting-info' }])
})

test('two items with the same title and id from different sources get their own worktrees', async () => {
  const h = harness()
  const first = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  const second = await h.engine.add({ ...add, source: 'other-board' })
  expect(h.store.get(second.id)!.worktree).not.toBe(h.store.get(first.id)!.worktree)
})

test('restart: a queued item is built by recover', async () => {
  const h = harness()
  await h.store.add({ source: 'clickup-board', externalId: '1', title: 'Task 1', url: 'u', repo: '/repo', flowId: null }, 'end')
  const after = h.restart()
  await after.engine.recover()
  expect(states(after.store.list())).toEqual(['1:building'])
  expect(h.started).toHaveLength(1)
})

test('restart: a building item whose run asked questions while MC was down posts them and parks', async () => {
  const h = harness()
  await h.engine.add(add)
  h.settle('run-1', { status: 'blocked', attempts: [blockedWith(['biz: Which page?'])] })
  const after = h.restart()
  await after.engine.recover()
  expect(h.posted).toEqual([{ id: '1', kind: 'ask', lines: ['Which page?'] }])
  expect(after.store.list()[0]).toMatchObject({ state: 'waiting-info', questions: ['Which page?'], lastSeenId: 'c1' })
})

test('restart: a building item whose run was stopped while MC was down fails', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  h.settle('run-1', { status: 'stopped', error: null })
  const after = h.restart()
  await after.engine.recover()
  expect(states(after.store.list())).toEqual(['1:failed', '2:building'])
})

test('restart: a waiting item reads replies from its saved cursor and resumes', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  h.answer(async () => reply('r1', 'The login page'))
  const after = h.restart()
  await after.engine.recover()
  expect(await after.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
  expect(h.sinceIds).toEqual(['c1'])
  expect(after.store.get(parked.id)).toMatchObject({ state: 'building', lastSeenId: 'r1', runIds: ['run-1', 'run-2'] })
})

test('restart: ready and failed items are left as they are', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  await h.engine.onRunSettled(h.settle('run-2', { status: 'failed', error: 'boom' }))
  const alerts = h.alerts.length
  const after = h.restart()
  await after.engine.recover()
  expect(after.store.list().map(item => [item.state, item.error])).toEqual([['ready', null], ['failed', 'boom']])
  expect(h.started).toHaveLength(2)
  expect(h.alerts).toHaveLength(alerts)
})

test('restart: a Studio retry of a failed item that settles after the restart still updates it', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  const after = h.restart()
  await after.engine.recover()
  await after.engine.onRunSettled(h.settle('run-1', { status: 'done', error: null, attempts: [blockedWith([], { endedAt: 9 })] }))
  expect(after.store.list()[0]).toMatchObject({ state: 'ready', error: null })
})
