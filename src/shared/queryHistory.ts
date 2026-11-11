/**
 * «Historial de consultas»: the scripts the user ran, newest first, kept on
 * this computer only (the desktop app in localStorage, the editor extension
 * in its global state). Pure: no storage, DOM or editor imports.
 *
 * An entry keeps the SQL as written (cut at MAX_HISTORY_SQL), where it ran and
 * how it went (time, statements, rows, ok/error). Never the error text or any
 * value of the results: server messages can quote row values.
 */
import type { EngineId, QueryStatementResult } from './types'

export const QUERY_HISTORY_LIMIT = 500
export const MAX_HISTORY_SQL = 100_000

export interface QueryHistoryEntry {
  id: string
  sql: string
  /** The SQL was longer than MAX_HISTORY_SQL and was cut. */
  truncated?: boolean
  connectionId: string
  /** Name when it ran (shown when the connection was renamed or deleted since). */
  connectionName: string
  engine: EngineId
  database: string | null
  schema?: string | null
  /** ISO 8601. */
  at: string
  durationMs: number
  statements: number
  /** Rows returned plus rows affected, when the server reported them. */
  rows: number | null
  ok: boolean
}

export type NewHistoryEntry = Omit<QueryHistoryEntry, 'id' | 'truncated'>

/** How a finished run went, from its statement results. */
export function runOutcome(
  results: readonly Pick<QueryStatementResult, 'affectedRows' | 'resultSet' | 'error'>[],
  failed = false
): { statements: number; rows: number | null; ok: boolean } {
  let rows: number | null = null
  for (const r of results) {
    const n = (r.resultSet?.rows.length ?? 0) + (r.affectedRows ?? 0)
    if (r.resultSet || r.affectedRows !== null) rows = (rows ?? 0) + n
  }
  return {
    statements: results.length,
    rows,
    ok: !failed && results.every((r) => !r.error)
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Adds a run at the front. Running the same SQL again on the same connection
 * and database replaces its entry (one line per query, with the latest run).
 */
export function addHistoryEntry(
  list: readonly QueryHistoryEntry[],
  entry: NewHistoryEntry,
  limit = QUERY_HISTORY_LIMIT
): QueryHistoryEntry[] {
  const sql = entry.sql.trim()
  if (!sql) return [...list]
  const truncated = sql.length > MAX_HISTORY_SQL
  const kept: QueryHistoryEntry = {
    ...entry,
    sql: truncated ? sql.slice(0, MAX_HISTORY_SQL) : sql,
    ...(truncated ? { truncated: true } : {}),
    id: newId()
  }
  const same = (e: QueryHistoryEntry): boolean =>
    e.sql === kept.sql && e.connectionId === kept.connectionId && e.database === kept.database
  return [kept, ...list.filter((e) => !same(e))].slice(0, Math.max(1, limit))
}

/**
 * Entries whose SQL, connection name or database contain every word of
 * `query` (any case); `connectionId` narrows to one connection.
 */
export function searchHistory(
  list: readonly QueryHistoryEntry[],
  query: string,
  connectionId?: string | null
): QueryHistoryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return list.filter((e) => {
    if (connectionId && e.connectionId !== connectionId) return false
    if (!words.length) return true
    const hay = `${e.sql}\n${e.connectionName}\n${e.database ?? ''}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** First line with code (comments skipped), at most 100 characters. */
export function historyTitle(entry: Pick<QueryHistoryEntry, 'sql'>): string {
  const lines = entry.sql.split('\n').map((l) => l.trim())
  const code = lines.find((l) => l && !l.startsWith('--') && !l.startsWith('/*')) ?? lines[0] ?? ''
  const flat = code.replace(/\s+/g, ' ')
  return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat
}

/** «12 filas · 35 ms», «error · 2 sentencias · 1,2 s». */
export function historySummary(entry: QueryHistoryEntry): string {
  const parts: string[] = []
  if (!entry.ok) parts.push('error')
  if (entry.statements > 1) parts.push(`${entry.statements} sentencias`)
  if (entry.rows !== null) parts.push(entry.rows === 1 ? '1 fila' : `${entry.rows} filas`)
  parts.push(
    entry.durationMs < 1000
      ? `${entry.durationMs} ms`
      : `${(entry.durationMs / 1000).toLocaleString('es', { maximumFractionDigits: 1 })} s`
  )
  return parts.join(' · ')
}

const ENGINES: readonly string[] = [
  'mysql',
  'mariadb',
  'postgresql',
  'sqlite',
  'mongodb',
  'sqlserver'
]

/** The stored list as read back: anything malformed is dropped, never guessed. */
export function normalizeHistory(raw: unknown, limit = QUERY_HISTORY_LIMIT): QueryHistoryEntry[] {
  if (!Array.isArray(raw)) return []
  const out: QueryHistoryEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const e = item as Partial<QueryHistoryEntry>
    if (
      typeof e.id !== 'string' ||
      typeof e.sql !== 'string' ||
      !e.sql.trim() ||
      typeof e.connectionId !== 'string' ||
      typeof e.at !== 'string' ||
      !ENGINES.includes(String(e.engine))
    )
      continue
    out.push({
      id: e.id,
      sql: e.sql.slice(0, MAX_HISTORY_SQL),
      ...(e.truncated ? { truncated: true } : {}),
      connectionId: e.connectionId,
      connectionName: typeof e.connectionName === 'string' ? e.connectionName : '',
      engine: e.engine as EngineId,
      database: typeof e.database === 'string' ? e.database : null,
      ...(typeof e.schema === 'string' ? { schema: e.schema } : {}),
      at: e.at,
      durationMs: Number.isFinite(e.durationMs) ? Number(e.durationMs) : 0,
      statements: Number.isInteger(e.statements) ? Number(e.statements) : 1,
      rows: Number.isFinite(e.rows) ? Number(e.rows) : null,
      ok: e.ok !== false
    })
    if (out.length >= limit) break
  }
  return out
}
