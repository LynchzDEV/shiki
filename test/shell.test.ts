import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { createApp } from '../server/index'

let dir: string
let app: Elysia

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-shell-'))
  process.env.SKD_CONFIG_DIR = dir
  app = await createApp()
})

afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('quiet shell', () => {
  test('/ renders the composer, toolbar controls and the usage card mount', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    for (const marker of ['id="composer"', 'id="new-chat"', 'id="chip-group"', 'id="project-chip"', 'id="model-chip"', 'id="edit-chip"', 'id="project-menu"', 'id="model-menu"', 'id="open-agents"', 'id="toggle-flow"', 'id="usage-track"', 'id="live-launch" class="access-dialog flat"', 'id="live-stage"', 'list="live-cwd-recents"', 'id="live-cwd-recents"','id="drop-stage"', 'id="term-park"', 'id="drop-over"', 'id="toast"', 'id="term-bar"', 'id="find-input"', 'id="backdrop"', 'id="motion"', 'id="messages"', 'id="queued"', 'id="chat-home"', 'id="team-card"', '/js/chat.js', '/js/sidebar.js', 'id="history-list"', 'id="agents-count"', 'id="agent-reply"', 'id="studio"', 'id="studio-root"', '/js/studio.js', 'href="/quiet.css"', 'id="open-studio"', 'id="session-icon"', 'window.SKD_WORKSPACE_DIR=', 'id="flow-stage"', 'id="flow-banner"', 'id="flow-quick"', '/js/flow-drawer.js']) expect(markup).toContain(marker)
    for (const gone of ['id="show-history"', 'data-dialog="session"', 'id="session"', 'id="live-recents"', 'id="new-conversation"', 'id="rail', 'with-rail', 'Design preview', 'id="live-flow']) expect(markup).not.toContain(gone)
    expect(markup).not.toContain('id="tabs"')
    expect(markup).not.toContain('Design preview')
    expect(markup).not.toContain('./vendor/')
    for (const cdn of ['cdn.jsdelivr.net', 'fonts.googleapis.com']) expect(markup).not.toContain(cdn)
  })

  test('/ puts New chat, search and New terminal in the sidebar instead of the toolbar', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    for (const marker of ['id="sidebar"', 'id="new-chat"', 'id="search"', 'data-live', 'id="sidebar-list"', 'id="all-history"']) expect(markup).toContain(marker)
    expect(markup).not.toContain('aria-label="Chats"')
    expect(markup).not.toContain('id="new-chat-menu"')
    expect(markup.indexOf('id="sidebar"')).toBeLessThan(markup.indexOf('<main class="canvas">'))
    expect(markup).toContain('class="sb-shell collapsed"')
  })

  test('the flow header has a back link before the menu, Pause and Stop as icon buttons, a divider, and no Studio button', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    expect(markup).not.toContain('id="flow-studio"')
    expect(markup).toContain('<button id="flow-back" class="text-button flow-back" type="button" hidden><svg aria-hidden="true"><use href="#back-icon"/></svg>All flows</button><select id="flow-runs"')
    expect(markup).toContain('<button id="flow-save" class="pill flow-sm" type="button" hidden>Save as workflow</button><button id="flow-pause" class="round flow-icon-button" type="button" aria-label="Pause" title="Pause" hidden><svg aria-hidden="true"><use href="#pause-icon"/></svg></button><button id="flow-stop" class="round flow-icon-button flow-stop flow-confirm" type="button" aria-label="Stop" title="Stop" hidden><svg aria-hidden="true"><use href="#stop-icon"/></svg></button><span class="term-bar-sep flow-sep" hidden></span><button id="close-flow"')
    for (const symbol of ['pause-icon', 'play-icon', 'chevron-icon', 'back-icon']) expect(markup).toContain(`<symbol id="${symbol}"`)
  })

  test('the All flows list sits between the banner and the graph', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    const at = (marker: string): number => markup.indexOf(marker)
    expect(at('<ol id="flow-rows" class="flow-rows" hidden></ol>')).toBeGreaterThan(at('id="flow-banner"'))
    expect(at('id="flow-rows"')).toBeLessThan(at('id="flow-stage"'))
  })

  test('on a narrow screen the flow actions wrap under the title and a row keeps its graph beside the name', async () => {
    const quiet = await Bun.file(join(import.meta.dir, '../public/quiet.css')).text()
    const narrow = [...quiet.matchAll(/@media \(max-width: 600px\) \{([^@]*)\n\}/g)].map(match => match[1]).join('\n')
    expect(narrow).toContain('.flow-actions { flex: 1 1 100%; flex-wrap: wrap; justify-content: flex-end; }')
    expect(narrow).toContain('.flow-row { grid-template-columns: minmax(0, 40%) minmax(0, 1fr) 16px; gap: 10px; }')
  })

  test('neumo-ui loads once, layered beneath quiet.css', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    expect(markup).not.toContain('href="/vendor/neumo-ui.css"')
    const quiet = await Bun.file(join(import.meta.dir, '../public/quiet.css')).text()
    expect(quiet.startsWith("@import url('/vendor/neumo-ui.css') layer(neumo);")).toBe(true)
  })

  test('the settings dialog states only true facts', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    expect(markup).toContain('<dialog id="settings" class="access-dialog" aria-labelledby="settings-title">')
    expect(markup).toContain('aria-label="Close settings"')
    expect(markup).not.toContain('<dialog id="access"')
    expect(markup).toContain('id="access-host"')
    for (const id of ['access-token', 'access-reveal', 'access-rotate', 'access-home', 'access-flow-approval']) expect(markup).toContain(`id="${id}"`)
    expect(markup).not.toContain('href="/settings"')
    for (const placeholder of ['127.0.0.1:3000', 'Not loaded in this preview', 'Rotate token']) expect(markup).not.toContain(placeholder)
  })

  test('the toolbar reads Studio, Flow, Agents and no longer holds motion or access', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    const toolbar = markup.slice(markup.indexOf('<header class="toolbar">'), markup.indexOf('</header>', markup.indexOf('<header class="toolbar">')))
    const order = ['id="open-studio"', 'id="toggle-flow"', 'id="open-agents"'].map(marker => toolbar.indexOf(marker))
    expect(order.every(index => index > 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    for (const gone of ['id="motion"', 'data-dialog=', 'lock-icon']) expect(toolbar).not.toContain(gone)
  })

  test('History sits above Settings at the bottom of the open and collapsed sidebar', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    const foot = markup.slice(markup.indexOf('class="sb-foot"'), markup.indexOf('</div>', markup.indexOf('class="sb-foot"')))
    expect(foot.indexOf('id="all-history"')).toBeGreaterThan(0)
    expect(foot.indexOf('id="open-settings"')).toBeGreaterThan(foot.indexOf('id="all-history"'))
    const strip = markup.slice(markup.indexOf('class="sb-strip"'), markup.indexOf('</aside>'))
    expect(strip.indexOf('data-dialog="settings"')).toBeGreaterThan(strip.indexOf('data-click="all-history"'))
    expect(strip.indexOf('data-click="all-history"')).toBeGreaterThan(0)
    expect(markup.match(/data-dialog="settings"/g)).toHaveLength(2)
  })

  test('Settings holds the dark theme and background motion switches, and the theme applies before first paint', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    const settings = markup.slice(markup.indexOf('<dialog id="settings"'), markup.indexOf('</dialog>', markup.indexOf('<dialog id="settings"')))
    expect(settings).toContain('<input id="theme-dark" type="checkbox" role="switch">Dark theme')
    expect(settings).toContain('<input id="motion" type="checkbox" role="switch">Background motion')
    const head = markup.slice(0, markup.indexOf('</head>'))
    expect(head.indexOf("localStorage.getItem('skd.theme')")).toBeGreaterThan(0)
    expect(head.indexOf("localStorage.getItem('skd.theme')")).toBeLessThan(head.indexOf('href="/quiet.css"'))
    expect(head.indexOf('skd.legacyCopied')).toBeGreaterThan(0)
    expect(head.indexOf('skd.legacyCopied')).toBeLessThan(head.indexOf("localStorage.getItem('skd.theme')"))
  })

  test('dark theme overrides the palette tokens on the root', async () => {
    const quiet = await Bun.file(join(import.meta.dir, '../public/quiet.css')).text()
    const dark = quiet.slice(quiet.indexOf(':root[data-theme="dark"] {'), quiet.indexOf('}', quiet.indexOf(':root[data-theme="dark"] {')))
    for (const token of ['color-scheme: dark', '--paper:', '--line:', '--muted:', '--text:', '--field:', '--hi:', '--nui-lights:', '--nui-shadows:', '--studio-dots:']) expect(dark).toContain(token)
  })

  test('the shell islands transpile', async () => {
    for (const island of ['shell', 'shell-composer', 'terminals', 'shell-activity', 'flow-drawer', 'usage-card', 'backdrop', 'chat', 'studio', 'access', 'plugins']) {
      const response = await app.handle(new Request(`http://localhost/js/${island}.js`))
      expect(response.status).toBe(200)
      expect((await response.text()).length).toBeGreaterThan(100)
    }
  })

  test('the old tab pages redirect home to the shell and never to a gate', async () => {
    const response = await app.handle(new Request('http://localhost/settings'))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
  })
})

describe('queue screen', () => {
  test('/ has the Queue screen, its island and its icons', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    expect(markup).toContain('<section id="queue" class="studio" aria-label="Queue" hidden></section>')
    expect(markup).toContain('<script src="/js/queue.js" type="module" defer></script>')
    for (const symbol of ['q-grip', 'q-queue', 'q-clock']) expect(markup).toContain(`<symbol id="${symbol}"`)
  })
})

describe('attention delivery', () => {
  test('/ links the Shikidan favicon and the attention island', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    expect(markup).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')
    expect(markup).not.toContain('href="data:,"')
    expect(markup).toContain('<script src="/js/attention.js" type="module" defer></script>')
  })

  test('/ puts the bell after Agents and the Waiting-on-you panel in the canvas', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    for (const marker of ['id="bell-icon"', 'id="open-attention"', 'aria-controls="attention"', 'id="attention-count"', '<section id="attention" class="nt-panel"', 'id="attention-list"', 'id="attention-empty"', 'id="attention-off"', 'id="attention-on"', 'id="attention-foot"', 'id="attention-mute"']) expect(markup).toContain(marker)
    expect(markup.indexOf('id="open-attention"')).toBeGreaterThan(markup.indexOf('id="open-agents"'))
    expect(markup.indexOf('id="open-attention"')).toBeLessThan(markup.indexOf('</header>'))
  })

  test('/sw.js serves the service worker with its click handler, and /favicon.svg serves the icon', async () => {
    const worker = await app.handle(new Request('http://localhost/sw.js'))
    expect(worker.status).toBe(200)
    expect(worker.headers.get('content-type')).toContain('javascript')
    const code = await worker.text()
    expect(code).toContain('notificationclick')
    expect(code).toContain('mc:open')
    const icon = await app.handle(new Request('http://localhost/favicon.svg'))
    expect(icon.status).toBe(200)
    expect(await icon.text()).toContain('<svg')
  })
})

describe('phone sessions drawer', () => {
  test('the toolbar starts with a Sessions button that toggles the sidebar and carries the waiting count', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    const toolbar = markup.slice(markup.indexOf('<header class="toolbar">'), markup.indexOf('</header>', markup.indexOf('<header class="toolbar">')))
    expect(toolbar.indexOf('id="phone-sessions"')).toBeLessThan(toolbar.indexOf('id="open-studio"'))
    expect(toolbar).toContain('id="phone-sessions" class="round phone-nav" data-sidebar-toggle aria-label="Sessions" aria-controls="sidebar" aria-expanded="false"')
    expect(toolbar).toContain('<span class="count" data-waiting-count hidden></span>')
  })

  test('the drawer opens with Waiting, Queue, Flow, Agents and Studio rows', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    const nav = markup.slice(markup.indexOf('<nav class="sb-destinations"'), markup.indexOf('</nav>', markup.indexOf('<nav class="sb-destinations"')))
    expect(markup.indexOf('<nav class="sb-destinations" aria-label="Go to">')).toBeGreaterThan(markup.indexOf('<div class="sb-open">'))
    expect([...nav.matchAll(/data-proxy="([^"]+)"/g)].map(match => match[1])).toEqual(['open-attention', 'toggle-flow', 'open-agents', 'open-studio'])
    expect(nav.match(/data-show="queue"/g)).toHaveLength(1)
    expect(nav.indexOf('data-show="queue"')).toBeLessThan(nav.indexOf('data-proxy="toggle-flow"'))
    expect(nav).toContain('data-waiting-count')
  })
})

describe('phone held sideways', () => {
  const termBar = (markup: string): string => markup.slice(markup.indexOf('<template id="term-bar">'), markup.indexOf('</template>', markup.indexOf('<template id="term-bar">')))

  test('the terminal bar carries Sessions before the name and Flow, bell and Keyboard after Find', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    const bar = termBar(markup)
    const order = ['data-sidebar-sheet', 'class="term-bar-logo"', 'class="term-bar-name"', 'class="term-bar-status"', 'class="term-bar-find"', 'data-click="toggle-flow"', 'data-click="open-attention"', 'data-keyboard'].map(marker => bar.indexOf(marker))
    expect(order.every(index => index > 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(bar.match(/class="sb-icon term-bar-mobile"/g)).toHaveLength(4)
    expect(bar).toContain('aria-label="Keyboard" aria-pressed="false"')
    expect(markup).toContain('<symbol id="keyboard-icon"')
  })

  test('the key row reads Esc, Tab, Ctrl, Ctrl-C, scroll up, scroll down, left, right, Enter, Paste', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    const row = markup.slice(markup.indexOf('<div id="key-row"'), markup.indexOf('</div>', markup.indexOf('<div id="key-row"')))
    expect(row).toContain('class="key-row" role="toolbar" aria-label="Terminal keys"')
    const keys = [...row.matchAll(/data-key="([^"]+)"/g)].map(match => match[1])
    expect(keys).toEqual(['esc', 'tab', 'ctrl', 'ctrl-c', 'scroll-up', 'scroll-down', 'left', 'right', 'enter', 'paste'])
    expect(row).toContain('data-key="ctrl" aria-pressed="false"')
    expect(markup.indexOf('<div id="key-row"')).toBeGreaterThan(markup.indexOf('id="drop-stage"'))
    expect(markup.indexOf('<div id="key-row"')).toBeLessThan(markup.indexOf('id="term-park"'))
  })

  test('the Back to live pill starts hidden inside the terminal stage', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    const stage = markup.slice(markup.indexOf('id="drop-stage"'), markup.indexOf('id="term-park"'))
    expect(stage).toContain('<button type="button" id="live-jump" class="live-jump" hidden></button>')
  })
})
