import { confirmButton } from './confirm-button'
import { reloadCurrentPluginScreen } from './plugins/plugin-screen'
import { closeChatMenu, openCurrentChatMenu, renameCurrentSession } from './sidebar'

export type ScreenAction = { label: string; icon: string; run: () => void }
export type ActionScreen = 'welcome' | 'history' | 'queue' | 'studio' | 'marketplace' | 'plugin'

const toast = (text: string): void => { dispatchEvent(new CustomEvent('quiet:toast', { detail: text })) }
const NOT_READY = 'Not ready yet'

function clickTarget(selector: string): () => void {
  return () => {
    const target = document.querySelector<HTMLElement>(selector)
    if (target) target.click()
    else toast(NOT_READY)
  }
}

export const SCREEN_ACTIONS: Record<ActionScreen, ScreenAction[]> = {
  welcome: [{ label: 'New terminal', icon: 'terminal-icon', run: clickTarget('.sb-open [data-live]') }],
  history: [{ label: 'Search history', icon: 'search-icon', run: () => { const search = document.getElementById('chat-search'); if (search) search.focus(); else toast(NOT_READY) } }],
  queue: [
    { label: 'Check replies', icon: 'mk-refresh', run: clickTarget('#queue [data-act="check"]') },
    { label: 'Add item', icon: 'plus-icon', run: clickTarget('#queue [data-act="add"]') },
  ],
  studio: [{ label: 'Core rules', icon: 'lock-icon', run: () => { dispatchEvent(new CustomEvent('quiet:studio-rules')) } }],
  marketplace: [{ label: 'Add from a link', icon: 'mk-link', run: clickTarget('#marketplace .connection-add') }],
  plugin: [{ label: 'Reload', icon: 'mk-refresh', run: () => { void reloadCurrentPluginScreen().then(ok => { if (!ok) toast(NOT_READY) }) } }],
}

const isActionScreen = (screen: string): screen is ActionScreen => screen in SCREEN_ACTIONS

let openAnchor: HTMLElement | null = null

function closeMenu(): void {
  if (openAnchor === null) return
  const anchor = openAnchor
  const focusWasInMenu = document.activeElement?.closest('.popover.row-menu') != null
  closeChatMenu()
  document.querySelectorAll('.popover.row-menu.anchored').forEach(menu => menu.remove())
  anchor.setAttribute('aria-expanded', 'false')
  openAnchor = null
  if (focusWasInMenu) anchor.focus()
}

function placeUnder(anchor: HTMLElement): (menu: HTMLElement) => void {
  return (menu) => {
    const box = anchor.getBoundingClientRect()
    menu.classList.add('anchored')
    menu.style.top = `${Math.round(box.bottom + 6)}px`
    menu.style.right = `${Math.max(8, Math.round(document.documentElement.clientWidth - box.right))}px`
    document.body.append(menu)
    anchor.setAttribute('aria-expanded', 'true')
    openAnchor = anchor
  }
}

function actionRow(label: string, icon: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'row'
  button.setAttribute('role', 'menuitem')
  button.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 20 20"><use href="#${icon}"/></svg>`)
  button.append(Object.assign(document.createElement('span'), { textContent: label }))
  button.onclick = () => { closeMenu(); run() }
  return button
}

function openMenu(anchor: HTMLElement, rows: HTMLButtonElement[]): void {
  const menu = document.createElement('div')
  menu.className = 'popover row-menu'
  menu.setAttribute('role', 'menu')
  menu.append(...rows)
  placeUnder(anchor)(menu)
  rows[0]?.focus()
}

function renameRow(): HTMLButtonElement {
  return actionRow('Rename', 'pencil-icon', () => { if (!renameCurrentSession()) toast('Open a chat or terminal first') })
}

function openScreenMenu(anchor: HTMLElement, screen: string): void {
  if (screen === 'conversation') {
    if (!openCurrentChatMenu(placeUnder(anchor))) toast('Open a chat first')
    return
  }
  if (!isActionScreen(screen)) { toast(NOT_READY); return }
  openMenu(anchor, SCREEN_ACTIONS[screen].map(action => actionRow(action.label, action.icon, action.run)))
}

function openTerminalMenu(anchor: HTMLElement): void {
  const id = anchor.closest<HTMLElement>('.term-host')?.dataset.id
  const close = actionRow('Close terminal', 'close-icon', () => {})
  close.classList.add('danger')
  close.onclick = null
  openMenu(anchor, [renameRow(), close])
  confirmButton(close, 'Close terminal', () => {
    closeMenu()
    if (id) dispatchEvent(new CustomEvent('quiet:terminal-end', { detail: id }))
    else toast(NOT_READY)
  })
}

export function initScreenActions(): void {
  const button = document.getElementById('screen-actions')
  let screen = 'welcome'
  addEventListener('quiet:screen', (event) => {
    screen = String((event as CustomEvent<string>).detail)
    if (button) button.hidden = !(screen === 'conversation' || isActionScreen(screen))
    closeMenu()
  })
  button?.addEventListener('click', (event) => {
    event.stopPropagation()
    const open = button.getAttribute('aria-expanded') === 'true'
    closeMenu()
    if (!open) openScreenMenu(button, screen)
  })
  document.getElementById('live')?.addEventListener('click', (event) => {
    const anchor = (event.target as Element).closest<HTMLElement>('[data-term-menu]')
    if (!anchor) return
    event.stopPropagation()
    const open = anchor.getAttribute('aria-expanded') === 'true'
    closeMenu()
    if (!open) openTerminalMenu(anchor)
  })
  document.addEventListener('click', (event) => {
    if (!(event.target as Element).closest('.row-menu.anchored, [data-term-menu], #screen-actions')) closeMenu()
  })
  // capture: sidebar's own Escape handler would otherwise remove the chat menu first and drop focus to <body>
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu() }, true)
}
