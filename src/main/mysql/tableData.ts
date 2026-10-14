import { performance } from 'node:perf_hooks'
import type { TableDataPage, TableDataRequest as SharedTableDataRequest } from '@shared/types'
import { fetchTablePage } from '../db/tableData'
import { MysqlUserError } from './errors'
import { escapeId, listColumns, primaryKeyColumns, type Queryable } from './introspect'
import { isMariaDbSession } from './mariadb'
import { MAX_ROWS_CAP } from './query'
import type { FullSession } from './session'
import { buildFilterWhere, filterNeedsColumns } from './tableFilter'
import { normalizeRow, toQueryColumn } from './values'

/** A table-data request on a MySQL connection: the schema is the database name. */
export type TableDataRequest = SharedTableDataRequest & { schema: string }

/** Milliseconds the COUNT(*) may run before we give up and report total = null. */
export const COUNT_TIMEOUT_MS = 3000

function validate(req: TableDataRequest): void {
  if (!req.schema || !req.table) throw new MysqlUserError('Falta el esquema o la tabla')
  if (!Number.isInteger(req.limit) || req.limit < 1 || req.limit > MAX_ROWS_CAP) {
    throw new MysqlUserError(`El límite de filas debe estar entre 1 y ${MAX_ROWS_CAP}`)
  }
  if (!Number.isInteger(req.offset) || req.offset < 0)
    throw new MysqlUserError('El desplazamiento debe ser 0 o mayor')
  if (req.orderBy && req.orderBy.direction !== 'ASC' && req.orderBy.direction !== 'DESC') {
    throw new MysqlUserError('La dirección de ordenación debe ser ASC o DESC')
  }
}

/**
 * WHERE body for the request: the raw `where` (user's own SQL, own lines and
 * parentheses so a trailing "-- note" or an OR cannot escape it) AND the
 * structured filter (escaped by tableFilter). '' when neither is set.
 * `columns` are the table's columns, required when the filter has conditions.
 */
export function buildWhere(req: TableDataRequest, columns: readonly string[] = []): string {
  const parts: string[] = []
  const raw = req.where?.trim()
  if (raw) parts.push(`(\n${raw}\n)`)
  const filter = buildFilterWhere(req.filter, columns)
  if (filter) parts.push(`(${filter})`)
  return parts.join(' AND ')
}

function fromClause(req: TableDataRequest, columns?: readonly string[]): string {
  let sql = `FROM ${escapeId(req.schema)}.${escapeId(req.table)}`
  const where = buildWhere(req, columns)
  if (where) sql += ` WHERE ${where}`
  return sql
}

/**
 * Paged SELECT. Everything is rendered to plain SQL (LIMIT/OFFSET are validated
 * integers, filter values escaped by the driver): a `?` typed inside the raw
 * WHERE must not be taken for a placeholder and consume a parameter.
 */
export function buildSelectSql(
  req: TableDataRequest,
  columns?: readonly string[],
  /** MariaDB with INVISIBLE columns: every column by name, since SELECT * omits them. */
  explicitColumns?: readonly string[]
): string {
  validate(req)
  let sql = explicitColumns?.length
    ? `SELECT ${explicitColumns.map(escapeId).join(', ')} ${fromClause(req, columns)}`
    : `SELECT * ${fromClause(req, columns)}`
  if (req.orderBy) sql += ` ORDER BY ${escapeId(req.orderBy.column)} ${req.orderBy.direction}`
  sql += ` LIMIT ${req.limit} OFFSET ${req.offset}`
  return sql
}

export function buildCountSql(
  req: TableDataRequest,
  columns?: readonly string[],
  flavor: 'mysql' | 'mariadb' = 'mysql'
): string {
  validate(req)
  // MariaDB ignores the MAX_EXECUTION_TIME hint; its own per-statement timeout is in seconds.
  if (flavor === 'mariadb')
    return `SET STATEMENT max_statement_time=${COUNT_TIMEOUT_MS / 1000} FOR SELECT COUNT(*) AS total ${fromClause(req, columns)}`
  return `SELECT /*+ MAX_EXECUTION_TIME(${COUNT_TIMEOUT_MS}) */ COUNT(*) AS total ${fromClause(req, columns)}`
}

/** Column names for validating a structured filter (only fetched when it needs them). */
export async function filterColumns(
  q: Queryable,
  req: Pick<TableDataRequest, 'schema' | 'table' | 'filter'>
): Promise<string[]> {
  if (!filterNeedsColumns(req.filter)) return []
  const columns = (await listColumns(q, req.schema, req.table)).map((c) => c.name)
  if (!columns.length) {
    throw new MysqlUserError(`No se encontró la tabla ${req.schema}.${req.table}`)
  }
  return columns
}

/** All columns in order when the table has an INVISIBLE one (MariaDB); undefined otherwise. */
async function explicitColumnsFor(
  q: Queryable,
  req: Pick<TableDataRequest, 'schema' | 'table'>
): Promise<string[] | undefined> {
  const columns = await listColumns(q, req.schema, req.table)
  return columns.some((c) => c.hidden) ? columns.map((c) => c.name) : undefined
}

/** «Exportar resultado completo» of the table view: its filter and sort, without paging. */
export type TableExportRequest = Omit<TableDataRequest, 'limit' | 'offset'>

/** The table view's SELECT without LIMIT/OFFSET (same WHERE and ORDER BY as the grid). */
export function buildExportSelectSql(
  req: TableExportRequest,
  columns?: readonly string[],
  explicitColumns?: readonly string[]
): string {
  const full: TableDataRequest = { ...req, limit: 1, offset: 0 }
  validate(full)
  let sql = explicitColumns?.length
    ? `SELECT ${explicitColumns.map(escapeId).join(', ')} ${fromClause(full, columns)}`
    : `SELECT * ${fromClause(full, columns)}`
  if (req.orderBy) sql += ` ORDER BY ${escapeId(req.orderBy.column)} ${req.orderBy.direction}`
  return sql
}

/** The export SELECT of a table view, reading the columns a filter or MariaDB needs. */
export async function exportSelectSql(
  session: FullSession,
  req: TableExportRequest
): Promise<string> {
  const full: TableDataRequest = { ...req, limit: 1, offset: 0 }
  validate(full)
  const columnNames = await filterColumns(session, full)
  const explicit = isMariaDbSession(session) ? await explicitColumnsFor(session, full) : undefined
  return buildExportSelectSql(req, columnNames, explicit)
}

/** Loads one page of a table plus its primary key and (best effort) total row count. */
export async function fetchTableData(
  session: FullSession,
  req: TableDataRequest
): Promise<TableDataPage> {
  validate(req)
  const started = performance.now()
  const columnNames = await filterColumns(session, req)
  const mariadb = isMariaDbSession(session)
  // MariaDB INVISIBLE columns are left out of SELECT *: name every column when there is one.
  const explicit = mariadb ? await explicitColumnsFor(session, req) : undefined
  const select = buildSelectSql(req, columnNames, explicit)
  const countSql = buildCountSql(req, columnNames, mariadb ? 'mariadb' : 'mysql')

  return fetchTablePage(
    {
      primaryKey: () => primaryKeyColumns(session, req.schema, req.table),
      page: async () => {
        const raw = await session.runStatement(select, req.limit)
        const first = raw.resultSets[0]
        const columns = first ? first.fields.map(toQueryColumn) : []
        const rows = first ? first.rows.map(normalizeRow) : []
        return { columns, rows }
      },
      // A timeout (ER_QUERY_TIMEOUT) rejects here and the total stays null.
      count: async () => {
        const [row] = await session.query<{ total: unknown }>(countSql)
        const n = Number(row?.total)
        return Number.isFinite(n) ? n : null
      }
    },
    started
  )
}
