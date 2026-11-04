import { lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

import { addPathWorktree, git, isWorktreeOf, prepareWorktree, removePathWorktree, worktreeBranch } from './job-worktrees'
import { LEGACY_SESSION_CONTEXT_DIR, SESSION_CONTEXT_DIR } from './plugins/context-files'
import { writePrivate } from './queue-files'
import { isPlainRepoName, isRepoList } from './repo-names'
import { probeRepo } from './repo-probe'

const REPOS_RECORD = 'repos.json'
const MAX_RECORD_BYTES = 8192
const BAR_WIDTH = 40

const recordPath = (workspace: string, folder = SESSION_CONTEXT_DIR): string => join(workspace, folder, REPOS_RECORD)

async function writeReposRecord(workspace: string, repos: readonly string[]): Promise<void> {
  const folder = join(workspace, SESSION_CONTEXT_DIR)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  if (!(await lstat(folder)).isDirectory()) throw new Error(`not a private folder: ${folder}`)
  await writePrivate(recordPath(workspace), Buffer.from(JSON.stringify({ repos })))
}

const lstatOrNull = (path: string) => lstat(path).catch(() => null)

async function isPlainDir(path: string): Promise<boolean> {
  const info = await lstatOrNull(path)
  return info !== null && info.isDirectory() && !info.isSymbolicLink()
}

async function sessionFolderName(workspace: string): Promise<string | null> {
  for (const name of [SESSION_CONTEXT_DIR, LEGACY_SESSION_CONTEXT_DIR]) if (await isPlainDir(join(workspace, name))) return name
  return null
}

async function isTrustedChild(folder: string, workspace: string, name: string): Promise<boolean> {
  const child = join(workspace, name)
  return await isPlainDir(child) && await isWorktreeOf(join(folder, name), child)
}

type WorkspaceOwner = (realPath: string) => boolean | Promise<boolean>
let ownsWorkspace: WorkspaceOwner = () => false

export function registerQueueWorkspaces(owner: WorkspaceOwner): void {
  ownsWorkspace = owner
}

export async function workspaceRepos(dir: string): Promise<string[] | null> {
  try {
    const real = await realpath(dir)
    if (basename(dirname(real)) !== '.worktree') return null
    const session = await sessionFolderName(real)
    if (session === null) return null
    const record = await lstat(recordPath(real, session))
    if (!record.isFile() || record.size > MAX_RECORD_BYTES) return null
    const { repos } = JSON.parse(await readFile(recordPath(real, session), 'utf8')) as { repos?: unknown }
    if (!isRepoList(repos)) return null
    if (repos.length === 0) return (await ownsWorkspace(real)) ? repos : null
    const folder = dirname(dirname(real))
    return (await Promise.all(repos.map(name => isTrustedChild(folder, real, name)))).every(Boolean) ? repos : null
  } catch {
    return null
  }
}


async function underHome(path: string): Promise<boolean> {
  const home = await realpath(homedir()).catch(() => homedir())
  return path === home || path.startsWith(home + sep)
}

async function checkTickedRepo(folder: string, name: string): Promise<void> {
  const child = join(folder, name)
  const stillRepo = await isPlainDir(child) && await realpath(child).catch(() => null) === child && await probeRepo(child) === 'repo'
  if (!stillRepo) throw new Error(`${name} is no longer a repo in this folder`)
}

async function checkOnBranch(folder: string, name: string): Promise<void> {
  const repo = join(folder, name)
  const onBranch = await git(repo, 'symbolic-ref', '-q', 'HEAD').then(() => true, () => false)
  const rebasing = await Promise.all(['rebase-merge', 'rebase-apply'].map(async state => lstatOrNull(await git(repo, 'rev-parse', '--path-format=absolute', '--git-path', state))))
  if (!onBranch || rebasing.some(found => found !== null)) throw new Error(`${name} is not on a branch (detached or mid-rebase); check out a branch in it first`)
}

async function plainFolderAt(path: string, expected: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  if (!(await isPlainDir(path)) || await realpath(path) !== expected) throw new Error(`The workspace folder is a link, not a plain folder: ${path}`)
}

async function missingWorktrees(folder: string, workspace: string, repos: readonly string[]): Promise<string[]> {
  const missing: string[] = []
  for (const name of repos) {
    const dir = join(workspace, name)
    const found = await lstatOrNull(dir)
    if (found !== null && (found.isSymbolicLink() || !found.isDirectory())) throw new Error(`The workspace folder is a link, not a plain folder: ${dir}`)
    if (found === null || !(await isWorktreeOf(join(folder, name), dir))) missing.push(name)
  }
  return missing
}

async function heldRepos(folder: string, workspace: string, given: readonly string[]): Promise<string[]> {
  const held: string[] = []
  for (const name of (await readdir(workspace)).sort()) {
    if (isPlainRepoName(name) && !given.includes(name) && await isTrustedChild(folder, workspace, name)) held.push(name)
  }
  const all = [...given, ...held]
  if (!isRepoList(all)) throw new Error(`${workspace} holds more repo copies than one item may use`)
  return all
}

export async function prepareRepoWorkspace(given: string, repos: readonly string[], label: string): Promise<{ worktree: string; repos: string[] }> {
  if (!isRepoList(repos)) throw new Error('Not a valid list of repos')
  const folder = await realpath(given)
  if (!(await underHome(folder))) throw new Error('The folder must be inside your home folder')
  for (const name of repos) await checkTickedRepo(folder, name)
  const parent = join(folder, '.worktree')
  const workspace = join(parent, worktreeBranch(label))
  await plainFolderAt(parent, parent)
  await plainFolderAt(workspace, workspace)
  const missing = await missingWorktrees(folder, workspace, repos)
  for (const name of missing) await checkOnBranch(folder, name)
  for (const name of missing) await prepareWorktree(join(folder, name), label, join(workspace, name))
  const all = await heldRepos(folder, workspace, repos)
  await writeReposRecord(workspace, all)
  return { worktree: workspace, repos: all }
}

async function checkedFolder(given: string, repos: readonly string[]): Promise<string> {
  if (!isRepoList(repos) || repos.length === 0) throw new Error('Not a valid list of repos')
  const folder = await realpath(given)
  if (!(await underHome(folder))) throw new Error('The folder must be inside your home folder')
  for (const name of repos) await checkTickedRepo(folder, name)
  return folder
}

async function plainPathWorkspace(folder: string, branch: string): Promise<string> {
  const parent = join(folder, '.worktree')
  const dir = join(parent, worktreeBranch(branch))
  await plainFolderAt(parent, parent)
  await plainFolderAt(dir, dir)
  return dir
}

type ChildState = 'missing' | 'plain' | 'unsafe'

async function childState(path: string): Promise<ChildState> {
  const found = await lstatOrNull(path)
  if (found === null) return 'missing'
  return found.isDirectory() && !found.isSymbolicLink() && await realpath(path) === path ? 'plain' : 'unsafe'
}

async function refuseUnsafeChildren(dir: string, repos: readonly string[]): Promise<void> {
  for (const name of repos) {
    if (await childState(join(dir, name)) === 'unsafe') throw new Error(`The workspace folder is a link, not a plain folder: ${join(dir, name)}`)
  }
}

export async function preparePathWorkspace(given: string, repos: readonly string[], branch: string, snapshots: Readonly<Record<string, string>>): Promise<string> {
  const folder = await checkedFolder(given, repos)
  const dir = await plainPathWorkspace(folder, branch)
  await refuseUnsafeChildren(dir, repos)
  for (const name of repos) await addPathWorktree(join(folder, name), join(dir, name), branch, snapshots[name]!)
  await writeReposRecord(dir, repos)
  return dir
}

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']

async function restoreChild(repo: string, child: string, branch: string, snapshot: string | undefined, name: string): Promise<void> {
  await git(repo, 'worktree', 'prune')
  if (await git(repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`) !== '') {
    await git(repo, ...NO_HOOKS, 'worktree', 'add', '-q', child, branch)
    return
  }
  const usable = snapshot !== undefined && await git(repo, 'cat-file', '-e', `${snapshot}^{commit}`).then(() => true, () => false)
  if (!usable) throw new Error(`${name} has neither the path branch ${branch} nor its fork snapshot; it cannot be restored`)
  await git(repo, ...NO_HOOKS, 'worktree', 'add', '-q', '-b', branch, child, snapshot!)
}

export async function pathWorkspaceIntact(dir: string, repos: readonly string[]): Promise<boolean> {
  if (!(await isPlainDir(dir))) return false
  for (const name of repos) if (!(await isPlainDir(join(dir, name))) || await lstatOrNull(join(dir, name, '.git')) === null) return false
  return true
}

export async function restorePathWorkspace(given: string, repos: readonly string[], branch: string, snapshots: Readonly<Record<string, string>>): Promise<string> {
  const folder = await checkedFolder(given, repos)
  const dir = await plainPathWorkspace(folder, branch)
  for (const name of await missingWorktrees(folder, dir, repos)) await restoreChild(join(folder, name), join(dir, name), branch, snapshots[name], name)
  await writeReposRecord(dir, repos)
  return dir
}

export async function removePathWorkspace(folder: string, repos: readonly string[], dir: string, branch: string, keepBranch: boolean): Promise<string[]> {
  const errors: string[] = []
  for (const name of repos) {
    const child = join(dir, name)
    if (await childState(child) === 'unsafe') { errors.push(`${name}: ${child} is not a plain folder; left it alone`); continue }
    await removePathWorktree(join(folder, name), child, branch, keepBranch).catch((error: unknown) => { errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`) })
  }
  await rm(dir, { recursive: true, force: true })
  return errors
}

type FileChange = { path: string; added: number; deleted: number; kind: 'text' | 'binary' | 'new' }

function parseNumstat(output: string): FileChange[] {
  return output.split('\0').filter(entry => entry !== '').map(entry => {
    const [added = '', deleted = '', ...rest] = entry.split('\t')
    const path = rest.join('\t')
    return added === '-' ? { path, added: 0, deleted: 0, kind: 'binary' as const } : { path, added: Number(added), deleted: Number(deleted), kind: 'text' as const }
  })
}

async function repoChanges(dir: string): Promise<FileChange[]> {
  const [numstat, untracked] = await Promise.all([
    git(dir, '-c', 'core.quotepath=false', 'diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', 'HEAD'),
    git(dir, 'ls-files', '--others', '--exclude-standard', '-z'),
  ])
  const added = untracked.split('\0').filter(path => path !== '').map(path => ({ path, added: 0, deleted: 0, kind: 'new' as const }))
  return [...parseNumstat(numstat), ...added]
}

function bar(added: number, deleted: number): string {
  const total = added + deleted
  const scale = total > BAR_WIDTH ? BAR_WIDTH / total : 1
  return '+'.repeat(Math.round(added * scale)) + '-'.repeat(Math.round(deleted * scale))
}

function statLine(change: FileChange): string {
  if (change.kind === 'new') return ` ${change.path} | new`
  if (change.kind === 'binary') return ` ${change.path} | Bin`
  return ` ${change.path} | ${change.added + change.deleted} ${bar(change.added, change.deleted)}`
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

function summaryLine(changes: readonly FileChange[]): string {
  const insertions = changes.reduce((sum, change) => sum + change.added, 0)
  const deletions = changes.reduce((sum, change) => sum + change.deleted, 0)
  return [` ${plural(changes.length, 'file')} changed`, ...(insertions > 0 ? [`${plural(insertions, 'insertion')}(+)`] : []), ...(deletions > 0 ? [`${plural(deletions, 'deletion')}(-)`] : [])].join(', ')
}

export async function workspaceChanges(workspace: string, repos: readonly string[]): Promise<FileChange[]> {
  const perRepo = await Promise.all(repos.map(async name => (await repoChanges(join(workspace, name))).map(change => ({ ...change, path: `${name}/${change.path}` }))))
  return perRepo.flat()
}

export async function workspaceDiffStat(workspace: string, repos: readonly string[]): Promise<string | null> {
  const changes = await workspaceChanges(workspace, repos)
  return changes.length === 0 ? null : [...changes.map(statLine), summaryLine(changes)].join('\n')
}
