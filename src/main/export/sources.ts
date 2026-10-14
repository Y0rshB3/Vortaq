/**
 * «Exportar resultado completo»: the rows of one read-only statement, read
 * again in a new session that cannot write and streamed in batches.
 *
 * - The statement must pass checkExportStatement (one statement, returns
 *   rows, provably read-only for the dialect's allowlist); a table view's
 *   SELECT is built here from its filter and sort and checked the same way.
 * - MySQL/MariaDB: a pooled connection in `START TRANSACTION READ ONLY`,
 *   rows streamed with backpressure; cancel = `KILL QUERY` from another
 *   session. The connection is destroyed afterwards (never reused).
 * - PostgreSQL: a client of the database's pool in `BEGIN READ ONLY` (the
 *   tab's search_path set locally), rows through pg-cursor; cancel =
 *   pg_cancel_backend. ROLLBACK and DISCARD ALL before the client goes back.
 * - SQLite: a separate worker on the same file opened read-only with
 *   query_only (never the query tabs' handle); cancel kills that worker.
 *
 * None of these sessions sees uncommitted changes of a query tab. Reading
 * needs no typed confirmation on production connections: nothing here writes.
 */
import type { Readable } from 'node:stream'
import Cursor from 'pg-cursor'
import type { FieldDef } from 'pg'
import { dialectForEngine, getDialect, type SqlDialect } from '@shared/dialects'
import { checkExportStatement } from '@shared/export/statement'
import type { ExportColumn, ExportQuerySource } from '@shared/export/types'
import { sqliteTypeKind } from '@shared/sqlite/affinity'
import type { CellValue, SchemaRef } from '@shared/types'
import type { AppContext } from '../context'
import { isMysqlFamily } from '../db/driver'
import type { ConnectionManager } from '../db/manager'
import { isMariaDbSession } from '../mysql/mariadb'
import type { PooledSession } from '../mysql/session'
import { exportSelectSql } from '../mysql/tableData'
import { normalizeRow, toQueryColumn } from '../mysql/values'
import { composeSearchPath, formatSearchPath } from '../postgres/client'
import { isPgConnection, type PgDriverConnection } from '../postgres/connection'
import type { PgSession } from '../postgres/session'
import { unsupportedStatement } from '../postgres/session'
import { buildPgExportSelectSql, pgFilterColumns } from '../postgres/tableData'
import { BUILTIN_TYPES, normalizeCell, pgTypes, typeKindOf } from '../postgres/values'
import type { WorkerClient } from '../sqlite/client'
import { isSqliteConnection } from '../sqlite/connection'
import { rowIdentity } from '../sqlite/introspect'
import {
  buildSqliteExportSelectSql,
  filterColumns as sqliteFilterColumns
} from '../sqlite/tableData'
import { ExportError } from './sink'
import { CANCELLED_EXPORT, type RowBatch } from './writer'

/** Rows per batch read from the server. */
export const EXPORT_BATCH_ROWS = 500

export interface RowSource {
  columns: ExportColumn[]
  batches: AsyncIterable<RowBatch>
  /** Stops the work on the server (the reader then fails and the export stops). */
  cancel(): Promise<void>
  /** Ends the session; always called, also after a failure or a cancel. */
  close(): Promise<void>
}

export const EXPORT_MONGO_REFUSED =
  'La exportación de resultados no está disponible en las conexiones MongoDB.'
const NO_ROWS = 'La consulta no devuelve filas: no hay nada que exportar.'

/** Refuses anything that is not one read-only statement returning rows. */
function guard(dialect: SqlDialect, sql: string): string {
  const check = checkExportStatement(dialect, sql)
  if (!check.ok) throw new ExportError(check.reason)
  return check.sql
}

function requireSource(source: ExportQuerySource): void {
  if (!source || typeof source !== 'object')
    throw new ExportError('Origen de exportación no válido.')
  if (source.kind === 'statement') {
    if (typeof source.sql !== 'string' || !source.sql.trim())
      throw new ExportError('No hay ninguna consulta que exportar.')
  } else if (source.kind === 'table') {
    if (!source.request || typeof source.request.table !== 'string' || !source.request.table)
      throw new ExportError('Falta la tabla que exportar.')
  } else throw new ExportError('Origen de exportación no válido.')
}

/**
 * Runs `stop` when the export is cancelled (also while the statement is
 * still starting); returns the function that removes the listener.
 */
function onAbort(signal: AbortSignal, stop: () => Promise<unknown>): () => void {
  const listener = (): void => void stop().catch(() => undefined)
  signal.addEventListener('abort', listener, { once: true })
  return () => signal.removeEventListener('abort', listener)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExportError(CANCELLED_EXPORT)
}

/**
 * Opens the row source of `source` on connection `id`. Aborting `signal`
 * stops the statement on the server at any point (also before its first row).
 */
export async function openRowSource(
  ctx: Pick<AppContext, 'connections'>,
  manager: ConnectionManager,
  id: string,
  source: ExportQuerySource,
  executionId: string,
  signal: AbortSignal = new AbortController().signal
): Promise<RowSource> {
  requireSource(source)
  const config = ctx.connections.get(id)
  if (!config) throw new ExportError('La conexión ya no existe.')
  const dialect = dialectForEngine(config.engine ?? 'mysql')
  if (!dialect) throw new ExportError(EXPORT_MONGO_REFUSED)
  // Refused before any connection is opened; each engine checks again with its final dialect.
  if (source.kind === 'statement') guard(dialect, source.sql)
  // A `mysql` connection whose server is MariaDB becomes `mariadb` when it opens.
  const connection = await manager.connection(id)
  throwIfAborted(signal)
  if (isPgConnection(connection)) return openPgSource(connection, source, executionId, signal)
  if (isSqliteConnection(connection)) {
    const reader = await connection.openReader()
    return openSqliteSource(reader, source, signal)
  }
  if (isMysqlFamily(connection)) {
    const engine = ctx.connections.get(id)?.engine
    return openMysqlSource(manager, id, engine === 'mariadb', source, signal)
  }
  throw new ExportError(EXPORT_MONGO_REFUSED)
}

/* ---------- MySQL / MariaDB ---------- */

function mysqlDatabase(ref: SchemaRef | null | undefined): string | null {
  if (ref === null || ref === undefined || ref === '') return null
  if (typeof ref === 'string') return ref
  throw new ExportError('Las conexiones MySQL usan el nombre de la base de datos como esquema.')
}

async function openMysqlSource(
  manager: ConnectionManager,
  id: string,
  mariadbEngine: boolean,
  source: ExportQuerySource,
  signal: AbortSignal
): Promise<RowSource> {
  const session = await manager.acquire(id, null)
  let stream: Readable | null = null
  let dispose = (): void => undefined
  try {
    const dialect = getDialect(mariadbEngine || isMariaDbSession(session) ? 'mariadb' : 'mysql')
    let sql: string
    let database: string | null
    if (source.kind === 'table') {
      database = mysqlDatabase(source.request.schema)
      if (!database) throw new ExportError('Falta la base de datos de la tabla.')
      sql = guard(dialect, await exportSelectSql(session, { ...source.request, schema: database }))
    } else {
      database = mysqlDatabase(source.context)
      sql = guard(dialect, source.sql)
    }
    if (database) await session.useSchema(database)
    await session.execute('START TRANSACTION READ ONLY')
    const threadId = session.threadId
    let killed = false
    const cancel = async (): Promise<void> => {
      if (killed) return
      killed = true
      if (threadId !== null) await killQuery(manager, id, threadId)
      stream?.destroy(new ExportError(CANCELLED_EXPORT))
    }
    throwIfAborted(signal)
    dispose = onAbort(signal, cancel)
    const result = await session.streamResult(sql)
    const rows = result.rows
    stream = rows
    throwIfAborted(signal)
    if (!result.fields.length) throw new ExportError(NO_ROWS)
    const columns = result.fields.map((f) => {
      const c = toQueryColumn(f)
      return { name: c.name, type: c.type }
    })
    async function* batches(): AsyncGenerator<RowBatch> {
      let batch: CellValue[][] = []
      for await (const raw of rows) {
        batch.push(normalizeRow(raw as unknown[]))
        if (batch.length >= EXPORT_BATCH_ROWS) {
          yield { rows: batch }
          batch = []
        }
      }
      if (batch.length) yield { rows: batch }
    }
    return {
      columns,
      batches: batches(),
      cancel,
      close: async () => {
        dispose()
        if (!rows.destroyed) rows.destroy()
        // The session is dirty (transaction, USE): release() destroys its connection.
        await session.release().catch(() => undefined)
      }
    }
  } catch (err) {
    dispose()
    stream?.destroy()
    await session.release().catch(() => undefined)
    throw signal.aborted ? new ExportError(CANCELLED_EXPORT) : err
  }
}

/** KILL QUERY of the export's thread from another session (best effort). */
async function killQuery(manager: ConnectionManager, id: string, threadId: number): Promise<void> {
  let other: PooledSession | null = null
  try {
    other = await manager.acquire(id, null)
    await other.query(`KILL QUERY ${Math.trunc(threadId)}`)
  } catch {
    /* the statement may have ended already; the stream is destroyed anyway */
  } finally {
    await other?.release().catch(() => undefined)
  }
}

/* ---------- PostgreSQL ---------- */

function pgColumns(fields: FieldDef[]): ExportColumn[] {
  return fields.map((f) => {
    const facts = BUILTIN_TYPES[f.dataTypeID]
    return {
      name: f.name,
      type: facts?.name ?? `oid ${f.dataTypeID}`,
      typeKind: facts ? typeKindOf(facts) : 'other'
    }
  })
}

function readCursor(
  cursor: Cursor<unknown[]>,
  count: number
): Promise<{ rows: unknown[][]; fields: FieldDef[] }> {
  return new Promise((resolve, reject) => {
    cursor.read(count, (err, rows, result) => {
      if (err) reject(err)
      else resolve({ rows, fields: result?.fields ?? [] })
    })
  })
}

async function openPgSource(
  connection: PgDriverConnection,
  source: ExportQuerySource,
  executionId: string,
  signal: AbortSignal
): Promise<RowSource> {
  const dialect = getDialect('postgresql')
  const table = source.kind === 'table' ? source.request : null
  const ref = table ? table.schema : source.kind === 'statement' ? source.context : null
  if (typeof ref === 'string' && ref)
    throw new ExportError('Las conexiones PostgreSQL necesitan la base de datos y el esquema.')
  const scope =
    ref && typeof ref === 'object'
      ? { database: ref.database || connection.initialDatabase, schema: ref.schema || null }
      : { database: connection.initialDatabase, schema: null as string | null }
  if (table && !scope.schema) throw new ExportError('Falta el esquema de la tabla.')
  const statement = source.kind === 'statement' ? guard(dialect, source.sql) : null
  if (statement) {
    const unsupported = unsupportedStatement(statement)
    if (unsupported) throw new ExportError(unsupported)
  }
  // Read before borrowing a client: baseSearchPath may need one from the same pool.
  const base = scope.schema ? await connection.baseSearchPath(scope.database) : []
  const session: PgSession = await connection.acquire({ database: scope.database, schema: null })
  // Session state changed (search_path, transaction): DISCARD ALL before reuse.
  session.usage.userSql = true
  let cursor: Cursor<unknown[]> | null = null
  let dispose = (): void => undefined
  const closeCursor = (): Promise<void> =>
    new Promise((resolve) => {
      if (!cursor) return resolve()
      cursor.close(() => resolve())
    })
  const finish = async (): Promise<void> => {
    dispose()
    connection.unregisterExecution(executionId)
    await closeCursor().catch(() => undefined)
    await session.query('ROLLBACK').catch(() => undefined)
    await session.release().catch(() => undefined)
  }
  try {
    await session.query('BEGIN READ ONLY')
    if (scope.schema)
      await session.query('SELECT set_config($1, $2, true)', [
        'search_path',
        formatSearchPath(composeSearchPath(scope.schema, base))
      ])
    let sql = statement ?? ''
    if (table) {
      const target = { schema: scope.schema ?? '', table: table.table }
      const filterColumns = await pgFilterColumns(session, target, table)
      sql = guard(dialect, buildPgExportSelectSql(table, target, filterColumns))
    }
    connection.registerExecution(executionId, session)
    const cancel = async (): Promise<void> => {
      await connection.cancel(executionId)
    }
    throwIfAborted(signal)
    dispose = onAbort(signal, cancel)
    const opened = new Cursor<unknown[]>(sql, null, { rowMode: 'array', types: pgTypes })
    cursor = opened
    void session.client.query(opened)
    const first = await readCursor(opened, EXPORT_BATCH_ROWS)
    throwIfAborted(signal)
    if (!first.fields.length) throw new ExportError(NO_ROWS)
    async function* batches(): AsyncGenerator<RowBatch> {
      let rows = first.rows
      while (rows.length) {
        yield { rows: rows.map((r) => r.map(normalizeCell)) }
        if (rows.length < EXPORT_BATCH_ROWS) return
        rows = (await readCursor(opened, EXPORT_BATCH_ROWS)).rows
      }
    }
    return {
      columns: pgColumns(first.fields),
      batches: batches(),
      cancel,
      close: finish
    }
  } catch (err) {
    await finish()
    throw signal.aborted ? new ExportError(CANCELLED_EXPORT) : err
  }
}

/* ---------- SQLite ---------- */

async function openSqliteSource(
  reader: WorkerClient,
  source: ExportQuerySource,
  signal: AbortSignal
): Promise<RowSource> {
  const dialect = getDialect('sqlite')
  let cursorId: number | null = null
  // node:sqlite cannot be interrupted: end the reader process (the tabs keep theirs).
  const cancel = (): Promise<void> => reader.kill()
  const dispose = onAbort(signal, cancel)
  try {
    throwIfAborted(signal)
    let sql: string
    if (source.kind === 'table') {
      const ref = source.request.schema
      if (ref !== null && ref !== undefined && typeof ref !== 'string')
        throw new ExportError('Las conexiones SQLite usan el nombre de la base de datos adjunta.')
      const target = { db: ref || 'main', table: source.request.table }
      const queryable = {
        query: async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
          (await reader.call('query', text, params)).rows as T[]
      }
      const identity = await rowIdentity(queryable, target.db, target.table)
      const columns = await sqliteFilterColumns(queryable, target, source.request)
      sql = guard(dialect, buildSqliteExportSelectSql(source.request, target, identity, columns))
    } else sql = guard(dialect, source.sql)
    const opened = await reader.call('cursorOpen', sql)
    throwIfAborted(signal)
    cursorId = opened.cursorId
    const id = opened.cursorId
    async function* batches(): AsyncGenerator<RowBatch> {
      for (;;) {
        const next = await reader.call('cursorRead', id, EXPORT_BATCH_ROWS)
        if (next.rows.length) yield { rows: next.rows, storage: next.storage }
        if (next.done) return
      }
    }
    return {
      columns: opened.columns.map((c) => ({
        name: c.name,
        type: c.type ?? '',
        typeKind: sqliteTypeKind(c.type)
      })),
      batches: batches(),
      cancel,
      close: async () => {
        dispose()
        await reader.close()
      }
    }
  } catch (err) {
    dispose()
    if (cursorId !== null) await reader.call('cursorClose', cursorId).catch(() => undefined)
    await reader.close()
    throw signal.aborted ? new ExportError(CANCELLED_EXPORT) : err
  }
}
