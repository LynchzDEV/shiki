import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realEngineResolver } from '../server/jobs-engine-iface'
import { writeSecrets } from '../server/secrets'
import { workerPluginSettings } from '../server/worker-plugin-guard'

let dir: string
let previousClaudeDir: string | undefined
const writeSettings = (body: string) => writeFile(join(dir, 'settings.json'), body)
const DISABLE_PSTACK = JSON.stringify({ enabledPlugins: { 'pstack@pstack-claude': false } })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-plugin-guard-'))
  previousClaudeDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.SKD_CONFIG_DIR = dir
  process.env.SKD_FAKE_ENGINES = '1'
  process.env.SKD_FAKE_CHAT_BRIDGE = '1'
})
afterEach(async () => {
  if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir
  delete process.env.SKD_FAKE_ENGINES
  delete process.env.SKD_FAKE_CHAT_BRIDGE
  await rm(dir, { recursive: true, force: true })
})

describe('workerPluginSettings', () => {
  test('is null when settings.json is missing or not JSON', async () => {
    expect(workerPluginSettings(dir)).toBeNull()
    await writeSettings('{nope')
    expect(workerPluginSettings(dir)).toBeNull()
  })

  test('is null when pstack is absent, disabled or settings lack enabledPlugins', async () => {
    await writeSettings(JSON.stringify({ enabledPlugins: { 'other@x': true } }))
    expect(workerPluginSettings(dir)).toBeNull()
    await writeSettings(JSON.stringify({ enabledPlugins: { 'pstack@x': false } }))
    expect(workerPluginSettings(dir)).toBeNull()
    await writeSettings('{}')
    expect(workerPluginSettings(dir)).toBeNull()
  })

  test('disables only the enabled pstack plugin', async () => {
    await writeSettings(JSON.stringify({ enabledPlugins: { 'pstack@pstack-claude': true, 'other@x': true } }))
    expect(workerPluginSettings(dir)).toBe(DISABLE_PSTACK)
  })
})

describe('worker spawn plugin settings', () => {
  beforeEach(() => writeSettings(JSON.stringify({ enabledPlugins: { 'pstack@pstack-claude': true } })))

  test('non-chat claude and glm spawns unload pstack', async () => {
    await writeSecrets({ zaiAuthToken: 'zai-test-token' })
    for (const engine of ['claude', 'glm']) {
      for (const extra of [{}, { readOnly: true }, { step: true }]) {
        const { args } = await realEngineResolver({ engine, prompt: 'p', ...extra })
        expect(args[args.indexOf('--settings') + 1]).toBe(DISABLE_PSTACK)
        expect(args.filter(arg => arg === '--settings')).toHaveLength(1)
      }
    }
  })

  test('chat and codex spawns keep the plugin', async () => {
    expect((await realEngineResolver({ engine: 'claude', prompt: 'p', purpose: 'chat' })).args).not.toContain('--settings')
    expect((await realEngineResolver({ engine: 'codex', prompt: 'p' })).args).not.toContain('--settings')
  })
})
