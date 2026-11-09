import { expect, test } from 'bun:test'

import type { InstalledPlugin } from '../server/plugins/store'
import { pluginSource, type SourceDeps } from '../server/queue-source'

type Call = { method: string; params: unknown }

function deps(answer: (call: Call) => unknown, options: { installed?: Partial<InstalledPlugin> | null; runtimeError?: string } = {}): { deps: SourceDeps; calls: Call[] } {
  const calls: Call[] = []
  const installed = options.installed === null ? null : ({ id: 'clickup-board', enabled: true, ...options.installed } as InstalledPlugin)
  return {
    calls,
    deps: {
      installed: async () => installed,
      runtimes: async () => ({
        getRuntime: async () => options.runtimeError
          ? { ok: false, status: 503, error: options.runtimeError }
          : { ok: true, runtime: { call: async (method: string, params: unknown) => { calls.push({ method, params }); const result = answer({ method, params }); return result instanceof Error ? { ok: false, status: 500, error: result.message } : { ok: true, result } }, dispose: async () => {} } },
      }),
    },
  }
}

test('item calls source.item and returns the parsed item', async () => {
  const { deps: d, calls } = deps(() => ({ title: 'Login copy', url: 'https://x/t/1', contextMarkdown: '# task' }))
  expect(await pluginSource('clickup-board', d).item({ id: '1' })).toEqual({ title: 'Login copy', url: 'https://x/t/1', contextMarkdown: '# task' })
  expect(calls).toEqual([{ method: 'source.item', params: { id: '1' } }])
})

test('item images are parsed, and more than 30 are rejected', async () => {
  const images = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `s${index}.png`, path: `card/s${index}.png` }))
  const ok = deps(() => ({ title: 'T', url: 'u', contextMarkdown: '# t', images: images(30) }))
  expect((await pluginSource('clickup-board', ok.deps).item({ id: '1' })).images).toHaveLength(30)
  const tooMany = deps(() => ({ title: 'T', url: 'u', contextMarkdown: '# t', images: images(31) }))
  await expect(pluginSource('clickup-board', tooMany.deps).item({ id: '1' })).rejects.toThrow('unexpected source.item result')
})

test('post sends kind and lines and returns the comment id', async () => {
  const { deps: d, calls } = deps(() => ({ commentId: 'c9' }))
  expect(await pluginSource('clickup-board', d).post({ id: '1', kind: 'ask', lines: ['Which page?'] })).toEqual({ commentId: 'c9' })
  expect(calls[0]).toEqual({ method: 'source.post', params: { id: '1', kind: 'ask', lines: ['Which page?'] } })
})

test('post passes a warning through and rejects an oversized one', async () => {
  const { deps: d } = deps(() => ({ commentId: 'c9', warning: 'Status not set: no such status' }))
  expect(await pluginSource('clickup-board', d).post({ id: '1', kind: 'update', lines: ['x'] })).toEqual({ commentId: 'c9', warning: 'Status not set: no such status' })
  const { deps: big } = deps(() => ({ commentId: 'c9', warning: 'w'.repeat(2001) }))
  await expect(pluginSource('clickup-board', big).post({ id: '1', kind: 'update', lines: ['x'] })).rejects.toThrow()
})

test('replies parses replies and images, and an author id the plugin left out reads as empty', async () => {
  const { deps: d } = deps(() => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [{ name: 'shot.png', path: 'replies/shot.png' }] }], lastId: 'r1' }))
  expect(await pluginSource('clickup-board', d).replies({ id: '1', sinceId: 'c9' })).toEqual({ replies: [{ id: 'r1', author: 'Ploy', authorId: '', text: 'The login page', images: [{ name: 'shot.png', path: 'replies/shot.png' }] }], lastId: 'r1' })
})

test('replies keep the author id the plugin sends', async () => {
  const { deps: d } = deps(() => ({ replies: [{ id: 'r1', author: 'Kan', authorId: '4242', text: 'แบบ C', images: [] }], lastId: 'r1' }))
  expect((await pluginSource('clickup-board', d).replies({ id: '1', sinceId: 'c9' })).replies[0]!.authorId).toBe('4242')
})

test('an ask with a tag and an assignee passes both and returns the comment ref', async () => {
  const { deps: d, calls } = deps(() => ({ commentId: '1730000000000', ref: '90120000123' }))
  const input = { id: '1', kind: 'ask' as const, lines: ['ช่วยเลือกหน่อยครับ'], mention: '4242', assignee: '4242' }
  expect(await pluginSource('clickup-board', d).post(input)).toEqual({ commentId: '1730000000000', ref: '90120000123' })
  expect(calls).toEqual([{ method: 'source.post', params: input }])
})

test('people calls source.people and parses the creator, the assignees and me', async () => {
  const answer = { creator: { id: '11', username: 'Kan' }, assignees: [{ id: '12', username: 'Mac' }], me: { id: '99', username: 'Palm' } }
  const { deps: d, calls } = deps(() => answer)
  expect(await pluginSource('clickup-board', d).people({ id: '1' })).toEqual(answer)
  expect(calls).toEqual([{ method: 'source.people', params: { id: '1' } }])
  const { deps: noCreator } = deps(() => ({ ...answer, creator: null }))
  expect((await pluginSource('clickup-board', noCreator).people({ id: '1' })).creator).toBeNull()
  const { deps: numeric } = deps(() => ({ ...answer, me: { id: 99, username: 'Palm' } }))
  await expect(pluginSource('clickup-board', numeric).people({ id: '1' })).rejects.toThrow('clickup-board returned an unexpected source.people result')
  const { deps: noMe } = deps(() => ({ creator: null, assignees: [] }))
  await expect(pluginSource('clickup-board', noMe).people({ id: '1' })).rejects.toThrow('unexpected source.people result')
})

test('resolve calls source.resolve with the comment ref and passes its failure on', async () => {
  const { deps: d, calls } = deps(() => ({}))
  await pluginSource('clickup-board', d).resolve({ id: '1', ref: '90120000123' })
  expect(calls).toEqual([{ method: 'source.resolve', params: { id: '1', ref: '90120000123' } }])
  const { deps: refused } = deps(() => new Error('Comment not found'))
  await expect(pluginSource('clickup-board', refused).resolve({ id: '1', ref: 'x' })).rejects.toThrow('Comment not found')
})

test('reply calls source.reply with the ask ref and returns the comment id', async () => {
  const { deps: d, calls } = deps(() => ({ commentId: 'c77' }))
  expect(await pluginSource('clickup-board', d).reply({ id: '1', ref: '9012', lines: ['a', 'b'] })).toEqual({ commentId: 'c77' })
  expect(calls).toEqual([{ method: 'source.reply', params: { id: '1', ref: '9012', lines: ['a', 'b'] } }])
  const { deps: empty } = deps(() => ({ commentId: '' }))
  await expect(pluginSource('clickup-board', empty).reply({ id: '1', ref: 'x', lines: ['a'] })).rejects.toThrow('unexpected source.reply result')
})

test('a malformed plugin answer is rejected, not trusted', async () => {
  const { deps: d } = deps(() => ({ title: 3 }))
  await expect(pluginSource('clickup-board', d).item({ id: '1' })).rejects.toThrow('clickup-board returned an unexpected source.item result')
})

test('replies without a lastId are rejected with the reason', async () => {
  const { deps: d } = deps(() => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [] }], lastId: null }))
  await expect(pluginSource('clickup-board', d).replies({ id: '1', sinceId: 'c9' })).rejects.toThrow('clickup-board returned an unexpected source.replies result: lastId is required when there are replies')
})

test('no replies and no lastId is a valid answer', async () => {
  const { deps: d } = deps(() => ({ replies: [], lastId: null }))
  expect(await pluginSource('clickup-board', d).replies({ id: '1', sinceId: 'c9' })).toEqual({ replies: [], lastId: null })
})

test('missing, disabled, unstartable or failing plugins throw readable errors', async () => {
  await expect(pluginSource('clickup-board', deps(() => ({}), { installed: null }).deps).item({ id: '1' })).rejects.toThrow('clickup-board is not installed')
  await expect(pluginSource('clickup-board', deps(() => ({}), { installed: { enabled: false } }).deps).item({ id: '1' })).rejects.toThrow('clickup-board is turned off')
  await expect(pluginSource('clickup-board', deps(() => ({}), { runtimeError: 'needs a newer Bun' }).deps).item({ id: '1' })).rejects.toThrow('needs a newer Bun')
  await expect(pluginSource('clickup-board', deps(() => new Error('No method source.item')).deps).item({ id: '1' })).rejects.toThrow('No method source.item')
})

test('status calls source.status and returns the status the source read back', async () => {
  const { deps: d, calls } = deps(() => ({ status: 'in progress' }))
  expect(await pluginSource('clickup-board', d).status({ id: '1', status: 'in progress' })).toEqual({ status: 'in progress' })
  expect(calls).toEqual([{ method: 'source.status', params: { id: '1', status: 'in progress' } }])
  const { deps: bad } = deps(() => ({ status: '' }))
  await expect(pluginSource('clickup-board', bad).status({ id: '1', status: 'x' })).rejects.toThrow('clickup-board returned an unexpected source.status result')
  const { deps: refused } = deps(() => new Error('No status "hold" on this list'))
  await expect(pluginSource('clickup-board', refused).status({ id: '1', status: 'hold' })).rejects.toThrow('No status "hold" on this list')
})
