import { join } from 'node:path'

import type { JobRecord } from './jobs'
import type { ImageRef, Notifier, NotifyEventName, NotifyInput, NotifyMockup } from './notify'
import type { PickReplyEvent } from './queue-pick-ask'
import type { QueueItem, QueueState } from './queue-store'
import type { WorkflowRun } from './workflow-runner'

export const QUEUE_EVENT: Partial<Record<QueueState, NotifyEventName>> = {
  'waiting-pick': 'pick',
  'waiting-info': 'question',
  failed: 'failed',
  'awaiting-stage': 'stage-ready',
  ready: 'ready',
  landed: 'landed',
}

type RunView = Pick<WorkflowRun, 'id' | 'status' | 'currentNodeId' | 'error' | 'attempts'>
type JobView = Pick<JobRecord, 'id' | 'label' | 'turns' | 'startedAt' | 'slowAt'> & { workflowRunId?: string }

export type NotifyEventsDeps = {
  notifier: Pick<Notifier, 'emit'>
  items: () => QueueItem[]
  run: (id: string) => RunView | undefined
}

export function itemOfRun(items: QueueItem[], runId: string): QueueItem | undefined {
  return items.find(item => item.currentRunId === runId || item.runIds.includes(runId) || item.recoverBuild?.recoveryRunId === runId || item.land?.recover?.runId === runId)
}

const clickupStatusOf = (item: QueueItem): string | null => item.syncedStatus ?? null

function mockupsOf(item: QueueItem): ImageRef[] {
  if (item.pick === undefined || item.worktree === null) return []
  const { path } = item.pick
  const root = item.worktree
  return item.pick.options.map(option => ({ option, root, relative: join(path, 'renders', `${option.toLowerCase()}.png`) }))
}

function itemFields(item: QueueItem, run: RunView | undefined) {
  return {
    queueItemId: item.id, runId: run?.id ?? item.currentRunId, taskId: item.externalId, taskUrl: item.url, title: item.title,
    node: run?.currentNodeId ?? null, itemState: item.state, runStatus: run?.status ?? null, clickupStatus: clickupStatusOf(item),
  }
}

const queueEvent = (item: QueueItem): NotifyEventName | undefined =>
  item.state === 'waiting-pick' && item.pick?.ask?.error !== undefined ? 'publish-failed' : QUEUE_EVENT[item.state]

export function queueInput(item: QueueItem, reason: string, run: RunView | undefined): NotifyInput | null {
  const event = queueEvent(item)
  if (event === undefined) return null
  const questions = item.state === 'waiting-info' ? item.questions : []
  const options = item.pick?.options ?? []
  const land = item.land
  const fingerprint = JSON.stringify([item.state, reason, questions, options, item.runIds.length, run?.attempts.length ?? 0, land?.stage ?? null, land?.stages[land.stage]?.startedAt ?? null])
  return {
    ...itemFields(item, run), event, fingerprintKey: `${item.id}:queue`, fingerprint, detail: reason,
    questions, options, recommended: item.pick?.recommended ?? null,
    mockups: item.state === 'waiting-pick' ? mockupsOf(item) : [],
    landStage: item.land?.stage ?? null,
    host: item.pick?.ask?.host ?? null, owner: item.pick?.ask?.ownerName || null,
  }
}

export function blockedInput(item: QueueItem, run: RunView): NotifyInput {
  return { ...itemFields(item, run), event: 'blocked', fingerprintKey: `${item.id}:${run.id}:blocked:${run.attempts.length}`, detail: run.error ?? '', landStage: item.land?.stage ?? null }
}

export function jobInput(event: 'permission' | 'slow', record: JobView, key: string, detail: string, item: QueueItem | undefined, run: RunView | undefined): NotifyInput {
  if (item === undefined) return { event, fingerprintKey: key, title: record.label, runId: record.workflowRunId ?? null, detail }
  return { ...itemFields(item, run), event, fingerprintKey: key, title: record.label, runId: record.workflowRunId ?? null, detail }
}

export function createNotifyEvents(deps: NotifyEventsDeps) {
  const emit = (input: NotifyInput | null): void => {
    if (input !== null) void deps.notifier.emit(input).catch(error => console.error('Notify failed', error))
  }
  const ofJob = (record: JobView) => {
    const item = record.workflowRunId === undefined ? undefined : itemOfRun(deps.items(), record.workflowRunId)
    return { item, run: record.workflowRunId === undefined ? undefined : deps.run(record.workflowRunId) }
  }
  return {
    queue: (item: QueueItem, reason: string): void => {
      const runId = item.currentRunId ?? item.runIds.at(-1)
      emit(queueInput(item, reason, runId === undefined ? undefined : deps.run(runId)))
    },
    runSettled: (run: RunView): void => {
      if (run.status !== 'blocked' && run.status !== 'failed') return
      const item = itemOfRun(deps.items(), run.id)
      if (item !== undefined) emit(blockedInput(item, run))
    },
    permission: (record: JobView, request: { requestId: string; title: string }): void => {
      const { item, run } = ofJob(record)
      emit(jobInput('permission', record, `${record.id}:${request.requestId}:permission`, request.title, item, run))
    },
    slow: (record: JobView): void => {
      const { item, run } = ofJob(record)
      const minutes = Math.floor(((record.slowAt ?? Date.now()) - record.startedAt) / 60_000)
      emit(jobInput('slow', record, `${record.id}:slow`, `May be stuck: ${record.turns} turns in ${minutes} min`, item, run))
    },
    pickReply: (item: QueueItem, reply: PickReplyEvent): void => {
      const detail = reply.event === 'picked' ? reply.option : reply.text
      emit({ ...itemFields(item, undefined), event: reply.event, fingerprintKey: `${item.id}:${reply.event}:${reply.replyId}`, detail, pickedBy: reply.by, host: item.pick?.ask?.host ?? item.published?.host ?? null, owner: item.pick?.ask?.ownerName || null })
    },
    syncFailed: (item: QueueItem, status: string, error: string): void => {
      emit({ ...itemFields(item, undefined), event: 'sync-failed', fingerprintKey: `${item.id}:sync-failed`, detail: `ClickUp status sync to ${status} failed: ${error}` })
    },
  }
}

export const SAMPLE_BLOB_BYTES = 800 * 1024
const SAMPLE_OPTIONS = ['A', 'B', 'C']

export function sampleEvent(items: QueueItem[]): { input: NotifyInput; extra: NotifyMockup[] } {
  const withPick = items.filter(item => item.pick !== undefined).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (withPick !== undefined) return { input: { ...queueInput({ ...withPick, state: 'waiting-pick' }, 'Test event from shiki notify test', undefined)!, fingerprintKey: 'test' }, extra: [] }
  const extra = SAMPLE_OPTIONS.map((option, index): NotifyMockup => ({ option, name: `${option.toLowerCase()}.png`, mime: 'image/png', base64: Buffer.alloc(SAMPLE_BLOB_BYTES, index + 1).toString('base64') }))
  return { input: { event: 'pick', fingerprintKey: 'test', title: 'Shikidan test event', itemState: 'waiting-pick', detail: 'Test event from shiki notify test', options: SAMPLE_OPTIONS, recommended: 'A' }, extra }
}

export type NotifyEvents = ReturnType<typeof createNotifyEvents>
