import { expect, test } from 'bun:test'

import { resolveQueueId } from '../server/queue-id'

const items = [{ id: '6ea3d96d-aaaa' }, { id: '6ea3d96e-bbbb' }, { id: 'abcd1234-cccc' }, { id: 'abc' }]

test('the full id resolves to itself', () => {
  expect(resolveQueueId(items, '6ea3d96d-aaaa')).toEqual({ id: '6ea3d96d-aaaa' })
})

test('an exact id wins even when it is also a prefix of another', () => {
  expect(resolveQueueId([{ id: 'abcd' }, { id: 'abcd-2' }], 'abcd')).toEqual({ id: 'abcd' })
})

test('a unique prefix of 4 or more characters resolves', () => {
  expect(resolveQueueId(items, 'abcd')).toEqual({ id: 'abcd1234-cccc' })
  expect(resolveQueueId(items, '6ea3d96d')).toEqual({ id: '6ea3d96d-aaaa' })
})

test('an ambiguous prefix is a 409 that says how many', () => {
  expect(resolveQueueId(items, '6ea3')).toEqual({ status: 409, error: '6ea3 matches 2 queue items; use more of the id' })
})

test('a prefix shorter than 4 characters is not tried', () => {
  expect(resolveQueueId(items, 'abc1')).toEqual({ status: 404, error: 'No queue item abc1' })
  expect(resolveQueueId(items, 'ab')).toEqual({ status: 404, error: 'No queue item ab' })
})

test('no match is a 404', () => {
  expect(resolveQueueId(items, 'zzzzzz')).toEqual({ status: 404, error: 'No queue item zzzzzz' })
})
