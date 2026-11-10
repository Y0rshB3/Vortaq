/**
 * SQL Server (T-SQL) dialect (docs/sqlserver-design.md, «Dialecto»). Every
 * function reads the same token stream (sqlserverLexer.ts), so the splitter,
 * both production-guard functions and the destructive-statement check agree
 * on what is a string, an identifier or a comment.
 *
 * - splitStatements returns BATCHES, split at `GO` lines like sqlcmd and SSMS
 *   (`GO 5` repeats the batch). A batch is sent whole: T-SQL variables and
 *   table variables live for one batch, and `;` is optional, so cutting a
 *   batch at semicolons would change what it does.
 * - statementsOfBatch segments a batch for analysis only (semicolons and the
 *   keyword that starts each statement); nothing runs per segment.
 * - isObviousWrite (main) and analyzeWrites (renderer) scan every code token
 *   of the batch and agree: any data change, DDL, EXEC of a procedure that is
 *   not a known read-only system procedure, SELECT … INTO, NEXT VALUE FOR,
 *   remote OPENROWSET/OPENQUERY/OPENDATASOURCE, DBCC and server commands are
 *   writes. Table variables (`INSERT @t …`) are not.
 */
import { tokenizeTsql, tsqlCodeTokens, type MsToken } from './sqlserverLexer'
import type {
  DestructiveStatementInfo,
  LexRules,
  SqlDialect,
  SqlStatement,
  WriteCheck
} from './types'

/** T-SQL reserved keywords (learn.microsoft.com, «Reserved keywords»). Quoted as identifiers. */
export const SQLSERVER_RESERVED: ReadonlySet<string> = new Set(
  (
    'add all alter and any as asc authorization backup begin between break browse bulk by ' +
    'cascade case check checkpoint close clustered coalesce collate column commit compute ' +
    'constraint contains containstable continue convert create cross current current_date ' +
    'current_time current_timestamp current_user cursor database dbcc deallocate declare default ' +
    'delete deny desc disk distinct distributed double drop dump else end errlvl escape except ' +
    'exec execute exists exit external fetch file fillfactor for foreign freetext freetexttable ' +
    'from full function goto grant group having holdlock identity identity_insert identitycol if ' +
    'in index inner insert intersect into is join key kill left like lineno load merge national ' +
    'nocheck nonclustered not null nullif of off offsets on open opendatasource openquery ' +
    'openrowset openxml option or order outer over percent pivot plan precision primary print ' +
    'proc procedure public raiserror read readtext reconfigure references replication restore ' +
    'restrict return revert revoke right rollback rowcount rowguidcol rule save schema ' +
    'securityaudit select semantickeyphrasetable semanticsimilaritydetailstable ' +
    'semanticsimilaritytable session_user set setuser shutdown some statistics system_user table ' +
    'tablesample textsize then to top tran transaction trigger truncate try_convert tsequal union ' +
    'unique unpivot update updatetext use user values varying view waitfor when where while with ' +
    'within writetext'
  ).split(' ')
)

const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `users` stays bare; `order`, `a b`, `1x` and `a]b` are bracketed. `force` always brackets. */
export function quoteIdent(name: string, force = false): string {
  if (!force && PLAIN_IDENT.test(name) && !SQLSERVER_RESERVED.has(name.toLowerCase())) return name
  return '[' + name.replace(/]/g, ']]') + ']'
}

/** Unicode string literal N'…' (the quote is doubled; backslashes are plain characters). */
export function quoteString(value: string): string {
  return "N'" + value.replace(/'/g, "''") + "'"
}

/** Non-Unicode literal '…', for comparisons with char/varchar columns (keeps index seeks). */
export function quoteAnsiString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

/** `schema.name` with both parts quoted; only `name` when there is no schema. */
export function qualified(schema: string | null | undefined, name: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name)
}

// ---------------------------------------------------------------------------
// Batches (GO)
// ---------------------------------------------------------------------------

/** Largest `GO n` count Vortaq runs (sqlcmd has no limit; this avoids typos like GO 100000000). */
export const MAX_GO_REPEAT = 1000

const isWord = (t: MsToken | undefined, ...words: string[]): boolean =>
  !!t && t.kind === 'word' && words.includes(t.value.toUpperCase())

const upperOf = (t: MsToken | undefined): string =>
  t && t.kind === 'word' ? t.value.toUpperCase() : ''

const isPunct = (t: MsToken | undefined, value: string): boolean =>
  !!t && (t.kind === 'punct' || t.kind === 'op') && t.value === value

/** Only spaces or tabs between the start of the line and `pos`. */
function blankBefore(src: string, pos: number): boolean {
  for (let i = pos - 1; i >= 0; i--) {
    const ch = src[i]
    if (ch === '\n') return true
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false
  }
  return true
}

/**
 * The batches of a script, split at lines that hold only `GO` (any case), an
 * optional repeat count and an optional `--` comment, never inside a string or
 * a comment. Empty batches (only comments) are dropped.
 */
export function splitStatements(script: string): SqlStatement[] {
  const src = script.replace(/\r\n/g, '\n')
  const tokens = tokenizeTsql(src)
  const out: SqlStatement[] = []
  let batchStart = 0
  let firstCode: MsToken | null = null

  const flush = (end: number, repeat: number): void => {
    if (firstCode) {
      const sql = src.slice(batchStart, end).trim()
      if (sql)
        out.push(
          repeat > 1
            ? { sql, startLine: firstCode.line, repeat }
            : { sql, startLine: firstCode.line }
        )
    }
    firstCode = null
  }

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    if (t.kind === 'word' && t.value.toUpperCase() === 'GO' && blankBefore(src, t.start)) {
      let j = k + 1
      let repeat = 1
      const next = tokens[j]
      if (next && next.kind === 'number' && next.line === t.line && /^\d+$/.test(next.value)) {
        repeat = Number(next.value)
        j++
      }
      const after = tokens[j]
      const lineEnds =
        !after || after.line > t.line || (after.kind === 'comment' && after.value.startsWith('--'))
      if (lineEnds) {
        flush(t.start, Math.max(1, Math.min(repeat, MAX_GO_REPEAT)))
        const eol = src.indexOf('\n', t.end)
        batchStart = eol < 0 ? src.length : eol + 1
        // Skip the tokens of the rest of the GO line (count and comment).
        while (k + 1 < tokens.length && tokens[k + 1].start < batchStart) k++
        continue
      }
    }
    if (t.kind !== 'comment' && !firstCode) firstCode = t
  }
  flush(src.length, 1)
  return out
}

/** A `GO n` count above MAX_GO_REPEAT, for the editor's warning; null when none. */
export function goRepeatTooLarge(script: string): number | null {
  const m = /^[ \t]*go[ \t]+(\d+)[ \t]*(?:--.*)?$/gim
  for (const match of script.matchAll(m)) {
    const n = Number(match[1])
    if (n > MAX_GO_REPEAT) return n
  }
  return null
}

// ---------------------------------------------------------------------------
// Statements of a batch (analysis only)
// ---------------------------------------------------------------------------

/** Words that start a T-SQL statement. */
const STARTERS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'EXEC',
  'EXECUTE',
  'DECLARE',
  'SET',
  'IF',
  'ELSE',
  'WHILE',
  'BEGIN',
  'END',
  'COMMIT',
  'ROLLBACK',
  'SAVE',
  'PRINT',
  'RAISERROR',
  'THROW',
  'RETURN',
  'USE',
  'GRANT',
  'REVOKE',
  'DENY',
  'GOTO',
  'BREAK',
  'CONTINUE',
  'WAITFOR',
  'BACKUP',
  'RESTORE',
  'DBCC',
  'BULK',
  'OPEN',
  'FETCH',
  'CLOSE',
  'DEALLOCATE',
  'KILL',
  'CHECKPOINT',
  'RECONFIGURE',
  'SHUTDOWN',
  'ENABLE',
  'DISABLE',
  'READTEXT',
  'WRITETEXT',
  'UPDATETEXT',
  'SETUSER',
  'REVERT',
  'SEND',
  'RECEIVE'
])

/** Objects whose CREATE/ALTER must be alone in its batch: the rest of the batch is its body. */
const MODULE_OBJECTS = new Set(['PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'VIEW'])

/** Object words after DROP that end an ALTER TABLE … DROP and start a DROP statement. */
const DROP_OBJECTS = new Set([
  'TABLE',
  'VIEW',
  'PROC',
  'PROCEDURE',
  'FUNCTION',
  'INDEX',
  'TRIGGER',
  'SCHEMA',
  'DATABASE',
  'SEQUENCE',
  'TYPE',
  'SYNONYM',
  'USER',
  'LOGIN',
  'ROLE',
  'ASSEMBLY',
  'DEFAULT',
  'RULE'
])

export interface BatchStatement {
  /** Code tokens of the statement (no comments, no trailing `;`). */
  tokens: MsToken[]
  /** Text as written. */
  sql: string
  /** First word, upper case ('' when it starts with something else). */
  head: string
  /** The statement a WITH … CTE ends in (SELECT/INSERT/UPDATE/DELETE/MERGE), else `head`. */
  kind: string
}

/** True for CREATE [OR ALTER] PROC/FUNCTION/TRIGGER/VIEW and ALTER of those, at `i`. */
function startsModule(code: MsToken[], i: number): boolean {
  const w0 = upperOf(code[i])
  if (w0 === 'ALTER') return MODULE_OBJECTS.has(upperOf(code[i + 1]))
  if (w0 !== 'CREATE') return false
  if (isWord(code[i + 1], 'OR') && isWord(code[i + 2], 'ALTER'))
    return MODULE_OBJECTS.has(upperOf(code[i + 3]))
  return MODULE_OBJECTS.has(upperOf(code[i + 1]))
}

/**
 * Segments one batch into statements at `;` and at the words that start a
 * statement, keeping continuations together (INSERT … SELECT, UNION SELECT,
 * UPDATE … SET, ALTER TABLE … DROP, ON DELETE, FOR UPDATE, CASE … ELSE … END,
 * WITH … CTE …, MERGE up to its `;`, GRANT … TO). CREATE/ALTER of a procedure,
 * function, trigger or view takes the rest of the batch, like the server.
 */
export function statementsOfBatch(batch: string): BatchStatement[] {
  const src = batch.replace(/\r\n/g, '\n')
  const code = tsqlCodeTokens(tokenizeTsql(src))
  const out: BatchStatement[] = []
  let begin = -1
  let head = ''
  let kind = ''
  let depth = 0
  let caseDepth = 0
  let wholeBatch = false
  let sourceSeen = false // INSERT: its SELECT/EXEC/VALUES; UPDATE: its SET; WITH: its statement
  let grantTarget = false

  const close = (end: number): void => {
    if (begin < 0) return
    const tokens = code.slice(begin, end)
    if (tokens.length) {
      const sql = src.slice(tokens[0].start, tokens[tokens.length - 1].end)
      out.push({ tokens, sql, head, kind })
    }
    begin = -1
  }
  const open = (i: number): void => {
    begin = i
    head = upperOf(code[i])
    kind = head
    depth = 0
    caseDepth = 0
    sourceSeen = false
    grantTarget = false
    wholeBatch = startsModule(code, i)
  }

  for (let i = 0; i < code.length; i++) {
    const t = code[i]
    // A module's body (semicolons included) belongs to its CREATE/ALTER.
    if (begin >= 0 && wholeBatch) continue
    if (isPunct(t, ';') && depth === 0) {
      close(i)
      continue
    }
    if (begin < 0) {
      open(i)
      if (isPunct(t, '(')) depth++
      continue
    }
    if (isPunct(t, '(')) {
      depth++
      continue
    }
    if (isPunct(t, ')')) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth > 0 || t.kind !== 'word') continue
    const w = t.value.toUpperCase()
    if (w === 'CASE') {
      caseDepth++
      continue
    }
    if (caseDepth > 0) {
      if (w === 'END') caseDepth--
      continue
    }
    if (kind === 'MERGE') continue // MERGE ends at its required `;`
    if ((head === 'GRANT' || head === 'REVOKE' || head === 'DENY') && !grantTarget) {
      if (w === 'TO' || w === 'FROM') grantTarget = true
      continue
    }
    if (!STARTERS.has(w)) continue
    const prev = upperOf(code[i - 1])
    if (
      prev === 'FOR' ||
      prev === 'ON' ||
      prev === 'UNION' ||
      prev === 'EXCEPT' ||
      prev === 'INTERSECT'
    )
      continue
    if (prev === 'ALL' && upperOf(code[i - 2]) === 'UNION') continue
    if (kind === 'INSERT' && !sourceSeen && (w === 'SELECT' || w === 'EXEC' || w === 'EXECUTE')) {
      sourceSeen = true
      continue
    }
    if (kind === 'UPDATE' && !sourceSeen && w === 'SET') {
      sourceSeen = true
      continue
    }
    if (
      head === 'WITH' &&
      kind === 'WITH' &&
      (w === 'SELECT' || w === 'INSERT' || w === 'UPDATE' || w === 'DELETE' || w === 'MERGE')
    ) {
      kind = w
      continue
    }
    if (head === 'ALTER') {
      if (w === 'ALTER' && isWord(code[i + 1], 'COLUMN')) continue
      if (w === 'DROP' && !DROP_OBJECTS.has(upperOf(code[i + 1]))) continue
      if (w === 'SET' || w === 'ENABLE' || w === 'DISABLE') continue
    }
    close(i)
    open(i)
  }
  close(code.length)
  return out
}

/** The batch is one query statement (SELECT, or WITH … SELECT) without INTO. */
export function isSingleQuery(batch: string): boolean {
  const statements = statementsOfBatch(batch)
  if (statements.length !== 1) return false
  const s = statements[0]
  if (s.kind !== 'SELECT') return false
  return !selectIntoTarget(s.tokens)
}

// ---------------------------------------------------------------------------
// Production guard
// ---------------------------------------------------------------------------

/** System procedures that only read (sp_help…, catalog procedures, sp_who…). */
export const READ_ONLY_PROCEDURES: ReadonlySet<string> = new Set([
  'sp_help',
  'sp_helptext',
  'sp_helpindex',
  'sp_helpconstraint',
  'sp_helpdb',
  'sp_helpfile',
  'sp_helpfilegroup',
  'sp_helprotect',
  'sp_helpuser',
  'sp_helprole',
  'sp_helprolemember',
  'sp_helplogins',
  'sp_helpserver',
  'sp_helpstats',
  'sp_helptrigger',
  'sp_helpsort',
  'sp_helplanguage',
  'sp_columns',
  'sp_column_privileges',
  'sp_tables',
  'sp_table_privileges',
  'sp_stored_procedures',
  'sp_sproc_columns',
  'sp_pkeys',
  'sp_fkeys',
  'sp_statistics',
  'sp_special_columns',
  'sp_datatype_info',
  'sp_who',
  'sp_who2',
  'sp_lock',
  'sp_databases',
  'sp_server_info',
  'sp_spaceused',
  'sp_depends',
  'sp_monitor',
  'sp_describe_first_result_set',
  'sp_describe_undeclared_parameters'
])

/** DBCC commands that only report. */
const READ_DBCC = new Set([
  'SHOW_STATISTICS',
  'USEROPTIONS',
  'OPENTRAN',
  'INPUTBUFFER',
  'SQLPERF',
  'TRACESTATUS'
])

/** Statements that never change data. */
const NEUTRAL_WORDS = new Set([
  'SELECT',
  'DECLARE',
  'SET',
  'IF',
  'ELSE',
  'WHILE',
  'BEGIN',
  'END',
  'COMMIT',
  'ROLLBACK',
  'SAVE',
  'PRINT',
  'RAISERROR',
  'THROW',
  'RETURN',
  'USE',
  'GOTO',
  'BREAK',
  'CONTINUE',
  'WAITFOR',
  'OPEN',
  'FETCH',
  'CLOSE',
  'DEALLOCATE',
  'WITH',
  'REVERT',
  'READTEXT'
])

/** Writes on sight (all of them are reserved words: never a bare identifier). */
const WRITE_WORDS: Record<string, string> = {
  MERGE: 'MERGE',
  TRUNCATE: 'TRUNCATE TABLE',
  GRANT: 'GRANT',
  REVOKE: 'REVOKE',
  DENY: 'DENY',
  BACKUP: 'BACKUP',
  RESTORE: 'RESTORE',
  BULK: 'BULK INSERT',
  KILL: 'KILL',
  SHUTDOWN: 'SHUTDOWN',
  RECONFIGURE: 'RECONFIGURE',
  CHECKPOINT: 'CHECKPOINT',
  WRITETEXT: 'WRITETEXT',
  UPDATETEXT: 'UPDATETEXT',
  SETUSER: 'SETUSER',
  OPENROWSET: 'OPENROWSET',
  OPENQUERY: 'OPENQUERY',
  OPENDATASOURCE: 'OPENDATASOURCE'
}

/** Name after an EXEC (last part of a dotted name), or null for dynamic SQL / EXECUTE AS. */
function procedureAt(code: MsToken[], i: number): { name: string | null; dynamic: boolean } {
  let j = i
  // EXEC @ret = proc
  if (code[j]?.kind === 'variable' && isPunct(code[j + 1], '=')) j += 2
  const t = code[j]
  if (!t) return { name: null, dynamic: false }
  if (isPunct(t, '(') || t.kind === 'variable' || t.kind === 'string')
    return { name: null, dynamic: true }
  if (t.kind !== 'word' && t.kind !== 'ident') return { name: null, dynamic: true }
  let name = t.value
  while (
    isPunct(code[j + 1], '.') &&
    code[j + 2] &&
    (code[j + 2].kind === 'word' || code[j + 2].kind === 'ident')
  ) {
    j += 2
    name = code[j].value
  }
  return { name, dynamic: false }
}

/** Reason when calling procedure `name` writes (anything but the read-only system procedures). */
function procedureReason(name: string | null, dynamic: boolean): string | null {
  if (dynamic || !name) return 'EXEC de SQL dinámico'
  return READ_ONLY_PROCEDURES.has(name.toLowerCase()) ? null : `EXEC ${name}`
}

/** INTO of a SELECT … INTO that creates a table (not FETCH … INTO @variables). */
function selectIntoTarget(code: MsToken[]): boolean {
  let depth = 0
  for (let i = 0; i < code.length; i++) {
    const t = code[i]
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) depth = Math.max(0, depth - 1)
    else if (depth === 0 && isWord(t, 'INTO') && code[i + 1]?.kind !== 'variable') return true
  }
  return false
}

/** Target of INSERT/UPDATE/DELETE/MERGE after `i` is a table variable (`@t`). */
function targetsVariable(code: MsToken[], i: number): boolean {
  let j = i + 1
  if (isWord(code[j], 'TOP')) {
    j++
    if (isPunct(code[j], '(')) {
      let depth = 0
      for (; j < code.length; j++) {
        if (isPunct(code[j], '(')) depth++
        else if (isPunct(code[j], ')') && --depth === 0) break
      }
      j++
    }
    if (isWord(code[j], 'PERCENT')) j++
  }
  if (isWord(code[j], 'INTO', 'FROM')) j++
  return code[j]?.kind === 'variable'
}

/** Every reason a batch writes (deduplicated, in order). */
function batchWrites(batch: string): string[] {
  const code = tsqlCodeTokens(tokenizeTsql(batch))
  const reasons: string[] = []
  const add = (r: string): void => {
    if (!reasons.includes(r)) reasons.push(r)
  }
  if (!code.length) return reasons
  // A batch that starts with a procedure name runs it (implicit EXEC).
  const first = code[0]
  if (
    first.kind === 'ident' ||
    (first.kind === 'word' &&
      !STARTERS.has(first.value.toUpperCase()) &&
      !NEUTRAL_WORDS.has(first.value.toUpperCase()))
  ) {
    const { name, dynamic } = procedureAt(code, 0)
    const r = procedureReason(name, dynamic)
    if (r) add(r)
  }
  for (let i = 0; i < code.length; i++) {
    const t = code[i]
    if (t.kind !== 'word') continue
    const w = t.value.toUpperCase()
    const prev = upperOf(code[i - 1])
    const next = upperOf(code[i + 1])
    switch (w) {
      case 'INSERT':
      case 'DELETE':
        if (prev === 'ON' || prev === 'FOR' || prev === 'AFTER' || prev === 'OF') break
        if (!targetsVariable(code, i)) add(w)
        break
      case 'UPDATE':
        if (prev === 'ON' || prev === 'FOR' || prev === 'AFTER' || prev === 'OF') break
        if (next === 'STATISTICS') add('UPDATE STATISTICS')
        else if (!targetsVariable(code, i)) add('UPDATE')
        break
      case 'CREATE':
      case 'ALTER':
      case 'DROP': {
        // ALTER/DROP inside an ALTER TABLE belong to it; a GRANT ALTER is a GRANT.
        if (prev === 'GRANT' || prev === 'REVOKE' || prev === 'DENY' || prev === ',') break
        const what = code[i + 1]?.kind === 'word' ? next : ''
        if (w === 'CREATE' && what === 'OR' && isWord(code[i + 2], 'ALTER'))
          add(`CREATE OR ALTER ${upperOf(code[i + 3])}`.trim())
        else add(`${w} ${what}`.trim())
        break
      }
      case 'INTO':
        if (prev === 'INSERT' || prev === 'MERGE' || code[i + 1]?.kind === 'variable') break
        // OUTPUT … INTO @t is a variable; INTO a table (SELECT … INTO, OUTPUT … INTO t) writes.
        add(code.slice(0, i).some((x) => isWord(x, 'OUTPUT')) ? 'OUTPUT … INTO' : 'SELECT … INTO')
        break
      case 'EXEC':
      case 'EXECUTE': {
        if (next === 'AS') break // EXECUTE AS USER/LOGIN: changes the security context only
        if (prev === 'GRANT' || prev === 'REVOKE' || prev === 'DENY' || prev === ',') break
        const { name, dynamic } = procedureAt(code, i + 1)
        const r = procedureReason(name, dynamic)
        if (r) add(r)
        break
      }
      case 'NEXT':
        if (next === 'VALUE' && isWord(code[i + 2], 'FOR')) add('NEXT VALUE FOR')
        break
      case 'DBCC':
        if (!READ_DBCC.has(next)) add(`DBCC ${next}`.trim())
        break
      case 'ENABLE':
      case 'DISABLE':
        if (next === 'TRIGGER') add(`${w} TRIGGER`)
        break
      case 'SEND':
        if (next === 'ON') add('SEND ON CONVERSATION')
        break
      case 'RECEIVE':
        if (i === 0 || isPunct(code[i - 1], '(') || isPunct(code[i - 1], ';')) add('RECEIVE')
        break
      default: {
        if (WRITE_WORDS[w] && !(w === 'GRANT' && prev === 'WITH')) add(WRITE_WORDS[w])
        if (
          (w === 'DIALOG' && prev === 'BEGIN') ||
          (w === 'CONVERSATION' && (prev === 'END' || prev === 'MOVE' || prev === 'GET'))
        )
          add(`${prev} ${w}`)
      }
    }
  }
  return reasons
}

/**
 * Renderer guard: anything not provably read-only is a write, with Spanish
 * reasons («UPDATE», «EXEC dbo.sp_x», «SELECT … INTO»…).
 */
export function analyzeWrites(script: string): WriteCheck {
  const reasons: string[] = []
  for (const batch of splitStatements(script))
    for (const r of batchWrites(batch.sql)) if (!reasons.includes(r)) reasons.push(r)
  return { writes: reasons.length > 0, reasons }
}

/**
 * Main guard. For T-SQL it is the same scan as analyzeWrites: a procedure can
 * change anything, so `isObviousWrite(s)` and `analyzeWrites(s).writes` agree.
 */
export function isObviousWrite(statement: string): boolean {
  return batchWrites(statement).length > 0
}

// ---------------------------------------------------------------------------
// Destructive statements
// ---------------------------------------------------------------------------

function hasTopLevelWord(tokens: MsToken[], word: string, from = 0): boolean {
  let depth = 0
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i]
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) depth = Math.max(0, depth - 1)
    else if (depth === 0 && isWord(t, word)) return true
  }
  return false
}

function destructiveOf(s: BatchStatement): { reason: string; allRows: boolean } | null {
  const tokens = s.tokens
  if (s.head === 'DROP') return { reason: `DROP ${upperOf(tokens[1])}`.trim(), allRows: false }
  if (s.head === 'TRUNCATE') return { reason: 'TRUNCATE TABLE', allRows: true }
  if (s.head === 'ALTER' && isWord(tokens[1], 'TABLE')) {
    if (tokens.some((t, i) => i > 1 && isWord(t, 'DROP')))
      return { reason: 'ALTER TABLE … DROP', allRows: false }
    return null
  }
  const at = tokens.findIndex((t) => isWord(t, s.kind))
  if (at < 0) return null
  if (s.kind === 'DELETE') {
    if (targetsVariable(tokens, at) || hasTopLevelWord(tokens, 'WHERE', at)) return null
    return { reason: 'DELETE sin WHERE', allRows: !isWord(tokens[at + 1], 'TOP') }
  }
  if (s.kind === 'UPDATE') {
    if (isWord(tokens[at + 1], 'STATISTICS')) return null
    if (targetsVariable(tokens, at) || hasTopLevelWord(tokens, 'WHERE', at)) return null
    return { reason: 'UPDATE sin WHERE', allRows: !isWord(tokens[at + 1], 'TOP') }
  }
  return null
}

export function analyzeDestructiveSqlServer(script: string): DestructiveStatementInfo[] {
  const out: DestructiveStatementInfo[] = []
  for (const batch of splitStatements(script))
    for (const s of statementsOfBatch(batch.sql)) {
      const found = destructiveOf(s)
      if (found) out.push({ sql: s.sql, ...found })
    }
  return out
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERROR_EXPLANATIONS: Record<string, string> = {
  '102': 'Error de sintaxis cerca del texto indicado.',
  '156': 'Palabra clave en un lugar incorrecto: revisa la sintaxis.',
  '207': 'La columna no existe en la tabla consultada.',
  '208': 'La tabla o vista no existe (o está en otro esquema o base de datos).',
  '229': 'Tu usuario no tiene permiso para esta operación.',
  '230': 'Tu usuario no tiene permiso sobre esa columna.',
  '262': 'Tu usuario no tiene permiso para esta operación en la base de datos.',
  '515': 'La columna no admite NULL.',
  '547': 'Lo impide una clave foránea o una restricción CHECK.',
  '916': 'Tu usuario no puede acceder a esa base de datos.',
  '1205': 'La transacción quedó en un interbloqueo y el servidor la canceló: vuelve a intentarlo.',
  '1222': 'Se agotó el tiempo de espera de un bloqueo.',
  '2601': 'Ya existe una fila con ese valor en un índice único.',
  '2627': 'Ya existe una fila con esa clave primaria o restricción UNIQUE.',
  '2628': 'El texto es más largo de lo que admite la columna.',
  '3701': 'El objeto no existe o no tienes permiso sobre él.',
  '3906': 'La base de datos es de solo lectura.',
  '4060': 'No se puede abrir la base de datos indicada.',
  '8115': 'El valor no cabe en el tipo de la columna (desbordamiento).',
  '8152': 'El texto es más largo de lo que admite la columna.',
  '18456': 'El servidor rechazó el usuario o la contraseña.'
}

/** Spanish explanation of a SQL Server error number, or null. */
export function explainSqlServerError(code: string): string | null {
  return ERROR_EXPLANATIONS[code] ?? null
}

const PRIVILEGE_ERRORS = new Set(['229', '230', '262', '297', '300', '916', '15247'])

export function isSqlServerPrivilegeError(code: string): boolean {
  return PRIVILEGE_ERRORS.has(code)
}

// ---------------------------------------------------------------------------
// Dialect
// ---------------------------------------------------------------------------

export const SQLSERVER_LEX: Readonly<LexRules> = {
  identQuotes: ['[', '"'],
  stringQuotes: ["'"],
  backslashEscapes: false,
  hashComment: false,
  dashCommentNeedsSpace: false,
  nestedBlockComments: true,
  executableComments: [],
  dollarQuotes: false,
  delimiterCommand: false,
  blockBodies: 'none'
}

export const sqlserverDialect: SqlDialect = {
  id: 'sqlserver',
  lex: SQLSERVER_LEX,
  splitStatements,
  quoteIdent: (name) => quoteIdent(name),
  quoteString,
  qualified,
  isObviousWrite,
  analyzeWrites,
  analyzeDestructive: analyzeDestructiveSqlServer,
  explainError: explainSqlServerError,
  isPrivilegeError: isSqlServerPrivilegeError
}
