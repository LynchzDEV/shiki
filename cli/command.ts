import { homedir } from 'node:os'

import type { Client } from './client'

export type OptionSpec = {
  type: 'string' | 'boolean'
  description: string
  multiple?: boolean
  short?: string
  placeholder?: string
}

export type OptionValues = Record<string, string | boolean | string[] | undefined>

export type Context = {
  client: Client
  args: Record<string, string | undefined>
  rest: string[]
  values: OptionValues
  json: boolean
  cwd: string
  env: Record<string, string | undefined>
  pollMs: number
  out(text: string): void
  err(text: string): void
  stdin(): Promise<string>
}

export type Command = {
  path: string[]
  args?: string[]
  options?: Record<string, OptionSpec>
  summary: string
  run(ctx: Context): Promise<number | void>
}

export class UsageError extends Error {
  constructor(message: string, readonly group?: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export function emit(ctx: Context, data: unknown, human: (data: unknown) => string): void {
  ctx.out(ctx.json ? `${JSON.stringify(data)}\n` : human(data))
}

export function stringOpt(ctx: Context, name: string): string | undefined {
  const value = ctx.values[name]
  return typeof value === 'string' ? value : undefined
}

export function flag(ctx: Context, name: string): boolean {
  return ctx.values[name] === true
}

export function listOpt(ctx: Context, name: string): string[] {
  const value = ctx.values[name]
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
}

export function countOpt(ctx: Context, name: string): number | undefined {
  const value = stringOpt(ctx, name)
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be a whole number`)
  return Number(value)
}

export function arg(ctx: Context, name: string): string {
  const value = ctx.args[name]
  if (value === undefined) throw new UsageError(`missing <${name}>`)
  return value
}

export function oneOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`${what} must be one of ${allowed.join(', ')}`)
  return value as T
}

export async function textArg(ctx: Context, name: string): Promise<string> {
  const value = arg(ctx, name)
  return value === '-' ? (await ctx.stdin()).trimEnd() : value
}

export function records(value: unknown, key: string): Array<Record<string, unknown>> {
  const list = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  return Array.isArray(list) ? list.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object') : []
}

export const SESSION_OPTIONS: Record<string, OptionSpec> = {
  chat: { type: 'string', description: 'chat id that owns the run', placeholder: 'ID' },
  terminal: { type: 'string', description: 'terminal id that owns the run', placeholder: 'ID' },
  'flow-version': { type: 'string', description: 'flow version number being answered', placeholder: 'N' },
}

export function sessionBody(ctx: Context): Record<string, unknown> {
  const chat = stringOpt(ctx, 'chat')
  const terminal = stringOpt(ctx, 'terminal')
  const version = countOpt(ctx, 'flow-version')
  return {
    ...(chat === undefined ? {} : { chat }),
    ...(terminal === undefined ? {} : { terminalId: terminal }),
    ...(version === undefined ? {} : { version }),
  }
}

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path
}
