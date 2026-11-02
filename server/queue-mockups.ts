import { lstat, realpath } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2',
}
const HEADERS = { 'Content-Security-Policy': 'sandbox allow-scripts', 'X-Content-Type-Options': 'nosniff' }

async function insideFile(worktree: string, requested: string): Promise<string | null> {
  let segments: string[]
  try { segments = requested.split('/').map(decodeURIComponent) } catch { return null }
  if (segments.some(part => part === '' || part.startsWith('.') || part.includes('\0') || part.includes('\\') || part.includes('/'))) return null
  const root = join(worktree, 'visualizer')
  if ((await lstat(root)).isSymbolicLink()) return null
  const realRoot = await realpath(root)
  let current = realRoot
  for (const part of segments) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) return null
  }
  const real = await realpath(current)
  return real.startsWith(realRoot + sep) && (await lstat(real)).isFile() ? real : null
}

export async function mockupResponse(worktree: string | null, requested: string): Promise<Response> {
  const found = worktree === null ? null : await insideFile(worktree, requested).catch(() => null)
  if (found === null) return new Response('Not found', { status: 404, headers: HEADERS })
  return new Response(Bun.file(found), { headers: { ...HEADERS, 'Content-Type': TYPES[extname(found).toLowerCase()] ?? 'application/octet-stream' } })
}
