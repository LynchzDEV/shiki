import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  WORKER_CLAUDE_MD,
  WORKER_CLAUDE_SETTINGS,
  WORKER_CODEX_CONFIG,
  ensureWorkerProfiles,
  workerEnv,
  workerProfileDirs,
} from '../server/worker-profile'
import { chatEnv } from '../server/chat-profile'

let dir: string
let sourceAuth: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-worker-profile-'))
  sourceAuth = join(dir, 'source-auth.json')
  await writeFile(sourceAuth, '{"tokens":{}}')
})

afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('ensureWorkerProfiles', () => {
  test('creates both dirs with the constants on disk and symlinks the codex auth', async () => {
    const dirs = await ensureWorkerProfiles({ configDir: dir, codexAuthPath: sourceAuth })

    expect(dirs).toEqual({ claude: join(dir, 'worker-claude'), codex: join(dir, 'worker-codex') })
    expect(await readFile(join(dirs.claude, 'CLAUDE.md'), 'utf8')).toBe(WORKER_CLAUDE_MD)
    expect(JSON.parse(await readFile(join(dirs.claude, 'settings.json'), 'utf8'))).toEqual(WORKER_CLAUDE_SETTINGS)
    expect(await readFile(join(dirs.codex, 'config.toml'), 'utf8')).toBe(WORKER_CODEX_CONFIG)
    expect(WORKER_CODEX_CONFIG).toBe('approval_policy = "never"\nsandbox_mode = "danger-full-access"\n')

    const authLink = join(dirs.codex, 'auth.json')
    expect((await lstat(authLink)).isSymbolicLink()).toBe(true)
    expect(await readlink(authLink)).toBe(sourceAuth)

    const { stat } = await import('node:fs/promises')
    expect((await stat(dirs.claude)).mode & 0o777).toBe(0o700)
    expect((await stat(dirs.codex)).mode & 0o777).toBe(0o700)
  })

  test('a missing auth source means no symlink and no throw', async () => {
    const dirs = await ensureWorkerProfiles({ configDir: dir, codexAuthPath: join(dir, 'nope', 'auth.json') })
    expect(await Array.fromAsync(new Bun.Glob('auth.json').scan({ cwd: dirs.codex }))).toEqual([])
  })

  test('a second run rewrites CLAUDE.md over manual edits and keeps the symlink', async () => {
    const dirs = await ensureWorkerProfiles({ configDir: dir, codexAuthPath: sourceAuth })
    const claudeMd = join(dirs.claude, 'CLAUDE.md')
    await writeFile(claudeMd, 'hand-edited drift')
    await ensureWorkerProfiles({ configDir: dir, codexAuthPath: sourceAuth })

    expect(await readFile(claudeMd, 'utf8')).toBe(WORKER_CLAUDE_MD)
    const authLink = join(dirs.codex, 'auth.json')
    expect((await lstat(authLink)).isSymbolicLink()).toBe(true)
    expect(await readlink(authLink)).toBe(sourceAuth)
  })

  test('falls back to the config dir from the environment', async () => {
    process.env.SKD_CONFIG_DIR = dir
    const dirs = await ensureWorkerProfiles()
    expect(dirs).toEqual(workerProfileDirs())
    expect(dirs.claude.startsWith(dir)).toBe(true)
  })
})

describe('WORKER_CLAUDE_MD house rules', () => {
  test('carries the code-output rules the slim profile drops with the global CLAUDE.md', () => {
    expect(WORKER_CLAUDE_MD).toContain("language's conventions")
    expect(WORKER_CLAUDE_MD).not.toContain('db/migrate')
    expect(WORKER_CLAUDE_MD).toContain('Write the test first')
    expect(WORKER_CLAUDE_MD).toContain('stop and report the conflict')
  })
})

describe('workerProfileDirs', () => {
  test('names both dirs under the given base', () => {
    expect(workerProfileDirs('/tmp/base')).toEqual({
      claude: join('/tmp/base', 'worker-claude'),
      codex: join('/tmp/base', 'worker-codex'),
    })
  })
})

describe('workerEnv', () => {
  const dirs = { claude: '/p/worker-claude', codex: '/p/worker-codex' }

  test('glm isolates the claude config dir', () => {
    expect(workerEnv('glm', dirs)).toEqual({ CLAUDE_CONFIG_DIR: dirs.claude })
  })

  test('codex isolates the codex home', () => {
    expect(workerEnv('codex', dirs)).toEqual({ CODEX_HOME: dirs.codex })
  })

  test('claude keeps the user profile', () => {
    expect(workerEnv('claude', dirs)).toEqual({})
  })

  test('with the full agent setup switch on, every engine keeps the user profile', () => {
    const saved = process.env.SKD_FULL_AGENT_SETUP
    process.env.SKD_FULL_AGENT_SETUP = '1'
    try {
      expect(workerEnv('glm', dirs)).toEqual({})
      expect(workerEnv('codex', dirs)).toEqual({})
      expect(chatEnv('glm', dirs)).toEqual({})
      expect(chatEnv('codex', dirs)).toEqual({})
      process.env.SKD_FULL_AGENT_SETUP = '0'
      expect(workerEnv('glm', dirs)).toEqual({ CLAUDE_CONFIG_DIR: dirs.claude })
      expect(chatEnv('codex', dirs)).toEqual({ CODEX_HOME: dirs.codex })
    } finally {
      if (saved === undefined) delete process.env.SKD_FULL_AGENT_SETUP
      else process.env.SKD_FULL_AGENT_SETUP = saved
    }
  })
})
