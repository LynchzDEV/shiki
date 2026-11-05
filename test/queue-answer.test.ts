import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import { createQueueEngine, type QueueEngineDeps } from '../server/queue-engine'
import { bizQuestionsOf, runRequest, techQuestionsOf, type RunView } from '../server/queue-prompts'
import type { QueueSource } from '../server/queue-source'
import { createQueueStore } from '../server/queue-store'
import { queueRoutes } from '../server/routes/queue'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-answer-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const blocked = (id: string, evidence: string[]): RunView => ({ id, status: 'blocked', error: null, attempts: [{ nodeId: 'plan', number: 0, jobId: 'j1', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: { outcome: 'blocked', summary: 's', evidence }, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [] }] })

function harness({ canRetry = true } = {}) {
  const store = createQueueStore(join(dir, 'queue.json'))
  const runs = new Map<string, RunView>()
  const requests: string[] = []
  const posted: Array<Parameters<QueueSource['post']>[0]> = []
  const replyReads: string[] = []
  const alerts: string[] = []
  const retried: Array<{ id: string; note: string | undefined }> = []
  let next = 0
  const source: QueueSource = {
    item: async ({ id }) => ({ title: `Task ${id}`, url: `https://x/t/${id}`, contextMarkdown: `# ${id}` }),
    post: async (input) => { posted.push(input); return { commentId: `c${posted.length}` } },
    replies: async ({ id }) => { replyReads.push(id); return { replies: [{ id: 'r1', author: 'Ann', text: 'from the card', images: [] }], lastId: 'r1' } },
  }
  const deps: QueueEngineDeps = {
    store,
    runner: { start: async (input) => { requests.push(input.request); const id = `run-${++next}`; runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } }, get: id => runs.get(id), ...(canRetry ? { retry: async (id: string, note?: string) => { retried.push({ id, note }); runs.set(id, { ...runs.get(id)!, status: 'running', error: null }); return { id } } } : {}) },
    source: () => source,
    prepareWorktree: async (_repo, label) => { const worktree = join(dir, 'wt', label); await mkdir(worktree, { recursive: true }); return { worktree } },
    writeContext: async (_pluginId, context, cwd) => { const path = join(cwd, `${context.name}-${next}.md`); await writeFile(path, context.markdown); return path },
    pluginFiles: pluginId => join(dir, 'plugin-data', pluginId),
    backupDir: itemId => join(dir, 'queue-files', itemId),
    needsYou: (_item, reason) => { alerts.push(reason) },
  }
  const engine = createQueueEngine(deps)
  const app = new Elysia().use(queueRoutes(store, engine))
  const post = (path: string, body: unknown) => app.handle(new Request(`http://127.0.0.1:7777${path}`, { method: 'POST', body: JSON.stringify(body), headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' } }))
  const asked = async (evidence: string[]) => {
    const added = await engine.add({ source: 'clickup-board', externalId: '1', repo: '/repo' })
    const runId = store.get(added.id)!.currentRunId!
    const run = blocked(runId, evidence)
    runs.set(runId, run)
    await engine.onRunSettled(run)
    return added.id
  }
  return { engine, store, runs, requests, retried, posted, replyReads, alerts, asked, post, item: (id: string) => store.get(id)! }
}

test('bizQuestionsOf takes only biz: lines without the tag', () => {
  expect(bizQuestionsOf(blocked('r', ['biz: ควรแสดงราคาไหม', '- Biz: อีกข้อ', 'tech: Which key?', 'untagged', 'repo: api', 'biz:']))).toEqual(['ควรแสดงราคาไหม', 'อีกข้อ'])
})

test('techQuestionsOf takes tech: and untagged lines, and leaves out biz, repo and pick lines', () => {
  expect(techQuestionsOf(blocked('r', ['tech: Which key?', 'untagged', 'biz: ราคา', 'repo: api', 'pick: A,B | visualizer/x', 'tech:']))).toEqual(['Which key?', 'untagged'])
})

test('the run request tells the agent what biz: and tech: are for', () => {
  const text = runRequest({ title: 't', url: 'u', contextPath: '/c.md', answerPaths: [], repo: '/repo', worktree: '/w' })
  expect(text).toContain('biz: is only for a product or business decision a non-technical person can answer, written in plain Thai with no technical words. Solve technical problems yourself. If only the owner can answer a technical question, use tech:.')
  expect(runRequest({ title: 't', url: 'u', contextPath: '/c.md', answerPaths: [], repo: '/repo', worktree: '/w', repos: [] })).toContain('tagged biz: or tech:')
})

test('a biz: line posts the question to the source without the tag', async () => {
  const h = harness()
  const id = await h.asked(['biz: ควรแสดงราคาไหม'])
  expect(h.posted).toEqual([{ id: '1', kind: 'ask', lines: ['ควรแสดงราคาไหม'] }])
  expect(h.item(id)).toMatchObject({ state: 'waiting-info', questions: ['ควรแสดงราคาไหม'] })
  expect(h.item(id).askedIn).toBeUndefined()
})

test('an untagged line posts nothing and waits for the owner in Shikidan', async () => {
  const h = harness()
  const id = await h.asked(['Which database?'])
  expect(h.posted).toEqual([])
  expect(h.item(id)).toMatchObject({ state: 'waiting-info', askedIn: 'shikidan', questions: ['Which database?'], currentRunId: null })
  expect(h.alerts).toEqual(['Technical question'])
})

test('a mix shows the technical questions first and posts nothing until answered', async () => {
  const h = harness()
  const id = await h.asked(['biz: ควรแสดงราคาไหม', 'tech: Which database?'])
  expect(h.posted).toEqual([])
  expect(h.item(id)).toMatchObject({ state: 'waiting-info', askedIn: 'shikidan', questions: ['Which database?'] })
  await h.engine.answer(id, 'Use the test one')
  expect(h.posted).toEqual([])
  expect(h.retried).toHaveLength(1)
  expect(h.retried[0]!.id).toBe('run-1')
  for (const part of ['Use the test one', 'Which database?', 'ควรแสดงราคาไหม']) expect(h.retried[0]!.note).toContain(part)
  expect(await readFile(h.item(id).answerPaths[0]!, 'utf8')).toContain('ควรแสดงราคาไหม')
  expect(h.item(id).recoverBuild?.openBiz).toBeUndefined()
  const again = h.item(id).currentRunId!
  const run = blocked(again, ['biz: ควรแสดงราคาไหม'])
  h.runs.set(again, run)
  await h.engine.onRunSettled(run)
  expect(h.posted).toEqual([{ id: '1', kind: 'ask', lines: ['ควรแสดงราคาไหม'] }])
  expect(h.item(id).askedIn).toBeUndefined()
})

test('a run retried in Studio that turns a Shikidan question into a biz post clears askedIn, so the card reply is read', async () => {
  const h = harness()
  const id = await h.asked(['tech: Which database?'])
  expect(h.item(id).askedIn).toBe('shikidan')
  const runId = h.item(id).runIds.at(-1)!
  const retried: RunView = { ...blocked(runId, ['biz: ราคา?']), attempts: [{ ...blocked(runId, []).attempts[0]!, number: 1, startedAt: 3, endedAt: 4, result: { outcome: 'blocked', summary: 's', evidence: ['biz: ราคา?'] } }] }
  h.runs.set(runId, retried)
  await h.engine.onRunSettled(retried)
  expect(h.posted).toEqual([{ id: '1', kind: 'ask', lines: ['ราคา?'] }])
  expect(h.item(id)).toMatchObject({ state: 'waiting-info', questions: ['ราคา?'] })
  expect(h.item(id).askedIn).toBeUndefined()
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
  expect(h.replyReads).toEqual(['1'])
})

test('checkReplies skips Shikidan questions and still reads an item with no askedIn', async () => {
  const h = harness()
  const ours = await h.asked(['Which database?'])
  expect(await h.engine.checkReplies()).toEqual({ checked: 0, resumed: 0 })
  expect(h.replyReads).toEqual([])
  expect(h.item(ours).state).toBe('waiting-info')
  await h.store.update(ours, { state: 'waiting-pick', lastSeenId: 'c1' })
  await h.store.update(ours, { state: 'waiting-info' })
  expect(h.item(ours).askedIn).toBeUndefined()
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
  expect(h.replyReads).toEqual(['1'])
})

test('the answer route refuses a card that is not waiting for the owner, with a 409', async () => {
  const h = harness()
  const asking = await h.asked(['biz: ถามการ์ด'])
  const refused = await h.post(`/api/queue/${asking}/answer`, { text: 'hello' })
  expect(refused.status).toBe(409)
  expect(await refused.json()).toEqual({ error: 'It is not waiting for your answer' })
  await h.store.update(asking, { state: 'building' })
  expect((await h.post(`/api/queue/${asking}/answer`, { text: 'hello' })).status).toBe(409)
  expect((await h.post('/api/queue/nope/answer', { text: 'hello' })).status).toBe(404)
})

test('the answer route refuses empty, blank and over-long text', async () => {
  const h = harness()
  const id = await h.asked(['Which database?'])
  for (const body of [{}, { text: '' }, { text: '  \n ' }, { text: 7 }, { text: 'x'.repeat(8001) }]) {
    expect((await h.post(`/api/queue/${id}/answer`, body)).status).toBe(400)
  }
  expect(h.item(id).state).toBe('waiting-info')
  expect(h.item(id).answerPaths).toEqual([])
})

test('a valid answer stores the file with its backup, continues the same run and posts nothing to the source', async () => {
  const h = harness()
  const id = await h.asked(['Which database?'])
  const worktree = h.item(id).worktree
  const response = await h.post(`/api/queue/${id}/answer`, { text: '  The test one  ' })
  expect(response.status).toBe(200)
  const item = h.item(id)
  expect(item.answerPaths).toHaveLength(1)
  const path = item.answerPaths[0]!
  const markdown = await readFile(path, 'utf8')
  for (const part of ['Which database?', '### Owner', 'The test one']) expect(markdown).toContain(part)
  expect(await readFile(join(dir, 'queue-files', id, path.split('/').at(-1)!), 'utf8')).toBe(markdown)
  expect(item.state).toBe('building')
  expect(item.currentRunId).toBe('run-1')
  expect(item.runIds).toEqual(['run-1'])
  expect(item.worktree).toBe(worktree)
  expect(item.questions).toEqual([])
  expect(item.askedIn).toBeUndefined()
  expect(h.requests).toHaveLength(1)
  expect(h.retried).toHaveLength(1)
  expect(h.retried[0]!.id).toBe('run-1')
  expect(h.retried[0]!.note).toContain('The test one')
  expect(h.posted).toEqual([])
})

test('a runner that cannot retry falls back to a reply-style resume with a new run, dropping old ship progress', async () => {
  const h = harness({ canRetry: false })
  const id = await h.asked(['Which database?'])
  await h.store.update(id, { land: { stage: 'uat', stages: {}, plan: [] } })
  await h.engine.answer(id, 'The test one')
  expect(h.item(id)).toMatchObject({ state: 'building', currentRunId: 'run-2', runIds: ['run-1', 'run-2'] })
  expect(h.item(id).land).toBeUndefined()
  expect(h.requests.at(-1)).toContain(h.item(id).answerPaths[0]!)
})

test('a requeue clears askedIn', async () => {
  const h = harness()
  const id = await h.asked(['Which database?'])
  await h.engine.requeue(id)
  expect(h.item(id).askedIn).toBeUndefined()
})

test('stored items with none of the new fields still load, and a bad askedIn is left out', async () => {
  const path = join(dir, 'stored.json')
  const base = { source: 's', externalId: '1', title: 't', url: 'u', repo: '/r', flowId: null, state: 'waiting-info', worktree: '/w', contextPath: null, answerPaths: [], runIds: ['r1'], currentRunId: null, questions: ['q'], lastSeenId: 'c1', error: null, createdAt: 1, updatedAt: 1 }
  await writeFile(path, JSON.stringify({ items: [{ ...base, id: 'old' }, { ...base, id: 'landing', state: 'landing', land: { stage: 'uat', stages: {}, plan: [] } }, { ...base, id: 'bad', askedIn: 'clickup' }] }))
  const store = createQueueStore(path)
  expect(store.list().map(item => item.id)).toEqual(['old', 'landing'])
})
