import type { CellValue, QueryColumn, TableStructure } from '@shared/types'
// Relative (not @renderer): the node typecheck and integration tests compile this file too.
import { isAutoIncrementColumn, isViewLike } from '../../utils/columnMeta'
import {
  REASON_MULTI,
  singleTableSelect,
  type JoinedSelect,
  type SelectItem,
  type TableRef
} from './selectSource'
import { pgSingleTableSelect } from './selectSourcePg'
import { sqliteSingleTableSelect } from './selectSourceSqlite'

/**
 * Decides whether a query result set can be edited in place, and which of its
 * columns: a SELECT that reads base tables directly (one, or several joined)
 * is edited in one of them when the result returns that table's whole primary
 * key. Pure functions: the component fetches the table structure.
 *
 * Two stages: `resultSource` reads the statement text (see selectSource.ts)
 * and names the candidate tables; then `decideEditability` checks a table's
 * type and primary key and ties each result column to it or not. Columns of
 * other tables and computed ones stay locked while the rest of the row is
 * edited. Result metadata (mysql2 field packets mapped in main/mysql/values.ts)
 * is cross-checked against the statement: for merged derived tables, CTEs and
 * views MySQL reports inner table/column names, so it is not enough alone.
 */

export interface ResultSource {
  schema: string
  table: string
  /** Name the statement uses for the table: its alias, or the table name. */
  alias: string
  /**
   * Joined SELECT: its select list, and the qualifiers that name this table
   * in it (the alias; without one, `table` and `schema.table`).
   */
  joined?: { items: SelectItem[]; qualifiers: string[][] }
}

export type SourceCheck =
  | {
      ok: true
      /** The first candidate. */
      source: ResultSource
      /** Tables the rows may be edited in, most likely first (joins: several). */
      candidates: ResultSource[]
    }
  | { ok: false; reason: string }

export type Editability =
  | {
      editable: true
      schema: string
      table: string
      /** Primary key as source column names, in index order (RowChange keys). */
      primaryKey: string[]
      /** Result column names (aliases) that hold the primary key, for the grid key icon. */
      keyColumns: string[]
      /**
       * Result column that receives the generated id of an insert: the single
       * primary key column when it is the table's AUTO_INCREMENT column, else null.
       */
      generatedKeyColumn: string | null
      /**
       * Per result column: why it is not edited (a column of another table, a
       * computed one), or null for the columns of `table`.
       */
      locked: (string | null)[]
    }
  | { editable: false; reason: string; schema?: string; table?: string }

export const REASON_COMPUTED = 'columnas calculadas'
export const REASON_MISMATCH = 'el resultado no coincide con la tabla de la consulta'
export const REASON_DUPLICATE_KEYS = 'hay filas repetidas con la misma clave'
export const REASON_NULL_KEY = 'hay filas sin clave (el JOIN no encontró su fila)'
export const LOCK_COMPUTED = 'columna calculada'

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

/** MySQL column names (and, on macOS, table names) are case-insensitive. */
const norm = (name: string): string => name.toLowerCase()
const same = (a: string | undefined, b: string): boolean => a !== undefined && norm(a) === norm(b)

/** Does `qualifier` (`t`, `schema.t`) name a table spelled one of the `forms`? */
const names = (forms: string[][], qualifier: string[] | null): boolean =>
  !!qualifier &&
  forms.some((f) => f.length === qualifier.length && f.every((p, i) => same(qualifier[i], p)))

/** Qualifiers that name a table reference: its alias, or its name with or without schema. */
function qualifiersOf(ref: TableRef, schema: string | null): string[][] {
  if (ref.alias) return [[ref.alias]]
  return schema ? [[ref.table], [schema, ref.table]] : [[ref.table]]
}

/** Read-only reason of a joined SELECT whose columns cannot be tied to a table. */
const qualifyHint = (ref: TableRef): string => {
  const q = ref.alias ?? ref.table
  return `${REASON_MULTI}: escribe ${q}.* o ${q}.columna para editar`
}

/**
 * Joined SELECT: the tables whose columns appear in the result, by how many
 * (with alias metadata, MySQL: the columns the driver ties to each alias;
 * without it: `t.*` first, then the `t.col` items), then in FROM order.
 */
function joinedCandidates(
  columns: QueryColumn[],
  joined: JoinedSelect,
  aliasMetadata: boolean
): SourceCheck {
  const keyOf = (t: TableRef): string => norm(t.alias ?? t.table)
  const keys = joined.tables.map(keyOf)
  const scored: { source: ResultSource; score: number; order: number }[] = []
  joined.tables.forEach((ref, order) => {
    // FROM t JOIN t (no aliases): the server refuses it, and nothing could tell them apart.
    if (keys.indexOf(keyOf(ref)) !== keys.lastIndexOf(keyOf(ref))) return
    const alias = ref.alias ?? ref.table
    const tied = columns.filter(
      (c) =>
        same(c.table, ref.table) &&
        (aliasMetadata ? same(c.tableAlias, alias) : true) &&
        (!ref.schema || same(c.schema, ref.schema))
    )
    const schema = ref.schema ?? tied.find((c) => c.schema)?.schema
    if (!schema) return
    const qualifiers = qualifiersOf(ref, schema)
    const score = aliasMetadata
      ? tied.filter((c) => c.sourceName).length
      : joined.items.reduce(
          (n, item) =>
            item.kind === 'star' && names(qualifiers, item.qualifier)
              ? n + 1_000_000
              : item.kind === 'column' && names(qualifiers, item.qualifier)
                ? n + 1
                : n,
          0
        )
    if (score > 0)
      scored.push({
        source: { schema, table: ref.table, alias, joined: { items: joined.items, qualifiers } },
        score,
        order
      })
  })
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  const candidates = scored.map((s) => s.source)
  if (candidates.length) return { ok: true, source: candidates[0], candidates }
  return fail(
    joined.items.every((i) => i.kind === 'expression')
      ? REASON_COMPUTED
      : qualifyHint(joined.tables[0])
  )
}

/**
 * Statement stage, no server round trip: which table can the rows be edited
 * in? The schema falls back to the one the result reports.
 */
export function resultSource(
  columns: QueryColumn[],
  sql: string,
  /**
   * 'postgresql' and 'sqlite' parse with their dialect's lexer; anything else
   * keeps the MySQL parser.
   */
  dialect: 'mysql' | 'postgresql' | 'sqlite' = 'mysql'
): SourceCheck {
  if (!columns.length) return fail('el resultado no tiene columnas')
  const parsed =
    dialect === 'postgresql'
      ? pgSingleTableSelect(sql)
      : dialect === 'sqlite'
        ? sqliteSingleTableSelect(sql)
        : singleTableSelect(sql)
  if (!parsed.ok) return fail(parsed.reason)
  if (parsed.joined) return joinedCandidates(columns, parsed.joined, dialect === 'mysql')
  const { ref } = parsed
  const schema = ref.schema ?? columns.find((c) => c.schema)?.schema
  // SELECT 1 FROM t: nothing in the result names a schema.
  if (!schema) return fail(REASON_COMPUTED)
  const source = { schema, table: ref.table, alias: ref.alias ?? ref.table }
  return { ok: true, source, candidates: [source] }
}

/**
 * Primary key columns of a table, in index order (empty when it has none).
 * IndexInfo.primary when the driver sets it; otherwise MySQL's index name.
 */
export function primaryKeyOf(structure: Pick<TableStructure, 'indexes'>): string[] {
  return structure.indexes.find((i) => i.primary ?? i.name === 'PRIMARY')?.columns ?? []
}

/** Index of the first row whose key repeats an earlier one, or -1. */
export function duplicateKeyRow(rows: CellValue[][], keyIndexes: number[]): number {
  const seen = new Set<string>()
  for (let r = 0; r < rows.length; r++) {
    const key = JSON.stringify(keyIndexes.map((k) => rows[r][k] ?? null))
    if (seen.has(key)) return r
    seen.add(key)
  }
  return -1
}

/** A joined SELECT names several tables: at most this many structures are read. */
export const MAX_CANDIDATES = 3

/**
 * The first candidate whose rows can be edited, else the first candidate's
 * result (its reason is the one shown). `decide` reads one table's structure.
 */
export async function firstEditable<T extends { decision: Editability }>(
  candidates: ResultSource[],
  decide: (candidate: ResultSource) => Promise<T>
): Promise<T | null> {
  let first: T | null = null
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    const result = await decide(candidate)
    if (result.decision.editable) return result
    first ??= result
  }
  return first
}

/** Where a result column comes from in a joined select list (see selectPositions). */
type Position = { own: string } | { item: SelectItem }

/**
 * Ties result columns to select list items by position, for drivers without
 * alias metadata (PostgreSQL, SQLite). `t.*` of the source table is as wide
 * as its structure; other stars (`*`, `other.*`) have an unknown width, so
 * columns are counted from both ends and those between two unknown stars stay
 * unplaced. Null when the counts cannot match the result.
 */
function selectPositions(
  items: SelectItem[],
  count: number,
  mine: (qualifier: string[] | null) => boolean,
  starColumns: string[] | undefined
): (Position | undefined)[] | null {
  const width = (item: SelectItem): number | null =>
    item.kind !== 'star' ? 1 : mine(item.qualifier) && starColumns ? starColumns.length : null
  const out: (Position | undefined)[] = Array.from({ length: count }, () => undefined)
  const place = (item: SelectItem, at: number): void => {
    if (item.kind === 'star') starColumns!.forEach((name, k) => (out[at + k] = { own: name }))
    else if (item.kind === 'column' && mine(item.qualifier)) out[at] = { own: item.name }
    else out[at] = { item }
  }
  let front = 0
  let i = 0
  for (; i < items.length; i++) {
    const w = width(items[i])
    if (w === null) break
    if (front + w > count) return null
    place(items[i], front)
    front += w
  }
  if (i === items.length) return front === count ? out : null
  let back = count
  for (let j = items.length - 1; j > i; j--) {
    const w = width(items[j])
    if (w === null) break
    if (back - w < front) return null
    back -= w
    place(items[j], back)
  }
  return out
}

/**
 * Which result columns belong to the source table; the others get the reason
 * they are locked. Null when the result contradicts the statement.
 *
 * Single-table SELECT: every column the driver ties to a table must be the
 * source table's; columns without a source (expressions) are computed. Joined
 * SELECT with alias metadata (MySQL): a column is the table's when its alias,
 * table and schema match. Without alias metadata (PostgreSQL, SQLite: a column
 * only names its table, so a self-join or a view over the same table would
 * look alike) by its place in the select list, and the driver must agree.
 */
function ownership(
  columns: QueryColumn[],
  source: ResultSource,
  starColumns: string[] | undefined,
  aliasMetadata: boolean
): (string | null)[] | null {
  const computed = (c: QueryColumn): boolean => !c.table || !c.schema || !c.sourceName
  const mine = (c: QueryColumn): boolean =>
    same(c.schema, source.schema) &&
    same(c.table, source.table) &&
    (!aliasMetadata || same(c.tableAlias, source.alias))
  const locked: (string | null)[] = []
  if (!source.joined) {
    for (const c of columns) {
      if (computed(c)) locked.push(LOCK_COMPUTED)
      else if (mine(c)) locked.push(null)
      else return null
    }
    return locked
  }
  if (aliasMetadata) {
    for (const c of columns)
      locked.push(
        computed(c)
          ? LOCK_COMPUTED
          : mine(c)
            ? null
            : `columna de otra tabla (${c.tableAlias ?? c.table})`
      )
    return locked
  }
  const { items, qualifiers } = source.joined
  const positions = selectPositions(items, columns.length, (q) => names(qualifiers, q), starColumns)
  if (!positions) return null
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i]
    const at = positions[i]
    if (at && 'own' in at) {
      if (computed(c) || !mine(c) || !same(c.sourceName, at.own)) return null
      locked.push(null)
    } else if (computed(c)) locked.push(LOCK_COMPUTED)
    else if (!same(c.table, source.table) || !same(c.schema, source.schema))
      locked.push(`columna de otra tabla (${c.table})`)
    else if (at?.item.kind === 'column' && at.item.qualifier)
      locked.push(`columna de otra tabla (${at.item.qualifier.join('.')})`)
    else locked.push(`escribe ${source.alias}.${c.sourceName} para editarla`)
  }
  return locked
}

/**
 * Final decision. `structure` is the structure of the candidate table
 * (db:tableStructure), or null when it could not be read. `rows` are the
 * loaded rows, checked for missing and repeated keys.
 */
export function decideEditability(
  columns: QueryColumn[],
  source: ResultSource,
  structure:
    | (Pick<TableStructure, 'indexes' | 'tableType'> &
        Partial<Pick<TableStructure, 'columns' | 'kind' | 'options'>>)
    | null,
  rows: CellValue[][] = [],
  /**
   * The driver reports the table alias of each column (MySQL). Without it
   * (PostgreSQL: RowDescription has no alias) columns of a joined SELECT are
   * tied to the table by their place in the select list.
   */
  options: {
    aliasMetadata?: boolean
    /**
     * SQLite: the key is what the driver marked `primaryKey` in the result (the
     * rowid, or the key of a WITHOUT ROWID table), not the declared primary key.
     */
    keyFromColumns?: boolean
  } = {}
): Editability {
  const where = { schema: source.schema, table: source.table }
  if (!structure) return { editable: false, reason: 'no se pudo comprobar la tabla', ...where }
  if (isViewLike(structure)) return { editable: false, reason: 'el origen es una vista', ...where }

  const locked = ownership(
    columns,
    source,
    structure.columns?.map((c) => c.name),
    options.aliasMetadata !== false
  )
  if (!locked) return { editable: false, reason: REASON_MISMATCH, ...where }
  const own = (i: number): boolean => locked[i] === null
  const owned = columns.filter((_, i) => own(i))
  if (!owned.length)
    return {
      editable: false,
      reason: source.joined ? `ninguna columna es de ${source.alias}` : REASON_COMPUTED,
      ...where
    }
  const readOnly = owned.find((c) => c.readOnlyReason)?.readOnlyReason
  if (readOnly)
    return {
      editable: false,
      reason: readOnly === 'vista' ? 'el origen es una vista' : readOnly,
      ...where
    }

  const seen = new Set<string>()
  for (const c of owned) {
    const key = norm(c.sourceName!)
    if (seen.has(key))
      return { editable: false, reason: 'la misma columna aparece varias veces', ...where }
    seen.add(key)
  }

  // SQLite: the rowid, or the whole key of a WITHOUT ROWID table (its declared key).
  const marked = owned.filter((c) => c.primaryKey).map((c) => c.sourceName!)
  const withoutRowid = structure.options?.withoutRowid === true
  const pk = options.keyFromColumns
    ? withoutRowid
      ? primaryKeyOf(structure)
      : marked
    : primaryKeyOf(structure)
  if (!pk.length) return { editable: false, reason: 'la tabla no tiene clave primaria', ...where }

  const keyIndexes = pk.map((k) => columns.findIndex((c, i) => own(i) && same(c.sourceName, k)))
  if (keyIndexes.some((i) => i < 0))
    return { editable: false, reason: 'falta la clave primaria completa en el resultado', ...where }
  // An outer join without a matching row: nothing to write to.
  if (rows.some((r) => keyIndexes.some((k) => (r[k] ?? null) === null)))
    return { editable: false, reason: REASON_NULL_KEY, ...where }
  // A join that repeats a row (or a table without its whole key): refuse rather than write twice.
  if (duplicateKeyRow(rows, keyIndexes) >= 0)
    return { editable: false, reason: REASON_DUPLICATE_KEYS, ...where }

  const keyCols = keyIndexes.map((i) => columns[i])
  const autoIncrement =
    pk.length === 1 &&
    !!structure.columns?.some((c) => same(c.name, pk[0]) && isAutoIncrementColumn(c))
  return {
    editable: true,
    // Spelled as the result reports them so they match the payload columns below.
    schema: keyCols[0].schema!,
    table: keyCols[0].table!,
    primaryKey: keyCols.map((c) => c.sourceName!),
    keyColumns: keyCols.map((c) => c.name),
    generatedKeyColumn: autoIncrement ? keyCols[0].name : null,
    locked
  }
}

/**
 * Result columns renamed to their real table columns: what RowChange payloads
 * must use. A locked column (another table's, computed) gets a name no real
 * column can have, so a key or value lookup by name never picks it.
 */
export function payloadColumns(
  columns: QueryColumn[],
  locked: readonly (string | null)[] = []
): QueryColumn[] {
  return columns.map((c, i) => ({
    ...c,
    name: locked[i] ? `\u0000${i}` : (c.sourceName ?? c.name)
  }))
}
