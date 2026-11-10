import type { PickChoice, QueueEngineDeps } from './queue-engine'
import { parsePickReply, pickOwner, type CardPeople, type Person, type PickReply } from './queue-pick-reply'
import { message as template, messageLines } from './messages'
import { cleanPickSummary, KEEP_PICK, NO_PICK } from './queue-prompts'
import { message } from './queue-replies'
import type { QueueSource, SourceReplies, SourceReply } from './queue-source'
import type { PickAsk, QueueItem, QueuePick } from './queue-store'

export type PickIn = 'clickup' | 'shikidan'
export type PickReplyEvent = { event: 'picked'; replyId: string; option: string; by: string } | { event: 'pick-unclear'; replyId: string; text: string; by: string }

const ASK_LOOKBACK_MS = 60_000
export const askCursor = (ask: PickAsk): string => ask.since ?? String(ask.postedAt - ASK_LOOKBACK_MS)
const MAX_REASON_LINE = 200
const firstLineOf = (text: string): string => (text.split('\n').find(line => line.trim() !== '') ?? '').trim().slice(0, MAX_REASON_LINE)
const MAX_ACKED = 50
const OPTIONS_HEADING = /^##\s+options\s*:?\s*$/i
const HEADING = /^##\s/
const BULLET = /^\s*[-*]\s+(.*)$/

function optionsSection(summary: string): string[] {
  const lines = summary.split('\n')
  const start = lines.findIndex(line => OPTIONS_HEADING.test(line))
  if (start === -1) return []
  const end = lines.findIndex((line, index) => index > start && HEADING.test(line))
  return lines.slice(start + 1, end === -1 ? undefined : end)
}

function optionLine(section: readonly string[], option: string): string {
  for (const line of section) {
    const [id = '', subtitle = '', ...rest] = (BULLET.exec(line)?.[1] ?? '').replace(/\*\*/g, '').split('|').map(part => part.trim())
    if (id.toLowerCase() !== option.toLowerCase()) continue
    const description = rest.join(' | ').trim()
    const named = [option, subtitle].filter(part => part !== '').join(' ')
    return description === '' ? named : `${named} — ${description}`
  }
  return option
}

export function optionLines(pick: QueuePick): string[] {
  const section = optionsSection(cleanPickSummary(pick.summary))
  return pick.options.map(option => {
    const text = optionLine(section, option)
    return option === pick.recommended ? `${text}${template('recommended')}` : text
  })
}

export const askLines = (pick: QueuePick, host: string): string[] => [...messageLines('ask-header', { host }), ...optionLines(pick)]

type Decisive = Exclude<PickReply, { kind: 'unclear' }>

function choiceFromThread(decided: { reply: SourceReply; verdict: Decisive }, thread: readonly SourceReply[]): PickChoice {
  const own = decided.verdict.kind === 'none' ? decided.verdict.feedback : decided.verdict.note
  const ordered = thread.some(reply => reply.id === decided.reply.id) ? thread : [...thread, decided.reply]
  const text = ordered.map(reply => (reply.id === decided.reply.id ? own : reply.text.trim())).filter(part => part !== '').join('\n\n')
  return decided.verdict.kind === 'none' ? { option: NO_PICK, feedback: text } : { option: decided.verdict.kind === 'keep' ? KEEP_PICK : decided.verdict.option, note: text }
}

const confirmation = (choice: PickChoice): string[] => {
  if (choice.option === NO_PICK) return messageLines('confirm-none')
  return choice.option === KEEP_PICK ? messageLines('confirm-keep') : messageLines('confirm-pick', { option: choice.option })
}

export type PickAsker = {
  asksInSource(item: QueueItem, plugin?: string): Promise<boolean>
  ask(item: QueueItem): Promise<void>
  askUnasked(): Promise<void>
  close(item: QueueItem, choice?: PickChoice): Promise<void>
  apply(item: QueueItem, worktree: string, result: SourceReplies, options?: { keepOthers?: boolean }): Promise<boolean>
}

export type PickAskerSteps = {
  pickNow(id: string, choice: PickChoice): Promise<void>
  keep(item: QueueItem, worktree: string, replies: SourceReply[]): Promise<void>
}

function heldCursor(item: QueueItem, replies: readonly SourceReply[], firstUnclear: SourceReply): string | null {
  const at = replies.findIndex(reply => reply.id === firstUnclear.id)
  return at > 0 ? replies[at - 1]!.id : item.lastSeenId
}

export const POSSIBLY_POSTED = 'The ClickUp question may have been posted before a restart; check the card'
const isOpen = (ask: PickAsk | undefined): boolean => ask !== undefined && ask.ref !== '' && ask.error === undefined
const wasCutOff = (ask: PickAsk | undefined): ask is PickAsk => ask?.posting === true && ask.ref === '' && ask.error === undefined
const failedReason = (error: string): string => `Pick in Shikidan, the ClickUp ask failed: ${error}`

export const isAsked = (item: QueueItem): boolean => item.state === 'waiting-pick' && isOpen(item.pick?.ask)

const judgedBy = (asked: PickAsk) => (reply: SourceReply): boolean => reply.authorId !== '' && (reply.authorId === asked.ownerId || reply.authorId === asked.meId)

export async function ownerReplies(source: Pick<QueueSource, 'replies'>, item: QueueItem): Promise<SourceReply[]> {
  const asked = item.pick!.ask!
  const { replies } = await source.replies({ id: item.externalId, sinceId: askCursor(asked) })
  return replies.filter(judgedBy(asked)).filter((reply, at, all) => all.findIndex(other => other.id === reply.id) === at)
}

export function pickAsker(deps: QueueEngineDeps, steps: PickAskerSteps): PickAsker {
  const { store } = deps
  const now = deps.now ?? Date.now

  async function asksInSource(item: QueueItem, plugin = deps.runner.get(item.runIds.at(-1) ?? '')?.workflow?.plugin): Promise<boolean> {
    return deps.pickIn !== undefined && await deps.pickIn(plugin) === 'clickup'
  }

  async function askedOwner(people: CardPeople): Promise<Person> {
    const id = await deps.pickAskTo?.() ?? null
    if (id === null) return pickOwner(people)
    const known = [people.creator, ...people.assignees, people.me].find(person => person?.id === id)
    return { id, username: known?.username ?? '' }
  }

  async function posted(item: QueueItem): Promise<{ ask: PickAsk; lastSeenId: string | null }> {
    let host: string | null = null
    try {
      if (deps.publish === undefined) throw new Error('Publishing is not set up')
      const published = await deps.publish(item)
      host = published.host
      await store.update(item.id, { published })
      const source = deps.source(item.source)
      const people = await source.people({ id: item.externalId })
      const owner = await askedOwner(people)
      const draft: PickAsk = { ref: '', ownerId: owner.id, ownerName: owner.username, meId: people.me.id, host, postedAt: now() }
      await store.update(item.id, { pick: { ...item.pick!, ask: { ...draft, posting: true } } })
      const post = await source.post({ id: item.externalId, kind: 'ask', lines: askLines(item.pick!, host), mention: owner.id, assignee: owner.id })
      if (post.ref === undefined) throw new Error(`${item.source} did not say which comment it posted`)
      return { ask: { ...draft, ref: post.ref, postedAt: now(), since: post.commentId }, lastSeenId: post.commentId }
    } catch (error) {
      return { ask: { ref: '', ownerId: '', ownerName: '', meId: '', host, postedAt: now(), error: message(error) }, lastSeenId: item.lastSeenId }
    }
  }

  async function ask(item: QueueItem): Promise<void> {
    const { ask, lastSeenId } = await posted(item)
    const asked = await store.update(item.id, { pick: { ...item.pick!, ask }, lastSeenId })
    deps.needsYou(asked, ask.error === undefined ? 'Pick a design variant' : failedReason(ask.error))
  }

  async function giveUp(item: QueueItem, cutOff: PickAsk): Promise<void> {
    const { posting: _posting, ...ask } = cutOff
    const failed = await store.update(item.id, { pick: { ...item.pick!, ask: { ...ask, error: POSSIBLY_POSTED } } })
    deps.needsYou(failed, failedReason(POSSIBLY_POSTED))
  }

  async function askUnasked(): Promise<void> {
    for (const item of store.list()) {
      if (item.state !== 'waiting-pick' || item.pick === undefined) continue
      if (wasCutOff(item.pick.ask)) await giveUp(item, item.pick.ask)
      else if (item.pick.ask === undefined && await asksInSource(item)) await ask(item)
    }
  }

  async function close(item: QueueItem, choice?: PickChoice): Promise<void> {
    if (!isAsked(item)) return
    const logged = (what: string) => (error: unknown): void => console.error(`Queue item ${item.id} ${what}`, error)
    try {
      const source = deps.source(item.source)
      if (choice !== undefined) await source.post({ id: item.externalId, kind: 'update', lines: confirmation(choice) }).catch(logged('pick confirmation not posted'))
      await source.resolve({ id: item.externalId, ref: item.pick!.ask!.ref }).catch(logged('pick ask not resolved'))
    } catch (error) {
      logged('pick ask not closed')(error)
    }
  }

  async function acknowledge(item: QueueItem, replies: readonly SourceReply[]): Promise<void> {
    const asked = item.pick!.ask!
    const acked = new Set(asked.acked ?? [])
    const fresh = replies.filter(reply => !acked.has(reply.id))
    if (fresh.length === 0) return
    const source = deps.source(item.source)
    for (const reply of fresh) {
      try {
        await source.reply({ id: item.externalId, ref: asked.ref, lines: messageLines('ack') })
        acked.add(reply.id)
      } catch (error) {
        console.error(`Queue item ${item.id} acknowledgement of reply ${reply.id} not posted`, error)
      }
    }
    if (acked.size === (asked.acked ?? []).length) return
    const current = store.get(item.id)
    if (current?.pick?.ask === undefined) return
    await store.update(item.id, { pick: { ...current.pick, ask: { ...current.pick.ask, acked: [...acked].slice(-MAX_ACKED) } } })
      .catch(error => console.error(`Queue item ${item.id} acknowledgements not saved`, error))
  }

  async function clarify(item: QueueItem, replies: readonly SourceReply[]): Promise<boolean> {
    const asked = item.pick!.ask!
    try {
      await deps.source(item.source).reply({ id: item.externalId, ref: asked.ref, lines: messageLines('clarify', { options: item.pick!.options.join(' / ') }) })
    } catch (error) {
      console.error(`Queue item ${item.id} clarifying reply not posted`, error)
      return false
    }
    const current = store.get(item.id)
    if (current?.pick?.ask === undefined) return true
    const clarified = [...(current.pick.ask.clarified ?? []), ...replies.map(reply => reply.id)].slice(-MAX_ACKED)
    await store.update(item.id, { pick: { ...current.pick, ask: { ...current.pick.ask, clarified } } })
      .catch(error => console.error(`Queue item ${item.id} clarified replies not saved`, error))
    return true
  }

  async function ownerThread(item: QueueItem): Promise<SourceReply[] | null> {
    try {
      return await ownerReplies(deps.source(item.source), item)
    } catch (error) {
      console.error(`Queue item ${item.id} earlier replies not read, using the deciding reply only`, error)
      return null
    }
  }

  async function apply(item: QueueItem, worktree: string, result: SourceReplies, { keepOthers = true }: { keepOthers?: boolean } = {}): Promise<boolean> {
    const asked = item.pick!.ask!
    await acknowledge(item, result.replies)
    const judged = judgedBy(asked)
    const others = result.replies.filter(reply => !judged(reply))
    if (keepOthers && others.length > 0) await steps.keep(item, worktree, others).catch(error => console.error(`Queue item ${item.id} replies not saved`, error))
    const extraNone = await deps.pickNonePhrases?.() ?? []
    const extraKeep = await deps.pickKeepPhrases?.() ?? []
    let decided: { reply: SourceReply; verdict: Decisive } | undefined
    const unclear: SourceReply[] = []
    for (const reply of result.replies.filter(judged).reverse()) {
      const verdict = parsePickReply(reply.text, item.pick!.options, extraNone, extraKeep, { freeText: reply.authorId === asked.ownerId })
      if (verdict.kind !== 'unclear') { decided = { reply, verdict }; break }
      unclear.unshift(reply)
    }
    const pending = unclear.filter(reply => !(asked.clarified ?? []).includes(reply.id))
    for (const reply of pending) deps.notify?.(item, { event: 'pick-unclear', replyId: reply.id, text: reply.text, by: reply.author })
    const clarified = decided !== undefined || pending.length === 0 || await clarify(item, pending)
    const cursor = clarified ? result.lastId : heldCursor(item, result.replies, pending[0]!)
    if (cursor !== null) await store.update(item.id, { lastSeenId: cursor })
    if (decided === undefined) {
      const latest = pending.at(-1)
      if (latest === undefined) return false
      deps.needsYou(store.get(item.id) ?? item, `ClickUp reply not understood: "${firstLineOf(latest.text)}"`, { webhook: false })
      deps.diagnose?.(store.get(item.id) ?? item)
      return false
    }
    const choice = choiceFromThread(decided, await ownerThread(item) ?? [decided.reply])
    try {
      await steps.pickNow(item.id, choice)
    } catch (error) {
      deps.needsYou(store.get(item.id) ?? item, `Could not use the ClickUp reply "${decided.reply.text}": ${message(error)}`)
      return false
    }
    await close(item, choice)
    deps.notify?.(store.get(item.id) ?? item, { event: 'picked', replyId: decided.reply.id, option: choice.option, by: decided.reply.author })
    return true
  }

  return { asksInSource, ask, askUnasked, close, apply }
}
