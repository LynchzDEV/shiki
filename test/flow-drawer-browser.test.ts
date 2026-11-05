import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Browser, Page } from 'playwright'

import { createApp } from '../server/index'

const chromiumPath = process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)
const DRAWER_SETTLE_MS = 450

function leaveTerminalForQueue(): void {
  const canvas = document.querySelector('.canvas') as HTMLElement
  canvas.dataset.live = 'true'
  document.body.dataset.live = 'true'
  document.getElementById('live')!.hidden = false
  dispatchEvent(new CustomEvent('quiet:show', { detail: 'queue' }))
}

const drawerHeight = (): number => Math.round(document.getElementById('flow')!.getBoundingClientRect().height)
const watchRun = (): void => { dispatchEvent(new CustomEvent('quiet:flow-watch', { detail: { runId: 'run-under-test' } })) }

describe.skipIf(chromiumPath === undefined)('flow drawer after leaving a terminal', () => {
  let dir: string
  let server: ReturnType<Awaited<ReturnType<typeof createApp>>['listen']>
  let browser: Browser

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mc-flow-drawer-'))
    process.env.SKD_CONFIG_DIR = dir
    server = (await createApp()).listen({ hostname: '127.0.0.1', port: 0 })
    browser = await (await import('playwright')).chromium.launch({ headless: true, executablePath: chromiumPath })
  })

  afterAll(async () => {
    await browser?.close()
    server?.stop()
    delete process.env.SKD_CONFIG_DIR
    await rm(dir, { recursive: true, force: true })
  })

  async function queueAfterTerminal(): Promise<Page> {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    await page.goto(`http://127.0.0.1:${server.server?.port}`, { waitUntil: 'load' })
    await page.evaluate(leaveTerminalForQueue)
    return page
  }

  test('Watch opens the drawer', async () => {
    const page = await queueAfterTerminal()
    await page.evaluate(watchRun)
    await page.waitForTimeout(DRAWER_SETTLE_MS)
    expect(await page.evaluate(drawerHeight)).toBeGreaterThan(0)
    await page.context().close()
  })

  test('the Flow button opens the drawer', async () => {
    const page = await queueAfterTerminal()
    await page.click('#toggle-flow')
    await page.waitForTimeout(DRAWER_SETTLE_MS)
    expect(await page.evaluate(drawerHeight)).toBeGreaterThan(0)
    await page.context().close()
  })
})
