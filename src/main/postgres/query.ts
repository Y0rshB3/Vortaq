/**
 * PostgreSQL script execution (docs/multi-engine-design.md, sections 5.3.1,
 * 5.4 and 5.5): split with the PG dialect, run statement by statement on one
 * session (pooled, or the query tab's own), cap rows through pg-cursor, and
 * resolve every result column to its source table in one catalog query
 * (RowDescription tableID/columnID -> pg_class/pg_attribute) so single-table
 * results are editable. Views report the view's oid: they are read-only.
 */
import { performance } from 'node:perf_hooks'
import type { FieldDef } from 'pg'
import { postgresqlDialect } from '@shared/dialects/postgresql'
import type { CellValue, QueryColumn, QueryStatementResult } from '@shared/types'
import { DEFAULT_ROW_LIMIT, resolveMaxRows } from '../db/query'
import { DbUserError } from '../db/errors'
import { describeError, errorPosition, sqlState } from './errors'
import type { PgSession, PgRawStatement } from './session'
import { BUILTIN_TYPES, normalizeCell, typeKindOf, type PgTypeFacts } from './values'

type Row = Record<string, unknown>

interface SourceColumn {
  schema: string
  table: string
  relkind: string
  column: string
  pk: boolean
}

/** Per-session caches: table sources by tableID/columnID and type facts by OID. */
export interface ResolveCache {
  sources: Map<string, SourceColumn | null>
  types: Map<number, PgTypeFacts & { label: string }>
}

export function newResolveCache(): ResolveCache {
  return { sources: new Map(), types: new Map() }
}

const sourceKey = (tid: number, cid: number): string => `${tid}:${cid}`

/**
 * Source metadata of a result's fields in at most two catalog queries
 * (sources and non-builtin types), cached per session.
 */
export async function resolveFields(
  session: Pick<PgSession, 'query' | 'database'>,
  fields: FieldDef[],
  cache: ResolveCache = newResolveCache()
): Promise<QueryColumn[]> {
  const missingSources = fields.filter(
    (f) => f.tableID > 0 && !cache.sources.has(sourceKey(f.tableID, f.columnID))
  )
  if (missingSources.length) {
    const rows = await session.query<Row>(
      `SELECT k.tid::int8 AS tid, k.cid::int AS cid, n.nspname AS schema, cl.relname AS table,
              cl.relkind::text AS relkind, at.attname AS column,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = cl.oid AND i.indisprimary
                         AND at.attnum = ANY(i.indkey)) AS pk
         FROM (SELECT ($1::oid[])[x] AS tid, ($2::int2[])[x] AS cid
                 FROM generate_subscripts($1::oid[], 1) AS x) k
         JOIN pg_class cl ON cl.oid = k.tid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
         JOIN pg_attribute at ON at.attrelid = k.tid AND at.attnum = k.cid`,
      [missingSources.map((f) => f.tableID), missingSources.map((f) => f.columnID)]
    )
    for (const f of missingSources) cache.sources.set(sourceKey(f.tableID, f.columnID), null)
    for (const r of rows)
      cache.sources.set(sourceKey(Number(r.tid), Number(r.cid)), {
        schema: String(r.schema),
        table: String(r.table),
        relkind: String(r.relkind),
        column: String(r.column),
        pk: r.pk === true
      })
  }
  const missingTypes = [
    ...new Set(
      fields.map((f) => f.dataTypeID).filter((oid) => !BUILTIN_TYPES[oid] && !cache.types.has(oid))
    )
  ]
  if (missingTypes.length) {
    const rows = await session.query<Row>(
      `SELECT t.oid::int8 AS oid, format_type(t.oid, NULL) AS label,
              COALESCE(bt.typname, t.typname) AS name,
              COALESCE(bt.typcategory, t.typcategory)::text AS category,
              COALESCE(bt.typtype, t.typtype)::text AS type
         FROM pg_type t LEFT JOIN pg_type bt ON t.typtype = 'd' AND bt.oid = t.typbasetype
        WHERE t.oid = ANY($1::oid[])`,
      [missingTypes]
    )
    for (const r of rows)
      cache.types.set(Number(r.oid), {
        oid: Number(r.oid),
        name: String(r.name),
        category: String(r.category),
        type: String(r.type),
        label: String(r.label)
      })
  }
  return fields.map((f) => {
    const builtin = BUILTIN_TYPES[f.dataTypeID]
    const facts = builtin ? { ...builtin, label: builtin.name } : cache.types.get(f.dataTypeID)
    const column: QueryColumn = {
      name: f.name,
      type: facts?.label ?? `oid ${f.dataTypeID}`,
      typeKind: facts ? typeKindOf(facts) : 'other',
      database: session.database
    }
    const source = f.tableID > 0 ? cache.sources.get(sourceKey(f.tableID, f.columnID)) : null
    if (source) {
      column.schema = source.schema
      column.table = source.table
      column.sourceName = source.column
      if (source.pk) column.primaryKey = true
      if (source.relkind !== 'r' && source.relkind !== 'p')
        column.readOnlyReason =
          source.relkind === 'v' || source.relkind === 'm' ? 'vista' : 'no es una tabla'
    }
    return column
  })
}

export function normalizeRows(rows: unknown[][]): CellValue[][] {
  return rows.map((r) => r.map(normalizeCell))
}

/** Command tags whose row count is "affected rows" (not a result set). */
const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY'])

export interface PgScriptHooks {
  /** Before the first statement (tab sessions: search_path, read-only lift). */
  before?(): Promise<void>
  /** After each statement, success or not (tab sessions: effective schema). */
  afterStatement?(result: QueryStatementResult): Promise<void>
  /** Registered while a statement runs; returns whether the run was cancelled. */
  onStatementStart?(session: PgSession): void
  onStatementEnd?(): void
  cancelled?(): boolean
  /** Error text for a failed statement (the guard maps 25006 inside read-only transactions). */
  explain?(err: unknown): string
}

/**
 * Runs a script statement by statement on `session`. Stops at the first error
 * unless stopOnError === false; a cancelled run never starts the next statement.
 */
export async function executePgScript(
  session: PgSession,
  script: string,
  options: { maxRows?: number; stopOnError?: boolean },
  defaultMaxRows = DEFAULT_ROW_LIMIT,
  hooks: PgScriptHooks = {},
  cache: ResolveCache = newResolveCache()
): Promise<QueryStatementResult[]> {
  const maxRows = resolveMaxRows(options.maxRows, defaultMaxRows)
  const stopOnError = options.stopOnError !== false
  const results: QueryStatementResult[] = []
  await hooks.before?.()
  for (const stmt of postgresqlDialect.splitStatements(script)) {
    if (hooks.cancelled?.()) break
    const started = performance.now()
    let result: QueryStatementResult
    let raw: PgRawStatement | null = null
    hooks.onStatementStart?.(session)
    try {
      raw = await session.runStatement(stmt.sql, maxRows)
    } catch (err) {
      const position = errorPosition(err)
      result = {
        sql: stmt.sql,
        durationMs: Math.round(performance.now() - started),
        affectedRows: null,
        insertId: null,
        changedRows: null,
        warnings: 0,
        resultSet: null,
        error: hooks.explain ? hooks.explain(err) : describeError(err),
        notices: session.takeNotices(),
        errorPosition: position
      }
    } finally {
      hooks.onStatementEnd?.()
    }
    if (raw) {
      const command = (raw.command ?? '').toUpperCase()
      if (!command.startsWith('SELECT') && command !== 'SHOW' && command !== 'FETCH')
        cache.sources.clear()
      const hasRows = raw.fields.length > 0
      let columns: QueryColumn[] = []
      try {
        columns = hasRows ? await resolveFields(session, raw.fields, cache) : []
      } catch {
        // Inside a failed transaction the catalog cannot be read: plain names and types.
        columns = raw.fields.map((f) => ({ name: f.name, type: `oid ${f.dataTypeID}` }))
      }
      result = {
        sql: stmt.sql,
        durationMs: Math.round(performance.now() - started),
        affectedRows: DML.has(command) || (!hasRows && raw.rowCount !== null) ? raw.rowCount : null,
        insertId: null,
        changedRows: null,
        warnings: 0,
        resultSet: hasRows
          ? { columns, rows: normalizeRows(raw.rows), truncated: raw.truncated }
          : null,
        error: null,
        ...(raw.notices.length ? { notices: raw.notices } : {})
      }
    }
    await hooks.afterStatement?.(result!)
    results.push(result!)
    if (result!.error && stopOnError) break
  }
  return results
}

/** The SQLSTATE of an error that ended a statement (for tests and guards). */
export function errorState(err: unknown): string | null {
  return sqlState(err)
}

/** A DbUserError never echoes server text, so it is a safe trusted message. */
export function isTrusted(err: unknown): boolean {
  return err instanceof DbUserError
}
