import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { errorText, getJson, pathsFromUriList, postJson, providerName, readArray, readRecord } from './shared'
import { launchChoice, readRecentDirectories, restoreRequested } from './shell-launch'
import { launchWorkflowOptions, launchWorkflowRequest } from './workflow-options'
import { writeOnlyClipboard, dragKind, dropCopy, findCount, findKeys, restoreTarget, nextActive, sessionSlot, sessionState, splitPlan, statusPill, terminalKeys, type Session, type TerminalKey, type SessionState } from './terminal-state'
import { createPanes, type PaneHeader } from './terminal-panes'
import { createOutcomeStrip } from './outcome-strip'
import type { ResumeRequest } from './chat-view'
import { morph, reveal, rollText } from './morph'
import { TERMINAL_FONT, terminalTheme } from './terminal-theme'
import { attachTouchScroll } from './terminal-touch'
import { createLandscape } from './terminal-landscape'
import { typeFiles } from './terminal-files'

type Provider = { id: string; name: string; models: string[] }

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const canvas = document.querySelector('.canvas') as HTMLElement
const savedKey = 'skd.quiet.terminal', recentKey = 'skd.term.recentCwd', engineKey = 'skd.shell.engine', modelKey = 'skd.shell.model'
const POLL_MS = 5000, BUFFER_CHARS = 4000
const launch = $('live-launch') as HTMLDialogElement
const engineSelect = $('live-engine') as HTMLSelectElement
const modelInput = $('live-model') as HTMLInputElement
const cwdInput = $('live-cwd') as HTMLInputElement
const workflowSelect = $('live-workflow') as HTMLSelectElement
const submit = $('live-submit') as HTMLButtonElement
const stage = $('live-stage')
const park = $('term-park')
const dropStage = $('drop-stage')
const panes = createPanes(stage)
const views = new Map<string, TerminalView>()
document.addEventListener('mc:theme', () => { for (const view of views.values()) view.terminal.options.theme = terminalTheme() })
let sessions: Session[] = []
let activeId: string | null = null
let opening = false
let models: Record<string, string[]> = {}
let workflowsReady = false
const landscape = createLandscape(() => activeId ? views.get(activeId) ?? null : null)
const engineName = (engine: string | undefined): string => engine === 'claude' ? 'Claude Code' : providerName(engine ?? '')
cwdInput.value = (window as { SKD_WORKSPACE_DIR?: string }).SKD_WORKSPACE_DIR ?? ''

const MAC = /Mac|iPhone|iPad/.test(navigator.platform)
const barTemplate = ($('term-bar') as HTMLTemplateElement).content
const findBar = barTemplate.querySelector('#find') as HTMLElement
findBar.remove()
const findPart = (id: string): HTMLElement => findBar.querySelector(`#${id}`) as HTMLElement
const findInput = findPart('find-input') as HTMLInputElement
const TERMINAL_BYTES: Record<Exclude<TerminalKey, 'clear' | null>, string> = { newline: '\x1b\r', 'send-now': '\x1b[13;5u', 'kill-line': '\x15', 'line-start': '\x01', 'line-end': '\x05' }

const stored = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }
const store = (key: string, value: string | null): void => { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key) } catch {} }

export class TerminalView {
  readonly host = document.createElement('div')
  readonly bar = (barTemplate.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement
  readonly terminal: Terminal
  readonly fit = new FitAddon()
  readonly search = new SearchAddon()
  readonly screen = document.createElement('div')
  readonly outcomes = createOutcomeStrip()
  socket: WebSocket | null = null
  lastOutputAt: number | null = null
  ended = false
  buffer = ''
  private resizeFrame = 0
  private readonly observer: ResizeObserver
  private readonly decoder = new TextDecoder()

  constructor(public session: Session) {
    this.host.className = 'term-host'
    this.host.dataset.id = session.id
    this.screen.className = 'term-screen'
    this.host.append(this.bar, this.screen, this.outcomes.element)
    this.paintBar()
    const find = this.bar.querySelector('.term-bar-find') as HTMLButtonElement
    find.title = `Find · ${MAC ? '⌘F' : 'Ctrl+F'}`
    find.onclick = () => { if (activeId !== this.session.id) activate(this.session.id); openFind() }
    ;(this.bar.querySelector('.term-bar-status') as HTMLButtonElement).onclick = () => void reconnect(this.session.id)
    this.terminal = new Terminal({ allowProposedApi: true, ...TERMINAL_FONT, cursorBlink: !matchMedia('(prefers-reduced-motion: reduce)').matches, scrollback: 10000, macOptionIsMeta: true, theme: terminalTheme() })
    this.terminal.loadAddon(this.fit)
    this.terminal.loadAddon(this.search)
    this.terminal.loadAddon(new WebLinksAddon())
    this.terminal.loadAddon(new ClipboardAddon(undefined, writeOnlyClipboard(navigator.clipboard)))
    this.terminal.attachCustomKeyEventHandler(event => {
      if (sessionSlot(event) !== null) return false
      const find = findKeys(event, false, MAC) === 'open'
      const action = terminalKeys(event)
      if (!find && action === null) return true
      if (event.type !== 'keydown') return false
      event.preventDefault()
      if (find) openFind()
      else if (action === 'clear') this.terminal.clear()
      else if (action !== null) this.send(TERMINAL_BYTES[action])
      return false
    })
    this.search.onDidChangeResults(({ resultIndex, resultCount }) => { if (activeId === session.id) rollText(findPart('find-count'), findCount(resultIndex, resultCount, findInput.value)) })
    this.terminal.open(this.screen)
    attachTouchScroll(this.terminal, this.screen)
    this.outcomes.setSource(`terminal=${encodeURIComponent(session.id)}`)
    this.terminal.onData(data => this.send(landscape.typed(data)))
    this.observer = new ResizeObserver(() => { cancelAnimationFrame(this.resizeFrame); this.resizeFrame = requestAnimationFrame(() => this.resize()) })
    this.observer.observe(this.screen)
  }

  send(data: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(new TextEncoder().encode(data))
  }

  paintBar(): void {
    const logo = this.bar.querySelector('.term-bar-logo') as HTMLElement
    logo.dataset.engine = this.session.engine
    ;(logo.firstElementChild as HTMLImageElement).src = `/providers/${this.session.engine}.svg`
    const name = this.bar.querySelector('.term-bar-name') as HTMLElement
    name.textContent = this.session.title
    name.title = this.session.cwd
  }

  setStatus(text: string): void {
    const pill = statusPill(text)
    const button = this.bar.querySelector('.term-bar-status') as HTMLButtonElement
    button.disabled = pill.kind !== 'down'
    button.title = text
    const label = button.lastElementChild as HTMLElement
    if (button.dataset.kind === pill.kind && label.textContent === pill.text) return
    morph(button, () => { button.dataset.kind = pill.kind; label.textContent = pill.text })
  }

  get state(): SessionState { return sessionState(this.lastOutputAt, this.ended, Date.now()) }

  resize(): void {
    if (this.host.hidden || this.host.clientWidth === 0) return
    this.fit.fit()
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'resize', cols: this.terminal.cols, rows: this.terminal.rows }))
  }

  connect(): void {
    this.socket?.close()
    this.terminal.reset()
    this.terminal.options.disableStdin = true
    this.ended = false
    this.setStatus('Connecting…')
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const connection = new WebSocket(`${scheme}//${location.host}/ws/terminal/${encodeURIComponent(this.session.id)}`)
    this.socket = connection
    connection.binaryType = 'arraybuffer'
    connection.onopen = () => {
      if (this.socket !== connection) return
      this.terminal.options.disableStdin = false
      this.setStatus(`Connected · live ${engineName(this.session.engine)}`)
      if (activeId === this.session.id) { this.resize(); this.terminal.focus() }
    }
    connection.onmessage = (event) => {
      if (this.socket !== connection) return
      const text = typeof event.data === 'string' ? event.data : this.decoder.decode(new Uint8Array(event.data as ArrayBuffer), { stream: true })
      this.terminal.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer))
      this.lastOutputAt = Date.now()
      this.buffer = (this.buffer + text).slice(-BUFFER_CHARS)
    }
    connection.onerror = () => { if (this.socket === connection) this.setStatus('Connection failed. Reconnect to try again.') }
    connection.onclose = (event) => {
      if (this.socket !== connection) return
      this.terminal.options.disableStdin = true
      this.ended = event.code === 4404 || event.code === 4410
      this.setStatus(this.ended ? 'Session ended.' : 'Disconnected. Reconnect to try again.')
    }
  }

  dispose(): void {
    this.observer.disconnect()
    this.socket?.close()
    this.socket = null
    this.terminal.dispose()
    this.outcomes.destroy()
    this.host.remove()
  }
}

function visible(on: boolean): void {
  const changed = (canvas.dataset.live === 'true') !== on
  canvas.dataset.live = String(on)
  document.body.dataset.live = String(on)
  if (on) reveal($('live'), true)
  else $('live').hidden = true
  const active = on && activeId ? views.get(activeId)?.session ?? null : null
  if (changed) dispatchEvent(new CustomEvent('quiet:activity-scope', { detail: active }))
  const url = new URL(location.href)
  url.hash = on ? 'terminal' : ''
  if (!on) url.searchParams.delete('terminal')
  if (on && activeId) url.searchParams.set('terminal', activeId)
  history.replaceState(null, '', url)
  if (on) requestAnimationFrame(() => { activeId && views.get(activeId)?.resize(); if (!(document.activeElement instanceof HTMLInputElement)) activeId && views.get(activeId)?.terminal.focus() })
  else { const newChat = $('new-chat'); (newChat.offsetParent !== null ? newChat : $('message')).focus() }
}

function ensureView(session: Session): TerminalView {
  let view = views.get(session.id)
  if (!view) {
    view = new TerminalView(session)
    views.set(session.id, view)
    landscape.attach(view)
    park.append(view.host)
    view.connect()
  } else if (view.session.title !== session.title || view.session.model !== session.model) {
    view.session = session
    panes.retitle(session.id, paneHeader(session))
    view.paintBar()
  } else view.session = session
  return view
}

function paneHeader(session: Session): PaneHeader {
  return { logo: `/providers/${session.engine}.svg`, title: session.title, caption: `${providerName(session.engine)}${session.model ? ` · ${session.model}` : ''}` }
}

function setActiveState(id: string): void {
  const view = views.get(id)
  if (!view) return
  if (!findBar.hidden && activeId !== null && activeId !== id) views.get(activeId)?.search.clearDecorations()
  activeId = id
  store(savedKey, id)
  if (!findBar.hidden) { view.bar.append(findBar); findStep('next') }
  if (canvas.dataset.live === 'true') {
    const url = new URL(location.href); url.searchParams.set('terminal', id); url.hash = 'terminal'; history.replaceState(null, '', url)
    dispatchEvent(new CustomEvent('quiet:activity-scope', { detail: view.session }))
  }
  $('live').setAttribute('aria-label', `Live ${engineName(view.session.engine)} terminal`)
  landscape.refresh()
  publishSessions()
}

export function activate(id: string): void {
  const view = views.get(id)
  if (!view) return
  panes.show(id, view.host, paneHeader(view.session))
  setActiveState(id)
  visible(true)
  view.outcomes.refresh()
}

panes.onActive(id => { if (id !== activeId) setActiveState(id) })
panes.onHide(id => {
  const view = views.get(id)
  if (view) park.append(view.host)
  if (id === activeId) { const next = panes.active() ?? panes.shown()[0] ?? null; if (next) setActiveState(next) }
})

let dragZone: 'right' | 'bottom' | null = null
function paintZones(zone: 'right' | 'bottom' | null, show: boolean): void {
  dragZone = zone
  dropStage.dataset.dragging = String(show)
  for (const name of ['right', 'bottom'] as const) $(`drop-${name}`).dataset.hot = String(show && zone === name)
}
const MATCH_DECORATIONS = { matchBackground: '#8062bd33', activeMatchBackground: '#8062bd88', matchOverviewRuler: '#8062bd88', activeMatchColorOverviewRuler: '#8062bd' }
function findStep(direction: 'next' | 'prev'): void {
  const view = activeId ? views.get(activeId) : null
  if (!view) return
  if (findInput.value === '') { view.search.clearDecorations(); findPart('find-count').textContent = ''; return }
  const options = { decorations: MATCH_DECORATIONS, incremental: direction === 'next' }
  if (direction === 'next') view.search.findNext(findInput.value, options)
  else view.search.findPrevious(findInput.value, options)
}
function openFind(): boolean {
  const view = activeId ? views.get(activeId) : null
  if (!view || document.querySelector('dialog[open]')) return false
  const opened = findBar.hidden
  morph(view.bar, () => { view.bar.append(findBar); findBar.hidden = false })
  findInput.focus()
  findInput.select()
  if (opened) findStep('next')
  return true
}
function closeFind(): void {
  const view = activeId ? views.get(activeId) : null
  view?.search.clearDecorations()
  if (view) morph(view.bar, () => { findBar.hidden = true })
  else findBar.hidden = true
  findPart('find-count').textContent = ''
  view?.terminal.focus()
}
findPart('find-prev').onclick = () => findStep('prev')
findPart('find-next').onclick = () => findStep('next')
findPart('find-close').onclick = closeFind
findInput.oninput = () => findStep('next')
findInput.onkeydown = (event) => {
  event.stopPropagation()
  const action = findKeys(event, true, MAC)
  if (action === null) return
  event.preventDefault()
  if (action === 'close') closeFind()
  else if (action === 'prev') findStep('prev')
  else findStep('next')
}
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || document.querySelector('dialog[open]')) return
  if (canvas.dataset.live !== 'true') return
  if (findKeys(event, false, MAC) === 'open' && openFind()) event.preventDefault()
  else if (terminalKeys(event) === 'clear') { event.preventDefault(); void openTerminal() }
})
for (const type of ['dragover', 'drop'] as const) document.addEventListener(type, (event) => { if (dragKind(event.dataTransfer?.types ?? []) === 'files' && !dropStage.contains(event.target as Node | null)) event.preventDefault() })

const dropOver = $('drop-over')
function paintDropOver(transfer: DataTransfer | null, show: boolean): void {
  if (show) $('drop-over-title').textContent = dropCopy(Array.from(transfer?.items ?? []).filter(item => item.kind === 'file').length).title
  reveal(dropOver, show)
}
let toastTimer = 0
function toast(text: string, ms = 2000): void {
  const box = $('toast')
  if (box.hidden) { box.textContent = text; reveal(box, true, 'center bottom', 'translateX(-50%)') } else rollText(box, text)
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => reveal(box, false, 'center bottom', 'translateX(-50%)'), ms)
}
addEventListener('quiet:toast', (event) => toast(String((event as CustomEvent<string>).detail), 4000))
function dropTarget(event: DragEvent): TerminalView | null {
  const id = (event.target as Element | null)?.closest<HTMLElement>('.term-host')?.dataset.id ?? activeId
  return id ? views.get(id) ?? null : null
}
async function addFiles(files: File[], localPaths: string[], view: TerminalView): Promise<void> {
  if (view.socket?.readyState !== WebSocket.OPEN) { toast('That terminal is not connected'); return }
  let delivered = false
  const typed = await typeFiles(files, localPaths, {
    toast,
    send: (text) => {
      if (view.socket?.readyState !== WebSocket.OPEN) { toast('That terminal disconnected before the files were added'); return }
      view.socket.send(new TextEncoder().encode(text))
      activate(view.session.id)
      delivered = true
    },
  })
  if (delivered && typed === (localPaths.length || files.length)) toast(dropCopy(typed).toast)
}
const dropFiles = (transfer: DataTransfer | null, view: TerminalView): Promise<void> =>
  addFiles(Array.from(transfer?.files ?? []), pathsFromUriList(transfer?.getData('text/uri-list') ?? ''), view)
const attachInput = document.getElementById('term-attach-input') as HTMLInputElement | null
document.getElementById('live')?.addEventListener('click', (event) => {
  if ((event.target as Element).closest('[data-attach]')) attachInput?.click()
})
attachInput?.addEventListener('change', () => {
  const files = Array.from(attachInput.files ?? [])
  attachInput.value = ''
  const view = activeId ? views.get(activeId) : undefined
  if (view) void addFiles(files, [], view)
  else toast('Open a terminal first')
})
dropStage.addEventListener('dragover', (event) => {
  const kind = dragKind(event.dataTransfer?.types ?? [])
  if (kind === 'none') return
  event.preventDefault()
  if (kind === 'files') { paintDropOver(event.dataTransfer, true); return }
  const box = dropStage.getBoundingClientRect()
  const zone = event.clientX > box.left + box.width * 0.52 ? 'right' : event.clientY > box.top + box.height * 0.6 ? 'bottom' : null
  paintZones(zone, true)
})
dropStage.addEventListener('dragleave', (event) => { if (!dropStage.contains(event.relatedTarget as Node | null)) { paintZones(null, false); paintDropOver(null, false) } })
dropStage.addEventListener('drop', (event) => {
  const kind = dragKind(event.dataTransfer?.types ?? [])
  if (kind === 'none') return
  event.preventDefault()
  if (kind === 'files') { paintDropOver(null, false); const view = dropTarget(event); if (view) void dropFiles(event.dataTransfer, view); return }
  const id = event.dataTransfer?.getData('text/x-skd-terminal') ?? ''
  const plan = splitPlan(id, panes.shown(), dragZone)
  paintZones(null, false)
  const view = views.get(id)
  if (!view) return
  if (!plan) { if (panes.shown().includes(id)) activate(id); return }
  panes.split(id, view.host, paneHeader(view.session), plan.direction)
  setActiveState(id)
})

async function endSession(id: string): Promise<void> {
  let ok = false
  try { const response = await fetch(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' }); ok = response.ok || response.status === 404 } catch {}
  if (!ok) { toast('Could not remove this terminal. Try again.'); return }
  dispatchEvent(new CustomEvent('quiet:terminal-ended', { detail: id }))
  await refreshSessions()
  if (canvas.dataset.live === 'true' && activeId) views.get(activeId)?.terminal.focus()
}

async function rename(id: string, title: string): Promise<void> {
  refreshGeneration += 1
  let ok = false
  try {
    const response = await fetch(`/api/terminals/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
    ok = response.ok
  } catch {}
  if (!ok) { toast('Could not rename this terminal'); return }
  sessions = sessions.map(session => session.id === id ? { ...session, title } : session)
  const view = views.get(id)
  if (view) { view.session = { ...view.session, title }; panes.retitle(id, paneHeader(view.session)); view.paintBar() }
  publishSessions()
}

function publishSessions(): void { dispatchEvent(new CustomEvent('quiet:terminals', { detail: sessions })) }

let refreshGeneration = 0
async function refreshSessions(): Promise<void> {
  const generation = ++refreshGeneration
  const result = await getJson('/api/terminals')
  if (!result.ok || generation !== refreshGeneration) return
  sessions = (readArray(result.data.sessions) as Session[]).filter(item => typeof item.id === 'string')
  for (const session of sessions) ensureView(session)
  const order = [...views.keys()]
  const removed = order.filter(id => !sessions.some(session => session.id === id))
  for (const id of removed) { panes.hide(id); views.get(id)?.dispose(); views.delete(id) }
  if (activeId !== null && removed.includes(activeId)) {
    const survivors = order.filter(id => !removed.includes(id) || id === activeId)
    const next = nextActive(survivors, activeId, activeId)
    if (next) { if (canvas.dataset.live === 'true') activate(next); else setActiveState(next) }
    else { activeId = null; store(savedKey, null); if (canvas.dataset.live === 'true') visible(false) }
  }
  publishSessions()
}

function updateModelChoices(): void {
  ;($('live-models') as HTMLDataListElement).replaceChildren(...(models[engineSelect.value] ?? []).map(model => new Option(model, model)))
  morph(submit, () => { submit.textContent = `Open ${engineName(engineSelect.value)}` })
}

async function load(restore = false): Promise<void> {
  rollText($('live-error'), 'Checking your workspace…')
  $('live-create').hidden = true
  workflowsReady = false
  await refreshSessions()
  if (restore) {
    const target = restoreTarget(new URLSearchParams(location.search).get('terminal'), stored(savedKey), [...views.keys()])
    if (target) { launch.close(); activate(target); return }
  }
  if (!launch.open) return
  const [providerResult, workflowResult] = await Promise.all([getJson('/api/providers'), getJson('/api/studio/workflows')])
  const failed = [providerResult, workflowResult].find(item => !item.ok)
  if (failed) { rollText($('live-error'), `Could not load launch options: ${errorText(failed)}. Close and reopen to retry.`); return }
  const selected = readRecord(workflowResult.data.selected)
  if (!selected.id || !selected.revision || !selected.name) { rollText($('live-error'), 'Default workflow unavailable. Close and reopen to retry.'); return }
  const providers = readArray(providerResult.data.providers) as Provider[]
  models = Object.fromEntries(providers.map(provider => [provider.id, provider.models]))
  engineSelect.replaceChildren(...providers.map(provider => new Option(provider.name, provider.id)))
  const choice = launchChoice(providers, stored(engineKey), stored(modelKey))
  engineSelect.value = choice.engine
  modelInput.value = choice.model
  const workflows = (readArray(workflowResult.data.workflows) as Array<{ id: string; revision: string; name: string }>).filter(item => item.id && item.revision && item.name)
  const base = { id: String(selected.id), revision: String(selected.revision), name: String(selected.name) }
  workflowSelect.replaceChildren(...launchWorkflowOptions(workflows, base, workflowResult.data.design === true).map(([label, value]) => new Option(label, value)))
  workflowSelect.disabled = false
  workflowsReady = true
  updateModelChoices()
  $('live-create').hidden = false
  rollText($('live-error'), 'Choose how and where to start.')
}

export async function openTerminal(restore = false, cwd?: string): Promise<void> {
  if (opening) return
  opening = true
  ;($('live-cwd-recents') as HTMLDataListElement).replaceChildren(...readRecentDirectories(stored(recentKey)).map(cwd => new Option(cwd, cwd)))
  if (!launch.open) launch.showModal()
  try { await load(restore); if (cwd) cwdInput.value = cwd } finally { opening = false }
}

async function createTerminal(): Promise<void> {
  if (opening || !workflowsReady) return
  const cwd = cwdInput.value.trim()
  if (!cwd) { rollText($('live-error'), 'Choose a working directory.'); return }
  opening = true
  submit.disabled = true
  const engine = engineSelect.value
  const model = modelInput.value.trim()
  rollText($('live-error'), `Opening ${engineName(engine)}…`)
  try {
    const result = await postJson('/api/terminals', { engine, cwd, cols: 100, rows: 30, ...(model ? { model } : {}), ...launchWorkflowRequest(workflowSelect.value) })
    if (!result.ok) { rollText($('live-error'), `Could not open ${engineName(engine)}: ${errorText(result)}`); return }
    store(recentKey, JSON.stringify([cwd, ...readRecentDirectories(stored(recentKey)).filter(item => item !== cwd)].slice(0, 12)))
    store(engineKey, engine)
    store(modelKey, model || null)
    const session = result.data as unknown as Session
    sessions = [...sessions.filter(item => item.id !== session.id), session]
    ensureView(session)
    launch.close()
    activate(session.id)
  } finally { opening = false; submit.disabled = false }
}

async function resumeSession(resume: ResumeRequest): Promise<void> {
  if (opening) return
  opening = true
  try {
    const result = await postJson('/api/terminals', { engine: resume.engine, cwd: resume.cwd, cols: 100, rows: 30, resumeSessionId: resume.sessionId, title: resume.title.slice(0, 60) })
    if (!result.ok) { toast(`Could not resume: ${errorText(result)}`, 4000); return }
    const session = result.data as unknown as Session
    sessions = [...sessions.filter(item => item.id !== session.id), session]
    ensureView(session)
    launch.close()
    activate(session.id)
  } finally { opening = false }
}

export type TerminalLaunch = { engine: string; model?: string; cwd: string; title?: string; initialPrompt?: string }

const DROPPED_PREFIX = "The first message was not sent: this AI's terminal arguments have no {{prompt}} slot."

export function notifyDroppedFirstMessage(prompt: string, clipboard: { writeText(text: string): Promise<void> } = navigator.clipboard): void {
  void clipboard.writeText(prompt).then(
    () => toast(`${DROPPED_PREFIX} It is on your clipboard.`, 6000),
    () => toast(`${DROPPED_PREFIX} Add one in Studio, Manage AIs.`, 6000),
  )
}

async function launchTerminal(options: TerminalLaunch): Promise<void> {
  const cwd = options.cwd.trim()
  if (cwd === '') { toast('Choose a working directory.', 4000); return }
  const model = options.model?.trim() ?? ''
  const result = await postJson('/api/terminals', { engine: options.engine, cwd, cols: 100, rows: 30, ...(model === '' ? {} : { model }), ...(options.title === undefined ? {} : { title: options.title.slice(0, 60) }), ...(options.initialPrompt === undefined ? {} : { initialPrompt: options.initialPrompt }) })
  if (!result.ok) { toast(`Could not open ${engineName(options.engine)}: ${errorText(result)}`, 4000); return }
  store(recentKey, JSON.stringify([cwd, ...readRecentDirectories(stored(recentKey)).filter(item => item !== cwd)].slice(0, 12)))
  const session = result.data as unknown as Session & { firstMessageDropped?: boolean }
  if (session.firstMessageDropped === true && options.initialPrompt !== undefined) notifyDroppedFirstMessage(options.initialPrompt)
  sessions = [...sessions.filter(item => item.id !== session.id), session]
  ensureView(session)
  activate(session.id)
}

;($('live-create') as HTMLFormElement).onsubmit = (event) => { event.preventDefault(); void createTerminal() }
engineSelect.onchange = () => { modelInput.value = ''; updateModelChoices() }
addEventListener('quiet:terminal-end', (event) => void endSession((event as CustomEvent<string>).detail))
addEventListener('quiet:terminal-rename', (event) => { const { id, title } = (event as CustomEvent<{ id: string; title: string }>).detail; void rename(id, title) })
document.addEventListener('dragend', () => paintZones(null, false))
addEventListener('quiet:design', () => { if (canvas.dataset.live === 'true') visible(false) })
addEventListener('quiet:open-terminal', (event) => {
  const detail = (event as CustomEvent<{ restore?: boolean; id?: string; cwd?: string; resume?: ResumeRequest; launch?: TerminalLaunch }>).detail
  if (detail.id) { void refreshSessions().then(() => { if (views.has(detail.id!)) activate(detail.id!); else toast('That terminal has ended.', 4000) }); return }
  if (detail.resume) { void resumeSession(detail.resume); return }
  if (detail.launch) { void launchTerminal(detail.launch); return }
  void openTerminal(detail.restore === true, detail.cwd)
})
async function reconnect(id: string): Promise<void> {
  if (opening) return
  opening = true
  views.get(id)?.setStatus('Reconnecting…')
  await refreshSessions()
  opening = false
  const view = views.get(id)
  if (view && !view.ended) view.connect()
  else view?.setStatus('Session ended.')
}
setInterval(() => { if (!document.hidden) void refreshSessions() }, POLL_MS)
if (restoreRequested(location)) void openTerminal(true)
else void refreshSessions()
