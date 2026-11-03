import { errorText, getJson, postJson } from '../shared'
import type { CatalogEntry, CatalogPlugin, InstalledPlugin, PluginPermissions, RequirementStep } from './types'

type Listing = { plugin: CatalogPlugin; marketplace?: string }

type Selection = { kind: 'installed'; id: string } | { kind: 'listing'; listing: Listing } | null

type Preview = { manifest: { id: string; name: string; version: string }; commit: string; permissions: PluginPermissions; runtime: 'trusted' | 'isolated'; contributions: string[]; requires: RequirementStep[] }

const CONTRIBUTION_LINES = [
  { key: 'agents', line: (path: string) => `Add the agent ${path} to your engines` },
  { key: 'skills', line: (path: string) => `Add the skill ${path} to your engines` },
  { key: 'flows', line: (path: string) => `Add the Studio flow ${path}` },
] as const

function contributionLines(manifest: unknown): string[] {
  const contributes = (manifest as { contributes?: Record<string, unknown> } | undefined)?.contributes
  if (contributes === undefined || contributes === null) return []
  return CONTRIBUTION_LINES.flatMap(kind => {
    const paths = contributes[kind.key]
    return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string').map(kind.line) : []
  })
}

function needsTrust(preview: Preview): boolean {
  return preview.runtime === 'trusted' || preview.contributions.length > 0
}

const STEP_STATUSES = ['ok', 'enable', 'install', 'update', 'unavailable']

const CHANGED_NOTE = 'Something changed since you reviewed it. Check the list again.'

function stepsFrom(value: unknown): RequirementStep[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is RequirementStep => typeof entry?.id === 'string' && STEP_STATUSES.includes(entry?.status))
}

const pendingSteps = (steps: RequirementStep[]): RequirementStep[] => steps.filter(step => step.status !== 'ok')

const hasBlockedStep = (steps: RequirementStep[]): boolean => steps.some(step => step.status === 'unavailable')

const installCount = (steps: RequirementStep[]): number => 1 + steps.filter(step => step.status === 'install' || step.status === 'update').length

function stepNeedsTrust(step: RequirementStep): boolean {
  if (step.status !== 'install' && step.status !== 'update') return false
  return step.preview.runtime === 'trusted' || contributionLines({ contributes: step.preview.contributes }).length > 0
}

function trustCount(preview: Preview): number {
  return (needsTrust(preview) ? 1 : 0) + preview.requires.filter(stepNeedsTrust).length
}

function consentOf(steps: RequirementStep[]): Array<{ id: string; action: string; commit?: string }> {
  return pendingSteps(steps).flatMap(step => {
    if (step.status === 'install' || step.status === 'update') return [{ id: step.id, action: step.status, commit: step.preview.commit }]
    return step.status === 'enable' ? [{ id: step.id, action: 'enable' }] : []
  })
}

function joinNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

function appliedNames(steps: RequirementStep[], ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  return steps.flatMap(step => {
    if (!ids.includes(step.id)) return []
    if (step.status === 'install' || step.status === 'update') return [step.preview.manifest.name]
    return step.status === 'enable' ? [step.name] : [step.id]
  })
}

type InstallDraft = { listing: Listing; preview: Preview; error: string }

type UpdateState = {
  status: 'idle' | 'checking' | 'up-to-date' | 'ready' | 'consent' | 'trust' | 'updating' | 'restarting' | 'error'
  ref: string
  commit: string
  version: string
  added: string[]
  message: string
  requires: RequirementStep[]
  given: { accept: boolean; trust: boolean }
}

const REPO_DISPLAY = (repo: string): string => repo.replace(/^https?:\/\//, '').replace(/\.git$/, '')
const section = (): HTMLElement => document.getElementById('marketplace') as HTMLElement
const icon = (id: string): string => `<svg><use href="#${id}"/></svg>`

let installedList: InstalledPlugin[] = []
let catalogEntries: CatalogEntry[] = []
let selected: Selection = null
let installDraft: InstallDraft | null = null
let updateState: UpdateState | null = null
let addingMarketplace = false

function toast(text: string): void {
  dispatchEvent(new CustomEvent('quiet:toast', { detail: text }))
}

function failNote(text: string, scope?: ParentNode | null): void {
  const host = (scope ?? section()) as ParentNode
  host.querySelector?.('.mk-fail')?.remove()
  const note = document.createElement('p')
  note.className = 'mk-fail muted'
  note.setAttribute('role', 'status')
  note.textContent = text
  ;(host as HTMLElement).append(note)
}

async function runBusy(target: HTMLButtonElement, label: string, run: () => Promise<string | null>, scope?: ParentNode | null): Promise<void> {
  const idle = target.textContent ?? ''
  target.disabled = true
  target.textContent = label
  const failure = await run()
  target.disabled = false
  target.textContent = idle
  if (failure !== null) failNote(failure, scope)
}

const stepSuffix = (data: Record<string, unknown>): string => (typeof data.step === 'string' ? ` (at ${String(data.step)})` : '')

function pluginLogo(plugin: { id: string; icon?: string }, size: number): string {
  const image = plugin.icon === undefined ? `<svg><use href="#auto-icon"/></svg>` : `<img src="/api/plugins/${encodeURIComponent(plugin.id)}/icon" alt="">`
  return `<span class="mk-logo" style="--s:${size}px">${image}</span>`
}

function tag(runtime: 'trusted' | 'isolated'): string {
  const iconId = runtime === 'trusted' ? 'mk-warn' : 'mk-shield'
  const label = runtime === 'trusted' ? 'Trusted' : 'Isolated'
  return `<span class="mk-tag"${runtime === 'trusted' ? ' data-k="trusted"' : ''}>${icon(iconId)} ${label}</span>`
}

function button(label: string, className: string, onClick: (element: HTMLButtonElement) => void): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  element.textContent = label
  element.onclick = () => onClick(element)
  return element
}

function permList(permissions: PluginPermissions, heading: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'connection-section'
  wrap.append(Object.assign(document.createElement('h3'), { textContent: heading }))
  const list = document.createElement('ul')
  list.className = 'mk-perm'
  const lines: Array<{ iconId: string; text: string; code?: string; note: string }> = []
  for (const host of permissions.network ?? []) {
    const wildcard = host.startsWith('*.')
    lines.push({ iconId: 'mk-globe', text: wildcard ? 'Reach any address ending in' : 'Reach', code: wildcard ? host.slice(1) : host, note: wildcard ? 'Any site under this domain.' : 'Nothing else on the internet.' })
  }
  const kinds = permissions.sessions ?? []
  if (kinds.length > 0) {
    const names = [...(kinds.includes('chat') ? ['chats'] : []), ...(kinds.includes('terminal') ? ['terminals'] : [])]
    lines.push({ iconId: 'mk-chat', text: `Start ${names.join(' and ')}`, note: 'Only when you click Start on a task. You still confirm the AI and folder.' })
  }
  if (permissions.settings === true) lines.push({ iconId: 'mk-key', text: 'Keep its own settings', note: 'Stored privately on this machine, never shared with other plugins.' })
  for (const line of lines) {
    const item = document.createElement('li')
    item.innerHTML = `<span>${icon(line.iconId)}</span>`
    const text = document.createElement('div')
    if (line.code === undefined) text.textContent = line.text
    else {
      text.append(document.createTextNode(`${line.text} `), Object.assign(document.createElement('code'), { textContent: line.code }))
    }
    item.append(text, Object.assign(document.createElement('small'), { textContent: line.note }))
    list.append(item)
  }
  wrap.append(list)
  return wrap
}

function headOf(name: string, description: string, runtime: 'trusted' | 'isolated', logo: string): HTMLElement {
  const head = document.createElement('header')
  head.className = 'connection-head'
  head.innerHTML = logo
  const intro = document.createElement('div')
  intro.append(Object.assign(document.createElement('h2'), { textContent: name }))
  const sub = document.createElement('p')
  sub.className = 'muted'
  sub.textContent = description
  intro.append(sub)
  head.append(intro)
  head.insertAdjacentHTML('beforeend', tag(runtime))
  return head
}

function sourceLine(repo: string, version: string | undefined, marketplace: string | undefined): HTMLElement {
  const line = document.createElement('p')
  line.className = 'mk-src'
  const text = document.createElement('span')
  text.textContent = `${REPO_DISPLAY(repo)}${version === undefined ? '' : ` · v${version}`}${marketplace === undefined ? '' : ` · from ${REPO_DISPLAY(marketplace)}`}`
  line.innerHTML = icon('mk-link')
  line.append(text)
  return line
}

function stepTitle(step: RequirementStep): string {
  if (step.status === 'install' || step.status === 'update') return `${step.preview.manifest.name} v${step.preview.manifest.version}`
  if (step.status === 'enable') return `${step.name} v${step.installedVersion}`
  return step.id + (step.minVersion === undefined ? '' : ` v${step.minVersion} or newer`)
}

function stepNote(step: RequirementStep): string {
  if (step.status === 'install') return 'Will be installed'
  if (step.status === 'update') return `Will be updated from v${step.installedVersion ?? ''}`
  if (step.status === 'enable') return 'Is turned off. It will be turned on'
  return ''
}

function requirementRow(step: RequirementStep): HTMLElement {
  const row = document.createElement('div')
  row.className = 'mk-req'
  row.dataset.requirement = step.id
  row.append(Object.assign(document.createElement('strong'), { textContent: stepTitle(step) }))
  if (step.status === 'unavailable') {
    row.append(Object.assign(document.createElement('p'), { className: 'mk-fail muted', textContent: step.reason }))
    return row
  }
  row.append(Object.assign(document.createElement('p'), { className: 'muted connection-small', textContent: stepNote(step) }))
  if (step.status === 'enable') return row
  row.append(permList(step.preview.permissions, 'It asks for').querySelector('.mk-perm')!)
  const lines = contributionLines({ contributes: step.preview.contributes })
  if (lines.length > 0) {
    const list = document.createElement('ul')
    list.className = 'mk-perm'
    for (const line of lines) list.append(Object.assign(document.createElement('li'), { textContent: line }))
    row.append(list)
  }
  return row
}

function requirementsSection(steps: RequirementStep[]): HTMLElement | null {
  const rows = pendingSteps(steps)
  if (rows.length === 0) return null
  const wrap = document.createElement('div')
  wrap.className = 'connection-section'
  wrap.append(Object.assign(document.createElement('h3'), { textContent: 'It also needs' }), ...rows.map(requirementRow))
  return wrap
}

function trustSwitch(text: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement('label')
  label.className = 'switch-label'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.setAttribute('role', 'switch')
  label.append(input, document.createTextNode(text))
  return { label, input }
}

function forcePrompt(host: ParentNode, text: string, label: string, onConfirm: (element: HTMLButtonElement) => void): void {
  host.querySelector?.('.mk-force')?.remove()
  const row = document.createElement('div')
  row.className = 'mk-force'
  row.append(Object.assign(document.createElement('p'), { className: 'mk-fail muted', textContent: text }), button(label, 'connection-button', onConfirm))
  ;(host as HTMLElement).append(row)
}

function isDependentsRefusal(response: Response, payload: { dependents?: unknown }): boolean {
  return response.status === 409 && Array.isArray(payload.dependents)
}

function runNote(runtime: 'trusted' | 'isolated'): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'connection-section'
  wrap.append(Object.assign(document.createElement('h3'), { textContent: 'How it runs' }))
  const note = document.createElement('p')
  note.className = 'connection-note'
  note.textContent = runtime === 'isolated'
    ? 'Isolated: it runs in its own locked-down space. macOS blocks it from your files, your other secrets and every website except the ones above.'
    : 'Trusted: it runs inside Shikidan with full access to your files, your tokens and the internet.'
  wrap.append(note)
  return wrap
}

async function loadInstalled(): Promise<void> {
  const result = await getJson('/api/plugins')
  if (!result.ok) return
  const plugins = result.data.plugins
  installedList = Array.isArray(plugins) ? plugins.filter(entry => typeof entry?.id === 'string' && typeof entry?.name === 'string') : []
}

async function loadCatalog(): Promise<void> {
  const result = await getJson('/api/plugins/catalog')
  if (!result.ok) return
  const entries = result.data.entries
  catalogEntries = Array.isArray(entries) ? entries as CatalogEntry[] : []
}

function listings(): Listing[] {
  const installedIds = new Set(installedList.map(plugin => plugin.id))
  return catalogEntries.flatMap(entry => 'error' in entry ? [] : entry.plugins.filter(plugin => !installedIds.has(plugin.id)).map(plugin => ({ plugin, marketplace: entry.marketplace })))
}

async function reload(): Promise<void> {
  await Promise.all([loadInstalled(), loadCatalog()])
}

export async function openMarketplace(): Promise<void> {
  await reload()
  if (selected === null) {
    const available = listings()
    selected = available.length > 0 ? { kind: 'listing', listing: available[0]! } : installedList.length > 0 ? { kind: 'installed', id: installedList[0]!.id } : null
  }
  render()
}

function choiceRow(options: { id: string; name: string; note: string; icon?: string; pressed: boolean; onSelect: () => void }): HTMLElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'connection-choice'
  row.dataset.plugin = options.id
  row.setAttribute('aria-pressed', String(options.pressed))
  row.innerHTML = pluginLogo(options, 28)
  const text = document.createElement('span')
  text.append(Object.assign(document.createElement('strong'), { textContent: options.name }))
  text.append(Object.assign(document.createElement('small'), { textContent: options.note }))
  row.append(text)
  if (options.pressed) row.insertAdjacentHTML('beforeend', '<i class="connection-dot"></i>')
  row.onclick = options.onSelect
  return row
}

function brokenMarketplaceRow(url: string, error: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'mk-market-broken'
  row.dataset.marketplace = url
  row.append(Object.assign(document.createElement('strong'), { textContent: url }))
  row.append(Object.assign(document.createElement('small'), { textContent: error }))
  row.append(button('Remove', 'connection-button', async (element) => {
    element.disabled = true
    element.textContent = 'Removing…'
    const response = await fetch('/api/plugins/marketplaces', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })
    if (!response.ok) {
      element.disabled = false
      element.textContent = 'Remove'
      toast(`Couldn't remove this marketplace (${response.status})`)
      return
    }
    toast('Marketplace removed')
    await reload()
    render()
  }))
  return row
}

function listPane(): HTMLElement {
  const pane = document.createElement('aside')
  pane.className = 'connection-list'
  pane.setAttribute('aria-label', 'Plugins')
  const marketNames = catalogEntries.flatMap(entry => 'error' in entry || entry.name === null ? [] : [entry.name]).join(', ')
  const installed = document.createElement('h2')
  installed.innerHTML = `Installed <span class="muted">${installedList.length}</span>`
  pane.append(installed)
  for (const plugin of installedList) {
    pane.append(choiceRow({
      id: plugin.id,
      name: plugin.name,
      note: `${plugin.runtime === 'trusted' ? 'Trusted' : 'Isolated'} · v${plugin.version}`,
      icon: plugin.icon,
      pressed: selected?.kind === 'installed' && selected.id === plugin.id,
      onSelect: () => { updateState = null; selected = { kind: 'installed', id: plugin.id }; render() },
    }))
  }
  pane.append(Object.assign(document.createElement('div'), { className: 'mk-list-sep' }))
  const available = document.createElement('h2')
  available.append('Available ')
  available.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: marketNames === '' ? 'no marketplace yet' : marketNames }))
  pane.append(available)
  for (const listing of listings()) {
    pane.append(choiceRow({
      id: listing.plugin.id,
      name: listing.plugin.name,
      note: listing.plugin.description,
      pressed: selected?.kind === 'listing' && selected.listing.plugin.id === listing.plugin.id,
      onSelect: () => { updateState = null; installDraft = null; selected = { kind: 'listing', listing }; render() },
    }))
  }
  for (const entry of catalogEntries) {
    if ('error' in entry) pane.append(brokenMarketplaceRow(entry.marketplace, entry.error))
  }
  const addLink = button('Add from a link', 'connection-add', () => { addingMarketplace = !addingMarketplace; render() })
  addLink.insertAdjacentHTML('afterbegin', icon('plus-icon'))
  pane.append(addLink)
  if (addingMarketplace) pane.append(addLinkForm())
  return pane
}

function addLinkForm(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'mk-market-add mk-link-add'
  const url = document.createElement('input')
  url.type = 'url'
  url.placeholder = 'https://github.com/you/your-plugin or a marketplace'
  url.setAttribute('aria-label', 'Plugin or marketplace link')
  const ref = document.createElement('input')
  ref.type = 'text'
  ref.placeholder = 'Version (optional: newest tag)'
  ref.setAttribute('aria-label', 'Version')
  const add = button('Add', 'connection-button', element => {
    const link = url.value.trim()
    if (link === '') { failNote('Paste a GitHub link to a plugin or a marketplace.', wrap); return }
    void runBusy(element, 'Checking…', async () => {
      const result = await postJson('/api/plugins/add-link', { url: link, ...(ref.value.trim() === '' ? {} : { ref: ref.value.trim() }) })
      if (!result.ok) return `${errorText(result)}${stepSuffix(result.data)}`
      addingMarketplace = false
      if (result.data.kind === 'marketplace') {
        toast('Marketplace added')
        await reload()
        render()
        return null
      }
      const manifest = result.data.manifest as { id?: string; name?: string; version?: string; description?: string } | undefined
      if (manifest?.id === undefined || manifest.name === undefined || manifest.version === undefined) return 'This plugin has no readable manifest'
      const runtime = result.data.runtime === 'trusted' ? 'trusted' : 'isolated'
      installDraft = {
        listing: { plugin: { id: manifest.id, repo: link, ref: String(result.data.ref), name: manifest.name, description: manifest.description ?? '', runtime } },
        preview: { manifest: { id: manifest.id, name: manifest.name, version: manifest.version }, commit: String(result.data.commit ?? ''), permissions: result.data.permissions as PluginPermissions, runtime, contributions: contributionLines(result.data.manifest), requires: stepsFrom(result.data.requires) },
        error: '',
      }
      render()
      return null
    }, wrap)
  })
  wrap.append(url, ref, add)
  return wrap
}

async function openInstallDraft(listing: Listing, target?: HTMLButtonElement): Promise<void> {
  const idle = target?.textContent ?? ''
  if (target !== undefined) { target.disabled = true; target.textContent = 'Checking…' }
  try {
    const preview = await previewListing(listing)
    if (preview === null) return
    installDraft = { listing, preview, error: '' }
    render()
  } finally {
    if (target !== undefined) { target.disabled = false; target.textContent = idle }
  }
}

async function previewListing(listing: Listing): Promise<Preview | null> {
  const result = await postJson('/api/plugins/preview', { repo: listing.plugin.repo, ref: listing.plugin.ref, ...(listing.marketplace === undefined ? {} : { marketplace: listing.marketplace }) })
  if (!result.ok) {
    failNote(`Could not preview: ${errorText(result)}${stepSuffix(result.data)}`)
    return null
  }
  const manifest = result.data.manifest as { id?: string; name?: string; version?: string } | undefined
  if (manifest === undefined || manifest.id === undefined || manifest.name === undefined || manifest.version === undefined) return null
  return {
    manifest: { id: manifest.id, name: manifest.name, version: manifest.version },
    commit: String(result.data.commit ?? ''),
    permissions: result.data.permissions as PluginPermissions,
    runtime: result.data.runtime === 'trusted' ? 'trusted' : 'isolated',
    contributions: contributionLines(result.data.manifest),
    requires: stepsFrom(result.data.requires),
  }
}

function contributionWarning(lines: string[]): HTMLElement[] {
  const warn = document.createElement('div')
  warn.className = 'mk-warn'
  warn.innerHTML = `${icon('mk-warn')}<div><strong>It adds work to your engines.</strong> Agents and skills run with your full access when a session or flow uses them.</div>`
  const list = document.createElement('ul')
  list.className = 'mk-perm'
  for (const line of lines) list.append(Object.assign(document.createElement('li'), { textContent: line }))
  return [warn, list]
}

function trustedWarning(): HTMLElement {
  const warn = document.createElement('div')
  warn.className = 'mk-warn'
  warn.innerHTML = `${icon('mk-warn')}<div><strong>This plugin gets full access.</strong> It runs inside Shikidan, so it can read your files, your saved tokens, and reach any website. Only install it if you trust who made it.</div>`
  return warn
}

function installDialog(): HTMLElement {
  const draft = installDraft!
  const { preview } = draft
  const overlay = document.createElement('div')
  overlay.className = 'mk-dialog'
  const card = document.createElement('section')
  const head = document.createElement('header')
  head.className = 'dialog-heading'
  head.innerHTML = pluginLogo(draft.listing.plugin, 40)
  const intro = document.createElement('div')
  intro.append(Object.assign(document.createElement('h2'), { textContent: `Install ${preview.manifest.name}?` }))
  const source = document.createElement('p')
  source.className = 'muted'
  source.textContent = draft.listing.marketplace === undefined ? `${REPO_DISPLAY(draft.listing.plugin.repo)} · v${preview.manifest.version}` : `from ${REPO_DISPLAY(draft.listing.marketplace)} · v${preview.manifest.version}`
  intro.append(source)
  head.append(intro)
  head.insertAdjacentHTML('beforeend', tag(preview.runtime))
  card.append(head)
  const label = pendingSteps(preview.requires).length > 0 ? `Install all (${installCount(preview.requires)})` : 'Install'
  const install = button(label, 'connection-button primary', element => { void confirmInstall(element, card) })
  if (preview.runtime === 'isolated') {
    card.append(Object.assign(document.createElement('p'), { className: 'connection-note', textContent: 'It will be able to:' }))
    card.append(permList(preview.permissions, 'It asks for').querySelector('.mk-perm')!)
    card.append(Object.assign(document.createElement('p'), { className: 'muted connection-small', textContent: 'It cannot read your files, your other secrets, or reach any other website.' }))
    if (preview.contributions.length > 0) card.append(...contributionWarning(preview.contributions))
  } else {
    card.append(trustedWarning())
  }
  const needs = requirementsSection(preview.requires)
  if (needs !== null) card.append(needs)
  const trusting = trustCount(preview)
  const trust = trustSwitch(trusting > 1 ? 'I trust these plugins' : 'I trust this plugin')
  const refresh = (): void => { install.disabled = hasBlockedStep(preview.requires) || (trusting > 0 && !trust.input.checked) }
  trust.input.onchange = refresh
  if (trusting > 0) card.append(trust.label)
  refresh()
  if (draft.error !== '') card.append(Object.assign(document.createElement('p'), { className: 'mk-fail muted', textContent: draft.error }))
  const footer = document.createElement('footer')
  footer.append(button('Cancel', 'connection-button', () => { installDraft = null; render() }), install)
  card.append(footer)
  overlay.append(card)
  return overlay
}

async function confirmInstall(target: HTMLButtonElement, scope: ParentNode): Promise<void> {
  const draft = installDraft
  if (draft === null) return
  await runBusy(target, 'Installing…', async () => {
    const result = await postJson('/api/plugins/install', {
      repo: draft.listing.plugin.repo,
      ref: draft.listing.plugin.ref,
      commit: draft.preview.commit,
      ...(trustCount(draft.preview) > 0 ? { trust: true } : {}),
      ...(draft.listing.marketplace === undefined ? {} : { marketplace: draft.listing.marketplace }),
      ...(pendingSteps(draft.preview.requires).length > 0 ? { requirements: consentOf(draft.preview.requires) } : {}),
    })
    if (!result.ok && result.data.needsRequirements === true) {
      installDraft = { ...draft, preview: { ...draft.preview, requires: stepsFrom(result.data.requirements) }, error: CHANGED_NOTE }
      render()
      return null
    }
    if (!result.ok) {
      installDraft = { ...draft, error: `${errorText(result)}${stepSuffix(result.data)}` }
      render()
      return null
    }
    installDraft = null
    toast(`Installed ${joinNames([draft.preview.manifest.name, ...appliedNames(draft.preview.requires, result.data.installedRequirements)])}`)
    dispatchEvent(new Event('quiet:plugins-changed'))
    await reload()
    selected = { kind: 'installed', id: draft.preview.manifest.id }
    render()
    return null
  }, scope)
}

function listingDetail(listing: Listing): HTMLElement {
  const pane = document.createElement('section')
  pane.className = 'connection-settings'
  pane.append(headOf(listing.plugin.name, listing.plugin.description, listing.plugin.runtime, pluginLogo(listing.plugin, 40)))
  pane.append(sourceLine(listing.plugin.repo, undefined, listing.marketplace))
  pane.append(Object.assign(document.createElement('p'), { className: 'connection-note muted', textContent: 'Preview the plugin to see exactly what it asks for before it is installed.' }))
  const foot = document.createElement('div')
  foot.className = 'connection-foot'
  const spacer = document.createElement('span')
  spacer.style.flex = '1'
  foot.append(Object.assign(document.createElement('span'), { className: 'muted connection-small', textContent: 'Free · open source' }), spacer)
  foot.append(button('Install', 'connection-button primary', element => { void openInstallDraft(listing, element) }))
  pane.append(foot)
  return pane
}

const settingsCache = new Map<string, { values: Record<string, string>; configured: Record<string, boolean> }>()

function settingsSection(plugin: InstalledPlugin): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'connection-section field-stack'
  wrap.append(Object.assign(document.createElement('h3'), { textContent: 'Settings' }))
  const fields = plugin.settingsFields ?? []
  if (fields.length === 0) {
    wrap.append(Object.assign(document.createElement('p'), { className: 'connection-note muted', textContent: 'This plugin has no settings.' }))
    return wrap
  }
  const inputs = new Map<string, HTMLInputElement>()
  for (const field of fields) {
    const label = document.createElement('label')
    label.className = 'mk-field'
    label.append(document.createTextNode(field.label))
    const input = document.createElement('input')
    input.type = field.type === 'secret' ? 'password' : 'text'
    if (field.type === 'secret') input.autocomplete = 'off'
    inputs.set(field.key, input)
    label.append(input)
    if (field.help !== undefined) label.append(Object.assign(document.createElement('small'), { textContent: field.help }))
    wrap.append(label)
  }
  const apply = (view: { values: Record<string, string>; configured: Record<string, boolean> }): void => {
    for (const field of fields) {
      const input = inputs.get(field.key)
      if (input === undefined) continue
      if (field.type === 'secret') input.placeholder = view.configured[field.key] === true ? 'Saved — type to replace' : ''
      else input.value = view.values[field.key] ?? ''
      input.dataset.stored = input.value
    }
  }
  const cached = settingsCache.get(plugin.id)
  if (cached !== undefined) apply(cached)
  else void (async () => {
    const view = await getJson(`/api/plugins/${encodeURIComponent(plugin.id)}/settings`)
    if (!view.ok) return
    const entry = { values: (view.data.values ?? {}) as Record<string, string>, configured: (view.data.configured ?? {}) as Record<string, boolean> }
    settingsCache.set(plugin.id, entry)
    apply(entry)
  })()
  wrap.append(button('Save settings', 'connection-button', element => {
    void runBusy(element, 'Saving…', async () => {
      const view = { values: { ...(settingsCache.get(plugin.id)?.values ?? {}) }, configured: { ...(settingsCache.get(plugin.id)?.configured ?? {}) } }
      for (const field of fields) {
        const input = inputs.get(field.key)!
        if (field.type === 'secret' && input.value === '') continue
        if (input.value === (input.dataset.stored ?? '')) continue
        const response = await fetch(`/api/plugins/${encodeURIComponent(plugin.id)}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: field.key, value: input.value }) })
        if (!response.ok) {
          const payload = await response.json().catch(() => ({})) as { error?: string }
          return payload.error ?? `Could not save ${field.label}`
        }
        view.values[field.key] = input.value
        view.configured[field.key] = input.value !== ''
        input.dataset.stored = input.value
        if (field.type === 'secret') input.value = ''
      }
      settingsCache.set(plugin.id, view)
      toast('Settings saved')
      return null
    }, wrap)
  }))
  return wrap
}

async function checkForUpdate(plugin: InstalledPlugin): Promise<void> {
  updateState = { status: 'checking', ref: plugin.source.ref, commit: '', version: '', added: [], message: '', requires: [], given: { accept: false, trust: false } }
  const mine = updateState
  render()
  const stillMine = (): boolean => updateState === mine
  const put = (patch: Partial<UpdateState>): void => { if (stillMine()) updateState = { ...mine, ...patch } }
  if (plugin.source.marketplace !== undefined) {
    const synced = await postJson('/api/plugins/marketplaces', { url: plugin.source.marketplace })
    if (!stillMine()) return
    if (!synced.ok) { put({ status: 'error', message: "Couldn't reach this marketplace" }); render(); return }
    const catalog = await getJson('/api/plugins/catalog')
    if (!stillMine()) return
    if (catalog.ok) {
      const entries = (catalog.data.entries ?? []) as CatalogEntry[]
      const listing = entries.flatMap(entry => 'error' in entry ? [] : entry.plugins).find(entry => entry.id === plugin.id)
      if (listing !== undefined && listing.repo === plugin.source.repo) mine.ref = listing.ref
    }
  }
  const result = await postJson('/api/plugins/preview', { repo: plugin.source.repo, ref: mine.ref, ...(plugin.source.marketplace === undefined ? {} : { marketplace: plugin.source.marketplace }) })
  if (!stillMine()) return
  if (!result.ok) { put({ status: 'error', message: `${errorText(result)}${stepSuffix(result.data)}` }); render(); return }
  const commit = String(result.data.commit ?? '')
  if (commit === plugin.commit) { put({ status: 'up-to-date' }); render(); return }
  const manifest = result.data.manifest as { version?: string } | undefined
  put({ status: 'ready', commit, version: manifest?.version ?? 'a newer version', requires: stepsFrom(result.data.requires) })
  render()
}

async function runUpdate(plugin: InstalledPlugin, given: Partial<UpdateState['given']>): Promise<void> {
  const state = updateState
  if (state === null || (state.status !== 'ready' && state.status !== 'consent' && state.status !== 'trust')) return
  const merged = { ...state.given, ...given }
  updateState = { ...state, status: 'updating', given: merged }
  render()
  const result = await postJson(`/api/plugins/${encodeURIComponent(plugin.id)}/update`, {
    ref: state.ref,
    commit: state.commit,
    ...(merged.accept ? { accept: true } : {}),
    ...(merged.trust ? { trust: true } : {}),
    ...(pendingSteps(state.requires).length > 0 ? { requirements: consentOf(state.requires) } : {}),
  })
  if (updateState === null || updateState.ref !== state.ref || updateState.commit !== state.commit) return
  if (!result.ok) {
    if (result.data.needsRequirements === true) { updateState = { ...state, status: 'ready', requires: stepsFrom(result.data.requirements), message: CHANGED_NOTE, given: merged }; render(); return }
    if (result.data.needsConsent === true) { updateState = { ...state, status: 'consent', added: (result.data.added as string[] | undefined) ?? [], given: merged }; render(); return }
    if (result.data.needsTrust === true) { updateState = { ...state, status: 'trust', given: merged }; render(); return }
    updateState = { ...state, status: 'error', message: `${errorText(result)}${stepSuffix(result.data)}` }
    render()
    return
  }
  const updated = result.data.plugin as InstalledPlugin | undefined
  updateState = updated?.restartRequired === true ? { ...state, status: 'restarting', given: merged } : { ...state, status: 'up-to-date', given: merged }
  toast(`Updated ${joinNames([plugin.name, ...appliedNames(state.requires, result.data.installedRequirements)])}`)
  dispatchEvent(new Event('quiet:plugins-changed'))
  await reload()
  render()
}

function updateArea(plugin: InstalledPlugin): HTMLElement | null {
  const state = updateState
  if (state === null) return null
  const wrap = document.createElement('div')
  wrap.className = 'connection-section'
  wrap.append(Object.assign(document.createElement('h3'), { textContent: 'Updates' }))
  if (state.status === 'checking') {
    wrap.append(Object.assign(document.createElement('p'), { className: 'connection-note muted', textContent: 'Checking this marketplace for a newer version…' }))
    return wrap
  }
  if (state.status === 'updating') {
    wrap.append(Object.assign(document.createElement('p'), { className: 'connection-note muted', textContent: `Updating to ${state.version}…` }))
    return wrap
  }
  if (state.status === 'error') {
    wrap.append(Object.assign(document.createElement('p'), { className: 'connection-note', textContent: state.message }))
    return wrap
  }
  if (state.status === 'up-to-date') {
    wrap.append(Object.assign(document.createElement('p'), { className: 'connection-note', textContent: 'Up to date.' }))
    return wrap
  }
  if (state.status === 'restarting') {
    wrap.append(Object.assign(document.createElement('p'), { className: 'connection-note', textContent: 'Restart Shikidan to finish updating.' }))
    return wrap
  }
  if (state.status === 'consent') {
    const consent = document.createElement('div')
    consent.className = 'mk-warn'
    consent.innerHTML = `${icon('mk-warn')}<div></div>`
    const text = consent.lastElementChild as HTMLElement
    text.append(Object.assign(document.createElement('strong'), { textContent: 'The new version asks for more:' }))
    const list = document.createElement('ul')
    list.style.margin = '6px 0 0'
    list.style.paddingLeft = '18px'
    for (const line of state.added) list.append(Object.assign(document.createElement('li'), { textContent: line }))
    text.append(list)
    wrap.append(consent, button('Accept and update', 'connection-button primary', () => void runUpdate(plugin, { accept: true })))
    return wrap
  }
  if (state.status === 'trust') {
    const warn = document.createElement('div')
    warn.className = 'mk-warn'
    warn.innerHTML = `${icon('mk-warn')}<div><strong>The new version runs trusted.</strong> It gets full access to your files, your tokens and the internet.</div>`
    wrap.append(warn)
    const trust = document.createElement('label')
    trust.className = 'switch-label'
    const trustInput = document.createElement('input')
    trustInput.type = 'checkbox'
    trustInput.setAttribute('role', 'switch')
    const update = button('Update anyway', 'connection-button primary', () => void runUpdate(plugin, { trust: true }))
    update.disabled = true
    trustInput.onchange = () => { update.disabled = !(trustInput as HTMLInputElement).checked }
    trust.append(trustInput, document.createTextNode('I trust this plugin'))
    wrap.append(trust, update)
    return wrap
  }
  const needs = requirementsSection(state.requires)
  if (needs !== null) wrap.append(needs)
  if (state.message !== '') wrap.append(Object.assign(document.createElement('p'), { className: 'connection-note', textContent: state.message }))
  const trusting = state.requires.some(stepNeedsTrust)
  const trust = trustSwitch('I trust these plugins')
  const label = pendingSteps(state.requires).length > 0 ? `Update all (${installCount(state.requires)})` : `Update to ${state.version}`
  const update = button(label, 'connection-button primary', () => void runUpdate(plugin, trust.input.checked ? { trust: true } : {}))
  const refresh = (): void => { update.disabled = hasBlockedStep(state.requires) || (trusting && !trust.input.checked) }
  trust.input.onchange = refresh
  if (trusting) wrap.append(trust.label)
  refresh()
  wrap.append(update)
  return wrap
}

function uninstallArea(plugin: InstalledPlugin): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'connection-section'
  wrap.append(Object.assign(document.createElement('h3'), { textContent: 'Uninstall' }))
  const keep = document.createElement('label')
  keep.className = 'switch-label'
  const keepInput = document.createElement('input')
  keepInput.type = 'checkbox'
  keepInput.setAttribute('role', 'switch')
  keepInput.checked = true
  keep.append(keepInput, document.createTextNode('Keep its data (settings and files)'))
  const attempt = (element: HTMLButtonElement, force: boolean): void => {
    void runBusy(element, 'Removing…', async () => {
      const response = await fetch(`/api/plugins/${encodeURIComponent(plugin.id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keepData: (keepInput as HTMLInputElement).checked, ...(force ? { force: true } : {}) }) })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string; dependents?: unknown }
        if (isDependentsRefusal(response, payload)) {
          forcePrompt(wrap, `${payload.error ?? 'Other plugins need this plugin'}. Remove anyway?`, 'Remove anyway', again => attempt(again, true))
          return null
        }
        return payload.error ?? 'Could not uninstall this plugin'
      }
      toast(`Removed ${plugin.name}`)
      dispatchEvent(new Event('quiet:plugins-changed'))
      selected = null
      await reload()
      await openMarketplace()
      return null
    }, wrap)
  }
  const remove = button('Uninstall', 'connection-button', element => attempt(element, false))
  remove.style.color = 'var(--danger)'
  wrap.append(keep, remove)
  return wrap
}

async function toggleEnabled(plugin: InstalledPlugin, input: HTMLInputElement, pane: HTMLElement, force: boolean): Promise<void> {
  const next = input.checked
  const response = await fetch(`/api/plugins/${encodeURIComponent(plugin.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: next, ...(force ? { force: true } : {}) }) })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string; dependents?: unknown }
    input.checked = !next
    if (!next && isDependentsRefusal(response, payload)) {
      forcePrompt(pane, `${payload.error ?? 'Other plugins need this plugin'}. Turn off anyway?`, 'Turn off anyway', () => { input.checked = false; void toggleEnabled(plugin, input, pane, true) })
      return
    }
    toast(payload.error ?? 'That change did not go through')
    return
  }
  toast(next ? `${plugin.name} is on` : `${plugin.name} is off`)
  dispatchEvent(new Event('quiet:plugins-changed'))
  await reload()
  render()
}

function installedDetail(plugin: InstalledPlugin): HTMLElement {
  const pane = document.createElement('section')
  pane.className = 'connection-settings'
  pane.append(headOf(plugin.name, plugin.description, plugin.runtime, pluginLogo(plugin, 40)))
  pane.append(sourceLine(plugin.source.repo, plugin.version, plugin.source.marketplace))
  if (plugin.restartRequired === true) {
    const restart = document.createElement('div')
    restart.className = 'mk-warn'
    restart.innerHTML = `${icon('mk-warn')}<div>Restart Shikidan to finish updating.</div>`
    pane.append(restart)
  }
  pane.append(settingsSection(plugin))
  pane.append(permList(plugin.permissions, 'It asks for'))
  pane.append(runNote(plugin.runtime))
  const updates = updateArea(plugin)
  if (updates !== null) pane.append(updates)
  pane.append(uninstallArea(plugin))
  const foot = document.createElement('div')
  foot.className = 'connection-foot'
  const enabled = document.createElement('label')
  enabled.className = 'switch-label'
  const enabledInput = document.createElement('input')
  enabledInput.type = 'checkbox'
  enabledInput.setAttribute('role', 'switch')
  enabledInput.checked = plugin.enabled
  enabledInput.onchange = () => { void toggleEnabled(plugin, enabledInput as HTMLInputElement, pane, false) }
  enabled.append(enabledInput, document.createTextNode('Enabled'))
  const spacer = document.createElement('span')
  spacer.style.flex = '1'
  foot.append(enabled, spacer)
  const check = button('Check for update', 'connection-button connection-refresh', () => void checkForUpdate(plugin))
  check.insertAdjacentHTML('afterbegin', icon('mk-refresh'))
  foot.append(check)
  foot.append(button('Open', 'connection-button primary', () => { dispatchEvent(new CustomEvent('quiet:show-plugin', { detail: plugin.id })) }))
  pane.append(foot)
  return pane
}

function emptyDetail(): HTMLElement {
  const pane = document.createElement('section')
  pane.className = 'connection-settings'
  pane.append(Object.assign(document.createElement('p'), { className: 'connection-note muted', textContent: 'Pick a plugin, or add a marketplace to browse more.' }))
  return pane
}

function render(): void {
  const screen = section()
  const heading = document.createElement('header')
  heading.className = 'studio-heading'
  heading.innerHTML = '<div><h1>Marketplace</h1><p class="muted">Boards and tools added to your cockpit.</p></div>'
  const view = document.createElement('section')
  view.className = 'studio-view connections-view'
  view.append(listPane())
  if (selected?.kind === 'installed') {
    const id = selected.id
    const plugin = installedList.find(entry => entry.id === id)
    view.append(plugin === undefined ? emptyDetail() : installedDetail(plugin))
  } else if (selected?.kind === 'listing') view.append(listingDetail(selected.listing))
  else view.append(emptyDetail())
  screen.replaceChildren(heading, view)
  if (installDraft !== null) screen.append(installDialog())
}

addEventListener('quiet:show', (event) => { if ((event as CustomEvent<string>).detail === 'marketplace') void openMarketplace() })
