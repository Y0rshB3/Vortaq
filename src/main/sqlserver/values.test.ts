import { describe, expect, it } from 'vitest'
import {
  installExactValues,
  normalizeCell,
  readExact,
  scaledText,
  sqlServerTypeKind,
  timeLength
} from './values'

/* eslint-disable @typescript-eslint/no-require-imports */
const valueParser = require('tedious/lib/value-parser') as typeof import('tedious/lib/value-parser')
const helpers = require('tedious/lib/token/helpers') as typeof import('tedious/lib/token/helpers')
/* eslint-enable @typescript-eslint/no-require-imports */

type Meta = Parameters<typeof valueParser.readValue>[2]
const meta = (name: string, scale?: number): Meta => ({ type: { name }, scale }) as unknown as Meta

const DAY_MS = 86_400_000
/** Days since 0001-01-01 of a UTC date. */
const days0001 = (y: number, m: number, d: number): number =>
  Date.UTC(y, m - 1, d) / DAY_MS + 719162
const days1900 = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / DAY_MS + 25567

function le(value: bigint, bytes: number): number[] {
  const out: number[] = []
  for (let i = 0; i < bytes; i++) out.push(Number((value >> BigInt(8 * i)) & 0xffn))
  return out
}

describe('scaledText', () => {
  it('keeps every digit and exactly the scale', () => {
    expect(scaledText(false, 1250n, 2)).toBe('12.50')
    expect(scaledText(true, 5n, 3)).toBe('-0.005')
    expect(scaledText(true, 0n, 2)).toBe('0.00')
    expect(scaledText(false, 42n, 0)).toBe('42')
  })
})

describe('readExact', () => {
  it('DECIMAL/NUMERIC: sign byte and little-endian magnitude, any precision', () => {
    const small = Buffer.from([5, 1, ...le(1250n, 4)])
    expect(readExact(small, 0, meta('DecimalN', 2))).toEqual(new helpers.Result('12.50', 6))
    const negative = Buffer.from([5, 0, ...le(1250n, 4)])
    expect(readExact(negative, 0, meta('NumericN', 2))?.value).toBe('-12.50')
    const big = Buffer.from([17, 1, ...le(1234567890123456781234n, 16)])
    expect(readExact(big, 0, meta('DecimalN', 4))?.value).toBe('123456789012345678.1234')
    expect(readExact(Buffer.from([0]), 0, meta('DecimalN', 2))).toEqual(new helpers.Result(null, 1))
  })

  it('MONEY keeps four decimals, also negative', () => {
    const money = Buffer.from([...le(0n, 4), ...le(15000n, 4)])
    expect(readExact(money, 0, meta('Money'))?.value).toBe('1.5000')
    const minus = -15000n & 0xffffffffffffffffn
    const neg = Buffer.from([...le(minus >> 32n, 4), ...le(minus & 0xffffffffn, 4)])
    expect(readExact(neg, 0, meta('Money'))?.value).toBe('-1.5000')
    expect(readExact(Buffer.from([4, ...le(25n, 4)]), 0, meta('MoneyN'))?.value).toBe('0.0025')
  })

  it('date, time, datetime2 and datetimeoffset to the 100 ns', () => {
    const date = Buffer.from([3, ...le(BigInt(days0001(2026, 1, 2)), 3)])
    expect(readExact(date, 0, meta('Date'))?.value).toBe('2026-01-02')
    expect(readExact(Buffer.from([3, ...le(0n, 3)]), 0, meta('Date'))?.value, 'the first day').toBe(
      '0001-01-01'
    )

    const units = BigInt(3 * 3600 + 4 * 60 + 5) * 10_000_000n + 1234567n
    const time = Buffer.from([5, ...le(units, 5)])
    expect(readExact(time, 0, meta('Time', 7))?.value).toBe('03:04:05.1234567')

    const dt2 = Buffer.from([8, ...le(units, 5), ...le(BigInt(days0001(2026, 1, 2)), 3)])
    expect(readExact(dt2, 0, meta('DateTime2', 7))?.value).toBe('2026-01-02 03:04:05.1234567')

    // Stored as UTC 08:04:05 on 2026-01-02 with offset -05:00 => local 03:04:05.
    const utc = BigInt(8 * 3600 + 4 * 60 + 5) * 10_000_000n + 1234567n
    const offset = Buffer.alloc(2)
    offset.writeInt16LE(-300)
    const dto = Buffer.from([10, ...le(utc, 5), ...le(BigInt(days0001(2026, 1, 2)), 3), ...offset])
    expect(readExact(dto, 0, meta('DateTimeOffset', 7))?.value).toBe(
      '2026-01-02 03:04:05.1234567 -05:00'
    )
    // Local time crosses midnight backwards: UTC 02:00 with -05:00 is 21:00 the day before.
    const early = Buffer.from([
      8,
      ...le(BigInt(2 * 3600), 3),
      ...le(BigInt(days0001(2026, 1, 2)), 3),
      ...offset
    ])
    expect(readExact(early, 0, meta('DateTimeOffset', 0))?.value).toBe('2026-01-01 21:00:00 -05:00')
  })

  it('datetime ticks (1/300 s) and smalldatetime minutes', () => {
    const ticks = (3 * 3600 + 4 * 60 + 5) * 300 + 37
    const buf = Buffer.alloc(8)
    buf.writeInt32LE(days1900(2026, 1, 2), 0)
    buf.writeUInt32LE(ticks, 4)
    expect(readExact(buf, 0, meta('DateTime'))?.value).toBe('2026-01-02 03:04:05.123')
    const small = Buffer.alloc(5)
    small[0] = 4
    small.writeUInt16LE(days1900(2026, 1, 2), 1)
    small.writeUInt16LE(3 * 60 + 4, 3)
    expect(readExact(small, 0, meta('DateTimeN'))?.value).toBe('2026-01-02 03:04:00')
  })

  it('asks for more data like tedious when the value is incomplete', () => {
    expect(() => readExact(Buffer.from([17, 1, 2]), 0, meta('DecimalN', 2))).toThrow(
      helpers.NotEnoughDataError as unknown as new () => unknown
    )
  })

  it('leaves every other type to tedious', () => {
    expect(readExact(Buffer.from([1, 2, 3, 4]), 0, meta('Int'))).toBeNull()
  })
})

describe('installExactValues', () => {
  it('wraps the readValue that tedious row parsers call, once', () => {
    expect(installExactValues()).toBe(true)
    const wrapped = valueParser.readValue
    expect(installExactValues()).toBe(true)
    expect(valueParser.readValue).toBe(wrapped)
    const decimal = Buffer.from([5, 1, ...le(1250n, 4)])
    const options = {} as Parameters<typeof valueParser.readValue>[3]
    expect(valueParser.readValue(decimal, 0, meta('DecimalN', 2), options).value).toBe('12.50')
    const int = Buffer.alloc(4)
    int.writeInt32LE(-7)
    expect(valueParser.readValue(int, 0, meta('Int'), options).value).toBe(-7)
  })
})

describe('normalizeCell', () => {
  it('maps the remaining JS values to grid cells', () => {
    expect(normalizeCell(Buffer.from([1, 0xab]))).toBe('0x01AB')
    expect(normalizeCell(true)).toBe(true)
    expect(normalizeCell('9007199254740993')).toBe('9007199254740993')
    expect(normalizeCell(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)))).toBe(
      '2026-01-02 03:04:05.006'
    )
    expect(normalizeCell(undefined)).toBeNull()
  })
})

describe('type helpers', () => {
  it('time lengths and type families', () => {
    expect([0, 2, 3, 4, 5, 7].map(timeLength)).toEqual([3, 3, 4, 4, 5, 5])
    expect(sqlServerTypeKind('nvarchar(50)')).toBe('text')
    expect(sqlServerTypeKind('DECIMAL(10,2)')).toBe('decimal')
    expect(sqlServerTypeKind('datetimeoffset')).toBe('datetime')
    expect(sqlServerTypeKind('uniqueidentifier')).toBe('uuid')
    expect(sqlServerTypeKind('hierarchyid')).toBe('other')
  })
})
