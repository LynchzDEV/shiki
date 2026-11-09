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
let configDir: string
const priorConfigDir = process.env.SKD_CONFIG_DIR
beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-queue-routes-config-'))
  process.env.SKD_CONFIG_DIR = configDir
  repo = await mkdtemp(join(homedir(), 'mc-queue-routes-repo-'))
  plain = await mkdtemp(join(homedir(), 'mc-queue-routes-plain-'))
  if (Bun.spawnSync(['git', 'init', '-q', repo]).exitCode !== 0) throw new Error('git init failed')
  await symlink(repo, join(plain, 'link'))
})
afterAll(async () => {
  if (priorConfigDir === undefined) delete process.env.SKD_CONFIG_DIR
  else process.env.SKD_CONFIG_DIR = priorConfigDir
  await rm(configDir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
  await rm(plain, { recursive: true, force: true })
})

type Engine = Pick<QueueEngine, 'add' | 'requeue' | 'pick' | 'say' | 'reread' | 'checkReplies' | 'remove' | 'stop' | 'move' | 'checkedAt' | 'subscribeChecks'>
type RunLookup = NonNullable<Parameters<typeof queueRoutes>[3]>

function engine(items: ReturnType<typeof store>, over: Partial<QueueEngine> = {}): Engine {
  const found = (id: string) => { const item = items.get(id); if (item === undefined) throw new QueueRefusal(`No queue item ${id}`, 404); return item }
  return {
    add: async input => items.add({ ...newItem, externalId: input.externalId, repo: input.repo, flowId: input.flowId ?? null }, input.position ?? 'end'),
    requeue: async id => items.update(id, { state: 'queued' }),
    pick: async (id, choice) => { if (found(id).state !== 'waiting-pick') throw new QueueRefusal('It is queued now', 409); return items.update(id, { state: 'queued', questions: [choice.option, choice.tester ?? '', choice.note ?? ''] }) },
    say: async id => found(id),
    reread: async id => { if (found(id).state !== 'waiting-pick') throw new QueueRefusal('It is not waiting on a ClickUp pick', 409); return found(id) },
    checkReplies: async () => ({ checked: 2, resumed: 1 }),
    remove: async id => { found(id); await items.remove(id) },
    stop: async id => {
      const { state } = found(id)
      if (state !== 'building' && state !== 'landing') throw new QueueRefusal(`It is ${state} now`, 409)
      return items.update(id, { state: 'failed', error: 'Stopped by user' })
    },
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

test('delete and move go through the engine, and a refused delete says why', async () => {
  const items = store()
  const a = await items.add(newItem, 'end')
  const seen: string[] = []
  const app = new Elysia().use(queueRoutes(items, engine(items, {
    remove: async id => { seen.push(`remove ${id}`); throw new QueueRefusal('It is building now', 409) },
    move: async (id, to) => { seen.push(`move ${id} ${to}`) },
  })))
  const removing = await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })
  expect(removing.status).toBe(409)
  expect((await removing.json()).error).toBe('It is building now')
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

test('requeue refuses a building item, delete removes it, and both 404 unknown ids', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const a = await items.add(newItem, 'end')
  await items.update(a.id, { state: 'building' })
  expect((await post(app, `/api/queue/${a.id}/requeue`)).status).toBe(409)
  await items.update(a.id, { state: 'failed' })
  expect((await post(app, `/api/queue/${a.id}/requeue`)).status).toBe(200)
  await items.update(a.id, { state: 'building' })
  expect((await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(200)
  expect((await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(404)
})

test('stop ends a building item, says why it refuses a queued one, and 404s an unknown id', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const a = await items.add(newItem, 'end')
  const refused = await post(app, `/api/queue/${a.id}/stop`)
  expect(refused.status).toBe(409)
  expect((await refused.json()).error).toBe('It is queued now')
  await items.update(a.id, { state: 'building' })
  const stopped = await post(app, `/api/queue/${a.id}/stop`)
  expect(stopped.status).toBe(200)
  expect((await stopped.json()).item).toMatchObject({ id: a.id, state: 'failed', error: 'Stopped by user' })
  const missing = await post(app, '/api/queue/nope/stop')
  expect(missing.status).toBe(404)
  expect((await missing.json()).error).toBe('No such queue item')
})

test('requeue passes { fresh: true } to the engine and treats any other body as not fresh', async () => {
  const items = store()
  const a = await items.add(newItem, 'end')
  await items.update(a.id, { state: 'failed' })
  const asked: Array<{ fresh?: boolean } | undefined> = []
  const app = new Elysia().use(queueRoutes(items, engine(items, { requeue: async (id, options) => { asked.push(options); return found(items, id) } })))
  expect((await post(app, `/api/queue/${a.id}/requeue`, { fresh: true })).status).toBe(200)
  expect((await post(app, `/api/queue/${a.id}/requeue`)).status).toBe(200)
  expect((await post(app, `/api/queue/${a.id}/requeue`, { fresh: 'yes' })).status).toBe(200)
  expect(asked).toEqual([{ fresh: true }, { fresh: false }, { fresh: false }])
})

const found = (items: ReturnType<typeof store>, id: string) => items.get(id)!

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
  expect(await (await call(app, '/api/queue')).json()).toEqual({ items: [], checkedAt: null, paused: null, parallel: 1, replyPollMinutes: 2, publishKeepDays: 14, pickAskTo: null, pickNonePhrases: [] })
  checkedAt = 1_700_000_000_000
  expect(await (await call(app, '/api/queue')).json()).toEqual({ items: [], checkedAt: 1_700_000_000_000, paused: null, parallel: 1, replyPollMinutes: 2, publishKeepDays: 14, pickAskTo: null, pickNonePhrases: [] })
})

test('GET says when the queue is paused on an unavailable AI', async () => {
  const items = store()
  const paused = { reason: 'glm unavailable: glm needs a z.ai token (Settings · GLM)', until: 1_700_000_300_000 }
  const app = new Elysia().use(queueRoutes(items, { ...engine(items), paused: () => paused }))
  expect((await (await call(app, '/api/queue')).json()).paused).toEqual(paused)
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
  expect(await nextData()).toEqual({ items: [], checkedAt: null, paused: null, parallel: 1, replyPollMinutes: 2, publishKeepDays: 14, pickAskTo: null, pickNonePhrases: [] })
  checkedAt = 42
  for (const listener of listeners) listener()
  expect(await nextData()).toEqual({ items: [], checkedAt: 42, paused: null, parallel: 1, replyPollMinutes: 2, publishKeepDays: 14, pickAskTo: null, pickNonePhrases: [] })
  aborting.abort()
  await reader.cancel()
  expect(listeners.size).toBe(0)
})

test('the stream carries how many cards build at once and sends again when it changes', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, { ...engine(items), kick: async () => {} }))
  await call(app, '/api/queue')
  const aborting = new AbortController()
  const response = await app.handle(new Request('http://127.0.0.1:7777/api/queue/stream', { headers: { host: '127.0.0.1:7777' }, signal: aborting.signal }))
  const reader = response.body!.getReader()
  const nextData = async (): Promise<Record<string, unknown>> => JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: /, '').trim())
  expect((await nextData()).parallel).toBe(1)
  await call(app, '/api/queue/settings', { method: 'PUT', body: JSON.stringify({ parallel: 3 }) })
  expect((await nextData()).parallel).toBe(3)
  aborting.abort()
  await reader.cancel()
  await call(app, '/api/queue/settings', { method: 'PUT', body: JSON.stringify({ parallel: 1 }) })
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
    const unstoppable = await call(app, `/api/queue/${items.list()[0]!.id}`, { method: 'DELETE' })
    expect(unstoppable.status).toBe(409)
    expect((await unstoppable.json()).error).toBe('Stopping runs is not available')
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

test('PUT /api/queue/settings stores how many cards build at once, kicks the queue, and GET shows it', async () => {
  const items = store()
  let kicks = 0
  const app = new Elysia().use(queueRoutes(items, { ...engine(items), kick: async () => { kicks += 1 } }))
  expect((await (await call(app, '/api/queue')).json()).parallel).toBe(1)
  const saved = await call(app, '/api/queue/settings', { method: 'PUT', body: JSON.stringify({ parallel: 3 }) })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toEqual({ parallel: 3, replyPollMinutes: 2, publishKeepDays: 14, pickAskTo: null, pickNonePhrases: [] })
  expect(kicks).toBe(1)
  expect((await (await call(app, '/api/queue')).json()).parallel).toBe(3)
  const crossSite = await app.handle(new Request('http://127.0.0.1:7777/api/queue/settings', { method: 'PUT', body: JSON.stringify({ parallel: 2 }), headers: { host: '127.0.0.1:7777', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } }))
  expect(crossSite.status).toBe(403)
  expect((await (await call(app, '/api/queue')).json()).parallel).toBe(3)
})

test('PUT /api/queue/settings sets the reply poll and keep days one at a time, tells the listener, and GET shows them', async () => {
  const items = store()
  const heard: unknown[] = []
  const app = new Elysia().use(queueRoutes(items, engine(items), undefined, undefined, settings => { heard.push(settings) }))
  const put = (body: unknown) => call(app, '/api/queue/settings', { method: 'PUT', body: JSON.stringify(body) })
  expect(await (await put({ replyPollMinutes: 5 })).json()).toMatchObject({ replyPollMinutes: 5, publishKeepDays: 14 })
  expect(await (await put({ publishKeepDays: 30 })).json()).toMatchObject({ replyPollMinutes: 5, publishKeepDays: 30 })
  expect(heard).toHaveLength(2)
  expect(heard.at(-1)).not.toHaveProperty('publishDomain')
  expect(heard.at(-1)).toMatchObject({ replyPollMinutes: 5, publishKeepDays: 30 })
  expect(await (await call(app, '/api/queue')).json()).toMatchObject({ replyPollMinutes: 5, publishKeepDays: 30 })
})

test('PUT /api/queue/settings refuses bad values with the rule, and an empty body', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const put = async (body: unknown) => { const response = await call(app, '/api/queue/settings', { method: 'PUT', body: JSON.stringify(body) }); return [response.status, (await response.json()).error] }
  for (const replyPollMinutes of [0, 16, 1.5]) expect(await put({ replyPollMinutes })).toEqual([400, 'replyPollMinutes must be a whole number from 1 to 15'])
  for (const publishKeepDays of [0, 91, '7']) expect(await put({ publishKeepDays })).toEqual([400, 'publishKeepDays must be a whole number from 1 to 90'])
  expect(await put({ publishDomain: 'mockups.example.com' })).toEqual([400, 'Send parallel, replyPollMinutes, publishKeepDays, pickAskTo or pickNonePhrases'])
  expect(await put({})).toEqual([400, 'Send parallel, replyPollMinutes, publishKeepDays, pickAskTo or pickNonePhrases'])
})

test('POST /api/queue/:id/unpublish goes through the engine and maps its refusals', async () => {
  const items = store()
  const a = await items.add({ ...newItem, externalId: '1' }, 'end')
  await items.update(a.id, { published: { sub: 's-1', host: 's-1.shikidan.com', at: 1 } })
  const app = new Elysia().use(queueRoutes(items, engine(items, {
    unpublish: async id => {
      const item = items.get(id)
      if (item === undefined) throw new QueueRefusal(`No queue item ${id}`, 404)
      if (item.published === undefined) throw new QueueRefusal('It has no published link', 409)
      return items.update(id, { published: undefined })
    },
  })))
  const done = await call(app, `/api/queue/${a.id}/unpublish`, { method: 'POST' })
  expect(done.status).toBe(200)
  expect((await done.json()).item.published).toBeUndefined()
  const again = await call(app, `/api/queue/${a.id}/unpublish`, { method: 'POST' })
  expect([again.status, (await again.json()).error]).toEqual([409, 'It has no published link'])
  expect((await call(app, '/api/queue/nope/unpublish', { method: 'POST' })).status).toBe(404)
})

test('PUT /api/queue/settings refuses anything but a whole number from 1 to 4', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  for (const parallel of [0, 5, 2.5, '2']) {
    const refused = await call(app, '/api/queue/settings', { method: 'PUT', body: JSON.stringify({ parallel }) })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({ error: 'parallel must be a whole number from 1 to 4' })
  }
})

test('POST say trims the text, goes through the engine, and answers 400, 404, 409 and 502', async () => {
  const items = store()
  const a = await items.add({ ...newItem, externalId: '1' }, 'end')
  const said: string[] = []
  const app = new Elysia().use(queueRoutes(items, engine(items, {
    say: async (id, text) => {
      const item = items.get(id)
      if (item === undefined) throw new QueueRefusal(`No queue item ${id}`, 404)
      if (text === 'no card') throw new QueueRefusal('It has no source card to write to', 409)
      if (text === 'down') throw new SourceFailure('ClickUp is down')
      said.push(text)
      return item
    },
  })))
  const url = `/api/queue/${a.id}/say`
  expect((await post(app, url, { text: '  hello  ' })).status).toBe(200)
  expect(said).toEqual(['hello'])
  for (const body of [{}, { text: '' }, { text: '   ' }, { text: 'x'.repeat(4001) }, { text: 5 }]) expect((await post(app, url, body)).status).toBe(400)
  expect((await post(app, '/api/queue/nope/say', { text: 'hi' })).status).toBe(404)
  const noCard = await post(app, url, { text: 'no card' })
  expect([noCard.status, (await noCard.json()).error]).toEqual([409, 'It has no source card to write to'])
  const down = await post(app, url, { text: 'down' })
  expect([down.status, (await down.json()).error]).toEqual([502, 'ClickUp is down'])
})

test('POST reread returns the item and maps the engine refusals', async () => {
  const items = store()
  const a = await items.add({ ...newItem, externalId: '1' }, 'end')
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const idle = await post(app, `/api/queue/${a.id}/reread`)
  expect([idle.status, (await idle.json()).error]).toEqual([409, 'It is not waiting on a ClickUp pick'])
  await items.update(a.id, { state: 'waiting-pick' })
  const ok = await post(app, `/api/queue/${a.id}/reread`)
  expect(ok.status).toBe(200)
  expect((await ok.json()).item.id).toBe(a.id)
  expect((await post(app, '/api/queue/nope/reread')).status).toBe(404)
})

test('PUT /api/queue/settings stores pickAskTo and the none phrases, trims them, clears with null or [], and GET shows them', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const put = (body: unknown) => call(app, '/api/queue/settings', { method: 'PUT', body: JSON.stringify(body) })
  expect(await (await put({ pickAskTo: '101078127', pickNonePhrases: ['  ไม่เอาเลย  ', 'nope'] })).json()).toMatchObject({ pickAskTo: '101078127', pickNonePhrases: ['ไม่เอาเลย', 'nope'] })
  expect(await (await call(app, '/api/queue')).json()).toMatchObject({ pickAskTo: '101078127', pickNonePhrases: ['ไม่เอาเลย', 'nope'] })
  expect(await (await put({ pickAskTo: null })).json()).toMatchObject({ pickAskTo: null, pickNonePhrases: ['ไม่เอาเลย', 'nope'] })
  expect(await (await put({ pickNonePhrases: [] })).json()).toMatchObject({ pickAskTo: null, pickNonePhrases: [] })
})

test('PUT /api/queue/settings refuses a pickAskTo that is not digits and none phrases that are too many, empty or too long', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const put = async (body: unknown) => { const response = await call(app, '/api/queue/settings', { method: 'PUT', body: JSON.stringify(body) }); return [response.status, (await response.json()).error] }
  for (const pickAskTo of ['12a', '', 101, '1'.repeat(31)]) expect(await put({ pickAskTo })).toEqual([400, 'pickAskTo must be a ClickUp user id of 1 to 30 digits, or null'])
  const rule = 'pickNonePhrases must be at most 30 phrases of 3 to 60 characters'
  for (const pickNonePhrases of [Array.from({ length: 31 }, (_, n) => `p${n}`), ['  '], ['ab'], ['x'.repeat(61)], 'nope', [5]]) expect(await put({ pickNonePhrases })).toEqual([400, rule])
})
