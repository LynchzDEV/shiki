import { decodeFrames, frameAt, PALETTES, petalCells, RAMP, TOP_LEVEL, type BadAppleFrames, type Palette } from './badapple-frames'

export { isBadApple } from './badapple-frames'

const FONT_SIZE = 12
const LINE_HEIGHT = 15
const FONT = `${FONT_SIZE}px "JetBrains Mono", Menlo, monospace`
const THINK_MS = 700
const TYPE_MS = 22
const GROW_MS = 260
const STORM_MS = 1400
const STORM_PARTICLES = 700
const STORM_GLYPHS = "*@%&*'`,.+*"
const STORM_SIZES = [14, 19, 26]
const PETAL_LAYER = RAMP.length
const PAUSED_KEY = 'skd.motion.paused'
const INTRO = 'Bad Apple!!, drawn in sakura. Press Esc or click it to stop.'
const OUTRO = 'fin.'
const MISSING = 'I could not load the frames. Rebuild public/badapple.bin with: bun scripts/badapple.ts <video>'

type Particle = { y: number; offset: number; scale: number; wobble: number; phase: number; size: number; glyph: string; tone: number }

let frames: Promise<BadAppleFrames> | null = null
let font: Promise<unknown> | null = null

function loadFrames(): Promise<BadAppleFrames> {
  frames ??= fetch('/badapple.bin').then(async (response) => {
    if (!response.ok || !response.body) throw new Error(`frames ${response.status}`)
    return decodeFrames(new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()))
  }).catch((error: unknown) => { frames = null; throw error })
  return frames
}

function loadFont(): Promise<unknown> {
  font ??= new FontFace('JetBrains Mono', 'url(/fonts/JetBrainsMono-Regular.woff2)').load().then(face => document.fonts.add(face)).catch(() => undefined)
  return font
}

function reducedMotion(): boolean {
  try { const stored = localStorage.getItem(PAUSED_KEY); if (stored !== null) return stored === 'true' } catch {}
  return matchMedia('(prefers-reduced-motion: reduce)').matches
}

const palette = (): Palette => PALETTES[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light']
const ease = (u: number): number => u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
const gauss = (): number => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) })
}

async function typeText(target: HTMLElement, text: string, signal: AbortSignal): Promise<void> {
  for (const char of text) {
    if (signal.aborted) return
    target.textContent += char
    await sleep(TYPE_MS, signal)
  }
}

function typedLine(body: HTMLElement): HTMLElement {
  const md = document.createElement('div')
  md.className = 'md'
  const line = document.createElement('p')
  md.append(line)
  body.append(md)
  return line
}

async function grow(wrap: HTMLElement, open: boolean): Promise<void> {
  if (reducedMotion()) return
  const height = `${wrap.scrollHeight}px`
  await wrap.animate([{ height: open ? '0px' : height, opacity: open ? 0 : 1 }, { height: open ? height : '0px', opacity: open ? 1 : 0 }], { duration: GROW_MS, easing: 'ease-out' }).finished.catch(() => undefined)
}

function particles(height: number, width: number): Particle[] {
  return Array.from({ length: STORM_PARTICLES }, () => {
    const roll = Math.random()
    return { y: Math.random() * (height + 40) - 20, offset: gauss() * width * (Math.random() < 0.8 ? 0.06 : 0.16), scale: 0.85 + Math.random() * 0.5, wobble: 6 + Math.random() * 24, phase: Math.random() * Math.PI * 2, size: roll < 0.55 ? 0 : roll < 0.85 ? 1 : 2, glyph: STORM_GLYPHS[Math.floor(Math.random() * STORM_GLYPHS.length)], tone: Math.floor(Math.random() * 4) }
  })
}

function drawStorm(ctx: CanvasRenderingContext2D, storm: Particle[], u: number, front: number, width: number, colors: Palette): void {
  const envelope = Math.min(1, u / 0.08, (1 - u) / 0.12)
  const tones = [colors.levels[TOP_LEVEL], ...colors.petals]
  ctx.textBaseline = 'middle'
  for (const particle of storm) {
    ctx.font = `700 ${STORM_SIZES[particle.size]}px "JetBrains Mono", Menlo, monospace`
    ctx.globalAlpha = Math.min(1, 0.35 + 0.9 * Math.exp(-((particle.offset / (width * 0.12)) ** 2))) * envelope
    ctx.fillStyle = tones[particle.tone]
    ctx.fillText(particle.glyph, front + particle.offset * particle.scale + Math.sin(u * 14 + particle.phase) * particle.wobble, particle.y + Math.sin(u * 9 + particle.phase) * 12 + (u - 0.5) * 35 * particle.scale)
  }
  ctx.globalAlpha = 1
}

function drawFrame(ctx: CanvasRenderingContext2D, video: BadAppleFrames, index: number, seconds: number, visible: (col: number) => boolean, petals: boolean, colors: Palette): void {
  const { cols, rows } = video
  const frame = frameAt(video, index)
  const dark = colors === PALETTES.dark
  const glyphs = new Array<string>(cols * rows).fill(' ')
  const layers = new Uint8Array(cols * rows)
  for (let cell = 0; cell < cols * rows; cell++) {
    if (!visible(cell % cols)) continue
    const level = dark ? frame[cell] : TOP_LEVEL - frame[cell]
    glyphs[cell] = RAMP[level]
    layers[cell] = level
  }
  if (petals) for (const petal of petalCells(seconds, cols, rows)) { const cell = petal.row * cols + petal.col; glyphs[cell] = petal.glyph; layers[cell] = PETAL_LAYER + petal.tone }
  const fills = [...colors.levels, ...colors.petals]
  ctx.font = FONT
  ctx.textBaseline = 'top'
  for (let layer = 1; layer < fills.length; layer++) {
    ctx.fillStyle = fills[layer]
    for (let row = 0; row < rows; row++) {
      let text = ''
      let any = false
      for (let col = 0; col < cols; col++) { const cell = row * cols + col; const on = layers[cell] === layer; text += on ? glyphs[cell] : ' '; any ||= on }
      if (any) ctx.fillText(text, 0, row * LINE_HEIGHT)
    }
  }
}

function play(canvas: HTMLCanvasElement, video: BadAppleFrames, cellWidth: number, signal: AbortSignal): Promise<void> {
  const ctx = canvas.getContext('2d')!
  const reduced = reducedMotion()
  const width = video.cols * cellWidth, height = video.rows * LINE_HEIGHT
  const dpr = canvas.width / width
  const storm = particles(height, width)
  const frontAt = (u: number): number => -0.22 * width + ease(u) * 1.44 * width
  const start = performance.now()
  const end = start + (video.count / video.fps) * 1000
  let stopAt: number | null = null
  const stop = (): void => { stopAt ??= performance.now() }
  const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') stop() }
  return new Promise(resolve => {
    let raf = 0
    const finish = (): void => { cancelAnimationFrame(raf); removeEventListener('keydown', onKey); canvas.removeEventListener('click', stop); resolve() }
    addEventListener('keydown', onKey)
    canvas.addEventListener('click', stop)
    const tick = (now: number): void => {
      if (signal.aborted || !canvas.isConnected) { finish(); return }
      if (stopAt === null && now >= end) stopAt = now
      const outU = stopAt === null ? 0 : reduced ? 1 : (now - stopAt) / STORM_MS
      if (outU >= 1) { finish(); return }
      const inU = reduced ? 1 : Math.min(1, (now - start) / STORM_MS)
      const shown = Math.min(now, stopAt ?? now) - start
      const index = Math.min(video.count - 1, Math.floor((shown / 1000) * video.fps))
      const front = stopAt === null ? frontAt(inU) : frontAt(outU)
      const visible = stopAt !== null ? (col: number) => col * cellWidth > front : inU < 1 ? (col: number) => col * cellWidth < front : () => true
      const colors = palette()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      drawFrame(ctx, video, index, shown / 1000, visible, !reduced, colors)
      if (!reduced && (inU < 1 || stopAt !== null)) drawStorm(ctx, storm, stopAt === null ? inU : outU, front, width, colors)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  })
}

function stage(video: BadAppleFrames): { wrap: HTMLElement; canvas: HTMLCanvasElement; cellWidth: number } {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  ctx.font = FONT
  const cellWidth = ctx.measureText('M').width
  const dpr = Math.min(2, devicePixelRatio || 1)
  canvas.width = Math.round(video.cols * cellWidth * dpr)
  canvas.height = Math.round(video.rows * LINE_HEIGHT * dpr)
  canvas.style.maxWidth = `${Math.ceil(video.cols * cellWidth)}px`
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'Bad Apple!! playing as sakura ASCII art')
  const wrap = document.createElement('div')
  wrap.className = 'badapple'
  wrap.append(canvas)
  return { wrap, canvas, cellWidth }
}

export async function playBadApple(body: HTMLElement, signal: AbortSignal, onGrow: () => void): Promise<void> {
  const loading = loadFrames()
  void loadFont()
  const thinking = document.createElement('p')
  thinking.className = 'activity-line'
  thinking.dataset.running = 'true'
  thinking.textContent = 'Thinking'
  body.append(thinking)
  await sleep(THINK_MS, signal)
  thinking.remove()
  if (signal.aborted) return
  const line = typedLine(body)
  let video: BadAppleFrames
  try { video = await loading } catch { await typeText(line, MISSING, signal); return }
  await typeText(line, INTRO, signal)
  await loadFont()
  if (signal.aborted) return
  const { wrap, canvas, cellWidth } = stage(video)
  body.append(wrap)
  await grow(wrap, true)
  onGrow()
  await play(canvas, video, cellWidth, signal)
  if (signal.aborted) return
  await grow(wrap, false)
  wrap.remove()
  await typeText(typedLine(body), OUTRO, signal)
}
