import type { AttentionItem } from '../server/attention'
import { ageText, alertFor, diffItems, QUEUE_HASH, requestFor, shouldAlert, tabTitle } from './attention-core'

const MUTE_KEY = 'skd.alerts'
const AGE_REFRESH_MS = 60_000
const ICONS: Record<AttentionItem['kind'], string> = { permission: 'code-icon', loop: 'auto-icon', needs: 'close-icon', queue: 'flow-icon' }
const OFF_TEXT = 'Get an alert with buttons when something needs you, even with this tab hidden.'
const BLOCKED_TEXT = "Allow notifications for this site in your browser's settings."

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const bell = $('open-attention')
const panel = $('attention')
const list = $('attention-list')

let items: AttentionItem[] = []
let primed = false
let ageTimer: ReturnType<typeof setInterval> | null = null
const busy = new Set<string>()
const failures = new Map<string, string>()

const permission = (): string => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
const workerReady = (): Promise<ServiceWorkerRegistration> | null => ('serviceWorker' in navigator ? navigator.serviceWorker.ready : null)

function muted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === 'off' } catch { return false }
}

function setMuted(value: boolean): void {
  try { if (value) localStorage.setItem(MUTE_KEY, 'off'); else localStorage.removeItem(MUTE_KEY) } catch {}
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = text
  return element
}

function button(label: string, act: string, className: string, key: string): HTMLButtonElement {
  const element = node('button', className, label)
  element.type = 'button'
  element.dataset.act = act
  element.disabled = busy.has(key)
  return element
}

function icon(name: string, className: string): HTMLElement {
  const holder = node('span', className)
  holder.insertAdjacentHTML('afterbegin', `<svg><use href="#${name}"/></svg>`)
  return holder
}

function actions(item: AttentionItem): HTMLElement {
  const row = node('div', 'nt-acts')
  const open = item.chatId !== null ? 'Open chat' : 'Open job'
  if (item.kind === 'permission') row.append(button('Deny', 'deny', 'text-button nt-danger', item.key), node('span', 'sp'), button('Open chat', 'open', 'text-button', item.key), button('Allow once', 'allow', 'pill nt-primary', item.key))
  else if (item.kind === 'loop') row.append(button('Stop job', 'stop', 'text-button nt-danger', item.key), node('span', 'sp'), button(open, 'open', 'pill', item.key))
  else if (item.kind === 'queue') row.append(node('span', 'sp'), button('Open queue', 'open-queue', 'pill', item.key))
  else row.append(node('span', 'sp'), button(open, 'open', 'pill', item.key))
  return row
}

function itemView(item: AttentionItem, now: number): HTMLElement {
  const card = node('article', 'nt-item')
  card.dataset.k = item.kind === 'permission' ? 'perm' : item.kind
  card.dataset.key = item.key
  const top = node('div', 'nt-top')
  top.append(node('strong', '', item.title), node('time', '', ageText(now - item.createdAt)))
  if (item.kind !== 'permission') {
    const dismiss = button('', 'dismiss', 'nt-dismiss', item.key)
    dismiss.setAttribute('aria-label', 'Dismiss')
    dismiss.insertAdjacentHTML('afterbegin', '<svg><use href="#close-icon"/></svg>')
    top.append(dismiss)
  }
  const body = node('div', 'nt-body')
  if (item.command !== null) {
    const command = node('div', 'nt-cmd')
    command.append(node('span', '', '$'), item.command)
    body.append(command)
  }
  body.append(actions(item))
  const failure = failures.get(item.key)
  if (failure !== undefined) body.append(node('p', 'nt-fail', failure))
  card.append(icon(ICONS[item.kind], 'nt-ico'), top, node('div', 'nt-what', item.detail), body)
  return card
}

function render(): void {
  const total = items.length
  const count = $('attention-count')
  count.textContent = String(total)
  count.hidden = total === 0
  for (const badge of document.querySelectorAll<HTMLElement>('[data-waiting-count]')) {
    badge.textContent = String(total)
    badge.hidden = total === 0
  }
  $('attention-n').textContent = String(total)
  $('attention-n').hidden = total === 0
  document.title = tabTitle(total)
  const now = Date.now()
  list.replaceChildren(...[...items].sort((a, b) => b.createdAt - a.createdAt).map(item => itemView(item, now)))
  list.hidden = total === 0
  $('attention-empty').hidden = total > 0
  const state = permission()
  const on = state === 'granted' && !muted()
  $('attention-off').hidden = on || state === 'unsupported'
  $('attention-off-title').textContent = state === 'denied' ? 'Mac alerts are blocked' : 'Mac alerts are off'
  $('attention-off-text').textContent = state === 'denied' ? BLOCKED_TEXT : OFF_TEXT
  $('attention-on').hidden = state === 'denied'
  $('attention-foot').hidden = !on || total === 0
}

function setOpen(open: boolean): void {
  panel.hidden = !open
  bell.setAttribute('aria-expanded', String(open))
  if (ageTimer !== null) { clearInterval(ageTimer); ageTimer = null }
  if (!open) return
  render()
  ageTimer = setInterval(render, AGE_REFRESH_MS)
}

function openTarget(target: { chatId: string | null; jobId: string | null }): void {
  setOpen(false)
  if (target.chatId !== null) dispatchEvent(new CustomEvent('quiet:open-chat', { detail: target.chatId }))
  else if (target.jobId !== null) dispatchEvent(new CustomEvent('quiet:agent-open', { detail: { jobId: target.jobId } }))
}

async function errorText(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null
  return typeof payload?.error === 'string' ? payload.error : 'try again'
}

async function act(item: AttentionItem, action: string): Promise<void> {
  if (action === 'open') { openTarget(item); return }
  if (action === 'open-queue') { showQueue(); return }
  const request = action === 'dismiss' ? { url: `/api/attention/${encodeURIComponent(item.key)}/dismiss`, body: null, verb: 'dismiss' } : requestFor(action, item)
  if (request === null) return
  busy.add(item.key)
  failures.delete(item.key)
  render()
  try {
    const response = await fetch(request.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: request.body === null ? undefined : JSON.stringify(request.body) })
    if (!response.ok && response.status !== 409) failures.set(item.key, `Couldn't ${request.verb}: ${await errorText(response)}`)
  } catch {
    failures.set(item.key, `Couldn't ${request.verb}: try again`)
  }
  busy.delete(item.key)
  render()
}

async function alert(raised: readonly AttentionItem[]): Promise<void> {
  const ready = workerReady()
  if (raised.length === 0 || ready === null) return
  if (!shouldAlert({ permission: permission(), enabled: !muted(), visible: document.visibilityState === 'visible', focused: document.hasFocus() })) return
  const registration = await ready
  for (const item of raised) {
    const { title, options } = alertFor(item)
    await registration.showNotification(title, options as NotificationOptions)
  }
}

async function closeAlerts(keys: readonly string[]): Promise<void> {
  const ready = workerReady()
  if (keys.length === 0 || ready === null) return
  const registration = await ready
  for (const tag of keys) for (const shown of await registration.getNotifications({ tag })) shown.close()
}

async function onSnapshot(next: AttentionItem[]): Promise<void> {
  const { raised, resolved } = diffItems(items, next)
  items = next
  for (const key of resolved) { busy.delete(key); failures.delete(key) }
  render()
  if (!primed) { primed = true; return }
  await closeAlerts(resolved)
  await alert(raised)
}

function showQueue(): void {
  setOpen(false)
  dispatchEvent(new CustomEvent('quiet:show', { detail: 'queue' }))
}

function openLink(link: string): void {
  const url = new URL(link, location.origin)
  if (url.hash === QUEUE_HASH) { showQueue(); return }
  openTarget({ chatId: url.searchParams.get('chat'), jobId: url.searchParams.get('job') })
}

bell.addEventListener('click', () => setOpen(panel.hidden === true))
list.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLButtonElement>('button[data-act]')
  const key = target?.closest<HTMLElement>('.nt-item')?.dataset.key
  const item = items.find(entry => entry.key === key)
  if (target && item) void act(item, target.dataset.act ?? '')
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !panel.hidden) { setOpen(false); bell.focus() }
})
document.addEventListener('click', event => {
  const path = event.composedPath()
  if (!panel.hidden && !path.includes(panel) && !path.includes(bell)) setOpen(false)
})
$('attention-on').addEventListener('click', async () => {
  if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') await Notification.requestPermission()
  setMuted(false)
  render()
})
$('attention-mute').addEventListener('click', () => { setMuted(true); render() })

const stream = new EventSource('/api/attention/stream')
stream.onmessage = event => {
  const parsed = JSON.parse(event.data) as { items?: unknown }
  void onSnapshot(Array.isArray(parsed.items) ? parsed.items as AttentionItem[] : [])
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(error => console.error('Alert worker failed to register', error))
  navigator.serviceWorker.addEventListener('message', event => {
    const data = event.data as { type?: unknown; link?: unknown } | null
    if (data?.type === 'mc:open' && typeof data.link === 'string') openLink(data.link)
  })
}

const initialJob = new URLSearchParams(location.search).get('job')
if (initialJob !== null) openTarget({ chatId: null, jobId: initialJob })
if (location.hash === QUEUE_HASH) showQueue()
