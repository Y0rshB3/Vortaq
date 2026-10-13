/**
 * Builds Vortaq's core for a host that is not the Electron app (the editor
 * extension, Node tests): the same AppContext, connection manager and IPC
 * handlers the desktop app registers, with the Electron-only pieces replaced
 * by the ports the host passes in (docs/vscode-extension-design.md).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IpcArgs, IpcChannel, IpcEventChannel, IpcEventMap, IpcResult } from '@shared/ipc'
import type { LogEvent } from '@shared/types'
import type { AppContext } from '@main/context'
import type { FetchFn } from '@main/ai/adapter'
import { setAiFetch } from '@main/ai/index'
import { CredentialStore, type CodecName, type SecretCodec } from '@main/credentials/store'
import { getConnectionManager, type ConnectionManager } from '@main/db/manager'
import { registerAiHandlers } from '@main/ipc/ai'
import { registerBackupsHandlers } from '@main/ipc/backups'
import { registerConnectionsHandlers } from '@main/ipc/connections'
import { registerDbHandlers } from '@main/ipc/db'
import { registerFiltersHandlers } from '@main/ipc/filters'
import { HandlerRegistry } from '@main/ipc/router'
import { configureLog } from '@main/log'
import { setSqliteSpawner, type ProcessSpawner } from '@main/sqlite/spawner'
import { setJsonStoreReload } from '@main/storage/jsonStore'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'

export interface CoreOptions {
  /**
   * The host's own profile folder: connections.json, settings.json,
   * credentials.json, filter profiles and the assistant's notes. Never the
   * desktop app's profile: the extension keeps its own data and secrets.
   */
  dataDir: string
  /**
   * How credentials.json values are encoded. The extension passes
   * keyCodec(<key kept in VS Code SecretStorage>) with codecName 'vaultKey'.
   */
  secrets: { codec: SecretCodec; codecName: CodecName }
  /** Home folder for the default backup folder (default: os.homedir()). */
  home?: string
  /** Push events for the host's views: progress, connection lost, assistant deltas. */
  emit?: <E extends IpcEventChannel>(channel: E, payload: IpcEventMap[E]) => void
  /**
   * SQLite worker spawner, normally nodeSqliteSpawner(<bundled sqliteWorker.cjs>).
   * Without one, opening a SQLite connection fails with an actionable message.
   */
  sqliteSpawner?: ProcessSpawner
  /** Network function of the AI provider calls (default: Node's global fetch). */
  fetch?: FetchFn
  /**
   * Log file and/or sink (an output channel). The rules do not change: the
   * core never logs secrets, query data or server text that may quote rows.
   */
  log?: {
    filePath?: string | null
    minLevel?: LogEvent['level']
    sink?: ((event: LogEvent) => void) | null
  }
}

export interface VortaqCore {
  readonly context: AppContext
  readonly connections: ConnectionManager
  /**
   * Same contract as the renderer's window.vortaq.invoke for the core
   * channels (connections:*, db:*, sqlite:*, mongo:*, filters:*, backups:*,
   * ai:*): same handlers, same production guard, same error messages.
   */
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>>
  /** The channels this core answers. */
  channels(): IpcChannel[]
  /** Closes every connection, SSH tunnel and SQLite worker. */
  dispose(): Promise<void>
}

/**
 * Creates the core. The SQLite spawner, the AI fetch and the log settings are
 * process-wide (one core per process, like the desktop app's one context).
 * Several processes may use the same dataDir (one per editor window): the JSON
 * files are re-read when another process changed them.
 */
export function createCore(options: CoreOptions): VortaqCore {
  // Several processes may share the profile (one extension host per editor window): each
  // store re-reads a file another process rewrote instead of overwriting it with a stale copy.
  setJsonStoreReload(true)
  if (options.log) configureLog(options.log)
  if (options.sqliteSpawner) setSqliteSpawner(options.sqliteSpawner)
  if (options.fetch) setAiFetch(options.fetch)
  const dir = options.dataDir
  const context: AppContext = {
    userDataPath: dir,
    logDir: join(dir, 'logs'),
    connections: new ConnectionsRepo(dir),
    jobs: new JobsRepo(dir),
    runs: new RunsRepo(dir),
    settings: new SettingsRepo(dir, options.home ?? homedir()),
    credentials: new CredentialStore(dir, options.secrets.codec, options.secrets.codecName),
    emit: options.emit ?? (() => undefined),
    headless: false
  }
  const registry = new HandlerRegistry()
  registerConnectionsHandlers(context, registry.handle)
  registerDbHandlers(context, registry.handle)
  registerFiltersHandlers(context, registry.handle)
  registerBackupsHandlers(context, registry.handle)
  registerAiHandlers(context, registry.handle)
  const connections = getConnectionManager(context)
  return {
    context,
    connections,
    invoke: (channel, ...args) => registry.invoke(channel, ...args),
    channels: () => registry.channels(),
    dispose: () => connections.closeAll()
  }
}
