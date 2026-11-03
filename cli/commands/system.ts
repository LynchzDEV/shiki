import { ApiError, segment } from '../client'
import { arg, countOpt, emit, flag, oneOf, records, stringOpt, UsageError, type Command, type Context } from '../command'
import { cell, keyValue, relativeAge, table } from '../format'

const ROLE_NAMES = ['plan', 'execute', 'review'] as const
const ROLE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const NOT_ROLES: readonly string[] = ['autoReview', 'fallback']
const FLOW_APPROVAL_VALUES: Record<string, boolean> = { on: true, true: true, off: false, false: false }
const DEFAULT_ENGINE = 'claude'
const USAGE_WINDOWS: Array<[string, string]> = [['fiveHourPct', '5h'], ['weeklyPct', 'week'], ['monthlyPct', 'month']]

type RoleAssignment = { engine: string; model: string | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function settle(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message }
    throw error
  }
}

function usageLine(name: string, quota: unknown): string {
  if (!isRecord(quota)) return `  ${name}: -`
  if (quota.available !== true) return `  ${name}: unavailable${typeof quota.reason === 'string' ? ` (${quota.reason})` : ''}`
  const windows = USAGE_WINDOWS.filter(([key]) => typeof quota[key] === 'number').map(([key, label]) => `${label} ${quota[key]}%`)
  return `  ${name}: ${windows.length === 0 ? 'available' : windows.join(', ')}`
}

function roleLine(name: string, role: unknown): string {
  const assignment = isRecord(role) ? role : {}
  return `  ${name.padEnd(8)}${cell(assignment.engine)}${typeof assignment.model === 'string' ? ` (${assignment.model})` : ''}`
}

function statusText(url: string, doc: { quota: unknown; roles: unknown }): string {
  const quota = isRecord(doc.quota) ? doc.quota : {}
  const usage = 'error' in quota ? [`  ${cell(quota.error)}`] : Object.keys(quota).filter((key) => key !== 'peak').map((key) => usageLine(key, quota[key]))
  const roles = isRecord(doc.roles) ? doc.roles : {}
  const roleLines = 'error' in roles ? [`  ${cell(roles.error)}`] : roleNames(roles).map((name) => roleLine(name, roles[name]))
  const fallback = 'fallback' in roles ? [roles.fallback === null ? '  fallback off' : roleLine('fallback', roles.fallback)] : []
  return [`Shikidan: up at ${url}`, 'Usage:', ...usage, 'Roles:', ...roleLines, ...fallback, ...(typeof roles.autoReview === 'boolean' ? [`  auto-review ${roles.autoReview ? 'on' : 'off'}`] : [])].join('\n') + '\n'
}

function roleAssignment(value: unknown): RoleAssignment {
  const record = isRecord(value) ? value : {}
  return { engine: typeof record.engine === 'string' ? record.engine : '', model: typeof record.model === 'string' ? record.model : null }
}

function roleNames(roles: Record<string, unknown>): string[] {
  return [...ROLE_NAMES, ...Object.keys(roles).filter((name) => !(ROLE_NAMES as readonly string[]).includes(name) && !NOT_ROLES.includes(name) && isRecord(roles[name]))]
}

async function setRole(ctx: Context): Promise<void> {
  const role = arg(ctx, 'role')
  if (!ROLE_NAME.test(role) || NOT_ROLES.includes(role)) throw new UsageError('role must be plan, execute, review or a name of letters, digits, - and _')
  const current = await ctx.client.get('/api/roles')
  const roles = Object.fromEntries(roleNames(isRecord(current) ? current : {}).map((name) => [name, roleAssignment(isRecord(current) ? current[name] : undefined)]))
  const next = { ...roles, [role]: { engine: arg(ctx, 'engine'), model: stringOpt(ctx, 'model') ?? null } }
  emit(ctx, await ctx.client.post('/api/roles', next), keyValue)
}

function listWithLimit(key: string, limit: number | undefined) {
  return (value: unknown): unknown => {
    if (limit === undefined || !isRecord(value) || !Array.isArray(value[key])) return value
    return { ...value, [key]: value[key].slice(0, limit) }
  }
}

function attentionText(value: unknown): string {
  const items = records(value, 'items')
  if (items.length === 0) return 'Nothing is waiting on you.\n'
  return table(items, [
    { header: 'KEY', value: (item) => cell(item.key) },
    { header: 'KIND', value: (item) => cell(item.kind) },
    { header: 'AGE', value: (item) => relativeAge(item.createdAt) },
    { header: 'TITLE', value: (item) => cell(item.title) },
  ])
}

function terminalsText(value: unknown): string {
  const sessions = records(value, 'sessions')
  if (sessions.length === 0) return 'No live terminals.\n'
  return table(sessions, [
    { header: 'ID', value: (row) => cell(row.id) },
    { header: 'ENGINE', value: (row) => cell(row.engine) },
    { header: 'AGE', value: (row) => relativeAge(row.createdAt) },
    { header: 'TITLE', value: (row) => cell(row.title) },
    { header: 'CWD', value: (row) => cell(row.cwd) },
  ])
}

function modelsText(models: unknown, state: unknown): string {
  const record = isRecord(state) ? state : {}
  const names = Array.isArray(models) ? models.filter((model): model is string => typeof model === 'string') : []
  const lines = [`models: ${names.length ? names.join(', ') : '(none)'}`]
  if (typeof record.current === 'string') lines.push(`current: ${record.current}`)
  lines.push(`checked: ${typeof record.checkedAt === 'number' ? `${relativeAge(record.checkedAt)} ago` : 'never'}`)
  if (typeof record.error === 'string') lines.push(`error: ${record.error}`)
  return `${lines.join('\n')}\n`
}

async function connectionModels(ctx: Context): Promise<void> {
  const id = arg(ctx, 'id')
  if (flag(ctx, 'refresh')) {
    const state = await ctx.client.post(`/api/studio/connections/${segment(id)}/models/refresh`)
    emit(ctx, state, (value) => modelsText(isRecord(value) ? value.models : [], value))
    return
  }
  const doc = await ctx.client.get('/api/studio/connections')
  const record = isRecord(doc) ? doc : {}
  if (!records(record, 'connections').some((connection) => connection.id === id)) throw new ApiError(404, `Connection "${id}" is not configured`)
  const state = isRecord(record.discovery) ? record.discovery[id] ?? null : null
  emit(ctx, state, (value) => modelsText(isRecord(record.models) ? record.models[id] : [], value))
}

const MODEL_OPTION = { model: { type: 'string', description: 'model id', placeholder: 'M' } } as const

export const systemCommands: Command[] = [
  {
    path: ['status'],
    summary: 'Is Shikidan up, usage per provider, and who plays each role',
    run: async (ctx) => {
      const health = await ctx.client.get('/api/health')
      const [quota, roles] = await Promise.all([settle(ctx.client.get('/api/quota')), settle(ctx.client.get('/api/roles'))])
      emit(ctx, { health, quota, roles }, (doc) => statusText(ctx.client.url, doc as { quota: unknown; roles: unknown }))
    },
  },
  { path: ['roles'], summary: 'Show which engine plays each role, and the fallback AI', run: async (ctx) => emit(ctx, await ctx.client.get('/api/roles'), keyValue) },
  {
    path: ['roles', 'set'],
    args: ['role', 'engine'],
    options: MODEL_OPTION,
    summary: 'Assign an engine (and optional model) to plan, execute, review or a named role',
    run: setRole,
  },
  { path: ['models'], summary: 'List the models each engine offers', run: async (ctx) => emit(ctx, await ctx.client.get('/api/models'), keyValue) },
  { path: ['providers'], summary: 'List connected AI providers', run: async (ctx) => emit(ctx, await ctx.client.get('/api/providers'), keyValue) },
  {
    path: ['history'],
    options: { limit: { type: 'string', description: 'show only the first N items', placeholder: 'N' } },
    summary: 'Recent chats, jobs, terminals and sessions',
    run: async (ctx) => emit(ctx, listWithLimit('items', countOpt(ctx, 'limit'))(await ctx.client.get('/api/history')), keyValue),
  },
  {
    path: ['outcomes'],
    options: {
      chat: { type: 'string', description: 'chat id', placeholder: 'ID' },
      terminal: { type: 'string', description: 'terminal id', placeholder: 'ID' },
      after: { type: 'string', description: 'skip the first N outcomes', placeholder: 'N' },
      limit: { type: 'string', description: 'at most N outcomes', placeholder: 'N' },
    },
    summary: 'Outcome ledger of one chat or terminal (pass exactly one of --chat/--terminal)',
    run: async (ctx) => {
      const chat = stringOpt(ctx, 'chat')
      const terminal = stringOpt(ctx, 'terminal')
      if ((chat === undefined) === (terminal === undefined)) throw new UsageError('pass exactly one of --chat or --terminal')
      const after = countOpt(ctx, 'after')
      const limit = countOpt(ctx, 'limit')
      const query = { chat, terminal, after: after === undefined ? undefined : String(after), limit: limit === undefined ? undefined : String(limit) }
      emit(ctx, await ctx.client.get('/api/outcomes', query), keyValue)
    },
  },
  { path: ['attention'], summary: 'What is waiting on you', run: async (ctx) => emit(ctx, await ctx.client.get('/api/attention'), attentionText) },
  {
    path: ['attention', 'dismiss'],
    args: ['key'],
    summary: 'Dismiss one waiting item (not permission requests)',
    run: async (ctx) => emit(ctx, await ctx.client.post(`/api/attention/${segment(arg(ctx, 'key'))}/dismiss`), keyValue),
  },
  { path: ['terminals'], summary: 'List live terminals', run: async (ctx) => emit(ctx, await ctx.client.get('/api/terminals'), terminalsText) },
  {
    path: ['terminal', 'new'],
    options: {
      engine: { type: 'string', description: `engine to run (default ${DEFAULT_ENGINE})`, placeholder: 'E' },
      cwd: { type: 'string', description: 'folder to open in (default: current folder)', placeholder: 'DIR' },
      ...MODEL_OPTION,
      title: { type: 'string', description: 'terminal name', placeholder: 'T' },
      resume: { type: 'string', description: 'session id to resume', placeholder: 'SID' },
      workflow: { type: 'string', description: 'workflow id to pin', placeholder: 'ID' },
      revision: { type: 'string', description: 'workflow revision to pin', placeholder: 'REV' },
    },
    summary: 'Open a new terminal',
    run: async (ctx) => {
      const optional: Array<[string, string]> = [['model', 'model'], ['title', 'title'], ['resume', 'resumeSessionId'], ['workflow', 'workflowId'], ['revision', 'revision']]
      const body: Record<string, unknown> = { engine: stringOpt(ctx, 'engine') ?? DEFAULT_ENGINE, cwd: stringOpt(ctx, 'cwd') ?? ctx.cwd }
      for (const [option, field] of optional) {
        const value = stringOpt(ctx, option)
        if (value !== undefined) body[field] = value
      }
      emit(ctx, await ctx.client.post('/api/terminals', body), keyValue)
    },
  },
  {
    path: ['terminal', 'rename'],
    args: ['id', 'name'],
    summary: 'Rename a terminal',
    run: async (ctx) => emit(ctx, await ctx.client.patch(`/api/terminals/${segment(arg(ctx, 'id'))}`, { title: arg(ctx, 'name') }), keyValue),
  },
  {
    path: ['terminal', 'close'],
    args: ['id'],
    summary: 'End a terminal',
    run: async (ctx) => emit(ctx, await ctx.client.del(`/api/terminals/${segment(arg(ctx, 'id'))}`), keyValue),
  },
  {
    path: ['terminal', 'thread'],
    args: ['id'],
    summary: 'Transcript of a terminal session',
    run: async (ctx) => emit(ctx, await ctx.client.get(`/api/terminals/${segment(arg(ctx, 'id'))}/thread`), keyValue),
  },
  {
    path: ['terminal', 'sessions'],
    options: { cwd: { type: 'string', description: 'folder to list sessions for (default: current folder)', placeholder: 'DIR' } },
    summary: 'Past sessions that a terminal could resume in a folder',
    run: async (ctx) => emit(ctx, await ctx.client.get('/api/terminals/sessions', { cwd: stringOpt(ctx, 'cwd') ?? ctx.cwd }), keyValue),
  },
  { path: ['connections'], summary: 'Built-in and connected AI agents', run: async (ctx) => emit(ctx, await ctx.client.get('/api/studio/connections'), keyValue) },
  {
    path: ['connection', 'probe'],
    args: ['id'],
    summary: 'Ask a connected agent what it can do',
    run: async (ctx) => emit(ctx, await ctx.client.post(`/api/studio/connections/${segment(arg(ctx, 'id'))}/probe`), keyValue),
  },
  {
    path: ['connection', 'models'],
    args: ['id'],
    options: { refresh: { type: 'boolean', description: 'ask the agent for its models now' } },
    summary: 'Models a connected agent reports, when they were checked and any error',
    run: connectionModels,
  },
  { path: ['flow-approval'], summary: 'Whether flows started by an AI wait for your approval', run: async (ctx) => emit(ctx, await ctx.client.get('/api/flow-approval'), keyValue) },
  {
    path: ['flow-approval', 'set'],
    args: ['value'],
    summary: 'Turn flow approval on or off (on|off|true|false)',
    run: async (ctx) => {
      const word = arg(ctx, 'value')
      const value = Object.hasOwn(FLOW_APPROVAL_VALUES, word) ? FLOW_APPROVAL_VALUES[word] : undefined
      if (value === undefined) throw new UsageError('value must be one of on, off, true, false')
      emit(ctx, await ctx.client.put('/api/flow-approval', { flowApproval: value }), keyValue)
    },
  },
]
