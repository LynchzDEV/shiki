import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main, type MainDeps } from '../cli/shiki'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skd-cli-settings-'))
  process.env.SKD_CONFIG_DIR = dir
})

afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }

function harness(reply: (call: Call) => Response | undefined = () => undefined, env: Record<string, string> = {}) {
  const calls: Call[] = []
  let out = ''
  let err = ''
  const deps: MainDeps = {
    fetch: async (request) => {
      const text = await request.text()
      const call = { method: request.method, path: new URL(request.url).pathname, body: text === '' ? undefined : JSON.parse(text) as Record<string, unknown> }
      calls.push(call)
      return reply(call) ?? Response.json({ ok: true })
    },
    stdout: (chunk) => { out += chunk },
    stderr: (chunk) => { err += chunk },
    env: { SKD_CONFIG_DIR: dir, ...env },
    stdin: async () => '',
    cwd: dir,
  }
  return { deps, calls, out: () => out, err: () => err }
}

const LISTED = { messages: [
  { name: 'ack', default: '✅ รับทราบครับ', override: null, slots: [] },
  { name: 'confirm-pick', default: 'ได้ครับ ใช้แบบ {option}', override: 'เอาแบบ {option}', slots: ['option'] },
] }

describe('shiki messages', () => {
  test('list shows each name, whether it is edited, its slots and its text', async () => {
    const h = harness(() => Response.json(LISTED))
    expect(await main(['messages', 'list'], h.deps)).toBe(0)
    expect(h.calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /api/messages'])
    for (const text of ['ack', 'no', 'confirm-pick', 'yes', '{option}', 'เอาแบบ {option}']) expect(h.out()).toContain(text)
  })

  test('show prints the current text and the default of an edited message; an unknown name is a usage error', async () => {
    const h = harness(() => Response.json(LISTED))
    expect(await main(['messages', 'show', 'confirm-pick'], h.deps)).toBe(0)
    expect(h.out()).toContain('เอาแบบ {option}')
    expect(h.out()).toContain('Default:\nได้ครับ ใช้แบบ {option}')
    expect(await main(['messages', 'show', 'nope'], h.deps)).toBe(2)
  })

  test('set reads the file and sends its text with the actor; reset sends DELETE', async () => {
    await writeFile(join(dir, 'ack.md'), 'รับแล้วครับ\n')
    const h = harness()
    expect(await main(['messages', 'set', 'ack', '--file', 'ack.md', '--as', 'human', '--why', 'shorter'], h.deps)).toBe(0)
    expect(await main(['messages', 'reset', 'ack'], h.deps)).toBe(0)
    expect(h.calls).toEqual([
      { method: 'PUT', path: '/api/messages/ack', body: { actor: 'human', why: 'shorter', text: 'รับแล้วครับ\n' } },
      { method: 'DELETE', path: '/api/messages/ack', body: { actor: 'human', why: 'cli' } },
    ])
  })

  test('set takes the actor from SKD_ACTOR and shows a 403 from the server', async () => {
    await writeFile(join(dir, 'ack.md'), 'hi')
    const h = harness(() => Response.json({ error: 'Only a human can change messages' }, { status: 403 }), { SKD_ACTOR: 'grok' })
    expect(await main(['messages', 'set', 'ack', '--file', 'ack.md'], h.deps)).not.toBe(0)
    expect(h.calls[0]!.body).toMatchObject({ actor: 'grok' })
    expect(h.err()).toContain('Only a human can change messages')
  })

  test('set without --file is a usage error and sends nothing', async () => {
    const h = harness()
    expect(await main(['messages', 'set', 'ack'], h.deps)).toBe(2)
    expect(h.calls).toEqual([])
  })
})
