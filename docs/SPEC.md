# Shikidan 2.0 — Multi-Engine AI Command Center

One continuous chat to the three-engine setup — Claude Code (Anthropic), GLM lane (z.ai coding plan via
an Anthropic-compatible endpoint), Codex CLI (ChatGPT Pro plan) — plus live terminals, a workflow
Studio, and a History of everything that ran. There is no login, no lanes/dispatch/review/settings
tabs, and no terminal-as-transcript mode: those pages were retired in 2.0 in favor of the chat and a
`/js`-served single-page shell. This file is the engineering contract, derived from the code in
`server/`, not from the product narrative in `docs/decisions/system-chat.md` (read that for intent;
read this for mechanics).

## Stack (fixed — do not substitute)

- Runtime: **Bun**, TypeScript executed natively — no build step, no bundler for the server.
- Backend: **Elysia** (`server/index.ts` mounts one `Elysia` app per route module) + `@elysiajs/static`
  for `public/`; websockets via Elysia's built-in `ws` (the terminal bridge only); SSE via a
  hand-rolled `ReadableStream` (`createLogStreamResponse` in `server/routes/jobs.ts`).
- Terminals: `bun-pty` (`spawn`/`IPty`), not `node-pty` directly, even though `node-pty` is still a
  listed dependency.
- No database. JSON / JSONL files under `~/.config/shikidan/` (see **Data**), mode 0700 for
  the directory, 0600 for files.
- No password, no session cookie. Access is gated by request origin (`server/local-access.ts`) plus
  an optional Bearer API token for a scoped subset of endpoints (see **Security model**).
- Frontend: one server-rendered shell (`server/views/shell.ts`) plus browser-side TypeScript islands
  under `client/*.ts`/`.tsx`, transpiled on request by `GET /js/:file` (`Bun.build`, in-memory,
  cached by a hash of every `client/*.{ts,tsx}` file's mtime+size — no `dist/` on disk, no `.js`
  files committed to the repo).
- Tests: `bun test` (68 files under `test/`, see **Tests**).

## Directory layout

```
shiki/
  server/
    index.ts              # Elysia bootstrap: route mounting, retired-page redirects, /js transpiler
    auth.ts                # requireLocal guard + allowToken (Bearer scope) + verifyBearerToken
    local-access.ts        # origin/host checks requireLocal and the terminal WS build on
    secrets.ts             # ~/.config/shikidan/{secrets,config}.json, API token
    workspace.ts           # validateWorkspaceCwd: must resolve under $HOME (+ optional git check)
    engines.ts             # claude/glm/codex definitions, env builders, binary resolution
    jobs.ts                # JobManager: spawn, persist (jobs.jsonl), log tail, worktree land
    jobs-engine-iface.ts   # EngineResolver contract + realEngineResolver (argv/env per engine)
    threads.ts             # job-thread chain assembly (a chat or a reply thread is a list of jobs)
    chat-queue.ts          # <configDir>/chat-queue.json: queued user messages, per chat
    chat-reports.ts        # createChatFlusher: folds queued messages + agent reports into chat turns
    chat-profile.ts        # CHAT_RULES system prompt text + the chat's slim Claude profile
    chat-home.ts           # derives/validates the one folder every chat runs in
    worker-profile.ts      # slim CLAUDE.md/settings.json profile headless jobs spawn under
    workflows.ts           # workflow graph schema (zod) + on-disk revisioned store
    workflow-runner.ts     # executes a workflow graph as a chain of jobs, one node at a time
    workflow-builder.ts    # "describe a workflow in English" designer, backed by a throwaway job
    terminals.ts           # bun-pty sessions + ring buffer + ws bridge for xterm.js
    plans.ts / plan-runner.ts / flow.ts / archive.ts   # the Flow side panel (see below)
    routes/*.ts            # one Elysia sub-app per concern, all mounted from index.ts
  server/views/shell.ts    # the one HTML shell; <script> tags name the client islands
  client/                  # browser islands, TypeScript (+ 2 .tsx files for Studio)
  public/                  # quiet.css, neumo-ui.css, vendor/ (xterm, textmode, anime), fonts, provider svgs
  skills/skd-dispatch/      # orchestration skill shipped with the repo, symlinked into ~/.claude/skills
  docs/
    SPEC.md
    decisions/system-chat.md   # product source of truth for the chat
  package.json
```

## Security model

There is no auth database, no password, no cookie session. Every request is judged by where it came
from:

- `server/local-access.ts` — `localRequestAllowed(request)`: the `Host` header must resolve to
  `127.0.0.1`, `localhost`, or `[::1]`; if an `Origin` header is present it must match that host; if
  `Sec-Fetch-Site` is present it must be `same-origin`/`none`, unless the request is a top-level page
  navigation (`GET`, `sec-fetch-mode: navigate`, `sec-fetch-dest: document`, and not under `/api/` or
  `/ws/`) — this is what lets a human open `http://127.0.0.1:7777/` directly.
- `server/auth.ts` — `requireLocal(ctx)`: the guard every `/api/*` Elysia sub-app registers via
  `.onBeforeHandle(requireLocal)`. It allows the request if `localRequestAllowed` passes, **or** if
  the path+method is in the Bearer-token allowlist (`allowToken`) and the request carries
  `Authorization: Bearer <token>` matching the token in `secrets.json` (`verifyBearerToken`, constant-time
  compare). Otherwise `403 { error: 'local access only' }`.
- `allowToken(pathname, method)` scopes what a script (the skd-dispatch skill, a chat agent's `curl`)
  may reach with only the token, no browser origin: GET or POST anywhere under `/api/jobs*` (not
  PATCH/DELETE — this is how a chat's own spawned agents and the chat itself call back into the
  cockpit for everything except renaming itself or deleting a queued message), GET-only on
  `/api/flow`, `/api/quota`, `/api/meta`, `/api/roles`, `/api/models`, `/api/providers`,
  `/api/studio/workflows` (and its `.../revisions`), and `/api/studio/policy` (but *not*
  `/api/studio/policy/revisions`, which the allowlist doesn't cover), GET+POST on `/api/studio/runs`
  and GET on `/api/studio/runs/:id`, POST on `/api/studio/runs/:id/(stop|retry)`, and POST/PATCH/GET on
  the `/api/flow/:label/plan`, `/run`, `/archive`, `/unarchive` family. Nothing else accepts a token —
  secrets, terminals, Studio connections/drafts, and history stay browser-origin only.
- The terminal WebSocket (`WS /ws/terminal/:id`) has its own guard: `localRequestAllowed(request) &&
  sameOrigin(request)`, no token bypass at all.
- `GET /`, `GET /api/health`, and the retired-page redirects check `localRequestAllowed` directly
  (not `requireLocal`) and return the same `403 { error/text: 'local access only' }` shape. `GET
  /js/:file` and the `public/` static plugin (`@elysiajs/static`) carry **no** guard — they only ever
  serve compiled client bundles, CSS, fonts, and vendor JS, never secrets.
- `cwd` for any job, terminal, or chat project must resolve (via `realpath`) under `$HOME`
  (`server/workspace.ts` `validateWorkspaceCwd`); jobs additionally require a git repository unless
  `purpose === 'chat'`. Secrets are never passed as CLI argv (only via `env`); job logs are redacted
  on every read (`server/log-redaction.ts`) against the z.ai token and the API token.
- Server binds `127.0.0.1` only; the port is `SKD_PORT` or `7777`
  (`server/secrets.ts` `listenTarget`). Startup probes that port and refuses to run if something
  already answers `/api/health` (no double-bind).

## Config and secrets (`server/secrets.ts`)

`~/.config/shikidan/secrets.json` (0600): `{ zaiAuthToken, zaiBaseUrl, apiToken }`. The API
token (`mct_<48 hex>`) is generated on first read (`readApiToken`) and never echoed except through
`POST /api/secrets/api-token/reveal`; API responses otherwise report only `configured: boolean`
flags (`publicView`).

`~/.config/shikidan/config.json`: `{ roles: EngineRoles, fallback: RoleAssignment | null,
autoReview: boolean, chatHome: string | null }`. `EngineRoles` is `{ plan, execute, review }` plus up
to 21 more named roles (identifiers, never `autoReview` or `fallback`), each `{ engine, model }`.
Studio's default workflow and auto-review read the three built-ins (`DEFAULT_ROLES`: plan → claude,
execute → glm, review → codex); a flow step may name any role. `fallback` is the AI a step uses when
its role is not defined or its own AI cannot start; absent means `{ engine: 'claude', model: null }`,
`null` turns it off. `GET/POST /api/roles` reads and writes roles, `autoReview` and `fallback`.

## Engines (`server/engines.ts`)

`ENGINE_NAMES = ['claude', 'glm', 'codex']`. `claude` and `glm` both run the `claude` binary; `glm`
overlays `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` (from secrets) plus a pinned model
(`GLM_MODEL = 'glm-5.3[1m]'`) on `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` and a 1M-token compact
window; `codex` runs the `codex` binary with no overlay (its own OAuth on disk). `buildEnv(engine,
{worker})` starts from a copy of `process.env` with the parent's own Claude-session identity
variables stripped (`PARENT_CLAUDE_SESSION_VARS`, so a cockpit started from inside a Claude session
never leaks that session's identity to what it spawns), applies the engine overlay, and — for
`worker: true` (headless jobs only, not terminals) — layers in the isolated worker profile env
(`CLAUDE_CONFIG_DIR`/`CODEX_HOME`, see **Worker profiles**). `resolveBinary` falls back to
`mise`/homebrew/`~/.bun/bin`/`~/.local/bin` when the launching environment's `PATH` is thin
(launchd, cron). `SKD_FAKE_ENGINES=1` substitutes `/bin/echo`/`/bin/sh` stubs for tests and UI dev.

### Worker profiles (`server/worker-profile.ts`)

Headless jobs get a slim, isolated config under the config dir — `worker-claude/` (`CLAUDE.md`: the
worker contract — implement in-tree, never call the cockpit API, run only touched tests while
iterating, comments capped at one line, stop when acceptance criteria are met; `settings.json`:
`bypassPermissions`) and `worker-codex/` (`config.toml`: `approval_policy = "never"`, `sandbox_mode =
"danger-full-access"`, with `auth.json` symlinked to `~/.codex/auth.json` when present). Rewritten
from constants on every server start. `claude`-engine jobs keep the user's full personal profile (no
env change); `glm` jobs get `CLAUDE_CONFIG_DIR=worker-claude/`; `codex` jobs get
`CODEX_HOME=worker-codex/` and always pass `--dangerously-bypass-approvals-and-sandbox`. Terminals
never get this treatment — they always run with the user's own full profile.

### Engine asset parity (`server/engine-assets.ts`, `server/codex-translate.ts`)

Every server start best-effort syncs `~/.claude` → `~/.codex` so Codex sees an equivalent
`AGENTS.md` (translated from the handwritten portion of `CLAUDE.md`, minus Claude-only machinery),
translated `SKILL.md`/agent `.toml` files for anything not too Claude-specific (a 30% Claude-residual
threshold skips the rest), and moves aside anything it would overwrite under
`~/.codex/backup/*.pre-shikidan-<timestamp>`. Failures are logged, never thrown.

### Skill install (`server/skill-install.ts`)

Every server start also symlinks each directory under the repo's `skills/` (currently just
`skd-dispatch`) into `~/.claude/skills/`, so the orchestration skill updates with a plain `git pull` —
no separate install step. An existing non-symlink at the target is moved aside to
`~/.claude/skills-backup/<name>.pre-shikidan-<timestamp>` first, and an already-correct symlink
is left alone.

## Quota, models, and providers

- **Quota** (`server/quota.ts`, `GET /api/quota`): **Claude** reads `~/.cache/ccstatusline/usage.json`
  when it's under 12h old, else falls back to `npx ccusage@latest blocks --json --breakdown` (then
  `daily --json --breakdown`), memoized 15 minutes; **GLM** calls `{zaiBaseUrl origin}/api/monitor/
  usage/quota/limit` with the z.ai token to read a `TOKENS_LIMIT` percentage (five-hour) and a
  `TIME_LIMIT`/credit-row percentage (monthly); **Codex** runs `codex login status` for `authed` plus
  `server/codex-limits.ts` (`readCodexLimits`) for its own weekly-only usage window (no five-hour
  limit exists for Codex). `glmPeak(now)` flags GLM's Mon–Fri 14:00–18:00 UTC+8 peak-credit window and
  how many minutes until it changes. `GET /api/sessions/external` (`fetchExternalSessions`) scans
  `ps -axo pid,etime,command` for `claude`/`codex` processes this server didn't spawn, with a
  best-effort `lsof` cwd hint. Both are cached 60s server-side (`createQuotaCache`); `server/meta.ts`
  derives the toolbar's block-progress clock from Claude's `resetsAt` and a linear-regression
  tokens-per-minute estimate (`GET /api/meta`).
- **Models** (`server/models.ts`, `GET /api/models`, cached 5 min): `claude` = the fixed tier aliases
  (`fable|opus|sonnet|haiku`); `codex` = slugs read from `~/.codex/models_cache.json` (the Codex CLI
  refreshes this itself; a static list is the fallback); `glm` = `GET {zai origin}/api/anthropic/v1/
  models` with the z.ai token (5s timeout, `GLM_MODEL` pinned first, static fallback without a token or
  on failure); plus each custom connection's own configured model list.
- **Providers** (`server/providers.ts`, `GET /api/providers`): the three built-ins plus every custom
  connection, each `{id, name, builtin, models, resumable, family}` — `resumable` is true for every
  built-in and for a `cli` connection whose args include a `{{session}}` slot.

## Jobs (`server/jobs.ts`) — headless dispatch, the substrate everything else is built on

A `JobRecord` is the unit of work: an id, `engine`, `cwd`, `label`, `prompt`, `pid`, `status`
(`running|done|failed`), timestamps, `sessionId` (scraped from the CLI's own output as it runs),
`threadRoot` (itself, unless it's a reply — see **Threads**), and optional fields used by the
features layered on top: `worktree`/`baseRepo`/`baseBranch` (isolated git worktree), `workflowRunId`/
`workflowNodeId`/`workflowAttempt` (a Studio run step), `purpose` (`'workflow-design' | 'chat'`),
`chatId`/`chatTurn`/`reason` (an agent spawned by or reporting to a chat), `edit`/`source`
(`'user'|'agent'`, chat-only), `project`, `titleLocked`, `reviewOf` (a cross-family review job),
`stoppedAt`/`landedAt`, `reportedAt` (`number | null`, chat-linked jobs only — `null` until its
report has gone into a chat turn; see **The chat**).

- `createJob(params, resolver)` validates `cwd` (git required unless `purpose==='chat'`), enforces a
  **3-attempts-per-step retry cap** for chat-spawned work (`stepAttempts`: same `chatId`+`label`,
  not itself a review, counted only at thread-root — a 4th attempt is `409 'retry cap reached for
  this step'`), checks the `cwd`/worktree isn't owned by a different running workflow, optionally
  prepares a worktree (`server/job-worktrees.ts`: `.worktree/<sanitized-label>` on a branch off
  current `HEAD`), spawns via the `EngineResolver`, and persists a `JobRecord` (append to
  `jobs.jsonl`, compacted back to one line per id once the file passes 5000 lines).
- Every process gets `SKD_JOB_ID`; chat processes additionally get `SKD_URL`, `SKD_TOKEN` (the API
  token), `SKD_CHAT_ID` (`threadRoot`), `SKD_CONFIG_DIR`.
- A non-chat `POST /api/jobs` prompt targeting the configured **execute** role's engine is checked by
  `server/spec-lint.ts` (`lintSpec`): it must have `## Decisions`/`## Preserve`/`## Steps` headings (or
  an `execute tasks N..M of <plan file>` line), an explicit "Done means all of these hold" acceptance
  line, no hedge words (`as appropriate`, `whichever`, …) in Decisions/Steps, and every step must name
  a file path — a miss is `422 { error, misses }`. The same check runs on each task of a
  `POST /api/flow/:label/run` before it starts.
- The manager tails each job's log file (not its stdio pipes, so state survives a server restart —
  `adoptOrphan` re-attaches to any `status: 'running'` record found on disk whose pid is still
  alive at startup, or settles it immediately if not) to derive `turns`, `lastTool`, a throttled
  `currentActivity` line, and the session id — all parsed from the engine's own JSON-lines output by
  `server/activity.ts`, the shared log-parsing vocabulary (`ActivityEvent`s: tool/text/thinking/
  result/error) that `threads.ts`, `chat-reports.ts` and `session-transcript.ts` all build on.
- `landJob(id)`: for a worktree job, commits any dirty worktree state, cherry-picks (never merges)
  the branch's commits oldest-first onto the base branch (which must still be the branch checked out
  at worktree-creation time), removes the worktree and branch, marks the job reviewed. A conflict
  aborts the cherry-pick and returns `409 { error: 'cherry-pick conflict', files }`, preserving the
  worktree for manual resolution.
- `killJob`: SIGTERM, SIGKILL after 5s if still alive.
- **Threads** (`server/threads.ts`): a reply (`POST /api/jobs/:id/reply`) is a new `JobRecord` with
  the same `threadRoot` as its parent. `threadChain` sorts every job sharing a root by start time,
  independent of `parentJobId` links, so the chain stays intact even if a parent record goes missing.
  `replySessionId` walks the chain backward for the newest known `sessionId` (what a reply resumes).
- **Auto-review** (`server/auto-review.ts`, opt-in via `config.autoReview`, default off): a finished,
  non-chat, non-workflow job on the configured `execute` engine with a non-empty diff and no existing
  review spawns one cross-family review job on the configured `review` engine, scoped to only the
  diff (forbids repo scans and test runs), first line `SHIP`/`NO-SHIP`.

## The chat

The chat is a job thread like any other (`purpose: 'chat'`), talking to whichever connected AI is
resumable. Product intent is in `docs/decisions/system-chat.md`; this section is the mechanics.

- **Starting one**: `POST /api/jobs` with `purpose: 'chat'` requires an engine that can resume a
  session (`engineSupportsResume`) and, if `project` is given, validates it under real `$HOME` (not
  yet under Chat home at creation — only the later `PATCH` enforces Chat-home containment). No
  `label` is required; it defaults to the first line of the prompt, truncated to 60 chars
  (`chatTitle`).
- **Chat home** (`server/chat-home.ts`): the one folder every chat runs in and never leaves. `chatHome`
  prefers the configured path (`config.json.chatHome`) if it resolves under real `$HOME`; otherwise
  it derives the deepest shared ancestor (`sharedRoot`) of every known job/terminal directory, and
  reports `{ ok: false, reason: 'none' | 'home' }` with candidates when there's no history or the
  only shared root is `$HOME` itself (`GET/PUT /api/chat/home`).
  Project inside a chat (`PATCH /api/jobs/:id` `{project}`) must resolve under Chat home
  (`projectInChatHome`), matching the model where the chat's own working tree never moves (Claude
  sessions are stored per-folder) but the project it discusses can be anywhere under Chat home; a
  chat-spawned agent is created with `worktree: true` under that project by whatever spawns it.
- **System prompt** (`server/chat-profile.ts`): `chatRules(context)` appends the chat's id, Chat
  home, current project (or "not chosen yet"), an edit-permission line, and — if a project is set —
  a `## Recent work in this project` memory block, onto the fixed `CHAT_RULES` text. `CHAT_RULES`
  states: no plan step unless asked; what needs no permission (read/search/answer, spawn/reply-to/
  stop its own agents, retry a failed step up to 3 attempts total, land reviewed work); what always
  needs the owner's click (push, deploy, anything touching production, deleting outside a worktree —
  and it is told never to push); the cockpit API surface it may call with `$SKD_URL`/`$SKD_TOKEN`/
  `$SKD_CHAT_ID`/`$SKD_JOB_ID` (all injected into its env, never invented); the fixed rule that any code
  change gets a cross-family review before landing; retry cap and title-renaming instructions. This
  is prompt text, not server-enforced logic, except where noted (the retry cap and the resume
  requirement ARE enforced server-side in `jobs.ts`).
- **Direct edits**: `editRule` in `chat-profile.ts` — Codex chats are always told every change goes
  through an agent (no direct-edit toggle exists for Codex); other engines get a rule permitting or
  forbidding direct file writes (including via shell) based on the chat's `edit` flag, scoped to the
  chosen project.
- **Shared memory** (`projectMemory` in `server/chat-reports.ts`): up to 8 other chat roots and 8
  other non-chat jobs in the same project (excluding the current chat), each summarized to one line
  (title/relative day/last text, or agent label+status), fed into `coreRules` on job creation
  (`chatSpawnContext` in `jobs.ts`) and into report turns.
- **Message queue** (`server/chat-queue.ts`): queued **user** messages persist in
  `<configDir>/chat-queue.json` (`{ items: [{id, chatId, text, queuedAt}] }`, atomic write).
  `POST /api/jobs/:id/reply` on a chat thread that is already replying no longer rejects the
  message: it appends to the queue and returns `202 { queued: true, item }`. On an idle chat it
  still starts the turn immediately, but first pulls and prepends any items already queued for that
  chat (`queue.take`), so nothing sent while the chat was busy is lost or reordered; if the spawn
  fails the pulled items are put back (`queue.restore`). `GET /api/jobs/:id/queue` (resolves `:id` to
  its thread root) lists queued items; `DELETE /api/jobs/:id/queue/:itemId` removes one.
- **Reports** (`createChatFlusher` in `server/chat-reports.ts`, replacing the earlier
  `createReportPoster`): whether a chat agent needs reporting is a property of the job record, not
  of in-memory state — `needsReport(job)` is true when it has a `chatId`, is settled
  (`status !== 'running'`), isn't a workflow step (`!workflowRunId`), and `reportedAt === null`
  (legacy jobs from before this field existed count as already reported, so an upgrade doesn't
  replay history). This is why reports survive a restart with no separate store. Each chat has one
  serial flush chain (`kick`); a flush builds **one turn** out of everything currently due — every
  queued user message (joined by a blank line) followed by every unreported agent's report
  (`agentReport`: `[agent <label> · <engine>] <outcome>` + last text + diff stat), and marks the
  included agents `reportedAt` once the turn is actually created. `source` is `'user'` if the turn
  carries any queued message, else `'agent'`. If the chat is mid-turn, the flush reschedules itself
  every `REPORT_RETRY_MS` (3s); queued user messages have no retry limit, and past
  `REPORT_RETRY_LIMIT` (400 tries, ~20 min) an agent-only retry just logs once and keeps waiting for
  the chat to go idle — reports are durable now, so nothing is dropped. A **breaker**
  (`AGENT_ROUNDS_MAX = 12`) holds agent reports unreported (rather than posting them) once 12
  consecutive turns have passed with no user message in between, so a runaway agent loop can't
  monopolize the conversation on its own; they go out folded into the next user turn instead. A
  report is `needsYou` (surfaced as **Needs you** in the UI, and a macOS notification via
  `server/notify.ts`) when the job failed or its last line ends in `?`; a chat with no session left
  to resume marks its due reports reported anyway (they could never be delivered) and still raises
  "Needs you".
- **Restart catch-up** (`recoverAll`, run once at startup, non-blocking): kicks every chat that has
  queued messages or unreported settled agents. The flusher only knows an agent "settled while this
  process was down" if it was never told about it via `onAgentSettled` — those reports are prefixed
  with `[Shikidan restarted — catching up]` in the turn they end up in.
- **Landing**: identical to any other job — the chat calls `POST /api/jobs/:id/land` on a reviewed,
  worktree-backed agent once review passes, and a `landedAt` on a job with a `chatId` triggers a
  "Landed" notification.
- **Naming a Studio workflow** (`CHAT_RULES` "## Studio workflows"): naming one is optional. When the
  owner names one, the chat looks it up with `GET /api/studio/workflows` (matched case-insensitively)
  and starts it with `POST /api/studio/runs {workflowId, revision, cwd, label, request, chat:
  $SKD_CHAT_ID, chatTurn: $SKD_JOB_ID, engine, model?}` instead of spawning agents itself.
  `chatDefaultFor`/`agentsFor` in `workflow-runner.ts` then resolve any node whose `agent.engine` is
  unset (a "Chat decides" step) to that `chat`/`model`, leaving explicitly pinned nodes untouched, and
  still refuses a run whose cross-family review would end up on the same model family as the
  implementation it reviews. Each step's job carries `chatId`/`chatTurn` and `reason: "Studio · <workflow
  name> · <step title>"` (so it shows individually on the chat's team card) but is never reported to
  the chat on its own — `workflowRunId` excludes it from `needsReport`. When the run reaches a final
  status, `onRunSettled` (wired in `server/index.ts`) hands it to `chatFlusher.onRunSettled`, which
  posts one `[workflow <name> · <status>]` turn (one line per attempt) the same durable way as an agent
  report (`WorkflowRun.reportedAt`, included in `recoverAll`). Without a named workflow, the chat keeps
  choosing and spawning agents itself as described above.

## Terminals (`server/terminals.ts`, `server/routes/terminals.ts`) — live sessions

`POST /api/terminals` spawns an interactive `claude`/`claude`-with-GLM-env/`codex` process under
`bun-pty`, full user profile (never the worker profile), cols/rows from the client. Accepts
`resumeSessionId` (spawns `--resume <id>`, claude/glm only, validated as a UUID) or
`workflowId`+`revision` (bootstraps the terminal with that workflow's system prompt via
`--append-system-prompt`/Codex `developer_instructions`, so a human can run a Studio workflow's
first node by hand). Codex terminals always prepend
`--dangerously-bypass-approvals-and-sandbox`. Sessions persist across browser reconnects (a 64 KB
ring buffer replays on reattach) until the server exits or `DELETE /api/terminals/:id` kills the pty.
`WS /ws/terminal/:id` bridges pty ↔ xterm.js: binary/UTF-8 data frames, `{type:'resize',cols,rows}`
control frames. Dropping a file onto a pane (`POST /api/terminals/drops`, `server/drops.ts`) resolves
to the original path via a Spotlight match (name+size+mtime), or saves a copy under
`~/.config/shikidan/drops/`, so the pty gets a shell-quoted real path. `GET
/api/terminals/sessions?cwd=` lists resumable Claude sessions found
under `~/.claude/projects/<slug>/`. `GET /api/terminals/:id/thread` renders a running terminal's own
transcript file (Claude JSONL or Codex rollout, `server/session-transcript.ts`) the same shape as a
job thread, cached by `(path, mtime, size)`, but with `canReply: false` — a terminal is driven by
keystrokes, not the reply API.

## Studio (`server/workflows.ts`, `server/workflow-runner.ts`, `server/workflow-builder.ts`)

A workflow is a validated (zod) directed graph of nodes (`task|plan|verify-plan|implement|review`,
each with an `agent` role/engine/model, optional `skills` (Markdown files), `mcpServers`, `checks`
(shell commands), `maxVisits`) and outcome-labelled edges (`pass|fail|blocked`). `validateWorkflow`
requires unique node ids, a reachable entry, at most one edge per node+outcome, and a reachable
"finished" endpoint. Revisions are content-hashed and stored immutably under
`~/.config/shikidan/workflows/<id>/<revision>.json`, with `latest.json` pointing at the
current one (`createWorkflowStore`); a policy template (shared preamble text) is versioned the same
way under `policies/`. The one built-in `default` workflow is plan → verify-plan → execute → review.

- **Running one** (`createWorkflowRunner`): resolves each unpinned node's engine/model to the
  matching `EngineRoles` entry (or, when started from a chat, to that chat's own engine/model — see
  **The chat** → "Naming a Studio workflow"), snapshots the node's skill files and the workspace's git
  state before each attempt, spawns a job per node (its own worktree, standard `createJob` path),
  waits for the job's final message to end in an `SKD_RESULT {"outcome",...}` line, runs the node's
  `checks`, and follows the matching outcome edge — retrying the same node up to `maxVisits` times on
  `fail`, and blocking the run outright if a plan is unverified before an `implement` node or a review
  would share a model family with the implementation it's reviewing and no other family can take it. `POST /api/studio/runs` starts
  one from `{terminalId?, workflowId?, revision?, cwd, request, label, chat?, chatTurn?, engine?,
  model?}`; `GET /api/studio/runs` lists summaries, `GET .../:id` the full run (agents, attempts,
  checks, status); `.../:id/stop` and `.../:id/retry` control it.
- **When a step's AI cannot start** (`server/engine-availability.ts`): before a run starts, every
  agent step's AI is checked. It is unavailable when GLM has no z.ai token, its CLI is not installed,
  or `/api/quota` shows its 5-hour or weekly limit at 100% with a reset still ahead. An unavailable
  step moves to a replacement (`replacementFor`): the fallback AI first, then the built-ins and
  connections that can start, and the agent records `swappedFrom`. A review only moves to a family
  the implementation did not use; with none left it may run same-family (`sameFamily`) for at most
  two review attempts in the run. A pinned AI that is one of several parallel paths is never swapped.
- **One run per folder.** A run claims its folder; while it runs, other jobs in that folder are refused (409). Chat turns are exempt both ways: a chat turn neither blocks a run from starting nor is blocked by one, so a chat can run a workflow in its own project.
- **Designing one in English** (`createWorkflowBuilder`): `POST /api/studio/drafts` spawns a
  throwaway, read-only job (a separate temp git-free worktree under `~/.cache/shikidan/
  workflow-designer/`, killed after 180s) whose only job is to emit a JSON workflow draft; the
  server validates the draft the same way (`validateWorkflow`) and additionally rejects any node
  proposing a tool/skill/check the human hasn't already approved.
- **Connections** (`server/agent-connections.ts`): non-built-in AI connections (a custom API-
  compatible endpoint, an ACP agent, or a CLI with `{{prompt}}`/`{{model}}`/`{{session}}` slots),
  stored one JSON file per id under `connections/`; `env` values name a *real* environment variable to
  read at spawn time, never a literal secret in the file. `server/agent-bridge.ts` is the general
  bridge for these: `jobs-engine-iface.ts` spawns it as the actual process for any job whose engine
  isn't one of the three built-ins (it speaks ACP/OpenCode/raw-CLI to the connection, sandboxes every
  tool file path to the job's own workspace, and redacts the connection's own secret env values out of
  its JSON output), and `POST /api/studio/connections/:id/probe` spawns it in a `probe: true` mode to
  ask a protocol connection what it can do (`skd_capabilities`). Either way it enforces a 60-minute
  hard deadline (SIGTERM, then SIGKILL a second later).

## Flow, plans, and runs — the session side panel

Predates the chat and still backs the collapsible "Session flow" panel and the multi-step "run" a
human can attach to a dispatch-style job label (not the chat): `server/flow.ts` derives a 5-stage
pipeline (`spec → impl → codex → verify → merged`) per session label from job/terminal state;
`server/plans.ts` lets a plan (steps with an `assignee` and `status`) be attached to a label and its
steps patched; `server/plan-runner.ts` runs a preamble + ordered task list as a chain of jobs against
one label, appending to `runs.jsonl`; `server/archive.ts` auto-archives a finished, inactive session
past a Bangkok-midnight boundary. All read through `GET /api/flow` (`flowSnapshot`), which merges
live derived state with stored plans and filters out archived labels unless `includeArchived=1`.

## History (`server/history.ts`, `server/routes/history.ts`)

`GET /api/history` merges into one list: job threads (`buildHistory`), live terminals, resumable
transcript files under every known directory plus Chat home (`server/transcripts.ts`
`listSessions`, capped at 20 per folder, 10s-cached), and "outside" sessions — `claude`/`codex`
processes on the machine not owned by this server (`server/quota.ts`
`GET /api/sessions/external`, via a `ps` scan). `ownedPids` excludes anything Shikidan itself
spawned (jobs, terminals) from that outside-sessions list.

## Frontend

`server/views/shell.ts` renders the one HTML shell (`GET /`): an SVG symbol sheet, the chat/history/
composer/Studio DOM, and `<script type="module" defer>` tags naming the client islands, each
transpiled on the fly by `GET /js/:file`:

| Script | Owns |
|---|---|
| `shell.js` (`client/shell.ts`) | Boot: routing between welcome/history/conversation/Studio panels, dialog wiring |
| `shell-composer.js` | The composer form: folder/model/edit chips, send |
| `chat.js` | `openChat`, sending messages, rendering a chat's turns, team cards, streaming activity |
| `studio.js` (from `client/studio.tsx` + `studio-settings.tsx`, React) | The Studio workflow graph editor, connections manager, run viewer |
| `terminals.js` | Terminal rail, panes, xterm.js wiring, drag-to-split, drops |
| `shell-activity.js` | The Agents drawer and Flow panel's live activity feed |
| `usage-card.js` | The scrolling provider-usage strip in the toolbar |
| `backdrop.js` | The ambient canvas background (textmode.js) |
| `access.js` | The Access dialog: host/token reveal-rotate, Chat home editor |

Supporting (imported, not `<script>`-mounted) modules: `chat-view.ts` (turn/team-row/signal
derivation from thread + job data), `thread-view.ts` (grouping jobs into threads generically,
shared by chat and terminals), `markdown.ts` (the chat's own Markdown renderer — no library),
`plan-view.ts` (Flow panel's plan parsing), `provider-usage.ts`/`work.ts`/`awareness.ts` (usage-card
and cross-session activity derivation), `shared.ts` (`getJson`/`postJson`/SSE log streaming
helpers), `shell-launch.ts` (terminal-launcher provider/model defaults), `terminal-state.ts`/
`terminal-panes.ts` (xterm pane lifecycle), `studio-api.ts`/`studio-graph.ts` (Studio's fetch
wrapper and graph-editing helpers). Styling is `public/quiet.css` plus `public/vendor/neumo-ui.css`
(neumorphic cards/buttons, deliberately flat inputs); provider identity uses SVG logos under
`public/providers/`, never emoji.

## Data

Everything lives under `~/.config/shikidan/` (override: `SKD_CONFIG_DIR`),
directory mode 0700, files mode 0600:

| Path | Owner | Contents |
|---|---|---|
| `secrets.json` | `secrets.ts` | `zaiAuthToken`, `zaiBaseUrl`, `apiToken` |
| `config.json` | `secrets.ts` | `roles` (plan/execute/review and named roles, engine+model), `fallback`, `autoReview`, `chatHome` |
| `jobs.jsonl` | `jobs.ts` | one line per `JobRecord`, latest wins on replay; compacted past 5000 lines |
| `logs/<jobId>.log` | `jobs.ts` | raw stdout+stderr of that job's process, tailed live, redacted on every read |
| `chat-queue.json` | `chat-queue.ts` | queued user messages per chat, drained into the next turn |
| `plans.jsonl` | `plans.ts` | Flow-panel plans keyed by session label |
| `runs.jsonl` | `plan-runner.ts` | Flow-panel multi-task runs |
| `archive.jsonl` | `archive.ts` | archived session labels |
| `workflows/<id>/<revision>.json` (+ `latest.json`) | `workflows.ts` | immutable, content-hashed workflow graphs |
| `policies/<revision>.json` (+ `latest.json`) | `workflows.ts` | shared Studio policy/preamble text |
| `workflow-runs/<runId>.json` | `workflow-runner.ts` | one file per Studio run: agents, attempts, checks, status |
| `connections/<id>.json` | `agent-connections.ts` | non-built-in AI connections |
| `worker-claude/`, `worker-codex/` | `worker-profile.ts` | isolated profile for `glm`/`codex` headless jobs |
| `chat-claude/` | `chat-profile.ts` | isolated profile for `glm`-engine chats (`CLAUDE_CONFIG_DIR`) |
| `drops/` | `drops.ts` | copies of files dropped onto a terminal pane when the original can't be found |

## Routes

Guard column: **local** = `requireLocal` (browser same-origin, or the Bearer-token allowlist —
marked **+token**); **local (manual)** = an inline `localRequestAllowed` check with the same 403
shape but no token bypass; **local+origin** = the terminal WebSocket's own guard; **none** = no guard
at all (never returns anything secret).

### Page, health, static

| Method | Path | Body | Response | Guard |
|---|---|---|---|---|
| GET | `/` | — | HTML shell | local (manual) |
| GET | `/js/:file` | — | transpiled `client/*.ts`/`.tsx` as JS, or its co-emitted CSS if `:file` ends `.css` | none |
| GET | `/lanes`, `/dispatch`, `/terminals`, `/review`, `/settings` | — | 302 → `/` | local (manual) |
| GET | `/studio` | — | 302 → `/?screen=studio` | local (manual) |
| GET | `/api/health` | — | `{ ok: true }` | none |
| GET | (static) `public/**` | — | file bytes, `cache-control: no-cache` | none |

### Jobs (`server/routes/jobs.ts`) — all **local**; GET and POST anywhere under `/api/jobs*` also accept the Bearer token (PATCH and DELETE do not — those two routes below are browser-origin only)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/jobs` | `{engine, cwd, prompt, label?, worktree?, terminalId?, model?, purpose?:'chat', edit?, project?, chat?, chatTurn?, reason?, reviewOf?}` | `JobRecord` or `400/409/422 {error}` |
| GET | `/api/jobs` | query `chat?` | `{ jobs: (JobRecord & {currentActivity})[] }`, secrets redacted |
| PATCH | `/api/jobs/:id` | `{titleLocked?:true, label?, project?}` (chat roots only) | updated `JobRecord` or `400/404` |
| GET | `/api/jobs/:id/activity` | — | `{status, currentActivity, events: ActivityEvent[]}` (redacted, max 50) |
| GET | `/api/jobs/:id/log` | — | full redacted log, `text/plain` |
| GET | `/api/jobs/:id/stream` | — | SSE tail + live updates, 15s heartbeat, redacted |
| GET | `/api/jobs/:id/thread` | — | `{rootId, engine, running, sessionId, canReply, messages}` |
| POST | `/api/jobs/:id/reply` | `{message}` | new `JobRecord`; chat thread already replying → `202 {queued:true, item}`; or `400/404/409` (see **The chat**) |
| GET | `/api/jobs/:id/queue` | — | `{items: ChatQueueItem[]}` for that thread's root, or `404` |
| DELETE | `/api/jobs/:id/queue/:itemId` | — | `{ok:true}` or `404` |
| POST | `/api/jobs/:id/land` | — | `{landed: string[], base}` or `400/404/409 {error, files?}` |
| POST | `/api/jobs/:id/reviewed` | — | `JobRecord` or `404` |
| POST | `/api/jobs/:id/kill` | — | `{ok:true}` or `404` |

### Chat, history, terminals, secrets, roles, models, providers, quota, meta — **local** unless noted

| Method | Path | Body | Response | Token? |
|---|---|---|---|---|
| GET | `/api/chat/home` | — | `ChatHomeStatus` | no |
| PUT | `/api/chat/home` | `{path}` | `{ok, path}` or `400` | no |
| GET | `/api/history` | — | `{items: HistoryItem[]}` | no |
| POST | `/api/terminals` | `{engine, cwd, cols?, rows?, model?, resumeSessionId?, title?, workflowId?, revision?}` | `TerminalRecord` or `400` | no |
| POST | `/api/terminals/drops` | multipart `{file, lastModified?}` | `{path, original}` or `413` | no |
| GET | `/api/terminals/sessions` | query `cwd` | `{sessions}` or `400` | no |
| GET | `/api/terminals` | — | `{sessions: TerminalRecord[]}` | no |
| GET | `/api/terminals/:id/thread` | — | `{engine, sessionId, running:true, canReply:false, bound, messages}` or `404` | no |
| PATCH | `/api/terminals/:id` | `{title}` | `TerminalRecord` or `400/404` | no |
| DELETE | `/api/terminals/:id` | — | `{ok:true}` or `404` | no |
| WS | `/ws/terminal/:id` | frames: resize / data | pty stream | local+origin only |
| GET | `/api/secrets` | — | `PublicSecretsView` | no |
| POST | `/api/secrets` | `{zaiAuthToken?, zaiBaseUrl?}` | `{ok, ...view}` or `400` | no |
| POST | `/api/secrets/api-token/reveal` | — | `{apiToken}` | no |
| POST | `/api/secrets/api-token/rotate` | — | `{apiToken}` | no |
| GET | `/api/roles` | — | `EngineRoles & {autoReview, fallback}` | yes |
| POST | `/api/roles` | `{plan, execute, review, ...namedRoles, autoReview?, fallback?}` | same, or `400` | no |
| GET | `/api/models` | — | `ModelLists` (per engine) | yes |
| GET | `/api/providers` | — | `{providers: Provider[]}` | yes |
| GET | `/api/quota` | — | `QuotaComposite` | yes |
| GET | `/api/sessions/external` | — | `{sessions: ExternalSession[]}` | no |
| GET | `/api/meta` | — | `{blockClock, tokPerMin, reviewCount}` | yes |

### Flow / plans / runs (`server/routes/flow.ts`, `runs.ts`) — **local+token** on the paths noted

| Method | Path | Body | Response | Token? |
|---|---|---|---|---|
| GET | `/api/flow` | query `includeArchived?` | `FlowResponse` | yes |
| POST | `/api/flow/:label/archive` | — | archive result | yes |
| POST | `/api/flow/:label/unarchive` | — | unarchive result | yes |
| POST | `/api/flow/:label/plan` | `PlanInput` | `Plan` or `400` | yes |
| PATCH | `/api/flow/:label/plan/:index` | `{status}` | `Plan` or `400/404` | yes |
| POST | `/api/flow/:label/run` | `RunInput` | `Run` or `400/422` | yes |
| GET | `/api/flow/:label/run` | — | `Run` or `404` | yes |
| POST | `/api/flow/:label/run/stop` | — | `{ok}` or error | yes |

### Studio (`server/routes/studio.ts`) — **local**, token-scoped subset noted

| Method | Path | Body | Response | Token? |
|---|---|---|---|---|
| GET | `/api/studio/drafts` | — | `{draft}` | no |
| POST | `/api/studio/drafts` | `{description, engine?, workflow?}` | `DraftJob` | no |
| GET | `/api/studio/drafts/:id` | — | `DraftJob` | no |
| POST | `/api/studio/drafts/:id/stop` | — | `DraftJob` | no |
| GET | `/api/studio/workflows` | — | `{workflows, selected}` | yes |
| POST | `/api/studio/workflows` | `{workflow, expectedRevision?}` | `WorkflowRevision` or `400` | no |
| GET | `/api/studio/workflows/:id/revisions` | — | `{revisions}` | yes |
| POST | `/api/studio/default` | `{id, revision}` | `{ok:true}` | no |
| GET | `/api/studio/policy` | — | `PolicyRevision` | yes |
| GET | `/api/studio/policy/revisions` | — | `{revisions}` | no |
| POST | `/api/studio/policy` | `{template}` | `PolicyRevision` | no |
| POST | `/api/studio/preview` | `{id, revision, nodeId, request}` | `{prompt}` | no |
| GET | `/api/studio/connections` | — | `{builtins, connections, presets, models, roles}` | no |
| POST | `/api/studio/connections` | `AgentConnection` | saved connection | no |
| DELETE | `/api/studio/connections/:id` | — | `{ok:true}` | no |
| POST | `/api/studio/connections/:id/probe` | — | `skd_capabilities` event or `400` | no |
| GET | `/api/studio/runs` | — | `{runs: summary[]}` | yes |
| POST | `/api/studio/runs` | `{terminalId?, workflowId?, revision?, cwd, request, label, chat?, chatTurn?, engine?, model?}` | `WorkflowRun` | yes |
| GET | `/api/studio/runs/:id` | — | `WorkflowRun` or `404` | yes |
| POST | `/api/studio/runs/:id/stop` | — | result | yes |
| POST | `/api/studio/runs/:id/retry` | — | result | yes |

## Tests

`bun test` across 68 files under `test/`, one file per server module plus one `*-routes.test.ts` per
route file, named and structured to match the module/route file it covers (e.g.
`test/chat-reports.test.ts` against `server/chat-reports.ts`, `test/jobs-routes.test.ts` against
`server/routes/jobs.ts`). `SKD_FAKE_ENGINES=1` (`server/engines.ts` `fakeEnginesEnabled`) substitutes
`/bin/echo`/`/bin/sh` stubs so the suite and local UI dev run without the real `claude`/`codex`
binaries. `test/setup.ts` and `test/fixtures`/`test/support` hold shared harness code.
