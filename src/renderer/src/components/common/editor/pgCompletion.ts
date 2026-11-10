import { quoteIdent } from '@shared/dialects/postgresql'
import {
  insertCompletionText,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource
} from '@codemirror/autocomplete'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { PostgreSQL, SQLDialect } from '@codemirror/lang-sql'
import type { EditorState, Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/*
 * PostgreSQL completion for the query editor (docs/multi-engine-design.md,
 * section 8.1). Schema-qualified and search_path aware: unqualified names
 * resolve through the tab's search_path in order, unquoted input matches the
 * folded (lower-case) names case-insensitively, and labels are inserted with
 * double quotes whenever PostgreSQL would need them. The MySQL source
 * (sqlCompletion.ts) is untouched.
 */

/** PostgreSQL dialect of the editor: `$$` bodies and `E''` strings are understood by lang-sql. */
export const vortaqPostgreSQL = SQLDialect.define({ ...PostgreSQL.spec })

export type PgRelationKind = 'table' | 'view' | 'materialized_view' | 'foreign'

/** Metadata the editor can ask for; every call may be slow (results are cached by cachedPg). */
export interface PgSchemaProvider {
  /** Effective search_path of the tab, in order (e.g. ['app', 'public']); first = default for CREATE. */
  searchPath(): string[]
  /** Schemas of the tab's database. */
  schemas(): Promise<string[]>
  /** Relations of one schema. */
  tables(schema: string): Promise<{ name: string; kind: PgRelationKind }[]>
  columns(schema: string, table: string): Promise<{ name: string; type: string }[]>
  /** Optional: functions of a schema (name + identity args) for completion after SELECT. */
  functions?(schema: string): Promise<{ name: string; signature: string }[]>
}

/** Longest identifier scanned (NAMEDATALEN is 64; quoted ones a bit more). */
const MAX_IDENT = 256
/** Characters around the cursor considered when scoping the statement. */
const SCOPE_WINDOW = 20_000
/** Referenced relations whose columns are offered for a bare word. */
const MAX_REFS = 8
/** search_path schemas whose relations are offered for a bare word. */
const MAX_PATH = 8

/** Quotes a name unless it is a plain lower-case identifier that is not reserved (shared dialect rule). */
export function pgQuoteIdent(name: string, force = false): string {
  return force ? '"' + name.replace(/"/g, '""') + '"' : quoteIdent(name)
}

/** Name an identifier as typed refers to: quoted keeps case, unquoted folds to lower case. */
export function pgIdentName(id: string): string {
  if (id.startsWith('"')) {
    const body = id.endsWith('"') && id.length > 1 ? id.slice(1, -1) : id.slice(1)
    return body.replace(/""/g, '"')
  }
  return id.toLowerCase()
}

/** Wraps a provider with per-key promise caching; failures and empty column lists retry. */
export function cachedPg(provider: PgSchemaProvider): PgSchemaProvider & { clear(): void } {
  const store = new Map<string, Promise<unknown>>()
  const memo = <T>(key: string, load: () => Promise<T>, keepEmpty = true): Promise<T> => {
    let p = store.get(key) as Promise<T> | undefined
    if (!p) {
      p = load().then(
        (value) => {
          if (!keepEmpty && Array.isArray(value) && !value.length) store.delete(key)
          return value
        },
        (err) => {
          store.delete(key)
          throw err
        }
      )
      store.set(key, p)
    }
    return p
  }
  const functions = provider.functions?.bind(provider)
  return {
    searchPath: () => provider.searchPath(),
    schemas: () => memo('s', () => provider.schemas()),
    tables: (s) => memo(`t:${s}`, () => provider.tables(s)),
    columns: (s, t) => memo(`c:${s}\u0000${t}`, () => provider.columns(s, t), false),
    ...(functions ? { functions: (s: string) => memo(`f:${s}`, () => functions(s)) } : {}),
    clear: () => store.clear()
  }
}

/* ---------- lexing ---------- */

/** Unquoted identifier characters: [A-Za-z0-9_$] plus U+0080 and above. */
function isWordCode(c: number): boolean {
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 95 ||
    c === 36 ||
    c >= 0x80
  )
}

type Token = { kind: 'id'; value: string; quoted: boolean } | { kind: 'punct'; value: string }

/** End index (exclusive) of a dollar-quote opening tag at `i`, or -1. */
function dollarTag(sql: string, i: number): string | null {
  const m = /^\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(sql.slice(i, i + MAX_IDENT))
  return m ? m[0] : null
}

/** Identifiers and punctuation; strings, dollar bodies and comments are skipped. Linear time. */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const ch = sql[i]
    const c = sql.charCodeAt(i)
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') i++
    else if (ch === '"') {
      let j = i + 1
      let value = ''
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            value += '"'
            j += 2
            continue
          }
          break
        }
        value += sql[j++]
      }
      tokens.push({ kind: 'id', value, quoted: true })
      i = j + 1
    } else if (ch === "'") {
      const escapes = i > 0 && /[eE]/.test(sql[i - 1]) && !isWordCode(sql.charCodeAt(i - 2) || 32)
      let j = i + 1
      while (j < n) {
        if (escapes && sql[j] === '\\') j += 2
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2
        else if (sql[j] === "'") break
        else j++
      }
      i = j + 1
    } else if (ch === '$' && dollarTag(sql, i)) {
      const tag = dollarTag(sql, i)!
      const end = sql.indexOf(tag, i + tag.length)
      i = end < 0 ? n : end + tag.length
    } else if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i)
      i = eol < 0 ? n : eol + 1
    } else if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      i = j
    } else if (isWordCode(c)) {
      let j = i + 1
      while (j < n && isWordCode(sql.charCodeAt(j))) j++
      // E'..' prefix: leave the quote for the string branch.
      if (j - i === 1 && /[eE]/.test(ch) && sql[j] === "'") {
        i = j
        continue
      }
      tokens.push({ kind: 'id', value: sql.slice(i, j), quoted: false })
      i = j
    } else {
      tokens.push({ kind: 'punct', value: ch })
      i++
    }
  }
  return tokens
}

/** True when the cursor at the end of `text` is inside a string, dollar body or comment. */
export function insideLiteral(text: string): boolean {
  const n = text.length
  let i = 0
  while (i < n) {
    const ch = text[i]
    if (ch === "'") {
      const escapes = i > 0 && /[eE]/.test(text[i - 1]) && !isWordCode(text.charCodeAt(i - 2) || 32)
      let j = i + 1
      for (;;) {
        if (j >= n) return true
        if (escapes && text[j] === '\\') j += 2
        else if (text[j] === "'" && text[j + 1] === "'") j += 2
        else if (text[j] === "'") break
        else j++
      }
      i = j + 1
    } else if (ch === '"') {
      const end = text.indexOf('"', i + 1)
      if (end < 0) return false // typing a quoted identifier: completion applies
      i = end + 1
    } else if (ch === '$' && !isWordCode(text.charCodeAt(i - 1) || 32) && dollarTag(text, i)) {
      const tag = dollarTag(text, i)!
      const end = text.indexOf(tag, i + tag.length)
      if (end < 0) return true
      i = end + tag.length
    } else if (ch === '-' && text[i + 1] === '-') {
      const eol = text.indexOf('\n', i)
      if (eol < 0) return true
      i = eol + 1
    } else if (ch === '/' && text[i + 1] === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++
          j += 2
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      if (depth > 0) return true
      i = j
    } else i++
  }
  return false
}

const NOT_ALIAS = new Set(
  (
    'WHERE ON USING JOIN INNER LEFT RIGHT FULL CROSS OUTER NATURAL LATERAL GROUP ORDER LIMIT OFFSET ' +
    'FETCH HAVING SET VALUES UNION AS WINDOW FOR SELECT WITH EXCEPT INTERSECT INTO FROM RETURNING ' +
    'ONLY TABLESAMPLE DEFAULT DO CONFLICT WHEN THEN ELSE END AND OR NOT'
  ).split(' ')
)
const TABLE_KW = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'USING', 'TABLE'])
const LIST_KW = new Set(['FROM', 'USING'])
const MODIFIERS = new Set(['ONLY', 'LATERAL'])
const NOT_TABLE = new Set([...NOT_ALIAS])

const isWord = (t: Token | undefined, words: Set<string>): boolean =>
  !!t && t.kind === 'id' && !t.quoted && words.has(t.value.toUpperCase())
const isPunct = (t: Token | undefined, value: string): boolean =>
  !!t && t.kind === 'punct' && t.value === value

export interface PgTableRef {
  /** Real (folded or quoted) names. */
  schema: string | null
  table: string
  alias: string | null
}

const nameOf = (t: { value: string; quoted: boolean }): string =>
  t.quoted ? t.value : t.value.toLowerCase()

/** Relations after FROM/JOIN/UPDATE/INTO/USING, with aliases and comma lists. */
export function pgTableRefs(sql: string): PgTableRef[] {
  const refs: PgTableRef[] = []
  const tokens = tokenize(sql)
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], TABLE_KW)) continue
    const keyword = (tokens[i] as { value: string }).value.toUpperCase()
    let j = i + 1
    while (isWord(tokens[j], MODIFIERS)) j++
    for (;;) {
      const name = tokens[j]
      if (!name || name.kind !== 'id' || isWord(name, NOT_TABLE)) break
      let schema: string | null = null
      let table = nameOf(name)
      j++
      const next = tokens[j + 1]
      if (isPunct(tokens[j], '.') && next?.kind === 'id') {
        schema = table
        table = nameOf(next)
        j += 2
      }
      if (isPunct(tokens[j], '(')) break // function call in FROM
      if (isWord(tokens[j], new Set(['AS']))) j++
      let alias: string | null = null
      const a = tokens[j]
      if (a?.kind === 'id' && (a.quoted || !NOT_ALIAS.has(a.value.toUpperCase()))) {
        alias = nameOf(a)
        j++
      }
      refs.push({ schema, table, alias })
      if (LIST_KW.has(keyword) && isPunct(tokens[j], ',')) {
        j++
        continue
      }
      break
    }
    i = Math.max(i, j - 1)
  }
  return refs
}

/* ---------- cursor ---------- */

type Tree = ReturnType<typeof syntaxTree>
type SyntaxNode = ReturnType<Tree['resolveInner']>

const SKIP_NODES = new Set(['String', 'LineComment', 'BlockComment'])

/** Syntax-tree check: inside a string / dollar body / comment (or at the end of an unclosed one). */
function inLiteralNode(node: SyntaxNode, pos: number, doc: Text): boolean {
  if (!SKIP_NODES.has(node.name) || pos <= node.from) return false
  if (pos < node.to || node.name === 'LineComment') return true
  const text = doc.sliceString(node.from, node.to)
  if (node.name === 'BlockComment') return text.length < 4 || !text.endsWith('*/')
  const body = text.replace(/^[A-Za-z_]*/, '')
  if (body.startsWith('$')) {
    const tag = dollarTag(body, 0)
    return !tag || body.length < tag.length * 2 || !body.endsWith(tag)
  }
  const quote = body[0]
  return body.length < 2 || body[body.length - 1] !== quote
}

/** Start of the identifier ending at `end` in `text`, or -1. */
function identStart(text: string, end: number): number {
  if (text[end - 1] === '"') {
    for (let k = end - 2; k >= 0 && end - k <= MAX_IDENT; k--) {
      if (text[k] === '\n') return -1
      if (text[k] !== '"') continue
      if (text[k - 1] === '"') {
        k--
        continue
      }
      return k
    }
    return -1
  }
  let k = end
  while (k > 0 && end - k < MAX_IDENT && isWordCode(text.charCodeAt(k - 1))) k--
  return k < end && end - k < MAX_IDENT ? k : -1
}

interface CursorPath {
  word: string
  from: number
  /** Qualifier names (folded or quoted). */
  qualifiers: string[]
}

function cursorPath(state: EditorState, pos: number): CursorPath | null {
  const doc = state.doc
  const before = doc.sliceString(Math.max(0, pos - MAX_IDENT), pos)
  let from: number
  // An opening (unclosed) double quote on this line: the word starts there.
  const line = before.slice(before.lastIndexOf('\n') + 1)
  const quotes = (line.match(/"/g) ?? []).length
  if (quotes % 2 === 1) {
    from = pos - (line.length - line.lastIndexOf('"'))
  } else {
    let k = before.length
    while (k > 0 && isWordCode(before.charCodeAt(k - 1))) k--
    if (k === 0 && before.length === MAX_IDENT) return null
    from = pos - (before.length - k)
  }
  const word = doc.sliceString(from, pos)
  const base = Math.max(0, from - 2 * (MAX_IDENT + 1))
  const text = doc.sliceString(base, from)
  const qualifiers: string[] = []
  let end = text.length
  while (qualifiers.length < 2 && text[end - 1] === '.') {
    const start = identStart(text, end - 1)
    if (start < 0) break
    qualifiers.unshift(pgIdentName(text.slice(start, end - 1)))
    end = start
  }
  return { word, from, qualifiers }
}

function statementRange(state: EditorState, tree: Tree, pos: number): { from: number; to: number } {
  let stmt: { from: number; to: number } | null = null
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'Statement') {
        stmt = n
        break
      }
    }
    if (stmt) break
  }
  return {
    from: Math.max(stmt?.from ?? 0, pos - SCOPE_WINDOW),
    to: Math.min(stmt?.to ?? state.doc.length, pos + SCOPE_WINDOW)
  }
}

/* ---------- options ---------- */

const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p
  } catch {
    return fallback
  }
}

/** Exact name first, then case-insensitive (unquoted input against folded names). */
function pick<T>(items: T[], name: string, key: (item: T) => string): T | undefined {
  const lower = name.toLowerCase()
  return items.find((x) => key(x) === name) ?? items.find((x) => key(x).toLowerCase() === lower)
}

function trailingEnd(doc: Text, pos: number, quoted: boolean): number {
  const after = doc.sliceString(pos, Math.min(doc.length, pos + MAX_IDENT))
  if (quoted) {
    const close = after.indexOf('"')
    const eol = after.indexOf('\n')
    if (close >= 0 && (eol < 0 || close < eol)) return pos + close + 1
  }
  let k = 0
  while (k < after.length && isWordCode(after.charCodeAt(k))) k++
  return pos + k
}

function applyWhole(quoted: boolean) {
  return (view: EditorView, completion: Completion, from: number, to: number): void => {
    const end = trailingEnd(view.state.doc, to, quoted)
    view.dispatch({
      ...insertCompletionText(view.state, completion.label, from, end),
      annotations: pickedCompletion.of(completion)
    })
  }
}

const KIND_LABEL: Record<PgRelationKind, string> = {
  table: 'tabla',
  view: 'vista',
  materialized_view: 'vista materializada',
  foreign: 'tabla externa'
}

/** How a completion label is quoted (`force`: the user started a quoted name). */
export type QuoteLabel = (name: string, force: boolean) => string

function relationOptions(
  rels: { name: string; kind: PgRelationKind }[],
  schema: string,
  boost: number,
  quoted: boolean,
  quote: QuoteLabel
): Completion[] {
  return rels.map((r) => ({
    label: quote(r.name, quoted),
    displayLabel: r.name,
    type: r.kind === 'table' || r.kind === 'foreign' ? 'class' : 'type',
    detail: `${KIND_LABEL[r.kind] ?? 'tabla'} · ${schema}`,
    boost,
    apply: applyWhole(quoted)
  }))
}

function columnOptions(
  cols: { name: string; type: string }[],
  table: string,
  boost: number,
  quoted: boolean,
  quote: QuoteLabel
): Completion[] {
  return cols.map((c) => ({
    label: quote(c.name, quoted),
    displayLabel: c.name,
    type: 'property',
    detail: `${c.type} · ${table}`,
    boost,
    apply: applyWhole(quoted)
  }))
}

function functionOptions(
  fns: { name: string; signature: string }[],
  schema: string,
  boost: number,
  quoted: boolean,
  quote: QuoteLabel
): Completion[] {
  const seen = new Set<string>()
  const out: Completion[] = []
  for (const f of fns) {
    if (seen.has(f.name)) continue
    seen.add(f.name)
    out.push({
      label: quote(f.name, quoted),
      displayLabel: f.name,
      type: 'function',
      detail: `${f.name}(${f.signature}) · ${schema}`,
      boost,
      apply: applyWhole(quoted)
    })
  }
  return out
}

/**
 * Context-aware PostgreSQL completion: relations of the search_path and schema
 * names for a bare word, relations after `schema.`, columns after `rel.`,
 * `alias.` or `schema.rel.`, and columns of relations used in the statement.
 * `quote` writes the labels (SQL Server passes its bracket rule).
 */
export function pgCompletionSource(
  provider: PgSchemaProvider,
  quote: QuoteLabel = pgQuoteIdent
): CompletionSource {
  const schemaOf = async (name: string): Promise<string | null> =>
    pick(await safe(provider.schemas(), []), name, (s) => s) ?? null
  /** Schema + real name of a relation; unqualified names go through the search_path. */
  const resolve = async (
    schema: string | null,
    table: string
  ): Promise<{ schema: string; table: string } | null> => {
    const candidates = schema
      ? [(await schemaOf(schema)) ?? schema]
      : provider.searchPath().slice(0, MAX_PATH)
    for (const s of candidates) {
      const rels = await safe(provider.tables(s), [])
      const found = pick(rels, table, (r) => r.name)
      if (found) return { schema: s, table: found.name }
    }
    return null
  }
  const columnsOf = async (schema: string | null, table: string) => {
    const r = await resolve(schema, table)
    return r ? { table: r.table, cols: await safe(provider.columns(r.schema, r.table), []) } : null
  }

  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const { state, pos } = ctx
    const tree =
      ensureSyntaxTree(state, Math.min(state.doc.length, pos + SCOPE_WINDOW), 50) ??
      syntaxTree(state)
    if (inLiteralNode(tree.resolveInner(pos, -1), pos, state.doc)) return null
    const range = statementRange(state, tree, pos)
    if (insideLiteral(state.doc.sliceString(range.from, pos))) return null
    const path = cursorPath(state, pos)
    if (!path) return null
    const { word, from, qualifiers } = path
    if (!qualifiers.length && !word && !ctx.explicit) return null

    const quoted = word.startsWith('"')
    const validFor = /^(?:"[^"]*"?|[\w$\u0080-￿]*)$/
    const refs = pgTableRefs(state.doc.sliceString(range.from, range.to))

    if (qualifiers.length === 2) {
      const found = await columnsOf(qualifiers[0], qualifiers[1])
      if (!found) return null
      return { from, options: columnOptions(found.cols, found.table, 0, quoted, quote), validFor }
    }

    if (qualifiers.length === 1) {
      const q = qualifiers[0]
      const options: Completion[] = []
      const lower = q.toLowerCase()
      const ref = refs.find((r) =>
        r.alias ? r.alias === q || r.alias.toLowerCase() === lower : r.table.toLowerCase() === lower
      )
      const found = ref ? await columnsOf(ref.schema, ref.table) : await columnsOf(null, q)
      if (found) options.push(...columnOptions(found.cols, found.table, 2, quoted, quote))
      const schema = await schemaOf(q)
      if (schema) {
        options.push(...relationOptions(await safe(provider.tables(schema), []), schema, 1, quoted, quote))
        if (provider.functions)
          options.push(
            ...functionOptions(await safe(provider.functions(schema), []), schema, 0, quoted, quote)
          )
      }
      return options.length ? { from, options, validFor } : null
    }

    const searchPath = provider.searchPath().slice(0, MAX_PATH)
    const [schemas, relLists, fnLists] = await Promise.all([
      safe(provider.schemas(), []),
      Promise.all(searchPath.map((s) => safe(provider.tables(s), []))),
      provider.functions
        ? Promise.all(searchPath.map((s) => safe(provider.functions!(s), [])))
        : Promise.resolve([] as { name: string; signature: string }[][])
    ])
    const options: Completion[] = []
    const seenRel = new Set<string>()
    searchPath.forEach((s, i) => {
      // An earlier schema shadows the same name later in the path.
      const rels = relLists[i].filter((r) => !seenRel.has(r.name))
      rels.forEach((r) => seenRel.add(r.name))
      options.push(...relationOptions(rels, s, 3 - i * 0.1, quoted, quote))
    })
    fnLists.forEach((fns, i) =>
      options.push(...functionOptions(fns, searchPath[i], -1 - i * 0.1, quoted, quote))
    )
    options.push(
      ...schemas.map((s) => ({
        label: quote(s, quoted),
        displayLabel: s,
        type: 'namespace',
        detail: 'esquema',
        boost: 2,
        apply: applyWhole(quoted)
      }))
    )
    const seen = new Set<string>()
    const lookups: ReturnType<typeof columnsOf>[] = []
    for (const r of refs) {
      const key = `${r.schema ?? ''}\u0000${r.table}`
      if (seen.has(key)) continue
      seen.add(key)
      lookups.push(columnsOf(r.schema, r.table))
      if (lookups.length >= MAX_REFS) break
    }
    for (const found of await Promise.all(lookups))
      if (found) options.push(...columnOptions(found.cols, found.table, 1, quoted, quote))
    return { from, options, validFor }
  }
}
