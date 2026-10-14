/**
 * Copy and export of tabular results (query results and table data). Pure
 * types and defaults shared by the renderer (copy, the export dialog) and main
 * (the export writers); no Node or DOM APIs.
 */
import type { SqlDialectId } from '../dialects/types'
import type { CellValue, SchemaRef, StorageClass, TableDataRequest, TypeKind } from '../types'

/** File formats of «Exportar». */
export type ExportFormat = 'csv' | 'xlsx' | 'json' | 'sql' | 'markdown' | 'html' | 'txt'

/** Clipboard formats of «Copiar como». */
export type CopyFormat = 'tsv' | 'csv' | 'json' | 'insert' | 'update' | 'in' | 'markdown'

/** One column of the exported data, in display order. */
export interface ExportColumn {
  /** Name shown in the result (the alias when the query uses `AS`). */
  name: string
  /** Type label as the driver reports it (MySQL names such as "BIGINT UNSIGNED"). */
  type?: string
  /** Engine-neutral family; absent => MySQL type names decide. */
  typeKind?: TypeKind
}

export type CsvDelimiter = ',' | ';' | '\t'

export interface ExportOptions {
  format: ExportFormat
  /** First line/row with the column names (CSV, TXT, XLSX; Markdown and HTML always have one). */
  header: boolean
  /** CSV field separator. */
  delimiter: CsvDelimiter
  /** UTF-8 byte order mark (CSV and TXT), so Excel reads accents correctly. */
  bom: boolean
  /** Text written for NULL in CSV, TXT, Markdown, HTML and XLSX ('' = empty field or cell). */
  nullText: string
  /** JSON: an array of objects keyed by column name, or an array of arrays. */
  jsonShape: 'objects' | 'arrays'
  /** SQL: target table of the INSERT statements (unqualified). */
  table: string
  /** SQL: optional schema/database that qualifies the table. */
  schema?: string | null
  /** SQL: rows per INSERT statement (1 = one statement per row). */
  batchSize: number
  /** SQL quoting rules. */
  dialect: SqlDialectId
  /**
   * SQL: column names for the INSERT, aligned with the columns (the source
   * table's names when the result renamed them with `AS`).
   */
  sqlNames?: string[]
  /** XLSX: worksheet name (sanitised; «Resultado» when empty). */
  sheetName?: string
}

export interface ExportFormatInfo {
  format: ExportFormat
  label: string
  extension: string
  /** Save dialog filter name. */
  filterName: string
}

export const EXPORT_FORMATS: readonly ExportFormatInfo[] = [
  { format: 'csv', label: 'CSV', extension: 'csv', filterName: 'CSV' },
  { format: 'xlsx', label: 'Excel (.xlsx)', extension: 'xlsx', filterName: 'Libro de Excel' },
  { format: 'json', label: 'JSON', extension: 'json', filterName: 'JSON' },
  { format: 'sql', label: 'SQL (INSERT)', extension: 'sql', filterName: 'SQL' },
  { format: 'markdown', label: 'Markdown', extension: 'md', filterName: 'Markdown' },
  { format: 'html', label: 'HTML', extension: 'html', filterName: 'HTML' },
  { format: 'txt', label: 'TXT (tabulado)', extension: 'txt', filterName: 'Texto' }
]

export function formatInfo(format: ExportFormat): ExportFormatInfo {
  const info = EXPORT_FORMATS.find((f) => f.format === format)
  if (!info) throw new Error(`Formato de exportación desconocido: ${String(format)}`)
  return info
}

export const DEFAULT_BATCH_SIZE = 100
export const MAX_BATCH_SIZE = 10_000

export function defaultExportOptions(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return {
    format: 'csv',
    header: true,
    delimiter: ',',
    bom: false,
    nullText: '',
    jsonShape: 'objects',
    table: 'tabla',
    schema: null,
    batchSize: DEFAULT_BATCH_SIZE,
    dialect: 'mysql',
    ...overrides
  }
}

/** export:rows — rows the renderer already holds (the loaded rows or the selection). */
export interface ExportRowsRequest {
  /** Absolute path chosen in the save dialog; written through `<path>.part`. */
  filePath: string
  columns: ExportColumn[]
  rows: CellValue[][]
  /** SQLite: storage class of each cell (blobs, integers and reals keep their class in SQL). */
  storage?: StorageClass[][]
  options: ExportOptions
}

/** Which rows «Exportar resultado completo» reads again. */
export type ExportQuerySource =
  | {
      kind: 'statement'
      /** The single statement the result came from (refused unless it is read-only). */
      sql: string
      /**
       * Where it ran: the MySQL database, PostgreSQL `{ database, schema }`
       * (search_path), ignored on SQLite. Absent = the connection's default.
       */
      context?: SchemaRef | null
    }
  | {
      kind: 'table'
      /** The table view's SELECT: its filter and sort, no paging. */
      request: Omit<TableDataRequest, 'limit' | 'offset'>
    }

/** export:query — runs the source again in a new read-only session and streams it to the file. */
export interface ExportQueryRequest {
  connectionId: string
  filePath: string
  source: ExportQuerySource
  options: ExportOptions
}

export interface ExportResult {
  filePath: string
  /** Data rows written (the header line is not counted). */
  rows: number
  bytes: number
  durationMs: number
  /** XLSX: cells cut to Excel's 32.767-character limit. */
  truncatedCells: number
}
