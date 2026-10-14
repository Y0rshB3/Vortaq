/**
 * Copy and export data of the results grid: the selected region as tabular
 * data (values exactly as the grid shows them, pending edits included) and
 * the clipboard text of each «Copiar como» format, built with the shared
 * formatters (src/shared/export). Pure: no DOM.
 */
import type { SqlDialectId } from '@shared/dialects/types'
import { formatInList, formatRows, formatUpdates, textFormatter } from '@shared/export/formats'
import type { CopyFormat, ExportColumn } from '@shared/export/types'
import type { CellValue, QueryColumn, StorageClass } from '@shared/types'
import type { GridRegion } from './gridSelection'
import type { EditableRow } from './rowEditing'

/** What copy needs to know about where the rows come from. */
export interface CopyContext {
  dialect: SqlDialectId
  /** INSERT/UPDATE target (unqualified), when the result has one source table. */
  table: string | null
  /** Key columns (displayed names) for UPDATE; empty = unknown, UPDATE is not offered. */
  keyColumns: string[]
  /** Real column names aligned with the grid columns (results that rename with `AS`). */
  sqlNames?: string[]
}

export const DEFAULT_COPY_CONTEXT: CopyContext = { dialect: 'mysql', table: null, keyColumns: [] }

/** What «Exportar» writes: the selection, the rows in the grid, or the whole result again. */
export type ExportScope = 'selection' | 'loaded' | 'full'

/** Placeholder table name when the result has no single source table. */
export const TABLE_PLACEHOLDER = 'nombre_tabla'

export interface TabularData {
  columns: ExportColumn[]
  rows: CellValue[][]
  /** SQLite: storage class of each cell (absent elsewhere). */
  storage?: StorageClass[][]
  /** Real names of `columns` (aligned), when known. */
  sqlNames?: string[]
}

export function exportColumns(columns: readonly QueryColumn[]): ExportColumn[] {
  return columns.map((c) => ({
    name: c.name,
    type: c.type,
    ...(c.typeKind ? { typeKind: c.typeKind } : {})
  }))
}

/** The region's rows × columns (display order). */
export function regionData(
  columns: readonly QueryColumn[],
  rows: readonly EditableRow[],
  region: GridRegion,
  sqlNames?: string[]
): TabularData {
  const picked = region.rows.map((i) => rows[i]).filter((r): r is EditableRow => !!r)
  const hasStorage = picked.some((r) => r.storage)
  const names =
    sqlNames && sqlNames.length === columns.length ? region.cols.map((c) => sqlNames[c]) : undefined
  return {
    columns: exportColumns(region.cols.map((c) => columns[c])),
    rows: picked.map((r) => region.cols.map((c) => r.values[c] ?? null)),
    ...(hasStorage
      ? { storage: picked.map((r) => region.cols.map((c) => r.storage?.[c] ?? 'null')) }
      : {}),
    ...(names ? { sqlNames: names } : {})
  }
}

/** Every row and column of the grid. */
export function allData(
  columns: readonly QueryColumn[],
  rows: readonly EditableRow[],
  sqlNames?: string[]
): TabularData {
  return regionData(
    columns,
    rows,
    { rows: rows.map((_, i) => i), cols: columns.map((_, i) => i) },
    sqlNames
  )
}

export interface CopyOutcome {
  text: string
  /** Toast shown after copying («3 filas copiadas»…). */
  message: string
  /** Shown as a warning instead of copying (nothing to copy in that format). */
  warning?: string
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export const COPY_FORMAT_LABELS: Record<CopyFormat, string> = {
  tsv: 'Texto tabulado',
  csv: 'CSV',
  json: 'JSON',
  insert: 'INSERT',
  update: 'UPDATE',
  in: 'Lista para IN',
  markdown: 'Markdown'
}

/**
 * Clipboard text of `data` in `format`. UPDATE also needs every column of
 * the selected rows (`full`) because the key may not be selected.
 */
export function copyText(
  format: CopyFormat,
  data: TabularData,
  context: CopyContext,
  options: { header?: boolean } = {},
  full?: { columns: readonly QueryColumn[]; rows: readonly EditableRow[]; region: GridRegion }
): CopyOutcome {
  const rowCount = data.rows.length
  const cells = rowCount * data.columns.length
  const what = cells === 1 ? 'Celda copiada' : plural(rowCount, 'fila copiada', 'filas copiadas')
  const table = context.table || TABLE_PLACEHOLDER
  switch (format) {
    case 'in': {
      const result = formatInList(
        data.columns,
        data.rows,
        context.dialect,
        data.storage,
        data.sqlNames
      )
      const nulls = result.nulls
        ? ` · ${plural(result.nulls, 'NULL omitido', 'NULL omitidos')}: IN no encuentra NULL, añade «OR columna IS NULL»`
        : ''
      if (!result.values)
        return {
          text: '',
          message: '',
          warning: 'No hay valores que listar: todas las celdas son NULL.'
        }
      return {
        text: result.text,
        message: `Lista para IN copiada (${plural(result.values, 'valor', 'valores')})${nulls}`
      }
    }
    case 'update': {
      if (!context.keyColumns.length || !full)
        return {
          text: '',
          message: '',
          warning: 'No se conoce la clave primaria de este resultado: no se puede generar UPDATE.'
        }
      const keyIndexes = context.keyColumns
        .map((k) => full.columns.findIndex((c) => c.name === k))
        .filter((i) => i >= 0)
      if (keyIndexes.length !== context.keyColumns.length)
        return {
          text: '',
          message: '',
          warning:
            'El resultado no incluye todas las columnas de la clave: no se puede generar UPDATE.'
        }
      const rows = full.region.rows.map((i) => full.rows[i]).filter((r): r is EditableRow => !!r)
      const text = formatUpdates({
        columns: exportColumns(full.columns),
        rows: rows.map((r) => r.values),
        storage: rows.some((r) => r.storage) ? rows.map((r) => r.storage) : undefined,
        setColumns: full.region.cols,
        keyColumns: keyIndexes,
        dialect: context.dialect,
        table,
        sqlNames: context.sqlNames,
        eol: '\n'
      })
      if (!text)
        return {
          text: '',
          message: '',
          warning: 'Selecciona alguna columna que no sea de la clave para generar UPDATE.'
        }
      return { text, message: `${plural(rows.length, 'UPDATE copiado', 'UPDATE copiados')}` }
    }
    default: {
      const textFormat =
        format === 'insert' ? 'sql' : format === 'tsv' ? 'tsv' : format === 'csv' ? 'csv' : format
      const formatter = textFormatter(textFormat, data.columns, {
        header: options.header ?? format !== 'tsv',
        delimiter: ',',
        bom: false,
        nullText: format === 'markdown' ? 'NULL' : '',
        jsonShape: 'objects',
        table,
        batchSize: 1,
        dialect: context.dialect,
        sqlNames: data.sqlNames,
        eol: '\n'
      })
      let text = formatRows(formatter, data.rows, data.storage)
      // Tab-separated text pastes into cells and editors without a trailing empty line.
      if (format === 'tsv') text = text.replace(/\n$/, '')
      return {
        text,
        message: format === 'tsv' ? what : `${what} como ${COPY_FORMAT_LABELS[format]}`
      }
    }
  }
}
