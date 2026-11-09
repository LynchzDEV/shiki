import { backUpAnswers } from './queue-answers'
import type { QueueEngineDeps } from './queue-engine'
import { importImages, queueFolder, refuseLinkedQueueFolders } from './queue-files'
import { answersMarkdown } from './queue-prompts'
import type { SourceReplies, SourceReply } from './queue-source'
import type { QueueItem } from './queue-store'
import { worktreeRestorer, WorktreeGone } from './queue-worktree'

const MAX_REPLY_FAILURES = 3

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function failureCounter(deps: QueueEngineDeps, reason: string) {
  const counts = new Map<string, number>()
  return {
    clear: (id: string) => { counts.delete(id) },
    record(item: QueueItem, error: unknown): void {
      const failures = (counts.get(item.id) ?? 0) + 1
      counts.set(item.id, failures % MAX_REPLY_FAILURES)
      if (failures === MAX_REPLY_FAILURES) deps.needsYou(deps.store.get(item.id) ?? item, `${reason}: ${message(error)}`)
    },
  }
}

export type ReplyCheck = {
  read(item: QueueItem): Promise<SourceReplies | null>
  apply(item: QueueItem, worktree: string, result: SourceReplies): Promise<boolean>
  answer(item: QueueItem, worktree: string, text: string): Promise<void>
  keepAnswer(item: QueueItem, worktree: string, text: string): Promise<void>
}

export function replyCheck(deps: QueueEngineDeps, fail: (item: QueueItem, reason: string) => Promise<void>): ReplyCheck {
  const { store } = deps
  const restore = worktreeRestorer(deps)
  const readFailures = failureCounter(deps, 'Could not read replies')
  const saveFailures = failureCounter(deps, 'Could not save the replies')

  async function saved(item: QueueItem, stored: string, replies: SourceReply[]): Promise<{ worktree: string; answerPaths: string[] }> {
    const worktree = await restore({ ...item, worktree: stored })
    await refuseLinkedQueueFolders(worktree, item.source)
    const images = await importImages(deps.pluginFiles(item.source), replies, queueFolder(worktree, item.source))
    const markdown = answersMarkdown(item.questions, replies, images)
    const path = await deps.writeContext(item.source, { name: `answers-${item.externalId}`, markdown }, worktree)
    await backUpAnswers(deps.backupDir(item.id), path, markdown)
    return { worktree, answerPaths: [...item.answerPaths, path] }
  }

  async function resume(item: QueueItem, stored: string, replies: SourceReply[], lastId: string | null): Promise<void> {
    await store.update(item.id, { state: 'queued', ...await saved(item, stored, replies), questions: [], lastSeenId: lastId ?? item.lastSeenId, land: undefined })
    await store.toFront(item.id)
  }

  async function read(item: QueueItem): Promise<SourceReplies | null> {
    try {
      const result = await deps.source(item.source).replies({ id: item.externalId, sinceId: item.lastSeenId })
      if (result.replies.length > 0 && result.lastId === null) throw new Error(`${item.source} returned replies without a lastId`)
      readFailures.clear(item.id)
      return result
    } catch (error) {
      readFailures.record(item, error)
      return null
    }
  }

  async function apply(item: QueueItem, worktree: string, result: SourceReplies): Promise<boolean> {
    if (result.replies.length === 0) return false
    try {
      await resume(item, worktree, result.replies, result.lastId)
      saveFailures.clear(item.id)
      return true
    } catch (error) {
      if (error instanceof WorktreeGone) { await fail(item, error.message); return false }
      console.error('queue resume failed', error)
      saveFailures.record(item, error)
      return false
    }
  }

  const fromOwner = (text: string): SourceReply[] => [{ id: 'owner', author: 'Owner', authorId: '', text, images: [] }]
  const answer = (item: QueueItem, worktree: string, text: string): Promise<void> => resume(item, worktree, fromOwner(text), null)
  const keepAnswer = async (item: QueueItem, worktree: string, text: string): Promise<void> => { await store.update(item.id, await saved(item, worktree, fromOwner(text))) }

  return { read, apply, answer, keepAnswer }
}
