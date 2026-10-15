import { describe, expect, it } from 'vitest'
import {
  cutStrings,
  cutText,
  MCP_LIMITS,
  mcpCell,
  resolveRowLimit,
  resolveTimeoutMs,
  ResponseBudget,
  tableOut
} from './values'

describe('MCP values and limits', () => {
  it('row limit: default 100, at most 1000; timeout: default 30 s, at most 120 s', () => {
    expect(resolveRowLimit(undefined)).toBe(100)
    expect(resolveRowLimit(0)).toBe(100)
    expect(resolveRowLimit(7.9)).toBe(7)
    expect(resolveRowLimit(5000)).toBe(1000)
    expect(resolveTimeoutMs(undefined)).toBe(30_000)
    expect(resolveTimeoutMs(-1)).toBe(30_000)
    expect(resolveTimeoutMs(1.5)).toBe(1500)
    expect(resolveTimeoutMs(999)).toBe(120_000)
  })

  it('cells: exact big integers and decimals as text, binary as typed hex, long text cut', () => {
    expect(mcpCell('18446744073709551615', { type: 'BIGINT UNSIGNED' })).toBe(
      '18446744073709551615'
    )
    expect(mcpCell('42', { type: 'INT' })).toBe(42)
    expect(mcpCell('12345678901234.123456', { type: 'DECIMAL(20,6)' })).toBe(
      '12345678901234.123456'
    )
    expect(mcpCell(9007199254740994, { typeKind: 'integer' })).toBe('9007199254740994')
    expect(mcpCell(Number.NaN, { typeKind: 'float' })).toBe('NaN')
    expect(mcpCell('0x00FF', { type: 'VARBINARY(16)' })).toEqual({
      type: 'binary',
      bytes: 2,
      hex: '00FF'
    })
    expect(mcpCell('0xABCD', { typeKind: 'binary' })).toEqual({
      type: 'binary',
      bytes: 2,
      hex: 'ABCD'
    })
    // Text that happens to look like hex stays text; SQLite decides by storage class.
    expect(mcpCell('0x00FF', { type: 'VARCHAR(10)' })).toBe('0x00FF')
    expect(mcpCell('0x01', {}, 'blob')).toEqual({ type: 'binary', bytes: 1, hex: '01' })
    expect(mcpCell('0x01', {}, 'text')).toBe('0x01')
    const big = mcpCell(`0x${'AB'.repeat(1500)}`, { type: 'BLOB' }) as {
      hex: string
      bytes: number
      truncated?: true
    }
    expect(big.bytes).toBe(1500)
    expect(big.hex.length).toBe(MCP_LIMITS.maxCellChars)
    expect(big.truncated).toBe(true)
    expect(mcpCell(null, {})).toBeNull()
    expect(mcpCell(true, {})).toBe(true)
    expect(cutText('abc', 2)).toBe('ab… [recortado: 3 caracteres en total]')
    expect(cutStrings({ a: ['x'.repeat(3000)], b: 1 })).toEqual({
      a: [`${'x'.repeat(2000)}… [recortado: 3000 caracteres en total]`],
      b: 1
    })
  })

  it('tableOut keeps the limit, flags more rows and caps the response size', () => {
    const columns = [
      { name: 'id', type: 'INT' },
      { name: 'txt', type: 'TEXT' }
    ]
    const rows = Array.from({ length: 6 }, (_, i) => [String(i), `t${i}`])
    const out = tableOut(columns, rows, 5)
    expect(out.rows).toHaveLength(5)
    expect(out.rows[0]).toEqual([0, 't0'])
    expect(out.truncated).toBe(true)
    expect(out.notes?.[0]).toMatch(/max_rows/)
    expect(tableOut(columns, rows.slice(0, 3), 5).truncated).toBe(false)

    const wide = Array.from({ length: 200 }, (_, i) => [i, 'y'.repeat(1900)])
    const capped = tableOut(columns, wide, 1000)
    expect(capped.row_count).toBeLessThan(200)
    expect(JSON.stringify(capped.rows).length).toBeLessThanOrEqual(MCP_LIMITS.maxResponseChars)
    expect(capped.truncated).toBe(true)
    expect(capped.notes?.[0]).toMatch(/200 KB/)

    const budget = new ResponseBudget(10)
    expect(budget.take('a'.repeat(50))).toBe(true) // the first value always fits
    expect(budget.take('b')).toBe(false)
    expect(budget.exceeded).toBe(true)
  })
})
