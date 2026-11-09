import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PLACEHOLDER_SHOT, publish, publishDomain, removeLeftovers, unpublish, type PublishItem } from '../server/publish'

let dir: string
let worktree: string
let out: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skd-publish-'))
  worktree = join(dir, 'worktree')
  out = join(dir, 'published')
  await mkdir(join(worktree, 'visualizer', 'login', 'assets'), { recursive: true })
  await writeFile(join(worktree, 'visualizer', 'login', 'index.html'), '<h1>pick</h1>')
  await writeFile(join(worktree, 'visualizer', 'login', 'a.html'), '<h1>A</h1>')
  await writeFile(join(worktree, 'visualizer', 'login', 'assets', 'app.css'), 'body{}')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const item = (over: Partial<PublishItem> = {}): PublishItem => ({ externalId: '86D3J4F8Q', worktree, pick: { path: 'visualizer/login' }, ...over })
const options = { dir: '', domain: 'shikidan.com', cardImages: [] as string[], now: () => 1234 }
const run = (input: PublishItem = item(), cardImages: string[] = []) => publish(input, { ...options, dir: out, cardImages })

async function tree(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? tree(join(root, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))
  return nested.flat().sort()
}

test('the sub is the lowercased task id plus 8 random [a-z0-9], and the host adds the domain', async () => {
  const published = await run()
  expect(published.sub).toMatch(/^86d3j4f8q-[a-z0-9]{8}$/)
  expect(published).toEqual({ sub: published.sub, host: `${published.sub}.shikidan.com`, at: 1234 })
  expect((await run()).sub).not.toBe(published.sub)
})

test('a task id with characters a host cannot carry is cut down to a valid DNS label', async () => {
  const { sub } = await run(item({ externalId: `Weird_ID.${'x'.repeat(80)}` }))
  expect(sub).toMatch(/^weird-id-x+-[a-z0-9]{8}$/)
  expect(sub.length).toBeLessThanOrEqual(63)
})

test('the card folder is copied as is, with its subfolders', async () => {
  const { sub } = await run()
  expect(await tree(join(out, sub))).toEqual(['a.html', 'assets/app.css', 'index.html'])
  expect(await readFile(join(out, sub, 'a.html'), 'utf8')).toBe('<h1>A</h1>')
})

test('dotfiles and dot folders are left out', async () => {
  const folder = join(worktree, 'visualizer', 'login')
  await writeFile(join(folder, '.env'), 'SECRET=1')
  await mkdir(join(folder, '.shikidan'))
  await writeFile(join(folder, '.shikidan', 'context.md'), 'private')
  const { sub } = await run()
  expect(await tree(join(out, sub))).toEqual(['a.html', 'assets/app.css', 'index.html'])
})

test('symlinks to files and to folders are left out', async () => {
  const folder = join(worktree, 'visualizer', 'login')
  await writeFile(join(dir, 'secret.txt'), 'secret')
  await symlink(join(dir, 'secret.txt'), join(folder, 'leak.txt'))
  await symlink(dir, join(folder, 'up'))
  const { sub } = await run()
  expect(await tree(join(out, sub))).toEqual(['a.html', 'assets/app.css', 'index.html'])
})

test('a pick folder that resolves outside the worktree is refused and nothing is published', async () => {
  await mkdir(join(dir, 'outside'))
  await writeFile(join(dir, 'outside', 'index.html'), 'outside')
  await symlink(join(dir, 'outside'), join(worktree, 'visualizer', 'away'))
  await expect(run(item({ pick: { path: 'visualizer/away' } }))).rejects.toThrow('outside the worktree')
  await expect(run(item({ pick: { path: 'visualizer/../../outside' } }))).rejects.toThrow('outside the worktree')
  await expect(readdir(out)).rejects.toThrow('ENOENT')
})

test('a card with no worktree, no pick or a missing folder is refused', async () => {
  await expect(run(item({ worktree: null }))).rejects.toThrow('no workspace')
  await expect(run(item({ pick: undefined }))).rejects.toThrow('no design pick')
  await expect(run(item({ pick: { path: 'visualizer/missing' } }))).rejects.toThrow()
})

test('every file under a shots folder, at any depth, is replaced by the placeholder under its own name', async () => {
  const folder = join(worktree, 'visualizer', 'login')
  await mkdir(join(folder, 'shots'))
  await mkdir(join(folder, 'assets', 'shots', 'deep'), { recursive: true })
  await writeFile(join(folder, 'shots', 'portal.png'), 'REAL PORTAL SCREENSHOT')
  await writeFile(join(folder, 'assets', 'shots', 'deep', 'admin.jpg'), 'REAL ADMIN SCREENSHOT')
  const { sub } = await run()
  const placeholder = await readFile(PLACEHOLDER_SHOT)
  expect(await readFile(join(out, sub, 'shots', 'portal.png'))).toEqual(placeholder)
  expect(await readFile(join(out, sub, 'assets', 'shots', 'deep', 'admin.jpg'))).toEqual(placeholder)
  expect(placeholder.subarray(1, 4).toString()).toBe('PNG')
})

test('renders and verify folders, at any depth, are never published', async () => {
  const folder = join(worktree, 'visualizer', 'login')
  await mkdir(join(folder, 'renders'))
  await mkdir(join(folder, 'assets', 'verify'), { recursive: true })
  await writeFile(join(folder, 'renders', 'index.png'), 'OVERVIEW WITH REAL SCREENSHOT THUMBNAILS')
  await writeFile(join(folder, 'assets', 'verify', 'a.png'), 'VERIFY SHOT')
  const { sub } = await run()
  expect(await tree(join(out, sub))).toEqual(['a.html', 'assets/app.css', 'index.html'])
})

test('a copied image with the same bytes as a card image is replaced by the placeholder, other images are kept', async () => {
  const folder = join(worktree, 'visualizer', 'login')
  const cardImage = join(dir, 'card-images', '0-portal.png')
  await mkdir(join(dir, 'card-images'))
  await writeFile(cardImage, 'REAL PORTAL SCREENSHOT FROM CLICKUP')
  await writeFile(join(folder, 'assets', 'copy.png'), 'REAL PORTAL SCREENSHOT FROM CLICKUP')
  await writeFile(join(folder, 'assets', 'Copy.JPEG'), 'REAL PORTAL SCREENSHOT FROM CLICKUP')
  await writeFile(join(folder, 'assets', 'copy.txt'), 'REAL PORTAL SCREENSHOT FROM CLICKUP')
  await writeFile(join(folder, 'assets', 'mock.png'), 'A MOCKUP DRAWN BY THE AGENT')
  const { sub } = await run(item(), [cardImage])
  const placeholder = await readFile(PLACEHOLDER_SHOT)
  expect(await readFile(join(out, sub, 'assets', 'copy.png'))).toEqual(placeholder)
  expect(await readFile(join(out, sub, 'assets', 'Copy.JPEG'))).toEqual(placeholder)
  expect(await readFile(join(out, sub, 'assets', 'copy.txt'), 'utf8')).toBe('REAL PORTAL SCREENSHOT FROM CLICKUP')
  expect(await readFile(join(out, sub, 'assets', 'mock.png'), 'utf8')).toBe('A MOCKUP DRAWN BY THE AGENT')
})

test('a card image that cannot be read stops the publish instead of risking a leak', async () => {
  await expect(run(item(), [join(dir, 'gone.png')])).rejects.toThrow('ENOENT')
  expect(await readdir(out).catch(() => [])).toEqual([])
})

test('a new round reuses the sub and swaps the whole folder, leaving no temporary folders behind', async () => {
  const first = await run()
  await rm(join(worktree, 'visualizer', 'login', 'a.html'))
  await writeFile(join(worktree, 'visualizer', 'login', 'b.html'), '<h1>B</h1>')
  const second = await run(item({ published: first }))
  expect(second.sub).toBe(first.sub)
  expect(await tree(join(out, first.sub))).toEqual(['assets/app.css', 'b.html', 'index.html'])
  expect(await readdir(out)).toEqual([first.sub])
})

test('a copy that fails leaves the published folder as it was and removes its temporary folder', async () => {
  const first = await run()
  await mkdir(join(worktree, 'visualizer', 'login', 'locked'), { mode: 0o000 })
  await expect(run(item({ published: first }))).rejects.toThrow()
  await chmod(join(worktree, 'visualizer', 'login', 'locked'), 0o755)
  expect(await readdir(out)).toEqual([first.sub])
  expect(await tree(join(out, first.sub))).toEqual(['a.html', 'assets/app.css', 'index.html'])
})

test('unpublish removes the folder and is harmless when it is already gone', async () => {
  const published = await run()
  await unpublish(published.sub, out)
  expect(await readdir(out)).toEqual([])
  await unpublish(published.sub, out)
})

test('unpublish refuses a sub that is not a plain host label', async () => {
  await expect(unpublish('../worktree', out)).rejects.toThrow('Not a published folder')
  await expect(unpublish('', out)).rejects.toThrow('Not a published folder')
})

test('the publish domain is SKD_PUBLISH_DOMAIN, or shikidan.com when it is not set', () => {
  const saved = process.env.SKD_PUBLISH_DOMAIN
  try {
    delete process.env.SKD_PUBLISH_DOMAIN
    expect(publishDomain()).toBe('shikidan.com')
    process.env.SKD_PUBLISH_DOMAIN = 'mockups.example.com'
    expect(publishDomain()).toBe('mockups.example.com')
  } finally {
    if (saved === undefined) delete process.env.SKD_PUBLISH_DOMAIN
    else process.env.SKD_PUBLISH_DOMAIN = saved
  }
})

test('removeLeftovers deletes interrupted .tmp- and .gone- folders and keeps the published ones', async () => {
  const published = await run()
  await mkdir(join(out, `${published.sub}.tmp-ab12cd34`, 'assets'), { recursive: true })
  await mkdir(join(out, `${published.sub}.gone-zz99yy88`))
  await writeFile(join(out, `${published.sub}.tmp-ab12cd34`, 'assets', 'a.png'), 'half copied')
  await removeLeftovers(out)
  expect(await readdir(out)).toEqual([published.sub])
  await removeLeftovers(join(dir, 'never-made'))
})
