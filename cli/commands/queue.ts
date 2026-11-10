import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { segment } from '../client'
import { arg, countOpt, emit, expandHome, flag, records, stringOpt, UsageError, type Command, type Context, type OptionSpec } from '../command'
import { cell, table } from '../format'
import { readEnv } from '../../server/env'
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

function wholeArg(ctx: Context, name: string, max: number): number {
  const text = arg(ctx, name)
  const value = /^\d+$/.test(text) ? Number(text) : 0
  if (value < 1 || value > max) throw new UsageError(`${name} must be a whole number from 1 to ${max}`)
  return value
}

function sayText(value: unknown): string {
  const item = field(value, 'item')
  const ask = field(field(item, 'pick'), 'ask')
  const open = field(item, 'state') === 'waiting-pick' && field(ask, 'ref') !== '' && field(ask, 'error') === undefined
  return open ? 'Said in the ClickUp thread.\n' : 'Said on the ClickUp card.\n'
}

const MAX_NONE_PHRASES = 30
const MAX_NONE_PHRASE_LENGTH = 60
const MIN_NONE_PHRASE_LENGTH = 3

const askToText = (value: unknown): string => {
  const id = field(value, 'pickAskTo')
  return typeof id === 'string' ? `Design picks are asked to ClickUp user ${id}.\n` : "Design picks are asked to the card's owner (default).\n"
}

const phrasesText = (key: string, meaning: string) => (value: unknown): string => {
  const phrases = field(value, key)
  return Array.isArray(phrases) && phrases.length > 0 ? `Extra "${meaning}" phrases: ${phrases.map(String).join(', ')}.\n` : `No extra "${meaning}" phrases.\n`
}

async function askTo(ctx: Context): Promise<void> {
  const id = ctx.args.userId
  const clear = flag(ctx, 'clear')
  if (id !== undefined && clear) throw new UsageError('give a user id or --clear, not both')
  if (id === undefined && !clear) return emit(ctx, await ctx.client.get('/api/queue'), askToText)
  if (id !== undefined && !/^\d{1,30}$/.test(id)) throw new UsageError('userId must be a ClickUp user id of 1 to 30 digits')
  await putSettings(ctx, { pickAskTo: id ?? null }, askToText)
}

const editPhrases = (key: string, meaning: string) => async (ctx: Context): Promise<void> => {
  const text = phrasesText(key, meaning)
  const clear = flag(ctx, 'clear')
  if (ctx.rest.length > 0 && clear) throw new UsageError('give phrases or --clear, not both')
  if (ctx.rest.length === 0 && !clear) return emit(ctx, await ctx.client.get('/api/queue'), text)
  const phrases = ctx.rest.map(phrase => phrase.trim())
  if (phrases.length > MAX_NONE_PHRASES || phrases.some(phrase => phrase.length < MIN_NONE_PHRASE_LENGTH || phrase.length > MAX_NONE_PHRASE_LENGTH)) throw new UsageError(`give at most ${MAX_NONE_PHRASES} phrases of ${MIN_NONE_PHRASE_LENGTH} to ${MAX_NONE_PHRASE_LENGTH} characters`)
  await putSettings(ctx, { [key]: phrases }, text)
}

const putSettings = async (ctx: Context, body: Json, text: (value: unknown) => string): Promise<void> => emit(ctx, await ctx.client.put('/api/queue/settings', body), text)

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

const TOOLBOX_OPTIONS: Record<string, OptionSpec> = {
  why: { type: 'string', description: 'why you are doing this, kept in the card\'s audit log (default: cli)', placeholder: 'TEXT' },
  as: { type: 'string', description: 'who is acting (default: $SKD_ACTOR, then human)', placeholder: 'NAME' },
  key: { type: 'string', description: 'idempotency key: repeating the same call with it returns the first result', placeholder: 'KEY' },
  expect: { type: 'string', description: 'refuse unless the card is in this state', placeholder: 'STATE' },
}
const LIMITED_ACTIONS = ['note', 'resume', 'repost', 'say', 'pick', 'requeue', 'reread', 'answer', 'stop']
const DURATION = /^(\d+)(s|m|h)$/
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 }

export const actorOf = (ctx: Context): string => stringOpt(ctx, 'as') ?? readEnv('ACTOR', ctx.env) ?? 'human'
export const whyOf = (ctx: Context): string => stringOpt(ctx, 'why') ?? 'cli'

function perform(ctx: Context, action: string, params: Json): Promise<unknown> {
  const key = stringOpt(ctx, 'key')
  const expect = stringOpt(ctx, 'expect')
  return ctx.client.post(itemPath(ctx, `/do/${action}`), { params, actor: actorOf(ctx), why: whyOf(ctx), ...(key === undefined ? {} : { key }), ...(expect === undefined ? {} : { expect }) })
}

function durationMs(ctx: Context): number {
  const text = stringOpt(ctx, 'for') ?? '30m'
  const match = DURATION.exec(text)
  if (match === null) throw new UsageError('--for is a duration such as 90s, 30m or 2h')
  return Number(match[1]) * UNIT_MS[match[2]!]!
}

async function noteText(ctx: Context): Promise<string> {
  const file = stringOpt(ctx, 'file')
  const given = ctx.args.text
  if ((file === undefined) === (given === undefined)) throw new UsageError('give the note as text or with --file, not both')
  if (given !== undefined) return given === '-' ? (await ctx.stdin()).trimEnd() : given
  return readFile(resolve(ctx.cwd, expandHome(file!)), 'utf8')
}

const when = (at: unknown): string => (typeof at === 'number' ? new Date(at).toISOString().replace(/\.\d+Z$/, 'Z') : '-')

function historyLine(line: Json): string {
  const tail = typeof line.error === 'string' ? `${cell(line.why)} (${line.error})` : cell(line.why)
  return `${when(line.at)}  ${cell(line.actor)} ${cell(line.action)} ${cell(line.result)}: ${tail}`
}

function historyText(value: unknown): string {
  const lines = records(value, 'history')
  return lines.length === 0 ? 'No actions logged for this card yet.\n' : `${lines.map(historyLine).join('\n')}\n`
}

function showText(value: unknown): string {
  const item = (field(value, 'item') ?? {}) as Json
  const run = field(value, 'run') as Json | null
  const lease = field(value, 'lease') as Json | null
  const lines = [
    `${cell(item.title)} (${cell(item.id)})`,
    `State: ${cell(item.state)}${run === null ? '' : `  Run: ${cell(run.id)} (${cell(run.status)}) at ${cell(run.currentNodeId)}`}`,
    `Lease: ${lease === null ? 'none' : `${cell(lease.holder)} until ${when(lease.until)}`}`,
    ...(typeof item.error === 'string' && item.error !== '' ? [`Error: ${item.error}`] : []),
    ...(Array.isArray(item.questions) && item.questions.length > 0 ? [`Questions: ${item.questions.map(String).join(' / ')}`] : []),
    ...(field(item, 'pick') === undefined ? [] : [`Pick: ${(field(field(item, 'pick'), 'options') as unknown[] | undefined ?? []).map(String).join(', ')}${field(field(field(item, 'pick'), 'ask'), 'ref') === undefined ? '' : ' (asked in ClickUp)'}`]),
    ...(run === null ? [] : ['Steps:', ...records(run, 'attempts').map(attempt => `  #${cell(attempt.number)} ${cell(attempt.nodeId)} ${cell(attempt.status)}${field(attempt.result, 'outcome') === undefined ? '' : ` ${cell(field(attempt.result, 'outcome'))}: ${cell(field(attempt.result, 'summary'))}`}`)]),
    'Recent actions:',
    ...records(value, 'history').map(line => `  ${historyLine(line)}`),
  ]
  return `${lines.join('\n')}\n`
}

function limitsText(value: unknown): string {
  const limits = field(value, 'limits')
  const rows = limits !== null && typeof limits === 'object' ? Object.entries(limits as Json) : []
  return `Most ok actions per card in 24 hours:\n${rows.map(([action, limit]) => `  ${action} ${cell(limit)}`).join('\n')}\n`
}

async function limits(ctx: Context): Promise<void> {
  const action = ctx.args.action
  const given = ctx.args.n
  if (action === undefined) return emit(ctx, await ctx.client.get('/api/queue/limits'), limitsText)
  if (!LIMITED_ACTIONS.includes(action)) throw new UsageError(`action must be one of ${LIMITED_ACTIONS.join(', ')}`)
  if (given === undefined || !/^\d+$/.test(given) || Number(given) > 100) throw new UsageError('n must be a whole number from 0 to 100')
  emit(ctx, await ctx.client.put('/api/queue/limits', { actor: actorOf(ctx), action, limit: Number(given) }), limitsText)
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
    path: ['queue', 'poll'],
    args: ['minutes'],
    summary: 'Set how often ClickUp replies (questions and design picks) are checked, 1 to 15 minutes (default 2)',
    run: async (ctx) => putSettings(ctx, { replyPollMinutes: wholeArg(ctx, 'minutes', 15) }, value => `ClickUp replies are checked every ${cell(field(value, 'replyPollMinutes'))} minutes.\n`),
  },
  {
    path: ['queue', 'publish-days'],
    args: ['days'],
    summary: 'Set how many days published mockups stay up, 1 to 90 (default 14)',
    run: async (ctx) => putSettings(ctx, { publishKeepDays: wholeArg(ctx, 'days', 90) }, value => `Published mockups come down after ${cell(field(value, 'publishKeepDays'))} days, or when the card lands or is removed.\n`),
  },
  {
    path: ['queue', 'ask-to'],
    args: ['userId?'],
    options: { clear: { type: 'boolean', description: 'ask the card\'s owner again (the default)' } },
    summary: 'Ask design picks to one ClickUp user instead of the card\'s owner; with no argument, show who',
    run: askTo,
  },
  {
    path: ['queue', 'none-phrases'],
    args: ['phrase...'],
    options: { clear: { type: 'boolean', description: 'remove all extra phrases' } },
    summary: 'Replace the extra phrases that mean "none of these" in a ClickUp reply; with no argument, show them',
    run: editPhrases('pickNonePhrases', 'none of these'),
  },
  {
    path: ['queue', 'keep-phrases'],
    args: ['phrase...'],
    options: { clear: { type: 'boolean', description: 'remove all extra phrases' } },
    summary: 'Replace the extra phrases that mean "keep the current design" in a ClickUp reply; with no argument, show them',
    run: editPhrases('pickKeepPhrases', 'keep the current design'),
  },
  {
    path: ['queue', 'unpublish'],
    args: ['id'],
    summary: 'Take down the published design-pick mockups of an item',
    run: async (ctx) => emit(ctx, await ctx.client.post(itemPath(ctx, '/unpublish'), {}), () => 'Unpublished.\n'),
  },
  {
    path: ['queue', 'requeue'],
    args: ['id'],
    options: { fresh: { type: 'boolean', description: 'start a new run instead of resuming the failed one' }, ...TOOLBOX_OPTIONS },
    summary: 'Put a failed, ready or waiting item back in line; a failed item resumes its last run',
    run: async (ctx) => emit(ctx, await perform(ctx, 'requeue', flag(ctx, 'fresh') ? { fresh: true } : {}), () => 'Back in the queue.\n'),
  },
  {
    path: ['queue', 'pick'],
    args: ['id', 'option'],
    options: {
      tester: { type: 'string', description: 'who to tag when the build is ready', placeholder: 'NAME' },
      note: { type: 'string', description: 'a note for the next run', placeholder: 'TEXT' },
      feedback: { type: 'string', description: 'what should change, only with none', placeholder: 'TEXT' },
      ...TOOLBOX_OPTIONS,
    },
    summary: 'Choose a design variant, none, or keep (also now, nochange: the current design stays) for an item waiting on a pick',
    run: async (ctx) => {
      const body = { option: arg(ctx, 'option'), ...optionalText(ctx, 'tester'), ...optionalText(ctx, 'note'), ...optionalText(ctx, 'feedback') }
      emit(ctx, await perform(ctx, 'pick', body), () => `Picked ${arg(ctx, 'option')}. Back in the queue.\n`)
    },
  },
  {
    path: ['queue', 'say'],
    args: ['id', 'text'],
    options: TOOLBOX_OPTIONS,
    summary: 'Write a message in the ClickUp pick thread, or on the card when no pick is open',
    run: async (ctx) => emit(ctx, await perform(ctx, 'say', { text: arg(ctx, 'text') }), sayText),
  },
  {
    path: ['queue', 'repost'],
    args: ['id'],
    options: TOOLBOX_OPTIONS,
    summary: 'Publish the mockups again and post a fresh ClickUp pick ask, closing the old one',
    run: async (ctx) => emit(ctx, await perform(ctx, 'repost', {}), () => 'Asked again in ClickUp.\n'),
  },
  {
    path: ['queue', 'reread'],
    args: ['id'],
    options: TOOLBOX_OPTIONS,
    summary: 'Read the ClickUp replies to the open pick again from the ask',
    run: async (ctx) => emit(ctx, await perform(ctx, 'reread', {}), (value) => `Re-read from the ask. It is ${cell(field(field(value, 'item'), 'state'))}.\n`),
  },
  {
    path: ['queue', 'answer'],
    args: ['id', 'text'],
    options: TOOLBOX_OPTIONS,
    summary: 'Answer the questions of an item waiting for your answer in Shikidan (text - reads stdin)',
    run: async (ctx) => emit(ctx, await perform(ctx, 'answer', { text: arg(ctx, 'text') === '-' ? (await ctx.stdin()).trimEnd() : arg(ctx, 'text') }), () => 'Answered. Back in the queue.\n'),
  },
  {
    path: ['queue', 'stop'],
    args: ['id'],
    options: TOOLBOX_OPTIONS,
    summary: 'Stop the run of a building or landing item',
    run: async (ctx) => emit(ctx, await perform(ctx, 'stop', {}), () => 'Stopped.\n'),
  },
  {
    path: ['queue', 'show'],
    args: ['id'],
    summary: 'Show everything about an item: state, run and its steps, lease and the last 10 logged actions',
    run: async (ctx) => emit(ctx, await ctx.client.get(itemPath(ctx, '/show')), showText),
  },
  {
    path: ['queue', 'history'],
    args: ['id'],
    options: { limit: { type: 'string', description: 'how many lines, newest last (default 50)', placeholder: 'N' } },
    summary: 'Show the audit log of an item: who did what, why and how it went',
    run: async (ctx) => emit(ctx, await ctx.client.get(itemPath(ctx, '/history'), { limit: String(countOpt(ctx, 'limit') ?? 50) }), historyText),
  },
  {
    path: ['queue', 'note'],
    args: ['id', 'text?'],
    options: { file: { type: 'string', description: 'read the note from this file', placeholder: 'FILE' }, ...TOOLBOX_OPTIONS },
    summary: 'Add an operator note to an item; the next fresh run reads it (text - reads stdin)',
    run: async (ctx) => emit(ctx, await perform(ctx, 'note', { text: await noteText(ctx) }), () => 'Note added.\n'),
  },
  {
    path: ['queue', 'resume'],
    args: ['id'],
    options: {
      at: { type: 'string', description: 'id of the step of its last run to continue from (see shiki queue show)', placeholder: 'STEP' },
      note: { type: 'string', description: 'a note for that step, also kept as an operator note file', placeholder: 'TEXT' },
      ...TOOLBOX_OPTIONS,
    },
    summary: 'Continue a failed, ready or waiting item\'s last run from a chosen step, keeping everything it already did',
    run: async (ctx) => {
      const at = stringOpt(ctx, 'at')
      if (at === undefined) throw new UsageError('give the step with --at STEP')
      emit(ctx, await perform(ctx, 'resume', { at, ...optionalText(ctx, 'note') }), () => `Resuming at ${at}.\n`)
    },
  },
  {
    path: ['queue', 'claim'],
    args: ['id'],
    options: { for: { type: 'string', description: 'how long, 1m to 4h (default 30m)', placeholder: 'DURATION' }, why: TOOLBOX_OPTIONS.why!, as: TOOLBOX_OPTIONS.as! },
    summary: 'Hold an item so only you can act on it until you release it or the time runs out',
    run: async (ctx) => {
      const ms = durationMs(ctx)
      emit(ctx, await ctx.client.post(itemPath(ctx, '/claim'), { actor: actorOf(ctx), ms, ...optionalText(ctx, 'why') }), (value) => `Claimed by ${cell(field(field(value, 'lease'), 'holder'))} until ${when(field(field(value, 'lease'), 'until'))}.\n`)
    },
  },
  {
    path: ['queue', 'release'],
    args: ['id'],
    options: { why: TOOLBOX_OPTIONS.why!, as: TOOLBOX_OPTIONS.as! },
    summary: 'Let go of an item you claimed',
    run: async (ctx) => emit(ctx, await ctx.client.post(itemPath(ctx, '/release'), { actor: actorOf(ctx), ...optionalText(ctx, 'why') }), () => 'Released.\n'),
  },
  {
    path: ['queue', 'limits'],
    args: ['action?', 'n?'],
    options: { as: TOOLBOX_OPTIONS.as! },
    summary: 'Show how many ok actions a card may take per action in 24 hours; with action and n, set one (human only)',
    run: limits,
  },
  {
    path: ['queue', 'limits', 'reset'],
    args: ['id'],
    options: { why: TOOLBOX_OPTIONS.why!, as: TOOLBOX_OPTIONS.as! },
    summary: 'Clear an item\'s used-up limits and its attention entry (human only)',
    run: async (ctx) => emit(ctx, await ctx.client.post(itemPath(ctx, '/limits/reset'), { actor: actorOf(ctx), why: whyOf(ctx) }), () => 'Limits reset.\n'),
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
