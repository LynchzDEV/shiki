export const RAMP = ' .:+*o%@'
export const TOP_LEVEL = RAMP.length - 1

const MAGIC = 'BAPL'
const HEADER_BYTES = 13
const PETAL_GLYPHS = ['*', "'", '`', ',', '*']
const PETAL_COUNT = 24
const PETAL_LOOP_SECONDS = 9
const PETAL_SEED = 1337

export type BadAppleFrames = { cols: number; rows: number; fps: number; count: number; cells: Uint8Array }
export type PetalCell = { col: number; row: number; glyph: string; tone: number }
export type Palette = { levels: readonly string[]; petals: readonly string[] }

const DARK = { sakura1: '#f7cad7', sakura2: '#eea0b6', sakura3: '#c08ad6', bark: '#a7868e', line: '#4a5163', accent: '#a58be2' }
const LIGHT = { sakura1: '#f2b9cc', sakura2: '#e48fad', sakura3: '#a8649f', bark: '#9a737b', line: '#b9c2d3', accent: '#8062bd' }

export const PALETTES: Record<'dark' | 'light', Palette> = {
  dark: { levels: ['', DARK.line, DARK.bark, DARK.sakura3, DARK.sakura3, DARK.sakura2, DARK.sakura2, DARK.sakura1], petals: [DARK.sakura2, DARK.sakura3, DARK.accent] },
  light: { levels: ['', LIGHT.line, LIGHT.bark, LIGHT.sakura1, LIGHT.sakura1, LIGHT.sakura2, LIGHT.sakura2, LIGHT.sakura3], petals: [LIGHT.sakura2, LIGHT.sakura3, LIGHT.accent] },
}

export function isBadApple(prompt: string): boolean {
  return prompt.trim().toLowerCase() === 'badapple'
}

export function quantize(gray: number): number {
  return Math.round((gray / 255) * TOP_LEVEL)
}

export function encodeFrames({ cols, rows, fps, count, cells }: BadAppleFrames): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + cells.length)
  const view = new DataView(out.buffer)
  out.set(new TextEncoder().encode(MAGIC))
  view.setUint16(4, cols, true)
  view.setUint16(6, rows, true)
  view.setUint8(8, fps)
  view.setUint32(9, count, true)
  const size = cols * rows
  for (let i = 0; i < cells.length; i++) out[HEADER_BYTES + i] = i < size ? cells[i] : cells[i] ^ cells[i - size]
  return out
}

export function decodeFrames(bytes: Uint8Array): BadAppleFrames {
  if (bytes.length < HEADER_BYTES || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) throw new Error('not a Bad Apple frame file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const cols = view.getUint16(4, true), rows = view.getUint16(6, true), fps = view.getUint8(8), count = view.getUint32(9, true)
  const size = cols * rows
  if (bytes.length < HEADER_BYTES + size * count) throw new Error('frame file is truncated')
  const cells = bytes.slice(HEADER_BYTES, HEADER_BYTES + size * count)
  for (let i = size; i < cells.length; i++) cells[i] ^= cells[i - size]
  return { cols, rows, fps, count, cells }
}

export function frameAt(frames: BadAppleFrames, index: number): Uint8Array {
  const size = frames.cols * frames.rows
  return frames.cells.subarray(index * size, (index + 1) * size)
}

export function fitSize(cols: number, rows: number, termCols: number, termRows: number): { width: number; height: number } {
  const scale = Math.min(1, termCols / cols, (termRows - 1) / rows)
  return { width: Math.max(1, Math.floor(cols * scale)), height: Math.max(1, Math.floor(rows * scale)) }
}

export function sampleLevel(frame: Uint8Array, cols: number, rows: number, width: number, height: number, x: number, y: number): number {
  return frame[Math.floor((y * rows) / height) * cols + Math.floor((x * cols) / width)]
}

function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Petal = { x: number; y: number; phase: number; dx: number; dy: number; wobble: number; waves: number; flutter: number; tone: number }

function makePetals(): Petal[] {
  const random = seeded(PETAL_SEED)
  return Array.from({ length: PETAL_COUNT }, () => ({
    x: random() * 1.1 - 0.15,
    y: random() * 0.4 - 0.15,
    phase: random(),
    dx: 0.15 + random() * 0.4,
    dy: 0.35 + random() * 0.6,
    wobble: 1 + random() * 2,
    waves: 1 + Math.floor(random() * 3),
    flutter: 3 + Math.floor(random() * 4),
    tone: random() < 0.55 ? 0 : random() < 0.6 ? 1 : 2,
  }))
}

const PETALS = makePetals()

export function petalCells(seconds: number, cols: number, rows: number): PetalCell[] {
  const cells: PetalCell[] = []
  for (const petal of PETALS) {
    const u = (seconds / PETAL_LOOP_SECONDS + petal.phase) % 1
    if (u < 0.04 || u > 0.95) continue
    const col = Math.floor((petal.x + petal.dx * u) * cols + petal.wobble * Math.sin(Math.PI * 2 * (u * petal.waves + petal.phase)))
    const row = Math.floor((petal.y + petal.dy * u) * rows)
    if (col < 0 || col >= cols || row < 0 || row >= rows) continue
    cells.push({ col, row, glyph: PETAL_GLYPHS[Math.floor(u * petal.flutter * 6) % PETAL_GLYPHS.length], tone: petal.tone })
  }
  return cells
}
