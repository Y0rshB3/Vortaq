<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { DataTypeInfo, SqliteTableDependents, TableStructure } from '@shared/types'
import { buildRebuildScript, rebuildPreview } from '@shared/sqlite/rebuild'
import { api } from '@renderer/api'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import SqlEditor from '@renderer/components/common/SqlEditor.vue'
import { firstError, friendlyError } from '@renderer/components/data/privileges'
import ColumnsEditor from '@renderer/components/designer/ColumnsEditor.vue'
import ForeignKeysEditor from '@renderer/components/designer/ForeignKeysEditor.vue'
import type { DesignerAlter } from '@renderer/components/designer/alterTable'
import IndexesEditor from '@renderer/components/designer/IndexesEditor.vue'
import ConstraintsEditor from '@renderer/components/designer/pg/ConstraintsEditor.vue'
import PgColumnsEditor from '@renderer/components/designer/pg/PgColumnsEditor.vue'
import { pgBuildCreatePlan, pgNewTableDraft } from '@renderer/components/designer/pg/planner'
import SqliteColumnsEditor from '@renderer/components/designer/sqlite/SqliteColumnsEditor.vue'
import {
  sqliteBuildCreatePlan,
  sqliteNewTableDraft,
  type SqliteDesignerAlter
} from '@renderer/components/designer/sqlite/planner'
import { validateDraft } from '@renderer/components/designer/validateDraft'
import { useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { tabTitle, useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import { useTreeStore } from '@renderer/stores/tree'
import { emptyColumn, type TableDraft } from '@renderer/utils/tableDesigner'
import { schemaRef } from '@renderer/utils/schemaRef'
import { useEngineUi } from '@renderer/engines'
import {
  msBuildCreatePlan,
  msEmptyTable,
  msTransactionScript
} from '@renderer/components/designer/sqlserver/planner'

const props = defineProps<{ tab: WorkspaceTab }>()

/** Designer model and SQL builders of the connection's engine (MySQL: today's modules). */
const engineUi = useEngineUi(() => props.tab.connectionId)
const designer = computed(() => engineUi.value.designer!)
const tableEngines = computed(() => engineUi.value.typeCatalog?.tableEngines ?? [])
/** PostgreSQL: own columns editor, constraints tab, transactional save (see save()). */
const isPg = computed(() => engineUi.value.id === 'postgresql')
/** SQLite: own columns editor, in-place or rebuild plans sent to sqlite:alterTable. */
const isSqlite = computed(() => engineUi.value.id === 'sqlite')
/** MariaDB: MySQL's editors plus its own types and system versioning (Opciones). */
const isMariaDb = computed(() => engineUi.value.id === 'mariadb')
/** SQL Server: generic editors, schema-addressed like PostgreSQL, transactional save (saveMs). */
const isMs = computed(() => engineUi.value.id === 'sqlserver')
/** Table options of the MySQL family only (ENGINE, charset, AUTO_INCREMENT). */
const mysqlLike = computed(() => !isPg.value && !isSqlite.value && !isMs.value)
const columnTypes = computed(() => engineUi.value.typeCatalog?.columnTypes)

/** Index methods of PostgreSQL (pg_am); MySQL keeps IndexesEditor's own list. */
const PG_INDEX_METHODS = ['btree', 'hash', 'gin', 'gist', 'brin', 'spgist']

const tabs = useTabsStore()
const tree = useTreeStore()
const connections = useConnectionsStore()
const notify = useNotify()
const { confirmDestructive } = useConfirm()

type Charset = { charset: string; defaultCollation: string; collations: string[] }

const tableName = ref<string | null>(props.tab.objectName || null)
const original = ref<TableStructure | null>(null)
const draft = ref<TableDraft>(designer.value.emptyTable())
const initialSnapshot = ref('')
const charsets = ref<Charset[]>([])
const schemas = ref<string[]>([])
/** v-model of the PG constraints and enum additions (optional members of the draft). */
const pgConstraints = computed({
  get: () => draft.value.constraints ?? [],
  set: (constraints) => (draft.value = { ...draft.value, constraints })
})
const pgEnumAdditions = computed({
  get: () => draft.value.enumAdditions ?? {},
  set: (enumAdditions) => (draft.value = { ...draft.value, enumAdditions })
})
/** PostgreSQL type picker (db:dataTypes). */
const dataTypes = ref<DataTypeInfo[]>([])
/** SQLite: triggers/views a rebuild recreates, the AUTOINCREMENT mark (preview only). */
const sqliteDependents = ref<SqliteTableDependents | null>(null)
/** SQLite: «Copiar el archivo antes» of a rebuild (VACUUM INTO next to the file). */
const copyBefore = ref(true)
const section = ref('fields')
const loading = ref(false)
const saving = ref(false)
const loadError = ref<string | null>(null)

const connectionId = computed(() => props.tab.connectionId ?? '')
const schema = computed(() => props.tab.schema ?? '')
/** PostgreSQL: database of the tab (undefined for MySQL, where `schema` is the database). */
const database = computed(() => props.tab.database)
/** db:* namespace argument: the plain schema on MySQL, `{ database, schema }` on PostgreSQL. */
const ref_ = computed(() => schemaRef(schema.value, database.value))
const isNew = computed(() => !original.value)
const columnNames = computed(() => draft.value.columns.map((c) => c.name).filter(Boolean))

const plan = computed<DesignerAlter>(() => {
  if (!original.value) {
    if (isSqlite.value)
      return draft.value.name && draft.value.columns.length
        ? sqliteBuildCreatePlan(schema.value, draft.value)
        : { statements: [], risks: [], problems: [], drops: [] }
    if (isPg.value)
      return draft.value.name && draft.value.columns.length
        ? pgBuildCreatePlan(schema.value, draft.value)
        : { statements: [], risks: [], problems: [], drops: [] }
    if (isMs.value)
      return draft.value.name && draft.value.columns.length
        ? msBuildCreatePlan(schema.value, draft.value)
        : { statements: [], risks: [], problems: [], drops: [] }
    const statements =
      draft.value.name && draft.value.columns.length
        ? [designer.value.buildCreate(schema.value, draft.value)]
        : []
    return { statements, risks: [], problems: [], drops: [] }
  }
  return designer.value.buildAlter(original.value, draft.value)
})
const statements = computed(() => plan.value.statements)
/** SQLite plan extras: the sqlite:alterTable request and the rebuild reason. */
const sqlitePlan = computed(() => (isSqlite.value ? (plan.value as SqliteDesignerAlter) : null))
const rebuildReason = computed(() => sqlitePlan.value?.rebuild?.reason ?? null)

/** SQLite: exactly what sqlite:alterTable runs (the rebuild with the dependents read on load). */
function sqlitePreview(): string {
  const p = sqlitePlan.value
  const request = p?.request
  if (!p || !p.statements.length) return '-- Sin cambios'
  if (!request) return p.statements.map((st) => (st.startsWith('--') ? st : `${st};`)).join('\n')
  if (!request.rebuild)
    return ['BEGIN;', ...request.statements.map((st) => `${st};`), 'COMMIT;'].join('\n')
  const deps = sqliteDependents.value
  return rebuildPreview(
    buildRebuildScript(request.rebuild, request.statements, {
      schema: schema.value,
      table: request.newName,
      dependents: deps?.dependents ?? [],
      sequence: deps?.sequence ?? null,
      foreignKeys: deps?.foreignKeys ?? false
    })
  )
}
const preStatements = computed(() => plan.value.preStatements ?? [])
const previewSql = computed(() => {
  if (isSqlite.value) return sqlitePreview()
  if (!statements.value.length && !preStatements.value.length) return '-- Sin cambios'
  if (isMs.value) return msTransactionScript(statements.value)
  if (!isPg.value) return statements.value.join('\n\n')
  // PostgreSQL: what save() runs, in order (ADD VALUE outside the transaction).
  const parts: string[] = []
  if (preStatements.value.length) parts.push('-- Antes de la transacción', ...preStatements.value)
  if (statements.value.length)
    parts.push(
      plan.value.transactional
        ? ['BEGIN;', ...statements.value, 'COMMIT;'].join('\n')
        : statements.value.join('\n')
    )
  return parts.join('\n\n')
})
const dirty = computed(() =>
  isNew.value
    ? JSON.stringify(draft.value) !== initialSnapshot.value
    : statements.value.length > 0 || preStatements.value.length > 0
)
const validation = computed(
  () =>
    validateDraft(draft.value, { typeOptional: isSqlite.value }) ?? plan.value.problems[0] ?? null
)

const charset = computed(
  () => charsets.value.find((c) => c.collations.includes(draft.value.collation))?.charset ?? null
)
const collationItems = computed(
  () =>
    charsets.value.find((c) => c.charset === charset.value)?.collations ?? [draft.value.collation]
)

watch(dirty, (value) => tabs.setDirty(props.tab.id, value), { immediate: true })

function setCharset(name: string | null): void {
  const found = charsets.value.find((c) => c.charset === name)
  if (found) draft.value = { ...draft.value, collation: found.defaultCollation }
}

function newTableDraft(): TableDraft {
  if (isPg.value) return pgNewTableDraft()
  if (isMs.value) return msEmptyTable()
  if (isSqlite.value) return sqliteNewTableDraft()
  const id = {
    ...emptyColumn(),
    name: 'id',
    columnType: 'int',
    nullable: false,
    autoIncrement: true,
    primaryKey: true,
    unsigned: true
  }
  return { ...designer.value.emptyTable(), columns: [id] }
}

async function loadStructure(): Promise<void> {
  if (!connectionId.value || !schema.value) {
    loadError.value = 'La pestaña no tiene conexión o esquema asociados'
    return
  }
  loading.value = true
  loadError.value = null
  try {
    if (tableName.value) {
      const structure = await api.invokeSilent(
        'db:tableStructure',
        connectionId.value,
        ref_.value,
        tableName.value
      )
      original.value = structure
      draft.value = designer.value.draftFromStructure(structure)
      if (isSqlite.value)
        sqliteDependents.value = await api
          .invokeSilent('sqlite:tableDependents', connectionId.value, schema.value, tableName.value)
          .catch(() => null)
    } else {
      original.value = null
      draft.value = newTableDraft()
      // MariaDB has no utf8mb4_0900_ai_ci before 11.4: start from the database's own collation.
      if (connections.serverInfo[connectionId.value]?.runtime?.flavor === 'mariadb')
        draft.value = { ...draft.value, collation: await databaseCollation() }
    }
    initialSnapshot.value = JSON.stringify(draft.value)
  } catch (err) {
    loadError.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

/** Default collation of the tab's database ('' = the server's default when unknown). */
async function databaseCollation(): Promise<string> {
  try {
    const dbs = await api.db.databases(connectionId.value)
    return dbs.find((d) => d.name === schema.value)?.collation ?? ''
  } catch {
    return ''
  }
}

async function loadLookups(): Promise<void> {
  if (!connectionId.value) return
  if (isSqlite.value) {
    // No charsets; foreign keys reference tables of the same database file.
    schemas.value = [schema.value]
    return
  }
  if (isMs.value) {
    // No charsets; the column types come from the engine's catalogue, schemas from the database.
    try {
      schemas.value = (await api.db.schemas(connectionId.value, database.value ?? '')).map(
        (s) => s.name
      )
    } catch {
      schemas.value = [schema.value]
    }
    return
  }
  if (isPg.value) {
    // No charsets in PostgreSQL; types and schemas come from the tab's database.
    const db = database.value ?? ''
    const [types, list] = await Promise.allSettled([
      api.db.dataTypes(connectionId.value, db),
      api.db.schemas(connectionId.value, db)
    ])
    if (types.status === 'fulfilled') dataTypes.value = types.value
    if (list.status === 'fulfilled') schemas.value = list.value.map((s) => s.name)
    return
  }
  const [cs, dbs] = await Promise.allSettled([
    api.invokeSilent('db:charsets', connectionId.value),
    api.db.databases(connectionId.value)
  ])
  if (cs.status === 'fulfilled') charsets.value = cs.value
  if (dbs.status === 'fulfilled') schemas.value = dbs.value.map((d) => d.name)
}

async function save(): Promise<void> {
  if (saving.value || !dirty.value) return
  if (validation.value) {
    notify.warning(validation.value)
    return
  }
  const sql =
    isPg.value || isSqlite.value || isMs.value
      ? statements.value.length || preStatements.value.length
        ? previewSql.value
        : ''
      : statements.value.join('\n')
  if (!sql) return
  // Risky changes (drops, type narrowing, NOT NULL, renames) always ask; production always asks via useConfirm.
  const risks = plan.value.risks
  const drops = plan.value.drops
  const ok = await confirmDestructive({
    connectionId: connectionId.value,
    title: isNew.value ? 'Crear tabla' : 'Modificar tabla',
    message: risks.length
      ? `Revisa los cambios antes de aplicarlos. Esta operación no se puede deshacer:\n• ${risks.join('\n• ')}`
      : 'Se aplicarán los cambios de estructura.',
    details: sql,
    confirmText: risks.length ? 'Aplicar cambios' : undefined,
    alwaysAsk: risks.length > 0,
    destructive: drops.length
      ? {
          title:
            drops.length === 1
              ? `¿Eliminar 1 elemento de la tabla «${tableName.value}»?`
              : `¿Eliminar ${drops.length} elementos de la tabla «${tableName.value}»?`,
          message: `Revisa los cambios antes de aplicarlos. Esta operación no se puede deshacer:\n• ${risks.join('\n• ')}`,
          items: drops.map((d) => ({ tag: `DROP ${d.kind}`, text: d.name })),
          details: sql,
          confirmText: 'Eliminar'
        }
      : undefined
  })
  if (!ok) return

  saving.value = true
  try {
    if (isSqlite.value) {
      if (!(await saveSqlite())) return
    } else if (isPg.value) {
      if (!(await savePg())) return
    } else if (isMs.value) {
      if (!(await saveMs())) return
    } else {
      const results = await api.invokeSilent('db:execute', connectionId.value, sql, {
        schema: schema.value,
        confirmProduction: true
      })
      const error = firstError(results)
      if (error) {
        notify.error(friendlyError(error))
        // Earlier statements may already be applied: reload to show the real state.
        if (!isNew.value) await loadStructure()
        return
      }
    }
    const created = isNew.value
    const renamed = !created && draft.value.name !== tableName.value
    tableName.value = draft.value.name
    if (created || renamed) {
      tabs.setTitle(
        props.tab.id,
        tabTitle(
          draft.value.name,
          schema.value,
          connections.nameOf(connectionId.value),
          database.value
        )
      )
      void refreshTables()
    }
    notify.success(
      created ? `Tabla "${draft.value.name}" creada` : `Tabla "${draft.value.name}" modificada`
    )
    await loadStructure()
  } catch (err) {
    notify.error(friendlyError(errorMessage(err)))
  } finally {
    saving.value = false
  }
}

/** Reloads the tree's table list (PostgreSQL groups are per database). */
function refreshTables(): Promise<unknown> {
  if (database.value === undefined)
    return tree.loadGroup(connectionId.value, schema.value, 'tables', true).catch(() => undefined)
  // Trailing `database` argument of the database-aware tree store (PostgreSQL).
  const load = tree.loadGroup as (...args: unknown[]) => Promise<unknown>
  return load(connectionId.value, schema.value, 'tables', true, database.value).catch(
    () => undefined
  )
}

/**
 * PostgreSQL save: `ALTER TYPE … ADD VALUE` steps first, each on its own
 * (a value added inside a transaction cannot be used in it), then the whole
 * plan in ONE transaction: if any statement fails nothing is applied.
 * Returns false (after telling the user) when something failed.
 */
async function savePg(): Promise<boolean> {
  const options = { schema: ref_.value, confirmProduction: true }
  for (const pre of preStatements.value) {
    const results = await api.invokeSilent('db:execute', connectionId.value, pre, options)
    const error = firstError(results)
    if (error) {
      notify.error(friendlyError(error))
      if (!isNew.value) await loadStructure()
      return false
    }
  }
  if (!statements.value.length) return true
  const body = statements.value.join('\n')
  const script = plan.value.transactional ? `BEGIN;\n${body}\nCOMMIT;` : body
  const results = await api.invokeSilent('db:execute', connectionId.value, script, options)
  const error = firstError(results)
  if (error) {
    notify.error(
      `${friendlyError(error)}${plan.value.transactional ? ' No se aplicó ningún cambio: la transacción se deshizo.' : ''}`
    )
    if (!isNew.value) await loadStructure()
    return false
  }
  return true
}

/**
 * SQL Server save: the whole plan in one batch with XACT_ABORT ON inside one
 * transaction, so any error undoes every change. Returns false (after telling
 * the user) when something failed.
 */
async function saveMs(): Promise<boolean> {
  if (!statements.value.length) return true
  const results = await api.invokeSilent('db:execute', connectionId.value, previewSql.value, {
    schema: ref_.value,
    confirmProduction: true
  })
  const error = firstError(results)
  if (error) {
    notify.error(`${friendlyError(error)} No se aplicó ningún cambio: la transacción se deshizo.`)
    if (!isNew.value) await loadStructure()
    return false
  }
  return true
}

/**
 * SQLite save: one sqlite:alterTable call (in place, or the rebuild with its
 * foreign key check), after the optional copy of the file (VACUUM INTO).
 * Returns false (after telling the user) when something failed.
 */
async function saveSqlite(): Promise<boolean> {
  const request = sqlitePlan.value?.request
  if (!request) return false
  if (request.rebuild && copyBefore.value && !(await copyFileFirst())) return false
  try {
    const result = await api.invokeSilent(
      'sqlite:alterTable',
      connectionId.value,
      schema.value,
      request,
      { confirmProduction: true }
    )
    for (const warning of result.warnings) notify.warning(warning)
    return true
  } catch (err) {
    notify.error(`${errorMessage(err)} No se aplicó ningún cambio.`)
    if (!isNew.value) await loadStructure()
    return false
  }
}

/** «Copiar el archivo antes»: VACUUM INTO a file the user confirms. False = do not apply. */
async function copyFileFirst(): Promise<boolean> {
  const file = connections.get(connectionId.value)?.sqlite?.filePath ?? 'base.db'
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const base = file.replace(/\.[^./\\]*$/, '')
  const target = await api.app.pickSaveFile(
    'Copia del archivo antes de reconstruir la tabla',
    `${base}-antes-${tableName.value ?? 'tabla'}-${stamp}.db`,
    [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] }]
  )
  if (!target) return false
  try {
    await api.invokeSilent('sqlite:copyFile', connectionId.value, target)
    notify.success('Copia del archivo guardada')
    return true
  } catch (err) {
    notify.error(`No se pudo copiar el archivo: ${errorMessage(err)}`)
    return false
  }
}

async function revert(): Promise<void> {
  await loadStructure()
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void save()
  }
}

onMounted(async () => {
  await Promise.all([loadStructure(), loadLookups()])
})

defineExpose({ draft, previewSql, save })
</script>

<template>
  <div class="nd-view designer" @keydown="onKeydown">
    <div class="nd-viewbar" role="toolbar" aria-label="Acciones del diseñador">
      <v-btn
        prepend-icon="mdi-content-save-outline"
        size="small"
        color="primary"
        variant="flat"
        :disabled="!dirty || loading"
        :loading="saving"
        title="Guardar (Cmd+S)"
        data-test="save"
        @click="save"
      >
        Guardar
      </v-btn>
      <v-btn
        prepend-icon="mdi-undo"
        size="small"
        class="ml-1"
        :disabled="!dirty || saving"
        data-test="revert"
        @click="revert"
        >Descartar</v-btn
      >
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <v-btn
        prepend-icon="mdi-refresh"
        size="small"
        :disabled="saving"
        :loading="loading"
        @click="loadStructure"
        >Recargar</v-btn
      >
      <span class="nd-viewbar__spacer" />
      <span
        v-if="dirty && validation"
        class="nd-status-pill nd-status-pill--warning designer__validation mr-2"
        :title="validation"
      >
        <v-icon icon="mdi-alert-outline" size="13" />
        <span class="nd-ellipsis">{{ validation }}</span>
      </span>
      <span v-if="isNew" class="nd-status-pill nd-status-pill--accent">
        <span class="nd-status-pill__dot" aria-hidden="true" />
        Nueva tabla
      </span>
    </div>

    <EmptyState
      v-if="loadError"
      icon="mdi-alert-circle-outline"
      title="No se pudo cargar la estructura"
      :description="loadError"
    >
      <v-btn variant="tonal" size="small" prepend-icon="mdi-refresh" @click="loadStructure"
        >Reintentar</v-btn
      >
    </EmptyState>

    <template v-else>
      <v-tabs v-model="section" density="compact" class="nd-segmented designer__tabs">
        <v-tab value="fields" data-test="tab-fields">
          <v-icon icon="mdi-table-column" size="15" class="mr-2" />Campos
        </v-tab>
        <v-tab value="indexes" data-test="tab-indexes">
          <v-icon icon="mdi-lightning-bolt-outline" size="15" class="mr-2" />Índices
        </v-tab>
        <v-tab value="fks" data-test="tab-fks">
          <v-icon icon="mdi-key-link" size="15" class="mr-2" />Claves foráneas
        </v-tab>
        <v-tab v-if="isPg" value="constraints" data-test="tab-constraints">
          <v-icon icon="mdi-shield-check-outline" size="15" class="mr-2" />Restricciones
        </v-tab>
        <v-tab value="options" data-test="tab-options">
          <v-icon icon="mdi-tune-variant" size="15" class="mr-2" />Opciones
        </v-tab>
        <v-tab value="sql" data-test="tab-sql">
          <v-icon icon="mdi-code-tags" size="15" class="mr-2" />Vista previa SQL
        </v-tab>
      </v-tabs>
      <div
        v-if="rebuildReason && dirty"
        class="designer__rebuild"
        role="note"
        data-test="rebuild-note"
      >
        <v-icon icon="mdi-alert-outline" size="16" />
        <span class="designer__rebuild-text"
          >La tabla se reconstruirá ({{ rebuildReason }}): se crea de nuevo y se copian sus datos,
          índices, disparadores y vistas en una sola transacción.</span
        >
        <v-checkbox
          v-model="copyBefore"
          label="Copiar el archivo antes"
          density="compact"
          hide-details
          data-test="copy-before"
        />
      </div>
      <div class="nd-viewpanel">
        <v-progress-linear
          v-if="loading"
          indeterminate
          color="primary"
          height="2"
          class="nd-viewpanel__loader"
        />
        <v-window v-model="section" class="designer__body">
          <v-window-item value="fields" class="fill">
            <PgColumnsEditor
              v-if="isPg"
              v-model="draft.columns"
              v-model:enum-additions="pgEnumAdditions"
              :data-types="dataTypes"
              :original="original"
            />
            <SqliteColumnsEditor
              v-else-if="isSqlite"
              v-model="draft.columns"
              :without-rowid="draft.options?.withoutRowid === true"
            />
            <ColumnsEditor
              v-else
              v-model="draft.columns"
              :column-types="columnTypes"
              :unsigned="!isMs"
            />
          </v-window-item>
          <v-window-item value="indexes" class="fill">
            <IndexesEditor
              v-if="isPg"
              v-model="draft.indexes"
              :column-names="columnNames"
              :types="PG_INDEX_METHODS"
              allow-expressions
            />
            <IndexesEditor
              v-else-if="isSqlite"
              v-model="draft.indexes"
              :column-names="columnNames"
              :types="['INDEX']"
            />
            <IndexesEditor
              v-else-if="isMs"
              v-model="draft.indexes"
              :column-names="columnNames"
              :types="['NONCLUSTERED']"
            />
            <IndexesEditor v-else v-model="draft.indexes" :column-names="columnNames" />
          </v-window-item>
          <v-window-item value="fks" class="fill">
            <ForeignKeysEditor
              v-model="draft.foreignKeys"
              :column-names="columnNames"
              :schemas="schemas"
              :default-schema="schema"
            />
          </v-window-item>
          <v-window-item v-if="isPg" value="constraints" class="fill">
            <ConstraintsEditor v-model="pgConstraints" />
          </v-window-item>
          <v-window-item value="options" class="fill">
            <div class="designer__options">
              <div class="designer__options-title">Propiedades de la tabla</div>
              <v-row dense>
                <v-col cols="12" md="6">
                  <v-text-field
                    v-model="draft.name"
                    label="Nombre de la tabla"
                    data-test="table-name"
                  />
                </v-col>
                <template v-if="isPg">
                  <v-col cols="12" md="6" class="d-flex align-center">
                    <v-checkbox
                      :model-value="draft.options?.unlogged === true"
                      label="UNLOGGED (sin registro WAL: más rápida, se vacía tras una caída)"
                      density="compact"
                      hide-details
                      data-test="pg-unlogged"
                      @update:model-value="
                        draft = { ...draft, options: { ...draft.options, unlogged: !!$event } }
                      "
                    />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field
                      :model-value="String(draft.options?.owner ?? '')"
                      label="Propietario"
                      readonly
                      hint="Solo lectura"
                      persistent-hint
                      data-test="pg-owner"
                    />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field
                      :model-value="String(draft.options?.tablespace ?? '')"
                      label="Tablespace"
                      placeholder="Predeterminado"
                      readonly
                      hint="Solo lectura"
                      persistent-hint
                    />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field
                      :model-value="String(draft.options?.partitionKey ?? '')"
                      label="Clave de partición"
                      placeholder="Sin particiones"
                      readonly
                      hint="Solo lectura"
                      persistent-hint
                    />
                  </v-col>
                </template>
                <template v-if="isSqlite">
                  <v-col cols="12" md="6" class="d-flex align-center ga-4">
                    <v-checkbox
                      :model-value="draft.options?.withoutRowid === true"
                      label="WITHOUT ROWID"
                      density="compact"
                      hide-details
                      data-test="sqlite-without-rowid"
                      @update:model-value="
                        draft = { ...draft, options: { ...draft.options, withoutRowid: !!$event } }
                      "
                    />
                    <v-checkbox
                      :model-value="draft.options?.strict === true"
                      label="STRICT (tipos estrictos)"
                      density="compact"
                      hide-details
                      data-test="sqlite-strict"
                      @update:model-value="
                        draft = { ...draft, options: { ...draft.options, strict: !!$event } }
                      "
                    />
                  </v-col>
                  <v-col v-if="original?.constraints?.length" cols="12">
                    <div class="designer__options-title">Restricciones CHECK (se conservan)</div>
                    <ul class="designer__checks" data-test="sqlite-checks">
                      <li v-for="(c, i) in original.constraints" :key="i">
                        <code>{{ c.name ? `CONSTRAINT ${c.name} ` : '' }}{{ c.definition }}</code>
                      </li>
                    </ul>
                  </v-col>
                </template>
                <v-col v-if="isMariaDb" cols="12">
                  <v-checkbox
                    :model-value="draft.options?.systemVersioning === true"
                    label="Versionado de sistema (WITH SYSTEM VERSIONING)"
                    density="compact"
                    hide-details
                    data-test="mariadb-system-versioning"
                    @update:model-value="
                      draft = {
                        ...draft,
                        options: { ...draft.options, systemVersioning: !!$event }
                      }
                    "
                  />
                  <div class="designer__hint">
                    MariaDB guarda cada versión de las filas; quitarlo borra el historial.
                  </div>
                </v-col>
                <v-col v-if="mysqlLike" cols="12" md="6">
                  <v-combobox
                    v-model="draft.engine"
                    :items="tableEngines"
                    label="Motor"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                </v-col>
                <v-col v-if="mysqlLike" cols="12" md="6">
                  <v-select
                    :model-value="charset"
                    :items="charsets.map((c) => c.charset)"
                    label="Juego de caracteres"
                    no-data-text="No disponible"
                    @update:model-value="setCharset"
                  />
                </v-col>
                <v-col v-if="mysqlLike" cols="12" md="6">
                  <v-combobox
                    v-model="draft.collation"
                    :items="collationItems"
                    label="Intercalación"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                </v-col>
                <v-col v-if="mysqlLike" cols="12" md="6">
                  <v-text-field
                    :model-value="draft.autoIncrement ?? ''"
                    label="Auto incremento"
                    type="number"
                    min="1"
                    @update:model-value="
                      draft.autoIncrement = $event === '' || $event === null ? null : Number($event)
                    "
                  />
                </v-col>
                <v-col v-if="!isSqlite" cols="12">
                  <v-textarea
                    v-model="draft.comment"
                    label="Comentario"
                    class="nd-ui-font"
                    rows="2"
                    density="compact"
                    variant="outlined"
                    hide-details
                    auto-grow
                  />
                </v-col>
              </v-row>
            </div>
          </v-window-item>
          <v-window-item value="sql" class="fill">
            <SqlEditor
              :model-value="previewSql"
              :engine="engineUi.id"
              readonly
              data-test="sql-preview"
            />
          </v-window-item>
        </v-window>
      </div>
    </template>
  </div>
</template>

<style scoped src="../components/data/viewChrome.css"></style>
<style scoped>
.designer__validation {
  max-width: 420px;
}
.designer__tabs {
  flex: 0 0 auto;
  margin: 0 12px 10px !important;
}
.designer__tabs :deep(.v-tab .v-icon) {
  color: var(--nd-text-muted);
}
.designer__tabs :deep(.v-tab--selected .v-icon) {
  color: var(--nd-accent);
}
.designer__body {
  flex: 1 1 auto;
  min-height: 0;
}
.designer__body :deep(.v-window__container),
.fill {
  height: 100%;
}
.designer__options {
  max-width: 880px;
  padding: 20px 24px;
  overflow: auto;
}
.designer__hint {
  margin: 0 4px 6px 40px;
  font-size: var(--nd-fs-small);
  color: var(--nd-text-muted);
}
.designer__options-title {
  margin: 0 4px 14px;
  font-size: var(--nd-fs-title);
  font-weight: var(--nd-fw-heading);
  color: var(--nd-text);
}
.designer__rebuild {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 12px 10px;
  padding: 6px 12px;
  border: 1px solid var(--nd-warning);
  border-radius: 8px;
  color: var(--nd-warning);
}
.designer__rebuild-text {
  flex: 1 1 auto;
  color: var(--nd-text);
}
.designer__checks {
  margin: 0 4px;
  padding-left: 18px;
  font-family: var(--nd-font-mono, monospace);
}
.designer__options :deep(.v-col) {
  padding-block: 8px;
}
</style>
