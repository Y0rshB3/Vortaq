import type { ModelColumn, ModelTable, SchemaModel } from './model'

/**
 * Box sizes and the automatic arrangement of the relationship diagram. The
 * canvas renders each table box at exactly these sizes, so the layout, the
 * relationship lines and the exported image agree.
 */
export const HEADER_H = 30
export const ROW_H = 22
export const BOX_PAD_B = 6
export const MIN_W = 170
export const MAX_W = 340
/** Approximate advance of the 12px UI font and the 11px mono font. */
const NAME_CHAR_W = 7
const TYPE_CHAR_W = 6.6
const TYPE_MAX_CHARS = 18

export interface Point {
  x: number
  y: number
}
export interface Size {
  w: number
  h: number
}
export type Positions = Record<string, Point>

/** Type text shown in a box: lower case, long ENUM/SET lists cut. */
export function shortType(type: string): string {
  const t = type.trim()
  return t.length > TYPE_MAX_CHARS ? `${t.slice(0, TYPE_MAX_CHARS - 1)}…` : t
}

/** Columns a box shows: all of them, or only key columns in «Solo claves». */
export function visibleColumns(table: ModelTable, keysOnly: boolean): ModelColumn[] {
  return keysOnly ? table.columns.filter((c) => c.primaryKey || c.foreignKey) : table.columns
}

/** `extraW`: room for the query builder's join handle on each row. */
export function tableSize(table: ModelTable, keysOnly: boolean, extraW = 0): Size {
  const columns = visibleColumns(table, keysOnly)
  const header = 44 + table.name.length * (NAME_CHAR_W + 0.6)
  const rows = columns.reduce(
    (w, c) =>
      Math.max(w, 48 + c.name.length * NAME_CHAR_W + shortType(c.type).length * TYPE_CHAR_W),
    0
  )
  return {
    w: Math.round(Math.min(MAX_W, Math.max(MIN_W, header, rows)) + extraW),
    h: HEADER_H + columns.length * ROW_H + BOX_PAD_B
  }
}

export function tableSizes(
  model: Pick<SchemaModel, 'tables'>,
  keysOnly: boolean,
  extraW = 0
): Record<string, Size> {
  return Object.fromEntries(model.tables.map((t) => [t.name, tableSize(t, keysOnly, extraW)]))
}

const GAP_X = 96
const GAP_Y = 36
const BLOCK_GAP = 120
const ROW_MAX_W = 2800
const SWEEPS = 4

interface Block {
  w: number
  h: number
  /** Positions relative to the block's top-left corner. */
  at: Positions
}

/** Related tables in layers: referenced tables to the left of the tables that point at them. */
function layeredBlock(
  names: string[],
  out: Map<string, Set<string>>,
  sizes: Record<string, Size>
): Block {
  const layer = new Map<string, number>()
  const state = new Map<string, 'open' | 'done'>()
  // Longest path to a table that references nothing in the group; edges closing a cycle are ignored.
  const visit = (t: string): number => {
    if (state.get(t) === 'done') return layer.get(t)!
    if (state.get(t) === 'open') return -1
    state.set(t, 'open')
    let l = 0
    for (const to of out.get(t) ?? []) {
      const d = visit(to)
      if (d >= 0) l = Math.max(l, d + 1)
    }
    state.set(t, 'done')
    layer.set(t, l)
    return l
  }
  for (const t of names) visit(t)

  const layers: string[][] = []
  for (const t of names) (layers[layer.get(t)!] ??= []).push(t)
  const degrees = new Map(names.map((t) => [t, out.get(t)?.size ?? 0]))
  for (const t of names)
    for (const to of out.get(t) ?? []) degrees.set(to, (degrees.get(to) ?? 0) + 1)
  const degree = (t: string): number => degrees.get(t) ?? 0
  for (const l of layers) l.sort((a, b) => degree(b) - degree(a) || a.localeCompare(b))

  // Barycenter sweeps: each table moves towards the tables it relates to in the next layer.
  const linked = (a: string, b: string): boolean => !!out.get(a)?.has(b) || !!out.get(b)?.has(a)
  const reorder = (l: number, ref: string[]): void => {
    const pos = new Map(ref.map((t, i) => [t, i]))
    const bary = new Map(
      layers[l].map((t, i) => {
        const ns = ref.filter((r) => linked(t, r)).map((r) => pos.get(r)!)
        return [t, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i]
      })
    )
    layers[l].sort((a, b) => bary.get(a)! - bary.get(b)!)
  }
  for (let s = 0; s < SWEEPS; s++) {
    for (let l = 1; l < layers.length; l++) reorder(l, layers[l - 1])
    for (let l = layers.length - 2; l >= 0; l--) reorder(l, layers[l + 1])
  }

  const heights = layers.map((l) => l.reduce((h, t) => h + sizes[t].h, 0) + GAP_Y * (l.length - 1))
  const tallest = Math.max(...heights)
  const at: Positions = {}
  let x = 0
  layers.forEach((l, i) => {
    let y = Math.round((tallest - heights[i]) / 2)
    for (const t of l) {
      at[t] = { x, y }
      y += sizes[t].h + GAP_Y
    }
    x += Math.max(...l.map((t) => sizes[t].w)) + GAP_X
  })
  return { w: x - GAP_X, h: tallest, at }
}

/** Tables without relations, in rows (shelf packing by name). */
function gridBlock(names: string[], sizes: Record<string, Size>): Block {
  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  const perRow = Math.max(1, Math.ceil(Math.sqrt(sorted.length * 1.6)))
  const at: Positions = {}
  let y = 0
  let w = 0
  for (let i = 0; i < sorted.length; i += perRow) {
    const row = sorted.slice(i, i + perRow)
    let x = 0
    for (const t of row) {
      at[t] = { x, y }
      x += sizes[t].w + GAP_Y
    }
    w = Math.max(w, x - GAP_Y)
    y += Math.max(...row.map((t) => sizes[t].h)) + GAP_Y
  }
  return { w, h: Math.max(0, y - GAP_Y), at }
}

/**
 * Arranges every table: each group of related tables in layers, the groups
 * and then the unrelated tables packed in rows. Deterministic for a model.
 */
export function autoLayout(model: SchemaModel, sizes: Record<string, Size>): Positions {
  const names = model.tables.map((t) => t.name)
  const out = new Map<string, Set<string>>(names.map((n) => [n, new Set()]))
  const undirected = new Map<string, Set<string>>(names.map((n) => [n, new Set()]))
  for (const r of model.relations) {
    if (r.from === r.to || !out.has(r.from) || !out.has(r.to)) continue
    out.get(r.from)!.add(r.to)
    undirected.get(r.from)!.add(r.to)
    undirected.get(r.to)!.add(r.from)
  }
  const seen = new Set<string>()
  const groups: string[][] = []
  const lonely: string[] = []
  for (const n of names) {
    if (seen.has(n)) continue
    const group: string[] = []
    const queue = [n]
    seen.add(n)
    while (queue.length) {
      const t = queue.shift()!
      group.push(t)
      for (const o of undirected.get(t)!)
        if (!seen.has(o)) {
          seen.add(o)
          queue.push(o)
        }
    }
    if (group.length > 1) groups.push(group)
    else lonely.push(n)
  }
  groups.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))
  const blocks = groups.map((g) => layeredBlock(g, out, sizes))
  if (lonely.length) blocks.push(gridBlock(lonely, sizes))

  const positions: Positions = {}
  let cx = 0
  let cy = 0
  let rowH = 0
  for (const b of blocks) {
    if (cx > 0 && cx + b.w > ROW_MAX_W) {
      cx = 0
      cy += rowH + BLOCK_GAP
      rowH = 0
    }
    for (const [t, p] of Object.entries(b.at)) positions[t] = { x: cx + p.x, y: cy + p.y }
    cx += b.w + BLOCK_GAP
    rowH = Math.max(rowH, b.h)
  }
  return positions
}

/** Bounding box of the placed tables (0×0 when there are none). */
export function contentBounds(
  positions: Positions,
  sizes: Record<string, Size>
): { x: number; y: number; w: number; h: number } {
  const keys = Object.keys(positions).filter((k) => sizes[k])
  if (!keys.length) return { x: 0, y: 0, w: 0, h: 0 }
  const x = Math.min(...keys.map((k) => positions[k].x))
  const y = Math.min(...keys.map((k) => positions[k].y))
  const r = Math.max(...keys.map((k) => positions[k].x + sizes[k].w))
  const b = Math.max(...keys.map((k) => positions[k].y + sizes[k].h))
  return { x, y, w: r - x, h: b - y }
}

/** Positions for tables that have none yet (new tables after a refresh), right of the rest. */
export function placeMissing(
  model: Pick<SchemaModel, 'tables'>,
  positions: Positions,
  sizes: Record<string, Size>
): Positions {
  const missing = model.tables.filter((t) => !positions[t.name]).map((t) => t.name)
  if (!missing.length) return positions
  const bounds = contentBounds(positions, sizes)
  const block = gridBlock(missing, sizes)
  const x0 = bounds.w ? bounds.x + bounds.w + BLOCK_GAP : 0
  const next = { ...positions }
  for (const [t, p] of Object.entries(block.at)) next[t] = { x: x0 + p.x, y: bounds.y + p.y }
  return next
}
