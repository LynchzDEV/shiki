import { MIN_REDACTED_SECRET_LENGTH, createLogRedactor, readLogFile, readLogTail } from './jobs'
import type { LogRedactor } from './jobs'
import { readSecrets } from './secrets'

export const LOG_TAIL_READ_BYTES = 65_536
const ELLIPSIS = '…'
const REDACTED = '[REDACTED]'

export async function logSecrets(): Promise<Array<string | null>> {
  const secrets = await readSecrets()
  return [secrets.zaiAuthToken, secrets.apiToken, secrets.notifyWebhookKey]
}

export function createSecretsRedactor(secrets: ReadonlyArray<string | null>): LogRedactor {
  const redactors = secrets.map((secret) => createLogRedactor(secret))
  return {
    redact: (chunk) => redactors.reduce((text, redactor) => redactor.redact(text), chunk),
    flush: () => redactors.reduce((text, redactor) => redactor.redact(text) + redactor.flush(), ''),
  }
}

export function redactAll(content: string, secrets: ReadonlyArray<string | null>): string {
  const redactor = createSecretsRedactor(secrets)
  return redactor.redact(content) + redactor.flush()
}

// Job logs are written raw by the child process, so every serving path redacts on read.
export async function readRedactedLog(path: string): Promise<string> {
  return redactAll(await readLogFile(path), await logSecrets())
}

export async function redactedTailReader(bytes = LOG_TAIL_READ_BYTES): Promise<(path: string) => Promise<string>> {
  const secrets = await logSecrets()
  return async (path) => redactAll((await readLogTail(path, bytes)).content, secrets)
}

function clippedSecretPrefix(line: string, secret: string): number {
  for (let length = Math.min(secret.length - 1, line.length); length >= MIN_REDACTED_SECRET_LENGTH; length -= 1) {
    if (line.endsWith(secret.slice(0, length))) return length
  }
  return 0
}

export function redactLine(line: string, secrets: ReadonlyArray<string | null>): string {
  const full = redactAll(line, secrets)
  if (!full.endsWith(ELLIPSIS)) return full
  const body = full.slice(0, -ELLIPSIS.length)
  for (const secret of secrets) {
    if (secret === null || secret.length < MIN_REDACTED_SECRET_LENGTH) continue
    const clipped = clippedSecretPrefix(body, secret)
    if (clipped > 0) return `${body.slice(0, body.length - clipped)}${REDACTED}${ELLIPSIS}`
  }
  return full
}

export async function activityRedactor(): Promise<(line: string | null) => string | null> {
  const secrets = await logSecrets()
  return (line) => (line === null ? null : redactLine(line, secrets))
}
