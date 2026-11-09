# ClickUp status sync and Grok Bot webhook

Cards on the ClickUp board move by themselves as a queue item runs, and a remote bot (Grok Bot, on another machine) hears about every moment a card needs a person. Nobody has to watch the cockpit.

Three changes, landed in this order:

1. The business-question alert that was missing.
2. ClickUp status sync.
3. The outbound webhook.

## 1. Business question raises an alert

`server/queue-engine.ts` (the `waiting-info` branch near line 194) posts the questions to the source and parks the item, but never calls `deps.needsYou`. After the `store.update`, call `deps.needsYou(parked, 'Question posted to ClickUp')`. `waiting-info` is already in `NEEDS_PERSON`, so the sweep keeps it.

## 2. ClickUp status sync

### The status table

The map is owned by the flow, so it lives in the flow file as one top-level field. Flow-node fields would be stripped by zod (`server/workflows.ts` `nodeSchema`). Adding a top-level optional field changes only the hash of flows that set it.

```json
"sourceStatus": {
  "states": { "queued": "Open", "waiting-pick": "hold", "waiting-info": "hold", "failed": "hold", "ready": "in progress", "landing": "in progress", "awaiting-stage": "review", "landed": "Closed" },
  "nodes": { "route": "pipeline", "compare": "pipeline", "mockups": "pipeline", "how": "pipeline", "architect": "pipeline", "verify-plan": "pipeline", "implement": "in progress", "verify-ui": "in progress", "review": "in progress", "audit": "in progress", "dod": "in progress" }
}
```

- `workflowSchema` gains `sourceStatus: z.object({ states: z.partialRecord(<QueueState enum>, status).optional(), nodes: z.record(z.string(), status).optional() }).optional()`, with `status = z.string().trim().min(1).max(100)`. A flow without it keeps its current hash.
- The flow's plugin may declare a `statusMap` setting (type `text`, same JSON shape). When it is set and parses, it replaces the flow's map wholesale. When it does not parse, log once and use the flow's map.
- The map is read from the workflow store's current definition for `item.flowId`, never from the run snapshot, so in-flight cards pick up a plugin update.

### What status a card should have

One pure function in `server/queue-status.ts`:

```ts
export type SourceStatusMap = { states?: Partial<Record<QueueState, string>>; nodes?: Record<string, string> }
export type StatusRun = { id: string; status: RunStatus; currentNodeId: string; workflow: { plugin?: string } }
export function desiredStatus(item: QueueItem, run: StatusRun | undefined, map: SourceStatusMap): string | null
```

- `item.state === 'building'`: the run is `item.currentRunId`'s run. When it is missing, or its workflow has no `plugin` (a recovery run), return `null`. Otherwise return `map.nodes[run.currentNodeId] ?? null`.
- Any other state: `map.states[item.state] ?? null`.
- `null` means leave ClickUp alone. Assignees are never touched.
- A blocked run does not move the card. The card goes to `hold` when the item reaches `failed`. The blocked webhook tells the bot sooner.
- `currentNodeId` names the step the run is heading to, so the status changes when the previous step settles.

### Sending it

- `QueueSource` (`server/queue-source.ts`) gains `status(input: { id: string; status: string }): Promise<{ status: string }>`, called as `source.status` on the plugin and parsed with zod. The plugin throws when the status does not exist on the task's list or when the read-back does not match.
- `QueueItem` gains `syncedStatus?: string`, the last status ClickUp confirmed. It persists, so a restart does not resend. Add it to the `isItem` guard.
- `createStatusSync(deps)` in `server/queue-status-sync.ts` exposes `reconcile(): void`. `reconcile` walks every item, computes `desiredStatus`, and for each item where the desired status is non-null, differs from `syncedStatus`, and has no call in flight, calls `source.status`. On success it stores `syncedStatus` and resolves the `queue-sync:<itemId>` alert. When the desired status changes during a call, the next `reconcile` picks it up.
- Failure: retry after 10 s, 1 min and 5 min. When the third retry fails, call `deps.onFailed(item, status, error)` once for that (item, desired status) pair, and stop until the desired status changes. The run never waits on ClickUp.
- Triggers: `queueStore.subscribe` and the runner's `onChange` both call `reconcile`. The syncer is built after the queue store, and `reconcile` runs once after `queueEngine.recover()`. `onChange` fires during `workflowRunner.recover()` before the syncer exists, so the call is guarded.
- `onFailed` raises an attention item with key `queue-sync:<itemId>`, kind `queue`, title = item title, detail `ClickUp status sync failed: <error>`. It has its own key so it never overwrites the item's `queue:<id>` alert, and `sweepQueueAlerts` only drops it when the item is gone.
- `ship-uat.sh` keeps posting `review` after UAT. The sync sends the same value, so the two never disagree.

## 3. Outbound webhook

### Settings

- `secrets.json` gains `notifyWebhookUrl` (https only) and `notifyWebhookKey`. `publicView` shows the URL and `notifyWebhookKeyConfigured`. `SecretsPatch`, `applyPatch` and its "nothing to update" guard learn both fields. `logSecrets()` includes the key. The Studio settings form gets both fields.
- Shikidan stays bound to localhost. Only outbound requests are added.

### Events

| Event | Fired when |
|---|---|
| `pick` | queue `needsYou` with the item in `waiting-pick` |
| `question` | queue `needsYou` with the item in `waiting-info` (business or technical) |
| `failed` | queue `needsYou` with the item in `failed` |
| `stage-ready` | queue `needsYou` with the item in `awaiting-stage` |
| `ready` | queue `needsYou` with the item in `ready` |
| `landed` | queue `needsYou` with the item in `landed` |
| `blocked` | `onRunSettled` with a run in `blocked` or `failed` that belongs to a queue item |
| `permission` | a permission attention item is raised |
| `slow` | a loop (slow job) attention item is raised |
| `sync-failed` | status sync `onFailed` |

Queue `needsYou` in any other state (auto-picked, queue paused, moved repos) sends nothing. Run done is covered by `ready`, `stage-ready` and `landed`, so there is no separate run-done event.

### Body

`POST` with `Content-Type: application/json`, `Authorization: Bearer <key>` and `X-Automation-Key: <key>`.

```ts
type NotifyEvent = {
  eventId: string; event: NotifyEventName; at: string
  queueItemId: string | null; runId: string | null; taskId: string | null; taskUrl: string | null; title: string
  node: string | null; itemState: QueueState | null; runStatus: RunStatus | null; clickupStatus: string | null
  detail: string; questions: string[]; options: string[]; recommended: string | null
  mockups: { option: string; name: string; mime: 'image/png'; base64: string }[]
  landStage: string | null
}
```

- `detail` is the reason, error or question text, cut to 2000 characters.
- `mockups` are read when the event is sent, from `<worktree>/<pick.path>/renders/<option lower>.png` (see `client/queue-review-decide.ts` and `server/queue-mockups.ts`). A missing file is left out.
- There is no `uiUrl`. The bot runs on another machine and cannot reach `127.0.0.1`. `taskUrl` is the ClickUp link.

### Delivery

- `createNotifier(deps)` in `server/notify.ts` keeps an outbox at `<configDir>/notify-outbox.json`: `{ pending: Pending[], last: Record<string, string> }`, written with `atomicJson`.
- `emit` builds the event, skips it when no URL is configured, and skips it when `last[<itemId or jobId>:<event>]` already equals `<itemState>|<detail>`. Otherwise it records that fingerprint and appends the event with a fresh `eventId`. That is what stops repeats on sweep, re-raise and restart.
- Each pending event is retried after 10 s, 1 min, 5 min, then every 30 min, until a 2xx. Every retry sends the same `eventId`. Pending events resume after a restart.
- Each request has a 30 s timeout.

### CLI and app parity

- `GET /api/notify` returns `{ configured, url, keyConfigured, pending }`. `POST /api/notify/test` sends a sample event straight away and returns the HTTP status.
- `shiki notify status`, `shiki notify test`, `shiki notify set-url <url>`, `shiki notify set-key -` (key on stdin, like `shiki plugin set`), `shiki notify clear`.
- The sample event carries real-sized images: the mockups of the most recent queue item with a pick, or else three 800 KB sample blobs, so a size limit on the bot's side shows up on the first test.
- `man/shiki.1` documents the commands and the outbox file, and its NOT COVERED section no longer says secrets are browser-only.

## As built

These differ from the plan above, and the code follows this list.

- Dedupe keys. Each card has one key, `<itemId>:queue`. Its value fingerprints the state, the detail, the questions, the options, the number of builds, the run's attempts, and the land stage with its start time. So a follow-up question after a retry, the same failure after a resume, a pick, then a question, then a pick again, and a land retry all send, while a repeated alert with nothing new sends once. Permission events use `<jobId>:<requestId>:permission`. Blocked events use `<itemId>:<runId>:blocked:<attempts>`. The outbox keeps at most 500 fingerprints.
- A parked card's run is `currentRunId`, or else its last run, so `runId`, `node` and `runStatus` describe where the card stopped.
- Pending events are dropped only when someone clears the URL: the secrets route calls `notifier.clear()` when a patch sets `notifyWebhookUrl` to `null`, which is what `shiki notify clear` and the Studio Clear button send. A delivery that finds no URL, for example while `secrets.json` is being rewritten, retries on the normal ladder.
- At most 200 events wait at once. Beyond that the oldest is dropped and a persisted `dropped` counter goes up, shown by `GET /api/notify` and `shiki notify status`.
- `notifier.resume()` runs right after the notifier is created, before anything can emit, and an event that already has a retry timer is never started twice.
- A render over 5 MB is left out of `mockups`.
- The first status sync pass after boot adopts the current status of every card that is not queued or building, without calling ClickUp. Old landed cards are never pushed back to Closed, and a card already parked when this ships keeps its ClickUp status until its next change. Queued and building cards are sent normally.
- At most 4 `source.status` calls run at once. Writing `syncedStatus` does not change the card's `updatedAt`.
- A sync-failed alert is resolved once the card no longer wants a status, or wants the one ClickUp already has.
- `POST /api/notify/test` answers 400 with no URL and 502 when the bot refuses, so `shiki notify test` exits non-zero.
- The sync module takes an `onSynced` callback, and index.ts resolves the `queue-sync:<id>` alert there, so the module never owns the attention store. `reconcile()` returns its pass as a promise so tests can wait on it.
- A building card whose run is blocked keeps its status, and so does a building card whose run is not `currentRunId`.
- The attention sweep used to read every kind-`queue` key as `queue:<id>`, which dropped `queue-sync:` alerts on the next store change. It now parses both prefixes.
- Status sync has no `shiki` command of its own. It has no user action, and `statusMap` is set with `shiki plugin set fixstack statusMap -`.

## Rollout

The ClickUp plugin with `source.status` ships first, then core, then the fixstack plugin with `sourceStatus`. In the other order, every active card would retry three times and raise a sync-failed alert.
