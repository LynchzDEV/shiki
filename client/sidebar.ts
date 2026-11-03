import { getJson, readArray } from './shared'
import { currentQueueItems, openQueueStream, QUEUE_KEY, queueGroup, queueRail } from './sidebar-queue'
import { blendColor, fold, glide, settleIn } from './morph'
import { chatSignal, historyDay, historyOpen, type HistoryItem } from './chat-view'
import { renameValue, sessionSlot, type Session } from './terminal-state'
import { confirmButton } from './confirm-button'

type Day = 'Pinned' | 'Today' | 'Yesterday'
type Row = { item: HistoryItem; state: 'running' | 'live' | 'landed' | 'needs' | null; note: string }

const POLL_MS = 5000
const DAYS: Day[] = ['Today', 'Yesterday']
const CHAT_ICON = '<svg viewBox="0 0 20 20"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5z"/></svg>'
const TERMINAL_ICON = '<svg><use href="#terminal-icon"/></svg>'
const SHORTCUT_SLOTS = 9
const HIDDEN_KEY = 'skd.sidebar.hidden'
const keyOf = (item: HistoryItem): string => `${item.kind}:${item.id}`
const isLiveTerminal = (item: HistoryItem): boolean => item.kind === 'terminal' && item.live

const isActive = (item: HistoryItem): boolean => isLiveTerminal(item) || (item.kind === 'chat' && item.running)

export function clearableItems(items: readonly HistoryItem[]): HistoryItem[] {
  return items.filter(item => !isActive(item))
}

export function sidebarGroups(items: HistoryItem[], now: number): { day: Day; items: HistoryItem[] }[] {
  const dayOf = (item: HistoryItem): Day | null => {
    const day = historyDay(item.updatedAt, now)
    if (day === 'Today' || day === 'Yesterday') return day
    return isActive(item) ? 'Today' : null
  }
  const isPinned = (item: HistoryItem): boolean => item.kind === 'chat' && item.pinned === true
  const pinned = items.filter(isPinned)
  const days = DAYS.map(day => ({ day, items: items.filter(item => dayOf(item) === day && !isPinned(item)) })).filter(group => group.items.length > 0)
  return pinned.length > 0 ? [{ day: 'Pinned', items: pinned }, ...days] : days
}

export function withLiveTerminals(items: HistoryItem[], sessions: Session[] | null, now: number): HistoryItem[] {
  if (!sessions) return items
  const known = new Map(items.flatMap(item => item.kind === 'terminal' ? [[item.id, item] as const] : []))
  const live = sessions.map((session): HistoryItem => ({ kind: 'terminal', id: session.id, title: session.title, updatedAt: known.get(session.id)?.updatedAt ?? now, cwd: session.cwd, engine: session.engine, sessionId: session.sessionId ?? known.get(session.id)?.sessionId ?? null, live: true }))
  const liveIds = new Set(sessions.map(session => session.id))
  const openSessions = new Set(sessions.flatMap(session => session.sessionId ? [session.sessionId] : []))
  const superseded = (item: HistoryItem): boolean => {
    if (item.kind === 'claude-history') return openSessions.has(item.id)
    if (item.kind !== 'terminal') return false
    return item.live || liveIds.has(item.id) || (item.sessionId !== null && openSessions.has(item.sessionId))
  }
  return [...items.filter(item => !superseded(item)), ...live].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function visibleItems(items: readonly HistoryItem[], hidden: Readonly<Record<string, number>>): HistoryItem[] {
  return items.filter(item => { const at = hidden[keyOf(item)]; return at === undefined || item.updatedAt > at })
}

const inRail = (row: Row): boolean => row.item.kind === 'chat' || row.state === 'live'

export function numberedKeys(items: readonly HistoryItem[], collapsed = false): string[] {
  return items.filter(item => historyOpen(item) !== null && (!collapsed || inRail(rowOf(item)))).slice(0, SHORTCUT_SLOTS).map(keyOf)
}

function rowOf(item: HistoryItem): Row {
  if (item.kind !== 'chat') return { item, state: isLiveTerminal(item) ? 'live' : null, note: '' }
  const signal = chatSignal(item.running, item.agents)
  if (signal.state === 'needs-you') return { item, state: 'needs', note: `${signal.count} needs you` }
  return { item, state: signal.state, note: signal.state === 'running' && signal.count > 0 ? `${signal.count} agent${signal.count === 1 ? '' : 's'}` : '' }
}

let openChatId: string | null = null
let screen: string | null = null
let signature = ''
let historyItems: HistoryItem[] = []
let liveTerminals: Session[] | null = null
let numbered: HistoryItem[] = []
let hidden: Record<string, number> = readHidden()

type PluginLink = { id: string; name: string; icon?: string; queueSource?: true }
let pluginRows: PluginLink[] = []

async function loadPlugins(): Promise<void> {
  const feed = await getJson('/api/plugins')
  if (!feed.ok) return
  pluginRows = readArray(feed.data.plugins)
    .filter(plugin => plugin.enabled === true && typeof plugin.screen === 'string' && typeof plugin.id === 'string')
    .map(plugin => ({ id: String(plugin.id), name: typeof plugin.name === 'string' && plugin.name !== '' ? plugin.name : String(plugin.id), ...(typeof plugin.icon === 'string' ? { icon: plugin.icon } : {}), ...(plugin.queueSource === true ? { queueSource: true as const } : {}) }))
  signature = ''
  paint(historyItems)
}

function pluginIcon(plugin: PluginLink): string {
  return plugin.icon === undefined ? '<svg><use href="#auto-icon"/></svg>' : `<img src="/api/plugins/${encodeURIComponent(plugin.id)}/icon" alt="" width="16" height="16">`
}

function pluginRow(plugin: PluginLink, className: 'sb-row' | 'sb-mini'): HTMLElement {
  const element = document.createElement('a')
  element.className = className
  element.dataset.kind = 'plugin'
  element.dataset.key = `plugin:${plugin.id}`
  element.href = '#'
  element.onclick = (event) => { event.preventDefault(); dispatchEvent(new CustomEvent('quiet:show-plugin', { detail: plugin.id })) }
  const icon = document.createElement('span')
  icon.className = 'sb-ic'
  icon.innerHTML = pluginIcon(plugin)
  element.append(icon)
  if (className === 'sb-mini') {
    element.title = plugin.name
    return element
  }
  const text = document.createElement('span')
  text.className = 'sb-t'
  text.textContent = plugin.name
  element.append(text)
  const wrap = document.createElement('div')
  wrap.className = 'sb-item'
  wrap.append(element)
  return wrap
}

function readHidden(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '{}') as Record<string, number> } catch { return {} }
}

function hide(keys: readonly string[]): void {
  const at = Date.now()
  hidden = { ...readHidden(), ...Object.fromEntries(keys.map(key => [key, at])) }
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden)) } catch {}
  const repaint = (): void => { signature = ''; paint(historyItems) }
  const rows = keys.flatMap(key => document.querySelector<HTMLElement>(`#sidebar-list .sb-row[data-key="${CSS.escape(key)}"]`)?.closest<HTMLElement>('.sb-item') ?? [])
  if (rows.length === 0) { repaint(); return }
  let folding = rows.length
  for (const row of rows) fold(row, () => { folding -= 1; if (folding === 0) repaint() })
}

async function removeTerminal(id: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return response.ok || response.status === 404
  } catch {
    return false
  }
}

async function clearGroup(items: readonly HistoryItem[]): Promise<void> {
  const targets = clearableItems(items)
  const removed = await Promise.all(targets.map(item => item.kind === 'terminal' ? removeTerminal(item.id) : Promise.resolve(true)))
  hide(targets.filter((_, index) => removed[index]).map(keyOf))
  const failed = removed.filter(ok => !ok).length
  if (failed > 0) dispatchEvent(new CustomEvent('quiet:toast', { detail: `${failed} terminal${failed === 1 ? '' : 's'} could not be removed. Try again.` }))
}

function dayHeader(group: { day: Day; items: HistoryItem[] }): HTMLElement {
  const header = Object.assign(document.createElement('p'), { className: 'sb-day', textContent: group.day })
  if (group.day === 'Pinned' || clearableItems(group.items).length === 0) return header
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'sb-clear', title: `Remove every finished row in ${group.day}` })
  button.setAttribute('aria-label', `Clear ${group.day}`)
  button.innerHTML = '<svg aria-hidden="true"><use href="#close-icon"/></svg><span>Clear all</span>'
  header.append(button)
  confirmButton(button, 'Clear all', () => void clearGroup(group.items))
  return header
}
let renaming = false

function selectedKey(): string | null {
  if (document.body.dataset.live === 'true') { const id = new URL(location.href).searchParams.get('terminal'); return id ? `terminal:${id}` : null }
  if (screen === 'queue' || screen === 'queue-review') return QUEUE_KEY
  return openChatId && !document.getElementById('conversation')?.hidden ? `chat:${openChatId}` : null
}

function open(item: HistoryItem): void {
  const target = historyOpen(item)
  if (target === null) return
  if ('chat' in target) dispatchEvent(new CustomEvent('quiet:open-chat', { detail: target.chat }))
  else dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: target.terminal }))
}

function startRename(item: HistoryItem, text: HTMLElement, onCommit?: (title: string) => void): void {
  if (renaming) return
  renaming = true
  const input = Object.assign(document.createElement('input'), { className: 'sb-rename', value: item.title, maxLength: 60 })
  input.setAttribute('aria-label', onCommit === undefined ? 'Terminal name' : 'Chat name')
  text.replaceWith(input)
  settleIn(input)
  let settled = false
  const finish = (save: boolean): void => {
    if (settled) return
    settled = true
    renaming = false
    const title = save ? renameValue(item.title, input.value) : null
    input.replaceWith(text)
    settleIn(text)
    if (title !== null) {
      if (onCommit === undefined) dispatchEvent(new CustomEvent('quiet:terminal-rename', { detail: { id: item.id, title } }))
      else onCommit(title)
    }
    signature = ''
    paint(historyItems)
  }
  input.onkeydown = (event) => {
    event.stopPropagation()
    if (event.key === 'Enter') { event.preventDefault(); finish(true) }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false) }
  }
  input.onblur = () => finish(false)
  input.onclick = (event) => { event.stopPropagation(); event.preventDefault() }
  input.focus()
  input.select()
}

function liveTerminalActions(item: HistoryItem, element: HTMLElement, text: HTMLElement | null): void {
  element.draggable = true
  element.ondragstart = (event) => { event.dataTransfer?.setData('text/x-skd-terminal', item.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move' }
  if (text) text.ondblclick = (event) => { event.preventDefault(); event.stopPropagation(); startRename(item, text) }
}

async function patchChat(id: string, body: Record<string, unknown>, onDone?: () => void): Promise<void> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    dispatchEvent(new CustomEvent('quiet:toast', { detail: payload.error ?? 'That change did not go through' }))
    return
  }
  onDone?.()
  void poll()
}

let menuOpen = false

function closeRowMenu(): void {
  if (!menuOpen) return
  menuOpen = false
  document.querySelectorAll('.popover.row-menu').forEach(menu => menu.remove())
  document.querySelectorAll('.sb-item.menu-open').forEach(item => item.classList.remove('menu-open'))
  signature = ''
  paint(historyItems)
}

function menuRow(label: string, iconId: string, action: () => void, extra?: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'row'
  button.setAttribute('role', 'menuitem')
  button.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 20 20"><use href="#${iconId}"/></svg>`)
  const text = document.createElement('span')
  text.textContent = label
  button.append(text)
  if (extra !== undefined) {
    const hint = document.createElement('kbd')
    hint.textContent = extra
    button.append(hint)
  }
  button.onclick = () => {
    closeRowMenu()
    action()
  }
  return button
}

function chatRow(item: HistoryItem): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#sidebar-list .sb-row[data-key="${CSS.escape(keyOf(item))}"]`)
}

function renameChat(item: HistoryItem, text: HTMLElement): void {
  startRename(item, text, title => void patchChat(item.id, { label: title, titleLocked: true }))
}

function exportUrl(item: HistoryItem): string {
  let leaf: string | null = null
  try { leaf = localStorage.getItem(`skd.chat.leaf.${item.id}`) } catch {}
  return `/api/jobs/${encodeURIComponent(item.id)}/export.md${leaf ? `?leaf=${encodeURIComponent(leaf)}` : ''}`
}

function openChatMenu(item: HistoryItem): void {
  if (renaming || item.kind !== 'chat') return
  closeRowMenu()
  const wrap = chatRow(item)?.closest<HTMLElement>('.sb-item') ?? null
  if (wrap === null) return
  menuOpen = true
  wrap.classList.add('menu-open')
  const menu = document.createElement('div')
  menu.className = 'popover row-menu'
  menu.setAttribute('role', 'menu')
  const divider = document.createElement('div')
  divider.className = 'divider'
  const remove = menuRow('Delete chat', 'trash-icon', () => {})
  remove.classList.add('danger')
  remove.onclick = null
  menu.append(
    menuRow('Rename', 'pencil-icon', () => { const text = chatRow(item)?.querySelector<HTMLElement>('.sb-t'); if (text) renameChat(item, text) }, 'F2'),
    menuRow(item.pinned === true ? 'Unpin' : 'Pin to top', 'pin-icon', () => void patchChat(item.id, { pinned: item.pinned !== true })),
    menuRow('Export as Markdown', 'export-icon', () => { window.location.href = exportUrl(item) }),
    divider,
    remove,
  )
  wrap.append(menu)
  confirmButton(remove, 'Delete chat', () => {
    closeRowMenu()
    void patchChat(item.id, { deleted: true }, () => {
      if (selectedKey() === `chat:${item.id}`) dispatchEvent(new Event('quiet:new-chat'))
    })
  })
  menu.querySelector<HTMLButtonElement>('.row')?.focus()
}

function chatRowFromEvent(event: Event): HistoryItem | null {
  const target = event.target instanceof Element ? event.target : null
  const row = target?.closest<HTMLElement>('.sb-row[data-kind="chat"]') ?? null
  if (row === null) return null
  return historyItems.find(item => keyOf(item) === row.dataset.key) ?? null
}

function removeButton(item: HistoryItem, wrap: HTMLElement, state: Row['state']): void {
  const live = isLiveTerminal(item)
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'sb-morph', title: live ? 'End and remove this terminal' : 'Remove from sidebar' })
  if (state) button.dataset.s = state
  button.setAttribute('aria-label', `Remove ${item.title}`)
  button.innerHTML = '<svg aria-hidden="true"><use href="#close-icon"/></svg><span>Remove</span>'
  wrap.append(button)
  confirmButton(button, 'Remove', () => {
    if (item.kind === 'terminal') dispatchEvent(new CustomEvent('quiet:terminal-end', { detail: item.id }))
    else hide([keyOf(item)])
  })
}

function rowElement(row: Row, className: 'sb-row' | 'sb-mini'): HTMLElement {
  const element = document.createElement('a')
  element.className = className
  element.dataset.kind = row.item.kind
  element.dataset.key = keyOf(row.item)
  element.href = row.item.kind === 'chat' ? `?chat=${encodeURIComponent(row.item.id)}` : isLiveTerminal(row.item) ? `?terminal=${encodeURIComponent(row.item.id)}#terminal` : '#'
  element.onclick = (event) => { event.preventDefault(); open(row.item) }
  const icon = document.createElement('span'); icon.className = 'sb-ic'; icon.innerHTML = row.item.kind === 'chat' ? CHAT_ICON : TERMINAL_ICON
  element.append(icon)
  const slot = numbered.findIndex(item => keyOf(item) === keyOf(row.item))
  const badge = slot < 0 ? null : Object.assign(document.createElement('kbd'), { className: 'sb-key', textContent: `⌘${slot + 1}`, title: `Open · ⌘${slot + 1}` })
  const dot = row.state ? Object.assign(document.createElement('i'), { className: 'sb-dot' }) : null
  if (dot) dot.dataset.s = row.state!
  if (className === 'sb-mini') {
    element.title = row.item.title
    element.append(...[badge, dot].filter((part): part is HTMLElement => part !== null))
    return element
  }
  const text = document.createElement('span'); text.className = 'sb-t'; text.textContent = row.item.title
  if (row.note) text.append(Object.assign(document.createElement('small'), { textContent: row.note }))
  const trail = document.createElement('span'); trail.className = 'sb-trail'
  const pin = row.item.kind === 'chat' && row.item.pinned === true ? Object.assign(document.createElement('span'), { className: 'sb-pin', title: 'Pinned to top' }) : null
  if (pin) pin.innerHTML = '<svg viewBox="0 0 20 20"><path d="M8 3h4l-.5 4.5L14 10v1.5H6V10l2.5-2.5z"/><path d="M10 11.5V17"/></svg>'
  trail.append(...[pin, badge, Object.assign(document.createElement('span'), { className: 'sb-slot' })].filter((part): part is HTMLElement => part !== null))
  element.append(text, trail)
  const wrap = document.createElement('div')
  wrap.className = 'sb-item'
  wrap.append(element)
  if (isLiveTerminal(row.item)) liveTerminalActions(row.item, element, text)
  removeButton(row.item, wrap, row.state)
  return wrap
}

function dotElements(): Array<[string, HTMLElement]> {
  const inList = [...document.querySelectorAll<HTMLElement>('#sidebar-list .sb-morph')].map((dot): [string, HTMLElement] => [(dot.previousElementSibling as HTMLElement | null)?.dataset.key ?? '', dot])
  const inRail = [...document.querySelectorAll<HTMLElement>('#sidebar-mini .sb-dot')].map((dot): [string, HTMLElement] => [`rail:${(dot.parentElement as HTMLElement).dataset.key}`, dot])
  return [...inList, ...inRail]
}

function dotColors(): Map<string, string> {
  return new Map(dotElements().map(([key, dot]) => [key, getComputedStyle(dot).backgroundColor]))
}

let lastSelected: HTMLElement | null = null

function markSelected(): void {
  const key = selectedKey()
  const list = document.getElementById('sidebar-list')
  const from = list?.querySelector<HTMLElement>('.sb-row.sel') ?? (lastSelected?.isConnected ? lastSelected : null)
  document.querySelectorAll<HTMLElement>('#sidebar .sb-row, #sidebar .sb-mini').forEach(element => {
    const selected = element.dataset.key === key
    element.classList.toggle('sel', selected)
    if (selected) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current')
  })
  const to = list?.querySelector<HTMLElement>('.sb-row.sel') ?? null
  if (list && from && to && from !== to) glide(list, from, to, 'sb-glide')
  if (to) lastSelected = to
}

function paint(items: HistoryItem[]): void {
  historyItems = items
  if (renaming || menuOpen) return
  const groups = sidebarGroups(visibleItems(withLiveTerminals(items, liveTerminals, Date.now()), hidden), Date.now())
  const rows = groups.flatMap(group => group.items.map(rowOf))
  const keys = numberedKeys(rows.map(row => row.item), document.getElementById('sb-shell')?.classList.contains('collapsed'))
  numbered = keys.flatMap(key => rows.filter(row => keyOf(row.item) === key).map(row => row.item))
  const next = JSON.stringify([pluginRows.map(plugin => [plugin.id, plugin.name, plugin.icon ?? null, plugin.queueSource === true]), currentQueueItems().map(item => [item.source, item.id, item.title, item.state]), groups.map(group => [group.day, group.items.length]), rows.map(row => [row.item.kind, row.item.id, row.item.title, row.state, row.note, row.item.kind === 'chat' && row.item.pinned === true]), keys])
  if (next === signature) return
  signature = next
  const list = document.getElementById('sidebar-list')!
  const dots = dotColors()
  list.replaceChildren(
    ...(pluginRows.length > 0 ? [Object.assign(document.createElement('p'), { className: 'sb-day', textContent: 'Plugins' })] : []),
    ...pluginRows.flatMap(plugin => [pluginRow(plugin, 'sb-row'), ...queueGroup(currentQueueItems().filter(item => item.source === plugin.id), plugin.queueSource === true)]),
    ...groups.flatMap(group => [
      dayHeader(group),
      ...group.items.map(item => rowElement(rowOf(item), 'sb-row')),
    ]),
  )
  const sourced = currentQueueItems().filter(item => pluginRows.some(plugin => plugin.id === item.source))
  document.getElementById('sidebar-mini')!.replaceChildren(...pluginRows.map(plugin => pluginRow(plugin, 'sb-mini')), ...queueRail(sourced, pluginRows.some(plugin => plugin.queueSource === true)), ...rows.filter(inRail).map(row => rowElement(row, 'sb-mini')))
  for (const [key, dot] of dotElements()) blendColor(dot, dots.get(key))
  markSelected()
}

let timer = 0
async function poll(): Promise<void> {
  clearTimeout(timer)
  if (document.visibilityState === 'visible') {
    const feed = await getJson('/api/history')
    if (feed.ok) paint(readArray(feed.data.items) as unknown as HistoryItem[])
  }
  timer = window.setTimeout(() => void poll(), POLL_MS)
}

if (typeof document !== 'undefined') {
  addEventListener('quiet:chat-open', (event) => { openChatId = (event as CustomEvent<string>).detail; markSelected(); void poll() })
  addEventListener('quiet:terminals', (event) => { liveTerminals = (event as CustomEvent<Session[]>).detail; paint(historyItems); markSelected() })
  addEventListener('quiet:new-chat', () => { openChatId = null; markSelected() })
  addEventListener('quiet:sidebar-toggle', () => paint(historyItems))
  addEventListener('quiet:terminal-ended', (event) => hide([`terminal:${(event as CustomEvent<string>).detail}`]))
  addEventListener('storage', (event) => { if ((event as StorageEvent).key === HIDDEN_KEY) { hidden = readHidden(); signature = ''; paint(historyItems) } })
  addEventListener('quiet:screen', (event) => { screen = String((event as CustomEvent<string>).detail); markSelected() })
  addEventListener('quiet:activity-scope', markSelected)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void poll() })
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (target === null || (target.closest('.row-menu') === null && target.closest('.sb-row[data-kind="chat"]') === null)) closeRowMenu()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menuOpen) {
      closeRowMenu()
      return
    }
    if (event.defaultPrevented || document.querySelector('dialog[open]')) return
    const item = numbered[sessionSlot(event) ?? -1]
    if (!item) return
    event.preventDefault()
    open(item)
  })
  const list = document.getElementById('sidebar-list')
  list?.addEventListener('contextmenu', (event) => {
    const item = chatRowFromEvent(event)
    if (item === null) {
      closeRowMenu()
      return
    }
    event.preventDefault()
    openChatMenu(item)
  })
  list?.addEventListener('keydown', (event) => {
    const item = chatRowFromEvent(event)
    if (item === null) return
    const anchor = event.target instanceof Element ? event.target.closest<HTMLElement>('.sb-row') : null
    if (event.key === 'F2' && anchor !== null) {
      event.preventDefault()
      const text = anchor.querySelector<HTMLElement>('.sb-t')
      if (text !== null) renameChat(item, text)
      return
    }
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault()
      openChatMenu(item)
    }
  })
  void poll()
  void loadPlugins()
  openQueueStream(() => paint(historyItems))
  addEventListener('quiet:plugins-changed', () => void loadPlugins())
}
