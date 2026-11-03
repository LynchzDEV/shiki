import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(homedir(), '.cache', 'shiki-tests')
const STALE_MS = 60 * 60_000

export async function homeScratch(prefix: string): Promise<string> {
  await mkdir(ROOT, { recursive: true })
  return mkdtemp(join(ROOT, prefix))
}

export async function sweepHomeScratch(now = Date.now()): Promise<void> {
  for (const name of await readdir(ROOT).catch(() => [])) {
    const path = join(ROOT, name)
    if (now - (await stat(path)).mtimeMs > STALE_MS) await rm(path, { recursive: true, force: true })
  }
}
