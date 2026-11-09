import { z } from 'zod'

import type { Runtimes } from './plugins/runtimes'
import type { CardPeople } from './queue-pick-reply'
import type { InstalledPlugin } from './plugins/store'

export type SourceImage = { name: string; path: string }
export type SourceItem = { title: string; url: string; contextMarkdown: string; images?: SourceImage[] }
export type SourceReply = { id: string; author: string; authorId: string; text: string; images: SourceImage[] }
export type SourceReplies = { replies: SourceReply[]; lastId: string | null }

export type QueueSource = {
  item(input: { id: string }): Promise<SourceItem>
  post(input: { id: string; kind: 'ask' | 'update'; lines: string[]; mention?: string; assignee?: string; status?: string }): Promise<{ commentId: string; ref?: string; status?: string; warning?: string }>
  replies(input: { id: string; sinceId: string | null }): Promise<SourceReplies>
  status(input: { id: string; status: string }): Promise<{ status: string }>
  people(input: { id: string }): Promise<CardPeople>
  resolve(input: { id: string; ref: string }): Promise<void>
}

export type SourceDeps = {
  installed(id: string): Promise<InstalledPlugin | null>
  runtimes(): Promise<Pick<Runtimes, 'getRuntime'>>
}

const text = z.string().max(64000)
const postSchema = z.object({ commentId: z.string().min(1).max(200), ref: z.string().min(1).max(200).optional(), status: z.string().max(200).optional(), warning: z.string().max(2000).optional() })
const statusSchema = z.object({ status: z.string().min(1).max(200) })
const imageSchema = z.object({ name: z.string().min(1).max(200), path: z.string().min(1).max(1024) })
const itemSchema = z.object({ title: z.string().min(1).max(500), url: z.string().max(2048), contextMarkdown: z.string().max(524288), images: z.array(imageSchema).max(30).optional() })
const personSchema = z.object({ id: z.string().min(1).max(200), username: z.string().max(200) })
const peopleSchema = z.object({ creator: personSchema.nullable(), assignees: z.array(personSchema).max(100), me: personSchema })
const repliesSchema = z.object({
  replies: z.array(z.object({ id: z.string().min(1).max(200), author: z.string().max(200), authorId: z.string().max(200).default(''), text, images: z.array(imageSchema).max(8) })).max(100),
  lastId: z.string().min(1).max(200).nullable(),
}).refine(result => result.replies.length === 0 || result.lastId !== null, { message: 'lastId is required when there are replies' })

const ruleBroken = (error: z.ZodError): string => {
  const custom = error.issues.find(issue => issue.code === 'custom')
  return custom === undefined ? '' : `: ${custom.message}`
}

export function pluginSource(pluginId: string, deps: SourceDeps): QueueSource {
  async function call<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
    const installed = await deps.installed(pluginId)
    if (installed === null) throw new Error(`${pluginId} is not installed`)
    if (!installed.enabled) throw new Error(`${pluginId} is turned off`)
    const runtime = await (await deps.runtimes()).getRuntime(installed)
    if (!runtime.ok) throw new Error(runtime.error)
    const outcome = await runtime.runtime.call(method, params)
    if (!outcome.ok) throw new Error(outcome.error)
    const parsed = schema.safeParse(outcome.result)
    if (!parsed.success) throw new Error(`${pluginId} returned an unexpected ${method} result${ruleBroken(parsed.error)}`)
    return parsed.data
  }
  return {
    item: input => call('source.item', input, itemSchema),
    post: input => call('source.post', input, postSchema),
    replies: input => call('source.replies', input, repliesSchema),
    status: input => call('source.status', input, statusSchema),
    people: input => call('source.people', input, peopleSchema),
    resolve: async input => { await call('source.resolve', input, z.unknown()) },
  }
}
