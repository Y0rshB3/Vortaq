/**
 * SQL Server script execution (docs/sqlserver-design.md, «Ejecución»): the
 * script is split at GO lines and each batch is sent whole (`GO n` sends it n
 * times). Every reply of the server becomes one result, in order: a result
 * set, a row count ("N filas afectadas"), an error (the batch usually goes on,
 * as in SSMS) or PRINT/RAISERROR messages, attached as notices.
 *
 * A batch that is a single query (isSingleQuery) is described with
 * sp_describe_first_result_set in browse mode, which names the source
 * database/schema/table/column of each result column and whether it belongs
 * to a key: with that, results of one table or plain joins can be edited.
 */
import { performance } from 'node:perf_hooks'
import type { ColumnMetadata } from 'tedious/lib/token/colmetadata-token-parser'
import { isSingleQuery, splitStatements } from '@shared/dialects/sqlserver'
import type { CellValue, QueryColumn, QueryStatementResult } from '@shared/types'
import { DEFAULT_ROW_LIMIT, resolveMaxRows } from '../db/query'
import { describeError, errorLine } from './errors'
import type { BatchOutput, MsSession, ServerMessage } from './session'
import { normalizeCell, sqlServerTypeKind } from './values'

/** One column of sp_describe_first_result_set (browse mode 1). */
export interface DescribedColumn {
  ordinal: number
  name: string | null
  hidden: boolean
  typeName: string
  database: string | null
  schema: string | null
  table: string | null
  column: string | null
  key: boolean
}

/** Per-session cache of descriptions by batch text. */
export type DescribeCache = Map<string, DescribedColumn[] | null>

export function newDescribeCache(): DescribeCache {
  return new Map()
}

/** Source columns of a single-query batch, or null when the server cannot describe it. */
export async function describeQuery(
  session: Pick<MsSession, 'query'>,
  sql: string,
  cache: DescribeCache = newDescribeCache()
): Promise<DescribedColumn[] | null> {
  if (cache.has(sql)) return cache.get(sql) ?? null
  let described: DescribedColumn[] | null = null
  try {
    const rows = await session.query<Record<string, unknown>>(
      'EXEC sys.sp_describe_first_result_set @tsql = @p1, @params = NULL, @browse_information_mode = 1',
      [sql]
    )
    described = rows.map((r) => ({
      ordinal: Number(r.column_ordinal),
      name: r.name === null ? null : String(r.name),
      hidden: r.is_hidden === true,
      typeName: String(r.system_type_name ?? ''),
      database: r.source_database == null ? null : String(r.source_database),
      schema: r.source_schema == null ? null : String(r.source_schema),
      table: r.source_table == null ? null : String(r.source_table),
      column: r.source_column == null ? null : String(r.source_column),
      key: r.is_part_of_unique_key === true
    }))
  } catch {
    described = null
  }
  if (cache.size > 200) cache.clear()
  cache.set(sql, described)
  return described
}

/** SQL type label of a tedious column (when the server did not describe the result). */
export function typeLabel(
  meta: Pick<ColumnMetadata, 'type' | 'dataLength' | 'precision' | 'scale'>
): string {
  const name = meta.type.name
  const length = meta.dataLength ?? 0
  const sized = (base: string, chars: number): string =>
    length === 65535 || length === 0xffff ? `${base}(max)` : `${base}(${chars})`
  switch (name) {
    case 'IntN':
      return length === 1 ? 'tinyint' : length === 2 ? 'smallint' : length === 8 ? 'bigint' : 'int'
    case 'FloatN':
      return length === 4 ? 'real' : 'float'
    case 'MoneyN':
      return length === 4 ? 'smallmoney' : 'money'
    case 'BitN':
      return 'bit'
    case 'DateTimeN':
      return length === 4 ? 'smalldatetime' : 'datetime'
    case 'DecimalN':
    case 'NumericN':
      return `${name === 'DecimalN' ? 'decimal' : 'numeric'}(${meta.precision ?? 18},${meta.scale ?? 0})`
    case 'NVarChar':
      return sized('nvarchar', length / 2)
    case 'NChar':
      return `nchar(${length / 2})`
    case 'VarChar':
      return sized('varchar', length)
    case 'Char':
      return `char(${length})`
    case 'VarBinary':
      return sized('varbinary', length)
    case 'Binary':
      return `binary(${length})`
    case 'Time':
    case 'DateTime2':
    case 'DateTimeOffset':
      return `${name.toLowerCase()}(${meta.scale ?? 7})`
    case 'UniqueIdentifier':
      return 'uniqueidentifier'
    case 'Variant':
      return 'sql_variant'
    default:
      return name.toLowerCase()
  }
}

/** Result columns from the wire metadata plus, for single queries, the server's description. */
export function resultColumns(
  metadata: ColumnMetadata[],
  described: DescribedColumn[] | null,
  database: string
): QueryColumn[] {
  const visible = described?.filter((d) => !d.hidden) ?? null
  const usable = visible && visible.length === metadata.length ? visible : null
  return metadata.map((m, i) => {
    const d = usable?.[i]
    const type = d?.typeName || typeLabel(m)
    const column: QueryColumn = { name: m.colName, type, typeKind: sqlServerTypeKind(type) }
    if (d?.table && d.schema && d.column) {
      column.database = d.database ?? database
      column.schema = d.schema
      column.table = d.table
      column.sourceName = d.column
      if (d.key) column.primaryKey = true
    }
    return column
  })
}

export function normalizeRows(rows: unknown[][]): CellValue[][] {
  return rows.map((r) => r.map(normalizeCell))
}

/** 0-based offset of the start of `line` (1-based) in `sql`, or null. */
export function lineOffset(sql: string, line: number | null): number | null {
  if (!line || line < 1) return null
  let offset = 0
  for (let n = 1; n < line; n++) {
    const next = sql.indexOf('\n', offset)
    if (next < 0) return null
    offset = next + 1
  }
  return offset
}

/** «<explicación>. Mensaje del servidor: … (número)» of an ERROR token. */
export function describeServerMessage(m: ServerMessage): string {
  return describeError({ message: m.message, number: m.number, lineNumber: m.lineNumber })
}

export interface MsScriptHooks {
  /** Before the first batch. */
  before?(): Promise<void>
  /** After each batch's results (tab sessions: transaction state, database). */
  afterBatch?(results: QueryStatementResult[]): Promise<void>
  onStatementStart?(session: MsSession): void
  onStatementEnd?(): void
  cancelled?(): boolean
}

function emptyResult(sql: string, durationMs: number): QueryStatementResult {
  return {
    sql,
    durationMs,
    affectedRows: null,
    insertId: null,
    changedRows: null,
    warnings: 0,
    resultSet: null,
    error: null
  }
}

/**
 * Runs a script batch by batch on `session`. Stops after a batch with an
 * error unless stopOnError === false; a cancelled run never starts the next
 * batch.
 */
export async function executeMsScript(
  session: MsSession,
  script: string,
  options: { maxRows?: number; stopOnError?: boolean },
  defaultMaxRows = DEFAULT_ROW_LIMIT,
  hooks: MsScriptHooks = {},
  cache: DescribeCache = newDescribeCache()
): Promise<QueryStatementResult[]> {
  const maxRows = resolveMaxRows(options.maxRows, defaultMaxRows)
  const stopOnError = options.stopOnError !== false
  const results: QueryStatementResult[] = []
  await hooks.before?.()
  outer: for (const batch of splitStatements(script)) {
    const single = isSingleQuery(batch.sql)
    for (let run = 0; run < (batch.repeat ?? 1); run++) {
      if (hooks.cancelled?.()) break outer
      const started = performance.now()
      const batchResults: QueryStatementResult[] = []
      hooks.onStatementStart?.(session)
      let outputs: BatchOutput[] = []
      let cancelled = false
      try {
        const reply = await session.runBatch(batch.sql, { maxRows, stopAtCap: single })
        outputs = reply.outputs
        cancelled = reply.cancelled
      } catch (err) {
        const line = errorLine(err)
        batchResults.push({
          ...emptyResult(batch.sql, Math.round(performance.now() - started)),
          error: describeError(err),
          errorPosition: lineOffset(batch.sql, line)
        })
      } finally {
        hooks.onStatementEnd?.()
      }
      const durationMs = Math.round(performance.now() - started)
      const described =
        single && outputs.some((o) => o.kind === 'rows')
          ? await describeQuery(session, batch.sql, cache)
          : null
      for (const output of outputs) {
        const result = emptyResult(batch.sql, durationMs)
        if (output.messages.length) result.notices = output.messages
        if (output.kind === 'rows') {
          result.resultSet = {
            columns: resultColumns(output.columns, described, session.database),
            rows: normalizeRows(output.rows),
            truncated: output.truncated
          }
        } else if (output.kind === 'count') result.affectedRows = output.rowCount
        else if (output.kind === 'error') {
          result.error = describeServerMessage(output.error)
          result.errorPosition = lineOffset(batch.sql, output.error.lineNumber)
        }
        batchResults.push(result)
      }
      if (cancelled)
        batchResults.push({
          ...emptyResult(batch.sql, durationMs),
          error: 'Consulta cancelada por el usuario (ECANCEL)'
        })
      // DECLARE, SET, USE…: nothing came back, the batch still ran.
      if (!batchResults.length) batchResults.push(emptyResult(batch.sql, durationMs))
      await hooks.afterBatch?.(batchResults)
      results.push(...batchResults)
      if (cancelled || (stopOnError && batchResults.some((r) => r.error))) break outer
    }
  }
  return results
}
