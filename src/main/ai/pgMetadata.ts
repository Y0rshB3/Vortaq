/**
 * Structure-only reader for the AI assistant on PostgreSQL connections (same
 * guard model as metadata.ts for MySQL).
 *
 * PRIVACY: `PgMetadataQueryable` refuses every statement that is not one
 * read-only SELECT whose relations are all in pg_catalog or
 * information_schema (or `SELECT version()`), checked with the PostgreSQL
 * lexer and the dialect's write allowlist, so a bug in the context builder
 * cannot read table rows or call a function with side effects. Only names,
 * types, keys, indexes, foreign keys, routine signatures and row estimates
 * are read: no defaults, view or routine bodies, trigger statements or rows.
 */
import { codeTokens, tokenizePg, type PgToken } from '@shared/dialects/pgLexer'
import { analyzeWrites, splitStatements } from '@shared/dialects/postgresql'
import type { Queryable, RoutineMeta, SchemaSnapshot, TableMeta } from './metadata'
import { MetadataOnlyError } from './metadata'
import {
  attgeneratedSql,
  attidentitySql,
  featuresOf,
  indexKeyCountSql,
  prokindSql,
  relispartitionSql
} from '../postgres/catalogCompat'

const CATALOG_SCHEMAS = new Set(['pg_catalog', 'information_schema'])
const RELATION_END = new Set([
  'WHERE',
  'GROUP',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'HAVING',
  'WINDOW',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'ON',
  'USING',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'FULL',
  'CROSS',
  'NATURAL',
  'OUTER',
  'LATERAL',
  'FETCH',
  'FOR'
])

const upper = (t: PgToken | undefined): string => (t?.kind === 'word' ? t.value.toUpperCase() : '')
const isPunct = (t: PgToken | undefined, v: string): boolean =>
  !!t && (t.kind === 'punct' || t.kind === 'op') && t.value === v
const nameOf = (t: PgToken | undefined): string | null =>
  t?.kind === 'ident' ? t.value : t?.kind === 'word' ? t.value.toLowerCase() : null

/**
 * Every relation after FROM / JOIN (and comma lists in FROM) must be
 * `pg_catalog.x` or `information_schema.x`; set-returning functions such as
 * `unnest(…)` or `generate_series(…)` are allowed (they read no table).
 */
function relationsAreCatalog(tokens: PgToken[]): boolean {
  let found = false
  for (let i = 0; i < tokens.length; i++) {
    const word = upper(tokens[i])
    if (word !== 'FROM' && word !== 'JOIN') continue
    let j = i + 1
    for (;;) {
      if (upper(tokens[j]) === 'LATERAL' || upper(tokens[j]) === 'ONLY') j++
      if (isPunct(tokens[j], '(')) break // subquery: its own FROM is checked by the outer loop
      const first = nameOf(tokens[j])
      if (first === null) return false
      if (isPunct(tokens[j + 1], '(')) break // function in FROM (unnest, generate_series…)
      if (!isPunct(tokens[j + 1], '.')) return false // unqualified relation
      const second = nameOf(tokens[j + 2])
      if (second === null || !CATALOG_SCHEMAS.has(first)) return false
      found = true
      j += 3
      // optional alias
      if (upper(tokens[j]) === 'AS') j += 2
      else if (tokens[j]?.kind === 'word' && !RELATION_END.has(upper(tokens[j]))) j++
      if (word === 'FROM' && isPunct(tokens[j], ',')) {
        j++
        continue
      }
      break
    }
  }
  return found
}

/** True when `sql` may run through the PostgreSQL metadata reader. */
export function isPgMetadataSql(sql: string): boolean {
  if (/^\s*SELECT\s+version\(\)(\s+AS\s+version)?\s*$/i.test(sql)) return true
  const statements = splitStatements(sql)
  if (statements.length !== 1) return false
  let tokens: PgToken[]
  try {
    tokens = codeTokens(tokenizePg(sql))
  } catch {
    return false
  }
  if (upper(tokens[0]) !== 'SELECT') return false
  if (tokens.some((t) => t.kind === 'meta' || isPunct(t, ';'))) return false
  if (tokens.some((t) => upper(t) === 'INTO')) return false
  if (analyzeWrites(sql).writes) return false
  return relationsAreCatalog(tokens)
}

/** Wraps a PostgreSQL session so only catalog reads reach the server. */
export class PgMetadataQueryable implements Queryable {
  constructor(private readonly inner: Queryable & { readonly serverVersionNum?: number }) {}
  /** The session's server_version_num, for the catalog features (catalogCompat.ts). */
  get serverVersionNum(): number | undefined {
    return this.inner.serverVersionNum
  }
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    if (!isPgMetadataSql(sql)) throw new MetadataOnlyError()
    return this.inner.query<T>(sql, params)
  }
}

type Row = Record<string, unknown>
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
/**
 * A JSON array column: the PostgreSQL driver keeps json as the server's text
 * (values.ts), so it arrives as '["a","b"]'; an already parsed array is
 * accepted too.
 */
const list = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => String(x))
  if (typeof v === 'string' && v.trimStart().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(v)
      if (Array.isArray(parsed)) return parsed.map((x) => String(x))
    } catch {
      /* not JSON: no columns */
    }
  }
  return []
}

/** Structure of one PostgreSQL schema (all tables, or only `only`). */
export async function readPgSchemaSnapshot(
  q: PgMetadataQueryable,
  schema: string,
  only?: string[]
): Promise<SchemaSnapshot> {
  const filter = only && only.length ? only : null
  const params = [schema, filter]
  const f = featuresOf(q)
  const kind = prokindSql(f)
  const tables = await q.query<Row>(
    `SELECT c.oid::int8 AS oid, c.relname AS name, c.relkind::text AS relkind,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::int8 END AS rows,
            COALESCE(pg_catalog.obj_description(c.oid, 'pg_class'), '') AS comment
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT ${relispartitionSql(f)}
        AND ($2::text[] IS NULL OR c.relname = ANY($2::text[]))
      ORDER BY c.relname`,
    params
  )
  const columns = await q.query<Row>(
    `SELECT c.relname AS table, a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
            NOT a.attnotnull AS nullable, ${attidentitySql(f)} AS identity, ${attgeneratedSql(f)} AS generated,
            COALESCE(pg_catalog.col_description(a.attrelid, a.attnum), '') AS comment,
            EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary
                       AND a.attnum = ANY(i.indkey)) AS pk
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
        AND ($2::text[] IS NULL OR c.relname = ANY($2::text[]))
      ORDER BY c.relname, a.attnum`,
    params
  )
  const indexes = await q.query<Row>(
    `SELECT tc.relname AS table, ic.relname AS name, i.indisunique AS unique,
            (SELECT pg_catalog.array_to_json(pg_catalog.array_agg(pg_catalog.pg_get_indexdef(i.indexrelid, k.ord::int, true) ORDER BY k.ord))
               FROM pg_catalog.generate_series(1, ${indexKeyCountSql(f)}) AS k(ord)) AS columns
       FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace
      WHERE n.nspname = $1 AND ($2::text[] IS NULL OR tc.relname = ANY($2::text[]))
      ORDER BY tc.relname, ic.relname`,
    params
  )
  const foreignKeys = await q.query<Row>(
    `SELECT tc.relname AS table, con.conname AS name,
            (SELECT pg_catalog.array_to_json(pg_catalog.array_agg(a.attname ORDER BY k.ord))
               FROM pg_catalog.generate_series(1, pg_catalog.array_length(con.conkey, 1)) AS k(ord)
               JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[k.ord]) AS columns,
            fn.nspname AS ref_schema, fc.relname AS ref_table,
            (SELECT pg_catalog.array_to_json(pg_catalog.array_agg(a.attname ORDER BY k.ord))
               FROM pg_catalog.generate_series(1, pg_catalog.array_length(con.confkey, 1)) AS k(ord)
               JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = con.confkey[k.ord]) AS ref_columns
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class tc ON tc.oid = con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace
       JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid
       JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE con.contype = 'f' AND n.nspname = $1 AND ($2::text[] IS NULL OR tc.relname = ANY($2::text[]))
      ORDER BY tc.relname, con.conname`,
    params
  )
  const routines = filter
    ? []
    : await q.query<Row>(
        `SELECT p.proname AS name, ${kind} AS kind,
                pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
                CASE WHEN ${kind} = 'p' THEN NULL ELSE pg_catalog.pg_get_function_result(p.oid) END AS returns
           FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND ${kind} IN ('f', 'p')
          ORDER BY p.proname`,
        [schema]
      )
  const [version] = await q.query<Row>('SELECT version() AS version')

  const byName = new Map<string, TableMeta>()
  for (const t of tables) {
    const view = ['v', 'm'].includes(str(t.relkind))
    byName.set(str(t.name), {
      name: str(t.name),
      kind: view ? 'view' : 'table',
      rows: view || t.rows === null || t.rows === undefined ? null : Number(t.rows),
      comment: str(t.comment),
      columns: [],
      indexes: [],
      foreignKeys: []
    })
  }
  for (const c of columns) {
    const identity = str(c.identity)
    byName.get(str(c.table))?.columns.push({
      name: str(c.name),
      type: str(c.type),
      nullable: c.nullable === true,
      key: c.pk === true ? 'PRI' : '',
      extra: identity
        ? `identity ${identity === 'a' ? 'always' : 'by default'}`
        : str(c.generated) === 's'
          ? 'generated stored'
          : '',
      comment: str(c.comment)
    })
  }
  for (const i of indexes)
    byName.get(str(i.table))?.indexes.push({
      name: str(i.name),
      unique: i.unique === true,
      columns: list(i.columns)
    })
  for (const f of foreignKeys)
    byName.get(str(f.table))?.foreignKeys.push({
      name: str(f.name),
      columns: list(f.columns),
      refSchema: str(f.ref_schema),
      refTable: str(f.ref_table),
      refColumns: list(f.ref_columns)
    })
  const routineMeta: RoutineMeta[] = routines.map((r) => ({
    name: str(r.name),
    type: str(r.kind) === 'p' ? 'PROCEDURE' : 'FUNCTION',
    params: str(r.args)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
    returns: r.returns === null || r.returns === undefined ? null : str(r.returns)
  }))
  return {
    schema,
    serverVersion: str(version?.version),
    tables: [...byName.values()],
    routines: routineMeta
  }
}

/** Schema names of the current database (no system schemas), for the "no schema" context. */
export async function readPgSchemaNames(q: PgMetadataQueryable): Promise<string[]> {
  const rows = await q.query<Row>(
    `SELECT n.nspname AS name FROM pg_catalog.pg_namespace n
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY n.nspname`
  )
  return rows.map((r) => str(r.name))
}

/** One read-only SELECT (EXPLAIN may run on it, never EXPLAIN ANALYZE). */
export function isSinglePgSelect(sql: string | null | undefined): boolean {
  if (!sql?.trim()) return false
  const statements = splitStatements(sql)
  if (statements.length !== 1) return false
  const first = codeTokens(tokenizePg(statements[0].sql))[0]
  return upper(first) === 'SELECT' && !analyzeWrites(statements[0].sql).writes
}

/** EXPLAIN (plan only) of a single read-only SELECT; null otherwise or on failure. */
export async function explainPgSelect(q: Queryable, sql: string): Promise<string | null> {
  if (!isSinglePgSelect(sql)) return null
  const statement = splitStatements(sql)[0].sql
  try {
    const rows = await q.query<Record<string, unknown>>(`EXPLAIN ${statement}`)
    const lines = rows.map((r) => String(r['QUERY PLAN'] ?? ''))
    return (
      lines.slice(0, 80).join('\n') +
      (lines.length > 80 ? `\n… ${lines.length - 80} líneas más` : '')
    )
  } catch {
    return null
  }
}
