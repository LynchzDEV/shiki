import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'

import { configDir } from './secrets'

export type Published = { sub: string; host: string; at: number }
export type PublishItem = { externalId: string; worktree: string | null; pick?: { path: string }; published?: Published }
export type PublishOptions = { dir: string; domain: string; cardImages: readonly string[]; now?: () => number }

export const PLACEHOLDER_SHOT = resolve(import.meta.dir, '..', 'static-host', 'shot-unpublished.png')
export const SUB_PATTERN = /^[a-z0-9-]{1,80}$/
const SHOTS = 'shots'
const NEVER_PUBLISHED = new Set(['renders', 'verify'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const RANDOM_LENGTH = 8
const MAX_LABEL = 63
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export const publishDir = (): string => join(configDir(), 'published')

function randomToken(length: number): string {
  let token = ''
  while (token.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < 252 && token.length < length) token += ALPHABET[byte % ALPHABET.length]
    }
  }
  return token
}

function newSub(externalId: string): string {
  const base = externalId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_LABEL - RANDOM_LENGTH - 1).replace(/-+$/, '')
  return `${base === '' ? 'card' : base}-${randomToken(RANDOM_LENGTH)}`
}

async function insideWorktree(item: PublishItem): Promise<string> {
  if (item.worktree === null) throw new Error('The card has no workspace')
  if (item.pick === undefined) throw new Error('The card has no design pick')
  const root = await realpath(item.worktree)
  const source = await realpath(join(root, item.pick.path))
  if (!source.startsWith(root + sep)) throw new Error(`The mockup folder ${item.pick.path} is outside the worktree`)
  if (!(await stat(source)).isDirectory()) throw new Error(`The mockup folder ${item.pick.path} is not a folder`)
  return source
}

const sha256 = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex')

async function isCardImage(path: string, cardHashes: ReadonlySet<string>): Promise<boolean> {
  return cardHashes.size > 0 && IMAGE_EXTENSIONS.has(extname(path).toLowerCase()) && cardHashes.has(await sha256(path))
}

async function copyTree(from: string, to: string, inShots: boolean, cardHashes: ReadonlySet<string>): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      if (!NEVER_PUBLISHED.has(entry.name.toLowerCase())) await copyTree(source, target, inShots || entry.name === SHOTS, cardHashes)
    } else if (entry.isFile()) {
      await copyFile(inShots || await isCardImage(source, cardHashes) ? PLACEHOLDER_SHOT : source, target)
    }
  }
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

export async function publish(item: PublishItem, options: PublishOptions): Promise<Published> {
  const source = await insideWorktree(item)
  const cardHashes = new Set(await Promise.all(options.cardImages.map(sha256)))
  const sub = item.published?.sub ?? newSub(item.externalId)
  await mkdir(options.dir, { recursive: true, mode: 0o700 })
  const staged = join(options.dir, `${sub}.tmp-${randomToken(RANDOM_LENGTH)}`)
  try {
    await copyTree(source, staged, false, cardHashes)
  } catch (error) {
    await rm(staged, { recursive: true, force: true })
    throw error
  }
  const final = join(options.dir, sub)
  const old = join(options.dir, `${sub}.gone-${randomToken(RANDOM_LENGTH)}`)
  const hadOld = await rename(final, old).then(() => true, (error: unknown) => { if (missing(error)) return false; throw error })
  await rename(staged, final)
  if (hadOld) await rm(old, { recursive: true, force: true })
  return { sub, host: `${sub}.${options.domain}`, at: (options.now ?? Date.now)() }
}

export async function unpublish(sub: string, dir: string): Promise<void> {
  if (!SUB_PATTERN.test(sub)) throw new Error(`Not a published folder: ${sub}`)
  await rm(join(dir, sub), { recursive: true, force: true })
}
