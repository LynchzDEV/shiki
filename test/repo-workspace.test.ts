import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { captureDiffStat } from '../server/jobs'
import { joinRepoPath, snapshotRepos, commitRepoPath } from '../server/repo-paths'
import { preparePathWorkspace, prepareRepoWorkspace, removePathWorkspace, restorePathWorkspace, workspaceDiffStat, workspaceRepos } from '../server/repo-workspace'
import { workspaceSnapshot } from '../server/workflow-runner'
import { validateWorkspaceCwd } from '../server/workspace'
import { git, repoAt } from './support/git-repos'

let parent: string
let scratch: string

beforeEach(async () => {
  parent = await mkdtemp(join(homedir(), 'mc-repo-workspace-test-'))
  scratch = await mkdtemp(join(tmpdir(), 'mc-repo-workspace-scratch-'))
})
afterEach(async () => {
  await rm(parent, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const twoRepos = async () => { await repoAt(join(parent, 'b')); await repoAt(join(parent, 'a')) }

test('a workspace holds one worktree per ticked repo, all on the same branch', async () => {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-fix-login-7-a8c0')
  expect(worktree).toBe(join(parent, '.worktree', 'queue-fix-login-7-a8c0'))
  for (const name of ['a', 'b']) {
    expect(git(join(worktree, name), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('queue-fix-login-7-a8c0')
    expect(await readFile(join(worktree, name, 'README.md'), 'utf8')).toBe('hello\n')
  }
  expect(await workspaceRepos(worktree)).toEqual(['a', 'b'])
  expect(await validateWorkspaceCwd(worktree)).toEqual({ ok: true, path: worktree })
  expect(git(join(parent, 'a'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
})

test('a plain folder without the workspace record still fails the git check', async () => {
  await mkdir(join(parent, 'loose'))
  expect(await workspaceRepos(join(parent, 'loose'))).toBeNull()
  expect(await validateWorkspaceCwd(join(parent, 'loose'))).toEqual({ ok: false, error: 'cwd is not a git repository' })
})

test('preparing again recreates only the child worktree deleted by hand', async () => {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')
  await writeFile(join(worktree, 'a', 'work.txt'), 'kept')
  await rm(join(worktree, 'b'), { recursive: true, force: true })
  expect((await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')).worktree).toBe(worktree)
  expect(await readFile(join(worktree, 'a', 'work.txt'), 'utf8')).toBe('kept')
  expect(git(join(worktree, 'b'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('queue-x-7-a8c0')
})

test('preparing a workspace again with no repos keeps the repo copies already in it', async () => {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')
  expect(await prepareRepoWorkspace(parent, [], 'queue-x-7-a8c0')).toEqual({ worktree, repos: ['a', 'b'] })
  expect(await workspaceRepos(worktree)).toEqual(['a', 'b'])
})

test('preparing a workspace with fewer repos than it holds records all of them, given ones first', async () => {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')
  expect((await prepareRepoWorkspace(parent, ['b'], 'queue-x-7-a8c0')).repos).toEqual(['b', 'a'])
  expect(await workspaceRepos(worktree)).toEqual(['b', 'a'])
})

test('a plain folder named like a repo in the workspace is not adopted as a repo copy', async () => {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a'], 'queue-x-7-a8c0')
  await mkdir(join(worktree, 'b'))
  await mkdir(join(worktree, 'visualizer'))
  expect((await prepareRepoWorkspace(parent, [], 'queue-x-7-a8c0')).repos).toEqual(['a'])
  expect(await workspaceRepos(worktree)).toEqual(['a'])
})

test('the changes are the union across child repos, prefixed by repo name, unchanged repos left out', async () => {
  await twoRepos()
  await repoAt(join(parent, 'c'))
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b', 'c'], 'queue-x-7-a8c0')
  expect(await workspaceDiffStat(worktree, ['a', 'b', 'c'])).toBeNull()
  await writeFile(join(worktree, 'a', 'README.md'), 'hello\nworld\n')
  await mkdir(join(worktree, 'c', 'app'))
  await writeFile(join(worktree, 'c', 'app', 'new.rb'), 'x = 1\n')
  const stat = await workspaceDiffStat(worktree, ['a', 'b', 'c'])
  expect(stat).toBe([' a/README.md | 1 +', ' c/app/new.rb | new', ' 2 files changed, 1 insertion(+)'].join('\n'))
  expect(stat).not.toContain('b/')
})

test('a job settled in a workspace reports the union of its repos as its diff stat; a single repo keeps git\'s own stat', async () => {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')
  await writeFile(join(worktree, 'b', 'README.md'), 'changed\n')
  expect(await captureDiffStat(worktree)).toBe([' b/README.md | 2 +-', ' 1 file changed, 1 insertion(+), 1 deletion(-)'].join('\n'))
  await writeFile(join(parent, 'a', 'README.md'), 'changed\n')
  expect(await captureDiffStat(join(parent, 'a'))).toBe(git(join(parent, 'a'), 'diff', '--stat', 'HEAD'))
  expect(await captureDiffStat(scratch)).toBeNull()
})

test('the run fingerprint of a workspace changes when any child repo changes', async () => {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')
  const before = await workspaceSnapshot(worktree)
  expect(await workspaceSnapshot(worktree)).toEqual(before)
  await writeFile(join(worktree, 'b', 'extra.txt'), 'new')
  const after = await workspaceSnapshot(worktree)
  expect(after.diffHash).not.toBe(before.diffHash)
  expect(after.head).toMatch(/^a:[0-9a-f]{40} b:[0-9a-f]{40}$/)
  await expect(workspaceSnapshot(scratch)).rejects.toThrow()
})

const worktreesOf = (repo: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length

test('a ticked repo swapped for a symlink after add is refused at build and no worktree is made for any repo', async () => {
  await twoRepos()
  const elsewhere = await repoAt(join(scratch, 'evil'))
  await rm(join(parent, 'b'), { recursive: true, force: true })
  await symlink(elsewhere, join(parent, 'b'))
  await expect(prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')).rejects.toThrow('b is no longer a repo in this folder')
  expect(worktreesOf(join(parent, 'a'))).toBe(1)
  expect(worktreesOf(elsewhere)).toBe(1)
})

test('a ticked repo deleted after add is refused at build with its name', async () => {
  await twoRepos()
  await rm(join(parent, 'b'), { recursive: true, force: true })
  await expect(prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')).rejects.toThrow('b is no longer a repo in this folder')
  expect(worktreesOf(join(parent, 'a'))).toBe(1)
})

test('a folder that only contains a repo is not one: a child must be its own git top level', async () => {
  await repoAt(join(parent, 'a'))
  await mkdir(join(parent, 'a', 'sub'))
  await expect(prepareRepoWorkspace(join(parent, 'a'), ['sub'], 'queue-x-7-a8c0')).rejects.toThrow('sub is no longer a repo in this folder')
})

test('a ticked repo that is detached or mid-rebase is refused before any worktree is made', async () => {
  await twoRepos()
  git(join(parent, 'b'), 'checkout', '-q', '--detach')
  await expect(prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')).rejects.toThrow('b is not on a branch (detached or mid-rebase); check out a branch in it first')
  expect(worktreesOf(join(parent, 'a'))).toBe(1)
})

test('a workspace folder planted as a symlink is refused and nothing is written where it points', async () => {
  await twoRepos()
  const target = await mkdtemp(join(homedir(), 'mc-repo-workspace-target-'))
  try {
    await mkdir(join(parent, '.worktree'))
    await symlink(target, join(parent, '.worktree', 'queue-x-7-a8c0'))
    await expect(prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')).rejects.toThrow('The workspace folder is a link, not a plain folder')
    expect(existsSync(join(target, '.shikidan'))).toBe(false)
    expect(existsSync(join(target, 'a'))).toBe(false)
  } finally { await rm(target, { recursive: true, force: true }) }
})

test('a .worktree folder that is a symlink is refused', async () => {
  await twoRepos()
  await symlink(scratch, join(parent, '.worktree'))
  await expect(prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')).rejects.toThrow('The workspace folder is a link, not a plain folder')
  expect(existsSync(join(scratch, 'queue-x-7-a8c0'))).toBe(false)
})

test('a child folder in the workspace planted as a symlink is refused', async () => {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')
  await rm(join(worktree, 'b'), { recursive: true, force: true })
  git(join(parent, 'b'), 'worktree', 'prune')
  await symlink(join(parent, 'b'), join(worktree, 'b'))
  await expect(prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')).rejects.toThrow('The workspace folder is a link, not a plain folder')
})

test('a workspace recorded under the old .mission-control folder still reads', async () => {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')
  await rename(join(worktree, '.shikidan'), join(worktree, '.mission-control'))
  expect(await workspaceRepos(worktree)).toEqual(['a', 'b'])
})

test('the .shikidan record wins over an old .mission-control record', async () => {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')
  await mkdir(join(worktree, '.mission-control'))
  await writeFile(join(worktree, '.mission-control', 'repos.json'), JSON.stringify({ repos: ['a'] }))
  expect(await workspaceRepos(worktree)).toEqual(['a', 'b'])
})

test('a hand-made repos record does not make a plain folder pass as a workspace', async () => {
  await twoRepos()
  await mkdir(join(parent, '.shikidan'))
  await writeFile(join(parent, '.shikidan', 'repos.json'), JSON.stringify({ repos: ['a', 'b'] }))
  expect(await workspaceRepos(parent)).toBeNull()
  expect(await validateWorkspaceCwd(parent)).toEqual({ ok: false, error: 'cwd is not a git repository' })
})

test('a hand-made record under .worktree with plain repo copies instead of worktrees is not a workspace', async () => {
  await twoRepos()
  const fake = join(parent, '.worktree', 'queue-fake-1-a8c0')
  await mkdir(join(fake, '.shikidan'), { recursive: true })
  await writeFile(join(fake, '.shikidan', 'repos.json'), JSON.stringify({ repos: ['a', 'b'] }))
  for (const name of ['a', 'b']) await cp(join(parent, name), join(fake, name), { recursive: true })
  expect(await workspaceRepos(fake)).toBeNull()
  expect(await validateWorkspaceCwd(fake)).toEqual({ ok: false, error: 'cwd is not a git repository' })
})

const pathBranch = 'flow-deadbeef-a2-1'

async function splitReady() {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')
  await writeFile(join(worktree, 'a', 'queue.txt'), 'earlier work\n')
  git(join(worktree, 'a'), 'add', '.')
  git(join(worktree, 'a'), 'commit', '-qm', 'queue work')
  return { worktree, snapshots: await snapshotRepos(worktree, ['a', 'b'], 'snap') }
}

test('a path workspace whose branch was deleted is restored from the fork snapshot, never from the base HEAD', async () => {
  const { worktree, snapshots } = await splitReady()
  const dir = await preparePathWorkspace(parent, ['a', 'b'], pathBranch, snapshots)
  await removePathWorkspace(parent, ['a', 'b'], dir, pathBranch, false)
  expect(git(join(parent, 'a'), 'branch', '--list', pathBranch)).toBe('')
  await restorePathWorkspace(parent, ['a', 'b'], pathBranch, snapshots)
  expect(git(join(dir, 'a'), 'rev-parse', 'HEAD')).toBe(snapshots.a!)
  await writeFile(join(dir, 'a', 'path.txt'), 'path work\n')
  await commitRepoPath(dir, ['a', 'b'], 'path')
  expect(await joinRepoPath(worktree, dir, 'a', snapshots.a!)).toEqual({ applied: true, files: 1 })
  expect(await readFile(join(worktree, 'a', 'queue.txt'), 'utf8')).toBe('earlier work\n')
})

test('restoring a path workspace works while the base repo is detached', async () => {
  const { snapshots } = await splitReady()
  const dir = await preparePathWorkspace(parent, ['a', 'b'], pathBranch, snapshots)
  await rm(join(dir, 'a'), { recursive: true, force: true })
  git(join(parent, 'a'), 'checkout', '-q', '--detach')
  await restorePathWorkspace(parent, ['a', 'b'], pathBranch, snapshots)
  expect(git(join(dir, 'a'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(pathBranch)
})

test('a path workspace whose branch and snapshot are both gone is not restored', async () => {
  const { snapshots } = await splitReady()
  const dir = await preparePathWorkspace(parent, ['a', 'b'], pathBranch, snapshots)
  await removePathWorkspace(parent, ['a', 'b'], dir, pathBranch, false)
  await expect(restorePathWorkspace(parent, ['a', 'b'], pathBranch, { ...snapshots, a: 'f'.repeat(40) })).rejects.toThrow(`a has neither the path branch ${pathBranch} nor its fork snapshot; it cannot be restored`)
})

test('a symlink planted as a repo folder in a path workspace is refused and the linked worktree is left alone', async () => {
  const { snapshots } = await splitReady()
  const { worktree: other } = await prepareRepoWorkspace(parent, ['a'], 'queue-other-2-bbbb')
  await writeFile(join(other, 'a', 'precious.txt'), 'uncommitted\n')
  const dir = join(parent, '.worktree', pathBranch)
  await mkdir(dir, { recursive: true })
  await symlink(join(other, 'a'), join(dir, 'a'))
  await expect(preparePathWorkspace(parent, ['a', 'b'], pathBranch, snapshots)).rejects.toThrow(`The workspace folder is a link, not a plain folder: ${join(dir, 'a')}`)
  expect(await readFile(join(other, 'a', 'precious.txt'), 'utf8')).toBe('uncommitted\n')
})

test('removing a path workspace leaves a linked repo folder\'s target alone and says so', async () => {
  const { snapshots } = await splitReady()
  const { worktree: other } = await prepareRepoWorkspace(parent, ['a'], 'queue-other-2-bbbb')
  await writeFile(join(other, 'a', 'precious.txt'), 'uncommitted\n')
  const dir = await preparePathWorkspace(parent, ['a', 'b'], pathBranch, snapshots)
  await rm(join(dir, 'a'), { recursive: true, force: true })
  await symlink(join(other, 'a'), join(dir, 'a'))
  const errors = await removePathWorkspace(parent, ['a', 'b'], dir, pathBranch, false)
  expect(errors).toEqual([`a: ${join(dir, 'a')} is not a plain folder; left it alone`])
  expect(await readFile(join(other, 'a', 'precious.txt'), 'utf8')).toBe('uncommitted\n')
  expect(existsSync(dir)).toBe(false)
})
