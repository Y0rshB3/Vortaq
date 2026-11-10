<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@renderer/api'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import SqlEditor from '@renderer/components/common/SqlEditor.vue'
import { firstError, friendlyError } from '@renderer/components/data/privileges'
import type { DdlObjectType } from '@renderer/components/designer/ddl'
import {
  pgBuildDdlScript,
  pgDdlTemplate,
  pgIsRename,
  pgParseObjectName,
  type PgDdlObjectType
} from '@renderer/components/designer/pg/ddl'
import { postgresqlDialect } from '@shared/dialects/postgresql'
import { sqlserverDialect } from '@shared/dialects/sqlserver'
import { sqliteDialect } from '@shared/dialects/sqlite'
import { schemaRef } from '@renderer/utils/schemaRef'
import {
  analyzeDestructiveScript,
  destructiveItems,
  destructiveTitle
} from '@renderer/components/query/destructiveGuard'
import { useEngineUi } from '@renderer/engines'
import { useConfirm, type DestructiveDetails } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { tabTitle, useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import { useTreeStore } from '@renderer/stores/tree'
import { OBJECT_TYPE_LABELS, OBJECT_TYPE_WITH_ARTICLE } from '@renderer/utils/objectTypes'
import type { GroupKind } from '@renderer/utils/objectTypes'

const props = defineProps<{ tab: WorkspaceTab }>()

/** Templates and apply script of the connection's engine (MySQL: designer/ddl.ts). */
const engineUi = useEngineUi(() => props.tab.connectionId)
const ddl = computed(() => engineUi.value.ddl!)
/** PostgreSQL: materialized views, routine signatures, trigger tables, no DEFINER. */
const isPg = computed(() => engineUi.value.id === 'postgresql')
/** SQL Server: CREATE OR ALTER keeps the object (and its permissions); only renames drop. */
const isMs = computed(() => engineUi.value.id === 'sqlserver')
/** SQLite: views and triggers, dropped and recreated inside one transaction. */
const isLite = computed(() => engineUi.value.id === 'sqlite')
const canStripDefiner = computed(() => engineUi.value.descriptor.capabilities.definer)

/** Every object type this editor opens (PostgreSQL adds materialized views). */
type EditorObjectType = DdlObjectType | 'materialized_view'

const tabs = useTabsStore()
const tree = useTreeStore()
const connections = useConnectionsStore()
const notify = useNotify()
const { confirmDestructive } = useConfirm()

const objectType = computed<EditorObjectType>(() => {
  // Tabs type objectType as the MySQL ObjectType; PostgreSQL also opens 'materialized_view'.
  const type = props.tab.objectType as string | undefined
  return type && type !== 'table' ? (type as EditorObjectType) : 'view'
})
/** PostgreSQL routines: identity arguments (overloads); triggers: owning table. */
const signature = computed(() =>
  typeof props.tab.payload?.signature === 'string' ? props.tab.payload.signature : undefined
)
const triggerTable = computed(() =>
  typeof props.tab.payload?.table === 'string' ? props.tab.payload.table : undefined
)
const objectName = ref<string | null>(props.tab.objectName || null)
const sql = ref('')
const loadedSql = ref('')
const removeDefiner = ref(false)
const loading = ref(false)
const applying = ref(false)
const loadError = ref<string | null>(null)
const showScript = ref(false)

const connectionId = computed(() => props.tab.connectionId ?? '')
const schema = computed(() => props.tab.schema ?? '')
/** PostgreSQL: database of the tab (undefined for MySQL). */
const database = computed(() => props.tab.database)
const typeLabel = computed(() =>
  objectType.value === 'materialized_view'
    ? 'vista materializada'
    : OBJECT_TYPE_LABELS[objectType.value]
)
const typeWithArticle = computed(() =>
  objectType.value === 'materialized_view'
    ? 'la vista materializada'
    : OBJECT_TYPE_WITH_ARTICLE[objectType.value]
)
/** Grammatical gender of the object kind, for «Nueva vista» / «Vista … guardada». */
const feminine = computed(() => typeWithArticle.value.startsWith('la '))
const dirty = computed(() => sql.value !== loadedSql.value)
const script = computed(() => {
  if (!sql.value.trim()) return ''
  if (isPg.value)
    return pgBuildDdlScript(sql.value, {
      type: objectType.value as PgDdlObjectType,
      schema: schema.value,
      originalName: objectName.value,
      removeDefiner: false,
      signature: signature.value,
      table: triggerTable.value
    })
  return ddl.value.buildScript(sql.value, {
    type: objectType.value as DdlObjectType,
    schema: schema.value,
    originalName: objectName.value,
    removeDefiner: removeDefiner.value
  })
})

/* Engine helpers: PostgreSQL also knows materialized views. */
const parseName = (source: string): string | null =>
  isPg.value
    ? pgParseObjectName(source, objectType.value as PgDdlObjectType)
    : ddl.value.parseObjectName(source, objectType.value as DdlObjectType)
const isRename = (source: string): boolean =>
  isPg.value
    ? pgIsRename(source, objectType.value as PgDdlObjectType, objectName.value)
    : ddl.value.isRename(source, objectType.value as DdlObjectType, objectName.value)
const hasDefiner = computed(() => /\bDEFINER\s*=/i.test(sql.value))

watch(dirty, (value) => tabs.setDirty(props.tab.id, value), { immediate: true })

const GROUP: Record<EditorObjectType, GroupKind | null> = {
  view: 'views',
  materialized_view: 'materializedViews' as GroupKind,
  function: 'functions',
  procedure: 'functions',
  event: 'events',
  // The connection tree has no trigger group (triggers are not listed there), so there is nothing to refresh.
  trigger: null
}

async function load(): Promise<void> {
  if (!connectionId.value || !schema.value) {
    loadError.value = 'La pestaña no tiene conexión o esquema asociados'
    return
  }
  loadError.value = null
  if (!objectName.value) {
    sql.value = isPg.value
      ? pgDdlTemplate(objectType.value as PgDdlObjectType)
      : ddl.value.template(objectType.value as DdlObjectType)
    loadedSql.value = ''
    return
  }
  loading.value = true
  try {
    // PostgreSQL routines are identified by name + signature (overloads), triggers by table.
    const name =
      isPg.value && (signature.value !== undefined || triggerTable.value !== undefined)
        ? {
            type: objectType.value,
            name: objectName.value,
            ...(signature.value !== undefined ? { signature: signature.value } : {}),
            ...(triggerTable.value !== undefined ? { table: triggerTable.value } : {})
          }
        : objectName.value
    const ddl = await api.invokeSilent(
      'db:showCreate',
      connectionId.value,
      schemaRef(schema.value, database.value),
      objectType.value,
      name
    )
    sql.value = ddl
    loadedSql.value = ddl
  } catch (err) {
    loadError.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

async function apply(): Promise<void> {
  if (applying.value || !script.value) return
  const rename = isRename(sql.value)
  const newName = parseName(sql.value)
  // PostgreSQL views and routines use CREATE OR REPLACE: only renames, materialized
  // views and triggers drop the original first.
  const replaces =
    !!objectName.value &&
    (isPg.value
      ? rename || objectType.value === 'materialized_view' || objectType.value === 'trigger'
      : isMs.value
        ? rename
        : isLite.value || objectType.value !== 'view' || rename)
  const message = rename
    ? `El nombre cambia: se creará ${typeWithArticle.value} "${newName}" y se eliminará "${objectName.value}". Lo que dependa del nombre anterior dejará de funcionar.`
    : replaces
      ? isLite.value
        ? `Se eliminará y volverá a crear ${typeWithArticle.value} "${objectName.value}" en una sola transacción: si la creación falla, no cambia nada.`
        : `Se eliminará y volverá a crear ${typeWithArticle.value} "${objectName.value}". Si la creación falla, el objeto quedará eliminado; el SQL sigue en el editor para reintentar.`
      : 'Se ejecutará el siguiente SQL.'
  // DROP + CREATE of routines/events/triggers, renamed views, or DROPs written by the user.
  const drops = isPg.value
    ? (postgresqlDialect.analyzeDestructive?.(script.value) ?? [])
    : isMs.value
      ? (sqlserverDialect.analyzeDestructive?.(script.value) ?? [])
      : isLite.value
        ? (sqliteDialect.analyzeDestructive?.(script.value) ?? [])
        : analyzeDestructiveScript(script.value)
  const article = typeWithArticle.value
  const destructive: DestructiveDetails | undefined = drops.length
    ? {
        title: rename
          ? `¿Reemplazar ${article} «${objectName.value}» por «${newName}»?`
          : replaces
            ? `¿Eliminar y volver a crear ${article} «${objectName.value}»?`
            : destructiveTitle(drops.length),
        message,
        items: destructiveItems(drops),
        details: script.value,
        confirmText: 'Ejecutar'
      }
    : undefined
  const ok = await confirmDestructive({
    connectionId: connectionId.value,
    title: objectName.value
      ? `Aplicar cambios en ${typeWithArticle.value}`
      : `Crear ${typeLabel.value}`,
    message,
    details: script.value,
    alwaysAsk: replaces,
    destructive
  })
  if (!ok) return

  applying.value = true
  try {
    const results = await api.invokeSilent('db:execute', connectionId.value, script.value, {
      schema: schemaRef(schema.value, database.value),
      confirmProduction: true
    })
    const error = firstError(results)
    if (error) {
      notify.error(friendlyError(error))
      return
    }
    const name = parseName(sql.value) ?? objectName.value
    const wasNew = !objectName.value
    const renamed = name !== objectName.value
    objectName.value = name
    if (wasNew || renamed) {
      if (name)
        tabs.setTitle(
          props.tab.id,
          tabTitle(name, schema.value, connections.nameOf(connectionId.value), database.value)
        )
      const group =
        isLite.value && objectType.value === 'trigger' ? 'triggers' : GROUP[objectType.value]
      if (group) void refreshGroup(group)
    }
    notify.success(
      `${typeLabel.value.charAt(0).toUpperCase()}${typeLabel.value.slice(1)} "${name ?? ''}" ${feminine.value ? 'guardada' : 'guardado'}`
    )
    if (name) await load()
    else loadedSql.value = sql.value
  } catch (err) {
    notify.error(friendlyError(errorMessage(err)))
  } finally {
    applying.value = false
  }
}

/** Reloads a tree group (PostgreSQL groups are per database: trailing `database` argument). */
function refreshGroup(group: GroupKind): Promise<unknown> {
  if (database.value === undefined)
    return tree.loadGroup(connectionId.value, schema.value, group, true).catch(() => undefined)
  const load = tree.loadGroup as (...args: unknown[]) => Promise<unknown>
  return load(connectionId.value, schema.value, group, true, database.value).catch(() => undefined)
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void apply()
  }
}

onMounted(load)

defineExpose({ sql, script, apply })
</script>

<template>
  <div class="nd-view ddl-editor" @keydown="onKeydown">
    <div class="nd-viewbar" role="toolbar" aria-label="Acciones del editor DDL">
      <v-btn
        prepend-icon="mdi-check"
        size="small"
        color="primary"
        variant="flat"
        :disabled="!script || loading"
        :loading="applying"
        title="Aplicar (Cmd+S)"
        data-test="apply"
        @click="apply"
      >
        Aplicar
      </v-btn>
      <v-btn
        prepend-icon="mdi-refresh"
        size="small"
        class="ml-1"
        :disabled="applying || !objectName"
        :loading="loading"
        @click="load"
        >Recargar</v-btn
      >
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <v-btn
        :prepend-icon="showScript ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
        size="small"
        :disabled="!script"
        :class="{ 'is-on': showScript }"
        :aria-pressed="showScript"
        @click="showScript = !showScript"
      >
        {{ showScript ? 'Ocultar SQL a ejecutar' : 'Ver SQL a ejecutar' }}
      </v-btn>
      <v-checkbox
        v-if="canStripDefiner"
        v-model="removeDefiner"
        label="Quitar DEFINER"
        density="compact"
        hide-details
        :disabled="!hasDefiner"
        class="ddl-editor__definer ml-2"
        title="Elimina la cláusula DEFINER para crear el objeto con el usuario actual"
        data-test="remove-definer"
      />
      <span class="nd-viewbar__spacer" />
      <span class="nd-status-pill" :class="{ 'nd-status-pill--accent': !objectName }">
        <v-icon icon="mdi-code-braces" size="13" />
        {{ objectName ? typeLabel : `${feminine ? 'Nueva' : 'Nuevo'} ${typeLabel}` }}
      </span>
    </div>

    <EmptyState
      v-if="loadError"
      icon="mdi-alert-circle-outline"
      :title="`No se pudo cargar ${typeWithArticle}`"
      :description="loadError"
    >
      <v-btn variant="tonal" size="small" prepend-icon="mdi-refresh" @click="load"
        >Reintentar</v-btn
      >
    </EmptyState>
    <div v-else class="ddl-editor__body">
      <div class="nd-viewpanel ddl-editor__editor">
        <v-progress-linear
          v-if="loading"
          indeterminate
          color="primary"
          height="2"
          class="nd-viewpanel__loader"
        />
        <SqlEditor v-model="sql" :engine="engineUi.id" @run="apply" @save="apply" />
      </div>
      <div v-if="showScript" class="nd-viewpanel ddl-editor__script">
        <div class="ddl-editor__script-head">
          <v-icon icon="mdi-play-circle-outline" size="14" />
          SQL que se ejecutará
        </div>
        <pre class="ddl-editor__pre" data-test="script-preview">{{ script }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped src="../components/data/viewChrome.css"></style>
<style scoped>
.ddl-editor__definer {
  flex: 0 0 auto;
}
.ddl-editor__definer :deep(.v-label) {
  font-size: var(--nd-fs-dense);
}
.is-on {
  color: var(--nd-accent);
}
.ddl-editor__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.ddl-editor__editor {
  background: var(--nd-bg-sunken);
}
.ddl-editor__editor:focus-within {
  border-color: rgba(var(--nd-accent-rgb), 0.45);
  box-shadow: var(--nd-glow);
}
.ddl-editor__script {
  flex: 0 0 35%;
}
.ddl-editor__script-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 8px 12px;
  font-size: var(--nd-fs-small);
  font-weight: 600;
  color: var(--nd-text-2);
  border-bottom: 1px solid var(--nd-hairline);
  background: var(--nd-bg-raised);
}
.ddl-editor__script-head .v-icon {
  color: var(--nd-accent);
}
.ddl-editor__pre {
  flex: 1 1 auto;
  overflow: auto;
  margin: 0;
  padding: 10px 14px 14px;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  line-height: 1.6;
  color: var(--nd-text);
  white-space: pre-wrap;
}
</style>
