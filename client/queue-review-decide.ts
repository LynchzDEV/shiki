import { renderMarkdown } from './markdown'
import type { OpenChoice, ParsedSummary, ReviewOption } from './queue-review-parse'
import { mockupUrl } from './queue-review-preview'
import { el, type QueueItemView } from './queue-view'

export const NO_PICK = 'none'
export type PickPayload = { option: string; tester: string; note: string; answers?: Array<{ id: string; label: string; answer: string; useDefault: boolean }>; feedback?: string }
export type Decide = {
  section: HTMLElement
  buildButton: HTMLButtonElement
  selected(): string
  isNone(): boolean
  feedback: HTMLTextAreaElement
  setSelected(id: string): void
  payload(): PickPayload
  setError(text: string): void
}
type DecideConfig = { item: QueueItemView; parsed: ParsedSummary; onSelect(id: string): void; onBuild(): void }

const MAX_ID = 16
const MAX_LABEL = 200
const MAX_ANSWER = 1000
const MAX_FEEDBACK = 4000

export function inline(markdown: string): Node[] {
  const paragraph = renderMarkdown(markdown).firstElementChild
  return paragraph === null ? [document.createTextNode(markdown)] : [...paragraph.childNodes]
}

export function optionsOf(item: QueueItemView, parsed: ParsedSummary): ReviewOption[] {
  const described = parsed.structured ? parsed.options : []
  return (item.pick?.options ?? []).map(id => described.find(entry => entry.id === id) ?? { id, subtitle: '', description: '' })
}

function optionCard(item: QueueItemView, option: ReviewOption, described: boolean, recommended: boolean, checked: boolean): HTMLElement {
  const lower = option.id.toLowerCase()
  const thumb = el('img', { src: mockupUrl(item.id, item.pick?.path ?? '', `renders/${lower}.png`), alt: `Render of option ${option.id}` })
  thumb.addEventListener('error', () => thumb.setAttribute('data-broken', ''))
  const heading = el('span', { class: 'pk-opt-t' }, el('strong', {}, described ? option.id : `Option ${option.id}`), ...(recommended ? [el('span', { class: 'mk-tag' }, 'Recommended')] : []))
  const text = el('span', { class: 'pk-opt-text' }, heading,
    ...(option.subtitle === '' ? [] : [el('span', { class: 'pk-opt-sub' }, option.subtitle)]),
    ...(option.description === '' ? [] : [el('span', { class: 'pk-opt-d' }, ...inline(option.description))]))
  return el('label', { class: 'mk-card pk-opt' }, el('input', { type: 'radio', name: 'option', value: option.id, checked }), thumb, text)
}

function noneCard(checked: boolean): HTMLElement {
  const text = el('span', { class: 'pk-opt-text' }, el('span', { class: 'pk-opt-t' }, el('strong', {}, 'None of these')), el('span', { class: 'pk-opt-sub' }, 'Ask for new designs'))
  return el('label', { class: 'mk-card pk-opt pk-none' }, el('input', { type: 'radio', name: 'option', value: NO_PICK, checked }), text)
}

function openFieldset(choice: OpenChoice, index: number): HTMLElement {
  const group = `open-${index}`
  const useDefault = el('input', { type: 'radio', name: group, value: 'default', checked: true })
  const useOther = el('input', { type: 'radio', name: group, value: 'other' })
  const other = el('input', { type: 'text', name: `${group}-other`, placeholder: choice.hint === '' ? 'Your choice' : `e.g. ${choice.hint}`, maxlength: String(MAX_LABEL), 'aria-label': `Other choice for ${choice.id}`, disabled: true }) as HTMLInputElement
  const sync = (): void => {
    other.disabled = !(useOther as HTMLInputElement).checked
    if (!other.disabled) other.focus()
  }
  useDefault.addEventListener('change', sync)
  useOther.addEventListener('change', sync)
  return el('fieldset', { class: 'q-repos pk-open', 'data-open': choice.id },
    el('legend', {}, choice.label === '' ? choice.id : `${choice.id} ${choice.label}`),
    el('label', { class: 'pk-radio' }, useDefault, el('span', {}, choice.default === '' ? 'Use default' : `Use default: ${choice.default}`)),
    el('label', { class: 'pk-radio pk-other' }, useOther, el('span', {}, 'Other:'), other))
}

const heading = (level: 'h3' | 'h4', text: string, note = ''): HTMLElement => el(level, { class: 'pk-h' }, text, ...(note === '' ? [] : [' ', el('span', { class: 'muted' }, note)]))

export function createDecide({ item, parsed, onSelect, onBuild }: DecideConfig): Decide {
  const pick = item.pick!
  const options = optionsOf(item, parsed)
  const open = parsed.structured ? parsed.open : []
  const selectedId = pick.recommended ?? pick.options[0] ?? ''
  const described = (id: string): boolean => parsed.structured && parsed.options.some(entry => entry.id === id)

  const radios = el('div', { class: 'pk-opts', role: 'radiogroup', 'aria-label': 'Design to build' },
    ...options.map(option => optionCard(item, option, described(option.id), option.id === pick.recommended, option.id === selectedId)),
    noneCard(selectedId === NO_PICK))
  const radioOf = (id: string): HTMLInputElement | undefined => [...radios.querySelectorAll<HTMLInputElement>('input')].find(input => input.value === id)
  const feedback = el('textarea', { id: 'queue-review-feedback', name: 'feedback', rows: '4', placeholder: "e.g. keep B's table but put it in the drawer, and drop the badge", maxlength: String(MAX_FEEDBACK) }) as HTMLTextAreaElement
  const feedbackBox = el('div', { class: 'pk-field pk-feedback', 'data-feedback': true, hidden: true }, el('div', { class: 'pk-lbl' }, el('label', { for: 'queue-review-feedback' }, 'What should change?')), feedback)
  const openWrap = el('div', { 'data-open-wrap': true })
  const isNone = (): boolean => radios.querySelector<HTMLInputElement>('input:checked')?.value === NO_PICK
  const sync = (): void => { feedbackBox.hidden = !isNone(); openWrap.hidden = isNone() }
  radios.addEventListener('change', (event) => { sync(); if (event.target instanceof HTMLInputElement) onSelect(event.target.value) })

  const fieldsets = open.map(openFieldset)
  const defaults = el('span', { 'data-defaults': true })
  const countDefaults = (): void => {
    const n = fieldsets.filter(fieldset => fieldset.querySelector<HTMLInputElement>('input[value=default]')?.checked === true).length
    defaults.textContent = open.length === 0 ? '' : n === 0 ? 'All open choices answered' : `${n} open ${n === 1 ? 'choice uses its default' : 'choices use defaults'}`
  }
  for (const fieldset of fieldsets) fieldset.addEventListener('change', countDefaults)
  countDefaults()

  const tester = el('input', { id: 'queue-review-tester', name: 'tester', placeholder: 'Who to tag', autocomplete: 'off', maxlength: '200', value: pick.tester ?? '' }) as HTMLInputElement
  const note = el('textarea', { id: 'queue-review-note', name: 'note', rows: '3', placeholder: 'Optional note for the next run', maxlength: '4000' }) as HTMLTextAreaElement
  const chips = parsed.structured ? parsed.tags.map(tag => el('button', { type: 'button', class: 'chip', 'data-tag': tag.name }, tag.name, ...(tag.role === 'watcher' ? [' ', el('span', { class: 'pk-role' }, 'watcher')] : []))) : []
  const chipRow = chips.length === 0 ? [] : [el('div', { class: 'pk-chips' }, ...chips)]
  for (const chip of chips) chip.addEventListener('click', () => {
    tester.value = tester.value.trim() === '' ? chip.dataset.tag ?? '' : `${tester.value.replace(/,?\s*$/, ', ')}${chip.dataset.tag ?? ''}`
    tester.focus()
  })

  const error = el('p', { class: 'q-add-error', role: 'alert', hidden: true })
  const buildButton = el('button', { type: 'button', class: 'connection-button primary pk-build' }) as HTMLButtonElement
  buildButton.addEventListener('click', onBuild)

  const outOfScope = parsed.structured && parsed.outOfScope.length > 0
    ? [heading('h4', 'Out of scope', `(${parsed.outOfScope.length}) · not in this fix`), el('ul', { class: 'md-list pk-oos' }, ...parsed.outOfScope.map(entry => el('li', {}, ...inline(entry))))]
    : []
  if (open.length > 0) openWrap.append(heading('h4', 'Still open', '· your call, my default if you say nothing'), el('div', { class: 'pk-open-grid' }, ...fieldsets))
  const section = el('section', { id: 'decide' },
    heading('h3', 'Decide'),
    radios,
    feedbackBox,
    openWrap,
    ...(item.questions.length === 0 ? [] : [heading('h4', 'Also asked'), el('ul', { class: 'md-list pk-oos pk-asked' }, ...item.questions.map(question => el('li', {}, question)))]),
    ...outOfScope,
    el('div', { class: 'pk-d-fields' },
      el('div', { class: 'pk-field pk-tag' }, el('div', { class: 'pk-lbl' }, el('label', { for: 'queue-review-tester' }, 'Tag on ClickUp'), el('small', {}, 'Who to @mention when it reaches UAT')), tester, ...chipRow),
      el('div', { class: 'pk-field pk-note' }, el('div', { class: 'pk-lbl' }, el('label', { for: 'queue-review-note' }, 'Note ', el('span', { class: 'pk-opt-l' }, 'optional')), el('small', {}, 'Goes to the build run')), note)),
    el('div', { class: 'pk-d-final' }, error, el('span', { class: 'pk-defaults' }, defaults), buildButton))

  return {
    section,
    buildButton,
    isNone,
    feedback,
    selected: () => radios.querySelector<HTMLInputElement>('input:checked')?.value ?? selectedId,
    setSelected(id): void {
      const radio = radioOf(id)
      if (radio) radio.checked = true
      sync()
    },
    payload() {
      if (isNone()) return { option: NO_PICK, feedback: feedback.value.trim(), tester: tester.value.trim(), note: note.value.trim() }
      const answers = open.map((choice, index) => {
        const other = fieldsets[index]!.querySelector<HTMLInputElement>('input[type=text]')!
        const custom = fieldsets[index]!.querySelector<HTMLInputElement>('input[value=other]')!.checked ? other.value.trim() : ''
        return { id: choice.id.slice(0, MAX_ID), label: choice.label.slice(0, MAX_LABEL), answer: custom.slice(0, MAX_ANSWER), useDefault: custom === '' }
      })
      return { option: this.selected(), tester: tester.value.trim(), note: note.value.trim(), answers }
    },
    setError(text): void { error.textContent = text; error.hidden = text === '' },
  }
}
