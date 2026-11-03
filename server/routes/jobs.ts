import { watch } from 'node:fs'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { Elysia } from 'elysia'

import { requireLocal } from '../auth'
import { oneLine, parseActivity, parseThread } from '../activity'
import type { ChatJobPatch, CreateJobParams, JobManager, JobRecord } from '../jobs'
import { completeLinesPrefix, readCompleteLinesSince, readLogSince, readLogTail } from '../jobs'
import { configDir, readConfig } from '../secrets'
import { activityRedactor, createSecretsRedactor, logSecrets, readRedactedLog, redactAll, redactedTailReader } from '../log-redaction'
import { projectMemory } from '../chat-reports'
import type { ChatQueue } from '../chat-queue'
import { chatQueuePath, createChatQueue } from '../chat-queue'
import { attentionKey, type AttentionStore } from '../attention'
import { chatHome } from '../chat-home'
import { returnedOriginals } from '../drops'
import { validateWorkspaceCwd } from '../workspace'
import type { BridgeImage, BridgeImageMedia, ChatPermissionMode } from '../chat-bridge-core'
import type { EngineResolver } from '../jobs-engine-iface'
import { chatUsesBridge, engineSupportsResume } from '../jobs-engine-iface'
import { MAX_MODEL_LENGTH } from '../engines'
import { lintSpec } from '../spec-lint'
import { findEditCall, serializeTurnUndo, UNDO_ALREADY, UNDO_CHANGED, UNDO_UNSUPPORTED, undoEditContent } from '../chat-undo'
import { readRoles } from './roles'
import { assembleThread, replySessionId, threadChain, threadIsRunning, threadRootOf } from '../threads'
import { buildTurnTree, forkPointUuid, nearestSessionId, newestLeaf, type TurnTree } from '../thread-tree'
import { isLogEvent, mentionsLogEvent } from '../log-events'

export const SSE_TAIL_BYTES = 4096
export const HEARTBEAT_MS = 15_000
export const ACTIVITY_FEED_MAX = 50
export const CHAT_TITLE_MAX = 60
export const SPAWN_REASON_MAX = 200
export const IMAGE_MAX_BYTES = 3_932_160
export const IMAGE_MAX_COUNT = 8
export const CHAT_PERMISSION_MODES = ['settings', 'ask', 'acceptEdits', 'plan', 'bypass'] as const

function imageMediaType(bytes: Uint8Array): BridgeImageMedia | null {
  const at = (index: number): number => bytes[index] ?? 0
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif'
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp'
  return null
}

async function dropsRoot(): Promise<string | null> {
  try {
    return await realpath(join(configDir(), 'drops'))
  } catch {
    return null
  }
}

export type ChatImages = { images: BridgeImage[]; tokens: string[] } | Failure

export async function resolveChatImages(payload: Record<string, unknown>): Promise<ChatImages> {
  const raw = payload.images
  if (raw === undefined) return { images: [], tokens: [] }
  if (!Array.isArray(raw)) return { status: 400, error: 'images must be a list of paths' }
  if (raw.length > IMAGE_MAX_COUNT) return { status: 400, error: `An image list may hold at most ${IMAGE_MAX_COUNT} files` }
  const root = await dropsRoot()
  const images: BridgeImage[] = []
  const tokens: string[] = []
  for (const entry of raw) {
    const path = typeof entry === 'object' && entry !== null && typeof (entry as { path?: unknown }).path === 'string' ? (entry as { path: string }).path : ''
    const bad = (reason: string): Failure => ({ status: 400, error: `Image ${path === '' ? 'file' : basename(path)} cannot be sent: ${reason}` })
    if (path === '') return bad('a path is required')
    let real: string
    try {
      real = await realpath(path)
    } catch {
      return bad('attach it again')
    }
    if (root === null || (real !== root && !real.startsWith(`${root}/`))) {
      if (!returnedOriginals.has(real)) return bad('attach it again')
    }
    const info = await stat(real).catch(() => null)
    if (info === null || !info.isFile()) return bad('attach it again')
    if (info.size > IMAGE_MAX_BYTES) return bad('it is larger than 3.75 MB')
    const mediaType = imageMediaType(new Uint8Array(await readFile(real).catch(() => new ArrayBuffer(0))))
    if (mediaType === null) return bad('it is not a PNG, JPEG, GIF or WebP image')
    images.push({ path: real, mediaType })
    for (const token of new Set([path, real])) tokens.push(token)
  }
  return { images, tokens }
}

export function stripImageTokens(text: string, tokens: readonly string[]): string {
  let next = text
  for (const token of tokens) {
    for (const form of [token, `'${token}'`, `"${token}"`]) {
      next = next.split(form).join('')
    }
  }
  return next.replace(/[ \t]{2,}/g, ' ').trim()
}

function chatPromptWithImages(payload: Record<string, unknown>, prompt: string, images: readonly BridgeImage[], tokens: readonly string[]): string {
  if (images.length === 0 || !chatUsesBridge(String(payload.engine ?? ''), payload.purpose === 'chat' ? 'chat' : undefined)) return prompt
  return stripImageTokens(prompt, tokens)
}


type Placement = { prevTurnId: string | null; versionOf?: string; branchFrom?: string; rootless?: boolean } | Failure

function placeReply(tree: TurnTree, body: Record<string, unknown>): Placement {
  const from = body.from as { turnId?: unknown; mode?: unknown } | undefined
  if (from !== undefined) {
    const turnId = typeof from.turnId === 'string' ? from.turnId : ''
    if ((from.mode !== 'replace' && from.mode !== 'after') || turnId === '' || !tree.byId.has(turnId)) {
      return { status: 409, error: 'That message is not part of this chat' }
    }
    if (from.mode === 'after') return { prevTurnId: turnId, branchFrom: turnId }
    const kept = tree.prev.get(turnId) ?? null
    const target = tree.byId.get(turnId)
    const original = target !== undefined && typeof target.versionOf === 'string' && target.versionOf !== '' ? target.versionOf : turnId
    return { prevTurnId: kept, versionOf: original, rootless: kept === null }
  }
  const parentTurnId = typeof body.parentTurnId === 'string' && body.parentTurnId !== '' ? body.parentTurnId : null
  if (parentTurnId === null) return { prevTurnId: newestLeaf(tree) }
  if (!tree.byId.has(parentTurnId)) return { status: 409, error: 'parentTurnId must name a turn of this chat' }
  return { prevTurnId: tree.newestLeafUnder(parentTurnId) }
}

function activeLeaf(tree: TurnTree, requested: unknown): string | null {
  if (typeof requested !== 'string' || !tree.byId.has(requested)) return null
  return tree.newestLeafUnder(requested)
}

async function resumeForPlacement(manager: JobManager, tree: TurnTree, placement: Placement): Promise<{ sessionId: string | null; forkSession?: boolean; resumeSessionAt?: string } | Failure> {
  const prevId = placement.prevTurnId
  if (prevId === null) return { sessionId: null }
  const sessionId = nearestSessionId(tree, prevId)
  if (placement.versionOf === undefined && placement.branchFrom === undefined) return { sessionId }
  if (sessionId === null) return { sessionId: null }
  const uuid = forkPointUuid(await readRedactedLog(manager.logPath(prevId)))
  if (uuid === null) return { status: 409, error: 'This reply is too old to branch from' }
  return { sessionId, forkSession: true, resumeSessionAt: uuid }
}

export type LiveTurn = { jobId: string; offset: number; partial: boolean }

export type ChatUsage = { contextPercent: number | null; costUsd: number | null }

async function chatUsage(chain: readonly JobRecord[], manager: JobManager, engine: string): Promise<ChatUsage> {
  let contextPercent: number | null = null
  let costUsd: number | null = null
  for (const turn of chain) {
    const log = await readRedactedLog(manager.logPath(turn.id))
    for (const line of log.split('\n')) {
      if (!mentionsLogEvent(line, 'context') && !line.includes('"total_cost_usd"')) continue
      try {
        const parsed = JSON.parse(line) as { type?: string; percentage?: unknown; total_cost_usd?: unknown }
        if (isLogEvent(parsed.type, 'context') && typeof parsed.percentage === 'number' && Number.isFinite(parsed.percentage)) contextPercent = parsed.percentage
        if (parsed.type === 'result' && typeof parsed.total_cost_usd === 'number' && Number.isFinite(parsed.total_cost_usd)) costUsd = parsed.total_cost_usd
      } catch {
        // a torn line mid-write is skipped
      }
    }
  }
  return { contextPercent, costUsd: engine === 'claude' ? costUsd : null }
}

type LiveSnapshot = { live: LiveTurn; log: string }

export type LogBytesReader = (path: string) => Promise<Uint8Array>

const readWholeLog: LogBytesReader = async (path) => new Uint8Array(await Bun.file(path).arrayBuffer())

async function liveSnapshot(chain: readonly JobRecord[], manager: JobManager, readLogBytes: LogBytesReader): Promise<LiveSnapshot | null> {
  const running = [...chain].reverse().find((turn) => turn.status === 'running')
  if (running === undefined) return null
  const bytes = await readLogBytes(manager.logPath(running.id)).catch(() => null)
  if (bytes === null) return null
  const { content, byteLength } = completeLinesPrefix(bytes)
  const log = redactAll(content, await logSecrets())
  const lastText = [...parseThread(log)].reverse().find((event) => event.kind === 'text' || event.kind === 'thinking')
  return { live: { jobId: running.id, offset: byteLength, partial: lastText?.partial === true }, log }
}

type Failure = { status: number; error: string }

function isFailure(value: unknown): value is Failure {
  return typeof value === 'object' && value !== null && 'error' in value && 'status' in value
}

async function realHome(): Promise<string> {
  try {
    return await realpath(homedir())
  } catch {
    return homedir()
  }
}

function isChatRoot(job: JobRecord | undefined): job is JobRecord {
  return job !== undefined && job.purpose === 'chat' && threadRootOf(job) === job.id
}

async function chatMemory(manager: JobManager, project: string | null | undefined, rootId: string): Promise<Pick<CreateJobParams, 'memory'>> {
  if (!project) return {}
  const read = await redactedTailReader()
  return { memory: await projectMemory(manager.listJobs(), project, rootId, (id) => read(manager.logPath(id))) }
}

function chatTitle(prompt: string): string {
  return (prompt.split('\n')[0] ?? '').trim().slice(0, CHAT_TITLE_MAX)
}

async function projectInChatHome(path: string, root: JobRecord): Promise<string | Failure> {
  const home = await realHome()
  const check = await validateWorkspaceCwd(path, home, { requireGit: false })
  if (!check.ok) return { status: 400, error: check.error }
  const chat = chatHome(await readConfig(), [root.cwd], home)
  if (!chat.ok || (check.path !== chat.path && !check.path.startsWith(`${chat.path}/`))) {
    return { status: 400, error: 'project must be inside Chat home' }
  }
  return check.path
}

function chatSpawnFields(payload: Record<string, unknown>, manager: JobManager): Pick<CreateJobParams, 'chatId' | 'chatTurn' | 'reason' | 'reviewOf'> | Failure {
  const { chat, chatTurn, reason, reviewOf } = payload
  if (chat !== undefined && (typeof chat !== 'string' || !isChatRoot(manager.getJob(chat)))) return { status: 400, error: 'chat not found' }
  if (reviewOf !== undefined && (typeof reviewOf !== 'string' || manager.getJob(reviewOf) === undefined)) return { status: 400, error: 'reviewOf must name an existing job' }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > SPAWN_REASON_MAX)) return { status: 400, error: `reason must be at most ${SPAWN_REASON_MAX} characters` }
  return {
    ...(typeof chat === 'string' ? { chatId: chat } : {}),
    ...(typeof chatTurn === 'string' && chatTurn !== '' ? { chatTurn } : {}),
    ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
    ...(typeof reviewOf === 'string' ? { reviewOf } : {}),
  }
}

async function chatRootFields(payload: Record<string, unknown>): Promise<Pick<CreateJobParams, 'purpose' | 'edit' | 'project'> | Failure> {
  if (payload.purpose !== 'chat') return {}
  if (!engineSupportsResume(payload.engine as string)) return { status: 400, error: 'chat needs an AI that can resume a conversation' }
  if (typeof payload.project !== 'string') return { purpose: 'chat', edit: payload.edit === true }
  const check = await validateWorkspaceCwd(payload.project, await realHome(), { requireGit: false })
  if (!check.ok) return { status: 400, error: check.error }
  return { purpose: 'chat', edit: payload.edit === true, project: check.path }
}

function chatPatch(body: Record<string, unknown>, root: JobRecord): ChatJobPatch | Failure {
  const patch: ChatJobPatch = {}
  if (body.titleLocked !== undefined) {
    if (body.titleLocked !== true) return { status: 400, error: 'titleLocked can only be set to true' }
    patch.titleLocked = true
  }
  if (body.label !== undefined) {
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    if (label === '' || label.length > CHAT_TITLE_MAX) return { status: 400, error: `label must be 1-${CHAT_TITLE_MAX} characters` }
    if (body.titleLocked !== undefined || root.titleLocked !== true) patch.label = label
  }
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== 'boolean') return { status: 400, error: 'pinned must be true or false' }
    patch.pinned = body.pinned
  }
  if (body.deleted !== undefined) {
    if (body.deleted !== true) return { status: 400, error: 'deleted can only be set to true' }
    patch.deletedAt = Date.now()
  }
  return patch
}

function logHasPendingPermission(log: string, requestId: string): boolean {
  let pending = false
  for (const line of log.split('\n')) {
    if (!mentionsLogEvent(line, 'permission_request') && !mentionsLogEvent(line, 'permission_resolved')) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (isLogEvent(parsed.type, 'permission_request') && parsed.requestId === requestId) pending = true
    if (isLogEvent(parsed.type, 'permission_resolved') && parsed.requestId === requestId) pending = false
  }
  return pending
}

function formatSSEData(content: string): string {
  return `${content
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n')}\n\n`
}

export function safeEnqueue<T>(
  controller: { enqueue(chunk: T): void },
  isClosed: () => boolean,
  chunk: T,
): void {
  if (isClosed()) return
  try {
    controller.enqueue(chunk)
  } catch {
    // controller was torn down between the guard check and this call
  }
}

function sseHeaders(): HeadersInit {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  }
}

export function createLogStreamResponse(path: string, signal: AbortSignal, secrets: ReadonlyArray<string | null> = [], startOffset?: number): Response {
  const encoder = new TextEncoder()
  const redactor = createSecretsRedactor(secrets)
  let watcher: ReturnType<typeof watch> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let offset = 0
  let closed = false

  function cleanup(): void {
    if (closed) return
    closed = true
    watcher?.close()
    if (heartbeat !== null) clearInterval(heartbeat)
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (content: string): void => {
        const text = redactor.redact(content)
        if (text === '') return
        safeEnqueue(controller, () => closed, encoder.encode(formatSSEData(text)))
      }

      const pushTail = async (): Promise<void> => {
        if (closed) return
        const chunk = await readLogSince(path, offset)
        if (closed || chunk.content === '') return
        offset = chunk.offset
        emit(chunk.content)
      }

      let pushing = Promise.resolve()
      const pushLines = (): Promise<void> => {
        pushing = pushing.then(async () => {
          if (closed) return
          const chunk = await readCompleteLinesSince(path, offset)
          if (closed || chunk.content === '') return
          offset = chunk.offset
          emit(chunk.content)
        }).catch(() => {})
        return pushing
      }

      if (startOffset === undefined) {
        const initial = await readLogTail(path, SSE_TAIL_BYTES)
        offset = initial.offset
        const initialText = redactor.redact(initial.content)
        if (initialText !== '') controller.enqueue(encoder.encode(formatSSEData(initialText)))
      } else {
        offset = startOffset
      }
      const pushUpdates = startOffset === undefined ? pushTail : pushLines

      try {
        watcher = watch(path, { persistent: false }, () => void pushUpdates())
      } catch {
        watcher = null
      }
      await pushUpdates()

      heartbeat = setInterval(() => {
        if (closed) return
        controller.enqueue(encoder.encode(': heartbeat\n\n'))
      }, HEARTBEAT_MS)

      signal.addEventListener('abort', () => {
        cleanup()
        try {
          controller.close()
        } catch {
          // stream already closed by the client disconnecting first
        }
      })
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, { headers: sseHeaders() })
}

type TerminalSessions = { list(): Array<{ id: string; sessionId: string | null }>; ended(): Array<{ id: string; sessionId: string | null }> }
export type JobsRoutesOptions = { attention?: AttentionStore; queue?: ChatQueue; terminals?: TerminalSessions; readLogBytes?: LogBytesReader }

function terminalSessionIds(terminals: TerminalSessions | undefined): Map<string, string> {
  if (!terminals) return new Map()
  return new Map([...terminals.ended(), ...terminals.list()].flatMap((terminal) => (terminal.sessionId ? [[terminal.id, terminal.sessionId] as const] : [])))
}

export function jobsRoutes(manager: JobManager, resolver: EngineResolver, options: JobsRoutesOptions = {}): Elysia {
  const queue = options.queue ?? createChatQueue(chatQueuePath())
  const readLogBytes = options.readLogBytes ?? readWholeLog
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .post('/api/jobs', async ({ body, set }) => {
      const payload = body as (Partial<CreateJobParams> & Record<string, unknown>) | null
      const isChat = payload?.purpose === 'chat'
      if (
        typeof payload?.engine !== 'string' ||
        typeof payload.cwd !== 'string' ||
        typeof payload.prompt !== 'string' ||
        (typeof payload.label !== 'string' && !isChat)
      ) {
        set.status = 400
        return { error: 'engine, cwd, prompt, and label are required' }
      }
      const label = typeof payload.label === 'string' && (payload.label !== '' || !isChat) ? payload.label : chatTitle(payload.prompt)

      const chatRoot = await chatRootFields(payload)
      if (isFailure(chatRoot)) {
        set.status = chatRoot.status
        return { error: chatRoot.error }
      }
      const chatSpawn = chatSpawnFields(payload, manager)
      if (isFailure(chatSpawn)) {
        set.status = chatSpawn.status
        return { error: chatSpawn.error }
      }

      let images: BridgeImage[] = []
      let imageTokens: string[] = []
      if (isChat && chatUsesBridge(payload.engine, 'chat')) {
        const resolved = await resolveChatImages(payload)
        if (isFailure(resolved)) {
          set.status = resolved.status
          return { error: resolved.error }
        }
        images = resolved.images
        imageTokens = resolved.tokens
      }

      const model = typeof payload?.model === 'string' && payload.model !== '' ? payload.model : undefined
      if (model !== undefined && model.length > MAX_MODEL_LENGTH) {
        set.status = 400
        return { error: 'model too long' }
      }

      if (!isChat && payload.engine === (await readRoles()).execute.engine) {
        const misses = lintSpec(payload.prompt)
        if (misses.length > 0) {
          set.status = 422
          return { error: 'spec lint failed: the execute engine only takes an execution plan', misses }
        }
      }

      const result = await manager.createJob(
        {
          engine: payload.engine,
          cwd: payload.cwd,
          prompt: chatPromptWithImages(payload, payload.prompt, images, imageTokens),
          label,
          worktree: payload.worktree === true,
          ...(typeof payload.terminalId === 'string' ? { terminalId: payload.terminalId } : {}),
          ...(model === undefined ? {} : { model }),
          ...(images.length > 0 ? { images } : {}),
          ...chatRoot,
          ...chatSpawn,
          ...(chatRoot.purpose === 'chat' ? await chatMemory(manager, chatRoot.project, '') : {}),
        },
        resolver,
      )
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return result.job
    })
    .get('/api/jobs', async ({ query }) => {
      const chat = typeof query.chat === 'string' && query.chat !== '' ? query.chat : null
      const jobs = chat === null ? manager.listJobs() : manager.listJobs().filter((job) => job.chatId === chat || job.threadRoot === chat)
      const redact = await activityRedactor()
      const sessions = terminalSessionIds(options.terminals)
      return { jobs: jobs.map((job) => { const terminalSessionId = job.terminalId ? sessions.get(job.terminalId) : undefined; return { ...job, prompt: job.prompt.split('\n', 1)[0], currentActivity: redact(manager.currentActivity(job.id)), ...(terminalSessionId ? { terminalSessionId } : {}) } }) }
    })
    .patch('/api/jobs/:id', async ({ params, body, set }) => {
      const root = manager.getJob(params.id)
      if (!isChatRoot(root)) {
        set.status = 404
        return { error: 'chat not found' }
      }
      const payload = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
      const patch = chatPatch(payload, root)
      if (isFailure(patch)) {
        set.status = patch.status
        return { error: patch.error }
      }
      if (payload.deleted === true && threadIsRunning(threadChain(manager.listJobs(), root.id))) {
        set.status = 409
        return { error: 'Stop the reply first' }
      }
      if (payload.project === null) patch.project = null
      else if (payload.project !== undefined) {
        const project = typeof payload.project === 'string' ? await projectInChatHome(payload.project, root) : { status: 400, error: 'project must be a path' }
        if (isFailure(project)) {
          set.status = project.status
          return { error: project.error }
        }
        patch.project = project
      }
      return await manager.updateJob(root.id, patch)
    })
    .get('/api/jobs/:id/activity', async ({ params, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      const events = parseActivity(await readRedactedLog(manager.logPath(params.id)), ACTIVITY_FEED_MAX)
      return { status: job.status, currentActivity: (await activityRedactor())(manager.currentActivity(params.id)), events }
    })
    .get('/api/jobs/:id/log', async ({ params, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      const content = await readRedactedLog(manager.logPath(params.id))
      return new Response(content, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    })
    .get('/api/jobs/:id/stream', async ({ params, query, set, request }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      const path = manager.logPath(params.id)
      if (query.offset !== undefined) {
        const offset = Number(query.offset)
        const info = await stat(path).catch(() => null)
        if (!Number.isInteger(offset) || offset < 0 || info === null || offset > info.size) {
          set.status = 400
          return { error: 'offset must be an integer within the log' }
        }
        return createLogStreamResponse(path, request.signal, await logSecrets(), offset)
      }
      return createLogStreamResponse(path, request.signal, await logSecrets())
    })
    .get('/api/jobs/:id/thread', async ({ params, query, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined || job.deletedAt !== undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      const rootId = threadRootOf(job)
      const threadHead = manager.getJob(rootId)
      const isChat = job.purpose === 'chat' || threadHead?.purpose === 'chat'
      const tree = isChat ? buildTurnTree(rootId, manager.listJobs()) : null
      const leaf = tree === null ? null : activeLeaf(tree, query.leaf) ?? newestLeaf(tree)
      const chain = tree !== null && leaf !== null ? tree.pathToLeaf(leaf) : threadChain(manager.listJobs(), rootId)
      const logSize = (await stat(manager.logPath(job.id)).catch(() => null))?.size ?? 0
      const snapshot = isChat && chatUsesBridge(job.engine, 'chat') ? await liveSnapshot(chain, manager, readLogBytes) : null
      const messages = await assembleThread(chain, (jobId) => (snapshot !== null && jobId === snapshot.live.jobId ? Promise.resolve(snapshot.log) : readRedactedLog(manager.logPath(jobId))))
      const pathSession = tree !== null && leaf !== null ? nearestSessionId(tree, leaf) : replySessionId(chain)
      return {
        rootId,
        engine: job.engine,
        running: threadIsRunning(chain),
        sessionId: pathSession,
        canReply: !job.workflowRunId && job.purpose !== 'workflow-design' && (job.resumeSupported ?? engineSupportsResume(job.engine)) && pathSession !== null,
        messages,
        logSize,
        ...(tree !== null ? { versions: tree.versions, branchPoints: tree.branchPoints, leaf: leaf === null ? null : leaf } : {}),
        ...(isChat && chatUsesBridge(job.engine, 'chat') ? { live: snapshot?.live ?? null } : {}),
        ...(isChat ? { usage: await chatUsage(chain, manager, threadHead?.engine ?? job.engine) } : {}),
      }
    })
    .post('/api/jobs/:id/reply', async ({ params, body, set }) => {
      const payload = body as { message?: unknown } | null
      const message = typeof payload?.message === 'string' ? payload.message.trim() : ''
      if (message === '') {
        set.status = 400
        return { error: 'message is required' }
      }

      const parent = manager.getJob(params.id)
      if (parent === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      if (parent.workflowRunId || parent.purpose === 'workflow-design') {
        set.status = 409
        return { error: 'Use Studio to retry this workflow step with its pinned instructions' }
      }
      if (!(parent.resumeSupported ?? engineSupportsResume(parent.engine))) {
        set.status = 400
        return { error: 'engine does not support conversation resume' }
      }

      const rootId = threadRootOf(parent)
      const chain = threadChain(manager.listJobs(), rootId)

      const threadHead = manager.getJob(rootId)
      const isChat = parent.purpose === 'chat' || threadHead?.purpose === 'chat'
      if (isChat && threadIsRunning(chain)) {
        const branching = (body as { from?: unknown } | null)?.from
        if (branching !== undefined) {
          set.status = 409
          return { error: 'Wait for the reply to finish' }
        }
        const item = await queue.add(rootId, message)
        set.status = 202
        return { queued: true, item }
      }
      const tree = isChat ? buildTurnTree(rootId, manager.listJobs()) : null
      const placement = tree === null ? { prevTurnId: undefined, versionOf: undefined, branchFrom: undefined, rootless: undefined } as Placement : placeReply(tree, body as Record<string, unknown>)
      if (isFailure(placement)) {
        set.status = placement.status
        return { error: placement.error }
      }
      const resume = tree === null ? { sessionId: replySessionId(chain) } : await resumeForPlacement(manager, tree, placement)
      if (isFailure(resume)) {
        set.status = resume.status
        return { error: resume.error }
      }
      const sessionId = resume.sessionId
      if (sessionId === null && placement.rootless !== true) {
        set.status = 400
        return { error: 'job has no session id to resume yet' }
      }
      const chatRoot = isChat ? threadHead : undefined
      let replyImages: BridgeImage[] = []
      let replyTokens: string[] = []
      if (isChat && chatUsesBridge(parent.engine, 'chat')) {
        const resolved = await resolveChatImages(body as Record<string, unknown>)
        if (isFailure(resolved)) {
          set.status = resolved.status
          return { error: resolved.error }
        }
        replyImages = resolved.images
        replyTokens = resolved.tokens
      }
      const newest = chain[chain.length - 1]
      const payloadModel = typeof (body as { model?: unknown } | null)?.model === 'string' ? String((body as { model: string }).model).trim() : ''
      if (payloadModel.length > MAX_MODEL_LENGTH) {
        set.status = 400
        return { error: 'model too long' }
      }
      const payloadMode = (body as { permissionMode?: unknown } | null)?.permissionMode
      if (payloadMode !== undefined && !CHAT_PERMISSION_MODES.includes(payloadMode as ChatPermissionMode)) {
        set.status = 400
        return { error: 'permissionMode must be one of settings, ask, acceptEdits, plan or bypass' }
      }
      const model = payloadModel !== '' ? payloadModel : newest?.model ?? parent.model
      const permissionMode = isChat ? ((payloadMode as ChatPermissionMode | undefined) ?? newest?.permissionMode ?? 'settings') : (payloadMode as ChatPermissionMode | undefined)
      const memory = isChat ? await chatMemory(manager, chatRoot?.project, rootId) : {}
      const earlier = isChat ? await queue.take(rootId) : []
      const created = manager.createJob(
        {
          ...(isChat ? {
            purpose: 'chat' as const,
            edit: chatRoot?.edit ?? parent.edit ?? false,
            project: chatRoot?.project ?? null,
            ...memory,
          } : {}),
          engine: parent.engine,
          cwd: parent.cwd,
          prompt: replyImages.length > 0 ? stripImageTokens([...earlier.map((item) => item.text), message].join('\n\n'), replyTokens) : [...earlier.map((item) => item.text), message].join('\n\n'),
          label: parent.label,
          parentJobId: parent.id,
          threadRoot: rootId,
          resumeSessionId: sessionId,
          ...(placement.prevTurnId === undefined ? {} : { prevTurnId: placement.prevTurnId }),
          ...(placement.versionOf === undefined ? {} : { versionOf: placement.versionOf }),
          ...(placement.branchFrom === undefined ? {} : { branchFrom: placement.branchFrom }),
          ...(resume.forkSession === true ? { forkSession: true } : {}),
          ...(resume.resumeSessionAt === undefined ? {} : { resumeSessionAt: resume.resumeSessionAt }),
          ...(parent.terminalId === null ? {} : { terminalId: parent.terminalId }),
          ...(model === null || model === undefined || model === '' ? {} : { model }),
          ...(permissionMode === undefined || permissionMode === null ? {} : { permissionMode }),
          ...(replyImages.length > 0 ? { images: replyImages } : {}),
          ...(parent.chatId ? { chatId: parent.chatId } : {}),
          ...(parent.chatTurn ? { chatTurn: parent.chatTurn } : {}),
          ...(parent.reason ? { reason: parent.reason } : {}),
        },
        resolver,
      )
      const result = await created.catch(async (error: unknown) => {
        await queue.restore(rootId, earlier)
        throw error
      })
      if (!result.ok) {
        await queue.restore(rootId, earlier)
        set.status = result.status
        return { error: result.error }
      }
      return result.job
    })
    .get('/api/jobs/:id/images/:n', async ({ params, set }) => {
      const job = manager.getJob(params.id)
      const index = Number(params.n)
      const image = job?.images?.[index]
      if (job === undefined || !Number.isInteger(index) || index < 0 || image === undefined) {
        set.status = 404
        return { error: 'image not found' }
      }
      const file = Bun.file(image.path)
      if (!(await file.exists())) {
        set.status = 404
        return { error: 'image not found' }
      }
      return new Response(file, { headers: { 'content-type': image.mediaType, 'cache-control': 'no-store' } })
    })
    .get('/api/jobs/:id/commands', async ({ params, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      let commands: Array<{ name: string; description: string; argumentHint: string }> = []
      for (const turn of threadChain(manager.listJobs(), threadRootOf(job))) {
        const log = await readRedactedLog(manager.logPath(turn.id))
        for (const line of log.split('\n')) {
          if (!mentionsLogEvent(line, 'commands')) continue
          try {
            const parsed = JSON.parse(line) as { type?: string; commands?: unknown }
            if (isLogEvent(parsed.type, 'commands') && Array.isArray(parsed.commands)) {
              commands = parsed.commands.filter((command): command is { name: string; description: string; argumentHint: string } => {
                const candidate = command as { name?: unknown; description?: unknown; argumentHint?: unknown }
                return typeof candidate.name === 'string' && candidate.name !== '' && typeof candidate.description === 'string' && typeof candidate.argumentHint === 'string'
              })
            }
          } catch {
            // a torn line mid-write is skipped
          }
        }
      }
      return { commands }
    })
    .get('/api/jobs/:id/export.md', async ({ params, query, set }) => {
      const root = manager.getJob(params.id)
      if (!isChatRoot(root) || root.deletedAt !== undefined) {
        set.status = 404
        return { error: 'chat not found' }
      }
      const tree = buildTurnTree(root.id, manager.listJobs())
      const requested = typeof query.leaf === 'string' && query.leaf !== '' ? query.leaf : null
      const leaf = requested === null ? newestLeaf(tree) : activeLeaf(tree, requested)
      if (requested !== null && leaf === null) {
        set.status = 404
        return { error: 'turn not found' }
      }
      const parts: string[] = [`# ${root.label}`, '']
      for (const turn of leaf === null ? [] : tree.pathToLeaf(leaf)) {
        parts.push('## You', '', turn.prompt, '')
        const log = await readRedactedLog(manager.logPath(turn.id))
        const events = parseThread(log)
        const assistant: string[] = []
        for (const event of events) {
          if (event.kind === 'text' && event.detail.trim() !== '') assistant.push(event.detail.trim())
          else if (event.kind === 'tool') assistant.push(`- ${event.title} ${oneLine(event.detail, 160)}`)
        }
        if (assistant.length > 0) parts.push('## Assistant', '', assistant.join('\n\n'), '')
      }
      const slug = root.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
      return new Response(`${parts.join('\n').trimEnd()}\n`, {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${slug === '' ? 'chat' : slug}.md"`,
        },
      })
    })
    .post('/api/jobs/:id/undo', async ({ params, body, set }) => {
      const toolUseId = typeof (body as { toolUseId?: unknown } | null)?.toolUseId === 'string' ? String((body as { toolUseId: string }).toolUseId) : ''
      if (toolUseId === '') {
        set.status = 400
        return { error: 'toolUseId is required' }
      }
      const turn = manager.getJob(params.id)
      if (turn === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      const rootId = threadRootOf(turn)
      const root = manager.getJob(rootId)
      if (turn.purpose !== 'chat' && root?.purpose !== 'chat') {
        set.status = 409
        return { error: 'Only a chat edit can be undone' }
      }
      if (threadIsRunning(threadChain(manager.listJobs(), rootId))) {
        set.status = 409
        return { error: 'Wait for the reply to finish' }
      }
      return await serializeTurnUndo(turn.id, async () => {
        if ((manager.getJob(turn.id)?.undone ?? []).includes(toolUseId)) {
          set.status = 409
          return { error: UNDO_ALREADY }
        }
        const call = findEditCall(await readRedactedLog(manager.logPath(turn.id)), toolUseId)
        if (call === null || (call.name !== 'Edit' && call.name !== 'MultiEdit') || call.resultIsError) {
          set.status = 409
          return { error: 'Only a successful Edit or MultiEdit call can be undone' }
        }
        const filePath = typeof call.input.file_path === 'string' && call.input.file_path !== '' ? call.input.file_path : ''
        if (filePath === '') {
          set.status = 409
          return { error: UNDO_UNSUPPORTED }
        }
        const absolute = resolve(turn.cwd, filePath)
        let realFile: string
        let realCwd: string
        try {
          realFile = await realpath(absolute)
          realCwd = await realpath(turn.cwd)
        } catch {
          set.status = 409
          return { error: UNDO_CHANGED }
        }
        if (realFile !== realCwd && !realFile.startsWith(`${realCwd}/`)) {
          set.status = 403
          return { error: 'This edit is outside the chat folder' }
        }
        const outcome = undoEditContent(await readFile(realFile, 'utf8'), call.name, call.input)
        if ('error' in outcome) {
          set.status = outcome.status
          return { error: outcome.error }
        }
        await writeFile(realFile, outcome.content)
        await manager.updateJob(turn.id, { undone: [...(manager.getJob(turn.id)?.undone ?? []), toolUseId] })
        return { ok: true }
      })
    })
    .get('/api/jobs/:id/queue', ({ params, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      return { items: queue.list(threadRootOf(job)) }
    })
    .delete('/api/jobs/:id/queue/:itemId', async ({ params, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined || !(await queue.remove(threadRootOf(job), params.itemId))) {
        set.status = 404
        return { error: 'queued message not found' }
      }
      return { ok: true }
    })
    .post('/api/jobs/:id/land', async ({ params, set }) => {
      const result = await manager.landJob(params.id)
      if (!result.ok) {
        set.status = result.status
        return { error: result.error, ...(result.files === undefined ? {} : { files: result.files }) }
      }
      const landed = await manager.updateJob(params.id, { landedAt: Date.now() })
      if (landed?.chatId) await options.attention?.resolve(attentionKey.needs(landed.chatId))
      return { landed: result.landed, base: result.base }
    })
    .post('/api/jobs/:id/reviewed', async ({ params, set }) => {
      const result = await manager.markReviewed(params.id)
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return result.job
    })
    .post('/api/jobs/:id/permission', async ({ params, body, set }) => {
      const payload = body as { requestId?: unknown; decision?: unknown } | null
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
      const decision = payload?.decision
      if (requestId === '' || (decision !== 'allow_once' && decision !== 'allow_always' && decision !== 'deny')) {
        set.status = 400
        return { error: 'requestId and a decision of allow_once, allow_always or deny are required' }
      }
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      const log = await readRedactedLog(manager.logPath(params.id))
      if (job.status !== 'running' || !logHasPendingPermission(log, requestId) || !manager.sendControl(params.id, { type: 'permission', requestId, decision })) {
        set.status = 409
        return { error: 'This reply is no longer waiting' }
      }
      await options.attention?.resolve(attentionKey.permission(params.id, requestId))
      return { ok: true }
    })
    .post('/api/jobs/:id/kill', async ({ params, set }) => {
      const result = await manager.killJob(params.id)
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return { ok: true }
    })
}
