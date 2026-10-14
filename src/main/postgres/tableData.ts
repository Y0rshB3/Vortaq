/**
 * PostgreSQL table browsing (docs/multi-engine-design.md, sections 5.1 and
 * 6): `LIMIT n OFFSET m` (never `LIMIT m, n`), identifiers quoted with "",
 * the structured filter compiled by tableFilter.ts, and a best-effort count
 * bounded by a 3 s statement_timeout (SET LOCAL inside a short transaction,
 * so nothing leaks to the pooled session).
 */
import { performance } from 'node:perf_hooks'
import { quoteIdent } from '@shared/dialects/postgresql'
import type { TableDataPage, TableDataRequest } from '@shared/types'
import { fetchTablePage } from '../db/tableData'
import { MAX_ROWS_CAP } from '../db/query'
import { PgUserError } from './errors'
import { listColumns, primaryKeyColumns } from './introspect'
import { newResolveCache, normalizeRows, resolveFields } from './query'
import type { PgSession } from './session'
import { buildPgFilterWhere, pgFilterNeedsColumns, type PgFilterColumn } from './tableFilter'

export const COUNT_TIMEOUT_MS = 3000

export interface PgTableTarget {
  schema: string
  table: string
}

function validate(req: TableDataRequest, target: PgTableTarget): void {
  if (!target.schema || !target.table) throw new PgUserError('Falta el esquema o la tabla')
  if (!Number.isInteger(req.limit) || req.limit < 1 || req.limit > MAX_ROWS_CAP)
    throw new PgUserError(`El límite de filas debe estar entre 1 y ${MAX_ROWS_CAP}`)
  if (!Number.isInteger(req.offset) || req.offset < 0)
    throw new PgUserError('El desplazamiento debe ser 0 o mayor')
  if (req.orderBy && req.orderBy.direction !== 'ASC' && req.orderBy.direction !== 'DESC')
    throw new PgUserError('La dirección de ordenación debe ser ASC o DESC')
}

/** WHERE body: the raw WHERE (own lines and parentheses) AND the structured filter. */
export function buildPgWhere(req: TableDataRequest, columns: PgFilterColumn[] = []): string {
  const parts: string[] = []
  const raw = req.where?.trim()
  if (raw) parts.push(`(\n${raw}\n)`)
  const filter = buildPgFilterWhere(req.filter ?? null, columns)
  if (filter) parts.push(`(${filter})`)
  return parts.join(' AND ')
}

function fromClause(target: PgTableTarget, where: string): string {
  let sql = `FROM ${quoteIdent(target.schema)}.${quoteIdent(target.table)}`
  if (where) sql += ` WHERE ${where}`
  return sql
}

export function buildPgSelectSql(
  req: TableDataRequest,
  target: PgTableTarget,
  columns: PgFilterColumn[] = []
): string {
  validate(req, target)
  let sql = `SELECT * ${fromClause(target, buildPgWhere(req, columns))}`
  if (req.orderBy) sql += ` ORDER BY ${quoteIdent(req.orderBy.column)} ${req.orderBy.direction}`
  sql += ` LIMIT ${req.limit} OFFSET ${req.offset}`
  return sql
}

/** The table view's SELECT without LIMIT/OFFSET («Exportar resultado completo»). */
export function buildPgExportSelectSql(
  req: Omit<TableDataRequest, 'limit' | 'offset'>,
  target: PgTableTarget,
  columns: PgFilterColumn[] = []
): string {
  const full: TableDataRequest = { ...req, limit: 1, offset: 0 }
  validate(full, target)
  let sql = `SELECT * ${fromClause(target, buildPgWhere(full, columns))}`
  if (req.orderBy) sql += ` ORDER BY ${quoteIdent(req.orderBy.column)} ${req.orderBy.direction}`
  return sql
}

export function buildPgCountSql(
  req: TableDataRequest,
  target: PgTableTarget,
  columns: PgFilterColumn[] = []
): string {
  validate(req, target)
  return `SELECT count(*) AS total ${fromClause(target, buildPgWhere(req, columns))}`
}

/** Columns for the structured filter (only fetched when it needs them). */
export async function pgFilterColumns(
  session: PgSession,
  target: PgTableTarget,
  req: Pick<TableDataRequest, 'filter'>
): Promise<PgFilterColumn[]> {
  if (!pgFilterNeedsColumns(req.filter ?? null)) return []
  const columns = await listColumns(session, target.schema, target.table)
  if (!columns.length)
    throw new PgUserError(`No se encontró la tabla ${target.schema}.${target.table}`)
  return columns.map((c) => ({ name: c.name, typeKind: c.typeKind, dataType: c.dataType }))
}

export async function fetchPgTableData(
  session: PgSession,
  req: TableDataRequest,
  target: PgTableTarget
): Promise<TableDataPage> {
  validate(req, target)
  const started = performance.now()
  const columns = await pgFilterColumns(session, target, req)
  const select = buildPgSelectSql(req, target, columns)
  const countSql = buildPgCountSql(req, target, columns)
  const cache = newResolveCache()
  return fetchTablePage(
    {
      primaryKey: () => primaryKeyColumns(session, target.schema, target.table),
      page: async () => {
        const raw = await session.runStatement(select, req.limit)
        return {
          columns: await resolveFields(session, raw.fields, cache),
          rows: normalizeRows(raw.rows)
        }
      },
      count: async () => {
        // statement_timeout local to a read-only transaction: a slow count gives null.
        return session.transaction(async (s) => {
          await s.query(`SET LOCAL statement_timeout = ${COUNT_TIMEOUT_MS}`)
          const [row] = await s.query<{ total: string | number }>(countSql)
          const n = Number(row?.total)
          return Number.isFinite(n) ? n : null
        }, 'BEGIN READ ONLY')
      }
    },
    started
  )
}
