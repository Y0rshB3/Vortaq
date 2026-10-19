import type {
  CellValue,
  ColumnInfo,
  ForeignKeyInfo,
  QueryColumn,
  SchemaRef,
  TableFilter
} from '@shared/types'
import { displayCell } from './rowEditing'

/**
 * A foreign key the grid can fill from its referenced table: «Elegir de
 * <tabla>…» reads that table with db:tableData and writes the chosen row's
 * referenced values into the grid columns `cols` (all of them for a
 * composite key).
 */
export interface GridForeignKey {
  name: string
  /** Grid column index of each key column, in key order. */
  cols: number[]
  /** Referenced table, where db:tableData reads it, and its columns aligned with `cols`. */
  table: string
  schema: SchemaRef
  refColumns: string[]
}

/** Address of the referenced table: MySQL/SQLite name the database, PostgreSQL also needs its database. */
export type ReferencedSchemaRef = (referencedSchema: string) => SchemaRef

/**
 * The foreign key of each grid column (the first one when a column belongs to
 * several), or null. `columnInfo` names the real table column behind each grid
 * column (a query result may rename it); a key is offered only when every one
 * of its columns is in the grid.
 */
export function gridForeignKeys(
  columnInfo: readonly (ColumnInfo | null | undefined)[],
  foreignKeys: readonly ForeignKeyInfo[],
  refOf: ReferencedSchemaRef
): (GridForeignKey | null)[] {
  const out: (GridForeignKey | null)[] = columnInfo.map(() => null)
  const indexOf = (name: string): number =>
    columnInfo.findIndex((i) => !!i && i.name.toLowerCase() === name.toLowerCase())
  for (const fk of foreignKeys) {
    if (!fk.columns.length || fk.columns.length !== fk.referencedColumns.length) continue
    const cols = fk.columns.map(indexOf)
    if (cols.some((c) => c < 0)) continue
    const key: GridForeignKey = {
      name: fk.name,
      cols,
      table: fk.referencedTable,
      schema: refOf(fk.referencedSchema),
      refColumns: [...fk.referencedColumns]
    }
    for (const c of cols) out[c] ??= key
  }
  return out
}

/** Short label of a key's target: `clientes (id)` or `pedidos (anio, numero)`. */
export function foreignKeyLabel(fk: GridForeignKey): string {
  return `${fk.table} (${fk.refColumns.join(', ')})`
}

const SEARCHABLE_KINDS = new Set(['text', 'uuid', 'enum', 'integer', 'decimal', 'float'])
/** Columns a search compares at most (the referenced ones always count). */
export const MAX_SEARCH_COLUMNS = 8

/** Text-like columns a search may use: never binary, JSON, spatial or arrays. */
function searchable(column: QueryColumn): boolean {
  if (column.typeKind) return SEARCHABLE_KINDS.has(column.typeKind)
  return !/(blob|binary|bytea|json|geometry|point|polygon|linestring|\[\])/i.test(column.type)
}

/**
 * The structured filter of a search in the referenced table: any of the
 * referenced columns or the first text-like columns contains the text
 * (main escapes the value and checks every column name). Null without text.
 */
export function foreignKeySearch(
  columns: readonly QueryColumn[],
  refColumns: readonly string[],
  text: string
): TableFilter | null {
  const value = text.trim()
  if (!value) return null
  const names = columns.map((c) => c.name)
  // Before the first page arrives only the referenced columns are known.
  const picked = refColumns.filter((r) => !names.length || names.includes(r))
  for (const c of columns) {
    if (picked.length >= MAX_SEARCH_COLUMNS) break
    if (!picked.includes(c.name) && searchable(c)) picked.push(c.name)
  }
  return {
    kind: 'group',
    enabled: true,
    connector: 'AND',
    children: picked.map((column) => ({
      kind: 'condition' as const,
      enabled: true,
      column,
      operator: 'contains' as const,
      values: [value],
      connector: 'OR' as const
    }))
  }
}

/**
 * What the grid writes when a referenced row is chosen: the referenced values
 * as the text editor would (NULL stays NULL), aligned with `fk.cols`. Null when
 * a referenced column is missing from the loaded rows.
 */
export function chosenValues(
  fk: GridForeignKey,
  columns: readonly QueryColumn[],
  row: readonly CellValue[]
): (string | null)[] | null {
  const values: (string | null)[] = []
  for (const ref of fk.refColumns) {
    const i = columns.findIndex((c) => c.name === ref)
    if (i < 0) return null
    const v = row[i] ?? null
    values.push(v === null ? null : displayCell(v))
  }
  return values
}
