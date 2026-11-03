import type { QueueTree } from '../server/queue-tree'
import { createAddDialog } from './queue-dialog'
import { createPickReview } from './queue-review'
import { createLandDialogs } from './queue-land'
import { readQueueTree, renderTree } from './queue-tree'
import { readPaused, readQueueItems, renderQueue, watchRunId, type QueueFlow, type QueueItemView, type QueueLayout, type QueuePaused, type QueuePlugin } from './queue-view'
import { errorText, getJson, postJson, readArray, readRecord, type ApiResult } from './shared'

export { parseItemRef } from './queue-dialog'
export { readQueueItems, renderQueue } from './queue-view'

const REFRESH_MS = 30_000
const FOCUS_MS = 1600
const LAYOUT_KEY = 'skd.queue.layout'
const ROW_SELECTOR = '.q-row, .q-notyet, .q-tree-tip'

let items: QueueItemView[] = []
let plugins: QueuePlugin[] = []
let flows: QueueFlow[] = []
let checkedAt: number | null = null
let paused: QueuePaused | null = null
let loaded = false
let dragId: string | null = null
let focusId: string | null = null
let paintAfterDrag = false
let layout: QueueLayout = savedLayout()
let tree: QueueTree | null = null
let treeError: string | null = null
let treeRequest = 0
const openIds = new Set<string>()

const toast = (text: string): void => { dispatchEvent(new CustomEvent('quiet:toast', { detail: text })) }
const watch = (item: QueueItemView | undefined): void => {
  const runId = item === undefined ? undefined : watchRunId(item)
  if (runId !== undefined) dispatchEvent(new CustomEvent('quiet:flow-watch', { detail: { runId } }))
}

function savedLayout(): QueueLayout {
  try { return localStorage.getItem(LAYOUT_KEY) === 'tree' ? 'tree' : 'list' } catch { return 'list' }
}

function statusLine(text: string): HTMLElement {
  const line = document.createElement('p')
  line.className = 'muted q-status'
  line.textContent = text
  return line
}

async function deleteJson(url: string): Promise<ApiResult> {
  try {
    const response = await fetch(url, { method: 'DELETE' })
    const data: unknown = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, data: readRecord(data) }
  } catch {
    return { ok: false, status: 0, data: {} }
  }
}

function readPlugins(value: unknown): QueuePlugin[] {
  return readArray(value).filter(entry => typeof entry.id === 'string').map(entry => ({
    id: String(entry.id),
    name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : String(entry.id),
    enabled: entry.enabled === true,
    ...(typeof entry.icon === 'string' ? { icon: entry.icon } : {}),
    ...(entry.queueSource === true ? { queueSource: true as const } : {}),
  }))
}

function readFlows(value: unknown): QueueFlow[] {
  return readArray(value).filter(entry => typeof entry.id === 'string' && typeof entry.name === 'string').map(entry => ({ id: String(entry.id), name: String(entry.name) }))
}

function start(section: HTMLElement): void {
  const rowsOf = (): HTMLElement[] => [...section.querySelectorAll<HTMLElement>(ROW_SELECTOR)]
  const rowFor = (target: EventTarget | null): HTMLElement | null => (target instanceof Element ? target.closest<HTMLElement>(ROW_SELECTOR) : null)
  const itemFor = (id: string | undefined): QueueItemView | undefined => items.find(item => item.id === id)
  const dialog = createAddDialog(() => ({ plugins, flows, items }), toast)
  const pickReview = createPickReview(toast)
  const landDialogs = createLandDialogs(() => items, toast)

  function applyFocus(): void {
    const row = rowsOf().find(entry => entry.dataset.id === focusId)
    if (row === undefined) return
    focusId = null
    row.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    row.setAttribute('data-focus', '')
    setTimeout(() => row.removeAttribute('data-focus'), FOCUS_MS)
  }

  function treeView(): HTMLElement {
    if (treeError !== null) return statusLine(`Could not load the git tree: ${treeError}`)
    return tree === null ? statusLine('Loading the git tree…') : renderTree(tree, items, flows)
  }

  function paint(): void {
    if (!loaded) return
    if (dragId !== null) { paintAfterDrag = true; return }
    const shown = layout === 'tree' ? { layout, treeView: treeView() } : { layout }
    section.replaceChildren(renderQueue(items, { plugins, flows, now: Date.now(), checkedAt, openIds, paused, ...shown }))
    applyFocus()
  }

  async function loadTree(): Promise<void> {
    const request = ++treeRequest
    const result = await getJson('/api/queue/tree')
    if (request !== treeRequest || layout !== 'tree') return
    if (result.ok) tree = readQueueTree(result.data)
    treeError = result.ok ? null : errorText(result)
    paint()
  }

  function showLayout(next: QueueLayout): void {
    layout = next
    try { localStorage.setItem(LAYOUT_KEY, next) } catch {}
    treeError = null
    paint()
    if (next === 'tree') void loadTree()
  }

  async function loadContext(): Promise<void> {
    const [pluginResult, flowResult] = await Promise.all([getJson('/api/plugins'), getJson('/api/studio/workflows')])
    if (pluginResult.ok) plugins = readPlugins(pluginResult.data.plugins)
    if (flowResult.ok) flows = readFlows(flowResult.data.workflows)
    paint()
  }

  async function act(button: HTMLElement, work: () => Promise<ApiResult>, done: string): Promise<void> {
    button.setAttribute('disabled', '')
    const result = await work()
    button.removeAttribute('disabled')
    toast(result.ok ? done : errorText(result))
  }

  async function checkReplies(button: HTMLElement): Promise<void> {
    button.setAttribute('disabled', '')
    const result = await postJson('/api/queue/check', {})
    button.removeAttribute('disabled')
    if (!result.ok) { toast(errorText(result)); return }
    checkedAt = Date.now()
    toast(`Checked ${Number(result.data.checked ?? 0)}, ${Number(result.data.resumed ?? 0)} resumed`)
    paint()
  }

  section.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest<HTMLElement>('[data-act]')
    const item = itemFor(button?.dataset.id)
    const action = button?.dataset.act
    const layoutButton = target?.closest<HTMLElement>('[data-layout]')
    if (layoutButton) { showLayout(layoutButton.dataset.layout === 'tree' ? 'tree' : 'list'); return }
    if (button && action === 'check') { void checkReplies(button); return }
    if (button && action === 'add') { dialog.open(); return }
    if (button && item && action === 'requeue') { void act(button, () => postJson(`/api/queue/${encodeURIComponent(item.id)}/requeue`, {}), `Requeued ${item.title}`); return }
    if (button && item && action === 'pick') { pickReview.open(item); return }
    if (button && item && action === 'remove') { void act(button, () => deleteJson(`/api/queue/${encodeURIComponent(item.id)}`), `Removed ${item.title}`); return }
    if (button && item && action === 'open-run') { dispatchEvent(new CustomEvent('quiet:studio-run', { detail: { runId: item.runIds.at(-1) } })); return }
    if (button && item && action === 'watch') { watch(item); return }
    if (button && item && action === 'land-confirm') { landDialogs.confirm(item.id); return }
    if (button && item && action === 'land-log') { landDialogs.log(item.id); return }
    if (button && item && action === 'report') { landDialogs.report(item.id); return }
    if (button && item && action === 'land-retry') { void act(button, () => postJson(`/api/queue/${encodeURIComponent(item.id)}/land/retry`, {}), `Retrying the stage of ${item.title}`); return }
    if (target?.closest('a, button')) return
    const row = rowFor(target)
    if (row?.hasAttribute('data-watchable') === true) { watch(itemFor(row.dataset.id)); return }
    if (row?.hasAttribute('data-openable') !== true || row.dataset.id === undefined) return
    if (openIds.has(row.dataset.id)) openIds.delete(row.dataset.id)
    else openIds.add(row.dataset.id)
    paint()
  })

  section.addEventListener('keydown', (event) => {
    const row = event.target instanceof Element ? event.target : null
    if (row?.hasAttribute('data-watchable') !== true || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    watch(itemFor((row as HTMLElement).dataset.id))
  })

  const dropTarget = (event: Event): HTMLElement | null => {
    const row = rowFor(event.target)
    return row?.hasAttribute('data-movable') === true && dragId !== null && row.dataset.id !== dragId ? row : null
  }
  const clearDrop = (): void => { for (const row of rowsOf()) row.removeAttribute('data-drop') }
  const endDrag = (): void => {
    dragId = null
    clearDrop()
    if (!paintAfterDrag) return
    paintAfterDrag = false
    paint()
  }
  section.addEventListener('dragstart', (event) => {
    const row = rowFor(event.target)
    if (row?.hasAttribute('data-movable') !== true) return
    dragId = row.dataset.id ?? null
    const transfer = (event as DragEvent).dataTransfer
    transfer?.setData('text/plain', dragId ?? '')
    if (transfer) transfer.effectAllowed = 'move'
  })
  section.addEventListener('dragover', (event) => {
    const row = dropTarget(event)
    if (row === null) return
    event.preventDefault()
    if (!row.hasAttribute('data-drop')) { clearDrop(); row.setAttribute('data-drop', '') }
  })
  section.addEventListener('drop', (event) => {
    const row = dropTarget(event)
    const moving = dragId
    endDrag()
    if (row === null || moving === null) return
    event.preventDefault()
    const to = items.findIndex(item => item.id === row.dataset.id)
    void postJson(`/api/queue/${encodeURIComponent(moving)}/move`, { to }).then((result) => { if (!result.ok) toast(errorText(result)) })
  })
  section.addEventListener('dragend', endDrag)
  addEventListener('dragend', () => { if (dragId !== null) endDrag() })

  addEventListener('quiet:queue-focus', (event) => {
    focusId = String((event as CustomEvent<string>).detail)
    if (section.hidden) dispatchEvent(new CustomEvent('quiet:show', { detail: 'queue' }))
    applyFocus()
  })
  addEventListener('quiet:screen', (event) => { if ((event as CustomEvent<string>).detail === 'queue') void loadContext() })
  const ageRefresh = setInterval(() => {
    if (!section.isConnected) { clearInterval(ageRefresh); return }
    if (!section.hidden && dragId === null) paint()
  }, REFRESH_MS)

  function showItems(next: QueueItemView[]): void {
    items = next
    loaded = true
    paint()
    if (layout === 'tree') void loadTree()
  }

  function showChecked(at: unknown): void {
    if (typeof at !== 'number') return
    checkedAt = at
    paint()
  }

  async function loadItems(): Promise<void> {
    const result = await getJson('/api/queue')
    if (result.ok && checkedAt === null) showChecked(result.data.checkedAt)
    if (loaded) return
    if (result.ok) { paused = readPaused(result.data.paused); showItems(readQueueItems(result.data.items)) }
    else section.replaceChildren(statusLine('Could not load the queue. Shikidan keeps trying.'))
  }

  section.replaceChildren(statusLine('Loading the queue…'))
  addEventListener('quiet:queue-items', (event) => showItems(readQueueItems((event as CustomEvent<unknown>).detail)))
  addEventListener('quiet:queue-checked', (event) => showChecked((event as CustomEvent<unknown>).detail))
  addEventListener('quiet:queue-paused', (event) => { paused = readPaused((event as CustomEvent<unknown>).detail); paint() })
  void loadItems()
  void loadContext()
}

const section = document.getElementById('queue')
if (section !== null) start(section)
