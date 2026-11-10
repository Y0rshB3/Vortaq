/**
 * SQL Server version of selectSource.ts: does a SELECT read one table, or
 * plain tables joined together (no CTE, subquery source, APPLY, set
 * operation, grouping, DISTINCT or INTO)? It uses the shared T-SQL lexer (the
 * same tokens as the GO splitter and the guard) and accepts [x] and "x"
 * quoting, `TOP (n)`, table hints (`WITH (NOLOCK)`) and `OPTION (…)`.
 * Temporary tables (#t) and table variables (@t) live in the query tab's own
 * session and three-part names in another database: they are read-only, like
 * anything it does not understand.
 */
import { tokenizeTsql, tsqlCodeTokens, type MsToken } from '@shared/dialects/sqlserverLexer'
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

export const REASON_TEMP_TABLE = 'la consulta lee una tabla temporal o una variable de tabla'
export const REASON_OTHER_DATABASE = 'la tabla está en otra base de datos'

const CLAUSE_WORDS = new Set([
  'WHERE',
  'ORDER',
  'GROUP',
  'HAVING',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'JOIN',
  'INNER',
  'CROSS',
  'LEFT',
  'RIGHT',
  'FULL',
  'OUTER',
  'ON',
  'AS',
  'WITH',
  'OPTION',
  'FOR',
  'APPLY',
  'PIVOT',
  'UNPIVOT',
  'TABLESAMPLE',
  'OFFSET',
  'FETCH',
  'INTO',
  'FROM'
])
const JOIN_WORDS = new Set(['JOIN', 'INNER', 'CROSS', 'LEFT', 'RIGHT', 'FULL', 'OUTER'])
const TAIL_WORDS = new Set(['WHERE', 'ORDER', 'OPTION'])
const SET_OPS = new Set(['UNION', 'EXCEPT', 'INTERSECT'])
const STOP_WORDS = new Set([...TAIL_WORDS, 'GROUP', 'HAVING', ...SET_OPS, 'FOR'])
const MODIFIERS = new Set(['ALL'])

const fail = (reason: string): SelectSource => ({ ok: false, reason })

const upper = (t: MsToken | undefined): string => (t?.kind === 'word' ? t.value.toUpperCase() : '')
const isPunct = (t: MsToken | undefined, text: string): boolean =>
  !!t && (t.kind === 'punct' || t.kind === 'op') && t.value === text

/** A quoted identifier, or an unquoted word that is not a clause keyword. */
function identifier(t: MsToken | undefined): string | null {
  if (t?.kind === 'ident') return t.value
  if (t?.kind === 'word' && !CLAUSE_WORDS.has(t.value.toUpperCase())) return t.value
  return null
}

/** Index after a balanced `( … )` starting at `at`, or -1. */
function skipGroup(tokens: MsToken[], at: number): number {
  let depth = 0
  for (let i = at; i < tokens.length; i++) {
    if (isPunct(tokens[i], '(')) depth++
    else if (isPunct(tokens[i], ')') && --depth === 0) return i + 1
  }
  return -1
}

/** `[schema.]table [[AS] alias] [WITH (hints)]` starting at `start`. */
function tableFactor(tokens: MsToken[], start: number): FactorParse {
  let i = start
  if (isPunct(tokens[i], '(')) return { ok: false, reason: REASON_DERIVED }
  if (tokens[i]?.kind === 'variable') return { ok: false, reason: REASON_TEMP_TABLE }
  const parts: string[] = []
  for (;;) {
    const name = identifier(tokens[i])
    if (name === null) return { ok: false, reason: REASON_UNPARSED }
    parts.push(name)
    i++
    if (!isPunct(tokens[i], '.')) break
    i++
  }
  if (parts.length > 2) return { ok: false, reason: REASON_OTHER_DATABASE }
  const table = parts[parts.length - 1]
  const schema = parts.length === 2 ? parts[0] : null
  if (table.startsWith('#')) return { ok: false, reason: REASON_TEMP_TABLE }
  // Table-valued function: FROM dbo.fn(1), OPENJSON(…)…
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
  if (upper(tokens[i]) === 'TABLESAMPLE') return { ok: false, reason: REASON_NOT_SIMPLE }
  if (upper(tokens[i]) === 'WITH' && isPunct(tokens[i + 1], '(')) {
    const end = skipGroup(tokens, i + 1)
    if (end < 0) return { ok: false, reason: REASON_UNPARSED }
    i = end
  }
  return { ok: true, ref: { schema, table, alias }, end: i }
}

function reader(tokens: MsToken[]): TokenReader {
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

/** Index of the first select item: after `SELECT [ALL] [TOP (n) [PERCENT] [WITH TIES]]`. */
function itemsStart(tokens: MsToken[]): number {
  let i = 1
  if (upper(tokens[i]) === 'ALL') i++
  if (upper(tokens[i]) !== 'TOP') return i
  i++
  if (isPunct(tokens[i], '(')) {
    const end = skipGroup(tokens, i)
    if (end < 0) return -1
    i = end
  } else i++
  if (upper(tokens[i]) === 'PERCENT') i++
  if (upper(tokens[i]) === 'WITH' && upper(tokens[i + 1]) === 'TIES') i += 2
  return i
}

export function msSingleTableSelect(sql: string): SelectSource {
  const tokens = tsqlCodeTokens(tokenizeTsql(sql))
  while (isPunct(tokens[tokens.length - 1], ';')) tokens.pop()
  if (!tokens.length) return fail(REASON_NOT_SIMPLE)
  if (tokens.some((t) => isPunct(t, ';'))) return fail(REASON_NOT_SIMPLE)

  const first = upper(tokens[0])
  if (first === 'WITH') return fail(REASON_CTE)
  if (first !== 'SELECT') return fail(REASON_NOT_SIMPLE)
  if (upper(tokens[1]) === 'DISTINCT') return fail(REASON_GROUPED)
  const start = itemsStart(tokens)
  if (start < 0) return fail(REASON_UNPARSED)

  let i = start
  let depth = 0
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) depth--
    else if (depth === 0 && SET_OPS.has(upper(t))) return fail(REASON_UNION)
    else if (upper(t) === 'SELECT') return fail(REASON_SUBQUERY)
    else if (depth === 0 && upper(t) === 'INTO') return fail(REASON_NOT_SIMPLE)
    else if (depth === 0 && upper(t) === 'FROM') break
  }
  if (i >= tokens.length) return fail(REASON_NO_TABLE)
  const fromAt = i
  const r = reader(tokens)
  if (aggregateCall(r, start, fromAt)) return fail(REASON_GROUPED)

  const factor = tableFactor(tokens, fromAt + 1)
  if (!factor.ok) return factor
  const { ref } = factor
  i = factor.end

  if (
    (upper(tokens[i]) === 'CROSS' || upper(tokens[i]) === 'OUTER') &&
    upper(tokens[i + 1]) === 'APPLY'
  )
    return fail(REASON_DERIVED)
  let joined: JoinedSelect | undefined
  if (isPunct(tokens[i], ',') || JOIN_WORDS.has(upper(tokens[i]))) {
    const more = joinedTables(r, factor, (at) => tableFactor(tokens, at), {
      joinWords: JOIN_WORDS,
      stopWords: STOP_WORDS
    })
    if (!more.ok) return more
    const items = selectItems(r, start, fromAt, MODIFIERS)
    if (!items) return fail(REASON_UNPARSED)
    joined = { tables: more.tables, items }
    i = more.end
  }
  const done = (): SelectSource => (joined ? { ok: true, ref, joined } : { ok: true, ref })

  if (i >= tokens.length) return done()
  const next = tokens[i]
  if (upper(next) === 'GROUP' || upper(next) === 'HAVING') return fail(REASON_GROUPED)
  if (SET_OPS.has(upper(next))) return fail(REASON_UNION)
  if (upper(next) === 'CROSS' || upper(next) === 'OUTER' || upper(next) === 'APPLY')
    return fail(REASON_DERIVED)
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
      // FOR XML / FOR JSON turn the rows into one document.
      if (word === 'FOR' && upper(tokens[i + 1]) !== 'BROWSE') return fail(REASON_NOT_SIMPLE)
    }
  }
  if (depth !== 0) return fail(REASON_UNPARSED)
  return done()
}
