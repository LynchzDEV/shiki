import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setServerSetting } from '../server/plugins/settings'
import { saveInstalled } from '../server/plugins/store'
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

async function installFixstack(keys: string[]): Promise<void> {
  await saveInstalled({
    id: 'fixstack', name: 'Fixstack', version: '1.0.0', description: 'test', runtime: 'trusted', source: { repo: 'r', ref: 'v1' }, commit: 'c', permissions: {},
    settingsFields: keys.map(key => ({ key, label: key, type: 'text' as const })), enabled: true, installedAt: 'now', updatedAt: 'now',
  })
}

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
    writeContext: async (_pluginId, context, cwd) => join(cwd, `20261102-${context.name}.md`),
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

test('stage env entries resolve from the contributing plugin settings, an unset one is empty and an undeclared one fails the stage', async () => {
  const h = harness()
  const dump = join(dir, 'env.txt')
  const up = await script('up.sh', `echo "$STAGING_LOGIN" > ${dump}`)
  await installFixstack(['stagingLogin', 'absent'])
  await setServerSetting('fixstack', 'stagingLogin', 'hunter2')
  const withSetting = stage('uat', up, { env: { STAGING_LOGIN: 'setting:stagingLogin' } })
  const first = await h.ship([withSetting], '1', 'fixstack')
  await h.engine.landIdle()
  expect(h.item(first).state).toBe('landed')
  expect((await readFile(dump, 'utf8')).trim()).toBe('hunter2')
  const second = await h.ship([stage('uat', up, { env: { STAGING_LOGIN: 'setting:absent' } })], '2', 'fixstack')
  await h.engine.landIdle()
  expect(h.item(second).state).toBe('landed')
  expect((await readFile(dump, 'utf8')).trim()).toBe('')
  const third = await h.ship([stage('uat', up, { env: { STAGING_LOGIN: 'setting:undeclared' } })], '3', 'fixstack')
  await h.engine.landIdle()
  expect(h.item(third)).toMatchObject({ state: 'failed', error: expect.stringContaining('Setting undeclared is not declared by fixstack') })
  expect(JSON.stringify(h.item(third))).not.toContain('hunter2')
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
  const id = await h.ship([stage('uat', slow, { command: { command: slow, args: [], timeoutSeconds: 2 } })])
  await h.engine.landIdle()
  expect(h.item(id)).toMatchObject({ state: 'failed', error: expect.stringContaining('timed out after 2s') })
  const pid = Number((await readFile(pidFile, 'utf8')).trim())
  expect(await goneWithin(pid, 5000)).toBe(true)
})

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { process.kill(pid, 0) } catch { return true }
    await Bun.sleep(50)
  }
  return false
}

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
  expect(h.item(id)).toMatchObject({ state: 'failed', error: expect.stringContaining('Bad uat.json:'), land: { stages: { uat: { status: 'ok' } } } })
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
  await h.store.update(landing.id, { state: 'landing', worktree: dir, runIds: ['r1'], land: { stage: 'uat', stages: { uat: { status: 'running' } }, plan: [stage('uat', ship)], runId: 'r1' } })
  await h.engine.recover()
  expect(h.item(landing.id)).toMatchObject({ state: 'failed', error: 'Shikidan restarted during uat; use Retry stage', land: { stages: { uat: { status: 'failed' } } } })
  expect(h.item(waiting).state).toBe('awaiting-stage')
  expect(h.item(landedId).state).toBe('landed')
  await h.engine.retryStage(landing.id)
  await h.engine.landIdle()
  expect(h.item(landing.id).state).toBe('landed')
})

test('remove while a stage command runs kills it and deletes the item without a failed step', async () => {
  const h = harness()
  const gate = join(dir, 'gate')
  const slow = await script('slow.sh', `touch ${dir}/started\nwhile [ ! -f ${gate} ]; do sleep 0.02; done`)
  const id = await h.ship([stage('uat', slow)])
  await until(() => Bun.file(join(dir, 'started')).exists())
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await h.engine.remove(id)
    await h.engine.landIdle()
    expect(errors).not.toHaveBeenCalled()
  } finally { errors.mockRestore() }
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
  await h.store.update(id, { state: 'failed', land: { ...h.item(id).land!, stages: { uat: { status: 'failed' } } }, answerPaths: ['/w/.shikidan/queue/clickup/1-answers.md', '/w/.shikidan/queue/clickup/20261101-pick.md', '/w/.shikidan/queue/clickup/20261102-pick.md', '/w/.shikidan/queue/clickup/20261103-whitepick.md'] })
  await h.engine.retryStage(id)
  await h.engine.landIdle()
  expect((await readFile(dump, 'utf8')).trim()).toBe('/w/.shikidan/queue/clickup/20261102-pick.md')
})

test('retrying a failed button stage goes back to awaiting confirmation with a fresh preflight instead of deploying', async () => {
  const h = harness()
  const prodRuns = join(dir, 'prod-runs')
  const flightRuns = join(dir, 'flight-runs')
  const prod = await script('prod.sh', `echo x >> ${prodRuns}\nexit 1`)
  const flight = await script('flight.sh', `echo y >> ${flightRuns}\necho ok`)
  const id = await h.ship([button('prod', prod, flight)])
  await h.engine.startStage(id, 'prod')
  await h.engine.landIdle()
  expect(h.item(id).state).toBe('failed')
  await h.engine.retryStage(id)
  await h.engine.landIdle()
  expect(h.item(id)).toMatchObject({ state: 'awaiting-stage', error: null, land: { stage: 'prod', stages: { prod: { status: 'waiting' } } } })
  expect((await readFile(prodRuns, 'utf8')).trim().split('\n')).toHaveLength(1)
  expect((await readFile(flightRuns, 'utf8')).trim().split('\n')).toHaveLength(3)
})

test('a button stage marked failed by a restart also needs a new confirmation on retry', async () => {
  const h = harness()
  const prodRuns = join(dir, 'prod-runs')
  const prod = await script('prod.sh', `echo x >> ${prodRuns}`)
  const id = await h.ship([button('prod', prod)])
  await h.store.update(id, { state: 'landing', land: { ...h.item(id).land!, stages: { prod: { status: 'running' } } } })
  await h.engine.recover()
  expect(h.item(id).land!.stages.prod!.status).toBe('failed')
  await h.engine.retryStage(id)
  await h.engine.landIdle()
  expect(h.item(id).state).toBe('awaiting-stage')
  expect(await Bun.file(prodRuns).exists()).toBe(false)
})

test('a rebuild after a failed stage drops the old land state and Retry refuses until a passing run lands again', async () => {
  const h = harness()
  const prodRuns = join(dir, 'uat-runs')
  const uat = await script('uat.sh', `echo x >> ${prodRuns}\nexit 1`)
  const id = await h.ship([stage('uat', uat)])
  await h.engine.landIdle()
  expect(h.item(id).land!.runId).toBe('run-1')
  await h.engine.requeue(id)
  expect(h.item(id).land).toBeUndefined()
  const rebuild = h.item(id).currentRunId!
  h.runs.set(rebuild, { ...h.runs.get(rebuild)!, status: 'failed', error: 'build broke' })
  await h.engine.onRunSettled(h.runs.get(rebuild)!)
  expect(h.item(id).state).toBe('failed')
  await expect(h.engine.retryStage(id)).rejects.toThrow('There is no stage to retry')
  expect((await readFile(prodRuns, 'utf8')).trim().split('\n')).toHaveLength(1)
})

test('retry refuses a failed stage whose run is no longer the latest', async () => {
  const h = harness()
  const uat = await script('uat.sh', 'exit 1')
  const id = await h.ship([stage('uat', uat)])
  await h.engine.landIdle()
  await h.store.update(id, { runIds: [...h.item(id).runIds, 'run-9'] })
  await expect(h.engine.retryStage(id)).rejects.toMatchObject({ message: 'This item was rebuilt since that stage; it lands again after a passing run', status: 409 })
})

test('a queue file saved before runId existed still loads', async () => {
  const h = harness()
  const uat = await script('uat.sh', 'exit 0')
  const id = await h.ship([button('prod', uat)])
  const saved = JSON.parse(await readFile(join(dir, 'queue.json'), 'utf8'))
  delete saved.items[0].land.runId
  await writeFile(join(dir, 'queue.json'), JSON.stringify(saved))
  expect(createQueueStore(join(dir, 'queue.json')).get(id)).toMatchObject({ state: 'awaiting-stage' })
})

test('a stage secret echoed by the stage never reaches the stored error, the stored preflight or the log route', async () => {
  const h = harness()
  await installFixstack(['stagingLogin'])
  await setServerSetting('fixstack', 'stagingLogin', 'hunter2-hunter2')
  const leaky = await script('leaky.sh', 'echo "login is $STAGING_LOGIN"\nexit 1')
  const flight = await script('flight.sh', 'echo "using $STAGING_LOGIN"')
  const env = { STAGING_LOGIN: 'setting:stagingLogin' }
  const failed = await h.ship([stage('uat', leaky, { env })], '1', 'fixstack')
  await h.engine.landIdle()
  expect(h.item(failed).error).toContain('login is [REDACTED]')
  expect(JSON.stringify(h.item(failed))).not.toContain('hunter2-hunter2')
  expect(await h.engine.landLog(failed, 'uat')).toBe('login is [REDACTED]\n')
  expect((await readFile(landLogPath(failed, 'uat'), 'utf8'))).toContain('hunter2-hunter2')
  const waiting = await h.ship([button('prod', leaky, flight, { env })], '2', 'fixstack')
  expect(h.item(waiting).land!.stages.prod!.preflight!.markdown).toBe('using [REDACTED]\n')
  expect(JSON.stringify(h.item(waiting))).not.toContain('hunter2-hunter2')
})

test('the log route serves only the last 256 KB of a big log', async () => {
  const h = harness()
  const noisy = await script('noisy.sh', `head -c 400000 /dev/zero | tr '\\0' 'a'\necho\necho the-end`)
  const id = await h.ship([stage('uat', noisy)])
  await h.engine.landIdle()
  const served = await h.engine.landLog(id, 'uat')
  expect(Buffer.byteLength(served)).toBe(256 * 1024)
  expect(served.endsWith('the-end\n')).toBe(true)
})

test('a stage json planted before the stage runs is not posted', async () => {
  const h = harness()
  const quiet = await script('quiet.sh', 'true')
  const added = await h.engine.add({ source: 'clickup-board', externalId: '1', repo: '/repo' })
  const landDir = join(h.item(added.id).worktree!, '.mission-control', 'land')
  await mkdir(landDir, { recursive: true })
  await writeFile(join(landDir, 'uat.json'), JSON.stringify({ post: { kind: 'update', lines: ['planted by the agent'] } }))
  await h.finish(h.item(added.id).currentRunId!, [stage('uat', quiet)])
  await h.engine.landIdle()
  expect(h.item(added.id).state).toBe('landed')
  expect(h.posted).toEqual([])
})

test('a symlinked stage report is left out of the item report', async () => {
  const h = harness()
  const outside = join(dir, 'outside.txt')
  await writeFile(outside, 'TOP-SECRET-VALUE')
  const id = await h.ship([button('prod', await script('ship.sh', 'true'))])
  const landDir = join(h.item(id).worktree!, '.mission-control', 'land')
  await mkdir(landDir, { recursive: true })
  await symlink(outside, join(landDir, 'prod.md'))
  expect(await h.engine.report(id)).not.toContain('TOP-SECRET-VALUE')
})

test('a preflight that leaves a background child holding its output returns promptly', async () => {
  const h = harness()
  const flight = await script('flight.sh', 'echo ok\nsleep 30 &')
  const started = Date.now()
  const id = await h.ship([button('prod', await script('ship.sh', 'true'), flight)])
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(h.item(id).land!.stages.prod!.preflight).toEqual({ exitCode: 0, markdown: 'ok\n' })
})

test('two items with different repos under the same folder take turns', async () => {
  const h = harness()
  const log = join(dir, 'folder-turns')
  const slow = await script('slow.sh', `echo start >> ${log}\nsleep 0.3\necho end >> ${log}`)
  const plan = [button('prod', slow)]
  const park = async (externalId: string, repo: string) => {
    const added = await h.store.add({ source: 'clickup-board', externalId, title: externalId, url: 'u', repo: '/work', repos: [repo], flowId: null }, 'end')
    await h.store.update(added.id, { state: 'awaiting-stage', worktree: dir, runIds: ['r'], land: { stage: 'prod', stages: { prod: { status: 'waiting', preflight: { exitCode: 0, markdown: '' } } }, plan, runId: 'r' } })
    return added.id
  }
  const first = await park('1', 'api')
  const second = await park('2', 'portal')
  await h.engine.startStage(first, 'prod')
  await h.engine.startStage(second, 'prod')
  await h.engine.landIdle()
  expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['start', 'end', 'start', 'end'])
})

test('after a bad stage json, retry posts the fixed file without running the stage again', async () => {
  const h = harness()
  const runs = join(dir, 'runs')
  const bad = await script('bad.sh', `echo ran >> ${runs}\necho '{bad' > "$SKD_LAND_DIR/uat.json"`)
  const id = await h.ship([stage('uat', bad)])
  await h.engine.landIdle()
  expect(h.item(id)).toMatchObject({ state: 'failed', error: expect.stringContaining('Bad uat.json') })
  await writeFile(join(h.item(id).worktree!, '.mission-control', 'land', 'uat.json'), JSON.stringify({ post: { kind: 'update', lines: ['fixed'] } }))
  await h.engine.retryStage(id)
  await h.engine.landIdle()
  expect(h.item(id).state).toBe('landed')
  expect((await readFile(runs, 'utf8')).trim().split('\n')).toEqual(['ran'])
  expect(h.posted).toHaveLength(1)
})

test('a post warning is stored on the stage, shown in the report and raised, and the item still lands', async () => {
  const h = harness({ post: async () => ({ commentId: 'c1', warning: 'Status not set: no such status\nsee settings' }) })
  const first = await script('first.sh', `printf '{"post":{"kind":"update","lines":["UAT is live"]}}' > "$SKD_LAND_DIR/uat.json"`)
  const id = await h.ship([stage('uat', first)])
  await h.engine.landIdle()
  expect(h.item(id)).toMatchObject({ state: 'landed', land: { stages: { uat: { posted: 'c1', warning: 'Status not set: no such status\nsee settings' } } } })
  expect(h.alerts.map(alert => alert.reason)).toContain('uat posted with a warning: Status not set: no such status')
  expect(await h.engine.report(id)).toContain('Warning: Status not set: no such status\nsee settings')
})

test('stop kills a running stage command and fails the item at that stage, and Retry stage starts it again', async () => {
  const h = harness()
  const marker = join(dir, 'after-sleep')
  const slow = await script('slow', `touch ${dir}/started\nsleep 5\ntouch ${marker}`)
  const id = await h.ship([stage('deploy', slow)])
  await until(() => Bun.file(join(dir, 'started')).exists())
  await h.engine.stop(id)
  expect(h.item(id)).toMatchObject({ state: 'failed', error: 'Stopped by you during deploy' })
  expect(h.item(id).land!.stages.deploy).toMatchObject({ status: 'failed' })
  await h.engine.landIdle()
  expect(h.item(id)).toMatchObject({ state: 'failed', error: 'Stopped by you during deploy' })
  await expect(stat(marker)).rejects.toThrow()
  expect((await h.engine.retryStage(id)).state).toBe('landing')
  await h.engine.stop(id)
  await h.engine.landIdle()
  expect(h.item(id).state).toBe('failed')
})

test('stop refuses an item waiting for its stage button', async () => {
  const h = harness()
  const id = await h.ship([button('prod', await script('prod', 'exit 0'))])
  expect(h.item(id).state).toBe('awaiting-stage')
  await expect(h.engine.stop(id)).rejects.toThrow('It is awaiting-stage now')
})
