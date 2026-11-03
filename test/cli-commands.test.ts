import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main, VERSION, type MainDeps } from '../cli/shiki'

let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-cli-commands-config-'))
  process.env.SKD_CONFIG_DIR = configDir
})

afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
})

type Call = { method: string; path: string; query: Record<string, string>; body: unknown }

const ROLES = { plan: { engine: 'claude', model: null }, execute: { engine: 'glm', model: null }, review: { engine: 'codex', model: 'gpt-5' }, autoReview: false }
const GROK_STATE = { models: ['grok-4.7', 'grok-4.5'], current: 'grok-4.7', checkedAt: Date.now() - 3 * 60_000, error: null }
const CONNECTIONS = { builtins: ['claude'], connections: [{ id: 'grok', adapter: 'acp', models: ['grok-custom'] }], models: { grok: ['grok-4.7', 'grok-4.5', 'grok-custom'] }, discovery: { grok: GROK_STATE } }
const JOB = { id: 'job-1', status: 'done', engine: 'claude', label: 'Fix the bug', prompt: 'Fix the bug\nmore', startedAt: Date.now() - 120_000 }

function cannedResponse(method: string, path: string): Response {
  if (method === 'GET' && path === '/api/roles') return Response.json(ROLES)
  if (method === 'GET' && path === '/api/jobs') return Response.json({ jobs: [JOB] })
  if (method === 'GET' && path === '/api/studio/connections') return Response.json(CONNECTIONS)
  if (path.endsWith('/export.md')) return new Response('# Fix the bug\n', { headers: { 'content-type': 'text/markdown' } })
  if (path.endsWith('/log')) return new Response('line one\nline two\n', { headers: { 'content-type': 'text/plain' } })
  return Response.json({ ok: true })
}

function harness(respond: (method: string, path: string) => Response = cannedResponse, stdin = '') {
  const calls: Call[] = []
  let out = ''
  let err = ''
  const deps: MainDeps = {
    fetch: async (request) => {
      const url = new URL(request.url)
      const text = await request.text()
      calls.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: text === '' ? undefined : JSON.parse(text) })
      return respond(request.method, url.pathname)
    },
    stdout: (chunk) => { out += chunk },
    stderr: (chunk) => { err += chunk },
    env: { SKD_CONFIG_DIR: configDir },
    stdin: async () => stdin,
    cwd: '/work/here',
  }
  return { deps, calls, out: () => out, err: () => err }
}

type Row = { argv: string[]; method: string; path: string; query?: Record<string, string>; body?: unknown }

const ROWS: Row[] = [
  { argv: ['status'], method: 'GET', path: '/api/health' },
  { argv: ['status'], method: 'GET', path: '/api/quota' },
  { argv: ['status'], method: 'GET', path: '/api/roles' },
  { argv: ['roles'], method: 'GET', path: '/api/roles' },
  {
    argv: ['roles', 'set', 'execute', 'codex', '--model', 'gpt-5.1'],
    method: 'POST',
    path: '/api/roles',
    body: { plan: { engine: 'claude', model: null }, execute: { engine: 'codex', model: 'gpt-5.1' }, review: { engine: 'codex', model: 'gpt-5' } },
  },
  { argv: ['roles', 'set', 'plan', 'glm'], method: 'POST', path: '/api/roles', body: { plan: { engine: 'glm', model: null }, execute: { engine: 'glm', model: null }, review: { engine: 'codex', model: 'gpt-5' } } },
  { argv: ['models'], method: 'GET', path: '/api/models' },
  { argv: ['providers'], method: 'GET', path: '/api/providers' },
  { argv: ['history'], method: 'GET', path: '/api/history' },
  { argv: ['outcomes', '--chat', 'chat-1'], method: 'GET', path: '/api/outcomes', query: { chat: 'chat-1' } },
  { argv: ['outcomes', '--terminal', 't-1', '--after', '5', '--limit', '10'], method: 'GET', path: '/api/outcomes', query: { terminal: 't-1', after: '5', limit: '10' } },
  { argv: ['attention'], method: 'GET', path: '/api/attention' },
  { argv: ['attention', 'dismiss', 'needs:chat 1'], method: 'POST', path: '/api/attention/needs%3Achat%201/dismiss' },
  { argv: ['terminals'], method: 'GET', path: '/api/terminals' },
  { argv: ['terminal', 'new'], method: 'POST', path: '/api/terminals', body: { engine: 'claude', cwd: '/work/here' } },
  {
    argv: ['terminal', 'new', '--engine', 'codex', '--cwd', '/repo', '--model', 'gpt-5', '--title', 'Build', '--resume', '0a1b2c3d-0000-4000-8000-000000000000', '--workflow', 'ship', '--revision', 'r1'],
    method: 'POST',
    path: '/api/terminals',
    body: { engine: 'codex', cwd: '/repo', model: 'gpt-5', title: 'Build', resumeSessionId: '0a1b2c3d-0000-4000-8000-000000000000', workflowId: 'ship', revision: 'r1' },
  },
  { argv: ['terminal', 'rename', 't-1', 'New name'], method: 'PATCH', path: '/api/terminals/t-1', body: { title: 'New name' } },
  { argv: ['terminal', 'close', 't-1'], method: 'DELETE', path: '/api/terminals/t-1' },
  { argv: ['terminal', 'thread', 't-1'], method: 'GET', path: '/api/terminals/t-1/thread' },
  { argv: ['terminal', 'sessions'], method: 'GET', path: '/api/terminals/sessions', query: { cwd: '/work/here' } },
  { argv: ['terminal', 'sessions', '--cwd', '/repo'], method: 'GET', path: '/api/terminals/sessions', query: { cwd: '/repo' } },
  { argv: ['connections'], method: 'GET', path: '/api/studio/connections' },
  { argv: ['connection', 'probe', 'my-acp'], method: 'POST', path: '/api/studio/connections/my-acp/probe' },
  { argv: ['connection', 'models', 'grok'], method: 'GET', path: '/api/studio/connections' },
  { argv: ['connection', 'models', 'grok', '--refresh'], method: 'POST', path: '/api/studio/connections/grok/models/refresh' },
  { argv: ['flow-approval'], method: 'GET', path: '/api/flow-approval' },
  { argv: ['flow-approval', 'set', 'on'], method: 'PUT', path: '/api/flow-approval', body: { flowApproval: true } },
  { argv: ['flow-approval', 'set', 'false'], method: 'PUT', path: '/api/flow-approval', body: { flowApproval: false } },

  { argv: ['jobs'], method: 'GET', path: '/api/jobs' },
  { argv: ['jobs', '--chat', 'chat-1'], method: 'GET', path: '/api/jobs', query: { chat: 'chat-1' } },
  { argv: ['job', 'new', 'Fix the bug\nsecond line'], method: 'POST', path: '/api/jobs', body: { engine: 'claude', cwd: '/work/here', prompt: 'Fix the bug\nsecond line', label: 'Fix the bug' } },
  {
    argv: ['job', 'new', 'Do it', '--engine', 'glm', '--model', 'glm-5', '--cwd', '/repo', '--label', 'Custom', '--worktree'],
    method: 'POST',
    path: '/api/jobs',
    body: { engine: 'glm', cwd: '/repo', prompt: 'Do it', label: 'Custom', model: 'glm-5', worktree: true },
  },
  { argv: ['job', 'show', 'job-1'], method: 'GET', path: '/api/jobs' },
  { argv: ['job', 'show', 'job-1'], method: 'GET', path: '/api/jobs/job-1/activity' },
  { argv: ['job', 'log', 'job-1'], method: 'GET', path: '/api/jobs/job-1/log' },
  { argv: ['job', 'reply', 'job-1', 'keep going'], method: 'POST', path: '/api/jobs/job-1/reply', body: { message: 'keep going' } },
  { argv: ['job', 'permission', 'job-1', 'allow_once', '--request', 'req-9'], method: 'POST', path: '/api/jobs/job-1/permission', body: { requestId: 'req-9', decision: 'allow_once' } },
  { argv: ['job', 'permission', 'job-1', 'deny', '--request', 'req-9'], method: 'POST', path: '/api/jobs/job-1/permission', body: { requestId: 'req-9', decision: 'deny' } },
  { argv: ['job', 'kill', 'job-1'], method: 'POST', path: '/api/jobs/job-1/kill' },
  { argv: ['job', 'land', 'job-1'], method: 'POST', path: '/api/jobs/job-1/land' },
  { argv: ['job', 'reviewed', 'job-1'], method: 'POST', path: '/api/jobs/job-1/reviewed' },
  { argv: ['job', 'undo', 'job-1', 'toolu_1'], method: 'POST', path: '/api/jobs/job-1/undo', body: { toolUseId: 'toolu_1' } },
  { argv: ['job', 'rename', 'job-1', 'Better title'], method: 'PATCH', path: '/api/jobs/job-1', body: { label: 'Better title' } },
  { argv: ['job', 'rename', 'job-1', 'Locked title', '--lock'], method: 'PATCH', path: '/api/jobs/job-1', body: { label: 'Locked title', titleLocked: true } },
  { argv: ['job', 'export', 'job-1'], method: 'GET', path: '/api/jobs/job-1/export.md' },
  { argv: ['job', 'export', 'job-1', '--leaf', 'turn-2'], method: 'GET', path: '/api/jobs/job-1/export.md', query: { leaf: 'turn-2' } },
  { argv: ['job', 'thread', 'job-1'], method: 'GET', path: '/api/jobs/job-1/thread' },
  { argv: ['job', 'thread', 'job-1', '--leaf', 'turn-2'], method: 'GET', path: '/api/jobs/job-1/thread', query: { leaf: 'turn-2' } },
  { argv: ['job', 'commands', 'job-1'], method: 'GET', path: '/api/jobs/job-1/commands' },
  { argv: ['job', 'queue', 'job-1'], method: 'GET', path: '/api/jobs/job-1/queue' },
  { argv: ['job', 'queue', 'rm', 'job-1', 'item-3'], method: 'DELETE', path: '/api/jobs/job-1/queue/item-3' },

  { argv: ['workflows'], method: 'GET', path: '/api/studio/workflows' },
  { argv: ['workflow', 'revisions', 'ship'], method: 'GET', path: '/api/studio/workflows/ship/revisions' },
  { argv: ['policy'], method: 'GET', path: '/api/studio/policy' },
  { argv: ['runs'], method: 'GET', path: '/api/studio/runs' },
  { argv: ['runs', '--chat', 'chat-1', '--terminal', 't-1'], method: 'GET', path: '/api/studio/runs', query: { chat: 'chat-1', terminal: 't-1' } },
  { argv: ['run', 'show', 'run-1'], method: 'GET', path: '/api/studio/runs/run-1' },
  { argv: ['run', 'start', 'ship', 'Add a login page'], method: 'POST', path: '/api/studio/runs', body: { workflowId: 'ship', request: 'Add a login page', label: 'Add a login page', cwd: '/work/here' } },
  {
    argv: ['run', 'start', 'ship', 'Add it', '--label', 'Login', '--cwd', '/repo', '--revision', 'r2', '--engine', 'codex', '--model', 'gpt-5', '--terminal', 't-1', '--chat', 'chat-1'],
    method: 'POST',
    path: '/api/studio/runs',
    body: { workflowId: 'ship', request: 'Add it', label: 'Login', cwd: '/repo', revision: 'r2', engine: 'codex', model: 'gpt-5', terminalId: 't-1', chat: 'chat-1' },
  },
  { argv: ['run', 'stop', 'run-1'], method: 'POST', path: '/api/studio/runs/run-1/stop' },
  { argv: ['run', 'retry', 'run-1'], method: 'POST', path: '/api/studio/runs/run-1/retry' },
  { argv: ['run', 'pause', 'run-1'], method: 'POST', path: '/api/studio/runs/run-1/pause' },
  { argv: ['run', 'resume', 'run-1'], method: 'POST', path: '/api/studio/runs/run-1/resume' },
  { argv: ['run', 'approve', 'run-1'], method: 'POST', path: '/api/studio/runs/run-1/approve', body: {} },
  { argv: ['run', 'approve', 'run-1', '--chat', 'chat-1', '--flow-version', '2'], method: 'POST', path: '/api/studio/runs/run-1/approve', body: { chat: 'chat-1', version: 2 } },
  { argv: ['run', 'reject', 'run-1', '--terminal', 't-1'], method: 'POST', path: '/api/studio/runs/run-1/reject', body: { terminalId: 't-1' } },
  { argv: ['run', 'step', 'run-1', 'build'], method: 'GET', path: '/api/studio/runs/run-1/steps/build' },
  {
    argv: ['run', 'step', 'run-1', 'build', '--post', '--outcome', 'pass', '--summary', 'Built it', '--evidence', 'bun test: 3 pass', '--evidence', 'tsc clean', '--output', 'full log', '--terminal', 't-1'],
    method: 'POST',
    path: '/api/studio/runs/run-1/steps/build',
    body: { outcome: 'pass', summary: 'Built it', evidence: ['bun test: 3 pass', 'tsc clean'], output: 'full log', terminalId: 't-1' },
  },
  { argv: ['run', 'step', 'run-1', 'build', '--post', '--outcome', 'blocked', '--summary', 'Need a key'], method: 'POST', path: '/api/studio/runs/run-1/steps/build', body: { outcome: 'blocked', summary: 'Need a key', evidence: [] } },
  { argv: ['run', 'remind', 'run-1', 'build'], method: 'POST', path: '/api/studio/runs/run-1/steps/build/remind' },
]

describe('command table', () => {
  for (const row of ROWS) {
    test(`${row.argv.join(' ')} -> ${row.method} ${row.path}`, async () => {
      const h = harness()
      const code = await main(row.argv, h.deps)
      expect(h.err()).toBe('')
      expect(code).toBe(0)
      const call = h.calls.find((entry) => entry.method === row.method && entry.path === row.path)
      expect(call).toBeDefined()
      expect(call!.query).toEqual(row.query ?? {})
      if (row.body !== undefined) expect(call!.body).toEqual(row.body)
      if (row.body === undefined && row.method !== 'GET' && row.method !== 'DELETE') expect(call!.body === undefined || JSON.stringify(call!.body) === '{}').toBe(true)
    })
  }

  test('run changes reads the graph from a file', async () => {
    const graphFile = join(configDir, 'graph.json')
    await writeFile(graphFile, JSON.stringify({ nodes: [{ id: 'a' }], edges: [] }))
    const h = harness()
    const code = await main(['run', 'changes', 'run-1', '--graph', graphFile, '--reason', 'Add a check', '--scope-grew', '--chat', 'chat-1'], h.deps)
    expect(h.err()).toBe('')
    expect(code).toBe(0)
    expect(h.calls[0]).toEqual({
      method: 'POST',
      path: '/api/studio/runs/run-1/changes',
      query: {},
      body: { graph: { nodes: [{ id: 'a' }], edges: [] }, reason: 'Add a check', scopeGrew: true, chat: 'chat-1' },
    })
  })

  test('job new reads the prompt from stdin when it is -', async () => {
    const h = harness(cannedResponse, 'Prompt from a pipe\nwith detail\n')
    expect(await main(['job', 'new', '-', '--engine', 'glm'], h.deps)).toBe(0)
    expect(h.calls[0]!.body).toEqual({ engine: 'glm', cwd: '/work/here', prompt: 'Prompt from a pipe\nwith detail', label: 'Prompt from a pipe' })
  })

  test('job new trims a long first line to a 60 character label', async () => {
    const h = harness()
    const prompt = 'x'.repeat(80)
    await main(['job', 'new', prompt], h.deps)
    expect((h.calls[0]!.body as { label: string }).label).toBe('x'.repeat(60))
  })

  test('jobs --limit keeps the newest N', async () => {
    const jobs = [1, 2, 3].map((n) => ({ ...JOB, id: `job-${n}`, startedAt: n }))
    const h = harness(() => Response.json({ jobs }))
    expect(await main(['jobs', '--limit', '2', '--json'], h.deps)).toBe(0)
    expect(JSON.parse(h.out()).jobs.map((job: { id: string }) => job.id)).toEqual(['job-3', 'job-2'])
  })

  test('history --limit keeps the first N items', async () => {
    const h = harness(() => Response.json({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }))
    expect(await main(['history', '--limit', '1', '--json'], h.deps)).toBe(0)
    expect(JSON.parse(h.out())).toEqual({ items: [{ id: 'a' }] })
  })
})

describe('usage errors exit 2 without calling the server', () => {
  const cases: Array<[string, string[]]> = [
    ['unknown command', ['frobnicate']],
    ['unknown subcommand', ['job', 'frobnicate', 'x']],
    ['bad permission decision', ['job', 'permission', 'job-1', 'allow_forever', '--request', 'r']],
    ['permission without a request id', ['job', 'permission', 'job-1', 'deny']],
    ['missing job id', ['job', 'log']],
    ['missing reply text', ['job', 'reply', 'job-1']],
    ['too many arguments', ['job', 'log', 'a', 'b']],
    ['unknown flag', ['jobs', '--frob']],
    ['flag that belongs to another command', ['jobs', '--worktree']],
    ['bad role name', ['roles', 'set', 'boss!', 'claude']],
    ['reserved role name', ['roles', 'set', 'fallback', 'claude']],
    ['bad flow-approval value', ['flow-approval', 'set', 'maybe']],
    ['bad step outcome', ['run', 'step', 'r', 'n', '--post', '--outcome', 'great', '--summary', 's']],
    ['step post without summary', ['run', 'step', 'r', 'n', '--post', '--outcome', 'pass']],
    ['changes without a graph', ['run', 'changes', 'r', '--reason', 'why']],
    ['outcomes with neither chat nor terminal', ['outcomes']],
    ['outcomes with both chat and terminal', ['outcomes', '--chat', 'a', '--terminal', 'b']],
    ['non-numeric limit', ['jobs', '--limit', 'lots']],
    ['non-numeric version', ['run', 'approve', 'r', '--flow-version', 'two']],
    ['group without a subcommand', ['run']],
  ]
  for (const [name, argv] of cases) {
    test(name, async () => {
      const h = harness()
      expect(await main(argv, h.deps)).toBe(2)
      expect(h.calls).toEqual([])
      expect(h.err()).not.toBe('')
    })
  }
})

describe('output', () => {
  test('--json prints the server JSON verbatim', async () => {
    const payload = { models: [{ id: 'm1', label: 'Model One' }], weird: { nested: [1, 2, { deep: true }] } }
    const h = harness(() => Response.json(payload))
    expect(await main(['models', '--json'], h.deps)).toBe(0)
    expect(JSON.parse(h.out())).toEqual(payload)
    expect(h.out().trim().split('\n')).toHaveLength(1)
  })

  test('human mode prints a table for jobs', async () => {
    const h = harness()
    expect(await main(['jobs'], h.deps)).toBe(0)
    const lines = h.out().trimEnd().split('\n')
    expect(lines[0]).toMatch(/^ID\s+STATUS\s+ENGINE\s+AGE\s+PROMPT$/)
    expect(lines[1]).toMatch(/^job-1\s+done\s+claude\s+2m\s+Fix the bug$/)
  })

  test('human mode says so when a list is empty', async () => {
    const h = harness(() => Response.json({ jobs: [] }))
    expect(await main(['jobs'], h.deps)).toBe(0)
    expect(h.out()).toContain('No jobs')
  })

  test('job log and export print raw text', async () => {
    const h = harness()
    await main(['job', 'log', 'job-1'], h.deps)
    expect(h.out()).toBe('line one\nline two\n')
    const e = harness()
    await main(['job', 'export', 'job-1'], e.deps)
    expect(e.out()).toBe('# Fix the bug\n')
  })

  test('job log under --json wraps the text in a JSON document', async () => {
    const h = harness()
    await main(['job', 'log', 'job-1', '--json'], h.deps)
    expect(JSON.parse(h.out())).toEqual({ log: 'line one\nline two\n' })
  })

  test('human mode prints key: value for a single item', async () => {
    const h = harness()
    expect(await main(['roles'], h.deps)).toBe(0)
    expect(h.out()).toContain('plan')
    expect(h.out()).toContain('claude')
    expect(h.out()).toContain('autoReview: false')
  })

  test('roles set keeps the named roles already in Settings', async () => {
    const h = harness((method, path) => method === 'GET' && path === '/api/roles' ? Response.json({ ...ROLES, builder: { engine: 'claude', model: 'opus' }, fallback: null }) : Response.json({ ok: true }))
    expect(await main(['roles', 'set', 'tester', 'codex'], h.deps)).toBe(0)
    expect(h.calls.at(-1)!.body).toEqual({ plan: ROLES.plan, execute: ROLES.execute, review: ROLES.review, builder: { engine: 'claude', model: 'opus' }, tester: { engine: 'codex', model: null } })
  })

  test('status combines health, usage and roles', async () => {
    const h = harness()
    expect(await main(['status', '--json'], h.deps)).toBe(0)
    const doc = JSON.parse(h.out())
    expect(doc.health).toEqual({ ok: true })
    expect(doc.roles).toEqual(ROLES)
    expect(doc.quota).toEqual({ ok: true })
  })

  test('connection models prints the effective list, when it was checked and any error', async () => {
    const h = harness()
    expect(await main(['connection', 'models', 'grok'], h.deps)).toBe(0)
    expect(h.out()).toBe('models: grok-4.7, grok-4.5, grok-custom\ncurrent: grok-4.7\nchecked: 3m ago\n')
    const failing = harness((method, path) => path === '/api/studio/connections' ? Response.json({ ...CONNECTIONS, discovery: { grok: { ...GROK_STATE, error: 'grok is not signed in' } } }) : cannedResponse(method, path))
    await main(['connection', 'models', 'grok'], failing.deps)
    expect(failing.out()).toContain('error: grok is not signed in\n')
  })

  test('connection models says when nothing was checked yet', async () => {
    const h = harness((method, path) => path === '/api/studio/connections' ? Response.json({ ...CONNECTIONS, discovery: { grok: null } }) : cannedResponse(method, path))
    expect(await main(['connection', 'models', 'grok'], h.deps)).toBe(0)
    expect(h.out()).toBe('models: grok-4.7, grok-4.5, grok-custom\nchecked: never\n')
  })

  test('connection models --json prints the discovery state', async () => {
    const h = harness()
    expect(await main(['connection', 'models', 'grok', '--json'], h.deps)).toBe(0)
    expect(JSON.parse(h.out())).toEqual(GROK_STATE)
  })

  test('connection models --refresh prints what the check found', async () => {
    const fresh = { ...GROK_STATE, checkedAt: Date.now() }
    const h = harness((method, path) => path.endsWith('/models/refresh') ? Response.json(fresh) : cannedResponse(method, path))
    expect(await main(['connection', 'models', 'grok', '--refresh'], h.deps)).toBe(0)
    expect(h.out()).toBe('models: grok-4.7, grok-4.5\ncurrent: grok-4.7\nchecked: 0s ago\n')
  })

  test('connection models with an unknown id is an API-style error', async () => {
    const h = harness()
    expect(await main(['connection', 'models', 'ghost'], h.deps)).toBe(1)
    expect(h.err()).toContain('Connection "ghost" is not configured')
  })

  test('job show with an unknown id is an API-style error', async () => {
    const h = harness()
    expect(await main(['job', 'show', 'missing'], h.deps)).toBe(1)
    expect(h.err()).toContain('job not found')
  })
})

describe('help', () => {
  test('root help lists every group and the out-of-scope footer', async () => {
    const h = harness()
    expect(await main(['--help'], h.deps)).toBe(0)
    for (const word of ['status', 'jobs', 'job new', 'job follow', 'run start', 'terminal new', 'flow-approval set', '--json', 'SKD_URL', 'Not covered']) {
      expect(h.out()).toContain(word)
    }
    expect(h.calls).toEqual([])
  })

  test('no arguments shows the Shikidan banner, the version and help', async () => {
    const h = harness()
    expect(await main([], h.deps)).toBe(0)
    expect(h.out()).toContain('███████╗██╗  ██╗██╗██╗  ██╗')
    expect(h.out()).toContain(`v${VERSION}`)
    expect(h.out()).toContain('Usage')
    expect(h.calls).toEqual([])
  })

  test('--help stays plain so scripts never parse the banner', async () => {
    const h = harness()
    await main(['--help'], h.deps)
    expect(h.out()).not.toContain('███')
  })

  test('--version prints the version alone, even after a command', async () => {
    for (const argv of [['--version'], ['-v'], ['jobs', '--version']]) {
      const h = harness()
      expect(await main(argv, h.deps)).toBe(0)
      expect(h.out()).toBe(`shiki ${VERSION}\n`)
      expect(h.calls).toEqual([])
    }
  })

  test('group help lists only that group', async () => {
    const h = harness()
    expect(await main(['job', '--help'], h.deps)).toBe(0)
    expect(h.out()).toContain('job permission')
    expect(h.out()).not.toContain('run start')
  })

  test('-h on a command shows its options', async () => {
    const h = harness()
    expect(await main(['job', 'new', '-h'], h.deps)).toBe(0)
    expect(h.out()).toContain('--engine')
    expect(h.out()).toContain('--follow')
    expect(h.calls).toEqual([])
  })
})
