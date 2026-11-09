import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { QueueEngineDeps } from '../server/queue-engine'
import { askLines, type PickReplyEvent } from '../server/queue-pick-ask'
import type { QueueSource, SourceReplies } from '../server/queue-source'
import type { QueueItem } from '../server/queue-store'
import { add, blockedWith, noReplies, queueHarness, reply } from './support/queue-harness'

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
  const needs: Array<{ item: QueueItem; reason: string }> = []
  const replies = new Map<string, () => Promise<SourceReplies>>()
  let comments = 0
  const h = queueHarness(dir, {
    pickIn: async () => 'clickup',
    publish: async item => { published.push(item.published); return { sub: '1-ab12cd34', host: HOST, at: 7 } },
    notify: (_item, event) => { notices.push(event) },
    needsYou: (item, reason) => { needs.push({ item, reason }) },
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
  expect(item.pick!.ask).toEqual({ ref: 'ref-1', ownerId: '11', ownerName: 'Kan', meId: '99', host: HOST, postedAt: expect.any(Number) })
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

test('in one batch, other people are kept, an unclear owner reply is reported, and the first clear one picks', async () => {
  const h = await parked()
  h.replies.set('1', async () => ({
    replies: [...h.from(MAC, 'c5', 'ผมว่า A').replies, ...h.from(KAN, 'c6', 'A หรือ C ดี').replies, ...h.from(KAN, 'c7', 'C').replies, ...h.from(KAN, 'c8', 'B').replies],
    lastId: 'c8',
  }))
  await h.engine.checkReplies()
  expect(await pickFile(h.store.get(h.id)!)).toContain('Option: C\n')
  expect(h.notices.map(notice => notice.event)).toEqual(['pick-unclear', 'picked'])
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
