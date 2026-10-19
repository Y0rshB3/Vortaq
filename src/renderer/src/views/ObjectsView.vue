<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DatabaseInfo, SchemaInfo } from '@shared/types'
import type { WorkspaceTab } from '@renderer/stores/tabs'
import { useConnectionsStore } from '@renderer/stores/connections'
import { nodeIds, useTreeStore, type TreeNode } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import { useWorkspace } from '@renderer/composables/useWorkspace'
import { useObjectActions, type MenuAction } from '@renderer/composables/useObjectActions'
import { useObjectsContext } from '@renderer/composables/useObjectsContext'
import {
  DATABASE_COLUMNS,
  GROUP_SINGULAR,
  SCHEMA_COLUMNS,
  columnsFor,
  filterItems,
  itemLabel,
  itemName
} from '@renderer/utils/objectColumns'
import { GROUP_ICONS, GROUP_LABELS, type GroupKind } from '@renderer/utils/objectTypes'
import DataListTable from '@renderer/components/common/DataListTable.vue'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import ContextMenu from '@renderer/components/common/ContextMenu.vue'
import { runSafely } from '@renderer/utils/errors'

defineProps<{ tab: WorkspaceTab }>()

const tree = useTreeStore()
const connections = useConnectionsStore()
const ui = useUiStore()
const ws = useWorkspace()
const { actionsFor } = useObjectActions()
const { context, connectionOpen, databases, schemas, items } = useObjectsContext()

const search = ref('')
const selectedDb = ref<string | null>(null)
const menu = ref<InstanceType<typeof ContextMenu> | null>(null)

const group = computed(() => context.value?.group ?? null)
/** PostgreSQL database of the selection (undefined on MySQL). */
const database = computed(() => context.value?.database)
const isDatabaseList = computed(() => !!context.value && !group.value)
/** PostgreSQL: a database node lists its schemas instead of databases. */
const isSchemaList = computed(() => isDatabaseList.value && database.value !== undefined)
const engine = computed(() =>
  context.value ? connections.get(context.value.connectionId)?.engine : undefined
)

/**
 * Database/schema «Diagrama» and «Consulta gráfica» open on: the one listed,
 * or the selected row of a database (MySQL, SQLite) or schema (PostgreSQL) list.
 */
const diagramTarget = computed(() => {
  const ctx = context.value
  if (!ctx || !connectionOpen.value || !engine.value || engine.value === 'mongodb') return null
  if (ctx.schema)
    return { connectionId: ctx.connectionId, schema: ctx.schema, database: ctx.database }
  if (!isDatabaseList.value || !selectedDb.value) return null
  if (isSchemaList.value)
    return { connectionId: ctx.connectionId, schema: selectedDb.value, database: ctx.database }
  if (tree.hasDatabaseLevel(ctx.connectionId)) return null
  return { connectionId: ctx.connectionId, schema: selectedDb.value, database: undefined }
})
function openDiagram(builder: boolean): void {
  const t = diagramTarget.value
  if (!t) return
  if (builder) ws.openQueryBuilder(t.connectionId, t.schema, t.database)
  else ws.openDiagram(t.connectionId, t.schema, t.database)
}

/** Tree node id that drives loading/error state for the current list. */
const listNodeId = computed(() => {
  const ctx = context.value
  if (!ctx) return null
  if (!ctx.group || !ctx.schema)
    return ctx.database !== undefined
      ? nodeIds.database(ctx.connectionId, ctx.database)
      : nodeIds.connection(ctx.connectionId)
  return nodeIds.group(ctx.connectionId, ctx.schema, ctx.group, ctx.database)
})
const loading = computed(() => {
  const id = listNodeId.value
  if (!id) return false
  return (
    !!tree.loading[id] || (!!context.value && !!connections.opening[context.value.connectionId])
  )
})
const error = computed(() => (listNodeId.value ? tree.errors[listNodeId.value] : undefined))

const columns = computed(() =>
  group.value
    ? columnsFor(group.value, engine.value)
    : isSchemaList.value
      ? SCHEMA_COLUMNS
      : DATABASE_COLUMNS
)
const rows = computed<unknown[]>(() =>
  isSchemaList.value
    ? filterItems<SchemaInfo>(schemas.value, null, search.value)
    : isDatabaseList.value
      ? filterItems<DatabaseInfo>(databases.value, null, search.value)
      : filterItems(items.value, group.value, search.value)
)

const selectedKey = computed(() =>
  isDatabaseList.value ? selectedDb.value : (context.value?.objectName ?? null)
)

function rowKey(item: unknown): string {
  return group.value ? itemName(group.value, item) : (item as DatabaseInfo).name
}

function rowIcon(item: unknown): string {
  if (isSchemaList.value) return 'mdi-folder-outline'
  if (!group.value) return 'mdi-database-outline'
  if (group.value === 'functions')
    return (item as { type?: string }).type === 'PROCEDURE'
      ? 'mdi-script-text-outline'
      : 'mdi-function-variant'
  return GROUP_ICONS[group.value]
}

function objectNode(item: unknown): TreeNode | null {
  const ctx = context.value
  if (!ctx || !ctx.schema || !ctx.group) return null
  const node = tree.parse(
    nodeIds.object(ctx.connectionId, ctx.schema, ctx.group, itemName(ctx.group, item), ctx.database)
  )
  if (!node) return null
  node.label = itemLabel(ctx.group, item)
  node.subtype = (item as { type?: string }).type
  return node
}

const groupNode = computed<TreeNode | null>(() => {
  const ctx = context.value
  if (!ctx || !ctx.schema || !ctx.group) return null
  return tree.parse(nodeIds.group(ctx.connectionId, ctx.schema, ctx.group, ctx.database))
})

const selectedItem = computed(() => {
  const key = context.value?.objectName
  return key && group.value
    ? (items.value.find((i) => itemName(group.value!, i) === key) ?? null)
    : null
})
const selectedNode = computed(() => (selectedItem.value ? objectNode(selectedItem.value) : null))

// Load the list lazily whenever the context changes (cached by the tree store).
watch(
  () =>
    [
      context.value?.connectionId,
      context.value?.schema,
      context.value?.group,
      connectionOpen.value,
      context.value?.database
    ] as const,
  ([connectionId, schema, g, open, db]) => {
    selectedDb.value = null
    if (!connectionId || !open) return
    if (schema && g) void tree.loadGroup(connectionId, schema, g, false, db)
    else if (db !== undefined) void tree.loadSchemas(connectionId, db)
    else void tree.loadDatabases(connectionId)
  },
  { immediate: true }
)

function onSelect(item: unknown): void {
  if (isDatabaseList.value) {
    selectedDb.value = (item as DatabaseInfo).name
    return
  }
  const node = objectNode(item)
  if (node) tree.select(node.id)
}

async function onOpen(item: unknown): Promise<void> {
  if (isSchemaList.value) {
    const ctx = context.value!
    const schema = (item as SchemaInfo).name
    tree.setExpanded(nodeIds.database(ctx.connectionId, ctx.database!), true)
    tree.setExpanded(nodeIds.schema(ctx.connectionId, schema, ctx.database), true)
    tree.select(nodeIds.schema(ctx.connectionId, schema, ctx.database))
    return
  }
  if (isDatabaseList.value) {
    const ctx = context.value!
    const name = (item as DatabaseInfo).name
    tree.setExpanded(nodeIds.connection(ctx.connectionId), true)
    if (tree.hasDatabaseLevel(ctx.connectionId)) {
      const node = tree.parse(nodeIds.database(ctx.connectionId, name))
      if (node) {
        tree.select(node.id)
        await tree.expand(node)
      }
      return
    }
    tree.setExpanded(nodeIds.schema(ctx.connectionId, name), true)
    tree.select(nodeIds.schema(ctx.connectionId, name))
    return
  }
  const node = objectNode(item)
  if (node) await ws.openNode(node)
}

function onContextMenu(event: MouseEvent, item: unknown): void {
  if (isDatabaseList.value) {
    const ctx = context.value!
    const name = (item as DatabaseInfo | SchemaInfo).name
    const node = tree.parse(
      isSchemaList.value
        ? nodeIds.schema(ctx.connectionId, name, ctx.database)
        : tree.hasDatabaseLevel(ctx.connectionId)
          ? nodeIds.database(ctx.connectionId, name)
          : nodeIds.schema(ctx.connectionId, name)
    )
    if (node) menu.value?.show(event, actionsFor(node))
    return
  }
  const node = objectNode(item)
  if (node) menu.value?.show(event, actionsFor(node))
}

function onBackgroundContextMenu(event: MouseEvent): void {
  if (groupNode.value) menu.value?.show(event, actionsFor(groupNode.value))
  else if (context.value) {
    const node = tree.parse(nodeIds.connection(context.value.connectionId))
    if (node) menu.value?.show(event, actionsFor(node))
  }
}

/* ---------- Sub-toolbar ---------- */

const noun = computed(() =>
  group.value ? GROUP_SINGULAR[group.value] : isSchemaList.value ? 'esquema' : 'base de datos'
)

/* "Nuevo/Nueva" must agree with the noun's gender (Spanish UI). */
const NEW_LABELS: Record<GroupKind, string> = {
  tables: 'Nueva tabla',
  views: 'Nueva vista',
  functions: 'Nueva función',
  events: 'Nuevo evento',
  queries: 'Nueva consulta',
  backups: 'Nueva copia de seguridad',
  materializedViews: 'Nueva vista materializada',
  sequences: 'Nueva secuencia',
  types: 'Nuevo tipo',
  indexes: 'Nuevo índice',
  triggers: 'Nuevo disparador',
  collections: 'Nueva colección'
}
const newLabel = computed(() => (group.value ? NEW_LABELS[group.value] : 'Nueva base de datos'))

const newActions = computed<MenuAction[]>(() => {
  if (groupNode.value) return actionsFor(groupNode.value).filter((a) => a.key.startsWith('new'))
  if (isDatabaseList.value && context.value)
    return [
      {
        key: 'newdb',
        label: 'Nueva base de datos…',
        icon: 'mdi-database-plus',
        action: () => ui.openNewDatabaseDialog(context.value!.connectionId)
      }
    ]
  return []
})

function findAction(node: TreeNode | null, key: string): MenuAction | undefined {
  return node ? actionsFor(node).find((a) => a.key === key) : undefined
}

const deleteAction = computed(() => {
  if (isSchemaList.value) return undefined
  if (isDatabaseList.value && selectedDb.value && context.value) {
    const cid = context.value.connectionId
    return findAction(
      tree.parse(
        tree.hasDatabaseLevel(cid)
          ? nodeIds.database(cid, selectedDb.value)
          : nodeIds.schema(cid, selectedDb.value)
      ),
      'drop'
    )
  }
  return findAction(selectedNode.value, 'delete')
})

const canOpen = computed(() => (isDatabaseList.value ? !!selectedDb.value : !!selectedItem.value))
const canDesign = computed(
  () => !!selectedNode.value && group.value !== 'backups' && group.value !== 'queries'
)

function openSelected(): void {
  if (isSchemaList.value) {
    const s = schemas.value.find((x) => x.name === selectedDb.value)
    if (s) void runSafely(() => onOpen(s))
  } else if (isDatabaseList.value) {
    const db = databases.value.find((d) => d.name === selectedDb.value)
    if (db) void runSafely(() => onOpen(db))
  } else if (selectedItem.value) {
    const item = selectedItem.value
    void runSafely(() => onOpen(item))
  }
}

function designSelected(): void {
  if (selectedNode.value) ws.designNode(selectedNode.value)
}

function refresh(): void {
  const ctx = context.value
  if (!ctx || !connectionOpen.value) return
  if (groupNode.value) void tree.refresh(groupNode.value)
  else if (ctx.database !== undefined) void tree.loadSchemas(ctx.connectionId, ctx.database, true)
  else void tree.loadDatabases(ctx.connectionId, true)
}

function retry(): void {
  const ctx = context.value
  if (!ctx) return
  if (!connectionOpen.value) void ws.ensureOpen(ctx.connectionId)
  else refresh()
}

/** Breadcrumb pieces for the header line: connection › schema › group. */
const crumbs = computed(() => {
  const ctx = context.value
  if (!ctx) return null
  return {
    connection: connections.nameOf(ctx.connectionId),
    color: connections.get(ctx.connectionId)?.color ?? null,
    schema: ctx.group
      ? ctx.database !== undefined
        ? `${ctx.database}.${ctx.schema}`
        : ctx.schema
      : ctx.database !== undefined
        ? ctx.database
        : null,
    group: ctx.group
      ? GROUP_LABELS[ctx.group]
      : ctx.database !== undefined
        ? 'Esquemas'
        : 'Bases de datos'
  }
})

const title = computed(() => {
  const ctx = context.value
  if (!ctx) return ''
  const conn = connections.nameOf(ctx.connectionId)
  if (!ctx.group) return ctx.database !== undefined ? `${ctx.database} (${conn})` : conn
  const where = ctx.database !== undefined ? `${ctx.database}.${ctx.schema}` : ctx.schema
  return `${GROUP_LABELS[ctx.group]} · ${where} (${conn})`
})
</script>

<template>
  <section class="objects-view" aria-label="Objetos">
    <div class="objects-view__toolbar" role="toolbar" aria-label="Acciones de objetos">
      <v-btn
        size="small"
        variant="text"
        prepend-icon="mdi-open-in-app"
        :disabled="!canOpen"
        data-test="objects-open"
        @click="openSelected"
      >
        Abrir {{ noun }}
      </v-btn>
      <v-btn
        v-if="group !== 'backups' && !isDatabaseList"
        size="small"
        variant="text"
        prepend-icon="mdi-pencil-ruler"
        :disabled="!canDesign"
        data-test="objects-design"
        @click="designSelected"
      >
        Diseñar {{ noun }}
      </v-btn>
      <v-menu v-if="newActions.length > 1">
        <template #activator="{ props: mp }">
          <v-btn
            v-bind="mp"
            size="small"
            color="primary"
            variant="tonal"
            prepend-icon="mdi-plus"
            append-icon="mdi-menu-down"
            data-test="objects-new"
            >Nuevo</v-btn
          >
        </template>
        <v-list density="compact">
          <v-list-item
            v-for="a in newActions"
            :key="a.key"
            :prepend-icon="a.icon"
            :title="a.label"
            @click="runSafely(a.action)"
          />
        </v-list>
      </v-menu>
      <v-btn
        v-else
        size="small"
        color="primary"
        variant="tonal"
        prepend-icon="mdi-plus"
        :disabled="!newActions.length"
        data-test="objects-new"
        @click="runSafely(newActions[0]?.action)"
      >
        {{ newLabel }}
      </v-btn>
      <v-btn
        size="small"
        variant="text"
        class="objects-view__delete"
        prepend-icon="mdi-delete-outline"
        :disabled="!deleteAction"
        data-test="objects-delete"
        @click="runSafely(deleteAction?.action)"
      >
        Eliminar {{ noun }}
      </v-btn>
      <span class="objects-view__divider" aria-hidden="true" />
      <v-btn
        size="small"
        variant="text"
        icon="mdi-refresh"
        :disabled="!context || !connectionOpen"
        aria-label="Actualizar"
        title="Actualizar"
        data-test="objects-refresh"
        @click="refresh"
      />
      <span class="objects-view__divider" aria-hidden="true" />
      <v-btn
        size="small"
        variant="text"
        prepend-icon="mdi-sitemap-outline"
        :disabled="!diagramTarget"
        :title="
          diagramTarget
            ? `Diagrama de relaciones de ${diagramTarget.schema}`
            : 'Selecciona una base de datos o un esquema'
        "
        data-test="objects-diagram"
        @click="openDiagram(false)"
        >Diagrama</v-btn
      >
      <v-btn
        size="small"
        variant="text"
        prepend-icon="mdi-vector-link"
        :disabled="!diagramTarget"
        :title="
          diagramTarget
            ? `Consulta gráfica sobre ${diagramTarget.schema}`
            : 'Selecciona una base de datos o un esquema'
        "
        data-test="objects-query-builder"
        @click="openDiagram(true)"
        >Consulta gráfica</v-btn
      >
      <v-spacer />
      <v-btn-toggle
        v-model="ui.objectsViewMode"
        mandatory
        density="compact"
        variant="text"
        class="objects-view__mode"
        aria-label="Modo de vista"
      >
        <v-btn value="list" icon="mdi-view-list" size="small" aria-label="Lista" title="Lista" />
        <v-btn
          value="grid"
          icon="mdi-view-grid-outline"
          size="small"
          aria-label="Iconos"
          title="Iconos"
        />
      </v-btn-toggle>
      <v-text-field
        v-model="search"
        class="objects-view__search"
        density="compact"
        variant="outlined"
        placeholder="Buscar"
        prepend-inner-icon="mdi-magnify"
        clearable
        hide-details
        aria-label="Buscar objetos"
        data-test="objects-search"
      />
    </div>

    <div v-if="crumbs" class="objects-view__title" :title="title">
      <span
        class="objects-view__crumb-dot"
        :class="{ 'objects-view__crumb-dot--none': !crumbs.color }"
        :style="{
          background: crumbs.color ?? 'transparent',
          '--nd-dot': crumbs.color ?? 'transparent'
        }"
        aria-hidden="true"
      />
      <span class="objects-view__crumb">{{ crumbs.connection }}</span>
      <template v-if="crumbs.schema">
        <v-icon icon="mdi-chevron-right" size="13" class="objects-view__crumb-sep" />
        <span class="objects-view__crumb">{{ crumbs.schema }}</span>
      </template>
      <v-icon icon="mdi-chevron-right" size="13" class="objects-view__crumb-sep" />
      <span class="objects-view__crumb objects-view__crumb--current">{{ crumbs.group }}</span>
      <span v-if="!loading && connectionOpen" class="objects-view__count nd-mono">{{
        rows.length
      }}</span>
    </div>
    <div class="objects-view__loading">
      <v-progress-linear v-if="loading" indeterminate color="primary" height="2" />
    </div>

    <div class="objects-view__body" @contextmenu.self.prevent="onBackgroundContextMenu">
      <EmptyState
        v-if="connections.loaded && connections.items.length === 0"
        icon="mdi-database-import-outline"
        title="Importa tus conexiones"
        description="Trae tus conexiones desde Navicat, DBeaver o MySQL Workbench, o restaura un archivo .sql o una copia .nb3."
        data-test="objects-empty-connections"
      >
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-import"
          data-test="objects-import-cta"
          @click="ui.openImportWizard()"
          >Importar…</v-btn
        >
        <v-btn variant="text" @click="ui.openConnectionDialog(null)">Nueva conexión</v-btn>
      </EmptyState>
      <EmptyState
        v-else-if="!context"
        icon="mdi-cursor-default-click-outline"
        title="Selecciona una conexión"
        description="Elige una conexión, base de datos o grupo en Mis Conexiones para ver sus objetos."
      >
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-plus"
          @click="ui.openConnectionDialog(null)"
          >Nueva conexión</v-btn
        >
        <v-btn variant="text" prepend-icon="mdi-import" @click="ui.openImportWizard()"
          >Importar…</v-btn
        >
      </EmptyState>
      <EmptyState
        v-else-if="!connectionOpen && !loading"
        icon="mdi-lan-disconnect"
        title="Conexión cerrada"
        description="Abre la conexión para ver sus bases de datos y objetos."
      >
        <v-btn
          color="primary"
          variant="tonal"
          prepend-icon="mdi-lan-connect"
          data-test="objects-connect"
          @click="ws.ensureOpen(context.connectionId)"
          >Abrir conexión</v-btn
        >
      </EmptyState>
      <EmptyState
        v-else-if="error"
        icon="mdi-alert-circle-outline"
        title="No se pudieron cargar los objetos"
        :description="error"
      >
        <v-btn variant="tonal" prepend-icon="mdi-refresh" @click="retry">Reintentar</v-btn>
      </EmptyState>
      <EmptyState
        v-else-if="!loading && rows.length === 0"
        :icon="group ? GROUP_ICONS[group] : 'mdi-database-off-outline'"
        :title="
          search
            ? 'Sin resultados'
            : `No hay ${group ? GROUP_LABELS[group].toLowerCase() : 'bases de datos'}`
        "
        :description="search ? `Ningún objeto coincide con “${search}”.` : undefined"
      >
        <v-btn
          v-if="!search && newActions.length"
          variant="tonal"
          prepend-icon="mdi-plus"
          @click="runSafely(newActions[0].action)"
          >{{ newActions[0].label }}</v-btn
        >
      </EmptyState>
      <DataListTable
        v-else-if="ui.objectsViewMode === 'list'"
        :columns="columns"
        :items="rows"
        :row-key="rowKey"
        :selected-key="selectedKey"
        :icon="rowIcon"
        :label="title"
        @select="onSelect"
        @open="onOpen"
        @contextmenu="onContextMenu"
      />
      <div
        v-else
        class="objects-view__grid"
        role="listbox"
        :aria-label="title"
        @contextmenu.self.prevent="onBackgroundContextMenu"
      >
        <div
          v-for="item in rows"
          :key="rowKey(item)"
          class="objects-view__tile"
          :class="{ 'objects-view__tile--selected': rowKey(item) === selectedKey }"
          role="option"
          :aria-selected="rowKey(item) === selectedKey"
          tabindex="0"
          data-test="objects-tile"
          @click="onSelect(item)"
          @dblclick="onOpen(item)"
          @keydown.enter.prevent="onOpen(item)"
          @contextmenu.prevent="(onSelect(item), onContextMenu($event, item))"
        >
          <span class="objects-view__tile-icon" aria-hidden="true">
            <v-icon :icon="rowIcon(item)" size="22" />
          </span>
          <span
            class="objects-view__tile-label"
            :title="group ? itemLabel(group, item) : rowKey(item)"
            >{{ group ? itemLabel(group, item) : rowKey(item) }}</span
          >
        </div>
      </div>
    </div>
    <ContextMenu ref="menu" />
  </section>
</template>

<style scoped>
.objects-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.objects-view__toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 46px;
  padding: 0 10px 0 8px;
  border-bottom: 1px solid var(--nd-hairline);
  flex: none;
  flex-wrap: nowrap;
  overflow: hidden;
}
.objects-view__toolbar > .v-btn {
  flex: none;
}
/* Destructive action: neutral until hovered (red only on hover). */
.objects-view__delete.v-btn:not(.v-btn--disabled):hover,
.objects-view__delete.v-btn:not(.v-btn--disabled):focus-visible {
  color: var(--nd-error) !important;
  background: var(--nd-error-soft);
}
.objects-view__toolbar > .v-btn--variant-tonal.v-btn--disabled {
  background: transparent !important;
  box-shadow: none !important;
}
/* Disabled actions: dimmed but legible (~3:1), icon and label at the same level. */
.objects-view__toolbar > .v-btn.v-btn--disabled {
  color: var(--nd-shell-disabled) !important;
}
.objects-view__divider {
  flex: none;
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--nd-border);
}
.objects-view__mode {
  flex: none;
  margin-right: 8px;
}
.objects-view__mode :deep(.v-btn) {
  width: 30px;
  min-width: 30px;
  height: 26px !important;
}
.objects-view__search {
  flex: 0 1 220px;
  max-width: 240px;
  min-width: 140px;
}
.objects-view__search :deep(.v-field__input) {
  min-height: 30px;
  padding-top: 4px;
  padding-bottom: 4px;
  font-size: var(--nd-fs-dense);
}
.objects-view__title {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 16px;
  flex: none;
  min-width: 0;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
  white-space: nowrap;
  overflow: hidden;
}
.objects-view__crumb-dot {
  flex: none;
  width: 7px;
  height: 7px;
  margin-right: 4px;
  border-radius: 50%;
  box-shadow: 0 0 7px var(--nd-dot);
}
.objects-view__crumb-dot--none {
  box-shadow: inset 0 0 0 1.5px var(--nd-text-muted);
}
.objects-view__crumb {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.objects-view__crumb--current {
  color: var(--nd-text);
  font-weight: 600;
}
.objects-view__crumb-sep {
  flex: none;
  color: var(--nd-text-muted);
}
.objects-view__count {
  flex: none;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: var(--nd-radius-pill);
  font-size: 10.5px;
  line-height: 16px;
  color: var(--nd-text-2);
  background: var(--nd-hover);
  border: 1px solid var(--nd-hairline);
}
.objects-view__loading {
  position: relative;
  height: 0;
  flex: none;
}
.objects-view__loading > .v-progress-linear {
  position: absolute;
  inset: 0 0 auto 0;
  z-index: 3;
}
.objects-view__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.objects-view__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
  padding: 12px;
  overflow: auto;
  height: 100%;
  align-content: start;
}
.objects-view__tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 14px 8px 10px;
  border-radius: 10px;
  border: 1px solid transparent;
  cursor: default;
  outline: none;
  transition:
    background-color var(--nd-dur) var(--nd-ease),
    border-color var(--nd-dur) var(--nd-ease),
    transform var(--nd-dur) var(--nd-ease);
}
.objects-view__tile:hover {
  background: var(--nd-hover);
  border-color: var(--nd-border);
  transform: translateY(-1px);
}
.objects-view__tile:focus-visible {
  box-shadow: var(--nd-glow);
}
.objects-view__tile-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  color: var(--nd-text-2);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
  transition:
    color var(--nd-dur) var(--nd-ease),
    background var(--nd-dur) var(--nd-ease);
}
.objects-view__tile--selected,
.objects-view__tile--selected:hover {
  background: var(--nd-selected);
  border-color: rgba(var(--nd-accent-rgb), 0.35);
}
.objects-view__tile--selected .objects-view__tile-icon {
  color: var(--nd-accent);
  background: var(--nd-accent-gradient-soft);
  border-color: rgba(var(--nd-accent-rgb), 0.3);
}
.objects-view__tile-label {
  font-size: var(--nd-fs-dense);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
