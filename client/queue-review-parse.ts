export type ReviewOption = { id: string; subtitle: string; description: string }
export type OpenChoice = { id: string; label: string; default: string; hint: string }
export type ReviewFact = { value: string; label: string }
export type TagChip = { name: string; role: 'assignee' | 'watcher' }
export type ExtraSection = { heading: string; markdown: string }
export type Recommendation = { option: string | null; reason: string }

export type ParsedSummary =
  | { structured: false; markdown: string }
  | {
    structured: true
    recommendation: Recommendation | null
    options: ReviewOption[]
    points: string | null
    open: OpenChoice[]
    outOfScope: string[]
    facts: ReviewFact[]
    tags: TagChip[]
    extra: ExtraSection[]
  }

const HEADING = /^##\s+(.+?)\s*$/
const BULLET = /^\s*[-*]\s+(.*\S)\s*$/
const RECOMMENDED = /^([A-Z][A-Za-z0-9]{0,15})\s*[—–-]\s*([\s\S]+)$/
const KNOWN = new Set(['recommendation', 'options', 'points', 'still open', 'out of scope', 'facts', 'tag'])
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

function sections(markdown: string): ExtraSection[] {
  const found: ExtraSection[] = []
  let heading = ''
  let body: string[] = []
  let fenced = false
  const flush = (): void => { found.push({ heading, markdown: body.join('\n').trim() }) }
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const match = fenced ? null : HEADING.exec(line)
    if (match === null) { body.push(line); continue }
    flush()
    heading = match[1]!.replace(/:$/, '').trim()
    body = []
  }
  flush()
  return found
}

const bullets = (markdown: string): string[] => markdown.split('\n').map(line => BULLET.exec(line)?.[1]).filter((text): text is string => text !== undefined)

function option(line: string): ReviewOption | null {
  const [id = '', subtitle, ...rest] = line.split('|').map(squash)
  if (id === '' || subtitle === undefined) return null
  return { id, subtitle, description: rest.join(' | ') }
}

function openChoice(line: string): OpenChoice | null {
  const [head = '', ...parts] = line.split('|').map(squash)
  const [id = '', ...label] = head.split(' ')
  if (id === '') return null
  const found = { default: '', hint: '' }
  let current: keyof typeof found = 'default'
  for (const part of parts) {
    const hint = /^other hint:\s*/i.exec(part)
    const given = /^default:\s*/i.exec(part)
    if (hint !== null) current = 'hint'
    else if (given !== null) current = 'default'
    const text = part.slice((hint ?? given)?.[0].length ?? 0)
    found[current] = found[current] === '' ? text : `${found[current]} | ${text}`
  }
  return { id, label: label.join(' '), ...found }
}

function fact(line: string): ReviewFact {
  const [value = '', ...label] = line.split('|').map(squash)
  return { value, label: label.join(' | ') }
}

function tag(line: string): TagChip {
  const [name = '', role = ''] = line.split('|').map(squash)
  return { name, role: role.toLowerCase() === 'watcher' ? 'watcher' : 'assignee' }
}

function recommendation(text: string): Recommendation | null {
  const reason = text.trim()
  if (reason === '') return null
  const match = RECOMMENDED.exec(reason)
  return match === null ? { option: null, reason: squash(reason) } : { option: match[1]!, reason: squash(match[2]!) }
}

export function parsePickSummary(markdown: string): ParsedSummary {
  const text = markdown.trim()
  const parts = sections(text)
  const named = (name: string): string | undefined => parts.find(part => part.heading.toLowerCase() === name)?.markdown
  if (!parts.some(part => KNOWN.has(part.heading.toLowerCase()))) return { structured: false, markdown: text }
  const points = named('points')
  return {
    structured: true,
    recommendation: recommendation(named('recommendation') ?? ''),
    options: bullets(named('options') ?? '').map(option).filter((entry): entry is ReviewOption => entry !== null),
    points: points === undefined || points === '' ? null : points,
    open: bullets(named('still open') ?? '').map(openChoice).filter((entry): entry is OpenChoice => entry !== null),
    outOfScope: bullets(named('out of scope') ?? ''),
    facts: bullets(named('facts') ?? '').map(fact),
    tags: bullets(named('tag') ?? '').map(tag),
    extra: parts.filter(part => !KNOWN.has(part.heading.toLowerCase()) && part.markdown !== ''),
  }
}
