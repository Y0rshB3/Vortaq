import { describe, expect, it } from 'vitest'
import {
  addHistoryEntry,
  historySummary,
  historyTitle,
  MAX_HISTORY_SQL,
  normalizeHistory,
  runOutcome,
  searchHistory,
  type NewHistoryEntry
} from './queryHistory'

const run = (sql: string, over: Partial<NewHistoryEntry> = {}): NewHistoryEntry => ({
  sql,
  connectionId: 'c1',
  connectionName: 'Tienda',
  engine: 'sqlserver',
  database: 'ventas',
  at: '2026-11-11T05:00:00.000Z',
  durationMs: 35,
  statements: 1,
  rows: 12,
  ok: true,
  ...over
})

describe('query history', () => {
  it('keeps the newest first, one entry per query and place, up to the limit', () => {
    let list = addHistoryEntry([], run('SELECT 1'))
    list = addHistoryEntry(list, run('SELECT 2'))
    list = addHistoryEntry(list, run('  SELECT 1  ', { durationMs: 9 }))
    expect(list.map((e) => [e.sql, e.durationMs])).toEqual([
      ['SELECT 1', 9],
      ['SELECT 2', 35]
    ])
    // Same SQL elsewhere is another entry.
    list = addHistoryEntry(list, run('SELECT 1', { database: 'otra' }))
    expect(list).toHaveLength(3)
    expect(addHistoryEntry(list, run('   '))).toHaveLength(3)
    let many: ReturnType<typeof addHistoryEntry> = []
    for (let i = 0; i < 8; i++) many = addHistoryEntry(many, run(`SELECT ${i}`), 5)
    expect(many.map((e) => e.sql)).toEqual([
      'SELECT 7',
      'SELECT 6',
      'SELECT 5',
      'SELECT 4',
      'SELECT 3'
    ])
  })

  it('cuts very long scripts and marks them', () => {
    const [e] = addHistoryEntry([], run(`SELECT '${'x'.repeat(MAX_HISTORY_SQL)}'`))
    expect(e.sql).toHaveLength(MAX_HISTORY_SQL)
    expect(e.truncated).toBe(true)
  })

  it('searches every word in the SQL, the connection and the database, optionally by connection', () => {
    let list = addHistoryEntry([], run('SELECT * FROM clientes WHERE ciudad = 1'))
    list = addHistoryEntry(
      list,
      run('UPDATE pedidos SET total = 0', { connectionId: 'c2', connectionName: 'Prod' })
    )
    expect(searchHistory(list, 'clientes ciudad').map((e) => e.connectionName)).toEqual(['Tienda'])
    expect(searchHistory(list, 'prod pedidos')).toHaveLength(1)
    expect(searchHistory(list, 'VENTAS')).toHaveLength(2)
    expect(searchHistory(list, '', 'c2').map((e) => e.sql)).toEqual([
      'UPDATE pedidos SET total = 0'
    ])
  })

  it('titles skip comments; summaries say rows, statements, time and errors', () => {
    expect(historyTitle({ sql: '-- informe\n\n  select   *\n  from t' })).toBe('select *')
    const [ok] = addHistoryEntry([], run('SELECT 1'))
    expect(historySummary(ok)).toBe('12 filas · 35 ms')
    const [bad] = addHistoryEntry(
      [],
      run('x', { ok: false, statements: 2, rows: null, durationMs: 1234 })
    )
    expect(historySummary(bad)).toBe('error · 2 sentencias · 1,2 s')
  })

  it('computes the outcome of a run without keeping any error text', () => {
    const outcome = runOutcome([
      { affectedRows: null, resultSet: { rows: [[1], [2]] } as never, error: null },
      { affectedRows: 3, resultSet: null, error: null },
      {
        affectedRows: null,
        resultSet: null,
        error: "Violation of UNIQUE KEY: duplicate key value is ('ana@x')"
      }
    ])
    expect(outcome).toEqual({ statements: 3, rows: 5, ok: false })
    expect(runOutcome([], true)).toEqual({ statements: 0, rows: null, ok: false })
  })

  it('drops malformed stored entries', () => {
    const [good] = addHistoryEntry([], run('SELECT 1'))
    expect(
      normalizeHistory([good, null, { id: 'x', sql: '' }, { ...good, engine: 'oracle' }, 'nope'])
    ).toEqual([good])
    expect(normalizeHistory({ not: 'a list' })).toEqual([])
  })
})
