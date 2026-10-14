/**
 * Which statements «Exportar resultado completo» may run again: exactly one
 * statement, that returns rows, that the dialect's allowlist (analyzeWrites)
 * proves read-only and that main's denylist does not flag. Main checks it
 * before opening the read-only session; the renderer uses it to offer (or
 * explain why not) the full export. When in doubt it refuses.
 */
import { normalize } from '../dialects/mysql'
import { codeTokens, tokenizePg } from '../dialects/pgLexer'
import { sqliteCodeTokens, tokenizeSqlite } from '../dialects/sqliteLexer'
import type { SqlDialect, SqlDialectId } from '../dialects/types'

export type ExportStatementCheck = { ok: true; sql: string } | { ok: false; reason: string }

/** Leading keywords of statements that return rows, per dialect. */
const ROW_STATEMENTS: Record<SqlDialectId, ReadonlySet<string>> = {
  mysql: new Set(['SELECT', 'WITH', 'TABLE', 'VALUES', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN']),
  mariadb: new Set(['SELECT', 'WITH', 'TABLE', 'VALUES', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN']),
  postgresql: new Set(['SELECT', 'WITH', 'TABLE', 'VALUES', 'SHOW', 'EXPLAIN']),
  sqlite: new Set(['SELECT', 'WITH', 'VALUES', 'PRAGMA', 'EXPLAIN'])
}

/** First keyword of a statement (comments skipped, executable comments unwrapped, `(` skipped). */
export function leadingWord(dialect: SqlDialectId, sql: string): string {
  if (dialect === 'mysql' || dialect === 'mariadb') {
    const text = normalize(dialect === 'mariadb' ? sql.split('/*M!').join('/*!') : sql)
    const m = /^[\s(]*([A-Za-z]+)/.exec(text)
    return m ? m[1].toUpperCase() : ''
  }
  const tokens =
    dialect === 'postgresql' ? codeTokens(tokenizePg(sql)) : sqliteCodeTokens(tokenizeSqlite(sql))
  const first = tokens.find((t) => !(t.kind === 'punct' && t.value === '('))
  return first && first.kind === 'word' ? first.value.toUpperCase() : ''
}

export const EXPORT_ONE_STATEMENT =
  'El resultado completo solo se puede exportar de una única sentencia: ejecuta la consulta sola o exporta las filas cargadas.'
export const EXPORT_NOT_A_QUERY =
  'Solo se puede exportar completo el resultado de una consulta de lectura (SELECT, WITH, SHOW…).'

export function checkExportStatement(dialect: SqlDialect, script: string): ExportStatementCheck {
  const statements = dialect.splitStatements(script).filter((s) => s.sql.trim() !== '')
  if (statements.length === 0) return { ok: false, reason: 'No hay ninguna consulta que exportar.' }
  if (statements.length > 1) return { ok: false, reason: EXPORT_ONE_STATEMENT }
  const sql = statements[0].sql
  if (!ROW_STATEMENTS[dialect.id].has(leadingWord(dialect.id, sql)))
    return { ok: false, reason: EXPORT_NOT_A_QUERY }
  const check = dialect.analyzeWrites(sql)
  if (check.writes || dialect.isObviousWrite(sql))
    return {
      ok: false,
      reason: `La consulta podría modificar datos${check.reasons.length ? ` (${check.reasons.join(', ')})` : ''}: solo se vuelven a ejecutar consultas de solo lectura. Exporta las filas cargadas.`
    }
  return { ok: true, sql }
}
