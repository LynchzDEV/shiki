import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { createJobManager, type JobManager } from '../server/jobs'
import { fakeEchoResolver } from '../server/jobs-engine-iface'
import { createWorkflowStore, defaultWorkflow } from '../server/workflows'
import { classicWorkflow } from './support/classic-workflow'
import { createWorkflowRunner, LIVE_STATUSES, type WorkflowRunner } from '../server/workflow-runner'
import { studioRoutes } from '../server/routes/studio'
import { initScratchGitRepo } from './support/scratch-git-repo'

let dir: string, app: Elysia, manager: JobManager, runner: WorkflowRunner, repos: string[]
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-studio-api-'))
  process.env.SKD_CONFIG_DIR = dir
  repos = []
  const store = createWorkflowStore(dir)
  manager = createJobManager()
  runner = createWorkflowRunner({ manager, resolver: fakeEchoResolver, store, requireApproval: async () => true })
  app = new Elysia().use(studioRoutes(store, runner))
})
afterEach(async () => {
  for (const run of runner.list()) if (LIVE_STATUSES.has(run.status)) await runner.stop(run.id)
  for (const job of manager.listJobs()) if (job.status === 'running') await manager.killJob(job.id)
  for (let i = 0; i < 200 && manager.listJobs().some(job => job.status === 'running'); i++) await Bun.sleep(20)
  delete process.env.SKD_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
  for (const repo of repos) await rm(repo, { recursive: true, force: true })
})
function request(path: string, body?: unknown, origin = 'http://localhost') {
  return app.handle(new Request(`${origin}/api/studio${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
}
function remove(path: string, origin = 'http://localhost') {
  return app.handle(new Request(`${origin}/api/studio${path}`, { method: 'DELETE' }))
}
function post(path: string, body: unknown, headers: Record<string, string>) {
  return app.handle(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))
}
function get(path: string) {
  return app.handle(new Request(`http://localhost${path}`))
}
async function scratchRepo() {
  const repo = await mkdtemp(join(homedir(), 'mc-studio-routes-repo-'))
  repos.push(repo)
  await initScratchGitRepo(repo)
  return repo
}
async function runBody(label = 'fixture') {
  return { cwd: await scratchRepo(), request: 'x', label }
}
async function chatRoot() {
  const created = await manager.createJob({ engine: 'claude', cwd: await scratchRepo(), prompt: 'Run the shipping workflow', label: 'Shipping chat', purpose: 'chat' }, fakeEchoResolver)
  if (!created.ok) throw new Error(created.error)
  for (let i = 0; i < 200 && manager.getJob(created.job.id)?.status === 'running'; i++) await Bun.sleep(20)
  return created.job.id
}

test('Studio configuration and execution refuse a rebinding host', async () => {
  const rebind = 'http://rebind.example'
  for (const path of ['/workflows', '/connections', '/policy', '/runs', '/drafts', '/drafts/unknown']) expect((await request(path, undefined, rebind)).status).toBe(403)
  expect((await request('/workflows', {}, rebind)).status).toBe(403)
  expect((await request('/drafts', {description:'Build a flow'}, rebind)).status).toBe(403)
  expect((await request('/drafts/unknown/stop', {}, rebind)).status).toBe(403)
})

test('the draft endpoint returns JSON when no workflow is being drafted', async () => {
  const response = await request('/drafts')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ draft: null })
})

test('users can duplicate the default, save revisions and select a pinned default', async () => {
  const saved = await request('/workflows', { workflow: { ...defaultWorkflow(), id: 'custom', name: 'Custom' } })
  expect(saved.status).toBe(200)
  const graph = await saved.json()
  expect((await request('/default', { id: graph.id, revision: graph.revision })).status).toBe(200)
  const listing = await (await request('/workflows')).json()
  expect(listing.selected.id).toBe('custom')
  const invalid = await request('/workflows', { workflow: { ...graph, entry: 'execute' }, expectedRevision: graph.revision })
  expect(invalid.status).toBe(400)
})

test('custom agent setup exposes references, never the referenced credential value', async () => {
  process.env.SKD_FIXTURE_KEY = 'sensitive-test-value'
  try {
    expect((await request('/connections', { id: 'qwen', name: 'Qwen', adapter: 'acp', command: 'qwen', args: ['--acp'], env: { API_KEY: 'SKD_FIXTURE_KEY' } })).status).toBe(200)
    const body = await (await request('/connections')).text()
    expect(body).toContain('SKD_FIXTURE_KEY')
    expect(body).not.toContain('sensitive-test-value')
  } finally { delete process.env.SKD_FIXTURE_KEY }
})

test('a saved connection can be removed while built-ins stay', async () => {
  expect((await request('/connections', { id: 'qwen', name: 'Qwen', adapter: 'acp', command: 'qwen', args: ['--acp'] })).status).toBe(200)
  const removed = await remove('/connections/qwen')
  expect(removed.status).toBe(200)
  expect(await removed.json()).toEqual({ ok: true })
  expect((await (await request('/connections')).json()).connections).toEqual([])
  const builtin = await remove('/connections/claude')
  expect(builtin.status).toBe(400)
  expect((await builtin.json()).error).toContain('built-in')
  expect((await remove('/connections/qwen', 'http://rebind.example')).status).toBe(403)
})

test('starting a run for a chat that does not exist is refused', async () => {
  const response = await request('/runs', { cwd: dir, request: 'Ship it', label: 'ship', chat: 'no-such-chat', chatTurn: 'no-such-turn', engine: 'claude' })
  expect(response.status).toBe(400)
  expect((await response.json()).error).toContain('Chat not found')
})

test('a browser start is approved by the user; a CLI start waits', async () => {
  const browser = await post('/api/studio/runs', await runBody(), { 'sec-fetch-site': 'same-origin' })
  expect((await browser.json()).versions[0].approvedVia).toBe('user')
  const cli = await post('/api/studio/runs', await runBody('cli'), {})
  expect((await cli.json()).status).toBe('awaiting-approval')
})

test('approve records drawer for browser requests and conversation for CLI requests', async () => {
  const run = await (await post('/api/studio/runs', await runBody(), {})).json()
  const approved = await (await post(`/api/studio/runs/${run.id}/approve`, {}, { 'sec-fetch-site': 'same-origin' })).json()
  expect(approved.versions[0].approvedVia).toBe('drawer')
  const chatId = await chatRoot()
  const chatRun = await (await post('/api/studio/runs', { ...(await runBody('chat')), chat: chatId }, {})).json()
  const relayed = await (await post(`/api/studio/runs/${chatRun.id}/approve`, { chat: chatId }, {})).json()
  expect(relayed.versions[0].approvedVia).toBe('conversation')
})

test('a relayed approval for another session is refused with 403', async () => {
  const chatId = await chatRoot()
  const run = await (await post('/api/studio/runs', { ...(await runBody()), chat: chatId }, {})).json()
  const response = await post(`/api/studio/runs/${run.id}/approve`, { chat: 'someone-else' }, {})
  expect(response.status).toBe(403)
  expect((await (await get(`/api/studio/runs/${run.id}`)).json()).status).toBe('awaiting-approval')
})

test('approving twice answers 409 the second time', async () => {
  const run = await (await post('/api/studio/runs', await runBody(), {})).json()
  await post(`/api/studio/runs/${run.id}/approve`, {}, { 'sec-fetch-site': 'same-origin' })
  expect((await post(`/api/studio/runs/${run.id}/approve`, {}, { 'sec-fetch-site': 'same-origin' })).status).toBe(409)
})

test('approving a version that is not the pending one answers 409', async () => {
  const run = await (await post('/api/studio/runs', await runBody(), {})).json()
  expect((await post(`/api/studio/runs/${run.id}/approve`, { version: 2 }, { 'sec-fetch-site': 'same-origin' })).status).toBe(409)
  expect((await post(`/api/studio/runs/${run.id}/approve`, { version: 1 }, { 'sec-fetch-site': 'same-origin' })).status).toBe(200)
})

test('rejecting a waiting flow stops it', async () => {
  const run = await (await post('/api/studio/runs', await runBody(), {})).json()
  const rejected = await (await post(`/api/studio/runs/${run.id}/reject`, {}, { 'sec-fetch-site': 'same-origin' })).json()
  expect(rejected.status).toBe('stopped')
  expect(rejected.versions[0].state).toBe('rejected')
})

test('pause and resume answer with the run, and a wrong state or unknown run is refused', async () => {
  const run = await (await post('/api/studio/runs', await runBody(), {})).json()
  expect((await post(`/api/studio/runs/${run.id}/pause`, {}, {})).status).toBe(409)
  await post(`/api/studio/runs/${run.id}/approve`, {}, { 'sec-fetch-site': 'same-origin' })
  expect((await (await post(`/api/studio/runs/${run.id}/pause`, {}, {})).json()).status).toBe('paused')
  expect((await (await post(`/api/studio/runs/${run.id}/resume`, {}, {})).json()).status).toBe('running')
  expect((await post('/api/studio/runs/no-such-run/resume', {}, {})).status).toBe(404)
})

test('dismiss refuses a run that is not failed or blocked, and an unknown run', async () => {
  const run = await (await post('/api/studio/runs', await runBody(), {})).json()
  const waiting = await post(`/api/studio/runs/${run.id}/dismiss`, {}, { 'sec-fetch-site': 'same-origin' })
  expect(waiting.status).toBe(409)
  expect((await waiting.json()).error).toBe('Only failed or blocked runs can be dismissed')
  expect((await post('/api/studio/runs/no-such-run/dismiss', {}, { 'sec-fetch-site': 'same-origin' })).status).toBe(404)
})

test('the run list filters by chat and terminal', async () => {
  const chatId = await chatRoot()
  const chatRun = await (await post('/api/studio/runs', { ...(await runBody('chat')), chat: chatId }, {})).json()
  await post('/api/studio/runs', await runBody('studio'), {})
  const chatRunIds = [chatRun.id]
  const list = await (await get(`/api/studio/runs?chat=${chatId}`)).json()
  expect(list.runs.length).toBe(1)
  expect(list.runs.every((run: { id: string }) => chatRunIds.includes(run.id))).toBe(true)
  expect(list.runs[0]).toMatchObject({ status: 'awaiting-approval', pending: true, origin: { where: 'chat' }, workingNodeIds: [] })
  expect((await (await get('/api/studio/runs')).json()).runs.length).toBe(2)
  expect((await (await get('/api/studio/runs?terminal=no-such-terminal')).json()).runs).toEqual([])
})

function withMigrate() {
  const graph = defaultWorkflow()
  graph.nodes.push({ ...graph.nodes.find(node => node.id === 'execute')!, id: 'migrate', title: 'Migrate', instructions: 'Write the migration' })
  graph.edges = graph.edges.filter(edge => edge.source !== 'verify-plan').concat({ source: 'verify-plan', target: 'migrate', outcome: 'pass' }, { source: 'migrate', target: 'execute', outcome: 'pass' })
  return graph
}

test('a drafted graph starts as a drafted flow waiting for approval, and a graph that breaks a rule is refused with the rule', async () => {
  const drafted = await post('/api/studio/runs', { ...(await runBody()), graph: { ...classicWorkflow(), id: 'drafted-export', name: 'Drafted export' } }, {})
  expect(drafted.status).toBe(200)
  expect(await drafted.json()).toMatchObject({ status: 'awaiting-approval', origin: { source: 'drafted' } })
  const unsafe = await post('/api/studio/runs', { ...(await runBody()), graph: { ...classicWorkflow(), id: 'unsafe', name: 'Unsafe', edges: [{ source: 'plan', target: 'execute', outcome: 'pass' }] } }, {})
  expect(unsafe.status).toBe(400)
  expect((await unsafe.json()).error).toContain('requires a verified plan')
})

test('a big change to a running flow waits for approval, and a second change is refused with 409', async () => {
  const chatId = await chatRoot()
  const run = await (await post('/api/studio/runs', { ...(await runBody()), chat: chatId }, { 'sec-fetch-site': 'same-origin' })).json()
  const proposed = await post(`/api/studio/runs/${run.id}/changes`, { graph: withMigrate(), reason: 'Needs a migration', chat: chatId }, {})
  expect(proposed.status).toBe(200)
  const changed = await proposed.json()
  expect(changed.versions.at(-1)).toMatchObject({ number: 2, size: 'big', state: 'pending', reason: 'Needs a migration' })
  const second = await post(`/api/studio/runs/${run.id}/changes`, { graph: withMigrate(), reason: 'Again' }, { 'sec-fetch-site': 'same-origin' })
  expect(second.status).toBe(409)
  expect((await second.json()).error).toBe('A change is already waiting')
})

test('a change relayed from another session is refused with 403 and leaves the run as it was', async () => {
  const run = await (await post('/api/studio/runs', await runBody(), { 'sec-fetch-site': 'same-origin' })).json()
  const response = await post(`/api/studio/runs/${run.id}/changes`, { graph: withMigrate(), reason: 'Needs a migration', terminalId: 'someone-else' }, {})
  expect(response.status).toBe(403)
  expect((await (await get(`/api/studio/runs/${run.id}`)).json()).versions).toHaveLength(1)
})

test('a change without a reason is refused with 400', async () => {
  const run = await (await post('/api/studio/runs', await runBody(), { 'sec-fetch-site': 'same-origin' })).json()
  expect((await post(`/api/studio/runs/${run.id}/changes`, { graph: withMigrate(), reason: '  ' }, { 'sec-fetch-site': 'same-origin' })).status).toBe(400)
})

test('the drawer saves a flow under a name taken from its label, once', async () => {
  const run = await (await post('/api/studio/runs', await runBody('Add CSV export'), { 'sec-fetch-site': 'same-origin' })).json()
  const saved = await post(`/api/studio/runs/${run.id}/save`, {}, { 'sec-fetch-site': 'same-origin' })
  expect(saved.status).toBe(200)
  const workflow = await saved.json()
  expect(workflow).toMatchObject({ id: 'add-csv-export', name: 'Add CSV export' })
  expect(workflow.revision).toMatch(/^[a-f0-9]{24}$/)
  expect((await (await get('/api/studio/workflows')).json()).workflows.map((graph: { id: string }) => graph.id)).toContain('add-csv-export')
  const again = await post(`/api/studio/runs/${run.id}/save`, {}, { 'sec-fetch-site': 'same-origin' })
  expect(again.status).toBe(409)
  expect((await again.json()).error).toBe('A workflow with that name exists')
})

test('a flow whose label starts with a digit is saved with a flow- prefix', async () => {
  const run = await (await post('/api/studio/runs', await runBody('2nd pass: Tidy imports!'), { 'sec-fetch-site': 'same-origin' })).json()
  expect(await (await post(`/api/studio/runs/${run.id}/save`, {}, { 'sec-fetch-site': 'same-origin' })).json()).toMatchObject({ id: 'flow-2nd-pass-tidy-imports' })
})

test('a flow whose label has no latin letters is saved under its run id', async () => {
  const run = await (await post('/api/studio/runs', await runBody('เพิ่มปุ่มส่งออก'), { 'sec-fetch-site': 'same-origin' })).json()
  expect(await (await post(`/api/studio/runs/${run.id}/save`, {}, { 'sec-fetch-site': 'same-origin' })).json()).toMatchObject({ id: `flow-${run.id.slice(0, 8)}`, name: 'เพิ่มปุ่มส่งออก' })
})

test('saving a flow is refused outside the drawer', async () => {
  const run = await (await post('/api/studio/runs', await runBody('Add CSV export'), { 'sec-fetch-site': 'same-origin' })).json()
  const response = await post(`/api/studio/runs/${run.id}/save`, {}, {})
  expect(response.status).toBe(403)
  expect((await response.json()).error).toBe('Save from the drawer')
  expect((await (await get('/api/studio/workflows')).json()).workflows.map((graph: { id: string }) => graph.id)).not.toContain('add-csv-export')
})

test('a token caller is never the drawer, even with a same-origin header', async () => {
  const token = { 'sec-fetch-site': 'same-origin', authorization: 'Bearer fixture-token' }
  const chatId = await chatRoot()
  const run = await (await post('/api/studio/runs', { ...(await runBody()), chat: chatId }, {})).json()
  const response = await post(`/api/studio/runs/${run.id}/approve`, { chat: 'someone-else' }, token)
  expect(response.status).toBe(403)
  expect((await (await get(`/api/studio/runs/${run.id}`)).json()).status).toBe('awaiting-approval')
  const started = await (await post('/api/studio/runs', await runBody('token start'), token)).json()
  expect(started.status).toBe('awaiting-approval')
  expect(started.versions[0].approvedVia).toBeNull()
})

test('reading runs never returns the graph, agents or skills of a version', async () => {
  const run = await (await post('/api/studio/runs', await runBody(), { 'sec-fetch-site': 'same-origin' })).json()
  const proposed = await post(`/api/studio/runs/${run.id}/changes`, { graph: withMigrate(), reason: 'Needs a migration' }, { 'sec-fetch-site': 'same-origin' })
  expect(proposed.status).toBe(200)
  for (const version of (await proposed.json()).versions) expect(Object.keys(version)).not.toContain('graph')
  const read = await (await get(`/api/studio/runs/${run.id}`)).json()
  expect(read.versions).toHaveLength(2)
  for (const version of read.versions) {
    expect(version).not.toHaveProperty('graph')
    expect(version).not.toHaveProperty('agents')
    expect(version).not.toHaveProperty('skills')
  }
  expect(read.versions[1]).toMatchObject({ number: 2, size: 'big', state: 'pending', reason: 'Needs a migration' })
  const listed = await (await get('/api/studio/runs')).json()
  for (const item of listed.runs) for (const version of item.versions ?? []) {
    expect(version).not.toHaveProperty('graph')
    expect(version).not.toHaveProperty('agents')
    expect(version).not.toHaveProperty('skills')
  }
})

test('the owning terminal reports an In Session step with its token; the browser cannot', async () => {
  const store = createWorkflowStore(dir)
  const cwd = await scratchRepo()
  const graph = await store.save(classicWorkflow())
  const terminal = { id: 'terminal-a', engine: 'claude', cwd, pid: 1, createdAt: 0, title: 'Terminal', sessionId: null, inSessionAware: true as const, workflow: { id: graph.id, name: graph.name, revision: graph.revision, selectedDefault: true } }
  runner = createWorkflowRunner({ manager, resolver: fakeEchoResolver, store, requireApproval: async () => true, terminals: { get: id => id === terminal.id ? terminal : undefined } })
  app = new Elysia().use(studioRoutes(store, runner))
  const token = { authorization: 'Bearer fixture-token' }
  const run = await (await post('/api/studio/runs', { cwd, request: 'x', label: 'fixture', terminalId: terminal.id }, token)).json()
  expect((await post(`/api/studio/runs/${run.id}/approve`, { terminalId: terminal.id }, token)).status).toBe(200)
  const report = { outcome: 'pass', summary: 'Planned', evidence: ['plan written'], output: 'THE PLAN', terminalId: terminal.id }
  const fromDrawer = await post(`/api/studio/runs/${run.id}/steps/plan`, report, { 'sec-fetch-site': 'same-origin' })
  expect(fromDrawer.status).toBe(403)
  const reported = await post(`/api/studio/runs/${run.id}/steps/plan`, report, token)
  expect(reported.status).toBe(200)
  const body = await reported.json()
  expect(body.attempts[0]).toMatchObject({ nodeId: 'plan', status: 'settled', output: 'THE PLAN' })
  expect(body.versions[0]).not.toHaveProperty('graph')
})

test('the owner reads a waiting In Session step with its token, and it is gone once reported', async () => {
  const store = createWorkflowStore(dir)
  const cwd = await scratchRepo()
  const graph = await store.save(classicWorkflow())
  const terminal = { id: 'terminal-a', engine: 'claude', cwd, pid: 1, createdAt: 0, title: 'Terminal', sessionId: null, inSessionAware: true as const, workflow: { id: graph.id, name: graph.name, revision: graph.revision, selectedDefault: true } }
  runner = createWorkflowRunner({ manager, resolver: fakeEchoResolver, store, requireApproval: async () => true, terminals: { get: id => id === terminal.id ? terminal : undefined } })
  app = new Elysia().use(studioRoutes(store, runner))
  const token = { authorization: 'Bearer fixture-token' }
  const run = await (await post('/api/studio/runs', { cwd, request: 'x', label: 'fixture', terminalId: terminal.id }, token)).json()
  expect((await post(`/api/studio/runs/${run.id}/approve`, { terminalId: terminal.id }, token)).status).toBe(200)
  const step = await get(`/api/studio/runs/${run.id}/steps/plan`)
  expect(step.status).toBe(200)
  expect(await step.json()).toMatchObject({ runId: run.id, nodeId: 'plan', title: 'Plan', kind: 'plan', prompt: expect.stringContaining('You are doing this step In Session'), waitingSince: expect.any(Number) })
  expect((await get(`/api/studio/runs/${run.id}/steps/verify-plan`)).status).toBe(404)
  await post(`/api/studio/runs/${run.id}/steps/plan`, { outcome: 'pass', summary: 'Planned', evidence: ['plan written'], terminalId: terminal.id }, token)
  expect((await get(`/api/studio/runs/${run.id}/steps/plan`)).status).toBe(404)
})

test('only the drawer reminds the owning terminal of a waiting step', async () => {
  const store = createWorkflowStore(dir)
  const cwd = await scratchRepo()
  const graph = await store.save(classicWorkflow())
  const terminal = { id: 'terminal-a', engine: 'claude', cwd, pid: 1, createdAt: 0, title: 'Terminal', sessionId: null, inSessionAware: true as const, workflow: { id: graph.id, name: graph.name, revision: graph.revision, selectedDefault: true } }
  const writes: string[] = []
  runner = createWorkflowRunner({ manager, resolver: fakeEchoResolver, store, requireApproval: async () => true, terminals: { get: id => id === terminal.id ? terminal : undefined, write: (_id, data) => { writes.push(data); return true } } })
  app = new Elysia().use(studioRoutes(store, runner))
  const token = { authorization: 'Bearer fixture-token' }
  const run = await (await post('/api/studio/runs', { cwd, request: 'x', label: 'fixture', terminalId: terminal.id }, token)).json()
  expect((await post(`/api/studio/runs/${run.id}/approve`, { terminalId: terminal.id }, token)).status).toBe(200)
  const fromSession = await post(`/api/studio/runs/${run.id}/steps/plan/remind`, { terminalId: terminal.id }, {})
  expect(fromSession.status).toBe(403)
  expect(await fromSession.json()).toEqual({ error: 'Remind from the drawer' })
  expect((await post(`/api/studio/runs/${run.id}/steps/plan/remind`, {}, { ...token, 'sec-fetch-site': 'same-origin' })).status).toBe(403)
  expect(writes).toEqual([])
  const reminded = await post(`/api/studio/runs/${run.id}/steps/plan/remind`, {}, { 'sec-fetch-site': 'same-origin' })
  expect(reminded.status).toBe(200)
  const body = await reminded.json()
  expect(body.id).toBe(run.id)
  expect(body.versions[0]).not.toHaveProperty('graph')
  expect(writes).toHaveLength(2)
  expect(writes[0]).toContain(`/api/studio/runs/${run.id}/steps/plan`)
  expect((await post(`/api/studio/runs/${run.id}/steps/verify-plan/remind`, {}, { 'sec-fetch-site': 'same-origin' })).status).toBe(409)
})

test('the default flow choice is AI design until a saved workflow is chosen, and can be switched back', async () => {
  const first = await (await get('/api/studio/workflows')).json()
  expect(first).toMatchObject({ design: true, selected: { id: 'default' } })
  expect((await request('/default', { id: 'default', revision: first.selected.revision })).status).toBe(200)
  expect((await (await get('/api/studio/workflows')).json()).design).toBe(false)
  expect((await request('/default', { design: true })).status).toBe(200)
  expect((await (await get('/api/studio/workflows')).json()).design).toBe(true)
})
