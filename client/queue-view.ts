export type QueueState = 'queued' | 'building' | 'waiting-info' | 'waiting-pick' | 'ready' | 'failed' | 'landing' | 'awaiting-stage' | 'landed'

export type QueuePickView = { options: string[]; path: string; recommended: string | null; tester: string | null; summary: string }
export type LandStageView = { status: string; preflight?: { exitCode: number; markdown: string } }
export type LandView = { stage: string; runId?: string; message?: string; plan: Array<{ id: string; label?: string }>; stages: Record<string, LandStageView> }

export type QueueItemView = {
  id: string; source: string; externalId: string; title: string; url: string; flowId: string | null
  state: QueueState; runIds: string[]; questions: string[]; error: string | null; updatedAt: number
  repo?: string; repos?: string[]; realChanged?: string[]; currentRunId?: string; resumeRunId?: string; step?: QueueStepView; preparing?: true; pick?: QueuePickView; land?: LandView
}

export type QueueStepView = { title: string; attempt: number; maxAttempts: number }

export type QueuePlugin = { id: string; name: string; icon?: string; enabled: boolean; queueSource?: true }
export type QueueFlow = { id: string; name: string }
export type QueueLayout = 'list' | 'tree'
export type QueuePaused = { reason: string; until: number }
export type QueueContext = {
  plugins: QueuePlugin[]; flows: QueueFlow[]; now: number; checkedAt: number | null; openIds: ReadonlySet<string>
  layout?: QueueLayout; treeView?: HTMLElement; paused?: QueuePaused | null; parallel?: number
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const LINE = 'Items from your sources, built in queue order. Nothing reaches the remote until you land it.'
const PARALLEL_CHOICES = ['1', '2', '3', '4']
const STATES: readonly QueueState[] = ['building', 'queued', 'waiting-info', 'waiting-pick', 'ready', 'failed', 'landing', 'awaiting-stage', 'landed']
const PILL: Record<QueueState, { s: string; label: string; count: string; icon?: string }> = {
  building: { s: 'running', label: 'Building', count: 'building' },
  queued: { s: 'queued', label: 'Queued', count: 'queued' },
  'waiting-info': { s: 'waiting', label: 'Waiting info', count: 'waiting', icon: 'q-clock' },
  'waiting-pick': { s: 'waiting', label: 'Pick a variant', count: 'to pick', icon: 'q-clock' },
  ready: { s: 'done', label: 'Ready', count: 'ready' },
  failed: { s: 'failed', label: 'Failed', count: 'failed' },
  landing: { s: 'running', label: 'Shipping', count: 'shipping' },
  'awaiting-stage': { s: 'waiting', label: 'Waiting for you', count: 'waiting for you', icon: 'q-clock' },
  landed: { s: 'done', label: 'Landed', count: 'landed' },
}

export type Child = Node | string
export type Attrs = Record<string, string | boolean>

export function el(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false) continue
    node.setAttribute(name, value === true ? '' : value)
  }
  node.append(...children)
  return node
}

export function icon(id: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(SVG_NS, 'use')
  use.setAttribute('href', `#${id}`)
  svg.append(use)
  return svg
}

const button = (label: string, className: string, attrs: Attrs = {}, iconId?: string): HTMLElement =>
  el('button', { type: 'button', class: className, ...attrs }, ...(iconId ? [icon(iconId)] : []), label)

export function ordinal(n: number): string {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${suffix}`
}

export function ageText(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

export function untilText(at: number, now: number): string {
  const minutes = Math.ceil(Math.max(0, at - now) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `in ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`
}

export function readPaused(value: unknown): QueuePaused | null {
  if (typeof value !== 'object' || value === null) return null
  const { reason, until } = value as Record<string, unknown>
  return typeof reason === 'string' && typeof until === 'number' ? { reason, until } : null
}

export function isWebLink(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

const waitingInLine = (item: QueueItemView): boolean => item.state === 'queued' && item.preparing !== true

export function lineText(items: readonly QueueItemView[], queuedIndex: number): string {
  if (queuedIndex === 0) return 'Next up'
  return `${ordinal(queuedIndex + 1 + (items.some(item => item.state === 'building' || item.preparing === true) ? 1 : 0))} in line`
}

export function pill(state: QueueState, text?: string): HTMLElement {
  const { s, label, icon: iconId } = PILL[state]
  return el('span', { class: 'pill-state', 'data-s': s }, ...(iconId ? [icon(iconId)] : []), text ?? label)
}

export function stageLabel(land: LandView, id: string): string {
  return land.plan.find(stage => stage.id === id)?.label ?? id
}

const stagePill = (item: QueueItemView): string | undefined => (item.state === 'landing' && item.land !== undefined ? `Shipping: ${stageLabel(item.land, item.land.stage)}` : undefined)
const failedAtStage = (item: QueueItemView): boolean => item.state === 'failed' && item.land !== undefined && item.land.runId === item.runIds.at(-1)
const firstLine = (text: string): string => text.split('\n')[0]!

function atOnce(parallel: number): HTMLElement {
  const select = el('select', { name: 'parallel' }, ...PARALLEL_CHOICES.map(choice => el('option', { value: choice, selected: choice === String(parallel) }, choice)))
  return el('label', { class: 'muted q-at-once' }, 'At once', select)
}

function heading(context: QueueContext): HTMLElement {
  const checked = context.checkedAt === null ? 'Not checked yet' : `Checked ${ageText(context.checkedAt, context.now)}`
  const control = context.parallel === undefined ? [] : [atOnce(context.parallel)]
  return el('header', { class: 'studio-heading' },
    el('div', {}, el('h1', {}, 'Queue'), el('p', { class: 'muted' }, LINE)),
    el('nav', { 'aria-label': 'Queue actions' }, ...control, el('span', { class: 'muted q-checked' }, checked), button('Check replies', 'connection-button q-btn', { 'data-act': 'check' }, 'mk-refresh')))
}

function top(context: QueueContext): HTMLElement[] {
  const { paused } = context
  return paused ? [heading(context), el('p', { class: 'q-paused', role: 'status' }, `Queue paused · ${paused.reason} · retrying ${untilText(paused.until, context.now)}`)] : [heading(context)]
}

const addButton = (): HTMLElement => button('Add item', 'connection-button q-btn', { 'data-act': 'add' }, 'plus-icon')

function summary(items: readonly QueueItemView[], shown: QueueLayout, parallel = 1): HTMLElement {
  const counts = STATES.map(state => [state, items.filter(item => item.state === state).length] as const).filter(([, count]) => count > 0)
  const layout = el('nav', { class: 'mk-seg q-layout', 'aria-label': 'Layout' },
    button('List', '', { 'data-layout': 'list', 'aria-pressed': String(shown === 'list') }),
    button('Git tree', '', { 'data-layout': 'tree', 'aria-pressed': String(shown === 'tree') }))
  return el('div', { class: 'q-bar' },
    ...counts.map(([state, count]) => el('span', { class: 'pill-state', 'data-s': PILL[state].s }, `${count} ${PILL[state].count}`)),
    el('span', { class: 'sp' }), el('span', { class: 'muted' }, parallel === 1 ? 'One builds at a time' : `Up to ${parallel} build at a time`), layout, addButton())
}

function sourceBadge(item: QueueItemView, plugins: readonly QueuePlugin[]): HTMLElement {
  const plugin = plugins.find(entry => entry.id === item.source)
  const parts: Child[] = []
  if (plugin !== undefined) {
    const logo = plugin.icon === undefined || !plugin.enabled ? icon('auto-icon') : el('img', { src: `/api/plugins/${encodeURIComponent(plugin.id)}/icon`, alt: '' })
    parts.push(el('span', { class: 'mk-logo', style: '--s:16px' }, logo))
  }
  parts.push(plugin?.name ?? item.source)
  if (!isWebLink(item.url)) return el('span', { class: 'q-src', title: item.externalId }, ...parts)
  return el('a', { class: 'q-src', href: item.url, target: '_blank', rel: 'noopener noreferrer', title: `Open ${item.externalId} in ${plugin?.name ?? item.source}` }, ...parts, icon('open-icon'))
}

export function flowName(item: Pick<QueueItemView, 'flowId'>, flows: readonly QueueFlow[]): string {
  if (item.flowId === null) return 'Default flow'
  return flows.find(flow => flow.id === item.flowId)?.name ?? item.flowId
}

export function watchRunId(item: Pick<QueueItemView, 'currentRunId' | 'runIds'>): string | undefined {
  return item.currentRunId ?? item.runIds.at(-1)
}

export function stepText(step: QueueStepView): string {
  return step.maxAttempts > 1 ? `${step.title} · attempt ${step.attempt} of ${step.maxAttempts}` : step.title
}

function progressText(item: QueueItemView, items: readonly QueueItemView[], now: number): string {
  if (item.state === 'building') return item.step === undefined ? 'Building' : stepText(item.step)
  if (item.preparing === true) return 'Getting the workspace ready…'
  if (item.state === 'queued') return lineText(items, items.filter(waitingInLine).indexOf(item))
  if (item.state === 'waiting-info') {
    const count = item.questions.length
    return `Asked ${count} question${count === 1 ? '' : 's'} · ${ageText(item.updatedAt, now)}`
  }
  if (item.state === 'waiting-pick') return `${item.pick?.options.length ?? 0} variants to choose from · ${ageText(item.updatedAt, now)}`
  if (item.state === 'ready') return `Built · ${ageText(item.updatedAt, now)}`
  if (item.state === 'landing') return item.land?.message ?? `Running · ${ageText(item.updatedAt, now)}`
  if (item.state === 'awaiting-stage') return `Waiting for you · ${ageText(item.updatedAt, now)}`
  if (item.state === 'landed') return `Landed · ${ageText(item.updatedAt, now)}`
  return failedAtStage(item) ? firstLine(item.error ?? 'Failed') : item.error ?? 'Failed'
}

function actions(item: QueueItemView, now: number): HTMLElement {
  const id = { 'data-id': item.id }
  const openRun = item.runIds.length > 0
  const parts: HTMLElement[] = []
  if (item.state === 'building') {
    parts.push(el('span', { class: 'muted q-time' }, `started ${ageText(item.updatedAt, now)}`))
    if (watchRunId(item) !== undefined) parts.push(button('Watch', 'connection-button primary', { ...id, 'data-act': 'watch', 'aria-label': `Watch ${item.title}` }, 'eye-icon'))
  }
  if (waitingInLine(item)) parts.push(button('Remove', 'text-button q-remove', { ...id, 'data-act': 'remove' }))
  if (item.state === 'waiting-pick') {
    parts.push(button('Requeue', 'text-button', { ...id, 'data-act': 'requeue' }))
    parts.push(button('Pick', 'connection-button primary', { ...id, 'data-act': 'pick', 'aria-label': `Pick a variant for ${item.title}` }))
  }
  if (item.state === 'waiting-info') parts.push(button('Requeue', 'text-button', { ...id, 'data-act': 'requeue' }))
  if (item.state === 'ready') {
    parts.push(button('Requeue', 'text-button', { ...id, 'data-act': 'requeue' }))
    if (openRun) parts.push(button('Open run', 'connection-button primary', { ...id, 'data-act': 'open-run' }, 'flow-icon'))
  }
  if (item.state === 'failed') {
    if (failedAtStage(item)) parts.push(button('Retry stage', 'connection-button primary', { ...id, 'data-act': 'land-retry' }, 'mk-refresh'))
    parts.push(button(item.resumeRunId === undefined ? 'Requeue' : 'Resume', failedAtStage(item) ? 'text-button' : 'connection-button', { ...id, 'data-act': 'requeue' }, failedAtStage(item) ? undefined : 'mk-refresh'))
    if (item.resumeRunId !== undefined) parts.push(button('Start over', 'text-button', { ...id, 'data-act': 'start-over' }))
    if (openRun) parts.push(button('Open run', 'connection-button', { ...id, 'data-act': 'open-run' }, 'flow-icon'))
  }
  if (item.state === 'landing') parts.push(button('Log', 'connection-button', { ...id, 'data-act': 'land-log' }))
  if (item.state === 'awaiting-stage' && item.land !== undefined) parts.push(button(stageLabel(item.land, item.land.stage), 'connection-button primary', { ...id, 'data-act': 'land-confirm' }))
  if ((item.state === 'landing' || item.state === 'awaiting-stage' || item.state === 'landed') && openRun) parts.push(button('Open run', 'text-button', { ...id, 'data-act': 'open-run' }))
  parts.push(button('Report', 'text-button', { ...id, 'data-act': 'report' }))
  return el('div', { class: 'q-acts' }, ...parts)
}

function questionsThread(item: QueueItemView, now: number): HTMLElement {
  const asked = item.questions.map(question => el('div', { class: 'q-msg' },
    el('span', { class: 'mk-logo', style: '--s:28px' }, icon('spark-icon')),
    el('div', { class: 'q-msg-meta' }, el('strong', {}, 'Shikidan'), el('span', {}, `asked on the source · ${ageText(item.updatedAt, now)}`)),
    el('div', { class: 'q-bubble' }, el('p', {}, question))))
  const foot = el('div', { class: 'q-thread-foot' }, el('span', {}, 'Answer on the source, then Check replies picks it up and the build goes on.'))
  return el('div', { class: 'q-thread' }, ...asked, foot)
}

const folderName = (path: string): string => path.split('/').filter(part => part !== '').at(-1) ?? path

function folderWithRepos(item: QueueItemView): HTMLElement[] {
  if (item.repos === undefined) return []
  const folder = item.repo ?? ''
  const chips = item.repos.length === 0 ? [el('span', { class: 'q-chip q-chip-open' }, 'repos: plan picks')] : item.repos.map(name => el('span', { class: 'q-chip' }, name))
  const moved = item.realChanged ?? []
  const warning = moved.length === 0 ? [] : [el('span', { class: 'q-real-changed', title: `${moved.join(', ')} in ${folder} changed while this item was building — check it wasn't the agent` }, icon('mk-warn'), `${moved.join(', ')} changed during the build`)]
  return [el('span', { class: 'q-folder', title: folder }, icon('folder-icon'), folderName(folder), ...chips), ...warning]
}

function row(item: QueueItemView, items: readonly QueueItemView[], context: QueueContext): HTMLElement {
  const movable = waitingInLine(item)
  const openable = item.state === 'waiting-info' && item.questions.length > 0
  const open = openable && context.openIds.has(item.id)
  const watchable = !openable && watchRunId(item) !== undefined
  const rowKeys = watchable && item.state !== 'building'
  const meta = el('div', { class: 'q-meta' },
    sourceBadge(item, context.plugins),
    ...folderWithRepos(item),
    el('span', {}, icon('flow-icon'), flowName(item, context.flows)),
    el('span', {}, progressText(item, items, context.now)))
  return el('article', { class: 'q-row', 'data-id': item.id, 'data-state': item.state, 'data-movable': movable, draggable: movable ? 'true' : false, 'data-openable': openable, 'data-open': open, 'data-watchable': watchable, tabindex: rowKeys ? '0' : false, title: watchable ? 'Watch this run' : false, 'aria-label': rowKeys ? `${item.title}, ${PILL[item.state].label}. Press Enter to watch its run` : false },
    el('span', { class: 'q-grip', title: movable ? 'Drag to reorder' : false }, icon('q-grip')),
    pill(item.state, stagePill(item)),
    el('div', { class: 'q-main' }, el('strong', {}, item.title), meta),
    actions(item, context.now),
    ...(failedAtStage(item) && item.error?.includes('\n') === true ? [el('pre', { class: 'q-land-error' }, item.error.slice(item.error.indexOf('\n') + 1))] : []),
    ...(open ? [questionsThread(item, context.now)] : []))
}

function emptyState(): HTMLElement {
  const way = (iconId: string, title: string, note: Child, end: HTMLElement): HTMLElement => el('div', { class: 'q-way' },
    el('span', { class: 'mk-logo q-ico', style: '--s:34px' }, icon(iconId)), el('span', {}, el('strong', {}, title), el('small', {}, note)), end)
  return el('div', { class: 'mk-empty q-empty' },
    el('span', { class: 'mk-logo', style: '--s:52px' }, icon('q-queue')),
    el('h2', {}, 'Nothing in the queue'),
    el('p', { class: 'muted' }, 'Items come from a source plugin. Add one and Shikidan plans it, builds it, and asks the requester when it needs them.'),
    el('div', { class: 'q-empty-ways' },
      way('store-icon', 'From a source plugin', 'Paste a task link from an enabled source plugin.', button('Add item', 'connection-button', { 'data-act': 'add' })),
      way('terminal-icon', 'From the terminal', el('code', { class: 'q-code' }, 'shiki queue add <source> <id> --repo <dir>'), el('span'))))
}

export function renderQueue(items: readonly QueueItemView[], context: QueueContext): HTMLElement {
  if (items.length === 0) {
    return el('div', { class: 'q-screen' }, ...top(context), el('div', { class: 'q-bar' }, el('span', { class: 'sp' }), addButton()), emptyState())
  }
  const treeView = context.layout === 'tree' ? context.treeView : undefined
  if (treeView !== undefined) return el('div', { class: 'q-screen' }, ...top(context), summary(items, 'tree', context.parallel), treeView)
  const hint = el('button', { type: 'button', class: 'connection-add q-hint', 'data-act': 'add' }, icon('plus-icon'), 'Add an item from a source plugin, or run ', el('code', {}, 'shiki queue add'))
  return el('div', { class: 'q-screen' }, ...top(context), summary(items, 'list', context.parallel), el('div', { class: 'q-list' }, ...items.map(item => row(item, items, context))), hint)
}

const isText = (value: unknown): value is string => typeof value === 'string'
const isTexts = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText)

function readStep(value: unknown): { step: QueueStepView } | null {
  if (typeof value !== 'object' || value === null) return null
  const { title, attempt, maxAttempts } = value as Record<string, unknown>
  if (!isText(title) || typeof attempt !== 'number' || typeof maxAttempts !== 'number') return null
  return { step: { title, attempt, maxAttempts } }
}

function readPick(value: unknown): { pick: QueuePickView } | null {
  if (typeof value !== 'object' || value === null) return null
  const { options, path, recommended, tester, summary } = value as Record<string, unknown>
  if (!isTexts(options) || !isText(path) || !isText(summary)) return null
  return { pick: { options, path, summary, recommended: isText(recommended) ? recommended : null, tester: isText(tester) ? tester : null } }
}

function readStages(value: unknown): Record<string, LandStageView> {
  const stages: Record<string, LandStageView> = {}
  if (typeof value !== 'object' || value === null) return stages
  for (const [name, entry] of Object.entries(value)) {
    const stage = entry as Record<string, unknown> | null
    if (stage === null || typeof stage !== 'object' || !isText(stage.status)) continue
    const preflight = stage.preflight as Record<string, unknown> | undefined
    const flight = preflight !== undefined && typeof preflight.exitCode === 'number' && isText(preflight.markdown) ? { preflight: { exitCode: preflight.exitCode, markdown: preflight.markdown } } : {}
    stages[name] = { status: stage.status, ...flight }
  }
  return stages
}

function readLand(value: unknown): { land: LandView } | null {
  if (typeof value !== 'object' || value === null) return null
  const { stage, message, plan, stages, runId } = value as Record<string, unknown>
  if (!isText(stage) || !Array.isArray(plan)) return null
  const named = plan.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && isText((entry as Record<string, unknown>).id))
  return { land: { stage, ...(isText(runId) ? { runId } : {}), ...(isText(message) ? { message } : {}), plan: named.map(entry => ({ id: String(entry.id), ...(isText(entry.label) ? { label: entry.label } : {}) })), stages: readStages(stages) } }
}

function readItem(value: unknown): QueueItemView | null {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Record<string, unknown>
  const { id, source, externalId, title, url, flowId, state, runIds, questions, error, updatedAt } = entry
  if (![id, source, externalId, title, url].every(isText) || !STATES.includes(state as QueueState)) return null
  if (!isTexts(runIds) || !isTexts(questions) || typeof updatedAt !== 'number') return null
  return {
    id: id as string, source: source as string, externalId: externalId as string, title: title as string, url: url as string,
    flowId: isText(flowId) ? flowId : null, state: state as QueueState, runIds, questions, error: isText(error) ? error : null, updatedAt,
    ...(isText(entry.repo) ? { repo: entry.repo } : {}),
    ...(isTexts(entry.repos) ? { repos: entry.repos } : {}),
    ...(isTexts(entry.realChanged) && entry.realChanged.length > 0 ? { realChanged: entry.realChanged } : {}),
    ...(isText(entry.currentRunId) ? { currentRunId: entry.currentRunId } : {}),
    ...(isText(entry.resumeRunId) ? { resumeRunId: entry.resumeRunId } : {}),
    ...(entry.preparing === true ? { preparing: true as const } : {}),
    ...(readStep(entry.step) ?? {}),
    ...(readPick(entry.pick) ?? {}),
    ...(readLand(entry.land) ?? {}),
  }
}

export function readQueueItems(value: unknown): QueueItemView[] {
  return Array.isArray(value) ? value.map(readItem).filter((item): item is QueueItemView => item !== null) : []
}
