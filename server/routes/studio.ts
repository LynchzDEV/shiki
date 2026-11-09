import { Elysia } from 'elysia'
import { z } from 'zod'
import { requireLocal } from '../auth'
import { fromBrowser } from '../local-access'
import { BUILTIN_AGENTS, CONNECTION_PRESETS, connectionSchema, createConnectionStore, type AgentConnection } from '../agent-connections'
import { modelDiscovery, spawnBridge, type ModelDiscovery } from '../model-discovery'
import { listModels } from '../models'
import { modelsCache } from './models'
import { composeWorkflowPrompt, identifier, type WorkflowStore } from '../workflows'
import type { WorkflowBuilder } from '../workflow-builder'
import { RunActionError, type ApprovalContext, type WorkflowRun, type WorkflowRunner } from '../workflow-runner'
import { type AppConfig, readConfig } from '../secrets'
import { eventStreamResponse, type RunEvents } from '../run-events'
import { scopeSnapshot, versionView } from '../run-view'
import type { JobRecord } from '../jobs'
import { logEvent } from '../log-events'

const changeBody = z.object({ graph: z.unknown(), reason: z.string().trim().min(1).max(500), scopeGrew: z.boolean().optional() })
const sessionBody = z.object({ chat: z.string().min(1).max(200).optional(), terminalId: identifier.optional(), version: z.number().int().min(1).optional() }).default({})
function approvalContext(request: Request, body: unknown): ApprovalContext {
  const { version, ...session } = sessionBody.parse(body ?? {})
  return fromBrowser(request) ? { via: 'drawer', ...(version ? { version } : {}) } : { via: 'conversation', ...session, ...(version ? { version } : {}) }
}

const publicRun = (run: WorkflowRun) => ({ ...run, versions: run.versions.map(versionView) })

function workflowIdFor(label: string, runId: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const prefixed = !slug ? `flow-${runId.slice(0, 8)}` : /^[0-9]/.test(slug) ? `flow-${slug}` : slug
  return prefixed.slice(0, 64).replace(/-+$/, '')
}

async function workflowExists(store: WorkflowStore, id: string): Promise<boolean> {
  try { await store.get(id); return true }
  catch (error) { if ((error as Error).message === 'Workflow not found') return false; throw error }
}

const PROBE_TIMEOUT_MS = 35_000

function rolesUsing(id: string, config: AppConfig): string[] {
  return [...Object.entries(config.roles).filter(([, role]) => role.engine === id).map(([name]) => name), ...(config.fallback?.engine === id ? ['fallback'] : [])]
}

async function saveConnection(connections: ReturnType<typeof createConnectionStore>, discovery: ModelDiscovery, body: unknown): Promise<AgentConnection> {
  const parsed = connectionSchema.safeParse(body)
  const endpoint = parsed.success && parsed.data.adapter === 'opencode' && parsed.data.baseUrl && parsed.data.models.length === 0 ? parsed.data : null
  if (!endpoint) {
    const saved = await connections.save(body)
    discovery.refreshLater(saved)
    return saved
  }
  const models = await discovery.endpoint(endpoint).catch((error: Error) => { throw new Error(`Couldn't list models from ${endpoint.baseUrl}: ${error.message}. Add at least one model ID.`) })
  if (!models.length) throw new Error(`Couldn't list models from ${endpoint.baseUrl}: it returned no models. Add at least one model ID.`)
  const saved = await connections.save(body)
  await discovery.record(saved.id, models)
  return saved
}

export function studioRoutes(store: WorkflowStore, runner: WorkflowRunner, builder?: WorkflowBuilder, events?: RunEvents, jobs?: () => JobRecord[], discovery: ModelDiscovery = modelDiscovery()) {
  const connections = createConnectionStore()
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .onError(({ error, set }) => {
      set.status = error instanceof RunActionError ? error.status : 400
      return { error: error instanceof Error ? error.message : 'Studio request failed' }
    })
    .get('/api/studio/drafts', () => ({ draft: builder?.current() ?? null }))
    .post('/api/studio/drafts', ({ body }) => { if (!builder) throw new Error('Workflow designer unavailable'); return builder.start(body) })
    .get('/api/studio/drafts/:id', ({ params }) => { if (!builder) throw new Error('Workflow designer unavailable'); return builder.get(params.id) })
    .post('/api/studio/drafts/:id/stop', ({ params }) => { if (!builder) throw new Error('Workflow designer unavailable'); return builder.stop(params.id) })
    .get('/api/studio/workflows', async () => ({ workflows: await store.list(), selected: await store.selected(), design: await store.design() }))
    .post('/api/studio/workflows', async ({ body }) => {
      const input = z.object({ workflow: z.unknown(), expectedRevision: z.string().optional() }).parse(body)
      return store.save(input.workflow, input.expectedRevision)
    })
    .get('/api/studio/workflows/:id/revisions', async ({ params }) => ({ revisions: await store.revisions(params.id) }))
    .post('/api/studio/default', async ({ body }) => {
      const input = z.union([z.object({ design: z.literal(true) }), z.object({ id: identifier, revision: identifier })]).parse(body)
      if ('design' in input) await store.setDesignDefault()
      else await store.setDefault(input.id, input.revision)
      return { ok: true }
    })
    .get('/api/studio/policy', () => store.policy())
    .get('/api/studio/policy/revisions', async () => ({ revisions: await store.policyRevisions() }))
    .post('/api/studio/policy', async ({ body }) => store.savePolicy(z.object({ template: z.string() }).parse(body).template))
    .post('/api/studio/preview', async ({ body }) => {
      const input = z.object({ id: identifier, revision: identifier, nodeId: identifier, request: z.string().max(32000) }).parse(body)
      const graph = await store.get(input.id, input.revision)
      const node = graph.nodes.find(node => node.id === input.nodeId)
      if (!node) throw new Error('Node not found')
      return { prompt: composeWorkflowPrompt(await store.policy(), graph, node, input.request, []) }
    })
    .get('/api/studio/connections', async () => {
      const saved = await connections.list()
      const models = await listModels({ discovery })
      const discovered = await Promise.all(saved.map(async connection => [connection.id, connection.adapter === 'cli' ? null : await discovery.read(connection.id)] as const))
      return { builtins: BUILTIN_AGENTS, connections: saved, presets: CONNECTION_PRESETS, models, roles: (await readConfig()).roles, discovery: Object.fromEntries(discovered) }
    })
    .post('/api/studio/connections', async ({ body }) => { const saved = await saveConnection(connections, discovery, body); modelsCache.invalidate(); return saved })
    .delete('/api/studio/connections/:id', async ({ params, set }) => {
      const users = BUILTIN_AGENTS.includes(params.id as typeof BUILTIN_AGENTS[number]) ? [] : rolesUsing(params.id, await readConfig())
      if (users.length) { set.status = 409; return { error: `Connection "${params.id}" is in use by: ${users.join(', ')}. Give those to another AI first (shiki roles set <role> <ai>).` } }
      await connections.remove(params.id)
      await discovery.forget(params.id)
      modelsCache.invalidate()
      return { ok: true }
    })
    .post('/api/studio/connections/:id/models/refresh', async ({ params }) => {
      const connection = await connections.get(params.id)
      if (connection.adapter === 'cli') throw new Error("This connection can't report its models; list them in its settings.")
      const state = await discovery.refresh(connection)
      modelsCache.invalidate()
      return state
    })
    .post('/api/studio/connections/:id/probe', async ({ params }) => {
      const connection = await connections.get(params.id)
      if (connection.adapter === 'cli') throw new Error('CLI connections do not advertise protocol capabilities')
      const events = await spawnBridge({ connection, prompt: '', probe: true }, PROBE_TIMEOUT_MS)
      return events.find(event => event.type === logEvent('capabilities')) ?? { error: 'Agent did not advertise capabilities' }
    })
    .get('/api/studio/events', ({ query, request }) => {
      if (!events || !jobs) throw new Error('Live updates unavailable')
      const scope = { chat: query.chat || undefined, terminal: query.terminal || undefined, run: query.run || undefined }
      return eventStreamResponse(events, () => scopeSnapshot(runner.list(), jobs(), scope), request.signal)
    })
    .get('/api/studio/runs', ({ query }) => ({ runs: runner.list()
      .filter(run => (!query.chat || run.chatId === query.chat) && (!query.terminal || run.terminalId === query.terminal))
      .map(run => ({ id: run.id, label: run.label, status: run.status, error: run.error, workflowName: run.workflow.name, revision: run.workflow.revision, currentNodeId: run.currentNodeId, workingNodeIds: run.tokens.filter(token => token.state === 'working').map(token => token.nodeId), createdAt: run.createdAt, origin: run.origin, pending: run.versions.some(version => version.state === 'pending') })) }))
    .post('/api/studio/runs', ({ body, request }) => runner.start(body, { startedByUser: fromBrowser(request) }).then(publicRun))
    .get('/api/studio/runs/:id', ({ params, set }) => {
      const run = runner.get(params.id)
      if (!run) { set.status = 404; return { error: 'Run not found' } }
      return publicRun(run)
    })
    .post('/api/studio/runs/:id/approve', ({ params, body, request }) => runner.approve(params.id, approvalContext(request, body)).then(publicRun))
    .post('/api/studio/runs/:id/reject', ({ params, body, request }) => runner.reject(params.id, approvalContext(request, body)).then(publicRun))
    .get('/api/studio/runs/:id/steps/:nodeId', ({ params }) => runner.waitingStep(params.id, params.nodeId))
    .post('/api/studio/runs/:id/steps/:nodeId', ({ params, body, request }) => runner.report(params.id, params.nodeId, body, approvalContext(request, body)).then(publicRun))
    .post('/api/studio/runs/:id/steps/:nodeId/remind', ({ params, request }) => {
      if (!fromBrowser(request)) throw new RunActionError('Remind from the drawer', 403)
      return runner.remind(params.id, params.nodeId).then(publicRun)
    })
    .post('/api/studio/runs/:id/changes',({ params, body, request }) => runner.propose(params.id, changeBody.parse(body), approvalContext(request, body)).then(publicRun))
    .post('/api/studio/runs/:id/save', async ({ params, request }) => {
      if (!fromBrowser(request)) throw new RunActionError('Save from the drawer', 403)
      const run = runner.get(params.id)
      if (!run) throw new RunActionError('Run not found', 404)
      const id = workflowIdFor(run.label, run.id)
      if (await workflowExists(store, id)) throw new RunActionError('A workflow with that name exists', 409)
      const { revision: _revision, createdAt: _createdAt, ...graph } = run.workflow
      return store.save({ ...graph, id, name: run.label })
    })
    .post('/api/studio/runs/:id/pause', ({ params }) => runner.pause(params.id).then(publicRun))
    .post('/api/studio/runs/:id/resume', ({ params }) => runner.resume(params.id).then(publicRun))
    .post('/api/studio/runs/:id/stop', ({ params }) => runner.stop(params.id).then(publicRun))
    .post('/api/studio/runs/:id/retry', ({ params }) => runner.retry(params.id).then(publicRun))
    .post('/api/studio/runs/:id/dismiss', ({ params }) => runner.dismiss(params.id).then(publicRun))
}
