/**
 * Real-process SQLite worker for integration tests: src/main/sqlite/nodeWorker.ts
 * bundled once with esbuild (scripts/core-bundle.mjs; node:sqlite stays a builtin)
 * and forked as a Node child process by nodeSqliteSpawner, so cancel-by-kill is
 * measured on a real process.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessSpawner } from '@main/sqlite/spawner'
import { nodeSqliteSpawner } from '@main/sqlite/nodeSpawner'
import { bundleSqliteWorker } from '../../scripts/core-bundle.mjs'

let bundled: Promise<string> | null = null

/** The worker bundle in a temp folder (built once per test file). */
export function sqliteWorkerBundle(): Promise<string> {
  bundled ??= bundleSqliteWorker(
    join(mkdtempSync(join(tmpdir(), 'vortaq-sqlite-worker-')), 'nodeWorker.cjs')
  )
  return bundled
}

/** A spawner whose workers are real Node processes (bundled on first use). */
export async function childProcessSpawner(): Promise<ProcessSpawner & { pids: number[] }> {
  const pids: number[] = []
  const spawn = nodeSqliteSpawner(await sqliteWorkerBundle(), {
    onSpawn: (child) => {
      if (child.pid) pids.push(child.pid)
    }
  })
  const spawner = (() => spawn()) as ProcessSpawner & { pids: number[] }
  spawner.pids = pids
  return spawner
}
