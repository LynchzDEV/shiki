import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Browser, Page } from 'playwright'

import { DUO_OPEN_QUERY, PHONE_TERMINAL_QUERY } from '../client/shared'
import { createApp } from '../server/index'
import { ShellPage } from '../server/views/shell'

const chromiumPath = process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)
const IPHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
const DUO_OPEN = { viewport: { width: 951, height: 669 }, hasTouch: true }

const findMarkup = /<div class="find" id="find" hidden>.*?<\/div>/.exec(ShellPage({ workspaceDir: '/work' }))![0]

type Box = { label: string; left: number; right: number; width: number; height: number }

function showTerminalBar(): void {
  const canvas = document.querySelector('.canvas') as HTMLElement
  canvas.dataset.live = 'true'
  document.body.dataset.live = 'true'
  document.getElementById('live')!.hidden = false
  for (const section of document.querySelectorAll<HTMLElement>('.stage > section')) section.hidden = true
  const template = document.getElementById('term-bar') as HTMLTemplateElement
  const host = Object.assign(document.createElement('div'), { className: 'term-host' })
  host.append(template.content.cloneNode(true))
  host.querySelector('.term-bar-name')!.textContent = `unbreakable-${'A'.repeat(120)}`
  document.getElementById('live-stage')!.replaceChildren(host)
}

function boxesOf(selector: string): Box[] {
  return [...document.querySelectorAll<HTMLElement>(selector)]
    .filter(element => element.getClientRects().length > 0)
    .map(element => {
      const box = element.getBoundingClientRect()
      return { label: element.getAttribute('aria-label') || element.textContent || element.id, left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width), height: Math.round(box.height) }
    })
}

describe.skipIf(chromiumPath === undefined)('touch layouts in Chromium', () => {
  let dir: string
  let server: ReturnType<Awaited<ReturnType<typeof createApp>>['listen']>
  let base: string
  let browser: Browser

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mc-touch-'))
    process.env.SKD_CONFIG_DIR = dir
    server = (await createApp()).listen({ hostname: '127.0.0.1', port: 0 })
    base = `http://127.0.0.1:${server.server?.port}`
    browser = await (await import('playwright')).chromium.launch({ headless: true, executablePath: chromiumPath })
  })

  afterAll(async () => {
    await browser?.close()
    server?.stop()
    delete process.env.SKD_CONFIG_DIR
    await rm(dir, { recursive: true, force: true })
  })

  async function open(device: typeof IPHONE | typeof DUO_OPEN): Promise<Page> {
    const page = await (await browser.newContext(device)).newPage()
    await page.goto(base, { waitUntil: 'load' })
    return page
  }

  test('on an iPhone the open Find bar keeps every control on screen at 44px', async () => {
    const page = await open(IPHONE)
    expect(await page.evaluate(query => matchMedia(query).matches, PHONE_TERMINAL_QUERY)).toBe(true)
    await page.evaluate(showTerminalBar)
    const closed = await page.evaluate(boxesOf, '#live .term-bar button')
    expect(closed.map(box => box.label)).toEqual(['Sessions', 'Connecting…', 'Find in this terminal', 'Keyboard', 'Attach files', 'Terminal actions'])
    for (const box of closed.filter(box => box.label !== 'Connecting…')) expect(box, box.label).toMatchObject({ width: 44, height: 44 })
    for (const box of closed) expect(box.right, box.label).toBeLessThanOrEqual(390)
    await page.evaluate(markup => { document.querySelector('#live .term-bar')!.insertAdjacentHTML('beforeend', markup.replace(' hidden>', '>')) }, findMarkup)
    const found = await page.evaluate(boxesOf, '#live .term-bar button, #live .find input')
    expect(found.map(box => box.label)).toEqual(['Find in this terminal', 'Previous match', 'Next match', 'Close find'])
    for (const box of found) expect(box.right, box.label).toBeLessThanOrEqual(390)
    for (const box of found.slice(1)) expect(box, box.label).toMatchObject({ width: 44, height: 44 })
    expect(found[0].width).toBeGreaterThan(80)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
    await page.context().close()
  }, 60000)

  test('on iPhone Duo open the Waiting panel, Agents and Flow open beside the 320px sessions list, never over it', async () => {
    const page = await open(DUO_OPEN)
    expect(await page.evaluate(query => matchMedia(query).matches, DUO_OPEN_QUERY)).toBe(true)
    expect(Math.round((await page.locator('#sidebar').boundingBox())!.width)).toBe(320)
    const overlays: Array<[string, string]> = [['#open-attention', '#attention'], ['#open-agents', '#agents'], ['#toggle-flow', '#flow']]
    for (const [button, overlay] of overlays) {
      await page.click(button)
      await page.waitForTimeout(400)
      const box = await page.locator(overlay).boundingBox()
      expect(box, overlay).not.toBeNull()
      expect(box!.width, overlay).toBeGreaterThan(0)
      expect(box!.x, overlay).toBeGreaterThanOrEqual(320)
      await page.click(button)
      await page.waitForTimeout(400)
    }
    await page.context().close()
  }, 60000)

  test('on an iPhone a workflow opens to the bigger-screen card, and Run this workflow opens the run dialog', async () => {
    const page = await open(IPHONE)
    await page.click('#phone-sessions')
    expect(await page.evaluate(() => [document.getElementById('sidebar')!.contains(document.activeElement), document.querySelector('.canvas')!.matches(':is([inert])')])).toEqual([true, true])
    await page.click('.sb-destinations [data-proxy="open-studio"]')
    await page.getByRole('button', { name: /Use the default/ }).click()
    await expect(page.getByRole('heading', { name: 'This needs a bigger screen' }).isVisible()).resolves.toBe(true)
    expect(await page.locator('.react-flow').count()).toBe(0)
    await page.getByRole('button', { name: 'Run this workflow' }).click()
    await expect(page.locator('dialog[open] #studio-dialog-title').textContent()).resolves.toBe('Run this workflow')
    await page.locator('dialog[open] [aria-label="Close dialog"]').click()
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page.getByRole('heading', { name: 'How should your team work?' }).isVisible()).resolves.toBe(true)
    await page.context().close()
  }, 60000)

  test('on an iPhone the composer paperclip opens the file picker and types the uploaded path into the message', async () => {
    const page = await open(IPHONE)
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#attach-files')])
    expect(chooser.isMultiple()).toBe(true)
    await chooser.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await page.waitForFunction(() => (document.getElementById('message') as HTMLTextAreaElement).value.includes('notes.txt'))
    expect(await page.locator('#toast').textContent()).toBe('Added 1 file')
    await page.context().close()
  }, 60000)

  test('on an iPhone the terminal paperclip opens the file picker and says when no terminal is ready for the files', async () => {
    const page = await open(IPHONE)
    await page.evaluate(showTerminalBar)
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#live [data-attach]')])
    expect(chooser.isMultiple()).toBe(true)
    await chooser.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await page.waitForFunction(() => document.getElementById('toast')?.textContent === 'Open a terminal first')
    await page.context().close()
  }, 60000)
})
