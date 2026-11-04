import { beforeAll, beforeEach, expect, test } from 'bun:test'
import { JSDOM, VirtualConsole } from 'jsdom'

import { PHONE_TERMINAL_QUERY } from '../client/shared'
import { ShellPage } from '../server/views/shell'

const page = ShellPage({ workspaceDir: '/work' })
const body = page.slice(page.indexOf('<body>') + 6, page.indexOf('</body>'))
const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', () => {})
const { window } = new JSDOM(`<body>${body}</body>`, { url: 'http://127.0.0.1:7777/', pretendToBeVisual: true, virtualConsole })
const doc = window.document

let phone = true
const sent: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = []
const toasts: string[] = []
const flush = async (times = 4): Promise<void> => { for (let index = 0; index < times; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const chatItem = { kind: 'chat', id: 'c1', title: 'Chat one', updatedAt: Date.now(), project: null, running: false, agents: [] }
const otherChats = [{ ...chatItem, id: 'c2', title: 'Chat two', running: true }, { ...chatItem, id: 'c3', title: 'Chat three', updatedAt: Date.now() - 1000 }]
const byId = (id: string): HTMLElement => doc.getElementById(id) as HTMLElement
const shell = (): HTMLElement => byId('sb-shell')
const pointerdown = (target: Element): void => { target.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })) }
const key = (target: Element, name: string): KeyboardEvent => {
  const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}
const openDrawer = (): void => { if (shell().classList.contains('collapsed')) byId('phone-sessions').click() }

beforeAll(async () => {
  Object.assign(globalThis, {
    window, document: doc, Element: window.Element, HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event, CustomEvent: window.CustomEvent,
    localStorage: window.localStorage, location: window.location, history: window.history, getComputedStyle: window.getComputedStyle,
    matchMedia: (query: string) => ({ get matches() { return phone && query === PHONE_TERMINAL_QUERY }, media: query, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (run: () => void) => setTimeout(run, 0),
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
    EventSource: class { onmessage = null; onerror = null; close(): void {} },
    CSS: { escape: (value: string) => value },
  })
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null })
    if (String(url) === '/api/history') return Response.json({ items: [chatItem, ...otherChats] })
    return Response.json({})
  }) as typeof fetch
  addEventListener('quiet:toast', (event) => toasts.push(String((event as CustomEvent).detail)))
  await import('../client/shell')
  await flush()
})

beforeEach(() => {
  phone = true
  if (!shell().classList.contains('collapsed')) key(doc.body, 'Escape')
  shell().classList.add('collapsed')
  doc.querySelector('.canvas')!.removeAttribute('inert')
  toasts.length = 0
  sent.length = 0
  doc.body.dataset.live = 'false'
})

const showScreen = (name: string): void => { dispatchEvent(new window.CustomEvent('quiet:show', { detail: name })) }
const openActions = (): HTMLElement[] => {
  byId('screen-actions').click()
  return [...doc.querySelectorAll<HTMLElement>('.popover.row-menu.anchored .row')]
}
const labels = (rows: HTMLElement[]): string[] => rows.map(row => row.textContent ?? '')
const rowNamed = (rows: HTMLElement[], label: string): HTMLElement => rows.find(row => row.textContent === label)!

test('Sessions opens the drawer and says so', () => {
  byId('phone-sessions').click()
  expect(shell().classList.contains('collapsed')).toBe(false)
  expect(byId('phone-sessions').getAttribute('aria-expanded')).toBe('true')
})

const canvasInert = (): boolean => doc.querySelector('.canvas')!.hasAttribute('inert')

test('opening the phone drawer moves focus into it and shuts off the page behind; closing hands focus back', () => {
  byId('phone-sessions').focus()
  byId('phone-sessions').click()
  expect(canvasInert()).toBe(true)
  expect(doc.activeElement).toBe(doc.querySelector('.sb-destinations [data-proxy="open-attention"]'))
  key(doc.activeElement!, 'Escape')
  expect(shell().classList.contains('collapsed')).toBe(true)
  expect(canvasInert()).toBe(false)
  expect(doc.activeElement).toBe(byId('phone-sessions'))
})

test('a destination row reopens the page behind before it runs, so the page is usable again', () => {
  let inertWhenClicked: boolean | null = null
  const watch = () => { inertWhenClicked = canvasInert() }
  byId('open-agents').addEventListener('click', watch)
  openDrawer()
  doc.querySelector<HTMLElement>('.sb-destinations [data-proxy="open-agents"]')!.click()
  byId('open-agents').removeEventListener('click', watch)
  expect(inertWhenClicked).toBe(false)
  expect(canvasInert()).toBe(false)
})

test('on desktop opening the sidebar neither moves focus nor shuts off the page', () => {
  phone = false
  byId('message').focus()
  doc.querySelector<HTMLElement>('.sb-strip [data-sidebar-toggle]')!.click()
  expect(shell().classList.contains('collapsed')).toBe(false)
  expect(canvasInert()).toBe(false)
  expect(doc.activeElement).toBe(byId('message'))
  shell().classList.add('collapsed')
})

test('a ⋯ menu puts focus on its first row, and Escape closes it and returns focus to the ⋯ button', () => {
  showScreen('queue')
  byId('queue').innerHTML = '<button type="button" data-act="check">Check replies</button>'
  const rows = openActions()
  expect(doc.activeElement).toBe(rows[0])
  key(rows[0], 'Escape')
  expect(doc.querySelector('.popover.row-menu.anchored')).toBeNull()
  expect(doc.activeElement).toBe(byId('screen-actions'))
  expect(byId('screen-actions').getAttribute('aria-expanded')).toBe('false')
})

test('a tap outside a ⋯ menu closes it without pulling focus back from where the tap landed', () => {
  showScreen('queue')
  openActions()
  byId('message').focus()
  byId('message').click()
  expect(doc.querySelector('.popover.row-menu.anchored')).toBeNull()
  expect(doc.activeElement).toBe(byId('message'))
})

test('the drawer lists Waiting, Queue, Flow, Agents and Studio in that order', () => {
  const rows = [...doc.querySelectorAll<HTMLElement>('.sb-destinations button')].map(row => row.dataset.proxy ?? `show:${row.dataset.show}`)
  expect(rows).toEqual(['open-attention', 'show:queue', 'toggle-flow', 'open-agents', 'open-studio'])
})

test('a destination row clicks its toolbar button and closes the drawer', () => {
  const clicked: string[] = []
  for (const id of ['open-attention', 'toggle-flow', 'open-agents', 'open-studio']) byId(id).addEventListener('click', () => clicked.push(id))
  for (const id of ['open-attention', 'toggle-flow', 'open-agents', 'open-studio']) {
    openDrawer()
    doc.querySelector<HTMLElement>(`.sb-destinations [data-proxy="${id}"]`)!.click()
    expect(shell().classList.contains('collapsed')).toBe(true)
  }
  expect(clicked).toEqual(['open-attention', 'toggle-flow', 'open-agents', 'open-studio'])
  expect(byId('phone-sessions').getAttribute('aria-expanded')).toBe('false')
})

test('the Queue row shows the Queue screen even when the queue is empty', () => {
  openDrawer()
  doc.querySelector<HTMLElement>('.sb-destinations [data-show="queue"]')!.click()
  expect(byId('queue').hidden).toBe(false)
  expect(shell().classList.contains('collapsed')).toBe(true)
})

test('Escape and a tap on the scrim close the drawer; a tap inside it does not', () => {
  openDrawer()
  pointerdown(byId('sidebar-list'))
  expect(shell().classList.contains('collapsed')).toBe(false)
  key(doc.body, 'Escape')
  expect(shell().classList.contains('collapsed')).toBe(true)
  openDrawer()
  pointerdown(shell())
  expect(shell().classList.contains('collapsed')).toBe(true)
})

test('on desktop an outside tap leaves the sidebar open', () => {
  phone = false
  shell().classList.remove('collapsed')
  pointerdown(byId('message'))
  key(doc.body, 'Escape')
  expect(shell().classList.contains('collapsed')).toBe(false)
})

test('on a phone Enter in the message box adds a line; the Send button sends', () => {
  const form = byId('composer') as HTMLFormElement
  let submits = 0
  form.requestSubmit = () => { submits += 1 }
  const enter = key(byId('message'), 'Enter')
  expect(enter.defaultPrevented).toBe(false)
  expect(submits).toBe(0)
})

test('on desktop Enter in the message box still sends', () => {
  phone = false
  const form = byId('composer') as HTMLFormElement
  let submits = 0
  form.requestSubmit = () => { submits += 1 }
  const enter = key(byId('message'), 'Enter')
  expect(enter.defaultPrevented).toBe(true)
  expect(submits).toBe(1)
})

test('the ⋯ on each screen lists its actions, and each action reaches the existing control', async () => {
  const clicks: string[] = []
  const spy = (element: Element | null, name: string): void => { element?.addEventListener('click', () => clicks.push(name)) }
  spy(doc.querySelector('.sb-open [data-live]'), 'new terminal')
  byId('queue').innerHTML = '<button type="button" data-act="check">Check replies</button><button type="button" data-act="add">Add item</button>'
  byId('marketplace').innerHTML = '<button type="button" class="connection-add">Add from a link</button>'
  spy(byId('queue').querySelector('[data-act="check"]'), 'check')
  spy(byId('queue').querySelector('[data-act="add"]'), 'add')
  spy(byId('marketplace').querySelector('.connection-add'), 'add link')
  let rulesAsked = 0
  addEventListener('quiet:studio-rules', () => { rulesAsked += 1 })
  const expected: Array<[string, string[]]> = [
    ['welcome', ['New terminal']],
    ['history', ['Search history']],
    ['queue', ['Check replies', 'Add item']],
    ['studio', ['Core rules']],
    ['marketplace', ['Add from a link']],
    ['plugin', ['Reload']],
  ]
  for (const [screen, names] of expected) {
    showScreen(screen)
    expect(byId('screen-actions').hidden).toBe(false)
    expect(labels(openActions())).toEqual(names)
    key(doc.body, 'Escape')
    for (const name of names) {
      const row = rowNamed(openActions(), name)
      row.click()
      expect(doc.querySelector('.popover.row-menu.anchored')).toBeNull()
      if (name === 'Search history') expect(doc.activeElement).toBe(byId('chat-search'))
    }
  }
  await flush()
  expect(clicks).toEqual(['new terminal', 'check', 'add', 'add link'])
  expect(rulesAsked).toBe(1)
  expect(toasts).toEqual(['Not ready yet'])
})

test('a ⋯ action whose control has not rendered yet says so instead of doing nothing', () => {
  byId('queue').innerHTML = ''
  showScreen('queue')
  rowNamed(openActions(), 'Check replies').click()
  expect(toasts).toEqual(['Not ready yet'])
})

test('⋯ on a saved chat opens the chat menu, and Rename edits the title in the drawer and closes it after', async () => {
  dispatchEvent(new window.CustomEvent('quiet:chat-open', { detail: 'c1' }))
  await flush()
  showScreen('conversation')
  expect(labels(openActions())).toEqual(['RenameF2', 'Pin to top', 'Export as Markdown', 'Delete chat'])
  rowNamed([...doc.querySelectorAll<HTMLElement>('.popover.row-menu .row')], 'RenameF2').click()
  expect(shell().classList.contains('collapsed')).toBe(false)
  const field = doc.querySelector<HTMLInputElement>('.sb-rename')!
  expect(doc.activeElement).toBe(field)
  field.value = 'New name'
  key(field, 'Enter')
  await flush()
  expect(sent.find(request => request.method === 'PATCH')).toMatchObject({ url: '/api/jobs/c1', body: { label: 'New name', titleLocked: true } })
  expect(shell().classList.contains('collapsed')).toBe(true)
})

test('Escape from the saved-chat ⋯ menu closes it and returns focus to the ⋯ button', async () => {
  dispatchEvent(new window.CustomEvent('quiet:chat-open', { detail: 'c1' }))
  await flush()
  showScreen('conversation')
  openActions()
  const first = doc.querySelector<HTMLElement>('.popover.row-menu .row')!
  expect(doc.activeElement).toBe(first)
  key(first, 'Escape')
  expect(doc.querySelector('.popover.row-menu')).toBeNull()
  expect(doc.activeElement).toBe(byId('screen-actions'))
  expect(byId('screen-actions').getAttribute('aria-expanded')).toBe('false')
})

test('⋯ on the conversation screen with no saved chat says so', async () => {
  dispatchEvent(new window.Event('quiet:new-chat'))
  showScreen('conversation')
  expect(openActions()).toEqual([])
  expect(toasts).toEqual(['Open a chat first'])
})

test('the terminal bar ⋯ renames the terminal through the drawer and closes it after a second tap', async () => {
  history.replaceState(null, '', '/?terminal=t1#terminal')
  doc.body.dataset.live = 'true'
  dispatchEvent(new window.CustomEvent('quiet:terminals', { detail: [{ id: 't1', engine: 'claude', cwd: '/work', title: 'Shell' }] }))
  byId('live-stage').innerHTML = '<div class="term-host" data-id="t1"><button type="button" data-term-menu aria-expanded="false"></button></div>'
  const renamed: unknown[] = []
  const ended: unknown[] = []
  addEventListener('quiet:terminal-rename', (event) => renamed.push((event as CustomEvent).detail))
  addEventListener('quiet:terminal-end', (event) => ended.push((event as CustomEvent).detail))
  const menuButton = doc.querySelector<HTMLElement>('[data-term-menu]')!
  menuButton.click()
  const rows = [...doc.querySelectorAll<HTMLElement>('.popover.row-menu.anchored .row')]
  expect(labels(rows)).toEqual(['Rename', 'Close terminal'])
  rowNamed(rows, 'Rename').click()
  expect(shell().classList.contains('collapsed')).toBe(false)
  const field = doc.querySelector<HTMLInputElement>('.sb-rename')!
  field.value = 'Build box'
  key(field, 'Enter')
  expect(renamed).toEqual([{ id: 't1', title: 'Build box' }])
  expect(shell().classList.contains('collapsed')).toBe(true)
  menuButton.click()
  const close = rowNamed([...doc.querySelectorAll<HTMLElement>('.popover.row-menu.anchored .row')], 'Close terminal')
  close.click()
  expect(ended).toEqual([])
  close.click()
  expect(ended).toEqual(['t1'])
})
