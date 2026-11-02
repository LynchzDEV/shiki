import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setServerSetting } from '../server/plugins/settings'
import { createQueueEngine, QueueRefusal, type QueueEngineDeps } from '../server/queue-engine'
import { landLogPath } from '../server/queue-land'
import type { RunView } from '../server/queue-prompts'
import type { QueueSource } from '../server/queue-source'
import { createQueueStore } from '../server/queue-store'
import type { LandStage } from '../server/workflows'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-queue-land-'))
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
const button = (id: string, command: string, preflight?: string, over: Partial<LandStage> = {}): LandStage =>
  stage(id, command, { run: 'button', label: 'Deploy prod', ...(preflight === undefined ? {} : { preflight: { command: preflight, args: [], timeoutSeconds: 30 } }), ...over })

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error('condition never held')
}

function harness(sourceOver: Partial<QueueSource> = {}) {
  const store = createQueueStore(join(dir, 'queue.json'))
  const runs = new Map<string, RunView>()
  const posted: Array<Parameters<QueueSource['post']>[0]> = []
  const alerts: Array<{ title: string; reason: string; state: string }> = []
  let next = 0
  const source: QueueSource = {
    item: async ({ id }) => ({ title: `Task ${id}`, url: `https://x/t/${id}`, contextMarkdown: `# ${id}` }),
    post: async (input) => { posted.push(input); return { commentId: `c${posted.length}` } },
    replies: async () => ({ replies: [], lastId: null }),
    ...sourceOver,
  }
  const deps: QueueEngineDeps = {
    store,
    runner: { start: async () => { const id = `run-${++next}`; runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } }, get: id => runs.get(id) },
    source: () => source,
    prepareWorktree: async (repo, label) => { const worktree = join(dir, 'wt', label); await mkdir(worktree, { recursive: true }); return { worktree } },
    writeContext: async (pluginId, context, cwd) => join(cwd, `${pluginId}-${context.name}.md`),
    pluginFiles: pluginId => join(dir, 'plugin-data', pluginId),
    backupDir: itemId => join(dir, 'queue-files', itemId),
    needsYou: (item, reason) => { alerts.push({ title: item.title, reason, state: item.state }) },
  }
  const engine = createQueueEngine(deps)
  const finish = async (runId: string, land: LandStage[], plugin?: string) => {
    const done: RunView = { ...runs.get(runId)!, status: 'done', workflow: { land, ...(plugin === undefined ? {} : { plugin }) } }
    runs.set(runId, done)
    await engine.onRunSettled(done)
  }
  const item = (id: string) => store.get(id)!
  const ship = async (land: LandStage[], externalId = '1', plugin?: string) => {
    const added = await engine.add({ source: 'clickup-board', externalId, repo: '/repo' })
    await finish(added.currentRunId ?? store.get(added.id)!.currentRunId!, land, plugin)
    return added.id
  }
  return { engine, store, posted, alerts, item, ship, finish, runs }
}

test('a done run whose flow has no land stages is ready, as before', async () => {
  const h = harness()
  const id = await h.ship([])
  expect(h.item(id)).toMatchObject({ state: 'ready', error: null })
  expect(h.item(id).land).toBeUndefined()
})

test('an auto stage runs on the host with the item environment and its log is private', async () => {
  const h = harness()
  const dump = join(dir, 'env.txt')
  const gate = join(dir, 'gate')
  const up = await script('up.sh', `env > ${dump}\ntouch ${dir}/started\nwhile [ ! -f ${gate} ]; do sleep 0.02; done\necho shipped`)
  const id = await h.ship([stage('uat', up)])
  await until(() => Bun.file(join(dir, 'started')).exists())
  expect(h.item(id)).toMatchObject({ state: 'landing', land: { stage: 'uat', stages: { uat: { status: 'running' } } } })
  await writeFile(gate, '')
  await h.engine.landIdle()
  const done = h.item(id)
  expect(done).toMatchObject({ state: 'landed', land: { stages: { uat: { status: 'ok', exitCode: 0 } } } })
  expect(h.alerts.at(-1)).toMatchObject({ reason: 'Landed', state: 'landed' })
  const env = await readFile(dump, 'utf8')
  for (const line of [`SKD_ITEM_ID=${id}`, `SKD_WORKSPACE=${done.worktree}`, 'SKD_REPOS=repo', 'SKD_REPO_ROOT=/repo', 'SKD_ITEM_URL=https://x/t/1', 'SKD_RUN_ID=run-1', 'SKD_STAGE=uat', `SKD_LAND_DIR=${done.worktree}/.mission-control/land`, 'SKD_PICK_FILE=']) expect(env).toContain(`${line}\n`)
  expect(env).toContain(`PATH=${process.env.PATH}\n`)
  expect(((await stat(landLogPath(id, 'uat'))).mode & 0o777).toString(8)).toBe('600')
  expect((await readFile(landLogPath(id, 'uat'), 'utf8')).trim()).toBe('shipped')
  expect(((await stat(join(done.worktree!, '.mission-control', 'land'))).mode & 0o777).toString(8)).toBe('700')
})

test('stage env entries resolve from the contributing plugin settings and a missing one fails the stage without leaking values', async () => {
  const h = harness()
  const dump = join(dir, 'env.txt')
  const up = await script('up.sh', `echo "$STAGING_LOGIN" > ${dump}`)
  await setServerSetting('fixstack', 'stagingLogin', 'hunter2')
  const withSetting = stage('uat', up, { env: { STAGING_LOGIN: 'setting:stagingLogin' } })
  const first = await h.ship([withSetting], '1', 'fixstack')
  await h.engine.landIdle()
  expect(h.item(first).state).toBe('landed')
  expect((await readFile(dump, 'utf8')).trim()).toBe('hunter2')
  const second = await h.ship([stage('uat', up, { env: { STAGING_LOGIN: 'setting:absent' } })], '2', 'fixstack')
  await h.engine.landIdle()
  expect(h.item(second)).toMatchObject({ state: 'failed', error: expect.stringContaining('Setting absent of fixstack is not set') })
  expect(JSON.stringify(h.item(second))).not.toContain('hunter2')
})

test('a non-zero exit fails the item with the last 40 log lines', async () => {
  const h = harness()
  const bad = await script('bad.sh', 'i=1; while [ $i -le 50 ]; do echo "line $i"; i=$((i+1)); done\nexit 3')
  const id = await h.ship([stage('uat', bad)])
  await h.engine.landIdle()
  const failed = h.item(id)
  expect(failed.state).toBe('failed')
  expect(failed.error).toContain('uat failed (exit 3)')
  expect(failed.error).toContain('line 50')
  expect(failed.error).toContain('line 11')
  expect(failed.error).not.toContain('line 10')
  expect(failed.land).toMatchObject({ stage: 'uat', stages: { uat: { status: 'failed', exitCode: 3 } } })
  expect(h.alerts.at(-1)).toMatchObject({ reason: 'uat failed (exit 3)', state: 'failed' })
})

test('a command that cannot start fails the stage', async () => {
  const h = harness()
  const id = await h.ship([stage('uat', join(dir, 'missing.sh'))])
  await h.engine.landIdle()
  expect(h.item(id)).toMatchObject({ state: 'failed', error: expect.stringContaining('uat failed to start') })
})

test('a timeout kills the whole process group', async () => {
  const h = harness()
  const pidFile = join(dir, 'child.pid')
  const slow = await script('slow.sh', `sleep 60 &\necho $! > ${pidFile}\nwait`)
  const id = await h.ship([stage('uat', slow, { command: { command: slow, args: [], timeoutSeconds: 1 } })])
  await h.engine.landIdle()
  expect(h.item(id)).toMatchObject({ state: 'failed', error: expect.stringContaining('timed out after 1s') })
  const pid = Number((await readFile(pidFile, 'utf8')).trim())
  expect(() => process.kill(pid, 0)).toThrow()
})

test('stage output can post an update once; later stages and retries do not post it again', async () => {
  const h = harness()
  const first = await script('first.sh', `printf '{"post":{"kind":"update","lines":["UAT is live"],"mention":"ann","status":"in review"}}' > "$SKD_LAND_DIR/uat.json"`)
  const flaky = await script('flaky.sh', `if [ -f ${dir}/second-ok ]; then exit 0; fi\nexit 1`)
  const id = await h.ship([stage('uat', first), stage('smoke', flaky)])
  await h.engine.landIdle()
  expect(h.posted).toEqual([{ id: '1', kind: 'update', lines: ['UAT is live'], mention: 'ann', status: 'in review' }])
  expect(h.item(id)).toMatchObject({ state: 'failed', land: { stage: 'smoke', stages: { uat: { status: 'ok', posted: 'c1' } } } })
  await writeFile(join(dir, 'second-ok'), '')
  await h.engine.retryStage(id)
  await h.engine.landIdle()
  expect(h.item(id).state).toBe('landed')
  expect(h.posted).toHaveLength(1)
})

test('a bad stage json fails the stage and nothing is posted', async () => {
  const h = harness()
  const bad = await script('bad-json.sh', `echo '{"post":{"kind":"update","lines":[]}}' > "$SKD_LAND_DIR/uat.json"`)
  const id = await h.ship([stage('uat', bad)])
  await h.engine.landIdle()
  expect(h.item(id)).toMatchObject({ state: 'failed', error: expect.stringContaining('Bad uat.json:'), land: { stages: { uat: { status: 'failed' } } } })
  const notJson = await script('not-json.sh', `echo nope > "$SKD_LAND_DIR/uat.json"`)
  const other = await h.ship([stage('uat', notJson)], '2')
  await h.engine.landIdle()
  expect(h.item(other).error).toContain('Bad uat.json:')
  expect(h.posted).toEqual([])
})

test('when only the post fails, retry posts again without running the stage again', async () => {
  let attempts = 0
  const h = harness({ post: async (input) => { attempts += 1; if (attempts === 1) throw new Error('ClickUp is down'); h.posted.push(input); return { commentId: 'late' } } })
  const runs = join(dir, 'runs')
  const first = await script('first.sh', `echo ran >> ${runs}\nprintf '{"post":{"kind":"update","lines":["done"]}}' > "$SKD_LAND_DIR/uat.json"`)
  const id = await h.ship([stage('uat', first)])
  await h.engine.landIdle()
  expect(h.item(id)).toMatchObject({ state: 'failed', error: 'uat ran but posting failed: ClickUp is down', land: { stages: { uat: { status: 'ok' } } } })
  await h.engine.retryStage(id)
  await h.engine.landIdle()
  expect(h.item(id)).toMatchObject({ state: 'landed', land: { stages: { uat: { posted: 'late' } } } })
  expect((await readFile(runs, 'utf8')).trim().split('\n')).toEqual(['ran'])
})

test('retry runs a failed stage again, and refuses when there is nothing to retry', async () => {
  const h = harness()
  const flaky = await script('flaky.sh', `if [ -f ${dir}/fixed ]; then exit 0; fi\nexit 1`)
  const id = await h.ship([stage('uat', flaky)])
  await h.engine.landIdle()
  expect(h.item(id).state).toBe('failed')
  await writeFile(join(dir, 'fixed'), '')
  expect(await h.engine.retryStage(id)).toMatchObject({ state: 'landing', error: null })
  await h.engine.landIdle()
  expect(h.item(id).state).toBe('landed')
  await expect(h.engine.retryStage(id)).rejects.toThrow('There is no stage to retry')
})

test('a button stage runs its preflight and waits for a person', async () => {
  const h = harness()
  const check = await script('check.sh', 'printf "| repo | ahead |\\n|---|---|\\n| api | 2 |\\n\\nSafety: prod"')
  const ship = await script('ship.sh', `touch ${dir}/shipped`)
  const id = await h.ship([button('prod', ship, check)])
  await h.engine.landIdle()
  expect(h.item(id)).toMatchObject({ state: 'awaiting-stage', land: { stage: 'prod', stages: { prod: { status: 'waiting', preflight: { exitCode: 0, markdown: '| repo | ahead |\n|---|---|\n| api | 2 |\n\nSafety: prod' } } } } })
  expect(h.alerts.at(-1)).toMatchObject({ reason: 'Deploy prod is ready', state: 'awaiting-stage' })
  expect(await Bun.file(join(dir, 'shipped')).exists()).toBe(false)
})

test('a button stage without a preflight waits with an empty, passing preflight', async () => {
  const h = harness()
  const ship = await script('ship.sh', 'exit 0')
  const id = await h.ship([button('prod', ship)])
  expect(h.item(id)).toMatchObject({ state: 'awaiting-stage', land: { stages: { prod: { preflight: { exitCode: 0, markdown: '' } } } } })
})

test('starting a button stage ships it after the preflight is checked again', async () => {
  const h = harness()
  const check = await script('check.sh', 'echo "all clear"')
  const ship = await script('ship.sh', `touch ${dir}/shipped`)
  const id = await h.ship([button('prod', ship, check)])
  expect(await h.engine.startStage(id, 'prod')).toMatchObject({ state: 'landing' })
  await h.engine.landIdle()
  expect(h.item(id).state).toBe('landed')
  expect(await Bun.file(join(dir, 'shipped')).exists()).toBe(true)
})

test('starting a stage is refused in the wrong state, for the wrong stage, or when the preflight blocks', async () => {
  const h = harness()
  const blocked = await script('blocked.sh', 'echo "behind main"\nexit 2')
  const ship = await script('ship.sh', `touch ${dir}/shipped`)
  const id = await h.ship([button('prod', ship, blocked)])
  expect(h.item(id).land!.stages.prod!.preflight).toEqual({ exitCode: 2, markdown: 'behind main\n' })
  await expect(h.engine.startStage(id, 'prod')).rejects.toThrow('Preflight blocked this stage')
  await expect(h.engine.startStage(id, 'other')).rejects.toThrow('It is not waiting for other')
  await expect(h.engine.startStage('nope', 'prod')).rejects.toBeInstanceOf(QueueRefusal)
  const plain = await h.ship([stage('uat', ship)], '2')
  await h.engine.landIdle()
  await expect(h.engine.startStage(plain, 'uat')).rejects.toThrow('It is landed now')
  expect(await Bun.file(join(dir, 'shipped')).exists()).toBe(true)
})

test('starting is refused and the new preflight stored when it changed since it was shown', async () => {
  const h = harness()
  const check = await script('check.sh', `n=$(cat ${dir}/count 2>/dev/null || echo 0)\necho $((n+1)) > ${dir}/count\necho "ahead by $n"`)
  const ship = await script('ship.sh', 'exit 0')
  const id = await h.ship([button('prod', ship, check)])
  expect(h.item(id).land!.stages.prod!.preflight!.markdown).toBe('ahead by 0\n')
  await expect(h.engine.startStage(id, 'prod')).rejects.toThrow('Preflight changed, review it again')
  expect(h.item(id)).toMatchObject({ state: 'awaiting-stage', land: { stages: { prod: { preflight: { markdown: 'ahead by 1\n' } } } } })
})

test('refreshing re-runs the preflight and stores the result', async () => {
  const h = harness()
  const check = await script('check.sh', `if [ -f ${dir}/ok ]; then echo ready; exit 0; fi\necho waiting\nexit 1`)
  const ship = await script('ship.sh', 'exit 0')
  const id = await h.ship([button('prod', ship, check)])
  expect(h.item(id).land!.stages.prod!.preflight).toEqual({ exitCode: 1, markdown: 'waiting\n' })
  await writeFile(join(dir, 'ok'), '')
  const refreshed = await h.engine.refreshPreflight(id, 'prod')
  expect(refreshed.land!.stages.prod!.preflight).toEqual({ exitCode: 0, markdown: 'ready\n' })
  await expect(h.engine.refreshPreflight(id, 'uat')).rejects.toThrow('It is not waiting for uat')
})

test('a stage chain runs in order: auto, then a button that waits, then lands', async () => {
  const h = harness()
  const order = join(dir, 'order')
  const uat = await script('uat.sh', `echo uat >> ${order}`)
  const prod = await script('prod.sh', `echo prod >> ${order}`)
  const id = await h.ship([stage('uat', uat), button('prod', prod)])
  await h.engine.landIdle()
  expect(h.item(id)).toMatchObject({ state: 'awaiting-stage', land: { stage: 'prod', stages: { uat: { status: 'ok' } } } })
  await h.engine.startStage(id, 'prod')
  await h.engine.landIdle()
  expect(h.item(id).state).toBe('landed')
  expect((await readFile(order, 'utf8')).trim().split('\n')).toEqual(['uat', 'prod'])
})

test('two items on the same repo take turns for a stage, and the second says it is waiting', async () => {
  const h = harness()
  const log = join(dir, 'turns')
  const slow = await script('slow.sh', `echo "start $SKD_ITEM_ID" >> ${log}\nsleep 0.4\necho "end $SKD_ITEM_ID" >> ${log}`)
  const first = await h.ship([stage('uat', slow)], '1')
  const second = await h.ship([stage('uat', slow)], '2')
  await until(() => h.item(second).land?.message !== undefined)
  expect(h.item(second).land!.message).toBe('waiting for another item to finish uat')
  await h.engine.landIdle()
  expect(h.item(second)).toMatchObject({ state: 'landed' })
  expect(h.item(second).land!.message).toBeUndefined()
  const lines = (await readFile(log, 'utf8')).trim().split('\n').map(line => line.split(' ')[0])
  expect(lines).toEqual(['start', 'end', 'start', 'end'])
  expect(h.item(first).state).toBe('landed')
})

test('items on different repos do not wait for each other', async () => {
  const h = harness()
  const log = join(dir, 'overlap')
  const slow = await script('slow.sh', `echo "start" >> ${log}\nsleep 0.3\necho "end" >> ${log}`)
  const one = await h.engine.add({ source: 'clickup-board', externalId: '1', repo: '/repo-a' })
  await h.finish(h.store.get(one.id)!.currentRunId!, [stage('uat', slow)])
  const two = await h.engine.add({ source: 'clickup-board', externalId: '2', repo: '/repo-b' })
  await h.finish(h.store.get(two.id)!.currentRunId!, [stage('uat', slow)])
  await h.engine.landIdle()
  expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['start', 'start', 'end', 'end'])
})

test('a restart turns a landing item into a failed one to retry; waiting and landed items stay', async () => {
  const h = harness()
  const ship = await script('ship.sh', 'exit 0')
  const plan = [button('prod', ship)]
  const waiting = await h.ship(plan, '1')
  const landedId = await h.ship([stage('uat', ship)], '2')
  await h.engine.landIdle()
  const landing = await h.store.add({ source: 'clickup-board', externalId: '3', title: 'Task 3', url: 'u', repo: '/repo', flowId: null }, 'end')
  await h.store.update(landing.id, { state: 'landing', worktree: dir, land: { stage: 'uat', stages: { uat: { status: 'running' } }, plan: [stage('uat', ship)] } })
  await h.engine.recover()
  expect(h.item(landing.id)).toMatchObject({ state: 'failed', error: 'Shikidan restarted during uat; use Retry stage', land: { stages: { uat: { status: 'failed' } } } })
  expect(h.item(waiting).state).toBe('awaiting-stage')
  expect(h.item(landedId).state).toBe('landed')
  await h.engine.retryStage(landing.id)
  await h.engine.landIdle()
  expect(h.item(landing.id).state).toBe('landed')
})

test('an item mid-landing cannot be removed, but a waiting one can', async () => {
  const h = harness()
  const gate = join(dir, 'gate')
  const slow = await script('slow.sh', `touch ${dir}/started\nwhile [ ! -f ${gate} ]; do sleep 0.02; done`)
  const id = await h.ship([stage('uat', slow)])
  await until(() => Bun.file(join(dir, 'started')).exists())
  await expect(h.engine.remove(id)).rejects.toThrow('It is landing now')
  await writeFile(gate, '')
  await h.engine.landIdle()
  await h.engine.remove(id)
  expect(h.store.get(id)).toBeUndefined()
})

test('a parked item keeps the stages of the flow that ran, even if the flow changes later', async () => {
  const h = harness()
  const ship = await script('ship.sh', 'exit 0')
  const id = await h.ship([button('prod', ship)])
  expect(h.item(id).land!.plan.map(entry => entry.id)).toEqual(['prod'])
})

test('SKD_PICK_FILE is the answers file ending in pick.md, whatever its stamp', async () => {
  const h = harness()
  const dump = join(dir, 'pick.txt')
  const up = await script('up.sh', `echo "$SKD_PICK_FILE" > ${dump}`)
  const id = await h.ship([stage('uat', up)])
  await h.engine.landIdle()
  expect((await readFile(dump, 'utf8')).trim()).toBe('')
  await h.store.update(id, { state: 'failed', land: { ...h.item(id).land!, stages: { uat: { status: 'failed' } } }, answerPaths: ['/w/.shikidan/queue/clickup/1-answers.md', '/w/.shikidan/queue/clickup/20261102-pick.md'] })
  await h.engine.retryStage(id)
  await h.engine.landIdle()
  expect((await readFile(dump, 'utf8')).trim()).toBe('/w/.shikidan/queue/clickup/20261102-pick.md')
})
