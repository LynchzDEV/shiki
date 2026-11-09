import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { extname, join, sep } from 'node:path'

export type StaticHostOptions = { dir: string; domain: string }

const SUB = /^[a-z0-9-]{1,80}$/

export const publishDomain = (): string => process.env.SKD_PUBLISH_DOMAIN || 'shikidan.com'
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
}
const HEADERS = { 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

function subOf(host: string | undefined, domain: string): string | null {
  const name = (host ?? '').toLowerCase().replace(/:\d+$/, '')
  const suffix = `.${domain}`
  if (!name.endsWith(suffix)) return null
  const sub = name.slice(0, -suffix.length)
  return SUB.test(sub) ? sub : null
}

function segmentsOf(target: string): string[] | null {
  const path = target.split(/[?#]/)[0]!
  if (!path.startsWith('/')) return null
  let decoded: string
  try { decoded = decodeURIComponent(path) } catch { return null }
  if (decoded.includes('\\') || decoded.includes('\0')) return null
  if (decoded === '/') return ['index.html']
  const segments = decoded.slice(1).split('/')
  return segments.some(part => part === '' || part.startsWith('.')) ? null : segments
}

async function fileFor(options: StaticHostOptions, sub: string, segments: string[]): Promise<string | null> {
  const root = join(options.dir, sub)
  if ((await lstat(root)).isSymbolicLink()) return null
  let current = root
  for (const part of segments) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) return null
  }
  const [realRoot, real] = await Promise.all([realpath(root), realpath(current)])
  if (!real.startsWith(realRoot + sep)) return null
  return (await lstat(real)).isFile() ? real : null
}

async function found(options: StaticHostOptions, request: IncomingMessage): Promise<string | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const sub = subOf(request.headers.host, options.domain)
  const segments = segmentsOf(request.url ?? '')
  if (sub === null || segments === null) return null
  return fileFor(options, sub, segments).catch(() => null)
}

async function answer(options: StaticHostOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = await found(options, request)
  if (path === null) {
    response.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
    return
  }
  const { size } = await lstat(path)
  response.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': size })
  if (request.method === 'HEAD') { response.end(); return }
  createReadStream(path).on('error', () => response.destroy()).pipe(response)
}

export function staticHost(options: StaticHostOptions): Server {
  const settled = { ...options, domain: options.domain.toLowerCase() }
  return createServer((request, response) => {
    answer(settled, request, response).catch(() => { if (!response.headersSent) response.writeHead(404, HEADERS); response.end() })
  })
}

if (import.meta.main) {
  const dir = process.env.SKD_PUBLISH_DIR || join(homedir(), '.config', 'shikidan', 'published')
  const port = Number.parseInt(process.env.SKD_STATIC_PORT ?? '', 10) || 7780
  const domain = publishDomain()
  staticHost({ dir, domain }).listen(port, '127.0.0.1', () => console.log(`static host serving ${dir} for *.${domain} on http://127.0.0.1:${port}`))
}
