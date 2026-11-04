import type { Terminal } from '@xterm/xterm'
import { KEY_ROW_BYTES, backToLiveText, liveJump, withCtrl, type KeyRowByte } from './terminal-state'
import { scrollTerminal } from './terminal-touch'

export const LANDSCAPE_QUERY = '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)'

export type LandscapeView = { terminal: Terminal; send(data: string): void; resize(): void }
export type Landscape = { attach(view: LandscapeView): void; typed(data: string): string; refresh(): void }

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const toast = (text: string): void => { dispatchEvent(new CustomEvent('quiet:toast', { detail: text })) }
const isByteKey = (key: string): key is KeyRowByte => key in KEY_ROW_BYTES

export function createLandscape(activeView: () => LandscapeView | null): Landscape {
  const media = matchMedia(LANDSCAPE_QUERY)
  const row = $('key-row')
  const ctrl = row.querySelector<HTMLButtonElement>('[data-key="ctrl"]') as HTMLButtonElement
  const paste = row.querySelector<HTMLButtonElement>('[data-key="paste"]') as HTMLButtonElement
  const pill = $('live-jump') as HTMLButtonElement
  const sidebarShell = $('sb-shell')
  const anchors = new WeakMap<LandscapeView, number | null>()
  let enabled = false
  let ctrlArmed = false

  paste.hidden = typeof navigator.clipboard?.readText !== 'function'

  const armCtrl = (on: boolean): void => { ctrlArmed = on; ctrl.setAttribute('aria-pressed', String(on)) }

  function paintPill(view: LandscapeView): void {
    if (view !== activeView()) return
    const anchor = anchors.get(view) ?? null
    const buffer = view.terminal.buffer.active
    pill.hidden = !enabled || anchor === null
    if (!pill.hidden) pill.textContent = backToLiveText(liveJump(buffer.viewportY, buffer.baseY, anchor).newLines)
  }

  function track(view: LandscapeView): void {
    const buffer = view.terminal.buffer.active
    anchors.set(view, liveJump(buffer.viewportY, buffer.baseY, anchors.get(view) ?? null).anchor)
    paintPill(view)
  }

  function sendKey(view: LandscapeView, data: string): void {
    view.terminal.scrollToBottom()
    view.send(data)
    armCtrl(false)
  }

  async function pasteClipboard(view: LandscapeView): Promise<void> {
    let text: string
    try { text = await navigator.clipboard.readText() } catch { toast('Allow clipboard access to paste'); return }
    if (text === '') { toast('The clipboard is empty'); return }
    view.terminal.scrollToBottom()
    armCtrl(false)
    view.terminal.paste(text)
  }

  function press(key: string): void {
    const view = activeView()
    if (!view) return
    if (isByteKey(key)) sendKey(view, KEY_ROW_BYTES[key])
    else if (key === 'ctrl') armCtrl(!ctrlArmed)
    else if (key === 'scroll-up' || key === 'scroll-down') scrollTerminal(view.terminal, key === 'scroll-up' ? 'up' : 'down', Math.max(1, Math.floor(view.terminal.rows / 2)))
    else if (key === 'paste') void pasteClipboard(view)
  }

  row.addEventListener('pointerdown', (event) => {
    const key = (event.target as Element).closest<HTMLElement>('[data-key]')?.dataset.key
    if (!key) return
    event.preventDefault()
    press(key)
  })
  row.addEventListener('click', (event) => {
    const key = (event.target as Element).closest<HTMLElement>('[data-key]')?.dataset.key
    if (key && event.detail === 0) press(key)
  })

  pill.addEventListener('click', () => { activeView()?.terminal.scrollToBottom() })

  const keyboardOpen = (): boolean => document.activeElement?.classList.contains('xterm-helper-textarea') === true
  const paintKeyboard = (): void => {
    for (const button of document.querySelectorAll('#live [data-keyboard]')) button.setAttribute('aria-pressed', String(keyboardOpen()))
  }
  document.addEventListener('focusin', paintKeyboard)
  document.addEventListener('focusout', () => requestAnimationFrame(paintKeyboard))

  const live = $('live')
  live.addEventListener('pointerdown', (event) => {
    if ((event.target as Element).closest('[data-keyboard]')) event.preventDefault()
  })
  live.addEventListener('click', (event) => {
    const target = (event.target as Element).closest<HTMLElement>('[data-click], [data-sidebar-sheet], [data-keyboard]')
    if (!target || !live.contains(target)) return
    event.stopPropagation()
    if (target.dataset.click) $(target.dataset.click).click()
    else if (target.hasAttribute('data-sidebar-sheet')) toggleSheet()
    else {
      const view = activeView()
      if (keyboardOpen()) view?.terminal.blur()
      else view?.terminal.focus()
    }
  })

  const sheetOpen = (): boolean => !sidebarShell.classList.contains('collapsed')
  const toggleSheet = (): void => { document.querySelector<HTMLElement>('[data-sidebar-toggle]')?.click() }
  const sheetMode = (): boolean => enabled && document.body.dataset.live === 'true' && sheetOpen()

  const viewport = window.visualViewport
  function fitViewport(): void {
    if (!viewport) return
    document.documentElement.style.setProperty('--vvh', `${Math.round(viewport.height)}px`)
    if (viewport.offsetTop > 0) scrollTo(0, 0)
    activeView()?.resize()
  }

  function sync(): void {
    enabled = media.matches
    armCtrl(false)
    if (enabled) {
      viewport?.addEventListener('resize', fitViewport)
      viewport?.addEventListener('scroll', fitViewport)
      if (sheetMode()) toggleSheet()
      fitViewport()
    } else {
      viewport?.removeEventListener('resize', fitViewport)
      viewport?.removeEventListener('scroll', fitViewport)
      document.documentElement.style.removeProperty('--vvh')
    }
    const view = activeView()
    if (view) paintPill(view)
    else pill.hidden = true
  }
  media.addEventListener('change', sync)
  sync()

  return {
    attach(view) {
      anchors.set(view, null)
      view.terminal.onScroll(() => track(view))
      view.terminal.onWriteParsed(() => track(view))
    },
    typed(data) {
      if (!ctrlArmed) return data
      armCtrl(false)
      return withCtrl(data) ?? data
    },
    refresh() {
      const view = activeView()
      if (view) paintPill(view)
      else pill.hidden = true
    },
  }
}
