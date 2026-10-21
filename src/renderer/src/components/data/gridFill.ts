/**
 * Editing several cells at once (EditableGrid): with a range or whole columns
 * selected, the value typed or picked in one cell is staged in every selected
 * cell that can take it. Kept pure so the rules are tested without a DOM.
 *
 * - Locked columns and deleted rows are left out of the targets (they are
 *   dimmed or struck through, so nothing changes where nothing looks editable).
 * - Each column checks the value as its own editor would: a date/time column
 *   takes it normalised to its literal, an ENUM column only one of its values,
 *   NULL only a nullable column; a primary key is never set to one value in
 *   several rows. Cells that refuse it are skipped and reported.
 */
import type { CellValue } from '@shared/types'
import { matchEnumOption } from './enumValues'
import type { CellRef, GridRegion } from './gridSelection'
import { displayCell, type EditableRow } from './rowEditing'
import { normalizeTemporal, type TemporalSpec } from './temporal'

/** What a column accepts, as its cell editor sees it. */
export interface FillColumn {
  name: string
  temporal: TemporalSpec | null
  options: readonly string[] | null
  nullable: boolean
  primaryKey: boolean
}

export interface FillEdit {
  uid: string
  col: number
  value: string | null
}

export interface FillPlan {
  edits: FillEdit[]
  /** Why cells were left as they were, one entry per reason. */
  skipped: { reason: string; count: number }[]
}

/** The cells of a region (display order) that `editable` accepts. */
export function regionCells(
  region: GridRegion,
  rows: readonly EditableRow[],
  editable: (row: EditableRow, col: number) => boolean
): CellRef[] {
  const cells: CellRef[] = []
  for (const index of region.rows) {
    const row = rows[index]
    if (!row) continue
    for (const col of region.cols) if (editable(row, col)) cells.push({ uid: row.uid, col })
  }
  return cells
}

type Check = { ok: true; value: string | null } | { ok: false; reason: string }

/** The value a column stores for `value`, or why it refuses it. */
export function fillValue(value: string | null, column: FillColumn, severalRows: boolean): Check {
  if (column.primaryKey && severalRows)
    return { ok: false, reason: `«${column.name}» es clave primaria y no puede repetirse` }
  if (value === null)
    return column.nullable
      ? { ok: true, value }
      : { ok: false, reason: `«${column.name}» no admite NULL` }
  if (column.temporal) {
    const result = normalizeTemporal(value, column.temporal)
    return result.ok
      ? { ok: true, value: result.text }
      : { ok: false, reason: `«${value}» no es válido en «${column.name}»` }
  }
  if (column.options) {
    const match = matchEnumOption(column.options, value)
    return match === null
      ? { ok: false, reason: `«${value}» no está en la lista de «${column.name}»` }
      : { ok: true, value: match }
  }
  return { ok: true, value }
}

const sameCell = (current: CellValue, value: string | null): boolean =>
  value === null ? current === null : current !== null && displayCell(current) === value

/**
 * Edits that write `valueFor(col)` into `targets` (unchanged cells dropped)
 * and the cells each column refused.
 */
export function planFill(
  targets: readonly CellRef[],
  rows: readonly EditableRow[],
  columns: readonly FillColumn[],
  valueFor: (col: number) => string | null
): FillPlan {
  const byUid = new Map(rows.map((r) => [r.uid, r]))
  const severalRows = new Set(targets.map((t) => t.uid)).size > 1
  const edits: FillEdit[] = []
  const skipped = new Map<string, number>()
  for (const { uid, col } of targets) {
    const row = byUid.get(uid)
    const column = columns[col]
    if (!row || !column) continue
    const check = fillValue(valueFor(col), column, severalRows)
    if (!check.ok) {
      skipped.set(check.reason, (skipped.get(check.reason) ?? 0) + 1)
      continue
    }
    if (!sameCell(row.values[col], check.value)) edits.push({ uid, col, value: check.value })
  }
  return { edits, skipped: [...skipped].map(([reason, count]) => ({ reason, count })) }
}

const cells = (n: number): string => `${n} ${n === 1 ? 'celda' : 'celdas'}`

/** Warning after a fill that skipped cells; null when every target took the value. */
export function skippedMessage(plan: FillPlan): string | null {
  if (!plan.skipped.length) return null
  const total = plan.skipped.reduce((n, s) => n + s.count, 0)
  const reasons = plan.skipped.map((s) => s.reason).join('; ')
  return plan.edits.length
    ? `${plan.edits.length === 1 ? 'Se cambió' : 'Se cambiaron'} ${cells(plan.edits.length)}; ${cells(total)} no: ${reasons}.`
    : `No se cambió ninguna celda: ${reasons}.`
}
