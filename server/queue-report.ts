import { join } from 'node:path'

import { landDirOf, readRegularFile } from './queue-land'
import type { RunView } from './queue-prompts'
import type { QueueItem } from './queue-store'

const MAX_STAGE_REPORT = 256 * 1024

async function stageReport(item: QueueItem, stage: string): Promise<string> {
  if (item.worktree === null) return ''
  return ((await readRegularFile(join(landDirOf(item.worktree), `${stage}.md`))) ?? '').slice(0, MAX_STAGE_REPORT)
}

function runSection(runId: string, run: RunView | undefined): string[] {
  if (run === undefined) return [`## Run ${runId}`, '', 'This run is no longer available.', '']
  const title = (nodeId: string): string => run.workflow?.nodes?.find(node => node.id === nodeId)?.title ?? nodeId
  const lines = [`## Run ${runId} (${run.status})`, '']
  if (run.error !== null) lines.push(`Error: ${run.error}`, '')
  for (const attempt of run.attempts) {
    const result = attempt.result
    lines.push(`### ${title(attempt.nodeId)} (attempt ${attempt.number}): ${result?.outcome ?? attempt.status}`, '')
    if (result !== null) {
      lines.push(result.summary, '')
      for (const evidence of result.evidence) lines.push(`- ${evidence}`)
      if (result.evidence.length > 0) lines.push('')
    }
  }
  return lines
}

function stageStatus(item: QueueItem, stage: string): string {
  const state = item.land?.stages[stage]
  const posted = state?.posted === undefined ? '' : ` (update posted: ${state.posted})`
  return `${state?.status ?? 'not started'}${posted}`
}

export async function buildReport(item: QueueItem, runOf: (id: string) => RunView | undefined): Promise<string> {
  const lines = [`# ${item.title}`, '', item.url, '']
  for (const runId of item.runIds) lines.push(...runSection(runId, runOf(runId)))
  for (const stage of item.land?.plan ?? []) {
    lines.push(`## ${stage.label ?? stage.id}: ${stageStatus(item, stage.id)}`, '')
    const report = await stageReport(item, stage.id)
    if (report !== '') lines.push(report.trimEnd(), '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
