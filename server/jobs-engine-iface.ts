export type EngineSpawn = {
  cmd: string
  args: string[]
  env: Record<string, string>
  stdin?: string
  control?: boolean
}

export type EngineResolverParams = {
  engine: string
  prompt: string
  resumeSessionId?: string
  model?: string
  connection?: import('./agent-connections').AgentConnection
  coreRules?: string
  readOnly?: boolean
  mcpServers?: import('./workflows').WorkflowNode['mcpServers']
  purpose?: 'workflow-design' | 'chat'
  edit?: boolean
  images?: import('./chat-bridge-core').BridgeImage[]
  permissionMode?: import('./chat-bridge-core').ChatPermissionMode
  forkSession?: boolean
  resumeSessionAt?: string
  allowedTools?: string[]
  step?: boolean
}

export type EngineResolver = (params: EngineResolverParams) => EngineSpawn | Promise<EngineSpawn>


export const fakeEchoResolver: EngineResolver = ({ engine, prompt }) => ({
  cmd: 'echo',
  args: [`[fake:${engine}] ${prompt}`],
  env: {},
})

import { buildEnv, fakeEnginesEnabled, modelArgs, resolveBinary, resolveEngine, stepEnv, type EngineName, ENGINE_NAMES } from './engines'
import { createConnectionStore } from './agent-connections'
import { modelDiscovery } from './model-discovery'
import { chatEnv, ensureChatProfile } from './chat-profile'
import { ensureWorkerProfiles } from './worker-profile'
import type { BridgeLaunch } from './chat-bridge-core'
import { join } from 'node:path'
import { readEnv } from './env'
import { workerPluginSettings } from './worker-plugin-guard'

export function engineArgs(engine: EngineName, prompt: string, resumeSessionId?: string, model?: string): string[] {
  if (engine === 'codex') {
    return resumeSessionId === undefined
      ? ['exec', '--dangerously-bypass-approvals-and-sandbox', '--json', ...modelArgs('codex', model), prompt]
      : ['exec', '--dangerously-bypass-approvals-and-sandbox', 'resume', '--json', ...modelArgs('codex', model), resumeSessionId, prompt]
  }
  const resume = resumeSessionId === undefined ? [] : ['--resume', resumeSessionId]
  return [...resume, '-p', prompt, '--output-format', 'stream-json', '--verbose', ...modelArgs(engine, model)]
}

export function engineSupportsResume(engine: string): boolean {
  return ENGINE_NAMES.includes(engine as EngineName)
}

async function chatProfileEnv(engine: EngineName): Promise<Record<string, string>> {
  if (engine === 'glm') return chatEnv(engine, { claude: (await ensureChatProfile()).claude, codex: '' })
  if (engine === 'codex') return chatEnv(engine, { claude: '', codex: (await ensureWorkerProfiles()).codex })
  return {}
}

export const BRIDGE_ENGINES: readonly EngineName[] = ['claude', 'glm']

export function chatUsesBridge(engine: string, purpose?: string): boolean {
  return purpose === 'chat' && BRIDGE_ENGINES.includes(engine as EngineName) && (!fakeEnginesEnabled() || readEnv('FAKE_CHAT_BRIDGE') === '1')
}

const BRIDGE_FIXTURES_DIR = join(import.meta.dir, '..', 'test', 'fixtures', 'chat-bridge')

async function chatBridgeSpawn(
  name: EngineName,
  params: Pick<EngineResolverParams, 'prompt' | 'resumeSessionId' | 'model' | 'coreRules' | 'edit' | 'images' | 'permissionMode' | 'forkSession' | 'resumeSessionAt' | 'allowedTools'>,
): Promise<EngineSpawn> {
  const launch: BridgeLaunch = {
    prompt: params.prompt ?? '',
    images: params.images ?? [],
    resumeSessionId: params.resumeSessionId ?? null,
    forkSession: params.forkSession === true,
    resumeSessionAt: params.resumeSessionAt ?? null,
    model: typeof params.model === 'string' && params.model !== '' ? params.model : null,
    permissionMode: params.permissionMode ?? 'settings',
    appendSystemPrompt: params.coreRules ?? '',
    disallowedTools: params.edit === false ? ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] : [],
    allowedTools: params.allowedTools ?? [],
    claudePath: resolveBinary(resolveEngine(name).cmd),
  }
  const env = { ...(await buildEnv(name, { worker: false })), ...(await chatProfileEnv(name)) }
  return {
    cmd: process.execPath,
    args: [join(import.meta.dir, 'chat-bridge.ts')],
    env: fakeEnginesEnabled() ? { ...env, SKD_BRIDGE_FAKE: BRIDGE_FIXTURES_DIR } : env,
    stdin: JSON.stringify(launch),
    control: true,
  }
}

export const realEngineResolver: EngineResolver = async ({ engine, prompt, resumeSessionId, model, connection, coreRules, mcpServers, readOnly, purpose, edit, images, permissionMode, forkSession, resumeSessionAt, allowedTools, step }) => {
  if (!ENGINE_NAMES.includes(engine as EngineName)) {
    const selected = await modelDiscovery().effective(connection ?? await createConnectionStore().get(engine))
    if (selected.id !== engine) throw new Error('Connection does not match the selected engine')
    return { cmd: process.execPath, args: [join(import.meta.dir, 'agent-bridge.ts')], env: {}, stdin: JSON.stringify({ connection: selected, prompt, resumeSessionId, model, mcpServers, readOnly, purpose, edit }) }
  }
  if (mcpServers?.length) throw new Error('Attached MCP tools require an ACP connection; configure a native ACP adapter for this agent')
  const name = engine as EngineName
  if (chatUsesBridge(engine, purpose)) {
    return await chatBridgeSpawn(name, { prompt, resumeSessionId, model, coreRules, edit, images, permissionMode, forkSession, resumeSessionAt, allowedTools })
  }
  const args = readOnly ? name === 'codex'
    ? ['exec', '--sandbox', 'read-only', '--ignore-user-config', '-c', 'approval_policy="never"', '--json', ...modelArgs(name, model), prompt]
    : ['-p', prompt, '--tools', '', '--strict-mcp-config', '--output-format', 'stream-json', '--verbose', ...modelArgs(name, model)]
    : engineArgs(name, prompt, resumeSessionId, model)
  if (coreRules) args.unshift(...(name === 'codex' ? ['-c', `developer_instructions=${JSON.stringify(coreRules)}`] : ['--append-system-prompt', coreRules]))
  if (purpose === 'chat' && edit === false && name !== 'codex') args.push('--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit')
  if (purpose === 'chat' && name !== 'codex') args.push('--include-partial-messages')
  const pluginSettings = purpose !== 'chat' && name !== 'codex' ? workerPluginSettings() : null
  if (pluginSettings) args.push('--settings', pluginSettings)
  const env = purpose === 'chat'
    ? { ...(await buildEnv(name, { worker: false })), ...(await chatProfileEnv(name)) }
    : await buildEnv(name, { worker: !readOnly })
  return { cmd: resolveBinary(resolveEngine(name).cmd), args, env: step === true && purpose !== 'chat' ? { ...env, ...stepEnv(name) } : env }
}
