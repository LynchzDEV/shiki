# Shikidan

**A simple cockpit for any AI coding agent, extensible with plugins.**

Website: [shikidan.com](https://shikidan.com)

Shikidan is a workspace that runs your AI coding agents from one chat. It isn't tied to one vendor: bring Claude Code, Codex, Grok, GLM (through any Anthropic-compatible endpoint), or any ACP, OpenCode or headless-CLI agent you add under **Studio → Manage AIs → Add an AI**. Extend it with plugin add-ons from a git marketplace, or write your own with the plugin SDK (see [Plugins](#plugins)).

You describe the work in a chat. The chat answers directly, or spins up agents in isolated git worktrees, has a *different* AI family review each code change it makes, and lands it on your branch. (Jobs you start outside the chat, for example with `shiki job new`, skip that automatic review.) Live terminals, a workflow Studio and your whole history sit in the same window.

**What you get:**
- **A CLI for people and agents.** `shiki` drives a running Shikidan from a shell: `shiki status`, `shiki job new "…" --follow`, `shiki attention`, `shiki runs`, `shiki plugin add <git url>`. See [Command line](#command-line).
- **Describe a workflow, get a draft.** In Studio, type what you want into **Describe your workflow** and an AI drafts the steps on an editable canvas. Or start from the default (plan → verify → execute → cross-family review), a template, or scratch.
- **Skills set up for you.** On start, Shikidan links its `skd-dispatch` skill into `~/.claude/skills`, loads the agents, skills and flows that installed plugins contribute, and mirrors Claude's global instructions, skills and agents to Codex so both follow the same rules.

**Example default setup:** Claude Code leads the chat, GLM via z.ai handles cheaper fan-out work, and Codex CLI reviews from the outside. Swap any of them for the agents you already use.

State lives in plain JSON files. No database, no build step.

![Shikidan: one sentence in the chat, a team of AI agents does the work, and a different AI reviews it before it lands](docs/images/demo.gif)

Video (MP4): [docs/images/demo.mp4](docs/images/demo.mp4)

## Quickstart

**You need:**
- [Bun](https://bun.sh) 1.2+ and git
- At least one agent CLI installed and signed in (e.g. Claude Code). Chat uses **Claude Code** by default:
  - Claude Code: install it (https://docs.anthropic.com/en/docs/claude-code), then run `claude` once to sign in
  - Codex (optional, the cross-family reviewer): install the Codex CLI, then `codex login`
  - GLM (optional): a z.ai API key, see below
- macOS or Linux. On Windows, use WSL2: see [Install on Windows](docs/install-windows.md).

```sh
git clone https://github.com/LynchzDEV/shiki.git
cd shiki
bun install
bun start            # port taken? SKD_PORT=7778 bun start
```

Open http://127.0.0.1:7777. On your first message, Shikidan asks **where your projects live**. Give it a folder under your home directory (for example `~/code`).

### Connect your AIs
| AI | Setup |
|---|---|
| Claude Code | Nothing more to do once `claude` is installed and signed in. It's the default chat AI. |
| GLM | **Studio** (top right) → Manage AIs → GLM: paste the z.ai base URL `https://api.z.ai/api/anthropic` and your API key |
| Codex | `codex login` once in any terminal |
| Grok (Grok Build) | Install the `grok` CLI and sign in, then **Studio** → Manage AIs → **Add an AI** → **Grok Build** (preset: ACP agent · `grok`) → **Save connection**, then **Check connection**. Shikidan reads its model list and weekly usage. |
| Others | Studio → Manage AIs → Add an AI (ACP agent, OpenCode, or a headless CLI) |

Check what's connected: `bun cli/shiki.ts status` (or `shiki status` after `bun link`, with `~/.bun/bin` on your PATH).

> If the first reply fails with `Claude Code native binary not found`, Claude Code isn't installed or isn't on PATH. Install it, or pick another AI with the AI chip.

### Just looking? Try it with no accounts
```sh
SKD_FAKE_ENGINES=1 SKD_CONFIG_DIR=$(mktemp -d) bun start
```
This swaps every AI for harmless stand-ins so you can click through chat, agents, Flow and Studio.

> Heads-up: Shikidan links a Claude Code skill into `~/.claude/skills/` and mirrors your Claude instructions into `~/.codex/` (backing up anything it replaces). State lives in `~/.config/shikidan`.

## A tour

### Chat

Type what you want. The folder chip picks the project, or leave it on **Auto** and the chat works it out. The AI chip picks who answers, and the pencil chip lets the chat edit files directly.

- **Replies stream in** as they are written. While the AI works you see a live `Thinking · 4s` / `Writing · 12s` line and a single fading line with the step it is on (`Reading client/chat.ts`, `Running bun test`). When it finishes, the steps fold under `Worked 39s · used 4 tools`.
- **Full markdown**: links, tables, code blocks, lists. Model output is sanitized before it reaches the page.
- **Agents**: when the work is bigger than a reply, the chat spawns agents. The reply grows a team card with one row per agent (AI, model, why it was picked, and its state: Running, In review, Landed, Needs you). Agents report back into the chat on their own; their reports show as a compact row with a **Show report** toggle.
- **Queue**: you can keep writing while the chat replies; messages wait under the conversation and send when it is done.
- **Safety net**: every code change is reviewed by a different AI family before it lands, a failed step is retried up to three times on different AIs, and the chat never pushes or deploys.

### Agents and Flow

The **Agents** button (top right) opens a drawer that follows the chat you are in. Each agent is one row with its AI, running time and status, plus one grey line showing what it is doing right now. Click an agent to open its live log, send it a message, or stop it.

The **Flow** button shows the same work as a graph: nodes for each step and agent, lines that draw in, a flowing dash toward the step that is running, and a pulse on the active node.

### Sidebar and terminals

The sidebar on the left lists your chats and live terminals, grouped by Today, Yesterday and Earlier. A dot shows what needs attention: purple while working, green for a live terminal or landed work, red when something needs you. It starts collapsed as a slim icon strip; the toggle slides it open.

**New terminal** opens Claude Code, GLM, Codex or any connected agent in a real terminal, in any folder under your home. Terminals live in the sidebar next to your chats:

- double-click a name to rename it, hover for the × to end it
- drag a terminal onto the screen to open it beside or below the current one
- each terminal has a small bar in its corner with its name, a Live indicator and Find (⌘F)
- links are clickable, and dropping files types their paths at the prompt

### Studio

**Studio** (top right) is where you shape how your AI team works:

- **Workflows**: describe one and an AI drafts it, or start from the default (plan → verify → execute → cross-family review), a template, or scratch. Steps sit on a canvas with success, failure and needs-help branches. Each step shows what it does and which AI does it (**Chat decides**, or a pinned AI and model), and can carry skills, tools and acceptance checks. While a workflow runs, the canvas shows which steps passed, which one is running, and where it failed.
- **Manage AIs**: every connected AI with its usage, the role it plays, its models and its settings.
- **Runs**: every run with its attempts, evidence and checks.
- **Rules**: the core rules every step follows.

### Plugins

**Marketplace** (sidebar footer) adds plugins from git. Add a marketplace link (for example `https://github.com/LynchzDEV/skd-marketplace`), pick a plugin and install it; it then shows under **Plugins** at the top of the sidebar. The first plugin, **ClickUp board**, shows a ClickUp board and starts a chat or terminal on any task, with a dossier of the task (description, subtasks, comments, linked tasks, fields) attached for the AI to read first.

- **Isolated** plugins run under the macOS sandbox: they reach only the hosts they declared, read only their own bundle and data folder, never see your other secrets, and draw their screen in a locked frame. Isolated plugins that use the network need Bun 1.2.23 or newer (`bun upgrade`).
- **Trusted** plugins load straight into Shikidan and get full access, so installing one asks you to confirm you trust it.
- A plugin can open the launcher for a chat or terminal, never start one on its own. Its task context is saved in the session folder under `.shikidan/` (kept out of git through `.git/info/exclude`).

Write your own: start from [skd-plugin-template](https://github.com/LynchzDEV/skd-plugin-template) and the [skd-plugin-sdk](https://github.com/LynchzDEV/skd-plugin-sdk) guide. Design: `docs/superpowers/specs/2026-10-04-plugins-marketplace-design.md`.

### History

**All history** (bottom of the sidebar) and search open one searchable list: chats, live terminals, earlier Claude Code sessions (resume one in a terminal), and Claude or Codex sessions you started outside Shikidan. Only real sessions are listed: Shikidan's own agents, background helpers, MCP servers and non-interactive runs are left out.

### Usage

The top bar shows each provider's usage in the same place:

| Provider | What you see | Source |
|---|---|---|
| Claude Code | 5-hour window, weekly underneath | `ccstatusline` cache when under 12 hours old, otherwise a labelled `ccusage` estimate |
| GLM | 5-hour window | z.ai monitor API |
| Codex | Weekly window | Codex CLI account API |

Reset times appear on hover.

## Configuration

Shikidan needs no config file. These environment variables change its behaviour:

| Variable | Default | What it does |
|---|---|---|
| `SKD_PORT` | `7777` | Port to listen on (always on `127.0.0.1`) |
| `SKD_CONFIG_DIR` | `~/.config/shikidan` | Where state, logs and credentials live |
| `SKD_LOG` | quiet | `verbose` logs every request, not just changes and errors |
| `SKD_FAKE_ENGINES` | off | `1` swaps the AI CLIs for harmless stand-ins, for development and tests |

### Server log

`bun start` prints one line per event, prefixed with the local time:

```
12:04:31  job started  say-hi html · glm/glm-5.3 · 56c345dc
12:04:31  POST /api/jobs 200 17ms
12:05:43  job done  say-hi html · 1m12s · 56c345dc
12:06:02  GET /api/nope 404 1ms
```

By default it logs jobs starting and finishing, requests that change something, and every failed request. The chat and sidebar poll in the background every few seconds, so ordinary reads stay quiet unless you run `SKD_LOG=verbose bun start`. Request bodies and query strings are never printed.

## Upgrading from Mission Control

Pull and restart; nothing has to be moved by hand.

- **Settings and data**: on its first start Shikidan moves `~/.config/mission-control` to `~/.config/shikidan` and leaves a link at the old path. If `~/.config/shikidan` already exists it is used and the old folder is left alone.
- **Environment**: the old `MISSION_CONTROL_*` and `MC_*` names still work, and `SKD_*` wins when both are set. Jobs, terminals and plugins are given both names.
- **History**: browser settings (theme, layout, last project) carry over once, and job logs, runs and repo session folders (`.mission-control/`) from before the rename still read.
- **Skill**: the skill is now `skd-dispatch`. The next start links it and removes the stale `mc-dispatch` link; rename `mc-dispatch` in your own notes, such as `~/.claude/CLAUDE.md`.
- **CLI**: the command is now `shiki`. Run `bun link` again; an old `mctl` link points at a file that no longer exists.
- **Windows**: re-run `install-autostart.ps1`. It replaces the `Mission Control` task with `Shikidan`, and keeps using `~/mission-control` when that is where your clone is.

## Command line

`shiki` drives a running Shikidan from a shell, for people and for AI agents. Install it once with `bun link` in the repo, then run `shiki` (banner, version and every command) or `shiki <group> --help`, e.g. `shiki job --help`. `shiki --version` prints the version. For the manual page, link it once with `mkdir -p ~/.local/share/man/man1 && ln -sfn "$PWD/man/shiki.1" ~/.local/share/man/man1/shiki.1`, then `man shiki`.

```sh
shiki status                          # up/down, usage per provider, role -> engine
shiki jobs --limit 10                 # newest jobs
shiki job new "Fix the flaky test" --cwd ~/code/app --follow
shiki attention                       # what is waiting on you
shiki runs                            # workflow runs
shiki plugin add https://github.com/LynchzDEV/skd-plugin-clickup --yes
shiki clickup board main              # the board, saved filters applied
shiki clickup filter add main Assignee "is any of" --value Me
shiki clickup start 86d4ccpu2 --board main   # chat with the task dossier attached
shiki queue add clickup-board 86d4ccpu2 --repo ~/code/app   # build it when its turn comes
shiki queue add clickup-board 86d4ccpu2 --repo ~/klangtech   # a folder of repos: the plan picks which (or pass --repos api,backoffice)
```

- `--json` prints the server's JSON as one document (NDJSON for `job follow` and `job new --follow`); every command supports it.
- `--url` > `SKD_URL` > `http://127.0.0.1:7777`. Local URLs need no token. For other URLs set `SKD_TOKEN`; otherwise `apiToken` from `secrets.json` is used when present.
- Exit codes: `0` ok, `1` API error (message on stderr), `2` usage error, `3` Shikidan isn't running.

## The Claude Code skill

`bun install` (and every server start) links `~/.claude/skills/skd-dispatch` to `skills/skd-dispatch` in this repo, so `git pull` keeps the skill current. With it, a Claude Code session can hand work to Shikidan: it plans, dispatches jobs to the right AI, and reviews them, while you watch the jobs in the Agents drawer and the Flow graph. An existing hand-written skill at that path is moved to `~/.claude/skills-backup/` first, never overwritten.

On the same occasions, Shikidan translates Claude's global instructions, skills and agents for Codex, so both AIs follow the same rules. Codex-incompatible pieces are skipped, and any personal Codex files it replaces are kept under `~/.codex/backup/`.

## Remote access

Shikidan runs on any machine or server you can install Bun on: a laptop, a home server, a cloud VM, or WSL2 on Windows (for example, `bun start` inside WSL on port 7777). The server always binds `127.0.0.1`, so nothing is reachable from outside until you put something in front of it.

The supported way in is [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve), which keeps it inside your private tailnet over HTTPS:

```sh
# on the machine running Shikidan
tailscale serve --bg 7777

# tell Shikidan which Tailscale name and users to accept
SKD_ALLOWED_HOSTS=my-box.your-tailnet.ts.net \
SKD_ALLOWED_USERS=you@example.com \
bun start
```

Then open `https://my-box.your-tailnet.ts.net` from any device on your tailnet. Proxied requests are accepted only when the host is a `*.ts.net` name listed in `SKD_ALLOWED_HOSTS`, the connection comes from loopback (Tailscale on the same machine), and the Tailscale login is listed in `SKD_ALLOWED_USERS`. Anything else that arrives through a proxy is refused, so a generic reverse proxy (nginx, Caddy, etc.) won't work today, even with auth in front of it. Turn sharing off with `tailscale serve --https=443 off`.

> [!WARNING]
> Shikidan gives **full terminal and agent access** to the machine it runs on: shells, your repos, and every credential the AIs use. Never expose it to the public internet, and never use `tailscale funnel` for it. Keep it on a private network, behind authentication you control, for users you trust.

## Security

- **Network binding.** The server binds `127.0.0.1` by default. A Host / Origin / Fetch-Metadata guard stops web pages from other origins from reading or driving it. Anyone who can open a local connection on this machine has full control, including other OS user accounts and the agent jobs Shikidan spawns.
- **Credentials** live in the config directory (`0700` folders, `0600` files) and reach the AIs only through their environment. The API token, for scripts and the skill, can be revealed or rotated from the lock button; it grants nothing extra to local callers.
- **Folders.** Jobs and terminals only run in directories that resolve, after symlinks, under your home folder.
- **Plugins.** Plugin routes accept loopback callers only and never accept the API token. Isolated plugins are confined by the OS sandbox and a per-plugin network proxy; trusted plugins have full access and install only after you confirm.
- **Model output** shown in the chat is sanitized: no scripts, styles, forms, embedded images or element ids from a reply reach the page.

## How it is built

```
Bun + Elysia, TypeScript end to end
├── one server-rendered page; Studio is a React island (React Flow canvas)
├── client files bundled on demand by Bun.build, no separate build step
├── bun-pty ↔ xterm.js over WebSocket for terminals
├── the AI CLIs' own JSON streams for live chat, activity and transcripts
└── JSON state in the config directory, no database
```

Transcripts come straight from each engine's own session logs (`~/.claude/projects` and `~/.codex/sessions`). The look is one stylesheet, `public/quiet.css`: a soft neumorphic surface with an Apple-style corner scale (`--r-xs` … `--r-lg`, continuous corners). JetBrains Mono ships with the app under the OFL.

## Development

```sh
bun test                    # full suite, offline, no AI CLIs needed
bun test test/chat-view.test.ts
bun run typecheck:studio    # Studio's React code
SKD_CONFIG_DIR=$(mktemp -d) SKD_PORT=7790 SKD_FAKE_ENGINES=1 bun server/index.ts
```

The last line runs a throwaway copy on another port with an empty config and fake AIs, which leaves your real instance and data alone.

## Docs

- [`docs/SPEC.md`](docs/SPEC.md): the full engineering contract
- [`docs/decisions/`](docs/decisions/): recorded decisions (why bun-pty, how the chat works, the markdown renderer, …)
- [`docs/design/redesign-2-1/`](docs/design/redesign-2-1/): the current design: mockups and [`DECISION.md`](docs/design/redesign-2-1/DECISION.md) for the sidebar, Agents, Flow, Studio, terminal bar and corner scale
- [`docs/design/`](docs/design/): earlier design studies
- [`docs/superpowers/plans/`](docs/superpowers/plans/): implementation plans

## Contributing

Issues and pull requests are welcome. Keep `bun test` green, write TypeScript, add a note in `docs/decisions/` for any new runtime dependency, and use conventional commits (`feat:`, `fix:`, `docs:` …).

## License

[MIT](LICENSE)
