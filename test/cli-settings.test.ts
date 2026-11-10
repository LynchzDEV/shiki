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

describe('shiki studio overlay', () => {
  test('show prints each overridden step; an empty overlay says so', async () => {
    const h = harness(() => Response.json({ flowId: 'fixstack--fixstack', overlay: { nodes: { how: { title: 'How', instructions: 'Keep NOW.\nFix the bug.' } } } }))
    expect(await main(['studio', 'overlay', 'show', 'fixstack--fixstack'], h.deps)).toBe(0)
    expect(h.calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /api/studio/flow-overlays/fixstack--fixstack'])
    expect(h.out()).toContain('how:\n  title: How\n  instructions:\n    Keep NOW.\n    Fix the bug.')
    const empty = harness(() => Response.json({ flowId: 'x', overlay: { nodes: {} } }))
    expect(await main(['studio', 'overlay', 'show', 'x'], empty.deps)).toBe(0)
    expect(empty.out()).toContain('No overrides')
  })

  test('set sends the file as instructions for one step; clear sends one step or none', async () => {
    await writeFile(join(dir, 'how.md'), 'Keep NOW.')
    const h = harness(() => Response.json({ overlay: { nodes: {} } }))
    expect(await main(['studio', 'overlay', 'set', 'fixstack--fixstack', 'how', '--file', 'how.md', '--title', 'How', '--as', 'human'], h.deps)).toBe(0)
    expect(await main(['studio', 'overlay', 'clear', 'fixstack--fixstack', 'how'], h.deps)).toBe(0)
    expect(await main(['studio', 'overlay', 'clear', 'fixstack--fixstack', '--why', 'back to plugin text'], h.deps)).toBe(0)
    expect(h.calls).toEqual([
      { method: 'PUT', path: '/api/studio/flow-overlays/fixstack--fixstack', body: { actor: 'human', why: 'cli', nodeId: 'how', instructions: 'Keep NOW.', title: 'How' } },
      { method: 'DELETE', path: '/api/studio/flow-overlays/fixstack--fixstack', body: { actor: 'human', why: 'cli', nodeId: 'how' } },
      { method: 'DELETE', path: '/api/studio/flow-overlays/fixstack--fixstack', body: { actor: 'human', why: 'back to plugin text' } },
    ])
  })

  test('set with neither --file nor --title is a usage error', async () => {
    const h = harness()
    expect(await main(['studio', 'overlay', 'set', 'f', 'how'], h.deps)).toBe(2)
    expect(h.calls).toEqual([])
  })
})

const SUGGESTION = { id: 's1', at: 0, state: 'waiting-pick', askRef: 'r', intent: 'reject', replyId: 'c9', confidence: 0.8, status: 'proposed', reason: 'the owner rejected every option', actions: [{ action: 'pick', params: { option: 'none', feedback: 'อยากได้ "สีเขียว"' } }] }

describe('shiki doctor', () => {
  test('doctor <id> starts a diagnosis as the given actor and says where to read it', async () => {
    const h = harness(() => Response.json({ runId: 'run-9', suggestion: null }))
    expect(await main(['doctor', '6ea3', '--as', 'grok', '--why', 'owner reply looked like a reject'], h.deps)).toBe(0)
    expect(h.calls).toEqual([{ method: 'POST', path: '/api/queue/6ea3/doctor', body: { actor: 'grok', why: 'owner reply looked like a reject' } }])
    expect(h.out()).toContain('shiki doctor show 6ea3')
  })

  test('show prints the intent, the reason and the exact command apply would run', async () => {
    const h = harness(() => Response.json({ suggestion: SUGGESTION }))
    expect(await main(['doctor', 'show', '6ea3'], h.deps)).toBe(0)
    expect(h.calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /api/queue/6ea3/doctor'])
    for (const text of ['reject', '0.80', 'reply c9', 'the owner rejected every option', 'shiki queue pick 6ea3 none --feedback "อยากได้ \\"สีเขียว\\""', 'shiki doctor apply 6ea3 --as <you>']) expect(h.out()).toContain(text)
  })

  test('show on an unknown card prints the server 404 and exits non-zero', async () => {
    const h = harness(() => Response.json({ error: 'No queue item bogus' }, { status: 404 }))
    expect(await main(['doctor', 'show', 'bogus'], h.deps)).not.toBe(0)
    expect(h.err()).toContain('No queue item bogus')
  })

  test('apply and dismiss post the actor from SKD_ACTOR', async () => {
    const h = harness(() => Response.json({ suggestion: { ...SUGGESTION, status: 'applied' } }), { SKD_ACTOR: 'grok' })
    expect(await main(['doctor', 'apply', '6ea3'], h.deps)).toBe(0)
    expect(await main(['doctor', 'dismiss', '6ea3', '--why', 'wrong'], h.deps)).toBe(0)
    expect(h.calls).toEqual([
      { method: 'POST', path: '/api/queue/6ea3/doctor/apply', body: { actor: 'grok', why: 'cli' } },
      { method: 'POST', path: '/api/queue/6ea3/doctor/dismiss', body: { actor: 'grok', why: 'wrong' } },
    ])
  })
})
