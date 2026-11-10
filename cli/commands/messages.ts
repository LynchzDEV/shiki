import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { segment } from '../client'
import { arg, emit, expandHome, records, stringOpt, UsageError, type Command, type Context, type OptionSpec } from '../command'
import { cell, table } from '../format'
import { actorOf, whyOf } from './queue'

const CHANGE_OPTIONS: Record<string, OptionSpec> = {
  as: { type: 'string', description: 'who is changing it; only human may (default: $SKD_ACTOR, then human)', placeholder: 'NAME' },
  why: { type: 'string', description: 'why, kept in the settings audit log (default: cli)', placeholder: 'TEXT' },
}

export async function fileOption(ctx: Context): Promise<string> {
  const file = stringOpt(ctx, 'file')
  if (file === undefined) throw new UsageError('--file is required')
  return readFile(resolve(ctx.cwd, expandHome(file)), 'utf8')
}

function listText(value: unknown): string {
  return table(records(value, 'messages'), [
    { header: 'NAME', value: entry => cell(entry.name) },
    { header: 'EDITED', value: entry => (entry.override === null ? 'no' : 'yes') },
    { header: 'SLOTS', value: entry => (Array.isArray(entry.slots) && entry.slots.length > 0 ? entry.slots.map(slot => `{${String(slot)}}`).join(' ') : '-') },
    { header: 'TEXT', value: entry => cell(entry.override ?? entry.default) },
  ])
}

async function shown(ctx: Context): Promise<Record<string, unknown>> {
  const name = arg(ctx, 'name')
  const found = records(await ctx.client.get('/api/messages'), 'messages').find(entry => entry.name === name)
  if (found === undefined) throw new UsageError(`no message ${name}; see: shiki messages list`)
  return found
}

function showText(value: unknown): string {
  const entry = value as Record<string, unknown>
  const slots = Array.isArray(entry.slots) && entry.slots.length > 0 ? entry.slots.map(slot => `{${String(slot)}}`).join(' ') : 'none'
  const edited = entry.override === null ? 'no (built-in default)' : 'yes'
  return `${String(entry.name)}\nEdited: ${edited}\nSlots: ${slots}\n\n${String(entry.override ?? entry.default)}\n${entry.override === null ? '' : `\nDefault:\n${String(entry.default)}\n`}`
}

const messagePath = (ctx: Context): string => `/api/messages/${segment(arg(ctx, 'name'))}`

export const messageCommands: Command[] = [
  {
    path: ['messages', 'list'],
    summary: 'List the messages Shikidan posts in ClickUp, and which ones you edited',
    run: async (ctx) => emit(ctx, await ctx.client.get('/api/messages'), listText),
  },
  {
    path: ['messages', 'show'],
    args: ['name'],
    summary: 'Show a message text, its slots and its default',
    run: async (ctx) => emit(ctx, await shown(ctx), showText),
  },
  {
    path: ['messages', 'set'],
    args: ['name'],
    options: { file: { type: 'string', description: 'file holding the new text', placeholder: 'FILE' }, ...CHANGE_OPTIONS },
    summary: 'Replace a message with the text of a file (human only)',
    run: async (ctx) => emit(ctx, await ctx.client.put(messagePath(ctx), { actor: actorOf(ctx), why: whyOf(ctx), text: await fileOption(ctx) }), () => `Saved ${arg(ctx, 'name')}.\n`),
  },
  {
    path: ['messages', 'reset'],
    args: ['name'],
    options: CHANGE_OPTIONS,
    summary: 'Go back to the built-in default for a message (human only)',
    run: async (ctx) => emit(ctx, await ctx.client.del(messagePath(ctx), { actor: actorOf(ctx), why: whyOf(ctx) }), () => `Reset ${arg(ctx, 'name')} to the default.\n`),
  },
]
