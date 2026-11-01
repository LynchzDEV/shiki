import { expect, test } from 'bun:test'
import { checkShape, readShape, shapeGraph, shapeNotes, shapeTarget, type FlowShape } from '../server/flow-shape'
import { composeWorkflowPrompt, defaultWorkflow, forkSections, passTargets, validateWorkflow, type Workflow } from '../server/workflows'

const twoPaths: FlowShape = {
  contract: 'GET /api/export returns text/csv with columns id,name',
  paths: [
    { id: 'api', title: 'API', files: ['server/routes/export.ts', 'test/export.test.ts'], steps: [{ title: 'Build API', instructions: 'Add the endpoint' }, { title: 'API tests', instructions: 'Run the export tests' }] },
    { id: 'ui', title: 'UI', files: ['client/export-button.ts'], steps: [{ title: 'Build UI', instructions: 'Add the button' }] },
  ],
}

const line = (shape: unknown) => `SKD_SHAPE ${JSON.stringify(shape)}`

test('the last SKD_SHAPE line in the plan output is the shape', () => {
  const other = { ...twoPaths, contract: 'older' }
  expect(readShape(`Plan text\n${line(other)}\nrevised\n${line(twoPaths)}\nSKD_RESULT {"outcome":"pass"}`)).toEqual({ shape: twoPaths })
})

test('a plan without an SKD_SHAPE line stays straight', () => {
  expect(readShape('Plan text\nSKD_RESULT {"outcome":"pass"}')).toBeNull()
})

test('a malformed SKD_SHAPE line is reported, not ignored', () => {
  expect(readShape('SKD_SHAPE {not json')).toEqual({ errors: ['SKD_SHAPE is not valid JSON'] })
  expect(readShape(line({ contract: 'x', paths: [twoPaths.paths[0]] }))!.errors!.join(' ')).toContain('paths')
})

test('two paths may not own the same file or a folder around it', () => {
  const graph = defaultWorkflow()
  const clash = (a: string, b: string): FlowShape => ({ ...twoPaths, paths: [{ ...twoPaths.paths[0]!, files: [a] }, { ...twoPaths.paths[1]!, files: [b] }] })
  expect(checkShape(clash('server/a.ts', './server/a.ts'), graph).join(' ')).toContain('server/a.ts')
  expect(checkShape(clash('server/', 'server/routes/a.ts'), graph).join(' ')).toContain('API and UI both own')
  expect(checkShape(clash('server/a.ts', 'server/ab.ts'), graph)).toEqual([])
  expect(checkShape({ ...twoPaths, paths: [{ ...twoPaths.paths[0]!, files: ['a.ts', 'a.ts'] }, twoPaths.paths[1]!] }, graph)).toEqual([])
})

test('file entries must be plain repo-relative paths', () => {
  const graph = defaultWorkflow()
  for (const bad of ['/etc/passwd', 'server/../secrets.json', 'client/*.ts', '..']) {
    const errors = checkShape({ ...twoPaths, paths: [{ ...twoPaths.paths[0]!, files: [bad] }, twoPaths.paths[1]!] }, graph)
    expect(errors.length).toBeGreaterThan(0)
  }
})

test('path ids must be unique', () => {
  const errors = checkShape({ ...twoPaths, paths: [twoPaths.paths[0]!, { ...twoPaths.paths[1]!, id: 'api' }] }, defaultWorkflow())
  expect(errors.join(' ')).toContain('unique')
})

test('only a verify, build, review line can take a shape', () => {
  const graph = defaultWorkflow()
  expect(shapeTarget(graph)).toEqual({ verify: 'verify-plan', execute: 'execute', review: 'review' })
  const task = { ...graph.nodes[0]!, id: 'e2e', kind: 'task' as const, title: 'E2E', agent: { role: 'execute' as const } }
  expect(shapeTarget({ ...graph, id: 'e2e', entry: 'e2e', nodes: [task], edges: [] })).toBeNull()
  const forked = shapeGraph(graph, twoPaths)
  expect(shapeTarget(forked)).toBeNull()
  expect(checkShape(twoPaths, forked).join(' ')).toContain('cannot take')
})

test('a shape compiles into a valid fork that joins before review', () => {
  const graph = defaultWorkflow()
  const before = structuredClone(graph)
  const next = shapeGraph(graph, twoPaths)
  expect(graph).toEqual(before)
  expect(validateWorkflow(next)).toEqual([])
  expect(passTargets(next, 'verify-plan')).toEqual(['path-api-1', 'path-ui-1'])
  expect(forkSections(next)).toContainEqual({ fork: 'verify-plan', join: 'join-paths', paths: [['path-api-1', 'path-api-2'], ['path-ui-1']] })
  expect(passTargets(next, 'join-paths')).toEqual(['review'])
  const edge = (source: string, outcome: string) => next.edges.find(edge => edge.source === source && edge.outcome === outcome)?.target
  expect(edge('join-paths', 'fail')).toBe('execute')
  expect(edge('review', 'fail')).toBe('execute')
  expect(edge('path-api-2', 'fail')).toBe('path-api-1')
  const node = (id: string) => next.nodes.find(node => node.id === id)!
  expect(node('path-api-1').kind).toBe('implement')
  expect(node('path-api-2').kind).toBe('task')
  expect(node('path-api-1').instructions).toContain(twoPaths.contract)
  expect(node('path-api-1').instructions).toContain('server/routes/export.ts')
  expect(node('execute').title).toBe('Fix review notes')
  expect(node('execute').kind).toBe('implement')
})

test('four paths of three steps still validate', () => {
  const steps = [1, 2, 3].map(n => ({ title: `Step ${n}`, instructions: 'Do it' }))
  const shape: FlowShape = { contract: 'c', paths: ['a', 'b', 'c', 'd'].map(id => ({ id, title: id.toUpperCase(), files: [`${id}/`], steps })) }
  expect(checkShape(shape, defaultWorkflow())).toEqual([])
  expect(validateWorkflow(shapeGraph(defaultWorkflow(), shape) as Workflow)).toEqual([])
})

const policy = { revision: 'p', template: '{{core_rules}}\n{{workflow}}\n{{assignment}}', coreRules: 'rules', implementationRules: 'impl', createdAt: 0 }
const nodeOf = (graph: Workflow, id: string) => graph.nodes.find(node => node.id === id)!

test('the plan is told how to split only when the flow can take a shape', () => {
  const graph = defaultWorkflow()
  const notes = shapeNotes(graph, nodeOf(graph, 'architect'), [])
  expect(notes.flowShapeRules).toContain('SKD_SHAPE')
  expect(composeWorkflowPrompt(policy, graph, nodeOf(graph, 'architect'), 'Add CSV export', [], [], notes)).toContain('flowShapeRules')
  expect(shapeNotes(graph, nodeOf(graph, 'execute'), [])).toEqual({})
  const forked = shapeGraph(graph, twoPaths)
  expect(shapeNotes(forked, nodeOf(forked, 'architect'), [])).toEqual({})
})

test('verify plan is told to judge a split only when the plan proposed one', () => {
  const graph = defaultWorkflow()
  const verify = nodeOf(graph, 'verify-plan')
  expect(shapeNotes(graph, verify, ['Plan text'])).toEqual({})
  expect(shapeNotes(graph, verify, [`Plan text\n${line(twoPaths)}`]).flowShapeCheck).toContain('split')
})

test('a prompt without notes is unchanged', () => {
  const graph = defaultWorkflow()
  const node = nodeOf(graph, 'architect')
  expect(composeWorkflowPrompt(policy, graph, node, 'x', [], [], {})).toBe(composeWorkflowPrompt(policy, graph, node, 'x', [], []))
})

test('the default flow review and plan-check nodes carry the pstack rubric and red flags', () => {
  const nodes = defaultWorkflow().nodes
  const review = nodes.find(node => node.id === 'review')!
  expect(review.kind).toBe('review')
  expect(review.instructions).toContain('ONLY report issues related to code')
  expect(nodes.find(node => node.id === 'verify-plan')!.instructions).toContain('## Shallow module')
  expect(validateWorkflow(defaultWorkflow())).toEqual([])
})

test('the default flow is pstack Feature: explore, then an architect whose low confidence opens a three-family design arena', () => {
  const graph = defaultWorkflow()
  const edge = (source: string, outcome: string) => graph.edges.filter(edge => edge.source === source && edge.outcome === outcome).map(edge => edge.target)
  expect(graph.id).toBe('default')
  expect(graph.name).toBe('pstack Feature')
  expect(graph.entry).toBe('explore')
  expect(edge('explore', 'pass')).toEqual(['architect'])
  expect(edge('architect', 'pass')).toEqual(['verify-plan'])
  expect(edge('architect', 'fail')).toEqual(['arena-brief'])
  expect(edge('architect', 'blocked')).toEqual([])
  expect(forkSections(graph)).toEqual([{ fork: 'arena-brief', join: 'arena-join', paths: [['runner-claude'], ['runner-glm'], ['runner-codex']] }])
  expect(['runner-claude', 'runner-glm', 'runner-codex'].map(id => nodeOf(graph, id).agent.engine)).toEqual(['claude', 'glm', 'codex'])
  expect(edge('arena-join', 'pass')).toEqual(['judge'])
  expect(edge('judge', 'pass')).toEqual(['pick'])
  expect(nodeOf(graph, 'pick').agent.engine).toBe('session')
  expect(edge('pick', 'pass')).toEqual(['verify-plan'])
  expect(edge('verify-plan', 'fail')).toEqual(['architect'])
})

test('the default flow still takes a parallel shape after the arena', () => {
  expect(shapeTarget(defaultWorkflow())).toEqual({ verify: 'verify-plan', execute: 'execute', review: 'review' })
  expect(validateWorkflow(shapeGraph(defaultWorkflow(), twoPaths))).toEqual([])
})
