import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { staticPlugin } from '@elysiajs/static'
import { Elysia } from 'elysia'

import { maybeAutoReview } from './auto-review'
import { localRequestAllowed, peerAddress } from './local-access'
import { quotaCache, quotaRoutes } from './routes/quota'
import { createAvailabilityCheck } from './engine-availability'
import { historyRoutes } from './routes/history'
import { createExternalSessionsCache, ownedPids } from './history'
import { CONFIG_DIR_NAME, configDir, LEGACY_CONFIG_DIR_NAME, listenTarget, migrateConfigDir, readConfig, readSecrets } from './secrets'
import { createJobManager } from './jobs'
import { attentionEvents } from './attention-events'
import { createChatFlusher } from './chat-reports'
import { chatQueuePath, createChatQueue } from './chat-queue'
import { threadRootOf } from './threads'
import { redactedTailReader } from './log-redaction'
import { createTerminalRegistry } from './terminals'
import { createTerminalLog } from './terminal-log'
import { realEngineResolver } from './jobs-engine-iface'
import { createWorkflowStore } from './workflows'
import { createWorkflowBuilder } from './workflow-builder'
import { createWorkflowRunner } from './workflow-runner'
import { studioRoutes } from './routes/studio'
import { createRunEvents } from './run-events'
import { jobsRoutes } from './routes/jobs'
import { chatRoutes } from './routes/chat'
import { metaRoutes } from './routes/meta'
import { modelsRoutes } from './routes/models'
import { providersRoutes } from './routes/providers'
import { pluginsRoutes } from './routes/plugins'
import { defaultRuntimes } from './plugins/runtimes'
import { getSetting } from './plugins/settings'
import { isWorktreeOf, prepareWorktree } from './job-worktrees'
import { getInstalled } from './plugins/store'
import { createQueueEngine, type QueueEngine } from './queue-engine'
import { cardImageFiles, writeQueueContext } from './queue-files'
import { pluginSource } from './queue-source'
import { createQueueStore, queuePath } from './queue-store'
import { queueRoutes } from './routes/queue'
import { queueTree } from './queue-tree'
import { prepareRepoWorkspace, registerQueueWorkspaces } from './repo-workspace'
import { terminalsRoutes } from './routes/terminals'
import { outcomesRoutes } from './routes/outcomes'
import { attentionRoutes } from './routes/attention'
import { attentionKey, createAttentionStore } from './attention'
import { raiseQueueAlert, raiseSyncAlert, sweepQueueAlerts, watchQueueAlerts } from './queue-attention'
import { automateOn, statusMaps } from './queue-status'
import { createStatusSync, type StatusSync } from './queue-status-sync'
import { createNotifier } from './notify'
import { publish, publishDir, publishDomain, removeLeftovers, unpublish } from './publish'
import { createNotifyEvents } from './notify-events'
import { notifyRoutes } from './routes/notify'
import type { QueueItem } from './queue-store'
import { createOutcomeLedger, OUTCOME_RETENTION_MS } from './outcomes'
import { createSessionResolver } from './outcome-session'
import { secretsRoutes } from './routes/secrets'
import { flowApprovalRoutes, rolesRoutes } from './routes/roles'
import { claudeSkillsDir, describeSkillInstall, installSkills } from './skill-install'
import { syncEngineAssets } from './engine-assets'
import { listedPluginFlows, refreshAllContributions } from './plugins/contributions'
import { ShellPage } from './views/shell'
import { jobLine, log, requestLine, shouldLogRequest } from './server-log'
import { readEnv } from './env'

const ROOT = resolve(import.meta.dir, '..')
const CLIENT_DIR = join(ROOT, 'client')
const PUBLIC_DIR = join(ROOT, 'public')

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' }
const JS_HEADERS = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }

const MODULE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

type CachedModule = {
  stamp: string
  code: string
  css: string
}

const transpileCache = new Map<string, CachedModule>()

export async function transpileClientModule(requested: string): Promise<string | null> {
  if (!requested.endsWith('.js')) return null
  const name = requested.slice(0, -3)
  if (!MODULE_NAME_PATTERN.test(name)) return null

  let path = join(CLIENT_DIR, `${name}.ts`)
  let info
  try {
    info = await stat(path)
  } catch {
    path = join(CLIENT_DIR, `${name}.tsx`)
    try { info = await stat(path) } catch { return null }
  }
  if (!info.isFile()) return null

  const files = [...new Bun.Glob('*.{ts,tsx}').scanSync(CLIENT_DIR)].sort()
  const stamp = (await Promise.all(files.map(async (file) => { const value = await stat(join(CLIENT_DIR, file)); return `${file}:${value.mtimeMs}:${value.size}` }))).join('|')
  const cached = transpileCache.get(name)
  if (cached !== undefined && cached.stamp === stamp) return cached.code

  const built = await Bun.build({ entrypoints: [path], target: 'browser', write: false, ...(name === 'studio' ? { minify: true, define: { 'process.env.NODE_ENV': '"production"' } } : {}) })
  if (!built.success || built.outputs.length === 0) return null

  const code = await built.outputs.find(output => output.path.endsWith('.js'))!.text()
  const css = await built.outputs.find(output => output.path.endsWith('.css'))?.text() ?? ''
  transpileCache.set(name, { stamp, code, css })
  return code
}

export async function transpileClientStyles(requested: string): Promise<string | null> {
  if (!requested.endsWith('.css')) return null
  const name = requested.slice(0, -4)
  if (!MODULE_NAME_PATTERN.test(name) || await transpileClientModule(`${name}.js`) === null) return null
  return transpileCache.get(name)?.css || null
}

function page(markup: string): Response {
  return new Response(markup, { headers: HTML_HEADERS })
}

function appShellPage(): Response {
  return page(ShellPage({ workspaceDir: homedir() }))
}

const RETIRED_PAGES: Record<string, string> = {
  '/lanes': '/',
  '/dispatch': '/',
  '/terminals': '/',
  '/review': '/',
  '/settings': '/',
  '/studio': '/?screen=studio',
}

function retiredPageRedirects() {
  const instance = new Elysia()
  for (const [path, location] of Object.entries(RETIRED_PAGES)) {
    instance.get(path, ({ request, server, set }) => {
      if (!localRequestAllowed(request, peerAddress(server, request))) { set.status = 403; return 'local access only' }
      set.status = 302
      set.headers['location'] = location
      return ''
    })
  }
  return instance
}

async function publicDirExists(): Promise<boolean> {
  try {
    return (await stat(PUBLIC_DIR)).isDirectory()
  } catch {
    return false
  }
}

// Health is deliberately public: probes (skd-dispatch skill, double-bind check) read liveness only.
function healthApi() {
  return new Elysia().get('/api/health', () => ({ ok: true }))
}

export async function createApp(): Promise<Elysia> {
  const skills = await installSkills()
  for (const problem of await refreshAllContributions()) console.error(`plugin contributions: ${problem}`)
  const assets = await syncEngineAssets()
  if (assets.linked.length > 0 || assets.written.length > 0 || assets.movedAside.length > 0) {
    console.error(`codex assets — linked ${assets.linked.length}, written ${assets.written.length}, moved aside ${assets.movedAside.length}, skipped ${assets.skipped.length}`)
  }
  if (skills.linked.length > 0 || skills.movedAside.length > 0 || skills.removed.length > 0) {
    console.error(`skills: ${describeSkillInstall(skills)} -> ${claudeSkillsDir()}`)
  }
  const workflowStore = createWorkflowStore(undefined, { pluginFlows: listedPluginFlows })
  const runEvents = createRunEvents()
  const attention = createAttentionStore()
  const attentionOn = attentionEvents(attention)
  const notifier = createNotifier({ config: async () => { const secrets = await readSecrets(); return { url: secrets.notifyWebhookUrl, key: secrets.notifyWebhookKey } } })
  void notifier.resume()
  let queueItems: () => QueueItem[] = () => []
  const notifyOn = createNotifyEvents({ notifier, items: () => queueItems(), run: id => workflowRunner.get(id) })
  const jobManager = createJobManager({
    onJobSlow: (record) => { notifyOn.slow(record); void attentionOn.slow(record).catch(error => console.error('Attention raise failed', error)) },
    onPermissionRequest: (record, request) => { notifyOn.permission(record, request); void attentionOn.permission(record, request).catch(error => console.error('Attention raise failed', error)) },
    onJobStarted: (record) => { log(jobLine('started', record)); runEvents.changed(); void attentionOn.started(record).catch(() => {}) },
    onJobProgress: () => runEvents.changed(),
    onJobSettled: (record) => {
      runEvents.changed()
      void attentionOn.settled(record).catch(() => {})
      log(jobLine(record.stoppedAt ? 'stopped' : record.status === 'done' ? 'done' : 'failed', record))
      if (record.purpose === 'workflow-design') {
        void workflowBuilder.cleanup(record).catch(error => console.error('Workflow designer cleanup failed', error))
        return
      }
      if (record.workflowRunId) {
        void workflowRunner.onJobSettled(record).catch(error => console.error('Workflow settlement failed', error))
        return
      }
      if (record.chatId) {
        void chatFlusher.onAgentSettled(record).catch(error => console.error('Chat report failed', error))
        return
      }
      if (record.purpose === 'chat') void chatFlusher.kick(threadRootOf(record)).catch(error => console.error('Chat queue failed', error))
      void maybeAutoReview(record, jobManager, { resolver: realEngineResolver }).catch(() => {})
    },
  })
  const terminalRegistry = createTerminalRegistry({ log: createTerminalLog() })
  let queueEngine: QueueEngine | undefined
  let statusSync: StatusSync | undefined
  const syncStatus = () => { void statusSync?.reconcile().catch(error => console.error('Status sync failed', error)) }
  const workflowRunner = createWorkflowRunner({
    manager: jobManager,
    resolver: realEngineResolver,
    store: workflowStore,
    terminals: terminalRegistry,
    onRunSettled: run => {
      void chatFlusher.onRunSettled(run).catch(error => console.error('Workflow chat report failed', error))
      notifyOn.runSettled(run)
      void queueEngine?.onRunSettled(run).catch(error => console.error('Queue settle failed', error))
    },
    onSessionStep: run => { void chatFlusher.onSessionStep(run).catch(error => console.error('In Session chat nudge failed', error)) },
    onChange: () => { runEvents.changed(); syncStatus() },
    availability: createAvailabilityCheck({ secrets: readSecrets, quota: () => quotaCache.get() }),
  })
  const chatQueue = createChatQueue(chatQueuePath())
  const chatFlusher = createChatFlusher(jobManager, realEngineResolver, {
    queue: chatQueue,
    runs: workflowRunner,
    needsYou: attentionOn.needsYou,
    logReader: async () => {
      const read = await redactedTailReader()
      return id => read(jobManager.logPath(id))
    },
  })
  const workflowBuilder = createWorkflowBuilder({ manager: jobManager, resolver: realEngineResolver, store: workflowStore })
  await workflowRunner.recover()
  const queueStore = createQueueStore(queuePath())
  queueItems = () => queueStore.list()
  const queueSource = (pluginId: string) => pluginSource(pluginId, { installed: getInstalled, runtimes: defaultRuntimes })
  registerQueueWorkspaces(path => queueStore.list().some(item => item.repos !== undefined && item.worktree === path))
  queueEngine = createQueueEngine({
    store: queueStore,
    runner: workflowRunner,
    source: queueSource,
    prepareWorktree: (repo, label) => prepareWorktree(repo, label),
    prepareWorkspace: (folder, repos, label) => prepareRepoWorkspace(folder, repos, label),
    isWorktree: (repo, worktree) => isWorktreeOf(repo, worktree),
    writeContext: (pluginId, context, cwd) => writeQueueContext(pluginId, context, cwd),
    pluginFiles: pluginId => join(configDir(), 'plugin-data', pluginId, 'files'),
    backupDir: itemId => join(configDir(), 'queue-files', itemId),
    needsYou: (item, reason) => { void raiseQueueAlert(attention, item, reason).catch(error => console.error('Queue alert failed', error)); notifyOn.queue(item, reason) },
    autoPick: async id => (await getSetting(id, 'autoPick')) === 'true',
    pickIn: async id => (await automateOn(getSetting, id) ? 'clickup' : 'shikidan'),
    publish: async item => publish(item, { dir: publishDir(), domain: publishDomain(), cardImages: item.worktree === null ? [] : await cardImageFiles(item.worktree, item.source) }),
    notify: (item, event) => notifyOn.pickReply(item, event),
    unpublish: async item => { if (item.published !== undefined) await unpublish(item.published.sub, publishDir()) },
    publishKeepDays: async () => (await readConfig()).publishKeepDays,
    pickAskTo: async () => (await readConfig()).pickAskTo,
    pickNonePhrases: async () => (await readConfig()).pickNonePhrases,
    sweepPublished: () => removeLeftovers(publishDir()),
    parallel: async () => (await readConfig()).queueParallel,
  })
  watchQueueAlerts(queueStore, attention)
  statusSync = createStatusSync({
    store: queueStore,
    run: id => workflowRunner.get(id),
    map: statusMaps({ flow: id => workflowStore.get(id), setting: getSetting }),
    source: queueSource,
    onSynced: item => { void attention.resolve(attentionKey.queueSync(item.id)).catch(error => console.error('Status sync alert failed', error)) },
    onFailed: (item, status, error) => { void raiseSyncAlert(attention, item, error).catch(alertError => console.error('Status sync alert failed', alertError)); notifyOn.syncFailed(item, status, error) },
  })
  queueStore.subscribe(syncStatus)
  const bootQueue = queueEngine
  void bootQueue.recover().then(
    () => {
      void sweepQueueAlerts(queueStore, attention).catch(error => console.error('Queue alert sweep failed', error))
      syncStatus()
      void bootQueue.retirePublished().catch(error => console.error('Published link sweep failed', error))
      return bootQueue.checkReplies().catch(error => console.error('Queue reply check failed', error))
    },
    error => console.error('Queue recover failed', error),
  )
  let replySweep: ReturnType<typeof setInterval> | undefined
  let replySweepMinutes = 0
  const sweepRepliesEvery = (minutes: number): void => {
    if (minutes === replySweepMinutes) return
    replySweepMinutes = minutes
    clearInterval(replySweep)
    replySweep = setInterval(() => { void queueEngine?.checkReplies().catch(error => console.error('Queue reply check failed', error)) }, minutes * 60_000)
    replySweep.unref()
  }
  sweepRepliesEvery((await readConfig()).replyPollMinutes)
  setInterval(() => { void queueEngine?.retirePublished().catch(error => console.error('Published link sweep failed', error)) }, 60 * 60_000).unref()
  await workflowBuilder.recover()
  await attention.prune(jobId => jobManager.getJob(jobId)?.status === 'running')
  void chatFlusher.recoverAll().catch(error => console.error('Chat catch-up failed', error))
  const knownDirectories = () => [...jobManager.listJobs().map(job => job.baseRepo ?? job.cwd), ...terminalRegistry.list().map(session => session.cwd)]
  const externalSessionsCache = createExternalSessionsCache(() => ownedPids(jobManager.listJobs(), terminalRegistry.list()))
  const outcomeLedger = createOutcomeLedger({ resolve: createSessionResolver({ terminals: terminalRegistry, jobs: jobManager, runs: workflowRunner }) })
  void outcomeLedger.prune(OUTCOME_RETENTION_MS).catch(error => console.error('Outcome prune failed', error))

  const requestStarts = new WeakMap<Request, number>()
  const verboseLog = readEnv('LOG') === 'verbose'
  const app = new Elysia()
    .onRequest(({ request }) => { requestStarts.set(request, performance.now()) })
    .onAfterResponse(({ request, set }) => {
      const status = typeof set.status === 'number' ? set.status : 200
      if (!shouldLogRequest(request.method, status, verboseLog)) return
      log(requestLine(request.method, request.url, status, performance.now() - (requestStarts.get(request) ?? performance.now())))
    })
    .get('/', async ({ request, server, set }) => {
      if (!localRequestAllowed(request, peerAddress(server, request))) { set.status = 403; return 'local access only' }
      return appShellPage()
    })
    .get('/js/:file', async ({ params, set }) => {
      if (params.file.endsWith('.css')) {
        const css = await transpileClientStyles(params.file)
        if (css === null) { set.status = 404; return { error: 'not found' } }
        return new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' } })
      }
      const code = await transpileClientModule(params.file)
      if (code === null) {
        set.status = 404
        return { error: 'not found' }
      }
      return new Response(code, { headers: JS_HEADERS })
    })
    .get('/sw.js', async ({ set }) => {
      const code = await transpileClientModule('sw.js')
      if (code === null) { set.status = 404; return { error: 'not found' } }
      return new Response(code, { headers: JS_HEADERS })
    })
    .use(retiredPageRedirects())
    .use(healthApi())
    .use(quotaRoutes({ externalSessions: () => externalSessionsCache.get() }))
    .use(metaRoutes(jobManager))
    .use(jobsRoutes(jobManager, realEngineResolver, { queue: chatQueue, terminals: terminalRegistry, attention }))
    .use(chatRoutes({ knownDirectories, manager: jobManager }))
    .use(historyRoutes({ manager: jobManager, registry: terminalRegistry }))
    .use(terminalsRoutes(terminalRegistry))
    .use(outcomesRoutes(outcomeLedger))
    .use(attentionRoutes(attention))
    .use(studioRoutes(workflowStore, workflowRunner, workflowBuilder, runEvents, () => jobManager.listJobs()))
    .use(secretsRoutes(() => notifier.clear()))
    .use(notifyRoutes(notifier, () => queueStore.list()))
    .use(rolesRoutes)
    .use(flowApprovalRoutes)
    .use(modelsRoutes)
    .use(providersRoutes)
    .use(pluginsRoutes())
    .use(queueRoutes(queueStore, queueEngine, () => queueTree(queueStore.list()), { get: id => workflowRunner.get(id), subscribe: runEvents.subscribe }, settings => sweepRepliesEvery(settings.replyPollMinutes)))

  await defaultRuntimes()

  if (await publicDirExists()) {
    app.use(staticPlugin({ assets: PUBLIC_DIR, prefix: '', headers: { 'cache-control': 'no-cache' } }))
  }

  return app
}

if (import.meta.main) {
  const target = listenTarget()
  const occupied = await fetch(`http://${target.hostname}:${target.port}/api/health`, { signal: AbortSignal.timeout(800) })
    .then(() => true, () => false)
  if (occupied) {
    console.error(`shiki: ${target.hostname}:${target.port} already answers — another instance is running, refusing to double-bind`)
    process.exit(1)
  }
  if (readEnv('CONFIG_DIR') === undefined && await migrateConfigDir() === 'migrated') console.error(`config: moved ~/.config/${LEGACY_CONFIG_DIR_NAME} to ~/.config/${CONFIG_DIR_NAME}, old path is a symlink`)
  const app = await createApp()
  app.listen({ hostname: target.hostname, port: target.port, reusePort: false })
  console.log(`shiki listening on http://${target.hostname}:${target.port}`)
}
