import { fold, morph, reveal } from './morph'

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const screens = ['welcome', 'history', 'conversation', 'studio', 'plugin', 'marketplace', 'queue', 'queue-review'] as const
const agents = $('agents') as HTMLDialogElement
const flow = $('flow')
const message = $('message') as HTMLTextAreaElement
const composer = $('composer') as HTMLFormElement

const STUDIO_LAYOUT = new Set<string>(['plugin', 'marketplace', 'queue', 'queue-review'])
const layoutOf = (name: (typeof screens)[number]): string => STUDIO_LAYOUT.has(name) ? 'studio' : name

function showScreen(name: (typeof screens)[number]): void {
  const changed = $(name).hidden
  if (name !== 'history') { beforeHistory = null; $('search').setAttribute('aria-pressed', 'false') }
  if (name !== 'studio' && name !== 'history') beforeStudio = null
  $('open-studio').setAttribute('aria-pressed', String(name === 'studio'))
  dispatchEvent(new Event('quiet:design'))
  dispatchEvent(new CustomEvent('quiet:screen', { detail: name }))
  for (const screen of screens) $(screen).hidden = screen !== name
  ;(document.querySelector('.canvas') as HTMLElement).dataset.screen = layoutOf(name)
  const stage = document.querySelector('.stage') as HTMLElement
  if (changed) stage.scrollTop = name === 'conversation' ? stage.scrollHeight : 0
}

function toggleFlow(open: boolean): void {
  flow.dataset.open = String(open)
  flow.inert = !open
  flow.setAttribute('aria-hidden', String(!open))
  $('toggle-flow').setAttribute('aria-expanded', String(open))
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: open }))
}

const mobileAgents = matchMedia('(max-width: 600px)')
function showAgents(): void {
  if (mobileAgents.matches) agents.showModal()
  else agents.show()
}
mobileAgents.addEventListener('change', () => {
  if (!agents.open) return
  agents.close()
  showAgents()
})
$('open-agents').onclick = () => {
  if (agents.open) agents.close()
  else showAgents()
  $('open-agents').setAttribute('aria-expanded', String(agents.open))
}
agents.addEventListener('close', () => $('open-agents').setAttribute('aria-expanded', String(agents.open)))
addEventListener('quiet:agent-open', () => {
  if (!agents.open) showAgents()
  $('open-agents').setAttribute('aria-expanded', String(agents.open))
})
agents.onkeydown = (event) => {
  if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); agents.close(); $('open-agents').focus() }
}
$('toggle-flow').onclick = () => toggleFlow(flow.dataset.open !== 'true')
$('close-flow').onclick = () => { toggleFlow(false); $('toggle-flow').focus() }





$('new-chat').onclick = () => {
  dispatchEvent(new Event('quiet:new-chat'))
  morph(composer, () => { composer.reset(); message.style.height = '' })
  showScreen('welcome')
  message.focus()
}
addEventListener('quiet:show', (event) => showScreen((event as CustomEvent<(typeof screens)[number]>).detail))

let beforeHistory: { screen: (typeof screens)[number]; live: boolean } | null = null
let beforeStudio: { screen: (typeof screens)[number]; live: boolean } | null = null
function currentView(): { screen: (typeof screens)[number]; live: boolean } {
  return { screen: screens.find(screen => !$(screen).hidden) ?? 'welcome', live: (document.querySelector('.canvas') as HTMLElement).dataset.live === 'true' }
}
function leaveTo(back: { screen: (typeof screens)[number]; live: boolean }): void {
  showScreen(back.screen)
  if (back.live) dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: { restore: true } }))
}
function enterStudio(): void {
  beforeStudio = currentView()
  showScreen('studio')
}
$('open-studio').onclick = () => {
  if (!$('studio').hidden) { const back = beforeStudio ?? { screen: 'welcome' as const, live: false }; beforeStudio = null; leaveTo(back); return }
  enterStudio()
}
addEventListener('quiet:studio-run', () => { toggleFlow(false); if ($('studio').hidden) enterStudio() })
addEventListener('quiet:flow-watch', () => toggleFlow(true))
function showHistory(): void {
  beforeHistory = currentView()
  showScreen('history')
  $('search').setAttribute('aria-pressed', 'true')
  $('chat-search').focus()
}
function leaveHistory(): void {
  const back = beforeHistory ?? { screen: 'welcome' as const, live: false }
  beforeHistory = null
  $('search').setAttribute('aria-pressed', 'false')
  leaveTo(back)
}
$('search').onclick = () => { if ($('history').hidden) showHistory(); else leaveHistory() }
$('all-history').onclick = () => { if ($('history').hidden) showHistory(); else $('chat-search').focus() }

const sidebarShell = $('sb-shell')
document.querySelectorAll<HTMLElement>('[data-sidebar-toggle]').forEach(button => {
  button.onclick = () => { sidebarShell.classList.toggle('collapsed'); dispatchEvent(new Event('quiet:sidebar-toggle')) }
})
document.querySelectorAll<HTMLElement>('[data-click]').forEach(button => {
  button.onclick = () => $(button.dataset.click ?? '').click()
})

addEventListener('quiet:history-painted', () => $('chat-search').dispatchEvent(new Event('input')))
$('chat-search').oninput = () => {
  const query = ($('chat-search') as HTMLInputElement).value.trim().toLowerCase()
  const items = [...document.querySelectorAll<HTMLElement>('#history .history-item')]
  const matches = (item: HTMLElement): boolean => (item.textContent ?? '').toLowerCase().includes(query)
  for (const item of items) {
    if (matches(item) === !item.hidden) continue
    if (matches(item)) reveal(item, true, 'top center')
    else fold(item)
  }
  $('no-results').hidden = items.some(matches)
}


;($('access-host') as HTMLInputElement).value = location.host
if (new URLSearchParams(location.search).get('screen') === 'studio') { history.replaceState(null, '', location.pathname); showScreen('studio') }

document.querySelectorAll<HTMLElement>('[data-dialog]').forEach(button => {
  button.onclick = () => ($(button.dataset.dialog ?? '') as HTMLDialogElement).showModal()
})

message.onkeydown = (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  composer.requestSubmit()
}
message.oninput = () => {
  message.style.height = ''
  message.style.height = `${Math.min(138, message.scrollHeight)}px`
}

document.querySelectorAll<HTMLElement>('[data-live]').forEach(button => {
  button.onclick = () => dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: { restore: false } }))
})

export {}
