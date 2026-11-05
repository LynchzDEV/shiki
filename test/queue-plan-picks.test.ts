import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { techQuestionsOf, repoRequestsOf, runRequest, type RunView } from '../server/queue-prompts'
import { prepareRepoWorkspace, registerQueueWorkspaces } from '../server/repo-workspace'
import { createQueueStore } from '../server/queue-store'
import { validateWorkspaceCwd } from '../server/workspace'
import { git, repoAt } from './support/git-repos'
import { blockedWith, queueHarness } from './support/queue-harness'

let parent: string
let scratch: string

beforeEach(async () => {
  parent = await mkdtemp(join(homedir(), 'mc-plan-picks-'))
  scratch = await mkdtemp(join(tmpdir(), 'mc-plan-picks-scratch-'))
})
afterEach(async () => {
  registerQueueWorkspaces(() => false)
  await rm(parent, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const repos = async (...names: string[]) => { for (const name of names) await repoAt(join(parent, name)) }
const multi = { source: 'clickup-board', externalId: '7', repo: '' }
const workspace = () => join(parent, '.worktree', 'queue-task-7-7-a8c0')
const harness = () => queueHarness(scratch, { prepareWorkspace: (folder, names, label) => prepareRepoWorkspace(folder, names, label) })
const blocked = (evidence: string[]): Partial<RunView> => ({ status: 'blocked', attempts: [blockedWith(evidence)] })

test('a multi-repo item with no repos ticked builds in an empty workspace and tells the agent how to ask for repos', async () => {
  await repos('a', 'b')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  expect(h.store.get(item.id)).toMatchObject({ state: 'building', repos: [], worktree: workspace() })
  expect(JSON.parse(await readFile(join(workspace(), '.shikidan', 'repos.json'), 'utf8'))).toEqual({ repos: [] })
  expect(existsSync(join(workspace(), 'a'))).toBe(false)
  expect(h.started[0]!.cwd).toBe(workspace())
  const request = h.started[0]!.request
  for (const text of ['READ-ONLY', join(parent, 'a'), join(parent, 'b'), `${workspace()}/<name>`, 'none yet', '`repo: <name>`']) expect(request).toContain(text)
})

test('a run blocked only to ask for a repo gets that repo copy and reruns first, with nothing posted', async () => {
  await repos('a', 'b')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  const other = await h.engine.add({ ...multi, externalId: '8', repo: '/repo' })
  await h.engine.onRunSettled(h.settle('run-1', blocked(['repo: a'])))
  expect(git(join(workspace(), 'a'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('queue-task-7-7-a8c0')
  expect(existsSync(join(workspace(), 'b'))).toBe(false)
  expect(h.started.map(start => start.cwd)).toEqual([workspace(), workspace()])
  expect(h.store.get(item.id)).toMatchObject({ state: 'building', repos: ['a'], repoReruns: 1, questions: [] })
  expect(h.store.get(other.id)!.state).toBe('queued')
  expect(h.posted).toEqual([])
  expect(h.started[1]!.request).toContain(`Copies ready now: ${join(workspace(), 'a')}.`)
})

test('a run that asks for a repo and asks questions gets the repo and parks for the questions', async () => {
  await repos('a', 'b')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  await h.engine.onRunSettled(h.settle('run-1', blocked(['repo: b', 'biz: Which page?'])))
  expect(h.posted).toEqual([{ id: '7', kind: 'ask', lines: ['Which page?'] }])
  expect(h.store.get(item.id)).toMatchObject({ state: 'waiting-info', repos: ['b'], questions: ['Which page?'] })
  expect(existsSync(join(workspace(), 'b', 'README.md'))).toBe(true)
  expect(h.started).toHaveLength(1)
})

test('a run that asks for a name that is not a repo in the folder fails the item', async () => {
  await repos('a')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  for (const [run, name] of [['run-1', 'zzz'], ['run-2', '../a']] as const) {
    if (run === 'run-2') await h.engine.requeue(item.id)
    await h.engine.onRunSettled(h.settle(run, blocked([`repo: ${name}`])))
    expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: `The plan asked for ${name}, which is not a repo in ${parent}` })
  }
  expect(h.posted).toEqual([])
})

test('a run that asks again only for repos it already has fails instead of looping', async () => {
  await repos('a')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  await h.engine.onRunSettled(h.settle('run-1', blocked(['repo: a'])))
  await h.engine.onRunSettled(h.settle('run-2', blocked(['repo: a'])))
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: 'The plan asked again for a, which it already has; stopped so it does not loop' })
  expect(h.started).toHaveLength(2)
})

test('after 3 repo-only reruns the next repo request fails the item', async () => {
  await repos('a', 'b', 'c', 'd')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  for (const [index, name] of ['a', 'b', 'c'].entries()) await h.engine.onRunSettled(h.settle(`run-${index + 1}`, blocked([`repo: ${name}`])))
  expect(h.store.get(item.id)).toMatchObject({ state: 'building', repos: ['a', 'b', 'c'], repoReruns: 3 })
  await h.engine.onRunSettled(h.settle('run-4', blocked(['repo: d'])))
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: 'The plan asked for repos 3 times already; tick the repos yourself and requeue' })
  expect(h.started).toHaveLength(4)
})

test('a run that would take the item past 8 repos fails it', async () => {
  const names = Array.from({ length: 9 }, (_, index) => `r${index}`)
  await repos(...names)
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: ['r0'] })
  await h.engine.onRunSettled(h.settle('run-1', blocked(names.slice(1).map(name => `repo: ${name}`))))
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: 'The plan asked for more than 8 repos' })
})

test('a single-repo item whose run only asks for repos fails with a plain reason', async () => {
  const h = queueHarness(scratch)
  const item = await h.engine.add({ ...multi, repo: '/repo' })
  await h.engine.onRunSettled(h.settle('run-1', blocked(['`repo: a`'])))
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: 'This item builds in one repo; add it with the parent folder to let it use more' })
  expect(h.posted).toEqual([])
})

test('a single-repo item never asks the source about repo lines', async () => {
  const h = queueHarness(scratch)
  const item = await h.engine.add({ ...multi, repo: '/repo' })
  await h.engine.onRunSettled(h.settle('run-1', blocked(['repo: a', 'biz: Which page?'])))
  expect(h.posted).toEqual([{ id: '7', kind: 'ask', lines: ['Which page?'] }])
  expect(h.store.get(item.id)).toMatchObject({ state: 'waiting-info', questions: ['Which page?'] })
  expect('repos' in h.store.get(item.id)!).toBe(false)
})

test('techQuestionsOf leaves out repo requests in any of the forms an agent writes them', () => {
  const asks = ['repo: api', '  repo:web ', '`repo: api`', 'Repo: api', 'REPO: api', '- repo: api', '* `repo: web`', '1. repo: api', '"repo: api"', 'repo: `api`', 'repo: api, web']
  const run: RunView = { id: 'r', status: 'blocked', error: null, attempts: [blockedWith([...asks, 'Which page?', 'Is the repo: label right?'])] }
  expect(techQuestionsOf(run)).toEqual(['Which page?', 'Is the repo: label right?'])
  expect(repoRequestsOf(run)).toEqual(['api', 'web'])
})

test('a ticked multi-repo item builds its repos up front as before', async () => {
  await repos('a', 'b')
  const h = harness()
  await h.engine.add({ ...multi, repo: parent, repos: ['a'] })
  expect(existsSync(join(workspace(), 'a', 'README.md'))).toBe(true)
  expect(existsSync(join(workspace(), 'b'))).toBe(false)
  expect(h.started[0]!.request).toContain(`${workspace()}/a`)
})

test('the request for a single-repo item has no repo instructions', () => {
  const request = runRequest({ title: 'T', url: 'u', contextPath: '/c.md', answerPaths: [], repo: '/repo', worktree: '/repo/.worktree/q' })
  expect(request).not.toContain('repo: <name>')
  expect(request).not.toContain('READ-ONLY')
})

test('the request asks for every repo in one go and names the cap', async () => {
  await repos('a')
  const h = harness()
  await h.engine.add({ ...multi, repo: parent, repos: [] })
  expect(h.started[0]!.request).toContain('Ask for every repo you need in one go: Shikidan makes the copies and starts a new run, and stops after 3 such asks.')
})

test('an ask written with backticks, a bullet or a capital is granted, and posts nothing', async () => {
  await repos('a', 'b')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  await h.engine.onRunSettled(h.settle('run-1', blocked(['- `Repo: a`', 'repo: `b`'])))
  expect(h.store.get(item.id)).toMatchObject({ state: 'building', repos: ['a', 'b'] })
  expect(h.posted).toEqual([])
})

test('a folder whose repos are gone fails the item before a run starts', async () => {
  await repos('a')
  const h = harness()
  const blocker = await h.engine.add({ ...multi, externalId: '1', repo: '/repo' })
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  await rm(join(parent, 'a'), { recursive: true, force: true })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  expect(h.store.get(blocker.id)!.state).toBe('ready')
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: `${parent} has no repos inside it any more` })
  expect(h.started).toHaveLength(1)
})

test('a manual requeue resets the repo rerun count', async () => {
  await repos('a', 'b')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  await h.engine.onRunSettled(h.settle('run-1', blocked(['repo: a'])))
  await h.engine.onRunSettled(h.settle('run-2', { status: 'failed', error: 'boom' }))
  expect(h.store.get(item.id)!.repoReruns).toBe(1)
  await h.engine.requeue(item.id)
  expect(h.store.get(item.id)!.repoReruns).toBe(0)
})

test('an ask for a repo swapped for a symlink after add is refused and makes no copy', async () => {
  await repos('a', 'b')
  const evil = await repoAt(join(scratch, 'evil'))
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  await rm(join(parent, 'b'), { recursive: true, force: true })
  await symlink(evil, join(parent, 'b'))
  await h.engine.onRunSettled(h.settle('run-1', blocked(['repo: b'])))
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: `The plan asked for b, which is not a repo in ${parent}` })
  expect(git(evil, 'worktree', 'list').split('\n')).toHaveLength(1)
})

test('settling the same blocked run twice makes the copy once and counts the rerun once', async () => {
  await repos('a')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  const run = h.settle('run-1', blocked(['repo: a']))
  await h.engine.onRunSettled(run)
  await h.engine.onRunSettled(run)
  expect(h.store.get(item.id)).toMatchObject({ repos: ['a'], repoReruns: 1 })
  expect(h.started).toHaveLength(2)
})

test('an empty workspace record only counts for a workspace a queue item owns', async () => {
  const planted = join(parent, 'other', '.worktree', 'evil')
  await mkdir(join(planted, '.shikidan'), { recursive: true })
  await writeFile(join(planted, '.shikidan', 'repos.json'), JSON.stringify({ repos: [] }))
  expect(await validateWorkspaceCwd(planted)).toEqual({ ok: false, error: 'cwd is not a git repository' })
  const store = createQueueStore(join(scratch, 'owned.json'))
  registerQueueWorkspaces(path => store.list().some(item => item.repos !== undefined && item.worktree === path))
  expect(await validateWorkspaceCwd(planted)).toEqual({ ok: false, error: 'cwd is not a git repository' })
  const owned = await store.add({ source: 's', externalId: '1', title: 't', url: 'u', repo: join(parent, 'other'), flowId: null, repos: [] }, 'end')
  await store.update(owned.id, { worktree: planted })
  expect(await validateWorkspaceCwd(planted)).toEqual({ ok: true, path: planted })
})

test('the first run of a plan-picks item starts only after its workspace is stored on the item', async () => {
  await repos('a')
  let seen: string | null | undefined
  const h = queueHarness(scratch, {
    prepareWorkspace: (folder, names, label) => prepareRepoWorkspace(folder, names, label),
    runner: { start: async () => { seen = h.store.list()[0]?.worktree; return { id: 'run-x' } }, get: () => undefined },
  })
  await h.engine.add({ ...multi, repo: parent, repos: [] })
  expect(seen).toBe(workspace())
})

test('a real repo that changes while the item builds is recorded on the item and raised, without failing it', async () => {
  await repos('a', 'b')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  await writeFile(join(parent, 'b', 'stray.txt'), 'oops')
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  expect(h.store.get(item.id)).toMatchObject({ state: 'ready', realChanged: ['b'] })
  expect(h.alerts.at(-1)).toMatchObject({ reason: `b in ${parent} changed while Task 7 was building — check it wasn't the agent` })
})

test('an unchanged real repo raises nothing extra', async () => {
  await repos('a')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  expect(h.store.get(item.id)!.realChanged ?? []).toEqual([])
  expect(h.alerts.map(alert => alert.reason)).toEqual(['Built and ready for review'])
})

test('repos a run added to the workspace itself are picked up by the item when the run settles', async () => {
  await repos('a', 'b')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: ['a'] })
  await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-task-7-7-a8c0')
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  expect(h.store.get(item.id)).toMatchObject({ state: 'ready', repos: ['a', 'b'] })
})

test('a repo the run recorded that is not a real repo of the folder fails the item instead of being adopted', async () => {
  await repos('a', 'b')
  const evil = await repoAt(join(scratch, 'evil'))
  await symlink(evil, join(parent, 's'))
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: ['a'] })
  git(join(parent, 's'), 'worktree', 'add', '-q', join(workspace(), 's'), '-b', 'evil')
  await rm(join(workspace(), '.shikidan', 'repos.json'))
  await writeFile(join(workspace(), '.shikidan', 'repos.json'), JSON.stringify({ repos: ['a', 's'] }))
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', repos: ['a'], error: `The run recorded s, which is not a repo in ${parent}` })
})

test('repos recorded by the run that would take the item past 8 fail it', async () => {
  const names = Array.from({ length: 9 }, (_, index) => `r${index}`)
  await repos(...names)
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: ['r0'] })
  for (const name of names.slice(1)) git(join(parent, name), 'worktree', 'add', '-q', join(workspace(), name), '-b', 'queue-task-7-7-a8c0')
  await expect(prepareRepoWorkspace(parent, [], 'queue-task-7-7-a8c0')).rejects.toThrow('holds more repo copies than one item may use')
  await rm(join(workspace(), '.shikidan', 'repos.json'))
  await writeFile(join(workspace(), '.shikidan', 'repos.json'), JSON.stringify({ repos: names.slice(1) }))
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', repos: ['r0'], error: 'The run added repos past the limit of 8' })
})
