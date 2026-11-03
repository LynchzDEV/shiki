import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { main, type MainDeps } from '../cli/shiki'

let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-cli-plugins-config-'))
  process.env.SKD_CONFIG_DIR = configDir
})

afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
})

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
type Reply = (call: Call) => Response | undefined

const FIELDS = [
  { key: 'assignee', label: 'Assignee', kind: 'assignee', options: [{ id: '7', name: 'Palm' }] },
  { key: 'cf:plan', label: 'Planning', kind: 'option', options: [{ id: 'o-17', name: 'Sprint 17' }, { id: 'o-ref', name: 'Refinement Plan' }] },
  { key: 'closed', label: 'Date closed', kind: 'date', options: [] },
]
const BOARD = { id: 'b-11112222', name: 'Main', folder: '~/work/api', source: { kind: 'view', viewId: 'v1', listId: 'l1' }, filters: { join: 'and', conditions: [] } }

function pluginCall(call: Call): { method: string; params: Record<string, unknown> } | null {
  if (call.method !== 'POST' || !call.path.endsWith('/call') || call.body === undefined) return null
  return { method: String(call.body.method), params: (call.body.params ?? {}) as Record<string, unknown> }
}

function clickupReply(call: Call): Response | undefined {
  const plugin = pluginCall(call)
  if (plugin?.method === 'boards.list') return Response.json({ result: [BOARD] })
  if (plugin?.method === 'board.cached') return Response.json({ result: { fields: FIELDS, viewFilter: null, me: '7' } })
  if (plugin?.method === 'board.view') return Response.json({ result: { board: BOARD, columns: [{ status: 'Open', tasks: [{ id: 't1', name: 'One', assignees: [{ initials: 'PV' }] }] }], shown: 1, total: 3 } })
  if (plugin?.method === 'boards.setFilters') return Response.json({ result: plugin.params.filters })
  if (plugin?.method === 'task.dossier') return Response.json({ result: { markdown: '# Dossier\n', tasksFetched: 1, truncated: false } })
  if (call.path === '/api/plugins/clickup-board/context') return Response.json({ path: '/home/me/work/api/.shikidan/context/clickup-board/t.md' })
  if (call.path === '/api/roles') return Response.json({ plan: { engine: 'claude', model: null } })
  if (call.path === '/api/jobs') return Response.json({ job: { id: 'job-9' } })
  if (call.path === '/api/terminals') return Response.json({ id: 'term-3' })
  return undefined
}

function harness(reply: Reply = clickupReply, stdin = '') {
  const calls: Call[] = []
  let out = ''
  let err = ''
  const deps: MainDeps = {
    fetch: async (request) => {
      const url = new URL(request.url)
      const text = await request.text()
      const call = { method: request.method, path: url.pathname, body: text === '' ? undefined : JSON.parse(text) as Record<string, unknown> }
      calls.push(call)
      return reply(call) ?? Response.json({ ok: true })
    },
    stdout: (chunk) => { out += chunk },
    stderr: (chunk) => { err += chunk },
    env: { SKD_CONFIG_DIR: configDir },
    stdin: async () => stdin,
    cwd: '/work/here',
  }
  return { deps, calls, out: () => out, err: () => err }
}

const methodsOf = (calls: Call[]) => calls.map(pluginCall).filter(Boolean).map((call) => call!.method)

describe('shiki plugin', () => {
  test('list shows installed plugins', async () => {
    const h = harness(() => Response.json({ plugins: [{ id: 'clickup-board', version: '1.3.0', runtime: 'isolated', enabled: true, state: 'ok', name: 'ClickUp board' }] }))
    expect(await main(['plugin', 'list'], h.deps)).toBe(0)
    expect(h.out()).toContain('clickup-board  1.3.0')
  })

  test('add shows what a plugin asks for, and installs only with --yes', async () => {
    const preview = { kind: 'plugin', ref: 'v1.3.0', commit: 'abc', runtime: 'isolated', manifest: { name: 'ClickUp board', version: '1.3.0' }, permissions: { network: ['api.clickup.com', '*.clickup-attachments.com'], sessions: ['chat'], settings: true } }
    const reply: Reply = (call) => (call.path === '/api/plugins/add-link' ? Response.json(preview) : call.path === '/api/plugins/install' ? Response.json({ plugin: { name: 'ClickUp board', version: '1.3.0' } }) : undefined)
    const look = harness(reply)
    expect(await main(['plugin', 'add', 'https://github.com/x/mc-plugin-clickup'], look.deps)).toBe(0)
    expect(look.out()).toContain('Reach api.clickup.com')
    expect(look.out()).toContain('Reach any address ending in .clickup-attachments.com')
    expect(look.out()).toContain('Run again with --yes')
    expect(look.calls.some((call) => call.path === '/api/plugins/install')).toBe(false)
    const install = harness(reply)
    expect(await main(['plugin', 'add', 'https://github.com/x/mc-plugin-clickup', '--yes'], install.deps)).toBe(0)
    expect(install.calls.find((call) => call.path === '/api/plugins/install')?.body).toEqual({ repo: 'https://github.com/x/mc-plugin-clickup', ref: 'v1.3.0', commit: 'abc' })
    expect(install.out()).toContain('Installed ClickUp board 1.3.0')
  })

  test('a plugin that adds agents, skills or flows lists them and needs --trust', async () => {
    const preview = { kind: 'plugin', ref: 'v0.2.0', commit: 'cp1', runtime: 'isolated', manifest: { name: 'Card pipeline', version: '0.2.0', contributes: { agents: ['agents/biz-gate.md'], skills: ['skills/card-refine'], flows: ['flows/card-pipeline.json'] } }, permissions: {} }
    const reply: Reply = (call) => (call.path === '/api/plugins/add-link' ? Response.json(preview) : call.path === '/api/plugins/install' ? Response.json({ plugin: { name: 'Card pipeline', version: '0.2.0' } }) : undefined)
    const look = harness(reply)
    expect(await main(['plugin', 'add', 'https://github.com/x/card-pipeline'], look.deps)).toBe(0)
    expect(look.out()).toContain('Add the agent agents/biz-gate.md to your engines')
    expect(look.out()).toContain('Add the skill skills/card-refine to your engines')
    expect(look.out()).toContain('Add the Studio flow flows/card-pipeline.json')
    expect(look.out()).toContain('Run again with --yes --trust')
    const refused = harness(reply)
    expect(await main(['plugin', 'add', 'https://github.com/x/card-pipeline', '--yes'], refused.deps)).toBe(2)
    expect(refused.err()).toContain('this plugin adds agents, skills or flows that run with your access; add --trust to install it')
    const install = harness(reply)
    expect(await main(['plugin', 'add', 'https://github.com/x/card-pipeline', '--yes', '--trust'], install.deps)).toBe(0)
    expect(install.calls.find((call) => call.path === '/api/plugins/install')?.body).toEqual({ repo: 'https://github.com/x/card-pipeline', ref: 'v0.2.0', commit: 'cp1', trust: true })
  })

  test('a trusted plugin needs --trust, and a marketplace link just adds it', async () => {
    const trusted = harness((call) => (call.path === '/api/plugins/add-link' ? Response.json({ kind: 'plugin', ref: 'v0.1.0', commit: 'c1', runtime: 'trusted', manifest: { name: 'Hello', version: '0.1.0' } }) : undefined))
    expect(await main(['plugin', 'add', 'https://github.com/x/hello', '--yes'], trusted.deps)).toBe(2)
    expect(trusted.err()).toContain('add --trust')
    const market = harness((call) => (call.path === '/api/plugins/add-link' ? Response.json({ kind: 'marketplace' }) : undefined))
    expect(await main(['plugin', 'add', 'https://github.com/x/market'], market.deps)).toBe(0)
    expect(market.out()).toContain('Marketplace added')
  })

  test('update re-syncs the marketplace and explains extra permissions', async () => {
    const installed = { id: 'clickup-board', name: 'ClickUp board', version: '1.0.0', commit: 'old', source: { repo: 'https://g/clickup', ref: 'v1.0.0', marketplace: 'https://g/market' } }
    const h = harness((call) => {
      if (call.method === 'GET' && call.path === '/api/plugins') return Response.json({ plugins: [installed] })
      if (call.path === '/api/plugins/catalog') return Response.json({ entries: [{ marketplace: 'https://g/market', plugins: [{ id: 'clickup-board', ref: 'v1.3.0' }] }] })
      if (call.path === '/api/plugins/preview') return Response.json({ commit: 'new', manifest: { version: '1.3.0' } })
      if (call.path === '/api/plugins/clickup-board/update') return Response.json({ needsConsent: true, added: ['Reach api.github.com'] }, { status: 409 })
      return undefined
    })
    expect(await main(['plugin', 'update', 'clickup-board', '--yes'], h.deps)).toBe(2)
    expect(h.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/plugins', 'POST /api/plugins/marketplaces', 'GET /api/plugins/catalog', 'POST /api/plugins/preview', 'POST /api/plugins/clickup-board/update'])
    expect(h.calls.find((call) => call.path === '/api/plugins/preview')?.body).toEqual({ repo: 'https://g/clickup', ref: 'v1.3.0' })
    expect(h.err()).toContain('Reach api.github.com')
    expect(h.err()).toContain('--yes --accept')
  })

  test('set reads a secret from stdin, call passes JSON params, remove keeps data by default', async () => {
    const set = harness(() => undefined, 'pk_secret\n')
    expect(await main(['plugin', 'set', 'clickup-board', 'token', '-'], set.deps)).toBe(0)
    expect(set.calls[0]).toEqual({ method: 'PUT', path: '/api/plugins/clickup-board/settings', body: { key: 'token', value: 'pk_secret' } })
    expect(set.out()).not.toContain('pk_secret')
    const call = harness(() => Response.json({ result: { ok: true } }))
    expect(await main(['plugin', 'call', 'clickup-board', 'boards.list', '--params', '{"x":1}'], call.deps)).toBe(0)
    expect(call.calls[0]?.body).toEqual({ method: 'boards.list', params: { x: 1 } })
    const remove = harness()
    expect(await main(['plugin', 'remove', 'clickup-board'], remove.deps)).toBe(0)
    expect(remove.calls[0]).toEqual({ method: 'DELETE', path: '/api/plugins/clickup-board', body: { keepData: true } })
  })

  test('settings shows a secret only as set and an unset toggle as false', async () => {
    const fields = [{ key: 'token', label: 'Token', type: 'secret' }, { key: 'autoPick', label: 'Auto-pick', type: 'toggle' }, { key: 'note', label: 'Note', type: 'text' }]
    const h = harness((call) => (call.path === '/api/plugins/fixstack/settings' ? Response.json({ fields, values: {}, configured: { token: true } }) : undefined))
    expect(await main(['plugin', 'settings', 'fixstack'], h.deps)).toBe(0)
    expect(h.out().split('\n').map(line => line.trim().split(/\s+/).at(-1))).toEqual(['VALUE', '(set)', 'false', '-', ''])
  })

  test('a plugin too old for a command says how to update it', async () => {
    const h = harness((call) => (pluginCall(call)?.method === 'board.view' ? Response.json({ error: 'No method board.view' }, { status: 404 }) : clickupReply(call)))
    expect(await main(['clickup', 'board', 'main'], h.deps)).toBe(2)
    expect(h.err()).toContain('shiki plugin update clickup-board --yes')
  })
})

describe('shiki clickup', () => {
  test('board finds the board by name and shows what the screen shows', async () => {
    const h = harness()
    expect(await main(['clickup', 'board', 'main', '--search', 'one'], h.deps)).toBe(0)
    expect(pluginCall(h.calls.at(-1)!)).toEqual({ method: 'board.view', params: { boardId: 'b-11112222', search: 'one' } })
    expect(h.out()).toContain('Main · 1 of 3 tasks')
    expect(h.out()).toContain('t1')
  })

  test('filter add resolves field, operator and values by name, Me included', async () => {
    const h = harness()
    expect(await main(['clickup', 'filter', 'add', 'Main', 'assignee', 'is any of', '--value', 'Me', '--value', 'Palm'], h.deps)).toBe(0)
    const saved = h.calls.map(pluginCall).find((call) => call?.method === 'boards.setFilters')
    expect(saved?.params).toEqual({ boardId: 'b-11112222', filters: { join: 'and', conditions: [{ field: 'assignee', op: 'any', values: ['me', '7'] }] } })
    expect(h.out()).toContain('Assignee Is any of Me, Palm')
  })

  test('filter add refuses operators that do not fit and values that do not exist', async () => {
    const op = harness()
    expect(await main(['clickup', 'filter', 'add', 'Main', 'Date closed', 'overdue'], op.deps)).toBe(2)
    expect(op.err()).toContain("doesn't apply to Date closed")
    const value = harness()
    expect(await main(['clickup', 'filter', 'add', 'Main', 'Planning', 'is', '--value', 'Sprint 99'], value.deps)).toBe(2)
    expect(value.err()).toContain('no Planning value "Sprint 99"')
    expect(methodsOf(value.calls)).not.toContain('boards.setFilters')
  })

  test('start writes the context in the board folder and opens a chat', async () => {
    const h = harness()
    expect(await main(['clickup', 'start', '86d4ccpu2', '--board', 'Main', '--message', 'Plan it'], h.deps)).toBe(0)
    expect(h.calls.find((call) => call.path === '/api/plugins/clickup-board/context')?.body).toEqual({ name: 'task-86d4ccpu2', markdown: '# Dossier\n', cwd: join(homedir(), 'work/api') })
    expect(h.calls.find((call) => call.path === '/api/jobs')?.body).toEqual({ engine: 'claude', cwd: join(homedir(), 'work/api'), prompt: 'Read the task context in /home/me/work/api/.shikidan/context/clickup-board/t.md before anything else.\n\nPlan it', purpose: 'chat' })
    expect(h.out()).toContain('Chat job-9 started')
  })

  test('start --terminal opens a terminal with the context as its first message', async () => {
    const h = harness()
    expect(await main(['clickup', 'start', '86d4ccpu2', '--terminal', '--cwd', '/srv/app', '--engine', 'codex'], h.deps)).toBe(0)
    expect(h.calls.find((call) => call.path === '/api/terminals')?.body).toEqual({ engine: 'codex', cwd: '/srv/app', initialPrompt: 'Read the task context in /home/me/work/api/.shikidan/context/clickup-board/t.md before anything else.', title: 'ClickUp 86d4ccpu2' })
    expect(h.out()).toContain('Terminal term-3 opened in /srv/app')
  })
})
