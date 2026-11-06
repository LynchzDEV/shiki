import { join } from 'node:path'

import { encodeFrames, quantize } from '../client/badapple-frames'

const COLS = 96
const ROWS = 36
const FPS = 30
const OUT = join(import.meta.dir, '..', 'public', 'badapple.bin')

const input = process.argv[2]
if (!input) {
  console.error('usage: bun scripts/badapple.ts <video file>')
  process.exit(2)
}

const ffmpeg = Bun.spawnSync(['ffmpeg', '-v', 'error', '-i', input, '-vf', `fps=${FPS},scale=${COLS}:${ROWS}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { stdout: 'pipe', stderr: 'pipe' })
if (ffmpeg.exitCode !== 0) {
  console.error(`ffmpeg failed: ${ffmpeg.stderr.toString().trim()}`)
  process.exit(1)
}

const gray = new Uint8Array(ffmpeg.stdout)
const count = Math.floor(gray.length / (COLS * ROWS))
const cells = gray.subarray(0, count * COLS * ROWS).map(quantize)
const packed = Bun.gzipSync(encodeFrames({ cols: COLS, rows: ROWS, fps: FPS, count, cells }), { level: 9 })
await Bun.write(OUT, packed)
console.log(`${count} frames at ${COLS}x${ROWS}, ${FPS} fps -> ${OUT} (${(packed.length / 1024).toFixed(0)} KB)`)
