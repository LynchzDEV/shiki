import { expect, test } from 'bun:test'
import { defaultWorkflow, validateWorkflow } from '../server/workflows'
import { classicWorkflow } from './support/classic-workflow'
import { agentChoice, agentFromChoice, agentHelp, agentIcon, agentLabel, roleChoice, insertWorkflowStep, runNote, showsModelFields, kindIcon, nodeRunStates, roleOptions, roleWord, rolesBody, removeWorkflowStep, swapNote, taskPreset, validRoleName, workflowTemplates } from '../client/studio-graph'

test('adding a custom step keeps the following review connected and preserves failure routes',()=>{
  const graph=classicWorkflow()
  graph.edges.push({source:'execute',target:'verify-plan',outcome:'fail'})
  const step=taskPreset('custom')
  const next=insertWorkflowStep(graph,step,'execute')
  expect(next.edges).toContainEqual({source:'execute',target:step.id,outcome:'pass'})
  expect(next.edges).toContainEqual({source:step.id,target:'review',outcome:'pass'})
  expect(next.edges).toContainEqual({source:'execute',target:'verify-plan',outcome:'fail'})
  expect(validateWorkflow(next)).toEqual([])
  expect(graph.nodes).toHaveLength(4)
})

test('removing a custom step reconnects the existing flow without removing its review',()=>{
  const graph=classicWorkflow(),step=taskPreset('custom')
  expect(removeWorkflowStep(insertWorkflowStep(graph,step,'execute'),step.id)).toEqual(graph)
})

test('all built-in starting templates satisfy core graph rules and blank graphs get an entry',()=>{
  for(const template of workflowTemplates(defaultWorkflow()))expect(validateWorkflow(template)).toEqual([])
  const step=taskPreset('research')
  const graph=insertWorkflowStep({id:'empty',name:'New workflow',entry:'',nodes:[],edges:[]},step)
  expect(graph.entry).toBe(step.id)
  expect(validateWorkflow(graph)).toEqual([])
})

test('agentLabel reads Chat decides, the provider name, or Unavailable for a removed connection',()=>{
  const providers=[{id:'claude',name:'Claude',models:[]},{id:'qwen',name:'Qwen Code',models:[]}]
  expect(agentLabel({agent:{role:'execute'}},providers)).toBe('Chat decides')
  expect(agentLabel({agent:{role:'execute',engine:'qwen'}},providers)).toBe('Qwen Code')
  expect(agentLabel({agent:{role:'execute',engine:'grok'}},providers)).toBe('Unavailable · grok')
  const roles=[{name:'execute',engine:'qwen',model:null}]
  expect(agentLabel({agent:{role:'execute'}},providers,roles)).toBe('Qwen Code')
  expect(agentLabel({agent:{role:'builder'}},providers,roles)).toBe('Missing role')
  expect(agentLabel({agent:{role:'execute',engine:'qwen'}},providers,roles)).toBe('Qwen Code')
})

test('agentLabel reads In Session for the session engine, whatever the providers are',()=>{
  expect(agentLabel({agent:{role:'plan',engine:'session'}},[])).toBe('In Session')
})

test('agentHelp explains Chat decides, In Session and a fixed AI',()=>{
  expect(agentHelp(undefined)).toBe('The chat picks the AI for this step from its strengths and usage.')
  expect(agentHelp('session')).toBe('The AI in the chat or terminal that started the flow does this step there, where you can see it.')
  expect(agentHelp('claude')).toBe('Always use this AI for this step.')
})

test('kindIcon names the symbol drawn on each step kind',()=>{
  expect(kindIcon('plan')).toBe('plan-icon')
  expect(kindIcon('verify-plan')).toBe('check-circle-icon')
  expect(kindIcon('implement')).toBe('code-icon')
  expect(kindIcon('review')).toBe('eye-icon')
  expect(kindIcon('task')).toBe('spark-icon')
})

test('roleWord capitalises the role shown on the AI tag',()=>{
  expect(roleWord('plan')).toBe('Plan')
  expect(roleWord('execute')).toBe('Execute')
  expect(roleWord('review')).toBe('Review')
})

test('roleWord capitalises any role name and keeps the rest',()=>{
  expect(roleWord('builder')).toBe('Builder')
  expect(roleWord('deepReview')).toBe('DeepReview')
})

test('roleOptions lists the built-in roles first, then the rest by name, without autoReview, fallback or engineless entries',()=>{
  const roles={review:{engine:'codex',model:'gpt-5'},zeta:{engine:'glm',model:null},autoReview:true,fallback:{engine:'claude',model:null},plan:{engine:'claude'},builder:{engine:'qwen',model:'q3'},broken:{model:'x'},execute:{engine:'glm',model:null},odd:'claude'}
  expect(roleOptions(roles)).toEqual([
    {name:'plan',engine:'claude',model:null},
    {name:'execute',engine:'glm',model:null},
    {name:'review',engine:'codex',model:'gpt-5'},
    {name:'builder',engine:'qwen',model:'q3'},
    {name:'zeta',engine:'glm',model:null},
  ])
})

test('validRoleName accepts a new name and rejects reserved, duplicate and malformed ones',()=>{
  expect(validRoleName('builder',['plan','execute','review'])).toBe(true)
  expect(validRoleName('fallback',[])).toBe(false)
  expect(validRoleName('autoReview',[])).toBe(false)
  expect(validRoleName('execute_model',[])).toBe(false)
  expect(validRoleName('plan',['plan','execute','review'])).toBe(false)
  expect(validRoleName('-x',[])).toBe(false)
  expect(validRoleName('a'.repeat(64),[])).toBe(true)
  expect(validRoleName('a'.repeat(65),[])).toBe(false)
})

test('the step picker shows a pinned AI by its id and an unpinned step by its role',()=>{
  expect(agentChoice({role:'execute',engine:'codex'})).toBe('codex')
  expect(agentChoice({role:'builder'})).toBe(roleChoice('builder'))
  expect(roleChoice('builder')).not.toBe(agentChoice({role:'execute',engine:'builder'}))
})

test('picking a role drops the pinned AI and model; picking an AI keeps the current role',()=>{
  expect(agentFromChoice(roleChoice('builder'),{role:'execute',engine:'codex'})).toEqual({role:'builder'})
  expect(agentFromChoice('glm',{role:'builder'})).toEqual({role:'builder',engine:'glm'})
  expect(agentFromChoice('session',{role:'plan'})).toEqual({role:'plan',engine:'session'})
})

test('swapNote marks a step another AI took over and a same-family review, and stays empty otherwise',()=>{
  expect(swapNote({engine:'claude',swappedFrom:{engine:'codex',model:'gpt-5',reason:'codex is not installed'}})).toBe(' · instead of codex (codex is not installed)')
  expect(swapNote({engine:'claude',sameFamily:true})).toBe(' · same-family review')
  expect(swapNote({engine:'claude',swappedFrom:{engine:'codex',model:null,reason:'crashed 3 times'},sameFamily:true})).toBe(' · instead of codex (crashed 3 times) · same-family review')
  expect(swapNote({engine:'claude'})).toBe('')
  expect(swapNote(undefined)).toBe('')
})

test('rolesBody sends every role from the last read plus edits, drops removed roles and keeps autoReview',()=>{
  const read={plan:{engine:'claude',model:null},execute:{engine:'glm',model:null},review:{engine:'codex',model:null},old:{engine:'qwen',model:null},hidden:{model:'kept'},autoReview:true,fallback:null}
  const edited=[{name:'plan',engine:'codex',model:'gpt-5'},{name:'execute',engine:'glm',model:null},{name:'review',engine:'codex',model:null},{name:'builder',engine:'claude',model:null}]
  expect(rolesBody(read,edited,{engine:'claude',model:null})).toEqual({plan:{engine:'codex',model:'gpt-5'},execute:{engine:'glm',model:null},review:{engine:'codex',model:null},builder:{engine:'claude',model:null},hidden:{model:'kept'},autoReview:true,fallback:{engine:'claude',model:null}})
  expect(rolesBody(read,edited,null).fallback).toBeNull()
})

const settled=(nodeId:string,outcome:string,startedAt:number)=>({nodeId,status:'settled',result:{outcome},startedAt})

test('nodeRunStates is empty when no run is running',()=>{
  expect(nodeRunStates(null)).toEqual({})
})

test('nodeRunStates marks settled passes and the current step as running',()=>{
  const run={status:'running',currentNodeId:'execute',tokens:[{nodeId:'execute',state:'working'}],attempts:[settled('plan','pass',1),settled('verify-plan','pass',2),{nodeId:'execute',status:'running',result:null,startedAt:3}]}
  expect(nodeRunStates(run)).toEqual({plan:'passed','verify-plan':'passed',execute:'running'})
})

test('nodeRunStates keeps the highlights of a paused run',()=>{
  const run={status:'paused',currentNodeId:'execute',tokens:[{nodeId:'execute',state:'working'}],attempts:[settled('plan','pass',1),{nodeId:'execute',status:'running',result:null,startedAt:2}]}
  expect(nodeRunStates(run)).toEqual({plan:'passed',execute:'running'})
})

test('nodeRunStates marks a settled fail or blocked step as failed',()=>{
  expect(nodeRunStates({status:'running',currentNodeId:'execute',tokens:[{nodeId:'execute',state:'working'}],attempts:[settled('review','fail',1)]}).review).toBe('failed')
  expect(nodeRunStates({status:'running',currentNodeId:'execute',tokens:[{nodeId:'execute',state:'working'}],attempts:[settled('review','blocked',1)]}).review).toBe('failed')
})

test('nodeRunStates uses the newest settled attempt of a step',()=>{
  const run={status:'running',currentNodeId:'review',tokens:[{nodeId:'review',state:'working'}],attempts:[settled('execute','fail',1),settled('execute','pass',2)]}
  expect(nodeRunStates(run).execute).toBe('passed')
})

test('nodeRunStates marks every step that holds a working token as running',()=>{
  const run={status:'running',currentNodeId:'a',tokens:[{nodeId:'a',state:'working'},{nodeId:'b',state:'working'},{nodeId:'join',state:'waiting'}],attempts:[settled('split','pass',1),{nodeId:'a',status:'running',result:null,startedAt:2},{nodeId:'b',status:'running',result:null,startedAt:2}]}
  expect(nodeRunStates(run)).toEqual({split:'passed',a:'running',b:'running'})
})

test('nodeRunStates does not mark a step whose token is only ready as running',()=>{
  expect(nodeRunStates({status:'paused',currentNodeId:'review',tokens:[{nodeId:'review',state:'ready'}],attempts:[settled('execute','pass',1)]})).toEqual({execute:'passed'})
})

test('an In Session step shows the session icon, never a provider image; Chat decides shows auto',()=>{
  expect(agentIcon('session')).toEqual({symbol:'session-icon'})
  expect(agentIcon(undefined)).toEqual({symbol:'auto-icon'})
  expect(agentIcon('codex')).toEqual({image:'/providers/codex.svg'})
})

test('the step panel hides Model and Family for an In Session step only',()=>{
  expect(showsModelFields('session')).toBe(false)
  expect(showsModelFields(undefined)).toBe(true)
  expect(showsModelFields('claude')).toBe(true)
})

test('the Run workflow modal notes that In Session steps run as agents from Studio, only when the graph has one',()=>{
  const graph=defaultWorkflow()
  const withSession={...graph,nodes:graph.nodes.map(node=>node.id==='plan'?{...node,agent:{role:'plan' as const,engine:'session'}}:node)}
  const without={...graph,nodes:graph.nodes.map(node=>({...node,agent:{role:node.agent.role}}))}
  expect(runNote(withSession)).toBe('In Session steps run as agents when started from Studio.')
  expect(runNote(without)).toBeNull()
})

test('review and plan-check presets carry the pstack rubric and red flags',()=>{
  expect(taskPreset('review').instructions).toContain('ONLY report issues related to code')
  expect(taskPreset('verify-plan').instructions).toContain('## Shallow module')
})

test('the browser bundle of studio-graph resolves the shared reviewer prompts',async()=>{
  const { transpileClientModule } = await import('../server/index')
  expect(await transpileClientModule('studio-graph.js')).toContain('ONLY report issues related to code')
})
