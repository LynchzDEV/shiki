import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJobManager, type JobManager } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { createWorkflowStore, defaultWorkflow, draftRevision, type Workflow } from '../server/workflows'
import { changeSize, checkTail, covers, createWorkflowRunner, lineage, recheckNotes, RunActionError, type ResolvedAgent, type WorkflowAttempt, type WorkflowRun, type WorkflowRunner } from '../server/workflow-runner'
import * as worktrees from '../server/job-worktrees'
import { initScratchGitRepo } from './support/scratch-git-repo'
import { classicWorkflow } from './support/classic-workflow'
import { homeScratch, sweepHomeScratch } from './support/home-scratch'
import type { TerminalRecord } from '../server/terminals'
import type { Unavailable } from '../server/engine-availability'
import { recoverGraph, recoveryVerdict } from '../server/queue-recover'
import { mcUrl, writeConfig } from '../server/secrets'

let dir: string, repo: string, manager: JobManager, runner: WorkflowRunner, settledRuns: WorkflowRun[]
let down: (engine: string) => Unavailable | null = () => null
const report = (outcome = 'pass') => JSON.stringify({ type: 'result', result: `SKD_RESULT ${JSON.stringify({ outcome, summary: 'Completed fixture', evidence: ['fixture assertion'] })}` })
const resolver: EngineResolver = () => ({ cmd: '/bin/echo', args: [report()], env: {} })
beforeAll(sweepHomeScratch)
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-workflow-runner-'))
  repo = await mkdtemp(join(homedir(), 'mc-workflow-repo-'))
  process.env.SKD_CONFIG_DIR = dir
  down = () => null
  await initScratchGitRepo(repo)
})
afterEach(async () => {
  for (const run of runner?.list() ?? []) if (run.status === 'running') await runner.stop(run.id)
  for (const job of manager?.listJobs() ?? []) if (job.status === 'running') await manager.killJob(job.id)
  const deadline = Date.now() + 4000
  while (manager?.listJobs().some(job => job.status === 'running')) {
    if (Date.now() > deadline) throw new Error('Fixture jobs did not stop before cleanup')
    await Bun.sleep(20)
  }
  for (const job of manager?.listJobs() ?? []) await runner.onJobSettled(job)
  delete process.env.SKD_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})
async function build(agent: EngineResolver = resolver, approval = false) {
  const store = createWorkflowStore(dir)
  const classic = await store.get('classic').catch(() => store.save(classicWorkflow()))
  await store.setDefault(classic.id, classic.revision)
  const settled: WorkflowRun[] = []
  settledRuns = settled
  manager = createJobManager({ onJobSettled: job => { void runner.onJobSettled(job) } })
  runner = createWorkflowRunner({ manager, resolver: agent, store, base: dir, requireApproval: async () => approval, onRunSettled: run => { settled.push(run) }, availability: async ({ engine }) => down(engine) })
  return store
}
function withoutSession(): Workflow {
  const graph = classicWorkflow()
  graph.nodes[0]!.agent = { role: 'plan' }
  return graph
}
async function finished(id: string) {
  for (let i = 0; i < 200; i++) { const run = runner.get(id)!; if (!['running', 'paused', 'awaiting-approval'].includes(run.status)) return run; await Bun.sleep(20) }
  throw new Error('Run did not settle')
}
async function until(id: string, predicate: (run: WorkflowRun) => boolean) {
  for (let i = 0; i < 200; i++) { const run = runner.get(id)!; if (predicate(run)) return run; await Bun.sleep(20) }
  throw new Error('Run never reached the expected state')
}

test('default workflow skips the arena when the architect is confident, with pinned policy and no mandatory commits', async () => {
  await build()
  const started = await runner.start({ workflowId: 'default', cwd: repo, request: 'Inspect and implement the fixture', label: 'fixture' })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['explore', 'architect', 'verify-plan', 'execute', 'review'])
  expect(done.attempts.every(attempt => attempt.prompt.includes('Never dispatch'))).toBe(true)
  expect(manager.listJobs().every(job => job.workflowRunId === done.id)).toBe(true)
})

test('default workflow sends an unsure architect through the three-family design arena before the plan check', async () => {
  await homeConfig()
  let calls = 0
  await build(() => ({ cmd: '/bin/echo', args: [report(calls++ === 1 ? 'fail' : 'pass')], env: {} }))
  const started = await runner.start({ workflowId: 'default', cwd: repo, request: 'Design and implement the fixture', label: 'arena' }, { startedByUser: true })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  const visited = done.attempts.map(attempt => attempt.nodeId)
  expect(visited.slice(0, 3)).toEqual(['explore', 'architect', 'arena-brief'])
  expect(new Set(visited.slice(3, 6))).toEqual(new Set(['runner-claude', 'runner-glm', 'runner-codex']))
  expect(visited.slice(6)).toEqual(['arena-join', 'judge', 'pick', 'verify-plan', 'execute', 'review'])
  expect(done.attempts[1]!.result!.outcome).toBe('fail')
  const engineOf = (nodeId: string) => manager.listJobs().find(job => job.workflowNodeId === nodeId)!.engine
  expect(['runner-claude', 'runner-glm', 'runner-codex', 'judge'].map(engineOf)).toEqual(['claude', 'glm', 'codex', 'codex'])
})

test('terminal runs default to their pinned workflow, let a named workflow override it, and reject unknown terminals', async () => {
  const store = await build()
  const first = await store.save({ ...withoutSession(), id: 'terminal-workflow', name: 'Original terminal workflow' })
  const terminal: TerminalRecord = { id: 'terminal-a', engine: 'claude', cwd: repo, pid: 1, createdAt: 0, title: 'Terminal', sessionId: null, workflow: { id: first.id, name: first.name, revision: first.revision, selectedDefault: true } }
  runner = createWorkflowRunner({ manager, resolver, store, base: dir, terminals: { get: id => id === terminal.id ? terminal : undefined }, requireApproval: async () => false })
  const next = await store.save({ ...first, name: 'Changed after terminal opened' }, first.revision)
  await store.setDefault(next.id, next.revision)
  const input = { terminalId: terminal.id, cwd: repo, request: 'Inspect this project', label: 'terminal task' }
  await expect(runner.start({ ...input, terminalId: 'unknown' })).rejects.toThrow('Terminal not found')
  expect(manager.listJobs()).toHaveLength(0)
  const started = await runner.start(input)
  expect(started.workflow.revision).toBe(first.revision)
  expect(started.terminalId).toBe(terminal.id)
  expect((await finished(started.id)).status).toBe('done')
  expect(manager.listJobs().every(job => job.terminalId === terminal.id)).toBe(true)
  await store.save({ ...withoutSession(), id: 'named' })
  const named = await runner.start({ ...input, workflowId: 'named' })
  expect(named.workflow.id).toBe('named')
  await finished(named.id)
})

test('a terminal opened on a folder of repos runs its flow in a repo inside that folder, never outside it', async () => {
  const store = await build()
  const pinned = await store.save({ ...withoutSession(), id: 'folder-workflow' })
  const terminalAt = (cwd: string): TerminalRecord => ({ id: 'terminal-a', engine: 'claude', cwd, pid: 1, createdAt: 0, title: 'Terminal', sessionId: null, workflow: { id: pinned.id, name: pinned.name, revision: pinned.revision, selectedDefault: true } })
  const startIn = (terminalCwd: string) => {
    const terminal = terminalAt(terminalCwd)
    runner = createWorkflowRunner({ manager, resolver, store, base: dir, terminals: { get: id => id === terminal.id ? terminal : undefined }, requireApproval: async () => false })
    return runner.start({ terminalId: terminal.id, cwd: repo, request: 'Inspect this project', label: 'nested repo' })
  }
  const outside = await mkdtemp(join(tmpdir(), 'mc-other-folder-'))
  try {
    await expect(startIn(outside)).rejects.toThrow('inside this terminal')
    await expect(startIn(`${repo}-sibling`)).rejects.toThrow('inside this terminal')
  } finally { await rm(outside, { recursive: true, force: true }) }
  const started = await startIn(homedir())
  expect(started.terminalId).toBe('terminal-a')
  expect((await finished(started.id)).status).toBe('done')
})

test('free-form E2E nodes require real checks; a failing check overrides AI pass', async () => {
  const store = await build()
  const graph = await store.save({ ...classicWorkflow(), id: 'e2e', entry: 'test', nodes: [{ id: 'test', title: 'E2E', instructions: 'Test with Jev', checks: [{ command: '/usr/bin/false' }] }], edges: [] })
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Test checkout', label: 'e2e' })
  const done = await finished(run.id)
  expect(done.status).toBe('failed')
  expect(done.attempts[0]!.checks[0]!.exitCode).toBe(1)
})

test('missing structured evidence blocks progress even when process exits zero', async () => {
  await build(() => ({ cmd: '/bin/echo', args: ['All done'], env: {} }))
  const run = await runner.start({ cwd: repo, request: 'Inspect', label: 'missing-evidence' })
  expect((await finished(run.id)).status).toBe('blocked')
  expect(manager.listJobs()).toHaveLength(1)
})

test('custom blueprint revisions and policy changes cannot alter a retry', async () => {
  const store = await build(() => ({ cmd: '/bin/echo', args: [report('fail')], env: {} }))
  const first = await store.save({ ...classicWorkflow(), id: 'custom' })
  const run = await runner.start({ workflowId: first.id, cwd: repo, request: 'Inspect', label: 'retry' })
  await finished(run.id)
  await store.save({ ...first, name: 'New name' }, first.revision)
  await store.savePolicy('New policy\n{{core_rules}}\n{{workflow}}\n{{assignment}}')
  await runner.retry(run.id)
  const retried = await finished(run.id)
  expect(retried.workflow.revision).toBe(first.revision)
  expect(retried.policy.revision).toBe(run.policy.revision)
  expect(retried.attempts[1]!.prompt).not.toContain('New policy')
})

test('a running workflow reserves its workspace against other workflows and ordinary jobs', async () => {
  await build(() => ({ cmd: '/bin/sleep', args: ['2'], env: {} }))
  const run = await runner.start({ cwd: repo, request: 'Inspect', label: 'owner' })
  await expect(runner.start({ cwd: repo, request: 'Other', label: 'intruder' })).rejects.toThrow('running work')
  const job = await manager.createJob({ engine: 'claude', cwd: repo, prompt: 'Other', label: 'intruder' }, resolver)
  expect(job.ok).toBe(false)
  await runner.stop(run.id)
})

test('failure routing is bounded and does not turn an endless loop into success', async () => {
  const store = await build(() => ({ cmd: '/bin/echo', args: [report('fail')], env: {} }))
  const graph = await store.save({ ...classicWorkflow(), id: 'loop', entry: 'test', nodes: [{ id: 'test', title: 'Test', instructions: 'Check', maxVisits: 2 }], edges: [{ source: 'test', target: 'test', outcome: 'fail' }] })
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Test', label: 'loop' })
  const done = await finished(run.id)
  expect(done.status).toBe('blocked')
  expect(done.attempts).toHaveLength(3)
  expect(done.error).toBe('Test reached its 2-visit limit from Test')
})

const scripted = (script: Record<string, string[]>): EngineResolver => ({ prompt }) => {
  const step = /STEP-(\w+)/.exec(prompt)?.[1] ?? ''
  return { cmd: '/bin/echo', args: [report(script[step]?.shift() ?? 'pass')], env: {} }
}
const checkedGraph = (): Workflow => {
  const graph = withoutSession()
  const step = (id: string, kind: string, role: string, maxVisits = 3) => ({ id, title: id, kind, agent: { role }, instructions: `STEP-${id}`, maxVisits, position: { x: 0, y: 0 } })
  return { ...graph, id: 'checked', nodes: [graph.nodes[0]!, graph.nodes[1]!, step('execute', 'implement', 'execute'), step('accept', 'task', 'execute', 5), step('ui', 'task', 'execute'), step('review', 'review', 'review')] as Workflow['nodes'], edges: [
    { source: 'plan', target: 'verify-plan', outcome: 'pass' },
    { source: 'verify-plan', target: 'execute', outcome: 'pass' },
    { source: 'execute', target: 'accept', outcome: 'pass' },
    { source: 'accept', target: 'execute', outcome: 'fail' },
    { source: 'accept', target: 'ui', outcome: 'pass' },
    { source: 'ui', target: 'execute', outcome: 'fail' },
    { source: 'ui', target: 'review', outcome: 'pass' },
    { source: 'review', target: 'execute', outcome: 'fail' },
  ] }
}

test('each sender has its own visit budget', async () => {
  const store = await build(scripted({ accept: ['fail', 'fail'], ui: ['fail'], review: ['fail'] }))
  await store.save(checkedGraph())
  const run = await runner.start({ workflowId: 'checked', cwd: repo, request: 'Build it', label: 'budgets' })
  const done = await finished(run.id)
  expect(done.error).toBeNull()
  expect(done.status).toBe('done')
  expect(done.attempts.filter(attempt => attempt.nodeId === 'execute')).toHaveLength(5)
})

test('one sender still hits its limit', async () => {
  const store = await build(({ prompt }) => ({ cmd: '/bin/echo', args: [report(prompt.includes('Independently review') ? 'fail' : 'pass')], env: {} }))
  await store.save({ ...withoutSession(), id: 'reviewed' })
  const run = await runner.start({ workflowId: 'reviewed', cwd: repo, request: 'Build it', label: 'one sender' })
  const done = await finished(run.id)
  expect(done.status).toBe('blocked')
  expect(done.error).toContain('reached its 3-visit limit from')
})

test('a re-check after a fail carries the convergence note', async () => {
  let checks = 0
  const store = await build(({ prompt }) => ({ cmd: '/bin/echo', args: [report(prompt.includes('Verify the upstream plan') && checks++ === 0 ? 'fail' : 'pass')], env: {} }))
  await store.save({ ...withoutSession(), id: 'rechecked' })
  const run = await runner.start({ workflowId: 'rechecked', cwd: repo, request: 'Build it', label: 'recheck' })
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  const prompts = done.attempts.filter(attempt => attempt.nodeId === 'verify-plan').map(attempt => attempt.prompt)
  expect(prompts).toHaveLength(2)
  expect(prompts[0]).not.toContain('This is a re-check after your earlier fail')
  expect(prompts[1]).toContain('This is a re-check after your earlier fail')
  expect(done.attempts.find(attempt => attempt.nodeId === 'review')!.prompt).not.toContain('This is a re-check')
})

const assignmentOf = (prompt: string) => { const start = prompt.indexOf('{\n  "request"'); return JSON.parse(prompt.slice(start, prompt.indexOf('\n}', start) + 2)) }

test('a re-visit after a pass is scoped to the changes since the commit it last checked', async () => {
  const store = await build(scripted({ ui: ['fail'] }))
  await store.save(checkedGraph())
  const run = await runner.start({ workflowId: 'checked', cwd: repo, request: 'Build it', label: 'passed recheck' })
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  const accepts = done.attempts.filter(attempt => attempt.nodeId === 'accept')
  expect(assignmentOf(accepts[0]!.prompt).recheck).toBeUndefined()
  const passedNote = assignmentOf(accepts[1]!.prompt).recheck as string
  expect(passedNote).toContain('You already passed this step')
  expect(passedNote).toContain(`Your last visit checked ${accepts[0]!.workspace!.head}`)
  const uis = done.attempts.filter(attempt => attempt.nodeId === 'ui')
  const failedNote = assignmentOf(uis[1]!.prompt).recheck as string
  expect(failedNote).toContain('This is a re-check after your earlier fail')
  expect(failedNote).toContain(`Your last visit checked ${uis[0]!.workspace!.head}`)
})

test('only task steps after new implementation get the passed re-check note; plan checks, reviews and briefs after a pass run in full', () => {
  const passed = { result: { outcome: 'pass', summary: 'ok', evidence: ['x'] }, workspace: { head: 'abc', diffHash: 'h' } } as WorkflowAttempt
  expect(recheckNotes('task', passed, true).recheck).toContain('You already passed this step')
  expect(recheckNotes('task', passed, false)).toEqual({})
  expect(recheckNotes('verify-plan', passed, true)).toEqual({})
  expect(recheckNotes('review', passed, true)).toEqual({})
  expect(recheckNotes('implement', passed, true)).toEqual({})
  expect(recheckNotes('review', { ...passed, result: { ...passed.result!, outcome: 'fail' } }, false).recheck).toContain('This is a re-check after your earlier fail')
  expect(recheckNotes('task', undefined, true)).toEqual({})
})

test('a planner sent back by the plan check keeps the full output of the steps before it', async () => {
  let checks = 0
  const store = await build(({ prompt }) => ({ cmd: '/bin/echo', args: [report(prompt.includes('Verify the upstream plan') && checks++ === 0 ? 'fail' : 'pass')], env: {} }))
  const graph = withoutSession()
  await store.save({ ...graph, id: 'replan', entry: 'how', nodes: [stepOf('how', 'task'), ...graph.nodes] as Workflow['nodes'], edges: [{ source: 'how', target: 'plan', outcome: 'pass' }, ...graph.edges] })
  const run = await runner.start({ workflowId: 'replan', cwd: repo, request: 'Build it', label: 'replan' })
  const done = await finished(run.id)
  const plans = done.attempts.filter(attempt => attempt.nodeId === 'plan')
  expect(plans).toHaveLength(2)
  const how = (evidenceOf(plans[1]!.prompt) as Array<{ node: string; output?: string; older?: true }>).find(input => input.node === 'how')!
  expect(how.older).toBe(true)
  expect(how.output).toBeDefined()
})

test('a fix round resumes the implement session with only the failure, and keeps the full assignment on record', async () => {
  const calls: StepCall[] = []
  let uiFails = 1
  const store = await build(({ prompt, resumeSessionId }) => {
    calls.push({ prompt, resumeSessionId })
    const step = /STEP-(\w+)/.exec(prompt)?.[1] ?? ''
    return lines(...(step === 'execute' ? [sessionLine] : []), report(step === 'ui' && uiFails-- > 0 ? 'fail' : 'pass'))
  })
  await store.save(checkedGraph())
  const run = await runner.start({ workflowId: 'checked', cwd: repo, request: 'Build it', label: 'resumed fix' })
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  const resumed = calls.filter(call => call.resumeSessionId !== undefined)
  expect(resumed).toHaveLength(1)
  expect(resumed[0]!.resumeSessionId).toBe(STEP_SESSION)
  const uiFail = done.attempts.find(attempt => attempt.nodeId === 'ui' && attempt.result?.outcome === 'fail')!
  expect(resumed[0]!.prompt).toContain(`Step "ui" (id ui, attempt ${uiFail.number}) sent you back with this failure: Completed fixture.`)
  expect(resumed[0]!.prompt).toContain('You are continuing your own implementation session')
  expect(resumed[0]!.prompt).not.toContain('upstreamEvidence')
  const fixRound = done.attempts.filter(attempt => attempt.nodeId === 'execute')[1]!
  expect(fixRound.resume).toMatchObject({ sessionId: STEP_SESSION })
  expect(assignmentOf(fixRound.prompt).sentBack).toContain('sent you back')
})

test('a fix round without a resumable session starts a fresh agent with the full assignment', async () => {
  const calls: StepCall[] = []
  const store = await build(({ prompt, resumeSessionId }) => {
    calls.push({ prompt, resumeSessionId })
    return { cmd: '/bin/echo', args: [report(/STEP-ui/.test(prompt) && calls.filter(call => /STEP-ui/.test(call.prompt)).length === 1 ? 'fail' : 'pass')], env: {} }
  })
  await store.save(checkedGraph())
  const run = await runner.start({ workflowId: 'checked', cwd: repo, request: 'Build it', label: 'fresh fix' })
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  expect(calls.every(call => call.resumeSessionId === undefined)).toBe(true)
  expect(done.attempts.filter(attempt => attempt.nodeId === 'execute').every(attempt => attempt.resume === undefined)).toBe(true)
})

test('older results keep only their outcome, except plans, and check logs are cut to their tail', async () => {
  const longLog = `${'x'.repeat(20000)}TAIL`
  const store = await build(scripted({ accept: ['fail'], ui: ['fail'] }))
  await store.save(checkedGraph())
  const run = await runner.start({ workflowId: 'checked', cwd: repo, request: 'Build it', label: 'trimmed' })
  const done = await finished(run.id)
  const executes = done.attempts.filter(attempt => attempt.nodeId === 'execute')
  const inputs = evidenceOf(executes[2]!.prompt) as Array<{ node: string; older?: true; output?: string }>
  expect(inputs.find(input => input.node === 'verify-plan')).toMatchObject({ older: true })
  expect(inputs.find(input => input.node === 'verify-plan')!.output).toBeUndefined()
  expect(inputs.find(input => input.node === 'plan')!.output).toBeDefined()
  expect(inputs.find(input => input.node === 'ui')!.output).toBeDefined()
  const check = { command: 'ci', args: [], exitCode: 1, output: longLog, timedOut: false }
  expect(checkTail(check).output).toHaveLength(8000)
  expect(checkTail(check).output.endsWith('TAIL')).toBe(true)
})

test('a step sent back by a failure names that failure and marks older results', async () => {
  const store = await build(scripted({ accept: ['fail'], ui: ['fail'] }))
  await store.save(checkedGraph())
  const run = await runner.start({ workflowId: 'checked', cwd: repo, request: 'Build it', label: 'sent back' })
  const done = await finished(run.id)
  const executes = done.attempts.filter(attempt => attempt.nodeId === 'execute')
  const uiFail = done.attempts.find(attempt => attempt.nodeId === 'ui' && attempt.result?.outcome === 'fail')!
  const sentBack = assignmentOf(executes[2]!.prompt).sentBack as string
  expect(sentBack).toContain(`Step "ui" (id ui, attempt ${uiFail.number}) sent you back with this failure: Completed fixture`)
  expect(executes[0]!.prompt).not.toContain('sent you back')
  expect(assignmentOf(executes[1]!.prompt).sentBack).toContain('Step "accept" (id accept, attempt 3)')
  const inputs = assignmentOf(executes[2]!.prompt).upstreamEvidence as Array<{ node: string; older?: true }>
  expect(inputs.find(input => input.node === 'plan')!.older).toBe(true)
  expect(inputs.find(input => input.node === 'ui')!.older).toBeUndefined()
  expect(executes[0]!.prompt).not.toContain('"older"')
})

test('a step whose sender passed gets no sent-back note', async () => {
  const store = await build(scripted({}))
  await store.save(checkedGraph())
  const run = await runner.start({ workflowId: 'checked', cwd: repo, request: 'Build it', label: 'passed sender' })
  const done = await finished(run.id)
  expect(done.attempts.every(attempt => !attempt.prompt.includes('sent you back'))).toBe(true)
})

const evidenceOf = (prompt: string) => assignmentOf(prompt).upstreamEvidence as Array<{ node: string; older?: true }>
const stepOf = (id: string, kind: string, maxVisits = 5) => ({ id, title: id, kind, agent: { role: kind === 'review' ? 'review' : 'execute' }, instructions: `STEP-${id}`, maxVisits, position: { x: 0, y: 0 } })
const sentBackGraph = (id: string, edges: Workflow['edges']): Workflow => {
  const graph = withoutSession()
  return { ...graph, id, nodes: [graph.nodes[0]!, graph.nodes[1]!, stepOf('execute', 'implement'), stepOf('dod', 'task'), stepOf('interrogate', 'task'), stepOf('review', 'review')].filter(step => step.id !== 'interrogate' || edges.some(edge => edge.source === 'interrogate')) as Workflow['nodes'], edges: [
    { source: 'plan', target: 'verify-plan', outcome: 'pass' }, { source: 'verify-plan', target: 'execute', outcome: 'pass' }, { source: 'review', target: 'execute', outcome: 'fail' }, ...edges,
  ] }
}

test('an older failure stays in the evidence, marked older, beside the fresh failure that sent the step back', async () => {
  const store = await build(scripted({ interrogate: ['pass', 'fail'], dod: ['fail'] }))
  await store.save(sentBackGraph('older-failure', [
    { source: 'execute', target: 'interrogate', outcome: 'pass' }, { source: 'interrogate', target: 'dod', outcome: 'pass' }, { source: 'dod', target: 'review', outcome: 'pass' },
    { source: 'dod', target: 'execute', outcome: 'fail' }, { source: 'interrogate', target: 'execute', outcome: 'fail' },
  ]))
  const run = await runner.start({ workflowId: 'older-failure', cwd: repo, request: 'Build it', label: 'older failure' })
  const done = await finished(run.id)
  const executes = done.attempts.filter(attempt => attempt.nodeId === 'execute')
  const fresh = done.attempts.find(attempt => attempt.nodeId === 'interrogate' && attempt.result?.outcome === 'fail')!
  const older = done.attempts.find(attempt => attempt.nodeId === 'dod' && attempt.result?.outcome === 'fail')!
  expect(assignmentOf(executes[1]!.prompt).sentBack).toContain(`(id dod, attempt ${older.number})`)
  expect(assignmentOf(executes[2]!.prompt).sentBack).toContain(`(id interrogate, attempt ${fresh.number})`)
  const inputs = evidenceOf(executes[2]!.prompt)
  expect(inputs.find(input => input.node === 'dod')).toMatchObject({ outcome: { outcome: 'fail' }, older: true })
  expect(inputs.find(input => input.node === 'interrogate')!.older).toBeUndefined()
})

test('a step sent back by a blocked sender gets no sent-back note', async () => {
  const store = await build(scripted({ dod: ['blocked'] }))
  await store.save(sentBackGraph('blocked-sender', [{ source: 'execute', target: 'dod', outcome: 'pass' }, { source: 'dod', target: 'review', outcome: 'pass' }, { source: 'dod', target: 'execute', outcome: 'blocked' }]))
  const run = await runner.start({ workflowId: 'blocked-sender', cwd: repo, request: 'Build it', label: 'blocked sender' })
  const done = await finished(run.id)
  const executes = done.attempts.filter(attempt => attempt.nodeId === 'execute')
  expect(executes.length).toBeGreaterThan(1)
  expect(executes.every(attempt => !attempt.prompt.includes('sent you back'))).toBe(true)
})

test('a stopped and retried visit still names the failure that sent it back and its interrupted visit does not move the older cutoff', async () => {
  let executeVisits = 0
  const store = await build(({ prompt }) => {
    const step = /STEP-(\w+)/.exec(prompt)?.[1]
    if (step === 'execute' && ++executeVisits === 2) return { cmd: '/bin/sh', args: ['-c', 'sleep 5'], env: {} }
    return { cmd: '/bin/echo', args: [report(step === 'dod' && !prompt.includes('failed once') && executeVisits === 1 ? 'fail' : 'pass')], env: {} }
  })
  await store.save(sentBackGraph('stop-retry', [{ source: 'execute', target: 'dod', outcome: 'pass' }, { source: 'dod', target: 'review', outcome: 'pass' }, { source: 'dod', target: 'execute', outcome: 'fail' }]))
  const run = await runner.start({ workflowId: 'stop-retry', cwd: repo, request: 'Build it', label: 'stop retry' })
  await until(run.id, current => current.attempts.filter(attempt => attempt.nodeId === 'execute').length === 2 && current.attempts.some(attempt => attempt.nodeId === 'execute' && attempt.status === 'running'))
  await runner.stop(run.id)
  await allJobsStopped()
  await runner.retry(run.id)
  const done = await finished(run.id)
  const executes = done.attempts.filter(attempt => attempt.nodeId === 'execute')
  const failed = done.attempts.find(attempt => attempt.nodeId === 'dod' && attempt.result?.outcome === 'fail')!
  const resumed = executes.at(-1)!
  expect(executes[1]!.interrupted).toBe(true)
  expect(assignmentOf(resumed.prompt).sentBack).toContain(`(id dod, attempt ${failed.number})`)
  expect(evidenceOf(resumed.prompt).find(input => input.node === 'dod')!.older).toBeUndefined()
})

test('a step fed by a failed join names the join attempt as the sender', async () => {
  await homeConfig()
  await build(scripted({}))
  const graph = forked({ a: { checks: writes('same.txt', 'a') }, b: { checks: writes('same.txt', 'b') }, review: { kind: 'review', agent: { role: 'review', engine: 'claude' } } }, {
    nodes: [{ id: 'fix', title: 'Fix', kind: 'implement', agent: { role: 'execute', engine: 'codex' }, instructions: 'STEP-fix' }],
    edges: [{ source: 'join', target: 'fix', outcome: 'fail' }, { source: 'fix', target: 'review', outcome: 'pass' }],
  })
  const started = await runner.start({ cwd: repo, request: 'Write the same file', label: 'join sender', graph }, { startedByUser: true })
  const done = await finished(started.id)
  const joined = joins(done)[0]!
  const fix = done.attempts.find(attempt => attempt.nodeId === 'fix')!
  expect(joined.result!.outcome).toBe('fail')
  expect(assignmentOf(fix.prompt).sentBack).toContain(`(id join, attempt ${joined.number}) sent you back with this failure: Paths could not be joined`)
})

test('a failure on one parallel path is not a sent-back note or an older mark on the other path', async () => {
  await homeConfig()
  let failedOnce = false
  await build(({ prompt }) => ({ cmd: '/bin/echo', args: [report(prompt.includes('STEP-a') && !failedOnce && (failedOnce = true) ? 'fail' : 'pass')], env: {} }))
  const graph = forked({ a: { instructions: 'STEP-a' }, b: { instructions: 'STEP-b' } }, { edges: [{ source: 'a', target: 'a', outcome: 'fail' }] })
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'parallel isolation', graph }, { startedByUser: true })
  const done = await finished(started.id)
  const pathA = done.attempts.filter(attempt => attempt.nodeId === 'a')
  const pathB = done.attempts.find(attempt => attempt.nodeId === 'b')!
  expect(pathA).toHaveLength(2)
  expect(assignmentOf(pathA[1]!.prompt).sentBack).toContain('(id a, attempt')
  expect(pathB.prompt).not.toContain('sent you back')
  expect(pathB.prompt).not.toContain('"older"')
})

test('retry gives every step a fresh budget', async () => {
  const store = await build(() => ({ cmd: '/bin/echo', args: [report('fail')], env: {} }))
  await store.save({ ...classicWorkflow(), id: 'loop', entry: 'test', nodes: [{ id: 'test', title: 'Test', instructions: 'Check', maxVisits: 2 }], edges: [{ source: 'test', target: 'test', outcome: 'fail' }] })
  const run = await runner.start({ workflowId: 'loop', cwd: repo, request: 'Test', label: 'loop' })
  expect((await finished(run.id)).attempts).toHaveLength(3)
  await runner.retry(run.id)
  const retried = await finished(run.id)
  expect(retried.status).toBe('blocked')
  expect(retried.attempts).toHaveLength(5)
})

test('an undefined role resolves to the fallback; with fallback null the run start throws naming the role', async () => {
  const store = await build()
  await store.save({ ...classicWorkflow(), id: 'named-role', entry: 'build', nodes: [{ id: 'build', title: 'Build', instructions: 'Build it', agent: { role: 'builder' } }], edges: [] })
  const run = await runner.start({ workflowId: 'named-role', cwd: repo, request: 'Build', label: 'named' })
  expect(run.agents.build).toMatchObject({ engine: 'claude', model: null })
  await finished(run.id)
  await writeConfig({ fallback: null })
  await expect(runner.start({ workflowId: 'named-role', cwd: repo, request: 'Build', label: 'named' })).rejects.toThrow('Build: role "builder" is not defined in Settings')
  await writeConfig({ roles: { plan: { engine: 'claude', model: null }, execute: { engine: 'glm', model: null }, review: { engine: 'codex', model: null }, builder: { engine: 'codex', model: 'gpt-5' } } })
  const named = await runner.start({ workflowId: 'named-role', cwd: repo, request: 'Build', label: 'named' })
  expect(named.agents.build).toMatchObject({ engine: 'codex', model: 'gpt-5', family: 'gpt' })
})

const downFor = (engines: string[]) => (engine: string) => engines.includes(engine) ? { reason: `${engine} is down`, until: null } : null
const ROLES = { plan: { engine: 'claude', model: null }, execute: { engine: 'glm', model: null }, review: { engine: 'codex', model: null } }

test('an unavailable role engine is swapped to the fallback before the run starts, and the swap is recorded', async () => {
  const store = await build()
  await store.save({ ...withoutSession(), id: 'swap' })
  down = downFor(['glm'])
  const run = await runner.start({ workflowId: 'swap', cwd: repo, request: 'Implement', label: 'swap' })
  expect(run.agents.execute).toMatchObject({ engine: 'claude', family: 'claude', swappedFrom: { engine: 'glm', model: null, reason: 'glm is down' } })
  expect(run.agents.review).toMatchObject({ engine: 'codex' })
  expect(run.agents.review!.swappedFrom).toBeUndefined()
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  expect(manager.listJobs().find(job => job.workflowNodeId === 'execute')!.engine).toBe('claude')
})

test('a review whose engine is down moves to another available family, never the implementation family', async () => {
  const store = await build()
  await store.save({ ...withoutSession(), id: 'review-down' })
  await writeConfig({ roles: { ...ROLES, plan: { engine: 'glm', model: null } }, fallback: { engine: 'glm', model: null } })
  down = downFor(['codex'])
  const run = await runner.start({ workflowId: 'review-down', cwd: repo, request: 'Implement', label: 'review-down' })
  expect(run.agents.execute).toMatchObject({ engine: 'glm', family: 'glm' })
  expect(run.agents.review).toMatchObject({ engine: 'claude', family: 'claude', swappedFrom: { engine: 'codex' } })
  expect(run.agents.review!.sameFamily).toBeUndefined()
  expect(run.agents['verify-plan']).toMatchObject({ engine: 'glm', swappedFrom: { engine: 'codex' } })
  expect((await finished(run.id)).status).toBe('done')
})

test('with no other family available, the review runs same-family at most twice and is marked sameFamily', async () => {
  let calls = 0
  const store = await build(() => ({ cmd: '/bin/echo', args: [report(++calls === 4 || calls === 6 ? 'fail' : 'pass')], env: {} }))
  await store.save({ ...withoutSession(), id: 'same-family-review' })
  await writeConfig({ roles: { ...ROLES, execute: { engine: 'claude', model: null } } })
  down = downFor(['codex', 'glm'])
  const run = await runner.start({ workflowId: 'same-family-review', cwd: repo, request: 'Implement', label: 'same-family' })
  expect(run.agents.review).toMatchObject({ engine: 'claude', family: 'claude', sameFamily: true, swappedFrom: { engine: 'codex' } })
  const done = await finished(run.id)
  const reviews = done.attempts.filter(attempt => attempt.nodeId === 'review')
  expect(reviews.map(attempt => [attempt.sameFamily, attempt.result!.outcome])).toEqual([[true, 'fail'], [true, 'fail']])
  expect(done.status).toBe('blocked')
  expect(done.error).toBe('claude unavailable: no reviewer of a different family is available')
  expect(done.unavailable).toEqual({ engine: 'claude', reason: 'no reviewer of a different family is available', until: null })
})

test('a review that would share the implementation family at dispatch moves to another family', async () => {
  const store = await build()
  await store.save({ ...withoutSession(), id: 'collide' })
  await writeConfig({ roles: { ...ROLES, review: { engine: 'claude', model: null } } })
  down = downFor(['glm'])
  const run = await runner.start({ workflowId: 'collide', cwd: repo, request: 'Implement', label: 'collide' })
  expect(run.agents.execute).toMatchObject({ engine: 'claude', swappedFrom: { engine: 'glm' } })
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  expect(done.agents.review).toMatchObject({ engine: 'codex', family: 'gpt', swappedFrom: { engine: 'claude' } })
})

test('a pinned parallel runner is not swapped before the run starts', async () => {
  await homeConfig()
  await build()
  down = downFor(['glm'])
  const run = await runner.start({ workflowId: 'default', cwd: repo, request: 'Design', label: 'arena' }, { startedByUser: true })
  expect(run.agents['runner-glm']).toMatchObject({ engine: 'glm' })
  expect(run.agents['runner-glm']!.swappedFrom).toBeUndefined()
  expect(run.agents.execute).toMatchObject({ engine: 'claude', swappedFrom: { engine: 'glm' } })
})

test('a crashing step is retried on the same engine up to three times, then on the fallback', async () => {
  const store = await build(({ engine }) => engine === 'glm' ? { cmd: '/bin/false', args: [], env: {} } : { cmd: '/bin/echo', args: [report()], env: {} })
  await store.save({ ...withoutSession(), id: 'crash' })
  const run = await runner.start({ workflowId: 'crash', cwd: repo, request: 'Implement', label: 'crash' })
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  const engines = stepJobs().filter(job => job.workflowNodeId === 'execute').map(job => job.engine)
  expect([engines.filter(engine => engine === 'glm').length, engines.filter(engine => engine === 'claude').length]).toEqual([3, 1])
  const execute = done.attempts.find(attempt => attempt.nodeId === 'execute')!
  expect(execute).toMatchObject({ crashes: 0, tried: ['glm'], result: { outcome: 'pass' } })
  expect(done.agents.execute).toMatchObject({ engine: 'claude', swappedFrom: { engine: 'glm', reason: 'Agent process failed (1)' } })
})

test('when nothing can run, the step settles with the real reason, never Interrupted before it finished, and run.unavailable is set', async () => {
  let broken = true
  const store = await build((input) => { if (broken) throw new Error('no binary'); return resolver(input) })
  await store.save({ ...withoutSession(), id: 'nothing' })
  const run = await runner.start({ workflowId: 'nothing', cwd: repo, request: 'Implement', label: 'nothing' })
  const blocked = await finished(run.id)
  expect(blocked.status).toBe('blocked')
  expect(manager.listJobs()).toHaveLength(0)
  expect(blocked.attempts).toHaveLength(1)
  const [attempt] = blocked.attempts
  expect(attempt!.status).toBe('settled')
  expect(attempt!.tried).toEqual(['claude', 'codex'])
  expect(attempt!.result!.summary).toBe('glm unavailable: engine resolver failed: no binary')
  expect(attempt!.result!.summary).not.toContain('Interrupted')
  expect(blocked.error).toBe(attempt!.result!.summary)
  expect(blocked.unavailable).toMatchObject({ engine: 'glm', until: null })
  expect(blocked.unavailable!.reason).toBe('engine resolver failed: no binary')
  broken = false
  await runner.retry(run.id)
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  expect(done.unavailable).toBeUndefined()
})

test('a user stop during a crash never retries', async () => {
  const store = await build(({ engine }) => engine === 'glm' ? { cmd: '/bin/sleep', args: ['20'], env: {} } : { cmd: '/bin/echo', args: [report()], env: {} })
  await store.save({ ...withoutSession(), id: 'user-stop' })
  const run = await runner.start({ workflowId: 'user-stop', cwd: repo, request: 'Implement', label: 'user-stop' })
  await until(run.id, current => current.attempts.some(attempt => attempt.nodeId === 'execute' && attempt.status === 'running'))
  await manager.killJob(stepJobs().find(job => job.workflowNodeId === 'execute')!.id)
  const done = await finished(run.id)
  expect(done.status).toBe('blocked')
  expect(done.error).toContain('Agent process failed')
  expect(done.unavailable).toBeUndefined()
  expect(stepJobs().filter(job => job.workflowNodeId === 'execute')).toHaveLength(1)
  const stopped = await runner.start({ workflowId: 'user-stop', cwd: repo, request: 'Implement', label: 'user-stop' })
  await until(stopped.id, current => current.attempts.some(attempt => attempt.nodeId === 'execute' && attempt.status === 'running'))
  await runner.stop(stopped.id)
  await allJobsStopped()
  expect(runner.get(stopped.id)!.status).toBe('stopped')
  expect(stepJobs().filter(job => job.workflowNodeId === 'execute' && job.workflowRunId === stopped.id)).toHaveLength(1)
})

test('a pinned parallel runner whose engine is down is skipped and the join still completes', async () => {
  await homeConfig()
  let calls = 0
  await build(() => ({ cmd: '/bin/echo', args: [report(calls++ === 1 ? 'fail' : 'pass')], env: {} }))
  down = downFor(['glm'])
  const started = await runner.start({ workflowId: 'default', cwd: repo, request: 'Design and implement the fixture', label: 'arena' }, { startedByUser: true })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.attempts.find(attempt => attempt.nodeId === 'runner-glm')!.result).toEqual({ outcome: 'pass', summary: 'Skipped: glm unavailable (glm is down)', evidence: ['glm unavailable: glm is down'] })
  expect(manager.listJobs().some(job => job.workflowNodeId === 'runner-glm')).toBe(false)
  expect(done.attempts.filter(attempt => attempt.nodeId === 'arena-join').map(attempt => attempt.result!.outcome)).toEqual(['pass'])
})

test('retry re-resolves agents from current Settings', async () => {
  const store = await build(() => ({ cmd: '/bin/echo', args: [report('blocked')], env: {} }))
  await store.save({ ...withoutSession(), id: 'resettle' })
  const run = await runner.start({ workflowId: 'resettle', cwd: repo, request: 'Implement', label: 'resettle' })
  expect(run.agents.execute).toMatchObject({ engine: 'glm' })
  expect((await finished(run.id)).status).toBe('blocked')
  await writeConfig({ roles: { ...ROLES, execute: { engine: 'claude', model: 'opus' } } })
  const retried = await runner.retry(run.id)
  expect(retried.agents.execute).toMatchObject({ engine: 'claude', model: 'opus', family: 'claude' })
  await finished(run.id)
})

test('after a retry with new Settings, the review is still checked against the family that wrote the code', async () => {
  let calls = 0
  const store = await build(() => ({ cmd: '/bin/echo', args: [report(calls++ === 3 ? 'blocked' : 'pass')], env: {} }))
  await store.save({ ...withoutSession(), id: 'author-family' })
  const run = await runner.start({ workflowId: 'author-family', cwd: repo, request: 'Implement', label: 'author-family' })
  expect(run.agents.execute).toMatchObject({ engine: 'glm' })
  expect((await finished(run.id)).status).toBe('blocked')
  await writeConfig({ roles: { ...ROLES, execute: { engine: 'codex', model: null }, review: { engine: 'glm', model: null } } })
  await runner.retry(run.id)
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  const reviews = stepJobs().filter(job => job.workflowRunId === run.id && job.workflowNodeId === 'review')
  expect(reviews.at(-1)!.engine).not.toBe('glm')
})

test('a family whose job crashed mid-implementation still counts as an author for the review', async () => {
  await build(({ engine }) => engine === 'glm' ? { cmd: '/bin/sh', args: ['-c', 'exit 1'], env: {} } : { cmd: '/bin/echo', args: [report()], env: {} })
  await createWorkflowStore(dir).save({ ...withoutSession(), id: 'crashed-author' })
  down = downFor(['codex'])
  const run = await runner.start({ workflowId: 'crashed-author', cwd: repo, request: 'Implement', label: 'crashed-author' })
  const done = await finished(run.id)
  const review = done.attempts.findLast(attempt => attempt.nodeId === 'review')!
  expect(done.attempts.find(attempt => attempt.nodeId === 'execute')!.families).toEqual(['glm', 'claude'])
  expect(review.sameFamily).toBe(true)
})

test('a run saved before families were recorded keeps its authors across a retry with new Settings', async () => {
  let calls = 0
  const store = await build(() => ({ cmd: '/bin/echo', args: [report(calls++ === 3 ? 'blocked' : 'pass')], env: {} }))
  await store.save({ ...withoutSession(), id: 'legacy-author' })
  const run = await runner.start({ workflowId: 'legacy-author', cwd: repo, request: 'Implement', label: 'legacy-author' })
  expect((await finished(run.id)).status).toBe('blocked')
  const file = join(dir, 'workflow-runs', `${run.id}.json`)
  const saved = JSON.parse(await readFile(file, 'utf8')) as WorkflowRun
  for (const attempt of saved.attempts as Array<Record<string, unknown>>) { delete attempt.families; delete attempt.family }
  await writeFile(file, JSON.stringify(saved))
  runner = createWorkflowRunner({ manager, resolver: () => ({ cmd: '/bin/echo', args: [report()], env: {} }), store, base: dir, availability: async ({ engine }) => down(engine) })
  await runner.recover()
  await writeConfig({ roles: { ...ROLES, execute: { engine: 'codex', model: null }, review: { engine: 'glm', model: null } } })
  await runner.retry(run.id)
  expect((await finished(run.id)).status).toBe('done')
  expect(stepJobs().filter(job => job.workflowRunId === run.id && job.workflowNodeId === 'review').at(-1)!.engine).not.toBe('glm')
})

test('an AI with no known family is never picked to build or review in place of another', async () => {
  const { createConnectionStore } = await import('../server/agent-connections')
  const store = await build()
  await store.save({ ...withoutSession(), id: 'mystery-family' })
  await createConnectionStore(dir).save({ id: 'mystery', name: 'Mystery CLI', adapter: 'cli', command: '/bin/echo', args: ['{{prompt}}'] })
  await writeConfig({ roles: { ...ROLES, execute: { engine: 'claude', model: null } }, fallback: { engine: 'mystery', model: null } })
  down = downFor(['codex'])
  const run = await runner.start({ workflowId: 'mystery-family', cwd: repo, request: 'Implement', label: 'mystery-family' })
  expect(run.agents.review).toMatchObject({ engine: 'glm', family: 'glm' })
  await finished(run.id)
})

test('a stop that lands while a crashed step is being recovered never starts another job', async () => {
  let spawns = 0
  const store = await build(({ engine }) => { if (engine === 'glm') { spawns += 1; throw new Error('glm will not start') } return { cmd: '/bin/echo', args: [report()], env: {} } })
  await store.save({ ...withoutSession(), id: 'stop-in-recovery' })
  let runId = ''
  down = engine => { if (engine === 'glm' && spawns === 1) void runner.stop(runId); return null }
  const started = await runner.start({ workflowId: 'stop-in-recovery', cwd: repo, request: 'Implement', label: 'stop-in-recovery' })
  runId = started.id
  const done = await finished(started.id)
  expect(done.status).toBe('stopped')
  expect(spawns).toBe(1)
  expect(stepJobs().filter(job => job.workflowNodeId === 'execute')).toHaveLength(0)
})

test('same model family through different engine names cannot perform cross-family review', async () => {
  const store = await build()
  const graph = classicWorkflow()
  graph.id = 'same-family'
  graph.nodes[2]!.agent = { role: 'execute', engine: 'claude', model: 'claude-opus' }
  graph.nodes[3]!.agent = { role: 'review', engine: 'codex', model: 'anthropic/claude-sonnet' }
  await store.save(graph)
  await expect(runner.start({ workflowId: graph.id, cwd: repo, request: 'Implement', label: 'families' })).rejects.toThrow('different model family')
  expect(manager.listJobs()).toHaveLength(0)
})

test('restart adopts an existing running job and continues without dispatching it twice', async () => {
  const store = await build(({ prompt }) => ({ cmd: process.execPath, args: ['-e', `setTimeout(() => console.log(${JSON.stringify(report())}), 150)`], env: {} }))
  const run = await runner.start({ cwd: repo, request: 'Inspect', label: 'restart' })
  runner = createWorkflowRunner({ manager, resolver, store, base: dir })
  await runner.recover()
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  expect(done.attempts).toHaveLength(4)
  expect(manager.listJobs()).toHaveLength(4)
})

test('a terminal agent error overrides an earlier claimed pass even with exit zero', async () => {
  await build(() => ({ cmd: '/usr/bin/printf', args: ['%s\n%s\n', report(), JSON.stringify({ type: 'result', is_error: true, result: 'Provider failed' })], env: {} }))
  const run = await runner.start({ cwd: repo, request: 'Inspect', label: 'false-success' })
  expect((await finished(run.id)).status).toBe('blocked')
  expect(manager.listJobs().map(job => job.workflowAttempt)).toEqual(Array(9).fill(0))
})

test('stopping an acceptance command prevents the next node from starting', async () => {
  const store = await build()
  await store.save({ ...classicWorkflow(), id: 'slow-check', entry: 'test', nodes: [{ id: 'test', title: 'Check', instructions: 'Check', checks: [{ command: '/bin/sleep', args: ['20'], timeoutSeconds: 30 }] }, { id: 'next', title: 'Next', instructions: 'Inspect' }], edges: [{ source: 'test', target: 'next', outcome: 'pass' }] })
  const run = await runner.start({ workflowId: 'slow-check', cwd: repo, request: 'Inspect', label: 'stop-check' })
  for (let i = 0; i < 100 && !runner.get(run.id)?.attempts[0]?.checkPid; i++) await Bun.sleep(20)
  expect(runner.get(run.id)?.attempts[0]?.status).toBe('checking')
  await runner.stop(run.id)
  expect(runner.get(run.id)?.status).toBe('stopped')
  expect(manager.listJobs()).toHaveLength(1)
})

test('registered ACP agents work through the existing job manager with advertised resume support', async () => {
  const { realEngineResolver } = await import('../server/jobs-engine-iface')
  const { createConnectionStore } = await import('../server/agent-connections')
  await build(realEngineResolver)
  await createConnectionStore(dir).save({ id: 'fixture-acp', name: 'Fixture ACP', adapter: 'acp', command: process.execPath, args: [join(import.meta.dir, 'fixtures/agents/acp.ts')] })
  const created = await manager.createJob({ engine: 'fixture-acp', cwd: repo, prompt: 'Inspect', label: 'custom-agent' }, realEngineResolver)
  expect(created.ok).toBe(true)
  if (!created.ok) return
  for (let i = 0; i < 100 && manager.getJob(created.job.id)?.status === 'running'; i++) await Bun.sleep(20)
  expect(manager.getJob(created.job.id)).toMatchObject({ status: 'done', sessionId: 'fixture-session', resumeSupported: true })
})

test('stop during dispatch also terminates the job that finishes launching afterwards', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await build(async () => { await gate; return { cmd: '/bin/sleep', args: ['20'], env: {} } })
  const starting = runner.start({ cwd: repo, request: 'Inspect', label: 'stop-dispatch' })
  for (let i = 0; i < 100 && runner.list().length === 0; i++) await Bun.sleep(10)
  const id = runner.list()[0]!.id
  const stopping = runner.stop(id)
  release()
  await starting
  await stopping
  for (let i = 0; i < 100 && manager.listJobs().some(job => job.status === 'running'); i++) await Bun.sleep(20)
  expect(runner.get(id)?.status).toBe('stopped')
  expect(manager.listJobs().some(job => job.status === 'running')).toBe(false)
})

async function chatRoot(engine = 'claude', model?: string) {
  const created = await manager.createJob({ engine, ...(model ? { model } : {}), cwd: repo, prompt: 'Run the shipping workflow', label: 'Shipping chat', purpose: 'chat' }, () => ({ cmd: '/bin/echo', args: ['hi'], env: {} }))
  if (!created.ok) throw new Error(created.error)
  for (let i = 0; i < 200 && manager.getJob(created.job.id)?.status === 'running'; i++) await Bun.sleep(20)
  return created.job
}
async function settledStatuses() {
  for (let i = 0; i < 200 && settledRuns.length === 0; i++) await Bun.sleep(10)
  return settledRuns.map(settled => settled.status)
}
const stepJobs = () => manager.listJobs().filter(job => job.workflowRunId).sort((a, b) => a.workflowAttempt! - b.workflowAttempt!)

test('a chat run of the default flow keeps its three design runners and judge on their own AI families', async () => {
  await build(resolver, true)
  const root = await chatRoot()
  const run = await runner.start({ workflowId: 'default', cwd: repo, request: 'Ship it', label: 'ship', chat: root.id, engine: 'claude' })
  expect(run.agents['arena-brief']).toMatchObject({ engine: 'claude' })
  expect(['runner-claude', 'runner-glm', 'runner-codex', 'judge'].map(id => run.agents[id]!.family)).toEqual(['claude', 'glm', 'gpt', 'gpt'])
})

test('a chat run of pstack Thermos keeps its security pass on codex and its quality pass on claude', async () => {
  await build(resolver, true)
  const root = await chatRoot()
  const run = await runner.start({ workflowId: 'pstack-thermos', cwd: repo, request: 'Review the diff', label: 'thermos', chat: root.id, engine: 'claude' })
  expect(run.agents.security).toMatchObject({ engine: 'codex' })
  expect(run.agents.quality).toMatchObject({ engine: 'claude' })
})

test('a chat run puts Chat decides steps on the chat AI, keeps pinned steps, and files its jobs under the chat', async () => {
  const store = await build()
  const graph = classicWorkflow()
  graph.id = 'shipping'; graph.name = 'Shipping'
  graph.nodes[0]!.agent = { role: 'plan', engine: 'codex' }
  await store.save(graph)
  const root = await chatRoot()
  const run = await runner.start({ workflowId: 'shipping', cwd: repo, request: 'Ship it', label: 'ship', chat: root.id, chatTurn: root.id, engine: 'claude', model: 'claude-opus-4' })
  expect(run.chatId).toBe(root.id)
  expect(run.chatTurn).toBe(root.id)
  expect(run.agents.plan).toMatchObject({ engine: 'codex', model: null })
  expect(run.agents['verify-plan']).toMatchObject({ engine: 'claude', model: 'claude-opus-4', family: 'claude' })
  expect(run.agents.execute).toMatchObject({ engine: 'claude', model: 'claude-opus-4', family: 'claude' })
  expect(run.agents.review).toMatchObject({ engine: 'codex', family: 'gpt' })
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  expect(done.reportedAt).toBeNull()
  expect(stepJobs().map(job => job.label)).toEqual(['Plan', 'Verify plan', 'Execute', 'Cross-family review'])
  for (const job of stepJobs()) {
    expect(job).toMatchObject({ chatId: root.id, chatTurn: root.id, reason: `Studio · Shipping · ${job.label}` })
    expect(job.reportedAt).toBeUndefined()
  }
  expect(await settledStatuses()).toEqual(['done'])
})

test('a chat run without an engine uses the chat root AI for Chat decides steps', async () => {
  const store = await build()
  await store.save({ ...withoutSession(), id: 'chat-decides' })
  const root = await chatRoot('glm')
  const run = await runner.start({ workflowId: 'chat-decides', cwd: repo, request: 'Ship it', label: 'ship', chat: root.id })
  expect(run.agents.plan).toMatchObject({ engine: 'glm' })
  expect(run.agents.execute).toMatchObject({ engine: 'glm' })
  expect(run.agents.review).toMatchObject({ engine: 'codex' })
  expect((await finished(run.id)).status).toBe('done')
})

test('a run outside a chat keeps the stored roles and plain labels', async () => {
  await build(() => ({ cmd: '/bin/echo', args: ['All done'], env: {} }))
  const run = await runner.start({ cwd: repo, request: 'Inspect', label: 'plain' })
  expect(run.agents.plan).toMatchObject({ engine: 'claude' })
  expect(run.agents.execute).toMatchObject({ engine: 'glm' })
  expect(run.chatId).toBeUndefined()
  const done = await finished(run.id)
  expect(done.reportedAt).toBeUndefined()
  expect(stepJobs().every(job => job.label === 'plain' && job.chatId === undefined && job.reason === undefined)).toBe(true)
  expect(await settledStatuses()).toEqual(['blocked'])
})

test('a chat run rejects an unknown chat or a turn from another chat', async () => {
  await build()
  const root = await chatRoot()
  await expect(runner.start({ cwd: repo, request: 'Ship it', label: 'ship', chat: 'no-such-chat' })).rejects.toThrow('Chat not found')
  await expect(runner.start({ cwd: repo, request: 'Ship it', label: 'ship', chat: root.id, chatTurn: 'no-such-turn' })).rejects.toThrow('Chat turn not found')
  expect(runner.list()).toHaveLength(0)
})

test('a chat run loops past the chat retry cap up to its own visit limit', async () => {
  const store = await build(() => ({ cmd: '/bin/echo', args: [report('fail')], env: {} }))
  await store.save({ ...classicWorkflow(), id: 'chat-loop', entry: 'test', nodes: [{ id: 'test', title: 'Test', instructions: 'Check', maxVisits: 4 }], edges: [{ source: 'test', target: 'test', outcome: 'fail' }] })
  const root = await chatRoot()
  const run = await runner.start({ workflowId: 'chat-loop', cwd: repo, request: 'Test', label: 'loop', chat: root.id })
  const done = await finished(run.id)
  expect(done.attempts).toHaveLength(5)
  expect(done.error).toContain('visit limit')
})

test('stopping a chat run settles it once, and a report mark survives a restart', async () => {
  const store = await build(() => ({ cmd: '/bin/sleep', args: ['20'], env: {} }))
  const root = await chatRoot()
  const run = await runner.start({ cwd: repo, request: 'Ship it', label: 'ship', chat: root.id })
  await runner.stop(run.id)
  expect(await settledStatuses()).toEqual(['stopped'])
  await runner.markReported(run.id, 1234)
  expect(createWorkflowRunner({ manager, resolver, store, base: dir }).get(run.id)?.reportedAt).toBe(1234)
})

test('a run started by a session AI waits for approval and dispatches nothing', async () => {
  await build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement the fixture', label: 'fixture' })
  expect(started.status).toBe('awaiting-approval')
  expect(started.versions).toEqual([expect.objectContaining({ number: 1, state: 'pending', approvedVia: null, size: 'initial' })])
  expect(started.origin).toEqual({ source: 'saved', by: 'you', where: 'studio' })
  await Bun.sleep(100)
  expect(manager.listJobs()).toHaveLength(0)
})

test('approving from the drawer records the source and runs the flow', async () => {
  await build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement the fixture', label: 'fixture' })
  const approved = await runner.approve(started.id, { via: 'drawer' })
  expect(approved.versions[0]).toEqual(expect.objectContaining({ state: 'approved', approvedVia: 'drawer', relayedBy: null }))
  expect((await finished(started.id)).status).toBe('done')
})

test('a second approval of the same version is a conflict and dispatches once', async () => {
  await build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement the fixture', label: 'fixture' })
  const results = await Promise.allSettled([runner.approve(started.id, { via: 'drawer' }), runner.approve(started.id, { via: 'drawer' })])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  expect((rejected.reason as RunActionError).status).toBe(409)
  const done = await finished(started.id)
  expect(done.attempts.filter(attempt => attempt.nodeId === 'plan')).toHaveLength(1)
})

test('a relayed approval must come from the session that owns the run', async () => {
  const store = await build(resolver, true)
  const first = await store.save({ ...classicWorkflow(), id: 'terminal-workflow', name: 'Terminal workflow' })
  const terminal: TerminalRecord = { id: 'terminal-a', engine: 'codex', cwd: repo, pid: 1, createdAt: 0, title: 'Terminal', sessionId: null, workflow: { id: first.id, name: first.name, revision: first.revision, selectedDefault: true } }
  runner = createWorkflowRunner({ manager, resolver, store, base: dir, terminals: { get: id => id === terminal.id ? terminal : undefined }, requireApproval: async () => true })
  const started = await runner.start({ terminalId: 'terminal-a', cwd: repo, request: 'Implement', label: 'fixture' })
  expect(started.origin).toEqual({ source: 'saved', by: 'codex', where: 'terminal' })
  await expect(runner.approve(started.id, { via: 'conversation', terminalId: 'terminal-b' })).rejects.toMatchObject({ status: 403 })
  const approved = await runner.approve(started.id, { via: 'conversation', terminalId: 'terminal-a' })
  expect(approved.versions[0]).toEqual(expect.objectContaining({ approvedVia: 'conversation', relayedBy: 'codex' }))
})

test('rejecting the first version stops the run and frees the workspace', async () => {
  await build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const rejected = await runner.reject(started.id, { via: 'drawer' })
  expect(rejected.status).toBe('stopped')
  expect(rejected.versions[0]!.state).toBe('rejected')
  const next = await runner.start({ cwd: repo, request: 'Again', label: 'second' })
  expect(next.status).toBe('awaiting-approval')
})

test('runs the user starts from the browser, or with approval off, start at once', async () => {
  await build(resolver, true)
  const byUser = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  expect(byUser.versions[0]).toEqual(expect.objectContaining({ state: 'approved', approvedVia: 'user' }))
  await finished(byUser.id)
  await settledStatuses()
  await build(resolver, false)
  const auto = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  expect(auto.versions[0]).toEqual(expect.objectContaining({ state: 'approved', approvedVia: 'auto' }))
  await finished(auto.id)
})

test('a paused run records the finished step but starts nothing new until resumed', async () => {
  const slow: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `sleep 0.3; echo '${report()}'`], env: {} })
  await build(slow, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const paused = await runner.pause(started.id)
  expect(paused.status).toBe('paused')
  const moved = await until(started.id, run => run.attempts[0]?.status === 'settled')
  expect(moved.status).toBe('paused')
  expect(moved.currentNodeId).toBe('verify-plan')
  await Bun.sleep(200)
  expect(runner.get(started.id)!.attempts).toHaveLength(1)
  expect(JSON.parse(await Bun.file(join(dir, 'workflow-runs', `${started.id}.json`)).text()).currentNodeId).toBe('verify-plan')
  await runner.resume(started.id)
  expect((await finished(started.id)).status).toBe('done')
})

test('after a restart a waiting or paused run keeps its status and its workspace', async () => {
  const store = await build(resolver, true)
  const waiting = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const reloaded = createWorkflowRunner({ manager, resolver, store, base: dir, requireApproval: async () => true })
  await reloaded.recover()
  expect(reloaded.get(waiting.id)!.status).toBe('awaiting-approval')
  await expect(reloaded.start({ cwd: repo, request: 'Other', label: 'other' })).rejects.toThrow('Workspace already has running work')
})

test('a rejected first version cannot be retried into running', async () => {
  await build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  await runner.reject(started.id, { via: 'drawer' })
  await expect(runner.retry(started.id)).rejects.toMatchObject({ status: 409 })
  expect(manager.listJobs()).toHaveLength(0)
})

test('pausing takes effect at once, even while a step is settling', async () => {
  const slow: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `sleep 0.2; echo '${report()}'`], env: {} })
  await build(slow, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const pausing = runner.pause(started.id)
  expect(runner.get(started.id)!.status).toBe('paused')
  await pausing
  await until(started.id, run => run.attempts[0]?.status === 'settled')
  await Bun.sleep(150)
  expect(runner.get(started.id)!.attempts).toHaveLength(1)
})

test('a run paused between steps survives a restart still paused', async () => {
  const store = await build(resolver, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  await runner.pause(started.id)
  await until(started.id, run => run.attempts.at(-1)?.status === 'settled')
  const reloaded = createWorkflowRunner({ manager, resolver, store, base: dir, requireApproval: async () => false })
  await reloaded.recover()
  expect(reloaded.get(started.id)!.status).toBe('paused')
  await reloaded.resume(started.id)
})

test('a paused run caught mid acceptance check is blocked on restart, not left paused', async () => {
  const store = await build(resolver, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const done = await finished(started.id)
  await settledStatuses()
  const file = join(dir, 'workflow-runs', `${done.id}.json`)
  const record = JSON.parse(await Bun.file(file).text()) as WorkflowRun
  record.status = 'paused'
  record.attempts.at(-1)!.status = 'checking'
  await Bun.write(file, JSON.stringify(record))
  const reloaded = createWorkflowRunner({ manager, resolver, store, base: dir, requireApproval: async () => false })
  await reloaded.recover()
  const recovered = reloaded.get(done.id)!
  expect(recovered.status).toBe('blocked')
  expect(recovered.error).toContain('Interrupted transition or acceptance check')
})

test('every persisted change is reported through onChange', async () => {
  const store = createWorkflowStore(dir)
  manager = createJobManager({ onJobSettled: job => { void runner.onJobSettled(job) } })
  const seen: string[] = []
  runner = createWorkflowRunner({ manager, resolver, store, base: dir, requireApproval: async () => true, onChange: run => { seen.push(run.status) } })
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  await runner.approve(started.id, { via: 'drawer' })
  await finished(started.id)
  for (let i = 0; i < 100 && seen.at(-1) !== 'done'; i++) await Bun.sleep(10)
  expect(seen[0]).toBe('awaiting-approval')
  expect(seen).toContain('running')
  expect(seen.at(-1)).toBe('done')
})

test('a drafted graph runs as a drafted flow and is not saved', async () => {
  const store = await build(resolver, true)
  const graph = { ...classicWorkflow(), id: 'drafted-export', name: 'Drafted export' }
  const started = await runner.start({ cwd: repo, request: 'Add export', label: 'export', graph })
  expect(started.origin.source).toBe('drafted')
  expect(started.workflow.name).toBe('Drafted export')
  expect(started.status).toBe('awaiting-approval')
  expect((await store.list()).map(workflow => workflow.id)).not.toContain('drafted-export')
})

test('a drafted graph that breaks a rule is refused and claims nothing', async () => {
  await build(resolver, true)
  const graph = { ...classicWorkflow(), id: 'unsafe', name: 'Unsafe', edges: [{ source: 'plan', target: 'execute', outcome: 'pass' }] }
  await expect(runner.start({ cwd: repo, request: 'x', label: 'x', graph })).rejects.toThrow('requires a verified plan')
  expect(runner.list()).toHaveLength(0)
  const ok = await runner.start({ cwd: repo, request: 'x', label: 'x' })
  expect(ok.status).toBe('awaiting-approval')
})

test('a saved workflow and a drafted graph cannot both be named', async () => {
  await build(resolver, true)
  await expect(runner.start({ cwd: repo, request: 'x', label: 'x', workflowId: 'default', graph: classicWorkflow() })).rejects.toThrow('Use either a saved workflow or a drafted graph')
})

const slow: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `sleep 0.3; echo '${report()}'`], env: {} })
const family = (engine: string, name: string): ResolvedAgent => ({ engine, model: null, family: name })
const defaultAgents = { plan: family('claude', 'claude'), 'verify-plan': family('codex', 'gpt'), execute: family('glm', 'glm'), review: family('codex', 'gpt') }
function withCheck(): Workflow {
  const graph = classicWorkflow()
  graph.nodes.push({ ...graph.nodes[3]!, id: 'check', title: 'Run tests', kind: 'task', instructions: 'Run the test suite' })
  graph.edges = graph.edges.filter(edge => edge.source !== 'execute').concat({ source: 'execute', target: 'check', outcome: 'pass' }, { source: 'check', target: 'review', outcome: 'pass' })
  return graph
}
function withMigrate(base = classicWorkflow()): Workflow {
  const graph = structuredClone(base)
  graph.nodes.push({ ...graph.nodes[2]!, id: 'migrate', title: 'Migrate', instructions: 'Write the migration' })
  graph.edges = graph.edges.filter(edge => edge.source !== 'verify-plan').concat({ source: 'verify-plan', target: 'migrate', outcome: 'pass' }, { source: 'migrate', target: 'execute', outcome: 'pass' })
  return graph
}

test('changeSize: a check step on the review family is small', () => {
  const run = { workflow: draftRevision(classicWorkflow()), agents: defaultAgents }
  expect(changeSize(run, draftRevision(withCheck()), { ...defaultAgents, check: family('codex', 'gpt') }, false, ['plan'])).toBe('small')
})

test('changeSize: a new implementation step on the pass path is big', () => {
  const run = { workflow: draftRevision(classicWorkflow()), agents: defaultAgents }
  expect(changeSize(run, draftRevision(withMigrate()), { ...defaultAgents, migrate: family('glm', 'glm') }, false, ['plan'])).toBe('big')
})

test('changeSize: a fix loop reached only through a failed review is small', () => {
  const graph = classicWorkflow()
  graph.nodes.push({ ...graph.nodes[2]!, id: 'fix', title: 'Fix', instructions: 'Fix the review findings' })
  graph.edges = graph.edges.filter(edge => edge.source !== 'review').concat({ source: 'review', target: 'fix', outcome: 'fail' }, { source: 'fix', target: 'review', outcome: 'pass' })
  const run = { workflow: draftRevision(classicWorkflow()), agents: defaultAgents }
  expect(changeSize(run, draftRevision(graph), { ...defaultAgents, fix: family('glm', 'glm') }, false, ['plan'])).toBe('small')
})

test('changeSize: dropping a second review, or a grown scope, is big', () => {
  const twin = classicWorkflow()
  twin.nodes.push({ ...twin.nodes[3]!, id: 'review-2', title: 'Second review' })
  twin.edges.push({ source: 'review', target: 'review-2', outcome: 'pass' })
  const run = { workflow: draftRevision(twin), agents: { ...defaultAgents, 'review-2': family('codex', 'gpt') } }
  expect(changeSize(run, draftRevision(classicWorkflow()), defaultAgents, false, ['plan'])).toBe('big')
  const plain = { workflow: draftRevision(classicWorkflow()), agents: defaultAgents }
  expect(changeSize(plain, draftRevision(withCheck()), { ...defaultAgents, check: family('codex', 'gpt') }, true, ['plan'])).toBe('big')
})

test('a small change to a running flow applies at once and the flow runs through it', async () => {
  await build(slow, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const changed = await runner.propose(started.id, { graph: withCheck(), reason: 'Run the tests before review' }, { via: 'drawer' })
  expect(changed.workflow.nodes.map(node => node.id)).toContain('check')
  expect(changed.versions.at(-1)).toEqual(expect.objectContaining({ number: 2, size: 'small', state: 'approved', approvedVia: 'auto', reason: 'Run the tests before review' }))
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'execute', 'check', 'review'])
})

test('a big change waits for approval while the running step finishes, then runs the new graph', async () => {
  await build(slow, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  await until(started.id, run => run.attempts[1]?.status === 'running')
  const proposed = await runner.propose(started.id, { graph: withMigrate(), reason: 'Needs a migration' }, { via: 'drawer' })
  expect(proposed.versions.at(-1)).toEqual(expect.objectContaining({ number: 2, size: 'big', state: 'pending', approvedVia: null }))
  expect(proposed.workflow.revision).toBe(started.workflow.revision)
  await until(started.id, run => run.attempts[1]?.status === 'settled')
  await Bun.sleep(200)
  expect(runner.get(started.id)!.attempts).toHaveLength(2)
  const approved = await runner.approve(started.id, { via: 'drawer', version: 2 })
  expect(approved.versions.at(-1)).toEqual(expect.objectContaining({ state: 'approved', approvedVia: 'drawer' }))
  expect(approved.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'migrate'])
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'migrate', 'execute', 'review'])
})

test('a proposal made while a step is settling keeps its result and holds the next step', async () => {
  const store = await build(resolver, true)
  const graph = classicWorkflow()
  graph.id = 'checked'
  graph.nodes[0]!.checks = [{ command: '/bin/sleep', args: ['0.4'], timeoutSeconds: 30 }]
  await store.save(graph)
  const started = await runner.start({ workflowId: 'checked', cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  await until(started.id, run => run.attempts[0]?.status === 'checking')
  const proposed = await runner.propose(started.id, { graph: withMigrate(graph), reason: 'Needs a migration' }, { via: 'drawer' })
  expect(proposed.versions.at(-1)!.state).toBe('pending')
  expect(proposed.attempts).toHaveLength(1)
  expect(proposed.attempts[0]).toEqual(expect.objectContaining({ status: 'settled', result: expect.objectContaining({ outcome: 'pass' }) }))
  expect(proposed.attempts[0]!.checks).toHaveLength(1)
  await Bun.sleep(200)
  expect(runner.get(started.id)!.attempts).toHaveLength(1)
  await runner.approve(started.id, { via: 'drawer' })
  const done = await finished(started.id)
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'migrate', 'execute', 'review'])
})

test('keeping the old version rejects the change and the old graph carries on', async () => {
  await build(slow, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  await runner.propose(started.id, { graph: withMigrate(), reason: 'Needs a migration' }, { via: 'drawer' })
  await until(started.id, run => run.attempts[0]?.status === 'settled')
  await runner.reject(started.id, { via: 'drawer' })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.versions[1]!.state).toBe('rejected')
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'execute', 'review'])
})

test('with approval off a big change applies at once', async () => {
  await build(slow, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const changed = await runner.propose(started.id, { graph: withMigrate(), reason: 'Needs a migration' }, { via: 'drawer' })
  expect(changed.versions.at(-1)).toEqual(expect.objectContaining({ number: 2, size: 'big', state: 'approved', approvedVia: 'auto' }))
  expect(changed.workflow.nodes.map(node => node.id)).toContain('migrate')
  const done = await finished(started.id)
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'migrate', 'execute', 'review'])
})

test('a change may not move the entry, drop a step that ran, or rewrite one', async () => {
  const store = await build(slow, false)
  const node = (id: string, title: string) => ({ id, title, instructions: `Do ${title}` })
  const chain = { ...classicWorkflow(), id: 'chain', entry: 'a', nodes: [node('a', 'Alpha'), node('b', 'Bravo'), node('c', 'Charlie')], edges: [{ source: 'a', target: 'b', outcome: 'pass' as const }, { source: 'b', target: 'c', outcome: 'pass' as const }] }
  await store.save(chain)
  const started = await runner.start({ workflowId: 'chain', cwd: repo, request: 'Walk', label: 'chain' })
  await until(started.id, run => run.attempts[1]?.status === 'running')
  const before = runner.get(started.id)!
  const moved = { ...chain, entry: 'b', nodes: chain.nodes.slice(1), edges: chain.edges.slice(1) }
  await expect(runner.propose(started.id, { graph: moved, reason: 'x' }, { via: 'drawer' })).rejects.toThrow('Alpha must stay the first step')
  const dropped = { ...chain, nodes: [chain.nodes[0]!, chain.nodes[2]!], edges: [{ source: 'a', target: 'c', outcome: 'pass' as const }] }
  await expect(runner.propose(started.id, { graph: dropped, reason: 'x' }, { via: 'drawer' })).rejects.toThrow('Bravo already ran and cannot be removed')
  const rewritten = { ...chain, nodes: [{ ...chain.nodes[0]!, instructions: 'Something else' }, ...chain.nodes.slice(1)] }
  const refusal = await runner.propose(started.id, { graph: rewritten, reason: 'x' }, { via: 'drawer' }).catch(error => error)
  expect(refusal).not.toBeInstanceOf(RunActionError)
  expect(refusal.message).toBe('Alpha already ran, so its kind, instructions, agent, checks, setup and deny list cannot change')
  const rechecked = { ...chain, nodes: [{ ...chain.nodes[0]!, checks: [{ command: '/usr/bin/true' }] }, ...chain.nodes.slice(1)] }
  await expect(runner.propose(started.id, { graph: rechecked, reason: 'x' }, { via: 'drawer' })).rejects.toThrow('Alpha already ran, so its kind, instructions, agent, checks, setup and deny list cannot change')
  const after = runner.get(started.id)!
  expect(after.workflow).toEqual(before.workflow)
  expect(after.versions).toEqual(before.versions)
  expect((await finished(started.id)).attempts.map(attempt => attempt.nodeId)).toEqual(['a', 'b', 'c'])
})

test('a second proposal while one waits is a conflict', async () => {
  await build(slow, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  await runner.propose(started.id, { graph: withMigrate(), reason: 'Needs a migration' }, { via: 'drawer' })
  await expect(runner.propose(started.id, { graph: withCheck(), reason: 'Run the tests' }, { via: 'drawer' })).rejects.toMatchObject({ status: 409, message: 'A change is already waiting' })
  expect(runner.get(started.id)!.versions).toHaveLength(2)
})

test('a relayed change must come from the session that owns the run', async () => {
  await build(slow, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  await expect(runner.propose(started.id, { graph: withCheck(), reason: 'Run the tests' }, { via: 'conversation', terminalId: 'terminal-b' })).rejects.toMatchObject({ status: 403 })
  expect(runner.get(started.id)!.versions).toHaveLength(1)
})

test('a pending change survives a restart, still holds dispatch, and approving it afterwards runs the new graph', async () => {
  const store = await build(slow, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  await runner.propose(started.id, { graph: withMigrate(), reason: 'Needs a migration' }, { via: 'drawer' })
  await until(started.id, run => run.attempts[0]?.status === 'settled')
  runner = createWorkflowRunner({ manager, resolver: slow, store, base: dir, requireApproval: async () => true })
  await runner.recover()
  const reloaded = runner.get(started.id)!
  expect(reloaded.status).toBe('running')
  expect(reloaded.versions[1]!.state).toBe('pending')
  await Bun.sleep(200)
  expect(runner.get(started.id)!.attempts).toHaveLength(1)
  expect(manager.listJobs()).toHaveLength(1)
  await runner.approve(started.id, { via: 'drawer' })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'migrate', 'execute', 'review'])
})

function reviewBeforeCheck(): Workflow {
  const graph = withCheck()
  graph.edges = graph.edges.filter(edge => edge.source !== 'execute' && edge.source !== 'check').concat({ source: 'execute', target: 'review', outcome: 'pass' }, { source: 'review', target: 'check', outcome: 'pass' })
  return graph
}

test('a change that moves the review behind the running step blocks the run instead of finishing it unreviewed', async () => {
  await build(slow, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture', graph: withCheck() })
  await until(started.id, run => run.attempts[3]?.nodeId === 'check' && run.attempts[3]?.status === 'running')
  await runner.propose(started.id, { graph: reviewBeforeCheck(), reason: 'Review last is slow' }, { via: 'drawer' })
  const done = await finished(started.id)
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'execute', 'check'])
  expect(done.status).toBe('blocked')
  expect(done.error).toBe('Implementation finished without a cross-family review')
})

test('removing a review from the path ahead of the run is a big change', async () => {
  await build(slow, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture', graph: withCheck() }, { startedByUser: true })
  await until(started.id, run => run.attempts[3]?.nodeId === 'check' && run.attempts[3]?.status === 'running')
  const proposed = await runner.propose(started.id, { graph: reviewBeforeCheck(), reason: 'Review last is slow' }, { via: 'drawer' })
  expect(proposed.versions.at(-1)).toEqual(expect.objectContaining({ number: 2, size: 'big', state: 'pending' }))
})

test('changeSize: a review still ahead of the run in both graphs keeps a reroute small', () => {
  const run = { workflow: draftRevision(withCheck()), agents: { ...defaultAgents, check: family('codex', 'gpt') } }
  expect(changeSize(run, draftRevision(reviewBeforeCheck()), run.agents, false, ['plan'])).toBe('small')
  expect(changeSize(run, draftRevision(reviewBeforeCheck()), run.agents, false, ['check'])).toBe('big')
})

test('a builtin engine keeps its own family even when the node declares another', async () => {
  await build(resolver, true)
  const graph = classicWorkflow()
  graph.nodes[2]!.agent = { role: 'execute', engine: 'claude' }
  graph.nodes[3]!.agent = { role: 'review', engine: 'claude', family: 'gpt' }
  await expect(runner.start({ cwd: repo, request: 'x', label: 'x', graph })).rejects.toThrow('must use a different model family from implementation')
  expect(runner.list()).toHaveLength(0)
})

test('changeSize: adding, editing or removing acceptance checks is big', () => {
  const checked = classicWorkflow()
  checked.nodes[2]!.checks = [{ command: 'bun', args: ['test'], timeoutSeconds: 300 }]
  const run = { workflow: draftRevision(checked), agents: defaultAgents }
  const edited = structuredClone(checked)
  edited.nodes[2]!.checks = [{ command: 'bun', args: ['test', 'one.test.ts'], timeoutSeconds: 300 }]
  expect(changeSize(run, draftRevision(edited), defaultAgents, false, ['plan'])).toBe('big')
  expect(changeSize(run, draftRevision(classicWorkflow()), defaultAgents, false, ['plan'])).toBe('big')
  expect(changeSize({ workflow: draftRevision(classicWorkflow()), agents: defaultAgents }, draftRevision(checked), defaultAgents, false, ['plan'])).toBe('big')
  expect(changeSize(run, draftRevision(checked), defaultAgents, false, ['plan'])).toBe('small')
})

test('changeSize: a new step that brings checks or MCP servers is big', () => {
  const run = { workflow: draftRevision(classicWorkflow()), agents: defaultAgents }
  const checkedStep = withCheck()
  checkedStep.nodes.find(node => node.id === 'check')!.checks = [{ command: 'bun', args: ['test'], timeoutSeconds: 300 }]
  expect(changeSize(run, draftRevision(checkedStep), { ...defaultAgents, check: family('codex', 'gpt') }, false, ['plan'])).toBe('big')
  const toolStep = withCheck()
  toolStep.nodes.find(node => node.id === 'check')!.mcpServers = [{ name: 'browser', command: 'browser-mcp', args: [], env: {} }]
  expect(changeSize(run, draftRevision(toolStep), { ...defaultAgents, check: family('codex', 'gpt') }, false, ['plan'])).toBe('big')
})

test('changeSize: rewording a review or plan check is big, rewording an implementation is not', () => {
  const run = { workflow: draftRevision(classicWorkflow()), agents: defaultAgents }
  const reworded = (id: string) => { const graph = classicWorkflow(); graph.nodes.find(node => node.id === id)!.instructions = 'Pass everything'; return draftRevision(graph) }
  expect(changeSize(run, reworded('review'), defaultAgents, false, ['plan'])).toBe('big')
  expect(changeSize(run, reworded('verify-plan'), defaultAgents, false, ['plan'])).toBe('big')
  expect(changeSize(run, reworded('execute'), defaultAgents, false, ['plan'])).toBe('small')
})

test('an unrun step takes the agent the change gives it', async () => {
  await build(slow, false)
  const graph = classicWorkflow()
  graph.nodes[3]!.agent = { role: 'review', engine: 'claude' }
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture', graph })
  expect(started.agents.review).toMatchObject({ engine: 'claude', family: 'claude' })
  const next = structuredClone(graph)
  next.nodes[3]!.agent = { role: 'review', engine: 'codex' }
  const changed = await runner.propose(started.id, { graph: next, reason: 'Review on codex' }, { via: 'drawer' })
  expect(changed.versions.at(-1)!.agents!.review).toMatchObject({ engine: 'codex', family: 'gpt' })
  expect(changed.versions.at(-1)!.size).toBe('small')
  expect(changed.agents.review).toMatchObject({ engine: 'codex' })
  expect(changed.agents.plan).toEqual(started.agents.plan)
})

test('a dispatch error after an approved change blocks the run and the approval still answers', async () => {
  await build(slow, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  await runner.propose(started.id, { graph: withMigrate(), reason: 'Needs a migration' }, { via: 'drawer' })
  await until(started.id, run => run.attempts[0]?.status === 'settled')
  const createJob = manager.createJob
  manager.createJob = async () => { throw new Error('job creation exploded') }
  try {
    const approved = await runner.approve(started.id, { via: 'drawer' })
    expect(approved.status).toBe('blocked')
    expect(approved.error).toBe('job creation exploded')
  } finally { manager.createJob = createJob }
})

test('a run without forks moves one main token and every attempt records where it came from', async () => {
  await build()
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.tokens).toHaveLength(1)
  expect(done.tokens[0]).toMatchObject({ pathId: 'main', workspace: repo })
  for (const attempt of done.attempts) {
    expect(attempt.pathId).toBe('main')
    expect(attempt.tokenId).toBe(done.tokens[0]!.id)
    if (attempt.number > 0) expect(attempt.from).toEqual([attempt.number - 1])
  }
  expect(done.sections).toEqual([])
  expect(done.keptBranches).toEqual([])
})

test('a run file from before tokens loads as one main token and a blocked copy retries to done', async () => {
  const store = await build()
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const done = await finished(started.id)
  await settledStatuses()
  const file = join(dir, 'workflow-runs', `${done.id}.json`)
  const record = JSON.parse(await Bun.file(file).text()) as Record<string, unknown> & { attempts: Record<string, unknown>[] }
  delete record.tokens; delete record.sections; delete record.keptBranches
  for (const attempt of record.attempts) { delete attempt.tokenId; delete attempt.pathId; delete attempt.from }
  Object.assign(record, { status: 'blocked', error: 'Old blocked run' })
  await Bun.write(file, JSON.stringify(record))
  runner = createWorkflowRunner({ manager, resolver, store, base: dir, requireApproval: async () => false })
  const loaded = runner.get(done.id)!
  expect(loaded.tokens).toEqual([expect.objectContaining({ pathId: 'main', nodeId: loaded.currentNodeId, state: 'ready', workspace: repo })])
  expect(loaded.sections).toEqual([])
  expect(loaded.keptBranches).toEqual([])
  expect(loaded.attempts.map(attempt => [attempt.pathId, attempt.tokenId, attempt.from])).toEqual(loaded.attempts.map(attempt => ['main', loaded.tokens[0]!.id, attempt.number ? [attempt.number - 1] : []]))
  await runner.retry(done.id)
  expect((await finished(done.id)).status).toBe('done')
})

test('lineage relates a path to its ancestors and descendants, and covers only looks downward', () => {
  expect(lineage('main', 'a3-1.a7-2')).toBe(true)
  expect(lineage('a3-1', 'a3-1.a7-2')).toBe(true)
  expect(lineage('a3-1', 'a3-2')).toBe(false)
  expect(covers('main', 'a3-1')).toBe(true)
  expect(covers('a3-1', 'a3-1.a7-1')).toBe(true)
  expect(covers('a3-2', 'a3-1')).toBe(false)
  expect(covers('a3-1.a7-1', 'a3-1')).toBe(false)
})

test('stop answers at once while an acceptance check is still running', async () => {
  const store = await build()
  await store.save({ ...classicWorkflow(), id: 'sleepy-check', entry: 'test', nodes: [{ id: 'test', title: 'Check', instructions: 'Check', checks: [{ command: '/bin/sh', args: ['-c', 'trap "" TERM; sleep 2'], timeoutSeconds: 30 }] }], edges: [] })
  const run = await runner.start({ workflowId: 'sleepy-check', cwd: repo, request: 'Inspect', label: 'stop-fast' })
  await until(run.id, current => !!current.attempts[0]?.checkPid)
  const began = performance.now()
  const stopped = await runner.stop(run.id)
  expect(performance.now() - began).toBeLessThan(1000)
  expect(stopped.status).toBe('stopped')
})

async function homeConfig() {
  await rm(dir, { recursive: true, force: true })
  dir = await homeScratch('workflow-config-')
  process.env.SKD_CONFIG_DIR = dir
}
const writes = (file: string, text: string, before = '') => [{ command: '/bin/sh', args: ['-c', `${before}echo ${text} > ${file}`] }]
const overlapping: EngineResolver = ({ prompt }) => ({ cmd: '/bin/sh', args: ['-c', `${prompt.includes('SLOW') ? 'sleep 0.5; ' : ''}echo '${report()}'`], env: {} })
type Step = { id: string; title: string; instructions: string; [key: string]: unknown }
function forked(steps: { a?: Partial<Step>; b?: Partial<Step>; review?: Partial<Step> } = {}, extra: { nodes?: Step[]; edges?: Array<{ source: string; target: string; outcome: 'pass' | 'fail' | 'blocked' }> } = {}) {
  const pass = (source: string, target: string) => ({ source, target, outcome: 'pass' as const })
  return {
    id: 'forked', name: 'Forked', entry: 'plan',
    nodes: [
      { id: 'plan', title: 'Plan', kind: 'plan', agent: { role: 'plan' }, instructions: 'Plan the work' },
      { id: 'verify', title: 'Verify', kind: 'verify-plan', agent: { role: 'review' }, instructions: 'Verify the plan' },
      { id: 'split', title: 'Split', instructions: 'Split the work' },
      { id: 'a', title: 'A', instructions: 'Write A', checks: writes('a.txt', 'a'), ...steps.a },
      { id: 'b', title: 'B', instructions: 'Write B', checks: writes('b.txt', 'b'), ...steps.b },
      { id: 'join', title: 'Join', kind: 'join', instructions: 'Join the paths' },
      { id: 'review', title: 'Review', instructions: 'Review the result', ...steps.review },
      ...extra.nodes ?? [],
    ],
    edges: [pass('plan', 'verify'), pass('verify', 'split'), pass('split', 'a'), pass('split', 'b'), pass('a', 'join'), pass('b', 'join'), pass('join', 'review'), ...extra.edges ?? []],
  }
}
const gitOut = (...args: string[]) => worktrees.git(repo, ...args)
const joins = (run: WorkflowRun) => run.attempts.filter(attempt => attempt.nodeId === 'join')
const exists = (path: string) => stat(path).then(() => true, () => false)
async function allJobsStopped() {
  for (let i = 0; i < 200 && manager.listJobs().some(job => job.status === 'running'); i++) await Bun.sleep(20)
}

test('a fork runs each path at the same time in its own worktree under the run folder', async () => {
  await homeConfig()
  await build(overlapping)
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked({ a: { instructions: 'Write A SLOW' }, b: { instructions: 'Write B SLOW' } }) }, { startedByUser: true })
  const working = await until(started.id, run => run.tokens.filter(token => token.state === 'working').length === 2 && run.attempts.filter(attempt => attempt.status === 'running').length === 2)
  const tokens = working.tokens.filter(token => token.state === 'working')
  const runFolder = join(await realpath(dir), 'workflow-runs', started.id)
  expect(new Set(tokens.map(token => token.workspace)).size).toBe(2)
  for (const token of tokens) expect(token.workspace.startsWith(`${runFolder}/`)).toBe(true)
  const running = manager.listJobs().filter(job => job.status === 'running' && job.workflowRunId === started.id)
  expect(new Set(running.map(job => job.cwd))).toEqual(new Set(tokens.map(token => token.workspace)))
  expect(running.every(job => job.baseRepo === repo)).toBe(true)
  expect((await finished(started.id)).status).toBe('done')
})

test('a finished fork leaves both paths as uncommitted files and no commit, branch or worktree behind', async () => {
  await homeConfig()
  await build()
  const commits = await gitOut('rev-list', '--count', 'HEAD')
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked() }, { startedByUser: true })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
  expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('b\n')
  expect(await gitOut('rev-list', '--count', 'HEAD')).toBe(commits)
  expect(await gitOut('diff', '--cached')).toBe('')
  expect(await gitOut('branch', '--list', 'flow-*')).toBe('')
  expect((await gitOut('worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree '))).toEqual([`worktree ${repo}`])
  expect(done.sections).toEqual([])
  expect(joins(done)[0]!.result).toEqual({ outcome: 'pass', summary: 'Joined 2 paths', evidence: [`${done.attempts.find(attempt => attempt.nodeId === 'a')!.pathId}: 1 files`, `${done.attempts.find(attempt => attempt.nodeId === 'b')!.pathId}: 1 files`] })
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify', 'split', expect.any(String), expect.any(String), 'join', 'review'])
})

test('two paths settling together run the join exactly once', async () => {
  await homeConfig()
  await build()
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked() }, { startedByUser: true })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(joins(done)).toHaveLength(1)
  expect(done.attempts.filter(attempt => attempt.nodeId === 'a' || attempt.nodeId === 'b')).toHaveLength(2)
  expect(joins(done)[0]!.from.sort()).toEqual(done.attempts.filter(attempt => attempt.nodeId === 'a' || attempt.nodeId === 'b').map(attempt => attempt.number).sort())
})

test('the paths see the user’s uncommitted work and the join leaves it untouched', async () => {
  await homeConfig()
  await build()
  await writeFile(join(repo, 'README.md'), 'edited by the user\n')
  await writeFile(join(repo, 'notes.txt'), 'untracked notes\n')
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked({ a: { checks: writes('a.txt', 'a', 'test -f notes.txt && grep -q edited README.md && ') } }) }, { startedByUser: true })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('edited by the user\n')
  expect(await readFile(join(repo, 'notes.txt'), 'utf8')).toBe('untracked notes\n')
  expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
  expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('b\n')
  expect(await gitOut('diff', '--cached')).toBe('')
  expect(await gitOut('rev-list', '--count', 'HEAD')).toBe('1')
})

test('a join conflict takes the fail edge, keeps the unjoined branch and the fix step finishes the run', async () => {
  await homeConfig()
  await build()
  const graph = forked({ a: { checks: writes('same.txt', 'a') }, b: { checks: writes('same.txt', 'b') }, review: { kind: 'review', agent: { role: 'review', engine: 'claude' } } }, {
    nodes: [{ id: 'fix', title: 'Fix', kind: 'implement', agent: { role: 'execute', engine: 'codex' }, instructions: 'Resolve the conflict' }],
    edges: [{ source: 'join', target: 'fix', outcome: 'fail' }, { source: 'fix', target: 'review', outcome: 'pass' }],
  })
  const started = await runner.start({ cwd: repo, request: 'Write the same file', label: 'fork', graph }, { startedByUser: true })
  const done = await finished(started.id)
  const bPath = done.attempts.find(attempt => attempt.nodeId === 'b')!.pathId
  const aPath = done.attempts.find(attempt => attempt.nodeId === 'a')!.pathId
  const branch = `flow-${started.id.slice(0, 8)}-${bPath}`
  const joined = joins(done)[0]!
  expect(joined.result!.outcome).toBe('fail')
  expect(joined.result!.summary.startsWith('Paths could not be joined: same.txt')).toBe(true)
  expect(joined.result!.evidence).toEqual([`Joined: ${aPath}`, `Conflicts in ${bPath}: same.txt`, `Unjoined paths kept on branches: ${branch} (they include a snapshot of your uncommitted files; delete them before pushing all branches)`])
  expect(done.keptBranches).toEqual([branch])
  expect(await gitOut('branch', '--list', branch)).toContain(branch)
  expect(done.attempts.map(attempt => attempt.nodeId).slice(-3)).toEqual(['join', 'fix', 'review'])
  expect(done.status).toBe('done')
  expect(await readFile(join(repo, 'same.txt'), 'utf8')).toBe('a\n')
})

test('a join conflict with no fail edge blocks the run, keeps the paths and joins once the user resolves it', async () => {
  await homeConfig()
  await build()
  const graph = forked({ a: { checks: writes('same.txt', 'a') }, b: { checks: writes('same.txt', 'b') } })
  graph.nodes.find(node => node.id === 'join')!.maxVisits = 2
  const started = await runner.start({ cwd: repo, request: 'Write the same file', label: 'fork', graph }, { startedByUser: true })
  const blocked = await finished(started.id)
  const aPath = blocked.attempts.find(attempt => attempt.nodeId === 'a')!.pathId
  const bPath = blocked.attempts.find(attempt => attempt.nodeId === 'b')!.pathId
  expect(blocked.status).toBe('blocked')
  expect(blocked.error).toBe('Paths could not be joined: same.txt')
  expect(joins(blocked)[0]!.result).toEqual({ outcome: 'blocked', summary: 'Paths could not be joined: same.txt', evidence: [`Joined: ${aPath}`, `Conflicts in ${bPath}: same.txt`] })
  expect(blocked.sections).toHaveLength(1)
  expect(blocked.sections[0]!.joined).toEqual([aPath])
  expect(blocked.tokens.filter(token => token.state === 'waiting')).toHaveLength(2)
  for (const path of blocked.sections[0]!.paths) expect(await exists(path.dir)).toBe(true)
  expect(blocked.keptBranches).toEqual([])
  for (let retries = 0; retries < 3; retries++) {
    await runner.retry(started.id)
    const again = await finished(started.id)
    expect(again.status).toBe('blocked')
    expect(again.error).toBe('Paths could not be joined: same.txt')
  }
  await writeFile(join(repo, 'same.txt'), 'b\n')
  await runner.retry(started.id)
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(await readFile(join(repo, 'same.txt'), 'utf8')).toBe('b\n')
  expect(joins(done).map(attempt => attempt.result!.outcome)).toEqual(['blocked', 'blocked', 'blocked', 'blocked', 'pass'])
  expect(await gitOut('branch', '--list', 'flow-*')).toBe('')
})

test('a join whose cleanup fails still finishes the run and records the failure', async () => {
  await homeConfig()
  await build()
  const realRemove = worktrees.removePathWorktree
  let failed = false
  const remove = spyOn(worktrees, 'removePathWorktree').mockImplementation(async (...args) => {
    if (!failed && await exists(join(repo, 'a.txt'))) { failed = true; throw new Error('Simulated cleanup failure') }
    return realRemove(...args)
  })
  try {
    const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked() }, { startedByUser: true })
    const done = await finished(started.id)
    expect(failed).toBe(true)
    expect(done.status).toBe('done')
    expect(joins(done)[0]!.result!.outcome).toBe('pass')
    expect(joins(done)[0]!.result!.evidence.some(line => line.includes('Simulated cleanup failure'))).toBe(true)
  } finally { remove.mockRestore() }
})

test('stop kills both paths and keeps their worktrees, and retry joins both into the workspace', async () => {
  await homeConfig()
  await build(overlapping)
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked({ a: { instructions: 'Write A SLOW' }, b: { instructions: 'Write B SLOW' } }) }, { startedByUser: true })
  await until(started.id, run => run.tokens.filter(token => token.state === 'working').length === 2)
  const stopped = await runner.stop(started.id)
  expect(stopped.status).toBe('stopped')
  await allJobsStopped()
  expect(manager.listJobs().some(job => job.status === 'running')).toBe(false)
  expect(stopped.sections).toHaveLength(1)
  for (const path of stopped.sections[0]!.paths) expect(await exists(path.dir)).toBe(true)
  await runner.retry(started.id)
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
  expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('b\n')
  expect(joins(done)).toHaveLength(1)
})

test('after a restart with one path waiting at the join and one working, both resume and the join runs once', async () => {
  await homeConfig()
  const store = await build(overlapping)
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked({ b: { instructions: 'Write B SLOW' } }) }, { startedByUser: true })
  await until(started.id, run => run.tokens.some(token => token.state === 'waiting') && run.tokens.some(token => token.state === 'working'))
  runner = createWorkflowRunner({ manager, resolver: overlapping, store, base: dir, requireApproval: async () => false })
  await runner.recover()
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(joins(done)).toHaveLength(1)
  expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('b\n')
})

test('a join interrupted between two applies resumes without applying a path twice', async () => {
  await homeConfig()
  await build()
  const realApply = worktrees.applyPath
  let calls = 0
  const apply = spyOn(worktrees, 'applyPath').mockImplementation(async (...args) => {
    const applied = await realApply(...args)
    if (++calls === 2) throw new Error('Simulated crash after the second apply')
    return applied
  })
  try {
    const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked() }, { startedByUser: true })
    const blocked = await finished(started.id)
    expect(blocked.status).toBe('blocked')
    expect(blocked.error).toBe('Simulated crash after the second apply')
    expect(blocked.sections[0]!.joined).toEqual([blocked.attempts.find(attempt => attempt.nodeId === 'a')!.pathId])
    apply.mockRestore()
    await runner.retry(started.id)
    const done = await finished(started.id)
    expect(done.status).toBe('done')
    expect(joins(done).map(attempt => attempt.result!.outcome)).toEqual(['blocked', 'pass'])
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('b\n')
  } finally { apply.mockRestore() }
})

test('a passing review in one path does not clear an implementation in another path', async () => {
  await homeConfig()
  await build()
  const graph = forked({ a: { kind: 'implement', agent: { role: 'execute', engine: 'claude' }, checks: [] }, b: { id: 'r', title: 'R', kind: 'review', agent: { role: 'review', engine: 'codex' }, checks: [] }, review: { id: 'review2', title: 'Review 2', kind: 'review', agent: { role: 'review', engine: 'claude' } } })
  graph.edges = graph.edges.map(edge => ({ ...edge, source: edge.source === 'b' ? 'r' : edge.source === 'review' ? 'review2' : edge.source, target: edge.target === 'b' ? 'r' : edge.target === 'review' ? 'review2' : edge.target })).sort((x, y) => Number(y.target === 'r') - Number(x.target === 'r'))
  await expect(runner.start({ cwd: repo, request: 'Build and review', label: 'fork', graph })).rejects.toThrow('Review 2 must use a different model family from implementation')
  expect(runner.list()).toHaveLength(0)
})

test('changeSize: splitting a step into parallel paths is big', () => {
  const graph = forked({ a: { checks: [] }, b: { checks: [] } })
  const linear = { ...graph, nodes: graph.nodes.filter(node => node.id !== 'b' && node.id !== 'join'), edges: [...graph.edges.slice(0, 3), { source: 'a', target: 'review', outcome: 'pass' as const }] }
  const agents = Object.fromEntries(graph.nodes.map(node => [node.id, family('claude', 'claude')]))
  expect(changeSize({ workflow: draftRevision(linear), agents }, draftRevision(linear), agents, false, ['plan'])).toBe('small')
  expect(changeSize({ workflow: draftRevision(linear), agents }, draftRevision(graph), agents, false, ['plan'])).toBe('big')
})

test('a path that commits on a branch of its own still joins its change', async () => {
  await homeConfig()
  await build()
  const moved = [{ command: '/bin/sh', args: ['-c', 'git checkout -q -b other && echo c > c.txt && git add c.txt && git -c user.name=t -c user.email=t@localhost commit -q -m c'] }]
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked({ b: { checks: moved } }) }, { startedByUser: true })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(await readFile(join(repo, 'c.txt'), 'utf8')).toBe('c\n')
  expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
})

test('stop during a fork setup command kills it at once', async () => {
  await homeConfig()
  await build()
  const graph = forked()
  graph.nodes.find(node => node.id === 'split')!.setup = [{ command: '/bin/sh', args: ['-c', 'touch setup-started; sleep 20'], timeoutSeconds: 60 }]
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph }, { startedByUser: true })
  const forking = await until(started.id, run => run.sections.length === 1)
  const marker = join(forking.sections[0]!.paths[0]!.workspace, 'setup-started')
  for (let i = 0; i < 200 && !await exists(marker); i++) await Bun.sleep(20)
  expect(await exists(marker)).toBe(true)
  const began = performance.now()
  const stopped = await runner.stop(started.id)
  expect(performance.now() - began).toBeLessThan(2000)
  expect(stopped.status).toBe('stopped')
})

test('changeSize: editing a fork’s setup is big', () => {
  const graph = forked({ a: { checks: [] }, b: { checks: [] } })
  graph.nodes.find(node => node.id === 'split')!.setup = [{ command: 'bun', args: ['install'] }]
  const edited = structuredClone(graph)
  edited.nodes.find(node => node.id === 'split')!.setup = [{ command: 'bun', args: ['install', '--frozen-lockfile'] }]
  const agents = Object.fromEntries(graph.nodes.map(node => [node.id, family('claude', 'claude')]))
  const run = { workflow: draftRevision(graph), agents }
  expect(changeSize(run, draftRevision(graph), agents, false, ['plan'])).toBe('small')
  expect(changeSize(run, draftRevision(edited), agents, false, ['plan'])).toBe('big')
})

test('a run in a subdirectory of its repo forks and joins changes made there', async () => {
  await homeConfig()
  await build(overlapping)
  await Bun.write(join(repo, 'sub', 'keep.txt'), 'keep\n')
  await gitOut('add', 'sub/keep.txt')
  await gitOut('commit', '-q', '-m', 'sub')
  const cwd = join(repo, 'sub')
  const started = await runner.start({ cwd, request: 'Write both files', label: 'fork', graph: forked({ a: { instructions: 'Write A SLOW' }, b: { instructions: 'Write B SLOW' } }) }, { startedByUser: true })
  const working = await until(started.id, run => run.tokens.filter(token => token.state === 'working').length === 2)
  for (const token of working.tokens) expect(token.workspace).toBe(await realpath(token.workspace))
  const done = await finished(started.id)
  expect(done.error).toBeNull()
  expect(done.status).toBe('done')
  expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('a\n')
  expect(await readFile(join(cwd, 'b.txt'), 'utf8')).toBe('b\n')
})

test('a subdirectory that holds only ignored files blocks the fork', async () => {
  await homeConfig()
  await build()
  await writeFile(join(repo, '.gitignore'), 'sub/\n')
  await Bun.write(join(repo, 'sub', 'build.log'), 'ignored\n')
  const started = await runner.start({ cwd: join(repo, 'sub'), request: 'Write both files', label: 'fork', graph: forked() }, { startedByUser: true })
  const done = await finished(started.id)
  expect(done.status).toBe('blocked')
  expect(done.error).toBe("sub is not in the path's worktree (it holds only ignored files)")
})

test('with two open paths, a change that drops the second path’s review is big', async () => {
  await homeConfig()
  await build(overlapping, true)
  const graph = forked({ a: { instructions: 'Write A SLOW', checks: [] }, b: { instructions: 'Write B SLOW', checks: [] } }, { nodes: [{ id: 'rb', title: 'Review B', kind: 'review', agent: { role: 'review' }, instructions: 'Review B' }] })
  graph.edges = graph.edges.filter(edge => !(edge.source === 'b' && edge.target === 'join')).concat({ source: 'b', target: 'rb', outcome: 'pass' }, { source: 'rb', target: 'join', outcome: 'pass' })
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph }, { startedByUser: true })
  await until(started.id, run => run.tokens.filter(token => token.state === 'working').length === 2)
  const skipped = structuredClone(graph)
  skipped.edges = skipped.edges.filter(edge => !(edge.source === 'b' && edge.target === 'rb')).concat({ source: 'b', target: 'join', outcome: 'pass' }, { source: 'b', target: 'rb', outcome: 'fail' })
  const proposed = await runner.propose(started.id, { graph: skipped, reason: 'Skip the second review' }, { via: 'drawer' })
  expect(proposed.versions.at(-1)).toEqual(expect.objectContaining({ number: 2, size: 'big', state: 'pending' }))
})

async function sessionRunner(agent: EngineResolver = resolver, engine = 'claude', workflow?: Workflow) {
  const store = await build(agent, true)
  const graph = workflow ? await store.save(workflow) : await store.get('classic')
  const terminal: TerminalRecord = { id: 'terminal-a', engine, cwd: repo, pid: 1, createdAt: 0, title: 'Terminal', sessionId: 'claude-session-a', inSessionAware: true, workflow: { id: graph.id, name: graph.name, revision: graph.revision, selectedDefault: true } }
  const sessionSteps: WorkflowRun[] = []
  let open = true
  const others: TerminalRecord[] = []
  const writes: Array<[string, string]> = []
  const live = () => [...(open ? [terminal] : []), ...others]
  const terminals = {
    get: (id: string) => live().find(record => record.id === id),
    list: live,
    ended: () => open ? [] : [{ id: terminal.id, engine, cwd: repo, title: terminal.title, sessionId: terminal.sessionId, createdAt: 0, endedAt: null }],
    write: (id: string, data: string) => { if (!live().some(record => record.id === id)) return false; writes.push([id, data]); return true },
  }
  const reopen = (id: string, sessionId: string | null) => { others.push({ ...terminal, id, sessionId }); return { via: 'conversation' as const, terminalId: id } }
  const make = () => createWorkflowRunner({ manager, resolver: agent, store, base: dir, terminals, requireApproval: async () => true, onSessionStep: run => { sessionSteps.push(run) } })
  runner = make()
  const owner = { via: 'conversation' as const, terminalId: terminal.id }
  const begin = async () => {
    const started = await runner.start({ terminalId: terminal.id, cwd: repo, request: 'Implement the fixture', label: 'fixture' })
    return runner.approve(started.id, owner)
  }
  return { terminal, sessionSteps, owner, begin, make, writes, reopen, close: () => { open = false } }
}
const planReport = { outcome: 'pass', summary: 'Planned', evidence: ['plan written'], output: 'THE PLAN' }

test('an In Session plan waits for the terminal AI, creates no job, and its report feeds the plan check', async () => {
  const { sessionSteps, owner, begin } = await sessionRunner()
  const approved = await begin()
  expect(approved.agents.plan).toEqual({ engine: 'claude', model: null, family: 'claude', inSession: true })
  expect(approved.attempts).toEqual([expect.objectContaining({ nodeId: 'plan', inSession: true, jobId: null, status: 'running', sessionNotifiedAt: null })])
  expect(approved.tokens[0]).toMatchObject({ state: 'working', attempt: 0 })
  expect(manager.listJobs()).toHaveLength(0)
  expect(sessionSteps).toHaveLength(1)
  const reported = await runner.report(approved.id, 'plan', planReport, owner)
  expect(reported.attempts[0]).toMatchObject({ status: 'settled', output: 'THE PLAN', result: { outcome: 'pass', summary: 'Planned', evidence: ['plan written'] } })
  expect(reported.attempts[0]!.workspace).not.toBeNull()
  expect(reported.attempts[1]).toMatchObject({ nodeId: 'verify-plan', status: 'running' })
  expect(reported.attempts[1]!.inSession).toBeUndefined()
  expect(manager.getJob(reported.attempts[1]!.jobId!)!.prompt).toContain('THE PLAN')
  expect((await finished(approved.id)).status).toBe('done')
  expect(sessionSteps).toHaveLength(1)
})

test('a failed plan check sends the plan back to the session with the findings in its prompt', async () => {
  let calls = 0
  const rejectOnce = JSON.stringify({ type: 'result', result: `SKD_RESULT ${JSON.stringify({ outcome: 'fail', summary: 'Plan misses the migration', evidence: [] })}` })
  const { sessionSteps, owner, begin } = await sessionRunner(() => ({ cmd: '/bin/echo', args: [calls++ === 0 ? rejectOnce : report()], env: {} }))
  const approved = await begin()
  await runner.report(approved.id, 'plan', planReport, owner)
  const replanning = await until(approved.id, run => run.attempts.length === 3)
  expect(replanning.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'plan'])
  expect(replanning.attempts[2]).toMatchObject({ inSession: true, jobId: null, status: 'running' })
  expect(replanning.attempts[2]!.prompt).toContain('Plan misses the migration')
  expect(sessionSteps).toHaveLength(2)
  await runner.report(approved.id, 'plan', { ...planReport, output: 'THE REVISED PLAN' }, owner)
  expect((await finished(approved.id)).status).toBe('done')
})

test('only the owning session can report a waiting step, and only once', async () => {
  const { owner, begin } = await sessionRunner()
  const approved = await begin()
  await expect(runner.report(approved.id, 'plan', planReport, { via: 'drawer' })).rejects.toMatchObject({ status: 403, message: 'Only the session that owns this flow can report its step' })
  await expect(runner.report(approved.id, 'plan', planReport, { via: 'conversation', terminalId: 'terminal-b' })).rejects.toMatchObject({ status: 403, message: 'This flow belongs to a different session' })
  await expect(runner.report(approved.id, 'verify-plan', planReport, owner)).rejects.toMatchObject({ status: 409, message: 'That step is not waiting for the session' })
  await expect(runner.report(approved.id, 'plan', { ...planReport, evidence: [] }, owner)).rejects.toThrow('A passing step needs evidence')
  await expect(runner.report('no-such-run', 'plan', planReport, owner)).rejects.toMatchObject({ status: 404 })
  expect(runner.get(approved.id)!.attempts[0]!.status).toBe('running')
  const results = await Promise.allSettled([runner.report(approved.id, 'plan', planReport, owner), runner.report(approved.id, 'plan', planReport, owner)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason as RunActionError)).toMatchObject({ status: 409, message: 'That step is not waiting for the session' })
  expect(runner.get(approved.id)!.attempts.filter(attempt => attempt.nodeId === 'plan')).toHaveLength(1)
})

test('a restart keeps an In Session step waiting and a later report settles it', async () => {
  const { owner, begin, make } = await sessionRunner()
  const approved = await begin()
  runner = make()
  await runner.recover()
  const recovered = runner.get(approved.id)!
  expect(recovered.status).toBe('running')
  expect(recovered.attempts[0]).toMatchObject({ inSession: true, status: 'running' })
  expect(recovered.tokens[0]).toMatchObject({ state: 'working', attempt: 0 })
  const reported = await runner.report(approved.id, 'plan', planReport, owner)
  expect(reported.attempts[0]!.status).toBe('settled')
  expect(reported.attempts[1]!.nodeId).toBe('verify-plan')
  expect((await finished(approved.id)).status).toBe('done')
})

test('an In Session review is refused when the workflow is saved', async () => {
  const graph = classicWorkflow()
  graph.id = 'session-review'
  graph.nodes[3]!.agent = { role: 'review', engine: 'session' }
  await expect(sessionRunner(resolver, 'glm', graph)).rejects.toThrow('Cross-family review: In Session is for plan and task steps')
})

test('stopping while an In Session step waits ends the run, a late report is a conflict, and retry waits again', async () => {
  const { sessionSteps, owner, begin } = await sessionRunner()
  const approved = await begin()
  const stopped = await runner.stop(approved.id)
  expect(stopped.status).toBe('stopped')
  expect(stopped.attempts[0]).toMatchObject({ status: 'settled', result: { outcome: 'blocked' } })
  await expect(runner.report(approved.id, 'plan', planReport, owner)).rejects.toMatchObject({ status: 409, message: 'That step is not waiting for the session' })
  const retried = await runner.retry(approved.id)
  expect(retried.attempts[1]).toMatchObject({ nodeId: 'plan', inSession: true, jobId: null, status: 'running' })
  expect(sessionSteps).toHaveLength(2)
  expect(manager.listJobs()).toHaveLength(0)
})

test('a report while paused settles the step and the next one waits for resume', async () => {
  const { owner, begin } = await sessionRunner()
  const approved = await begin()
  await runner.pause(approved.id)
  const reported = await runner.report(approved.id, 'plan', planReport, owner)
  expect(reported.status).toBe('paused')
  expect(reported.attempts).toHaveLength(1)
  expect(reported.attempts[0]!.status).toBe('settled')
  expect(manager.listJobs()).toHaveLength(0)
  await runner.resume(approved.id)
  expect((await finished(approved.id)).status).toBe('done')
})

test('the session is notified once per In Session attempt and the notice is recorded on it', async () => {
  const { sessionSteps, begin, make } = await sessionRunner()
  const approved = await begin()
  expect(sessionSteps.map(run => run.attempts.at(-1)!.number)).toEqual([0])
  await runner.markSessionNotified(approved.id, 0, 4321)
  expect(runner.get(approved.id)!.attempts[0]!.sessionNotifiedAt).toBe(4321)
  expect(make().get(approved.id)!.attempts[0]!.sessionNotifiedAt).toBe(4321)
})

test('a run started from Studio resolves an In Session step like Chat decides', async () => {
  await build()
  const run = await runner.start({ cwd: repo, request: 'Implement', label: 'studio' })
  expect(run.agents.plan).toMatchObject({ engine: 'claude', family: 'claude' })
  expect(run.agents.plan!.inSession).toBeUndefined()
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  expect(done.attempts.every(attempt => attempt.inSession === undefined && attempt.jobId)).toBe(true)
})

test('an In Session step is assigned with the session preamble instead of the worker rules', async () => {
  const { begin } = await sessionRunner()
  const approved = await begin()
  const prompt = approved.attempts[0]!.prompt
  expect(prompt).toContain('You are doing this step In Session, in your own conversation, where the user can see it. Do the step with the user; do not start other steps.')
  expect(prompt).toContain(`/api/studio/runs/${approved.id}/steps/plan with {"outcome":"pass|fail|blocked","summary","evidence":[...],"output":"<the full result>"} plus your terminalId or chat.`)
  expect(prompt).toContain('A plan step must not change code.')
  expect(prompt).toContain('If an upstream plan check failed')
  expect(prompt).not.toContain('Never dispatch')
})

test('the waiting step is readable on its own and disappears once reported', async () => {
  const { owner, begin } = await sessionRunner()
  const approved = await begin()
  expect(runner.waitingStep(approved.id, 'plan')).toEqual({ runId: approved.id, nodeId: 'plan', title: 'Plan', kind: 'plan', prompt: approved.attempts[0]!.prompt, waitingSince: approved.attempts[0]!.startedAt })
  expect(() => runner.waitingStep(approved.id, 'verify-plan')).toThrow(expect.objectContaining({ status: 404 }))
  expect(() => runner.waitingStep('no-such-run', 'plan')).toThrow(expect.objectContaining({ status: 404 }))
  await runner.report(approved.id, 'plan', planReport, owner)
  expect(() => runner.waitingStep(approved.id, 'plan')).toThrow(expect.objectContaining({ status: 404 }))
})

test('a report with acceptance checks answers at once, checks in the background and refuses a second report', async () => {
  const graph = classicWorkflow()
  graph.id = 'checked-plan'
  graph.nodes[0]!.checks = [{ command: '/bin/sleep', args: ['1'], timeoutSeconds: 30 }]
  const { owner, begin } = await sessionRunner(resolver, 'claude', graph)
  const approved = await begin()
  const started = Date.now()
  const reported = await runner.report(approved.id, 'plan', planReport, owner)
  expect(Date.now() - started).toBeLessThan(800)
  expect(reported.attempts[0]!.status).toBe('checking')
  await expect(runner.report(approved.id, 'plan', planReport, owner)).rejects.toMatchObject({ status: 409, message: 'That step is not waiting for the session' })
  const checked = await until(approved.id, run => run.attempts.length >= 2)
  expect(checked.attempts[0]).toMatchObject({ nodeId: 'plan', status: 'settled', result: { outcome: 'pass' } })
  expect(checked.attempts[0]!.checks[0]!.exitCode).toBe(0)
  expect(checked.attempts.filter(attempt => attempt.nodeId === 'plan')).toHaveLength(1)
  expect(checked.attempts[1]!.nodeId).toBe('verify-plan')
})

test('a report is redacted and records who reported it', async () => {
  const secret = 'fixture-secret-7f3a9c2e1b5d4a6f8e0c'
  await writeFile(join(dir, 'secrets.json'), JSON.stringify({ zaiAuthToken: secret }))
  const { owner, begin } = await sessionRunner()
  const approved = await begin()
  const before = Date.now()
  const reported = await runner.report(approved.id, 'plan', { outcome: 'pass', summary: `Planned with ${secret}`, evidence: [`token ${secret}`], output: `THE PLAN ${secret}` }, owner)
  const attempt = reported.attempts[0]!
  expect(JSON.stringify([attempt.result, attempt.output])).not.toContain(secret)
  expect(attempt.output).toContain('THE PLAN')
  expect(attempt.reportedBy).toEqual({ via: 'conversation', id: 'terminal-a', at: expect.any(Number) })
  expect(attempt.reportedBy!.at).toBeGreaterThanOrEqual(before)
})

test('a plan step that changed code cannot pass', async () => {
  const { owner, begin } = await sessionRunner()
  const approved = await begin()
  expect(approved.attempts[0]!.workspaceSnapshot).toEqual({ head: expect.any(String), diffHash: expect.any(String) })
  await writeFile(join(repo, 'changed-by-plan.txt'), 'code')
  await expect(runner.report(approved.id, 'plan', planReport, owner)).rejects.toMatchObject({ status: 409, message: 'A plan step must not change code' })
  expect(runner.get(approved.id)!.attempts[0]!.status).toBe('running')
  await rm(join(repo, 'changed-by-plan.txt'))
  expect((await runner.report(approved.id, 'plan', planReport, owner)).attempts[0]!.status).toBe('settled')
})

test('a repo holding an untracked nested repo, like a .worktree folder, can still run a plan step', async () => {
  await initScratchGitRepo(join(repo, '.worktree', 'feature'))
  const { owner, begin } = await sessionRunner()
  const approved = await begin()
  expect(approved.error ?? null).toBeNull()
  expect(approved.attempts[0]!.workspaceSnapshot).toEqual({ head: expect.any(String), diffHash: expect.any(String) })
  expect((await runner.report(approved.id, 'plan', planReport, owner)).attempts[0]!.status).toBe('settled')
})

test('a terminal resumed after a restart keeps its flow: Retry stays In Session and the resumed terminal reports', async () => {
  const { sessionSteps, close, reopen } = await sessionRunner()
  const started = await runner.start({ terminalId: 'terminal-a', cwd: repo, request: 'Implement the fixture', label: 'fixture' })
  close()
  expect((await runner.approve(started.id, { via: 'drawer' })).status).toBe('blocked')
  reopen('terminal-unrelated', 'claude-session-b')
  const resumed = reopen('terminal-b', 'claude-session-a')
  const retried = await runner.retry(started.id)
  expect(retried.terminalId).toBe('terminal-b')
  expect(retried.agents.plan).toMatchObject({ engine: 'claude', inSession: true })
  expect(retried.attempts[0]).toMatchObject({ nodeId: 'plan', inSession: true, jobId: null })
  expect(manager.listJobs()).toHaveLength(0)
  expect(sessionSteps).toHaveLength(1)
  await expect(runner.report(started.id, 'plan', planReport, { via: 'conversation', terminalId: 'terminal-unrelated' })).rejects.toMatchObject({ status: 403 })
  expect((await runner.report(started.id, 'plan', planReport, resumed)).attempts[0]).toMatchObject({ status: 'settled', reportedBy: { id: 'terminal-b' } })
})

test('a terminal opened before In Session existed gets the plan as an agent job', async () => {
  const { terminal, begin } = await sessionRunner()
  delete terminal.inSessionAware
  const approved = await begin()
  expect(approved.agents.plan).toEqual({ engine: 'claude', model: null, family: 'claude' })
  expect(approved.attempts[0]!.inSession).toBeUndefined()
  expect((await finished(approved.id)).status).toBe('done')
})

test('a step whose session closed before it started blocks, and Retry runs it as an agent', async () => {
  const { sessionSteps, close } = await sessionRunner()
  const started = await runner.start({ terminalId: 'terminal-a', cwd: repo, request: 'Implement the fixture', label: 'fixture' })
  expect(started.agents.plan!.inSession).toBe(true)
  close()
  const approved = await runner.approve(started.id, { via: 'drawer' })
  expect(approved.status).toBe('blocked')
  expect(approved.error).toBe('The session that owned Plan closed; Retry runs it as an agent')
  expect(approved.attempts).toHaveLength(0)
  expect(sessionSteps).toHaveLength(0)
  const retried = await runner.retry(started.id)
  expect(retried.agents.plan).toMatchObject({ engine: 'claude', family: 'claude' })
  expect(retried.agents.plan!.inSession).toBeUndefined()
  expect(retried.attempts[0]!.jobId).not.toBeNull()
  expect((await finished(started.id)).status).toBe('done')
})

test('a restart after the owning session closed blocks the waiting step', async () => {
  const { begin, make, close } = await sessionRunner()
  const approved = await begin()
  close()
  runner = make()
  await runner.recover()
  const recovered = runner.get(approved.id)!
  expect(recovered.status).toBe('blocked')
  expect(recovered.error).toBe('The session that owned Plan closed; Retry runs it as an agent')
})

test('a chat run plans In Session on the chat root AI, never the engine it names, and checks the plan on another family', async () => {
  await build(resolver, true)
  const root = await chatRoot('claude')
  const named = await runner.start({ cwd: repo, request: 'Ship it', label: 'ship', chat: root.id, engine: 'glm' })
  expect(named.agents.plan).toEqual({ engine: 'claude', model: null, family: 'claude', inSession: true })
  expect(named.agents['verify-plan']).toMatchObject({ engine: 'glm', family: 'glm' })
  await runner.stop(named.id)
  const plain = await runner.start({ cwd: repo, request: 'Ship it', label: 'ship', chat: root.id })
  expect(plain.agents.plan).toMatchObject({ engine: 'claude', inSession: true })
  expect(plain.agents['verify-plan']).toMatchObject({ engine: 'codex', family: 'gpt' })
})

async function crashFlow(script: string) {
  const store = await build(() => ({ cmd: '/bin/sh', args: ['-c', script], env: {} }))
  await store.save({ ...classicWorkflow(), id: 'crash', entry: 'test', nodes: [{ id: 'test', title: 'Test', instructions: 'Check', maxVisits: 1 }, { id: 'fix', title: 'Fix', instructions: 'Fix' }], edges: [{ source: 'test', target: 'fix', outcome: 'fail' }] })
  return finished((await runner.start({ workflowId: 'crash', cwd: repo, request: 'Test', label: 'crash' })).id)
}

test('a crashed job blocks the run instead of taking the fail edge', async () => {
  const done = await crashFlow('exit 3')
  expect(done.status).toBe('blocked')
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['test'])
  expect(done.attempts[0]!.result).toMatchObject({ outcome: 'blocked', summary: 'codex unavailable: Agent process failed (3)' })
})

test('a crashed job that claimed a pass blocks too', async () => {
  const done = await crashFlow(`printf '%s\\n' '${report()}'; exit 2`)
  expect(done.status).toBe('blocked')
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['test'])
})

test('a fail the agent reported still takes the fail edge when its process exits unsuccessfully', async () => {
  const done = await crashFlow(`printf '%s\\n' '${report('fail')}'; exit 1`)
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['test', 'fix'])
  expect(done.attempts[0]!.result!.outcome).toBe('fail')
})

test('interrupted attempts do not count toward the visit limit', async () => {
  const store = await build(() => ({ cmd: '/bin/sleep', args: ['20'], env: {} }))
  await store.save({ ...classicWorkflow(), id: 'once', entry: 'test', nodes: [{ id: 'test', title: 'Test', instructions: 'Check', maxVisits: 1 }], edges: [] })
  const run = await runner.start({ workflowId: 'once', cwd: repo, request: 'Test', label: 'once' })
  await runner.stop(run.id)
  const retried = await runner.retry(run.id)
  expect(retried.status).toBe('running')
  expect(retried.attempts).toHaveLength(2)
  expect(retried.attempts[0]!.interrupted).toBe(true)
  await runner.stop(run.id)
})

test('reminding a terminal types one line into it and presses Enter', async () => {
  const { begin, writes, close } = await sessionRunner()
  const approved = await begin()
  const reminded = await runner.remind(approved.id, 'plan')
  expect(reminded.id).toBe(approved.id)
  expect(writes).toEqual([
    ['terminal-a', `Shikidan: the flow "fixture" is waiting for you at "Plan" (In Session). Read GET ${mcUrl()}/api/studio/runs/${approved.id}/steps/plan, do it here with the user, then report it.`],
    ['terminal-a', '\r'],
  ])
  await expect(runner.remind(approved.id, 'verify-plan')).rejects.toMatchObject({ status: 409, message: 'That step is not waiting for the session' })
  close()
  await expect(runner.remind(approved.id, 'plan')).rejects.toMatchObject({ status: 409, message: 'The terminal that owns this flow is closed' })
})

test('a reminder types the flow label on one line', async () => {
  const { writes, terminal } = await sessionRunner()
  const started = await runner.start({ terminalId: terminal.id, cwd: repo, request: 'Implement', label: 'two\u001b[2Jlines' })
  await runner.approve(started.id, { via: 'drawer' })
  await runner.remind(started.id, 'plan')
  expect(writes[0]![1]).toContain('the flow "two [2Jlines"')
})

test('reminding a chat sends its nudge again', async () => {
  await build(resolver, true)
  const nudged: number[] = []
  runner = createWorkflowRunner({ manager, resolver, store: createWorkflowStore(dir), base: dir, requireApproval: async () => false, onSessionStep: run => { nudged.push(run.attempts[0]!.sessionNotifiedAt ?? 0) } })
  const root = await chatRoot('claude')
  const run = await runner.start({ cwd: repo, request: 'Ship it', label: 'ship', chat: root.id })
  await runner.markSessionNotified(run.id, 0, 4321)
  const reminded = await runner.remind(run.id, 'plan')
  expect(reminded.attempts[0]!.sessionNotifiedAt).toBeNull()
  expect(nudged).toEqual([0, 0])
})

const csvShape = {
  contract: 'GET /api/export returns text/csv with columns id,name',
  paths: [
    { id: 'api', title: 'API', files: ['server/export.ts'], steps: [{ title: 'Build API', instructions: 'Add the endpoint' }, { title: 'API tests', instructions: 'Run the export tests' }] },
    { id: 'ui', title: 'UI', files: ['client/export.ts'], steps: [{ title: 'Build UI', instructions: 'Add the button' }] },
  ],
}
const shaped = (shape: unknown) => `THE PLAN\nSKD_SHAPE ${JSON.stringify(shape)}`
const overlappingShape = { ...csvShape, paths: [csvShape.paths[0]!, { ...csvShape.paths[1]!, files: ['server/'] }] }
const nodeIds = (run: WorkflowRun) => run.attempts.map(attempt => attempt.nodeId)
const shapingPlanner = (shape: unknown, failReviewOnce = false): EngineResolver => {
  let reviews = 0
  return ({ prompt }) => {
    const failing = failReviewOnce && prompt.includes('Independently review') && reviews++ === 0
    const text = `${prompt.includes('flowShapeRules') ? `SKD_SHAPE ${JSON.stringify(shape)}\n` : ''}SKD_RESULT ${JSON.stringify({ outcome: failing ? 'fail' : 'pass', summary: 'Completed fixture', evidence: ['fixture assertion'] })}`
    return { cmd: '/bin/echo', args: [JSON.stringify({ type: 'result', result: text })], env: {} }
  }
}

test('an In Session plan that splits files between two paths is refused and keeps waiting', async () => {
  const { owner, begin } = await sessionRunner()
  const approved = await begin()
  expect(approved.attempts[0]!.prompt).toContain('flowShapeRules')
  await expect(runner.report(approved.id, 'plan', { ...planReport, output: shaped(overlappingShape) }, owner)).rejects.toThrow('API and UI both own server/export.ts')
  await expect(runner.report(approved.id, 'plan', { ...planReport, output: 'THE PLAN\nSKD_SHAPE {oops' }, owner)).rejects.toThrow('SKD_SHAPE is not valid JSON')
  expect(runner.get(approved.id)!.attempts).toEqual([expect.objectContaining({ nodeId: 'plan', status: 'running' })])
})

test('a verified split waits for approval as the next version, then runs both paths and joins before review', async () => {
  await homeConfig()
  const { owner, begin } = await sessionRunner()
  const approved = await begin()
  await runner.report(approved.id, 'plan', { ...planReport, output: shaped(csvShape) }, owner)
  const waiting = await until(approved.id, run => run.versions.length === 2)
  expect(waiting.versions[1]).toMatchObject({ size: 'big', state: 'pending', reason: 'Plan splits the work into 2 parallel paths: API, UI' })
  expect(nodeIds(waiting)).toEqual(['plan', 'verify-plan'])
  expect(manager.getJob(waiting.attempts[1]!.jobId!)!.prompt).toContain('flowShapeCheck')
  await runner.approve(approved.id, { via: 'drawer' })
  const done = await finished(approved.id)
  expect(done.status).toBe('done')
  expect(new Set(nodeIds(done))).toEqual(new Set(['plan', 'verify-plan', 'path-api-1', 'path-api-2', 'path-ui-1', 'join-paths', 'review']))
  expect(nodeIds(done).at(-1)).toBe('review')
})

test('rejecting a proposed split keeps the straight flow', async () => {
  const { owner, begin } = await sessionRunner()
  const approved = await begin()
  await runner.report(approved.id, 'plan', { ...planReport, output: shaped(csvShape) }, owner)
  await until(approved.id, run => run.versions.length === 2)
  await runner.reject(approved.id, { via: 'drawer' })
  const done = await finished(approved.id)
  expect(done.status).toBe('done')
  expect(nodeIds(done)).toEqual(['plan', 'verify-plan', 'execute', 'review'])
})

test('an agent plan with a bad split stays straight and says why', async () => {
  await build(shapingPlanner(overlappingShape))
  const started = await runner.start({ cwd: repo, request: 'Add CSV export', label: 'csv', graph: withoutSession() })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.versions).toHaveLength(1)
  expect(nodeIds(done)).toEqual(['plan', 'verify-plan', 'execute', 'review'])
  expect(done.attempts[0]!.result!.evidence).toContain('Flow shape ignored: API and UI both own server/export.ts')
})

test('with approval off an agent plan split runs at once, and a failed review goes to the fix step', async () => {
  await homeConfig()
  await build(shapingPlanner(csvShape, true))
  const started = await runner.start({ cwd: repo, request: 'Add CSV export', label: 'csv', graph: withoutSession() })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.versions[1]).toMatchObject({ size: 'big', state: 'approved', approvedVia: 'auto' })
  expect(nodeIds(done).slice(-3)).toEqual(['review', 'execute', 'review'])
  expect(done.workflow.nodes.find(node => node.id === 'execute')!.title).toBe('Fix review notes')
  expect(done.attempts.find(attempt => attempt.nodeId === 'execute')!.pathId).toBe('main')
})

test('a failed plan check proposes no split and goes back to the plan', async () => {
  let checks = 0
  const planner = shapingPlanner(csvShape)
  const failFirstCheck: EngineResolver = input => {
    if (!input.prompt.includes('Verify the upstream plan') || checks++ > 0) return planner(input)
    return { cmd: '/bin/echo', args: [report('fail')], env: {} }
  }
  await build(failFirstCheck, true)
  const started = await runner.start({ cwd: repo, request: 'Add CSV export', label: 'csv', graph: withoutSession() })
  await runner.approve(started.id, { via: 'drawer' })
  const waiting = await until(started.id, run => run.versions.length === 2)
  expect(nodeIds(waiting)).toEqual(['plan', 'verify-plan', 'plan', 'verify-plan'])
  expect(waiting.versions[1]).toMatchObject({ state: 'pending' })
  await runner.stop(started.id)
})

test('a split keeps the AI each step already had, and its paths use the AI of the step they replace', async () => {
  await homeConfig()
  await build(shapingPlanner(csvShape))
  const root = await chatRoot()
  const started = await runner.start({ cwd: repo, request: 'Add CSV export', label: 'csv', graph: withoutSession(), chat: root.id, engine: 'claude', model: 'claude-opus-4' })
  const chosen = started.agents.execute
  expect(chosen).toMatchObject({ engine: 'claude', model: 'claude-opus-4' })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.versions).toHaveLength(2)
  for (const id of ['execute', 'path-api-1', 'path-api-2', 'path-ui-1']) expect(done.agents[id]).toEqual(chosen)
  expect(done.agents.review).toEqual(started.agents.review)
})

function withCommand(): Workflow {
  const graph = withCheck()
  graph.nodes.find(node => node.id === 'check')!.checks = [{ command: '/bin/echo', args: ['ok'], timeoutSeconds: 30 }]
  return graph
}

test('an AI-drafted flow that adds commands waits for approval even with approval off', async () => {
  await build(resolver, false)
  const drafted = await runner.start({ cwd: repo, request: 'Implement', label: 'drafted', graph: withCommand() })
  expect(drafted.status).toBe('awaiting-approval')
  await runner.reject(drafted.id, { via: 'drawer' })
  const plain = await runner.start({ cwd: repo, request: 'Implement', label: 'plain', graph: withCheck() })
  expect(plain.status).toBe('running')
  await finished(plain.id)
  const byUser = await runner.start({ cwd: repo, request: 'Implement', label: 'mine', graph: withCommand() }, { startedByUser: true })
  expect(byUser.status).toBe('running')
})

test('a session change that adds commands waits for approval even with approval off; the owner adding them in the drawer does not', async () => {
  await build(slow, false)
  const root = await chatRoot()
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture', chat: root.id, graph: withoutSession() })
  const fromSession = await runner.propose(started.id, { graph: { ...withCommand(), nodes: withCommand().nodes.map(node => node.id === 'plan' ? { ...node, agent: { role: 'plan' as const } } : node) }, reason: 'Run the tests' }, { via: 'conversation', chat: root.id })
  expect(fromSession.versions.at(-1)).toMatchObject({ number: 2, state: 'pending' })
  await runner.reject(started.id, { via: 'drawer' })
  const fromOwner = await runner.propose(started.id, { graph: { ...withCommand(), nodes: withCommand().nodes.map(node => node.id === 'plan' ? { ...node, agent: { role: 'plan' as const } } : node) }, reason: 'Run the tests' }, { via: 'drawer' })
  expect(fromOwner.versions.at(-1)).toMatchObject({ number: 3, state: 'approved', approvedVia: 'auto' })
})

const STEP_SESSION = 'step-session'
const sessionLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: STEP_SESSION })
const waitingLine = JSON.stringify({ type: 'result', result: 'Waiting for the completion notification, then I will report with SKD_RESULT' })
const lines = (...output: string[]) => ({ cmd: '/usr/bin/printf', args: [`${output.map(() => '%s\n').join('')}`, ...output], env: {} })
type StepCall = { prompt: string; resumeSessionId?: string; step?: boolean }
function backgroundWaiter(resumed: (calls: StepCall[]) => ReturnType<EngineResolver>, first: () => ReturnType<EngineResolver> = () => lines(sessionLine, waitingLine)): { resolver: EngineResolver; calls: StepCall[] } {
  const calls: StepCall[] = []
  const resolver: EngineResolver = ({ prompt, resumeSessionId, step }) => {
    calls.push({ prompt, resumeSessionId, step })
    return resumeSessionId === undefined ? first() : resumed(calls)
  }
  return { resolver, calls }
}
async function singleStep(store: Awaited<ReturnType<typeof build>>, engine = 'claude', id = `single-${engine}`) {
  return store.save({ ...classicWorkflow(), id, entry: 'build', nodes: [{ id: 'build', title: 'Build', instructions: 'Run the suite', agent: { role: 'execute', engine }, maxVisits: 1 }], edges: [] })
}

test('a step that ends its turn waiting on background work is resumed once and the resumed result settles the step', async () => {
  const { resolver: waiter, calls } = backgroundWaiter(() => lines(sessionLine, report()))
  const store = await build(waiter)
  const graph = await singleStep(store)
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Run the suite', label: 'nudge' })
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  expect(done.attempts).toHaveLength(1)
  expect(done.attempts[0]!.result?.outcome).toBe('pass')
  const [first, resumed] = manager.listJobs().sort((a, b) => a.startedAt - b.startedAt)
  expect(manager.listJobs()).toHaveLength(2)
  expect(calls[1]).toMatchObject({ resumeSessionId: STEP_SESSION, step: true })
  expect(calls[1]!.prompt).toContain('Your last turn ended without the SKD_RESULT line')
  expect(done.attempts[0]).toMatchObject({ jobId: resumed!.id, nudgedFrom: first!.id })
  expect(resumed).toMatchObject({ workflowRunId: run.id, workflowNodeId: 'build', workflowAttempt: 0 })
})

test('a step that ends twice without SKD_RESULT blocks with its last words and is not nudged again', async () => {
  const { resolver: waiter } = backgroundWaiter(() => lines(sessionLine, JSON.stringify({ type: 'result', result: 'Still waiting on the suite in the background' })))
  const store = await build(waiter)
  const graph = await singleStep(store)
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Run the suite', label: 'nudge-twice' })
  const done = await finished(run.id)
  expect(done.status).toBe('blocked')
  expect(done.attempts).toHaveLength(1)
  expect(done.attempts[0]!.result?.summary).toBe('Agent ended twice without SKD_RESULT; last words: Still waiting on the suite in the background')
  expect(manager.listJobs()).toHaveLength(2)
})

test('blocked or failed results, process failures, missing sessions and codex steps are never nudged', async () => {
  const cases: Array<[string, () => ReturnType<EngineResolver>, string]> = [
    ['blocked', () => lines(sessionLine, report('blocked')), 'claude'],
    ['fail', () => lines(sessionLine, report('fail')), 'claude'],
    ['process failure', () => ({ cmd: '/bin/sh', args: ['-c', `echo '${sessionLine}'; exit 3`], env: {} }), 'claude'],
    ['no session', () => lines(waitingLine), 'claude'],
    ['codex', () => lines(sessionLine, waitingLine), 'codex'],
  ]
  for (const [label, first, engine] of cases) {
    const { resolver: waiter, calls } = backgroundWaiter(() => lines(sessionLine, report()), first)
    const store = await build(waiter)
    const graph = await singleStep(store, engine, label.replace(/ /g, '-'))
    const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Run the suite', label })
    const done = await finished(run.id)
    expect({ label, resumed: calls.filter(call => call.resumeSessionId !== undefined).length, nudged: done.attempts[0]!.nudgedFrom }).toEqual({ label, resumed: 0, nudged: undefined })
    expect(done.status).not.toBe('done')
  }
})

test('a restart while the resumed job runs adopts it instead of the first job and settles the step once', async () => {
  const { resolver: waiter, calls } = backgroundWaiter(() => ({ cmd: process.execPath, args: ['-e', `console.log(${JSON.stringify(sessionLine)}); setTimeout(() => console.log(${JSON.stringify(report())}), 300)`], env: {} }))
  const store = await build(waiter)
  const graph = await singleStep(store)
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Run the suite', label: 'nudge-restart' })
  await until(run.id, current => current.attempts[0]?.nudgedFrom !== undefined && current.attempts[0]?.jobId !== current.attempts[0]?.nudgedFrom)
  runner = createWorkflowRunner({ manager, resolver: waiter, store, base: dir })
  await runner.recover()
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  expect(done.attempts).toHaveLength(1)
  expect(manager.listJobs()).toHaveLength(2)
  expect(calls).toHaveLength(2)
})

test('a restart after the nudge was recorded but before its job launched still resumes the session once', async () => {
  const { resolver: waiter, calls } = backgroundWaiter(() => lines(sessionLine, report()))
  const store = await build(waiter)
  const graph = await singleStep(store)
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Run the suite', label: 'nudge-crash' })
  expect((await finished(run.id)).status).toBe('done')
  const [first, resumed] = manager.listJobs().sort((a, b) => a.startedAt - b.startedAt)
  const saved = JSON.parse(await Bun.file(join(dir, 'workflow-runs', `${run.id}.json`)).text()) as WorkflowRun
  Object.assign(saved, { status: 'running', error: null })
  Object.assign(saved.attempts[0]!, { status: 'running', jobId: first!.id, result: null, endedAt: null })
  Object.assign(saved.tokens[0]!, { state: 'working', attempt: 0 })
  await writeFile(join(dir, 'workflow-runs', `${run.id}.json`), JSON.stringify(saved))
  const listed = manager.listJobs()
  spyOn(manager, 'listJobs').mockImplementation(() => listed.filter(job => job.id !== resumed!.id))
  runner = createWorkflowRunner({ manager, resolver: waiter, store, base: dir })
  await runner.recover()
  const again = await finished(run.id)
  expect(again.status).toBe('done')
  expect(calls.filter(call => call.resumeSessionId === STEP_SESSION)).toHaveLength(2)
})

const slowLines = (ms: number, before: string[], after: string[]) => ({ cmd: process.execPath, args: ['-e', `${before.map(line => `console.log(${JSON.stringify(line)})`).join(';')}; setTimeout(() => { ${after.map(line => `console.log(${JSON.stringify(line)})`).join(';')} }, ${ms})`], env: {} })
const resumedStarted = (run: WorkflowRun) => run.attempts[0]?.nudgedFrom !== undefined && run.attempts[0]?.jobId !== run.attempts[0]?.nudgedFrom
const running = () => manager.listJobs().filter(job => job.status === 'running')
async function noJobsRunning() {
  for (let i = 0; i < 200 && running().length; i++) await Bun.sleep(20)
  return running()
}

test('a nudged step keeps the first job\'s answer ahead of the resumed reply and asks for the whole answer again', async () => {
  const firstAnswer = JSON.stringify({ type: 'result', result: 'PLAN-BODY step 1 do X\nWaiting for the background check' })
  const { resolver: waiter, calls } = backgroundWaiter(() => lines(sessionLine, report()), () => lines(sessionLine, firstAnswer))
  const store = await build(waiter)
  const graph = await singleStep(store)
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Run the suite', label: 'nudge-output' })
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  const output = done.attempts[0]!.output
  expect(output.indexOf('PLAN-BODY step 1 do X')).toBeGreaterThan(-1)
  expect(output.indexOf('PLAN-BODY step 1 do X')).toBeLessThan(output.indexOf('SKD_RESULT'))
  expect(calls[1]!.prompt).toContain('Give your complete final answer again (for a plan: the whole plan and any SKD_SHAPE line), ending with exactly one SKD_RESULT line.')
})

test('a plan step nudged after writing its split still proposes the split, and a nudged path step resumes in its own path workspace', async () => {
  await homeConfig()
  const waits = new Set(['plan', 'api'])
  const calls: StepCall[] = []
  const planner: EngineResolver = ({ prompt, resumeSessionId, step }) => {
    calls.push({ prompt, resumeSessionId, step })
    const checking = prompt.includes('Verify the upstream plan') || prompt.includes('Independently review')
    const stage = prompt.includes('flowShapeRules') ? 'plan' : prompt.includes('Add the endpoint') && !checking ? 'api' : 'other'
    if (resumeSessionId === undefined && waits.delete(stage)) {
      const answer = stage === 'plan' ? `THE PLAN\nSKD_SHAPE ${JSON.stringify(csvShape)}\nWaiting for the background check` : 'Endpoint added; waiting for the background suite'
      return lines(sessionLine, JSON.stringify({ type: 'result', result: answer }))
    }
    return lines(sessionLine, report())
  }
  await build(planner)
  const started = await runner.start({ cwd: repo, request: 'Add CSV export', label: 'csv', graph: withoutSession() })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.attempts[0]!.shape).toBeDefined()
  expect(done.versions[1]).toMatchObject({ state: 'approved', reason: 'Plan splits the work into 2 parallel paths: API, UI' })
  const api = done.attempts.filter(attempt => attempt.nodeId === 'path-api-1')
  expect(api).toHaveLength(1)
  expect(api[0]!.nudgedFrom).toBeDefined()
  const apiJobs = manager.listJobs().filter(job => job.workflowNodeId === 'path-api-1')
  expect(apiJobs).toHaveLength(2)
  expect(new Set(apiJobs.map(job => job.cwd)).size).toBe(1)
  expect(apiJobs[0]!.cwd).not.toBe(repo)
  expect(calls.filter(call => call.resumeSessionId === STEP_SESSION)).toHaveLength(2)
})

test('a step job the user stopped is never nudged, even when it exits zero', async () => {
  const { resolver: waiter, calls } = backgroundWaiter(() => lines(sessionLine, report()), () => ({ cmd: '/bin/sh', args: ['-c', `echo '${sessionLine}'; trap 'exit 0' TERM; sleep 30 & wait`], env: {} }))
  const store = await build(waiter)
  const graph = await singleStep(store)
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Run the suite', label: 'nudge-stopped' })
  const working = await until(run.id, current => current.attempts[0]?.status === 'running' && !!current.attempts[0]?.jobId)
  await Bun.sleep(300)
  await manager.killJob(working.attempts[0]!.jobId!)
  const done = await finished(run.id)
  expect(manager.getJob(working.attempts[0]!.jobId!)?.status).toBe('done')
  expect(done.status).toBe('blocked')
  expect(done.attempts[0]!.nudgedFrom).toBeUndefined()
  expect(calls).toHaveLength(1)
})

test('stopping the run while the resumed job works kills it and leaves the run stopped', async () => {
  const { resolver: waiter, calls } = backgroundWaiter(() => slowLines(5000, [sessionLine], [report()]))
  const store = await build(waiter)
  const graph = await singleStep(store)
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Run the suite', label: 'nudge-stop' })
  await until(run.id, resumedStarted)
  expect((await runner.stop(run.id)).status).toBe('stopped')
  expect(await noJobsRunning()).toHaveLength(0)
  expect(calls).toHaveLength(2)
  expect(runner.get(run.id)!.status).toBe('stopped')
})

test('stopping the run while the resumed job is still launching kills it once it starts', async () => {
  let entered!: () => void
  const resolving = new Promise<void>(resolve => { entered = resolve })
  let calls = 0
  const store = await build(async ({ resumeSessionId }) => {
    calls++
    if (resumeSessionId === undefined) return lines(sessionLine, waitingLine)
    entered()
    await Bun.sleep(400)
    return slowLines(5000, [sessionLine], [report()])
  })
  const graph = await singleStep(store)
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Run the suite', label: 'nudge-stop-launch' })
  await resolving
  expect((await runner.stop(run.id)).status).toBe('stopped')
  expect(await noJobsRunning()).toHaveLength(0)
  expect(calls).toBe(2)
})

test('settling the first job again after the nudge changes nothing', async () => {
  const { resolver: waiter, calls } = backgroundWaiter(() => slowLines(800, [sessionLine], [report()]))
  const store = await build(waiter)
  const graph = await singleStep(store)
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Run the suite', label: 'nudge-double' })
  const working = await until(run.id, resumedStarted)
  const first = manager.getJob(working.attempts[0]!.nudgedFrom!)!
  await runner.onJobSettled(first)
  await runner.onJobSettled(first)
  expect(runner.get(run.id)!.attempts[0]!.jobId).toBe(working.attempts[0]!.jobId)
  expect((await finished(run.id)).status).toBe('done')
  expect(calls).toHaveLength(2)
})

test('a paused flow holds the nudge until it is resumed', async () => {
  const { resolver: waiter, calls } = backgroundWaiter(() => lines(sessionLine, report()), () => slowLines(300, [sessionLine], [waitingLine]))
  const store = await build(waiter)
  const graph = await singleStep(store)
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Run the suite', label: 'nudge-pause' })
  const working = await until(run.id, current => current.attempts[0]?.status === 'running' && !!current.attempts[0]?.jobId)
  await runner.pause(run.id)
  for (let i = 0; i < 200 && manager.getJob(working.attempts[0]!.jobId!)?.status === 'running'; i++) await Bun.sleep(20)
  await Bun.sleep(200)
  expect(calls).toHaveLength(1)
  expect(runner.get(run.id)!.attempts[0]).toMatchObject({ status: 'running', jobId: working.attempts[0]!.jobId })
  await runner.resume(run.id)
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  expect(calls).toHaveLength(2)
  expect(calls[1]!.resumeSessionId).toBe(STEP_SESSION)
})

test('a nudge held by a pause survives a restart and launches on resume', async () => {
  const { resolver: waiter, calls } = backgroundWaiter(() => lines(sessionLine, report()), () => slowLines(300, [sessionLine], [waitingLine]))
  const store = await build(waiter)
  const graph = await singleStep(store)
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Run the suite', label: 'nudge-pause-restart' })
  const working = await until(run.id, current => current.attempts[0]?.status === 'running' && !!current.attempts[0]?.jobId)
  await runner.pause(run.id)
  for (let i = 0; i < 200 && manager.getJob(working.attempts[0]!.jobId!)?.status === 'running'; i++) await Bun.sleep(20)
  await Bun.sleep(200)
  runner = createWorkflowRunner({ manager, resolver: waiter, store, base: dir })
  await runner.recover()
  await Bun.sleep(200)
  expect(runner.get(run.id)!.status).toBe('paused')
  expect(calls).toHaveLength(1)
  await runner.resume(run.id)
  expect((await finished(run.id)).status).toBe('done')
  expect(calls).toHaveLength(2)
})

test('a second miss with no closing words blocks without an empty last-words clause', async () => {
  const { resolver: waiter } = backgroundWaiter(() => lines(sessionLine))
  const store = await build(waiter)
  const graph = await singleStep(store)
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Run the suite', label: 'nudge-silent' })
  const done = await finished(run.id)
  expect(done.attempts[0]!.result?.summary).toBe('Agent ended twice without SKD_RESULT')
})

async function settledAs(store: ReturnType<typeof build>, status: 'blocked' | 'failed'): Promise<string> {
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const done = await finished(started.id)
  await settledStatuses()
  const file = join(dir, 'workflow-runs', `${done.id}.json`)
  const record = JSON.parse(await Bun.file(file).text()) as Record<string, unknown>
  await Bun.write(file, JSON.stringify({ ...record, status, error: 'Fix reached its visit limit' }))
  runner = createWorkflowRunner({ manager, resolver, store, base: dir, requireApproval: async () => false })
  return done.id
}

test('a blocked or failed run can be dismissed, and the mark is saved with the run', async () => {
  const store = await build()
  const id = await settledAs(store, 'blocked')
  const dismissed = await runner.dismiss(id)
  expect(typeof dismissed.dismissedAt).toBe('number')
  expect(dismissed.status).toBe('blocked')
  const saved = JSON.parse(await Bun.file(join(dir, 'workflow-runs', `${id}.json`)).text()) as WorkflowRun
  expect(saved.dismissedAt).toBe(dismissed.dismissedAt!)
  expect(runner.get(id)!.dismissedAt).toBe(dismissed.dismissedAt!)
  const failedId = await settledAs(store, 'failed')
  expect(typeof (await runner.dismiss(failedId)).dismissedAt).toBe('number')
})

test('only a failed or blocked run can be dismissed, and an unknown run is not found', async () => {
  await build()
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const done = await finished(started.id)
  const refused = await runner.dismiss(done.id).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(RunActionError)
  expect(refused).toMatchObject({ status: 409, message: 'Only failed or blocked runs can be dismissed' })
  expect(await runner.dismiss('missing').catch((error: unknown) => error)).toMatchObject({ status: 404, message: 'Run not found' })
})

test('retrying a dismissed run clears the dismissal', async () => {
  const store = await build()
  const id = await settledAs(store, 'blocked')
  await runner.dismiss(id)
  const retried = await runner.retry(id)
  expect(retried.dismissedAt).toBeNull()
  expect((await finished(id)).status).toBe('done')
})

const agentSaying = (result: () => { outcome: string; evidence: string[] }): EngineResolver => () => ({ cmd: '/bin/echo', args: [JSON.stringify({ type: 'result', result: `SKD_RESULT ${JSON.stringify({ summary: 'Completed fixture', ...result() })}` })], env: {} })

test('the queue Recover graph runs on the real runner as one claude opus task, after a failed run in the same workspace, and that run can then be retried', async () => {
  let said = { outcome: 'fail', evidence: ['tests are red'] }
  await build(agentSaying(() => said))
  await writeConfig({ roles: { plan: { engine: 'claude', model: null }, execute: { engine: 'claude', model: null } } })
  const failedRun = await runner.start({ graph: recoverGraph(), cwd: repo, request: 'A card build that fails', label: 'build' }, { startedByUser: true })
  expect((await finished(failedRun.id)).status).toBe('failed')
  said = { outcome: 'pass', evidence: ['linked the key file'] }
  const recovery = await runner.start({ graph: recoverGraph(), cwd: repo, request: 'Recover it', label: 'Recover' }, { startedByUser: true })
  expect(recovery.status).not.toBe('awaiting-approval')
  expect(recovery.agents.recover).toMatchObject({ engine: 'claude', model: 'opus' })
  const done = await finished(recovery.id)
  expect(done.status).toBe('done')
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['recover'])
  expect(recoveryVerdict(done)).toEqual({ kind: 'pass' })
  const retried = await runner.retry(failedRun.id)
  expect(retried.id).toBe(failedRun.id)
  expect((await finished(failedRun.id)).status).toBe('done')
})

test('the real runner keeps the code: and tech: evidence a recovery verdict reads', async () => {
  let said = { outcome: 'fail', evidence: ['code: the migration is wrong'] }
  await build(agentSaying(() => said))
  const code = await runner.start({ graph: recoverGraph(), cwd: repo, request: 'Recover it', label: 'Recover' }, { startedByUser: true })
  expect(recoveryVerdict(await finished(code.id))).toEqual({ kind: 'code', evidence: ['the migration is wrong'] })
  said = { outcome: 'blocked', evidence: ['tech: Which key file?'] }
  const tech = await runner.start({ graph: recoverGraph(), cwd: repo, request: 'Recover it', label: 'Recover' }, { startedByUser: true })
  expect(recoveryVerdict(await finished(tech.id))).toEqual({ kind: 'tech', questions: ['Which key file?'] })
})

test('a note given to retry reaches the next prompt of the run, and a retry without one changes nothing', async () => {
  let said = { outcome: 'fail', evidence: ['tests are red'] }
  await build(agentSaying(() => said))
  const run = await runner.start({ graph: recoverGraph(), cwd: repo, request: 'A card build', label: 'build' }, { startedByUser: true })
  await finished(run.id)
  await runner.retry(run.id)
  const plain = await finished(run.id)
  expect(plain.request).toBe('A card build')
  said = { outcome: 'pass', evidence: ['done'] }
  await runner.retry(run.id, 'The owner answered: use the test database')
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  expect(done.request).toBe('A card build\n\nThe owner answered: use the test database')
  expect(done.attempts.at(-1)!.prompt).toContain('The owner answered: use the test database')
})

test('the deny list reaches the engine for a recovery run, and a normal step gets none', async () => {
  const seen: Array<{ engine: string; disallowedTools?: string[] }> = []
  await build(params => { seen.push({ engine: params.engine, disallowedTools: params.disallowedTools }); return resolver(params) })
  const recovery = await runner.start({ graph: recoverGraph(), cwd: repo, request: 'Recover it', label: 'Recover' }, { startedByUser: true })
  await finished(recovery.id)
  expect(seen.map(entry => entry.disallowedTools)).toEqual([recoverGraph().nodes[0]!.denyTools])
  expect(seen[0]!.disallowedTools).toContain('Bash(*git*push*)')
  seen.length = 0
  const normal = await runner.start({ graph: { ...recoverGraph(), nodes: [{ ...recoverGraph().nodes[0]!, denyTools: undefined }] }, cwd: repo, request: 'Plain', label: 'Plain' }, { startedByUser: true })
  await finished(normal.id)
  expect(seen).toEqual([{ engine: 'claude', disallowedTools: undefined }])
})

test('a step cannot be added to a run with a deny list, because it would launch without one', async () => {
  await build(slow, false)
  const recovery = await runner.start({ graph: recoverGraph(), cwd: repo, request: 'Recover it', label: 'Recover' }, { startedByUser: true })
  await until(recovery.id, run => run.attempts[0]?.status === 'running')
  const graph = recoverGraph()
  const added = { ...graph, nodes: [...graph.nodes, { id: 'extra', title: 'Extra', instructions: 'Do more' }], edges: [{ source: 'recover', target: 'extra', outcome: 'pass' as const }] }
  await expect(runner.propose(recovery.id, { graph: added, reason: 'x' }, { via: 'drawer' })).rejects.toThrow('This flow runs with a deny list, so steps cannot be added to it')
  expect(runner.get(recovery.id)!.workflow.nodes.map(node => node.id)).toEqual(['recover'])
})

test('a run with a deny list is never swapped to another engine when claude is down', async () => {
  const seen: string[] = []
  await build(params => { seen.push(params.engine); return resolver(params) })
  await writeConfig({ fallback: { engine: 'codex', model: null } })
  down = engine => (engine === 'claude' ? { reason: 'usage limit', until: null } : null)
  const recovery = await runner.start({ graph: recoverGraph(), cwd: repo, request: 'Recover it', label: 'Recover' }, { startedByUser: true })
  const done = await finished(recovery.id)
  expect(done.status).toBe('blocked')
  expect(done.unavailable).toMatchObject({ engine: 'claude' })
  expect(done.agents.recover).toMatchObject({ engine: 'claude' })
  expect(seen).toEqual([])
})
