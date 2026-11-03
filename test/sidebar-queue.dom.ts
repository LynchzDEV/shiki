import { beforeAll, expect, test } from 'bun:test'
import { JSDOM, VirtualConsole } from 'jsdom'

import type { QueueItem } from '../server/queue-store'

const markup = `<div class="sb-shell" id="sb-shell">
  <aside id="sidebar" class="sb">
    <nav id="sidebar-list" class="sb-list"></nav>
    <nav id="sidebar-mini" class="sb-mini-list"></nav>
  </aside>
  <section id="conversation" hidden></section>
  <section id="queue" hidden></section>
</div>`

const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', () => {})
const { window } = new JSDOM(`<body>${markup}</body>`, { url: 'http://127.0.0.1:7777/', pretendToBeVisual: true, virtualConsole })
const doc = window.document

class FakeSource {
  static opened: FakeSource[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeSource.opened.push(this) }
  close(): void {}
  send(items: QueueItem[], checkedAt: number | null = null, extra: Record<string, unknown> = {}): void { this.onmessage?.({ data: JSON.stringify({ items, checkedAt, ...extra }) }) }
}

let plugins: Array<Record<string, unknown>> = [
  { id: 'clickup-board', name: 'ClickUp board', enabled: true, screen: 'src/screen.ts', icon: 'icon.svg' },
  { id: 'hello-board', name: 'Hello board', enabled: true, screen: 'src/screen.ts' },
]
const shown: unknown[] = []
const focused: unknown[] = []
const logged: unknown[] = []
const passedOn: unknown[] = []
let releaseList: (items: QueueItem[]) => void = () => {}
const listReply = new Promise<Response>(resolve => { releaseList = items => resolve(Response.json({ items })) })
const ageTicks: Array<{ id: number; run: () => void }> = []
const clearedTicks: unknown[] = []
const AGE_REFRESH_MS = 30_000
const flush = async (times = 3): Promise<void> => { for (let index = 0; index < times; index++) await new Promise(resolve => setTimeout(resolve, 0)) }

const NOW = Date.now()
const item = (patch: Partial<QueueItem>): QueueItem => ({
  id: 'i0', source: 'clickup-board', externalId: '86d3k1a2b', title: 'Army settings: show export columns', url: 'https://app.clickup.com/t/86d3k1a2b', repo: '/Users/me/api', flowId: null,
  state: 'queued', worktree: null, contextPath: null, answerPaths: [], runIds: [], currentRunId: null, questions: [], lastSeenId: null, error: null,
  createdAt: NOW, updatedAt: NOW, ...patch,
})
const building = item({ id: 'b1', state: 'building', title: 'Moni export: filter by call result' })
const queued = item({ id: 'q1' })
const waiting = item({ id: 'w1', state: 'waiting-info', title: 'Bulk import contacts from CSV' })
const ready = item({ id: 'r1', state: 'ready', title: 'Invoice PDF footer' })
const failed = item({ id: 'f1', state: 'failed', title: 'Kood queue retry' })

const checkedText = (): string | null | undefined => doc.querySelector('#queue .q-checked')?.textContent
const list = (): HTMLElement => doc.getElementById('sidebar-list') as HTMLElement
const groups = (): HTMLElement[] => [...list().querySelectorAll<HTMLElement>('.q-sb')]
const stream = (): FakeSource => FakeSource.opened[0]!

beforeAll(async () => {
  Object.assign(globalThis, {
    window, document: doc, Element: window.Element, HTMLElement: window.HTMLElement, localStorage: window.localStorage, location: window.location,
    getComputedStyle: window.getComputedStyle, EventSource: FakeSource, CSS: { escape: (value: string) => value },
  })
  globalThis.fetch = (async (url: string) => {
    if (String(url) === '/api/plugins') return Response.json({ plugins })
    if (String(url) === '/api/history') return Response.json({ items: [] })
    if (String(url) === '/api/queue') return listReply
    return Response.json({})
  }) as typeof fetch
  for (const method of ['log', 'warn', 'error'] as const) console[method] = (...args: unknown[]) => { logged.push(args) }
  addEventListener('quiet:show', (event) => { shown.push((event as CustomEvent).detail); doc.getElementById('queue')!.hidden = (event as CustomEvent).detail !== 'queue' })
  addEventListener('quiet:queue-focus', (event) => focused.push((event as CustomEvent).detail))
  addEventListener('quiet:queue-items', (event) => passedOn.push((event as CustomEvent).detail))
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  Object.assign(globalThis, {
    setInterval: (run: () => void, ms: number) => {
      if (ms !== AGE_REFRESH_MS) return realSetInterval(run, ms)
      ageTicks.push({ id: 1000 + ageTicks.length, run })
      return 1000 + ageTicks.length - 1
    },
    clearInterval: (id: Parameters<typeof clearInterval>[0]) => { clearedTicks.push(id); realClearInterval(id) },
  })
  await import('../client/queue')
  globalThis.setInterval = realSetInterval
  await import('../client/sidebar')
  await flush()
})

test('the sidebar and the Queue screen share one queue stream', () => {
  expect(FakeSource.opened.map(source => source.url)).toEqual(['/api/queue/stream'])
})

test('no queue group shows while the stream has said nothing', () => {
  expect(list().querySelector('[data-kind="plugin"]')).not.toBeNull()
  expect(groups()).toHaveLength(0)
})

test('a stream error shows no group and logs nothing', async () => {
  stream().onerror?.()
  await flush()
  expect(groups()).toHaveLength(0)
  expect(logged).toEqual([])
})

test('each stream message is passed on to the Queue screen, and a late first list does not undo it', async () => {
  stream().send([building, queued, waiting, ready, failed])
  await flush()
  expect(passedOn.map(items => (items as QueueItem[]).map(entry => entry.id))).toEqual([['b1', 'q1', 'w1', 'r1', 'f1']])
  releaseList([])
  await flush()
  const screenIds = [...doc.querySelectorAll<HTMLElement>('#queue .q-row')].map(row => row.dataset.id)
  expect(screenIds).toEqual(['b1', 'q1', 'w1', 'r1', 'f1'])
})

test('the Queue screen says Not checked yet until the server has checked', () => {
  expect(checkedText()).toBe('Not checked yet')
})

test('the Queue screen shows how long ago the server last checked replies', async () => {
  stream().send([building, queued, waiting, ready, failed], Date.now() - 7 * 60_000)
  await flush()
  expect(checkedText()).toBe('Checked 7 min ago')
})

test('a paused snapshot on the stream shows on the Queue screen, and the next snapshot without it clears it', async () => {
  const paused = () => doc.querySelector('#queue .q-paused')?.textContent
  stream().send([building, queued, waiting, ready, failed], null, { paused: { reason: 'codex unavailable: codex is not installed', until: Date.now() + 15 * 60_000 } })
  await flush()
  expect(paused()).toBe('Queue paused · codex unavailable: codex is not installed · retrying in 15 min')
  stream().send([building, queued, waiting, ready, failed])
  await flush()
  expect(paused()).toBeUndefined()
})

test('items sit in a group right under the plugin they came from', async () => {
  expect(groups()).toHaveLength(1)
  const group = groups()[0]!
  expect((group.previousElementSibling?.querySelector('[data-kind="plugin"]') as HTMLElement).dataset.key).toBe('plugin:clickup-board')
  expect(group.classList.contains('q-sb-children')).toBe(true)
})

test('the Queue row shows the count of every item from that source', () => {
  const head = groups()[0]!.querySelector<HTMLElement>('.sb-row[data-kind="queue"]')!
  expect(head.querySelector('.sb-t')?.textContent).toBe('Queue')
  expect(head.querySelector('.q-sb-n')?.textContent).toBe('5')
  expect(head.querySelector('use')?.getAttribute('href')).toBe('#q-queue')
})

test('each item row has its state dot, title and state words', () => {
  const rows = [...groups()[0]!.querySelectorAll<HTMLElement>('.sb-row[data-kind="queue-item"]')]
  expect(rows.map(row => [row.dataset.key, row.querySelector<HTMLElement>('.q-dot')?.dataset.s, row.querySelector('.sb-t')?.firstChild?.textContent, row.querySelector('.sb-t small')?.textContent])).toEqual([
    ['queue-item:b1', 'running', 'Moni export: filter by call result', 'Building'],
    ['queue-item:q1', 'queued', 'Army settings: show export columns', 'Queued'],
    ['queue-item:w1', 'waiting', 'Bulk import contacts from CSV', 'Waiting info'],
    ['queue-item:r1', 'done', 'Invoice PDF footer', 'Ready'],
    ['queue-item:f1', 'failed', 'Kood queue retry', 'Failed'],
  ])
})

test('the Queue row opens the Queue screen', () => {
  shown.length = 0
  focused.length = 0
  groups()[0]!.querySelector<HTMLElement>('.sb-row[data-kind="queue"]')!.click()
  expect(shown).toEqual(['queue'])
  expect(focused).toEqual([])
})

test('an item row opens the Queue screen focused on that item', () => {
  shown.length = 0
  focused.length = 0
  list().querySelector<HTMLElement>('.sb-row[data-key="queue-item:w1"]')!.click()
  expect(shown).toEqual(['queue'])
  expect(focused).toEqual(['w1'])
})

test('the Queue row is selected while the Queue screen shows', async () => {
  dispatchEvent(new CustomEvent('quiet:screen', { detail: 'queue' }))
  expect(list().querySelector<HTMLElement>('.sb-row[data-kind="queue"]')!.classList.contains('sel')).toBe(true)
  dispatchEvent(new CustomEvent('quiet:screen', { detail: 'welcome' }))
  expect(list().querySelector<HTMLElement>('.sb-row[data-kind="queue"]')!.classList.contains('sel')).toBe(false)
})

test('titles are text, never markup', async () => {
  stream().send([item({ id: 'x1', title: '<img src=x onerror=alert(1)>' })])
  await flush()
  const row = list().querySelector<HTMLElement>('.sb-row[data-key="queue-item:x1"]')!
  expect(row.querySelector('img')).toBeNull()
  expect(row.querySelector('.sb-t')?.firstChild?.textContent).toBe('<img src=x onerror=alert(1)>')
})

test('each source gets its own group; a source with no items gets none', async () => {
  stream().send([item({ id: 'h1', source: 'hello-board', title: 'Hello task' }), item({ id: 'c1' }), item({ id: 'c2', state: 'ready' })])
  await flush()
  const keys = groups().map(group => (group.previousElementSibling?.querySelector('[data-kind="plugin"]') as HTMLElement).dataset.key)
  expect(keys).toEqual(['plugin:clickup-board', 'plugin:hello-board'])
  expect(groups().map(group => group.querySelector('.q-sb-n')?.textContent)).toEqual(['2', '1'])
  stream().send([item({ id: 'h1', source: 'hello-board', title: 'Hello task' })])
  await flush()
  expect(groups()).toHaveLength(1)
  expect((groups()[0]!.previousElementSibling?.querySelector('[data-kind="plugin"]') as HTMLElement).dataset.key).toBe('plugin:hello-board')
})

test('an item whose source is not an enabled plugin shows nowhere', async () => {
  stream().send([item({ id: 'u1', source: 'gone-plugin' })])
  await flush()
  expect(groups()).toHaveLength(0)
})

test('an empty queue removes every group', async () => {
  stream().send([item({ id: 'c1' })])
  await flush()
  expect(groups()).toHaveLength(1)
  stream().send([])
  await flush()
  expect(groups()).toHaveLength(0)
})

const rail = (): HTMLElement => doc.getElementById('sidebar-mini')!
const railQueue = (): HTMLElement | null => rail().querySelector<HTMLElement>('.sb-mini[data-kind="queue"]')

test('the collapsed rail shows one Queue entry with its count and a building dot', async () => {
  stream().send([building, queued, ready])
  await flush()
  doc.getElementById('sb-shell')!.classList.add('collapsed')
  dispatchEvent(new Event('quiet:sidebar-toggle'))
  expect(rail().querySelector('[data-kind="plugin"]')).not.toBeNull()
  const entry = railQueue()!
  expect(entry.dataset.key).toBe('queue')
  expect(entry.getAttribute('title')).toBe('Queue · 3 items, 1 building')
  expect(entry.getAttribute('aria-label')).toBe('Queue · 3 items, 1 building')
  expect(entry.querySelector('use')?.getAttribute('href')).toBe('#q-queue')
  expect(entry.querySelector('.q-mini-n')?.textContent).toBe('3')
  expect(entry.querySelector<HTMLElement>('.sb-dot')?.dataset.s).toBe('running')
  expect(rail().querySelector('.q-dot, [data-kind="queue-item"]')).toBeNull()
  expect(rail().querySelectorAll('[data-kind="queue"]')).toHaveLength(1)
})

test('the rail Queue entry has no dot when nothing builds, opens the Queue screen, and is selected there', async () => {
  stream().send([queued, ready])
  await flush()
  const entry = railQueue()!
  expect(entry.querySelector('.sb-dot')).toBeNull()
  expect(entry.getAttribute('title')).toBe('Queue · 2 items')
  shown.length = 0
  entry.click()
  expect(shown).toEqual(['queue'])
  dispatchEvent(new CustomEvent('quiet:screen', { detail: 'queue' }))
  expect(railQueue()!.classList.contains('sel')).toBe(true)
  dispatchEvent(new CustomEvent('quiet:screen', { detail: 'welcome' }))
})

test('the rail has no Queue entry when no enabled source has items', async () => {
  stream().send([item({ id: 'u1', source: 'gone-plugin' })])
  await flush()
  expect(railQueue()).toBeNull()
  doc.getElementById('sb-shell')!.classList.remove('collapsed')
  dispatchEvent(new Event('quiet:sidebar-toggle'))
  stream().send([item({ id: 'c1' })])
  await flush()
})

test('a malformed message keeps the last good rows, is not passed on, and the stream stays the only one', async () => {
  const before = passedOn.length
  stream().onmessage?.({ data: 'not json' })
  await flush()
  expect(passedOn).toHaveLength(before)
  expect(groups()).toHaveLength(1)
  expect(FakeSource.opened).toHaveLength(1)
  expect(logged).toEqual([])
})

test('an empty queue still shows a Queue 0 row under a plugin that declares queueSource', async () => {
  plugins = [
    { id: 'clickup-board', name: 'ClickUp board', enabled: true, screen: 'src/screen.ts', icon: 'icon.svg', queueSource: true },
    { id: 'hello-board', name: 'Hello board', enabled: true, screen: 'src/screen.ts' },
  ]
  stream().send([])
  dispatchEvent(new Event('quiet:plugins-changed'))
  await flush()
  doc.getElementById('sb-shell')!.classList.remove('collapsed')
  expect(groups()).toHaveLength(1)
  const group = groups()[0]!
  expect((group.previousElementSibling?.querySelector('[data-kind="plugin"]') as HTMLElement).dataset.key).toBe('plugin:clickup-board')
  expect(group.querySelector('.sb-row[data-kind="queue"] .q-sb-n')?.textContent).toBe('0')
  expect(group.querySelectorAll('[data-kind="queue-item"]')).toHaveLength(0)
})

test('the empty Queue 0 row opens the Queue screen', () => {
  shown.length = 0
  focused.length = 0
  groups()[0]!.querySelector<HTMLElement>('.sb-row[data-kind="queue"]')!.click()
  expect(shown).toEqual(['queue'])
  expect(focused).toEqual([])
})

test('a queueSource plugin with items lists them under its Queue row as before', async () => {
  stream().send([item({ id: 'c1' })])
  await flush()
  expect(groups()).toHaveLength(1)
  expect(groups()[0]!.querySelector('.q-sb-n')?.textContent).toBe('1')
  expect(groups()[0]!.querySelectorAll('[data-kind="queue-item"]')).toHaveLength(1)
  stream().send([])
  await flush()
})

test('an empty queue shows no row under a plugin without queueSource', async () => {
  plugins = plugins.map(plugin => ({ ...plugin, queueSource: false }))
  dispatchEvent(new Event('quiet:plugins-changed'))
  await flush()
  expect(list().querySelector('[data-kind="plugin"]')).not.toBeNull()
  expect(groups()).toHaveLength(0)
  expect(logged).toEqual([])
})

test('the age refresh does nothing and stops once the Queue screen is gone from the page', () => {
  expect(ageTicks).toHaveLength(1)
  const tick = ageTicks[0]!
  doc.getElementById('queue')!.remove()
  Reflect.deleteProperty(globalThis, 'document')
  expect(() => tick.run()).not.toThrow()
  expect(clearedTicks).toContain(tick.id)
  expect(logged).toEqual([])
})
