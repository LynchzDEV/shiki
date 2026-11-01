import type { z } from 'zod'
import { CODE_REVIEW_RUBRIC } from './reviewer-prompts'
import * as p from './pstack-prompts'
import type { workflowSchema } from './workflows'

export type PstackFlow = z.input<typeof workflowSchema>
type Step = PstackFlow['nodes'][number]
type Role = 'plan' | 'execute' | 'review'

export const PSTACK_FLOW_IDS = ['pstack-arena', 'pstack-interrogate', 'pstack-swarm', 'pstack-how', 'pstack-why', 'pstack-reflect', 'pstack-thermos'] as const

const SESSION = 'session'
const FAMILIES = [['claude', 'Claude'], ['glm', 'GLM'], ['codex', 'Codex']] as const
const COLUMN = 280
const ROW = 200

const step = (id: string, title: string, role: Role, engine: string | undefined, instructions: string): Step =>
  ({ id, title, kind: 'task', agent: { role, ...(engine ? { engine } : {}) }, instructions })

function flow(id: string, name: string, before: Step, panel: Step[], after: Step[]): PstackFlow {
  const join: Step = { id: 'join', title: 'Join', kind: 'join', instructions: `Collect the ${panel.length} panel results.` }
  const place = (node: Step, x: number, y: number): Step => ({ ...node, position: { x, y } })
  const middle = (panel.length - 1) * ROW / 2
  return {
    id, name, entry: before.id,
    nodes: [
      place(before, 0, middle),
      ...panel.map((node, index) => place(node, COLUMN, index * ROW)),
      place(join, COLUMN * 2, middle),
      ...after.map((node, index) => place(node, COLUMN * (3 + index), middle)),
    ],
    edges: [
      ...panel.flatMap(node => [{ source: before.id, target: node.id, outcome: 'pass' as const }, { source: node.id, target: 'join', outcome: 'pass' as const }]),
      ...[join, ...after].slice(0, -1).map((node, index) => ({ source: node.id, target: [join, ...after][index + 1]!.id, outcome: 'pass' as const })),
    ],
  }
}

const eachFamily = (id: string, title: string, role: Role, instructions: (family: string) => string) =>
  FAMILIES.map(([engine, name]) => step(`${id}-${engine}`, `${title} · ${name}`, role, engine, instructions(name)))

export function pstackFlows(): PstackFlow[] {
  return [
    flow('pstack-arena', 'pstack Arena',
      step('frame', 'Frame', 'plan', SESSION, p.ARENA_FRAME),
      eachFamily('candidate', 'Candidate', 'plan', p.ARENA_CANDIDATE),
      [step('judge', 'Judge', 'review', 'codex', p.ARENA_JUDGE), step('pick', 'Pick & graft', 'plan', SESSION, p.ARENA_PICK)]),
    flow('pstack-interrogate', 'pstack Interrogate',
      step('brief', 'Brief', 'plan', undefined, p.INTERROGATE_BRIEF),
      eachFamily('adversary', 'Adversary', 'review', () => p.INTERROGATE_ADVERSARY),
      [step('reproduce', 'Reproduce', 'review', 'codex', p.INTERROGATE_REPRODUCE)]),
    flow('pstack-swarm', 'pstack Swarm (race)',
      step('frame', 'Frame', 'plan', SESSION, p.SWARM_FRAME),
      eachFamily('worker', 'Worker', 'review', () => p.SWARM_WORKER),
      [step('aggregate', 'Aggregate', 'plan', SESSION, p.SWARM_AGGREGATE)]),
    flow('pstack-how', 'pstack How',
      step('scope', 'Scope', 'plan', undefined, p.HOW_SCOPE),
      [
        step('explorer-flow', 'Explorer · flow', 'plan', 'claude', p.HOW_EXPLORER('Entry points and the runtime flow: what triggers the subsystem, what runs in what order, and what each step passes on.')),
        step('explorer-data', 'Explorer · data', 'plan', 'glm', p.HOW_EXPLORER('Data model, state and persistence: the core types, where state lives, who owns it, and how it is stored and migrated.')),
        step('explorer-edges', 'Explorer · edges', 'plan', 'codex', p.HOW_EXPLORER('Boundaries, ownership and tests: where the subsystem meets the rest of the codebase, which layer owns what, and what the tests pin down.')),
      ],
      [step('explain', 'Explain', 'review', 'codex', p.HOW_EXPLAINER)]),
    flow('pstack-why', 'pstack Why',
      step('anchor', 'Anchor', 'plan', undefined, p.WHY_ANCHOR),
      [
        step('source-control', 'Investigator · source control', 'plan', 'claude', p.WHY_INVESTIGATOR('Source control', p.WHY_SOURCE_CONTROL)),
        step('discussion', 'Investigator · discussion', 'plan', 'glm', p.WHY_INVESTIGATOR('Issue and PR discussion', p.WHY_DISCUSSION)),
        step('docs', 'Investigator · docs', 'plan', 'codex', p.WHY_INVESTIGATOR('Documentation', p.WHY_DOCS)),
      ],
      [step('synthesize', 'Synthesize', 'review', 'codex', p.WHY_SYNTHESIZER)]),
    flow('pstack-reflect', 'pstack Reflect',
      step('scope', 'Scope', 'plan', undefined, p.REFLECT_SCOPE),
      [
        step('judgment', 'Reviewer · judgment', 'review', 'claude', p.REFLECT_JUDGMENT),
        step('tooling', 'Reviewer · tooling', 'review', 'glm', p.REFLECT_TOOLING),
        step('divergent', 'Reviewer · divergent', 'review', 'codex', p.REFLECT_DIVERGENT),
      ],
      [step('synthesize', 'Synthesize', 'review', 'codex', p.REFLECT_SYNTHESIZER), step('approve', 'Approve', 'plan', SESSION, p.REFLECT_APPROVE)]),
    flow('pstack-thermos', 'pstack Thermos',
      step('scope', 'Scope', 'plan', undefined, p.THERMOS_SCOPE),
      [
        step('security', 'Review · bugs & security', 'review', 'codex', p.THERMOS_SECURITY + CODE_REVIEW_RUBRIC),
        step('quality', 'Review · code quality', 'review', 'claude', p.THERMOS_QUALITY + p.CODE_QUALITY_RUBRIC),
      ],
      [step('dedupe', 'Dedupe', 'plan', SESSION, p.THERMOS_DEDUPE)]),
  ]
}
