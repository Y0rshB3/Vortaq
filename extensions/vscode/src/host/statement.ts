/**
 * What «Ejecutar» runs in a SQL document: the selection, else the statement
 * under the cursor, else the whole document. Statements come from the
 * connection's dialect splitter (the same one the core uses), so a `;`
 * inside a string, a comment, a dollar-quoted body or a DELIMITER block never
 * cuts a statement. Pure: no `vscode` import.
 */
import type { SqlDialect, SqlStatement } from '@core'

export interface StatementRange {
  /** Statement text as the splitter returns it (what the engine runs). */
  sql: string
  /** Offsets into the document text: [start, end). */
  start: number
  end: number
}

/** Offset of the first character of each 1-based line. */
function lineOffsets(text: string): number[] {
  const offsets = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1)
  return offsets
}

/**
 * Document ranges of the statements of `text`. The splitter gives each
 * statement's text and first line; the text is searched from that line, and a
 * statement the splitter rewrote (none of today's dialects do) falls back to
 * the lines up to the next statement.
 */
export function statementRanges(
  text: string,
  statements: readonly SqlStatement[]
): StatementRange[] {
  const lines = lineOffsets(text)
  const lineStart = (line: number): number =>
    lines[Math.min(Math.max(line, 1), lines.length) - 1] ?? 0
  const ranges: StatementRange[] = []
  let cursor = 0
  statements.forEach((statement, i) => {
    const from = Math.max(cursor, lineStart(statement.startLine))
    const at = statement.sql ? text.indexOf(statement.sql, from) : -1
    if (at >= 0) {
      ranges.push({ sql: statement.sql, start: at, end: at + statement.sql.length })
      cursor = at + statement.sql.length
      return
    }
    const next = statements[i + 1]
    const end = next ? lineStart(next.startLine) : text.length
    ranges.push({ sql: statement.sql, start: from, end: Math.max(from, end) })
    cursor = Math.max(from, end)
  })
  return ranges
}

/**
 * The statement under `offset`: the one that contains it; else the one that
 * ends earlier on the same line (the cursor right after `;`); else the next
 * one (the cursor on a blank or comment line before it); else the last one.
 * Null when the text has no statement.
 */
export function statementAt(
  text: string,
  ranges: readonly StatementRange[],
  offset: number
): StatementRange | null {
  if (!ranges.length) return null
  const inside = ranges.find((r) => offset >= r.start && offset <= r.end)
  if (inside) return inside
  let before: StatementRange | null = null
  for (const r of ranges) if (r.end <= offset) before = r
  if (before && !text.slice(before.end, offset).includes('\n')) return before
  return ranges.find((r) => r.start >= offset) ?? before ?? ranges[0]
}

export interface RunTarget {
  /** SQL sent to the engine. */
  sql: string
  /** Document range that was picked (for the brief highlight). */
  start: number
  end: number
  kind: 'selection' | 'statement' | 'document'
}

/**
 * What «Ejecutar» sends. A selection runs as written; the statement under the
 * cursor runs as the splitter returned it; with no statement (empty or only
 * comments) the whole document goes, so the server reports what it sees.
 */
export function runTarget(
  text: string,
  selection: { start: number; end: number },
  dialect: Pick<SqlDialect, 'id' | 'splitStatements'>
): RunTarget | null {
  if (selection.end > selection.start) {
    const sql = text.slice(selection.start, selection.end)
    if (sql.trim()) return { sql, start: selection.start, end: selection.end, kind: 'selection' }
  }
  const ranges = statementRanges(text, dialect.splitStatements(text))
  const statement = statementAt(text, ranges, selection.start)
  if (statement && statement.sql.trim())
    return {
      sql: wrapForSingleStatement(statement.sql, dialect),
      start: statement.start,
      end: statement.end,
      kind: 'statement'
    }
  return text.trim() ? { sql: text, start: 0, end: text.length, kind: 'document' } : null
}

/** Delimiters tried, in order, for a MySQL statement that holds `;` (a routine body). */
const DELIMITERS = ['$$', '//', ';;', '$$$', '@@']

/**
 * A MySQL/MariaDB statement that came out of a DELIMITER block (CREATE
 * PROCEDURE … BEGIN …; …; END) has inner semicolons: sent alone, the core
 * would split it again at each one. It is wrapped back into a DELIMITER block
 * the splitter turns into exactly that one statement. Other dialects keep
 * bodies together on their own (dollar quotes, trigger BEGIN … END).
 */
export function wrapForSingleStatement(
  sql: string,
  dialect: Pick<SqlDialect, 'id' | 'splitStatements'>
): string {
  if (dialect.id !== 'mysql' && dialect.id !== 'mariadb') return sql
  if (dialect.splitStatements(sql).length <= 1) return sql
  const delimiter = DELIMITERS.find((d) => !sql.includes(d))
  if (!delimiter) return sql
  return `DELIMITER ${delimiter}\n${sql}\n${delimiter}\nDELIMITER ;\n`
}
