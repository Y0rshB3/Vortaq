/**
 * Values and limits of what the MCP tools return: JSON-safe cells (big
 * integers and decimals keep their exact text, binary data becomes a typed
 * hex object), long texts cut with a marker, at most MAX_ROWS rows and a
 * bounded response size.
 */
import { isHexBinaryColumn, jsonValue, type ColumnTypeInfo } from '@shared/export/values'
import type { CellValue, StorageClass } from '@shared/types'

export const MCP_LIMITS = {
  /** Rows returned when the agent does not say. */
  defaultRows: 100,
  /** Hard cap of max_rows. */
  maxRows: 1000,
  defaultTimeoutSec: 30,
  maxTimeoutSec: 120,
  /** Characters kept of one text cell (and hex digits of one binary cell). */
  maxCellChars: 2000,
  /** Approximate size of the rows of one response (JSON characters). */
  maxResponseChars: 200_000,
  /** Databases whose schemas list_databases reads on PostgreSQL. */
  maxPgDatabases: 25
} as const

export function resolveRowLimit(requested: unknown): number {
  const n = Math.trunc(Number(requested))
  if (!Number.isFinite(n) || n < 1) return MCP_LIMITS.defaultRows
  return Math.min(n, MCP_LIMITS.maxRows)
}

/** Timeout of one call in milliseconds. */
export function resolveTimeoutMs(seconds: unknown): number {
  const n = Number(seconds)
  const sec = !Number.isFinite(n) || n <= 0 ? MCP_LIMITS.defaultTimeoutSec : n
  return Math.round(Math.min(sec, MCP_LIMITS.maxTimeoutSec) * 1000)
}

/** Cuts a long text, saying how long it was. */
export function cutText(text: string, max: number = MCP_LIMITS.maxCellChars): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}… [recortado: ${text.length} caracteres en total]`
}

const HEX = /^0x((?:[0-9a-f]{2})*)$/i

export interface BinaryValue {
  type: 'binary'
  /** Size in bytes. */
  bytes: number
  /** Uppercase hex digits (the first MCP_LIMITS.maxCellChars when truncated). */
  hex: string
  truncated?: true
}

/** JSON-safe value of one result cell. */
export function mcpCell(value: CellValue, column: ColumnTypeInfo, storage?: StorageClass): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const binary = storage ? storage === 'blob' : isHexBinaryColumn(column)
    const hex = binary ? HEX.exec(value) : null
    if (hex) {
      const digits = hex[1].toUpperCase()
      const out: BinaryValue = { type: 'binary', bytes: digits.length / 2, hex: digits }
      if (digits.length > MCP_LIMITS.maxCellChars) {
        out.hex = digits.slice(0, MCP_LIMITS.maxCellChars)
        out.truncated = true
      }
      return out
    }
  }
  const v = jsonValue(value, column, storage)
  return typeof v === 'string' ? cutText(v) : v
}

/** Strings cut inside a parsed document (MongoDB canonical Extended JSON). */
export function cutStrings(
  value: unknown,
  scrub: (text: string) => string = (t) => t,
  depth = 0
): unknown {
  if (typeof value === 'string') return cutText(scrub(value))
  if (value === null || typeof value !== 'object' || depth > 100) return value
  if (Array.isArray(value)) return value.map((v) => cutStrings(v, scrub, depth + 1))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      cutStrings(v, scrub, depth + 1)
    ])
  )
}

/** A copy with `fn` applied to every string value (object keys stay as they are). */
export function mapStrings(value: unknown, fn: (text: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return fn(value)
  if (value === null || typeof value !== 'object' || depth > 100) return value
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, depth + 1))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      mapStrings(v, fn, depth + 1)
    ])
  )
}

/** A copy without the keys `drop` names, at any depth (server facts in explain/stats output). */
export function withoutKeys(value: unknown, drop: ReadonlySet<string>, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 100) return value
  if (Array.isArray(value)) return value.map((v) => withoutKeys(v, drop, depth + 1))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !drop.has(k))
      .map(([k, v]) => [k, withoutKeys(v, drop, depth + 1)])
  )
}

/**
 * Size budget of one response: rows are added while they fit; the first
 * one that does not fit marks the response as cut.
 */
export class ResponseBudget {
  private used = 0
  exceeded = false
  constructor(private readonly max: number = MCP_LIMITS.maxResponseChars) {}

  /** True when `value` fits (and is counted). */
  take(value: unknown): boolean {
    if (this.exceeded) return false
    const size = JSON.stringify(value)?.length ?? 4
    if (this.used + size > this.max && this.used > 0) {
      this.exceeded = true
      return false
    }
    this.used += size
    return true
  }
}

export const SIZE_NOTE = `La respuesta se recortó a unos ${Math.round(MCP_LIMITS.maxResponseChars / 1000)} KB: pide menos filas o columnas.`
export const MORE_ROWS_NOTE = `Hay más filas: filtra la consulta o sube max_rows (máximo ${MCP_LIMITS.maxRows}).`

export interface ColumnOut {
  name: string
  type?: string
}

export interface TableOut {
  columns: ColumnOut[]
  rows: unknown[][]
  row_count: number
  truncated: boolean
  notes?: string[]
}

/**
 * Result table for an agent from rows already read (at most limit + 1 of
 * them: one more than the limit says there are more).
 */
export function tableOut(
  columns: (ColumnTypeInfo & { name: string })[],
  rows: CellValue[][],
  limit: number,
  options: {
    storage?: StorageClass[][]
    moreRows?: boolean
    budget?: ResponseBudget
  } = {}
): TableOut {
  const budget = options.budget ?? new ResponseBudget()
  const out: unknown[][] = []
  const notes: string[] = []
  let more = options.moreRows === true || rows.length > limit
  for (let i = 0; i < Math.min(rows.length, limit); i++) {
    const storage = options.storage?.[i]
    const row = rows[i].map((v, c) => mcpCell(v, columns[c] ?? {}, storage?.[c]))
    if (!budget.take(row)) break
    out.push(row)
  }
  if (budget.exceeded) {
    more = true
    notes.push(SIZE_NOTE)
  } else if (more) notes.push(MORE_ROWS_NOTE)
  return {
    columns: columns.map((c) => (c.type ? { name: c.name, type: c.type } : { name: c.name })),
    rows: out,
    row_count: out.length,
    truncated: more,
    ...(notes.length ? { notes } : {})
  }
}
