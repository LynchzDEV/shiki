import { renderMarkdown } from './markdown'
import { errorText, postJson, readRecord, type ApiResult } from './shared'
import { el, icon, readQueueItems, stageLabel, type QueueItemView } from './queue-view'

const LOG_POLL_MS = 5000

export type LandDialogs = {
  confirm(itemId: string): void
  log(itemId: string): void
  report(itemId: string): void
}

type Shell = { dialog: HTMLDialogElement; body: HTMLElement; error: HTMLElement; foot: HTMLElement; setTitle(text: string): void; fail(text: string): void }

const itemUrl = (id: string): string => `/api/queue/${encodeURIComponent(id)}`

async function fetchText(url: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(url)
    const text = await response.text()
    if (response.ok) return { ok: true, text }
    const message = readRecord(JSON.parse(text.startsWith('{') ? text : '{}')).error
    return { ok: false, error: typeof message === 'string' ? message : `request failed (${response.status})` }
  } catch {
    return { ok: false, error: 'server unreachable' }
  }
}

function shell(title: string, onClose: () => void): Shell {
  const heading = el('h2', {}, title)
  const body = el('div', { class: 'q-land-body' })
  const error = el('p', { class: 'q-add-error', role: 'alert', hidden: true })
  const foot = el('footer', { class: 'q-add-foot' })
  const close = el('button', { type: 'submit', class: 'round', 'aria-label': 'Close' }, icon('close-icon'))
  const dialog = el('dialog', { class: 'access-dialog flat q-add q-land' },
    el('header', { class: 'dialog-heading' }, el('div', {}, heading), el('form', { method: 'dialog' }, close)),
    body, error, foot) as HTMLDialogElement
  dialog.addEventListener('close', () => { onClose(); dialog.remove() })
  document.body.append(dialog)
  dialog.showModal()
  return {
    dialog, body, error, foot,
    setTitle: (text) => { heading.textContent = text },
    fail: (text) => { error.textContent = text; error.hidden = text === '' },
  }
}

function showResult(view: Shell, result: ApiResult): boolean {
  view.fail(result.ok ? '' : errorText(result))
  return result.ok
}

export function createLandDialogs(items: () => readonly QueueItemView[], toast: (text: string) => void): LandDialogs {
  const find = (id: string): QueueItemView | undefined => items().find(item => item.id === id)

  function confirm(itemId: string): void {
    const start = find(itemId)
    if (start?.land === undefined) { toast('That item is not waiting for a stage'); return }
    const stage = start.land.stage
    const label = stageLabel(start.land, stage)
    const refresh = el('button', { type: 'button', class: 'connection-button' }, 'Refresh') as HTMLButtonElement
    const go = el('button', { type: 'button', class: 'connection-button primary' }, 'Confirm') as HTMLButtonElement
    const cancel = el('button', { type: 'button', class: 'connection-button' }, 'Cancel')
    let latest: QueueItemView | undefined
    const onItems = (): void => { latest = undefined; paint() }
    const view = shell(label, () => removeEventListener('quiet:queue-items', onItems))
    view.foot.append(refresh, el('span', { class: 'sp' }), cancel, go)

    function paint(): void {
      const item = latest ?? find(itemId)
      const flight = item?.land?.stages[stage]?.preflight
      view.body.replaceChildren()
      if (item === undefined || item.state !== 'awaiting-stage' || item.land?.stage !== stage) {
        view.body.append(el('p', { class: 'muted' }, `This item is ${item?.state ?? 'gone'} now, so ${label} cannot be started from here.`))
        go.disabled = true
        return
      }
      const blocked = flight !== undefined && flight.exitCode !== 0
      if (blocked) view.body.append(el('p', { class: 'q-land-blocked', role: 'status' }, `The preflight blocked this stage (exit ${flight.exitCode}). Fix what it reports, then Refresh.`))
      if (flight === undefined || flight.markdown.trim() === '') view.body.append(el('p', { class: 'muted' }, 'The preflight printed nothing to review.'))
      else view.body.append(el('div', { class: 'q-land-md' }, renderMarkdown(flight.markdown)))
      go.disabled = blocked
    }
    paint()
    addEventListener('quiet:queue-items', onItems)

    const busy = async (button: HTMLButtonElement, work: () => Promise<ApiResult>, done?: () => void): Promise<void> => {
      refresh.disabled = true
      button.disabled = true
      const result = await work()
      refresh.disabled = false
      go.disabled = false
      if (showResult(view, result)) { latest = readQueueItems([result.data.item])[0]; done?.() }
      paint()
    }
    refresh.addEventListener('click', () => { void busy(refresh, () => postJson(`${itemUrl(itemId)}/land/${encodeURIComponent(stage)}/preflight`, {})) })
    go.addEventListener('click', () => { void busy(go, () => postJson(`${itemUrl(itemId)}/land/${encodeURIComponent(stage)}/start`, { confirm: true }), () => { view.dialog.close(); toast(`Started ${label}`) }) })
    cancel.addEventListener('click', () => view.dialog.close())
  }

  function log(itemId: string): void {
    const item = find(itemId)
    const stage = item?.land?.stage
    if (item?.land === undefined || stage === undefined) { toast('That item has no stage log yet'); return }
    let timer: ReturnType<typeof setInterval> | undefined
    const view = shell(`${stageLabel(item.land, stage)} log`, () => clearInterval(timer))
    const output = el('pre', { class: 'q-land-log' }, 'Loading…')
    view.body.append(output)
    async function load(): Promise<void> {
      const result = await fetchText(`${itemUrl(itemId)}/land/${encodeURIComponent(stage!)}/log`)
      view.fail(result.ok ? '' : result.error)
      if (!result.ok) return
      const stuck = output.scrollHeight - output.scrollTop - output.clientHeight < 24
      output.textContent = result.text === '' ? '(nothing printed yet)' : result.text
      if (stuck) output.scrollTop = output.scrollHeight
    }
    void load()
    timer = setInterval(() => { void load() }, LOG_POLL_MS)
  }

  function report(itemId: string): void {
    const item = find(itemId)
    const view = shell(item === undefined ? 'Report' : `Report: ${item.title}`, () => {})
    view.body.append(el('p', { class: 'muted' }, 'Loading…'))
    void fetchText(`${itemUrl(itemId)}/report`).then((result) => {
      view.fail(result.ok ? '' : result.error)
      view.body.replaceChildren(...(result.ok ? [el('div', { class: 'q-land-md' }, renderMarkdown(result.text))] : []))
    })
  }

  return { confirm, log, report }
}
