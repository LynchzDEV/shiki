import { describe, expect, test } from 'bun:test'

import { compareVersions, satisfies } from '../server/plugins/requirements'

describe('compareVersions', () => {
  test('compares numerically, so 1.10.0 is newer than 1.9.0', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0)
  })

  test('a missing part counts as zero', () => {
    expect(compareVersions('1.7', '1.7.0')).toBe(0)
    expect(compareVersions('2', '1.9.9')).toBeGreaterThan(0)
  })

  test('anything from the first non-digit, non-dot character is ignored', () => {
    expect(compareVersions('1.7.0-beta', '1.7.0')).toBe(0)
    expect(compareVersions('1.7.1-rc1', '1.7.0')).toBeGreaterThan(0)
  })
})

describe('satisfies', () => {
  test('no minimum is always satisfied', () => {
    expect(satisfies('0.0.1', undefined)).toBe(true)
  })

  test('equal and newer versions satisfy, older ones do not', () => {
    expect(satisfies('1.7.0', '1.7.0')).toBe(true)
    expect(satisfies('1.8.0', '1.7.0')).toBe(true)
    expect(satisfies('1.6.9', '1.7.0')).toBe(false)
  })
})
