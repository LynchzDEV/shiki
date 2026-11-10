import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import { cardToolbox, type AuditLine, type ToolboxDeps } from '../server/card-toolbox'
import { QueueRefusal } from '../server/queue-engine'
import { queueRoutes } from '../server/routes/queue'
import { parkedItem, queueHarness, refusal, type QueueHarness } from './support/queue-harness'

const SECRET = 'sk-test-secret-0123456789'
let dir: string
const priorConfigDir = process.env.SKD_CONFIG_DIR
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-card-toolbox-'))
  process.env.SKD_CONFIG_DIR = join(dir, 'config')
})
afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.SKD_CONFIG_DIR
  else process.env.SKD_CONFIG_DIR = priorConfigDir
  await rm(dir, { recursive: true, force: true })
})

const auditDir = () => join(dir, 'audit')
const toolboxOf = (h: QueueHarness, over: Partial<ToolboxDeps> = {}) => cardToolbox({ store: h.store, engine: h.engine, auditDir: auditDir(), secrets: async () => [SECRET], ...over })
const human = { actor: 'human', why: 'testing' }
const rawLines = async (id: string) => (await readFile(join(auditDir(), `${id}.jsonl`), 'utf8')).trimEnd().split('\n')
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

test('every performed action writes one hash-chained, redacted audit line: ok, refused and failed', async () => {
  let posting: 'ok' | 'down' = 'ok'
  const h = queueHarness(dir, {}, { post: async input => { if (posting === 'down') throw new Error(`ClickUp down, token ${SECRET}`); h.posted.push(input); return { commentId: 'c2' } } })
  const item = await parkedItem(h)
  const toolbox = toolboxOf(h)
  expect(await toolbox.perform(item.id, 'say', { text: `hello ${SECRET}` }, { actor: 'grok', why: `why ${SECRET}` })).toEqual({ state: 'waiting-info', node: null })
  expect(await refusal(toolbox.perform(item.id, 'pick', { option: 'A' }, human))).toMatchObject({ status: 409, message: 'It is waiting-info now' })
  posting = 'down'
  expect(await refusal(toolbox.perform(item.id, 'say', { text: 'again' }, human))).toMatchObject({ name: 'SourceFailure' })
  const lines = await rawLines(item.id)
  expect(lines).toHaveLength(3)
  const parsed = lines.map(line => JSON.parse(line) as AuditLine)
  expect(parsed.map(line => [line.actor, line.action, line.result])).toEqual([['grok', 'say', 'ok'], ['human', 'pick', 'refused'], ['human', 'say', 'failed']])
  expect(parsed.map(line => line.prev)).toEqual(['', sha256(lines[0]!), sha256(lines[1]!)])
  expect(lines.join('\n')).not.toContain(SECRET)
  expect(parsed[0]).toMatchObject({ cardId: item.id, why: 'why [REDACTED]', params: { text: 'hello [REDACTED]' }, before: { state: 'waiting-info', node: null }, after: { state: 'waiting-info', node: null } })
  expect(parsed[1]).toMatchObject({ error: 'It is waiting-info now', after: null })
  expect(parsed[2]!.error).toBe('ClickUp down, token [REDACTED]')
  expect(await toolbox.history(item.id)).toEqual(parsed)
})

test('bad params are refused with 400 and logged; an unknown card is a 404 that writes no file', async () => {
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  const toolbox = toolboxOf(h)
  expect(await refusal(toolbox.perform(item.id, 'say', { text: '' }, human))).toMatchObject({ status: 400, message: 'Write a message of 1 to 4000 characters' })
  expect((JSON.parse((await rawLines(item.id))[0]!) as AuditLine).result).toBe('refused')
  expect(await refusal(toolbox.perform('../../etc/passwd', 'say', { text: 'x' }, human))).toMatchObject({ status: 404 })
  expect(await refusal(toolbox.perform('nope', 'say', { text: 'x' }, human))).toMatchObject({ status: 404 })
  expect(await toolbox.history('nope')).toEqual([])
})

test('only toolbox actions can be performed: land, done, remove and object keys are not actions', async () => {
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  const toolbox = toolboxOf(h)
  for (const name of ['land', 'done', 'remove', 'constructor', '__proto__', 'toString']) {
    const refused = await refusal(toolbox.perform(item.id, name, {}, human))
    expect(refused).toBeInstanceOf(QueueRefusal)
    expect(refused).toMatchObject({ status: 404, message: `No such action: ${name}` })
  }
  expect(h.store.get(item.id)!.state).toBe('waiting-info')
})

test('show returns the card, its run and its last 10 audit lines, and writes none itself', async () => {
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  const run = { id: 'run-1', status: 'blocked', error: null, currentNodeId: 'plan', attempts: [{ nodeId: 'plan', number: 0, status: 'settled', result: { outcome: 'blocked', summary: 'Need info' } }] }
  const toolbox = toolboxOf(h, { runs: { get: id => (id === 'run-1' ? run : undefined) } })
  for (let n = 0; n < 12; n += 1) await refusal(toolbox.perform(item.id, 'pick', { option: 'A' }, human))
  const shown = await toolbox.perform(item.id, 'show', {}, human) as { item: { id: string }; run: unknown; history: AuditLine[] }
  expect(shown.item.id).toBe(item.id)
  expect(shown.run).toEqual(run)
  expect(shown.history).toHaveLength(10)
  expect(shown.history[0]!.before).toEqual({ state: 'waiting-info', node: 'plan' })
  expect(await rawLines(item.id)).toHaveLength(12)
})

test('say, stop and requeue --fresh are never doctor actions', async () => {
  const toolbox = toolboxOf(queueHarness(dir))
  expect(toolbox.traits('say', { text: 'x' })).toMatchObject({ openWorld: true, doctor: false })
  expect(toolbox.traits('stop', {})).toMatchObject({ destructive: true, doctor: false })
  expect(toolbox.traits('requeue', { fresh: true })).toMatchObject({ destructive: true, doctor: false })
  expect(toolbox.traits('requeue', {})).toMatchObject({ destructive: false, doctor: true })
  expect(toolbox.traits('show', {})).toMatchObject({ readOnly: true })
})

type App = { handle(request: Request): Promise<Response> }
const send = (app: App, path: string, init: RequestInit = {}) => app.handle(new Request(`http://127.0.0.1:7777${path}`, { ...init, headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' } }))
const post = (app: App, path: string, body: unknown) => send(app, path, { method: 'POST', body: JSON.stringify(body) })

function appOf(h: QueueHarness) {
  const toolbox = toolboxOf(h)
  return new Elysia().use(queueRoutes(h.store, h.engine, undefined, undefined, undefined, toolbox))
}

test('POST /do/:action performs as the named actor; a non-action is a 404 and a bad body a 400', async () => {
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  const app = appOf(h)
  const done = await post(app, `/api/queue/${item.id}/do/say`, { params: { text: 'hi' }, actor: 'grok', why: 'tell the owner' })
  expect(done.status).toBe(200)
  expect(await done.json()).toMatchObject({ result: { state: 'waiting-info' }, item: { id: item.id } })
  for (const name of ['land', 'done', 'remove', 'constructor']) {
    const refused = await post(app, `/api/queue/${item.id}/do/${name}`, { params: {}, actor: 'grok', why: 'try it' })
    expect([name, refused.status]).toEqual([name, 404])
  }
  for (const body of [{ params: {}, actor: 'grok' }, { params: {}, actor: 'Grok Bot', why: 'x' }, { params: {}, actor: 'grok', why: 'x', expect: 'sleeping' }, { params: {}, actor: 'grok', why: 'x', key: 'has space' }]) {
    expect((await post(app, `/api/queue/${item.id}/do/say`, body)).status).toBe(400)
  }
  expect((await post(app, `/api/queue/${item.id}/do/say`, { params: { text: '' }, actor: 'grok', why: 'x' })).status).toBe(400)
  expect((JSON.parse((await rawLines(item.id))[0]!) as AuditLine).actor).toBe('grok')
})

test('the browser routes go through the toolbox as human and are logged too', async () => {
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  const app = appOf(h)
  expect((await post(app, `/api/queue/${item.id}/say`, { text: 'from the browser' })).status).toBe(200)
  expect((await post(app, `/api/queue/${item.id}/pick`, { option: 'A' })).status).toBe(409)
  const lines = (await rawLines(item.id)).map(line => JSON.parse(line) as AuditLine)
  expect(lines.map(line => [line.actor, line.action, line.result, line.why])).toEqual([['human', 'say', 'ok', 'browser'], ['human', 'pick', 'refused', 'browser']])
})

test('GET show and history return the card and its log; an unknown card is a clean 404', async () => {
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  const app = appOf(h)
  await post(app, `/api/queue/${item.id}/say`, { text: 'hi' })
  const shown = await (await send(app, `/api/queue/${item.id}/show`)).json()
  expect(shown).toMatchObject({ item: { id: item.id, state: 'waiting-info' }, run: null, history: [{ action: 'say' }] })
  expect(await (await send(app, `/api/queue/${item.id.slice(0, 8)}/history`)).json()).toMatchObject({ history: [{ action: 'say', result: 'ok' }] })
  for (const path of ['/api/queue/bogus/show', '/api/queue/bogus/history']) {
    const missing = await send(app, path)
    expect(missing.status).toBe(404)
    expect((await missing.json()).error).toBe('No queue item bogus')
  }
})
