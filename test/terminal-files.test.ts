import { describe, expect, test } from 'bun:test'

import { typeFiles } from '../client/terminal-files'

const file = (name: string): File => new File(['x'], name)

function target(uploads: Record<string, string | Error>) {
  const sent: string[] = []
  const toasts: string[] = []
  return {
    sent,
    toasts,
    send: (text: string) => { sent.push(text) },
    toast: (text: string) => { toasts.push(text) },
    upload: async (picked: File) => {
      const result = uploads[picked.name]
      if (result instanceof Error || result === undefined) throw result ?? new Error('missing')
      return result
    },
  }
}

describe('typeFiles', () => {
  test('uploads each picked file and types the quoted paths at the prompt with a trailing space', async () => {
    const terminal = target({ 'a.png': '/drops/a b.png', 'c.txt': '/drops/c.txt' })
    expect(await typeFiles([file('a.png'), file('c.txt')], [], terminal)).toBe(2)
    expect(terminal.sent).toEqual(["'/drops/a b.png' /drops/c.txt "])
    expect(terminal.toasts).toEqual([])
  })

  test('a file that fails to upload is skipped with a toast naming it; the rest are still typed', async () => {
    const terminal = target({ 'a.png': '/drops/a b.png', 'c.txt': new Error('too big') })
    expect(await typeFiles([file('a.png'), file('c.txt')], [], terminal)).toBe(1)
    expect(terminal.sent).toEqual(["'/drops/a b.png' "])
    expect(terminal.toasts).toEqual(['Upload failed: c.txt'])
  })

  test('local file paths from a drop are typed as they are, without uploading', async () => {
    const terminal = target({})
    expect(await typeFiles([file('a.png')], ['/Users/me/a.png'], terminal)).toBe(1)
    expect(terminal.sent).toEqual(['/Users/me/a.png '])
  })

  test('nothing to type says so instead of sending an empty line', async () => {
    const terminal = target({ 'c.txt': new Error('too big') })
    expect(await typeFiles([], [], terminal)).toBe(0)
    expect(await typeFiles([file('c.txt')], [], terminal)).toBe(0)
    expect(terminal.sent).toEqual([])
    expect(terminal.toasts).toEqual(['Nothing to add', 'Upload failed: c.txt'])
  })
})
