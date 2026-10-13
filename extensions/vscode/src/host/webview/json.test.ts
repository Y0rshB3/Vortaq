import { describe, expect, it } from 'vitest'
import { toJsonSafe } from './json'

const roundTrip = (v: unknown): unknown => JSON.parse(JSON.stringify(v))

describe('toJsonSafe (webview messages are JSON)', () => {
  it('leaves the values the core returns for results untouched', () => {
    const result = {
      sql: 'SELECT 1',
      resultSet: {
        columns: [{ name: 'id', type: 'BIGINT' }],
        rows: [['9223372036854775807', 1.5, true, null, '0xDEADBEEF']],
        truncated: false
      },
      storage: [['integer', 'real', 'integer', 'null', 'blob']]
    }
    expect(toJsonSafe(result)).toEqual(result)
    expect(roundTrip(toJsonSafe(result))).toEqual(result)
  })

  it('turns values JSON cannot carry into exact text', () => {
    const value = {
      big: 12345678901234567890n,
      bytes: new Uint8Array([0, 1, 255]),
      when: new Date('2026-10-13T10:00:00.000Z'),
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      gone: undefined,
      fn: () => 1,
      list: [1, undefined, 2n],
      map: new Map([['a', 1]]),
      set: new Set(['x'])
    }
    const safe = toJsonSafe(value)
    expect(safe).toEqual({
      big: '12345678901234567890',
      bytes: '0x0001FF',
      when: '2026-10-13T10:00:00.000Z',
      nan: 'NaN',
      inf: 'Infinity',
      list: [1, null, '2'],
      map: { a: 1 },
      set: ['x']
    })
    expect(roundTrip(safe)).toEqual(safe)
  })

  it('breaks cycles but keeps shared references', () => {
    const shared = { a: 1 }
    const cyclic: Record<string, unknown> = { shared, again: shared }
    cyclic.self = cyclic
    expect(toJsonSafe(cyclic)).toEqual({ shared: { a: 1 }, again: { a: 1 }, self: null })
  })
})
