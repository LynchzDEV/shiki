import { basename, join } from 'node:path'

import type { TaskContext } from './plugins/context-files'
import { backUpAnswers, dropAnswerBackups, restoreAnswers } from './queue-answers'
import { agentCouldFix, bizQuestionsOf, blockedSummary, cardImagesMarkdown, NO_PICK, noPickMarkdown, pickOf, repoRequestsOf, runRequest, SETTLED, oneLine, stillOpenMarkdown, techQuestionsOf, type PickAnswer, type RunView } from './queue-prompts'
import { adoptionProblem, grantRepos, movedRealRepos, movedText, realRepoStates, reposToOffer, SINGLE_REPO_ASK } from './queue-repo-asks'
import { cardImagesFolder, importCardImages, refuseLinkedQueueFolders } from './queue-files'
import { createLand, PICK_FILE, type Land } from './queue-land'
import { isAsked, pickAsker, type PickAsker, type PickIn, type PickReplyEvent } from './queue-pick-ask'
import type { Published } from './publish'
import { afterRecoveries, applyRecovery, askOwner, buildRecoveryRequest, MAX_BUILD_RECOVERIES, ownerAnswerText, recoverGraph, withOpenBiz } from './queue-recover'
import { buildReport } from './queue-report'
import { QueueRefusal } from './queue-refusal'
import { message, replyCheck } from './queue-replies'
import type { QueueSource } from './queue-source'
import { workspaceRepos } from './repo-workspace'
import type { QueueItem, QueuePatch, QueueStore } from './queue-store'
import { fileExists, freshWorktree, WorktreeGone, worktreeRestorer } from './queue-worktree'

export type QueueRunner = {
  start(input: { cwd: string; request: string; label: string; workflowId?: string; graph?: unknown }, context: { startedByUser: boolean }): Promise<{ id: string }>
  get(id: string): RunView | undefined
  retry?(id: string, note?: string): Promise<{ id: string }>
  stop?(id: string): Promise<unknown>
}

export type QueueEngineDeps = {
  store: QueueStore
  runner: QueueRunner
  source(pluginId: string): QueueSource
  prepareWorktree(repo: string, label: string): Promise<{ worktree: string }>
  prepareWorkspace?(folder: string, repos: readonly string[], label: string): Promise<{ worktree: string }>
  isWorktree?(repo: string, worktree: string): Promise<boolean>
  writeContext(pluginId: string, context: TaskContext, cwd: string): Promise<string>
  pluginFiles(pluginId: string): string
  backupDir(itemId: string): string
  needsYou(item: QueueItem, reason: string, options?: { webhook?: boolean }): void
  autoPick?(pluginId: string): Promise<boolean>
  pickIn?(pluginId: string | undefined): Promise<PickIn>
  publish?(item: QueueItem): Promise<Published>
  notify?(item: QueueItem, event: PickReplyEvent): void
  unpublish?(item: QueueItem): Promise<void>
  publishKeepDays?(): Promise<number>
  pickAskTo?(): Promise<string | null>
  pickNonePhrases?(): Promise<string[]>
  sweepPublished?(): Promise<void>
  parallel?(): Promise<number>
  now?: () => number
}

export type AddInput = { source: string; externalId: string; repo: string; repos?: string[]; flowId?: string | null; position?: 'end' | 'next' }

export type PickChoice = { option: string; tester?: string; note?: string; answers?: PickAnswer[]; feedback?: string }

export type AddOptions = { background?: boolean }

export type RequeueOptions = { fresh?: boolean }

export type QueueEngine = {
  add(input: AddInput, options?: AddOptions): Promise<QueueItem>
  kick(): Promise<void>
  onRunSettled(run: RunView): Promise<void>
  recover(): Promise<void>
  requeue(id: string, options?: RequeueOptions): Promise<QueueItem>
  pick(id: string, choice: PickChoice): Promise<QueueItem>
  remove(id: string): Promise<void>
  unpublish(id: string): Promise<QueueItem>
  retirePublished(): Promise<void>
  stop(id: string): Promise<QueueItem>
  move(id: string, to: number): Promise<void>
  checkReplies(): Promise<{ checked: number; resumed: number }>
  answer(id: string, text: string): Promise<QueueItem>
  say(id: string, text: string): Promise<QueueItem>
  reread(id: string): Promise<QueueItem>
  repost(id: string): Promise<QueueItem>
  startStage(id: string, stage: string): Promise<QueueItem>
  refreshPreflight(id: string, stage: string): Promise<QueueItem>
  retryStage(id: string): Promise<QueueItem>
  markDone(id: string): Promise<QueueItem>
  landIdle(): Promise<void>
  landLog(id: string, stage: string): Promise<string>
  report(id: string): Promise<string>
  checkedAt(): number | null
  preparing(): string | null
  paused(): QueuePause | null
  subscribeChecks(listener: () => void): () => void
}

export type QueuePause = { reason: string; until: number }

const MAX_RUN_LABEL = 120
const MAX_AUTO_PICKS = 2
const DAY_MS = 24 * 60 * 60_000
const ASK_LOOKBACK_MS = 60_000
const DEFAULT_KEEP_DAYS = 14
const PAUSE_BACKOFF_MS = [5, 15, 60].map(minutes => minutes * 60_000)
const MAX_TIMER_MS = 2 ** 31 - 1
const REQUEUEABLE: ReadonlySet<QueueItem['state']> = new Set(['failed', 'ready', 'waiting-info', 'waiting-pick'])
const RETRIED_FROM = REQUEUEABLE

export { QueueRefusal }

export class SourceFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceFailure'
  }
}

async function fromSource<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw new SourceFailure(message(error))
  }
}

const MAX_TESTER = 200
const MAX_NOTE = 4000

async function writePick(deps: QueueEngineDeps, item: QueueItem, worktree: string, choice: PickChoice): Promise<void> {
  const none = choice.option === NO_PICK
  const tester = oneLine((choice.tester ?? '').slice(0, MAX_TESTER))
  const note = oneLine((choice.note ?? '').slice(0, MAX_NOTE))
  const markdown = `# Design pick\n\nOption: ${choice.option}\nTester: ${tester || '(not set)'}\nNote: ${note || '(none)'}\n${none ? noPickMarkdown(choice.feedback ?? '') : stillOpenMarkdown(choice.answers ?? [])}`
  const restored = await worktreeRestorer(deps)({ ...item, worktree })
  await refuseLinkedQueueFolders(restored, item.source)
  const path = await deps.writeContext(item.source, { name: 'pick', markdown }, restored)
  await backUpAnswers(deps.backupDir(item.id), path, markdown)
  await deps.store.update(item.id, { state: 'queued', worktree: restored, answerPaths: [...item.answerPaths.filter(entry => !PICK_FILE.test(basename(entry))), path], pick: undefined, questions: [], currentRunId: null, error: null })
  await deps.store.toFront(item.id)
}

const stateRefusal = (state: QueueItem['state']): QueueRefusal => new QueueRefusal(`It is ${state} now`, 409)

function found(store: QueueStore, id: string): QueueItem {
  const item = store.get(id)
  if (item === undefined) throw new QueueRefusal(`No queue item ${id}`, 404)
  return item
}

type QueueSteps = {
  atBoot(work: () => Promise<void>): Promise<void>
  answeredBuildRecovery(item: QueueItem, text: string): Promise<void>
  failer(resumeRunId?: string): (item: QueueItem, reason: string) => Promise<void>
  fail(item: QueueItem, reason: string): Promise<void>
  settle(run: RunView): Promise<void>
  startNext(): Promise<void>
  paused(): QueuePause | null
}

async function pickNow(deps: QueueEngineDeps, id: string, choice: PickChoice): Promise<void> {
  const item = found(deps.store, id)
  if (item.state !== 'waiting-pick' || item.pick === undefined) throw stateRefusal(item.state)
  if (isRunningInStudio(deps, item)) throw new QueueRefusal('It is running in Studio now', 409)
  const none = choice.option === NO_PICK
  if (!none && !item.pick.options.includes(choice.option)) throw new QueueRefusal(`Not an option: ${choice.option}`, 409)
  if (none && (choice.feedback ?? '').trim() === '') throw new QueueRefusal('Say what should change', 400)
  if (!none && choice.feedback !== undefined) throw new QueueRefusal('Feedback is only for none of these', 400)
  if (item.worktree === null) throw new QueueRefusal('It has no workspace', 409)
  try {
    await writePick(deps, item, item.worktree, choice)
  } catch (error) {
    if (error instanceof WorktreeGone) throw new QueueRefusal(error.message, 409)
    throw error
  }
}

function isRunningInStudio(deps: QueueEngineDeps, item: QueueItem): boolean {
  const lastRunId = item.runIds.at(-1)
  const run = lastRunId === undefined ? undefined : deps.runner.get(lastRunId)
  return run !== undefined && !SETTLED.has(run.status)
}

function queueSteps(deps: QueueEngineDeps, land: Land, onPreparing: (id: string | null) => void, wake: () => void, onPausedChange: () => void, asker: () => PickAsker): QueueSteps {
  const { store } = deps
  const now = deps.now ?? Date.now
  let paused: QueuePause | null = null
  let backoff = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  let booting = false
  const atBoot = async (work: () => Promise<void>): Promise<void> => {
    booting = true
    try { await work() } finally { booting = false }
  }

  const failer = (resumeRunId?: string) => async (item: QueueItem, reason: string): Promise<void> => {
    const failed = await store.update(item.id, { state: 'failed', error: reason, currentRunId: null, pick: undefined, questions: [], resumeRunId })
    deps.needsYou(failed, reason)
  }
  const fail = failer()

  const applied = new Map<string, string>()
  const fingerprint = (run: RunView): string => JSON.stringify([run.status, run.error, run.attempts.length, run.attempts.at(-1)?.endedAt ?? null])

  function settling(run: RunView): QueueItem | undefined {
    const items = store.list()
    const building = items.find(entry => entry.state === 'building' && entry.currentRunId === run.id)
    if (building !== undefined) return building
    if (applied.get(run.id) === fingerprint(run)) return undefined
    return items.find(entry => RETRIED_FROM.has(entry.state) && entry.runIds.at(-1) === run.id)
  }

  async function rerunWithRepos(item: QueueItem, repos: string[]): Promise<void> {
    await store.update(item.id, { state: 'queued', repos, repoReruns: (item.repoReruns ?? 0) + 1, currentRunId: null, questions: [], error: null })
    await store.toFront(item.id)
  }

  async function askOrFail(settled: QueueItem, run: RunView): Promise<void> {
    const fail = failer(run.id)
    let item = settled
    const biz = bizQuestionsOf(run)
    const tech = techQuestionsOf(run)
    const questions = [...tech, ...biz]
    if (item.repos === undefined && questions.length === 0 && repoRequestsOf(run).length > 0) return fail(item, SINGLE_REPO_ASK)
    const asked = item.repos === undefined ? [] : repoRequestsOf(run)
    if (asked.length > 0) {
      const granted = await grantRepos(deps, item, asked, questions.length > 0)
      if ('fail' in granted) return fail(item, granted.fail)
      if (questions.length === 0) return rerunWithRepos(item, granted.repos)
      item = await store.update(item.id, { repos: granted.repos })
    }
    const picked = pickOf(run)
    if (picked !== null && 'invalid' in picked) return fail(item, `Bad pick line: ${picked.invalid}`)
    if (picked !== null) {
      if (picked.recommended !== null && await autoPicked(item, picked.recommended, run.workflow?.plugin)) return
      const parked = await store.update(item.id, { state: 'waiting-pick', pick: { ...picked, summary: blockedSummary(run) }, questions, currentRunId: null })
      if (await asker().asksInSource(parked, run.workflow?.plugin)) return asker().ask(parked)
      deps.needsYou(parked, 'Pick a design variant')
      return
    }
    if (questions.length === 0) return recoverOrFail(item, run)
    if (tech.length > 0) return askOwner(deps, item, tech, continuing(item, run, biz, (item.repos ?? []).filter(name => !settled.repos?.includes(name))))
    try {
      const posted = await deps.source(item.source).post({ id: item.externalId, kind: 'ask', lines: biz })
      const parked = await store.update(item.id, { state: 'waiting-info', questions: biz, askedIn: undefined, lastSeenId: item.lastSeenId ?? posted.commentId, currentRunId: null })
      deps.needsYou(parked, 'Question posted to ClickUp')
    } catch (error) {
      await fail(item, `Could not post the questions: ${message(error)}`)
    }
  }

  function continuing(item: QueueItem, run: RunView, biz: string[], addedRepos: string[]): QueuePatch {
    if (deps.runner.retry === undefined) return {}
    const attempts = item.recoverBuild?.runId === run.id ? item.recoverBuild.attempts : 0
    return { recoverBuild: { runId: run.id, attempts, asked: true, ...(biz.length === 0 ? {} : { openBiz: biz }), ...(addedRepos.length === 0 ? {} : { addedRepos }) } }
  }

  async function recoverOrFail(item: QueueItem, run: RunView): Promise<void> {
    const reason = run.error ?? `Run ${run.status}`
    if (run.status === 'stopped' || deps.runner.retry === undefined || !agentCouldFix(run)) return failer(run.id)(item, reason)
    const attempts = item.recoverBuild?.runId === run.id ? item.recoverBuild.attempts : 0
    return startBuildRecovery(item, run, reason, attempts)
  }

  async function startBuildRecovery(item: QueueItem, run: RunView, reason: string, attempts: number): Promise<void> {
    const fail = failer(run.id)
    if (booting) return fail(item, reason)
    if (attempts >= MAX_BUILD_RECOVERIES) return fail(item, afterRecoveries(reason, attempts))
    let recoveryRunId: string
    try {
      if (item.worktree === null) throw new Error('The item has no workspace')
      const request = buildRecoveryRequest(item, reason, run.attempts.at(-1)?.output ?? '')
      recoveryRunId = (await deps.runner.start({ cwd: item.worktree, request, label: `Recover: ${item.title}`.slice(0, MAX_RUN_LABEL), graph: recoverGraph() }, { startedByUser: true })).id
    } catch (error) {
      return fail(item, `${reason}\nRecovery could not start: ${message(error)}`)
    }
    await store.update(item.id, { state: 'building', currentRunId: recoveryRunId, error: null, questions: [], pick: undefined, recoverBuild: { runId: run.id, attempts: attempts + 1, recoveryRunId } })
    await settleIfDone(recoveryRunId)
  }

  async function buildRecoverySettled(item: QueueItem, run: RunView): Promise<void> {
    const { runId, attempts } = item.recoverBuild!
    const failed = deps.runner.get(runId)
    const reason = failed?.error ?? (failed === undefined ? `Run ${run.status}` : `Run ${failed.status}`)
    if (booting) return failer(runId)(item, reason)
    if (run.unavailable) await store.update(item.id, { recoverBuild: { runId, attempts: attempts - 1 } })
    await applyRecovery(deps, item, run, reason, {
      whenAsking: { recoverBuild: { runId, attempts, asked: true } },
      pass: async () => {
        const resumedRun = await deps.runner.retry!(runId)
        await store.update(item.id, { currentRunId: resumedRun.id, recoverBuild: { runId, attempts } })
        await settleIfDone(resumedRun.id)
      },
      stopped: () => failer(runId)(item, run.error ?? reason),
      again: () => startBuildRecovery(item, failed ?? run, reason, attempts),
      fail: why => failer(runId)(item, why),
    })
  }

  async function answeredBuildRecovery(item: QueueItem, text: string): Promise<void> {
    const { runId, attempts, addedRepos } = item.recoverBuild!
    const note = ownerAnswerText(item.questions, text, addedRepos)
    try {
      await store.update(item.id, { recoverBuild: { ...item.recoverBuild!, note } })
      const resumedRun = await deps.runner.retry!(runId, note)
      await store.update(item.id, { state: 'building', currentRunId: resumedRun.id, questions: [], error: null, recoverBuild: { runId, attempts } })
      await settleIfDone(resumedRun.id)
    } catch (error) {
      await failer(runId)(item, `Could not resume the run with your answer: ${message(error)}`)
    }
  }

  async function autoPicked(item: QueueItem, option: string, plugin: string | undefined): Promise<boolean> {
    if (plugin === undefined || item.worktree === null || (item.autoPicks ?? 0) >= MAX_AUTO_PICKS) return false
    try {
      if (!await deps.autoPick?.(plugin)) return false
      await writePick(deps, item, item.worktree, { option, tester: '', note: `Auto-picked the recommended option (autoPick is on in ${plugin} settings)` })
    } catch (error) {
      console.error(`Queue item ${item.id} auto-pick failed`, error)
      return false
    }
    const picked = await store.update(item.id, { autoPicks: (item.autoPicks ?? 0) + 1 })
    deps.needsYou(picked, `Auto-picked ${option}`)
    return true
  }

  async function withRecordedRepos(item: QueueItem): Promise<QueueItem | { fail: string }> {
    if (item.repos === undefined || item.worktree === null) return item
    const recorded = await workspaceRepos(item.worktree)
    const added = (recorded ?? []).filter(name => !item.repos!.includes(name))
    if (added.length === 0) return item
    const problem = await adoptionProblem(item, added)
    return problem === null ? store.update(item.id, { repos: [...item.repos, ...added] }) : { fail: problem }
  }

  async function noteMovedRealRepos(item: QueueItem): Promise<{ item: QueueItem; moved: string[] }> {
    const moved = await movedRealRepos(item)
    if (moved.length === 0) return { item, moved }
    const realChanged = [...new Set([...(item.realChanged ?? []), ...moved])]
    return { item: await store.update(item.id, { realChanged }), moved }
  }

  async function pause(item: QueueItem, run: RunView, unavailable: NonNullable<RunView['unavailable']>): Promise<void> {
    const queued = await store.update(item.id, { state: 'queued', currentRunId: null, error: null, questions: [], pick: undefined, resumeRunId: run.id })
    await store.toFront(item.id)
    const at = now()
    const until = unavailable.until ?? at + PAUSE_BACKOFF_MS[Math.min(backoff++, PAUSE_BACKOFF_MS.length - 1)]!
    const raise = paused === null
    paused = { reason: `${unavailable.engine} unavailable: ${unavailable.reason}`, until }
    clearTimeout(timer)
    timer = setTimeout(wake, Math.min(Math.max(until - at, 0), MAX_TIMER_MS))
    timer.unref()
    if (raise) deps.needsYou(queued, `Queue paused: ${paused.reason}`)
  }

  async function settleState(item: QueueItem, run: RunView): Promise<void> {
    if (run.unavailable) return pause(item, run, run.unavailable)
    backoff = 0
    if (run.status !== 'done') return askOrFail(item, run)
    const stages = run.workflow?.land ?? []
    if (stages.length > 0) return land.begin(item, stages, run.workflow?.plugin)
    const ready = await store.update(item.id, { state: 'ready', currentRunId: null, error: null, pick: undefined, questions: [] })
    deps.needsYou(ready, 'Built and ready for review')
  }

  async function settle(run: RunView): Promise<void> {
    if (!SETTLED.has(run.status)) return
    if (await land.recoverySettled(run)) return
    const recovering = store.list().find(entry => entry.state === 'building' && entry.recoverBuild?.recoveryRunId === run.id)
    if (recovering !== undefined) return buildRecoverySettled(recovering, run)
    const found = settling(run)
    if (found === undefined) return
    applied.set(run.id, fingerprint(run))
    const adopted = await withRecordedRepos(found)
    if ('fail' in adopted) return failer(run.id)(found, adopted.fail)
    const { item, moved } = await noteMovedRealRepos(adopted)
    await settleState(item, run)
    if (moved.length > 0) deps.needsYou(store.get(item.id) ?? item, movedText(item, moved))
  }

  const restore = worktreeRestorer(deps)
  const prepare = freshWorktree(deps)

  async function contextIn(item: QueueItem, worktree: string): Promise<string> {
    if (item.contextPath !== null && await fileExists(item.contextPath)) return item.contextPath
    const detail = await deps.source(item.source).item({ id: item.externalId })
    const outcomes = await importCardImages(deps.pluginFiles(item.source), detail.images ?? [], cardImagesFolder(worktree, item.source))
    return deps.writeContext(item.source, { name: `item-${item.externalId}`, markdown: detail.contextMarkdown + cardImagesMarkdown(outcomes) }, worktree)
  }

  async function answersOf(item: QueueItem): Promise<string[]> {
    const { kept, dropped } = await restoreAnswers(deps.backupDir(item.id), item.answerPaths)
    if (dropped.length === 0) return kept
    console.warn(`Queue item ${item.id} lost answers with no backup, dropped: ${dropped.join(', ')}`)
    await store.update(item.id, { answerPaths: kept })
    return kept
  }

  async function resumed(item: QueueItem): Promise<string | null> {
    if (item.resumeRunId === undefined || deps.runner.retry === undefined || item.worktree === null) return null
    const worktree = await restore({ ...item, worktree: item.worktree })
    await refuseLinkedQueueFolders(worktree, item.source)
    await contextIn(item, worktree)
    await answersOf(item)
    const pending = item.recoverBuild?.runId === item.resumeRunId ? item.recoverBuild : undefined
    try {
      const run = await deps.runner.retry(item.resumeRunId, pending?.note)
      await store.update(item.id, { state: 'building', currentRunId: run.id, resumeRunId: undefined, error: null, ...(pending === undefined ? {} : { recoverBuild: { runId: pending.runId, attempts: pending.attempts } }) })
      return run.id
    } catch (error) {
      console.warn(`Queue item ${item.id} could not resume run ${item.resumeRunId}, starting over: ${message(error)}`)
      await store.update(item.id, { resumeRunId: undefined, recoverBuild: undefined })
      return null
    }
  }

  async function settleIfDone(runId: string): Promise<void> {
    const now = deps.runner.get(runId)
    if (now !== undefined && SETTLED.has(now.status)) await settle(now)
  }

  async function build(queued: QueueItem): Promise<void> {
    const resumedRunId = await resumed(queued)
    if (resumedRunId !== null) return settleIfDone(resumedRunId)
    const current = store.get(queued.id) ?? queued
    const available = current.repos === undefined ? [] : await reposToOffer(current.repo)
    const worktree = current.worktree === null ? (await prepare(current)).worktree : await restore({ ...current, worktree: current.worktree })
    const item = await withRecordedRepos({ ...current, worktree })
    if ('fail' in item) throw new Error(item.fail)
    await refuseLinkedQueueFolders(worktree, item.source)
    const contextPath = await contextIn(item, worktree)
    const answerPaths = await answersOf(item)
    const ready = { ...item, worktree, contextPath, answerPaths }
    const realBaseline = item.repos === undefined ? undefined : await realRepoStates(item.repo, available)
    if (item.repos !== undefined) await store.update(item.id, { worktree })
    const run = await deps.runner.start({ cwd: worktree, request: runRequest(ready, available), label: item.title.slice(0, MAX_RUN_LABEL), ...(item.flowId ? { workflowId: item.flowId } : {}) }, { startedByUser: true })
    await store.update(item.id, { state: 'building', worktree, contextPath, currentRunId: run.id, runIds: [...item.runIds, run.id], error: null, realBaseline })
    await settleIfDone(run.id)
  }

  async function startNext(): Promise<void> {
    if (paused !== null && now() < paused.until) return
    if (paused !== null) { paused = null; onPausedChange() }
    const limit = deps.parallel ? await deps.parallel() : 1
    while (paused === null && store.list().filter(item => item.state === 'building').length < limit) {
      const next = store.list().find(item => item.state === 'queued')
      if (next === undefined) return
      onPreparing(next.id)
      try { await build(next) } catch (error) { await fail(next, message(error)) } finally { onPreparing(null) }
    }
  }

  return { answeredBuildRecovery, atBoot, failer, fail, settle, startNext, paused: () => paused }
}

export function createQueueEngine(deps: QueueEngineDeps): QueueEngine {
  const { store } = deps
  const checkListeners = new Set<() => void>()
  const tell = (): void => { for (const listener of checkListeners) listener() }
  let preparingId: string | null = null
  const land = createLand({ ...deps, settleRun: (run) => { void onRunSettled(run).catch(error => console.error('Queue settle failed', error)) } })
  let asker: PickAsker | undefined
  const { answeredBuildRecovery, atBoot, failer, fail, settle, startNext, paused } = queueSteps(deps, land, (id) => { preparingId = id; tell() }, () => { void kick().catch(error => console.error('queue resume failed', error)) }, () => tell(), () => asker!)
  let lane: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = lane.then(work)
    lane = result.catch(error => console.error('queue step failed', error))
    return result
  }

  function kick(): Promise<void> {
    return serial(startNext)
  }

  function onRunSettled(run: RunView): Promise<void> {
    return serial(async () => { await settle(run); await startNext() })
  }

  const refuseDuplicate = (input: AddInput): void => {
    if (store.list().some(item => item.source === input.source && item.externalId === input.externalId)) throw new QueueRefusal('Already in the queue', 409)
  }

  async function add(input: AddInput, options: AddOptions = {}): Promise<QueueItem> {
    refuseDuplicate(input)
    const detail = await fromSource(() => deps.source(input.source).item({ id: input.externalId }))
    refuseDuplicate(input)
    const item = await store.add({ source: input.source, externalId: input.externalId, title: detail.title, url: detail.url, repo: input.repo, flowId: input.flowId ?? null, ...(input.repos === undefined ? {} : { repos: input.repos }) }, input.position ?? 'end')
    const building = serial(startNext)
    if (options.background) building.catch(() => {})
    else await building
    return store.get(item.id) ?? item
  }

  const runningInStudio = (item: QueueItem): boolean => isRunningInStudio(deps, item)

  const requeue = (id: string, options: RequeueOptions = {}): Promise<QueueItem> => serial(async () => {
    const item = found(store, id)
    if (!REQUEUEABLE.has(item.state)) throw stateRefusal(item.state)
    if (runningInStudio(item)) throw new QueueRefusal('It is running in Studio now', 409)
    const resumeRunId = item.state === 'failed' && options.fresh !== true ? item.resumeRunId : undefined
    const unsentNote = item.recoverBuild?.runId === resumeRunId ? item.recoverBuild?.note : undefined
    await store.update(id, { state: 'queued', error: null, currentRunId: null, pick: undefined, land: undefined, questions: [], repoReruns: item.repoReruns === undefined ? undefined : 0, realChanged: item.realChanged === undefined ? undefined : [], resumeRunId, recoverBuild: unsentNote === undefined ? undefined : { runId: resumeRunId!, attempts: 0, note: unsentNote } })
    await asker!.close(item)
    await store.move(id, store.list().length)
    await startNext()
    return found(store, id)
  })

  const pick = (id: string, choice: PickChoice): Promise<QueueItem> => serial(async () => {
    const asked = found(store, id)
    await pickNow(deps, id, choice)
    await asker!.close(asked, choice)
    await startNext()
    return found(store, id)
  })

  async function stopRun(item: QueueItem): Promise<void> {
    const run = item.currentRunId === null ? undefined : deps.runner.get(item.currentRunId)
    if (run === undefined || SETTLED.has(run.status)) return
    if (deps.runner.stop === undefined) throw new QueueRefusal('Stopping runs is not available', 409)
    await deps.runner.stop(run.id)
  }

  const stop = (id: string): Promise<QueueItem> => serial(async () => {
    const item = found(store, id)
    if (item.state === 'building') await stopRun(item)
    else if (item.state === 'landing') { await stopRun(item); await land.stop(id) }
    else throw stateRefusal(item.state)
    return found(store, id)
  })

  const remove = (id: string): Promise<void> => serial(async () => {
    const item = found(store, id)
    if (item.state === 'building') await stopRun(item)
    if (item.state === 'landing') { await stopRun(item); land.halt(id) }
    await asker!.close(item)
    if (item.published !== undefined) await deps.unpublish?.(item).catch(error => console.error(`Queue item ${id} published folder not removed`, error))
    await store.remove(id)
    await dropAnswerBackups(deps.backupDir(id)).catch(error => console.error('queue answer backups not removed', error))
  })

  async function takeDown(item: QueueItem): Promise<QueueItem> {
    await deps.unpublish?.(item)
    return store.update(item.id, { published: undefined }, { touch: false })
  }

  const unpublish = (id: string): Promise<QueueItem> => serial(async () => {
    const item = found(store, id)
    if (item.published === undefined) throw new QueueRefusal('It has no published link', 409)
    return takeDown(item)
  })

  const landedWithLink = (item: QueueItem): boolean => item.published !== undefined && item.state === 'landed'
  const retirePublished = (): Promise<void> => serial(async () => {
    const keepMs = (await deps.publishKeepDays?.() ?? DEFAULT_KEEP_DAYS) * DAY_MS
    const at = (deps.now ?? Date.now)()
    const expired = (entry: QueueItem): boolean => entry.published !== undefined && at - entry.published.at > keepMs && !isAsked(entry)
    for (const item of store.list().filter(entry => landedWithLink(entry) || expired(entry))) {
      await takeDown(item).catch(error => console.error(`Queue item ${item.id} published folder not removed`, error))
    }
    await deps.sweepPublished?.()
  })
  store.subscribe(() => { if (store.list().some(landedWithLink)) retirePublished().catch(error => console.error('Published link sweep failed', error)) })

  const move = (id: string, to: number): Promise<void> => serial(async () => {
    const item = found(store, id)
    if (item.state !== 'queued') throw stateRefusal(item.state)
    await store.move(id, to)
  })

  const replies = replyCheck(deps, fail)
  asker = pickAsker(deps, { pickNow: (id, choice) => pickNow(deps, id, choice), keep: replies.keep })
  const readsReplies = (item: QueueItem): boolean => item.worktree !== null && ((item.state === 'waiting-info' && item.askedIn !== 'shikidan') || isAsked(item))
  const stillWaiting = (read: QueueItem): { item: QueueItem; worktree: string } | undefined => {
    const item = store.get(read.id)
    if (item === undefined || !readsReplies(item) || item.state !== read.state || item.lastSeenId !== read.lastSeenId || item.pick?.ask?.ref !== read.pick?.ask?.ref || runningInStudio(item)) return undefined
    return { item, worktree: item.worktree! }
  }

  let lastCheckedAt: number | null = null
  const markChecked = (): void => {
    lastCheckedAt = (deps.now ?? Date.now)()
    tell()
  }

  const checkReplies = async (): Promise<{ checked: number; resumed: number }> => {
    await serial(() => asker!.askUnasked())
    const waiting = store.list().filter(readsReplies)
    const reads = await Promise.allSettled(waiting.map(item => runningInStudio(item) ? Promise.resolve(null) : replies.read(item)))
    return serial(async () => {
      let resumed = 0
      for (const [index, read] of reads.entries()) {
        const current = stillWaiting(waiting[index]!)
        if (read.status !== 'fulfilled' || read.value === null || current === undefined) continue
        const apply = current.item.state === 'waiting-pick' ? asker!.apply : replies.apply
        if (await apply(current.item, current.worktree, read.value)) resumed += 1
      }
      await startNext()
      return { checked: waiting.length, resumed }
    }).then((counts) => { markChecked(); return counts })
  }

  const answer = (id: string, text: string): Promise<QueueItem> => serial(async () => {
    const item = found(store, id)
    if (item.state !== 'waiting-info' || item.askedIn !== 'shikidan') throw new QueueRefusal('It is not waiting for your answer', 409)
    if (item.worktree === null) throw new QueueRefusal('It has no workspace', 409)
    if (runningInStudio(item)) throw new QueueRefusal('It is running in Studio now', 409)
    try {
      if (item.land?.recover?.asked === true) {
        await replies.keepAnswer(item, item.worktree, text)
        await land.answered(id, text)
      } else if (item.recoverBuild?.asked === true) {
        const full = withOpenBiz(text, item.recoverBuild.openBiz)
        await replies.keepAnswer(item, item.worktree, full)
        await answeredBuildRecovery(found(store, id), full)
      } else {
        await replies.answer(item, item.worktree, text)
      }
    } catch (error) {
      if (error instanceof WorktreeGone) throw new QueueRefusal(error.message, 409)
      throw error
    }
    await startNext()
    return found(store, id)
  })

  async function say(id: string, text: string): Promise<QueueItem> {
    const item = found(store, id)
    if (item.source === '' || item.externalId === '') throw new QueueRefusal('It has no source card to write to', 409)
    const source = deps.source(item.source)
    const lines = text.split('\n')
    await fromSource(() => (isAsked(item) ? source.reply({ id: item.externalId, ref: item.pick!.ask!.ref, lines }) : source.post({ id: item.externalId, kind: 'update', lines })))
    return found(store, id)
  }

  const reread = (id: string): Promise<QueueItem> => serial(async () => {
    const item = found(store, id)
    if (!isAsked(item)) throw new QueueRefusal('It is not waiting on a ClickUp pick', 409)
    if (item.worktree === null) throw new QueueRefusal('It has no workspace', 409)
    if (runningInStudio(item)) throw new QueueRefusal('It is running in Studio now', 409)
    const ask = item.pick!.ask!
    const sinceId = ask.since ?? String(ask.postedAt - ASK_LOOKBACK_MS)
    const result = await fromSource(() => deps.source(item.source).replies({ id: item.externalId, sinceId }))
    await asker!.apply(item, item.worktree, result, { keepOthers: false })
    await startNext()
    return found(store, id)
  })

  const repost = (id: string): Promise<QueueItem> => serial(async () => {
    const item = found(store, id)
    if (item.state !== 'waiting-pick' || item.pick === undefined) throw new QueueRefusal('It is not waiting on a pick', 409)
    if (item.worktree === null) throw new QueueRefusal('It has no workspace', 409)
    if (runningInStudio(item)) throw new QueueRefusal('It is running in Studio now', 409)
    await asker!.close(item)
    const { ask: _old, ...pick } = item.pick
    await asker!.ask(await store.update(id, { pick }))
    const ask = found(store, id).pick?.ask
    if (ask?.error !== undefined) throw new SourceFailure(ask.error)
    return found(store, id)
  })

  async function recover(): Promise<void> {
    await serial(async () => {
      await land.recover()
      await atBoot(async () => {
        for (const item of store.list().filter(entry => entry.state === 'building')) {
          const run = item.currentRunId === null ? undefined : deps.runner.get(item.currentRunId)
          if (run === undefined) await failer(item.recoverBuild?.runId)(item, 'Its run is gone')
          else if (SETTLED.has(run.status)) await settle(run)
        }
      })
      await asker!.askUnasked()
      await startNext()
    })
  }

  return {
    add,
    requeue,
    pick,
    remove,
    unpublish,
    retirePublished,
    stop,
    move,
    recover,
    kick,
    startStage: (id, stage) => serial(() => land.startStage(id, stage)),
    refreshPreflight: (id, stage) => serial(() => land.refreshPreflight(id, stage)),
    retryStage: id => serial(() => land.retryStage(id)),
    markDone: id => serial(() => land.markDone(id)),
    landIdle: land.idle,
    landLog: land.log,
    report: async id => buildReport(found(store, id), runId => deps.runner.get(runId)),
    onRunSettled,
    checkReplies,
    answer,
    say,
    reread,
    repost,
    checkedAt: () => lastCheckedAt,
    preparing: () => preparingId,
    paused,
    subscribeChecks: (listener) => { checkListeners.add(listener); return () => { checkListeners.delete(listener) } },
  }
}
