import type { EngineObjectType } from '@shared/types'
import { api } from '@renderer/api'
import { splitRoutineName } from '@renderer/utils/objectColumns'
import { schemaRef } from '@renderer/utils/schemaRef'
import { useConnectionsStore } from '@renderer/stores/connections'
import { OBJECTS_TAB_ID, objectTabId, useTabsStore, tabTitle } from '@renderer/stores/tabs'
import { nodeIds, useTreeStore, type TreeNode } from '@renderer/stores/tree'
import type { GroupKind } from '@renderer/utils/objectTypes'
import { useUiStore } from '@renderer/stores/ui'
import { useNotify } from './useNotify'
import { runSafely } from '@renderer/utils/errors'

/** High-level actions shared by the toolbar, the tree and the objects list. */
export function useWorkspace() {
  const tabs = useTabsStore()
  const tree = useTreeStore()
  const connections = useConnectionsStore()
  const ui = useUiStore()
  const notify = useNotify()

  /**
   * Connection the toolbar acts on: the tree selection, then the active tab.
   * Without either, only an unambiguous single connection is used: acting on an
   * arbitrary one (maybe production) the user never chose would be surprising.
   */
  function currentConnectionId(): string | null {
    return (
      tree.selected?.connectionId ??
      tabs.active.connectionId ??
      (connections.items.length === 1 ? connections.items[0].id : null)
    )
  }

  /** Schema in context, never mixing the tree selection with another connection's tab. */
  function currentSchema(): string | null {
    if (tree.selected?.schema) return tree.selected.schema
    const cid = currentConnectionId()
    return cid && tabs.active.connectionId === cid ? (tabs.active.schema ?? null) : null
  }

  /** PostgreSQL database in context (tree selection, then the active tab); undefined on MySQL. */
  function currentDatabase(): string | undefined {
    if (tree.selected?.database !== undefined) return tree.selected.database
    const cid = currentConnectionId()
    return cid && tabs.active.connectionId === cid ? tabs.active.database : undefined
  }

  async function ensureOpen(connectionId: string): Promise<boolean> {
    if (connections.isOpen(connectionId)) return true
    try {
      await connections.open(connectionId)
      tree.setExpanded(nodeIds.connection(connectionId), true)
      await tree.loadDatabases(connectionId)
      return true
    } catch {
      return false
    }
  }

  /*
   * `database` is only for engines with a database level above schemas
   * (PostgreSQL); MySQL callers omit it and get the v0.1.0 ids and titles.
   */
  function openTableData(
    connectionId: string,
    schema: string,
    table: string,
    database?: string
  ): void {
    tabs.open({
      kind: 'tableData',
      id: objectTabId('tableData', connectionId, database, schema, table),
      title: tabTitle(table, schema, connections.nameOf(connectionId), database),
      connectionId,
      database,
      schema,
      objectName: table,
      objectType: 'table'
    })
  }

  function openTableDesigner(
    connectionId: string,
    schema: string,
    table: string | null,
    database?: string
  ): void {
    tabs.open({
      kind: 'tableDesigner',
      id: table ? objectTabId('tableDesigner', connectionId, database, schema, table) : undefined,
      title: table
        ? tabTitle(table, schema, connections.nameOf(connectionId), database)
        : tabTitle('Nueva tabla', schema, connections.nameOf(connectionId), database),
      connectionId,
      database,
      schema,
      objectName: table ?? undefined,
      objectType: 'table'
    })
  }

  /**
   * DDL editor tab. PostgreSQL routines pass `{ signature }` (overloads share a
   * name) and triggers `{ table }` in `payload`; MySQL callers pass none.
   */
  function openDdlEditor(
    connectionId: string,
    schema: string,
    type: EngineObjectType,
    name: string | null,
    database?: string,
    payload?: { signature?: string; table?: string }
  ): void {
    const idName = name && payload?.signature !== undefined ? `${name}(${payload.signature})` : name
    tabs.open({
      kind: 'ddlEditor',
      id: idName ? objectTabId('ddl', connectionId, database, schema, type, idName) : undefined,
      title: idName
        ? tabTitle(idName, schema, connections.nameOf(connectionId), database)
        : tabTitle(`Nuevo ${type}`, schema, connections.nameOf(connectionId), database),
      connectionId,
      database,
      schema,
      objectName: name ?? undefined,
      objectType: type,
      ...(payload ? { payload } : {})
    })
  }

  function openQuery(
    connectionId?: string | null,
    schema?: string | null,
    payload?: { savedQueryId?: string; sql?: string; name?: string },
    /** PostgreSQL: database of the tab (defaults to the tree's / the initial one). */
    database?: string
  ): void {
    const cid = connectionId ?? currentConnectionId()
    if (!cid) {
      notify.warning('Selecciona una conexión antes de crear una consulta')
      return
    }
    // A query first saved with "Guardar como" lives in a tab with an anonymous id: reuse it.
    const savedId = payload?.savedQueryId
    const existing = savedId
      ? tabs.tabs.find(
          (t) => t.kind === 'query' && t.connectionId === cid && t.payload?.savedQueryId === savedId
        )
      : undefined
    if (existing) {
      tabs.activate(existing.id)
      return
    }
    const s = schema ?? (tree.selected?.connectionId === cid ? currentSchema() : null)
    const name = payload?.name ?? 'Consulta sin título'
    // PostgreSQL tabs always know their database (MySQL tabs never get one).
    const db = tree.hasDatabaseLevel(cid)
      ? (database ??
        (tree.selected?.connectionId === cid ? currentDatabase() : undefined) ??
        connections.get(cid)?.postgres?.initialDatabase ??
        'postgres')
      : undefined
    // A tab with this id may since have been switched to another connection: open a new one.
    const queryTabId = savedId ? `query:${cid}:${savedId}` : undefined
    const idTaken = !!queryTabId && tabs.tabs.some((t) => t.id === queryTabId)
    const where = db !== undefined ? (s ? `${db}.${s}` : db) : s
    tabs.open({
      kind: 'query',
      id: idTaken ? undefined : queryTabId,
      title: `${name}${where ? `@${where}` : ''} (${connections.nameOf(cid)})`,
      connectionId: cid,
      ...(db !== undefined ? { database: db } : {}),
      schema: s ?? undefined,
      payload
    })
  }

  /** MongoDB documents browser of a collection or view (`schema` is the database). */
  function openCollection(connectionId: string, database: string, collection: string): void {
    tabs.open({
      kind: 'collection',
      id: objectTabId('collection', connectionId, undefined, database, collection),
      title: tabTitle(collection, database, connections.nameOf(connectionId)),
      connectionId,
      schema: database,
      objectName: collection,
      objectType: 'collection'
    })
  }

  /** MongoDB collection designer (indexes, validator, options); null = new collection. */
  function openCollectionDesigner(
    connectionId: string,
    database: string,
    collection: string | null,
    section: 'indexes' | 'validator' | 'options' = 'indexes'
  ): void {
    tabs.open({
      kind: 'collectionDesigner',
      id: collection
        ? objectTabId('collectionDesigner', connectionId, undefined, database, collection)
        : undefined,
      title: tabTitle(collection ?? 'Nueva colección', database, connections.nameOf(connectionId)),
      connectionId,
      schema: database,
      objectName: collection ?? undefined,
      objectType: 'collection',
      payload: { section }
    })
  }

  function openBackups(connectionId?: string | null, schema?: string | null): void {
    const cid = connectionId ?? currentConnectionId()
    if (!cid) return notify.warning('Selecciona una conexión')
    tabs.open({
      kind: 'backups',
      id: `backups:${cid}:${schema ?? '*'}`,
      title: `Copias de seguridad${schema ? `@${schema}` : ''} (${connections.nameOf(cid)})`,
      connectionId: cid,
      schema: schema ?? undefined
    })
  }

  function openUsers(connectionId?: string | null): void {
    const cid = connectionId ?? currentConnectionId()
    if (!cid) return notify.warning('Selecciona una conexión')
    tabs.open({
      kind: 'users',
      id: `users:${cid}`,
      title: `Usuarios (${connections.nameOf(cid)})`,
      connectionId: cid
    })
  }

  function openAutomation(): void {
    tabs.open({ kind: 'automation', id: 'automation', title: 'Automatización' })
  }

  function openJobEditor(jobId: string | null, name?: string): void {
    tabs.open({
      kind: 'jobEditor',
      id: jobId ? `job:${jobId}` : undefined,
      title: jobId ? `${name ?? 'Tarea'} (Automatización)` : 'Nueva tarea (Automatización)',
      payload: { jobId }
    })
  }

  /** Activates the fixed "Objetos" tab. */
  function showObjects(): void {
    tabs.activate(OBJECTS_TAB_ID)
  }

  /**
   * Selects a group (Tablas, Vistas...) of the current schema in the tree and
   * shows it in the Objects tab (the toolbar's Objetos menu).
   */
  async function showGroup(group: GroupKind): Promise<boolean> {
    const cid = currentConnectionId()
    const schema = currentSchema()
    if (!cid || !schema) {
      notify.warning('Selecciona una base de datos en el árbol de conexiones')
      return false
    }
    if (!(await ensureOpen(cid))) return false
    const db = currentDatabase()
    tree.setExpanded(nodeIds.connection(cid), true)
    if (db !== undefined) tree.setExpanded(nodeIds.database(cid, db), true)
    tree.setExpanded(nodeIds.schema(cid, schema, db), true)
    const node = tree.parse(nodeIds.group(cid, schema, group, db))
    if (!node) return false
    tree.select(node.id)
    showObjects()
    await tree.expand(node)
    return true
  }

  /** Default action for double-clicking a tree/object node. */
  async function openNode(node: TreeNode): Promise<void> {
    if (node.kind === 'connection') {
      await ensureOpen(node.connectionId)
      return
    }
    if (node.kind !== 'object' || !node.schema || !node.name) return
    const { connectionId, schema, name, group, database } = node
    if (database !== undefined) return openPgNode(node)
    if (connections.get(connectionId)?.engine === 'sqlite') return openSqliteNode(node)
    if (connections.get(connectionId)?.engine === 'mongodb') return openMongoNode(node)
    switch (group) {
      case 'tables':
        return openTableData(connectionId, schema, name)
      case 'views':
        return openDdlEditor(connectionId, schema, 'view', name)
      case 'functions':
        return openDdlEditor(
          connectionId,
          schema,
          node.subtype === 'PROCEDURE' ? 'procedure' : 'function',
          name
        )
      case 'events':
        return openDdlEditor(connectionId, schema, 'event', name)
      case 'queries':
        return openQuery(connectionId, schema, { savedQueryId: name })
      case 'backups':
        return openBackups(connectionId, schema)
      case 'sequences': {
        // MariaDB: no dedicated editor, the DDL opens in a query tab (read it, edit it, run it).
        const ddl = await api.db.showCreate(connectionId, schema, 'sequence', name)
        return openQuery(connectionId, schema, { sql: ddl, name })
      }
    }
  }

  /** PostgreSQL objects: every tab carries the database (two databases never share a tab). */
  async function openPgNode(node: TreeNode): Promise<void> {
    const { connectionId: c, schema, name, group, database: db } = node
    if (!schema || !name || db === undefined) return
    switch (group) {
      case 'tables':
      case 'materializedViews':
        return openTableData(c, schema, name, db)
      case 'views':
        return openDdlEditor(c, schema, 'view', name, db)
      case 'functions': {
        const parts = splitRoutineName(name)
        return openDdlEditor(
          c,
          schema,
          node.subtype === 'PROCEDURE' ? 'procedure' : 'function',
          parts.name,
          db,
          { signature: parts.signature ?? '' }
        )
      }
      case 'sequences':
      case 'types': {
        // No dedicated editor: the DDL opens in a query tab (read it, edit it, run it).
        const type = group === 'sequences' ? 'sequence' : 'type'
        const ddl = await api.db.showCreate(c, schemaRef(schema, db), type, name)
        return openQuery(c, schema, { sql: ddl, name }, db)
      }
      case 'queries':
        return openQuery(c, schema, { savedQueryId: name }, db)
    }
  }

  /** SQLite objects: views open as data (read-only), indexes as DDL, triggers in the DDL editor. */
  async function openSqliteNode(node: TreeNode): Promise<void> {
    const { connectionId: c, schema, name, group } = node
    if (!schema || !name) return
    switch (group) {
      case 'tables':
      case 'views':
        return openTableData(c, schema, name)
      case 'indexes': {
        const ddl = await api.db.showCreate(c, schema, 'index', name)
        return openQuery(c, schema, { sql: ddl, name })
      }
      case 'triggers':
        return openDdlEditor(c, schema, 'trigger', name)
      case 'queries':
        return openQuery(c, schema, { savedQueryId: name })
    }
  }

  /** MongoDB: collections and views open their documents; indexes their collection's designer. */
  function openMongoNode(node: TreeNode): void {
    const { connectionId: c, schema, name, group } = node
    if (!schema || !name) return
    switch (group) {
      case 'collections':
      case 'views':
        return openCollection(c, schema, name)
      case 'indexes': {
        const item = tree.itemsOf(c, schema, 'indexes').find((o) => o.name === name)
        return openCollectionDesigner(c, schema, item?.table ?? name.split('.')[0], 'indexes')
      }
      case 'queries':
        return openQuery(c, schema, { savedQueryId: name })
    }
  }

  function designNode(node: TreeNode): void {
    if (node.kind !== 'object' || !node.schema || !node.name) return
    if (node.group === 'collections') {
      openCollectionDesigner(node.connectionId, node.schema, node.name)
      return
    }
    if (node.group === 'tables')
      openTableDesigner(node.connectionId, node.schema, node.name, node.database)
    else void runSafely(() => openNode(node))
  }

  /**
   * Cmd/Ctrl+D: the structure of the object in context. With the tree focused,
   * its selected table, collection or view; otherwise the active data tab's
   * table (a view opened as data, in SQLite or a PostgreSQL materialized view,
   * opens its DDL). False when there is nothing to show.
   */
  function designCurrent(fromTree: boolean): boolean {
    if (fromTree) {
      const node = tree.selected
      if (node?.kind !== 'object' || !node.schema || !node.name) return false
      if (node.group === 'materializedViews' && node.database !== undefined) {
        openDdlEditor(node.connectionId, node.schema, 'materialized_view', node.name, node.database)
        return true
      }
      if (!['tables', 'collections', 'views'].includes(node.group ?? '')) return false
      designNode(node)
      return true
    }
    const tab = tabs.active
    const { connectionId: c, schema: s, objectName: name, database: db } = tab
    if (!c || !s || !name) return false
    if (tab.kind === 'collection') {
      openCollectionDesigner(c, s, name)
      return true
    }
    if (tab.kind !== 'tableData') return false
    const listed = (group: 'views' | 'materializedViews'): boolean =>
      tree.itemsOf(c, s, group, db).some((o) => o.name === name)
    if (listed('views')) openDdlEditor(c, s, 'view', name, db)
    else if (db !== undefined && listed('materializedViews'))
      openDdlEditor(c, s, 'materialized_view', name, db)
    else openTableDesigner(c, s, name, db)
    return true
  }

  return {
    currentConnectionId,
    currentSchema,
    currentDatabase,
    ensureOpen,
    openTableData,
    openTableDesigner,
    openDdlEditor,
    openQuery,
    openCollection,
    openCollectionDesigner,
    openBackups,
    openUsers,
    openAutomation,
    openJobEditor,
    openNode,
    designNode,
    designCurrent,
    showObjects,
    showGroup,
    ui
  }
}
