import type { CellValue, QueryColumn, RowChange, StorageClass } from '@shared/types'

/**
 * Client-side editing model for the table data grid. Rows keep their original
 * values so that pending edits can be highlighted and turned into a minimal
 * RowChange[] payload for db:applyRowChanges.
 */
export interface EditableRow {
  /** Stable key for v-for while the page is displayed. */
  uid: string
  /** Values as loaded from the server; null for rows added in the UI. */
  original: CellValue[] | null
  values: CellValue[]
  /** Column indexes explicitly set by the user (used to build INSERT values). */
  touched: number[]
  deleted: boolean
  /** SQLite: storage class of each loaded cell (kept by edits, shown in the tooltip). */
  storage?: StorageClass[]
}

/** Focused cell of the grid. */
export interface ActiveCell {
  uid: string
  col: number
}

let seq = 0
const nextUid = (): string => `r${++seq}`

export function rowsFromPage(rows: CellValue[][], storage?: StorageClass[][]): EditableRow[] {
  return rows.map((r, i) => ({
    uid: nextUid(),
    original: r,
    values: [...r],
    touched: [],
    deleted: false,
    ...(storage?.[i] ? { storage: storage[i] } : {})
  }))
}

export function newRow(columnCount: number): EditableRow {
  return {
    uid: nextUid(),
    original: null,
    values: Array.from({ length: columnCount }, () => null),
    touched: [],
    deleted: false
  }
}

/** Values are compared as text because inline edits always produce strings. */
export function sameValue(a: CellValue, b: CellValue): boolean {
  if (a === null || b === null) return a === b
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) === Number(b)
  return String(a) === String(b)
}

export function isCellChanged(row: EditableRow, col: number): boolean {
  if (!row.original) return row.touched.includes(col)
  return !sameValue(row.original[col], row.values[col])
}

export function isRowChanged(row: EditableRow): boolean {
  if (row.deleted) return row.original !== null
  if (!row.original) return true
  return row.values.some((_, i) => isCellChanged(row, i))
}

export function pendingCount(rows: EditableRow[]): number {
  return rows.filter(isRowChanged).length
}

/**
 * A locked column (SQLite rowid or generated column, a query result's column
 * of another table or computed) is never edited on a loaded row; a new row may
 * set its rowid.
 */
export function isLockedCell(column: QueryColumn | undefined, row: EditableRow): boolean {
  const locked = column?.locked
  return !!locked && (locked !== 'rowid' || !!row.original)
}

export function setCell(row: EditableRow, col: number, value: CellValue): void {
  row.values[col] = value
  if (!row.touched.includes(col)) row.touched.push(col)
}

/** Columns used to identify a row: the primary key, or every column when the table has none. */
export function keyColumns(columns: QueryColumn[], primaryKey: string[]): string[] {
  const names = columns.map((c) => c.name)
  const pk = primaryKey.filter((k) => names.includes(k))
  return pk.length ? pk : names
}

function keyOf(
  row: EditableRow,
  columns: QueryColumn[],
  keys: string[]
): Record<string, CellValue> {
  const key: Record<string, CellValue> = {}
  for (const name of keys) {
    const idx = columns.findIndex((c) => c.name === name)
    key[name] = (row.original ?? row.values)[idx] ?? null
  }
  return key
}

/** db:applyRowChanges payload plus the row (uid) behind each change, in request order. */
export interface RowChangeBatch {
  changes: RowChange[]
  rowIds: string[]
}

/** Builds the db:applyRowChanges payload. Deletes go first, then updates, then inserts. */
export function buildRowChangeBatch(
  rows: EditableRow[],
  columns: QueryColumn[],
  primaryKey: string[]
): RowChangeBatch {
  const keys = keyColumns(columns, primaryKey)
  type Entry = { change: RowChange; uid: string }
  const deletes: Entry[] = []
  const updates: Entry[] = []
  const inserts: Entry[] = []
  for (const row of rows) {
    if (row.deleted) {
      if (row.original)
        deletes.push({ change: { kind: 'delete', key: keyOf(row, columns, keys) }, uid: row.uid })
      continue
    }
    if (!row.original) {
      const values: Record<string, CellValue> = {}
      for (const col of [...row.touched].sort((a, b) => a - b))
        values[columns[col].name] = row.values[col]
      inserts.push({ change: { kind: 'insert', values }, uid: row.uid })
      continue
    }
    const values: Record<string, CellValue> = {}
    const storage: Record<string, StorageClass> = {}
    row.values.forEach((v, i) => {
      if (!isCellChanged(row, i)) return
      values[columns[i].name] = v
      if (row.storage?.[i]) storage[columns[i].name] = row.storage[i]
    })
    if (Object.keys(values).length)
      updates.push({
        change: {
          kind: 'update',
          key: keyOf(row, columns, keys),
          values,
          // SQLite only: rows of other engines carry no storage classes.
          ...(Object.keys(storage).length ? { storage } : {})
        },
        uid: row.uid
      })
  }
  const all = [...deletes, ...updates, ...inserts]
  return { changes: all.map((e) => e.change), rowIds: all.map((e) => e.uid) }
}

export function buildRowChanges(
  rows: EditableRow[],
  columns: QueryColumn[],
  primaryKey: string[]
): RowChange[] {
  return buildRowChangeBatch(rows, columns, primaryKey).changes
}

/**
 * Local state after a successful apply, without reloading: deleted rows go
 * away and current values become the new originals. `generatedIds` are the
 * AUTO_INCREMENT ids of the inserts in row order; each fills the `idColumn`
 * of its new row when the user left it empty.
 */
export function commitRows(
  rows: EditableRow[],
  generatedIds: (number | string | null)[] = [],
  idColumn: number | null = null
): EditableRow[] {
  let insert = 0
  return rows
    .filter((r) => !r.deleted)
    .map((r) => {
      const values = [...r.values]
      if (!r.original) {
        const id = generatedIds[insert++] ?? null
        if (idColumn !== null && id !== null && values[idColumn] === null) values[idColumn] = id
      }
      return { ...r, original: [...values], values, touched: [], deleted: false }
    })
}

function compareCells(a: CellValue, b: CellValue): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1
  const na = Number(a)
  const nb = Number(b)
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

/** Client-side sort of loaded rows (NULL first); rows added in the UI stay at the end. */
export function sortRows(
  rows: EditableRow[],
  col: number,
  direction: 'ASC' | 'DESC'
): EditableRow[] {
  const sign = direction === 'ASC' ? 1 : -1
  const loaded = rows.filter((r) => r.original)
  const added = rows.filter((r) => !r.original)
  return [...loaded.sort((x, y) => sign * compareCells(x.values[col], y.values[col])), ...added]
}

export function displayCell(value: CellValue): string {
  if (value === null) return '(NULL)'
  if (typeof value === 'boolean') return value ? '1' : '0'
  return String(value)
}
