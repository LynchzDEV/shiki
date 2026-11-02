import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import { createQueueEngine } from '../server/queue-engine'
import type { RunView } from '../server/queue-prompts'
import { createQueueStore, type QueueItem } from '../server/queue-store'
import { queueRoutes } from '../server/routes/queue'
import type { LandStage } from '../server/workflows'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-queue-land-routes-'))
  process.env.SKD_CONFIG_DIR = join(dir, 'config')
})
afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

async function script(name: string, body: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

const run: RunView = {
  id: 'run-1', status: 'done', error: null,
  workflow: { nodes: [{ id: 'plan', title: 'Plan the change' } as never] },
  attempts: [{ nodeId: 'plan', number: 1, status: 'settled', result: { outcome: 'pass', summary: 'Planned it', evidence: ['bun test: 12 pass'] } } as never],
}

async function setup() {
  const store = createQueueStore(join(dir, 'queue.json'))
  const engine = createQueueEngine({
    store, runner: { start: async () => ({ id: 'run-1' }), get: id => (id === 'run-1' ? run : undefined) },
    source: () => ({ item: async () => ({ title: 't', url: 'u', contextMarkdown: '' }), post: async () => ({ commentId: 'c' }), replies: async () => ({ replies: [], lastId: null }) }),
    prepareWorktree: async () => ({ worktree: dir }), writeContext: async () => '', pluginFiles: () => dir, backupDir: () => dir, needsYou: () => {},
  })
  const app = new Elysia().use(queueRoutes(store, engine))
  const call = (path: string, init: RequestInit = {}) => app.handle(new Request(`http://127.0.0.1:7777${path}`, { ...init, headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' } }))
  const post = (path: string, body: unknown = {}) => call(path, { method: 'POST', body: JSON.stringify(body) })
  const worktree = join(dir, 'wt')
  await mkdir(join(worktree, '.mission-control', 'land'), { recursive: true })
  const park = async (plan: LandStage[], patch: Partial<QueueItem>): Promise<QueueItem> => {
    const added = await store.add({ source: 'clickup-board', externalId: '1', title: 'Fix the badge', url: 'https://x/t/1', repo: '/repo', flowId: null }, 'end')
    return store.update(added.id, { worktree, runIds: ['run-1'], land: { stage: plan[0]!.id, stages: {}, plan }, ...patch })
  }
  return { store, engine, call, post, park, worktree }
}

const stage = (id: string, command: string, over: Partial<LandStage> = {}): LandStage => ({ id, run: 'button', label: 'Deploy prod', command: { command, args: [], timeoutSeconds: 30 }, env: {}, ...over })

test('starting a stage needs confirm: true, then ships it', async () => {
  const h = await setup()
  const check = await script('check.sh', 'echo fine')
  const ship = await script('ship.sh', 'echo shipped-it')
  const item = await h.park([stage('prod', ship, { preflight: { command: check, args: [], timeoutSeconds: 30 } })], { state: 'awaiting-stage' })
  await h.engine.refreshPreflight(item.id, 'prod')
  expect((await h.post(`/api/queue/${item.id}/land/prod/start`, {})).status).toBe(400)
  expect((await h.post(`/api/queue/${item.id}/land/prod/start`, { confirm: false })).status).toBe(400)
  const started = await h.post(`/api/queue/${item.id}/land/prod/start`, { confirm: true })
  expect(started.status).toBe(200)
  expect((await started.json()).item.state).toBe('landing')
  await h.engine.landIdle()
  expect(h.store.get(item.id)!.state).toBe('landed')
})

test('start, preflight and retry answer 404 for an unknown item and 409 for the wrong state', async () => {
  const h = await setup()
  const ship = await script('ship.sh', 'exit 0')
  const item = await h.park([stage('prod', ship)], { state: 'ready' })
  expect((await h.post('/api/queue/nope/land/prod/start', { confirm: true })).status).toBe(404)
  const wrong = await h.post(`/api/queue/${item.id}/land/prod/start`, { confirm: true })
  expect(wrong.status).toBe(409)
  expect((await wrong.json()).error).toBe('It is ready now')
  expect((await h.post(`/api/queue/${item.id}/land/prod/preflight`)).status).toBe(409)
  const retry = await h.post(`/api/queue/${item.id}/land/retry`)
  expect(retry.status).toBe(409)
  expect((await retry.json()).error).toBe('There is no stage to retry')
})

test('preflight refresh returns the item with the new preflight', async () => {
  const h = await setup()
  const check = await script('check.sh', 'echo "# Ready\\nSafety: prod"')
  const ship = await script('ship.sh', 'exit 0')
  const item = await h.park([stage('prod', ship, { preflight: { command: check, args: [], timeoutSeconds: 30 } })], { state: 'awaiting-stage' })
  const refreshed = await (await h.post(`/api/queue/${item.id}/land/prod/preflight`)).json()
  expect(refreshed.item.land.stages.prod.preflight).toMatchObject({ exitCode: 0 })
})

test('retry re-runs a failed stage and the log shows its output', async () => {
  const h = await setup()
  const ship = await script('ship.sh', `echo "deploy log line"\nif [ -f ${dir}/fixed ]; then exit 0; fi\nexit 1`)
  const item = await h.park([stage('prod', ship, { run: 'auto' })], { state: 'failed', error: 'x' })
  expect((await h.call(`/api/queue/${item.id}/land/prod/log`)).status).toBe(404)
  await h.engine.retryStage(item.id)
  await h.engine.landIdle()
  expect(h.store.get(item.id)!.state).toBe('failed')
  await writeFile(join(dir, 'fixed'), '')
  expect((await h.post(`/api/queue/${item.id}/land/retry`)).status).toBe(200)
  await h.engine.landIdle()
  expect(h.store.get(item.id)!.state).toBe('landed')
  const log = await h.call(`/api/queue/${item.id}/land/prod/log`)
  expect(log.headers.get('content-type')).toContain('text/plain')
  expect(await log.text()).toBe('deploy log line\n')
  expect((await h.call(`/api/queue/${item.id}/land/other/log`)).status).toBe(404)
})

test('the report lists the runs, each step outcome and summary, and every land stage report', async () => {
  const h = await setup()
  const ship = await script('ship.sh', 'exit 0')
  await writeFile(join(h.worktree, '.mission-control', 'land', 'uat.md'), '## UAT\n\nAll green.\n')
  const item = await h.park([stage('uat', ship, { run: 'auto', label: undefined }), stage('prod', ship)], {
    state: 'awaiting-stage',
    land: { stage: 'prod', plan: [stage('uat', ship, { run: 'auto', label: undefined }), stage('prod', ship)], stages: { uat: { status: 'ok', posted: 'c9' }, prod: { status: 'waiting' } } },
  })
  const response = await h.call(`/api/queue/${item.id}/report`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/markdown')
  const report = await response.text()
  expect(report).toContain('# Fix the badge\n\nhttps://x/t/1')
  expect(report).toContain('## Run run-1 (done)')
  expect(report).toContain('### Plan the change (attempt 1): pass\n\nPlanned it\n\n- bun test: 12 pass')
  expect(report).toContain('## uat: ok (update posted: c9)\n\n## UAT\n\nAll green.')
  expect(report).toContain('## Deploy prod: waiting')
  expect((await h.call('/api/queue/nope/report')).status).toBe(404)
})

test('the report of an item with no land stages is just its runs', async () => {
  const h = await setup()
  const added = await h.store.add({ source: 'clickup-board', externalId: '2', title: 'Plain', url: 'u', repo: '/repo', flowId: null }, 'end')
  await h.store.update(added.id, { runIds: ['run-1', 'run-gone'] })
  const report = await (await h.call(`/api/queue/${added.id}/report`)).text()
  expect(report).toContain('## Run run-1 (done)')
  expect(report).toContain('## Run run-gone\n\nThis run is no longer available.')
})
