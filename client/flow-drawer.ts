import type { QuickJobView, RunAttemptView, RunView, ScopeSnapshot } from '../server/run-view'
import { confirmButton } from './confirm-button'
import { describeCard, renderRunGraph, type EdgeState, type GraphEdge, type GraphStep, type StepState } from './flow-graph'
import { mountViewport } from './flow-viewport'
import { rollText } from './morph'
import { errorText, postJson, providerName, putJson } from './shared'

type RunAction = 'approve' | 'reject' | 'retry' | 'dismiss' | 'stop' | 'pause' | 'resume'
type BannerAction = 'approve' | 'reject' | 'retry' | 'stop' | 'keep' | 'approval-on' | 'remind'
type Banner = { tone: 'ask' | 'problem' | 'notice' | null; text: string; actions: BannerAction[] }
type Edge = RunView['edges'][number]
type StepStatus = { state: StepState; detail: string; since?: number }
type Section = RunView['sections'][number]
type Composed = { steps: GraphStep[]; edges: GraphEdge[]; bands: Section[] }
type Point = { x: number; y: number }
type MenuEntry = { value: string; label: string }
export type DrawerView = { kind: 'all'; runs: RunView[] } | { kind: 'one'; run: RunView } | { kind: 'none' }
export type RunMenu = { all: MenuEntry | null; live: MenuEntry[]; finished: MenuEntry[] }
export type RowDetail = { text: string; problem: boolean; label?: string; since?: number }

export const ALL_FLOWS = 'all'

const LIVE = new Set(['awaiting-approval', 'running', 'paused'])
const SUMMARY_CHARS = 60
const TICK_MS = 1000
const EMPTY_TITLE = 'Session flow'
const MISSING_JOB = "That step’s job is no longer available."
const NOTICE_MS = 4000
const NO_BANNER: Banner = { tone: null, text: '', actions: [] }
const SVG_NS = 'http://www.w3.org/2000/svg'
const ROW_INSET_X = 24
const ROW_INSET_Y = 12
const ROW_CONTROLS = ['flow-row-open', 'flow-primary', 'text-button']

const isLive = (run: RunView): boolean => LIVE.has(run.status)
const pad = (value: number): string => String(value).padStart(2, '0')
const inOrder = (run: RunView): RunAttemptView[] => [...run.attempts].sort((a, b) => a.number - b.number)

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
}

function reachableByPass(run: RunView): Set<string> {
  const seen = new Set([run.entry])
  const queue = [run.entry]
  while (queue.length) {
    const id = queue.shift()!
    for (const edge of run.edges) {
      if (edge.source !== id || edge.outcome !== 'pass' || seen.has(edge.target)) continue
      seen.add(edge.target)
      queue.push(edge.target)
    }
  }
  return seen
}

function titleOf(run: RunView, id: string): string {
  return [...run.nodes, ...(run.proposal?.nodes ?? [])].find(node => node.id === id)?.title ?? id
}

const sameEdge = (a: Edge, b: Edge): boolean => a.source === b.source && a.target === b.target && a.outcome === b.outcome

export function activeVersion(run: RunView): number {
  return run.versions.filter(version => version.state === 'approved').at(-1)?.number ?? 1
}

function routedTarget(run: RunView, token: RunView['tokens'][number]): string {
  const ran = run.attempts.filter(attempt => attempt.nodeId === token.nodeId && (attempt.pathId ?? 'main') === token.pathId && attempt.status === 'settled').at(-1)
  return run.edges.find(edge => edge.source === token.nodeId && edge.outcome === ran?.outcome)?.target ?? token.nodeId
}

function nextUp(run: RunView): Set<string> {
  const ids = new Set<string>()
  for (const token of run.tokens) {
    if (token.state === 'ready') ids.add(token.nodeId)
    if (token.state === 'settled') { ids.add(token.nodeId); ids.add(routedTarget(run, token)) }
  }
  return ids
}

function afterWorking(run: RunView, nodeId: string): boolean {
  const working = new Set(run.tokens.filter(token => token.state === 'working').map(token => token.nodeId))
  return run.edges.some(edge => working.has(edge.source) && edge.target === nodeId && edge.outcome === 'pass')
}

function unstartedStatus(run: RunView, nodeId: string, engine: string, reachable: Set<string>): StepStatus {
  const onFailure = run.edges.find(edge => edge.target === nodeId && edge.outcome !== 'pass')
  if (!reachable.has(nodeId) && onFailure) return { state: 'conditional', detail: `If ${titleOf(run, onFailure.source)} fails` }
  if (run.status === 'awaiting-approval') return { state: 'pending', detail: providerName(engine) }
  if (isLive(run) && nextUp(run).has(nodeId)) return { state: 'pending', detail: run.status === 'paused' ? 'Paused here' : 'Up next' }
  return { state: 'pending', detail: isLive(run) && afterWorking(run, nodeId) ? 'Up next' : 'Waiting' }
}

function waitingAtJoin(run: RunView, nodeId: string, tries: RunAttemptView[]): StepStatus | null {
  const section = run.sections.find(open => open.join === nodeId && open.state === 'open')
  if (!section || !isLive(run) || tries.some(attempt => attempt.status !== 'settled')) return null
  const pathIds = new Set(section.paths.map(path => path.pathId).filter(pathId => pathId !== null))
  const arrived = new Set(run.tokens.filter(token => token.nodeId === nodeId && token.state === 'waiting' && pathIds.has(token.pathId)).map(token => token.pathId))
  return { state: 'pending', detail: `Waiting for ${section.paths.length - arrived.size} of ${section.paths.length}` }
}

function joinedStatus(run: RunView, nodeId: string, status: StepStatus, latest: RunAttemptView): StepStatus {
  if (latest.status !== 'settled') return status
  if (latest.outcome === 'fail') return { ...status, detail: 'Paths could not be joined' }
  if (latest.outcome !== 'pass') return status
  const paths = Number(/^Joined (\d+) paths/.exec(latest.summary ?? '')?.[1] ?? run.edges.filter(edge => edge.target === nodeId && edge.outcome === 'pass').length)
  return { ...status, detail: `Joined ${paths} paths` }
}

function stepStatus(run: RunView, kind: string, nodeId: string, engine: string, tries: RunAttemptView[], reachable: Set<string>, now: number): StepStatus {
  const waiting = kind === 'join' ? waitingAtJoin(run, nodeId, tries) : null
  if (waiting) return waiting
  if (!tries.length) return unstartedStatus(run, nodeId, engine, reachable)
  const status = attemptStatus(run, engine, tries, now)
  return kind === 'join' ? joinedStatus(run, nodeId, status, tries.at(-1)!) : status
}

function attemptStatus(run: RunView, engine: string, tries: RunAttemptView[], now: number): StepStatus {
  const latest = tries.at(-1)!
  const retry = tries.length > 1 ? `Try ${tries.length} · ` : ''
  if (latest.status !== 'settled') {
    if (!isLive(run)) return { state: 'failed', detail: run.status === 'stopped' ? 'Stopped' : 'Did not finish' }
    if (latest.inSession) return { state: 'session', detail: `In Session · ${elapsed(now - latest.startedAt)}`, since: latest.startedAt }
    const subAgents = latest.subAgents ?? 0
    const doing = [tries.length > 1 ? `Try ${tries.length}` : '', subAgents > 0 ? `${subAgents} sub-agent${subAgents === 1 ? '' : 's'}` : ''].filter(Boolean)
    return { state: 'active', detail: `${(doing.length ? doing : ['Working']).join(' · ')} · ${elapsed(now - latest.startedAt)}`, since: latest.startedAt }
  }
  if (latest.outcome === 'pass') return { state: 'done', detail: `${retry}Done · ${elapsed((latest.endedAt ?? now) - latest.startedAt)}` }
  const summary = (latest.summary ?? '').slice(0, SUMMARY_CHARS)
  return { state: 'failed', detail: [latest.outcome === 'blocked' ? 'Blocked' : 'Failed', summary].filter(Boolean).join(' · ') }
}

export function stepsFor(run: RunView, now: number): GraphStep[] {
  const reachable = reachableByPass(run)
  const attempts = inOrder(run)
  const proposal = run.proposal
  const current = run.nodes.map(node => {
    const tries = attempts.filter(attempt => attempt.nodeId === node.id)
    const status = stepStatus(run, node.kind, node.id, node.engine, tries, reachable, now)
    const jobId = tries.filter(attempt => attempt.jobId).at(-1)?.jobId
    const proposed = proposal?.removed.includes(node.id) ? { state: 'removed' as const, detail: `Removed in v${proposal.number}` }
      : !tries.length && proposal?.changed.includes(node.id) ? { state: status.state, detail: `Changed in v${proposal.number}` }
        : status
    return { id: node.id, title: node.title, engine: node.engine, kind: node.kind, ...proposed, ...(jobId ? { jobId } : {}) }
  })
  const known = new Set(run.nodes.map(node => node.id))
  const ghosts = (run.proposal?.nodes ?? []).filter(node => !known.has(node.id))
    .map(node => ({ id: node.id, title: node.title, engine: node.engine, kind: node.kind, state: 'proposed' as const, detail: 'Proposed' }))
  return [...current, ...ghosts]
}

function sourcesOf(attempts: RunAttemptView[], next: RunAttemptView, index: number): RunAttemptView[] {
  if (!next.from?.length) return index > 0 ? [attempts[index - 1]!] : []
  return attempts.filter(attempt => next.from.includes(attempt.number))
}

function takenPairs(run: RunView, edge: Edge): [RunAttemptView, RunAttemptView][] {
  const attempts = inOrder(run)
  const took = (previous: RunAttemptView) => previous.nodeId === edge.source && previous.status === 'settled' && previous.outcome === edge.outcome
  return attempts.flatMap((next, index): [RunAttemptView, RunAttemptView][] => next.nodeId === edge.target
    ? sourcesOf(attempts, next, index).filter(took).map(previous => [previous, next])
    : [])
}

function reachedJoin(run: RunView, edge: Edge): boolean {
  const arrivals = new Set(run.tokens.filter(token => token.nodeId === edge.target && token.state === 'waiting').flatMap(token => token.from))
  return run.attempts.some(attempt => arrivals.has(attempt.number) && attempt.nodeId === edge.source && attempt.status === 'settled' && attempt.outcome === edge.outcome)
}

function edgeState(run: RunView, edge: Edge): EdgeState {
  const pairs = takenPairs(run, edge)
  if (!pairs.length) return reachedJoin(run, edge) ? (edge.outcome === 'pass' ? 'done' : 'failed') : 'idle'
  if (edge.outcome !== 'pass') return 'failed'
  return pairs.at(-1)![1].status !== 'settled' && isLive(run) ? 'flowing' : 'done'
}

function labelled(run: RunView, edge: Edge, state: EdgeState): GraphEdge {
  if (edge.outcome === 'pass') return { ...edge, state }
  const source = titleOf(run, edge.source)
  return { ...edge, state, label: state === 'failed' ? `${source} failed · retried` : `if ${source} fails` }
}

export function edgesFor(run: RunView): GraphEdge[] {
  const proposed = run.proposal?.edges
  const current = run.edges.map(edge => labelled(run, edge, edgeState(run, edge)))
  const added = (proposed ?? []).filter(edge => !run.edges.some(other => sameEdge(other, edge))).map(edge => labelled(run, edge, 'proposed'))
  return [...current, ...added]
}

const sectionBox = (fork: string): string => `section:${fork}`
const byNumber = (a: RunAttemptView, b: RunAttemptView): number => a.number - b.number

function sectionDuration(section: Section, attempts: RunAttemptView[], now: number): string {
  const forked = attempts.filter(attempt => attempt.nodeId === section.fork && attempt.endedAt !== null).sort(byNumber).at(-1)
  const joined = attempts.filter(attempt => attempt.nodeId === section.join && attempt.outcome === 'pass').sort(byNumber).at(-1)
  const members = new Set(section.paths.flatMap(path => path.nodes))
  const starts = attempts.filter(attempt => forked && members.has(attempt.nodeId) && attempt.startedAt >= forked.endedAt!).map(attempt => attempt.startedAt)
  if (!joined || !starts.length) return 'Done'
  return `Done · ${elapsed((joined.endedAt ?? now) - Math.min(...starts))}`
}

function boxStep(section: Section, attempts: RunAttemptView[], now: number): GraphStep {
  return { id: sectionBox(section.fork), title: `Parallel · ${section.paths.map(path => path.title).join(' + ')}`, detail: sectionDuration(section, attempts, now), state: 'done', kind: 'join', engine: '' }
}

function rewire(edges: GraphEdge[], boxOf: Map<string, string>): GraphEdge[] {
  const seen = new Set<string>()
  return edges.flatMap(edge => {
    const source = boxOf.get(edge.source) ?? edge.source, target = boxOf.get(edge.target) ?? edge.target
    if (source === edge.source && target === edge.target) return [edge]
    const key = `${source}>${target}:${edge.outcome}`
    if (source === target || seen.has(key)) return []
    seen.add(key)
    return [{ ...edge, source, target, ...(target !== edge.target ? { state: 'done' as const } : {}) }]
  })
}

export function collapseSections(steps: GraphStep[], edges: GraphEdge[], sections: Section[], expanded: ReadonlySet<string>, attempts: RunAttemptView[], now: number): Composed {
  const boxOf = new Map<string, string>()
  const boxes = new Map<string, GraphStep>()
  const drawn: Section[] = []
  for (const section of sections) {
    if (boxOf.has(section.fork)) continue
    if (section.state !== 'joined' || expanded.has(section.fork)) { drawn.push(section); continue }
    const box = boxStep(section, attempts, now)
    boxes.set(box.id, box)
    for (const member of [...section.paths.flatMap(path => path.nodes), section.join]) boxOf.set(member, box.id)
  }
  const shown = new Set<string>()
  const composedSteps = steps.flatMap(step => {
    const box = boxOf.get(step.id)
    if (!box) return [step]
    if (shown.has(box)) return []
    shown.add(box)
    return [boxes.get(box)!]
  })
  const bands = drawn.map(section => ({ ...section, paths: section.paths.map(path => ({ ...path, nodes: [...new Set(path.nodes.map(id => boxOf.get(id) ?? id))] })) }))
  return { steps: composedSteps, edges: rewire(edges, boxOf), bands }
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function startPhrase(run: RunView): string {
  const version = run.versions[0]
  if (!version || version.state === 'pending') return ''
  if (version.state === 'rejected') return `rejected, ${clock(version.at)}`
  if (version.approvedVia === 'user') return 'started by you'
  if (version.approvedVia === 'drawer') return `approved by you in the drawer, ${clock(version.at)}`
  if (version.approvedVia === 'conversation') return `approved in the conversation (relayed by ${providerName(version.relayedBy ?? run.origin.by)}), ${clock(version.at)}`
  return 'started on its own (approval is off)'
}

function approvalPhrase(run: RunView): string {
  const pending = run.versions.find(version => version.state === 'pending')
  const active = run.versions.filter(version => version.number > 1 && version.state === 'approved').at(-1)
  return [
    startPhrase(run),
    active ? `now on v${active.number}` : '',
    pending ? `${pending.number > 1 ? `v${pending.number} ` : ''}waiting for your approval` : '',
  ].filter(Boolean).join(' · ')
}

export function metaFor(run: RunView): string {
  const by = providerName(run.origin.by)
  const picked = run.origin.where === 'studio' ? 'started from Studio' : `picked by ${by} in ${run.origin.where}`
  const origin = run.origin.source === 'drafted' ? `New flow drafted by ${by} in ${run.origin.where}` : `Saved workflow ${run.workflowName} · ${picked}`
  return [origin, approvalPhrase(run)].filter(Boolean).join(' · ')
}

export function pillsFor(run: RunView): { running: number; done: number; waiting: number } {
  const states = stepsFor(run, Date.now()).map(step => step.state)
  const count = (...wanted: StepState[]): number => states.filter(state => wanted.includes(state)).length
  return { running: count('active', 'session'), done: count('done'), waiting: isLive(run) ? count('pending', 'conditional') : 0 }
}

function waitingInSession(run: RunView): RunView['nodes'][number] | undefined {
  if (!isLive(run)) return undefined
  const waiting = run.attempts.find(attempt => attempt.inSession && attempt.status !== 'settled')
  return waiting && run.nodes.find(node => node.id === waiting.nodeId)
}

function problemText(run: RunView): string {
  const word = run.status === 'blocked' ? 'Blocked' : 'Failed'
  return run.error ? `${word}: ${run.error}` : word
}

export function bannerFor(run: RunView): Banner {
  const by = providerName(run.origin.by)
  if (run.status === 'awaiting-approval' && run.versions.some(version => version.state === 'pending')) {
    const asked = run.origin.source === 'drafted' ? `${by} drafted a flow for this task.` : `${by} picked "${run.workflowName}" for this task.`
    return { tone: 'ask', text: `${asked} Nothing runs until you approve, or say "go" to ${by}.`, actions: ['reject', 'approve'] }
  }
  if (run.proposal) return { tone: 'ask', text: `${by} wants to change the flow. ${run.proposal.reason}`, actions: ['keep', 'approve'] }
  if (run.status === 'blocked' || run.status === 'failed') return { tone: 'problem', text: problemText(run), actions: ['retry'] }
  const inSession = waitingInSession(run)
  if (inSession) return { tone: 'notice', text: `${inSession.title} is being done In Session by ${providerName(inSession.engine)}. Talk to it here; the flow continues when it reports the step.`, actions: ['remind'] }
  const change = run.latestChange
  if (change?.size === 'big' && change.approvedVia === 'auto' && isLive(run)) {
    return { tone: 'notice', text: `v${change.number} applied automatically. ${change.reason} Approval is off, so it did not wait.`, actions: ['approval-on'] }
  }
  return NO_BANNER
}

export function pickRun(runs: RunView[], pinned: string | null): RunView | null {
  const kept = runs.find(run => run.id === pinned)
  if (kept) return kept
  const newestFirst = [...runs].sort((a, b) => b.createdAt - a.createdAt)
  return newestFirst.find(isLive) ?? newestFirst[0] ?? null
}

export function needsYou(run: RunView): boolean {
  return (run.status === 'blocked' || run.status === 'failed') && !run.dismissed
}

const byNewest = (a: RunView, b: RunView): number => b.createdAt - a.createdAt

export type PillCount = readonly [state: string, count: number, word: string]

export function allFlowsPills(rows: RunView[]): PillCount[] {
  const count = (status: string): number => rows.filter(run => needsYou(run) && run.status === status).length
  return ([['needs', count('blocked'), 'blocked'], ['needs', count('failed'), 'failed'], ['running', rows.filter(isLive).length, 'running']] as const)
    .filter(([, total]) => total > 0)
}

export function rowRuns(runs: RunView[]): RunView[] {
  const shown = runs.filter(run => isLive(run) || needsYou(run)).sort(byNewest)
  return [...shown.filter(needsYou), ...shown.filter(run => !needsYou(run))]
}

export function drawerView(runs: RunView[], selected: string | null): DrawerView {
  const picked = runs.find(run => run.id === selected)
  if (picked) return { kind: 'one', run: picked }
  const rows = rowRuns(runs)
  if ((selected === null || selected === ALL_FLOWS) && rows.length > 1) return { kind: 'all', runs: rows }
  const run = pickRun(runs, selected)
  return run ? { kind: 'one', run } : { kind: 'none' }
}

const menuEntry = (run: RunView): MenuEntry => ({ value: run.id, label: `${run.label} · ${run.status}` })

export function runMenu(runs: RunView[]): RunMenu {
  const rows = rowRuns(runs)
  const inRows = new Set(rows.map(run => run.id))
  return {
    all: rows.length > 1 ? { value: ALL_FLOWS, label: `All flows · ${rows.length} live` } : null,
    live: rows.map(menuEntry),
    finished: runs.filter(run => !inRows.has(run.id)).sort(byNewest).map(menuEntry),
  }
}

export function rowDetail(run: RunView, now: number): RowDetail {
  if (needsYou(run)) return { text: problemText(run), problem: true }
  if (run.status === 'paused') return { text: 'Paused', problem: false }
  if (run.status === 'awaiting-approval') return { text: 'Waiting for approval', problem: false }
  const working = inOrder(run).filter(attempt => attempt.status !== 'settled')
  if (!working.length) return { text: titleOf(run, run.currentNodeId), problem: false }
  const label = [...new Set(working.map(attempt => titleOf(run, attempt.nodeId)))].join(' + ')
  const since = Math.min(...working.map(attempt => attempt.startedAt))
  return { text: `${label} · ${elapsed(now - since)}`, problem: false, label, since }
}

function motionAllowed(): boolean {
  try { return localStorage.getItem('skd.motion.paused') !== 'true' } catch { return true }
}

function mountFlowDrawer(): void {
  const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
  const title = $('flow-title'), meta = $('flow-meta'), pills = $('flow-pills'), runsSelect = $('flow-runs') as HTMLSelectElement
  const pause = $('flow-pause') as HTMLButtonElement, stop = $('flow-stop') as HTMLButtonElement, save = $('flow-save') as HTMLButtonElement
  const banner = $('flow-banner'), stage = $('flow-stage'), canvas = $('flow-canvas'), quick = $('flow-quick'), quickList = $('flow-quick-list'), empty = $('flow-empty')
  const back = $('flow-back') as HTMLButtonElement, rowsList = $('flow-rows')
  const divider = pause.parentElement?.querySelector<HTMLElement>('.flow-sep') ?? null
  const term = document.getElementById('flow-term')
  const viewport = mountViewport(stage, canvas, { animate: motionAllowed })
  const notice = document.createElement('p')
  notice.className = 'flow-notice'
  notice.setAttribute('role', 'status')
  notice.hidden = true
  banner.after(notice)
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  let pressedStep: string | null = null
  let scopeQuery: string | null = null
  let open = false
  let source: EventSource | null = null
  let ticker: ReturnType<typeof setInterval> | undefined
  let snapshot: ScopeSnapshot = { runs: [], jobs: [] }
  let selected: string | null = null
  let current: RunView | null = null
  let bannerKey = ''
  let watching: string | null = null
  let pickedStep: string | null = null
  let pickedJob: string | null = null
  let watchKey = ''
  let scopeBeforeWatch: string | null = null
  let saving: string | null = null
  let reminded: string | null = null
  let remindTimer: ReturnType<typeof setTimeout> | undefined
  const savedAs = new Map<string, string>()
  const approvalRestored = new Set<string>()
  const expandedByRun = new Map<string, Set<string>>()
  const expandedFor = (runId: string): Set<string> => expandedByRun.get(runId) ?? expandedByRun.set(runId, new Set()).get(runId)!
  const compose = (run: RunView, now: number): Composed => {
    const composed = collapseSections(stepsFor(run, now), edgesFor(run), run.sections, expandedFor(run.id), run.attempts, now)
    return run.id === watching ? { ...composed, steps: composed.steps.map(step => ({ ...step, opens: 'output' as const })) } : composed
  }
  const cardFor = (id: string | null | undefined): HTMLElement | null => id ? [...canvas.querySelectorAll<HTMLElement>('.flow-step')].find(card => card.dataset.step === id) ?? null : null
  const cardAt = (id: string | undefined): Point | null => {
    const card = cardFor(id)
    return card ? { x: parseFloat(card.style.left) || 0, y: parseFloat(card.style.top) || 0 } : null
  }

  const make = (tag: string, text = '', className = ''): HTMLElement => {
    const element = document.createElement(tag)
    element.textContent = text
    if (className) element.className = className
    return element
  }
  const logo = (engine: string, className: string): HTMLImageElement => {
    const image = document.createElement('img')
    if (className) image.className = className
    image.src = `/providers/${engine}.svg`
    image.alt = ''
    return image
  }
  const mark = (state: string): HTMLElement => {
    const span = make('span', '', 'flow-mark')
    span.dataset.state = state
    return span
  }

  function showError(text: string): void {
    if (banner.hidden) { banner.className = 'flow-banner problem'; banner.querySelector<HTMLElement>('.flow-mark')!.dataset.state = 'failed'; banner.hidden = false }
    rollText(banner.querySelector('p') as HTMLElement, text)
  }

  async function act(action: RunAction, runId: string | undefined, label: string = action): Promise<boolean> {
    const target = snapshot.runs.find(run => run.id === runId)
    if (!target) return false
    const pending = target.versions.find(version => version.state === 'pending')
    const body = (action === 'approve' || action === 'reject') && pending ? { version: pending.number } : {}
    const result = await postJson(`/api/studio/runs/${encodeURIComponent(target.id)}/${action}`, body)
    if (!result.ok) showError(`Could not ${label}: ${errorText(result)}`)
    return result.ok
  }

  async function whileBusy(button: HTMLButtonElement, task: () => Promise<boolean>): Promise<void> {
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    const succeeded = await task()
    button.removeAttribute('aria-busy')
    if (!succeeded) button.disabled = false
  }

  async function restoreApproval(run: RunView): Promise<boolean> {
    const result = await putJson('/api/flow-approval', { flowApproval: true })
    if (!result.ok) { showError(`Could not turn approval on: ${errorText(result)}`); return false }
    approvalRestored.add(`${run.id}:${run.latestChange?.number}`)
    paintBanner(current, true)
    return true
  }

  async function saveRun(runId: string | undefined): Promise<void> {
    if (!runId || saving) return
    saving = runId
    save.setAttribute('aria-busy', 'true')
    paintSave(current)
    const result = await postJson(`/api/studio/runs/${encodeURIComponent(runId)}/save`, {})
    saving = null
    save.removeAttribute('aria-busy')
    if (result.ok) { savedAs.set(runId, typeof result.data.name === 'string' ? result.data.name : 'a workflow'); paintBanner(current, true) }
    else showError(`Could not save: ${errorText(result)}`)
    paintSave(current)
  }

  function forgetReminder(): void {
    clearTimeout(remindTimer)
    remindTimer = undefined
    reminded = null
  }

  async function remind(run: RunView, nodeId: string): Promise<boolean> {
    const result = await postJson(`/api/studio/runs/${encodeURIComponent(run.id)}/steps/${encodeURIComponent(nodeId)}/remind`, {})
    if (!result.ok) { showError(`Could not remind: ${errorText(result)}`); return false }
    forgetReminder()
    reminded = `${run.id}:${nodeId}`
    remindTimer = setTimeout(() => { forgetReminder(); paintBanner(current, true) }, NOTICE_MS)
    paintBanner(current, true)
    return true
  }

  function remindButton(button: HTMLButtonElement, run: RunView | null): HTMLButtonElement {
    const node = run && waitingInSession(run)
    button.classList.add('flow-ghost')
    if (!run || !node) return button
    const sent = reminded === `${run.id}:${node.id}`
    button.textContent = sent ? 'Reminded' : `Remind ${providerName(node.engine)}`
    button.disabled = sent
    button.onclick = () => void whileBusy(button, () => remind(run, node.id))
    return button
  }

  function actionButton(action: BannerAction, run: RunView | null): HTMLButtonElement {
    const runId = run?.id
    const button = make('button', '', 'pill flow-sm') as HTMLButtonElement
    button.type = 'button'
    const busy = (task: () => Promise<boolean>) => () => void whileBusy(button, task)
    if (action === 'approve') {
      button.classList.add('flow-primary')
      button.textContent = run?.proposal ? `Approve v${run.proposal.number}` : 'Approve and run'
      button.onclick = busy(() => act('approve', runId))
      return button
    }
    if (action === 'keep') {
      const label = `Keep v${run ? activeVersion(run) : 1}`
      button.classList.add('flow-ghost')
      button.textContent = label
      button.onclick = busy(() => act('reject', runId, label.toLowerCase()))
      return button
    }
    if (action === 'approval-on') {
      button.classList.add('flow-ghost')
      button.textContent = 'Turn approval on'
      button.onclick = busy(() => run ? restoreApproval(run) : Promise.resolve(false))
      return button
    }
    if (action === 'remind') return remindButton(button, run)
    if (action === 'retry') { button.textContent = 'Retry step'; button.onclick = busy(() => act('retry', runId)); return button }
    const [idle, armed] = action === 'reject' ? ['Reject', 'Reject flow'] : ['Stop', 'Stop flow']
    button.classList.add('flow-ghost', 'flow-confirm')
    button.setAttribute('aria-label', idle)
    button.dataset.action = action
    button.append(make('span', idle), make('span', armed))
    return button
  }

  function bannerShown(run: RunView | null): Banner {
    const next = run ? bannerFor(run) : NO_BANNER
    if (run && next.tone === 'notice' && approvalRestored.has(`${run.id}:${run.latestChange?.number}`)) return { tone: 'notice', text: 'Approval is on again.', actions: [] }
    return next
  }

  function bannerMark(run: RunView | null, next: Banner): string {
    if (next.tone === 'problem') return 'failed'
    if (next.actions.includes('remind')) return 'session'
    if (next.tone === 'notice') return 'done'
    return run?.proposal ? 'proposed' : 'active'
  }

  function paintBanner(run: RunView | null, force = false): void {
    const next = bannerShown(run)
    const key = JSON.stringify([run?.id, next])
    if (key === bannerKey && !force) return
    bannerKey = key
    banner.hidden = !next.tone
    banner.className = next.tone ? `flow-banner ${next.tone}` : 'flow-banner'
    banner.querySelector<HTMLElement>('.flow-mark')!.dataset.state = bannerMark(run, next)
    ;(banner.querySelector('p') as HTMLElement).textContent = next.text
    const actions = banner.querySelector('.flow-banner-actions') as HTMLElement
    actions.replaceChildren(...next.actions.map(action => actionButton(action, run)))
    actions.querySelectorAll<HTMLButtonElement>('.flow-confirm').forEach(button => confirmButton(button, button.lastElementChild!.textContent ?? '', () => void act(button.dataset.action as RunAction, run?.id)))
  }

  function paintMenu(view: DrawerView): void {
    const menu = runMenu(snapshot.runs)
    const option = (entry: MenuEntry): HTMLOptionElement => new Option(entry.label, entry.value)
    const finished = document.createElement('optgroup')
    finished.label = 'Finished'
    finished.append(...menu.finished.map(option))
    runsSelect.replaceChildren(...[menu.all, ...menu.live].filter(entry => entry !== null).map(option), ...(menu.finished.length ? [finished] : []))
    runsSelect.value = view.kind === 'one' ? view.run.id : ALL_FLOWS
  }

  function paintPause(run: RunView | null): void {
    pause.hidden = run?.status !== 'running' && run?.status !== 'paused'
    const word = run?.status === 'paused' ? 'Resume' : 'Pause'
    pause.setAttribute('aria-label', word)
    pause.title = word
    pause.querySelector('use')?.setAttribute('href', word === 'Resume' ? '#play-icon' : '#pause-icon')
  }

  function paintHeader(view: DrawerView, heading: string): void {
    const run = view.kind === 'one' ? view.run : null
    rollText(title, heading)
    runsSelect.hidden = snapshot.runs.length < 2 || view.kind === 'none'
    title.hidden = !runsSelect.hidden
    if (!runsSelect.hidden) paintMenu(view)
    back.hidden = !run || rowRuns(snapshot.runs).length < 2
    const counts = run ? pillsFor(run) : { running: 0, done: 0, waiting: 0 }
    const shown: PillCount[] = view.kind === 'all' ? allFlowsPills(view.runs) : [['running', counts.running, 'running'], ['done', counts.done, 'done'], ['queued', counts.waiting, 'waiting']]
    pills.replaceChildren(...shown
      .filter(([, count]) => count > 0)
      .map(([state, count, word]) => { const pill = make('span', `${count} ${word}`, 'pill-state'); pill.dataset.s = state; return pill }))
    paintPause(run)
    stop.hidden = !run || !isLive(run)
    if (divider) divider.hidden = pause.hidden && stop.hidden
    paintSave(run)
  }

  function chevron(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'flow-row-chevron')
    svg.setAttribute('aria-hidden', 'true')
    const use = document.createElementNS(SVG_NS, 'use')
    use.setAttribute('href', '#chevron-icon')
    svg.append(use)
    return svg
  }

  function rowActions(run: RunView): HTMLElement {
    const actions = make('div', '', 'flow-row-acts')
    const button = (text: string, className: string, action: RunAction): HTMLButtonElement => {
      const element = make('button', text, className) as HTMLButtonElement
      element.type = 'button'
      element.onclick = (event) => { event.stopPropagation(); void whileBusy(element, () => act(action, run.id)) }
      return element
    }
    actions.append(button('Retry', 'pill flow-sm flow-primary', 'retry'), button('Dismiss', 'text-button', 'dismiss'))
    return actions
  }

  function flowRow(run: RunView, now: number): HTMLElement {
    const detail = rowDetail(run, now)
    const row = make('li', '', 'flow-row')
    row.dataset.run = run.id
    const name = make('button', run.label, 'flow-row-open') as HTMLButtonElement
    name.type = 'button'
    const heading = make('div', '', 'flow-row-name')
    heading.append(mark(detail.problem ? 'failed' : 'active'), name)
    const status = make('small', detail.text, detail.problem ? 'flow-meta flow-row-problem' : 'flow-meta')
    if (detail.since !== undefined) { status.dataset.since = String(detail.since); status.dataset.label = detail.label ?? '' }
    const text = make('div', '', 'flow-row-text')
    text.append(heading, status, ...(detail.problem ? [rowActions(run)] : []))
    const rowCanvas = make('div', '', 'flow-canvas')
    rowCanvas.setAttribute('inert', '')
    const rowStage = make('div', '', 'flow-stage')
    rowStage.append(rowCanvas)
    const composed = compose(run, now)
    renderRunGraph(rowCanvas, composed.steps, composed.edges, run.entry, { animate: false, sections: composed.bands, runId: run.id })
    row.append(text, rowStage, chevron())
    return row
  }

  function fitRow(rowStage: HTMLElement): void {
    const rowCanvas = rowStage.firstElementChild as HTMLElement | null
    const graph = rowCanvas?.firstElementChild as HTMLElement | null
    const width = parseFloat(graph?.style.width ?? ''), height = parseFloat(graph?.style.height ?? '')
    if (!rowCanvas || !width || !height || !rowStage.clientWidth || !rowStage.clientHeight) return
    const scale = Math.min((rowStage.clientHeight - ROW_INSET_Y) / height, (rowStage.clientWidth - ROW_INSET_X) / width, 1)
    const x = (rowStage.clientWidth - width * scale) / 2, y = (rowStage.clientHeight - height * scale) / 2
    rowCanvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
  }

  function focusedRowControl(): { runId: string; control: string } | null {
    const focused = document.activeElement
    const runId = focused instanceof HTMLElement && rowsList.contains(focused) ? focused.closest<HTMLElement>('.flow-row')?.dataset.run : undefined
    const control = ROW_CONTROLS.find(name => focused instanceof HTMLElement && focused.classList.contains(name))
    return runId && control ? { runId, control } : null
  }

  function paintRows(runs: RunView[]): void {
    const focused = focusedRowControl()
    const scroll = rowsList.scrollTop
    const now = Date.now()
    rowsList.replaceChildren(...runs.map(run => flowRow(run, now)))
    rowsList.querySelectorAll<HTMLElement>('.flow-stage').forEach(fitRow)
    rowsList.scrollTop = scroll
    if (focused) [...rowsList.querySelectorAll<HTMLElement>('.flow-row')].find(row => row.dataset.run === focused.runId)?.querySelector<HTMLElement>(`.${focused.control}`)?.focus({ preventScroll: true })
  }

  function openRun(runId: string): void {
    selected = runId
    paint()
  }

  function paintSave(run: RunView | null): void {
    save.hidden = run?.origin.source !== 'drafted'
    if (!run || save.hidden) return
    const name = savedAs.get(run.id)
    save.textContent = name ? `Saved as ${name}` : 'Save as workflow'
    save.toggleAttribute('data-saved', !!name)
    save.disabled = !!name || saving === run.id
  }

  function quickRow(job: QuickJobView, now: number): HTMLElement {
    const state = job.status === 'done' ? 'done' : job.status === 'running' ? 'active' : 'failed'
    const row = make('li')
    row.dataset.state = state
    const time = make('small', quickTime(job, now))
    if (job.status === 'running') time.dataset.since = String(job.startedAt)
    row.append(mark(state), logo(job.engine, 'flow-step-logo'), make('strong', job.label), time)
    return row
  }

  function quickTime(job: QuickJobView, now: number): string {
    const word = job.status === 'done' ? 'Finished' : job.status === 'running' ? 'Working' : job.status.charAt(0).toUpperCase() + job.status.slice(1)
    return `${word} · ${elapsed((job.endedAt ?? now) - job.startedAt)}`
  }

  function paint(keep?: { id: string; before: Point }): void {
    const view = drawerView(snapshot.runs, selected)
    const run = view.kind === 'one' ? view.run : null
    const all = view.kind === 'all'
    current = run
    stage.hidden = !run
    rowsList.hidden = !all
    quick.hidden = !!run || all || !snapshot.jobs.length
    empty.hidden = !!run || all || !!snapshot.jobs.length
    paintBanner(run)
    if (view.kind === 'all') {
      paintHeader(view, EMPTY_TITLE)
      meta.replaceChildren()
      paintRows(view.runs)
      paintWatch(null)
      return
    }
    rowsList.replaceChildren()
    if (run) {
      paintHeader(view, run.label)
      meta.replaceChildren(...(run.origin.by === 'you' ? [] : [logo(run.origin.by, '')]), metaFor(run))
      const composed = compose(run, Date.now())
      const focused = document.activeElement instanceof HTMLElement && canvas.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>('.flow-step')?.dataset.step : undefined
      const frame = renderRunGraph(canvas, composed.steps, composed.edges, run.entry, { animate: motionAllowed(), sections: composed.bands, runId: run.id })
      const after = keep ? cardAt(keep.id) : null
      viewport.paint(run.id, frame, frame.focus, keep && after ? { before: keep.before, after } : undefined)
      const refocus = cardFor(focused)
      if (refocus && document.activeElement !== refocus) viewport.quietly(() => refocus.focus({ preventScroll: true }))
      paintWatch(run)
      return
    }
    paintWatch(null)
    const newest = snapshot.jobs[0]
    paintHeader(view, newest?.label ?? EMPTY_TITLE)
    meta.replaceChildren(newest ? 'Quick work · no flow needed' : '')
    const now = Date.now()
    quickList.replaceChildren(...snapshot.jobs.map(job => quickRow(job, now)))
  }

  function watchedAttempt(run: RunView): RunAttemptView | undefined {
    const attempts = inOrder(run)
    if (pickedJob !== null) return attempts.find(attempt => attempt.jobId === pickedJob || attempt.nudgedFrom === pickedJob)
    if (pickedStep !== null) return attempts.filter(attempt => attempt.nodeId === pickedStep).at(-1)
    return attempts.filter(attempt => attempt.status !== 'settled').at(-1) ?? attempts.at(-1)
  }

  function paintWatch(run: RunView | null): void {
    const shown = watching !== null && run !== null && run.id === watching
    if (term) term.hidden = !shown
    canvas.querySelectorAll('.flow-step[data-watched]').forEach(card => card.removeAttribute('data-watched'))
    if (!shown) { stopTerminal(); return }
    const attempt = watchedAttempt(run)
    const nodeId = attempt?.nodeId ?? pickedStep ?? run.currentNodeId
    const tries = run.attempts.filter(entry => entry.nodeId === nodeId)
    const visit = attempt === undefined ? tries.length + 1 : tries.findIndex(entry => entry.number === attempt.number) + 1
    cardFor(nodeId)?.setAttribute('data-watched', '')
    const detail = { jobId: attempt?.jobId ?? null, title: `${titleOf(run, nodeId)}${visit > 1 ? ` · attempt ${visit}` : ''}`, engine: run.nodes.find(node => node.id === nodeId)?.engine ?? 'claude' }
    const key = JSON.stringify(detail)
    if (key === watchKey) return
    watchKey = key
    dispatchEvent(new CustomEvent('quiet:job-watch', { detail }))
  }

  function stopTerminal(): void {
    if (watchKey === '') return
    watchKey = ''
    dispatchEvent(new CustomEvent('quiet:job-watch', { detail: null }))
  }

  function stopWatching(restoreScope: boolean): void {
    if (watching === null) return
    watching = null
    pickedStep = null
    pickedJob = null
    stopTerminal()
    const before = scopeBeforeWatch
    scopeBeforeWatch = null
    if (restoreScope) setScope(before)
  }

  function watchStep(run: RunView, id: string): void {
    const working = inOrder(run).filter(attempt => attempt.status !== 'settled').at(-1)
    pickedJob = null
    pickedStep = working?.nodeId === id ? null : id
    paintWatch(run)
  }

  function tick(): void {
    if (document.hidden) return
    const now = Date.now()
    if (!rowsList.hidden) {
      rowsList.querySelectorAll<HTMLElement>('.flow-row-text [data-since]').forEach(status => { status.textContent = `${status.dataset.label} · ${elapsed(now - Number(status.dataset.since))}` })
      return
    }
    if (current) {
      const steps = new Map(compose(current, now).steps.map(step => [step.id, step]))
      canvas.querySelectorAll<HTMLElement>('.flow-step').forEach(card => {
        const detail = card.querySelector<HTMLElement>('small[data-since]')
        const step = steps.get(card.dataset.step ?? '')
        if (!detail || !step) return
        detail.textContent = step.detail
        describeCard(card, step)
      })
      return
    }
    quickList.querySelectorAll<HTMLElement>('small[data-since]').forEach(time => { time.textContent = `Working · ${elapsed(now - Number(time.dataset.since))}` })
  }

  function connect(): void {
    source?.close()
    source = null
    clearInterval(ticker)
    ticker = undefined
    if (!open || !scopeQuery) return
    source = new EventSource(`/api/studio/events?${scopeQuery}`)
    source.onmessage = (event: MessageEvent<string>) => { snapshot = JSON.parse(event.data) as ScopeSnapshot; paint() }
    ticker = setInterval(tick, TICK_MS)
  }

  function setScope(next: string | null): void {
    if (next === scopeQuery) return
    scopeQuery = next
    snapshot = { runs: [], jobs: [] }
    selected = null
    paint()
    connect()
  }

  function toggleSection(fork: string, expand: boolean): void {
    if (!current) return
    const firstStep = current.sections.find(section => section.fork === fork)?.paths[0]?.firstNodeId
    const [from, to] = expand ? [sectionBox(fork), firstStep] : [firstStep, sectionBox(fork)]
    const before = cardAt(from)
    if (expand) expandedFor(current.id).add(fork)
    else expandedFor(current.id).delete(fork)
    paint(before && to ? { id: to, before } : undefined)
  }

  function activateStep(id: string | null | undefined): void {
    if (!id || !current) return
    if (id.startsWith(sectionBox(''))) { toggleSection(id.slice(sectionBox('').length), true); return }
    if (watching !== null && current.id === watching) { watchStep(current, id); return }
    const jobId = compose(current, Date.now()).steps.find(step => step.id === id)?.jobId
    if (jobId) dispatchEvent(new CustomEvent('quiet:agent-open', { detail: { jobId } }))
  }

  function hideNotice(): void {
    clearTimeout(noticeTimer)
    noticeTimer = undefined
    notice.hidden = true
  }

  function showNotice(text: string): void {
    hideNotice()
    notice.textContent = text
    notice.hidden = false
    noticeTimer = setTimeout(hideNotice, NOTICE_MS)
  }

  const stepOf = (target: EventTarget | null): string | undefined => (target as Element | null)?.closest?.<HTMLElement>('.flow-step')?.dataset.step
  stage.addEventListener('pointerdown', (event) => { pressedStep = stepOf(event.target) ?? null })
  const forgetPress = (): void => { setTimeout(() => { pressedStep = null }, 0) }
  stage.addEventListener('pointerup', forgetPress)
  stage.addEventListener('pointercancel', forgetPress)
  stage.addEventListener('click', (event) => {
    const collapse = (event.target as Element).closest<HTMLElement>('[data-collapse]')
    const pressed = pressedStep
    pressedStep = null
    if (collapse) { toggleSection(collapse.dataset.collapse!, false); return }
    activateStep(pressed ?? stepOf(event.target))
  })
  stage.addEventListener('keydown', (event) => {
    const card = (event.target as Element).closest<HTMLElement>('.flow-step[tabindex]')
    if (!card || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    activateStep(card.dataset.step)
  })
  rowsList.addEventListener('click', (event) => {
    const target = event.target as Element
    if (target.closest('.flow-row-acts button')) return
    const runId = target.closest<HTMLElement>('.flow-row')?.dataset.run
    if (runId) openRun(runId)
  })
  back.onclick = () => openRun(ALL_FLOWS)
  addEventListener('resize', () => rowsList.querySelectorAll<HTMLElement>('.flow-stage').forEach(fitRow))
  addEventListener('quiet:agent-open-missing', () => showNotice(MISSING_JOB))
  runsSelect.onchange = () => { selected = runsSelect.value; paint() }
  pause.onclick = () => void act(current?.status === 'paused' ? 'resume' : 'pause', current?.id)
  let stopTarget: string | undefined
  stop.addEventListener('click', () => { if (stop.dataset.armed !== 'true') stopTarget = current?.id }, { capture: true })
  confirmButton(stop, 'Stop flow', () => void act('stop', stopTarget))
  save.onclick = () => void saveRun(current?.id)
  addEventListener('quiet:flow-open', (event) => { open = (event as CustomEvent<boolean>).detail; if (!open) { hideNotice(); forgetReminder(); stopWatching(true) } connect() })
  addEventListener('quiet:activity-scope', (event) => { const session = (event as CustomEvent<{ id: string; cwd: string } | null>).detail; stopWatching(false); setScope(session ? `terminal=${encodeURIComponent(session.id)}` : null) })
  addEventListener('quiet:chat-agents', (event) => { const chat = (event as CustomEvent<string | null>).detail; if (!chat) return; stopWatching(false); setScope(`chat=${encodeURIComponent(chat)}`) })
  addEventListener('quiet:flow-watch', (event) => {
    const { runId, jobId } = (event as CustomEvent<{ runId: string; jobId?: string }>).detail
    if (watching === null) scopeBeforeWatch = scopeQuery
    watching = runId
    pickedStep = null
    pickedJob = jobId ?? null
    watchKey = ''
    setScope(`run=${encodeURIComponent(runId)}`)
    selected = runId
    paint()
  })
  if (document.body.dataset.chat) setScope(`chat=${encodeURIComponent(document.body.dataset.chat)}`)
  else paint()
}

if (typeof document !== 'undefined' && document.getElementById('flow-stage')) mountFlowDrawer()
