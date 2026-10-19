<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { CellValue, ColumnInfo, ForeignKeyInfo, QueryColumn, SchemaRef } from '@shared/types'
import { api, invokeSilent } from '@renderer/api'
import CellValuePanel from '@renderer/components/data/CellValuePanel.vue'
import { isCellChanged } from '@renderer/components/data/rowEditing'
import { useValuePanelPref } from '@renderer/components/data/useValuePanelPref'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import ApplyErrorBanner from '@renderer/components/data/ApplyErrorBanner.vue'
import EditableGrid from '@renderer/components/data/EditableGrid.vue'
import { gridForeignKeys } from '@renderer/components/data/foreignKeys'
import ExportDialog from '@renderer/components/data/ExportDialog.vue'
import type { CopyContext, ExportScope } from '@renderer/components/data/gridCopy'
import type { GridSelectionSnapshot } from '@renderer/components/data/gridSelection'
import type { SqlDialectId } from '@shared/dialects/types'
import type { ExportQuerySource } from '@shared/export/types'
import RowEditActions from '@renderer/components/data/RowEditActions.vue'
import TableFilterPanel from '@renderer/components/data/filter/TableFilterPanel.vue'
import { NO_FILTER, useTableFilter } from '@renderer/components/data/filter/useTableFilter'
import { isApplyShortcut, useRowEditor } from '@renderer/components/data/useRowEditor'
import { useConfirm } from '@renderer/composables/useConfirm'
import { useWorkspace } from '@renderer/composables/useWorkspace'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import { formatDuration, formatNumber } from '@renderer/utils/format'
import { refOf, schemaRef } from '@renderer/utils/schemaRef'
import { isViewLike } from '@renderer/utils/columnMeta'
import { isMac } from '@renderer/utils/platform'
import { useConnectionsStore } from '@renderer/stores/connections'

const props = defineProps<{ tab: WorkspaceTab }>()

const settings = useSettingsStore()
const tabs = useTabsStore()
const workspace = useWorkspace()
/** «Estructura» (Cmd/Ctrl+D anywhere in the tab, see useShortcuts). */
const designShortcut = isMac() ? '⌘D' : 'Ctrl+D'
function openStructure(): void {
  tabs.activate(props.tab.id)
  workspace.designCurrent(false)
}
const { ask } = useConfirm()
const notify = useNotify()

const columns = ref<QueryColumn[]>([])
const editor = useRowEditor(columns)
const { rows, selected, active, applying, applyError, pending, dirty } = editor
const primaryKey = ref<string[]>([])
const total = ref<number | null>(null)
const durationMs = ref<number | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)

const page = ref(1)
const sort = ref<{ column: string; direction: 'ASC' | 'DESC' } | null>(null)

/** `{ database, schema }` on PostgreSQL tabs, the database name on MySQL ones. */
const target = (): [string, SchemaRef, string] => [
  props.tab.connectionId ?? '',
  refOf(props.tab),
  props.tab.objectName ?? ''
]
const connections = useConnectionsStore()
const isPostgres = computed(
  () => connections.get(props.tab.connectionId ?? '')?.engine === 'postgresql'
)
/** SQLite: rows are written by rowid (or the key of a WITHOUT ROWID table); views are read-only. */
const isSqlite = computed(() => connections.get(props.tab.connectionId ?? '')?.engine === 'sqlite')
/**
 * PostgreSQL rows are written by primary key only (a PK-less table or a
 * materialized view is read-only in v1); MySQL keeps all-columns keys.
 */
const pgReadOnlyReason = ref<string | null>(null)
const filter = useTableFilter(props.tab, {
  columns,
  generateWhere: (f) => api.db.tableFilterSql(...target(), f),
  confirm: (message, confirmText) =>
    ask({ title: 'Filtro', message, confirmText, color: 'warning' }),
  profiles: {
    list: () => api.db.filterProfiles(...target()),
    save: (name, f) => api.db.saveFilterProfile(...target(), name, f),
    remove: (name) => api.db.deleteFilterProfile(...target(), name)
  }
})
const { applied: appliedFilter, isApplied: filtered } = filter

/** Declared columns (nullability, datetime(3)...) for the editors, aligned with `columns`. */
const columnInfoList = ref<ColumnInfo[]>([])
const columnInfo = computed(() =>
  columns.value.map((c) => columnInfoList.value.find((i) => i.name === c.name) ?? null)
)
/** The table's foreign keys: «Elegir de <tabla>» on their columns. */
const foreignKeyList = ref<ForeignKeyInfo[]>([])
const gridFks = computed(() =>
  gridForeignKeys(columnInfo.value, foreignKeyList.value, (s) => schemaRef(s, props.tab.database))
)
async function loadColumnInfo(): Promise<void> {
  const { connectionId, schema, objectName } = props.tab
  if (!connectionId || !schema || !objectName) return
  try {
    columnInfoList.value = await invokeSilent(
      'db:columns',
      connectionId,
      refOf(props.tab),
      objectName
    )
  } catch {
    columnInfoList.value = [] // editors fall back to the result types
  }
  try {
    const structure = await invokeSilent(
      'db:tableStructure',
      connectionId,
      refOf(props.tab),
      objectName
    )
    foreignKeyList.value = structure.foreignKeys ?? []
    if (isPostgres.value)
      pgReadOnlyReason.value = isViewLike(structure)
        ? 'Vista materializada: solo lectura (usa «Refrescar» para recalcularla).'
        : null
  } catch {
    // No foreign keys offered; on PostgreSQL the primary-key check below still applies.
    foreignKeyList.value = []
  }
}
/** Column widths are remembered per table (names and pixels only). */
const widthKey = computed(() =>
  props.tab.connectionId && props.tab.schema && props.tab.objectName
    ? props.tab.database !== undefined
      ? `${props.tab.connectionId}:${props.tab.database}:${props.tab.schema}:${props.tab.objectName}`
      : `${props.tab.connectionId}:${props.tab.schema}:${props.tab.objectName}`
    : null
)

/* "Texto" value panel: the full value of the active cell. */
const valuePref = useValuePanelPref()
const activeCell = computed(() => {
  const cell = active.value
  const row = cell ? rows.value.find((r) => r.uid === cell.uid) : undefined
  if (!cell || !row) return null
  return { row, col: cell.col, value: row.values[cell.col] as CellValue }
})
function editFromPanel(value: CellValue): void {
  const cell = activeCell.value
  if (cell && !cell.row.deleted) editor.onEdit(cell.row.uid, cell.col, value)
}

const pageSize = computed(() => settings.rowLimit)
const pageCount = computed(() =>
  total.value === null ? null : Math.max(1, Math.ceil(total.value / pageSize.value))
)
const loadedRows = computed(() => rows.value.filter((r) => r.original).length)
const hasNext = computed(() =>
  pageCount.value === null ? loadedRows.value >= pageSize.value : page.value < pageCount.value
)
const noPrimaryKey = computed(() => columns.value.length > 0 && primaryKey.value.length === 0)
/** Why the grid cannot be edited (PostgreSQL only; MySQL keeps editing by all columns). */
const readOnlyNotice = computed(() => {
  if (isSqlite.value) {
    if (!noPrimaryKey.value) return null
    const reason = columns.value.find((c) => c.readOnlyReason)?.readOnlyReason
    return `Solo lectura${reason ? `: ${reason}` : ''}. Las filas no se pueden editar desde la cuadrícula.`
  }
  return !isPostgres.value
    ? null
    : (pgReadOnlyReason.value ??
        (noPrimaryKey.value
          ? 'La tabla no tiene clave primaria: sus filas no se pueden editar desde la cuadrícula (solo lectura).'
          : null))
})

watch(dirty, (value) => tabs.setDirty(props.tab.id, value), { immediate: true })

async function discardGuard(): Promise<boolean> {
  if (!dirty.value) return true
  return ask({
    title: 'Cambios sin aplicar',
    message: `Hay ${pending.value} fila(s) con cambios pendientes. ¿Descartarlos y continuar?`,
    confirmText: 'Descartar cambios',
    color: 'warning'
  })
}

async function load(): Promise<void> {
  if (!props.tab.connectionId || !props.tab.schema || !props.tab.objectName) {
    loadError.value = 'La pestaña no tiene conexión, esquema o tabla asociados'
    return
  }
  loading.value = true
  loadError.value = null
  try {
    const result = await api.db.tableData(props.tab.connectionId, {
      schema: refOf(props.tab),
      table: props.tab.objectName,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
      orderBy: sort.value,
      where: appliedFilter.value.where,
      // Structured filter: main escapes it and checks the columns (no SQL built here).
      ...(appliedFilter.value.filter ? { filter: appliedFilter.value.filter } : {})
    })
    columns.value = result.columns
    editor.reset(result.rows, result.storage)
    primaryKey.value = result.primaryKey
    total.value = result.total
    durationMs.value = result.durationMs
  } catch (err) {
    loadError.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

async function reload(): Promise<void> {
  if (await discardGuard()) await load()
}

async function goToPage(target: number): Promise<void> {
  if (target < 1 || target === page.value) return
  if (!(await discardGuard())) return
  page.value = target
  await load()
}

async function toggleSort(column: string, direction?: 'ASC' | 'DESC' | null): Promise<void> {
  if (!(await discardGuard())) return
  if (direction !== undefined) sort.value = direction ? { column, direction } : null
  else if (sort.value?.column !== column) sort.value = { column, direction: 'ASC' }
  else if (sort.value.direction === 'ASC') sort.value = { column, direction: 'DESC' }
  else sort.value = null
  page.value = 1
  await load()
}

async function applyFilter(): Promise<void> {
  const next = filter.prepareApply()
  if (!next) return
  if (!(await discardGuard())) return
  appliedFilter.value = next
  page.value = 1
  await load()
}

async function clearFilter(): Promise<void> {
  if (filter.isApplied.value && !(await discardGuard())) return
  filter.reset()
  if (!filter.isApplied.value) return
  appliedFilter.value = NO_FILTER
  page.value = 1
  await load()
}

async function saveFilterProfile(name: string): Promise<void> {
  try {
    await filter.saveProfile(name)
    notify.success(`Perfil de filtro «${name}» guardado`)
  } catch {
    /* invoke already reported the error */
  }
}

async function deleteFilterProfile(name: string): Promise<void> {
  try {
    await filter.deleteProfile(name)
  } catch {
    /* invoke already reported the error */
  }
}

async function toggleFilterMode(): Promise<void> {
  try {
    if (filter.state.value.mode === 'text') await filter.switchToBuilder()
    else await filter.switchToText()
  } catch (err) {
    notify.error(`No se pudo generar el WHERE: ${errorMessage(err)}`)
  }
}

async function applyChanges(): Promise<void> {
  const { connectionId, schema, objectName } = props.tab
  if (!connectionId || !schema || !objectName) return
  if (readOnlyNotice.value) return
  const applied = await editor.apply(
    {
      connectionId,
      schema,
      table: objectName,
      ...(props.tab.database !== undefined ? { database: props.tab.database } : {})
    },
    columns.value,
    primaryKey.value
  )
  if (applied) await load()
}

const grid = ref<InstanceType<typeof EditableGrid> | null>(null)

/* ---------- copy and export ---------- */

const dialectId = computed<SqlDialectId>(() => {
  const engine = connections.get(props.tab.connectionId ?? '')?.engine
  return engine === 'postgresql' || engine === 'sqlite' || engine === 'mariadb' ? engine : 'mysql'
})
const copyContext = computed<CopyContext>(() => ({
  dialect: dialectId.value,
  table: props.tab.objectName ?? null,
  keyColumns: primaryKey.value
}))
/** The table's SELECT with the applied filter and sort, without paging. */
const fullSource = computed<ExportQuerySource | null>(() =>
  props.tab.connectionId && props.tab.schema && props.tab.objectName
    ? {
        kind: 'table',
        request: {
          schema: refOf(props.tab),
          table: props.tab.objectName,
          orderBy: sort.value,
          where: appliedFilter.value.where,
          ...(appliedFilter.value.filter ? { filter: appliedFilter.value.filter } : {})
        }
      }
    : null
)
const exportOpen = ref(false)
const exportScope = ref<ExportScope>('loaded')
const exportSelection = ref<GridSelectionSnapshot | null>(null)
function openExport(scope?: 'selection' | 'all'): void {
  exportSelection.value = grid.value?.selectionSnapshot() ?? null
  exportScope.value = scope === 'selection' ? 'selection' : 'full'
  exportOpen.value = true
}
const exportPartial = computed(() =>
  pageCount.value !== null && pageCount.value > 1
    ? `Solo la página ${page.value} de ${pageCount.value}. «Resultado completo» exporta todas las filas${filtered.value ? ' del filtro' : ''}.`
    : null
)

/** "Ir a la fila": selects the row (and cell) whose change failed. */
function locateApplyError(): void {
  const failure = applyError.value
  if (!failure?.uid) return
  selected.value = [failure.uid]
  active.value = { uid: failure.uid, col: failure.col ?? 0 }
  grid.value?.revealError()
}

function onKeydown(event: KeyboardEvent): void {
  if (isApplyShortcut(event)) {
    event.preventDefault()
    void applyChanges()
  }
}

onMounted(() => {
  void load()
  void loadColumnInfo()
})

defineExpose({ rows, applyChanges, load })
</script>

<template>
  <div class="nd-view table-data" @keydown="onKeydown">
    <div class="nd-viewbar nd-viewbar--rowedit" role="toolbar" aria-label="Acciones de datos">
      <v-btn
        prepend-icon="mdi-refresh"
        size="small"
        :loading="loading"
        data-test="refresh"
        @click="reload"
        >Refrescar</v-btn
      >
      <v-btn
        prepend-icon="mdi-filter-variant"
        size="small"
        class="table-data__filter-btn"
        :class="{ 'is-active': filter.open.value, 'is-filtered': filtered }"
        :aria-pressed="filter.open.value"
        :title="
          filtered
            ? `Filtro aplicado (${filter.appliedCount.value} condición/es). Mostrar u ocultar el panel`
            : 'Mostrar u ocultar el panel de filtro'
        "
        data-test="filter-toggle"
        data-tour="table-filter"
        @click="filter.open.value = !filter.open.value"
        >Filtro<span
          v-if="filtered"
          class="table-data__filter-badge"
          :aria-label="`${filter.appliedCount.value} condición(es) aplicadas`"
          data-test="filter-badge"
          >{{ filter.appliedCount.value }}</span
        ></v-btn
      >
      <v-btn
        prepend-icon="mdi-text-box-outline"
        size="small"
        :class="{ 'is-active': valuePref.open }"
        class="table-data__filter-btn"
        :aria-pressed="valuePref.open"
        title="Mostrar el valor completo de la celda seleccionada"
        data-test="value-toggle"
        @click="valuePref.open = !valuePref.open"
        >Texto</v-btn
      >
      <v-btn
        prepend-icon="mdi-file-export-outline"
        size="small"
        :disabled="!columns.length"
        title="Exportar a CSV, Excel, JSON, SQL, Markdown, HTML o TXT"
        data-test="export"
        @click="openExport()"
        >Exportar</v-btn
      >
      <v-btn
        prepend-icon="mdi-table-cog"
        size="small"
        :title="`Ver la estructura de la tabla (${designShortcut})`"
        data-test="structure"
        @click="openStructure"
        >Estructura</v-btn
      >
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <RowEditActions
        :can-add="!loading && columns.length > 0 && !readOnlyNotice"
        :can-delete="selected.length > 0 && !readOnlyNotice"
        :can-set-null="!!active && !readOnlyNotice"
        :pending="pending"
        :applying="applying"
        @add="editor.addRow"
        @delete="editor.deleteSelected"
        @null="editor.setNull"
        @discard="editor.discard"
        @apply="applyChanges"
      />
    </div>

    <div class="nd-viewpanel">
      <TableFilterPanel
        v-if="filter.open.value"
        :state="filter.state.value"
        :columns="columns"
        :profiles="filter.profiles.value"
        :show-problems="filter.showProblems.value"
        :is-applied="filtered"
        :pending-apply="filter.pendingApply.value"
        :active-count="filter.activeCount.value"
        :problem="filter.problem.value"
        :busy="loading || filter.switching.value"
        @action="filter.dispatch"
        @set-text="filter.setText"
        @toggle-mode="toggleFilterMode"
        @apply="applyFilter"
        @menu-open="filter.refreshProfiles"
        @load-profile="filter.loadProfile"
        @save-profile="saveFilterProfile"
        @delete-profile="deleteFilterProfile"
        @clear="clearFilter"
      />

      <ApplyErrorBanner
        v-if="applyError"
        :message="applyError.message"
        :can-locate="!!applyError.uid"
        @locate="locateApplyError"
        @close="applyError = null"
      />

      <div v-if="readOnlyNotice" class="table-data__notice" role="note" data-test="read-only">
        <v-icon icon="mdi-lock-outline" size="14" />
        {{ readOnlyNotice }}
      </div>
      <div v-else-if="noPrimaryKey" class="table-data__notice" role="note">
        <v-icon icon="mdi-key-remove" size="14" />
        La tabla no tiene clave primaria: las filas se identifican por todos sus valores.
      </div>

      <div
        class="table-data__grid"
        :style="valuePref.open ? { minHeight: '160px' } : undefined"
        data-test="grid-area"
      >
        <v-progress-linear
          v-if="loading"
          indeterminate
          color="primary"
          height="2"
          class="nd-viewpanel__loader"
        />
        <EmptyState
          v-if="loadError"
          icon="mdi-alert-circle-outline"
          title="No se pudieron cargar los datos"
          :description="loadError"
        >
          <v-btn variant="tonal" size="small" prepend-icon="mdi-refresh" @click="load"
            >Reintentar</v-btn
          >
        </EmptyState>
        <EditableGrid
          v-else-if="columns.length"
          ref="grid"
          v-model:selected="selected"
          v-model:active="active"
          :columns="columns"
          :rows="rows"
          :primary-key="primaryKey"
          :sort="sort"
          :offset="(page - 1) * pageSize"
          :error-row="applyError?.uid ?? null"
          :error-col="applyError?.col ?? null"
          :column-info="columnInfo"
          :width-key="widthKey"
          :plain-editors="isSqlite"
          :readonly="!!readOnlyNotice"
          :copy="copyContext"
          :foreign-keys="gridFks"
          :connection-id="tab.connectionId ?? null"
          exportable
          @sort="toggleSort"
          @edit="editor.onEdit"
          @export="openExport"
        />
        <EmptyState v-else-if="!loading" icon="mdi-table-off" title="Sin datos" />
      </div>

      <CellValuePanel
        v-if="valuePref.open"
        :column="activeCell ? (columns[activeCell.col] ?? null) : null"
        :info="activeCell ? columnInfo[activeCell.col] : null"
        :value="activeCell?.value ?? null"
        :editable="!!activeCell && !activeCell.row.deleted && !readOnlyNotice"
        :changed="!!activeCell && isCellChanged(activeCell.row, activeCell.col)"
        view="table"
        @edit="editFromPanel"
      />

      <div class="table-data__footer" data-test="footer">
        <span class="table-data__stats nd-ellipsis">
          {{ formatNumber(loadedRows) }} fila(s) en esta página
          <template v-if="total !== null"> · {{ formatNumber(total) }} en total</template>
          <template v-if="durationMs !== null"> · {{ formatDuration(durationMs) }}</template>
          <template v-if="filtered"> · filtrado</template>
        </span>
        <span class="nd-viewbar__spacer" />
        <div class="table-data__pager" role="navigation" aria-label="Paginación">
          <v-btn
            icon="mdi-page-first"
            size="x-small"
            aria-label="Primera página"
            :disabled="page <= 1 || loading"
            @click="goToPage(1)"
          />
          <v-btn
            icon="mdi-chevron-left"
            size="x-small"
            aria-label="Página anterior"
            :disabled="page <= 1 || loading"
            @click="goToPage(page - 1)"
          />
          <span class="table-data__page"
            >Página {{ page
            }}<template v-if="pageCount !== null"> de {{ pageCount }}</template></span
          >
          <v-btn
            icon="mdi-chevron-right"
            size="x-small"
            aria-label="Página siguiente"
            :disabled="!hasNext || loading"
            data-test="next-page"
            @click="goToPage(page + 1)"
          />
          <v-btn
            icon="mdi-page-last"
            size="x-small"
            aria-label="Última página"
            :disabled="pageCount === null || page >= pageCount || loading"
            @click="goToPage(pageCount ?? page)"
          />
        </div>
      </div>
    </div>
    <ExportDialog
      v-model="exportOpen"
      :connection-id="tab.connectionId ?? null"
      :columns="columns"
      :rows="rows"
      :selection="exportSelection"
      :copy="copyContext"
      :full-source="fullSource"
      :base-name="tab.objectName ?? 'tabla'"
      :scope="exportScope"
      :partial="exportPartial"
      :pending-edits="dirty"
    />
  </div>
</template>

<style scoped src="../components/data/viewChrome.css"></style>
<style scoped>
.table-data__filter-btn.is-active {
  color: var(--nd-accent);
  background: rgba(var(--nd-accent-rgb), 0.1);
}
.table-data__filter-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  margin-left: 6px;
  padding: 0 4px;
  border-radius: var(--nd-radius-pill);
  font-family: var(--nd-font-mono);
  font-size: 10px;
  color: var(--nd-bg-base, #000);
  background: var(--nd-accent);
  box-shadow: 0 0 6px rgba(var(--nd-accent-rgb), 0.6);
}
.table-data__notice {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 6px 12px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-info);
  background: var(--nd-info-soft);
  border-bottom: 1px solid var(--nd-hairline);
}
.table-data__grid {
  position: relative;
  /* Basis 0: the rows never compete with the value panel for space; min-height (inline) protects the grid. */
  flex: 1 1 0;
  min-height: 0;
}
.table-data__footer {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  min-height: 34px;
  padding: 0 6px 0 12px;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--nd-text-2);
  border-top: 1px solid var(--nd-border);
  background: var(--nd-bg-raised);
}
.table-data__pager {
  display: flex;
  align-items: center;
  gap: 2px;
}
.table-data__page {
  margin: 0 8px;
  color: var(--nd-text);
  white-space: nowrap;
}
</style>
