export type PickReply = { kind: 'pick'; option: string; note: string } | { kind: 'none'; feedback: string } | { kind: 'unclear' }

export type Person = { id: string; username: string }
export type CardPeople = { creator: Person | null; assignees: Person[]; me: Person }

const NONE_WORDS = ['ไม่เอาสักแบบ', 'ไม่เอาซักแบบ', 'ไม่เอาซักช้อยส์', 'ไม่เอาสักช้อยส์', 'ไม่เอาเลย', 'ไม่ชอบสักแบบ', 'ไม่ชอบเลย', 'none', 'neither']
const FILLERS = /แบบ|เอา|ข้อ|เลือก|ตัว|option|ครับ|ค่ะ|คะ|นะ|จ้า/gi
const NOISE = /[\s\p{P}]/gu
const EDGE_PUNCTUATION = /^[\s\p{P}]+|[\s\p{P}]+$/gu
const tidy = (text: string): string => text.replace(/\p{P}/gu, ' ').replace(/\s+/g, ' ').trim()
const escaped = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const asciiEdge = /[a-z0-9]/i

const THAI_MARKS = '\\u0E31\\u0E34-\\u0E3A\\u0E47-\\u0E4E'

function phraseRegex(word: string): RegExp {
  const after = asciiEdge.test(word.at(-1)!) ? '(?![a-z0-9])' : `(?![${THAI_MARKS}])`
  return new RegExp(`^[\\s\\p{P}]*${escaped(word)}(?:เลย)?${after}`, 'iu')
}

const nonePhrases = (extra: readonly string[]): RegExp[] =>
  [...NONE_WORDS, ...extra].sort((a, b) => b.length - a.length).map(phraseRegex)

const namesAnOption = (line: string, options: readonly string[]): boolean => {
  const tokens = line.replace(FILLERS, ' ').toLowerCase().split(/[\s\p{P}]+/u)
  return options.some(id => tokens.includes(id.toLowerCase()))
}

const noneWith = (text: string, rest: string): PickReply => {
  const feedback = tidy(rest)
  return { kind: 'none', feedback: feedback === '' ? text.trim() : feedback }
}

export function parsePickReply(text: string, options: readonly string[], extraNonePhrases: readonly string[] = []): PickReply {
  const lines = text.split('\n')
  const at = lines.findIndex(line => line.trim() !== '')
  if (at === -1) return { kind: 'unclear' }
  const first = lines[at]!
  const after = lines.slice(at + 1)
  const matched = namesAnOption(first, options) ? undefined : nonePhrases(extraNonePhrases).map(phrase => phrase.exec(first)).find(found => found !== null)
  if (matched !== undefined && matched !== null) return noneWith(text, [first.slice(matched[0].length), ...after].join('\n'))
  if (first.replace(EDGE_PUNCTUATION, '').toLowerCase() === 'no') return noneWith(text, after.join('\n'))
  const left = first.replace(FILLERS, '').replace(NOISE, '').toLowerCase()
  const option = options.find(id => id.toLowerCase() === left)
  return option === undefined ? { kind: 'unclear' } : { kind: 'pick', option, note: after.join('\n').trim() }
}

export function pickOwner({ creator, assignees, me }: CardPeople): Person {
  const owner = assignees.length === 1 ? assignees[0]! : creator
  return owner === null || owner.id === me.id ? me : owner
}
