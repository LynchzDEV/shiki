import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Elysia } from 'elysia'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { DUO_OPEN_QUERY, PHONE_TERMINAL_QUERY } from '../client/shared'
import { createApp } from '../server/index'

const scratch = process.env.SKD_GOAL_SCRATCH ?? join(tmpdir(), 'mc-responsive-shots')
const quiet = await Bun.file(join(import.meta.dir, '../public/quiet.css')).text()
const plugins = await Bun.file(join(import.meta.dir, '../public/plugins.css')).text()
const pluginUi = await Bun.file(join(import.meta.dir, '../public/plugin-ui.css')).text()

const narrowBlock = (css: string) => [...css.matchAll(/@media \(max-width: 600px\) \{([^@]*)\n\}/g)].map(match => match[1]).join('\n')
const mediaBlock = (css: string, query: string): string => {
  const start = css.indexOf(`@media ${query} {`)
  return start < 0 ? '' : css.slice(start, css.indexOf('\n}', start))
}
const quietNarrow = narrowBlock(quiet)
const pluginsNarrow = narrowBlock(plugins)
const pluginUiNarrow = narrowBlock(pluginUi)

describe('shipped layout at phone width', () => {
  test('on a phone the sidebar is a full-height drawer over a scrim, with no icon rail and no 264px track', () => {
    const drawer = mediaBlock(quiet, PHONE_TERMINAL_QUERY)
    expect(quiet.split(`@media ${PHONE_TERMINAL_QUERY} {`)).toHaveLength(2)
    expect(drawer).toContain('.sb-shell, .sb-shell.collapsed { grid-template-columns: minmax(0, 1fr); transition: none; }')
    expect(drawer).toContain('.sb-shell .sb-strip, .sb-shell.collapsed .sb { display: none; }')
    expect(drawer).toContain('.sb-shell:not(.collapsed) .sb { position: fixed; inset: 0 auto 0 0; width: min(86vw, 340px); height: 100dvh; z-index: 60;')
    expect(drawer).toContain('.sb-shell:not(.collapsed)::after { content: \'\'; position: fixed; inset: 0; z-index: 59; background: var(--scrim, #41485218); }')
    expect(drawer).not.toContain('grid-template-columns: 264px')
    expect(quietNarrow).not.toContain('top: 68px')
    expect(quietNarrow).not.toContain('z-index: 50')
  })

  test('on a phone the toolbar keeps only Sessions; Studio, Flow, Agents and the bell move into the drawer', () => {
    const drawer = mediaBlock(quiet, PHONE_TERMINAL_QUERY)
    expect(quiet.indexOf('#phone-sessions, #screen-actions, .sb-destinations, .touch-only { display: none; }')).toBeLessThan(quiet.indexOf(`@media ${PHONE_TERMINAL_QUERY}, `))
    expect(drawer).toContain('#phone-sessions, #screen-actions { display: inline-flex;')
    expect(drawer).toContain('#screen-actions[hidden] { display: none; }')
    expect(drawer).toContain('.row-menu.anchored .row { min-height: 44px; }')
    expect(quiet).toContain('.popover.row-menu.anchored { position: fixed; left: auto; width: 220px; z-index: 70; }')
    expect(drawer).toContain('.sb-destinations { display: flex;')
    expect(drawer).toContain('.toolbar :is(#open-studio, #toggle-flow, #open-agents, #open-attention, .usage-card) { display: none; }')
  })

  test('drawer rows and the Sessions button are at least 44px tap targets', () => {
    const drawer = mediaBlock(quiet, PHONE_TERMINAL_QUERY)
    expect(drawer).toContain('.sb .sb-icon { width: 44px; height: 44px; }')
    expect(drawer).toContain('.sb-new, .sb-link, .sb-row { min-height: 44px; }')
    expect(drawer).toContain('width: 44px; flex-basis: 44px; min-height: 44px;')
  })

  test('queue rows, studio editors, connections and launchers collapse or scroll inside themselves', () => {
    expect(quietNarrow).toContain('.q-row { grid-template-columns: minmax(0, 1fr); overflow-x: auto; }')
    expect(quietNarrow).toContain('.launcher-fields { grid-template-columns: minmax(0, 1fr); }')
    expect(quietNarrow).toContain('.connections-view { grid-template-columns: minmax(0, 1fr);')
    expect(narrowBlock(quiet.replaceAll('@media (max-width: 900px)', '@media (max-width: 600px)'))).toContain('.editor-body { grid-template-columns: minmax(0, 1fr); }')
    expect(pluginsNarrow).toContain('.plugin-launch-fields { grid-template-columns: minmax(0, 1fr); }')
    expect(pluginUiNarrow).toContain('.connections-view { grid-template-columns: minmax(0, 1fr);')
    expect(plugins).toContain('.mk-cols { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(250px, 1fr); gap: 16px; overflow-x: auto;')
  })

  test('dialogs and chip menus are capped by the viewport', () => {
    expect(quietNarrow).toContain('.access-dialog, .confirm-dialog { width: min(460px, calc(100vw - 32px)); overflow: auto; }')
    expect(quietNarrow).toContain('.mention-menu, .chat-slash-menu, .chat-model-menu, .model-menu { left: 0; width: min(300px, 100%); overflow: auto; }')
    expect(quiet).toContain('.chip-menu { left: 0; width: min(300px, 100%); }')
    expect(pluginsNarrow).toContain('.mk-dialog > section { width: min(520px, calc(100vw - 32px)); }')
    expect(pluginUiNarrow).toContain('.mk-dialog > section { width: min(520px, calc(100vw - 32px)); }')
  })

  test('the phone welcome centres vertically once the stage stacks as a column', () => {
    expect(quietNarrow).toContain('.stage { flex-direction: column; }')
    expect(quietNarrow).toContain('.welcome { margin-block: auto; }')
  })

  test('the context meter drops under the phone composer instead of squeezing the message box', () => {
    expect(quietNarrow).toContain('.composer .ctx-meter { order: 1; flex-basis: 100%; justify-content: flex-end; padding: 0 4px; }')
  })
})

describe('chat reading layout', () => {
  test('conversation, history and composer keep one 760px column instead of the stage-wide reset', () => {
    expect(quiet).toContain('.content-width { width: min(100%, 760px); margin-inline: auto; }')
    expect(quiet).toContain('.stage > :not(.content-width) { min-width: 0; max-width: 100%; width: 100%; }')
    expect(quiet).not.toContain('.stage > * { min-width: 0; max-width: 100%; width: 100%; }')
  })

  test('an open conversation fades at its scroll edges instead of cutting lines in half', () => {
    expect(quiet).toContain('.stage:has(> .conversation:not([hidden])) { mask-image: linear-gradient(transparent, #000 18px, #000 calc(100% - 18px), transparent); }')
  })

  test('history rows sit closer together', () => {
    expect(quiet).toMatch(/\.history-item \{[^}]*margin-bottom: 12px;/)
    expect(quiet).toContain('.history-item > summary { padding: 15px 20px; }')
  })

  test('the composer hint stays on one line on a narrow composer', () => {
    expect(quiet).toContain('.composer textarea::placeholder { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }')
  })

  test('code inside a fenced block takes its own line height', () => {
    expect(quiet).toContain('.md pre code { display: block;')
  })

  test('usage meters fit the Codex label and fade at the ticker edges', () => {
    expect(quiet).toContain('.usage-card { --item: 110px;')
    expect(quiet).toMatch(/\.usage-card \{[^}]*mask-image: linear-gradient\(to right/)
  })
})

const widths = [
  { width: 320, height: 740, name: '320' },
  { width: 640, height: 800, name: '640' },
  { width: 768, height: 1024, name: '768' },
  { width: 1280, height: 800, name: '1280' },
] as const

const long = `unbreakable-${'A'.repeat(180)}`

describe('real shell at phone, tablet and desktop widths', () => {
  let dir: string
  let app: Elysia

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mc-responsive-'))
    process.env.SKD_CONFIG_DIR = dir
    app = await createApp()
  })

  afterEach(async () => {
    delete process.env.SKD_CONFIG_DIR
    await rm(dir, { recursive: true, force: true })
  })

  test('the shipped shell stays inside the viewport on every surface', async () => {
    mkdirSync(scratch, { recursive: true })
    const logPath = join(scratch, 'responsive-launch.log')
    const lines: string[] = []
    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${server.server?.port}`
    try {
      let chromium: typeof import('playwright').chromium
      try {
        chromium = (await import('playwright')).chromium
      } catch (error) {
        lines.push(`launcher error: ${error instanceof Error ? error.message : String(error)}`)
        writeFileSync(logPath, `${lines.join('\n')}\n`)
        return
      }
      let browser: Awaited<ReturnType<typeof chromium.launch>>
      try {
        browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) })
      } catch (error) {
        lines.push(`launcher error: ${error instanceof Error ? error.message : String(error)}`)
        writeFileSync(logPath, `${lines.join('\n')}\n`)
        return
      }
      try {
        for (const run of [1, 2]) {
          for (const size of widths) {
            const page = await browser.newPage({ viewport: { width: size.width, height: size.height } })
            const response = await page.goto(base, { waitUntil: 'domcontentloaded' })
            expect(response?.ok()).toBe(true)
            const report = await page.evaluate(auditSurfaces, long)
            lines.push(`run ${run} ${size.name}: ${JSON.stringify(report.overflows)}`)
            if (size.name === '320' && run === 1) {
              for (const shot of report.shots) {
                await page.evaluate(showShot, { id: shot.id, longText: long })
                await page.screenshot({ path: join(scratch, `responsive-${shot.id}.png`) })
              }
            }
            await page.close()
            expect(report.overflows, `${size.name} run ${run}`).toEqual([])
            expect(report.misses, `${size.name} controls run ${run}`).toEqual([])
            if (size.width === 320) expect(report.expandedCanvas).toBeGreaterThan(200)
          }
        }
        lines.push('both runs passed')
      } finally {
        await browser.close()
      }
    } finally {
      writeFileSync(logPath, `${lines.join('\n')}\n`)
      server.stop()
    }
  }, 180000)
})

type Audit = { overflows: string[]; misses: string[]; expandedCanvas: number; shots: { id: string }[] }

function auditSurfaces(longText: string): Audit {
  const overflows: string[] = []
  const misses: string[] = []
  const doc = document.documentElement
  document.querySelectorAll('.stage > section').forEach(node => { (node as HTMLElement).style.animation = 'none' })
  const stageIds = ['welcome', 'history', 'conversation', 'studio', 'plugin', 'marketplace', 'queue']
  const showStage = (id: string) => {
    const canvas = document.querySelector('.canvas') as HTMLElement
    canvas.dataset.live = 'false'
    canvas.dataset.screen = id === 'studio' ? 'studio' : ''
    document.getElementById('live')!.hidden = true
    const flow = document.getElementById('flow')!
    flow.dataset.open = id === 'flow' ? 'true' : 'false'
    flow.removeAttribute('hidden')
    for (const other of stageIds) {
      const node = document.getElementById(other)
      if (node) node.hidden = other !== id
    }
  }
  const pageFits = (label: string) => {
    const extra = doc.scrollWidth - doc.clientWidth
    if (extra > 1) overflows.push(`${label} page +${extra}`)
    const stage = document.querySelector('.stage') as HTMLElement | null
    if (stage) {
      const stageExtra = stage.scrollWidth - stage.clientWidth
      if (stageExtra > 1) overflows.push(`${label} stage +${stageExtra}`)
    }
  }
  const reachable = (selector: string, label: string) => {
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) {
      misses.push(`${label} missing`)
      return
    }
    const box = el.getBoundingClientRect()
    const vw = doc.clientWidth
    const vh = doc.clientHeight
    const onScreen = box.width > 0 && box.height > 0 && box.left < vw - 1 && box.right > 1 && box.top < vh - 1 && box.bottom > 1
    if (onScreen && box.left >= -1 && box.top >= -1 && box.right <= vw + 1 && box.bottom <= vh + 1) return
    let node: HTMLElement | null = el.parentElement
    while (node) {
      const style = getComputedStyle(node)
      const scrollable = ['auto', 'scroll', 'overlay'].includes(style.overflowX) || ['auto', 'scroll', 'overlay'].includes(style.overflowY)
      if (scrollable && node.clientWidth > 0) {
        const host = node.getBoundingClientRect()
        const inHost = box.right <= host.right + (node.scrollWidth - node.clientWidth) + 1 && box.bottom <= host.bottom + (node.scrollHeight - node.clientHeight) + 1 && box.left >= host.left - node.scrollLeft - 1 && box.top >= host.top - node.scrollTop - 1
        if (inHost) return
      }
      node = node.parentElement
    }
    misses.push(`${label} ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`)
  }

  const shell = document.getElementById('sb-shell')!
  const phone = matchMedia('(max-width: 600px)').matches
  const destinations = ['open-studio', 'toggle-flow', 'open-agents', 'open-attention']
  shell.classList.add('collapsed')
  showStage('welcome')
  const welcome = document.getElementById('welcome')!
  welcome.querySelector('h1')!.textContent = longText
  pageFits('welcome')
  if (!phone) for (const id of destinations) reachable(`#${id}`, id)
  reachable('#message', 'message')
  reachable('button.send', 'send')
  reachable('#project-chip', 'project chip')
  reachable(phone ? '#phone-sessions' : '.sb-strip [data-sidebar-toggle]', 'sidebar toggle')

  showStage('history')
  const history = document.getElementById('history')!
  history.insertAdjacentHTML('beforeend', `<article class="history-item"><p>${longText}</p></article>`)
  pageFits('history')

  showStage('conversation')
  const messages = document.getElementById('messages')!
  messages.innerHTML = `<div class="msg assistant"><div class="msg-body"><div class="md"><p>${longText}</p><pre><code>${longText}</code></pre></div><article class="tool-card"><details class="tool-row" open><summary><svg></svg><svg class="tool-caret"></svg><span class="tool-verb">Ran</span><span class="tool-target">${longText}</span><span class="tool-status">done</span></summary></details></article><article class="diff-card"><header class="diff-head"><span class="diff-path">${longText}</span></header><div class="diff-body"><div class="diff-line"><span class="n">1</span><span class="n">1</span><span class="s">+</span><code>${longText}</code></div></div></article></div></div>`
  pageFits('conversation')

  showStage('welcome')
  const flow = document.getElementById('flow')!
  flow.dataset.open = 'true'
  const flowStage = document.getElementById('flow-stage')!
  flowStage.hidden = false
  flowStage.querySelector('.flow-canvas')!.innerHTML = `<div style="width:2400px;height:80px">${longText}</div>`
  document.getElementById('flow-title')!.textContent = longText
  pageFits('flow')
  flow.dataset.open = 'false'

  const canvas = document.querySelector('.canvas') as HTMLElement
  canvas.dataset.live = 'true'
  document.getElementById('live')!.hidden = false
  for (const id of stageIds) {
    const node = document.getElementById(id)
    if (node) node.hidden = true
  }
  document.getElementById('live-stage')!.innerHTML = `<div class="term-host"><div class="term-bar"><span class="term-bar-name">${longText}</span></div><pre class="term-out">${longText}</pre></div>`
  pageFits('terminals')
  canvas.dataset.live = 'false'
  document.getElementById('live')!.hidden = true

  showStage('studio')
  document.getElementById('studio')!.innerHTML = `<header class="studio-heading"><h1>${longText}</h1><nav><a href="#editor">Editor</a></nav></header><div class="editor-body"><div class="workflow-canvas"><div class="workflow-scroll"><div class="workflow-nodes"><button class="workflow-node" type="button"><strong>${longText}</strong></button><button class="workflow-node" type="button"><strong>Next</strong></button></div></div></div><aside class="step-inspector"><label>Prompt<textarea>${longText}</textarea></label></aside></div><div class="connections-view"><div class="connection-list"><h2>Connections</h2></div><div class="connection-settings"><div class="connection-columns"><div class="field-stack"><label>One<input value="${longText}"></label></div><div class="field-stack"><label>Two<input value="b"></label></div></div></div></div>`
  pageFits('studio')

  showStage('marketplace')
  document.getElementById('marketplace')!.innerHTML = `<div class="mk-board-bar"><span class="mk-folder">${longText}</span></div><div class="mk-cols"><section class="mk-col"><header>Ready</header><article class="mk-card"><strong>${longText}</strong></article></section><section class="mk-col"><header>Doing</header></section><section class="mk-col"><header>Done</header></section></div><div class="mk-dialog"><section><h2>Install</h2><form class="mk-field"><input value="${longText}"></form><footer><button type="button">Cancel</button><button type="button">Add</button></footer></section></div>`
  pageFits('marketplace')

  showStage('queue')
  const flowName = `unbreakable-${'A'.repeat(40)}`
  document.getElementById('queue')!.innerHTML = `<div class="q-list"><article class="q-row"><span class="q-grip"></span><span class="pill-state" data-s="needs">Needs you</span><div class="q-main"><strong>${longText}</strong><div class="q-meta"><span>${flowName}</span></div></div><div class="q-acts"><button class="connection-button" type="button">Open</button><button class="connection-button" type="button">Reply</button><button class="text-button q-remove" type="button">Remove</button></div></article></div>`
  pageFits('queue')

  showStage('plugin')
  document.getElementById('plugin')!.innerHTML = `<div class="plugin-screen"><h1>${longText}</h1><div class="plugin-launch-fields"><label>AI<input value="${longText}"></label><label>Model<input value="claude"></label></div></div>`
  pageFits('plugin')

  showStage('welcome')
  const openMenu = (selector: string, label: string) => {
    const menu = document.querySelector(selector) as HTMLElement | null
    if (!menu) {
      misses.push(`${label} missing`)
      return
    }
    menu.hidden = false
    menu.innerHTML = `<button class="row" type="button"><span>${longText}</span></button>`
    reachable(selector, label)
    pageFits(label)
    menu.hidden = true
  }
  openMenu('#project-menu', '#project-menu')
  openMenu('#model-menu', '#model-menu')
  openMenu('.mention-menu', 'mention')
  openMenu('.chat-slash-menu', 'slash')

  const dialogs: Array<[string, string]> = [
    ['#settings', 'settings'],
    ['#live-launch', 'open terminal'],
    ['#plugin-launch', 'start chat'],
    ['#chat-home', 'chat home'],
    ['#agents', 'agents dialog'],
  ]
  for (const [selector, label] of dialogs) {
    const dialog = document.querySelector(selector) as HTMLDialogElement
    dialog.showModal()
    dialog.querySelectorAll('form[hidden], [hidden]').forEach(node => { (node as HTMLElement).hidden = false })
    const field = dialog.querySelector('input, textarea, button') as HTMLElement | null
    pageFits(label)
    if (field) reachable(`${selector} ${field.tagName.toLowerCase()}`, `${label} field`)
    reachable(`${selector} button`, `${label} action`)
    dialog.close()
  }
  const attention = document.getElementById('attention')!
  attention.hidden = false
  attention.innerHTML = `<header class="nt-head"><h2>Waiting on you</h2></header><div class="nt-list"><article class="nt-item"><div class="nt-top"><strong>${longText}</strong></div><div class="nt-acts"><button class="pill" type="button">Allow</button></div></article></div>`
  pageFits('attention panel')
  reachable('#attention .pill', 'attention action')
  attention.hidden = true

  shell.style.transition = 'none'
  shell.classList.remove('collapsed')
  showStage('queue')
  pageFits('queue sidebar open')
  showStage('studio')
  pageFits('studio sidebar open')
  showStage('welcome')
  openMenu('.mention-menu', 'mention sidebar open')
  openMenu('#model-menu', 'model sidebar open')
  openMenu('.chat-slash-menu', 'slash sidebar open')
  openMenu('#project-menu', 'project sidebar open')
  pageFits('sidebar open')
  if (phone) for (const id of destinations) reachable(`.sb-destinations [data-proxy="${id}"]`, `${id} in drawer`)
  else reachable('#open-studio', 'studio with sidebar')
  reachable('#message', 'message with sidebar')
  reachable('button.send', 'send with sidebar')
  reachable('.sb-open [data-sidebar-toggle]', 'hide sidebar')
  const expandedCanvas = (document.querySelector('.canvas') as HTMLElement).clientWidth
  shell.classList.add('collapsed')

  return {
    overflows,
    misses,
    expandedCanvas,
    shots: ['welcome', 'history', 'conversation', 'flow', 'terminals', 'studio', 'marketplace', 'queue', 'plugin'].map(id => ({ id })),
  }
}

function showShot(arg: { id: string; longText: string }): void {
  const id = arg.id
  const longText = arg.longText
  const stageIds = ['welcome', 'history', 'conversation', 'studio', 'plugin', 'marketplace', 'queue']
  const canvas = document.querySelector('.canvas') as HTMLElement
  const flow = document.getElementById('flow')!
  flow.style.transition = 'none'
  if (id === 'terminals') {
    canvas.dataset.live = 'true'
    document.getElementById('live')!.hidden = false
    document.getElementById('live-stage')!.innerHTML = `<div class="term-host"><div class="term-bar"><span class="term-bar-name">${longText}</span></div><pre class="term-out">${longText}</pre></div>`
    return
  }
  canvas.dataset.live = 'false'
  canvas.dataset.screen = id === 'studio' || id === 'plugin' || id === 'marketplace' || id === 'queue' ? 'studio' : ''
  document.getElementById('live')!.hidden = true
  flow.dataset.open = id === 'flow' ? 'true' : 'false'
  if (id === 'welcome') document.getElementById('welcome')!.querySelector('h1')!.textContent = longText
  if (id === 'history') document.getElementById('history')!.insertAdjacentHTML('beforeend', `<article class="history-item"><p>${longText}</p></article>`)
  if (id === 'conversation') document.getElementById('messages')!.innerHTML = `<div class="msg assistant"><div class="msg-body"><div class="md"><p>${longText}</p><pre><code>${longText}</code></pre></div></div></div>`
  if (id === 'flow') {
    document.getElementById('flow-stage')!.hidden = false
    document.getElementById('flow-canvas')!.innerHTML = `<div style="width:2400px;height:80px">${longText}</div>`
    document.getElementById('flow-title')!.textContent = longText
  }
  if (id === 'studio') document.getElementById('studio')!.innerHTML = `<header class="studio-heading"><h1>${longText}</h1></header><div class="editor-body"><div class="workflow-canvas"><div class="workflow-scroll"><div class="workflow-nodes"><button class="workflow-node" type="button"><strong>${longText}</strong></button></div></div></div><aside class="step-inspector"><label>Prompt<textarea>${longText}</textarea></label></aside></div>`
  if (id === 'marketplace') document.getElementById('marketplace')!.innerHTML = `<div class="mk-board-bar"><span class="mk-folder">${longText}</span></div><div class="mk-cols"><section class="mk-col"><header>Ready</header><article class="mk-card"><strong>${longText}</strong></article></section></div>`
  if (id === 'queue') document.getElementById('queue')!.innerHTML = `<div class="q-list"><article class="q-row"><div class="q-main"><strong>${longText}</strong><div class="q-meta"><span>unbreakable-${'A'.repeat(40)}</span></div></div><div class="q-acts"><button type="button">Open</button><button type="button">Reply</button></div></article></div>`
  if (id === 'plugin') document.getElementById('plugin')!.innerHTML = `<div class="plugin-screen"><h1>${longText}</h1></div>`
  for (const other of stageIds) {
    const node = document.getElementById(other)
    if (node) node.hidden = other !== id && id !== 'flow'
  }
  if (id === 'flow') document.getElementById('welcome')!.hidden = false
  const shown = document.getElementById(id === 'terminals' ? 'live' : id === 'flow' ? 'flow' : id)
  if (shown) { shown.style.animation = 'none'; shown.style.opacity = '1' }
}

const TOUCH_QUERY = `${PHONE_TERMINAL_QUERY}, ${DUO_OPEN_QUERY}`

describe('terminal on touch layouts', () => {
  const touch = mediaBlock(quiet, TOUCH_QUERY)
  const phone = mediaBlock(quiet, PHONE_TERMINAL_QUERY)

  test('every touch media query in quiet.css is one of the exported constants', () => {
    const coarse = [...quiet.matchAll(/@media ([^{]*pointer: coarse[^{]*) \{/g)].map(match => match[1])
    expect(coarse.length).toBeGreaterThan(0)
    for (const query of coarse) expect([PHONE_TERMINAL_QUERY, TOUCH_QUERY, DUO_OPEN_QUERY]).toContain(query)
    expect(quiet.split(`@media ${TOUCH_QUERY} {`)).toHaveLength(2)
  })

  test('the terminal bar is a row above the output, not floating over it', () => {
    expect(touch).toContain('#live .term-bar { position: static;')
    expect(quiet.replace(touch, '')).toContain('.term-bar .term-bar-mobile, .key-row, .live-jump { display: none; }')
    expect(touch).toContain('#live .term-bar .term-bar-mobile { display: grid; width: 44px; height: 44px;')
    expect(touch).toContain('#live .term-bar .term-bar-mobile:is([data-click], [data-sidebar-sheet]) { display: none; }')
    expect(phone).toContain('#live .term-bar .term-bar-mobile[data-sidebar-sheet] { display: grid; }')
    expect(touch).toContain('#live .term-bar-name { flex: 1; min-width: 0;')
  })

  test('the key row and Back to live show with 44px keys that scroll sideways instead of overflowing', () => {
    expect(touch).toContain('.key-row { display: flex; flex: none; flex-wrap: nowrap; overflow-x: auto;')
    expect(touch).toContain('.key-row button { flex: 1 0 44px; min-width: 44px; height: 44px; min-height: 44px;')
    expect(touch).toContain('.live-jump:not([hidden]) { display: inline-flex;')
    expect(touch).toContain('min-height: 44px; padding: 0 16px;')
  })

  test('drop zones, the dot background, Save as workflow and the Git tree hide, and the composer paperclip shows at 44px on touch layouts', () => {
    expect(touch).toContain('.drop-zone, #backdrop, #flow-save, .q-layout [data-layout="tree"] { display: none; }')
    expect(touch).toContain('.touch-only { display: inline-flex; }')
    expect(touch).toContain('.composer #attach-files { width: 44px; flex-basis: 44px; min-height: 44px; }')
  })

  test('on a phone the status is a dot whose label stays readable to screen readers', () => {
    expect(phone).toContain('#live .term-bar-status span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%);')
  })

  test('the pill and keys use cockpit tokens, never a literal colour', () => {
    expect(touch).toContain('background: var(--accent);')
    expect(touch).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })
})

describe('iPhone Duo open', () => {
  const duo = mediaBlock(quiet, DUO_OPEN_QUERY)

  test('a 320px sessions list stays open beside the chat or terminal, with no rail and no hide button', () => {
    expect(quiet.split(`@media ${DUO_OPEN_QUERY} {`)).toHaveLength(2)
    expect(duo).toContain('.sb-shell, .sb-shell.collapsed { grid-template-columns: 320px minmax(0, 1fr);')
    expect(duo).toContain('.sb-shell.collapsed .sb-open { display: contents; }')
    expect(duo).toContain('.sb-shell.collapsed .sb-strip { display: none; }')
    expect(duo).toContain('.sb [data-sidebar-toggle] { display: none; }')
  })

  test('the Waiting panel never reaches over the sessions list', () => {
    expect(duo).toContain('.nt-panel { max-width: calc(100vw - 320px - 24px); }')
  })

  test('the drawer destination rows and the phone Sessions button stay hidden; the desktop toolbar keeps them', () => {
    expect(duo).not.toContain('sb-destinations')
    expect(duo).not.toContain('phone-sessions')
  })
})
