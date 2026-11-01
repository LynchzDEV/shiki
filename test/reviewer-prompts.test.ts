import { describe, expect, test } from 'bun:test'
import { CODE_REVIEW_RUBRIC, PLAN_RED_FLAGS } from '../server/reviewer-prompts'

describe('reviewer prompts', () => {
  test('the code review rubric carries the diff-scope rule and critical rules', () => {
    expect(CODE_REVIEW_RUBRIC).toContain('ONLY report issues related to code that is being ADDED or MODIFIED')
    expect(CODE_REVIEW_RUBRIC).toContain('# Critical Rules')
  })

  test('the plan red flags list the design red flags', () => {
    expect(PLAN_RED_FLAGS).toContain('## Shallow module')
    expect(PLAN_RED_FLAGS).toContain('## Hand-synced list')
  })
})
