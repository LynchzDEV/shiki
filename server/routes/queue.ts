import { Elysia } from 'elysia'
import { z } from 'zod'

import { requireLocal, type GuardContext } from '../auth'
import { peerAddress, trustedHostRequest } from '../local-access'
import { QueueRefusal, SourceFailure, type QueueEngine } from '../queue-engine'
import { cleanPickSummary, NO_PICK } from '../queue-prompts'
import type { QueueItem, QueueStore } from '../queue-store'
import { mockupResponse } from '../queue-mockups'
import { queueStep, type QueueStep, type QueueStepRun } from '../queue-step'
import { listFolderRepos, resolveQueueFolder } from '../queue-folder'
import { queueTree, type QueueTree } from '../queue-tree'
import { eventStreamResponse, type RunEvents } from '../run-events'
import { MAX_PUBLISH_KEEP_DAYS, MAX_QUEUE_PARALLEL, MAX_REPLY_POLL_MINUTES, readConfig, writeConfig, type AppConfig } from '../secrets'

type Status = { status?: number | string }
type QueueEngineRoutes = Pick<QueueEngine, 'add' | 'requeue' | 'pick' | 'checkReplies' | 'answer' | 'remove' | 'stop' | 'move' | 'checkedAt' | 'subscribeChecks' | 'startStage' | 'refreshPreflight' | 'retryStage' | 'markDone' | 'landLog' | 'report'> & Partial<Pick<QueueEngine, 'preparing' | 'paused' | 'kick'>>
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
const oneLineText = (max: number) => z.string().max(max).refine(text => !/[\r\n]/.test(text))
const pickAnswerSchema = z.object({ id: oneLineText(16).pipe(z.string().min(1)), label: oneLineText(200), answer: z.string().max(1000), useDefault: z.boolean().optional() })
  .refine(entry => entry.useDefault === true || entry.answer.trim() !== '')
const pickSchema = z.object({ option: z.string().min(1).max(16), tester: oneLineText(200).optional(), note: z.string().max(4000).optional(), answers: z.array(pickAnswerSchema).max(20).optional(), feedback: z.string().max(4000).optional() })
const confirmSchema = z.object({ confirm: z.literal(true) })
const answerSchema = z.object({ text: z.string().trim().min(1).max(8000) })
const moveSchema = z.object({ to: z.number().int().min(0) })
const whole = (max: number, rule: string) => z.number({ error: rule }).int({ error: rule }).min(1, { error: rule }).max(max, { error: rule }).optional()
const settingsSchema = z.object({
  parallel: whole(MAX_QUEUE_PARALLEL, `parallel must be a whole number from 1 to ${MAX_QUEUE_PARALLEL}`),
  replyPollMinutes: whole(MAX_REPLY_POLL_MINUTES, `replyPollMinutes must be a whole number from 1 to ${MAX_REPLY_POLL_MINUTES}`),
  publishKeepDays: whole(MAX_PUBLISH_KEEP_DAYS, `publishKeepDays must be a whole number from 1 to ${MAX_PUBLISH_KEEP_DAYS}`),
}).refine(body => Object.values(body).some(value => value !== undefined), { error: 'Send parallel, replyPollMinutes or publishKeepDays' })
export type QueueSettings = Pick<AppConfig, 'replyPollMinutes' | 'publishKeepDays'> & { parallel: number }
const settingsOf = (config: AppConfig): QueueSettings => ({ parallel: config.queueParallel, replyPollMinutes: config.replyPollMinutes, publishKeepDays: config.publishKeepDays })
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

async function requeueItem(store: QueueStore, engine: QueueEngineRoutes, id: string, body: unknown, set: Status) {
  const item = store.get(id)
  if (item === undefined) { set.status = 404; return { error: NO_ITEM } }
  if (item.state === 'building') { set.status = 409; return { error: 'It is building now' } }
  const fresh = (body as { fresh?: unknown } | null)?.fresh === true
  return refusing(set, async () => ({ item: cleaned(await engine.requeue(id, { fresh })) }))
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

export function queueRoutes(store: QueueStore, engine: QueueEngineRoutes, tree: () => Promise<QueueTree> = () => queueTree(store.list()), runs: QueueRunLookup = NO_RUNS, onSettings: (settings: QueueSettings) => void = () => {}) {
  let settings: QueueSettings = { parallel: 1, replyPollMinutes: 2, publishKeepDays: 14 }
  const settingsListeners = new Set<() => void>()
  const readSettings = async (): Promise<QueueSettings> => { settings = settingsOf(await readConfig()); return settings }
  void readSettings().catch(() => {})
  const snapshot = () => ({ items: store.list().map(item => withStep(cleaned(item), runs, engine.preparing?.() ?? null)), checkedAt: engine.checkedAt(), paused: engine.paused?.() ?? null, ...settings })
  return new Elysia()
    .onBeforeHandle(requireLocalExceptMockupAssets)
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
    .post('/api/queue/:id/pick', ({ params, body, set }) => {
      const parsed = pickSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: 'option is required; tester is at most 200 characters and note at most 4000; each answer needs an id, a label and an answer, at most 20; feedback is at most 4000' } }
      const { option, feedback } = parsed.data
      if (option === NO_PICK && (feedback ?? '').trim() === '') { set.status = 400; return { error: 'Say what should change' } }
      if (option !== NO_PICK && feedback !== undefined) { set.status = 400; return { error: 'Feedback is only for none of these' } }
      return refusing(set, async () => ({ item: cleaned(await engine.pick(params.id, parsed.data)) }))
    })
    .post('/api/queue/:id/answer', ({ params, body, set }) => {
      const parsed = answerSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: 'Write an answer of 1 to 8000 characters' } }
      return refusing(set, async () => ({ item: cleaned(await engine.answer(params.id, parsed.data.text)) }))
    })
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
    .post('/api/queue/:id/requeue', ({ params, body, set }) => requeueItem(store, engine, params.id, body, set))
    .post('/api/queue/:id/stop', ({ params, set }) => refusing(set, async () => ({ item: cleaned(await engine.stop(params.id)) }), conflictOrMissing))
    .delete('/api/queue/:id', ({ params, set }) => refusing(set, async () => { await engine.remove(params.id); return { ok: true } }, conflictOrMissing))
}
