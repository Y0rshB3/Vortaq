/**
 * Reads the FROM clause of a SELECT statement to tell which table its rows can
 * be edited in: one table reference, or several plain tables joined with JOIN
 * or commas, with no derived table, CTE, grouping or subquery column.
 *
 * Result metadata alone cannot be trusted for in-place editing: once MySQL
 * merges a derived table, a CTE or a view it reports the inner table and
 * column names (orgTable/orgName), which may name a different table, swap
 * columns or hide a self-join. Editing is only offered when the statement text
 * itself reads base tables directly; anything this parser does not understand
 * is treated as read-only. Joined statements also return their tables and
 * select list, so each result column can be tied to the table it comes from.
 *
 * The join and select-list helpers below are shared with the PostgreSQL and
 * SQLite parsers through a TokenReader.
 */

export interface TableRef {
  /** Schema written in the statement (`schema.table`), or null for the default one. */
  schema: string | null
  table: string
  /** Alias given in the statement, or null. */
  alias: string | null
}

/** One item of the select list. */
export type SelectItem =
  /** `*` (qualifier null), `t.*` or `schema.t.*`. */
  | { kind: 'star'; qualifier: string[] | null }
  /** `col`, `t.col` or `schema.t.col`, with or without an alias. */
  | { kind: 'column'; qualifier: string[] | null; name: string }
  /** Anything else: exactly one result column that no table owns. */
  | { kind: 'expression' }

/** A SELECT that joins several tables: every table reference and the select list. */
export interface JoinedSelect {
  tables: TableRef[]
  items: SelectItem[]
}

export type SelectSource =
  | {
      ok: true
      /** The table reference (the first one when the statement joins several). */
      ref: TableRef
      /** Present only when the FROM clause joins several tables. */
      joined?: JoinedSelect
    }
  | { ok: false; reason: string }

type Token =
  | { kind: 'word'; text: string }
  | { kind: 'quoted'; text: string }
  | { kind: 'string' }
  | { kind: 'punct'; text: string }

export const REASON_NOT_SIMPLE = 'la consulta no es un SELECT simple'
export const REASON_UNPARSED = 'no se pudo analizar la consulta'
export const REASON_CTE = 'la consulta usa WITH (CTE)'
export const REASON_SUBQUERY = 'la consulta usa subconsultas'
export const REASON_DERIVED = 'la consulta lee de una subconsulta'
export const REASON_MULTI = 'la consulta usa varias tablas'
export const REASON_GROUPED = 'la consulta agrupa filas'
export const REASON_UNION = 'la consulta combina varios resultados'
export const REASON_NO_TABLE = 'el resultado no proviene directamente de una tabla'

const WORD = /[\p{L}\p{N}_$@]/u

/**
 * Splits a statement into tokens, dropping comments. Returns null for
 * executable comments (`/*! ... *\/`), whose content MySQL runs and which
 * could hide a join, and for unterminated literals.
 */
function tokenize(sql: string): Token[] | null {
  const out: Token[] = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const two = sql.slice(i, i + 2)
    if (/\s/.test(ch)) {
      i++
    } else if (two === '/*') {
      if (sql[i + 2] === '!') return null
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) return null
      i = end + 2
    } else if (ch === '#' || (two === '--' && /\s/.test(sql[i + 2] ?? ' '))) {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? sql.length : end + 1
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      let text = ''
      for (;;) {
        if (j >= sql.length) return null
        if (sql[j] === '\\' && ch !== '`') {
          text += sql.slice(j, j + 2)
          j += 2
        } else if (sql[j] === ch && sql[j + 1] === ch) {
          text += ch
          j += 2
        } else if (sql[j] === ch) break
        else text += sql[j++]
      }
      out.push(ch === '`' ? { kind: 'quoted', text } : { kind: 'string' })
      i = j + 1
    } else if (WORD.test(ch)) {
      let j = i + 1
      while (j < sql.length && WORD.test(sql[j])) j++
      out.push({ kind: 'word', text: sql.slice(i, j) })
      i = j
    } else {
      out.push({ kind: 'punct', text: ch })
      i++
    }
  }
  return out
}

/** Words that end the table factor: never read as an alias. */
const CLAUSE_WORDS = new Set([
  'WHERE',
  'ORDER',
  'LIMIT',
  'GROUP',
  'HAVING',
  'WINDOW',
  'FOR',
  'LOCK',
  'INTO',
  'PROCEDURE',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'JOIN',
  'INNER',
  'CROSS',
  'LEFT',
  'RIGHT',
  'NATURAL',
  'STRAIGHT_JOIN',
  'FULL',
  'OUTER',
  'ON',
  'USING',
  'USE',
  'IGNORE',
  'FORCE',
  'PARTITION',
  'AS',
  'TABLESAMPLE'
])

const JOIN_WORDS = new Set([
  'JOIN',
  'INNER',
  'CROSS',
  'LEFT',
  'RIGHT',
  'NATURAL',
  'STRAIGHT_JOIN',
  'FULL',
  'OUTER'
])

/** Clauses allowed after the table factors. */
const TAIL_WORDS = new Set(['WHERE', 'ORDER', 'LIMIT', 'WINDOW', 'FOR', 'LOCK'])

/** Words that end a join condition, besides a comma or the next join. */
const STOP_WORDS = new Set([
  ...TAIL_WORDS,
  'GROUP',
  'HAVING',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'INTO',
  'PROCEDURE'
])

/** Select modifiers MySQL accepts before the select list. */
const SELECT_MODIFIERS = new Set([
  'ALL',
  'DISTINCT',
  'DISTINCTROW',
  'HIGH_PRIORITY',
  'STRAIGHT_JOIN',
  'SQL_SMALL_RESULT',
  'SQL_BIG_RESULT',
  'SQL_BUFFER_RESULT',
  'SQL_NO_CACHE',
  'SQL_CALC_FOUND_ROWS'
])

const fail = (reason: string): SelectSource => ({ ok: false, reason })

/* ---------- shared with the PostgreSQL and SQLite parsers ---------- */

/** What the shared helpers need from a dialect's tokens. */
export interface TokenReader {
  readonly length: number
  /** Upper-cased bare word at `i`, or ''. */
  word(i: number): string
  punct(i: number, text: string): boolean
  /** Identifier at `i` as the server reads it, or null (clause keywords are not identifiers). */
  ident(i: number): string | null
  /** Name after `qualifier.`: a quoted identifier or any bare word, keywords included. */
  member(i: number): string | null
}

/** One table factor read by a dialect's parser, ending just before `end`. */
export type FactorParse = { ok: true; ref: TableRef; end: number } | { ok: false; reason: string }

export interface JoinRules {
  /** Words that open a join (`LEFT`, `JOIN`…). */
  joinWords: ReadonlySet<string>
  /** Words that end a join condition: the tail clauses, GROUP, set operations… */
  stopWords: ReadonlySet<string>
}

function skipReaderGroup(r: TokenReader, start: number): number {
  let depth = 0
  for (let i = start; i < r.length; i++) {
    if (r.punct(i, '(')) depth++
    else if (r.punct(i, ')') && --depth === 0) return i + 1
  }
  return -1
}

/** Index just past an ON condition that starts at `start`, or -1 when unbalanced. */
function conditionEnd(r: TokenReader, start: number, rules: JoinRules): number {
  let depth = 0
  for (let i = start; i < r.length; i++) {
    if (r.punct(i, '(')) depth++
    else if (r.punct(i, ')')) {
      if (--depth < 0) return -1
    } else if (depth === 0) {
      const word = r.word(i)
      if (r.punct(i, ',') || rules.stopWords.has(word)) return i
      // LEFT(…) and RIGHT(…) are string functions, not joins.
      if (rules.joinWords.has(word) && !r.punct(i + 1, '(')) return i
    }
  }
  return depth === 0 ? r.length : -1
}

/**
 * The rest of a FROM list after its first table: `, t`, `[NATURAL] [INNER |
 * CROSS | LEFT | RIGHT | FULL [OUTER]] JOIN t` or `STRAIGHT_JOIN t`, each with
 * an optional ON or USING condition. Every joined table goes through the
 * dialect's own factor parser, so derived tables and table functions are
 * refused there as they are for the first table. `end` is the first token
 * after the list.
 */
export function joinedTables(
  r: TokenReader,
  first: { ref: TableRef; end: number },
  factor: (at: number) => FactorParse,
  rules: JoinRules
): { ok: true; tables: TableRef[]; end: number } | { ok: false; reason: string } {
  const tables = [first.ref]
  let i = first.end
  for (;;) {
    if (r.punct(i, ',')) i++
    else if (rules.joinWords.has(r.word(i))) {
      while (r.word(i) !== 'JOIN' && r.word(i) !== 'STRAIGHT_JOIN') {
        if (!rules.joinWords.has(r.word(i))) return { ok: false, reason: REASON_UNPARSED }
        i++
      }
      i++
    } else break
    const next = factor(i)
    if (!next.ok) return next
    tables.push(next.ref)
    i = next.end
    if (r.word(i) === 'ON') {
      i = conditionEnd(r, i + 1, rules)
      if (i < 0) return { ok: false, reason: REASON_UNPARSED }
    } else if (r.word(i) === 'USING' && r.punct(i + 1, '(')) {
      i = skipReaderGroup(r, i + 1)
      if (i < 0) return { ok: false, reason: REASON_UNPARSED }
    }
  }
  return { ok: true, tables, end: i }
}

/** True when tokens `i`..`end` are empty or an alias: `[AS] name`. */
function aliasOnly(r: TokenReader, i: number, end: number): boolean {
  if (i === end) return true
  if (r.word(i) === 'AS') return i + 2 === end && r.ident(i + 1) !== null
  return i + 1 === end && r.ident(i) !== null
}

function selectItem(r: TokenReader, start: number, end: number): SelectItem | null {
  if (start >= end) return null
  if (end - start === 1 && r.punct(start, '*')) return { kind: 'star', qualifier: null }
  const head = r.ident(start)
  if (head !== null) {
    const names = [head]
    let i = start + 1
    while (r.punct(i, '.') && i + 1 < end) {
      if (r.punct(i + 1, '*'))
        return i + 2 === end && names.length <= 2 ? { kind: 'star', qualifier: names } : null
      const member = r.member(i + 1)
      if (member === null) break
      names.push(member)
      i += 2
    }
    if (names.length <= 3 && aliasOnly(r, i, end))
      return {
        kind: 'column',
        qualifier: names.length > 1 ? names.slice(0, -1) : null,
        name: names[names.length - 1]
      }
  }
  // An expression is one column, unless it expands a whole row (`(t).*`).
  let depth = 0
  for (let i = start; i < end; i++) {
    if (r.punct(i, '(')) depth++
    else if (r.punct(i, ')')) depth--
    else if (depth === 0 && r.punct(i, '.') && r.punct(i + 1, '*')) return null
  }
  return { kind: 'expression' }
}

/**
 * The select list between `start` (just after SELECT) and `end` (its FROM),
 * item by item, after the leading `modifiers` (DISTINCT…). Null when an item
 * may expand to a number of columns this cannot count (`(t).*`, DISTINCT ON).
 */
export function selectItems(
  r: TokenReader,
  start: number,
  end: number,
  modifiers: ReadonlySet<string>
): SelectItem[] | null {
  let i = start
  if (r.word(i) === 'DISTINCT' && r.word(i + 1) === 'ON') return null
  while (i < end && modifiers.has(r.word(i))) i++
  const items: SelectItem[] = []
  let from = i
  let depth = 0
  for (; i <= end; i++) {
    if (i < end && r.punct(i, '(')) depth++
    else if (i < end && r.punct(i, ')')) depth--
    else if (i === end || (depth === 0 && r.punct(i, ','))) {
      const item = selectItem(r, from, i)
      if (!item) return null
      items.push(item)
      from = i + 1
    }
  }
  return items
}

const AGGREGATES = new Set([
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'GROUP_CONCAT',
  'STRING_AGG',
  'ARRAY_AGG',
  'JSON_AGG',
  'JSONB_AGG',
  'JSON_OBJECT_AGG',
  'JSONB_OBJECT_AGG',
  'JSON_ARRAYAGG',
  'JSON_OBJECTAGG',
  'JSON_GROUP_ARRAY',
  'JSON_GROUP_OBJECT',
  'XMLAGG',
  'BIT_AND',
  'BIT_OR',
  'BIT_XOR',
  'BOOL_AND',
  'BOOL_OR',
  'EVERY',
  'STD',
  'STDDEV',
  'STDDEV_POP',
  'STDDEV_SAMP',
  'VARIANCE',
  'VAR_POP',
  'VAR_SAMP',
  'TOTAL',
  'ANY_VALUE'
])

/**
 * An aggregate call (COUNT(…), SUM(…)…) between `start` and `end` that is not
 * a window function. Without GROUP BY it still folds every row into one, and
 * MySQL may then show columns of different rows side by side.
 */
export function aggregateCall(r: TokenReader, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (!AGGREGATES.has(r.word(i)) || !r.punct(i + 1, '(')) continue
    let close = skipReaderGroup(r, i + 1)
    if (close >= 0 && r.word(close) === 'FILTER' && r.punct(close + 1, '('))
      close = skipReaderGroup(r, close + 1)
    if (close < 0 || r.word(close) !== 'OVER') return true
  }
  return false
}

/* ---------- MySQL / MariaDB ---------- */

function upper(token: Token | undefined): string {
  return token?.kind === 'word' ? token.text.toUpperCase() : ''
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === 'punct' && token.text === text
}

/** Identifier at `token`: a backquoted name or a bare word that is not a clause keyword. */
function identifier(token: Token | undefined): string | null {
  if (token?.kind === 'quoted') return token.text
  if (token?.kind === 'word' && !CLAUSE_WORDS.has(token.text.toUpperCase())) return token.text
  return null
}

/** Index just past the parenthesised group that opens at `start`, or -1 when unbalanced. */
function skipGroup(tokens: Token[], start: number): number {
  let depth = 0
  for (let i = start; i < tokens.length; i++) {
    if (isPunct(tokens[i], '(')) depth++
    else if (isPunct(tokens[i], ')') && --depth === 0) return i + 1
  }
  return -1
}

/** `[schema.]table [PARTITION (…)] [[AS] alias] [index hints]` starting at `start`. */
function tableFactor(tokens: Token[], start: number): FactorParse {
  let i = start
  if (isPunct(tokens[i], '(')) return { ok: false, reason: REASON_DERIVED }
  if (upper(tokens[i]) === 'DUAL') return { ok: false, reason: REASON_NO_TABLE }
  if (upper(tokens[i]) === 'LATERAL' || upper(tokens[i]) === 'JSON_TABLE')
    return { ok: false, reason: REASON_DERIVED }
  const name = identifier(tokens[i])
  if (name === null) return { ok: false, reason: REASON_UNPARSED }
  i++
  let schema: string | null = null
  let table = name
  if (isPunct(tokens[i], '.')) {
    const second = identifier(tokens[i + 1])
    if (second === null) return { ok: false, reason: REASON_UNPARSED }
    schema = name
    table = second
    i += 2
  }
  if (isPunct(tokens[i], '(')) return { ok: false, reason: REASON_NOT_SIMPLE } // table function call

  // PARTITION (p0, ...) only narrows the rows read: edits still go to the table.
  if (upper(tokens[i]) === 'PARTITION' && isPunct(tokens[i + 1], '(')) {
    i = skipGroup(tokens, i + 1)
    if (i < 0) return { ok: false, reason: REASON_UNPARSED }
  }

  // [AS] alias
  let alias: string | null = null
  if (upper(tokens[i]) === 'AS') {
    alias = identifier(tokens[i + 1])
    if (alias === null) return { ok: false, reason: REASON_UNPARSED }
    i += 2
  } else {
    alias = identifier(tokens[i])
    if (alias !== null) i++
  }

  // Index hints: USE|IGNORE|FORCE INDEX|KEY [FOR ...] (...) [, ...]
  for (;;) {
    const hint = upper(tokens[i])
    const isHint =
      (hint === 'USE' || hint === 'IGNORE' || hint === 'FORCE') &&
      (upper(tokens[i + 1]) === 'INDEX' || upper(tokens[i + 1]) === 'KEY')
    if (!isHint) {
      // A comma between two hints is part of the hint list, not a comma join.
      const next = upper(tokens[i + 1])
      if (isPunct(tokens[i], ',') && (next === 'USE' || next === 'IGNORE' || next === 'FORCE')) {
        i++
        continue
      }
      break
    }
    let j = i + 2
    while (j < tokens.length && !isPunct(tokens[j], '(')) j++
    i = skipGroup(tokens, j)
    if (i < 0) return { ok: false, reason: REASON_UNPARSED }
  }
  return { ok: true, ref: { schema, table, alias }, end: i }
}

function reader(tokens: Token[]): TokenReader {
  return {
    length: tokens.length,
    word: (i) => upper(tokens[i]),
    punct: (i, text) => isPunct(tokens[i], text),
    ident: (i) => identifier(tokens[i]),
    member: (i) => {
      const t = tokens[i]
      return t?.kind === 'quoted' || t?.kind === 'word' ? t.text : null
    }
  }
}

export function singleTableSelect(sql: string): SelectSource {
  const tokens = tokenize(sql)
  if (!tokens) return fail(REASON_UNPARSED)
  while (isPunct(tokens[tokens.length - 1], ';')) tokens.pop()
  if (!tokens.length) return fail(REASON_NOT_SIMPLE)

  const first = upper(tokens[0])
  if (first === 'WITH') return fail(REASON_CTE)
  if (first !== 'SELECT') return fail(REASON_NOT_SIMPLE)

  // Select list: up to the first FROM outside parentheses.
  let i = 1
  let depth = 0
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) depth--
    else if (depth === 0 && ['UNION', 'EXCEPT', 'INTERSECT'].includes(upper(t)))
      return fail(REASON_UNION)
    else if (upper(t) === 'SELECT') return fail(REASON_SUBQUERY)
    else if (depth === 0 && upper(t) === 'FROM') break
    else if (depth === 0 && upper(t) === 'INTO') return fail(REASON_NOT_SIMPLE)
  }
  if (i >= tokens.length) return fail(REASON_NO_TABLE)
  const fromAt = i
  const r = reader(tokens)
  if (aggregateCall(r, 1, fromAt)) return fail(REASON_GROUPED)

  const factor = tableFactor(tokens, fromAt + 1)
  if (!factor.ok) return factor
  const { ref } = factor
  i = factor.end

  let joined: JoinedSelect | undefined
  if (isPunct(tokens[i], ',') || JOIN_WORDS.has(upper(tokens[i]))) {
    const more = joinedTables(r, factor, (at) => tableFactor(tokens, at), {
      joinWords: JOIN_WORDS,
      stopWords: STOP_WORDS
    })
    if (!more.ok) return more
    const items = selectItems(r, 1, fromAt, SELECT_MODIFIERS)
    if (!items) return fail(REASON_UNPARSED)
    joined = { tables: more.tables, items }
    i = more.end
  }
  const done = (): SelectSource => (joined ? { ok: true, ref, joined } : { ok: true, ref })

  if (i >= tokens.length) return done()
  const next = tokens[i]
  if (upper(next) === 'GROUP' || upper(next) === 'HAVING') return fail(REASON_GROUPED)
  if (['UNION', 'EXCEPT', 'INTERSECT'].includes(upper(next))) return fail(REASON_UNION)
  if (!TAIL_WORDS.has(upper(next))) return fail(REASON_UNPARSED)

  // Tail (WHERE / ORDER BY / LIMIT / locking): subqueries there only filter or order rows.
  depth = 0
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) depth--
    else if (depth === 0) {
      const word = upper(t)
      if (word === 'GROUP' || word === 'HAVING') return fail(REASON_GROUPED)
      if (word === 'UNION' || word === 'EXCEPT' || word === 'INTERSECT') return fail(REASON_UNION)
      if (word === 'INTO') return fail(REASON_NOT_SIMPLE)
    }
  }
  if (depth !== 0) return fail(REASON_UNPARSED)
  return done()
}
