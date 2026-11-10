/**
 * Structure-only reader for the AI assistant on SQL Server connections (same
 * guard model as metadata.ts and pgMetadata.ts).
 *
 * PRIVACY: `MsMetadataQueryable` refuses every statement that is not one
 * read-only SELECT whose sources are all `sys.*` or `INFORMATION_SCHEMA.*`
 * catalog views of the session's database (checked with the T-SQL lexer and
 * the dialect's write allowlist), so a bug in the context builder cannot read
 * table rows. Only names, types, keys, indexes, foreign keys, routine
 * parameters and row estimates are read: never defaults, module bodies
 * (OBJECT_DEFINITION) or rows. The only other statement is the estimated plan
 * of one read-only SELECT (SET SHOWPLAN_TEXT ON compiles it, nothing runs).
 */
import { analyzeWrites, isSingleQuery, splitStatements } from '@shared/dialects/sqlserver'
import { tokenizeTsql, tsqlCodeTokens, type MsToken } from '@shared/dialects/sqlserverLexer'
import type { MsSession } from '../sqlserver/session'
import type { Queryable, RoutineMeta, SchemaSnapshot, TableMeta } from './metadata'
import { MetadataOnlyError } from './metadata'

const CATALOG_SCHEMAS = new Set(['sys', 'information_schema'])
/** Functions that would read module text or data: refused even inside a catalog query. */
const FORBIDDEN_FUNCTIONS = new Set([
  'OBJECT_DEFINITION',
  'OPENROWSET',
  'OPENQUERY',
  'OPENDATASOURCE',
  'OPENJSON',
  'OPENXML'
])

const upper = (t: MsToken | undefined): string => (t?.kind === 'word' ? t.value.toUpperCase() : '')
const isPunct = (t: MsToken | undefined, v: string): boolean =>
  !!t && (t.kind === 'punct' || t.kind === 'op') && t.value === v
const nameOf = (t: MsToken | undefined): string | null =>
  t?.kind === 'ident' || t?.kind === 'word' ? t.value.toLowerCase() : null

const RELATION_END = new Set([
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'ON',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'FULL',
  'CROSS',
  'OUTER',
  'APPLY',
  'FOR',
  'OPTION',
  'WITH'
])

/** Every relation after FROM / JOIN / APPLY is `sys.x` or `INFORMATION_SCHEMA.x` (two parts). */
function relationsAreCatalog(tokens: MsToken[]): boolean {
  let found = false
  for (let i = 0; i < tokens.length; i++) {
    const word = upper(tokens[i])
    if (word !== 'FROM' && word !== 'JOIN' && word !== 'APPLY') continue
    let j = i + 1
    for (;;) {
      if (isPunct(tokens[j], '(')) break // subquery: its own FROM is checked by the outer loop
      const first = nameOf(tokens[j])
      if (first === null) return false
      if (!isPunct(tokens[j + 1], '.')) return false // unqualified relation
      const second = nameOf(tokens[j + 2])
      if (second === null || !CATALOG_SCHEMAS.has(first)) return false
      if (isPunct(tokens[j + 3], '.')) return false // three-part name: another database
      found = true
      j += 3
      if (isPunct(tokens[j], '(')) break // catalog function, e.g. sys.dm_db_index_physical_stats(…)
      if (upper(tokens[j]) === 'AS') j += 2
      else if (
        (tokens[j]?.kind === 'word' && !RELATION_END.has(upper(tokens[j]))) ||
        tokens[j]?.kind === 'ident'
      )
        j++
      if (word === 'FROM' && isPunct(tokens[j], ',')) {
        j++
        continue
      }
      break
    }
  }
  return found
}

/** True when `sql` may run through the SQL Server metadata reader. */
export function isMsMetadataSql(sql: string): boolean {
  if (/^\s*SELECT\s+@@VERSION(\s+AS\s+version)?\s*$/i.test(sql)) return true
  if (splitStatements(sql).length !== 1 || !isSingleQuery(sql)) return false
  const tokens = tsqlCodeTokens(tokenizeTsql(sql))
  if (upper(tokens[0]) !== 'SELECT') return false
  if (tokens.some((t) => isPunct(t, ';') || upper(t) === 'INTO')) return false
  // Only the reader's own @p parameters; no system variables that could carry data.
  if (tokens.some((t) => t.kind === 'variable' && !/^@p\d+$/i.test(t.value))) return false
  if (tokens.some((t, i) => FORBIDDEN_FUNCTIONS.has(upper(t)) && isPunct(tokens[i + 1], '(')))
    return false
  if (analyzeWrites(sql).writes) return false
  return relationsAreCatalog(tokens)
}

/** Wraps a SQL Server session so only catalog reads reach the server. */
export class MsMetadataQueryable implements Queryable {
  constructor(private readonly inner: Queryable) {}
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    if (!isMsMetadataSql(sql)) throw new MetadataOnlyError()
    return this.inner.query<T>(sql, params)
  }
}

type Row = Record<string, unknown>
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/** Structure of one schema of the session's database (all tables, or only `only`). */
export async function readMsSchemaSnapshot(
  q: MsMetadataQueryable,
  schema: string,
  only?: string[]
): Promise<SchemaSnapshot> {
  const wanted = only && only.length ? new Set(only) : null
  const keep = (name: unknown): boolean => !wanted || wanted.has(str(name))
  const tables = (
    await q.query<Row>(
      `SELECT o.name, o.type,
              (SELECT SUM(p.rows) FROM sys.partitions p
                WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS rows,
              (SELECT CAST(ep.value AS nvarchar(4000)) FROM sys.extended_properties ep
                WHERE ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0
                  AND ep.name = N'MS_Description') AS comment
         FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @p1 AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
        ORDER BY o.name`,
      [schema]
    )
  ).filter((t) => keep(t.name))
  const columns = await q.query<Row>(
    `SELECT o.name AS tbl, c.name, TYPE_NAME(c.user_type_id) AS type, c.max_length, c.precision, c.scale,
            c.is_nullable, c.is_identity, c.is_computed,
            CAST(CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i
                  JOIN sys.index_columns k ON k.object_id = i.object_id AND k.index_id = i.index_id
                 WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND k.column_id = c.column_id)
                 THEN 1 ELSE 0 END AS bit) AS pk,
            (SELECT CAST(ep.value AS nvarchar(4000)) FROM sys.extended_properties ep
              WHERE ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id
                AND ep.name = N'MS_Description') AS comment
       FROM sys.columns c
       JOIN sys.objects o ON o.object_id = c.object_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = @p1 AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
      ORDER BY o.name, c.column_id`,
    [schema]
  )
  const indexes = await q.query<Row>(
    `SELECT o.name AS tbl, i.name, i.is_unique, c.name AS col
       FROM sys.indexes i
       JOIN sys.index_columns k ON k.object_id = i.object_id AND k.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = k.object_id AND c.column_id = k.column_id
       JOIN sys.objects o ON o.object_id = i.object_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = @p1 AND o.type IN ('U', 'V') AND i.index_id > 0 AND k.is_included_column = 0
      ORDER BY o.name, i.name, k.key_ordinal`,
    [schema]
  )
  const foreignKeys = await q.query<Row>(
    `SELECT o.name AS tbl, fk.name, pc.name AS col, rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_col
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns k ON k.constraint_object_id = fk.object_id
       JOIN sys.objects o ON o.object_id = fk.parent_object_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       JOIN sys.columns pc ON pc.object_id = k.parent_object_id AND pc.column_id = k.parent_column_id
       JOIN sys.objects rt ON rt.object_id = k.referenced_object_id
       JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
       JOIN sys.columns rc ON rc.object_id = k.referenced_object_id AND rc.column_id = k.referenced_column_id
      WHERE s.name = @p1
      ORDER BY o.name, fk.name, k.constraint_column_id`,
    [schema]
  )
  const routines = wanted
    ? []
    : await q.query<Row>(
        `SELECT o.name, RTRIM(o.type) AS type, p.parameter_id, p.name AS param,
                TYPE_NAME(p.user_type_id) AS param_type
           FROM sys.objects o
           JOIN sys.schemas s ON s.schema_id = o.schema_id
           LEFT JOIN sys.parameters p ON p.object_id = o.object_id
          WHERE s.name = @p1 AND o.is_ms_shipped = 0
            AND o.type IN ('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT')
          ORDER BY o.name, p.parameter_id`,
        [schema]
      )
  const [version] = await q.query<Row>(
    "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS v, CAST(SERVERPROPERTY('EngineEdition') AS int) AS ed  FROM sys.databases d WHERE d.database_id = DB_ID()"
  )

  const byName = new Map<string, TableMeta>()
  for (const t of tables)
    byName.set(str(t.name), {
      name: str(t.name),
      kind: str(t.type).trim() === 'V' ? 'view' : 'table',
      rows: str(t.type).trim() === 'V' || t.rows === null ? null : Number(t.rows),
      comment: str(t.comment),
      columns: [],
      indexes: [],
      foreignKeys: []
    })
  for (const c of columns) {
    const type = str(c.type)
    const length = Number(c.max_length)
    const sized = ['varchar', 'char', 'varbinary', 'binary'].includes(type)
      ? `${type}(${length === -1 ? 'max' : length})`
      : ['nvarchar', 'nchar'].includes(type)
        ? `${type}(${length === -1 ? 'max' : length / 2})`
        : ['decimal', 'numeric'].includes(type)
          ? `${type}(${str(c.precision)},${str(c.scale)})`
          : type
    byName.get(str(c.tbl))?.columns.push({
      name: str(c.name),
      type: sized,
      nullable: c.is_nullable === true,
      key: c.pk === true ? 'PRI' : '',
      extra: c.is_identity === true ? 'identity' : c.is_computed === true ? 'computed' : '',
      comment: str(c.comment)
    })
  }
  for (const i of indexes) {
    const table = byName.get(str(i.tbl))
    if (!table) continue
    let index = table.indexes.find((x) => x.name === str(i.name))
    if (!index) {
      index = { name: str(i.name), unique: i.is_unique === true, columns: [] }
      table.indexes.push(index)
    }
    index.columns.push(str(i.col))
  }
  for (const f of foreignKeys) {
    const table = byName.get(str(f.tbl))
    if (!table) continue
    let fk = table.foreignKeys.find((x) => x.name === str(f.name))
    if (!fk) {
      fk = {
        name: str(f.name),
        columns: [],
        refSchema: str(f.ref_schema),
        refTable: str(f.ref_table),
        refColumns: []
      }
      table.foreignKeys.push(fk)
    }
    fk.columns.push(str(f.col))
    fk.refColumns.push(str(f.ref_col))
  }
  const routineMeta = new Map<string, RoutineMeta>()
  for (const r of routines) {
    const name = str(r.name)
    const type = str(r.type)
    let routine = routineMeta.get(name)
    if (!routine) {
      routine = {
        name,
        type: type === 'P' || type === 'PC' ? 'PROCEDURE' : 'FUNCTION',
        params: [],
        returns: type === 'IF' || type === 'TF' || type === 'FT' ? 'TABLE' : null
      }
      routineMeta.set(name, routine)
    }
    if (r.param_type === null || r.param_type === undefined) continue
    if (Number(r.parameter_id) === 0) routine.returns = str(r.param_type)
    else routine.params.push(`${str(r.param)} ${str(r.param_type)}`)
  }
  const ed = Number(version?.ed)
  const product =
    ed === 5 ? 'Azure SQL Database' : ed === 8 ? 'Azure SQL Managed Instance' : 'SQL Server'
  return {
    schema,
    serverVersion: `${product} ${str(version?.v)}`.trim(),
    tables: [...byName.values()],
    routines: [...routineMeta.values()]
  }
}

/** User schemas of the session's database that hold tables or views (dbo always). */
export async function readMsSchemaNames(q: MsMetadataQueryable): Promise<string[]> {
  const rows = await q.query<Row>(
    `SELECT s.name FROM sys.schemas s
      WHERE NOT (s.schema_id IN (2, 3, 4) OR s.schema_id BETWEEN 16384 AND 16399)
        AND (s.name = N'dbo' OR EXISTS (SELECT 1 FROM sys.objects o
              WHERE o.schema_id = s.schema_id AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0))
      ORDER BY s.name`
  )
  return rows.map((r) => str(r.name))
}

/** One read-only SELECT (its estimated plan may be read; it is never executed). */
export function isSingleMsSelect(sql: string | null | undefined): boolean {
  if (!sql?.trim()) return false
  const batches = splitStatements(sql)
  return (
    batches.length === 1 && isSingleQuery(batches[0].sql) && !analyzeWrites(batches[0].sql).writes
  )
}

/**
 * Estimated plan (SET SHOWPLAN_TEXT ON: the SELECT is compiled, never run) of
 * a single read-only SELECT, on a pooled session that is reset afterwards;
 * null otherwise or on failure.
 */
export async function explainMsSelect(session: MsSession, sql: string): Promise<string | null> {
  if (!isSingleMsSelect(sql)) return null
  const statement = splitStatements(sql)[0].sql
  session.usage.userSql = true
  try {
    await session.exec('SET SHOWPLAN_TEXT ON')
    try {
      const { rows } = await session.queryArrays(statement)
      const lines = rows.map((r) => String(r[0] ?? '')).flatMap((t) => t.split('\n'))
      return (
        lines.slice(0, 80).join('\n') +
        (lines.length > 80 ? `\n… ${lines.length - 80} líneas más` : '')
      )
    } finally {
      await session.exec('SET SHOWPLAN_TEXT OFF')
    }
  } catch {
    return null
  }
}
