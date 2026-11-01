import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// shortcut: only pstack is unloaded; add other orchestrator plugins here when needed
const ORCHESTRATOR_PLUGINS = ['pstack']

export function workerPluginSettings(claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')): string | null {
  let enabled: unknown
  try { enabled = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'))?.enabledPlugins } catch { return null }
  if (!enabled || typeof enabled !== 'object') return null
  const off = Object.entries(enabled).filter(([key, on]) => on === true && ORCHESTRATOR_PLUGINS.includes(key.split('@')[0]))
  return off.length ? JSON.stringify({ enabledPlugins: Object.fromEntries(off.map(([key]) => [key, false])) }) : null
}
