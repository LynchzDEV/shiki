import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAvailabilityCheck } from '../server/engine-availability'
import type { QuotaComposite } from '../server/quota'
import type { Secrets } from '../server/secrets'

const NOW = Date.parse('2026-11-03T10:00:00Z')
const HOUR = 3_600_000
const secrets: Secrets = { zaiAuthToken: 'token', zaiBaseUrl: 'https://z.ai', apiToken: null }
const idle: QuotaComposite = {
  claude: { available: false, reason: 'not probed' },
  glm: { available: false, reason: 'not probed' },
  codex: { available: true, authed: true, fiveHourPct: 10, weeklyPct: 20 },
  grok: { available: false, reason: 'not probed' },
  peak: { peak: false, minutesToChange: 0 },
}
const check = (over: { secrets?: Partial<Secrets>; quota?: () => Promise<QuotaComposite> } = {}) =>
  createAvailabilityCheck({ secrets: async () => ({ ...secrets, ...over.secrets }), quota: over.quota ?? (async () => idle), now: () => NOW })

let bin: string
const savedPath = process.env.PATH
beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), 'mc-availability-bin-'))
  for (const name of ['claude', 'codex']) {
    await writeFile(join(bin, name), '#!/bin/sh\n')
    await chmod(join(bin, name), 0o755)
  }
  process.env.PATH = `${bin}:${savedPath}`
  delete process.env.SKD_FAKE_ENGINES
})
afterAll(async () => {
  process.env.PATH = savedPath
  await rm(bin, { recursive: true, force: true })
})

test('glm without a z.ai token is unavailable until the token is set', async () => {
  expect((await check({ secrets: { zaiAuthToken: null } })({ engine: 'glm' }))?.reason).toContain('z.ai token')
  expect(await check()({ engine: 'glm' })).toBeNull()
})

test('a connection whose command is missing is not installed', async () => {
  const connection = { id: 'ghost', name: 'Ghost', adapter: 'acp', command: '/nonexistent/ghost-agent', args: [], env: {}, models: [], autoApprove: false, output: 'text', provider: 'custom' } as const
  const down = await check()({ engine: 'ghost', connection })
  expect(down?.reason.endsWith('is not installed')).toBe(true)
  expect(down?.until).toBeNull()
  expect(await check()({ engine: 'live', connection: { ...connection, command: process.execPath } })).toBeNull()
})

test('codex at its weekly limit is unavailable until the weekly reset', async () => {
  const reset = new Date(NOW + HOUR).toISOString()
  const full: QuotaComposite = { ...idle, codex: { available: true, authed: true, fiveHourPct: 40, weeklyPct: 100, weeklyResetsAt: reset } }
  expect(await check({ quota: async () => full })({ engine: 'codex' })).toEqual({ reason: 'codex usage limit reached', until: NOW + HOUR })
  const past: QuotaComposite = { ...idle, codex: { available: true, authed: true, weeklyPct: 100, weeklyResetsAt: new Date(NOW - HOUR).toISOString() } }
  expect(await check({ quota: async () => past })({ engine: 'codex' })).toBeNull()
})

test('claude stays available at a full usage reading, because that reading is an estimate', async () => {
  const reset = new Date(NOW + HOUR).toISOString()
  const full = { ...idle, claude: { ...idle.claude, available: true, weeklyPct: 100, weeklyResetsAt: reset } } as QuotaComposite
  expect(await check({ quota: async () => full })({ engine: 'claude' })).toBeNull()
})

test('both windows full waits for the later reset', async () => {
  const both: QuotaComposite = { ...idle, codex: { available: true, authed: true, fiveHourPct: 100, fiveHourResetsAt: new Date(NOW + HOUR).toISOString(), weeklyPct: 100, weeklyResetsAt: new Date(NOW + 5 * HOUR).toISOString() } }
  expect((await check({ quota: async () => both })({ engine: 'codex' }))?.until).toBe(NOW + 5 * HOUR)
})

test('a quota read that throws does not make the engine unavailable', async () => {
  expect(await check({ quota: async () => { throw new Error('ccusage missing') } })({ engine: 'codex' })).toBeNull()
})

test('session steps and fake engines are always available', async () => {
  expect(await check({ secrets: { zaiAuthToken: null } })({ engine: 'session' })).toBeNull()
  process.env.SKD_FAKE_ENGINES = '1'
  try { expect(await check({ secrets: { zaiAuthToken: null } })({ engine: 'glm' })).toBeNull() } finally { delete process.env.SKD_FAKE_ENGINES }
})
