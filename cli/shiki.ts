#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { readEnv } from '../server/env'
import { BANNER } from './banner'
import { ApiError, createClient, UnreachableError, type FetchLike } from './client'
import { UsageError, type Command, type Context, type OptionSpec, type OptionValues } from './command'
import { badAppleCommands } from './commands/badapple'
import { clickupCommands } from './commands/clickup'
import { jobCommands } from './commands/jobs'
import { pluginCommands } from './commands/plugins'
import { queueCommands } from './commands/queue'
import { studioCommands } from './commands/studio'
import { notifyCommands } from './commands/notify'
import { systemCommands } from './commands/system'

export const VERSION = '0.1.0'
export const DEFAULT_URL = 'http://127.0.0.1:7777'
const DEFAULT_POLL_MS = 1000

export type MainDeps = {
  fetch: FetchLike
  stdout(text: string): void
  stderr(text: string): void
  env: Record<string, string | undefined>
  stdin?: () => Promise<string>
  cwd?: string
  pollMs?: number
}

export const COMMANDS: Command[] = [...systemCommands, ...jobCommands, ...studioCommands, ...pluginCommands, ...clickupCommands, ...queueCommands, ...notifyCommands, ...badAppleCommands]

const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  url: { type: 'string', description: `Shikidan URL (default: $SKD_URL, then ${DEFAULT_URL})`, placeholder: 'URL' },
  json: { type: 'boolean', description: 'print the server JSON as one document (NDJSON for follow)' },
  help: { type: 'boolean', short: 'h', description: 'show help' },
  version: { type: 'boolean', short: 'v', description: 'print the shiki version' },
}

const OUT_OF_SCOPE = 'Not covered here (use the browser): secrets reveal/rotate/write, connection create/delete, drafts, preview, studio default, workflow and policy editing, chat home and file pickers, job images, terminal drops, live event streams, attaching to a terminal.'

const EXIT_CODES = 'Exit codes: 0 ok, 1 API error, 2 usage error, 3 Shikidan unreachable.'

const ENVIRONMENT = 'Environment: SKD_URL (server URL), SKD_TOKEN (API token; default: apiToken in secrets.json, needed only for non-local URLs).'

type ParseConfig = Parameters<typeof parseArgs>[0] & {}
type ParseOptions = NonNullable<ParseConfig['options']>

function toParseOptions(specs: Record<string, OptionSpec>): ParseOptions {
  return Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, { type: spec.type, ...(spec.multiple ? { multiple: true } : {}), ...(spec.short ? { short: spec.short } : {}) }]))
}

const ALL_OPTIONS: Record<string, OptionSpec> = Object.assign({}, GLOBAL_OPTIONS, ...COMMANDS.map((command) => command.options ?? {}))

function usageLine(command: Command): string {
  const args = (command.args ?? []).map((name) => (name.endsWith('...') ? `[${name}]` : name.endsWith('?') ? `[${name.slice(0, -1)}]` : `<${name}>`))
  const options = Object.keys(command.options ?? {}).length > 0 ? ['[options]'] : []
  return ['shiki', ...command.path, ...args, ...options].join(' ')
}

function optionLines(specs: Record<string, OptionSpec>): string[] {
  return Object.entries(specs).map(([name, spec]) => {
    const flagText = `${spec.short ? `-${spec.short}, ` : ''}--${name}${spec.type === 'string' ? ` <${spec.placeholder ?? 'value'}>` : ''}`
    return `    ${flagText.padEnd(28)} ${spec.description}${spec.multiple ? ' (repeatable)' : ''}`
  })
}

function globalLines(): string[] {
  return ['Global options:', ...optionLines(GLOBAL_OPTIONS)]
}

export function rootHelp(): string {
  const width = Math.max(...COMMANDS.map((command) => usageLine(command).length))
  return [
    'Usage: shiki <command> [options]',
    '',
    'Shikidan from the command line.',
    '',
    'Commands:',
    ...COMMANDS.map((command) => `  ${usageLine(command).padEnd(width)}  ${command.summary}`),
    '',
    ...globalLines(),
    '',
    ENVIRONMENT,
    EXIT_CODES,
    '',
    OUT_OF_SCOPE,
    '',
  ].join('\n')
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((word, index) => path[index] === word)
}

export function prefixHelp(prefix: readonly string[]): string {
  const commands = COMMANDS.filter((command) => startsWith(command.path, prefix))
  const blocks = commands.map((command) => [`  ${usageLine(command)}`, `      ${command.summary}`, ...optionLines(command.options ?? {})].join('\n'))
  return ['Usage:', blocks.join('\n\n'), '', ...globalLines(), '', EXIT_CODES, ''].join('\n')
}

function findCommand(positionals: readonly string[]): Command | undefined {
  return COMMANDS.filter((command) => startsWith(positionals, command.path)).sort((a, b) => b.path.length - a.path.length)[0]
}

function isGroup(word: string | undefined): boolean {
  return word !== undefined && COMMANDS.some((command) => command.path[0] === word)
}

function configDirsFor(env: Record<string, string | undefined>): string[] {
  const override = readEnv('CONFIG_DIR', env)
  if (override !== undefined) return [override]
  const config = join(env.HOME ?? homedir(), '.config')
  // ponytail: legacy ~/.config/mission-control read before the server has moved it, drop with migrateConfigDir
  return [join(config, 'shikidan'), join(config, 'mission-control')]
}

async function readTokenFile(dir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8')) as { apiToken?: unknown }
    return typeof parsed.apiToken === 'string' && parsed.apiToken !== '' ? parsed.apiToken : null
  } catch {
    return null
  }
}

export async function resolveToken(env: Record<string, string | undefined>): Promise<string | null> {
  const token = readEnv('TOKEN', env)
  if (token !== undefined) return token
  for (const dir of configDirsFor(env)) {
    const found = await readTokenFile(dir)
    if (found !== null) return found
  }
  return null
}

function preParse(argv: string[]): { positionals: string[]; values: OptionValues } {
  const { positionals, values } = parseArgs({ args: argv, options: toParseOptions(ALL_OPTIONS), strict: false, allowPositionals: true })
  return { positionals, values: values as OptionValues }
}

const argName = (name: string): string => name.replace(/(\?|\.\.\.)$/, '')

function bindArgs(command: Command, rest: readonly string[]): Record<string, string | undefined> {
  const names = command.args ?? []
  const variadic = names.at(-1)?.endsWith('...') === true
  const required = names.filter((name) => !name.endsWith('?') && !name.endsWith('...'))
  if (!variadic && rest.length > names.length) throw new UsageError(`unexpected argument: ${rest[names.length]}`, command.path[0])
  if (rest.length < required.length) throw new UsageError(`missing <${required[rest.length]}>`, command.path[0])
  return Object.fromEntries(names.map((name, index) => [argName(name), rest[index]]))
}

function showHelp(deps: MainDeps, text: string, requested: boolean): number {
  if (!requested) {
    deps.stderr(text)
    return 2
  }
  deps.stdout(text)
  return 0
}

async function dispatch(argv: string[], deps: MainDeps): Promise<number> {
  const pre = preParse(argv)
  const wantsHelp = pre.values.help === true
  if (pre.values.version === true) {
    deps.stdout(`shiki ${VERSION}\n`)
    return 0
  }
  const command = findCommand(pre.positionals)

  if (command === undefined) {
    if (pre.positionals.length === 0 && !wantsHelp) {
      deps.stdout(`${BANNER}  shiki v${VERSION}\n\n${rootHelp()}`)
      return 0
    }
    if (pre.positionals.length === 0) return showHelp(deps, rootHelp(), true)
    const group = pre.positionals[0]
    if (isGroup(group) && pre.positionals.length === 1) return showHelp(deps, prefixHelp([group!]), wantsHelp)
    throw new UsageError(`unknown command: ${pre.positionals.join(' ')}`, isGroup(group) ? group : undefined)
  }
  if (wantsHelp) return showHelp(deps, prefixHelp(command.path), true)

  let parsed: { positionals: string[]; values: OptionValues }
  try {
    const result = parseArgs({ args: argv, options: toParseOptions({ ...GLOBAL_OPTIONS, ...command.options }), strict: true, allowPositionals: true })
    parsed = { positionals: result.positionals, values: result.values as OptionValues }
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error), command.path[0])
  }

  const args = bindArgs(command, parsed.positionals.slice(command.path.length))
  const url = typeof parsed.values.url === 'string' ? parsed.values.url : readEnv('URL', deps.env) ?? DEFAULT_URL
  const client = createClient({ url, token: await resolveToken(deps.env), fetch: deps.fetch })
  const ctx: Context = {
    client,
    args,
    rest: parsed.positionals.slice(command.path.length),
    values: parsed.values,
    json: parsed.values.json === true,
    cwd: deps.cwd ?? process.cwd(),
    pollMs: deps.pollMs ?? DEFAULT_POLL_MS,
    out: deps.stdout,
    err: deps.stderr,
    stdin: deps.stdin ?? (() => Bun.stdin.text()),
  }
  try {
    return (await command.run(ctx)) ?? 0
  } catch (error) {
    if (error instanceof UsageError && error.group === undefined) throw new UsageError(error.message, command.path[0])
    throw error
  }
}

export async function main(argv: string[], deps: MainDeps): Promise<number> {
  try {
    return await dispatch(argv, deps)
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`shiki: ${error.message}\nRun 'shiki ${error.group === undefined ? '' : `${error.group} `}--help' for usage.\n`)
      return 2
    }
    if (error instanceof UnreachableError) {
      deps.stderr(`${error.message}\n`)
      return 3
    }
    if (error instanceof ApiError) {
      deps.stderr(`Error: ${error.message}\n`)
      return 1
    }
    deps.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    fetch: (request) => fetch(request),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
  })
  process.exitCode = code
}
