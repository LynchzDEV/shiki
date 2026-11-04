import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

import type { QueueItem } from '../server/queue-store'

const { window } = new JSDOM('<body><main><section id="queue" class="studio" aria-label="Queue"></section><section id="queue-review" class="studio q-review" aria-label="Pick a design"></section></main></body>', { url: 'http://127.0.0.1:7777/' })
const doc = window.document
const section = () => doc.getElementById('queue') as HTMLElement

class FakeSource {
  static opened: string[] = []
  constructor(readonly url: string) { FakeSource.opened.push(url) }
  close() {}
}
const send = (items: QueueItem[]) => { dispatchEvent(new CustomEvent('quiet:queue-items', { detail: items })) }

type Call = { method: string; url: string; body: unknown }
const calls: Call[] = []
const replies = new Map<string, () => Response>()
const toasts: string[] = []
const studioRuns: unknown[] = []
const watched: unknown[] = []
const realFetch = globalThis.fetch
const flush = async (times = 3) => { for (let index = 0; index < times; index++) await new Promise(resolve => setTimeout(resolve, 0)) }

const NOW = Date.now()
const item = (patch: Partial<QueueItem>): QueueItem => ({
  id: 'i0', source: 'clickup-board', externalId: '86d3k1a2b', title: 'Army settings: show export columns', url: 'https://app.clickup.com/t/86d3k1a2b', repo: '/Users/me/api', flowId: null,
  state: 'queued', worktree: null, contextPath: null, answerPaths: [], runIds: [], currentRunId: null, questions: [], lastSeenId: null, error: null,
  createdAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000, ...patch,
})
const building = item({ id: 'b1', state: 'building', title: 'Moni export: filter by call result', runIds: ['r-b1'], currentRunId: 'r-b1', updatedAt: NOW - 12 * 60_000 })
const queuedA = item({ id: 'q1', title: 'Army settings: show export columns' })
const queuedB = item({ id: 'q2', title: 'Backoffice: add tax ID to invoice', flowId: 'plan-only' })
const waiting = item({ id: 'w1', state: 'waiting-info', title: 'Bulk import contacts from CSV', questions: ['Which CSV columns are required?', 'Should duplicates be skipped?'], runIds: ['r-w1'], updatedAt: NOW - 5 * 3_600_000 })
const ready = item({ id: 'r1', state: 'ready', title: 'Invoice PDF footer', runIds: ['r-old', 'r-ready'], updatedAt: NOW - 20 * 60_000 })
const failed = item({ id: 'f1', state: 'failed', title: 'Kood queue retry', runIds: ['r-failed'], error: 'Review failed 3 times' })
const all = [building, queuedA, queuedB, waiting, ready, failed]

const plugins = [{ id: 'clickup-board', name: 'ClickUp board', icon: 'icon.svg', enabled: true }, { id: 'jira-board', name: 'Jira board', enabled: true }, { id: 'off-board', name: 'Off board', enabled: false }]
const flows = [{ id: 'plan-only', name: 'Plan only' }, { id: 'default', name: 'Default' }]
const context = (patch: Record<string, unknown> = {}) => ({ plugins, flows, now: NOW, checkedAt: null, openIds: new Set<string>(), ...patch })

let queue: typeof import('../client/queue')
let firstIds: string[] = []
let firstCalls: string[] = []

const rows = (root: ParentNode = section()) => [...root.querySelectorAll<HTMLElement>('.q-row')]
const rowOf = (id: string) => rows().find(row => row.dataset.id === id) as HTMLElement
const buttonNamed = (text: string, root: ParentNode = doc) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text) as HTMLButtonElement
const click = (element: Element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const menuItem = (id: string, label: string): HTMLButtonElement => {
  if (rowOf(id).querySelector('.q-menu') === null) click(rowOf(id).querySelector('.q-more')!)
  return buttonNamed(label, rowOf(id).querySelector('.q-menu')!)
}
const offered = (items: QueueItem[], id: string) => {
  const row = rows(queue.renderQueue(items, context({ menuId: id }))).find(entry => entry.dataset.id === id)!
  const texts = (selector: string) => [...row.querySelectorAll(selector)].map(button => button.textContent)
  return { main: texts('.q-acts > button:not(.q-more)'), menu: texts('.q-menu [role="menuitem"]'), row }
}
const escape = () => doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
const drag = (type: string, element: Element) => element.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }))

beforeAll(async () => {
  const dialogProto = window.HTMLDialogElement.prototype as unknown as Record<string, unknown>
  dialogProto.showModal = function (this: HTMLDialogElement): void { this.open = true }
  dialogProto.close = function (this: HTMLDialogElement): void { if (!this.open) return; this.open = false; this.dispatchEvent(new window.Event('close')) }
  Object.assign(globalThis, { window, document: doc, EventSource: FakeSource, localStorage: window.localStorage, Element: window.Element, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, location: window.location })
  window.localStorage.setItem('skd.term.recentCwd', JSON.stringify(['/Users/me/api', '/Users/me/web']))
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url: String(url), body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null }
    calls.push(call)
    const reply = replies.get(`${call.method} ${call.url}`)
    if (reply) return reply()
    if (call.url === '/api/queue') return Response.json({ items: [queuedA, queuedB], checkedAt: NOW - 3 * 60_000, parallel: 2 })
    if (call.url === '/api/plugins') return Response.json({ plugins })
    if (call.url === '/api/studio/workflows') return Response.json({ workflows: flows, selected: flows[1] })
    return Response.json({ ok: true })
  }) as typeof fetch
  addEventListener('quiet:toast', (event) => toasts.push(String((event as CustomEvent).detail)))
  addEventListener('quiet:show', (event) => shown.push(String((event as CustomEvent).detail)))
  addEventListener('quiet:studio-run', (event) => studioRuns.push((event as CustomEvent).detail))
  addEventListener('quiet:flow-watch', (event) => watched.push((event as CustomEvent).detail))
  queue = await import('../client/queue')
  await flush()
  firstIds = rows().map(row => row.dataset.id ?? '')
  firstCalls = calls.map(entry => `${entry.method} ${entry.url}`)
})

beforeEach(async () => {
  escape()
  send(all)
  await flush()
  calls.length = 0
  toasts.length = 0
  shown.length = 0
  studioRuns.length = 0
  watched.length = 0
  replies.clear()
})

afterAll(() => {
  section().remove()
  globalThis.fetch = realFetch
  for (const key of ['window', 'document', 'EventSource', 'localStorage', 'Element', 'HTMLElement', 'HTMLInputElement', 'location']) Reflect.deleteProperty(globalThis, key)
  window.close()
})

test('renders one row per item in order with the right pill text', () => {
  const view = queue.renderQueue(all, context())
  expect(rows(view).map(row => row.querySelector('.q-main strong')?.textContent)).toEqual(all.map(entry => entry.title))
  expect(rows(view).map(row => row.querySelector('.pill-state')?.textContent)).toEqual(['Building', 'Queued', 'Queued', 'Waiting info', 'Ready', 'Failed'])
  expect(view.querySelector('.studio-heading h1')?.textContent).toBe('Queue')
  expect([...view.querySelectorAll('.q-bar > .pill-state')].map(pill => pill.textContent)).toEqual(['1 building', '2 queued', '1 waiting', '1 ready', '1 failed'])
})

test('progress text follows each state', () => {
  const view = queue.renderQueue(all, context())
  const progress = rows(view).map(row => row.querySelector('.q-meta > span:last-child')?.textContent)
  expect(progress).toEqual(['Building', 'Next up', '3rd in line', 'Asked 2 questions · 5h ago', 'Built · 20 min ago', 'Review failed 3 times'])
  expect(rows(view)[2]?.querySelector('.q-meta')?.textContent).toContain('Plan only')
  expect(rows(view)[1]?.querySelector('.q-meta')?.textContent).toContain('Default flow')
})

const pausedLine = (root: ParentNode) => [...root.querySelectorAll('[role=status]')].find(line => line.textContent?.startsWith('Queue paused'))

test('a paused queue says why and when it retries, above the items', () => {
  const view = queue.renderQueue(all, context({ paused: { reason: 'codex unavailable: codex is not installed', until: NOW + 15 * 60_000 } }))
  const line = pausedLine(view) as HTMLElement
  expect(line.textContent).toBe('Queue paused · codex unavailable: codex is not installed · retrying in 15 min')
  expect(line.compareDocumentPosition(view.querySelector('.q-list')!) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(view.querySelector('.q-checked')?.textContent).toBe('Not checked yet')
})

test('a running queue, or a snapshot without paused, shows no paused line', () => {
  expect(pausedLine(queue.renderQueue(all, context({ paused: null })))).toBeUndefined()
  expect(pausedLine(queue.renderQueue(all, context()))).toBeUndefined()
})

test('the live queue screen shows and clears the paused line as snapshots arrive', async () => {
  dispatchEvent(new CustomEvent('quiet:queue-paused', { detail: { reason: 'codex unavailable: codex is not installed', until: Date.now() + 2 * 3_600_000 } }))
  await flush()
  expect(pausedLine(section())?.textContent).toBe('Queue paused · codex unavailable: codex is not installed · retrying in 2h')
  dispatchEvent(new CustomEvent('quiet:queue-paused', { detail: null }))
  await flush()
  expect(pausedLine(section())).toBeUndefined()
})

test('the live queue screen follows At once as stream snapshots change it', async () => {
  const atOnce = () => section().querySelector<HTMLSelectElement>('.q-at-once select')
  dispatchEvent(new CustomEvent('quiet:queue-parallel', { detail: 3 }))
  await flush()
  expect(atOnce()?.value).toBe('3')
  dispatchEvent(new CustomEvent('quiet:queue-parallel', { detail: 2 }))
  await flush()
  expect(atOnce()?.value).toBe('2')
})

test('summary only counts states that have items', () => {
  const view = queue.renderQueue([queuedA], context())
  expect([...view.querySelectorAll('.q-bar > .pill-state')].map(pill => pill.textContent)).toEqual(['1 queued'])
})

test('empty queue shows how to add an item', () => {
  const view = queue.renderQueue([], context())
  expect(rows(view)).toHaveLength(0)
  const empty = view.querySelector('.q-empty') as HTMLElement
  expect(empty.querySelector('h2')?.textContent).toBe('Nothing in the queue')
  expect(empty.textContent).toContain('Items come from a source plugin')
  expect(empty.textContent).toContain('shiki queue add')
  expect(buttonNamed('Add item', view)).toBeDefined()
})

test('an item from an unknown source still renders', () => {
  const view = queue.renderQueue([item({ id: 'u1', source: 'gone-plugin' })], context())
  const badge = view.querySelector('.q-src') as HTMLElement
  expect(badge.textContent).toBe('gone-plugin')
  expect(badge.querySelector('img')).toBeNull()
  expect(view.querySelector('.q-main strong')?.textContent).toBe('Army settings: show export columns')
})

test('a known source shows its icon and name, linking only http links', () => {
  const view = queue.renderQueue([queuedA, item({ id: 'x1', url: 'javascript:alert(1)' }), item({ id: 'j1', source: 'jira-board' })], context())
  const [linked, plain, noIcon] = [...view.querySelectorAll<HTMLElement>('.q-src')]
  expect(linked?.tagName).toBe('A')
  expect(linked?.getAttribute('href')).toBe('https://app.clickup.com/t/86d3k1a2b')
  expect(linked?.querySelector('img')?.getAttribute('src')).toBe('/api/plugins/clickup-board/icon')
  expect(linked?.textContent).toBe('ClickUp board')
  expect(plain?.tagName).toBe('SPAN')
  expect(plain?.hasAttribute('href')).toBe(false)
  expect(noIcon?.querySelector('img')).toBeNull()
  expect(noIcon?.textContent).toBe('Jira board')
})

test('a disabled plugin gets the generic badge, not its icon', () => {
  const offWithIcon = [...plugins, { id: 'off-icon', name: 'Off icon board', icon: 'icon.svg', enabled: false }]
  const view = queue.renderQueue([item({ id: 'o1', source: 'off-icon' })], context({ plugins: offWithIcon }))
  const badge = view.querySelector('.q-src') as HTMLElement
  expect(badge.querySelector('img')).toBeNull()
  expect(badge.querySelector('.mk-logo use')?.getAttribute('href')).toBe('#auto-icon')
  expect(badge.textContent).toBe('Off icon board')
})

test('only queued rows are draggable', () => {
  const view = queue.renderQueue(all, context())
  expect(rows(view).filter(row => row.getAttribute('draggable') === 'true').map(row => row.dataset.id)).toEqual(['q1', 'q2'])
  expect(rows(view).filter(row => row.hasAttribute('data-movable')).map(row => row.dataset.id)).toEqual(['q1', 'q2'])
})

test('each state offers one main button and the rest in its menu, safe actions first', () => {
  const view = queue.renderQueue(all, context())
  expect(view.querySelector('.q-menu')).toBeNull()
  expect(rows(view).map(row => row.querySelectorAll('.q-more[aria-expanded="false"]').length)).toEqual([1, 1, 1, 1, 1, 1])
  expect(offered(all, 'b1')).toMatchObject({ main: ['Watch'], menu: ['Report', 'Stop', 'Remove'] })
  expect(offered(all, 'q1')).toMatchObject({ main: [], menu: ['Report', 'Remove'] })
  expect(offered(all, 'w1')).toMatchObject({ main: [], menu: ['Requeue', 'Report', 'Remove'] })
  expect(offered(all, 'r1')).toMatchObject({ main: ['Open run'], menu: ['Requeue', 'Report', 'Remove'] })
  expect(offered(all, 'f1')).toMatchObject({ main: ['Requeue'], menu: ['Open run', 'Report', 'Remove'] })
  expect(offered(all, 'b1').row.querySelectorAll('.q-menu .row.danger')).toHaveLength(2)
  expect(buttonNamed('Git tree', view).disabled).toBe(false)
  expect(buttonNamed('Git tree', view).getAttribute('aria-pressed')).toBe('false')
  expect(buttonNamed('List', view).getAttribute('aria-pressed')).toBe('true')
})

test('the screen opens no stream of its own and starts from one GET of the list', () => {
  expect(FakeSource.opened).toEqual([])
  expect(firstCalls.filter(entry => entry.endsWith('/api/queue'))).toEqual(['GET /api/queue'])
  expect(firstIds).toEqual(['q1', 'q2'])
})

test('queue items passed on by the sidebar fill the screen', async () => {
  send([waiting, queuedA])
  await flush()
  expect(rows().map(row => row.dataset.id)).toEqual(['w1', 'q1'])
  send(all)
  await flush()
  expect(rows().map(row => row.dataset.id)).toEqual(all.map(entry => entry.id))
})

test('dropping a queued row onto another queued row moves it there', async () => {
  drag('dragstart', rowOf('q2'))
  const over = new window.Event('dragover', { bubbles: true, cancelable: true })
  rowOf('q1').dispatchEvent(over)
  expect(over.defaultPrevented).toBe(true)
  drag('drop', rowOf('q1'))
  await flush()
  expect(calls).toEqual([{ method: 'POST', url: '/api/queue/q2/move', body: { to: 1 } }])
})

test('a queued row cannot be dropped onto a row that is not queued', async () => {
  drag('dragstart', rowOf('q2'))
  const over = new window.Event('dragover', { bubbles: true, cancelable: true })
  rowOf('r1').dispatchEvent(over)
  expect(over.defaultPrevented).toBe(false)
  drag('drop', rowOf('r1'))
  drag('dragend', rowOf('q2'))
  await flush()
  expect(calls).toEqual([])
})

test('the screen starts from when the server last checked replies', () => {
  expect(section().querySelector('.q-checked')?.textContent).toBe('Checked 3 min ago')
})

const atOnce = (root: ParentNode) => root.querySelector<HTMLSelectElement>('select[name=parallel]')
const choose = (select: HTMLSelectElement, value: string) => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })) }

test('the At once select shows the snapshot parallel, and an older server without parallel shows none', () => {
  const view = queue.renderQueue(all, context({ parallel: 3 }))
  const select = atOnce(view)!
  expect(select.value).toBe('3')
  expect([...select.options].map(option => option.value)).toEqual(['1', '2', '3', '4'])
  expect(select.closest('label')?.textContent).toStartWith('At once')
  expect(select.closest('.studio-heading nav')).not.toBeNull()
  expect(view.querySelector('.q-bar')?.textContent).toContain('Up to 3 build at a time')
  expect(atOnce(queue.renderQueue([], context({ parallel: 1 })))?.value).toBe('1')
  const older = queue.renderQueue(all, context())
  expect(atOnce(older)).toBeNull()
  expect(older.querySelector('.q-bar')?.textContent).toContain('One builds at a time')
})

test('changing At once saves it, and a refused change says why and shows the saved value again', async () => {
  expect(atOnce(section())?.value).toBe('2')
  replies.set('PUT /api/queue/settings', () => Response.json({ parallel: 3 }))
  choose(atOnce(section())!, '3')
  await flush()
  expect(calls).toEqual([{ method: 'PUT', url: '/api/queue/settings', body: { parallel: 3 } }])
  expect(atOnce(section())?.value).toBe('3')
  expect(toasts).toEqual(['Up to 3 cards build at once'])
  replies.set('PUT /api/queue/settings', () => Response.json({ error: 'parallel must be a whole number from 1 to 4' }, { status: 400 }))
  choose(atOnce(section())!, '4')
  await flush()
  expect(toasts.at(-1)).toBe('parallel must be a whole number from 1 to 4')
  expect(atOnce(section())?.value).toBe('3')
})

test('requeue, remove and check call their routes', async () => {
  replies.set('POST /api/queue/check', () => Response.json({ checked: 3, resumed: 1 }))
  click(buttonNamed('Requeue', rowOf('f1')))
  click(menuItem('r1', 'Requeue'))
  click(menuItem('w1', 'Requeue'))
  click(menuItem('q1', 'Remove'))
  click(buttonNamed('Check replies', section()))
  await flush()
  expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['POST /api/queue/f1/requeue', 'POST /api/queue/r1/requeue', 'POST /api/queue/w1/requeue', 'DELETE /api/queue/q1', 'POST /api/queue/check'])
  expect(toasts).toContain('Checked 3, 1 resumed')
  expect(section().querySelector('.q-checked')?.textContent).toBe('Checked just now')
})

test('Stop and Remove on a building card need a second click, and the armed menu survives a repaint', async () => {
  click(menuItem('b1', 'Stop'))
  await flush()
  expect(calls).toEqual([])
  expect(menuItem('b1', 'Confirm stop').dataset.armed).toBe('true')
  send(all)
  await flush()
  click(menuItem('b1', 'Confirm stop'))
  await flush()
  expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['POST /api/queue/b1/stop'])
  expect(toasts).toContain('Stopping Moni export: filter by call result')
  expect(rowOf('b1').querySelector('.q-menu')).toBeNull()
  click(menuItem('b1', 'Remove'))
  await flush()
  expect(menuItem('b1', 'Confirm remove')).toBeDefined()
  expect(menuItem('b1', 'Stop')).toBeDefined()
  click(menuItem('b1', 'Confirm remove'))
  await flush()
  expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['POST /api/queue/b1/stop', 'DELETE /api/queue/b1'])
})

test('arming Stop then clicking Remove arms Remove instead of removing', async () => {
  click(menuItem('b1', 'Stop'))
  click(menuItem('b1', 'Remove'))
  await flush()
  expect(calls).toEqual([])
  expect(menuItem('b1', 'Stop')).toBeDefined()
  expect(menuItem('b1', 'Confirm remove')).toBeDefined()
})

test('the ⋯ button opens one menu at a time; a click outside or Escape closes it', async () => {
  const more = (id: string) => rowOf(id).querySelector<HTMLButtonElement>('.q-more')!
  click(more('r1'))
  expect(more('r1').getAttribute('aria-expanded')).toBe('true')
  expect(doc.activeElement?.textContent).toBe('Requeue')
  click(more('f1'))
  expect(section().querySelectorAll('.q-menu')).toHaveLength(1)
  expect(rowOf('f1').querySelector('.q-menu')).not.toBeNull()
  click(more('f1'))
  expect(section().querySelector('.q-menu')).toBeNull()
  click(more('f1'))
  click(rowOf('f1').querySelector('.q-main')!)
  expect(section().querySelector('.q-menu')).toBeNull()
  click(more('f1'))
  escape()
  expect(section().querySelector('.q-menu')).toBeNull()
  expect(doc.activeElement).toBe(more('f1'))
  expect(calls).toEqual([])
})

test('a failed card with a run to resume offers Resume and Start over', async () => {
  send([{ ...failed, resumeRunId: 'r-failed' }, ready])
  await flush()
  expect(buttonNamed('Requeue', rowOf('f1'))).toBeUndefined()
  click(buttonNamed('Resume', rowOf('f1')))
  click(menuItem('f1', 'Start over'))
  await flush()
  expect(calls.map(call => [`${call.method} ${call.url}`, call.body])).toEqual([['POST /api/queue/f1/requeue', {}], ['POST /api/queue/f1/requeue', { fresh: true }]])
})

test('a refused action says why', async () => {
  replies.set('POST /api/queue/f1/requeue', () => Response.json({ error: 'It is building now' }, { status: 409 }))
  replies.set('DELETE /api/queue/q1', () => Response.json({ error: 'Stop its run in Studio first' }, { status: 409 }))
  click(buttonNamed('Requeue', rowOf('f1')))
  click(menuItem('q1', 'Remove'))
  await flush()
  expect(toasts).toEqual(['It is building now', 'Stop its run in Studio first'])
})

test('Open run opens the latest run in Studio', () => {
  click(buttonNamed('Open run', rowOf('r1')))
  expect(studioRuns).toEqual([{ runId: 'r-ready' }])
})

test('Watch opens the building item\'s current run in the flow view', () => {
  const watch = buttonNamed('Watch', rowOf('b1'))
  expect(watch.classList.contains('primary')).toBe(true)
  click(watch)
  expect(watched).toEqual([{ runId: 'r-b1' }])
  expect(studioRuns).toEqual([])
})

test('Watch falls back to the last run when the current run is not known yet', () => {
  send([{ ...building, currentRunId: null, runIds: ['r-a', 'r-b'] }])
  click(buttonNamed('Watch', rowOf('b1')))
  expect(watched).toEqual([{ runId: 'r-b' }])
})

test('clicking a row with a run, or pressing Enter or Space on it, opens that run', () => {
  click(rowOf('b1').querySelector('.q-main') as Element)
  click(rowOf('r1').querySelector('.q-main') as Element)
  rowOf('f1').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  rowOf('r1').dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
  expect(watched).toEqual([{ runId: 'r-b1' }, { runId: 'r-ready' }, { runId: 'r-failed' }, { runId: 'r-ready' }])
})

test('rows with a run but no Watch button are one named tab stop; a building row leaves the keyboard to its Watch button', () => {
  expect(rowOf('r1').getAttribute('tabindex')).toBe('0')
  expect(rowOf('r1').getAttribute('aria-label')).toBe('Invoice PDF footer, Ready. Press Enter to watch its run')
  expect(rowOf('f1').getAttribute('aria-label')).toBe('Kood queue retry, Failed. Press Enter to watch its run')
  expect(rowOf('b1').getAttribute('title')).toBe('Watch this run')
  expect(rowOf('b1').hasAttribute('tabindex')).toBe(false)
  expect(rowOf('b1').hasAttribute('aria-label')).toBe(false)
  expect(buttonNamed('Watch', rowOf('b1')).getAttribute('aria-label')).toBe('Watch Moni export: filter by call result')
  expect(rowOf('q1').hasAttribute('tabindex')).toBe(false)
  click(rowOf('q1').querySelector('.q-main') as Element)
  rowOf('q1').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(watched).toEqual([])
})

test('a key pressed on a button inside a row does not also open the run', () => {
  buttonNamed('Open run', rowOf('r1')).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(watched).toEqual([])
})

test('a queued item being prepared says so, asks twice before removal, and cannot be dragged', () => {
  const preparing = { ...queuedA, preparing: true } as unknown as QueueItem
  const both = [preparing, queuedB]
  const [first, second] = rows(queue.renderQueue(queue.readQueueItems(both), context()))
  const removeIn = (id: string) => offered(both, id).row.querySelector('[data-act="remove"]')
  expect(first!.querySelector('.q-meta > span:last-child')?.textContent).toBe('Getting the workspace ready…')
  expect(removeIn('q1')?.hasAttribute('data-confirm')).toBe(true)
  expect(removeIn('q2')?.hasAttribute('data-confirm')).toBe(false)
  expect(first!.hasAttribute('data-movable')).toBe(false)
  expect(first!.getAttribute('draggable')).toBeNull()
  expect(second!.querySelector('.q-meta > span:last-child')?.textContent).toBe('Next up')
})

test('a building row shows its live step and attempt', () => {
  const step = (title: string, attempt: number, maxAttempts: number) => ({ ...building, step: { title, attempt, maxAttempts } }) as unknown as QueueItem
  const progress = (entry: QueueItem) => rows(queue.renderQueue(queue.readQueueItems([entry]), context()))[0]?.querySelector('.q-meta > span:last-child')?.textContent
  expect(progress(step('Plan', 1, 3))).toBe('Plan · attempt 1 of 3')
  expect(progress(step('Execute', 2, 4))).toBe('Execute · attempt 2 of 4')
  expect(progress(step('Review', 1, 1))).toBe('Review')
  expect(progress(building)).toBe('Building')
})

test('opening a waiting row shows its questions', () => {
  expect(rowOf('w1').querySelector('.q-thread')).toBeNull()
  click(rowOf('w1').querySelector('.q-main') as Element)
  expect(rowOf('w1').hasAttribute('data-open')).toBe(true)
  expect([...rowOf('w1').querySelectorAll('.q-bubble')].map(bubble => bubble.textContent)).toEqual(waiting.questions)
  click(rowOf('w1').querySelector('.q-main') as Element)
  expect(rowOf('w1').querySelector('.q-thread')).toBeNull()
})

test('focusing an item outlines its row', () => {
  dispatchEvent(new CustomEvent('quiet:queue-focus', { detail: 'q2' }))
  expect(rowOf('q2').hasAttribute('data-focus')).toBe(true)
})

test('parseItemRef reads ids out of links', () => {
  expect(queue.parseItemRef('https://app.clickup.com/t/86d3j4f8q')).toBe('86d3j4f8q')
  expect(queue.parseItemRef('  86d3j4f8q  ')).toBe('86d3j4f8q')
  expect(queue.parseItemRef('https://example.com/board/items/42/?view=1#top')).toBe('42')
  expect(queue.parseItemRef('https://example.com/')).toBe('')
  expect(queue.parseItemRef('')).toBe('')
})

const dialog = () => doc.querySelector('dialog.access-dialog.flat') as HTMLDialogElement
const field = <T extends HTMLElement>(name: string) => dialog().querySelector(`[name="${name}"]`) as T

test('the Add form posts the item and closes', async () => {
  click(buttonNamed('Add item', section()))
  await flush()
  expect(dialog().open).toBe(true)
  const sources = [...field<HTMLSelectElement>('source').options].map(option => option.value)
  expect(sources).toEqual(['clickup-board', 'jira-board'])
  expect([...field<HTMLSelectElement>('flow').options].map(option => option.textContent)).toEqual(['Default flow', 'Plan only', 'Default'])
  expect([...dialog().querySelectorAll('datalist option')].map(option => option.getAttribute('value'))).toEqual(['/Users/me/api', '/Users/me/web'])
  field<HTMLInputElement>('ref').value = 'https://app.clickup.com/t/86d3j4f8q'
  field<HTMLInputElement>('repo').value = '/Users/me/api'
  field<HTMLSelectElement>('flow').value = 'plan-only'
  click(buttonNamed('Next up', dialog()))
  replies.set('POST /api/queue', () => Response.json({ item: item({ id: 'n1', title: 'Products v2' }) }))
  dialog().querySelector('form.field-stack')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await flush()
  expect(calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', url: '/api/queue', body: { source: 'clickup-board', externalId: '86d3j4f8q', repo: '/Users/me/api', flowId: 'plan-only', position: 'next' } }])
  expect(dialog().open).toBe(false)
  expect(toasts).toEqual(['Added Products v2'])
})

test('the Add button says Adding… while the folder is still being checked, before anything is posted', async () => {
  click(buttonNamed('Add item', section()))
  await flush()
  field<HTMLInputElement>('ref').value = '86d3j4f8q'
  field<HTMLInputElement>('repo').value = '/Users/me/api'
  let folderAnswer: (response: Response) => void = () => {}
  replies.set(`GET /api/queue/folder?path=${encodeURIComponent('/Users/me/api')}`, () => new Promise<Response>(resolve => { folderAnswer = resolve }) as unknown as Response)
  field<HTMLInputElement>('repo').dispatchEvent(new window.Event('input', { bubbles: true }))
  field<HTMLInputElement>('repo').dispatchEvent(new window.Event('blur'))
  await flush()
  dialog().querySelector('form.field-stack')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await flush()
  const submit = dialog().querySelector<HTMLButtonElement>('form.field-stack button.primary[type="submit"]')!
  expect([submit.textContent, submit.disabled]).toEqual(['Adding…', true])
  expect(calls.filter(call => call.method === 'POST')).toEqual([])
  replies.set('POST /api/queue', () => Response.json({ error: 'Already in the queue' }, { status: 409 }))
  folderAnswer(Response.json({ path: '/Users/me/api', isRepo: true, repos: [], skipped: 0 }))
  await flush(6)
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
  expect([submit.textContent, submit.disabled]).toEqual(['Add', false])
  dialog().close()
})

test('the Add form leaves out a default flow and shows the source error inline', async () => {
  click(buttonNamed('Add item', section()))
  await flush()
  field<HTMLInputElement>('ref').value = '86d3j4f8q'
  field<HTMLInputElement>('repo').value = '/Users/me/api'
  replies.set('POST /api/queue', () => Response.json({ error: 'No method source.item' }, { status: 502 }))
  dialog().querySelector('form.field-stack')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await flush()
  expect(calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', url: '/api/queue', body: { source: 'clickup-board', externalId: '86d3j4f8q', repo: '/Users/me/api', position: 'end' } }])
  expect(dialog().open).toBe(true)
  const error = dialog().querySelector('[role="alert"]') as HTMLElement
  expect(error.hidden).toBe(false)
  expect(error.textContent).toBe('No method source.item')
  dialog().close()
})

test('the Add form refuses a link with no id before posting', async () => {
  click(buttonNamed('Add item', section()))
  await flush()
  field<HTMLInputElement>('ref').value = 'https://example.com/'
  field<HTMLInputElement>('repo').value = '/Users/me/api'
  dialog().querySelector('form.field-stack')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await flush()
  expect(calls.filter(call => call.method === 'POST')).toEqual([])
  expect((dialog().querySelector('[role="alert"]') as HTMLElement).textContent).toBe('Paste a task link or id')
  dialog().close()
})

async function addSourcesWith(pluginList: Array<Record<string, unknown>>): Promise<string[]> {
  replies.set('GET /api/plugins', () => Response.json({ plugins: pluginList }))
  dispatchEvent(new CustomEvent('quiet:screen', { detail: 'queue' }))
  await flush()
  click(buttonNamed('Add item', section()))
  await flush()
  const sources = [...field<HTMLSelectElement>('source').options].map(option => option.value)
  dialog().close()
  replies.delete('GET /api/plugins')
  dispatchEvent(new CustomEvent('quiet:screen', { detail: 'queue' }))
  await flush()
  return sources
}

test('the Add form offers only enabled queue-source plugins when any declares queueSource', async () => {
  const sources = await addSourcesWith([
    { id: 'clickup-board', name: 'ClickUp board', enabled: true, queueSource: true },
    { id: 'jira-board', name: 'Jira board', enabled: true },
    { id: 'off-board', name: 'Off board', enabled: false, queueSource: true },
  ])
  expect(sources).toEqual(['clickup-board'])
})

test('the Add form falls back to every enabled plugin when no enabled plugin declares queueSource', async () => {
  const sources = await addSourcesWith([
    { id: 'clickup-board', name: 'ClickUp board', enabled: true },
    { id: 'jira-board', name: 'Jira board', enabled: true, queueSource: false },
    { id: 'off-board', name: 'Off board', enabled: false, queueSource: true },
  ])
  expect(sources).toEqual(['clickup-board', 'jira-board'])
})

const treeCalls = () => calls.filter(call => call.url === '/api/queue/tree')
const tree = { repos: [{ repo: '/Users/me/api', base: { branch: 'main', commits: [{ sha: '4f2a9c1', subject: 'kood: timeout copy' }] }, lanes: [{ itemId: 'r1', branch: 'queue/invoice-pdf-footer', worktree: '/Users/me/api/.worktree/queue-invoice-pdf-footer', forkSha: '4f2a9c1', commits: [{ sha: '3be81f0', subject: 'fix round 1: footer' }] }] }] }

test('Git tree shows the branches, follows the stream and is remembered', async () => {
  replies.set('GET /api/queue/tree', () => Response.json(tree))
  expect(buttonNamed('List', section()).getAttribute('aria-pressed')).toBe('true')
  click(buttonNamed('Git tree', section()))
  await flush()
  expect(window.localStorage.getItem('skd.queue.layout')).toBe('tree')
  expect(buttonNamed('Git tree', section()).getAttribute('aria-pressed')).toBe('true')
  expect(section().querySelector('.q-list')).toBeNull()
  expect([...section().querySelectorAll('.q-tree-tip .q-ref')].map(ref => ref.textContent)).toEqual(['queue/invoice-pdf-footer'])
  expect(treeCalls()).toHaveLength(1)
  send(all)
  await flush()
  expect(treeCalls()).toHaveLength(2)
  click(buttonNamed('List', section()))
  await flush()
  expect(window.localStorage.getItem('skd.queue.layout')).toBe('list')
  expect(rows().map(row => row.dataset.id)).toEqual(all.map(entry => entry.id))
  send(all)
  await flush()
  expect(treeCalls()).toHaveLength(2)
})

test('a git tree that cannot load says so in place', async () => {
  replies.set('GET /api/queue/tree', () => Response.json({ error: 'Not found' }, { status: 404 }))
  click(buttonNamed('Git tree', section()))
  await flush()
  expect(section().querySelector('.q-status')?.textContent).toBe('Could not load the git tree: Not found')
  expect(section().querySelector('.q-bar')).not.toBeNull()
  click(buttonNamed('List', section()))
  await flush()
})

test('a stream update during a drag waits for the drag to end', async () => {
  const dragged = rowOf('q2')
  drag('dragstart', dragged)
  send([...all, item({ id: 'q3', title: 'New queued item' })])
  await flush()
  expect(rowOf('q2')).toBe(dragged)
  expect(rowOf('q3')).toBeUndefined()
  drag('dragend', dragged)
  expect(rowOf('q3')).toBeDefined()
})

test('a drag that ends outside the screen still lets go', async () => {
  drag('dragstart', rowOf('q2'))
  dispatchEvent(new Event('dragend'))
  const over = new window.Event('dragover', { bubbles: true, cancelable: true })
  rowOf('q1').dispatchEvent(over)
  expect(over.defaultPrevented).toBe(false)
})

const STRUCTURED = [
  '## Recommendation', 'B — Wide panel reads best.',
  '## Options', '- A | Narrow | Squeezes the table.', '- B | Wide | Full `table`.', '- C | Popup | Adds a screen.',
  '## Points', '| # | Point | File | Fix |', '| - | - | - | - |', '| 1 | Cannot type | `a.erb` | Fixed by #2. |', '| 2 | No page | `b.rb` | Decision needed: pick a page. |', '', 'Specs are listed elsewhere.',
  '## Still open', '- #7 Promo replies | default: grey verdict | other hint: drop promo pairs', '- #5 No page | default: keep blocked',
  '## Out of scope', '- AURA takes questions from one page',
  '## Facts', '- 2 points | all still present',
  '## Tag', '- Natthida | assignee', '- Kanchana | watcher',
].join('\n')
const pickItem = (summary: string) => item({ id: 'p1', state: 'waiting-pick', title: 'Login button wording', questions: ['Which tenant?'], runIds: ['r-p1'], pick: { options: ['A', 'B', 'C'], path: 'visualizer/login', recommended: 'B', tester: 'Ploy', summary } } as Partial<QueueItem>)
const picking = pickItem(STRUCTURED)
const review = () => doc.getElementById('queue-review') as HTMLElement
const shown: string[] = []
const sel = <T extends Element = HTMLElement>(css: string) => review().querySelector(css) as T
const all$ = <T extends Element = HTMLElement>(css: string) => [...review().querySelectorAll<T>(css)]
const stageFrames = () => all$<HTMLIFrameElement>('.pk-d-stage iframe')
const previewSrc = () => stageFrames().at(-1)?.getAttribute('src')
const openPick = async (target: QueueItem = picking) => {
  send([target])
  await flush()
  click(buttonNamed('Pick', rowOf('p1')))
  await flush()
}
const tab = (name: string) => buttonNamed(name, sel('.pk-d-right'))
const radio = (value: string) => all$<HTMLInputElement>('input[name=option]').find(input => input.value === value) as HTMLInputElement

test('a waiting-pick row shows the Pick a variant pill and a Pick button', () => {
  const view = queue.renderQueue([picking], context())
  expect(view.querySelector('.q-row .pill-state')?.textContent).toBe('Pick a variant')
  expect(view.querySelector('.q-meta > span:last-child')?.textContent).toBe('3 variants to choose from · 1h ago')
  expect(buttonNamed('Pick', view)).toBeDefined()
})

test('Pick opens the review screen with every section of a structured summary', async () => {
  await openPick()
  expect(shown.at(-1)).toBe('queue-review')
  expect(sel('h1').textContent).toBe('Login button wording')
  expect(all$('.pk-nav a').map(link => link.textContent)).toEqual(['1Summary', '2Points', '3Decide'])
  expect(sel('.pk-rec').textContent).toContain('Recommended: B')
  expect(sel('.pk-rec').textContent).toContain('Wide panel reads best.')
  expect(sel('.pk-stat').textContent).toBe('2 pointsall still present')
  expect(sel('#points h3').textContent).toBe('Points (2 · 1 needs a decision)')
  expect(all$('.pk-points tr[data-decision]').map(row => row.children[0]?.textContent)).toEqual(['2'])
  expect(sel('.pk-points tr[data-decision] .pill-state').textContent).toBe('Decision needed')
  expect(sel('.pk-points tr[data-decision] td:last-child').textContent).toBe('Decision needed: pick a page.')
  expect(sel('.pk-foot-note').textContent).toBe('Specs are listed elsewhere.')
  expect(all$('.pk-opt:not(.pk-none)').map(card => card.textContent)).toEqual(['ANarrowSqueezes the table.', 'BRecommendedWideFull table.', 'CPopupAdds a screen.'])
  expect(sel('.pk-opt code').textContent).toBe('table')
  expect(sel<HTMLImageElement>('.pk-opt img').getAttribute('src')).toBe('/queue/p1/files/login/renders/a.png')
  expect(all$('.pk-open legend').map(legend => legend.textContent)).toEqual(['#7 Promo replies', '#5 No page'])
  expect(all$('.pk-open .pk-radio:first-of-type').map(label => label.textContent)).toEqual(['Use default: grey verdict', 'Use default: keep blocked'])
  expect(sel('[data-defaults]').textContent).toBe('2 open choices use defaults')
  expect(sel('.pk-asked').textContent).toContain('Which tenant?')
  expect(sel('.pk-oos:not(.pk-asked)').textContent).toContain('AURA takes questions from one page')
  expect(all$('[data-tag]').map(chip => chip.textContent)).toEqual(['Natthida', 'Kanchana watcher'])
  expect(sel<HTMLInputElement>('[name="tester"]').value).toBe('Ploy')
  expect(sel('[role=radiogroup]').getAttribute('aria-label')).toBe('Design to build')
  expect(radio('B').checked).toBe(true)
  expect(all$('.pk-build').map(button => button.textContent)).toEqual(['Build with B', 'Build with B'])
  expect(previewSrc()).toBe('/queue/p1/files/login/b.html')
  expect(stageFrames()[0]?.getAttribute('sandbox')).toBe('allow-scripts')
})

test('a summary without headings falls back to markdown and has no Points section', async () => {
  await openPick(pickItem('**Three** variants\n\nSee them.'))
  expect(sel('#summary strong').textContent).toBe('Three')
  expect(review().querySelector('#points')).toBeNull()
  expect(all$('.pk-nav a').map(link => link.textContent)).toEqual(['1Summary', '2Decide'])
  expect(all$('.pk-opt:not(.pk-none)').map(card => card.querySelector('strong')?.textContent)).toEqual(['Option A', 'Option B', 'Option C'])
  expect(review().querySelector('.pk-open')).toBeNull()
})

test('summary text is never parsed as markup', async () => {
  await openPick(pickItem('## Facts\n- <img src=x onerror=alert(1)> | <b>bold</b>'))
  expect(review().querySelector('img[src=x]')).toBeNull()
  expect(sel('.pk-stat strong').textContent).toBe('<img src=x onerror=alert(1)>')
})

test('with no recommendation the first option is selected and previewed', async () => {
  await openPick({ ...picking, pick: { ...picking.pick!, recommended: null } } as QueueItem)
  expect(radio('A').checked).toBe(true)
  expect(previewSrc()).toBe('/queue/p1/files/login/a.html')
})

test('selecting an option card previews it and relabels both Build buttons', async () => {
  await openPick()
  radio('C').checked = true
  radio('C').dispatchEvent(new window.Event('change', { bubbles: true }))
  expect(previewSrc()).toBe('/queue/p1/files/login/c.html')
  expect(all$('.pk-build').map(button => button.textContent)).toEqual(['Build with C', 'Build with C'])
  expect(tab('C').getAttribute('aria-pressed')).toBe('true')
})

test('previewing another option shows the hint and keeps the selection until Select is clicked', async () => {
  await openPick()
  click(tab('C'))
  expect(previewSrc()).toBe('/queue/p1/files/login/c.html')
  expect(radio('B').checked).toBe(true)
  expect(sel('.pk-d-cap').textContent).toBe('Option C · PopupPreviewing C · selected: B — Select C')
  expect(sel('[data-hint]').hidden).toBe(false)
  click(tab('NOW'))
  expect(sel('[data-hint]').hidden).toBe(true)
  click(tab('All'))
  expect(sel('[data-cap]').textContent).toBe('All variants')
  expect(sel('[data-hint]').hidden).toBe(true)
  click(tab('A'))
  click(buttonNamed('Select A', review()))
  expect(radio('A').checked).toBe(true)
  expect(sel('[data-hint]').hidden).toBe(true)
  expect(all$('.pk-build').map(button => button.textContent)).toEqual(['Build with A', 'Build with A'])
})

test('Compare with NOW shows two iframes and goes back to one', async () => {
  await openPick()
  click(tab('C'))
  click(buttonNamed('Compare with NOW', review()))
  expect(sel('[data-cmp]').getAttribute('aria-pressed')).toBe('true')
  expect(stageFrames().map(frame => frame.getAttribute('src'))).toEqual(['/queue/p1/files/login/now.html', '/queue/p1/files/login/c.html'])
  expect(all$('.pk-d-col > strong').map(label => label.textContent)).toEqual(['NOW', 'C'])
  click(tab('NOW'))
  expect(stageFrames().map(frame => frame.getAttribute('src'))).toEqual(['/queue/p1/files/login/now.html', '/queue/p1/files/login/b.html'])
  expect(all$('.pk-d-col > strong').map(label => label.textContent)).toEqual(['NOW', 'B'])
  click(buttonNamed('Compare with NOW', review()))
  expect(sel('[data-cmp]').getAttribute('aria-pressed')).toBe('false')
  expect(stageFrames()).toHaveLength(1)
})

test('each iframe is scaled to fit the pane width from a 1256px mockup', async () => {
  const width = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'clientWidth')
  const height = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 628 })
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 500 })
  try {
    await openPick()
    const frame = stageFrames()[0] as HTMLIFrameElement
    expect(frame.style.width).toBe('1256px')
    expect(frame.style.transform).toBe('scale(0.5)')
    expect(frame.style.height).toBe('1000px')
  } finally {
    if (width) Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', width); else Reflect.deleteProperty(window.HTMLElement.prototype, 'clientWidth')
    if (height) Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', height); else Reflect.deleteProperty(window.HTMLElement.prototype, 'clientHeight')
  }
})

test('Full screen opens an unscaled modal dialog; Esc and the close button close it and return focus', async () => {
  await openPick()
  click(tab('C'))
  const opener = buttonNamed('Full screen', review())
  opener.focus()
  click(opener)
  const viewer = sel<HTMLDialogElement>('.pk-viewer')
  expect(viewer.tagName).toBe('DIALOG')
  expect(viewer.open).toBe(true)
  expect(viewer.getAttribute('aria-labelledby')).toBe(viewer.querySelector('.pk-viewer-title')?.id as string)
  expect(viewer.querySelector('.pk-viewer-title')?.textContent).toBe('Option C · Popup')
  expect(viewer.querySelector('iframe')?.getAttribute('src')).toBe('/queue/p1/files/login/c.html')
  expect(viewer.querySelector('iframe')?.getAttribute('style')).toBeNull()
  click(viewer.querySelector('[data-vtab="now"]') as HTMLElement)
  expect(viewer.querySelector('iframe')?.getAttribute('src')).toBe('/queue/p1/files/login/now.html')
  expect(doc.activeElement).toBe(viewer.querySelector('.round'))
  viewer.dispatchEvent(new window.Event('cancel', { cancelable: true }))
  expect(viewer.open).toBe(false)
  expect(doc.activeElement).toBe(opener)
  click(opener)
  click(viewer.querySelector('.round') as HTMLElement)
  expect(viewer.open).toBe(false)
  expect(doc.activeElement).toBe(opener)
})

test('leaving for another screen closes the viewer but keeps the preview observing, and Back stops it', async () => {
  const observers: Array<{ on: boolean }> = []
  class FakeObserver { on = false; observe(): void { this.on = true; observers.push(this) } disconnect(): void { this.on = false } }
  Object.assign(globalThis, { ResizeObserver: FakeObserver })
  try {
    await openPick()
    click(buttonNamed('Full screen', review()))
    expect(sel<HTMLDialogElement>('.pk-viewer').open).toBe(true)
    dispatchEvent(new CustomEvent('quiet:screen', { detail: 'history' }))
    expect(sel<HTMLDialogElement>('.pk-viewer').open).toBe(false)
    expect(observers.at(-1)?.on).toBe(true)
    click(sel('.flow-back'))
    expect(observers.at(-1)?.on).toBe(false)
  } finally {
    Reflect.deleteProperty(globalThis, 'ResizeObserver')
  }
})

test('opening focuses the heading and marks the active nav link and the preview region', async () => {
  await openPick()
  expect(doc.activeElement).toBe(sel('h1'))
  expect(sel('h1').getAttribute('tabindex')).toBe('-1')
  expect(all$('.pk-nav a[aria-current]').map(link => link.dataset.goto)).toEqual(['summary'])
  expect(sel('.pk-d-right').getAttribute('role')).toBe('region')
  expect(all$('.pk-d-right .toolbar nav').every(nav => nav.hasAttribute('aria-label'))).toBe(true)
})

test('a build still in flight does not tear down another item review that was opened meanwhile', async () => {
  const second = { ...pickItem(STRUCTURED), id: 'p2', title: 'Second item' } as QueueItem
  send([picking, second])
  await flush()
  click(buttonNamed('Pick', rowOf('p1')))
  await flush()
  let finish: (response: Response) => void = () => {}
  replies.set('POST /api/queue/p1/pick', () => new Promise<Response>(resolve => { finish = resolve }) as unknown as Response)
  click(all$('.pk-build')[0] as HTMLElement)
  await flush()
  click(sel('.flow-back'))
  expect(shown.at(-1)).toBe('queue-review')
  dispatchEvent(new CustomEvent('quiet:show', { detail: 'queue' }))
  click(buttonNamed('Pick', rowOf('p2')))
  await flush()
  finish(Response.json({ item: { id: 'p1' } }))
  await flush()
  expect(sel('h1').textContent).toBe('Second item')
  expect(shown.at(-1)).toBe('queue-review')
  expect(toasts).toEqual(['Picked B for Login button wording'])
})

test('an Other text input is only enabled while Other is chosen', async () => {
  await openPick()
  const fieldset = sel('[data-open="#7"]')
  const other = fieldset.querySelector('input[type=text]') as HTMLInputElement
  const choose = (value: string) => { const input = fieldset.querySelector(`input[value=${value}]`) as HTMLInputElement; input.checked = true; input.dispatchEvent(new window.Event('change', { bubbles: true })) }
  expect(other.disabled).toBe(true)
  expect(other.placeholder).toBe('e.g. drop promo pairs')
  choose('other')
  expect(other.disabled).toBe(false)
  expect(sel('[data-defaults]').textContent).toBe('1 open choice uses its default')
  choose('default')
  expect(other.disabled).toBe(true)
  expect(sel('[data-defaults]').textContent).toBe('2 open choices use defaults')
})

test('a tag chip fills and extends the tester field', async () => {
  await openPick()
  const tester = sel<HTMLInputElement>('[name="tester"]')
  tester.value = ''
  click(buttonNamed('Natthida', review()))
  expect(tester.value).toBe('Natthida')
  click(all$('[data-tag]')[1] as HTMLElement)
  expect(tester.value).toBe('Natthida, Kanchana')
})

test('a thumbnail that fails to load is hidden', async () => {
  await openPick()
  const thumb = sel<HTMLImageElement>('.pk-opt img')
  thumb.dispatchEvent(new window.Event('error'))
  expect(thumb.hasAttribute('data-broken')).toBe(true)
})

test('a mockup that is missing says so in the pane', async () => {
  replies.set('GET /queue/p1/files/login/b.html', () => new Response('Not found', { status: 404 }))
  await openPick()
  expect(sel('.pk-d-stage .q-status').hidden).toBe(false)
  expect(sel('.pk-d-stage .q-status').textContent).toBe("Mockup files not found in this item's workspace")
  expect(stageFrames()[0]?.hidden).toBe(true)
})

test('Build posts the option, tester, note and every Still open answer, then returns to the queue', async () => {
  await openPick()
  sel<HTMLInputElement>('[name="tester"]').value = ' Mint '
  sel<HTMLTextAreaElement>('[name="note"]').value = 'wide one'
  const fieldset = sel('[data-open="#7"]')
  const other = fieldset.querySelector('input[value=other]') as HTMLInputElement
  other.checked = true
  other.dispatchEvent(new window.Event('change', { bubbles: true }))
  ;(fieldset.querySelector('input[type=text]') as HTMLInputElement).value = ' drop promo pairs '
  const blank = sel('[data-open="#5"]').querySelector('input[value=other]') as HTMLInputElement
  blank.checked = true
  blank.dispatchEvent(new window.Event('change', { bubbles: true }))
  replies.set('POST /api/queue/p1/pick', () => Response.json({ item: { id: 'p1' } }))
  click(all$('.pk-build')[1] as HTMLElement)
  expect(all$('.pk-build').every(button => (button as HTMLButtonElement).disabled)).toBe(true)
  await flush()
  expect(calls.find(entry => entry.method === 'POST')).toMatchObject({ url: '/api/queue/p1/pick', body: { option: 'B', tester: 'Mint', note: 'wide one', answers: [{ id: '#7', label: 'Promo replies', answer: 'drop promo pairs', useDefault: false }, { id: '#5', label: 'No page', answer: '', useDefault: true }] } })
  expect(toasts).toEqual(['Picked B for Login button wording'])
  expect(shown.at(-1)).toBe('queue')
})

test('a refused pick shows the server message inline and re-enables the buttons', async () => {
  await openPick()
  replies.set('POST /api/queue/p1/pick', () => Response.json({ error: 'It is queued now' }, { status: 409 }))
  click(all$('.pk-build')[0] as HTMLElement)
  await flush()
  expect(sel('.q-add-error').textContent).toContain('It is queued now')
  expect(sel('.q-add-error').getAttribute('role')).toBe('alert')
  expect(sel('.q-add-error').hidden).toBe(false)
  expect(all$('.pk-build').some(button => (button as HTMLButtonElement).disabled)).toBe(false)
  expect(toasts).toEqual([])
  expect(shown.at(-1)).toBe('queue-review')
})

test('the back link returns to the queue', async () => {
  await openPick()
  click(sel('.flow-back'))
  expect(shown.at(-1)).toBe('queue')
})

const stagePlan = [{ id: 'uat', run: 'auto' }, { id: 'prod', run: 'button', label: 'Deploy prod' }]
const landing = item({ id: 'l1', state: 'landing', title: 'Shipping one', runIds: ['r-l1'], land: { stage: 'uat', stages: { uat: { status: 'running' } }, plan: stagePlan } } as Partial<QueueItem>)
const flight = (exitCode: number, markdown: string) => ({ stage: 'prod', stages: { uat: { status: 'ok' }, prod: { status: 'waiting', preflight: { exitCode, markdown } } }, plan: stagePlan })
const awaiting = item({ id: 'a1', state: 'awaiting-stage', title: 'Waiting one', runIds: ['r-a1'], land: flight(0, '| repo | ahead |\n|---|---|\n| api | 2 |\n\nSafety: prod') } as Partial<QueueItem>)
const blocked = item({ id: 'a2', state: 'awaiting-stage', title: 'Blocked one', runIds: ['r-a2'], land: flight(2, 'behind main') } as Partial<QueueItem>)
const landed = item({ id: 'd1', state: 'landed', title: 'Done one', runIds: ['r-d1'], land: { stage: 'prod', stages: { prod: { status: 'ok' } }, plan: stagePlan } } as Partial<QueueItem>)
const stuck = item({ id: 'x1', state: 'failed', title: 'Stuck one', runIds: ['r-x1'], error: 'uat failed (exit 3)\nline 49\nline 50', land: { stage: 'uat', stages: { uat: { status: 'failed' } }, plan: stagePlan, runId: 'r-x1' } } as Partial<QueueItem>)
const shipping = [landing, awaiting, blocked, landed, stuck]

test('land states show their pill, their one main button and the rest in the menu', () => {
  const view = queue.renderQueue(shipping, context())
  const row = (id: string) => rows(view).find(entry => entry.dataset.id === id)!
  expect(rows(view).map(entry => entry.querySelector('.pill-state')?.textContent)).toEqual(['Shipping: uat', 'Waiting for you', 'Waiting for you', 'Landed', 'Failed'])
  const shippingCard = offered(shipping, 'l1')
  expect(shippingCard).toMatchObject({ main: ['Log'], menu: ['Open run', 'Report', 'Stop', 'Remove'] })
  const note = shippingCard.row.querySelector('.q-menu-note')!
  expect(note.textContent).toBe('A push or deploy cut short can leave the remote half-updated.')
  expect(buttonNamed('Stop', shippingCard.row).getAttribute('aria-describedby')).toBe(note.id)
  expect(offered(shipping, 'a1')).toMatchObject({ main: ['Deploy prod'], menu: ['Open run', 'Report', 'Remove'] })
  expect(offered(shipping, 'd1')).toMatchObject({ main: [], menu: ['Open run', 'Report', 'Remove'] })
  expect(offered(shipping, 'x1')).toMatchObject({ main: ['Retry stage'], menu: ['Requeue', 'Open run', 'Report', 'Remove'] })
  expect(row('x1').querySelector('.q-meta')?.textContent).toContain('uat failed (exit 3)')
  expect(row('x1').querySelector('.q-land-error')?.textContent).toBe('line 49\nline 50')
})

test('a failed item rebuilt since its stage failed offers no Retry stage', () => {
  const rebuilt = item({ id: 'x2', state: 'failed', title: 'Rebuilt one', runIds: ['r-1', 'r-2'], error: 'Run failed', land: { stage: 'uat', stages: { uat: { status: 'failed' } }, plan: stagePlan, runId: 'r-1' } } as Partial<QueueItem>)
  const view = queue.renderQueue([rebuilt], context())
  expect([...rows(view)[0]!.querySelectorAll('.q-acts button')].map(button => button.textContent)).not.toContain('Retry stage')
})

test('Retry stage posts to the land retry route', async () => {
  send([stuck])
  await flush()
  click(buttonNamed('Retry stage', rowOf('x1')))
  await flush()
  expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['POST /api/queue/x1/land/retry'])
  expect(toasts).toEqual(['Retrying the stage of Stuck one'])
})

test('the stage button opens a confirm dialog with the preflight rendered; Confirm starts the stage', async () => {
  send([awaiting])
  await flush()
  click(buttonNamed('Deploy prod', rowOf('a1')))
  await flush()
  const dialog = doc.querySelector('dialog.q-land') as HTMLDialogElement
  expect(dialog.open).toBe(true)
  expect(dialog.querySelector('table')?.textContent).toContain('api')
  expect(dialog.querySelector('.q-land-md')?.textContent).toContain('Safety: prod')
  const confirm = buttonNamed('Confirm', dialog)
  expect(confirm.disabled).toBe(false)
  click(confirm)
  await flush()
  expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['POST /api/queue/a1/land/prod/start'])
  expect(calls[0]!.body).toEqual({ confirm: true })
  expect(dialog.isConnected).toBe(false)
  expect(toasts).toEqual(['Started Deploy prod'])
})

test('a blocked preflight shows its markdown, disables Confirm, and Refresh re-runs it', async () => {
  send([blocked])
  await flush()
  click(buttonNamed('Deploy prod', rowOf('a2')))
  await flush()
  const dialog = doc.querySelector('dialog.q-land') as HTMLDialogElement
  expect(dialog.querySelector('.q-land-md')?.textContent).toContain('behind main')
  expect(dialog.querySelector('.q-land-blocked')?.textContent).toContain('blocked this stage (exit 2)')
  expect(buttonNamed('Confirm', dialog).disabled).toBe(true)
  replies.set('POST /api/queue/a2/land/prod/preflight', () => Response.json({ item: { ...blocked, land: flight(0, 'now fine') } }))
  click(buttonNamed('Refresh', dialog))
  await flush()
  expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['POST /api/queue/a2/land/prod/preflight'])
  expect(dialog.querySelector('.q-land-md')?.textContent).toContain('now fine')
  expect(buttonNamed('Confirm', dialog).disabled).toBe(false)
  dialog.close()
})

test('a refused Confirm shows the reason inside the dialog and nothing closes', async () => {
  send([awaiting])
  await flush()
  click(buttonNamed('Deploy prod', rowOf('a1')))
  await flush()
  const dialog = doc.querySelector('dialog.q-land') as HTMLDialogElement
  replies.set('POST /api/queue/a1/land/prod/start', () => Response.json({ error: 'Preflight changed, review it again' }, { status: 409 }))
  click(buttonNamed('Confirm', dialog))
  await flush()
  expect(dialog.querySelector('.q-add-error')?.textContent).toBe('Preflight changed, review it again')
  expect(dialog.open).toBe(true)
  dialog.close()
})

test('Report opens the rendered report; a failure is shown in the dialog', async () => {
  replies.set('GET /api/queue/d1/report', () => new Response('# Done one\n\n## prod: ok\n', { headers: { 'content-type': 'text/markdown' } }))
  send([landed])
  await flush()
  click(menuItem('d1', 'Report'))
  await flush()
  const dialog = doc.querySelector('dialog.q-land') as HTMLDialogElement
  expect(dialog.querySelector('h1')?.textContent).toBe('Done one')
  expect(dialog.querySelector('.q-land-md h2')?.textContent).toBe('prod: ok')
  dialog.close()
  replies.set('GET /api/queue/d1/report', () => Response.json({ error: 'No queue item d1' }, { status: 404 }))
  click(menuItem('d1', 'Report'))
  await flush()
  const failed = doc.querySelector('dialog.q-land') as HTMLDialogElement
  expect(failed.querySelector('.q-add-error')?.textContent).toBe('No queue item d1')
  failed.close()
})

test('the log dialog shows the log and polls every 5 seconds only while it is open', async () => {
  const realSetInterval = globalThis.setInterval
  const ticks: Array<() => void> = []
  const cleared: unknown[] = []
  globalThis.setInterval = ((handler: () => void) => { ticks.push(handler); return ticks.length }) as unknown as typeof setInterval
  const realClear = globalThis.clearInterval
  globalThis.clearInterval = ((id: unknown) => { cleared.push(id) }) as typeof clearInterval
  try {
    let reads = 0
    replies.set('GET /api/queue/l1/land/uat/log', () => new Response(`log read ${++reads}\n`, { headers: { 'content-type': 'text/plain' } }))
    send([landing])
    await flush()
    click(buttonNamed('Log', rowOf('l1')))
    await flush()
    const dialog = doc.querySelector('dialog.q-land') as HTMLDialogElement
    expect(dialog.querySelector('.q-land-log')?.textContent).toBe('log read 1\n')
    ticks.at(-1)!()
    await flush()
    expect(dialog.querySelector('.q-land-log')?.textContent).toBe('log read 2\n')
    dialog.close()
    expect(cleared.length).toBeGreaterThan(0)
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClear
  }
})

const chooseOption = (value: string) => { const input = radio(value); input.checked = true; input.dispatchEvent(new window.Event('change', { bubbles: true })) }
const feedbackBox = () => sel<HTMLTextAreaElement>('[name="feedback"]')

test('None of these is a fourth card that shows a required feedback box and relabels both Build buttons', async () => {
  await openPick()
  expect(all$('input[name=option]').map(input => input.value)).toEqual(['A', 'B', 'C', 'none'])
  expect(sel('.pk-none').textContent).toContain('None of these')
  expect(sel('.pk-none').textContent).toContain('Ask for new designs')
  expect(sel('.pk-none img')).toBeNull()
  expect(sel('[data-feedback]').hidden).toBe(true)
  chooseOption('none')
  expect(sel('[data-feedback]').hidden).toBe(false)
  expect(sel('[data-feedback] label').textContent).toBe('What should change?')
  expect(feedbackBox().maxLength).toBe(4000)
  expect(feedbackBox().placeholder).toContain('keep B')
  expect(all$('.pk-build').map(button => button.textContent)).toEqual(['Ask for new designs', 'Ask for new designs'])
  expect(sel('[data-open-wrap]').hidden).toBe(true)
  expect(sel('[data-defaults]').hidden).toBe(true)
  expect(previewSrc()).toBe('/queue/p1/files/login/b.html')
})

test('reselecting an option restores its Build label and the Still open answers', async () => {
  await openPick()
  chooseOption('none')
  chooseOption('B')
  expect(all$('.pk-build').map(button => button.textContent)).toEqual(['Build with B', 'Build with B'])
  expect(sel('[data-open-wrap]').hidden).toBe(false)
  expect(sel('[data-defaults]').hidden).toBe(false)
  expect(sel('[data-feedback]').hidden).toBe(true)
})

test('asking for new designs with empty feedback shows an error and posts nothing', async () => {
  await openPick()
  chooseOption('none')
  feedbackBox().value = '   '
  click(all$('.pk-build')[1] as HTMLElement)
  await flush()
  expect(sel('.q-add-error').textContent).toBe('Say what should change')
  expect(sel('.q-add-error').hidden).toBe(false)
  expect(calls.some(entry => entry.method === 'POST' && entry.url.endsWith('/pick'))).toBe(false)
  expect(all$('.pk-build').some(button => (button as HTMLButtonElement).disabled)).toBe(false)
})

test('asking for new designs posts none with feedback and no answers, then returns to the queue', async () => {
  await openPick()
  sel<HTMLInputElement>('[name="tester"]').value = ' Mint '
  chooseOption('none')
  feedbackBox().value = ' keep B but drop the badge '
  replies.set('POST /api/queue/p1/pick', () => Response.json({ item: { id: 'p1' } }))
  click(all$('.pk-build')[0] as HTMLElement)
  await flush()
  const post = calls.find(entry => entry.method === 'POST')!
  expect(post.url).toBe('/api/queue/p1/pick')
  expect(post.body).toEqual({ option: 'none', feedback: 'keep B but drop the badge', tester: 'Mint', note: '' })
  expect(toasts).toEqual(['Asked for new designs for Login button wording'])
  expect(shown.at(-1)).toBe('queue')
})
