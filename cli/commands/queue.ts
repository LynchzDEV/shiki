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
    path: ['queue', 'requeue'],
    args: ['id'],
    summary: 'Put a failed, ready or waiting item back in line',
    run: async (ctx) => emit(ctx, await ctx.client.post(itemPath(ctx, '/requeue'), {}), () => 'Back in the queue.\n'),
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
    path: ['queue', 'check'],
    summary: 'Check sources for replies now',
    run: async (ctx) => emit(ctx, await ctx.client.post('/api/queue/check', {}), (value) => `Checked ${cell(field(value, 'checked'))}, resumed ${cell(field(value, 'resumed'))}\n`),
  },
]
