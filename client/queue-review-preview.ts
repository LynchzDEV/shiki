import { el, icon } from './queue-view'

export type PreviewOption = { id: string; subtitle: string }
export type PreviewConfig = {
  itemId: string
  path: string
  options: PreviewOption[]
  recommended: string | null
  selected: () => string
  choose: (id: string) => void
}
export type Preview = { pane: HTMLElement; viewer: HTMLElement; show(screen: string): void; dispose(): void }

const NO_MOCKUP = "Mockup files not found in this item's workspace"
const ROOT = 'visualizer/'
const MOCKUP_WIDTH = 1256

export const mockupUrl = (id: string, path: string, file: string): string =>
  `/queue/${encodeURIComponent(id)}/files/${path.slice(ROOT.length).split('/').map(encodeURIComponent).join('/')}/${file.split('/').map(encodeURIComponent).join('/')}`

function mockFrame(title: string, className: string, scaled: boolean) {
  const frame = el('iframe', { sandbox: 'allow-scripts', title }) as HTMLIFrameElement
  const missing = el('p', { class: 'muted q-status', hidden: true }, NO_MOCKUP)
  const box = el('div', { class: className }, frame, missing)
  let current = ''
  return {
    box,
    load(url: string): void {
      if (url === current) return
      current = url
      missing.hidden = true
      frame.hidden = false
      frame.src = url
      void fetch(url).then(response => response.ok, () => false).then((found) => {
        if (current !== url || found) return
        frame.hidden = true
        missing.hidden = false
      })
    },
    clear(): void { current = ''; frame.src = 'about:blank' },
    fit(): void {
      if (!scaled || box.clientWidth === 0) return
      const scale = Math.min(1, box.clientWidth / MOCKUP_WIDTH)
      frame.style.width = `${MOCKUP_WIDTH}px`
      frame.style.height = `${box.clientHeight / scale}px`
      frame.style.transform = `scale(${scale})`
    },
  }
}

export function createPreview(config: PreviewConfig): Preview {
  const known = new Set(config.options.map(option => option.id.toLowerCase()))
  const tabs = [{ screen: 'index', label: 'All' }, { screen: 'now', label: 'NOW' }, ...config.options.map(option => ({ screen: option.id.toLowerCase(), label: option.id }))]
  const subtitleOf = (screen: string): string => config.options.find(option => option.id.toLowerCase() === screen)?.subtitle ?? ''
  const nameOf = (screen: string): string => {
    if (screen === 'index') return 'All variants'
    if (screen === 'now') return 'NOW · current screen'
    const id = screen.toUpperCase()
    const subtitle = subtitleOf(screen)
    return `Option ${config.options.find(option => option.id.toLowerCase() === screen)?.id ?? id}${subtitle === '' ? '' : ` · ${subtitle}`}${config.recommended?.toLowerCase() === screen ? ' (recommended)' : ''}`
  }

  let previewing = config.selected().toLowerCase()
  let comparing = false
  const url = (screen: string): string => mockupUrl(config.itemId, config.path, `${screen}.html`)

  const stageFrame = mockFrame('Preview', 'pk-fit', true)
  const nowFrame = mockFrame('NOW', 'pk-fit', true)
  const label = el('strong')
  const nowColumn = el('div', { class: 'pk-d-col', 'data-col': 'now' }, el('strong', {}, 'NOW'), nowFrame.box)
  const pickColumn = el('div', { class: 'pk-d-col', 'data-col': 'pick' }, label, stageFrame.box)
  const stage = el('div', { class: 'pk-d-stage' }, pickColumn)

  const tabButtons = tabs.map(tab => el('button', { type: 'button', 'data-ptab': tab.screen, 'aria-pressed': 'false' }, tab.label))
  const compare = el('button', { type: 'button', class: 'pill', 'data-cmp': true, 'aria-pressed': 'false' }, 'Compare with NOW')
  const fullScreen = el('button', { type: 'button', class: 'pill', 'data-preview': true }, icon('expand-icon'), 'Full screen')
  const caption = el('span', { 'data-cap': true })
  const hintPreviewing = el('strong')
  const hintSelected = el('strong')
  const selectButton = el('button', { type: 'button', class: 'text-button', 'data-select': true })
  const hint = el('span', { 'data-hint': true, hidden: true }, 'Previewing ', hintPreviewing, ' · selected: ', hintSelected, ' — ', selectButton)
  const toolbar = el('div', { class: 'toolbar' },
    el('nav', { 'aria-label': 'Preview' }, el('div', { class: 'mk-seg', role: 'group', 'aria-label': 'Preview' }, ...tabButtons)),
    el('nav', {}, compare, fullScreen))
  const pane = el('div', { class: 'pk-d-right', 'aria-label': 'Mockup preview' }, toolbar, el('p', { class: 'pk-d-cap' }, caption, hint), stage)

  const viewerFrame = mockFrame('Preview', 'pk-viewer-body', false)
  const viewerTitle = el('strong', { class: 'pk-viewer-title' })
  const viewerTabs = tabs.map(tab => el('button', { type: 'button', 'data-vtab': tab.screen, 'aria-pressed': 'false' }, tab.label))
  const viewerClose = el('button', { type: 'button', class: 'round', 'aria-label': 'Close preview' }, icon('close-icon'))
  const viewer = el('div', { class: 'pk-viewer', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Preview' },
    el('div', { class: 'pk-viewer-bar' }, viewerTitle, el('div', { class: 'mk-seg', role: 'group', 'aria-label': 'Preview' }, ...viewerTabs), el('span', { class: 'pk-viewer-sp' }), el('small', { class: 'muted' }, 'Esc to close'), viewerClose),
    viewerFrame.box)

  const fitAll = (): void => { stageFrame.fit(); nowFrame.fit() }

  function paint(): void {
    const selected = config.selected()
    const pickScreen = known.has(previewing) || !comparing ? previewing : selected.toLowerCase()
    stageFrame.load(url(pickScreen))
    label.textContent = pickScreen === 'index' ? 'All' : (config.options.find(option => option.id.toLowerCase() === pickScreen)?.id ?? pickScreen.toUpperCase())
    for (const button of tabButtons) button.setAttribute('aria-pressed', String(button.dataset.ptab === previewing))
    caption.textContent = nameOf(previewing)
    fullScreen.dataset.preview = previewing
    const differs = known.has(previewing) && previewing.toUpperCase() !== selected.toUpperCase()
    const option = config.options.find(entry => entry.id.toLowerCase() === previewing)?.id ?? ''
    hint.hidden = !differs
    if (differs) {
      hintPreviewing.textContent = option
      hintSelected.textContent = selected
      selectButton.textContent = `Select ${option}`
      selectButton.dataset.option = option
    }
    stage.toggleAttribute('data-compare', comparing)
    if (comparing) { nowFrame.load(url('now')); stage.prepend(nowColumn) } else nowColumn.remove()
    fitAll()
  }

  function showViewer(screen: string): void {
    viewerFrame.load(url(screen))
    viewerTitle.textContent = nameOf(screen)
    for (const button of viewerTabs) button.setAttribute('aria-pressed', String(button.dataset.vtab === screen))
  }

  let opener: HTMLElement | null = null
  const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); closeViewer() } }
  function openViewer(from: HTMLElement): void {
    opener = from
    viewer.hidden = false
    showViewer(previewing)
    document.addEventListener('keydown', onKey)
    viewerClose.focus()
  }
  function closeViewer(): void {
    if (viewer.hidden) return
    viewer.hidden = true
    viewerFrame.clear()
    document.removeEventListener('keydown', onKey)
    opener?.focus()
  }

  pane.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    const tab = target?.closest<HTMLElement>('[data-ptab]')
    if (tab) { previewing = tab.dataset.ptab ?? previewing; paint(); return }
    const select = target?.closest<HTMLElement>('[data-select]')
    if (select?.dataset.option) { config.choose(select.dataset.option); return }
    if (target?.closest('[data-cmp]')) { comparing = !comparing; compare.setAttribute('aria-pressed', String(comparing)); paint(); return }
    if (target?.closest('[data-preview]')) openViewer(fullScreen)
  })
  viewer.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    const tab = target?.closest<HTMLElement>('[data-vtab]')
    if (tab) showViewer(tab.dataset.vtab ?? previewing)
    else if (target?.closest('.round')) closeViewer()
  })

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitAll)
  observer?.observe(stage)
  paint()

  return {
    pane,
    viewer,
    show(screen): void { previewing = screen; paint() },
    dispose(): void { observer?.disconnect(); opener = null; closeViewer() },
  }
}
