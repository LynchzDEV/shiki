import { Elysia } from 'elysia'
import { z } from 'zod'

import { auditSettings } from '../audit-log'
import { requireLocal } from '../auth'
import { actorSchema, HUMAN } from '../card-toolbox'
import { isMessageName, listMessages, MAX_MESSAGE, resetMessage, setMessage } from '../messages'
import { clearOverlay, FLOW_ID, overlayNodeOf, readFlowOverlay, setOverlayNode } from '../plugins/flow-overlays'
import { QueueRefusal } from '../queue-refusal'
import { DOCTOR_AUTO_INTENTS, readConfig, writeConfig } from '../secrets'

type Status = { status?: number | string }

const changeSchema = z.object({ actor: actorSchema, why: z.string().trim().min(1).max(1000).optional() })
const messageSchema = changeSchema.extend({ text: z.string().max(MAX_MESSAGE * 2) })
const overlaySetSchema = changeSchema.extend({ nodeId: z.string().min(1).max(64) }).passthrough()
const overlayClearSchema = changeSchema.extend({ nodeId: z.string().min(1).max(64).optional() })
const autoSchema = changeSchema.extend({ intent: z.enum(DOCTOR_AUTO_INTENTS), on: z.boolean() })
const AUTO_RULE = `Send { actor, intent, on }: actor is a short lowercase name such as human, intent is one of ${DOCTOR_AUTO_INTENTS.join(', ')}, on is true or false`
const OVERLAY_RULE = 'Send { actor, nodeId, instructions?, title? }: actor is a short lowercase name such as human'

export async function humanChange<T>(set: Status, change: { actor: string; why?: string | undefined; action: string; params: unknown }, work: () => Promise<T>): Promise<T | { error: string }> {
  const line = { actor: change.actor, action: change.action, why: change.why ?? 'cli', params: change.params }
  try {
    if (change.actor !== HUMAN) throw new QueueRefusal(`Only a human can change ${change.action.split('-')[0]}s`, 403)
    const result = await work()
    await auditSettings({ ...line, result: 'ok' })
    return result
  } catch (error) {
    if (!(error instanceof QueueRefusal)) throw error
    await auditSettings({ ...line, result: 'refused', error: error.message })
    set.status = error.status
    return { error: error.message }
  }
}

function parsedBody<T>(schema: z.ZodType<T>, body: unknown, set: Status, rule: string): T | { error: string } {
  const parsed = schema.safeParse(body ?? {})
  if (parsed.success) return parsed.data
  set.status = 400
  return { error: rule }
}

const MESSAGE_RULE = `Send { actor, text }: actor is a short lowercase name such as human, text is 1 to ${MAX_MESSAGE} characters`

export function humanSettingsRoutes() {
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .get('/api/messages', () => ({ messages: listMessages() }))
    .put('/api/messages/:name', ({ params, body, set }) => {
      if (!isMessageName(params.name)) { set.status = 404; return { error: `No message ${params.name}` } }
      const name = params.name
      const input = parsedBody(messageSchema, body, set, MESSAGE_RULE)
      if ('error' in input) return input
      return humanChange(set, { ...input, action: 'message-set', params: { name, text: input.text } }, async () => { await setMessage(name, input.text); return { ok: true } })
    })
    .delete('/api/messages/:name', ({ params, body, set }) => {
      if (!isMessageName(params.name)) { set.status = 404; return { error: `No message ${params.name}` } }
      const name = params.name
      const input = parsedBody(changeSchema, body, set, 'Send { actor }: actor is a short lowercase name such as human')
      if ('error' in input) return input
      return humanChange(set, { ...input, action: 'message-reset', params: { name } }, async () => { await resetMessage(name); return { ok: true } })
    })
    .get('/api/doctor/auto', async () => ({ auto: (await readConfig()).doctorAuto }))
    .put('/api/doctor/auto', ({ body, set }) => {
      const input = parsedBody(autoSchema, body, set, AUTO_RULE)
      if ('error' in input) return input
      return humanChange(set, { ...input, action: 'doctor-auto-set', params: { intent: input.intent, on: input.on } }, async () => ({ auto: (await writeConfig({ doctorAuto: { ...(await readConfig()).doctorAuto, [input.intent]: input.on } })).doctorAuto }))
    })
    .get('/api/studio/flow-overlays/:flowId', async ({ params, set }) => {
      if (!FLOW_ID.test(params.flowId)) { set.status = 400; return { error: `Not a flow id: ${params.flowId}` } }
      return { flowId: params.flowId, overlay: (await readFlowOverlay(params.flowId)) ?? { nodes: {} } }
    })
    .put('/api/studio/flow-overlays/:flowId', ({ params, body, set }) => {
      const input = parsedBody(overlaySetSchema, body, set, OVERLAY_RULE)
      if ('error' in input) return input
      const { actor, why, nodeId, ...node } = input
      return humanChange(set, { actor, why, action: 'overlay-set', params: { flowId: params.flowId, nodeId, node } }, async () => ({ flowId: params.flowId, overlay: await setOverlayNode(params.flowId, nodeId, overlayNodeOf(node)) }))
    })
    .delete('/api/studio/flow-overlays/:flowId', ({ params, body, set }) => {
      const input = parsedBody(overlayClearSchema, body, set, 'Send { actor, nodeId? }: actor is a short lowercase name such as human')
      if ('error' in input) return input
      return humanChange(set, { ...input, action: 'overlay-clear', params: { flowId: params.flowId, nodeId: input.nodeId ?? null } }, async () => ({ flowId: params.flowId, overlay: await clearOverlay(params.flowId, input.nodeId) }))
    })
}
