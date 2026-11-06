import { decodeFrames, fitSize, frameAt, PALETTES, petalCells, RAMP, sampleLevel, type BadAppleFrames } from '../../client/badapple-frames'
import type { Command, Context } from '../command'

const FRAMES_FILE = new URL('../../public/badapple.bin', import.meta.url)
const START = '\x1b[?25l\x1b[2J'
const HOME = '\x1b[H'
const RESET = '\x1b[0m'
const FINISH = `${RESET}\x1b[?25h\n`
const MISSING = 'Bad Apple frames are missing. Rebuild public/badapple.bin with: bun scripts/badapple.ts <video>\n'

const truecolor = (hex: string): string => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`
const COLORS = [...PALETTES.dark.levels, ...PALETTES.dark.petals].map(hex => hex === '' ? '' : truecolor(hex))

export function ansiFrame(video: BadAppleFrames, index: number, seconds: number, width: number, height: number, withPetals = true): string {
  const frame = frameAt(video, index)
  const glyphs: string[] = []
  const tones: number[] = []
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const level = sampleLevel(frame, video.cols, video.rows, width, height, x, y)
    glyphs.push(RAMP[level])
    tones.push(level)
  }
  if (withPetals) for (const petal of petalCells(seconds, width, height)) { glyphs[petal.row * width + petal.col] = petal.glyph; tones[petal.row * width + petal.col] = RAMP.length + petal.tone }
  const lines: string[] = []
  for (let y = 0; y < height; y++) {
    let line = ''
    let tone = -1
    for (let x = 0; x < width; x++) {
      const cell = y * width + x
      if (tones[cell] !== 0 && tones[cell] !== tone) { line += COLORS[tones[cell]]; tone = tones[cell] }
      line += glyphs[cell]
    }
    lines.push(line)
  }
  return HOME + lines.join('\n')
}

async function badApple(ctx: Context): Promise<number> {
  const bytes = await Bun.file(FRAMES_FILE).bytes().catch(() => null)
  if (bytes === null) { ctx.err(MISSING); return 1 }
  const video = decodeFrames(Bun.gunzipSync(bytes))
  const { width, height } = fitSize(video.cols, video.rows, process.stdout.columns ?? 80, process.stdout.rows ?? 24)
  let stopped = false
  const stop = (): void => { stopped = true }
  process.on('SIGINT', stop)
  ctx.out(START)
  const start = performance.now()
  let shown = -1
  try {
    for (;;) {
      const seconds = (performance.now() - start) / 1000
      const index = Math.floor(seconds * video.fps)
      if (stopped || index >= video.count) break
      if (index !== shown) ctx.out(ansiFrame(video, index, seconds, width, height))
      shown = index
      await Bun.sleep(Math.ceil(Math.max(0, start + ((index + 1) / video.fps) * 1000 - performance.now())))
    }
  } finally {
    process.off('SIGINT', stop)
    ctx.out(FINISH)
  }
  return 0
}

export const badAppleCommands: Command[] = [
  { path: ['badapple'], summary: 'Play Bad Apple!! as sakura ASCII art in this terminal (Ctrl-C stops it)', run: badApple },
]
