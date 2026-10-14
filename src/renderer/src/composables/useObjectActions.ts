import type { EngineCapabilities } from '@shared/engines'
import { postgresqlDialect } from '@shared/dialects/postgresql'
import { qualified as liteQualified, quoteIdent as liteQ } from '@shared/dialects/sqlite'
import type { SqliteMaintenanceAction } from '@shared/types'
import type { EngineObjectType, NameRef, ObjectType } from '@shared/types'
import { api } from '@renderer/api'
import { descriptorOf } from '@renderer/engines/capabilities'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useQueriesStore } from '@renderer/stores/queries'
import { useTabsStore } from '@renderer/stores/tabs'
import { nodeIds, useTreeStore, type TreeNode } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import { OBJECT_TYPE_LABELS, OBJECT_TYPE_WITH_ARTICLE } from '@renderer/utils/objectTypes'
import { qualified } from '@renderer/utils/sql'
import { splitRoutineName } from '@renderer/utils/objectColumns'
import { schemaRef } from '@renderer/utils/schemaRef'
import { connectionUri } from '@renderer/components/dialogs/connectionForm'
import { useConfirm } from './useConfirm'
import { errorMessage, useNotify } from './useNotify'
import { useWorkspace } from './useWorkspace'

export interface MenuAction {
  key: string
  label: string
  icon?: string
  disabled?: boolean
  danger?: boolean
  divider?: boolean
  action?: () => void | Promise<void>
  /** Submenu (opens on hover); the item itself has no action. */
  children?: MenuAction[]
  /** Keyboard shortcut shown at the right («⌘C»). */
  hint?: string
}

export function objectTypeOf(node: TreeNode): ObjectType | null {
  switch (node.group) {
    case 'tables':
      return 'table'
    case 'views':
      return 'view'
    case 'functions':
      return node.subtype === 'PROCEDURE' ? 'procedure' : 'function'
    case 'events':
      return 'event'
    default:
      return null
  }
}

/** Object type of a node on any engine (PostgreSQL adds matviews, sequences and types). */
export function engineObjectTypeOf(node: TreeNode): EngineObjectType | null {
  switch (node.group) {
    case 'materializedViews':
      return 'materialized_view'
    case 'sequences':
      return 'sequence'
    case 'types':
      return 'type'
    // SQLite (MySQL and PostgreSQL have no such tree groups).
    case 'indexes':
      return 'index'
    case 'triggers':
      return 'trigger'
    default:
      return objectTypeOf(node)
  }
}

/**
 * Name argument of db:showCreate / db:dropObject: the plain name, or on
 * PostgreSQL routines `{ type, name, signature }` (the node name is `name(args)`).
 */
export function nameRefOf(node: TreeNode, type: EngineObjectType): NameRef {
  if (node.database !== undefined && (type === 'function' || type === 'procedure')) {
    const parts = splitRoutineName(node.name ?? '')
    return { type, name: parts.name, signature: parts.signature ?? '' }
  }
  return node.name ?? ''
}

/** PostgreSQL labels for the types MySQL does not have. */
const PG_TYPE_LABELS: Partial<Record<EngineObjectType, { label: string; article: string }>> = {
  materialized_view: { label: 'vista materializada', article: 'la vista materializada' },
  sequence: { label: 'secuencia', article: 'la secuencia' },
  type: { label: 'tipo', article: 'el tipo' }
}

/** SQLite object types of the tree groups (tables, views, indexes, triggers). */
export function sqliteObjectTypeOf(node: TreeNode): EngineObjectType | null {
  switch (node.group) {
    case 'tables':
      return 'table'
    case 'views':
      return 'view'
    case 'indexes':
      return 'index'
    case 'triggers':
      return 'trigger'
    default:
      return null
  }
}

const LITE_TYPE_LABELS: Partial<Record<EngineObjectType, { label: string; article: string }>> = {
  table: { label: 'tabla', article: 'la tabla' },
  view: { label: 'vista', article: 'la vista' },
  index: { label: 'índice', article: 'el índice' },
  trigger: { label: 'disparador', article: 'el disparador' }
}

/** «Mostrar en Finder» on macOS, the file manager elsewhere. */
function showInFolderLabel(): string {
  const platform = typeof window !== 'undefined' ? window.vortaq?.platform : undefined
  return platform === 'darwin' ? 'Mostrar en Finder' : 'Mostrar en la carpeta'
}

const pgQ = postgresqlDialect.quoteIdent
const pgQualified = (schema: string, name: string): string => `${pgQ(schema)}.${pgQ(name)}`

export function useObjectActions() {
  const tree = useTreeStore()
  const tabs = useTabsStore()
  const connections = useConnectionsStore()
  const queries = useQueriesStore()
  const ui = useUiStore()
  const ws = useWorkspace()
  const notify = useNotify()
  const { confirmDestructive, ask } = useConfirm()

  /**
   * Capabilities of the node's engine. Menus only drop entries the engine
   * cannot do, so MySQL (which can do all of them) keeps its v0.1.0 menus.
   * An unknown engine gets no capability-gated entry.
   */
  function capsOf(connectionId: string): Partial<EngineCapabilities> {
    return descriptorOf(connections.get(connectionId))?.capabilities ?? {}
  }

  async function copyText(text: string, what = 'Texto'): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      notify.success(`${what} copiado al portapapeles`)
    } catch {
      notify.error('No se pudo copiar al portapapeles')
    }
  }

  async function dropObject(node: TreeNode): Promise<void> {
    if (node.database !== undefined) return dropPgObject(node)
    if (node.group === 'sequences') return dropMariaDbSequence(node)
    const type = objectTypeOf(node)
    if (!type || !node.schema || !node.name) return
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: `Eliminar ${OBJECT_TYPE_LABELS[type]}`,
      message: `Se eliminará ${OBJECT_TYPE_WITH_ARTICLE[type]} ${qualified(node.schema, node.name)} de forma permanente.`,
      confirmText: 'Eliminar',
      destructive: {
        title: `¿Eliminar ${OBJECT_TYPE_WITH_ARTICLE[type]} «${node.name}»?`,
        message: 'Se eliminará de forma permanente. Esta acción no se puede deshacer.',
        items: [{ tag: `DROP ${type.toUpperCase()}`, text: qualified(node.schema, node.name) }],
        confirmText: 'Eliminar'
      }
    })
    if (!ok) return
    await api.db.dropObject(node.connectionId, node.schema, type, node.name, {
      confirmProduction: true
    })
    notify.success(`${node.name} eliminado`)
    await tree.loadGroup(node.connectionId, node.schema, node.group!, true)
  }

  async function truncateTable(node: TreeNode): Promise<void> {
    if (!node.schema || !node.name) return
    const sql = `TRUNCATE TABLE ${qualified(node.schema, node.name)}`
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: 'Truncar tabla',
      message: `Se borrarán todas las filas de ${qualified(node.schema, node.name)}. Esta acción no se puede deshacer.`,
      details: sql,
      confirmText: 'Truncar',
      destructive: {
        title: `¿Vaciar la tabla «${node.name}»?`,
        message: 'Se borrarán todas sus filas. Esta acción no se puede deshacer.',
        items: [{ tag: 'TRUNCATE TABLE', text: qualified(node.schema, node.name) }],
        confirmText: 'Eliminar'
      }
    })
    if (!ok) return
    const [result] = await api.db.execute(node.connectionId, sql, { confirmProduction: true })
    if (result?.error) notify.error(result.error)
    else {
      notify.success(`Tabla ${node.name} truncada`)
      await tree.loadGroup(node.connectionId, node.schema, 'tables', true)
    }
  }

  async function exportDdl(node: TreeNode): Promise<void> {
    if (node.database !== undefined) {
      const type = engineObjectTypeOf(node)
      if (!type || !node.schema || !node.name) return
      const ddl = await api.db.showCreate(
        node.connectionId,
        schemaRef(node.schema, node.database),
        type,
        nameRefOf(node, type)
      )
      await copyText(ddl, 'DDL')
      return
    }
    if (node.group === 'sequences' && node.schema && node.name) {
      const ddl = await api.db.showCreate(node.connectionId, node.schema, 'sequence', node.name)
      await copyText(ddl, 'DDL')
      return
    }
    const type = objectTypeOf(node)
    if (!type || !node.schema || !node.name) return
    const ddl = await api.db.showCreate(node.connectionId, node.schema, type, node.name)
    await copyText(ddl, 'DDL')
  }

  /* ---------- MariaDB sequences ---------- */

  async function dropMariaDbSequence(node: TreeNode): Promise<void> {
    if (!node.schema || !node.name) return
    const target = qualified(node.schema, node.name)
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: 'Eliminar secuencia',
      message: `Se eliminará la secuencia ${target} de forma permanente.`,
      confirmText: 'Eliminar',
      destructive: {
        title: `¿Eliminar la secuencia «${node.name}»?`,
        message: 'Se eliminará de forma permanente. Esta acción no se puede deshacer.',
        items: [{ tag: 'DROP SEQUENCE', text: target }],
        confirmText: 'Eliminar'
      }
    })
    if (!ok) return
    await api.db.dropObject(node.connectionId, node.schema, 'sequence', node.name, {
      confirmProduction: true
    })
    notify.success(`${node.name} eliminado`)
    await tree.loadGroup(node.connectionId, node.schema, 'sequences', true)
  }

  /** MariaDB sequence actions: state (a read) and the next value (SETVAL, a guarded write). */
  function mariaDbSequenceItems(node: TreeNode): MenuAction[] {
    const c = node.connectionId
    const s = node.schema!
    const target = qualified(s, node.name!)
    return [
      {
        key: 'seqState',
        label: 'Ver estado',
        icon: 'mdi-numeric',
        action: () =>
          ws.openQuery(c, s, {
            sql: `SELECT next_not_cached_value, minimum_value, maximum_value, increment, cache_size, cycle_option, cycle_count\n  FROM ${target};`,
            name: `Estado de ${node.name}`
          })
      },
      {
        key: 'setval',
        label: 'Fijar siguiente valor…',
        icon: 'mdi-numeric-positive-1',
        action: () =>
          ws.openQuery(c, s, {
            sql: `-- El siguiente NEXTVAL devolverá el valor posterior a este.\nSELECT SETVAL(${target}, 1);`,
            name: `SETVAL ${node.name}`
          })
      }
    ]
  }

  /* ---------- PostgreSQL (preview) ---------- */

  /** Runs one confirmed statement on the node's database; true when it succeeded. */
  async function runPg(node: TreeNode, sql: string, success: string): Promise<boolean> {
    const [result] = await api.db.execute(node.connectionId, sql, {
      schema: schemaRef(node.schema ?? '', node.database),
      confirmProduction: true
    })
    if (result?.error) {
      notify.error(result.error)
      return false
    }
    notify.success(success)
    return true
  }

  async function dropPgObject(node: TreeNode): Promise<void> {
    const type = engineObjectTypeOf(node)
    if (!type || !node.schema || !node.name || node.database === undefined) return
    const labels = PG_TYPE_LABELS[type] ?? {
      label: OBJECT_TYPE_LABELS[type as ObjectType],
      article: OBJECT_TYPE_WITH_ARTICLE[type as ObjectType]
    }
    const target = `${node.database}.${node.schema}.${node.label}`
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: `Eliminar ${labels.label}`,
      message: `Se eliminará ${labels.article} ${target} de forma permanente.`,
      confirmText: 'Eliminar',
      destructive: {
        title: `¿Eliminar ${labels.article} «${node.label}»?`,
        message: 'Se eliminará de forma permanente. Esta acción no se puede deshacer.',
        items: [{ tag: `DROP ${type.replace('_', ' ').toUpperCase()}`, text: target }],
        confirmText: 'Eliminar'
      }
    })
    if (!ok) return
    await api.db.dropObject(
      node.connectionId,
      schemaRef(node.schema, node.database),
      type,
      nameRefOf(node, type),
      { confirmProduction: true }
    )
    notify.success(`${node.label} eliminado`)
    await tree.loadGroup(node.connectionId, node.schema, node.group!, true, node.database)
  }

  /** TRUNCATE with PostgreSQL's options; CASCADE lists the tables whose rows also go. */
  async function truncatePg(
    node: TreeNode,
    options: { restartIdentity?: boolean; cascade?: boolean } = {}
  ): Promise<void> {
    if (!node.schema || !node.name || node.database === undefined) return
    const target = pgQualified(node.schema, node.name)
    const sql =
      `TRUNCATE TABLE ${target}` +
      (options.restartIdentity ? ' RESTART IDENTITY' : '') +
      (options.cascade ? ' CASCADE' : '')
    let dependants: string[] = []
    if (options.cascade) {
      const [r] = await api.db.execute(
        node.connectionId,
        // TRUNCATE … CASCADE is transitive and reaches partitions/children too: walk both.
        `WITH RECURSIVE dep(oid) AS (
           SELECT '${target.replace(/'/g, "''")}'::regclass::oid
           UNION
           SELECT x.oid FROM dep JOIN (
             SELECT con.conrelid AS oid, con.confrelid AS parent FROM pg_catalog.pg_constraint con
              WHERE con.contype = 'f'
             UNION ALL
             SELECT i.inhrelid, i.inhparent FROM pg_catalog.pg_inherits i
           ) x ON x.parent = dep.oid
         )
         SELECT n.nspname || '.' || c.relname FROM dep
           JOIN pg_catalog.pg_class c ON c.oid = dep.oid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE dep.oid <> '${target.replace(/'/g, "''")}'::regclass::oid ORDER BY 1`,
        { schema: schemaRef(node.schema, node.database) }
      )
      dependants = (r?.resultSet?.rows ?? []).map((row) => String(row[0]))
    }
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: 'Truncar tabla',
      message:
        `Se borrarán todas las filas de ${node.schema}.${node.name}` +
        (dependants.length
          ? ` y de las tablas que dependen de ella (${dependants.join(', ')})`
          : '') +
        (options.restartIdentity ? ' y se reiniciarán sus secuencias' : '') +
        '. Esta acción no se puede deshacer.',
      details: sql,
      confirmText: 'Truncar',
      destructive: {
        title: `¿Vaciar la tabla «${node.name}»?`,
        message: 'Se borrarán todas sus filas. Esta acción no se puede deshacer.',
        items: [
          { tag: 'TRUNCATE TABLE', text: `${node.schema}.${node.name}` },
          ...dependants.map((d) => ({ tag: 'CASCADE', text: d }))
        ],
        confirmText: 'Eliminar'
      }
    })
    if (!ok) return
    if (await runPg(node, sql, `Tabla ${node.name} truncada`))
      await tree.loadGroup(node.connectionId, node.schema, 'tables', true, node.database)
  }

  /** «Vaciar»: DELETE FROM (fires triggers, keeps sequences). */
  async function emptyPgTable(node: TreeNode): Promise<void> {
    if (!node.schema || !node.name) return
    const sql = `DELETE FROM ${pgQualified(node.schema, node.name)}`
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: 'Vaciar tabla',
      message: `Se borrarán todas las filas de ${node.schema}.${node.name} (DELETE: se ejecutan los disparadores).`,
      details: sql,
      confirmText: 'Vaciar',
      destructive: {
        title: `¿Vaciar la tabla «${node.name}»?`,
        message: 'Se borrarán todas sus filas. Esta acción no se puede deshacer.',
        items: [{ tag: 'DELETE', text: `${node.schema}.${node.name}` }],
        confirmText: 'Eliminar'
      }
    })
    if (ok) await runPg(node, sql, `Tabla ${node.name} vaciada`)
  }

  async function refreshMatview(node: TreeNode, concurrently: boolean): Promise<void> {
    if (!node.schema || !node.name) return
    const sql = `REFRESH MATERIALIZED VIEW ${concurrently ? 'CONCURRENTLY ' : ''}${pgQualified(node.schema, node.name)}`
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: 'Refrescar vista materializada',
      message: `Se volverá a calcular ${node.schema}.${node.name}.`,
      details: sql,
      alwaysAsk: false
    })
    if (ok && (await runPg(node, sql, `${node.name} refrescada`)))
      await tree.loadGroup(node.connectionId, node.schema, node.group!, true, node.database)
  }

  async function analyzeTable(node: TreeNode): Promise<void> {
    if (!node.schema || !node.name) return
    const sql = `ANALYZE ${pgQualified(node.schema, node.name)}`
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: 'Analizar tabla',
      message: `Se actualizarán las estadísticas de ${node.schema}.${node.name}.`,
      details: sql,
      alwaysAsk: false
    })
    if (ok && (await runPg(node, sql, `Estadísticas de ${node.name} actualizadas`)))
      await tree.loadGroup(node.connectionId, node.schema, 'tables', true, node.database)
  }

  async function sequenceValue(node: TreeNode): Promise<void> {
    if (!node.schema || !node.name) return
    const [r] = await api.db.execute(
      node.connectionId,
      `SELECT last_value, is_called FROM ${pgQualified(node.schema, node.name)}`,
      { schema: schemaRef(node.schema, node.database) }
    )
    if (r?.error) notify.error(r.error)
    else {
      const [last, called] = r?.resultSet?.rows[0] ?? []
      notify.success(
        `${node.name}: valor actual ${String(last)}${called ? '' : ' (todavía no usado)'}`
      )
    }
  }

  /** «Cerrar base de datos»: closes the database's pool; its node shows closed again. */
  async function closePgDatabase(connectionId: string, database: string): Promise<void> {
    try {
      await tree.closeDatabase(connectionId, database)
      notify.success(`Base de datos ${database} cerrada`)
    } catch (err) {
      notify.error(errorMessage(err))
    }
  }

  function pgStatementTab(node: TreeNode, sql: string, name: string): void {
    ws.openQuery(node.connectionId, node.schema ?? null, { sql, name }, node.database)
  }

  async function showExtensions(connectionId: string, database: string): Promise<void> {
    const list = await api.db.extensions(connectionId, database)
    await ask({
      title: `Extensiones de ${database}`,
      message: list.length
        ? 'Extensiones instaladas (para crear una, usa CREATE EXTENSION en el editor de consultas):'
        : 'No hay extensiones instaladas. Para crear una, usa CREATE EXTENSION en el editor de consultas.',
      items: list.map((e) => ({ tag: e.version, text: `${e.name} (${e.schema})` })),
      confirmText: 'Cerrar'
    })
  }

  function pgNewObjectFor(node: TreeNode): MenuAction[] {
    const c = node.connectionId
    const s = node.schema!
    const db = node.database!
    const q =
      (sql: string, name: string): MenuAction['action'] =>
      () =>
        pgStatementTab(node, sql, name)
    switch (node.group) {
      case 'tables':
        return [
          {
            key: 'new',
            label: 'Nueva tabla',
            icon: 'mdi-table-plus',
            action: () => ws.openTableDesigner(c, s, null, db)
          }
        ]
      case 'views':
        return [
          {
            key: 'new',
            label: 'Nueva vista',
            icon: 'mdi-plus',
            action: () => ws.openDdlEditor(c, s, 'view', null, db)
          }
        ]
      case 'materializedViews':
        return [
          {
            key: 'new',
            label: 'Nueva vista materializada',
            icon: 'mdi-plus',
            action: () => ws.openDdlEditor(c, s, 'materialized_view', null, db)
          }
        ]
      case 'functions':
        return [
          {
            key: 'newf',
            label: 'Nueva función',
            icon: 'mdi-plus',
            action: () => ws.openDdlEditor(c, s, 'function', null, db)
          },
          {
            key: 'newp',
            label: 'Nuevo procedimiento',
            icon: 'mdi-plus',
            action: () => ws.openDdlEditor(c, s, 'procedure', null, db)
          }
        ]
      case 'sequences':
        return [
          {
            key: 'new',
            label: 'Nueva secuencia',
            icon: 'mdi-plus',
            action: q(
              `CREATE SEQUENCE ${pgQualified(s, 'nueva_secuencia')} START 1;`,
              'Nueva secuencia'
            )
          }
        ]
      case 'types':
        return [
          {
            key: 'new',
            label: 'Nuevo tipo enumerado',
            icon: 'mdi-plus',
            action: q(
              `CREATE TYPE ${pgQualified(s, 'nuevo_tipo')} AS ENUM ('valor1', 'valor2');`,
              'Nuevo tipo'
            )
          }
        ]
      case 'queries':
        return [
          {
            key: 'new',
            label: 'Nueva consulta',
            icon: 'mdi-plus',
            action: () => ws.openQuery(c, s, undefined, db)
          }
        ]
      default:
        return []
    }
  }

  /** Context menu of a PostgreSQL database / schema / group / object node (section 4.1). */
  function pgActionsFor(node: TreeNode, refresh: MenuAction): MenuAction[] {
    const c = node.connectionId
    const db = node.database!
    if (node.kind === 'database') {
      const initial = connections.get(c)?.postgres?.initialDatabase || 'postgres'
      const loaded = tree.schemasOf(c, db).length > 0
      return [
        {
          key: 'query',
          label: 'Nueva consulta',
          icon: 'mdi-database-search-outline',
          action: () => ws.openQuery(c, null, undefined, db)
        },
        loaded
          ? {
              key: 'closeDb',
              label: 'Cerrar base de datos',
              icon: 'mdi-database-off-outline',
              // The initial database holds the connection's own sessions: it closes with it.
              disabled: db === initial,
              action: () => closePgDatabase(c, db)
            }
          : {
              key: 'openDb',
              label: 'Abrir base de datos',
              icon: 'mdi-database-arrow-right-outline',
              action: () => tree.expand(node)
            },
        {
          key: 'extensions',
          label: 'Extensiones',
          icon: 'mdi-puzzle-outline',
          action: () => showExtensions(c, db)
        },
        // PostgreSQL backups are .vqb of a whole database.
        {
          key: 'backup',
          label: 'Nueva copia de seguridad…',
          icon: 'mdi-archive-plus-outline',
          action: () => ui.openBackupDialog(c, db)
        },
        {
          key: 'backups',
          label: 'Copias de seguridad',
          icon: 'mdi-archive-outline',
          action: () => ws.openBackups(c, db)
        },
        { key: 'd1', label: '', divider: true },
        refresh,
        {
          key: 'drop',
          label: 'Eliminar base de datos',
          icon: 'mdi-delete-outline',
          danger: true,
          action: () => dropDatabase(node)
        }
      ]
    }
    if (node.kind === 'schema') {
      const s = node.schema!
      return [
        {
          key: 'query',
          label: 'Nueva consulta',
          icon: 'mdi-database-search-outline',
          action: () => ws.openQuery(c, s, undefined, db)
        },
        {
          key: 'table',
          label: 'Nueva tabla',
          icon: 'mdi-table-plus',
          action: () => ws.openTableDesigner(c, s, null, db)
        },
        { key: 'd1', label: '', divider: true },
        refresh
      ]
    }
    if (node.kind === 'group')
      return [...pgNewObjectFor(node), { key: 'd1', label: '', divider: true }, refresh]

    const s = node.schema!
    const group = node.group
    const items: MenuAction[] = []
    const opens = group !== 'sequences' && group !== 'types'
    items.push({
      key: 'open',
      label: opens ? 'Abrir' : 'Ver DDL',
      icon: 'mdi-open-in-app',
      action: () => ws.openNode(node)
    })
    if (group === 'tables')
      items.push({
        key: 'design',
        label: 'Diseñar tabla',
        icon: 'mdi-table-edit',
        action: () => ws.designNode(node)
      })
    items.push(...pgNewObjectFor({ ...node, kind: 'group' }))
    items.push({ key: 'd1', label: '', divider: true })
    if (group === 'queries') {
      items.push({
        key: 'copy',
        label: 'Copiar nombre',
        icon: 'mdi-content-copy',
        action: () => copyText(node.label, 'Nombre')
      })
      items.push({
        key: 'delete',
        label: 'Eliminar',
        icon: 'mdi-delete-outline',
        danger: true,
        action: () => deleteSavedQuery(node)
      })
      items.push({ key: 'd2', label: '', divider: true }, refresh)
      return items
    }
    const plainName = group === 'functions' ? splitRoutineName(node.name!).name : node.name!
    items.push({
      key: 'copy',
      label: 'Copiar nombre cualificado',
      icon: 'mdi-content-copy',
      action: () => copyText(pgQualified(s, plainName), 'Nombre')
    })
    items.push({
      key: 'ddl',
      label: 'Exportar DDL (copiar)',
      icon: 'mdi-code-tags',
      action: () => exportDdl(node)
    })
    if (group === 'tables') {
      items.push({
        key: 'analyze',
        label: 'Analizar (ANALYZE)',
        icon: 'mdi-chart-box-outline',
        action: () => analyzeTable(node)
      })
      items.push({
        key: 'empty',
        label: 'Vaciar (DELETE)',
        icon: 'mdi-eraser-variant',
        danger: true,
        action: () => emptyPgTable(node)
      })
      items.push({
        key: 'truncate',
        label: 'Truncar tabla',
        icon: 'mdi-eraser',
        danger: true,
        action: () => truncatePg(node)
      })
      items.push({
        key: 'truncateRestart',
        label: 'Truncar y reiniciar identidad',
        icon: 'mdi-eraser',
        danger: true,
        action: () => truncatePg(node, { restartIdentity: true })
      })
      items.push({
        key: 'truncateCascade',
        label: 'Truncar en cascada…',
        icon: 'mdi-eraser',
        danger: true,
        action: () => truncatePg(node, { restartIdentity: true, cascade: true })
      })
    }
    if (group === 'materializedViews') {
      items.push({
        key: 'refreshMv',
        label: 'Refrescar',
        icon: 'mdi-sync',
        action: () => refreshMatview(node, false)
      })
      items.push({
        key: 'refreshMvC',
        label: 'Refrescar (concurrently)',
        icon: 'mdi-sync',
        action: () => refreshMatview(node, true)
      })
    }
    if (group === 'sequences') {
      items.push({
        key: 'seqValue',
        label: 'Valor actual',
        icon: 'mdi-numeric',
        action: () => sequenceValue(node)
      })
      items.push({
        key: 'setval',
        label: 'Fijar valor actual…',
        icon: 'mdi-numeric-positive-1',
        action: () =>
          pgStatementTab(
            node,
            `SELECT setval('${pgQualified(s, node.name!).replace(/'/g, "''")}', 1, false);`,
            `setval ${node.name}`
          )
      })
    }
    if (group === 'types')
      items.push({
        key: 'addValue',
        label: 'Añadir valor…',
        icon: 'mdi-playlist-plus',
        action: () =>
          pgStatementTab(
            node,
            `ALTER TYPE ${pgQualified(s, node.name!)} ADD VALUE 'nuevo_valor';`,
            `Añadir valor a ${node.name}`
          )
      })
    items.push({
      key: 'delete',
      label: 'Eliminar',
      icon: 'mdi-delete-outline',
      danger: true,
      action: () => dropObject(node)
    })
    items.push({ key: 'd2', label: '', divider: true }, refresh)
    return items
  }

  /* ---------- SQLite (preview) ---------- */

  const isLite = (connectionId: string): boolean =>
    connections.get(connectionId)?.engine === 'sqlite'

  async function dropLiteObject(node: TreeNode): Promise<void> {
    const type = sqliteObjectTypeOf(node)
    if (!type || !node.schema || !node.name) return
    const labels = LITE_TYPE_LABELS[type]!
    const target = liteQualified(node.schema, node.name)
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: `Eliminar ${labels.label}`,
      message: `Se eliminará ${labels.article} ${node.schema}.${node.name} de forma permanente.`,
      confirmText: 'Eliminar',
      destructive: {
        title: `¿Eliminar ${labels.article} «${node.name}»?`,
        message: 'Se eliminará de forma permanente. Esta acción no se puede deshacer.',
        items: [{ tag: `DROP ${type.toUpperCase()}`, text: target }],
        confirmText: 'Eliminar'
      }
    })
    if (!ok) return
    await api.db.dropObject(node.connectionId, node.schema, type, node.name, {
      confirmProduction: true
    })
    notify.success(`${node.name} eliminado`)
    await tree.loadGroup(node.connectionId, node.schema, node.group!, true)
    // Dropping a table also drops its indexes and triggers.
    if (type === 'table')
      for (const g of ['indexes', 'triggers'] as const)
        if (tree.hasItems(node.connectionId, node.schema, g))
          await tree.loadGroup(node.connectionId, node.schema, g, true)
  }

  async function exportLiteDdl(node: TreeNode): Promise<void> {
    const type = sqliteObjectTypeOf(node)
    if (!type || !node.schema || !node.name) return
    await copyText(await api.db.showCreate(node.connectionId, node.schema, type, node.name), 'DDL')
  }

  /** «Vaciar»: DELETE FROM (SQLite has no TRUNCATE; triggers run, AUTOINCREMENT keeps its counter). */
  async function emptyLiteTable(node: TreeNode): Promise<void> {
    if (!node.schema || !node.name) return
    const sql = `DELETE FROM ${liteQualified(node.schema, node.name)}`
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: 'Vaciar tabla',
      message: `Se borrarán todas las filas de ${node.schema}.${node.name} (DELETE: se ejecutan los disparadores).`,
      details: sql,
      confirmText: 'Vaciar',
      destructive: {
        title: `¿Vaciar la tabla «${node.name}»?`,
        message: 'Se borrarán todas sus filas. Esta acción no se puede deshacer.',
        items: [{ tag: 'DELETE', text: `${node.schema}.${node.name}` }],
        confirmText: 'Eliminar'
      }
    })
    if (!ok) return
    const [result] = await api.db.execute(node.connectionId, sql, { confirmProduction: true })
    if (result?.error) notify.error(result.error)
    else notify.success(`Tabla ${node.name} vaciada`)
  }

  async function liteMaintenance(
    connectionId: string,
    action: SqliteMaintenanceAction
  ): Promise<void> {
    const writes = action === 'vacuum' || action === 'optimize'
    if (writes) {
      const ok = await confirmDestructive({
        connectionId,
        title: action === 'vacuum' ? 'Compactar la base de datos (VACUUM)' : 'Optimizar',
        message:
          action === 'vacuum'
            ? 'VACUUM reescribe el archivo entero para recuperar espacio: puede tardar en archivos grandes y necesita espacio libre en disco.'
            : 'PRAGMA optimize actualiza las estadísticas que usa el planificador de consultas.',
        details: action === 'vacuum' ? 'VACUUM' : 'PRAGMA optimize',
        alwaysAsk: false
      })
      if (!ok) return
    }
    const result = await api.sqlite.maintenance(
      connectionId,
      action,
      writes ? { confirmProduction: true } : undefined
    )
    const titles: Record<SqliteMaintenanceAction, string> = {
      integrityCheck: 'Comprobación de integridad',
      quickCheck: 'Comprobación rápida',
      foreignKeyCheck: 'Comprobación de claves foráneas',
      vacuum: 'VACUUM',
      optimize: 'Optimizar'
    }
    if (writes) {
      notify.success(`${titles[action]} terminado`)
      return
    }
    await ask({
      title: titles[action],
      message: result.ok
        ? action === 'foreignKeyCheck'
          ? 'No hay filas que incumplan las claves foráneas.'
          : 'La base de datos está bien (ok).'
        : 'Se han encontrado problemas:',
      items: result.messages.slice(0, 50).map((m) => ({ text: m })),
      confirmText: 'Cerrar'
    })
  }

  /** «Copiar archivo…»: VACUUM INTO a new file the user picks (a consistent copy). */
  async function copyLiteFile(connectionId: string): Promise<void> {
    const config = connections.get(connectionId)
    const base = (config?.sqlite?.filePath ?? 'copia.db').split(/[\\/]/).pop() ?? 'copia.db'
    const stem = base.replace(/\.[^.]+$/, '')
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
    const target = await api.app.pickSaveFile('Copiar archivo SQLite', `${stem}-${stamp}.db`, [
      { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] }
    ])
    if (!target) return
    const result = await api.sqlite.copyFile(connectionId, target)
    notify.success(`Copia guardada (${Math.max(1, Math.round(result.sizeBytes / 1024))} KB)`)
  }

  /** «Reabrir en modo escritura»: production read-only files need the typed confirmation. */
  async function reopenWritable(connectionId: string): Promise<void> {
    const ok = await confirmDestructive({
      connectionId,
      title: 'Reabrir en modo escritura',
      message:
        'El archivo se volverá a abrir en modo lectura y escritura para esta sesión (la conexión guardada sigue en solo lectura). Se cerrarán las transacciones abiertas.',
      confirmText: 'Reabrir',
      alwaysAsk: true
    })
    if (!ok) return
    const info = await api.sqlite.reopenWritable(connectionId, { confirmProduction: true })
    connections.setServerInfo(connectionId, info)
    notify.success('Archivo abierto en modo escritura')
  }

  /** Extra connection-menu entries of a SQLite connection (file and maintenance). */
  function liteConnectionItems(connectionId: string, open: boolean): MenuAction[] {
    const config = connections.get(connectionId)
    const filePath = config?.sqlite?.filePath ?? ''
    const readOnly = connections.serverInfo[connectionId]?.runtime?.readOnly === true
    const items: MenuAction[] = [
      { key: 'd-lite', label: '', divider: true },
      {
        key: 'showFile',
        label: showInFolderLabel(),
        icon: 'mdi-folder-open-outline',
        disabled: !filePath || config?.sqlite?.pathNeedsReview === true,
        action: () => api.app.showInFolder(filePath)
      },
      {
        key: 'copyFile',
        label: 'Copiar archivo…',
        icon: 'mdi-content-duplicate',
        disabled: !open,
        action: () => copyLiteFile(connectionId)
      },
      {
        key: 'integrity',
        label: 'Comprobar integridad',
        icon: 'mdi-shield-check-outline',
        disabled: !open,
        action: () => liteMaintenance(connectionId, 'integrityCheck')
      },
      {
        key: 'fkCheck',
        label: 'Comprobar claves foráneas',
        icon: 'mdi-key-link',
        disabled: !open,
        action: () => liteMaintenance(connectionId, 'foreignKeyCheck')
      },
      {
        key: 'vacuum',
        label: 'Compactar (VACUUM)',
        icon: 'mdi-archive-arrow-down-outline',
        disabled: !open || readOnly,
        action: () => liteMaintenance(connectionId, 'vacuum')
      }
    ]
    if (open && readOnly)
      items.push({
        key: 'reopenRw',
        label: 'Reabrir en modo escritura…',
        icon: 'mdi-lock-open-variant-outline',
        action: () => reopenWritable(connectionId)
      })
    return items
  }

  function liteNewObjectFor(node: TreeNode): MenuAction[] {
    const c = node.connectionId
    const s = node.schema!
    switch (node.group) {
      case 'tables':
        return [
          {
            key: 'new',
            label: 'Nueva tabla',
            icon: 'mdi-table-plus',
            action: () => ws.openTableDesigner(c, s, null)
          }
        ]
      case 'views':
        return [
          {
            key: 'new',
            label: 'Nueva vista',
            icon: 'mdi-plus',
            action: () => ws.openDdlEditor(c, s, 'view', null)
          }
        ]
      case 'indexes':
        return [
          {
            key: 'new',
            label: 'Nuevo índice',
            icon: 'mdi-plus',
            action: () =>
              ws.openQuery(c, s, {
                sql: `CREATE INDEX ${liteQ('nuevo_indice')} ON ${liteQualified(s, 'tabla')} (columna);`,
                name: 'Nuevo índice'
              })
          }
        ]
      case 'triggers':
        return [
          {
            key: 'new',
            label: 'Nuevo disparador',
            icon: 'mdi-plus',
            action: () => ws.openDdlEditor(c, s, 'trigger', null)
          }
        ]
      case 'queries':
        return [
          {
            key: 'new',
            label: 'Nueva consulta',
            icon: 'mdi-plus',
            action: () => ws.openQuery(c, s)
          }
        ]
      default:
        return []
    }
  }

  /** Context menu of a SQLite database (main / attached) / group / object node. */
  function liteActionsFor(node: TreeNode, refresh: MenuAction): MenuAction[] {
    const c = node.connectionId
    if (node.kind === 'schema') {
      const s = node.schema!
      return [
        {
          key: 'query',
          label: 'Nueva consulta',
          icon: 'mdi-database-search-outline',
          action: () => ws.openQuery(c, s)
        },
        {
          key: 'table',
          label: 'Nueva tabla',
          icon: 'mdi-table-plus',
          action: () => ws.openTableDesigner(c, s, null)
        },
        {
          key: 'backup',
          label: 'Nueva copia de seguridad…',
          icon: 'mdi-archive-plus-outline',
          action: () => ui.openBackupDialog(c, s)
        },
        {
          key: 'backups',
          label: 'Copias de seguridad',
          icon: 'mdi-archive-outline',
          action: () => ws.openBackups(c, s)
        },
        { key: 'd1', label: '', divider: true },
        refresh
      ]
    }
    if (node.kind === 'group')
      return [...liteNewObjectFor(node), { key: 'd1', label: '', divider: true }, refresh]

    const s = node.schema!
    const group = node.group
    const items: MenuAction[] = []
    if (group === 'queries') {
      items.push(
        { key: 'open', label: 'Abrir', icon: 'mdi-open-in-app', action: () => ws.openNode(node) },
        ...liteNewObjectFor({ ...node, kind: 'group' }),
        { key: 'd1', label: '', divider: true },
        {
          key: 'copy',
          label: 'Copiar nombre',
          icon: 'mdi-content-copy',
          action: () => copyText(node.label, 'Nombre')
        },
        {
          key: 'delete',
          label: 'Eliminar',
          icon: 'mdi-delete-outline',
          danger: true,
          action: () => deleteSavedQuery(node)
        },
        { key: 'd2', label: '', divider: true },
        refresh
      )
      return items
    }
    items.push({
      key: 'open',
      label: group === 'indexes' ? 'Ver DDL' : group === 'triggers' ? 'Editar disparador' : 'Abrir',
      icon: 'mdi-open-in-app',
      action: () => ws.openNode(node)
    })
    if (group === 'tables')
      items.push({
        key: 'design',
        label: 'Diseñar tabla',
        icon: 'mdi-table-edit',
        action: () => ws.designNode(node)
      })
    if (group === 'views')
      items.push({
        key: 'design',
        label: 'Editar vista',
        icon: 'mdi-pencil-outline',
        action: () => ws.openDdlEditor(c, s, 'view', node.name!)
      })
    items.push(...liteNewObjectFor({ ...node, kind: 'group' }))
    items.push({ key: 'd1', label: '', divider: true })
    items.push({
      key: 'copy',
      label: 'Copiar nombre',
      icon: 'mdi-content-copy',
      action: () => copyText(liteQ(node.name!), 'Nombre')
    })
    items.push({
      key: 'ddl',
      label: 'Exportar DDL (copiar)',
      icon: 'mdi-code-tags',
      action: () => exportLiteDdl(node)
    })
    if (group === 'tables')
      items.push({
        key: 'empty',
        label: 'Vaciar (DELETE)',
        icon: 'mdi-eraser-variant',
        danger: true,
        action: () => emptyLiteTable(node)
      })
    items.push({
      key: 'delete',
      label: 'Eliminar',
      icon: 'mdi-delete-outline',
      danger: true,
      action: () => dropLiteObject(node)
    })
    items.push({ key: 'd2', label: '', divider: true }, refresh)
    return items
  }

  /* ---------- MongoDB (preview) ---------- */

  const isMongo = (connectionId: string): boolean =>
    connections.get(connectionId)?.engine === 'mongodb'

  /** «db.getCollection('x')» (works for any collection name). */
  const mongoColl = (name: string): string => `db.getCollection(${JSON.stringify(name)})`

  async function dropMongoObject(node: TreeNode): Promise<void> {
    const s = node.schema!
    const name = node.name!
    const index = node.group === 'indexes'
    const item = index
      ? tree.itemsOf(node.connectionId, s, 'indexes').find((o) => o.name === name)
      : null
    const indexName = item?.table ? name.slice(item.table.length + 1) : name
    if (index && indexName === '_id_') return notify.warning('El índice _id_ no se puede eliminar.')
    const what = index ? 'el índice' : node.group === 'views' ? 'la vista' : 'la colección'
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: `Eliminar ${what.replace(/^(el|la) /, '')}`,
      message: `Se eliminará ${what} ${index ? `${item?.table ?? ''}.${indexName}` : `${s}.${name}`} de forma permanente.`,
      confirmText: 'Eliminar',
      destructive: {
        title: `¿Eliminar ${what} «${index ? indexName : name}»?`,
        message: index
          ? 'Las consultas que lo usaban irán más lentas. Esta acción no se puede deshacer.'
          : 'Se borrarán todos sus documentos e índices. Esta acción no se puede deshacer.',
        items: [
          {
            tag: index ? 'dropIndex' : 'drop',
            text: index ? `${item?.table}.${indexName}` : `${s}.${name}`
          }
        ],
        confirmText: 'Eliminar'
      }
    })
    if (!ok) return
    const type = index ? 'index' : node.group === 'views' ? 'view' : 'collection'
    await api.db.dropObject(
      node.connectionId,
      s,
      type,
      index ? { type: 'index', name, table: item?.table } : name,
      { confirmProduction: true }
    )
    notify.success(`${index ? indexName : name} eliminado`)
    await tree.loadGroup(node.connectionId, s, node.group!, true)
    if (!index && tree.hasItems(node.connectionId, s, 'indexes'))
      await tree.loadGroup(node.connectionId, s, 'indexes', true)
  }

  async function clearMongoCollection(node: TreeNode): Promise<void> {
    const s = node.schema!
    const name = node.name!
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: 'Vaciar colección',
      message: `Se borrarán todos los documentos de ${s}.${name} (deleteMany({})); los índices se mantienen.`,
      details: `${mongoColl(name)}.deleteMany({})`,
      confirmText: 'Vaciar',
      destructive: {
        title: `¿Vaciar la colección «${name}»?`,
        message: 'Se borrarán todos sus documentos. Esta acción no se puede deshacer.',
        items: [{ tag: 'deleteMany', text: `${s}.${name}` }],
        confirmText: 'Eliminar'
      }
    })
    if (!ok) return
    const deleted = await api.mongo.clearCollection(node.connectionId, s, name, {
      confirmProduction: true
    })
    notify.success(`${formatCount(deleted)} documento(s) eliminados de ${name}`)
    await tree.loadGroup(node.connectionId, s, 'collections', true)
  }

  async function countMongoCollection(node: TreeNode): Promise<void> {
    const n = await api.mongo.countDocuments(node.connectionId, node.schema!, node.name!)
    notify.info(`«${node.name}»: ${formatCount(n)} documento(s) (recuento exacto)`)
  }

  function formatCount(n: number): string {
    return n.toLocaleString('es-ES')
  }

  function mongoNewObjectFor(node: TreeNode): MenuAction[] {
    const c = node.connectionId
    const s = node.schema!
    switch (node.group) {
      case 'collections':
        return [
          {
            key: 'new',
            label: 'Nueva colección',
            icon: 'mdi-plus',
            action: () => ws.openCollectionDesigner(c, s, null)
          }
        ]
      case 'views':
        return [
          {
            key: 'new',
            label: 'Nueva vista',
            icon: 'mdi-plus',
            action: () =>
              ws.openQuery(c, s, {
                sql: "db.createCollection('nueva_vista', {\n  viewOn: 'coleccion',\n  pipeline: [{ $match: {} }]\n})",
                name: 'Nueva vista'
              })
          }
        ]
      case 'indexes':
        return [
          {
            key: 'new',
            label: 'Nuevo índice',
            icon: 'mdi-plus',
            action: () =>
              ws.openQuery(c, s, {
                sql: "db.getCollection('coleccion').createIndex({ campo: 1 }, { name: 'campo_1' })",
                name: 'Nuevo índice'
              })
          }
        ]
      case 'queries':
        return [
          {
            key: 'new',
            label: 'Nueva consulta',
            icon: 'mdi-plus',
            action: () => ws.openQuery(c, s)
          }
        ]
      default:
        return []
    }
  }

  /** Context menu of a MongoDB database / group / object node. */
  function mongoActionsFor(node: TreeNode, refresh: MenuAction): MenuAction[] {
    const c = node.connectionId
    if (node.kind === 'schema') {
      const s = node.schema!
      return [
        {
          key: 'query',
          label: 'Nueva consulta',
          icon: 'mdi-database-search-outline',
          action: () => ws.openQuery(c, s)
        },
        {
          key: 'collection',
          label: 'Nueva colección',
          icon: 'mdi-file-document-plus-outline',
          action: () => ws.openCollectionDesigner(c, s, null)
        },
        {
          key: 'backup',
          label: 'Nueva copia de seguridad…',
          icon: 'mdi-archive-plus-outline',
          action: () => ui.openBackupDialog(c, s)
        },
        {
          key: 'backups',
          label: 'Copias de seguridad',
          icon: 'mdi-archive-outline',
          action: () => ws.openBackups(c, s)
        },
        { key: 'd1', label: '', divider: true },
        refresh,
        {
          key: 'drop',
          label: 'Eliminar base de datos',
          icon: 'mdi-delete-outline',
          danger: true,
          action: () => dropDatabase(node)
        }
      ]
    }
    if (node.kind === 'group')
      return [...mongoNewObjectFor(node), { key: 'd1', label: '', divider: true }, refresh]

    const s = node.schema!
    const name = node.name!
    const group = node.group
    if (group === 'queries')
      return [
        { key: 'open', label: 'Abrir', icon: 'mdi-open-in-app', action: () => ws.openNode(node) },
        ...mongoNewObjectFor({ ...node, kind: 'group' }),
        { key: 'd1', label: '', divider: true },
        {
          key: 'copy',
          label: 'Copiar nombre',
          icon: 'mdi-content-copy',
          action: () => copyText(node.label, 'Nombre')
        },
        {
          key: 'delete',
          label: 'Eliminar',
          icon: 'mdi-delete-outline',
          danger: true,
          action: () => deleteSavedQuery(node)
        },
        { key: 'd2', label: '', divider: true },
        refresh
      ]
    const items: MenuAction[] = []
    if (group === 'indexes') {
      items.push(
        {
          key: 'open',
          label: 'Ver en el diseñador',
          icon: 'mdi-open-in-app',
          action: () => ws.openNode(node)
        },
        ...mongoNewObjectFor({ ...node, kind: 'group' }),
        { key: 'd1', label: '', divider: true },
        {
          key: 'copy',
          label: 'Copiar nombre',
          icon: 'mdi-content-copy',
          action: () => copyText(node.label, 'Nombre')
        }
      )
    } else {
      items.push(
        {
          key: 'open',
          label: 'Abrir documentos',
          icon: 'mdi-open-in-app',
          action: () => ws.openNode(node)
        },
        ...(group === 'collections'
          ? [
              {
                key: 'design',
                label: 'Diseñar (índices y validador)',
                icon: 'mdi-file-document-edit-outline',
                action: () => ws.designNode(node)
              }
            ]
          : []),
        {
          key: 'query',
          label: 'Nueva consulta',
          icon: 'mdi-database-search-outline',
          action: () => ws.openQuery(c, s, { sql: `${mongoColl(name)}.find({})`, name })
        },
        ...mongoNewObjectFor({ ...node, kind: 'group' }),
        { key: 'd1', label: '', divider: true },
        {
          key: 'copy',
          label: 'Copiar nombre',
          icon: 'mdi-content-copy',
          action: () => copyText(name, 'Nombre')
        },
        {
          key: 'duplicate',
          label: 'Duplicar…',
          icon: 'mdi-content-duplicate',
          action: () => ui.openDuplicateCollection(c, s, name, group === 'views')
        }
      )
      if (group === 'collections')
        items.push(
          {
            key: 'count',
            label: 'Contar exacto',
            icon: 'mdi-counter',
            action: () => countMongoCollection(node)
          },
          {
            key: 'rename',
            label: 'Renombrar…',
            icon: 'mdi-rename-outline',
            action: () => ws.openCollectionDesigner(c, s, name, 'options')
          },
          {
            key: 'empty',
            label: 'Vaciar (deleteMany)',
            icon: 'mdi-eraser-variant',
            danger: true,
            action: () => clearMongoCollection(node)
          }
        )
    }
    items.push(
      {
        key: 'delete',
        label: 'Eliminar',
        icon: 'mdi-delete-outline',
        danger: true,
        action: () => dropMongoObject(node)
      },
      { key: 'd2', label: '', divider: true },
      refresh
    )
    return items
  }

  async function deleteSavedQuery(node: TreeNode): Promise<void> {
    if (!node.name) return
    const ok = await ask({
      title: 'Eliminar consulta',
      message: `Se eliminará la consulta guardada "${node.label}".`,
      confirmText: 'Eliminar',
      color: 'warning'
    })
    if (!ok) return
    queries.remove(node.connectionId, node.name)
    tabs.close(`query:${node.connectionId}:${node.name}`)
  }

  async function closeConnection(connectionId: string): Promise<void> {
    const dirty = tabs.tabs.filter((t) => t.connectionId === connectionId && t.dirty)
    if (dirty.length) {
      const ok = await ask({
        title: 'Cerrar conexión',
        message: `Hay ${dirty.length} pestaña(s) con cambios sin guardar. ¿Cerrar de todos modos?`,
        confirmText: 'Cerrar',
        color: 'warning'
      })
      if (!ok) return
    }
    await connections.close(connectionId)
    tabs.closeForConnection(connectionId)
    tree.forget(connectionId)
  }

  async function deleteConnection(connectionId: string): Promise<void> {
    const dirty = tabs.tabs.filter((t) => t.connectionId === connectionId && t.dirty).length
    const unsaved = dirty
      ? `\n\nHay ${dirty} pestaña(s) de esta conexión con cambios sin guardar que se perderán.`
      : ''
    const ok = await ask({
      title: 'Eliminar conexión',
      message: `Se eliminará la conexión "${connections.nameOf(connectionId)}" y su contraseña guardada.${unsaved}`,
      confirmText: 'Eliminar',
      color: 'error'
    })
    if (!ok) return
    tabs.closeForConnection(connectionId)
    tree.forget(connectionId)
    await connections.remove(connectionId)
    if (tree.selectedId === nodeIds.connection(connectionId)) tree.select(null)
    notify.success('Conexión eliminada')
  }

  async function dropDatabase(node: TreeNode): Promise<void> {
    if (node.kind === 'database' && node.database !== undefined) {
      const name = node.database
      const ok = await confirmDestructive({
        connectionId: node.connectionId,
        title: 'Eliminar base de datos',
        message: `Se eliminará la base de datos ${name} con todos sus esquemas, objetos y datos.`,
        details: `DROP DATABASE ${pgQ(name)}`,
        confirmText: 'Eliminar base de datos',
        destructive: {
          title: `¿Eliminar la base de datos «${name}»?`,
          message:
            'Se eliminarán todos sus esquemas, tablas y datos. Esta acción no se puede deshacer.',
          items: [{ tag: 'DROP DATABASE', text: name }],
          confirmText: 'Eliminar'
        }
      })
      if (!ok) return
      await api.db.dropDatabase(node.connectionId, name, { confirmProduction: true })
      notify.success(`Base de datos ${name} eliminada`)
      tree.forget(node.connectionId)
      await tree.loadDatabases(node.connectionId, true)
      return
    }
    if (!node.schema) return
    const ok = await confirmDestructive({
      connectionId: node.connectionId,
      title: 'Eliminar base de datos',
      message: `Se eliminará la base de datos ${node.schema} con todos sus objetos y datos.`,
      details: `DROP DATABASE \`${node.schema}\``,
      confirmText: 'Eliminar base de datos',
      destructive: {
        title: `¿Eliminar la base de datos «${node.schema}»?`,
        message:
          'Se eliminarán todas sus tablas, vistas, rutinas, eventos y datos. Esta acción no se puede deshacer.',
        items: [{ tag: 'DROP DATABASE', text: qualified(null, node.schema) }],
        confirmText: 'Eliminar'
      }
    })
    if (!ok) return
    await api.db.dropDatabase(node.connectionId, node.schema, { confirmProduction: true })
    notify.success(`Base de datos ${node.schema} eliminada`)
    tree.forget(node.connectionId)
    await tree.loadDatabases(node.connectionId, true)
  }

  function newObjectFor(node: TreeNode): MenuAction[] {
    const c = node.connectionId
    const s = node.schema!
    const caps = capsOf(c)
    switch (node.group) {
      case 'tables':
        return [
          {
            key: 'new',
            label: 'Nueva tabla',
            icon: 'mdi-table-plus',
            action: () => ws.openTableDesigner(c, s, null)
          }
        ]
      case 'views':
        return [
          {
            key: 'new',
            label: 'Nueva vista',
            icon: 'mdi-plus',
            action: () => ws.openDdlEditor(c, s, 'view', null)
          }
        ]
      case 'functions':
        return [
          {
            key: 'newf',
            label: 'Nueva función',
            icon: 'mdi-plus',
            action: () => ws.openDdlEditor(c, s, 'function', null)
          },
          {
            key: 'newp',
            label: 'Nuevo procedimiento',
            icon: 'mdi-plus',
            action: () => ws.openDdlEditor(c, s, 'procedure', null)
          }
        ]
      case 'events':
        if (!caps.events) return []
        return [
          {
            key: 'new',
            label: 'Nuevo evento',
            icon: 'mdi-plus',
            action: () => ws.openDdlEditor(c, s, 'event', null)
          }
        ]
      case 'queries':
        return [
          {
            key: 'new',
            label: 'Nueva consulta',
            icon: 'mdi-plus',
            action: () => ws.openQuery(c, s)
          }
        ]
      case 'sequences':
        // MariaDB (the only MySQL-family engine with sequences).
        if (!caps.sequences) return []
        return [
          {
            key: 'new',
            label: 'Nueva secuencia',
            icon: 'mdi-plus',
            action: () =>
              ws.openQuery(c, s, {
                sql: `CREATE SEQUENCE ${qualified(s, 'nueva_secuencia')}\n  START WITH 1 INCREMENT BY 1;`,
                name: 'Nueva secuencia'
              })
          }
        ]
      case 'backups':
        if (!caps.supportsBackupsNb3) return []
        return [
          {
            key: 'new',
            label: 'Nueva copia de seguridad…',
            icon: 'mdi-plus',
            action: () => ui.openBackupDialog(c, s)
          }
        ]
      default:
        return []
    }
  }

  function actionsFor(node: TreeNode): MenuAction[] {
    const c = node.connectionId
    const refresh: MenuAction = {
      key: 'refresh',
      label: 'Actualizar',
      icon: 'mdi-refresh',
      action: () => tree.refresh(node)
    }
    const caps = capsOf(c)
    if (node.kind !== 'connection' && node.database !== undefined)
      return pgActionsFor(node, refresh)
    if (node.kind !== 'connection' && isLite(c)) return liteActionsFor(node, refresh)
    if (node.kind !== 'connection' && isMongo(c)) return mongoActionsFor(node, refresh)
    if (node.kind === 'connection') {
      const open = connections.isOpen(c)
      const items: (MenuAction | false)[] = [
        open
          ? {
              key: 'close',
              label: 'Cerrar conexión',
              icon: 'mdi-lan-disconnect',
              action: () => closeConnection(c)
            }
          : {
              key: 'open',
              label: 'Abrir conexión',
              icon: 'mdi-lan-connect',
              action: async () => {
                await ws.ensureOpen(c)
              }
            },
        {
          key: 'edit',
          label: 'Editar conexión…',
          icon: 'mdi-pencil-outline',
          action: () => ui.openConnectionDialog(connections.get(c) ?? null)
        },
        // PostgreSQL and MongoDB only (MySQL menus unchanged): the URI never contains the password.
        (connections.get(c)?.engine === 'postgresql' || isMongo(c)) && {
          key: 'copyUri',
          label: 'Copiar URI',
          icon: 'mdi-link-variant',
          action: () => {
            const config = connections.get(c)
            const uri = config ? connectionUri(config) : null
            if (uri) void copyText(uri, 'URI')
          }
        },
        { key: 'd1', label: '', divider: true },
        {
          key: 'query',
          label: 'Nueva consulta',
          icon: 'mdi-database-search-outline',
          disabled: !open,
          action: () => ws.openQuery(c, null)
        },
        !!caps.createDatabase && {
          key: 'newdb',
          label: 'Nueva base de datos…',
          icon: 'mdi-database-plus',
          disabled: !open,
          action: () => ui.openNewDatabaseDialog(c)
        },
        !!(caps.supportsBackupsNb3 || caps.supportsBackupsVqb) && {
          key: 'backups',
          label: 'Copias de seguridad',
          icon: 'mdi-archive-outline',
          action: () => ws.openBackups(c, null)
        },
        !!caps.hasUsers && {
          key: 'users',
          label: 'Usuarios',
          icon: 'mdi-account-multiple-outline',
          disabled: !open,
          action: () => ws.openUsers(c)
        },
        ...(isLite(c) ? liteConnectionItems(c, open) : []),
        { key: 'd2', label: '', divider: true },
        { ...refresh, disabled: !open },
        {
          key: 'delete',
          label: 'Eliminar conexión',
          icon: 'mdi-delete-outline',
          danger: true,
          action: () => deleteConnection(c)
        }
      ]
      return items.filter((a): a is MenuAction => !!a)
    }
    if (node.kind === 'schema') {
      const s = node.schema!
      const items: (MenuAction | false)[] = [
        {
          key: 'query',
          label: 'Nueva consulta',
          icon: 'mdi-database-search-outline',
          action: () => ws.openQuery(c, s)
        },
        caps.designer === 'table' && {
          key: 'table',
          label: 'Nueva tabla',
          icon: 'mdi-table-plus',
          action: () => ws.openTableDesigner(c, s, null)
        },
        !!caps.supportsBackupsNb3 && {
          key: 'backup',
          label: 'Nueva copia de seguridad…',
          icon: 'mdi-archive-plus-outline',
          action: () => ui.openBackupDialog(c, s)
        },
        !!caps.supportsBackupsNb3 && {
          key: 'backups',
          label: 'Copias de seguridad',
          icon: 'mdi-archive-outline',
          action: () => ws.openBackups(c, s)
        },
        { key: 'd1', label: '', divider: true },
        refresh,
        {
          key: 'drop',
          label: 'Eliminar base de datos',
          icon: 'mdi-delete-outline',
          danger: true,
          action: () => dropDatabase(node)
        }
      ]
      return items.filter((a): a is MenuAction => !!a)
    }
    if (node.kind === 'group')
      return [...newObjectFor(node), { key: 'd1', label: '', divider: true }, refresh]

    const isTable = node.group === 'tables'
    const isQuery = node.group === 'queries'
    const isBackup = node.group === 'backups'
    const items: MenuAction[] = [
      {
        key: 'open',
        label: isBackup ? 'Ver copias de seguridad' : 'Abrir',
        icon: 'mdi-open-in-app',
        action: () => ws.openNode(node)
      }
    ]
    if (isTable && caps.designer === 'table')
      items.push({
        key: 'design',
        label: 'Diseñar tabla',
        icon: 'mdi-table-edit',
        action: () => ws.designNode(node)
      })
    if (node.group === 'sequences') items.push(...mariaDbSequenceItems(node))
    items.push(...newObjectFor({ ...node, kind: 'group' }))
    items.push({ key: 'd1', label: '', divider: true })
    if (isBackup) {
      items.push({
        key: 'restore',
        label: 'Restaurar…',
        icon: 'mdi-backup-restore',
        action: () => openRestore(node)
      })
      items.push({
        key: 'finder',
        label: 'Mostrar en Finder',
        icon: 'mdi-folder-open-outline',
        action: () => api.app.showInFolder(node.name!)
      })
    } else {
      items.push({
        key: 'copy',
        label: 'Copiar nombre',
        icon: 'mdi-content-copy',
        action: () => copyText(node.label, 'Nombre')
      })
      if (!isQuery)
        items.push({
          key: 'ddl',
          label: 'Exportar DDL (copiar)',
          icon: 'mdi-code-tags',
          action: () => exportDdl(node)
        })
      if (isTable && caps.truncate)
        items.push({
          key: 'truncate',
          label: 'Truncar tabla',
          icon: 'mdi-eraser',
          danger: true,
          action: () => truncateTable(node)
        })
      items.push({
        key: 'delete',
        label: 'Eliminar',
        icon: 'mdi-delete-outline',
        danger: true,
        action: () => (isQuery ? deleteSavedQuery(node) : dropObject(node))
      })
    }
    items.push({ key: 'd2', label: '', divider: true }, refresh)
    return items
  }

  function openRestore(node: TreeNode): void {
    const file = tree
      .itemsOf(node.connectionId, node.schema!, 'backups')
      .find((b) => b.path === node.name)
    if (file) ui.openRestoreDialog(file, node.connectionId)
  }

  return {
    actionsFor,
    copyText,
    dropObject,
    truncateTable,
    exportDdl,
    deleteSavedQuery,
    closeConnection,
    deleteConnection,
    dropDatabase
  }
}
