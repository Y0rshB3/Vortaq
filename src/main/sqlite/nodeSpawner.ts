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
  /**
   * Node binary for the worker (default: this process's). A host whose own Node
   * is too old for the driver can point it at a newer one.
   */
  execPath?: string
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
      ...(options.execPath ? { execPath: options.execPath } : {}),
      // Rows carry bigint and Uint8Array values: the default JSON channel would lose them.
      serialization: 'advanced',
      env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
    })
    options.onSpawn?.(child)
    // Exit is reported once, whether the process exits or never starts (a failed
    // fork emits 'error' and no 'exit'), so the client always learns it is gone.
    const exitListeners: ((code: number | null) => void)[] = []
    let exitCode: number | null | undefined
    const exited = (code: number | null): void => {
      if (exitCode !== undefined) return
      exitCode = code
      for (const listener of exitListeners.splice(0)) listener(code)
    }
    child.once('exit', (code) => exited(code))
    // Without a listener an 'error' (failed fork, closed IPC channel) would be an
    // uncaught exception in the host process.
    child.on('error', () => {
      if (child.pid === undefined) exited(null)
    })
    const proc: WorkerProcess = {
      postMessage: (message) => {
        // A closed channel never answers: end the process so 'exit' rejects the call.
        child.send(message, (err) => {
          if (err) child.kill('SIGKILL')
        })
      },
      onMessage: (listener) => {
        child.on('message', (message) => listener(message as WorkerResponse))
      },
      onExit: (listener) => {
        if (exitCode !== undefined) {
          const code = exitCode
          setImmediate(() => listener(code))
        } else exitListeners.push(listener)
      },
      kill: () => {
        child.kill('SIGKILL')
      }
    }
    return proc
  }
}
