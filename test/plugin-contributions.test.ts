import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyContributions, checkFlows, fillTemplate, pluginFlows, removeContributions, type ContributionSource } from '../server/plugins/contributions'
import type { InstalledPlugin } from '../server/plugins/store'

let root: string
let pluginDir: string
let targets: string[]

const AGENT = `---
name: biz-gate
description: Gate one card.
---

Repos live in {{setting:reposRoot}}. Run {{mc:mctl}} plugin call x.
`

const SKILL = `---
name: card-refine
description: Refine cards.
---

Footer: {{setting:commentFooter}}
`

const FLOW = {
  id: 'card-pipeline',
  name: 'Card pipeline',
  entry: 'gate',
  nodes: [{ id: 'gate', title: 'Gate', instructions: 'Run the gate.', kind: 'task' }],
  edges: [],
}

function source(overrides: Partial<ContributionSource> = {}): ContributionSource {
  return {
    pluginId: 'card-pipeline',
    folder: pluginDir,
    contributes: { agents: ['agents/biz-gate.md'], skills: ['skills/card-refine'] },
    settingsFields: [
      { key: 'reposRoot', label: 'Repos', type: 'text' },
      { key: 'commentFooter', label: 'Footer', type: 'text' },
      { key: 'token', label: 'Token', type: 'secret' },
    ],
    settings: { reposRoot: '/work/repos', commentFooter: '[bot]' },
    shiki: 'bun /mc/cli/shiki.ts',
    ...overrides,
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mc-contrib-'))
  pluginDir = join(root, 'plugin')
  await mkdir(join(pluginDir, 'agents'), { recursive: true })
  await mkdir(join(pluginDir, 'skills', 'card-refine', 'docs'), { recursive: true })
  await mkdir(join(pluginDir, 'flows'), { recursive: true })
  await writeFile(join(pluginDir, 'agents', 'biz-gate.md'), AGENT)
  await writeFile(join(pluginDir, 'skills', 'card-refine', 'SKILL.md'), SKILL)
  await writeFile(join(pluginDir, 'skills', 'card-refine', 'docs', 'notes.md'), 'Folder {{setting:reposRoot}}\n')
  await writeFile(join(pluginDir, 'flows', 'card-pipeline.json'), JSON.stringify(FLOW))
  targets = [join(root, 'home', '.claude'), join(root, 'worker-claude'), join(root, 'chat-claude')]
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('fillTemplate', () => {
  const context = { settingsFields: source().settingsFields, settings: source().settings, shiki: 'bun /mc/cli/shiki.ts' }

  test('fills text settings and the shiki command', () => {
    expect(fillTemplate('a {{setting:reposRoot}} b {{mc:mctl}}', 'x.md', context)).toEqual({ ok: true, text: 'a /work/repos b bun /mc/cli/shiki.ts' })
  })

  test('leaves an empty setting as written', () => {
    expect(fillTemplate('{{setting:reposRoot}}', 'x.md', { ...context, settings: {} })).toEqual({ ok: true, text: '{{setting:reposRoot}}' })
  })

  test('refuses a secret setting with the file and line', () => {
    expect(fillTemplate('ok\nkey {{setting:token}}', 'agents/a.md', context)).toEqual({ ok: false, error: 'agents/a.md:2: {{setting:token}} is a secret setting and is never written into a file' })
  })

  test('refuses an undeclared setting and an unknown mc value', () => {
    expect(fillTemplate('{{setting:nope}}', 'a.md', context)).toEqual({ ok: false, error: 'a.md:1: {{setting:nope}} is not a declared setting' })
    expect(fillTemplate('{{mc:home}}', 'a.md', context)).toEqual({ ok: false, error: 'a.md:1: {{mc:home}} is not a value Shikidan fills' })
  })
})

describe('applyContributions', () => {
  test('writes the agent and skill into every profile with settings filled and a marker', async () => {
    const result = await applyContributions(source(), targets, [])
    expect(result.ok).toBe(true)
    for (const target of targets) {
      const agent = await readFile(join(target, 'agents', 'biz-gate.md'), 'utf8')
      expect(agent).toContain('Repos live in /work/repos. Run bun /mc/cli/shiki.ts plugin call x.')
      expect(agent).toContain('<!-- installed by shikidan plugin card-pipeline -->')
      expect(agent.startsWith('---\nname: biz-gate\n')).toBe(true)
      expect(await readFile(join(target, 'skills', 'card-refine', 'SKILL.md'), 'utf8')).toContain('Footer: [bot]')
      expect(await readFile(join(target, 'skills', 'card-refine', 'docs', 'notes.md'), 'utf8')).toBe('Folder /work/repos\n')
      expect(await readFile(join(target, 'skills', 'card-refine', '.mc-plugin'), 'utf8')).toBe('card-pipeline\n')
    }
    if (result.ok) expect(result.written.sort()).toEqual(targets.flatMap(target => [join(target, 'agents', 'biz-gate.md'), join(target, 'skills', 'card-refine')]).sort())
  })

  test('stops on a file it did not write and writes nothing', async () => {
    await mkdir(join(targets[1]!, 'agents'), { recursive: true })
    await writeFile(join(targets[1]!, 'agents', 'biz-gate.md'), 'my own agent\n')
    const result = await applyContributions(source(), targets, [])
    expect(result).toEqual({ ok: false, error: `${join(targets[1]!, 'agents', 'biz-gate.md')} already exists and was not installed by this plugin` })
    expect(await readFile(join(targets[1]!, 'agents', 'biz-gate.md'), 'utf8')).toBe('my own agent\n')
    expect(await exists(join(targets[0]!, 'agents', 'biz-gate.md'))).toBe(false)
  })

  test('an agent installed before Shikidan still counts as its own', async () => {
    await mkdir(join(targets[1]!, 'agents'), { recursive: true })
    await writeFile(join(targets[1]!, 'agents', 'biz-gate.md'), '---\nname: biz-gate\n---\n<!-- installed by mission-control plugin card-pipeline -->\nold\n')
    const result = await applyContributions(source(), targets, [])
    expect(result.ok).toBe(true)
    expect(await readFile(join(targets[1]!, 'agents', 'biz-gate.md'), 'utf8')).toContain('<!-- installed by shikidan plugin card-pipeline -->')
  })

  test('re-applying replaces its own files and removes ones no longer contributed', async () => {
    const first = await applyContributions(source(), targets, [])
    if (!first.ok) throw new Error(first.error)
    const second = await applyContributions(source({ contributes: { agents: ['agents/biz-gate.md'] }, settings: { reposRoot: '/new' } }), targets, first.written)
    expect(second.ok).toBe(true)
    expect(await readFile(join(targets[0]!, 'agents', 'biz-gate.md'), 'utf8')).toContain('Repos live in /new.')
    expect(await exists(join(targets[0]!, 'skills', 'card-refine'))).toBe(false)
  })

  test('a template error writes nothing', async () => {
    await writeFile(join(pluginDir, 'agents', 'biz-gate.md'), '---\nname: biz-gate\n---\n{{setting:token}}\n')
    const result = await applyContributions(source(), targets, [])
    expect(result.ok).toBe(false)
    expect(await exists(join(targets[0]!, 'skills', 'card-refine'))).toBe(false)
  })

  test('an agent or skill without a name is refused', async () => {
    await writeFile(join(pluginDir, 'agents', 'biz-gate.md'), 'no frontmatter\n')
    expect(await applyContributions(source(), targets, [])).toEqual({ ok: false, error: 'agents/biz-gate.md has no name: in its frontmatter' })
  })
})

describe('removeContributions', () => {
  test('removes only paths this plugin wrote', async () => {
    const applied = await applyContributions(source(), targets, [])
    if (!applied.ok) throw new Error(applied.error)
    const foreign = join(targets[0]!, 'agents', 'mine.md')
    await writeFile(foreign, 'mine\n')
    await removeContributions('card-pipeline', [...applied.written, foreign])
    for (const path of applied.written) expect(await exists(path), path).toBe(false)
    expect(await readFile(foreign, 'utf8')).toBe('mine\n')
  })
})

describe('flows', () => {
  test('checkFlows accepts a valid flow and names a broken one', async () => {
    expect(await checkFlows(pluginDir, ['flows/card-pipeline.json'])).toEqual([])
    await writeFile(join(pluginDir, 'flows', 'card-pipeline.json'), JSON.stringify({ ...FLOW, entry: 'missing' }))
    const errors = await checkFlows(pluginDir, ['flows/card-pipeline.json'])
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toStartWith('flows/card-pipeline.json: ')
  })

  test('pluginFlows lists enabled plugins flows as read-only entries', async () => {
    const plugin = { id: 'card-pipeline', name: 'Card pipeline', enabled: true, contributes: { flows: ['flows/card-pipeline.json'] } } as unknown as InstalledPlugin
    const flows = await pluginFlows([plugin, { ...plugin, id: 'off', enabled: false } as InstalledPlugin], () => pluginDir)
    expect(flows.map(flow => [flow.id, flow.name, flow.plugin])).toEqual([['card-pipeline--card-pipeline', 'Card pipeline: Card pipeline', 'card-pipeline']])
    expect(flows[0]!.revision).toMatch(/^[a-f0-9]{24}$/)
  })

  test('a maxAttempts setting from 1 to 10 sets every step of the plugin flow, anything else keeps the flow numbers', async () => {
    const plugin = { id: 'card-pipeline', name: 'Card pipeline', enabled: true, contributes: { flows: ['flows/card-pipeline.json'] } } as unknown as InstalledPlugin
    const visits = async (value: string | null) => (await pluginFlows([plugin], () => pluginDir, async () => value))[0]!.nodes.map(node => node.maxVisits)
    const own = await visits(null)
    expect((await visits('5')).every(count => count === 5)).toBe(true)
    expect(await visits('0')).toEqual(own)
    expect(await visits('11')).toEqual(own)
    expect(await visits('two')).toEqual(own)
  })
})
