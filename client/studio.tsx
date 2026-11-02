import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ReactFlow, Background, BackgroundVariant, BaseEdge, Controls, Handle, Position, MarkerType, getBezierPath, useNodesState, useEdgesState, type Node, type NodeProps, type Edge, type EdgeProps, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Workflow, WorkflowNode, WorkflowRevision, PolicyRevision, Outcome } from '../server/workflows'
import type { RunStatus, WorkflowRun } from '../server/workflow-runner'
import type { DraftJob, WorkflowDraft } from '../server/workflow-builder'
import { api, openRun } from './studio-api'
import { Connections, StepAttachments, type ConnectionList } from './studio-settings'
import { agentHelp, agentIcon, agentLabel, IN_SESSION, insertWorkflowStep, kindIcon, nodeRunStates, roleWord, removeWorkflowStep, runNote, showsModelFields, stepPresets, taskPreset, workflowTemplates, type NodeRunState, type Provider } from './studio-graph'

type TaskNode = Node<WorkflowNode & { agentLabel: string; branches: Outcome[]; runState?: NodeRunState; runSince?: number }, 'task'>
type Screen = 'home' | 'templates' | 'editor' | 'connections' | 'runs' | 'rules'
type Panel = 'assistant' | 'picker' | 'step' | 'history' | null
const isLiveRun = (status: RunStatus | undefined) => status === 'running' || status === 'paused' || status === 'awaiting-approval'
type RunSummary = Pick<WorkflowRun, 'id' | 'label' | 'status' | 'error' | 'currentNodeId' | 'createdAt'> & { workflowName: string; revision: string; workingNodeIds: string[] }
const outcomes: Outcome[] = ['pass', 'fail', 'blocked']
const outcomeLabels: Record<Outcome, string> = { pass: 'When it succeeds', fail: 'If it fails', blocked: 'If it needs help' }
const purposeLabels = { task: 'Custom task', plan: 'Plan work', 'verify-plan': 'Check a plan', implement: 'Implement changes', review: 'Review work', join: 'Join paths' }
const NAV: Array<[Screen, string]> = [['home', 'Workflows'], ['connections', 'Manage AIs'], ['runs', 'Runs'], ['rules', 'Rules']]
const EXAMPLES: Array<[string, string]> = [['Plan, implement, review', 'Plan the work, verify the plan, then implement and get an independent review using my configured AIs.'], ['Research and verify', 'Research my question, then have another AI check the sources and findings.']]
const SUGGESTIONS = ['Add a testing step before the final review', 'Use a different AI to review the work']
const Icon = ({ id }: { id: string }) => <svg aria-hidden="true"><use href={`#${id}`} /></svg>

const runLabels: Record<NodeRunState, string> = { passed: 'Passed', running: 'Running', failed: 'Needs attention', waiting: 'Waiting' }
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return <>{` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</>
}
const engineTints: Record<string, string> = { claude: '#d4a091', glm: '#91b0dc', codex: '#bfd38b' }
const TaskCard = memo(function TaskCard({ data, selected }: NodeProps<TaskNode>) {
  const engine = data.agent.engine
  return <div className="workflow-node" data-selected={selected} data-run={data.runState}>
    <Handle type="target" position={Position.Left} />
    <Icon id={kindIcon(data.kind)} />
    <strong>{data.title}</strong>
    <p>{data.instructions.split(/(?<=[.!?])\s/)[0]}</p>
    {data.runState && <span className={`run-state run-${data.runState}`}>{runLabels[data.runState]}{data.runState === 'running' && data.runSince ? <Elapsed since={data.runSince} /> : null}</span>}
    <footer><small style={engine && engineTints[engine] ? { '--engine': engineTints[engine] } as CSSProperties : undefined}><AgentGlyph engine={engine} />{roleWord(data.agent.role)} AI · {data.agentLabel}</small></footer>
    <Handle type="source" id="pass" position={Position.Right} />
    {data.branches.filter(outcome => outcome !== 'pass').map((outcome, index) => <Handle key={outcome} title={outcomeLabels[outcome]} aria-label={outcomeLabels[outcome]} type="source" id={outcome} position={Position.Bottom} className={`handle-${outcome}`} style={{ left: index ? '70%' : '30%' }} />)}
  </div>
})
function AgentGlyph({ engine }: { engine: string | undefined }) {
  const icon = agentIcon(engine)
  return 'image' in icon ? <img src={icon.image} alt="" /> : <Icon id={icon.symbol} />
}
const nodeTypes = { task: TaskCard }
function FlowEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, sourceHandleId, markerEnd, label, style }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  return <>
    <BaseEdge path={path} markerEnd={markerEnd} style={style} label={label} labelX={labelX} labelY={labelY} labelBgPadding={[8, 3]} labelBgBorderRadius={10} />
    {sourceHandleId === 'pass' && <BaseEdge path={path} className="edge-flow" interactionWidth={0} />}
  </>
}
const edgeTypes = { flow: FlowEdge }
const motionPaused = () => { try { return localStorage.getItem('skd.motion.paused') === 'true' } catch { return false } }
const syncMotion = () => document.documentElement.toggleAttribute('data-motion-paused', motionPaused())
syncMotion()
document.getElementById('motion')?.addEventListener('change', () => setTimeout(syncMotion))

const navHost = document.getElementById('studio-nav')
function graphEdges(graph: Workflow): Edge[] { return graph.edges.map(edge => ({ id: `${edge.source}-${edge.outcome}-${edge.target}`, source: edge.source, target: edge.target, sourceHandle: edge.outcome, label: edge.outcome === 'pass' ? undefined : outcomeLabels[edge.outcome], type: 'flow', markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#8a93a8' }, className: `outcome-${edge.outcome}` })) }
function fresh(graph: Workflow): WorkflowRevision { return { ...graph, id: `workflow-${crypto.randomUUID().slice(0, 8)}`, revision: '', createdAt: 0 } }
function dateLabel(time: number): string { return time ? new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Built-in version' }

let pendingRunId: string | null = null
addEventListener('quiet:studio-run', event => { pendingRunId = (event as CustomEvent<{ runId: string }>).detail?.runId ?? null })

function Studio() {
  const [screen, setScreen] = useState<Screen>('home')
  const [panel, setPanel] = useState<Panel>(null)
  const [workflows, setWorkflows] = useState<WorkflowRevision[]>([])
  const [defaultFlow, setDefaultFlow] = useState<WorkflowRevision | null>(null)
  const [design, setDesign] = useState(false)
  const [graph, setGraph] = useState<WorkflowRevision | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<TaskNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [list, setList] = useState<ConnectionList>({ builtins: ['claude', 'glm', 'codex'], connections: [], presets: [], models: {} })
  const [providers, setProviders] = useState<Provider[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [description, setDescription] = useState('')
  const [builderEngine, setBuilderEngine] = useState('')
  const [draftJob, setDraftJob] = useState<DraftJob | null>(null)
  const [aiSummary, setAiSummary] = useState('')
  const [setup, setSetup] = useState<string[]>([])
  const [revisions, setRevisions] = useState<WorkflowRevision[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [run, setRun] = useState<WorkflowRun | null>(null)
  const [revealRunId, setRevealRunId] = useState<string | null>(null)
  const [canvasRun, setCanvasRun] = useState<WorkflowRun | null>(null)
  const [policy, setPolicy] = useState<PolicyRevision | null>(null)
  const [policyText, setPolicyText] = useState('')
  const [policyRevisions, setPolicyRevisions] = useState<PolicyRevision[]>([])
  const [modal, setModal] = useState<'run' | 'rules' | null>(null)
  const [cwd, setCwd] = useState('')
  const [runTitle, setRunTitle] = useState('')
  const [request, setRequest] = useState('')
  const [promptPreview, setPromptPreview] = useState('')
  const flow = useRef<ReactFlowInstance<TaskNode> | null>(null)
  const dialog = useRef<HTMLDialogElement | null>(null)
  const generationBase = useRef<WorkflowRevision | null>(null)
  const current = nodes.find(node => node.id === selected)?.data
  const building = draftJob?.status === 'running'
  const disabled = busy || building
  const builtin = workflows.find(item => item.id === 'default')
  const templates = builtin ? workflowTemplates(builtin) : []
  const label = (node: Pick<WorkflowNode, 'agent'>) => agentLabel(node, providers)
  const runStates = useMemo(() => nodeRunStates(canvasRun), [canvasRun])
  const runSince = (id: string) => canvasRun?.attempts.findLast(attempt => attempt.nodeId === id && attempt.status !== 'settled')?.startedAt
  const shownNodes = useMemo(() => isLiveRun(canvasRun?.status) ? nodes.map(node => ({ ...node, data: { ...node.data, runState: runStates[node.id] ?? 'waiting' as const, runSince: runSince(node.id) } })) : nodes, [nodes, canvasRun, runStates])
  const shownEdges = useMemo(() => edges.map(edge => edge.sourceHandle === 'pass' && runStates[edge.source] === 'passed' ? { ...edge, className: `${edge.className} run-passed`, markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#6f9c7e' } } : edge), [edges, runStates])
  const toast = (text: string) => dispatchEvent(new CustomEvent('quiet:toast', { detail: text }))

  function nodesFor(value: Workflow): TaskNode[] { return value.nodes.map(node => ({ id: node.id, type: 'task', position: node.position, ariaLabel: `${node.title} · ${label(node)}`, data: { ...node, agentLabel: label(node), branches: value.edges.filter(edge => edge.source === node.id).map(edge => edge.outcome) } })) }
  function fit() { setTimeout(() => { void flow.current?.fitView({ padding: 0.2, maxZoom: 1 }) }, 70) }
  function load(value: WorkflowRevision, edited = false) { setGraph(value); setNodes(nodesFor(value)); setEdges(graphEdges(value)); setSelected(null); setDirty(edited); setPromptPreview(''); setRevisions([]); fit() }
  function draft(): Workflow { return { id: graph!.id, name: graph!.name, entry: graph!.entry, nodes: nodes.map(node => { const { agentLabel: _label, branches: _branches, ...spec } = node.data; return { ...spec, position: node.position } }), edges: edges.map(edge => ({ source: edge.source, target: edge.target, outcome: (edge.sourceHandle ?? 'pass') as Outcome })), land: graph!.land ?? [] } }
  function markDirty() { setGraph(current => current?.id === 'default' ? fresh({ ...current, name: `${current.name} copy` }) : current); setDirty(true); setError(''); setPromptPreview('') }
  function patch(patch: Partial<WorkflowNode>) { if (disabled) return; markDirty(); setNodes(current => current.map(node => node.id === selected ? { ...node, data: { ...node.data, ...patch, ...(patch.agent ? { agentLabel: label({ agent: patch.agent }) } : {}) } } : node)) }
  function adopt(value: Workflow) { markDirty(); setGraph(current => current ? { ...current, entry: value.entry } : current); setNodes(nodesFor(value)); setEdges(graphEdges(value)); fit() }
  function addStep(id: string) { if (disabled || !graph) return; const step = taskPreset(id); adopt(insertWorkflowStep(draft(), step, selected ?? undefined)); setSelected(step.id); setPanel('step') }
  function wire(source: string, outcome: Outcome, target: string, replacing?: string) { if (disabled) return; const value = draft(); const replaced = (edge: Workflow['edges'][number]) => edge.source === source && edge.outcome === outcome && (outcome !== 'pass' || edge.target === target || edge.target === replacing); value.edges = [...value.edges.filter(edge => !replaced(edge)), ...(target ? [{ source, outcome, target }] : [])]; adopt(value) }
  async function action(task: () => Promise<void>) { setBusy(true); setError(''); try { await task() } catch (error) { setError((error as Error).message) } finally { setBusy(false) } }
  const refreshConnections = useCallback(async () => { setList(await api<ConnectionList>('/connections')); const result = await fetch('/api/providers').then(response => response.json()) as { providers: Provider[] }; setProviders(result.providers ?? []) }, [])
  const refreshWorkflows = useCallback(async () => { const result = await api<{ workflows: WorkflowRevision[]; selected: WorkflowRevision; design: boolean }>('/workflows'); setWorkflows(result.workflows); setDefaultFlow(result.selected); setDesign(result.design); return result }, [])
  const refreshRuns = useCallback(async () => setRuns((await api<{ runs: RunSummary[] }>('/runs')).runs), [])
  useEffect(() => { let active = true; Promise.all([refreshWorkflows(), refreshConnections(), api<PolicyRevision>('/policy'), api<{ draft: DraftJob | null }>('/drafts')]).then(([, , policy, drafting]) => { if (active) { setPolicy(policy); setPolicyText(policy.template); if (drafting.draft) setDraftJob(drafting.draft) } }).catch(error => setError(error.message)); return () => { active = false } }, [])
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (dirty || building) event.preventDefault() }; addEventListener('beforeunload', guard); return () => removeEventListener('beforeunload', guard) }, [dirty, building])
  useEffect(() => { if (modal) dialog.current?.showModal() }, [modal])
  useEffect(() => {
    const consume = () => {
      const runId = pendingRunId
      if (!runId) return
      pendingRunId = null
      go('runs')
      openRun<WorkflowRun>(runId, refreshRuns).then(result => { setRun(() => result); setRevealRunId(() => runId) }).catch(error => setError((error as Error).message))
    }
    consume()
    addEventListener('quiet:studio-run', consume)
    return () => removeEventListener('quiet:studio-run', consume)
  }, [])
  useEffect(() => {
    if (!revealRunId || screen !== 'runs') return
    const item = [...document.querySelectorAll<HTMLElement>('.runs-view .history-item')].find(element => element.dataset.run === revealRunId)
    if (!item) return
    item.scrollIntoView({ block: 'nearest' })
    setRevealRunId(null)
  }, [revealRunId, runs, run?.id, screen])
  useEffect(() => { setNodes(current => current.map(node => ({ ...node, data: { ...node.data, agentLabel: label(node.data) } }))) }, [providers])
  useEffect(() => { if (screen === 'runs') void refreshRuns().catch(error => setError(error.message)); if (screen === 'rules') void api<{ revisions: PolicyRevision[] }>('/policy/revisions').then(result => setPolicyRevisions(result.revisions)).catch(error => setError(error.message)) }, [screen, run?.status])
  useEffect(() => { if (panel === 'history' && graph?.revision) void api<{ revisions: WorkflowRevision[] }>(`/workflows/${graph.id}/revisions`).then(result => setRevisions(result.revisions)).catch(error => setError(error.message)) }, [panel, graph?.id, graph?.revision])
  useEffect(() => {
    const revision = graph?.revision
    if (screen !== 'editor' || !revision) { setCanvasRun(null); return }
    let stopped = false, pending = false, lastError = ''
    const poll = async () => {
      if (pending) return
      pending = true
      try {
        const live = (await api<{ runs: RunSummary[] }>('/runs')).runs.filter(item => item.revision === revision && isLiveRun(item.status)).sort((a, b) => b.createdAt - a.createdAt)[0]
        const result = live ? await api<WorkflowRun>(`/runs/${live.id}`) : null
        if (stopped) return
        lastError = ''
        setCanvasRun(current => current?.id === result?.id && current?.updatedAt === result?.updatedAt ? current : result)
      } catch (error) {
        const message = (error as Error).message
        if (!stopped && message !== lastError) { lastError = message; setError(message) }
      } finally { pending = false }
    }
    void poll(); const timer = setInterval(() => { if (!document.hidden && !document.getElementById('studio')?.hidden) void poll() }, 3000); return () => { stopped = true; clearInterval(timer) }
  }, [screen, graph?.revision])
  useEffect(() => { if (!run || !isLiveRun(run.status)) return; let stopped = false; const poll = async () => { try { const result = await api<WorkflowRun>(`/runs/${run.id}`); if (!stopped) setRun(result) } catch (error) { if (!stopped) setError((error as Error).message) } }; const timer = setInterval(() => { if (!document.hidden && !document.getElementById('studio')?.hidden) void poll() }, 1500); return () => { stopped = true; clearInterval(timer) } }, [run?.id, run?.status])
  useEffect(() => {
    if (!building || !draftJob) return
    let stopped = false, pending = false
    const poll = async () => { if (pending) return; pending = true; try { const result = await api<DraftJob>(`/drafts/${draftJob.id}`); if (stopped) return; if (result.status === 'done' && result.draft) { applyAiDraft(result.draft); setDraftJob(result) } else if (result.status === 'failed') { setDraftJob(result); setError(result.error ?? 'Could not build this workflow. Try again.') } } catch (error) { if (!stopped) setError((error as Error).message) } finally { pending = false } }
    const timer = setInterval(() => void poll(), 1200); void poll(); return () => { stopped = true; clearInterval(timer) }
  }, [draftJob?.id, building])
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && panel && !modal && !document.getElementById('studio')?.hidden) setPanel(null) }; addEventListener('keydown', close); return () => removeEventListener('keydown', close) }, [panel, modal])
  function applyAiDraft(result: WorkflowDraft) { const base = generationBase.current; const next = base && base.id !== 'default' ? { ...result.workflow, land: base.land ?? [], id: base.id, revision: base.revision, createdAt: base.createdAt } : fresh(result.workflow); load(next, true); setAiSummary(result.summary); setSetup(result.setup); setScreen('editor'); setPanel('assistant'); setDescription(''); toast('Workflow draft ready. Review the steps before saving or running.') }
  async function generate() { if (!description.trim() || disabled) return; if (screen !== 'editor' && dirty && !confirm('Replace your unsaved draft with a new AI workflow?')) return; await action(async () => { generationBase.current = screen === 'editor' && graph ? { ...graph, ...draft() } : null; const base = generationBase.current; const job = await api<DraftJob>('/drafts', { description, ...(builderEngine ? { engine: builderEngine } : {}), ...(base?.nodes.length ? { workflow: base } : {}) }); setDraftJob(job); setPanel('assistant') }) }
  async function stopDraft() { if (!draftJob) return; await action(async () => { await api(`/drafts/${draftJob.id}/stop`, {}); setDraftJob({ ...draftJob, status: 'failed' }); toast('Workflow drafting stopped. Your existing flow is unchanged.') }) }
  function open(value: WorkflowRevision, copy = false) { if (building) return; if (dirty && !confirm('Discard unsaved changes and open this workflow?')) return; load(copy ? fresh(value) : value, copy); setScreen('editor'); setPanel(null); setAiSummary(''); setSetup([]) }
  function openTemplate(value: Workflow) { open({ ...value, revision: '', createdAt: 0 }, true) }
  function blank() { if (building) return; if (dirty && !confirm('Discard unsaved changes and start a new workflow?')) return; load(fresh({ id: 'new', name: 'Untitled workflow', entry: '', nodes: [], edges: [], land: [] }), true); setScreen('editor'); setPanel('picker'); setAiSummary(''); setSetup([]) }
  async function save() { const result = await api<WorkflowRevision>('/workflows', { workflow: draft(), ...(graph?.revision ? { expectedRevision: graph.revision } : {}) }); load(result); await refreshWorkflows(); toast('Workflow saved. Existing runs keep their original version.'); return result }
  function go(next: Screen) { setScreen(next); setError('') }
  function closeModal() { dialog.current?.close(); setModal(null) }

  const heading = navHost ? createPortal(screen === 'editor'
    ? <button type="button" className="text-button" onClick={() => go('home')}><Icon id="back-icon" />Workflows</button>
    : NAV.map(([id, text]) => <button key={id} type="button" className="text-button" aria-current={screen === id || (screen === 'templates' && id === 'home') ? 'page' : undefined} onClick={() => go(id)}>{text}</button>), navHost) : null
  const providerOptions = providers.filter(provider => provider.id !== IN_SESSION).map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)
  const draftProviders = providers.filter(provider => !list.connections.some(connection => connection.id === provider.id && connection.adapter === 'cli'))
  const promptBox = (small = false) => <form className="workflow-prompt" onSubmit={event => { event.preventDefault(); void generate() }}>
    <textarea aria-label={small ? 'Ask AI to change the workflow' : 'Describe your workflow'} rows={small ? 6 : 4} value={description} disabled={disabled} onChange={event => setDescription(event.target.value)} placeholder={small ? 'Add a testing step before the review…' : 'Plan the work, build it, then ask another AI to review…'} required />
    <div><label><span className="visually-hidden">Planning AI</span><select aria-label="Planning AI" disabled={disabled} value={builderEngine} onChange={event => setBuilderEngine(event.target.value)}><option value="">Chat default</option>{draftProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>{building ? <button type="button" className="pill" onClick={() => void stopDraft()}>Stop drafting</button> : <button className="pill" type="submit" disabled={busy || !description.trim()}><Icon id="spark-icon" />{small ? 'Update draft' : 'Build workflow'}</button>}</div>
    {building && <p className="muted" role="status">Your AI is drafting the workflow… This can take a minute.</p>}
  </form>
  const strip = (value: Workflow) => <span className="strip" aria-hidden="true">{value.nodes.slice(0, 5).map(node => <i key={node.id} />)}</span>
  const modelsOf = (engine?: string) => providers.find(provider => provider.id === engine)?.models ?? []

  return <>
    {heading}
    {error && <div className="studio-error" role="alert"><span>{error}</span><button type="button" className="round" aria-label="Dismiss error" onClick={() => setError('')}><Icon id="close-icon" /></button></div>}
    {screen === 'home' && <section className="studio-view describe-home">
      <h2>How should your team work?</h2><p className="muted">Describe the steps you have in mind. Shape them on the canvas.</p>
      {promptBox()}
      {defaultFlow && <p className="muted default-mode">New flows: <strong>{design ? 'the AI designs each one for its task' : defaultFlow.name}</strong> <button type="button" className="text-button" disabled={building} onClick={() => void action(async () => { await api('/default', design ? { id: defaultFlow.id, revision: defaultFlow.revision } : { design: true }); await refreshWorkflows(); toast(design ? `New flows use ${defaultFlow.name}.` : 'New flows are designed by the AI.') })}>{design ? `Use ${defaultFlow.name} instead` : 'Let the AI design'}</button></p>}
      <div className="prompt-examples"><span className="muted">Try an example</span>{EXAMPLES.map(([title, text]) => <button key={title} type="button" className="example" disabled={disabled} onClick={() => setDescription(text)}>{title}</button>)}</div>
      <div className="starting-options">
        <button type="button" className="studio-option" disabled={!defaultFlow || building} onClick={() => defaultFlow && open(defaultFlow)}><Icon id="flow-icon" /><strong>Use the default</strong><small>{defaultFlow?.name ?? 'Loading your default…'}</small></button>
        <button type="button" className="studio-option" disabled={building} onClick={() => go('templates')}><Icon id="history-icon" /><strong>Browse templates</strong><small>A starting point to make yours</small></button>
        <button type="button" className="studio-option" disabled={building} onClick={blank}><Icon id="plus-icon" /><strong>Start from scratch</strong><small>One step at a time</small></button>
      </div>
      <div className="compact-templates">{templates.slice(1).map(item => <button key={item.id} type="button" disabled={building} onClick={() => openTemplate(item)}>{strip(item)}<span>{item.name}</span><small className="muted">{item.nodes.length} steps</small></button>)}</div>
      {graph && <button type="button" className="text-button continue-draft" onClick={() => go('editor')}>Continue editing {graph.name}{dirty ? ' · Unsaved changes' : ''}<Icon id="open-icon" /></button>}
      {workflows.some(item => item.id !== 'default') && <section className="saved-workflows"><h3>Your workflows</h3>{workflows.filter(item => item.id !== 'default').map(item => <button key={item.id} type="button" disabled={building} onClick={() => open(item)}><span><strong>{item.name}</strong><small>{item.nodes.length} steps · {dateLabel(item.createdAt)}</small></span><Icon id="open-icon" /></button>)}</section>}
    </section>}
    {screen === 'templates' && <section className="studio-view describe-home"><h2>Choose a starting point.</h2><div className="starting-options">
      {templates.map((item, index) => <button key={item.id} type="button" className="studio-option" disabled={building} onClick={() => index === 0 ? open({ ...item, revision: builtin!.revision, createdAt: 0 }) : openTemplate(item)}><strong>{index === 0 ? 'Plan, build & review' : item.name}</strong><small>{item.nodes.length} steps · {index === 0 ? 'Default workflow' : index === 1 ? 'Explore, then check the findings' : 'Check existing work and take a closer look'}</small></button>)}
      <button type="button" className="studio-option" disabled={building} onClick={blank}><strong>Blank workflow</strong><small>Start with your own task</small></button>
    </div></section>}
    {screen === 'editor' && graph && <section className="studio-view">
      <header className="editor-heading">
        <div><label className="visually-hidden" htmlFor="workflow-name">Workflow name</label><input id="workflow-name" value={graph.name} disabled={disabled} onChange={event => { markDirty(); setGraph(current => current ? { ...current, name: event.target.value } : current) }} /><p className="muted" role="status">{dirty ? 'Unsaved changes' : graph.id === 'default' ? 'Default workflow' : 'Saved'} · {nodes.length} step{nodes.length === 1 ? '' : 's'}</p></div>
        <div className="editor-actions"><button type="button" className="text-button" aria-pressed={panel === 'history'} onClick={() => setPanel(panel === 'history' ? null : 'history')}>History</button><button type="button" className="pill" disabled={!dirty || disabled} onClick={() => void action(async () => { await save() })}>Save</button><button type="button" className="pill" disabled={disabled || !nodes.length} onClick={() => void action(async () => { if (dirty) await save(); setRunTitle(graph.name); setModal('run') })}>Run workflow</button></div>
      </header>
      <div className="editor-body">
        <div className="workflow-canvas">
          <div className="flow-host">
            <div className="canvas-tools"><button type="button" className="pill" disabled={disabled} onClick={() => { setQuery(''); setPanel('picker') }}><Icon id="plus-icon" />Add step</button>{aiSummary && <span className="draft-notice"><strong>AI draft</strong> {aiSummary} <button type="button" className="round" aria-label="Dismiss draft message" onClick={() => setAiSummary('')}><Icon id="close-icon" /></button></span>}<button type="button" className="text-button" aria-pressed={panel === 'assistant'} onClick={() => setPanel(panel === 'assistant' ? null : 'assistant')}><Icon id="spark-icon" />Ask AI</button></div>
            <ReactFlow<TaskNode> nodes={shownNodes} edges={shownEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={instance => { flow.current = instance; fit() }} onNodesChange={changes => { onNodesChange(changes); if (changes.some(change => change.type === 'position' && change.dragging)) markDirty() }} onEdgesChange={changes => { onEdgesChange(changes); if (changes.some(change => change.type === 'remove')) markDirty() }} onNodeClick={(_, node) => { setSelected(node.id); setPanel('step') }} onSelectionChange={({ nodes: picked }) => { const id = picked[0]?.id; if (id && id !== selected) { setSelected(id); setPanel('step') } }} onConnect={connection => { if (connection.source && connection.target) wire(connection.source, (connection.sourceHandle ?? 'pass') as Outcome, connection.target) }} nodesDraggable={!disabled} nodesConnectable={!disabled} deleteKeyCode={null} fitView fitViewOptions={{ padding: 0.18, maxZoom: 1 }} minZoom={0.25} maxZoom={1.4} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--studio-dots)" /><Controls showInteractive={false} /></ReactFlow>
            {!nodes.length && <div className="empty-canvas"><span className="welcome-mark"><Icon id="plus-icon" /></span><h3>Your workflow starts here</h3><p className="muted">Add a step, or describe the whole workflow to AI.</p><div><button type="button" className="pill" onClick={() => setPanel('picker')}>Add first step</button><button type="button" className="pill" onClick={() => setPanel('assistant')}><Icon id="spark-icon" />Build with AI</button></div></div>}
            <p className="canvas-note">Drag to arrange · connect to set the order. <button type="button" className="text-button" onClick={() => setModal('rules')}><Icon id="lock-icon" />Core rules always apply</button></p>
          </div>
        </div>
        <aside className="step-inspector" aria-label={panel === 'picker' ? 'Add a step' : panel === 'step' ? 'Edit step' : panel === 'history' ? 'Workflow history' : panel === 'assistant' ? 'Build with AI' : 'Step details'}>
          {panel === null && <p className="muted">Select a step to edit it.</p>}
          {panel === 'picker' && <><h2>Add a step</h2><label className="search-field flat-search"><Icon id="search-icon" /><input aria-label="Find a step" placeholder="Find a step…" value={query} onChange={event => setQuery(event.target.value)} /></label>
            <div className="preset-list">{stepPresets.filter(item => item.id !== 'custom' && `${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase())).map(item => <button key={item.id} type="button" className="preset-row" disabled={disabled} onClick={() => addStep(item.id)}><span><strong>{item.title}</strong><small>{item.description}</small></span><Icon id="plus-icon" /></button>)}
              <button type="button" className="preset-row custom" disabled={disabled} onClick={() => addStep('custom')}><span><strong>Custom task</strong><small>Write your own instructions. Use any connected AI and its tools.</small></span><Icon id="plus-icon" /></button></div>
            <p className="muted">Presets are starting points. Every field stays editable.</p></>}
          {panel === 'step' && (current ? <fieldset disabled={disabled} className="step-editor"><h2>Edit step</h2>
            <label>Step name<input value={current.title} onChange={event => patch({ title: event.target.value })} /></label>
            <label>What should happen?<textarea rows={6} value={current.instructions} onChange={event => patch({ instructions: event.target.value })} /></label>
            <label>Who should do it?<select value={current.agent.engine ?? ''} onChange={event => event.target.value === 'connect' ? go('connections') : patch({ agent: event.target.value ? { role: current.agent.role, engine: event.target.value } : { role: current.agent.role } })}><option value="">Chat decides</option><option value={IN_SESSION}>In Session</option>{providerOptions}{current.agent.engine && current.agent.engine !== IN_SESSION && !providers.some(provider => provider.id === current.agent.engine) && <option value={current.agent.engine}>Unavailable · {current.agent.engine}</option>}<option value="connect">+ Connect another AI</option></select><small className="muted">{agentHelp(current.agent.engine)}</small></label>
            <details><summary>Tools, skills & checks{current.skills.length + current.mcpServers.length + current.checks.length ? ` (${current.skills.length + current.mcpServers.length + current.checks.length})` : ''}</summary><StepAttachments node={current} onChange={patch} /></details>
            <details><summary>More options</summary>
              <label>Task purpose<select value={current.kind} onChange={event => patch({ kind: event.target.value as WorkflowNode['kind'] })}>{Object.entries(purposeLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
              {outcomes.map(outcome => <label key={outcome}>{outcomeLabels[outcome]}<select value={edges.find(edge => edge.source === current.id && edge.sourceHandle === outcome)?.target ?? ''} onChange={event => wire(current.id, outcome, event.target.value, edges.find(edge => edge.source === current.id && edge.sourceHandle === outcome)?.target)}><option value="">End the workflow</option>{nodes.filter(node => node.id !== current.id).map(node => <option key={node.id} value={node.id}>{node.data.title}</option>)}</select></label>)}
              {showsModelFields(current.agent.engine) && <label>Model<input list="studio-models" value={current.agent.model ?? ''} placeholder="Use this AI's default" onChange={event => patch({ agent: { ...current.agent, model: event.target.value || undefined } })} /><datalist id="studio-models">{modelsOf(current.agent.engine).map(model => <option key={model} value={model} />)}</datalist></label>}
              <label>Maximum attempts<input type="number" min={1} max={10} value={current.maxVisits} onChange={event => patch({ maxVisits: Number(event.target.value) })} /></label>
              {showsModelFields(current.agent.engine) && <label>Model family (if unknown)<input value={current.agent.family ?? ''} onChange={event => patch({ agent: { ...current.agent, family: event.target.value || undefined } })} /></label>}
              <button type="button" className="text-button" disabled={dirty || busy} title={dirty ? 'Save first to preview the exact instructions' : undefined} onClick={() => void action(async () => setPromptPreview((await api<{ prompt: string }>('/preview', { id: graph.id, revision: graph.revision, nodeId: current.id, request: request || 'Preview request' })).prompt))}>Preview full instructions</button>
              {promptPreview && <pre className="studio-output">{promptPreview}</pre>}
            </details>
            <div className="inspector-actions"><button type="button" className="text-button danger" onClick={() => { adopt(removeWorkflowStep(draft(), current.id)); setSelected(null); setPanel(null) }}>Remove step</button><span><button type="button" className="text-button" onClick={() => { setQuery(''); setPanel('picker') }}><Icon id="plus-icon" />Add next step</button><button type="button" className="pill" onClick={() => setPanel(null)}>Done</button></span></div>
          </fieldset> : <p className="muted">Select a step on the canvas to edit it.</p>)}
          {panel === 'assistant' && <><h2>Build with AI</h2><p className="muted">Describe a change, add a step, or ask for a different approach. Your AI updates this draft.</p>
            {aiSummary && <div className="saved-revision"><strong>Draft ready</strong><small>{aiSummary}</small></div>}
            {setup.length > 0 && <div className="saved-revision"><strong>Before running</strong><ul>{setup.map(item => <li key={item}>{item}</li>)}</ul><button type="button" className="text-button" onClick={() => go('connections')}>Manage AIs</button></div>}
            <div className="prompt-examples"><span className="muted">Try a change</span>{SUGGESTIONS.map(suggestion => <button key={suggestion} type="button" className="example" disabled={disabled} onClick={() => setDescription(suggestion)}>{suggestion}</button>)}</div>
            {promptBox(true)}<p className="muted">Changes stay in this draft until you save.</p></>}
          {panel === 'history' && <><h2>History</h2><p className="muted">Saved versions stay available. Running work keeps the version it started with.</p>
            {dirty && <div className="saved-revision"><strong>Current draft</strong><small>Unsaved changes</small></div>}
            {revisions.map(item => <div className="saved-revision" key={item.revision}><strong>{item.revision === graph.revision ? 'Current saved version' : dateLabel(item.createdAt)}</strong><small>{item.nodes.length} steps · {dateLabel(item.createdAt)}</small><button type="button" className="text-button" disabled={building} onClick={() => { open(item); setPanel('history') }}>Open version</button></div>)}
            {!graph.revision && <p className="muted">Save this workflow to create its first version.</p>}
            <div className="inspector-actions"><button type="button" className="text-button" disabled={dirty || disabled || !graph.revision || (!design && defaultFlow?.id === graph.id && defaultFlow.revision === graph.revision)} onClick={() => void action(async () => { await api('/default', { id: graph.id, revision: graph.revision }); await refreshWorkflows(); toast('Default updated for future runs.') })}>Use as default workflow</button><button type="button" className="text-button" disabled={building} onClick={() => { load(fresh({ ...draft(), name: `${graph.name} copy` }), true); setPanel(null) }}>Make a copy</button></div></>}
        </aside>
      </div>
    </section>}
    {screen === 'connections' && <Connections list={list} refresh={refreshConnections} report={toast} onError={setError} />}
    {screen === 'runs' && <section className="studio-view secondary-studio runs-view">
      <div className="runs-heading"><h2>Recent runs</h2><button type="button" className="text-button" disabled={busy} onClick={() => void action(refreshRuns)}>Refresh</button></div>
      {runs.length === 0 && <p className="muted">Your workflow runs will appear here.</p>}
      <div className="history-list">{runs.map(item => <details key={item.id} className="history-item" data-run={item.id} open={run?.id === item.id} onToggle={event => { if (event.currentTarget.open && run?.id !== item.id) void action(async () => setRun(await api<WorkflowRun>(`/runs/${item.id}`))) }}>
        <summary><span>{item.label}</span><span className="status" data-state={item.status}>{item.status}</span></summary>
        {run?.id === item.id ? <div className="run-detail">
          <div className="run-actions"><span className="muted">{run.workflow.name} · {dateLabel(run.createdAt)}</span>{isLiveRun(run.status) ? <button type="button" className="text-button danger" disabled={busy} onClick={() => void action(async () => setRun(await api<WorkflowRun>(`/runs/${run.id}/stop`, {})))}>Stop run</button> : ['failed', 'blocked', 'stopped'].includes(run.status) && <button type="button" className="text-button" disabled={busy} onClick={() => void action(async () => setRun(await api<WorkflowRun>(`/runs/${run.id}/retry`, {})))}>Retry current step</button>}</div>
          <p>{run.request}</p><p className="muted"><code>{run.cwd}</code></p>
          {run.error && <p role="alert" className="chat-error">{run.error}</p>}
          <ol className="attempts">{run.attempts.map(attempt => <li key={`${attempt.nodeId}-${attempt.number}`}>
            <h3>{run.workflow.nodes.find(node => node.id === attempt.nodeId)?.title ?? attempt.nodeId}<span className="status" data-state={attempt.result?.outcome ?? attempt.status}>{attempt.result?.outcome ?? attempt.status}</span></h3>
            <p className="muted">{label({ agent: { role: 'execute', engine: run.agents[attempt.nodeId]?.engine } })}{run.agents[attempt.nodeId]?.model ? ` · ${run.agents[attempt.nodeId]?.model}` : ''}</p>
            {attempt.result && <><p>{attempt.result.summary}</p>{attempt.result.evidence.length > 0 && <ul>{attempt.result.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul>}</>}
            {attempt.checks.map((check, index) => <details key={index}><summary>{check.command} {check.args.join(' ')} · {check.exitCode === 0 ? 'Passed' : 'Failed'}</summary><pre className="studio-output">{check.output}</pre></details>)}
            {attempt.jobId && <p><button type="button" className="text-button" onClick={() => dispatchEvent(new CustomEvent('quiet:flow-watch', { detail: { runId: run.id, jobId: attempt.jobId } }))}><Icon id="terminal-icon" />Show this step’s output</button></p>}
            <details><summary>Instructions used for this step</summary><pre className="studio-output">{attempt.prompt}</pre></details>
          </li>)}</ol>
          <details><summary>Versions used for this run</summary><p className="muted">Workflow {run.workflow.revision} · Core prompt {run.policy.revision}</p></details>
        </div> : <p className="muted">{item.workflowName} · {dateLabel(item.createdAt)}</p>}
      </details>)}</div>
    </section>}
    {screen === 'rules' && policy && <section className="studio-view secondary-studio">
      <h2>Rules every workflow follows</h2><p className="muted">Required rules apply to every step. Editing a workflow cannot remove them.</p>
      <div className="rules-card"><pre className="rules-text">{policy.coreRules}</pre></div>
      <details><summary>Edit the core prompt</summary>
        <p className="muted">Changes apply to future runs. Existing runs keep their original instructions.</p>
        <label>Start from an earlier version<select value="" onChange={event => { const earlier = policyRevisions.find(item => item.revision === event.target.value); if (earlier) setPolicyText(earlier.template) }}><option value="">Choose a saved version</option>{policyRevisions.map(item => <option key={item.revision} value={item.revision}>{dateLabel(item.createdAt)}{item.revision === policy.revision ? ' · current' : ''}</option>)}</select></label>
        <label>Prompt template<textarea className="prompt-template" rows={14} value={policyText} onChange={event => setPolicyText(event.target.value)} /></label>
        <p className="muted">Keep one each of {'{{core_rules}}'}, {'{{workflow}}'} and {'{{assignment}}'}.</p>
        <button type="button" className="pill" disabled={busy || policyText === policy.template} onClick={() => void action(async () => { const next = await api<PolicyRevision>('/policy', { template: policyText }); setPolicy(next); setPolicyText(next.template); setPolicyRevisions((await api<{ revisions: PolicyRevision[] }>('/policy/revisions')).revisions); toast('Core prompt saved for future runs.') })}>Save prompt</button>
      </details>
    </section>}
    {modal && <dialog ref={dialog} className="access-dialog flat" onClose={() => setModal(null)} aria-labelledby="studio-dialog-title">
      <header className="dialog-heading"><h2 id="studio-dialog-title">{modal === 'rules' ? 'Rules you can rely on' : 'Run this workflow'}</h2><form method="dialog"><button className="round" aria-label="Close dialog"><Icon id="close-icon" /></button></form></header>
      {modal === 'rules' ? <><p className="muted">Every workflow follows your project instructions, reports actual evidence, and requires a verified plan and an independent review for implementation work.</p><p className="muted">These rules stay in place when you edit a workflow or ask AI to change it.</p><button type="button" className="pill" onClick={closeModal}>Back to workflow</button></>
        : <form className="field-stack" onSubmit={event => { event.preventDefault(); void action(async () => { const started = await api<WorkflowRun>('/runs', { workflowId: graph!.id, revision: graph!.revision, cwd, label: runTitle, request }); setRun(started); closeModal(); go('runs'); toast('Workflow started.') }) }}>
          <label>Run title<input required value={runTitle} onChange={event => setRunTitle(event.target.value)} /></label>
          <label>Project folder<input required value={cwd} onChange={event => setCwd(event.target.value)} placeholder="/Users/you/projects/my-project" /></label>
          <label>What should this run accomplish?<textarea required rows={4} value={request} onChange={event => setRequest(event.target.value)} /></label>
          <p className="muted">Your AIs will work in this folder using the workflow's configured tools and checks.</p>
          {runNote({ nodes: nodes.map(node => node.data) }) && <p className="muted">{runNote({ nodes: nodes.map(node => node.data) })}</p>}
          {error && <p role="alert" className="chat-error">{error}</p>}
          <button disabled={busy} className="pill" type="submit">{busy ? 'Starting…' : 'Start run'}</button>
        </form>}
    </dialog>}
  </>
}

const root = document.getElementById('studio-root')
if (root) createRoot(root).render(<Studio />)
