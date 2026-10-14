import { describe, expect, it } from 'vitest'
import {
  NO_SELECTION,
  clickCell,
  clickColumn,
  clickRow,
  describeRegion,
  dragTo,
  extendBy,
  isSingleCell,
  pruneSelection,
  regionOf,
  rowsForDeletion,
  selectAll,
  singleCell,
  type GridSelection
} from './gridSelection'

const uids = ['a', 'b', 'c', 'd', 'e']
const cell = (uid: string, col: number) => ({ uid, col })

describe('grid selection', () => {
  it('cells: click selects one, Shift+click extends a rectangle from the anchor', () => {
    let sel = clickCell(NO_SELECTION, cell('b', 1))
    expect(isSingleCell(sel)).toBe(true)
    sel = clickCell(sel, cell('d', 3), { shift: true })
    expect(regionOf(sel, uids, 5)).toEqual({ rows: [1, 2, 3], cols: [1, 2, 3] })
    // Backwards ranges are normalised.
    sel = clickCell(sel, cell('a', 0), { shift: true })
    expect(regionOf(sel, uids, 5)).toEqual({ rows: [0, 1], cols: [0, 1] })
    // Shift without a rectangle starts at the active cell.
    expect(
      regionOf(clickCell(NO_SELECTION, cell('c', 2), { shift: true }, cell('a', 2)), uids, 5)
    ).toEqual({
      rows: [0, 1, 2],
      cols: [2]
    })
  })

  it('drag and Shift+arrows move the focus, clamped to the grid', () => {
    let sel = dragTo(cell('b', 1), cell('c', 2))
    expect(regionOf(sel, uids, 3)).toEqual({ rows: [1, 2], cols: [1, 2] })
    sel = extendBy(sel, 5, 5, uids, 3, null)
    expect(regionOf(sel, uids, 3)).toEqual({ rows: [1, 2, 3, 4], cols: [1, 2] })
    sel = extendBy(NO_SELECTION, -1, 0, uids, 3, cell('c', 0))
    expect(regionOf(sel, uids, 3)).toEqual({ rows: [1, 2], cols: [0] })
  })

  it('rows: click, Shift range and Cmd/Ctrl toggle', () => {
    let sel = clickRow(NO_SELECTION, 'b', uids)
    sel = clickRow(sel, 'd', uids, { shift: true })
    expect(regionOf(sel, uids, 2)).toEqual({ rows: [1, 2, 3], cols: [0, 1] })
    sel = clickRow(sel, 'c', uids, { toggle: true })
    expect(rowsForDeletion(sel, null)).toEqual(['b', 'd'])
    sel = clickRow(sel, 'a', uids, { toggle: true })
    expect(rowsForDeletion(sel, null)).toEqual(['b', 'd', 'a'])
    expect(regionOf(sel, uids, 1)?.rows).toEqual([0, 1, 3])
  })

  it('columns: click, Shift range and Cmd/Ctrl toggle', () => {
    let sel = clickColumn(NO_SELECTION, 1)
    sel = clickColumn(sel, 3, { shift: true })
    expect(regionOf(sel, uids, 5)).toEqual({ rows: [0, 1, 2, 3, 4], cols: [1, 2, 3] })
    sel = clickColumn(sel, 2, { toggle: true })
    expect(regionOf(sel, uids, 5)?.cols).toEqual([1, 3])
    sel = clickColumn(clickColumn(NO_SELECTION, 4), 4, { toggle: true })
    expect(sel).toEqual(NO_SELECTION)
  })

  it('SAFETY: column selections and select-all never mark rows for deletion', () => {
    const active = cell('c', 0)
    expect(rowsForDeletion(clickColumn(NO_SELECTION, 0), active)).toEqual([])
    expect(
      rowsForDeletion(clickColumn(clickColumn(NO_SELECTION, 0), 2, { shift: true }), active)
    ).toEqual([])
    expect(rowsForDeletion(selectAll(), active)).toEqual([])
    expect(rowsForDeletion(NO_SELECTION, active)).toEqual([])
    // A rectangle only ever targets the active cell's row (as before), never the whole range.
    expect(rowsForDeletion(dragTo(cell('a', 0), cell('e', 1)), active)).toEqual(['c'])
    expect(rowsForDeletion(singleCell(cell('b', 0)), null)).toEqual(['b'])
    // Rows picked in the gutter are the only multi-row deletion.
    expect(
      rowsForDeletion(
        clickRow(clickRow(NO_SELECTION, 'a', uids), 'c', uids, { shift: true }),
        active
      )
    ).toEqual(['a', 'b', 'c'])
  })

  it('select all covers every row and column; empty grids select nothing', () => {
    expect(regionOf(selectAll(), uids, 2)).toEqual({ rows: [0, 1, 2, 3, 4], cols: [0, 1] })
    expect(pruneSelection(selectAll(), [])).toEqual(NO_SELECTION)
  })

  it('follows rows by uid after a re-sort and drops vanished rows', () => {
    const sel = dragTo(cell('a', 0), cell('b', 0))
    expect(regionOf(sel, ['b', 'x', 'a'], 1)).toEqual({ rows: [0, 1, 2], cols: [0] })
    expect(pruneSelection(sel, ['b'])).toEqual(NO_SELECTION)
    const rows: GridSelection = { kind: 'rows', uids: ['a', 'b'], anchor: 'a' }
    expect(pruneSelection(rows, ['b', 'c'])).toEqual({ kind: 'rows', uids: ['b'], anchor: 'a' })
  })

  it('describes regions', () => {
    expect(describeRegion({ rows: [0], cols: [1] })).toBe('1 celda')
    expect(describeRegion({ rows: [0, 1, 2], cols: [1] })).toBe('3 filas × 1 columna')
  })
})
