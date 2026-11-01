import { expect, test } from 'bun:test'

import { queueStep } from '../server/queue-step'
import { classicWorkflow } from './support/classic-workflow'
import type { WorkflowAttempt, WorkflowRun } from '../server/workflow-runner'

const workflow = { ...classicWorkflow(), revision: 'r1', createdAt: 0 }
const attempt = (nodeId: string, number: number): WorkflowAttempt => ({ nodeId, number, jobId: `j${number}`, status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: null, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [] })
const run = (currentNodeId: string, attempts: WorkflowAttempt[]) => ({ workflow, currentNodeId, attempts }) as Pick<WorkflowRun, 'workflow' | 'currentNodeId' | 'attempts'>

test('the step names the current node and counts its visits against its limit', () => {
  const execute = workflow.nodes.find(node => node.id === 'execute')!
  expect(queueStep(run('execute', [attempt('plan', 0), attempt('execute', 1), attempt('review', 2), attempt('execute', 3)]))).toEqual({ title: execute.title, attempt: 2, maxAttempts: execute.maxVisits })
})

test('a node that has not started yet counts as its first attempt', () => {
  const plan = workflow.nodes.find(node => node.id === 'plan')!
  expect(queueStep(run('plan', []))).toEqual({ title: plan.title, attempt: 1, maxAttempts: plan.maxVisits })
})

test('a current node missing from the workflow gives no step', () => {
  expect(queueStep(run('gone', []))).toBeNull()
})
