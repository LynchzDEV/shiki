import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readdir, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { writeQueueContext } from '../server/queue-files'
import { blockedWith, parkedItem, queueHarness, reply, type QueueHarness } from './support/queue-harness'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-answers-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777
const backupOf = (itemId: string, path: string): string => join(dir, 'queue-files', itemId, basename(path))

async function answeredThenFailed(h: QueueHarness, text = 'The login page') {
  const parked = await parkedItem(h)
  h.answer(async () => reply('r1', text))
  await h.engine.checkReplies()
  await h.engine.onRunSettled(h.settle('run-2', { status: 'failed', error: 'boom' }))
  return h.store.get(parked.id)!
}

test('writing an answers file also writes a private backup with the same bytes', async () => {
  const h = queueHarness(dir, { writeContext: (pluginId, context, cwd) => writeQueueContext(pluginId, context, cwd) })
  const item = await answeredThenFailed(h, 'The login page, 日本語')
  const answers = item.answerPaths[0]!
  const backup = backupOf(item.id, answers)
  expect(await readFile(backup)).toEqual(await readFile(answers))
  expect(await mode(join(dir, 'queue-files', item.id))).toBe(0o700)
  expect(await mode(backup)).toBe(0o600)
})

test('requeue after the worktree was deleted by hand brings the answers back byte for byte', async () => {
  const h = queueHarness(dir, { writeContext: (pluginId, context, cwd) => writeQueueContext(pluginId, context, cwd) })
  const item = await answeredThenFailed(h, 'The login page, 日本語')
  const answers = item.answerPaths[0]!
  const before = await readFile(answers)
  await rm(item.worktree!, { recursive: true, force: true })
  await h.engine.requeue(item.id)
  expect(await readFile(answers)).toEqual(before)
  expect(await mode(answers)).toBe(0o600)
  expect(h.store.get(item.id)).toMatchObject({ state: 'building', answerPaths: [answers] })
  expect(h.started[2]!.request).toContain(answers)
})

test('resuming a run after the worktree was deleted brings the answers and context back first', async () => {
  const retried: string[] = []
  const h = queueHarness(dir, { writeContext: (pluginId, context, cwd) => writeQueueContext(pluginId, context, cwd) })
  const item = await answeredThenFailed(h, 'The login page, 日本語')
  expect(item.resumeRunId).toBe('run-2')
  const answers = item.answerPaths[0]!
  const before = await readFile(answers)
  await rm(item.worktree!, { recursive: true, force: true })
  const { engine } = h.restart({ retry: async id => { retried.push(id); return { id } } })
  await engine.requeue(item.id)
  expect(retried).toEqual(['run-2'])
  expect(await readFile(answers)).toEqual(before)
  expect(existsSync(item.contextPath!)).toBe(true)
})

test('a second reply after the worktree was deleted brings the earlier answers back too', async () => {
  let written = 0
  const h = queueHarness(dir, { writeContext: (pluginId, context, cwd) => writeQueueContext(pluginId, { ...context, name: `${context.name}-${++written}` }, cwd) })
  const parked = await parkedItem(h)
  h.answer(async () => reply('r1', 'The login page'))
  await h.engine.checkReplies()
  await h.engine.onRunSettled(h.settle('run-2', { status: 'blocked', attempts: [blockedWith(['Which button?'])] }))
  const first = h.store.get(parked.id)!.answerPaths[0]!
  const before = await readFile(first)
  await rm(parked.worktree!, { recursive: true, force: true })
  h.answer(async () => reply('r2', 'The blue one'))
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
  const resumed = h.store.get(parked.id)!
  expect(resumed.answerPaths).toHaveLength(2)
  expect(await readFile(first)).toEqual(before)
  expect(resumed.answerPaths.every(path => existsSync(path))).toBe(true)
})

test('an answers file with no backup is dropped from the item and logged once', async () => {
  const h = queueHarness(dir)
  const item = await answeredThenFailed(h)
  const answers = item.answerPaths[0]!
  await rm(item.worktree!, { recursive: true, force: true })
  await rm(join(dir, 'queue-files', item.id), { recursive: true, force: true })
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await h.engine.requeue(item.id)
    expect(h.store.get(item.id)!.answerPaths).toEqual([])
    expect(h.started[2]!.request).not.toContain(answers)
    await h.engine.onRunSettled(h.settle('run-3', { status: 'failed', error: 'boom' }))
    await h.engine.requeue(item.id)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain(answers)
  } finally { warn.mockRestore() }
})

test('a queue folder swapped for a link stops the build before any answers are restored through it', async () => {
  const h = queueHarness(dir, { writeContext: (pluginId, context, cwd) => writeQueueContext(pluginId, context, cwd) })
  const item = await answeredThenFailed(h)
  const folder = dirname(item.answerPaths[0]!)
  const outside = await mkdtemp(join(tmpdir(), 'mc-queue-outside-'))
  try {
    await cp(item.contextPath!, join(outside, basename(item.contextPath!)))
    await rm(folder, { recursive: true, force: true })
    await symlink(outside, folder)
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try { await h.engine.requeue(item.id) } finally { error.mockRestore() }
    expect(await readdir(outside)).toEqual([basename(item.contextPath!)])
    expect(h.store.get(item.id)).toMatchObject({ state: 'failed' })
  } finally { await rm(outside, { recursive: true, force: true }) }
})

test('removing an item from the queue deletes its answers backup folder', async () => {
  const h = queueHarness(dir)
  const item = await answeredThenFailed(h)
  expect(existsSync(join(dir, 'queue-files', item.id))).toBe(true)
  await h.engine.remove(item.id)
  expect(existsSync(join(dir, 'queue-files', item.id))).toBe(false)
})
