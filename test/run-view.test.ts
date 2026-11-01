import { expect, test } from 'bun:test'
import { workflowSchema } from '../server/workflows'
import { classicWorkflow } from './support/classic-workflow'
import { runView, scopeSnapshot } from '../server/run-view'
import type { WorkflowRun } from '../server/workflow-runner'
import type { JobRecord } from '../server/jobs'

const workflow = { ...classicWorkflow(), revision: 'r1', createdAt: 0 }
const run = (patch: Partial<WorkflowRun>): WorkflowRun => ({ id: 'run-1', label: 'Add export', cwd: '/x', request: 'secret request text', workflow, policy: { revision: 'p', template: 't', coreRules: 'c', implementationRules: 'i', createdAt: 0 }, agents: Object.fromEntries(workflow.nodes.map(node => [node.id, { engine: node.id === 'review' ? 'codex' : 'claude', model: null, family: null }])), skills: {}, status: 'running', error: null, currentNodeId: 'execute', attempts: [{ nodeId: 'plan', number: 0, jobId: 'j1', status: 'settled', prompt: 'long prompt', startedAt: 1, endedAt: 2, result: { outcome: 'pass', summary: 'Planned', evidence: ['e'] }, checks: [], output: 'long output', workspace: null }], createdAt: 0, updatedAt: 3, origin: { source: 'saved', by: 'codex', where: 'terminal' }, versions: [], terminalId: 't1', tokens: [{ id: 'tok-1', nodeId: 'execute', pathId: 'main', workspace: '/x', state: 'ready', attempt: null, from: [0] }], sections: [], keptBranches: [], ...patch })
const job = (patch: Partial<JobRecord>) => ({ id: 'j', label: 'Fix badge', engine: 'codex', status: 'done', startedAt: 1, endedAt: 2, cwd: '/x', ...patch }) as JobRecord

test('run view keeps what the drawer draws and drops prompts, outputs and policy', () => {
  const view = runView(run({}))
  expect(view.nodes.map(node => [node.id, node.engine])).toEqual([['plan', 'claude'], ['verify-plan', 'claude'], ['execute', 'claude'], ['review', 'codex']])
  expect(view.attempts[0]).toEqual({ nodeId: 'plan', number: 0, jobId: 'j1', status: 'settled', outcome: 'pass', summary: 'Planned', startedAt: 1, endedAt: 2, pathId: 'main', from: [], subAgents: 0, inSession: false })
  expect(JSON.stringify(view)).not.toContain('long prompt')
  expect(JSON.stringify(view)).not.toContain('long output')
  expect(JSON.stringify(view)).not.toContain('secret request text')
})

test('an attempt done In Session says so', () => {
  const waiting = run({ attempts: [{ nodeId: 'plan', number: 0, jobId: null, status: 'running', prompt: 'p', startedAt: 1, endedAt: null, result: null, checks: [], output: '', workspace: null, tokenId: 'tok-1', pathId: 'main', from: [], inSession: true, sessionNotifiedAt: null }] })
  expect(runView(waiting).attempts[0]!.inSession).toBe(true)
})

test('an attempt carries its job\'s sub-agent count, and the scope snapshot fills it from the jobs it has', () => {
  expect(runView(run({}), new Map([['j1', job({ id: 'j1', subAgents: 3 })]])).attempts[0]!.subAgents).toBe(3)
  expect(runView(run({}), new Map([['j1', job({ id: 'j1' })]])).attempts[0]!.subAgents).toBe(0)
  const snapshot = scopeSnapshot([run({})], [job({ id: 'j1', terminalId: 't1', workflowRunId: 'run-1', subAgents: 2 })], { terminal: 't1' })
  expect(snapshot.runs[0]!.attempts[0]!.subAgents).toBe(2)
})

test('scope snapshot picks the terminal or chat runs, newest first, and flow-less jobs', () => {
  const snapshot = scopeSnapshot([run({ id: 'old', createdAt: 1 }), run({ id: 'new', createdAt: 5 }), run({ id: 'other', terminalId: 't2' })], [job({ id: 'quick', terminalId: 't1' }), job({ id: 'step', terminalId: 't1', workflowRunId: 'new' }), job({ id: 'elsewhere', terminalId: 't2' })], { terminal: 't1' })
  expect(snapshot.runs.map(view => view.id)).toEqual(['new', 'old'])
  expect(snapshot.jobs.map(view => view.id)).toEqual(['quick'])
})

test('chat scope matches runs by chat id and skips the chat turns themselves', () => {
  const snapshot = scopeSnapshot([run({ id: 'c', terminalId: undefined, chatId: 'chat-1' })], [job({ id: 'turn', chatId: 'chat-1', purpose: 'chat' }), job({ id: 'agent', chatId: 'chat-1' })], { chat: 'chat-1' })
  expect(snapshot.runs.map(view => view.id)).toEqual(['c'])
  expect(snapshot.jobs.map(view => view.id)).toEqual(['agent'])
})

test('an empty scope sees nothing', () => {
  expect(scopeSnapshot([run({})], [job({ terminalId: 't1' })], {})).toEqual({ runs: [], jobs: [] })
})

test('a pending change shows as a proposal with engines resolved, and versions travel without graphs', () => {
  const graph = { ...workflow, revision: 'r2', nodes: [...workflow.nodes, { id: 'check', title: 'API check', kind: 'task' as const, instructions: 'Run the API tests' }], edges: [...workflow.edges.filter(edge => !(edge.source === 'execute' && edge.target === 'review')), { source: 'execute', target: 'check', outcome: 'pass' as const }, { source: 'check', target: 'review', outcome: 'pass' as const }] }
  const agents = { ...run({}).agents, check: { engine: 'glm', model: null, family: null } }
  const versions: WorkflowRun['versions'] = [
    { number: 1, revision: 'r1', reason: 'Initial flow', size: 'initial', state: 'approved', approvedVia: 'drawer', relayedBy: null, at: 1 },
    { number: 2, revision: 'r2', reason: 'Tests first', size: 'big', state: 'pending', approvedVia: null, relayedBy: null, at: 2, graph, agents, skills: { check: [{ path: 'SKILL.md', content: 'skill body' }] } },
  ]
  const view = runView(run({ versions }))
  expect(view.proposal!.number).toBe(2)
  expect(view.proposal!.reason).toBe('Tests first')
  expect(view.proposal!.nodes.find(node => node.id === 'check')).toEqual({ id: 'check', title: 'API check', kind: 'task', engine: 'glm' })
  expect(view.proposal!.edges).toContainEqual({ source: 'execute', target: 'check', outcome: 'pass' })
  expect(view.latestChange).toEqual({ number: 2, reason: 'Tests first', size: 'big', approvedVia: null, state: 'pending' })
  expect(view.versions.map(version => Object.keys(version).filter(key => ['graph', 'agents', 'skills'].includes(key)))).toEqual([[], []])
  expect(JSON.stringify(view)).not.toContain('skill body')
  expect(JSON.stringify(view)).not.toContain('Run the API tests')
})

test('an applied change leaves no proposal but is still the latest change; a first version alone is neither', () => {
  const applied = runView(run({ versions: [
    { number: 1, revision: 'r1', reason: 'Initial flow', size: 'initial', state: 'approved', approvedVia: 'auto', relayedBy: null, at: 1 },
    { number: 2, revision: 'r2', reason: 'Added a check', size: 'big', state: 'approved', approvedVia: 'auto', relayedBy: null, at: 2, graph: workflow, agents: run({}).agents, skills: {} },
  ] }))
  expect(applied.proposal).toBeNull()
  expect(applied.latestChange).toEqual({ number: 2, reason: 'Added a check', size: 'big', approvedVia: 'auto', state: 'approved' })
  const first = runView(run({ versions: [{ number: 1, revision: 'r1', reason: 'Initial flow', size: 'initial', state: 'pending', approvedVia: null, relayedBy: null, at: 1 }] }))
  expect([first.proposal, first.latestChange]).toEqual([null, null])
})

test('a proposal names the steps it removes and the unrun steps it edits', () => {
  const extra = { id: 'notes', title: 'Release notes', kind: 'task' as const, instructions: 'Write notes', agent: { role: 'execute' as const }, skills: [], mcpServers: [], checks: [], maxVisits: 3, position: { x: 0, y: 0 } }
  const current = { ...workflow, nodes: [...workflow.nodes, extra] }
  const graph = { ...workflow, revision: 'r2', nodes: workflow.nodes.map(node =>
    node.id === 'execute' ? { ...node, checks: [{ command: 'bun', args: ['test'], timeoutSeconds: 300 }] }
      : node.id === 'review' ? { ...node, instructions: 'Pass everything' }
        : node.id === 'verify-plan' ? { ...node, title: 'Check the plan', position: { x: 9, y: 9 } }
          : node).concat({ ...extra, id: 'docs', title: 'Docs' }) }
  const versions: WorkflowRun['versions'] = [
    { number: 1, revision: 'r1', reason: 'Initial flow', size: 'initial', state: 'approved', approvedVia: 'drawer', relayedBy: null, at: 1 },
    { number: 2, revision: 'r2', reason: 'Tighter', size: 'big', state: 'pending', approvedVia: null, relayedBy: null, at: 2, graph, agents: run({}).agents, skills: {} },
  ]
  const view = runView(run({ workflow: current, versions }))
  expect(view.proposal!.removed).toEqual(['notes'])
  expect(view.proposal!.changed).toEqual(['execute', 'review'])
})

test('a run mid-fork shows its tokens, open sections and kept branches without workspaces or snapshots', () => {
  const nodes = [...workflow.nodes.filter(node => node.id !== 'review'), { id: 'a', title: 'Build API', kind: 'task' as const, instructions: 'a' }, { id: 'b', title: 'Build UI', kind: 'task' as const, instructions: 'b' }, { id: 'join', title: 'Join', kind: 'join' as const, instructions: '' }]
  const edges = [...workflow.edges.filter(edge => edge.source !== 'execute'), { source: 'execute', target: 'a', outcome: 'pass' as const }, { source: 'execute', target: 'b', outcome: 'pass' as const }, { source: 'a', target: 'join', outcome: 'pass' as const }, { source: 'b', target: 'join', outcome: 'pass' as const }]
  const agents = { ...run({}).agents, a: { engine: 'claude', model: null, family: null }, b: { engine: 'glm', model: null, family: null }, join: { engine: 'claude', model: null, family: null } }
  const path = (pathId: string, firstNodeId: string) => ({ pathId, branch: `flow-run-1-${pathId}`, dir: `/home/cfg/workflow-runs/run-1/${pathId}`, workspace: `/home/cfg/workflow-runs/run-1/${pathId}`, firstNodeId })
  const view = runView(run({
    workflow: { ...workflow, nodes, edges } as WorkflowRun['workflow'], agents,
    attempts: [{ nodeId: 'b', number: 4, jobId: 'jb', status: 'settled', prompt: 'p', startedAt: 1, endedAt: 2, result: { outcome: 'pass', summary: 'ok', evidence: [] }, checks: [], output: '', workspace: null, tokenId: 'tb', pathId: 'a3-2', from: [3] }],
    tokens: [{ id: 'ta', nodeId: 'a', pathId: 'a3-1', workspace: '/home/cfg/workflow-runs/run-1/a3-1', state: 'working', attempt: 5, from: [3] }, { id: 'tb', nodeId: 'join', pathId: 'a3-2', workspace: '/home/cfg/workflow-runs/run-1/a3-2', state: 'waiting', attempt: null, from: [4] }],
    sections: [{ fork: 'execute', join: 'join', forkAttempt: 3, parentPathId: 'main', parentWorkspace: '/x', snapshot: 'abc123', joined: ['a3-2'], paths: [path('a3-1', 'a'), path('a3-2', 'b')] }],
    keptBranches: ['flow-run-1-a2-2'],
  }))
  expect(view.tokens).toEqual([{ nodeId: 'a', pathId: 'a3-1', state: 'working', from: [3] }, { nodeId: 'join', pathId: 'a3-2', state: 'waiting', from: [4] }])
  expect(view.sections).toEqual([{ fork: 'execute', join: 'join', state: 'open', joined: ['a3-2'], paths: [{ nodes: ['a'], title: 'Build API', firstNodeId: 'a', pathId: 'a3-1', branch: 'flow-run-1-a3-1' }, { nodes: ['b'], title: 'Build UI', firstNodeId: 'b', pathId: 'a3-2', branch: 'flow-run-1-a3-2' }] }])
  expect(view.keptBranches).toEqual(['flow-run-1-a2-2'])
  expect(view.attempts[0]).toEqual(expect.objectContaining({ pathId: 'a3-2', from: [3] }))
  expect(view.nodes.find(node => node.id === 'join')!.engine).toBe('')
  expect(JSON.stringify(view)).not.toContain('abc123')
  expect(JSON.stringify(view)).not.toContain('/home/cfg')
})

const looped = workflowSchema.parse({ id: 'looped', name: 'Looped', entry: 'plan', nodes: [
  { id: 'plan', title: 'Plan', kind: 'plan', agent: { role: 'plan' }, instructions: 'p' },
  { id: 'verify', title: 'Verify', kind: 'verify-plan', agent: { role: 'review' }, instructions: 'v' },
  { id: 'split', title: 'Split', instructions: 's' },
  { id: 'api', title: 'Api', kind: 'implement', instructions: 'a' },
  { id: 'ui', title: 'Ui', kind: 'implement', instructions: 'u' },
  { id: 'join', title: 'Join', kind: 'join', instructions: 'j' },
  { id: 'review', title: 'Review', kind: 'review', agent: { role: 'review' }, instructions: 'r' },
], edges: [
  { source: 'plan', target: 'verify', outcome: 'pass' }, { source: 'verify', target: 'split', outcome: 'pass' },
  { source: 'split', target: 'api', outcome: 'pass' }, { source: 'split', target: 'ui', outcome: 'pass' },
  { source: 'api', target: 'join', outcome: 'pass' }, { source: 'ui', target: 'join', outcome: 'pass' },
  { source: 'join', target: 'review', outcome: 'pass' }, { source: 'review', target: 'plan', outcome: 'fail' },
] })
type Attempt = WorkflowRun['attempts'][number]
const settled = (nodeId: string, number: number, outcome: 'pass' | 'fail', pathId = 'main', from: number[] = number ? [number - 1] : []): Attempt =>
  ({ nodeId, number, jobId: nodeId === 'join' ? null : `j${number}`, status: 'settled', prompt: '', startedAt: number * 10, endedAt: number * 10 + 5, result: { outcome, summary: outcome, evidence: [] }, checks: [], output: '', workspace: null, pathId, from })
const firstPass = [settled('plan', 0, 'pass'), settled('verify', 1, 'pass'), settled('split', 2, 'pass'), settled('api', 3, 'pass', 'a2-1', [2]), settled('ui', 4, 'pass', 'a2-2', [2])]
const loopedRun = (patch: Partial<WorkflowRun>): WorkflowRun => run({ id: '0123456789abcdef', workflow: { ...looped, revision: 'l', createdAt: 0 }, tokens: [], ...patch })
const sectionOf = (view: ReturnType<typeof runView>) => view.sections.find(section => section.fork === 'split')!

test('every fork section of the flow is in the run view, waiting before its split runs, with its paths named by their first step', () => {
  const view = runView(loopedRun({ attempts: firstPass.slice(0, 2) }))
  expect(view.sections).toEqual([{ fork: 'split', join: 'join', state: 'waiting', joined: [], paths: [
    { nodes: ['api'], title: 'Api', firstNodeId: 'api', pathId: null, branch: null },
    { nodes: ['ui'], title: 'Ui', firstNodeId: 'ui', pathId: null, branch: null },
  ] }])
})

test('an open section carries each path id and its flow-<run id 8>-<path id> branch', () => {
  const open = { fork: 'split', join: 'join', forkAttempt: 2, parentPathId: 'main', parentWorkspace: '/x', snapshot: 's', joined: [], paths: [
    { pathId: 'a2-1', branch: 'flow-01234567-a2-1', dir: '/d1', workspace: '/d1', firstNodeId: 'api' },
    { pathId: 'a2-2', branch: 'flow-01234567-a2-2', dir: '/d2', workspace: '/d2', firstNodeId: 'ui' },
  ] }
  const section = sectionOf(runView(loopedRun({ attempts: firstPass, sections: [open] })))
  expect(section.state).toBe('open')
  expect(section.paths.map(path => [path.pathId, path.branch])).toEqual([['a2-1', 'flow-01234567-a2-1'], ['a2-2', 'flow-01234567-a2-2']])
})

test('a section whose latest join passed is joined, with no branches left', () => {
  const section = sectionOf(runView(loopedRun({ attempts: [...firstPass, settled('join', 5, 'pass', 'main', [3, 4])] })))
  expect(section.state).toBe('joined')
  expect(section.joined).toEqual(['a2-1', 'a2-2'])
  expect(section.paths.map(path => [path.pathId, path.branch])).toEqual([['a2-1', null], ['a2-2', null]])
})

test('a section whose latest join failed is a conflict and names the branch the unjoined path was kept on', () => {
  const section = sectionOf(runView(loopedRun({ attempts: [...firstPass, settled('join', 5, 'fail', 'main', [3, 4])], keptBranches: ['flow-01234567-a2-2'] })))
  expect(section.state).toBe('conflict')
  expect(section.joined).toEqual(['a2-1'])
  expect(section.paths.map(path => [path.pathId, path.branch])).toEqual([['a2-1', null], ['a2-2', 'flow-01234567-a2-2']])
})

test('a loop around a whole section re-opens it: after the split runs again the section is open, not joined', () => {
  const again = [...firstPass, settled('join', 5, 'pass', 'main', [3, 4]), settled('review', 6, 'fail'), settled('plan', 7, 'pass'), settled('verify', 8, 'pass'), settled('split', 9, 'pass')]
  const replanning = sectionOf(runView(loopedRun({ attempts: again.slice(0, 8) })))
  expect(replanning.state).toBe('joined')
  const open = { fork: 'split', join: 'join', forkAttempt: 9, parentPathId: 'main', parentWorkspace: '/x', snapshot: 's', joined: [], paths: [
    { pathId: 'a9-1', branch: 'flow-01234567-a9-1', dir: '/d1', workspace: '/d1', firstNodeId: 'api' },
    { pathId: 'a9-2', branch: 'flow-01234567-a9-2', dir: '/d2', workspace: '/d2', firstNodeId: 'ui' },
  ] }
  const reopened = sectionOf(runView(loopedRun({ attempts: again, sections: [open] })))
  expect(reopened.state).toBe('open')
  expect(reopened.paths.map(path => path.pathId)).toEqual(['a9-1', 'a9-2'])
})

test('run scope picks only that run, wherever it was started, and no quick jobs', () => {
  const snapshot = scopeSnapshot([run({ id: 'queue-run', terminalId: undefined }), run({ id: 'other' })], [job({ id: 'quick', terminalId: 't1' }), job({ id: 'step', workflowRunId: 'queue-run' })], { run: 'queue-run' })
  expect(snapshot.runs.map(view => view.id)).toEqual(['queue-run'])
  expect(snapshot.jobs).toEqual([])
})

test('a resumed step names the job it was resumed from so a picked first job still finds it', () => {
  const view = runView(run({ attempts: [{ nodeId: 'execute', number: 0, jobId: 'j2', status: 'running', prompt: 'p', startedAt: 1, endedAt: null, result: null, checks: [], output: '', workspace: null, tokenId: 'tok-1', pathId: 'main', from: [], nudgedFrom: 'j1' }] }))
  expect(view.attempts[0]).toMatchObject({ jobId: 'j2', nudgedFrom: 'j1' })
})

test('a run view says whether a failed or blocked run was dismissed', () => {
  expect(runView(run({ status: 'blocked' })).dismissed).toBe(false)
  expect(runView(run({ status: 'blocked', dismissedAt: null })).dismissed).toBe(false)
  expect(runView(run({ status: 'blocked', dismissedAt: 5 })).dismissed).toBe(true)
})
