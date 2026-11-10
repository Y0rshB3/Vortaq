/**
 * MySQL temporal literals for the date/time picker, handled as plain text and
 * integers: nothing goes through a JS Date, so there is no timezone or DST
 * shift (the grid shows the server text as sent with dateStrings).
 *
 * Formats written back: DATE `YYYY-MM-DD`, DATETIME/TIMESTAMP
 * `YYYY-MM-DD HH:MM:SS[.ffffff]` (fraction only with fsp > 0), TIME
 * `[-]HHH:MM:SS[.ffffff]` (-838:59:59 .. 838:59:59), YEAR `YYYY`.
 * Zero dates ('0000-00-00', '0000-00-00 00:00:00') are accepted as typed.
 */

export type TemporalKind = 'date' | 'datetime' | 'time' | 'year'

export interface TemporalSpec {
  kind: TemporalKind
  /** Fractional second digits (0-6). */
  fsp: number
}

/**
 * Picker kind for a column: `type` is the result type name (DATETIME...),
 * `columnType` the declared type when known (datetime(3) gives fsp 3).
 */
export function temporalSpec(
  type: string | null | undefined,
  columnType?: string | null
): TemporalSpec | null {
  const declared = (columnType ?? '').trim().toLowerCase()
  const t = (declared || (type ?? '')).trim().toUpperCase()
  const fspMatch = /^\w+\s*\((\d)\)/.exec(declared)
  // MySQL's limit is 6; SQL Server's time and datetime2 go to 7 (datetime2 alone means 7).
  const fsp = fspMatch ? Math.min(7, Number(fspMatch[1])) : 0
  if (/^DATETIME2\b/.test(t)) return { kind: 'datetime', fsp: fspMatch ? fsp : 7 }
  if (/^(DATETIME|TIMESTAMP)\b/.test(t)) return { kind: 'datetime', fsp }
  if (/^DATE\b/.test(t)) return { kind: 'date', fsp: 0 }
  if (/^TIME\b/.test(t)) return { kind: 'time', fsp }
  if (/^YEAR\b/.test(t)) return { kind: 'year', fsp: 0 }
  return null
}

export interface DateParts {
  year: number
  month: number
  day: number
}

export interface TimeParts {
  negative: boolean
  hours: number
  minutes: number
  seconds: number
  /** Fraction digits as typed (no rounding), '' when none. */
  fraction: string
}

export interface ParsedTemporal {
  date: DateParts | null
  time: TimeParts | null
  year: number | null
  /** The all-zero date of MySQL. */
  zero: boolean
}

export type ParseResult = { ok: true; value: ParsedTemporal } | { ok: false; error: string }

export function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31
}

/** Day of the week, 0 = Monday ... 6 = Sunday (Sakamoto, proleptic Gregorian). */
export function weekday(year: number, month: number, day: number): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  const y = month < 3 ? year - 1 : year
  const sunday0 =
    (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[month - 1] + day) % 7
  return (sunday0 + 6) % 7
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/
// Up to 7 fraction digits: SQL Server time(7)/datetime2(7) keep 100 ns.
const TIME_RE = /^(-)?(\d{1,3}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,7}))?)?$/

function parseDate(text: string): DateParts | 'zero' | string {
  const m = DATE_RE.exec(text)
  if (!m) return 'Usa el formato AAAA-MM-DD'
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (year === 0 && month === 0 && day === 0) return 'zero'
  if (month < 1 || month > 12) return 'El mes debe estar entre 01 y 12'
  if (day < 1 || day > daysInMonth(year, month))
    return `El día debe estar entre 01 y ${daysInMonth(year, month)}`
  return { year, month, day }
}

function parseTime(text: string, limitHours: number): TimeParts | string {
  const m = TIME_RE.exec(text)
  if (!m) return 'Usa el formato hh:mm:ss'
  const time: TimeParts = {
    negative: !!m[1],
    hours: Number(m[2]),
    minutes: Number(m[3]),
    seconds: m[4] === undefined ? 0 : Number(m[4]),
    fraction: m[5] ?? ''
  }
  if (time.hours > limitHours) return `Las horas deben estar entre 00 y ${limitHours}`
  if (time.minutes > 59) return 'Los minutos deben estar entre 00 y 59'
  if (time.seconds > 59) return 'Los segundos deben estar entre 00 y 59'
  return time
}

/** Validates text typed for a temporal column (accepts a `T` separator and spaces around). */
export function parseTemporal(input: string, kind: TemporalKind): ParseResult {
  const text = input.trim()
  if (!text) return { ok: false, error: 'Escribe un valor' }
  const empty: ParsedTemporal = { date: null, time: null, year: null, zero: false }
  if (kind === 'year') {
    if (!/^\d{4}$/.test(text)) return { ok: false, error: 'Usa el formato AAAA' }
    const year = Number(text)
    if (year !== 0 && (year < 1901 || year > 2155))
      return { ok: false, error: 'El año debe estar entre 1901 y 2155' }
    return { ok: true, value: { ...empty, year, zero: year === 0 } }
  }
  if (kind === 'time') {
    const time = parseTime(text, 838)
    if (typeof time === 'string') return { ok: false, error: time }
    if (time.hours === 838 && (time.minutes > 59 || time.seconds > 59 || time.fraction))
      return { ok: false, error: 'TIME admite como máximo 838:59:59' }
    return { ok: true, value: { ...empty, time } }
  }
  const [datePart, timePart, ...rest] = text.split(/[ T]+/)
  if (rest.length) return { ok: false, error: 'Usa el formato AAAA-MM-DD hh:mm:ss' }
  const date = parseDate(datePart)
  if (typeof date === 'string' && date !== 'zero') return { ok: false, error: date }
  if (kind === 'date') {
    if (timePart !== undefined) return { ok: false, error: 'Usa el formato AAAA-MM-DD' }
    return {
      ok: true,
      value: date === 'zero' ? { ...empty, zero: true } : { ...empty, date: date as DateParts }
    }
  }
  let time: TimeParts = { negative: false, hours: 0, minutes: 0, seconds: 0, fraction: '' }
  if (timePart !== undefined) {
    const parsed = parseTime(timePart, 23)
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    if (parsed.negative) return { ok: false, error: 'La hora no puede ser negativa' }
    time = parsed
  }
  if (date === 'zero') {
    if (time.hours || time.minutes || time.seconds || Number(time.fraction || 0))
      return { ok: false, error: 'Una fecha cero solo admite la hora 00:00:00' }
    return { ok: true, value: { ...empty, time, zero: true } }
  }
  return { ok: true, value: { ...empty, date: date as DateParts, time } }
}

function fractionOf(fraction: string, fsp: number): string {
  if (fsp <= 0) return ''
  return '.' + fraction.slice(0, fsp).padEnd(fsp, '0')
}

export function formatDate(d: DateParts): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`
}

export function formatTime(t: TimeParts, fsp: number, hoursWidth = 2): string {
  const sign =
    t.negative && (t.hours || t.minutes || t.seconds || Number(t.fraction || 0)) ? '-' : ''
  return `${sign}${pad(t.hours, hoursWidth)}:${pad(t.minutes)}:${pad(t.seconds)}${fractionOf(t.fraction, fsp)}`
}

/**
 * The exact MySQL literal for a parsed value. `fsp` decides the fraction digits
 * (a typed fraction is kept when the column has no declared fsp but the value
 * carried one, so editing never drops precision the server sent).
 */
export function formatTemporal(value: ParsedTemporal, spec: TemporalSpec): string {
  const fsp = spec.fsp || (value.time?.fraction ? value.time.fraction.length : 0)
  switch (spec.kind) {
    case 'year':
      return pad(value.year ?? 0, 4)
    case 'date':
      return value.zero || !value.date ? '0000-00-00' : formatDate(value.date)
    case 'time':
      return formatTime(
        value.time ?? { negative: false, hours: 0, minutes: 0, seconds: 0, fraction: '' },
        fsp
      )
    case 'datetime': {
      const time = value.time ?? { negative: false, hours: 0, minutes: 0, seconds: 0, fraction: '' }
      const date = value.zero || !value.date ? '0000-00-00' : formatDate(value.date)
      return `${date} ${formatTime(time, fsp)}`
    }
  }
}

/** Normalises typed text to the MySQL literal, or returns the validation error. */
export function normalizeTemporal(
  input: string,
  spec: TemporalSpec
): { ok: true; text: string } | { ok: false; error: string } {
  const parsed = parseTemporal(input, spec.kind)
  return parsed.ok ? { ok: true, text: formatTemporal(parsed.value, spec) } : parsed
}

/** Local wall-clock "now" as parts (what the user sees on their clock; no conversion). */
export function nowParts(clock: Date = new Date()): { date: DateParts; time: TimeParts } {
  return {
    date: { year: clock.getFullYear(), month: clock.getMonth() + 1, day: clock.getDate() },
    time: {
      negative: false,
      hours: clock.getHours(),
      minutes: clock.getMinutes(),
      seconds: clock.getSeconds(),
      fraction: String(clock.getMilliseconds()).padStart(3, '0') + '000'
    }
  }
}

/** Calendar month as weeks of day numbers (null = padding), weeks starting on Monday. */
export function monthGrid(year: number, month: number): (number | null)[][] {
  const first = weekday(year, month, 1)
  const days = daysInMonth(year, month)
  const cells: (number | null)[] = Array.from({ length: first }, () => null)
  for (let d = 1; d <= days; d++) cells.push(d)
  while (cells.length % 7) cells.push(null)
  const weeks: (number | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}
