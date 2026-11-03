import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { parseSessionId, parseThread } from './activity'
import { BUILTIN_AGENTS, createConnectionStore, modelFamily, SESSION_ENGINE, type AgentConnection } from './agent-connections'
import { modelDiscovery } from './model-discovery'
import { resolveBinary } from './engines'
import { addPathWorktree, applyPath, changedFileCount, commitPath, git, gitTimed, removePathWorktree, snapshotCommit } from './job-worktrees'
import { type CreateJobParams, type JobManager, type JobRecord, readLogFile, redactSecrets } from './jobs'
import type { EngineResolver } from './jobs-engine-iface'
import type { TerminalRegistry } from './terminals'
import { threadRootOf } from './threads'
import { configDir, mcUrl, readConfig, readSecrets } from './secrets'
import { commitRepoPath, joinRepoPath, shapeRepoNames, shapeRepoProblems, shapeRulesFor, snapshotRepos, workspaceFolder } from './repo-paths'
import { MAX_QUEUE_REPOS } from './repo-names'
import { pathWorkspaceIntact, preparePathWorkspace, prepareRepoWorkspace, removePathWorkspace, restorePathWorkspace, workspaceRepos } from './repo-workspace'
import { validateWorkspaceCwd } from './workspace'
import { checkShape, readShape, shapeGraph, shapeNotes, shapeTarget, type FlowShape } from './flow-shape'
import { atomicJson, composeWorkflowPrompt, draftRevision, forkSections, identifier, passTargets, sessionRules, type Outcome, type PolicyRevision, type WorkflowNode, type WorkflowRevision, type WorkflowStore } from './workflows'
import { exportEnv } from './env'
import type { AvailabilityCheck } from './engine-availability'

const jobId = z.string().min(1).max(200)
const GIT_TIMEOUT = 120_000
const startSchema = z.object({ terminalId: identifier.optional(), workflowId: identifier.optional(), revision: identifier.optional(), cwd: z.string().min(1).max(2048), request: z.string().trim().min(1).max(32000), label: z.string().trim().min(1).max(120), chat: jobId.optional(), chatTurn: jobId.optional(), engine: identifier.optional(), model: z.string().min(1).max(200).optional(), graph: z.unknown().optional() })
const resultSchema = z.object({ outcome: z.enum(['pass', 'fail', 'blocked']), summary: z.string().trim().min(1).max(16000), evidence: z.array(z.string().min(1).max(4000)).max(100) })
const stepReportSchema = resultSchema.extend({ output: z.string().max(64000).optional() })
type NodeResult = z.infer<typeof resultSchema>
export type ResolvedAgent = { engine: string; model: string | null; family: string | null; connection?: AgentConnection; inSession?: true; swappedFrom?: { engine: string; model: string | null; reason: string }; sameFamily?: true }
type ChatDefault = { engine: string; model: string | null }
type WorkspaceState = { head: string; diffHash: string }
export type CheckResult = { command: string; args: string[]; exitCode: number | null; output: string; timedOut: boolean }
export type WorkflowAttempt = {
  nodeId: string; number: number; jobId: string | null; status: 'starting' | 'running' | 'checking' | 'settled';
  prompt: string; startedAt: number; endedAt: number | null; result: NodeResult | null; checks: CheckResult[];
  output: string; checkPid?: number; workspace: WorkspaceState | null;
  tokenId: string; pathId: string; from: number[];
  inSession?: true; sessionNotifiedAt?: number | null; workspaceSnapshot?: WorkspaceState;
  reportedBy?: { via: ApprovalContext['via']; id: string; at: number }; interrupted?: true;
  shape?: FlowShape; nudgedFrom?: string;
  crashes?: number; tried?: string[]; sameFamily?: true;
}
export type TokenState = 'ready' | 'working' | 'settled' | 'waiting'
export type WorkflowToken = { id: string; nodeId: string; pathId: string; workspace: string; state: TokenState; attempt: number | null; from: number[] }
export type OpenSection = { fork: string; join: string; forkAttempt: number; parentPathId: string; parentWorkspace: string; snapshot: string; joined: string[]; counts?: Record<string, number>; paths: { pathId: string; branch: string; dir: string; workspace: string; firstNodeId: string }[]; folder?: string; repoSnapshots?: Record<string, string>; joinedRepos?: Record<string, string[]> }
export type RunStatus = 'awaiting-approval' | 'running' | 'paused' | 'done' | 'failed' | 'blocked' | 'stopped'
export type ApprovalVia = 'user' | 'drawer' | 'conversation' | 'auto'
export type RunVersion = { number: number; revision: string; reason: string; size: 'initial' | 'small' | 'big'; state: 'pending' | 'approved' | 'rejected'; approvedVia: ApprovalVia | null; relayedBy: string | null; at: number; graph?: WorkflowRevision; agents?: Record<string, ResolvedAgent>; skills?: Record<string, Array<{ path: string; content: string }>> }
export type RunChange = { graph: unknown; reason: string; scopeGrew?: boolean }
export type RunOrigin = { source: 'saved' | 'drafted'; by: string; where: 'chat' | 'terminal' | 'studio' }
export type ApprovalContext = { via: 'drawer' | 'conversation'; chat?: string; terminalId?: string; version?: number }
export class RunActionError extends Error { constructor(message: string, readonly status: 403 | 404 | 409) { super(message) } }
export const LIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['awaiting-approval', 'running', 'paused'])
type SettledStatus = Exclude<RunStatus, 'awaiting-approval' | 'running' | 'paused'>
export type WorkflowRun = {
  terminalId?: string
  chatId?: string; chatTurn?: string; reportedAt?: number | null
  id: string; label: string; cwd: string; request: string; workflow: WorkflowRevision; policy: PolicyRevision;
  agents: Record<string, ResolvedAgent>; skills: Record<string, Array<{ path: string; content: string }>>;
  status: RunStatus; error: string | null; origin: RunOrigin; versions: RunVersion[];
  currentNodeId: string; attempts: WorkflowAttempt[]; createdAt: number; updatedAt: number;
  tokens: WorkflowToken[]; sections: OpenSection[]; keptBranches: string[];
  dismissedAt?: number | null
  unavailable?: { engine: string; reason: string; until: number | null }
}

export function lineage(a: string, b: string): boolean {
  return a === b || a === 'main' || b === 'main' || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}

export function covers(reviewPath: string, implementPath: string): boolean {
  return reviewPath === implementPath || reviewPath === 'main' || implementPath.startsWith(`${reviewPath}.`)
}

// ponytail: legacy MC_RESULT from agents prompted before Shikidan, drop once no run predates it
const RESULT_LINE = /(?:^|\n)(?:SKD|MC)_RESULT\s+(\{[^\n]*\})\s*$/

export function readNodeResult(log: string): NodeResult | null {
  const messages = parseThread(log).filter(event => event.kind === 'text' || event.kind === 'result').map(event => event.detail)
  for (const message of messages.reverse()) {
    const match = RESULT_LINE.exec(message.trim())
    if (!match) continue
    try { return resultSchema.parse(JSON.parse(match[1]!)) } catch { return null }
  }
  return null
}

function passReachable(graph: WorkflowRevision, from = graph.entry): Set<string> {
  const reached = new Set<string>()
  const queue = graph.nodes.some(node => node.id === from) ? [from] : []
  while (queue.length) {
    const id = queue.shift()!
    if (reached.has(id)) continue
    reached.add(id)
    queue.push(...graph.edges.filter(edge => edge.source === id && edge.outcome === 'pass').map(edge => edge.target))
  }
  return reached
}

function reviewsAhead(graph: WorkflowRevision, from: string[]): Set<string> {
  const ahead = new Set(from.flatMap(id => [...passReachable(graph, id)]))
  return new Set(graph.nodes.filter(node => node.kind === 'review' && ahead.has(node.id)).map(node => node.id))
}

const GATING_KINDS: ReadonlySet<WorkflowNode['kind']> = new Set(['review', 'verify-plan'])

function commandsChanged(before: Pick<WorkflowRevision, 'nodes'>, after: Pick<WorkflowRevision, 'nodes'>): boolean {
  const commands = (node?: WorkflowNode) => JSON.stringify([node?.checks ?? [], node?.setup ?? [], node?.mcpServers ?? []])
  const ids = new Set([...before.nodes, ...after.nodes].map(node => node.id))
  return [...ids].some(id => commands(before.nodes.find(node => node.id === id)) !== commands(after.nodes.find(node => node.id === id)))
}

function weakensGates(before: WorkflowRevision, after: WorkflowRevision): boolean {
  if (commandsChanged(before, after)) return true
  return before.nodes.some(old => {
    const next = after.nodes.find(node => node.id === old.id)
    return !!next && GATING_KINDS.has(old.kind) && old.instructions !== next.instructions
  })
}

export function changeSize(run: Pick<WorkflowRun, 'workflow' | 'agents'>, next: WorkflowRevision, nextAgents: Record<string, ResolvedAgent>, scopeGrew: boolean, from: string[]): 'small' | 'big' {
  if (scopeGrew) return 'big'
  const families = new Set(Object.values(run.agents).map(agent => agent.family))
  if (next.nodes.some(node => node.kind !== 'join' && !families.has(nextAgents[node.id]?.family ?? null))) return 'big'
  if (next.nodes.some(node => passTargets(next, node.id).length > 1 && passTargets(run.workflow, node.id).length < 2)) return 'big'
  const reviews = (graph: WorkflowRevision) => graph.nodes.filter(node => node.kind === 'review').length
  if (reviews(next) < reviews(run.workflow)) return 'big'
  const reviewsStillAhead = reviewsAhead(next, from)
  if ([...reviewsAhead(run.workflow, from)].some(id => !reviewsStillAhead.has(id))) return 'big'
  if (weakensGates(run.workflow, next)) return 'big'
  const wasImplement = new Set(run.workflow.nodes.filter(node => node.kind === 'implement').map(node => node.id))
  const onPassPath = passReachable(next)
  return next.nodes.some(node => node.kind === 'implement' && onPassPath.has(node.id) && !wasImplement.has(node.id)) ? 'big' : 'small'
}

function guardChange(run: WorkflowRun, next: WorkflowRevision): void {
  const title = (id: string) => run.workflow.nodes.find(node => node.id === id)?.title ?? id
  if (next.entry !== run.workflow.entry) throw new Error(`${title(run.workflow.entry)} must stay the first step`)
  for (const id of new Set(run.attempts.map(attempt => attempt.nodeId))) {
    const before = run.workflow.nodes.find(node => node.id === id)!
    const after = next.nodes.find(node => node.id === id)
    if (!after) throw new Error(`${before.title} already ran and cannot be removed`)
    const frozen = (node: WorkflowNode) => JSON.stringify([node.kind, node.instructions, node.agent, node.checks, node.setup ?? []])
    if (frozen(after) !== frozen(before)) throw new Error(`${before.title} already ran, so its kind, instructions, agent, checks and setup cannot change`)
  }
  for (const token of run.tokens) if (!next.nodes.some(node => node.id === token.nodeId)) throw new Error(`${title(token.nodeId)} is in progress and cannot be removed`)
  const firsts = (paths: string[][]) => JSON.stringify(paths.map(path => path[0]))
  const sections = run.sections.length ? forkSections(next) : []
  for (const open of run.sections) {
    const kept = sections.some(section => section.fork === open.fork && section.join === open.join && firsts(section.paths) === JSON.stringify(open.paths.map(path => path.firstNodeId)))
    if (!kept) throw new Error(`Wait for the parallel paths to join before changing ${title(open.fork)}`)
  }
}

function positionOfToken(run: WorkflowRun, token: WorkflowToken): string {
  if (token.state !== 'settled') return token.nodeId
  const outcome = run.attempts[token.attempt!]?.result?.outcome
  return run.workflow.edges.find(edge => edge.source === token.nodeId && edge.outcome === outcome)?.target ?? token.nodeId
}

function positionOf(run: WorkflowRun): string {
  const token = run.tokens[0]
  return token ? positionOfToken(run, token) : run.currentNodeId
}

function positionsOf(run: WorkflowRun): string[] {
  return run.tokens.length ? run.tokens.map(token => positionOfToken(run, token)) : [run.currentNodeId]
}

const kindOf = (run: WorkflowRun, attempt: WorkflowAttempt) => run.workflow.nodes.find(node => node.id === attempt.nodeId)?.kind

function unreviewedImplementations(run: WorkflowRun, pathId: string): WorkflowAttempt[] {
  const reviewed = (implementation: WorkflowAttempt) => run.attempts.some(review => review.number > implementation.number && kindOf(run, review) === 'review' && review.result?.outcome === 'pass' && covers(review.pathId, implementation.pathId))
  return run.attempts.filter(attempt => kindOf(run, attempt) === 'implement' && lineage(attempt.pathId, pathId) && !reviewed(attempt))
}

const previousOf = (number: number) => number ? [number - 1] : []

function migrateRun(record: WorkflowRun): WorkflowRun {
  record.origin ??= { source: 'saved', by: 'you', where: record.terminalId ? 'terminal' : record.chatId ? 'chat' : 'studio' }
  record.versions ??= [{ number: 1, revision: record.workflow.revision, reason: 'Initial flow', size: 'initial', state: 'approved', approvedVia: 'user', relayedBy: null, at: record.createdAt }]
  for (const graph of [record.workflow, ...record.versions.map(version => version.graph)]) for (const node of graph?.nodes ?? []) node.setup ??= []
  record.sections ??= []
  record.keptBranches ??= []
  if (!record.tokens) {
    const last = record.attempts.at(-1)
    const working = !!last && last.status !== 'settled'
    const held = last?.status === 'settled' && LIVE_STATUSES.has(record.status) && record.versions.some(version => version.number > 1 && version.state === 'pending')
    const occupied = working || held
    record.tokens = [{ id: crypto.randomUUID(), nodeId: held ? last.nodeId : record.currentNodeId, pathId: 'main', workspace: record.cwd, state: working ? 'working' : held ? 'settled' : 'ready', attempt: occupied ? last!.number : null, from: occupied ? previousOf(last!.number) : last ? [last.number] : [] }]
  }
  for (const attempt of record.attempts) {
    attempt.pathId ??= 'main'
    attempt.tokenId ??= record.tokens[0]!.id
    attempt.from ??= previousOf(attempt.number)
  }
  return record
}

const inSession = (node: WorkflowNode) => node.agent.engine === SESSION_ENGINE

function detached(node: WorkflowNode): WorkflowNode {
  if (!inSession(node)) return node
  const { engine: _engine, model: _model, ...agent } = node.agent
  return { ...node, agent }
}

const ENTER_DELAY_MS = 150
const SAME_FAMILY_REVIEWS = 2
const MAX_CRASHES = 3
const REPLACEMENT_ORDER = ['claude', 'codex', 'glm'] as const
export const NUDGE_PROMPT = 'Your last turn ended without the SKD_RESULT line. Anything you left running in the background was stopped when your turn ended. Re-run what you need in the foreground. Give your complete final answer again (for a plan: the whole plan and any SKD_SHAPE line), ending with exactly one SKD_RESULT line.'
const NUDGEABLE_ENGINES: ReadonlySet<string> = new Set(['claude', 'glm'])
const LAST_WORDS_CHARS = 200
const OUTPUT_CHARS = 64000
const oneLine = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, ' ')
const sessionClosed = (title: string) => `The session that owned ${title} closed; Retry runs it as an agent`

async function snapshotSkills(node: WorkflowNode, cwd: string): Promise<Array<{ path: string; content: string }>> {
  return Promise.all(node.skills.map(async path => {
    const full = await realpath(isAbsolute(path) ? path : resolve(cwd, path))
    const home = await realpath(homedir())
    if (!full.startsWith(home + sep) || !full.endsWith('.md')) throw new Error('Skills must be Markdown files under your home directory')
    const info = await stat(full)
    if (!info.isFile() || info.size > 64000) throw new Error('Skill must be a Markdown file up to 64 KB')
    return { path: full, content: await readFile(full, 'utf8') }
  }))
}

export async function workspaceSnapshot(cwd: string): Promise<WorkspaceState> {
  try {
    return await repoSnapshot(cwd)
  } catch (error) {
    const repos = await workspaceRepos(cwd)
    if (repos === null) throw error
    const parts = await Promise.all(repos.map(name => repoSnapshot(join(cwd, name))))
    const head = repos.map((name, index) => `${name}:${parts[index]!.head}`).join(' ')
    return { head, diffHash: createHash('sha256').update(JSON.stringify(parts.map(part => part.diffHash))).digest('hex') }
  }
}

async function repoSnapshot(cwd: string): Promise<WorkspaceState> {
  const [head, diff, untracked] = await Promise.all([git(cwd, 'rev-parse', 'HEAD'), git(cwd, 'diff', '--binary', 'HEAD'), git(cwd, 'ls-files', '--others', '--exclude-standard', '-z')])
  const hash = createHash('sha256').update(diff)
  for (const path of untracked.split('\0').filter(Boolean).sort()) {
    const resolved = await realpath(join(cwd, path))
    hash.update(path)
    if (!resolved.startsWith(cwd + sep)) { hash.update(resolved); continue }
    const info = await stat(resolved)
    if (info.isDirectory()) continue
    if (info.size > 10_000_000) throw new Error(`Untracked artifact too large to fingerprint: ${path}`)
    hash.update(await readFile(resolved))
  }
  return { head, diffHash: hash.digest('hex') }
}

export function createWorkflowRunner(deps: { manager: JobManager; resolver: EngineResolver; store: WorkflowStore; base?: string; terminals?: Pick<TerminalRegistry, 'get'> & Partial<Pick<TerminalRegistry, 'write' | 'list' | 'ended'>>; onRunSettled?: (run: WorkflowRun) => void; requireApproval?: () => Promise<boolean>; onChange?: (run: WorkflowRun) => void; onSessionStep?: (run: WorkflowRun) => void; availability?: AvailabilityCheck }) {
  const root = join(deps.base ?? configDir(), 'workflow-runs')
  const requireApproval = deps.requireApproval ?? (async () => (await readConfig()).flowApproval)
  const availability = deps.availability ?? (async () => null)
  const runs = new Map<string, WorkflowRun>()
  try {
    for (const file of readdirSync(root).filter(file => /^[a-zA-Z0-9-]+\.json$/.test(file))) {
      const record = migrateRun(JSON.parse(readFileSync(join(root, file), 'utf8')) as WorkflowRun)
      runs.set(record.id, record)
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const pending = new Map<string, Promise<unknown>>()
  const stopping = new Set<string>()
  const checks = new Map<string, Map<number, () => void>>()
  const settling = new Map<string, Set<Promise<void>>>()
  const incoming = new Map<string, number>()
  const changePending = (run: WorkflowRun) => run.versions.some(version => version.number > 1 && version.state === 'pending')
  let starts = Promise.resolve<unknown>(undefined)
  function exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const task = (pending.get(id) ?? Promise.resolve()).then(action)
    pending.set(id, task.catch(() => {}))
    return task
  }
  async function persist(run: WorkflowRun): Promise<void> {
    run.updatedAt = Date.now()
    run.currentNodeId = positionOf(run)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await atomicJson(join(root, `${run.id}.json`), run)
    runs.set(run.id, run)
    deps.onChange?.(structuredClone(run))
    if (!LIVE_STATUSES.has(run.status) && !run.attempts.some(attempt => processAlive(attempt.checkPid)) && !deps.manager.listJobs().some(job => job.workflowRunId === run.id && job.status === 'running')) {
      for (const workspace of [run.cwd, ...pathWorkspaces(run)]) deps.manager.releaseWorkspace(workspace, run.id)
    }
  }
  function pathWorkspaces(run: WorkflowRun): string[] {
    return run.sections.flatMap(section => section.paths.map(path => path.workspace))
  }
  function claimPaths(run: WorkflowRun): string | null {
    return pathWorkspaces(run).find(workspace => !deps.manager.claimWorkspace(workspace, run.id)) ?? null
  }
  function processAlive(pid?: number): boolean {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
  }
  async function killWork(run: WorkflowRun): Promise<void> {
    for (const kill of checks.get(run.id)?.values() ?? []) kill()
    for (const job of deps.manager.listJobs().filter(job => job.workflowRunId === run.id && job.status === 'running')) await deps.manager.killJob(job.id)
  }
  function interrupt(run: WorkflowRun): void {
    for (const attempt of run.attempts.filter(attempt => attempt.status !== 'settled')) {
      Object.assign(attempt, { status: 'settled', endedAt: Date.now(), interrupted: true, result: { outcome: 'blocked', summary: 'Interrupted before it finished', evidence: [] } })
      const token = run.tokens.find(token => token.id === attempt.tokenId && token.attempt === attempt.number)
      if (token) Object.assign(token, { nodeId: attempt.nodeId, state: 'ready', attempt: null })
    }
  }
  async function finish(run: WorkflowRun, status: SettledStatus, error: string | null): Promise<void> {
    const wasLive = LIVE_STATUSES.has(run.status)
    run.status = status; run.error = error
    if (status !== 'done') { await killWork(run); interrupt(run) }
    else for (const section of run.sections.splice(0)) await closeSection(run, section, () => false)
    for (const version of run.versions.filter(version => version.state === 'pending')) Object.assign(version, { state: 'rejected', at: Date.now() })
    await persist(run)
    if (wasLive) deps.onRunSettled?.(structuredClone(run))
  }
  async function block(run: WorkflowRun, error: string): Promise<void> {
    await finish(run, 'blocked', error)
  }
  function workspaceBusy(cwd: string, except?: string): boolean {
    return [...runs.values()].some(run => run.id !== except && run.cwd === cwd && LIVE_STATUSES.has(run.status)) || deps.manager.listJobs().some(job => job.cwd === cwd && job.status === 'running' && job.purpose !== 'chat' && job.workflowRunId !== except)
  }
  function followResumedTerminals(targets: Array<Pick<WorkflowRun, 'terminalId'>>): void {
    const orphaned = targets.filter(run => run.terminalId && !deps.terminals?.get(run.terminalId))
    if (!orphaned.length || !deps.terminals?.ended || !deps.terminals.list) return
    const sessionIds = new Map(deps.terminals.ended().map(past => [past.id, past.sessionId]))
    const live = deps.terminals.list()
    for (const run of orphaned) {
      const sessionId = sessionIds.get(run.terminalId!)
      const resumed = sessionId ? live.find(terminal => terminal.sessionId === sessionId) : undefined
      if (resumed) run.terminalId = resumed.id
    }
  }
  function sessionOf(run: Pick<WorkflowRun, 'terminalId' | 'chatId'>): ChatDefault | undefined {
    followResumedTerminals([run])
    if (run.terminalId) {
      const terminal = deps.terminals?.get(run.terminalId)
      return terminal?.inSessionAware ? { engine: terminal.engine, model: null } : undefined
    }
    const root = run.chatId ? deps.manager.getJob(run.chatId) : undefined
    return root ? { engine: root.engine, model: root.model ?? null } : undefined
  }
  async function agentResolver(): Promise<(node: WorkflowNode, chatDefault: ChatDefault | undefined) => Promise<ResolvedAgent>> {
    const { roles, fallback } = await readConfig()
    const connections = createConnectionStore(deps.base)
    return async (node, chatDefault) => {
      const role = chatDefault ?? (Object.hasOwn(roles, node.agent.role) ? roles[node.agent.role] : undefined) ?? fallback
      if (!role && !node.agent.engine) throw new Error(`${node.title}: role "${node.agent.role}" is not defined in Settings`)
      const engine = node.agent.engine ?? role!.engine
      const builtin = BUILTIN_AGENTS.includes(engine as typeof BUILTIN_AGENTS[number])
      const connection = builtin ? undefined : await connections.get(engine)
      return agentOn(node, engine, node.agent.model ?? (node.agent.engine ? null : role!.model), connection)
    }
  }
  async function agentOn(node: WorkflowNode, engine: string, model: string | null, stored?: AgentConnection): Promise<ResolvedAgent> {
    const connection = stored ? await modelDiscovery(deps.base).effective(stored) : undefined
    if (node.mcpServers.length && (!connection || connection.adapter === 'cli')) throw new Error(`${node.title}: attached MCP servers need an ACP connection`)
    const ownFamily = connection ? connection.family ?? node.agent.family : engine === 'codex' ? 'gpt' : engine
    const family = (modelFamily(model) ?? ownFamily)?.toLowerCase() ?? null
    return { engine, model, family, ...(connection ? { connection } : {}) }
  }
  async function agentsFor(workflow: WorkflowRevision, chatDefault?: ChatDefault, session?: ChatDefault): Promise<Record<string, ResolvedAgent>> {
    const resolveAgent = await agentResolver()
    async function resolveNode(node: WorkflowNode): Promise<ResolvedAgent> {
      if (!inSession(node) || !session) return resolveAgent(detached(node), chatDefault)
      const { connection: _connection, ...agent } = await resolveAgent({ ...node, agent: { ...detached(node).agent, engine: session.engine, ...(session.model ? { model: session.model } : {}) } }, undefined)
      return { ...agent, inSession: true }
    }
    const working = workflow.nodes.filter(node => node.kind !== 'join')
    const agents: Record<string, ResolvedAgent> = Object.fromEntries(await Promise.all(working.map(async node => [node.id, await resolveNode(node)] as const)))
    const sessionPlanFamilies = new Set(workflow.nodes.filter(node => node.kind === 'plan' && agents[node.id]!.inSession).map(node => agents[node.id]!.family))
    for (const check of workflow.nodes.filter(node => node.kind === 'verify-plan' && sessionPlanFamilies.has(agents[node.id]!.family))) {
      agents[check.id] = await resolveAgent(detached(check), undefined)
    }
    const implementationFamilies = new Set(workflow.nodes.filter(node => node.kind === 'implement').map(node => agents[node.id]!.family))
    const chatDecides = (node: WorkflowNode) => !node.agent.engine || (inSession(node) && !session)
    for (const review of workflow.nodes.filter(node => chatDefault && node.kind === 'review' && chatDecides(node) && implementationFamilies.has(agents[node.id]!.family))) {
      agents[review.id] = await resolveAgent(detached(review), undefined)
    }
    for (const implementation of workflow.nodes.filter(node => node.kind === 'implement')) {
      if (!agents[implementation.id]!.family) throw new Error(`${implementation.title}: select or declare the model family for cross-family review`)
    }
    for (const review of workflow.nodes.filter(node => node.kind === 'review')) {
      if (!agents[review.id]!.family) throw new Error(`${review.title}: select or declare the review model family`)
    }
    const stack: Array<[string, Set<string>]> = [[workflow.entry, new Set()]]
    const visited = new Set<string>()
    while (stack.length) {
      const [id, families] = stack.pop()!
      const key = `${id}:${[...families].sort().join(',')}`
      if (visited.has(key)) continue
      visited.add(key)
      const node = workflow.nodes.find(node => node.id === id)!
      const carried = new Set(families)
      if (node.kind === 'implement') carried.add(agents[node.id]!.family!)
      if (node.kind === 'review') {
        if (carried.has(agents[node.id]!.family!)) throw new Error(`${node.title} must use a different model family from implementation`)
        carried.clear()
      }
      for (const target of passTargets(workflow, id)) stack.push([target, carried])
    }
    return agents
  }
  function pinnedParallel(run: WorkflowRun, node: WorkflowNode): boolean {
    if (!node.agent.engine || node.agent.engine === SESSION_ENGINE) return false
    return run.workflow.nodes.some(source => { const targets = passTargets(run.workflow, source.id); return targets.length > 1 && targets.includes(node.id) })
  }
  const sameFamilyUses = (run: WorkflowRun) => run.attempts.filter(attempt => attempt.sameFamily).length
  async function replacementFor(run: WorkflowRun, node: WorkflowNode, tried: string[], reason: string): Promise<ResolvedAgent | null> {
    const current = run.agents[node.id]!
    if (pinnedParallel(run, node)) return null
    const { fallback } = await readConfig()
    const connections = await createConnectionStore(deps.base).list()
    const options: Array<{ engine: string; model: string | null; connection?: AgentConnection }> = [
      ...(fallback ? [{ ...fallback, connection: connections.find(connection => connection.id === fallback.engine) }] : []),
      ...REPLACEMENT_ORDER.map(engine => ({ engine, model: null })),
      ...connections.map(connection => ({ engine: connection.id, model: null, connection })),
    ]
    const candidates: ResolvedAgent[] = []
    for (const option of options) {
      if (option.engine === current.engine || tried.includes(option.engine)) continue
      if (!BUILTIN_AGENTS.includes(option.engine as typeof BUILTIN_AGENTS[number]) && !option.connection) continue
      const agent = await agentOn(node, option.engine, option.model, option.connection).catch(() => null)
      if (agent && !await availability(agent)) candidates.push(agent)
    }
    const swappedFrom = { engine: current.engine, model: current.model, reason }
    if (node.kind !== 'review') return candidates[0] ? { ...candidates[0], swappedFrom } : null
    const implemented = new Set(run.workflow.nodes.filter(other => other.kind === 'implement').map(other => run.agents[other.id]?.family))
    const crossFamily = candidates.find(agent => !implemented.has(agent.family))
    if (crossFamily) return { ...crossFamily, swappedFrom }
    return candidates[0] && sameFamilyUses(run) < SAME_FAMILY_REVIEWS ? { ...candidates[0], swappedFrom, sameFamily: true } : null
  }
  async function preflight(run: WorkflowRun): Promise<void> {
    const steps = run.workflow.nodes.filter(node => node.kind !== 'join' && !run.agents[node.id]?.inSession)
    for (const node of [...steps.filter(node => node.kind !== 'review'), ...steps.filter(node => node.kind === 'review')]) {
      const agent = run.agents[node.id]!
      const down = await availability(agent)
      if (!down) continue
      const replacement = await replacementFor(run, node, [agent.engine], down.reason)
      if (replacement) run.agents[node.id] = replacement
    }
  }
  async function unavailableBlock(run: WorkflowRun, engine: string, reason: string, until: number | null): Promise<void> {
    run.unavailable = { engine, reason, until }
    await block(run, `${engine} unavailable: ${reason}`)
  }
  function visitLimit(run: WorkflowRun, node: WorkflowNode, counts: (attempt: WorkflowAttempt) => boolean = () => true): string | null {
    if (run.attempts.filter(attempt => attempt.nodeId === node.id && counts(attempt)).length >= node.maxVisits) return `${node.title} reached its ${node.maxVisits}-visit limit`
    return run.attempts.length >= 256 ? 'Run reached its 256-node execution limit' : null
  }
  async function dispatch(run: WorkflowRun, token: WorkflowToken): Promise<void> {
    if (stopping.has(run.id) || run.status !== 'running' || changePending(run)) return
    const node = run.workflow.nodes.find(node => node.id === token.nodeId)!
    if (node.kind === 'join') return block(run, `${node.title} has no open paths to join`)
    const limit = visitLimit(run, node, attempt => !attempt.interrupted)
    if (limit) return block(run, limit)
    const related = run.attempts.filter(attempt => lineage(attempt.pathId, token.pathId))
    const lastPlan = related.findLastIndex(attempt => kindOf(run, attempt) === 'plan')
    const verification = related.findLastIndex(attempt => kindOf(run, attempt) === 'verify-plan')
    const verified = verification > lastPlan && related[verification]?.result?.outcome === 'pass'
    if (node.kind === 'implement' && !verified) return block(run, 'Implementation requires a successfully verified plan')
    if (node.kind === 'review' && unreviewedImplementations(run, token.pathId).some(attempt => run.agents[attempt.nodeId]!.family === run.agents[node.id]!.family)) {
      const reviewer = run.agents[node.id]!
      const reason = 'no reviewer of a different family is available'
      const replacement = reviewer.sameFamily ? null : await replacementFor(run, node, [reviewer.engine], 'it shares a family with the implementation')
      if (replacement) run.agents[node.id] = replacement
      else if (!reviewer.sameFamily || sameFamilyUses(run) >= SAME_FAMILY_REVIEWS) return unavailableBlock(run, reviewer.engine, reason, null)
    }
    const latest = new Map(related.filter(attempt => attempt.result).map(attempt => [attempt.nodeId, attempt]))
    const inputs = [...latest.values()].map(attempt => ({ node: attempt.nodeId, outcome: attempt.result, output: attempt.output, checks: attempt.checks, workspace: attempt.workspace }))
    const agent = run.agents[node.id]!
    if (agent.inSession && !sessionOf(run)) return block(run, sessionClosed(node.title))
    const policy = agent.inSession ? { ...run.policy, coreRules: sessionRules(mcUrl(), run.id, node.id) } : run.policy
    const restored = await restorePath(run, token)
    if (restored) return block(run, restored)
    const repoRules = node.kind === 'plan' ? await shapeRulesFor(run.cwd) : ''
    const prompt = composeWorkflowPrompt(policy, run.workflow, node, run.request, inputs, run.skills[node.id], shapeNotes(run.workflow, node, inputs.map(input => input.output), repoRules))
    const session = agent.inSession ? { inSession: true as const, sessionNotifiedAt: null, workspaceSnapshot: await workspaceSnapshot(token.workspace) } : {}
    const attempt: WorkflowAttempt = { nodeId: node.id, number: run.attempts.length, jobId: null, status: agent.inSession ? 'running' : 'starting', prompt, startedAt: Date.now(), endedAt: null, result: null, checks: [], output: '', workspace: null, tokenId: token.id, pathId: token.pathId, from: token.from, ...session }
    if (prompt.length > 500000) return block(run, 'Combined task inputs exceed 500 KB; use artifact paths for large outputs')
    run.attempts.push(attempt)
    Object.assign(token, { state: 'working', attempt: attempt.number })
    await persist(run)
    if (agent.inSession) { deps.onSessionStep?.(structuredClone(run)); return }
    await launch(run, node, attempt, token)
  }
  async function launch(run: WorkflowRun, node: WorkflowNode, attempt: WorkflowAttempt, token: WorkflowToken): Promise<null> {
    const agent = run.agents[node.id]!
    const down = await availability(agent)
    if (down) return recoverStep(run, node, attempt, token, down.reason)
    if (agent.sameFamily) attempt.sameFamily = true
    const result = await deps.manager.createJob(stepJob(run, node, attempt, token, attempt.prompt), deps.resolver)
    if (!result.ok) return recoverStep(run, node, attempt, token, result.error)
    Object.assign(attempt, { jobId: result.job.id, status: 'running' })
    await persist(run)
    settleIfFinished(run, result.job.id)
    return null
  }
  async function recoverStep(run: WorkflowRun, node: WorkflowNode, attempt: WorkflowAttempt, token: WorkflowToken, reason: string): Promise<null> {
    const agent = run.agents[node.id]!
    const down = await availability(agent)
    attempt.crashes = (attempt.crashes ?? 0) + 1
    if (attempt.crashes < MAX_CRASHES && !down) return launch(run, node, attempt, token)
    const why = down?.reason ?? reason
    const tried = [...attempt.tried ?? [], agent.engine]
    const replacement = await replacementFor(run, node, tried, why)
    if (replacement) {
      run.agents[node.id] = replacement
      Object.assign(attempt, { crashes: 0, tried })
      return launch(run, node, attempt, token)
    }
    if (pinnedParallel(run, node)) {
      await conclude(run, attempt, token, { outcome: 'pass', summary: `Skipped: ${agent.engine} unavailable (${why})`, evidence: [`${agent.engine} unavailable: ${why}`] }, [])
      return null
    }
    Object.assign(attempt, { status: 'settled', endedAt: Date.now(), result: { outcome: 'blocked', summary: `${agent.engine} unavailable: ${why}`, evidence: [] } })
    Object.assign(token, { state: 'ready', attempt: null })
    await unavailableBlock(run, agent.engine, why, down?.until ?? null)
    return null
  }
  function stepJob(run: WorkflowRun, node: WorkflowNode, attempt: WorkflowAttempt, token: WorkflowToken, prompt: string): CreateJobParams {
    const agent = run.agents[node.id]!
    const chat = run.chatId ? { chatId: run.chatId, ...(run.chatTurn ? { chatTurn: run.chatTurn } : {}), reason: `Studio · ${run.workflow.name} · ${node.title}` } : {}
    return { engine: agent.engine, model: agent.model ?? undefined, connection: agent.connection, cwd: token.workspace, ...(token.workspace === run.cwd ? {} : { baseRepo: run.cwd }), label: run.chatId ? node.title : run.label, prompt, ...chat, coreRules: node.kind === 'implement' ? `${run.policy.coreRules}\n\n${run.policy.implementationRules}` : run.policy.coreRules, mcpServers: node.mcpServers, workflowRunId: run.id, workflowNodeId: node.id, workflowAttempt: attempt.number, terminalId: run.terminalId }
  }
  function lastWords(output: string): string {
    const words = output.slice(-LAST_WORDS_CHARS).trim()
    return words ? `Agent ended twice without SKD_RESULT; last words: ${words}` : 'Agent ended twice without SKD_RESULT'
  }
  function heldJobs(run: WorkflowRun): JobRecord[] {
    return run.attempts.flatMap(attempt => {
      const job = attempt.status === 'running' && !attempt.inSession && attempt.jobId ? deps.manager.getJob(attempt.jobId) : undefined
      return job && job.status !== 'running' ? [job] : []
    })
  }
  function settleIfFinished(run: WorkflowRun, id: string): void {
    const job = deps.manager.getJob(id)
    if (job && job.status !== 'running') queueMicrotask(() => { void onJobSettled(job).catch(error => block(run, String(error))) })
  }
  async function nudge(run: WorkflowRun, attempt: WorkflowAttempt, token: WorkflowToken, record: JobRecord, sessionId: string): Promise<Checking | null> {
    attempt.nudgedFrom = record.id
    await persist(run)
    const node = run.workflow.nodes.find(node => node.id === attempt.nodeId)!
    const created = await deps.manager.createJob({ ...stepJob(run, node, attempt, token, NUDGE_PROMPT), resumeSessionId: sessionId }, deps.resolver)
    if (!created.ok) return accept(run, attempt, token, { outcome: 'blocked', summary: `Agent ended without SKD_RESULT and could not be resumed: ${created.error}`, evidence: [] })
    attempt.jobId = created.job.id
    await persist(run)
    settleIfFinished(run, created.job.id)
    return null
  }
  function chatDefaultFor(input: z.infer<typeof startSchema>): ChatDefault | undefined {
    if (!input.chat) {
      if (input.chatTurn) throw new Error('A chat turn needs its chat')
      return input.engine ? { engine: input.engine, model: input.model ?? null } : undefined
    }
    const root = deps.manager.getJob(input.chat)
    if (!root || root.purpose !== 'chat' || threadRootOf(root) !== root.id) throw new Error('Chat not found')
    const turn = input.chatTurn ? deps.manager.getJob(input.chatTurn) : root
    if (!turn || threadRootOf(turn) !== root.id) throw new Error('Chat turn not found in this chat')
    return input.engine ? { engine: input.engine, model: input.model ?? null } : { engine: root.engine, model: root.model }
  }
  async function start(value: unknown, context: { startedByUser: boolean } = { startedByUser: false }): Promise<WorkflowRun> {
    const action = starts.then(async () => {
      const input = startSchema.parse(value)
      if (input.graph !== undefined && input.workflowId) throw new Error('Use either a saved workflow or a drafted graph')
      const chatDefault = chatDefaultFor(input)
      const cwd = await validateWorkspaceCwd(input.cwd)
      if (!cwd.ok) throw new Error(cwd.error)
      const terminal = input.terminalId ? deps.terminals?.get(input.terminalId) : undefined
      if (input.terminalId && !terminal) throw new Error('Terminal not found; open a new terminal before starting its workflow')
      const terminalRoot = terminal ? await realpath(terminal.cwd).catch(() => terminal.cwd) : null
      if (terminalRoot !== null && cwd.path !== terminalRoot && !cwd.path.startsWith(terminalRoot.endsWith(sep) ? terminalRoot : terminalRoot + sep)) throw new Error('Use this terminal’s folder or a repo inside this terminal’s folder')
      const selection = terminal?.workflow
      if (terminal && !selection) throw new Error('This terminal has no pinned workflow; open a new terminal')
      const workflow = input.graph !== undefined ? draftRevision(input.graph) : input.workflowId ? await deps.store.get(input.workflowId, input.revision) : selection ? await deps.store.get(selection.id, selection.revision) : await deps.store.selected()
      if (workspaceBusy(cwd.path)) throw new Error('Workspace already has running work')
      const agents = await agentsFor(workflow, chatDefault, sessionOf({ terminalId: input.terminalId, chatId: input.chat }))
      const policy = await deps.store.policy()
      const skills = Object.fromEntries(await Promise.all(workflow.nodes.map(async node => [node.id, await snapshotSkills(node, cwd.path)])))
      const chat = input.chat ? { chatId: input.chat, ...(input.chatTurn ? { chatTurn: input.chatTurn } : {}), reportedAt: null } : {}
      const by = terminal?.engine ?? (input.chat ? deps.manager.getJob(input.chat)?.engine : undefined) ?? 'you'
      const where = terminal ? 'terminal' : input.chat ? 'chat' : 'studio'
      const waits = !context.startedByUser && (await requireApproval() || (input.graph !== undefined && commandsChanged({ nodes: [] }, workflow)))
      const version: RunVersion = { number: 1, revision: workflow.revision, reason: 'Initial flow', size: 'initial', state: waits ? 'pending' : 'approved', approvedVia: waits ? null : context.startedByUser ? 'user' : 'auto', relayedBy: null, at: Date.now() }
      const run: WorkflowRun = { id: crypto.randomUUID(), ...(input.terminalId ? { terminalId: input.terminalId } : {}), ...chat, label: input.label, cwd: cwd.path, request: input.request, workflow, policy, agents, skills, status: waits ? 'awaiting-approval' : 'running', error: null, origin: { source: input.graph !== undefined ? 'drafted' : 'saved', by, where }, versions: [version], currentNodeId: workflow.entry, attempts: [], createdAt: Date.now(), updatedAt: Date.now(), tokens: [{ id: crypto.randomUUID(), nodeId: workflow.entry, pathId: 'main', workspace: cwd.path, state: 'ready', attempt: null, from: [] }], sections: [], keptBranches: [] }
      await preflight(run)
      if (!deps.manager.claimWorkspace(run.cwd, run.id)) throw new Error('Workspace already has running work')
      await persist(run)
      if (!waits) await exclusive(run.id, () => advance(run))
      return structuredClone(run)
    })
    starts = action.catch(() => {})
    return action
  }
  async function redactRunOutput(run: WorkflowRun, text: string): Promise<string> {
    const references = Object.values(run.agents).flatMap(agent => [...Object.values(agent.connection?.env ?? {}), agent.connection?.apiKeyEnv]).filter((value): value is string => !!value)
    references.push(...run.workflow.nodes.flatMap(node => node.mcpServers.flatMap(server => Object.values(server.env))))
    const values = [(await readSecrets()).zaiAuthToken, ...references.map(reference => process.env[reference] ?? null)]
    return values.reduce<string>((output, secret) => redactSecrets(output, secret), text)
  }
  type Command = WorkflowNode['checks'][number]
  type Finished = { exitCode: number | null; output: string; timedOut: boolean }
  function spawnKillable(run: WorkflowRun, key: number, cwd: string, command: Command): { pid?: number; done: Promise<Finished> } {
    const proc = spawn(resolveBinary(command.command), command.args, { cwd, env: { ...process.env, ...exportEnv({ WORKFLOW_RUN_ID: run.id }) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const completion = new Promise<number | null>((resolveExit, reject) => { proc.once('error', reject); proc.once('exit', resolveExit) })
    let output = '', timedOut = false
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16000) }
    proc.stdout.on('data', collect); proc.stderr.on('data', collect)
    const kill = () => { try { if (proc.pid) process.kill(-proc.pid, 'SIGTERM') } catch {}; setTimeout(() => { try { if (proc.pid) process.kill(-proc.pid, 'SIGKILL') } catch {} }, 1000).unref() }
    const kills = checks.get(run.id) ?? new Map<number, () => void>()
    checks.set(run.id, kills.set(key, kill))
    const timer = setTimeout(() => { timedOut = true; kill() }, command.timeoutSeconds * 1000)
    const done = completion
      .then(async exitCode => ({ exitCode, output: await redactRunOutput(run, output), timedOut }), (error: Error) => ({ exitCode: null, output: error.message, timedOut }))
      .finally(() => {
        clearTimeout(timer); kills.delete(key)
        if (!kills.size) checks.delete(run.id)
      })
    return { pid: proc.pid, done }
  }
  async function runCheck(run: WorkflowRun, attempt: WorkflowAttempt, cwd: string, check: Command): Promise<CheckResult> {
    const started = spawnKillable(run, attempt.number, cwd, check)
    try {
      await exclusive(run.id, async () => { attempt.checkPid = started.pid; await persist(run) })
    } catch (error) {
      return { command: check.command, args: check.args, exitCode: null, output: (error as Error).message, timedOut: false }
    }
    return { command: check.command, args: check.args, ...await started.done }
  }
  type Checking = { attempt: WorkflowAttempt; token: WorkflowToken; node: WorkflowNode; result: NodeResult }
  async function settle(run: WorkflowRun, record: JobRecord): Promise<Checking | null> {
    if ((run.status !== 'running' && run.status !== 'paused') || stopping.has(run.id)) return null
    const attempt = run.attempts.find(attempt => attempt.jobId === record.id)
    if (!attempt || attempt.status === 'settled' || attempt.status === 'checking') return null
    const token = run.tokens.find(token => token.id === attempt.tokenId)!
    const log = await redactRunOutput(run, await readLogFile(deps.manager.logPath(record.id)))
    const messages = parseThread(log)
    const own = messages.findLast(event => event.kind === 'result')?.detail ?? messages.filter(event => event.kind === 'text').map(event => event.detail).join('\n')
    const nudged = attempt.nudgedFrom !== undefined && attempt.nudgedFrom !== record.id
    attempt.output = (nudged ? [attempt.output, own].filter(Boolean).join('\n') : own).slice(-OUTPUT_CHARS)
    let result = readNodeResult(log)
    const current = deps.manager.getJob(record.id) ?? record
    const sessionId = current.sessionId ?? parseSessionId(log)
    if (record.status === 'done' && !result && !nudged && current.stoppedAt === undefined && sessionId && NUDGEABLE_ENGINES.has(record.engine)) {
      if (run.status === 'paused') { await persist(run); return null }
      return nudge(run, attempt, token, record, sessionId)
    }
    if (record.status === 'done' && !result && nudged) result = { outcome: 'blocked', summary: lastWords(own), evidence: [] }
    if (record.status !== 'done' && result?.outcome !== 'fail' && result?.outcome !== 'blocked') {
      const summary = `Agent process failed (${record.exitCode ?? 'unknown exit'})`
      if (current.stoppedAt !== undefined) result = { outcome: 'blocked', summary, evidence: [] }
      else if (run.status === 'paused') { await persist(run); return null }
      else return recoverStep(run, run.workflow.nodes.find(node => node.id === attempt.nodeId)!, attempt, token, summary)
    }
    if (!result || (result.outcome === 'pass' && !result.evidence.length)) result = { outcome: 'blocked', summary: 'Agent did not provide a valid SKD_RESULT with evidence', evidence: [] }
    if (result.outcome === 'pass' && kindOf(run, attempt) === 'plan') {
      const errors = await keepShape(run, attempt)
      if (errors.length) result = { ...result, evidence: [...result.evidence, `Flow shape ignored: ${errors.join('; ')}`] }
    }
    return accept(run, attempt, token, result)
  }
  async function accept(run: WorkflowRun, attempt: WorkflowAttempt, token: WorkflowToken, result: NodeResult): Promise<Checking | null> {
    const node = run.workflow.nodes.find(node => node.id === attempt.nodeId)!
    attempt.result = result
    if (result.outcome === 'pass' && node.checks.length) {
      attempt.status = 'checking'
      await persist(run)
      return { attempt, token, node, result }
    }
    await conclude(run, attempt, token, result, [])
    return null
  }
  async function acceptance(run: WorkflowRun, { attempt, token, node, result }: Checking): Promise<{ result: NodeResult; checks: CheckResult[] }> {
    const results: CheckResult[] = []
    for (const check of node.checks) {
      if (attempt.status === 'settled' || stopping.has(run.id)) break
      const checked = await runCheck(run, attempt, token.workspace, check)
      results.push(checked)
      if (checked.exitCode !== 0 || checked.timedOut) return { result: { ...result, outcome: 'fail', summary: `Acceptance check failed: ${check.command}` }, checks: results }
    }
    return { result, checks: results }
  }
  async function conclude(run: WorkflowRun, attempt: WorkflowAttempt, token: WorkflowToken, result: NodeResult, checked: CheckResult[]): Promise<void> {
    attempt.checks.push(...checked)
    delete attempt.checkPid
    if (attempt.status === 'settled' || stopping.has(run.id) || (run.status !== 'running' && run.status !== 'paused')) return persist(run)
    attempt.workspace = await workspaceSnapshot(token.workspace)
    Object.assign(attempt, { result, status: 'settled', endedAt: Date.now() })
    token.state = 'settled'
    await proposeShape(run, attempt)
    await advance(run)
  }
  async function route(run: WorkflowRun, token: WorkflowToken): Promise<boolean> {
    const attempt = run.attempts[token.attempt!]!
    const result = attempt.result!
    const targets = result.outcome === 'pass' ? passTargets(run.workflow, attempt.nodeId) : run.workflow.edges.filter(edge => edge.source === attempt.nodeId && edge.outcome === result.outcome).map(edge => edge.target)
    if (targets.length > 1) return fork(run, token, run.workflow.nodes.find(node => node.id === attempt.nodeId)!, attempt)
    const target = targets[0]
    const waits = target !== undefined && run.sections.some(section => section.join === target && section.paths.some(path => path.pathId === token.pathId))
    Object.assign(token, { nodeId: target ?? attempt.nodeId, state: waits ? 'waiting' : 'ready', attempt: null, from: [attempt.number] })
    if (target !== undefined) return true
    if (result.outcome === 'pass' && unreviewedImplementations(run, token.pathId).length) await block(run, 'Implementation finished without a cross-family review')
    else await finish(run, result.outcome === 'pass' ? 'done' : result.outcome === 'fail' ? 'failed' : 'blocked', result.outcome === 'pass' ? null : result.summary)
    return false
  }
  async function runSetup(run: WorkflowRun, node: WorkflowNode, cwd: string, key: number): Promise<string | null> {
    for (const command of node.setup ?? []) {
      if (stopping.has(run.id)) return null
      const { exitCode, output, timedOut } = await spawnKillable(run, key, cwd, command).done
      if (stopping.has(run.id)) return null
      if (exitCode === 0 && !timedOut) continue
      const detail = timedOut ? `timed out after ${command.timeoutSeconds} s` : output.trimEnd()
      return `${node.title} setup failed: ${[command.command, ...command.args].join(' ')}${detail ? `\n${detail}` : ''}`
    }
    return null
  }
  type PlannedPath = OpenSection['paths'][number]
  async function startPaths(run: WorkflowRun, token: WorkflowToken, node: WorkflowNode, attempt: WorkflowAttempt, section: OpenSection, materialize: (path: PlannedPath) => Promise<string | null>): Promise<boolean> {
    run.sections = [...run.sections.filter(open => !(open.fork === node.id && open.forkAttempt === attempt.number)), section]
    await persist(run)
    for (const path of section.paths) {
      const problem = await materialize(path)
      if (problem) { await block(run, problem); return false }
      if (!deps.manager.claimWorkspace(path.workspace, run.id)) { await block(run, `Another run owns ${path.workspace}`); return false }
      const failed = await runSetup(run, node, path.workspace, attempt.number)
      if (stopping.has(run.id)) return false
      if (failed) { await block(run, failed); return false }
    }
    run.tokens = [...run.tokens.filter(other => other.id !== token.id), ...section.paths.map(path => ({ id: crypto.randomUUID(), nodeId: path.firstNodeId, pathId: path.pathId, workspace: path.workspace, state: 'ready' as const, attempt: null, from: [attempt.number] }))]
    return true
  }
  function plannedPaths(run: WorkflowRun, token: WorkflowToken, node: WorkflowNode, attempt: WorkflowAttempt, dirOf: (pathId: string, branch: string) => string): PlannedPath[] {
    const stem = token.pathId === 'main' ? '' : `${token.pathId}.`
    return passTargets(run.workflow, node.id).map((firstNodeId, index) => {
      const pathId = `${stem}a${attempt.number}-${index + 1}`
      const branch = `flow-${run.id.slice(0, 8)}-${pathId}`
      const dir = dirOf(pathId, branch)
      return { pathId, branch, dir, workspace: dir, firstNodeId }
    })
  }
  function plannedShape(run: WorkflowRun, token: WorkflowToken): FlowShape | undefined {
    return run.attempts.filter(attempt => kindOf(run, attempt) === 'plan' && attempt.shape && lineage(attempt.pathId, token.pathId)).at(-1)?.shape
  }
  async function reposForSplit(run: WorkflowRun, token: WorkflowToken, folder: string, repos: string[]): Promise<string[] | string> {
    const shape = plannedShape(run, token)
    const missing = shape ? shapeRepoNames(shape).filter(name => !repos.includes(name)) : []
    if (missing.length === 0) return repos.length > 0 ? repos : 'Parallel paths need at least one repo copy in this workspace; ask for the repos first'
    if (token.workspace !== run.cwd) return `This path has no copy of ${missing.join(', ')}; only the run's own workspace can add repos`
    if (repos.length + missing.length > MAX_QUEUE_REPOS) return `The split needs more than ${MAX_QUEUE_REPOS} repos`
    try {
      await prepareRepoWorkspace(folder, [...repos, ...missing], basename(token.workspace))
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return [...repos, ...missing]
  }
  async function forkRepos(run: WorkflowRun, token: WorkflowToken, node: WorkflowNode, attempt: WorkflowAttempt, joinId: string, current: string[]): Promise<boolean> {
    const folder = await workspaceFolder(token.workspace)
    const repos = await reposForSplit(run, token, folder, current)
    if (typeof repos === 'string') { await block(run, repos); return false }
    const paths = plannedPaths(run, token, node, attempt, (_, branch) => join(folder, '.worktree', branch))
    const repoSnapshots = await snapshotRepos(token.workspace, repos, `${run.label}: snapshot before ${node.title}`)
    const section: OpenSection = { fork: node.id, join: joinId, forkAttempt: attempt.number, parentPathId: token.pathId, parentWorkspace: token.workspace, snapshot: '', joined: [], paths, folder, repoSnapshots }
    return startPaths(run, token, node, attempt, section, async path => {
      try {
        path.workspace = await preparePathWorkspace(folder, repos, path.branch, repoSnapshots)
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
  }
  async function fork(run: WorkflowRun, token: WorkflowToken, node: WorkflowNode, attempt: WorkflowAttempt): Promise<boolean> {
    const closing = forkSections(run.workflow).find(section => section.fork === node.id)
    if (!closing) throw new Error(`${node.title} paths must meet at one join`)
    const parentWorkspace = token.workspace
    const repos = await workspaceRepos(parentWorkspace)
    if (repos !== null) return forkRepos(run, token, node, attempt, closing.join, repos)
    const top = await gitTimed(parentWorkspace, GIT_TIMEOUT, ['rev-parse', '--show-toplevel'])
    const prefix = (await gitTimed(parentWorkspace, GIT_TIMEOUT, ['rev-parse', '--show-prefix'])).replace(/\/$/, '')
    await mkdir(join(root, run.id), { recursive: true, mode: 0o700 })
    const base = await realpath(join(root, run.id))
    if (!base.startsWith(await realpath(homedir()) + sep)) { await block(run, 'Path worktrees must be under your home directory'); return false }
    const paths = plannedPaths(run, token, node, attempt, pathId => join(base, pathId)).map(path => ({ ...path, workspace: prefix ? join(path.dir, prefix) : path.dir }))
    const snapshot = await snapshotCommit(parentWorkspace, `${run.label}: snapshot before ${node.title}`)
    const section: OpenSection = { fork: node.id, join: closing.join, forkAttempt: attempt.number, parentPathId: token.pathId, parentWorkspace, snapshot, joined: [], paths }
    return startPaths(run, token, node, attempt, section, async path => {
      await addPathWorktree(top, path.dir, path.branch, snapshot)
      const workspace = await realpath(path.workspace).catch(() => null)
      if (!workspace) return `${prefix} is not in the path's worktree (it holds only ignored files)`
      path.workspace = workspace
      return null
    })
  }
  function sectionOf(run: WorkflowRun, pathId: string): { section: OpenSection; path: PlannedPath } | undefined {
    for (const section of run.sections) {
      const path = section.paths.find(entry => entry.pathId === pathId)
      if (path) return { section, path }
    }
    return undefined
  }
  function finishedOnPath(run: WorkflowRun, pathId: string): WorkflowAttempt | undefined {
    return run.attempts.filter(attempt => (attempt.pathId === pathId || attempt.pathId.startsWith(`${pathId}.`)) && attempt.status === 'settled' && !attempt.interrupted && attempt.result !== null).at(-1)
  }
  async function restorePath(run: WorkflowRun, token: WorkflowToken): Promise<string | null> {
    const found = sectionOf(run, token.pathId)
    if (!found?.section.repoSnapshots || !found.section.folder) return null
    const repos = Object.keys(found.section.repoSnapshots)
    if (await pathWorkspaceIntact(found.path.dir, repos)) return null
    const done = finishedOnPath(run, found.path.pathId)
    if (done) return `The path workspace ${found.path.dir} was deleted after ${run.workflow.nodes.find(node => node.id === done.nodeId)?.title ?? done.nodeId} finished; its work is gone. Start the run again.`
    try {
      await restorePathWorkspace(found.section.folder, repos, found.path.branch, found.section.repoSnapshots)
      return null
    } catch (error) {
      return `The path workspace ${found.path.dir} could not be restored: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  function joinable(run: WorkflowRun): OpenSection | undefined {
    return run.sections.find(section => section.paths.every(path => run.tokens.some(token => token.pathId === path.pathId && token.state === 'waiting' && token.nodeId === section.join)))
  }
  async function closeRepoSection(run: WorkflowRun, section: OpenSection, keep: (pathId: string) => boolean): Promise<string[]> {
    const errors: string[] = []
    const repos = Object.keys(section.repoSnapshots ?? {})
    for (const path of section.paths) {
      const failed = await removePathWorkspace(section.folder!, repos, path.dir, path.branch, keep(path.pathId))
      errors.push(...failed.map(error => `${path.pathId}: ${error}`))
      deps.manager.releaseWorkspace(path.workspace, run.id)
    }
    return errors
  }
  async function closeSection(run: WorkflowRun, section: OpenSection, keep: (pathId: string) => boolean): Promise<string[]> {
    if (section.repoSnapshots) return closeRepoSection(run, section, keep)
    const errors: string[] = []
    const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
    const top = await gitTimed(section.parentWorkspace, GIT_TIMEOUT, ['rev-parse', '--show-toplevel']).catch(error => { errors.push(reason(error)); return null })
    for (const path of section.paths) {
      if (top) await removePathWorktree(top, path.dir, path.branch, keep(path.pathId)).catch(error => { errors.push(`${path.pathId}: ${reason(error)}`) })
      deps.manager.releaseWorkspace(path.workspace, run.id)
    }
    return errors
  }
  async function joinedCount(section: OpenSection, path: OpenSection['paths'][number]): Promise<number> {
    return section.counts?.[path.pathId] ?? await changedFileCount(section.parentWorkspace, section.snapshot, path.branch).catch(() => 0)
  }
  type Joining = { counts: string[]; conflict: { pathId: string; files: string[] } | null }
  async function joinRepoPathInto(run: WorkflowRun, section: OpenSection, path: PlannedPath): Promise<{ files: number } | { conflicts: string[] }> {
    const pending = Object.entries(section.repoSnapshots!).filter(([name]) => !section.joinedRepos?.[path.pathId]?.includes(name))
    const conflicts: string[] = []
    for (const [name, snapshot] of pending) {
      const checked = await joinRepoPath(section.parentWorkspace, path.dir, name, snapshot, true)
      if (!checked.applied) conflicts.push(...checked.conflicts)
    }
    if (conflicts.length > 0) return { conflicts }
    for (const [name, snapshot] of pending) {
      const joined = await joinRepoPath(section.parentWorkspace, path.dir, name, snapshot)
      if (!joined.applied) return { conflicts: joined.conflicts }
      section.joinedRepos = { ...section.joinedRepos, [path.pathId]: [...(section.joinedRepos?.[path.pathId] ?? []), name] }
      section.counts = { ...section.counts, [path.pathId]: (section.counts?.[path.pathId] ?? 0) + joined.files }
      await persist(run)
    }
    return { files: section.counts?.[path.pathId] ?? 0 }
  }
  async function applyRepoSection(run: WorkflowRun, section: OpenSection, title: (id: string) => string): Promise<Joining> {
    const repos = Object.keys(section.repoSnapshots!)
    for (const path of section.paths.filter(path => !section.joined.includes(path.pathId))) await commitRepoPath(path.dir, repos, `${run.label}: ${title(path.firstNodeId)}`)
    const counts: string[] = []
    for (const path of section.paths) {
      if (section.joined.includes(path.pathId)) { counts.push(`${path.pathId}: ${section.counts?.[path.pathId] ?? 0} files`); continue }
      const joined = await joinRepoPathInto(run, section, path)
      if ('conflicts' in joined) return { counts, conflict: { pathId: path.pathId, files: joined.conflicts } }
      section.joined.push(path.pathId)
      counts.push(`${path.pathId}: ${joined.files} files`)
      await persist(run)
    }
    return { counts, conflict: null }
  }
  async function applySection(run: WorkflowRun, section: OpenSection): Promise<Joining> {
    const title = (id: string) => run.workflow.nodes.find(node => node.id === id)?.title ?? id
    if (section.repoSnapshots) return applyRepoSection(run, section, title)
    const open = section.paths.filter(path => !section.joined.includes(path.pathId))
    for (const path of open) await commitPath(path.dir, `${run.label}: ${title(path.firstNodeId)}`)
    const counts: string[] = []
    for (const path of section.paths) {
      if (section.joined.includes(path.pathId)) { counts.push(`${path.pathId}: ${await joinedCount(section, path)} files`); continue }
      const head = await gitTimed(path.dir, GIT_TIMEOUT, ['rev-parse', 'HEAD'])
      const applied = await applyPath(section.parentWorkspace, section.snapshot, head)
      if (!applied.applied) return { counts, conflict: { pathId: path.pathId, files: applied.conflicts } }
      section.joined.push(path.pathId)
      section.counts = { ...section.counts, [path.pathId]: applied.files }
      counts.push(`${path.pathId}: ${applied.files} files`)
      await persist(run)
    }
    return { counts, conflict: null }
  }
  async function joinPaths(run: WorkflowRun, section: OpenSection): Promise<void> {
    const node = run.workflow.nodes.find(node => node.id === section.join)!
    const limit = visitLimit(run, node, attempt => attempt.result?.outcome !== 'blocked')
    if (limit) return block(run, limit)
    const waiting = run.tokens.filter(token => token.state === 'waiting' && token.nodeId === section.join && section.paths.some(path => path.pathId === token.pathId))
    const attempt: WorkflowAttempt = { nodeId: node.id, number: run.attempts.length, jobId: null, status: 'running', prompt: '', startedAt: Date.now(), endedAt: null, result: null, checks: [], output: '', workspace: null, tokenId: crypto.randomUUID(), pathId: section.parentPathId, from: waiting.flatMap(token => token.from) }
    run.attempts.push(attempt)
    await persist(run)
    const settleAttempt = (result: NodeResult) => Object.assign(attempt, { status: 'settled', endedAt: Date.now(), result })
    let joining: Joining
    try { joining = await applySection(run, section) } catch (error) {
      const summary = error instanceof Error ? error.message : 'Join failed'
      settleAttempt({ outcome: 'blocked', summary, evidence: [] })
      return block(run, summary)
    }
    const unjoined = section.paths.filter(path => !section.joined.includes(path.pathId))
    const { conflict } = joining
    const files = conflict?.files.join(', ')
    const conflictEvidence = conflict ? [`Joined: ${section.joined.join(', ') || 'none'}`, `Conflicts in ${conflict.pathId}: ${files}`] : []
    if (conflict && !run.workflow.edges.some(edge => edge.source === node.id && edge.outcome === 'fail')) {
      const summary = `Paths could not be joined: ${files}`
      settleAttempt({ outcome: 'blocked', summary, evidence: conflictEvidence })
      return block(run, summary)
    }
    const result: NodeResult = conflict
      ? { outcome: 'fail', summary: `Paths could not be joined: ${files}`, evidence: [...conflictEvidence, `Unjoined paths kept on branches: ${unjoined.map(path => path.branch).join(', ')} (they include a snapshot of your uncommitted files; delete them before pushing all branches)`] }
      : { outcome: 'pass', summary: `Joined ${section.paths.length} paths`, evidence: joining.counts }
    if (conflict) run.keptBranches.push(...unjoined.map(path => path.branch))
    settleAttempt(result)
    attempt.workspace = await workspaceSnapshot(section.parentWorkspace)
    run.sections = run.sections.filter(open => open !== section)
    const parent: WorkflowToken = { id: attempt.tokenId, nodeId: node.id, pathId: section.parentPathId, workspace: section.parentWorkspace, state: 'settled', attempt: attempt.number, from: attempt.from }
    run.tokens = [...run.tokens.filter(token => !waiting.includes(token)), parent]
    await persist(run)
    const cleanup = await closeSection(run, section, pathId => unjoined.some(path => path.pathId === pathId))
    if (cleanup.length) attempt.result = { ...result, evidence: [...result.evidence, ...cleanup.map(error => `Cleanup failed: ${error}`)] }
    await route(run, parent)
  }
  async function shapeOf(run: WorkflowRun, output: string): Promise<{ shape: FlowShape } | { errors: string[] } | null> {
    const read = readShape(output)
    if (!read || 'errors' in read) return read
    const errors = checkShape(read.shape, run.workflow)
    if (errors.length) return { errors }
    const repoErrors = await shapeRepoProblems(read.shape, run.cwd)
    return repoErrors.length ? { errors: repoErrors } : read
  }
  async function keepShape(run: WorkflowRun, attempt: WorkflowAttempt): Promise<string[]> {
    const planned = await shapeOf(run, attempt.output)
    if (!planned) return []
    if ('errors' in planned) return planned.errors
    attempt.shape = planned.shape
    return []
  }
  async function proposeShape(run: WorkflowRun, check: WorkflowAttempt): Promise<void> {
    if (kindOf(run, check) !== 'verify-plan' || check.result?.outcome !== 'pass' || changePending(run) || !shapeTarget(run.workflow)) return
    const plan = run.attempts.filter(attempt => attempt.number < check.number && lineage(attempt.pathId, check.pathId) && kindOf(run, attempt) === 'plan').at(-1)
    if (!plan?.shape) return
    const target = shapeTarget(run.workflow)!
    const reason = `Plan splits the work into ${plan.shape.paths.length} parallel paths: ${plan.shape.paths.map(path => path.title).join(', ')}`
    const repos = await workspaceRepos(run.cwd)
    const graph = shapeGraph(run.workflow, plan.shape, repos === null ? undefined : [...new Set([...repos, ...shapeRepoNames(plan.shape)])])
    const inherited = Object.fromEntries(graph.nodes.filter(node => node.kind !== 'join').map(node => [node.id, run.agents[node.id] ?? run.agents[target.execute]!]))
    try {
      const version = await versionFor(run, { graph, reason }, null, inherited)
      run.versions.push(version)
      if (version.state === 'approved') applyVersion(run, version)
    } catch (error) {
      check.result = { ...check.result, evidence: [...check.result.evidence, `Flow shape not applied: ${error instanceof Error ? error.message : String(error)}`] }
    }
  }
  async function advance(run: WorkflowRun): Promise<void> {
    try {
      if (stopping.has(run.id) || run.status !== 'running' || changePending(run) || incoming.has(run.id)) return await persist(run)
      for (const token of run.tokens.filter(token => token.state === 'settled')) if (!await route(run, token)) return
      for (let section = joinable(run); section; section = joinable(run)) {
        await joinPaths(run, section)
        if (run.status !== 'running') return
      }
      for (const token of run.tokens.filter(token => token.state === 'ready')) {
        if (token.state !== 'ready' || !run.tokens.includes(token)) continue
        await dispatch(run, token)
        if (run.status !== 'running') return
      }
      await persist(run)
    } catch (error) { await block(run, error instanceof Error ? error.message : 'Workflow failed to continue') }
  }
  async function guarded(run: WorkflowRun, action: () => Promise<Checking | null>): Promise<Checking | null> {
    try { return await action() } catch (error) {
      await block(run, error instanceof Error ? error.message : 'Workflow settlement failed')
      return null
    }
  }
  async function check(run: WorkflowRun, checking: Checking | null): Promise<void> {
    if (!checking) return
    const outcome = await acceptance(run, checking)
    await exclusive(run.id, () => guarded(run, async () => { await conclude(run, checking.attempt, checking.token, outcome.result, outcome.checks); return null }))
  }
  async function settleJob(run: WorkflowRun, record: JobRecord): Promise<void> {
    await check(run, await exclusive(run.id, () => guarded(run, async () => {
      if (run.status === 'running' || run.status === 'paused') return settle(run, record)
      await persist(run)
      return null
    })))
  }
  async function tracked<T>(id: string, work: Promise<T>): Promise<T> {
    const inFlight = settling.get(id) ?? new Set<Promise<void>>()
    const done = work.then(() => {}, () => {})
    settling.set(id, inFlight.add(done))
    try { return await work } finally {
      inFlight.delete(done)
      if (!inFlight.size) settling.delete(id)
    }
  }
  async function onJobSettled(record: JobRecord): Promise<void> {
    if (!record.workflowRunId || record.status === 'running') return
    const run = runs.get(record.workflowRunId)
    if (!run) return
    await tracked(run.id, settleJob(run, record))
  }
  function waitingInSession(run: WorkflowRun, nodeId: string): WorkflowToken | undefined {
    if ((run.status !== 'running' && run.status !== 'paused') || stopping.has(run.id)) return undefined
    return run.tokens.find(token => {
      const attempt = token.state === 'working' ? run.attempts[token.attempt!] : undefined
      return attempt?.inSession && attempt.nodeId === nodeId && attempt.status === 'running'
    })
  }
  function waitingStep(id: string, nodeId: string) {
    const run = mustGet(id)
    const token = waitingInSession(run, nodeId)
    if (!token) throw new RunActionError('That step is not waiting for the session', 404)
    const attempt = run.attempts[token.attempt!]!
    const node = run.workflow.nodes.find(node => node.id === nodeId)!
    return { runId: run.id, nodeId, title: node.title, kind: node.kind, prompt: attempt.prompt, waitingSince: attempt.startedAt }
  }
  async function changedCode(attempt: WorkflowAttempt, cwd: string): Promise<boolean> {
    const before = attempt.workspaceSnapshot
    if (!before) return false
    const now = await workspaceSnapshot(cwd)
    return now.head !== before.head || now.diffHash !== before.diffHash
  }
  async function report(id: string, nodeId: string, value: unknown, context: ApprovalContext): Promise<WorkflowRun> {
    const accepting = exclusive(id, async () => {
      const run = mustGet(id)
      if (context.via !== 'conversation') throw new RunActionError('Only the session that owns this flow can report its step', 403)
      owned(run, context)
      const { output, ...reported } = stepReportSchema.parse(value)
      if (reported.outcome === 'pass' && !reported.evidence.length) throw new Error('A passing step needs evidence')
      const token = waitingInSession(run, nodeId)
      if (!token) throw new RunActionError('That step is not waiting for the session', 409)
      const attempt = run.attempts[token.attempt!]!
      if (reported.outcome === 'pass' && kindOf(run, attempt) === 'plan' && await changedCode(attempt, token.workspace)) throw new RunActionError('A plan step must not change code', 409)
      const redact = (text: string) => redactRunOutput(run, text)
      const redactedOutput = await redact(output ?? reported.summary)
      const planned = reported.outcome === 'pass' && kindOf(run, attempt) === 'plan' ? await shapeOf(run, redactedOutput) : null
      if (planned && 'errors' in planned) throw new Error(planned.errors.join('\n'))
      const result: NodeResult = { outcome: reported.outcome, summary: await redact(reported.summary), evidence: await Promise.all(reported.evidence.map(redact)) }
      attempt.output = redactedOutput
      attempt.reportedBy = { via: context.via, id: context.terminalId && context.terminalId === run.terminalId ? context.terminalId : context.chat!, at: Date.now() }
      if (planned) attempt.shape = planned.shape
      return { run, checking: await guarded(run, () => accept(run, attempt, token, result)) }
    })
    const { run, checking } = await tracked(id, accepting)
    const cloned = structuredClone(run)
    void tracked(id, check(run, checking)).catch(error => console.error(`In Session acceptance check failed for run ${id}`, error))
    return cloned
  }
  async function remind(id: string, nodeId: string): Promise<WorkflowRun> {
    const terminalId = await exclusive(id, async () => {
      const run = mustGet(id)
      const token = waitingInSession(run, nodeId)
      if (!token) throw new RunActionError('That step is not waiting for the session', 409)
      const attempt = run.attempts[token.attempt!]!
      if (run.chatId) {
        attempt.sessionNotifiedAt = null
        await persist(run)
        deps.onSessionStep?.(structuredClone(run))
        return null
      }
      const title = run.workflow.nodes.find(node => node.id === nodeId)!.title
      const line = `Shikidan: the flow "${oneLine(run.label)}" is waiting for you at "${oneLine(title)}" (In Session). Read GET ${mcUrl()}/api/studio/runs/${run.id}/steps/${nodeId}, do it here with the user, then report it.`
      followResumedTerminals([run])
      if (!run.terminalId || !deps.terminals?.write?.(run.terminalId, line)) throw new RunActionError('The terminal that owns this flow is closed', 409)
      return run.terminalId
    })
    if (terminalId) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, ENTER_DELAY_MS))
      deps.terminals?.write?.(terminalId, '\r')
    }
    return structuredClone(mustGet(id))
  }
  async function stop(id: string): Promise<WorkflowRun> {
    const run = runs.get(id)
    if (!run) throw new Error('Run not found')
    if (!LIVE_STATUSES.has(run.status)) throw new Error('Run is not running')
    if (run.status === 'awaiting-approval') for (const version of run.versions.filter(version => version.state === 'pending')) Object.assign(version, { state: 'rejected', at: Date.now() })
    stopping.add(id)
    await killWork(run)
    return exclusive(id, async () => {
      try { await finish(run, 'stopped', 'Stopped by user') } finally { stopping.delete(id) }
      return structuredClone(run)
    })
  }
  async function reresolve(run: WorkflowRun): Promise<void> {
    const root = run.chatId ? deps.manager.getJob(run.chatId) : undefined
    run.agents = await agentsFor(run.workflow, root ? { engine: root.engine, model: root.model ?? null } : undefined, sessionOf(run))
    await preflight(run)
  }
  async function retry(id: string): Promise<WorkflowRun> {
    return exclusive(id, async () => {
      const run = runs.get(id)
      if (!run) throw new Error('Run not found')
      if (LIVE_STATUSES.has(run.status) || run.status === 'done') throw new Error('Only failed, blocked or stopped runs can be retried')
      if (run.versions[0]?.state !== 'approved') throw new RunActionError('Approve the flow before retrying', 409)
      if (workspaceBusy(run.cwd, id) || deps.manager.listJobs().some(job => job.workflowRunId === id && job.status === 'running')) throw new Error('Workspace still has running work')
      if (run.attempts.some(attempt => processAlive(attempt.checkPid))) throw new Error('The interrupted acceptance process may still be running; inspect it before retrying')
      await reresolve(run)
      delete run.unavailable
      interrupt(run)
      if (!deps.manager.claimWorkspace(run.cwd, run.id)) throw new Error('Workspace already has running work')
      const taken = claimPaths(run)
      if (taken) { deps.manager.releaseWorkspace(run.cwd, run.id); throw new Error(`Another run owns ${taken}`) }
      run.status = 'running'; run.error = null; run.dismissedAt = null
      if (run.chatId) run.reportedAt = null
      await advance(run)
      return structuredClone(run)
    })
  }
  async function recover(): Promise<void> {
    for (const run of runs.values()) {
      const unsettled = run.attempts.filter(attempt => attempt.status !== 'settled')
      if (run.status === 'awaiting-approval' || ((run.status === 'paused' || (run.status === 'running' && changePending(run))) && !unsettled.length)) {
        const taken = deps.manager.claimWorkspace(run.cwd, run.id) ? claimPaths(run) : 'this workspace'
        if (taken) await block(run, `Another run owns ${taken}`)
        continue
      }
      if (run.status !== 'running' && run.status !== 'paused') { if (run.attempts.some(attempt => processAlive(attempt.checkPid))) deps.manager.claimWorkspace(run.cwd, run.id); continue }
      if (!deps.manager.claimWorkspace(run.cwd, run.id)) { await block(run, 'Another run owns this workspace'); continue }
      const taken = claimPaths(run)
      if (taken) { await block(run, `Another run owns ${taken}`); continue }
      if (unsettled.some(attempt => kindOf(run, attempt) === 'join')) { await block(run, 'Join interrupted; Retry resumes it'); continue }
      const waiting = unsettled.filter(attempt => attempt.inSession && attempt.status === 'running')
      const orphaned = sessionOf(run) ? undefined : waiting[0]
      if (orphaned) { await block(run, sessionClosed(run.workflow.nodes.find(node => node.id === orphaned.nodeId)?.title ?? orphaned.nodeId)); continue }
      const adopted = unsettled.filter(attempt => !waiting.includes(attempt)).map(attempt => ({ attempt, job: attemptJob(run, attempt) }))
      const broken = adopted.find(({ attempt, job }) => !job || attempt.status === 'checking')
      if ((!adopted.length && !waiting.length) || broken) { await block(run, `Interrupted transition or acceptance check; inspect evidence${broken?.attempt.checkPid ? ` and process ${broken.attempt.checkPid}` : ''} before retrying`); continue }
      for (const { attempt, job } of adopted) {
        attempt.jobId = job!.id; attempt.status = 'running'
        const token = run.tokens.find(token => token.id === attempt.tokenId)
        if (token) Object.assign(token, { nodeId: attempt.nodeId, state: 'working', attempt: attempt.number })
      }
      await persist(run)
      for (const { job } of adopted) if (job!.status !== 'running') await onJobSettled(job!)
    }
  }
  function attemptJob(run: WorkflowRun, attempt: WorkflowAttempt): JobRecord | undefined {
    const jobs = deps.manager.listJobs().filter(job => job.workflowRunId === run.id && job.workflowAttempt === attempt.number)
    return (attempt.nudgedFrom ? jobs.find(job => job.id !== attempt.nudgedFrom) : undefined) ?? jobs.find(job => job.id === attempt.jobId) ?? jobs[0]
  }
  function owned(run: WorkflowRun, context: ApprovalContext): void {
    if (context.via !== 'conversation') return
    followResumedTerminals([run])
    const matches = (context.chat && context.chat === run.chatId) || (context.terminalId && context.terminalId === run.terminalId)
    if (!matches) throw new RunActionError('This flow belongs to a different session', 403)
  }
  function pendingVersion(run: WorkflowRun, context: ApprovalContext): RunVersion {
    const version = run.versions.find(version => version.state === 'pending')
    if (!version) throw new RunActionError('Nothing is waiting for approval', 409)
    if (context.version !== undefined && context.version !== version.number) throw new RunActionError('That version is no longer waiting', 409)
    return version
  }
  function mustGet(id: string): WorkflowRun {
    const run = runs.get(id)
    if (!run) throw new RunActionError('Run not found', 404)
    return run
  }
  async function approve(id: string, context: ApprovalContext): Promise<WorkflowRun> {
    return exclusive(id, async () => {
      const run = mustGet(id)
      owned(run, context)
      const version = pendingVersion(run, context)
      if (version.number > 1) guardChange(run, version.graph!)
      Object.assign(version, { state: 'approved', approvedVia: context.via, relayedBy: context.via === 'conversation' ? run.origin.by : null, at: Date.now() })
      if (version.number > 1) { applyVersion(run, version); await advance(run) }
      else if (run.status === 'awaiting-approval') { run.status = 'running'; await advance(run) } else await persist(run)
      return structuredClone(run)
    })
  }
  async function reject(id: string, context: ApprovalContext): Promise<WorkflowRun> {
    return exclusive(id, async () => {
      const run = mustGet(id)
      owned(run, context)
      const version = pendingVersion(run, context)
      Object.assign(version, { state: 'rejected', at: Date.now() })
      if (version.number > 1) await advance(run)
      else if (run.status === 'awaiting-approval') await finish(run, 'stopped', 'Flow rejected')
      else await persist(run)
      return structuredClone(run)
    })
  }
  function applyVersion(run: WorkflowRun, version: RunVersion): void {
    run.workflow = version.graph!
    run.agents = version.agents!
    run.skills = { ...run.skills, ...version.skills }
  }
  async function propose(id: string, change: RunChange, context: ApprovalContext): Promise<WorkflowRun> {
    mustGet(id)
    incoming.set(id, (incoming.get(id) ?? 0) + 1)
    await Promise.allSettled([...settling.get(id) ?? []])
    return exclusive(id, async () => {
      incoming.set(id, incoming.get(id)! - 1)
      if (!incoming.get(id)) incoming.delete(id)
      const run = mustGet(id)
      let version: RunVersion
      try { version = await versionFor(run, change, context) }
      catch (error) {
        if (run.status === 'running' || run.status === 'paused') await advance(run)
        throw error
      }
      run.versions.push(version)
      if (version.state === 'pending') await persist(run)
      else { applyVersion(run, version); await advance(run) }
      return structuredClone(run)
    })
  }
  async function versionFor(run: WorkflowRun, change: RunChange, context: ApprovalContext | null, inherited: Record<string, ResolvedAgent> = {}): Promise<RunVersion> {
    if (context) owned(run, context)
    if (!LIVE_STATUSES.has(run.status)) throw new RunActionError('Only a live flow can change', 409)
    if (run.versions.some(version => version.state === 'pending')) throw new RunActionError('A change is already waiting', 409)
    const next = draftRevision(change.graph)
    guardChange(run, next)
    const ran = new Set(run.attempts.map(attempt => attempt.nodeId))
    const kept = Object.fromEntries(Object.entries(run.agents).filter(([nodeId]) => ran.has(nodeId)))
    const agents = { ...await agentsFor(next, undefined, sessionOf(run)), ...inherited, ...kept }
    const skills = Object.fromEntries(await Promise.all(next.nodes.filter(node => !ran.has(node.id)).map(async node => [node.id, await snapshotSkills(node, run.cwd)] as const)))
    const size = changeSize(run, next, agents, !!change.scopeGrew, positionsOf(run))
    const waits = (size === 'big' && await requireApproval()) || (context?.via === 'conversation' && commandsChanged(run.workflow, next))
    return { number: run.versions.length + 1, revision: next.revision, reason: change.reason, size, state: waits ? 'pending' : 'approved', approvedVia: waits ? null : 'auto', relayedBy: null, at: Date.now(), graph: next, agents, skills }
  }
  async function pause(id: string): Promise<WorkflowRun> {
    const run = mustGet(id)
    if (run.status !== 'running') throw new RunActionError('Only a running flow can be paused', 409)
    run.status = 'paused'
    return exclusive(id, async () => { await persist(run); return structuredClone(run) })
  }
  async function resume(id: string): Promise<WorkflowRun> {
    const resumed = await exclusive(id, async () => {
      const run = mustGet(id)
      if (run.status !== 'paused') throw new RunActionError('Only a paused flow can be resumed', 409)
      run.status = 'running'
      await advance(run)
      return structuredClone(run)
    })
    for (const job of heldJobs(mustGet(id))) void onJobSettled(job).catch(error => block(mustGet(id), String(error)))
    return resumed
  }
  async function dismiss(id: string): Promise<WorkflowRun> {
    return exclusive(id, async () => {
      const run = mustGet(id)
      if (run.status !== 'blocked' && run.status !== 'failed') throw new RunActionError('Only failed or blocked runs can be dismissed', 409)
      run.dismissedAt = Date.now()
      await persist(run)
      return structuredClone(run)
    })
  }
  async function markSessionNotified(id: string, attempt: number, at: number): Promise<void> {
    await exclusive(id, async () => {
      const run = runs.get(id)
      const notified = run?.attempts[attempt]
      if (!run || !notified?.inSession) return
      notified.sessionNotifiedAt = at
      await persist(run)
    })
  }
  async function markReported(id: string, at: number): Promise<void> {
    await exclusive(id, async () => {
      const run = runs.get(id)
      if (!run) return
      run.reportedAt = at
      await persist(run)
    })
  }
  return { start, stop, retry, dismiss, recover, approve, reject, propose, pause, resume, onJobSettled, report, waitingStep, remind, markSessionNotified, markReported, get: (id: string) => { const run = runs.get(id); return run ? structuredClone(run) : undefined }, list: () => { followResumedTerminals([...runs.values()]); return [...runs.values()].map(run => structuredClone(run)).sort((a, b) => b.createdAt - a.createdAt) } }
}
export type WorkflowRunner = ReturnType<typeof createWorkflowRunner>
