import type { QueueTree, TreeCommit, TreeLane, TreeRepo } from '../server/queue-tree'
import { readArray, readRecord } from './shared'
import { el, flowName, icon, lineText, pill, type QueueFlow, type QueueItemView, type QueueState } from './queue-view'

export type TreeItem = Pick<QueueItemView, 'id' | 'state' | 'title' | 'flowId' | 'runIds'>
export type TreeRowItem = { id: string; state: QueueState; branch: string; worktree: string }
export type TreeRow = {
  lane: number; sha: string; subject: string; item?: TreeRowItem; forkOf?: number
  tip?: boolean; parked?: boolean; working?: boolean
}
type PlacedLane = { lane: TreeLane; item: TreeItem; index: number }

const SVG_NS = 'http://www.w3.org/2000/svg'
const ROW_HEIGHT = 36
const LANE_GAP = 22
const GRAPH_PAD = 22
const NO_SHA = '·······'
const WORKING = 'Working on the next commit'
const NO_COMMITS = 'No commits yet'
const SHIPPED_COMMITS = 'No commits waiting'
const SHIPPING: ReadonlySet<QueueState> = new Set(['landing', 'awaiting-stage', 'landed'])
const MAIN_INK = 'var(--muted)'
const INK: Record<QueueState, string> = {
  queued: 'var(--muted)', building: 'var(--accent)', 'waiting-info': 'var(--text-soft)', 'waiting-pick': 'var(--text-soft)', ready: 'var(--green-ink)', failed: 'var(--red-ink)',
  landing: 'var(--accent)', 'awaiting-stage': 'var(--text-soft)', landed: 'var(--green-ink)',
}

const laneX = (lane: number): number => 14 + lane * LANE_GAP
const rowY = (index: number): number => index * ROW_HEIGHT + ROW_HEIGHT / 2
const sameSha = (left: string, right: string): boolean => left !== '' && right !== '' && (left.startsWith(right) || right.startsWith(left))

function placeLanes(lanes: readonly TreeLane[], items: readonly TreeItem[]): PlacedLane[] {
  const byId = new Map(items.map(item => [item.id, item]))
  return lanes
    .flatMap(lane => { const item = byId.get(lane.itemId); return item === undefined ? [] : [{ lane, item }] })
    .map((entry, position) => ({ ...entry, index: position + 1 }))
}

function laneRows({ lane, item, index }: PlacedLane): TreeRow[] {
  const rowItem: TreeRowItem = { id: item.id, state: item.state, branch: lane.branch, worktree: lane.worktree }
  const commits: Array<TreeCommit & { working?: boolean }> = lane.commits.map(({ sha, subject }) => ({ sha, subject }))
  const lead = item.state === 'building' ? [{ sha: '', subject: WORKING, working: true }] : commits.length === 0 ? [{ sha: '', subject: SHIPPING.has(item.state) ? SHIPPED_COMMITS : NO_COMMITS }] : []
  const parked = item.state === 'waiting-info' ? { parked: true } : {}
  return [...lead, ...commits].map((commit, position) => ({ lane: index, ...commit, item: rowItem, ...parked, ...(position === 0 ? { tip: true } : {}) }))
}

export function treeRows(tree: TreeRepo, items: readonly TreeItem[]): TreeRow[] {
  const placed = placeLanes(tree.lanes, items)
  const forkIndex = ({ lane }: PlacedLane): number => tree.base.commits.findIndex(commit => sameSha(commit.sha, lane.forkSha ?? ''))
  const orphans = placed.filter(entry => forkIndex(entry) < 0).flatMap(laneRows)
  return tree.base.commits.reduce<TreeRow[]>((rows, commit, baseIndex) => {
    const forked = placed.filter(entry => forkIndex(entry) === baseIndex).flatMap(laneRows)
    const forkAt = rows.length + forked.length
    return [...rows, ...forked.map(row => (row.tip === true ? { ...row, forkOf: forkAt } : row)), { lane: 0, sha: commit.sha, subject: commit.subject }]
  }, orphans)
}

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value))
  return node
}

const inkOf = (row: TreeRow): string => (row.item === undefined ? MAIN_INK : INK[row.item.state])

function lanePath(row: TreeRow, index: number, rows: readonly TreeRow[]): SVGElement {
  const x = laneX(row.lane)
  const top = rowY(index)
  const dash = row.parked === true ? ';stroke-dasharray:4 4' : ''
  const style = `stroke:${inkOf(row)};stroke-width:2;fill:none${dash}`
  if (row.forkOf === undefined) {
    const last = rows.reduce((bottom, entry, position) => (entry.lane === row.lane ? position : bottom), index)
    return svg('path', { d: `M${x} ${top} V${rowY(last) + ROW_HEIGHT / 2}`, style })
  }
  const fork = rowY(row.forkOf)
  const x0 = laneX(0)
  return svg('path', { d: `M${x} ${top} V${fork - ROW_HEIGHT * 0.7} C${x} ${fork - ROW_HEIGHT * 0.25} ${x0} ${fork - ROW_HEIGHT * 0.45} ${x0} ${fork}`, style })
}

function landArrow(from: number, to: number, rows: readonly TreeRow[]): SVGElement {
  const x1 = laneX(rows[from]?.lane ?? 0)
  const x2 = laneX(0)
  const bend = Math.max(x1, x2) + LANE_GAP * 1.4
  const [y1, y2] = [rowY(from), rowY(to)]
  return svg('path', { d: `M${x1 + 7} ${y1} C${bend} ${y1} ${bend} ${y2} ${x2 + 9} ${y2}`, 'data-mark': 'land', style: 'stroke:var(--green-ink);stroke-width:1.6;fill:none;stroke-dasharray:4 3' })
}

function dot(row: TreeRow, index: number): SVGElement[] {
  const [x, y, ink] = [laneX(row.lane), rowY(index), inkOf(row)]
  if (row.item === undefined) return [svg('circle', { cx: x, cy: y, r: 5, style: `fill:${ink}` })]
  if (row.working === true) return [svg('circle', { class: 'q-working', cx: x, cy: y, r: 5.5, style: `fill:var(--paper);stroke:${ink};stroke-width:2;stroke-dasharray:3 2.4` })]
  const circle = svg('circle', { cx: x, cy: y, r: 5, style: `fill:var(--paper);stroke:${ink};stroke-width:2` })
  if (row.parked !== true || row.tip !== true) return [circle]
  return [circle, svg('path', { d: `M${x + 10} ${y - 4} v8 M${x + 14} ${y - 4} v8`, 'data-mark': 'parked', style: `stroke:${ink};stroke-width:1.8;stroke-linecap:round` })]
}

function graph(rows: readonly TreeRow[], markerId: string): { node: SVGElement; width: number } {
  const width = laneX(Math.max(0, ...rows.map(row => row.lane))) + GRAPH_PAD
  const height = rows.length * ROW_HEIGHT
  const root = svg('svg', { class: 'q-graph', width, height, viewBox: `0 0 ${width} ${height}`, style: `width:${width}px;height:${height}px`, 'aria-hidden': 'true' })
  const marker = svg('marker', { id: markerId, viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })
  marker.append(svg('path', { d: 'M1 1 9 5 1 9z', style: 'fill:var(--green-ink)' }))
  const defs = svg('defs', {})
  defs.append(marker)
  const head = rows.findIndex(row => row.lane === 0)
  const arrows = head < 0 ? [] : rows.flatMap((row, index) => (row.tip === true && row.item?.state === 'ready' ? [landArrow(index, head, rows)] : []))
  for (const arrow of arrows) arrow.setAttribute('marker-end', `url(#${markerId})`)
  root.append(
    defs,
    svg('path', { d: `M${laneX(0)} ${rowY(0)} V${height}`, style: `stroke:${MAIN_INK};stroke-width:2.4;fill:none` }),
    ...rows.flatMap((row, index) => (row.tip === true ? [lanePath(row, index, rows)] : [])),
    ...arrows,
    ...rows.flatMap(dot),
  )
  return { node: root, width }
}

const worktreeText = (worktree: string, repo: string): string => (worktree.startsWith(`${repo}/`) ? worktree.slice(repo.length + 1) : worktree)

function tipLabels(row: TreeRowItem, item: TreeItem | undefined, repo: TreeRepo): HTMLElement {
  const extras: HTMLElement[] = []
  if (row.state === 'waiting-info') extras.push(el('span', { class: 'q-parked' }, 'parked'))
  if (row.state === 'ready') extras.push(el('span', { class: 'q-ff' }, `rebase onto ${repo.base.branch || 'main'} → fast-forward`))
  if ((row.state === 'ready' || row.state === 'failed') && (item?.runIds.length ?? 0) > 0) {
    const className = row.state === 'ready' ? 'connection-button primary q-mini' : 'connection-button q-mini'
    extras.push(el('button', { type: 'button', class: className, 'data-act': 'open-run', 'data-id': row.id }, icon('flow-icon'), 'Open run'))
  }
  return el('span', { class: 'q-labels' },
    el('code', { class: 'q-ref', 'data-k': 'branch', title: item?.title ?? row.branch }, row.branch),
    el('code', { class: 'q-wt' }, worktreeText(row.worktree, repo.repo)),
    pill(row.state), ...extras)
}

function treeRow(row: TreeRow, index: number, head: number, repo: TreeRepo, items: readonly TreeItem[]): HTMLElement {
  const placeholder = row.sha === ''
  const message = el('span', { class: 'q-msg-line' }, placeholder ? el('span', { class: 'muted' }, row.subject) : row.subject)
  const tip = row.tip === true && row.item !== undefined
  const labels = tip && row.item ? [tipLabels(row.item, items.find(entry => entry.id === row.item?.id), repo)]
    : index === head && repo.base.branch !== '' ? [el('span', { class: 'q-labels' }, el('code', { class: 'q-ref', 'data-k': 'main' }, repo.base.branch))] : []
  return el('div', { class: tip ? 'q-tree-row q-tree-tip' : 'q-tree-row', 'data-id': tip && row.item ? row.item.id : false },
    el('code', { class: 'q-sha' }, placeholder ? NO_SHA : row.sha), message, ...labels)
}

function repoPanel(repo: TreeRepo, items: readonly TreeItem[], markerId: string): HTMLElement {
  const title = repo.base.branch === ''
    ? el('h3', {}, el('code', { class: 'q-wt' }, repo.repo), ' · newest on top')
    : el('h3', {}, el('code', { class: 'q-ref', 'data-k': 'main' }, repo.base.branch), ' in ', el('code', { class: 'q-wt' }, repo.repo), ' · newest on top')
  const rows = treeRows(repo, items)
  if (rows.length === 0) return el('section', { class: 'q-tree-panel' }, title, el('p', { class: 'muted q-tree-note' }, 'Nothing to show for this repo yet.'))
  const { node, width } = graph(rows, markerId)
  const head = rows.findIndex(row => row.lane === 0)
  return el('section', { class: 'q-tree-panel' }, title,
    el('div', { class: 'q-tree', style: `--gw:${width}px` }, node, el('div', { class: 'q-tree-rows' }, ...rows.map((row, index) => treeRow(row, index, head, repo, items)))))
}

function notStartedPanel(items: readonly QueueItemView[], started: ReadonlySet<string>, flows: readonly QueueFlow[]): HTMLElement | null {
  const queued = items.filter(item => item.state === 'queued')
  const waiting = queued.filter(item => !started.has(item.id))
  if (waiting.length === 0) return null
  return el('section', { class: 'q-tree-panel' }, el('h3', {}, `Not started · ${waiting.length} queued`),
    ...waiting.map(item => el('div', { class: 'q-notyet', 'data-id': item.id, 'data-movable': true, draggable: 'true' },
      el('span', { class: 'q-grip', title: 'Drag to reorder' }, icon('q-grip')),
      pill('queued'),
      el('strong', {}, item.title),
      el('span', { class: 'muted' }, `${flowName(item, flows)} · ${lineText(items, queued.indexOf(item))} · no branch yet`))))
}

export function renderTree(tree: QueueTree, items: readonly QueueItemView[], flows: readonly QueueFlow[] = []): HTMLElement {
  const started = new Set(tree.repos.flatMap(repo => repo.lanes.map(lane => lane.itemId)))
  const notStarted = notStartedPanel(items, started, flows)
  const repos = tree.repos.map((repo, index) => repoPanel(repo, items, `q-arrow-${index}`))
  const empty = tree.repos.length === 0
    ? [el('section', { class: 'q-tree-panel' }, el('h3', {}, 'No branches yet'), el('p', { class: 'muted q-tree-note' }, 'An item gets its own branch and worktree when it starts building.'))]
    : []
  return el('div', { class: 'q-tree-view' }, ...(notStarted ? [notStarted] : []), ...repos, ...empty)
}

const isText = (value: unknown): value is string => typeof value === 'string'

function readCommits(value: unknown): TreeCommit[] {
  return readArray(value).filter(entry => isText(entry.sha) && isText(entry.subject)).map(entry => ({ sha: String(entry.sha), subject: String(entry.subject) }))
}

function readLane(entry: Record<string, unknown>): TreeLane[] {
  const { itemId, branch, worktree, forkSha } = entry
  if (!isText(itemId) || !isText(branch) || !isText(worktree) || !(forkSha === null || isText(forkSha))) return []
  return [{ itemId, branch, worktree, forkSha, commits: readCommits(entry.commits) }]
}

export function readQueueTree(value: unknown): QueueTree {
  return {
    repos: readArray(readRecord(value).repos).flatMap((entry) => {
      const base = readRecord(entry.base)
      if (!isText(entry.repo) || !isText(base.branch)) return []
      return [{ repo: entry.repo, base: { branch: base.branch, commits: readCommits(base.commits) }, lanes: readArray(entry.lanes).flatMap(readLane) }]
    }),
  }
}
