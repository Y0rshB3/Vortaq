import type { SqlDialect } from '@shared/dialects/types'

/**
 * SQL of the visual query builder («Consulta gráfica»): one SELECT built from
 * the tables on the canvas, their joins and the column grid, with every
 * identifier quoted by the connection's dialect and every typed value written
 * as a quoted literal (numbers only for numeric columns). The builder never
 * runs it: the SQL goes to a query tab, where running goes through its guards.
 */
export type JoinType = 'INNER' | 'LEFT'
export type BuilderAggregate = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'
export type BuilderOperator =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'contains'
  | 'beginsWith'
  | 'endsWith'
  | 'isNull'
  | 'isNotNull'
  | 'in'

export interface BuilderTable {
  name: string
  /** Short alias, unique in the query ([a-z][a-z0-9_]*). */
  alias: string
}

export interface BuilderJoin {
  id: string
  type: JoinType
  /** Aliases of the two tables and the column pairs compared with `=`. */
  a: string
  b: string
  on: { a: string; b: string }[]
}

export interface BuilderColumn {
  id: string
  /** Alias of its table. */
  table: string
  column: string
  /** Part of the SELECT list (a column used only to filter or sort may be hidden). */
  output: boolean
  as: string
  aggregate: BuilderAggregate | null
  sort: 'ASC' | 'DESC' | null
  operator: BuilderOperator | null
  value: string
  /** Numeric column: a value that is a number is written without quotes. */
  numeric: boolean
}

export interface BuilderSpec {
  /** Schema/database to qualify table names with (null: the tab's current one). */
  qualifier: string | null
  tables: BuilderTable[]
  joins: BuilderJoin[]
  columns: BuilderColumn[]
  distinct: boolean
  limit: number | null
}

export interface BuiltQuery {
  sql: string
  warnings: string[]
}

export const OPERATOR_LABELS: Record<BuilderOperator, string> = {
  eq: '=',
  ne: '≠',
  lt: '<',
  le: '≤',
  gt: '>',
  ge: '≥',
  contains: 'contiene',
  beginsWith: 'empieza por',
  endsWith: 'termina en',
  isNull: 'es nulo',
  isNotNull: 'no es nulo',
  in: 'en la lista'
}

/** Operators that take no value. */
export const NO_VALUE: ReadonlySet<BuilderOperator> = new Set(['isNull', 'isNotNull'])

const RESERVED = new Set([
  'as',
  'at',
  'by',
  'do',
  'if',
  'in',
  'is',
  'of',
  'on',
  'or',
  'to',
  'all',
  'and',
  'any',
  'asc',
  'end',
  'for',
  'not',
  'set',
  'top',
  'use',
  'key'
])

/** A short alias for a table: the initials of its words (`order_items` → `oi`), made unique. */
export function tableAlias(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const words = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  let base = words
    .map((w) => w[0])
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  if (!/^[a-z]/.test(base)) base = `t${base}`
  base = base.slice(0, 6)
  if (RESERVED.has(base)) base = `${base}_`
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`
}

const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/

function literal(value: string, numeric: boolean, d: SqlDialect): string {
  const v = value.trim()
  return numeric && NUMBER.test(v) ? v : d.quoteString(value)
}

/** LIKE pattern with `\`, `%` and `_` escaped, plus its explicit ESCAPE clause. */
function like(value: string, op: 'contains' | 'beginsWith' | 'endsWith', d: SqlDialect): string {
  const escaped = value.replace(/[\\%_]/g, (c) => `\\${c}`)
  const pattern =
    op === 'contains' ? `%${escaped}%` : op === 'beginsWith' ? `${escaped}%` : `%${escaped}`
  return `LIKE ${d.quoteString(pattern)} ESCAPE ${d.quoteString('\\')}`
}

function condition(expr: string, c: BuilderColumn, d: SqlDialect): string | null {
  const op = c.operator
  if (!op) return null
  if (op === 'isNull') return `${expr} IS NULL`
  if (op === 'isNotNull') return `${expr} IS NOT NULL`
  if (op === 'in') {
    const items = c.value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '')
    return items.length
      ? `${expr} IN (${items.map((v) => literal(v, c.numeric, d)).join(', ')})`
      : null
  }
  if (op === 'contains' || op === 'beginsWith' || op === 'endsWith')
    return `${expr} ${like(c.value, op, d)}`
  const sym = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' }[op]
  return `${expr} ${sym} ${literal(c.value, c.numeric, d)}`
}

/** The SELECT for a builder state, with warnings for what it had to assume. */
export function buildQuery(spec: BuilderSpec, d: SqlDialect): BuiltQuery {
  const warnings: string[] = []
  if (!spec.tables.length) return { sql: '', warnings }
  const single = spec.tables.length === 1
  const tableRef = (t: BuilderTable): string =>
    `${d.qualified(spec.qualifier, t.name)}${single ? '' : ` AS ${t.alias}`}`
  const colRef = (alias: string, column: string): string =>
    single ? d.quoteIdent(column) : `${alias}.${d.quoteIdent(column)}`
  const known = new Set(spec.tables.map((t) => t.alias))
  const columns = spec.columns.filter((c) => known.has(c.table))
  const expr = (c: BuilderColumn): string => {
    const ref = colRef(c.table, c.column)
    return c.aggregate ? `${c.aggregate}(${ref})` : ref
  }

  // FROM and joins: each table joins the ones already listed through every join it has with them.
  const from = [`FROM ${tableRef(spec.tables[0])}`]
  const included = new Set([spec.tables[0].alias])
  const pending = spec.tables.slice(1)
  const joins = spec.joins.filter((j) => known.has(j.a) && known.has(j.b) && j.on.length)
  while (pending.length) {
    const i = pending.findIndex((t) =>
      joins.some(
        (j) => (j.a === t.alias && included.has(j.b)) || (j.b === t.alias && included.has(j.a))
      )
    )
    if (i < 0) {
      const t = pending.shift()!
      warnings.push(
        `«${t.name}» no está unida a las demás tablas: se combina cada fila con todas (CROSS JOIN).`
      )
      from.push(`  CROSS JOIN ${tableRef(t)}`)
      included.add(t.alias)
      continue
    }
    const [t] = pending.splice(i, 1)
    const mine = joins.filter(
      (j) => (j.a === t.alias && included.has(j.b)) || (j.b === t.alias && included.has(j.a))
    )
    const on = mine.flatMap((j) =>
      j.on.map((p) =>
        j.a === t.alias
          ? `${colRef(j.a, p.a)} = ${colRef(j.b, p.b)}`
          : `${colRef(j.b, p.b)} = ${colRef(j.a, p.a)}`
      )
    )
    const type = mine.some((j) => j.type === 'LEFT') ? 'LEFT' : 'INNER'
    from.push(`  ${type} JOIN ${tableRef(t)} ON ${on.join(' AND ')}`)
    included.add(t.alias)
  }

  const output = columns.filter((c) => c.output)
  const select = output.length
    ? output.map((c) => `  ${expr(c)}${c.as.trim() ? ` AS ${d.quoteIdent(c.as.trim())}` : ''}`)
    : ['  *']
  const where = columns.filter((c) => !c.aggregate).flatMap((c) => condition(expr(c), c, d) ?? [])
  const having = columns.filter((c) => c.aggregate).flatMap((c) => condition(expr(c), c, d) ?? [])
  // With an aggregate, every visible plain column is a group (none: one row for the whole result).
  const groupBy = columns.some((c) => c.aggregate)
    ? output.filter((c) => !c.aggregate).map((c) => expr(c))
    : []
  const order = columns.filter((c) => c.sort).map((c) => `${expr(c)} ${c.sort}`)

  const lines = [`SELECT${spec.distinct ? ' DISTINCT' : ''}`, select.join(',\n'), ...from]
  if (where.length) lines.push(`WHERE ${where.join('\n  AND ')}`)
  if (groupBy.length) lines.push(`GROUP BY ${groupBy.join(', ')}`)
  if (having.length) lines.push(`HAVING ${having.join('\n  AND ')}`)
  if (order.length) lines.push(`ORDER BY ${order.join(', ')}`)
  if (spec.limit !== null && Number.isInteger(spec.limit) && spec.limit > 0)
    lines.push(`LIMIT ${spec.limit}`)
  return { sql: lines.join('\n'), warnings }
}
