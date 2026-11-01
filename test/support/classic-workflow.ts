import { REVIEW_STEP_INSTRUCTIONS, VERIFY_PLAN_STEP_INSTRUCTIONS } from '../../server/reviewer-prompts'
import { workflowSchema, type Workflow } from '../../server/workflows'

export function classicWorkflow(): Workflow {
  return workflowSchema.parse({ id: 'classic', name: 'Plan, verify, execute, review', entry: 'plan', nodes: [
    { id: 'plan', title: 'Plan', kind: 'plan', agent: { role: 'plan', engine: 'session' }, instructions: 'Inspect the request and repository. Produce a concrete implementation plan, affected files, constraints, and acceptance checks. Do not modify application code. If an upstream plan check failed, revise the plan to fix every finding it lists.' },
    { id: 'verify-plan', title: 'Verify plan', kind: 'verify-plan', agent: { role: 'review' }, instructions: VERIFY_PLAN_STEP_INSTRUCTIONS },
    { id: 'execute', title: 'Execute', kind: 'implement', agent: { role: 'execute' }, instructions: 'Implement the verified plan in this workspace. Follow repository conventions, create a regression test when appropriate, and run relevant checks. Report files changed and real test evidence. Do not make a commit unless the request explicitly asks. If an upstream review failed, fix every finding it lists.' },
    { id: 'review', title: 'Cross-family review', kind: 'review', agent: { role: 'review' }, instructions: REVIEW_STEP_INSTRUCTIONS },
  ].map((node, index) => ({ ...node, position: { x: index * 270, y: 100 } })), edges: [
    { source: 'plan', target: 'verify-plan', outcome: 'pass' },
    { source: 'verify-plan', target: 'execute', outcome: 'pass' },
    { source: 'verify-plan', target: 'plan', outcome: 'fail' },
    { source: 'review', target: 'execute', outcome: 'fail' },
    { source: 'execute', target: 'review', outcome: 'pass' },
  ] })
}
