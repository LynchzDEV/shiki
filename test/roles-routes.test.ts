import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { createApp } from '../server/index'
import { parseRoles } from '../server/routes/roles'
import { DEFAULT_FALLBACK, DEFAULT_ROLES, readConfig } from '../server/secrets'

let dir: string
let app: Elysia

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-roles-route-'))
  process.env.SKD_CONFIG_DIR = dir
  app = await createApp()
})

afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

function request(method: string, body?: unknown, origin = 'http://localhost'): Request {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  return new Request(`${origin}/api/roles`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('parseRoles', () => {
  test('accepts any engine per role and rejects unknown or missing engines', () => {
    expect(parseRoles({ plan: 'glm', execute: 'glm', review: 'glm' })).toEqual({
      ok: true,
      roles: {
        plan: { engine: 'glm', model: null },
        execute: { engine: 'glm', model: null },
        review: { engine: 'glm', model: null },
      },
    })
    expect(parseRoles({ plan: 'claude', execute: 'gpt', review: 'codex' }).ok).toBe(false)
    expect(parseRoles({ plan: 'claude', review: 'codex' }).ok).toBe(false)
    expect(parseRoles(null).ok).toBe(false)
  })

  test('accepts the nested form with an optional model, trimmed, empty to null', () => {
    expect(
      parseRoles({
        plan: { engine: 'claude', model: ' opus ' },
        execute: { engine: 'glm', model: '   ' },
        review: { engine: 'codex', model: 'gpt-5.1' },
      }),
    ).toEqual({
      ok: true,
      roles: {
        plan: { engine: 'claude', model: 'opus' },
        execute: { engine: 'glm', model: null },
        review: { engine: 'codex', model: 'gpt-5.1' },
      },
    })
    expect(parseRoles({ plan: { engine: 'claude' }, execute: 'glm', review: 'codex' })).toEqual({
      ok: true,
      roles: {
        plan: { engine: 'claude', model: null },
        execute: { engine: 'glm', model: null },
        review: { engine: 'codex', model: null },
      },
    })
  })

  test('accepts the flat settings-form shape with role_model keys', () => {
    expect(
      parseRoles({ plan: 'claude', plan_model: 'fable', execute: 'glm', execute_model: '', review: 'codex' }),
    ).toEqual({
      ok: true,
      roles: {
        plan: { engine: 'claude', model: 'fable' },
        execute: { engine: 'glm', model: null },
        review: { engine: 'codex', model: null },
      },
    })
  })

  test('rejects a model longer than 100 characters', () => {
    expect(parseRoles({ plan: 'claude', plan_model: 'x'.repeat(101), execute: 'glm', review: 'codex' })).toEqual({
      ok: false,
      error: 'plan model too long',
    })
  })

  test('parses autoReview from booleans or on/off strings, and rejects junk', () => {
    expect(parseRoles({ plan: 'claude', execute: 'glm', review: 'codex', autoReview: true })).toEqual({
      ok: true,
      roles: { plan: { engine: 'claude', model: null }, execute: { engine: 'glm', model: null }, review: { engine: 'codex', model: null } },
      autoReview: true,
    })
    expect(parseRoles({ plan: 'claude', execute: 'glm', review: 'codex', autoReview: 'off' })).toEqual({
      ok: true,
      roles: { plan: { engine: 'claude', model: null }, execute: { engine: 'glm', model: null }, review: { engine: 'codex', model: null } },
      autoReview: false,
    })
    expect(parseRoles({ plan: 'claude', execute: 'glm', review: 'codex', autoReview: 'nope' }).ok).toBe(false)
  })
})

describe('/api/roles', () => {
  test('GET returns defaults and refuses a rebinding host', async () => {
    expect((await app.handle(request('GET', undefined, 'http://rebind.example'))).status).toBe(403)
    const response = await app.handle(request('GET'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ...DEFAULT_ROLES, autoReview: false, fallback: DEFAULT_FALLBACK })
  })

  test('POST persists the full nested mapping and GET reflects it', async () => {
    const next = {
      plan: { engine: 'claude', model: null },
      execute: { engine: 'codex', model: 'gpt-5.1' },
      review: { engine: 'claude', model: null },
    }
    const saved = await app.handle(request('POST', next))
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ ...next, autoReview: false, fallback: DEFAULT_FALLBACK })
    expect((await readConfig()).roles).toEqual(next)
    expect(await (await app.handle(request('GET'))).json()).toEqual({ ...next, autoReview: false, fallback: DEFAULT_FALLBACK })
  })

  test('POST accepts the flat settings form and returns the nested shape', async () => {
    const saved = await app.handle(
      request('POST', { plan: 'claude', plan_model: 'opus', execute: 'glm', review: 'codex' }),
    )
    expect(saved.status).toBe(200)
    const nested = {
      plan: { engine: 'claude', model: 'opus' },
      execute: { engine: 'glm', model: null },
      review: { engine: 'codex', model: null },
    }
    expect(await saved.json()).toEqual({ ...nested, autoReview: false, fallback: DEFAULT_FALLBACK })
    expect((await readConfig()).roles).toEqual(nested)
  })

  test('POST autoReview on persists and a later POST without the field leaves it unchanged', async () => {
    const saved = await app.handle(
      request('POST', { plan: 'claude', execute: 'glm', review: 'codex', autoReview: 'on' }),
    )
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({
      plan: { engine: 'claude', model: null },
      execute: { engine: 'glm', model: null },
      review: { engine: 'codex', model: null },
      autoReview: true,
      fallback: DEFAULT_FALLBACK,
    })
    expect((await readConfig()).autoReview).toBe(true)

    const after = await app.handle(request('POST', { plan: 'codex', execute: 'glm', review: 'claude' }))
    expect(await after.json()).toEqual({
      plan: { engine: 'codex', model: null },
      execute: { engine: 'glm', model: null },
      review: { engine: 'claude', model: null },
      autoReview: true,
      fallback: DEFAULT_FALLBACK,
    })
  })

  test('accepts named roles and a fallback, rejects reserved names', async () => {
    const roles = { plan: 'claude', execute: 'glm', review: 'codex' }
    const saved = await app.handle(request('POST', { ...roles, builder: { engine: 'claude', model: 'opus' }, fallback: { engine: 'claude', model: null } }))
    expect(saved.status).toBe(200)
    const view = await (await app.handle(request('GET'))).json()
    expect(view.builder.model).toBe('opus')
    expect(view.fallback.engine).toBe('claude')
    expect((await app.handle(request('POST', { ...roles, autoReview: { engine: 'claude', model: null } }))).status).toBe(400)
    expect((await app.handle(request('POST', { ...roles, 'bad name': 'claude' }))).status).toBe(400)
    expect((await app.handle(request('POST', { ...roles, builder: 'gpt' }))).status).toBe(400)
    const crowd = Object.fromEntries(Array.from({ length: 22 }, (_, index) => [`role-${index}`, 'claude']))
    expect((await app.handle(request('POST', { ...roles, ...crowd }))).status).toBe(400)
    expect((await readConfig()).roles.builder).toEqual({ engine: 'claude', model: 'opus' })
  })

  test('fallback null turns it off, and a POST without fallback keeps it', async () => {
    const roles = { plan: 'claude', execute: 'glm', review: 'codex' }
    await app.handle(request('POST', { ...roles, fallback: null }))
    expect((await (await app.handle(request('GET'))).json()).fallback).toBeNull()
    await app.handle(request('POST', roles))
    expect((await readConfig()).fallback).toBeNull()
  })

  test('POST rejects a partial or invalid mapping without touching storage', async () => {
    expect((await app.handle(request('POST', { plan: 'claude' }))).status).toBe(400)
    expect((await app.handle(request('POST', { plan: 'claude', execute: 'nope', review: 'codex' }))).status).toBe(400)
    expect((await readConfig()).roles).toEqual(DEFAULT_ROLES)
  })
})
