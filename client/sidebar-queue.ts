import { readRecord } from './shared'
import { readQueueItems, type QueueItemView, type QueueState } from './queue-view'

export const QUEUE_KEY = 'queue'
const FOLDED_KEY = 'skd.sidebar.queue-folded'

const QUEUE_DOT: Record<QueueState, { s: string; label: string }> = {
  building: { s: 'running', label: 'Building' },
  queued: { s: 'queued', label: 'Queued' },
  'waiting-info': { s: 'waiting', label: 'Waiting info' },
  'waiting-pick': { s: 'waiting', label: 'Pick a variant' },
  ready: { s: 'done', label: 'Ready' },
  failed: { s: 'failed', label: 'Failed' },
  landing: { s: 'running', label: 'Shipping' },
  'awaiting-stage': { s: 'waiting', label: 'Waiting for you' },
  landed: { s: 'done', label: 'Landed' },
}

const notLanded = (items: readonly QueueItemView[]): QueueItemView[] => items.filter(item => item.state !== 'landed')

let queueItems: QueueItemView[] = []

export const currentQueueItems = (): readonly QueueItemView[] => queueItems

export function openQueueStream(onChange: () => void): void {
  const stream = new EventSource('/api/queue/stream')
  stream.onmessage = (event: MessageEvent) => {
    let checkedAt: unknown
    let paused: unknown
    let parallel: unknown
    try {
      const snapshot = readRecord(JSON.parse(String(event.data)))
      queueItems = readQueueItems(snapshot.items)
      checkedAt = snapshot.checkedAt
      paused = snapshot.paused ?? null
      parallel = snapshot.parallel
    } catch { return }
    onChange()
    dispatchEvent(new CustomEvent('quiet:queue-items', { detail: queueItems }))
    if (typeof checkedAt === 'number') dispatchEvent(new CustomEvent('quiet:queue-checked', { detail: checkedAt }))
    dispatchEvent(new CustomEvent('quiet:queue-paused', { detail: paused }))
    if (parallel !== undefined) dispatchEvent(new CustomEvent('quiet:queue-parallel', { detail: parallel }))
  }
}

function queueLink(kind: 'queue' | 'queue-item', key: string, onOpen: () => void): HTMLAnchorElement {
  const element = document.createElement('a')
  element.className = 'sb-row'
  element.dataset.kind = kind
  element.dataset.key = key
  element.href = '#'
  element.onclick = (event) => { event.preventDefault(); onOpen() }
  return element
}

function inItem(element: HTMLElement): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'sb-item'
  wrap.append(element)
  return wrap
}

const showQueue = (): void => { dispatchEvent(new CustomEvent('quiet:show', { detail: 'queue' })) }

function queueItemRow(item: QueueItemView): HTMLElement {
  const element = queueLink('queue-item', `queue-item:${item.id}`, () => {
    showQueue()
    dispatchEvent(new CustomEvent('quiet:queue-focus', { detail: item.id }))
  })
  const dot = document.createElement('span')
  dot.className = 'q-dot'
  dot.dataset.s = QUEUE_DOT[item.state].s
  const text = document.createElement('span')
  text.className = 'sb-t'
  text.textContent = item.title
  text.append(Object.assign(document.createElement('small'), { textContent: QUEUE_DOT[item.state].label }))
  element.append(dot, text)
  return inItem(element)
}

function foldedSources(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]')
    return new Set(Array.isArray(saved) ? saved.filter((entry): entry is string => typeof entry === 'string') : [])
  } catch { return new Set() }
}

function saveFolded(sources: ReadonlySet<string>): void {
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...sources])) } catch {}
}

function foldButton(group: HTMLElement, source: string): HTMLButtonElement {
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'q-sb-fold' })
  button.innerHTML = '<svg aria-hidden="true"><use href="#chevron-icon"/></svg>'
  const show = (folded: boolean): void => {
    group.toggleAttribute('data-folded', folded)
    button.setAttribute('aria-expanded', String(!folded))
    button.setAttribute('aria-label', folded ? 'Show queue items' : 'Hide queue items')
  }
  button.onclick = (event) => {
    event.preventDefault()
    event.stopPropagation()
    const sources = foldedSources()
    const folded = !sources.has(source)
    if (folded) sources.add(source)
    else sources.delete(source)
    saveFolded(sources)
    show(folded)
  }
  show(foldedSources().has(source))
  return button
}

export function queueGroup(items: readonly QueueItemView[], isQueueSource: boolean, source: string): HTMLElement[] {
  if (items.length === 0 && !isQueueSource) return []
  const open = notLanded(items)
  const head = queueLink('queue', QUEUE_KEY, showQueue)
  const icon = document.createElement('span')
  icon.className = 'sb-ic'
  icon.innerHTML = '<svg><use href="#q-queue"/></svg>'
  const text = Object.assign(document.createElement('span'), { className: 'sb-t', textContent: 'Queue' })
  const count = Object.assign(document.createElement('em'), { className: 'q-sb-n', textContent: String(open.length) })
  head.append(icon, text, count)
  const group = document.createElement('div')
  group.className = 'q-sb q-sb-children'
  const headItem = inItem(head)
  headItem.classList.add('q-sb-head')
  if (open.length > 0) headItem.append(foldButton(group, source))
  group.append(headItem, ...open.map(queueItemRow))
  return [group]
}

export function queueRail(items: readonly QueueItemView[], hasQueueSource: boolean): HTMLElement[] {
  if (items.length === 0 && !hasQueueSource) return []
  const open = notLanded(items)
  const building = open.filter(item => item.state === 'building').length
  const label = `Queue · ${open.length} item${open.length === 1 ? '' : 's'}${building > 0 ? `, ${building} building` : ''}`
  const element = document.createElement('a')
  element.className = 'sb-mini'
  element.dataset.kind = 'queue'
  element.dataset.key = QUEUE_KEY
  element.href = '#'
  element.title = label
  element.setAttribute('aria-label', label)
  element.onclick = (event) => { event.preventDefault(); showQueue() }
  const icon = document.createElement('span')
  icon.className = 'sb-ic'
  icon.innerHTML = '<svg><use href="#q-queue"/></svg>'
  element.append(icon, Object.assign(document.createElement('em'), { className: 'q-mini-n', textContent: String(open.length) }))
  if (building > 0) {
    const dot = Object.assign(document.createElement('i'), { className: 'sb-dot' })
    dot.dataset.s = 'running'
    element.append(dot)
  }
  return [element]
}
