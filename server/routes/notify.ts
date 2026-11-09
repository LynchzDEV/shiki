import { Elysia } from 'elysia'

import { requireLocal } from '../auth'
import type { Notifier } from '../notify'
import { sampleEvent } from '../notify-events'
import type { QueueItem } from '../queue-store'
import { readSecrets } from '../secrets'

export function notifyRoutes(notifier: Notifier, items: () => QueueItem[]): Elysia {
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .get('/api/notify', async () => {
      const secrets = await readSecrets()
      return { configured: secrets.notifyWebhookUrl !== null, url: secrets.notifyWebhookUrl, keyConfigured: secrets.notifyWebhookKey !== null, pending: notifier.pending(), dropped: notifier.dropped() }
    })
    .post('/api/notify/test', async ({ set }) => {
      const { input, extra } = sampleEvent(items())
      const result = await notifier.send(input, extra)
      if (result.ok) return { ok: true, status: result.status }
      set.status = result.status === null && result.error === 'no webhook url configured' ? 400 : 502
      return { ok: false, status: result.status, error: result.error ?? `the webhook answered ${result.status}` }
    })
}
