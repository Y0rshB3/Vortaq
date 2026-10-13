/**
 * The extension's Vortaq core: createCore() with this host's ports
 * (docs/vscode-extension-design.md, sections 3 and 9.2):
 * - profile folder: the extension's globalStorageUri (never the desktop app's);
 * - secrets: keyCodec with the vault key in SecretStorage (vault.ts);
 * - SQLite: nodeSqliteSpawner on VS Code's own Node, only when
 *   sqliteRuntimeProblem() says that Node can run the driver;
 * - logging: the «Vortaq» log output channel (never secrets or row data).
 */
import { mkdirSync } from 'node:fs'
import * as vscode from 'vscode'
import {
  createCore,
  nodeSqliteSpawner,
  sqliteRuntimeProblem,
  type IpcEventChannel,
  type IpcEventMap,
  type LogEvent,
  type VortaqCore
} from '@core'
import { loadVaultKey } from './vault'

export interface ExtensionCore {
  core: VortaqCore
  /** Spanish message when SQLite cannot run in this editor, else null. */
  sqliteProblem: string | null
  /** Passwords stored with a vault key SecretStorage no longer has (dropped, asked again). */
  droppedSecrets: number
}

type EventListener = <E extends IpcEventChannel>(channel: E, payload: IpcEventMap[E]) => void

/** Writes core log events to the output channel. The core never logs secrets or rows. */
export function logSink(output: vscode.LogOutputChannel): (event: LogEvent) => void {
  return (event) => {
    const line = `[${event.scope}] ${event.message}`
    if (event.level === 'error') output.error(line)
    else if (event.level === 'warn') output.warn(line)
    else if (event.level === 'debug') output.debug(line)
    else output.info(line)
  }
}

export async function createExtensionCore(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
  onEvent: EventListener
): Promise<ExtensionCore> {
  const dataDir = context.globalStorageUri.fsPath
  mkdirSync(dataDir, { recursive: true })
  const vault = await loadVaultKey(context.secrets)
  const sqliteProblem = sqliteRuntimeProblem()
  const core = createCore({
    dataDir,
    secrets: { codec: vault.codec, codecName: 'vaultKey' },
    // Without a spawner the core refuses SQLite with an actionable message (fail closed).
    sqliteSpawner: sqliteProblem
      ? undefined
      : nodeSqliteSpawner(context.asAbsolutePath('dist/sqliteWorker.cjs')),
    emit: onEvent,
    log: { filePath: null, minLevel: 'info', sink: logSink(output) }
  })
  const droppedSecrets = dropUndecryptable(core)
  if (droppedSecrets)
    output.warn(
      `${droppedSecrets} contraseña(s) guardada(s) no se pueden descifrar con la clave actual del almacén seguro: se pedirán de nuevo al conectar.`
    )
  if (sqliteProblem) output.warn(`SQLite no disponible: ${sqliteProblem}`)
  return { core, sqliteProblem, droppedSecrets }
}

/**
 * Removes stored secrets the current vault key cannot decrypt (SecretStorage
 * lost the key, or credentials.json came from somewhere else), so opening a
 * connection asks for its password instead of failing on every attempt.
 */
function dropUndecryptable(core: VortaqCore): number {
  const store = core.context.credentials
  const items = store.rawItems()
  const kept: Record<string, string> = {}
  let dropped = 0
  for (const [key, cipher] of Object.entries(items)) {
    try {
      store.decode(cipher)
      kept[key] = cipher
    } catch {
      dropped++
    }
  }
  if (dropped) store.replaceRaw(kept)
  return dropped
}
