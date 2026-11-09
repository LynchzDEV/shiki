import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_MOCKUP_BYTES, MAX_PENDING, RETRY_LADDER_MS, createNotifier, readContainedImage, type NotifyInput } from '../server/notify'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skd-notify-'))
  path = join(dir, 'notify-outbox.json')
})

afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

type Call = { url: string; init: RequestInit }

function harness(options: { url?: string | null; replies?: Array<number | 'throw'> } = {}) {
  const calls: Call[] = []
  const timers: Array<{ run: () => void; ms: number }> = []
  const replies = [...(options.replies ?? [])]
  let counter = 0
  const config = { url: options.url === undefined ? 'https://bot.example/hook' : options.url, key: 'whk-key' }
  const make = () => createNotifier({
    path,
    config: async () => config,
    fetch: async (url, init) => {
      calls.push({ url, init: init ?? {} })
      const reply = replies.shift() ?? 200
      if (reply === 'throw') throw new Error('network down')
      return new Response('', { status: reply })
    },
    schedule: (run, ms) => { timers.push({ run, ms }) },
    now: () => new Date('2026-09-01T10:00:00.000Z'),
    newId: () => `evt-${++counter}`,
    readImage: async (root, relative) => (relative.endsWith('missing.png') ? null : Buffer.from(`${root}|${relative}`)),
  })
  return { calls, timers, config, make }
}

const input = (patch: Partial<NotifyInput> = {}): NotifyInput => ({
  event: 'pick', fingerprintKey: 'item-1:pick', itemState: 'waiting-pick', title: 'Card', detail: 'Choose one',
  queueItemId: 'item-1', taskId: 'T1', taskUrl: 'https://app.clickup.com/t/T1', ...patch,
})

const body = (call: Call) => JSON.parse(call.init.body as string)

describe('createNotifier', () => {
  test('posts the exact event shape with both auth headers', async () => {
    const h = harness()
    const notifier = h.make()
    await notifier.emit(input({ node: 'mockups', runId: 'run-1', runStatus: 'running', clickupStatus: 'hold', options: ['A', 'B'], recommended: 'A', questions: ['Which?'], landStage: 'uat' }))
    await notifier.drain()
    expect(h.calls).toHaveLength(1)
    const call = h.calls[0]!
    expect(call.url).toBe('https://bot.example/hook')
    const headers = call.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer whk-key')
    expect(headers['X-Automation-Key']).toBe('whk-key')
    expect(headers['Content-Type']).toBe('application/json')
    expect(body(call)).toEqual({
      eventId: 'evt-1', event: 'pick', at: '2026-09-01T10:00:00.000Z',
      queueItemId: 'item-1', runId: 'run-1', taskId: 'T1', taskUrl: 'https://app.clickup.com/t/T1', title: 'Card',
      node: 'mockups', itemState: 'waiting-pick', runStatus: 'running', clickupStatus: 'hold',
      detail: 'Choose one', questions: ['Which?'], options: ['A', 'B'], recommended: 'A', mockups: [], landStage: 'uat',
    })
  })

  test('absent fields are null or empty, never undefined', async () => {
    const h = harness()
    const notifier = h.make()
    await notifier.emit({ event: 'slow', fingerprintKey: 'job-1:slow', title: 'Job' })
    await notifier.drain()
    expect(body(h.calls[0]!)).toEqual({
      eventId: 'evt-1', event: 'slow', at: '2026-09-01T10:00:00.000Z',
      queueItemId: null, runId: null, taskId: null, taskUrl: null, title: 'Job',
      node: null, itemState: null, runStatus: null, clickupStatus: null,
      detail: '', questions: [], options: [], recommended: null, mockups: [], landStage: null,
    })
  })

  test('cuts detail to 2000 characters', async () => {
    const h = harness()
    const notifier = h.make()
    await notifier.emit(input({ detail: 'x'.repeat(5000) }))
    await notifier.drain()
    expect(body(h.calls[0]!).detail).toHaveLength(2000)
  })

  test('attaches mockups read at send time and skips a missing file', async () => {
    const h = harness()
    const notifier = h.make()
    await notifier.emit(input({ mockups: [{ option: 'A', root: '/wt', relative: 'pick/renders/a.png' }, { option: 'B', root: '/wt', relative: 'pick/renders/missing.png' }] }))
    await notifier.drain()
    expect(body(h.calls[0]!).mockups).toEqual([{ option: 'A', name: 'a.png', mime: 'image/png', base64: Buffer.from('/wt|pick/renders/a.png').toString('base64') }])
  })

  test('with no url nothing is enqueued, and the fingerprint is not recorded', async () => {
    const h = harness({ url: null })
    const notifier = h.make()
    await notifier.emit(input())
    expect(notifier.pending()).toBe(0)
    h.config.url = 'https://bot.example/hook'
    await notifier.emit(input())
    await notifier.drain()
    expect(h.calls).toHaveLength(1)
  })

  test('the same fingerprint is sent once, a changed state or detail is sent again', async () => {
    const h = harness()
    const notifier = h.make()
    await notifier.emit(input())
    await notifier.emit(input())
    await notifier.emit(input({ detail: 'Different' }))
    await notifier.drain()
    expect(h.calls.map(call => body(call).detail)).toEqual(['Choose one', 'Different'])
  })

  test('retries keep the eventId and stop at the first 2xx', async () => {
    const h = harness({ replies: [500, 'throw', 503, 502, 500, 200] })
    const notifier = h.make()
    await notifier.emit(input())
    await notifier.drain()
    expect(RETRY_LADDER_MS).toEqual([10_000, 60_000, 300_000, 1_800_000])
    for (let step = 0; step < 5; step += 1) { h.timers.shift()!.run(); await notifier.drain() }
    expect(h.calls).toHaveLength(6)
    expect(new Set(h.calls.map(call => body(call).eventId))).toEqual(new Set(['evt-1']))
    expect(notifier.pending()).toBe(0)
    expect(h.timers).toHaveLength(0)
  })

  test('schedules each retry on the ladder, then every 30 minutes', async () => {
    const h = harness({ replies: [500, 500, 500, 500, 500, 200] })
    const notifier = h.make()
    await notifier.emit(input())
    await notifier.drain()
    const delays: number[] = [h.timers[0]!.ms]
    for (let step = 0; step < 4; step += 1) { h.timers.shift()!.run(); await notifier.drain(); delays.push(h.timers[0]!.ms) }
    expect(delays).toEqual([10_000, 60_000, 300_000, 1_800_000, 1_800_000])
  })

  test('a restart resumes the pending event and delivers it once', async () => {
    const h = harness({ replies: [500] })
    const first = h.make()
    await first.emit(input())
    await first.drain()
    expect(first.pending()).toBe(1)
    h.timers.length = 0
    const second = h.make()
    expect(second.pending()).toBe(1)
    await second.resume()
    await second.drain()
    expect(second.pending()).toBe(0)
    expect(h.calls.map(call => body(call).eventId)).toEqual(['evt-1', 'evt-1'])
    expect(h.timers).toHaveLength(0)
  })

  test('the same fingerprint is not enqueued again across a restart', async () => {
    const h = harness()
    const first = h.make()
    await first.emit(input())
    await first.drain()
    const second = h.make()
    await second.emit(input())
    await second.drain()
    expect(h.calls).toHaveLength(1)
  })

  test('the outbox file holds pending and fingerprints', async () => {
    const h = harness({ replies: [500] })
    const notifier = h.make()
    await notifier.emit(input())
    await notifier.drain()
    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect(stored.last['item-1:pick']).toBe('waiting-pick|Choose one')
    expect(stored.pending).toHaveLength(1)
  })

  test('send posts straight away, without the outbox, and reports the status', async () => {
    const h = harness({ replies: [413] })
    const notifier = h.make()
    expect(await notifier.send(input())).toEqual({ ok: false, status: 413 })
    expect(notifier.pending()).toBe(0)
  })

  test('send reports a network failure as an error', async () => {
    const h = harness({ replies: ['throw'] })
    const result = await h.make().send(input())
    expect(result).toEqual({ ok: false, status: null, error: 'network down' })
  })

  test('send fails clearly when no url is configured', async () => {
    const result = await harness({ url: null }).make().send(input())
    expect(result).toEqual({ ok: false, status: null, error: 'no webhook url configured' })
  })

  test('an explicit fingerprint replaces the state and detail one', async () => {
    const h = harness()
    const notifier = h.make()
    await notifier.emit(input({ fingerprint: 'same' }))
    await notifier.emit(input({ fingerprint: 'same', detail: 'Different' }))
    await notifier.emit(input({ fingerprint: 'other' }))
    await notifier.drain()
    expect(h.calls.map(call => body(call).detail)).toEqual(['Choose one', 'Choose one'])
  })

  test('a delivery that finds no url keeps the event and retries on the ladder', async () => {
    const h = harness({ replies: [500] })
    const notifier = h.make()
    await notifier.emit(input())
    await notifier.drain()
    h.config.url = null
    h.timers.shift()!.run()
    await notifier.drain()
    expect(h.calls).toHaveLength(1)
    expect(notifier.pending()).toBe(1)
    expect(h.timers.map(timer => timer.ms)).toEqual([60_000])
    h.config.url = 'https://bot.example/hook'
    h.timers.shift()!.run()
    await notifier.drain()
    expect(h.calls.map(call => body(call).eventId)).toEqual(['evt-1', 'evt-1'])
    expect(notifier.pending()).toBe(0)
  })

  test('clear drops every pending event, and a waiting retry then sends nothing', async () => {
    const h = harness({ replies: [500] })
    const notifier = h.make()
    await notifier.emit(input())
    await notifier.drain()
    await notifier.clear()
    expect(notifier.pending()).toBe(0)
    h.timers.shift()!.run()
    await notifier.drain()
    expect(h.calls).toHaveLength(1)
    expect(h.make().pending()).toBe(0)
  })

  test('resume while a retry is waiting does not start a second chain', async () => {
    const h = harness({ replies: [500, 500, 200] })
    const notifier = h.make()
    await notifier.emit(input())
    await notifier.drain()
    await notifier.resume()
    await notifier.drain()
    expect(h.calls).toHaveLength(1)
    expect(h.timers).toHaveLength(1)
    h.timers.shift()!.run()
    await notifier.drain()
    await notifier.resume()
    await notifier.drain()
    expect(h.calls).toHaveLength(2)
    expect(h.timers).toHaveLength(1)
    h.timers.shift()!.run()
    await notifier.drain()
    expect(h.calls).toHaveLength(3)
    expect(notifier.pending()).toBe(0)
    expect(h.timers).toHaveLength(0)
  })

  test(`holds at most ${MAX_PENDING} pending events, dropping the oldest and counting them`, async () => {
    const h = harness({ replies: Array(MAX_PENDING + 5).fill(500) })
    const notifier = h.make()
    for (let index = 1; index <= MAX_PENDING + 5; index += 1) await notifier.emit(input({ fingerprintKey: `item-${index}:pick` }))
    await notifier.drain()
    expect(MAX_PENDING).toBe(200)
    expect(notifier.pending()).toBe(200)
    expect(notifier.dropped()).toBe(5)
    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect(stored.dropped).toBe(5)
    expect(stored.pending[0].event.eventId).toBe('evt-6')
    expect(h.make().dropped()).toBe(5)
  })
})

describe('readContainedImage', () => {
  test('reads a render inside the root and skips one over 5 MB', async () => {
    const root = join(dir, 'wt')
    await mkdir(join(root, 'renders'), { recursive: true })
    await writeFile(join(root, 'renders', 'a.png'), 'png-bytes')
    await writeFile(join(root, 'renders', 'big.png'), '')
    await truncate(join(root, 'renders', 'big.png'), MAX_MOCKUP_BYTES + 1)
    expect(MAX_MOCKUP_BYTES).toBe(5 * 1024 * 1024)
    expect((await readContainedImage(root, 'renders/a.png'))?.toString()).toBe('png-bytes')
    expect(await readContainedImage(root, 'renders/big.png')).toBeNull()
  })
})
