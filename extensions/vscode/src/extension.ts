/**
 * Vortaq for VS Code and compatible editors (Cursor, VSCodium, Windsurf):
 * activation, commands and wiring. The database work is Vortaq's core
 * (src/core, Electron-free) with this host's ports (host/core.ts); this file
 * only connects VS Code's UI to it.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'
import {
  defaultSchemaOf,
  ENGINES,
  environmentName,
  runOutcome,
  trustFixesError,
  selectFirstRows,
  usesSchemaRef,
  type ConnectionConfig,
  type EngineId,
  type ProgressEvent
} from '@core'
import { ConnectionService } from './host/connections'
import { createExtensionCore } from './host/core'
import {
  desktopProfileDir,
  parseDesktopConnections,
  readDesktopConnections,
  type DesktopConnection,
  type DesktopImportPreview
} from './host/desktopImport'
import { sqlDialectOf, vscodePrompter, WriteGuard, type Prompter } from './host/guard'
import { coreMcpPorts, McpService, registerMcpProvider } from './host/mcp'
import { showConnectionMcp, showMcpManager, type McpManagerDeps } from './host/mcpManager'
import { ExtensionUpdater, readInstallSource } from './host/updates'
import { ConnectionFormPanel } from './host/panels/connectionForm'
import { ResultsPanels } from './host/panels/results'
import { SchemaPanels } from './host/panels/schemaViews'
import { SqlRunner } from './host/runner'
import { readSettings, syncSettings, type ExtensionSettings } from './host/settings'
import { SqlCompletionProvider, SqlFormattingProvider } from './host/sqlEditing'
import { ExtensionQueryHistory, showQueryHistory } from './host/queryHistory'
import { findObject } from './host/objectSearch'
import { isSqlDocument, TargetCodeLens, TargetStatusBar } from './host/sqlDocuments'
import { DocumentTargets } from './host/targets'
import {
  ConnectionsTree,
  EnvironmentDecorations,
  iconFolder,
  type ObjectNode,
  type TreeNode
} from './host/tree'
import type { SchemaViewState, WebviewSettings } from './webviewState'
import { showError, showInformation, showWarning } from './host/notice'

/** What the integration tests reach (only returned in ExtensionMode.Test). */
export interface VortaqTestApi {
  core: import('@core').VortaqCore
  mcp: McpService
  history: ExtensionQueryHistory
  connections: ConnectionService
  tree: ConnectionsTree
  view: vscode.TreeView<TreeNode>
  targets: DocumentTargets
  runner: SqlRunner
  results: ResultsPanels
  schemaViews: SchemaPanels
  sqliteProblem: string | null
  setPrompter(prompter: Prompter | null): void
  openConnectionForm(editing: ConnectionConfig | null): ConnectionFormPanel
  readDesktopImport(): DesktopImportPreview
  importConnections(selected: DesktopConnection[]): Promise<number>
}

let disposeCore: (() => Promise<void>) | null = null

export async function activate(
  context: vscode.ExtensionContext
): Promise<VortaqTestApi | undefined> {
  const output = vscode.window.createOutputChannel('Vortaq', { log: true })
  context.subscriptions.push(output)

  let connections: ConnectionService | null = null
  let runner: SqlRunner | null = null
  let results: ResultsPanels | null = null
  const { core, sqliteProblem } = await createExtensionCore(context, output, (channel, payload) => {
    if (channel === 'event:connectionClosed') {
      const event = payload as { connectionId: string; reason: string }
      runner?.connectionClosed(event.connectionId)
      connections?.connectionLost(event.connectionId, event.reason)
    }
    // «Exportar»: progress of an export goes to the panel that started it.
    if (channel === 'event:progress') results?.progress(payload as ProgressEvent)
  })
  disposeCore = () => core.dispose()
  context.subscriptions.push({ dispose: () => void core.dispose() })

  let settings: ExtensionSettings = readSettings()
  const webviewSettings = (): WebviewSettings => {
    const s = core.context.settings.get()
    return {
      typedConfirmEnvironments: s.typedConfirmEnvironments,
      confirmDestructiveEverywhere: s.confirmDestructiveEverywhere !== false,
      defaultRowLimit: settings.maxRows
    }
  }

  let prompter: Prompter | null = null
  const guard = new WriteGuard(core, () => prompter ?? vscodePrompter)
  connections = new ConnectionService(core, sqliteProblem, output)
  const service = connections
  const targets = new DocumentTargets(context.workspaceState)
  const invoke = (channel: string, args: unknown[]): Promise<unknown> =>
    (core.invoke as (c: string, ...a: unknown[]) => Promise<unknown>)(channel, ...args)
  results = new ResultsPanels({
    extensionUri: context.extensionUri,
    invoke,
    guard,
    settings: webviewSettings,
    onStop: (key) => runner?.stopPanel(key)
  })
  runner = new SqlRunner(core, service, targets, guard, results, () => settings, webviewSettings)
  const sqlRunner = runner
  /* «Diagrama de relaciones» / «Consulta gráfica»: structure reads only; data and SQL open here. */
  const schemaViews = new SchemaPanels({
    extensionUri: context.extensionUri,
    invoke,
    prepare: (channel, args) => guard.prepareWebviewCall(channel, args),
    settings: webviewSettings,
    viewData: (state, table) =>
      sqlRunner.viewData({
        kind: 'table',
        connectionId: state.connection.id,
        database: typeof state.ref === 'string' ? state.ref : state.ref.database,
        ...(typeof state.ref === 'string' ? {} : { schema: state.ref.schema }),
        name: table
      }),
    openSql: async (state, sql, run) => {
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: sql })
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active)
      await sqlRunner.setTarget(doc.uri.toString(), {
        connectionId: state.connection.id,
        database: typeof state.ref === 'string' ? state.ref : state.ref.database,
        ...(typeof state.ref === 'string' ? {} : { schema: state.ref.schema })
      })
      // Runs through the runner like Ejecutar todo: the same guards and confirmations.
      if (run) await sqlRunner.run(editor, true)
    }
  })

  const tree = new ConnectionsTree(
    service,
    iconFolder(context.globalStorageUri.fsPath),
    (c) => guard.needsTyped(c),
    (connection, message) => void showOpenError(connection, message)
  )
  const view = vscode.window.createTreeView('vortaq.connections', {
    treeDataProvider: tree,
    showCollapseAll: true
  })
  const statusBar = new TargetStatusBar(targets, service, (c) => guard.needsTyped(c))
  const codeLens = new TargetCodeLens(targets, service)
  /* Autocompletion with the target's structure, and «Dar formato al documento». */
  const completion = new SqlCompletionProvider(core, service, targets)
  const formatting = new SqlFormattingProvider(service, targets, (message) =>
    vscode.window.setStatusBarMessage(`$(warning) ${message}`, 6000)
  )
  /* «Historial de consultas»: every finished run, in the editor's global state. */
  const historyEnabled = (): boolean =>
    vscode.workspace.getConfiguration('vortaq').get<boolean>('queryHistory.enabled', true) !== false
  const queryHistory = new ExtensionQueryHistory(context.globalState, historyEnabled)
  context.subscriptions.push(
    sqlRunner.onDidRun((finished) => {
      void queryHistory.record({
        sql: finished.sql,
        connectionId: finished.connection.id,
        connectionName: finished.connection.name,
        engine: finished.connection.engine,
        database: finished.target.database,
        ...(finished.target.schema ? { schema: finished.target.schema } : {}),
        at: new Date().toISOString(),
        durationMs: finished.durationMs,
        ...runOutcome(finished.results, finished.failed)
      })
      // DDL may have created or changed tables: read the structure again for completion.
      if (sqlDialectOf(finished.connection).analyzeWrites(finished.sql).writes)
        completion.forget(finished.connection.id)
    })
  )
  context.subscriptions.push(
    completion,
    vscode.languages.registerCompletionItemProvider({ language: 'sql' }, completion, '.'),
    vscode.languages.registerDocumentFormattingEditProvider({ language: 'sql' }, formatting),
    vscode.languages.registerDocumentRangeFormattingEditProvider({ language: 'sql' }, formatting)
  )

  /* ---------- agents (MCP): the server inside the editor (host/mcp.ts) ---------- */
  const version = context.extension.packageJSON.version as string
  const logLine = (message: string): void => output.info(message)
  const mcp = new McpService({
    secrets: context.secrets,
    settings: () => settings.mcp,
    platform: process.platform,
    ports: coreMcpPorts(core, version, logLine),
    log: logLine
  })
  const mcpProvider = registerMcpProvider(mcp, version)
  context.subscriptions.push(mcp, ...(mcpProvider ? [mcpProvider] : []))
  const mcpDeps: McpManagerDeps = {
    core,
    service: mcp,
    connections: () => service.list(),
    setEnabled: (on) =>
      vscode.workspace
        .getConfiguration('vortaq')
        .update('mcp.enabled', on, vscode.ConfigurationTarget.Global),
    changed: () => service.refreshAll()
  }

  context.subscriptions.push(
    service,
    tree,
    view,
    results,
    schemaViews,
    sqlRunner,
    statusBar,
    codeLens,
    vscode.window.registerFileDecorationProvider(new EnvironmentDecorations()),
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, codeLens),
    syncSettings(core, (next) => {
      settings = next
      codeLens.enabled = next.codeLens
      codeLens.refresh()
      tree.refresh()
      statusBar.update()
      // Starts, moves or stops the agents' server (vortaq.mcp.enabled / .port).
      void mcp.refresh()
    })
  )
  void vscode.commands.executeCommand('setContext', 'vortaq.sqliteUnavailable', !!sqliteProblem)

  /* ---------- running state of the active document (editor title buttons) ---------- */
  const updateRunningContext = (): void => {
    const doc = vscode.window.activeTextEditor?.document
    void vscode.commands.executeCommand(
      'setContext',
      'vortaq.running',
      !!doc && sqlRunner.isRunning(doc.uri.toString())
    )
  }
  context.subscriptions.push(
    sqlRunner.onDidChangeRunning(updateRunningContext),
    vscode.window.onDidChangeActiveTextEditor(updateRunningContext),
    // A document's server session (PostgreSQL/SQLite) ends when its last tab closes. Closing a
    // text document is not the same event (it also fires on a language change, and a model may
    // outlive its tabs).
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      for (const tab of event.closed) {
        if (!(tab.input instanceof vscode.TabInputText)) continue
        const uri = tab.input.uri.toString()
        if (openTabUris().has(uri)) continue
        void sqlRunner.closeSession(uri)
        targets.closed(uri)
      }
    }),
    // Another editor window changed the connections (each window runs its own core on the
    // same profile; the stores re-read the files): refresh this window's tree.
    watchProfile(context.globalStorageUri, () => service.refreshAll())
  )

  /* ---------- connection form ---------- */
  let sqliteNoticeShown = false
  const forms = new Map<string, ConnectionFormPanel>()
  const openForm = (
    editing: ConnectionConfig | null,
    engine: EngineId | null = null
  ): ConnectionFormPanel => {
    if (sqliteProblem && !sqliteNoticeShown && !editing) {
      sqliteNoticeShown = true
      void showInformation(`SQLite no aparece en el formulario: ${sqliteProblem}`)
    }
    const key = editing?.id ?? `new:${Date.now()}`
    const existing = editing ? forms.get(key) : undefined
    if (existing && !existing.isDisposed) {
      existing.reveal()
      return existing
    }
    const panel = new ConnectionFormPanel(
      key,
      editing,
      engine,
      {
        extensionUri: context.extensionUri,
        invoke,
        prepare: (channel, args) => guard.prepareWebviewCall(channel, args),
        settings: webviewSettings,
        sqliteProblem,
        onClosed: (changed) => {
          if (changed) service.refreshAll()
        }
      },
      () => forms.delete(key)
    )
    forms.set(key, panel)
    return panel
  }

  /* ---------- helpers ---------- */
  async function showOpenError(connection: ConnectionConfig, message: string): Promise<void> {
    const edit = 'Editar conexión'
    const password = 'Cambiar contraseña'
    const trust = 'Confiar en el certificado'
    const usesPassword =
      ENGINES[connection.engine].capabilities.needsHost && connection.authMode !== 'none'
    // SQL Server with a self-signed certificate (SQL Server Express, a server of one's own).
    const trustFixes =
      connection.engine === 'sqlserver' && trustFixesError(message, connection.sqlserver)
    const answer = await showError(
      message,
      ...(trustFixes ? [trust] : []),
      ...(usesPassword ? [password] : []),
      edit
    )
    if (answer === edit) openForm(service.get(connection.id))
    if (answer === trust && connection.sqlserver) {
      await service.save({
        ...connection,
        sqlserver: { ...connection.sqlserver, trustServerCertificate: true }
      })
      try {
        if (await service.open(connection.id))
          tree.refresh({ kind: 'connection', connectionId: connection.id })
      } catch (err) {
        void showOpenError(service.get(connection.id) ?? connection, errorText(err))
      }
    }
    if (answer === password && (await service.replacePassword(connection.id))) {
      try {
        if (await service.open(connection.id))
          tree.refresh({ kind: 'connection', connectionId: connection.id })
      } catch (err) {
        void showOpenError(connection, errorText(err))
      }
    }
  }

  const nodeConnection = (node: TreeNode | undefined): ConnectionConfig | null =>
    node ? service.get(node.connectionId) : null

  async function newQuery(node?: TreeNode): Promise<void> {
    let content = ''
    const connection = nodeConnection(node)
    if (node && connection && (node.kind === 'table' || node.kind === 'view')) {
      const dialect = sqlDialectOf(connection)
      const namespace = usesSchemaRef(connection.engine)
        ? (node.schema ?? defaultSchemaOf(connection.engine))
        : node.database
      content = `${selectFirstRows(dialect, dialect.qualified(namespace, node.name), 100)};\n`
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content })
    const editor = await vscode.window.showTextDocument(doc)
    if (connection && node) {
      const database = node.kind === 'connection' ? null : 'database' in node ? node.database : null
      const schema =
        node.kind === 'schema' ? node.schema : 'schema' in node ? (node.schema ?? null) : null
      if (database !== null || node.kind === 'connection') {
        await sqlRunner.setTarget(doc.uri.toString(), {
          connectionId: connection.id,
          database: database ?? defaultDatabase(connection),
          ...(usesSchemaRef(connection.engine)
            ? { schema: schema ?? (database ? defaultSchemaOf(connection.engine) : null) }
            : {})
        })
      }
    }
    editor.selection = new vscode.Selection(
      doc.positionAt(content.length),
      doc.positionAt(content.length)
    )
  }

  function defaultDatabase(connection: ConnectionConfig): string | null {
    if (connection.engine === 'postgresql')
      return connection.postgres?.initialDatabase || 'postgres'
    if (connection.engine === 'sqlserver')
      return connection.sqlserver?.initialDatabase?.trim() || 'master'
    if (connection.engine === 'sqlite') return 'main'
    return connection.customDatabases[0] ?? null
  }

  /* ---------- desktop import ---------- */
  function readDesktopImport(): DesktopImportPreview {
    return readDesktopConnections(desktopProfileDir(process.platform, process.env, homedir()))
  }

  async function importConnections(selected: DesktopConnection[]): Promise<number> {
    let count = 0
    for (const item of selected) {
      await core.invoke('connections:save', item.input)
      count++
    }
    service.refreshAll()
    return count
  }

  async function importDesktop(): Promise<void> {
    let preview: DesktopImportPreview
    try {
      preview = readDesktopImport()
    } catch (err) {
      const choose = 'Elegir connections.json…'
      const answer = await showWarning(errorText(err), choose)
      if (answer !== choose) return
      const files = await vscode.window.showOpenDialog({
        title: 'connections.json de la aplicación de escritorio de Vortaq',
        canSelectMany: false,
        filters: { 'connections.json': ['json'] },
        defaultUri: vscode.Uri.file(desktopProfileDir(process.platform, process.env, homedir()))
      })
      if (!files?.[0]) return
      try {
        preview = parseDesktopConnections(await readFile(files[0].fsPath, 'utf8'))
      } catch (parseError) {
        void showError(errorText(parseError))
        return
      }
    }
    if (!preview.connections.length) {
      void showInformation(
        preview.skipped.length
          ? `No hay conexiones que se puedan importar (${preview.skipped.length} no válidas).`
          : 'La aplicación de escritorio no tiene conexiones.'
      )
      return
    }
    const existing = new Set((await service.list()).map((c) => c.name))
    const picks = await vscode.window.showQuickPick(
      preview.connections.map((c) => ({
        label: c.name,
        description: existing.has(c.name)
          ? `${c.summary} · ya existe una con este nombre`
          : c.summary,
        detail: `Entorno: ${environmentName(c.environment)}`,
        picked: !existing.has(c.name),
        connection: c
      })),
      {
        title: 'Importar conexiones de Vortaq (escritorio)',
        placeHolder:
          'Marca las conexiones que quieres importar. Las contraseñas no se importan: las escribirás una vez al conectar.',
        canPickMany: true,
        matchOnDescription: true
      }
    )
    if (!picks?.length) return
    const count = await importConnections(picks.map((p) => p.connection))
    const skipped = preview.skipped.length
      ? ` ${preview.skipped.length} no válidas se omitieron.`
      : ''
    void showInformation(
      `${count === 1 ? 'Se importó 1 conexión' : `Se importaron ${count} conexiones`}. Las contraseñas no se copian de la aplicación de escritorio: escríbelas al conectar y se guardarán cifradas en el almacén seguro del editor.${skipped}`
    )
  }

  /* ---------- commands ---------- */
  const command = (id: string, fn: (...args: never[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        try {
          await fn(...args)
        } catch (err) {
          void showError(errorText(err))
        }
      })
    )
  }

  command('vortaq.addConnection', (engine?: EngineId) =>
    openForm(null, typeof engine === 'string' ? engine : null)
  )
  command('vortaq.importDesktop', importDesktop)
  command('vortaq.refresh', (node?: TreeNode) => {
    if (node) completion.forget(node.connectionId)
    tree.refresh(node)
  })
  command('vortaq.showLog', () => output.show())
  command('vortaq.editConnection', (node?: TreeNode) => {
    const connection = nodeConnection(node)
    if (connection) openForm(connection)
  })
  command('vortaq.deleteConnection', async (node?: TreeNode) => {
    const connection = nodeConnection(node)
    if (!connection) return
    const remove = 'Eliminar'
    const answer = await showWarning(
      `¿Eliminar la conexión «${connection.name}»?`,
      {
        modal: true,
        detail:
          'Se borran también sus contraseñas guardadas en este editor. Las bases de datos no cambian.'
      },
      remove
    )
    if (answer !== remove) return
    for (const panel of results.forConnection(connection.id)) panel.dispose()
    for (const panel of schemaViews.forConnection(connection.id)) panel.dispose()
    await service.remove(connection.id)
    await targets.forgetConnection(connection.id)
  })
  command('vortaq.connect', async (node?: TreeNode) => {
    const connection = nodeConnection(node)
    if (!connection) return
    try {
      if (await service.open(connection.id)) tree.refresh()
    } catch (err) {
      void showOpenError(connection, errorText(err))
    }
  })
  command('vortaq.disconnect', async (node?: TreeNode) => {
    const connection = nodeConnection(node)
    if (!connection) return
    sqlRunner.connectionClosed(connection.id)
    await service.close(connection.id)
  })
  command('vortaq.newQuery', (node?: TreeNode) => newQuery(node))

  /** A new SQL document targeted at a table's or view's connection, database and schema. */
  async function objectDocument(
    node: ObjectNode,
    content: string
  ): Promise<vscode.TextEditor | null> {
    const connection = nodeConnection(node)
    if (!connection) return null
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content })
    const editor = await vscode.window.showTextDocument(doc)
    await sqlRunner.setTarget(doc.uri.toString(), {
      connectionId: connection.id,
      database: node.database,
      ...(usesSchemaRef(connection.engine)
        ? { schema: node.schema ?? defaultSchemaOf(connection.engine) }
        : {})
    })
    return editor
  }
  const objectNode = (node?: TreeNode): ObjectNode | null =>
    node && (node.kind === 'table' || node.kind === 'view') ? node : null

  /* «Seleccionar las primeras 1000 filas»: a document with the SELECT, run at once. */
  command('vortaq.selectTop', async (node?: TreeNode) => {
    const object = objectNode(node)
    const connection = object ? nodeConnection(object) : null
    if (!object || !connection) return
    const dialect = sqlDialectOf(connection)
    const namespace = usesSchemaRef(connection.engine)
      ? (object.schema ?? defaultSchemaOf(connection.engine))
      : object.database
    const editor = await objectDocument(
      object,
      `${selectFirstRows(dialect, dialect.qualified(namespace, object.name), 1000)};\n`
    )
    if (editor) await sqlRunner.run(editor, true)
  })

  /* «Script como CREATE»: the table's or view's DDL in a new document (nothing runs). */
  command('vortaq.scriptCreate', async (node?: TreeNode) => {
    const object = objectNode(node)
    const connection = object ? nodeConnection(object) : null
    if (!object || !connection) return
    if (!(await service.open(connection.id))) return
    const ref = usesSchemaRef(connection.engine)
      ? {
          database: object.database,
          schema: object.schema ?? defaultSchemaOf(connection.engine) ?? ''
        }
      : object.database
    const ddl = await core.invoke('db:showCreate', connection.id, ref, object.kind, object.name)
    await objectDocument(object, `${ddl.trim()}\n`)
  })

  command('vortaq.findObject', (node?: TreeNode) =>
    findObject(
      {
        core,
        connections: service,
        reveal: (target) => view.reveal(target, { select: true, focus: true, expand: true })
      },
      node
    )
  )
  command('vortaq.viewData', (node?: TreeNode) => {
    if (node && (node.kind === 'table' || node.kind === 'view'))
      return sqlRunner.viewData(node as ObjectNode)
  })
  command('vortaq.viewDocuments', (node?: TreeNode) => {
    if (node?.kind === 'collection') return sqlRunner.viewDocuments(node)
  })
  /* ---------- updates (a .vsix install is not updated by the editor; a gallery one is) ---------- */
  const updater = new ExtensionUpdater({
    currentVersion: version,
    state: context.globalState,
    downloadDir: join(context.globalStorageUri.fsPath, 'updates'),
    enabled: () =>
      vscode.workspace.getConfiguration('vortaq').get<boolean>('updates.check', true) !== false,
    log: logLine,
    installSource: () => readInstallSource(context.extensionPath)
  })
  command('vortaq.checkUpdates', () => updater.checkNow())
  if (context.extensionMode === vscode.ExtensionMode.Production) {
    // A little after start-up, at most once a day for all the editor's windows.
    const timer = setTimeout(() => void updater.checkInBackground(), 15_000)
    context.subscriptions.push({ dispose: () => clearTimeout(timer) })
  }

  command('vortaq.queryHistory', () =>
    showQueryHistory(
      queryHistory,
      async (entry) => {
        const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: entry.sql })
        await vscode.window.showTextDocument(doc)
        if (service.get(entry.connectionId))
          await sqlRunner.setTarget(doc.uri.toString(), {
            connectionId: entry.connectionId,
            database: entry.database,
            ...(entry.schema ? { schema: entry.schema } : {})
          })
      },
      historyEnabled()
    )
  )
  command('vortaq.mcp', () => showMcpManager(mcpDeps))
  command('vortaq.mcpConnection', async (node?: TreeNode) => {
    const connection = nodeConnection(node)
    if (connection) await showConnectionMcp(mcpDeps, connection)
    else await showMcpManager(mcpDeps)
  })
  command('vortaq.diagram', (node?: TreeNode) => openSchemaView('diagram', node))
  command('vortaq.queryBuilder', (node?: TreeNode) => openSchemaView('queryBuilder', node))

  /** The diagram or a visual query of a database node (MySQL, MariaDB, SQLite) or schema (PostgreSQL). */
  async function openSchemaView(kind: SchemaViewState['kind'], node?: TreeNode): Promise<void> {
    const connection = nodeConnection(node)
    if (!node || !connection || (node.kind !== 'database' && node.kind !== 'schema')) {
      void showInformation('Elige una base de datos o un esquema en el árbol de Vortaq.')
      return
    }
    if (connection.engine === 'mongodb') {
      void showInformation('MongoDB no tiene claves foráneas entre colecciones.')
      return
    }
    if (!(await service.open(connection.id))) return
    const pg = usesSchemaRef(connection.engine)
    const schema =
      node.kind === 'schema' ? node.schema : (defaultSchemaOf(connection.engine) ?? 'public')
    const namespace = pg ? schema : node.database
    const label = kind === 'diagram' ? 'Diagrama' : 'Consulta gráfica'
    schemaViews.open({
      kind,
      title: `${label} · ${pg ? `${node.database}.${schema}` : node.database} (${connection.name})`,
      connection,
      ref: pg ? { database: node.database, schema } : node.database,
      namespace,
      platform: process.platform,
      settings: webviewSettings()
    })
  }
  command('vortaq.copyName', async (node?: TreeNode) => {
    if (!node) return
    const text =
      node.kind === 'connection'
        ? (service.get(node.connectionId)?.name ?? '')
        : node.kind === 'database'
          ? node.database
          : node.kind === 'schema'
            ? node.schema
            : 'name' in node
              ? node.name
              : ''
    if (!text) return
    await vscode.env.clipboard.writeText(text)
    vscode.window.setStatusBarMessage(`$(check) Copiado: ${text}`, 3000)
  })
  command('vortaq.pickConnection', async () => {
    const doc = vscode.window.activeTextEditor?.document
    if (!isSqlDocument(doc)) {
      void showInformation('Abre un documento SQL para elegir su conexión.')
      return
    }
    await sqlRunner.pick(doc)
  })
  command('vortaq.plan', () => planActive(false))
  command('vortaq.planActual', () => planActive(true))
  command('vortaq.run', () => runActive(false))
  command('vortaq.runAll', () => runActive(true))
  command('vortaq.stop', async () => {
    const doc = vscode.window.activeTextEditor?.document
    if (doc) await sqlRunner.stop(doc.uri.toString())
  })

  /** «Plan de ejecución» of the statement under the cursor of the active SQL document. */
  async function planActive(actual: boolean): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (!editor || !isSqlDocument(editor.document)) {
      void showInformation('Abre un documento SQL para ver su plan.')
      return
    }
    await sqlRunner.plan(editor, actual)
  }

  async function runActive(all: boolean): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (!editor || !isSqlDocument(editor.document)) {
      void showInformation('Abre un documento SQL para ejecutarlo con Vortaq.')
      return
    }
    await sqlRunner.run(editor, all)
  }

  output.info(
    `Vortaq ${context.extension.packageJSON.version as string} activo (Node ${process.versions.node}${sqliteProblem ? ', sin SQLite' : ''})`
  )

  if (context.extensionMode !== vscode.ExtensionMode.Test) return undefined
  return {
    core,
    mcp,
    history: queryHistory,
    connections: service,
    tree,
    view,
    targets,
    runner: sqlRunner,
    results,
    schemaViews,
    sqliteProblem,
    setPrompter: (next) => {
      prompter = next
    },
    openConnectionForm: (editing) => openForm(editing),
    readDesktopImport,
    importConnections
  }
}

/** URIs shown in a text tab of any editor group. */
function openTabUris(): Set<string> {
  const uris = new Set<string>()
  for (const group of vscode.window.tabGroups.all)
    for (const tab of group.tabs)
      if (tab.input instanceof vscode.TabInputText) uris.add(tab.input.uri.toString())
  return uris
}

/** Calls `onChange` when connections.json or credentials.json of the profile changes on disk. */
function watchProfile(storage: vscode.Uri, onChange: () => void): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(storage, '{connections,credentials}.json')
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = (): void => {
    clearTimeout(timer)
    timer = setTimeout(onChange, 150)
  }
  const subscriptions = [
    watcher.onDidChange(fire),
    watcher.onDidCreate(fire),
    watcher.onDidDelete(fire)
  ]
  return {
    dispose: () => {
      clearTimeout(timer)
      for (const s of subscriptions) s.dispose()
      watcher.dispose()
    }
  }
}

export async function deactivate(): Promise<void> {
  await disposeCore?.()
  disposeCore = null
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
