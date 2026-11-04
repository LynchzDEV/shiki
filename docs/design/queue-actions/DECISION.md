# Decision: queue card actions

**Chosen:** Variant A: each card shows one button for its next step and a `⋯` button that opens the sidebar's row menu with everything else.

**Why:** after Stop and Remove became available on every card, cards carried up to five actions in a row. The user picked A over the hover-icon tray (B) and the expand-for-actions card (C). The cockpit is often viewed from a phone, hover never shows on touch, and C costs a tap for everything but the main action.

**Real files to touch:** `client/queue-view.ts` (`actions()`), `client/queue.ts` (menu open state, outside click, Escape), `public/quiet.css` (`.q-more`, `.q-menu`), `server/views/shell.ts` (new `more-icon` symbol), `test/queue-dom.test.ts`, `test/sidebar-queue.dom.ts`.

**Implementation notes:**
- Main button per state: building → Watch; shipping → Log; waiting-pick → Pick; ready → Open run; failed → Retry stage (failed at a land stage), else Resume (has a run to resume), else Requeue; waiting for a stage → the stage's label (e.g. Deploy prod). Queued, waiting info and landed cards have no main button, only `⋯`.
- Menu order: safe actions first (Requeue, Start over, Open run, Report), a divider, then Stop and Remove in red.
- Stop and Remove on a running card (building, shipping, or a queued card getting its workspace ready) ask twice. The first click turns the row into "Confirm stop" or "Confirm remove" on red, and it disarms after 4 s. On any other card Remove acts on the first click, since opening the menu is already a deliberate step.
- Stop on a shipping card carries the note "A push or deploy cut short can leave the remote half-updated."
- The menu stays open across live repaints. It closes on any action, a click outside, or Escape. Only one menu is open at a time.
- "started N min ago" leaves the building card's action area; the step line in the card's details already says what is running.

**Rejected:** B: the icons only show on hover, which a phone never sends, and the icons need tooltips to be read. C: every action except the main one costs an extra tap, and opening a card would compete with clicking the card to watch its run.
