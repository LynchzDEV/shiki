import { expect, test } from 'bun:test'

import { parsePickSummary } from '../client/queue-review-parse'

const FULL = `## Recommendation
B — It shows the full table in a panel that widens to 760px.
## Options
- A | Table in the panel | Squeezes the table.
- B | Wide panel | Full 5-column table | with a pipe in the description
- C | Summary in the panel | Moves the table into a pop-up.
## Points
| # | Feedback point | Still present? | File | Fix |
| - | - | - | - | - |
| 1 | Cannot type | Yes | \`a.erb\` | Fixed by #2. |
| 5 | No page | Yes | \`b.rb\` | Decision needed: pick a page. |

Affected specs are listed in the compare output.
## Still open
- #7 Promo replies | default: grey verdict, not scored | other hint: drop promo pairs
- #5 No page | default: keep blocked
## Out of scope
- First thing
- Second thing
## Facts
- 14 points | all still present on trunk
- army only
## Tag
- Natthida | assignee
- Kanchana | watcher
- Pranut
## Notes
Anything else goes after Summary.`

test('a structured summary yields every known section', () => {
  const parsed = parsePickSummary(FULL)
  if (!parsed.structured) throw new Error('expected structured')
  expect(parsed.recommendation).toEqual({ option: 'B', reason: 'It shows the full table in a panel that widens to 760px.' })
  expect(parsed.options).toEqual([
    { id: 'A', subtitle: 'Table in the panel', description: 'Squeezes the table.' },
    { id: 'B', subtitle: 'Wide panel', description: 'Full 5-column table | with a pipe in the description' },
    { id: 'C', subtitle: 'Summary in the panel', description: 'Moves the table into a pop-up.' },
  ])
  expect(parsed.points?.startsWith('| # | Feedback point')).toBe(true)
  expect(parsed.points?.endsWith('compare output.')).toBe(true)
  expect(parsed.open).toEqual([
    { id: '#7', label: 'Promo replies', default: 'grey verdict, not scored', hint: 'drop promo pairs' },
    { id: '#5', label: 'No page', default: 'keep blocked', hint: '' },
  ])
  expect(parsed.outOfScope).toEqual(['First thing', 'Second thing'])
  expect(parsed.facts).toEqual([{ value: '14 points', label: 'all still present on trunk' }, { value: 'army only', label: '' }])
  expect(parsed.tags).toEqual([{ name: 'Natthida', role: 'assignee' }, { name: 'Kanchana', role: 'watcher' }, { name: 'Pranut', role: 'assignee' }])
  expect(parsed.extra).toEqual([{ heading: 'Notes', markdown: 'Anything else goes after Summary.' }])
})

test('missing sections come back empty', () => {
  const parsed = parsePickSummary('## Options\n- A | One | First\n- B | Two | Second')
  if (!parsed.structured) throw new Error('expected structured')
  expect(parsed.recommendation).toBeNull()
  expect(parsed.points).toBeNull()
  expect([parsed.open, parsed.outOfScope, parsed.facts, parsed.tags, parsed.extra]).toEqual([[], [], [], [], []])
  expect(parsed.options).toHaveLength(2)
})

test('headings match case-insensitively and extra whitespace is ignored', () => {
  const parsed = parsePickSummary('\n\n##   RECOMMENDATION  \n\n  B   —   Because it is wide.  \n\n##  still OPEN\n  -   #7   Promo   |  default:  grey  |  other hint:  none  \n')
  if (!parsed.structured) throw new Error('expected structured')
  expect(parsed.recommendation).toEqual({ option: 'B', reason: 'Because it is wide.' })
  expect(parsed.open).toEqual([{ id: '#7', label: 'Promo', default: 'grey', hint: 'none' }])
})

test('a recommendation without a letter is just text', () => {
  const parsed = parsePickSummary('## Recommendation\nGo with the wide one, it reads best.')
  if (!parsed.structured) throw new Error('expected structured')
  expect(parsed.recommendation).toEqual({ option: null, reason: 'Go with the wide one, it reads best.' })
})

test('a summary without a known heading is unstructured markdown', () => {
  const text = '  Just a paragraph.\n\n### Not a level-2 heading\n\n- bullet  '
  expect(parsePickSummary(text)).toEqual({ structured: false, markdown: 'Just a paragraph.\n\n### Not a level-2 heading\n\n- bullet' })
  expect(parsePickSummary('## Something else\ntext')).toEqual({ structured: false, markdown: '## Something else\ntext' })
  expect(parsePickSummary('')).toEqual({ structured: false, markdown: '' })
})

test('text before the first heading is kept as an unnamed extra section', () => {
  const parsed = parsePickSummary('Intro line.\n## Options\n- A | One | First')
  if (!parsed.structured) throw new Error('expected structured')
  expect(parsed.extra).toEqual([{ heading: '', markdown: 'Intro line.' }])
})

test('a heading inside a fenced code block does not split the summary', () => {
  const parsed = parsePickSummary('## Points\n```\n## Options\n```\n| # |\n| - |')
  if (!parsed.structured) throw new Error('expected structured')
  expect(parsed.options).toEqual([])
  expect(parsed.points).toContain('## Options')
})

test('an option line without a subtitle bar is skipped', () => {
  const parsed = parsePickSummary('## Options\n- A only an id\n- B | Two | Second')
  if (!parsed.structured) throw new Error('expected structured')
  expect(parsed.options.map(option => option.id)).toEqual(['B'])
})
