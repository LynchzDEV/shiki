# Card doctor: research notes

Research date: 2026-11-10. Sources are primary (papers, specs, vendor docs). Where a page came back only as a summary, the text below paraphrases it; direct quotes are used only where the source text was read verbatim. Anything not confirmed from a primary source is marked **UNVERIFIED**.

## TL;DR

1. Build it, but be clear what it is. A doctor that reads the ClickUp thread and then picks actions is **not** the paper's "action-selector" pattern. That pattern requires that untrusted input can never trigger a consequential action ([Beurer-Kellner et al. 2025](https://arxiv.org/abs/2506.08837)).
2. A closed, validated action set limits the blast radius, which answers OWASP's Excessive Agency risk ([OWASP LLM06](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)). It does not make the doctor injection-proof.
3. The safety comes from suggest-mode by default. Auto-apply only action types whose worst allowed outcome, with the worst allowed arguments, is tolerable.
4. Best-fitting sourced pattern is dual LLM plus map-reduce. A quarantined call classifies the thread into a fixed enum. Deterministic playbook code maps (enum, card state) to toolbox actions ([Willison 2023](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/), [paper §3](https://arxiv.org/html/2506.08837v3)).
5. The biggest residual risk is free text: `post reply`, `add note` and `restart with note`. Replies are an exfiltration and phishing channel, which CaMeL itself says it cannot stop ([CaMeL](https://arxiv.org/html/2503.18813v2)). Notes carry injected text into downstream agents that *do* have shell and file tools.
6. Make the free text templated or playbook-sourced. Treat any LLM-written text as untrusted all the way downstream.
7. Use Anthropic structured outputs (`output_config.format`) or `strict: true` tools for the plan's shape. The docs list no length constraints, and refusals or `max_tokens` can break the schema ([Claude docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)), so a hand-written semantic validator is still required.
8. Don't adopt an agent framework. The doctor is one Messages API call with no tools. LangGraph.js and OpenAI Agents JS are MIT and have useful HITL ideas. The Claude Agent SDK is proprietary (Anthropic Commercial Terms) and built for agents that hold tools, which this one must not.
9. Copy proven mechanics. Use a per-card lease with expiry ([Kubernetes Lease](https://kubernetes.io/docs/concepts/architecture/leases/)), idempotency keys that compare parameters ([Stripe](https://docs.stripe.com/api/idempotent_requests)), and validate-before-append ([Temporal Update validators](https://docs.temporal.io/develop/typescript/message-passing)).
10. Keep an append-only audit trail with who, what, when, why, result and before/after ([OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)), plus per-card fix limits ([Anthropic, stopping conditions](https://www.anthropic.com/engineering/building-effective-agents)).

---

## 1. Prompt-injection design patterns

**Core rule.** The paper's guiding principle is that once an agent has ingested untrusted input, "it must be constrained so that it is impossible for that input to trigger any consequential actions" ([paper](https://arxiv.org/html/2506.08837v3), [Willison summary](https://simonwillison.net/2025/Jun/13/prompt-injection-design-patterns/)). The authors also say no single pattern is likely to suffice across all threat models ([paper](https://arxiv.org/html/2506.08837v3)).

| Pattern | What it does | Stated limits |
|---|---|---|
| Action-selector | The LLM maps a request to a predefined action and never sees the action's results ([paper](https://arxiv.org/html/2506.08837v3)) | No feedback loop, so it is very restrictive. An embedding-based allowlist match can still be manipulated (§4.4) |
| Plan-then-execute | The plan is fixed before untrusted data is read. Tool output can't change *which* actions run | Acts only as "control flow integrity". Injected data can still change action **arguments**, e.g. an email body. Doesn't cover injection in the user prompt ([paper](https://arxiv.org/html/2506.08837v3)) |
| LLM map-reduce | Each untrusted item is processed by an isolated LLM that returns a constrained result. A reduce step aggregates (non-LLM or constrained) | Each map step can be injected, so it must be unable to do harm. A malicious item can still force its own classification, e.g. "fits all categories" ([paper](https://arxiv.org/html/2506.08837v3)) |
| Dual LLM | A privileged LLM plans and never sees untrusted text. A quarantined LLM reads it, has no tools, and returns symbolic variables | The quarantined output can still be tampered with to serve the attacker. It still sees any sensitive data it is given ([paper](https://arxiv.org/html/2506.08837v3)). Willison lists social engineering of the user, exfiltration via links and images, chaining risk across model boundaries, and complexity ([Willison 2023](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/)) |
| Code-then-execute (CaMeL) | The privileged LLM writes a program in a sandboxed DSL. An interpreter tracks data flow and capabilities and checks a policy before every tool call ([CaMeL](https://arxiv.org/abs/2503.18813)) | Authors: users must write and maintain policies, approval prompts cause fatigue, it is vulnerable to side channels, and it "cannot defend against text-to-text attacks" or injection-induced phishing. Changing tool-call arguments via the quarantined LLM "can be a security issue". ROP-style attacks may work. "prompt injection attacks are not fully solved" ([CaMeL v2](https://arxiv.org/html/2503.18813v2)). AgentDojo: 77% of tasks solved with provable security vs 84% undefended ([abstract](https://arxiv.org/abs/2503.18813)) |
| Context-minimization | Drop the user prompt from context after it has been turned into a constrained action | Covers only some user-prompt injections. Retrieval can still be manipulated ([paper](https://arxiv.org/html/2506.08837v3)) |

**Which fits the card doctor.** The doctor's job is to *interpret* human replies, so it must read untrusted text before choosing actions. That breaks the core rule, so a single doctor LLM call that both reads and chooses is not covered by any of these patterns' guarantees. The closest structure that is covered:

- **Map step (quarantined).** An LLM reads the thread plus card state and outputs only `{intent: enum, option_id?: enum-of-known-ids, confidence}`. That is map-reduce with constrained output.
- **Reduce step (deterministic).** Playbook code maps `(intent, card state)` to a toolbox plan. That is the dual-LLM idea with a plain-code controller instead of a privileged LLM.
- **Residual risk.** An attacker or a confused owner can still force a *wrong-but-allowed* intent, as the paper says for map-reduce. That only gets you one action from the allowlist, and suggest-mode or approval catches it.

**Is "LLM outputs a validated plan from a closed action set" safe?** It is a blast-radius control, not an injection defence. What remains:

- **Wrong-but-allowed action.** For example, an injected "pick option B" or "requeue". The plan validator can't tell a manipulated plan from a correct one.
- **Argument manipulation.** Plan-then-execute and CaMeL both say arguments stay attacker-influenceable. Here that means the free-text fields: reply body, note text, restart note.
- **Exfiltration and phishing through `post reply`.** A reply could carry card or repo data, or links, to the ClickUp audience. This is the text-to-text class CaMeL excludes from its threat model, and the link-exfiltration channel Willison warns about.
- **Chaining.** "Restart at node with note" feeds LLM-written text into a coding agent that has shell and file tools. Willison's chaining risk says every boundary needs protecting, so the note is untrusted input to that agent.
- **Approval fatigue.** Both the paper and CaMeL say tired users approve unsafe actions.
- **Loops.** Repeated re-ask or requeue cycles. This is mitigated by fix limits (§2) rather than by the patterns.

## 2. Industry guidance

**OWASP Top 10 for LLM Apps (2025).**
- [LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) recommends constraining model behaviour, defining output formats and validating them with deterministic code, filtering inputs and outputs, least privilege with functions handled in code, human approval for high-risk actions, segregating and labelling external content, and adversarial testing. It says foolproof prevention may not exist.
- [LLM06 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) names three root causes: excessive functionality, excessive permissions and excessive autonomy. Its fixes are to minimise extensions and their functions, avoid open-ended tools such as shell, use least privilege, require user approval for high-impact actions, and enforce **complete mediation** downstream (authorization checked on every request, not left to the LLM). It also lists logging, monitoring and **rate limiting** as damage limiters.
- The proposed toolbox matches LLM06 almost line for line. Shikidan's executor is the "complete mediation" point.

**Anthropic.** *Building effective agents* advises sandboxed testing with guardrails, human checkpoints, stopping conditions "such as a maximum number of iterations", and "poka-yoke" tools that make mistakes hard ([source](https://www.anthropic.com/engineering/building-effective-agents)). The trustworthy-agents framework (Aug 2025) keeps humans in control before high-stakes decisions, read-only by default, plans visible ([source](https://www.anthropic.com/news/our-framework-for-developing-safe-and-trustworthy-agents)). The browser prompt-injection post (Nov 2025) reports ~1–2% adaptive attack success even with improved safeguards and calls 1% "meaningful risk" ([source](https://www.anthropic.com/research/prompt-injection-defenses)): model robustness helps but cannot be the control.

**OpenAI Agents SDK.** Input guardrails run only on the first agent, output guardrails only on the final one, tool guardrails only on function tools. Parallel guardrails can let tools run before the tripwire fires; blocking mode avoids it ([Python docs](https://openai.github.io/openai-agents-python/guardrails/); the JS page was unreadable). Lesson: validate **before** execution, never alongside it.

**Microsoft.** The AI Red Team failure-mode taxonomy (Apr 2025) highlights memory poisoning; mitigations include external validation for memory updates and controlled memory structure ([blog](https://www.microsoft.com/en-us/security/blog/2025/04/24/new-whitepaper-outlines-the-taxonomy-of-failure-modes-in-ai-agents/)). Playbook files and card notes are memory, so the doctor must not write the playbook. Whitepaper body: **UNVERIFIED**.

**NIST.** CAISI treats agent hijacking as indirect prompt injection, extended AgentDojo to evaluate it, and a large red-team competition broke every target model at least once ([CAISI blog](https://www.nist.gov/blogs/caisi-research-blog/insights-ai-agent-security-large-scale-red-teaming-competition)); read from search snippets only, **UNVERIFIED** in detail. No NIST or Microsoft "autonomy levels" scale was located (**UNVERIFIED**).

## 3. Prior art for remediating stuck items

| System | Mechanism | Pattern to copy |
|---|---|---|
| [PagerDuty Automation Actions](https://docs.pagerduty.com/ai-automation/automation/automation-actions) | Push-button library of predefined actions typed *Diagnostic* or *Remediation*; run rights by role/team; auto-invocation from Event Orchestration is a per-action opt-in; every run logged to the incident timeline | Closed library, per-action auto flag, audit on the item |
| [AWS SSM `aws:approve`](https://docs.aws.amazon.com/systems-manager/latest/userguide/automation-action-approve.html) (stand-in: no first-party Rundeck/Shoreline approval docs found, **UNVERIFIED**) | Pauses until named `Approvers` reach `MinRequiredApprovals`; default timeout 7 days, max 30; `onFailure: Abort`; decisions in `ApproverDecisions` | Named approvers, fail-closed timeout, recorded decisions |
| [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/) | Non-terminating loops that move current state toward desired state, then report status | Re-read card state before each action; never replay a stale plan |
| [Temporal](https://docs.temporal.io/develop/typescript/message-passing) | Signals are fire-and-forget; Updates are synchronous, return result/error, and validators "reject an Update before it is written to History"; approval example is a Signal setting a flag the workflow waits on | Manual intervention as a validated synchronous update |
| [Copilot Autofix](https://docs.github.com/en/code-security/code-scanning/managing-code-scanning-alerts/responsible-use-autofix-code-scanning) | Suggest-only; explicit developer review and acceptance; suggestions failing internal tests are hidden; may not fix or may add vulnerabilities | Suggest-only for code/flow changes, pre-filtered by checks |

**Rollback.** None of these sources describes automatic rollback; they rely on audit plus forward-fix. Record a `before` snapshot per action so a human can revert (generic rollback engine: **UNVERIFIED**).

## 4. HITL libraries and frameworks

| Option | What's reusable | License | Fit |
|---|---|---|---|
| LangGraph.js `interrupt()` / `Command({resume})` | Pause and resume with a durable checkpointer keyed by `thread_id`. On resume the node re-runs from its start, so side effects before the interrupt must be idempotent ([docs](https://docs.langchain.com/oss/javascript/langgraph/interrupts)) | MIT (`gh api`) | Ideas only. Shikidan already has its own flow graph and JSON state |
| OpenAI Agents JS `needsApproval` | Per-tool approval, `result.interruptions`, `state.approve/reject`, `RunState.toString()/fromString()` ([docs](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)) | MIT (`gh api`) | Ideas only. Its security notes are directly applicable (below) |
| Claude Agent SDK | Permission flow: hooks → deny rules → ask rules → mode → allow rules → `canUseTool`. `dontAsk` mode turns every prompt into a denial ([docs](https://code.claude.com/docs/en/agent-sdk/permissions)) | Proprietary: "Use is subject to Anthropic's Commercial Terms of Service" (repo LICENSE.md) | Wrong tool: it governs an agent that *has* tools. The doctor should have none |
| MCP tool annotations | `readOnlyHint` (default false), `destructiveHint` (default true), `idempotentHint` (default false), `openWorldHint`. Clients "MUST consider tool annotations to be untrusted unless they come from trusted servers" ([spec 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools), [schema](https://modelcontextprotocol.io/specification/2025-06-18/schema)) | Spec / SDK Apache-2.0 + MIT (transitioning) | Reuse the **vocabulary** as fields on each toolbox action definition |

Security guidance worth copying, whatever Shikidan builds on:
- **OpenAI.** `fromString()` doesn't authenticate the snapshot. Keep state on the server, send reviewers only opaque decision IDs, authorize the reviewer against stored pending requests, and atomically consume each request. Consuming a request does not guarantee exactly-once side effects, so reconcile uncertain ones ([JS HITL](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)).
- **OpenAI Python.** Store a version marker with long-pending state, and use idempotency keys on consequential tools ([Python HITL](https://openai.github.io/openai-agents-python/human_in_the_loop/)).
- **MCP spec.** Clients SHOULD "Show tool inputs to the user before calling the server, to avoid malicious or accidental data exfiltration" and "Log tool usage for audit purposes". Servers MUST validate inputs and rate limit ([spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)).
- **MCP best practices.** Scope minimization and "MUST NOT treat possession of a state handle as authentication" ([MCP security](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)).

**Verdict: hand-roll.** The validator is a small, testable function over a closed union type: action-type allowlist, per-card state preconditions, argument enums or templates, limits and lease. That beats pulling in a framework whose main value is running a tool-using agent loop.

## 5. Locking, idempotency, audit

- **Single owner (lease).** A Kubernetes Lease has `holderIdentity`, `leaseDurationSeconds` and `renewTime`. Holders renew periodically, and leader election ensures only one instance is active ([docs](https://kubernetes.io/docs/concepts/architecture/leases/)).
  - Shikidan equivalent: `card.lease = {holder: "doctor"|"operator:<id>"|"human:<id>", acquiredAt, renewAt, ttl}`.
  - Acquire with compare-and-set on the JSON state file. An expired lease is claimable.
  - The executor rejects any action from a non-holder.
  - Exact CAS semantics on Shikidan's file store are a design detail, not sourced.
- **Idempotency.** In Stripe's v1 API the server saves the status and body of the first request for a key and returns it on retries, including 500s. Keys may be pruned after 24h. The layer "compares incoming parameters to those of the original request and errors if they're not the same". Use V4 UUIDs and no sensitive data in keys ([Stripe](https://docs.stripe.com/api/idempotent_requests)).
  - For the doctor, key = `hash(cardId, planId, actionIndex)`. Store the result. A retry returns the stored result, and a parameter mismatch is an error.
  - This matters most for `post reply`, where a duplicate ClickUp comment is visible to the customer.
- **Validate before append.** Temporal rejects invalid Updates before they reach history ([docs](https://docs.temporal.io/develop/typescript/message-passing)). Likewise, only validated plans enter the audit log as `proposed`. Rejected plans get logged as `rejected` with the reason.
- **Audit record.** OWASP says to record when, where, who and what, plus action, object, result status and reason. It recommends tamper detection, copying to read-only storage, monitoring access, and keeping tokens and secrets out of logs ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)). OWASP doesn't explicitly say "append-only", but append-only JSONL with a hash chain meets its tamper-detection goal. That design choice is ours, not sourced.
  - Proposed record: `{ts, cardId, actor, leaseId, planId, idempotencyKey, action, args, why (doctor rationale + intent enum), before, after, result, approvedBy?}`.
- **Fix limits.** The basis is Anthropic's "stopping conditions (such as a maximum number of iterations)" ([source](https://www.anthropic.com/engineering/building-effective-agents)) and OWASP LLM06 rate limiting ([source](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)).

## 6. Structured output with Anthropic models

Source: the [Claude structured outputs docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

- **Mechanisms.** `output_config.format` (`type: "json_schema"`) constrains the response text; `strict: true` on a tool constrains its name and inputs; they combine. No beta header (the old `output_format` is deprecated and needs `structured-outputs-2025-11-13`). Supported models include `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and the 4.5–4.8 line.
- **Guarantee.** Constrained decoding: valid JSON, types and required fields enforced.
- **Caveats.** `stop_reason: "refusal"` or `"max_tokens"` may not match the schema; `enum` casing isn't guaranteed; grammar compiled on first use, cached 24h.
- **Unsupported:** recursive schemas, `minimum`/`maximum`, `minLength`/`maxLength`, array constraints beyond `minItems` 0/1, `additionalProperties` other than `false`. Limits: 20 strict tools, 24 optional params, 16 `anyOf` params per request.
- **Implications.** Model the plan as `{steps: [anyOf(action variants)]}` with `type` as `const` and `additionalProperties: false`. Text-length and step-count caps must live in Shikidan's validator. Treat refusal or `max_tokens` as "no plan + alert". The TS SDK's `zodOutputFormat()` helper builds the schema.

---

## Recommended design adjustments

1. **Split classification from planning.** The LLM returns only an intent enum, known option IDs and a confidence score. Deterministic playbook code builds the toolbox plan (dual LLM / map-reduce, §1). The LLM-authored plan stays an optional suggest-only mode.
2. **No LLM-authored free text on auto-apply.** Replies and re-asks use playbook templates with slot values drawn from card state, never from the thread. Free-text replies are always suggest-mode with a human-visible diff (CaMeL text-to-text limit; MCP "show tool inputs").
3. **Mark notes passed to downstream agents as untrusted.** "Restart at node with note" wraps the note in an explicit untrusted-data block for the coding agent, or uses a template (Willison chaining risk; OWASP LLM01 "segregate and identify external content").
4. **Give every toolbox action annotations:** `readOnly`, `destructive`, `idempotent`, `openWorld` (posts to ClickUp = open world), plus `autoApplyAllowed` and `requiresApproval` (MCP annotations; PagerDuty diagnostic/remediation typing). Only Shikidan-authored definitions are trusted.
5. **Make deploy and flow edits unreachable from the doctor**, not merely "approval required". They are absent from its action union and only reachable through the human UI or CLI (OWASP LLM06 "minimize extensions").
6. **Put a card lease with TTL on every action.** The executor rejects non-holders, and an expired lease is reclaimable (Kubernetes Lease).
7. **Give every action an idempotency key that compares parameters,** with stored results (Stripe). Check ClickUp for an existing comment before re-posting after a crash (OpenAI HITL: consuming a decision doesn't guarantee exactly-once).
8. **Re-validate preconditions against fresh card state at execute time,** not only at plan time (Kubernetes reconcile; Temporal validators).
9. **Approvals fail closed on timeout,** with a named approver and a recorded decision (`aws:approve`). Approval IDs are opaque, server-side and single-use (OpenAI HITL security notes).
10. **Use append-only JSONL audit with a hash chain,** using the OWASP who/what/when/why/result fields plus before/after. Redact secrets, and never log tokens.
11. **Set fix limits per card and per action type.** Examples: max 2 re-asks per 24h, max 1 restart per node, escalate to a human after N. Add a global rate limit across cards (Anthropic stopping conditions; OWASP rate limiting).
12. **Make the playbook and message files human-edited only.** The doctor can never write them (Microsoft memory-poisoning mitigation).
13. **Treat a refusal, `max_tokens`, schema-valid-but-semantically-invalid output or low confidence as "no plan, alert a human"** (structured outputs caveats).
14. **Build a red-team fixture set** of ClickUp replies containing injections and run it in `bun test` against the validator and classifier (OWASP LLM01 adversarial testing; CAISI/AgentDojo approach).

## Open risks

- **Wrong-but-allowed actions** can't be detected by validation. Suggest-mode, confidence thresholds and fix limits only reduce how often they happen.
- **Approval fatigue.** If most suggestions are correct, humans will rubber-stamp them (paper; CaMeL).
- **The classifier can be forced.** A crafted reply can still force the intent enum (map-reduce limit), e.g. a fake "approve option B". Mitigation: only accept picks from the card's known owner, which needs ClickUp author identity. Whether ClickUp author metadata is reliable enough was not checked: **UNVERIFIED**.
- **The external operator bot** is a second fixer with its own injection surface. The lease stops conflicts, not a compromised operator.
- **Model-level injection robustness** is improving (around 1–2% attack success in Anthropic's browser tests) but is not zero, and those figures don't transfer directly to this task.
- **Rollback is manual.** No source offers a general undo for posted ClickUp comments or restarted agent runs.
- **Coverage gaps.** NIST guidance, Microsoft whitepaper details, Rundeck and Shoreline approval features, and any formal "autonomy levels" scale were not verified from primary text.
