export type PickReply = { kind: 'pick'; option: string; note: string } | { kind: 'none'; feedback: string } | { kind: 'unclear' }

export type Person = { id: string; username: string }
export type CardPeople = { creator: Person | null; assignees: Person[]; me: Person }

const NONE_PHRASES = [/ไม่เอาสักแบบ/gi, /ไม่ชอบเลย/gi, /(?<![a-z0-9])none(?![a-z0-9])/gi]
const FILLERS = /แบบ|เอา|ข้อ|เลือก|ตัว|option|ครับ|ค่ะ|คะ|นะ|จ้า/gi
const NOISE = /[\s\p{P}]/gu
const tidy = (text: string): string => text.replace(/\p{P}/gu, ' ').replace(/\s+/g, ' ').trim()

export function parsePickReply(text: string, options: readonly string[]): PickReply {
  const lines = text.split('\n')
  const at = lines.findIndex(line => line.trim() !== '')
  if (at === -1) return { kind: 'unclear' }
  const first = lines[at]!
  if (NONE_PHRASES.some(phrase => new RegExp(phrase).test(first))) {
    const rest = tidy(NONE_PHRASES.reduce((left, phrase) => left.replace(phrase, ' '), text))
    return { kind: 'none', feedback: rest === '' ? text.trim() : rest }
  }
  const left = first.replace(FILLERS, '').replace(NOISE, '').toLowerCase()
  const option = options.find(id => id.toLowerCase() === left)
  return option === undefined ? { kind: 'unclear' } : { kind: 'pick', option, note: lines.slice(at + 1).join('\n').trim() }
}

export function pickOwner({ creator, assignees, me }: CardPeople): Person {
  const owner = assignees.length === 1 ? assignees[0]! : creator
  return owner === null || owner.id === me.id ? me : owner
}
