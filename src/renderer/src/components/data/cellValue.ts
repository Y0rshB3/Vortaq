import type { CellValue } from '@shared/types'

/**
 * Helpers of the "Texto" value panel: JSON detection / pretty printing /
 * tokens for highlighting (rendered as text spans, never as HTML), binary
 * (0xHEX cells) as a hex dump, and sizes.
 */

/** Above this size JSON is shown without highlighting (keeps the panel responsive). */
export const HIGHLIGHT_LIMIT = 200_000

const BINARY_TYPES = /^(BLOB|TINYBLOB|MEDIUMBLOB|LONGBLOB|BINARY|VARBINARY|BIT|GEOMETRY)\b/i
const HEX = /^0x(?:[0-9a-f]{2})*$/i

/** Binary column whose value travels as "0xHEX" text. */
export function isBinaryValue(value: CellValue, type: string | null | undefined): boolean {
  return typeof value === 'string' && HEX.test(value) && BINARY_TYPES.test((type ?? '').trim())
}

/** JSON object/array text (scalars are left alone: "12" is not shown as JSON). */
export function isJsonText(value: CellValue): value is string {
  if (typeof value !== 'string') return false
  const t = value.trim()
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']')))
    return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

export function prettyJson(text: string): string {
  return JSON.stringify(JSON.parse(text), null, 2)
}

export function compactJson(text: string): string {
  return JSON.stringify(JSON.parse(text))
}

export type JsonTokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'space'

export interface JsonToken {
  kind: JsonTokenKind
  text: string
}

const TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}[\],:])|(\s+)/g

/** Tokens of (pretty) JSON text for highlighting; concatenated they give the text back. */
export function jsonTokens(text: string): JsonToken[] {
  const tokens: JsonToken[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) tokens.push({ kind: 'punct', text: text.slice(last, m.index) })
    if (m[1] !== undefined) {
      tokens.push({ kind: m[2] ? 'key' : 'string', text: m[1] })
      if (m[2]) tokens.push({ kind: 'punct', text: m[2] })
    } else if (m[3] !== undefined) tokens.push({ kind: 'number', text: m[3] })
    else if (m[4] !== undefined) tokens.push({ kind: 'literal', text: m[4] })
    else if (m[5] !== undefined) tokens.push({ kind: 'punct', text: m[5] })
    else tokens.push({ kind: 'space', text: m[6] })
    last = m.index! + m[0].length
  }
  if (last < text.length) tokens.push({ kind: 'punct', text: text.slice(last) })
  return tokens
}

/** "0xDEADBEEF" -> "DE AD BE EF" in rows of 16 bytes with offsets. */
export function hexDump(value: string, perRow = 16): string {
  const hex = value.slice(2).toUpperCase()
  const rows: string[] = []
  for (let i = 0; i < hex.length; i += perRow * 2) {
    const bytes = hex.slice(i, i + perRow * 2).match(/../g) ?? []
    rows.push(`${(i / 2).toString(16).padStart(8, '0')}  ${bytes.join(' ')}`)
  }
  return rows.join('\n')
}

export function binaryBytes(value: string): number {
  return (value.length - 2) / 2
}

/** UTF-8 size of a text value. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * A declared column type for display: keywords upper-cased, the quoted values
 * of ENUM/SET kept exactly as defined (`ENUM('Active','it''s')`).
 */
export function displayColumnType(columnType: string): string {
  return columnType.replace(/('(?:[^'\\]|''|\\.)*')|[^']+/g, (m, quoted?: string) =>
    quoted ? m : m.toUpperCase()
  )
}
