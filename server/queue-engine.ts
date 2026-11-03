import { basename, join } from 'node:path'

import type { TaskContext } from './plugins/context-files'
import { backUpAnswers, dropAnswerBackups, restoreAnswers } from './queue-answers'
import { blockedSummary, cardImagesMarkdown, NO_PICK, noPickMarkdown, pickOf, questionsOf, repoRequestsOf, runRequest, SETTLED, oneLine, stillOpenMarkdown, type PickAnswer, type RunView } from './queue-prompts'
import { adoptionProblem, grantRepos, movedRealRepos, movedText, realRepoStates, reposToOffer, SINGLE_REPO_ASK } from './queue-repo-asks'
import { importCardImages, queueFolder, refuseLinkedQueueFolders } from './queue-files'
import { createLand, PICK_FILE, type Land } from './queue-land'
import { buildReport } from './queue-report'
import { QueueRefusal } from './queue-refusal'
import { message, replyCheck } from './queue-replies'
import type { QueueSource } from './queue-source'
import { workspaceRepos } from './repo-workspace'
import type { QueueItem, QueueStore } from './queue-store'
import { fileExists, freshWorktree, WorktreeGone, worktreeRestorer } from './queue-worktree'

export type QueueRunner = {
  start(input: { cwd: string; request: string; label: string; workflowId?: string }, context: { startedByUser: boolean }): Promise<{ id: string }>
  get(id: string): RunView | undefined
  retry?(id: string): Promise<{ id: string }>
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
  needsYou(item: QueueItem, reason: string): void
  autoPick?(pluginId: string): Promise<boolean>
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
  move(id: string, to: number): Promise<void>
  checkReplies(): Promise<{ checked: number; resumed: number }>
  startStage(id: string, stage: string): Promise<QueueItem>
  refreshPreflight(id: string, stage: string): Promise<QueueItem>
  retryStage(id: string): Promise<QueueItem>
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
  fail(item: QueueItem, reason: string): Promise<void>
  settle(run: RunView): Promise<void>
  startNext(): Promise<void>
  paused(): QueuePause | null
}

function queueSteps(deps: QueueEngineDeps, land: Land, onPreparing: (id: string | null) => void, wake: () => void, onPausedChange: () => void): QueueSteps {
  const { store } = deps
  const now = deps.now ?? Date.now
  let paused: QueuePause | null = null
  let backoff = 0
  let timer: ReturnType<typeof setTimeout> | undefined

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
    const questions = questionsOf(run)
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
      deps.needsYou(parked, 'Pick a design variant')
      return
    }
    if (questions.length === 0) return fail(item, run.error ?? `Run ${run.status}`)
    try {
      const posted = await deps.source(item.source).post({ id: item.externalId, kind: 'ask', lines: questions })
      await store.update(item.id, { state: 'waiting-info', questions, lastSeenId: item.lastSeenId ?? posted.commentId, currentRunId: null })
    } catch (error) {
      await fail(item, `Could not post the questions: ${message(error)}`)
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
    const outcomes = await importCardImages(deps.pluginFiles(item.source), detail.images ?? [], join(queueFolder(worktree, item.source), 'card-images'))
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
    try {
      const run = await deps.runner.retry(item.resumeRunId)
      await store.update(item.id, { state: 'building', currentRunId: run.id, resumeRunId: undefined, error: null })
      return run.id
    } catch (error) {
      console.warn(`Queue item ${item.id} could not resume run ${item.resumeRunId}, starting over: ${message(error)}`)
      await store.update(item.id, { resumeRunId: undefined })
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
    const item = store.get(queued.id) ?? queued
    const available = item.repos === undefined ? [] : await reposToOffer(item.repo)
    const worktree = item.worktree === null ? (await prepare(item)).worktree : await restore({ ...item, worktree: item.worktree })
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

  return { fail, settle, startNext, paused: () => paused }
}

export function createQueueEngine(deps: QueueEngineDeps): QueueEngine {
  const { store } = deps
  const checkListeners = new Set<() => void>()
  const tell = (): void => { for (const listener of checkListeners) listener() }
  let preparingId: string | null = null
  const land = createLand(deps)
  const { fail, settle, startNext, paused } = queueSteps(deps, land, (id) => { preparingId = id; tell() }, () => { void kick().catch(error => console.error('queue resume failed', error)) }, () => tell())
  let lane: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = lane.then(work)
    lane = result.catch(error => console.error('queue step failed', error))
    return result
  }

  function kick(): Promise<void> {
    return serial(startNext)
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

  const runningInStudio = (item: QueueItem): boolean => {
    const lastRunId = item.runIds.at(-1)
    const run = lastRunId === undefined ? undefined : deps.runner.get(lastRunId)
    return run !== undefined && !SETTLED.has(run.status)
  }

  const requeue = (id: string, options: RequeueOptions = {}): Promise<QueueItem> => serial(async () => {
    const item = found(store, id)
    if (!REQUEUEABLE.has(item.state)) throw stateRefusal(item.state)
    if (runningInStudio(item)) throw new QueueRefusal('It is running in Studio now', 409)
    const resumeRunId = item.state === 'failed' && options.fresh !== true ? item.resumeRunId : undefined
    await store.update(id, { state: 'queued', error: null, currentRunId: null, pick: undefined, land: undefined, questions: [], repoReruns: item.repoReruns === undefined ? undefined : 0, realChanged: item.realChanged === undefined ? undefined : [], resumeRunId })
    await store.move(id, store.list().length)
    await startNext()
    return found(store, id)
  })

  const pick = (id: string, choice: PickChoice): Promise<QueueItem> => serial(async () => {
    const item = found(store, id)
    if (item.state !== 'waiting-pick' || item.pick === undefined) throw stateRefusal(item.state)
    if (runningInStudio(item)) throw new QueueRefusal('It is running in Studio now', 409)
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
    await startNext()
    return found(store, id)
  })

  const remove = (id: string): Promise<void> => serial(async () => {
    const { state } = found(store, id)
    if (state === 'building' || state === 'landing') throw stateRefusal(state)
    await store.remove(id)
    await dropAnswerBackups(deps.backupDir(id)).catch(error => console.error('queue answer backups not removed', error))
  })

  const move = (id: string, to: number): Promise<void> => serial(async () => {
    const item = found(store, id)
    if (item.state !== 'queued') throw stateRefusal(item.state)
    await store.move(id, to)
  })

  const replies = replyCheck(deps, fail)
  const stillWaiting = (read: QueueItem): { item: QueueItem; worktree: string } | undefined => {
    const item = store.get(read.id)
    if (item?.state !== 'waiting-info' || item.lastSeenId !== read.lastSeenId || item.worktree === null || runningInStudio(item)) return undefined
    return { item, worktree: item.worktree }
  }

  let lastCheckedAt: number | null = null
  const markChecked = (): void => {
    lastCheckedAt = (deps.now ?? Date.now)()
    tell()
  }

  const checkReplies = async (): Promise<{ checked: number; resumed: number }> => {
    const waiting = store.list().filter(item => item.state === 'waiting-info' && item.worktree !== null)
    const reads = await Promise.allSettled(waiting.map(item => runningInStudio(item) ? Promise.resolve(null) : replies.read(item)))
    return serial(async () => {
      let resumed = 0
      for (const [index, read] of reads.entries()) {
        const current = stillWaiting(waiting[index]!)
        if (read.status !== 'fulfilled' || read.value === null || current === undefined) continue
        if (await replies.apply(current.item, current.worktree, read.value)) resumed += 1
      }
      await startNext()
      return { checked: waiting.length, resumed }
    }).then((counts) => { markChecked(); return counts })
  }

  async function recover(): Promise<void> {
    await serial(async () => {
      for (const item of store.list().filter(entry => entry.state === 'building')) {
        const run = item.currentRunId === null ? undefined : deps.runner.get(item.currentRunId)
        if (run === undefined) await fail(item, 'Its run is gone')
        else if (SETTLED.has(run.status)) await settle(run)
      }
      await land.recover()
      await startNext()
    })
  }

  return {
    add,
    requeue,
    pick,
    remove,
    move,
    recover,
    kick,
    startStage: (id, stage) => serial(() => land.startStage(id, stage)),
    refreshPreflight: (id, stage) => serial(() => land.refreshPreflight(id, stage)),
    retryStage: id => serial(() => land.retryStage(id)),
    landIdle: land.idle,
    landLog: land.log,
    report: async id => buildReport(found(store, id), runId => deps.runner.get(runId)),
    onRunSettled: run => serial(async () => { await settle(run); await startNext() }),
    checkReplies,
    checkedAt: () => lastCheckedAt,
    preparing: () => preparingId,
    paused,
    subscribeChecks: (listener) => { checkListeners.add(listener); return () => { checkListeners.delete(listener) } },
  }
}
