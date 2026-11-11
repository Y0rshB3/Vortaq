/**
 * Which statement a plan can be asked for, decided the same way in the UIs
 * and in main (main checks again before touching the server).
 *
 * - Estimated plan: one SELECT / WITH / INSERT / UPDATE / DELETE / MERGE /
 *   REPLACE. The server only plans it (SHOWPLAN, EXPLAIN without ANALYZE,
 *   EXPLAIN QUERY PLAN): nothing runs, so writes are allowed here.
 * - Actual plan: the statement runs to measure rows and times, so it must be
 *   one read-only SELECT / WITH (the dialect's allowlist); main runs it where
 *   nothing can be kept (a read-only transaction, or one always rolled back).
 */
import { getDialect } from '../dialects'
import { statementsOfBatch } from '../dialects/sqlserver'
import type { SqlDialectId } from '../dialects/types'

const PLANNABLE = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE'])
const READS = new Set(['SELECT', 'WITH'])

/** First keyword, past comments, blanks and opening parentheses. */
export function firstKeyword(statement: string): string {
  const rest = statement.replace(
    /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|#[^\n]*(?:\n|$)|\()+/,
    ''
  )
  return /^([A-Za-z]+)/.exec(rest)?.[1]?.toUpperCase() ?? ''
}

/**
 * The statement under the cursor (or the last one before it) of a script, for
 * «Plan» without a selection. SQL Server: the statement inside the GO batch.
 */
export function statementAt(dialectId: SqlDialectId, script: string, offset: number): string {
  const locate = (texts: string[], text: string, at: number): string | null => {
    let from = 0
    let before: string | null = null
    for (const t of texts) {
      const start = text.indexOf(t, from)
      if (start < 0) continue
      const end = start + t.length
      if (at >= start && at <= end + 1) return t
      if (at > end) before = t
      from = end
    }
    return before ?? texts[0] ?? null
  }
  const parts = getDialect(dialectId)
    .splitStatements(script)
    .map((s) => s.sql)
    .filter((s) => s.trim())
  const part = locate(parts, script, offset)
  if (!part || dialectId !== 'sqlserver') return part ?? ''
  const base = script.indexOf(part)
  const inner = statementsOfBatch(part).map((s) => s.sql)
  return locate(inner, part, offset - Math.max(0, base)) ?? part
}

/** The one statement to plan, or the Spanish reason it cannot be planned. */
export function planStatement(
  dialectId: SqlDialectId,
  sql: string,
  actual: boolean
): { statement: string } | { problem: string } {
  const dialect = getDialect(dialectId)
  const parts = dialect.splitStatements(sql).filter((s) => s.sql.trim())
  if (!parts.length) return { problem: 'No hay ninguna sentencia para analizar.' }
  const one =
    parts.length === 1 &&
    (dialectId !== 'sqlserver' || statementsOfBatch(parts[0].sql).length === 1)
  if (!one)
    return {
      problem: 'El plan se calcula para una sola sentencia: selecciónala o pon el cursor en ella.'
    }
  const statement = parts[0].sql.trim().replace(/;\s*$/, '')
  const head = firstKeyword(statement)
  if (!PLANNABLE.has(head))
    return {
      problem: `No hay plan de ejecución para ${head || 'esta sentencia'}: solo para SELECT, INSERT, UPDATE, DELETE${dialectId === 'sqlserver' ? ' y MERGE' : ''}.`
    }
  if (actual && (!READS.has(head) || dialect.analyzeWrites(statement).writes))
    return {
      problem:
        'El plan real ejecuta la sentencia, así que solo se ofrece para consultas de solo lectura (SELECT). Usa el plan estimado: no ejecuta nada.'
    }
  return { statement }
}
