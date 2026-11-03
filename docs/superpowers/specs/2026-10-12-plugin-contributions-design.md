# Plugin contributions — plugins that install agents and skills, and the card-pipeline plugin

Status: design, awaiting review. Builds on `2026-10-04-plugins-marketplace-design.md` and `2026-10-12-card-pipeline-design.md` (branch `card-pipeline-spec`).

## Goal

A teammate opens Marketplace, installs **card-pipeline**, fills a few settings, and gets the `biz-gate` agent and the `card-refine` skill on their own machine — for Claude and for every engine Mission Control runs. Today no plugin can do this: plugins ship only server and screen code, and nothing a plugin carries reaches `~/.claude`.

## Decisions (with the user)

| Topic | Decision |
|---|---|
| Home | A Mission Control marketplace plugin, not a Claude Code plugin |
| What a plugin can contribute (v1) | Agents (`.md`) and skills (folders with `SKILL.md`). Studio flow templates come later, with the card pipeline's later steps |
| Plugin repo | `LynchzDEV/mc-plugin-card-pipeline`, **public**. Nothing KlangTech-internal in it: business rules, key accounts, project map and ClickUp ids live in a private team-knowledge file each install points to |
| Old hosts | Plugins that contribute declare `pluginApi: 2`, so an older Mission Control refuses them ("This plugin needs a newer Mission Control") instead of installing them without their agents |

## Part 1 — contributions in the plugin system

### Manifest

```json
"pluginApi": 2,
"contributes": {
  "agents": ["agents/biz-gate.md"],
  "skills": ["skills/card-refine"]
}
```

- Paths are inside the repo (same rule as `server` / `screen`). An agent is a `.md` file with a `name:` in its frontmatter; a skill is a folder holding `SKILL.md` with a `name:`.
- `contributes` requires `pluginApi: 2`; `pluginApi: 2` is accepted with or without it.
- Changed in three places, kept identical: the SDK (`src/manifest.ts`, `src/types.ts`, `schema/mc-plugin.schema.json`, README author section), the host (`server/plugins/manifest.ts`), and the template README (one paragraph pointing to the SDK section).

### Templating

Contributed files may contain `{{setting:<key>}}` and `{{mc:mctl}}` (the absolute command that runs this Mission Control's `mctl`). The host fills them when it installs the files.
- Only `text` and `toggle` settings can be referenced. Referencing a `secret` setting, or a key the manifest does not declare, fails the install with the file and line.
- An empty setting stays as the literal `{{setting:<key>}}` text and the plugin shows "needs setup" until every referenced setting is filled.

### Install, update, disable, uninstall

| Event | What the host does |
|---|---|
| Install / enable | Copies each agent to `agents/<name>.md` and each skill to `skills/<name>/` in every profile: `~/.claude`, `<configDir>/worker-claude`, `<configDir>/chat-claude`; then runs `syncEngineAssets()` so Codex gets them too |
| Setting saved | Re-copies, so the filled values follow the setting |
| Update | Removes the old set, copies the new set, in the existing replace-with-rollback step |
| Disable / uninstall | Removes exactly the files it wrote, and the Codex copies made from them |

- **Ownership.** Each written file or folder carries a marker (`<!-- installed by mission-control plugin <id> -->` after the frontmatter; a `.mc-plugin` file inside a skill folder), and the install record lists every path written. Removal deletes only marked paths from that list.
- **Collisions.** If `agents/<name>.md` or `skills/<name>/` already exists and is not marked as this plugin's, the install stops and names the file. Nothing of the user's is moved or overwritten.
- **Consent.** Agents and skills run with full permissions, so a plugin with `contributes` needs the trust confirmation (`--trust`, or the trust checkbox in Marketplace) even when its runtime is `isolated`. The install prompt lists every agent and skill and where it is written; an update that adds one asks again.
- **Self-healing.** At startup the host re-copies the contributions of enabled plugins, next to `installSkills()`, so a crash mid-install repairs itself.

## Part 2 — the card-pipeline plugin (v1)

```
mc-plugin-card-pipeline/
  mc-plugin.json            pluginApi 2, runtime isolated, no server/screen, settings, contributes
  agents/biz-gate.md        the generic gate (no team data)
  skills/card-refine/SKILL.md
  examples/team-knowledge.example.md
  test/                     manifest + template checks
  README.md
```

### Settings

| Key | Example (KlangTech) |
|---|---|
| `teamKnowledgeFile` | `/home/<user>/klangtech/.claude/biz-gate-team.md` |
| `reposRoot` | `/home/<user>/klangtech` |
| `clickupWorkspaceId` | `3845974` |
| `clickupBoardId` | the clickup-board plugin's saved board id |
| `planningFieldId` | `1769d214-d88b-413e-b56c-45fb86f454cb` |
| `aiSprintPattern` | `^Sprint (\d+) ?AI\b` |
| `commentFooter` | `[🤖 Biz ยังไม่ต้อบตอบ อันนี้บอทจ้า]` |

### `biz-gate` (generic)

The current agent minus everything team-specific: sources and ignore rules, the confidence gate (A/B/C, HIGH/MEDIUM/LOW, proven by elimination), evidence from screenshots in a per-card folder, Fibonacci estimates, the comment layout (bold headings, `***` divider, bullets, footer from `{{setting:commentFooter}}`), card links, and the output format. It reads `{{setting:teamKnowledgeFile}}` first; that file holds:
- the business rules (R1–R9, the never-stop list),
- the project map and project knowledge,
- team words and language rules for the comment,
- the AI-comment formats to ignore.

### `card-refine` (the procedure run by hand on 2026-10-12)

1. Check prerequisites: the clickup-board plugin answers (`{{mc:mctl}} plugin call clickup-board …`), the team-knowledge file exists, the `inv-prod` skill is installed. Any missing → stop and name it.
2. Fetch the card, save it and its screenshots in its own folder.
3. Bug card → run the read-only production check and write the findings file.
4. Run `biz-gate` with the card folder.
5. Show the draft, checks and score in the session. Post nothing until the user says so (every score, in v1).
6. On OK: post or replace the comment, set Planning to the newest sprint matching `aiSprintPattern`, set the Time estimate (on subtasks when the card has them).
7. Read the card back and report what saved.

### The KlangTech team file

Generated from today's agent into `~/klangtech/.claude/biz-gate-team.md` (outside any public repo). After the plugin is installed and the file is in place, the hand-written `~/klangtech/.claude/agents/biz-gate.md` is removed so one `biz-gate` remains.

## Build order

Mission Control does not import the SDK (`server/plugins/manifest.ts` is its own copy of the rules), so the SDK and the host are independent and run in parallel. Both must hold the same rules; each has its own tests for them.

| Job | Depends on |
|---|---|
| A. SDK: schema, types, check, README — published as a new version | nothing |
| B. Host: manifest, templating, copy / remove / collision / consent, startup self-heal — TDD, with the existing installer tests as the pattern | nothing |
| C. Template README paragraph | nothing |
| D. Plugin repo + KlangTech team file; install from a `file:///` link, then from the marketplace | A (its manifest test uses the SDK) and B (installing needs the new host) |

A, B and C start together as separate cockpit jobs (mc-dispatch); D starts when A and B have landed. The 7 acceptance concerns apply.

## Testing

- Host: install writes the files into all three profiles with settings filled; secret reference fails; collision stops without touching the user's file; disable and uninstall remove exactly what was written; update swaps sets; setting change re-copies; startup re-copies; `pluginApi: 1` with `contributes` is refused.
- SDK: schema and `parseManifest` accept the new shape and reject the bad ones listed above.
- Plugin: the manifest parses with the SDK; every `{{setting:…}}` in the files is a declared text setting.
- End to end: on a throwaway Mission Control (separate `MISSION_CONTROL_CONFIG_DIR`, and restore the `mc-dispatch` link after), install from `file:///`, fill settings, run `card-refine` on one card in draft mode.

## Out of scope

- Studio flow templates in `contributes` (with the pipeline's later steps).
- Automatic posting by score (v1 always shows the draft first).
- Plugin-to-plugin dependency declarations (card-refine checks for clickup-board at run time instead).
