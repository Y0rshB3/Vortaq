/**
 * «Plan de ejecución» (db:plan): asks the server for the plan of one
 * statement on a pooled session of the connection and turns it into the
 * common tree (shared/plan/parse.ts). Electron-free (also in the core).
 *
 * - Estimated plans never run the statement: SQL Server SET SHOWPLAN_XML ON,
 *   PostgreSQL EXPLAIN (FORMAT JSON) inside BEGIN READ ONLY, MySQL 8 EXPLAIN
 *   FORMAT=TREE (tabular EXPLAIN on MySQL 5.7 and MariaDB), SQLite EXPLAIN
 *   QUERY PLAN.
 * - Actual plans run one read-only SELECT (shared/plan/check.ts) where nothing
 *   can be kept: PostgreSQL EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) in BEGIN
 *   READ ONLY; MySQL EXPLAIN ANALYZE and MariaDB ANALYZE in START TRANSACTION
 *   READ ONLY; SQL Server SET STATISTICS XML ON inside a transaction that is
 *   always rolled back (it has no read-only sessions). SQLite has none.
 * Neither needs the typed confirmation: nothing is written. The session is
 * marked as used by user SQL, so the pool resets it before reusing it.
 */
import { planStatement } from '@shared/plan/check'
import {
  parseMsShowplan,
  parseMysqlTable,
  parseMysqlTree,
  parsePgPlan,
  parseSqlitePlan
} from '@shared/plan/parse'
import type { ExecutionPlan, PlanRequest } from '@shared/plan/types'
import { DbUserError } from '../db/errors'
import type { ConnectionManager } from '../db/manager'
import type { Scope, SqlDriverConnection, SqlSession } from '../db/driver'

/** Queries of the plan: one at a time, rows as objects. */
type Session = SqlSession & { usage?: { userSql: boolean } }

function scopeOf(schema: PlanRequest['schema']): Scope | null {
  if (!schema) return null
  return typeof schema === 'string'
    ? { database: schema, schema: null }
    : { database: schema.database, schema: schema.schema }
}

const firstValue = (rows: Record<string, unknown>[]): string => {
  const row = rows[0]
  return row ? String(Object.values(row)[0] ?? '') : ''
}

async function inTransaction<T>(
  session: Session,
  begin: string,
  end: string,
  fn: () => Promise<T>
): Promise<T> {
  await session.query(begin)
  try {
    return await fn()
  } finally {
    await session.query(end).catch(() => undefined)
  }
}

async function mysqlPlan(
  session: Session,
  statement: string,
  actual: boolean,
  mariadb: boolean
): Promise<ExecutionPlan> {
  const engine = mariadb ? 'mariadb' : 'mysql'
  if (actual) {
    return inTransaction(session, 'START TRANSACTION READ ONLY', 'ROLLBACK', async () => {
      if (mariadb) return parseMysqlTable(await session.query(`ANALYZE ${statement}`), engine, true)
      try {
        const rows = await session.query(`EXPLAIN ANALYZE ${statement}`)
        return { ...parseMysqlTree(firstValue(rows), true), engine }
      } catch (err) {
        throw new DbUserError(
          `El plan real necesita MySQL 8.0.18 o posterior (EXPLAIN ANALYZE). Usa el plan estimado. ${err instanceof Error ? err.message : ''}`.trim()
        )
      }
    })
  }
  if (!mariadb) {
    try {
      const rows = await session.query(`EXPLAIN FORMAT=TREE ${statement}`)
      return { ...parseMysqlTree(firstValue(rows), false), engine }
    } catch {
      /* MySQL before 8.0.16: the table below */
    }
  }
  return parseMysqlTable(await session.query(`EXPLAIN ${statement}`), engine, false)
}

async function pgPlan(
  session: Session,
  statement: string,
  actual: boolean,
  schema: string | null
): Promise<ExecutionPlan> {
  return inTransaction(session, 'BEGIN READ ONLY', 'ROLLBACK', async () => {
    if (schema)
      await session.query('SELECT pg_catalog.set_config($1, $2, true)', [
        'search_path',
        `"${schema.replace(/"/g, '""')}", public`
      ])
    const options = actual ? 'ANALYZE, BUFFERS, FORMAT JSON' : 'FORMAT JSON'
    const rows = await session.query(`EXPLAIN (${options}) ${statement}`)
    const value = Object.values(rows[0] ?? {})[0]
    return parsePgPlan(typeof value === 'string' ? value : JSON.stringify(value), actual)
  })
}

async function msPlan(
  session: Session,
  statement: string,
  actual: boolean
): Promise<ExecutionPlan> {
  if (!actual) {
    await session.query('SET SHOWPLAN_XML ON')
    try {
      return parseMsShowplan(firstValue(await session.query(statement)), false)
    } finally {
      await session.query('SET SHOWPLAN_XML OFF').catch(() => undefined)
    }
  }
  // The statement runs; the transaction is always rolled back (no read-only sessions).
  return inTransaction(session, 'BEGIN TRANSACTION', 'IF @@TRANCOUNT > 0 ROLLBACK', async () => {
    await session.query('SET STATISTICS XML ON')
    try {
      // The last result set of the batch is the plan.
      return parseMsShowplan(firstValue(await session.query(statement)), true)
    } finally {
      await session.query('SET STATISTICS XML OFF').catch(() => undefined)
    }
  })
}

export async function executionPlan(
  manager: ConnectionManager,
  connectionId: string,
  request: PlanRequest
): Promise<ExecutionPlan> {
  const connection = await manager.connection(connectionId)
  if (connection.family !== 'sql')
    throw new DbUserError(
      'MongoDB no tiene plan de ejecución en Vortaq: usa .explain() en la consulta.'
    )
  const sql = connection as SqlDriverConnection
  const dialect = sql.dialect.id
  const checked = planStatement(dialect, request.sql, request.actual)
  if ('problem' in checked) throw new DbUserError(checked.problem)
  if (request.actual && dialect === 'sqlite')
    throw new DbUserError('SQLite no mide la ejecución: usa el plan estimado (EXPLAIN QUERY PLAN).')
  const session = (await sql.acquire(scopeOf(request.schema))) as Session
  if (session.usage) session.usage.userSql = true
  try {
    switch (dialect) {
      case 'mysql':
      case 'mariadb':
        return await mysqlPlan(session, checked.statement, request.actual, dialect === 'mariadb')
      case 'postgresql':
        return await pgPlan(
          session,
          checked.statement,
          request.actual,
          request.schema && typeof request.schema === 'object' ? request.schema.schema : null
        )
      case 'sqlserver':
        return await msPlan(session, checked.statement, request.actual)
      case 'sqlite':
        return parseSqlitePlan(await session.query(`EXPLAIN QUERY PLAN ${checked.statement}`))
      default:
        throw new DbUserError('Este motor no tiene plan de ejecución en Vortaq.')
    }
  } catch (err) {
    if (err instanceof DbUserError) throw err
    throw new DbUserError(
      `No se pudo obtener el plan: ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    await session.release()
  }
}
