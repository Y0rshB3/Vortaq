/**
 * Vortaq for VS Code and compatible editors (Cursor, VSCodium, Windsurf):
 * activation, commands and wiring. The database work is Vortaq's core
 * (src/core, Electron-free) with this host's ports (host/core.ts); this file
 * only connects VS Code's UI to it.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as vscode from 'vscode'
import {
  ENGINES,
  environmentName,
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
import { ConnectionFormPanel } from './host/panels/connectionForm'
import { ResultsPanels } from './host/panels/results'
import { SqlRunner } from './host/runner'
import { readSettings, syncSettings, type ExtensionSettings } from './host/settings'
import { isSqlDocument, TargetCodeLens, TargetStatusBar } from './host/sqlDocuments'
import { DocumentTargets } from './host/targets'
import {
  ConnectionsTree,
  EnvironmentDecorations,
  iconFolder,
  type ObjectNode,
  type TreeNode
} from './host/tree'
import type { WebviewSettings } from './webviewState'

/** What the integration tests reach (only returned in ExtensionMode.Test). */
export interface VortaqTestApi {
  core: import('@core').VortaqCore
  connections: ConnectionService
  tree: ConnectionsTree
  view: vscode.TreeView<TreeNode>
  targets: DocumentTargets
  runner: SqlRunner
  results: ResultsPanels
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
  context.subscriptions.push(
    service,
    tree,
    view,
    results,
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
      void vscode.window.showInformationMessage(
        `SQLite no aparece en el formulario: ${sqliteProblem}`
      )
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
    const usesPassword =
      ENGINES[connection.engine].capabilities.needsHost && connection.authMode !== 'none'
    const answer = await vscode.window.showErrorMessage(
      message,
      ...(usesPassword ? [password] : []),
      edit
    )
    if (answer === edit) openForm(service.get(connection.id))
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
      const namespace =
        connection.engine === 'postgresql' ? (node.schema ?? 'public') : node.database
      content = `SELECT * FROM ${dialect.qualified(namespace, node.name)} LIMIT 100;\n`
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
          ...(connection.engine === 'postgresql'
            ? { schema: schema ?? (database ? 'public' : null) }
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
      const answer = await vscode.window.showWarningMessage(errorText(err), choose)
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
        void vscode.window.showErrorMessage(errorText(parseError))
        return
      }
    }
    if (!preview.connections.length) {
      void vscode.window.showInformationMessage(
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
    void vscode.window.showInformationMessage(
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
          void vscode.window.showErrorMessage(errorText(err))
        }
      })
    )
  }

  command('vortaq.addConnection', (engine?: EngineId) =>
    openForm(null, typeof engine === 'string' ? engine : null)
  )
  command('vortaq.importDesktop', importDesktop)
  command('vortaq.refresh', (node?: TreeNode) => tree.refresh(node))
  command('vortaq.showLog', () => output.show())
  command('vortaq.editConnection', (node?: TreeNode) => {
    const connection = nodeConnection(node)
    if (connection) openForm(connection)
  })
  command('vortaq.deleteConnection', async (node?: TreeNode) => {
    const connection = nodeConnection(node)
    if (!connection) return
    const remove = 'Eliminar'
    const answer = await vscode.window.showWarningMessage(
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
  command('vortaq.viewData', (node?: TreeNode) => {
    if (node && (node.kind === 'table' || node.kind === 'view'))
      return sqlRunner.viewData(node as ObjectNode)
  })
  command('vortaq.viewDocuments', (node?: TreeNode) => {
    if (node?.kind === 'collection') return sqlRunner.viewDocuments(node)
  })
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
      void vscode.window.showInformationMessage('Abre un documento SQL para elegir su conexión.')
      return
    }
    await sqlRunner.pick(doc)
  })
  command('vortaq.run', () => runActive(false))
  command('vortaq.runAll', () => runActive(true))
  command('vortaq.stop', async () => {
    const doc = vscode.window.activeTextEditor?.document
    if (doc) await sqlRunner.stop(doc.uri.toString())
  })

  async function runActive(all: boolean): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (!editor || !isSqlDocument(editor.document)) {
      void vscode.window.showInformationMessage('Abre un documento SQL para ejecutarlo con Vortaq.')
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
    connections: service,
    tree,
    view,
    targets,
    runner: sqlRunner,
    results,
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
