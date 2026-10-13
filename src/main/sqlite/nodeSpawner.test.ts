import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WorkerResponse } from './protocol'
import { nodeSqliteSpawner } from './nodeSpawner'

/** A stand-in worker: answers every request with its op (the real one is nodeWorker.ts). */
const ECHO_WORKER = `
process.on('message', (m) => {
  process.send({ id: m.id, ok: true, result: { op: m.op, big: 10n ** 20n, bytes: new Uint8Array([1, 2]) } })
})
`

const nextExit = (onExit: (l: (code: number | null) => void) => void) =>
  new Promise<number | null>((resolve) => onExit(resolve))

describe('nodeSqliteSpawner', () => {
  let dir: string
  let entry: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-node-spawner-'))
    entry = join(dir, 'echo.cjs')
    writeFileSync(entry, ECHO_WORKER)
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips requests with bigint and bytes, and reports the kill', async () => {
    const pids: number[] = []
    const proc = nodeSqliteSpawner(entry, { onSpawn: (c) => pids.push(c.pid!) })()
    const answer = new Promise<WorkerResponse>((resolve) => proc.onMessage(resolve))
    proc.postMessage({ id: 1, op: 'ping', args: [] })
    expect(await answer).toEqual({
      id: 1,
      ok: true,
      result: { op: 'ping', big: 10n ** 20n, bytes: new Uint8Array([1, 2]) }
    })
    expect(pids).toHaveLength(1)
    const exit = nextExit(proc.onExit)
    proc.kill()
    expect(await exit).toBeNull()
  })

  it('survives a message to a dead process and reports exit to late listeners', async () => {
    const proc = nodeSqliteSpawner(entry)()
    const exit = nextExit(proc.onExit)
    proc.kill()
    await exit
    // No uncaught ERR_IPC_CHANNEL_CLOSED: the error goes to the send callback.
    proc.postMessage({ id: 2, op: 'ping', args: [] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await nextExit(proc.onExit)).toBeNull()
  })

  it('reports a worker that never starts as exited instead of throwing', async () => {
    const proc = nodeSqliteSpawner(entry, { execPath: join(dir, 'no-such-node') })()
    expect(await nextExit(proc.onExit)).toBeNull()
  })
})
