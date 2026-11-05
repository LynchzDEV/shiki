import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createQueueStore, type NewQueueItem } from '../server/queue-store'

let dir: string
let path: string
const item = (externalId: string): NewQueueItem => ({ source: 'clickup-board', externalId, title: `Task ${externalId}`, url: `https://app.clickup.com/t/${externalId}`, repo: '/repo', flowId: null })

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-')); path = join(dir, 'nested', 'queue.json') })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('a missing file is an empty queue', () => {
  expect(createQueueStore(path).list()).toEqual([])
})

test('added items start queued, keep order, and survive a new instance', async () => {
  const store = createQueueStore(path, () => 1000)
  const a = await store.add(item('a'), 'end')
  await store.add(item('b'), 'end')
  expect(a).toMatchObject({ state: 'queued', worktree: null, contextPath: null, answerPaths: [], runIds: [], currentRunId: null, questions: [], lastSeenId: null, error: null, createdAt: 1000, updatedAt: 1000 })
  expect(createQueueStore(path).list().map(entry => entry.externalId)).toEqual(['a', 'b'])
})

test('next puts the item first', async () => {
  const store = createQueueStore(path)
  await store.add(item('a'), 'end')
  await store.add(item('b'), 'next')
  expect(store.list().map(entry => entry.externalId)).toEqual(['b', 'a'])
})

test('update patches fields and bumps updatedAt; unknown ids throw', async () => {
  let now = 1
  const store = createQueueStore(path, () => now)
  const a = await store.add(item('a'), 'end')
  now = 5
  const updated = await store.update(a.id, { state: 'building', currentRunId: 'run-1' })
  expect(updated).toMatchObject({ state: 'building', currentRunId: 'run-1', createdAt: 1, updatedAt: 5 })
  await expect(store.update('nope', { state: 'failed' })).rejects.toThrow('No queue item nope')
})

test('move and toFront reorder; remove deletes', async () => {
  const store = createQueueStore(path)
  const a = await store.add(item('a'), 'end')
  const b = await store.add(item('b'), 'end')
  const c = await store.add(item('c'), 'end')
  expect(await store.move(c.id, 0)).toBe(true)
  expect(store.list().map(entry => entry.externalId)).toEqual(['c', 'a', 'b'])
  await store.toFront(b.id)
  expect(store.list().map(entry => entry.externalId)).toEqual(['b', 'c', 'a'])
  expect(await store.move('nope', 0)).toBe(false)
  expect(await store.remove(a.id)).toBe(true)
  expect(await store.remove(a.id)).toBe(false)
  expect(store.list().map(entry => entry.externalId)).toEqual(['b', 'c'])
})

test('move clamps the target index into range', async () => {
  const store = createQueueStore(path)
  const a = await store.add(item('a'), 'end')
  await store.add(item('b'), 'end')
  await store.move(a.id, 99)
  expect(store.list().map(entry => entry.externalId)).toEqual(['b', 'a'])
})

test('every change notifies subscribers', async () => {
  const store = createQueueStore(path)
  let calls = 0
  store.subscribe(() => { calls += 1 })
  const a = await store.add(item('a'), 'end')
  await store.update(a.id, { state: 'failed' })
  await store.remove(a.id)
  expect(calls).toBe(3)
})

test('a corrupt file or malformed entries load as empty instead of crashing', async () => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '{not json')
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(createQueueStore(path).list()).toEqual([])
    expect(quiet).toHaveBeenCalledTimes(1)
  } finally { quiet.mockRestore() }
  await writeFile(path, JSON.stringify({ items: [{ id: 'x' }] }))
  expect(createQueueStore(path).list()).toEqual([])
})

test('the file is written as { items }', async () => {
  const store = createQueueStore(path)
  await store.add(item('a'), 'end')
  expect(JSON.parse(await readFile(path, 'utf8')).items).toHaveLength(1)
})

test('an undefined patch value leaves the field as is and the item survives a reload', async () => {
  const store = createQueueStore(path)
  const a = await store.add(item('a'), 'end')
  await store.update(a.id, { error: undefined, state: 'failed' })
  expect(createQueueStore(path).list()).toMatchObject([{ id: a.id, error: null, state: 'failed' }])
})

test('a corrupt file logs once and a missing file logs nothing', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    createQueueStore(path)
    expect(errors).toHaveBeenCalledTimes(0)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{not json')
    createQueueStore(path)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0]![0]).toBe(`queue list unreadable, starting empty: ${path}`)
  } finally {
    errors.mockRestore()
  }
})

const pick = { options: ['A', 'B'], path: 'visualizer/x', recommended: 'A', tester: null, summary: 'Two variants' }

test('a waiting-pick item keeps its pick across a reload and update can clear it', async () => {
  const store = createQueueStore(path)
  const a = await store.add(item('a'), 'end')
  await store.update(a.id, { state: 'waiting-pick', pick })
  expect(createQueueStore(path).get(a.id)).toMatchObject({ state: 'waiting-pick', pick })
  await store.update(a.id, { state: 'queued', pick: undefined })
  expect('pick' in createQueueStore(path).get(a.id)!).toBe(false)
})

test('a queue.json from before waiting-pick loads unchanged, and a malformed pick is left out', async () => {
  const store = createQueueStore(path)
  const a = await store.add(item('a'), 'end')
  const b = await store.add(item('b'), 'end')
  const raw = JSON.parse(await readFile(path, 'utf8')) as { items: Array<Record<string, unknown>> }
  raw.items[1]!.pick = { options: 'A' }
  await writeFile(path, JSON.stringify(raw))
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  const loaded = createQueueStore(path).list()
  quiet.mockRestore()
  expect(loaded.map(entry => entry.id)).toEqual([a.id])
  expect(loaded[0]).toEqual(store.get(a.id)!)
  expect(b.id).not.toBe(a.id)
})

test('a queue.json written before land stages existed loads unchanged, and land progress survives a new instance', async () => {
  const store = createQueueStore(path)
  const a = await store.add(item('a'), 'end')
  const oldFile = JSON.parse(await readFile(path, 'utf8'))
  expect(oldFile.items[0]).not.toHaveProperty('land')
  expect(createQueueStore(path).get(a.id)).toEqual(a)
  const plan = [{ id: 'uat', run: 'auto' as const, command: { command: 'ship.sh', args: [], timeoutSeconds: 3600 }, env: {} }]
  await store.update(a.id, { state: 'awaiting-stage', land: { stage: 'uat', stages: { uat: { status: 'waiting', preflight: { exitCode: 0, markdown: 'ok' } } }, plan } })
  expect(createQueueStore(path).get(a.id)).toMatchObject({ state: 'awaiting-stage', land: { stage: 'uat', stages: { uat: { preflight: { markdown: 'ok' } } } } })
})

test('an item with a malformed land record is left out', async () => {
  const store = createQueueStore(path)
  const a = await store.add(item('a'), 'end')
  const file = JSON.parse(await readFile(path, 'utf8'))
  file.items[0].land = { stage: 5 }
  await writeFile(path, JSON.stringify(file))
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  expect(createQueueStore(path).get(a.id)).toBeUndefined()
  logged.mockRestore()
})

test('recovery counters must be whole numbers, and items without them still load', async () => {
  const base = { source: 's', externalId: '1', title: 't', url: 'u', repo: '/r', flowId: null, state: 'landing', worktree: '/w', contextPath: null, answerPaths: [], runIds: ['r1'], currentRunId: null, questions: [], lastSeenId: null, error: null, createdAt: 1, updatedAt: 1 }
  const land = { stage: 'uat', stages: {}, plan: [] }
  const spy = spyOn(console, 'error').mockImplementation(() => {})
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ items: [
    { ...base, id: 'plain', land },
    { ...base, id: 'good', land: { ...land, recover: { stage: 'uat', attempts: 2, reason: 'x' } }, recoverRebuilds: 1, recoverBuild: { runId: 'r1', attempts: 1 } },
    { ...base, id: 'bad-rebuilds', recoverRebuilds: 'one' },
    { ...base, id: 'bad-build', recoverBuild: { runId: 'r1', attempts: 'many' } },
    { ...base, id: 'bad-land', land: { ...land, recover: { stage: 'uat', attempts: -1, reason: 'x' } } },
    { ...base, id: 'null-build', recoverBuild: null },
    { ...base, id: 'null-land', land: { ...land, recover: null } },
    { ...base, id: 'bad-note', recoverBuild: { runId: 'r1', attempts: 1, note: 7 } },
  ] }))
  expect(createQueueStore(path).list().map(entry => entry.id)).toEqual(['plain', 'good'])
  spy.mockRestore()
})
