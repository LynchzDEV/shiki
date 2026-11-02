# fixstack as a Shikidan plugin — paste a card, pick a variant, click Deploy prod

Status: design, awaiting review. Builds on `2026-10-05-card-queue-design.md` (queue engine, phase 1 built), `2026-10-12-plugin-contributions-design.md` (plugins contribute agents, skills, flows) and the `fixstack` skill (`~/.claude/skills/fixstack/SKILL.md`), which this replaces as the way to run a feedback card.

## Goal

You paste a ClickUp card link into Shikidan. Shikidan reads the feedback, compares it with trunk, builds NOW + A/B/C mockups and stops once so you can pick. After the pick it builds, verifies, reviews, pushes, deploys to UAT, posts on ClickUp and writes the same report fixstack writes today. When every Shikidan review is green and UAT is healthy, the card shows a **Deploy prod** button. Production happens only when you click it.

## Decisions (with the user, 2026-11-02)

| Topic | Decision |
|---|---|
| Input | A ClickUp card link, optionally `?comment=<id>`. Pasted into Queue → Add item, or "Add to queue" on a ClickUp board card |
| Variant stop | Always. Every card stops after the mockups for an A/B/C pick, as fixstack does today |
| What unlocks Deploy prod | Shikidan's own reviews (Codex review, interrogate, thermo-nuclear, DoD all green) plus a healthy UAT. The tester's ClickUp reply is not waited on |
| Builder AI | Claude: sonnet implements, opus verifies and reviews. Codex is the required review step (see "Studio rule" below) |
| Home | A Shikidan plugin `skd-plugin-fixstack` for everything KlangTech-specific; the generic pieces it needs go into Shikidan core |
| Plugin repo | Private, `LynchzDEV/skd-plugin-fixstack` |
| After production | No ClickUp post in v1 |
| Scope | Same as the skill: Army, the other api-pinned engines, api. Portal and backoffice cards fail at add time with "out of scope" |

### Studio rule that changes the "opus review" answer

Studio requires an **Implement** step to be followed by a **Review** step on a *different model family* (`docs/workflow-studio.md`, "Review uses a different declared model family"). Sonnet build plus opus review is one family (Claude), so Studio refuses that flow. To keep both:
- the required **Review** step runs on Codex (cross-family);
- opus runs as three extra steps after it: verify-ui, interrogate, thermo-nuclear.

Opus still reviews every card. Codex's review is added on top, not swapped in for it.

### pstack is not available inside steps

Shikidan unloads the pstack plugin in worker and step jobs (commit `143ac98`), so a step cannot call `/how`, `/architect`, `/interrogate` or `/thermos`. Each step's instructions are written into the flow, and the rubric files are attached as skills by path ("Tools, skills & checks" snapshots them at run start). The plugin installs those files at `~/.claude/skills/fixstack-*/`, so the paths are stable.

## How a card moves

```
Add item (card URL, flow = fixstack, build in ~/klangtech)
  │  host: source.item → item.md (dossier + screenshots), DoD page → dod.md
  ▼
building ── Route ──(no DECISION.md)──► Compare ─► Mockups ─► end blocked, evidence "pick: …"
  ▲                                                               │
  │                                                               ▼
  │                                                         waiting-pick   (Shikidan only, never ClickUp)
  │                                   you click A / B / C ────────┘
  │   (pick.md written, item back to the front of the queue, same workspace)
  └── Route ──(DECISION.md exists)──► How ─► Architect ─► Verify plan ─► Implement ─► Verify UI
                                         ─► Review (Codex) ─► Interrogate ─► Thermo-nuclear ─► DoD
                                                                                          │ pass
                                                                                          ▼
                                                                  ready ─► landing:uat (auto)
                                                                                          │ ok
                                                                                          ▼
                                                                   on-uat ── [Deploy prod] button
                                                                                          │ click + confirm
                                                                                          ▼
                                                                  landing:prod ─► landed
Any step or stage failing past its cap ─► failed (log tail, Retry)
```

One card builds at a time (the queue's single build slot). Parked cards (`waiting-pick`, `on-uat`) don't hold the slot.

## Part A — Shikidan core changes

None of these exist today. Each is generic: nothing in core knows about ClickUp, kamal or KlangTech.

### A1. A pick stop that stays in Shikidan

Today a step that ends `blocked` with evidence lines posts them to the source as questions (ClickUp). The A/B/C pick must never reach ClickUp. Same precedent as `repo:` evidence lines, which never reach the source:

- An evidence line `pick: <option ids> | <mockup path> | <recommended id>` makes the item `waiting-pick` instead of `waiting-info`. Other evidence lines in the same result stay questions and post as today.
- The Queue row opens a **Pick** panel:
  - the mockup, embedded (A2), with tabs NOW / A / B / C;
  - the point → still present? → file → fix table, from the step's summary;
  - the out-of-scope list;
  - buttons, one per option, with the recommended one marked;
  - **Tag on ClickUp**: filled with the card's non-developer assignee, editable;
  - a note field (optional, goes into `pick.md`).
- Clicking an option writes `<workspace>/.mission-control/context/<source>/pick.md` (option, tester, note) through `queue-answers.ts` (backed up like answers today) and puts the item at the front of the queue for a new run on the same workspace. Nothing is posted.
- Store: `QueueState` gains `waiting-pick`, `landing`, `on-uat` (generic name: `awaiting-stage`), `landed`. Old `queue.json` loads unchanged.

### A2. Shikidan serves the mockups

The skill's per-card live-server plus `tailscale serve` would die when the step's job ends. Instead:
- `GET /queue/:itemId/files/*` serves files read-only from `<workspace>/visualizer/`. The path is resolved with realpath, must stay inside that folder, and links are refused.
- It's reachable remotely through Shikidan's existing remote access (`docs/remote-access.md`). There is no per-card port and no tailscale step.
- The Mockups step still renders every screen in headless Chromium and attaches the screenshots as evidence, so the pick panel works even when the HTML can't load.

### A3. Land stages on a flow

The queue stops at `ready` today, and queue decision 6 says agents never push or post. Shipping therefore runs on the host, as stages the flow declares:

```json
"land": [
  { "id": "uat",  "run": "auto",   "command": ["{{skill:fixstack-ship}}/ship-uat.sh"], "timeoutMin": 90,
    "env": { "STAGING_LOGIN": "setting:stagingLogin" } },
  { "id": "prod", "run": "button", "label": "Deploy prod",
    "preflight": ["{{skill:fixstack-ship}}/prod-preflight.sh"],
    "command":   ["{{skill:fixstack-ship}}/ship-prod.sh"], "timeoutMin": 60 }
]
```

- **When.** After the run passes (item `ready`), stages run in order. An `auto` stage starts at once. A `button` stage first runs its `preflight`, whose stdout (Markdown) becomes the confirm dialog. The item then waits as `awaiting-stage`, showing the button.
- **How.** Each stage runs as a normal **cockpit job**: live log, visible in the session flow and agents panel. It's a job and not a plugin call because `bin/ci` plus kamal takes 20+ minutes, far past any call timeout. It runs in the item's workspace with env `SKD_ITEM_ID`, `SKD_WORKSPACE`, `SKD_REPOS`, `SKD_ITEM_URL`, `SKD_RUN_ID`, plus `env` mapped from plugin settings. Secret settings are passed this way, by reference, because they can't be templated into files.
- **Result.** Exit 0 → next stage, or `landed` after the last one. The stage writes `<workspace>/.mission-control/land/<stage>.md` (its report) and `<stage>.json` (`{ post?: { kind, lines, status?, mention? } }`). If `post` is present the host calls the source (A4). This keeps it true that only Shikidan, never an agent, writes to ClickUp.
- **Failure.** Non-zero exit or timeout → `failed`, showing the stage name, the last 40 log lines and **Retry stage**. Retry re-runs that stage only. Stage scripts must be safe to re-run (each step checks whether it is already done).
- **Locks.** A per-repo lock around push and deploy stages across items, so two cards never push or deploy the same repo at once. A stage waiting on the lock shows "waiting for <item> to finish deploying".
- **Validation.** `land` commands are executable code. They are allowed only in plugin-contributed flows (trust consent already covers them) and in flows the user saves by hand, never in AI-drafted flows (Build with AI rejects invented checks today; same rule).

### A4. Source contract additions

```
source.post({ id, kind: 'ask' | 'update', lines, mention?: string, status?: string })
      → { commentId, status?: string }                       status = what the card shows after the call
source.page({ docId, pageId })  → { markdown }               a ClickUp Doc page, for the DoD template
```

- `update` posts without the question framing. `mention` is a ClickUp user id: the plugin writes a real mention, then reads the comment back and re-posts once if it came out as literal text. `status` sets the card's status by its exact name on that list.
- The ClickUp MCP is not available in steps, and its daily pool runs out. The DoD doc is fetched through `source.page` (REST) when the item is added and on every new run, then written to `dod.md` in the item context. It's always fresh, the same rule as the skill's.

### A5. The item report

Queue row → **Report** shows, in order: the run's step summaries and evidence, then each stage's `<stage>.md`. That is the same report fixstack writes today: what changed for the seller, the point table, DoD per repo, pushed shas, deploy and health, the sign-off line, the ClickUp link, what was skipped or not checked, and a `Safety:` line. `mctl queue report <id>` prints it.

## Part B — the plugin `skd-plugin-fixstack`

```
skd-plugin-fixstack/
  mc-plugin.json             pluginApi 2, runtime isolated, no server/screen; settings; contributes skills + flow
  flows/fixstack.json        the flow below, with its land stages
  skills/fixstack-steps/     one instruction file per step (compare, mockups, verify-ui, dod, …)
  skills/fixstack-review/    the review rubrics inlined from pstack (interrogate, thermo-nuclear, deslop, no-comments)
  skills/fixstack-ship/      ci.sh, ship-uat.sh, prod-preflight.sh, ship-prod.sh, health.sh, lib.sh
  skills/fixstack-template/  today's fixstack template/ (tabs, screenshot strip, copy table, ไฮไลต์ ใหม่ toggle, marks.css)
  test/                      manifest, flow validates, every script's bats tests against fixture repos
```

It needs the `clickup-board` plugin as its source (already implements `source.item/post/replies`). At add time it checks that this plugin is enabled and names it if missing.

### Settings

| Key | Type | Example |
|---|---|---|
| `reposRoot` | text | `/home/lynchz/Work/kingpinggroup/klangtech` |
| `apiRepo` | text | `api` |
| `engineRepos` | text | `army` (comma list of api-pinned engines) |
| `stagingUrl` | text | `https://staging-app.klangtech.com` |
| `prodUrl` | text | the production app URL |
| `dodDoc` | text | `3nbup-45016/3nbup-367616` |
| `stagingLogin` | secret | email:password for the changed-page render. Empty → that health check reports "not checked" |
| `memoryFloorGb` | text | `12` (below this, `ci.sh` refuses to start) |

### The flow (`flows/fixstack.json`)

| # | Step | Kind | AI | Checks / attaches | Pass → | Fail → (cap) |
|---|---|---|---|---|---|---|
| 0 | **Route** | task | claude haiku | check: `test -f visualizer/*/DECISION.md` | 4 How | 1 Compare |
| 1 | **Compare** | task | claude opus | reads `item.md`, `git pull --ff-only` on trunk per repo; writes the point → present? → `file:line` → fix table; lists specs, JS fixtures and docs asserting the text; lists out-of-scope things seen in screenshots | 2 | blocked |
| 2 | **Mockups** | task | claude opus | attaches `fixstack-template`, `visualize-me`; copies the template to `visualizer/<slug>/`, builds NOW + A/B/C, renders each in headless Chromium, attaches screenshots | 3 | 2 (2) |
| 3 | **Ask pick** | task | claude haiku | ends `blocked` with `pick: A,B,C \| visualizer/<slug>/ \| <rec>` → A1 | — | — |
| 4 | **How** | task | claude opus | maps the subsystem the decision touches (pstack How rubric inlined) | 5 | blocked |
| 5 | **Architect** | plan | claude opus | writes `DECISION.md` from `pick.md`, then the plan: files, commits in order, success criteria, DoD 2/5/6/7/8 as constraints | 6 | — |
| 6 | **Verify plan** | verify-plan | codex | Studio's plan check + design red flags | 7 | 5 (3) |
| 7 | **Implement** | implement | claude sonnet | attaches `fixstack-review/deslop`, `no-comments`; the comment rule verbatim (below); small ordered commits, each green alone, fixtures regenerated in the commit that changed markup; never bypass hooks, no Co-Authored-By. Check: `ci.sh` | 8 | 7 (3) |
| 8 | **Verify UI** | task | claude opus | boots each changed engine's `spec/dummy` on a free port, seeds records incl. an empty / no-image state, drives the flow in Chromium, screenshots it beside the chosen variant, queries the DB to prove saves persist, stops the app | 9 | 7 (2) |
| 9 | **Review** | review | codex | Studio's required cross-family review (pstack rubric) | 10 | 7 (3) |
| 10 | **Interrogate** | task | claude opus | attaches `fixstack-review/interrogate`: try to break the change, prove each finding by running it | 11 | 7 (2) |
| 11 | **Thermo-nuclear** | task | claude opus | attaches `fixstack-review/thermo-nuclear` on the final diff | 12 | 7 (2) |
| 12 | **DoD** | task | claude opus | fills `dod.md`'s table per repo on HEAD; 7 and 8 = verdicts of 10 and 11. Any red → fail | done | 7 (1) |

- Implement's instructions include both lines verbatim: "Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks." and "Do NOT match the surrounding code's comment density — existing dense files are legacy, not license."
- Step 0 makes one flow handle both runs: the first run takes the design branch and parks; the run after the pick sees `DECISION.md` and takes the build branch. No new core.
- No step uses fable.
- Overall node cap: 256 (Studio's limit). A step that runs out of retries stops the run as blocked → the item fails with that step named.

### `ci.sh` (the acceptance check)

Studio runs checks at the workspace root, which in a multi-repo workspace isn't a repo, so the check is one script:
1. Memory pre-flight from `MemAvailable`: ≥ 24 GB normal; 12–24 GB sets `PARALLEL_TEST_PROCESSORS=$(( $(nproc) / 2 ))` and `BROWSER_PROCESSES` the same; < `memoryFloorGb` → exit 2 with what holds memory (`/proc/meminfo`, GPU GTT, `llama-server`), killing nothing.
2. Waits while another `rspec` runs (`ps -eo pid,command | grep '[r]spec'`).
3. For each changed repo: per-worktree test DB name if `database.yml` reads one, full `bin/ci`, then the diff's specs with `--seed` 11111, 22222, 33333.
4. Checks each commit alone: `git rebase -x` with the diff's specs, on a throwaway branch.

### Stage `uat` — `ship-uat.sh` (auto)

Steps are the skill's Ship 2–8. Each one checks "already done?" first, so Retry is safe.
1. Per changed engine: fetch, rebase on `origin/main`, `ci.sh`, DoD 3 (0 behind, every outgoing commit is this item's branch), `git push origin HEAD:main` fast-forward only.
2. api: worktree off fresh `origin/main`, `bundle update <engine>`; the `Gemfile.lock` diff must be exactly the revision line; commit `chore(deps): bump <engine> to <sha>`; `ci.sh`; DoD 3; push. An api-only card pushes its own commits the same way.
3. `kamal deploy` (staging) at the pushed sha, logged.
4. Health, all five: `/up` 200; `kamal app details` shows the sha; `git show <sha>:Gemfile.lock` pins the engine sha; `kamal app logs` since boot have no errors (cred-shaped matches redacted); the changed page renders on staging with `STAGING_LOGIN` (else "not checked").
5. Sign-off: `bin/ci` again on the pushed sha with a clean tree must print `Signed off <sha>`.
6. Writes `uat.json`: `post` = `update`, status `review`, mention = the tester from `pick.md`, lines = the two Thai lines from the skill (staging URL of the changed page; no shas, counts or file names).
7. If `origin/main` moved before a push: rebase and rerun step 1. If the incoming commits touch this diff's files, exit 3 "trunk changed under this card — re-run from Verify UI", and the item fails with that message.

### Stage `prod` — the Deploy prod button

Lit only when the run passed (so Codex review, interrogate, thermo-nuclear and DoD are green) and `uat` passed with all five health checks green. If any health check reads "not checked", the button shows that, and the confirm dialog repeats it.

`prod-preflight.sh` writes the confirm dialog:
- the api sha this card shipped to UAT, `origin/main`, and the sha production runs now (`kamal app details -d production`);
- **also ships**: every commit between production and the card's sha that isn't this card's, by subject. Two cards on UAT means card A's button ships B too; the dialog says so by name;
- **blocked** (button disabled, with the reason) when production runs a sha that isn't an ancestor of the card's sha, i.e. ahead or diverged, so a deploy would roll something back;
- the tag that will be created, `prod-YYYYMMDD-HHMM`, with a bullet list of features shipping (one per card or commit subject), editable in the dialog;
- a `Safety:` line: `production | no payment step | yes — deploys api <sha> to production`.

`ship-prod.sh` after Confirm:
1. Rechecks the preflight facts. Anything changed → stops and the dialog comes back.
2. Creates and pushes the annotated tag on api at the card's sha, with the bullets.
3. `kamal deploy -d production` at that sha.
4. Production health: `/up` 200, version shows the sha, logs since boot clean.
5. Writes `prod.md`. No ClickUp post in v1.

The button is the production ask. Nothing reaches production any other way, and staging-only cards (never clicked) simply stay `on-uat`.

### Install

- Contributions refuse to overwrite an unmarked `skills/fixstack`, so the plugin's skills are named `fixstack-*`. The hand skill `~/.claude/skills/fixstack` stays for terminal use until the plugin has shipped three cards, then it's removed (a separate step, asked first).
- The plugin repo is **private** (`LynchzDEV/skd-plugin-fixstack`): its scripts name KlangTech hosts, repos and DoD ids.

## Build order

| Job | What | Depends on |
|---|---|---|
| 1 | Core A4: `source.post` kinds + mention + status, `source.page`; ClickUp plugin implements them (REST), with read-back | — |
| 2 | Core A1 + A2: `pick:` evidence, `waiting-pick`, Pick panel, mockup file route | — |
| 3 | Core A3 + A5: flow `land` schema and validation, stage runner as cockpit jobs, locks, Retry stage, report view | — |
| 4 | Plugin: flow, step and rubric skills, template; validated by Studio | 2 |
| 5 | Plugin: `ci.sh`, `ship-uat.sh`, `prod-preflight.sh`, `ship-prod.sh` with bats tests on fixture repos (fake `kamal`, fake `gh` on PATH) | 3 |
| 6 | End to end on a throwaway Shikidan (separate `SKD_CONFIG_DIR`, `SKD_PORT=7781`) on one real Army card, through `on-uat`. The prod button is clicked once, with you watching | 1–5 |

Jobs 1, 2 and 3 are independent and run in parallel. This repo is Shikidan itself, so they're built with native Claude agents (sonnet build, opus review), not cockpit GLM jobs.

## Testing

- Core: `pick:` evidence parks without posting (dummy source records no post); mixed `pick:` + question posts only the question; pick answer requeues to the front on the same workspace; mockup route refuses `..`, links and paths outside `visualizer/`; land stage pass/fail/timeout/retry; `button` stage never runs without a click; lock serialises two items on one repo; `post` from `<stage>.json` reaches the source once (not again on Retry); old `queue.json` loads.
- ClickUp plugin: mention comes out as a mention, literal-text fallback re-posts once; status set by exact name; `source.page` returns the page.
- Scripts: each step skips when already done; lockfile guard rejects a two-line diff; preflight blocks a diverged production sha and lists "also ships"; memory tiers.
- Flow: Studio validates it; Route takes the design branch without `DECISION.md` and the build branch with it.

## Risks to check before job 6

- **Server environment.** The stage jobs run as the Shikidan server. It needs `kamal`, `SSH_AUTH_SOCK` (if Shikidan runs as a service it may not see the agent), `gh` logged in (sign-off), and Docker access for kamal's build. The first stage checks all of them and fails naming the missing one.
- **Staging is shared.** Card B's UAT deploy replaces card A's build. That's fine because main is cumulative and B's build contains A, but A's tester sees B's changes too.
- **Long first run.** Compare + Mockups + 12 steps + `bin/ci` several times: budget about 1–2 hours of machine time per card, mostly CI.

## Out of scope

- Portal and backoffice cards (same as the skill).
- Starting runs by itself when a reviewer comments (input stays a pasted link).
- Waiting on the tester's reply before Deploy prod (decided: Shikidan's reviews unlock it).
- More than one card building at once.
- A ClickUp post after the production deploy (v1 posts only at UAT).
