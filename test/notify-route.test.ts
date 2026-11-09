import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { createApp } from '../server/index'
import { SAMPLE_BLOB_BYTES, sampleEvent } from '../server/notify-events'
import type { QueueItem } from '../server/queue-store'

let dir: string
let app: Elysia
let receiver: ReturnType<typeof Bun.serve> | undefined
const received: Array<{ headers: Headers; body: Record<string, unknown> }> = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skd-notify-route-'))
  process.env.SKD_CONFIG_DIR = dir
  received.length = 0
  app = await createApp()
})

afterEach(async () => {
  receiver?.stop(true)
  receiver = undefined
  delete process.env.SKD_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

function listen(status: number): string {
  receiver = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async request => { received.push({ headers: request.headers, body: await request.json() as Record<string, unknown> }); return new Response('', { status }) } })
  return `http://127.0.0.1:${receiver.port}/hook`
}

const call = (method: string, path: string) => app.handle(new Request(`http://localhost${path}`, { method }))

async function configure(url: string | null, key: string | null) {
  await Bun.write(join(dir, 'secrets.json'), JSON.stringify({ notifyWebhookUrl: url, notifyWebhookKey: key }))
}

describe('GET /api/notify', () => {
  test('is unconfigured by default', async () => {
    expect(await (await call('GET', '/api/notify')).json()).toEqual({ configured: false, url: null, keyConfigured: false, pending: 0, dropped: 0 })
  })

  test('shows the url and whether a key is set, never the key', async () => {
    await configure('https://bot.example/hook', 'whk-secret')
    const text = await (await call('GET', '/api/notify')).text()
    expect(JSON.parse(text)).toEqual({ configured: true, url: 'https://bot.example/hook', keyConfigured: true, pending: 0, dropped: 0 })
    expect(text).not.toContain('whk-secret')
  })

  test('is refused from a foreign origin', async () => {
    const response = await app.handle(new Request('http://localhost/api/notify', { headers: { host: '127.0.0.1:7777', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }))
    expect(response.status).toBe(403)
  })
})

describe('pending events', () => {
  const secrets = (body: unknown) => app.handle(new Request('http://localhost/api/secrets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  const pending = async () => (await (await call('GET', '/api/notify')).json()).pending

  async function bootWithPending(): Promise<void> {
    await configure(listen(500), 'k')
    await Bun.write(join(dir, 'notify-outbox.json'), JSON.stringify({ pending: [{ event: { eventId: 'evt-1', event: 'ready', title: 'Card' }, images: [], attempts: 0 }], last: {}, dropped: 3 }))
    app = await createApp()
  }

  test('report how many were dropped by the cap', async () => {
    await bootWithPending()
    expect((await (await call('GET', '/api/notify')).json()).dropped).toBe(3)
  })

  test('survive a key change and are dropped when the url is cleared', async () => {
    await bootWithPending()
    expect(await pending()).toBe(1)
    await secrets({ notifyWebhookKey: 'k2' })
    expect(await pending()).toBe(1)
    await secrets({ notifyWebhookUrl: null, notifyWebhookKey: null })
    expect(await pending()).toBe(0)
  })
})

describe('POST /api/notify/test', () => {
  test('without a url says so', async () => {
    const response = await call('POST', '/api/notify/test')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, error: 'no webhook url configured' })
  })

  test('sends the sample with both headers and three real-sized images', async () => {
    await configure(listen(200), 'whk-secret')
    const response = await call('POST', '/api/notify/test')
    expect(await response.json()).toEqual({ ok: true, status: 200 })
    const { headers, body } = received[0]!
    expect(headers.get('authorization')).toBe('Bearer whk-secret')
    expect(headers.get('x-automation-key')).toBe('whk-secret')
    const mockups = body.mockups as Array<{ base64: string; mime: string }>
    expect(mockups).toHaveLength(3)
    expect(mockups.every(mockup => mockup.mime === 'image/png' && Buffer.from(mockup.base64, 'base64').length === SAMPLE_BLOB_BYTES)).toBe(true)
  })

  test('reports the status the webhook answered, such as a size limit', async () => {
    await configure(listen(413), 'k')
    const response = await call('POST', '/api/notify/test')
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ ok: false, status: 413, error: 'the webhook answered 413' })
  })

  test('does not touch the outbox', async () => {
    await configure(listen(500), 'k')
    await call('POST', '/api/notify/test')
    expect((await (await call('GET', '/api/notify')).json()).pending).toBe(0)
  })
})

describe('sampleEvent', () => {
  const item = (id: string, updatedAt: number, pick: boolean): QueueItem => ({
    id, source: 'clickup', externalId: id, title: id, url: `https://x/${id}`, repo: '/r', flowId: null, state: 'ready', worktree: `/wt/${id}`, contextPath: null, answerPaths: [],
    runIds: [], currentRunId: null, questions: [], lastSeenId: null, error: null, createdAt: 1, updatedAt,
    ...(pick ? { pick: { options: ['A', 'B'], path: 'visualizer/x', recommended: 'A', tester: null, summary: '' } } : {}),
  })

  test('uses the renders of the most recent item with a pick', () => {
    const { input, extra } = sampleEvent([item('old', 1, true), item('new', 5, true), item('newest-no-pick', 9, false)])
    expect(extra).toEqual([])
    expect(input.queueItemId).toBe('new')
    expect(input.mockups?.map(mockup => mockup.root)).toEqual(['/wt/new', '/wt/new'])
  })

  test('falls back to three 800 KB blobs', () => {
    const { input, extra } = sampleEvent([item('plain', 1, false)])
    expect(extra).toHaveLength(3)
    expect(extra.map(blob => Buffer.from(blob.base64, 'base64').length)).toEqual([SAMPLE_BLOB_BYTES, SAMPLE_BLOB_BYTES, SAMPLE_BLOB_BYTES])
    expect(input.event).toBe('pick')
  })
})
