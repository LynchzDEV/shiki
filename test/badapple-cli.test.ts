import { describe, expect, test } from 'bun:test'

import { ansiFrame } from '../cli/commands/badapple'

const video = { cols: 4, rows: 2, fps: 30, count: 1, cells: new Uint8Array([0, 7, 3, 7, 0, 0, 1, 0]) }
const SAKURA_LIGHTEST = '\x1b[38;2;247;202;215m'
const plain = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

describe('ansiFrame', () => {
  test('starts at the top-left corner so each frame paints over the last', () => {
    expect(ansiFrame(video, 0, 0, 4, 2, false).startsWith('\x1b[H')).toBe(true)
  })

  test('draws each level with its ramp glyph', () => {
    expect(plain(ansiFrame(video, 0, 0, 4, 2, false))).toBe(' @+@\n  . ')
  })

  test('colors the brightest glyph with the lightest sakura and leaves blanks uncolored', () => {
    expect(ansiFrame(video, 0, 0, 4, 2, false).split('\n')[0]).toBe(`\x1b[H ${SAKURA_LIGHTEST}@\x1b[38;2;192;138;214m+${SAKURA_LIGHTEST}@`)
  })

  test('shrinks to the size it is given', () => {
    expect(plain(ansiFrame(video, 0, 0, 2, 1, false))).toBe(' +')
  })

  test('keeps the same size with petals drifting over it', () => {
    const lines = plain(ansiFrame({ ...video, cols: 96, rows: 36, cells: new Uint8Array(96 * 36) }, 0, 3.2, 96, 36)).split('\n')
    expect(lines).toHaveLength(36)
    expect(lines.every(line => line.length === 96)).toBe(true)
    expect(lines.join('')).toMatch(/[*'`,]/)
  })
})
