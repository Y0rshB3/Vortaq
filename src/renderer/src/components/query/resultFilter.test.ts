import { describe, expect, it } from 'vitest'
import type { EditableRow } from '@renderer/components/data/rowEditing'
import { filterRows } from './resultFilter'

const row = (uid: string, values: unknown[], added = false): EditableRow =>
  ({ uid, original: added ? null : values, values, touched: [], deleted: false }) as EditableRow

describe('«Filtrar» of a result', () => {
  const rows = [
    row('a', [1, 'Ana', null]),
    row('b', [2, 'Luis', '{"ciudad":"Madrid"}']),
    row('c', [3n, 'ana maría', true]),
    row('n', [null, '', null], true)
  ]

  it('keeps the rows with the text in any cell, any case, and the rows being added', () => {
    expect(filterRows(rows, 'ANA').map((r) => r.uid)).toEqual(['a', 'c', 'n'])
    expect(filterRows(rows, 'madrid').map((r) => r.uid)).toEqual(['b', 'n'])
    expect(filterRows(rows, '3').map((r) => r.uid)).toEqual(['c', 'n'])
    expect(filterRows(rows, 'true').map((r) => r.uid)).toEqual(['c', 'n'])
    expect(filterRows(rows, 'null').map((r) => r.uid)).toEqual(['n'])
  })

  it('shows everything without a filter', () => {
    expect(filterRows(rows, '   ')).toHaveLength(4)
  })
})
