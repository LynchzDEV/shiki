import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { DUO_OPEN_QUERY, PHONE_TERMINAL_QUERY, enterIntent, errorText, getJson, pathsFromUriList, shellQuote, streamJobLog } from '../client/shared'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('getJson / parse', () => {
  beforeEach(() => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ id: 'a' }, { id: 'b' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
  })

  test('discards a bare top-level JSON array response to {}', async () => {
    const result = await getJson('/api/whatever')
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({})
  })

  test('an object envelope with an array property passes through untouched', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jobs: [{ id: 'a' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    const result = await getJson('/api/jobs')
    expect(result.data).toEqual({ jobs: [{ id: 'a' }] })
  })
})

class FakeEventSource {
  static last: FakeEventSource | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.last = this
  }

  close(): void {
    this.closed = true
  }
}

describe('errorText', () => {
  test('appends a misses list when the server sends one', () => {
    expect(errorText({ ok: false, status: 422, data: { error: 'spec lint failed', misses: ['missing "## Decisions" section', 'step 2 names no file path'] } })).toBe('spec lint failed\n- missing "## Decisions" section\n- step 2 names no file path')
    expect(errorText({ ok: false, status: 400, data: { error: 'plain' } })).toBe('plain')
    expect(errorText({ ok: false, status: 0, data: {} })).toBe('server unreachable')
  })
})

describe('streamJobLog', () => {
  const originalEventSource = globalThis.EventSource

  beforeEach(() => {
    FakeEventSource.last = null
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
  })

  afterEach(() => {
    globalThis.EventSource = originalEventSource
  })

  test('subscribes to the job stream endpoint and forwards each line', () => {
    const lines: string[] = []
    const stream = streamJobLog('job-1', (line) => lines.push(line), () => {})

    expect((stream as unknown as FakeEventSource).url).toBe('/api/jobs/job-1/stream')
    FakeEventSource.last?.onmessage?.({ data: 'first' })
    FakeEventSource.last?.onmessage?.({ data: 'second' })
    expect(lines).toEqual(['first', 'second'])
  })

  test('signals the end once and closes the source on error', () => {
    let ended = 0
    const stream = streamJobLog('job-2', () => {}, () => {
      ended += 1
    })

    FakeEventSource.last?.onerror?.()
    expect(ended).toBe(1)
    expect((stream as unknown as FakeEventSource).closed).toBe(true)
  })
})

describe('shellQuote / pathsFromUriList', () => {
  test('leaves already-safe paths unquoted', () => {
    expect(shellQuote('/a/b.txt')).toBe('/a/b.txt')
    expect(shellQuote('~/dir/file-name_2.txt')).toBe('~/dir/file-name_2.txt')
  })

  test('single-quotes paths with spaces and embedded quotes', () => {
    expect(shellQuote("/a/my file's.txt")).toBe("'/a/my file'\\''s.txt'")
  })

  test('extracts decoded file:// paths from a uri-list', () => {
    expect(pathsFromUriList('file:///Users/x/a%20b.txt\r\n#c\r\nhttps://x')).toEqual(['/Users/x/a b.txt'])
  })

  test('ignores blank lines, comments, and non-file schemes', () => {
    expect(pathsFromUriList('')).toEqual([])
    expect(pathsFromUriList('\r\n\r\n#comment\r\nhttp://x/y')).toEqual([])
  })
})

describe('enterIntent', () => {
  const originalMatchMedia = globalThis.matchMedia
  const stubMatching = (matching: string[]): void => {
    globalThis.matchMedia = ((query: string) => ({ matches: matching.includes(query) })) as unknown as typeof matchMedia
  }
  const enter = { key: 'Enter', shiftKey: false, isComposing: false }

  afterEach(() => {
    globalThis.matchMedia = originalMatchMedia
  })

  test('a desktop Enter sends, or picks the highlighted menu row', () => {
    stubMatching([])
    expect(enterIntent(enter, false)).toBe('send')
    expect(enterIntent(enter, true)).toBe('pick')
  })

  test('a phone Enter adds a line, even with a menu open and nothing matching, but still picks a highlighted row', () => {
    stubMatching([PHONE_TERMINAL_QUERY])
    expect(enterIntent(enter, false)).toBe('newline')
    expect(enterIntent(enter, true)).toBe('pick')
  })

  test('an iPhone Duo open Enter adds a line', () => {
    stubMatching([DUO_OPEN_QUERY])
    expect(enterIntent(enter, false)).toBe('newline')
  })

  test('Shift+Enter, IME composing and other keys are left alone', () => {
    stubMatching([])
    expect(enterIntent({ ...enter, shiftKey: true }, false)).toBe('none')
    expect(enterIntent({ ...enter, isComposing: true }, false)).toBe('none')
    expect(enterIntent({ ...enter, key: 'a' }, false)).toBe('none')
  })
})
