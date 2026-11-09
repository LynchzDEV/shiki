import { spyOn } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createQueueEngine, type QueueEngineDeps, type QueueRunner } from '../../server/queue-engine'
import type { RunView } from '../../server/queue-prompts'
import type { CardPeople } from '../../server/queue-pick-reply'
import type { QueueSource, SourceReplies } from '../../server/queue-source'
import { createQueueStore, type QueueItem } from '../../server/queue-store'
import type { WorkflowAttempt } from '../../server/workflow-runner'

export const blockedWith = (evidence: string[], over: Partial<WorkflowAttempt> = {}): WorkflowAttempt => ({ nodeId: 'plan', number: 1, jobId: 'j', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: { outcome: 'blocked', summary: 'Need info', evidence }, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [], ...over })
export const reply = (id: string, text: string, author = 'Ploy', authorId = ''): SourceReplies => ({ replies: [{ id, author, authorId, text, images: [] }], lastId: id })
export const PEOPLE: CardPeople = { creator: { id: '11', username: 'Kan' }, assignees: [], me: { id: '99', username: 'Palm' } }
export const noReplies: SourceReplies = { replies: [], lastId: null }

export type Started = { cwd: string; request: string; label: string; workflowId?: string }

export function queueHarness(dir: string, over: Partial<QueueEngineDeps> = {}, sourceOver: Partial<QueueSource> = {}) {
  const queueFile = join(dir, 'queue.json')
  const store = createQueueStore(queueFile)
  const runs = new Map<string, RunView>()
  const started: Started[] = []
  const posted: Array<Parameters<QueueSource['post']>[0]> = []
  const resolved: Array<{ id: string; ref: string }> = []
  const alerts: Array<{ title: string; reason: string; state: string }> = []
  const sinceIds: Array<string | null> = []
  let replies: () => Promise<SourceReplies> = async () => noReplies
  let next = 0
  const runner: QueueRunner = {
    start: async input => { started.push(input); const id = `run-${++next}`; runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } },
    get: id => runs.get(id),
  }
  const source: QueueSource = {
    item: async ({ id }) => ({ title: `Task ${id}`, url: `https://x/t/${id}`, contextMarkdown: `# ${id}` }),
    post: async input => { posted.push(input); return { commentId: 'c1', ...(input.mention === undefined ? {} : { ref: `ref-${posted.length}` }) } },
    replies: async ({ sinceId }) => { sinceIds.push(sinceId); return replies() },
    status: async ({ status }) => ({ status }),
    people: async () => PEOPLE,
    resolve: async input => { resolved.push(input) },
    ...sourceOver,
  }
  const deps: QueueEngineDeps = {
    store, runner,
    source: () => source,
    prepareWorktree: async (repo, label) => {
      const worktree = join(dir, repo.replace(/\W/g, '_'), '.worktree', label)
      await mkdir(worktree, { recursive: true })
      await writeFile(join(worktree, '.git'), 'gitdir: elsewhere')
      return { worktree }
    },
    writeContext: async (pluginId, context, cwd) => { const folder = join(cwd, '.shikidan', 'queue', pluginId); await mkdir(folder, { recursive: true }); const path = join(folder, `${context.name}.md`); await writeFile(path, context.markdown); return path },
    pluginFiles: pluginId => join(dir, 'plugin-data', pluginId, 'files'),
    backupDir: itemId => join(dir, 'queue-files', itemId),
    needsYou: (item, reason) => { alerts.push({ title: item.title, reason, state: item.state }) },
    ...over,
  }
  const settle = (id: string, run: Partial<RunView>) => { const done = { ...runs.get(id)!, ...run }; runs.set(id, done); return done }
  const restart = (runnerOver: Partial<QueueRunner> = {}) => {
    const reloaded = createQueueStore(queueFile)
    return { store: reloaded, engine: createQueueEngine({ ...deps, store: reloaded, runner: { ...runner, ...runnerOver } }) }
  }
  return {
    engine: createQueueEngine(deps), store, runs, started, posted, resolved, alerts, sinceIds, settle, restart, deps,
    answer: (next: () => Promise<SourceReplies>) => { replies = next },
  }
}

export const add = { source: 'clickup-board', externalId: '1', repo: '/repo' }
export const states = (items: QueueItem[]) => items.map(item => `${item.externalId}:${item.state}`)

export async function refusal(work: Promise<unknown>): Promise<unknown> {
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    return await work.then(() => null, (error: unknown) => error)
  } finally { quiet.mockRestore() }
}

export async function parkedItem(h: QueueHarness) {
  const item = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', attempts: [blockedWith(['biz: Which page?'])] }))
  return h.store.get(item.id)!
}


export type QueueHarness = ReturnType<typeof queueHarness>
