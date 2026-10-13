/**
 * Whether this process's Node can run the SQLite driver. The desktop app
 * always can (Electron 44, Node 24.20); an editor's extension host runs the
 * editor's own Node, which may be older (docs/vscode-extension-design.md,
 * "SQLite in the editors"). The worker is forked with the same binary, so
 * checking here answers for it too.
 *
 * The newest API the driver needs is DatabaseSync#setAuthorizer (Node 24.10),
 * which denies ATTACH of missing or relative paths; columns() (22.16) and
 * setReturnArrays (24.0) come before it. Without it the driver must not open
 * files at all (fail closed), so this reports a problem instead.
 */

export interface SqliteRuntime {
  /** process.versions.node */
  version: string
  /** process.getBuiltinModule (Node 22.3+); undefined on older Node. */
  getBuiltinModule?: (id: string) => unknown
}

const MIN_NODE = '24.10'

function currentRuntime(): SqliteRuntime {
  const p = process as unknown as { getBuiltinModule?: (id: string) => unknown }
  return {
    version: process.versions.node,
    getBuiltinModule: p.getBuiltinModule ? (id) => p.getBuiltinModule!(id) : undefined
  }
}

/** Spanish message for the UI when SQLite cannot run here, else null. */
export function sqliteRuntimeProblem(runtime: SqliteRuntime = currentRuntime()): string | null {
  const sqlite = runtime.getBuiltinModule?.('node:sqlite') as
    { DatabaseSync?: { prototype?: Record<string, unknown> } } | undefined
  const database = sqlite?.DatabaseSync?.prototype
  if (!database)
    return `Las conexiones SQLite necesitan Node ${MIN_NODE} o posterior, y este editor usa Node ${runtime.version} sin el módulo node:sqlite.`
  if (typeof database.setAuthorizer !== 'function')
    return `Las conexiones SQLite necesitan Node ${MIN_NODE} o posterior: con Node ${runtime.version}, el de este editor, Vortaq no puede impedir que un script adjunte otros archivos.`
  return null
}
