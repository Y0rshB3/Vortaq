import type { ColumnInfo } from '@shared/types'

/**
 * Values of a MySQL/MariaDB `enum('a','b')` column type as information_schema
 * spells it: single quotes doubled (`'it''s'`), backslashes doubled. Null when
 * the type is not an enum or cannot be read whole (never a partial list).
 */
export function parseEnumType(columnType: string | null | undefined): string[] | null {
  const m = /^\s*enum\s*\((.*)\)\s*$/is.exec(columnType ?? '')
  if (!m) return null
  const body = m[1]
  const values: string[] = []
  let i = 0
  while (i < body.length) {
    while (body[i] === ' ') i++
    if (body[i] !== "'") return null
    i++
    let value = ''
    for (;;) {
      if (i >= body.length) return null
      const c = body[i]
      if (c === "'" && body[i + 1] === "'") {
        value += "'"
        i += 2
      } else if (c === '\\' && (body[i + 1] === '\\' || body[i + 1] === "'")) {
        value += body[i + 1]
        i += 2
      } else if (c === "'") {
        i++
        break
      } else {
        value += c
        i++
      }
    }
    values.push(value)
    while (body[i] === ' ') i++
    if (i >= body.length) break
    if (body[i] !== ',') return null
    i++
  }
  return values.length ? values : null
}

/**
 * Allowed values of a column edited in the grid: PostgreSQL's pg_enum labels,
 * or the MySQL/MariaDB enum type parsed. Null for any other column.
 */
export function enumOptions(info: ColumnInfo | null | undefined): string[] | null {
  if (!info) return null
  if (info.enumValues?.length) return info.enumValues
  return parseEnumType(info.columnType)
}

/**
 * The option a typed text stands for: the exact value, else the only one equal
 * ignoring case (MySQL compares enum input that way). Null when none or ambiguous.
 */
export function matchEnumOption(options: readonly string[], text: string): string | null {
  if (options.includes(text)) return text
  const lower = text.toLowerCase()
  const same = options.filter((o) => o.toLowerCase() === lower)
  return same.length === 1 ? same[0] : null
}

/** Options shown for a typed text: those starting with it first, then those containing it. */
export function filterEnumOptions(options: readonly string[], text: string): string[] {
  const q = text.trim().toLowerCase()
  if (!q) return [...options]
  const starts = options.filter((o) => o.toLowerCase().startsWith(q))
  const contains = options.filter((o) => !starts.includes(o) && o.toLowerCase().includes(q))
  return [...starts, ...contains]
}
