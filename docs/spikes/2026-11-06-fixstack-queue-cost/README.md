# fixstack queue cost spike

Question: a queued ClickUp card running the `fixstack--fixstack` flow costs far more turns than the same work done with `/fixstack` in one terminal session. Why, and what should change so a queued card runs about as cheaply, with the plan check, cross-family review, browser check, audit and DoD all kept?

Research only. No code was changed. Evidence: two runs dumped from the cockpit on 2026-11-06 (`GET /api/jobs`, `GET /api/queue`, and run `58874e08…` VAYU and run `30bf4927…` UX/UI), plus the Shikidan source, the fixstack plugin, the installed skills and the Claude Code docs.

Legend: **[fact]** is checked against a file, line or data dump. **[inference]** is my estimate or reasoning and has not been measured.

## TL;DR

1. The browser check (verify-ui) and the audit take about 60% of turns, and their re-runs alone take about 43%. Every fix round, even a 4-line comment fix, re-runs both from zero.
2. The flow never tells a re-check to look only at what changed. Shikidan already records the commit each step last saw, so the change can be made in the flow text alone.
3. A finding about wording in code comments counts as blocking, and the loop limit was raised to 5 for every step by one setting, then reset by a retry.
4. Every step is a new agent that gets a prompt of about 100k characters plus a 78 KB global CLAUDE.md, and it re-reads the repo and re-creates its server and database.
5. First change (flow text only, no Shikidan code): re-checks look only at the diff since their last run, and style findings stop blocking. Estimated saving: about 270–400 turns per card, 20–30%.

## Measured baseline [fact]

From `jobs.json`, grouped by `workflowRunId` and `workflowNodeId`:

| Node | VAYU jobs / turns / min | UX jobs / turns / min |
|---|---|---|
| verify-ui | 6 / 438 / 110 (36%) | 6 / 464 / 121 (35%) |
| audit | 3 / 294 / 91 (24%) | 3 / 280 / 87 (21%) |
| implement | 11 / 286 / 35 (23%) | 7 / 348 / 71 (27%) |
| architect | 2 / 88 / 13 | 2 / 82 / 21 |
| how | 1 / 49 / 6 | 1 / 58 / 9 |
| dod | 1 / 38 / 20 | 1 / 47 / 21 |
| review (codex) | 9 / 26 / 7 | 6 / 18 / 6 |
| verify-plan, route | 3 / 12 | 3 / 11 |
| **total** | **36 / 1,231 / 284** | **29 / 1,308 / 338 (stopped by user)** |

Re-check share. verify-ui: first pass 107 (VAYU) and 93 (UX), re-checks **331** and **371**. audit: first pass 97 and 84, re-checks **197** and **196**. Fix-round implement jobs: VAYU 226 turns over 9 jobs, UX 181 over 6.

Assignment prompt length (characters, much of it Thai, so tokens are not a fixed ratio): 8.7k at `route`, 39k at attempt #3, and **94k–106k from VAYU #22 to the end**. That includes the 3-turn codex review jobs (#23 103k, #32 96k).

The terminal `/fixstack` numbers ("far fewer turns") come from the user and were not measured in this spike.

## Root causes

### R1. A re-check after a pass is a full check [fact]

- `RECHECK_NOTE` ("fail again only for findings from your earlier check that are still not fixed…") is added only when the node's **own last result was fail**. See `server/workflow-runner.ts:111-112` and `:505-506`.
- In VAYU, verify-ui #26 and #33 and audit #34 came right after their own passes, so they got no note. The breakdown of #33's prompt has no `recheck` key. Their only instruction is the first-pass instruction: boot, seed, drive the whole flow, compare, tear down (`skd-plugin-fixstack/flows/fixstack.json`, verify-ui node).
- Result: VAYU #33 summary: "The diff since 38e1539b is 4 comment lines, and the whole flow was re-run anyway on a fresh database: 20 steps." That cost 47 turns. Audit #34 then re-ran both reviewers for 102 turns.
- UX: DoD #23 failed because a spec example sat in the wrong file. Moving the test (implement #24, 16 turns) set off a full verify-ui (#26, 74 turns) and a full audit (#27, 102 turns), and that audit then found a **new** interrogate finding.
- The data needed for a delta is already in the prompt. Each upstream input carries its attempt's `workspace` (`workflow-runner.ts:498`), and `workspace.head` is set at `:723` (`klangtech-army:38e1539b…` on VAYU #29). Nothing in the flow tells the agent to use it.

### R2. Style findings block, and the re-check rule keeps them blocking [fact]

- `skills/fixstack-steps/thermo-nuclear.md:8` treats comments as slop, and `:38` fails on "any blocker or clear structural regression". The audit node fails on "any thermo-nuclear blocker or clear structural regression" (flow JSON, audit node).
- `RECHECK_NOTE` makes "findings from your earlier check that are still not fixed" fail again, whatever their severity.
- VAYU audit #30: "7 of 8 thermo-nuclear findings are fixed; the remainder of finding 8 stays: the old feature name in header comments … That comment-only edit is the only required fix."
- That one finding cost implement #31 (7 turns), review #32 (3), verify-ui #33 (47) and audit #34 (102): **159 turns, about 13% of the card**.

### R3. The loop limit exists but was loosened twice [fact]

- The plugin flow sets `maxVisits` verify-ui=2, audit=3, implement=3, mockups=2, dod=1, verify-plan=3; the rest default to 3 (`workflows.ts:30`).
- `plugins/contributions.ts:191-195`: if the plugin setting `maxAttempts` is non-empty, **every** node's `maxVisits` is overwritten with it. Both run snapshots show `maxVisits: 5` on every node, so the setting is `5` and the per-node tuning has no effect.
- `workflow-runner.ts:465-467`: visits count only from `run.budgetFrom` onward. `:1151` sets `budgetFrom = attempts.length` on every Retry. Both runs were retried mid-run (`budgetFrom` 23 and 25), so every counter went back to zero. That is how VAYU's verify-ui ran 6 times under a limit of 5.
- `sentBy` (`:469-472`) counts the limit per (node, sender). `implement` has five fail-edge senders (implement, review, verify-ui, audit, dod), so its limit of 3 really means up to 15 visits.
- There is no card-level limit on gate-fail rounds. Only a run-wide cap of 256 attempts (`:468`).
- [inference] Why both runs were retried is not in the dumps. In both, the retry happened just before a `review` step, which matches `dispatch` blocking on reviewer availability at `:489-495`.

### R4. Every step is a cold, separate agent [fact]

- Each attempt is a new `claude -p` / `codex exec` job with its own session id (`jobs.json`: a distinct `sessionId` per job). The args are `-p <prompt> --output-format stream-json --verbose --model …`, plus `--append-system-prompt <coreRules>` (`jobs-engine-iface.ts:48-56`, `:117-120`). There is no `--max-turns`.
- Resume is supported (`--resume` at `jobs-engine-iface.ts:54`, codex `exec resume` at `:52`, `resumeSupported` recorded at `jobs.ts:395`). The runner uses it only for the "you forgot SKD_RESULT" nudge (`workflow-runner.ts:576-586`).
- The workspace (worktree) **is** reused: every job runs in `token.workspace` (`stepJob`, `:557-561`). The dev server and database are **not** reused. The verify-ui instruction ends with "Stop the app afterwards and confirm the port is free", and the evidence shows `DROP DATABASE done` (VAYU #33). Workers also run with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (`engines.ts:124-128`, applied to every workflow job via `step: true` at `jobs.ts:763` and `jobs-engine-iface.ts:128`), and core rules say "anything left running is lost". Nothing outlives a step.
- In Session (one session doing several steps) is not allowed on implement, verify and review steps (`docs/decisions/workflow-studio.md:73`), and a queue run has no owning session anyway.

### R5. The prompt grows with every node's latest output [fact]

- `composeWorkflowPrompt` (`workflows.ts:421-427`) JSON-encodes the request, the full node, the notes, inlined skills and `upstreamEvidence`. `upstreamEvidence` holds the **latest attempt of every node on the path**, each with its full `output` (up to 64,000 chars, `workflow-runner.ts:224`, `:676`), its result, its check output and its workspace (`:497-498`).
- Breakdown of VAYU #22 (103,732 chars):

  | Part | Size |
  |---|---|
  | `audit` output | 19.9k |
  | `implement` check output (ci.sh log) | 17.9k |
  | `how` output (marked `older`) | 14.9k |
  | `architect` output (marked `older`) | 13.4k |
  | `verify-ui` output + result | 6.4k + 3.5k (the result repeats the output) |
  | `route`, `verify-plan`, `review` | the rest |

  Items marked `older` are still sent in full; only the `sentBack` note tells the agent to skip them.
- The same prompt goes to the codex review jobs, which finish in 2–4 turns.
- **Global CLAUDE.md.** For engine `claude`, `workerEnv` returns `{}` (`worker-profile.ts:63-68`). Only `glm` gets a worker `CLAUDE_CONFIG_DIR`. So every claude worker loads the user's `~/.claude`: the 78 KB `CLAUDE.md`, the `rules/` files, hooks and every plugin except pstack (`worker-plugin-guard.ts:5-13`). The headless docs confirm that a non-`--bare` `-p` run loads CLAUDE.md, hooks, skills and plugins from `~/.claude` ([headless](https://code.claude.com/docs/en/headless)).
- [inference] That CLAUDE.md also contains orchestrator rules ("dispatch to agent", "COCKPIT-FIRST skd-dispatch") that contradict the worker core rules. Workers probably spend some turns working out which rules apply.

### R6. Review and verify-ui are sequential gates with separate fix loops [fact]

- The edges run implement → review → verify-ui → audit → dod, and every fail goes back to implement (flow JSON `edges`). Each later gate finds things only after the earlier gates have passed, so each finding costs a full trip through the chain again.
- VAYU: audit #21 found 13 issues only after verify-ui had run three times (#13, #16, #20). Each of those fixes then went through review and a full verify-ui again.

## What terminal `/fixstack` does differently [fact, from `~/.claude/skills/fixstack/SKILL.md`]

- One orchestrator session keeps the context the whole way. Implementation is handed to one background agent (`:48`, `:56-63`). After that "you own the diff": the orchestrator makes fixes inline, with no fresh agent per fix.
- Verify runs once (`:65`). interrogate and thermo-nuclear run once, on the final diff (`:51`). DoD runs once, and "any red → fix, do not push" (`:69`).
- Re-checks are scoped by delta: "If the incoming commits touch files in your diff, redo Feature step 5 (verify)" (`:117`).
- [inference] Within one session, prompt caching keeps repeated context cheap. The Claude API cache lives 5 minutes by default and is refreshed on each use. A cache read costs 0.1x base input, and 0.05x on Opus/Sonnet 5.5. A cache write costs 1.25x, or 2x with the 1-hour TTL ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). Whether and how `claude -p` sets cache breakpoints is not documented on the pages I read.

## Options, ranked by turns saved against effort and risk

Turn savings are per card, estimated from the two runs. All estimates are **[inference]**.

| # | Option | What changes | Est. turns saved / card | Effort | Gate risk |
|---|---|---|---|---|---|
| 1 | Delta-scoped re-checks | flow JSON text (verify-ui, audit, dod) | 270–400 | low | low–med |
| 2 | Style findings do not block | `thermo-nuclear.md`, audit node text | ~80 avg (159 when it happens) | low | low |
| 3 | Real loop limit that escalates to a person | clear the `maxAttempts` setting; add a card-level cap | bounds the worst case (UX ran to 1,308) | zero / low | none |
| 4 | Trim the prompt | `workflow-runner.ts:497-498`, `:676`; worker profile | ~0 turns; ~40–55% of the prompt | low–med | low |
| 5 | Resume implement on fix rounds | runner `launch`/`stepJob` | 40–85 | med | low |
| 6 | Run verify-ui and audit in parallel | flow edges + join | about one serial cycle when both would fail (~100–150) | med | med |
| 7 | Reuse the server and DB across verify-ui runs | new Shikidan service lifecycle | 50–100 | high | med |
| 8 | Whole card as one session with subagents | new node kind or runner mode | largest, unmeasured | high | high |

### 1. Delta-scoped re-checks (recommended first)

- **What changes.** Instruction text only, in `skd-plugin-fixstack/flows/fixstack.json`:
  - **verify-ui.** "If upstreamEvidence has an earlier verify-ui entry, run `git -C <repo> diff <its workspace.head>..HEAD --stat` first. If the delta touches no runtime file (only comments, specs, docs or fixtures), pass, with the diff stat as evidence and without booting. Otherwise re-run only the steps whose screens, controllers, routes, locales or JS the delta touches, plus every item in `sentBack`. Reuse the harness and seed scripts already under `visualizer/<slug>/verify/`."
  - **audit.** "If there is an earlier audit entry, give both reviewers the delta since its head plus its earlier findings. A full-diff pass is required only on the first visit."
  - Optional runner change, to make this uniform for every flow: at `workflow-runner.ts:506`, also add a note naming the node's last-pass `workspace.head` when the node already passed.
- **Turns saved.** If re-checks drop to 30–50% of today's cost: verify-ui re-checks of 331/371 save 165–260, and audit re-checks of 197/196 save 100–140. VAYU #33 alone would drop from 47 turns to about 5.
- **Gate weakened.** A regression could come from code outside the delta's screens (UX #18 was such a case, but its delta did touch that flow).
- **How to keep it.**
  - The first verify-ui and the first audit stay full.
  - DoD gets one more row: the last **full** verify-ui and audit passes are at a sha whose diff to HEAD touches no runtime file. If not, DoD fails back once to a full verify-ui.
  - interrogate still proves every finding by running it.

### 2. Style-only findings do not block

- **What changes.**
  - `skills/fixstack-steps/thermo-nuclear.md`: rule 8 (comments) and Priority 7 (legibility, naming) go under "Non-blocking notes". The Blockers list stays as it is.
  - Audit node text: "a re-check fails only on findings from the Blockers list or a verified interrogate finding; comment and naming findings go to DoD as notes."
  - Carry those notes to implement as a "fix while you are there" list on the next real fix round, or to DoD, which already runs `/deslop` and `no-comments` style checks.
- **Turns saved.** 159 on VAYU, 0 on UX: about 80 per card on average.
- **Gate weakened.** Comment slop can ship.
- **How to keep it.** The implement instructions already require deslop and no-comments before each commit. The `comment-density-guard` hook stays as the backstop. If needed, have DoD check comment-only lines directly, without a whole new cycle.

### 3. A loop limit that escalates to a person

- **What changes.**
  - Clear the fixstack `maxAttempts` setting so the tuned per-node limits apply again (`contributions.ts:191-195`). This needs no code.
  - Small runner change: count gate-fail rounds per card across all senders, and do not reset the count on Retry. For example, after 2 full implement→gate rounds, `block` with "needs a person". Only an explicit "reset budget" action resets it.
  - Optionally, make `maxAttempts` cap each node at `min(flow value, setting)` instead of overwriting it.
- **Turns saved.** The average stays about the same. The worst case is bounded: UX would have stopped near attempt #15–18, about 600 turns earlier, with a person deciding.
- **Gate weakened.** None. A blocked card is the safe failure.

### 4. Trim the prompt

- **What changes.**
  - `workflow-runner.ts:497-498`: for inputs marked `older`, send `{node, outcome.summary, workspace}` and the path of the artifact, not the full `output`.
  - Send only the tail of `checks[].output` (for example the last 2k chars) and store the full log as a file.
  - Do not repeat `result.evidence` when it duplicates `output`.
  - For `review` (codex), send only the request, the latest `sentBack` and the diff pointer.
  - Separately, give claude workers a worker profile like glm's (`worker-profile.ts:65`). Do not use `--bare`: `--bare` also drops the subagents the audit node needs ([headless](https://code.claude.com/docs/en/headless)).
- **Saved.** About 50k of ~100k chars per prompt from VAYU #22 on: `how`, `architect`, `route` and `verify-plan` outputs are ~33k, and the ci log is 18k. Plus 78 KB of global CLAUDE.md per claude job. This removes a fixed cost from every turn of every job, about 1,250 turns per card. Turn count is mostly unchanged, unless conflicting CLAUDE.md rules cost turns, which I have not measured.
- **Gate weakened.** A gate might miss context it needs.
- **How to keep it.** Plans and decisions already live on disk (`visualizer/<slug>/DECISION.md`); give the paths. Keep full evidence for the node that sent the card back.

### 5. Resume implement on fix rounds instead of a cold start

- **What changes.** In `launch`/`stepJob` (`workflow-runner.ts:519-561`): when `node.kind === 'implement'`, a previous implement attempt on this path has a `sessionId` and `resumeSupported`, and the engine is the same, call `createJob({ …, resumeSessionId })`. The prompt is just the `sentBack` failure and the new evidence. The plumbing already exists for nudges (`:580`).
- **Turns saved.** Fix-round implement turns are 226 (VAYU) and 181 (UX). Skipping re-orientation might save 20–35%, so 40–85.
- **Gate weakened.** Cross-family review is unaffected. The implementer keeps its own blind spots, which it has anyway.
- **Caveats.**
  - Gates take 30–60 minutes, far longer than the 5-minute cache, so each resume re-sends the whole transcript as a cache write at 1.25x. The token effect is unproven. Measure `total_cost_usd` from the `json`/`stream-json` result ([headless](https://code.claude.com/docs/en/headless)) before and after.
  - Long sessions (UX #6 ran 167 turns) may compact.

### 6. Run verify-ui and audit in parallel, with one fix round for both

- **What changes.**
  - Flow edges: review pass → fork to verify-ui and audit → join → dod.
  - A fail from either goes to implement with both results.
  - Parallel paths get their own branch and worktree (`OpenSection.paths[].workspace`, `workflow-runner.ts:49`, `:793-799`). That means one more checkout per fork, separate databases, and no collisions on the test DB.
- **Turns saved.** It removes the serial "verify-ui passes three times, then audit finds 13 things" pattern (VAYU #13–#21). About one verify-ui+review+implement cycle, ~100–150 turns, when both would have failed.
- **Gate weakened.** None, if the join requires both to pass.
- **Not verified.** How join and fail routing behave when one path fails while the other is still running. Check `docs/decisions/workflow-studio.md` and the fork and join code before choosing this.

### 7. Reuse the running server and database across verify-ui runs

- **What changes.** A Shikidan-managed per-card service, for example a `services` field on the flow, started by the runner and stopped at land or stop. Today nothing outlives a job (R4). Cheap partial version with no Shikidan change: one DB name per card, dropped only at DoD, and verify-ui re-runs its saved seed script.
- **Turns saved.** Perhaps 10–20 turns of boot, seed and teardown per verify-ui re-run, so 50–100 per card. Mostly redundant once option 1 lands.
- **Gate weakened.** Stale state can hide a persistence bug, and the server can run stale code after migrations.
- **How to keep it.** Reseed the records the check touches, and run migrations every time.

### 8. Whole card as one long session with subagents, Shikidan tracks gates only

- **What changes.** A new node kind (or runner mode) where one claude session runs how→architect→implement→verify→audit→dod with subagents, as terminal `/fixstack` does, and reports each gate to Shikidan.
- **Conflicts with today's enforced invariants.** "Implementation requires a verified plan" (`:488`). Cross-family review before finishing (`:489-495`, `:738`). In Session is not allowed for implement, verify and review (`workflow-studio.md:73`).
- **Turns saved.** Likely the largest, but unmeasured. The terminal turn counts come from the user.
- **Gate weakened.** Reviewers would no longer be independent of the implementer's context, and plan verification and cross-family review would be reported by the agent rather than enforced by the runner. Per-step visibility and retry granularity are lost.
- **Recommendation.** Do not start here. Options 1–5 get most of the gap while keeping runner enforcement.

## Recommended first change

Option 1 plus option 2, in the fixstack plugin only (flow JSON instructions for verify-ui, audit and dod, and `thermo-nuclear.md`), plus clearing the `maxAttempts` setting (option 3, first part). No Shikidan code. Estimated about 270–400 turns per card, roughly 20–30%. Option 2 removes a style-only cycle outright (159 turns on VAYU); option 1 shrinks the re-checks that remain. Do not add the two numbers: VAYU #33/#34 are counted in both. Every gate still runs: the first full pass, plus a DoD row proving a full pass covers HEAD.

Then measure the next two cards in the same way (turns per node from `GET /api/jobs`) before taking on option 4 (prompt trimming) and option 5 (resume).

## Sources

- Shikidan: `server/workflow-runner.ts` (111-112, 224, 465-472, 488-498, 505-516, 519-561, 576-586, 676, 723, 733-739, 1151); `server/jobs.ts` (395, 763); `server/workflows.ts` (22-34, 421-427); `server/jobs-engine-iface.ts` (48-56, 103-128); `server/engines.ts` (124-132); `server/worker-profile.ts` (39-68); `server/worker-plugin-guard.ts`; `server/plugins/contributions.ts` (180-198); `docs/decisions/workflow-studio.md:73`.
- Plugin: `skd-plugin-fixstack/flows/fixstack.json` (nodes, edges, `maxVisits`); `mc-plugin.json` (`maxAttempts` setting); `skills/fixstack-steps/thermo-nuclear.md`, `interrogate.md`.
- Terminal skill: `~/.claude/skills/fixstack/SKILL.md`.
- Data: `jobs.json`, `run_vayu.json`, `run_ux.json` (scratchpad dumps of 2026-11-06).
- Claude Code docs: [CLI reference](https://code.claude.com/docs/en/cli-reference) (`--resume`, `--session-id`, `--fork-session`, `--max-turns`, `--max-budget-usd`, `--bare`); [headless / programmatic](https://code.claude.com/docs/en/headless) (continue/resume in `-p`, bare mode, `total_cost_usd`); [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (5-minute default TTL, 1-hour option, read and write multipliers).
