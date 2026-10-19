import { HEADER_H, ROW_H, visibleColumns, type Positions, type Size } from './layout'
import type { ModelRelation, ModelTable } from './model'

/**
 * Geometry of a relationship line: from the referencing column's row (the
 * «many» end, drawn with a crow's foot) to the referenced column's row (the
 * «one» end). Rows hidden by «Solo claves» anchor at the header.
 */
export interface EdgeGeometry {
  relation: ModelRelation
  path: string
  /** Where the label/hit area sits (the curve's middle). */
  mid: { x: number; y: number }
}

const MIN_BEND = 40
const CLEARANCE = 20
const LOOP = 46

/** Vertical centre of a column's row in a placed box (the header when the row is hidden). */
export function rowY(table: ModelTable, column: string, keysOnly: boolean, top: number): number {
  const i = visibleColumns(table, keysOnly).findIndex(
    (c) => c.name.toLowerCase() === column.toLowerCase()
  )
  return i < 0 ? top + HEADER_H / 2 : top + HEADER_H + i * ROW_H + ROW_H / 2
}

export function edgeGeometry(
  relation: ModelRelation,
  tables: ReadonlyMap<string, ModelTable>,
  positions: Positions,
  sizes: Record<string, Size>,
  keysOnly: boolean
): EdgeGeometry | null {
  const a = tables.get(relation.from)
  const b = tables.get(relation.to)
  const pa = positions[relation.from]
  const pb = positions[relation.to]
  const sa = sizes[relation.from]
  const sb = sizes[relation.to]
  if (!a || !b || !pa || !pb || !sa || !sb) return null
  const y1 = rowY(a, relation.fromColumns[0], keysOnly, pa.y)
  const y2 = rowY(b, relation.toColumns[0], keysOnly, pb.y)
  const round = (n: number): number => Math.round(n * 10) / 10

  if (relation.from === relation.to) {
    const x = pa.x + sa.w
    return {
      relation,
      path: `M ${x} ${round(y1)} C ${x + LOOP} ${round(y1)}, ${x + LOOP} ${round(y2)}, ${x} ${round(y2)}`,
      mid: { x: x + LOOP * 0.75, y: round((y1 + y2) / 2) }
    }
  }
  let x1: number
  let x2: number
  let d1: number
  let d2: number
  if (pa.x + sa.w + CLEARANCE <= pb.x) {
    // Referencing table on the left: leave by its right side, enter by the left.
    ;[x1, d1, x2, d2] = [pa.x + sa.w, 1, pb.x, -1]
  } else if (pb.x + sb.w + CLEARANCE <= pa.x) {
    ;[x1, d1, x2, d2] = [pa.x, -1, pb.x + sb.w, 1]
  } else {
    // Stacked boxes: both ends on the right, the curve loops outside them.
    ;[x1, d1, x2, d2] = [pa.x + sa.w, 1, pb.x + sb.w, 1]
  }
  let c1: number
  let c2: number
  if (d1 === d2) {
    c1 = c2 = Math.max(x1, x2) + LOOP
  } else {
    const bend = Math.max(MIN_BEND, Math.abs(x2 - x1) / 2)
    c1 = x1 + d1 * bend
    c2 = x2 + d2 * bend
  }
  return {
    relation,
    path: `M ${x1} ${round(y1)} C ${round(c1)} ${round(y1)}, ${round(c2)} ${round(y2)}, ${x2} ${round(y2)}`,
    // Bézier at t = 0.5.
    mid: {
      x: round((x1 + 3 * c1 + 3 * c2 + x2) / 8),
      y: round((y1 + 3 * y1 + 3 * y2 + y2) / 8)
    }
  }
}

export function edgeGeometries(
  relations: readonly ModelRelation[],
  tables: readonly ModelTable[],
  positions: Positions,
  sizes: Record<string, Size>,
  keysOnly: boolean
): EdgeGeometry[] {
  const byName = new Map(tables.map((t) => [t.name, t]))
  return relations.flatMap((r) => edgeGeometry(r, byName, positions, sizes, keysOnly) ?? [])
}
