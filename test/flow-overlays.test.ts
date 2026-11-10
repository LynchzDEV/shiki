import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import { pluginFlows } from '../server/plugins/contributions'
import type { InstalledPlugin } from '../server/plugins/store'
import { humanSettingsRoutes } from '../server/routes/human-settings'

let dir: string
let pluginDir: string
const priorConfigDir = process.env.SKD_CONFIG_DIR
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skd-flow-overlays-'))
  pluginDir = join(dir, 'plugin')
  process.env.SKD_CONFIG_DIR = join(dir, 'config')
  await mkdir(join(pluginDir, 'flows'), { recursive: true })
  await writeFile(join(pluginDir, 'flows', 'fixstack.json'), JSON.stringify(FIXSTACK))
})
afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.SKD_CONFIG_DIR
  else process.env.SKD_CONFIG_DIR = priorConfigDir
  await rm(dir, { recursive: true, force: true })
})

const FIXSTACK = {
  id: 'fixstack',
  name: 'Fixstack',
  entry: 'design',
  nodes: [
    { id: 'design', title: 'Design', kind: 'task', instructions: 'Build three mockups.' },
    { id: 'how', title: 'How', kind: 'task', instructions: 'Plan the fix.', checks: [{ command: 'bun', args: ['test'] }] },
  ],
  edges: [{ source: 'design', target: 'how', outcome: 'pass' }],
  land: [{ id: 'uat', run: 'button', label: 'Ship UAT', command: { command: 'ship-uat', args: [] }, env: { APP: 'setting:app' } }],
  sourceStatus: { states: { ready: 'review' }, nodes: { how: 'in progress' } },
}
const PLUGIN = { id: 'fixstack', name: 'Fixstack', enabled: true, contributes: { flows: ['flows/fixstack.json'] } } as unknown as InstalledPlugin
const FLOW_ID = 'fixstack--fixstack'
const listed = async () => (await pluginFlows([PLUGIN], () => pluginDir, async () => null))[0]!
const overlayPath = () => join(dir, 'config', 'flow-overlays', `${FLOW_ID}.json`)
const writeOverlay = async (overlay: unknown) => {
  await mkdir(join(dir, 'config', 'flow-overlays'), { recursive: true })
  await writeFile(overlayPath(), JSON.stringify(overlay))
}
const quiet = () => spyOn(console, 'error').mockImplementation(() => {})
const call = (method: string, body?: unknown, flowId = FLOW_ID) => new Elysia().use(humanSettingsRoutes()).handle(new Request(`http://127.0.0.1:7777/api/studio/flow-overlays/${flowId}`, {
  method, headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}))

test('an overlaid fixstack flow changes only the step text and keeps its plugin id, land stages, status map and checks', async () => {
  const plain = await listed()
  await writeOverlay({ nodes: { how: { instructions: 'Plan the fix. Keep the current design.', title: 'How (local)' } } })
  const flow = await listed()
  expect([flow.id, flow.plugin, flow.name]).toEqual([FLOW_ID, 'fixstack', 'Fixstack: Fixstack'])
  expect(flow.land).toEqual(plain.land)
  expect(flow.sourceStatus).toEqual(plain.sourceStatus)
  expect(flow.edges).toEqual(plain.edges)
  const how = flow.nodes.find(node => node.id === 'how')!
  expect([how.instructions, how.title]).toEqual(['Plan the fix. Keep the current design.', 'How (local)'])
  expect(how.checks).toEqual(plain.nodes.find(node => node.id === 'how')!.checks)
  expect(flow.nodes.find(node => node.id === 'design')).toEqual(plain.nodes.find(node => node.id === 'design'))
  expect(flow.revision).not.toBe(plain.revision)
})

test('a hand-edited overlay with checks or setup is not used at all, and says why', async () => {
  const errors = quiet()
  try {
    const plain = await listed()
    for (const bad of [{ nodes: { how: { instructions: 'x', checks: [{ command: 'rm', args: ['-rf', '/'] }] } } }, { nodes: { design: { setup: [{ command: 'curl' }] } } }, { nodes: {}, edges: [] }]) {
      await writeOverlay(bad)
      expect((await listed()).nodes).toEqual(plain.nodes)
    }
    expect(errors.mock.calls.length).toBe(3)
    expect(String(errors.mock.calls[0]![0])).toContain('Only instructions and title can be overridden')
  } finally { errors.mockRestore() }
})

test('an unknown step id in an overlay is reported and skipped; the known ones still apply', async () => {
  const errors = quiet()
  try {
    await writeOverlay({ nodes: { ghost: { instructions: 'boo' }, design: { instructions: 'Two mockups.' } } })
    const flow = await listed()
    expect(flow.nodes.map(node => node.instructions)).toEqual(['Two mockups.', 'Plan the fix.'])
    expect(String(errors.mock.calls[0]![0])).toContain('no step ghost')
  } finally { errors.mockRestore() }
})

test('a broken overlay file is logged and the plugin flow is still listed', async () => {
  const errors = quiet()
  try {
    await mkdir(join(dir, 'config', 'flow-overlays'), { recursive: true })
    await writeFile(overlayPath(), '{not json')
    expect((await listed()).id).toBe(FLOW_ID)
    expect(errors).toHaveBeenCalled()
  } finally { errors.mockRestore() }
})

test('PUT sets one step for a human only, refuses checks and setup, and DELETE clears a step or the whole overlay', async () => {
  expect((await call('PUT', { actor: 'grok', nodeId: 'how', instructions: 'x' })).status).toBe(403)
  const checks = await call('PUT', { actor: 'human', nodeId: 'how', instructions: 'x', checks: [{ command: 'rm' }] })
  expect(checks.status).toBe(400)
  expect((await checks.json()).error).toContain('Only instructions and title can be overridden')
  expect((await call('PUT', { actor: 'human', nodeId: 'how', setup: [] })).status).toBe(400)
  expect((await call('PUT', { actor: 'human', nodeId: 'how' })).status).toBe(400)
  expect((await call('PUT', { actor: 'human', nodeId: '../x', instructions: 'x' })).status).toBe(400)
  expect((await call('GET', undefined, '..%2Fsecrets')).status).toBe(400)
  expect((await call('PUT', { actor: 'human', nodeId: 'how', instructions: 'Keep NOW.' })).status).toBe(200)
  expect((await call('PUT', { actor: 'human', nodeId: 'design', title: 'Mockups' })).status).toBe(200)
  expect((await (await call('GET')).json()).overlay).toEqual({ nodes: { how: { instructions: 'Keep NOW.' }, design: { title: 'Mockups' } } })
  expect((await listed()).nodes.find(node => node.id === 'how')!.instructions).toBe('Keep NOW.')
  expect((await call('DELETE', { actor: 'human', nodeId: 'how' })).status).toBe(200)
  expect(JSON.parse(await readFile(overlayPath(), 'utf8'))).toEqual({ nodes: { design: { title: 'Mockups' } } })
  expect((await call('DELETE', { actor: 'doctor' })).status).toBe(403)
  expect((await call('DELETE', { actor: 'human' })).status).toBe(200)
  expect(await readFile(overlayPath(), 'utf8').catch(() => null)).toBeNull()
  const audit = (await readFile(join(dir, 'config', 'queue-audit', '_settings.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  expect(audit.map(line => [line.actor, line.action, line.result])).toEqual([
    ['grok', 'overlay-set', 'refused'], ['human', 'overlay-set', 'refused'], ['human', 'overlay-set', 'refused'], ['human', 'overlay-set', 'refused'], ['human', 'overlay-set', 'refused'],
    ['human', 'overlay-set', 'ok'], ['human', 'overlay-set', 'ok'], ['human', 'overlay-clear', 'ok'], ['doctor', 'overlay-clear', 'refused'], ['human', 'overlay-clear', 'ok'],
  ])
})
