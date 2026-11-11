import type { EditableRow } from '@renderer/components/data/rowEditing'

/** Text of a cell for «Filtrar» (null never matches). */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/**
 * «Filtrar» of a result: the loaded rows with the text in any cell (any case),
 * plus the rows added in the grid (so a new row never vanishes while typing).
 * Only what is shown changes: edits, selection and Aplicar follow rows by uid.
 */
export function filterRows(rows: readonly EditableRow[], text: string): EditableRow[] {
  const q = text.trim().toLowerCase()
  if (!q) return [...rows]
  return rows.filter(
    (r) => r.original === null || r.values.some((v) => cellText(v).toLowerCase().includes(q))
  )
}
