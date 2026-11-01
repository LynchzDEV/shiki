import { existsSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { EngineName } from './engines'
import { configDir } from './secrets'
import { readEnv } from './env'

export const WORKER_CLAUDE_MD = `# Shikidan worker
You are a headless worker job spawned by Shikidan. The prompt is your whole spec.
- Implement directly in this working tree. Never dispatch jobs, post plans, or call any cockpit API.
- Do not commit or push unless the prompt says so.
- While iterating, run only the tests for files you touched. Run the full suite once, at the end.
- Read a file once; keep what you learned. Do not re-read to "double check".
- Comments: max 1 line, only for a trap no refactor can express. No decision-record comment blocks.
- Stop when the prompt's acceptance criteria are met. Final message: files changed, test count, anything not done.

House rules for the code you write:
- Names describe purpose and follow the language's conventions; never update, fix, temp, data, test as names.
- Write the test first, in the style of the nearest existing test in this repo.
- Prefer new values over mutating existing ones; early returns over nesting; functions under 50 lines.
- No hardcoded secrets, no leftover debug output.
- Do not match the surrounding code's comment density; dense files are legacy, not license.
- If the prompt and this file disagree, stop and report the conflict instead of choosing.`

export const WORKER_CLAUDE_SETTINGS = {
  permissions: { defaultMode: 'bypassPermissions' },
  skipDangerousModePermissionPrompt: true,
}

export const WORKER_CODEX_CONFIG = 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n'

export function workerProfileDirs(configDirOverride?: string): { claude: string; codex: string } {
  const base = configDirOverride ?? configDir()
  return { claude: join(base, 'worker-claude'), codex: join(base, 'worker-codex') }
}

export async function ensureWorkerProfiles(
  opts: { configDir?: string; codexAuthPath?: string } = {},
): Promise<{ claude: string; codex: string }> {
  const dirs = workerProfileDirs(opts.configDir)
  try {
    await mkdir(dirs.claude, { recursive: true, mode: 0o700 })
    await mkdir(dirs.codex, { recursive: true, mode: 0o700 })
    await writeFile(join(dirs.claude, 'CLAUDE.md'), WORKER_CLAUDE_MD)
    await writeFile(join(dirs.claude, 'settings.json'), `${JSON.stringify(WORKER_CLAUDE_SETTINGS, null, 2)}\n`)
    await writeFile(join(dirs.codex, 'config.toml'), WORKER_CODEX_CONFIG)
    if (!existsSync(join(dirs.codex, 'auth.json'))) {
      const source = opts.codexAuthPath ?? join(homedir(), '.codex', 'auth.json')
      if (existsSync(source)) await symlink(source, join(dirs.codex, 'auth.json'))
    }
  } catch (error) {
    console.error('worker profiles: setup failed -', error)
  }
  return dirs
}

export function fullAgentSetup(): boolean {
  return readEnv('FULL_AGENT_SETUP') === '1'
}

export function workerEnv(engine: EngineName, dirs: { claude: string; codex: string }): Record<string, string> {
  if (fullAgentSetup()) return {}
  if (engine === 'glm') return { CLAUDE_CONFIG_DIR: dirs.claude }
  if (engine === 'codex') return { CODEX_HOME: dirs.codex }
  return {}
}
