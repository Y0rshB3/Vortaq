import type { SchemaRef } from '@shared/types'
import { engineOf } from '@shared/engines'
import { mariadbDialect } from '@shared/dialects/mariadb'
import { mysqlDialect } from '@shared/dialects/mysql'
import type { AppContext } from '../context'
import { CAPABILITY_MESSAGES, DbUserError, requireConnectionCapability } from '../db/errors'
import { getConnectionManager } from '../db/manager'
import * as introspect from '../mysql/introspect'
import { executeScript } from '../mysql/query'
import { applyRowChanges, isBinaryDataType } from '../mysql/rowChanges'
import type { PooledSession } from '../mysql/session'
import { fetchTableData, filterColumns } from '../mysql/tableData'
import { buildFilterWhere } from '../mysql/tableFilter'
import { listUsers } from '../mysql/users'
import { createPgDbHandlers, PG_REFUSED } from './dbPostgres'
import { createSqliteDbHandlers, SQLITE_REFUSED } from './dbSqlite'
import {
  createMongoHandlers,
  MONGO_REFUSED,
  type MongoChannel,
  type MongoChannelHandlers
} from './mongo'
import { createSqliteFile } from '../sqlite/driver'
import { assertProductionWriteConfirmed, assertScriptAllowed } from './productionGuard'
import type { HandleFn, IpcHandler } from './router'

/**
 * MySQL takes the database as a plain string (v0.1.x). The object form is
 * PostgreSQL's; on a MySQL connection it is a renderer bug.
 */
function mysqlSchema(ref: SchemaRef): string {
  if (typeof ref === 'string') return ref
  throw new DbUserError('Las conexiones MySQL usan el nombre de la base de datos como esquema')
}

const CHANNEL_NOT_FOR_MYSQL = 'Esta operación no existe en las conexiones MySQL ni MariaDB.'

/** Registers every mongo:* handler of the map (each keeps its channel's types). */
function registerChannels(handle: HandleFn, channels: MongoChannelHandlers): void {
  const register = <C extends MongoChannel>(channel: C): void =>
    handle(channel, channels[channel] as IpcHandler<C>)
  for (const channel of Object.keys(channels) as MongoChannel[]) register(channel)
}

export function registerDbHandlers(ctx: AppContext, handle: HandleFn): void {
  const manager = getConnectionManager(ctx)
  const pg = createPgDbHandlers(ctx, manager)
  const lite = createSqliteDbHandlers(ctx, manager)
  const mongo = createMongoHandlers(ctx, manager)
  registerChannels(handle, mongo.channels)

  /** True for PostgreSQL connections: their db:* calls go to dbPostgres.ts. */
  const isPg = (id: string): boolean => ctx.connections.get(id)?.engine === 'postgresql'
  /** True for SQLite connections: their db:* calls go to dbSqlite.ts. */
  const isLite = (id: string): boolean => ctx.connections.get(id)?.engine === 'sqlite'
  /** True for MongoDB connections: their shared db:* calls go to mongo.ts, the rest are refused. */
  const isMongo = (id: string): boolean => ctx.connections.get(id)?.engine === 'mongodb'
  /** Splitter of a MySQL-family connection: MariaDB's also runs `/*M!` statements. */
  const mysqlFamilyDialect = (id: string) =>
    ctx.connections.get(id)?.engine === 'mariadb' ? mariadbDialect : mysqlDialect
  const refuseOnLite = (id: string): void => {
    if (isLite(id)) throw new DbUserError(SQLITE_REFUSED.notAvailable, 'E_CAPABILITY')
    refuseOnMongo(id)
  }
  const refuseOnMongo = (id: string): void => {
    if (isMongo(id)) throw new DbUserError(MONGO_REFUSED.notAvailable, 'E_CAPABILITY')
  }

  /** MySQL-family sequences: MariaDB connections only (main mirrors the tree). */
  const requireSequences = (id: string): void => {
    const connection = ctx.connections.get(id)
    if (connection)
      requireConnectionCapability(connection, 'sequences', CAPABILITY_MESSAGES.sequences)
  }

  /** Runs `fn` on a short-lived dedicated session, always releasing it. */
  const withSession = async <T>(
    connectionId: string,
    schema: string | null,
    fn: (session: PooledSession) => Promise<T>
  ): Promise<T> => {
    const session = await manager.acquire(connectionId, schema)
    try {
      return await fn(session)
    } finally {
      await session.release().catch(() => undefined)
    }
  }

  /** db:* channels MongoDB shares; every other db:* channel refuses a MongoDB connection. */
  const MONGO_SHARED = new Set<string>([
    'db:databases',
    'db:objects',
    'db:dropObject',
    'db:createDatabase',
    'db:dropDatabase',
    'db:cancel',
    'db:sessionState',
    'db:commit',
    'db:rollback',
    'db:closeSession'
  ])
  const dbHandle: typeof handle = (channel, fn) =>
    handle(channel, ((...args: Parameters<typeof fn>) => {
      if (!MONGO_SHARED.has(channel) && typeof args[0] === 'string') refuseOnMongo(args[0])
      return fn(...args)
    }) as typeof fn)

  dbHandle('db:databases', (id) =>
    isMongo(id)
      ? mongo.databases(id)
      : isPg(id)
        ? pg.databases(id)
        : isLite(id)
          ? lite.databases(id)
          : withSession(id, null, (s) => introspect.listDatabases(s))
  )
  dbHandle('db:tables', (id, schema) =>
    isPg(id)
      ? pg.tables(id, schema)
      : isLite(id)
        ? lite.tables(id, schema)
        : withSession(id, null, (s) => introspect.listTables(s, mysqlSchema(schema)))
  )
  dbHandle('db:views', (id, schema) =>
    isPg(id)
      ? pg.views(id, schema)
      : isLite(id)
        ? lite.views(id, schema)
        : withSession(id, null, (s) => introspect.listViews(s, mysqlSchema(schema)))
  )
  dbHandle('db:routines', (id, schema) =>
    isPg(id)
      ? pg.routines(id, schema)
      : isLite(id)
        ? Promise.resolve([])
        : withSession(id, null, (s) => introspect.listRoutines(s, mysqlSchema(schema)))
  )
  dbHandle('db:events', (id, schema) => {
    // Main mirrors the UI: engines without scheduled events are refused (MySQL has them).
    const connection = ctx.connections.get(id)
    if (connection) requireConnectionCapability(connection, 'events', CAPABILITY_MESSAGES.events)
    return withSession(id, null, (s) => introspect.listEvents(s, mysqlSchema(schema)))
  })
  dbHandle('db:triggers', (id, schema) =>
    isPg(id)
      ? pg.triggers(id, schema)
      : isLite(id)
        ? lite.triggers(id, schema)
        : withSession(id, null, (s) => introspect.listTriggers(s, mysqlSchema(schema)))
  )
  dbHandle('db:columns', (id, schema, table) =>
    isPg(id)
      ? pg.columns(id, schema, table)
      : isLite(id)
        ? lite.columns(id, schema, table)
        : withSession(id, null, (s) => introspect.listColumns(s, mysqlSchema(schema), table))
  )
  dbHandle('db:tableStructure', (id, schema, table) =>
    isPg(id)
      ? pg.tableStructure(id, schema, table)
      : isLite(id)
        ? lite.tableStructure(id, schema, table)
        : withSession(id, null, (s) => introspect.tableStructure(s, mysqlSchema(schema), table))
  )
  dbHandle('db:showCreate', (id, schema, type, name) => {
    if (isPg(id)) return pg.showCreate(id, schema, type, name)
    if (isLite(id)) return lite.showCreate(id, schema, type, name)
    if (type === 'sequence') {
      requireSequences(id)
      const sequence = typeof name === 'string' ? name : name.name
      return withSession(id, null, (s) =>
        introspect.showCreateSequence(s, mysqlSchema(schema), sequence)
      )
    }
    return withSession(id, null, (s) =>
      introspect.showCreate(
        s,
        mysqlSchema(schema),
        type as Parameters<typeof introspect.showCreate>[2],
        typeof name === 'string' ? name : name.name
      )
    )
  })
  dbHandle('db:schemas', (id, database) => {
    refuseOnLite(id)
    if (!isPg(id)) throw new DbUserError(CHANNEL_NOT_FOR_MYSQL)
    return pg.schemas(id, database)
  })
  dbHandle('db:objects', (id, schema, type) => {
    if (isMongo(id)) return mongo.objects(id, schema, type)
    if (isLite(id)) return lite.objects(id, schema, type)
    if (isPg(id)) return pg.objects(id, schema, type)
    // MariaDB: sequences (the only group without its own channel).
    if (type !== 'sequence') throw new DbUserError(CHANNEL_NOT_FOR_MYSQL)
    requireSequences(id)
    return withSession(id, null, (s) => introspect.listSequences(s, mysqlSchema(schema)))
  })
  dbHandle('db:closeDatabase', (id, database) => {
    refuseOnLite(id)
    if (!isPg(id)) throw new DbUserError(CHANNEL_NOT_FOR_MYSQL)
    return pg.closeDatabase(id, database)
  })
  dbHandle('db:extensions', (id, database) => {
    refuseOnLite(id)
    if (!isPg(id)) throw new DbUserError(CHANNEL_NOT_FOR_MYSQL)
    return pg.extensions(id, database)
  })
  dbHandle('db:dataTypes', (id, database) => {
    refuseOnLite(id)
    if (!isPg(id)) throw new DbUserError(CHANNEL_NOT_FOR_MYSQL)
    return pg.dataTypes(id, database)
  })
  dbHandle('db:tableData', (id, request) =>
    isPg(id)
      ? pg.tableData(id, request)
      : isLite(id)
        ? lite.tableData(id, request)
        : withSession(id, null, (s) =>
            fetchTableData(s, { ...request, schema: mysqlSchema(request.schema) })
          )
  )
  dbHandle('db:tableFilterSql', (id, schema, table, filter) => {
    if (isPg(id)) return pg.tableFilterSql(id, schema, table, filter)
    if (isLite(id)) return lite.tableFilterSql(id, schema, table, filter)
    const db = mysqlSchema(schema)
    return withSession(id, null, async (s) =>
      buildFilterWhere(filter, await filterColumns(s, { schema: db, table, filter }))
    )
  })
  dbHandle('db:applyRowChanges', (id, schema, table, changes, options) => {
    if (isPg(id)) return pg.applyRowChanges(id, schema, table, changes, options)
    if (isLite(id)) return lite.applyRowChanges(id, schema, table, changes, options)
    const db = mysqlSchema(schema)
    if (changes.length) assertProductionWriteConfirmed(ctx, id, options, 'Modificar filas')
    return withSession(id, null, async (s) => {
      // binary cells travel as "0xHEX" text; the column types say which to decode
      const columns = await introspect.listColumns(s, db, table)
      const binary = new Set(columns.filter((c) => isBinaryDataType(c.dataType)).map((c) => c.name))
      return applyRowChanges(s, db, table, changes, binary)
    })
  })
  dbHandle('db:execute', async (id, sql, options) => {
    if (isPg(id)) return pg.execute(id, sql, options)
    if (isLite(id)) return lite.execute(id, sql, options)
    // Open first: a `mysql` connection whose server is MariaDB becomes `mariadb` when it opens,
    // and the guard must split and classify with the dialect that will run the script.
    if (!manager.isOpen(id) && ctx.connections.get(id)?.engine === 'mysql') await manager.open(id)
    assertScriptAllowed(ctx, id, sql, options)
    const schema = options?.schema
    const mysqlOptions =
      schema === undefined || schema === null
        ? (options ?? {})
        : { ...options, schema: mysqlSchema(schema) }
    return withSession(id, null, (s) =>
      executeScript(
        s,
        sql,
        mysqlOptions,
        ctx.settings.get().defaultRowLimit,
        mysqlFamilyDialect(id)
      )
    )
  })
  dbHandle('db:cancel', (id, executionId) =>
    isMongo(id)
      ? mongo.cancel(id, executionId)
      : isPg(id)
        ? pg.cancel(id, executionId)
        : isLite(id)
          ? lite.cancel(id, executionId)
          : false
  )
  dbHandle('db:sessionState', (id, key) =>
    isMongo(id)
      ? mongo.sessionState(id, key)
      : isPg(id)
        ? pg.sessionState(id, key)
        : isLite(id)
          ? lite.sessionState(id, key)
          : {
              open: false,
              transactionStatus: 'idle' as const,
              effectiveSchema: null,
              database: null
            }
  )
  dbHandle('db:commit', (id, key, options) => {
    if (isMongo(id)) return mongo.commit(id, key, options)
    if (isLite(id)) return lite.commit(id, key, options)
    if (!isPg(id)) throw new DbUserError(CHANNEL_NOT_FOR_MYSQL)
    return pg.commit(id, key, options)
  })
  dbHandle('db:rollback', (id, key) => {
    if (isMongo(id)) return mongo.rollback(id, key)
    if (isLite(id)) return lite.rollback(id, key)
    if (!isPg(id)) throw new DbUserError(CHANNEL_NOT_FOR_MYSQL)
    return pg.rollback(id, key)
  })
  dbHandle('db:closeSession', async (id, key) => {
    if (isMongo(id)) await mongo.closeSession(id, key)
    else if (isPg(id)) await pg.closeSession(id, key)
    else if (isLite(id)) await lite.closeSession(id, key)
  })
  dbHandle('db:users', (id) => {
    const connection = ctx.connections.get(id)
    if (connection && !engineOf(connection).capabilities.hasUsers)
      throw new DbUserError(
        connection.engine === 'sqlite'
          ? SQLITE_REFUSED.notAvailable
          : PG_REFUSED.users(connection.name),
        'E_CAPABILITY'
      )
    return withSession(id, null, (s) => listUsers(s))
  })
  dbHandle('db:dropObject', (id, schema, type, name, options) => {
    if (isMongo(id)) return mongo.dropObject(id, schema, type, name, options)
    if (isPg(id)) return pg.dropObject(id, schema, type, name, options)
    if (isLite(id)) return lite.dropObject(id, schema, type, name, options)
    const objectName = typeof name === 'string' ? name : name.name
    assertProductionWriteConfirmed(ctx, id, options, `Eliminar ${objectName}`)
    if (type === 'sequence') {
      requireSequences(id)
      return withSession(id, null, (s) =>
        introspect.dropSequence(s, mysqlSchema(schema), objectName)
      )
    }
    return withSession(id, null, (s) =>
      introspect.dropObject(
        s,
        mysqlSchema(schema),
        type as Parameters<typeof introspect.dropObject>[2],
        objectName
      )
    )
  })
  dbHandle('db:createDatabase', (id, name, charset, collation, options, engineOptions) => {
    if (isMongo(id)) return mongo.createDatabase(id, name, options, engineOptions)
    if (isPg(id)) return pg.createDatabase(id, name, options, engineOptions)
    if (isLite(id)) throw new DbUserError(SQLITE_REFUSED.createDatabase, 'E_CAPABILITY')
    assertProductionWriteConfirmed(ctx, id, options, `Crear la base de datos ${name}`)
    return withSession(id, null, (s) => introspect.createDatabase(s, name, charset, collation))
  })
  dbHandle('db:dropDatabase', (id, name, options) => {
    if (isMongo(id)) return mongo.dropDatabase(id, name, options)
    if (isPg(id)) return pg.dropDatabase(id, name, options)
    if (isLite(id)) throw new DbUserError(SQLITE_REFUSED.dropDatabase, 'E_CAPABILITY')
    assertProductionWriteConfirmed(ctx, id, options, `Eliminar la base de datos ${name}`)
    return withSession(id, null, (s) => introspect.dropDatabase(s, name))
  })
  dbHandle('db:charsets', (id) => {
    if (isPg(id)) throw new DbUserError(PG_REFUSED.charsets, 'E_CAPABILITY')
    refuseOnLite(id)
    return withSession(id, null, (s) => introspect.listCharsets(s))
  })

  const requireLite = (id: string): void => {
    if (!isLite(id))
      throw new DbUserError('Esta operación solo existe en las conexiones SQLite.', 'E_CAPABILITY')
  }
  handle('sqlite:createFile', (filePath) => createSqliteFile(filePath))
  handle('sqlite:reopenWritable', (id, options) => {
    requireLite(id)
    return lite.reopenWritable(id, options)
  })
  handle('sqlite:copyFile', (id, targetPath) => {
    requireLite(id)
    return lite.copyFile(id, targetPath)
  })
  handle('sqlite:maintenance', (id, action, options) => {
    requireLite(id)
    return lite.maintenance(id, action, options)
  })
  handle('sqlite:tableDependents', (id, schema, table) => {
    requireLite(id)
    return lite.tableDependents(id, schema, table)
  })
  handle('sqlite:alterTable', (id, schema, request, options) => {
    requireLite(id)
    return lite.alterTable(id, schema, request, options)
  })
}
