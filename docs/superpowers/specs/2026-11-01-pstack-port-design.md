# pstack in Shikidan form: design

Status: decided and built (2026-11-01). The owner's decisions replaced parts of the draft below:

- **Built into Shikidan, not a plugin.** The pstack flows ship in `server/pstack-flows.ts` as read-only built-ins (`pstack-arena`, `-interrogate`, `-swarm`, `-how`, `-why`, `-reflect`, `-thermos`). That makes H1 (flow templating) unnecessary: role prompts are inlined (`server/pstack-prompts.ts`).
- **The default flow is "pstack Feature".** Explore → Architect (In Session). Architect `pass` → Verify plan → Execute → pstack review. Architect `fail` (it can't decide, or isn't confident) → a design arena: Arena brief → runners on claude / glm / codex → Join → Judge → Pick & graft (In Session) → Verify plan. The arena compares designs, not implementations. The gate uses `fail`, not `blocked`, because the runner reports a crash as `blocked`.
- **Every built-in reviewer uses pstack's rubric.** Code review uses `thermo-nuclear-review`; plan checks use architect's design red flags (`server/reviewer-prompts.ts`). Attribution is in `NOTICE.md`.
- **Rails-specific concerns are gone.** The Definition of Done items 1-7 (rspec, brakeman, migrations, recurring jobs, Rails naming) are replaced by a generic coding Definition of Done.
- **H0** (the chat prefers built-in flows over fan-out inside the chat) and **H2** (the pstack plugin is turned off in worker and step jobs with a per-process `--settings` `enabledPlugins` override, checked on Claude Code 2.1.316) are both built.

The original draft follows, kept for context.

## What we found

**pstack** (`~/.claude/plugins/cache/pstack-claude/pstack/0.9.114`) is 67 skills (43 public, 24 hidden `principle-*`), 4 subagent `.md` files, 1 SessionStart hook and a role → model table (`models.json` + `~/.claude/pstack-models.md`). About 6,200 lines of Markdown and 11,500 lines of helper scripts. Its multi-agent skills (arena, swarm, interrogate, architect, how, why, reflect, thermos) are written procedures that the chat model carries out with Claude Code's `Agent` tool. On Claude Code no code picks a model per role: the model reads the sheet and decides.

**Shikidan** already runs everything pstack's fan-out procedures describe, but as real, visible units: Studio flows with fork/join (`server/workflows.ts:90-168`), a model per node (`agent.{engine,model,family}`, `workflows.ts:16`), cross-family enforcement (`workflow-runner.ts:383-398`), worktrees, the Flow graph and the review queue. Plugins can ship `agents`, `skills` and `flows` (`server/plugins/manifest.ts:36,129-148`).

**pstack is already live inside Shikidan for Claude.** Claude-engine chats, terminals and workers use the real `~/.claude` (`worker-profile.ts:65-70`), so pstack's skills, agents and SessionStart hook already load there. GLM and Codex sessions don't see pstack at all.

## Decision: what "Shikidan form" means

| Option | What ships | Gains | Costs |
|---|---|---|---|
| **A. Flows plugin (recommended)** | A pluginApi 2 plugin `skd-plugin-pstack` with `contributes.flows` (the fan-out procedures as Studio flows), one `contributes.skills` folder holding pstack's role prompt templates, and plugin settings for models. The prose skills stay with the existing pstack Claude plugin. | Fan-outs become visible jobs across Claude, GLM and Codex. Code picks the model per node. No duplicate skills. | Single-agent skills (tdd, deslop, how-as-a-single-agent…) stay Claude-only. |
| B. Re-ship all skills via `contributes.skills` | Option A plus all 67 skills and 4 agents, copied into the three Claude profiles. | GLM gets pstack skills too. | A second `poteto-mode` next to the installed one. Copies land un-namespaced (`agents/poteto-agent.md`), but pstack's text names them `pstack:poteto-agent` / `pstack:X` (10 skill files use the `pstack:` prefix). `poteto-agent.md` finds poteto-mode by scanning the plugin cache, which a copy doesn't satisfy. The Codex mirror flattens multi-agent text (`codex-translate.ts:4-48`), and `worker-codex` never sees mirrored skills (`worker-profile.ts:47-63`). |

Option A ports the part pstack lacks (enforced, visible orchestration) and leaves the part Claude Code already serves well (prose skills) alone.

## Mapping: pstack artifact → Shikidan

| pstack artifact | Count | Shikidan equivalent | Status |
|---|---|---|---|
| Fan-out skills with a panel (arena, interrogate, architect phase B, swarm race) | 4 | Plugin flow: fork → N `task` nodes, each with its own `agent` → `join` → judge or synthesis `task` | Native. Width is fixed in the JSON (see below). |
| Fan-out skills with stages (how, why, reflect, thermos) | 4 | Plugin flow: fork of explorers/investigators/reviewers → `join` → synthesizer `task` | Native, except reflect's human gate (H4) |
| Role prompt templates (arena runner-prompt, how explorer/explainer, why investigator/synthesizer, reflect reviewers) plus the two thermo-nuclear rubrics, which GLM and Codex nodes can't load by name | ~22 files | One contributed skill folder `pstack-roles/`, referenced from `node.skills` | Needs H1 |
| Role → model table, `@effort` | 17 roles | Plugin settings + per-node `agent` defaults | Settings need H1. Effort needs H3. |
| SessionStart mandate | 1 | Nothing new. It already fires in Claude sessions. | Needs the H2 guard |
| Single-agent skills, principles, playbooks | 63 | Stay in the installed pstack plugin | Not ported |
| Subagent definitions | 4 | Stay in the installed plugin; thermos's two rubric agents become two flow nodes | Not ported |
| setup-pstack | 1 | Plugin settings form (later, a plugin screen) | Native (`client/plugins/host-api.ts:45-63`) |
| Scripts (watch-pr, orch, statechart, resume) | ~52 files | Stay in the installed plugin | Out of scope |

## Routing: how the chat picks a flow over pstack's prose fan-out

Shipping flows changes nothing unless the chat runs them. Today pstack's mandate sends "design this" to `pstack:architect`, which runs its arena through the `Agent` tool inside the chat process. That is the invisible fan-out this port exists to replace. `CHAT_RULES` say "use flows for multi-step code work" (`chat-profile.ts:27-36`) but name no tie-breaker.

Recommended: add one generic sentence to `CHAT_RULES` (H0): *"When a skill you are following would fan out to subagents and `GET /api/studio/workflows` lists a flow for that skill (for example `pstack--arena`), start that flow instead of spawning the subagents yourself."* It is generic, so other plugins get the same behavior. The chat is the only place fan-outs should start, and it already reads these rules.

Rejected:
- A pstack project playbook in `.agents/playbooks/`: per project, and only seen when poteto-mode routes to it.
- A routing section in skd-dispatch: that skill is for sessions outside the cockpit chat. The chat itself runs on `CHAT_RULES`.
- A routing `SKILL.md` in `pstack-roles/`: it would compete with poteto-mode for the same trigger.

## Flow sketches

All flows use only `task` nodes, so the plan / verify / cross-family-review gates (`workflows.ts:210-221`) don't apply. Each fork closes at exactly one `join` (`analyzeForks`). Defaults use the three built-in engines, so every panel is cross-family out of the box.

- **arena**: `Frame` (In Session: the chat writes the rubric, and runners never see it) → fork: `Runner·claude`, `Runner·glm`, `Runner·codex` → join → `Judge` (defaults to codex; its instructions say it reports and does not edit) → `Pick & graft` (In Session: the chat picks a base criterion by criterion and grafts parts from the losers, the way pstack's parent does). In Session after a join is allowed: `validateWorkflow` blocks it only on parallel paths (`workflows.ts:196`).
- **architect**: `Map` (task, runs how/why-style exploration) → the arena shape, with `pstack-roles/architect-runner.md` as the runner prompt.
- **interrogate**: fork: three `Adversary` nodes (claude / glm / codex, shared brief "break this change, prove it with a run") → join → `Reproduce` (reruns each finding's command; keeps only reproduced ones; reports, never fixes).
- **swarm (race)**: fork of N identical workers → join → `Aggregate` (PASS / ISSUES / BLOCKED with SHAs). **swarm (partition)** needs briefs written per run: use a `plan` node that emits `SKD_SHAPE` (2-4 paths, `flow-shape.ts:10-104`). Check that a plan node with no implement node passes `validateWorkflow`.
- **how**: fork: 2-3 `Explorer` → join → `Explainer`.
- **why**: `Anchor` (git blame / log / `gh pr view`) → fork: one `Investigator` per evidence category (source control always; issues, docs, chat when their MCP exists) → join → `Synthesizer`. Investigators need the node's `mcpServers` listed.
- **reflect**: fork: `Judgment`, `Tooling`, `Divergent` reviewers → join → `Synthesizer` → human approval (H4, or an In Session step where the chat asks the owner).
- **thermos**: fork: `Security & correctness`, `Code quality` → join → `Dedupe` (In Session).

**No node equivalent:**
- pstack's "minimum two runners, keep going if one drops out". The runner retries a node, but a join waits for every branch.
- Panel width comes from the length of a sheet list in pstack. Here it is fixed in the flow JSON. Ship three-wide defaults; the owner can "save as" a wider copy in Studio.
- "Read-only" children (pstack's judge, explorers). Shikidan nodes have no such field, so it becomes a line in the node's instructions.
- An enforced "judge family differs". The runner checks families only between `implement` and `review` nodes (`workflow-runner.ts:380-398`). A `review`-kind judge validates without an `implement` node, but nothing is carried into it, so it gets no check. The judge's engine is a default (codex, because the chat is Claude), not a guarantee. Making the runner carry `task` families into a judge is optional host change H5.
- To check: whether task nodes on a fork each get their own worktree, or share one.

## Models and effort

Recommended: each plugin flow node carries a default `agent` (engine + model). Plugin settings override them: `arena_runners`, `judge`, `swarm_workers`, `how_explorer`, `why_synthesizer`, and so on, named after pstack's role lines. Values are written into the flow at load time (H1).

Not recommended: adding pstack's 17 roles to `ROLE_NAMES` (`routes/roles.ts:8`). They are pstack's vocabulary, not Shikidan's. Shikidan's plan / execute / review stay as they are.

Effort has no home today: there is no field, and `buildEnv` strips `CLAUDE_EFFORT` (`engines.ts:99-111`). That is H3, and it is optional.

## Hook problem (must decide)

pstack's SessionStart hook (`hooks/session-start.sh`) checks only the `session hook: off` sheet line. It has no worker guard. In Claude-engine **worker** jobs it injects "invoke poteto-mode, spawn subagents", which contradicts `CORE_RULES` and skd-dispatch's "workers never dispatch" (`skills/skd-dispatch/SKILL.md:8-21`). This is true today, before any port.

Guard options:
1. **Host-side (recommended):** Claude worker spawns pass a settings override that disables the pstack plugin, or only its hook, for that process. Chats and terminals keep it. This needs a check that the Claude CLI accepts a per-process `enabledPlugins` override.
2. **Upstream:** ask pstack to skip the mandate when `SKD_JOB_ID` is set and `SKD_CHAT_ID` is not. Chats also get `SKD_JOB_ID` (`chat-profile.ts:17`), so we'd first need to confirm that workers lack `SKD_CHAT_ID`.
3. **Manual:** put `session hook: off` in the sheet while the cockpit runs. This also turns it off in plain Claude Code.

Unverified: whether the Agent SDK chat bridge loads `~/.claude` hooks at all. No `settingSources` is passed (`chat-bridge-core.ts:229-246`), and `node_modules` was absent when this was checked.

## Host changes, ranked by necessity

| # | Change | Why | Size |
|---|---|---|---|
| H0 | One generic flow-over-subagents sentence in `CHAT_RULES` (see Routing) | Without it the flows are never picked | Tiny |
| H1 | Run plugin flows through `fillTemplate` when `pluginFlows` loads them (`contributions.ts:180-195`). Add `{{mc:skills}}`, which resolves to `~/.claude/skills`: of the three profile dirs, that one is always under `$HOME`. If a `{{setting:…}}` inside an `agent` field is empty, drop the field. Today `fillTemplate` leaves the placeholder text in place (`contributions.ts:63`), which would spawn with model `"{{setting:…}}"`. | Node `skills` must be absolute paths under `$HOME` (`workflow-runner.ts:217-226`), and flows get no templating today. This also lets settings set node models. Pointing `node.skills` straight at the plugin cache doesn't work: that path contains the pstack version (`0.9.114`) and breaks on every update. | Small |
| H2 | Worker hook guard (see above) | Safety. pstack already misbehaves inside Claude workers. | Small |
| H3 | Optional `agent.effort` on nodes, passed as the engine's effort flag | pstack's `@effort` | Small–medium |
| H4 | Optional mid-flow human gate node | reflect's approval step | Medium |
| H5 | Optional: carry `task` families on fork paths into a downstream `review` node | Enforced cross-family judge | Small |
| — | Hook contribution kind, plugin CLI subcommands, extra `ROLE_NAMES` | Not needed for option A | — |

## Out of scope

statechart (mise/TLC/Java), watch-pr, orch, resume and the playbook system. These stay with the installed plugin. The Codex mirror also stays out: it flattens multi-agent text and `worker-codex` doesn't read mirrored skills.

## Tests (bun test, `SKD_FAKE_ENGINES=1`)

- `test/pstack-plugin-flows.test.ts`: every shipped flow passes `validateWorkflow`, uses only `task`/`join`/In Session nodes, and closes each fork at one join.
- Plugin install from a `createPluginRepo` fixture (`test/support/plugin-fixtures.ts`): flows show up as `pstack--<id>`, and `pstack-roles/` lands in all three profiles.
- H1: a flow's `{{setting:…}}` and `{{mc:skills}}` resolve at load; a secret or undeclared key fails with file and line.
- H2: a worker spawn carries the guard; a chat spawn does not.
- A run with fake engines goes Frame → 3 runners → join → Judge → Pick & graft, and each node spawns on the engine its `agent` (or setting) names.
- H0: `CHAT_RULES` contain the flow-over-subagents rule. Whether a live Claude chat told to "arena this" actually starts `pstack--arena` is a model behavior, so it gets checked by hand in the real cockpit, not by a unit test.

## Assumptions

- The plugin lives in its own repo (`skd-plugin-pstack`), like the other `skd-plugin-*` repos. Role prompt templates copied from pstack keep pstack's MIT notice.
- Panel defaults are claude / glm / codex. Grok or other connections can be swapped in per node.
