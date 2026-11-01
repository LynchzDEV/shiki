import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAT_RULES, chatEnv, chatRules, ensureChatProfile } from '../server/chat-profile'
import { PSTACK_FLOW_IDS } from '../server/pstack-flows'
import { flowDesignRules } from '../server/flow-design'
import { engineArgs, realEngineResolver } from '../server/jobs-engine-iface'
import { writeSecrets } from '../server/secrets'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-chat-profile-')); process.env.SKD_CONFIG_DIR = dir; process.env.SKD_FAKE_ENGINES = '1'; process.env.SKD_FAKE_CHAT_BRIDGE = '1' })
afterEach(async () => { delete process.env.SKD_CONFIG_DIR; delete process.env.SKD_FAKE_ENGINES; delete process.env.SKD_FAKE_CHAT_BRIDGE; await rm(dir, { recursive: true, force: true }) })

describe('chat rules', () => {
  test('name the API, the retry cap, the review rule and the landing call', () => {
    for (const phrase of ['POST $SKD_URL/api/jobs', 'SKD_CHAT_ID', 'different AI family', '/land', 'Never push', '/api/quota', 'copy them exactly, never invent them']) expect(CHAT_RULES).toContain(phrase)
    expect(CHAT_RULES.split('3 attempts per step in total (the server refuses a 4th)')).toHaveLength(3)
  })
  test('carry the chat context', () => {
    const text = chatRules({ chatId: 'root-1', home: '/Users/me/work', project: '/Users/me/work/app', edit: false, memory: 'Recent: fixed login' })
    expect(text).toContain('root-1')
    expect(text).toContain('/Users/me/work/app')
    expect(text).toContain('read-only')
    expect(text).toContain('do not write files through Bash either')
    expect(text).toContain('Recent: fixed login')
    expect(chatRules({ chatId: 'r', home: '/h', project: null, edit: true, memory: '' })).toContain('may edit files directly')
  })
  test('chat rules explain when to use a flow and how to relay approval', () => {
    for (const phrase of ['more than one step that changes code', 'GET $SKD_URL/api/studio/workflows', '"status":"awaiting-approval"', '/approve {"chat":"$SKD_CHAT_ID"}', 'Never approve without the owner saying so']) expect(CHAT_RULES).toContain(phrase)
    expect(CHAT_RULES).not.toContain('Naming a Studio workflow is optional')
  })
  test('chat rules prefer a built-in pstack flow over in-chat subagent fan-out', () => {
    expect(CHAT_RULES).toContain('pstack-arena')
    expect(CHAT_RULES).toContain('/api/studio/runs instead of spawning the subagents yourself')
    const named = CHAT_RULES.match(/pstack-[a-z]+/g) ?? []
    expect(named.length).toBeGreaterThan(0)
    for (const id of named) expect(PSTACK_FLOW_IDS as readonly string[]).toContain(id)
    const skills = /for example pstack's ([^)]*)\)/.exec(CHAT_RULES)![1].split(/, | or /)
    for (const skill of skills) expect(PSTACK_FLOW_IDS as readonly string[]).toContain(`pstack-${skill}`)
  })
  test('chat rules say to design the flow when Studio reports design mode', () => {
    expect(CHAT_RULES).toContain(`When GET $SKD_URL/api/studio/workflows returns "design": true, ${flowDesignRules('$SKD_URL')}`)
  })
  test('chat rules explain how to draft a flow and change a running one', () => {
    for (const phrase of ['"graph" instead of "workflowId"', '/changes', 'Never mark scopeGrew false to avoid approval']) expect(CHAT_RULES).toContain(phrase)
  })
  test('chat rules explain how to split a flow into parallel paths', () => {
    for (const phrase of ['kind "join"', 'its own git worktree', '"setup" commands', 'Keep fail edges inside their own path']) expect(CHAT_RULES).toContain(phrase)
  })
  test('chat rules explain In Session steps and how to report them, without a background watcher', () => {
    for (const phrase of ['"In Session"', 'POST $SKD_URL/api/studio/runs/<id>/steps/<nodeId>', 'GET $SKD_URL/api/studio/runs/<id>/steps/<nodeId> returns its assignment', 'A failed plan check sends the plan back to you']) expect(CHAT_RULES).toContain(phrase)
    expect(CHAT_RULES).not.toContain('background watcher')
  })
  test('state the chat\'s own engine and model', () => {
    expect(chatRules({ chatId: 'r', home: '/h', project: null, edit: false, memory: '', engine: 'claude', model: 'claude-opus-4' })).toContain('Your AI: engine claude, model claude-opus-4.')
    expect(chatRules({ chatId: 'r', home: '/h', project: null, edit: false, memory: '', engine: 'glm', model: null })).toContain('Your AI: engine glm, default model.')
    expect(chatRules({ chatId: 'r', home: '/h', project: null, edit: false, memory: '' })).not.toContain('Your AI:')
  })
  test('tell a Codex chat that direct edits are unavailable', () => {
    for (const edit of [true, false]) {
      const text = chatRules({ chatId: 'r', home: '/h', project: null, edit, memory: '', engine: 'codex' })
      expect(text).toContain('Direct edits are unavailable on Codex; every code change goes through an agent.')
      expect(text).not.toContain('may edit files directly')
      expect(text).not.toContain('read-only for direct edits')
    }
  })
})

describe('chat profile', () => {
  test('writes a slim Claude profile and maps engines to it', async () => {
    const dirs = await ensureChatProfile({ configDir: dir })
    expect(await readFile(join(dirs.claude, 'CLAUDE.md'), 'utf8')).toBe('Rules arrive as the appended system prompt.\n')
    expect(JSON.parse(await readFile(join(dirs.claude, 'settings.json'), 'utf8')).permissions.defaultMode).toBe('bypassPermissions')
    expect(chatEnv('glm', { claude: dirs.claude, codex: '/codex' })).toEqual({ CLAUDE_CONFIG_DIR: dirs.claude })
    expect(chatEnv('codex', { claude: dirs.claude, codex: '/codex' })).toEqual({ CODEX_HOME: '/codex' })
    expect(chatEnv('claude', { claude: dirs.claude, codex: '/codex' })).toEqual({})
  })
})

describe('resolver for a chat', () => {
  const launchOf = async (params: Parameters<typeof realEngineResolver>[0]): Promise<Record<string, unknown>> =>
    JSON.parse((await realEngineResolver(params)).stdin ?? '{}') as Record<string, unknown>

  test('claude and glm chats run through the bridge with the rules and tool gates', async () => {
    const spawn = await realEngineResolver({ engine: 'claude', prompt: 'hi', purpose: 'chat', edit: false, coreRules: 'RULES' })
    expect(spawn.control).toBe(true)
    expect(spawn.args[0]).toContain('chat-bridge.ts')
    expect(spawn.env.SKD_BRIDGE_FAKE).toContain('test/fixtures/chat-bridge')
    const launch = await launchOf({ engine: 'claude', prompt: 'hi', purpose: 'chat', edit: false, coreRules: 'RULES' })
    expect(launch.appendSystemPrompt).toBe('RULES')
    expect(launch.disallowedTools).toEqual(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
    expect(launch.permissionMode).toBe('settings')
    expect(launch.images).toEqual([])
    expect(launch.allowedTools).toEqual([])
    expect(typeof launch.claudePath).toBe('string')
    expect(spawn.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    await writeSecrets({ zaiAuthToken: 'zai-test-token' })
    const editing = await realEngineResolver({ engine: 'glm', prompt: 'hi', purpose: 'chat', edit: true, coreRules: 'RULES', resumeSessionId: 'sess-1', model: 'glm-5.3[1m]', permissionMode: 'bypass', allowedTools: ['Bash(x)'] })
    const editingLaunch = await launchOf({ engine: 'glm', prompt: 'hi', purpose: 'chat', edit: true, coreRules: 'RULES', resumeSessionId: 'sess-1', model: 'glm-5.3[1m]', permissionMode: 'bypass', allowedTools: ['Bash(x)'] })
    expect(editingLaunch.disallowedTools).toEqual([])
    expect(editingLaunch.resumeSessionId).toBe('sess-1')
    expect(editingLaunch.model).toBe('glm-5.3[1m]')
    expect(editingLaunch.permissionMode).toBe('bypass')
    expect(editingLaunch.allowedTools).toEqual(['Bash(x)'])
    expect(editing.env.CLAUDE_CONFIG_DIR).toContain('chat-claude')
  })
  test('without the bridge flag a fake-engine chat keeps the CLI stub path', async () => {
    delete process.env.SKD_FAKE_CHAT_BRIDGE
    const spawn = await realEngineResolver({ engine: 'claude', prompt: 'hi', purpose: 'chat', edit: false, coreRules: 'RULES' })
    expect(spawn.control).toBeUndefined()
    expect(spawn.args).toContain('--append-system-prompt')
    process.env.SKD_FAKE_CHAT_BRIDGE = '1'
  })
  test('a codex chat takes the worker Codex profile and no Claude tool flags', async () => {
    const spawn = await realEngineResolver({ engine: 'codex', prompt: 'hi', purpose: 'chat', edit: false, coreRules: 'RULES' })
    expect(spawn.control).toBeUndefined()
    expect(spawn.args).not.toContain('--disallowedTools')
    expect(spawn.env.CODEX_HOME?.endsWith('worker-codex')).toBe(true)
    expect(existsSync(join(dir, 'chat-claude'))).toBe(false)
  })
  test('a claude chat builds no profile at all', async () => {
    await realEngineResolver({ engine: 'claude', prompt: 'hi', purpose: 'chat', edit: true, coreRules: 'RULES' })
    expect(existsSync(join(dir, 'chat-claude'))).toBe(false)
    expect(existsSync(join(dir, 'worker-codex'))).toBe(false)
  })
  test('a worker job is unchanged', async () => {
    expect(engineArgs('claude', 'p')).toEqual(['-p', 'p', '--output-format', 'stream-json', '--verbose'])
    const worker = await realEngineResolver({ engine: 'claude', prompt: 'hi' })
    expect(worker.args).toContain('-p')
    expect(worker.control).toBeUndefined()
    await writeSecrets({ zaiAuthToken: 'zai-test-token' })
    const glmWorker = await realEngineResolver({ engine: 'glm', prompt: 'hi' })
    expect(glmWorker.env.CLAUDE_CONFIG_DIR?.endsWith('worker-claude')).toBe(true)
  })
})
