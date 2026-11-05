import { afterAll, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

import type { QueueItem } from '../server/queue-store'
import type { QueueTree, TreeRepo } from '../server/queue-tree'

const { window } = new JSDOM('<body></body>')
let layout: typeof import('../client/queue-tree')

const item = (patch: Partial<QueueItem>): QueueItem => ({
  id: 'i0', source: 'clickup-board', externalId: 'x', title: 'Task', url: 'https://example.com/t/x', repo: '/Users/me/api', flowId: null,
  state: 'queued', worktree: null, contextPath: null, answerPaths: [], runIds: [], currentRunId: null, questions: [], lastSeenId: null, error: null,
  createdAt: 0, updatedAt: 0, ...patch,
})
const building = item({ id: 'b1', state: 'building', title: 'Moni export', worktree: '/Users/me/api/.worktree/queue-moni-export' })
const queued = item({ id: 'q1', title: 'Army settings: show export columns' })
const queuedLater = item({ id: 'q2', title: 'Backoffice: add tax ID', flowId: 'plan-only' })
const waiting = item({ id: 'w1', state: 'waiting-info', title: 'Bulk import', worktree: '/Users/me/api/.worktree/queue-bulk-import' })
const ready = item({ id: 'r1', state: 'ready', title: 'Invoice footer', runIds: ['r-1'], worktree: '/Users/me/api/.worktree/queue-invoice-footer' })
const failed = item({ id: 'f1', state: 'failed', title: 'Kood retry', worktree: '/Users/me/gone' })
const items = [building, queued, waiting, ready, failed, queuedLater]

const lane = (itemId: string, branch: string, forkSha: string | null, commits: Array<[string, string]>) => ({
  itemId, branch, worktree: `/Users/me/api/.worktree/${branch.replace('/', '-')}`, forkSha, commits: commits.map(([sha, subject]) => ({ sha, subject })),
})
const repo: TreeRepo = {
  repo: '/Users/me/api',
  base: { branch: 'main', commits: [{ sha: '4f2a9c1', subject: 'kood: timeout copy' }, { sha: '2c6a8d7', subject: 'army: column order' }, { sha: '51be0c4', subject: 'backoffice: cleanup' }] },
  lanes: [
    lane('b1', 'queue/moni-export', '2c6a8d7', [['0ad44c9', 'plan: filter by call result']]),
    lane('gone', 'queue/removed', '4f2a9c1', [['aaaaaaa', 'plan: removed item']]),
    lane('w1', 'queue/bulk-import', '51be0c4', [['e3d90b1', 'plan: bulk CSV import']]),
    lane('r1', 'queue/invoice-footer', '51be0c4', [['3be81f0', 'fix round 1: footer'], ['c47d2a8', 'execute: footer']]),
    lane('f1', 'gone', null, []),
  ],
}
const tree: QueueTree = { repos: [repo, { repo: '/Users/me/web', base: { branch: 'develop', commits: [{ sha: '1111111', subject: 'web: init' }] }, lanes: [] }] }

beforeAll(async () => {
  Object.assign(globalThis, { document: window.document })
  layout = await import('../client/queue-tree')
})

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'document')
  window.close()
})

test('started items get the next lane in queue order and items without lanes are left out', () => {
  const rows = layout.treeRows(repo, items)
  expect(rows.map(row => [row.lane, row.sha])).toEqual([
    [4, ''], [0, '4f2a9c1'], [1, ''], [1, '0ad44c9'], [0, '2c6a8d7'], [2, 'e3d90b1'], [3, '3be81f0'], [3, 'c47d2a8'], [0, '51be0c4'],
  ])
  expect(rows.some(row => row.subject === 'plan: removed item')).toBe(false)
  expect(rows.flatMap(row => (row.item ? [row.item.id] : []))).not.toContain('q1')
})

test('each lane tip points at the main commit it forked from', () => {
  const rows = layout.treeRows(repo, items)
  const tips = rows.filter(row => row.tip === true)
  expect(tips.map(row => [row.item?.id, row.forkOf])).toEqual([['f1', undefined], ['b1', 4], ['w1', 8], ['r1', 8]])
  expect(tips.map(row => row.item?.branch)).toEqual(['gone', 'queue/moni-export', 'queue/bulk-import', 'queue/invoice-footer'])
  expect(rows.filter(row => row.lane === 0).every(row => row.item === undefined)).toBe(true)
})

test('a building lane starts with a working row and an empty lane still shows its branch', () => {
  const rows = layout.treeRows(repo, items)
  expect(rows[2]).toMatchObject({ lane: 1, sha: '', working: true, tip: true })
  expect(rows[0]).toMatchObject({ lane: 4, sha: '', subject: 'No commits yet', tip: true })
})

test('only a waiting lane is parked', () => {
  const rows = layout.treeRows(repo, items)
  expect(rows.filter(row => row.parked === true).map(row => row.sha)).toEqual(['e3d90b1'])
})

test('a repo whose main could not be read keeps its lanes', () => {
  const rows = layout.treeRows({ ...repo, base: { branch: '', commits: [] } }, items)
  expect(rows.every(row => row.lane > 0 && row.forkOf === undefined)).toBe(true)
  expect(rows.filter(row => row.tip === true)).toHaveLength(4)
})

test('renders one section per repo under a Not started list', () => {
  const view = layout.renderTree(tree, items, [{ id: 'plan-only', name: 'Plan only' }])
  const panels = [...view.querySelectorAll<HTMLElement>('.q-tree-panel')]
  expect(panels.map(panel => panel.querySelector('h3')?.textContent)).toEqual([
    'Not started · 2 queued', 'main in /Users/me/api · newest on top', 'develop in /Users/me/web · newest on top',
  ])
  const notYet = [...view.querySelectorAll('.q-notyet')]
  expect(notYet.map(row => row.querySelector('strong')?.textContent)).toEqual([queued.title, queuedLater.title])
  expect(notYet.map(row => row.querySelector('.muted')?.textContent)).toEqual(['Default flow · Next up · no branch yet', 'Plan only · 3rd in line · no branch yet'])
  expect(notYet.map(row => row.getAttribute('draggable'))).toEqual(['true', 'true'])
})

test('the graph draws a dot per row, a working dot, a pause mark and the ready rebase label', () => {
  const panel = layout.renderTree(tree, items).querySelectorAll('.q-tree-panel')[1] as HTMLElement
  expect(panel.querySelectorAll('.q-tree-row')).toHaveLength(9)
  expect(panel.querySelectorAll('.q-graph circle')).toHaveLength(9)
  expect(panel.querySelectorAll('.q-graph .q-working')).toHaveLength(1)
  expect(panel.querySelectorAll('.q-graph [data-mark="parked"]')).toHaveLength(1)
  expect(panel.querySelectorAll('.q-graph [stroke-dasharray], .q-graph [style*="dasharray"]').length).toBeGreaterThan(0)
  const tips = [...panel.querySelectorAll<HTMLElement>('.q-tree-tip')]
  expect(tips.map(tip => tip.querySelector('.q-ref')?.textContent)).toEqual(['gone', 'queue/moni-export', 'queue/bulk-import', 'queue/invoice-footer'])
  expect(tips[2]?.querySelector('.q-parked')?.textContent).toBe('parked')
  expect(tips[3]?.querySelector('.q-ff')?.textContent).toBe('rebase onto main → fast-forward')
  expect(tips[3]?.querySelector('[data-act="open-run"]')?.getAttribute('data-id')).toBe('r1')
  expect(tips[3]?.querySelector('.q-wt')?.textContent).toBe('.worktree/queue-invoice-footer')
})

test('commit text and branch names stay text', () => {
  const hostile: TreeRepo = { ...repo, base: { branch: 'main', commits: [{ sha: '1234567', subject: '<img src=x onerror=alert(1)>' }] }, lanes: [] }
  const view = layout.renderTree({ repos: [hostile] }, [])
  expect(view.querySelector('img')).toBeNull()
  expect(view.querySelector('.q-msg-line')?.textContent).toBe('<img src=x onerror=alert(1)>')
})

test('no branches and nothing queued says how lanes appear', () => {
  const view = layout.renderTree({ repos: [] }, [])
  expect(view.querySelector('.q-notyet')).toBeNull()
  expect(view.textContent).toContain('No branches yet')
})

test('a lane with no commits says none are waiting once the card ships, and no commits yet before that', () => {
  const lanes = (state: QueueItem['state']) => layout.treeRows({ repo: '/r', base: { branch: 'main', commits: [{ sha: 'abc1234', subject: 'x' }] }, lanes: [lane('i', 'queue/i', 'abc1234', [])] }, [item({ id: 'i', state })])
  for (const state of ['landing', 'awaiting-stage', 'landed'] as const) expect(lanes(state)[0]!.subject).toBe('No commits waiting')
  for (const state of ['queued', 'ready', 'failed', 'waiting-info', 'waiting-pick'] as const) expect(lanes(state)[0]!.subject).toBe('No commits yet')
})
