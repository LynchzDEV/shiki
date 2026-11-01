import { describe, expect, test } from 'bun:test'

import { lintSpec } from '../server/spec-lint'

const FULL = `You are a Shikidan worker job: implement directly in this tree.
## Decisions
1. Match semantics: exact string equality.
## Preserve
- Response shape { jobs: [...] } (server/routes/jobs.ts:152).
## Steps
### Step 1 — server/routes/jobs.ts
Replace the handler with the code below.
### Step 2 — test/jobs-routes.test.ts
Add three tests.
## Tests
1. 'filters jobs' expects length 1.
Done means all of these hold, verified by you before you report:
1. The assignment's acceptance criteria are met.`

describe('lintSpec', () => {
  test('a full execution plan has no misses', () => {
    expect(lintSpec(FULL)).toEqual([])
  })

  test('a goal-shaped prompt misses every section', () => {
    expect(lintSpec('Goal: add a label filter.\nAcceptance:\n- works\nPointers:\n- server/routes/jobs.ts')).toEqual([
      'missing "## Decisions" section',
      'missing "## Preserve" section',
      'missing "## Steps" section or "execute tasks N..M of <plan file>" line',
      'missing acceptance baseline ("Done means all of these hold")',
    ])
  })

  test('a plan-file spec counts as steps', () => {
    const spec = FULL.replace(/## Steps[\s\S]*?## Tests/, 'Execute tasks 1..9 of docs/superpowers/plans/x.md in order.\n## Tests')
    expect(lintSpec(spec)).toEqual([])
  })

  test('hedged wording inside Decisions or Steps is a miss, elsewhere it is not', () => {
    expect(lintSpec(FULL.replace('exact string equality.', 'exact or prefix match, whichever fits.'))).toEqual([
      'hedged wording in Decisions: "whichever"',
    ])
    expect(lintSpec(FULL.replace('Add three tests.', 'Add tests as appropriate.'))).toEqual([
      'hedged wording in Steps: "as appropriate"',
    ])
    expect(lintSpec(FULL.replace('Every spec passes.', 'Every spec passes, as appropriate.'))).toEqual([])
  })

  test('a step without a file path is a miss', () => {
    expect(lintSpec(FULL.replace('### Step 2 — test/jobs-routes.test.ts', '### Step 2 — the tests'))).toEqual([
      'step 2 names no file path',
    ])
  })
})
