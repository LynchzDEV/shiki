import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type { QueueItem, QueuePick } from './queue-store'
import type { SourceReply } from './queue-source'
import type { WorkflowRun } from './workflow-runner'

export type RunView = Pick<WorkflowRun, 'id' | 'status' | 'error' | 'attempts'> & { workflow?: Partial<Pick<WorkflowRun['workflow'], 'land' | 'nodes'>> & { plugin?: string } }

export const SETTLED: ReadonlySet<WorkflowRun['status']> = new Set(['done', 'failed', 'blocked', 'stopped'])

const MAX_BRANCH = 60

const sourceTag = (source: string): string => createHash('sha256').update(source).digest('hex').slice(0, 4)

export function branchLabel(item: Pick<QueueItem, 'title' | 'externalId' | 'source'>): string {
  const id = `${item.externalId.toLowerCase().replace(/[^a-z0-9]+/g, '')}-${sourceTag(item.source)}`
  const room = MAX_BRANCH - 'queue-'.length - id.length - 1
  const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, Math.max(0, room)).replace(/-+$/, '')
  return slug ? `queue-${slug}-${id}` : `queue-${id}`
}

const REPO_REQUEST = /^repo:\s*(\S.*)$/i
const PICK_LINE = /^pick:\s*(.*)$/i
const QUOTES = /^[`'"]+|[`'"]+$/g
const BULLET = /^(?:[-*•>]|\d+[.)])\s*/

function requestedRepos(line: string): string[] | null {
  const bare = line.replace(BULLET, '').replace(QUOTES, '').trim()
  const match = REPO_REQUEST.exec(bare)
  if (match === null) return null
  return match[1]!.split(/[\s,]+/).map(name => name.replace(QUOTES, '')).filter(name => name !== '')
}

function reposLines(item: Pick<QueueItem, 'repo' | 'worktree'> & { repos: readonly string[] }, available: readonly string[]): string[] {
  const copies = item.repos.length === 0 ? 'none yet' : item.repos.map(name => join(item.worktree ?? '', name)).join(', ')
  return [
    `This item spans several repos in ${item.repo}. The real repos there are READ-ONLY: read them to plan, never change them: ${available.map(name => join(item.repo, name)).join(', ')}.`,
    `Work only in the repo copies in this workspace, at ${item.worktree}/<name>. Copies ready now: ${copies}. Each copy is its own git worktree; make, test and inspect changes inside it.`,
    'To get a copy of another repo, end the step with SKD_RESULT blocked and one evidence item per repo in exactly the form `repo: <name>`. Any other evidence item is a question for the requester.',
    'Ask for every repo you need in one go: Shikidan makes the copies and starts a new run, and stops after 3 such asks.',
  ]
}

export function runRequest(item: Pick<QueueItem, 'title' | 'url' | 'contextPath' | 'answerPaths' | 'repos' | 'repo' | 'worktree'>, available: readonly string[] = []): string {
  return [
    `Work on "${item.title}" (${item.url}).`,
    ...(item.repos === undefined ? [] : reposLines({ ...item, repos: item.repos }, available)),
    `Read the task context in ${item.contextPath}.`,
    ...(item.answerPaths.length > 0 ? [`The requester answered your earlier questions: read ${item.answerPaths.join(', ')}.`] : []),
    'If information you need is missing and you cannot decide it yourself, end the step with SKD_RESULT blocked and put each question for the requester as one evidence item.',
  ].join('\n')
}

type Attempt = RunView['attempts'][number]

const byAgent = (attempt: Attempt): boolean => attempt.jobId !== null || attempt.inSession === true

function lastBlocked(run: RunView): Attempt | undefined {
  const settled = run.attempts.filter(attempt => attempt.result !== null && attempt.endedAt !== null && !attempt.interrupted)
  const last = settled.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).at(-1)
  if (run.status !== 'blocked' || last === undefined || !byAgent(last) || last.result?.outcome !== 'blocked') return undefined
  return last
}

const blockedEvidence = (run: RunView): string[] => lastBlocked(run)?.result?.evidence.map(line => line.trim()).filter(line => line !== '') ?? []

const MAX_SUMMARY = 64000

export function blockedSummary(run: RunView): string {
  const last = lastBlocked(run)
  const text = [last?.result?.summary ?? '', last?.output ?? ''].filter(part => part.trim() !== '').join('\n\n')
  return text.slice(0, MAX_SUMMARY)
}

const pickBody = (line: string): string | null => PICK_LINE.exec(line.replace(BULLET, '').replace(QUOTES, '').trim())?.[1] ?? null

export function questionsOf(run: RunView): string[] {
  return blockedEvidence(run).filter(line => requestedRepos(line) === null && pickBody(line) === null)
}

export function repoRequestsOf(run: RunView): string[] {
  return [...new Set(blockedEvidence(run).flatMap(line => requestedRepos(line) ?? []))]
}

export function answersMarkdown(questions: string[], replies: SourceReply[], images: string[]): string {
  const asked = questions.map(question => `- ${question}`).join('\n')
  const answered = replies.map(reply => `### ${reply.author}\n\n${reply.text}`).join('\n\n')
  const pictures = images.length > 0 ? `\n## Images\n\n${images.map(path => `- ${path}`).join('\n')}\n` : ''
  return `# Answers from the requester\n\n## Questions asked\n\n${asked}\n\n## Replies\n\n${answered}\n${pictures}`
}

const OPTION_ID = /^[A-Z][A-Za-z0-9]{0,15}$/
const MOCKUP_ROOT = 'visualizer/'
const MIN_OPTIONS = 2
const MAX_OPTIONS = 6

export type PickRequest = Omit<QueuePick, 'summary'>
export type PickInvalid = { invalid: string }

function pickProblem(options: string[], path: string, recommended: string | null): string | null {
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return `give ${MIN_OPTIONS} to ${MAX_OPTIONS} options`
  const bad = options.find(id => !OPTION_ID.test(id))
  if (bad !== undefined) return `bad option id ${bad}`
  if (new Set(options).size !== options.length) return 'option ids must be unique'
  if (path.startsWith('/') || !path.startsWith(MOCKUP_ROOT) || path.length === MOCKUP_ROOT.length || path.split('/').includes('..')) return `the folder must be relative and inside ${MOCKUP_ROOT}`
  if (recommended !== null && !options.includes(recommended)) return `recommended ${recommended} is not an option`
  return null
}

export function pickOf(run: RunView): PickRequest | PickInvalid | null {
  const bodies = blockedEvidence(run).map(pickBody).filter((body): body is string => body !== null)
  const body = bodies.at(-1)
  if (body === undefined) return null
  const [ids = '', folder = '', recommended = '', tester = ''] = body.split('|').map(part => part.trim().replace(QUOTES, '').trim())
  const options = ids.split(/[\s,]+/).map(id => id.replace(QUOTES, '')).filter(id => id !== '')
  const path = folder.replace(/\/+$/, '')
  const problem = pickProblem(options, path, recommended === '' ? null : recommended)
  if (problem !== null) return { invalid: problem }
  return { options, path, recommended: recommended === '' ? null : recommended, tester: tester === '' ? null : tester }
}
