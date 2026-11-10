/**
 * SQL Server table browsing (docs/sqlserver-design.md, «Datos»):
 * `ORDER BY … OFFSET n ROWS FETCH NEXT m ROWS ONLY` (the order is the chosen
 * column, else the primary key, else `(SELECT NULL)`), names bracketed when
 * needed, the structured filter compiled by tableFilter.ts, and a best-effort
 * COUNT_BIG(*) the server cancels after 3 s.
 */
import { performance } from 'node:perf_hooks'
import { quoteIdent } from '@shared/dialects/sqlserver'
import type { QueryColumn, TableDataPage, TableDataRequest } from '@shared/types'
import { MAX_ROWS_CAP } from '../db/query'
import { fetchTablePage } from '../db/tableData'
import { MsUserError } from './errors'
import { listColumns, primaryKeyColumns, type MsColumnInfo } from './introspect'
import { normalizeRows, typeLabel } from './query'
import type { MsSession } from './session'
import { buildMsFilterWhere, msFilterNeedsColumns, type MsFilterColumn } from './tableFilter'

export const COUNT_TIMEOUT_MS = 3000

export interface MsTableTarget {
  schema: string
  table: string
}

function validate(
  req: Omit<TableDataRequest, 'limit' | 'offset'> & { limit: number; offset: number },
  target: MsTableTarget
): void {
  if (!target.schema || !target.table) throw new MsUserError('Falta el esquema o la tabla')
  if (!Number.isInteger(req.limit) || req.limit < 1 || req.limit > MAX_ROWS_CAP)
    throw new MsUserError(`El límite de filas debe estar entre 1 y ${MAX_ROWS_CAP}`)
  if (!Number.isInteger(req.offset) || req.offset < 0)
    throw new MsUserError('El desplazamiento debe ser 0 o mayor')
  if (req.orderBy && req.orderBy.direction !== 'ASC' && req.orderBy.direction !== 'DESC')
    throw new MsUserError('La dirección de ordenación debe ser ASC o DESC')
}

/** WHERE body: the raw WHERE (own lines and parentheses) AND the structured filter. */
export function buildMsWhere(
  req: Pick<TableDataRequest, 'where' | 'filter'>,
  columns: MsFilterColumn[] = []
): string {
  const parts: string[] = []
  const raw = req.where?.trim()
  if (raw) parts.push(`(\n${raw}\n)`)
  const filter = buildMsFilterWhere(req.filter ?? null, columns)
  if (filter) parts.push(`(${filter})`)
  return parts.join(' AND ')
}

function fromClause(target: MsTableTarget, where: string): string {
  let sql = `FROM ${quoteIdent(target.schema)}.${quoteIdent(target.table)}`
  if (where) sql += ` WHERE ${where}`
  return sql
}

function orderClause(req: Pick<TableDataRequest, 'orderBy'>, primaryKey: string[]): string {
  if (req.orderBy) return ` ORDER BY ${quoteIdent(req.orderBy.column)} ${req.orderBy.direction}`
  if (primaryKey.length) return ` ORDER BY ${primaryKey.map((k) => quoteIdent(k)).join(', ')}`
  return ' ORDER BY (SELECT NULL)'
}

export function buildMsSelectSql(
  req: TableDataRequest,
  target: MsTableTarget,
  columns: MsFilterColumn[] = [],
  primaryKey: string[] = []
): string {
  validate(req, target)
  return (
    `SELECT * ${fromClause(target, buildMsWhere(req, columns))}` +
    orderClause(req, primaryKey) +
    ` OFFSET ${req.offset} ROWS FETCH NEXT ${req.limit} ROWS ONLY`
  )
}

/** The table view's SELECT without paging («Exportar resultado completo»). */
export function buildMsExportSelectSql(
  req: Omit<TableDataRequest, 'limit' | 'offset'>,
  target: MsTableTarget,
  columns: MsFilterColumn[] = []
): string {
  validate({ ...req, limit: 1, offset: 0 }, target)
  let sql = `SELECT * ${fromClause(target, buildMsWhere(req, columns))}`
  if (req.orderBy) sql += ` ORDER BY ${quoteIdent(req.orderBy.column)} ${req.orderBy.direction}`
  return sql
}

export function buildMsCountSql(
  req: TableDataRequest,
  target: MsTableTarget,
  columns: MsFilterColumn[] = []
): string {
  validate(req, target)
  return `SELECT COUNT_BIG(*) AS total ${fromClause(target, buildMsWhere(req, columns))}`
}

/** Columns for the structured filter (only fetched when it needs them). */
export async function msFilterColumns(
  session: MsSession,
  target: MsTableTarget,
  req: Pick<TableDataRequest, 'filter'>
): Promise<MsFilterColumn[]> {
  if (!msFilterNeedsColumns(req.filter ?? null)) return []
  const columns = await listColumns(session, target.schema, target.table)
  if (!columns.length)
    throw new MsUserError(`No se encontró la tabla ${target.schema}.${target.table}`)
  return columns.map((c) => ({ name: c.name, typeKind: c.typeKind, dataType: c.dataType }))
}

/** Why the grid never writes a column: identity, computed, rowversion, period columns. */
export function lockReason(c: MsColumnInfo): string | null {
  if (c.autoIncrement) return 'columna IDENTITY (la genera el servidor)'
  if (c.computed !== null) return 'columna calculada'
  if (c.generated) return 'la genera el servidor'
  return null
}

/** Result columns of `SELECT *` on the table, tied to it (names are the table's own). */
export function tableColumns(
  names: { colName: string; meta: Parameters<typeof typeLabel>[0] }[],
  columns: MsColumnInfo[],
  database: string,
  target: MsTableTarget
): QueryColumn[] {
  const byName = new Map(columns.map((c) => [c.name, c]))
  return names.map(({ colName, meta }) => {
    const c = byName.get(colName)
    const column: QueryColumn = {
      name: colName,
      type: c?.columnType ?? typeLabel(meta),
      typeKind: c?.typeKind
    }
    if (c) {
      column.database = database
      column.schema = target.schema
      column.table = target.table
      column.sourceName = c.name
      if (c.primaryKey) column.primaryKey = true
      const locked = lockReason(c)
      if (locked) column.locked = locked
    }
    return column
  })
}

export async function fetchMsTableData(
  session: MsSession,
  req: TableDataRequest,
  target: MsTableTarget
): Promise<TableDataPage> {
  validate(req, target)
  const started = performance.now()
  const all = await listColumns(session, target.schema, target.table)
  if (!all.length) throw new MsUserError(`No se encontró la tabla ${target.schema}.${target.table}`)
  const filterColumns = msFilterNeedsColumns(req.filter ?? null)
    ? all.map((c) => ({ name: c.name, typeKind: c.typeKind, dataType: c.dataType }))
    : []
  const primaryKey = await primaryKeyColumns(session, target.schema, target.table)
  const select = buildMsSelectSql(req, target, filterColumns, primaryKey)
  const countSql = buildMsCountSql(req, target, filterColumns)
  return fetchTablePage(
    {
      primaryKey: async () => primaryKey,
      page: async () => {
        const raw = await session.queryArrays(select)
        return {
          columns: tableColumns(
            raw.columns.map((m) => ({ colName: m.colName, meta: m })),
            all,
            session.database,
            target
          ),
          rows: normalizeRows(raw.rows)
        }
      },
      count: async () => {
        const [row] = await session.query<{ total: string | number }>(countSql, undefined, {
          timeoutMs: COUNT_TIMEOUT_MS
        })
        const n = Number(row?.total)
        return Number.isFinite(n) ? n : null
      }
    },
    started
  )
}
