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
const BULLET = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/
const RECOMMENDED = /^([A-Za-z][A-Za-z0-9]{0,15})\s+[—–-]\s+([\s\S]+)$/
const DASHED = /^([A-Za-z][A-Za-z0-9]{0,15})\s+[—–-]\s+(.+)$/
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

const unbold = (text: string): string => text.replace(/\*\*/g, '')
const canonical = (id: string, known: readonly string[]): string | null =>
  known.length === 0 ? id : (known.find(entry => entry.toLowerCase() === id.toLowerCase()) ?? null)

function option(line: string, known: readonly string[]): ReviewOption | null {
  const text = unbold(line).replace(/^option\s+/i, '')
  const dashed = text.includes('|') ? null : DASHED.exec(text)
  const [id = '', subtitle, ...rest] = dashed === null ? text.split('|').map(squash) : [dashed[1]!, squash(dashed[2]!)]
  const matched = canonical(id, known)
  if (matched === null || matched === '' || subtitle === undefined) return null
  return { id: matched, subtitle, description: rest.join(' | ') }
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

function recommendation(text: string, known: readonly string[]): Recommendation | null {
  const reason = unbold(text).trim()
  if (reason === '') return null
  const match = RECOMMENDED.exec(reason)
  const id = match === null ? null : canonical(match[1]!, known)
  return match === null || id === null ? { option: null, reason: squash(reason) } : { option: id, reason: squash(match[2]!) }
}

export function parsePickSummary(markdown: string, knownOptions: readonly string[] = []): ParsedSummary {
  const text = markdown.trim()
  const parts = sections(text)
  const isKnown = (heading: string): boolean => KNOWN.has(heading.toLowerCase())
  if (!parts.some(part => isKnown(part.heading))) return { structured: false, markdown: text }
  const named = (name: string): string => parts.filter(part => part.heading.toLowerCase() === name).map(part => part.markdown).filter(body => body !== '').join('\n')
  const unparsed: ExtraSection[] = []
  const entries = <T>(name: string, read: (line: string) => T | null): T[] => {
    const body = named(name)
    const found = bullets(body).map(read).filter((entry): entry is T => entry !== null)
    if (body !== '' && found.length === 0) unparsed.push({ heading: parts.find(part => part.heading.toLowerCase() === name)!.heading, markdown: body })
    return found
  }
  const points = named('points')
  const result = {
    structured: true as const,
    recommendation: recommendation(named('recommendation'), knownOptions),
    options: entries('options', line => option(line, knownOptions)),
    points: points === '' ? null : points,
    open: entries('still open', openChoice),
    outOfScope: entries('out of scope', line => line),
    facts: entries('facts', fact),
    tags: entries('tag', tag),
  }
  const extra = parts.filter(part => !isKnown(part.heading) && part.markdown !== '')
  return { ...result, extra: [...unparsed, ...extra] }
}
