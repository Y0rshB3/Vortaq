/**
 * Selection model of the results grid (EditableGrid), kept pure so it can be
 * tested without a DOM. A selection is always a product of rows × columns
 * (what copy and «Exportar selección» read):
 *
 * - `cells`: a rectangle from an anchor to a focus cell (click, Shift+click,
 *   drag, Shift+arrows); rows are found by uid, so it follows the rows when
 *   they are re-sorted;
 * - `rows`: rows picked in the `#` gutter (click, Shift, Cmd/Ctrl), every column;
 * - `columns`: columns picked on their header (click, Shift, Cmd/Ctrl), every row;
 * - `all`: Cmd/Ctrl+A or the `#` corner.
 *
 * Deletion safety: only gutter rows (or the active cell's row, as before)
 * are rows «Eliminar» may delete; a column selection or «Seleccionar todo»
 * never marks a row for deletion (rowsForDeletion).
 */

export interface CellRef {
  uid: string
  col: number
}

export type GridSelection =
  | { kind: 'none' }
  | { kind: 'cells'; anchor: CellRef; focus: CellRef }
  | { kind: 'rows'; uids: string[]; anchor: string }
  | { kind: 'columns'; cols: number[]; anchor: number }
  | { kind: 'all' }

/** Shift extends from the anchor; toggle (Cmd/Ctrl) adds or removes one item. */
export interface Modifiers {
  shift?: boolean
  toggle?: boolean
}

/** The selected rows and columns, as indexes in display order. */
export interface GridRegion {
  rows: number[]
  cols: number[]
}

/** Rows (by uid) and column indexes of a selection, kept while a dialog is open. */
export interface GridSelectionSnapshot {
  rowUids: string[]
  cols: number[]
}

export const NO_SELECTION: GridSelection = { kind: 'none' }

const range = (a: number, b: number): number[] => {
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
}

export function singleCell(cell: CellRef): GridSelection {
  return { kind: 'cells', anchor: cell, focus: cell }
}

/** Click on a cell; Shift extends the rectangle from the anchor (or from the active cell). */
export function clickCell(
  sel: GridSelection,
  cell: CellRef,
  mods: Modifiers = {},
  active: CellRef | null = null
): GridSelection {
  if (mods.shift) {
    const anchor = sel.kind === 'cells' ? sel.anchor : active
    if (anchor) return { kind: 'cells', anchor, focus: cell }
  }
  return singleCell(cell)
}

/** Drag from `start` to `cell`. */
export function dragTo(start: CellRef, cell: CellRef): GridSelection {
  return { kind: 'cells', anchor: start, focus: cell }
}

/** Click on a row number. `uids` is the display order. */
export function clickRow(
  sel: GridSelection,
  uid: string,
  uids: readonly string[],
  mods: Modifiers = {}
): GridSelection {
  if (mods.shift && sel.kind === 'rows') {
    const a = uids.indexOf(sel.anchor)
    const b = uids.indexOf(uid)
    if (a >= 0 && b >= 0)
      return { kind: 'rows', uids: range(a, b).map((i) => uids[i]), anchor: sel.anchor }
  }
  if (mods.toggle && sel.kind === 'rows') {
    const next = sel.uids.includes(uid) ? sel.uids.filter((u) => u !== uid) : [...sel.uids, uid]
    return next.length ? { kind: 'rows', uids: next, anchor: uid } : NO_SELECTION
  }
  return { kind: 'rows', uids: [uid], anchor: uid }
}

/** Click on a column header. */
export function clickColumn(sel: GridSelection, col: number, mods: Modifiers = {}): GridSelection {
  if (mods.shift && sel.kind === 'columns')
    return { kind: 'columns', cols: range(sel.anchor, col), anchor: sel.anchor }
  if (mods.toggle && sel.kind === 'columns') {
    const next = sel.cols.includes(col) ? sel.cols.filter((c) => c !== col) : [...sel.cols, col]
    return next.length ? { kind: 'columns', cols: next, anchor: col } : NO_SELECTION
  }
  return { kind: 'columns', cols: [col], anchor: col }
}

export function selectAll(): GridSelection {
  return { kind: 'all' }
}

/**
 * Shift+arrow: moves the focus of the rectangle (starting at the active cell
 * when the selection is not a rectangle), clamped to the grid.
 */
export function extendBy(
  sel: GridSelection,
  dRow: number,
  dCol: number,
  uids: readonly string[],
  colCount: number,
  active: CellRef | null
): GridSelection {
  const base: { anchor: CellRef; focus: CellRef } | null =
    sel.kind === 'cells' ? sel : active ? { anchor: active, focus: active } : null
  if (!base || !uids.length || colCount < 1) return sel
  const index = uids.indexOf(base.focus.uid)
  if (index < 0) return sel
  const row = Math.min(Math.max(index + dRow, 0), uids.length - 1)
  const col = Math.min(Math.max(base.focus.col + dCol, 0), colCount - 1)
  return { kind: 'cells', anchor: base.anchor, focus: { uid: uids[row], col } }
}

/** The selected rows × columns in display order, or null when nothing is selected. */
export function regionOf(
  sel: GridSelection,
  uids: readonly string[],
  colCount: number
): GridRegion | null {
  const allRows = (): number[] => uids.map((_, i) => i)
  const allCols = (): number[] => Array.from({ length: colCount }, (_, i) => i)
  switch (sel.kind) {
    case 'none':
      return null
    case 'all':
      return { rows: allRows(), cols: allCols() }
    case 'columns': {
      const cols = sel.cols.filter((c) => c >= 0 && c < colCount).sort((a, b) => a - b)
      return cols.length ? { rows: allRows(), cols } : null
    }
    case 'rows': {
      const wanted = new Set(sel.uids)
      const rows = allRows().filter((i) => wanted.has(uids[i]))
      return rows.length ? { rows, cols: allCols() } : null
    }
    case 'cells': {
      const a = uids.indexOf(sel.anchor.uid)
      const b = uids.indexOf(sel.focus.uid)
      if (a < 0 || b < 0 || colCount < 1) return null
      const clamp = (c: number): number => Math.min(Math.max(c, 0), colCount - 1)
      return { rows: range(a, b), cols: range(clamp(sel.anchor.col), clamp(sel.focus.col)) }
    }
  }
}

/** True for a rectangle of exactly one cell (the plain active cell). */
export function isSingleCell(sel: GridSelection): boolean {
  return (
    sel.kind === 'cells' && sel.anchor.uid === sel.focus.uid && sel.anchor.col === sel.focus.col
  )
}

/**
 * Rows the row actions («Eliminar») work on: the rows picked in the gutter,
 * or the row of the active cell. Never every row: a column selection and
 * «Seleccionar todo» give none.
 */
export function rowsForDeletion(sel: GridSelection, active: CellRef | null): string[] {
  if (sel.kind === 'rows') return [...sel.uids]
  if (sel.kind === 'cells') return [(active ?? sel.anchor).uid]
  return []
}

/** Drops references to rows that are gone (new page, discarded rows). */
export function pruneSelection(sel: GridSelection, uids: readonly string[]): GridSelection {
  const present = new Set(uids)
  if (sel.kind === 'cells')
    return present.has(sel.anchor.uid) && present.has(sel.focus.uid) ? sel : NO_SELECTION
  if (sel.kind === 'rows') {
    const kept = sel.uids.filter((u) => present.has(u))
    if (!kept.length) return NO_SELECTION
    return kept.length === sel.uids.length ? sel : { ...sel, uids: kept }
  }
  if (sel.kind === 'all' && !uids.length) return NO_SELECTION
  return sel
}

/** «3 filas × 2 columnas», «1 celda»… for menus and the export dialog. */
export function describeRegion(region: GridRegion): string {
  const r = region.rows.length
  const c = region.cols.length
  if (r === 1 && c === 1) return '1 celda'
  return `${r} ${r === 1 ? 'fila' : 'filas'} × ${c} ${c === 1 ? 'columna' : 'columnas'}`
}
