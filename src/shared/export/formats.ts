/**
 * Text formatters of copy and export. Each format is a row-by-row writer
 * (`begin`, one `row` per data row, `end`), so the renderer joins the pieces
 * for the clipboard and main streams them to a file without holding the
 * whole result. Pure: no Node or DOM APIs.
 */
import type { CellValue, StorageClass } from '../types'
import type { CsvDelimiter, ExportColumn, ExportOptions } from './types'
import {
  cellText,
  isNumericColumn,
  jsonValue,
  sqlIdent,
  sqlLiteral,
  sqlTableName,
  uniqueNames
} from './values'

export type RowStorage = readonly (StorageClass | undefined)[] | undefined

export interface RowFormatter {
  /** Text before the first row (BOM, header line, opening bracket…). */
  begin(): string
  /** One data row (values in column order). */
  row(values: readonly CellValue[], storage?: RowStorage): string
  /** Text after the last row. */
  end(): string
}

export type TextFormat = 'csv' | 'tsv' | 'json' | 'sql' | 'markdown' | 'html'

/** Options of the text formatters (a superset of what each one reads). */
export interface TextFormatOptions extends Pick<
  ExportOptions,
  'header' | 'delimiter' | 'bom' | 'nullText' | 'jsonShape' | 'table' | 'schema' | 'batchSize'
> {
  dialect: ExportOptions['dialect']
  sqlNames?: string[]
  /** Line end: CRLF in files (RFC 4180), LF on the clipboard. */
  eol: '\r\n' | '\n'
  /** HTML document title. */
  title?: string
}

const BOM = '﻿'

/* ---------- CSV / TSV ---------- */

function delimitedField(text: string, delimiter: CsvDelimiter): string {
  if (text.includes(delimiter) || text.includes('"') || text.includes('\n') || text.includes('\r'))
    return `"${text.replace(/"/g, '""')}"`
  return text
}

/**
 * RFC 4180 CSV (also TSV with `delimiter: '\t'`): fields with the separator,
 * a quote or a line break are quoted with quotes doubled; NULL is an empty
 * field unless `nullText` says otherwise. Spreadsheets read the same quoting
 * when TSV is pasted.
 */
export function delimitedFormatter(
  columns: readonly ExportColumn[],
  options: Pick<TextFormatOptions, 'header' | 'delimiter' | 'bom' | 'nullText' | 'eol'>
): RowFormatter {
  const line = (fields: string[]): string =>
    fields.map((f) => delimitedField(f, options.delimiter)).join(options.delimiter) + options.eol
  return {
    begin: () =>
      (options.bom ? BOM : '') + (options.header ? line(columns.map((c) => c.name)) : ''),
    row: (values) => line(columns.map((_, i) => cellText(values[i] ?? null, options.nullText))),
    end: () => ''
  }
}

/* ---------- JSON ---------- */

/**
 * An array of objects keyed by column name (duplicate names get `_2`, `_3`…)
 * or an array of arrays (with the column names first when `header`). One row
 * per line. Numbers stay numbers only in numeric columns and only when a JS
 * number keeps them exactly; decimals and big integers keep their text.
 */
export function jsonFormatter(
  columns: readonly ExportColumn[],
  options: Pick<TextFormatOptions, 'jsonShape' | 'header' | 'eol'>
): RowFormatter {
  const keys = uniqueNames(columns.map((c) => c.name)).map((k) => JSON.stringify(k))
  let first = true
  const next = (text: string): string => {
    const out = `${first ? '' : ','}${options.eol}  ${text}`
    first = false
    return out
  }
  const values = (row: readonly CellValue[], storage: RowStorage): string[] =>
    columns.map((c, i) => JSON.stringify(jsonValue(row[i] ?? null, c, storage?.[i])))
  return {
    begin: () =>
      options.jsonShape === 'arrays' && options.header
        ? '[' + next(JSON.stringify(columns.map((c) => c.name)))
        : '[',
    row: (row, storage) => {
      const v = values(row, storage)
      return next(
        options.jsonShape === 'arrays'
          ? `[${v.join(', ')}]`
          : `{${keys.map((k, i) => `${k}: ${v[i]}`).join(', ')}}`
      )
    },
    end: () => `${first ? '' : options.eol}]${options.eol}`
  }
}

/* ---------- SQL ---------- */

function quotedColumnList(
  columns: readonly ExportColumn[],
  options: Pick<TextFormatOptions, 'dialect' | 'sqlNames'>
): string {
  const names =
    options.sqlNames && options.sqlNames.length === columns.length
      ? options.sqlNames
      : columns.map((c) => c.name)
  return names.map((n) => sqlIdent(options.dialect, n)).join(', ')
}

/**
 * INSERT statements with the engine's quoting: one per row (`batchSize` 1)
 * or multi-row `VALUES` lists of at most `batchSize` rows.
 */
export function insertFormatter(
  columns: readonly ExportColumn[],
  options: Pick<
    TextFormatOptions,
    'dialect' | 'table' | 'schema' | 'batchSize' | 'sqlNames' | 'eol'
  >
): RowFormatter {
  const target = sqlTableName(options.dialect, options.table || 'tabla', options.schema)
  const head = `INSERT INTO ${target} (${quotedColumnList(columns, options)}) VALUES`
  const batch = Math.max(1, Math.floor(options.batchSize) || 1)
  const eol = options.eol
  let inBatch = 0
  const tuple = (values: readonly CellValue[], storage: RowStorage): string =>
    `(${columns.map((c, i) => sqlLiteral(values[i] ?? null, c, options.dialect, storage?.[i])).join(', ')})`
  return {
    begin: () => '',
    row: (values, storage) => {
      if (batch === 1) return `${head} ${tuple(values, storage)};${eol}`
      let out = inBatch === 0 ? `${head}${eol}  ` : `,${eol}  `
      out += tuple(values, storage)
      inBatch++
      if (inBatch >= batch) {
        out += `;${eol}`
        inBatch = 0
      }
      return out
    },
    end: () => {
      if (inBatch === 0) return ''
      inBatch = 0
      return `;${eol}`
    }
  }
}

/* ---------- Markdown ---------- */

function markdownCell(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, '<br>')
}

/** A GitHub-style table: `|` escaped, line breaks as `<br>`, numeric columns right aligned. */
export function markdownFormatter(
  columns: readonly ExportColumn[],
  options: Pick<TextFormatOptions, 'nullText' | 'eol'>
): RowFormatter {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |${options.eol}`
  return {
    begin: () =>
      line(columns.map((c) => markdownCell(c.name))) +
      line(columns.map((c) => (isNumericColumn(c) ? '---:' : '---'))),
    row: (values) =>
      line(columns.map((_, i) => markdownCell(cellText(values[i] ?? null, options.nullText)))),
    end: () => ''
  }
}

/* ---------- HTML ---------- */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const HTML_STYLE = [
  'body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;margin:16px;color:#1f2328}',
  'table{border-collapse:collapse}',
  'th,td{border:1px solid #d0d7de;padding:4px 8px;vertical-align:top;white-space:pre-wrap}',
  'th{background:#f6f8fa;text-align:left}',
  'td.num{text-align:right;font-variant-numeric:tabular-nums}',
  'td.null{color:#8c959f;font-style:italic}'
].join('')

/** A standalone HTML page with one escaped table. */
export function htmlFormatter(
  columns: readonly ExportColumn[],
  options: Pick<TextFormatOptions, 'nullText' | 'eol' | 'title'>
): RowFormatter {
  const eol = options.eol
  const numeric = columns.map((c) => isNumericColumn(c))
  const title = escapeHtml(options.title || 'Resultado')
  return {
    begin: () =>
      `<!DOCTYPE html>${eol}<html>${eol}<head>${eol}<meta charset="utf-8">${eol}` +
      `<title>${title}</title>${eol}<style>${HTML_STYLE}</style>${eol}</head>${eol}<body>${eol}` +
      `<table>${eol}<thead>${eol}<tr>${columns.map((c) => `<th>${escapeHtml(c.name)}</th>`).join('')}</tr>${eol}</thead>${eol}<tbody>${eol}`,
    row: (values) =>
      `<tr>${columns
        .map((_, i) => {
          const value = values[i] ?? null
          const cls = value === null ? ' class="null"' : numeric[i] ? ' class="num"' : ''
          return `<td${cls}>${escapeHtml(cellText(value, options.nullText))}</td>`
        })
        .join('')}</tr>${eol}`,
    end: () => `</tbody>${eol}</table>${eol}</body>${eol}</html>${eol}`
  }
}

/** The formatter of a text format. */
export function textFormatter(
  format: TextFormat,
  columns: readonly ExportColumn[],
  options: TextFormatOptions
): RowFormatter {
  switch (format) {
    case 'csv':
      return delimitedFormatter(columns, options)
    case 'tsv':
      return delimitedFormatter(columns, { ...options, delimiter: '\t' })
    case 'json':
      return jsonFormatter(columns, options)
    case 'sql':
      return insertFormatter(columns, options)
    case 'markdown':
      return markdownFormatter(columns, options)
    case 'html':
      return htmlFormatter(columns, options)
  }
}

/** Runs a formatter over in-memory rows. */
export function formatRows(
  formatter: RowFormatter,
  rows: readonly (readonly CellValue[])[],
  storage?: readonly RowStorage[]
): string {
  let out = formatter.begin()
  rows.forEach((row, i) => (out += formatter.row(row, storage?.[i])))
  return out + formatter.end()
}

/* ---------- copy-only formats ---------- */

export interface UpdateCopyInput {
  /** Every column of the grid, so key values are found even when the key is not selected. */
  columns: readonly ExportColumn[]
  rows: readonly (readonly CellValue[])[]
  storage?: readonly RowStorage[]
  /** Columns to SET (indexes into `columns`). */
  setColumns: readonly number[]
  /** Key columns for WHERE (indexes into `columns`). */
  keyColumns: readonly number[]
  dialect: ExportOptions['dialect']
  table: string
  schema?: string | null
  /** Real column names, aligned with `columns`. */
  sqlNames?: string[]
  eol: '\r\n' | '\n'
}

/**
 * `UPDATE t SET a = …, b = … WHERE key = …;` per row: the selected columns
 * that are not part of the key, addressed by the whole key (NULL keys match
 * with IS NULL). Empty when only key columns are selected.
 */
export function formatUpdates(input: UpdateCopyInput): string {
  const keys = new Set(input.keyColumns)
  const set = input.setColumns.filter((c) => !keys.has(c))
  if (!set.length || !input.keyColumns.length) return ''
  const names =
    input.sqlNames && input.sqlNames.length === input.columns.length
      ? input.sqlNames
      : input.columns.map((c) => c.name)
  const target = sqlTableName(input.dialect, input.table || 'tabla', input.schema)
  const ident = (i: number): string => sqlIdent(input.dialect, names[i])
  return input.rows
    .map((row, r) => {
      const storage = input.storage?.[r]
      const literal = (i: number): string =>
        sqlLiteral(row[i] ?? null, input.columns[i], input.dialect, storage?.[i])
      const assignments = set.map((i) => `${ident(i)} = ${literal(i)}`).join(', ')
      const where = input.keyColumns
        .map((i) =>
          (row[i] ?? null) === null ? `${ident(i)} IS NULL` : `${ident(i)} = ${literal(i)}`
        )
        .join(' AND ')
      return `UPDATE ${target} SET ${assignments} WHERE ${where};${input.eol}`
    })
    .join('')
}

export interface InListResult {
  text: string
  /** Distinct values listed. */
  values: number
  /** NULL cells left out (IN never matches NULL). */
  nulls: number
}

/**
 * `(v1, v2, …)` with each value once, numbers unquoted in numeric columns.
 * NULL is left out (`x IN (NULL)` matches nothing) and counted, so the UI can
 * suggest `OR x IS NULL`. With several columns, one `col IN (…)` line each.
 */
export function formatInList(
  columns: readonly ExportColumn[],
  rows: readonly (readonly CellValue[])[],
  dialect: ExportOptions['dialect'],
  storage?: readonly RowStorage[],
  sqlNames?: string[]
): InListResult {
  let nulls = 0
  let count = 0
  const lists = columns.map((column, c) => {
    const seen = new Set<string>()
    for (let r = 0; r < rows.length; r++) {
      const value = rows[r][c] ?? null
      if (value === null) {
        nulls++
        continue
      }
      seen.add(sqlLiteral(value, column, dialect, storage?.[r]?.[c]))
    }
    count += seen.size
    return `(${[...seen].join(', ')})`
  })
  if (columns.length === 1) return { text: lists[0], values: count, nulls }
  const names =
    sqlNames && sqlNames.length === columns.length ? sqlNames : columns.map((c) => c.name)
  return {
    text: lists.map((list, i) => `${sqlIdent(dialect, names[i])} IN ${list}`).join('\n'),
    values: count,
    nulls
  }
}
