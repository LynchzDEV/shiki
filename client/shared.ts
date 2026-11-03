export type JsonRecord = Record<string, unknown>

export type ApiResult = {
  ok: boolean
  status: number
  data: JsonRecord
}

async function parse(response: Response): Promise<JsonRecord> {
  try {
    const parsed: unknown = await response.json()
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as JsonRecord
  } catch {
    return {}
  }
}

export async function getJson(url: string): Promise<ApiResult> {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    return { ok: response.ok, status: response.status, data: await parse(response) }
  } catch {
    return { ok: false, status: 0, data: {} }
  }
}

async function sendJson(method: 'POST' | 'PUT', url: string, body: JsonRecord): Promise<ApiResult> {
  try {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { ok: response.ok, status: response.status, data: await parse(response) }
  } catch {
    return { ok: false, status: 0, data: {} }
  }
}

export const postJson = (url: string, body: JsonRecord): Promise<ApiResult> => sendJson('POST', url, body)
export const putJson = (url: string, body: JsonRecord): Promise<ApiResult> => sendJson('PUT', url, body)

export function errorText(result: ApiResult): string {
  const message = result.data.error
  const misses = Array.isArray(result.data.misses) ? result.data.misses.filter((miss): miss is string => typeof miss === 'string') : []
  if (typeof message === 'string' && message !== '') return misses.length ? [message, ...misses.map(miss => `- ${miss}`)].join('\n') : message
  return result.status === 0 ? 'server unreachable' : `request failed (${result.status})`
}

export function streamJobLog(
  id: string,
  onLine: (line: string) => void,
  onEnd: () => void,
): EventSource {
  const stream = new EventSource(`/api/jobs/${id}/stream`)
  stream.onmessage = (event: MessageEvent) => onLine(String(event.data))
  stream.onerror = () => {
    onEnd()
    stream.close()
  }
  return stream
}

export function markFixture(source: string, on: boolean): void {
  document.querySelectorAll<HTMLElement>(`.fixture[data-src="${source}"]`).forEach((tag) => {
    tag.classList.toggle('on', on)
  })
}

export function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as JsonRecord
}

export function readArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is JsonRecord => readRecord(entry) === entry)
}

export type AnimeParams = Record<string, unknown>

export type Animation = { pause?: () => void; revert?: () => void }

export type Anime = {
  animate(targets: unknown, params: AnimeParams): Animation
  stagger(value: number, options?: Record<string, unknown>): unknown
}

export function anime(): Anime | null {
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return null
  const found = (window as unknown as { anime?: Anime }).anime
  return found !== undefined && typeof found.animate === 'function' ? found : null
}

export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function text(selector: string, value: string): void {
  const element = document.querySelector<HTMLElement>(selector)
  if (element !== null) element.textContent = value
}

export function shellQuote(path: string): string {
  if (/^[A-Za-z0-9_.\/~+=:@%,-]+$/.test(path)) return path
  return `'${path.replace(/'/g, "'\\''")}'`
}

const COPY_FLASH_MS = 1500

export function copyButton(text: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'text-button copy-button'
  button.insertAdjacentHTML('afterbegin', '<svg><use href="#file-icon"/></svg>')
  const label = document.createTextNode('Copy')
  button.append(label)
  let timer = 0
  const flash = (note: string): void => {
    label.data = note
    button.classList.add('copied')
    clearTimeout(timer)
    timer = window.setTimeout(() => { label.data = 'Copy'; button.classList.remove('copied') }, COPY_FLASH_MS)
  }
  button.onclick = () => {
    try {
      void navigator.clipboard.writeText(text).then(() => flash('Copied'), () => flash('Copy failed'))
    } catch {
      flash('Copy failed')
    }
  }
  return button
}

export function pathsFromUriList(text: string): string[] {
  const paths: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || !trimmed.startsWith('file://')) continue
    try {
      paths.push(decodeURIComponent(new URL(trimmed).pathname))
    } catch {
      continue
    }
  }
  return paths
}

export function providerName(engine: string): string {
  return ({claude:'Claude',codex:'Codex',glm:'GLM'} as Record<string,string>)[engine] ?? engine
}

export async function uploadDrop(file: File): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  form.append('lastModified', String(file.lastModified))
  const response = await fetch('/api/terminals/drops', { method: 'POST', body: form })
  const payload = (await response.json().catch(() => ({}))) as { error?: string; path?: string }
  if (!response.ok || typeof payload.path !== 'string') throw new Error(payload.error ?? `Upload failed (${response.status})`)
  return payload.path
}
