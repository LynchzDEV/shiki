import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  JOBS_FILE,
  LOGS_DIR,
  createJobManager,
  createLogRedactor,
  normalizeJobRecord,
  readLogSince,
  readLogTail,
  redactSecrets,
  validateJobCwd,
} from '../server/jobs'
import type { JobManager, JobRecord } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { configPath, writeSecrets } from '../server/secrets'
import { isOwnClaudeChild, parseUtcPsLine, readProcessInfo } from '../server/process-info'
import { initScratchGitRepo } from './support/scratch-git-repo'

let configDir: string
let testRoot: string
let home: string
let outside: string

const echoResolver: EngineResolver = ({ prompt }) => ({ cmd: 'echo', args: [prompt], env: {} })
const failResolver: EngineResolver = () => ({
  cmd: 'ls',
  args: ['/definitely-does-not-exist-shikidan-jobs-test'],
  env: {},
})
const sleepResolver: EngineResolver = () => ({ cmd: 'sleep', args: ['30'], env: {} })
const initGitRepo = initScratchGitRepo

async function waitForStatus(
  manager: JobManager,
  id: string,
  timeoutMs = 3000,
): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = manager.getJob(id)
    if (job !== undefined && job.status !== 'running') return job
    if (Date.now() > deadline) throw new Error(`job ${id} did not settle within ${timeoutMs}ms`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-jobs-config-'))
  process.env.SKD_CONFIG_DIR = configDir

  testRoot = await mkdtemp(join(tmpdir(), 'mc-jobs-root-'))
  home = join(testRoot, 'home')
  outside = join(testRoot, 'outside')
  await mkdir(home, { recursive: true })
  await mkdir(outside, { recursive: true })
})

afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(testRoot, { recursive: true, force: true })
})

describe('validateJobCwd', () => {
  test('rejects a directory that does not exist', async () => {
    const result = await validateJobCwd(join(home, 'nope'), home)
    expect(result.ok).toBe(false)
  })

  test('rejects an existing directory that is not a git repo', async () => {
    const plain = join(home, 'plain')
    await mkdir(plain, { recursive: true })
    const result = await validateJobCwd(plain, home)
    expect(result.ok).toBe(false)
  })

  test('rejects a git repo outside HOME', async () => {
    await initGitRepo(outside)
    const result = await validateJobCwd(outside, home)
    expect(result.ok).toBe(false)
  })

  test('rejects `..` traversal that escapes HOME', async () => {
    await initGitRepo(outside)
    const nested = join(home, 'nested')
    await mkdir(nested, { recursive: true })
    const traversal = join(nested, '..', '..', 'outside')
    const result = await validateJobCwd(traversal, home)
    expect(result.ok).toBe(false)
  })

  test('rejects a symlink under HOME that escapes to outside HOME', async () => {
    await initGitRepo(outside)
    const escapeLink = join(home, 'escape')
    await symlink(outside, escapeLink)
    const result = await validateJobCwd(escapeLink, home)
    expect(result.ok).toBe(false)
  })

  test('accepts a git repo under HOME', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const result = await validateJobCwd(repo, home)
    expect(result.ok).toBe(true)
  })
})

describe('job lifecycle', () => {
  test('only workflow step jobs are resolved as headless steps', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })
    const seen: Array<boolean | undefined> = []
    const recording: EngineResolver = ({ step, prompt }) => { seen.push(step); return { cmd: 'echo', args: [prompt], env: {} } }

    const plain = await manager.createJob({ engine: 'glm', cwd: repo, prompt: 'plain', label: 'plain' }, recording)
    if (plain.ok) await waitForStatus(manager, plain.job.id)
    const step = await manager.createJob({ engine: 'glm', cwd: repo, prompt: 'step', label: 'step', workflowRunId: 'run-1', workflowNodeId: 'execute', workflowAttempt: 0 }, recording)
    if (step.ok) await waitForStatus(manager, step.job.id)

    expect(seen).toEqual([undefined, true])
  })

  test('a resolver that throws keeps its real error after the engine resolver failed prefix', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })
    const throwing: EngineResolver = () => { throw new Error('glm engine requested but zaiAuthToken is not configured') }
    const result = await manager.createJob({ engine: 'glm', cwd: repo, prompt: 'hi', label: 'glm' }, throwing)
    expect(result).toEqual({ ok: false, status: 400, error: 'engine resolver failed: glm engine requested but zaiAuthToken is not configured' })
  })

  test('a job runs to completion and is recorded as done', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })

    const result = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'hello-world', label: 'smoke' },
      echoResolver,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.job.status).toBe('running')

    const finished = await waitForStatus(manager, result.job.id)
    expect(finished?.status).toBe('done')
    expect(finished?.exitCode).toBe(0)
    expect(finished?.endedAt).not.toBeNull()

    const log = await readFile(manager.logPath(result.job.id), 'utf8')
    expect(log).toContain('hello-world')

    const jsonl = await readFile(configPath(JOBS_FILE), 'utf8')
    const lines = jsonl.trim().split('\n').map((line) => JSON.parse(line))
    const lastRecordForJob = [...lines].reverse().find((record) => record.id === result.job.id)
    expect(lastRecordForJob.status).toBe('done')
  })

  test('a job that exits non-zero is recorded as failed with a null diffStat', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })

    const result = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'irrelevant', label: 'fail' },
      failResolver,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const finished = await waitForStatus(manager, result.job.id)
    expect(finished?.status).toBe('failed')
    expect(finished?.exitCode).not.toBe(0)
    expect(finished?.diffStat).toBeNull()
  })

  test('killJob sends SIGTERM and the job settles as failed', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })

    const result = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'irrelevant', label: 'kill-me' },
      sleepResolver,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const killResult = await manager.killJob(result.job.id)
    expect(killResult.ok).toBe(true)

    const finished = await waitForStatus(manager, result.job.id)
    expect(finished?.status).toBe('failed')
  })

  test('killJob reports an error for an id that is not running', async () => {
    const manager = createJobManager({ home })
    const result = await manager.killJob('does-not-exist')
    expect(result.ok).toBe(false)
  })

  test('diffStat captures an uncommitted change in the job cwd once the job is done', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    await writeFile(join(repo, 'README.md'), 'initial\nchanged\n')
    const manager = createJobManager({ home })

    const result = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'irrelevant', label: 'diff' },
      echoResolver,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const finished = await waitForStatus(manager, result.job.id)
    expect(finished?.status).toBe('done')
    expect(finished?.diffStat).not.toBeNull()
    expect(finished?.diffStat).toContain('README.md')
  })

  // The child writes its log raw (direct fd, so it survives a server restart); the guarantee
  // moved to serving time — redactSecrets is what every log-serving route applies.
  test('a token echoed into the raw log is stripped by the serving-time redaction', async () => {
    const TOKEN = 'super-secret-zai-token-abcdef123456'
    await writeSecrets({ zaiAuthToken: TOKEN })

    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })
    const echoTokenResolver: EngineResolver = () => ({
      cmd: 'echo',
      args: [`leaking ${TOKEN} in verbose output`],
      env: {},
    })

    const result = await manager.createJob(
      { engine: 'glm', cwd: repo, prompt: 'irrelevant', label: 'redact' },
      echoTokenResolver,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const finished = await waitForStatus(manager, result.job.id)
    expect(finished?.status).toBe('done')

    const raw = await readFile(manager.logPath(result.job.id), 'utf8')
    expect(raw).toContain(TOKEN)
    const served = redactSecrets(raw, TOKEN)
    expect(served).toContain('[REDACTED]')
    expect(served).not.toContain(TOKEN)
  })

  test('listJobs returns newest first, even for jobs started in the same millisecond', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const sameMillisecond = () => 1_700_000_000_000
    const manager = createJobManager({ home, now: sameMillisecond })

    const first = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'one', label: 'first' },
      echoResolver,
    )
    const second = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'two', label: 'second' },
      echoResolver,
    )
    if (!first.ok || !second.ok) throw new Error('expected both jobs to be created')

    await waitForStatus(manager, first.job.id)
    await waitForStatus(manager, second.job.id)

    const order = (jobs: JobRecord[]) => jobs.map((job) => job.id).filter((id) => id === first.job.id || id === second.job.id)
    expect(manager.getJob(first.job.id)!.startedAt).toBe(manager.getJob(second.job.id)!.startedAt)
    expect(order(manager.listJobs())).toEqual([second.job.id, first.job.id])
    expect(order(createJobManager({ home, now: sameMillisecond }).listJobs())).toEqual([second.job.id, first.job.id])
  })
})

describe('createLogRedactor', () => {
  const TOKEN = 'zai-token-1234567890'

  test('redacts a token fully contained within one chunk', () => {
    const redactor = createLogRedactor(TOKEN)
    const out = redactor.redact(`before ${TOKEN} after`) + redactor.flush()
    expect(out).toBe('before [REDACTED] after')
    expect(out).not.toContain(TOKEN)
  })

  test('redacts a token split across two chunk writes', () => {
    const redactor = createLogRedactor(TOKEN)
    const splitAt = Math.floor(TOKEN.length / 2)
    const first = redactor.redact(`before ${TOKEN.slice(0, splitAt)}`)
    const second = redactor.redact(`${TOKEN.slice(splitAt)} after`)
    const out = first + second + redactor.flush()
    expect(out).toBe('before [REDACTED] after')
    expect(out).not.toContain(TOKEN)
  })

  test('leaves a chunk with no token untouched', () => {
    const redactor = createLogRedactor(TOKEN)
    const text = 'nothing sensitive in this line\n'
    const out = redactor.redact(text) + redactor.flush()
    expect(out).toBe(text)
  })

  test('disables redaction when the secret is shorter than the minimum length', () => {
    const redactor = createLogRedactor('short1')
    const text = 'contains short1 verbatim'
    const out = redactor.redact(text) + redactor.flush()
    expect(out).toBe(text)
  })

  test('passes chunks through unchanged when no secret is configured', () => {
    const redactor = createLogRedactor(null)
    const text = 'anything goes here'
    const out = redactor.redact(text) + redactor.flush()
    expect(out).toBe(text)
  })
})

describe('log stream failures', () => {
  test('an unopenable log path refuses the job upfront instead of crashing the process', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })

    const fixedId = 'fixed-log-stream-error-id'
    const originalRandomUUID = crypto.randomUUID
    crypto.randomUUID = (() => fixedId) as typeof crypto.randomUUID
    try {
      await mkdir(join(configDir, LOGS_DIR, `${fixedId}.log`), { recursive: true })

      const result = await manager.createJob(
        { engine: 'claude', cwd: repo, prompt: 'irrelevant', label: 'log-error' },
        echoResolver,
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(500)
    } finally {
      crypto.randomUUID = originalRandomUUID
    }
  })
})

describe('jsonl reload', () => {
  test('compacts ten lines to the latest three jobs in first-seen order on startup', async () => {
    const ids = ['b', 'a', 'c', 'a', 'b', 'c', 'b', 'a', 'c', 'a']
    const records = ids.map((id, turns) => ({ id, status: 'done', turns, label: `turn ${turns}` }))
    const path = join(configDir, JOBS_FILE)
    await writeFile(path, records.map((record) => JSON.stringify(record) + '\n').join(''))
    await writeFile(`${path}.tmp`, 'stale temporary file', { mode: 0o644 })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const manager = createJobManager({ home })
      const saved = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      expect(saved.map((record) => record.id)).toEqual(['b', 'a', 'c'])
      expect(saved.map((record) => record.turns)).toEqual([6, 9, 8])
      expect(saved).toEqual(['b', 'a', 'c'].map((id) => manager.getJob(id)))
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(await Bun.file(`${path}.tmp`).exists()).toBe(false)
      expect(log).toHaveBeenCalledWith('jobs: compacted 10 lines → 3')
      expect(log).toHaveBeenCalledTimes(1)
    } finally {
      log.mockRestore()
    }
  })

  test('compacts queued runtime appends only after passing 5000 lines', async () => {
    const records = Array.from({ length: 4999 }, (_, index) => ({ id: `job-${index}`, status: 'done' }))
    const path = join(configDir, JOBS_FILE)
    await writeFile(path, records.map((record) => JSON.stringify(record) + '\n').join(''))
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const manager = createJobManager({ home })
      await manager.markReviewed('job-0', 10)
      expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(5000)
      expect(log).not.toHaveBeenCalled()
      await Promise.all([manager.markReviewed('job-1', 11), manager.markReviewed('job-2', 12)])
      const saved = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      expect(saved).toHaveLength(5000)
      expect(saved.slice(0, 4999).map((record) => record.id)).toEqual(records.map((record) => record.id))
      expect(saved[0].reviewedAt).toBe(10)
      expect(saved[1].reviewedAt).toBe(11)
      expect(saved.at(-1).id).toBe('job-2')
      expect(saved.at(-1).reviewedAt).toBe(12)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(log).toHaveBeenCalledWith('jobs: compacted 5001 lines → 4999')
      expect(log).toHaveBeenCalledTimes(1)
      await manager.markReviewed('job-3', 13)
      expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(4999)
      expect(log).toHaveBeenCalledTimes(2)
    } finally {
      log.mockRestore()
    }
  })

  test('a fresh manager instance loads jobs persisted by an earlier instance', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const first = createJobManager({ home })

    const result = await first.createJob(
      { engine: 'claude', cwd: repo, prompt: 'hello-again', label: 'reload' },
      echoResolver,
    )
    if (!result.ok) throw new Error('expected job to be created')
    await waitForStatus(first, result.job.id)

    const second = createJobManager({ home })
    const reloaded = second.getJob(result.job.id)
    expect(reloaded).toBeDefined()
    expect(reloaded?.status).toBe('done')
    expect(reloaded?.reviewedAt).toBeNull()
    expect(second.listJobs().some((job) => job.id === result.job.id)).toBe(true)
  })

  test('a running record whose pid is gone is adopted on boot and settled from its log', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)

    const gone = Bun.spawn(['/usr/bin/true'])
    await gone.exited

    const running = {
      id: 'adopted-1',
      engine: 'glm',
      cwd: repo,
      label: 'orphan',
      prompt: 'work',
      pid: gone.pid,
      status: 'running',
      startedAt: Date.now() - 60_000,
      endedAt: null,
      exitCode: null,
      diffStat: null,
      reviewedAt: null,
      sessionId: null,
      parentJobId: null,
      threadRoot: 'adopted-1',
      terminalId: null,
      reviewOf: null,
    }
    await mkdir(join(configDir, LOGS_DIR), { recursive: true })
    await writeFile(join(configDir, JOBS_FILE), `${JSON.stringify(running)}\n`)
    await writeFile(join(configDir, LOGS_DIR, 'adopted-1.log'), '{"type":"result","subtype":"success"}\n')

    const manager = createJobManager({ home })
    const settled = await waitForStatus(manager, 'adopted-1')
    expect(settled.status).toBe('done')
    expect(settled.exitCode).toBeNull()
  })

  test('a running record with no result marker in its log settles as failed on adoption', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)

    const gone = Bun.spawn(['/usr/bin/true'])
    await gone.exited

    const running = {
      id: 'adopted-2',
      engine: 'glm',
      cwd: repo,
      label: 'orphan-crashed',
      prompt: 'work',
      pid: gone.pid,
      status: 'running',
      startedAt: Date.now() - 60_000,
      endedAt: null,
      exitCode: null,
      diffStat: null,
      reviewedAt: null,
      sessionId: null,
      parentJobId: null,
      threadRoot: 'adopted-2',
      terminalId: null,
      reviewOf: null,
    }
    await mkdir(join(configDir, LOGS_DIR), { recursive: true })
    await writeFile(join(configDir, JOBS_FILE), `${JSON.stringify(running)}\n`)
    await writeFile(join(configDir, LOGS_DIR, 'adopted-2.log'), 'partial output, then nothing\n')

    const manager = createJobManager({ home })
    const settled = await waitForStatus(manager, 'adopted-2')
    expect(settled.status).toBe('failed')
  })

  test('a reviewedAt stamp survives a manager reload', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const first = createJobManager({ home })

    const result = await first.createJob(
      { engine: 'claude', cwd: repo, prompt: 'review-me', label: 'reviewed' },
      echoResolver,
    )
    if (!result.ok) throw new Error('expected job to be created')
    await waitForStatus(first, result.job.id)

    const marked = await first.markReviewed(result.job.id, 1_700_000_000_000)
    expect(marked.ok).toBe(true)

    const second = createJobManager({ home })
    expect(second.getJob(result.job.id)?.reviewedAt).toBe(1_700_000_000_000)
  })

  test('updateJob persists a chat title and project across a reload', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const first = createJobManager({ home })
    const result = await first.createJob({ engine: 'claude', cwd: repo, prompt: 'hi', label: 'hi', purpose: 'chat' }, echoResolver)
    if (!result.ok) throw new Error('expected job to be created')
    expect(result.job.project).toBeNull()
    expect(result.job.titleLocked).toBe(false)
    await waitForStatus(first, result.job.id)

    const updated = await first.updateJob(result.job.id, { label: 'Login fix', titleLocked: true, project: repo })
    expect(updated?.label).toBe('Login fix')
    expect(await first.updateJob('nope', { label: 'x' })).toBeUndefined()

    const second = createJobManager({ home })
    expect(second.getJob(result.job.id)).toMatchObject({ label: 'Login fix', titleLocked: true, project: repo, status: 'done' })
  })

  test('a chat may run in a Chat home that is not a git repository, a worker may not', async () => {
    const chatHomeDir = join(home, 'work')
    await mkdir(chatHomeDir, { recursive: true })
    const manager = createJobManager({ home })
    expect((await manager.createJob({ engine: 'claude', cwd: chatHomeDir, prompt: 'hi', label: 'hi', purpose: 'chat' }, echoResolver)).ok).toBe(true)
    expect((await manager.createJob({ engine: 'claude', cwd: chatHomeDir, prompt: 'hi', label: 'hi' }, echoResolver)).ok).toBe(false)
  })

  test('markReviewed 404s for an unknown id and is idempotent for a known one', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })

    const missing = await manager.markReviewed('nope')
    expect(missing).toEqual({ ok: false, status: 404, error: 'job not found' })

    const result = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'once', label: 'idempotent' },
      echoResolver,
    )
    if (!result.ok) throw new Error('expected job to be created')
    await waitForStatus(manager, result.job.id)

    const first = await manager.markReviewed(result.job.id, 1_700_000_000_000)
    const again = await manager.markReviewed(result.job.id, 1_800_000_000_000)
    expect(first.ok && again.ok && again.job.reviewedAt).toBe(1_700_000_000_000)
  })

  test('a record persisted before reviewedAt existed loads as unreviewed', async () => {
    const legacy = {
      id: 'legacy-1',
      engine: 'glm',
      cwd: home,
      label: 'legacy',
      pid: 42,
      status: 'done',
      startedAt: 1,
      endedAt: 2,
      exitCode: 0,
      diffStat: '1 file changed',
    }
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, JOBS_FILE), `${JSON.stringify(legacy)}\n`)

    const manager = createJobManager({ home })
    expect(manager.getJob('legacy-1')?.reviewedAt).toBeNull()
  })
})

describe('session id capture', () => {
  const sessionLine = '{"type":"system","subtype":"init","session_id":"sess-42"}'
  const streamResolver: EngineResolver = () => ({ cmd: 'echo', args: [sessionLine], env: {} })

  test('pulls the session id out of the stream and persists it on the record', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })

    const created = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'say alpha', label: 'thread' },
      streamResolver,
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.job.sessionId).toBeNull()

    const settled = await waitForStatus(manager, created.job.id)
    expect(settled.sessionId).toBe('sess-42')
    expect(settled.status).toBe('done')

    const lines = (await readFile(configPath(JOBS_FILE), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JobRecord)
    expect(lines[lines.length - 1]?.sessionId).toBe('sess-42')
  })

  test('records the prompt and its own id as the thread root for an original dispatch', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })

    const created = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'say alpha', label: 'thread' },
      streamResolver,
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    expect(created.job.prompt).toBe('say alpha')
    expect(created.job.parentJobId).toBeNull()
    expect(created.job.threadRoot).toBe(created.job.id)
  })

  test('carries the reply thread fields through and hands the resolver the session to resume', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })
    const seen: Array<string | undefined> = []
    const capturing: EngineResolver = (params) => {
      seen.push(params.resumeSessionId)
      return { cmd: 'echo', args: [sessionLine], env: {} }
    }

    const created = await manager.createJob(
      {
        engine: 'claude',
        cwd: repo,
        prompt: 'what word did you say?',
        label: 'thread',
        parentJobId: 'parent-1',
        threadRoot: 'root-1',
        resumeSessionId: 'sess-42',
      },
      capturing,
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    expect(seen).toEqual(['sess-42'])
    expect(created.job.parentJobId).toBe('parent-1')
    expect(created.job.threadRoot).toBe('root-1')
  })

  test('leaves sessionId null when the engine never prints one', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })

    const created = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'plain text', label: 'thread' },
      echoResolver,
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect((await waitForStatus(manager, created.job.id)).sessionId).toBeNull()
  })

  test('a record written before threads existed loads as its own single-turn thread', async () => {
    const legacy = {
      id: 'legacy-2',
      engine: 'glm',
      cwd: home,
      label: 'legacy',
      pid: 42,
      status: 'done',
      startedAt: 1,
      endedAt: 2,
      exitCode: 0,
      diffStat: null,
    }
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, JOBS_FILE), `${JSON.stringify(legacy)}\n`)

    const loaded = createJobManager({ home }).getJob('legacy-2')
    expect(loaded?.prompt).toBe('')
    expect(loaded?.sessionId).toBeNull()
    expect(loaded?.parentJobId).toBeNull()
    expect(loaded?.threadRoot).toBe('legacy-2')
    expect(loaded?.turns).toBe(0)
    expect(loaded?.lastTool).toBeNull()
  })
})

describe('activity throttle trailing recompute', () => {
  // `exec` at the end replaces the shell with `sleep` in place (same pid, same stdout/stderr
  // fds), so killing the spawned process closes the pipe immediately instead of leaving a
  // forked `sleep` child holding it open for its full duration.
  const throttledActivityResolver: EngineResolver = () => ({
    cmd: 'sh',
    args: [
      '-c',
      [
        'printf \'%s\\n\' \'{"type":"assistant","message":{"content":[{"type":"text","text":"first"}]}}\'',
        'printf \'%s\\n\' \'{"type":"assistant","message":{"content":[{"type":"text","text":"second"}]}}\'',
        'exec sleep 2',
      ].join('; '),
    ],
    env: {},
  })

  test('a chunk dropped by the throttle is still parsed once its window elapses, with no further chunk arriving', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home, activityIntervalMs: 100 })

    const created = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'irrelevant', label: 'throttle-trailing' },
      throttledActivityResolver,
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    // The two lines print back to back, so the second is throttled and dropped without the
    // trailing-timer fix. Check well after the 100ms window but well before the 2s sleep ends.
    await new Promise((resolveWait) => setTimeout(resolveWait, 400))
    expect(manager.currentActivity(created.job.id)).toBe('second')
    expect(manager.getJob(created.job.id)?.status).toBe('running')

    await manager.killJob(created.job.id)
    await waitForStatus(manager, created.job.id)
  })
})

describe('log tail/offset reader', () => {
  test('readLogTail returns only the last N bytes and the total size as offset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-jobs-log-'))
    const path = join(dir, 'sample.log')
    await writeFile(path, '0123456789')

    const tail = await readLogTail(path, 4)
    expect(tail.content).toBe('6789')
    expect(tail.offset).toBe(10)

    await rm(dir, { recursive: true, force: true })
  })

  test('readLogTail returns the whole file when it is smaller than the requested window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-jobs-log-'))
    const path = join(dir, 'sample.log')
    await writeFile(path, 'short')

    const tail = await readLogTail(path, 4096)
    expect(tail.content).toBe('short')
    expect(tail.offset).toBe(5)

    await rm(dir, { recursive: true, force: true })
  })

  test('readLogTail on a missing file returns empty content and zero offset', async () => {
    const tail = await readLogTail(join(tmpdir(), 'mc-jobs-log-missing.log'))
    expect(tail.content).toBe('')
    expect(tail.offset).toBe(0)
  })

  test('readLogSince returns only bytes appended after the given offset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-jobs-log-'))
    const path = join(dir, 'sample.log')
    await writeFile(path, 'abc')

    const first = await readLogTail(path)
    expect(first.content).toBe('abc')

    await writeFile(path, 'abcdef')
    const since = await readLogSince(path, first.offset)
    expect(since.content).toBe('def')
    expect(since.offset).toBe(6)

    await rm(dir, { recursive: true, force: true })
  })

  test('readLogSince returns empty content when nothing new has been written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-jobs-log-'))
    const path = join(dir, 'sample.log')
    await writeFile(path, 'stable')

    const tail = await readLogTail(path)
    const since = await readLogSince(path, tail.offset)
    expect(since.content).toBe('')
    expect(since.offset).toBe(tail.offset)

    await rm(dir, { recursive: true, force: true })
  })
})

describe('job loop progress', () => {
  test('counts complete assistant messages once across appends and persists progress', async () => {
    const repo = join(home, 'progress')
    await initGitRepo(repo)
    const manager = createJobManager({ home })
    const created = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: '', label: 'progress' }, sleepResolver,
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.job.id
    const line = JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'text', text: 'checking' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
    ] } })
    const pause = () => Bun.sleep(350)
    try {
      await appendFile(manager.logPath(id), line.slice(0, 45))
      await pause()
      expect(manager.getJob(id)?.turns).toBe(0)
      await appendFile(manager.logPath(id), line.slice(45) + '\n')
      await pause()
      expect(manager.getJob(id)?.turns).toBe(1)
      expect(manager.getJob(id)?.lastTool).toBe('Bash')
      await appendFile(manager.logPath(id), [
        'not json', '{"type":"user"}', '{"type":"result"}',
        '{"type":"item.started","item":{"type":"agent_message","text":"start"}}',
        '{"type":"item.completed","item":{"type":"error","message":"oops"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":""}}',
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(20_000) }] } }),
        '',
      ].join('\n'))
      await pause()
      expect(manager.getJob(id)?.turns).toBe(4)
      expect(manager.getJob(id)?.lastTool).toBe('Bash')
      await pause()
      expect(manager.getJob(id)?.turns).toBe(4)
      const saved = JSON.parse((await readFile(join(configDir, JOBS_FILE), 'utf8')).trim().split('\n').at(-1)!)
      expect(saved.turns).toBe(4)
      await appendFile(manager.logPath(id), line)
    } finally {
      await manager.killJob(id)
      await waitForStatus(manager, id)
    }
    expect(manager.getJob(id)?.turns).toBe(5)
    const reloaded = createJobManager({ home }).getJob(id)
    expect(reloaded?.turns).toBe(5)
    expect(reloaded?.lastTool).toBe('Bash')
  })

  test('counts each top-level Agent or Task call once as a sub-agent, persists it and reports progress', async () => {
    const repo = join(home, 'sub-agents')
    await initGitRepo(repo)
    const progress: JobRecord[] = []
    const manager = createJobManager({ home, onJobProgress: (record) => { progress.push(record) } })
    const created = await manager.createJob({ engine: 'claude', cwd: repo, prompt: '', label: 'sub-agents' }, sleepResolver)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.job.id
    const call = (toolId: string, name: string, parent: string | null = null) => JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id: toolId, name, input: {} }] } })
    try {
      await appendFile(manager.logPath(id), [call('t1', 'Agent'), call('t2', 'Task'), call('t1', 'Agent'), call('t3', 'Read'), call('t4', 'Agent', 't1'), ''].join('\n'))
      await Bun.sleep(350)
      expect(manager.getJob(id)?.subAgents).toBe(2)
      expect(progress.at(-1)?.subAgents).toBe(2)
      const saved = JSON.parse((await readFile(join(configDir, JOBS_FILE), 'utf8')).trim().split('\n').at(-1)!)
      expect(saved.subAgents).toBe(2)
    } finally {
      await manager.killJob(id)
      await waitForStatus(manager, id)
    }
    expect(createJobManager({ home }).getJob(id)?.subAgents).toBe(2)
  })

  test('replays an adopted live log without counting persisted turns twice', async () => {
    const repo = join(home, 'adopt-progress')
    await initGitRepo(repo)
    const proc = Bun.spawn(['sleep', '30'])
    const id = 'replayed'
    const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}\n'
    await mkdir(join(configDir, LOGS_DIR), { recursive: true })
    await writeFile(join(configDir, LOGS_DIR, id + '.log'), line.repeat(2))
    await writeFile(join(configDir, JOBS_FILE), JSON.stringify({
      id, engine: 'glm', cwd: repo, pid: proc.pid, status: 'running',
      startedAt: 1000, turns: 2, lastTool: 'Read', slowAt: 901001,
    }) + '\n')
    const notifications: JobRecord[] = []
    const manager = createJobManager({ home, onJobSlow: (record) => { notifications.push(record) } })
    try {
      await Bun.sleep(350)
      expect(manager.getJob(id)?.turns).toBe(2)
      await appendFile(manager.logPath(id), line)
      await Bun.sleep(350)
      expect(manager.getJob(id)?.turns).toBe(3)
    } finally {
      proc.kill()
      await proc.exited
      await waitForStatus(manager, id)
    }
    expect(manager.getJob(id)?.turns).toBe(3)
    expect(manager.getJob(id)?.slowAt).toBe(901001)
    expect(notifications).toHaveLength(0)
  })
})


describe('slow jobs', () => {
  test('normalizes missing and invalid slow timestamps', () => {
    for (const slowAt of [undefined, null, '123', NaN, Infinity]) {
      expect(normalizeJobRecord({ slowAt }).slowAt).toBeNull()
    }
    expect(normalizeJobRecord({ slowAt: 0 }).slowAt).toBe(0)
  })

  for (const trigger of ['turns', 'elapsed']) {
    test(`notifies once when ${trigger} crosses its threshold and persists slowAt`, async () => {
      const repo = join(home, 'slow')
      await initGitRepo(repo)
      const startedAt = 1_700_000_000_000
      let now = startedAt
      const notifications: JobRecord[] = []
      const manager = createJobManager({ home, now: () => now, onJobSlow: (record) => { notifications.push(record) } })
      const created = await manager.createJob(
        { engine: 'claude', cwd: repo, prompt: '', label: 'slow' }, sleepResolver,
      )
      expect(created.ok).toBe(true)
      if (!created.ok) return
      const id = created.job.id
      const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"checking"}]}}\n'
      let slowAt = 0
      try {
        expect(created.job.startedAt).toBe(startedAt)
        expect(created.job.slowAt).toBeNull()
        await appendFile(manager.logPath(id), line.repeat(80))
        now = startedAt + 15 * 60_000
        await Bun.sleep(350)
        expect(manager.getJob(id)?.turns).toBe(80)
        expect(notifications).toHaveLength(0)
        if (trigger === 'turns') await appendFile(manager.logPath(id), line)
        else now += 1
        slowAt = now
        await Bun.sleep(350)
        expect(notifications).toHaveLength(1)
        expect(notifications[0]?.slowAt).toBe(slowAt)
        expect(notifications[0]?.turns).toBe(trigger === 'turns' ? 81 : 80)
        const saved = (await readFile(configPath(JOBS_FILE), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).at(-1)
        expect(saved.slowAt).toBe(slowAt)
        now += 60_000
        await appendFile(manager.logPath(id), line)
        await Bun.sleep(350)
        expect(notifications).toHaveLength(1)
        expect(manager.getJob(id)?.slowAt).toBe(slowAt)
      } finally {
        await manager.killJob(id)
        await waitForStatus(manager, id)
      }
      const reloaded = createJobManager({ home, now: () => now, onJobSlow: (record) => { notifications.push(record) } })
      expect(reloaded.getJob(id)?.slowAt).toBe(slowAt)
      await Bun.sleep(350)
      expect(notifications).toHaveLength(1)
    })
  }
})

describe('job worktrees', () => {
  test('creates a sanitized branch, runs there, persists metadata, and reuses it', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })
    const params = { engine: 'claude', cwd: repo, prompt: '', label: 'ticket / one', worktree: true }
    const resolver: EngineResolver = () => ({ cmd: 'pwd', args: [], env: {} })
    const created = await manager.createJob(params, resolver)
    if (!created.ok) throw new Error(created.error)
    const job = await waitForStatus(manager, created.job.id)
    expect(job.worktree).toBe(join(job.baseRepo!, '.worktree', 'ticket---one'))
    expect(job.cwd).toBe(job.worktree!)
    expect(job.baseRepo).toBe(await realpath(repo))
    expect(job.baseBranch).toBe(await gitOutput(repo, 'rev-parse', '--abbrev-ref', 'HEAD'))
    expect((await readFile(manager.logPath(job.id), 'utf8')).trim()).toBe(job.cwd)
    await writeFile(join(job.cwd, 'retained.txt'), 'keep this')
    const again = await manager.createJob(params, resolver)
    if (!again.ok) throw new Error(again.error)
    await waitForStatus(manager, again.job.id)
    expect(again.job.cwd).toBe(job.cwd)
    expect(await readFile(join(again.job.cwd, 'retained.txt'), 'utf8')).toBe('keep this')
    const reloaded = createJobManager({ home }).getJob(job.id)
    expect(reloaded?.worktree).toBe(job.worktree)
    expect(reloaded?.baseRepo).toBe(job.baseRepo)
    expect(reloaded?.baseBranch).toBe(job.baseBranch)
  })

  test('reuses an existing branch without an attached worktree', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    await gitOutput(repo, 'branch', 'existing')
    const manager = createJobManager({ home })
    const created = await manager.createJob({ engine: 'claude', cwd: repo, prompt: '', label: 'existing', worktree: true }, echoResolver)
    if (!created.ok) throw new Error(created.error)
    await waitForStatus(manager, created.job.id)
    expect(await gitOutput(created.job.cwd, 'branch', '--show-current')).toBe('existing')
  })

  test('normalizes legacy worktree fields to null', () => {
    const job = normalizeJobRecord({ id: 'old' })
    expect(job.worktree).toBeNull()
    expect(job.baseRepo).toBeNull()
    expect(job.baseBranch).toBeNull()
  })

  test('rejects invalid branch labels without creating a job', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })
    for (const label of ['..', '-bad', '', 'bad..name']) {
      const result = await manager.createJob({ engine: 'claude', cwd: repo, prompt: '', label, worktree: true }, echoResolver)
      expect(result.ok).toBe(false)
    }
    expect(manager.listJobs()).toHaveLength(0)
  })
})

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [output, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(error)
  return output.trim()
}

describe('chat turns and workflow workspaces', () => {
  test('a running chat turn does not stop a workflow run from claiming its folder', async () => {
    const project = join(home, 'project')
    await mkdir(project)
    const manager = createJobManager({ home })
    const turn = await manager.createJob({ engine: 'claude', cwd: project, prompt: 'hi', label: 'Chat', purpose: 'chat' }, sleepResolver)
    expect(turn.ok).toBe(true)
    expect(manager.claimWorkspace(await realpath(project), 'run-1')).toBe(true)
    if (turn.ok) await manager.killJob(turn.job.id)
  })

  test('a chat turn can start in a folder a workflow run holds; other jobs still cannot', async () => {
    const project = join(home, 'project')
    await mkdir(project)
    const manager = createJobManager({ home })
    expect(manager.claimWorkspace(await realpath(project), 'run-1')).toBe(true)
    const turn = await manager.createJob({ engine: 'claude', cwd: project, prompt: 'hi', label: 'Chat', purpose: 'chat' }, echoResolver)
    expect(turn.ok).toBe(true)
    const worker = await manager.createJob({ engine: 'claude', cwd: project, prompt: 'hi', label: 'Work' }, echoResolver)
    expect(worker.ok).toBe(false)
  })
})

describe('bridge control channel', () => {
  const catResolver: EngineResolver = () => ({ cmd: 'cat', args: [], env: {}, control: true, stdin: JSON.stringify({ hello: 'launch' }) })

  test('a control spawn keeps stdin open and later lines reach the child', async () => {
    const project = join(home, 'project')
    await mkdir(project)
    const manager = createJobManager({ home })
    const result = await manager.createJob({ engine: 'claude', cwd: project, prompt: 'hi', label: 'Chat', purpose: 'chat' }, catResolver)
    if (!result.ok) throw new Error(result.error)
    expect(manager.sendControl(result.job.id, { type: 'permission', requestId: 'r1', decision: 'allow_once' })).toBe(true)
    expect(manager.sendControl(result.job.id, { type: 'permission', requestId: 'r2', decision: 'deny' })).toBe(true)
    for (let attempt = 0; attempt < 40; attempt++) {
      const log = await readFile(manager.logPath(result.job.id), 'utf8').catch(() => '')
      if (log.includes('"requestId":"r2"')) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const log = await readFile(manager.logPath(result.job.id), 'utf8')
    expect(log).toContain('"hello":"launch"')
    expect(log).toContain('"requestId":"r1"')
    expect(log).toContain('"requestId":"r2"')
    const kill = await manager.killJob(result.job.id)
    expect(kill.ok).toBe(true)
    await waitForStatus(manager, result.job.id)
    expect(manager.sendControl(result.job.id, { type: 'permission', requestId: 'r3', decision: 'deny' })).toBe(false)
  })

  test('sendControl is false for an unknown job', () => {
    const manager = createJobManager({ home })
    expect(manager.sendControl('missing', { type: 'permission', requestId: 'r1', decision: 'deny' })).toBe(false)
  })

  const claudeProcess = async (): Promise<{ command: string; startedAt: number }> => ({ command: '/usr/local/bin/claude --output-format stream-json', startedAt: Date.now() })

  async function waitPidGone(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        process.kill(pid, 0)
      } catch {
        return true
      }
      if (Date.now() > deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

  test('a bridge child that ignores SIGTERM is killed even after the bridge exited', async () => {
    const project = join(home, 'project')
    await mkdir(project)
    const script = `sh -c 'trap "" TERM; sleep 60' & child=$!; echo "{\\"type\\":\\"skd_child\\",\\"skd\\":true,\\"pid\\":$child}"; sleep 0.3`
    const resolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', script], env: {} })
    const manager = createJobManager({ home, processInfo: claudeProcess })
    const result = await manager.createJob({ engine: 'claude', cwd: project, prompt: 'hi', label: 'Chat', purpose: 'chat' }, resolver)
    if (!result.ok) throw new Error(result.error)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const log = await readFile(manager.logPath(result.job.id), 'utf8')
    const childPid = Number(JSON.parse(log.trim().split('\n')[0]).pid)
    expect(Number.isInteger(childPid)).toBe(true)
    await manager.killJob(result.job.id).catch(() => undefined)
    await waitForStatus(manager, result.job.id, 8000).catch(() => undefined)
    expect(await waitPidGone(childPid, 7000)).toBe(true)
  }, 20000)

  function adoptedBridgeRecord(id: string) {
    return {
      id,
      engine: 'claude',
      cwd: join(home, 'project'),
      worktree: null,
      baseRepo: null,
      baseBranch: null,
      label: 'Chat',
      prompt: 'hi',
      pid: 999_999,
      status: 'running' as const,
      startedAt: Date.now() - 1000,
      turns: 0,
      slowAt: null,
      lastTool: null,
      endedAt: null,
      exitCode: null,
      diffStat: null,
      reviewedAt: null,
      sessionId: null,
      parentJobId: null,
      threadRoot: id,
      terminalId: null,
      reviewOf: null,
      model: null,
      purpose: 'chat' as const,
    }
  }

  test('an adopted dead bridge job leaves alone a logged pid that is no longer a claude child', async () => {
    const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' })
    const childPid = child.pid as number
    const asked: number[] = []
    try {
      await mkdir(join(home, 'project'), { recursive: true })
      await mkdir(join(configDir, LOGS_DIR), { recursive: true })
      await writeFile(join(configDir, JOBS_FILE), `${JSON.stringify(adoptedBridgeRecord('adopted-bridge-2'))}\n`)
      await writeFile(join(configDir, LOGS_DIR, 'adopted-bridge-2.log'), `${JSON.stringify({ type: 'skd_child', skd: true, pid: childPid, startedAt: Date.now() })}\n{"type":"result","subtype":"success","is_error":false}\n`)
      const manager = createJobManager({ home, processInfo: async (pid) => { asked.push(pid); return { command: '/bin/sleep 60', startedAt: Date.now() } } })
      await waitForStatus(manager, 'adopted-bridge-2', 5000)
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(asked).toContain(childPid)
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
    } finally {
      child.kill('SIGKILL')
    }
  }, 20000)

  test('a logged claude pid that started before the job is not signalled', async () => {
    const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await mkdir(join(home, 'project'), { recursive: true })
      await mkdir(join(configDir, LOGS_DIR), { recursive: true })
      await writeFile(join(configDir, JOBS_FILE), `${JSON.stringify(adoptedBridgeRecord('adopted-bridge-3'))}\n`)
      await writeFile(join(configDir, LOGS_DIR, 'adopted-bridge-3.log'), `${JSON.stringify({ type: 'skd_child', skd: true, pid: child.pid })}\n`)
      const manager = createJobManager({ home, processInfo: async () => ({ command: '/usr/local/bin/claude --print', startedAt: Date.now() - 60_000 }) })
      await waitForStatus(manager, 'adopted-bridge-3', 5000)
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
    } finally {
      child.kill('SIGKILL')
    }
  }, 20000)

  test('an adopted dead bridge job kills a live child from its log', async () => {
    const child = Bun.spawn(['sh', '-c', 'trap "" TERM; sleep 60'], { stdout: 'ignore', stderr: 'ignore' })
    const childPid = child.pid as number
    const running = {
      id: 'adopted-bridge-1',
      engine: 'claude',
      cwd: join(home, 'project'),
      worktree: null,
      baseRepo: null,
      baseBranch: null,
      label: 'Chat',
      prompt: 'hi',
      pid: 999_999,
      status: 'running' as const,
      startedAt: Date.now() - 1000,
      turns: 0,
      slowAt: null,
      lastTool: null,
      endedAt: null,
      exitCode: null,
      diffStat: null,
      reviewedAt: null,
      sessionId: null,
      parentJobId: null,
      threadRoot: 'adopted-bridge-1',
      terminalId: null,
      reviewOf: null,
      model: null,
      purpose: 'chat' as const,
    }
    await mkdir(join(home, 'project'), { recursive: true })
    await mkdir(join(configDir, LOGS_DIR), { recursive: true })
    await writeFile(join(configDir, JOBS_FILE), `${JSON.stringify(running)}\n`)
    await writeFile(join(configDir, LOGS_DIR, 'adopted-bridge-1.log'), `${JSON.stringify({ type: 'skd_child', skd: true, pid: childPid })}\n{"type":"result","subtype":"success","is_error":false}\n`)
    createJobManager({ home, processInfo: claudeProcess })
    expect(await waitPidGone(childPid, 8000)).toBe(true)
  }, 20000)

  test('a settled chat turn merges allow_always rules into the chat root', async () => {
    const project = join(home, 'project')
    await mkdir(project)
    const script = `echo '{"type":"skd_permission_resolved","skd":true,"requestId":"r1","decision":"allow_always","rules":["Bash(bun test:*)"]}' && echo '{"type":"skd_permission_resolved","skd":true,"requestId":"r2","decision":"allow_always","rules":["Bash(bun test:*)","Read(//tmp/x.md)"]}'`
    const resolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', script], env: {} })
    const manager = createJobManager({ home })
    const root = await manager.createJob({ engine: 'claude', cwd: project, prompt: 'hi', label: 'Chat', purpose: 'chat' }, resolver)
    if (!root.ok) throw new Error(root.error)
    await waitForStatus(manager, root.job.id)
    const turn = await manager.createJob({ engine: 'claude', cwd: project, prompt: 'again', label: 'Chat', purpose: 'chat', threadRoot: root.job.id, parentJobId: root.job.id }, resolver)
    if (!turn.ok) throw new Error(turn.error)
    await waitForStatus(manager, turn.job.id)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(manager.getJob(root.job.id)?.allowRules).toEqual(['Bash(bun test:*)', 'Read(//tmp/x.md)'])
  })
})

describe('child process identity', () => {
  test('ps output parses into a start time and a command, padded days included', () => {
    expect(parseUtcPsLine('Wed Sep  3 10:12:33 2026     /usr/local/bin/claude --print\n')).toEqual({ command: '/usr/local/bin/claude --print', startedAt: Date.UTC(2026, 8, 3, 10, 12, 33) })
    expect(parseUtcPsLine('')).toBeNull()
    expect(parseUtcPsLine('not a date at all, really   sleep 60')).toBeNull()
  })

  test('only a claude command started no earlier than 5 s before the job counts as ours', () => {
    const since = Date.parse('2026-09-30T10:00:00Z')
    expect(isOwnClaudeChild({ command: '/opt/claude/bin/claude -p', startedAt: since - 4_000 }, since)).toBe(true)
    expect(isOwnClaudeChild({ command: '/opt/claude/bin/claude -p', startedAt: since - 6_000 }, since)).toBe(false)
    expect(isOwnClaudeChild({ command: '/bin/sleep 60', startedAt: since }, since)).toBe(false)
    expect(isOwnClaudeChild(null, since)).toBe(false)
  })

  test('the real ps reader describes a process it is given', async () => {
    const child = Bun.spawn(['sleep', '5'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const info = await readProcessInfo(child.pid as number)
      expect(info?.command).toContain('sleep 5')
      expect(Math.abs((info?.startedAt ?? 0) - Date.now())).toBeLessThan(3_000)
      expect(await readProcessInfo(999_999)).toBeNull()
    } finally {
      child.kill('SIGKILL')
    }
  })
})
