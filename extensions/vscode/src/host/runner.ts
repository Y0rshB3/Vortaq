/**
 * Runs SQL from editors and opens data in the results panel:
 * - «Ejecutar» (Cmd/Ctrl+Enter): the selection, else the statement under the
 *   cursor, else the whole document; «Ejecutar todo»: the whole document;
 * - «Detener»: PostgreSQL cancels the statement (pg_cancel_backend), SQLite
 *   ends its worker process; MySQL cannot cancel from here, so later results
 *   are discarded (as in the desktop app);
 * - «Ver datos» (first rows of a table or view) and «Ver documentos» (first
 *   documents of a MongoDB collection, read-only in this version).
 * Every write goes through the WriteGuard first.
 */
import { defaultSchemaOf, selectFirstRows, usesSchemaRef } from '@core'
import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import type {
  ConnectionConfig,
  QueryExecuteOptions,
  QueryStatementResult,
  SchemaRef,
  VortaqCore
} from '@core'
import type { ConnectionService } from './connections'
import { sqlDialectOf, type WriteGuard } from './guard'
import type { ResultsPanels } from './panels/results'
import type { ExtensionSettings } from './settings'
import { runTarget, type RunTarget } from './statement'
import { pickTarget } from './sqlDocuments'
import { targetLabel, type DocumentTarget, type DocumentTargets } from './targets'
import type { ObjectNode, TreeNode } from './tree'
import { schemaRefOf } from './tree'
import type { ResultsState, WebviewSettings } from '../webviewState'
import type { ExecutionPlan } from '@shared/plan/types'
import { showInformation, showWarning } from './notice'

interface Running {
  seq: number
  connectionId: string
  executionId: string | null
  started: number
}

const hasTabSession = (c: Pick<ConnectionConfig, 'engine'>): boolean =>
  c.engine === 'postgresql' || c.engine === 'sqlite' || c.engine === 'sqlserver'

/**
 * Where a document's statements run, so «Exportar › Resultado completo» reads
 * in the same place (as the desktop query view): PostgreSQL `{ database,
 * schema }`, MySQL/MariaDB the database, SQLite null (one file).
 */
export function runContext(
  connection: Pick<ConnectionConfig, 'engine'>,
  target: Pick<DocumentTarget, 'database' | 'schema'>
): SchemaRef | null {
  if (usesSchemaRef(connection.engine))
    return { database: target.database ?? '', schema: target.schema ?? '' }
  if (connection.engine === 'sqlite') return null
  return target.database
}

/** What a finished run reports (never shown to anyone else; the history keeps no values). */
export interface FinishedRun {
  connection: ConnectionConfig
  target: DocumentTarget
  sql: string
  durationMs: number
  results: QueryStatementResult[]
  /** The whole run failed (the server or the connection refused it). */
  failed: boolean
}

export class SqlRunner implements vscode.Disposable {
  private readonly running = new Map<string, Running>()
  /** Documents between «Ejecutar» and their run starting (prompts, connecting). */
  private readonly starting = new Set<string>()
  private seq = 0
  private runIds = 0
  /** Documents with a tab session on the server (PostgreSQL/SQLite), by URI. */
  private readonly sessions = new Map<string, string>()
  private readonly highlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    isWholeLine: false
  })
  private readonly runningChanged = new vscode.EventEmitter<void>()
  readonly onDidChangeRunning = this.runningChanged.event

  constructor(
    private readonly core: VortaqCore,
    private readonly connections: ConnectionService,
    private readonly targets: DocumentTargets,
    private readonly guard: WriteGuard,
    private readonly results: ResultsPanels,
    private readonly settings: () => ExtensionSettings,
    private readonly webviewSettings: () => WebviewSettings
  ) {}

  private readonly ran = new vscode.EventEmitter<FinishedRun>()
  /** A script finished (with results or failing): the query history records it. */
  readonly onDidRun = this.ran.event

  isRunning(uri: string): boolean {
    return this.running.has(uri)
  }

  /** «Elegir conexión y base de datos» of a document. */
  async pick(doc: vscode.TextDocument): Promise<DocumentTarget | null> {
    const uri = doc.uri.toString()
    const target = await pickTarget(this.connections, this.targets.get(uri))
    if (target) await this.setTarget(uri, target)
    return target
  }

  /** Sets a document's target; a different connection or database closes the old session. */
  async setTarget(uri: string, target: DocumentTarget): Promise<void> {
    const previous = this.targets.get(uri)
    if (
      previous &&
      (previous.connectionId !== target.connectionId || previous.database !== target.database)
    )
      await this.closeSession(uri)
    await this.targets.set(uri, target)
  }

  async run(editor: vscode.TextEditor, all: boolean): Promise<void> {
    const doc = editor.document
    const uri = doc.uri.toString()
    // `starting` covers the prompts and the connect before the run is registered, so a second
    // Cmd+Enter meanwhile cannot send the script twice.
    if (this.running.has(uri) || this.starting.has(uri)) {
      void showInformation(
        'Este documento ya está ejecutando una consulta. Pulsa «Detener» para cancelarla.'
      )
      return
    }
    this.starting.add(uri)
    try {
      let target = this.targets.get(uri)
      let connection = target ? this.connections.get(target.connectionId) : null
      if (!target || !connection) {
        target = await this.pick(doc)
        connection = target ? this.connections.get(target.connectionId) : null
        if (!target || !connection) return
      }
      // Open first: a `mysql` connection whose server is MariaDB becomes `mariadb` when it
      // opens, and the statement split and the guard must use the dialect that will run it.
      if (!(await this.connections.open(connection.id))) return
      connection = this.connections.get(connection.id) ?? connection
      const text = doc.getText()
      const selection = editor.selection
      const picked: RunTarget | null = all
        ? text.trim()
          ? { sql: text, start: 0, end: text.length, kind: 'document' }
          : null
        : runTarget(
            text,
            { start: doc.offsetAt(selection.start), end: doc.offsetAt(selection.end) },
            sqlDialectOf(connection)
          )
      if (!picked) {
        void showWarning('No hay SQL para ejecutar.')
        return
      }
      await this.execute(uri, connection, target, picked, editor)
    } finally {
      this.starting.delete(uri)
    }
  }

  /** Runs `picked` for the document `uri` (also used by the integration tests). */
  async execute(
    uri: string,
    connection: ConnectionConfig,
    target: DocumentTarget,
    picked: RunTarget,
    editor?: vscode.TextEditor
  ): Promise<QueryStatementResult[] | null> {
    if (this.running.has(uri)) return null
    if (!(await this.results.mayReplace(`doc:${uri}`))) return null
    const info = await this.connections.open(connection.id)
    if (!info) return null
    connection = this.connections.get(connection.id) ?? connection
    const decision = await this.guard.checkSql(
      connection,
      picked.sql,
      this.settings().confirmDestructive
    )
    if (!decision.proceed) {
      vscode.window.setStatusBarMessage(
        '$(circle-slash) Ejecución cancelada: no se envió nada al servidor',
        5000
      )
      return null
    }
    if (this.running.has(uri)) return null
    if (editor) this.flash(editor, picked)

    const name = uri.startsWith('untitled:')
      ? uri.slice('untitled:'.length)
      : vscode.Uri.parse(uri).path.split('/').pop()
    const panel = this.results.open(`doc:${uri}`, {
      ...this.state(connection, `Resultados · ${name}`, targetLabel(target), true),
      script: picked.sql,
      context: runContext(connection, target)
    })
    const seq = ++this.seq
    const executionId = hasTabSession(connection) ? `exec-${randomUUID()}` : null
    const run: Running = { seq, connectionId: connection.id, executionId, started: Date.now() }
    this.running.set(uri, run)
    this.runningChanged.fire()
    const options: QueryExecuteOptions = {
      maxRows: this.settings().maxRows,
      ...(decision.confirmProduction ? { confirmProduction: true } : {})
    }
    if (usesSchemaRef(connection.engine)) {
      options.schema = { database: target.database ?? '', schema: target.schema ?? '' }
    } else if (target.database !== null) options.schema = target.database
    if (executionId) {
      options.executionId = executionId
      options.sessionKey = uri
      this.sessions.set(uri, connection.id)
    }
    try {
      const out = await this.core.invoke('db:execute', connection.id, picked.sql, options)
      if (this.running.get(uri)?.seq !== seq) return null
      panel.update({
        running: false,
        canStop: false,
        results: out,
        totalMs: Date.now() - run.started,
        notice: null
      })
      // `SET search_path` in the script moved the document's schema: follow it.
      const effective = out[out.length - 1]?.effectiveSchema
      if (connection.engine === 'postgresql' && effective && effective !== target.schema)
        await this.targets.set(uri, { ...target, schema: effective })
      this.ran.fire({
        connection,
        target,
        sql: picked.sql,
        durationMs: Date.now() - run.started,
        results: out,
        failed: false
      })
      const failed = out.filter((r) => r.error).length
      vscode.window.setStatusBarMessage(
        failed
          ? `$(error) ${failed} sentencia(s) con error`
          : `$(check) ${out.length} sentencia(s) · ${Date.now() - run.started} ms`,
        5000
      )
      return out
    } catch (err) {
      if (this.running.get(uri)?.seq !== seq) return null
      panel.update({
        running: false,
        canStop: false,
        results: [],
        totalMs: Date.now() - run.started,
        notice: err instanceof Error ? err.message : String(err)
      })
      this.ran.fire({
        connection,
        target,
        sql: picked.sql,
        durationMs: Date.now() - run.started,
        results: [],
        failed: true
      })
      return null
    } finally {
      if (this.running.get(uri)?.seq === seq) {
        this.running.delete(uri)
        this.runningChanged.fire()
      }
    }
  }

  /**
   * «Plan de ejecución» of the statement under the cursor (or the selection),
   * shown in the document's results panel next to its results. Estimated plans
   * never run it; the actual one runs a read-only SELECT where nothing can be
   * kept (src/main/plan/service.ts), so neither needs the typed confirmation.
   */
  async plan(editor: vscode.TextEditor, actual: boolean): Promise<ExecutionPlan | null> {
    const doc = editor.document
    const uri = doc.uri.toString()
    let target = this.targets.get(uri)
    let connection = target ? this.connections.get(target.connectionId) : null
    if (!target || !connection) {
      target = await this.pick(doc)
      connection = target ? this.connections.get(target.connectionId) : null
      if (!target || !connection) return null
    }
    if (connection.engine === 'mongodb') {
      void showInformation(
        'MongoDB no tiene plan de ejecución en Vortaq: usa .explain() en la consulta.'
      )
      return null
    }
    if (!(await this.connections.open(connection.id))) return null
    connection = this.connections.get(connection.id) ?? connection
    const text = doc.getText()
    const selection = editor.selection
    const picked = runTarget(
      text,
      { start: doc.offsetAt(selection.start), end: doc.offsetAt(selection.end) },
      sqlDialectOf(connection)
    )
    if (!picked) {
      void showWarning('No hay SQL para analizar.')
      return null
    }
    const schema = usesSchemaRef(connection.engine)
      ? { database: target.database ?? '', schema: target.schema ?? '' }
      : target.database
    const plan = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: actual ? 'Vortaq: plan real…' : 'Vortaq: plan estimado…'
      },
      () => this.core.invoke('db:plan', connection.id, { sql: picked.sql, actual, schema })
    )
    const key = `doc:${uri}`
    const name = uri.startsWith('untitled:')
      ? uri.slice('untitled:'.length)
      : vscode.Uri.parse(uri).path.split('/').pop()
    const existing = this.results.get(key)
    if (existing && !existing.isDisposed) {
      existing.update({ plan, planId: (existing.state.planId ?? 0) + 1 })
      existing.reveal()
    } else
      this.results.open(key, {
        ...this.state(connection, `Resultados · ${name}`, targetLabel(target), false),
        plan,
        planId: 1
      })
    return plan
  }

  /** «Detener» of a document's run (or of the panel that shows it). */
  async stop(uri: string): Promise<void> {
    const run = this.running.get(uri)
    if (!run) return
    const panel = this.results.get(`doc:${uri}`)
    if (run.executionId) {
      const connection = this.connections.get(run.connectionId)
      panel?.update({
        notice:
          connection?.engine === 'sqlite'
            ? 'Cancelando la consulta en curso (se reabrirá el archivo)…'
            : 'Cancelando la consulta en curso…'
      })
      const ok = await this.core
        .invoke('db:cancel', run.connectionId, run.executionId)
        .catch(() => false)
      if (!ok && this.running.get(uri)?.seq === run.seq)
        panel?.update({
          notice:
            'No se pudo cancelar todavía: la sentencia aún no había empezado. Pulsa Detener de nuevo.'
        })
      return
    }
    // MySQL/MariaDB: the server may finish the statement; its results are dropped.
    this.running.delete(uri)
    this.runningChanged.fire()
    panel?.update({
      running: false,
      canStop: false,
      notice:
        'Ejecución detenida. El servidor puede terminar la sentencia en curso; sus resultados se descartarán.'
    })
  }

  /** The key of a panel → its document URI («Detener» from the panel). */
  stopPanel(key: string): void {
    if (key.startsWith('doc:')) void this.stop(key.slice(4))
  }

  /** Closes the document's server session (PostgreSQL/SQLite: rolls back an open transaction). */
  async closeSession(uri: string): Promise<void> {
    const connectionId = this.sessions.get(uri)
    if (!connectionId) return
    this.sessions.delete(uri)
    if (!this.connections.isOpen(connectionId)) return
    await this.core.invoke('db:closeSession', connectionId, uri).catch(() => undefined)
  }

  /** Forgets the sessions of a connection that closed (the server already ended them). */
  connectionClosed(connectionId: string): void {
    for (const [uri, id] of [...this.sessions]) if (id === connectionId) this.sessions.delete(uri)
  }

  /** «Ver datos»: the first rows of a table or view, editable when it has a key. */
  async viewData(node: ObjectNode): Promise<QueryStatementResult[] | null> {
    const connection = this.connections.get(node.connectionId)
    if (!connection) return null
    if (!(await this.connections.open(connection.id))) return null
    const dialect = sqlDialectOf(connection)
    const limit = this.settings().maxRows
    const namespace = usesSchemaRef(connection.engine)
      ? (node.schema ?? defaultSchemaOf(connection.engine))
      : node.database
    const sql = selectFirstRows(dialect, dialect.qualified(namespace, node.name), limit)
    const where = [node.database, node.schema].filter(Boolean).join('.')
    const key = `data:${connection.id}:${where}:${node.name}`
    if (!(await this.results.mayReplace(key))) return null
    const schema = schemaRefOf(connection, node.database, node.schema)
    // «Exportar › Resultado completo» reads the whole table, not these first rows.
    const panel = this.results.open(
      key,
      {
        ...this.state(connection, `${node.name} · ${connection.name}`, where, true, false),
        script: sql,
        context: connection.engine === 'sqlite' ? null : schema
      },
      { sql, schema, table: node.name }
    )
    const started = Date.now()
    const options: QueryExecuteOptions = { maxRows: limit }
    options.schema = schema
    try {
      const out = await this.core.invoke('db:execute', connection.id, sql, options)
      panel.update({ running: false, canStop: false, results: out, totalMs: Date.now() - started })
      return out
    } catch (err) {
      panel.update({
        running: false,
        canStop: false,
        notice: err instanceof Error ? err.message : String(err),
        totalMs: Date.now() - started
      })
      return null
    }
  }

  /** «Ver documentos»: the first documents of a collection (read-only in this version). */
  async viewDocuments(
    node: Extract<TreeNode, { kind: 'collection' }>
  ): Promise<ResultsState | null> {
    const connection = this.connections.get(node.connectionId)
    if (!connection) return null
    if (!(await this.connections.open(connection.id))) return null
    const key = `docs:${connection.id}:${node.database}:${node.name}`
    const title = `${node.name} · ${connection.name}`
    const panel = this.results.open(key, {
      ...this.state(connection, title, `${node.database}.${node.name}`, true, false),
      kind: 'documents'
    })
    try {
      const page = await this.core.invoke('mongo:find', connection.id, {
        database: node.database,
        collection: node.name,
        filter: '{}',
        sort: '',
        projection: '',
        skip: 0,
        limit: this.settings().maxRows,
        owner: key
      })
      // No «Cargar más» in this version: release the server cursor now.
      if (page.resultId)
        await this.core
          .invoke('mongo:closeCursor', connection.id, page.resultId)
          .catch(() => undefined)
      panel.update({
        running: false,
        canStop: false,
        totalMs: page.durationMs,
        documents: {
          database: node.database,
          collection: node.name,
          docs: page.docs,
          total: page.total,
          totalExact: page.totalExact,
          truncated: page.truncated,
          durationMs: page.durationMs
        }
      })
    } catch (err) {
      panel.update({
        running: false,
        canStop: false,
        notice: err instanceof Error ? err.message : String(err)
      })
    }
    return panel.state
  }

  private state(
    connection: ConnectionConfig,
    title: string,
    target: string,
    running: boolean,
    canStop = running
  ): ResultsState {
    return {
      kind: 'sql',
      runId: ++this.runIds,
      title,
      connection,
      target,
      platform: process.platform,
      settings: this.webviewSettings(),
      running,
      results: [],
      script: null,
      context: null,
      totalMs: null,
      notice: null,
      documents: null,
      canStop
    }
  }

  /** Brief highlight of what was sent. */
  private flash(editor: vscode.TextEditor, picked: RunTarget): void {
    if (picked.kind === 'document') return
    const doc = editor.document
    const range = new vscode.Range(doc.positionAt(picked.start), doc.positionAt(picked.end))
    editor.setDecorations(this.highlight, [range])
    setTimeout(() => editor.setDecorations(this.highlight, []), 700)
  }

  dispose(): void {
    this.highlight.dispose()
    this.runningChanged.dispose()
    this.ran.dispose()
  }
}
