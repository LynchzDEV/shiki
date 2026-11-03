import { afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createJobManager, type JobManager } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { prepareRepoWorkspace } from '../server/repo-workspace'
import { homeScratch, sweepHomeScratch } from './support/home-scratch'
import { createWorkflowRunner, type WorkflowRun, type WorkflowRunner } from '../server/workflow-runner'
import { createWorkflowStore, type Workflow } from '../server/workflows'
import { classicWorkflow } from './support/classic-workflow'
import { git, repoAt } from './support/git-repos'

setDefaultTimeout(30_000)

let dir: string, parent: string, workspace: string, manager: JobManager, runner: WorkflowRunner
const passing = (text = '') => JSON.stringify({ type: 'result', result: `${text}SKD_RESULT ${JSON.stringify({ outcome: 'pass', summary: 'Completed fixture', evidence: ['fixture assertion'] })}` })
const echo: EngineResolver = () => ({ cmd: '/bin/echo', args: [passing()], env: {} })

beforeAll(sweepHomeScratch)
beforeEach(async () => {
  dir = await homeScratch('multi-runner-config-')
  parent = await mkdtemp(join(homedir(), 'mc-multi-runner-'))
  process.env.SKD_CONFIG_DIR = dir
  for (const name of ['a', 'b', 'c']) await repoAt(join(parent, name))
  workspace = (await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-split-1-a8c0')).worktree
})
afterEach(async () => {
  for (const run of runner?.list() ?? []) if (run.status === 'running') await runner.stop(run.id)
  for (const job of manager?.listJobs() ?? []) if (job.status === 'running') await manager.killJob(job.id)
  for (let i = 0; i < 200 && manager?.listJobs().some(job => job.status === 'running'); i++) await Bun.sleep(20)
  delete process.env.SKD_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
  await rm(parent, { recursive: true, force: true })
})

function build(agent: EngineResolver = echo) {
  const store = createWorkflowStore(dir)
  manager = createJobManager({ onJobSettled: job => { void runner.onJobSettled(job) } })
  runner = createWorkflowRunner({ manager, resolver: agent, store, base: dir, requireApproval: async () => false })
}
async function finished(id: string): Promise<WorkflowRun> {
  for (let i = 0; i < 400; i++) { const run = runner.get(id)!; if (!['running', 'paused', 'awaiting-approval'].includes(run.status)) return run; await Bun.sleep(20) }
  throw new Error('Run did not settle')
}
async function until(id: string, predicate: (run: WorkflowRun) => boolean): Promise<WorkflowRun> {
  for (let i = 0; i < 400; i++) { const run = runner.get(id)!; if (predicate(run)) return run; await Bun.sleep(20) }
  throw new Error('Run never reached the expected state')
}

type Step = { id: string; title: string; instructions: string; [key: string]: unknown }
const writes = (file: string, text: string) => [{ command: '/bin/sh', args: ['-c', `echo ${text} > ${file}`] }]
function forked(steps: { a?: Partial<Step>; b?: Partial<Step> } = {}): Workflow {
  const pass = (source: string, target: string) => ({ source, target, outcome: 'pass' as const })
  return {
    ...classicWorkflow(), id: 'forked', name: 'Forked', entry: 'plan',
    nodes: [
      { id: 'plan', title: 'Plan', kind: 'plan', agent: { role: 'plan' }, instructions: 'Plan the work' },
      { id: 'verify', title: 'Verify', kind: 'verify-plan', agent: { role: 'review' }, instructions: 'Verify the plan' },
      { id: 'split', title: 'Split', instructions: 'Split the work' },
      { id: 'a', title: 'A', instructions: 'Write A', ...steps.a },
      { id: 'b', title: 'B', instructions: 'Write B', ...steps.b },
      { id: 'join', title: 'Join', kind: 'join', instructions: 'Join the paths' },
      { id: 'review', title: 'Review', instructions: 'Review the result' },
    ],
    edges: [pass('plan', 'verify'), pass('verify', 'split'), pass('split', 'a'), pass('split', 'b'), pass('a', 'join'), pass('b', 'join'), pass('join', 'review')],
  } as unknown as Workflow
}
async function jobsStopped(): Promise<void> {
  for (let i = 0; i < 400 && manager.listJobs().some(job => job.status === 'running'); i++) await Bun.sleep(20)
}
const joins = (run: WorkflowRun) => run.attempts.filter(attempt => attempt.nodeId === 'join')
const flowBranches = (repo: string) => git(join(parent, repo), 'branch', '--list', 'flow-*')
const pathJobCwds = () => manager.listJobs().filter(job => ['a', 'b'].includes(job.workflowNodeId ?? '')).map(job => job.cwd)

test('a fork over two repos gives each path its own workspace of both repos and joins each repo back', async () => {
  build()
  const started = await runner.start({ cwd: workspace, request: 'Write both', label: 'split', graph: forked({ a: { checks: writes('a/one.txt', 'one') }, b: { checks: writes('b/two.txt', 'two') } }) }, { startedByUser: true })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(await readFile(join(workspace, 'a', 'one.txt'), 'utf8')).toBe('one\n')
  expect(await readFile(join(workspace, 'b', 'two.txt'), 'utf8')).toBe('two\n')
  expect(existsSync(join(parent, 'a', 'one.txt'))).toBe(false)
  const cwds = pathJobCwds()
  expect(cwds).toHaveLength(2)
  for (const cwd of cwds) expect(cwd.startsWith(join(parent, '.worktree', `flow-${started.id.slice(0, 8)}-`))).toBe(true)
  const aPath = done.attempts.find(attempt => attempt.nodeId === 'a')!.pathId
  const bPath = done.attempts.find(attempt => attempt.nodeId === 'b')!.pathId
  expect(joins(done)[0]!.result).toEqual({ outcome: 'pass', summary: 'Joined 2 paths', evidence: [`${aPath}: 1 files`, `${bPath}: 1 files`] })
  for (const cwd of cwds) expect(existsSync(cwd)).toBe(false)
  for (const repo of ['a', 'b']) expect(flowBranches(repo)).toBe('')
  expect(git(join(workspace, 'a'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('queue-split-1-a8c0')
})

test('paths that both touch only one repo leave the other repo alone', async () => {
  build()
  const started = await runner.start({ cwd: workspace, request: 'Write in a', label: 'split', graph: forked({ a: { checks: writes('a/one.txt', 'one') }, b: { checks: writes('a/two.txt', 'two') } }) }, { startedByUser: true })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(await readFile(join(workspace, 'a', 'one.txt'), 'utf8')).toBe('one\n')
  expect(await readFile(join(workspace, 'a', 'two.txt'), 'utf8')).toBe('two\n')
  expect(git(join(workspace, 'b'), 'status', '--porcelain')).toBe('')
})

test('a join conflict in one repo blocks with the repo-prefixed file and keeps the paths', async () => {
  build()
  const started = await runner.start({ cwd: workspace, request: 'Clash', label: 'split', graph: forked({ a: { checks: writes('b/same.txt', 'a') }, b: { checks: writes('b/same.txt', 'b') } }) }, { startedByUser: true })
  const blocked = await finished(started.id)
  expect(blocked.status).toBe('blocked')
  expect(blocked.error).toBe('Paths could not be joined: b/same.txt')
  expect(blocked.sections).toHaveLength(1)
  for (const path of blocked.sections[0]!.paths) expect(existsSync(join(path.dir, 'b', 'same.txt'))).toBe(true)
  expect(await readFile(join(workspace, 'b', 'same.txt'), 'utf8')).toBe('a\n')
})

test('a path workspace deleted by hand while stopped is restored on retry and the paths still join', async () => {
  const slow: EngineResolver = ({ prompt }) => ({ cmd: '/bin/sh', args: ['-c', `${prompt.includes('SLOW') ? 'sleep 0.6; ' : ''}echo '${passing()}'`], env: {} })
  build(slow)
  const started = await runner.start({ cwd: workspace, request: 'Write both', label: 'split', graph: forked({ a: { instructions: 'Write A SLOW', checks: writes('a/one.txt', 'one') }, b: { instructions: 'Write B SLOW', checks: writes('b/two.txt', 'two') } }) }, { startedByUser: true })
  const working = await until(started.id, run => run.tokens.filter(token => token.state === 'working').length === 2)
  const doomed = working.sections[0]!.paths[0]!.dir
  await runner.stop(started.id)
  for (let i = 0; i < 200 && manager.listJobs().some(job => job.status === 'running'); i++) await Bun.sleep(20)
  await rm(doomed, { recursive: true, force: true })
  await runner.retry(started.id)
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(await readFile(join(workspace, 'a', 'one.txt'), 'utf8')).toBe('one\n')
  expect(await readFile(join(workspace, 'b', 'two.txt'), 'utf8')).toBe('two\n')
})

const shapeOf = (paths: Array<{ id: string; files: string[] }>) => ({ contract: 'Shared names are in the plan', paths: paths.map(path => ({ ...path, title: path.id.toUpperCase(), steps: [{ title: `Build ${path.id}`, instructions: `Build ${path.id}` }] })) })
const planner = (shape: unknown, seen: string[] = []): EngineResolver => ({ prompt }) => {
  seen.push(prompt)
  if (prompt.includes('flowShapeRules')) return { cmd: '/bin/echo', args: [passing(`SKD_SHAPE ${JSON.stringify(shape)}\n`)], env: {} }
  const owned = /Only change these files: ([^\n\\"]+)/.exec(prompt)?.[1]?.split(', ') ?? []
  const write = owned.map(file => `mkdir -p "$(dirname ${file})" && echo x > ${file}`).join(' && ')
  return { cmd: '/bin/sh', args: ['-c', `${write ? `${write}; ` : ''}echo '${passing()}'`], env: {} }
}
const straight = (): Workflow => { const graph = classicWorkflow(); graph.nodes[0]!.agent = { role: 'plan' }; return graph }
const nodeIds = (run: WorkflowRun) => run.attempts.map(attempt => attempt.nodeId)

test('the plan of a multi-repo run is told to prefix files with their repo, and a prefixed split joins per repo', async () => {
  const prompts: string[] = []
  build(planner(shapeOf([{ id: 'api', files: ['a/api.txt'] }, { id: 'web', files: ['b/web.txt'] }]), prompts))
  const started = await runner.start({ cwd: workspace, request: 'Split it', label: 'shape', graph: straight() })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(prompts[0]).toContain('This run spans several repos side by side (a, b)')
  expect(new Set(nodeIds(done))).toEqual(new Set(['plan', 'verify-plan', 'path-api-1', 'path-web-1', 'join-paths', 'review']))
  expect(await readFile(join(workspace, 'a', 'api.txt'), 'utf8')).toBe('x\n')
  expect(await readFile(join(workspace, 'b', 'web.txt'), 'utf8')).toBe('x\n')
})

test('a split whose prefixed files overlap, lack a repo or name an unknown repo stays straight and says why', async () => {
  const cases: Array<[Array<{ id: string; files: string[] }>, string]> = [
    [[{ id: 'api', files: ['a/app'] }, { id: 'web', files: ['a/app/x.rb'] }], 'Flow shape ignored: API and WEB both own a/app/x.rb'],
    [[{ id: 'api', files: ['app/x.rb'] }, { id: 'web', files: ['b/web.txt'] }], `Flow shape ignored: SKD_SHAPE file app/x.rb must start with one of the repos in ${parent}: a, b, c`],
    [[{ id: 'api', files: ['zzz/x.rb'] }, { id: 'web', files: ['b/web.txt'] }], `Flow shape ignored: SKD_SHAPE file zzz/x.rb must start with one of the repos in ${parent}: a, b, c`],
  ]
  for (const [paths, reason] of cases) {
    build(planner(shapeOf(paths)))
    const started = await runner.start({ cwd: workspace, request: 'Split it', label: 'shape', graph: straight() })
    const done = await finished(started.id)
    await jobsStopped()
    expect(done.status).toBe('done')
    expect(nodeIds(done)).toEqual(['plan', 'verify-plan', 'execute', 'review'])
    expect(done.attempts[0]!.result!.evidence).toContain(reason)
  }
})

test('a split path that needs a repo with no copy yet gets the copy before the fork', async () => {
  build(planner(shapeOf([{ id: 'api', files: ['a/api.txt'] }, { id: 'jobs', files: ['c/jobs.txt'] }])))
  const started = await runner.start({ cwd: workspace, request: 'Split it', label: 'shape', graph: straight() })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(git(join(workspace, 'c'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('queue-split-1-a8c0')
  expect(await readFile(join(workspace, 'c', 'jobs.txt'), 'utf8')).toBe('x\n')
  expect(JSON.parse(await readFile(join(workspace, '.shikidan', 'repos.json'), 'utf8'))).toEqual({ repos: ['a', 'b', 'c'] })
  expect(await readdir(join(parent, '.worktree'))).toEqual(['queue-split-1-a8c0'])
})

test('a path whose second repo conflicts joins none of its repos, and the evidence says so', async () => {
  build()
  const started = await runner.start({ cwd: workspace, request: 'Clash', label: 'split', graph: forked({ a: { checks: writes('b/same.txt', 'a') }, b: { checks: [{ command: '/bin/sh', args: ['-c', 'echo new > a/new.txt; echo b > b/same.txt'] }] } }) }, { startedByUser: true })
  const blocked = await finished(started.id)
  const aPath = blocked.attempts.find(attempt => attempt.nodeId === 'a')!.pathId
  const bPath = blocked.attempts.find(attempt => attempt.nodeId === 'b')!.pathId
  expect(blocked.status).toBe('blocked')
  expect(blocked.error).toBe('Paths could not be joined: b/same.txt')
  expect(existsSync(join(workspace, 'a', 'new.txt'))).toBe(false)
  expect(blocked.sections[0]!.joined).toEqual([aPath])
  expect(blocked.sections[0]!.joinedRepos?.[bPath] ?? []).toEqual([])
  expect(joins(blocked).at(-1)!.result!.evidence).toEqual([`Joined: ${aPath}`, `Conflicts in ${bPath}: b/same.txt`])
})

test('a path workspace deleted after one of its steps finished blocks the run instead of losing that work', async () => {
  const slow: EngineResolver = ({ prompt }) => ({ cmd: '/bin/sh', args: ['-c', `${prompt.includes('SLOW') ? 'sleep 0.8; ' : ''}echo '${passing()}'`], env: {} })
  build(slow)
  const pass = (source: string, target: string) => ({ source, target, outcome: 'pass' as const })
  const graph = {
    ...classicWorkflow(), id: 'forked2', name: 'Forked2', entry: 'plan',
    nodes: [
      { id: 'plan', title: 'Plan', kind: 'plan', agent: { role: 'plan' }, instructions: 'Plan the work' },
      { id: 'verify', title: 'Verify', kind: 'verify-plan', agent: { role: 'review' }, instructions: 'Verify the plan' },
      { id: 'split', title: 'Split', instructions: 'Split the work' },
      { id: 'a', title: 'Write A', instructions: 'Write A', checks: writes('a/one.txt', 'one') },
      { id: 'a2', title: 'Check A', instructions: 'Check A SLOW' },
      { id: 'b', title: 'B', instructions: 'Write B SLOW', checks: writes('b/two.txt', 'two') },
      { id: 'join', title: 'Join', kind: 'join', instructions: 'Join the paths' },
      { id: 'review', title: 'Review', instructions: 'Review the result' },
    ],
    edges: [pass('plan', 'verify'), pass('verify', 'split'), pass('split', 'a'), pass('split', 'b'), pass('a', 'a2'), pass('a2', 'join'), pass('b', 'join'), pass('join', 'review')],
  } as unknown as Workflow
  const started = await runner.start({ cwd: workspace, request: 'Write both', label: 'split', graph }, { startedByUser: true })
  const working = await until(started.id, run => run.tokens.some(token => token.nodeId === 'a2' && token.state === 'working'))
  const aPath = working.tokens.find(token => token.nodeId === 'a2')!.pathId
  const doomed = working.sections[0]!.paths.find(path => path.pathId === aPath)!.dir
  await runner.stop(started.id)
  await jobsStopped()
  await rm(doomed, { recursive: true, force: true })
  await runner.retry(started.id)
  const blocked = await finished(started.id)
  expect(blocked.status).toBe('blocked')
  expect(blocked.error).toBe(`The path workspace ${doomed} was deleted after Write A finished; its work is gone. Start the run again.`)
  expect(existsSync(doomed)).toBe(false)
})

test('a split inside a path forks from the path workspace and both levels join back per repo', async () => {
  build()
  const pass = (source: string, target: string) => ({ source, target, outcome: 'pass' as const })
  const graph = {
    ...classicWorkflow(), id: 'nested', name: 'Nested', entry: 'plan',
    nodes: [
      { id: 'plan', title: 'Plan', kind: 'plan', agent: { role: 'plan' }, instructions: 'Plan the work' },
      { id: 'verify', title: 'Verify', kind: 'verify-plan', agent: { role: 'review' }, instructions: 'Verify the plan' },
      { id: 'split', title: 'Split', instructions: 'Split the work' },
      { id: 'top', title: 'Top', instructions: 'Write top', checks: writes('a/top.txt', 'top') },
      { id: 'inner', title: 'Inner split', instructions: 'Split again' },
      { id: 'i1', title: 'I1', instructions: 'Write i1', checks: writes('a/i1.txt', 'i1') },
      { id: 'i2', title: 'I2', instructions: 'Write i2', checks: writes('b/i2.txt', 'i2') },
      { id: 'ijoin', title: 'Inner join', kind: 'join', instructions: 'Join inner' },
      { id: 'join', title: 'Join', kind: 'join', instructions: 'Join the paths' },
      { id: 'review', title: 'Review', instructions: 'Review the result' },
    ],
    edges: [pass('plan', 'verify'), pass('verify', 'split'), pass('split', 'top'), pass('split', 'inner'), pass('inner', 'i1'), pass('inner', 'i2'), pass('i1', 'ijoin'), pass('i2', 'ijoin'), pass('ijoin', 'join'), pass('top', 'join'), pass('join', 'review')],
  } as unknown as Workflow
  const started = await runner.start({ cwd: workspace, request: 'Nested', label: 'nested', graph }, { startedByUser: true })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  for (const [file, text] of [['a/top.txt', 'top'], ['a/i1.txt', 'i1'], ['b/i2.txt', 'i2']] as const) expect(await readFile(join(workspace, file), 'utf8')).toBe(`${text}\n`)
  const innerCwds = manager.listJobs().filter(job => ['i1', 'i2'].includes(job.workflowNodeId ?? '')).map(job => job.cwd)
  for (const cwd of innerCwds) expect(cwd).toMatch(new RegExp(`/\\.worktree/flow-${started.id.slice(0, 8)}-a\\d+-2\\.a\\d+-\\d$`))
  expect(await readdir(join(parent, '.worktree'))).toEqual(['queue-split-1-a8c0'])
  for (const repo of ['a', 'b']) expect(flowBranches(repo)).toBe('')
})

test('a split that would need more than 8 repos stays straight and says why', async () => {
  for (const name of ['d', 'e', 'f', 'g', 'h', 'i']) await repoAt(join(parent, name))
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map(name => `${name}/x.txt`)
  build(planner(shapeOf([{ id: 'one', files: files.slice(0, 5) }, { id: 'two', files: files.slice(5) }])))
  const started = await runner.start({ cwd: workspace, request: 'Split it', label: 'shape', graph: straight() })
  const done = await finished(started.id)
  expect(nodeIds(done)).toEqual(['plan', 'verify-plan', 'execute', 'review'])
  expect(done.attempts[0]!.result!.evidence).toContain('Flow shape ignored: SKD_SHAPE needs more than 8 repos')
})

test('a split path is told it holds a copy of each repo side by side', async () => {
  const prompts: string[] = []
  build(planner(shapeOf([{ id: 'api', files: ['a/api.txt'] }, { id: 'web', files: ['b/web.txt'] }]), prompts))
  const started = await runner.start({ cwd: workspace, request: 'Split it', label: 'shape', graph: straight() })
  expect((await finished(started.id)).status).toBe('done')
  const pathPrompt = prompts.find(prompt => prompt.includes('Only change these files: a/api.txt'))!
  expect(pathPrompt).toContain('This folder holds a fresh copy of each repo (a, b) side by side')
  expect(pathPrompt).not.toContain('fresh copy of the repository')
})
