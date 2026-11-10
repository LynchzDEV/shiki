import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import { cardToolbox, type AuditLine, type ToolboxDeps } from '../server/card-toolbox'
import { QueueRefusal } from '../server/queue-engine'
import { queueRoutes } from '../server/routes/queue'
import { add, blockedWith, parkedItem, queueHarness, refusal, type QueueHarness } from './support/queue-harness'

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
  const toolbox = toolboxOf(h, { runs: { get: id => (id === 'run-1' ? { ...run, request: 'big', attempts: run.attempts.map(attempt => ({ ...attempt, prompt: 'x'.repeat(1000) })) } : undefined) } })
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

test('a card leased to another actor refuses with 423 naming the holder; an expired lease can be reclaimed', async () => {
  let clock = 1_700_000_000_000
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  const toolbox = toolboxOf(h, { now: () => clock })
  const lease = await toolbox.claim(item.id, 'grok', 30 * 60_000, 'fixing the pick')
  expect(lease).toEqual({ holder: 'grok', until: clock + 30 * 60_000 })
  const refused = await refusal(toolbox.perform(item.id, 'say', { text: 'hi' }, human))
  expect(refused).toMatchObject({ status: 423 })
  expect((refused as Error).message).toStartWith('grok holds this card until')
  expect(await refusal(toolbox.claim(item.id, 'doctor', 60_000))).toMatchObject({ status: 423 })
  expect(await refusal(toolbox.release(item.id, 'doctor'))).toMatchObject({ status: 423 })
  expect(await toolbox.perform(item.id, 'say', { text: 'hi' }, { actor: 'grok', why: 'mine' })).toMatchObject({ state: 'waiting-info' })
  expect((await toolbox.perform(item.id, 'show', {}, human) as { lease: unknown }).lease).toEqual(lease)
  clock += 30 * 60_000 + 1
  expect((await toolbox.perform(item.id, 'show', {}, human) as { lease: unknown }).lease).toBeNull()
  expect(await toolbox.perform(item.id, 'say', { text: 'after' }, human)).toMatchObject({ state: 'waiting-info' })
  expect(await toolbox.claim(item.id, 'doctor', 60_000)).toEqual({ holder: 'doctor', until: clock + 60_000 })
  await toolbox.release(item.id, 'doctor', 'done')
  expect(h.store.get(item.id)!.lease).toBeUndefined()
  for (const ms of [59_999, 4 * 60 * 60_000 + 1, 1.5]) expect(await refusal(toolbox.claim(item.id, 'grok', ms))).toMatchObject({ status: 400 })
  const actions = (await toolbox.history(item.id)).map(line => `${line.actor} ${line.action} ${line.result}`)
  expect(actions.slice(0, 7)).toEqual(['grok claim ok', 'human say refused', 'doctor claim refused', 'doctor release refused', 'grok say ok', 'human say ok', 'doctor claim ok'])
})

test('the same idempotency key and params returns the stored result without running again; other params are a 409', async () => {
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  const toolbox = toolboxOf(h)
  const before = h.posted.length
  const meta = { actor: 'grok', why: 'tell', key: 'plan-1:0' }
  const first = await toolbox.perform(item.id, 'say', { text: 'once' }, meta)
  expect(await toolbox.perform(item.id, 'say', { text: 'once' }, meta)).toEqual(first)
  expect(h.posted.length).toBe(before + 1)
  expect(await refusal(toolbox.perform(item.id, 'say', { text: 'twice' }, meta))).toMatchObject({ status: 409, message: 'Key plan-1:0 was already used for a different action or params' })
  expect(await refusal(toolbox.perform(item.id, 'reread', {}, meta))).toMatchObject({ status: 409 })
  expect(h.posted.length).toBe(before + 1)
  expect((await toolbox.history(item.id)).map(line => line.result)).toEqual(['ok', 'replayed', 'refused', 'refused'])
  expect(h.restart().store.get(item.id)!.actionKeys).toEqual([{ key: 'plan-1:0', action: 'say', paramsHash: expect.any(String), result: first }])
})

test('expect refuses with 409 when the card moved on', async () => {
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  const toolbox = toolboxOf(h)
  expect(await refusal(toolbox.perform(item.id, 'say', { text: 'x' }, { ...human, expect: 'waiting-pick' }))).toMatchObject({ status: 409, message: 'Expected waiting-pick, but it is waiting-info now' })
  expect(await toolbox.perform(item.id, 'say', { text: 'x' }, { ...human, expect: 'waiting-info' })).toMatchObject({ state: 'waiting-info' })
})

test('over its limit an action is refused with 429 and raises attention; only a human reset clears it', async () => {
  let clock = 1_700_000_000_000
  const alerts: string[] = []
  const cleared: string[] = []
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  const toolbox = toolboxOf(h, { now: () => clock, limits: async () => ({ say: 2 }), alert: (_item, reason) => { alerts.push(reason) }, clearAlert: id => { cleared.push(id) } })
  expect((await toolbox.limits()).say).toBe(2)
  expect((await toolbox.limits()).pick).toBe(3)
  for (const text of ['one', 'two']) await toolbox.perform(item.id, 'say', { text }, human)
  await refusal(toolbox.perform(item.id, 'say', { text: '' }, human))
  expect(await refusal(toolbox.perform(item.id, 'say', { text: 'three' }, human))).toMatchObject({ status: 429 })
  expect(alerts).toEqual(['Card needs a human: say reached its limit of 2 in 24 hours'])
  expect(await refusal(toolbox.resetLimits(item.id, 'grok', 'let me'))).toMatchObject({ status: 403 })
  expect(cleared).toEqual([])
  clock += 1
  await toolbox.resetLimits(item.id, 'human', 'checked the thread')
  expect(cleared).toEqual([item.id])
  expect(await toolbox.perform(item.id, 'say', { text: 'three' }, human)).toMatchObject({ state: 'waiting-info' })
  clock += 24 * 60 * 60_000
  await toolbox.perform(item.id, 'say', { text: 'next day' }, human)
  expect(h.restart().store.get(item.id)!.limitsResetAt).toBe(1_700_000_000_001)
})

test('the reply poller skips a card leased to someone else, but not one leased to poller or expired', async () => {
  let clock = 1_700_000_000_000
  const h = queueHarness(dir, { now: () => clock })
  const item = await parkedItem(h)
  h.answer(async () => ({ replies: [{ id: 'r1', author: 'Ploy', authorId: '', text: 'The login page', images: [] }], lastId: 'r1' }))
  await h.store.update(item.id, { lease: { holder: 'grok', until: clock + 60_000 } })
  expect(await h.engine.checkReplies()).toEqual({ checked: 0, resumed: 0 })
  expect(h.store.get(item.id)!.state).toBe('waiting-info')
  await h.store.update(item.id, { lease: { holder: 'poller', until: clock + 60_000 } })
  expect((await h.engine.checkReplies()).checked).toBe(1)
  expect(h.store.get(item.id)!.state).not.toBe('waiting-info')
})

test('an expired lease does not hold back the poller', async () => {
  let clock = 1_700_000_000_000
  const h = queueHarness(dir, { now: () => clock })
  const item = await parkedItem(h)
  h.answer(async () => ({ replies: [{ id: 'r1', author: 'Ploy', authorId: '', text: 'The login page', images: [] }], lastId: 'r1' }))
  await h.store.update(item.id, { lease: { holder: 'grok', until: clock + 60_000 } })
  clock += 60_001
  expect((await h.engine.checkReplies()).resumed).toBe(1)
})

test('limits are listed for anyone and changed only by a human; claim and release go through the routes', async () => {
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  const app = appOf(h)
  expect((await (await send(app, '/api/queue/limits')).json()).limits).toMatchObject({ say: 5, resume: 3, repost: 2 })
  const put = (body: unknown) => send(app, '/api/queue/limits', { method: 'PUT', body: JSON.stringify(body) })
  expect((await put({ actor: 'grok', action: 'say', limit: 50 })).status).toBe(403)
  expect((await put({ actor: 'human', action: 'land', limit: 5 })).status).toBe(400)
  const changed = await put({ actor: 'human', action: 'say', limit: 7 })
  expect((await changed.json()).limits.say).toBe(7)
  expect((await post(app, `/api/queue/${item.id}/claim`, { actor: 'grok', ms: 60_000 })).status).toBe(200)
  const blocked = await post(app, `/api/queue/${item.id}/say`, { text: 'from the browser' })
  expect(blocked.status).toBe(423)
  expect((await post(app, `/api/queue/${item.id}/release`, { actor: 'human' })).status).toBe(423)
  expect((await post(app, `/api/queue/${item.id}/release`, { actor: 'grok' })).status).toBe(200)
  expect((await post(app, `/api/queue/${item.id}/limits/reset`, { actor: 'grok', why: 'x' })).status).toBe(403)
  expect((await post(app, `/api/queue/${item.id}/limits/reset`, { actor: 'human', why: 'checked' })).status).toBe(200)
})

test('note writes an operator note marked with the actor, adds it to the answers, backs it up, and the next fresh run reads it', async () => {
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  const toolbox = toolboxOf(h)
  await toolbox.perform(item.id, 'note', { text: 'Keep the current design; fix the switcher.' }, { actor: 'grok', why: 'extra detail from Palm' })
  await toolbox.perform(item.id, 'note', { text: 'Second note' }, human)
  const paths = h.store.get(item.id)!.answerPaths
  expect(paths.map(path => path.split('/').at(-1))).toEqual(['operator-note-1.md', 'operator-note-2.md'])
  expect(await readFile(paths[0]!, 'utf8')).toBe('# Operator note\n\nFrom: grok\n\nKeep the current design; fix the switcher.\n')
  await rm(paths[0]!)
  await toolbox.perform(item.id, 'requeue', { fresh: true }, human)
  expect(await readFile(paths[0]!, 'utf8')).toContain('fix the switcher')
  expect(h.started.at(-1)!.request).toContain(paths[0]!)
  expect(await refusal(toolbox.perform(item.id, 'note', { text: ' ' }, human))).toMatchObject({ status: 400 })
  await h.store.update(item.id, { state: 'landed' })
  expect(await refusal(toolbox.perform(item.id, 'note', { text: 'late' }, human))).toMatchObject({ status: 409, message: 'It is landed now' })
})

test('resume refuses a bad step id, a runner that cannot resume, and a building card', async () => {
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  const toolbox = toolboxOf(h)
  expect(await refusal(toolbox.perform(item.id, 'resume', { at: '../how' }, human))).toMatchObject({ status: 400 })
  expect(await refusal(toolbox.perform(item.id, 'resume', { at: 'how' }, human))).toMatchObject({ status: 409, message: 'It has no run to resume' })
  await h.store.update(item.id, { state: 'building' })
  expect(await refusal(toolbox.perform(item.id, 'resume', { at: 'how' }, human))).toMatchObject({ status: 409, message: 'It is building now' })
  expect(h.store.get(item.id)!.resumeAt).toBeUndefined()
})

test('resume parks the card with resumeAt, and a resumeAt that fails fails the card instead of starting over', async () => {
  const resumedAt: Array<[string, string, string | undefined]> = []
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  h.runs.set('run-1', { ...h.runs.get('run-1')!, workflow: { nodes: [{ id: 'plan', title: 'Plan', maxVisits: 1 }, { id: 'how', title: 'How', maxVisits: 1 }] as never } })
  const restarted = h.restart({ resumeAt: async (id, nodeId, note) => { resumedAt.push([id, nodeId, note]); throw new Error('Workspace still has running work') } })
  const toolbox = cardToolbox({ store: restarted.store, engine: restarted.engine, auditDir: auditDir(), secrets: async () => [] })
  expect(await refusal(toolbox.perform(item.id, 'resume', { at: 'nope' }, human))).toMatchObject({ status: 400, message: 'No step nope in its flow; steps: plan, how' })
  await toolbox.perform(item.id, 'resume', { at: 'how', note: 'fix the switcher' }, { actor: 'grok', why: 'bug fix only' })
  expect(resumedAt).toEqual([['run-1', 'how', 'Operator note from grok: fix the switcher']])
  expect(restarted.store.get(item.id)).toMatchObject({ state: 'failed', error: 'Could not resume at how: Workspace still has running work' })
  expect(restarted.store.get(item.id)!.resumeAt).toBeUndefined()
  expect(h.started).toHaveLength(1)
})

test('a card parked to resume at a step keeps it across a restart, and loses it with its resume run', async () => {
  const h = queueHarness(dir)
  const item = await parkedItem(h)
  await h.store.update(item.id, { state: 'queued', resumeRunId: 'run-1', resumeAt: { node: 'how', note: 'n' }, lease: { holder: 'grok', until: 5 } })
  expect(h.restart().store.get(item.id)).toMatchObject({ resumeRunId: 'run-1', resumeAt: { node: 'how', note: 'n' }, lease: { holder: 'grok', until: 5 } })
  await h.store.update(item.id, { state: 'building' })
  expect(h.store.get(item.id)!.resumeAt).toBeUndefined()
})

test('incidents 1 and 2 on a card waiting on a ClickUp pick: pick none with the owner\'s text, and repost round 2', async () => {
  const h = queueHarness(dir, { pickIn: async () => 'clickup', publish: async () => ({ sub: '1-ab12cd34', host: '1-ab12cd34.shikidan.com', at: 7 }) })
  const card = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', attempts: [blockedWith(['pick: A,B | visualizer/login'])] }))
  expect(h.store.get(card.id)!.pick!.ask!.ref).toBe('ref-1')
  const toolbox = toolboxOf(h)
  expect(await toolbox.perform(card.id, 'repost', {}, { actor: 'grok', why: 'round 2 mockups, no new ask' })).toEqual({ state: 'waiting-pick', node: null })
  expect(h.store.get(card.id)!.pick!.ask!.ref).toBe('ref-2')
  expect(h.resolved).toEqual([{ id: '1', ref: 'ref-1' }])
  expect(await toolbox.perform(card.id, 'pick', { option: 'none', feedback: 'ไม่ชอบทั้งสองแบบ อยากได้ปุ่มใหญ่ขึ้น' }, { actor: 'grok', why: 'reject with free text was read as unclear' })).toMatchObject({ node: null })
  expect(h.store.get(card.id)!.pick).toBeUndefined()
  expect(h.started).toHaveLength(2)
  expect((await toolbox.history(card.id)).map(line => `${line.action} ${line.result}`)).toEqual(['repost ok', 'pick ok'])
})

test('the browser stop route names the holder of a lease instead of calling the card missing', async () => {
  const h = queueHarness(dir)
  const card = await h.engine.add(add)
  const app = appOf(h)
  expect((await post(app, `/api/queue/${card.id}/claim`, { actor: 'grok', ms: 60_000 })).status).toBe(200)
  const stopped = await post(app, `/api/queue/${card.id}/stop`, {})
  expect(stopped.status).toBe(423)
  expect((await stopped.json()).error).toStartWith('grok holds this card until')
  expect((await (await post(app, '/api/queue/nope/stop', {})).json()).error).toBe('No such queue item')
})
