import { closeSync, openSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'

import { readLogTail } from './jobs'
import { logSecrets, redactAll } from './log-redaction'
import { getSetting } from './plugins/settings'
import { getInstalled } from './plugins/store'
import { QueueRefusal } from './queue-refusal'
import { message } from './queue-replies'
import type { QueueSource } from './queue-source'
import type { LandProgress, LandStageState, QueueItem, QueueStore } from './queue-store'
import { configDir } from './secrets'
import type { LandStage } from './workflows'

const MAX_MARKDOWN = 64 * 1024
const TAIL_LINES = 40
const KILL_GRACE_MS = 10_000
const PREFLIGHT_FAILED = 1
const SPAWN_FAILED = 127
const TIMED_OUT = 124

export const PICK_FILE = /(^|-)pick\.md$/
export const LOG_BYTES = 256 * 1024
export const landDirOf = (worktree: string): string => join(worktree, '.mission-control', 'land')
export async function readRegularFile(path: string): Promise<string | undefined> {
  try {
    if (!(await lstat(path)).isFile()) return undefined
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export const landLogPath = (itemId: string, stage: string): string => join(configDir(), 'queue-land', itemId, `${stage}.log`)

const postFile = z.object({
  post: z.object({
    kind: z.literal('update'),
    lines: z.array(z.string().max(2000)).min(1).max(20),
    mention: z.string().max(200).optional(),
    status: z.string().max(100).optional(),
  }).optional(),
})

export type LandDeps = {
  store: QueueStore
  source(pluginId: string): QueueSource
  needsYou(item: QueueItem, reason: string): void
  now?: () => number
}

type Spawned = { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string; startError?: string }

type Command = LandStage['command']

const lastLines = (text: string): string => text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n')

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal) } catch { /* the group is already gone */ }
}

async function spawnCommand(command: Command, options: { cwd: string; env: Record<string, string>; logFile?: string }): Promise<Spawned> {
  const fd = options.logFile === undefined ? undefined : openSync(options.logFile, 'w', 0o600)
  try {
    if (options.logFile !== undefined) await chmod(options.logFile, 0o600)
    const proc = Bun.spawn([command.command, ...command.args], {
      cwd: options.cwd, env: options.env, detached: true, stdin: 'ignore',
      stdout: fd ?? 'pipe', stderr: fd ?? 'pipe',
    })
    let timedOut = false
    let killer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(proc.pid, 'SIGTERM')
      killer = setTimeout(() => killGroup(proc.pid, 'SIGKILL'), KILL_GRACE_MS)
    }, command.timeoutSeconds * 1000)
    const pipes = fd === undefined
      ? Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()])
      : Promise.resolve(['', ''])
    const exitCode = await proc.exited
    clearTimeout(timer)
    clearTimeout(killer)
    killGroup(proc.pid, 'SIGKILL')
    const [stdout, stderr] = await pipes
    return { exitCode, timedOut, stdout, stderr }
  } catch (error) {
    return { exitCode: null, timedOut: false, stdout: '', stderr: '', startError: message(error) }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function repoKeys(item: QueueItem): string[] {
  const keys = item.repos === undefined || item.repos.length === 0 ? [item.repo] : item.repos.map(name => `${item.repo}/${name}`)
  return [...new Set([item.repo, ...keys])].sort()
}

function repoMutex() {
  const tails = new Map<string, Promise<void>>()
  async function acquire(key: string): Promise<() => void> {
    const previous = tails.get(key) ?? Promise.resolve()
    let release = () => {}
    const mine = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => mine)
    tails.set(key, tail)
    await previous
    return () => { release(); if (tails.get(key) === tail) tails.delete(key) }
  }
  return {
    async hold<T>(keys: string[], onWait: () => Promise<void>, onAcquired: () => Promise<void>, work: () => Promise<T>): Promise<T> {
      const waited = keys.some(key => tails.has(key))
      if (waited) await onWait()
      const releases: Array<() => void> = []
      try {
        for (const key of keys) releases.push(await acquire(key))
        if (waited) await onAcquired()
        return await work()
      } finally {
        for (const release of releases.reverse()) release()
      }
    },
  }
}

export type Land = ReturnType<typeof createLand>

export function createLand(deps: LandDeps) {
  const { store } = deps
  const clock = deps.now ?? Date.now
  const locks = repoMutex()
  const inflight = new Set<Promise<unknown>>()

  const track = (work: Promise<unknown>): void => {
    const watched = work.catch(error => console.error('queue land step failed', error)).finally(() => { inflight.delete(watched) })
    inflight.add(watched)
  }

  function found(id: string): QueueItem {
    const item = store.get(id)
    if (item === undefined) throw new QueueRefusal(`No queue item ${id}`, 404)
    return item
  }

  function stageOf(item: QueueItem, name: string): LandStage {
    const stage = item.land?.plan.find(entry => entry.id === name)
    if (stage === undefined) throw new QueueRefusal(`No land stage ${name}`, 404)
    return stage
  }

  function progress(item: QueueItem, name: string, change?: Partial<LandStageState>, top: Partial<LandProgress> = {}): LandProgress {
    const { message: _cleared, ...land } = item.land!
    const stages = change === undefined ? land.stages : { ...land.stages, [name]: { status: 'waiting' as const, ...land.stages[name], ...change } }
    return { ...land, ...top, stages }
  }

  async function environment(item: QueueItem, stage: LandStage, name: string): Promise<Record<string, string>> {
    const worktree = item.worktree
    if (worktree === null) throw new Error('The item has no workspace')
    const landDir = landDirOf(worktree)
    await mkdir(landDir, { recursive: true, mode: 0o700 })
    await chmod(landDir, 0o700)
    const resolved: Record<string, string> = {}
    for (const [variable, reference] of Object.entries(stage.env)) {
      const key = reference.slice('setting:'.length)
      const plugin = item.land?.plugin
      if (plugin === undefined) throw new Error('Setting references need a plugin flow')
      const declared = (await getInstalled(plugin))?.settingsFields.some(field => field.key === key)
      if (declared !== true) throw new Error(`Setting ${key} is not declared by ${plugin}`)
      resolved[variable] = (await getSetting(plugin, key)) ?? ''
    }
    const repos = item.repos === undefined || item.repos.length === 0 ? [basename(item.repo)] : item.repos
    return {
      ...(process.env as Record<string, string>),
      SKD_ITEM_ID: item.id, SKD_WORKSPACE: worktree, SKD_REPOS: repos.join(','), SKD_REPO_ROOT: item.repo,
      SKD_ITEM_URL: item.url, SKD_RUN_ID: item.runIds.at(-1) ?? '', SKD_STAGE: name, SKD_LAND_DIR: landDir,
      SKD_PICK_FILE: item.answerPaths.findLast(path => PICK_FILE.test(basename(path))) ?? '',
      ...resolved,
    }
  }

  async function redactForStage(item: QueueItem, name: string, text: string): Promise<string> {
    const plugin = item.land?.plugin
    const refs = Object.values(stageOf(item, name).env)
    const settings = plugin === undefined ? [] : await Promise.all(refs.map(ref => getSetting(plugin, ref.slice('setting:'.length)).catch(() => null)))
    return redactAll(text, [...(await logSecrets()), ...settings])
  }

  async function fail(id: string, reason: string, stage: string, change?: Partial<LandStageState>): Promise<void> {
    const item = found(id)
    const failed = await store.update(id, { state: 'failed', error: reason, land: progress(item, stage, change, { stage }) })
    deps.needsYou(failed, reason.split('\n')[0]!)
  }

  async function runPreflight(item: QueueItem, name: string): Promise<{ exitCode: number; markdown: string }> {
    const preflight = stageOf(item, name).preflight
    if (preflight === undefined) return { exitCode: 0, markdown: '' }
    let env: Record<string, string>
    try { env = await environment(item, stageOf(item, name), name) } catch (error) { return { exitCode: PREFLIGHT_FAILED, markdown: message(error) } }
    const result = await spawnCommand(preflight, { cwd: item.worktree!, env })
    if (result.startError !== undefined) return { exitCode: SPAWN_FAILED, markdown: `Could not start the preflight: ${result.startError}` }
    if (result.timedOut) return { exitCode: TIMED_OUT, markdown: `The preflight timed out after ${preflight.timeoutSeconds}s.` }
    const text = result.exitCode !== 0 && result.stdout.trim() === '' ? result.stderr : result.stdout
    return { exitCode: result.exitCode ?? PREFLIGHT_FAILED, markdown: (await redactForStage(item, name, text)).slice(0, MAX_MARKDOWN) }
  }

  async function awaitButton(id: string, name: string): Promise<void> {
    const item = found(id)
    const preflight = await runPreflight(item, name)
    const waiting = await store.update(id, { state: 'awaiting-stage', error: null, land: progress(found(id), name, { status: 'waiting', preflight }, { stage: name }) })
    deps.needsYou(waiting, `${stageOf(waiting, name).label ?? name} is ready`)
  }

  async function enter(id: string, name: string): Promise<void> {
    if (stageOf(found(id), name).run === 'button') return awaitButton(id, name)
    await begin(id, name)
  }

  async function begin(id: string, name: string): Promise<void> {
    const item = found(id)
    await store.update(id, { state: 'landing', error: null, land: progress(item, name, { status: 'running', startedAt: clock() }, { stage: name }) })
    track(execute(id, name))
  }

  async function advance(id: string, name: string): Promise<void> {
    const item = found(id)
    const plan = item.land!.plan
    const next = plan[plan.findIndex(entry => entry.id === name) + 1]
    if (next !== undefined) return enter(id, next.id)
    const landed = await store.update(id, { state: 'landed', error: null, land: progress(item, name, undefined, { stage: name }) })
    deps.needsYou(landed, 'Landed')
  }

  async function readPost(item: QueueItem, name: string): Promise<z.infer<typeof postFile>['post']> {
    const raw = await readRegularFile(join(landDirOf(item.worktree!), `${name}.json`))
    if (raw === undefined) return undefined
    const parsed = postFile.safeParse(JSON.parse(raw))
    if (!parsed.success) throw new Error(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
    return parsed.data.post
  }

  async function finish(id: string, name: string): Promise<void> {
    const item = found(id)
    let post: Awaited<ReturnType<typeof readPost>>
    try { post = await readPost(item, name) } catch (error) { return fail(id, `Bad ${name}.json: ${message(error)}`, name) }
    if (post !== undefined && item.land!.stages[name]?.posted === undefined) {
      try {
        const sent = await deps.source(item.source).post({ id: item.externalId, kind: 'update', lines: post.lines, ...(post.mention === undefined ? {} : { mention: post.mention }), ...(post.status === undefined ? {} : { status: post.status }) })
        await store.update(id, { land: progress(found(id), name, { posted: sent.commentId }) })
      } catch (error) {
        return fail(id, `${name} ran but posting failed: ${message(error)}`, name)
      }
    }
    await advance(id, name)
  }

  async function execute(id: string, name: string): Promise<void> {
    try {
      const item = found(id)
      const stage = stageOf(item, name)
      const env = await environment(item, stage, name)
      const logFile = landLogPath(id, name)
      for (const extension of ['json', 'md']) await rm(join(landDirOf(item.worktree!), `${name}.${extension}`), { force: true })
      await mkdir(join(configDir(), 'queue-land', id), { recursive: true, mode: 0o700 })
      const keys = repoKeys(item)
      const setMessage = (text: string | null) => async () => { await store.update(id, { land: text === null ? progress(found(id), name) : progress(found(id), name, undefined, { message: text }) }) }
      const result = await locks.hold(keys, setMessage(`waiting for another item to finish ${name}`), setMessage(null), () => spawnCommand(stage.command, { cwd: item.worktree!, env, logFile }))
      const log = await redactForStage(found(id), name, (await readLogTail(logFile, LOG_BYTES)).content)
      const ended = { endedAt: clock(), exitCode: result.exitCode }
      if (result.startError !== undefined) return await fail(id, `${name} failed to start: ${result.startError}`, name, { ...ended, status: 'failed' })
      if (result.timedOut) return await fail(id, `${name} failed (timed out after ${stage.command.timeoutSeconds}s)\n${lastLines(log)}`, name, { ...ended, status: 'failed' })
      if (result.exitCode !== 0) return await fail(id, `${name} failed (exit ${result.exitCode})\n${lastLines(log)}`, name, { ...ended, status: 'failed' })
      await store.update(id, { land: progress(found(id), name, { ...ended, status: 'ok' }) })
      await finish(id, name)
    } catch (error) {
      await fail(id, `${name} failed: ${message(error)}`, name, { status: 'failed' })
    }
  }

  function waitingFor(item: QueueItem, name: string): void {
    if (item.state !== 'awaiting-stage') throw new QueueRefusal(`It is ${item.state} now`, 409)
    if (item.land?.stage !== name) throw new QueueRefusal(`It is not waiting for ${name}`, 409)
  }

  async function storePreflight(id: string, name: string, preflight: { exitCode: number; markdown: string }): Promise<QueueItem> {
    return store.update(id, { land: progress(found(id), name, { status: 'waiting', preflight }) })
  }

  return {
    async begin(item: QueueItem, plan: LandStage[], plugin?: string): Promise<void> {
      const runId = item.runIds.at(-1)
      const land: LandProgress = { stage: plan[0]!.id, stages: {}, plan, ...(plugin === undefined ? {} : { plugin }), ...(runId === undefined ? {} : { runId }) }
      await store.update(item.id, { currentRunId: null, error: null, questions: [], land })
      await enter(item.id, plan[0]!.id)
    },

    async startStage(id: string, name: string): Promise<QueueItem> {
      const item = found(id)
      waitingFor(item, name)
      stageOf(item, name)
      const stored = item.land!.stages[name]?.preflight ?? { exitCode: 0, markdown: '' }
      if (stored.exitCode !== 0) throw new QueueRefusal('Preflight blocked this stage', 409)
      const again = await runPreflight(item, name)
      if (again.exitCode !== stored.exitCode || again.markdown !== stored.markdown) {
        await storePreflight(id, name, again)
        throw new QueueRefusal('Preflight changed, review it again', 409)
      }
      await begin(id, name)
      return found(id)
    },

    async refreshPreflight(id: string, name: string): Promise<QueueItem> {
      const item = found(id)
      waitingFor(item, name)
      stageOf(item, name)
      return storePreflight(id, name, await runPreflight(item, name))
    },

    async retryStage(id: string): Promise<QueueItem> {
      const item = found(id)
      const name = item.land?.stage
      if (item.state !== 'failed' || name === undefined) throw new QueueRefusal('There is no stage to retry', 409)
      if (item.land!.runId !== item.runIds.at(-1)) throw new QueueRefusal('This item was rebuilt since that stage; it lands again after a passing run', 409)
      if (item.land!.stages[name]?.status !== 'ok') {
        if (stageOf(item, name).run === 'button') await awaitButton(id, name)
        else await begin(id, name)
        return found(id)
      }
      const posting = await store.update(id, { state: 'landing', error: null, land: progress(item, name) })
      track(finish(id, name))
      return posting
    },

    async recover(): Promise<void> {
      for (const item of store.list().filter(entry => entry.state === 'landing' && entry.land !== undefined)) {
        const name = item.land!.stage
        const running = item.land!.stages[name]?.status === 'running'
        await fail(item.id, `Shikidan restarted during ${name}; use Retry stage`, name, running ? { status: 'failed' } : undefined)
      }
    },

    async log(id: string, name: string): Promise<string> {
      stageOf(found(id), name)
      const path = landLogPath(id, name)
      try { await stat(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new QueueRefusal('No log yet', 404)
        throw error
      }
      return redactForStage(found(id), name, (await readLogTail(path, LOG_BYTES)).content)
    },

    async idle(): Promise<void> {
      while (inflight.size > 0) await Promise.all([...inflight])
    },
  }
}
