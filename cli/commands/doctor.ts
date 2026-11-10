import { segment } from '../client'
import { arg, emit, type Command, type Context, type OptionSpec } from '../command'
import { actorOf, whyOf } from './queue'

type Json = Record<string, unknown>

const OPTIONS: Record<string, OptionSpec> = {
  as: { type: 'string', description: 'who is acting (default: $SKD_ACTOR, then human); doctor may not apply or dismiss', placeholder: 'NAME' },
  why: { type: 'string', description: 'why, kept in the card\'s audit log (default: cli)', placeholder: 'TEXT' },
}

const doctorPath = (ctx: Context, suffix = ''): string => `/api/queue/${segment(arg(ctx, 'id'))}/doctor${suffix}`
const when = (at: unknown): string => (typeof at === 'number' ? new Date(at).toISOString().replace(/\.\d+Z$/, 'Z') : '-')
const quoted = (text: unknown): string => JSON.stringify(String(text))

function actionLine(id: string, step: Json): string {
  const params = (step.params ?? {}) as Json
  if (step.action === 'resume') return `shiki queue resume ${id} --at ${String(params.at)} --note ${quoted(params.note)}`
  return `shiki queue pick ${id} ${String(params.option)}${params.feedback === undefined ? '' : ` --feedback ${quoted(params.feedback)}`}`
}

function suggestionText(id: string, value: unknown): string {
  const suggestion = ((value ?? {}) as Json).suggestion as Json | null | undefined
  if (suggestion === null || suggestion === undefined) return `The doctor is looking at ${id}${typeof (value as Json).runId === 'string' ? ` (run ${String((value as Json).runId)})` : ''}. Read its suggestion with: shiki doctor show ${id}\n`
  const actions = Array.isArray(suggestion.actions) ? suggestion.actions as Json[] : []
  const intent = `${String(suggestion.intent)}${suggestion.option === undefined ? '' : ` ${String(suggestion.option)}`}`
  return [
    `Suggestion ${String(suggestion.id)} (${String(suggestion.status)}), made ${when(suggestion.at)} while the card was ${String(suggestion.state)}`,
    `Intent: ${intent} (confidence ${Number(suggestion.confidence).toFixed(2)})${suggestion.replyId === '' ? '' : `, from reply ${String(suggestion.replyId)}`}`,
    `Reason: ${String(suggestion.reason)}`,
    ...(actions.length === 0 ? ['Actions: none. The reply needs a human.'] : ['Actions (what apply runs):', ...actions.map(step => `  ${actionLine(id, step)}`)]),
    ...(suggestion.status === 'proposed' && actions.length > 0 ? [`Apply: shiki doctor apply ${id} --as <you>    Dismiss: shiki doctor dismiss ${id} --as <you>`] : []),
  ].join('\n') + '\n'
}

const body = (ctx: Context): Json => ({ actor: actorOf(ctx), why: whyOf(ctx) })

export const doctorCommands: Command[] = [
  {
    path: ['doctor'],
    args: ['id'],
    options: OPTIONS,
    summary: 'Ask the card doctor to read the owner\'s replies to an open ClickUp pick and suggest a fix (nothing is applied)',
    run: async (ctx) => emit(ctx, await ctx.client.post(doctorPath(ctx), body(ctx)), value => suggestionText(arg(ctx, 'id'), value)),
  },
  {
    path: ['doctor', 'show'],
    args: ['id'],
    summary: 'Show the doctor\'s suggestion for a card: intent, reason and the exact commands apply would run',
    run: async (ctx) => emit(ctx, await ctx.client.get(doctorPath(ctx)), value => suggestionText(arg(ctx, 'id'), value)),
  },
  {
    path: ['doctor', 'apply'],
    args: ['id'],
    options: OPTIONS,
    summary: 'Run the doctor\'s proposed actions through the card toolbox as you; refused if the card changed since',
    run: async (ctx) => emit(ctx, await ctx.client.post(doctorPath(ctx, '/apply'), body(ctx)), value => suggestionText(arg(ctx, 'id'), value)),
  },
  {
    path: ['doctor', 'dismiss'],
    args: ['id'],
    options: OPTIONS,
    summary: 'Mark the doctor\'s suggestion as wrong; nothing is run',
    run: async (ctx) => emit(ctx, await ctx.client.post(doctorPath(ctx, '/dismiss'), body(ctx)), value => suggestionText(arg(ctx, 'id'), value)),
  },
]
