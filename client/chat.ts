import { renderMarkdown } from './markdown'
import { MORPH_EASE, MORPH_MS, blendColor, morph, reveal, rollText } from './morph'
import { copyButton, enterIntent, errorText, getJson, postJson, readArray } from './shared'
import { launchChoice, type LaunchProvider } from './shell-launch'
import { createOutcomeStrip } from './outcome-strip'
import { chatModeChoice, chatModeKey, chatSignal, costText, filterSlashCommands, historyAction, historyDay, historyLabel, historyOpen, mentionMarks, mentionToken, parseAgentReport, runningLabel, slashQuery, teamRows, titleFrom, turnsFrom, workedLine, type AgentJob, type ChatCommand, type HistoryItem, type PermissionView, type TeamRow, type ThreadMessage, type Turn, type TurnJob } from './chat-view'
import { ansiHtml, capOutput, type ToolCard, type ToolCardKind } from './tool-cards'
import { collectRowStates, rowScrollOf, setRowScroll, trackRowScroll, type RowState } from './tool-row-scroll'
import { createLiveFeed, steadyLiveText, type LiveFeed } from './live-text'
import { isBadApple, playBadApple } from './badapple'

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const RUNNING_POLL_MS = 700
const STEP_FADE_MS = 300
const IDLE_POLL_MS = 5000
const TICK_MS = 1000
const ENGINE_COLORS: Record<string, string> = { claude: '#d4a091', glm: '#91b0dc', codex: '#bfd38b' }
const composer = $('composer') as HTMLFormElement
const message = $('message') as HTMLTextAreaElement
const send = composer.querySelector('.send') as HTMLButtonElement
const messages = $('messages')
const easterEgg = Object.assign(document.createElement('div'), { className: 'chat' })
messages.after(easterEgg)
const stage = document.querySelector('.stage') as HTMLElement
const outcomes = createOutcomeStrip()
composer.before(outcomes.element)
const stored = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }
const keep = (key: string, value: string): void => { try { localStorage.setItem(key, value) } catch {} }

let root: string | null = null
let easterEggRun: AbortController | null = null
let rootCwd: string | null = null
let running = false
let pollTimer = 0
let tickTimer = 0
let generation = 0
let providers: LaunchProvider[] = []
let wasRunning = false
let agents: AgentJob[] = []
let shownTurns: Turn[] = []

function show(screen: 'welcome' | 'conversation' | 'history'): void {
  dispatchEvent(new CustomEvent('quiet:show', { detail: screen }))
}

function setUrl(chat: string | null): void {
  const url = new URL(location.href)
  if (chat) url.searchParams.set('chat', chat); else url.searchParams.delete('chat')
  url.hash = ''
  history.replaceState(null, '', url)
}

function setRunning(on: boolean): void {
  running = on
  send.classList.toggle('stop', on)
  send.setAttribute('aria-label', on ? 'Stop reply' : 'Send message')
  send.title = on ? 'Stop reply' : 'Send message'
  if (on) send.dataset.mode = 'stop'
  else delete send.dataset.mode
  send.querySelector('use')?.setAttribute('href', on ? '#stop-icon' : '#arrow-icon')
}

async function stopReply(): Promise<void> {
  const runningTurn = [...shownTurns].reverse().find(turn => turn.running)
  if (runningTurn === undefined) return
  const result = await postJson(`/api/jobs/${encodeURIComponent(runningTurn.id)}/kill`, {})
  if (!result.ok) { chatError(`Could not stop the reply: ${errorText(result)}`); return }
  await refresh()
}

type QueuedItem = { id: string; text: string; queuedAt: number }
const queued = $('queued')
function paintQueue(items: QueuedItem[]): void {
  const signature = items.map(item => item.id).join()
  if (queued.dataset.sig === signature) return
  queued.dataset.sig = signature
  queued.replaceChildren(...items.map(item => {
    const row = document.createElement('div'); row.className = 'msg user queued-row'
    const bubble = document.createElement('div'); bubble.className = 'user-message'; bubble.textContent = item.text
    const meta = document.createElement('small'); meta.className = 'queued-meta'; meta.textContent = 'Queued · sends when the reply finishes'
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'round queued-x'; cancel.setAttribute('aria-label', 'Remove this queued message'); cancel.insertAdjacentHTML('afterbegin', '<svg><use href="#close-icon"/></svg>')
    cancel.onclick = async () => { if (!root) return; await fetch(`/api/jobs/${encodeURIComponent(root)}/queue/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); void refresh() }
    const column = document.createElement('div'); column.className = 'queued-column'; column.append(bubble, meta)
    row.append(column, cancel)
    return row
  }))
}

function chatError(text: string): void {
  const last = messages.lastElementChild
  if (last instanceof HTMLElement && last.className === 'chat-error') { last.textContent = text; return }
  const line = document.createElement('p')
  line.className = 'chat-error'
  line.textContent = text
  messages.append(line)
}
function clearChatError(): void { messages.querySelectorAll('.chat-error').forEach(node => node.remove()) }

function engineName(engine: string): string {
  return providers.find(item => item.id === engine)?.name ?? engine
}

function elapsed(row: TeamRow, now: number): string {
  const seconds = Math.max(0, Math.round(((row.ended ?? now) - row.started) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`
}

function stateText(row: TeamRow, now: number): string {
  if (row.state === 'running') return `Running · ${elapsed(row, now)}`
  if (row.state === 'reviewing') return 'In review'
  if (row.state === 'landed') return 'Landed'
  if (row.state === 'needs-you') return 'Needs you'
  if (row.state === 'retried') return 'Retried'
  if (row.state === 'stopped') return 'Stopped'
  return 'Done'
}

function teamCard(rows: TeamRow[], project: string | null): HTMLElement {
  const card = ($('team-card') as HTMLTemplateElement).content.firstElementChild!.cloneNode(true) as HTMLElement
  const now = Date.now()
  card.querySelector('header .muted')!.textContent = `${rows.length} agent${rows.length === 1 ? '' : 's'}${project ? ` · ${project.split('/').pop()}` : ''}`
  const list = card.querySelector('ol')!
  for (const row of rows) {
    const item = document.createElement('li')
    item.dataset.engine = row.engine
    item.dataset.state = row.state
    item.style.setProperty('--engine', ENGINE_COLORS[row.engine] ?? '#b5a5d8')
    const disc = document.createElement('span'); disc.className = 'engine-disc'
    const logo = document.createElement('img'); logo.src = `/providers/${row.engine}.svg`; logo.alt = engineName(row.engine)
    disc.append(logo)
    const body = document.createElement('div')
    const title = document.createElement('strong'); title.textContent = row.label
    const meta = document.createElement('small'); meta.textContent = `${engineName(row.engine)} · ${row.model ?? 'default'}${row.reason ? ` — ${row.reason}` : ''}`
    body.append(title, meta)
    if (row.activity) { const latest = document.createElement('p'); latest.className = 'latest'; latest.insertAdjacentHTML('afterbegin', '<span class="pulse"></span>'); latest.append(row.activity); body.append(latest) }
    const state = document.createElement('span'); state.className = 'state'; state.textContent = stateText(row, now)
    item.append(disc, body, state)
    list.append(item)
  }
  const progress = card.querySelector('.team-progress') as HTMLElement
  if (rows.some(row => row.state === 'running' || row.state === 'reviewing')) {
    reveal(progress, true, 'left center')
    const settled = rows.filter(row => row.state === 'done' || row.state === 'landed').length
    ;(progress.firstElementChild as HTMLElement).style.width = `${Math.round((settled / rows.length) * 100)}%`
  }
  ;(card.querySelector('[data-open-agents]') as HTMLButtonElement).onclick = () => {
    dispatchEvent(new CustomEvent('quiet:chat-agents', { detail: root }))
    $('open-agents').click()
  }
  return card
}

type VersionEntry = { index: number; count: number; ids: string[]; leaf: string }
type BranchPoint = { turnId: string; label: string; mainLeaf: string }
let threadVersions: Record<string, VersionEntry> = {}
let branchPoints: BranchPoint[] = []
let pendingFrom: { turnId: string; mode: 'replace' | 'after' } | null = null

const leafKey = (): string | null => (root === null ? null : `skd.chat.leaf.${root}`)

function storeLeaf(leaf: string): void {
  const key = leafKey()
  if (key === null) return
  try { localStorage.setItem(key, leaf) } catch {}
}

function setLeaf(leaf: string): void {
  storeLeaf(leaf)
  void refresh()
}

function userActionButton(iconId: string, title: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'u-act'
  button.title = title
  button.setAttribute('aria-label', title)
  button.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 20 20"><use href="#${iconId}"/></svg>`)
  button.onclick = action
  return button
}

function startEdit(turn: Turn): void {
  message.value = turn.prompt
  message.dispatchEvent(new Event('input', { bubbles: true }))
  pendingFrom = { turnId: turn.id, mode: 'replace' }
  paintComposerBanner()
  message.focus()
}

function startBranch(turn: Turn): void {
  pendingFrom = { turnId: turn.id, mode: 'after' }
  paintComposerBanner()
  message.focus()
}

function paintComposerBanner(): void {
  const banner = $('composer-banner')
  if (pendingFrom === null) {
    banner.hidden = true
    return
  }
  banner.hidden = false
  $('composer-banner-text').textContent = pendingFrom.mode === 'replace' ? 'Editing a message — sends as a new version' : 'New branch after this reply'
}

function userActions(turn: Turn): HTMLElement {
  const actions = document.createElement('div')
  actions.className = 'u-actions'
  const time = document.createElement('span')
  time.className = 'u-time'
  time.textContent = new Date(turn.started).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const copy = userActionButton('copy-icon', 'Copy', () => {
    void navigator.clipboard.writeText(turn.prompt).then(() => {
      copy.classList.add('copied')
      setTimeout(() => copy.classList.remove('copied'), 1200)
    })
  })
  copy.dataset.flash = 'Copied'
  const branch = userActionButton('branch-icon', 'Branch from this message', () => startBranch(turn))
  if (pendingFrom?.turnId === turn.id && pendingFrom.mode === 'after') branch.classList.add('hot')
  const edit = userActionButton('pencil-icon', 'Edit message', () => startEdit(turn))
  if (pendingFrom?.turnId === turn.id && pendingFrom.mode === 'replace') edit.classList.add('hot')
  actions.append(time, edit, copy, branch)
  return actions
}

function versionSwitch(turn: Turn, group: VersionEntry): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'u-versions'
  const edited = document.createElement('span')
  edited.className = 'u-edited'
  edited.textContent = 'edited'
  const switcher = document.createElement('span')
  switcher.className = 'ver-switch'
  const step = (direction: -1 | 1, label: string, title: string): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.setAttribute('aria-label', title)
    const target = group.ids[group.index - 1 + direction]
    button.disabled = target === undefined
    button.onclick = () => {
      const entry = threadVersions[target]
      if (entry !== undefined) setLeaf(entry.leaf)
    }
    return button
  }
  const position = document.createElement('span')
  position.textContent = `${group.index} / ${group.count}`
  switcher.append(step(-1, '‹', 'Previous version'), position, step(1, '›', 'Next version'))
  wrap.append(edited, switcher)
  return wrap
}

function branchDivider(turn: Turn): HTMLElement {
  const point = branchPoints.find(entry => entry.turnId === turn.id)
  const divider = document.createElement('div')
  divider.className = 'branch-divider'
  divider.dataset.turn = turn.id
  divider.dataset.part = 'branch'
  const left = document.createElement('i')
  left.className = 'branch-rule'
  const pill = document.createElement('span')
  pill.className = 'branch-pill'
  pill.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 20 20"><use href="#branch-icon"/></svg>')
  const label = document.createElement('span')
  label.append('Branch · ')
  const bold = document.createElement('b')
  bold.textContent = point?.label ?? ''
  label.append(bold)
  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'text-button'
  back.textContent = 'Back to main'
  back.onclick = () => setLeaf(point?.mainLeaf ?? '')
  pill.append(label, back)
  const right = document.createElement('i')
  right.className = 'branch-rule'
  divider.append(left, pill, right)
  return divider
}

function userRow(turn: Turn): HTMLElement {
  const row = document.createElement('div')
  row.className = 'msg user'
  const stack = document.createElement('div')
  stack.className = 'u-stack'
  const bubble = document.createElement('div')
  bubble.className = 'user-message'
  if (turn.images.length > 0) {
    bubble.classList.add('chat-user-with-image')
    const text = document.createElement('span')
    text.textContent = turn.prompt
    bubble.append(text)
    turn.images.forEach((name, index) => {
      const figure = document.createElement('figure')
      figure.className = 'chat-attach'
      const shot = document.createElement('img')
      shot.className = 'chat-shot'
      shot.alt = name
      shot.src = `/api/jobs/${encodeURIComponent(turn.id)}/images/${index}`
      shot.onerror = () => {
        const icon = document.createElement('span')
        icon.className = 'attach-icon'
        icon.insertAdjacentHTML('afterbegin', '<svg><use href="#file-icon"/></svg>')
        shot.replaceWith(icon)
      }
      const caption = document.createElement('figcaption')
      caption.insertAdjacentHTML('afterbegin', '<svg><use href="#file-icon"/></svg>')
      caption.append(`${name} · sent as image`)
      figure.append(shot, caption)
      bubble.append(figure)
    })
  } else {
    bubble.textContent = turn.prompt
  }
  stack.append(bubble)
  const group = threadVersions[turn.id]
  if (group !== undefined) stack.append(versionSwitch(turn, group))
  if (turn.source === 'user' && document.body.dataset.chatEngine !== 'codex') stack.append(userActions(turn))
  row.append(stack)
  return row
}

function outcomeTone(outcome: string): string {
  if (outcome === 'done') return 'done'
  return outcome.startsWith('failed') || outcome === 'blocked' ? 'failed' : 'other'
}

function agentRow(turn: Turn): HTMLElement {
  const report = parseAgentReport(turn.prompt)
  if (!report) return rawAgentRow(turn)
  const row = document.createElement('div')
  row.className = 'agent-report compact'
  row.style.setProperty('--engine', ENGINE_COLORS[report.engine] ?? '#b5a5d8')
  const head = document.createElement('div'); head.className = 'agent-report-head'
  const disc = document.createElement('span'); disc.className = 'engine-tile'
  if (report.engine === 'workflow') disc.insertAdjacentHTML('afterbegin', '<svg aria-hidden="true" style="width:14px;height:14px"><use href="#flow-icon"/></svg>')
  else {
    const logo = document.createElement('img'); logo.src = `/providers/${report.engine}.svg`; logo.alt = engineName(report.engine)
    disc.append(logo)
  }
  const label = document.createElement('span'); label.className = 'agent-report-label'; label.textContent = report.label
  const pill = document.createElement('span'); pill.className = 'outcome-pill'; pill.dataset.tone = outcomeTone(report.outcome)
  pill.textContent = report.outcome.charAt(0).toUpperCase() + report.outcome.slice(1)
  head.append(disc, label, pill)
  row.append(head)
  if (report.body === '') return row
  const body = document.createElement('div'); body.className = 'md agent-report-body'; body.hidden = true
  body.append(renderMarkdown(report.body))
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'text-button'; toggle.textContent = 'Show report'
  toggle.onclick = () => morph(row, () => {
    body.hidden = !body.hidden
    toggle.textContent = body.hidden ? 'Show report' : 'Hide report'
  })
  head.append(toggle)
  row.append(body)
  return row
}

function rawAgentRow(turn: Turn): HTMLElement {
  const row = document.createElement('details')
  row.className = 'agent-report'
  const [first, ...rest] = turn.prompt.split('\n')
  const summary = document.createElement('summary'); summary.textContent = first ?? ''
  const body = document.createElement('pre'); body.textContent = rest.join('\n').trim()
  row.append(summary, body)
  return row
}

const KIND_ICONS: Record<ToolCardKind, string> = { read: 'file-icon', search: 'search-icon', edit: 'pencil-icon', bash: 'terminal-icon', agent: 'agents-icon', other: 'code-icon' }
const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

function termOut(text: string): HTMLElement {
  const out = document.createElement('pre')
  out.className = 'term-out'
  out.innerHTML = ansiHtml(capOutput(text))
  return out
}

function toolSummary(card: ToolCard): HTMLElement {
  const summary = document.createElement('summary')
  summary.insertAdjacentHTML('afterbegin', '<svg class="tool-caret"><use href="#chevron-icon"/></svg>')
  summary.insertAdjacentHTML('beforeend', `<svg><use href="#${KIND_ICONS[card.kind]}"/></svg>`)
  const verb = document.createElement('span'); verb.className = 'tool-verb'; verb.textContent = card.verb
  const target = document.createElement('span'); target.className = 'tool-target'; target.textContent = card.target
  const status = document.createElement('span'); status.className = 'tool-status'
  if (card.status === 'done') {
    status.append(card.summary)
    status.insertAdjacentHTML('beforeend', '<svg><use href="#check-icon"/></svg>')
  } else {
    status.insertAdjacentHTML('afterbegin', '<i class="tool-dot"></i>')
    status.append(card.summary)
  }
  summary.append(verb, target, status)
  if (card.errorLine !== null) {
    const error = document.createElement('span'); error.className = 'tool-err'; error.textContent = card.errorLine
    summary.append(error)
  }
  return summary
}

function bashHead(card: ToolCard): HTMLElement {
  const head = document.createElement('div')
  head.className = 'cmd-head'
  const line = document.createElement('span'); line.className = 'cmd-line'
  const dollar = document.createElement('b'); dollar.textContent = '$'
  line.append(dollar, ` ${card.command ?? ''}`)
  head.append(line)
  if (rootCwd !== null) {
    const tag = document.createElement('span'); tag.className = 'cmd-tag'
    tag.insertAdjacentHTML('afterbegin', '<svg><use href="#folder-icon"/></svg>')
    tag.append(baseName(rootCwd))
    head.append(tag)
  }
  if (card.exitCode !== null) {
    const badge = document.createElement('span'); badge.className = 'exit-badge'
    badge.dataset.tone = card.exitCode === 0 ? 'ok' : 'fail'
    badge.textContent = `exit ${card.exitCode}`
    head.append(badge)
  }
  head.append(copyButton(card.command ?? ''))
  return head
}

function relativeDiffPath(path: string): string {
  if (rootCwd === null || !path.startsWith('/')) return path
  const root = `${rootCwd}/`
  if (!path.startsWith(root)) return path
  return path.slice(root.length)
}

async function undoEdit(turnId: string, toolUseId: string): Promise<void> {
  const result = await postJson(`/api/jobs/${encodeURIComponent(turnId)}/undo`, { toolUseId })
  if (!result.ok) { chatError(errorText(result)); return }
  await refresh()
}

function diffCard(card: ToolCard, turn: Turn): HTMLElement {
  const diff = card.diff!
  const article = document.createElement('article')
  article.className = 'diff-card'
  const head = document.createElement('header')
  head.className = 'diff-head'
  head.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 20 20"><use href="#file-icon"/></svg>')
  const path = document.createElement('code')
  path.className = 'diff-path'
  path.textContent = relativeDiffPath(diff.path)
  const tool = document.createElement('span')
  tool.className = 'diff-tool'
  tool.textContent = diff.tool
  const stat = document.createElement('span')
  stat.className = 'diff-stat'
  const additions = document.createElement('span')
  additions.className = 'add'
  additions.textContent = `+${diff.additions}`
  const deletions = document.createElement('span')
  deletions.className = 'del'
  deletions.textContent = `−${diff.deletions}`
  stat.append(additions, deletions)
  head.append(path, tool, stat)
  const spacer = document.createElement('span')
  spacer.className = 'sp'
  head.append(spacer)
  if (diff.tool !== 'Write') {
    const undo = document.createElement('button')
    undo.type = 'button'
    undo.className = 'text-button diff-undo'
    undo.textContent = card.undone ? 'Undone' : 'Undo this edit'
    undo.disabled = card.undone || turn.running
    undo.onclick = () => { void undoEdit(turn.id, card.toolUseId) }
    head.append(undo)
  }
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'text-button diff-open'
  open.textContent = 'Open full diff'
  open.onclick = () => {
    article.classList.toggle('open')
    open.textContent = article.classList.contains('open') ? 'Close full diff' : 'Open full diff'
  }
  head.append(open)
  const body = document.createElement('div')
  body.className = 'diff-body'
  for (const line of diff.lines) {
    const row = document.createElement('div')
    row.className = line.sign === '+' ? 'diff-line add' : line.sign === '-' ? 'diff-line del' : 'diff-line'
    const oldNumber = document.createElement('span')
    oldNumber.className = 'n'
    oldNumber.textContent = line.old === null ? '' : String(line.old)
    const newNumber = document.createElement('span')
    newNumber.className = 'n'
    newNumber.textContent = line.new === null ? '' : String(line.new)
    const sign = document.createElement('span')
    sign.className = 's'
    sign.textContent = line.sign === ' ' ? ' ' : line.sign
    const code = document.createElement('code')
    code.textContent = line.text
    row.append(oldNumber, newNumber, sign, code)
    body.append(row)
  }
  article.append(head, body)
  return article
}

function toolDetail(card: ToolCard, turn: Turn): HTMLElement | null {
  const detail = document.createElement('div')
  detail.className = 'tool-detail'
  if (card.kind === 'edit' && card.diff !== null) detail.append(diffCard(card, turn))
  if (card.kind === 'bash') detail.append(bashHead(card), termOut(card.output))
  else if (card.output !== '') detail.append(termOut(card.output))
  return detail.childElementCount === 0 ? null : detail
}

const rowSignature = (card: ToolCard): string => JSON.stringify([card.status, card.summary, card.errorLine, card.exitCode, card.command, card.output, card.undone])

const PERMISSION_ICONS: Record<string, string> = { Bash: 'terminal-icon', Edit: 'pencil-icon', Write: 'pencil-icon', MultiEdit: 'pencil-icon', NotebookEdit: 'pencil-icon' }
const permissionIcon = (toolName: string): string => PERMISSION_ICONS[toolName] ?? 'code-icon'
const PERMISSION_STATE_TEXT: Record<string, string> = { allow_once: 'allowed once', allow_always: 'always allowed', deny: 'denied', cancelled: 'cancelled' }
const answering = new Set<string>()

function setPermissionButtons(requestId: string, disabled: boolean): void {
  for (const button of messages.querySelectorAll<HTMLButtonElement>(`button[data-request="${CSS.escape(requestId)}"]`)) button.disabled = disabled
}

function settleAnswered(turns: Turn[]): void {
  for (const permission of turns.flatMap(turn => turn.permissions)) {
    if (permission.state !== 'pending') answering.delete(permission.requestId)
  }
}

async function answerPermission(turnId: string, requestId: string, decision: string): Promise<void> {
  if (answering.has(requestId)) return
  answering.add(requestId)
  setPermissionButtons(requestId, true)
  const result = await postJson(`/api/jobs/${encodeURIComponent(turnId)}/permission`, { requestId, decision })
  if (!result.ok) {
    answering.delete(requestId)
    setPermissionButtons(requestId, false)
    chatError(`Could not answer the request: ${errorText(result)}`)
    return
  }
  await refresh()
}

function permissionButton(turnId: string, permission: PermissionView, label: string, className: string, decision: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = label
  button.dataset.request = permission.requestId
  button.disabled = answering.has(permission.requestId)
  button.onclick = () => { void answerPermission(turnId, permission.requestId, decision) }
  return button
}

function permissionCard(turnId: string, permission: PermissionView): HTMLElement {
  const card = document.createElement('article')
  card.className = 'chat-perm'
  card.setAttribute('aria-label', 'Permission request')
  const head = document.createElement('header')
  head.className = 'chat-perm-head'
  const icon = document.createElement('span')
  icon.className = 'chat-perm-icon'
  icon.insertAdjacentHTML('afterbegin', `<svg><use href="#${permissionIcon(permission.toolName)}"/></svg>`)
  const title = document.createElement('strong')
  title.textContent = permission.title
  const note = document.createElement('span')
  note.className = 'chat-perm-note'
  note.insertAdjacentHTML('afterbegin', '<svg><use href="#lock-icon"/></svg>')
  note.append('Nothing runs until you choose')
  head.append(icon, title, note)
  card.append(head)
  if (permission.plan !== null) {
    const plan = document.createElement('pre')
    plan.className = 'term-out'
    plan.textContent = permission.plan
    card.append(plan)
  } else {
    const line = document.createElement('div')
    line.className = 'chat-cmd'
    const code = document.createElement('code')
    if (permission.command !== null) {
      const prompt = document.createElement('span')
      prompt.className = 'chat-prompt'
      prompt.textContent = '$'
      code.append(prompt, permission.command)
    } else {
      code.append(permission.target ?? permission.toolName)
    }
    line.append(code)
    if (rootCwd !== null) {
      const cwd = document.createElement('span')
      cwd.className = 'chat-cwd'
      cwd.insertAdjacentHTML('afterbegin', '<svg><use href="#folder-icon"/></svg>')
      cwd.append(baseName(rootCwd))
      line.append(cwd)
    }
    card.append(line)
  }
  const footer = document.createElement('footer')
  footer.className = 'chat-perm-actions'
  const reason = document.createElement('p')
  reason.className = 'chat-reason'
  reason.textContent = permission.description
  footer.append(reason, permissionButton(turnId, permission, 'Deny', 'text-button', 'deny'), permissionButton(turnId, permission, 'Allow once', 'pill', 'allow_once'))
  if (!permission.suppressAlways) footer.append(permissionButton(turnId, permission, 'Always allow in this chat', 'pill chat-primary', 'allow_always'))
  card.append(footer)
  return card
}

function permissionChip(permission: PermissionView): HTMLElement {
  const chip = document.createElement('div')
  chip.className = 'chat-step chat-resolved'
  chip.insertAdjacentHTML('afterbegin', `<svg><use href="#${permissionIcon(permission.toolName)}"/></svg>`)
  const span = document.createElement('span')
  const code = document.createElement('code')
  code.textContent = permission.command ?? permission.target ?? permission.toolName
  span.append(`${permission.toolName === '' ? 'Tool' : permission.toolName} `, code)
  const state = document.createElement('small')
  state.textContent = PERMISSION_STATE_TEXT[permission.state] ?? 'cancelled'
  chip.append(span, state)
  return chip
}

function resolvedPermissionSteps(turn: Turn): HTMLElement | null {
  const resolved = turn.permissions.filter(permission => permission.state !== 'pending')
  if (resolved.length === 0) return null
  const steps = document.createElement('div')
  steps.className = 'chat-steps'
  steps.append(...resolved.map(permissionChip))
  return steps
}

function toolRow(card: ToolCard, turn: Turn): HTMLDetailsElement {
  const row = document.createElement('details')
  row.className = 'tool-row'
  row.dataset.key = card.key
  row.dataset.status = card.status
  row.dataset.sig = rowSignature(card)
  row.append(toolSummary(card))
  const detail = toolDetail(card, turn)
  if (detail !== null) row.append(detail)
  trackRowScroll(row)
  return row
}

function paintToolList(list: HTMLElement, cards: ToolCard[], turn: Turn): void {
  const rows = new Map([...list.children].map(row => [(row as HTMLElement).dataset.key ?? '', row as HTMLDetailsElement]))
  for (const card of cards) {
    const row = rows.get(card.key)
    if (row === undefined) {
      list.append(toolRow(card, turn))
      continue
    }
    rows.delete(card.key)
    const sig = rowSignature(card)
    if (row.dataset.sig === sig) continue
    const saved = rowScrollOf(row)
    row.dataset.status = card.status
    row.dataset.sig = sig
    row.replaceChildren(toolSummary(card))
    const detail = toolDetail(card, turn)
    if (detail !== null) row.append(detail)
    trackRowScroll(row)
    setRowScroll(row, saved)
  }
  for (const row of rows.values()) row.remove()
}

function turnErrorNode(turn: Turn): HTMLElement {
  const card = document.createElement('div')
  card.className = 'turn-error'
  card.setAttribute('role', 'alert')
  card.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 22 22"><circle cx="11" cy="11" r="9"/><path d="M11 6.5v5.5"/><circle cx="11" cy="15.3" r=".6" fill="currentColor"/></svg>')
  const body = document.createElement('div')
  const title = document.createElement('strong'); title.textContent = 'This reply stopped with an error'
  const reason = document.createElement('p'); reason.textContent = turn.error
  const actions = document.createElement('div'); actions.className = 'error-actions'
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'retry-button'
  retry.insertAdjacentHTML('afterbegin', '<svg><use href="#history-icon"/></svg>'); retry.append('Retry')
  retry.onclick = () => { retry.disabled = true; void sendMessage(turn.prompt).finally(() => { retry.disabled = false }) }
  actions.append(retry)
  if (turn.errorDetail !== '') {
    const detail = document.createElement('pre'); detail.className = 'term-out'; detail.textContent = turn.errorDetail; detail.hidden = true
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'text-button'; toggle.textContent = 'Show details'
    toggle.onclick = () => { detail.hidden = !detail.hidden; toggle.textContent = detail.hidden ? 'Show details' : 'Hide details' }
    actions.append(toggle)
    body.append(title, reason, actions, detail)
  } else {
    body.append(title, reason, actions)
  }
  card.append(body)
  return card
}

function activityNode(turn: Turn): HTMLElement {
  const finishedWithSteps = !turn.running && turn.steps.length > 0
  const line = document.createElement(finishedWithSteps ? 'summary' : 'p')
  line.className = 'activity-line'
  line.dataset.running = String(turn.running)
  line.textContent = workedLine(turn, Date.now())
  if (turn.failed) {
    const pill = document.createElement('span'); pill.className = 'outcome-pill'; pill.dataset.tone = 'failed'; pill.textContent = 'Failed'
    line.append(pill)
  }
  if (!finishedWithSteps) return line
  const details = document.createElement('details'); details.className = 'turn-steps tool-steps'
  const card = document.createElement('div'); card.className = 'tool-card'
  paintToolList(card, turn.cards, turn)
  details.append(line, card)
  return details
}

function fadeStep(tick: HTMLElement, step: string): void {
  if (tick.dataset.step === step) return
  tick.dataset.step = step
  if (!tick.textContent) { tick.textContent = step; return }
  tick.classList.add('out')
  setTimeout(() => { tick.textContent = tick.dataset.step ?? ''; tick.classList.remove('out') }, STEP_FADE_MS)
}

function growText(md: Element, text: string): void {
  const before = md.children.length
  md.replaceChildren(renderMarkdown(text))
  for (const block of [...md.children].slice(before)) block.classList.add('md-in')
}

function patchReply(reply: HTMLElement, turn: Turn): boolean {
  if (turn.running) reply.querySelector('.activity-line')!.textContent = runningLabel(turn, Date.now())
  const tick = reply.querySelector<HTMLElement>('.step-tick')
  const step = turn.steps.at(-1)
  if (tick && step) fadeStep(tick, step)
  const card = reply.querySelector<HTMLElement>('.tool-card')
  if (card !== null) paintToolList(card, turn.cards, turn)
  if (reply.dataset.live === '1') return false
  if (reply.dataset.text === String(turn.text.length)) return false
  reply.dataset.text = String(turn.text.length)
  growText(reply.querySelector('.md')!, turn.text)
  return true
}

function tickRunning(): void {
  const now = Date.now()
  for (const turn of shownTurns) {
    if (!turn.running) continue
    const line = messages.querySelector(`[data-turn="${CSS.escape(turn.id)}"][data-part="reply"] .activity-line`)
    if (line) line.textContent = runningLabel(turn, now)
  }
}

function toBottom(behavior: ScrollBehavior = 'smooth'): void {
  stage.scrollTo({ top: stage.scrollHeight, behavior })
}

function assistantRow(turn: Turn, rows: TeamRow[], project: string | null): HTMLElement {
  const row = ($('assistant-row') as HTMLTemplateElement).content.firstElementChild!.cloneNode(true) as HTMLElement
  row.querySelector('time')!.textContent = new Date(turn.started).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const body = row.querySelector('.msg-body')!
  body.append(activityNode(turn))
  if (turn.failed) body.append(turnErrorNode(turn))
  const resolvedSteps = resolvedPermissionSteps(turn)
  if (resolvedSteps !== null) body.append(resolvedSteps)
  if (turn.running) {
    const tick = document.createElement('p'); tick.className = 'step-tick'; tick.textContent = tick.dataset.step = turn.steps.at(-1) ?? ''
    const card = document.createElement('div'); card.className = 'tool-card'
    paintToolList(card, turn.cards, turn)
    body.append(tick, card)
  }
  const md = document.createElement('div'); md.className = 'md'; md.append(renderMarkdown(turn.text)); body.append(md)
  for (const permission of turn.permissions) {
    if (permission.state === 'pending') body.append(permissionCard(turn.id, permission))
  }
  if (rows.length) body.append(teamCard(rows, project))
  return row
}

function signature(turn: Turn, rows: TeamRow[]): string {
  return JSON.stringify([turn.running ? 0 : turn.tools, turn.running, turn.edits.length, turn.failed, turn.stopped, turn.error, turn.permissions.map(permission => [permission.requestId, permission.state]), rows.map(row => [row.id, row.state, row.activity])])
}

function paint(turns: Turn[], project: string | null): void {
  const existing = new Map([...messages.querySelectorAll<HTMLElement>('[data-turn]')].map(node => [`${node.dataset.turn}:${node.dataset.part}`, node]))
  const atBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight < 80
  const firstPaint = messages.childElementCount === 0
  const ordered: HTMLElement[] = []
  const rebuilt: { reply: HTMLElement; rowStates: Map<string, RowState> }[] = []
  let grew = false
  shownTurns = turns
  settleAnswered(turns)
  for (const turn of turns) {
    const rows = teamRows(agents, turn.id)
    if (turn.branchFrom !== null) ordered.push(existing.get(`${turn.id}:branch`) ?? branchDivider(turn))
    const vsig = JSON.stringify(threadVersions[turn.id] ?? null)
    const kept = existing.get(`${turn.id}:prompt`)
    const prompt = kept !== undefined && kept.dataset.vsig === vsig ? kept : (turn.source === 'agent' ? agentRow(turn) : userRow(turn))
    prompt.dataset.turn = turn.id
    prompt.dataset.part = 'prompt'
    prompt.dataset.vsig = vsig
    ordered.push(prompt)
    const sig = signature(turn, rows)
    let reply = existing.get(`${turn.id}:reply`)
    if (!reply || reply.dataset.sig !== sig) {
      const wasOpen = reply?.querySelector<HTMLDetailsElement>('.turn-steps')?.open === true
      const rowStates = reply ? collectRowStates(reply) : new Map<string, RowState>()
      reply = assistantRow(turn, rows, project)
      Object.assign(reply.dataset, { turn: turn.id, part: 'reply', sig, text: String(turn.text.length) })
      const shown = liveShown.get(turn.id)
      if (turn.running && liveSource !== null) {
        reply.dataset.live = '1'
        if (shown !== undefined) reply.querySelector('.md')!.replaceChildren(renderMarkdown(steadyLiveText(shown, turn.text)))
      }
      const steps = reply.querySelector<HTMLDetailsElement>('.turn-steps')
      if (steps) steps.open = wasOpen
      for (const row of reply.querySelectorAll<HTMLDetailsElement>('.tool-row')) {
        const state = rowStates.get(row.dataset.key ?? '')
        if (state) row.open = state.open
      }
      rebuilt.push({ reply, rowStates })
    } else if (patchReply(reply, turn)) grew = true
    ordered.push(reply)
  }
  const reordered = ordered.some((node, index) => messages.children[index] !== node) || messages.children.length !== ordered.length
  if (reordered) messages.replaceChildren(...ordered)
  if (rebuilt.length > 0) {
    requestAnimationFrame(() => {
      for (const { reply, rowStates } of rebuilt) {
        for (const row of reply.querySelectorAll<HTMLDetailsElement>('.tool-row')) {
          const state = rowStates.get(row.dataset.key ?? '')
          if (state) setRowScroll(row, state.scrollTop)
        }
      }
    })
  }
  if (atBottom && (reordered || grew)) toBottom(firstPaint ? 'auto' : 'smooth')
}

async function refresh(): Promise<void> {
  if (!root) return
  const mine = ++generation
  const storedLeaf = stored(`skd.chat.leaf.${root}`)
  const [thread, jobs, queue] = await Promise.all([getJson(`/api/jobs/${encodeURIComponent(root)}/thread${storedLeaf ? `?leaf=${encodeURIComponent(storedLeaf)}` : ''}`), getJson(`/api/jobs?chat=${encodeURIComponent(root)}`), getJson(`/api/jobs/${encodeURIComponent(root)}/queue`)])
  if (mine !== generation || !root) return
  if (!thread.ok) {
    if (thread.status === 404) { dispatchEvent(new Event('quiet:new-chat')); show('welcome'); return }
    chatError(`Could not reach the chat: ${errorText(thread)}. Retrying…`); schedule(); return
  }
  clearChatError()
  const all = readArray(jobs.ok ? jobs.data.jobs : []) as unknown as Array<AgentJob & TurnJob & { threadRoot?: string; purpose?: string; project?: string | null; cwd?: string | null }>
  const turnsJobs = all.filter(job => job.threadRoot === root)
  agents = all.filter(job => job.purpose !== 'chat')
  const rootJob = all.find(job => job.id === root)
  if (typeof rootJob?.engine === 'string' && rootJob.engine !== '' && document.body.dataset.chatEngine !== rootJob.engine) {
    document.body.dataset.chatEngine = rootJob.engine
    dispatchEvent(new Event('quiet:chat-engine'))
  }
  rootCwd = rootJob?.cwd ?? null
  const project = rootJob?.project ?? null
  threadVersions = (thread.data.versions ?? {}) as Record<string, VersionEntry>
  branchPoints = readArray(thread.data.branchPoints) as unknown as BranchPoint[]
  paint(turnsFrom(readArray(thread.data.messages) as unknown as ThreadMessage[], turnsJobs), project)
  const nowRunning = thread.data.running === true
  setRunning(nowRunning)
  if (wasRunning && !nowRunning) void loadCommands()
  wasRunning = nowRunning
  paintContextMeter(thread.data.usage as { contextPercent: number | null; costUsd: number | null } | undefined)
  const live = thread.data.live as { jobId: string; offset: number; partial: boolean } | null | undefined
  if (live !== null && live !== undefined) openLiveText(live)
  else if (liveSource !== null) closeLiveText()
  paintQueue(queue.ok ? readArray(queue.data.items) as unknown as QueuedItem[] : [])
  schedule()
}

function paintContextMeter(usage: { contextPercent: number | null; costUsd: number | null } | undefined | null): void {
  const meter = $('ctx-meter')
  const percent = usage === undefined || usage === null ? null : usage.contextPercent
  const cost = usage === undefined || usage === null ? null : usage.costUsd
  if (percent === null && cost === null) {
    meter.hidden = true
    return
  }
  meter.hidden = false
  const circumference = 2 * Math.PI * 7.5
  const fill = meter.querySelector('circle.fill') as SVGCircleElement
  const ratio = percent === null ? 0 : Math.min(100, Math.max(0, percent)) / 100
  fill.setAttribute('stroke-dasharray', `${(ratio * circumference).toFixed(1)} ${circumference.toFixed(1)}`)
  fill.style.stroke = percent !== null && percent >= 80 ? 'var(--danger)' : ''
  const text = $('ctx-text')
  text.replaceChildren()
  if (percent !== null) {
    const value = document.createElement('b')
    value.textContent = `${Math.round(percent)}%`
    text.append(value, ' context')
  }
  text.append(costText(percent, cost))
  meter.querySelector<SVGElement>('svg')!.style.display = percent === null ? 'none' : ''
}

function schedule(): void {
  clearTimeout(pollTimer)
  if (!root || $('conversation').hidden || document.visibilityState !== 'visible') { stopPolling(); return }
  pollTimer = window.setTimeout(() => void refresh(), running && liveSource === null ? RUNNING_POLL_MS : IDLE_POLL_MS)
  tickTimer ||= window.setInterval(tickRunning, TICK_MS)
}

let liveSource: EventSource | null = null
let liveFeed: LiveFeed | null = null
let liveFrame = 0
let liveRefreshTimer = 0
const liveShown = new Map<string, string>()
let liveRendered = new WeakMap<Element, string>()

function scheduleLiveRefresh(): void {
  clearTimeout(liveRefreshTimer)
  liveRefreshTimer = window.setTimeout(() => void refresh(), 150)
}

function closeLiveText(): void {
  if (liveSource !== null) {
    liveSource.close()
    liveSource = null
  }
  cancelAnimationFrame(liveFrame)
  liveFeed = null
  for (const node of messages.querySelectorAll<HTMLElement>('[data-live]')) delete node.dataset.live
  for (const caret of messages.querySelectorAll('.chat-caret')) caret.remove()
}

function paintLiveFrame(): void {
  if (liveSource === null || liveFeed === null) return
  liveFrame = requestAnimationFrame(paintLiveFrame)
  const turn = [...shownTurns].reverse().find(item => item.running)
  if (turn === undefined) return
  const reply = messages.querySelector<HTMLElement>(`[data-turn="${CSS.escape(turn.id)}"][data-part="reply"]`)
  const md = reply?.querySelector('.md')
  if (md === undefined || md === null) return
  reply!.dataset.live = '1'
  const text = steadyLiveText(liveShown.get(turn.id), liveFeed.text(turn.text))
  liveShown.set(turn.id, text)
  if (liveRendered.get(md) !== text) {
    growText(md, text)
    liveRendered.set(md, text)
  }
  if (md.querySelector('.chat-caret') === null) {
    const caret = document.createElement('span')
    caret.className = 'chat-caret'
    caret.setAttribute('aria-hidden', 'true')
    md.append(caret)
  }
}

function openLiveText(live: { jobId: string; offset: number; partial: boolean }): void {
  closeLiveText()
  liveFeed = createLiveFeed(scheduleLiveRefresh)
  liveFeed.setPartial(live.partial)
  liveSource = new EventSource(`/api/jobs/${encodeURIComponent(live.jobId)}/stream?offset=${live.offset}`)
  liveSource.onmessage = (event) => liveFeed?.push(`${event.data}\n`)
  liveSource.onerror = () => closeLiveText()
  const turn = [...shownTurns].reverse().find(item => item.running)
  const reply = turn === undefined ? null : messages.querySelector<HTMLElement>(`[data-turn="${CSS.escape(turn.id)}"][data-part="reply"]`)
  if (reply !== null) reply.dataset.live = '1'
  cancelAnimationFrame(liveFrame)
  liveFrame = requestAnimationFrame(paintLiveFrame)
}

function stopPolling(): void {
  clearTimeout(pollTimer)
  clearInterval(tickTimer)
  tickTimer = 0
}

function askHome(why: string, candidates: string[]): Promise<string | null> {
  const dialog = $('chat-home') as HTMLDialogElement
  const input = $('chat-home-path') as HTMLInputElement
  const form = $('chat-home-form') as HTMLFormElement
  $('chat-home-why').textContent = why
  $('chat-home-error').textContent = ''
  input.value = candidates[0] ?? ''
  $('chat-home-candidates').replaceChildren(...candidates.map(path => { const button = document.createElement('button'); button.type = 'button'; button.textContent = path; button.onclick = () => { input.value = path }; return button }))
  dialog.showModal()
  ;[...$('chat-home-candidates').children].forEach((choice, index) => (choice as HTMLElement).animate?.([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: MORPH_MS, easing: MORPH_EASE, delay: 60 + index * 40, fill: 'backwards' }))
  return new Promise(resolve => {
    const done = (value: string | null): void => { dialog.removeEventListener('close', onClose); dialog.close(); resolve(value) }
    const onClose = (): void => done(null)
    dialog.addEventListener('close', onClose)
    form.onsubmit = async (event) => {
      event.preventDefault()
      const response = await fetch('/api/chat/home', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: input.value.trim() }) })
      const payload = (await response.json().catch(() => ({}))) as { path?: string; error?: string }
      if (response.ok && typeof payload.path === 'string') done(payload.path)
      else $('chat-home-error').textContent = payload.error ?? 'That folder cannot be used.'
    }
  })
}

async function ensureHome(): Promise<string | null> {
  const status = await getJson('/api/chat/home')
  if (!status.ok) { chatError(errorText(status)); return null }
  if (status.data.ok === true) return String(status.data.path)
  const candidates = (readArray(status.data.candidates) as unknown[]).map(String)
  return askHome(status.data.reason === 'home' ? 'Your projects share only your home folder. Pick the folder that holds them.' : 'No projects yet. Type the folder where your projects live.', candidates)
}

async function createChat(options: { engine: string; model: string; cwd: string; prompt: string; images: string[]; mode: string | null; project: string | null }): Promise<void> {
  const result = await postJson('/api/jobs', { engine: options.engine, ...(options.model ? { model: options.model } : {}), ...(options.mode === null ? {} : { permissionMode: options.mode }), cwd: options.cwd, prompt: options.prompt, label: titleFrom(options.prompt), purpose: 'chat', edit: stored('skd.shell.edit') === '1', ...(options.project ? { project: options.project } : {}), ...(options.images.length > 0 ? { images: options.images.map(path => ({ path })) } : {}) })
  if (!result.ok) { chatError(errorText(result)); return }
  root = String(result.data.id)
  if (options.model) keep(`skd.chat.model.${root}`, options.model)
  if (options.mode !== null) keep(chatModeKey(root), options.mode)
  document.body.dataset.chat = root
  document.body.dataset.chatEngine = options.engine
  setUrl(root)
  dispatchEvent(new CustomEvent('quiet:chat-agents', { detail: root }))
  dispatchEvent(new CustomEvent('quiet:chat-open', { detail: root }))
  await refresh()
}

async function startChat(prompt: string, images: string[]): Promise<void> {
  const home = await ensureHome()
  if (!home) return
  await providersReady
  const choice = launchChoice(providers, stored('skd.shell.engine'), stored('skd.shell.model'))
  if (!choice.engine) { chatError('No AI is connected yet. Add one in Studio → Manage AIs.'); return }
  const project = stored('skd.shell.project')
  const mode = choice.engine === 'codex' ? null : chatModeChoice(null, stored)
  await createChat({ engine: choice.engine, model: choice.model, cwd: home, prompt, images, mode, project })
}

addEventListener('quiet:start-chat', (event) => {
  const detail = (event as CustomEvent<{ engine: string; model?: string; cwd: string; prompt: string }>).detail
  show('conversation')
  const mode = detail.engine === 'codex' ? null : chatModeChoice(null, stored)
  void createChat({ engine: detail.engine, model: detail.model ?? '', cwd: detail.cwd, prompt: detail.prompt, images: [], mode, project: stored('skd.shell.project') })
})

function restoreComposer(text: string, images: string[]): void {
  dispatchEvent(new CustomEvent('quiet:message-restore', { detail: { text, images } }))
}

function draftTurn(prompt: string, images: string[]): Turn {
  return { id: 'pending', source: 'user', prompt, text: '', tools: 0, edits: [], steps: [], cards: [], permissions: [], images, thinking: false, started: Date.now(), ended: null, running: true, failed: false, stopped: false, error: '', errorDetail: '', versionOf: null, branchFrom: null }
}

function clearEasterEgg(): void {
  easterEggRun?.abort()
  easterEggRun = null
  easterEgg.replaceChildren()
}

function startEasterEgg(prompt: string): void {
  clearEasterEgg()
  show('conversation')
  const reply = ($('assistant-row') as HTMLTemplateElement).content.firstElementChild!.cloneNode(true) as HTMLElement
  reply.querySelector('time')!.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  easterEgg.append(userRow(draftTurn(prompt, [])), reply)
  toBottom()
  easterEggRun = new AbortController()
  void playBadApple(reply.querySelector('.msg-body') as HTMLElement, easterEggRun.signal, () => toBottom())
}

async function sendMessage(prompt: string, images: string[] = []): Promise<void> {
  clearEasterEgg()
  show('conversation')
  if (!root) { messages.replaceChildren(userRow(draftTurn(prompt, images))); setRunning(true); toBottom(); await startChat(prompt, images); if (!root) { setRunning(false); messages.replaceChildren(); restoreComposer(prompt, images); show('welcome') } return }
  const result = await postJson(`/api/jobs/${encodeURIComponent(root)}/reply`, {
    message: prompt,
    ...(images.length > 0 ? { images: images.map(path => ({ path })) } : {}),
    ...replyChoices(),
    ...(stored(`skd.chat.leaf.${root}`) ? { parentTurnId: stored(`skd.chat.leaf.${root}`) } : {}),
    ...(pendingFrom === null ? {} : { from: pendingFrom }),
  })
  if (!result.ok) { chatError(errorText(result)); restoreComposer(prompt, images); return }
  pendingFrom = null
  paintComposerBanner()
  if (result.status !== 202 && typeof result.data.id === 'string') storeLeaf(result.data.id)
  if (result.status !== 202) setRunning(true)
  await refresh()
  toBottom()
}

function replyChoices(): { model?: string; permissionMode?: string } {
  const model = stored(`skd.chat.model.${root}`)
  const engine = document.body.dataset.chatEngine
  return {
    ...(model ? { model } : {}),
    ...(engine === 'codex' ? {} : { permissionMode: chatModeChoice(root, stored) }),
  }
}

type ListedJob = AgentJob & TurnJob & { threadRoot: string; purpose?: string; project?: string | null; chatId?: string; label: string }

function paintHistory(items: HistoryItem[]): void {
  rollText($('history-count'), items.length ? `(${items.length})` : '')
  const list = $('history-list')
  if (!items.length) { list.replaceChildren(Object.assign(document.createElement('p'), { className: 'history-empty', textContent: 'Nothing yet. Write a message or open a terminal to start.' })); historySignature = ''; return }
  const signature = JSON.stringify(items.map(item => [item.kind, item.id, item.title, item.updatedAt, item.kind === 'chat' ? [item.running, item.agents.map(job => [job.status, job.landedAt, job.stoppedAt])] : null]))
  if (signature === historySignature) return
  historySignature = signature
  const openIds = new Set([...list.querySelectorAll<HTMLElement>('details[open]')].map(item => item.dataset.item))
  const dotColors = new Map([...list.querySelectorAll<HTMLElement>('.live-dot')].map(dot => [(dot.closest('details') as HTMLElement).dataset.item, getComputedStyle(dot).backgroundColor]))
  list.replaceChildren(...items.map((item, index) => {
    const key = `${item.kind}:${item.id}`
    const signal = item.kind === 'chat' ? chatSignal(item.running, item.agents) : item.kind === 'terminal' && item.live ? { state: 'running' as const, count: 0 } : { state: null, count: 0 }
    const card = document.createElement('details'); card.className = 'history-item'; card.dataset.item = key; card.dataset.kind = item.kind; card.open = item.kind !== 'chat' && (openIds.size ? openIds.has(key) : index === 0)
    const summary = document.createElement('summary')
    if (item.kind === 'chat') summary.onclick = (event) => { event.preventDefault(); openChat(item.id) }
    const title = document.createElement('span')
    if (signal.state) { const dot = document.createElement('span'); dot.className = 'live-dot'; dot.dataset.state = signal.state; dot.title = signal.count ? `${signal.count} ${signal.state === 'running' ? 'running' : signal.state === 'needs-you' ? 'need you' : 'landed'}` : signal.state; title.append(dot); if (signal.count > 1) { const count = document.createElement('small'); count.className = 'dot-count'; count.textContent = String(signal.count); title.append(count) } }
    title.append(item.title)
    const dot = title.querySelector<HTMLElement>('.live-dot')
    if (dot) queueMicrotask(() => blendColor(dot, dotColors.get(key)))
    const time = document.createElement('time'); time.textContent = historyDay(item.updatedAt, Date.now())
    summary.append(title, time)
    const line = document.createElement('p'); line.textContent = historyLabel(item)
    const footer = document.createElement('footer')
    const kind = document.createElement('span'); kind.textContent = item.kind === 'chat' ? 'Chat' : item.kind === 'terminal' ? 'Terminal' : 'Claude Code'
    footer.append(kind)
    const actionText = historyAction(item)
    if (actionText) {
      const action = document.createElement('button'); action.type = 'button'; action.className = 'text-button'; action.textContent = actionText
      action.onclick = () => {
        const target = historyOpen(item)
        if (target === null) return
        if ('chat' in target) { openChat(target.chat); return }
        show('welcome')
        dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: target.terminal }))
      }
      footer.append(action)
    }
    card.append(summary, line, footer)
    return card
  }))
  dispatchEvent(new Event('quiet:history-painted'))
}

function paintAgentsCount(jobs: ListedJob[]): void {
  const running = jobs.filter(job => job.chatId && job.status === 'running').length
  const badge = $('agents-count')
  rollText(badge, String(running))
  reveal(badge, running > 0)
}

let jobsTimer = 0
let historySignature = ''
async function pollJobs(): Promise<void> {
  clearTimeout(jobsTimer)
  if (document.visibilityState === 'visible') {
    const result = await getJson('/api/jobs')
    if (result.ok) paintAgentsCount(readArray(result.data.jobs) as unknown as ListedJob[])
    if (!$('history').hidden) { const feed = await getJson('/api/history'); if (feed.ok) paintHistory(readArray(feed.data.items) as unknown as HistoryItem[]) }
  }
  jobsTimer = window.setTimeout(() => void pollJobs(), IDLE_POLL_MS)
}

export function openChat(id: string): void {
  clearEasterEgg()
  root = id
  agents = []
  shownTurns = []
  closeLiveText()
  messages.replaceChildren()
  setUrl(id)
  document.body.dataset.chat = id
  show('conversation')
  dispatchEvent(new CustomEvent('quiet:chat-agents', { detail: id }))
  dispatchEvent(new CustomEvent('quiet:chat-open', { detail: id }))
  void loadCommands()
  void refresh()
}

$('composer-banner-cancel').onclick = () => {
  pendingFrom = null
  paintComposerBanner()
  message.focus()
}

composer.onsubmit = (event) => {
  event.preventDefault()
  const prompt = message.value.trim()
  if (!prompt || (running && !root)) return
  closeSlashMenu()
  closeMentionMenu()
  if (isBadApple(prompt)) {
    morph(composer, () => { message.value = ''; message.style.height = '' })
    startEasterEgg(prompt)
    message.focus()
    return
  }
  const snapshot = { images: [] as string[] }
  dispatchEvent(new CustomEvent('quiet:collect-images', { detail: snapshot }))
  morph(composer, () => { message.value = ''; message.style.height = '' })
  dispatchEvent(new Event('quiet:message-sent'))
  void sendMessage(prompt, snapshot.images)
  message.focus()
}

const slashMenu = document.createElement('div')
slashMenu.className = 'popover chat-slash-menu'
slashMenu.setAttribute('role', 'listbox')
slashMenu.setAttribute('aria-label', 'Slash commands')
slashMenu.hidden = true
composer.append(slashMenu)
let chatCommands: ChatCommand[] = []
let commandsForChat: string | null = null
let slashIndex = 0

async function loadCommands(): Promise<void> {
  if (root === null) return
  const current = root
  const result = await getJson(`/api/jobs/${encodeURIComponent(current)}/commands`)
  if (!result.ok || root !== current) return
  chatCommands = (readArray(result.data.commands) as unknown as ChatCommand[]).filter(command => typeof command.name === 'string')
  commandsForChat = current
}

function closeSlashMenu(): void {
  slashMenu.hidden = true
  slashIndex = 0
}

function insertSlashCommand(command: ChatCommand): void {
  message.value = `/${command.name} `
  message.dispatchEvent(new Event('input', { bubbles: true }))
  closeSlashMenu()
  message.focus()
}

function slashRow(command: ChatCommand): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'row'
  button.setAttribute('role', 'option')
  button.insertAdjacentHTML('afterbegin', '<svg><use href="#terminal-icon"/></svg>')
  const text = document.createElement('span')
  const name = document.createElement('code')
  name.textContent = `/${command.name}`
  const description = document.createElement('small')
  description.textContent = command.description
  text.append(name, description)
  button.append(text)
  button.onclick = () => insertSlashCommand(command)
  return button
}

function paintSlashMenu(matches: readonly ChatCommand[], query: string): void {
  const nodes: HTMLElement[] = []
  if (matches.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'row muted'
    empty.textContent = query === '' ? 'Commands appear after the first reply' : `No command starts with ${query}`
    nodes.push(empty)
  } else {
    const label = document.createElement('div')
    label.className = 'group-label'
    label.textContent = 'Commands'
    nodes.push(label, ...matches.map(slashRow))
  }
  const divider = document.createElement('div')
  divider.className = 'divider'
  const foot = document.createElement('div')
  foot.className = 'chat-menu-foot'
  foot.append('Commands come from the agent — ')
  const key = document.createElement('kbd')
  key.textContent = 'Enter'
  foot.append(key, ' to insert')
  slashMenu.replaceChildren(...nodes, divider, foot)
  slashMenu.hidden = false
  slashIndex = 0
  markSlashCurrent(matches)
}

function markSlashCurrent(matches: readonly ChatCommand[]): void {
  const rows = [...slashMenu.querySelectorAll<HTMLButtonElement>('button.row')]
  rows.forEach((row, index) => {
    const current = index === slashIndex
    row.classList.toggle('current', current)
    row.setAttribute('aria-selected', String(current))
  })
}

function updateSlashMenu(): void {
  const query = slashQuery(message.value)
  if (query === null || root === null) {
    closeSlashMenu()
    return
  }
  if (commandsForChat !== root) {
    chatCommands = []
    void loadCommands()
  }
  paintSlashMenu(filterSlashCommands(chatCommands, query), query)
}

message.addEventListener('input', () => updateSlashMenu())
message.addEventListener('blur', () => setTimeout(() => { if (!slashMenu.contains(document.activeElement)) closeSlashMenu() }, 80))
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Node) || slashMenu.contains(event.target) || message.contains(event.target)) return
  closeSlashMenu()
})

function leavesEnterAlone(event: KeyboardEvent, highlighted: boolean): boolean {
  const intent = enterIntent(event, highlighted)
  return intent === 'newline' || intent === 'none'
}

composer.addEventListener('keydown', (event) => {
  if (slashMenu.hidden && mentionMenu.hidden) return
  if (!slashMenu.hidden) {
    const matches = filterSlashCommands(chatCommands, slashQuery(message.value) ?? '')
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (matches.length > 0) {
        slashIndex = event.key === 'ArrowDown' ? (slashIndex + 1) % matches.length : (slashIndex - 1 + matches.length) % matches.length
        markSlashCurrent(matches)
      }
      return
    }
    if (event.key === 'Enter' && leavesEnterAlone(event, matches[slashIndex] !== undefined)) return
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (matches.length === 0 && event.key === 'Tab') {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      if (matches[slashIndex] !== undefined) insertSlashCommand(matches[slashIndex])
      else if (event.key === 'Enter') composer.requestSubmit()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      closeSlashMenu()
    }
    return
  }
  const mentionMatches = mentionFiles
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (mentionMatches.length > 0) {
      mentionIndex = event.key === 'ArrowDown' ? (mentionIndex + 1) % mentionMatches.length : (mentionIndex - 1 + mentionMatches.length) % mentionMatches.length
      markMentionCurrent()
    }
    return
  }
  if (event.key === 'Enter' && leavesEnterAlone(event, mentionMatches[mentionIndex] !== undefined)) return
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault()
    event.stopImmediatePropagation()
    const file = mentionMatches[mentionIndex]
    if (file !== undefined) insertMention(file.path)
    else if (event.key === 'Enter') composer.requestSubmit()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    closeMentionMenu()
  }
}, true)

const mentionMenu = document.createElement('div')
mentionMenu.className = 'popover mention-menu'
mentionMenu.setAttribute('role', 'listbox')
mentionMenu.setAttribute('aria-label', 'Project files')
mentionMenu.hidden = true
composer.append(mentionMenu)
let mentionFiles: Array<{ path: string }> = []
let mentionQuery = ''
let mentionIndex = 0
let mentionTimer = 0
let mentionProject = ''

function closeMentionMenu(): void {
  mentionMenu.hidden = true
  mentionIndex = 0
}

function markMentionCurrent(): void {
  const rows = [...mentionMenu.querySelectorAll<HTMLButtonElement>('button.row')]
  rows.forEach((row, index) => {
    const current = index === mentionIndex
    row.classList.toggle('current', current)
    row.setAttribute('aria-selected', String(current))
  })
}

function insertMention(path: string): void {
  const token = mentionToken(message.value, message.selectionStart)
  if (token === null) {
    closeMentionMenu()
    return
  }
  const start = message.selectionStart - token.length - 1
  message.setRangeText(`@${path} `, start, message.selectionStart, 'end')
  closeMentionMenu()
  message.dispatchEvent(new Event('input', { bubbles: true }))
  message.focus()
}

function mentionRow(file: { path: string }): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'row'
  button.setAttribute('role', 'option')
  button.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 20 20"><use href="#file-icon"/></svg>')
  const name = document.createElement('span')
  const marks = new Set(mentionMarks(file.path, mentionQuery))
  const caret = document.createElement('kbd')
  caret.className = 'rtn'
  caret.textContent = 'Enter'
  for (const [index, character] of [...file.path].entries()) {
    if (marks.has(index)) {
      const bold = document.createElement('b')
      bold.textContent = character
      name.append(bold)
    } else {
      name.append(character)
    }
  }
  button.append(name, caret)
  button.onclick = () => insertMention(file.path)
  return button
}

function paintMentionMenu(matches: ReadonlyArray<{ path: string }>): void {
  const nodes: HTMLElement[] = []
  if (matches.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'row muted'
    empty.textContent = mentionQuery === '' ? 'No files in this project yet' : `Nothing matches ${mentionQuery}`
    nodes.push(empty)
  } else {
    const label = document.createElement('div')
    label.className = 'group-label'
    const scope = document.createElement('span')
    scope.textContent = `Files in ${mentionProject === '' ? 'this project' : mentionProject}`
    const count = document.createElement('span')
    count.textContent = `${matches.length} match${matches.length === 1 ? '' : 'es'}`
    label.append(scope, count)
    nodes.push(label, ...matches.map(mentionRow))
  }
  mentionMenu.replaceChildren(...nodes)
  mentionMenu.hidden = false
  mentionIndex = 0
  markMentionCurrent()
}

async function loadMentionFiles(query: string): Promise<void> {
  const result = await getJson(`/api/chat/files?root=${encodeURIComponent(root ?? '')}&q=${encodeURIComponent(query)}`)
  if (!result.ok) return
  const payload = result.data as { files?: unknown; project?: unknown }
  mentionFiles = (readArray(payload.files) as unknown as Array<{ path: string }>).filter(file => typeof file.path === 'string')
  mentionProject = typeof payload.project === 'string' ? payload.project : ''
  paintMentionMenu(mentionFiles)
}

function updateMentionMenu(): void {
  const token = mentionToken(message.value, message.selectionStart)
  if (token === null) {
    closeMentionMenu()
    return
  }
  mentionQuery = token
  clearTimeout(mentionTimer)
  mentionTimer = window.setTimeout(() => { void loadMentionFiles(token) }, 120)
  paintMentionMenu(mentionFiles)
}

message.addEventListener('input', () => updateMentionMenu())

send.addEventListener('click', event => {
  if (send.dataset.mode !== 'stop') return
  event.preventDefault()
  void stopReply()
})
message.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !running || document.querySelector('.popover:not([hidden])') !== null) return
  event.preventDefault()
  void stopReply()
})

addEventListener('quiet:chat-agents', (event) => outcomes.setSource(`chat=${encodeURIComponent((event as CustomEvent<string>).detail)}`))
addEventListener('quiet:new-chat', () => { clearEasterEgg(); outcomes.setSource(null); liveShown.clear(); liveRendered = new WeakMap(); root = null; agents = []; shownTurns = []; threadVersions = {}; branchPoints = []; pendingFrom = null; paintComposerBanner(); closeLiveText(); messages.replaceChildren(); paintQueue([]); setRunning(false); stopPolling(); setUrl(null); delete document.body.dataset.chat; delete document.body.dataset.chatEngine; dispatchEvent(new CustomEvent('quiet:activity-scope', { detail: null })) })
addEventListener('quiet:open-chat', (event) => openChat((event as CustomEvent<string>).detail))
addEventListener('quiet:show', (event) => { if ((event as CustomEvent<string>).detail === 'conversation') schedule(); else stopPolling() })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(); else stopPolling() })

const providersReady = getJson('/api/providers').then(result => {
  if (result.ok) providers = (readArray(result.data.providers) as unknown as LaunchProvider[]).filter(item => typeof item.id === 'string')
})
addEventListener('quiet:screen', (event) => { if ((event as CustomEvent<string>).detail === 'history') void pollJobs() })
void pollJobs()
const initial = new URLSearchParams(location.search).get('chat')
if (initial) openChat(initial)
