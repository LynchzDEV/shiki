import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CORE_RULES, createWorkflowStore, defaultWorkflow, draftRevision, forkSections, passTargets, validateWorkflow, workflowSchema, composeWorkflowPrompt } from '../server/workflows'
import { classicWorkflow } from './support/classic-workflow'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-workflows-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('saving a blueprint preserves older revisions and default selection across restart', async () => {
  const store = createWorkflowStore(dir)
  const first = await store.save({ ...defaultWorkflow(), id: 'custom', name: 'My workflow' })
  const second = await store.save({ ...first, name: 'Revised workflow' }, first.revision)
  await store.setDefault('custom', first.revision)
  const restarted = createWorkflowStore(dir)
  expect((await restarted.get('custom', first.revision)).name).toBe('My workflow')
  expect((await restarted.get('custom')).revision).toBe(second.revision)
  expect((await restarted.selected()).revision).toBe(first.revision)
  await expect(store.save(first, first.revision)).rejects.toThrow('changed')
})

test('implementation cannot skip plan verification or finish without review on any success path', () => {
  const graph = defaultWorkflow()
  expect(validateWorkflow(graph)).toEqual([])
  expect(validateWorkflow({ ...graph, entry: 'execute' }).join(' ')).toContain('verified plan')
  expect(validateWorkflow({ ...graph, edges: graph.edges.filter(edge => edge.source !== 'execute') }).join(' ')).toContain('review')
})

test('arbitrary test tasks need no implementation checkpoints, ambiguous edges are rejected', () => {
  const node = { ...defaultWorkflow().nodes[0]!, id: 'e2e', kind: 'task', title: 'E2E with Jev' }
  const graph = { ...defaultWorkflow(), id: 'e2e', entry: 'e2e', nodes: [node], edges: [] }
  expect(validateWorkflow(graph)).toEqual([])
  expect(validateWorkflow({ ...graph, edges: [{ source: 'e2e', target: 'e2e', outcome: 'fail' }, { source: 'e2e', target: 'e2e', outcome: 'fail' }] }).join(' ')).toContain('one edge')
})

test('prompt composition keeps mandatory rules, resolved workflow and task separate', async () => {
  const store = createWorkflowStore(dir)
  const policy = await store.policy()
  const graph = defaultWorkflow()
  const rendered = composeWorkflowPrompt(policy, graph, graph.nodes[0]!, 'Inspect project', [])
  expect(rendered).toContain('Never dispatch')
  expect(rendered).toContain('SKD_RESULT')
  expect(rendered).toContain('Inspect project')
  expect(rendered).not.toContain('{{workflow}}')
  await expect(store.savePolicy('Only {{assignment}}')).rejects.toThrow('core_rules')
})

test('policy revisions retain implementation rules without requiring them for research tasks', async () => {
  const store = createWorkflowStore(dir)
  const policy = await store.policy()
  const graph = classicWorkflow()
  expect(composeWorkflowPrompt(policy, graph, graph.nodes[2]!, 'Implement', [])).toContain("language's conventions")
  expect(composeWorkflowPrompt(policy, graph, graph.nodes[0]!, 'Research', [])).not.toContain("language's conventions")
  const next = await store.savePolicy('Team instructions\n{{core_rules}}\n{{workflow}}\n{{assignment}}')
  expect(next.revision).not.toBe(policy.revision)
  expect((await store.policy(policy.revision)).template).toBe(policy.template)
  expect((await store.policyRevisions()).map(item => item.revision)).toContain(next.revision)
})

test('graph validation rejects stale verification after replanning and unreachable nodes', () => {
  const graph = classicWorkflow()
  graph.edges.push({ source: 'execute', target: 'plan', outcome: 'fail' })
  expect(validateWorkflow(graph)).toEqual([])
  graph.edges.push({ source: 'plan', target: 'execute', outcome: 'fail' })
  expect(validateWorkflow(graph).join(' ')).toContain('verified plan')
  expect(validateWorkflow({ ...classicWorkflow(), nodes: [...classicWorkflow().nodes, { id: 'lost', title: 'Lost', instructions: 'Inspect' }] }).join(' ')).toContain('reachable')
})

test('draftRevision stamps a valid graph and rejects one that breaks a safety rule', () => {
  const draft = draftRevision({ ...classicWorkflow(), id: 'drafted', name: 'Drafted' })
  expect(draft.revision).toMatch(/^[a-f0-9]{24}$/)
  expect(draft.name).toBe('Drafted')
  const unsafe = { ...classicWorkflow(), id: 'unsafe', name: 'Unsafe', edges: [{ source: 'plan', target: 'execute', outcome: 'pass' }] }
  expect(() => draftRevision(unsafe)).toThrow('requires a verified plan')
})

type Kind = 'task' | 'plan' | 'verify-plan' | 'implement' | 'review' | 'join'
type Link = [string, 'pass' | 'fail' | 'blocked', string]
function step(id: string, kind: Kind = 'task', extra: Record<string, unknown> = {}) {
  return { id, title: id[0]!.toUpperCase() + id.slice(1), kind, instructions: 'Do it', ...extra }
}
function flow(nodes: ReturnType<typeof step>[], links: Link[], entry = nodes[0]!.id) {
  return { id: 'forked', name: 'Forked', entry, nodes, edges: links.map(([source, outcome, target]) => ({ source, outcome, target })) }
}
const forkSteps = () => [step('plan', 'plan'), step('verify', 'verify-plan'), step('split'), step('a', 'implement'), step('b', 'implement'), step('join', 'join'), step('review', 'review')]
const forkLinks = (): Link[] => [['plan', 'pass', 'verify'], ['verify', 'pass', 'split'], ['split', 'pass', 'a'], ['split', 'pass', 'b'], ['a', 'pass', 'join'], ['b', 'pass', 'join'], ['join', 'pass', 'review']]
const errorsOf = (graph: unknown) => validateWorkflow(graph).join('\n')

test('a step with two pass edges splits into paths that meet at one join', () => {
  const graph = flow(forkSteps(), forkLinks())
  expect(validateWorkflow(graph)).toEqual([])
  expect(forkSections(workflowSchema.parse(graph))).toEqual([{ fork: 'split', join: 'join', paths: [['a'], ['b']] }])
  expect(passTargets(graph, 'split')).toEqual(['a', 'b'])
})

test('every path of a split must reach the same join', () => {
  const links = forkLinks().map(([source, outcome, target]): Link => source === 'b' ? ['b', outcome, 'review'] : [source, outcome, target])
  expect(errorsOf(flow(forkSteps(), links))).toContain('Split paths must meet at one join')
})

test('a split cannot send a path straight to its join', () => {
  expect(errorsOf(flow(forkSteps(), [...forkLinks(), ['split', 'pass', 'join']]))).toContain('Split has a path with no steps')
})

test('a join must close exactly one split', () => {
  expect(errorsOf(flow([...forkSteps(), step('join2', 'join')], [...forkLinks(), ['review', 'pass', 'join2']]))).toContain('Join2 must close exactly one fork')
})

test('failure loops stay inside their own path', () => {
  expect(errorsOf(flow(forkSteps(), [...forkLinks(), ['a', 'fail', 'b']]))).toContain('An edge from A crosses into another path')
  expect(errorsOf(flow(forkSteps(), [...forkLinks(), ['a', 'fail', 'review']]))).toContain('A: loops must stay inside one path')
  const looped = flow([...forkSteps(), step('fix-a', 'implement')], [...forkLinks(), ['a', 'fail', 'fix-a'], ['fix-a', 'pass', 'a']])
  expect(validateWorkflow(looped)).toEqual([])
  expect(forkSections(workflowSchema.parse(looped))[0]!.paths[0]).toEqual(['a', 'fix-a'])
})

test('only a split own paths lead into its join', () => {
  expect(errorsOf(flow(forkSteps(), [...forkLinks(), ['review', 'fail', 'join']]))).toContain('Join can only be reached from its own paths')
})

test('a path can split again and its sections are listed outermost first', () => {
  const nodes = [step('split'), step('a'), step('a1'), step('a2'), step('join-a', 'join'), step('a3'), step('b'), step('join', 'join')]
  const graph = flow(nodes, [['split', 'pass', 'a'], ['split', 'pass', 'b'], ['a', 'pass', 'a1'], ['a', 'pass', 'a2'], ['a1', 'pass', 'join-a'], ['a2', 'pass', 'join-a'], ['join-a', 'pass', 'a3'], ['a3', 'pass', 'join'], ['b', 'pass', 'join']])
  expect(validateWorkflow(graph)).toEqual([])
  expect(forkSections(workflowSchema.parse(graph))).toEqual([
    { fork: 'split', join: 'join', paths: [['a', 'a1', 'a2', 'join-a', 'a3'], ['b']] },
    { fork: 'a', join: 'join-a', paths: [['a1'], ['a2']] },
  ])
})

test('reviews inside each path do not stand in for a review of the joined result', () => {
  const nodes = [...forkSteps().filter(node => node.id !== 'review'), step('ra', 'review'), step('rb', 'review')]
  const links: Link[] = [['plan', 'pass', 'verify'], ['verify', 'pass', 'split'], ['split', 'pass', 'a'], ['split', 'pass', 'b'], ['a', 'pass', 'ra'], ['b', 'pass', 'rb'], ['ra', 'pass', 'join'], ['rb', 'pass', 'join']]
  expect(errorsOf(flow(nodes, links))).toContain('Join cannot finish successfully without a subsequent review')
})

test('a join runs no agent and only a split carries setup commands', () => {
  const check = { command: 'true' }
  const withCheck = forkSteps().map(node => node.id === 'join' ? { ...node, checks: [check] } : node)
  expect(errorsOf(flow(withCheck, forkLinks()))).toContain('Join: a join runs no agent')
  const withSetup = forkSteps().map(node => node.id === 'a' ? { ...node, setup: [check] } : node)
  expect(errorsOf(flow(withSetup, forkLinks()))).toContain('A: only a step that splits can have setup commands')
  const splitSetup = forkSteps().map(node => node.id === 'split' ? { ...node, setup: [{ command: 'bun', args: ['install'] }] } : node)
  expect(validateWorkflow(flow(splitSetup, forkLinks()))).toEqual([])
})

test('a step still has at most one failure edge', () => {
  expect(errorsOf(flow(forkSteps(), [...forkLinks(), ['a', 'fail', 'plan'], ['a', 'fail', 'verify']]))).toContain('Only one edge per node outcome is allowed')
})

test('the big-flow fixture is a valid 22-step flow with two splits, a nested split and loops', async () => {
  const graph = JSON.parse(await Bun.file(join(import.meta.dir, 'fixtures/big-flow.json')).text())
  expect(validateWorkflow(graph)).toEqual([])
  expect(graph.nodes).toHaveLength(22)
  expect(forkSections(workflowSchema.parse(graph)).map(section => [section.fork, section.join])).toEqual([['split', 'join'], ['split2', 'join2'], ['ui-split', 'ui-join']])
})

test('the built-in default designs In Session and loops failed checks back to the step they judge', () => {
  const graph = defaultWorkflow()
  for (const id of ['architect', 'pick']) expect(graph.nodes.find(node => node.id === id)!.agent.engine).toBe('session')
  expect(graph.edges).toContainEqual({ source: 'verify-plan', target: 'architect', outcome: 'fail' })
  expect(graph.edges).toContainEqual({ source: 'review', target: 'execute', outcome: 'fail' })
  expect(graph.nodes.find(node => node.id === 'architect')!.instructions).toContain('If an upstream plan check failed, revise the plan to fix every finding it lists.')
  expect(graph.nodes.find(node => node.id === 'execute')!.instructions).toContain('If an upstream review failed, fix every finding it lists.')
  expect(validateWorkflow(graph)).toEqual([])
})

test('In Session is only for plan and task steps', () => {
  const inSession = (kinds: string[]) => forkSteps().map(node => kinds.includes(node.id) ? { ...node, agent: { role: 'plan', engine: 'session' } } : node)
  expect(validateWorkflow(flow(inSession(['plan']), forkLinks()))).toEqual([])
  const errors = errorsOf(flow(inSession(['verify', 'review']), forkLinks()))
  expect(errors).toContain('Verify: In Session is for plan and task steps')
  expect(errors).toContain('Review: In Session is for plan and task steps')
})

test('In Session steps cannot run on a parallel path', () => {
  const nodes = [...forkSteps().filter(node => node.id !== 'a'), { ...step('a'), agent: { role: 'execute', engine: 'session' } }]
  expect(errorsOf(flow(nodes, forkLinks()))).toContain('A: In Session steps cannot run on a parallel path')
  const splitting = forkSteps().map(node => node.id === 'split' ? { ...node, agent: { role: 'execute', engine: 'session' } } : node)
  expect(validateWorkflow(flow(splitting, forkLinks()))).toEqual([])
})

test('with no saved choice the AI designs each flow on top of the built-in steps, and a saved default turns that off', async () => {
  const store = createWorkflowStore(dir)
  expect(await store.design()).toBe(true)
  expect((await store.selected()).id).toBe('default')
  const custom = await store.save({ ...defaultWorkflow(), id: 'custom', name: 'Mine' })
  await store.setDefault('custom', custom.revision)
  expect(await store.design()).toBe(false)
  expect((await store.selected()).id).toBe('custom')
  await store.setDesignDefault()
  const restarted = createWorkflowStore(dir)
  expect(await restarted.design()).toBe(true)
  expect((await restarted.selected()).id).toBe('default')
})

test('worker rules keep long commands in the foreground because a headless session ends with its turn', () => {
  const lines = CORE_RULES.split('\n')
  const foreground = lines.findIndex(line => line.includes('foreground') && line.includes('background') && line.includes('SKD_RESULT'))
  expect(foreground).toBeGreaterThan(-1)
  expect(foreground).toBeLessThan(lines.findIndex(line => line.startsWith('End your final response')))
})

test('plugin flows are listed, readable and read-only', async () => {
  const pluginFlow = { ...draftRevision({ id: 'card-pipeline--card-pipeline', name: 'Card pipeline: Card pipeline', entry: 'gate', nodes: [{ id: 'gate', title: 'Gate', instructions: 'Run it.', kind: 'task' }], edges: [] }), createdAt: 0, plugin: 'card-pipeline' }
  const store = createWorkflowStore(dir, { pluginFlows: async () => [pluginFlow] })
  expect((await store.list()).map(flow => flow.id)).toContain('card-pipeline--card-pipeline')
  expect((await store.get('card-pipeline--card-pipeline')).name).toBe('Card pipeline: Card pipeline')
  expect((await store.get('card-pipeline--card-pipeline', pluginFlow.revision)).revision).toBe(pluginFlow.revision)
  const { revision: _revision, createdAt: _createdAt, plugin: _plugin, ...graph } = pluginFlow
  await expect(store.save(graph, pluginFlow.revision)).rejects.toThrow('This flow comes from the card-pipeline plugin; save it under a new id to change it')
})

const landed = (land: unknown[]) => ({ ...defaultWorkflow(), land })
const auto = { id: 'uat', run: 'auto', command: { command: 'ship.sh' } }
const button = { id: 'prod', run: 'button', label: 'Deploy prod', command: { command: 'ship.sh' }, preflight: { command: 'check.sh' } }

test('a flow without land stages keeps the revision it had before land existed', () => {
  expect(draftRevision(defaultWorkflow()).revision).toBe('d91a841cdee32b2315bd26ce')
  expect(draftRevision(landed([auto])).revision).not.toBe('d91a841cdee32b2315bd26ce')
})

test('land stages accept an auto and a button stage with their defaults', () => {
  expect(validateWorkflow(landed([auto, button]))).toEqual([])
  const parsed = workflowSchema.parse(landed([auto, button]))
  expect(parsed.land[0]).toMatchObject({ env: {}, command: { args: [], timeoutSeconds: 3600 } })
  expect(workflowSchema.parse(defaultWorkflow()).land).toEqual([])
})

test('land stage rules: unique ids, button needs a label, preflight only on button, auto has no label', () => {
  expect(validateWorkflow(landed([auto, auto])).join(' ')).toContain('unique')
  expect(validateWorkflow(landed([{ ...button, label: undefined }])).join(' ')).toContain('needs a label')
  expect(validateWorkflow(landed([{ ...auto, preflight: { command: 'x' } }])).join(' ')).toContain('only a button stage can have a preflight')
  expect(validateWorkflow(landed([{ ...auto, label: 'Ship' }])).join(' ')).toContain('auto stage has no label')
})

test('land stage limits: at most 4 stages, timeout up to 2 hours, env values must be setting references', () => {
  expect(validateWorkflow(landed([1, 2, 3, 4, 5].map(n => ({ ...auto, id: `s${n}` }))))).not.toEqual([])
  expect(validateWorkflow(landed([{ ...auto, command: { command: 'x', timeoutSeconds: 7201 } }]))).not.toEqual([])
  expect(validateWorkflow(landed([{ ...auto, command: { command: 'x', timeoutSeconds: 7200 } }]))).toEqual([])
  expect(validateWorkflow(landed([{ ...auto, env: { TOKEN: 'plain' } }]))).not.toEqual([])
  expect(validateWorkflow(landed([{ ...auto, env: { TOKEN: 'setting:stagingLogin' } }]))).toEqual([])
})

test('a saved flow that is not from a plugin cannot reference plugin settings', async () => {
  const store = createWorkflowStore(dir)
  await expect(store.save({ ...landed([{ ...auto, env: { TOKEN: 'setting:stagingLogin' } }]), id: 'mine' })).rejects.toThrow('Setting references need a plugin flow')
  const saved = await store.save({ ...landed([auto, button]), id: 'mine' })
  expect(saved.land.map(stage => stage.id)).toEqual(['uat', 'prod'])
})
