import { expect, test } from 'bun:test'
import { join } from 'node:path'

// Own process: client/shell.ts binds to the shell markup when it loads, so it needs its own DOM and module cache.
test('phone shell (own process)', () => {
  const run = Bun.spawnSync([process.execPath, 'test', './test/phone-shell.dom.ts'], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' })
  const output = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(output)
  expect(output).toMatch(/\b0 fail\b/)
  expect(run.exitCode).toBe(0)
}, 120000)
