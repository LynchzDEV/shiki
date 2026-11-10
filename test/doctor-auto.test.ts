import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import { readConfig } from '../server/secrets'
import { humanSettingsRoutes } from '../server/routes/human-settings'

let dir: string
const priorConfigDir = process.env.SKD_CONFIG_DIR
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skd-doctor-auto-'))
  process.env.SKD_CONFIG_DIR = dir
})
afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.SKD_CONFIG_DIR
  else process.env.SKD_CONFIG_DIR = priorConfigDir
  await rm(dir, { recursive: true, force: true })
})

const call = (method: string, body?: unknown) => new Elysia().use(humanSettingsRoutes()).handle(new Request('http://127.0.0.1:7777/api/doctor/auto', {
  method, headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}))
const settingsLines = async () => (await readFile(join(dir, 'queue-audit', '_settings.jsonl'), 'utf8')).trimEnd().split('\n').map(text => JSON.parse(text) as Record<string, unknown>)

test('config: all off by default; only booleans for pick, reject and keep are read, anything else is ignored', async () => {
  expect((await readConfig()).doctorAuto).toEqual({ pick: false, reject: false, keep: false })
  await writeFile(join(dir, 'config.json'), JSON.stringify({ doctorAuto: { pick: true, reject: 'yes', keep: 1, land: true } }))
  expect((await readConfig()).doctorAuto).toEqual({ pick: true, reject: false, keep: false })
  await writeFile(join(dir, 'config.json'), JSON.stringify({ doctorAuto: ['pick'] }))
  expect((await readConfig()).doctorAuto).toEqual({ pick: false, reject: false, keep: false })
})

test('GET lists the switches; a human PUT turns one on and off, persisted and audited', async () => {
  expect(await (await call('GET')).json()).toEqual({ auto: { pick: false, reject: false, keep: false } })
  const on = await call('PUT', { actor: 'human', intent: 'keep', on: true, why: 'trust it' })
  expect(on.status).toBe(200)
  expect(await on.json()).toEqual({ auto: { pick: false, reject: false, keep: true } })
  expect((await readConfig()).doctorAuto.keep).toBe(true)
  await call('PUT', { actor: 'human', intent: 'keep', on: false })
  expect((await readConfig()).doctorAuto.keep).toBe(false)
  const lines = await settingsLines()
  expect(lines.map(entry => [entry.actor, entry.action, entry.result])).toEqual([['human', 'doctor-auto-set', 'ok'], ['human', 'doctor-auto-set', 'ok']])
  expect(lines[0]).toMatchObject({ why: 'trust it', params: { intent: 'keep', on: true } })
})

test('a non-human PUT is 403, changes nothing and is logged as refused; a bad body is 400', async () => {
  for (const actor of ['grok', 'doctor', 'doctor-auto']) {
    expect((await call('PUT', { actor, intent: 'pick', on: true })).status).toBe(403)
  }
  expect((await readConfig()).doctorAuto.pick).toBe(false)
  expect((await settingsLines()).map(entry => entry.result)).toEqual(['refused', 'refused', 'refused'])
  expect((await call('PUT', { actor: 'human', intent: 'land', on: true })).status).toBe(400)
  expect((await call('PUT', { actor: 'human', intent: 'pick', on: 'yes' })).status).toBe(400)
})
