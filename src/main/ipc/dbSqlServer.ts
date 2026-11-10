/**
 * db:* channels for SQL Server connections (docs/sqlserver-design.md). ipc/db.ts
 * routes here by the connection's engine.
 *
 * Addressing: every object channel needs `{ database, schema }` (like
 * PostgreSQL); a plain string SchemaRef is refused so no renderer path can
 * act on the wrong database. Writes go through the production guard; SQL
 * Server has no read-only session mode, so the guard is the dialect's
 * classifier (main denylist + renderer allowlist), as for MySQL.
 */
import { quoteIdent } from '@shared/dialects/sqlserver'
import type { IpcArgs, IpcChannel, IpcResult } from '@shared/ipc'
import type {
  EngineObjectType,
  NameRef,
  ObjectRef,
  QueryExecuteOptions,
  QueryStatementResult,
  SchemaRef,
  TabSessionState,
  WriteOptions
} from '@shared/types'
import type { AppContext } from '../context'
import type { ConnectionManager } from '../db/manager'
import { CAPABILITY_MESSAGES } from '../db/errors'
import { sqlserverOf } from '../sqlserver/client'
import { isMsConnection, type MsDriverConnection, type TabSession } from '../sqlserver/connection'
import { MsUserError } from '../sqlserver/errors'
import * as introspect from '../sqlserver/introspect'
import { executeMsScript, newDescribeCache, type DescribeCache } from '../sqlserver/query'
import { applyMsRowChanges } from '../sqlserver/rowChanges'
import type { MsSession } from '../sqlserver/session'
import { fetchMsTableData } from '../sqlserver/tableData'
import { buildMsFilterWhere } from '../sqlserver/tableFilter'
import { assertProductionWriteConfirmed, assertScriptAllowed } from './productionGuard'

export const MISSING_DATABASE = 'Falta la base de datos: actualiza la vista'

type H<C extends IpcChannel> = (...args: IpcArgs<C>) => Promise<IpcResult<C>>

export interface MsDbHandlers {
  databases: H<'db:databases'>
  schemas: H<'db:schemas'>
  tables: H<'db:tables'>
  views: H<'db:views'>
  routines: H<'db:routines'>
  triggers: H<'db:triggers'>
  columns: H<'db:columns'>
  tableStructure: H<'db:tableStructure'>
  showCreate: H<'db:showCreate'>
  objects: H<'db:objects'>
  closeDatabase: H<'db:closeDatabase'>
  dataTypes: H<'db:dataTypes'>
  tableData: H<'db:tableData'>
  tableFilterSql: H<'db:tableFilterSql'>
  applyRowChanges: H<'db:applyRowChanges'>
  execute: H<'db:execute'>
  dropObject: H<'db:dropObject'>
  createDatabase(
    id: string,
    name: string,
    options?: WriteOptions,
    engineOptions?: Record<string, string>
  ): Promise<void>
  dropDatabase: H<'db:dropDatabase'>
  cancel: H<'db:cancel'>
  sessionState: H<'db:sessionState'>
  commit: H<'db:commit'>
  rollback: H<'db:rollback'>
  closeSession: H<'db:closeSession'>
}

export interface MsScope {
  database: string
  schema: string
}

/** `{ database, schema }` of a SQL Server call; a plain string is refused. */
export function msScope(ref: SchemaRef | null | undefined): MsScope {
  if (!ref || typeof ref === 'string' || !ref.database)
    throw new MsUserError(MISSING_DATABASE, 'E_MS_SCOPE')
  if (typeof ref.schema !== 'string') throw new MsUserError(MISSING_DATABASE, 'E_MS_SCOPE')
  return { database: ref.database, schema: ref.schema }
}

function requireSchema(scope: MsScope): MsScope {
  if (!scope.schema) throw new MsUserError('Falta el esquema: actualiza la vista', 'E_MS_SCOPE')
  return scope
}

function objectRef(type: EngineObjectType, name: NameRef): ObjectRef {
  if (typeof name === 'string') return { type, name }
  return { ...name, type: name.type ?? type }
}

/** Per tab session: descriptions of single-query batches (result sources). */
const tabCaches = new WeakMap<TabSession, DescribeCache>()

export function createMsDbHandlers(ctx: AppContext, manager: ConnectionManager): MsDbHandlers {
  const connectionOf = async (id: string): Promise<MsDriverConnection> => {
    const connection = await manager.connection(id)
    if (!isMsConnection(connection))
      throw new MsUserError('La conexión no es SQL Server', 'E_MS_ENGINE')
    return connection
  }

  /** Runs `fn` on a pooled session of `database`, always releasing it. */
  const withSession = async <T>(
    id: string,
    database: string | null,
    fn: (session: MsSession, connection: MsDriverConnection) => Promise<T>
  ): Promise<T> => {
    const connection = await connectionOf(id)
    const session = await connection.acquire(database ? { database, schema: null } : null)
    try {
      return await fn(session, connection)
    } finally {
      await session.release().catch(() => undefined)
    }
  }

  const showSystem = (id: string): boolean =>
    sqlserverOf(ctx.connections.get(id) ?? {}).showSystemObjects === true

  /** Marks a pooled session that ran a write, so its release resets it. */
  const writing = (s: MsSession): MsSession => {
    s.usage.userSql = true
    return s
  }

  async function runOnTab(
    connection: MsDriverConnection,
    key: string,
    database: string,
    sql: string,
    options: QueryExecuteOptions
  ): Promise<QueryStatementResult[]> {
    let tab = connection.tabSession(key)
    if (tab?.lost) {
      const reason = tab.lost
      await connection.closeTabSession(key)
      throw new MsUserError(`${reason}. Vuelve a ejecutar la consulta.`, 'E_MS_SESSION_LOST')
    }
    tab = await connection.openTabSession(key, database)
    const current = tab
    // The tab's database combo decides every run: a `USE` in an earlier run is undone here
    // (within one script it still applies, as in SSMS).
    if (current.currentDatabase.toLowerCase() !== database.toLowerCase()) {
      await current.session.exec(`USE ${quoteIdent(database, true)}`)
      current.currentDatabase = database
    }
    let cache = tabCaches.get(current)
    if (!cache) {
      cache = newDescribeCache()
      tabCaches.set(current, cache)
    }
    const executionId = options.executionId
    connection.registerExecution(executionId, current.session)
    try {
      return await executeMsScript(
        current.session,
        sql,
        options,
        ctx.settings.get().defaultRowLimit,
        {
          cancelled: () => connection.isCancelled(executionId),
          afterBatch: async (results) => {
            try {
              await current.refresh()
            } catch {
              /* keep the last known state */
            }
            // No effectiveSchema: SCHEMA_NAME() is the user's default schema, not the tab's
            // choice, and the renderer would move the tab's schema combo to it.
            for (const r of results) r.transactionStatus = current.status
          }
        },
        cache
      )
    } finally {
      connection.unregisterExecution(executionId)
      current.lastUsed = Date.now()
    }
  }

  async function runPooled(
    connection: MsDriverConnection,
    database: string,
    sql: string,
    options: QueryExecuteOptions
  ): Promise<QueryStatementResult[]> {
    const session = writing(await connection.acquire({ database, schema: null }))
    const executionId = options.executionId
    connection.registerExecution(executionId, session)
    try {
      return await executeMsScript(session, sql, options, ctx.settings.get().defaultRowLimit, {
        cancelled: () => connection.isCancelled(executionId)
      })
    } finally {
      connection.unregisterExecution(executionId)
      await session.release().catch(() => undefined)
    }
  }

  async function endTransaction(
    connection: MsDriverConnection,
    key: string,
    command: 'COMMIT' | 'ROLLBACK'
  ): Promise<TabSessionState> {
    const tab = connection.tabSession(key)
    if (!tab) return closedState()
    if (tab.lost) {
      const reason = tab.lost
      await connection.closeTabSession(key)
      throw new MsUserError(reason, 'E_MS_SESSION_LOST')
    }
    // COMMIT only lowers @@TRANCOUNT by one: «Confirmar» commits every nested level.
    await tab.session.exec(
      command === 'COMMIT'
        ? 'WHILE @@TRANCOUNT > 0 COMMIT TRANSACTION'
        : 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION'
    )
    await tab.refresh().catch(() => undefined)
    return tab.state()
  }

  return {
    databases: async (id) =>
      withSession(id, null, (s) => introspect.listDatabases(s, showSystem(id))),
    schemas: async (id, database) =>
      withSession(id, database, (s) => introspect.listSchemas(s, showSystem(id))),
    tables: async (id, ref) => {
      const scope = requireSchema(msScope(ref))
      return withSession(id, scope.database, (s) => introspect.listTables(s, scope.schema))
    },
    views: async (id, ref) => {
      const scope = requireSchema(msScope(ref))
      return withSession(id, scope.database, (s) => introspect.listViews(s, scope.schema))
    },
    routines: async (id, ref) => {
      const scope = requireSchema(msScope(ref))
      return withSession(id, scope.database, (s) => introspect.listRoutines(s, scope.schema))
    },
    triggers: async (id, ref) => {
      const scope = requireSchema(msScope(ref))
      return withSession(id, scope.database, (s) => introspect.listTriggers(s, scope.schema))
    },
    columns: async (id, ref, table) => {
      const scope = requireSchema(msScope(ref))
      return withSession(id, scope.database, (s) => introspect.listColumns(s, scope.schema, table))
    },
    tableStructure: async (id, ref, table) => {
      const scope = requireSchema(msScope(ref))
      return withSession(id, scope.database, (s) =>
        introspect.tableStructure(s, scope.database, scope.schema, table)
      )
    },
    showCreate: async (id, ref, type, name) => {
      const scope = requireSchema(msScope(ref))
      return withSession(id, scope.database, (s) =>
        introspect.objectDdl(s, scope.schema, objectRef(type, name))
      )
    },
    objects: async (id, ref, type) => {
      const scope = requireSchema(msScope(ref))
      return withSession(id, scope.database, (s) => introspect.listObjects(s, scope.schema, type))
    },
    closeDatabase: async (id, database) => {
      if (!manager.isOpen(id)) return
      const connection = await connectionOf(id)
      await connection.closeDatabaseFromTree(database)
    },
    dataTypes: async (id, database) =>
      withSession(id, database, (s) => introspect.listDataTypes(s)),
    tableData: async (id, request) => {
      const scope = requireSchema(msScope(request.schema))
      return withSession(id, scope.database, (s) =>
        fetchMsTableData(s, request, { schema: scope.schema, table: request.table })
      )
    },
    tableFilterSql: async (id, ref, table, filter) => {
      const scope = requireSchema(msScope(ref))
      return withSession(id, scope.database, async (s) => {
        const columns = await introspect.listColumns(s, scope.schema, table)
        return buildMsFilterWhere(
          filter,
          columns.map((c) => ({ name: c.name, typeKind: c.typeKind, dataType: c.dataType }))
        )
      })
    },
    applyRowChanges: async (id, ref, table, changes, options) => {
      const scope = requireSchema(msScope(ref))
      if (changes.length) assertProductionWriteConfirmed(ctx, id, options, 'Modificar filas')
      return withSession(id, scope.database, async (s) => {
        const columns = await introspect.listColumns(s, scope.schema, table)
        const primaryKey = await introspect.primaryKeyColumns(s, scope.schema, table)
        return applyMsRowChanges(writing(s), scope.schema, table, changes, columns, primaryKey)
      })
    },
    execute: async (id, sql, options = {}) => {
      assertScriptAllowed(ctx, id, sql, options)
      const connection = await connectionOf(id)
      const ref = options.schema
      if (typeof ref === 'string' && ref) throw new MsUserError(MISSING_DATABASE, 'E_MS_SCOPE')
      const database =
        ref && typeof ref === 'object' && ref.database ? ref.database : connection.initialDatabase
      return options.sessionKey
        ? runOnTab(connection, options.sessionKey, database, sql, options)
        : runPooled(connection, database, sql, options)
    },
    dropObject: async (id, ref, type, name, options) => {
      const scope = requireSchema(msScope(ref))
      const objectName = typeof name === 'string' ? name : name.name
      assertProductionWriteConfirmed(ctx, id, options, `Eliminar ${objectName}`)
      return withSession(id, scope.database, (s) =>
        introspect.dropObject(writing(s), scope.schema, objectRef(type, name))
      )
    },
    createDatabase: async (id, name, options, engineOptions) => {
      assertProductionWriteConfirmed(ctx, id, options, `Crear la base de datos ${name}`)
      return withSession(id, null, (s) =>
        introspect.createDatabase(writing(s), name, engineOptions ?? {})
      )
    },
    dropDatabase: async (id, name, options) => {
      assertProductionWriteConfirmed(ctx, id, options, `Eliminar la base de datos ${name}`)
      const connection = await connectionOf(id)
      // Our own sessions on it would block DROP DATABASE: close them first.
      if (name !== connection.initialDatabase) await connection.closeDatabase(name)
      return withSession(id, null, (s, c) =>
        introspect.dropDatabase(writing(s), name, c.initialDatabase)
      )
    },
    cancel: async (id, executionId) => {
      const connection = await connectionOf(id)
      return connection.cancel(executionId)
    },
    sessionState: async (id, key) => {
      if (!manager.isOpen(id)) return closedState()
      const connection = await connectionOf(id)
      const tab = connection.tabSession(key)
      if (!tab) return closedState()
      if (tab.lost) {
        const reason = tab.lost
        await connection.closeTabSession(key)
        throw new MsUserError(reason, 'E_MS_SESSION_LOST')
      }
      return tab.state()
    },
    commit: async (id, key, options) => {
      assertProductionWriteConfirmed(ctx, id, options, 'Confirmar la transacción (COMMIT)')
      return endTransaction(await connectionOf(id), key, 'COMMIT')
    },
    rollback: async (id, key) => endTransaction(await connectionOf(id), key, 'ROLLBACK'),
    closeSession: async (id, key) => {
      if (!manager.isOpen(id)) return
      const connection = await connectionOf(id)
      await connection.closeTabSession(key)
    }
  }
}

function closedState(): TabSessionState {
  return { open: false, transactionStatus: 'idle', effectiveSchema: null, database: null }
}

/** Main-side capability refusals for SQL Server (the renderer never calls these). */
export const MS_REFUSED = {
  events: CAPABILITY_MESSAGES.events,
  users: (name: string): string =>
    `La lista de inicios de sesión y usuarios de SQL Server todavía no está disponible («${name}»).`,
  charsets:
    'SQL Server no usa juegos de caracteres por tabla: la intercalación (collation) se elige en la base de datos o en cada columna.',
  extensions: 'Las extensiones son de PostgreSQL: SQL Server no las tiene.'
} as const
