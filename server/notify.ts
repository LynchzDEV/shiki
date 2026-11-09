import { readFileSync } from 'node:fs'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'

import type { FetchLike } from './quota'
import { configDir } from './secrets'
import type { QueueState } from './queue-store'
import type { RunStatus } from './workflow-runner'
import { atomicJson } from './workflows'

export const NOTIFY_OUTBOX_FILE = 'notify-outbox.json'
export const RETRY_LADDER_MS = [10_000, 60_000, 300_000, 1_800_000]
export const MAX_DETAIL = 2000
export const REQUEST_TIMEOUT_MS = 30_000
const MAX_FINGERPRINTS = 500
export const MAX_PENDING = 200
export const MAX_MOCKUP_BYTES = 5 * 1024 * 1024

export type NotifyEventName = 'pick' | 'question' | 'failed' | 'stage-ready' | 'ready' | 'landed' | 'blocked' | 'permission' | 'slow' | 'sync-failed' | 'picked' | 'pick-unclear' | 'publish-failed'

export type ImageRef = { option: string; root: string; relative: string }

export type NotifyMockup = { option: string; name: string; mime: 'image/png'; base64: string }

export type NotifyEvent = {
  eventId: string; event: NotifyEventName; at: string
  queueItemId: string | null; runId: string | null; taskId: string | null; taskUrl: string | null; title: string
  node: string | null; itemState: QueueState | null; runStatus: RunStatus | null; clickupStatus: string | null
  detail: string; questions: string[]; options: string[]; recommended: string | null
  mockups: NotifyMockup[]
  landStage: string | null
  host: string | null; owner: string | null; pickedBy: string | null
}

export type NotifyInput = {
  event: NotifyEventName
  fingerprintKey: string
  fingerprint?: string
  title: string
  queueItemId?: string | null; runId?: string | null; taskId?: string | null; taskUrl?: string | null
  node?: string | null; itemState?: QueueState | null; runStatus?: RunStatus | null; clickupStatus?: string | null
  detail?: string; questions?: string[]; options?: string[]; recommended?: string | null
  mockups?: ImageRef[]
  landStage?: string | null
  host?: string | null; owner?: string | null; pickedBy?: string | null
}

export type SendResult = { ok: true; status: number } | { ok: false; status: number | null; error?: string }

type Pending = { event: Omit<NotifyEvent, 'mockups'>; images: ImageRef[]; attempts: number }
type Outbox = { pending: Pending[]; last: Record<string, string>; dropped: number }

export type NotifyDeps = {
  path?: string
  config: () => Promise<{ url: string | null; key: string | null }>
  fetch?: FetchLike
  schedule?: (run: () => void, ms: number) => void
  now?: () => Date
  newId?: () => string
  readImage?: (root: string, relative: string) => Promise<Buffer | null>
  timeoutMs?: number
}

export type Notifier = {
  emit(input: NotifyInput): Promise<void>
  send(input: NotifyInput, extra?: NotifyMockup[]): Promise<SendResult>
  pending(): number
  resume(): Promise<void>
  drain(): Promise<void>
  clear(): Promise<void>
  dropped(): number
}

export function notifyOutboxPath(): string {
  return join(configDir(), NOTIFY_OUTBOX_FILE)
}

export async function readContainedImage(root: string, relative: string): Promise<Buffer | null> {
  try {
    const realRoot = await realpath(root)
    const real = await realpath(join(realRoot, relative))
    if (!real.startsWith(realRoot + sep) || (await stat(real)).size > MAX_MOCKUP_BYTES) return null
    return await readFile(real)
  } catch {
    return null
  }
}

function defaultSchedule(run: () => void, ms: number): void {
  setTimeout(run, ms).unref()
}

function isPending(value: unknown): value is Pending {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<Pending>
  return typeof entry.event?.eventId === 'string' && Array.isArray(entry.images) && typeof entry.attempts === 'number'
}

function load(path: string): Outbox {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Outbox>
    const last = typeof parsed.last === 'object' && parsed.last !== null && !Array.isArray(parsed.last) ? parsed.last : {}
    return { pending: Array.isArray(parsed.pending) ? parsed.pending.filter(isPending) : [], last, dropped: typeof parsed.dropped === 'number' ? parsed.dropped : 0 }
  } catch {
    return { pending: [], last: {}, dropped: 0 }
  }
}

export function createNotifier(deps: NotifyDeps): Notifier {
  const path = deps.path ?? notifyOutboxPath()
  const send = deps.fetch ?? fetch
  const schedule = deps.schedule ?? defaultSchedule
  const now = deps.now ?? (() => new Date())
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const readImage = deps.readImage ?? readContainedImage
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS
  const outbox = load(path)
  const inflight = new Map<string, Promise<void>>()
  const scheduled = new Set<string>()
  let writing: Promise<void> = Promise.resolve()

  const save = (): Promise<void> => {
    const snapshot = structuredClone(outbox)
    writing = writing.then(async () => {
      await mkdir(dirname(path), { recursive: true })
      await atomicJson(path, snapshot)
    }).catch(error => console.error('Notify outbox write failed', error))
    return writing
  }

  async function body(event: Omit<NotifyEvent, 'mockups'>, images: ImageRef[], extra: NotifyMockup[]): Promise<NotifyEvent> {
    const read = await Promise.all(images.map(async image => ({ image, bytes: await readImage(image.root, image.relative) })))
    const mockups = read.flatMap(({ image, bytes }): NotifyMockup[] => bytes === null ? [] : [{ option: image.option, name: basename(image.relative), mime: 'image/png', base64: bytes.toString('base64') }])
    return { ...event, mockups: [...mockups, ...extra] }
  }

  async function post(event: Omit<NotifyEvent, 'mockups'>, images: ImageRef[], extra: NotifyMockup[] = []): Promise<SendResult> {
    const { url, key } = await deps.config()
    if (url === null) return { ok: false, status: null, error: 'no webhook url configured' }
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(key === null ? {} : { Authorization: `Bearer ${key}`, 'X-Automation-Key': key }) }
    try {
      const response = await send(url, { method: 'POST', headers, body: JSON.stringify(await body(event, images, extra)), signal: AbortSignal.timeout(timeoutMs) })
      return response.ok ? { ok: true, status: response.status } : { ok: false, status: response.status }
    } catch (error) {
      return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) }
    }
  }

  function build(input: NotifyInput): Omit<NotifyEvent, 'mockups'> {
    return {
      eventId: newId(), event: input.event, at: now().toISOString(),
      queueItemId: input.queueItemId ?? null, runId: input.runId ?? null, taskId: input.taskId ?? null, taskUrl: input.taskUrl ?? null, title: input.title,
      node: input.node ?? null, itemState: input.itemState ?? null, runStatus: input.runStatus ?? null, clickupStatus: input.clickupStatus ?? null,
      detail: (input.detail ?? '').slice(0, MAX_DETAIL), questions: input.questions ?? [], options: input.options ?? [], recommended: input.recommended ?? null,
      landStage: input.landStage ?? null,
      host: input.host ?? null, owner: input.owner ?? null, pickedBy: input.pickedBy ?? null,
    }
  }

  async function deliver(eventId: string): Promise<void> {
    const entry = outbox.pending.find(item => item.event.eventId === eventId)
    if (entry === undefined) return
    const result = await post(entry.event, entry.images)
    if (result.ok) {
      outbox.pending = outbox.pending.filter(item => item !== entry)
      await save()
      return
    }
    const delay = RETRY_LADDER_MS[Math.min(entry.attempts, RETRY_LADDER_MS.length - 1)]!
    entry.attempts += 1
    await save()
    scheduled.add(eventId)
    schedule(() => { scheduled.delete(eventId); void start(eventId) }, delay)
  }

  function start(eventId: string): Promise<void> {
    const running = inflight.get(eventId)
    if (running !== undefined) return running
    if (scheduled.has(eventId)) return Promise.resolve()
    const task = deliver(eventId).catch(error => console.error('Notify delivery failed', error)).finally(() => { inflight.delete(eventId) })
    inflight.set(eventId, task)
    return task
  }

  async function emit(input: NotifyInput): Promise<void> {
    const { url } = await deps.config()
    if (url === null) return
    const event = build(input)
    const fingerprint = input.fingerprint ?? `${event.itemState ?? ''}|${event.detail}`
    if (outbox.last[input.fingerprintKey] === fingerprint) return
    delete outbox.last[input.fingerprintKey]
    outbox.last[input.fingerprintKey] = fingerprint
    const keys = Object.keys(outbox.last)
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_FINGERPRINTS))) delete outbox.last[stale]
    outbox.pending.push({ event, images: input.mockups ?? [], attempts: 0 })
    const over = Math.max(0, outbox.pending.length - MAX_PENDING)
    outbox.pending.splice(0, over)
    outbox.dropped += over
    await save()
    void start(event.eventId)
  }

  return {
    emit,
    send: async (input, extra = []) => post(build(input), input.mockups ?? [], extra),
    pending: () => outbox.pending.length,
    resume: async () => { await Promise.all(outbox.pending.map(entry => start(entry.event.eventId))) },
    drain: async () => { await Promise.all([...inflight.values()]); await writing },
    clear: async () => { outbox.pending = []; await save() },
    dropped: () => outbox.dropped,
  }
}
