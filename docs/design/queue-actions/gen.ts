import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'

const root = join(import.meta.dir, '..', '..', '..')
const out = import.meta.dir
const { window } = new JSDOM('<body></body>')
Object.assign(globalThis, { window, document: window.document })
const view = await import('../../../client/queue-view')
const { el, icon, renderQueue, readQueueItems } = view

const NOW = Date.UTC(2026, 10, 4, 9, 30)
const min = 60_000
const base = { source: 'clickup-board', url: 'https://app.clickup.com/t/x', flowId: 'fixstack', questions: [], error: null, repo: '/home/lynchz/Work/klangtech/api' }
const plan = [{ id: 'uat', label: 'Deploy UAT' }, { id: 'prod', label: 'Deploy prod' }]
const raw = [
  { ...base, id: 'b1', externalId: '86d3k1a2b', title: 'Moni export: filter by call result', state: 'building', runIds: ['r1'], currentRunId: 'r1', updatedAt: NOW - 12 * min, step: { title: 'Review', attempt: 2, maxAttempts: 3 } },
  { ...base, id: 'l1', externalId: '86d3k1a2c', title: 'Army settings: show export columns', state: 'landing', runIds: ['r2'], updatedAt: NOW - 3 * min, land: { stage: 'uat', runId: 'r2', message: 'Deploying to UAT…', plan, stages: { uat: { status: 'running' } } } },
  { ...base, id: 'q1', externalId: '86d3k1a2d', title: 'Backoffice: add tax ID to invoice', state: 'queued', runIds: [], updatedAt: NOW - 20 * min, preparing: true },
  { ...base, id: 'q2', externalId: '86d3k1a2e', title: 'Bulk import contacts from CSV', state: 'queued', runIds: [], updatedAt: NOW - 25 * min },
  { ...base, id: 'p1', externalId: '86d3k1a2f', title: 'Invoice PDF footer', state: 'waiting-pick', runIds: ['r3'], updatedAt: NOW - 40 * min, pick: { options: ['A', 'B', 'C'], path: 'x', recommended: 'B', tester: null, summary: '' } },
  { ...base, id: 'w1', externalId: '86d3k1a2g', title: 'Kood queue: retry failed sends', state: 'waiting-info', runIds: ['r4'], updatedAt: NOW - 5 * 60 * min, questions: ['Which sends count as failed?', 'Retry how many times?'] },
  { ...base, id: 'r1', externalId: '86d3k1a2h', title: 'Portal: dark mode for settings', state: 'ready', runIds: ['r5'], updatedAt: NOW - 50 * min },
  { ...base, id: 'f1', externalId: '86d3k1a2i', title: 'HerMEZ segment delete', state: 'failed', runIds: ['r6'], resumeRunId: 'r6', updatedAt: NOW - 70 * min, error: 'Stopped by user' },
  { ...base, id: 'a1', externalId: '86d3k1a2j', title: 'Moni Call01 two-layer view', state: 'awaiting-stage', runIds: ['r7'], updatedAt: NOW - 2 * 60 * min, land: { stage: 'prod', runId: 'r7', plan, stages: { uat: { status: 'ok' }, prod: { status: 'waiting' } } } },
  { ...base, id: 'd1', externalId: '86d3k1a2k', title: 'Sidebar: pin chats to the top', state: 'landed', runIds: ['r8'], updatedAt: NOW - 26 * 60 * min, land: { stage: 'prod', runId: 'r8', plan, stages: { uat: { status: 'ok' }, prod: { status: 'ok' } } } },
]
const items = readQueueItems(raw)
const context = { plugins: [{ id: 'clickup-board', name: 'ClickUp board', enabled: true }], flows: [{ id: 'fixstack', name: 'Fixstack' }], now: NOW, checkedAt: NOW - 7 * min, openIds: new Set<string>(), parallel: 2 }

type Extra = { label: string; icon: string; danger?: true; note?: string }
type Spec = { primary: HTMLElement | null; extras: Extra[] }

const LANDING_NOTE = 'A push or deploy cut short can leave the remote half-updated.'
const primaryButton = (label: string, iconId?: string): HTMLElement => el('button', { type: 'button', class: 'connection-button primary' }, ...(iconId ? [icon(iconId)] : []), label)
const report: Extra = { label: 'Report', icon: 'file-icon' }
const openRun: Extra = { label: 'Open run', icon: 'flow-icon' }
const requeue: Extra = { label: 'Requeue', icon: 'mk-refresh' }
const remove: Extra = { label: 'Remove', icon: 'trash-icon', danger: true }
const stop: Extra = { label: 'Stop', icon: 'stop-icon', danger: true }

function spec(id: string): Spec {
  switch (id) {
    case 'b1': return { primary: primaryButton('Watch', 'eye-icon'), extras: [report, stop, remove] }
    case 'l1': return { primary: primaryButton('Log', 'file-icon'), extras: [openRun, report, { ...stop, note: LANDING_NOTE }, remove] }
    case 'q1': return { primary: null, extras: [report, remove] }
    case 'q2': return { primary: null, extras: [report, remove] }
    case 'p1': return { primary: primaryButton('Pick'), extras: [requeue, report, remove] }
    case 'w1': return { primary: null, extras: [requeue, report, remove] }
    case 'r1': return { primary: primaryButton('Open run', 'flow-icon'), extras: [requeue, report, remove] }
    case 'f1': return { primary: primaryButton('Resume', 'mk-refresh'), extras: [{ label: 'Start over', icon: 'back-icon' }, openRun, report, remove] }
    case 'a1': return { primary: primaryButton('Deploy prod'), extras: [openRun, report, remove] }
    default: return { primary: null, extras: [openRun, report, remove] }
  }
}

const menuRow = (extra: Extra): HTMLElement => {
  const row = el('button', { type: 'button', class: extra.danger ? 'row danger' : 'row', role: 'menuitem' }, icon(extra.icon), el('span', {}, extra.label))
  return extra.note ? el('div', { class: 'va-menu-group' }, row, el('p', { class: 'va-note' }, extra.note)) : row
}

function variantA(row: HTMLElement, s: Spec): void {
  const more = el('button', { type: 'button', class: 'va-more is-new', 'aria-label': 'More actions', title: 'More actions', 'aria-expanded': String(row.dataset.id === 'l1') }, icon('more-icon'))
  const acts = el('div', { class: 'q-acts va-acts' }, ...(s.primary ? [s.primary] : []), more)
  if (row.dataset.id === 'l1') {
    const calm = s.extras.filter(extra => !extra.danger)
    const danger = s.extras.filter(extra => extra.danger)
    acts.append(el('div', { class: 'popover row-menu va-menu is-new', role: 'menu' }, ...calm.map(menuRow), el('div', { class: 'divider' }), ...danger.map(menuRow)))
  }
  row.querySelector('.q-acts')!.replaceWith(acts)
}

function variantB(row: HTMLElement, s: Spec): void {
  const id = row.dataset.id
  const tray = el('div', { class: 'va-tray is-new' }, ...s.extras.map((extra) => {
    const armed = id === 'f1' && extra.label === 'Remove'
    const attrs = { type: 'button', class: extra.danger ? 'va-ico danger' : 'va-ico', title: extra.note ? `${extra.label} — ${extra.note}` : extra.label, 'aria-label': extra.label, ...(armed ? { 'data-armed': 'true' } : {}) }
    return el('button', attrs, icon(extra.icon), el('span', {}, extra.label))
  }))
  const acts = el('div', { class: 'q-acts va-acts' }, ...(s.primary ? [s.primary] : []), tray)
  if (id === 'l1' || id === 'f1') row.classList.add('va-hover')
  row.querySelector('.q-acts')!.replaceWith(acts)
}

function variantC(row: HTMLElement, s: Spec): void {
  const open = row.dataset.id === 'l1'
  const toggle = el('button', { type: 'button', class: 'va-toggle is-new', 'aria-expanded': String(open), 'aria-label': 'Show actions', title: 'Show actions' }, icon('chevron-icon'))
  row.querySelector('.q-acts')!.replaceWith(el('div', { class: 'q-acts va-acts' }, ...(s.primary ? [s.primary] : []), toggle))
  if (!open) return
  row.setAttribute('data-open', '')
  const calm = s.extras.filter(extra => !extra.danger).map(extra => el('button', { type: 'button', class: 'text-button' }, icon(extra.icon), extra.label))
  const danger = s.extras.filter(extra => extra.danger).map(extra => el('button', { type: 'button', class: 'text-button q-remove' }, icon(extra.icon), extra.label))
  const note = s.extras.find(extra => extra.note)?.note
  row.append(el('div', { class: 'va-drawer is-new' },
    el('div', { class: 'va-drawer-calm' }, ...calm),
    el('div', { class: 'va-drawer-danger' }, ...(note ? [el('span', { class: 'va-note' }, note)] : []), ...danger)))
}

const shellSource = readFileSync(join(root, 'server/views/shell.ts'), 'utf8')
const sprite = shellSource.slice(shellSource.indexOf('<svg class="symbols"'), shellSource.indexOf('</svg>', shellSource.indexOf('<svg class="symbols"')))
  + '<symbol id="more-icon" viewBox="0 0 20 20"><circle cx="5" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.3" fill="currentColor" stroke="none"/></symbol></svg>'

const PAGES = {
  now: { title: 'NOW — every action is a button', note: 'What ships after the Stop/Remove change: up to five buttons per card.', apply: null },
  a: { title: 'A — one main button + ⋯ menu', note: 'Each card keeps the one button for its next step. Everything else (Open run, Report, Requeue, Stop, Remove) moves into the ⋯ menu, which reuses the sidebar row menu. Shown open on the shipping card.', apply: variantA },
  b: { title: 'B — one main button + icon tray on hover', note: 'The main button stays. The other actions become small icons that show when you hover the card. Stop and Remove grow into a red pill on the first click, like the sidebar ✕. Shown hovered on the shipping and failed cards, with Remove armed on the failed one.', apply: variantB },
  c: { title: 'C — one main button + expand for the rest', note: 'Cards show only the main button and a chevron. Opening a card reveals an action bar: safe actions on the left, Stop and Remove on the right. Shown open on the shipping card.', apply: variantC },
} as const

for (const [name, page] of Object.entries(PAGES)) {
  const screen = renderQueue(items, context)
  if (page.apply !== null) for (const row of screen.querySelectorAll<HTMLElement>('.q-row')) page.apply(row, spec(row.dataset.id!))
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Queue actions ${name.toUpperCase()}</title>
<link rel="stylesheet" href="assets/quiet.css">
<link rel="stylesheet" href="assets/plugins.css">
<link rel="stylesheet" href="variants.css">
</head>
<body class="va-page">
${sprite}
<p class="va-caption"><strong>${page.title}</strong><span>${page.note}</span></p>
<section id="queue" class="studio" aria-label="Queue">${screen.outerHTML}</section>
<footer class="va-foot">Rendered by the real <code>renderQueue</code> in <code>client/queue-view.ts</code> with <code>public/quiet.css</code> + <code>public/plugins.css</code> and the sprite from <code>server/views/shell.ts</code>. Variant markup: <code>docs/design/queue-actions/gen.ts</code>, styles: <code>variants.css</code>.</footer>
<script>const highlight = () => document.body.classList.toggle('hl', location.hash === '#hl'); highlight(); addEventListener('hashchange', highlight)</script>
</body>
</html>
`
  writeFileSync(join(out, `${name}.html`), html)
}
console.log('wrote now.html a.html b.html c.html')
