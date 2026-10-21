import { describe, expect, it } from 'vitest'
import { fillValue, planFill, regionCells, skippedMessage, type FillColumn } from './gridFill'
import { rowsFromPage } from './rowEditing'

const text = (name: string, extra: Partial<FillColumn> = {}): FillColumn => ({
  name,
  temporal: null,
  options: null,
  nullable: true,
  primaryKey: false,
  ...extra
})

describe('regionCells', () => {
  it('lists the region by row, leaving out what editable refuses', () => {
    const rows = rowsFromPage([
      [1, 'a', 'x'],
      [2, 'b', 'y'],
      [3, 'c', 'z']
    ])
    rows[1].deleted = true
    const cells = regionCells({ rows: [0, 1, 2], cols: [1, 2] }, rows, (row, col) => {
      return !row.deleted && col !== 2
    })
    expect(cells).toEqual([
      { uid: rows[0].uid, col: 1 },
      { uid: rows[2].uid, col: 1 }
    ])
  })
})

describe('fillValue', () => {
  it('normalises a date or time for its column, and refuses text that is none', () => {
    const born = text('born', { temporal: { kind: 'date', fsp: 0 } })
    const ends = text('ends', { temporal: { kind: 'datetime', fsp: 0 } })
    expect(fillValue('2026-10-21', born, true)).toEqual({ ok: true, value: '2026-10-21' })
    expect(fillValue('2026-10-21', ends, true)).toEqual({ ok: true, value: '2026-10-21 00:00:00' })
    expect(fillValue('H', born, true)).toEqual({ ok: false, reason: '«H» no es válido en «born»' })
  })

  it('takes one of the ENUM values, matched like MySQL (case only when one fits)', () => {
    const status = text('status', { options: ['Active', 'Archived'] })
    expect(fillValue('archived', status, true)).toEqual({ ok: true, value: 'Archived' })
    expect(fillValue('Ac', status, true)).toEqual({
      ok: false,
      reason: '«Ac» no está en la lista de «status»'
    })
  })

  it('NULL only where the column allows it', () => {
    expect(fillValue(null, text('note'), true)).toEqual({ ok: true, value: null })
    expect(fillValue(null, text('name', { nullable: false }), true)).toEqual({
      ok: false,
      reason: '«name» no admite NULL'
    })
  })

  it('SAFETY: never one primary key value in several rows; one row may change its key', () => {
    const id = text('id', { primaryKey: true, nullable: false })
    expect(fillValue('5', id, true)).toEqual({
      ok: false,
      reason: '«id» es clave primaria y no puede repetirse'
    })
    expect(fillValue('5', id, false)).toEqual({ ok: true, value: '5' })
  })

  it('other columns take the text as typed', () => {
    expect(fillValue('', text('note'), true)).toEqual({ ok: true, value: '' })
  })
})

describe('planFill', () => {
  const rows = rowsFromPage([
    [1, 'US', '2026-01-01'],
    [2, 'CA', null],
    [3, 'US', '2026-01-02']
  ])
  const columns = [
    text('id', { primaryKey: true, nullable: false }),
    text('country'),
    text('born', { temporal: { kind: 'date', fsp: 0 } })
  ]
  const all = rows.flatMap((r) => [0, 1, 2].map((col) => ({ uid: r.uid, col })))

  it('stages the value where it differs and counts what each column refused', () => {
    const plan = planFill(all, rows, columns, () => 'US')
    expect(plan.edits).toEqual([{ uid: rows[1].uid, col: 1, value: 'US' }])
    expect(plan.skipped).toEqual([
      { reason: '«id» es clave primaria y no puede repetirse', count: 3 },
      { reason: '«US» no es válido en «born»', count: 3 }
    ])
    expect(skippedMessage(plan)).toBe(
      'Se cambió 1 celda; 6 celdas no: «id» es clave primaria y no puede repetirse; «US» no es válido en «born».'
    )
  })

  it('a value per column (the picked foreign key), normalised for each', () => {
    const targets = [rows[0], rows[1]].flatMap((r) => [
      { uid: r.uid, col: 1 },
      { uid: r.uid, col: 2 }
    ])
    const plan = planFill(targets, rows, columns, (col) => (col === 1 ? 'MX' : '2026-1-2'))
    expect(plan.edits).toEqual([
      { uid: rows[0].uid, col: 1, value: 'MX' },
      { uid: rows[0].uid, col: 2, value: '2026-01-02' },
      { uid: rows[1].uid, col: 1, value: 'MX' },
      { uid: rows[1].uid, col: 2, value: '2026-01-02' }
    ])
    expect(skippedMessage(plan)).toBeNull()
  })

  it('says when nothing changed', () => {
    const plan = planFill([{ uid: rows[0].uid, col: 2 }], rows, columns, () => 'x')
    expect(plan.edits).toEqual([])
    expect(skippedMessage(plan)).toBe('No se cambió ninguna celda: «x» no es válido en «born».')
  })
})
