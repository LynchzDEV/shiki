import { existsSync } from 'node:fs'

import { BUILTIN_AGENTS, SESSION_ENGINE, type AgentConnection } from './agent-connections'
import { ENGINES, type EngineName, fakeEnginesEnabled, resolveBinary } from './engines'
import type { QuotaComposite } from './quota'
import type { Secrets } from './secrets'

export type Unavailable = { reason: string; until: number | null }
export type AvailabilityCheck = (agent: { engine: string; connection?: AgentConnection }) => Promise<Unavailable | null>

type UsageWindow = { fiveHourPct?: number | null; weeklyPct?: number | null; fiveHourResetsAt?: string | null; weeklyResetsAt?: string | null }

const isBuiltin = (engine: string): engine is EngineName => (BUILTIN_AGENTS as readonly string[]).includes(engine)

function missingBinary(command: string): Unavailable | null {
  const path = resolveBinary(command)
  return path.includes('/') && existsSync(path) ? null : { reason: `${command} is not installed`, until: null }
}

function limitReached(usage: UsageWindow, now: number): number | null {
  const resets = [[usage.fiveHourPct, usage.fiveHourResetsAt], [usage.weeklyPct, usage.weeklyResetsAt]] as const
  const until = resets.flatMap(([pct, at]) => {
    const reset = at ? Date.parse(at) : NaN
    return typeof pct === 'number' && pct >= 100 && reset > now ? [reset] : []
  })
  return until.length ? Math.max(...until) : null
}

export function createAvailabilityCheck(deps: { secrets: () => Promise<Secrets>; quota: () => Promise<QuotaComposite>; now?: () => number }): AvailabilityCheck {
  const now = deps.now ?? Date.now
  return async ({ engine, connection }) => {
    if (engine === SESSION_ENGINE || fakeEnginesEnabled()) return null
    if (engine === 'glm' && !(await deps.secrets()).zaiAuthToken) return { reason: 'glm needs a z.ai token (Settings · GLM)', until: null }
    const missing = isBuiltin(engine) ? missingBinary(ENGINES[engine].cmd) : connection ? missingBinary(connection.command) : null
    if (missing) return missing
    const key = connection?.family === 'grok' ? 'grok' : isBuiltin(engine) ? engine : null
    if (!key || key === 'claude') return null
    const quota = await deps.quota().catch(() => null)
    const usage = quota?.[key]
    if (!usage?.available) return null
    const until = limitReached(usage, now())
    return until === null ? null : { reason: `${engine} usage limit reached`, until }
  }
}
