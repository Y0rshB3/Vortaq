/**
 * PostgreSQL dialect (docs/multi-engine-design.md, sections 6 and 10). Every
 * function reads the same token stream (pgLexer.ts), so the splitter, both
 * production-guard functions and the destructive-statement check agree on
 * what is a string, a comment or a dollar-quoted body.
 *
 * - splitStatements: psql rules: `;` ends a statement only outside quotes,
 *   comments, parentheses and `BEGIN ATOMIC … END` bodies; a psql
 *   meta-command (`\copy`, `\d`…) is returned as its own statement so the
 *   driver can refuse it with a message.
 * - isObviousWrite (main): small denylist on the leading keyword.
 * - analyzeWrites (renderer): allowlist. A statement is a read only if it is
 *   provably read-only; anything else is a write with a Spanish reason. A call
 *   to a function with side effects (pg_terminate_backend, set_config,
 *   nextval…) makes any statement a write.
 */
import { codeTokens, tokenizePg, type PgToken } from './pgLexer'
import type {
  DestructiveStatementInfo,
  LexRules,
  SqlDialect,
  SqlStatement,
  WriteCheck
} from './types'

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

/**
 * Keywords that cannot be used as an unquoted identifier everywhere (reserved,
 * reserved-but-function/type and column-name keywords of the PostgreSQL 17
 * keyword appendix). Over-quoting is always valid, so the list errs wide.
 */
export const PG_RESERVED: ReadonlySet<string> = new Set(
  (
    'all analyse analyze and any array as asc asymmetric authorization between bigint binary bit ' +
    'boolean both case cast char character check coalesce collate collation column concurrently ' +
    'constraint create cross current_catalog current_date current_role current_schema current_time ' +
    'current_timestamp current_user dec decimal default deferrable desc distinct do else end except ' +
    'exists extract false fetch float for foreign freeze from full grant greatest group grouping ' +
    'having ilike in initially inner inout int integer intersect interval into is isnull join ' +
    'json json_array json_arrayagg json_exists json_object json_objectagg json_query json_scalar ' +
    'json_serialize json_table json_value lateral leading least left like limit localtime ' +
    'localtimestamp merge_action national natural nchar none normalize not notnull null nullif ' +
    'numeric offset on only or order out outer overlaps overlay placing position precision primary ' +
    'real references returning right row select session_user setof similar smallint some substring ' +
    'symmetric system_user table tablesample then time timestamp to trailing treat trim true union ' +
    'unique user using values varchar variadic verbose when where window with xmlattributes ' +
    'xmlconcat xmlelement xmlexists xmlforest xmlnamespaces xmlparse xmlpi xmlroot xmlserialize ' +
    'xmltable'
  ).split(' ')
)

const PLAIN_IDENT = /^[a-z_][a-z0-9_$]*$/

/** `users` stays bare; `Users`, `user`, `a b` and `a"b` are double-quoted. */
export function quoteIdent(name: string): string {
  if (PLAIN_IDENT.test(name) && !PG_RESERVED.has(name)) return name
  return '"' + name.replace(/"/g, '""') + '"'
}

/** Standard string literal (standard_conforming_strings = on: backslashes are plain). */
export function quoteString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

export function qualified(schema: string | null | undefined, name: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name)
}

// ---------------------------------------------------------------------------
// Splitter
// ---------------------------------------------------------------------------

const upperOf = (t: PgToken | undefined): string =>
  t && t.kind === 'word' ? t.value.toUpperCase() : ''

export function splitStatements(script: string): SqlStatement[] {
  const src = script.replace(/\r\n/g, '\n')
  const tokens = tokenizePg(src)
  const out: SqlStatement[] = []
  let start = 0 // offset where the current statement text starts
  let first: PgToken | null = null // first code token of the current statement
  let depth = 0
  let atomic = 0 // BEGIN ATOMIC … END nesting (SQL-standard routine bodies)
  let prevWord = ''

  const flush = (end: number): void => {
    if (first) {
      const sql = src.slice(start, end).trim()
      if (sql) out.push({ sql, startLine: first.line })
    }
    first = null
    depth = 0
    atomic = 0
    prevWord = ''
  }

  for (const t of tokens) {
    if (t.kind === 'meta') {
      flush(t.start)
      out.push({ sql: t.value, startLine: t.line })
      start = t.end
      continue
    }
    if (t.kind === 'comment') continue
    if (t.kind === 'punct' && t.value === ';' && depth === 0 && atomic === 0) {
      flush(t.start)
      start = t.end
      continue
    }
    if (!first) first = t
    if (t.kind === 'punct') {
      if (t.value === '(' || t.value === '[') depth++
      else if ((t.value === ')' || t.value === ']') && depth > 0) depth--
    } else if (t.kind === 'word') {
      const w = t.value.toUpperCase()
      if (w === 'ATOMIC' && prevWord === 'BEGIN') atomic++
      else if (atomic > 0 && w === 'CASE') atomic++
      else if (atomic > 0 && w === 'END') atomic--
      prevWord = w
    }
  }
  flush(src.length)
  return out
}

// ---------------------------------------------------------------------------
// Statement analysis helpers
// ---------------------------------------------------------------------------

/** Code tokens of a statement without the leading `(` of `(SELECT …)` and a trailing `;`. */
function body(statement: string): PgToken[] {
  const code = codeTokens(tokenizePg(statement))
  let i = 0
  while (code[i]?.kind === 'punct' && code[i].value === '(') i++
  let end = code.length
  while (end > i && code[end - 1].kind === 'punct' && code[end - 1].value === ';') end--
  return code.slice(i, end)
}

/** Depth of every token (inside how many parentheses/brackets it sits). */
function depths(tokens: PgToken[]): number[] {
  const out: number[] = []
  let d = 0
  for (const t of tokens) {
    if (t.kind === 'punct' && (t.value === ')' || t.value === ']')) d = Math.max(0, d - 1)
    out.push(d)
    if (t.kind === 'punct' && (t.value === '(' || t.value === '[')) d++
  }
  return out
}

const isWord = (t: PgToken | undefined, ...words: string[]): boolean =>
  !!t && t.kind === 'word' && words.includes(t.value.toUpperCase())

/** Index of the first depth-0 word among `words` at or after `from`, or -1. */
function topLevelWord(tokens: PgToken[], d: number[], words: string[], from = 0): number {
  for (let i = from; i < tokens.length; i++) if (d[i] === 0 && isWord(tokens[i], ...words)) return i
  return -1
}

const LOCK_PREFIX = new Set(['FOR', 'KEY', 'NO'])

/** True when tokens[i] starts a data-modifying statement (not a FOR UPDATE lock clause). */
function startsDml(tokens: PgToken[], i: number): boolean {
  const w = upperOf(tokens[i])
  if (w === 'INSERT') return isWord(tokens[i + 1], 'INTO')
  if (w === 'DELETE') return isWord(tokens[i + 1], 'FROM')
  if (w === 'MERGE') return isWord(tokens[i + 1], 'INTO')
  if (w === 'UPDATE') {
    if (LOCK_PREFIX.has(upperOf(tokens[i - 1]))) return false
    // ON CONFLICT … DO UPDATE belongs to an INSERT, which is detected on its own.
    if (isWord(tokens[i - 1], 'DO')) return false
    const next = tokens[i + 1]
    return !!next && (next.kind === 'word' || next.kind === 'ident')
  }
  return false
}

/** Tokens from `i` to the end of its parenthesis level. */
function sliceLevel(tokens: PgToken[], d: number[], i: number): PgToken[] {
  const level = d[i]
  let j = i
  while (j < tokens.length && !(d[j] < level)) j++
  return tokens.slice(i, j)
}

/** "DELETE" or "DELETE sin WHERE" (same for UPDATE) for a DML statement body. */
function dmlReason(tokens: PgToken[]): { reason: string; allRows: boolean } {
  const d = depths(tokens)
  const w = upperOf(tokens[0])
  if (w === 'DELETE' || w === 'UPDATE') {
    const allRows = topLevelWord(tokens, d, ['WHERE']) < 0
    return { reason: allRows ? `${w} sin WHERE` : w, allRows }
  }
  return { reason: w, allRows: false }
}

// ---------------------------------------------------------------------------
// Function denylist
// ---------------------------------------------------------------------------

const SIDE_EFFECT_FUNCTIONS = new Set([
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'set_config',
  'dblink_exec',
  'dblink',
  'dblink_connect',
  'dblink_connect_u',
  'dblink_send_query',
  'nextval',
  'setval',
  'pg_switch_wal',
  'pg_create_restore_point',
  'pg_promote',
  'pg_backup_start',
  'pg_backup_stop',
  'pg_wal_replay_pause',
  'pg_wal_replay_resume',
  'pg_log_backend_memory_contexts',
  // Run the SQL text they receive (a side effect inside the string is invisible here).
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'cursor_to_xml',
  'cursor_to_xmlschema',
  // Wakes the session's listeners (and their jobs), also in a read-only transaction.
  'pg_notify'
])

const SIDE_EFFECT_PREFIXES = [
  /^pg_advisory_/,
  /^pg_try_advisory_/,
  /^lo_/,
  /^pg_.*file/,
  /^pg_ls_/,
  /^pg_stat_reset/,
  /^dblink/,
  /^pg_create_.*replication_slot/,
  /^pg_drop_replication_slot/,
  /^pg_replication_origin_/,
  /^pg_import_system_collations/
]

export function isSideEffectFunction(name: string): boolean {
  const n = name.toLowerCase()
  return SIDE_EFFECT_FUNCTIONS.has(n) || SIDE_EFFECT_PREFIXES.some((re) => re.test(n))
}

/** Names of side-effect functions called in the statement (strings and comments never count). */
function sideEffectCalls(tokens: PgToken[]): string[] {
  const found: string[] = []
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]
    if (t.kind !== 'word' && t.kind !== 'ident') continue
    const next = tokens[i + 1]
    if (next.kind !== 'punct' || next.value !== '(') continue
    if (isSideEffectFunction(t.value) && !found.includes(t.value.toLowerCase()))
      found.push(t.value.toLowerCase())
  }
  return found
}

// ---------------------------------------------------------------------------
// Renderer allowlist (analyzeWrites)
// ---------------------------------------------------------------------------

/** Session settings a read-only user may change: they only affect this session's reads. */
const READ_SETTINGS = new Set([
  'search_path',
  'statement_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
  'idle_session_timeout',
  'transaction_timeout',
  'timezone',
  'datestyle',
  'intervalstyle',
  'application_name',
  'client_min_messages',
  'extra_float_digits',
  'work_mem',
  'maintenance_work_mem',
  'temp_buffers',
  'random_page_cost',
  'seq_page_cost',
  'cpu_tuple_cost',
  'cpu_index_tuple_cost',
  'cpu_operator_cost',
  'effective_cache_size',
  'jit',
  'geqo',
  'from_collapse_limit',
  'join_collapse_limit',
  'max_parallel_workers_per_gather',
  'plan_cache_mode',
  'bytea_output',
  'xmloption',
  'xmlbinary',
  'lc_messages',
  'lc_monetary',
  'lc_numeric',
  'lc_time',
  'default_text_search_config',
  'row_security',
  'standard_conforming_strings',
  'escape_string_warning',
  'array_nulls',
  'transform_null_equals',
  'gin_fuzzy_search_limit',
  'trace_sort'
])

function isReadSetting(name: string): boolean {
  const n = name.toLowerCase()
  return READ_SETTINGS.has(n) || n.startsWith('enable_')
}

const NEUTRAL = new Set(['COMMIT', 'END', 'ROLLBACK', 'ABORT', 'SAVEPOINT', 'RELEASE'])
const READ_FIRST = new Set(['SHOW', 'DEALLOCATE', 'FETCH', 'MOVE', 'CLOSE'])
const QUERY_FIRST = new Set(['SELECT', 'VALUES', 'TABLE', 'WITH'])
const TWO_WORD = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'SET',
  'SECURITY',
  'IMPORT',
  'REASSIGN',
  'COMMENT'
])
const CREATE_MODIFIERS = new Set([
  'OR',
  'REPLACE',
  'TEMP',
  'TEMPORARY',
  'UNLOGGED',
  'UNIQUE',
  'GLOBAL',
  'LOCAL',
  'TRUSTED',
  'PROCEDURAL',
  'DEFAULT',
  'RECURSIVE'
])

/** Short label of an unknown write: "CREATE FUNCTION", "VACUUM"… */
function genericReason(tokens: PgToken[]): string {
  const w = upperOf(tokens[0]) || (tokens[0]?.value ?? '?')
  if (!TWO_WORD.has(w)) return w
  let i = 1
  if (w === 'CREATE' || w === 'DROP' || w === 'ALTER')
    while (CREATE_MODIFIERS.has(upperOf(tokens[i]))) i++
  const second = upperOf(tokens[i])
  if (!second) return w
  const third = upperOf(tokens[i + 1])
  const long = ['MATERIALIZED', 'FOREIGN', 'EVENT', 'ACCESS', 'TEXT', 'DEFAULT', 'USER', 'OPERATOR']
  return long.includes(second) && third ? `${w} ${second} ${third}` : `${w} ${second}`
}

/** Write reason of a SELECT/VALUES/TABLE/WITH statement, or null when it only reads. */
function queryWrites(tokens: PgToken[]): string | null {
  const d = depths(tokens)
  if (isWord(tokens[0], 'WITH')) {
    const main = topLevelWord(
      tokens,
      d,
      ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES', 'TABLE'],
      1
    )
    if (main >= 0 && startsDml(tokens, main)) return dmlReason(tokens.slice(main)).reason
  }
  for (let i = 0; i < tokens.length; i++) {
    if (startsDml(tokens, i))
      return isWord(tokens[0], 'WITH') ? 'CTE con escritura' : 'Subconsulta con escritura'
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    if (isWord(tokens[i], 'FOR') && isWord(tokens[i + 1], 'UPDATE', 'SHARE', 'NO', 'KEY'))
      return 'SELECT … FOR UPDATE'
  }
  // SELECT … INTO new_table (CREATE TABLE AS in disguise); INTO inside a subquery is invalid anyway.
  if (topLevelWord(tokens, d, ['INTO']) >= 0) return 'SELECT … INTO'
  return null
}

/** EXPLAIN [ANALYZE] [VERBOSE] stmt / EXPLAIN (options) stmt. */
function explainWrites(tokens: PgToken[]): string | null {
  let i = 1
  let analyze = false
  if (tokens[i]?.kind === 'punct' && tokens[i].value === '(') {
    const d = depths(tokens)
    let j = i + 1
    for (; j < tokens.length && !(d[j] === 0 && tokens[j].value === ')'); j++) {
      if (isWord(tokens[j], 'ANALYZE', 'ANALYSE')) {
        const v = tokens[j + 1]
        const off =
          (v?.kind === 'word' && /^(false|off|no)$/i.test(v.value)) ||
          (v?.kind === 'number' && v.value === '0') ||
          (v?.kind === 'string' && /^'(false|off|no|0)'$/i.test(v.value))
        if (!off) analyze = true
      }
    }
    i = j + 1
  } else {
    while (isWord(tokens[i], 'ANALYZE', 'ANALYSE', 'VERBOSE')) {
      if (isWord(tokens[i], 'ANALYZE', 'ANALYSE')) analyze = true
      i++
    }
  }
  if (!analyze) return null
  const inner = tokens.slice(i)
  return statementWrites(inner) ? 'EXPLAIN ANALYZE de una escritura' : null
}

function setWrites(tokens: PgToken[]): string | null {
  let i = 1
  if (isWord(tokens[i], 'SESSION', 'LOCAL')) {
    if (isWord(tokens[i], 'SESSION') && isWord(tokens[i + 1], 'AUTHORIZATION'))
      return 'SET SESSION AUTHORIZATION'
    if (isWord(tokens[i], 'SESSION') && isWord(tokens[i + 1], 'CHARACTERISTICS'))
      return tokens.some((t) => isWord(t, 'WRITE')) ? 'SET … READ WRITE' : null
    i++
  }
  const name = tokens[i]
  if (!name) return 'SET'
  if (isWord(name, 'ROLE')) return 'SET ROLE'
  if (isWord(name, 'TRANSACTION', 'CONSTRAINTS'))
    return tokens.some((t) => isWord(t, 'WRITE')) ? 'SET … READ WRITE' : null
  if (isWord(name, 'TIME') && isWord(tokens[i + 1], 'ZONE')) return null
  if (isWord(name, 'SCHEMA')) return null
  if (name.kind !== 'word' && name.kind !== 'ident') return 'SET'
  // Custom settings (my.var) are session-local too, but unknown: treat as writes.
  if (tokens[i + 1]?.kind === 'punct' && tokens[i + 1].value === '.') return `SET ${name.value}`
  return isReadSetting(name.value) ? null : `SET ${name.value}`
}

function resetWrites(tokens: PgToken[]): string | null {
  const name = tokens[1]
  if (!name || isWord(name, 'ALL')) return 'RESET ALL'
  if (isWord(name, 'ROLE', 'SESSION')) return `RESET ${name.value.toUpperCase()}`
  if (isWord(name, 'TIME') && isWord(tokens[2], 'ZONE')) return null
  return (name.kind === 'word' || name.kind === 'ident') && isReadSetting(name.value)
    ? null
    : `RESET ${name.value}`
}

/** COPY … TO STDOUT reads; COPY … FROM writes; COPY … TO 'file' writes a server file. */
function copyWrites(tokens: PgToken[]): string | null {
  const d = depths(tokens)
  const to = topLevelWord(tokens, d, ['TO'])
  if (to >= 0 && isWord(tokens[to + 1], 'STDOUT')) return null
  if (topLevelWord(tokens, d, ['FROM']) >= 0) return 'COPY FROM'
  return 'COPY'
}

/** Write reason of one statement (code tokens), or null when it is provably read-only. */
function statementWrites(tokens: PgToken[]): string | null {
  if (!tokens.length) return null
  const first = tokens[0]
  if (first.kind === 'meta') return `Comando de psql: ${first.value.split(/\s/)[0]}`
  const w = upperOf(first)
  if (QUERY_FIRST.has(w)) return queryWrites(tokens)
  if (READ_FIRST.has(w)) return null
  if (NEUTRAL.has(w)) {
    if (isWord(tokens[1], 'PREPARED')) return `${w} PREPARED`
    return null
  }
  if (w === 'BEGIN' || w === 'START')
    return tokens.some((t) => isWord(t, 'WRITE')) ? 'BEGIN READ WRITE' : null
  if (w === 'EXPLAIN') return explainWrites(tokens)
  if (w === 'SET') return setWrites(tokens)
  if (w === 'RESET') return resetWrites(tokens)
  if (w === 'COPY') return copyWrites(tokens)
  if (w === 'DECLARE') {
    const d = depths(tokens)
    const f = topLevelWord(tokens, d, ['FOR'])
    return f >= 0 ? statementWrites(tokens.slice(f + 1)) : 'DECLARE'
  }
  if (w === 'INSERT' || w === 'UPDATE' || w === 'DELETE' || w === 'MERGE')
    return dmlReason(tokens).reason
  return genericReason(tokens)
}

/** Reason given for a U&"…" identifier the lexer could not decode with certainty. */
export const UNDECODABLE_IDENT = 'Identificador U&"…" que no se puede comprobar'

export function analyzeWrites(script: string): WriteCheck {
  const reasons = new Set<string>()
  for (const { sql } of splitStatements(script)) {
    const tokens = body(sql)
    const reason = statementWrites(tokens)
    if (reason) reasons.add(reason)
    for (const fn of sideEffectCalls(tokens)) reasons.add(`Función con efectos: ${fn}`)
    // Fail closed: a name that cannot be read could be any function.
    if (tokens.some((t) => t.undecodable)) reasons.add(UNDECODABLE_IDENT)
  }
  return { writes: reasons.size > 0, reasons: [...reasons] }
}

// ---------------------------------------------------------------------------
// Main denylist (isObviousWrite)
// ---------------------------------------------------------------------------

const OBVIOUS_WRITES = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'CALL',
  'DO',
  'REFRESH',
  'VACUUM',
  'CLUSTER',
  'REINDEX',
  'COMMENT',
  'REASSIGN'
])

/**
 * Main side: true only for a statement that surely writes, from its leading
 * keyword. Everything flagged here is also a write for analyzeWrites.
 */
export function isObviousWrite(statement: string): boolean {
  const tokens = body(statement)
  const w = upperOf(tokens[0])
  if (!w) return false
  if (OBVIOUS_WRITES.has(w)) return true
  // Anything that could switch off the read-only sessions of a guarded connection, or call a
  // function that bypasses them (set_config, pg_terminate_backend, dblink…), is refused unconfirmed.
  if (sideEffectCalls(tokens).length) return true
  if (tokens.some((t) => t.undecodable)) return true
  if (w === 'DISCARD') return true
  if (w === 'BEGIN' || w === 'START') return tokens.some((t) => isWord(t, 'WRITE'))
  if (w === 'SET' || w === 'RESET') {
    if (w === 'RESET' && isWord(tokens[1], 'ALL')) return true
    if (
      isWord(tokens[1], 'ROLE') ||
      (isWord(tokens[1], 'SESSION') && isWord(tokens[2], 'AUTHORIZATION'))
    )
      return true
    return tokens.some(
      (t) =>
        isWord(t, 'WRITE', 'DEFAULT_TRANSACTION_READ_ONLY', 'TRANSACTION_READ_ONLY') ||
        (t.kind === 'ident' && /^(default_)?transaction_read_only$/i.test(t.value))
    )
  }
  if (w === 'SECURITY') return isWord(tokens[1], 'LABEL')
  if (w === 'IMPORT') return isWord(tokens[1], 'FOREIGN')
  if (w === 'COPY') return topLevelWord(tokens, depths(tokens), ['FROM']) >= 0
  if (w === 'WITH') {
    const d = depths(tokens)
    const main = topLevelWord(
      tokens,
      d,
      ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES', 'TABLE'],
      1
    )
    return main >= 0 && startsDml(tokens, main)
  }
  return false
}

// ---------------------------------------------------------------------------
// Destructive statements (renderer «confirmar antes de borrar»)
// ---------------------------------------------------------------------------

export type PgDestructiveStatement = DestructiveStatementInfo

function destructiveOf(tokens: PgToken[]): { reason: string; allRows: boolean }[] {
  const w = upperOf(tokens[0])
  const d = depths(tokens)
  if (w === 'DROP') {
    const second = upperOf(tokens[1])
    const third = upperOf(tokens[2])
    const long = ['MATERIALIZED', 'FOREIGN', 'EVENT', 'ACCESS', 'TEXT', 'USER', 'OPERATOR']
    return [
      {
        reason:
          long.includes(second) && third ? `DROP ${second} ${third}` : `DROP ${second}`.trim(),
        allRows: false
      }
    ]
  }
  if (w === 'TRUNCATE') return [{ reason: 'TRUNCATE TABLE', allRows: false }]
  if (w === 'DELETE') return [dmlReason(tokens)]
  if (w === 'UPDATE') {
    const r = dmlReason(tokens)
    return r.allRows ? [r] : []
  }
  if (w === 'ALTER' && isWord(tokens[1], 'TABLE')) {
    for (let i = 2; i < tokens.length; i++) {
      if (d[i] !== 0 || !isWord(tokens[i], 'DROP')) continue
      if (isWord(tokens[i + 1], 'DEFAULT', 'NOT', 'EXPRESSION')) continue
      return [{ reason: 'ALTER TABLE … DROP', allRows: false }]
    }
    return []
  }
  if (w === 'WITH' || w === 'EXPLAIN' || QUERY_FIRST.has(w)) {
    // CTE / subquery DML: DELETE and UPDATE without WHERE anywhere in the statement.
    if (w === 'EXPLAIN') return []
    const out: { reason: string; allRows: boolean }[] = []
    for (let i = 1; i < tokens.length; i++) {
      if (!startsDml(tokens, i)) continue
      const kw = upperOf(tokens[i])
      if (kw !== 'DELETE' && kw !== 'UPDATE') continue
      const r = dmlReason(sliceLevel(tokens, d, i))
      if (kw === 'DELETE' || r.allRows) out.push(r)
    }
    return out
  }
  return []
}

/** Destructive statements of `script`, in order (empty when nothing needs confirming). */
export function analyzeDestructivePg(script: string): PgDestructiveStatement[] {
  const out: PgDestructiveStatement[] = []
  for (const { sql } of splitStatements(script)) {
    const all = tokenizePg(sql)
    const firstCode = all.find((t) => t.kind !== 'comment')
    const shown = firstCode ? sql.slice(firstCode.start).trim() : sql.trim()
    for (const found of destructiveOf(body(sql))) out.push({ sql: shown, ...found })
  }
  return out
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERROR_EXPLANATIONS: Record<string, string> = {
  '23502': 'Una columna NOT NULL quedaría sin valor: rellénala o dale un valor por defecto.',
  '23505': 'Ya existe una fila con esa clave única o primaria.',
  '23503':
    'La clave foránea no se cumple: la fila referenciada no existe o hay filas que dependen de esta.',
  '22001': 'El valor es más largo de lo que admite la columna.',
  '22003': 'El número está fuera del rango del tipo de la columna.',
  '22P02':
    'El texto no tiene el formato del tipo de la columna. Para arrays usa el formato {a,b,"c d"}.',
  '42501': 'No tienes privilegios suficientes para esta operación.',
  '40P01': 'Interbloqueo con otra transacción: la sentencia se canceló; vuelve a intentarlo.',
  '55P03': 'No se pudo obtener el bloqueo: otra sesión lo tiene.',
  '57014': 'Consulta cancelada.',
  '25P02': 'Transacción abortada: ejecuta ROLLBACK.',
  '25006':
    'La transacción es de solo lectura: ejecuta ROLLBACK y repite el script confirmando la escritura.',
  '0A000':
    'PostgreSQL no admite referencias entre bases de datos: cambia la base de datos de la pestaña.',
  '42P01': 'La tabla o vista no existe (revisa el esquema y el search_path).',
  '42703': 'La columna no existe.',
  '42601': 'Error de sintaxis.'
}

/** Spanish explanation of a SQLSTATE, or null when there is none. */
export function explainPgError(code: string): string | null {
  return ERROR_EXPLANATIONS[code] ?? null
}

export function isPgPrivilegeError(code: string): boolean {
  return code === '42501'
}

// ---------------------------------------------------------------------------
// Dialect object
// ---------------------------------------------------------------------------

export const POSTGRESQL_LEX: Readonly<LexRules> = {
  identQuotes: ['"'],
  stringQuotes: ["'"],
  backslashEscapes: 'E-prefix',
  hashComment: false,
  dashCommentNeedsSpace: false,
  nestedBlockComments: true,
  executableComments: [],
  dollarQuotes: true,
  delimiterCommand: false,
  blockBodies: 'none'
}

export const postgresqlDialect: SqlDialect = {
  id: 'postgresql',
  lex: POSTGRESQL_LEX,
  splitStatements,
  quoteIdent,
  quoteString,
  qualified,
  isObviousWrite,
  analyzeWrites,
  analyzeDestructive: analyzeDestructivePg,
  explainError: explainPgError,
  isPrivilegeError: isPgPrivilegeError
}
