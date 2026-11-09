import type { PickChoice, QueueEngineDeps } from './queue-engine'
import { parsePickReply, pickOwner, type PickReply } from './queue-pick-reply'
import { cleanPickSummary, NO_PICK } from './queue-prompts'
import { message } from './queue-replies'
import type { SourceReplies, SourceReply } from './queue-source'
import type { PickAsk, QueueItem, QueuePick } from './queue-store'

export type PickIn = 'clickup' | 'shikidan'
export type PickReplyEvent = { event: 'picked'; replyId: string; option: string; by: string } | { event: 'pick-unclear'; replyId: string; text: string; by: string }

const RECOMMENDED = ' (แนะนำ)'
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

export function askLines(pick: QueuePick, host: string): string[] {
  const section = optionsSection(cleanPickSummary(pick.summary))
  const options = pick.options.map(option => {
    const text = optionLine(section, option)
    return option === pick.recommended ? `${text}${RECOMMENDED}` : text
  })
  return [`รบกวนช่วยเลือกหน่อยครับว่าจะให้เป็นแบบไหนครับ https://${host}`, ...options]
}

const choiceOf = (verdict: Exclude<PickReply, { kind: 'unclear' }>): PickChoice =>
  verdict.kind === 'pick' ? { option: verdict.option, note: verdict.note } : { option: NO_PICK, feedback: verdict.feedback }

const confirmation = (choice: PickChoice): string => (choice.option === NO_PICK ? 'ได้ครับ จะทำแบบใหม่ตามนี้ครับ' : `ได้ครับ ใช้แบบ ${choice.option}`)

export type PickAsker = {
  asksInSource(item: QueueItem, plugin?: string): Promise<boolean>
  ask(item: QueueItem): Promise<void>
  askUnasked(): Promise<void>
  close(item: QueueItem, choice?: PickChoice): Promise<void>
  apply(item: QueueItem, worktree: string, result: SourceReplies): Promise<boolean>
}

export type PickAskerSteps = {
  pickNow(id: string, choice: PickChoice): Promise<void>
  keep(item: QueueItem, worktree: string, replies: SourceReply[]): Promise<void>
}

export const POSSIBLY_POSTED = 'The ClickUp question may have been posted before a restart; check the card'
const isOpen = (ask: PickAsk | undefined): boolean => ask !== undefined && ask.ref !== '' && ask.error === undefined
const wasCutOff = (ask: PickAsk | undefined): ask is PickAsk => ask?.posting === true && ask.ref === '' && ask.error === undefined
const failedReason = (error: string): string => `Pick in Shikidan, the ClickUp ask failed: ${error}`

export const isAsked = (item: QueueItem): boolean => item.state === 'waiting-pick' && isOpen(item.pick?.ask)

export function pickAsker(deps: QueueEngineDeps, steps: PickAskerSteps): PickAsker {
  const { store } = deps
  const now = deps.now ?? Date.now

  async function asksInSource(item: QueueItem, plugin = deps.runner.get(item.runIds.at(-1) ?? '')?.workflow?.plugin): Promise<boolean> {
    return deps.pickIn !== undefined && await deps.pickIn(plugin) === 'clickup'
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
      const owner = pickOwner(people)
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
      if (choice !== undefined) await source.post({ id: item.externalId, kind: 'update', lines: [confirmation(choice)] }).catch(logged('pick confirmation not posted'))
      await source.resolve({ id: item.externalId, ref: item.pick!.ask!.ref }).catch(logged('pick ask not resolved'))
    } catch (error) {
      logged('pick ask not closed')(error)
    }
  }

  async function apply(item: QueueItem, worktree: string, result: SourceReplies): Promise<boolean> {
    const asked = item.pick!.ask!
    const judged = (reply: SourceReply): boolean => reply.authorId !== '' && (reply.authorId === asked.ownerId || reply.authorId === asked.meId)
    const others = result.replies.filter(reply => !judged(reply))
    if (others.length > 0) await steps.keep(item, worktree, others).catch(error => console.error(`Queue item ${item.id} replies not saved`, error))
    let decided: { reply: SourceReply; choice: PickChoice } | undefined
    for (const reply of result.replies.filter(judged)) {
      const verdict = parsePickReply(reply.text, item.pick!.options)
      if (verdict.kind !== 'unclear') { decided = { reply, choice: choiceOf(verdict) }; break }
      deps.notify?.(item, { event: 'pick-unclear', replyId: reply.id, text: reply.text, by: reply.author })
    }
    if (result.lastId !== null) await store.update(item.id, { lastSeenId: result.lastId })
    if (decided === undefined) return false
    try {
      await steps.pickNow(item.id, decided.choice)
    } catch (error) {
      deps.needsYou(store.get(item.id) ?? item, `Could not use the ClickUp reply "${decided.reply.text}": ${message(error)}`)
      return false
    }
    await close(item, decided.choice)
    deps.notify?.(store.get(item.id) ?? item, { event: 'picked', replyId: decided.reply.id, option: decided.choice.option, by: decided.reply.author })
    return true
  }

  return { asksInSource, ask, askUnasked, close, apply }
}
