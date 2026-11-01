export function executionPlan(body: string): string {
  return `${body}
## Decisions
1. Exactly as written.
## Preserve
- Everything not named below (server/index.ts).
## Steps
### Step 1 — server/index.ts
Do the work.
Done means all of these hold, verified by you before you report:
1. The assignment's acceptance criteria are met.`
}
