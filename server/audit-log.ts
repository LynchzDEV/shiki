import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { logSecrets, redactAll } from './log-redaction'
import { configDir } from './secrets'

export const SETTINGS_AUDIT = '_settings'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const lanes = new Map<string, Promise<unknown>>()

export const auditDirOf = (): string => join(configDir(), 'queue-audit')

export function redacted(value: unknown, secrets: ReadonlyArray<string | null>): unknown {
  if (typeof value === 'string') return redactAll(value, secrets)
  if (Array.isArray(value)) return value.map(entry => redacted(entry, secrets))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redacted(entry, secrets)]))
  return value
}

export async function auditLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(line => line !== '')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function appendAuditLine(path: string, entry: Record<string, unknown>, secrets: ReadonlyArray<string | null>, at: number): Promise<void> {
  const work = (lanes.get(path) ?? Promise.resolve()).then(async () => {
    const last = (await auditLines(path)).at(-1)
    const line = { at, ...(redacted(entry, secrets) as Record<string, unknown>), prev: last === undefined ? '' : sha256(last) }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await appendFile(path, `${JSON.stringify(line)}\n`, { mode: 0o600 })
  })
  const settled = work.catch(() => {})
  lanes.set(path, settled)
  void settled.then(() => { if (lanes.get(path) === settled) lanes.delete(path) })
  return work
}

export type SettingsChange = { actor: string; action: string; why: string; params: unknown; result: 'ok' | 'refused'; error?: string }

export async function auditSettings(change: SettingsChange): Promise<void> {
  await appendAuditLine(join(auditDirOf(), `${SETTINGS_AUDIT}.jsonl`), change, await logSecrets(), Date.now())
}
