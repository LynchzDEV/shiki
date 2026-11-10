import { Elysia } from 'elysia'
import { z } from 'zod'

import { auditSettings } from '../audit-log'
import { requireLocal } from '../auth'
import { actorSchema, HUMAN } from '../card-toolbox'
import { isMessageName, listMessages, MAX_MESSAGE, resetMessage, setMessage } from '../messages'
import { QueueRefusal } from '../queue-refusal'

type Status = { status?: number | string }

const changeSchema = z.object({ actor: actorSchema, why: z.string().trim().min(1).max(1000).optional() })
const messageSchema = changeSchema.extend({ text: z.string().max(MAX_MESSAGE * 2) })

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
}
