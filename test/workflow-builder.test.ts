import { PSTACK_FLOW_IDS } from '../server/pstack-flows'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJobManager, type JobManager } from '../server/jobs'
import { createWorkflowStore } from '../server/workflows'
import { classicWorkflow } from './support/classic-workflow'
import { createWorkflowBuilder, readWorkflowDraft } from '../server/workflow-builder'
import { realEngineResolver, type EngineResolver } from '../server/jobs-engine-iface'
import { writeConfig } from '../server/secrets'

let config: string, home: string, manager: JobManager
beforeEach(async () => {
  config = await mkdtemp(join(tmpdir(), 'mc-builder-config-'))
  home = await mkdtemp(join(homedir(), 'mc-builder-work-'))
  process.env.SKD_CONFIG_DIR = config
  await writeConfig({ roles: { plan: {engine:'codex',model:null},execute:{engine:'claude',model:null},review:{engine:'codex',model:null} } })
  manager = createJobManager()
})
afterEach(async () => {
  for (const job of manager.listJobs()) if(job.status==='running') await manager.killJob(job.id)
  delete process.env.SKD_CONFIG_DIR
  await rm(config,{recursive:true,force:true}); await rm(home,{recursive:true,force:true})
})
const answer = () => ({workflow:{...classicWorkflow(),id:'draft',name:'My workflow'},summary:'Created an implementation flow',setup:[]})
const log = (value:unknown) => JSON.stringify({type:'result',is_error:false,result:JSON.stringify(value)})

test('accepts a valid draft and rejects a graph that bypasses implementation rules',()=>{
  expect(readWorkflowDraft(log(answer()),['claude','codex','glm']).workflow.nodes).toHaveLength(4)
  expect(()=>readWorkflowDraft(log({...answer(),workflow:{...answer().workflow,entry:'execute'}}),['claude','codex','glm'])).toThrow('verified plan')
  expect(()=>readWorkflowDraft(log({...answer(),workflow:{...answer().workflow,nodes:answer().workflow.nodes.map(node=>({...node,agent:{role:'plan',engine:'invented'}}))}}),['codex'])).toThrow('not connected')
})

test('a draft may keep a step In Session without a connection named session',()=>{
  expect(readWorkflowDraft(log(answer()),['codex']).workflow.nodes[0]!.agent.engine).toBe('session')
})

test('generated drafts cannot introduce executable checks or tool servers',()=>{
  const value=answer();value.workflow.nodes[0]!.checks=[{command:'sh',args:['-c','danger'],timeoutSeconds:30}]
  expect(()=>readWorkflowDraft(log(value),['claude','codex'])).toThrow('tool')
  expect(()=>readWorkflowDraft('not JSON',['claude'])).toThrow('valid workflow')
})

test('builds a draft in an isolated job without saving or executing its workflow',async()=>{
  let readOnly=false
  const resolver:EngineResolver=params=>{readOnly=params.readOnly===true;return {cmd:'echo',args:[log(answer())],env:{}}}
  const store=createWorkflowStore(config)
  const builder=createWorkflowBuilder({manager,resolver,store,home})
  const started=await builder.start({description:'Plan, implement and review the change'})
  const end=Date.now()+4000
  while(manager.getJob(started.id)?.status==='running'&&Date.now()<end)await Bun.sleep(20)
  const result=await builder.get(started.id)
  expect(result.status).toBe('done');expect(result.draft?.workflow.nodes).toHaveLength(4)
  expect(readOnly).toBe(true)
  expect(manager.getJob(started.id)?.purpose).toBe('workflow-design')
  expect((await store.list()).map(item=>item.id)).toEqual(['default',...PSTACK_FLOW_IDS])
  expect(manager.listJobs()).toHaveLength(1)
  await builder.cleanup(manager.getJob(started.id)!)
})

test('builder stop uses the existing job lifecycle and generation rejects empty requests',async()=>{
  const resolver:EngineResolver=()=>({cmd:'sleep',args:['30'],env:{}})
  const builder=createWorkflowBuilder({manager,resolver,store:createWorkflowStore(config),home})
  await expect(builder.start({description:''})).rejects.toThrow()
  const job=await builder.start({description:'Research a topic'})
  expect(builder.current()?.id).toBe(job.id)
  const recovered=createWorkflowBuilder({manager,resolver,store:createWorkflowStore(config),home})
  expect(recovered.current()?.id).toBe(job.id)
  await builder.stop(job.id)
  const end=Date.now()+4000
  while(manager.getJob(job.id)?.status==='running'&&Date.now()<end)await Bun.sleep(20)
  expect((await builder.get(job.id)).status).toBe('failed')
  await builder.cleanup(manager.getJob(job.id)!)
})

test('native drafting uses read-only Codex and disables Claude tools',async()=>{
  const codex=await realEngineResolver({engine:'codex',prompt:'Design only',readOnly:true})
  expect(codex.args).toContain('read-only')
  expect(codex.args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  const claude=await realEngineResolver({engine:'claude',prompt:'Design only',readOnly:true})
  expect(claude.args[claude.args.indexOf('--tools')+1]).toBe('')
  expect(claude.args).toContain('--strict-mcp-config')
})
