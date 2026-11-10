import { appendFile, chmod, mkdir, readFile, stat } from 'node:fs/promises'
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  ACTIVITY_THROTTLE_MS,
  createActivityThrottle,
  currentActivity,
  parseActivity,
  parseJobProgress,
  parseSessionId,
  reportedJobOutcome,
} from './activity'
import { DIR_MODE, FILE_MODE, configDir, listenTarget, readApiToken } from './secrets'
import { chatRules } from './chat-profile'
import { isOwnClaudeChild, readProcessInfo, type ProcessInfoReader } from './process-info'
import { workspaceDiffStat, workspaceRepos } from './repo-workspace'
import { validateWorkspaceCwd } from './workspace'
import { git, prepareWorktree, worktreeBranch } from './job-worktrees'
import type { EngineResolver, EngineResolverParams, EngineSpawn } from './jobs-engine-iface'
import { exportEnv } from './env'
import { isLogEvent, mentionsLogEvent } from './log-events'

export const JOBS_FILE = 'jobs.jsonl'
export const LOGS_DIR = 'logs'
export const KILL_ESCALATION_MS = 5_000
export const LOG_TAIL_POLL_MS = 150
export const ADOPT_POLL_MS = 2_000
export const MIN_REDACTED_SECRET_LENGTH = 8
export const ACTIVITY_TAIL_CHARS = 16_384
export const SESSION_SCAN_MAX_CHARS = 65_536

const REDACTED_PLACEHOLDER = '[REDACTED]'

export type JobStatus = 'running' | 'done' | 'failed'

export type JobRecord = {
  id: string
  engine: string
  cwd: string
  worktree: string | null
  baseRepo: string | null
  baseBranch: string | null
  label: string
  prompt: string
  pid: number
  status: JobStatus
  startedAt: number
  turns: number
  subAgents?: number
  slowAt: number | null
  lastTool: string | null
  endedAt: number | null
  exitCode: number | null
  diffStat: string | null
  reviewedAt: number | null
  sessionId: string | null
  parentJobId: string | null
  threadRoot: string
  terminalId: string | null
  reviewOf: string | null
  model: string | null
  workflowRunId?: string
  workflowNodeId?: string
  workflowAttempt?: number
  purpose?: JobPurpose
  resumeSupported?: boolean
  chatId?: string
  chatTurn?: string
  reason?: string
  project?: string | null
  titleLocked?: boolean
  source?: 'user' | 'agent'
  edit?: boolean
  stoppedAt?: number
  landedAt?: number
  reportedAt?: number | null
  images?: import('./chat-bridge-core').BridgeImage[]
  permissionMode?: import('./chat-bridge-core').ChatPermissionMode
  allowRules?: string[]
  pinned?: boolean
  deletedAt?: number
  undone?: string[]
  prevTurnId?: string | null
  versionOf?: string
  branchFrom?: string
}

export type JobPurpose = 'workflow-design' | 'chat'

export type ChatJobPatch = Partial<Pick<JobRecord, 'label' | 'project' | 'titleLocked' | 'landedAt' | 'stoppedAt' | 'reportedAt' | 'allowRules' | 'pinned' | 'deletedAt' | 'undone'>>

export type CreateJobParams = {
  worktree?: boolean
  baseRepo?: string
  engine: string
  cwd: string
  prompt: string
  label: string
  parentJobId?: string
  threadRoot?: string
  resumeSessionId?: string
  terminalId?: string
  reviewOf?: string
  model?: string
  workflowRunId?: string
  workflowNodeId?: string
  workflowAttempt?: number
  connection?: import('./agent-connections').AgentConnection
  coreRules?: string
  mcpServers?: import('./workflows').WorkflowNode['mcpServers']
  disallowedTools?: string[]
  toolless?: true
  purpose?: JobPurpose
  chatId?: string
  chatTurn?: string
  reason?: string
  project?: string | null
  source?: 'user' | 'agent'
  edit?: boolean
  memory?: string
  images?: import('./chat-bridge-core').BridgeImage[]
  permissionMode?: import('./chat-bridge-core').ChatPermissionMode
  forkSession?: boolean
  resumeSessionAt?: string
  prevTurnId?: string | null
  versionOf?: string
  branchFrom?: string
}

export const CHAT_STEP_ATTEMPTS = 3

export type CreateJobResult =
  | { ok: true; job: JobRecord }
  | { ok: false; status: number; error: string }

export type KillJobResult = { ok: true } | { ok: false; status: number; error: string }

export type MarkReviewedResult =
  | { ok: true; job: JobRecord }
  | { ok: false; status: number; error: string }

export type LandJobResult =
  | { ok: true; landed: string[]; base: string }
  | { ok: false; status: number; error: string; files?: string[] }

export type JobManager = {
  claimWorkspace(cwd: string, owner: string): boolean
  releaseWorkspace(cwd: string, owner: string): void
  landJob(id: string): Promise<LandJobResult>
  createJob(params: CreateJobParams, resolver: EngineResolver): Promise<CreateJobResult>
  killJob(id: string): Promise<KillJobResult>
  sendControl(id: string, line: object): boolean
  markReviewed(id: string, at?: number): Promise<MarkReviewedResult>
  updateJob(id: string, patch: ChatJobPatch): Promise<JobRecord | undefined>
  listJobs(): JobRecord[]
  getJob(id: string): JobRecord | undefined
  currentActivity(id: string): string | null
  logPath(id: string): string
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

export function normalizeJobRecord(raw: Record<string, unknown>): JobRecord {
  const id = readString(raw.id, '')
  return {
    ...(raw as unknown as JobRecord),
    turns: typeof raw.turns === 'number' && Number.isSafeInteger(raw.turns) && raw.turns >= 0 ? raw.turns : 0,
    slowAt: typeof raw.slowAt === 'number' && Number.isFinite(raw.slowAt) ? raw.slowAt : null,
    lastTool: typeof raw.lastTool === 'string' && raw.lastTool !== '' ? raw.lastTool : null,
    reviewedAt: typeof raw.reviewedAt === 'number' ? raw.reviewedAt : null,
    prompt: readString(raw.prompt, ''),
    worktree: readString(raw.worktree, '') || null,
    baseRepo: readString(raw.baseRepo, '') || null,
    baseBranch: readString(raw.baseBranch, '') || null,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null,
    parentJobId: typeof raw.parentJobId === 'string' && raw.parentJobId !== '' ? raw.parentJobId : null,
    threadRoot: readString(raw.threadRoot, '') === '' ? id : readString(raw.threadRoot, id),
    terminalId: typeof raw.terminalId === 'string' && raw.terminalId !== '' ? raw.terminalId : null,
    reviewOf: typeof raw.reviewOf === 'string' && raw.reviewOf !== '' ? raw.reviewOf : null,
    model: typeof raw.model === 'string' && raw.model !== '' ? raw.model : null,
  }
}

function loadJobs(path: string): { jobs: Map<string, JobRecord>; lineCount: number } {
  const jobs = new Map<string, JobRecord>()
  let lineCount = 0
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { jobs, lineCount }
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    lineCount++
    try {
      const record = normalizeJobRecord(JSON.parse(trimmed) as Record<string, unknown>)
      jobs.set(record.id, record)
    } catch {
      continue
    }
  }
  return { jobs, lineCount }
}

function compactJobs(path: string, jobs: Map<string, JobRecord>, lineCount: number): number {
  const temporaryPath = `${path}.tmp`
  const content = [...jobs.values()].map((record) => `${JSON.stringify(record)}\n`).join('')
  writeFileSync(temporaryPath, content, { mode: FILE_MODE })
  chmodSync(temporaryPath, FILE_MODE)
  renameSync(temporaryPath, path)
  console.log(`jobs: compacted ${lineCount} lines → ${jobs.size}`)
  return jobs.size
}

async function appendJsonl(path: string, record: JobRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: FILE_MODE })
  await chmod(path, FILE_MODE)
}

function ensureDirsSync(dir: string, logsDir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  chmodSync(dir, DIR_MODE)
  mkdirSync(logsDir, { recursive: true, mode: DIR_MODE })
  chmodSync(logsDir, DIR_MODE)
}

export type { CwdCheck } from './workspace'
export { validateWorkspaceCwd as validateJobCwd } from './workspace'

async function workspaceDiffStatOf(cwd: string): Promise<string | null> {
  const repos = await workspaceRepos(cwd)
  return repos === null ? null : workspaceDiffStat(cwd, repos).catch(() => null)
}

export async function captureDiffStat(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', '-C', cwd, 'diff', '--stat', 'HEAD'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const [output, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    if (exitCode !== 0) return workspaceDiffStatOf(cwd)
    const trimmed = output.trim()
    return trimmed === '' ? null : trimmed
  } catch {
    return null
  }
}

export type LogRedactor = {
  redact(chunk: string): string
  flush(): string
}

// The longest suffix of `text` that is also a prefix of `secret` (capped at maxLen) — the
// part of `text` that could still grow into a full match once more input arrives.
function suffixPrefixOverlap(text: string, secret: string, maxLen: number): number {
  const upper = Math.min(maxLen, text.length)
  for (let len = upper; len > 0; len--) {
    if (text.endsWith(secret.slice(0, len))) return len
  }
  return 0
}

// Holds back only the trailing chars of unprocessed input that could still be the start of
// a secret continuing into the next chunk, so a secret split across two writes is still
// matched once the next chunk arrives.
export function createLogRedactor(secret: string | null): LogRedactor {
  if (secret === null || secret.length < MIN_REDACTED_SECRET_LENGTH) {
    return { redact: (chunk) => chunk, flush: () => '' }
  }
  const holdBack = secret.length - 1
  let carry = ''

  return {
    redact(chunk: string): string {
      const combined = carry + chunk
      const replaced = combined.split(secret).join(REDACTED_PLACEHOLDER)
      const overlap = suffixPrefixOverlap(combined, secret, holdBack)
      if (overlap === 0) {
        carry = ''
        return replaced
      }
      carry = combined.slice(combined.length - overlap)
      return replaced.slice(0, replaced.length - overlap)
    },
    flush(): string {
      const remaining = carry
      carry = ''
      return remaining
    },
  }
}

export function redactSecrets(content: string, secret: string | null): string {
  const redactor = createLogRedactor(secret)
  return redactor.redact(content) + redactor.flush()
}

export type JobManagerOptions = {
  home?: string
  activityIntervalMs?: number
  now?: () => number
  onJobSlow?: (record: JobRecord) => void
  onJobSettled?: (record: JobRecord) => void
  onJobStarted?: (record: JobRecord) => void
  onJobProgress?: (record: JobRecord) => void
  onPermissionRequest?: (record: JobRecord, request: { requestId: string; title: string; body: string }) => void
  processInfo?: ProcessInfoReader
}

export function createJobManager(options: JobManagerOptions = {}): JobManager {
  const dir = configDir()
  const jsonlPath = join(dir, JOBS_FILE)
  const logsDir = join(dir, LOGS_DIR)
  let { jobs, lineCount } = loadJobs(jsonlPath)
  if (lineCount > jobs.size) lineCount = compactJobs(jsonlPath, jobs, lineCount)
  const persistedJobs = new Map(jobs)
  const creationOrder = new Map([...jobs.keys()].map((id, index) => [id, index]))
  const createdAs = (id: string): number => creationOrder.get(id) ?? -1
  const home = options.home
  const activityIntervalMs = options.activityIntervalMs ?? ACTIVITY_THROTTLE_MS
  const clock = options.now ?? Date.now
  const processInfo = options.processInfo ?? readProcessInfo
  let persistence = Promise.resolve()
  const processes = new Map<string, Bun.Subprocess>()
  const controls = new Map<string, Bun.FileSink>()
  const workspaceOwners = new Map([...jobs.values()].filter(job => job.status === 'running' && job.workflowRunId).map(job => [job.cwd, job.workflowRunId!]))
  const activities = new Map<string, string>()
  const tails = new Map<string, string>()
  const sessionScans = new Map<string, string>()
  const pendingActivityTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const subAgentCalls = new Map<string, Set<string>>()
  const notifiedPermissions = new Set<string>()

  function notifyPendingPermissions(id: string, chunk: string): void {
    const record = jobs.get(id)
    if (record === undefined || options.onPermissionRequest === undefined) return
    for (const line of chunk.split('\n')) {
      if (!mentionsLogEvent(line, 'permission_request')) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (!isLogEvent(parsed.type, 'permission_request') || typeof parsed.requestId !== 'string' || parsed.requestId === '') continue
      const key = `${id}:${parsed.requestId}`
      if (notifiedPermissions.has(key)) continue
      notifiedPermissions.add(key)
      const input = typeof parsed.input === 'object' && parsed.input !== null ? (parsed.input as Record<string, unknown>) : {}
      const body = typeof input.command === 'string' && input.command !== ''
        ? input.command
        : typeof input.file_path === 'string' && input.file_path !== ''
          ? input.file_path
          : typeof parsed.toolName === 'string'
            ? parsed.toolName
            : ''
      options.onPermissionRequest(record, { requestId: parsed.requestId, title: typeof parsed.title === 'string' && parsed.title !== '' ? parsed.title : 'Permission needed', body })
    }
  }

  function logPath(id: string): string {
    return join(logsDir, `${id}.log`)
  }

  function refreshActivity(id: string): void {
    const line = currentActivity(parseActivity(tails.get(id) ?? ''))
    if (line !== null) activities.set(id, line)
  }

  // The activity tail drops the head of a long log, but the session id is in the first line —
  // so it gets its own bounded head buffer, dropped as soon as an id is found.
  function scanSessionId(id: string, text: string): void {
    const pending = sessionScans.get(id)
    if (pending === undefined) return
    const combined = pending + text
    const found = parseSessionId(combined)
    if (found === null) {
      if (combined.length > SESSION_SCAN_MAX_CHARS) sessionScans.delete(id)
      else sessionScans.set(id, combined)
      return
    }
    sessionScans.delete(id)
    const record = jobs.get(id)
    if (record === undefined || record.sessionId === found) return
    const capability = combined.split('\n').flatMap(line => { try { const value = JSON.parse(line); return value?.type === 'system' && typeof value.resumeSupported === 'boolean' ? [value.resumeSupported] : [] } catch { return [] } }).at(-1)
    void persist({ ...record, sessionId: found, ...(capability === undefined ? {} : { resumeSupported: capability }) }).catch(() => {})
  }

  function clearPendingActivityTimer(id: string): void {
    const pending = pendingActivityTimers.get(id)
    if (pending === undefined) return
    clearTimeout(pending)
    pendingActivityTimers.delete(id)
  }

  // A throttled chunk still holds the newest activity line — it just can't be shown yet — so a
  // single coalesced timer revisits it once the throttle window passes, even if no further chunk
  // ever arrives (a long tool call with no interim output would otherwise leave the ticker stale).
  function scheduleTrailingRefresh(id: string, throttle: ReturnType<typeof createActivityThrottle>): void {
    if (pendingActivityTimers.has(id)) return
    const timer = setTimeout(() => {
      pendingActivityTimers.delete(id)
      refreshActivity(id)
    }, throttle.remainingMs())
    pendingActivityTimers.set(id, timer)
  }

  function collectActivity(id: string, throttle: ReturnType<typeof createActivityThrottle>) {
    let pending = ''
    let turns = 0
    return (text: string): void => {
      pending += text
      const end = pending.lastIndexOf('\n')
      if (end >= 0) {
        const progress = parseJobProgress(pending.slice(0, end))
        notifyPendingPermissions(id, pending.slice(0, end))
        pending = pending.slice(end + 1)
        turns += progress.turns
        const calls = subAgentCalls.get(id) ?? subAgentCalls.set(id, new Set()).get(id)!
        for (const callId of progress.subAgentIds) calls.add(callId)
        const record = jobs.get(id)
        if (record !== undefined) {
          const nextTurns = Math.max(record.turns, turns)
          const lastTool = progress.lastTool ?? record.lastTool
          const subAgents = Math.max(record.subAgents ?? 0, calls.size)
          const subAgentsChanged = subAgents !== (record.subAgents ?? 0)
          if (nextTurns !== record.turns || lastTool !== record.lastTool || subAgentsChanged) {
            const next = { ...record, turns: nextTurns, lastTool, ...(subAgents > 0 ? { subAgents } : {}) }
            void persist(next).catch(() => {})
            if (subAgentsChanged) options.onJobProgress?.(next)
          }
        }
      }
      scanSessionId(id, text)
      const combined = (tails.get(id) ?? '') + text
      tails.set(id, combined.slice(Math.max(0, combined.length - ACTIVITY_TAIL_CHARS)))
      if (throttle.ready()) {
        refreshActivity(id)
        return
      }
      scheduleTrailingRefresh(id, throttle)
    }
  }

  async function persist(record: JobRecord): Promise<void> {
    if (!creationOrder.has(record.id)) creationOrder.set(record.id, creationOrder.size)
    jobs.set(record.id, record)
    const write = persistence.then(async () => {
      await appendJsonl(jsonlPath, record)
      persistedJobs.set(record.id, record)
      lineCount++
      if (lineCount > 5000) lineCount = compactJobs(jsonlPath, persistedJobs, lineCount)
    })
    persistence = write.catch(() => {})
    await write
  }

  async function checkSlowJob(id: string): Promise<void> {
    const record = jobs.get(id)
    if (record === undefined || record.status !== 'running' || record.slowAt !== null) return
    const now = clock()
    if (record.turns <= 80 && now - record.startedAt <= 15 * 60_000) return
    const slow = { ...record, slowAt: now }
    await persist(slow)
    options.onJobSlow?.(slow)
  }

  async function settleFailed(id: string, record: JobRecord): Promise<void> {
    processes.delete(id)
    closeControl(id)
    subAgentCalls.delete(id)
    clearPendingActivityTimer(id)
    await persist({
      ...(jobs.get(id) ?? record),
      status: 'failed',
      endedAt: Date.now(),
      exitCode: null,
      diffStat: null,
    })
  }

  function closeControl(id: string): void {
    const sink = controls.get(id)
    if (sink === undefined) return
    controls.delete(id)
    try {
      sink.end()
    } catch {
      // bridge already closed its stdin
    }
  }

  function sendControl(id: string, line: object): boolean {
    const sink = controls.get(id)
    const proc = processes.get(id)
    if (sink === undefined || proc === undefined || proc.exitCode !== null) return false
    try {
      sink.write(`${JSON.stringify(line)}\n`)
      sink.flush()
      return true
    } catch {
      return false
    }
  }

  async function logChildren(id: string): Promise<Array<{ pid: number; startedAt: number | null }>> {
    const log = await readLogFile(logPath(id))
    const children: Array<{ pid: number; startedAt: number | null }> = []
    for (const line of log.split('\n')) {
      if (!mentionsLogEvent(line, 'child')) continue
      try {
        const parsed = JSON.parse(line) as { type?: string; pid?: unknown; startedAt?: unknown }
        if (isLogEvent(parsed.type, 'child') && typeof parsed.pid === 'number' && parsed.pid > 0) {
          children.push({ pid: parsed.pid, startedAt: typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt) ? parsed.startedAt : null })
        }
      } catch {
        // a torn line mid-write is skipped
      }
    }
    return children
  }

  // A logged pid may have been reused by an unrelated process since (e.g. after a reboot).
  async function ownLiveChildPids(id: string): Promise<number[]> {
    const jobStartedAt = jobs.get(id)?.startedAt ?? 0
    const pids: number[] = []
    for (const child of await logChildren(id)) {
      if (!pidAlive(child.pid)) continue
      if (!isOwnClaudeChild(await processInfo(child.pid), child.startedAt ?? jobStartedAt)) continue
      pids.push(child.pid)
    }
    return pids
  }

  function signalPids(pids: readonly number[], signal: 'SIGTERM' | 'SIGKILL'): void {
    for (const pid of pids) {
      if (!pidAlive(pid)) continue
      try {
        process.kill(pid, signal)
      } catch {
        // already gone
      }
    }
  }

  async function signalChildren(id: string, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    signalPids(await ownLiveChildPids(id), signal)
  }

  // The escalation must not depend on the bridge surviving: the CLI child is killed from the log too.
  function killOrphanChildren(id: string): void {
    void (async () => {
      const alive = await ownLiveChildPids(id)
      if (alive.length === 0) return
      signalPids(alive, 'SIGTERM')
      setTimeout(() => signalPids(alive, 'SIGKILL'), KILL_ESCALATION_MS)
    })().catch(() => {})
  }

  async function mergeChatAllowRules(record: JobRecord): Promise<void> {
    if (record.purpose !== 'chat') return
    const root = jobs.get(record.threadRoot === '' ? record.id : record.threadRoot)
    if (root === undefined) return
    const log = await readLogFile(logPath(record.id))
    const found: string[] = []
    for (const line of log.split('\n')) {
      if (!mentionsLogEvent(line, 'permission_resolved')) continue
      try {
        const parsed = JSON.parse(line) as { type?: string; decision?: unknown; rules?: unknown }
        if (isLogEvent(parsed.type, 'permission_resolved') && parsed.decision === 'allow_always' && Array.isArray(parsed.rules)) {
          for (const rule of parsed.rules) if (typeof rule === 'string' && rule !== '') found.push(rule)
        }
      } catch {
        // a torn line mid-write is skipped
      }
    }
    if (found.length === 0) return
    const merged = [...new Set([...(root.allowRules ?? []), ...found])].slice(0, 200)
    if (merged.length === (root.allowRules ?? []).length) return
    await persist({ ...root, allowRules: merged })
  }

  // Children write straight to the log file (no pipes), so they survive a server restart;
  // activity comes from tailing that file instead of pumping stdio.
  function startLogTail(id: string, collect: (text: string) => void, startOffset = 0): () => Promise<void> {
    const path = logPath(id)
    let offset = startOffset
    let active: Promise<void> | null = null
    const read = async (): Promise<void> => {
      try {
        const chunk = await readLogSince(path, offset)
        if (chunk.content !== '') {
          offset = chunk.offset
          collect(chunk.content)
        }
        await checkSlowJob(id)
      } catch {
        // log file may not exist yet; the next tick retries
      }
    }
    const tick = (): Promise<void> => {
      if (active !== null) return active
      active = read().finally(() => { active = null })
      return active
    }
    const timer = setInterval(() => void tick(), LOG_TAIL_POLL_MS)
    return async () => {
      clearInterval(timer)
      await active
      await tick()
      collect('\n')
    }
  }

  async function settleJob(id: string, record: JobRecord, exitCode: number | null, status: JobStatus): Promise<void> {
    const current = jobs.get(id) ?? record
    if (current.status !== 'running') return
    processes.delete(id)
    closeControl(id)
    sessionScans.delete(id)
    subAgentCalls.delete(id)
    clearPendingActivityTimer(id)
    tails.delete(id)
    const diffStat = status === 'done' ? await captureDiffStat(current.cwd) : null
    const settled = { ...(jobs.get(id) ?? current), status, endedAt: Date.now(), exitCode, diffStat }
    await persist(settled)
    await mergeChatAllowRules(settled).catch(() => {})
    killOrphanChildren(id)
    options.onJobSettled?.(settled)
  }

  async function finalizeJob(id: string, proc: Bun.Subprocess, record: JobRecord): Promise<void> {
    const throttle = createActivityThrottle(activityIntervalMs, clock)
    const stopTail = startLogTail(id, collectActivity(id, throttle))
    try {
      const exitCode = await proc.exited
      await stopTail()
      refreshActivity(id)
      const reported = reportedJobOutcome((await readLogTail(logPath(id), SESSION_SCAN_MAX_CHARS)).content)
      await settleJob(id, record, exitCode, exitCode === 0 && reported !== 'failed' ? 'done' : 'failed')
    } catch {
      await stopTail().catch(() => {})
      await settleFailed(id, record)
    }
  }

  function pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  // ponytail: an orphan's exit code is unknowable — a result marker in the log is the best done-signal.
  async function settleAdopted(record: JobRecord): Promise<void> {
    const log = await readLogFile(logPath(record.id)).catch(() => '')
    const progress = parseJobProgress(log)
    const current = jobs.get(record.id) ?? record
    const subAgents = Math.max(current.subAgents ?? 0, new Set(progress.subAgentIds).size)
    await persist({ ...current, turns: Math.max(current.turns, progress.turns), lastTool: progress.lastTool ?? current.lastTool, ...(subAgents > 0 ? { subAgents } : {}) })
    const done = reportedJobOutcome(log) === 'done'
    await settleJob(record.id, record, null, done ? 'done' : 'failed')
  }

  function adoptOrphan(record: JobRecord): void {
    if (!pidAlive(record.pid)) {
      void settleAdopted(record).catch(() => {})
      return
    }
    const throttle = createActivityThrottle(activityIntervalMs, clock)
    const stopTail = startLogTail(record.id, collectActivity(record.id, throttle))
    const watcher = setInterval(() => {
      if (pidAlive(record.pid)) return
      clearInterval(watcher)
      void stopTail()
        .catch(() => {})
        .then(() => settleAdopted(jobs.get(record.id) ?? record))
        .catch(() => {})
    }, ADOPT_POLL_MS)
  }

  for (const record of jobs.values()) {
    if (record.status === 'running') adoptOrphan(record)
  }

  function stepAttempts(chatId: string, label: string): number {
    return [...jobs.values()].filter(job => job.chatId === chatId && job.label === label && !job.reviewOf && !job.workflowRunId && job.threadRoot === job.id).length
  }

  function chatSpawnContext(params: CreateJobParams, id: string, chatHomePath: string): Partial<EngineResolverParams> {
    if (params.purpose !== 'chat') return {}
    const root = params.threadRoot === undefined ? undefined : jobs.get(params.threadRoot)
    const edit = params.edit ?? root?.edit ?? false
    const project = params.project ?? root?.project ?? null
    return {
      purpose: 'chat',
      edit,
      coreRules: chatRules({ chatId: params.threadRoot ?? id, home: chatHomePath, project, edit, memory: params.memory ?? '', engine: params.engine, model: typeof params.model === 'string' && params.model !== '' ? params.model : null }),
      ...(params.permissionMode === undefined ? {} : { permissionMode: params.permissionMode }),
      ...(params.forkSession === undefined ? {} : { forkSession: params.forkSession }),
      ...(params.resumeSessionAt === undefined ? {} : { resumeSessionAt: params.resumeSessionAt }),
      ...(root?.allowRules && root.allowRules.length > 0 ? { allowedTools: root.allowRules } : {}),
    }
  }

  async function chatSpawnEnv(params: CreateJobParams, id: string): Promise<Record<string, string>> {
    if (params.purpose !== 'chat') return {}
    return exportEnv({
      URL: `http://127.0.0.1:${listenTarget().port}`,
      TOKEN: await readApiToken(),
      CHAT_ID: params.threadRoot ?? id,
      CONFIG_DIR: dir,
    })
  }

  function chatRecordFields(params: CreateJobParams, edit: boolean | undefined): Partial<JobRecord> {
    const isChat = params.purpose === 'chat'
    return {
      ...(params.chatId ? { chatId: params.chatId } : {}),
      ...(params.chatId && !params.workflowRunId ? { reportedAt: null } : {}),
      ...(params.chatTurn ? { chatTurn: params.chatTurn } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
      ...(isChat ? { edit: edit ?? false, source: params.source ?? 'user' } : {}),
      ...(isChat && params.threadRoot === undefined ? { project: params.project ?? null, titleLocked: false } : {}),
    }
  }

  async function createJob(params: CreateJobParams, resolver: EngineResolver): Promise<CreateJobResult> {
    const cwdCheck = await validateWorkspaceCwd(params.cwd, home, { requireGit: params.purpose !== 'chat' })
    if (!cwdCheck.ok) return { ok: false, status: 400, error: cwdCheck.error }
    if (params.chatId && !params.reviewOf && !params.workflowRunId && params.threadRoot === undefined && stepAttempts(params.chatId, params.label) >= CHAT_STEP_ATTEMPTS) {
      return { ok: false, status: 409, error: 'retry cap reached for this step' }
    }
    const owner = params.purpose === 'chat' ? undefined : workspaceOwners.get(cwdCheck.path)
    if (owner && owner !== params.workflowRunId) return { ok: false, status: 409, error: 'Workspace is reserved by a running workflow' }

    ensureDirsSync(dir, logsDir)
    const id = crypto.randomUUID()
    const chatContext = chatSpawnContext(params, id, cwdCheck.path)
    let spawnSpec: EngineSpawn
    try {
      spawnSpec = await resolver({
        engine: params.engine,
        ...(params.purpose === 'workflow-design' || params.toolless ? { readOnly: true } : {}),
        prompt: params.prompt,
        connection: params.connection,
        coreRules: params.coreRules,
        mcpServers: params.mcpServers,
        ...(params.disallowedTools === undefined ? {} : { disallowedTools: params.disallowedTools }),
        ...(params.resumeSessionId === undefined ? {} : { resumeSessionId: params.resumeSessionId }),
        ...(params.workflowRunId ? { step: true } : {}),
        ...(typeof params.model === 'string' && params.model !== '' ? { model: params.model } : {}),
        ...(params.images === undefined ? {} : { images: params.images }),
        ...chatContext,
      })
    } catch (error) {
      return { ok: false, status: 400, error: `engine resolver failed: ${error instanceof Error ? error.message : String(error)}` }
    }

    let workspace: Pick<JobRecord, 'worktree' | 'baseRepo' | 'baseBranch'> = { worktree: null, baseRepo: params.baseRepo ?? null, baseBranch: null }
    if (params.worktree) {
      try {
        workspace = await prepareWorktree(cwdCheck.path, params.label)
      } catch (error) {
        return { ok: false, status: 400, error: String(error instanceof Error ? error.message : error) }
      }
    }
    const cwd = workspace.worktree ?? cwdCheck.path
    const activeOwner = params.purpose === 'chat' ? undefined : workspaceOwners.get(cwdCheck.path) ?? workspaceOwners.get(cwd)
    if (activeOwner && activeOwner !== params.workflowRunId) return { ok: false, status: 409, error: 'Workspace is reserved by a running workflow' }
    const path = logPath(id)
    const chatEnv = await chatSpawnEnv(params, id)

    let proc: Bun.Subprocess
    try {
      const logFd = openSync(path, 'a', FILE_MODE)
      try {
        proc = Bun.spawn([spawnSpec.cmd, ...spawnSpec.args], {
          cwd,
          env: { ...process.env, ...spawnSpec.env, ...exportEnv({ JOB_ID: id }), ...chatEnv },
          stdin: spawnSpec.control === true || spawnSpec.stdin !== undefined ? 'pipe' : 'ignore',
          stdout: logFd,
          stderr: logFd,
        })
        if (proc.stdin && typeof proc.stdin !== 'number') {
          if (spawnSpec.control === true) {
            const sink = proc.stdin
            try {
              sink.write(`${spawnSpec.stdin ?? ''}\n`)
              sink.flush()
              controls.set(id, sink)
            } catch {
              // the bridge closed its stdin before the launch line landed
            }
          } else if (spawnSpec.stdin !== undefined) {
            proc.stdin.write(spawnSpec.stdin)
            proc.stdin.end()
          }
        }
      } finally {
        closeSync(logFd)
      }
    } catch {
      return { ok: false, status: 500, error: 'failed to spawn engine process' }
    }
    processes.set(id, proc)

    const record: JobRecord = {
      id,
      engine: params.engine,
      cwd,
      ...workspace,
      label: params.label,
      prompt: params.prompt,
      pid: proc.pid,
      status: 'running',
      startedAt: clock(),
      turns: 0,
      slowAt: null,
      lastTool: null,
      endedAt: null,
      exitCode: null,
      diffStat: null,
      reviewedAt: null,
      sessionId: null,
      parentJobId: params.parentJobId ?? null,
      threadRoot: params.threadRoot ?? id,
      terminalId: typeof params.terminalId === 'string' && params.terminalId !== '' ? params.terminalId : null,
      reviewOf: typeof params.reviewOf === 'string' && params.reviewOf !== '' ? params.reviewOf : null,
      model: typeof params.model === 'string' && params.model !== '' ? params.model : null,
      ...(params.purpose ? { purpose: params.purpose } : {}),
      ...(params.images === undefined ? {} : { images: params.images }),
      ...(params.permissionMode === undefined ? {} : { permissionMode: params.permissionMode }),
      ...(params.prevTurnId === undefined ? {} : { prevTurnId: params.prevTurnId }),
      ...(params.versionOf === undefined ? {} : { versionOf: params.versionOf }),
      ...(params.branchFrom === undefined ? {} : { branchFrom: params.branchFrom }),
      ...chatRecordFields(params, chatContext.edit),
      ...(params.workflowRunId ? { workflowRunId: params.workflowRunId, workflowNodeId: params.workflowNodeId, workflowAttempt: params.workflowAttempt } : {}),
    }
    sessionScans.set(id, '')
    await persist(record)
    options.onJobStarted?.(record)

    void finalizeJob(id, proc, record).catch(() => settleFailed(id, record).catch(() => {}))

    return { ok: true, job: record }
  }

  async function markStopped(id: string): Promise<void> {
    const record = jobs.get(id)
    if (record !== undefined) await persist({ ...record, stoppedAt: clock() })
  }

  async function killJob(id: string): Promise<KillJobResult> {
    const proc = processes.get(id)
    if (proc !== undefined) {
      await markStopped(id)
      proc.kill('SIGTERM')
      await signalChildren(id, 'SIGTERM')
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL')
        void signalChildren(id, 'SIGKILL')
      }, KILL_ESCALATION_MS)
      return { ok: true }
    }
    const record = jobs.get(id)
    if (record === undefined || record.status !== 'running' || !pidAlive(record.pid)) {
      return { ok: false, status: 404, error: 'job is not running' }
    }
    await markStopped(id)
    try {
      process.kill(record.pid, 'SIGTERM')
      await signalChildren(id, 'SIGTERM')
      setTimeout(() => {
        if (pidAlive(record.pid)) {
          try {
            process.kill(record.pid, 'SIGKILL')
          } catch {
            // already gone
          }
        }
        void signalChildren(id, 'SIGKILL')
      }, KILL_ESCALATION_MS)
    } catch {
      return { ok: false, status: 404, error: 'job is not running' }
    }
    return { ok: true }
  }

  async function markReviewed(id: string, at: number = Date.now()): Promise<MarkReviewedResult> {
    const record = jobs.get(id)
    if (record === undefined) return { ok: false, status: 404, error: 'job not found' }
    if (record.reviewedAt !== null) return { ok: true, job: record }
    const reviewed: JobRecord = { ...record, reviewedAt: at }
    await persist(reviewed)
    return { ok: true, job: reviewed }
  }

  async function updateJob(id: string, patch: ChatJobPatch): Promise<JobRecord | undefined> {
    const record = jobs.get(id)
    if (record === undefined) return undefined
    const next = { ...record, ...patch }
    await persist(next)
    return next
  }

  const landingRepos = new Set<string>()

  async function landJob(id: string): Promise<LandJobResult> {
    const record = jobs.get(id)
    if (record === undefined) return { ok: false, status: 404, error: 'job not found' }
    const { worktree, baseRepo, baseBranch } = record
    if (worktree === null || baseRepo === null || baseBranch === null) {
      return { ok: false, status: 400, error: 'job has no worktree' }
    }
    if (workspaceOwners.has(baseRepo) || workspaceOwners.has(worktree) || landingRepos.has(baseRepo) || [...jobs.values()].some((job) => job.cwd === worktree && job.status === 'running')) {
      return { ok: false, status: 409, error: 'worktree or base repository is busy' }
    }
    landingRepos.add(baseRepo)
    try {
      const branch = worktreeBranch(record.label)
      if (await git(baseRepo, 'rev-parse', '--abbrev-ref', 'HEAD') !== baseBranch) {
        return { ok: false, status: 409, error: `base repository must have ${baseBranch} checked out` }
      }
      if (await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD') !== branch) {
        return { ok: false, status: 409, error: 'worktree branch has changed' }
      }
      if (await git(worktree, 'status', '--porcelain') !== '') {
        await git(worktree, 'add', '-A')
        await git(worktree, 'commit', '-m', `${record.label}: landed from cockpit`)
      }
      const revisions = await git(baseRepo, 'rev-list', '--reverse', `refs/heads/${baseBranch}..refs/heads/${branch}`)
      const landed = revisions === '' ? [] : revisions.split('\n')
      if (landed.length > 0) {
        try {
          await git(baseRepo, 'cherry-pick', ...landed)
        } catch (error) {
          const conflicts = await git(baseRepo, 'diff', '--name-only', '--diff-filter=U')
          if (conflicts === '') throw error
          await git(baseRepo, 'cherry-pick', '--abort')
          return { ok: false, status: 409, error: 'cherry-pick conflict', files: conflicts.split('\n') }
        }
      }
      await git(baseRepo, 'worktree', 'remove', worktree, '--force')
      await git(baseRepo, 'branch', '-D', branch)
      await markReviewed(id)
      return { ok: true, landed, base: baseBranch }
    } catch (error) {
      return { ok: false, status: 400, error: String(error instanceof Error ? error.message : error) }
    } finally {
      landingRepos.delete(baseRepo)
    }
  }

  function listJobs(): JobRecord[] {
    return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt || createdAs(b.id) - createdAs(a.id))
  }

  function getJob(id: string): JobRecord | undefined {
    return jobs.get(id)
  }

  function jobActivity(id: string): string | null {
    return activities.get(id) ?? null
  }

  function claimWorkspace(cwd: string, owner: string): boolean {
    const current = workspaceOwners.get(cwd)
    if ((current && current !== owner) || [...jobs.values()].some(job => job.cwd === cwd && job.status === 'running' && job.purpose !== 'chat' && job.workflowRunId !== owner)) return false
    workspaceOwners.set(cwd, owner)
    return true
  }
  function releaseWorkspace(cwd: string, owner: string): void {
    if (workspaceOwners.get(cwd) === owner) workspaceOwners.delete(cwd)
  }
  return { createJob, killJob, sendControl, landJob, markReviewed, updateJob, listJobs, getJob, currentActivity: jobActivity, logPath, claimWorkspace, releaseWorkspace }
}

export async function readLogFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

export type LogChunk = { content: string; offset: number }

export async function readLogTail(path: string, maxBytes = 4096): Promise<LogChunk> {
  let info
  try {
    info = await stat(path)
  } catch {
    return { content: '', offset: 0 }
  }
  const size = info.size
  const start = Math.max(0, size - maxBytes)
  const content = await readLogRange(path, start, size)
  return { content, offset: size }
}

export async function readLogSince(path: string, offset: number): Promise<LogChunk> {
  let info
  try {
    info = await stat(path)
  } catch {
    return { content: '', offset }
  }
  if (info.size <= offset) return { content: '', offset }
  const content = await readLogRange(path, offset, info.size)
  return { content, offset: info.size }
}

const NEWLINE_BYTE = 0x0a

export function completeLinesPrefix(bytes: Uint8Array): { content: string; byteLength: number } {
  const byteLength = bytes.lastIndexOf(NEWLINE_BYTE) + 1
  return { content: new TextDecoder().decode(bytes.subarray(0, byteLength)), byteLength }
}

export async function readCompleteLinesSince(path: string, offset: number): Promise<LogChunk> {
  let info
  try {
    info = await stat(path)
  } catch {
    return { content: '', offset }
  }
  if (info.size <= offset) return { content: '', offset }
  const { content, byteLength } = completeLinesPrefix(new Uint8Array(await Bun.file(path).slice(offset, info.size).arrayBuffer()))
  return { content, offset: offset + byteLength }
}

async function readLogRange(path: string, start: number, end: number): Promise<string> {
  if (end <= start) return ''
  const file = Bun.file(path)
  const slice = file.slice(start, end)
  return slice.text()
}
