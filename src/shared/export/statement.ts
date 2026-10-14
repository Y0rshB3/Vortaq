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

export const EXPORT_SESSION_VARIABLES =
  'La consulta usa variables de sesión (@…), que en la sesión nueva del resultado completo están vacías: exporta las filas cargadas.'
export const EXPORT_SESSION_SCRIPT =
  'Otra sentencia del script cambia la sesión o los datos (USE, SET, CREATE…): el resultado completo vuelve a ejecutar solo esta consulta en una sesión nueva y podría no coincidir. Ejecuta la consulta sola o exporta las filas cargadas.'

/** MySQL/MariaDB user variables (`@x`, `@'x'`; not `@@system`) outside strings and comments. */
function usesUserVariables(dialect: SqlDialectId, sql: string): boolean {
  if (dialect !== 'mysql' && dialect !== 'mariadb') return false
  const text = normalize(dialect === 'mariadb' ? sql.split('/*M!').join('/*!') : sql)
  return /(^|[^@\w$])@(?!@)[\w$'"`]/.test(text)
}

export function checkExportStatement(dialect: SqlDialect, script: string): ExportStatementCheck {
  const statements = dialect.splitStatements(script).filter((s) => s.sql.trim() !== '')
  if (statements.length === 0) return { ok: false, reason: 'No hay ninguna consulta que exportar.' }
  if (statements.length > 1) return { ok: false, reason: EXPORT_ONE_STATEMENT }
  const sql = statements[0].sql
  if (!ROW_STATEMENTS[dialect.id].has(leadingWord(dialect.id, sql)))
    return { ok: false, reason: EXPORT_NOT_A_QUERY }
  if (usesUserVariables(dialect.id, sql)) return { ok: false, reason: EXPORT_SESSION_VARIABLES }
  const check = dialect.analyzeWrites(sql)
  if (check.writes || dialect.isObviousWrite(sql))
    return {
      ok: false,
      reason: `La consulta podría modificar datos${check.reasons.length ? ` (${check.reasons.join(', ')})` : ''}: solo se vuelven a ejecutar consultas de solo lectura. Exporta las filas cargadas.`
    }
  return { ok: true, sql }
}

/**
 * The check for one result of a run: its statement must pass checkExportStatement
 * and so must every other statement of the script that produced it, because the
 * full export runs the statement alone in a new session (a `USE`, `SET search_path`
 * or write earlier in the script would not be there, and the rows could differ).
 */
export function checkExportResult(
  dialect: SqlDialect,
  statement: string,
  script?: string | null
): ExportStatementCheck {
  const check = checkExportStatement(dialect, statement)
  if (!check.ok || !script) return check
  const others = dialect.splitStatements(script).filter((s) => s.sql.trim() !== '')
  if (others.length > 1 && others.some((s) => !checkExportStatement(dialect, s.sql).ok))
    return { ok: false, reason: EXPORT_SESSION_SCRIPT }
  return check
}
