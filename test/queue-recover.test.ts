import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { realEngineResolver } from '../server/jobs-engine-iface'
import { createQueueEngine, type QueueEngineDeps, type QueueRunner } from '../server/queue-engine'
import { landLogPath } from '../server/queue-land'
import type { RunView } from '../server/queue-prompts'
import { recoverGraph, recoveryVerdict, RECOVERY_RULES } from '../server/queue-recover'
import type { QueueSource } from '../server/queue-source'
import { createQueueStore } from '../server/queue-store'
import { validateWorkflow, type LandStage } from '../server/workflows'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-queue-recover-'))
  process.env.SKD_CONFIG_DIR = join(dir, 'config')
})
afterEach(async () => {
  delete process.env.SKD_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

async function script(name: string, body: string): Promise<string> {
  const path = join(dir, 'bin', name)
  await mkdir(join(dir, 'bin'), { recursive: true })
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

const stage = (id: string, command: string, over: Partial<LandStage> = {}): LandStage => ({ id, run: 'auto', command: { command, args: [], timeoutSeconds: 30 }, env: {}, ...over })

type StartInput = Parameters<QueueRunner['start']>[0]

function harness() {
  const store = createQueueStore(join(dir, 'queue.json'))
  const runs = new Map<string, RunView>()
  const started: Array<StartInput & { id: string }> = []
  const stopped: string[] = []
  const retried: string[] = []
  const posted: Array<Parameters<QueueSource['post']>[0]> = []
  const alerts: string[] = []
  let next = 0
  const source: QueueSource = {
    item: async ({ id }) => ({ title: `Task ${id}`, url: `https://x/t/${id}`, contextMarkdown: `# ${id}` }),
    post: async (input) => { posted.push(input); return { commentId: `c${posted.length}` } },
    replies: async () => ({ replies: [{ id: 'r1', author: 'Ann', text: 'never read', images: [] }], lastId: 'r1' }),
  }
  const runner: QueueRunner = {
    start: async (input) => { const id = `run-${++next}`; runs.set(id, { id, status: 'running', error: null, attempts: [] }); started.push({ ...input, id }); return { id } },
    get: id => runs.get(id),
    retry: async (id) => { retried.push(id); runs.set(id, { ...runs.get(id)!, status: 'running', error: null }); return { id } },
    stop: async (id) => { stopped.push(id); const run: RunView = { ...runs.get(id)!, status: 'stopped', error: 'Stopped by user' }; runs.set(id, run); void engine.onRunSettled(run); return run },
  }
  const deps: QueueEngineDeps = {
    store,
    runner,
    source: () => source,
    prepareWorktree: async (_repo, label) => { const worktree = join(dir, 'wt', label); await mkdir(worktree, { recursive: true }); return { worktree } },
    writeContext: async (_pluginId, context, cwd) => { const path = join(cwd, `${context.name}-${next}.md`); await writeFile(path, context.markdown); return path },
    pluginFiles: pluginId => join(dir, 'plugin-data', pluginId),
    backupDir: itemId => join(dir, 'queue-files', itemId),
    needsYou: (_item, reason) => { alerts.push(reason) },
  }
  const engine = createQueueEngine(deps)
  const settle = async (id: string, status: RunView['status'], evidence: string[] = [], over: Partial<RunView> = {}) => {
    const outcome = status === 'done' ? 'pass' : status === 'failed' ? 'fail' : 'blocked'
    const run: RunView = { ...runs.get(id)!, status, error: status === 'done' ? null : 'agent gave up', attempts: [{ nodeId: 'recover', number: 0, jobId: 'j1', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: { outcome, summary: 's', evidence }, checks: [], output: 'last words', workspace: null, tokenId: 't', pathId: 'main', from: [] }], ...over }
    runs.set(id, run)
    await engine.onRunSettled(run)
    await engine.landIdle()
    return run
  }
  const item = (id: string) => store.get(id)!
  const ship = async (land: LandStage[], externalId = '1') => {
    const added = await engine.add({ source: 'clickup-board', externalId, repo: '/repo' })
    const runId = store.get(added.id)!.currentRunId!
    const done: RunView = { ...runs.get(runId)!, status: 'done', workflow: { land } }
    runs.set(runId, done)
    await engine.onRunSettled(done)
    await engine.landIdle()
    return added.id
  }
  return { engine, store, runner, runs, started, stopped, retried, posted, alerts, item, ship, settle, deps }
}

const failing = () => script('bad.sh', 'echo boom\nexit 3')

test('the Recover graph is one valid task node for claude opus', () => {
  const graph = recoverGraph()
  expect(validateWorkflow(graph)).toEqual([])
  expect(graph.nodes).toHaveLength(1)
  expect(graph.nodes[0]).toMatchObject({ title: 'Recover', kind: 'task', maxVisits: 1, agent: { role: 'execute', engine: 'claude', model: 'opus' }, denyTools: ['Bash(*git*push*)', 'Bash(*kamal*)', 'Bash(*ship-prod*)', 'Bash(*ship-uat*)', 'Bash(*land/*/start*)'] })
  expect(graph.edges).toEqual([])
})

test('an auto stage failure starts a recovery run and stays landing', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', await failing())])
  const item = h.item(id)
  expect(item.state).toBe('landing')
  expect(item.error).toBeNull()
  expect(item.land).toMatchObject({ stage: 'uat', message: 'Recovering, attempt 1 of 3', stages: { uat: { status: 'failed', exitCode: 3 } }, recover: { stage: 'uat', attempts: 1, runId: 'run-2' } })
  expect(item.currentRunId).toBe('run-2')
  expect(item.runIds).toEqual(['run-1'])
  expect(h.alerts).toEqual([])
})

test('the recovery request names the stage, log, workspace and repos and carries the rules verbatim', async () => {
  const h = harness()
  const noisy = await script('noisy.sh', 'i=1; while [ $i -le 250 ]; do echo "line $i"; i=$((i+1)); done\nexit 3')
  const id = await h.ship([stage('uat', noisy)])
  const { request, graph, cwd } = h.started.at(-1)!
  const item = h.item(id)
  expect(cwd).toBe(item.worktree!)
  expect(graph).toEqual(recoverGraph())
  for (const part of ['Failed stage: uat', 'Why it failed: uat failed (exit 3)', `Stage command: ${noisy}`, item.worktree!, 'repo', '/repo', 'line 250', 'line 51', 'tech:']) expect(request).toContain(part)
  expect(request).not.toContain(landLogPath(id, 'uat'))
  expect(request).not.toContain('Full log')
  expect(request).not.toContain('test database')
  expect(request).not.toContain('line 50\n')
  expect(request).toContain('Find why this ship stage failed and fix it in this worktree, then end with SKD_RESULT pass so Shikidan runs the stage again. You may repair the environment and tooling: link or copy gitignored key files from the real checkout, install gems or node modules, restore files a test run generated, wait for a lock. You must not: git push, force-push, or rewrite pushed history; run kamal, deploy, or anything touching production; release a deploy lock another person holds; edit a test to make it pass; change application code to get past a check; change anything outside this worktree except your own temp files; print secret values. If the card\'s own code is wrong, make no change and end with SKD_RESULT fail with evidence lines starting `code:`. If only the owner can answer, end with SKD_RESULT blocked with evidence lines starting `tech:`, one question each.')
})

test('a huge log still gives a request the runner accepts, because it caps requests at 32000 characters', async () => {
  const h = harness()
  const huge = await script('huge.sh', 'i=1; while [ $i -le 200 ]; do printf "%0500d\\n" $i; i=$((i+1)); done\necho the-last-line\nexit 3')
  await h.ship([stage('uat', huge)])
  const { request } = h.started.at(-1)!
  expect(request.length).toBeLessThanOrEqual(32000)
  expect(request).toContain('the-last-line')
  expect(request).toContain(RECOVERY_RULES)
})

test('a recovery that passes runs the stage again and a pass resets the count', async () => {
  const h = harness()
  const flaky = await script('flaky.sh', `if [ -f ${dir}/fixed ]; then exit 0; fi\nexit 1`)
  const id = await h.ship([stage('uat', flaky)])
  await writeFile(join(dir, 'fixed'), '')
  await h.settle('run-2', 'done')
  expect(h.item(id).state).toBe('landed')
  expect(h.item(id).currentRunId).toBeNull()
  expect(h.item(id).land?.recover).toBeUndefined()
  expect(h.item(id).land?.message).toBeUndefined()
  expect(h.alerts).toEqual(['Landed'])
})

test('a fourth failure ends failed and names 3 attempts', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', await failing())])
  await h.settle('run-2', 'done')
  expect(h.item(id).land).toMatchObject({ message: 'Recovering, attempt 2 of 3', recover: { attempts: 2, runId: 'run-3' } })
  await h.settle('run-3', 'done')
  expect(h.item(id).land).toMatchObject({ message: 'Recovering, attempt 3 of 3', recover: { attempts: 3, runId: 'run-4' } })
  await h.settle('run-4', 'done')
  const failed = h.item(id)
  expect(failed.state).toBe('failed')
  expect(failed.currentRunId).toBeNull()
  expect(failed.error!.split('\n')[0]).toBe('uat failed (exit 3)')
  expect(failed.error).toContain('3 recovery attempts')
  expect(failed.error).toContain('boom')
  expect(h.started).toHaveLength(4)
  expect(h.alerts).toEqual(['uat failed (exit 3)'])
})

test('a recovery run that fails with no code lines counts as an attempt until the cap, then fails with the stage error', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', await failing())])
  await h.settle('run-2', 'failed', ['no idea'])
  expect(h.item(id).land).toMatchObject({ recover: { attempts: 2, runId: 'run-3' } })
  await h.settle('run-3', 'blocked', [])
  expect(h.item(id).land).toMatchObject({ recover: { attempts: 3, runId: 'run-4' } })
  await h.settle('run-4', 'failed', ['still no idea'])
  expect(h.item(id).state).toBe('failed')
  expect(h.item(id).error).toContain('uat failed (exit 3)')
  expect(h.item(id).error).toContain('3 recovery attempts')
  expect(h.started).toHaveLength(4)
})

test('a button stage failure starts no recovery', async () => {
  const h = harness()
  const id = await h.ship([stage('prod', await failing(), { run: 'button', label: 'Deploy prod' })])
  await h.engine.startStage(id, 'prod')
  await h.engine.landIdle()
  expect(h.item(id)).toMatchObject({ state: 'failed', error: expect.stringContaining('prod failed (exit 3)') })
  expect(h.item(id).land?.recover).toBeUndefined()
  expect(h.started).toHaveLength(1)
})

test('a stopped stage and a bad stage json start no recovery', async () => {
  const h = harness()
  const slow = await script('slow.sh', `touch ${dir}/started\nsleep 30`)
  const stopping = await h.engine.add({ source: 'clickup-board', externalId: 'a', repo: '/repo' })
  const run = h.runs.get(h.item(stopping.id).currentRunId!)!
  const done: RunView = { ...run, status: 'done', workflow: { land: [stage('uat', slow)] } }
  h.runs.set(run.id, done)
  await h.engine.onRunSettled(done)
  while (!await Bun.file(join(dir, 'started')).exists()) await Bun.sleep(20)
  await h.engine.stop(stopping.id)
  await h.engine.landIdle()
  expect(h.item(stopping.id)).toMatchObject({ state: 'failed', error: 'Stopped by you during uat' })
  const badJson = await script('bad-json.sh', 'echo nope > "$SKD_LAND_DIR/uat.json"')
  const bad = await h.ship([stage('uat', badJson)], 'b')
  expect(h.item(bad)).toMatchObject({ state: 'failed', error: expect.stringContaining('Bad uat.json:') })
  expect(h.started).toHaveLength(2)
})

test('a posting failure starts no recovery', async () => {
  const h = harness()
  const up = await script('up.sh', `printf '{"post":{"kind":"update","lines":["live"]}}' > "$SKD_LAND_DIR/uat.json"`)
  const source = h.deps.source('x')
  source.post = async () => { throw new Error('ClickUp is down') }
  const id = await h.ship([stage('uat', up)])
  expect(h.item(id)).toMatchObject({ state: 'failed', error: 'uat ran but posting failed: ClickUp is down' })
  expect(h.started).toHaveLength(1)
})

test('Stop during recovery stops the run and fails the item, and the late settle changes nothing', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', await failing())])
  await h.engine.stop(id)
  await h.engine.kick()
  await h.engine.landIdle()
  expect(h.stopped).toEqual(['run-2'])
  expect(h.item(id)).toMatchObject({ state: 'failed', error: 'Stopped by you during uat', currentRunId: null })
  expect(h.started).toHaveLength(2)
})

test('a recovery run stopped elsewhere fails the item as stopped instead of spending an attempt', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', await failing())])
  await h.settle('run-2', 'stopped')
  expect(h.item(id)).toMatchObject({ state: 'failed', error: 'Stopped by you during uat', currentRunId: null })
  expect(h.started).toHaveLength(2)
})

test('Remove during recovery stops the run', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', await failing())])
  await h.engine.remove(id)
  await h.engine.landIdle()
  expect(h.stopped).toEqual(['run-2'])
  expect(h.store.get(id)).toBeUndefined()
})

test('a manual Retry stage resets the attempts', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', await failing())])
  await h.settle('run-2', 'done')
  await h.settle('run-3', 'done')
  await h.settle('run-4', 'done')
  expect(h.item(id).state).toBe('failed')
  await h.engine.retryStage(id)
  await h.engine.landIdle()
  expect(h.item(id).land).toMatchObject({ message: 'Recovering, attempt 1 of 3', recover: { attempts: 1, runId: 'run-5' } })
})

test('a passing stage resets the count for a later failure of the same item', async () => {
  const h = harness()
  const flaky = await script('flaky.sh', `if [ -f ${dir}/fixed ]; then exit 0; fi\nexit 1`)
  const id = await h.ship([stage('uat', flaky), stage('smoke', await failing())])
  await writeFile(join(dir, 'fixed'), '')
  await h.settle('run-2', 'done')
  expect(h.item(id).land).toMatchObject({ stage: 'smoke', message: 'Recovering, attempt 1 of 3', recover: { stage: 'smoke', attempts: 1, runId: 'run-3' } })
})

test('code: stores the evidence, requeues once, then fails with the evidence as the error', async () => {
  const h = harness()
  const bad = await failing()
  const id = await h.ship([stage('uat', bad)])
  await h.settle('run-2', 'failed', ['code: the migration drops a column it still reads'])
  const rebuilt = h.item(id)
  expect(rebuilt.recoverRebuilds).toBe(1)
  expect(rebuilt.state).toBe('building')
  expect(rebuilt.land).toBeUndefined()
  expect(rebuilt.currentRunId).toBe('run-3')
  expect(rebuilt.runIds).toEqual(['run-1', 'run-3'])
  expect(rebuilt.answerPaths).toHaveLength(1)
  const note = rebuilt.answerPaths[0]!
  expect(await readFile(note, 'utf8')).toContain('the migration drops a column it still reads')
  expect(await readFile(join(dir, 'queue-files', id, note.split('/').at(-1)!), 'utf8')).toContain('the migration drops a column it still reads')
  expect(h.started.at(-1)!.request).toContain(note)
  expect(h.started.at(-1)!.graph).toBeUndefined()
  const done: RunView = { ...h.runs.get('run-3')!, status: 'done', workflow: { land: [stage('uat', bad)] } }
  h.runs.set('run-3', done)
  await h.engine.onRunSettled(done)
  await h.engine.landIdle()
  await h.settle(h.item(id).currentRunId!, 'failed', ['code: still wrong'])
  expect(h.item(id).state).toBe('failed')
  expect(h.item(id).error).toBe('still wrong')
  expect(h.item(id).recoverRebuilds).toBe(1)
})

test('tech: asks the owner in Shikidan and posts nothing to the source', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', await failing())])
  await h.settle('run-2', 'blocked', ['tech: Which key file does this stage read?'])
  expect(h.item(id)).toMatchObject({ state: 'waiting-info', askedIn: 'shikidan', questions: ['Which key file does this stage read?'], currentRunId: null, error: null })
  expect(h.posted).toEqual([])
  expect(h.alerts).toEqual(['Technical question'])
})

test('a restart during recovery gives the restart failure and stops the orphaned run', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', await failing())])
  await h.engine.recover()
  expect(h.item(id)).toMatchObject({ state: 'failed', error: 'Shikidan restarted during uat; use Retry stage', currentRunId: null })
  expect(h.stopped).toEqual(['run-2'])
  expect(h.started).toHaveLength(2)
})

test('a recovery run is not treated as the build run', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', await failing())])
  await h.settle('run-2', 'done')
  expect(h.item(id).state).toBe('landing')
  expect(h.item(id).runIds).toEqual(['run-1'])
  const again = h.runs.get('run-2')!
  await h.engine.onRunSettled(again)
  await h.engine.landIdle()
  expect(h.started).toHaveLength(3)
})

test('a recovery run that settled before the start returned is still handled', async () => {
  const h = harness()
  const realStart = h.runner.start
  h.runner.start = async (input, context) => {
    const started = await realStart(input, context)
    if (input.graph !== undefined) {
      const run: RunView = { ...h.runs.get(started.id)!, status: 'blocked', error: 'claude unavailable', attempts: [] }
      h.runs.set(started.id, run)
      void h.engine.onRunSettled(run)
    }
    return started
  }
  const id = await h.ship([stage('uat', await failing())])
  while (h.item(id).state === 'landing') await Bun.sleep(10)
  expect(h.item(id).state).toBe('failed')
  expect(h.item(id).error).toContain('3 recovery attempts')
  expect(h.started).toHaveLength(4)
})

test('a recovery that cannot start fails the stage as today and says why', async () => {
  const h = harness()
  const realStart = h.runner.start
  h.runner.start = async (input, context) => {
    if (input.graph !== undefined) throw new Error('Workspace already has running work')
    return realStart(input, context)
  }
  const id = await h.ship([stage('uat', await failing())])
  expect(h.item(id).state).toBe('failed')
  expect(h.item(id).error!.split('\n')[0]).toBe('uat failed (exit 3)')
  expect(h.item(id).error).toContain('Workspace already has running work')
  expect(h.item(id).currentRunId).toBeNull()
})

test('a failed code note write fails the card with the evidence instead of leaving it stuck', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', await failing())])
  const brokenDisk = createQueueEngine({ ...h.deps, writeContext: async () => { throw new Error('disk full') } })
  const run: RunView = { ...h.runs.get('run-2')!, status: 'failed', error: 'x', attempts: [{ nodeId: 'recover', number: 0, jobId: 'j1', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: { outcome: 'fail', summary: 's', evidence: ['code: wrong'] }, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [] }] }
  await brokenDisk.onRunSettled(run)
  expect(h.item(id).state).toBe('failed')
  expect(h.item(id).error).toContain('wrong')
  expect(h.item(id).error).toContain('disk full')
})

async function failedBuild(h: ReturnType<typeof harness>, externalId = '1') {
  const added = await h.engine.add({ source: 'clickup-board', externalId, repo: '/repo' })
  await h.settle(h.item(added.id).currentRunId!, 'failed', ['tests are red'], { error: 'Execute failed' })
  return added.id
}

test('a build run with no questions starts a recovery run and stays building', async () => {
  const h = harness()
  const id = await failedBuild(h)
  expect(h.item(id)).toMatchObject({ state: 'building', currentRunId: 'run-2', error: null, runIds: ['run-1'], recoverBuild: { runId: 'run-1', attempts: 1, recoveryRunId: 'run-2' } })
  const { request, graph, cwd } = h.started.at(-1)!
  expect(graph).toEqual(recoverGraph())
  expect(cwd).toBe(h.item(id).worktree!)
  for (const part of ['Execute failed', 'last words', RECOVERY_RULES]) expect(request).toContain(part)
})

test('a passing build recovery resumes the run, and its later settle counts as the build run', async () => {
  const h = harness()
  const id = await failedBuild(h)
  await h.settle('run-2', 'done')
  expect(h.retried).toEqual(['run-1'])
  expect(h.item(id)).toMatchObject({ state: 'building', currentRunId: 'run-1' })
  const done: RunView = { ...h.runs.get('run-1')!, status: 'done', workflow: {} }
  h.runs.set('run-1', done)
  await h.engine.onRunSettled(done)
  expect(h.item(id)).toMatchObject({ state: 'ready', error: null })
})

test('build recovery stops at 2 attempts and fails with the run error', async () => {
  const h = harness()
  const id = await failedBuild(h)
  await h.settle('run-2', 'done')
  await h.settle('run-1', 'failed', ['tests are red'], { error: 'Execute failed' })
  expect(h.item(id)).toMatchObject({ state: 'building', recoverBuild: { attempts: 2, recoveryRunId: 'run-3' } })
  await h.settle('run-3', 'done')
  await h.settle('run-1', 'failed', ['tests are red'], { error: 'Execute failed' })
  expect(h.item(id).state).toBe('failed')
  expect(h.item(id).error).toContain('Execute failed')
  expect(h.item(id).error).toContain('2 recovery attempts')
  expect(h.item(id).resumeRunId).toBe('run-1')
  expect(h.started).toHaveLength(3)
})

test('a build recovery that does not pass tries again until the cap, without a retry', async () => {
  const h = harness()
  const id = await failedBuild(h)
  await h.settle('run-2', 'failed', ['no idea'])
  expect(h.item(id)).toMatchObject({ state: 'building', recoverBuild: { attempts: 2, recoveryRunId: 'run-3' } })
  await h.settle('run-3', 'failed', ['no idea'])
  expect(h.item(id).state).toBe('failed')
  expect(h.item(id).error).toContain('Execute failed')
  expect(h.retried).toEqual([])
})

test('a build run stopped by a person starts no recovery', async () => {
  const h = harness()
  const added = await h.engine.add({ source: 'clickup-board', externalId: '1', repo: '/repo' })
  await h.engine.stop(added.id)
  await h.engine.kick()
  expect(h.item(added.id)).toMatchObject({ state: 'failed', error: 'Stopped by user' })
  expect(h.started).toHaveLength(1)
})

test('Stop during a build recovery stops that run and fails the card, leaving the run resumable', async () => {
  const h = harness()
  const id = await failedBuild(h)
  await h.engine.stop(id)
  await h.engine.kick()
  expect(h.stopped).toEqual(['run-2'])
  expect(h.item(id)).toMatchObject({ state: 'failed', error: 'Stopped by user', resumeRunId: 'run-1' })
  expect(h.started).toHaveLength(2)
})

test('a manual requeue gives build recovery a new budget', async () => {
  const h = harness()
  const id = await failedBuild(h)
  await h.settle('run-2', 'failed', ['no idea'])
  await h.settle('run-3', 'failed', ['no idea'])
  expect(h.item(id).state).toBe('failed')
  await h.engine.requeue(id)
  expect(h.item(id).recoverBuild).toBeUndefined()
  expect(h.retried).toEqual(['run-1'])
})

test('tech: and code: work from a build recovery too', async () => {
  const h = harness()
  const asking = await failedBuild(h, 'a')
  await h.settle('run-2', 'blocked', ['tech: Which database?'])
  expect(h.item(asking)).toMatchObject({ state: 'waiting-info', askedIn: 'shikidan', questions: ['Which database?'] })
  const rebuilding = await failedBuild(h, 'b')
  await h.settle(h.item(rebuilding).currentRunId!, 'failed', ['code: wrong column'])
  expect(h.item(rebuilding)).toMatchObject({ recoverRebuilds: 1, state: 'building' })
  expect(h.item(rebuilding).answerPaths).toHaveLength(1)
})

test('a build recovery run that settled before the start returned is still handled', async () => {
  const h = harness()
  const realStart = h.runner.start
  h.runner.start = async (input, context) => {
    const started = await realStart(input, context)
    if (input.graph !== undefined) h.runs.set(started.id, { ...h.runs.get(started.id)!, status: 'blocked', error: 'claude unavailable', attempts: [] })
    return started
  }
  const id = await failedBuild(h)
  expect(h.item(id).state).toBe('failed')
  expect(h.item(id).error).toContain('Execute failed')
  expect(h.item(id).error).toContain('2 recovery attempts')
  expect(h.started).toHaveLength(3)
})

test('without a retry on the runner a build run with no questions fails as before', async () => {
  const h = harness()
  delete h.runner.retry
  const id = await failedBuild(h)
  expect(h.item(id)).toMatchObject({ state: 'failed', error: 'Execute failed' })
  expect(h.started).toHaveLength(1)
})

test('recoveryVerdict reads the last settled result of the run', () => {
  const run = (status: RunView['status'], outcome: 'pass' | 'fail' | 'blocked', evidence: string[]): RunView => ({ id: 'r', status, error: null, attempts: [{ nodeId: 'recover', number: 0, jobId: 'j1', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: { outcome, summary: 's', evidence }, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [] }] })
  expect(recoveryVerdict(run('done', 'pass', ['ok']))).toEqual({ kind: 'pass' })
  expect(recoveryVerdict(run('stopped', 'blocked', []))).toEqual({ kind: 'stopped' })
  expect(recoveryVerdict(run('failed', 'fail', ['note', 'code: a', '- Code: b']))).toEqual({ kind: 'code', evidence: ['a', 'b'] })
  expect(recoveryVerdict(run('failed', 'fail', ['tech: not on a fail']))).toEqual({ kind: 'again' })
  expect(recoveryVerdict(run('blocked', 'blocked', ['tech: q?', 'untagged', 'biz: ราคา', '- Biz: อีกข้อ', 'tech:', 'biz:', '  ']))).toEqual({ kind: 'tech', questions: ['q?', 'untagged', 'ราคา', 'อีกข้อ'] })
  expect(recoveryVerdict(run('blocked', 'blocked', []))).toEqual({ kind: 'again' })
  expect(recoveryVerdict(run('blocked', 'blocked', ['tech:', '  ']))).toEqual({ kind: 'again' })
  expect(recoveryVerdict({ ...run('failed', 'fail', ['code: a']), attempts: [] })).toEqual({ kind: 'again' })
})

const DENIED = 'Bash(*git*push*),Bash(*kamal*),Bash(*ship-prod*),Bash(*ship-uat*),Bash(*land/*/start*)'

test('the built claude command carries the deny list, and a normal step has none', async () => {
  const denied = await realEngineResolver({ engine: 'claude', prompt: 'p', disallowedTools: recoverGraph().nodes[0]!.denyTools })
  const flag = denied.args.indexOf('--disallowedTools')
  expect(flag).toBeGreaterThan(-1)
  expect(denied.args[flag + 1]).toBe(DENIED)
  const normal = await realEngineResolver({ engine: 'claude', prompt: 'p' })
  expect(normal.args).not.toContain('--disallowedTools')
})

test('a deny list on an engine that cannot enforce it refuses to start', async () => {
  await expect(realEngineResolver({ engine: 'codex', prompt: 'p', disallowedTools: ['Bash(kamal:*)'] })).rejects.toThrow('codex cannot enforce a deny list')
  expect((await realEngineResolver({ engine: 'codex', prompt: 'p', disallowedTools: [] })).args).toContain('--dangerously-bypass-approvals-and-sandbox')
})

const outage = { engine: 'claude', reason: 'usage limit', until: null }

test('an outage on a stage recovery run spends no attempt and fails the card with the outage, and three in a row never read as attempts', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', await failing())])
  for (let round = 0; round < 3; round += 1) {
    await h.settle(h.item(id).currentRunId!, 'blocked', [], { unavailable: outage, attempts: [], error: 'claude unavailable: usage limit' })
    const failed = h.item(id)
    expect(failed.state).toBe('failed')
    expect(failed.currentRunId).toBeNull()
    expect(failed.error!.split('\n')[0]).toBe('claude unavailable: usage limit')
    expect(failed.error).toContain('uat failed (exit 3)')
    expect(failed.error).not.toContain('recovery attempts')
    expect(failed.land?.recover?.attempts).toBe(0)
    await h.engine.retryStage(id)
    await h.engine.landIdle()
    expect(h.item(id).land?.recover?.attempts).toBe(1)
  }
  expect(h.alerts.slice(0, 3)).toEqual(['claude unavailable: usage limit', 'claude unavailable: usage limit', 'claude unavailable: usage limit'])
})

test('an outage on a build recovery run spends no attempt and leaves the run resumable', async () => {
  const h = harness()
  const id = await failedBuild(h)
  await h.settle('run-2', 'blocked', [], { unavailable: outage, attempts: [], error: 'claude unavailable: usage limit' })
  const failed = h.item(id)
  expect(failed.state).toBe('failed')
  expect(failed.error!.split('\n')[0]).toBe('claude unavailable: usage limit')
  expect(failed.error).toContain('Execute failed')
  expect(failed.error).not.toContain('recovery attempts')
  expect(failed.resumeRunId).toBe('run-1')
  expect(failed.recoverBuild?.attempts).toBe(0)
  expect(h.started).toHaveLength(2)
})

test('an untagged or biz: question from a recovery run goes to the owner with no attempt spent, and never to the card', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', await failing())])
  await h.settle('run-2', 'blocked', ['Which key file should I link?', 'biz: ควรใช้ราคาไหน', 'tech: Which port?'])
  expect(h.item(id)).toMatchObject({ state: 'waiting-info', askedIn: 'shikidan', questions: ['Which key file should I link?', 'ควรใช้ราคาไหน', 'Which port?'] })
  expect(h.posted).toEqual([])
  expect(h.started).toHaveLength(2)
})

test('a blocked recovery run with no evidence spends an attempt and tries again', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', await failing())])
  await h.settle('run-2', 'blocked', ['   '])
  expect(h.item(id)).toMatchObject({ state: 'landing', land: { recover: { attempts: 2, runId: 'run-3' } } })
})

test('the recovery request says why a stage could not start, with its command line', async () => {
  const h = harness()
  const missing = join(dir, 'bin', 'missing-binary')
  await h.ship([stage('uat', missing, { command: { command: missing, args: ['--env', 'uat'], timeoutSeconds: 30 } })])
  const { request } = h.started.at(-1)!
  expect(request).toContain('Why it failed: uat failed to start:')
  expect(request).toContain(`Stage command: ${missing} --env uat`)
})

test('the recovery request says a stage timed out', async () => {
  const h = harness()
  const slow = await script('slow.sh', 'sleep 30')
  await h.ship([stage('uat', slow, { command: { command: slow, args: [], timeoutSeconds: 1 } })])
  const { request } = h.started.at(-1)!
  expect(request).toContain('Why it failed: uat failed (timed out after 1s)')
  expect(request).toContain(`Stage command: ${slow}`)
}, 20_000)

test('one long log line is capped at 4000 characters in the stored reason and the error, keeping its tail', async () => {
  const h = harness()
  const long = await script('long.sh', 'head -c 200000 /dev/zero | tr "\\0" x\necho the-end\nexit 3')
  const id = await h.ship([stage('uat', long)])
  const reason = h.item(id).land!.recover!.reason
  expect(reason.length).toBeLessThanOrEqual(4100)
  expect(reason).toContain('the-end')
  await h.engine.stop(id)
  await h.engine.kick()
  expect(h.item(id).state).toBe('failed')
})

test('a stop during the stage leaves recoverStage with nothing to do', async () => {
  const h = harness()
  const gate = join(dir, 'gate')
  const held = await script('held.sh', `touch ${dir}/started\nwhile [ ! -f ${gate} ]; do sleep 0.02; done\nexit 3`)
  const added = await h.engine.add({ source: 'clickup-board', externalId: '1', repo: '/repo' })
  const runId = h.item(added.id).currentRunId!
  const done: RunView = { ...h.runs.get(runId)!, status: 'done', workflow: { land: [stage('uat', held)] } }
  h.runs.set(runId, done)
  await h.engine.onRunSettled(done)
  while (!await Bun.file(join(dir, 'started')).exists()) await Bun.sleep(10)
  await h.engine.stop(added.id)
  await writeFile(gate, '')
  await h.engine.landIdle()
  expect(h.started).toHaveLength(1)
  expect(h.item(added.id)).toMatchObject({ state: 'failed', error: 'Stopped by you during uat' })
})

const interruptedAttempt = { nodeId: 'n', number: 0, jobId: 'j1', status: 'settled' as const, prompt: '', startedAt: 1, endedAt: 2, interrupted: true as const, result: { outcome: 'blocked' as const, summary: 'Interrupted before it finished', evidence: [] }, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [] }

test('a build run interrupted by a restart starts no recovery run at boot and stays resumable', async () => {
  const h = harness()
  const added = await h.engine.add({ source: 'clickup-board', externalId: '1', repo: '/repo' })
  const runId = h.item(added.id).currentRunId!
  h.runs.set(runId, { ...h.runs.get(runId)!, status: 'blocked', error: 'Interrupted transition or acceptance check; inspect evidence before retrying', attempts: [interruptedAttempt] })
  await h.engine.recover()
  expect(h.started).toHaveLength(1)
  expect(h.item(added.id)).toMatchObject({ state: 'failed', resumeRunId: runId, error: 'Interrupted transition or acceptance check; inspect evidence before retrying' })
})

test('a build run that failed while Shikidan was down starts no recovery run at boot', async () => {
  const h = harness()
  const added = await h.engine.add({ source: 'clickup-board', externalId: '1', repo: '/repo' })
  const runId = h.item(added.id).currentRunId!
  const attempt = { ...interruptedAttempt, interrupted: undefined, result: { outcome: 'fail' as const, summary: 's', evidence: ['tests are red'] } }
  h.runs.set(runId, { ...h.runs.get(runId)!, status: 'failed', error: 'Execute failed', attempts: [attempt] })
  await h.engine.recover()
  expect(h.started).toHaveLength(1)
  expect(h.item(added.id)).toMatchObject({ state: 'failed', resumeRunId: runId, error: 'Execute failed' })
})

test('a build recovery run that settled while Shikidan was down neither retries nor starts another at boot', async () => {
  const h = harness()
  const id = await failedBuild(h)
  h.runs.set('run-2', { ...h.runs.get('run-2')!, status: 'done' })
  await h.engine.recover()
  expect(h.started).toHaveLength(2)
  expect(h.retried).toEqual([])
  expect(h.item(id)).toMatchObject({ state: 'failed', resumeRunId: 'run-1' })
})

test('after boot a build run that fails still gets its recovery', async () => {
  const h = harness()
  await h.engine.recover()
  const id = await failedBuild(h)
  expect(h.item(id)).toMatchObject({ state: 'building', recoverBuild: { attempts: 1 } })
})

test('an interrupted last attempt or a run no agent reported on starts no recovery outside boot either', async () => {
  const h = harness()
  const added = await h.engine.add({ source: 'clickup-board', externalId: 'a', repo: '/repo' })
  await h.settle(h.item(added.id).currentRunId!, 'blocked', [], { attempts: [interruptedAttempt], error: 'Interrupted' })
  expect(h.item(added.id)).toMatchObject({ state: 'failed', error: 'Interrupted', resumeRunId: 'run-1' })
  const other = await h.engine.add({ source: 'clickup-board', externalId: 'b', repo: '/repo' })
  await h.settle(h.item(other.id).currentRunId!, 'blocked', [], { attempts: [], error: 'Implementation requires a successfully verified plan' })
  expect(h.item(other.id)).toMatchObject({ state: 'failed', error: 'Implementation requires a successfully verified plan', resumeRunId: 'run-2' })
  expect(h.started).toHaveLength(2)
})

test('a lost recovery run keeps Resume on the card', async () => {
  const h = harness()
  const id = await failedBuild(h)
  h.runs.delete('run-2')
  await h.engine.recover()
  expect(h.item(id)).toMatchObject({ state: 'failed', error: 'Its run is gone', resumeRunId: 'run-1' })
})

test('a run that settled while Shikidan was down starts its stage once at boot, and the restart does not fail that stage', async () => {
  const h = harness()
  const marker = join(dir, 'stage-runs')
  const slow = await script('slow.sh', `echo ran >> ${marker}\nsleep 0.2\nexit 0`)
  const added = await h.engine.add({ source: 'clickup-board', externalId: '1', repo: '/repo' })
  const runId = h.item(added.id).currentRunId!
  h.runs.set(runId, { ...h.runs.get(runId)!, status: 'done', workflow: { land: [stage('uat', slow)] } })
  await h.engine.recover()
  expect(h.item(added.id)).toMatchObject({ state: 'landing', error: null })
  await h.engine.landIdle()
  expect(h.item(added.id)).toMatchObject({ state: 'landed', error: null })
  expect((await readFile(marker, 'utf8')).trim().split('\n')).toEqual(['ran'])
})

test('a run the runner blocked after the agent passed starts no recovery, because an agent cannot fix that', async () => {
  const h = harness()
  const added = await h.engine.add({ source: 'clickup-board', externalId: '1', repo: '/repo' })
  const passed = { ...interruptedAttempt, interrupted: undefined, result: { outcome: 'pass' as const, summary: 's', evidence: [] } }
  await h.settle('run-1', 'blocked', [], { error: 'A review from another engine family is required', attempts: [passed] })
  expect(h.started).toHaveLength(1)
  expect(h.item(added.id)).toMatchObject({ state: 'failed', resumeRunId: 'run-1', error: 'A review from another engine family is required' })
})

test('a stage that could not start and wrote no log gets a plain line, not a heading with nothing under it', async () => {
  const h = harness()
  await h.ship([stage('uat', join(dir, 'bin', 'missing-binary'))])
  const { request } = h.started.at(-1)!
  expect(request).not.toContain('asking for it:')
  expect(request.trimEnd().endsWith('The stage wrote no log.')).toBe(true)
})
