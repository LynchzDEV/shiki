import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import { createQueueEngine, QueueRefusal, SourceFailure, type QueueEngine } from '../server/queue-engine'
import { createQueueStore } from '../server/queue-store'
import { queueRoutes } from '../server/routes/queue'

const store = () => createQueueStore(join(mkdtempSync(join(tmpdir(), 'mc-queue-routes-')), 'queue.json'))
type App = { handle(request: Request): Promise<Response> }
const call = (app: App, path: string, init: RequestInit = {}) => app.handle(new Request(`http://127.0.0.1:7777${path}`, { ...init, headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' } }))
const post = (app: App, path: string, body: unknown = {}) => call(app, path, { method: 'POST', body: JSON.stringify(body) })
const newItem = { source: 'clickup-board', externalId: '1', title: 'Task 1', url: 'u', repo: '/repo', flowId: null }

let repo: string
let plain: string
beforeAll(async () => {
  repo = await mkdtemp(join(homedir(), 'mc-queue-routes-repo-'))
  plain = await mkdtemp(join(homedir(), 'mc-queue-routes-plain-'))
  if (Bun.spawnSync(['git', 'init', '-q', repo]).exitCode !== 0) throw new Error('git init failed')
  await symlink(repo, join(plain, 'link'))
})
afterAll(async () => {
  await rm(repo, { recursive: true, force: true })
  await rm(plain, { recursive: true, force: true })
})

type Engine = Pick<QueueEngine, 'add' | 'requeue' | 'pick' | 'checkReplies' | 'remove' | 'move' | 'checkedAt' | 'subscribeChecks'>
type RunLookup = NonNullable<Parameters<typeof queueRoutes>[3]>

function engine(items: ReturnType<typeof store>, over: Partial<QueueEngine> = {}): Engine {
  const found = (id: string) => { const item = items.get(id); if (item === undefined) throw new QueueRefusal(`No queue item ${id}`, 404); return item }
  return {
    add: async input => items.add({ ...newItem, externalId: input.externalId, repo: input.repo, flowId: input.flowId ?? null }, input.position ?? 'end'),
    requeue: async id => items.update(id, { state: 'queued' }),
    pick: async (id, choice) => { if (found(id).state !== 'waiting-pick') throw new QueueRefusal('It is queued now', 409); return items.update(id, { state: 'queued', questions: [choice.option, choice.tester ?? '', choice.note ?? ''] }) },
    checkReplies: async () => ({ checked: 2, resumed: 1 }),
    remove: async id => { if (found(id).state === 'building') throw new QueueRefusal('It is building now', 409); await items.remove(id) },
    move: async (id, to) => { found(id); await items.move(id, to) },
    checkedAt: () => null,
    subscribeChecks: () => () => {},
    ...over,
  }
}

test('GET lists items; POST adds through the engine', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const added = await post(app, '/api/queue', { source: 'clickup-board', externalId: '7', repo: join(plain, 'link'), position: 'next' })
  expect(added.status).toBe(200)
  expect((await added.json()).item).toMatchObject({ externalId: '7', repo: await realpath(repo) })
  expect((await (await call(app, '/api/queue')).json()).items).toHaveLength(1)
})

test('POST rejects a bad body and reports a source failure as 502', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items, { add: async () => { throw new SourceFailure('clickup-board is not installed') } })))
  expect((await post(app, '/api/queue', { source: '', externalId: '1', repo: '/repo' })).status).toBe(400)
  expect((await post(app, '/api/queue', { source: 'x', externalId: '1', repo: '/repo', position: 'top' })).status).toBe(400)
  const failed = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo })
  expect(failed.status).toBe(502)
  expect((await failed.json()).error).toBe('clickup-board is not installed')
})

test('POST refuses a repo that is missing, not git, or outside home before the engine sees it', async () => {
  const items = store()
  let calls = 0
  const app = new Elysia().use(queueRoutes(items, engine(items, { add: async () => { calls += 1; throw new Error('unreachable') } })))
  const cases: Array<[string, string]> = [[plain, 'cwd is not a git repository'], [join(repo, 'missing'), 'cwd does not exist'], [tmpdir(), 'cwd must be under $HOME']]
  for (const [dir, error] of cases) {
    const refused = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo: dir })
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toBe(error)
  }
  expect(calls).toBe(0)
})

test('POST maps an item already in the queue to 409', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items, { add: async () => { throw new QueueRefusal('Already in the queue', 409) } })))
  const twice = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo })
  expect(twice.status).toBe(409)
  expect((await twice.json()).error).toBe('Already in the queue')
})

test('delete and move go through the engine so they wait for a build in progress', async () => {
  const items = store()
  const a = await items.add(newItem, 'end')
  const seen: string[] = []
  const app = new Elysia().use(queueRoutes(items, engine(items, {
    remove: async id => { seen.push(`remove ${id}`); throw new QueueRefusal('It is building now', 409) },
    move: async (id, to) => { seen.push(`move ${id} ${to}`) },
  })))
  const removing = await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })
  expect(removing.status).toBe(409)
  expect((await removing.json()).error).toBe('Stop its run in Studio first')
  expect((await post(app, `/api/queue/${a.id}/move`, { to: 3 })).status).toBe(200)
  expect(seen).toEqual([`remove ${a.id}`, `move ${a.id} 3`])
  expect(items.get(a.id)!.state).toBe('queued')
})

test('move refuses an item that is not queued with 409 and says why', async () => {
  const items = store()
  const a = await items.add(newItem, 'end')
  const app = new Elysia().use(queueRoutes(items, engine(items, { move: async () => { throw new QueueRefusal('It is building now', 409) } })))
  const refused = await post(app, `/api/queue/${a.id}/move`, { to: 0 })
  expect(refused.status).toBe(409)
  expect((await refused.json()).error).toBe('It is building now')
})

test('check returns the engine counts', async () => {
  const items = store()
  expect(await (await post(new Elysia().use(queueRoutes(items, engine(items))), '/api/queue/check')).json()).toEqual({ checked: 2, resumed: 1 })
})

test('move reorders and 404s an unknown id', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  await items.add(newItem, 'end')
  const b = await items.add({ ...newItem, externalId: '2' }, 'end')
  const moved = await post(app, `/api/queue/${b.id}/move`, { to: 0 })
  expect((await moved.json()).items.map((item: { externalId: string }) => item.externalId)).toEqual(['2', '1'])
  expect((await post(app, '/api/queue/nope/move', { to: 0 })).status).toBe(404)
  expect((await post(app, `/api/queue/${b.id}/move`, { to: -1 })).status).toBe(400)
})

test('delete and requeue refuse a building item and 404 unknown ids', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const a = await items.add(newItem, 'end')
  await items.update(a.id, { state: 'building' })
  expect((await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(409)
  expect((await post(app, `/api/queue/${a.id}/requeue`)).status).toBe(409)
  await items.update(a.id, { state: 'failed' })
  expect((await post(app, `/api/queue/${a.id}/requeue`)).status).toBe(200)
  expect((await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(200)
  expect((await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(404)
})

test('requeue maps the engine refusals to 404 and 409 and rethrows anything else', async () => {
  const items = store()
  const a = await items.add(newItem, 'end')
  const refusing = (error: Error) => new Elysia().use(queueRoutes(items, engine(items, { requeue: async () => { throw error } })))
  const busy = await post(refusing(new QueueRefusal('It is queued now', 409)), `/api/queue/${a.id}/requeue`)
  expect(busy.status).toBe(409)
  expect((await busy.json()).error).toBe('It is queued now')
  const gone = await post(refusing(new QueueRefusal(`No queue item ${a.id}`, 404)), `/api/queue/${a.id}/requeue`)
  expect(gone.status).toBe(404)
  expect((await gone.json()).error).toBe(`No queue item ${a.id}`)
  expect((await post(refusing(new Error('disk full')), `/api/queue/${a.id}/requeue`)).status).toBe(500)
  expect((await post(refusing(new Error(`No queue item ${a.id}`)), `/api/queue/${a.id}/requeue`)).status).toBe(500)
  expect((await post(refusing(new Error('It is broken')), `/api/queue/${a.id}/requeue`)).status).toBe(500)
})

test('a request from another site is refused', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const response = await app.handle(new Request('http://127.0.0.1:7777/api/queue', { headers: { host: 'evil.example' } }))
  expect(response.status).toBe(403)
})

test('GET tree returns what the tree source builds', async () => {
  const items = store()
  const tree = { repos: [{ repo: '/repo', base: { branch: 'main', commits: [{ sha: 'abc1234', subject: 'Base' }] }, lanes: [] }] }
  const app = new Elysia().use(queueRoutes(items, engine(items), async () => tree))
  const response = await call(app, '/api/queue/tree')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(tree)
})

test('POST reports a source error that reads like a refusal as 502', async () => {
  const items = store()
  for (const text of ['It is broken', 'No queue item here', 'Already in the queue']) {
    const app = new Elysia().use(queueRoutes(items, engine(items, { add: async () => { throw new SourceFailure(text) } })))
    const failed = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo })
    expect(failed.status).toBe(502)
    expect((await failed.json()).error).toBe(text)
  }
})

test('move and delete map only engine refusals to 404 and 409', async () => {
  const items = store()
  const a = await items.add(newItem, 'end')
  const app = (error: Error) => new Elysia().use(queueRoutes(items, engine(items, { move: async () => { throw error }, remove: async () => { throw error } })))
  const gone = await post(app(new QueueRefusal(`No queue item ${a.id}`, 404)), `/api/queue/${a.id}/move`, { to: 0 })
  expect(gone.status).toBe(404)
  expect((await gone.json()).error).toBe('No such queue item')
  expect((await post(app(new Error('It is broken')), `/api/queue/${a.id}/move`, { to: 0 })).status).toBe(500)
  expect((await call(app(new Error('It is building now')), `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(500)
  expect((await call(app(new QueueRefusal(`No queue item ${a.id}`, 404)), `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(404)
})

test('GET says when replies were last checked, or null before the first check', async () => {
  const items = store()
  let checkedAt: number | null = null
  const app = new Elysia().use(queueRoutes(items, engine(items, { checkedAt: () => checkedAt })))
  expect(await (await call(app, '/api/queue')).json()).toEqual({ items: [], checkedAt: null })
  checkedAt = 1_700_000_000_000
  expect(await (await call(app, '/api/queue')).json()).toEqual({ items: [], checkedAt: 1_700_000_000_000 })
})

test('the stream sends checkedAt and sends again when a check finishes with no item changes', async () => {
  const items = store()
  let checkedAt: number | null = null
  const listeners = new Set<() => void>()
  const app = new Elysia().use(queueRoutes(items, engine(items, {
    checkedAt: () => checkedAt,
    subscribeChecks: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })))
  const aborting = new AbortController()
  const response = await app.handle(new Request('http://127.0.0.1:7777/api/queue/stream', { headers: { host: '127.0.0.1:7777' }, signal: aborting.signal }))
  const reader = response.body!.getReader()
  const nextData = async (): Promise<unknown> => JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: /, '').trim())
  expect(await nextData()).toEqual({ items: [], checkedAt: null })
  checkedAt = 42
  for (const listener of listeners) listener()
  expect(await nextData()).toEqual({ items: [], checkedAt: 42 })
  aborting.abort()
  await reader.cancel()
  expect(listeners.size).toBe(0)
})

test('POST maps an unexpected local failure to 500, not a source error', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items, { add: async () => { throw new Error('disk full') } })))
  const failed = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo })
  expect(failed.status).toBe(500)
})

function realEngine(items: ReturnType<typeof store>) {
  const runs = new Map<string, { id: string; status: 'running' | 'done'; error: null; attempts: [] }>()
  let next = 0
  return createQueueEngine({
    store: items,
    runner: { start: async () => { const id = `run-${++next}`; runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } }, get: id => runs.get(id) },
    source: () => ({ item: async ({ id }) => ({ title: `Task ${id}`, url: 'u', contextMarkdown: '# t' }), post: async () => ({ commentId: 'c1' }), replies: async () => ({ replies: [], lastId: null }) }),
    prepareWorktree: async (_repo, label) => ({ worktree: join(repo, '.worktree', label) }),
    writeContext: async (_pluginId, context, cwd) => join(cwd, `${context.name}.md`),
    pluginFiles: () => repo,
    backupDir: itemId => join(repo, 'queue-files', itemId),
    needsYou: () => {},
  })
}

test('with the real engine: add builds, a queued item cannot be requeued, and a queued item can be removed', async () => {
  const items = store()
  const engine = realEngine(items)
  const app = new Elysia().use(queueRoutes(items, engine))
  const first = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo })
  expect((await first.json()).item).toMatchObject({ state: 'queued', title: 'Task 1' })
  await engine.kick()
  expect(items.list()[0]!.state).toBe('building')
  const second = (await (await post(app, '/api/queue', { source: 'clickup-board', externalId: '2', repo })).json()).item
  expect(second.state).toBe('queued')
  const twice = await post(app, '/api/queue', { source: 'clickup-board', externalId: '2', repo })
  expect(twice.status).toBe(409)
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const requeued = await post(app, `/api/queue/${second.id}/requeue`)
    expect(requeued.status).toBe(409)
    expect((await requeued.json()).error).toBe('It is queued now')
    expect((await call(app, `/api/queue/${items.list()[0]!.id}`, { method: 'DELETE' })).status).toBe(409)
  } finally { quiet.mockRestore() }
  expect((await call(app, `/api/queue/${second.id}`, { method: 'DELETE' })).status).toBe(200)
  expect(items.list().map(item => item.externalId)).toEqual(['1'])
  expect(await (await post(app, '/api/queue/check')).json()).toEqual({ checked: 0, resumed: 0 })
})

test('move refuses a position that is not a whole number', async () => {
  const items = store()
  const a = await items.add(newItem, 'end')
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  for (const to of [1.5, '1', null]) expect((await post(app, `/api/queue/${a.id}/move`, { to })).status).toBe(400)
})

test('POST asks the engine to build in the background so adding returns at once', async () => {
  const items = store()
  const options: unknown[] = []
  const app = new Elysia().use(queueRoutes(items, engine(items, { add: async (input, given) => { options.push(given); return items.add({ ...newItem, externalId: input.externalId }, 'end') } })))
  expect((await post(app, '/api/queue', { source: 'clickup-board', externalId: '7', repo })).status).toBe(200)
  expect(options).toEqual([{ background: true }])
})

const runWith = (currentNodeId: string, nodeIds: string[]) => ({ workflow: { nodes: [{ id: 'plan', title: 'Plan', maxVisits: 3 }, { id: 'execute', title: 'Execute', maxVisits: 4 }] }, currentNodeId, attempts: nodeIds.map(nodeId => ({ nodeId })) })

test('a building item carries its run step; other items do not', async () => {
  const items = store()
  const building = await items.add(newItem, 'end')
  await items.update(building.id, { state: 'building', currentRunId: 'run-1', runIds: ['run-1'] })
  await items.add({ ...newItem, externalId: '2' }, 'end')
  const runs: RunLookup = { get: id => (id === 'run-1' ? runWith('execute', ['plan', 'execute', 'execute']) : undefined) as ReturnType<RunLookup['get']>, subscribe: () => () => {} }
  const app = new Elysia().use(queueRoutes(items, engine(items), undefined, runs))
  const listed = (await (await call(app, '/api/queue')).json()).items as Array<{ externalId: string; step?: unknown }>
  expect(listed[0]!.step).toEqual({ title: 'Execute', attempt: 2, maxAttempts: 4 })
  expect(listed[1]!.step).toBeUndefined()
})

test('the queue stream sends a new snapshot when the run moves to its next step', async () => {
  const items = store()
  const building = await items.add(newItem, 'end')
  await items.update(building.id, { state: 'building', currentRunId: 'run-1', runIds: ['run-1'] })
  let current = runWith('plan', ['plan'])
  const listeners = new Set<() => void>()
  const runs: RunLookup = { get: () => current as ReturnType<RunLookup['get']>, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const app = new Elysia().use(queueRoutes(items, engine(items), undefined, runs))
  const aborter = new AbortController()
  const response = await app.handle(new Request('http://127.0.0.1:7777/api/queue/stream', { headers: { host: '127.0.0.1:7777' }, signal: aborter.signal }))
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const next = async () => decoder.decode((await reader.read()).value)
  expect(await next()).toContain('"title":"Plan"')
  current = runWith('execute', ['plan', 'execute'])
  for (const listener of listeners) listener()
  expect(await next()).toContain('"title":"Execute"')
  aborter.abort()
})

test('a queued item whose workspace is being prepared is marked preparing', async () => {
  const items = store()
  const a = await items.add(newItem, 'end')
  await items.add({ ...newItem, externalId: '2' }, 'end')
  const app = new Elysia().use(queueRoutes(items, { ...engine(items), preparing: () => a.id }))
  const listed = (await (await call(app, '/api/queue')).json()).items as Array<{ externalId: string; preparing?: boolean }>
  expect(listed.map(entry => entry.preparing)).toEqual([true, undefined])
})

test('POST pick hands the choice to the engine and maps refusals', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const parked = await items.add(newItem, 'end')
  expect((await post(app, `/api/queue/${parked.id}/pick`, { option: 'B' })).status).toBe(409)
  await items.update(parked.id, { state: 'waiting-pick' })
  const picked = await post(app, `/api/queue/${parked.id}/pick`, { option: 'B', tester: 'Ploy', note: 'wide' })
  expect(picked.status).toBe(200)
  expect((await picked.json()).item).toMatchObject({ state: 'queued', questions: ['B', 'Ploy', 'wide'] })
  expect((await post(app, '/api/queue/nope/pick', { option: 'B' })).status).toBe(404)
  expect((await post(app, `/api/queue/${parked.id}/pick`, {})).status).toBe(400)
  expect((await post(app, `/api/queue/${parked.id}/pick`, { option: 'B', note: 'x'.repeat(4001) })).status).toBe(400)
})

test('queue items sent to the client carry a cleaned pick summary', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const parked = await items.add(newItem, 'end')
  const dirty = 'Intro line.\n\n## Points\n\nbody\n\nSKD_RESULT {"outcome":"blocked","summary":"Intro line.","evidence":[]}'
  await items.update(parked.id, { state: 'waiting-pick', pick: { options: ['A', 'B'], path: 'visualizer/x', recommended: null, tester: null, summary: dirty } })
  const listed = (await (await call(app, '/api/queue')).json()).items as Array<{ pick: { summary: string } }>
  expect(listed[0]!.pick.summary).toBe('## Points\n\nbody')
  expect(items.get(parked.id)!.pick!.summary).toBe(dirty)
})

test('POST pick accepts answers and refuses too many, a long id or an empty answer', async () => {
  const items = store()
  let seen: unknown
  const app = new Elysia().use(queueRoutes(items, engine(items, { pick: async (id, choice) => { seen = choice.answers; return items.update(id, { state: 'queued' }) } })))
  const parked = await items.add(newItem, 'end')
  await items.update(parked.id, { state: 'waiting-pick' })
  const url = `/api/queue/${parked.id}/pick`
  const entry = (n: number) => ({ id: `#${n}`, label: 'Label', useDefault: true, answer: '' })
  expect((await post(app, url, { option: 'B', answers: [{ id: '#7', label: '', answer: 'x' }] })).status).toBe(200)
  expect(seen).toEqual([{ id: '#7', label: '', answer: 'x' }])
  expect((await post(app, url, { option: 'B', answers: Array.from({ length: 21 }, (_, n) => entry(n)) })).status).toBe(400)
  expect((await post(app, url, { option: 'B', answers: [{ ...entry(1), id: 'x'.repeat(17) }] })).status).toBe(400)
  expect((await post(app, url, { option: 'B', answers: [{ ...entry(1), useDefault: false, answer: '' }] })).status).toBe(400)
  expect((await post(app, url, { option: 'B', answers: [{ ...entry(1), answer: 'x'.repeat(1001) }] })).status).toBe(400)
  expect((await post(app, url, { option: 'B', answers: [{ ...entry(1), id: 'a\nb' }] })).status).toBe(400)
  expect((await post(app, url, { option: 'B', answers: [{ ...entry(1), label: 'a\rb' }] })).status).toBe(400)
  expect((await post(app, url, { option: 'B', tester: 'Ploy\nOption: C' })).status).toBe(400)
  expect((await post(app, url, { option: 'B', answers: [{ ...entry(1), label: 'x'.repeat(201) }] })).status).toBe(400)
})

describe('mockup files', () => {
  let tree: string
  let outside: string
  beforeAll(async () => {
    tree = await mkdtemp(join(tmpdir(), 'mc-queue-mock-'))
    outside = await mkdtemp(join(tmpdir(), 'mc-queue-out-'))
    await mkdir(join(tree, 'visualizer', 'demo'), { recursive: true })
    await writeFile(join(tree, 'visualizer', 'demo', 'index.html'), '<h1>demo</h1>')
    await writeFile(join(tree, 'visualizer', 'demo', 'a.css'), 'h1{}')
    await writeFile(join(tree, 'visualizer', 'demo', 'blob.bin'), 'x')
    await writeFile(join(tree, 'visualizer', 'demo', 'a b.html'), '<p>spaced</p>')
    await mkdir(join(tree, 'visualizer', 'หน้าแรก'), { recursive: true })
    await writeFile(join(tree, 'visualizer', 'หน้าแรก', 'index.html'), '<p>thai</p>')
    await writeFile(join(tree, 'visualizer', 'demo', '.secret'), 'no')
    await writeFile(join(tree, 'secret.txt'), 'no')
    await writeFile(join(outside, 'loot.txt'), 'no')
    await symlink(join(outside, 'loot.txt'), join(tree, 'visualizer', 'demo', 'file-link.txt'))
    await symlink(outside, join(tree, 'visualizer', 'dir-link'))
  })
  afterAll(async () => {
    await rm(tree, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  async function files(path: string, over: { worktree?: string | null } = {}) {
    const items = store()
    const item = await items.add(newItem, 'end')
    await items.update(item.id, { worktree: over.worktree === undefined ? tree : over.worktree })
    return call(new Elysia().use(queueRoutes(items, engine(items))), `/queue/${path.replace('{id}', item.id)}`)
  }
  const sealed = (response: Response) => {
    expect(response.headers.get('content-security-policy')).toBe('sandbox allow-scripts')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  }

  test('serves a file with its type, sandbox policy and nosniff', async () => {
    const html = await files('{id}/files/demo/index.html')
    expect(html.status).toBe(200)
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await html.text()).toBe('<h1>demo</h1>')
    sealed(html)
    expect((await files('{id}/files/demo/a.css')).headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect((await files('{id}/files/demo/blob.bin')).headers.get('content-type')).toBe('application/octet-stream')
  })

  test('names with spaces or Thai letters are served, bad encodings are 404', async () => {
    expect(await (await files('{id}/files/demo/a%20b.html')).text()).toBe('<p>spaced</p>')
    expect(await (await files(`{id}/files/${encodeURIComponent('หน้าแรก')}/index.html`)).text()).toBe('<p>thai</p>')
    expect((await files('{id}/files/demo/%E0%A4%A.html')).status).toBe(404)
  })

  test('an encoded slash cannot smuggle a dotfile past the segment checks', async () => {
    expect((await files('{id}/files/demo%2F.secret')).status).toBe(404)
    expect((await files('{id}/files/demo%2Fa.css')).status).toBe(404)
  })

  test('answers 404, still sealed, for everything it refuses', async () => {
    const refused = [
      '{id}/files/demo/missing.html', '{id}/files/demo', '{id}/files/%2e%2e/secret.txt', '{id}/files/demo/%2e%2e/%2e%2e/secret.txt',
      '{id}/files/demo/file-link.txt', '{id}/files/dir-link/loot.txt', '{id}/files/demo/.secret', '{id}/files/demo/..%2f..%2fsecret.txt',
    ]
    for (const path of refused) {
      const response = await files(path)
      expect([path, response.status]).toEqual([path, 404])
      if (!path.includes('%2e%2e/')) sealed(response)
    }
  })

  test('a sandboxed mockup frame can load its own assets cross-site, but the queue api stays closed to it', async () => {
    const items = store()
    const item = await items.add(newItem, 'end')
    await items.update(item.id, { worktree: tree })
    const app = new Elysia().use(queueRoutes(items, engine(items)))
    const crossSite = (path: string) => app.handle(new Request(`http://127.0.0.1:7777${path}`, { headers: { host: '127.0.0.1:7777', 'sec-fetch-site': 'cross-site' } }))
    expect((await crossSite(`/queue/${item.id}/files/demo/a.css`)).status).toBe(200)
    expect((await crossSite('/api/queue')).status).toBe(403)
  })

  test('a visualizer folder that is itself a link is refused', async () => {
    const linked = await mkdtemp(join(tmpdir(), 'mc-queue-mock-link-'))
    await symlink(join(tree, 'visualizer'), join(linked, 'visualizer'))
    expect((await files('{id}/files/demo/index.html', { worktree: linked })).status).toBe(404)
    await rm(linked, { recursive: true, force: true })
  })

  test('an item without a workspace, or an unknown item, has no files', async () => {
    const bare = await files('{id}/files/demo/index.html', { worktree: null })
    expect(bare.status).toBe(404)
    sealed(bare)
    const items = store()
    expect((await call(new Elysia().use(queueRoutes(items, engine(items))), '/queue/nope/files/demo/index.html')).status).toBe(404)
  })
})

test('POST pick takes none with feedback and refuses the other combinations', async () => {
  const items = store()
  let seen: unknown
  const app = new Elysia().use(queueRoutes(items, engine(items, { pick: async (id, choice) => { seen = choice; return items.update(id, { state: 'queued' }) } })))
  const parked = await items.add(newItem, 'end')
  await items.update(parked.id, { state: 'waiting-pick' })
  const url = `/api/queue/${parked.id}/pick`
  expect((await post(app, url, { option: 'none', feedback: 'new designs please' })).status).toBe(200)
  expect(seen).toMatchObject({ option: 'none', feedback: 'new designs please' })
  const missing = await post(app, url, { option: 'none' })
  expect([missing.status, (await missing.json()).error]).toEqual([400, 'Say what should change'])
  expect((await post(app, url, { option: 'none', feedback: '  \n ' })).status).toBe(400)
  expect((await post(app, url, { option: 'B', feedback: 'x' })).status).toBe(400)
  expect((await post(app, url, { option: 'none', feedback: 'x'.repeat(4001) })).status).toBe(400)
  expect((await post(app, url, { option: 'none', feedback: 'x'.repeat(4000) })).status).toBe(200)
})
