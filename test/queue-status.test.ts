import { expect, spyOn, test } from 'bun:test'

import { automateOn, desiredStatus, statusMaps, type SourceStatusMap, type StatusFlow, type StatusRun } from '../server/queue-status'
import type { QueueItem, QueueState } from '../server/queue-store'

const map: SourceStatusMap = {
  states: { queued: 'Open', 'waiting-pick': 'hold', 'waiting-info': 'hold', failed: 'hold', ready: 'in progress', landing: 'in progress', 'awaiting-stage': 'review', landed: 'Closed' },
  nodes: { route: 'pipeline', implement: 'in progress' },
}
const item = (state: QueueState, currentRunId: string | null = null): QueueItem => ({ id: 'q1', source: 'clickup-board', externalId: '1', title: 'T', url: 'u', repo: '/r', flowId: 'fixstack--fixstack', state, worktree: null, contextPath: null, answerPaths: [], runIds: [], currentRunId, questions: [], lastSeenId: null, error: null, createdAt: 1, updatedAt: 1 })
const run = (over: Partial<StatusRun> = {}): StatusRun => ({ id: 'r1', status: 'running', currentNodeId: 'implement', workflow: { id: 'fixstack--fixstack', plugin: 'fixstack' }, ...over })

test.each([
  ['queued', 'Open'], ['waiting-pick', 'hold'], ['waiting-info', 'hold'], ['failed', 'hold'], ['ready', 'in progress'],
  ['landing', 'in progress'], ['awaiting-stage', 'review'], ['landed', 'Closed'],
] as const)('an item in %s wants %s', (state, status) => {
  expect(desiredStatus(item(state), undefined, map)).toBe(status)
})

test.each([
  ['the node the run is heading to', item('building', 'r1'), run(), 'in progress'],
  ['another mapped node', item('building', 'r1'), run({ currentNodeId: 'route' }), 'pipeline'],
  ['an unmapped node', item('building', 'r1'), run({ currentNodeId: 'dod' }), null],
  ['a missing run', item('building', 'r1'), undefined, null],
  ['a run that is not the current one', item('building', 'r1'), run({ id: 'r0' }), null],
  ['a recovery run, which has no plugin', item('building', 'r1'), run({ workflow: { id: 'recover' } }), null],
  ['a blocked run', item('building', 'r1'), run({ status: 'blocked' }), null],
] as const)('a building item with %s', (_name, building, current, status) => {
  expect(desiredStatus(building, current, map)).toBe(status)
})

test('an unmapped state, an empty map, or a missing part of the map leaves the card alone', () => {
  expect(desiredStatus(item('queued'), undefined, { states: { landed: 'Closed' } })).toBeNull()
  expect(desiredStatus(item('queued'), undefined, {})).toBeNull()
  expect(desiredStatus(item('building', 'r1'), run(), { states: map.states })).toBeNull()
})

function maps(flows: Record<string, StatusFlow>, settings: Record<string, string> = {}) {
  const read: string[] = []
  const lookup = statusMaps({
    flow: async id => { read.push(id); const flow = flows[id]; if (flow === undefined) throw new Error('Workflow not found'); return flow },
    setting: async (plugin, key) => settings[`${plugin}:${key}`] ?? null,
  })
  return { lookup, read }
}

const flowMap: SourceStatusMap = { states: { queued: 'Open' }, nodes: { implement: 'in progress' } }

const automate = { 'fixstack:automate': 'true' }

test('a plugin flow has no status map unless its plugin turns full automate on', async () => {
  for (const value of [undefined, 'false', '', 'yes']) {
    const { lookup } = maps({ 'fixstack--fixstack': { plugin: 'fixstack', sourceStatus: flowMap } }, value === undefined ? {} : { 'fixstack:automate': value })
    expect(await lookup('fixstack--fixstack')).toEqual({})
  }
})

test('automateOn is true only for a plugin whose automate setting is true', async () => {
  const setting = async (plugin: string, key: string) => (plugin === 'fixstack' && key === 'automate' ? 'true' : null)
  expect(await automateOn(setting, 'fixstack')).toBe(true)
  expect(await automateOn(setting, 'other')).toBe(false)
  expect(await automateOn(setting, undefined)).toBe(false)
})

test('the flow map is used when its plugin sets no statusMap, and a flow outside a plugin uses its own map', async () => {
  const { lookup } = maps({ 'fixstack--fixstack': { plugin: 'fixstack', sourceStatus: flowMap }, mine: { sourceStatus: flowMap } }, automate)
  expect(await lookup('fixstack--fixstack')).toEqual(flowMap)
  expect(await lookup('mine')).toEqual(flowMap)
})

test('a statusMap setting replaces the flow map wholesale', async () => {
  const { lookup } = maps({ 'fixstack--fixstack': { plugin: 'fixstack', sourceStatus: flowMap } }, { ...automate, 'fixstack:statusMap': JSON.stringify({ states: { landed: 'done' } }) })
  expect(await lookup('fixstack--fixstack')).toEqual({ states: { landed: 'done' } })
})

test('a statusMap that does not parse falls back to the flow map and logs once', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (const bad of ['{not json', JSON.stringify({ states: { flying: 'x' } })]) {
      const { lookup } = maps({ 'fixstack--fixstack': { plugin: 'fixstack', sourceStatus: flowMap } }, { ...automate, 'fixstack:statusMap': bad })
      expect(await lookup('fixstack--fixstack')).toEqual(flowMap)
      expect(await lookup('fixstack--fixstack')).toEqual(flowMap)
    }
    expect(errors).toHaveBeenCalledTimes(2)
  } finally {
    errors.mockRestore()
  }
})

test('no flow, a missing flow, or a flow without a map gives an empty map', async () => {
  const { lookup, read } = maps({ plain: {} })
  expect(await lookup(null)).toEqual({})
  expect(await lookup('plain')).toEqual({})
  expect(await lookup('gone')).toEqual({})
  expect(read).toEqual(['plain', 'gone'])
})
