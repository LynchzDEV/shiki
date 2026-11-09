import { arg, emit, textArg, UsageError, type Command } from '../command'
import { keyValue } from '../format'

export const notifyCommands: Command[] = [
  { path: ['notify', 'status'], summary: 'Webhook url, whether a key is set, events still waiting to be delivered, and events dropped by the cap', run: async (ctx) => emit(ctx, await ctx.client.get('/api/notify'), keyValue) },
  {
    path: ['notify', 'test'],
    summary: 'Send a sample event with real-sized images to the webhook now',
    run: async (ctx) => emit(ctx, await ctx.client.post('/api/notify/test'), (result) => `The webhook answered ${(result as { status: number }).status}.\n`),
  },
  {
    path: ['notify', 'set-url'],
    args: ['url'],
    summary: 'Set the https webhook url',
    run: async (ctx) => emit(ctx, await ctx.client.post('/api/secrets', { notifyWebhookUrl: arg(ctx, 'url') }), () => 'Saved the webhook url.\n'),
  },
  {
    path: ['notify', 'set-key'],
    args: ['key'],
    summary: 'Set the webhook key (key - reads stdin, keeps it out of shell history)',
    run: async (ctx) => {
      const key = await textArg(ctx, 'key')
      if (key === '') throw new UsageError('the key is empty')
      emit(ctx, await ctx.client.post('/api/secrets', { notifyWebhookKey: key }), () => 'Saved the webhook key.\n')
    },
  },
  {
    path: ['notify', 'clear'],
    summary: 'Remove the webhook url and key (events waiting to be delivered are dropped)',
    run: async (ctx) => emit(ctx, await ctx.client.post('/api/secrets', { notifyWebhookUrl: null, notifyWebhookKey: null }), () => 'Cleared the webhook.\n'),
  },
]
