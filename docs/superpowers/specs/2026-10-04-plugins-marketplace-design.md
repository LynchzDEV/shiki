# Plugins + Marketplace, with ClickUp board as the first plugin

Date: 2026-10-04 · Status: draft for review

## 1. What we are building and why

Mission Control gets a plugin system. Plugins are separate git repos that anyone can write, listed in one or more marketplaces, installed from the app. Work that is specific to one team (KlangTech's ClickUp boards) lives in a plugin instead of the core app.

The first real plugin is **ClickUp board**: pick a ClickUp board, see its tasks in status columns, and start a chat or terminal for any task in one click. The AI in that session starts out already knowing the task: its body, subtasks, comments, linked tasks and custom fields (what the `klangtech-read` skill gathers), for any AI engine.

**Success looks like**
- From the sidebar, open ClickUp board, click Start chat on a card, confirm the pre-filled launcher, and the session's first turn already knows the task. No copy-pasting.
- Another developer can copy the template repo, write a plugin against one documented toolkit, list it in a marketplace, and someone else can install it.
- An isolated plugin cannot read files outside its own folder, cannot read Mission Control's secrets, and cannot reach any website except the ones it declared. This is enforced by the operating system, not by convention.

## 2. Decisions already made (with the user)

| Topic | Decision |
|---|---|
| What "marketplace" means | Real installable plugins from git, not a built-in catalog |
| Repos | Host stays in `mission-control`; separate repos for the SDK, the template, the ClickUp plugin and the marketplace list |
| Runtimes | Two runtimes behind one contract: **trusted** (loaded into Mission Control) and **isolated** (OS sandbox + locked iframe). ClickUp runs isolated; the Hello template demonstrates trusted |
| Task context | The plugin builds the task dossier itself from the ClickUp REST API, so it works for every engine. Not a hand-off to the `/klangtech-read` skill |
| ClickUp access | Personal API token (`pk_…`), stored in the plugin's private settings. The ClickUp MCP is Claude-only and not reachable from the server |
| Choosing a board | Both: browse Workspace → Space → Folder → List, or paste a board-view or list link |
| Session folder | Each saved board remembers a folder; Start opens the normal launcher pre-filled, still editable |
| Write-back to ClickUp | None in v1 (read-only) |
| Refresh | On open + a Refresh button. No background polling (concern 6: no high-frequency jobs) |
| Placement | Variant B: installed plugins are sidebar rows under "Plugins"; Marketplace link in the sidebar footer. Screens as approved in `visualizer/marketplace/` (see its `DECISION.md`) |

## 3. Pieces and where they live

| Repo | Contents |
|---|---|
| `mission-control` (this repo) | Plugin host: install/update/uninstall, both runtimes, permission checks, the host side of the toolkit, Marketplace and plugin screens, terminal-with-first-message, task-context files |
| `mc-plugin-sdk` | `@mission-control/plugin-sdk`: the types and helpers plugin authors import (`definePlugin`, `defineScreen`), the manifest JSON schema, the shared UI stylesheet, and the author guide |
| `mc-plugin-template` | "Hello board": a trusted example plugin. Authors copy it to start |
| `mc-plugin-clickup` | The ClickUp board plugin (isolated) |
| `mc-marketplace` | `marketplace.json`, the list of plugins |

All four new repos live on the user's personal GitHub account, `LynchzDEV`, and are public: `github.com/LynchzDEV/mc-plugin-sdk`, `mc-plugin-template`, `mc-plugin-clickup`, `mc-marketplace`. Creating them is an outward-facing step done at the point the plan reaches it, with the user's go-ahead.

## 4. The plugin contract

### 4.1 Manifest: `mc-plugin.json` at the repo root

```json
{
  "id": "clickup-board",
  "name": "ClickUp board",
  "version": "1.0.0",
  "description": "See a ClickUp board and start a chat or terminal on any task.",
  "pluginApi": 1,
  "runtime": "isolated",
  "icon": "assets/icon.svg",
  "server": "src/server.ts",
  "screen": "src/screen.ts",
  "permissions": {
    "network": ["api.clickup.com"],
    "sessions": ["chat", "terminal"],
    "settings": true
  },
  "settings": [
    { "key": "token", "label": "ClickUp token", "type": "secret", "help": "ClickUp, Settings, Apps, Generate." }
  ]
}
```

Rules, all checked by the host at install time:
- `id`: lowercase letters, digits and dashes, 3–40 characters, unique among installed plugins.
- `pluginApi`: the host supports a list of versions (`[1]` today). Anything else is refused with "This plugin needs a newer Mission Control".
- `runtime`: `"trusted"` or `"isolated"`.
- `server` and `screen` are optional (a plugin may have only one), and must be paths inside the repo.
- `permissions.network`: plain host names only, no wildcards in v1. Only meaningful for isolated plugins; a trusted plugin has full access anyway.
- `permissions.sessions`: a subset of `chat` and `terminal`.
- `settings`: declared fields render in the plugin's Marketplace detail. `secret` fields are masked and never sent back to the screen in full (the screen sees `configured: true`). `toggle` fields render as an on/off switch that saves at once; the stored value is `true` or `false`, absent means off, and any other value is refused.

### 4.2 The toolkit, one API for both runtimes

Plugin authors write the same code for either runtime. Only the plumbing under it differs (section 5).

**Server part** (`src/server.ts`):

```ts
import { definePlugin } from '@mission-control/plugin-sdk/server'

export default definePlugin({
  methods: {
    'board.load': async ({ boardId }, ctx) => { /* … */ },
  },
})
```

`ctx` gives the server part:
- `ctx.settings.get(key)` and `ctx.settings.set(key, value)`: the plugin's own settings, secrets included.
- `ctx.data`: a path to the plugin's private writable folder.
- `ctx.log(...)`: lines appear in the Mission Control server log, prefixed with the plugin id.

**Screen part** (`src/screen.ts`):

```ts
import { defineScreen } from '@mission-control/plugin-sdk/screen'

export default defineScreen((root, mc) => { /* render into root */ })
```

`mc` gives the screen part:

| Call | Does |
|---|---|
| `mc.call(method, params)` | Calls the plugin's own server method |
| `mc.sessions.startChat({ title, cwd, context, prompt? })` | Opens the host's launcher pre-filled (section 7). The user confirms; a plugin can never start a session silently |
| `mc.sessions.startTerminal({ title, cwd, context, prompt? })` | Same, for a terminal |
| `mc.settings.view()` / `mc.settings.set(key, value)` | Reads settings (secrets show only `configured`) and saves them |
| `mc.folders.recent()` | The user's recent working folders, for folder fields |
| `mc.ui.toast(text, kind?)` | A host toast |
| `mc.theme()` + `mc.onTheme(cb)` | Light or dark, so the screen matches |

`context` is `{ name: string, markdown: string }`, capped at 512 KB.

Each call is checked against the manifest. For example, `startTerminal` from a plugin without `sessions: ["terminal"]` is refused with a clear error.

## 5. Runtimes

### 5.1 Trusted

- **Server part:** the host `import()`s the server entry in-process and calls its methods directly.
- **Screen part:** the host builds the screen entry with `Bun.build` (target browser) at install time, then imports the module into the page and calls `mount(root, mc)` with a direct `mc` object.
- **Isolation:** none, the same model as VS Code and Claude Code plugins. The install prompt says so (section 6.3).

### 5.2 Isolated

**Server part:**
- The host spawns `bun <plugin>/src/server.ts` wrapped by **sandbox-runtime** (`@anthropic-ai/sandbox-runtime`, the open-source OS sandbox Claude Code uses; macOS uses `sandbox-exec`).
- Sandbox config:
  - **Network:** `allowedDomains` = exactly `permissions.network`. Everything else is blocked.
  - **Reads:** deny the whole home directory, then allow the plugin folder, the plugin data folder, and Bun's own runtime and cache paths. sandbox-runtime reads are deny-then-allow, so this order matters and must be proven by the spike (section 12).
  - **Writes:** allow only the plugin data folder.
- **Messaging:** the host and the plugin talk JSON-RPC 2.0 over stdin/stdout using `vscode-jsonrpc` (Microsoft, MIT, the library behind the Language Server Protocol). Both directions are supported: the host calls plugin methods, and the plugin calls `settings.get/set` on the host. The plugin process never receives the settings file itself, only the values it asks for.
- **Lifecycle:**
  - Started on the first call, not at boot.
  - Stopped after 10 minutes with no calls. This is a single timer reset on each call, not polling.
  - A call that runs past 30 seconds fails with "The plugin did not answer".
  - A crash fails the in-flight calls with the plugin's last stderr lines. The next call starts a fresh process; after 3 crashes within 5 minutes the plugin is marked "Stopped after repeated crashes" until the user re-enables it.

**Screen part:**
- The plugin's screen bundle is served from the host at `/plugin-frame/<id>/` inside an `<iframe sandbox="allow-scripts">`. There is no `allow-same-origin`, so the frame has an opaque origin: no cookies, no host storage, no access to the host page.
- **CSP:** `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'`. The screen reaches nothing on the network directly; everything goes through `mc`.
- **Messaging:** `mc` is a **Comlink** proxy over `postMessage`. The host verifies `event.source` is that frame's window before acting.
- **Styling:** the frame loads the SDK stylesheet (the host's tokens, cards, buttons and flat fields) and receives theme changes, so isolated screens look native.

### 5.3 Why both, behind one contract

Authors learn one API. Marketplace plugins default to isolated, which is the safe choice. Trusted stays available for plugins that genuinely need deep access, behind an explicit warning. If later we want to isolate trusted plugins too, nothing about the author-facing API changes.

## 6. Marketplaces, install, update, uninstall

### 6.1 Marketplace format: `marketplace.json` in a git repo

```json
{
  "name": "KlangTech marketplace",
  "plugins": [
    { "id": "clickup-board", "repo": "https://github.com/LynchzDEV/mc-plugin-clickup", "ref": "v1.0.0",
      "name": "ClickUp board", "description": "Board + start a session per task", "runtime": "isolated" }
  ]
}
```

The listing is for browsing only. What gets installed and granted always comes from the plugin's own manifest at the pinned `ref`.

### 6.2 Storage under the config dir

The config dir is `~/.config/mission-control`, or `MISSION_CONTROL_CONFIG_DIR` when set. Everything below is created with mode 0700 for folders and 0600 for files.

| Path | Holds |
|---|---|
| `marketplaces/<slug>/` | Shallow clones of the added marketplaces |
| `plugins/<id>/` | The plugin repo checked out at its pinned commit |
| `plugins/<id>/.mc-build/` | The built screen bundle |
| `plugin-data/<id>/settings.json` | Settings, secrets included |
| `plugin-data/<id>/files/` | The plugin's writable folder (`ctx.data`) |
| `plugins.json` | Installed list: `id`, source repo, ref, commit SHA, runtime, granted permissions, `enabled`, installed and updated times |
| `context/<id>/` | Task-context files handed to sessions (section 7) |

`config.json` gains `marketplaces: [{ url }]`.

### 6.3 Install flow

1. The user clicks Install (from a marketplace, or "Install from a git link").
2. The host clones the repo shallowly at the ref into a temp folder and validates `mc-plugin.json` (section 4.1).
3. The host shows the install prompt:
   - **Isolated:** the exact permission list, as approved in the mockup.
   - **Trusted:** the full-access warning; Install stays disabled until "I trust this plugin" is ticked.
4. On Install:
   - Run `bun install --production --ignore-scripts`, so dependency install scripts never run.
   - Build the screen bundle.
   - Move the checkout into `plugins/<id>/` and record it in `plugins.json`.
   - If anything fails, delete the temp folder and leave no half-installed plugin behind.
5. The plugin appears in the sidebar under Plugins.

### 6.4 Update

- **Check for update:** re-fetch the marketplace and compare refs. For direct-link installs, compare the remote ref.
- If the new manifest asks for **more** permissions, the user re-approves with the additions highlighted. The same or fewer permissions update without a prompt.
- Updates never happen automatically.

### 6.5 Uninstall and disable

- **Uninstall:** stop the process, delete `plugins/<id>/` and remove it from `plugins.json`. The user picks whether to keep `plugin-data/<id>/` (default: keep, so the token survives a reinstall).
- **Disable:** the plugin stays installed but its server part is not started, its sidebar row is hidden, and its routes return 409 "This plugin is turned off".

### 6.6 Host HTTP surface

New file `server/routes/plugins.ts`, mounted in `server/index.ts` next to `providersRoutes` and guarded by `requireLocal`. API-token callers are not allowed: `allowToken` stays as is.

| Route | Purpose |
|---|---|
| `GET /api/plugins` | Installed plugins + state |
| `GET /api/plugins/marketplaces`, `POST`, `DELETE` | Manage marketplaces |
| `GET /api/plugins/catalog` | Merged listings |
| `POST /api/plugins/preview` | Clone + validate, returns what the install prompt shows |
| `POST /api/plugins/install`, `POST /api/plugins/:id/update`, `DELETE /api/plugins/:id`, `PATCH /api/plugins/:id` (enable) | Lifecycle |
| `GET/PUT /api/plugins/:id/settings` | Secrets masked on GET |
| `POST /api/plugins/:id/call` | `{ method, params }` forwarded to the plugin's server part |
| `GET /plugin-frame/:id/*` | Isolated screen files, with the CSP above |
| `GET /plugin-module/:id/screen.js` | The trusted screen module |

## 7. Starting a session with task context

**Host change 1: terminals accept a first message.**
- Add `initialPrompt` to `POST /api/terminals` and `CreateTerminalParams` (`server/routes/terminals.ts`, `server/terminals.ts`).
- In `terminalArgs` (`server/terminals.ts:116-129`), append it as the trailing positional argument. claude, glm and codex all take a positional prompt.
- For custom connections, add a `{{prompt}}` placeholder next to `{{model}}` and `{{instructions}}` (`server/terminals.ts:240`). A connection without that placeholder gets no first message, and the launcher says so.

**Host change 2: the launcher accepts a hand-off.**

`mc.sessions.startChat/startTerminal` opens the existing launcher with:
- AI and model as last used,
- the working directory from the call,
- the optional first message,
- a "Task context attached" note with the size and a one-line summary.

On confirm, the host:
1. Writes `context.markdown` to `context/<plugin-id>/<yyyymmdd-hhmmss>-<safe-name>.md` (0600).
2. Starts the session with this first message: `Read the task context in <absolute path> before anything else.` followed by the user's first message if they gave one.
   - **Chat:** `POST /api/jobs` with `purpose: 'chat'` (`client/chat.ts:1008`, `server/routes/jobs.ts:406`).
   - **Terminal:** the new `initialPrompt`.

Using a file rather than pasting the dossier into the message keeps the chat history readable and the terminal command line short. Every engine can read a file by absolute path.

Context files older than 30 days are deleted the next time a context file is written. That is a sweep on write, not a timer.

## 8. Host UI (variant B)

Changes, per `visualizer/marketplace/DECISION.md`:

- **Sidebar** (`client/sidebar.ts`, `server/views/shell.ts`):
  - A "Plugins" group of rows above the day groups, one per enabled plugin with a screen.
  - In the collapsed rail, each plugin's icon joins the strip, following the existing `sb-mini` pattern.
  - A "Marketplace" link in `.sb-foot` before All history.
- **Screens** (`client/shell.ts`): `screens` gains `plugin` and `marketplace`, and `showScreen` sets `data-screen="studio"` behaviour so the composer hides.
  - The plugin screen is one host section holding either the trusted mount root or the isolated iframe, with the Studio-style heading.
  - Marketplace reuses the Manage AIs layout (`connection-list` + `connection-settings` from `client/studio-settings.tsx`) and the approved states: browse, isolated install, trusted install, installed detail with settings, Enabled switch, Check for update, Uninstall, and Open.
- **Empty and error states:**
  - "No plugins yet. Browse the Marketplace."
  - "Couldn't reach this marketplace" with Retry.
  - "This plugin stopped" with the last error and a Restart button.
  - An unsupported `pluginApi` shows "Needs a newer Mission Control".

## 9. The ClickUp board plugin (`mc-plugin-clickup`)

### 9.1 Settings and saved boards

- **Settings:**
  - `token`: a secret.
  - `boards`: `[{ id, name, folder, source }]`, where `source` is `{ kind: 'list', listId }` or `{ kind: 'view', viewId, listId }`.

### 9.2 Server methods (all ClickUp calls happen here)

| Method | ClickUp API v2 calls |
|---|---|
| `token.check` | `GET /user` |
| `tree.load` | `GET /team` → `/team/{id}/space` → `/space/{id}/folder` + `/space/{id}/list` (folderless) → `/folder/{id}/list`, loaded one level at a time as the user expands |
| `link.resolve(url)` | Parses list links (`/v/li/<listId>`) and view links (`/v/b/<viewId>`, `/v/l/<viewId>`); `GET /view/{id}` to learn its name and parent list |
| `board.load(boardId)` | Columns from `GET /list/{id}` (its statuses, in order). Tasks: a view source uses `GET /view/{id}/task` (keeps the view's filters); a list source uses `GET /list/{id}/task?subtasks=false`, all pages |
| `task.dossier(taskId)` | See 9.3 |

**Fallback for limited-release view tasks.** `GET /view/{id}/task` is a limited-release endpoint. If it returns 401, 403 or 404 for this token, the board loads the view's parent list instead and shows "This board shows the whole list; ClickUp didn't let us apply the view's filters."

**Rate limit.** ClickUp allows 100 requests per minute per token. All calls go through one queue with at most 4 in flight. A 429 waits `Retry-After` (or 60 s), then retries once. The board shows "ClickUp is busy, trying again in N s" while it waits.

### 9.3 Dossier (ported from the `klangtech-read` skill's traversal)

Starting from one task, the plugin fetches:
- the task, with `include_subtasks=true`;
- **every subtask re-fetched by id**, because the embedded ones lack description and comments (depth ≤ 3);
- comments (`GET /task/{id}/comment`) and their threaded replies (`GET /comment/{id}/reply`);
- dependencies and linked tasks, plus ClickUp task links found in the description and comments (one hop);
- custom-field values;
- attachments as name + link only, not downloaded in v1.

**Limits:**
- A visited set means no task is fetched twice.
- A cap of 60 fetched tasks. When it is hit, the dossier says "Stopped after 60 tasks", so the AI knows the view is partial.

**Output:** one Markdown file, in this order:
1. Summary
2. Description
3. Fields
4. Subtasks
5. Comments
6. Dependencies and links
7. Attachments
8. a "Gathered at <time> from ClickUp" footer

### 9.4 Screen

As approved in `visualizer/marketplace/board.html`:
- board select, folder chip, Edit board;
- Refresh with "Updated N min ago";
- status columns with cards;
- Start chat / Start terminal on hover and on keyboard focus;
- the first-run token screen, "Pick your first board", and Add a board (Browse / Paste a link, Name, Start sessions in).

**Starting from a card:** the screen calls `task.dossier`, then `mc.sessions.startChat` with `cwd = board.folder`. The card shows "Gathering task…" while it waits.

### 9.5 Permissions

`network: ["api.clickup.com"]`, `sessions: ["chat", "terminal"]`, `settings: true`.

## 10. Errors the user can see

Every failure says what happened and what to do. None is silent.

| Situation | What the user sees |
|---|---|
| Bad or expired token | "ClickUp didn't accept this token" plus the token field |
| Network down | "Can't reach ClickUp" with Retry |
| Board's list was deleted | "This board's list is gone" with Edit board / Remove |
| Plugin process crashed | The section 8 stopped state |
| Sandbox denied something | Logged with the plugin id. The plugin's call fails with "The plugin tried to reach <host>, which it didn't ask for" when the denial is a network block we can attribute |
| Install failed (clone, manifest, `bun install`, build) | The step name and the first error lines; nothing left half-installed |

## 11. Security notes

- **Isolated plugins** never see `secrets.json`, `config.json` or other plugins' data:
  - their settings are served one key at a time over RPC;
  - their screens have no host origin;
  - their network is allow-listed by the OS sandbox.
- **Trusted plugins** have full access. That is the explicit trade, gated by the warning and the trust checkbox.
- **Install hygiene:**
  - `--ignore-scripts` on install;
  - repos pinned to a commit SHA;
  - permission increases need re-consent.
- **Host routes:**
  - `/api/plugins/*` is local-only, with no API-token access;
  - `/api/plugins/:id/call` only reaches enabled, installed plugins, and only methods the plugin's server part exports.
- **Untrusted input:** markdown handed to sessions is plugin output. The session prompt names it as context to read, not instructions from the user.

## 12. Build order

Each step lands, with its tests, before the next starts.

0. **Spike (throwaway, answers yes/no).** Under sandbox-runtime on this Mac:
   - Bun starts.
   - `fetch` to an allowed host works and to another host fails.
   - Reading `~/.config/mission-control/secrets.json` fails while the plugin folder reads fine.
   - `vscode-jsonrpc` works over stdio under Bun.

   If any answer is no, stop and come back with options before building the isolated runtime.
1. **Host foundations:** manifest validation, `plugins.json` store, marketplace fetch, the preview / install / uninstall / update / enable routes, and the settings store.
2. **Trusted runtime + SDK v1:** `@mission-control/plugin-sdk` (server and screen entries, types, stylesheet), the trusted loader, and the Hello board template repo.
3. **Isolated runtime:** sandboxed process with JSON-RPC both ways, lifecycle, the iframe + Comlink bridge, and CSP.
4. **Sessions:** terminal `initialPrompt`, the launcher hand-off, and context files.
5. **UI:** sidebar Plugins group, rail icons, Marketplace link, plugin screen, and Marketplace screen per the decision.
6. **ClickUp plugin:** settings and boards, tree + link resolve, board load with the view fallback, dossier, screen.
7. **Marketplace repo**, and an end-to-end run with a real token.

## 13. Testing

- **Host unit tests** (`bun test`, `test/<name>.test.ts`, route tests via `new Elysia().use(pluginsRoutes(...))` with a temp `MISSION_CONTROL_CONFIG_DIR`, as in `test/chat-routes.test.ts`):
  - manifest rules, including every refusal;
  - marketplace parsing;
  - install from a local `file://` git fixture, success and each failure step with cleanup;
  - permission checks on every `mc` call;
  - re-consent when permissions grow;
  - secrets masked on GET;
  - `terminalArgs` with `initialPrompt` per engine, plus the `{{prompt}}` connection placeholder;
  - context file write, mode and the 30-day sweep.
- **Isolated runtime tests** (integration, macOS):
  - a fixture plugin that reads `secrets.json` gets a denial;
  - a fixture plugin that fetches a non-allowed host gets a denial;
  - an allowed host works;
  - a crash fails in-flight calls;
  - the 3-crash stop rule;
  - the idle shutdown.
- **ClickUp plugin tests** (mocked `fetch`):
  - link parsing for each URL shape;
  - the view-tasks fallback;
  - dossier traversal: subtask re-fetch, visited set, depth limit, 60-task cap, reply threads;
  - 429 handling;
  - board column order.
- **End to end:** install Hello (trusted) and ClickUp (isolated) from a local marketplace, open the board, start a chat and a terminal, and confirm the session's first turn mentions the task. Verified in the real browser, not only by tests.

## 14. Not in v1

- Writing back to ClickUp: status moves, comments.
- Downloading attachments into the dossier.
- Signed plugins, ratings, payments.
- Automatic updates.
- Wildcard network permissions.
- Sandboxing trusted plugins.
- Linux sandboxing (sandbox-runtime supports it; untested here).
- `mctl plugin …` commands.
- A plugin's own sidebar badges or notifications.

## 15. Open items

- **Repo creation timing:** the four repos (`LynchzDEV`, public) are created only when the plan reaches them, with the user's go-ahead.
- **The Section 12 spike result** decides whether the isolated runtime proceeds as written.
