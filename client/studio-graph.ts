import { REVIEW_STEP_INSTRUCTIONS, VERIFY_PLAN_STEP_INSTRUCTIONS } from '../server/reviewer-prompts'
import type { Workflow, WorkflowNode } from '../server/workflows'
export const stepPresets = [
  { id:'plan', title:'Plan work', description:'Turn a request into a clear plan', kind:'plan', role:'plan', symbol:'plan', instruction:'Inspect the request and project. Outline the changes, constraints, and how to verify the result.' },
  { id:'verify-plan', title:'Check a plan', description:'Catch gaps before work begins', kind:'verify-plan', role:'review', symbol:'check', instruction:VERIFY_PLAN_STEP_INSTRUCTIONS },
  { id:'implement', title:'Implement changes', description:'Carry out the approved plan', kind:'implement', role:'execute', symbol:'code', instruction:'Implement the verified plan. Follow project conventions and check that the changes work.' },
  { id:'review', title:'Review work', description:'Get an independent second opinion', kind:'review', role:'review', symbol:'review', instruction:REVIEW_STEP_INSTRUCTIONS },
  { id:'research', title:'Research', description:'Explore a question and collect sources', kind:'task', role:'plan', symbol:'research', instruction:'Research the question. Compare sources and provide a concise, evidence-backed answer.' },
  { id:'test', title:'Run tests', description:'Check that the result works as expected', kind:'task', role:'execute', symbol:'test', instruction:'Run the relevant tests and inspect the result. Report what passed, what failed, and supporting evidence.' },
  { id:'custom', title:'Custom task', description:'Write your own instructions', kind:'task', role:'execute', symbol:'spark', instruction:'Describe the task, constraints, and evidence required for success.' },
] as const
export function taskPreset(id: string): WorkflowNode {
  const preset=stepPresets.find(item=>item.id===id)??stepPresets.at(-1)!
  return {id:`step-${crypto.randomUUID().slice(0,8)}`,title:preset.title,instructions:preset.instruction,kind:preset.kind,agent:{role:preset.role},skills:[],mcpServers:[],checks:[],setup:[],maxVisits:3,position:{x:0,y:100}}
}
export function insertWorkflowStep(graph: Workflow, step: WorkflowNode, afterId?: string): Workflow {
  const after=graph.nodes.find(node=>node.id===afterId)??graph.nodes.at(-1)
  const next=graph.edges.find(edge=>edge.source===after?.id&&edge.outcome==='pass')
  const position={x:after?after.position.x+280:0,y:after?after.position.y+(next?220:0):100}
  return {...graph,entry:graph.entry||step.id,nodes:[...graph.nodes,{...step,position}],edges:[...graph.edges.filter(edge=>edge!==next),...(after?[{source:after.id,target:step.id,outcome:'pass' as const}]:[]),...(next?[{source:step.id,target:next.target,outcome:'pass' as const}]:[])]}
}
export function removeWorkflowStep(graph: Workflow, id: string): Workflow {
  const following=graph.edges.find(edge=>edge.source===id&&edge.outcome==='pass')?.target
  return {...graph,entry:graph.entry===id?following??graph.nodes.find(node=>node.id!==id)?.id??'':graph.entry,nodes:graph.nodes.filter(node=>node.id!==id),edges:graph.edges.filter(edge=>edge.source!==id&&(edge.target!==id||following)).map(edge=>edge.target===id?{...edge,target:following!}:edge)}
}
export function workflowTemplates(defaultFlow: Workflow): Workflow[] {
  return [defaultFlow,...[{id:'research',name:'Research & summarize',steps:['research','review']},{id:'quality',name:'Test & review',steps:['test','review']}].map(template=>{
    const nodes=template.steps.map((id,index)=>({...taskPreset(id),id:`${template.id}-${index}`,position:{x:index*280,y:100}}))
    return {id:`template-${template.id}`,name:template.name,entry:nodes[0]!.id,nodes,edges:[{source:nodes[0]!.id,target:nodes[1]!.id,outcome:'pass' as const}],land:[]}
  })]
}
export type Provider = { id: string; name: string; models: string[]; builtin?: boolean; family?: string | null }
export const IN_SESSION = 'session'
export function agentLabel(node: Pick<WorkflowNode, 'agent'>, providers: readonly Provider[], roles?: readonly RoleOption[] | null): string {
  const role = roles?.find(entry => entry.name === node.agent.role)
  if (!node.agent.engine && roles && !role) return 'Missing role'
  const engine = node.agent.engine ?? role?.engine
  if (!engine) return 'Chat decides'
  if (engine === IN_SESSION) return 'In Session'
  return providers.find(provider => provider.id === engine)?.name ?? `Unavailable · ${engine}`
}
export function agentHelp(engine: string | undefined): string {
  if (!engine) return 'The chat picks the AI for this step from its strengths and usage.'
  if (engine === IN_SESSION) return 'The AI in the chat or terminal that started the flow does this step there, where you can see it.'
  return 'Always use this AI for this step.'
}
export type AgentIcon = { symbol: string } | { image: string }
export function agentIcon(engine: string | undefined): AgentIcon {
  if (engine === IN_SESSION) return { symbol: 'session-icon' }
  return engine ? { image: `/providers/${engine}.svg` } : { symbol: 'auto-icon' }
}
export function showsModelFields(engine: string | undefined): boolean { return engine !== IN_SESSION }
export function runNote(graph: Pick<Workflow, 'nodes'>): string | null {
  return graph.nodes.some(node => node.agent.engine === IN_SESSION) ? 'In Session steps run as agents when started from Studio.' : null
}
const kindIcons: Record<WorkflowNode['kind'], string> = { plan: 'plan-icon', 'verify-plan': 'check-circle-icon', implement: 'code-icon', review: 'eye-icon', task: 'spark-icon', join: 'spark-icon' }
export function kindIcon(kind: WorkflowNode['kind']): string { return kindIcons[kind] }
export function roleWord(role: string): string { return role.charAt(0).toUpperCase() + role.slice(1) }
export type RoleAssignment = { engine: string; model: string | null }
export type RoleOption = RoleAssignment & { name: string }
export const BUILTIN_ROLES = ['plan', 'execute', 'review'] as const
const RESERVED_KEYS = new Set(['autoReview', 'fallback'])
const ROLE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const builtinRank = (name: string) => { const index = (BUILTIN_ROLES as readonly string[]).indexOf(name); return index < 0 ? BUILTIN_ROLES.length : index }
export function roleOptions(roles: Record<string, unknown>): RoleOption[] {
  return Object.entries(roles)
    .filter(([name]) => !RESERVED_KEYS.has(name))
    .flatMap(([name, value]) => {
      const entry = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
      return typeof entry.engine === 'string' ? [{ name, engine: entry.engine, model: typeof entry.model === 'string' ? entry.model : null }] : []
    })
    .sort((a, b) => builtinRank(a.name) - builtinRank(b.name) || a.name.localeCompare(b.name))
}
export function validRoleName(name: string, existing: readonly string[]): boolean {
  return ROLE_NAME.test(name) && !RESERVED_KEYS.has(name) && !existing.includes(name)
}
export type RunAgentMarks = { engine?: string; swappedFrom?: { engine: string; model: string | null; reason: string }; sameFamily?: boolean }
export function swapNote(agent: RunAgentMarks | undefined): string {
  const instead = agent?.swappedFrom ? ` · instead of ${agent.swappedFrom.engine} (${agent.swappedFrom.reason})` : ''
  return `${instead}${agent?.sameFamily ? ' · same-family review' : ''}`
}
const ROLE_CHOICE = 'role:'
export type AgentPick = { role: string; engine?: string }
export function agentChoice(agent: AgentPick): string { return agent.engine ?? `${ROLE_CHOICE}${agent.role}` }
export function roleChoice(name: string): string { return `${ROLE_CHOICE}${name}` }
export function agentFromChoice(value: string, current: AgentPick): AgentPick {
  return value.startsWith(ROLE_CHOICE) ? { role: value.slice(ROLE_CHOICE.length) } : { role: current.role, engine: value }
}
export function rolesBody(read: Record<string, unknown>, roles: readonly RoleOption[], fallback: RoleAssignment | null): Record<string, unknown> {
  const shown = new Set(roleOptions(read).map(role => role.name))
  const unshown = Object.entries(read).filter(([name]) => !shown.has(name))
  return { ...Object.fromEntries(unshown), ...Object.fromEntries(roles.map(({ name, engine, model }) => [name, { engine, model }])), fallback }
}
export type NodeRunState = 'passed' | 'running' | 'failed' | 'waiting'
export type CanvasRun = { status: string; tokens: { nodeId: string; state: string }[]; attempts: { nodeId: string; status: string; result: { outcome: string } | null; startedAt: number }[] }
export function nodeRunStates(run: CanvasRun | null): Record<string, NodeRunState> {
  if (run?.status !== 'running' && run?.status !== 'paused') return {}
  const settled = run.attempts.filter(attempt => attempt.status === 'settled' && attempt.result).sort((a, b) => a.startedAt - b.startedAt)
  const states: Record<string, NodeRunState> = Object.fromEntries(settled.map(attempt => [attempt.nodeId, attempt.result!.outcome === 'pass' ? 'passed' : 'failed']))
  const working = run.tokens.filter(token => token.state === 'working').map(token => [token.nodeId, 'running' as const])
  return { ...states, ...Object.fromEntries(working) }
}
