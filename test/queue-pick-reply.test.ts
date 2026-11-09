import { expect, test } from 'bun:test'

import { parsePickReply, pickOwner } from '../server/queue-pick-reply'

const OPTIONS = ['A', 'B', 'C']

const table: Array<[string, ReturnType<typeof parsePickReply>]> = [
  ['C', { kind: 'pick', option: 'C', note: '' }],
  ['c', { kind: 'pick', option: 'C', note: '' }],
  ['แบบ C', { kind: 'pick', option: 'C', note: '' }],
  ['เอา C', { kind: 'pick', option: 'C', note: '' }],
  ['ข้อ C', { kind: 'pick', option: 'C', note: '' }],
  ['C ครับ', { kind: 'pick', option: 'C', note: '' }],
  ['เลือก C', { kind: 'pick', option: 'C', note: '' }],
  ['ตัว C', { kind: 'pick', option: 'C', note: '' }],
  ['C ครับ\nปุ่มใหญ่ขึ้นหน่อย', { kind: 'pick', option: 'C', note: 'ปุ่มใหญ่ขึ้นหน่อย' }],
  ['C ครับ ปุ่มใหญ่ขึ้นหน่อย', { kind: 'unclear' }],
  ['Can you make a darker version first?', { kind: 'unclear' }],
  ['looks good, please add a back button', { kind: 'unclear' }],
  ['see https://x.shikidan.com/b.html', { kind: 'unclear' }],
  ['I don\u2019t like C', { kind: 'unclear' }],
  ["I don't like C", { kind: 'unclear' }],
  ['C is bad', { kind: 'unclear' }],
  ['C ดูแย่สุด', { kind: 'unclear' }],
  ['ไม่เอา A', { kind: 'unclear' }],
  ['A หรือ C ดี', { kind: 'unclear' }],
  ['ไม่ชอบเลย อยากได้แบบเดิม', { kind: 'none', feedback: 'อยากได้แบบเดิม' }],
]

for (const [reply, expected] of table) {
  test(`${JSON.stringify(reply)} reads as ${expected.kind}`, () => {
    expect(parsePickReply(reply, OPTIONS)).toEqual(expected)
  })
}

test('only the first non-empty line decides, and the lines after a pick are its note', () => {
  expect(parsePickReply('\n  \nแบบ B นะ\n\nปุ่มใหญ่ขึ้น\nสีเข้มขึ้น\n', OPTIONS)).toEqual({ kind: 'pick', option: 'B', note: 'ปุ่มใหญ่ขึ้น\nสีเข้มขึ้น' })
  expect(parsePickReply('option c จ้า', OPTIONS)).toEqual({ kind: 'pick', option: 'C', note: '' })
  expect(parsePickReply('อยากได้แบบใหม่\nC', OPTIONS)).toEqual({ kind: 'unclear' })
})

test('a letter touching Thai or brackets still counts, one with any other letter or digit left over does not', () => {
  expect(parsePickReply('แบบC', OPTIONS)).toEqual({ kind: 'pick', option: 'C', note: '' })
  expect(parsePickReply('(C)', OPTIONS)).toEqual({ kind: 'pick', option: 'C', note: '' })
  expect(parsePickReply('C1', OPTIONS)).toEqual({ kind: 'unclear' })
  expect(parsePickReply('xC', OPTIONS)).toEqual({ kind: 'unclear' })
})

test('two letters, extra words, or no letter at all are unclear', () => {
  expect(parsePickReply('C นะ C', OPTIONS)).toEqual({ kind: 'unclear' })
  expect(parsePickReply('C, nothing else', OPTIONS)).toEqual({ kind: 'unclear' })
  expect(parsePickReply('not C', OPTIONS)).toEqual({ kind: 'unclear' })
  expect(parsePickReply('สวยทุกแบบเลย', OPTIONS)).toEqual({ kind: 'unclear' })
  expect(parsePickReply('', OPTIONS)).toEqual({ kind: 'unclear' })
})

test('none on the first line wins and keeps the rest as feedback, or the whole text when nothing is left', () => {
  expect(parsePickReply('None, make it blue', OPTIONS)).toEqual({ kind: 'none', feedback: 'make it blue' })
  expect(parsePickReply('ไม่เอาสักแบบ ทั้ง A และ B', OPTIONS)).toEqual({ kind: 'none', feedback: 'ทั้ง A และ B' })
  expect(parsePickReply('ไม่ชอบเลย\nอยากได้ปุ่มใหญ่', OPTIONS)).toEqual({ kind: 'none', feedback: 'อยากได้ปุ่มใหญ่' })
  expect(parsePickReply('ไม่ชอบเลย', OPTIONS)).toEqual({ kind: 'none', feedback: 'ไม่ชอบเลย' })
  expect(parsePickReply('none', OPTIONS)).toEqual({ kind: 'none', feedback: 'none' })
  expect(parsePickReply('nonetheless C', OPTIONS)).toEqual({ kind: 'unclear' })
  expect(parsePickReply('C\nnone of the others', OPTIONS)).toEqual({ kind: 'pick', option: 'C', note: 'none of the others' })
})

test('longer option ids match whole and come back in their own case', () => {
  expect(parsePickReply('เอา opt2 ครับ', ['Opt1', 'Opt2'])).toEqual({ kind: 'pick', option: 'Opt2', note: '' })
  expect(parsePickReply('Opt', ['Opt1', 'Opt2'])).toEqual({ kind: 'unclear' })
})

const person = (id: string, username = `user ${id}`) => ({ id, username })
const me = person('9', 'Palm')

test('the one assignee owns the pick', () => {
  expect(pickOwner({ creator: person('1'), assignees: [person('2')], me })).toEqual(person('2'))
})

test('with no assignee or several, the creator owns the pick', () => {
  expect(pickOwner({ creator: person('1'), assignees: [], me })).toEqual(person('1'))
  expect(pickOwner({ creator: person('1'), assignees: [person('2'), person('3')], me })).toEqual(person('1'))
})

test('no creator, or an owner who is the bot account itself, falls back to me', () => {
  expect(pickOwner({ creator: null, assignees: [], me })).toEqual(me)
  expect(pickOwner({ creator: person('9', 'Palm old name'), assignees: [], me })).toEqual(me)
  expect(pickOwner({ creator: person('1'), assignees: [person('9')], me })).toEqual(me)
})
