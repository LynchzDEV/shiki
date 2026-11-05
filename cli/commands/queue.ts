import { resolve } from 'node:path'

import { segment } from '../client'
import { arg, emit, expandHome, flag, records, stringOpt, UsageError, type Command, type Context } from '../command'
import { cell, table } from '../format'
import { repoNamesProblem } from '../../server/repo-names'

type Json = Record<string, unknown>

const EMPTY_QUEUE = 'The queue is empty. Add an item with: shiki queue add <source> <id> --repo <dir>\n'

const itemPath = (ctx: Context, suffix = ''): string => `/api/queue/${segment(arg(ctx, 'id'))}${suffix}`
const field = (value: unknown, key: string): unknown => (value !== null && typeof value === 'object' ? (value as Json)[key] : undefined)

function note(item: Json): string {
  if (typeof item.error === 'string' && item.error !== '') return item.error
  return Array.isArray(item.questions) ? item.questions.map(String).join(' / ') : ''
}

function listText(value: unknown): string {
  const rows = records(value, 'items')
  if (rows.length === 0) return EMPTY_QUEUE
  return table(rows, [
    { header: 'ID', value: (item) => cell(item.id) },
    { header: 'STATE', value: (item) => cell(item.state) },
    { header: 'SOURCE', value: (item) => cell(item.source) },
    { header: 'TITLE', value: (item) => cell(item.title) },
    { header: 'REPOS', value: (item) => cell(reposText(item)) },
    { header: 'ERROR/QUESTIONS', value: (item) => cell(note(item)) },
  ])
}

function reposOption(ctx: Context): string[] | undefined {
  const given = stringOpt(ctx, 'repos')
  if (given === undefined) return undefined
  const repos = given.split(',').map(name => name.trim()).filter(name => name !== '')
  const problem = repoNamesProblem(repos)
  if (problem !== null) throw new UsageError(problem)
  return repos
}

function reposText(item: Json): string {
  if (!Array.isArray(item.repos)) return '-'
  return item.repos.length === 0 ? 'plan picks' : item.repos.map(String).join(', ')
}

function optionalText(ctx: Context, name: string): Json {
  const value = stringOpt(ctx, name)
  return value === undefined ? {} : { [name]: value }
}

function position(ctx: Context): number {
  const text = arg(ctx, 'to')
  if (!/^\d+$/.test(text)) throw new UsageError('to must be a whole number from 0')
  return Number(text)
}

function parallelOption(ctx: Context): number {
  const text = arg(ctx, 'n')
  if (!/^[1-4]$/.test(text)) throw new UsageError('parallel must be a whole number from 1 to 4')
  return Number(text)
}

const parallelText = (value: unknown): string => {
  const parallel = field(value, 'parallel')
  return parallel === 1 ? 'One card builds at a time.\n' : `Up to ${cell(parallel)} cards build at once.\n`
}

function addBody(ctx: Context): Json {
  const flowId = stringOpt(ctx, 'flow')
  const repos = reposOption(ctx)
  return {
    source: arg(ctx, 'source'),
    externalId: arg(ctx, 'externalId'),
    repo: resolve(ctx.cwd, expandHome(stringOpt(ctx, 'repo') ?? ctx.cwd)),
    ...(repos === undefined ? {} : { repos }),
    ...(flowId === undefined ? {} : { flowId }),
    position: flag(ctx, 'next') ? 'next' : 'end',
  }
}

function preflightOf(list: unknown, id: string, stage: string): Json {
  const item = records(list, 'items').find((entry) => entry.id === id)
  if (item === undefined) throw new UsageError(`no queue item ${id}`)
  const preflight = field(field(field(field(item, 'land'), 'stages'), stage), 'preflight')
  return preflight !== null && typeof preflight === 'object' ? (preflight as Json) : {}
}

async function landStage(ctx: Context): Promise<void> {
  const id = arg(ctx, 'id')
  const stage = arg(ctx, 'stage')
  const preflight = preflightOf(await ctx.client.get('/api/queue'), id, stage)
  const shown = `${typeof preflight.markdown === 'string' ? preflight.markdown.trimEnd() : ''}\n`
  if (!flag(ctx, 'yes')) {
    const blocked = typeof preflight.exitCode === 'number' && preflight.exitCode !== 0
    emit(ctx, { stage, preflight }, () => `${shown}${blocked ? `This stage is blocked by its preflight (exit ${preflight.exitCode}).` : `Run again with --yes to start ${stage}.`}\n`)
    return
  }
  if (!ctx.json) ctx.out(shown)
  emit(ctx, await ctx.client.post(itemPath(ctx, `/land/${segment(stage)}/start`), { confirm: true }), () => `Started ${stage}.\n`)
}

export const queueCommands: Command[] = [
  {
    path: ['queue', 'list'],
    summary: 'Show the queue in build order',
    run: async (ctx) => emit(ctx, await ctx.client.get('/api/queue'), listText),
  },
  {
    path: ['queue', 'add'],
    args: ['source', 'externalId'],
    options: {
      repo: { type: 'string', description: 'repo, or folder of repos, the item is built in (default: current directory)', placeholder: 'DIR' },
      repos: { type: 'string', description: 'repos inside --repo this item touches, comma separated (default: the plan picks)', placeholder: 'A,B' },
      flow: { type: 'string', description: 'saved flow id', placeholder: 'ID' },
      next: { type: 'boolean', description: 'put it first' },
    },
    summary: 'Add a source item to the queue',
    run: async (ctx) => emit(ctx, await ctx.client.post('/api/queue', addBody(ctx)), (value) => `Added ${cell(field(field(value, 'item'), 'title'))}.\n`),
  },
  {
    path: ['queue', 'move'],
    args: ['id', 'to'],
    summary: 'Move an item to a position (0 is first)',
    run: async (ctx) => {
      const to = position(ctx)
      emit(ctx, await ctx.client.post(itemPath(ctx, '/move'), { to }), listText)
    },
  },
  {
    path: ['queue', 'parallel'],
    args: ['n'],
    summary: 'Set how many cards build at once, 1 to 4 (default 1)',
    run: async (ctx) => {
      const parallel = parallelOption(ctx)
      emit(ctx, await ctx.client.put('/api/queue/settings', { parallel }), parallelText)
    },
  },
  {
    path: ['queue', 'requeue'],
    args: ['id'],
    options: { fresh: { type: 'boolean', description: 'start a new run instead of resuming the failed one' } },
    summary: 'Put a failed, ready or waiting item back in line; a failed item resumes its last run',
    run: async (ctx) => emit(ctx, await ctx.client.post(itemPath(ctx, '/requeue'), flag(ctx, 'fresh') ? { fresh: true } : {}), () => 'Back in the queue.\n'),
  },
  {
    path: ['queue', 'pick'],
    args: ['id', 'option'],
    options: {
      tester: { type: 'string', description: 'who to tag when the build is ready', placeholder: 'NAME' },
      note: { type: 'string', description: 'a note for the next run', placeholder: 'TEXT' },
    },
    summary: 'Choose a design variant for an item waiting on a pick',
    run: async (ctx) => {
      const body = { option: arg(ctx, 'option'), ...optionalText(ctx, 'tester'), ...optionalText(ctx, 'note') }
      emit(ctx, await ctx.client.post(itemPath(ctx, '/pick'), body), () => `Picked ${arg(ctx, 'option')}. Back in the queue.\n`)
    },
  },
  {
    path: ['queue', 'remove'],
    args: ['id'],
    summary: 'Remove an item that is not building',
    run: async (ctx) => emit(ctx, await ctx.client.del(itemPath(ctx)), () => 'Removed.\n'),
  },
  {
    path: ['queue', 'report'],
    args: ['id'],
    summary: 'Show the report of an item: its runs and every land stage',
    run: async (ctx) => ctx.out(await ctx.client.getText(itemPath(ctx, '/report'))),
  },
  {
    path: ['queue', 'land'],
    args: ['id', 'stage'],
    options: { yes: { type: 'boolean', description: 'start the stage (without it: show its preflight only)' } },
    summary: 'Show the preflight of a waiting land stage and, with --yes, start it',
    run: landStage,
  },
  {
    path: ['queue', 'done'],
    args: ['id'],
    summary: 'Close an item waiting on a land stage as done, without running the stage',
    run: async (ctx) => emit(ctx, await ctx.client.post(itemPath(ctx, '/land/done'), {}), () => 'Marked done.\n'),
  },
  {
    path: ['queue', 'check'],
    summary: 'Check sources for replies now',
    run: async (ctx) => emit(ctx, await ctx.client.post('/api/queue/check', {}), (value) => `Checked ${cell(field(value, 'checked'))}, resumed ${cell(field(value, 'resumed'))}\n`),
  },
]
