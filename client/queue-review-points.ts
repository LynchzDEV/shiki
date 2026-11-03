import { renderMarkdown } from './markdown'
import { el } from './queue-view'

const DECISION = /decision needed/i

export type PointsView = { body: DocumentFragment; total: number; decisions: number }

function markDecision(cell: Element): void {
  const pill = el('span', { class: 'pill-state', 'data-s': 'needs' }, 'Decision needed')
  for (const node of [...cell.childNodes]) {
    const text = node.nodeType === 3 ? node.textContent ?? '' : ''
    const match = DECISION.exec(text)
    if (match === null) continue
    node.replaceWith(text.slice(0, match.index), pill, text.slice(match.index + match[0].length))
    return
  }
  cell.prepend(pill, ' ')
}

export function renderPoints(markdown: string): PointsView {
  const body = renderMarkdown(markdown)
  const table = body.querySelector('table')
  if (table === null) return { body, total: 0, decisions: 0 }
  table.className = 'md-table pk-points'
  const headers = [...table.querySelectorAll('thead th')]
  const fixAt = headers.findIndex(header => /^fix\b/i.test(header.textContent ?? ''))
  const fixIndex = fixAt >= 0 ? fixAt : headers.length - 1
  const rows = [...table.querySelectorAll('tbody tr')]
  let decisions = 0
  for (const row of rows) {
    const cell = row.children[fixIndex]
    if (cell === undefined || !DECISION.test(cell.textContent ?? '')) continue
    decisions += 1
    row.setAttribute('data-decision', '')
    markDecision(cell)
  }
  for (const note of body.children) if (note.tagName === 'P') note.className = 'pk-foot-note'
  return { body, total: rows.length, decisions }
}
