import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { JobManager, JobRecord } from '../server/jobs'
import { createJobManager, JOBS_FILE, LOGS_DIR, readLogFile } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { agentReport, createChatFlusher, projectMemory, RESTART_CATCH_UP, runNeedsReport, workflowReport } from '../server/chat-reports'
import type { ChatFlusherOptions } from '../server/chat-reports'
import { createChatQueue } from '../server/chat-queue'
import type { ChatQueue } from '../server/chat-queue'
import { initScratchGitRepo } from './support/scratch-git-repo'
import type { WorkflowAttempt, WorkflowRun } from '../server/workflow-runner'
import { classicWorkflow } from './support/classic-workflow'

const base: JobRecord = { id: 'j1', engine: 'codex', cwd: '/p', worktree: null, baseRepo: null, baseBranch: null, label: 'Build it', prompt: 'x', pid: 1, status: 'done', startedAt: 1, turns: 3, slowAt: null, lastTool: null, endedAt: 2, exitCode: 0, diffStat: ' 2 files changed', reviewedAt: null, sessionId: null, parentJobId: null, threadRoot: 'j1', terminalId: null, reviewOf: null, model: null, chatId: 'root' }
const textEvent = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

describe('agentReport', () => {
  test('a finished agent reports done with its last words and the diff', () => {
    const report = agentReport(base, `${textEvent('All tests pass.')}\n`)
    expect(report.message.startsWith('[agent Build it · codex] done')).toBe(true)
    expect(report.message).toContain('All tests pass.')
    expect(report.message).toContain('2 files changed')
    expect(report.needsYou).toBe(false)
  })
  test('a failure or a question needs you', () => {
    expect(agentReport({ ...base, status: 'failed', exitCode: 1 }, '').needsYou).toBe(true)
    expect(agentReport(base, `${textEvent('Which branch should I use?')}\n`).needsYou).toBe(true)
  })
  test('a failure names its exit code and a failed result event counts as failed', () => {
    expect(agentReport({ ...base, status: 'failed', exitCode: 2 }, '').message.startsWith('[agent Build it · codex] failed (exit 2)')).toBe(true)
    const reportedFailure = agentReport(base, `${JSON.stringify({ type: 'result', is_error: true })}\n`)
    expect(reportedFailure.needsYou).toBe(true)
    expect(reportedFailure.message).toContain('] failed')
  })
  test('a stopped agent reports stopped and does not need you', () => {
    const report = agentReport({ ...base, status: 'failed', exitCode: 143, stoppedAt: 5 }, `${textEvent('Should I go on?')}\n`)
    expect(report.message.startsWith('[agent Build it · codex] stopped')).toBe(true)
    expect(report.needsYou).toBe(false)
  })
  test('long last words are clipped and a multi-line label stays on one line', () => {
    const report = agentReport({ ...base, label: 'Build\nit', diffStat: null }, `${textEvent('y'.repeat(5000))}\n`)
    expect(report.message.startsWith('[agent Build it · codex] done\n')).toBe(true)
    expect(report.message.length).toBeLessThan(1300)
    expect(report.message).not.toContain('Diff:')
  })
})

const attempt = (nodeId: string, outcome: 'pass' | 'fail' | 'blocked' | null, summary = ''): WorkflowAttempt => ({ nodeId, number: 0, jobId: null, status: outcome ? 'settled' : 'running', prompt: '', startedAt: 1, endedAt: outcome ? 2 : null, result: outcome ? { outcome, summary, evidence: [] } : null, checks: [], output: '', workspace: null })
const runFixture = (fields: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'run-1', label: 'ship', cwd: '/p', request: 'Ship it',
  workflow: { ...classicWorkflow(), name: 'Shipping', revision: 'r1' } as unknown as WorkflowRun['workflow'],
  policy: {} as WorkflowRun['policy'], agents: {}, skills: {},
  status: 'done', error: null, currentNodeId: 'review',
  attempts: [attempt('plan', 'pass', 'Planned the change'), attempt('review', 'pass', 'No findings')],
  createdAt: 1, updatedAt: 2, chatId: 'root', reportedAt: null, ...fields,
})

describe('workflowReport', () => {
  test('a finished run reports its name, status and one line per attempt', () => {
    const report = workflowReport(runFixture())
    expect(report.message).toBe('[workflow Shipping · done]\nPlan · pass · Planned the change\nCross-family review · pass · No findings')
    expect(report.needsYou).toBe(false)
  })
  test('a failed or blocked run needs you and names its reason; a stopped run does not need you', () => {
    const failed = workflowReport(runFixture({ status: 'failed', error: 'Acceptance check failed: bun', attempts: [attempt('execute', 'fail', 'Tests\nfailed')] }))
    expect(failed.message).toBe('[workflow Shipping · failed]\nExecute · fail · Tests failed\nReason: Acceptance check failed: bun')
    expect(failed.needsYou).toBe(true)
    expect(workflowReport(runFixture({ status: 'blocked', error: 'limit' })).needsYou).toBe(true)
    const stopped = workflowReport(runFixture({ status: 'stopped', error: 'Stopped by user', attempts: [attempt('execute', null)] }))
    expect(stopped.message).toBe('[workflow Shipping · stopped]\nExecute · unfinished\nReason: Stopped by user')
    expect(stopped.needsYou).toBe(false)
  })
  test('an attempt made in a parallel path is prefixed with its path id', () => {
    const report = workflowReport(runFixture({ attempts: [{ ...attempt('plan', 'pass', 'Planned the change'), pathId: 'main' }, { ...attempt('execute', 'pass', 'Built the UI'), pathId: 'a3-2' }, { ...attempt('review', 'pass', 'No findings'), pathId: 'main' }] }))
    expect(report.message).toBe('[workflow Shipping · done]\nPlan · pass · Planned the change\na3-2 · Execute · pass · Built the UI\nCross-family review · pass · No findings')
  })
})

describe('runNeedsReport', () => {
  test('a run waiting for approval or paused is still live and is not reported yet', () => {
    expect(runNeedsReport(runFixture({ status: 'awaiting-approval' }))).toBe(false)
    expect(runNeedsReport(runFixture({ status: 'paused' }))).toBe(false)
    expect(runNeedsReport(runFixture({ status: 'done' }))).toBe(true)
  })
})

describe('projectMemory', () => {
  test('lists recent chats and agents of the same project, not this chat', async () => {
    const chats: JobRecord[] = [
      { ...base, id: 'c1', purpose: 'chat', project: '/p', label: 'Login fix', threadRoot: 'c1', chatId: undefined, startedAt: 10 },
      { ...base, id: 'c2', purpose: 'chat', project: '/p', label: 'This chat', threadRoot: 'c2', chatId: undefined, startedAt: 20 },
      { ...base, id: 'c3', purpose: 'chat', project: '/other', label: 'Other', threadRoot: 'c3', chatId: undefined, startedAt: 30 },
      { ...base, id: 'a1', label: 'Build it', status: 'done', startedAt: 15, cwd: '/p', chatId: 'c1' },
    ]
    const memory = await projectMemory(chats, '/p', 'c2', async () => `${textEvent('Fixed the redirect loop.')}\n`)
    expect(memory).toContain('Login fix')
    expect(memory).toContain('Fixed the redirect loop.')
    expect(memory).toContain('agent Build it (done)')
    expect(memory).not.toContain('This chat')
    expect(memory).not.toContain('Other')
  })
  test('keeps at most eight chats and eight agents, and leaves out this chat\'s own agents', async () => {
    const jobs: JobRecord[] = [
      ...Array.from({ length: 10 }, (_, index) => ({ ...base, id: `c${index}`, purpose: 'chat' as const, project: '/p', label: `Chat ${index}`, threadRoot: `c${index}`, chatId: undefined, startedAt: 100 + index })),
      ...Array.from({ length: 10 }, (_, index) => ({ ...base, id: `a${index}`, label: `Agent ${index}`, cwd: '/p', chatId: 'c0', startedAt: 200 + index })),
      { ...base, id: 'own', label: 'Own agent', cwd: '/p', chatId: 'here', startedAt: 999 },
    ]
    const lines = (await projectMemory(jobs, '/p', 'here', async () => '')).split('\n')
    expect(lines.filter((line) => line.startsWith('- Chat '))).toHaveLength(8)
    expect(lines.filter((line) => line.startsWith('- agent '))).toHaveLength(8)
    expect(lines.join('\n')).toContain('Chat 9')
    expect(lines.join('\n')).not.toContain('Chat 1 ')
    expect(lines.join('\n')).not.toContain('Own agent')
  })

  test('an empty project has no memory', async () => {
    expect(await projectMemory([], '/p', 'c1', async () => '')).toBe('')
  })
})

const SESSION_LINE = '{"type":"system","subtype":"init","session_id":"sess-1"}'
const sessionResolver: EngineResolver = () => ({ cmd: 'echo', args: [SESSION_LINE], env: {} })
const runningSessionResolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `echo '${SESSION_LINE}'; sleep 30`], env: {} })
const agentResolver = (text: string): EngineResolver => () => ({ cmd: 'echo', args: [textEvent(text)], env: {} })

describe('createChatFlusher', () => {
  let configDir: string
  let repo: string

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'mc-chat-reports-config-'))
    process.env.SKD_CONFIG_DIR = configDir
    repo = await mkdtemp(join(homedir(), 'mc-chat-reports-scratch-'))
    await initScratchGitRepo(repo)
  })

  afterEach(async () => {
    mock.restore()
    delete process.env.SKD_CONFIG_DIR
    await rm(configDir, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  })

  async function settled(manager: JobManager, id: string): Promise<JobRecord> {
    const deadline = Date.now() + 5000
    for (;;) {
      const job = manager.getJob(id)
      if (job !== undefined && job.status !== 'running' && (job.purpose !== 'chat' || job.sessionId !== null || job.status === 'failed')) return job
      if (Date.now() > deadline) throw new Error(`job ${id} did not settle`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
  }

  async function chatRoot(manager: JobManager, resolver = sessionResolver): Promise<JobRecord> {
    const result = await manager.createJob({ engine: 'claude', cwd: repo, prompt: 'Fix the login bug', label: 'Login fix', purpose: 'chat', project: repo }, resolver)
    if (!result.ok) throw new Error(result.error)
    return result.job
  }

  async function agent(manager: JobManager, chatId: string, text: string): Promise<JobRecord> {
    const result = await manager.createJob({ engine: 'codex', cwd: repo, prompt: 'p', label: 'Build it', chatId }, agentResolver(text))
    if (!result.ok) throw new Error(result.error)
    return settled(manager, result.job.id)
  }

  const logReader = (manager: JobManager) => async () => (id: string) => readLogFile(manager.logPath(id))
  const agentTurns = (manager: JobManager) => manager.listJobs().filter((job) => job.source === 'agent')
  const chatTurnsAfterRoot = (manager: JobManager, rootId: string) => manager.listJobs().filter((job) => job.threadRoot === rootId && job.id !== rootId)
  const queueFile = () => join(configDir, 'chat-queue.json')

  function flusherFor(manager: JobManager, opts: Partial<ChatFlusherOptions> = {}, queue: ChatQueue = createChatQueue(queueFile())) {
    return createChatFlusher(manager, sessionResolver, { logReader: logReader(manager), queue, bootAt: 0, ...opts })
  }

  async function waitForSession(manager: JobManager, id: string): Promise<void> {
    const deadline = Date.now() + 5000
    while (manager.getJob(id)?.sessionId === null) {
      if (Date.now() > deadline) throw new Error('no session id')
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
  }

  test('a settled agent posts an agent turn into its idle chat and is marked reported', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const worker = await agent(manager, root.id, 'All tests pass.')
    expect(worker.reportedAt).toBeNull()
    const notes: string[] = []
    const flusher = flusherFor(manager, { needsYou: (root, detail) => { notes.push(`${root.label}|${detail}`) } })
    await flusher.onAgentSettled(worker)
    const turn = agentTurns(manager)[0]
    expect(turn?.prompt.startsWith('[agent Build it · codex] done')).toBe(true)
    expect(turn?.prompt).toContain('All tests pass.')
    expect(turn?.threadRoot).toBe(root.id)
    expect(turn?.parentJobId).toBe(root.id)
    expect(turn?.purpose).toBe('chat')
    expect(notes).toEqual([])
    expect(typeof manager.getJob(worker.id)?.reportedAt).toBe('number')
    await settled(manager, turn!.id)
    await flusher.kick(root.id)
    expect(agentTurns(manager)).toHaveLength(1)
  })

  test('an agent that asks a question notifies that it needs you', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const worker = await agent(manager, root.id, 'Which branch should I use?')
    const notes: string[] = []
    await flusherFor(manager, { needsYou: (root, detail) => { notes.push(`${root.label}|${detail}`) } }).onAgentSettled(worker)
    expect(notes).toEqual(['Login fix|Needs you: Build it'])
    await settled(manager, agentTurns(manager)[0]!.id)
  })

  test('two agents settling together fold into one chat turn', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const first = await agent(manager, root.id, 'First done.')
    const second = await agent(manager, root.id, 'Second done.')
    const flusher = flusherFor(manager, { schedule: () => {} })
    await Promise.all([flusher.onAgentSettled(first), flusher.onAgentSettled(second)])
    const turns = agentTurns(manager)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt).toContain('First done.')
    expect(turns[0]?.prompt).toContain('Second done.')
    expect(turns[0]?.prompt).toContain('\n\n[agent Build it · codex] done')
    expect(turns[0]?.prompt).not.toContain(RESTART_CATCH_UP)
    await settled(manager, turns[0]!.id)
  })

  test('an agent started before this server run reads as a restart catch-up even when it settles now', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await chatRoot(manager, sessionResolver)
    await waitForSession(manager, root.id)
    await settled(manager, root.id)
    const worker = await agent(manager, root.id, 'Done while the server was down.')
    const flusher = flusherFor(manager, { bootAt: Date.now() + 1 })
    await flusher.onAgentSettled(worker)
    const turns = chatTurnsAfterRoot(manager, root.id)
    expect(turns[0]?.prompt.startsWith(RESTART_CATCH_UP)).toBe(true)
    await settled(manager, turns[0]!.id)
  })

  test('the report waits until the chat stops running, then posts', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await chatRoot(manager, runningSessionResolver)
    await waitForSession(manager, root.id)
    const worker = await agent(manager, root.id, 'Done.')
    const queued: Array<() => Promise<void>> = []
    const flusher = flusherFor(manager, { schedule: (retry) => { queued.push(retry) } })
    await flusher.onAgentSettled(worker)
    await flusher.onAgentSettled(worker)
    expect(queued).toHaveLength(1)
    expect(agentTurns(manager)).toHaveLength(0)
    await manager.killJob(root.id)
    await settled(manager, root.id)
    await queued[0]!()
    const turns = agentTurns(manager)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt.startsWith('[agent Build it · codex] done')).toBe(true)
    await settled(manager, turns[0]!.id)
  })

  test('a report past the retry limit keeps waiting, logs, and goes out when the chat is next idle', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const manager = createJobManager({ home: homedir() })
    const root = await chatRoot(manager, runningSessionResolver)
    await waitForSession(manager, root.id)
    const worker = await agent(manager, root.id, 'Which branch should I use?')
    const queued: Array<() => Promise<void>> = []
    const flusher = flusherFor(manager, { retryLimit: 1, schedule: (retry) => { queued.push(retry) } })
    await flusher.onAgentSettled(worker)
    await queued[0]!()
    expect(queued).toHaveLength(1)
    expect(agentTurns(manager)).toHaveLength(0)
    expect(manager.getJob(worker.id)?.reportedAt).toBeNull()
    expect(errors.mock.calls.some((call) => String(call[0]).includes(root.id) && String(call[0]).includes('Build it'))).toBe(true)
    await manager.killJob(root.id)
    await settled(manager, root.id)
    await flusher.kick(root.id)
    const turns = agentTurns(manager)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt).toContain('Which branch should I use?')
    await settled(manager, turns[0]!.id)
  })

  test('a chat without a session marks the report with a log line and a needs-you notice', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const manager = createJobManager({ home: homedir() })
    const root = await chatRoot(manager, () => ({ cmd: 'echo', args: ['no session'], env: {} }))
    const deadline = Date.now() + 5000
    while (manager.getJob(root.id)?.status === 'running') {
      if (Date.now() > deadline) throw new Error('root did not settle')
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
    const worker = await agent(manager, root.id, 'Should I land it?')
    const notes: string[] = []
    const flusher = flusherFor(manager, { needsYou: (root, detail) => { notes.push(`${root.label}|${detail}`) } })
    await flusher.onAgentSettled(worker)
    await flusher.kick(root.id)
    expect(agentTurns(manager)).toHaveLength(0)
    expect(notes).toEqual(['Login fix|Needs you: Build it'])
    expect(errors.mock.calls.some((call) => String(call[0]).includes(root.id))).toBe(true)
  })

  test('after twelve agent rounds in a row the chat waits for you instead of replying', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    for (let round = 0; round < 12; round += 1) {
      const turn = await manager.createJob({ engine: 'claude', cwd: repo, prompt: `[agent round ${round}]`, label: root.label, threadRoot: root.id, parentJobId: root.id, resumeSessionId: 'sess-1', purpose: 'chat', source: 'agent' }, sessionResolver)
      if (!turn.ok) throw new Error(turn.error)
      await settled(manager, turn.job.id)
    }
    const worker = await agent(manager, root.id, 'Done again.')
    const notes: string[] = []
    await flusherFor(manager, { needsYou: (root, detail) => { notes.push(`${root.label}|${detail}`) } }).onAgentSettled(worker)
    expect(agentTurns(manager)).toHaveLength(12)
    expect(notes).toEqual(['Login fix|Needs you: waiting after 12 agent rounds'])
    expect(errors.mock.calls.some((call) => String(call[0]).includes(root.id))).toBe(true)
  })

  test('a queued user message goes out even after twelve agent rounds, with the held report after it', async () => {
    spyOn(console, 'error').mockImplementation(() => {})
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    for (let round = 0; round < 12; round += 1) {
      const turn = await manager.createJob({ engine: 'claude', cwd: repo, prompt: `[agent round ${round}]`, label: root.label, threadRoot: root.id, parentJobId: root.id, resumeSessionId: 'sess-1', purpose: 'chat', source: 'agent' }, sessionResolver)
      if (!turn.ok) throw new Error(turn.error)
      await settled(manager, turn.job.id)
    }
    const worker = await agent(manager, root.id, 'Held report.')
    const queue = createChatQueue(queueFile())
    const flusher = flusherFor(manager, {}, queue)
    await flusher.onAgentSettled(worker)
    await queue.add(root.id, 'keep going')
    await flusher.kick(root.id)
    const turn = manager.listJobs().find((job) => job.source === 'user' && job.threadRoot === root.id && job.id !== root.id)
    expect(turn?.prompt.startsWith('keep going\n\n[agent Build it · codex] done')).toBe(true)
    await settled(manager, turn!.id)
  })

  test('queued messages become the next turn in order when the running turn settles, with a settled agent after them', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await chatRoot(manager, runningSessionResolver)
    await waitForSession(manager, root.id)
    const queue = createChatQueue(queueFile())
    const flusher = flusherFor(manager, { schedule: () => {} }, queue)
    await queue.add(root.id, 'first thing')
    await queue.add(root.id, 'second thing')
    const worker = await agent(manager, root.id, 'Agent finished.')
    await flusher.onAgentSettled(worker)
    await flusher.kick(root.id)
    expect(chatTurnsAfterRoot(manager, root.id)).toHaveLength(0)
    await manager.killJob(root.id)
    await settled(manager, root.id)
    await flusher.kick(root.id)
    const turns = chatTurnsAfterRoot(manager, root.id)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.source).toBe('user')
    expect(turns[0]?.prompt.startsWith('first thing\n\nsecond thing\n\n[agent Build it · codex] done')).toBe(true)
    expect(queue.list(root.id)).toEqual([])
    expect(createChatQueue(queueFile()).list(root.id)).toEqual([])
    expect(typeof manager.getJob(worker.id)?.reportedAt).toBe('number')
    await settled(manager, turns[0]!.id)
    await flusher.kick(root.id)
    expect(chatTurnsAfterRoot(manager, root.id)).toHaveLength(1)
  })

  test('recovery after a restart catches the chat up in one turn and leaves legacy agents alone', async () => {
    const rootId = 'root-1'
    const record = (fields: Record<string, unknown>) => JSON.stringify({ ...base, cwd: repo, pid: 999_999, startedAt: 1, endedAt: 2, diffStat: null, ...fields })
    await mkdir(join(configDir, LOGS_DIR), { recursive: true })
    await writeFile(join(configDir, JOBS_FILE), [
      record({ id: rootId, engine: 'claude', label: 'Login fix', purpose: 'chat', project: repo, threadRoot: rootId, chatId: undefined, sessionId: 'sess-1', source: 'user', edit: false }),
      record({ id: 'agent-1', label: 'Build it', chatId: rootId, threadRoot: 'agent-1', reportedAt: null, startedAt: 3, endedAt: 4 }),
      record({ id: 'legacy', label: 'Old work', chatId: rootId, threadRoot: 'legacy', startedAt: 5, endedAt: 6 }),
      '',
    ].join('\n'))
    await writeFile(join(configDir, LOGS_DIR, 'agent-1.log'), `${textEvent('Finished while you were away.')}\n`)
    const manager = createJobManager({ home: homedir() })
    const flusher = flusherFor(manager, { bootAt: Date.now() })
    await flusher.recoverAll()
    const turns = chatTurnsAfterRoot(manager, rootId)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt.startsWith(`${RESTART_CATCH_UP}\n[agent Build it · codex] done`)).toBe(true)
    expect(turns[0]?.prompt).toContain('Finished while you were away.')
    expect(turns[0]?.prompt).not.toContain('Old work')
    expect(turns[0]?.source).toBe('agent')
    expect(typeof manager.getJob('agent-1')?.reportedAt).toBe('number')
    await settled(manager, turns[0]!.id)
  })

  test('recovery sends messages that were queued before the restart', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    await createChatQueue(queueFile()).add(root.id, 'did you finish?')
    const flusher = flusherFor(manager)
    await flusher.recoverAll()
    const turns = chatTurnsAfterRoot(manager, root.id)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt).toBe('did you finish?')
    expect(turns[0]?.source).toBe('user')
    await settled(manager, turns[0]!.id)
  })

  test('a job with no chat, a workflow step, or a chat id that is not a chat root posts nothing', async () => {
    const manager = createJobManager({ home: homedir() })
    const worker = await agent(manager, 'missing', 'x')
    const flusher = flusherFor(manager, { schedule: () => { throw new Error('should not retry') } })
    await flusher.onAgentSettled(worker)
    await flusher.onAgentSettled({ ...worker, chatId: undefined })
    await flusher.onAgentSettled({ ...worker, chatId: worker.id })
    await flusher.kick('missing')
    expect(manager.listJobs()).toHaveLength(1)
  })

  test('a workflow step in a chat is not reported', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const step = await manager.createJob({ engine: 'codex', cwd: repo, prompt: 'p', label: 'Step', chatId: root.id, workflowRunId: 'run-1', workflowNodeId: 'n1', workflowAttempt: 1 }, agentResolver('step done'))
    if (!step.ok) throw new Error(step.error)
    const done = await settled(manager, step.job.id)
    expect(done.reportedAt).toBeUndefined()
    const flusher = flusherFor(manager)
    await flusher.onAgentSettled(done)
    await flusher.recoverAll()
    expect(agentTurns(manager)).toHaveLength(0)
  })

  function runSource(runs: WorkflowRun[]) {
    return {
      list: () => runs.map((run) => structuredClone(run)),
      get: (id: string) => { const run = runs.find((candidate) => candidate.id === id); return run ? structuredClone(run) : undefined },
      markReported: async (id: string, at: number) => { const run = runs.find((candidate) => candidate.id === id); if (run) run.reportedAt = at },
      markSessionNotified: async (id: string, number: number, at: number) => {
        notified.push([id, number])
        const target = runs.find((candidate) => candidate.id === id)?.attempts.find((candidate) => candidate.number === number)
        if (target) target.sessionNotifiedAt = at
      },
    }
  }
  const notified: [string, number][] = []
  beforeEach(() => { notified.length = 0 })

  const sessionRun = (fields: Partial<WorkflowRun> = {}): WorkflowRun => runFixture({
    status: 'running', reportedAt: null,
    workflow: { ...classicWorkflow(), revision: 'r1' } as unknown as WorkflowRun['workflow'],
    attempts: [{ ...attempt('plan', null), number: 0, inSession: true, sessionNotifiedAt: null }],
    ...fields,
  })

  test('a step waiting In Session in a chat-owned run nudges the chat once and marks the attempt notified', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const runs = [sessionRun({ chatId: root.id })]
    const notes: string[] = []
    const flusher = flusherFor(manager, { runs: runSource(runs), needsYou: (root, detail) => { notes.push(`${root.label}|${detail}`) } })
    await flusher.onSessionStep(runs[0]!)
    const turns = agentTurns(manager)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt).toBe('[workflow Plan, verify, execute, review · your turn] Plan is In Session. Read it with GET /api/studio/runs/run-1/steps/plan, do it here with the user, then report it: POST /api/studio/runs/run-1/steps/plan.')
    expect(notified).toEqual([['run-1', 0]])
    expect(typeof runs[0]!.attempts[0]!.sessionNotifiedAt).toBe('number')
    expect(runs[0]!.reportedAt).toBeNull()
    expect(notes).toEqual([])
    await settled(manager, turns[0]!.id)
    await flusher.onSessionStep(runs[0]!)
    await flusher.recoverAll()
    expect(agentTurns(manager)).toHaveLength(1)
  })

  test('a step waiting In Session in a terminal run or an already-notified attempt sends nothing', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const runs = [
      sessionRun({ id: 'terminal-run', chatId: undefined, terminalId: 't1' }),
      sessionRun({ id: 'told', chatId: root.id, attempts: [{ ...attempt('plan', null), inSession: true, sessionNotifiedAt: 5 }] }),
    ]
    const flusher = flusherFor(manager, { runs: runSource(runs) })
    await flusher.onSessionStep(runs[0]!)
    await flusher.onSessionStep(runs[1]!)
    expect(agentTurns(manager)).toHaveLength(0)
    expect(notified).toEqual([])
  })

  test('a nudge re-reads the run when it is sent and is skipped once the step no longer waits', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const runs = [sessionRun({ chatId: root.id })]
    const source = { ...runSource(runs), get: () => sessionRun({ chatId: root.id, attempts: [{ ...attempt('plan', null), status: 'checking', inSession: true, sessionNotifiedAt: null }] }) }
    const flusher = flusherFor(manager, { runs: source })
    await flusher.onSessionStep(runs[0]!)
    expect(agentTurns(manager)).toHaveLength(0)
    expect(notified).toEqual([])
  })

  test('a chat with no session to resume leaves the nudge unmarked', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const manager = createJobManager({ home: homedir() })
    const root = await chatRoot(manager, () => ({ cmd: 'echo', args: ['no session'], env: {} }))
    for (let i = 0; i < 250 && manager.getJob(root.id)?.status === 'running'; i++) await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    const runs = [sessionRun({ chatId: root.id })]
    await flusherFor(manager, { runs: runSource(runs) }).onSessionStep(runs[0]!)
    expect(agentTurns(manager)).toHaveLength(0)
    expect(notified).toEqual([])
    expect(runs[0]!.attempts[0]!.sessionNotifiedAt).toBeNull()
    errors.mockRestore()
  })

  test('recovery nudges a chat for a step that waits and was never notified', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const runs = [sessionRun({ chatId: root.id })]
    await flusherFor(manager, { runs: runSource(runs) }).recoverAll()
    expect(agentTurns(manager).map((turn) => turn.prompt.startsWith('[workflow Plan, verify, execute, review · your turn] Plan is In Session.'))).toEqual([true])
    expect(notified).toEqual([['run-1', 0]])
  })

  test('a settled In Session attempt is not a nudge', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const runs = [sessionRun({ chatId: root.id, attempts: [{ ...attempt('plan', 'pass', 'Planned'), inSession: true, sessionNotifiedAt: null }] })]
    const flusher = flusherFor(manager, { runs: runSource(runs) })
    await flusher.onSessionStep(runs[0]!)
    expect(agentTurns(manager)).toHaveLength(0)
  })

  test('a settled chat workflow run reports once as one turn and is marked reported', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const runs = [runFixture({ chatId: root.id })]
    const flusher = flusherFor(manager, { runs: runSource(runs) })
    await flusher.onRunSettled(runs[0]!)
    const turns = agentTurns(manager)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt.startsWith('[workflow Shipping · done]\nPlan · pass')).toBe(true)
    expect(typeof runs[0]!.reportedAt).toBe('number')
    await settled(manager, turns[0]!.id)
    await flusher.kick(root.id)
    expect(agentTurns(manager)).toHaveLength(1)
  })

  test('an agent report and a workflow run report fold into one turn', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const worker = await agent(manager, root.id, 'Agent finished.')
    const runs = [runFixture({ chatId: root.id })]
    const flusher = flusherFor(manager, { runs: runSource(runs), schedule: () => {} })
    await Promise.all([flusher.onAgentSettled(worker), flusher.onRunSettled(runs[0]!)])
    const turns = agentTurns(manager)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt).toContain('Agent finished.')
    expect(turns[0]?.prompt).toContain('\n\n[workflow Shipping · done]')
    await settled(manager, turns[0]!.id)
  })

  test('recovery catches up a workflow run started before this server run and leaves legacy and running runs alone', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const legacy = runFixture({ id: 'legacy', chatId: root.id, workflow: { ...runFixture().workflow, name: 'Old flow' } })
    delete legacy.reportedAt
    const runs = [
      runFixture({ chatId: root.id, status: 'failed', error: 'Tests failed', attempts: [attempt('execute', 'fail', 'Tests failed')] }),
      legacy,
      runFixture({ id: 'running', chatId: root.id, status: 'running', workflow: { ...runFixture().workflow, name: 'Still going' } }),
      runFixture({ id: 'other', chatId: undefined, workflow: { ...runFixture().workflow, name: 'No chat' } }),
    ]
    const notes: string[] = []
    const flusher = flusherFor(manager, { runs: runSource(runs), bootAt: Date.now(), needsYou: (root, detail) => { notes.push(`${root.label}|${detail}`) } })
    await flusher.recoverAll()
    const turns = chatTurnsAfterRoot(manager, root.id)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt.startsWith(`${RESTART_CATCH_UP}\n[workflow Shipping · failed]\nExecute · fail · Tests failed`)).toBe(true)
    for (const name of ['Old flow', 'Still going', 'No chat']) expect(turns[0]?.prompt).not.toContain(name)
    expect(notes).toEqual(['Login fix|Needs you: workflow Shipping'])
    expect(typeof runs[0]!.reportedAt).toBe('number')
    expect(runs[1]!.reportedAt).toBeUndefined()
    await settled(manager, turns[0]!.id)
  })
})
