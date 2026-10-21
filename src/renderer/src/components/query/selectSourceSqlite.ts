/**
 * SQLite version of selectSource.ts: does a SELECT read one table, or plain
 * tables joined together (no CTE, subquery source, set operation, grouping or
 * DISTINCT)? It uses the shared SQLite lexer (the same tokens as the splitter
 * and the guard) and accepts the three quoting forms ("x", [x], `x`), an
 * attached-database qualifier (`aux.t`) and `INDEXED BY` / `NOT INDEXED`.
 * Identifiers keep their spelling: SQLite names are case-insensitive and the
 * editability check compares them that way. Anything it does not understand
 * is read-only.
 */
import { sqliteCodeTokens, tokenizeSqlite, type SqliteToken } from '@shared/dialects/sqliteLexer'
import {
  REASON_CTE,
  REASON_DERIVED,
  REASON_GROUPED,
  REASON_NO_TABLE,
  REASON_NOT_SIMPLE,
  REASON_SUBQUERY,
  REASON_UNION,
  REASON_UNPARSED,
  aggregateCall,
  joinedTables,
  selectItems,
  type FactorParse,
  type JoinedSelect,
  type SelectSource,
  type TokenReader
} from './selectSource'

const CLAUSE_WORDS = new Set([
  'WHERE',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'GROUP',
  'HAVING',
  'WINDOW',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'JOIN',
  'INNER',
  'CROSS',
  'LEFT',
  'RIGHT',
  'NATURAL',
  'FULL',
  'OUTER',
  'ON',
  'USING',
  'AS',
  'INDEXED',
  'NOT',
  'RETURNING'
])
const JOIN_WORDS = new Set(['JOIN', 'INNER', 'CROSS', 'LEFT', 'RIGHT', 'NATURAL', 'FULL', 'OUTER'])
const TAIL_WORDS = new Set(['WHERE', 'ORDER', 'LIMIT', 'WINDOW'])
const SET_OPS = new Set(['UNION', 'EXCEPT', 'INTERSECT'])
const STOP_WORDS = new Set([...TAIL_WORDS, 'GROUP', 'HAVING', ...SET_OPS])
const MODIFIERS = new Set(['ALL'])

const fail = (reason: string): SelectSource => ({ ok: false, reason })

const upper = (t: SqliteToken | undefined): string =>
  t?.kind === 'word' ? t.value.toUpperCase() : ''
const isPunct = (t: SqliteToken | undefined, text: string): boolean =>
  !!t && (t.kind === 'punct' || t.kind === 'op') && t.value === text

/** A quoted identifier, or an unquoted word that is not a clause keyword. */
function identifier(t: SqliteToken | undefined): string | null {
  if (t?.kind === 'ident') return t.value
  if (t?.kind === 'word' && !CLAUSE_WORDS.has(t.value.toUpperCase())) return t.value
  return null
}

/** `[schema.]table [[AS] alias] [INDEXED BY i | NOT INDEXED]` starting at `start`. */
function tableFactor(tokens: SqliteToken[], start: number): FactorParse {
  let i = start
  if (isPunct(tokens[i], '(')) return { ok: false, reason: REASON_DERIVED }
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
    if (isPunct(tokens[i], '.')) return { ok: false, reason: REASON_UNPARSED }
  }
  // Table-valued function: FROM pragma_table_info('t'), json_each(x)…
  if (isPunct(tokens[i], '(')) return { ok: false, reason: REASON_NOT_SIMPLE }

  let alias: string | null = null
  if (upper(tokens[i]) === 'AS') {
    alias = identifier(tokens[i + 1])
    if (alias === null) return { ok: false, reason: REASON_UNPARSED }
    i += 2
  } else {
    alias = identifier(tokens[i])
    if (alias !== null) i++
  }
  if (upper(tokens[i]) === 'INDEXED' && upper(tokens[i + 1]) === 'BY') {
    if (identifier(tokens[i + 2]) === null && tokens[i + 2]?.kind !== 'word')
      return { ok: false, reason: REASON_UNPARSED }
    i += 3
  } else if (upper(tokens[i]) === 'NOT' && upper(tokens[i + 1]) === 'INDEXED') i += 2
  return { ok: true, ref: { schema, table, alias }, end: i }
}

function reader(tokens: SqliteToken[]): TokenReader {
  return {
    length: tokens.length,
    word: (i) => upper(tokens[i]),
    punct: (i, text) => isPunct(tokens[i], text),
    ident: (i) => identifier(tokens[i]),
    member: (i) => {
      const t = tokens[i]
      return t?.kind === 'ident' || t?.kind === 'word' ? t.value : null
    }
  }
}

export function sqliteSingleTableSelect(sql: string): SelectSource {
  const tokens = sqliteCodeTokens(tokenizeSqlite(sql))
  while (isPunct(tokens[tokens.length - 1], ';')) tokens.pop()
  if (!tokens.length) return fail(REASON_NOT_SIMPLE)
  // Two statements in one: never editable.
  if (tokens.some((t) => isPunct(t, ';'))) return fail(REASON_NOT_SIMPLE)

  const first = upper(tokens[0])
  if (first === 'WITH') return fail(REASON_CTE)
  if (first !== 'SELECT') return fail(REASON_NOT_SIMPLE)
  if (upper(tokens[1]) === 'DISTINCT') return fail(REASON_GROUPED)

  let i = 1
  let depth = 0
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) depth--
    else if (depth === 0 && SET_OPS.has(upper(t))) return fail(REASON_UNION)
    else if (upper(t) === 'SELECT') return fail(REASON_SUBQUERY)
    else if (depth === 0 && upper(t) === 'FROM') break
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
    const items = selectItems(r, 1, fromAt, MODIFIERS)
    if (!items) return fail(REASON_UNPARSED)
    joined = { tables: more.tables, items }
    i = more.end
  }
  const done = (): SelectSource => (joined ? { ok: true, ref, joined } : { ok: true, ref })

  if (i >= tokens.length) return done()
  const next = tokens[i]
  if (upper(next) === 'GROUP' || upper(next) === 'HAVING') return fail(REASON_GROUPED)
  if (SET_OPS.has(upper(next))) return fail(REASON_UNION)
  if (!TAIL_WORDS.has(upper(next))) return fail(REASON_UNPARSED)

  depth = 0
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) depth--
    else if (depth === 0) {
      const word = upper(t)
      if (word === 'GROUP' || word === 'HAVING') return fail(REASON_GROUPED)
      if (SET_OPS.has(word)) return fail(REASON_UNION)
    }
  }
  if (depth !== 0) return fail(REASON_UNPARSED)
  return done()
}
