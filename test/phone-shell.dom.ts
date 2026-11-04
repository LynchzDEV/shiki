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
  })
  await import('../client/shell')
})

beforeEach(() => {
  phone = true
  if (!shell().classList.contains('collapsed')) key(doc.body, 'Escape')
  shell().classList.add('collapsed')
  doc.querySelector('.canvas')!.removeAttribute('inert')
})

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
