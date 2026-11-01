import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowStore, forkSections, validateWorkflow, workflowSchema } from '../server/workflows'
import { PSTACK_FLOW_IDS, pstackFlows } from '../server/pstack-flows'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-pstack-flows-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const flows = () => pstackFlows().map(flow => workflowSchema.parse(flow))
const panelEngines = (flow: ReturnType<typeof flows>[number]) => forkSections(flow)[0]!.paths.flat().map(id => flow.nodes.find(node => node.id === id)!.agent.engine)

test('the seven pstack flows keep their ids', () => {
  expect(PSTACK_FLOW_IDS).toEqual(['pstack-arena', 'pstack-interrogate', 'pstack-swarm', 'pstack-how', 'pstack-why', 'pstack-reflect', 'pstack-thermos'])
  expect(pstackFlows().map(flow => flow.id)).toEqual([...PSTACK_FLOW_IDS])
})

for (const flow of flows()) {
  test(`${flow.id} is a valid read-only task and join graph with one cross-family fork`, () => {
    expect(validateWorkflow(flow)).toEqual([])
    expect(flow.nodes.every(node => node.kind === 'task' || node.kind === 'join')).toBe(true)
    const sections = forkSections(flow)
    expect(sections).toHaveLength(1)
    expect(flow.nodes.filter(node => node.kind === 'join')).toHaveLength(1)
    const engines = panelEngines(flow)
    expect(engines.every(Boolean)).toBe(true)
    expect(new Set(engines).size).toBe(engines.length)
    expect(engines).toHaveLength(flow.id === 'pstack-thermos' ? 2 : 3)
    expect(flow.nodes.filter(node => node.agent.engine === 'session' && sections[0]!.paths.flat().includes(node.id))).toEqual([])
  })
}

test('the store lists the default first, then the pstack flows, then saved flows', async () => {
  const store = createWorkflowStore(dir)
  const custom = await store.save({ ...flows()[0]!, id: 'custom', name: 'Custom' })
  const ids = (await store.list()).map(flow => flow.id)
  expect(ids).toEqual(['default', ...PSTACK_FLOW_IDS, custom.id])
})

test('a built-in pstack flow resolves with a stable revision, including its pinned revision after a restart', async () => {
  const first = await createWorkflowStore(dir).get('pstack-arena')
  expect(first.revision).toMatch(/^[a-f0-9]{24}$/)
  expect(first.name).toBe('pstack Arena')
  const restarted = createWorkflowStore(dir)
  expect((await restarted.get('pstack-arena', first.revision)).revision).toBe(first.revision)
  expect((await restarted.revisions('pstack-arena')).map(flow => flow.revision)).toEqual([first.revision])
})

test('saving over a built-in pstack flow is refused', async () => {
  const store = createWorkflowStore(dir)
  await expect(store.save({ ...flows()[0]!, name: 'Mine' })).rejects.toThrow('This flow is built in; save it under a new id to change it')
})
