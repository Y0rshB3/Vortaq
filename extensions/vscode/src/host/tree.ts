/**
 * «Conexiones» tree: connections › databases (PostgreSQL: › schemas) ›
 * Tablas / Vistas, and MongoDB databases › Colecciones / Vistas. Expanding a
 * closed connection opens it (asking for a missing password first). Every
 * list comes from the same core channels the desktop tree uses.
 */
import { join } from 'node:path'
import * as vscode from 'vscode'
import {
  ENGINES,
  environmentName,
  type ConnectionConfig,
  type MongoCollectionInfo,
  type SchemaRef
} from '@core'
import { connectionIcon } from './icons'
import type { ConnectionService } from './connections'

export type GroupKind = 'tables' | 'views' | 'collections' | 'mongoViews'

export type TreeNode =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'database'; connectionId: string; database: string }
  | { kind: 'schema'; connectionId: string; database: string; schema: string }
  | { kind: 'group'; connectionId: string; database: string; schema?: string; group: GroupKind }
  | {
      kind: 'table' | 'view'
      connectionId: string
      database: string
      schema?: string
      name: string
    }
  | { kind: 'collection'; connectionId: string; database: string; name: string; view: boolean }
  | { kind: 'message'; connectionId: string; label: string; detail: string; error: boolean }

export type ObjectNode = Extract<TreeNode, { kind: 'table' | 'view' }>

const GROUP_LABELS: Record<GroupKind, string> = {
  tables: 'Tablas',
  views: 'Vistas',
  collections: 'Colecciones',
  mongoViews: 'Vistas'
}
const GROUP_ICONS: Record<GroupKind, string> = {
  tables: 'table',
  views: 'eye',
  collections: 'json',
  mongoViews: 'eye'
}

/** Address of a database/schema in the db:* channels (PostgreSQL needs the object form). */
export function schemaRefOf(
  connection: Pick<ConnectionConfig, 'engine'>,
  database: string,
  schema?: string
): SchemaRef {
  return connection.engine === 'postgresql' ? { database, schema: schema ?? 'public' } : database
}

const seg = (s: string): string => encodeURIComponent(s)

/** Environment badge and colour of a connection row (FileDecorationProvider). */
export const CONNECTION_SCHEME = 'vortaq-connection'

export class EnvironmentDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CONNECTION_SCHEME) return undefined
    const env = new URLSearchParams(uri.query).get('env')
    const locked = new URLSearchParams(uri.query).get('locked') === '1'
    switch (env) {
      case 'production':
        return {
          badge: 'P',
          color: new vscode.ThemeColor('vortaq.environment.production'),
          tooltip: 'Producción: toda escritura pide escribir el nombre de la conexión'
        }
      case 'staging':
        return {
          badge: 'S',
          color: new vscode.ThemeColor('vortaq.environment.staging'),
          tooltip: locked ? 'Staging: las escrituras piden escribir el nombre' : 'Staging'
        }
      case 'local':
        return {
          badge: 'L',
          color: new vscode.ThemeColor('vortaq.environment.local'),
          tooltip: 'Local'
        }
      case 'other':
        return locked
          ? { badge: 'O', tooltip: 'Otro: las escrituras piden escribir el nombre' }
          : undefined
      default:
        return undefined
    }
  }
}

export class ConnectionsTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>()
  readonly onDidChangeTreeData = this.emitter.event
  /** Bumped when a connection closes, so VS Code shows it collapsed (and does not reopen it). */
  private readonly generation = new Map<string, number>()
  /** Connection nodes by id: VS Code refreshes an element by its identity. */
  private readonly nodes = new Map<string, TreeNode>()
  /** Connections being opened by an expand (their state change is handled there). */
  private readonly opening = new Set<string>()
  private readonly subscription: vscode.Disposable

  constructor(
    private readonly connections: ConnectionService,
    private readonly iconDir: string,
    private readonly needsTyped: (c: ConnectionConfig) => boolean,
    private readonly onOpenError: (connection: ConnectionConfig, message: string) => void
  ) {
    this.subscription = connections.onDidChange((id) => {
      if (id && this.opening.has(id)) return
      // A closed connection gets a new item id: VS Code shows it collapsed.
      if (id && !connections.isOpen(id)) this.bump(id)
      this.emitter.fire(undefined)
    })
  }

  refresh(node?: TreeNode): void {
    this.emitter.fire(
      node && node.kind === 'connection' ? this.connectionNode(node.connectionId) : node
    )
  }

  /** The tree node of a connection (one object per id). */
  connectionNode(id: string): TreeNode {
    let node = this.nodes.get(id)
    if (!node) {
      node = { kind: 'connection', connectionId: id }
      this.nodes.set(id, node)
    }
    return node
  }

  private bump(id: string): void {
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1)
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'connection':
        return this.connectionItem(node.connectionId)
      case 'database': {
        const connection = this.connections.get(node.connectionId)
        const item = new vscode.TreeItem(node.database, vscode.TreeItemCollapsibleState.Collapsed)
        item.id = `d:${seg(node.connectionId)}:${seg(node.database)}`
        item.iconPath = new vscode.ThemeIcon('database')
        item.contextValue = `vortaq.database.${connection?.engine === 'mongodb' ? 'mongo' : 'sql'}`
        if (connection?.engine === 'sqlite')
          item.description = node.database === 'main' ? 'principal' : 'adjunta'
        return item
      }
      case 'schema': {
        const item = new vscode.TreeItem(node.schema, vscode.TreeItemCollapsibleState.Collapsed)
        item.id = `s:${seg(node.connectionId)}:${seg(node.database)}:${seg(node.schema)}`
        item.iconPath = new vscode.ThemeIcon('symbol-namespace')
        item.contextValue = 'vortaq.schema.sql'
        return item
      }
      case 'group': {
        const item = new vscode.TreeItem(
          GROUP_LABELS[node.group],
          vscode.TreeItemCollapsibleState.Collapsed
        )
        item.id = `g:${seg(node.connectionId)}:${seg(node.database)}:${seg(node.schema ?? '')}:${node.group}`
        item.iconPath = new vscode.ThemeIcon(GROUP_ICONS[node.group])
        item.contextValue = 'vortaq.group'
        return item
      }
      case 'table':
      case 'view': {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None)
        item.id = `${node.kind === 'table' ? 't' : 'v'}:${seg(node.connectionId)}:${seg(node.database)}:${seg(node.schema ?? '')}:${seg(node.name)}`
        item.iconPath = new vscode.ThemeIcon(node.kind === 'table' ? 'table' : 'eye')
        item.contextValue = `vortaq.${node.kind}`
        item.tooltip = `${node.kind === 'table' ? 'Tabla' : 'Vista'} ${[node.schema ?? node.database, node.name].join('.')}`
        return item
      }
      case 'collection': {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None)
        item.id = `m:${seg(node.connectionId)}:${seg(node.database)}:${seg(node.name)}`
        item.iconPath = new vscode.ThemeIcon(node.view ? 'eye' : 'json')
        item.contextValue = node.view ? 'vortaq.collectionView' : 'vortaq.collection'
        return item
      }
      case 'message': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None)
        item.description = node.detail
        item.tooltip = node.detail
        item.iconPath = new vscode.ThemeIcon(
          node.error ? 'error' : 'info',
          node.error ? new vscode.ThemeColor('errorForeground') : undefined
        )
        item.contextValue = 'vortaq.message'
        return item
      }
    }
  }

  private connectionItem(id: string): vscode.TreeItem {
    const connection = this.connections.get(id)
    if (!connection) return new vscode.TreeItem('(conexión eliminada)')
    const open = this.connections.isOpen(id)
    const engine = ENGINES[connection.engine]
    const locked = this.needsTyped(connection)
    const unavailable = connection.engine === 'sqlite' && !!this.connections.sqliteProblem
    const item = new vscode.TreeItem(
      connection.name,
      unavailable ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed
    )
    item.id = `c:${seg(id)}:${this.generation.get(id) ?? 0}`
    const where =
      connection.engine === 'sqlite'
        ? (connection.sqlite?.filePath.split(/[\\/]/).pop() ?? '')
        : connection.engine === 'mongodb' && connection.mongo?.srv
          ? connection.host
          : `${connection.host}:${connection.port}`
    item.description = unavailable
      ? `${engine.label} · no disponible en este editor`
      : `${engine.label} · ${where}${open ? ' · conectada' : ''}`
    const icon = connectionIcon(this.iconDir, connection.engine, connection.color, locked)
    item.iconPath = { light: vscode.Uri.file(icon.light), dark: vscode.Uri.file(icon.dark) }
    item.resourceUri = vscode.Uri.from({
      scheme: CONNECTION_SCHEME,
      path: `/${id}`,
      query: `env=${connection.environment}&locked=${locked ? 1 : 0}`
    })
    const family = connection.engine === 'mongodb' ? 'mongo' : 'sql'
    item.contextValue = `vortaq.connection.${family}.${open ? 'open' : 'closed'}`
    const tooltip = new vscode.MarkdownString(undefined, true)
    tooltip.appendMarkdown(`**${escapeMd(connection.name)}**\n\n`)
    tooltip.appendMarkdown(`${engine.label} · ${escapeMd(where)}\n\n`)
    tooltip.appendMarkdown(`Entorno: ${environmentName(connection.environment)}`)
    if (locked) tooltip.appendMarkdown(' · las escrituras piden escribir el nombre de la conexión')
    if (unavailable) tooltip.appendMarkdown(`\n\n${escapeMd(this.connections.sqliteProblem ?? '')}`)
    item.tooltip = tooltip
    return item
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      const list = await this.connections.list()
      for (const id of [...this.nodes.keys()])
        if (!list.some((c) => c.id === id)) this.nodes.delete(id)
      return list.map((c) => this.connectionNode(c.id))
    }
    const connection = this.connections.get(node.connectionId)
    if (!connection) return []
    try {
      return await this.childrenOf(node, connection)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (node.kind === 'connection') this.onOpenError(connection, message)
      return [
        {
          kind: 'message',
          connectionId: node.connectionId,
          label: node.kind === 'connection' ? 'No se pudo conectar' : 'No se pudo leer',
          detail: message,
          error: true
        }
      ]
    }
  }

  private async childrenOf(node: TreeNode, connection: ConnectionConfig): Promise<TreeNode[]> {
    const core = this.connections.core
    const id = connection.id
    switch (node.kind) {
      case 'connection': {
        if (!this.connections.isOpen(id)) {
          this.opening.add(id)
          let info
          try {
            info = await this.connections.open(id)
          } finally {
            this.opening.delete(id)
          }
          if (!info) {
            // Password prompt dismissed: show the connection collapsed again.
            this.bump(id)
            setTimeout(() => this.emitter.fire(undefined), 0)
            return []
          }
          // Now open: refresh its row (description, menu) once this expand has returned.
          setTimeout(() => this.emitter.fire(this.connectionNode(id)), 0)
        }
        const custom = connection.customDatabases ?? []
        const databases = (await core.invoke('db:databases', id))
          .map((d) => d.name)
          .filter((name) => !custom.length || custom.includes(name))
        return databases.map((database) => ({ kind: 'database', connectionId: id, database }))
      }
      case 'database': {
        if (connection.engine === 'postgresql') {
          const schemas = await core.invoke('db:schemas', id, node.database)
          return schemas.map((s) => ({
            kind: 'schema',
            connectionId: id,
            database: node.database,
            schema: s.name
          }))
        }
        if (connection.engine === 'mongodb')
          return (['collections', 'mongoViews'] as const).map((group) => ({
            kind: 'group',
            connectionId: id,
            database: node.database,
            group
          }))
        return (['tables', 'views'] as const).map((group) => ({
          kind: 'group',
          connectionId: id,
          database: node.database,
          group
        }))
      }
      case 'schema':
        return (['tables', 'views'] as const).map((group) => ({
          kind: 'group',
          connectionId: id,
          database: node.database,
          schema: node.schema,
          group
        }))
      case 'group': {
        if (node.group === 'collections' || node.group === 'mongoViews') {
          const all: MongoCollectionInfo[] = await core.invoke(
            'mongo:collections',
            id,
            node.database
          )
          const views = node.group === 'mongoViews'
          const list = all.filter((c) => (c.type === 'view') === views)
          if (!list.length) return [this.emptyNode(id, views ? 'Sin vistas' : 'Sin colecciones')]
          return list.map((c) => ({
            kind: 'collection',
            connectionId: id,
            database: node.database,
            name: c.name,
            view: views
          }))
        }
        const ref = schemaRefOf(connection, node.database, node.schema)
        const items =
          node.group === 'tables'
            ? await core.invoke('db:tables', id, ref)
            : await core.invoke('db:views', id, ref)
        if (!items.length)
          return [this.emptyNode(id, node.group === 'tables' ? 'Sin tablas' : 'Sin vistas')]
        return items.map((t) => ({
          kind: node.group === 'tables' ? 'table' : 'view',
          connectionId: id,
          database: node.database,
          ...(node.schema !== undefined ? { schema: node.schema } : {}),
          name: t.name
        }))
      }
      default:
        return []
    }
  }

  private emptyNode(connectionId: string, label: string): TreeNode {
    return { kind: 'message', connectionId, label, detail: '', error: false }
  }

  dispose(): void {
    this.subscription.dispose()
    this.emitter.dispose()
  }
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&')
}

/** Folder of the generated connection icons inside the extension's storage. */
export function iconFolder(storage: string): string {
  return join(storage, 'icons')
}
