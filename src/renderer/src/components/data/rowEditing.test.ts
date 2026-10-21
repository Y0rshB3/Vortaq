import { describe, expect, it } from 'vitest'
import type { QueryColumn } from '@shared/types'
import {
  buildRowChangeBatch,
  buildRowChanges,
  commitRows,
  isLockedCell,
  isRowChanged,
  pendingCount,
  newRow,
  rowsFromPage,
  sameValue,
  setCell,
  sortRows
} from './rowEditing'

const columns: QueryColumn[] = [
  { name: 'a', type: 'LONG' },
  { name: 'b', type: 'VAR_STRING' }
]

describe('rowEditing', () => {
  it('treats numeric and textual values as equal when they print the same', () => {
    expect(sameValue(5, '5')).toBe(true)
    expect(sameValue(null, '')).toBe(false)
    expect(sameValue(true, 1)).toBe(true)
  })

  it('uses every column as key when the table has no primary key', () => {
    const [row] = rowsFromPage([[1, 'x']])
    setCell(row, 1, 'y')
    expect(buildRowChanges([row], columns, [])).toEqual([
      { kind: 'update', key: { a: 1, b: 'x' }, values: { b: 'y' } }
    ])
  })

  it('ignores edits that restore the original value and drops removed new rows', () => {
    const [row] = rowsFromPage([[1, 'x']])
    setCell(row, 1, 'x')
    expect(isRowChanged(row)).toBe(false)
    const added = newRow(2)
    added.deleted = true
    expect(buildRowChanges([row, added], columns, ['a'])).toEqual([])
  })

  it('sends explicit NULLs in inserts only for touched columns', () => {
    const added = newRow(2)
    setCell(added, 1, null)
    expect(buildRowChanges([added], columns, ['a'])).toEqual([
      { kind: 'insert', values: { b: null } }
    ])
  })

  it('commits applied edits locally: deletes removed, inserts kept with their generated id', () => {
    const [kept, gone] = rowsFromPage([
      [1, 'x'],
      [2, 'y']
    ])
    setCell(kept, 1, 'z')
    gone.deleted = true
    const added = newRow(2)
    setCell(added, 1, 'nuevo')
    const typedKey = newRow(2)
    setCell(typedKey, 0, '9')
    const out = commitRows([kept, gone, added, typedKey], [41, 42], 0)
    expect(out.map((r) => r.values)).toEqual([
      [1, 'z'],
      [41, 'nuevo'],
      ['9', null]
    ])
    expect(pendingCount(out)).toBe(0)
    expect(out.every((r) => r.original && r.touched.length === 0)).toBe(true)
  })

  it('sorts loaded rows client-side, numbers numerically and NULL first, new rows last', () => {
    const rows = rowsFromPage([
      [10, 'b'],
      [9, null],
      [100, 'a']
    ])
    const added = newRow(2)
    const asc = sortRows([...rows, added], 0, 'ASC')
    expect(asc.map((r) => r.values[0])).toEqual([9, 10, 100, null])
    const desc = sortRows([...rows, added], 1, 'DESC')
    expect(desc.map((r) => r.values[1])).toEqual(['b', 'a', null, null])
    expect(desc.at(-1)).toBe(added)
  })

  it('reports the row behind each change, in request order', () => {
    const rows = rowsFromPage([
      [1, 'x'],
      [2, 'y']
    ])
    setCell(rows[0], 1, 'x2')
    rows[1].deleted = true
    const added = newRow(2)
    setCell(added, 1, 'z')
    const batch = buildRowChangeBatch([...rows, added], columns, ['a'])
    expect(batch.changes.map((c) => c.kind)).toEqual(['delete', 'update', 'insert'])
    expect(batch.rowIds).toEqual([rows[1].uid, rows[0].uid, added.uid])
  })

  it('locks columns on loaded rows; a new row may still set its rowid', () => {
    const [loaded] = rowsFromPage([[1, 'x']])
    const added = newRow(2)
    const rowid: QueryColumn = { name: 'rowid', type: 'INTEGER', locked: 'rowid' }
    const other: QueryColumn = { name: 't', type: 'TEXT', locked: 'columna de otra tabla (o)' }
    expect(isLockedCell(rowid, loaded)).toBe(true)
    expect(isLockedCell(rowid, added)).toBe(false)
    expect(isLockedCell(other, loaded)).toBe(true)
    expect(isLockedCell(other, added)).toBe(true)
    expect(isLockedCell(columns[0], loaded)).toBe(false)
    expect(isLockedCell(undefined, loaded)).toBe(false)
  })
})
