/**
 * SQLite table browsing: `LIMIT n OFFSET m`, identifiers double-quoted, the
 * structured filter compiled by tableFilter.ts, and an exact count. Rows are
 * addressed by rowid (section 5.6): a table without an INTEGER PRIMARY KEY
 * gets its rowid as the first column (locked: key only).
 */
import { performance } from 'node:perf_hooks'
import { quoteIdent } from '@shared/dialects/sqlite'
import type { TableDataPage, TableDataRequest } from '@shared/types'
import { MAX_ROWS_CAP } from '../db/query'
import type { SqliteDriverConnection } from './connection'
import { SqliteUserError } from './errors'
import { listColumns, rowIdentity, type RowIdentity, type SqliteQueryable } from './introspect'
import { describeColumns } from './query'
import {
  buildSqliteFilterWhere,
  sqliteFilterNeedsColumns,
  type SqliteFilterColumn
} from './tableFilter'

export interface SqliteTableTarget {
  db: string
  table: string
}

function validate(req: TableDataRequest, target: SqliteTableTarget): void {
  if (!target.db || !target.table) throw new SqliteUserError('Falta la base de datos o la tabla')
  if (!Number.isInteger(req.limit) || req.limit < 1 || req.limit > MAX_ROWS_CAP)
    throw new SqliteUserError(`El límite de filas debe estar entre 1 y ${MAX_ROWS_CAP}`)
  if (!Number.isInteger(req.offset) || req.offset < 0)
    throw new SqliteUserError('El desplazamiento debe ser 0 o mayor')
  if (req.orderBy && req.orderBy.direction !== 'ASC' && req.orderBy.direction !== 'DESC')
    throw new SqliteUserError('La dirección de ordenación debe ser ASC o DESC')
}

/** WHERE body: the raw WHERE (own lines and parentheses) AND the structured filter. */
export function buildSqliteWhere(
  req: TableDataRequest,
  columns: SqliteFilterColumn[] = []
): string {
  const parts: string[] = []
  const raw = req.where?.trim()
  if (raw) parts.push(`(\n${raw}\n)`)
  const filter = buildSqliteFilterWhere(req.filter ?? null, columns)
  if (filter) parts.push(`(${filter})`)
  return parts.join(' AND ')
}

const fromClause = (target: SqliteTableTarget, where: string): string =>
  `FROM ${quoteIdent(target.db, true)}.${quoteIdent(target.table, true)}${where ? ` WHERE ${where}` : ''}`

/** Extra leading column that carries the rowid (null when the key is a real column). */
export function rowidSelect(identity: RowIdentity): string | null {
  return identity.kind === 'rowid' && identity.column === null ? identity.alias : null
}

export function buildSqliteSelectSql(
  req: TableDataRequest,
  target: SqliteTableTarget,
  identity: RowIdentity,
  columns: SqliteFilterColumn[] = []
): string {
  validate(req, target)
  const rowid = rowidSelect(identity)
  let sql = `SELECT ${rowid ? `${rowid}, ` : ''}* ${fromClause(target, buildSqliteWhere(req, columns))}`
  if (req.orderBy)
    sql += ` ORDER BY ${quoteIdent(req.orderBy.column, true)} ${req.orderBy.direction}`
  sql += ` LIMIT ${req.limit} OFFSET ${req.offset}`
  return sql
}

/** The table view's SELECT without LIMIT/OFFSET («Exportar resultado completo»). */
export function buildSqliteExportSelectSql(
  req: Omit<TableDataRequest, 'limit' | 'offset'>,
  target: SqliteTableTarget,
  identity: RowIdentity,
  columns: SqliteFilterColumn[] = []
): string {
  const full: TableDataRequest = { ...req, limit: 1, offset: 0 }
  validate(full, target)
  const rowid = rowidSelect(identity)
  let sql = `SELECT ${rowid ? `${rowid}, ` : ''}* ${fromClause(target, buildSqliteWhere(full, columns))}`
  if (req.orderBy)
    sql += ` ORDER BY ${quoteIdent(req.orderBy.column, true)} ${req.orderBy.direction}`
  return sql
}

export function buildSqliteCountSql(
  req: TableDataRequest,
  target: SqliteTableTarget,
  columns: SqliteFilterColumn[] = []
): string {
  validate(req, target)
  return `SELECT count(*) AS total ${fromClause(target, buildSqliteWhere(req, columns))}`
}

export async function filterColumns(
  session: SqliteQueryable,
  target: SqliteTableTarget,
  req: Pick<TableDataRequest, 'filter'>
): Promise<SqliteFilterColumn[]> {
  if (!sqliteFilterNeedsColumns(req.filter ?? null)) return []
  const columns = await listColumns(session, target.db, target.table)
  if (!columns.length)
    throw new SqliteUserError(`No se encontró la tabla ${target.db}.${target.table}`)
  return columns.map((c) => ({ name: c.name, typeKind: c.typeKind, dataType: c.columnType }))
}

/** One page of a table plus its key columns and the total (null when the count fails). */
export async function fetchSqliteTableData(
  connection: SqliteDriverConnection,
  req: TableDataRequest,
  target: SqliteTableTarget
): Promise<TableDataPage> {
  validate(req, target)
  const started = performance.now()
  return connection.exclusive(async (session) => {
    const identity = await rowIdentity(session, target.db, target.table)
    const columns = await filterColumns(session, target, req)
    const raw = await connection.runStatement(
      buildSqliteSelectSql(req, target, identity, columns),
      req.limit,
      ''
    )
    const resultColumns = await describeColumns(session, raw.columns)
    let total: number | null = null
    try {
      const [row] = await session.query<{ total: number }>(
        buildSqliteCountSql(req, target, columns)
      )
      total = typeof row?.total === 'number' ? row.total : null
    } catch {
      total = null
    }
    const primaryKey =
      identity.kind === 'rowid'
        ? [resultColumns.find((c) => c.primaryKey)?.name ?? identity.column ?? identity.alias]
        : identity.kind === 'primaryKey'
          ? identity.columns
          : []
    return {
      columns: resultColumns,
      rows: raw.rows ?? [],
      storage: raw.storage ?? [],
      primaryKey,
      total,
      durationMs: Math.round(performance.now() - started)
    }
  })
}
