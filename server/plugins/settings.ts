import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { DIR_MODE, configDir, readJsonFile, writeJsonFile } from '../secrets'
import { PluginBusyError, withPluginLock } from './locks'
import { getInstalled } from './store'
import type { SettingField } from './manifest'

export const SETTINGS_DIR = 'plugin-settings'

const SERVER_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/
const MAX_SETTING_BYTES = 1048576

export type SettingsView = {
  fields: SettingField[]
  values: Record<string, string>
  configured: Record<string, boolean>
}

export type SettingsResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

type SettingValues = Record<string, string>

function prototypeSafeValues(): SettingValues {
  return Object.create(null)
}

function copySettings(values: SettingValues): SettingValues {
  return Object.assign(prototypeSafeValues(), values)
}

export function settingsFile(id: string): string {
  return join(SETTINGS_DIR, `${id}.json`)
}

async function readSettings(id: string): Promise<SettingValues> {
  const raw = await readJsonFile(settingsFile(id))
  const values = prototypeSafeValues()
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') values[key] = value
  }
  return values
}

async function writeSettings(id: string, values: Record<string, string>): Promise<void> {
  await mkdir(join(configDir(), SETTINGS_DIR), { recursive: true, mode: DIR_MODE })
  await writeJsonFile(settingsFile(id), values)
}

function viewOf(fields: SettingField[], values: SettingValues): SettingsView {
  const secretKeys = new Set(fields.filter(field => field.type === 'secret').map(field => field.key))
  const safeValues = prototypeSafeValues()
  const configured: Record<string, boolean> = Object.create(null)
  for (const field of fields) {
    const value = values[field.key]
    configured[field.key] = typeof value === 'string' && value !== ''
    if (field.type !== 'secret' && !secretKeys.has(field.key) && typeof value === 'string') safeValues[field.key] = value
  }
  return { fields, values: safeValues, configured }
}

export async function settingsView(id: string): Promise<SettingsResult<SettingsView>> {
  const installed = await getInstalled(id)
  if (installed === null) return { ok: false, status: 404, error: 'That plugin is not installed' }
  return { ok: true, value: viewOf(installed.settingsFields ?? [], await readSettings(id)) }
}

export async function setSetting(id: string, key: string, value: string | null): Promise<SettingsResult<SettingsView>> {
  const installed = await getInstalled(id)
  if (installed === null) return { ok: false, status: 404, error: 'That plugin is not installed' }
  const declared = (installed.settingsFields ?? []).find(field => field.key === key)
  if (declared === undefined) return { ok: false, status: 400, error: `Unknown setting: ${key}` }
  if (declared.type === 'toggle' && value !== null && value !== 'true' && value !== 'false') return { ok: false, status: 400, error: `${declared.label} takes true or false` }
  try {
    return await withPluginLock(id, async () => {
      const current = await readSettings(id)
      const next = copySettings(current)
      if (value === null) delete next[key]
      else next[key] = value
      await writeSettings(id, next)
      return { ok: true as const, value: viewOf(installed.settingsFields ?? [], next) }
    })
  } catch (error) {
    if (error instanceof PluginBusyError) return { ok: false, status: 409, error: error.message }
    throw error
  }
}

export async function getSetting(id: string, key: string): Promise<string | null> {
  return (await readSettings(id))[key] ?? null
}

export async function setServerSetting(id: string, key: string, value: string | null): Promise<void> {
  if (!SERVER_KEY_PATTERN.test(key)) throw new Error(`Invalid setting key: ${key}`)
  if (value !== null && Buffer.byteLength(value) > MAX_SETTING_BYTES) throw new Error('That setting is too large')
  return withPluginLock(id, async () => {
    const current = await readSettings(id)
    const next = copySettings(current)
    if (value === null) delete next[key]
    else next[key] = value
    await writeSettings(id, next)
  })
}
