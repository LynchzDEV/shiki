import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { main, type MainDeps } from '../cli/shiki'

let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-cli-queue-config-'))
  process.env.SKD_CONFIG_DIR = configDir
})

afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
})

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
type Reply = (call: Call) => Response | undefined

function harness(reply: Reply = () => undefined, cwd = '/work/here') {
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
    stdin: async () => '',
    cwd,
  }
  return { deps, calls, out: () => out, err: () => err }
}

const routesOf = (calls: Call[]) => calls.map((call) => `${call.method} ${call.path}`)

describe('shiki queue', () => {
  test('list prints one row per item with its state and questions', async () => {
    const h = harness((call) => (call.method === 'GET' && call.path === '/api/queue'
      ? Response.json({ items: [{ id: 'a1', state: 'waiting-info', source: 'clickup-board', title: 'Login copy', questions: ['Which page?'], error: null }] })
      : undefined))
    expect(await main(['queue', 'list'], h.deps)).toBe(0)
    expect(routesOf(h.calls)).toEqual(['GET /api/queue'])
    for (const text of ['a1', 'waiting-info', 'clickup-board', 'Login copy', 'Which page?']) expect(h.out()).toContain(text)
  })

  test('list shows the error instead of questions for a failed item', async () => {
    const h = harness(() => Response.json({ items: [{ id: 'b2', state: 'failed', source: 'clickup-board', title: 'Export', questions: ['ignored?'], error: 'Plan step failed' }] }))
    expect(await main(['queue', 'list'], h.deps)).toBe(0)
    expect(h.out()).toContain('Plan step failed')
    expect(h.out()).not.toContain('ignored?')
  })

  test('list says how to add when the queue is empty', async () => {
    const h = harness(() => Response.json({ items: [] }))
    expect(await main(['queue', 'list'], h.deps)).toBe(0)
    expect(h.out()).toBe('The queue is empty. Add an item with: shiki queue add <source> <id> --repo <dir>\n')
  })

  test('add posts source, id, repo, flow and position next', async () => {
    const h = harness((call) => (call.path === '/api/queue' ? Response.json({ item: { id: 'a1', title: 'Login copy' } }) : undefined))
    expect(await main(['queue', 'add', 'clickup-board', '86d3j4f8q', '--repo', '/repo', '--flow', 'wf-1', '--next'], h.deps)).toBe(0)
    expect(routesOf(h.calls)).toEqual(['POST /api/queue'])
    expect(h.calls[0]?.body).toEqual({ source: 'clickup-board', externalId: '86d3j4f8q', repo: '/repo', flowId: 'wf-1', position: 'next' })
    expect(h.out()).toContain('Login copy')
  })

  test('add uses the current directory when --repo is missing', async () => {
    const h = harness(() => Response.json({ item: { id: 'a1', title: 'Login copy' } }), '/work/api')
    expect(await main(['queue', 'add', 'clickup-board', '86d3j4f8q'], h.deps)).toBe(0)
    const body = h.calls[0]?.body
    expect(body?.repo).toBe('/work/api')
    expect(body?.position).toBe('end')
    expect(body !== undefined && 'flowId' in body).toBe(false)
  })

  test('add sends --repo as an absolute path from the current directory or home', async () => {
    for (const [given, sent] of [['../x', '/work/x'], ['~/x', join(homedir(), 'x')], ['~', homedir()]] as const) {
      const h = harness(() => Response.json({ item: { id: 'a1', title: 'Login copy' } }), '/work/here')
      expect(await main(['queue', 'add', 'clickup-board', '86d3j4f8q', '--repo', given], h.deps)).toBe(0)
      expect(h.calls[0]?.body?.repo).toBe(sent)
    }
  })

  test('move sends a whole number and rejects anything else', async () => {
    const ok = harness(() => Response.json({ items: [] }))
    expect(await main(['queue', 'move', 'a1', '2'], ok.deps)).toBe(0)
    expect(routesOf(ok.calls)).toEqual(['POST /api/queue/a1/move'])
    expect(ok.calls[0]?.body).toEqual({ to: 2 })

    for (const bad of ['x', '1.5']) {
      const rejected = harness()
      expect(await main(['queue', 'move', 'a1', bad], rejected.deps)).toBe(2)
      expect(rejected.err()).toContain('shiki: to must be a whole number from 0')
      expect(rejected.err()).toContain("shiki queue --help")
      expect(rejected.calls).toEqual([])
    }
  })

  test('requeue, remove and check hit their routes', async () => {
    const requeue = harness(() => Response.json({ item: { id: 'a1' } }))
    expect(await main(['queue', 'requeue', 'a1'], requeue.deps)).toBe(0)
    expect(routesOf(requeue.calls)).toEqual(['POST /api/queue/a1/requeue'])

    const remove = harness()
    expect(await main(['queue', 'remove', 'a1'], remove.deps)).toBe(0)
    expect(routesOf(remove.calls)).toEqual(['DELETE /api/queue/a1'])

    const check = harness(() => Response.json({ checked: 2, resumed: 1 }))
    expect(await main(['queue', 'check'], check.deps)).toBe(0)
    expect(routesOf(check.calls)).toEqual(['POST /api/queue/check'])
    expect(check.out()).toBe('Checked 2, resumed 1\n')
  })

  test('an id with a slash stays one path segment', async () => {
    const h = harness()
    expect(await main(['queue', 'remove', 'a/b'], h.deps)).toBe(0)
    expect(routesOf(h.calls)).toEqual(['DELETE /api/queue/a%2Fb'])
  })

  test('pick sends the option with the optional tester and note', async () => {
    const h = harness(() => Response.json({ item: { id: 'a1' } }))
    expect(await main(['queue', 'pick', 'a1', 'B', '--tester', 'Ploy', '--note', 'wide'], h.deps)).toBe(0)
    expect(h.calls).toEqual([{ method: 'POST', path: '/api/queue/a1/pick', body: { option: 'B', tester: 'Ploy', note: 'wide' } }])
    const bare = harness(() => Response.json({ item: { id: 'a1' } }))
    expect(await main(['queue', 'pick', 'a1', 'A'], bare.deps)).toBe(0)
    expect(bare.calls[0]!.body).toEqual({ option: 'A' })
  })

  test('a refused requeue prints the server message and exits 1', async () => {
    const h = harness(() => Response.json({ error: 'It is building now' }, { status: 409 }))
    expect(await main(['queue', 'requeue', 'a1'], h.deps)).toBe(1)
    expect(h.err()).toContain('It is building now')
  })

  test('--json prints the server answer unchanged', async () => {
    const h = harness(() => Response.json({ checked: 0, resumed: 0 }))
    expect(await main(['queue', 'check', '--json'], h.deps)).toBe(0)
    expect(JSON.parse(h.out())).toEqual({ checked: 0, resumed: 0 })
  })

  test('shiki help lists the queue group', async () => {
    const h = harness()
    expect(await main(['--help'], h.deps)).toBe(0)
    expect(h.out()).toContain('shiki queue requeue <id>')
    expect(h.out()).toContain('Put a failed, ready or waiting item back in line')
  })
})

describe('shiki queue with several repos', () => {
  test('add --repos sends the trimmed repo names with the folder', async () => {
    const h = harness(() => Response.json({ item: { id: 'a1', title: 'Login copy' } }))
    expect(await main(['queue', 'add', 'clickup-board', '86d3j4f8q', '--repo', '/home/me/klangtech', '--repos', 'api, backoffice'], h.deps)).toBe(0)
    expect(h.calls[0]?.body).toEqual({ source: 'clickup-board', externalId: '86d3j4f8q', repo: '/home/me/klangtech', repos: ['api', 'backoffice'], position: 'end' })
  })

  test('add --repos refuses a bad list before calling the server', async () => {
    const nine = Array.from({ length: 9 }, (_, index) => `r${index}`).join(',')
    const cases: Array<[string, string]> = [
      ['../x', 'Not a repo name: ../x'],
      ['api,.git', 'Not a repo name: .git'],
      ['api,api', 'api is ticked twice'],
      [nine, 'Pick at most 8 repos for one item'],
    ]
    for (const [given, error] of cases) {
      const h = harness()
      expect(await main(['queue', 'add', 'clickup-board', '1', '--repo', '/k', '--repos', given], h.deps)).toBe(2)
      expect(h.err()).toContain(`shiki: ${error}`)
      expect(h.calls).toEqual([])
    }
  })

  test('add --repos with nothing in it sends an empty list so the plan picks', async () => {
    for (const given of ['', ' , ']) {
      const h = harness(() => Response.json({ item: { id: 'a1', title: 'x' } }))
      expect(await main(['queue', 'add', 'clickup-board', '1', '--repo', '/k', '--repos', given], h.deps)).toBe(0)
      expect(h.calls[0]?.body?.repos).toEqual([])
    }
  })

  test('add without --repos sends no repos key', async () => {
    const h = harness(() => Response.json({ item: { id: 'a1', title: 'x' } }))
    expect(await main(['queue', 'add', 'clickup-board', '1', '--repo', '/k'], h.deps)).toBe(0)
    expect(h.calls[0]?.body !== undefined && 'repos' in h.calls[0].body).toBe(false)
  })

  test('list shows the repos of a multi-repo item and a dash for others', async () => {
    const h = harness(() => Response.json({ items: [
      { id: 'm1', state: 'queued', source: 'clickup-board', title: 'Login', repo: '/home/me/klangtech', repos: ['api', 'backoffice'], questions: [], error: null },
      { id: 's1', state: 'queued', source: 'clickup-board', title: 'Copy', repo: '/home/me/api', questions: [], error: null },
      { id: 'p1', state: 'queued', source: 'clickup-board', title: 'Pick', repo: '/home/me/klangtech', repos: [], questions: [], error: null },
    ] }))
    expect(await main(['queue', 'list'], h.deps)).toBe(0)
    expect(h.out()).toContain('REPOS')
    expect(h.out()).toContain('api, backoffice')
    expect(h.out().split('\n').find(line => line.includes('s1'))).toContain('-')
    expect(h.out().split('\n').find(line => line.includes('p1'))).toContain('plan picks')
  })

  const waiting = { id: 'q1', state: 'awaiting-stage', land: { stage: 'prod', stages: { prod: { status: 'waiting', preflight: { exitCode: 0, markdown: '| repo |\n|---|\n| api |\n\nSafety: prod' } } } } }
  const listing = (call: Call) => (call.method === 'GET' && call.path === '/api/queue' ? Response.json({ items: [waiting] }) : undefined)

  test('report prints the item report as plain text', async () => {
    const h = harness((call) => (call.path === '/api/queue/q1/report' ? new Response('# Login copy\n', { headers: { 'content-type': 'text/markdown' } }) : undefined))
    expect(await main(['queue', 'report', 'q1'], h.deps)).toBe(0)
    expect(routesOf(h.calls)).toEqual(['GET /api/queue/q1/report'])
    expect(h.out()).toBe('# Login copy\n')
  })

  test('land shows the preflight and does not start without --yes', async () => {
    const h = harness(listing)
    expect(await main(['queue', 'land', 'q1', 'prod'], h.deps)).toBe(0)
    expect(routesOf(h.calls)).toEqual(['GET /api/queue'])
    expect(h.out()).toContain('Safety: prod')
    expect(h.out()).toContain('Run again with --yes to start prod.')
  })

  test('land without --yes says the stage is blocked when the preflight failed', async () => {
    const blockedItem = { ...waiting, land: { stage: 'prod', stages: { prod: { status: 'waiting', preflight: { exitCode: 2, markdown: 'behind main' } } } } }
    const h = harness((call) => (call.path === '/api/queue' ? Response.json({ items: [blockedItem] }) : undefined))
    expect(await main(['queue', 'land', 'q1', 'prod'], h.deps)).toBe(0)
    expect(h.out()).toContain('behind main')
    expect(h.out()).toContain('This stage is blocked by its preflight')
    expect(h.out()).not.toContain('Run again with --yes')
  })

  test('land with --yes prints the preflight first, then starts the stage with confirm', async () => {
    const h = harness((call) => (call.method === 'POST' ? Response.json({ item: { id: 'q1' } }) : listing(call)))
    expect(await main(['queue', 'land', 'q1', 'prod', '--yes'], h.deps)).toBe(0)
    expect(routesOf(h.calls)).toEqual(['GET /api/queue', 'POST /api/queue/q1/land/prod/start'])
    expect(h.calls[1]?.body).toEqual({ confirm: true })
    expect(h.out().indexOf('Safety: prod')).toBeLessThan(h.out().indexOf('Started prod.'))
  })

  test('land on an unknown item is a usage error', async () => {
    const h = harness(() => Response.json({ items: [] }))
    expect(await main(['queue', 'land', 'zz', 'prod', '--yes'], h.deps)).not.toBe(0)
    expect(h.calls.every((call) => call.method === 'GET')).toBe(true)
    expect(h.err()).toContain('no queue item zz')
  })
})
