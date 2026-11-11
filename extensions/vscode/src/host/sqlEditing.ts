/**
 * Autocompletion and «Dar formato al documento» for SQL documents, with the
 * desktop app's own logic (docs/vscode-extension-design.md, «Autocompletado»):
 *
 * - Completion runs the query editor's CodeMirror completion sources headless
 *   (an EditorState of the text around the cursor, no view): keywords of the
 *   engine's dialect, plus databases, schemas, tables, views, columns and
 *   functions of the document's target, read with the core's db:* channels
 *   (structure only) and cached per connection and database for a while.
 *   Metadata is read only while the connection is open: completing never
 *   opens a connection or asks for a password.
 * - Formatting is the desktop's «Formatear SQL» (sql-formatter with the
 *   engine's grammar; T-SQL batch by batch, GO lines kept).
 */
import * as vscode from 'vscode'
import { CompletionContext, type Completion, type CompletionSource } from '@codemirror/autocomplete'
import { keywordCompletionSource, sql, StandardSQL, type SQLDialect } from '@codemirror/lang-sql'
import { EditorState } from '@codemirror/state'
import type { EngineId, SchemaRef, VortaqCore } from '@core'
import {
  msCompletionSource,
  msSearchPath,
  vortaqMSSQL,
  cachedMs
} from '@renderer/components/common/editor/msCompletion'
import { vortaqMariaSQL } from '@renderer/components/common/editor/mariadbCompletion'
import {
  cachedPg,
  pgCompletionSource,
  vortaqPostgreSQL,
  type PgRelationKind
} from '@renderer/components/common/editor/pgCompletion'
import {
  cached,
  schemaCompletionSource,
  vortaqMySQL
} from '@renderer/components/common/editor/sqlCompletion'
import {
  cachedSqlite,
  sqliteCompletionSource,
  vortaqSQLite
} from '@renderer/components/common/editor/sqliteCompletion'
import { beautifySql, formatterDialectOf } from '@renderer/components/query/beautifySql'
import type { ConnectionService } from './connections'
import type { DocumentTarget, DocumentTargets } from './targets'

/** Text around the cursor the sources see (they bound their own scans the same way). */
const WINDOW_BEFORE = 20_000
const WINDOW_AFTER = 4_000
/** How long a connection's metadata is reused before it is read again. */
export const METADATA_TTL_MS = 2 * 60 * 1000

/** One suggestion, in document offsets, ready for vscode.CompletionItem. */
export interface SqlSuggestion {
  label: string
  insertText: string
  filterText: string
  type: string
  detail?: string
  sortText: string
  from: number
  /** End of the identifier under the cursor (replace mode). */
  to: number
}

/* ---------- headless CodeMirror (pure) ---------- */

/** End of the identifier (and its closing quote) that starts before `pos`. */
function identifierEnd(text: string, pos: number): number {
  let k = pos
  while (k < text.length && /[\w$#@\u0080-￿]/.test(text[k])) k++
  if (k < text.length && /[\]`"]/.test(text[k])) k++
  return k
}

const QUOTE_START = /^[[`"]/

function suggestionOf(
  option: Completion,
  from: number,
  cursor: number,
  text: string
): SqlSuggestion {
  const shown = option.displayLabel ?? option.label
  const typed = text.slice(from, cursor)
  const boost = option.boost ?? 0
  return {
    label: shown,
    insertText: option.label,
    filterText: QUOTE_START.test(typed) ? option.label : shown,
    type: option.type ?? 'text',
    ...(option.detail ? { detail: option.detail } : {}),
    // Higher boost first; keywords after names of the same score.
    sortText: `${String(500 - boost).padStart(4, '0')}${option.type === 'keyword' ? '1' : '0'}${shown.toLowerCase()}`,
    from,
    to: identifierEnd(text, cursor)
  }
}

/**
 * Runs CodeMirror completion sources on `text` at `offset`, as the desktop
 * editor would, and returns the merged suggestions.
 */
export async function suggestionsAt(
  text: string,
  offset: number,
  explicit: boolean,
  dialect: SQLDialect,
  sources: CompletionSource[]
): Promise<SqlSuggestion[]> {
  // A window of whole lines around the cursor keeps big scripts fast.
  const startLine = text.lastIndexOf('\n', Math.max(0, offset - WINDOW_BEFORE))
  const base = offset - WINDOW_BEFORE > 0 ? startLine + 1 : 0
  const endLine = text.indexOf('\n', offset + WINDOW_AFTER)
  const slice = text.slice(base, endLine < 0 ? text.length : endLine)
  const pos = offset - base
  const state = EditorState.create({
    doc: slice,
    selection: { anchor: pos },
    extensions: [sql({ dialect, upperCaseKeywords: true })]
  })
  const out: SqlSuggestion[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    const result = await source(new CompletionContext(state, pos, explicit))
    if (!result) continue
    for (const option of result.options) {
      const key = `${option.type ?? ''}:${option.label}`
      if (seen.has(key)) continue
      seen.add(key)
      const s = suggestionOf(option, result.from, pos, slice)
      out.push({ ...s, from: s.from + base, to: s.to + base })
    }
  }
  return out
}

const KINDS: Record<string, vscode.CompletionItemKind> = {
  keyword: vscode.CompletionItemKind.Keyword,
  class: vscode.CompletionItemKind.Class,
  type: vscode.CompletionItemKind.Interface,
  property: vscode.CompletionItemKind.Field,
  function: vscode.CompletionItemKind.Function,
  method: vscode.CompletionItemKind.Method,
  namespace: vscode.CompletionItemKind.Module,
  constant: vscode.CompletionItemKind.Constant,
  variable: vscode.CompletionItemKind.Variable,
  enum: vscode.CompletionItemKind.Enum
}

/* ---------- metadata of a document's target ---------- */

interface EngineCompletion {
  dialect: SQLDialect
  source: CompletionSource | null
}

const KEYWORDS_ONLY: EngineCompletion = { dialect: StandardSQL, source: null }

export class SqlCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {
  /** Per connection + database (+ schema): the cached source and when it was made. */
  private readonly sources = new Map<string, { made: number; engine: EngineCompletion }>()
  private readonly subscriptions: vscode.Disposable[] = []

  constructor(
    private readonly core: VortaqCore,
    private readonly connections: ConnectionService,
    private readonly targets: DocumentTargets,
    private readonly now: () => number = Date.now
  ) {
    // Saved, imported or edited connections: read their structure again.
    this.subscriptions.push(connections.onDidChange(() => this.sources.clear()))
  }

  /** After running a script that may have changed the structure (CREATE, ALTER…). */
  forget(connectionId: string): void {
    for (const key of [...this.sources.keys()])
      if (key.startsWith(`${connectionId}\u0000`)) this.sources.delete(key)
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[]> {
    const target = this.targets.get(document.uri.toString())
    const engine = this.engineFor(target)
    const sources = [keywordCompletionSource(engine.dialect, true)]
    if (engine.source) sources.unshift(engine.source)
    const text = document.getText()
    const offset = document.offsetAt(position)
    let suggestions: SqlSuggestion[]
    try {
      suggestions = await suggestionsAt(
        text,
        offset,
        context.triggerKind === vscode.CompletionTriggerKind.Invoke,
        engine.dialect,
        sources
      )
    } catch {
      return []
    }
    if (token.isCancellationRequested) return []
    return suggestions.map((s) => {
      const item = new vscode.CompletionItem(
        { label: s.label, description: s.detail },
        KINDS[s.type] ?? vscode.CompletionItemKind.Text
      )
      item.insertText = s.insertText
      item.filterText = s.filterText
      item.sortText = s.sortText
      if (s.detail) item.detail = s.detail
      const start = document.positionAt(s.from)
      item.range = {
        inserting: new vscode.Range(start, position),
        replacing: new vscode.Range(start, document.positionAt(s.to))
      }
      return item
    })
  }

  private engineFor(target: DocumentTarget | null): EngineCompletion {
    if (!target) return KEYWORDS_ONLY
    const connection = this.connections.get(target.connectionId)
    if (!connection) return KEYWORDS_ONLY
    const key = `${target.connectionId}\u0000${target.database ?? ''}\u0000${target.schema ?? ''}`
    const hit = this.sources.get(key)
    if (hit && this.now() - hit.made < METADATA_TTL_MS) return hit.engine
    const engine = this.build(connection.engine, target)
    this.sources.set(key, { made: this.now(), engine })
    return engine
  }

  /** Reads structure only while the connection is open; otherwise every list is empty. */
  private invoke<T>(target: DocumentTarget, channel: string, ...args: unknown[]): Promise<T[]> {
    if (!this.connections.isOpen(target.connectionId)) return Promise.resolve([])
    return (this.core.invoke as (c: string, ...a: unknown[]) => Promise<T[]>)(
      channel,
      target.connectionId,
      ...args
    ).catch(() => [])
  }

  private build(engine: EngineId, target: DocumentTarget): EngineCompletion {
    const id = target.connectionId
    type Named = { name: string }
    type Column = { name: string; columnType: string }
    const columns = (cols: Column[]) => cols.map((c) => ({ name: c.name, type: c.columnType }))

    if (engine === 'mysql' || engine === 'mariadb') {
      const provider = cached({
        defaultSchema: () => target.database,
        databases: async () =>
          (await this.invoke<Named>(target, 'db:databases')).map((d) => d.name),
        tables: async (s) => {
          const [tables, views, sequences] = await Promise.all([
            this.invoke<Named>(target, 'db:tables', s),
            this.invoke<Named>(target, 'db:views', s),
            engine === 'mariadb'
              ? this.invoke<Named>(target, 'db:objects', s, 'sequence')
              : Promise.resolve([])
          ])
          return [
            ...tables.map((t) => ({ name: t.name, kind: 'table' as const })),
            ...views.map((v) => ({ name: v.name, kind: 'view' as const })),
            ...sequences.map((q) => ({ name: q.name, kind: 'sequence' as const }))
          ]
        },
        columns: async (s, t) => columns(await this.invoke<Column>(target, 'db:columns', s, t))
      })
      return {
        dialect: engine === 'mariadb' ? vortaqMariaSQL : vortaqMySQL,
        source: schemaCompletionSource(provider)
      }
    }

    if (engine === 'postgresql' || engine === 'sqlserver') {
      const database = target.database ?? ''
      const ref = (s: string): SchemaRef => ({ database, schema: s })
      const relations = async (s: string) => {
        const [tables, views, matviews] = await Promise.all([
          this.invoke<Named & { engine?: string }>(target, 'db:tables', ref(s)),
          this.invoke<Named>(target, 'db:views', ref(s)),
          engine === 'postgresql'
            ? this.invoke<Named>(target, 'db:objects', ref(s), 'materialized_view')
            : Promise.resolve([])
        ])
        return [
          ...tables.map((t) => ({
            name: t.name,
            kind: (t.engine === 'foránea' ? 'foreign' : 'table') as PgRelationKind
          })),
          ...views.map((v) => ({ name: v.name, kind: 'view' as PgRelationKind })),
          ...matviews.map((m) => ({ name: m.name, kind: 'materialized_view' as PgRelationKind }))
        ]
      }
      const common = {
        schemas: async () =>
          database
            ? (await this.invoke<Named>(target, 'db:schemas', database)).map((s) => s.name)
            : [],
        tables: async (s: string) => (database ? relations(s) : []),
        columns: async (s: string, t: string) =>
          database ? columns(await this.invoke<Column>(target, 'db:columns', ref(s), t)) : []
      }
      if (engine === 'sqlserver') {
        const provider = cachedMs({
          searchPath: () => msSearchPath(target.schema),
          ...common,
          functions: async (s) =>
            database
              ? (await this.invoke<Named & { type: string }>(target, 'db:routines', ref(s)))
                  .filter((r) => r.type === 'FUNCTION')
                  .map((f) => ({ name: f.name, signature: '' }))
              : []
        })
        return { dialect: vortaqMSSQL, source: msCompletionSource(provider) }
      }
      const connection = this.connections.get(id)
      const configured = (connection?.postgres?.searchPath ?? '')
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter((s) => s && s !== '$user')
      const provider = cachedPg({
        searchPath: () =>
          [
            ...new Set(
              [target.schema ?? '', ...(configured.length ? configured : ['public'])].filter(
                Boolean
              )
            )
          ] as string[],
        ...common,
        functions: async (s) =>
          database
            ? (
                await this.invoke<Named & { signature?: string }>(
                  target,
                  'db:objects',
                  ref(s),
                  'function'
                )
              ).map((f) => ({ name: f.name, signature: f.signature ?? '' }))
            : []
      })
      return { dialect: vortaqPostgreSQL, source: pgCompletionSource(provider) }
    }

    if (engine === 'sqlite') {
      const provider = cachedSqlite({
        defaultDatabase: () => target.database || 'main',
        databases: async () =>
          (await this.invoke<Named>(target, 'db:databases')).map((d) => d.name),
        tables: async (db) => {
          const [tables, views] = await Promise.all([
            this.invoke<Named>(target, 'db:tables', db),
            this.invoke<Named>(target, 'db:views', db)
          ])
          return [
            ...tables.map((t) => ({ name: t.name, kind: 'table' as const })),
            ...views.map((v) => ({ name: v.name, kind: 'view' as const }))
          ]
        },
        columns: async (db, table) =>
          columns(await this.invoke<Column>(target, 'db:columns', db, table))
      })
      return { dialect: vortaqSQLite, source: sqliteCompletionSource(provider) }
    }
    return KEYWORDS_ONLY
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose()
    this.sources.clear()
  }
}

/* ---------- formatting ---------- */

export class SqlFormattingProvider
  implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider
{
  constructor(
    private readonly connections: ConnectionService,
    private readonly targets: DocumentTargets,
    private readonly warn: (message: string) => void
  ) {}

  private format(document: vscode.TextDocument, range: vscode.Range): vscode.TextEdit[] {
    const text = document.getText(range)
    if (!text.trim()) return []
    const target = this.targets.get(document.uri.toString())
    const engine = target ? this.connections.get(target.connectionId)?.engine : null
    const result = beautifySql(text, formatterDialectOf(engine))
    if (!result.structured) {
      this.warn(
        'No se pudo analizar el SQL para darle formato: el texto queda como estaba (o solo con las palabras clave en mayúsculas).'
      )
    }
    return result.sql === text ? [] : [vscode.TextEdit.replace(range, result.sql)]
  }

  provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
    const whole = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    )
    return this.format(document, whole)
  }

  provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.TextEdit[] {
    return this.format(document, range)
  }
}
