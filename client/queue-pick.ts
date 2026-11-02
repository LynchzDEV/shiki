import { renderMarkdown } from './markdown'
import { el, icon, type QueueItemView } from './queue-view'
import { errorText, postJson } from './shared'

export type PickDialog = { open(item: QueueItemView): void }

const NO_MOCKUP = "Mockup files not found in this item's workspace"
const ROOT = 'visualizer/'

export const mockupUrl = (id: string, path: string): string =>
  `/queue/${encodeURIComponent(id)}/files/${path.slice(ROOT.length).split('/').map(encodeURIComponent).join('/')}/index.html`

export function createPickDialog(toast: (text: string) => void): PickDialog {
  const stage = el('div', { class: 'q-pick-stage' })
  const summary = el('div', { class: 'q-pick-summary md' })
  const asked = el('div', { class: 'q-pick-asked' })
  const tester = el('input', { name: 'tester', placeholder: 'Who to tag', autocomplete: 'off', maxlength: '200' }) as HTMLInputElement
  const note = el('textarea', { name: 'note', rows: '2', placeholder: 'Optional note for the next run', maxlength: '4000' }) as HTMLTextAreaElement
  const options = el('div', { class: 'q-pick-options' })
  const error = el('p', { class: 'q-add-error', role: 'alert', hidden: true })
  const title = el('h2', { id: 'queue-pick-title' }, 'Pick a variant')
  const close = el('button', { type: 'submit', class: 'round', 'aria-label': 'Close' }, icon('close-icon'))
  const dialog = el('dialog', { class: 'access-dialog flat q-pick', 'aria-labelledby': 'queue-pick-title' },
    el('header', { class: 'dialog-heading' }, el('div', {}, title, el('p', { class: 'muted' }, 'Choose the design to build. Nothing is posted to the source.')), el('form', { method: 'dialog' }, close)),
    stage, summary, asked,
    el('div', { class: 'field-stack' }, el('label', { class: 'mk-field' }, 'Tag on ClickUp', tester), el('label', { class: 'mk-field' }, 'Note', note)),
    error, options) as HTMLDialogElement

  const showError = (text: string): void => { error.textContent = text; error.hidden = text === '' }

  async function showMockup(id: string, path: string): Promise<void> {
    const src = mockupUrl(id, path)
    const found = await fetch(src).then(response => response.ok, () => false)
    if (!dialog.open) return
    stage.replaceChildren(found ? el('iframe', { class: 'q-pick-frame', sandbox: 'allow-scripts', src, title: 'Mockup' }) : el('p', { class: 'muted q-status' }, NO_MOCKUP))
  }

  async function choose(item: QueueItemView, option: string): Promise<void> {
    const buttons = [...options.querySelectorAll('button')]
    for (const button of buttons) button.setAttribute('disabled', '')
    showError('')
    const result = await postJson(`/api/queue/${encodeURIComponent(item.id)}/pick`, { option, tester: tester.value.trim(), note: note.value.trim() })
    for (const button of buttons) button.removeAttribute('disabled')
    if (!result.ok) { showError(errorText(result)); return }
    dialog.close()
    toast(`Picked ${option} for ${item.title}`)
  }

  return {
    open(item): void {
      const pick = item.pick
      if (pick === undefined) return
      title.textContent = item.title
      stage.replaceChildren(el('p', { class: 'muted q-status' }, 'Loading the mockup…'))
      summary.replaceChildren(renderMarkdown(pick.summary))
      asked.replaceChildren(...(item.questions.length === 0 ? [] : [el('strong', {}, 'Also asked'), el('ul', {}, ...item.questions.map(question => el('li', {}, question)))]))
      tester.value = pick.tester ?? ''
      note.value = ''
      showError('')
      options.replaceChildren(...pick.options.map((option) => {
        const recommended = option === pick.recommended
        const button = el('button', { type: 'button', class: recommended ? 'connection-button primary' : 'connection-button', 'data-option': option }, recommended ? `${option} (recommended)` : option)
        button.addEventListener('click', () => { void choose(item, option) })
        return button
      }))
      if (!dialog.isConnected) document.body.append(dialog)
      dialog.showModal()
      void showMockup(item.id, pick.path)
    },
  }
}
