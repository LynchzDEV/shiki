import { Elysia } from 'elysia'
import { z } from 'zod'

import { requireLocal, type GuardContext } from '../auth'
import { peerAddress, trustedHostRequest } from '../local-access'
import { actorSchema, cardToolbox, DEFAULT_CARD_LIMITS, HUMAN, type ActionMeta, type ActionName, type CardShow, type CardToolbox } from '../card-toolbox'
import type { CardDoctor, DiagnoseMeta } from '../card-doctor'
import { QueueRefusal, SourceFailure, type QueueEngine } from '../queue-engine'
import { cleanPickSummary } from '../queue-prompts'
import type { QueueItem, QueueStore } from '../queue-store'
import { resolveQueueId } from '../queue-id'
import { mockupResponse } from '../queue-mockups'
import { queueStep, type QueueStep, type QueueStepRun } from '../queue-step'
import { listFolderRepos, resolveQueueFolder } from '../queue-folder'
import { queueTree, type QueueTree } from '../queue-tree'
import { eventStreamResponse, type RunEvents } from '../run-events'
import { QUEUE_STATES } from '../workflows'
import { MAX_CARD_LIMIT, MAX_NONE_PHRASE_LENGTH, MAX_NONE_PHRASES, MIN_NONE_PHRASE_LENGTH, MAX_PUBLISH_KEEP_DAYS, MAX_QUEUE_PARALLEL, MAX_REPLY_POLL_MINUTES, MAX_USER_ID_LENGTH, readConfig, writeConfig, type AppConfig } from '../secrets'

type Status = { status?: number | string }
type QueueEngineRoutes = Pick<QueueEngine, 'add' | 'requeue' | 'pick' | 'unpublish' | 'checkReplies' | 'answer' | 'say' | 'reread' | 'repost' | 'remove' | 'stop' | 'move' | 'checkedAt' | 'subscribeChecks' | 'startStage' | 'refreshPreflight' | 'retryStage' | 'markDone' | 'landLog' | 'report'> & Partial<Pick<QueueEngine, 'preparing' | 'paused' | 'kick' | 'note' | 'resume'>>
export type QueueRunLookup = { get(id: string): QueueStepRun | undefined; subscribe(listener: () => void): () => void }
const NO_RUNS: QueueRunLookup = { get: () => undefined, subscribe: () => () => {} }

const addSchema = z.object({
  source: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  externalId: z.string().min(1).max(200),
  repo: z.string().min(1).max(2048),
  repos: z.array(z.string().max(255)).max(64).optional(),
  flowId: z.string().min(1).max(200).nullable().optional(),
  position: z.enum(['end', 'next']).optional(),
})
const ACTOR_RULE = 'actor is a short lowercase name such as human, grok or doctor'
const doSchema = z.object({
  params: z.unknown().optional(),
  actor: actorSchema,
  why: z.string().trim().min(1).max(1000),
  key: z.string().regex(/^[\w.:-]{1,100}$/).optional(),
  expect: z.enum(QUEUE_STATES).optional(),
})
const DO_RULE = `Send { params, actor, why }: ${ACTOR_RULE}, why is 1 to 1000 characters, key (letters, digits, . : _ -) and expect (a queue state) are optional`
const claimSchema = z.object({ actor: doSchema.shape.actor, ms: z.number().int(), why: z.string().max(1000).optional() })
const releaseSchema = z.object({ actor: doSchema.shape.actor, why: z.string().max(1000).optional() })
const resetSchema = z.object({ actor: doSchema.shape.actor, why: doSchema.shape.why })
const doctorSchema = z.object({ actor: actorSchema, why: z.string().trim().min(1).max(1000).optional() })
const limitSchema = z.object({ actor: doSchema.shape.actor, action: z.enum(Object.keys(DEFAULT_CARD_LIMITS) as [string, ...string[]]), limit: z.number().int().min(0).max(MAX_CARD_LIMIT) })
const confirmSchema = z.object({ confirm: z.literal(true) })
const FROM_BROWSER: ActionMeta = { actor: 'human', why: 'browser' }
const moveSchema = z.object({ to: z.number().int().min(0) })
const whole = (max: number, rule: string) => z.number({ error: rule }).int({ error: rule }).min(1, { error: rule }).max(max, { error: rule }).optional()
const USER_ID_RULE = `pickAskTo must be a ClickUp user id of 1 to ${MAX_USER_ID_LENGTH} digits, or null`
const phrasesRule = (name: string): string => `${name} must be at most ${MAX_NONE_PHRASES} phrases of ${MIN_NONE_PHRASE_LENGTH} to ${MAX_NONE_PHRASE_LENGTH} characters`
const phrasesOf = (name: string) => {
  const rule = phrasesRule(name)
  return z.array(z.string({ error: rule }).trim().min(MIN_NONE_PHRASE_LENGTH, { error: rule }).max(MAX_NONE_PHRASE_LENGTH, { error: rule }), { error: rule }).max(MAX_NONE_PHRASES, { error: rule }).optional()
}
const settingsSchema = z.object({
  parallel: whole(MAX_QUEUE_PARALLEL, `parallel must be a whole number from 1 to ${MAX_QUEUE_PARALLEL}`),
  replyPollMinutes: whole(MAX_REPLY_POLL_MINUTES, `replyPollMinutes must be a whole number from 1 to ${MAX_REPLY_POLL_MINUTES}`),
  publishKeepDays: whole(MAX_PUBLISH_KEEP_DAYS, `publishKeepDays must be a whole number from 1 to ${MAX_PUBLISH_KEEP_DAYS}`),
  pickAskTo: z.string({ error: USER_ID_RULE }).regex(new RegExp(`^\\d{1,${MAX_USER_ID_LENGTH}}$`), { error: USER_ID_RULE }).nullable().optional(),
  pickNonePhrases: phrasesOf('pickNonePhrases'),
  pickKeepPhrases: phrasesOf('pickKeepPhrases'),
}).refine(body => Object.values(body).some(value => value !== undefined), { error: 'Send parallel, replyPollMinutes, publishKeepDays, pickAskTo, pickNonePhrases or pickKeepPhrases' })
export type QueueSettings = Pick<AppConfig, 'replyPollMinutes' | 'publishKeepDays' | 'pickAskTo' | 'pickNonePhrases' | 'pickKeepPhrases'> & { parallel: number }
const settingsOf = (config: AppConfig): QueueSettings => ({ parallel: config.queueParallel, replyPollMinutes: config.replyPollMinutes, publishKeepDays: config.publishKeepDays, pickAskTo: config.pickAskTo, pickNonePhrases: config.pickNonePhrases, pickKeepPhrases: config.pickKeepPhrases })
const NO_ITEM = 'No such queue item'
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function refusing<T>(set: Status, work: () => Promise<T>, explain: (error: unknown) => string = message): Promise<T | { error: string }> {
  try {
    return await work()
  } catch (error) {
    if (!(error instanceof QueueRefusal)) throw error
    set.status = error.status
    return { error: explain(error) }
  }
}

async function fromSource<T>(set: Status, work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work()
  } catch (error) {
    if (!(error instanceof SourceFailure)) throw error
    set.status = 502
    return { error: error.message }
  }
}

async function addItem(engine: QueueEngineRoutes, body: unknown, set: Status) {
  const parsed = addSchema.safeParse(body)
  if (!parsed.success) { set.status = 400; return { error: 'source, externalId and repo are required; position is end or next' } }
  const { repos: ticked, ...fields } = parsed.data
  const repo = await resolveQueueFolder(fields.repo, ticked)
  if (!repo.ok) { set.status = 400; return { error: repo.error } }
  const input = { ...fields, repo: repo.path, ...(repo.repos === undefined ? {} : { repos: repo.repos }) }
  try {
    return await refusing(set, async () => ({ item: cleaned(await engine.add(input, { background: true })) }))
  } catch (error) {
    if (!(error instanceof SourceFailure)) throw error
    set.status = 502
    return { error: error.message }
  }
}

async function folderRepos(path: unknown, set: Status) {
  if (typeof path !== 'string' || path === '' || path.length > 2048) { set.status = 400; return { error: 'path is required' } }
  const listing = await listFolderRepos(path)
  if (!listing.ok) { set.status = 400; return { error: listing.error } }
  return { path: listing.path, isRepo: listing.isRepo, repos: listing.repos, skipped: listing.skipped }
}

const explainMissing = (error: unknown): string => message(error)
const text = (body: string, type: string): Response => new Response(body, { headers: { 'content-type': `${type}; charset=utf-8` } })
const isConflict = (error: unknown): boolean => error instanceof QueueRefusal && error.status === 409
const conflictOrMissing = (error: unknown): string => (isConflict(error) ? message(error) : NO_ITEM)
const missingAsNoItem = (error: unknown): string => (error instanceof QueueRefusal && error.status === 404 ? NO_ITEM : message(error))

function itemsChecksAndRuns(store: QueueStore, engine: QueueEngineRoutes, runs: QueueRunLookup, settings: Set<() => void>): RunEvents {
  return {
    changed: store.changed,
    subscribe(listener) {
      settings.add(listener)
      const stops = [store.subscribe(listener), engine.subscribeChecks(listener), runs.subscribe(listener), () => { settings.delete(listener) }]
      return () => { for (const stop of stops) stop() }
    },
  }
}

const cleaned = (item: QueueItem): QueueItem => (item.pick === undefined ? item : { ...item, pick: { ...item.pick, summary: cleanPickSummary(item.pick.summary) } })
const isShow = (value: unknown): value is CardShow => value !== null && typeof value === 'object' && 'item' in value && 'history' in value
const shownCleaned = (value: unknown): unknown => (isShow(value) ? { ...value, item: cleaned(value.item) } : value)

function withStep(item: QueueItem, runs: QueueRunLookup, preparing: string | null): QueueItem & { step?: QueueStep; preparing?: true } {
  if (item.state === 'queued' && item.id === preparing) return { ...item, preparing: true }
  const run = item.state === 'building' && item.currentRunId !== null ? runs.get(item.currentRunId) : undefined
  const step = run === undefined ? null : queueStep(run)
  return step === null ? item : { ...item, step }
}

// The Pick panel iframe is sandboxed (opaque origin), so its own assets look cross-site to requireLocal.
const MOCKUP_ASSET_PATH = /^\/queue\/[^/]+\/files\//

async function requireLocalExceptMockupAssets(context: GuardContext): Promise<void | { error: string }> {
  const request = context.request
  if (request.method === 'GET'
    && MOCKUP_ASSET_PATH.test(new URL(request.url).pathname)
    && trustedHostRequest(request, peerAddress(context.server, request))) return
  return requireLocal(context)
}

export function queueRoutes(store: QueueStore, engine: QueueEngineRoutes, tree: () => Promise<QueueTree> = () => queueTree(store.list()), runs: QueueRunLookup = NO_RUNS, onSettings: (settings: QueueSettings) => void = () => {}, toolbox: CardToolbox = cardToolbox({ store, engine }), doctor?: CardDoctor) {
  const doctorDoes = <T>(body: unknown, set: Status, work: (doctor: CardDoctor, meta: DiagnoseMeta) => Promise<T>) => {
    const parsed = doctorSchema.safeParse(body ?? {})
    if (!parsed.success) { set.status = 400; return { error: `Send { actor, why? }: ${ACTOR_RULE}, why is 1 to 1000 characters` } }
    return fromSource(set, () => refusing(set, async () => {
      if (doctor === undefined) throw new QueueRefusal('The card doctor is not set up', 404)
      return work(doctor, { actor: parsed.data.actor, why: parsed.data.why ?? 'cli' })
    }))
  }
  const act = (id: string, action: ActionName, raw: unknown, set: Status, explain?: (error: unknown) => string) => fromSource(set, () => refusing(set, async () => {
    await toolbox.perform(id, action, raw ?? {}, FROM_BROWSER)
    return { item: cleaned(store.get(id)!) }
  }, explain))
  let settings: QueueSettings = { parallel: 1, replyPollMinutes: 2, publishKeepDays: 14, pickAskTo: null, pickNonePhrases: [], pickKeepPhrases: [] }
  const settingsListeners = new Set<() => void>()
  const readSettings = async (): Promise<QueueSettings> => { settings = settingsOf(await readConfig()); return settings }
  void readSettings().catch(() => {})
  const snapshot = () => ({ items: store.list().map(item => withStep(cleaned(item), runs, engine.preparing?.() ?? null)), checkedAt: engine.checkedAt(), paused: engine.paused?.() ?? null, ...settings })
  return new Elysia()
    .onBeforeHandle(requireLocalExceptMockupAssets)
    .onBeforeHandle(({ params, set }) => {
      const given = (params as { id?: string } | undefined)?.id
      if (given === undefined) return
      const resolved = resolveQueueId(store.list(), given)
      if ('error' in resolved && resolved.status === 404) return
      if ('error' in resolved) { set.status = resolved.status; return { error: resolved.error } }
      ;(params as { id: string }).id = resolved.id
    })
    .get('/api/queue', async () => { await readSettings(); return snapshot() })
    .put('/api/queue/settings', async ({ body, set }) => {
      const parsed = settingsSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: parsed.error.issues[0]!.message } }
      const { parallel, ...rest } = parsed.data
      const patch = Object.fromEntries(Object.entries({ queueParallel: parallel, ...rest }).filter(([, value]) => value !== undefined))
      settings = settingsOf(await writeConfig(patch))
      for (const listener of settingsListeners) listener()
      onSettings(settings)
      await engine.kick?.()
      return settings
    })
    .get('/api/queue/limits', async () => ({ limits: await toolbox.limits() }))
    .put('/api/queue/limits', async ({ body, set }) => {
      const parsed = limitSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: `Send { actor, action, limit }: action is one of ${Object.keys(DEFAULT_CARD_LIMITS).join(', ')}, limit is a whole number from 0 to ${MAX_CARD_LIMIT}` } }
      if (parsed.data.actor !== HUMAN) { set.status = 403; return { error: 'Only a human can change card limits' } }
      await writeConfig({ cardLimits: { ...(await readConfig()).cardLimits, [parsed.data.action]: parsed.data.limit } })
      return { limits: await toolbox.limits() }
    })
    .get('/api/queue/tree', () => tree())
    .get('/api/queue/folder', ({ query, set }) => folderRepos(query.path, set))
    .get('/api/queue/stream', ({ request }) => eventStreamResponse(itemsChecksAndRuns(store, engine, runs, settingsListeners), snapshot, request.signal))
    .post('/api/queue', ({ body, set }) => addItem(engine, body, set))
    .post('/api/queue/check', () => engine.checkReplies())
    .post('/api/queue/:id/move', async ({ params, body, set }) => {
      const parsed = moveSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: 'to must be a position from 0' } }
      return refusing(set, async () => { await engine.move(params.id, parsed.data.to); return { items: store.list().map(cleaned) } }, conflictOrMissing)
    })
    .post('/api/queue/:id/pick', ({ params, body, set }) => act(params.id, 'pick', body, set))
    .post('/api/queue/:id/unpublish', ({ params, set }) => refusing(set, async () => ({ item: cleaned(await engine.unpublish(params.id)) }), conflictOrMissing))
    .post('/api/queue/:id/answer', ({ params, body, set }) => act(params.id, 'answer', body, set))
    .post('/api/queue/:id/say', ({ params, body, set }) => act(params.id, 'say', body, set))
    .post('/api/queue/:id/reread', ({ params, set }) => act(params.id, 'reread', {}, set))
    .post('/api/queue/:id/repost', ({ params, set }) => act(params.id, 'repost', {}, set))
    .post('/api/queue/:id/do/:action', ({ params, body, set }) => {
      const parsed = doSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: DO_RULE } }
      const { params: raw, ...meta } = parsed.data
      return fromSource(set, () => refusing(set, async () => {
        const result = await toolbox.perform(params.id, params.action, raw ?? {}, meta)
        const item = store.get(params.id)
        return { result: shownCleaned(result), item: item === undefined ? null : cleaned(item) }
      }))
    })
    .post('/api/queue/:id/claim', ({ params, body, set }) => {
      const parsed = claimSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: `Send { actor, ms }: ${ACTOR_RULE}, ms is how long the claim lasts` } }
      return refusing(set, async () => ({ lease: await toolbox.claim(params.id, parsed.data.actor, parsed.data.ms, parsed.data.why) }))
    })
    .post('/api/queue/:id/release', ({ params, body, set }) => {
      const parsed = releaseSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: `Send { actor }: ${ACTOR_RULE}` } }
      return refusing(set, async () => { await toolbox.release(params.id, parsed.data.actor, parsed.data.why); return { ok: true } })
    })
    .post('/api/queue/:id/limits/reset', ({ params, body, set }) => {
      const parsed = resetSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: `Send { actor, why }: ${ACTOR_RULE}, why is 1 to 1000 characters` } }
      return refusing(set, async () => { await toolbox.resetLimits(params.id, parsed.data.actor, parsed.data.why); return { ok: true } })
    })
    .post('/api/queue/:id/doctor', ({ params, body, set }) => doctorDoes(body, set, (cardDoctor, meta) => cardDoctor.diagnose(params.id, meta)))
    .get('/api/queue/:id/doctor', ({ params, set }) => refusing(set, async () => {
      if (doctor === undefined) throw new QueueRefusal('The card doctor is not set up', 404)
      return { suggestion: doctor.show(params.id) }
    }))
    .post('/api/queue/:id/doctor/apply', ({ params, body, set }) => doctorDoes(body, set, async (cardDoctor, meta) => ({ suggestion: await cardDoctor.apply(params.id, meta), item: cleaned(store.get(params.id)!) })))
    .post('/api/queue/:id/doctor/dismiss', ({ params, body, set }) => doctorDoes(body, set, async (cardDoctor, meta) => ({ suggestion: await cardDoctor.dismiss(params.id, meta) })))
    .get('/api/queue/:id/show', ({ params, set }) => refusing(set, async () => shownCleaned(await toolbox.perform(params.id, 'show', {}, { actor: 'human', why: 'show' }))))
    .get('/api/queue/:id/history', ({ params, query, set }) => refusing(set, async () => {
      const lines = await toolbox.history(params.id, query.limit === undefined ? undefined : Number.parseInt(query.limit, 10) || undefined)
      if (lines.length === 0 && store.get(params.id) === undefined) throw new QueueRefusal(`No queue item ${params.id}`, 404)
      return { history: lines }
    }))
    .get('/queue/:id/files/*', ({ params }) => mockupResponse(store.get(params.id)?.worktree ?? null, params['*']))
    .post('/api/queue/:id/land/retry', ({ params, set }) => refusing(set, async () => ({ item: cleaned(await engine.retryStage(params.id)) }), explainMissing))
    .post('/api/queue/:id/land/done', ({ params, set }) => refusing(set, async () => ({ item: cleaned(await engine.markDone(params.id)) }), explainMissing))
    .post('/api/queue/:id/land/:stage/start', ({ params, body, set }) => {
      if (!confirmSchema.safeParse(body).success) { set.status = 400; return { error: 'Send { "confirm": true } to start this stage' } }
      return refusing(set, async () => ({ item: cleaned(await engine.startStage(params.id, params.stage)) }), explainMissing)
    })
    .post('/api/queue/:id/land/:stage/preflight', ({ params, set }) => refusing(set, async () => ({ item: cleaned(await engine.refreshPreflight(params.id, params.stage)) }), explainMissing))
    .get('/api/queue/:id/land/:stage/log', ({ params, set }) => refusing(set, async () => text(await engine.landLog(params.id, params.stage), 'text/plain'), explainMissing))
    .get('/api/queue/:id/report', ({ params, set }) => refusing(set, async () => text(await engine.report(params.id), 'text/markdown'), explainMissing))
    .post('/api/queue/:id/requeue', ({ params, body, set }) => act(params.id, 'requeue', body, set))
    .post('/api/queue/:id/stop', ({ params, set }) => act(params.id, 'stop', {}, set, missingAsNoItem))
    .delete('/api/queue/:id', ({ params, set }) => refusing(set, async () => { await engine.remove(params.id); return { ok: true } }, conflictOrMissing))
}
