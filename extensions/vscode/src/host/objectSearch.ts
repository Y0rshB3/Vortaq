/**
 * «Vortaq: Buscar tabla o vista…»: every table and view of a connection in one
 * list you type into; picking one shows it in the tree. Structure only (the
 * same db:* channels as the tree), loaded namespace by namespace while the list
 * is open. PostgreSQL and SQL Server search the selected (or initial) database,
 * across its schemas; MySQL, MariaDB and SQLite every database or attachment.
 */
import * as vscode from 'vscode'
import { usesSchemaRef, type ConnectionConfig, type SchemaRef, type VortaqCore } from '@core'
import type { ConnectionService } from './connections'
import type { ObjectNode, TreeNode } from './tree'

/** At most this many namespaces are read for one search. */
export const MAX_NAMESPACES = 60

type Named = { name: string }
type ObjectItem = vscode.QuickPickItem & { node: ObjectNode }

export interface ObjectSearchDeps {
  core: VortaqCore
  connections: ConnectionService
  reveal: (node: ObjectNode) => Thenable<void> | Promise<void>
}

/** The database PostgreSQL / SQL Server search: the selection's, else the initial one. */
export function searchDatabase(connection: ConnectionConfig, node?: TreeNode): string {
  if (node && 'database' in node) return node.database
  if (connection.engine === 'sqlserver')
    return connection.sqlserver?.initialDatabase?.trim() || 'master'
  return connection.postgres?.initialDatabase || 'postgres'
}

/** The namespaces to read, in the order the list fills. */
export async function namespacesOf(
  core: VortaqCore,
  connection: ConnectionConfig,
  node?: TreeNode
): Promise<{ database: string; schema?: string }[]> {
  if (usesSchemaRef(connection.engine)) {
    const database = searchDatabase(connection, node)
    const schemas = (await core.invoke('db:schemas', connection.id, database)) as Named[]
    return schemas.slice(0, MAX_NAMESPACES).map((s) => ({ database, schema: s.name }))
  }
  const databases = (await core.invoke('db:databases', connection.id)) as Named[]
  return databases.slice(0, MAX_NAMESPACES).map((d) => ({ database: d.name }))
}

export function objectItems(
  space: { database: string; schema?: string },
  connectionId: string,
  tables: readonly Named[],
  views: readonly Named[]
): ObjectItem[] {
  const where = space.schema ? `${space.database}.${space.schema}` : space.database
  const item = (kind: 'table' | 'view', name: string): ObjectItem => ({
    label: `$(${kind === 'table' ? 'table' : 'eye'}) ${name}`,
    description: `${kind === 'table' ? 'tabla' : 'vista'} · ${where}`,
    node: {
      kind,
      connectionId,
      database: space.database,
      ...(space.schema ? { schema: space.schema } : {}),
      name
    }
  })
  return [...tables.map((t) => item('table', t.name)), ...views.map((v) => item('view', v.name))]
}

async function chooseConnection(connections: ConnectionService): Promise<ConnectionConfig | null> {
  const all = (await connections.list()).filter((c) => c.engine !== 'mongodb')
  if (!all.length) {
    void vscode.window.showInformationMessage('Añade una conexión SQL para buscar en ella.')
    return null
  }
  const open = all.filter((c) => connections.isOpen(c.id))
  if (open.length === 1) return open[0]
  const picked = await vscode.window.showQuickPick(
    (open.length ? open : all).map((c) => ({ label: c.name, description: c.engine, c })),
    { title: 'Vortaq · Buscar tabla o vista', placeHolder: '¿En qué conexión?' }
  )
  return picked?.c ?? null
}

export async function findObject(deps: ObjectSearchDeps, node?: TreeNode): Promise<void> {
  const selected = node ? deps.connections.get(node.connectionId) : null
  const connection =
    selected && selected.engine !== 'mongodb' ? selected : await chooseConnection(deps.connections)
  if (!connection) return
  if (!(await deps.connections.open(connection.id))) return
  const pick = vscode.window.createQuickPick<ObjectItem>()
  pick.title = `Vortaq · Buscar tabla o vista · ${connection.name}`
  pick.placeholder = 'Escribe parte del nombre'
  pick.matchOnDescription = true
  pick.busy = true
  let closed = false
  pick.onDidHide(() => {
    closed = true
    pick.dispose()
  })
  pick.onDidAccept(async () => {
    const item = pick.selectedItems[0]
    pick.hide()
    if (item) await deps.reveal(item.node)
  })
  pick.show()
  try {
    const spaces = await namespacesOf(deps.core, connection, node)
    for (const space of spaces) {
      if (closed) return
      const ref: SchemaRef = space.schema
        ? { database: space.database, schema: space.schema }
        : space.database
      const [tables, views] = await Promise.all([
        deps.core.invoke('db:tables', connection.id, ref).catch(() => []) as Promise<Named[]>,
        deps.core.invoke('db:views', connection.id, ref).catch(() => []) as Promise<Named[]>
      ])
      if (closed) return
      // Keep what the user has highlighted while the list grows.
      const active = pick.activeItems
      pick.items = [...pick.items, ...objectItems(space, connection.id, tables, views)]
      if (active.length) pick.activeItems = active
    }
  } catch (err) {
    if (!closed) pick.placeholder = err instanceof Error ? err.message : String(err)
  } finally {
    if (!closed) pick.busy = false
  }
}
