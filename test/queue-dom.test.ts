import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

import type { QueueItem } from '../server/queue-store'

const { window } = new JSDOM('<body><main><section id="queue" class="studio" aria-label="Queue"></section></main></body>', { url: 'http://127.0.0.1:7777/' })
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
const drag = (type: string, element: Element) => element.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }))

beforeAll(async () => {
  const dialogProto = window.HTMLDialogElement.prototype as unknown as Record<string, unknown>
  dialogProto.showModal = function (this: HTMLDialogElement): void { this.open = true }
  dialogProto.close = function (this: HTMLDialogElement): void { if (!this.open) return; this.open = false; this.dispatchEvent(new window.Event('close')) }
  Object.assign(globalThis, { window, document: doc, EventSource: FakeSource, localStorage: window.localStorage, Element: window.Element, HTMLElement: window.HTMLElement, location: window.location })
  window.localStorage.setItem('skd.term.recentCwd', JSON.stringify(['/Users/me/api', '/Users/me/web']))
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url: String(url), body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null }
    calls.push(call)
    const reply = replies.get(`${call.method} ${call.url}`)
    if (reply) return reply()
    if (call.url === '/api/queue') return Response.json({ items: [queuedA, queuedB], checkedAt: NOW - 3 * 60_000 })
    if (call.url === '/api/plugins') return Response.json({ plugins })
    if (call.url === '/api/studio/workflows') return Response.json({ workflows: flows, selected: flows[1] })
    return Response.json({ ok: true })
  }) as typeof fetch
  addEventListener('quiet:toast', (event) => toasts.push(String((event as CustomEvent).detail)))
  addEventListener('quiet:studio-run', (event) => studioRuns.push((event as CustomEvent).detail))
  addEventListener('quiet:flow-watch', (event) => watched.push((event as CustomEvent).detail))
  queue = await import('../client/queue')
  await flush()
  firstIds = rows().map(row => row.dataset.id ?? '')
  firstCalls = calls.map(entry => `${entry.method} ${entry.url}`)
})

beforeEach(async () => {
  send(all)
  await flush()
  calls.length = 0
  toasts.length = 0
  studioRuns.length = 0
  watched.length = 0
  replies.clear()
})

afterAll(() => {
  section().remove()
  globalThis.fetch = realFetch
  for (const key of ['window', 'document', 'EventSource', 'localStorage', 'Element', 'HTMLElement', 'location']) Reflect.deleteProperty(globalThis, key)
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

test('each state offers its own actions', () => {
  const view = queue.renderQueue(all, context())
  const actions = (id: string) => [...(rows(view).find(row => row.dataset.id === id)?.querySelectorAll('.q-acts button') ?? [])].map(button => button.textContent)
  expect(actions('b1')).toEqual(['Watch'])
  expect(actions('q1')).toEqual(['Remove'])
  expect(actions('w1')).toEqual(['Requeue'])
  expect(actions('r1')).toEqual(['Requeue', 'Open run'])
  expect(actions('f1')).toEqual(['Requeue', 'Open run'])
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

test('requeue, remove and check call their routes', async () => {
  replies.set('POST /api/queue/check', () => Response.json({ checked: 3, resumed: 1 }))
  click(buttonNamed('Requeue', rowOf('f1')))
  click(buttonNamed('Requeue', rowOf('r1')))
  click(buttonNamed('Requeue', rowOf('w1')))
  click(buttonNamed('Remove', rowOf('q1')))
  click(buttonNamed('Check replies', section()))
  await flush()
  expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['POST /api/queue/f1/requeue', 'POST /api/queue/r1/requeue', 'POST /api/queue/w1/requeue', 'DELETE /api/queue/q1', 'POST /api/queue/check'])
  expect(toasts).toContain('Checked 3, 1 resumed')
  expect(section().querySelector('.q-checked')?.textContent).toBe('Checked just now')
})

test('a refused action says why', async () => {
  replies.set('POST /api/queue/f1/requeue', () => Response.json({ error: 'It is building now' }, { status: 409 }))
  replies.set('DELETE /api/queue/q1', () => Response.json({ error: 'Stop its run in Studio first' }, { status: 409 }))
  click(buttonNamed('Requeue', rowOf('f1')))
  click(buttonNamed('Remove', rowOf('q1')))
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
  buttonNamed('Requeue', rowOf('r1')).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(watched).toEqual([])
})

test('a queued item being prepared says so and cannot be removed or dragged', () => {
  const preparing = { ...queuedA, preparing: true } as unknown as QueueItem
  const view = queue.renderQueue(queue.readQueueItems([preparing, queuedB]), context())
  const [first, second] = rows(view)
  expect(first!.querySelector('.q-meta > span:last-child')?.textContent).toBe('Getting the workspace ready…')
  expect(first!.querySelector('.q-remove')).toBeNull()
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

const picking = item({ id: 'p1', state: 'waiting-pick', title: 'Login button wording', questions: ['Which tenant?'], runIds: ['r-p1'], pick: { options: ['A', 'B', 'C'], path: 'visualizer/login', recommended: 'B', tester: 'Ploy', summary: '**Three** variants' } } as Partial<QueueItem>)
const pickDialog = () => doc.querySelector('dialog.q-pick-dialog') as HTMLDialogElement
const openPick = async (reply: () => Response = () => new Response('<h1>x</h1>')) => {
  replies.set('GET /queue/p1/files/login/index.html', reply)
  send([picking])
  await flush()
  click(buttonNamed('Pick', rowOf('p1')))
  await flush()
}

test('a waiting-pick row shows the Pick a variant pill and a Pick button', () => {
  const view = queue.renderQueue([picking], context())
  expect(view.querySelector('.q-row .pill-state')?.textContent).toBe('Pick a variant')
  expect(view.querySelector('.q-meta > span:last-child')?.textContent).toBe('3 variants to choose from · 1h ago')
  expect(buttonNamed('Pick', view)).toBeDefined()
})

test('Pick opens the mockup in a sandboxed frame, the summary, the questions and one button per option', async () => {
  await openPick()
  const frame = pickDialog().querySelector('iframe') as HTMLIFrameElement
  expect(pickDialog().open).toBe(true)
  expect(frame.getAttribute('src')).toBe('/queue/p1/files/login/index.html')
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(pickDialog().querySelector('.q-pick-summary strong')?.textContent).toBe('Three')
  expect(pickDialog().querySelector('.q-pick-asked')?.textContent).toContain('Which tenant?')
  expect([...pickDialog().querySelectorAll('.q-pick-options button')].map(button => button.textContent)).toEqual(['A', 'B (recommended)', 'C'])
  expect(pickDialog().querySelector('.q-pick-options .primary')?.textContent).toBe('B (recommended)')
  expect((pickDialog().querySelector('[name="tester"]') as HTMLInputElement).value).toBe('Ploy')
})

test('a mockup that is missing says so instead of showing an empty frame', async () => {
  await openPick(() => new Response('Not found', { status: 404 }))
  expect(pickDialog().querySelector('iframe')).toBeNull()
  expect(pickDialog().querySelector('.q-pick-stage')?.textContent).toBe("Mockup files not found in this item's workspace")
})

test('choosing an option posts it with the tester and note, then closes with a toast', async () => {
  await openPick()
  ;(pickDialog().querySelector('[name="tester"]') as HTMLInputElement).value = ' Mint '
  ;(pickDialog().querySelector('[name="note"]') as HTMLTextAreaElement).value = 'wide one'
  replies.set('POST /api/queue/p1/pick', () => Response.json({ item: { id: 'p1' } }))
  click(buttonNamed('B (recommended)', pickDialog()))
  await flush()
  expect(calls.find(entry => entry.method === 'POST')).toMatchObject({ url: '/api/queue/p1/pick', body: { option: 'B', tester: 'Mint', note: 'wide one' } })
  expect(pickDialog().open).toBe(false)
  expect(toasts).toEqual(['Picked B for Login button wording'])
})

test('a refused pick shows the server message inline and keeps the dialog open', async () => {
  await openPick()
  replies.set('POST /api/queue/p1/pick', () => Response.json({ error: 'It is queued now' }, { status: 409 }))
  click(buttonNamed('A', pickDialog()))
  await flush()
  expect(pickDialog().open).toBe(true)
  expect(pickDialog().querySelector('.q-add-error')?.textContent).toContain('It is queued now')
  expect(buttonNamed('A', pickDialog()).hasAttribute('disabled')).toBe(false)
  expect(toasts).toEqual([])
})
