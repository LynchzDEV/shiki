import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQueueEngine, type QueueEngineDeps } from '../server/queue-engine'
import type { RunView } from '../server/queue-prompts'
import type { QueueSource, SourceReplies } from '../server/queue-source'
import { createQueueStore } from '../server/queue-store'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-replies-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function parked(replies: () => Promise<SourceReplies>, overrides: Partial<QueueEngineDeps> = {}) {
  const store = createQueueStore(join(dir, 'queue.json'))
  const runs = new Map<string, RunView>()
  const alerts: string[] = []
  const requests: string[] = []
  let next = 0
  const files = join(dir, 'plugin-data', 'clickup-board', 'files')
  const source: QueueSource = { item: async ({ id }) => ({ title: `Task ${id}`, url: 'u', contextMarkdown: '# t' }), post: async () => ({ commentId: 'c1' }), replies }
  const deps: QueueEngineDeps = {
    store,
    runner: { start: async input => { requests.push(input.request); const id = `run-${++next}`; runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } }, get: id => runs.get(id) },
    source: () => source,
    prepareWorktree: async (_repo, label) => { const worktree = join(dir, 'wt', label); await mkdir(worktree, { recursive: true }); return { worktree } },
    writeContext: async (pluginId, context, cwd) => { const folder = join(cwd, '.shikidan', 'queue', pluginId); await mkdir(folder, { recursive: true }); const path = join(folder, `${context.name}.md`); await writeFile(path, context.markdown); return path },
    pluginFiles: () => files,
    backupDir: itemId => join(dir, 'queue-files', itemId),
    needsYou: (_item, reason) => { alerts.push(reason) },
  }
  const engine = createQueueEngine(deps)
  const item = await engine.add({ source: 'clickup-board', externalId: '1', repo: '/repo' })
  const blocked: RunView = { id: 'run-1', status: 'blocked', error: null, attempts: [{ nodeId: 'plan', number: 1, jobId: 'j', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: { outcome: 'blocked', summary: 's', evidence: ['biz: Which page?'] }, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [] }] }
  runs.set(blocked.id, blocked)
  await engine.onRunSettled(blocked)
  Object.assign(deps, overrides)
  return { engine, store, item, alerts, requests, files, runs, blocked }
}

function silencedErrors() {
  return spyOn(console, 'error').mockImplementation(() => {})
}

async function contextFiles(worktree: string): Promise<string[]> {
  return (await readdir(join(worktree, '.shikidan', 'queue', 'clickup-board'))).sort()
}

test('no replies keeps the item waiting', async () => {
  const h = await parked(async () => ({ replies: [], lastId: null }))
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 0 })
  expect(h.store.get(h.item.id)!.state).toBe('waiting-info')
})

test('a reply writes the answers, puts the item first and rebuilds it with the answers', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [] }], lastId: 'r1' }))
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
  const item = h.store.get(h.item.id)!
  expect(item).toMatchObject({ state: 'building', questions: [], lastSeenId: 'r1', runIds: ['run-1', 'run-2'] })
  expect(await readFile(item.answerPaths[0]!, 'utf8')).toContain('The login page')
  expect(h.requests[1]).toContain(`The requester answered your earlier questions: read ${item.answerPaths[0]}`)
  expect(await readFile(item.answerPaths[0]!, 'utf8')).toContain('- Which page?')
})

test('a reply puts the parked item in front of items already queued', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [] }], lastId: 'r1' }))
  const building = await h.engine.add({ source: 'clickup-board', externalId: '2', repo: '/repo' })
  const waiting = await h.engine.add({ source: 'clickup-board', externalId: '3', repo: '/repo' })
  await h.store.move(h.item.id, 2)
  expect(h.store.list().map(item => item.id)).toEqual([building.id, waiting.id, h.item.id])
  await h.engine.checkReplies()
  expect(h.store.list().map(item => item.id)).toEqual([h.item.id, building.id, waiting.id])
  expect(h.store.get(h.item.id)!.state).toBe('queued')
  expect(h.store.get(waiting.id)!.state).toBe('queued')
})

test('reply images are copied into the worktree context folder and listed', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'See this', images: [{ name: 'shot.png', path: 'replies/shot.png' }] }], lastId: 'r1' }))
  await mkdir(join(h.files, 'replies'), { recursive: true })
  await writeFile(join(h.files, 'replies', 'shot.png'), 'png-bytes')
  await h.engine.checkReplies()
  const item = h.store.get(h.item.id)!
  const copied = join(item.worktree!, '.shikidan', 'queue', 'clickup-board', 'r1-0-shot.png')
  expect(await readFile(copied, 'utf8')).toBe('png-bytes')
  expect((await stat(copied)).mode & 0o777).toBe(0o600)
  expect(await readFile(item.answerPaths[0]!, 'utf8')).toContain(`- ${copied}`)
})

test('images outside the plugin data folder are skipped', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'key', path: '../../../secret' }] }], lastId: 'r1' }))
  await writeFile(join(dir, 'secret'), 'do not copy')
  const errors = silencedErrors()
  try {
    await h.engine.checkReplies()
    expect(errors).toHaveBeenCalledTimes(1)
  } finally {
    errors.mockRestore()
  }
  const item = h.store.get(h.item.id)!
  await expect(stat(join(item.worktree!, '.shikidan', 'queue', 'clickup-board', 'r1-0-key'))).rejects.toThrow()
  expect(await readFile(item.answerPaths[0]!, 'utf8')).not.toContain('## Images')
})

test('a link in the plugin folder pointing outside it is never followed', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'id_rsa', path: 'x' }, { name: 'ok.png', path: 'ok.png' }] }], lastId: 'r1' }))
  await mkdir(h.files, { recursive: true })
  await writeFile(join(dir, 'secret'), 'do not copy')
  await symlink(join(dir, 'secret'), join(h.files, 'x'))
  await writeFile(join(h.files, 'ok.png'), 'png-bytes')
  const errors = silencedErrors()
  try {
    await h.engine.checkReplies()
    expect(errors).toHaveBeenCalledTimes(1)
  } finally {
    errors.mockRestore()
  }
  const item = h.store.get(h.item.id)!
  expect(await contextFiles(item.worktree!)).toEqual(['answers-1.md', 'item-1.md', 'r1-1-ok.png'])
  const answers = await readFile(item.answerPaths[0]!, 'utf8')
  expect(answers).not.toContain('id_rsa')
  expect(answers).toContain('r1-1-ok.png')
})

test('a link pointing at another file inside the plugin folder is not copied either', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'alias.png', path: 'alias.png' }] }], lastId: 'r1' }))
  await mkdir(h.files, { recursive: true })
  await writeFile(join(h.files, 'real.png'), 'png-bytes')
  await symlink(join(h.files, 'real.png'), join(h.files, 'alias.png'))
  const errors = silencedErrors()
  try {
    await h.engine.checkReplies()
    expect(errors).toHaveBeenCalledTimes(1)
  } finally {
    errors.mockRestore()
  }
  const item = h.store.get(h.item.id)!
  expect(await contextFiles(item.worktree!)).toEqual(['answers-1.md', 'item-1.md'])
  expect(await readFile(item.answerPaths[0]!, 'utf8')).not.toContain('## Images')
})

test('two images with the same name in one reply are both kept', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'shot.png', path: 'a/shot.png' }, { name: 'shot.png', path: 'b/shot.png' }] }], lastId: 'r1' }))
  await mkdir(join(h.files, 'a'), { recursive: true })
  await mkdir(join(h.files, 'b'), { recursive: true })
  await writeFile(join(h.files, 'a', 'shot.png'), 'first')
  await writeFile(join(h.files, 'b', 'shot.png'), 'second')
  await h.engine.checkReplies()
  const folder = join(h.store.get(h.item.id)!.worktree!, '.shikidan', 'queue', 'clickup-board')
  expect(await readFile(join(folder, 'r1-0-shot.png'), 'utf8')).toBe('first')
  expect(await readFile(join(folder, 'r1-1-shot.png'), 'utf8')).toBe('second')
})

test('a local failure while resuming keeps the item waiting and asks for you after three failures', async () => {
  const failingWrite: QueueEngineDeps['writeContext'] = async () => { throw new Error('disk full') }
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [] }], lastId: 'r1' }), { writeContext: failingWrite })
  const errors = silencedErrors()
  try {
    for (let i = 0; i < 2; i += 1) expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 0 })
    expect(h.alerts).toEqual([])
    await h.engine.checkReplies()
    expect(errors.mock.calls.map(call => call[0])).toEqual(['queue resume failed', 'queue resume failed', 'queue resume failed'])
  } finally {
    errors.mockRestore()
  }
  expect(h.store.get(h.item.id)).toMatchObject({ state: 'waiting-info', lastSeenId: 'c1', questions: ['Which page?'], answerPaths: [] })
  expect(h.alerts).toEqual(['Could not save the replies: disk full'])
})

test('the resume failure count resets after the alert', async () => {
  const failingWrite: QueueEngineDeps['writeContext'] = async () => { throw new Error('disk full') }
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [] }], lastId: 'r1' }), { writeContext: failingWrite })
  const errors = silencedErrors()
  try {
    for (let i = 0; i < 5; i += 1) await h.engine.checkReplies()
  } finally {
    errors.mockRestore()
  }
  expect(h.alerts).toEqual(['Could not save the replies: disk full'])
})

test('a hard link to a file outside the plugin folder is not copied', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'hard.png', path: 'hard.png' }] }], lastId: 'r1' }))
  await mkdir(h.files, { recursive: true })
  await writeFile(join(dir, 'secret'), 'do not copy')
  await link(join(dir, 'secret'), join(h.files, 'hard.png'))
  const errors = silencedErrors()
  try {
    await h.engine.checkReplies()
    expect(errors).toHaveBeenCalledTimes(1)
  } finally {
    errors.mockRestore()
  }
  const item = h.store.get(h.item.id)!
  expect(await contextFiles(item.worktree!)).toEqual(['answers-1.md', 'item-1.md'])
  expect(await readFile(item.answerPaths[0]!, 'utf8')).not.toContain('## Images')
})

test('an image over the size cap is not copied', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'big.png', path: 'big.png' }, { name: 'edge.png', path: 'edge.png' }] }], lastId: 'r1' }))
  await mkdir(h.files, { recursive: true })
  await writeFile(join(h.files, 'big.png'), Buffer.alloc(3_932_161, 1))
  await writeFile(join(h.files, 'edge.png'), Buffer.alloc(3_932_160, 2))
  const errors = silencedErrors()
  try {
    await h.engine.checkReplies()
    expect(errors).toHaveBeenCalledTimes(1)
  } finally {
    errors.mockRestore()
  }
  const item = h.store.get(h.item.id)!
  expect(await contextFiles(item.worktree!)).toEqual(['answers-1.md', 'item-1.md', 'r1-1-edge.png'])
  expect((await stat(join(item.worktree!, '.shikidan', 'queue', 'clickup-board', 'r1-1-edge.png'))).size).toBe(3_932_160)
})

test('a normal image is copied byte for byte', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a, 0x0d])
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'shot.png', path: 'shot.png' }] }], lastId: 'r1' }))
  await mkdir(h.files, { recursive: true })
  await writeFile(join(h.files, 'shot.png'), bytes)
  await h.engine.checkReplies()
  const copied = await readFile(join(h.store.get(h.item.id)!.worktree!, '.shikidan', 'queue', 'clickup-board', 'r1-0-shot.png'))
  expect(copied.equals(bytes)).toBe(true)
})

test('a missing reply image is logged and left out of the answers', async () => {
  const errors = silencedErrors()
  try {
    const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'gone.png', path: 'replies/gone.png' }] }], lastId: 'r1' }))
    expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
    const item = h.store.get(h.item.id)!
    expect(await readFile(item.answerPaths[0]!, 'utf8')).not.toContain('## Images')
    expect(errors).toHaveBeenCalledTimes(1)
  } finally {
    errors.mockRestore()
  }
})

test('a failing source keeps the item waiting and asks for you after three failures', async () => {
  const h = await parked(async () => { throw new Error('ClickUp is down') })
  await h.engine.checkReplies()
  await h.engine.checkReplies()
  expect(h.alerts).toEqual([])
  await h.engine.checkReplies()
  expect(h.store.get(h.item.id)!.state).toBe('waiting-info')
  expect(h.alerts).toEqual(['Could not read replies: ClickUp is down'])
})

test('the failure count resets after an alert and after a good read', async () => {
  let down = true
  const h = await parked(async () => { if (down) throw new Error('ClickUp is down'); return { replies: [], lastId: null } })
  for (let i = 0; i < 4; i += 1) await h.engine.checkReplies()
  expect(h.alerts).toHaveLength(1)
  down = false
  await h.engine.checkReplies()
  down = true
  await h.engine.checkReplies()
  await h.engine.checkReplies()
  expect(h.alerts).toHaveLength(1)
})

function slowReplies(result: SourceReplies) {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { entered = resolve })
  let calls = 0
  const replies = async (): Promise<SourceReplies> => {
    calls += 1
    if (calls === 1) return { replies: [], lastId: null }
    entered()
    await gate
    return result
  }
  return { replies, release, reading }
}

const settledWithin = (work: Promise<unknown>): Promise<string> => Promise.race([work.then(() => 'settled'), Bun.sleep(200).then(() => 'stuck')])

test('a slow source does not hold up adds and settles while replies are read', async () => {
  const slow = slowReplies({ replies: [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [] }], lastId: 'r1' })
  const h = await parked(slow.replies)
  await h.engine.checkReplies()
  const checking = h.engine.checkReplies()
  await slow.reading
  expect(await settledWithin(h.engine.add({ source: 'clickup-board', externalId: '2', repo: '/repo' }))).toBe('settled')
  expect(await settledWithin(h.engine.onRunSettled({ id: 'run-2', status: 'failed', error: 'boom', attempts: [] }))).toBe('settled')
  slow.release()
  expect(await checking).toEqual({ checked: 1, resumed: 1 })
  expect(h.store.get(h.item.id)).toMatchObject({ state: 'building', lastSeenId: 'r1' })
})

test('replies read for an item that was requeued meanwhile are discarded', async () => {
  const slow = slowReplies({ replies: [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [] }], lastId: 'r1' })
  const h = await parked(slow.replies)
  await h.engine.checkReplies()
  const checking = h.engine.checkReplies()
  await slow.reading
  await h.engine.requeue(h.item.id)
  slow.release()
  expect(await checking).toEqual({ checked: 1, resumed: 0 })
  expect(h.store.get(h.item.id)).toMatchObject({ state: 'building', answerPaths: [], lastSeenId: 'c1', runIds: ['run-1', 'run-2'] })
})

test('replies read against a cursor that moved meanwhile are discarded', async () => {
  const slow = slowReplies({ replies: [{ id: 'r1', author: 'Ploy', text: 'old', images: [] }], lastId: 'r1' })
  const h = await parked(slow.replies)
  await h.engine.checkReplies()
  const checking = h.engine.checkReplies()
  await slow.reading
  await h.store.update(h.item.id, { lastSeenId: 'r9' })
  slow.release()
  expect(await checking).toEqual({ checked: 1, resumed: 0 })
  expect(h.store.get(h.item.id)).toMatchObject({ state: 'waiting-info', answerPaths: [], lastSeenId: 'r9' })
})

test('a link planted at the copy target name is never followed and the image is skipped', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'shot.png', path: 'shot.png' }] }], lastId: 'r1' }))
  await mkdir(h.files, { recursive: true })
  await writeFile(join(h.files, 'shot.png'), 'png-bytes')
  await writeFile(join(dir, 'victim'), 'original')
  await chmod(join(dir, 'victim'), 0o644)
  const folder = join(h.store.get(h.item.id)!.worktree!, '.shikidan', 'queue', 'clickup-board')
  await symlink(join(dir, 'victim'), join(folder, 'r1-0-shot.png'))
  const errors = silencedErrors()
  try {
    await h.engine.checkReplies()
    expect(errors).toHaveBeenCalledTimes(1)
  } finally {
    errors.mockRestore()
  }
  expect(await readFile(join(dir, 'victim'), 'utf8')).toBe('original')
  expect((await stat(join(dir, 'victim'))).mode & 0o777).toBe(0o644)
  expect((await lstat(join(folder, 'r1-0-shot.png'))).isSymbolicLink()).toBe(true)
  expect(await readFile(h.store.get(h.item.id)!.answerPaths[0]!, 'utf8')).not.toContain('## Images')
})

test('a regular file already at the copy target is replaced with a private copy', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'shot.png', path: 'shot.png' }] }], lastId: 'r1' }))
  await mkdir(h.files, { recursive: true })
  await writeFile(join(h.files, 'shot.png'), 'png-bytes')
  const folder = join(h.store.get(h.item.id)!.worktree!, '.shikidan', 'queue', 'clickup-board')
  await writeFile(join(folder, 'r1-0-shot.png'), 'stale', { mode: 0o644 })
  await h.engine.checkReplies()
  expect(await readFile(join(folder, 'r1-0-shot.png'), 'utf8')).toBe('png-bytes')
  expect((await stat(join(folder, 'r1-0-shot.png'))).mode & 0o777).toBe(0o600)
})

test('a reply waits while the last run is live again in Studio and applies once it is blocked again', async () => {
  let reads = 0
  const h = await parked(async () => { reads += 1; return { replies: [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [] }], lastId: 'r1' } })
  h.runs.set('run-1', { ...h.blocked, status: 'running' })
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 0 })
  expect(reads).toBe(0)
  expect(h.store.get(h.item.id)).toMatchObject({ state: 'waiting-info', lastSeenId: 'c1', answerPaths: [] })
  const blockedAgain: RunView = { ...h.blocked, attempts: [...h.blocked.attempts, { ...h.blocked.attempts[0]!, number: 2 }] }
  h.runs.set('run-1', blockedAgain)
  await h.engine.onRunSettled(blockedAgain)
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
  expect(h.store.get(h.item.id)).toMatchObject({ state: 'building', lastSeenId: 'r1' })
})

test('a queue folder planted as a link to outside the worktree gets no image copies and fails the resume', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'shot.png', path: 'shot.png' }] }], lastId: 'r1' }))
  await mkdir(h.files, { recursive: true })
  await writeFile(join(h.files, 'shot.png'), 'png-bytes')
  const outside = join(dir, 'outside')
  await mkdir(outside)
  const queue = join(h.store.get(h.item.id)!.worktree!, '.shikidan', 'queue')
  await rm(queue, { recursive: true, force: true })
  await symlink(outside, queue)
  const errors = silencedErrors()
  try {
    expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 0 })
    expect(errors.mock.calls.map(call => call[0])).toEqual(['queue resume failed'])
  } finally {
    errors.mockRestore()
  }
  expect(await readdir(outside)).toEqual([])
  expect(h.store.get(h.item.id)).toMatchObject({ state: 'waiting-info', answerPaths: [] })
})
