import { afterEach, describe, expect, test } from 'bun:test'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { logSecrets, redactAll, redactLine } from '../server/log-redaction'

const TOKEN = 'mct_0123456789abcdef0123456789abcdef'

describe('redactLine', () => {
  test('redacts every named secret in a line', () => {
    expect(redactAll(`a=${TOKEN} b=zai-secret-value`, [TOKEN, 'zai-secret-value', null])).toBe('a=[REDACTED] b=[REDACTED]')
  })
  test('redacts a secret cut off by a clipped preview', () => {
    expect(redactLine(`token=${TOKEN.slice(0, 20)}…`, [TOKEN])).toBe('token=[REDACTED]…')
  })
  test('leaves short look-alikes and unclipped lines alone', () => {
    expect(redactLine('token=mct_01…', [TOKEN])).toBe('token=mct_01…')
    expect(redactLine(`token=${TOKEN.slice(0, 20)}`, [TOKEN])).toBe(`token=${TOKEN.slice(0, 20)}`)
  })
})

describe('logSecrets', () => {
  afterEach(() => { delete process.env.SKD_CONFIG_DIR })

  test('includes the webhook key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-logsecrets-'))
    process.env.SKD_CONFIG_DIR = dir
    await Bun.write(join(dir, 'secrets.json'), JSON.stringify({ notifyWebhookKey: 'whk-secret-key' }))
    expect(await logSecrets()).toContain('whk-secret-key')
    await rm(dir, { recursive: true, force: true })
  })
})
