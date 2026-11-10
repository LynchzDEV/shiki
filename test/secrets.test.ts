import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  API_TOKEN_PREFIX,
  CONFIG_FILE,
  DEFAULT_FALLBACK,
  DEFAULT_ROLES,
  DEFAULT_ZAI_BASE_URL,
  SECRETS_FILE,
  configPath,
  ensureConfigDir,
  listenTarget,
  publicView,
  readApiToken,
  isRoleName,
  readConfig,
  readSecrets,
  rotateApiToken,
  writeConfig,
  writeSecrets,
} from '../server/secrets'

const TOKEN = 'sk-zai-test-token-value-do-not-leak'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-secrets-'))
  process.env.SKD_CONFIG_DIR = dir
})

afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777
}

describe('defaults', () => {
  test('missing files fall back to documented defaults', async () => {
    expect(await readSecrets()).toEqual({ zaiAuthToken: null, zaiBaseUrl: DEFAULT_ZAI_BASE_URL, apiToken: null, notifyWebhookUrl: null, notifyWebhookKey: null })
    expect(await readConfig()).toEqual({ roles: DEFAULT_ROLES, fallback: DEFAULT_FALLBACK, autoReview: false, chatHome: null, flowApproval: true, marketplaces: [], queueParallel: 1, replyPollMinutes: 2, publishKeepDays: 14, pickAskTo: null, pickNonePhrases: [], pickKeepPhrases: [] })
  })

  test('corrupt json falls back instead of throwing', async () => {
    await ensureConfigDir()
    await Bun.write(configPath(SECRETS_FILE), '{ not json')
    expect(await readSecrets()).toEqual({ zaiAuthToken: null, zaiBaseUrl: DEFAULT_ZAI_BASE_URL, apiToken: null, notifyWebhookUrl: null, notifyWebhookKey: null })
  })
})

describe('round trip', () => {
  test('secrets survive write then read', async () => {
    await writeSecrets({ zaiAuthToken: TOKEN, zaiBaseUrl: 'https://example.test/anthropic' })
    expect(await readSecrets()).toEqual({
      zaiAuthToken: TOKEN,
      zaiBaseUrl: 'https://example.test/anthropic',
      apiToken: null,
      notifyWebhookUrl: null,
      notifyWebhookKey: null,
    })
  })

  test('partial writes merge with stored values', async () => {
    await writeSecrets({ zaiAuthToken: TOKEN })
    await writeSecrets({ zaiBaseUrl: 'https://example.test/anthropic' })
    const stored = await readSecrets()
    expect(stored.zaiAuthToken).toBe(TOKEN)
    expect(stored.zaiBaseUrl).toBe('https://example.test/anthropic')
  })

  test('the flat model keys of the built-in roles are not role names', () => {
    expect(['plan_model', 'execute_model', 'review_model'].map(isRoleName)).toEqual([false, false, false])
    expect(isRoleName('builder')).toBe(true)
  })

  test('a role named like an object property survives a reload', async () => {
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ roles: { constructor: { engine: 'codex', model: null }, toString: 'claude' } }))
    const { roles } = await readConfig()
    expect(roles.constructor).toEqual({ engine: 'codex', model: null })
    expect(roles.toString).toEqual({ engine: 'claude', model: null })
  })

  test('roles persist and missing fields fall back per role', async () => {
    const roles = {
      plan: { engine: 'codex', model: 'gpt-5.1' },
      execute: { engine: 'glm', model: null },
      review: { engine: 'claude', model: null },
    }
    await writeConfig({ roles })
    expect((await readConfig()).roles).toEqual(roles)

    await ensureConfigDir()
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ roles: { execute: 'codex' } }))
    expect((await readConfig()).roles).toEqual({ ...DEFAULT_ROLES, execute: { engine: 'codex', model: null } })
  })

  test('config without fallback defaults to claude', async () => {
    expect((await readConfig()).fallback).toEqual({ engine: 'claude', model: null })
    await ensureConfigDir()
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ fallback: null }))
    expect((await readConfig()).fallback).toBeNull()
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ fallback: { engine: 'codex', model: 'gpt-5' } }))
    expect((await readConfig()).fallback).toEqual({ engine: 'codex', model: 'gpt-5' })
  })

  test('named roles load beside the three defaults; reserved or malformed names are dropped', async () => {
    await ensureConfigDir()
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ roles: { builder: { engine: 'claude', model: 'opus' }, tester: 'codex', fallback: 'glm', autoReview: 'glm', 'bad name': 'glm', empty: {} } }))
    expect((await readConfig()).roles).toEqual({ ...DEFAULT_ROLES, builder: { engine: 'claude', model: 'opus' }, tester: { engine: 'codex', model: null } })
  })

  test('autoReview defaults to false and survives the round trip', async () => {
    expect((await readConfig()).autoReview).toBe(false)
    await writeConfig({ autoReview: true })
    expect((await readConfig()).autoReview).toBe(true)
    await writeConfig({ roles: DEFAULT_ROLES })
    expect((await readConfig()).autoReview).toBe(true)
  })

  test('chatHome defaults to null, survives the round trip and drops non-strings', async () => {
    expect((await readConfig()).chatHome).toBeNull()
    await writeConfig({ chatHome: '/Users/me/work' })
    expect((await readConfig()).chatHome).toBe('/Users/me/work')
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ chatHome: 42 }))
    expect((await readConfig()).chatHome).toBeNull()
  })

  test('queueParallel reads 1 when missing, clamps whole numbers to 1..4 and survives the round trip', async () => {
    expect((await readConfig()).queueParallel).toBe(1)
    await ensureConfigDir()
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ queueParallel: 9 }))
    expect((await readConfig()).queueParallel).toBe(4)
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ queueParallel: 0 }))
    expect((await readConfig()).queueParallel).toBe(1)
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ queueParallel: 2.5 }))
    expect((await readConfig()).queueParallel).toBe(1)
    await writeConfig({ queueParallel: 3 })
    expect((await readConfig()).queueParallel).toBe(3)
  })

  test('replyPollMinutes reads 2 when missing and clamps whole numbers to 1..15', async () => {
    await ensureConfigDir()
    for (const [raw, read] of [[30, 15], [0, 1], [1.5, 2], ['5', 2], [7, 7]] as const) {
      await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ replyPollMinutes: raw }))
      expect((await readConfig()).replyPollMinutes).toBe(read)
    }
  })

  test('publishKeepDays reads 14 when missing and clamps whole numbers to 1..90', async () => {
    await ensureConfigDir()
    for (const [raw, read] of [[365, 90], [0, 1], [2.5, 14], [30, 30]] as const) {
      await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ publishKeepDays: raw }))
      expect((await readConfig()).publishKeepDays).toBe(read)
    }
  })

  test('pickAskTo reads only a digit id of up to 30 characters, otherwise null', async () => {
    await ensureConfigDir()
    for (const [raw, read] of [['101078127', '101078127'], ['', null], ['12a', null], [101, null], ['1'.repeat(31), null], ['1'.repeat(30), '1'.repeat(30)]] as const) {
      await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ pickAskTo: raw }))
      expect((await readConfig()).pickAskTo).toBe(read)
    }
  })

  test('pickKeepPhrases reads the same way as pickNonePhrases and defaults to none', async () => {
    await ensureConfigDir()
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ pickKeepPhrases: [' ใช้ของเดิม ', 'ab', 7] }))
    expect((await readConfig()).pickKeepPhrases).toEqual(['ใช้ของเดิม'])
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ pickKeepPhrases: 'keep' }))
    expect((await readConfig()).pickKeepPhrases).toEqual([])
  })

  test('pickNonePhrases reads trimmed phrases of 1..60 characters, at most 30, and drops the rest', async () => {
    await ensureConfigDir()
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ pickNonePhrases: [' ไม่เอา ', '', 'ab', 7, 'x'.repeat(61), 'nope'] }))
    expect((await readConfig()).pickNonePhrases).toEqual(['ไม่เอา', 'nope'])
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ pickNonePhrases: Array.from({ length: 40 }, (_, n) => `p${n}`) }))
    expect((await readConfig()).pickNonePhrases).toHaveLength(30)
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ pickNonePhrases: 'nope' }))
    expect((await readConfig()).pickNonePhrases).toEqual([])
  })

  test('publishDomain is not a config setting: an old value on disk is dropped on the next write', async () => {
    await ensureConfigDir()
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ publishDomain: 'old.example.com' }))
    expect(await readConfig()).not.toHaveProperty('publishDomain')
    await writeConfig({ queueParallel: 2 })
    expect(JSON.parse(await Bun.file(configPath(CONFIG_FILE)).text())).not.toHaveProperty('publishDomain')
  })

  test('legacy string roles on disk load with a null model', async () => {
    await ensureConfigDir()
    await Bun.write(
      configPath(CONFIG_FILE),
      JSON.stringify({ roles: { plan: 'codex', execute: 'glm', review: 'claude' } }),
    )
    expect((await readConfig()).roles).toEqual({
      plan: { engine: 'codex', model: null },
      execute: { engine: 'glm', model: null },
      review: { engine: 'claude', model: null },
    })
  })

  test('an invalid model type is dropped to null', async () => {
    await ensureConfigDir()
    await Bun.write(configPath(CONFIG_FILE), JSON.stringify({ roles: { plan: { engine: 'claude', model: 42 } } }))
    expect((await readConfig()).roles.plan).toEqual({ engine: 'claude', model: null })
  })
})

describe('permissions', () => {
  test('directory is 0700 and every file is 0600', async () => {
    await writeSecrets({ zaiAuthToken: TOKEN })
    await writeConfig({ autoReview: false })

    expect(await modeOf(dir)).toBe(0o700)
    expect(await modeOf(configPath(SECRETS_FILE))).toBe(0o600)
    expect(await modeOf(configPath(CONFIG_FILE))).toBe(0o600)
  })

  test('rewriting an existing file keeps it at 0600', async () => {
    await writeSecrets({ zaiAuthToken: TOKEN })
    await writeSecrets({ zaiAuthToken: `${TOKEN}-rotated` })
    expect(await modeOf(configPath(SECRETS_FILE))).toBe(0o600)
  })
})

describe('publicView', () => {
  test('never exposes the token value', async () => {
    await writeSecrets({ zaiAuthToken: TOKEN })
    const view = publicView(await readSecrets())

    expect(JSON.stringify(view)).not.toContain(TOKEN)
    expect(Object.values(view)).not.toContain(TOKEN)
    expect(view).toEqual({
      zaiBaseUrl: DEFAULT_ZAI_BASE_URL,
      zaiAuthTokenConfigured: true,
      apiTokenConfigured: false,
      notifyWebhookUrl: null,
      notifyWebhookKeyConfigured: false,
    })
  })

  test('shows the webhook url but never the webhook key', () => {
    const view = publicView({ zaiAuthToken: null, zaiBaseUrl: DEFAULT_ZAI_BASE_URL, apiToken: null, notifyWebhookUrl: 'https://bot.example/hook', notifyWebhookKey: 'whk-secret' })
    expect(view.notifyWebhookUrl).toBe('https://bot.example/hook')
    expect(view.notifyWebhookKeyConfigured).toBe(true)
    expect(JSON.stringify(view)).not.toContain('whk-secret')
  })

  test('reports unconfigured for missing or empty token', () => {
    expect(publicView({ zaiAuthToken: null, zaiBaseUrl: DEFAULT_ZAI_BASE_URL, apiToken: null, notifyWebhookUrl: null, notifyWebhookKey: null })).toEqual({
      zaiBaseUrl: DEFAULT_ZAI_BASE_URL,
      zaiAuthTokenConfigured: false,
      apiTokenConfigured: false,
      notifyWebhookUrl: null,
      notifyWebhookKeyConfigured: false,
    })
    expect(publicView({ zaiAuthToken: '', zaiBaseUrl: DEFAULT_ZAI_BASE_URL, apiToken: '', notifyWebhookUrl: '', notifyWebhookKey: '' })).toEqual({
      zaiBaseUrl: DEFAULT_ZAI_BASE_URL,
      zaiAuthTokenConfigured: false,
      apiTokenConfigured: false,
      notifyWebhookUrl: null,
      notifyWebhookKeyConfigured: false,
    })
  })

  test('never exposes the api token value once generated', async () => {
    const apiToken = await readApiToken()
    const view = publicView(await readSecrets())

    expect(JSON.stringify(view)).not.toContain(apiToken)
    expect(view.apiTokenConfigured).toBe(true)
  })
})

describe('readApiToken', () => {
  test('generates a prefixed token on first read and persists it', async () => {
    const token = await readApiToken()
    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true)
    expect(token.slice(API_TOKEN_PREFIX.length)).toMatch(/^[0-9a-f]{48}$/)

    const stored = await readSecrets()
    expect(stored.apiToken).toBe(token)
  })

  test('is idempotent — repeat reads return the same token', async () => {
    const first = await readApiToken()
    const second = await readApiToken()
    expect(second).toBe(first)
  })

  test('is persisted at 0600', async () => {
    await readApiToken()
    expect(await modeOf(configPath(SECRETS_FILE))).toBe(0o600)
  })
})

describe('rotateApiToken', () => {
  test('replaces the stored token with a new, differently-valued one', async () => {
    const original = await readApiToken()
    const rotated = await rotateApiToken()

    expect(rotated).not.toBe(original)
    expect(rotated.startsWith(API_TOKEN_PREFIX)).toBe(true)
    expect((await readSecrets()).apiToken).toBe(rotated)
    expect(await readApiToken()).toBe(rotated)
  })
})

describe('listenTarget', () => {
  test('is loopback on 7777 by default', () => {
    delete process.env.SKD_PORT
    expect(listenTarget()).toEqual({ hostname: '127.0.0.1', port: 7777 })
  })

  test('still honours the legacy MISSION_CONTROL_PORT', () => {
    process.env.MISSION_CONTROL_PORT = '7782'
    try {
      expect(listenTarget().port).toBe(7782)
    } finally { delete process.env.MISSION_CONTROL_PORT }
  })

  test('honours SKD_PORT and ignores junk', () => {
    process.env.SKD_PORT = '7781'
    expect(listenTarget().port).toBe(7781)
    process.env.SKD_PORT = 'nope'
    expect(listenTarget().port).toBe(7777)
    delete process.env.SKD_PORT
  })
})
