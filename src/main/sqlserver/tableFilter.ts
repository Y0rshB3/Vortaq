/**
 * Visual filter builder -> WHERE clause for SQL Server (same filter model,
 * limits and messages as src/main/postgres/tableFilter.ts).
 *
 * Identifiers are checked against the table's real columns and bracketed when
 * needed; every value is a string literal ('' doubling, never backslash
 * escapes). Nothing from the renderer is concatenated into SQL except
 * `custom` rows, which are the user's own SQL fragment like the raw WHERE box.
 *
 * Dialect choices:
 * - comparisons use a string literal that SQL Server converts to the column's
 *   type; char/varchar/text columns get '…' (an N'…' literal would convert the
 *   column and lose index seeks), every other column N'…';
 * - datetime/smalldatetime read 'yyyy-mm-dd' by the session's language, so
 *   their values are written in the ISO forms every language reads
 *   (yyyymmdd, yyyy-mm-ddThh:mm:ss);
 * - bit columns take 1/0 (sí/no/true/false… accepted);
 * - xml, text, ntext and image cannot be compared: they compare as nvarchar(max);
 * - "contiene", "empieza por"… are case-insensitive whatever the collation:
 *   LOWER(CAST(col AS nvarchar(max))) LIKE LOWER(N'%v%') ESCAPE N'\', with
 *   `\`, `%`, `_` and `[` escaped;
 * - "está vacío" is `(CAST(col AS nvarchar(max)) = N'' OR col IS NULL)`.
 */
import type {
  TableFilter,
  TableFilterCondition,
  TableFilterGroup,
  TableFilterJoin,
  TableFilterNode,
  TableFilterOperator,
  TypeKind
} from '@shared/types'
import { quoteAnsiString, quoteIdent, quoteString } from '@shared/dialects/sqlserver'
import { DbUserError } from '../db/errors'

export const MAX_FILTER_CONDITIONS = 200
export const MAX_IN_VALUES = 1000
export const MAX_FILTER_DEPTH = 8

/** What the builder needs to know about a column. */
export interface MsFilterColumn {
  name: string
  typeKind?: TypeKind
  /** Declared base type, e.g. 'nvarchar', 'varchar', 'datetime', 'bit', 'xml'. */
  dataType?: string
}

const ERROR_CODE = 'E_MS_FILTER'
function fail(message: string): never {
  throw new DbUserError(message, ERROR_CODE)
}

const COMPARISON: Partial<Record<TableFilterOperator, string>> = {
  eq: '=',
  ne: '<>',
  lt: '<',
  le: '<=',
  gt: '>',
  ge: '>='
}

const LIKE: Partial<Record<TableFilterOperator, { not: boolean; pattern: (v: string) => string }>> =
  {
    contains: { not: false, pattern: (v) => `%${v}%` },
    notContains: { not: true, pattern: (v) => `%${v}%` },
    beginsWith: { not: false, pattern: (v) => `${v}%` },
    notBeginsWith: { not: true, pattern: (v) => `${v}%` },
    endsWith: { not: false, pattern: (v) => `%${v}` },
    notEndsWith: { not: true, pattern: (v) => `%${v}` }
  }

const OPERATORS: ReadonlySet<string> = new Set<TableFilterOperator>([
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'contains',
  'notContains',
  'beginsWith',
  'notBeginsWith',
  'endsWith',
  'notEndsWith',
  'isNull',
  'isNotNull',
  'isEmpty',
  'isNotEmpty',
  'in',
  'notIn',
  'between',
  'notBetween',
  'custom'
])

/** Escapes LIKE wildcards so the value matches literally (`\`, `%`, `_` and `[`). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_[]/g, (c) => `\\${c}`)
}

/** Only plain strings and finite numbers are values (no NUL characters). */
function scalar(value: unknown, what: string): string {
  let text: string | null = null
  if (typeof value === 'string') text = value
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value)
  if (text === null) return fail(`Falta ${what}`)
  if (text.includes('\0'))
    return fail(`${what[0].toUpperCase()}${what.slice(1)} contiene un carácter nulo`)
  return text
}

/**
 * Resolves `column` to a real column: the exact name first, then a unique
 * case-insensitive match (names follow the database collation).
 * Unknown names never reach the SQL.
 */
export function resolveColumn(column: unknown, columns: readonly MsFilterColumn[]): MsFilterColumn {
  if (typeof column !== 'string' || !column)
    return fail('Elige una columna en cada condición del filtro')
  const exact = columns.find((c) => c.name === column)
  if (exact) return exact
  const lower = column.toLowerCase()
  const matches = columns.filter((c) => c.name.toLowerCase() === lower)
  if (matches.length === 1) return matches[0]
  return fail(`La columna «${column}» no existe en la tabla`)
}

type ValueKind = 'boolean' | 'ansi' | 'unicode' | 'castText' | 'legacyDate' | 'plain'

function valueKind(c: MsFilterColumn): ValueKind {
  const type = (c.dataType ?? '').toLowerCase().trim()
  if (type === 'bit' || c.typeKind === 'boolean') return 'boolean'
  if (type === 'char' || type === 'varchar') return 'ansi'
  if (type === 'nchar' || type === 'nvarchar' || type === 'sysname') return 'unicode'
  if (type === 'xml' || type === 'text' || type === 'ntext' || type === 'image') return 'castText'
  if (type === 'datetime' || type === 'smalldatetime') return 'legacyDate'
  return 'plain'
}

const TRUE_WORDS = new Set(['true', 't', '1', 'yes', 'y', 'on', 'si', 'sí', 'verdadero'])
const FALSE_WORDS = new Set(['false', 'f', '0', 'no', 'n', 'off', 'falso'])

function booleanLiteral(value: string, column: string): string {
  const v = value.trim().toLowerCase()
  if (TRUE_WORDS.has(v)) return '1'
  if (FALSE_WORDS.has(v)) return '0'
  return fail(`El valor «${value}» de la columna «${column}» no es un booleano (usa 1 o 0)`)
}

/**
 * datetime/smalldatetime literal every session language reads the same:
 * 2026-01-02 → 20260102, 2026-01-02 03:04[:05[.123]] → 2026-01-02T03:04[:05[.123]].
 */
export function isoLegacyDate(value: string): string {
  const v = value.trim()
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (dateOnly) return `${dateOnly[1]}${dateOnly[2]}${dateOnly[3]}`
  const full = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?)$/.exec(v)
  if (full) {
    const time = full[2].length === 5 ? `${full[2]}:00` : full[2]
    // datetime accepts 3 fractional digits.
    return `${full[1]}T${time.replace(/(\.\d{3})\d+$/, '$1')}`
  }
  return v
}

/** Column expression and literal renderer for comparisons on this column. */
function comparable(c: MsFilterColumn): { expr: string; literal: (v: string) => string } {
  const id = quoteIdent(c.name)
  switch (valueKind(c)) {
    case 'boolean':
      return { expr: id, literal: (v) => booleanLiteral(v, c.name) }
    case 'ansi':
      return { expr: id, literal: quoteAnsiString }
    case 'castText':
      return { expr: `CAST(${id} AS nvarchar(max))`, literal: quoteString }
    case 'legacyDate':
      return { expr: id, literal: (v) => quoteAnsiString(isoLegacyDate(v)) }
    case 'unicode':
    default:
      return { expr: id, literal: quoteString }
  }
}

/** Renders one enabled, non-custom condition to SQL (without outer parentheses). */
export function compileCondition(
  cond: TableFilterCondition,
  columns: readonly MsFilterColumn[]
): string {
  if (!OPERATORS.has(cond.operator) || cond.operator === 'custom')
    return fail(`Operador de filtro no válido: ${String(cond.operator)}`)
  const column = resolveColumn(cond.column, columns)
  const id = quoteIdent(column.name)
  const op = cond.operator
  const values: unknown[] = Array.isArray(cond.values) ? cond.values : []
  const label = `el valor de la condición sobre «${cond.column}»`
  const { expr, literal } = comparable(column)

  const cmp = COMPARISON[op]
  if (cmp) return `${expr} ${cmp} ${literal(scalar(values[0], label))}`

  const like = LIKE[op]
  if (like) {
    const pattern = like.pattern(escapeLike(scalar(values[0], label)))
    return `LOWER(CAST(${id} AS nvarchar(max))) ${like.not ? 'NOT LIKE' : 'LIKE'} LOWER(${quoteString(pattern)}) ESCAPE N'\\'`
  }

  switch (op) {
    case 'isNull':
      return `${id} IS NULL`
    case 'isNotNull':
      return `${id} IS NOT NULL`
    case 'isEmpty':
      return `(CAST(${id} AS nvarchar(max)) = N'' OR ${id} IS NULL)`
    case 'isNotEmpty':
      return `(CAST(${id} AS nvarchar(max)) <> N'' AND ${id} IS NOT NULL)`
    case 'in':
    case 'notIn': {
      if (!values.length) return fail(`Falta la lista de valores sobre «${cond.column}»`)
      if (values.length > MAX_IN_VALUES)
        return fail(`La lista admite como máximo ${MAX_IN_VALUES} valores`)
      const list = values.map((v) => literal(scalar(v, label))).join(', ')
      return `${expr} ${op === 'in' ? 'IN' : 'NOT IN'} (${list})`
    }
    case 'between':
    case 'notBetween': {
      const from = literal(scalar(values[0], `el valor inicial de «${cond.column}»`))
      const to = literal(scalar(values[1], `el valor final de «${cond.column}»`))
      return `${expr} ${op === 'between' ? 'BETWEEN' : 'NOT BETWEEN'} ${from} AND ${to}`
    }
  }
  /* c8 ignore next */
  return fail(`Operador de filtro no válido: ${String(op)}`)
}

function renderCondition(
  cond: TableFilterCondition,
  columns: readonly MsFilterColumn[]
): string | null {
  if (cond.operator === 'custom') {
    const raw = typeof cond.sql === 'string' ? cond.sql.trim() : ''
    // Own lines: a trailing "-- note" in the fragment cannot comment out what follows.
    return raw ? `(\n${raw}\n)` : null
  }
  return `(${compileCondition(cond, columns)})`
}

function checkJoin(op: unknown): TableFilterJoin {
  if (op === 'AND' || op === 'OR') return op
  return fail('Las condiciones del filtro se combinan con AND u OR')
}

function isNode(value: unknown): value is TableFilterNode {
  return typeof value === 'object' && value !== null && 'kind' in value
}

/** True when the filter has at least one enabled condition that needs the column list. */
export function msFilterNeedsColumns(filter: TableFilterNode | null | undefined): boolean {
  if (!isNode(filter) || !filter.enabled) return false
  if (filter.kind === 'condition') return filter.operator !== 'custom'
  return Array.isArray(filter.children) && filter.children.some((c) => msFilterNeedsColumns(c))
}

interface Walk {
  columns: readonly MsFilterColumn[]
  count: number
}

function renderGroup(group: TableFilterGroup, walk: Walk, depth: number): string | null {
  if (depth > MAX_FILTER_DEPTH)
    fail(`El filtro admite como máximo ${MAX_FILTER_DEPTH} niveles de paréntesis`)
  if (!Array.isArray(group.children)) fail('Filtro no válido')
  let sql = ''
  let pending: TableFilterJoin | null = null
  for (const child of group.children) {
    if (!isNode(child)) fail('Filtro no válido')
    if (!child.enabled) continue
    let part: string | null
    if (child.kind === 'group') {
      const inner = renderGroup(child, walk, depth + 1)
      part = inner === null ? null : `(${inner})`
    } else {
      if (++walk.count > MAX_FILTER_CONDITIONS)
        fail(`El filtro admite como máximo ${MAX_FILTER_CONDITIONS} condiciones`)
      part = renderCondition(child, walk.columns)
    }
    const connector = checkJoin(child.connector ?? 'AND')
    if (part === null) continue
    sql = pending === null ? part : `${sql} ${pending} ${part}`
    pending = connector
  }
  return sql || null
}

/**
 * Builds the WHERE body (without the keyword) for `filter`, or '' when it has
 * no enabled condition. `columns` are the table's real columns.
 */
export function buildMsFilterWhere(
  filter: TableFilter | null | undefined,
  columns: readonly MsFilterColumn[]
): string {
  if (filter === null || filter === undefined) return ''
  if (!isNode(filter) || filter.kind !== 'group') fail('Filtro no válido')
  if (!filter.enabled) return ''
  return renderGroup(filter, { columns, count: 0 }, 0) ?? ''
}
