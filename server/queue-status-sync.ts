import type { QueueSource } from './queue-source'
import type { QueueItem, QueueState, QueueStore } from './queue-store'
import { desiredStatus, type SourceStatusMap, type StatusRun } from './queue-status'

export const SYNC_RETRY_MS: readonly number[] = [10_000, 60_000, 300_000]
export const MAX_STATUS_CALLS = 4
const SENT_ON_FIRST_PASS = new Set<QueueState>(['queued', 'building'])

export type StatusSyncDeps = {
  store: QueueStore
  run(id: string): StatusRun | undefined
  map(flowId: string | null): Promise<SourceStatusMap>
  source(pluginId: string): Pick<QueueSource, 'status'>
  onSynced(item: QueueItem): void
  onFailed(item: QueueItem, status: string, error: unknown): void
  schedule?(retry: () => Promise<void>, ms: number): () => void
}

export type StatusSync = { reconcile(): Promise<void> }

type Retry = { status: string; failures: number; due: boolean; cancel: () => void }
type MapOf = (flowId: string | null) => Promise<SourceStatusMap>
type Limit = <T>(work: () => Promise<T>) => Promise<T>
type Pass = { mapOf: MapOf; limit: Limit; adopt: boolean }

function limiter(max: number): Limit {
  let active = 0
  const waiting: Array<() => void> = []
  return async work => {
    if (active < max) active += 1
    else await new Promise<void>(resolve => waiting.push(resolve))
    try {
      return await work()
    } finally {
      const next = waiting.shift()
      if (next === undefined) active -= 1
      else next()
    }
  }
}

function timer(retry: () => Promise<void>, ms: number): () => void {
  const handle = setTimeout(() => { void retry().catch(error => console.error('Status sync retry failed', error)) }, ms)
  handle.unref()
  return () => clearTimeout(handle)
}

export function createStatusSync(deps: StatusSyncDeps): StatusSync {
  const schedule = deps.schedule ?? timer
  const busy = new Set<string>()
  const retries = new Map<string, Retry>()
  const gaveUp = new Map<string, string>()
  let firstPass = true

  function forget(id: string): false {
    retries.get(id)?.cancel()
    retries.delete(id)
    gaveUp.delete(id)
    return false
  }

  function failed(item: QueueItem, status: string, failures: number, error: unknown): void {
    if (failures > SYNC_RETRY_MS.length) {
      gaveUp.set(item.id, status)
      deps.onFailed(item, status, error)
      return
    }
    const due = () => {
      const pending = retries.get(item.id)
      if (pending !== undefined) pending.due = true
      return reconcile()
    }
    retries.set(item.id, { status, failures, due: false, cancel: schedule(due, SYNC_RETRY_MS[failures - 1]!) })
  }

  const saveSynced = (id: string, status: string): Promise<unknown> =>
    deps.store.update(id, { syncedStatus: status }, { touch: false }).catch(error => console.error('Queue status save failed', error))

  async function send(id: string, pass: Pass): Promise<boolean> {
    const flowId = deps.store.get(id)?.flowId
    if (flowId === undefined) return forget(id)
    const map = await pass.mapOf(flowId)
    const item = deps.store.get(id)
    if (item === undefined) return forget(id)
    const run = item.state === 'building' && item.currentRunId !== null ? deps.run(item.currentRunId) : undefined
    const desired = desiredStatus(item, run, map)
    if (pass.adopt && item.syncedStatus === undefined && !SENT_ON_FIRST_PASS.has(item.state)) {
      if (desired !== null) await saveSynced(id, desired)
      return false
    }
    const retry = retries.get(id)
    if (retry !== undefined && retry.status === desired && !retry.due) return false
    retry?.cancel()
    retries.delete(id)
    const settled = desired === null || desired === item.syncedStatus
    if (gaveUp.has(id) && (settled || gaveUp.get(id) !== desired)) {
      gaveUp.delete(id)
      if (settled) deps.onSynced(item)
    }
    if (settled || gaveUp.has(id)) return false
    try {
      await pass.limit(() => deps.source(item.source).status({ id: item.externalId, status: desired }))
    } catch (error) {
      failed(item, desired, (retry?.status === desired ? retry.failures : 0) + 1, error)
      return true
    }
    if (deps.store.get(id) === undefined) return true
    await saveSynced(id, desired)
    deps.onSynced(item)
    return true
  }

  async function syncItem(id: string, pass: Pass): Promise<void> {
    if (busy.has(id)) return
    busy.add(id)
    let called = false
    try {
      called = await send(id, pass)
    } finally {
      busy.delete(id)
    }
    // reconciles skipped while this call was in flight may have missed a change
    if (called) await reconcile()
  }

  function reconcile(): Promise<void> {
    const lookups = new Map<string | null, Promise<SourceStatusMap>>()
    const mapOf: MapOf = flowId => {
      const known = lookups.get(flowId)
      if (known !== undefined) return known
      const looked = deps.map(flowId)
      lookups.set(flowId, looked)
      return looked
    }
    const pass: Pass = { mapOf, limit: limiter(MAX_STATUS_CALLS), adopt: firstPass }
    firstPass = false
    return Promise.all(deps.store.list().map(item => syncItem(item.id, pass))).then(() => {
      const live = new Set(deps.store.list().map(item => item.id))
      for (const id of new Set([...retries.keys(), ...gaveUp.keys()])) if (!live.has(id)) forget(id)
    })
  }

  return { reconcile }
}
