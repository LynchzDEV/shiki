import { LEGACY_STORAGE_COPY } from './legacy-storage'
import { remoteAccessEnabled } from '../local-access'

export type ShellProps = { workspaceDir: string }

const LOCAL_ONLY_NOTE = 'This app answers only on this machine.'
const TAILSCALE_NOTE = 'This app answers on this machine and to the Tailscale users you allow.'

const BODY = `
  <svg class="symbols" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <symbol id="search-icon" viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.7"/><path d="m13 13 4 4"/></symbol>
    <symbol id="plus-icon" viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"/></symbol>
    <symbol id="sidebar-icon" viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M8 4v12"/></symbol>
    <symbol id="history-icon" viewBox="0 0 20 20"><path d="M3 7a7 7 0 1 1-1 5M3 3v4h4M10 6v4l3 2"/></symbol>
    <symbol id="arrow-icon" viewBox="0 0 20 20"><path d="M10 16V4M5 9l5-5 5 5"/></symbol>
    <symbol id="pause-icon" viewBox="0 0 20 20"><path d="M7.5 5v10M12.5 5v10"/></symbol>
    <symbol id="play-icon" viewBox="0 0 20 20"><path d="M7 5.2v9.6a.6.6 0 0 0 .9.5l7.4-4.8a.6.6 0 0 0 0-1L7.9 4.7a.6.6 0 0 0-.9.5Z"/></symbol>
    <symbol id="stop-icon" viewBox="0 0 20 20"><rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none"/></symbol>
    <symbol id="bell-icon" viewBox="0 0 20 20"><path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z"/><path d="M8.5 17a1.6 1.6 0 0 0 3 0"/></symbol>
    <symbol id="agents-icon" viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M11 4v12M6 8h2M6 11h2"/></symbol>
    <symbol id="flow-icon" viewBox="0 0 20 20"><rect x="2" y="7" width="5" height="6" rx="1.5"/><rect x="13" y="2" width="5" height="6" rx="1.5"/><rect x="13" y="12" width="5" height="6" rx="1.5"/><path d="M7 10h3V5h3M10 10v5h3"/></symbol>
    <symbol id="close-icon" viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"/></symbol>
    <symbol id="expand-icon" viewBox="0 0 20 20"><path d="M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5"/></symbol>
    <symbol id="rec-icon" viewBox="0 0 20 20"><path d="M10 2.5v3M10 14.5v3M2.5 10h3M14.5 10h3M4.7 4.7l2.1 2.1M13.2 13.2l2.1 2.1M4.7 15.3l2.1-2.1M13.2 6.8l2.1-2.1"/></symbol>
    <symbol id="spark-icon" viewBox="0 0 24 24"><path d="m14 3 2.4 6.6L23 12l-6.6 2.4L14 21l-2.4-6.6L5 12l6.6-2.4L14 3ZM5 3l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z"/></symbol>
    <symbol id="lock-icon" viewBox="0 0 20 20"><rect x="4" y="8" width="12" height="9" rx="2"/><path d="M7 8V6a3 3 0 0 1 6 0v2M10 11v3"/></symbol>
    <symbol id="back-icon" viewBox="0 0 20 20"><path d="M16 10H4m5-5-5 5 5 5"/></symbol>
    <symbol id="folder-icon" viewBox="0 0 20 20"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H8l1.5 2h6A1.5 1.5 0 0 1 17 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5Z"/></symbol>
    <symbol id="check-icon" viewBox="0 0 20 20"><path d="m5 10.5 3.2 3L15 6.5"/></symbol>
    <symbol id="pencil-icon" viewBox="0 0 20 20"><path d="M12.5 4.5 15.5 7.5 7.5 15.5H4.5v-3Z"/></symbol>
    <symbol id="plan-icon" viewBox="0 0 20 20"><path d="M6 3h8l3 3v11H6z"/><path d="M9 9h5M9 12h5M9 15h3"/></symbol>
    <symbol id="check-circle-icon" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><path d="m7 10 2 2 4-4"/></symbol>
    <symbol id="code-icon" viewBox="0 0 20 20"><path d="m7 6-4 4 4 4M13 6l4 4-4 4"/></symbol>
    <symbol id="eye-icon" viewBox="0 0 20 20"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"/><circle cx="10" cy="10" r="2.5"/></symbol>
    <symbol id="session-icon" viewBox="0 0 20 20"><path d="M4 4h12a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 14h-7l-4 3v-3H4a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 4 4z"/></symbol>
    <symbol id="auto-icon" viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.5 1.5"/></symbol>
    <symbol id="terminal-icon" viewBox="0 0 20 20"><rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="m6 8 2.5 2L6 12M10.5 12H14"/></symbol>
    <symbol id="keyboard-icon" viewBox="0 0 20 20"><rect x="2" y="5" width="16" height="10" rx="2"/><path d="M5 8h1M8 8h1M11 8h1M14 8h1M6 12h8"/></symbol>
    <symbol id="file-icon" viewBox="0 0 20 20"><path d="M5 2.5h6.5L15 6v11.5H5Z"/><path d="M11.5 2.5V6H15"/></symbol>
    <symbol id="clip-icon" viewBox="0 0 20 20"><path d="M15.5 9.5 9.8 15.2a3.7 3.7 0 0 1-5.2-5.2l6.2-6.2a2.5 2.5 0 0 1 3.5 3.5l-6.1 6.1a1.2 1.2 0 0 1-1.7-1.7l5.5-5.5"/></symbol>
    <symbol id="up-icon" viewBox="0 0 20 20"><path d="m5 12 5-5 5 5"/></symbol>
    <symbol id="down-icon" viewBox="0 0 20 20"><path d="m5 8 5 5 5-5"/></symbol>
    <symbol id="settings-icon" viewBox="0 0 20 20"><circle cx="10" cy="10" r="2.5"/><circle cx="10" cy="10" r="5.5"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/></symbol>
    <symbol id="chevron-icon" viewBox="0 0 20 20"><path d="m6 8 4 4 4-4"/></symbol>
    <symbol id="more-icon" viewBox="0 0 20 20"><circle cx="5" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.3" fill="currentColor" stroke="none"/></symbol>
    <symbol id="pin-icon" viewBox="0 0 20 20"><path d="M8 3h4l-.5 4.5L14 10v1.5H6V10l2.5-2.5z"/><path d="M10 11.5V17"/></symbol>
    <symbol id="export-icon" viewBox="0 0 20 20"><path d="M10 3v10M6 9l4 4 4-4M4 16h12"/></symbol>
    <symbol id="trash-icon" viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2M6 6l.8 10h6.4L14 6M8.5 9v4.5M11.5 9v4.5"/></symbol>
    <symbol id="branch-icon" viewBox="0 0 20 20"><circle cx="6" cy="4.5" r="1.8"/><circle cx="6" cy="15.5" r="1.8"/><circle cx="14" cy="7" r="1.8"/><path d="M6 6.3v7.4M14 8.8c0 3-2.5 3.7-8 4.9"/></symbol>
    <symbol id="copy-icon" viewBox="0 0 20 20"><rect x="7" y="7" width="9.5" height="9.5" rx="2"/><path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 4 5v6a1.5 1.5 0 0 0 1.5 1.5H7"/></symbol>
    <symbol id="open-icon" viewBox="0 0 20 20"><path d="M11 4h5v5M16 4l-7 7M14 12v3.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5H8"/></symbol>
    <symbol id="store-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8 5 3.5h10L16.5 8"/><path d="M3.5 8a2.2 2.2 0 0 0 4.3 0 2.2 2.2 0 0 0 4.4 0 2.2 2.2 0 0 0 4.3 0"/><path d="M4.5 10v6.5h11V10"/><path d="M8.5 16.5v-3.5h3v3.5"/></symbol>
    <symbol id="mk-globe" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13M10 3.5c2 2 2.8 4.2 2.8 6.5S12 14.5 10 16.5C8 14.5 7.2 12.3 7.2 10S8 5.5 10 3.5z"/></symbol>
    <symbol id="mk-shield" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M10 3 4.5 5v4.6c0 3.4 2.3 5.9 5.5 7.4 3.2-1.5 5.5-4 5.5-7.4V5z"/></symbol>
    <symbol id="mk-key" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="12.5" r="3.2"/><path d="m9.3 10.2 6.2-6.2M13.2 6.3l1.8 1.8"/></symbol>
    <symbol id="mk-warn" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 17 16H3z"/><path d="M10 8.5v3.5M10 14.2v.1"/></symbol>
    <symbol id="mk-chat" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5z"/></symbol>
    <symbol id="mk-link" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1"/></symbol>
    <symbol id="mk-refresh" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 9A5.5 5.5 0 0 0 5.4 6.5M4.5 11a5.5 5.5 0 0 0 10.1 2.5"/><path d="M5 3.5v3h3M15 16.5v-3h-3"/></symbol>
    <symbol id="q-grip" viewBox="0 0 20 20" fill="currentColor" stroke="none"><circle cx="7.5" cy="5" r="1.3"/><circle cx="12.5" cy="5" r="1.3"/><circle cx="7.5" cy="10" r="1.3"/><circle cx="12.5" cy="10" r="1.3"/><circle cx="7.5" cy="15" r="1.3"/><circle cx="12.5" cy="15" r="1.3"/></symbol>
    <symbol id="q-queue" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="13" height="4" rx="1.3"/><path d="M3.5 11h13M3.5 14.5h9"/></symbol>
    <symbol id="q-clock" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.3 1.4"/></symbol>
  </svg>
  <canvas id="backdrop" class="backdrop" aria-hidden="true"></canvas>
  <div class="sb-shell collapsed" id="sb-shell">
  <aside id="sidebar" class="sb" aria-label="Chats and terminals">
    <div class="sb-open">
      <div class="sb-top"><button type="button" class="sb-icon" data-sidebar-toggle aria-expanded="true" aria-controls="sidebar" aria-label="Hide sidebar" title="Hide sidebar"><svg><use href="#sidebar-icon"/></svg></button><span class="sp"></span><button type="button" id="search" class="sb-icon" aria-pressed="false" aria-label="Search chats" title="Search chats"><svg><use href="#search-icon"/></svg></button></div>
      <nav class="sb-destinations" aria-label="Go to"><button type="button" class="sb-link" data-proxy="open-attention"><svg><use href="#bell-icon"/></svg>Waiting on you<span class="count" data-waiting-count hidden></span></button><button type="button" class="sb-link" data-show="queue"><svg><use href="#q-queue"/></svg>Queue</button><button type="button" class="sb-link" data-proxy="toggle-flow"><svg><use href="#flow-icon"/></svg>Flow</button><button type="button" class="sb-link" data-proxy="open-agents"><svg><use href="#agents-icon"/></svg>Agents</button><button type="button" class="sb-link" data-proxy="open-studio"><svg><use href="#spark-icon"/></svg>Studio</button></nav>
      <button type="button" id="new-chat" class="sb-new"><svg><use href="#plus-icon"/></svg>New chat</button>
      <button type="button" class="sb-new" data-live><svg><use href="#terminal-icon"/></svg>New terminal</button>
      <nav id="sidebar-list" class="sb-list" aria-label="Recent chats and terminals"></nav>
      <div class="sb-foot"><button type="button" id="open-marketplace" class="sb-link"><svg><use href="#store-icon"/></svg>Marketplace</button><button type="button" id="all-history" class="sb-link"><svg><use href="#history-icon"/></svg>All history</button><button type="button" id="open-settings" class="sb-link" data-dialog="settings"><svg><use href="#settings-icon"/></svg>Settings</button></div>
    </div>
    <div class="sb-strip">
      <button type="button" class="sb-icon" data-sidebar-toggle aria-expanded="false" aria-controls="sidebar" aria-label="Show sidebar" title="Show sidebar"><svg><use href="#sidebar-icon"/></svg></button>
      <button type="button" class="sb-icon accent" data-click="new-chat" aria-label="New chat" title="New chat"><svg><use href="#plus-icon"/></svg></button>
      <button type="button" class="sb-icon" data-click="search" aria-label="Search chats" title="Search chats"><svg><use href="#search-icon"/></svg></button>
      <span class="sb-sep"></span>
      <nav id="sidebar-mini" class="sb-mini-list" aria-label="Live chats and terminals"></nav>
      <span class="sp"></span>
      <button type="button" class="sb-icon" data-click="open-marketplace" aria-label="Marketplace" title="Marketplace"><svg><use href="#store-icon"/></svg></button>
      <button type="button" class="sb-icon" data-click="all-history" aria-label="All history" title="All history"><svg><use href="#history-icon"/></svg></button>
      <button type="button" class="sb-icon" data-dialog="settings" aria-label="Settings" title="Settings"><svg><use href="#settings-icon"/></svg></button>
    </div>
  </aside>
  <main class="canvas">
    <header class="toolbar">
      <button type="button" id="phone-sessions" class="round phone-nav" data-sidebar-toggle aria-label="Sessions" aria-controls="sidebar" aria-expanded="false" title="Sessions"><svg><use href="#sidebar-icon"/></svg><span class="count" data-waiting-count hidden></span></button>
      <nav aria-label="Session activity">
        <section class="usage-card" aria-label="Provider usage">
          <div class="usage-track" id="usage-track"></div>
        </section>
        <button id="open-studio" class="pill" type="button" aria-pressed="false">Studio</button>
        <button id="toggle-flow" class="round quiet-control" aria-label="Flow" title="Flow" aria-expanded="false" aria-controls="flow"><svg><use href="#flow-icon"/></svg></button>
        <button id="open-agents" class="round quiet-control" aria-expanded="false" aria-controls="agents" aria-label="Agents" title="Agents"><svg><use href="#agents-icon"/></svg><span id="agents-count" class="count" hidden></span></button>
        <button id="open-attention" class="round quiet-control nt-bell" type="button" aria-expanded="false" aria-controls="attention" aria-label="Waiting on you" title="Waiting on you"><svg><use href="#bell-icon"/></svg><span id="attention-count" class="count" hidden></span></button>
      </nav>
    </header>

    <div class="workspace">
    <div class="chat-container">
    <section id="flow" class="inline-flow" aria-labelledby="flow-title" aria-hidden="true" inert>
      <div class="flow-inner"><div class="flow-card">
        <header class="flow-head">
          <div class="flow-title"><h2 id="flow-title">Session flow</h2><button id="flow-back" class="text-button flow-back" type="button" hidden><svg aria-hidden="true"><use href="#back-icon"/></svg>All flows</button><select id="flow-runs" class="flow-runs" aria-label="Flows in this session" hidden></select><small id="flow-meta" class="flow-meta"></small></div>
          <div id="flow-pills" class="flow-pills"></div>
          <div class="flow-actions"><button id="flow-save" class="pill flow-sm" type="button" hidden>Save as workflow</button><button id="flow-pause" class="round flow-icon-button" type="button" aria-label="Pause" title="Pause" hidden><svg aria-hidden="true"><use href="#pause-icon"/></svg></button><button id="flow-stop" class="round flow-icon-button flow-stop flow-confirm" type="button" aria-label="Stop" title="Stop" hidden><svg aria-hidden="true"><use href="#stop-icon"/></svg></button><span class="term-bar-sep flow-sep" hidden></span><button id="close-flow" class="round" aria-label="Collapse flow"><svg><use href="#close-icon"/></svg></button></div>
        </header>
        <div id="flow-banner" class="flow-banner" role="status" hidden><span class="flow-mark"></span><p></p><div class="flow-banner-actions"></div></div>
        <ol id="flow-rows" class="flow-rows" hidden></ol>
        <div id="flow-stage" class="flow-stage" role="group" tabindex="0" aria-label="Flow graph. Arrow keys pan, plus and minus zoom, 0 fits" hidden><div id="flow-canvas" class="flow-canvas"></div><div class="flow-zoom" hidden><button class="flow-zoom-button" type="button" data-zoom="out" aria-label="Zoom out">&minus;</button><button class="flow-zoom-button" type="button" data-zoom="in" aria-label="Zoom in">+</button><button class="flow-zoom-button" type="button" data-zoom="fit">Fit</button><button class="flow-zoom-button" type="button" data-zoom="follow" aria-pressed="true">Follow</button></div></div>
        <div id="flow-term" class="term-host flow-term" role="region" aria-label="Step output" hidden></div>
        <div id="flow-quick" class="flow-quick" hidden><p class="muted">No flow for this work. The agents run directly.</p><ol id="flow-quick-list"></ol></div>
        <p id="flow-empty" class="flow-empty muted">Your session’s flow will appear here.</p>
      </div></div>
    </section>

    <div class="toast" id="toast" role="status" hidden></div>
    <section id="live" class="live-workspace" aria-label="Live terminals" hidden>
      <div class="live-main" id="live-main">
        <template id="term-bar"><div class="term-bar"><button type="button" class="sb-icon term-bar-mobile" data-sidebar-sheet aria-label="Sessions" title="Sessions"><svg><use href="#sidebar-icon"/></svg></button><span class="term-bar-logo"><img alt=""></span><span class="term-bar-name"></span><button class="term-bar-status" type="button" data-kind="muted" disabled><i></i><span>Connecting…</span></button><span class="term-bar-sep"></span><button class="term-bar-find" type="button" aria-label="Find in this terminal"><svg aria-hidden="true"><use href="#search-icon"/></svg></button><button type="button" class="sb-icon term-bar-mobile" data-click="toggle-flow" aria-label="Flow" title="Flow"><svg><use href="#flow-icon"/></svg></button><button type="button" class="sb-icon term-bar-mobile" data-click="open-attention" aria-label="Waiting on you" title="Waiting on you"><svg><use href="#bell-icon"/></svg></button><button type="button" class="sb-icon term-bar-mobile" data-keyboard aria-label="Keyboard" aria-pressed="false" title="Keyboard"><svg><use href="#keyboard-icon"/></svg></button><button type="button" class="sb-icon term-bar-mobile" data-attach aria-label="Attach files" title="Attach files"><svg><use href="#clip-icon"/></svg></button><div class="find" id="find" hidden><input id="find-input" type="text" placeholder="Find" aria-label="Find in this terminal" autocomplete="off"><span id="find-count" role="status"></span><button class="round" id="find-prev" type="button" aria-label="Previous match"><svg><use href="#up-icon"/></svg></button><button class="round" id="find-next" type="button" aria-label="Next match"><svg><use href="#down-icon"/></svg></button><button class="round" id="find-close" type="button" aria-label="Close find"><svg><use href="#close-icon"/></svg></button></div></div></template>
        <div class="drop-stage" id="drop-stage" data-dragging="false"><div id="live-stage" class="live-stage"></div><div class="drop-zone right" id="drop-right" data-hot="false">Drop to open beside</div><div class="drop-zone bottom" id="drop-bottom" data-hot="false">Drop to open below</div><div class="drop-over" id="drop-over" hidden><svg class="drop-over-icon"><use href="#file-icon"/></svg><strong id="drop-over-title">Drop to add files</strong><small>Their paths are typed at the prompt · up to 100 MB each</small></div><button type="button" id="live-jump" class="live-jump" hidden></button></div>
        <div id="key-row" class="key-row" role="toolbar" aria-label="Terminal keys"><button type="button" data-key="esc">Esc</button><button type="button" data-key="tab">Tab</button><button type="button" data-key="ctrl" aria-pressed="false">Ctrl</button><button type="button" data-key="ctrl-c" aria-label="Control C">^C</button><button type="button" data-key="scroll-up" class="key-scroll" aria-label="Scroll up"><svg aria-hidden="true"><use href="#up-icon"/></svg><small>scroll</small></button><button type="button" data-key="scroll-down" class="key-scroll" aria-label="Scroll down"><svg aria-hidden="true"><use href="#down-icon"/></svg><small>scroll</small></button><button type="button" data-key="left" aria-label="Left">&larr;</button><button type="button" data-key="right" aria-label="Right">&rarr;</button><button type="button" data-key="enter" aria-label="Enter">&#9166;</button><button type="button" data-key="paste">Paste</button></div>
        <div id="term-park" hidden></div>
        <input type="file" multiple id="term-attach-input" hidden>
      </div>
    </section>

    <div class="stage">
      <section id="welcome" class="welcome" aria-labelledby="welcome-title">
        <span class="welcome-mark"><svg><use href="#spark-icon"/></svg></span>
        <h1 id="welcome-title">A little space to build.</h1>
        <p>What would you like to work on?</p>
      </section>

      <section id="history" class="history content-width" aria-labelledby="history-title" hidden>
        <header class="history-heading"><h1 id="history-title">History <span id="history-count"></span></h1><label class="search-field"><svg aria-hidden="true"><use href="#search-icon"/></svg><input id="chat-search" type="search" placeholder="Search history" aria-label="Search history"></label></header>
        <div class="history-list" id="history-list"></div>
        <p id="no-results" class="muted" hidden>Nothing matches. Try another search.</p>
      </section>

      <section id="conversation" class="conversation content-width" aria-label="Conversation" hidden>
        <div id="messages" class="chat" role="log" aria-live="polite"></div>
        <div id="queued" class="queued" aria-label="Queued messages"></div>
      </section>
      <section id="studio" class="studio" aria-label="Workflow Studio" hidden>
        <header class="studio-heading"><div><h1>Studio</h1><p class="muted">Give your AI team a way to work.</p></div><nav id="studio-nav" aria-label="Studio sections"></nav></header>
        <div id="studio-root"></div>
      </section>
      <section id="plugin" class="studio" aria-label="Plugin" hidden></section>
      <section id="marketplace" class="studio" aria-label="Marketplace" hidden></section>
      <section id="queue" class="studio" aria-label="Queue" hidden></section>
      <section id="queue-review" class="studio q-review" aria-label="Pick a design" hidden></section>
    </div>

    <div class="composer-area content-width">
      <div class="popover chip-menu" id="project-menu" role="menu" hidden></div>
      <div class="popover chip-menu model-menu" id="model-menu" role="menu" hidden></div>
      <div class="popover chip-menu" id="mode-menu" role="menu" hidden></div>
      <form id="composer" class="composer nui-neuromorphic-inset">
        <div class="composer-banner" id="composer-banner" hidden><span id="composer-banner-text"></span><button type="button" class="text-button" id="composer-banner-cancel">Cancel</button></div>
        <div id="attach-tray" class="attach-tray" hidden></div>
        <span class="chip-group" id="chip-group" data-expanded="false">
          <button type="button" class="chip" id="project-chip" aria-expanded="false" aria-controls="project-menu" title="Project for this chat"><svg><use href="#folder-icon"/></svg><span id="project-name">Project</span></button>
          <span class="chip-extra chat-chip-extra" id="chip-extra" inert>
            <button type="button" class="chip" id="model-chip" aria-expanded="false" aria-controls="model-menu" title="AI for this chat"><img id="model-logo" src="/providers/claude.svg" alt=""><span id="model-name">Chat default</span><svg class="caret-sm"><use href="#chevron-icon"/></svg></button>
            <button type="button" class="chip chat-mode-chip" id="mode-chip" aria-expanded="false" aria-controls="mode-menu" title="Permission mode for the next reply" hidden><svg><use href="#lock-icon"/></svg><span id="mode-name">My settings</span><svg class="caret-sm"><use href="#chevron-icon"/></svg></button>
            <button type="button" class="chip off" id="edit-chip" aria-pressed="false" title="Let the chat edit directly"><svg><use href="#pencil-icon"/></svg></button>
          </span>
        </span>
        <textarea id="message" rows="1" placeholder="Write a message here…" aria-label="Message" required></textarea>
        <span class="ctx-meter" id="ctx-meter" hidden title="Excludes stopped replies"><svg viewBox="0 0 20 20" aria-hidden="true"><circle class="track" cx="10" cy="10" r="7.5"></circle><circle class="fill" cx="10" cy="10" r="7.5"></circle></svg><span id="ctx-text"></span></span>
        <button type="button" id="attach-files" class="round touch-only" aria-label="Attach files" title="Attach files"><svg><use href="#clip-icon"/></svg></button><input type="file" multiple id="attach-input" hidden>
        <button type="submit" class="round send" aria-label="Send message" title="Send message"><svg><use href="#arrow-icon"/></svg></button>
      </form>
    </div>
    </div>

  <dialog id="agents" class="drawer" aria-labelledby="agents-title">
    <header class="ag-header"><h2 id="agents-title">Agents</h2><span id="agents-summary" class="ag-count"></span><form method="dialog"><button class="round ag-x" aria-label="Close agents" autofocus><svg><use href="#close-icon"/></svg></button></form></header>
    <div id="live-agents" hidden><p id="live-agents-status" class="muted" role="status"></p><div id="live-agents-list"></div></div>
    <div class="activity-empty"><p>No agents yet.</p><p class="muted">They’ll appear here when a session starts.</p></div>
    <section id="flow-agents" class="flow-agents" aria-labelledby="flow-agents-title" hidden><h3 id="flow-agents-title">Flows running</h3><div id="flow-agents-list"></div></section>
    <form id="agent-reply" class="agent-reply" hidden><label for="reply" id="agent-reply-label">Message</label><div class="reply-line"><textarea id="reply" rows="2" placeholder="Add a direction…" required></textarea><button class="round" type="submit" aria-label="Send to this agent"><svg><use href="#arrow-icon"/></svg></button></div></form>
  </dialog>

    </div>
    <section id="attention" class="nt-panel" aria-label="Waiting on you" hidden>
      <header class="nt-head"><h2>Waiting on you</h2><span class="nt-n" id="attention-n" hidden></span></header>
      <div class="nt-off" id="attention-off" hidden><span class="nt-ico"><svg><use href="#bell-icon"/></svg></span><div><strong id="attention-off-title">Mac alerts are off</strong><span id="attention-off-text">Get an alert with buttons when something needs you, even with this tab hidden.</span></div><button class="pill" type="button" id="attention-on">Turn on</button></div>
      <div class="nt-list" id="attention-list" hidden></div>
      <div class="nt-empty" id="attention-empty"><span class="nt-ico"><svg><use href="#check-icon"/></svg></span><strong>Nothing is waiting on you</strong><span>When a chat needs an answer, it shows up here and as a Mac alert.</span></div>
      <footer class="nt-foot" id="attention-foot" hidden><span>Mac alerts on · quiet while you're here</span><button class="text-button" type="button" id="attention-mute">Turn off</button></footer>
    </section>
  </main>
  </div>

  <dialog id="settings" class="access-dialog" aria-labelledby="settings-title"><header class="dialog-heading"><h2 id="settings-title">Settings</h2><form method="dialog"><button class="round" aria-label="Close settings" autofocus><svg><use href="#close-icon"/></svg></button></form></header><div class="field-stack"><label class="switch-label"><input id="theme-dark" type="checkbox" role="switch">Dark theme</label><label class="switch-label"><input id="motion" type="checkbox" role="switch">Background motion</label></div><p class="muted">${LOCAL_ONLY_NOTE}</p><div class="field-stack"><label>Address<input id="access-host" value="" readonly></label>
    <label>API token<span class="token-row"><input id="access-token" value="" readonly aria-describedby="access-token-note"><button type="button" class="text-button" id="access-reveal">Reveal</button><button type="button" class="confirm-morph" id="access-rotate" aria-label="Rotate API token" title="Scripts and the dispatch skill using the current token stop working until they read the new one."><span>Rotate</span><span>Make new token</span></button></span></label><p class="muted" id="access-token-note" role="status">For scripts and the dispatch skill. It grants nothing extra on this machine.</p></div>
    <form id="access-home-form" class="field-stack"><label>Chat home<span class="token-row"><input id="access-home" autocomplete="off" spellcheck="false" placeholder="/Users/you/projects" aria-describedby="access-home-note"><button type="submit" class="text-button">Save</button></span></label><p class="muted" id="access-home-note" role="status"></p></form>
    <div class="field-stack"><label class="switch-label"><input id="access-flow-approval" type="checkbox" role="switch">Ask me before a flow runs</label><p id="access-flow-note" class="muted">When off, flows start as soon as an AI picks them, and big changes apply on their own.</p></div></dialog>
  <dialog id="live-launch" class="access-dialog flat" aria-labelledby="live-launch-title">
    <header class="dialog-heading"><h2 id="live-launch-title">Open terminal</h2><form method="dialog"><button class="round" aria-label="Close terminal launcher"><svg><use href="#close-icon"/></svg></button></form></header>
    <p id="live-error" role="status"></p>
    <form id="live-create" class="field-stack" hidden>
      <label>Workflow<select id="live-workflow" disabled></select></label>
      <div id="live-engine-fields" class="launcher-fields"><label>Engine<select id="live-engine"></select></label><label>Model<input id="live-model" list="live-models" placeholder="Engine default" maxlength="100" autocomplete="off"><datalist id="live-models"></datalist></label></div>
      <label>Working directory<input id="live-cwd" list="live-cwd-recents" placeholder="/path/to/your/project" required autocomplete="off"><datalist id="live-cwd-recents"></datalist></label>
      <button id="live-submit" class="pill">Open terminal</button>
    </form>

  </dialog>

  <dialog id="plugin-launch" class="access-dialog flat" aria-labelledby="plugin-launch-title">
    <header class="dialog-heading"><div><h2 id="plugin-launch-title">Start chat</h2><p class="muted" id="plugin-launch-sub"></p></div><form method="dialog"><button class="round" aria-label="Close" type="submit"><svg><use href="#close-icon"/></svg></button></form></header>
    <p class="muted" id="plugin-launch-error" role="status"></p>
    <div class="mk-ctx" id="plugin-launch-ctx" hidden><span><svg><use href="#file-icon"/></svg></span><strong id="plugin-launch-ctx-name"></strong><small id="plugin-launch-ctx-size"></small></div>
    <form id="plugin-launch-form" class="field-stack">
      <div class="launcher-fields plugin-launch-fields"><label class="mk-field">AI<select id="plugin-launch-engine"></select></label><label class="mk-field">Model<input id="plugin-launch-model" list="plugin-launch-models" placeholder="Engine default" maxlength="100" autocomplete="off"><datalist id="plugin-launch-models"></datalist></label></div>
      <label class="mk-field">Working directory<input id="plugin-launch-cwd" list="plugin-launch-recents" placeholder="/path/to/your/project" required autocomplete="off"><datalist id="plugin-launch-recents"></datalist></label>
      <label class="mk-field">First message (optional)<input id="plugin-launch-message" placeholder="Read the task, then propose a plan"><small class="muted" id="plugin-launch-message-hint" hidden>Type a first message</small></label>
      <button id="plugin-launch-start" class="pill">Start chat</button>
    </form>
  </dialog>

  <template id="assistant-row">
    <div class="msg assistant"><span class="avatar"><svg><use href="#spark-icon"/></svg></span><div class="msg-body"><div class="msg-meta"><strong>Shikidan</strong><time>now</time></div></div></div>
  </template>
  <template id="team-card">
    <article class="team-card"><header><strong>Team for this task</strong><span class="muted"></span><button type="button" class="text-button" data-open-agents>Open in Agents <svg><use href="#open-icon"/></svg></button></header><ol></ol><div class="team-progress" hidden><span></span></div></article>
  </template>
  <dialog id="chat-home" class="access-dialog flat" aria-labelledby="chat-home-title">
    <header class="dialog-heading"><h2 id="chat-home-title">Where do your projects live?</h2><form method="dialog"><button class="round" aria-label="Close" type="submit"><svg><use href="#close-icon"/></svg></button></form></header>
    <p class="muted" id="chat-home-why">The chat runs in one folder that holds your projects. It is never your home folder.</p>
    <form id="chat-home-form" class="field-stack"><label>Folder<input id="chat-home-path" type="text" autocomplete="off" spellcheck="false" required></label><div id="chat-home-candidates" class="home-candidates"></div><p id="chat-home-error" class="muted" role="alert"></p><button class="pill" type="submit">Use this folder</button></form>
  </dialog>
`

export function ShellPage(props: ShellProps): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shikidan</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <script>${LEGACY_STORAGE_COPY}</script>
  <script>try{if(localStorage.getItem('skd.theme')==='dark')document.documentElement.dataset.theme='dark'}catch{}</script>
  <link rel="stylesheet" href="/vendor/xterm.css">
  <link rel="stylesheet" href="/quiet.css">
  <link rel="stylesheet" href="/plugins.css">
  <link rel="stylesheet" href="/js/studio.css">
  <script>window.SKD_WORKSPACE_DIR=${JSON.stringify(props.workspaceDir)}</script>
  <script src="/js/shell.js" type="module" defer></script>
  <script src="/js/shell-composer.js" type="module" defer></script>
  <script src="/js/sidebar.js" type="module" defer></script>
  <script src="/js/chat.js" type="module" defer></script>
  <script src="/js/studio.js" type="module" defer></script>
  <script src="/js/terminals.js" type="module" defer></script>
  <script src="/js/shell-activity.js" type="module" defer></script>
  <script src="/js/flow-drawer.js" type="module" defer></script>
  <script src="/js/job-terminal.js" type="module" defer></script>
  <script src="/js/flow-agents.js" type="module" defer></script>
  <script src="/js/usage-card.js" type="module" defer></script>
  <script src="/js/backdrop.js" type="module" defer></script>
  <script src="/js/access.js" type="module" defer></script>
  <script src="/js/attention.js" type="module" defer></script>
  <script src="/js/plugins.js" type="module" defer></script>
  <script src="/js/queue.js" type="module" defer></script>
</head>
<body>${remoteAccessEnabled() ? BODY.replace(LOCAL_ONLY_NOTE, TAILSCALE_NOTE) : BODY}</body>
</html>`
}
