import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import { listMessages, message, messageLines } from '../server/messages'
import { askLines } from '../server/queue-pick-ask'
import { humanSettingsRoutes } from '../server/routes/human-settings'

let dir: string
const priorConfigDir = process.env.SKD_CONFIG_DIR
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skd-messages-'))
  process.env.SKD_CONFIG_DIR = dir
})
afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.SKD_CONFIG_DIR
  else process.env.SKD_CONFIG_DIR = priorConfigDir
  await rm(dir, { recursive: true, force: true })
})

const override = async (name: string, text: string) => {
  await mkdir(join(dir, 'messages'), { recursive: true })
  await writeFile(join(dir, 'messages', `${name}.md`), text)
}
const call = (path: string, method: string, body?: unknown) => new Elysia().use(humanSettingsRoutes()).handle(new Request(`http://127.0.0.1:7777${path}`, {
  method, headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}))
const settingsLines = async () => (await readFile(join(dir, 'queue-audit', '_settings.jsonl'), 'utf8')).trimEnd().split('\n')

test('with no files every message is its built-in default', () => {
  expect(message('ack')).toBe('✅ รับทราบครับ')
  expect(message('confirm-pick', { option: 'C' })).toBe('ได้ครับ ใช้แบบ C')
  expect(messageLines('clarify', { options: 'A / B' })[1]).toBe('- ตอบเป็นตัวอักษร: A / B')
  expect(message('recommended')).toBe(' (แนะนำ)')
})

test('an override file replaces the default, keeps a leading space, and fills only its own slots', async () => {
  await override('confirm-pick', 'โอเค แบบ {option} {host} {x}\n\n')
  await override('recommended', ' ⭐\n')
  expect(message('confirm-pick', { option: 'B', host: 'evil.example' })).toBe('โอเค แบบ B {host} {x}')
  expect(message('recommended')).toBe(' ⭐')
})

test('a slot value is inserted once and never re-read as a slot', async () => {
  expect(message('confirm-pick', { option: '{option}' })).toBe('ได้ครับ ใช้แบบ {option}')
})

test('an empty or oversized override is ignored with an error naming the file', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await override('ack', '   \n')
    expect(message('ack')).toBe('✅ รับทราบครับ')
    await override('ack', 'x'.repeat(2001))
    expect(message('ack')).toBe('✅ รับทราบครับ')
    expect(errors.mock.calls.map(call => String(call[0]))).toEqual([expect.stringContaining(join(dir, 'messages', 'ack.md')), expect.stringContaining(join(dir, 'messages', 'ack.md'))])
  } finally { errors.mockRestore() }
})

test('the pick ask uses the edited header and recommended mark', async () => {
  await override('ask-header', 'เลือกได้ที่ https://{host}\nตอบเป็นตัวอักษรครับ')
  const pick = { options: ['A', 'B'], path: '', recommended: 'B', tester: null, summary: '' }
  expect(askLines(pick, 'x.shikidan.com')).toEqual(['เลือกได้ที่ https://x.shikidan.com', 'ตอบเป็นตัวอักษรครับ', 'A', 'B (แนะนำ)'])
})

test('GET /api/messages lists each name with its default, override and slots', async () => {
  await override('ack', 'ok')
  const listed = (await (await call('/api/messages', 'GET')).json()).messages
  expect(listed).toEqual(listMessages())
  expect(listed.find((entry: { name: string }) => entry.name === 'ack')).toEqual({ name: 'ack', default: '✅ รับทราบครับ', override: 'ok', slots: [] })
  expect(listed.map((entry: { name: string }) => entry.name)).toEqual(['ack', 'clarify', 'confirm-none', 'confirm-keep', 'confirm-pick', 'ask-header', 'recommended'])
})

test('PUT and DELETE need actor human; every attempt writes a hash-chained _settings audit line', async () => {
  const refused = await call('/api/messages/ack', 'PUT', { actor: 'grok', text: 'hi' })
  expect(refused.status).toBe(403)
  expect(message('ack')).toBe('✅ รับทราบครับ')
  expect((await call('/api/messages/ack', 'PUT', { actor: 'human', text: 'รับแล้วครับ', why: 'shorter' })).status).toBe(200)
  expect(message('ack')).toBe('รับแล้วครับ')
  expect((await call('/api/messages/ack', 'DELETE', { actor: 'doctor' })).status).toBe(403)
  expect((await call('/api/messages/ack', 'DELETE', { actor: 'human' })).status).toBe(200)
  expect(message('ack')).toBe('✅ รับทราบครับ')
  const lines = await settingsLines()
  const parsed = lines.map(line => JSON.parse(line))
  expect(parsed.map(line => [line.actor, line.action, line.result])).toEqual([['grok', 'message-set', 'refused'], ['human', 'message-set', 'ok'], ['doctor', 'message-reset', 'refused'], ['human', 'message-reset', 'ok']])
  expect(parsed[1]).toMatchObject({ why: 'shorter', params: { name: 'ack', text: 'รับแล้วครับ' } })
  expect(parsed.map(line => line.prev)).toEqual(['', ...lines.slice(0, -1).map(line => createHash('sha256').update(line).digest('hex'))])
})

test('an unknown name is 404, bad text is 400, and nothing is written', async () => {
  expect((await call('/api/messages/land', 'PUT', { actor: 'human', text: 'x' })).status).toBe(404)
  expect((await call('/api/messages/..%2Fsecrets', 'PUT', { actor: 'human', text: 'x' })).status).toBe(404)
  expect((await call('/api/messages/ack', 'PUT', { actor: 'human', text: '  ' })).status).toBe(400)
  expect((await call('/api/messages/ack', 'PUT', { actor: 'human', text: 'x'.repeat(2001) })).status).toBe(400)
  expect(message('ack')).toBe('✅ รับทราบครับ')
})
