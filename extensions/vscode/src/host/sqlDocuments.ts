/**
 * SQL documents (`.sql` files and untitled SQL): the connection and database
 * each one runs on, chosen from the status bar item, the CodeLens on the
 * first line or the editor title, and remembered per document (targets.ts).
 */
import * as vscode from 'vscode'
import { ENGINES, environmentName, type ConnectionConfig } from '@core'
import type { ConnectionService } from './connections'
import { targetLabel, type DocumentTarget, type DocumentTargets } from './targets'

export const isSqlDocument = (doc: vscode.TextDocument | undefined): doc is vscode.TextDocument =>
  !!doc && doc.languageId === 'sql'

interface PickItem<T> extends vscode.QuickPickItem {
  value: T
}

/**
 * Asks for the connection, then its database (PostgreSQL: database and
 * schema). `preset` skips the connection step. Resolves null when dismissed.
 */
export async function pickTarget(
  connections: ConnectionService,
  current: DocumentTarget | null,
  preset?: { connectionId: string; database?: string | null; schema?: string | null }
): Promise<DocumentTarget | null> {
  let connection: ConnectionConfig | null = null
  if (preset) connection = connections.get(preset.connectionId)
  if (!connection) {
    const list = (await connections.list()).filter((c) => c.engine !== 'mongodb')
    if (!list.length) {
      const add = 'Añadir conexión'
      const answer = await vscode.window.showInformationMessage(
        'No hay conexiones SQL en Vortaq todavía.',
        add
      )
      if (answer === add) await vscode.commands.executeCommand('vortaq.addConnection')
      return null
    }
    const items: PickItem<ConnectionConfig>[] = list.map((c) => ({
      label: c.name,
      description: `${ENGINES[c.engine].label}${connections.isOpen(c.id) ? ' · conectada' : ''}`,
      detail: `Entorno: ${environmentName(c.environment)}`,
      picked: c.id === current?.connectionId,
      value: c
    }))
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Conexión del documento',
      placeHolder: 'Elige la conexión donde se ejecutará este documento',
      matchOnDescription: true
    })
    if (!picked) return null
    connection = picked.value
  }
  const info = await connections.open(connection.id)
  if (!info) return null
  const core = connections.core
  const custom = connection.customDatabases ?? []
  const databases = (await core.invoke('db:databases', connection.id))
    .map((d) => d.name)
    .filter((n) => !custom.length || custom.includes(n))
  let database: string | null = preset?.database ?? null
  if (preset?.database === undefined) {
    const none: PickItem<string | null> = {
      label: '$(circle-slash) Ninguna',
      description: 'Las consultas deben nombrar la base de datos',
      value: null
    }
    const items: PickItem<string | null>[] = [
      ...databases.map((d) => ({
        label: d,
        picked: d === current?.database && connection!.id === current?.connectionId,
        value: d as string | null
      })),
      ...(connection.engine === 'mysql' || connection.engine === 'mariadb' ? [none] : [])
    ]
    const label =
      connection.engine === 'sqlite' ? 'Base de datos (principal o adjunta)' : 'Base de datos'
    const picked = await vscode.window.showQuickPick(items, {
      title: `${label} · ${connection.name}`,
      placeHolder: 'Elige la base de datos del documento'
    })
    if (!picked) return null
    database = picked.value
  }
  let schema: string | null = preset?.schema ?? null
  if (connection.engine === 'postgresql' && database && preset?.schema === undefined) {
    const schemas = (await core.invoke('db:schemas', connection.id, database)).map((s) => s.name)
    const ordered = [...schemas].sort((a, b) =>
      a === 'public' ? -1 : b === 'public' ? 1 : a.localeCompare(b)
    )
    const picked = await vscode.window.showQuickPick(
      ordered.map((s) => ({ label: s, value: s })),
      { title: `Esquema · ${database}`, placeHolder: 'Elige el esquema (primero en search_path)' }
    )
    if (!picked) return null
    schema = picked.value
  }
  return {
    connectionId: connection.id,
    database,
    ...(connection.engine === 'postgresql' ? { schema } : {})
  }
}

/** Status bar item of the active SQL document: connection · database. */
export class TargetStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    'vortaq.target',
    vscode.StatusBarAlignment.Left,
    50
  )
  private readonly subscriptions: vscode.Disposable[] = []

  constructor(
    private readonly targets: DocumentTargets,
    private readonly connections: ConnectionService,
    private readonly needsTyped: (c: ConnectionConfig) => boolean
  ) {
    this.item.name = 'Vortaq: conexión del documento'
    this.item.command = 'vortaq.pickConnection'
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      targets.onDidChange(() => this.update()),
      connections.onDidChange(() => this.update())
    )
    this.update()
  }

  update(): void {
    const doc = vscode.window.activeTextEditor?.document
    if (!isSqlDocument(doc)) {
      this.item.hide()
      return
    }
    const target = this.targets.get(doc.uri.toString())
    const connection = target ? this.connections.get(target.connectionId) : null
    if (!target || !connection) {
      this.item.text = '$(database) Vortaq: elegir conexión'
      this.item.tooltip = 'Elige la conexión y la base de datos de este documento'
      this.item.backgroundColor = undefined
    } else {
      const where = targetLabel(target)
      this.item.text = `$(database) ${connection.name}${where ? ` · ${where}` : ''}`
      const guarded = this.needsTyped(connection)
      this.item.tooltip = `${ENGINES[connection.engine].label} · entorno ${environmentName(connection.environment)}${guarded ? ' · las escrituras piden escribir el nombre de la conexión' : ''}\nPulsa para cambiar la conexión o la base de datos`
      this.item.backgroundColor =
        connection.environment === 'production'
          ? new vscode.ThemeColor('statusBarItem.errorBackground')
          : guarded
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined
    }
    this.item.show()
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose()
    this.item.dispose()
  }
}

/** CodeLens on the first line: the document's connection and «Ejecutar todo». */
export class TargetCodeLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this.emitter.event
  private readonly subscriptions: vscode.Disposable[]
  enabled = true

  constructor(
    private readonly targets: DocumentTargets,
    private readonly connections: ConnectionService
  ) {
    this.subscriptions = [
      targets.onDidChange(() => this.emitter.fire()),
      connections.onDidChange(() => this.emitter.fire())
    ]
  }

  refresh(): void {
    this.emitter.fire()
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.enabled || !isSqlDocument(doc)) return []
    const range = new vscode.Range(0, 0, 0, 0)
    const target = this.targets.get(doc.uri.toString())
    const connection = target ? this.connections.get(target.connectionId) : null
    const where = targetLabel(target)
    return [
      new vscode.CodeLens(range, {
        title: connection
          ? `$(database) ${connection.name}${where ? ` · ${where}` : ''}`
          : '$(database) Elegir conexión de Vortaq',
        command: 'vortaq.pickConnection',
        tooltip: 'Conexión y base de datos de este documento'
      }),
      new vscode.CodeLens(range, {
        title: '$(play) Ejecutar todo',
        command: 'vortaq.runAll',
        tooltip: 'Ejecuta el documento completo'
      })
    ]
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose()
    this.emitter.dispose()
  }
}
