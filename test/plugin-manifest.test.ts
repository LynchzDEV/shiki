import { describe, expect, test } from 'bun:test'

import { contributionsAdded, parseManifest, permissionsAdded, type PluginManifest } from '../server/plugins/manifest'

const CLICKUP_MANIFEST: PluginManifest = {
  id: 'clickup-board',
  name: 'ClickUp board',
  version: '1.0.0',
  description: 'See a ClickUp board and start a chat or terminal on any task.',
  pluginApi: 1,
  runtime: 'isolated',
  icon: 'assets/icon.svg',
  server: 'src/server.ts',
  screen: 'src/screen.ts',
  permissions: {
    network: ['api.clickup.com'],
    sessions: ['chat', 'terminal'],
    settings: true,
  },
  settings: [
    { key: 'token', label: 'ClickUp token', type: 'secret', help: 'ClickUp, Settings, Apps, Generate.' },
  ],
}

describe('parseManifest', () => {
  test('accepts the ClickUp manifest from the spec', () => {
    expect(parseManifest(CLICKUP_MANIFEST)).toEqual({ ok: true, manifest: CLICKUP_MANIFEST })
  })

  test('queueSource is optional and must be a boolean', () => {
    expect(parseManifest({ ...CLICKUP_MANIFEST, queueSource: true })).toEqual({ ok: true, manifest: { ...CLICKUP_MANIFEST, queueSource: true } })
    expect(parseManifest({ ...CLICKUP_MANIFEST, queueSource: false })).toEqual({ ok: true, manifest: { ...CLICKUP_MANIFEST, queueSource: false } })
    const absent = parseManifest(CLICKUP_MANIFEST)
    expect(absent.ok && absent.manifest.queueSource).toBeUndefined()
    const wrong = parseManifest({ ...CLICKUP_MANIFEST, queueSource: 'yes' })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.errors.join('\n')).toContain('queueSource')
  })

  test('refuses a pluginApi the host does not speak', () => {
    const result = parseManifest({ ...CLICKUP_MANIFEST, pluginApi: 3 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toContain('This plugin needs a newer Shikidan')
  })

  test('refuses an invalid id', () => {
    const result = parseManifest({ ...CLICKUP_MANIFEST, id: 'Bad_ID' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0)
  })

  test('refuses paths outside the plugin folder', () => {
    for (const field of ['server', 'screen', 'icon']) {
      const result = parseManifest({ ...CLICKUP_MANIFEST, [field]: '../x.ts' })
      expect(result.ok, field).toBe(false)
      if (!result.ok) expect(result.errors.join('\n')).toContain(field)
    }
    expect(parseManifest({ ...CLICKUP_MANIFEST, screen: '/abs.ts' }).ok).toBe(false)
  })

  test('accepts a *. wildcard over a host of at least two labels', () => {
    const network = ['api.clickup.com', '*.clickup-attachments.com']
    expect(parseManifest({ ...CLICKUP_MANIFEST, permissions: { ...CLICKUP_MANIFEST.permissions, network } })).toEqual({
      ok: true,
      manifest: { ...CLICKUP_MANIFEST, permissions: { ...CLICKUP_MANIFEST.permissions, network } },
    })
  })

  test('refuses other wildcard shapes and non-plain network permissions', () => {
    for (const host of ['*.com', '*', 'a.*.b', '**.x', '*clickup.com', '*.', 'https://api.clickup.com', 'api.clickup.com/path', 'API.ClickUp.com', '*.API.clickup.com']) {
      const result = parseManifest({ ...CLICKUP_MANIFEST, permissions: { ...CLICKUP_MANIFEST.permissions, network: [host] } })
      expect(result.ok, host).toBe(false)
      if (!result.ok) expect(result.errors.join('\n')).toContain(host)
    }
  })

  test('the network format rule holds for trusted plugins too', () => {
    expect(parseManifest({ ...CLICKUP_MANIFEST, runtime: 'trusted', permissions: { network: ['*.com'] } }).ok).toBe(false)
  })

  test('accepts an on/off toggle setting and refuses an unknown setting type', () => {
    const settings = [...CLICKUP_MANIFEST.settings!, { key: 'autoPick', label: 'Auto-pick', type: 'toggle' as const }]
    expect(parseManifest({ ...CLICKUP_MANIFEST, settings })).toEqual({ ok: true, manifest: { ...CLICKUP_MANIFEST, settings } })
    expect(parseManifest({ ...CLICKUP_MANIFEST, settings: [{ key: 'x', label: 'X', type: 'switch' }] }).ok).toBe(false)
  })

  test('refuses a settings key declared twice', () => {
    const result = parseManifest({ ...CLICKUP_MANIFEST, settings: [
      { key: 'token', label: 'ClickUp token', type: 'secret' },
      { key: 'token', label: 'Token again', type: 'text' },
    ] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('\n')).toContain('declared more than once')
  })

  test('accepts requires with and without a minimum version', () => {
    const requires = [{ id: 'queue-board', version: '1.7.0' }, { id: 'hello-board' }]
    expect(parseManifest({ ...CLICKUP_MANIFEST, requires })).toEqual({ ok: true, manifest: { ...CLICKUP_MANIFEST, requires } })
  })

  test('requires needs pluginApi 1 or 2 only, so it works on both', () => {
    expect(parseManifest({ ...CLICKUP_MANIFEST, pluginApi: 2, requires: [{ id: 'hello-board' }] }).ok).toBe(true)
  })

  test.each([
    ['a bad id', [{ id: 'Bad_ID' }], 'Bad_ID'],
    ['a bad version', [{ id: 'hello-board', version: '1.x' }], '1.x'],
    ['a version with four parts', [{ id: 'hello-board', version: '1.2.3.4' }], '1.2.3.4'],
    ['the plugin itself', [{ id: 'clickup-board' }], 'cannot require itself'],
    ['the same id twice', [{ id: 'hello-board' }, { id: 'hello-board', version: '1.0' }], 'listed more than once'],
    ['more than 10 entries', Array.from({ length: 11 }, (_, index) => ({ id: `plugin-${index}a` })), 'at most 10'],
  ])('refuses requires with %s, with one error', (_label, requires, fragment) => {
    const result = parseManifest({ ...CLICKUP_MANIFEST, requires })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain(fragment)
    }
  })

  test('collects several errors at once', () => {
    const result = parseManifest({ ...CLICKUP_MANIFEST, id: 'x', pluginApi: 3, screen: '../x.ts' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBe(3)
  })
})

describe('permissionsAdded', () => {
  test('lists new hosts, new session kinds and new settings in order', () => {
    expect(permissionsAdded(
      { network: ['a.com'] },
      { network: ['a.com', 'b.com'], sessions: ['chat'] },
    )).toEqual(['Reach b.com', 'Start chats'])
  })

  test('words a wildcard host as any address ending in that domain', () => {
    expect(permissionsAdded(
      { network: ['api.clickup.com'] },
      { network: ['api.clickup.com', '*.clickup-attachments.com'] },
    )).toEqual(['Reach any address ending in .clickup-attachments.com'])
  })

  test('reports nothing when permissions only shrink', () => {
    expect(permissionsAdded(
      { network: ['a.com', 'b.com'], sessions: ['chat', 'terminal'], settings: true },
      { network: ['a.com'] },
    )).toEqual([])
  })

  test('reports settings false to true and terminal growth separately', () => {
    expect(permissionsAdded({ sessions: ['chat'] }, { sessions: ['chat', 'terminal'], settings: true })).toEqual(['Start terminals', 'Keep its own settings'])
  })
})

const CONTRIBUTING: PluginManifest = {
  id: 'card-pipeline',
  name: 'Card pipeline',
  version: '0.1.0',
  description: 'Refine ClickUp cards.',
  pluginApi: 2,
  runtime: 'isolated',
  permissions: { settings: true },
  settings: [{ key: 'reposRoot', label: 'Repos folder', type: 'text' }],
  contributes: { agents: ['agents/biz-gate.md'], skills: ['skills/card-refine'], flows: ['flows/card-pipeline.json'] },
}

function errorsOf(raw: unknown): string[] {
  const result = parseManifest(raw)
  return result.ok ? [] : result.errors
}

describe('contributes', () => {
  test('pluginApi 2 accepts agents, skills and flows', () => {
    expect(parseManifest(CONTRIBUTING)).toEqual({ ok: true, manifest: CONTRIBUTING })
  })

  test('pluginApi 2 is accepted without contributes', () => {
    const { contributes: _contributes, ...plain } = CONTRIBUTING
    expect(parseManifest(plain).ok).toBe(true)
  })

  test('contributes needs pluginApi 2', () => {
    expect(errorsOf({ ...CONTRIBUTING, pluginApi: 1 })).toContain('contributes needs pluginApi 2')
  })

  test('contributes lists at least one item and never repeats a path', () => {
    expect(errorsOf({ ...CONTRIBUTING, contributes: {} })).toContain('contributes must list at least one agent, skill or flow')
    expect(errorsOf({ ...CONTRIBUTING, contributes: { agents: ['agents/a.md', 'agents/a.md'] } })).toContain('contributes must not repeat a path')
  })

  test('agents are .md, skills are folders, flows are .json, all inside the repo', () => {
    expect(errorsOf({ ...CONTRIBUTING, contributes: { agents: ['agents/a.txt'] } })).toContain('contributes.agents: agents/a.txt must be a .md file inside the plugin folder')
    expect(errorsOf({ ...CONTRIBUTING, contributes: { agents: ['../a.md'] } })).toContain('contributes.agents: ../a.md must be a .md file inside the plugin folder')
    expect(errorsOf({ ...CONTRIBUTING, contributes: { skills: ['skills/x/SKILL.md'] } })).toContain('contributes.skills: skills/x/SKILL.md must be a folder inside the plugin folder')
    expect(errorsOf({ ...CONTRIBUTING, contributes: { flows: ['flows/x.yaml'] } })).toContain('contributes.flows: flows/x.yaml must be a .json file inside the plugin folder')
  })
})

describe('contributionsAdded', () => {
  test('lists every new agent, skill and flow', () => {
    expect(contributionsAdded(undefined, CONTRIBUTING.contributes)).toEqual([
      'Add the agent agents/biz-gate.md to your engines',
      'Add the skill skills/card-refine to your engines',
      'Add the Studio flow flows/card-pipeline.json',
    ])
  })

  test('lists only what the update adds', () => {
    expect(contributionsAdded({ agents: ['agents/biz-gate.md'] }, { agents: ['agents/biz-gate.md', 'agents/other.md'] })).toEqual(['Add the agent agents/other.md to your engines'])
    expect(contributionsAdded(CONTRIBUTING.contributes, CONTRIBUTING.contributes)).toEqual([])
  })
})
