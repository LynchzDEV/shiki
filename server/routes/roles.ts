import { Elysia } from 'elysia'

import { requireLocal } from '../auth'
import { ENGINE_NAMES, MAX_MODEL_LENGTH } from '../engines'
import { type AppConfig, type EngineRoles, isRoleName, MAX_ROLES, RESERVED_ROLE_NAMES, type RoleAssignment, readConfig, writeConfig } from '../secrets'
import { createConnectionStore } from '../agent-connections'

export const ROLE_NAMES = ['plan', 'execute', 'review'] as const

export type RoleName = (typeof ROLE_NAMES)[number]

const AUTO_REVIEW_FLAGS: Record<string, boolean> = { on: true, true: true, off: false, false: false }

type ParsedRoles = { ok: true; roles: EngineRoles; autoReview?: boolean; fallback?: RoleAssignment | null } | { ok: false; error: string }

const FLAT_MODEL_KEYS: readonly string[] = ROLE_NAMES.map(role => `${role}_model`)

function parseAssignment(name: string, value: unknown, flatModel: unknown, engines: readonly string[]): RoleAssignment | string {
  const nested = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  const engine = typeof value === 'string' ? value : nested?.engine
  if (typeof engine !== 'string' || !engines.includes(engine)) return `${name} must be one of ${engines.join(', ')}`
  const rawModel = typeof flatModel === 'string' ? flatModel : typeof nested?.model === 'string' ? nested.model : null
  const model = rawModel === null ? null : rawModel.trim()
  if (model !== null && model.length > MAX_MODEL_LENGTH) return `${name} model too long`
  return { engine, model: model === '' ? null : model }
}

function parseAutoReview(raw: unknown): boolean | undefined | { error: string } {
  if (raw === undefined || typeof raw === 'boolean') return raw
  const flag = AUTO_REVIEW_FLAGS[raw as string]
  return flag === undefined ? { error: 'autoReview must be on/off/true/false' } : flag
}

export function parseRoles(body: unknown, engines: readonly string[] = ENGINE_NAMES): ParsedRoles {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const named = Object.keys(record).filter(key => !(ROLE_NAMES as readonly string[]).includes(key) && !FLAT_MODEL_KEYS.includes(key) && !RESERVED_ROLE_NAMES.includes(key))
    .filter(key => typeof record[key] === 'string' || (typeof record[key] === 'object' && record[key] !== null))
  const invalid = named.find(key => !isRoleName(key))
  if (invalid !== undefined) return { ok: false, error: `${invalid} is not a role name: use letters, digits, - and _` }
  if (ROLE_NAMES.length + named.length > MAX_ROLES) return { ok: false, error: `At most ${MAX_ROLES} roles` }
  const roles: Record<string, RoleAssignment> = {}
  for (const role of [...ROLE_NAMES, ...named]) {
    const parsed = parseAssignment(role, record[role], (ROLE_NAMES as readonly string[]).includes(role) ? record[`${role}_model`] : undefined, engines)
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    roles[role] = parsed
  }
  const autoReview = parseAutoReview(record.autoReview)
  if (typeof autoReview === 'object') return { ok: false, error: autoReview.error }
  let fallback: RoleAssignment | null | undefined
  if (record.fallback === null) fallback = null
  else if (record.fallback !== undefined) {
    const parsed = parseAssignment('fallback', record.fallback, undefined, engines)
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    fallback = parsed
  }
  return { ok: true, roles: roles as EngineRoles, ...(autoReview === undefined ? {} : { autoReview }), ...(fallback === undefined ? {} : { fallback }) }
}

export type RolesView = { plan: RoleAssignment; execute: RoleAssignment; review: RoleAssignment; autoReview: boolean; fallback: RoleAssignment | null } & Record<string, RoleAssignment | boolean | null>

function viewOf(config: AppConfig): RolesView {
  return { ...config.roles, autoReview: config.autoReview, fallback: config.fallback }
}

export async function readRoles(): Promise<EngineRoles> {
  return (await readConfig()).roles
}

export async function rolesView(): Promise<RolesView> {
  return viewOf(await readConfig())
}

export const rolesRoutes = new Elysia()
  .onBeforeHandle(requireLocal)
  .get('/api/roles', () => rolesView())
  .post('/api/roles', async ({ body, set }) => {
    const parsed = parseRoles(body, [...ENGINE_NAMES, ...(await createConnectionStore().list()).map(connection => connection.id)])
    if (!parsed.ok) {
      set.status = 400
      return { error: parsed.error }
    }
    const current = await readConfig()
    return viewOf(await writeConfig({
      roles: parsed.roles,
      autoReview: parsed.autoReview ?? current.autoReview,
      fallback: parsed.fallback === undefined ? current.fallback : parsed.fallback,
    }))
  })

export const flowApprovalRoutes = new Elysia()
  .onBeforeHandle(requireLocal)
  .get('/api/flow-approval', async () => ({ flowApproval: (await readConfig()).flowApproval }))
  .put('/api/flow-approval', async ({ body, set }) => {
    const value = (body as { flowApproval?: unknown } | null)?.flowApproval
    if (typeof value !== 'boolean') { set.status = 400; return { error: 'flowApproval must be true or false' } }
    return { flowApproval: (await writeConfig({ flowApproval: value })).flowApproval }
  })
