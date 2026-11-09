# Design pick in ClickUp, mockups on <task>.shikidan.com

When a card parks for a design pick, the card owner is tagged in ClickUp with a link to the mockups. Their reply ("แบบ C") becomes the pick, so nobody relays it. Grok Bot only gets a heads-up.

Settled with the operator:

- Protection is an unguessable host plus no real screenshots. There is no Cloudflare Access.
- `shots/` (real portal screenshots from the card) is never published. Each image in it is replaced by a placeholder that says the screenshot is not published.
- Making mockups fit phones is a separate job.
- The bot's own ClickUp account (the token owner, from `GET /user`) is "me" (Palm). Verified: Shikidan's marked UAT comment on 14znf2futry was posted by user 101078127, Palm_TH_Jinnawat Vilairat.

## ClickUp plugin (skd-plugin-clickup v1.10.0)

`QueueSource` in core grows to match.

- `source.post` with `kind: 'ask'` takes optional `mention: string` (a numeric user id) and `assignee: string` (a numeric user id).
  - With a mention, the comment is sent as parts `[{ type: 'tag', user: { id } }, { text: ' ' + rest }]`, the same shape and read-back check as `postWithMention`.
  - With an assignee, the body has `assignee: Number(id)`. It always has `notify_all: true`.
  - The result gains `ref: string`, the ClickUp comment id. `commentId` stays the date cursor.
- New `source.people { id }` returns `{ creator: Person | null, assignees: Person[], me: Person }`, with `Person = { id: string; username: string }` and `me` from `GET /user`.
- New `source.resolve { id, ref }` marks comment `ref` resolved with `PUT /comment/{ref}`. Read the ClickUp API docs for the required body fields. It throws on failure.
- Every reply from `source.replies` gains `authorId: string` (`raw.user.id`, or `''` when missing).

## Core (shiki)

### Data on the card

`QueueItem.pick` gains an optional `ask`:

```ts
type PickAsk = { ref: string; ownerId: string; ownerName: string; meId: string; host: string | null; postedAt: number; error?: string }
```

`QueueItem` gains an optional `published`:

```ts
type Published = { sub: string; host: string; at: number }
```

The subdomain is chosen once per card and reused for later rounds.

### Who the owner is

The pure function `pickOwner({ creator, assignees, me })` returns a `Person`:

- With exactly one assignee, that assignee.
- Otherwise the creator.
- If the result is `null` or has `me.id`, it returns `me`.

### Parking at waiting-pick (queue-engine.ts, the `picked !== null` branch)

The auto-pick path is unchanged.

When the flow plugin's `automate` setting is `true` (full automate), the steps run in this order. Parking comes first, so a restart in the middle can never post a second ask:

1. Park in `waiting-pick` with a new `pick` that has no `ask`, exactly as today, but do not call `needsYou` yet.
2. Publish the mockups.
3. Call `people`.
4. Post the ask.
5. Store `pick.ask`, and overwrite `lastSeenId` with the ask's `commentId`. Never use `??` here, or older owner comments would be judged as picks.
6. Call `needsYou`, so the webhook `pick` event carries the host and the owner.

On any failure in steps 2 to 4, `pick.ask` is stored with `error` set, and `needsYou` is called with a reason that names the error. The pick can still be made in Shikidan.

Recovery: when `checkReplies` or `recover()` finds a `waiting-pick` card with full automate on and no `pick.ask`, it runs steps 2 to 6 once. A card that already has `pick.ask.ref` is never posted to again in the same round. A new round replaces `pick`, which clears `ask`.

`queueInput` in notify-events.ts returns `publish-failed` when `item.state === 'waiting-pick' && item.pick?.ask?.error !== undefined`, and `pick` otherwise.

With full automate off, the default, today's behavior is unchanged.

Every new round, including the one after `Option: none`, publishes again to the same subdomain and posts a new ask comment.

### The ask comment

```
รบกวน @<owner tag> ช่วยเลือกหน่อยครับว่าจะให้เป็นแบบไหนครับ https://<host>
A <description>
B <description> (แนะนำ)
C <description>
```

- The descriptions are the lines of `pick.summary` that start with an option id. An option with no such line shows only its id.
- The recommended option gets ` (แนะนำ)`.
- The plugin adds the invisible marker.

### Reading replies (`checkReplies`)

`checkReplies` also walks `waiting-pick` cards that have a `pick.ask` with no `error`. For each one:

- It reads replies since `lastSeenId` and advances `lastSeenId` past everything it read, so a reply is never judged twice.
- Replies whose `authorId` is the owner or `me` are judged in order. Others are appended to the card's answers file as context, the same way waiting-info replies are saved today, and never pick.
- The first judged reply that resolves to a pick or to none ends the loop.

`parsePickReply(text, options)` returns `{ kind: 'pick', option, note } | { kind: 'none', feedback } | { kind: 'unclear' }`. It is a pure function, case-insensitive.

- **none:** the text contains `ไม่เอาสักแบบ`, `ไม่ชอบเลย`, or the word `none`. The feedback is the text without that phrase, or the whole text when nothing else is left.
- **pick:** exactly one distinct option id appears as a standalone token, and the text has no negation (`ไม่`, `not`, `no`, `don't`). A token is standalone when no Latin letter or digit sits right before or after it, so `แบบC`, `C ครับ` and `(C)` all count. The note is the text with that token and the filler words removed (`แบบ`, `เอา`, `ข้อ`, `เลือก`, `ครับ`, `ค่ะ`, `คะ`, `นะ`), plus punctuation, trimmed. An empty note means none.
- **unclear:** anything else, which covers zero letters, two letters, or a negation.

Examples:

| Reply | Result |
|---|---|
| `C` | pick C |
| `c` | pick C |
| `แบบ C` | pick C |
| `เอา C` | pick C |
| `ข้อ C` | pick C |
| `C ครับ` | pick C |
| `เลือก C` | pick C |
| `C ครับ ปุ่มใหญ่ขึ้นหน่อย` | pick C, note `ปุ่มใหญ่ขึ้นหน่อย` |
| `ไม่เอา A` | unclear |
| `A หรือ C ดี` | unclear |
| `ไม่ชอบเลย อยากได้แบบเดิม` | none, feedback `อยากได้แบบเดิม` |

A reply that is a pick or none goes through the same `pick()` the route and CLI use, with the note or feedback. Then:

- The card posts the update `ได้ครับ ใช้แบบ <X>`, or for none `ได้ครับ จะทำแบบใหม่ตามนี้ครับ`.
- It calls `resolve` on `pick.ask.ref`.
- The webhook sends `picked` with the picker's name and the option.

Failures in the confirm or in `resolve` are logged and raise no alert. The pick stands.

An `unclear` reply sends the webhook `pick-unclear` with the reply text. The card keeps waiting.

Resolving the comment in ClickUp is never read as a pick.

### Polling

The core config gains `replyPollMinutes`, an integer from 1 to 15, default 2. The reply sweep in index.ts uses it and reschedules when it changes. It covers both questions and picks.

Cost per sweep: one comment-list request per waiting card, plus one thread request for each threaded comment up to `MAX_THREADS`. With five waiting cards and two threads each, that is 15 requests every 2 minutes, far below ClickUp's 100 per minute.

### Publishing and teardown (`server/publish.ts`)

- `publishDir()` is `<configDir>/published`. The core config gains `publishDomain` (default `shikidan.com`) and `publishKeepDays` (default 14, from 1 to 90).
- `publish(item)` copies `<worktree>/<pick.path>/` into `published/<sub>.tmp-<random>` and then renames it over `published/<sub>`.
  - It skips dotfiles, dot-directories, symlinks, and anything that is not a regular file or a directory.
  - The source must resolve, by realpath, inside the worktree.
  - Each file under `shots/` is replaced by the bundled placeholder `static-host/shot-unpublished.png`, under the same name.
  - The subdomain is `<externalId lowercased>-<8 chars of [a-z0-9] from crypto>`, and the host is `<sub>.<publishDomain>`.
- `unpublish(item)` removes `published/<sub>` and clears `item.published`. It runs in these cases:
  - The card reaches `landed`.
  - The card is removed from the queue.
  - `published.at` is older than `publishKeepDays`, checked by an hourly unref'd sweep.
  - `shiki queue unpublish <id>`, through `POST /api/queue/:id/unpublish`.

### Static host (`static-host/serve.ts`)

This is its own Bun process, separate from Shikidan. It never imports server code.

- It reads `SKD_PUBLISH_DIR` (default `~/.config/shikidan/published`), `SKD_STATIC_PORT` (default 7780) and `SKD_PUBLISH_DOMAIN` (default `shikidan.com`), and binds `127.0.0.1` only.
- The `Host` header must be `<sub>.<domain>`, optionally with a port, and `sub` must match `^[a-z0-9-]{1,80}$`. Every other host gets 404.
- It answers `GET` and `HEAD` only. Every other method gets 404.
- Path rules:
  - The path is URL-decoded once.
  - Any segment that is empty, `.`, `..`, or starts with `.`, or any path containing `\` or NUL, gets 404.
  - `/` serves `index.html`.
  - A directory gets 404.
  - A symlink gets 404, checked with `lstat` on each segment.
  - The realpath must sit inside `<publish>/<sub>`.
- Content type comes from the file extension. Every response carries `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Nothing is logged.
- Tests start it on a random port and use `fetch` with a `Host` header.

### Webhook

- `NotifyEventName` gains `picked`, `pick-unclear` and `publish-failed`.
- `NotifyEvent` gains `host: string | null`, `owner: string | null` and `pickedBy: string | null`.
- The `pick` event fills `host` and `owner`. `picked` fills `pickedBy` and puts the option in `detail`.

### CLI and app parity

- `shiki queue unpublish <id>`.
- `shiki queue poll <minutes>`, `shiki queue publish-domain <domain>` and `shiki queue publish-days <n>`, in the pattern of `queueParallel`.
- The man page lists them, the `published/` folder, and `static-host/serve.ts`.
- The queue screen shows the published link on a waiting-pick card when `pick.ask.host` is set.

## fixstack plugin (v0.1.21)

One toggle, `automate` ("Full automate"), default off. Off is legacy: the design pick waits in Shikidan, and the ClickUp status changes only when the UAT stage posts it. On asks the pick in ClickUp and moves the status at every step. It replaces the short-lived `pickIn` setting, and it also gates status sync: `statusMaps` returns `{}` for a plugin flow unless `automate` is `true`. Flows outside a plugin keep their own map.

## Operations (main session, with the operator)

- systemd user units for `static-host/serve.ts` and for `cloudflared tunnel run`.
- A named tunnel with ingress `*.shikidan.com → http://127.0.0.1:7780`, then `http_status:404`. Port 7777 never appears in it.
- A proxied wildcard CNAME through `cloudflared tunnel route dns <tunnel> '*.shikidan.com'`.
- The operator runs `cloudflared tunnel login` once.

## As built (after review)

These replace the earlier sections where they disagree.

- **Reply parsing is strict.** Only the first non-empty line decides. Filler words (แบบ, เอา, ข้อ, เลือก, ตัว, option, ครับ, ค่ะ, คะ, นะ, จ้า), spaces and punctuation are removed.
  - The none phrase on that line gives none.
  - Exactly one option id left gives a pick, and the lines after the first become the note.
  - Anything else is unclear: the card keeps waiting and the webhook sends `pick-unclear`.
  - So `C ครับ ปุ่มใหญ่ขึ้นหน่อย` on one line is unclear, while the same text with the note on the next line picks C. English sentences that happen to contain "a" never pick.
- **Publishing skips `renders/` and `verify/` at any depth.** The overview render shows the real screenshots as thumbnails. Any copied image whose bytes match an image the card downloaded from ClickUp is replaced by the placeholder.
- **Option lines come only from `## Options`** (`- A | subtitle | desc` becomes `A subtitle — desc`). The `## Recommendation` section is ignored.
- **The publish domain has no setting.** Core and the static host both use `SKD_PUBLISH_DOMAIN`, default `shikidan.com`. The static host listens on `SKD_STATIC_PORT`, default 7780.
- **An ask is marked `posting` before it is sent.** A restart that finds `posting` with no `ref` does not post again. It raises an alert asking the operator to check the card.
- **The age sweep never removes the folder of a card whose ask is still open.** The sweep also deletes leftover `*.tmp-*` and `*.gone-*` folders.
- **Leaving `waiting-pick` any other way closes the open ask.** That covers a pick in Shikidan or the CLI, a requeue, and a removal. The ask comment is resolved, and a pick also posts the confirm. Failures are only logged.
- **Cloudflare.** The tunnel is `shikidan-mockups` (`ac3b8ce6-3ee4-4a49-8094-87eb37e8c1d7`), configured in `~/.cloudflared/shikidan-mockups.yml` as `*.shikidan.com` to 127.0.0.1:7780, then 404. DNS has a proxied wildcard CNAME. `moni-redesign.shikidan.com` keeps its own record and tunnel. The user units are `shikidan-static-host.service` and `shikidan-mockups-tunnel.service`.

## Rollout order

The ClickUp plugin goes first, then core, then fixstack. Core needs `people`, `resolve` and `authorId`. Without them, every ask fails into the `publish-failed` path and the pick falls back to Shikidan.
