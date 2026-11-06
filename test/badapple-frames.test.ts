import { describe, expect, test } from 'bun:test'

import { decodeFrames, encodeFrames, fitSize, frameAt, isBadApple, petalCells, quantize, sampleLevel } from '../client/badapple-frames'

const twoFrames = { cols: 3, rows: 2, fps: 30, count: 2, cells: new Uint8Array([0, 7, 3, 7, 0, 1, 0, 7, 4, 7, 0, 0]) }

describe('frame file', () => {
  test('round-trips header and every cell', () => {
    const decoded = decodeFrames(encodeFrames(twoFrames))
    expect([decoded.cols, decoded.rows, decoded.fps, decoded.count]).toEqual([3, 2, 30, 2])
    expect([...decoded.cells]).toEqual([0, 7, 3, 7, 0, 1, 0, 7, 4, 7, 0, 0])
  })

  test('stores each frame as its change from the one before', () => {
    const body = encodeFrames(twoFrames).subarray(13)
    expect([...body.subarray(6)]).toEqual([0, 0, 7, 0, 0, 1])
  })

  test('refuses bytes that are not a frame file', () => {
    expect(() => decodeFrames(new Uint8Array(20))).toThrow('not a Bad Apple frame file')
  })

  test('refuses a file cut short', () => {
    expect(() => decodeFrames(encodeFrames(twoFrames).subarray(0, 20))).toThrow('frame file is truncated')
  })

  test('frameAt returns one frame of cells', () => {
    expect([...frameAt(twoFrames, 1)]).toEqual([0, 7, 4, 7, 0, 0])
  })
})

describe('quantize', () => {
  test('maps black to 0, white to 7 and mid grey between', () => {
    expect([quantize(0), quantize(255), quantize(128)]).toEqual([0, 7, 4])
  })
})

describe('isBadApple', () => {
  test('matches the word alone, any case, with surrounding spaces', () => {
    expect(['badapple', ' BadApple ', 'BADAPPLE'].map(isBadApple)).toEqual([true, true, true])
  })

  test('ignores the word inside a longer message', () => {
    expect(['play badapple', 'bad apple', 'badapples'].map(isBadApple)).toEqual([false, false, false])
  })
})

describe('fitSize', () => {
  test('keeps the full size when the terminal is big enough', () => {
    expect(fitSize(96, 36, 200, 60)).toEqual({ width: 96, height: 36 })
  })

  test('shrinks both sides by the same ratio to fit a small terminal', () => {
    expect(fitSize(96, 36, 48, 40)).toEqual({ width: 48, height: 18 })
  })

  test('leaves the last terminal row free for the cursor', () => {
    expect(fitSize(96, 36, 200, 19)).toEqual({ width: 48, height: 18 })
  })
})

describe('sampleLevel', () => {
  test('picks the nearest source cell when shrinking', () => {
    const frame = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 0])
    expect([sampleLevel(frame, 4, 2, 2, 1, 0, 0), sampleLevel(frame, 4, 2, 2, 1, 1, 0)]).toEqual([1, 3])
  })
})

describe('petalCells', () => {
  test('puts every petal inside the grid with a petal glyph', () => {
    const petals = petalCells(3.2, 96, 36)
    expect(petals.length).toBeGreaterThan(0)
    for (const petal of petals) {
      expect(petal.col).toBeGreaterThanOrEqual(0)
      expect(petal.col).toBeLessThan(96)
      expect(petal.row).toBeGreaterThanOrEqual(0)
      expect(petal.row).toBeLessThan(36)
      expect("*'`,".includes(petal.glyph)).toBe(true)
    }
  })

  test('is the same for the same moment', () => {
    expect(petalCells(5, 96, 36)).toEqual(petalCells(5, 96, 36))
  })
})
