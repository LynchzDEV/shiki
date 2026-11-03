# Workflow Studio

Open **Studio** from the workspace toolbar. Describe the workflow you want, use your default, browse templates, or start blank. All paths lead to the same editable canvas. The built-in default is **pstack Feature**, based on the pstack plugin's Feature playbook (see `NOTICE.md`). Editing it creates your own copy automatically.

## The default flow: pstack Feature

1. **Explore** maps the part of the project the request touches: the files involved, how data moves through them, and existing code worth reusing. It changes nothing.
2. **Architect** designs the change with you, In Session, and writes the plan. It also says how sure it is.
3. If the design is clear, the plan goes straight to **Verify plan**.
4. If the architect is torn between different designs, or not confident, it reports a failure on purpose and the flow runs a **design arena** instead:
   - **Arena brief** writes one shared brief for the designers and a short scoring list (3 to 6 points) that the designers never see.
   - Three **design runners** sketch a design at the same time, each on a different AI: Claude, GLM and Codex. These steps name their AI, so a flow started from a chat still uses three different AIs.
   - A **Judge** (Codex) scores the three sketches against the list and recommends one, plus the best parts of the others.
   - **Pick & graft**, In Session, is where you and your AI choose the base design, borrow one or two parts from the others, and write the final plan.
5. **Verify plan** checks the plan against the code and the design red flags. A failed check goes back to the architect.
6. **Execute** builds it, then **pstack review** reviews it on a different model family. A failed review goes back to Execute.

A step that crashes or ends without a result stops the run as blocked. Only the architect's deliberate failure opens the arena. **Save** creates a version; **History → Use as default workflow** selects a saved version for future runs.

## Build with AI

Enter your description and choose **Build workflow**. The configured planning AI is selected by default; you can choose another native or ACP connection. The AI works in a temporary designer folder and returns a workflow draft. It does not execute that workflow or change your project. **Ask AI** beside the canvas lets you describe edits to the current draft.

Drafts are validated against the workflow schema and required implementation/review rules before appearing on the canvas. Unconnected agents and invented executable checks or tool configurations are rejected. Missing setup is shown separately. Add new tools, skills, and executable checks yourself, save the workflow, then ask AI to use them. Generated drafts remain unsaved until **Save**, or until **Run workflow** saves the draft before opening the run form.

The designer uses existing job logs and cancellation. A generation can be stopped, has a three-minute limit, and can reconnect after a page reload while still running. Claude/GLM drafting disables tools and inherited MCP configuration; Codex drafting uses a read-only sandbox without user configuration; ACP drafting denies tool requests and advertises no filesystem/terminal callbacks. Native or ACP sign-in is still required. Custom headless CLI connections remain usable for workflow tasks but are not used as workflow designers.

## Tasks and routing

Use **Add step** to search editable presets or select **Custom task**. Every step has free-form instructions and an AI assignment. Select a step and choose **Add next step** to insert a task while preserving the following step. Drag to arrange the canvas or connect the handles. **Connections & more options** provides labeled outcome routes, model selection, attempt limits, and task purpose. One outcome follows one path. Loops stop at the node's maximum visit count, with an overall limit of 256 node executions.

**Who should do it?** lists the roles first, each as `<Role> · <its AI>` from **Manage AIs → Roles**, then **In Session**, then **A specific AI** with one entry per connected AI. A step on a role uses whatever AI that role has in Settings, and the fallback AI when that AI cannot run. Picking a specific AI pins the step to it and keeps the step's role. A step whose role no longer exists shows **Missing role · `<name>`** until you pick another, so nothing changes silently.

The **New terminal** form has a **Workflow** selector, shared with **Resume**. **Default workflow** selects your saved default; choose another saved workflow for that terminal alone. If your saved default is custom, **pstack Feature** still offers the built-in default. Each terminal shows its workflow name and version below its header, including in split views and after refreshing the page.

Opening a terminal pins that workflow version; later blueprint edits or changes to the workspace default do not change existing terminals. Opening a terminal does not start a workflow run. Native agents receive the selection in their instructions. Terminal-originated workflow runs pass `terminalId`; the server enforces that terminal's workflow version and directory, and links every node job back to its terminal. The session's `SKD_URL` and configuration directory keep dispatches on its own Shikidan instance, including port 7778.

Mark code-writing steps as **Implement changes** under **Task purpose**. They require a successful plan and plan verification before execution and a later successful review before the workflow can finish. Review uses a different declared model family, even when two differently named connections expose the same model. For unknown model IDs, set the family on the connection or node. Research and test tasks do not require a commit. The **Review work** and **Check a plan** steps, the built-in pstack Feature flow, and the automatic cross-family review all use pstack's code-review rubric and design red-flags list (see `NOTICE.md`).

Add Markdown skill files by path under **Tools, skills & checks**. Their contents are snapshotted at run start. Attached stdio MCP servers use the ACP adapter. Their environment settings map target variable names to existing Shikidan server environment variable names; they are not credential values.

Acceptance checks have separate command, argument, and time-limit fields. Enter arguments one per line; they run directly in the selected project directory. Each must exit zero before an AI pass is accepted. Their output and exit status appear in run evidence. Treat these commands as code you have chosen to execute, including on retry.

A custom task can use a tool such as Jev when you choose and configure it. There is no special Jev preset. Attach the required instructions/tools and describe what must be checked. A browser agent's DONE signal alone is insufficient evidence; use independent assertions and artifacts. See [Jev's official example](https://github.com/browser-use/jev-ultrafast).

## Agent connections

Open **Manage AIs** to select a preset or custom connection. Technical fields live under **Advanced connection settings**. Existing Claude, GLM, and Codex settings continue to work. Studio connections also appear in job/model selectors and role settings.

The **Roles** section at the top of **Manage AIs** assigns an AI and an optional model to each role. **Plan**, **Execute** and **Review** always exist. **Add role** creates another one, such as `builder`: names use up to 64 letters, numbers, `-` or `_`, start with a letter or number, and cannot be `autoReview` or `fallback`. Leave the model empty to use that AI's default. **Fallback AI** (off by default) takes over when a step's AI cannot start or keeps crashing. **Save roles** saves every role at once. Each AI's **Used for** badges list the roles it plays. After adding a connection, reload previously opened settings/terminal forms to refresh their available agents.

| Connection | Configuration |
| --- | --- |
| Grok Build | Install/sign in to `grok`; preset runs `grok agent stdio`. This is Grok Build, not the separate Grok Bot cloud product. |
| Qwen Code | Install/configure `qwen`; preset runs `qwen --acp`. Use the authentication and endpoint required by your plan. |
| Other ACP agents | Enter the installed executable and its ACP argument array; probe advertised capabilities. |
| OpenCode providers | Install/configure OpenCode, choose its preset, and enter provider/model IDs. Existing OpenCode provider sign-ins remain with OpenCode. |
| Custom API or local endpoint | Use OpenCode with an OpenAI-compatible base URL, a provider ID, available model IDs, and an optional API-key environment variable name. Example endpoints include `http://localhost:11434/v1` and `https://openrouter.ai/api/v1`. The chosen model must support the tools the task needs. |
| Other headless coding CLIs | Enter an executable and arguments (one per line) with `{{prompt}}`; optionally `{{model}}` and `{{session}}`. Choose plain text, Claude stream JSON, or Codex JSON output. |

ACP provides native agent integration; it does not grant subscriptions or bypass provider restrictions. A capability probe starts the local agent and performs initialization/authentication if configured, but sends no task. Some subscriptions restrict unattended automation; check the provider's current terms. In particular, [Alibaba Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan) documents usage restrictions that need resolving before unattended Qwen workflows. Closed cloud products without public control interfaces still need a suitable adapter/API.

Credentials are native CLI sign-ins or references to variables in the Shikidan server's environment. Studio does not return those values. Enable unattended tool permissions only for connections you trust. ACP filesystem callbacks are restricted to the assigned workspace; native agent processes and shell tools run with your account's authority and are not an OS sandbox.

To use a custom connection interactively, configure **Interactive terminal arguments**. An empty array launches its normal interface. Include a `{{model}}` slot if that CLI supports model selection there. Use `{{instructions}}` with its supported instruction flag to pass terminal workflow context; otherwise the agent must consume the supplied `SKD_TERMINAL_ID`, `SKD_URL`, and `SKD_WORKFLOW_*` environment variables through its own integration. Selecting a workflow does not intercept arbitrary terminal commands. Native session history remains available for Claude/GLM/Codex; custom interactive history is not imported. Standalone ACP jobs can be replied to when the agent advertises session loading. The existing quota bar still covers its built-in providers; custom subscription quotas are not inferred. Workflow retry starts a new node attempt, preserving the run's settings and evidence.

## Prompts and revisions

The linked `skills/skd-dispatch` directory remains the shared entry point. It reads the selected workflow and starts a run; no run rewrites that shared skill. `prompts/skd-dispatch.md` seeds the core prompt template. Edit it through **Rules → Edit the core prompt**. Prompt revisions and blueprint revisions are independent.

Keep exactly one `{{core_rules}}`, `{{workflow}}`, and `{{assignment}}` slot in the prompt template. The mandatory core rules are supplied by Shikidan. Implementation nodes additionally receive the existing implementation rules, including migration and testing conventions. These rules are outside blueprint editing.

Every run stores its workflow, policy, connection settings, skill contents, and rendered node instructions. Credential references are stored; credential values are resolved when used. Model aliases and a native agent's unspecified default model remain provider/CLI-controlled; pin an explicit model ID when that distinction matters. Claude receives core rules through its append-system-prompt option, Codex through developer instructions, and generic ACP agents receive the composed assignment through ACP's prompt message. ACP has no universal system-prompt override.

In **Runs**, each step names the AI and model that did it. A step the fallback AI took over adds `· instead of <AI> (<reason>)`, and a review that had to run on the same model family as the work adds `· same-family review`.

Runs store workspace HEAD and a diff fingerprint with each settled node. Prior node output, acceptance results, and evidence pass to subsequent nodes. A workflow reserves its directory against other Shikidan jobs while running. Unrelated terminals or external programs can still edit that directory.

Stop terminates the active job/check. Retry repeats the current step with the same revisions and may repeat side effects. After a restart, Shikidan reconnects the workflow to its existing job. An interrupted check or uncertain dispatch is blocked for inspection rather than silently repeated. Studio jobs cannot be continued through the legacy job reply endpoint, which would discard their pinned instructions.

## Storage and verification

Private files live under the existing Shikidan config directory: `connections/`, `workflows/`, `policies/`, and `workflow-runs/`. Revisions are immutable, content-addressed JSON records. Existing jobs and sequential plans use their original formats.

Run `bun test` for the test suite and `bun run typecheck:studio` for the Studio modules. Studio is verified in a browser against a throwaway instance (`SKD_PORT=7781 SKD_CONFIG_DIR=<scratch> bun server/index.ts`) with Playwright; the old `check:studio` script targeted the pre-2.0 page and was removed.

Studio reuses [React Flow](https://reactflow.dev/learn) (MIT), the [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) (Apache-2.0), and an externally installed [OpenCode](https://opencode.ai/docs/acp/) runtime (MIT). React is isolated to Studio; existing pages keep their original rendering path.

## Built-in pstack flows

Next to **pstack Feature**, Studio lists seven read-only flows adapted from pstack. Each fans out to a panel on different AI families (Claude, GLM, Codex), joins, then finishes. None of them edits your workspace. To change one, duplicate it under a new id.

- **pstack Arena**: you and the AI frame a brief and a hidden rubric, three AIs each solve it, Codex judges, then you pick a base and graft parts.
- **pstack Interrogate**: three adversaries try to break the change and prove every finding by running it, then Codex reruns each finding and keeps only the reproduced ones.
- **pstack Swarm (race)**: you set the done test and the race rule, three AIs work the same brief, then you apply the rule to one report.
- **pstack How**: three explorers trace the flow, the data and the boundaries of a subsystem, then Codex writes one explanation.
- **pstack Why**: three investigators search source history, issue and PR discussion, and docs, then Codex writes a confidence-graded answer.
- **pstack Reflect**: three reviewers (judgment, tooling, divergent) read a session, Codex sorts findings into Accepted, Rejected and Backlog, and you approve.
- **pstack Thermos**: Codex reviews bugs and security, Claude reviews code quality, then you merge and dedupe the two reviews.

Shikidan turns the pstack plugin off inside Claude and GLM worker and step jobs, so its routing mandate does not make workers dispatch further agents. Chats and terminals keep it.
