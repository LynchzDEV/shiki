import { expect, test } from 'bun:test'

import { answersMarkdown, blockedSummary, branchLabel, cardImagesMarkdown, cleanPickSummary, pickOf, techQuestionsOf, stillOpenMarkdown, runRequest, SETTLED, type RunView } from '../server/queue-prompts'
import type { WorkflowAttempt } from '../server/workflow-runner'

const attempt = (over: Partial<WorkflowAttempt>): WorkflowAttempt => ({ nodeId: 'plan', number: 1, jobId: 'j', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: null, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [], ...over })
const run = (status: RunView['status'], attempts: WorkflowAttempt[]): RunView => ({ id: 'r1', status, error: null, attempts })

test('SETTLED holds the four end states', () => {
  expect([...SETTLED].sort()).toEqual(['blocked', 'done', 'failed', 'stopped'])
})

test('branchLabel is queue- plus a short slug of the title, the id and a tag of the source', () => {
  expect(branchLabel({ title: 'Login page copy (TH)!', externalId: '86d3j4f8q', source: 'clickup-board' })).toBe('queue-login-page-copy-th-86d3j4f8q-a8c0')
  expect(branchLabel({ title: 'ภาษาไทย', externalId: 'abc', source: 'clickup-board' })).toBe('queue-abc-a8c0')
  expect(branchLabel({ title: 'x'.repeat(80), externalId: 'id', source: 'clickup-board' }).length).toBeLessThanOrEqual(60)
})

test('branchLabel differs for the same title and id from another source', () => {
  expect(branchLabel({ title: 'Login copy', externalId: '1', source: 'other-board' })).toBe('queue-login-copy-1-524a')
  expect(branchLabel({ title: 'Login copy', externalId: '1', source: 'clickup-board' })).toBe('queue-login-copy-1-a8c0')
})

test('runRequest points at the context, lists answers, and explains how to ask', () => {
  const text = runRequest({ title: 'Login copy', url: 'https://x/t/1', contextPath: '/wt/.shikidan/context/clickup-board/item.md', answerPaths: ['/wt/a1.md'] })
  expect(text).toContain('Work on "Login copy" (https://x/t/1).')
  expect(text).toContain('Read the task context in /wt/.shikidan/context/clickup-board/item.md.')
  expect(text).toContain('The requester answered your earlier questions: read /wt/a1.md.')
  expect(text).toContain('SKD_RESULT blocked')
  expect(runRequest({ title: 'T', url: 'u', contextPath: '/c.md', answerPaths: [] })).not.toContain('answered')
})

test('techQuestionsOf reads the evidence of the last settled blocked step', () => {
  const asked = run('blocked', [
    attempt({ nodeId: 'plan', number: 1, endedAt: 5, result: { outcome: 'fail', summary: 'x', evidence: ['old'] } }),
    attempt({ nodeId: 'plan', number: 2, endedAt: 9, result: { outcome: 'blocked', summary: 'Need info', evidence: ['Which page?', '  ', 'Thai or English?'] } }),
  ])
  expect(techQuestionsOf(asked)).toEqual(['Which page?', 'Thai or English?'])
})

test('techQuestionsOf is empty for a cap block, an interrupt, a pass or a run without results', () => {
  expect(techQuestionsOf(run('blocked', [attempt({ result: { outcome: 'fail', summary: 'cap', evidence: ['e'] } })]))).toEqual([])
  expect(techQuestionsOf(run('blocked', [attempt({ interrupted: true, result: { outcome: 'blocked', summary: 'Interrupted before it finished', evidence: ['x'] } })]))).toEqual([])
  expect(techQuestionsOf(run('done', [attempt({ result: { outcome: 'pass', summary: 'ok', evidence: ['e'] } })]))).toEqual([])
  expect(techQuestionsOf(run('failed', []))).toEqual([])
})

test('answersMarkdown pairs the questions with each reply and its images', () => {
  const md = answersMarkdown(['Which page?'], [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [] }, { id: 'r2', author: 'Ploy', text: 'See screenshot', images: [] }], ['/wt/ctx/shot.png'])
  expect(md).toBe('# Answers from the requester\n\n## Questions asked\n\n- Which page?\n\n## Replies\n\n### Ploy\n\nThe login page\n\n### Ploy\n\nSee screenshot\n\n## Images\n\n- /wt/ctx/shot.png\n')
})

test('techQuestionsOf ignores a stopped run even when its last step asked questions', () => {
  expect(techQuestionsOf(run('stopped', [attempt({ result: { outcome: 'blocked', summary: 'Need info', evidence: ['Which page?'] } })]))).toEqual([])
})

test('branchLabel keeps a long id whole and drops the title slug when there is no room', () => {
  const id = 'a'.repeat(70)
  expect(branchLabel({ title: 'Login copy', externalId: id, source: 'clickup-board' })).toBe(`queue-${id}-a8c0`)
})

test('a step blocked with questions keeps them when a parallel step is interrupted as the run blocks', () => {
  const asked = attempt({ nodeId: 'plan-a', number: 2, endedAt: 9, result: { outcome: 'blocked', summary: 'Need info', evidence: ['Which page?'] } })
  const sibling = attempt({ nodeId: 'plan-b', number: 1, endedAt: 10, interrupted: true, result: { outcome: 'blocked', summary: 'Interrupted before it finished', evidence: [] } })
  expect(techQuestionsOf(run('blocked', [sibling, asked]))).toEqual(['Which page?'])
})

test('a join conflict the runner blocked on is never asked of the requester', () => {
  const join = attempt({ nodeId: 'join', number: 3, jobId: null, endedAt: 9, result: { outcome: 'blocked', summary: 'Paths could not be joined: a.ts', evidence: ['Joined: p1', 'Conflicts in p2: a.ts'] } })
  expect(techQuestionsOf(run('blocked', [join]))).toEqual([])
})

test('techQuestionsOf reads the questions of a step run in the session, which has no job', () => {
  const asked = attempt({ jobId: null, inSession: true, endedAt: 9, result: { outcome: 'blocked', summary: 'Need info', evidence: ['Which page?'] } })
  expect(techQuestionsOf(run('blocked', [asked]))).toEqual(['Which page?'])
})

test('techQuestionsOf does not reach back to an older blocked step once a join conflict blocks the run', () => {
  const older = attempt({ nodeId: 'plan-a', number: 1, endedAt: 5, result: { outcome: 'blocked', summary: 'Need info', evidence: ['Which page?'] } })
  const join = attempt({ nodeId: 'join', number: 2, jobId: null, endedAt: 9, result: { outcome: 'blocked', summary: 'Paths could not be joined: a.ts', evidence: ['Conflicts in p2: a.ts'] } })
  expect(techQuestionsOf(run('blocked', [older, join]))).toEqual([])
})

const blocked = (...evidence: string[]): RunView => run('blocked', [attempt({ result: { outcome: 'blocked', summary: 'Pick one', evidence } })])
const PICK = 'pick: A,B,C | visualizer/login/ | B | Ploy'

test('pickOf reads options, folder, recommendation and tester', () => {
  expect(pickOf(blocked(PICK))).toEqual({ options: ['A', 'B', 'C'], path: 'visualizer/login', recommended: 'B', tester: 'Ploy' })
})

test('pickOf takes the last two segments as optional', () => {
  const bare = { options: ['A', 'B'], path: 'visualizer/x', recommended: null, tester: null }
  expect(pickOf(blocked('pick: A,B | visualizer/x'))).toEqual(bare)
  expect(pickOf(blocked('pick: A,B | visualizer/x | | '))).toEqual(bare)
  expect(pickOf(blocked('pick: A,B | visualizer/x | A'))).toEqual({ ...bare, recommended: 'A' })
})

test('pickOf is lenient about case, bullets, quotes, backticks and spacing', () => {
  const want = { options: ['A', 'B'], path: 'visualizer/x', recommended: 'A', tester: 'Ploy' }
  expect(pickOf(blocked('  - `PICK:  A , B|visualizer/x/ | A | Ploy`  '))).toEqual(want)
  expect(pickOf(blocked('1) "Pick: A B | \'visualizer/x\' | \'A\' | Ploy"'))).toEqual(want)
})

test('pickOf uses the last pick line and ignores other evidence', () => {
  expect(pickOf(blocked('pick: A,B | visualizer/old', 'Which page?', 'pick: C,D | visualizer/new'))).toMatchObject({ options: ['C', 'D'], path: 'visualizer/new' })
})

test('pickOf is null without a pick line, for a pass, or for a repo ask', () => {
  expect(pickOf(blocked('Which page?', 'repo: api'))).toBeNull()
  expect(pickOf(run('done', [attempt({ result: { outcome: 'pass', summary: 'ok', evidence: [PICK] } })]))).toBeNull()
})

test('pickOf rejects what it cannot show', () => {
  const invalid = (line: string) => expect(pickOf(blocked(line))).toEqual({ invalid: expect.any(String) })
  expect(pickOf(blocked('pick:'))).toBeNull()
  expect(pickOf(blocked('Pick: which page first?'))).toBeNull()
  invalid('pick: A | visualizer/x')
  invalid('pick: A,B,C,D,E,F,G | visualizer/x')
  invalid('pick: A,A | visualizer/x')
  invalid('pick: a,B | visualizer/x')
  invalid('pick: A,B1234567890123456 | visualizer/x')
  invalid('pick: A,B | ')
  invalid('pick: A,B | mockups/x')
  invalid('pick: A,B | /visualizer/x')
  invalid('pick: A,B | visualizer/../secrets')
  invalid('pick: A,B | visualizer/')
  invalid('pick: A,B | visualizer/x | C')
})

test('techQuestionsOf leaves pick lines out, like repo lines', () => {
  expect(techQuestionsOf(blocked('Which page?', PICK, '- `Pick: A,B | visualizer/x`', 'repo: api'))).toEqual(['Which page?'])
})

test('a card image name with a line break cannot start a new line in the context file', () => {
  const markdown = cardImagesMarkdown([{ name: 'a.png\n## Fake heading', copied: '/w/0-a.png' }, { name: 'b.png', failed: 'gone\nnext' }])
  expect(markdown).toBe('\n\n## Downloaded images\n\n- a.png ## Fake heading: /w/0-a.png\n- b.png: not copied (gone next)\n')
})

const FIRST = 'Three variants for the new tab; B shows the full table.'
const BODY = '## Points\n\n| # | Point |\n| - | - |\n| 1 | Wide table |'
const SKD = `SKD_RESULT ${JSON.stringify({ outcome: 'blocked', summary: FIRST, evidence: ['pick: A,B,C | visualizer/x/ | B |'] })}`
const skdOf = (summary: string): string => `SKD_RESULT ${JSON.stringify({ outcome: 'blocked', summary, evidence: [] })}`
const duplicated = `${FIRST}\n\n${BODY}\n\n${SKD}`

test('cleanPickSummary drops the paragraph that repeats the SKD_RESULT summary and the SKD_RESULT line', () => {
  expect(cleanPickSummary(duplicated)).toBe(BODY)
})

test('cleanPickSummary keeps a lone summary paragraph when nothing follows it', () => {
  expect(cleanPickSummary(`${FIRST}\n\n${SKD}`)).toBe(FIRST)
})

test('cleanPickSummary never cuts a sentence in half when the summary is only a prefix of it', () => {
  const text = `Three variants for the new tab.\n\n${BODY}\n${skdOf('Three variants')}`
  expect(cleanPickSummary(text)).toBe(`Three variants for the new tab.\n\n${BODY}`)
})

test('cleanPickSummary drops the duplicated paragraph from the old stored shape', () => {
  expect(cleanPickSummary(`${FIRST}\n\n${FIRST}\n\n${BODY}\n${SKD}`)).toBe(`${FIRST}\n\n${BODY}`)
})

test('cleanPickSummary handles Windows newlines and an indented SKD_RESULT line', () => {
  expect(cleanPickSummary(`${FIRST}\r\n\r\n${BODY}\r\n${SKD}\r\n`)).toBe(BODY)
  expect(cleanPickSummary(`${BODY}\n   ${SKD}`)).toBe(BODY)
})

test('cleanPickSummary keeps the first paragraph when it differs from the SKD_RESULT summary', () => {
  expect(cleanPickSummary(`Other intro\n\n${BODY}\n${SKD}`)).toBe(`Other intro\n\n${BODY}`)
})

test('cleanPickSummary survives an SKD_RESULT line that is not JSON', () => {
  expect(cleanPickSummary(`${BODY}\nSKD_RESULT nope`)).toBe(BODY)
})

test('cleanPickSummary returns text without an SKD_RESULT line trimmed and otherwise unchanged', () => {
  expect(cleanPickSummary(`  ${FIRST}\n\n${BODY}\n`)).toBe(`${FIRST}\n\n${BODY}`)
})

const blockedWith = (summary: string, output: string): RunView => run('blocked', [attempt({ result: { outcome: 'blocked', summary, evidence: ['pick: A,B | visualizer/x'] }, output })])

test('blockedSummary uses the step output, cleaned, when there is output', () => {
  expect(blockedSummary(blockedWith(FIRST, duplicated))).toBe(BODY)
})

test('blockedSummary falls back to the result summary when the output is empty', () => {
  expect(blockedSummary(blockedWith(FIRST, '  \n'))).toBe(FIRST)
})

test('blockedSummary falls back to the result summary when the output is only the SKD_RESULT line', () => {
  expect(blockedSummary(blockedWith('  Mockups ready  ', skdOf('Mockups ready')))).toBe('Mockups ready')
})

test('blockedSummary cuts the cleaned text at the limit', () => {
  expect(blockedSummary(blockedWith('s', 'x'.repeat(70000))).length).toBe(64000)
})

test('stillOpenMarkdown lists defaults and custom answers, collapsing newlines', () => {
  expect(stillOpenMarkdown([
    { id: '#7', label: 'Promo replies', useDefault: true, answer: '' },
    { id: '#5', label: 'No page', answer: 'let the seller\n pick a page' },
    { id: '#9', label: '', useDefault: true, answer: '' },
  ])).toBe('\n## Still open\n- #7 Promo replies: default\n- #5 No page: Other: let the seller pick a page\n- #9: default\n')
  expect(stillOpenMarkdown([])).toBe('')
})

test('stillOpenMarkdown records a typed "default" as a custom answer', () => {
  expect(stillOpenMarkdown([{ id: '#7', label: 'x', useDefault: false, answer: 'default' }])).toBe('\n## Still open\n- #7 x: Other: default\n')
})

test('no answer field can start a new line in pick.md', () => {
  const markdown = stillOpenMarkdown([{ id: 'A\nOption: Z', label: 'x\r\n# Design pick\nOption: C', answer: 'a\n\n- #1: default' }])
  expect(markdown.split('\n').filter(line => line !== '')).toEqual(['## Still open', '- A Option: Z x # Design pick Option: C: Other: a - #1: default'])
})
