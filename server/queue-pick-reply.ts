export type PickReply = { kind: 'pick'; option: string; note: string } | { kind: 'none'; feedback: string } | { kind: 'keep'; note: string } | { kind: 'unclear' }

export type Person = { id: string; username: string }
export type CardPeople = { creator: Person | null; assignees: Person[]; me: Person }

const NONE_WORDS = ['ไม่เอาสักแบบ', 'ไม่เอาซักแบบ', 'ไม่เอาซักช้อยส์', 'ไม่เอาสักช้อยส์', 'ไม่เอาเลย', 'ไม่ชอบสักแบบ', 'ไม่ชอบเลย', 'none', 'neither']
const KEEP_WORDS = ['เหมือน NOW', 'เหมือนเดิม', 'แบบเดิม', 'ไม่ต้องปรับ UI', 'keep now', 'keep', 'no change']
const FILLERS = /แบบ|เอา|ข้อ|เลือก|ตัว|option|ครับ|ค่ะ|คะ|นะ|จ้า/gi
const NOISE = /[\s\p{P}]/gu
const EDGE_PUNCTUATION = /^[\s\p{P}]+|[\s\p{P}]+$/gu
const tidy = (text: string): string => text.replace(/\p{P}/gu, ' ').replace(/\s+/g, ' ').trim()
const escaped = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const asciiEdge = /[a-z0-9]/i

const MIN_FEEDBACK_LETTERS = 10
const DEFERRALS = /เดี๋ยว|รอก่อน|ขอดูก่อน|ขอคิดก่อน|\b(?:later|wait)\b/i
const QUESTION_MARKERS = /[?？]|ไหม|มั้ย|มั๊ย|หรือเปล่า|รึเปล่า|ป่าว|ยังไง|อย่างไร|อะไร|ไหน|เหรอ|หรอ|ทำไม|เมื่อไหร่|ใคร/
const QUESTION_OPENERS = /^[\s\p{P}]*(?:what|which|how|why|when|where|who|can|could|should|is|are|do|does)(?![a-z0-9])/iu
const PLEASANTRIES = /ครับ|ค่ะ|คะ|นะ|จ้า|ขอบคุณ|โอเค|okay|ok|thanks|thank you|ได้|ดี|รับทราบ|5+/giu
const THAI_MARKS = '\\u0E31\\u0E34-\\u0E3A\\u0E47-\\u0E4E'

function phraseRegex(word: string): RegExp {
  const after = asciiEdge.test(word.at(-1)!) ? '(?![a-z0-9])' : `(?![${THAI_MARKS}])`
  return new RegExp(`^[\\s\\p{P}]*${escaped(word)}(?:เลย)?${after}`, 'iu')
}

const phrasesOf = (words: readonly string[], extra: readonly string[]): RegExp[] =>
  [...words, ...extra].sort((a, b) => b.length - a.length).map(phraseRegex)

const matchedBy = (phrases: readonly RegExp[], line: string): RegExpExecArray | undefined =>
  phrases.map(phrase => phrase.exec(line)).find(found => found !== null) ?? undefined

const namesAnOption = (line: string, options: readonly string[]): boolean => {
  const tokens = line.replace(FILLERS, ' ').toLowerCase().split(/[\s\p{P}]+/u)
  return options.some(id => tokens.includes(id.toLowerCase()))
}

const noneWith = (text: string, rest: string): PickReply => {
  const feedback = tidy(rest)
  return { kind: 'none', feedback: feedback === '' ? text.trim() : feedback }
}

const letterCount = (text: string): number => text.match(/\p{L}/gu)?.length ?? 0

function isFeedback(lines: readonly string[], first: string, options: readonly string[], keeps: readonly RegExp[]): boolean {
  const text = lines.join('\n')
  if (lines.some(line => namesAnOption(line, options) || matchedBy(keeps, line) !== undefined)) return false
  if (QUESTION_MARKERS.test(text) || QUESTION_OPENERS.test(first)) return false
  if (DEFERRALS.test(text)) return false
  return letterCount(text.replace(PLEASANTRIES, '')) >= MIN_FEEDBACK_LETTERS
}

export function parsePickReply(text: string, options: readonly string[], extraNonePhrases: readonly string[] = [], extraKeepPhrases: readonly string[] = [], { freeText = false }: { freeText?: boolean } = {}): PickReply {
  const lines = text.split('\n')
  const at = lines.findIndex(line => line.trim() !== '')
  if (at === -1) return { kind: 'unclear' }
  const first = lines[at]!
  const after = lines.slice(at + 1)
  const keeps = phrasesOf(KEEP_WORDS, extraKeepPhrases)
  const guarded = namesAnOption(first, options)
  const none = guarded ? undefined : matchedBy(phrasesOf(NONE_WORDS, extraNonePhrases), first)
  if (none !== undefined) {
    const rest = first.slice(none[0].length)
    return matchedBy(keeps, rest) === undefined ? noneWith(text, [rest, ...after].join('\n')) : { kind: 'unclear' }
  }
  if (!guarded && (matchedBy(keeps, first) !== undefined || first.replace(EDGE_PUNCTUATION, '').toLowerCase() === 'now')) return { kind: 'keep', note: text.trim() }
  if (first.replace(EDGE_PUNCTUATION, '').toLowerCase() === 'no') return noneWith(text, after.join('\n'))
  const left = first.replace(FILLERS, '').replace(NOISE, '').toLowerCase()
  const option = options.find(id => id.toLowerCase() === left)
  if (option !== undefined) return { kind: 'pick', option, note: after.join('\n').trim() }
  return freeText && isFeedback(lines, first, options, keeps) ? { kind: 'none', feedback: text.trim() } : { kind: 'unclear' }
}

export function pickOwner({ creator, assignees, me }: CardPeople): Person {
  const owner = assignees.length === 1 ? assignees[0]! : creator
  return owner === null || owner.id === me.id ? me : owner
}
