import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

import { logSecrets, redactAll } from './log-redaction'
import type { QueueEngine } from './queue-engine'
import { normalPickOption, NO_PICK } from './queue-prompts'
import { QueueRefusal } from './queue-refusal'
import type { ActionKey, CardLease, QueueItem, QueueState, QueueStore } from './queue-store'
import { configDir, readConfig } from './secrets'
import { QUEUE_STATES } from './workflows'

export type Actor = string
export const ACTION_NAMES = ['show', 'note', 'resume', 'repost', 'say', 'pick', 'requeue', 'reread', 'answer', 'stop'] as const
export type ActionName = typeof ACTION_NAMES[number]

export type ActionTraits = { readOnly: boolean; destructive: boolean; openWorld: boolean; doctor: boolean }
export type ActionMeta = { actor: Actor; why: string; key?: string; expect?: QueueState }
export type CardSnapshot = { state: QueueState; node: string | null }

export type AuditLine = {
  at: number; cardId: string; actor: Actor; action: ActionName | 'claim' | 'release' | 'limits-reset'; why: string
  params: unknown
  before: CardSnapshot
  after: CardSnapshot | null
  result: 'ok' | 'refused' | 'failed' | 'replayed'; error?: string; key?: string; prev: string
}

export type CardLimits = Record<Exclude<ActionName, 'show'>, number>
export const DEFAULT_CARD_LIMITS: CardLimits = { note: 10, resume: 3, repost: 2, say: 5, pick: 3, requeue: 3, reread: 5, answer: 5, stop: 3 }
export const HUMAN: Actor = 'human'
export const MIN_LEASE_MS = 60_000
export const MAX_LEASE_MS = 4 * 60 * 60_000

export type ToolboxEngine = Pick<QueueEngine, 'pick' | 'say' | 'repost' | 'reread' | 'requeue' | 'answer' | 'stop'>
export type ToolboxRun = {
  id: string; status: string; error: string | null; currentNodeId: string
  attempts: ReadonlyArray<{ nodeId: string; number: number; status: string; result: { outcome: string; summary: string } | null }>
}

export type ToolboxDeps = {
  store: QueueStore
  engine: ToolboxEngine
  runs?: { get(id: string): ToolboxRun | undefined }
  auditDir?: string
  secrets?: () => Promise<ReadonlyArray<string | null>>
  limits?: () => Promise<Record<string, number>>
  alert?(item: QueueItem, reason: string): void
  clearAlert?(id: string): void
  now?: () => number
}

type ToolboxAction<P> = {
  name: ActionName
  traits: Partial<ActionTraits>
  traitsFor?: (params: P) => Partial<ActionTraits>
  params: (raw: unknown) => P
  allowedIn: readonly QueueState[]
  notAllowed?: string
  run(item: QueueItem, params: P, meta: ActionMeta): Promise<unknown>
}

export type CardShow = { item: QueueItem; run: ToolboxRun | null; lease: CardLease | null; history: AuditLine[] }

export type CardToolbox = {
  perform(id: string, action: string, raw: unknown, meta: ActionMeta): Promise<unknown>
  claim(id: string, holder: Actor, ms: number, why?: string): Promise<CardLease>
  release(id: string, holder: Actor, why?: string): Promise<void>
  history(id: string, limit?: number): Promise<AuditLine[]>
  limits(): Promise<CardLimits>
  resetLimits(id: string, actor: Actor, why: string): Promise<void>
  traits(action: ActionName, raw: unknown): ActionTraits
}

const SHOW_HISTORY = 10
const MAX_KEYS = 50
const DAY_MS = 24 * 60 * 60_000
const MAX_HISTORY = 500
const CARD_ID = /^[\w-]{1,64}$/
const ANY_STATE: readonly QueueState[] = QUEUE_STATES

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const NO_TRAITS: ActionTraits = { readOnly: false, destructive: false, openWorld: false, doctor: true }

function parsed<T>(schema: z.ZodType<T>, rule: string) {
  return (raw: unknown): T => {
    const result = schema.safeParse(raw ?? {})
    if (!result.success) throw new QueueRefusal(rule, 400)
    return result.data
  }
}

const oneLineText = (max: number) => z.string().max(max).refine(text => !/[\r\n]/.test(text))
const pickAnswerSchema = z.object({ id: oneLineText(16).pipe(z.string().min(1)), label: oneLineText(200), answer: z.string().max(1000), useDefault: z.boolean().optional() })
  .refine(entry => entry.useDefault === true || entry.answer.trim() !== '')
const pickSchema = z.object({ option: z.string().min(1).max(16), tester: oneLineText(200).optional(), note: z.string().max(4000).optional(), answers: z.array(pickAnswerSchema).max(20).optional(), feedback: z.string().max(4000).optional() })
const PICK_RULE = 'option is required; tester is at most 200 characters and note at most 4000; each answer needs an id, a label and an answer, at most 20; feedback is at most 4000'

function pickParams(raw: unknown) {
  const choice = parsed(pickSchema, PICK_RULE)(raw)
  const option = normalPickOption(choice.option)
  if (option === NO_PICK && (choice.feedback ?? '').trim() === '') throw new QueueRefusal('Say what should change', 400)
  if (option !== NO_PICK && choice.feedback !== undefined) throw new QueueRefusal('Feedback is only for none of these', 400)
  return { ...choice, option }
}

const noParams = parsed(z.object({}), 'This action takes no params')
const requeueParams = (raw: unknown): { fresh: boolean } => ({ fresh: (raw as { fresh?: unknown } | null)?.fresh === true })

function table(deps: Required<Pick<ToolboxDeps, 'engine'>> & { show(item: QueueItem): Promise<CardShow> }): Map<string, ToolboxAction<unknown>> {
  const { engine } = deps
  const actions: Array<ToolboxAction<never>> = [
    { name: 'show', traits: { readOnly: true }, params: noParams, allowedIn: ANY_STATE, run: item => deps.show(item) },
    { name: 'repost', traits: { openWorld: true }, params: noParams, allowedIn: ['waiting-pick'], notAllowed: 'It is not waiting on a pick', run: item => engine.repost(item.id) },
    { name: 'say', traits: { openWorld: true, doctor: false }, params: parsed(z.object({ text: z.string().trim().min(1).max(4000) }), 'Write a message of 1 to 4000 characters'), allowedIn: ANY_STATE, run: (item, params: { text: string }) => engine.say(item.id, params.text) },
    { name: 'pick', traits: {}, params: pickParams, allowedIn: ['waiting-pick'], run: (item, params: ReturnType<typeof pickParams>) => engine.pick(item.id, params) },
    { name: 'requeue', traits: {}, traitsFor: (params: { fresh: boolean }) => ({ destructive: params.fresh, doctor: !params.fresh }), params: requeueParams, allowedIn: ['failed', 'ready', 'waiting-info', 'waiting-pick'], run: (item, params: { fresh: boolean }) => engine.requeue(item.id, params) },
    { name: 'reread', traits: {}, params: noParams, allowedIn: ['waiting-pick', 'waiting-info'], notAllowed: 'It is not waiting on a ClickUp pick', run: item => engine.reread(item.id) },
    { name: 'answer', traits: {}, params: parsed(z.object({ text: z.string().trim().min(1).max(8000) }), 'Write an answer of 1 to 8000 characters'), allowedIn: ['waiting-info'], notAllowed: 'It is not waiting for your answer', run: (item, params: { text: string }) => engine.answer(item.id, params.text) },
    { name: 'stop', traits: { destructive: true, doctor: false }, params: noParams, allowedIn: ['building', 'landing'], run: item => engine.stop(item.id) },
  ]
  return new Map(actions.map(action => [action.name, action as unknown as ToolboxAction<unknown>]))
}

function redacted(value: unknown, secrets: ReadonlyArray<string | null>): unknown {
  if (typeof value === 'string') return redactAll(value, secrets)
  if (Array.isArray(value)) return value.map(entry => redacted(entry, secrets))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redacted(entry, secrets)]))
  return value
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const isLimited = (name: ActionName): name is keyof CardLimits => Object.hasOwn(DEFAULT_CARD_LIMITS, name)
const live = (lease: CardLease | undefined, at: number): lease is CardLease => lease !== undefined && lease.until > at
const heldBy = (lease: CardLease): QueueRefusal => new QueueRefusal(`${lease.holder} holds this card until ${new Date(lease.until).toISOString()}`, 423)

export function cardToolbox(deps: ToolboxDeps): CardToolbox {
  const { store, engine } = deps
  const now = deps.now ?? Date.now
  const auditDir = deps.auditDir ?? join(configDir(), 'queue-audit')
  const secrets = deps.secrets ?? logSecrets
  let lane: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = lane.then(work)
    lane = result.catch(() => {})
    return result
  }

  const auditPath = (cardId: string): string => {
    if (!CARD_ID.test(cardId)) throw new QueueRefusal(`Not a card id: ${cardId}`, 400)
    return join(auditDir, `${cardId}.jsonl`)
  }

  async function rawLines(cardId: string): Promise<string[]> {
    try {
      return (await readFile(auditPath(cardId), 'utf8')).split('\n').filter(line => line !== '')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async function history(cardId: string, limit = MAX_HISTORY): Promise<AuditLine[]> {
    return (await rawLines(cardId)).slice(-Math.max(1, Math.min(limit, MAX_HISTORY))).map(line => JSON.parse(line) as AuditLine)
  }

  async function audit(entry: Omit<AuditLine, 'prev' | 'at'>): Promise<void> {
    const known = await secrets()
    const last = (await rawLines(entry.cardId)).at(-1)
    const line: AuditLine = { at: now(), ...entry, why: redactAll(entry.why, known), params: redacted(entry.params, known), ...(entry.error === undefined ? {} : { error: redactAll(entry.error, known) }), prev: last === undefined ? '' : sha256(last) }
    await mkdir(auditDir, { recursive: true, mode: 0o700 })
    await appendFile(auditPath(entry.cardId), `${JSON.stringify(line)}\n`, { mode: 0o600 })
  }

  const runOf = (item: QueueItem): ToolboxRun | null => {
    const runId = item.currentRunId ?? item.runIds.at(-1)
    return (runId === undefined ? undefined : deps.runs?.get(runId)) ?? null
  }
  const snapshot = (item: QueueItem): CardSnapshot => ({ state: item.state, node: runOf(item)?.currentNodeId ?? null })
  const snapshotAfter = (id: string): CardSnapshot | null => {
    const item = store.get(id)
    return item === undefined ? null : snapshot(item)
  }

  const leaseOf = (item: QueueItem): CardLease | null => (live(item.lease, now()) ? item.lease : null)
  const show = async (item: QueueItem): Promise<CardShow> => ({ item, run: runOf(item), lease: leaseOf(item), history: await history(item.id, SHOW_HISTORY) })
  const actions = table({ engine, show })

  const found = (id: string): QueueItem => {
    const item = store.get(id)
    if (item === undefined) throw new QueueRefusal(`No queue item ${id}`, 404)
    return item
  }
  const actionOf = (name: string): ToolboxAction<unknown> => {
    const action = actions.get(name)
    if (action === undefined) throw new QueueRefusal(`No such action: ${name}`, 404)
    return action
  }

  async function limits(): Promise<CardLimits> {
    const configured = await (deps.limits ?? (async () => (await readConfig()).cardLimits))()
    return Object.fromEntries(Object.entries(DEFAULT_CARD_LIMITS).map(([name, limit]) => [name, configured[name] ?? limit])) as CardLimits
  }

  async function refuseOverLimit(item: QueueItem, name: ActionName): Promise<void> {
    if (!isLimited(name)) return
    const limit = (await limits())[name]
    const since = Math.max(now() - DAY_MS, item.limitsResetAt ?? 0)
    const used = (await rawLines(item.id)).map(line => JSON.parse(line) as AuditLine).filter(line => line.action === name && line.result === 'ok' && line.at > since).length
    if (used < limit) return
    const reason = `Card needs a human: ${name} reached its limit of ${limit} in 24 hours`
    deps.alert?.(item, reason)
    throw new QueueRefusal(`${reason}. A human can clear it with: shiki queue limits reset ${item.id}`, 429)
  }

  function replayed(item: QueueItem, name: ActionName, key: string | undefined, paramsHash: string): ActionKey | null {
    const seen = key === undefined ? undefined : item.actionKeys?.find(entry => entry.key === key)
    if (seen === undefined) return null
    if (seen.action !== name || seen.paramsHash !== paramsHash) throw new QueueRefusal(`Key ${key} was already used for a different action or params`, 409)
    return seen
  }

  async function rememberKey(id: string, entry: ActionKey): Promise<void> {
    const item = store.get(id)
    if (item !== undefined) await store.update(id, { actionKeys: [...(item.actionKeys ?? []), entry].slice(-MAX_KEYS) }, { touch: false })
  }

  async function perform(id: string, name: string, raw: unknown, meta: ActionMeta): Promise<unknown> {
    const action = actionOf(name)
    return serial(async () => {
      const item = found(id)
      if (action.traits.readOnly === true) return action.run(item, action.params(raw), meta)
      auditPath(item.id)
      const before = snapshot(item)
      const record = (result: AuditLine['result'], params: unknown, error?: string) => audit({
        cardId: item.id, actor: meta.actor, action: action.name, why: meta.why, params, before,
        after: result === 'ok' ? snapshotAfter(item.id) : null, result,
        ...(error === undefined ? {} : { error }), ...(meta.key === undefined ? {} : { key: meta.key }),
      })
      let params: unknown = raw
      try {
        params = action.params(raw)
        if (live(item.lease, now()) && item.lease.holder !== meta.actor) throw heldBy(item.lease)
        const paramsHash = sha256(JSON.stringify([action.name, params]))
        const seen = replayed(item, action.name, meta.key, paramsHash)
        if (seen !== null) { await record('replayed', params); return seen.result }
        if (meta.expect !== undefined && meta.expect !== item.state) throw new QueueRefusal(`Expected ${meta.expect}, but it is ${item.state} now`, 409)
        if (!action.allowedIn.includes(item.state)) throw new QueueRefusal(action.notAllowed ?? `It is ${item.state} now`, 409)
        await refuseOverLimit(item, action.name)
        await action.run(item, params, meta)
        await record('ok', params)
        const result = snapshotAfter(item.id)
        if (meta.key !== undefined) await rememberKey(item.id, { key: meta.key, action: action.name, paramsHash, result })
        return result
      } catch (error) {
        await record(error instanceof QueueRefusal ? 'refused' : 'failed', params, errorText(error))
        throw error
      }
    })
  }

  async function guarded(id: string, actor: Actor, name: 'claim' | 'release' | 'limits-reset', why: string, params: unknown, work: (item: QueueItem) => Promise<void>): Promise<void> {
    const item = found(id)
    auditPath(item.id)
    const line = { cardId: item.id, actor, action: name, why, params, before: snapshot(item) }
    try {
      await work(item)
      await audit({ ...line, after: snapshotAfter(item.id), result: 'ok' })
    } catch (error) {
      await audit({ ...line, after: null, result: error instanceof QueueRefusal ? 'refused' : 'failed', error: errorText(error) })
      throw error
    }
  }

  const claim = (id: string, holder: Actor, ms: number, why = ''): Promise<CardLease> => serial(async () => {
    let lease: CardLease | undefined
    await guarded(id, holder, 'claim', why, { ms }, async (item) => {
      if (!Number.isInteger(ms) || ms < MIN_LEASE_MS || ms > MAX_LEASE_MS) throw new QueueRefusal(`A claim lasts ${MIN_LEASE_MS / 60_000} to ${MAX_LEASE_MS / 60_000} minutes`, 400)
      if (live(item.lease, now()) && item.lease.holder !== holder) throw heldBy(item.lease)
      lease = { holder, until: now() + ms }
      await store.update(item.id, { lease }, { touch: false })
    })
    return lease!
  })

  const release = (id: string, holder: Actor, why = ''): Promise<void> => serial(() => guarded(id, holder, 'release', why, {}, async (item) => {
    if (live(item.lease, now()) && item.lease.holder !== holder) throw heldBy(item.lease)
    await store.update(item.id, { lease: undefined }, { touch: false })
  }))

  const resetLimits = (id: string, actor: Actor, why: string): Promise<void> => serial(() => guarded(id, actor, 'limits-reset', why, {}, async (item) => {
    if (actor !== HUMAN) throw new QueueRefusal('Only a human can reset a card\'s limits', 403)
    await store.update(item.id, { limitsResetAt: now() }, { touch: false })
    deps.clearAlert?.(item.id)
  }))

  return {
    perform,
    claim,
    release,
    history: async (id, limit) => serial(() => history(id, limit)),
    limits,
    resetLimits,
    traits: (name, raw) => { const action = actionOf(name); return { ...NO_TRAITS, ...action.traits, ...action.traitsFor?.(action.params(raw)) } },
  }
}
