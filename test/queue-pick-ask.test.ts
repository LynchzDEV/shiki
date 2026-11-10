import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QueueRefusal, SourceFailure, type QueueEngineDeps } from '../server/queue-engine'
import { askLines, type PickReplyEvent } from '../server/queue-pick-ask'
import type { QueueSource, SourceReplies, SourceReply } from '../server/queue-source'
import type { QueueItem } from '../server/queue-store'
import { createAttentionStore } from '../server/attention'
import { createNotifyEvents } from '../server/notify-events'
import { queueNeedsYou } from '../server/queue-attention'
import type { NotifyInput } from '../server/notify'
import { add, blockedWith, noReplies, queueHarness, refusal, reply } from './support/queue-harness'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'skd-pick-ask-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const PICK_LINE = 'pick: A,B,C | visualizer/login | B | Ploy'
const SUMMARY = [
  '## Recommendation',
  'B — the medium button keeps the form compact. A and C trade space for reach.',
  '',
  '## Options',
  '- A | Small button | keeps the current size, moves it under the form',
  '- B | Medium button | 48px button, full width on phones',
  '- C | Big button |',
  '',
  '## Points',
  '# | Feedback point | Still present? | File | Fix',
  '1 | Login button too small | yes | app/views/login.html.erb | Decision needed: button size',
  '',
  '## Facts',
  '- 1 point | still present on trunk',
  '- army only | fixes in klangtech-army only',
  '- 1 decision | #1',
  '',
  '## Tag',
  '- Ploy | assignee',
].join('\n')
const HOST = '1-ab12cd34.shikidan.com'
const ASK_LINES = [`รบกวนช่วยเลือกหน่อยครับว่าจะให้เป็นแบบไหนครับ https://${HOST}`, 'A Small button — keeps the current size, moves it under the form', 'B Medium button — 48px button, full width on phones (แนะนำ)', 'C Big button']
const KAN = { author: 'Kan', id: '11' }
const MAC = { author: 'Mac', id: '12' }
const PALM = { author: 'Palm', id: '99' }

type Setup = { deps?: Partial<QueueEngineDeps>; source?: Partial<QueueSource> }

function harness({ deps = {}, source = {} }: Setup = {}) {
  const published: Array<QueueItem['published']> = []
  const notices: PickReplyEvent[] = []
  const needs: Array<{ item: QueueItem; reason: string; options?: { webhook?: boolean } }> = []
  const replies = new Map<string, () => Promise<SourceReplies>>()
  let comments = 0
  const h = queueHarness(dir, {
    pickIn: async () => 'clickup',
    publish: async item => { published.push(item.published); return { sub: '1-ab12cd34', host: HOST, at: 7 } },
    notify: (_item, event) => { notices.push(event) },
    needsYou: (item, reason, options) => { needs.push({ item, reason, options }) },
    ...deps,
  }, {
    post: async input => { h.posted.push(input); comments += 1; return { commentId: `c${comments}`, ...(input.mention === undefined ? {} : { ref: `ref-${comments}` }) } },
    replies: async ({ id, sinceId }) => { h.sinceIds.push(sinceId); return (replies.get(id) ?? (async () => noReplies))() },
    ...source,
  })
  const block = async (runId: string, workflow?: { plugin?: string }) => {
    await h.engine.onRunSettled(h.settle(runId, { status: 'blocked', ...(workflow === undefined ? {} : { workflow }), attempts: [blockedWith([PICK_LINE], { output: SUMMARY })] }))
  }
  const from = (person: { author: string; id: string }, id: string, text: string) => reply(id, text, person.author, person.id)
  return { ...h, published, notices, needs, replies, block, from }
}

async function parked(setup: Setup = {}) {
  const h = harness(setup)
  const item = await h.engine.add(add)
  await h.block('run-1')
  return { ...h, id: item.id }
}

const pickFile = async (item: QueueItem): Promise<string> => readFile(item.answerPaths.find(path => path.endsWith('pick.md'))!, 'utf8')
const asks = (h: { posted: Array<{ kind: string; mention?: string }> }) => h.posted.filter(post => post.kind === 'ask')

test('a pick parks, publishes, tags the owner with the link and the options, then alerts once with the ask on the card', async () => {
  const h = await parked()
  expect(h.posted).toEqual([{ id: '1', kind: 'ask', lines: ASK_LINES, mention: '11', assignee: '11' }])
  const item = h.store.get(h.id)!
  expect(item).toMatchObject({ state: 'waiting-pick', lastSeenId: 'c1', published: { sub: '1-ab12cd34', host: HOST, at: 7 } })
  expect(item.pick!.ask).toEqual({ ref: 'ref-1', ownerId: '11', ownerName: 'Kan', meId: '99', host: HOST, postedAt: expect.any(Number), since: 'c1' })
  expect(h.needs.map(need => need.reason)).toEqual(['Pick a design variant'])
  expect(h.needs[0]!.item.pick!.ask!.host).toBe(HOST)
})

const pickOf = (summary: string) => ({ options: ['A', 'B', 'C'], path: 'visualizer/login', recommended: 'A', tester: null, summary })

test('option lines come only from the Options section, and the Recommendation line never describes an option', () => {
  const lines = askLines(pickOf('## Recommendation\nA — safest.\n\n## Options\n- **A** | Small | keeps the size\n- b | | only a description\n\n## Facts\n- C | not an option line'), HOST)
  expect(lines.slice(1)).toEqual(['A Small — keeps the size (แนะนำ)', 'B — only a description', 'C'])
})

test('a summary with no Options section shows only the option ids', () => {
  expect(askLines(pickOf('A — small\nB — medium\nC — big'), HOST).slice(1)).toEqual(['A (แนะนำ)', 'B', 'C'])
})

test('the ask overwrites an older lastSeenId so earlier owner comments are never judged', async () => {
  const h = harness()
  const item = await h.engine.add(add)
  await h.store.update(item.id, { lastSeenId: 'old-comment' })
  await h.block('run-1')
  expect(h.store.get(item.id)!.lastSeenId).toBe('c1')
})

test('Kan replies แบบ C: pick C is written exactly like the CLI pick, confirmed, resolved and announced', async () => {
  const h = harness()
  const viaClickUp = await h.engine.add(add)
  const viaCli = await h.engine.add({ ...add, externalId: '2' })
  await h.block('run-1')
  await h.block('run-2')
  h.replies.set('1', async () => h.from(KAN, 'c9', 'แบบ C'))
  expect(await h.engine.checkReplies()).toEqual({ checked: 2, resumed: 1 })
  await h.engine.pick(viaCli.id, { option: 'C' })
  const picked = h.store.get(viaClickUp.id)!
  expect(picked.pick).toBeUndefined()
  expect(['queued', 'building']).toContain(picked.state)
  expect(await pickFile(picked)).toBe('# Design pick\n\nOption: C\nTester: (not set)\nNote: (none)\n')
  expect(await pickFile(picked)).toBe(await pickFile(h.store.get(viaCli.id)!))
  expect(h.posted.filter(post => post.kind === 'update')).toEqual([{ id: '1', kind: 'update', lines: ['ได้ครับ ใช้แบบ C'] }, { id: '2', kind: 'update', lines: ['ได้ครับ ใช้แบบ C'] }])
  expect(h.resolved).toEqual([{ id: '1', ref: 'ref-1' }, { id: '2', ref: 'ref-2' }])
  expect(h.notices).toEqual([{ event: 'picked', replyId: 'c9', option: 'C', by: 'Kan' }])
})

test('a pick with a note on the next line carries the note into pick.md', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(KAN, 'c9', 'C ครับ\nปุ่มใหญ่ขึ้นหน่อย'))
  await h.engine.checkReplies()
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: C\nTester: (not set)\nNote: ปุ่มใหญ่ขึ้นหน่อย\n')
})

test('Mac replies B: nothing is picked, the reply is kept as context and never judged again', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(MAC, 'c9', 'B'))
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 0 })
  const item = h.store.get(h.id)!
  expect(item).toMatchObject({ state: 'waiting-pick', lastSeenId: 'c9' })
  const context = await readFile(item.answerPaths.at(-1)!, 'utf8')
  expect(context).toContain('### Mac\n\nB')
  expect(h.resolved).toEqual([])
  expect(h.notices).toEqual([])
  h.replies.set('1', async () => noReplies)
  await h.engine.checkReplies()
  expect(h.sinceIds.slice(-2)).toEqual(['c1', 'c9'])
})

test('a reply with no author id is context, not a pick', async () => {
  const h = await parked()
  h.replies.set('1', async () => reply('c9', 'C', 'Someone', ''))
  await h.engine.checkReplies()
  expect(h.store.get(h.id)!.state).toBe('waiting-pick')
})

test('me (the bot account) replies B: picks B', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(PALM, 'c9', 'B'))
  await h.engine.checkReplies()
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: B\n')
  expect(h.notices).toEqual([{ event: 'picked', replyId: 'c9', option: 'B', by: 'Palm' }])
})

test('A หรือ C ดี: still waiting, pick-unclear is sent, and the next reply can still pick', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(KAN, 'c9', 'A หรือ C ดี'))
  await h.engine.checkReplies()
  expect(h.store.get(h.id)).toMatchObject({ state: 'waiting-pick', lastSeenId: 'c9' })
  expect(h.notices).toEqual([{ event: 'pick-unclear', replyId: 'c9', text: 'A หรือ C ดี', by: 'Kan' }])
  expect(h.resolved).toEqual([])
  h.replies.set('1', async () => h.from(KAN, 'c10', 'เอา A'))
  await h.engine.checkReplies()
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: A\n')
})

test('in one batch, other people are kept and the owner\'s newest clear reply wins over older ones', async () => {
  const h = await parked()
  h.replies.set('1', async () => ({
    replies: [...h.from(MAC, 'c5', 'ผมว่า A').replies, ...h.from(KAN, 'c6', 'A หรือ C ดี').replies, ...h.from(KAN, 'c7', 'C').replies, ...h.from(KAN, 'c8', 'B').replies],
    lastId: 'c8',
  }))
  await h.engine.checkReplies()
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: B\n')
  expect(h.notices.map(notice => notice.event)).toEqual(['picked'])
  expect(h.store.get(h.id)!.answerPaths.some(path => path.includes('answers-1'))).toBe(true)
})

test('none from the owner rebuilds with the feedback, then the new round republishes to the same sub and asks again', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(KAN, 'c9', 'ไม่ชอบเลย อยากได้แบบเดิม'))
  await h.engine.checkReplies()
  const rebuilt = h.store.get(h.id)!
  expect(await pickFile(rebuilt)).toContain('Option: none\n')
  expect(await pickFile(rebuilt)).toContain('> อยากได้แบบเดิม')
  expect(h.posted.filter(post => post.kind === 'update')).toEqual([{ id: '1', kind: 'update', lines: ['ได้ครับ จะทำแบบใหม่ตามนี้ครับ'] }])
  expect(h.notices).toEqual([{ event: 'picked', replyId: 'c9', option: 'none', by: 'Kan' }])
  expect(rebuilt.state).toBe('building')
  await h.block(rebuilt.currentRunId!)
  expect(asks(h)).toHaveLength(2)
  expect(h.published).toEqual([undefined, { sub: '1-ab12cd34', host: HOST, at: 7 }])
  expect(h.store.get(h.id)).toMatchObject({ state: 'waiting-pick', lastSeenId: 'c3', pick: { ask: { ref: 'ref-3' } } })
})

test('a confirm or resolve that fails is logged, raises nothing, and the pick stands', async () => {
  const h = await parked({ source: { resolve: async () => { throw new Error('ClickUp down') } } })
  const posted = h.posted
  const quiet = console.error
  console.error = () => {}
  try {
    h.replies.set('1', async () => h.from(KAN, 'c9', 'C'))
    await h.engine.checkReplies()
  } finally { console.error = quiet }
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: C\n')
  expect(posted.filter(post => post.kind === 'update')).toHaveLength(1)
  expect(h.needs.map(need => need.reason)).toEqual(['Pick a design variant'])
})

test('a publish that fails still parks, alerts with the reason, sends publish-failed, and the pick can be made in Shikidan', async () => {
  const h = await parked({ deps: { publish: async () => { throw new Error('disk full') } } })
  const item = h.store.get(h.id)!
  expect(item.state).toBe('waiting-pick')
  expect(item.pick!.ask).toMatchObject({ error: 'disk full', host: null, ref: '' })
  expect(asks(h)).toEqual([])
  expect(h.needs.map(need => need.reason)).toEqual(['Pick in Shikidan, the ClickUp ask failed: disk full'])
  await h.engine.checkReplies()
  expect(asks(h)).toEqual([])
  expect(h.sinceIds).toEqual([])
  await h.engine.pick(h.id, { option: 'B' })
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: B\n')
  expect(h.resolved).toEqual([])
  expect(h.posted.filter(post => post.kind === 'update')).toEqual([])
})

test('people or post failing, or a plugin that returns no ref, also falls back to Shikidan with the host kept', async () => {
  const people = await parked({ source: { people: async () => { throw new Error('no source.people') } } })
  expect(people.store.get(people.id)!.pick!.ask).toMatchObject({ error: 'no source.people', host: HOST })
  await rm(dir, { recursive: true, force: true })
  const noRef = await parked({ source: { post: async () => ({ commentId: 'c1' }) } })
  expect(noRef.store.get(noRef.id)!.pick!.ask!.error).toBe('clickup-board did not say which comment it posted')
  expect(noRef.store.get(noRef.id)!.lastSeenId).toBeNull()
})

test('with pickIn shikidan nothing is published or posted, as before', async () => {
  const h = await parked({ deps: { pickIn: async () => 'shikidan' } })
  expect(h.posted).toEqual([])
  expect(h.published).toEqual([])
  expect(h.store.get(h.id)!.pick!.ask).toBeUndefined()
  expect(h.needs.map(need => need.reason)).toEqual(['Pick a design variant'])
  h.replies.set('1', async () => h.from(KAN, 'c9', 'C'))
  await h.engine.checkReplies()
  expect(h.store.get(h.id)!.state).toBe('waiting-pick')
})

test('pickIn is read from the flow plugin of the run', async () => {
  const asked: Array<string | undefined> = []
  const h = harness({ deps: { pickIn: async plugin => { asked.push(plugin); return 'shikidan' } } })
  await h.engine.add(add)
  await h.block('run-1', { plugin: 'fixstack' })
  expect(asked).toEqual(['fixstack'])
})

test('restart mid-ask: a parked card with no ask is asked once at recovery, and never again after', async () => {
  const h = await parked({ deps: { pickIn: async () => 'shikidan' } })
  expect(asks(h)).toEqual([])
  h.deps.pickIn = async () => 'clickup'
  const first = h.restart()
  await first.engine.recover()
  expect(asks(h)).toHaveLength(1)
  expect(first.store.get(h.id)!.pick!.ask!.ref).toBe('ref-1')
  await first.engine.checkReplies()
  await first.engine.checkReplies()
  const second = h.restart()
  await second.engine.recover()
  await second.engine.checkReplies()
  expect(asks(h)).toHaveLength(1)
  expect(second.store.get(h.id)!.pick!.ask).toMatchObject({ ref: 'ref-1', ownerName: 'Kan' })
  expect(second.store.get(h.id)!.published).toEqual({ sub: '1-ab12cd34', host: HOST, at: 7 })
})

test('the ask is stored as posting before the comment is sent', async () => {
  const seen: unknown[] = []
  const h = harness({ source: { post: async input => { seen.push(h.store.list()[0]!.pick!.ask); return { commentId: 'c1', ref: 'ref-1' } } } })
  await h.engine.add(add)
  await h.block('run-1')
  expect(seen).toEqual([{ ref: '', ownerId: '11', ownerName: 'Kan', meId: '99', host: HOST, postedAt: expect.any(Number), posting: true }])
  expect(h.store.list()[0]!.pick!.ask).not.toHaveProperty('posting')
})

test('a restart between storing posting and storing the ref never posts again and asks the operator to check the card', async () => {
  let reached!: () => void
  const sending = new Promise<void>(resolve => { reached = resolve })
  const h = harness({ source: { post: async input => { h.posted.push(input); reached(); return new Promise(() => {}) } } })
  const item = await h.engine.add(add)
  void h.block('run-1')
  await sending
  const after = h.restart()
  await after.engine.recover()
  await after.engine.checkReplies()
  await after.engine.checkReplies()
  const error = 'The ClickUp question may have been posted before a restart; check the card'
  expect(asks(h)).toHaveLength(1)
  expect(after.store.get(item.id)).toMatchObject({ state: 'waiting-pick', pick: { ask: { ref: '', error } } })
  expect(after.store.get(item.id)!.pick!.ask).not.toHaveProperty('posting')
  expect(h.needs.map(need => need.reason)).toEqual([`Pick in Shikidan, the ClickUp ask failed: ${error}`])
  expect(h.sinceIds).toEqual([])
  await after.engine.pick(item.id, { option: 'B' })
  expect(h.resolved).toEqual([])
})

test('checkReplies asks a parked card with no ask when recover has not', async () => {
  const h = await parked({ deps: { pickIn: async () => 'shikidan' } })
  h.deps.pickIn = async () => 'clickup'
  const restarted = h.restart()
  await restarted.engine.checkReplies()
  expect(asks(h)).toHaveLength(1)
})

test('a pick made in Shikidan resolves the open ask and confirms it in ClickUp', async () => {
  const h = await parked()
  await h.engine.pick(h.id, { option: 'B' })
  expect(h.posted.filter(post => post.kind === 'update')).toEqual([{ id: '1', kind: 'update', lines: ['ได้ครับ ใช้แบบ B'] }])
  expect(h.resolved).toEqual([{ id: '1', ref: 'ref-1' }])
  expect(h.notices).toEqual([])
})

test('none of these in Shikidan confirms the redo in ClickUp', async () => {
  const h = await parked()
  await h.engine.pick(h.id, { option: 'none', feedback: 'bigger' })
  expect(h.posted.filter(post => post.kind === 'update')).toEqual([{ id: '1', kind: 'update', lines: ['ได้ครับ จะทำแบบใหม่ตามนี้ครับ'] }])
  expect(h.resolved).toEqual([{ id: '1', ref: 'ref-1' }])
})

test('removing or requeueing a card with an open ask resolves the ask without a confirmation', async () => {
  const removed = await parked()
  await removed.engine.remove(removed.id)
  expect(removed.resolved).toEqual([{ id: '1', ref: 'ref-1' }])
  expect(removed.posted.filter(post => post.kind === 'update')).toEqual([])
  await rm(dir, { recursive: true, force: true })
  const requeued = await parked()
  await requeued.engine.requeue(requeued.id)
  expect(requeued.resolved).toEqual([{ id: '1', ref: 'ref-1' }])
  expect(requeued.posted.filter(post => post.kind === 'update')).toEqual([])
})

test('closing the ask when the card leaves another way is best effort: failures are logged and the action stands', async () => {
  const h = await parked({ source: { resolve: async () => { throw new Error('ClickUp down') } } })
  const quiet = console.error
  console.error = () => {}
  try {
    await h.engine.remove(h.id)
  } finally { console.error = quiet }
  expect(h.store.get(h.id)).toBeUndefined()
})

const DAY = 24 * 60 * 60 * 1000

function tearing(clock = { now: 1_000 * DAY }) {
  const removed: string[] = []
  let sweeps = 0
  const h = harness({ deps: { now: () => clock.now, publishKeepDays: async () => 14, unpublish: async item => { removed.push(item.published!.sub) }, sweepPublished: async () => { sweeps += 1 } } })
  return { ...h, removed, clock, sweeps: () => sweeps }
}

async function publishedCard(h: ReturnType<typeof tearing>, at: number) {
  const item = await h.engine.add(add)
  await h.block('run-1')
  return h.store.update(item.id, { published: { sub: '1-ab12cd34', host: HOST, at } })
}

test('a card that reaches landed is unpublished by itself', async () => {
  const h = tearing()
  const item = await publishedCard(h, h.clock.now)
  await h.store.update(item.id, { state: 'landed', pick: undefined })
  await h.engine.kick()
  expect(h.removed).toEqual(['1-ab12cd34'])
  expect(h.store.get(item.id)!.published).toBeUndefined()
})

test('removing a published card removes its folder', async () => {
  const h = tearing()
  const item = await publishedCard(h, h.clock.now)
  await h.engine.remove(item.id)
  expect(h.removed).toEqual(['1-ab12cd34'])
})

test('a link older than publishKeepDays is taken down by the sweep, a younger one stays', async () => {
  const h = tearing()
  const parked = await publishedCard(h, h.clock.now - 14 * DAY + 1)
  const item = await h.store.update(parked.id, { pick: { ...parked.pick!, ask: { ...parked.pick!.ask!, error: 'ClickUp down' } } })
  await h.engine.retirePublished()
  expect(h.removed).toEqual([])
  h.clock.now += 2
  await h.engine.retirePublished()
  expect(h.removed).toEqual(['1-ab12cd34'])
  expect(h.store.get(item.id)!.published).toBeUndefined()
  expect(h.store.get(item.id)!.state).toBe('waiting-pick')
})

test('the age sweep keeps the folder of a card whose ClickUp ask is still open', async () => {
  const h = tearing()
  const item = await publishedCard(h, h.clock.now - 30 * DAY)
  await h.engine.retirePublished()
  expect(h.removed).toEqual([])
  expect(h.store.get(item.id)!.published).toEqual({ sub: '1-ab12cd34', host: HOST, at: h.clock.now - 30 * DAY })
  await h.engine.pick(item.id, { option: 'B' })
  await h.engine.retirePublished()
  expect(h.removed).toEqual(['1-ab12cd34'])
})

test('every sweep also clears leftover folders in the publish dir', async () => {
  const h = tearing()
  await h.engine.retirePublished()
  await h.engine.retirePublished()
  expect(h.sweeps()).toBe(2)
})

test('unpublish on request takes the link down, and refuses a card with nothing published', async () => {
  const h = tearing()
  const item = await publishedCard(h, h.clock.now)
  expect((await h.engine.unpublish(item.id)).published).toBeUndefined()
  expect(h.removed).toEqual(['1-ab12cd34'])
  const refused = await h.engine.unpublish(item.id).catch((error: unknown) => error)
  expect(refused).toMatchObject({ message: 'It has no published link', status: 409 })
  await expect(h.engine.unpublish('nope')).rejects.toMatchObject({ status: 404 })
})

test('a folder that cannot be removed keeps the link on the card for the next sweep', async () => {
  const h = harness({ deps: { publishKeepDays: async () => 14, unpublish: async () => { throw new Error('EBUSY') } } })
  const item = await h.engine.add(add)
  await h.block('run-1')
  const quiet = console.error
  console.error = () => {}
  try {
    await h.store.update(item.id, { state: 'landed', pick: undefined, published: { sub: 's', host: HOST, at: 1 } })
    await h.engine.retirePublished()
  } finally { console.error = quiet }
  expect(h.store.get(item.id)!.published).toEqual({ sub: 's', host: HOST, at: 1 })
})

const refusalOf = async (work: Promise<unknown>) => { const error = await refusal(work); return error instanceof QueueRefusal ? [error.status, error.message] : error }

test('say writes into the ask thread while the pick is open, and leaves lastSeenId alone', async () => {
  const h = await parked()
  const said = await h.engine.say(h.id, 'ขอถามก่อนครับ\nแบบไหนดีครับ')
  expect(h.replied).toEqual([{ id: '1', ref: 'ref-1', lines: ['ขอถามก่อนครับ', 'แบบไหนดีครับ'] }])
  expect(h.posted.filter(post => post.kind === 'update')).toEqual([])
  expect(said.lastSeenId).toBe('c1')
  expect(h.store.get(h.id)!.state).toBe('waiting-pick')
})

test('say posts on the card when no pick is open', async () => {
  const h = harness()
  const item = await h.engine.add(add)
  await h.engine.say(item.id, 'กำลังทำอยู่ครับ')
  expect(h.replied).toEqual([])
  expect(h.posted).toEqual([{ id: '1', kind: 'update', lines: ['กำลังทำอยู่ครับ'] }])
})

test('say refuses an unknown item with 404 and an item with no source card with 409', async () => {
  const h = harness()
  expect(await refusalOf(h.engine.say('nope', 'hi'))).toEqual([404, 'No queue item nope'])
  const item = await h.engine.add(add)
  await h.store.update(item.id, { externalId: '' })
  expect(await refusalOf(h.engine.say(item.id, 'hi'))).toEqual([409, 'It has no source card to write to'])
})

test('say surfaces a failing source as a SourceFailure', async () => {
  const h = harness({ source: { post: async () => { throw new Error('ClickUp is down') } } })
  const item = await h.engine.add(add)
  const error = await refusal(h.engine.say(item.id, 'hi'))
  expect(error).toBeInstanceOf(SourceFailure)
  expect((error as Error).message).toBe('ClickUp is down')
})

test('reread goes back to the ask cursor and judges the replies again', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(KAN, 'c2', 'แบบ B'))
  await h.store.update(h.id, { lastSeenId: 'c99' })
  const item = await h.engine.reread(h.id)
  expect(h.sinceIds.at(-1)).toBe('c1')
  expect(await pickFile(item)).toContain('Option: B\n')
})

test('reread falls back to a minute before the ask when it has no cursor, and refuses an item that is not asked', async () => {
  const h = await parked()
  const ask = h.store.get(h.id)!.pick!.ask!
  const { since: _since, ...older } = ask
  await h.store.update(h.id, { pick: { ...h.store.get(h.id)!.pick!, ask: { ...older, postedAt: 5_000_000 } } })
  await h.engine.reread(h.id)
  expect(h.sinceIds.at(-1)).toBe('4940000')
  const idle = await h.engine.add({ ...add, externalId: '2' })
  expect(await refusalOf(h.engine.reread(idle.id))).toEqual([409, 'It is not waiting on a ClickUp pick'])
  expect(await refusalOf(h.engine.reread('nope'))).toEqual([404, 'No queue item nope'])
})

const ownerCases: Array<[string, string | null, { mention: string; ownerName: string }]> = [
  ['a user the card does not know', '12', { mention: '12', ownerName: '' }],
  ['the card creator, by id', '11', { mention: '11', ownerName: 'Kan' }],
  ['nobody set: the usual card owner', null, { mention: '11', ownerName: 'Kan' }],
]
for (const [name, to, expected] of ownerCases) {
  test(`pickAskTo ${name}: tagged, assigned and saved as the owner`, async () => {
    const h = await parked({ deps: { pickAskTo: async () => to } })
    expect(h.posted[0]).toMatchObject({ kind: 'ask', mention: expected.mention, assignee: expected.mention })
    expect(h.store.get(h.id)!.pick!.ask).toMatchObject({ ownerId: expected.mention, ownerName: expected.ownerName })
  })
}

test('with pickAskTo set, that user\'s reply decides the pick and the card owner\'s does not', async () => {
  const h = await parked({ deps: { pickAskTo: async () => '12' } })
  h.replies.set('1', async () => h.from(KAN, 'c9', 'A'))
  await h.engine.checkReplies()
  expect(h.store.get(h.id)!.state).toBe('waiting-pick')
  h.replies.set('1', async () => h.from(MAC, 'c10', 'แบบ B'))
  await h.engine.checkReplies()
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: B\n')
})

test('extra none phrases from the settings turn a reply into none with the rest as feedback', async () => {
  const h = await parked({ deps: { pickNonePhrases: async () => ['ขอใหม่ทั้งหมด'] } })
  h.replies.set('1', async () => h.from(KAN, 'c9', 'ขอใหม่ทั้งหมด ทับเว็บเลย'))
  await h.engine.checkReplies()
  const rebuilt = h.store.get(h.id)!
  expect(await pickFile(rebuilt)).toContain('Option: none\n')
  expect(await pickFile(rebuilt)).toContain('> ทับเว็บเลย')
})

test('the real stuck reply picks none with its feedback', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(KAN, 'c9', 'ไม่เอาซักช้อยส์เลย มันควรแสดงผลทับเว็บไปเลย ไม่ใช่ดันออกมา'))
  await h.engine.checkReplies()
  expect(await pickFile(h.store.get(h.id)!)).toContain('> มันควรแสดงผลทับเว็บไปเลย ไม่ใช่ดันออกมา')
})

test('a keep reply writes keep with the whole reply as the note, confirms in Thai and announces keep', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(KAN, 'c9', 'เหมือน NOW เลย แก้บั๊กอย่างเดียว'))
  await h.engine.checkReplies()
  const file = await pickFile(h.store.get(h.id)!)
  expect(file).toContain('Option: keep\nTester: (not set)\nNote: เหมือน NOW เลย แก้บั๊กอย่างเดียว\n')
  expect(file).toContain('## Keep the current design')
  expect(h.posted.filter(post => post.kind === 'update')).toEqual([{ id: '1', kind: 'update', lines: ['รับทราบครับ ใช้แบบเดิม (NOW) ไม่ปรับ UI แก้บั๊กอย่างเดียว'] }])
  expect(h.notices).toEqual([{ event: 'picked', replyId: 'c9', option: 'keep', by: 'Kan' }])
})

test('extra keep phrases from the settings turn a reply into keep', async () => {
  const h = await parked({ deps: { pickKeepPhrases: async () => ['ใช้ของเดิม'] } })
  h.replies.set('1', async () => h.from(KAN, 'c9', 'ใช้ของเดิม พอ'))
  await h.engine.checkReplies()
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: keep\n')
})

function threaded() {
  const thread: SourceReply[] = []
  const reads: Array<string | null> = []
  let failEarlier = false
  const source: Partial<QueueSource> = {
    replies: async ({ sinceId }) => {
      reads.push(sinceId)
      if (failEarlier && sinceId === 'c1') throw new Error('ClickUp is down')
      const at = thread.findIndex(entry => entry.id === sinceId)
      const fresh = at === -1 ? thread : thread.slice(at + 1)
      return { replies: fresh, lastId: fresh.at(-1)?.id ?? null }
    },
  }
  return { thread, reads, source, failEarlierRead: () => { failEarlier = true } }
}

const twoPolls = async (first: string, second: string) => {
  const t = threaded()
  const h = await parked({ source: t.source })
  t.thread.push(...reply('c9', first, KAN.author, KAN.id).replies, ...reply('c10', 'someone else chimes in', MAC.author, MAC.id).replies)
  await h.engine.checkReplies()
  expect(h.store.get(h.id)!.state).toBe('waiting-pick')
  t.thread.push(...reply('c11', second, KAN.author, KAN.id).replies)
  return { ...h, ...t }
}

test('an unclear owner reply on one poll and a none reply on the next: both texts reach the feedback, oldest first', async () => {
  const h = await twoPolls('ผมงงครับ asdf', 'ไม่เอาสักแบบ ทับเว็บเลย')
  await h.engine.checkReplies()
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: none\n')
  expect(await pickFile(h.store.get(h.id)!)).toContain('> ผมงงครับ asdf\n>\n> ทับเว็บเลย\n')
  expect(await pickFile(h.store.get(h.id)!)).not.toContain('someone else')
  expect(h.reads.at(-1)).toBe('c1')
})

test('an unclear owner reply then a keep reply: the keep note holds both texts', async () => {
  const h = await twoPolls('แก้ยังไงดี', 'เหมือน NOW เลย แก้บั๊กอย่างเดียว')
  await h.engine.checkReplies()
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: keep\nTester: (not set)\nNote: แก้ยังไงดี เหมือน NOW เลย แก้บั๊กอย่างเดียว\n')
})

test('an unclear owner reply then a letter reply: the pick note holds the earlier text and the lines after the letter', async () => {
  const h = await twoPolls('ขอดูอีกที', 'C ครับ\nปุ่มใหญ่ขึ้นหน่อย')
  await h.engine.checkReplies()
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: C\nTester: (not set)\nNote: ขอดูอีกที ปุ่มใหญ่ขึ้นหน่อย\n')
})

test('when the extra read fails the pick still goes through with the deciding reply only', async () => {
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  const h = await twoPolls('ผมงงครับ asdf', 'ไม่เอาสักแบบ ทับเว็บเลย')
  h.failEarlierRead()
  await h.engine.checkReplies()
  quiet.mockRestore()
  expect(await pickFile(h.store.get(h.id)!)).toContain('Note: (none)\n\n## Feedback on all variants\n> ทับเว็บเลย\n')
})

const withoutSince = async (h: Awaited<ReturnType<typeof parked>>, postedAt: number) => {
  const { since: _since, ...older } = h.store.get(h.id)!.pick!.ask!
  await h.store.update(h.id, { pick: { ...h.store.get(h.id)!.pick!, ask: { ...older, postedAt } } })
}

test('the stuck card: an unclear reply needs you, reread reads again from the ask, and pick none --feedback finishes it', async () => {
  const h = await parked({ deps: { now: () => 5_000_000 } })
  await withoutSince(h, 5_000_000)
  h.replies.set('1', async () => h.from(KAN, 'c9', 'ผมงงครับ asdf'))
  await h.engine.checkReplies()
  expect(h.store.get(h.id)).toMatchObject({ state: 'waiting-pick', lastSeenId: 'c9' })
  const unclear = h.needs.filter(need => need.reason.startsWith('ClickUp reply not understood'))
  expect(unclear).toHaveLength(1)
  expect(unclear[0]).toMatchObject({ reason: 'ClickUp reply not understood: "ผมงงครับ asdf"', options: { webhook: false } })
  expect(h.notices).toEqual([{ event: 'pick-unclear', replyId: 'c9', text: 'ผมงงครับ asdf', by: 'Kan' }])

  const reread = await h.engine.reread(h.id)
  expect(h.sinceIds.at(-1)).toBe('4940000')
  expect(reread.state).toBe('waiting-pick')

  await h.engine.pick(h.id, { option: 'none', feedback: 'overlay, not push' })
  const rebuilt = h.store.get(h.id)!
  expect(await pickFile(rebuilt)).toContain('Option: none\n')
  expect(await pickFile(rebuilt)).toContain('> overlay, not push')
  expect(h.posted.filter(post => post.kind === 'update')).toEqual([{ id: '1', kind: 'update', lines: ['ได้ครับ จะทำแบบใหม่ตามนี้ครับ'] }])
  expect(h.resolved).toEqual([{ id: '1', ref: 'ref-1' }])
})

test('one unclear reply yields one attention entry and exactly one webhook event, the pick-unclear one', async () => {
  const events: NotifyInput[] = []
  const attention = createAttentionStore(join(dir, 'attention.json'))
  let h: Awaited<ReturnType<typeof parked>>
  const notifyOn = createNotifyEvents({ notifier: { emit: async input => { events.push(input); return [] } }, items: () => h.store.list(), run: () => undefined })
  h = await parked({ deps: { needsYou: queueNeedsYou(attention, notifyOn.queue), notify: (item, event) => notifyOn.pickReply(item, event) } })
  await Bun.sleep(20)
  expect(events.map(event => event.event)).toEqual(['pick'])
  events.length = 0
  h.replies.set('1', async () => h.from(KAN, 'c9', 'asdf'))
  await h.engine.checkReplies()
  await Bun.sleep(20)
  expect(events.map(event => event.event)).toEqual(['pick-unclear'])
  expect(attention.list().filter(alert => alert.kind === 'queue')).toEqual([expect.objectContaining({ key: `queue:${h.id}`, detail: 'ClickUp reply not understood: "asdf"' })])
})

test('an unclear reply with several lines or a very long first line is cut to its first line, 200 characters', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(KAN, 'c9', `\n${'ก'.repeat(300)}?\nsecond line`))
  await h.engine.checkReplies()
  expect(h.needs.at(-1)!.reason).toBe(`ClickUp reply not understood: "${'ก'.repeat(200)}"`)
})

test('an unclear reply followed by a clear one in the same batch picks and raises no not-understood alert', async () => {
  const h = await parked()
  h.replies.set('1', async () => ({ replies: [...h.from(KAN, 'c6', 'asdf').replies, ...h.from(KAN, 'c7', 'C').replies], lastId: 'c7' }))
  await h.engine.checkReplies()
  expect(h.needs.some(need => need.reason.startsWith('ClickUp reply not understood'))).toBe(false)
})

const batch = (h: Awaited<ReturnType<typeof parked>>, ...texts: string[]) => h.replies.set('1', async () => ({
  replies: texts.flatMap((text, index) => h.from(KAN, `c${5 + index}`, text).replies),
  lastId: `c${4 + texts.length}`,
}))

test('the owner\'s latest word wins: a later A beats an earlier none, with no alert', async () => {
  const h = await parked()
  batch(h, 'ไม่เอาเลย ขอใหม่', 'A')
  await h.engine.checkReplies()
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: A\n')
  expect(h.needs.some(need => need.reason.startsWith('ClickUp reply not understood'))).toBe(false)
})

test('a clear reply older than an unclear one still picks, announces only the newer one, and raises no alert', async () => {
  const h = await parked()
  batch(h, 'A', 'asdf')
  await h.engine.checkReplies()
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: A\n')
  expect(h.notices.map(notice => notice.event)).toEqual(['pick-unclear', 'picked'])
  expect(h.notices[0]).toMatchObject({ replyId: 'c6' })
  expect(h.needs.some(need => need.reason.startsWith('ClickUp reply not understood'))).toBe(false)
})

test('only unclear replies newer than the decisive one are announced', async () => {
  const h = await parked()
  batch(h, 'asdf', 'B')
  await h.engine.checkReplies()
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: B\n')
  expect(h.notices.map(notice => notice.event)).toEqual(['picked'])
})

test('reread twice with one non-owner reply keeps the context once', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(MAC, 'c9', 'ผมว่า A'))
  await h.engine.checkReplies()
  const kept = h.store.get(h.id)!.answerPaths
  await h.engine.reread(h.id)
  await h.engine.reread(h.id)
  expect(h.store.get(h.id)!.answerPaths).toEqual(kept)
  expect(h.store.get(h.id)!.state).toBe('waiting-pick')
})

test('a failed read in reread leaves lastSeenId alone and surfaces a SourceFailure', async () => {
  let fail = false
  const h = await parked({ source: { replies: async () => { if (fail) throw new Error('ClickUp is down'); return noReplies } } })
  fail = true
  const error = await refusal(h.engine.reread(h.id))
  expect(error).toBeInstanceOf(SourceFailure)
  expect(h.store.get(h.id)!.lastSeenId).toBe('c1')
})

test('reread of the real stuck reply goes straight to a rebuild with its feedback and closes the ask', async () => {
  const h = await parked({ deps: { now: () => 5_000_000 } })
  await withoutSince(h, 5_000_000)
  h.replies.set('1', async () => h.from(KAN, 'c9', 'ไม่เอาซักช้อยส์เลย มันควรแสดงผลทับเว็บไปเลย ไม่ใช่ดันออกมา'))
  await h.engine.reread(h.id)
  expect(h.sinceIds.at(-1)).toBe('4940000')
  const rebuilt = h.store.get(h.id)!
  expect(await pickFile(rebuilt)).toContain('Option: none\n')
  expect(await pickFile(rebuilt)).toContain('> มันควรแสดงผลทับเว็บไปเลย ไม่ใช่ดันออกมา')
  expect(h.posted.filter(post => post.kind === 'update')).toEqual([{ id: '1', kind: 'update', lines: ['ได้ครับ จะทำแบบใหม่ตามนี้ครับ'] }])
  expect(h.resolved).toEqual([{ id: '1', ref: 'ref-1' }])
})

const ACK = '✅ รับทราบครับ'
const acks = (h: { replied: Array<{ lines: string[] }> }) => h.replied.filter(sent => sent.lines[0] === ACK)

test('the owner reply is acknowledged once in the ask thread, before the pick is acted on', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(KAN, 'c9', 'แบบ C'))
  await h.engine.checkReplies()
  expect(h.replied).toEqual([{ id: '1', ref: 'ref-1', lines: [ACK] }])
})

test('replies from other people are acknowledged too', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(PALM, 'c8', 'ขอดูก่อนนะ'))
  await h.engine.checkReplies()
  expect(acks(h)).toHaveLength(1)
  expect(h.store.get(h.id)!.pick!.ask!.acked).toEqual(['c8'])
})

test('a reply is never acknowledged twice, not by the next poll and not by reread', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(KAN, 'c9', 'ขอคิดก่อนครับ'))
  await h.engine.checkReplies()
  await h.engine.checkReplies()
  await h.engine.reread(h.id)
  expect(acks(h)).toHaveLength(1)
  expect(h.store.get(h.id)!.pick!.ask!.acked).toEqual(['c9'])
})

test('a failed acknowledgement is logged and never blocks the pick', async () => {
  const h = await parked({ source: { reply: async () => { throw new Error('ClickUp is down') } } })
  const logged = console.error
  console.error = () => {}
  h.replies.set('1', async () => h.from(KAN, 'c9', 'แบบ C'))
  try {
    await h.engine.checkReplies()
  } finally {
    console.error = logged
  }
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: C\n')
})

test('the acknowledged ids are kept per ask and capped at the newest 50', async () => {
  const h = await parked()
  const many = Array.from({ length: 60 }, (_, index) => ({ id: `c${100 + index}`, author: 'Palm', authorId: '99x', text: 'hi', images: [] }))
  h.replies.set('1', async () => ({ replies: many, lastId: 'c159' }))
  await h.engine.checkReplies()
  const acked = h.store.get(h.id)!.pick!.ask!.acked!
  expect(acked).toHaveLength(50)
  expect(acked.at(-1)).toBe('c159')
})

test('repost resolves the old ask, publishes again and posts a fresh ask with a new cursor and no acknowledgements', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(PALM, 'c8', 'ขอดูก่อนนะ'))
  await h.engine.checkReplies()
  expect(h.store.get(h.id)!.pick!.ask!.acked).toEqual(['c8'])
  const item = await h.engine.repost(h.id)
  expect(h.resolved).toEqual([{ id: '1', ref: 'ref-1' }])
  expect(h.published).toHaveLength(2)
  expect(asks(h)).toHaveLength(2)
  expect(item.pick!.ask).toMatchObject({ ref: 'ref-2', since: 'c2', ownerName: 'Kan' })
  expect(item.pick!.ask!.acked).toBeUndefined()
  expect(item.lastSeenId).toBe('c2')
})

test('repost asks a waiting pick that was never asked, even when the pick is kept in Shikidan', async () => {
  const h = await parked({ deps: { pickIn: async () => 'shikidan' } })
  expect(asks(h)).toEqual([])
  const item = await h.engine.repost(h.id)
  expect(asks(h)).toHaveLength(1)
  expect(item.pick!.ask).toMatchObject({ ref: 'ref-1' })
  expect(h.resolved).toEqual([])
})

test('repost refuses an item that is not waiting on a pick, and an unknown id', async () => {
  const h = await parked()
  const idle = await h.engine.add({ ...add, externalId: '2' })
  expect(await refusalOf(h.engine.repost(idle.id))).toEqual([409, 'It is not waiting on a pick'])
  expect(await refusalOf(h.engine.repost('nope'))).toEqual([404, 'No queue item nope'])
})

test('repost reports a failed publish or post as a SourceFailure and leaves the error on the ask', async () => {
  const h = await parked()
  h.deps.publish = async () => { throw new Error('Publishing is down') }
  const error = await refusal(h.engine.repost(h.id))
  expect(error).toBeInstanceOf(SourceFailure)
  expect((error as Error).message).toBe('Publishing is down')
  expect(h.store.get(h.id)!.pick!.ask).toMatchObject({ ref: '', error: 'Publishing is down' })
})

const FREE_TEXT = 'มันควรแสดงผลทับเว็บไปเลย ไม่ใช่ดันออกมา'

test('a free-text reply from the card owner is a rejection that carries the text as feedback', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(KAN, 'c9', FREE_TEXT))
  await h.engine.checkReplies()
  const file = await pickFile(h.store.get(h.id)!)
  expect(file).toContain('Option: none\n')
  expect(file).toContain(`> ${FREE_TEXT}`)
  expect(h.notices.map(notice => notice.event)).toEqual(['picked'])
})

test('the same free text from the bot account is not a rejection while the owner is someone else', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(PALM, 'c9', FREE_TEXT))
  await h.engine.checkReplies()
  expect(h.store.get(h.id)!.state).toBe('waiting-pick')
  expect(h.notices.map(notice => notice.event)).toEqual(['pick-unclear'])
})

const CLARIFY = [
  'ขอโทษครับ ยังไม่แน่ใจว่าเลือกแบบไหน รบกวนตอบใหม่อีกครั้งครับ',
  '- ตอบเป็นตัวอักษร: A / B / C',
  '- หรือ "ไม่เอาสักแบบ" ตามด้วยสิ่งที่อยากได้',
  '- หรือ "เหมือน NOW" ถ้าไม่ต้องปรับ UI แก้บั๊กอย่างเดียว',
]
const clarifications = (h: { replied: Array<{ lines: string[] }> }) => h.replied.filter(sent => sent.lines[0] === CLARIFY[0])
const notUnderstood = (h: { needs: Array<{ reason: string }> }) => h.needs.filter(need => need.reason.startsWith('ClickUp reply not understood'))

test('a gibberish owner reply is acknowledged, then answered once with the choices, and is never silent', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(KAN, 'c9', 'asdf'))
  await h.engine.checkReplies()
  expect(h.replied).toEqual([{ id: '1', ref: 'ref-1', lines: [ACK] }, { id: '1', ref: 'ref-1', lines: CLARIFY }])
  expect(h.store.get(h.id)!.pick!.ask!.clarified).toEqual(['c9'])
  expect(h.store.get(h.id)).toMatchObject({ state: 'waiting-pick', lastSeenId: 'c9' })
  expect(notUnderstood(h)).toHaveLength(1)
})

test('reading the same unclear reply again asks nothing more and notifies nobody again', async () => {
  const h = await parked()
  h.replies.set('1', async () => h.from(KAN, 'c9', 'asdf'))
  await h.engine.checkReplies()
  await h.engine.reread(h.id)
  await h.engine.reread(h.id)
  expect(clarifications(h)).toHaveLength(1)
  expect(notUnderstood(h)).toHaveLength(1)
  expect(h.notices.map(notice => notice.event)).toEqual(['pick-unclear'])
})

test('several unclear replies in one batch get one clarifying reply, and all of them are marked', async () => {
  const h = await parked()
  h.replies.set('1', async () => ({ replies: [...h.from(KAN, 'c6', 'asdf').replies, ...h.from(KAN, 'c7', 'qwer').replies], lastId: 'c7' }))
  await h.engine.checkReplies()
  expect(clarifications(h)).toHaveLength(1)
  expect(h.store.get(h.id)!.pick!.ask!.clarified).toEqual(['c6', 'c7'])
})

test('when the clarifying reply cannot be posted the cursor stays before the unclear reply, the alert is raised, and the next read retries', async () => {
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  let failing = true
  const sent: string[][] = []
  const h = await parked({ source: { reply: async input => { if (failing && input.lines[0] === CLARIFY[0]) throw new Error('ClickUp is down'); sent.push(input.lines); return { commentId: 'r' } } } })
  h.replies.set('1', async () => ({ replies: [...h.from(MAC, 'c8', 'ผมว่า A').replies, ...h.from(KAN, 'c9', 'asdf').replies, ...h.from(MAC, 'c10', 'ok').replies], lastId: 'c10' }))
  await h.engine.checkReplies()
  expect(h.store.get(h.id)!.lastSeenId).toBe('c8')
  expect(h.store.get(h.id)!.pick!.ask!.clarified).toBeUndefined()
  expect(notUnderstood(h)).toHaveLength(1)
  failing = false
  await h.engine.checkReplies()
  quiet.mockRestore()
  expect(sent.filter(lines => lines[0] === CLARIFY[0])).toEqual([CLARIFY])
  expect(h.store.get(h.id)).toMatchObject({ lastSeenId: 'c10' })
  expect(h.store.get(h.id)!.pick!.ask!.clarified).toEqual(['c9'])
})

test('a failed clarifying reply for the first reply of the batch leaves the cursor where it was', async () => {
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  const h = await parked({ source: { reply: async input => { if (input.lines[0] === CLARIFY[0]) throw new Error('ClickUp is down'); return { commentId: 'r' } } } })
  h.replies.set('1', async () => h.from(KAN, 'c9', 'asdf'))
  await h.engine.checkReplies()
  quiet.mockRestore()
  expect(h.store.get(h.id)!.lastSeenId).toBe('c1')
})

test('a decided pick sends no clarifying reply, even with an older unclear reply in the batch', async () => {
  const h = await parked()
  batch(h, 'asdf', 'B')
  await h.engine.checkReplies()
  expect(clarifications(h)).toHaveLength(0)
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: B\n')
})
