/**
 * Value rules of copy and export: which columns are numeric or hold binary
 * data shown as `0xHEX`, the text of a cell (exactly what the grid shows:
 * dates, decimals and big integers are never reformatted) and SQL literals
 * with the quoting of each engine.
 */
import { getDialect } from '../dialects'
import type { SqlDialectId } from '../dialects/types'
import type { CellValue, StorageClass, TypeKind } from '../types'
import type { ExportColumn } from './types'

/** What the value rules read of a column (its name is optional here). */
export type ColumnTypeInfo = Pick<ExportColumn, 'type' | 'typeKind'> & { name?: string }

const NUMERIC_KINDS: ReadonlySet<TypeKind> = new Set<TypeKind>(['integer', 'decimal', 'float'])

/* MySQL type labels (the MySQL driver sends no typeKind). BIT is shown as 0xHEX: binary. */
const MYSQL_NUMERIC =
  /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|YEAR)\b/i
const MYSQL_INTEGER = /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|YEAR)\b/i
const MYSQL_HEX_BINARY = /^(TINYBLOB|MEDIUMBLOB|LONGBLOB|BLOB|BINARY|VARBINARY|BIT|GEOMETRY)\b/i

/** Numbers in the column are numbers (right aligned in the grid, unquoted in SQL). */
export function isNumericColumn(column: ColumnTypeInfo): boolean {
  if (column.typeKind) return NUMERIC_KINDS.has(column.typeKind)
  return MYSQL_NUMERIC.test((column.type ?? '').trim())
}

export function isIntegerColumn(column: ColumnTypeInfo): boolean {
  if (column.typeKind) return column.typeKind === 'integer'
  return MYSQL_INTEGER.test((column.type ?? '').trim())
}

/**
 * The grid shows this column's bytes as `0xHEX` text: MySQL/MariaDB binary,
 * BIT and GEOMETRY columns, PostgreSQL bytea and SQLite BLOB columns.
 */
export function isHexBinaryColumn(column: ColumnTypeInfo): boolean {
  if (column.typeKind) return column.typeKind === 'binary'
  return MYSQL_HEX_BINARY.test((column.type ?? '').trim())
}

/** Text of a cell as the grid shows it; NULL becomes `nullText`. */
export function cellText(value: CellValue, nullText = ''): string {
  if (value === null) return nullText
  if (typeof value === 'boolean') return value ? '1' : '0'
  return String(value)
}

const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const INTEGER = /^[+-]?\d+$/
const HEX = /^0x((?:[0-9a-f]{2})*)$/i

/** A decimal number written the way SQL and JSON read it (no hex, no spaces, no Infinity). */
export function isDecimalText(text: string): boolean {
  return DECIMAL.test(text)
}

/** JSON value of a cell: numbers only for numeric data that a JS number keeps exactly. */
export function jsonValue(
  value: CellValue,
  column: ColumnTypeInfo,
  storage?: StorageClass
): unknown {
  if (value === null || typeof value === 'boolean') return value
  const numeric = storage === 'integer' || storage === 'real' || isNumericColumn(column)
  // Integer data (BIGINT, SQLite integers): beyond 2^53 a JS number is no longer exact.
  const integerData = storage === 'integer' || (storage === undefined && isIntegerColumn(column))
  if (typeof value === 'number') {
    if (!numeric || !Number.isFinite(value)) return String(value)
    return integerData && !Number.isSafeInteger(value) ? String(value) : value
  }
  if (numeric && integerData && INTEGER.test(value)) {
    const n = Number(value)
    if (Number.isSafeInteger(n) && String(n) === value.replace(/^\+/, '')) return n
  }
  // Decimals and big integers keep their exact text.
  return value
}

/** SQL literal of a cell for `dialect`; `storage` is the SQLite storage class when known. */
export function sqlLiteral(
  value: CellValue,
  column: ColumnTypeInfo,
  dialect: SqlDialectId,
  storage?: StorageClass
): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean')
    return dialect === 'postgresql' ? (value ? 'TRUE' : 'FALSE') : value ? '1' : '0'
  const quote = getDialect(dialect).quoteString
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : quote(String(value))
  if (dialect === 'sqlite' && storage) {
    if (storage === 'blob') {
      const hex = HEX.exec(value)
      if (hex) return `X'${hex[1].toUpperCase()}'`
    }
    if ((storage === 'integer' || storage === 'real') && DECIMAL.test(value)) return value
    if (storage === 'text') return quote(value)
  }
  if (isHexBinaryColumn(column)) {
    const hex = HEX.exec(value)
    // PostgreSQL bytea reads '\x…' (standard_conforming_strings); the others take X'…'.
    if (hex)
      return dialect === 'postgresql'
        ? `'\\x${hex[1].toUpperCase()}'`
        : `X'${hex[1].toUpperCase()}'`
  }
  if (isNumericColumn(column) && DECIMAL.test(value)) return value
  return quote(value)
}

/** Quoted (and optionally qualified) table name for `dialect`. */
export function sqlTableName(dialect: SqlDialectId, table: string, schema?: string | null): string {
  return getDialect(dialect).qualified(schema || null, table)
}

export function sqlIdent(dialect: SqlDialectId, name: string): string {
  return getDialect(dialect).quoteIdent(name)
}

/**
 * Keys for JSON objects: duplicate column names (joins: `id`, `id`) get a
 * numeric suffix in order (`id`, `id_2`), skipping names already taken.
 */
export function uniqueNames(names: readonly string[]): string[] {
  const taken = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    let key = name
    for (let n = 2; taken.has(key); n++) key = `${name}_${n}`
    taken.add(key)
    out.push(key)
  }
  return out
}
