import { readFile } from 'node:fs/promises'

import { segment } from '../client'
import { arg, emit, flag, listOpt, oneOf, records, SESSION_OPTIONS, sessionBody, stringOpt, textArg, UsageError, type Command, type Context } from '../command'
import { cell, keyValue, relativeAge, table } from '../format'
import { CHANGE_OPTIONS, fileOption } from './messages'
import { actorOf, whyOf } from './queue'

const LABEL_MAX = 120
const STEP_OUTCOMES = ['pass', 'fail', 'blocked'] as const

const runPath = (ctx: Context, suffix = ''): string => `/api/studio/runs/${segment(arg(ctx, 'id'))}${suffix}`
const stepPath = (ctx: Context, suffix = ''): string => `/api/studio/runs/${segment(arg(ctx, 'runId'))}/steps/${segment(arg(ctx, 'nodeId'))}${suffix}`

function runsText(value: unknown): string {
  const runs = records(value, 'runs')
  if (runs.length === 0) return 'No runs.\n'
  return table(runs, [
    { header: 'ID', value: (run) => cell(run.id) },
    { header: 'STATUS', value: (run) => cell(run.status) },
    { header: 'WORKFLOW', value: (run) => cell(run.workflowName) },
    { header: 'AGE', value: (run) => relativeAge(run.createdAt) },
    { header: 'LABEL', value: (run) => cell(run.label) },
  ])
}

function workflowsText(value: unknown): string {
  const workflows = records(value, 'workflows')
  const selected = value !== null && typeof value === 'object' ? (value as Record<string, unknown>).selected : undefined
  const selectedId = selected !== null && typeof selected === 'object' ? (selected as Record<string, unknown>).id : undefined
  if (workflows.length === 0) return 'No workflows.\n'
  return table(workflows, [
    { header: 'ID', value: (workflow) => `${cell(workflow.id)}${workflow.id === selectedId ? ' *' : ''}` },
    { header: 'NAME', value: (workflow) => cell(workflow.name) },
    { header: 'REVISION', value: (workflow) => cell(workflow.revision) },
    { header: 'NODES', value: (workflow) => (Array.isArray(workflow.nodes) ? String(workflow.nodes.length) : '-') },
  ])
}

function optionalFields(ctx: Context, pairs: Array<[string, string]>): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const [option, field] of pairs) {
    const value = stringOpt(ctx, option)
    if (value !== undefined) fields[field] = value
  }
  return fields
}

async function startRun(ctx: Context): Promise<void> {
  const request = await textArg(ctx, 'request')
  const label = stringOpt(ctx, 'label') ?? (request.split('\n')[0] ?? '').trim().slice(0, LABEL_MAX)
  if (request.trim() === '' || label === '') throw new UsageError('the request is empty')
  const body = {
    workflowId: arg(ctx, 'workflowId'),
    request,
    label,
    cwd: stringOpt(ctx, 'cwd') ?? ctx.cwd,
    ...optionalFields(ctx, [['revision', 'revision'], ['engine', 'engine'], ['model', 'model'], ['terminal', 'terminalId'], ['chat', 'chat']]),
  }
  emit(ctx, await ctx.client.post('/api/studio/runs', body), keyValue)
}

async function proposeChanges(ctx: Context): Promise<void> {
  const graphFile = stringOpt(ctx, 'graph')
  const reason = stringOpt(ctx, 'reason')
  if (graphFile === undefined) throw new UsageError('--graph <file> is required')
  if (reason === undefined || reason.trim() === '') throw new UsageError('--reason is required')
  const session = sessionBody(ctx)
  let graph: unknown
  try {
    graph = JSON.parse(await readFile(graphFile, 'utf8'))
  } catch (error) {
    throw new UsageError(`could not read a JSON graph from ${graphFile}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const body = { graph, reason, ...(flag(ctx, 'scope-grew') ? { scopeGrew: true } : {}), ...session }
  emit(ctx, await ctx.client.post(runPath(ctx, '/changes'), body), keyValue)
}

async function step(ctx: Context): Promise<void> {
  if (!flag(ctx, 'post')) {
    emit(ctx, await ctx.client.get(stepPath(ctx)), keyValue)
    return
  }
  const outcome = oneOf(stringOpt(ctx, 'outcome') ?? '', STEP_OUTCOMES, '--outcome')
  const summary = stringOpt(ctx, 'summary')
  if (summary === undefined || summary.trim() === '') throw new UsageError('--summary is required with --post')
  const output = stringOpt(ctx, 'output')
  const body = { outcome, summary, evidence: listOpt(ctx, 'evidence'), ...(output === undefined ? {} : { output }), ...sessionBody(ctx) }
  emit(ctx, await ctx.client.post(stepPath(ctx), body), keyValue)
}

function bareVerb(verb: string, summary: string): Command {
  return { path: ['run', verb], args: ['id'], summary, run: async (ctx) => emit(ctx, await ctx.client.post(runPath(ctx, `/${verb}`)), keyValue) }
}

function decisionVerb(verb: string, summary: string): Command {
  return {
    path: ['run', verb],
    args: ['id'],
    options: SESSION_OPTIONS,
    summary,
    run: async (ctx) => emit(ctx, await ctx.client.post(runPath(ctx, `/${verb}`), sessionBody(ctx)), keyValue),
  }
}

const overlayPath = (ctx: Context): string => `/api/studio/flow-overlays/${segment(arg(ctx, 'flowId'))}`

function overlayText(value: unknown): string {
  const nodes = Object.entries((((value ?? {}) as Record<string, unknown>).overlay as { nodes?: Record<string, Record<string, unknown>> } | undefined)?.nodes ?? {})
  if (nodes.length === 0) return 'No overrides: every step uses the plugin\'s own text.\n'
  return `${nodes.map(([id, node]) => [`${id}:`, ...(typeof node.title === 'string' ? [`  title: ${node.title}`] : []), ...(typeof node.instructions === 'string' ? ['  instructions:', ...node.instructions.split('\n').map(line => `    ${line}`)] : [])].join('\n')).join('\n')}\n`
}

export const studioCommands: Command[] = [
  { path: ['workflows'], summary: 'Saved workflows (* marks the default)', run: async (ctx) => emit(ctx, await ctx.client.get('/api/studio/workflows'), workflowsText) },
  {
    path: ['workflow', 'revisions'],
    args: ['id'],
    summary: 'Revision history of one workflow',
    run: async (ctx) => emit(ctx, await ctx.client.get(`/api/studio/workflows/${segment(arg(ctx, 'id'))}/revisions`), keyValue),
  },
  { path: ['policy'], summary: 'The policy template every workflow step gets', run: async (ctx) => emit(ctx, await ctx.client.get('/api/studio/policy'), keyValue) },
  {
    path: ['runs'],
    options: {
      chat: { type: 'string', description: 'only runs of this chat', placeholder: 'ID' },
      terminal: { type: 'string', description: 'only runs of this terminal', placeholder: 'ID' },
    },
    summary: 'Workflow runs',
    run: async (ctx) => emit(ctx, await ctx.client.get('/api/studio/runs', { chat: stringOpt(ctx, 'chat'), terminal: stringOpt(ctx, 'terminal') }), runsText),
  },
  { path: ['run', 'show'], args: ['id'], summary: 'One run in full', run: async (ctx) => emit(ctx, await ctx.client.get(runPath(ctx)), keyValue) },
  {
    path: ['run', 'start'],
    args: ['workflowId', 'request'],
    options: {
      label: { type: 'string', description: 'run name (default: first line of the request)', placeholder: 'L' },
      cwd: { type: 'string', description: 'repo to work in (default: current folder)', placeholder: 'DIR' },
      revision: { type: 'string', description: 'workflow revision (default: latest)', placeholder: 'REV' },
      engine: { type: 'string', description: 'engine override', placeholder: 'E' },
      model: { type: 'string', description: 'model override', placeholder: 'M' },
      terminal: { type: 'string', description: 'terminal that owns the run', placeholder: 'ID' },
      chat: { type: 'string', description: 'chat that owns the run', placeholder: 'ID' },
    },
    summary: 'Start a workflow run; pass - as the request to read it from stdin',
    run: startRun,
  },
  bareVerb('stop', 'Stop a run'),
  bareVerb('retry', 'Retry a run’s failed step'),
  bareVerb('pause', 'Pause a run'),
  bareVerb('resume', 'Resume a paused run'),
  decisionVerb('approve', 'Approve a run waiting for you'),
  decisionVerb('reject', 'Reject a run waiting for you'),
  {
    path: ['run', 'changes'],
    args: ['id'],
    options: {
      graph: { type: 'string', description: 'JSON file with the proposed graph (required)', placeholder: 'FILE' },
      reason: { type: 'string', description: 'why the flow should change (required)', placeholder: 'TEXT' },
      'scope-grew': { type: 'boolean', description: 'the change widens the scope' },
      ...SESSION_OPTIONS,
    },
    summary: 'Propose a change to a running flow',
    run: proposeChanges,
  },
  {
    path: ['run', 'step'],
    args: ['runId', 'nodeId'],
    options: {
      post: { type: 'boolean', description: 'report the step result instead of reading it' },
      outcome: { type: 'string', description: 'pass, fail or blocked (with --post)', placeholder: 'O' },
      summary: { type: 'string', description: 'what happened (with --post)', placeholder: 'TEXT' },
      evidence: { type: 'string', multiple: true, description: 'one piece of evidence; repeat for more (with --post)', placeholder: 'TEXT' },
      output: { type: 'string', description: 'full step output (with --post)', placeholder: 'TEXT' },
      ...SESSION_OPTIONS,
    },
    summary: 'Read a step waiting on this session, or report it with --post',
    run: step,
  },
  {
    path: ['run', 'remind'],
    args: ['runId', 'nodeId'],
    summary: 'Remind the session about a waiting step (the server only accepts this from the browser)',
    run: async (ctx) => emit(ctx, await ctx.client.post(stepPath(ctx, '/remind')), keyValue),
  },
  {
    path: ['studio', 'overlay', 'show'],
    args: ['flowId'],
    summary: 'Show the local step text overrides for a plugin flow',
    run: async (ctx) => emit(ctx, await ctx.client.get(overlayPath(ctx)), overlayText),
  },
  {
    path: ['studio', 'overlay', 'set'],
    args: ['flowId', 'nodeId'],
    options: { file: { type: 'string', description: 'file holding the step instructions', placeholder: 'FILE' }, title: { type: 'string', description: 'new step title', placeholder: 'TEXT' }, ...CHANGE_OPTIONS },
    summary: 'Override one plugin flow step\'s instructions or title; new runs use it (human only)',
    run: async (ctx) => {
      const instructions = await fileOption(ctx, false)
      const title = stringOpt(ctx, 'title')
      if (instructions === undefined && title === undefined) throw new UsageError('give --file, --title or both')
      const body = { actor: actorOf(ctx), why: whyOf(ctx), nodeId: arg(ctx, 'nodeId'), ...(instructions === undefined ? {} : { instructions }), ...(title === undefined ? {} : { title }) }
      emit(ctx, await ctx.client.put(overlayPath(ctx), body), overlayText)
    },
  },
  {
    path: ['studio', 'overlay', 'clear'],
    args: ['flowId', 'nodeId?'],
    options: CHANGE_OPTIONS,
    summary: 'Drop one step\'s override, or all of a flow\'s overrides (human only)',
    run: async (ctx) => emit(ctx, await ctx.client.del(overlayPath(ctx), { actor: actorOf(ctx), why: whyOf(ctx), ...(ctx.args.nodeId === undefined ? {} : { nodeId: ctx.args.nodeId }) }), overlayText),
  },
]
