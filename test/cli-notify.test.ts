import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main, type MainDeps } from '../cli/shiki'

let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'skd-cli-notify-'))
  process.env.SKD_CONFIG_DIR = configDir
})

afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
})

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }

function harness(reply: (call: Call) => Response | undefined = () => undefined, stdin = '') {
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

describe('shiki notify', () => {
  test('status shows the url, key flag, pending and dropped counts', async () => {
    const h = harness(() => Response.json({ configured: true, url: 'https://bot.example/hook', keyConfigured: true, pending: 2, dropped: 7 }))
    expect(await main(['notify', 'status'], h.deps)).toBe(0)
    expect(h.calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /api/notify'])
    for (const text of ['https://bot.example/hook', 'keyConfigured', 'pending', '2', 'dropped', '7']) expect(h.out()).toContain(text)
  })

  test('test posts and prints the status the webhook answered', async () => {
    const h = harness(() => Response.json({ ok: true, status: 200 }))
    expect(await main(['notify', 'test'], h.deps)).toBe(0)
    expect(h.calls.map(call => `${call.method} ${call.path}`)).toEqual(['POST /api/notify/test'])
    expect(h.out()).toBe('The webhook answered 200.\n')
  })

  test('test exits non-zero and shows the reason when the webhook refuses', async () => {
    const h = harness(() => Response.json({ ok: false, status: 413, error: 'the webhook answered 413' }, { status: 502 }))
    expect(await main(['notify', 'test'], h.deps)).not.toBe(0)
    expect(h.err()).toContain('the webhook answered 413')
  })

  test('set-url posts the url to secrets', async () => {
    const h = harness()
    expect(await main(['notify', 'set-url', 'https://bot.example/hook'], h.deps)).toBe(0)
    expect(h.calls[0]).toEqual({ method: 'POST', path: '/api/secrets', body: { notifyWebhookUrl: 'https://bot.example/hook' } })
  })

  test('set-url shows the server refusing an http url', async () => {
    const h = harness(() => Response.json({ error: 'notifyWebhookUrl must be an https url' }, { status: 400 }))
    expect(await main(['notify', 'set-url', 'http://bot.example'], h.deps)).not.toBe(0)
    expect(h.err()).toContain('must be an https url')
  })

  test('set-key - reads the key from stdin and never prints it', async () => {
    const h = harness(() => undefined, 'whk-from-stdin\n')
    expect(await main(['notify', 'set-key', '-'], h.deps)).toBe(0)
    expect(h.calls[0]?.body).toEqual({ notifyWebhookKey: 'whk-from-stdin' })
    expect(h.out()).not.toContain('whk-from-stdin')
  })

  test('set-key with an empty stdin is a usage error and sends nothing', async () => {
    const h = harness(() => undefined, '\n')
    expect(await main(['notify', 'set-key', '-'], h.deps)).not.toBe(0)
    expect(h.calls).toEqual([])
  })

  test('clear nulls both fields', async () => {
    const h = harness()
    expect(await main(['notify', 'clear'], h.deps)).toBe(0)
    expect(h.calls[0]?.body).toEqual({ notifyWebhookUrl: null, notifyWebhookKey: null })
    expect(h.out()).toBe('Cleared the webhook.\n')
  })
})
