---
name: skd-dispatch
description: COCKPIT-FIRST implementation routing. Use for ANY implementation request — create/build/write/fix/add CODE that ships (features, fixes, scripts, pages) — whenever Shikidan is running (curl -s -o /dev/null -w '%{http_code}' ${SKD_URL:-${MC_URL:-http://127.0.0.1:7777}}/api/health returns 200 — or 401 on pre-2026-09 builds; both mean UP, anything else means down). NOT for analysis output — scans, audits, reports, docs-vs-reality checks, codebase Q&A go to native Explore/read-only agents (writing the report file does NOT make it implementation); post a plan label to the cockpit for visibility instead. NEVER dispatch a user's meta/routing question as a job prompt — answer it. The session stays orchestrator (plan → post plan → dispatch → review); the labor runs as a cockpit job (engine per GET /api/roles: `execute` for jobs, `review` for cross-review) so the user sees it in the session flow, agents panel, and review queue. Also triggers on "dispatch to glm", "send to codex", "/skd-dispatch". Skip only when the cockpit is not running, or the work is judgment/prod-critical per the dispatch table.
---

# skd-dispatch — cross-engine dispatch via Shikidan

## ARE YOU THE WORKER? (read first)

Cockpit jobs run the same `claude` binary as your interactive sessions, so
they load this CLAUDE.md, this skill, and every hook. If ANY of these hold,
you are the dispatched labor, not the orchestrator:

- `$SKD_JOB_ID` (or `$MC_JOB_ID` from a cockpit started before Shikidan) is set in your environment
- your prompt says "You are a Shikidan worker job" / "do NOT dispatch"
- you are running headless (`-p` / print mode) inside a repo with a spec-shaped prompt

Then: implement directly in the working tree, never post a plan, never call
`POST /api/jobs`, never invoke this skill again. A worker that re-dispatches
creates a second job on the same tree (happened 2026-09-04, job 43ba1200 →
cfb3ddde) and nothing lands in the parent's diff.

## Versioned workflow entry

This linked skill is a stable entry point. Never write a run's workflow or
instructions into this shared file. Shikidan composes the versioned
core prompt, selected blueprint, and current assignment for each node.

Use the terminal-provided `SKD_URL` and `SKD_CONFIG_DIR` for this
service. Never send a terminal from one Shikidan instance to another instance.
When `SKD_TERMINAL_ID` is present, start `POST /api/studio/runs` with
`terminalId`, the git repo the task targets as `cwd` (the terminal directory,
or a repo inside it when the terminal is opened on a folder of repos), `label`, and the complete
user `request`. The server uses that terminal’s pinned workflow.
`SKD_WORKFLOW_ID` and `SKD_WORKFLOW_REVISION` identify the selection; do not
replace it with a newer global default. To choose another workflow or
version, open a new terminal with that selection.

Outside a Shikidan terminal, read `GET /api/studio/workflows` after authenticating.
Use its `selected` workflow unless the user named another saved blueprint.
Start `POST /api/studio/runs` with `cwd`, `label`, and the complete user
`request`; include `workflowId` and `revision` for an explicit selection.
Omit those two fields to use the selected default. Read progress with
`GET /api/studio/runs/:id`. The run snapshots its blueprint, core prompt,
agent settings, and skill contents. Report its actual status and evidence.

The server owns planning, plan verification, implementation, review, and
custom nodes. Once a workflow run starts, do not also post legacy jobs,
start a second review, or follow the legacy execution steps below. On a
blocked or failed run, report the reason; `POST /api/studio/runs/:id/retry`
repeats the current step with its original revisions and may repeat side
effects, so use it only when the user's authorization covers that retry.

Only a 404 from the workflows endpoint means this is an older server: use
the legacy flow below then. Authentication or validation failures are not
a reason to bypass the workflow. Core policy and connection settings are
edited through Studio, separately from blueprint editing. Worker jobs must
never call these orchestration endpoints.

Shikidan (the local cockpit at `$SKD_URL`) runs jobs on other
engines: `glm` (GLM-5.3-Flash via z.ai — bulk implementation labor) and `codex`
(Codex CLI — cross-family review / overflow). Dispatching through it (instead of
raw `ccglm`/`codex exec`) gets you: session-flow tracking, live logs, diff-stat
capture, and the review queue.

## Auth

Set these when the terminal has not supplied them:

```sh
# ponytail: MC_* fallbacks for a cockpit started before Shikidan, drop once every install runs it
SKD_URL=${SKD_URL:-${MC_URL:-http://127.0.0.1:7777}}
SKD_TERMINAL_ID=${SKD_TERMINAL_ID:-${MC_TERMINAL_ID:-}}
```

Token lives in `secrets.json` in `$SKD_CONFIG_DIR` (default `~/.config/shikidan`) field `apiToken` (starts
`mct_`). It is LAZY-GENERATED: if the field is absent, fire one throwaway Bearer
request first (`curl -s -o /dev/null -H "Authorization: Bearer probe" $SKD_URL/api/flow`)
and re-read the file — never conclude the feature is missing from an absent key. Read it with a scoped jq/python read — NEVER print it:

```sh
# ponytail: MISSION_CONTROL_CONFIG_DIR and ~/.config/mission-control fallbacks, drop with the MC_* ones above
SKD_TOKEN=$(python3 -c 'import json,os;e=os.environ;c=os.path.expanduser("~/.config");d=e.get("SKD_CONFIG_DIR") or e.get("MISSION_CONTROL_CONFIG_DIR") or next((p for p in (c+"/shikidan",c+"/mission-control") if os.path.isdir(p)),c+"/shikidan");print(json.load(open(os.path.join(d,"secrets.json")))["apiToken"])')
```

All calls: `-H "Authorization: Bearer $SKD_TOKEN"`. Scope covers /api/jobs*,
/api/flow, /api/quota, /api/meta, /api/roles, /api/models, read-only Studio
workflow/policy endpoints, and Studio run start/read/stop/retry. It cannot
edit blueprints, core policy, or agent connections.

## Roles (which engine does what)

The cockpit Settings page maps `plan | execute | review` to engines. READ IT
FIRST — never hardcode glm/codex:

```sh
ROLES=$(curl -s -H "Authorization: Bearer $SKD_TOKEN" $SKD_URL/api/roles)   # {"plan":{"engine":"claude","model":null},"execute":{"engine":"glm","model":null},"review":{"engine":"codex","model":null}}
EXEC_ENGINE=$(printf '%s' "$ROLES" | python3 -c "import json,sys;print(json.load(sys.stdin)['execute']['engine'])")
EXEC_MODEL=$(printf '%s' "$ROLES" | python3 -c "import json,sys;print(json.load(sys.stdin)['execute']['model'] or '')")
REVIEW_ENGINE=$(printf '%s' "$ROLES" | python3 -c "import json,sys;print(json.load(sys.stdin)['review']['engine'])")
REVIEW_MODEL=$(printf '%s' "$ROLES" | python3 -c "import json,sys;print(json.load(sys.stdin)['review']['model'] or '')")
```

Each role also carries an optional `model` (null = engine default). `GET /api/models`
returns the current per-engine model lists (same Bearer token) when you need a valid model id. Pass it on
every dispatch as `"model":"$EXEC_MODEL"` / `"model":"$REVIEW_MODEL"` — an empty
string is ignored server-side, so always include the field. The cockpit turns it
into `claude --model X` or `codex -m X`.

- implementation jobs → `"engine":"$EXEC_ENGINE"` (codex jobs run with full access: no sandbox, no approvals — the user asked for it; keep prompts scoped to the worktree)
- cross-family review jobs → `"engine":"$REVIEW_ENGINE"`
- `plan` is the engine you are driving from (NEW TERMINAL default); nothing to dispatch
- auto-review (Settings → AUTO-REVIEW) is OFF by default: reviews are on demand
  (see "After completion"). When on, a done `execute` job with a diff spawns one
  `review` job (marked `reviewOf`), never a second

## Cockpit-first rule (overrides "trivial = do it myself")

If the cockpit answers on :7777, implementation work is dispatched through it BY
DEFAULT — including small/trivial tasks. Rationale: the user's goal is to see
every piece of AI labor in the cockpit (flow graph, agents panel, review queue);
a 2-minute task done silently in the main session defeats that. Main session =
orchestrator only: plan, post plan, dispatch, monitor, review, mark reviewed.
Trivial task → still post a 2–3 step plan + one glm job. The only exceptions are
the "native agent, NOT here" rows below and pure Q&A/discussion (no code output).
"Visible in the cockpit" for analysis work means a PLAN LABEL, not a glm job —
never downgrade judgment work to glm just to make it show up in the panel.

Exception — live-debug tight loop: if the task is iterating on a running
process/UI where each edit is judged by immediately checking the result
(interactive debugging, not a spec'd chunk), do it in the main session per
CLAUDE.md `orchestrator-agent-background-default` clause 3 — do not probe
cockpit health or dispatch first. This does not weaken the default for any
spec'd/dispatchable chunk. [daily-retro 2026-09-24 E01]

Exception — this repo is Shikidan itself (the shiki repo): for work on Shikidan's
own codebase, the cockpit-first default does not apply — not to
implementation, and not to plan or branch review either. Build and review in
the main session or with native Claude Code agents (Agent tool, explicit
opus/sonnet model, background), not cockpit `execute`/`review` jobs. The
2026-09-24 exception above only covered live-edit tight loops; on 2026-09-28 a
plan review and a branch review for this repo were still routed through
cockpit and had to be redone. See project memory
`main-session-when-confident.md` for the full statement and why (cockpit
`execute` maps to GLM; output needed redoing; quality matters more here than
cockpit visibility). If this recurs again, escalate to a mechanical
repo-identity check at dispatch time. [daily-retro 2026-09-28 E10]

## When to dispatch vs native agent

| Work | Route |
|---|---|
| Spec'd implementation ticket, mechanical/bulk, tests, docs | `glm` job here |
| Cross-family second-opinion review of a risky diff | `codex` job here |
| Judgment-heavy, house-style-critical, prod-adjacent | native Claude agent (Agent tool), NOT here |
| Scan / audit / report / docs-vs-reality / codebase Q&A (report file included) | native Explore/read-only agent + cockpit plan label, NOT a glm job |
| User's meta/routing/process question | answer it in prose — NEVER a job prompt |

Workers run on a slim profile (glm: `CLAUDE_CONFIG_DIR=~/.config/shikidan/worker-claude`,
codex: `CODEX_HOME=.../worker-codex`): no global CLAUDE.md, agents, skills,
hooks or plugins — measured 91k → ~20k tokens and 12s → 3s per turn. The prompt
is the worker's whole world and MUST open with the line
`You are a Shikidan worker job: implement directly in this tree, do NOT
dispatch, do NOT post plans, do NOT invoke skd-dispatch.` (belt and braces
against the cockpit-first rule if a worker ever runs on the full profile).
Check peak first: `GET /api/quota` → `peak.peak` true means 2× GLM credits
(Mon–Fri 13:00–17:00 Thai); prefer deferring bulk fleets during peak.

## Spec writing (the biggest lever after the profile)

The worker executes; the orchestrator decides. Every design choice the ticket
involves is made in the main session, from reading the code, before dispatch.
The job log (2026-09-14, 494 jobs) shows what leaving them open costs: nearly
every fix-loop reply was a decision the worker made alone — subset vs exact
header match, a return shape that had to be preserved, sliding vs fixed rate
window, a spec asserting against the constant it tests — at 50–400 worker
turns plus a review round each.

A spec is a numbered execution plan. Its parts, in this order:

1. Header: `You are a Shikidan worker job: implement directly in this
   tree, do NOT dispatch, do NOT post plans, do NOT invoke skd-dispatch. Execute
   the steps below exactly; do not redesign. If a step cannot be done as
   written, stop and report which one.`
2. Repo, stack, base branch, ClickUp id.
3. **Decisions** — every choice the ticket involves, each written as the chosen
   answer: `Recall rule: remembered header set ⊆ file header set.` A spec
   containing "or", "either", "as appropriate", "if it makes sense",
   "whichever fits" is not ready.
4. **Preserve** — each existing behaviour the diff touches, with its source:
   `unrecognised slot → { value: nil, tag: "unknown" } (leads_helper.rb:41)`.
5. **Steps** — numbered, one file per step: exact path, exact
   method/function/type signature, exact commit message. Literal values
   (constants, strings, Thai text, SQL, config keys) are copied into the step.
   Prose is only for what the worker derives mechanically from a file you name.
6. **Tests** — spec file path plus each example name with its literal expected
   value. Expected values are never computed from the constant under test.
7. **Constraints** — no commit / no push / no restart as applicable; the two
   comment-rule lines verbatim; `While iterating run only the tests for files
   you touch; run the full suite ONCE at the end.` (measured: 55–62 full-suite
   runs per job without it).
8. The acceptance baseline block below, verbatim.

Writing 3–6 means reading the code the steps touch. That is the cost, and it
is smaller than the review-fix loop it replaces. Contract or type changes that
cross modules: every exact type goes in the spec.

### Pre-dispatch gate

Check the finished spec against this list before `POST /api/jobs`. A miss
means edit the spec, not dispatch. The cockpit enforces the section, hedge
and file-path checks itself: a prompt for the execute engine that fails them
gets a 422 with the miss list, and no job is created.

- [ ] every step names a file path and a signature
- [ ] zero "or" / "either" / "as appropriate" in Decisions and Steps
- [ ] every existing behaviour the diff will touch appears under Preserve
- [ ] a new validation, constraint or required association lists EVERY
      creation site it breaks (grep the factories, specs and services that
      build the record) as tasks — "about ten files" on 2026-09-14 was 28,
      and the gap became an 84-minute job
- [ ] every test example has a literal expected value
- [ ] at most 8 steps inline; a longer plan lives in
      `docs/superpowers/plans/*.md` in the tree and the spec says
      "execute tasks N..M of <file> in order"

### One task = one job (one employee, one deliverable)

A worker is one employee with one deliverable: one plan task, one commit,
then stop. Never hand a worker the whole plan. A single 8-task job on
2026-09-14 ran 84 minutes and 607 turns, most of it improvising around a
sibling repo that moved underneath it; at turn 30 a worker is sharp, at turn
600 it is writing throwaway scripts in /tmp.

**Fan out first, chain only what must chain.** One long `o---o---o` is the
slowest shape that works and it is the one you reach for by reflex. Before
dispatching, walk the plan and write the dependency next to each task — the
file it edits, the symbol it needs to already exist. Tasks with no arrow into
them start NOW, in parallel:

```
o---o---o        reflex: 3 sequential jobs, 3x the wall clock
o---o            what to dispatch instead: two chains plus a loner, all
o---o            starting at once, landing in order by cherry-pick
o
```

- **Independent tasks fan out** into separate worktrees under separate labels,
  dispatched in the same breath, landed in order by cherry-pick. That is where
  unlimited headcount pays; never two jobs on one tree at once.
- **Dependent tasks chain** in one worktree under one label, through the plan
  runner below. Each job starts with fresh context; a failure re-runs one
  task, not the plan. A chain needs a named dependency — "it feels sequential"
  is not one, and neither is "they touch the same repo".
- **Cross-repo dependencies serialize.** A chain that depends on another
  repo's change (army on core, api on core) does not start until that change
  has landed; its first task pins to the landed SHA. Both chains running at
  once is what stranded the 84-minute job.
- A single-task ticket is still one `POST /api/jobs`.

### Acceptance baseline — paste into EVERY worker prompt (claude, glm, codex)

Workers run on the slim profile, so the prompt is their only contract. Every spec ends with the block below verbatim, after the ticket-specific acceptance bullets.

```
Done means all of these hold, verified by you before you report:
1. The assignment's acceptance criteria are met, each checked against real behavior (run it), not by reading the code.
2. New or changed behavior has a test that fails without the change. The tests for every file you touched, and for code that depends on what you changed, pass. Run those while iterating and once more at the end. Do NOT run the full suite: the orchestrator runs it once at landing.
3. No regressions: existing callers, public interfaces, stored data and config keep working. Any intended break is named in your report with the reason.
4. The repo's own build, type check and linter pass for the files you touched with no new warnings. No debug output, commented-out code or hard-coded secrets are left behind.
5. Nothing on the remote is lost: fetch and rebase onto the latest base before you finish; never force-push or drop commits.
6. Docs that describe the changed behavior (README, docs/, help text) are updated in the same change.
Report the exact commands you ran and their summary lines as evidence for 2 and 4, and every intended break (or "none") for 3. The reviewer signs that evidence off, not you.
```

A job that reports done without that evidence is not done: reply to it
(`/reply`) asking for it before review.

**Landing gate (orchestrator, not the worker):** after `POST /api/jobs/<id>/land`
cherry-picks onto the base branch, run the repo's full test command (for
example its CI script) ONCE on the base branch before any push. One full run
per landed change, serialized, never concurrently across worktrees: concurrent
full runs against shared test infrastructure (one test database, one port)
collide and fail for reasons unrelated to the change. A failure here is a
NO-SHIP: fix via `/reply` to the job, re-land, re-run.

**Autonomous push conditions (default in the project's acceptance checklist):**
when the user sets a session-scoped finish-and-push condition ("push to tip
of remote once done"), default to including the project's own documented
acceptance gate rather than waiting for them to append it — e.g. klangtech
sessions have a standing `four-concerns-checklist` project memory (the worker
contract's 4 acceptance lines) that is easy to forget in the condition's
phrasing. Check for a matching project memory before treating "done" as
"tests pass". [daily-retro 2026-09-21 E09 — the same gap recurred
2026-09-15, 2026-09-18, and 2026-09-21]

**UI parity citation (ticket-specific acceptance, not part of the verbatim
block):** any spec for an Army / Backoffice / Portal screen that has an
equivalent in a sibling repo MUST name the sibling file(s) the worker copies
its fields, layout AND user journey from (path + what to mirror), and the
worker's report must cite them. No citation = not dispatched; the reviewer
rejects a UI job whose report lacks it. This is the mechanical answer to the
`design-from-source` clause 13 loop (prose failed at 63 recurrences; Army
export mapping/variable/journey redesigned from mockups instead of backoffice
on 2026-09-23). [daily-retro 2026-09-23 E01-E03]

**"All N concerns pass?" answers are a table.** When the user asks whether the
acceptance concerns pass, reply with one line per concern (1-7: PASS/FAIL +
the evidence command), never a bare "yes" — the user asked twice in a row on
2026-09-23 because the first answer carried no per-concern status.
[daily-retro 2026-09-23 E09]

**Do not wait to be asked (2026-09-29).** Three habits the user had to prompt
for across sessions:
1. End every landing report with the per-concern table (1-N, PASS/FAIL + the
   evidence command) unasked; N is whatever the baseline block above holds
   (7 as of 2026-10-11), and `four-concerns-checklist` is only the legacy
   memory name. He asked "5 concerns gone?" in three separate sessions before
   allowing a push.
2. Before the first dispatch on a repo, run `git fetch` and print one line of
   ahead/behind against the origin tip, so "did you pull from remote yet?" is
   never needed (seen 2026-09-21 and 2026-09-29).
3. After each dispatch, one line: job id, where to watch it in the cockpit, and
   the next milestone; "but i see nothing running?" means the receipt was
   missing.
[daily-retro 2026-09-29 E06, E08, E10]

## Plan first (makes the cockpit graph real)

Post the plan AS SOON AS it is agreed in discussion — do not wait for dispatch.
A plan-only label immediately appears in the cockpit as a session with pending
steps, so the user watches the plan the moment it exists; re-POST when the
discussion changes it (last-write-wins). Then dispatch when ready.

Post the plan for the ticket — the cockpit renders it as the
session's node graph (one node per step, assignee-colored, live states):

```sh
curl -s -X POST $SKD_URL/api/flow/<label>/plan \
  -H "Authorization: Bearer $SKD_TOKEN" -H 'content-type: application/json' \
  -d '{"steps":[{"title":"<step>","assignee":"claude|glm|codex|user","status":"pending|active|done"}],"next":"<what happens after>"}'
```

- steps ≤32, non-empty; POST replaces the whole plan (last-write-wins)
- as work progresses, PATCH single steps (0-based):
  `curl -s -X PATCH .../api/flow/<label>/plan/<i> -H "Authorization: Bearer $SKD_TOKEN" -H 'content-type: application/json' -d '{"status":"done"}'`
- keep the plan honest: mark your own steps active/done as you do them; the
  dispatched job's live activity feed shows automatically (no action needed)

## Dispatch

### Plan review before task 1 (codex, ~2 min)

Of the 8 correction commits on 2026-09-14, 5 were design gaps a reader of the
plan could name before any code existed: a race inside a transaction, a destroy
with no cascade rule, a direct write that bypassed the parent's validation, a
uniqueness collision in a backfill, a dry run that reported work it would skip.
So the plan gets the adversarial pass, not only the diff:

`{"engine":"$REVIEW_ENGINE","prompt":"Read <spec> and <plan> only. For each task list what breaks: concurrency, deletion/cascade, writes that bypass a validation, uniqueness collisions, dry-run vs real accounting, callers not in Preserve. Findings only, one line each; first line SHIP or NO-SHIP."}`

Every finding becomes a Decision, a Preserve line, or a task BEFORE the run
starts. Show the user the Decisions list at this point; a five-minute read of
twenty decisions is where "data in a migration" gets caught, not commit 12.

### Multi-task plan → the plan runner (default)

```sh
curl -s -X POST "$SKD_URL/api/flow/<label>/run" \
  -H "Authorization: Bearer $SKD_TOKEN" -H 'content-type: application/json' \
  -d '{"engine":"'"$EXEC_ENGINE"'","model":"'"$EXEC_MODEL"'","cwd":"<ABS_PATH_GIT_REPO>","terminalId":"'"${SKD_TERMINAL_ID:-}"'",
       "preamble":"<header + repo line + Decisions + Preserve + Constraints + acceptance baseline>",
       "tasks":[{"title":"<task 1 title>","prompt":"<task 1 step body with exact path, signature, code, commit message>"}, ...]}'
```

- The server composes one prompt per task (preamble + `### Step N of M — title`
  + body + "one commit, then stop"), lints every task up front (422 with
  misses), and dispatches task 1 in `.worktree/<label>`. Each settle checks the
  worktree HEAD: new commit → next task, same worktree, fresh context; no
  commit or non-zero exit → run `failed`, remaining tasks stay `pending`.
- The task list becomes the label's plan, so the flow graph shows one step
  per task moving pending → active → done on its own; do not also POST a plan.
- `GET .../run` reads state (`tasks[].status`, `commit`, `error`);
  `POST .../run/stop` kills the current job and halts. 409 if a run is
  already running for the label.
- Task prompts are Steps bodies only; Decisions, Preserve and the baseline
  live once in the preamble. Put "re-pin <dep repo> to <SHA>" as task 1 when
  the chain depends on another repo's landed change.

### Single task → one job

```sh
curl -s -X POST $SKD_URL/api/jobs \
  -H "Authorization: Bearer $SKD_TOKEN" -H 'content-type: application/json' \
  -d '{"engine":"'"$EXEC_ENGINE"'","model":"'"$EXEC_MODEL"'","cwd":"<ABS_PATH_GIT_REPO>","worktree":true,"label":"<kebab-ticket-name>","prompt":"<SELF-CONTAINED SPEC>","terminalId":"'"${SKD_TERMINAL_ID:-}"'"}'
```

- `cwd` is the repo root under $HOME; the cockpit makes `.worktree/<label>` itself; land with `POST /api/jobs/<id>/land` after review (cherry-pick, never merge).
- `terminalId`: always pass `$SKD_TERMINAL_ID` as shown — set automatically when the
  session runs inside a Shikidan terminal; empty elsewhere (harmless). It ties
  the job to the dispatching terminal so the cockpit's agents panel can scope per-terminal.
- `label` = the ticket name; it becomes the session in the cockpit's flow graph —
  reuse the SAME label for follow-up jobs (codex review of the same ticket) so
  stages chain: IMPLEMENT → CROSS-REVIEW → VERIFY → MERGED
- returns `{id, status:"running", ...}`

## Monitor

```sh
curl -s -H "Authorization: Bearer $SKD_TOKEN" $SKD_URL/api/jobs            # {jobs:[...]} newest first
curl -s -H "Authorization: Bearer $SKD_TOKEN" $SKD_URL/api/jobs/<id>/log   # full log
curl -s -H "Authorization: Bearer $SKD_TOKEN" $SKD_URL/api/flow            # plans + stages + currentActivity per label
curl -s -H "Authorization: Bearer $SKD_TOKEN" $SKD_URL/api/jobs/<id>/activity  # live feed: what the model is doing now
```

Poll `/api/jobs` until the job's `status` is `done`/`failed` (spawn a background
Bash with a sleep loop rather than blocking). `failed` → read the log, fix the
spec, re-dispatch same label.

Time budget — a small ticket (UI tweak, one endpoint, a fix) should finish in
5–10 min on the slim profile:
- at 10 min, read `/api/jobs/<id>/activity`; if it is looping (re-reading the
  same files, re-running the full suite, retrying a failing command), kill it:
  `curl -s -X POST -H "Authorization: Bearer $SKD_TOKEN" $SKD_URL/api/jobs/<id>/kill`
  then re-dispatch with a tighter spec (name the exact file + change).
- 20 min without a diff on a small ticket = wrong spec, not a slow model. Stop
  and rewrite; do not wait it out.

## Talk to a running/finished job (thread continuation)

Every job is a resumable thread (claude/glm via `--resume`, codex via `exec resume`).
To steer or follow up without re-dispatching:

```sh
curl -s -X POST $SKD_URL/api/jobs/<id>/reply -H "Authorization: Bearer $SKD_TOKEN" \
  -H 'content-type: application/json' -d '{"message":"<follow-up instruction>"}'   # → new chained job, same context
curl -s -H "Authorization: Bearer $SKD_TOKEN" $SKD_URL/api/jobs/<id>/thread   # full ordered transcript: user/thinking/tool(+input,+result)/text/result
```

Use reply for: "also add tests", "you missed X", "explain what you changed" — cheaper than a fresh spec, keeps the agent's context.

## After completion (no review loops)

The old loop — implement → codex review → NO-SHIP → glm reply → review again —
turned 10-minute UI tickets into 2-hour sessions. Replace it with:

0. Review happens on the WORKTREE, before `land`. Landing first and reviewing
   after turned a 9-task feature into 17 commits on local main (8 of them
   corrections) that the owner could not review, and the day ended with a
   rebuild onto a fresh worktree. Order: worker done → review → fix on the
   worktree → land once, clean.
1. `done` + non-empty `diffStat` → read the diff yourself (`git diff` in the
   worktree, or the review queue). Run the tests once. This is THE review for
   a small ticket. GLM never self-certifies, but codex is not the default
   certifier either.
2. Cross-family codex review only when the diff touches auth, payments, data
   migrations, prod config, or concurrency — or when the user asks. ONE pass,
   same label, `{"engine":"$REVIEW_ENGINE","model":"$REVIEW_MODEL","prompt":"Review ONLY the diff of <commit|worktree>; read at most the files in it; report bugs, data loss, security, broken behavior only; first line SHIP or NO-SHIP"}`.
3. NO-SHIP findings: act only on real bugs. Worktree noise (database names,
   ports, .env, generated files) and style are not findings. Fix via one
   `/reply` to the implementation job. Do NOT dispatch a second review after
   the fix — verify the fix yourself by reading the reply's diff.
   **Fixes fold into the task they correct, never on top.** The worktree's
   history is private until `land`, so the fix reply says: `git commit
   --fixup <sha of the task commit>`; before landing run `GIT_SEQUENCE_EDITOR=:
   git rebase -i --autosquash <base>` on the worktree. The landed history then
   has exactly one commit per task however many review rounds ran. Migration
   files keep their filename and timestamp through the squash.
4. Verified good → commit per the repo's rules yourself, then mark it:
   `curl -s -X POST -H "Authorization: Bearer $SKD_TOKEN" $SKD_URL/api/jobs/<id>/reviewed`
   → flow shows MERGED, review counter drops.
5. Verification proportional to risk: browser/Playwright checks for UI the user
   will click; curl for endpoints; nothing beyond `bun test` for internal
   refactors. Do not spin a throwaway server for a one-line change.
6. Pushed → remove the worktree in the same step (see Worktree lifecycle).

## Worktree lifecycle (never work on main, never leave a landed tree behind)

Every edit, commit and test run for a task happens in a worktree, never in a
checkout that sits on the trunk; the main checkout only tracks origin.

1. **Start:** `git fetch origin && git worktree add -b <task> .worktree/<task> origin/<trunk>`.
   Copy the gitignored files the app needs (`config/master.key`,
   `config/credentials/*.key`, `.env`) from the main checkout. Link
   `node_modules` from the main checkout instead of installing, and keep the
   link out of commits.
2. **Land:** in the worktree, `git fetch origin && git rebase origin/<trunk>`,
   run the repo's gate once, then `git push origin HEAD:<trunk>`
   (fast-forward only; the local branch is a scratch handle, never pushed).
3. **Clean up right after the push:** run
   `~/.claude/skills/skd-dispatch/scripts/prune-worktrees <repo>`. It removes
   only worktrees that are clean, whose commits are all on `origin/main`,
   `origin/master` or origin's default branch (patch-equivalent, so rebased
   commits count), and that no running process is inside. It never touches
   the main checkout, and deletes the scratch branch with the worktree.
   `--dry-run` shows what it would do. Then
   `git -C <main checkout> reset --keep origin/<trunk>` if that checkout
   holds stale local copies of the landed commits.
4. **No timer, no cron** (check 6 of 7: no needless recurring jobs). Step 3
   runs over the whole repo, so a tree left behind by an earlier task is
   removed at the next push to that repo; the push is the trigger.

Starting a Shikidan server inside a worktree re-points
`~/.claude/skills/skd-dispatch` at that worktree. After such a session, check
`readlink ~/.claude/skills/skd-dispatch` and point it back at the main checkout
(`ln -sfn <shiki checkout>/skills/skd-dispatch ~/.claude/skills/skd-dispatch`).

## Failure modes

- Connection refused → cockpit not running: tell the user to `bun run start` in
  the shiki checkout; do NOT fall back to raw ccglm silently.
- 400 "engine environment is not configured" → z.ai token missing in cockpit
  Settings — surface to user.
- 401 → token rotated; re-read secrets.json.
- `PG::DuplicateTable` / "already exists" on a worker's `db:migrate` inside a
  worktree → do not treat it as a code bug first. The dev DB is shared across
  worktrees/sessions (same root cause as klangtech-worktree-up's 2026-07-17
  "shared dev DB schema.rb pollution" guardrail — this cockpit path spawns its
  own worktrees and does not route through that skill). Run `git worktree
  list`, check whether another worktree/session already applied a migration
  creating the same table, and resolve which branch owns it before re-running
  or rolling back. [daily-retro 2026-09-14 E10]
- Codex review job fails repeatedly with `"The '<model>' model requires a
  newer version of Codex. Please upgrade..."` (e.g. gpt-6-astra) → this is a
  PATH problem, not a model problem: the cockpit resolved an outdated `codex`
  binary (a `brew`/`nvm` install) ahead of the mise-managed one that actually
  supports the model. Do not retry the identical dispatch. Run `which -a
  codex` and compare every match's `codex --version` against the mise
  install (`~/.local/share/mise/installs/node/*/bin/codex` or the active mise
  shim) — the cockpit's own PATH/fallback-dir order needs the mise-managed
  binary to resolve first. Fix the PATH/symlink once, then re-dispatch.
  [daily-retro 2026-09-21 E03 — 4 identical failures in one session before
  this was isolated. RECURRED 2026-09-24 on a fresh day/session — the PATH
  fix wasn't applied permanently, only re-diagnosed. Treat this failure mode
  as a MANDATORY PRE-FLIGHT CHECK from now on: run `which -a codex` and
  confirm the mise-managed binary resolves first BEFORE dispatching any
  codex-engine job, not only after a job already fails with this error.]
