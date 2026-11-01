import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Elysia } from 'elysia'

import { createApp } from '../server/index'
import { createJobManager } from '../server/jobs'
import type { JobManager } from '../server/jobs'
import type { EngineResolver, EngineResolverParams } from '../server/jobs-engine-iface'
import { engineArgs } from '../server/jobs-engine-iface'
import { jobsRoutes, safeEnqueue } from '../server/routes/jobs'
import { historyRoutes } from '../server/routes/history'
import { createChatQueue } from '../server/chat-queue'
import { attentionKey, createAttentionStore } from '../server/attention'
import { attentionEvents } from '../server/attention-events'
import { readApiToken } from '../server/secrets'
import { initScratchGitRepo, runGit } from './support/scratch-git-repo'
import { executionPlan } from './support/execution-plan'

const echoResolver: EngineResolver = ({ prompt }) => ({ cmd: 'echo', args: [prompt], env: {} })
const sleepResolver: EngineResolver = () => ({ cmd: 'sleep', args: ['30'], env: {} })

let configDir: string
let repo: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-jobs-routes-config-'))
  process.env.SKD_CONFIG_DIR = configDir

  repo = await mkdtemp(join(homedir(), 'mc-jobs-routes-scratch-'))
  await initScratchGitRepo(repo)
})

afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

function buildApp(manager: JobManager, resolver: EngineResolver): Elysia {
  return new Elysia().use(jobsRoutes(manager, resolver))
}

const REBIND = 'http://rebind.example'

function post(path: string, body: unknown, origin = 'http://localhost'): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  return new Request(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

function get(path: string, origin = 'http://localhost'): Request {
  return new Request(`${origin}${path}`)
}

async function pollUntilDone(
  app: Elysia,
  id: string,
  timeoutMs = 3000,
): Promise<{ id: string; status: string; diffStat: string | null; stoppedAt?: number }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await app.handle(get('/api/jobs'))
    const { jobs } = (await response.json()) as { jobs: Array<{ id: string; status: string; diffStat: string | null; stoppedAt?: number }> }
    const job = jobs.find((entry) => entry.id === id)
    if (job !== undefined && job.status !== 'running') return job
    if (Date.now() > deadline) throw new Error(`job ${id} did not settle within ${timeoutMs}ms`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

describe('POST /api/jobs', () => {
  test('rejects a rebinding host', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'x' }, REBIND),
    )
    expect(response.status).toBe(403)
  })

  test('rejects an incomplete payload', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs', { engine: 'claude' }))
    expect(response.status).toBe(400)
  })

  test('rejects a cwd outside HOME', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: '/tmp', prompt: 'hi', label: 'x' }),
    )
    expect(response.status).toBe(400)
  })

  test('creates a job that completes with a readable log and a diffStat', async () => {
    const app = buildApp(createJobManager(), echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hello-from-route', label: 'route-smoke' }),
    )
    expect(created.status).toBe(200)
    const job = (await created.json()) as { id: string; status: string }
    expect(job.status).toBe('running')

    const finished = await pollUntilDone(app, job.id)
    expect(finished.status).toBe('done')

    const log = await app.handle(get(`/api/jobs/${job.id}/log`))
    expect(log.status).toBe(200)
    expect(await log.text()).toContain('hello-from-route')
  })

  test('passes SKD_JOB_ID and the legacy MC_JOB_ID in the spawned process env', async () => {
    const envResolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', 'echo "job=$SKD_JOB_ID legacy=$MC_JOB_ID"'], env: {} })
    const app = buildApp(createJobManager(), envResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'mc-job-id' }),
    )
    expect(created.status).toBe(200)
    const job = (await created.json()) as { id: string }

    const finished = await pollUntilDone(app, job.id)
    expect(finished.status).toBe('done')

    const log = await app.handle(get(`/api/jobs/${job.id}/log`))
    expect(await log.text()).toContain(`job=${job.id} legacy=${job.id}`)
  })

  test('passes an optional model to the resolver and stores it on the record', async () => {
    const calls: EngineResolverParams[] = []
    const app = buildApp(createJobManager(), capturingResolver(calls))

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'with-model', model: 'opus' }),
    )
    expect(created.status).toBe(200)
    expect(calls[0]?.model).toBe('opus')
    expect(((await created.json()) as { model: string | null }).model).toBe('opus')

    const { jobs } = (await (await app.handle(get('/api/jobs'))).json()) as {
      jobs: Array<{ label: string; model: string | null }>
    }
    expect(jobs.find((row) => row.label === 'with-model')?.model).toBe('opus')
  })

  test('defaults the record model to null when none is sent', async () => {
    const calls: EngineResolverParams[] = []
    const app = buildApp(createJobManager(), capturingResolver(calls))

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'no-model' }),
    )
    expect(((await created.json()) as { model: string | null }).model).toBeNull()
    expect(calls[0]?.model).toBeUndefined()
  })

  test('rejects a model longer than 100 characters', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'l', model: 'x'.repeat(101) }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'model too long' })
  })
})

describe('GET /api/jobs', () => {
  test('rejects a rebinding host', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(get('/api/jobs', REBIND))
    expect(response.status).toBe(403)
  })

  test('lists dispatched jobs', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'listed' }),
    )
    const job = (await created.json()) as { id: string }

    const response = await app.handle(get('/api/jobs'))
    const { jobs } = (await response.json()) as { jobs: Array<{ label: string; turns: number; lastTool: string | null }> }
    expect(jobs.some((entry) => entry.label === 'listed')).toBe(true)
    expect(jobs.find((entry) => entry.label === 'listed')).toMatchObject({ turns: 0, lastTool: null, slowAt: null })

    await pollUntilDone(app, job.id)
  })

  test('carries the Claude session of the terminal that started a job, even after that terminal ended', async () => {
    const terminals = { list: () => [{ id: 'live', sessionId: 'conv-2' }], ended: () => [{ id: 'gone', sessionId: 'conv-1' }] }
    const app = new Elysia().use(jobsRoutes(createJobManager(), echoResolver, { terminals }))
    const started = await Promise.all(['gone', 'live', 'unknown'].map(async (terminalId) => (await (await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: terminalId, terminalId }))).json()) as { id: string }))
    await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'none' }))

    const { jobs } = (await (await app.handle(get('/api/jobs'))).json()) as { jobs: Array<{ label: string; terminalSessionId?: string }> }
    expect(Object.fromEntries(jobs.map((entry) => [entry.label, entry.terminalSessionId ?? null]))).toEqual({ gone: 'conv-1', live: 'conv-2', unknown: null, none: null })

    await Promise.all(started.map((job) => pollUntilDone(app, job.id)))
  })
})

describe('POST /api/jobs/:id/reviewed', () => {
  test('rejects a rebinding host', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs/does-not-exist/reviewed', {}, REBIND))
    expect(response.status).toBe(403)
  })

  test('404s for an unknown job id', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs/does-not-exist/reviewed', {}))
    expect(response.status).toBe(404)
  })

  test('stamps reviewedAt, keeps it stable on a repeat call, and drops the job from the flow queue', async () => {
    const manager = createJobManager()
    const app = buildApp(manager, echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'glm', cwd: repo, prompt: executionPlan('hi'), label: 'reviewed-me' }),
    )
    const job = (await created.json()) as { id: string }
    const finished = await pollUntilDone(app, job.id)
    expect(finished.status).toBe('done')

    const listed = await app.handle(get('/api/jobs'))
    const { jobs } = (await listed.json()) as { jobs: Array<{ id: string; reviewedAt: number | null }> }
    expect(jobs.find((entry) => entry.id === job.id)?.reviewedAt).toBeNull()

    const marked = await app.handle(post(`/api/jobs/${job.id}/reviewed`, {}))
    expect(marked.status).toBe(200)
    const reviewed = (await marked.json()) as { reviewedAt: number }
    expect(typeof reviewed.reviewedAt).toBe('number')

    const again = await app.handle(post(`/api/jobs/${job.id}/reviewed`, {}))
    expect(((await again.json()) as { reviewedAt: number }).reviewedAt).toBe(reviewed.reviewedAt)

    const relisted = await app.handle(get('/api/jobs'))
    const listedAgain = (await relisted.json()) as { jobs: Array<{ id: string; reviewedAt: number | null }> }
    expect(listedAgain.jobs.find((entry) => entry.id === job.id)?.reviewedAt).toBe(reviewed.reviewedAt)
    expect(manager.getJob(job.id)?.reviewedAt).toBe(reviewed.reviewedAt)
  })
})

describe('GET /api/jobs/:id/log', () => {
  test('404s for an unknown job id', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(get('/api/jobs/does-not-exist/log'))
    expect(response.status).toBe(404)
  })
})

describe('POST /api/jobs/:id/kill', () => {
  test('rejects a rebinding host', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs/does-not-exist/kill', {}, REBIND))
    expect(response.status).toBe(403)
  })

  test('errors for a job id that is not running', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs/does-not-exist/kill', {}))
    expect(response.status).toBe(404)
  })

  test('kills a running job', async () => {
    const app = buildApp(createJobManager(), sleepResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'irrelevant', label: 'kill-me' }),
    )
    const job = (await created.json()) as { id: string }

    const killed = await app.handle(post(`/api/jobs/${job.id}/kill`, {}))
    expect(killed.status).toBe(200)

    const finished = await pollUntilDone(app, job.id)
    expect(finished.status).toBe('failed')
    expect(finished.stoppedAt).toBeNumber()
    expect(createJobManager().getJob(job.id)?.stoppedAt).toBeNumber()
  })
})

describe('GET /api/jobs/:id/stream', () => {
  test('rejects a rebinding host', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(get('/api/jobs/does-not-exist/stream', REBIND))
    expect(response.status).toBe(403)
  })

  test('404s for an unknown job id', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(get('/api/jobs/does-not-exist/stream'))
    expect(response.status).toBe(404)
  })

  test('streams the initial log tail then closes cleanly when the client aborts', async () => {
    const app = buildApp(createJobManager(), echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'stream-me', label: 'stream' }),
    )
    const job = (await created.json()) as { id: string }
    await pollUntilDone(app, job.id)

    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${server.server?.port}`
    const controller = new AbortController()

    try {
      const response = await fetch(`${base}/api/jobs/${job.id}/stream`, {
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')

      const reader = response.body?.getReader()
      expect(reader).toBeDefined()
      const { value } = await reader!.read()
      const chunk = new TextDecoder().decode(value)
      expect(chunk).toContain('data:')
      expect(chunk).toContain('stream-me')

      controller.abort()
      await expect(reader!.read()).rejects.toBeDefined()
    } finally {
      server.stop(true)
    }
  })
})

describe('GET /api/jobs/:id/activity', () => {
  const STREAM_LINE =
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"server/flow.ts"}}]}}'

  test('rejects a rebinding host and 404s an unknown id', async () => {
    const app = buildApp(createJobManager(), echoResolver)

    expect((await app.handle(get('/api/jobs/nope/activity', REBIND))).status).toBe(403)
    expect((await app.handle(get('/api/jobs/nope/activity'))).status).toBe(404)
  })

  test('parses the job log into a feed and reports the running activity on the list row', async () => {
    const app = buildApp(createJobManager(), echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: STREAM_LINE, label: 'activity-smoke' }),
    )
    const job = (await created.json()) as { id: string }
    await pollUntilDone(app, job.id)

    const feed = (await (await app.handle(get(`/api/jobs/${job.id}/activity`))).json()) as {
      status: string
      currentActivity: string | null
      events: Array<{ kind: string; title: string; detail: string }>
    }
    expect(feed.status).toBe('done')
    expect(feed.events).toEqual([{ kind: 'tool', title: 'Edit', detail: 'server/flow.ts' }])
    expect(feed.currentActivity).toBe('Edit · server/flow.ts')

    const { jobs } = (await (await app.handle(get('/api/jobs'))).json()) as {
      jobs: Array<{ id: string; currentActivity: string | null; turns: number; lastTool: string | null }>
    }
    expect(jobs.find((row) => row.id === job.id)?.currentActivity).toBe('Edit · server/flow.ts')
    expect(jobs.find((row) => row.id === job.id)?.turns).toBe(1)
    expect(jobs.find((row) => row.id === job.id)?.lastTool).toBe('Edit')
  })

  test('returns an empty feed for a job whose output is not stream-json', async () => {
    const app = buildApp(createJobManager(), echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'plain text output', label: 'plain' }),
    )
    const job = (await created.json()) as { id: string }
    await pollUntilDone(app, job.id)

    const feed = (await (await app.handle(get(`/api/jobs/${job.id}/activity`))).json()) as {
      currentActivity: string | null
      events: unknown[]
    }
    expect(feed.events).toEqual([])
    expect(feed.currentActivity).toBeNull()
  })
})

const SESSION_LINE = '{"type":"system","subtype":"init","session_id":"sess-1"}'

// Echoes one real init line so the pump finds a session id exactly the way it does for claude.
const sessionResolver: EngineResolver = () => ({ cmd: 'echo', args: [SESSION_LINE], env: {} })

function capturingResolver(calls: EngineResolverParams[]): EngineResolver {
  return (params) => {
    calls.push(params)
    return { cmd: 'echo', args: [SESSION_LINE], env: {} }
  }
}

async function dispatch(
  app: Elysia,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const response = await app.handle(post('/api/jobs', body))
  return (await response.json()) as { id: string }
}

describe('POST /api/jobs/:id/reply', () => {
  test('rejects a rebinding host', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const response = await app.handle(post('/api/jobs/anything/reply', { message: 'hi' }, REBIND))
    expect(response.status).toBe(403)
  })

  test('404s for an unknown job', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const response = await app.handle(post('/api/jobs/nope/reply', { message: 'hi' }))
    expect(response.status).toBe(404)
  })

  test('rejects a blank message', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const job = await dispatch(app, { engine: 'claude', cwd: repo, prompt: 'p', label: 'l' })
    await pollUntilDone(app, job.id)

    const response = await app.handle(post(`/api/jobs/${job.id}/reply`, { message: '   ' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'message is required' })
  })

  test('chains a new job whose argv carries --resume with the parent session id', async () => {
    const calls: EngineResolverParams[] = []
    const app = buildApp(createJobManager(), capturingResolver(calls))

    const parent = await dispatch(app, {
      engine: 'claude',
      cwd: repo,
      prompt: 'reply with the word alpha',
      label: 'thread-work',
    })
    await pollUntilDone(app, parent.id)

    const response = await app.handle(
      post(`/api/jobs/${parent.id}/reply`, { message: 'what word did you say?' }),
    )
    expect(response.status).toBe(200)
    const child = (await response.json()) as {
      id: string
      engine: string
      cwd: string
      label: string
      prompt: string
      parentJobId: string
      threadRoot: string
    }

    expect(child.id).not.toBe(parent.id)
    expect(child.engine).toBe('claude')
    expect(child.label).toBe('thread-work')
    expect(child.prompt).toBe('what word did you say?')
    expect(child.parentJobId).toBe(parent.id)
    expect(child.threadRoot).toBe(parent.id)

    expect(calls[1]?.resumeSessionId).toBe('sess-1')
    expect(engineArgs('claude', 'what word did you say?', calls[1]?.resumeSessionId)).toEqual([
      '--resume',
      'sess-1',
      '-p',
      'what word did you say?',
      '--output-format',
      'stream-json',
      '--verbose',
    ])
    expect(calls[0]?.resumeSessionId).toBeUndefined()
  })

  test('a reply inherits the parent model', async () => {
    const calls: EngineResolverParams[] = []
    const app = buildApp(createJobManager(), capturingResolver(calls))

    const parent = await dispatch(app, {
      engine: 'claude',
      cwd: repo,
      prompt: 'reply with the word alpha',
      label: 'thread-work',
      model: 'opus',
    })
    await pollUntilDone(app, parent.id)

    const child = (await (
      await app.handle(post(`/api/jobs/${parent.id}/reply`, { message: 'again' }))
    ).json()) as { id: string; model: string | null }
    expect(child.model).toBe('opus')
    expect(calls[1]?.model).toBe('opus')
    await pollUntilDone(app, child.id)
  })

  test('a reply to the reply stays on the same thread root', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const root = await dispatch(app, { engine: 'claude', cwd: repo, prompt: 'one', label: 'l' })
    await pollUntilDone(app, root.id)

    const first = (await (
      await app.handle(post(`/api/jobs/${root.id}/reply`, { message: 'two' }))
    ).json()) as { id: string }
    await pollUntilDone(app, first.id)

    const second = (await (
      await app.handle(post(`/api/jobs/${first.id}/reply`, { message: 'three' }))
    ).json()) as { threadRoot: string; parentJobId: string }

    expect(second.threadRoot).toBe(root.id)
    expect(second.parentJobId).toBe(first.id)
  })

  test('400s while the job has produced no session id', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const job = await dispatch(app, { engine: 'claude', cwd: repo, prompt: 'no json here', label: 'l' })
    await pollUntilDone(app, job.id)

    const response = await app.handle(post(`/api/jobs/${job.id}/reply`, { message: 'hi' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'job has no session id to resume yet' })
  })

  test('400s for an engine with no verified resume invocation', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const job = await dispatch(app, { engine: 'mystery', cwd: repo, prompt: 'p', label: 'l' })
    await pollUntilDone(app, job.id)

    const response = await app.handle(post(`/api/jobs/${job.id}/reply`, { message: 'hi' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'engine does not support conversation resume' })
  })
})

describe('GET /api/jobs/:id/thread', () => {
  test('rejects a rebinding host and 404s an unknown job', async () => {
    const app = buildApp(createJobManager(), sessionResolver)

    expect((await app.handle(get('/api/jobs/x/thread', REBIND))).status).toBe(403)
    expect((await app.handle(get('/api/jobs/x/thread'))).status).toBe(404)
  })

  test('returns the ordered conversation for the whole chain from either end', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const root = await dispatch(app, {
      engine: 'claude',
      cwd: repo,
      prompt: 'reply with the word alpha',
      label: 'l',
    })
    await pollUntilDone(app, root.id)

    const child = (await (
      await app.handle(post(`/api/jobs/${root.id}/reply`, { message: 'what word did you say?' }))
    ).json()) as { id: string }
    await pollUntilDone(app, child.id)

    for (const id of [root.id, child.id]) {
      const thread = (await (await app.handle(get(`/api/jobs/${id}/thread`))).json()) as {
        rootId: string
        engine: string
        running: boolean
        canReply: boolean
        sessionId: string | null
        messages: Array<{ role: string; kind: string; text: string; jobId: string }>
      }

      expect(thread.rootId).toBe(root.id)
      expect(thread.engine).toBe('claude')
      expect(thread.running).toBe(false)
      expect(thread.canReply).toBe(true)
      expect(thread.sessionId).toBe('sess-1')

      const prompts = thread.messages.filter((message) => message.role === 'user')
      expect(prompts.map((message) => message.text)).toEqual([
        'reply with the word alpha',
        'what word did you say?',
      ])
      expect(prompts.map((message) => message.jobId)).toEqual([root.id, child.id])
    }
  })

  test('reports the size of the job log it read, so a live view can follow from there', async () => {
    const manager = createJobManager()
    const app = buildApp(manager, echoResolver)
    const job = await dispatch(app, { engine: 'claude', cwd: repo, prompt: 'plain', label: 'l' })
    await pollUntilDone(app, job.id)

    const thread = (await (await app.handle(get(`/api/jobs/${job.id}/thread`))).json()) as { logSize: number }
    expect(thread.logSize).toBe((await stat(manager.logPath(job.id))).size)
  })

  test('reports canReply false while no session id has appeared', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const job = await dispatch(app, { engine: 'claude', cwd: repo, prompt: 'plain', label: 'l' })
    await pollUntilDone(app, job.id)

    const thread = (await (await app.handle(get(`/api/jobs/${job.id}/thread`))).json()) as {
      canReply: boolean
      sessionId: string | null
      messages: unknown[]
    }
    expect(thread.canReply).toBe(false)
    expect(thread.sessionId).toBeNull()
    expect(thread.messages).toHaveLength(1)
  })
})

describe('safeEnqueue', () => {
  test('skips enqueue once already closed', () => {
    let called = false
    safeEnqueue({ enqueue: () => (called = true) }, () => true, 'chunk')
    expect(called).toBe(false)
  })

  test('enqueues when not closed', () => {
    let received: string | null = null
    safeEnqueue<string>({ enqueue: (chunk) => (received = chunk) }, () => false, 'chunk')
    expect(received).toBe('chunk')
  })

  test('swallows a throw from enqueue on an already-torn-down controller', () => {
    const torndown = {
      enqueue: () => {
        throw new TypeError('Invalid state: Controller is already closed')
      },
    }
    expect(() => safeEnqueue(torndown, () => false, 'chunk')).not.toThrow()
  })
})

describe('mounted in the real app', () => {
  test('createApp wires the jobs routes behind the local-access guard', async () => {
    configDir = await mkdtemp(join(tmpdir(), 'mc-jobs-routes-config-'))
    process.env.SKD_CONFIG_DIR = configDir
    const app = await createApp()

    const rebound = await app.handle(get('/api/jobs', REBIND))
    expect(rebound.status).toBe(403)

    const listed = await app.handle(get('/api/jobs'))
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ jobs: [] })
  })
})

describe('POST /api/jobs/:id/land', () => {
  async function setup(worktree = true) {
    const manager = createJobManager()
    const app = buildApp(manager, echoResolver)
    const response = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hello', label: 'land-me', worktree }))
    expect(response.status).toBe(200)
    const job = await response.json()
    await pollUntilDone(app, job.id)
    return { app, manager, job }
  }

  test('lands all commits oldest first, cleans up, and persists reviewed marking', async () => {
    const { app, manager, job } = await setup()
    await writeFile(join(job.cwd, 'result.txt'), 'first\n')
    await runGit(['add', '-A'], job.cwd)
    await runGit(['commit', '-m', 'first change'], job.cwd)
    await writeFile(join(job.cwd, 'result.txt'), 'second\n')
    await runGit(['add', '-A'], job.cwd)
    await runGit(['commit', '-m', 'second change'], job.cwd)
    const response = await app.handle(post(`/api/jobs/${job.id}/land`, {}))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.base).toBe(job.baseBranch)
    expect(body.landed).toHaveLength(2)
    expect(await readFile(join(repo, 'result.txt'), 'utf8')).toBe('second\n')
    expect(await stat(job.cwd).catch(() => null)).toBeNull()
    const branch = Bun.spawn(['git', '-C', repo, 'show-ref', '--verify', 'refs/heads/land-me'], { stdout: 'ignore', stderr: 'ignore' })
    expect(await branch.exited).not.toBe(0)
    expect(manager.getJob(job.id)?.reviewedAt).toBeNumber()
    expect(createJobManager().getJob(job.id)?.reviewedAt).toBeNumber()
    expect(manager.getJob(job.id)?.landedAt).toBeNumber()
    expect(createJobManager().getJob(job.id)?.landedAt).toBeNumber()
  })

  test('auto-commits dirty changes before landing', async () => {
    const { app, job } = await setup()
    await writeFile(join(job.cwd, 'dirty.txt'), 'auto committed\n')
    const response = await app.handle(post(`/api/jobs/${job.id}/land`, {}))
    expect(response.status).toBe(200)
    expect((await response.json()).landed).toHaveLength(1)
    expect(await readFile(join(repo, 'dirty.txt'), 'utf8')).toBe('auto committed\n')
    const log = Bun.spawn(['git', '-C', repo, 'log', '-1', '--format=%s'], { stdout: 'pipe' })
    expect((await new Response(log.stdout).text()).trim()).toBe('land-me: landed from cockpit')
    expect(await log.exited).toBe(0)
  })

  test('aborts the entire sequence on conflict and preserves the worktree', async () => {
    const { app, manager, job } = await setup()
    await writeFile(join(job.cwd, 'first.txt'), 'first commit\n')
    await runGit(['add', '-A'], job.cwd)
    await runGit(['commit', '-m', 'first'], job.cwd)
    await writeFile(join(job.cwd, 'README.md'), 'worker\n')
    await runGit(['add', '-A'], job.cwd)
    await runGit(['commit', '-m', 'worker'], job.cwd)
    await writeFile(join(repo, 'README.md'), 'base\n')
    await runGit(['add', 'README.md'], repo)
    await runGit(['commit', '-m', 'base'], repo)
    const response = await app.handle(post(`/api/jobs/${job.id}/land`, {}))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'cherry-pick conflict', files: ['README.md'] })
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('base\n')
    expect(await stat(join(repo, 'first.txt')).catch(() => null)).toBeNull()
    expect(await readFile(join(job.cwd, 'README.md'), 'utf8')).toBe('worker\n')
    expect(manager.getJob(job.id)?.reviewedAt).toBeNull()
    await runGit(['diff', '--exit-code'], repo)
    const picking = Bun.spawn(['git', '-C', repo, 'rev-parse', '--verify', 'CHERRY_PICK_HEAD'], { stdout: 'ignore', stderr: 'ignore' })
    expect(await picking.exited).not.toBe(0)
  })

  test('rejects jobs without a worktree and unknown jobs', async () => {
    const { app, job } = await setup(false)
    expect((await app.handle(post(`/api/jobs/${job.id}/land`, {}))).status).toBe(400)
    expect((await app.handle(post('/api/jobs/missing/land', {}))).status).toBe(404)
    expect((await app.handle(post(`/api/jobs/${job.id}/land`, {}, REBIND))).status).toBe(403)
  })

  test('refuses to land onto a different checked-out branch', async () => {
    const { app, job } = await setup()
    await runGit(['checkout', '-b', 'other-base'], repo)
    await writeFile(join(job.cwd, 'dirty.txt'), 'keep\n')
    expect((await app.handle(post(`/api/jobs/${job.id}/land`, {}))).status).toBe(409)
    expect(await readFile(join(job.cwd, 'dirty.txt'), 'utf8')).toBe('keep\n')
  })
})

describe('POST /api/jobs spec lint', () => {
  const thin = 'Goal: add a label filter.\nAcceptance:\n- works\nPointers: server/routes/jobs.ts'
  const full = `${thin}\n## Decisions\n1. exact match.\n## Preserve\n- shape (server/routes/jobs.ts:152).\n## Steps\n### Step 1 — server/routes/jobs.ts\nedit.\nDone means all of these hold, verified by you before you report:\n1. acceptance criteria are met.`

  test('rejects a thin prompt for the execute engine with every miss listed', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs', { engine: 'glm', cwd: repo, prompt: thin, label: 'thin' }))
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: string; misses: string[] }
    expect(body.error).toBe('spec lint failed: the execute engine only takes an execution plan')
    expect(body.misses).toHaveLength(4)
    expect(body.misses[0]).toBe('missing "## Decisions" section')
    const listed = await app.handle(get('/api/jobs'))
    expect(((await listed.json()) as { jobs: unknown[] }).jobs).toEqual([])
  })

  test('a full plan for the execute engine and any prompt for other engines pass', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const planned = await app.handle(post('/api/jobs', { engine: 'glm', cwd: repo, prompt: full, label: 'full' }))
    expect(planned.status).toBe(200)
    const review = await app.handle(post('/api/jobs', { engine: 'codex', cwd: repo, prompt: 'Review ONLY the diff', label: 'full' }))
    expect(review.status).toBe(200)
    for (const created of [planned, review]) await pollUntilDone(app, ((await created.json()) as { id: string }).id)
  })
})

describe('chat jobs', () => {
  const chatBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ engine: 'claude', cwd: repo, prompt: 'Fix the login bug\nmore', purpose: 'chat', ...extra })
  const post = (app: Elysia, body: string) => app.handle(new Request('http://127.0.0.1:7777/api/jobs', { method: 'POST', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body }))

  test('a chat root takes its title from the first line and carries the chat env', async () => {
    const seen: EngineResolverParams[] = []
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, (params) => { seen.push(params); return { cmd: 'echo', args: [params.prompt], env: {} } })
    const response = await post(app, chatBody({ edit: true }))
    expect(response.status).toBe(200)
    const job = await response.json()
    expect(job.purpose).toBe('chat')
    expect(job.label).toBe('Fix the login bug')
    expect(job.edit).toBe(true)
    expect(seen[0]?.purpose).toBe('chat')
    expect(seen[0]?.edit).toBe(true)
    expect(seen[0]?.coreRules).toContain('Shikidan chat')
    expect(seen[0]?.coreRules).toContain(`Chat id ${job.id}`)
  })

  test('a chat job gets the cockpit address and its chat id in its env', async () => {
    const envResolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', 'echo "chat=$SKD_CHAT_ID url=$SKD_URL token=${#SKD_TOKEN}"'], env: {} })
    const app = buildApp(createJobManager({ home: homedir() }), envResolver)
    const root = await (await post(app, chatBody())).json()
    await pollUntilDone(app, root.id)
    const log = await (await app.handle(get(`/api/jobs/${root.id}/log`))).text()
    expect(log).toContain(`chat=${root.id} url=http://127.0.0.1:`)
    expect(log).not.toContain('token=0')
  })

  test('a chat needs a resumable engine and skips the spec lint', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    expect((await post(app, chatBody({ engine: 'glm' }))).status).toBe(200)
    expect((await post(app, chatBody({ engine: 'unknown-connection' }))).status).toBe(400)
  })

  test('a chat may name a project folder that is not a git repository', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const plain = await mkdtemp(join(homedir(), 'mc-chat-plain-'))
    try {
      const response = await post(app, chatBody({ project: plain }))
      expect(response.status).toBe(200)
      expect((await response.json()).project).toBe(await realpath(plain))
    } finally { await rm(plain, { recursive: true, force: true }) }
  })

  test('spawned jobs carry chatId/chatTurn/reason and are listed by ?chat=', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const root = await (await post(app, chatBody())).json()
    const spawned = await (await post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: executionPlan('Build it'), label: 'Build it', chat: root.id, chatTurn: root.id, reason: 'Codex · many small edits' }))).json()
    expect(spawned.chatId).toBe(root.id)
    expect(spawned.chatTurn).toBe(root.id)
    expect(spawned.reason).toBe('Codex · many small edits')
    await post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: 'unrelated', label: 'other' }))
    const listed = await (await app.handle(new Request(`http://127.0.0.1:7777/api/jobs?chat=${root.id}`, { headers: { host: '127.0.0.1:7777' } }))).json()
    expect(listed.jobs.map((job: { id: string }) => job.id).sort()).toEqual([root.id, spawned.id].sort())
  })

  test('a spawn naming a chat that does not exist is refused', async () => {
    const app = buildApp(createJobManager({ home: homedir() }), echoResolver)
    const worker = await (await post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: 'p', label: 'x' }))).json()
    for (const chat of ['nope', worker.id]) {
      expect((await post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: 'p', label: 'y', chat }))).status).toBe(400)
    }
    const root = await (await post(app, chatBody())).json()
    expect((await post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: 'p', label: 'y', chat: root.id, reason: 'x'.repeat(201) }))).status).toBe(400)
  })

  test('the fourth attempt at a step is refused', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const root = await (await post(app, chatBody())).json()
    const step = () => post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: executionPlan('Build it'), label: 'Build it', chat: root.id, chatTurn: root.id }))
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await step()).status).toBe(200)
    const fourth = await step()
    expect(fourth.status).toBe(409)
    expect((await fourth.json()).error).toContain('retry cap')
  })

  test('a review names an existing job, is marked reviewOf, and does not count toward the retry cap', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const root = await (await post(app, chatBody())).json()
    const step = (extra: Record<string, unknown> = {}) => post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: executionPlan('Build it'), label: 'Build it', chat: root.id, ...extra }))
    const first = await (await step()).json()
    for (let attempt = 0; attempt < 2; attempt += 1) expect((await step()).status).toBe(200)
    for (const reviewOf of ['nope', 42]) expect((await step({ reviewOf })).status).toBe(400)
    const review = await step({ reviewOf: first.id })
    expect(review.status).toBe(200)
    expect((await review.json()).reviewOf).toBe(first.id)
    expect((await step()).status).toBe(409)
  })

  test('the API token a chat job carries is redacted from its served log', async () => {
    const token = await readApiToken()
    const envResolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', 'echo "token=$SKD_TOKEN"'], env: {} })
    const app = buildApp(createJobManager({ home: homedir() }), envResolver)
    const root = await (await post(app, chatBody())).json()
    await pollUntilDone(app, root.id)
    const log = await (await app.handle(get(`/api/jobs/${root.id}/log`))).text()
    expect(log).toContain('token=[REDACTED]')
    expect(log).not.toContain(token)
  })

  test('a new chat in a project carries the memory of earlier chats there', async () => {
    const seen: EngineResolverParams[] = []
    const app = buildApp(createJobManager({ home: homedir() }), (params) => { seen.push(params); return { cmd: 'echo', args: [SESSION_LINE], env: {} } })
    const first = await (await post(app, chatBody({ project: repo, prompt: 'Login fix' }))).json()
    await pollUntilDone(app, first.id)
    const second = await (await post(app, chatBody({ project: repo, prompt: 'Next thing' }))).json()
    await pollUntilDone(app, second.id)
    expect(seen[0]?.coreRules).not.toContain('Login fix (today)')
    expect(seen[1]?.coreRules).toContain('Login fix (today)')
    const reply = await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${second.id}/reply`, { method: 'POST', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify({ message: 'go on' }) }))
    expect(reply.status).toBe(200)
    expect(seen[2]?.coreRules).toContain('Login fix (today)')
    await pollUntilDone(app, (await reply.json()).id)
  })

  test('the log stream redacts the API token', async () => {
    const token = await readApiToken()
    const envResolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', 'echo "token=$SKD_TOKEN"'], env: {} })
    const app = buildApp(createJobManager({ home: homedir() }), envResolver)
    const root = await (await post(app, chatBody())).json()
    await pollUntilDone(app, root.id)
    const controller = new AbortController()
    const response = await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${root.id}/stream`, { headers: { host: '127.0.0.1:7777' }, signal: controller.signal }))
    const reader = response.body!.getReader()
    const chunk = new TextDecoder().decode((await reader.read()).value)
    controller.abort()
    expect(chunk).toContain('token=[REDACTED]')
    expect(chunk).not.toContain(token)
  })

  test("landing a chat-spawned job clears that chat's waiting item", async () => {
    const attention = createAttentionStore(join(mkdtempSync(join(tmpdir(), 'mc-attention-')), 'attention.json'))
    const manager = createJobManager({ home: homedir() })
    const app = new Elysia().use(jobsRoutes(manager, echoResolver, { attention }))
    const root = await (await post(app, chatBody())).json()
    await attention.raise({ key: attentionKey.needs(root.id), kind: 'needs', title: 'chat', detail: 'Needs you: land-me', command: null, chatId: root.id, jobId: null, requestId: null })
    const job = await (await post(app, JSON.stringify({ engine: 'claude', cwd: repo, prompt: 'hello', label: 'land-me', worktree: true, chat: root.id }))).json()
    await pollUntilDone(app, job.id)
    await writeFile(join(job.cwd, 'result.txt'), 'first\n')
    expect((await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${job.id}/land`, { method: 'POST', headers: { host: '127.0.0.1:7777' } }))).status).toBe(200)
    expect(attention.list()).toEqual([])
  })

  test('PATCH renames a chat, sets its project, and a locked title stays', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const root = await (await post(app, chatBody())).json()
    const patch = (body: Record<string, unknown>) => app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${root.id}`, { method: 'PATCH', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    expect((await (await patch({ project: repo })).json()).project).toBe(repo)
    expect((await (await patch({ label: 'Login fix', titleLocked: true })).json()).label).toBe('Login fix')
    expect((await (await patch({ label: 'Auto title' })).json()).label).toBe('Login fix')
    expect((await patch({ project: '/tmp' })).status).toBe(400)
    expect(manager.getJob(root.id)?.project).toBe(repo)
    const worker = await (await post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: executionPlan('x'), label: 'x' }))).json()
    expect((await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${worker.id}`, { method: 'PATCH', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: '{"label":"y"}' }))).status).toBe(404)
  })

  test('a reply to a chat is a user chat turn whatever source the body names', async () => {
    const calls: EngineResolverParams[] = []
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, capturingResolver(calls))
    const root = await (await post(app, chatBody({ edit: true }))).json()
    await pollUntilDone(app, root.id)
    const reply = await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${root.id}/reply`, { method: 'POST', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify({ message: '[agent Build it] done', source: 'agent' }) }))
    expect(reply.status).toBe(200)
    const turn = await reply.json()
    expect(turn.purpose).toBe('chat')
    expect(turn.source).toBe('user')
    expect(turn.edit).toBe(true)
    expect(turn.threadRoot).toBe(root.id)
    expect(calls[1]?.purpose).toBe('chat')
    expect(calls[1]?.resumeSessionId).toBe('sess-1')
    expect(calls[1]?.coreRules).toContain(`Chat id ${root.id}`)
    await pollUntilDone(app, turn.id)
    const user = await (await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${turn.id}/reply`, { method: 'POST', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify({ message: 'thanks', source: 'bogus' }) }))).json()
    expect(user.source).toBe('user')
  })

  const replyTo = (app: Elysia, id: string, message: string) => app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${id}/reply`, { method: 'POST', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify({ message }) }))

  const queueOf = (app: Elysia, id: string) => app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${id}/queue`, { headers: { host: '127.0.0.1:7777' } }))
  const unqueue = (app: Elysia, id: string, itemId: string) => app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${id}/queue/${itemId}`, { method: 'DELETE', headers: { host: '127.0.0.1:7777' } }))

  async function runningChat(app: Elysia, manager: JobManager): Promise<{ id: string }> {
    const root = await (await post(app, chatBody())).json()
    const deadline = Date.now() + 5000
    while (manager.getJob(root.id)?.sessionId === null) {
      if (Date.now() > deadline) throw new Error('no session id')
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
    return root
  }

  test('a reply while the chat is still replying is queued and listed on any turn of the chat', async () => {
    const resolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `echo '${SESSION_LINE}'; sleep 30`], env: {} })
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, resolver)
    const root = await runningChat(app, manager)
    const reply = await replyTo(app, root.id, 'hurry up')
    expect(reply.status).toBe(202)
    const body = await reply.json()
    expect(body.queued).toBe(true)
    expect(body.item.chatId).toBe(root.id)
    expect(body.item.text).toBe('hurry up')
    expect(manager.listJobs()).toHaveLength(1)
    const listed = await (await queueOf(app, root.id)).json()
    expect(listed.items.map((item: { text: string }) => item.text)).toEqual(['hurry up'])
    expect(JSON.parse(await readFile(join(configDir, 'chat-queue.json'), 'utf8')).items).toHaveLength(1)
    await manager.killJob(root.id)
    await pollUntilDone(app, root.id)
  })

  test('DELETE removes a queued message and a missing one is a 404', async () => {
    const resolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `echo '${SESSION_LINE}'; sleep 30`], env: {} })
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, resolver)
    const root = await runningChat(app, manager)
    const { item } = await (await replyTo(app, root.id, 'never mind')).json()
    await replyTo(app, root.id, 'keep this')
    expect((await unqueue(app, root.id, item.id)).status).toBe(200)
    expect((await unqueue(app, root.id, item.id)).status).toBe(404)
    expect((await unqueue(app, 'nope', item.id)).status).toBe(404)
    expect((await queueOf(app, 'nope')).status).toBe(404)
    const listed = await (await queueOf(app, root.id)).json()
    expect(listed.items.map((entry: { text: string }) => entry.text)).toEqual(['keep this'])
    await manager.killJob(root.id)
    await pollUntilDone(app, root.id)
  })

  test('a reply to an idle chat sends earlier queued messages first, in order', async () => {
    const calls: EngineResolverParams[] = []
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, capturingResolver(calls))
    const root = await (await post(app, chatBody())).json()
    await pollUntilDone(app, root.id)
    const queue = createChatQueue(join(configDir, 'chat-queue.json'))
    await queue.add(root.id, 'first')
    await queue.add(root.id, 'second')
    const replyApp = buildApp(manager, capturingResolver(calls))
    const reply = await replyTo(replyApp, root.id, 'third')
    expect(reply.status).toBe(200)
    const turn = await reply.json()
    expect(turn.prompt).toBe('first\n\nsecond\n\nthird')
    expect((await (await queueOf(replyApp, root.id)).json()).items).toEqual([])
    await pollUntilDone(app, turn.id)
  })

  test('a reply rejected for a bad image keeps the queued messages', async () => {
    const calls: EngineResolverParams[] = []
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, capturingResolver(calls))
    const root = await (await post(app, chatBody())).json()
    await pollUntilDone(app, root.id)
    const queue = createChatQueue(join(configDir, 'chat-queue.json'))
    await queue.add(root.id, 'first')
    await queue.add(root.id, 'second')
    const replyApp = buildApp(manager, capturingResolver(calls))
    const rejected = await replyApp.handle(new Request(`http://127.0.0.1:7777/api/jobs/${root.id}/reply`, { method: 'POST', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify({ message: 'third', images: [{ path: join(configDir, 'missing.png') }] }) }))
    expect(rejected.status).toBe(400)
    const badMode = await replyApp.handle(new Request(`http://127.0.0.1:7777/api/jobs/${root.id}/reply`, { method: 'POST', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify({ message: 'third', permissionMode: 'yolo' }) }))
    expect(badMode.status).toBe(400)
    const items = (await (await queueOf(replyApp, root.id)).json()).items as Array<{ text: string }>
    expect(items.map(item => item.text)).toEqual(['first', 'second'])
  })

  test('a reply to a running non-chat job is still not queued', async () => {
    const resolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `echo '${SESSION_LINE}'; sleep 30`], env: {} })
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, resolver)
    const job = await (await post(app, JSON.stringify({ engine: 'claude', cwd: repo, prompt: 'p', label: 'plain' }))).json()
    const deadline = Date.now() + 5000
    while (manager.getJob(job.id)?.sessionId === null) {
      if (Date.now() > deadline) throw new Error('no session id')
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
    const reply = await replyTo(app, job.id, 'more')
    expect(reply.status).toBe(200)
    expect((await (await queueOf(app, job.id)).json()).items).toEqual([])
    for (const entry of manager.listJobs()) await manager.killJob(entry.id)
    for (const entry of manager.listJobs()) await pollUntilDone(app, entry.id)
  })

  test('a follow-up to a chat-spawned agent stays in the chat and is not a new attempt', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, capturingResolver([]))
    const root = await (await post(app, chatBody())).json()
    const step = () => post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: executionPlan('Build it'), label: 'Build it', chat: root.id, chatTurn: root.id, reason: 'Codex · edits' }))
    const agent = await (await step()).json()
    for (let attempt = 0; attempt < 2; attempt += 1) expect((await step()).status).toBe(200)
    await pollUntilDone(app, agent.id)
    const reply = await replyTo(app, agent.id, 'also add a test')
    expect(reply.status).toBe(200)
    const followUp = await reply.json()
    expect(followUp.chatId).toBe(root.id)
    expect(followUp.chatTurn).toBe(root.id)
    expect(followUp.reason).toBe('Codex · edits')
    expect(followUp.threadRoot).toBe(agent.id)
    const listed = await (await app.handle(new Request(`http://127.0.0.1:7777/api/jobs?chat=${root.id}`, { headers: { host: '127.0.0.1:7777' } }))).json()
    expect(listed.jobs.map((job: { id: string }) => job.id)).toContain(followUp.id)
    expect((await step()).status).toBe(409)
    for (const job of listed.jobs as Array<{ id: string }>) await pollUntilDone(app, job.id)
  })

  test('titleLocked can only be switched on', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const root = await (await post(app, chatBody())).json()
    const patch = (body: Record<string, unknown>) => app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${root.id}`, { method: 'PATCH', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    expect((await patch({ titleLocked: false })).status).toBe(400)
    expect((await patch({ label: 'Mine', titleLocked: true })).status).toBe(200)
    expect((await patch({ titleLocked: false, label: 'Theirs' })).status).toBe(400)
    expect((await (await patch({ label: 'Theirs' })).json()).label).toBe('Mine')
    expect(manager.getJob(root.id)?.titleLocked).toBe(true)
  })

  test('the listed current activity never shows the API token', async () => {
    const token = await readApiToken()
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `token=${token}` }] } })
    const app = buildApp(createJobManager({ home: homedir(), activityIntervalMs: 0 }), () => ({ cmd: '/bin/sh', args: ['-c', `echo '${line}'; sleep 30`], env: {} }))
    const job = await (await post(app, JSON.stringify({ engine: 'claude', cwd: repo, prompt: 'p', label: 'leaky' }))).json()
    const deadline = Date.now() + 5000
    let activity: string | null = null
    while (activity === null) {
      if (Date.now() > deadline) throw new Error('no activity')
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      const listed = await (await app.handle(new Request('http://127.0.0.1:7777/api/jobs', { headers: { host: '127.0.0.1:7777' } }))).json()
      activity = listed.jobs.find((entry: { id: string }) => entry.id === job.id)?.currentActivity ?? null
    }
    expect(activity).toContain('[REDACTED]')
    expect(activity).not.toContain(token.slice(0, 12))
    const feed = await (await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${job.id}/activity`, { headers: { host: '127.0.0.1:7777' } }))).json()
    expect(feed.currentActivity).not.toContain(token.slice(0, 12))
    await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${job.id}/kill`, { method: 'POST', headers: { host: '127.0.0.1:7777' } }))
    await pollUntilDone(app, job.id)
  })
})

describe('POST /api/jobs/:id/permission', () => {
  const requestLine = '{"type":"skd_permission_request","skd":true,"requestId":"r1","toolName":"Bash","title":"Claude wants to run a command","description":"To check","decisionReason":"","suppressAlways":false,"input":{"command":"bun test"}}'
  const askResolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `printf '%s\\n' '${requestLine}'; cat`], env: {}, control: true })

  test('rejects a bad body with 400 and an unknown job with 404', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    expect((await app.handle(post('/api/jobs/x/permission', {}))).status).toBe(400)
    expect((await app.handle(post('/api/jobs/x/permission', { requestId: 'r1', decision: 'maybe' }))).status).toBe(400)
    expect((await app.handle(post('/api/jobs/missing/permission', { requestId: 'r1', decision: 'deny' }))).status).toBe(404)
  })

  test('409 for a finished job or a request the log does not show as pending', async () => {
    const manager = createJobManager()
    const app = buildApp(manager, echoResolver)
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'done-job' }))
    const { id } = (await created.json()) as { id: string }
    await pollUntilDone(app, id)
    expect((await app.handle(post(`/api/jobs/${id}/permission`, { requestId: 'r1', decision: 'allow_once' }))).status).toBe(409)

    const running = buildApp(manager, sleepResolver)
    const live = await running.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'quiet-job' }))
    const { id: liveId } = (await live.json()) as { id: string }
    expect((await running.handle(post(`/api/jobs/${liveId}/permission`, { requestId: 'r1', decision: 'allow_once' }))).status).toBe(409)
    await manager.killJob(liveId)
  })

  test('409 once the request is already resolved, 200 while it waits', async () => {
    const manager = createJobManager()
    const app = buildApp(manager, askResolver)
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'ask-job' }))
    const { id } = (await created.json()) as { id: string }
    for (let attempt = 0; attempt < 50; attempt++) {
      const log = await readFile(manager.logPath(id), 'utf8').catch(() => '')
      if (log.includes('skd_permission_request')) break
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    const allowed = await app.handle(post(`/api/jobs/${id}/permission`, { requestId: 'r1', decision: 'allow_once' }))
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ ok: true })
    for (let attempt = 0; attempt < 50; attempt++) {
      const log = await readFile(manager.logPath(id), 'utf8').catch(() => '')
      if (log.includes('"decision":"allow_once"')) break
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    await appendFile(manager.logPath(id), '{"type":"skd_permission_resolved","skd":true,"requestId":"r1","decision":"allow_once"}\n')
    expect((await app.handle(post(`/api/jobs/${id}/permission`, { requestId: 'r1', decision: 'deny' }))).status).toBe(409)
    await manager.killJob(id)
  })

  test('a job asking permission puts it on the Waiting-on-you list, and answering clears it', async () => {
    const attention = createAttentionStore(join(mkdtempSync(join(tmpdir(), 'mc-attention-')), 'attention.json'))
    const events = attentionEvents(attention)
    const manager = createJobManager({ onPermissionRequest: (record, request) => { void events.permission(record, request) } })
    const app = new Elysia().use(jobsRoutes(manager, askResolver, { attention }))
    const { id } = (await (await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'ask-raise' }))).json()) as { id: string }
    for (let attempt = 0; attempt < 50 && attention.list().length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 40))
    expect(attention.list()).toMatchObject([{ key: attentionKey.permission(id, 'r1'), kind: 'permission', title: 'ask-raise', detail: 'Claude wants to run a command', command: 'bun test', jobId: id, requestId: 'r1' }])
    expect((await app.handle(post(`/api/jobs/${id}/permission`, { requestId: 'r1', decision: 'allow_once' }))).status).toBe(200)
    expect(attention.list()).toEqual([])
    await manager.killJob(id)
  })

  test('answering a request clears its Waiting-on-you item', async () => {
    const attention = createAttentionStore(join(mkdtempSync(join(tmpdir(), 'mc-attention-')), 'attention.json'))
    const manager = createJobManager()
    const app = new Elysia().use(jobsRoutes(manager, askResolver, { attention }))
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'ask-attention' }))
    const { id } = (await created.json()) as { id: string }
    for (let attempt = 0; attempt < 50; attempt++) {
      const log = await readFile(manager.logPath(id), 'utf8').catch(() => '')
      if (log.includes('skd_permission_request')) break
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    await attention.raise({ key: attentionKey.permission(id, 'r1'), kind: 'permission', title: 'ask-attention', detail: 'Claude wants to run a command', command: 'bun test', chatId: id, jobId: id, requestId: 'r1' })
    expect(attention.list().map(item => item.key)).toEqual([attentionKey.permission(id, 'r1')])
    expect((await app.handle(post(`/api/jobs/${id}/permission`, { requestId: 'r1', decision: 'allow_once' }))).status).toBe(200)
    expect(attention.list()).toEqual([])
    await manager.killJob(id)
  })
})

describe('chat images', () => {
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

  async function makeDrops(): Promise<string> {
    const drops = join(configDir, 'drops')
    await mkdir(drops, { recursive: true })
    return drops
  }

  test('accepts a PNG from drops, stores its media type and strips the path token from the prompt', async () => {
    const drops = await makeDrops()
    const path = join(drops, 'shot.png')
    await writeFile(path, pngBytes)
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: `look at ${path} and tell me`, purpose: 'chat', images: [{ path }] }))
    expect(response.status).toBe(200)
    const job = (await response.json()) as { id: string; prompt: string; images: Array<{ path: string; mediaType: string }> }
    expect(job.images[0]?.mediaType).toBe('image/png')
    expect(job.images[0]?.path).toBe(await realpath(path))
    expect(job.prompt).toBe('look at and tell me')
    const image = await app.handle(get(`/api/jobs/${job.id}/images/0`))
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect((await app.handle(get(`/api/jobs/${job.id}/images/5`))).status).toBe(404)
    expect((await app.handle(get(`/api/jobs/${job.id}/images/x`))).status).toBe(404)
  })

  test('rejects a text file named .png, an oversized image, nine images and a path outside drops', async () => {
    const drops = await makeDrops()
    const textPath = join(drops, 'fake.png')
    await writeFile(textPath, 'definitely not an image')
    const bigPath = join(drops, 'big.png')
    await writeFile(bigPath, Buffer.concat([pngBytes, Buffer.alloc(3_932_161 - pngBytes.length)]))
    const goodPath = join(drops, 'good.png')
    await writeFile(goodPath, pngBytes)
    const outsidePath = join(repo, 'outside.png')
    await writeFile(outsidePath, pngBytes)
    const app = buildApp(createJobManager(), echoResolver)
    const body = (path: string): Record<string, unknown> => ({ engine: 'claude', cwd: repo, prompt: 'look', purpose: 'chat', images: [{ path }] })
    expect(await (await app.handle(post('/api/jobs', body(textPath)))).json()).toEqual({ error: 'Image fake.png cannot be sent: it is not a PNG, JPEG, GIF or WebP image' })
    expect(await (await app.handle(post('/api/jobs', body(bigPath)))).json()).toEqual({ error: 'Image big.png cannot be sent: it is larger than 3.75 MB' })
    const nine = await app.handle(post('/api/jobs', { ...body(goodPath), images: Array.from({ length: 9 }, () => ({ path: goodPath })) }))
    expect(await nine.json()).toEqual({ error: 'An image list may hold at most 8 files' })
    expect(await (await app.handle(post('/api/jobs', body(outsidePath)))).json()).toEqual({ error: 'Image outside.png cannot be sent: attach it again' })
    expect((await app.handle(post('/api/jobs', body(join(drops, 'missing.png'))))).status).toBe(400)
  })

  test('a reply carries its images onto the new turn', async () => {
    const drops = await makeDrops()
    const path = join(drops, 'reply.png')
    await writeFile(path, pngBytes)
    const sessionResolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `echo '${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-img', resumeSupported: true })}'`], env: {} })
    const app = buildApp(createJobManager(), sessionResolver)
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'img-chat', purpose: 'chat' }))
    const { id } = (await created.json()) as { id: string }
    await pollUntilDone(app, id)
    const reply = await app.handle(post(`/api/jobs/${id}/reply`, { message: `check ${path}`, images: [{ path }] }))
    expect(reply.status).toBe(200)
    const turn = (await reply.json()) as { id: string; images: Array<{ mediaType: string }>; prompt: string }
    expect(turn.images[0]?.mediaType).toBe('image/png')
    expect(turn.prompt).toBe('check')
  })
})

describe('reply model and permission mode', () => {
  const sessionResolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `echo '${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-mode', resumeSupported: true })}'`], env: {} })

  test('a reply stores the model and permission mode it was given', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'mode-chat', purpose: 'chat', model: 'opus-first' }))
    const { id } = (await created.json()) as { id: string }
    await pollUntilDone(app, id)
    const reply = await app.handle(post(`/api/jobs/${id}/reply`, { message: 'again', model: 'opus-next', permissionMode: 'acceptEdits' }))
    expect(reply.status).toBe(200)
    const turn = (await reply.json()) as { model: string | null; permissionMode?: string }
    expect(turn.model).toBe('opus-next')
    expect(turn.permissionMode).toBe('acceptEdits')
    await pollUntilDone(app, turn.id)
    const inherited = await app.handle(post(`/api/jobs/${turn.id}/reply`, { message: 'once more' }))
    const nextTurn = (await inherited.json()) as { model: string | null; permissionMode?: string }
    expect(nextTurn.model).toBe('opus-next')
    expect(nextTurn.permissionMode).toBe('acceptEdits')
  })

  test('an unknown permission mode is rejected and the default is settings', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'mode-chat-2', purpose: 'chat' }))
    const { id } = (await created.json()) as { id: string }
    await pollUntilDone(app, id)
    expect((await app.handle(post(`/api/jobs/${id}/reply`, { message: 'x', permissionMode: 'yolo' }))).status).toBe(400)
    const reply = await app.handle(post(`/api/jobs/${id}/reply`, { message: 'ok' }))
    const turn = (await reply.json()) as { permissionMode?: string }
    expect(turn.permissionMode).toBe('settings')
  })
})

describe('GET /api/jobs/:id/commands', () => {
  test('returns the newest skd_commands line of the chat, or an empty list', async () => {
    const manager = createJobManager()
    const commandsResolver: EngineResolver = ({ prompt }) => ({ cmd: '/bin/sh', args: ['-c', `echo '{"type":"system","subtype":"init","session_id":"sess-cmds"}'; echo '{"type":"skd_commands","skd":true,"commands":[{"name":"review","description":"Review the current changes","argumentHint":""}]}'; echo "${prompt}"`], env: {} })
    const app = buildApp(manager, commandsResolver)
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'cmd-chat', purpose: 'chat' }))
    const { id } = (await created.json()) as { id: string }
    await pollUntilDone(app, id)
    const response = await app.handle(get(`/api/jobs/${id}/commands`))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ commands: [{ name: 'review', description: 'Review the current changes', argumentHint: '' }] })
    expect((await app.handle(get('/api/jobs/missing/commands'))).status).toBe(404)
    const plainApp = buildApp(manager, echoResolver)
    const bare = await plainApp.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'plain', label: 'plain-chat', purpose: 'chat' }))
    const { id: bareId } = (await bare.json()) as { id: string }
    await pollUntilDone(app, bareId)
    expect(await (await plainApp.handle(get(`/api/jobs/${bareId}/commands`))).json()).toEqual({ commands: [] })
  })
})

describe('live thread and stream offsets', () => {
  const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-live' })
  const streamLine = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half' } } })

  const resultLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
  const linesResolver: EngineResolver = () => ({
    cmd: '/bin/sh',
    args: ['-c', "printf '%s\\n' '" + initLine + "'; printf '%s\\n' '" + streamLine + "'; sleep 1.6; printf '%s\\n' '" + resultLine + "'"],
    env: {},
  })

  async function logSize(manager: JobManager, id: string): Promise<number> {
    return (await stat(manager.logPath(id))).size
  }

  test('a running chat reports a live turn whose offset ends on a line boundary', async () => {
    const manager = createJobManager()
    const app = buildApp(manager, linesResolver)
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'live-chat', purpose: 'chat' }))
    const { id } = (await created.json()) as { id: string }
    await new Promise((resolve) => setTimeout(resolve, 300))
    const thread = await (await app.handle(get(`/api/jobs/${id}/thread`))).json() as { live: { jobId: string; offset: number; partial: boolean } | null }
    expect(thread.live).not.toBeNull()
    expect(thread.live?.jobId).toBe(id)
    expect(thread.live?.partial).toBe(true)
    const raw = await readFile(manager.logPath(id), 'utf8')
    expect(raw[Number(thread.live?.offset) - 1]).toBe('\n')
    await manager.killJob(id).catch(() => undefined)
  }, 10000)

  test('an offset stream never emits a partial line and rejects bad offsets', async () => {
    const manager = createJobManager()
    const app = buildApp(manager, linesResolver)
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'live-chat-2', purpose: 'chat' }))
    const { id } = (await created.json()) as { id: string }
    await new Promise((resolve) => setTimeout(resolve, 250))
    const size = (await stat(manager.logPath(id))).size
    expect((await app.handle(get(`/api/jobs/${id}/stream?offset=${size + 1}`))).status).toBe(400)
    expect((await app.handle(get(`/api/jobs/${id}/stream?offset=-2`))).status).toBe(400)
    expect((await app.handle(get(`/api/jobs/${id}/stream?offset=abc`))).status).toBe(400)
    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${server.server?.port}`
    try {
      const response = await fetch(`${base}/api/jobs/${id}/stream?offset=0`)
      expect(response.status).toBe(200)
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let collected = ''
      const deadline = Date.now() + 3000
      while (!collected.includes('stream_event') && Date.now() < deadline) {
        const next = await Promise.race([reader.read(), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250))])
        if (next === undefined || next.done) continue
        collected += decoder.decode(next.value)
        for (const line of collected.replace(/^data: /gm, '').split('\n')) {
          if (line.startsWith('{') && line.endsWith('}')) expect(() => JSON.parse(line)).not.toThrow()
        }
      }
      await reader.cancel().catch(() => undefined)
      expect(collected).toContain('stream_event')
    } finally {
      server.stop(true)
    }
    await manager.killJob(id).catch(() => undefined)
  }, 12000)

  async function finishedJob(app: Elysia): Promise<string> {
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'log-owner', label: 'log-owner' }))
    const { id } = (await created.json()) as { id: string }
    await pollUntilDone(app, id)
    return id
  }

  async function collectSse(response: Response, done: (text: string) => boolean, timeoutMs = 3000): Promise<{ text: string; reader: ReadableStreamDefaultReader<Uint8Array> }> {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + timeoutMs
    while (!done(text) && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100))])
      if (next === undefined || next.done) continue
      text += decoder.decode(next.value, { stream: true })
    }
    return { text, reader }
  }

  const dataLines = (sse: string): string[] => sse.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: ').map(line => line.slice('data: '.length))

  test('an offset stream counts bytes, so Thai text and dashes arrive once and whole', async () => {
    const manager = createJobManager()
    const app = buildApp(manager, echoResolver)
    const id = await finishedJob(app)
    const line1 = JSON.stringify({ n: 1, text: 'สวัสดี — one' })
    const line2 = JSON.stringify({ n: 2, text: 'สวัสดี — two' })
    const line3 = JSON.stringify({ n: 3, text: 'สวัสดี — three' })
    const line4 = JSON.stringify({ n: 4, text: 'สวัสดี — four' })
    await writeFile(manager.logPath(id), `${line1}\n${line2}\n`)
    const controller = new AbortController()
    const response = await app.handle(new Request(`http://localhost/api/jobs/${id}/stream?offset=${Buffer.byteLength(`${line1}\n`)}`, { signal: controller.signal }))
    expect(response.status).toBe(200)
    const first = await collectSse(response, text => text.includes('"n":2'))
    await appendFile(manager.logPath(id), `${line3}\n`)
    let text = first.text
    const decoder = new TextDecoder()
    const deadline = Date.now() + 3000
    while (!text.includes('"n":3') && Date.now() < deadline) {
      const next = await Promise.race([first.reader.read(), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100))])
      if (next !== undefined && !next.done) text += decoder.decode(next.value, { stream: true })
    }
    const tail = Buffer.from(`${line4}\n`)
    const insideThaiChar = Buffer.byteLength('{"n":4,"text":"') + 1
    await appendFile(manager.logPath(id), tail.subarray(0, insideThaiChar))
    await new Promise((resolve) => setTimeout(resolve, 300))
    await appendFile(manager.logPath(id), tail.subarray(insideThaiChar))
    const end = Date.now() + 3000
    while (!text.includes('"n":4') && Date.now() < end) {
      const next = await Promise.race([first.reader.read(), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100))])
      if (next !== undefined && !next.done) text += decoder.decode(next.value, { stream: true })
    }
    controller.abort()
    await first.reader.cancel().catch(() => undefined)
    expect(dataLines(text)).toEqual([line2, line3, line4])
  })

  test('the stream without an offset keeps its original tail-then-append behaviour', async () => {
    const manager = createJobManager()
    const app = buildApp(manager, echoResolver)
    const id = await finishedJob(app)
    await writeFile(manager.logPath(id), 'alpha\nสวัสดี — beta\nno newline yet')
    const controller = new AbortController()
    const response = await app.handle(new Request(`http://localhost/api/jobs/${id}/stream`, { signal: controller.signal }))
    const initial = await collectSse(response, text => text.endsWith('\n\n'))
    expect(initial.text).toBe('data: alpha\ndata: สวัสดี — beta\ndata: no newline yet\n\n')
    await appendFile(manager.logPath(id), '\nlast line without newline')
    let text = ''
    const decoder = new TextDecoder()
    const deadline = Date.now() + 3000
    while (!text.includes('last line') && Date.now() < deadline) {
      const next = await Promise.race([initial.reader.read(), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100))])
      if (next !== undefined && !next.done) text += decoder.decode(next.value, { stream: true })
    }
    controller.abort()
    await initial.reader.cancel().catch(() => undefined)
    expect(text).toBe('data: \ndata: last line without newline\n\n')
  })

  test('the live turn and its messages come from one read, so text written in between is not lost', async () => {
    const hello = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'สวัสดี — hello' }] } })
    const late = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'late words' }] } })
    const resolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `printf '%s\\n' '${initLine}'; printf '%s\\n' '${hello}'; sleep 30`], env: {} })
    const manager = createJobManager()
    let reads = 0
    const readLogBytes = async (path: string): Promise<Uint8Array> => {
      reads += 1
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
      await appendFile(path, `${late}\n`)
      return bytes
    }
    const app = new Elysia().use(jobsRoutes(manager, resolver, { readLogBytes }))
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'live-gap', purpose: 'chat' }))
    const { id } = (await created.json()) as { id: string }
    const deadline = Date.now() + 3000
    while (!(await readFile(manager.logPath(id), 'utf8').catch(() => '')).includes('hello') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30))
    const before = Buffer.byteLength(await readFile(manager.logPath(id), 'utf8'))
    const thread = await (await app.handle(get(`/api/jobs/${id}/thread`))).json() as { live: { offset: number } | null; messages: Array<{ kind: string; text: string }> }
    expect(reads).toBe(1)
    expect(thread.live?.offset).toBe(before)
    const texts = thread.messages.filter(message => message.kind === 'text').map(message => message.text)
    expect(texts).toEqual(['สวัสดี — hello'])
    const rest = (await readFile(manager.logPath(id))).subarray(Number(thread.live?.offset)).toString('utf8')
    expect(rest).toBe(`${late}\n`)
    await manager.killJob(id).catch(() => undefined)
  }, 10000)
})

describe('chat menu actions', () => {
  const sessionResolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `echo '${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-menu' })}'; echo '${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Worked.' }] } })}'`], env: {} })

  async function chatWithTurn(): Promise<{ app: Elysia; manager: JobManager; id: string }> {
    const manager = createJobManager()
    const app = new Elysia().use(jobsRoutes(manager, sessionResolver)).use(historyRoutes({ manager, registry: { list: () => [], ended: () => [] } }))
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'first question', label: 'Export me now', purpose: 'chat' }))
    const { id } = (await created.json()) as { id: string }
    await pollUntilDone(app, id)
    return { app, manager, id }
  }

  test('pinning sets the flag the history feed reports', async () => {
    const { app, id } = await chatWithTurn()
    expect(await (await app.handle(post(`/api/jobs/${id}/permission`, {}))).status).toBe(400)
    const patched = await app.handle(new Request(`http://localhost/api/jobs/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned: true }) }))
    expect(patched.status).toBe(200)
    const history = await (await app.handle(get('/api/history'))).json() as { items: Array<{ kind: string; id: string; pinned?: boolean }> }
    expect(history.items.find(item => item.id === id)?.pinned).toBe(true)
    expect((await app.handle(new Request(`http://localhost/api/jobs/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned: 'yes' }) }))).status).toBe(400)
  })

  test('a deleted chat leaves the history feed and its thread reads gone', async () => {
    const { app, id } = await chatWithTurn()
    const gone = await app.handle(new Request(`http://localhost/api/jobs/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deleted: true }) }))
    expect(gone.status).toBe(200)
    const history = await (await app.handle(get('/api/history'))).json() as { items: Array<{ id: string }> }
    expect(history.items.some(item => item.id === id)).toBe(false)
    expect((await app.handle(get(`/api/jobs/${id}/thread`))).status).toBe(404)
    expect((await app.handle(new Request(`http://localhost/api/jobs/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deleted: false }) }))).status).toBe(400)
  })

  test('a running chat refuses deletion', async () => {
    const manager = createJobManager()
    const app = buildApp(manager, sleepResolver)
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'busy', purpose: 'chat' }))
    const { id } = (await created.json()) as { id: string }
    const response = await app.handle(new Request(`http://localhost/api/jobs/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deleted: true }) }))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Stop the reply first' })
    await manager.killJob(id)
  })

  test('export renders the chat as markdown with a slug filename', async () => {
    const { app, id } = await chatWithTurn()
    const response = await app.handle(get(`/api/jobs/${id}/export.md`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="export-me-now.md"')
    const body = await response.text()
    expect(body.startsWith('# Export me now')).toBe(true)
    expect(body).toContain('## You')
    expect(body).toContain('first question')
    expect(body).toContain('## Assistant')
    expect(body).toContain('Worked.')
    expect((await app.handle(get(`/api/jobs/${id}/export.md?leaf=missing`))).status).toBe(404)
    expect((await app.handle(get('/api/jobs/nope/export.md'))).status).toBe(404)
  })
})

describe('thread usage meter', () => {
  test('reports the newest context percentage and cumulative cost for a claude chat', async () => {
    const usageResolver: EngineResolver = () => ({
      cmd: '/bin/sh',
      args: ['-c', `printf '%s\\n' '${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-usage' })}'; printf '%s\\n' '${JSON.stringify({ type: 'skd_context', skd: true, percentage: 47, totalTokens: 94000, maxTokens: 200000 })}'; printf '%s\\n' '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'first', total_cost_usd: 0.5 })}'`],
      env: {},
    })
    const manager = createJobManager()
    const app = buildApp(manager, usageResolver)
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'usage-chat', purpose: 'chat' }))
    const { id } = (await created.json()) as { id: string }
    await pollUntilDone(app, id)
    const thread = await (await app.handle(get(`/api/jobs/${id}/thread`))).json() as { usage: { contextPercent: number | null; costUsd: number | null } }
    expect(thread.usage).toEqual({ contextPercent: 47, costUsd: 0.5 })
  })

  test('still reads the legacy mc_context line from a log written before Shikidan', async () => {
    const legacyResolver: EngineResolver = () => ({
      cmd: '/bin/sh',
      args: ['-c', `printf '%s\\n' '${JSON.stringify({ type: 'mc_context', mc: true, percentage: 33, totalTokens: 66000, maxTokens: 200000 })}'; printf '%s\\n' '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'old', total_cost_usd: 0.25 })}'`],
      env: {},
    })
    const app = buildApp(createJobManager(), legacyResolver)
    const created = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'legacy-usage-chat', purpose: 'chat' }))
    const { id } = (await created.json()) as { id: string }
    await pollUntilDone(app, id)
    const thread = await (await app.handle(get(`/api/jobs/${id}/thread`))).json() as { usage: { contextPercent: number | null; costUsd: number | null } }
    expect(thread.usage).toEqual({ contextPercent: 33, costUsd: 0.25 })
  })

  test('a glm chat reports context but no cost, and the newest result wins', async () => {
    const usageResolver: EngineResolver = () => ({
      cmd: '/bin/sh',
      args: ['-c', `printf '%s\\n' '${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-usage-2' })}'; printf '%s\\n' '${JSON.stringify({ type: 'skd_context', skd: true, percentage: 62, totalTokens: 124000, maxTokens: 200000 })}'; printf '%s\\n' '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'a', total_cost_usd: 0.5 })}'; printf '%s\\n' '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'b', total_cost_usd: 0.84 })}'`],
      env: {},
    })
    const manager = createJobManager()
    const app = buildApp(manager, usageResolver)
    const created = await app.handle(post('/api/jobs', { engine: 'glm', cwd: repo, prompt: 'hi', label: 'usage-glm', purpose: 'chat' }))
    const { id } = (await created.json()) as { id: string }
    await pollUntilDone(app, id)
    const thread = await (await app.handle(get(`/api/jobs/${id}/thread`))).json() as { usage: { contextPercent: number | null; costUsd: number | null } }
    expect(thread.usage).toEqual({ contextPercent: 62, costUsd: null })
  })
})

describe('versions and branches', () => {
  const line = (value: unknown): string => `printf '%s\\n' '${JSON.stringify(value).replace(/'/g, "'\\''")}'`
  const treeResolver: EngineResolver = ({ prompt }) => ({
    cmd: '/bin/sh',
    args: ['-c', [
      line({ type: 'system', subtype: 'init', session_id: `sess-${prompt}`, resumeSupported: true }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `reply ${prompt}` }] }, uuid: `u-${prompt}`, parent_tool_use_id: null }),
      line({ type: 'result', subtype: 'success', is_error: false, result: `reply ${prompt}`, total_cost_usd: 0.1 }),
    ].join('; ')],
    env: {},
  })
  const bareResolver: EngineResolver = ({ prompt }) => ({
    cmd: '/bin/sh',
    args: ['-c', [
      line({ type: 'system', subtype: 'init', session_id: `sess-${prompt}`, resumeSupported: true }),
      line({ type: 'result', subtype: 'success', is_error: false, result: 'no uuids here', uuid: 'result-only' }),
    ].join('; ')],
    env: {},
  })

  async function settle(app: Elysia, id: string): Promise<void> {
    await pollUntilDone(app, id)
  }

  test('a legacy chat threads in order and a replace forks from the kept turn', async () => {
    const spawns: Array<{ prompt?: string; resumeSessionId?: string; forkSession?: boolean; resumeSessionAt?: string }> = []
    const recording: EngineResolver = async (params) => {
      spawns.push({ prompt: params.prompt, resumeSessionId: params.resumeSessionId, forkSession: params.forkSession, resumeSessionAt: params.resumeSessionAt })
      return await treeResolver(params)
    }
    const app = buildApp(createJobManager(), recording)
    const first = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'one', label: 'tree-chat', purpose: 'chat' }))
    const root = ((await first.json()) as { id: string }).id
    await settle(app, root)
    const second = await app.handle(post(`/api/jobs/${root}/reply`, { message: 'two' }))
    const turn2 = ((await second.json()) as { id: string }).id
    await settle(app, turn2)
    const third = await app.handle(post(`/api/jobs/${root}/reply`, { message: 'three' }))
    const turn3 = ((await third.json()) as { id: string }).id
    await settle(app, turn3)

    const replies = (payload: { messages: Array<{ kind: string; text: string }> }): string[] => payload.messages.filter(message => message.kind === 'text').map(message => message.text)
    const legacy = await (await app.handle(get(`/api/jobs/${root}/thread`))).json() as { messages: Array<{ kind: string; text: string }>; versions: Record<string, unknown>; branchPoints: unknown[]; leaf: string }
    expect(replies(legacy)).toEqual(['reply one', 'reply two', 'reply three'])
    expect(legacy.versions).toEqual({})
    expect(legacy.branchPoints).toEqual([])
    expect(legacy.leaf).toBe(turn3)

    const edited = await app.handle(post(`/api/jobs/${root}/reply`, { message: 'two revised', from: { turnId: turn2, mode: 'replace' } }))
    expect(edited.status).toBe(200)
    const version = (await edited.json()) as { id: string; prevTurnId: string | null; versionOf: string }
    expect(version.versionOf).toBe(turn2)
    expect(version.prevTurnId).toBe(root)
    expect(spawns.at(-1)).toMatchObject({ prompt: 'two revised', resumeSessionId: 'sess-one', forkSession: true, resumeSessionAt: 'u-one' })
    await settle(app, version.id)

    const thread = await (await app.handle(get(`/api/jobs/${root}/thread`))).json() as { versions: Record<string, { index: number; count: number }>; leaf: string; messages: Array<{ kind: string; text: string }> }
    expect(thread.versions[turn2]).toMatchObject({ index: 1, count: 2 })
    expect(thread.versions[version.id]).toMatchObject({ index: 2, count: 2 })
    expect(thread.leaf).toBe(version.id)
    expect(replies(thread)).toEqual(['reply one', 'reply two revised'])

    const branched = await app.handle(post(`/api/jobs/${root}/reply`, { message: 'go left instead', from: { turnId: root, mode: 'after' } }))
    expect(branched.status).toBe(200)
    const branch = (await branched.json()) as { id: string; prevTurnId: string; branchFrom: string }
    expect(branch.prevTurnId).toBe(root)
    expect(branch.branchFrom).toBe(root)
    await settle(app, branch.id)
    const withBranch = await (await app.handle(get(`/api/jobs/${root}/thread?leaf=${branch.id}`))).json() as { branchPoints: Array<{ turnId: string; label: string; mainLeaf: string }> }
    expect(withBranch.branchPoints).toEqual([{ turnId: branch.id, label: 'go left instead', mainLeaf: version.id }])
  })

  test('a stale leaf resolves to the newest leaf under it for the thread and the next reply', async () => {
    const app = buildApp(createJobManager(), treeResolver)
    const first = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'one', label: 'stale-leaf', purpose: 'chat' }))
    const root = ((await first.json()) as { id: string }).id
    await settle(app, root)
    const second = await app.handle(post(`/api/jobs/${root}/reply`, { message: 'two' }))
    const turn2 = ((await second.json()) as { id: string }).id
    await settle(app, turn2)
    const edited = await app.handle(post(`/api/jobs/${root}/reply`, { message: 'two revised', from: { turnId: turn2, mode: 'replace' } }))
    await settle(app, ((await edited.json()) as { id: string }).id)

    const fromOld = await app.handle(post(`/api/jobs/${root}/reply`, { message: 'three', parentTurnId: turn2 }))
    expect(fromOld.status).toBe(200)
    const turn3 = ((await fromOld.json()) as { id: string }).id
    await settle(app, turn3)

    const texts = (payload: { messages: Array<{ kind: string; text: string }> }): string[] => payload.messages.filter(message => message.kind === 'text').map(message => message.text)
    const stale = await (await app.handle(get(`/api/jobs/${root}/thread?leaf=${turn2}`))).json() as { leaf: string; messages: Array<{ kind: string; text: string }> }
    expect(stale.leaf).toBe(turn3)
    expect(texts(stale)).toEqual(['reply one', 'reply two', 'reply three'])

    const next = await app.handle(post(`/api/jobs/${root}/reply`, { message: 'four', parentTurnId: turn2 }))
    expect(next.status).toBe(200)
    const turn4 = (await next.json()) as { id: string; prevTurnId: string }
    expect(turn4.prevTurnId).toBe(turn3)
    await settle(app, turn4.id)
  })

  test('export follows the active path, not every turn by start time', async () => {
    const app = buildApp(createJobManager(), treeResolver)
    const first = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'one', label: 'export-path', purpose: 'chat' }))
    const root = ((await first.json()) as { id: string }).id
    await settle(app, root)
    const second = await app.handle(post(`/api/jobs/${root}/reply`, { message: 'two', parentTurnId: root }))
    const turn2 = ((await second.json()) as { id: string }).id
    await settle(app, turn2)
    const edited = await app.handle(post(`/api/jobs/${root}/reply`, { message: 'two revised', from: { turnId: turn2, mode: 'replace' } }))
    const version = ((await edited.json()) as { id: string }).id
    await settle(app, version)

    const active = await (await app.handle(get(`/api/jobs/${root}/export.md`))).text()
    expect(active).toContain('reply two revised')
    expect(active).not.toContain('reply two\n')
    const older = await (await app.handle(get(`/api/jobs/${root}/export.md?leaf=${turn2}`))).text()
    expect(older).toContain('reply two\n')
    expect(older).not.toContain('two revised')
  })

  test('an unknown parentTurnId, a running chat and a uuid-less fork point are refused', async () => {
    const manager = createJobManager()
    const app = new Elysia().use(jobsRoutes(manager, treeResolver)).use(jobsRoutes(manager, treeResolver))
    const first = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'alpha', label: 'tree-refuse', purpose: 'chat' }))
    const root = ((await first.json()) as { id: string }).id
    await settle(app, root)
    const second = await app.handle(post(`/api/jobs/${root}/reply`, { message: 'beta' }))
    const turn2 = ((await second.json()) as { id: string }).id
    await settle(app, turn2)
    const stale = await app.handle(post(`/api/jobs/${root}/reply`, { message: 'late', parentTurnId: root }))
    expect(stale.status).toBe(200)
    const staleTurn = (await stale.json()) as { id: string; prevTurnId: string }
    expect(staleTurn.prevTurnId).toBe(turn2)
    await settle(app, staleTurn.id)
    const foreign = await app.handle(post(`/api/jobs/${root}/reply`, { message: 'x', parentTurnId: 'nope' }))
    expect(foreign.status).toBe(409)

    const bareApp = buildApp(createJobManager(), bareResolver)
    const bareRoot = await bareApp.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'bare', label: 'bare-chat', purpose: 'chat' }))
    const bareId = ((await bareRoot.json()) as { id: string }).id
    await settle(bareApp, bareId)
    const tooOld = await bareApp.handle(post(`/api/jobs/${bareId}/reply`, { message: 'branch it', from: { turnId: bareId, mode: 'after' } }))
    expect(tooOld.status).toBe(409)
    expect(await tooOld.json()).toEqual({ error: 'This reply is too old to branch from' })

    const runningApp = buildApp(createJobManager(), sleepResolver)
    const live = await runningApp.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'busy', label: 'busy-tree', purpose: 'chat' }))
    const liveId = ((await live.json()) as { id: string }).id
    const fromRunning = await runningApp.handle(post(`/api/jobs/${liveId}/reply`, { message: 'edit', from: { turnId: liveId, mode: 'replace' } }))
    expect(fromRunning.status).toBe(409)
    expect(await fromRunning.json()).toEqual({ error: 'Wait for the reply to finish' })
    await manager.killJob(liveId)
  })
})
