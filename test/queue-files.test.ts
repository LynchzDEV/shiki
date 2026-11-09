import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ContextTooLarge, MAX_CONTEXT_BYTES, writeContextFile } from '../server/plugins/context-files'
import { cardImageFiles, cardImagesFolder, queueFolder, writeQueueContext } from '../server/queue-files'
import { initScratchGitRepo } from './support/scratch-git-repo'

let repo: string
beforeEach(async () => {
  repo = await mkdtemp(join(homedir(), 'mc-queue-files-'))
  await initScratchGitRepo(repo)
})
afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

test('writeQueueContext writes a private file under the queue folder of its source', async () => {
  const path = await writeQueueContext('clickup-board', { name: 'item-1', markdown: '# Task 1' }, repo, new Date(Date.UTC(2026, 9, 5, 1, 2, 3)))
  expect(path).toBe(join(repo, '.shikidan', 'queue', 'clickup-board', '20261005-010203-item-1.md'))
  expect(path.startsWith(queueFolder(repo, 'clickup-board'))).toBe(true)
  expect(await readFile(path, 'utf8')).toBe('# Task 1')
  expect(await mode(path)).toBe(0o600)
  expect(await mode(join(repo, '.shikidan', 'queue'))).toBe(0o700)
  expect(await mode(queueFolder(repo, 'clickup-board'))).toBe(0o700)
})

test('writeQueueContext keeps the queue folder out of git', async () => {
  await writeQueueContext('clickup-board', { name: 'item-1', markdown: '# Task 1' }, repo)
  expect(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.shikidan/\n')
})

test('writeQueueContext never sweeps old queue files', async () => {
  const old = await writeQueueContext('clickup-board', { name: 'item-1', markdown: '# Task 1' }, repo)
  const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
  await utimes(old, longAgo, longAgo)
  await writeQueueContext('clickup-board', { name: 'answers-1', markdown: '# Answers' }, repo)
  expect(await readFile(old, 'utf8')).toBe('# Task 1')
})

test('a session context sweep leaves queue files alone', async () => {
  const kept = await writeQueueContext('clickup-board', { name: 'item-1', markdown: '# Task 1' }, repo)
  await writeContextFile('clickup-board', { name: 'session', markdown: '# s' }, new Date(Date.now() + 31 * 24 * 60 * 60 * 1000), repo)
  expect(await readFile(kept, 'utf8')).toBe('# Task 1')
})

test('writeQueueContext refuses context over the size limit', async () => {
  await expect(writeQueueContext('clickup-board', { name: 'big', markdown: 'x'.repeat(MAX_CONTEXT_BYTES + 1) }, repo)).rejects.toBeInstanceOf(ContextTooLarge)
})

test('writeQueueContext refuses a queue folder that is a symlink', async () => {
  const elsewhere = join(repo, 'elsewhere')
  await mkdir(elsewhere)
  await mkdir(join(repo, '.shikidan'), { recursive: true })
  await symlink(elsewhere, join(repo, '.shikidan', 'queue'))
  await expect(writeQueueContext('clickup-board', { name: 'item-1', markdown: '# Task 1' }, repo)).rejects.toThrow('not a private folder')
})

test('cardImageFiles lists the card images and reply images of a source, not its context files or other sources', async () => {
  const folder = queueFolder(repo, 'clickup-board')
  await mkdir(cardImagesFolder(repo, 'clickup-board'), { recursive: true })
  await mkdir(queueFolder(repo, 'other'), { recursive: true })
  await writeFile(join(cardImagesFolder(repo, 'clickup-board'), '0-portal.png'), 'card')
  await writeFile(join(folder, 'c9-0-reply.jpg'), 'reply')
  await writeFile(join(folder, '20261005-010203-item-1.md'), '# Task 1')
  await writeFile(join(queueFolder(repo, 'other'), 'x.png'), 'other')
  await symlink(join(repo, 'outside.png'), join(folder, 'link.png'))
  expect((await cardImageFiles(repo, 'clickup-board')).sort()).toEqual([join(folder, 'c9-0-reply.jpg'), join(cardImagesFolder(repo, 'clickup-board'), '0-portal.png')].sort())
  expect(await cardImageFiles(repo, 'missing')).toEqual([])
})
