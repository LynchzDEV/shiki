import { Elysia } from 'elysia'
import { z } from 'zod'

import { requireLocal, type GuardContext } from '../auth'
import { peerAddress, trustedHostRequest } from '../local-access'
import { QueueRefusal, SourceFailure, type QueueEngine } from '../queue-engine'
import type { QueueItem, QueueStore } from '../queue-store'
import { mockupResponse } from '../queue-mockups'
import { queueStep, type QueueStep, type QueueStepRun } from '../queue-step'
import { listFolderRepos, resolveQueueFolder } from '../queue-folder'
import { queueTree, type QueueTree } from '../queue-tree'
import { eventStreamResponse, type RunEvents } from '../run-events'

type Status = { status?: number | string }
type QueueEngineRoutes = Pick<QueueEngine, 'add' | 'requeue' | 'pick' | 'checkReplies' | 'remove' | 'move' | 'checkedAt' | 'subscribeChecks' | 'startStage' | 'refreshPreflight' | 'retryStage' | 'landLog' | 'report'> & Partial<Pick<QueueEngine, 'preparing'>>
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
const pickSchema = z.object({ option: z.string().min(1).max(16), tester: z.string().max(200).optional(), note: z.string().max(4000).optional() })
const confirmSchema = z.object({ confirm: z.literal(true) })
const moveSchema = z.object({ to: z.number().int().min(0) })
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

async function requeueItem(store: QueueStore, engine: QueueEngineRoutes, id: string, set: Status) {
  const item = store.get(id)
  if (item === undefined) { set.status = 404; return { error: NO_ITEM } }
  if (item.state === 'building') { set.status = 409; return { error: 'It is building now' } }
  return refusing(set, async () => ({ item: await engine.requeue(id) }))
}

async function addItem(engine: QueueEngineRoutes, body: unknown, set: Status) {
  const parsed = addSchema.safeParse(body)
  if (!parsed.success) { set.status = 400; return { error: 'source, externalId and repo are required; position is end or next' } }
  const { repos: ticked, ...fields } = parsed.data
  const repo = await resolveQueueFolder(fields.repo, ticked)
  if (!repo.ok) { set.status = 400; return { error: repo.error } }
  const input = { ...fields, repo: repo.path, ...(repo.repos === undefined ? {} : { repos: repo.repos }) }
  try {
    return await refusing(set, async () => ({ item: await engine.add(input, { background: true }) }))
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
const removeExplanation = (error: unknown): string => (isConflict(error) ? 'Stop its run in Studio first' : NO_ITEM)
const moveExplanation = (error: unknown): string => (isConflict(error) ? message(error) : NO_ITEM)

function itemsChecksAndRuns(store: QueueStore, engine: QueueEngineRoutes, runs: QueueRunLookup): RunEvents {
  return {
    changed: store.changed,
    subscribe(listener) {
      const stops = [store.subscribe(listener), engine.subscribeChecks(listener), runs.subscribe(listener)]
      return () => { for (const stop of stops) stop() }
    },
  }
}

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

export function queueRoutes(store: QueueStore, engine: QueueEngineRoutes, tree: () => Promise<QueueTree> = () => queueTree(store.list()), runs: QueueRunLookup = NO_RUNS) {
  const snapshot = () => ({ items: store.list().map(item => withStep(item, runs, engine.preparing?.() ?? null)), checkedAt: engine.checkedAt() })
  return new Elysia()
    .onBeforeHandle(requireLocalExceptMockupAssets)
    .get('/api/queue', snapshot)
    .get('/api/queue/tree', () => tree())
    .get('/api/queue/folder', ({ query, set }) => folderRepos(query.path, set))
    .get('/api/queue/stream', ({ request }) => eventStreamResponse(itemsChecksAndRuns(store, engine, runs), snapshot, request.signal))
    .post('/api/queue', ({ body, set }) => addItem(engine, body, set))
    .post('/api/queue/check', () => engine.checkReplies())
    .post('/api/queue/:id/move', async ({ params, body, set }) => {
      const parsed = moveSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: 'to must be a position from 0' } }
      return refusing(set, async () => { await engine.move(params.id, parsed.data.to); return { items: store.list() } }, moveExplanation)
    })
    .post('/api/queue/:id/pick', ({ params, body, set }) => {
      const parsed = pickSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: 'option is required; tester is at most 200 characters and note at most 4000' } }
      return refusing(set, async () => ({ item: await engine.pick(params.id, parsed.data) }))
    })
    .get('/queue/:id/files/*', ({ params }) => mockupResponse(store.get(params.id)?.worktree ?? null, params['*']))
    .post('/api/queue/:id/land/retry', ({ params, set }) => refusing(set, async () => ({ item: await engine.retryStage(params.id) }), explainMissing))
    .post('/api/queue/:id/land/:stage/start', ({ params, body, set }) => {
      if (!confirmSchema.safeParse(body).success) { set.status = 400; return { error: 'Send { "confirm": true } to start this stage' } }
      return refusing(set, async () => ({ item: await engine.startStage(params.id, params.stage) }), explainMissing)
    })
    .post('/api/queue/:id/land/:stage/preflight', ({ params, set }) => refusing(set, async () => ({ item: await engine.refreshPreflight(params.id, params.stage) }), explainMissing))
    .get('/api/queue/:id/land/:stage/log', ({ params, set }) => refusing(set, async () => text(await engine.landLog(params.id, params.stage), 'text/plain'), explainMissing))
    .get('/api/queue/:id/report', ({ params, set }) => refusing(set, async () => text(await engine.report(params.id), 'text/markdown'), explainMissing))
    .post('/api/queue/:id/requeue', ({ params, set }) => requeueItem(store, engine, params.id, set))
    .delete('/api/queue/:id', ({ params, set }) => refusing(set, async () => { await engine.remove(params.id); return { ok: true } }, removeExplanation))
}
