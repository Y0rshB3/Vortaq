/**
 * SQL Server value fidelity (docs/sqlserver-design.md, «Valores»).
 *
 * tedious turns DECIMAL/NUMERIC/MONEY into JS numbers (digits beyond ~15 are
 * lost and the scale disappears: 12.50 arrives as 12.5) and every date/time
 * type into a JS Date (100 ns precision becomes milliseconds and the
 * datetimeoffset's own offset is dropped). Vortaq keeps the server's value
 * instead, like the other engines:
 *
 * - `installExactValues()` wraps tedious's row value reader (the module export
 *   `readValue` of tedious/lib/value-parser, which the row parsers call
 *   through the module object) so exact numerics and temporal values are read
 *   straight from the TDS bytes as text: `12.50`, `123456789012345678.1234`,
 *   `1.5000` (money keeps 4 decimals), `2026-01-02 03:04:05.1234567`,
 *   `2026-01-02 03:04:05.1234567 -05:00`. Every other type goes through
 *   tedious's own reader. tedious is pinned to an exact version and
 *   values.test.ts plus the integration suite check the wrapper still applies.
 * - `normalizeCell()` maps what remains to CellValue: bit → boolean, bigint
 *   stays text, binary → `0xHEX`, a Date (inside sql_variant) → text.
 */
import type { CellValue, TypeKind } from '@shared/types'

// The module objects tedious itself uses. A literal require() keeps the very same instance in
// the desktop build (tedious is external), the editor extension's esbuild bundle and Vitest; a
// namespace import would be a frozen copy in bundles and the patch would not reach tedious.
/* eslint-disable @typescript-eslint/no-require-imports */
const valueParser = require('tedious/lib/value-parser') as typeof import('tedious/lib/value-parser')
const helpers = require('tedious/lib/token/helpers') as typeof import('tedious/lib/token/helpers')
/* eslint-enable @typescript-eslint/no-require-imports */

type ReadValue = typeof valueParser.readValue
type Metadata = Parameters<ReadValue>[2]

const MARK = Symbol.for('vortaq.sqlserver.exactValues')

/* ---------- exact readers (TDS 7.4 encodings, MS-TDS 2.2.5.5) ---------- */

const NotEnoughData = helpers.NotEnoughDataError
const Result = helpers.Result

function need(buf: Buffer, end: number): void {
  if (buf.length < end) throw new NotEnoughData(end)
}

/** Unsigned little-endian integer of `length` bytes as a bigint. */
function readUnsignedLE(buf: Buffer, offset: number, length: number): bigint {
  let value = 0n
  for (let i = length - 1; i >= 0; i--) value = (value << 8n) | BigInt(buf[offset + i])
  return value
}

/** `magnitude / 10^scale` written with exactly `scale` decimals. */
export function scaledText(negative: boolean, magnitude: bigint, scale: number): string {
  const digits = magnitude.toString().padStart(scale + 1, '0')
  const sign = negative && magnitude !== 0n ? '-' : ''
  if (scale <= 0) return sign + digits
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

function readDecimalBody(buf: Buffer, offset: number, length: number, scale: number): string {
  const positive = buf[offset] === 1
  return scaledText(!positive, readUnsignedLE(buf, offset + 1, length - 1), scale)
}

function readMoneyBody(buf: Buffer, offset: number, length: 4 | 8): string {
  let value: bigint
  if (length === 4) value = BigInt(buf.readInt32LE(offset))
  else value = (BigInt(buf.readInt32LE(offset)) << 32n) | BigInt(buf.readUInt32LE(offset + 4))
  const negative = value < 0n
  return scaledText(negative, negative ? -value : value, 4)
}

const pad = (n: number | bigint, width: number): string => String(n).padStart(width, '0')

/** Civil date of a day count since 1970-01-01 (proleptic Gregorian, H. Hinnant). */
function civilFromDays(daysSinceEpoch: number): { y: number; m: number; d: number } {
  const z = daysSinceEpoch + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  )
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0)
  return { y, m, d }
}

/** Days between 0001-01-01 and 1970-01-01. */
const DAYS_0001_TO_1970 = 719162
/** Days between 1900-01-01 and 1970-01-01. */
const DAYS_1900_TO_1970 = 25567

function dateText(daysSinceEpoch: number): string {
  const { y, m, d } = civilFromDays(daysSinceEpoch)
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`
}

/** `hh:mm:ss[.fffffff]` of `units` (10^-scale seconds since midnight). */
function timeText(units: bigint, scale: number): string {
  const per = 10n ** BigInt(scale)
  const seconds = units / per
  const fraction = units % per
  const h = seconds / 3600n
  const m = (seconds / 60n) % 60n
  const s = seconds % 60n
  const base = `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}`
  return scale > 0 ? `${base}.${pad(fraction, scale)}` : base
}

/** Bytes of a time value for a scale (MS-TDS: 3 for 0-2, 4 for 3-4, 5 for 5-7). */
export function timeLength(scale: number): number {
  return scale <= 2 ? 3 : scale <= 4 ? 4 : 5
}

function readTimeUnits(buf: Buffer, offset: number, length: number): bigint {
  return readUnsignedLE(buf, offset, length)
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`
}

/** datetimeoffset: the stored UTC instant shifted to its own offset, plus that offset. */
function dateTimeOffsetText(
  days: number,
  units: bigint,
  scale: number,
  offsetMinutes: number
): string {
  const per = 10n ** BigInt(scale)
  const dayUnits = 86400n * per
  let local = units + BigInt(offsetMinutes) * 60n * per
  let localDays = days
  while (local < 0n) {
    local += dayUnits
    localDays--
  }
  while (local >= dayUnits) {
    local -= dayUnits
    localDays++
  }
  return `${dateText(localDays - DAYS_0001_TO_1970)} ${timeText(local, scale)} ${offsetText(offsetMinutes)}`
}

/** datetime: days since 1900-01-01 and 1/300 s ticks, shown with milliseconds like SQL Server. */
function dateTimeText(days: number, ticks: number): string {
  // SQL Server rounds 1/300 s ticks to .000, .003 or .007 milliseconds.
  let ms = Math.round((ticks * 10) / 3)
  let dayShift = 0
  if (ms >= 86400000) {
    ms -= 86400000
    dayShift = 1
  }
  const total = BigInt(ms)
  return `${dateText(days + dayShift - DAYS_1900_TO_1970)} ${timeText(total, 3)}`
}

function smallDateTimeText(days: number, minutes: number): string {
  return `${dateText(days - DAYS_1900_TO_1970)} ${pad(Math.floor(minutes / 60), 2)}:${pad(minutes % 60, 2)}:00`
}

/**
 * Exact reader for the types tedious would round; null for every other type
 * (the caller then uses tedious's own reader).
 */
export function readExact(
  buf: Buffer,
  offset: number,
  metadata: Pick<Metadata, 'type' | 'scale'>
): InstanceType<typeof Result> | null {
  const scale = metadata.scale ?? 0
  switch (metadata.type.name) {
    case 'DecimalN':
    case 'NumericN': {
      need(buf, offset + 1)
      const length = buf[offset]
      if (length === 0) return new Result(null, offset + 1)
      need(buf, offset + 1 + length)
      return new Result(readDecimalBody(buf, offset + 1, length, scale), offset + 1 + length)
    }
    case 'Money':
      need(buf, offset + 8)
      return new Result(readMoneyBody(buf, offset, 8), offset + 8)
    case 'SmallMoney':
      need(buf, offset + 4)
      return new Result(readMoneyBody(buf, offset, 4), offset + 4)
    case 'MoneyN': {
      need(buf, offset + 1)
      const length = buf[offset]
      if (length === 0) return new Result(null, offset + 1)
      if (length !== 4 && length !== 8) return null
      need(buf, offset + 1 + length)
      return new Result(readMoneyBody(buf, offset + 1, length), offset + 1 + length)
    }
    case 'Date': {
      need(buf, offset + 1)
      const length = buf[offset]
      if (length === 0) return new Result(null, offset + 1)
      need(buf, offset + 1 + length)
      const days = buf.readUIntLE(offset + 1, 3)
      return new Result(dateText(days - DAYS_0001_TO_1970), offset + 1 + length)
    }
    case 'Time': {
      need(buf, offset + 1)
      const length = buf[offset]
      if (length === 0) return new Result(null, offset + 1)
      need(buf, offset + 1 + length)
      return new Result(
        timeText(readTimeUnits(buf, offset + 1, length), scale),
        offset + 1 + length
      )
    }
    case 'DateTime2': {
      need(buf, offset + 1)
      const length = buf[offset]
      if (length === 0) return new Result(null, offset + 1)
      need(buf, offset + 1 + length)
      const timeBytes = length - 3
      const units = readTimeUnits(buf, offset + 1, timeBytes)
      const days = buf.readUIntLE(offset + 1 + timeBytes, 3)
      return new Result(
        `${dateText(days - DAYS_0001_TO_1970)} ${timeText(units, scale)}`,
        offset + 1 + length
      )
    }
    case 'DateTimeOffset': {
      need(buf, offset + 1)
      const length = buf[offset]
      if (length === 0) return new Result(null, offset + 1)
      need(buf, offset + 1 + length)
      const timeBytes = length - 5
      const units = readTimeUnits(buf, offset + 1, timeBytes)
      const days = buf.readUIntLE(offset + 1 + timeBytes, 3)
      const minutes = buf.readInt16LE(offset + 1 + timeBytes + 3)
      return new Result(dateTimeOffsetText(days, units, scale, minutes), offset + 1 + length)
    }
    case 'DateTime':
      need(buf, offset + 8)
      return new Result(
        dateTimeText(buf.readInt32LE(offset), buf.readUInt32LE(offset + 4)),
        offset + 8
      )
    case 'SmallDateTime':
      need(buf, offset + 4)
      return new Result(
        smallDateTimeText(buf.readUInt16LE(offset), buf.readUInt16LE(offset + 2)),
        offset + 4
      )
    case 'DateTimeN': {
      need(buf, offset + 1)
      const length = buf[offset]
      if (length === 0) return new Result(null, offset + 1)
      need(buf, offset + 1 + length)
      if (length === 4)
        return new Result(
          smallDateTimeText(buf.readUInt16LE(offset + 1), buf.readUInt16LE(offset + 3)),
          offset + 5
        )
      if (length === 8)
        return new Result(
          dateTimeText(buf.readInt32LE(offset + 1), buf.readUInt32LE(offset + 5)),
          offset + 9
        )
      return null
    }
    default:
      return null
  }
}

/**
 * Installs the exact reader once per process (idempotent). Returns false when
 * tedious no longer exposes a writable `readValue` (a tedious upgrade changed
 * its internals): values.test.ts fails on that before a release.
 */
export function installExactValues(): boolean {
  const target = valueParser as unknown as Record<string | symbol, unknown>
  const current = target.readValue as ReadValue & { [MARK]?: true }
  if (current[MARK]) return true
  const descriptor = Object.getOwnPropertyDescriptor(target, 'readValue')
  if (!descriptor || !descriptor.writable || typeof current !== 'function') return false
  const original = current
  const wrapped = ((buf, offset, metadata, options) =>
    readExact(buf, offset, metadata) ?? original(buf, offset, metadata, options)) as ReadValue & {
    [MARK]?: true
  }
  wrapped[MARK] = true
  target.readValue = wrapped
  return true
}

/* ---------- cells ---------- */

/** A tedious value (after installExactValues) as a grid cell. */
export function normalizeCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return '0x' + value.toString('hex').toUpperCase()
  if (value instanceof Date) {
    // Only sql_variant values still arrive as Dates (useUTC: the UTC fields are the stored ones).
    if (Number.isNaN(value.getTime())) return null
    return value.toISOString().replace('T', ' ').replace('Z', '')
  }
  return String(value)
}

/** Type family of a SQL Server type name (sys.types / tedious names, any case). */
export function sqlServerTypeKind(typeName: string): TypeKind {
  const t = typeName.toLowerCase().replace(/\(.*$/, '').trim()
  switch (t) {
    case 'tinyint':
    case 'smallint':
    case 'int':
    case 'bigint':
    case 'intn':
      return 'integer'
    case 'decimal':
    case 'numeric':
    case 'money':
    case 'smallmoney':
    case 'decimaln':
    case 'numericn':
    case 'moneyn':
      return 'decimal'
    case 'real':
    case 'float':
    case 'floatn':
      return 'float'
    case 'bit':
    case 'bitn':
      return 'boolean'
    case 'char':
    case 'varchar':
    case 'nchar':
    case 'nvarchar':
    case 'text':
    case 'ntext':
    case 'sysname':
    case 'xml':
      return 'text'
    case 'binary':
    case 'varbinary':
    case 'image':
    case 'timestamp':
    case 'rowversion':
      return 'binary'
    case 'date':
      return 'date'
    case 'time':
      return 'time'
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
    case 'datetimeoffset':
    case 'datetimen':
      return 'datetime'
    case 'uniqueidentifier':
      return 'uuid'
    case 'geography':
    case 'geometry':
      return 'spatial'
    default:
      return 'other'
  }
}
