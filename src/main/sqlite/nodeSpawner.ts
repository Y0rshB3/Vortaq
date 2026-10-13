/**
 * SQLite workers as Node child processes (`child_process.fork` of a bundled
 * nodeWorker.ts), for hosts without Electron's utilityProcess: the editor
 * extension host and the Node-only tests. The desktop app keeps
 * electronSpawner.ts; the worker handler is the same.
 *
 * A process, not a worker thread: node:sqlite runs a statement synchronously
 * inside sqlite3_step, and only killing the process stops a runaway one
 * (cancel by kill, docs/multi-engine-design.md section 5.6).
 */
import { fork, type ChildProcess } from 'node:child_process'
import type { WorkerResponse } from './protocol'
import type { ProcessSpawner, WorkerProcess } from './spawner'

export interface NodeSpawnerOptions {
  /** Called with each child right after it starts (tests track the pids). */
  onSpawn?: (child: ChildProcess) => void
}

/**
 * Spawner for `entry`, the nodeWorker.ts bundle (CommonJS, node:sqlite left
 * as a builtin). Inside an Electron-based host (VS Code's extension host)
 * process.execPath is the Electron binary, so the child gets
 * ELECTRON_RUN_AS_NODE=1 to start as plain Node. execArgv is not inherited:
 * a host started with --inspect would make every child fight for the port.
 */
export function nodeSqliteSpawner(entry: string, options: NodeSpawnerOptions = {}): ProcessSpawner {
  return () => {
    const child = fork(entry, [], {
      stdio: 'ignore',
      execArgv: [],
      // Rows carry bigint and Uint8Array values: the default JSON channel would lose them.
      serialization: 'advanced',
      env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
    })
    options.onSpawn?.(child)
    const proc: WorkerProcess = {
      postMessage: (message) => {
        child.send(message)
      },
      onMessage: (listener) => {
        child.on('message', (message) => listener(message as WorkerResponse))
      },
      onExit: (listener) => {
        child.once('exit', (code) => listener(code))
      },
      kill: () => {
        child.kill('SIGKILL')
      }
    }
    return proc
  }
}
