import { renderMarkdown } from './markdown'
import { createDecide, inline, NO_PICK, optionsOf, type Decide } from './queue-review-decide'
import { parsePickSummary, type ParsedSummary } from './queue-review-parse'
import { renderPoints, type PointsView } from './queue-review-points'
import { createPreview, type Preview } from './queue-review-preview'
import { el, icon, type QueueItemView } from './queue-view'
import { errorText, postJson } from './shared'

export type PickReview = { open(item: QueueItemView): void }

const SPY_OFFSET = 120

const show = (screen: string): void => { dispatchEvent(new CustomEvent('quiet:show', { detail: screen })) }

function summarySection(item: QueueItemView, parsed: ParsedSummary): HTMLElement {
  const section = el('section', { id: 'summary' }, el('h3', { class: 'pk-h' }, 'Summary'))
  if (!parsed.structured) {
    section.append(el('div', { class: 'md pk-md' }, renderMarkdown(parsed.markdown)))
    return section
  }
  const recommended = item.pick?.recommended ?? parsed.recommendation?.option ?? null
  if (recommended !== null || parsed.recommendation !== null) {
    section.append(el('div', { class: 'mk-ctx pk-rec' },
      el('span', {}, icon('rec-icon')),
      el('strong', {}, recommended === null ? 'Recommendation' : `Recommended: ${recommended}`),
      ...(parsed.recommendation === null ? [] : [el('p', {}, ...inline(parsed.recommendation.reason))])))
  }
  if (parsed.facts.length > 0) {
    section.append(el('div', { class: 'pk-stats' }, ...parsed.facts.map(fact =>
      el('span', { class: 'pill pk-stat' }, el('strong', {}, fact.value), ...(fact.label === '' ? [] : [el('span', { class: 'muted' }, fact.label)])))))
  }
  for (const extra of parsed.extra) {
    section.append(...(extra.heading === '' ? [] : [el('h4', { class: 'pk-h' }, extra.heading)]), el('div', { class: 'md pk-md' }, renderMarkdown(extra.markdown)))
  }
  return section
}

function pointsSection(points: PointsView): HTMLElement {
  const note = points.total === 0 ? '' : `(${points.total} · ${points.decisions} need${points.decisions === 1 ? 's' : ''} a decision)`
  return el('section', { id: 'points' }, el('h3', { class: 'pk-h' }, 'Points', ...(note === '' ? [] : [' ', el('span', { class: 'muted' }, note)])), points.body)
}

function spy(scroller: HTMLElement, links: HTMLElement[]): void {
  scroller.addEventListener('scroll', () => {
    let current: string | null = null
    for (const section of scroller.querySelectorAll('section[id]')) {
      if (section.getBoundingClientRect().top - scroller.getBoundingClientRect().top < SPY_OFFSET) current = section.id
    }
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) current = 'decide'
    for (const link of links) {
      const active = link.dataset.goto === (current ?? links[0]?.dataset.goto)
      link.classList.toggle('on', active)
      if (active) link.setAttribute('aria-current', 'true'); else link.removeAttribute('aria-current')
    }
  })
}

export function createPickReview(toast: (text: string) => void): PickReview {
  const screen = document.getElementById('queue-review')
  let preview: Preview | null = null
  let opened = 0

  function leave(): void {
    preview?.dispose()
    preview = null
    show('queue')
  }

  addEventListener('quiet:screen', (event) => {
    if ((event as CustomEvent<string>).detail !== 'queue-review') preview?.closeViewer()
  })

  return {
    open(item): void {
      const pick = item.pick
      if (pick === undefined || screen === null) return
      preview?.dispose()
      const token = ++opened
      const parsed = parsePickSummary(pick.summary, pick.options)
      const points = parsed.structured && parsed.points !== null ? renderPoints(parsed.points) : null
      const options = optionsOf(item, parsed)
      let decide: Decide
      const buildLabel = (id: string): string => (id === NO_PICK ? 'Ask for new designs' : `Build with ${id}`)
      const headerBuild = el('button', { type: 'button', class: 'connection-button primary pk-build pk-build-sm' }) as HTMLButtonElement

      let current: Preview
      function select(id: string): void {
        decide.setSelected(id)
        headerBuild.textContent = decide.buildButton.textContent = buildLabel(id)
        if (id !== NO_PICK) current.show(id.toLowerCase())
      }
      decide = createDecide({ item, parsed, onSelect: select, onBuild: () => { void build() } })
      current = createPreview({ itemId: item.id, path: pick.path, options, recommended: pick.recommended, selected: () => decide.selected(), choose: select })
      preview = current
      headerBuild.textContent = decide.buildButton.textContent = buildLabel(decide.selected())
      headerBuild.addEventListener('click', () => { void build() })

      async function build(): Promise<void> {
        if (decide.isNone() && decide.feedback.value.trim() === '') { decide.setError('Say what should change'); decide.feedback.focus(); return }
        const buttons = [headerBuild, decide.buildButton]
        for (const button of buttons) button.disabled = true
        decide.setError('')
        const body = decide.payload()
        back.setAttribute('aria-disabled', 'true')
        const result = await postJson(`/api/queue/${encodeURIComponent(item.id)}/pick`, body)
        for (const button of buttons) button.disabled = false
        back.removeAttribute('aria-disabled')
        if (!result.ok) { if (token === opened) decide.setError(errorText(result)); return }
        if (token === opened && !screen!.hidden) leave()
        toast(body.option === NO_PICK ? `Asked for new designs for ${item.title}` : `Picked ${body.option} for ${item.title}`)
      }

      const sections = [
        { id: 'summary', label: 'Summary', node: summarySection(item, parsed) },
        ...(points === null ? [] : [{ id: 'points', label: 'Points', node: pointsSection(points) }]),
        { id: 'decide', label: 'Decide', node: decide.section },
      ]
      const links = sections.map((entry, index) => el('a', { href: `#${entry.id}`, 'data-goto': entry.id, ...(index === 0 ? { class: 'on', 'aria-current': 'true' } : {}) }, el('span', {}, String(index + 1)), entry.label))
      const nav = el('nav', { class: 'pk-nav', 'aria-label': 'Sections' }, ...links)
      nav.addEventListener('click', (event) => {
        const link = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-goto]') : null
        if (link === null) return
        event.preventDefault()
        decide.section.ownerDocument.getElementById(link.dataset.goto ?? '')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      })
      const left = el('div', { class: 'pk-d-left', 'data-spy': true }, nav, el('div', { class: 'pk-main' }, ...sections.map(entry => entry.node)))
      spy(left, links)

      const title = el('h1', { id: 'queue-pick-title', tabindex: '-1' }, item.title)
      const back = el('a', { class: 'flow-back', href: '#' }, '← Queue')
      back.addEventListener('click', (event) => { event.preventDefault(); if (!back.hasAttribute('aria-disabled')) leave() })
      const header = el('header', { class: 'studio-heading pk-d-head' },
        el('div', {}, back, title, el('p', { class: 'muted' }, 'Choose the design to build. Nothing is posted to the source.')),
        el('div', { class: 'pk-head-acts' }, headerBuild))

      screen.replaceChildren(el('div', { class: 'pk-d' }, header, el('div', { class: 'pk-d-body' }, left, current.pane)), current.viewer)
      show('queue-review')
      title.focus()
    },
  }
}
