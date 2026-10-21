/**
 * PostgreSQL version of selectSource.ts: does a SELECT read one table, or
 * plain tables joined together (no CTE, subquery source or set operation)? It
 * uses the
 * shared PostgreSQL lexer (the same tokens as the splitter and the guard),
 * folds unquoted identifiers to lower case like the server, and accepts
 * PostgreSQL's tail clauses (OFFSET, FETCH, FOR UPDATE…). Anything it does
 * not understand is read-only.
 */
import { codeTokens, tokenizePg, type PgToken } from '@shared/dialects/pgLexer'
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
  'FETCH',
  'GROUP',
  'HAVING',
  'WINDOW',
  'FOR',
  'INTO',
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
  'TABLESAMPLE',
  'LATERAL'
])
const JOIN_WORDS = new Set(['JOIN', 'INNER', 'CROSS', 'LEFT', 'RIGHT', 'NATURAL', 'FULL', 'OUTER'])
const TAIL_WORDS = new Set(['WHERE', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'WINDOW', 'FOR'])
const SET_OPS = new Set(['UNION', 'EXCEPT', 'INTERSECT'])
const STOP_WORDS = new Set([...TAIL_WORDS, 'GROUP', 'HAVING', ...SET_OPS, 'INTO'])
const MODIFIERS = new Set(['ALL', 'DISTINCT'])

const fail = (reason: string): SelectSource => ({ ok: false, reason })

const upper = (t: PgToken | undefined): string => (t?.kind === 'word' ? t.value.toUpperCase() : '')
const isPunct = (t: PgToken | undefined, text: string): boolean =>
  !!t && (t.kind === 'punct' || t.kind === 'op') && t.value === text

/** Identifier as the server sees it: quoted kept, unquoted folded to lower case. */
function identifier(t: PgToken | undefined): string | null {
  if (t?.kind === 'ident') return t.value
  if (t?.kind === 'word' && !CLAUSE_WORDS.has(t.value.toUpperCase())) return t.value.toLowerCase()
  return null
}

/** `[ONLY] [schema.]table [*] [[AS] alias]` starting at `start`. */
function tableFactor(tokens: PgToken[], start: number): FactorParse {
  let i = start
  if (upper(tokens[i]) === 'ONLY') i++
  if (isPunct(tokens[i], '(')) return { ok: false, reason: REASON_DERIVED }
  if (upper(tokens[i]) === 'LATERAL' || upper(tokens[i]) === 'ROWS')
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
    // database.schema.table: cross-database references do not exist in PostgreSQL
    if (isPunct(tokens[i], '.')) return { ok: false, reason: REASON_UNPARSED }
  }
  if (isPunct(tokens[i], '(')) return { ok: false, reason: REASON_NOT_SIMPLE } // set-returning function
  if (isPunct(tokens[i], '*')) i++ // FROM t * (inheritance, the default)

  let alias: string | null = null
  if (upper(tokens[i]) === 'AS') {
    alias = identifier(tokens[i + 1])
    if (alias === null) return { ok: false, reason: REASON_UNPARSED }
    i += 2
  } else {
    alias = identifier(tokens[i])
    if (alias !== null) i++
  }
  // Column alias list `t (a, b)` renames columns: the result no longer maps 1:1.
  if (isPunct(tokens[i], '(')) return { ok: false, reason: REASON_NOT_SIMPLE }
  return { ok: true, ref: { schema, table, alias }, end: i }
}

function reader(tokens: PgToken[]): TokenReader {
  return {
    length: tokens.length,
    word: (i) => upper(tokens[i]),
    punct: (i, text) => isPunct(tokens[i], text),
    ident: (i) => identifier(tokens[i]),
    member: (i) => {
      const t = tokens[i]
      if (t?.kind === 'ident') return t.value
      return t?.kind === 'word' ? t.value.toLowerCase() : null
    }
  }
}

export function pgSingleTableSelect(sql: string): SelectSource {
  let tokens: PgToken[]
  try {
    tokens = codeTokens(tokenizePg(sql))
  } catch {
    return fail(REASON_UNPARSED)
  }
  if (tokens.some((t) => t.kind === 'meta')) return fail(REASON_UNPARSED)
  while (isPunct(tokens[tokens.length - 1], ';')) tokens.pop()
  if (!tokens.length) return fail(REASON_NOT_SIMPLE)

  const first = upper(tokens[0])
  if (first === 'WITH') return fail(REASON_CTE)
  if (first !== 'SELECT') return fail(REASON_NOT_SIMPLE)

  let i = 1
  let depth = 0
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) depth--
    else if (depth === 0 && SET_OPS.has(upper(t))) return fail(REASON_UNION)
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
  if (upper(next) === 'TABLESAMPLE') return fail(REASON_NOT_SIMPLE)
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
      if (word === 'INTO') return fail(REASON_NOT_SIMPLE)
    }
  }
  if (depth !== 0) return fail(REASON_UNPARSED)
  return done()
}
