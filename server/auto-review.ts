import { CODE_REVIEW_RUBRIC } from './reviewer-prompts'
import type { JobManager, JobRecord } from './jobs'
import type { EngineResolver } from './jobs-engine-iface'
import type { QuotaComposite } from './quota'
import { quotaCache } from './routes/quota'
import { readRoles } from './routes/roles'
import { readConfig, type EngineRoles } from './secrets'
import { BUILTIN_AGENTS, connectionEnvironment, createConnectionStore } from './agent-connections'
import { modelDiscovery } from './model-discovery'

export function buildReviewPrompt(source: JobRecord): string {
  return [
    `Cross-family review of a finished ${source.engine} implementation job (${source.label}). You are in the job's working tree.`,
    `Scope: ONLY the diff — \`git status --porcelain\`; dirty tree → \`git diff HEAD\` plus untracked files; clean tree → \`git diff HEAD~1\`.`,
    `Start from the files in that diff. You MAY read callers and dependents of the changed code to trace side effects, but do NOT scan unrelated parts of the repository, do NOT run the full test suite, do NOT edit anything.`,
    `Ignore worktree-local setup noise: database names, ports, .env values, generated files.`,
    `Output: first line exactly SHIP or NO-SHIP, then findings ranked most severe first as file:line — what is wrong — why it matters. Only report bugs, data loss, security, or broken behavior; style is not a finding. SHIP with no findings → one line.`,
    `Reported diff stat: ${source.diffStat ?? 'unknown'}.`,
    `Where the output contract above differs from the rubric below, the output contract wins.`,
    `Review rubric (from pstack thermo-nuclear-review):`,
    CODE_REVIEW_RUBRIC,
  ].join('\n')
}

export function shouldAutoReview(record: JobRecord, allJobs: readonly JobRecord[], roles: EngineRoles): boolean {
  if (record.workflowRunId || record.purpose === 'workflow-design') return false
  const { execute } = roles
  if (record.status !== 'done' || record.engine !== execute.engine || record.reviewOf !== null) return false
  if (record.diffStat === null || record.diffStat.trim() === '') return false
  return !allJobs.some((job) => job.reviewOf !== null && job.threadRoot === record.threadRoot)
}

export type ReviewerReadiness = { ok: true } | { ok: false; reason: string }

export function reviewerReadiness(engine: string, quota: QuotaComposite): ReviewerReadiness {
  if (engine === 'codex') {
    if (!quota.codex.available) return { ok: false, reason: 'codex unavailable' }
    return quota.codex.authed ? { ok: true } : { ok: false, reason: 'codex not authed' }
  }
  if (engine === 'glm') return quota.glm.available ? { ok: true } : { ok: false, reason: quota.glm.reason }
  if (engine === 'claude') return quota.claude.available ? { ok: true } : { ok: false, reason: quota.claude.reason }
  return { ok: false, reason: `unknown reviewer engine ${engine}` }
}

export type AutoReviewDeps = {
  resolver: EngineResolver
  roles?: () => Promise<EngineRoles>
  autoReview?: () => Promise<boolean>
  probeQuota?: () => Promise<QuotaComposite>
  log?: (line: string) => void
}

export async function maybeAutoReview(
  record: JobRecord,
  manager: JobManager,
  deps: AutoReviewDeps,
): Promise<void> {
  const log = deps.log ?? console.error
  const enabled = await (deps.autoReview ?? (async () => (await readConfig()).autoReview))()
  if (!enabled) return
  const roles = await (deps.roles ?? readRoles)()
  if (!shouldAutoReview(record, manager.listJobs(), roles)) return
  const { review } = roles

  let readiness: ReviewerReadiness
  if (BUILTIN_AGENTS.includes(review.engine as typeof BUILTIN_AGENTS[number])) readiness = reviewerReadiness(review.engine, await (deps.probeQuota ?? (() => quotaCache.get()))())
  else {
    try { connectionEnvironment(await modelDiscovery().effective(await createConnectionStore().get(review.engine))); readiness = { ok: true } }
    catch { readiness = { ok: false, reason: 'reviewer connection is not configured' } }
  }
  if (!readiness.ok) {
    log(`auto-review: skipped for ${record.label} — ${readiness.reason}`)
    return
  }

  const result = await manager.createJob(
    {
      engine: review.engine,
      cwd: record.cwd,
      label: record.label,
      prompt: buildReviewPrompt(record),
      parentJobId: record.id,
      threadRoot: record.threadRoot,
      reviewOf: record.id,
      ...(record.terminalId === null ? {} : { terminalId: record.terminalId }),
      ...(review.model === null ? {} : { model: review.model }),
    },
    deps.resolver,
  )
  if (!result.ok) log(`auto-review: dispatch failed for ${record.label} — ${result.error}`)
}
