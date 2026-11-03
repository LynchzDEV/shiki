import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readEnv } from './env'

export const DIR_MODE = 0o700
export const FILE_MODE = 0o600

export const DEFAULT_ZAI_BASE_URL = 'https://api.z.ai/api/anthropic'

export const SECRETS_FILE = 'secrets.json'
export const CONFIG_FILE = 'config.json'

export const API_TOKEN_PREFIX = 'mct_'

export type Secrets = {
  zaiAuthToken: string | null
  zaiBaseUrl: string
  apiToken: string | null
}

export type RoleAssignment = { engine: string; model: string | null }

export type EngineRoles = { plan: RoleAssignment; execute: RoleAssignment; review: RoleAssignment } & Record<string, RoleAssignment>

const ROLE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
export const MAX_ROLES = 24
export const RESERVED_ROLE_NAMES: readonly string[] = ['autoReview', 'fallback', 'plan_model', 'execute_model', 'review_model']

export function isRoleName(name: string): boolean {
  return ROLE_NAME.test(name) && !RESERVED_ROLE_NAMES.includes(name)
}

export const DEFAULT_ROLES: EngineRoles = {
  plan: { engine: 'claude', model: null },
  execute: { engine: 'glm', model: null },
  review: { engine: 'codex', model: null },
}

export const DEFAULT_FALLBACK: RoleAssignment = { engine: 'claude', model: null }

export type MarketplaceRef = { url: string }

export type AppConfig = {
  roles: EngineRoles
  fallback: RoleAssignment | null
  autoReview: boolean
  chatHome: string | null
  flowApproval: boolean
  marketplaces: MarketplaceRef[]
  queueParallel: number
}

export type PublicSecretsView = {
  zaiBaseUrl: string
  zaiAuthTokenConfigured: boolean
  apiTokenConfigured: boolean
}

export type BindTarget = { hostname: '127.0.0.1'; port: number }

export function listenTarget(): BindTarget {
  const port = Number.parseInt(readEnv('PORT') ?? '', 10)
  return { hostname: '127.0.0.1', port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7777 }
}

export function mcUrl(): string {
  const target = listenTarget()
  return `http://${target.hostname}:${target.port}`
}

export function configDir(): string {
  const override = readEnv('CONFIG_DIR')
  if (override !== undefined) return override
  return join(homedir(), '.config', CONFIG_DIR_NAME)
}

export const CONFIG_DIR_NAME = 'shikidan'
// ponytail: legacy ~/.config/mission-control, drop the move and its symlink once every install runs Shikidan
export const LEGACY_CONFIG_DIR_NAME = 'mission-control'

export async function migrateConfigDir(home = homedir()): Promise<'none' | 'migrated'> {
  const target = join(home, '.config', CONFIG_DIR_NAME)
  const legacy = join(home, '.config', LEGACY_CONFIG_DIR_NAME)
  if (await lstat(target).catch(() => null) !== null) return 'none'
  const found = await lstat(legacy).catch(() => null)
  if (found === null || !found.isDirectory()) return 'none'
  await rename(legacy, target)
  await symlink(target, legacy, 'dir')
  return 'migrated'
}

export function configPath(file: string): string {
  return join(configDir(), file)
}

export async function ensureConfigDir(): Promise<string> {
  const dir = configDir()
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  await chmod(dir, DIR_MODE)
  return dir
}

export async function readJsonFile(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configPath(file), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await ensureConfigDir()
  const path = configPath(file)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE })
  await chmod(path, FILE_MODE)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

export async function readSecrets(): Promise<Secrets> {
  const raw = await readJsonFile(SECRETS_FILE)
  return {
    zaiAuthToken: asString(raw.zaiAuthToken),
    zaiBaseUrl: asString(raw.zaiBaseUrl) ?? DEFAULT_ZAI_BASE_URL,
    apiToken: asString(raw.apiToken),
  }
}

export async function writeSecrets(patch: Partial<Secrets>): Promise<Secrets> {
  const merged: Secrets = { ...(await readSecrets()), ...patch }
  await writeJsonFile(SECRETS_FILE, merged)
  return merged
}

function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`
}

export async function readApiToken(): Promise<string> {
  const existing = (await readSecrets()).apiToken
  if (existing !== null) return existing
  const generated = generateApiToken()
  await writeSecrets({ apiToken: generated })
  return generated
}

export async function rotateApiToken(): Promise<string> {
  const generated = generateApiToken()
  await writeSecrets({ apiToken: generated })
  return generated
}

function readRoleAssignment(value: unknown, fallback: RoleAssignment): RoleAssignment {
  if (typeof value === 'string') return value === '' ? fallback : { engine: value, model: null }
  if (typeof value !== 'object' || value === null) return fallback
  const record = value as Record<string, unknown>
  const engine = asString(record.engine)
  if (engine === null) return fallback
  return { engine, model: asString(record.model) }
}

function readExtraRoles(record: Record<string, unknown>): Record<string, RoleAssignment> {
  const extras = Object.entries(record).filter(([name]) => !Object.hasOwn(DEFAULT_ROLES, name) && isRoleName(name)).slice(0, MAX_ROLES - 3)
  return Object.fromEntries(extras.flatMap(([name, value]) => {
    const role = readRoleAssignment(value, { engine: '', model: null })
    return role.engine === '' ? [] : [[name, role]]
  }))
}

function readRoles(raw: unknown): EngineRoles {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    ...readExtraRoles(record),
    plan: readRoleAssignment(record.plan, DEFAULT_ROLES.plan),
    execute: readRoleAssignment(record.execute, DEFAULT_ROLES.execute),
    review: readRoleAssignment(record.review, DEFAULT_ROLES.review),
  }
}

function readMarketplaces(raw: unknown): MarketplaceRef[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(entry => {
    const url = typeof entry === 'object' && entry !== null ? asString((entry as Record<string, unknown>).url) : null
    return url === null ? [] : [{ url }]
  })
}

export const MAX_QUEUE_PARALLEL = 4

const readQueueParallel = (raw: unknown): number => (Number.isInteger(raw) ? Math.min(Math.max(raw as number, 1), MAX_QUEUE_PARALLEL) : 1)

export async function readConfig(): Promise<AppConfig> {
  const raw = await readJsonFile(CONFIG_FILE)
  return {
    roles: readRoles(raw.roles),
    fallback: raw.fallback === null ? null : readRoleAssignment(raw.fallback, DEFAULT_FALLBACK),
    autoReview: raw.autoReview === true,
    chatHome: asString(raw.chatHome),
    flowApproval: raw.flowApproval !== false,
    marketplaces: readMarketplaces(raw.marketplaces),
    queueParallel: readQueueParallel(raw.queueParallel),
  }
}

export async function writeConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const merged: AppConfig = { ...(await readConfig()), ...patch }
  await writeJsonFile(CONFIG_FILE, merged)
  return merged
}

export function publicView(secrets: Secrets): PublicSecretsView {
  return {
    zaiBaseUrl: secrets.zaiBaseUrl,
    zaiAuthTokenConfigured: typeof secrets.zaiAuthToken === 'string' && secrets.zaiAuthToken !== '',
    apiTokenConfigured: typeof secrets.apiToken === 'string' && secrets.apiToken !== '',
  }
}
