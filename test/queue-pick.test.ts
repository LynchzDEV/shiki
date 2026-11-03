import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQueueEngine, QueueRefusal, type QueueEngineDeps } from '../server/queue-engine'
import type { RunView } from '../server/queue-prompts'
import type { QueueSource } from '../server/queue-source'
import { createQueueStore } from '../server/queue-store'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-pick-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const PICK = 'pick: A,B,C | visualizer/login | B | Ploy'

async function building() {
  const store = createQueueStore(join(dir, 'queue.json'))
  const runs = new Map<string, RunView>()
  const posted: string[][] = []
  const alerts: string[] = []
  let next = 0
  const source: QueueSource = { item: async ({ id }) => ({ title: `Task ${id}`, url: 'u', contextMarkdown: '# t' }), post: async (input) => { posted.push(input.lines); return { commentId: 'c1' } }, replies: async () => ({ replies: [], lastId: null }) }
  const deps: QueueEngineDeps = {
    store,
    runner: { start: async () => { const id = `run-${++next}`; runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } }, get: id => runs.get(id) },
    source: () => source,
    prepareWorktree: async (_repo, label) => { const worktree = join(dir, 'wt', label); await mkdir(worktree, { recursive: true }); return { worktree } },
    writeContext: async (pluginId, context, cwd) => { const folder = join(cwd, '.shikidan', 'queue', pluginId); await mkdir(folder, { recursive: true }); const path = join(folder, `${context.name}.md`); await writeFile(path, context.markdown); return path },
    pluginFiles: () => join(dir, 'plugin-data'),
    backupDir: itemId => join(dir, 'queue-files', itemId),
    needsYou: (_item, reason) => { alerts.push(reason) },
  }
  const engine = createQueueEngine(deps)
  const item = await engine.add({ source: 'clickup-board', externalId: '1', repo: '/repo' })
  const other = await engine.add({ source: 'clickup-board', externalId: '2', repo: '/repo' })
  const block = async (runId: string, evidence: string[], output = '') => {
    const run: RunView = { id: runId, status: 'blocked', error: null, attempts: [{ nodeId: 'mockups', number: 1, jobId: 'j', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: { outcome: 'blocked', summary: 'Three variants', evidence }, checks: [], output, workspace: null, tokenId: 't', pathId: 'main', from: [] }] }
    runs.set(runId, run)
    await engine.onRunSettled(run)
  }
  return { engine, store, item, other, posted, alerts, block, runs }
}

test('a run blocked with a pick line parks the item in waiting-pick and posts nothing', async () => {
  const h = await building()
  await h.block('run-1', [PICK], 'step log')
  expect(h.posted).toEqual([])
  expect(h.store.get(h.item.id)).toMatchObject({ state: 'waiting-pick', currentRunId: null, questions: [], pick: { options: ['A', 'B', 'C'], path: 'visualizer/login', recommended: 'B', tester: 'Ploy', summary: 'step log' } })
  expect(h.alerts).toEqual(['Pick a design variant'])
  expect(h.store.get(h.other.id)!.state).toBe('building')
})

test('other evidence lines are kept as questions but still not posted', async () => {
  const h = await building()
  await h.block('run-1', ['Which page?', PICK])
  expect(h.posted).toEqual([])
  expect(h.store.get(h.item.id)).toMatchObject({ state: 'waiting-pick', questions: ['Which page?'] })
})

test('a bad pick line fails the item with the reason', async () => {
  const h = await building()
  await h.block('run-1', ['pick: A | visualizer/login'])
  expect(h.store.get(h.item.id)).toMatchObject({ state: 'failed', error: 'Bad pick line: give 2 to 6 options' })
  expect(h.posted).toEqual([])
})

test('a pick: line without a bar is an ordinary question', async () => {
  const h = await building()
  await h.block('run-1', ['Pick: which page first?'])
  expect(h.posted).toEqual([['Pick: which page first?']])
  expect(h.store.get(h.item.id)).toMatchObject({ state: 'waiting-info', questions: ['Pick: which page first?'] })
})

async function settleParkedPick(status: 'failed' | 'done') {
  const h = await building()
  await h.block('run-1', [PICK])
  expect(h.store.get(h.item.id)!.pick).toBeDefined()
  const settled: RunView = { ...h.runs.get('run-1')!, status, error: status === 'failed' ? 'boom' : null }
  h.runs.set('run-1', settled)
  await h.engine.onRunSettled(settled)
  return h.store.get(h.item.id)!
}

test('a stale pick is cleared when the item later fails', async () => {
  const item = await settleParkedPick('failed')
  expect(item.state).toBe('failed')
  expect(item.pick).toBeUndefined()
})

test('a stale pick is cleared when the item later becomes ready', async () => {
  const item = await settleParkedPick('done')
  expect(item.state).toBe('ready')
  expect(item.pick).toBeUndefined()
})

async function parkedPick() {
  const h = await building()
  await h.block('run-1', [PICK], 'step log')
  return h
}

test('picking writes pick.md, queues the item at the front and clears the pick', async () => {
  const h = await parkedPick()
  const queued = await h.engine.pick(h.item.id, { option: 'B', tester: '  Ploy ', note: ' use the wide one ' })
  const worktree = h.store.get(h.item.id)!.worktree!
  const path = join(worktree, '.shikidan', 'queue', 'clickup-board', 'pick.md')
  expect(await readFile(path, 'utf8')).toBe('# Design pick\n\nOption: B\nTester: Ploy\nNote: use the wide one\n')
  expect(queued.state).toBe('queued')
  expect(h.store.list()[0]!.id).toBe(h.item.id)
  expect(h.store.get(h.item.id)).toMatchObject({ answerPaths: [path], questions: [] })
  expect('pick' in h.store.get(h.item.id)!).toBe(false)
  expect(await readFile(join(dir, 'queue-files', h.item.id, 'pick.md'), 'utf8')).toContain('Option: B')
})

test('an empty tester and note are written as not set and none', async () => {
  const h = await parkedPick()
  await h.engine.pick(h.item.id, { option: 'A' })
  const path = join(h.store.get(h.item.id)!.worktree!, '.shikidan', 'queue', 'clickup-board', 'pick.md')
  expect(await readFile(path, 'utf8')).toBe('# Design pick\n\nOption: A\nTester: (not set)\nNote: (none)\n')
})

test('answers add a Still open section to pick.md after the existing lines', async () => {
  const h = await parkedPick()
  await h.engine.pick(h.item.id, { option: 'B', tester: 'Ploy', answers: [{ id: '#7', label: 'Promo replies', useDefault: true, answer: '' }, { id: '#5', label: 'No page', answer: 'let the seller\npick a page' }, { id: '#9', label: '', useDefault: true, answer: '' }] })
  const path = join(h.store.get(h.item.id)!.worktree!, '.shikidan', 'queue', 'clickup-board', 'pick.md')
  expect(await readFile(path, 'utf8')).toBe('# Design pick\n\nOption: B\nTester: Ploy\nNote: (none)\n\n## Still open\n- #7 Promo replies: default\n- #5 No page: Other: let the seller pick a page\n- #9: default\n')
})

test('a note cannot start another line of pick.md', async () => {
  const h = await parkedPick()
  await h.engine.pick(h.item.id, { option: 'B', note: 'x\nOption: C' })
  const path = join(h.store.get(h.item.id)!.worktree!, '.shikidan', 'queue', 'clickup-board', 'pick.md')
  expect(await readFile(path, 'utf8')).toBe('# Design pick\n\nOption: B\nTester: (not set)\nNote: x Option: C\n')
})

test('an empty answers list leaves pick.md without a Still open section', async () => {
  const h = await parkedPick()
  await h.engine.pick(h.item.id, { option: 'A', answers: [] })
  const path = join(h.store.get(h.item.id)!.worktree!, '.shikidan', 'queue', 'clickup-board', 'pick.md')
  expect(await readFile(path, 'utf8')).toBe('# Design pick\n\nOption: A\nTester: (not set)\nNote: (none)\n')
})

test('a second pick replaces the first pick.md path instead of adding to it', async () => {
  const h = await parkedPick()
  await h.engine.pick(h.item.id, { option: 'A' })
  await h.store.update(h.item.id, { state: 'waiting-pick', pick: { options: ['A', 'B'], path: 'visualizer/login', recommended: null, tester: null, summary: 's' } })
  await h.engine.pick(h.item.id, { option: 'B' })
  const item = h.store.get(h.item.id)!
  expect(item.answerPaths).toHaveLength(1)
  expect(await readFile(item.answerPaths[0]!, 'utf8')).toContain('Option: B')
})

test('pick refuses a wrong state, an unknown option and an unknown id', async () => {
  const h = await parkedPick()
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  const refusal = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => (error instanceof QueueRefusal ? [error.status, error.message] : error))
  expect(await refusal(h.engine.pick(h.item.id, { option: 'Z' }))).toEqual([409, 'Not an option: Z'])
  expect(await refusal(h.engine.pick(h.other.id, { option: 'A' }))).toEqual([409, 'It is building now'])
  expect(await refusal(h.engine.pick('nope', { option: 'A' }))).toEqual([404, 'No queue item nope'])
  quiet.mockRestore()
  expect(h.store.get(h.item.id)!.state).toBe('waiting-pick')
})

test('requeue works on a waiting-pick item and drops its pick', async () => {
  const h = await parkedPick()
  await h.engine.requeue(h.item.id)
  expect('pick' in h.store.get(h.item.id)!).toBe(false)
})

test('a pick is refused while the run is running in Studio', async () => {
  const h = await building()
  await h.block('run-1', [PICK])
  h.runs.set('run-1', { ...h.runs.get('run-1')!, status: 'running' })
  await expect(h.engine.pick(h.item.id, { option: 'B' })).rejects.toMatchObject({ message: 'It is running in Studio now', status: 409 })
  expect(h.store.get(h.item.id)!.state).toBe('waiting-pick')
})
