---
name: shikidan
description: Use when the user wants to set up, start, check, configure or operate Shikidan (the local AI-agent cockpit on 127.0.0.1:7777, CLI `shiki`). Covers first install and first run, "is shikidan up", connecting AIs (Claude Code, Codex, GLM, Grok, custom), assigning roles, starting, following, replying to and landing jobs, what is waiting on the user, workflow runs, the build queue, plugins and marketplaces, updating, remote access and startup troubleshooting. Not for handing implementation work to the cockpit; that is skd-dispatch.
---

# Shikidan: setup and everyday use

**Are you a worker?** If `$SKD_JOB_ID` (or `$MC_JOB_ID`) is set, you are a job Shikidan started. Do the task in your working tree and don't drive the cockpit from inside it.

**Where it lives**: the clone is two levels up from this skill's real path:
`dirname "$(dirname "$(readlink -f ~/.claude/skills/shikidan)")"`. State lives in `~/.config/shikidan` (or `$SKD_CONFIG_DIR`).

## 1. Is it up?

`shiki status`. Exit code `3` means it isn't running. Without the CLI: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7777/api/health` (`200` means up).

- **Down, already installed**: run `bun start` in the clone, in the background or its own terminal, because it never exits. Wait for `shiki listening on ...`. If it prints `another instance is running`, it was already up.
- **Not installed**: follow `AGENTS.md` → "Setting up Shikidan" in the clone, or in https://github.com/LynchzDEV/shiki.
- **`shiki: command not found`**: run `bun link` in the clone with `~/.bun/bin` on PATH, or use `bun <clone>/cli/shiki.ts`.

## 2. Connect AIs and roles

| AI | How |
|---|---|
| Claude Code | `claude` installed and signed in. It is the default chat AI. |
| Codex | `codex login` (the user runs it; never sign in for them). Codex is the default reviewer. |
| GLM | Browser → **Studio** → Manage AIs → GLM: base URL `https://api.z.ai/api/anthropic` plus a z.ai key |
| Grok / others | `shiki connection add <grok\|qwen\|opencode\|custom-agent\|custom-cli> --probe` (or Studio → Manage AIs → **Add an AI**) |

`shiki connections`, `shiki providers` and `shiki models` show what is connected. Roles decide who plans, builds and reviews (defaults: plan Claude, execute GLM, review Codex). Check them with `shiki roles` and change them with `shiki roles set <plan|execute|review> <connection> [--model <id>]`, where the connection is a built-in (claude, glm, codex) or any id from `shiki connections`. Change or remove a connection with `shiki connection set <id>` / `shiki connection remove <id>`; removal is refused while a role uses it.

## 3. Everyday commands

| Need | Command |
|---|---|
| What is waiting on the user | `shiki attention` |
| Start a job and watch it | `shiki job new "<prompt>" --cwd <repo> [--worktree] [--engine E] --follow` |
| List, inspect, log | `shiki jobs --limit 10`, `shiki job show <id>`, `shiki job log <id>` |
| Talk to a running job | `shiki job reply <id> "<text>"` |
| Permission request | `shiki job permission <id> allow_once\|allow_always\|deny` |
| Stop, land, mark reviewed | `shiki job kill <id>`, `shiki job land <id>`, `shiki job reviewed <id>` |
| Workflows | `shiki workflows`, `shiki run start <workflowId> "<request>"`, `shiki runs`, `shiki run show <id>`, `shiki run approve\|reject\|retry\|stop <id>` |
| Build queue | `shiki queue list`, `shiki queue add <source> <externalId> --repo <dir>`, `shiki queue report <id>`, `shiki queue requeue <id>` |
| ClickUp design pick, operator | `shiki queue pick <id> <option>\|none [--feedback TEXT]`, `shiki queue say <id> <text>`, `shiki queue reread <id>`, `shiki queue ask-to [userId\|--clear]`, `shiki queue none-phrases [phrase...\|--clear]` |
| Plugins | `shiki marketplace add <url>`, `shiki plugin catalog`, `shiki plugin add <git url>`, `shiki plugin list`, `shiki plugin settings <id>` |
| Terminals and history | `shiki terminals`, `shiki terminal new`, `shiki history` |

Run `shiki` for every command and `shiki <group> --help` for options. Add `--json` when you parse the output (`job follow` prints NDJSON). Exit codes: `0` ok, `1` API error, `2` usage error, `3` unreachable. Target another instance with `--url` or `SKD_URL`. Non-local URLs need `SKD_TOKEN`.

The browser handles what the CLI can't: revealing or rotating secrets, editing workflows and policy, and attaching to a live terminal.

## 4. Rules

- Ask before anything that grants access or reaches outside the machine. `shiki plugin add ... --yes` on a **trusted** plugin gives it full access, `shiki job land` writes to the user's branch, and `allow_always` is permanent.
- Never start a second server on the same port or config directory. To experiment, use `SKD_CONFIG_DIR=$(mktemp -d) SKD_PORT=7790 SKD_FAKE_ENGINES=1 bun <clone>/server/index.ts`.
- Never print `secrets.json` or plugin secrets. Use `shiki plugin set <id> <key> -` to pass a secret on stdin so it stays out of shell history.
- Remote access is Tailscale Serve only (README → Remote access). Never `tailscale funnel` and never a public proxy, because Shikidan gives full terminal access to the machine.
- Jobs and terminals run only in folders under `$HOME`.

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `Claude Code native binary not found` | Claude Code isn't installed or isn't on PATH. Install it, or pick another AI in the chat's AI chip. |
| `glm: unavailable (zaiAuthToken not configured)` | Add GLM in Studio, or `shiki roles set execute claude --model sonnet` |
| `cwd must be under $HOME` | Move or clone the repo under home. On WSL that means never under `/mnt/c`. |
| Port 7777 used by something else | `SKD_PORT=7778 bun start`, then `--url http://127.0.0.1:7778` |
| Isolated plugin won't start | Bun must be 1.2.23 or newer (`bun upgrade`). On WSL Ubuntu, run `scripts/wsl/setup.sh --with-plugins`. |
| Odd behaviour after `git pull` | `bun install` in the clone, then restart the server |
| Anything else | Read the server's own output (one line per event). `SKD_LOG=verbose bun start` logs every request. |
