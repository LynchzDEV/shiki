import { z } from 'zod'
import { forkSections, nodeSchema, passTargets, validateWorkflow, type Workflow, type WorkflowNode } from './workflows'

const fileEntry = z.string().min(1).max(200)
  .refine(file => !file.startsWith('/') && !/^[A-Za-z]:/.test(file), 'must be relative to the repository')
  .refine(file => !file.split(/[\\/]/).includes('..'), 'must not use ..')
  .refine(file => !/[*?[\]{}]/.test(file), 'must not use wildcards')
  .refine(file => normalise(file) !== '', 'must name a file or folder')

export const shapeSchema = z.object({
  contract: z.string().trim().min(1).max(8000),
  paths: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9]{0,19}$/, 'use a short lowercase id'),
    title: z.string().trim().min(1).max(60),
    files: z.array(fileEntry).min(1).max(50),
    steps: z.array(z.object({ title: z.string().trim().min(1).max(120), instructions: z.string().trim().min(1).max(12000) })).min(1).max(3),
  })).min(2).max(4),
})
export type FlowShape = z.infer<typeof shapeSchema>
export type ShapeTarget = { verify: string; execute: string; review: string }

const JOIN_ID = 'join-paths'
const FIX_INSTRUCTIONS = 'Fix every finding from the failed review or join in upstream evidence, following the verified plan. Run the relevant checks. Report files changed and real test evidence. Do not make a commit unless the request explicitly asks.'

function normalise(file: string): string {
  return file.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
}

function schemaErrors(error: z.ZodError): string[] {
  return error.issues.map(issue => `SKD_SHAPE ${issue.path.join('.') || 'value'}: ${issue.message}`)
}

// ponytail: legacy MC_SHAPE from plans written before Shikidan, drop once no run predates it
const SHAPE_PREFIXES = ['SKD_SHAPE ', 'MC_SHAPE ']

export function readShape(output: string): { shape: FlowShape } | { errors: string[] } | null {
  const lines = output.split('\n').map(line => line.trim()).filter(line => SHAPE_PREFIXES.some(prefix => line.startsWith(prefix)))
  const last = lines.at(-1)
  if (!last) return null
  let value: unknown
  try { value = JSON.parse(last.slice(last.indexOf(' ') + 1)) } catch { return { errors: ['SKD_SHAPE is not valid JSON'] } }
  const parsed = shapeSchema.safeParse(value)
  return parsed.success ? { shape: parsed.data } : { errors: schemaErrors(parsed.error) }
}

export function shapeTarget(workflow: Workflow): ShapeTarget | null {
  const onPaths = new Set(forkSections(workflow).flatMap(section => section.paths.flat()))
  const kind = (id: string) => workflow.nodes.find(node => node.id === id)?.kind
  for (const verify of workflow.nodes.filter(node => node.kind === 'verify-plan' && !onPaths.has(node.id))) {
    const [execute, ...extra] = passTargets(workflow, verify.id)
    if (!execute || extra.length || execute === workflow.entry || kind(execute) !== 'implement') continue
    const [review, ...more] = passTargets(workflow, execute)
    if (review && !more.length && kind(review) === 'review') return { verify: verify.id, execute, review }
  }
  return null
}

function overlaps(shape: FlowShape): string[] {
  const owned = shape.paths.flatMap(path => [...new Set(path.files.map(normalise))].map(file => ({ path, file })))
  const errors: string[] = []
  for (const [index, a] of owned.entries()) {
    for (const b of owned.slice(index + 1)) {
      if (a.path.id === b.path.id) continue
      if (a.file === b.file || b.file.startsWith(`${a.file}/`) || a.file.startsWith(`${b.file}/`)) {
        errors.push(`${a.path.title} and ${b.path.title} both own ${a.file.length >= b.file.length ? a.file : b.file}`)
      }
    }
  }
  return errors
}

export function checkShape(value: unknown, workflow: Workflow): string[] {
  const parsed = shapeSchema.safeParse(value)
  if (!parsed.success) return schemaErrors(parsed.error)
  const shape = parsed.data
  const ids = shape.paths.map(path => path.id)
  if (new Set(ids).size !== ids.length) return ['SKD_SHAPE path ids must be unique']
  const errors = overlaps(shape)
  if (errors.length) return errors
  if (!shapeTarget(workflow)) return ['This flow cannot take a shape; it needs one build step between Verify plan and a review']
  return validateWorkflow(shapeGraph(workflow, shape))
}

function pathInstructions(shape: FlowShape, path: FlowShape['paths'][number], step: FlowShape['paths'][number]['steps'][number], repos?: readonly string[]): string {
  const copy = repos === undefined ? 'This folder is a fresh copy of the repository' : `This folder holds a fresh copy of each repo (${repos.join(', ')}) side by side`
  return `${step.instructions}\n\nShared contract (do not change it): ${shape.contract}\nOnly change these files: ${path.files.join(', ')}\n${copy}; install dependencies first if the step needs them.`
}

export function shapeGraph(workflow: Workflow, shape: FlowShape, repos?: readonly string[]): Workflow {
  const target = shapeTarget(workflow)
  if (!target) throw new Error('This flow cannot take a shape')
  const stepId = (path: FlowShape['paths'][number], index: number) => `path-${path.id}-${index + 1}`
  const pathNodes: WorkflowNode[] = shape.paths.flatMap(path => path.steps.map((step, index) => nodeSchema.parse({
    id: stepId(path, index), title: step.title, kind: index === 0 ? 'implement' : 'task', agent: { role: 'execute' }, instructions: pathInstructions(shape, path, step, repos),
  })))
  const join = nodeSchema.parse({ id: JOIN_ID, title: 'Join paths', kind: 'join', instructions: 'Join the parallel paths.' })
  const nodes = workflow.nodes.map(node => node.id === target.execute ? { ...node, title: 'Fix review notes', instructions: FIX_INSTRUCTIONS } : node)
  const kept = workflow.edges.filter(edge => !(edge.source === target.verify && edge.outcome === 'pass'))
  const pathEdges = shape.paths.flatMap(path => [
    { source: target.verify, target: stepId(path, 0), outcome: 'pass' as const },
    ...path.steps.slice(1).flatMap((_, index) => [
      { source: stepId(path, index), target: stepId(path, index + 1), outcome: 'pass' as const },
      { source: stepId(path, index + 1), target: stepId(path, 0), outcome: 'fail' as const },
    ]),
    { source: stepId(path, path.steps.length - 1), target: JOIN_ID, outcome: 'pass' as const },
  ])
  const joinEdges = [{ source: JOIN_ID, target: target.review, outcome: 'pass' as const }, { source: JOIN_ID, target: target.execute, outcome: 'fail' as const }]
  return { ...workflow, nodes: [...nodes, ...pathNodes, join], edges: [...kept, ...pathEdges, ...joinEdges] }
}

export const FLOW_SHAPE_RULES = 'Flow shape. After your plan, decide whether the work splits into parallel paths. Split only when all of these hold: the work has 2 to 4 parts that can each be built and tested on their own; each part owns its own files and no file or folder is listed by two parts; and everything the parts share (API shape, types, names, data format) is written in the contract, so no part has to guess what another decided. Otherwise do not split. Most tasks should stay one straight path; a split that saves little is not worth the merge risk. To split, put one line just before your SKD_RESULT line: SKD_SHAPE {"contract":"...","paths":[{"id":"api","title":"API","files":["..."],"steps":[{"title":"...","instructions":"..."}]}]}. Each path has 1 to 3 steps: the first builds, later steps check that path\'s own work and send it back to the first step when they fail. List files as repo-relative paths or folders, no wildcards. Shikidan turns this into parallel paths that meet at a join before review, and asks the user to approve the split.'
export const FLOW_SHAPE_CHECK = 'The plan proposes a split (SKD_SHAPE). Also check it: fail if any part needs a file another part owns, if the parts depend on anything missing from the contract, or if the work is too small or too connected to be worth splitting. Name the problem.'

export function shapeNotes(workflow: Workflow, node: WorkflowNode, upstreamOutputs: string[], repoRules = ''): { flowShapeRules?: string; flowShapeCheck?: string } {
  if (!shapeTarget(workflow)) return {}
  if (node.kind === 'plan') return { flowShapeRules: `${FLOW_SHAPE_RULES}${repoRules}` }
  if (node.kind === 'verify-plan' && upstreamOutputs.some(output => readShape(output))) return { flowShapeCheck: FLOW_SHAPE_CHECK }
  return {}
}
