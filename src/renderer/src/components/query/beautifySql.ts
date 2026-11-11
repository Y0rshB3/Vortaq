import { format } from 'sql-formatter'
import { formatSql } from './formatSql'

/**
 * sql-formatter's language for each engine. 'sql' (standard SQL) is for text
 * without a connection (an editor document not targeted yet).
 */
export type FormatterDialect = 'mysql' | 'mariadb' | 'postgresql' | 'sqlite' | 'transactsql' | 'sql'

export function formatterDialectOf(engine: string | null | undefined): FormatterDialect {
  switch (engine) {
    case 'mariadb':
      return 'mariadb'
    case 'postgresql':
      return 'postgresql'
    case 'sqlite':
      return 'sqlite'
    case 'sqlserver':
      return 'transactsql'
    case 'mysql':
      return 'mysql'
    default:
      return 'sql'
  }
}

/** A line that ends a T-SQL batch: `GO`, an optional count and an optional `--` comment. */
const GO_LINE = /^\s*GO(?:\s+\d+)?\s*(?:--.*)?$/i

export interface BeautifyResult {
  sql: string
  /** False when the text could not be parsed and only keywords were upper-cased. */
  structured: boolean
}

const DELIMITER_RE = /^\s*DELIMITER\s+(\S+)\s*$/i

/**
 * «Formatear SQL»: one clause per line, clause contents
 * indented with a tab, upper-case keywords, a blank line between statements.
 * Blocks written under a custom DELIMITER (procedures, triggers...) keep their
 * layout and only get keywords upper-cased, because the formatter cannot parse
 * client-side DELIMITER syntax. Unparseable input falls back the same way.
 */
export function beautifySql(sql: string, dialect: FormatterDialect = 'mysql'): BeautifyResult {
  if (!sql.trim()) return { sql, structured: true }
  if (dialect === 'transactsql') return beautifyBatches(sql)
  if (dialect !== 'mysql' && dialect !== 'mariadb') return beautifyPlain(sql, dialect)
  const lines = sql.split('\n')
  if (!lines.some((l) => DELIMITER_RE.test(l))) return beautifyPlain(sql, dialect)

  // Split into segments: plain SQL (formatted) and DELIMITER blocks (kept).
  const out: string[] = []
  let structured = true
  let plain: string[] = []
  let delimiter = ';'
  let block: string[] = []
  const flushPlain = (): void => {
    if (plain.join('\n').trim()) {
      const r = beautifyPlain(plain.join('\n'), dialect)
      structured &&= r.structured
      out.push(r.sql)
    }
    plain = []
  }
  for (const line of lines) {
    const m = DELIMITER_RE.exec(line)
    if (m) {
      if (delimiter === ';') flushPlain()
      else if (block.length) out.push(formatBlock(block, delimiter))
      block = []
      out.push(`DELIMITER ${m[1]}`)
      delimiter = m[1]
      continue
    }
    if (delimiter === ';') plain.push(line)
    else block.push(line)
  }
  if (delimiter === ';') flushPlain()
  else if (block.length) out.push(formatBlock(block, delimiter))
  return { sql: out.join('\n\n'), structured }
}

/** Upper-cases keywords in a DELIMITER block without letting `END$$` hide the keyword. */
function formatBlock(lines: string[], delimiter: string): string {
  const marker = '\u0000'
  const text = lines.join('\n').split(delimiter).join(marker)
  return formatSql(text).split(marker).join(delimiter).trim()
}

/** Fixes sql-formatter quirks: upper-case operators and the layout described above. */
function polish(sql: string): string {
  // Operators such as LIKE/IS/NOT/IN are not always upper-cased by sql-formatter's MySQL dialect.
  const upper = formatSql(sql)
  // `CALL p ()` -> `CALL p()`
  return upper.replace(/\b(CALL\s+(?:`[^`]+`|[\w$]+)(?:\.(?:`[^`]+`|[\w$]+))?)\s+\(/g, '$1(')
}

/**
 * T-SQL: each batch between `GO` lines is formatted on its own (variables live
 * in their batch) and the `GO` lines are kept as written.
 */
function beautifyBatches(sql: string): BeautifyResult {
  const out: string[] = []
  let structured = true
  let batch: string[] = []
  const flush = (): void => {
    const text = batch.join('\n')
    if (text.trim()) {
      const r = beautifyPlain(text, 'transactsql')
      structured &&= r.structured
      out.push(r.sql)
    }
    batch = []
  }
  for (const line of sql.replace(/\r\n/g, '\n').split('\n')) {
    if (GO_LINE.test(line)) {
      flush()
      out.push(line.trim())
    } else batch.push(line)
  }
  flush()
  return { sql: out.join('\n'), structured }
}

function beautifyPlain(sql: string, dialect: FormatterDialect): BeautifyResult {
  const mysqlFamily = dialect === 'mysql' || dialect === 'mariadb'
  try {
    const formatted = format(sql, {
      language: dialect,
      keywordCase: 'upper',
      dataTypeCase: 'upper',
      functionCase: 'upper',
      identifierCase: 'preserve',
      useTabs: true,
      linesBetweenQueries: 1,
      expressionWidth: 60
    })
    return { sql: mysqlFamily ? polish(formatted) : formatted, structured: true }
  } catch {
    // The keyword-only fallback follows MySQL's lexical rules (`#` comments, backticks):
    // other dialects keep their text unchanged.
    return { sql: mysqlFamily ? formatSql(sql) : sql, structured: false }
  }
}
