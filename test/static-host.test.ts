import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { publishDomain, staticHost } from '../static-host/serve'

const SUB = '86d3j4f8q-ab12cd34'
const OTHER = 'other-zz99yy88'
let dir: string
let server: Server
let port: number

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skd-static-'))
  const site = join(dir, 'published', SUB)
  await mkdir(join(site, 'assets'), { recursive: true })
  await mkdir(join(site, '.shikidan'))
  await mkdir(join(dir, 'published', OTHER))
  await writeFile(join(site, 'index.html'), '<h1>index</h1>')
  await writeFile(join(site, 'a.html'), '<h1>A</h1>')
  await writeFile(join(site, 'assets', 'app.css'), 'body{}')
  await writeFile(join(site, 'assets', 'logo.png'), 'png')
  await writeFile(join(site, '.shikidan', 'context.md'), 'private')
  await writeFile(join(dir, 'published', OTHER, 'secret.html'), 'other card')
  await writeFile(join(dir, 'outside.txt'), 'outside')
  await symlink(join(dir, 'outside.txt'), join(site, 'link.html'))
  await symlink(join(dir, 'published', OTHER), join(site, 'other'))
  server = staticHost({ dir: join(dir, 'published'), domain: 'shikidan.com' })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  port = (server.address() as { port: number }).port
})
afterAll(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

const get = (path: string, host = `${SUB}.shikidan.com`, method = 'GET') => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { host } })

async function raw(target: string, host = `${SUB}.shikidan.com`): Promise<number> {
  const chunks: string[] = []
  const closed = Promise.withResolvers<void>()
  const socket = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data(_socket, data) { chunks.push(data.toString()) }, close() { closed.resolve() }, error() { closed.resolve() } } })
  socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
  await closed.promise
  return Number(/^HTTP\/1\.1 (\d{3})/.exec(chunks.join(''))?.[1])
}

test('/ serves index.html with the content type and the no-index, no-referrer, no-store headers', async () => {
  const response = await get('/')
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('<h1>index</h1>')
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('cache-control')).toBe('no-store')
})

test('a variant page and its assets load, a query string is ignored, and the host may carry a port', async () => {
  expect(await (await get('/a.html')).text()).toBe('<h1>A</h1>')
  expect((await get('/assets/app.css?v=2')).headers.get('content-type')).toBe('text/css; charset=utf-8')
  expect((await get('/assets/logo.png')).headers.get('content-type')).toBe('image/png')
  expect((await get('/a.html', `${SUB.toUpperCase()}.Shikidan.com:7780`)).status).toBe(200)
})

test('HEAD answers like GET without a body', async () => {
  const response = await get('/a.html', undefined, 'HEAD')
  expect(response.status).toBe(200)
  expect(response.headers.get('content-length')).toBe('10')
  expect(await response.text()).toBe('')
})

test('every other method gets 404', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) expect((await get('/a.html', undefined, method)).status).toBe(404)
})

test('dot segments, plain or encoded, are 404 before any normalization', async () => {
  expect(await raw('/a.html')).toBe(200)
  expect(await raw('/../')).toBe(404)
  expect(await raw(`/../${OTHER}/secret.html`)).toBe(404)
  expect(await raw('/assets/../a.html')).toBe(404)
  expect(await raw('/./a.html')).toBe(404)
  expect(await raw('/%2e%2e/%2e%2e/outside.txt')).toBe(404)
  expect(await raw('/%2E%2E%2Foutside.txt')).toBe(404)
  expect(await raw('/assets%2F..%2Fa.html')).toBe(404)
})

test('dot folders, backslashes, NUL, double slashes and bad escapes are 404', async () => {
  expect((await get('/.shikidan/context.md')).status).toBe(404)
  expect((await get('/%2eshikidan/context.md')).status).toBe(404)
  expect((await get('/assets%5Capp.css')).status).toBe(404)
  expect((await get('/a.html%00')).status).toBe(404)
  expect(await raw('//a.html')).toBe(404)
  expect((await get('/%E0%A4%A')).status).toBe(404)
})

test('symlinks to a file or to another card are 404', async () => {
  expect((await get('/link.html')).status).toBe(404)
  expect((await get('/other/secret.html')).status).toBe(404)
})

test("one card's host never reaches another card's folder", async () => {
  expect((await get('/secret.html')).status).toBe(404)
  expect((await get('/secret.html', `${OTHER}.shikidan.com`)).status).toBe(200)
  expect((await get('/index.html', `${OTHER}.shikidan.com`)).status).toBe(404)
})

test('an unknown, malformed or foreign host is 404', async () => {
  expect((await get('/', 'nope-00000000.shikidan.com')).status).toBe(404)
  expect((await get('/', 'shikidan.com')).status).toBe(404)
  expect((await get('/', `${SUB}.evil.com`)).status).toBe(404)
  expect((await get('/', `a.${SUB}.shikidan.com`)).status).toBe(404)
  expect((await get('/', `${SUB}.shikidan.com.evil.com`)).status).toBe(404)
  expect((await get('/', '127.0.0.1')).status).toBe(404)
  expect(await raw('/', `..%2F.shikidan.com`)).toBe(404)
})

test('a directory is 404, and a 404 still carries the headers', async () => {
  const response = await get('/assets')
  expect(response.status).toBe(404)
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect((await get('/assets/')).status).toBe(404)
})

test('an absolute-form request target is 404', async () => {
  expect(await raw(`http://${OTHER}.shikidan.com/secret.html`)).toBe(404)
})

test('the domain is SKD_PUBLISH_DOMAIN, or shikidan.com when it is not set', () => {
  const saved = process.env.SKD_PUBLISH_DOMAIN
  try {
    delete process.env.SKD_PUBLISH_DOMAIN
    expect(publishDomain()).toBe('shikidan.com')
    process.env.SKD_PUBLISH_DOMAIN = 'mockups.example.com'
    expect(publishDomain()).toBe('mockups.example.com')
  } finally {
    if (saved === undefined) delete process.env.SKD_PUBLISH_DOMAIN
    else process.env.SKD_PUBLISH_DOMAIN = saved
  }
})
