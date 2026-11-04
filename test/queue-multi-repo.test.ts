import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { prepareWorktree } from '../server/job-worktrees'
import { writeQueueContext } from '../server/queue-files'
import { listFolderRepos, MAX_QUEUE_REPOS, resolveQueueFolder } from '../server/queue-folder'
import { createQueueStore, type QueueItem } from '../server/queue-store'
import { gitTopLevelProbe, type RepoProbe } from '../server/repo-probe'
import { prepareRepoWorkspace } from '../server/repo-workspace'
import { git, repoAt } from './support/git-repos'
import { queueHarness } from './support/queue-harness'

let parent: string
let scratch: string

beforeEach(async () => {
  parent = await mkdtemp(join(homedir(), 'mc-multirepo-test-'))
  scratch = await mkdtemp(join(tmpdir(), 'mc-multirepo-scratch-'))
})
afterEach(async () => {
  await rm(parent, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const twoRepos = async () => { await repoAt(join(parent, 'b')); await repoAt(join(parent, 'a')) }
const multi = { source: 'clickup-board', externalId: '7', repo: '' }

test('a repo folder is a repo and lists no child repos', async () => {
  const repo = await repoAt(join(parent, 'solo'))
  expect(await listFolderRepos(repo)).toEqual({ ok: true, path: repo, isRepo: true, repos: [], skipped: 0 })
})

test('a parent folder lists its direct child repos by name, sorted, and nothing else', async () => {
  await twoRepos()
  await mkdir(join(parent, 'notes'))
  await repoAt(join(parent, 'group', 'inner'))
  await repoAt(join(parent, '.hidden'))
  const elsewhere = await repoAt(join(scratch, 'elsewhere'))
  await symlink(elsewhere, join(parent, 'linked-out'))
  await symlink(join(parent, 'a'), join(parent, 'linked-in'))
  expect(await listFolderRepos(parent)).toEqual({ ok: true, path: parent, isRepo: false, repos: ['a', 'b'], skipped: 0 })
})

test('an empty folder is not a repo and has no repos inside', async () => {
  expect(await listFolderRepos(parent)).toEqual({ ok: true, path: parent, isRepo: false, repos: [], skipped: 0 })
})

test('a folder outside home or missing is refused with the workspace errors', async () => {
  expect(await listFolderRepos(scratch)).toEqual({ ok: false, error: 'cwd must be under $HOME' })
  expect(await listFolderRepos(join(parent, 'missing'))).toEqual({ ok: false, error: 'cwd does not exist' })
})

test('a child that is a folder inside another repo does not count as a repo', async () => {
  const outer = await repoAt(join(parent, 'outer'))
  await mkdir(join(outer, 'sub'))
  expect(await listFolderRepos(outer)).toMatchObject({ isRepo: true, repos: [], skipped: 0 })
  const listed = await listFolderRepos(parent)
  expect(listed).toMatchObject({ isRepo: false, repos: ['outer'] })
})

test('a child whose git check takes too long is left out and counted as skipped', async () => {
  await twoRepos()
  await repoAt(join(parent, 'slow'))
  const probe: RepoProbe = (dir, signal) => (basename(dir) === 'slow' ? new Promise(resolve => { signal.addEventListener('abort', () => resolve(true)) }) : gitTopLevelProbe(dir, signal))
  expect(await listFolderRepos(parent, undefined, { timeoutMs: 100, probe })).toEqual({ ok: true, path: parent, isRepo: false, repos: ['a', 'b'], skipped: 1 })
})

test('children are probed a few at a time', async () => {
  for (let index = 0; index < 20; index++) await mkdir(join(parent, `d${index}`))
  let running = 0
  let most = 0
  const probe: RepoProbe = async () => { running += 1; most = Math.max(most, running); await Bun.sleep(5); running -= 1; return false }
  expect(await listFolderRepos(parent, undefined, { probe })).toMatchObject({ repos: [], skipped: 0 })
  expect(most).toBe(8)
})

test('without repos a repo resolves as before, a folder of repos becomes a plan-picks item, anything else keeps the old error', async () => {
  await twoRepos()
  await mkdir(join(parent, 'notes'))
  expect(await resolveQueueFolder(parent, undefined)).toEqual({ ok: true, path: parent, repos: [] })
  expect(await resolveQueueFolder(join(parent, 'notes'), undefined)).toEqual({ ok: false, error: 'cwd is not a git repository' })
  expect(await resolveQueueFolder(join(parent, 'notes'), [])).toEqual({ ok: false, error: 'cwd is not a git repository' })
  expect(await resolveQueueFolder(join(parent, 'a'), undefined)).toEqual({ ok: true, path: join(parent, 'a') })
})

test('ticked repos are checked before the item is added', async () => {
  await twoRepos()
  const nine = Array.from({ length: MAX_QUEUE_REPOS + 1 }, (_, index) => `r${index}`)
  const cases: Array<[string[], string]> = [
    [['zzz'], 'zzz is not a repo in this folder'],
    [['a', 'zzz', 'yyy'], 'zzz, yyy are not repos in this folder'],
    [['../x'], 'Not a repo name: ../x'],
    [['a/b'], 'Not a repo name: a/b'],
    [['.hidden'], 'Not a repo name: .hidden'],
    [['a', 'a'], 'a is ticked twice'],
    [nine, 'Pick at most 8 repos for one item'],
  ]
  for (const [repos, error] of cases) expect(await resolveQueueFolder(parent, repos)).toEqual({ ok: false, error })
  expect(await resolveQueueFolder(parent, ['b', 'a'])).toEqual({ ok: true, path: parent, repos: ['a', 'b'] })
  expect(await resolveQueueFolder(parent, [])).toEqual({ ok: true, path: parent, repos: [] })
})

test('a ticked repo deleted between listing and add is refused', async () => {
  await twoRepos()
  expect(await listFolderRepos(parent)).toMatchObject({ repos: ['a', 'b'] })
  await rm(join(parent, 'b'), { recursive: true, force: true })
  expect(await resolveQueueFolder(parent, ['a', 'b'])).toEqual({ ok: false, error: 'b is not a repo in this folder' })
})

test('repos are refused for a folder that is a repo itself', async () => {
  const repo = await repoAt(join(parent, 'solo'))
  expect(await resolveQueueFolder(repo, ['solo'])).toEqual({ ok: false, error: 'This folder is a git repo itself, so leave the repos out' })
})

test('an old queue.json without repos loads and its items stay single-repo', async () => {
  const file = join(scratch, 'queue.json')
  const old = { id: 'i1', source: 'clickup-board', externalId: '1', title: 'T', url: 'u', repo: '/repo', flowId: null, state: 'ready', worktree: '/repo/.worktree/q', contextPath: null, answerPaths: [], runIds: ['r1'], currentRunId: null, questions: [], lastSeenId: null, error: null, createdAt: 1, updatedAt: 2 }
  await writeFile(file, JSON.stringify({ items: [old, { ...old, id: 'i2', externalId: '2', repos: ['../x'] }, { ...old, id: 'i3', externalId: '3', repos: ['a', 'b'] }] }))
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  const store = createQueueStore(file)
  expect(logged.mock.calls.map(call => String(call[0]))).toEqual([`queue item i2 in ${file} is not valid and was left out`])
  logged.mockRestore()
  expect(store.list().map(item => item.id)).toEqual(['i1', 'i3'])
  expect(store.get('i1')).toEqual(old as unknown as QueueItem)
  expect('repos' in store.get('i1')!).toBe(false)
  expect(store.get('i3')!.repos).toEqual(['a', 'b'])
})

test('a multi-repo item builds in one workspace with its context at the root, outside every child repo', async () => {
  await twoRepos()
  const h = queueHarness(scratch, { prepareWorkspace: (folder, repos, label) => prepareRepoWorkspace(folder, repos, label), writeContext: (pluginId, context, cwd) => writeQueueContext(pluginId, context, cwd) })
  const item = await h.engine.add({ ...multi, repo: parent, repos: ['a', 'b'] })
  const built = h.store.get(item.id)!
  const workspace = join(parent, '.worktree', 'queue-task-7-7-a8c0')
  expect(built).toMatchObject({ state: 'building', repo: parent, repos: ['a', 'b'], worktree: workspace })
  expect(h.started[0]!.cwd).toBe(workspace)
  expect(built.contextPath!.startsWith(join(workspace, '.shikidan', 'queue', 'clickup-board') + '/')).toBe(true)
  expect(h.started[0]!.request).toContain(`Copies ready now: ${join(workspace, 'a')}, ${join(workspace, 'b')}.`)
  for (const name of ['a', 'b']) expect(git(join(workspace, name), 'status', '--porcelain')).toBe('')
})

test('a single-repo item gets no repos line in its request', async () => {
  const h = queueHarness(scratch)
  await h.engine.add({ ...multi, repo: '/repo' })
  expect(h.started[0]!.request).not.toContain('side by side')
  expect('repos' in h.store.list()[0]!).toBe(false)
})

test('requeue of a multi-repo item with one child worktree deleted recreates only that one', async () => {
  await twoRepos()
  const h = queueHarness(scratch, { prepareWorkspace: (folder, repos, label) => prepareRepoWorkspace(folder, repos, label) })
  const item = await h.engine.add({ ...multi, repo: parent, repos: ['a', 'b'] })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  const workspace = h.store.get(item.id)!.worktree!
  await writeFile(join(workspace, 'a', 'work.txt'), 'kept')
  await rm(join(workspace, 'b'), { recursive: true, force: true })
  await h.engine.requeue(item.id)
  expect(h.store.get(item.id)).toMatchObject({ state: 'building', worktree: workspace })
  expect(await readFile(join(workspace, 'a', 'work.txt'), 'utf8')).toBe('kept')
  expect(existsSync(join(workspace, 'b', 'README.md'))).toBe(true)
})

test('a card re-added with no repos ticked adopts the repo copies its reused workspace already holds', async () => {
  await twoRepos()
  const h = queueHarness(scratch, { prepareWorkspace: (folder, repos, label) => prepareRepoWorkspace(folder, repos, label) })
  const first = await h.engine.add({ ...multi, repo: parent, repos: ['a', 'b'] })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  const workspace = h.store.get(first.id)!.worktree!
  await h.engine.remove(first.id)
  const again = await h.engine.add({ ...multi, repo: parent, repos: [] })
  expect(h.store.get(again.id)).toMatchObject({ state: 'building', worktree: workspace, repos: ['a', 'b'] })
  expect(h.started[1]!.request).toContain(`Copies ready now: ${join(workspace, 'a')}, ${join(workspace, 'b')}.`)
})

test('a multi-repo item without a workspace preparer fails with a clear reason', async () => {
  await twoRepos()
  const h = queueHarness(scratch)
  const item = await h.engine.add({ ...multi, repo: parent, repos: ['a', 'b'] })
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: 'This Shikidan cannot build multi-repo items' })
})

test('remove leaves worktrees and branches in place for multi-repo items, as it does for single-repo items', async () => {
  await twoRepos()
  const single = await repoAt(join(parent, 'solo'))
  const h = queueHarness(scratch, { prepareWorktree: (repo, label) => prepareWorktree(repo, label), prepareWorkspace: (folder, repos, label) => prepareRepoWorkspace(folder, repos, label) })
  const one = await h.engine.add({ ...multi, externalId: '1', repo: single })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  const many = await h.engine.add({ ...multi, externalId: '2', repo: parent, repos: ['a', 'b'] })
  await h.engine.onRunSettled(h.settle('run-2', { status: 'done' }))
  const worktrees = [h.store.get(one.id)!.worktree!, h.store.get(many.id)!.worktree!]
  for (const id of [one.id, many.id]) await h.engine.remove(id)
  expect(h.store.list()).toEqual([])
  expect(existsSync(join(worktrees[0]!, 'README.md'))).toBe(true)
  for (const name of ['a', 'b']) {
    expect(existsSync(join(worktrees[1]!, name, 'README.md'))).toBe(true)
    expect(git(join(parent, name), 'branch', '--list', 'queue-task-2-2-a8c0')).toContain('queue-task-2-2-a8c0')
  }
})

test('a multi-repo item whose ticked repo was deleted after add fails at build with the repo named', async () => {
  await twoRepos()
  const h = queueHarness(scratch, { prepareWorkspace: (folder, repos, label) => prepareRepoWorkspace(folder, repos, label) })
  const blocker = await h.engine.add({ ...multi, externalId: '1', repo: '/repo' })
  await rm(join(parent, 'b'), { recursive: true, force: true })
  const item = await h.engine.add({ ...multi, repo: parent, repos: ['a', 'b'] })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  expect(h.store.get(blocker.id)!.state).toBe('ready')
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: 'b is no longer a repo in this folder', worktree: null })
  expect(existsSync(join(parent, '.worktree', 'queue-task-7-7-a8c0', 'a'))).toBe(false)
})

test('restoring a multi-repo item whose ticked repo became a symlink fails with a plain reason', async () => {
  await twoRepos()
  const h = queueHarness(scratch, { prepareWorkspace: (folder, repos, label) => prepareRepoWorkspace(folder, repos, label) })
  const item = await h.engine.add({ ...multi, repo: parent, repos: ['a', 'b'] })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  const evil = await repoAt(join(scratch, 'evil'))
  await rm(join(parent, 'b'), { recursive: true, force: true })
  await symlink(evil, join(parent, 'b'))
  await h.engine.requeue(item.id)
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: 'Its worktree is gone and could not be restored: b is no longer a repo in this folder' })
  expect(h.started).toHaveLength(1)
})
