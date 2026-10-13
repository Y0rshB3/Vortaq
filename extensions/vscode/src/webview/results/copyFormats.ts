/**
 * «Copiar como TSV / CSV / JSON» of a result set. Pure (unit-tested). NULL is
 * an empty field in TSV and CSV and `null` in JSON; values keep the text the
 * driver returned (BIGINT and DECIMAL stay exact, binary stays 0x…).
 */
import type { CellValue } from '@shared/types'

export type CopyFormat = 'tsv' | 'csv' | 'json'

const text = (v: CellValue): string => (v === null ? '' : String(v))

/** Quotes a field that holds the separator, a quote or a line break (RFC 4180 style). */
function field(v: CellValue, separator: string): string {
  const s = text(v)
  return s.includes(separator) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function delimited(
  columns: readonly string[],
  rows: readonly CellValue[][],
  separator: string
): string {
  return [columns, ...rows]
    .map((row) => row.map((v) => field(v as CellValue, separator)).join(separator))
    .join('\n')
}

/** Distinct keys for JSON objects: a join's second `id` becomes `id_2`. */
export function uniqueKeys(columns: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return columns.map((name) => {
    const n = (seen.get(name) ?? 0) + 1
    seen.set(name, n)
    if (n === 1) return name
    let key = `${name}_${n}`
    while (columns.includes(key)) key = `${key}_`
    return key
  })
}

export function formatRows(
  format: CopyFormat,
  columns: readonly string[],
  rows: readonly CellValue[][]
): string {
  if (format === 'tsv') return delimited(columns, rows, '\t')
  if (format === 'csv') return delimited(columns, rows, ',')
  const keys = uniqueKeys(columns)
  return JSON.stringify(
    rows.map((row) => Object.fromEntries(keys.map((k, i) => [k, row[i] ?? null]))),
    null,
    2
  )
}

export const FORMAT_LABELS: Record<CopyFormat, string> = {
  tsv: 'TSV (para hojas de cálculo)',
  csv: 'CSV',
  json: 'JSON'
}
