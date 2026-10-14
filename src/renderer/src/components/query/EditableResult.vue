<script setup lang="ts">
import { computed, onMounted, ref, toRef, watch } from 'vue'
import { getDialect } from '@shared/dialects'
import type { SqlDialectId } from '@shared/dialects/types'
import { checkExportStatement } from '@shared/export/statement'
import type { ExportQuerySource } from '@shared/export/types'
import type {
  CellValue,
  ColumnInfo,
  QueryColumn,
  SchemaRef,
  StorageClass,
  TableStructure
} from '@shared/types'
import CellValuePanel from '@renderer/components/data/CellValuePanel.vue'
import { isCellChanged } from '@renderer/components/data/rowEditing'
import { useValuePanelPref } from '@renderer/components/data/useValuePanelPref'
import { invokeSilent } from '@renderer/api'
import ApplyErrorBanner from '@renderer/components/data/ApplyErrorBanner.vue'
import EditableGrid from '@renderer/components/data/EditableGrid.vue'
import ExportDialog from '@renderer/components/data/ExportDialog.vue'
import type { CopyContext, ExportScope } from '@renderer/components/data/gridCopy'
import type { GridSelectionSnapshot } from '@renderer/components/data/gridSelection'
import RowEditActions from '@renderer/components/data/RowEditActions.vue'
import { commitRows, sortRows } from '@renderer/components/data/rowEditing'
import { isApplyShortcut, useRowEditor } from '@renderer/components/data/useRowEditor'
import { useConnectionsStore } from '@renderer/stores/connections'
import { schemaRef } from '@renderer/utils/schemaRef'
import {
  decideEditability,
  payloadColumns,
  resultSource,
  type Editability
} from './resultEditability'

/**
 * One query result set. When its statement is a plain SELECT of exactly one
 * base table and the result carries its whole primary key it can be edited
 * like the table data view; otherwise it stays read-only and says why. Edits
 * are written by key, so a truncated result is still safe to edit. Every
 * result (multi-table ones too) can be selected, copied and exported.
 */
const props = defineProps<{
  connectionId: string
  /** Statement that produced the result: editability is decided from its FROM clause. */
  sql: string
  columns: QueryColumn[]
  rows: CellValue[][]
  truncated: boolean
  /** SQLite: storage class of each cell (edits keep it). */
  storage?: StorageClass[][]
  /**
   * Where the statement ran (MySQL database, PostgreSQL `{ database, schema }`),
   * so «Exportar resultado completo» runs it again in the same place.
   */
  context?: SchemaRef | null
  /**
   * Offer «Exportar» (button, menu, dialog). Off unless the host can save
   * files and answers the export:* channels (the desktop query view).
   */
  exportable?: boolean
}>()

const emit = defineEmits<{ dirty: [value: boolean] }>()

const editor = useRowEditor(toRef(props, 'columns'))
const { rows: gridRows, selected, active, applying, applyError, pending, dirty } = editor
editor.reset(props.rows, props.storage)

/**
 * PostgreSQL: the statement is parsed with the PG lexer, the result columns
 * name their database (RowDescription has no table alias, so that check is
 * skipped) and every call addresses `{ database, schema }`.
 */
const engine = useConnectionsStore().get(props.connectionId)?.engine
const dialectId: SqlDialectId =
  engine === 'postgresql' || engine === 'sqlite' || engine === 'mariadb' ? engine : 'mysql'
const isPg = engine === 'postgresql'
/** SQLite: parsed with the SQLite lexer, keyed by the rowid the driver marked in the result. */
const isLite = engine === 'sqlite'
const database = isPg ? props.columns.find((c) => c.database)?.database : undefined

/** Statement stage runs synchronously: most read-only results never touch the server. */
const source = resultSource(
  props.columns,
  props.sql,
  isPg ? 'postgresql' : isLite ? 'sqlite' : 'mysql'
)
const editability = ref<Editability | null>(
  source.ok ? null : { editable: false, reason: source.reason }
)
const checking = computed(() => editability.value === null)
const editable = computed(() => editability.value?.editable === true)
const keyColumns = computed(() => (editability.value?.editable ? editability.value.keyColumns : []))
const loadedCount = computed(() => gridRows.value.filter((r) => r.original).length)
const readOnlyReason = computed(() =>
  editability.value && !editability.value.editable ? editability.value.reason : ''
)
const target = computed(() =>
  editability.value?.schema ? `${editability.value.schema}.${editability.value.table}` : null
)

/** Source table structure (declared types, nullability) once known. */
const structure = ref<TableStructure | null>(null)
const columnInfo = computed<(ColumnInfo | null)[]>(() =>
  props.columns.map((c) => {
    if (!structure.value || (c.table && c.table !== structure.value.name)) return null
    const name = (c.sourceName ?? c.name).toLowerCase()
    return structure.value.columns.find((i) => i.name.toLowerCase() === name) ?? null
  })
)
/** Widths remembered per source table of the result (names and pixels only). */
const widthKey = source.ok
  ? `query:${props.connectionId}:${database !== undefined ? `${database}:` : ''}${source.source.schema}:${source.source.table}`
  : null

const valuePref = useValuePanelPref()
const activeCell = computed(() => {
  const cell = active.value
  const row = cell ? gridRows.value.find((r) => r.uid === cell.uid) : undefined
  if (!cell || !row) return null
  return { row, col: cell.col, value: row.values[cell.col] as CellValue }
})
function editFromPanel(value: CellValue): void {
  const cell = activeCell.value
  if (cell && editable.value && !cell.row.deleted) editor.onEdit(cell.row.uid, cell.col, value)
}

async function checkEditability(): Promise<void> {
  if (!source.ok) return
  try {
    const loaded = await invokeSilent(
      'db:tableStructure',
      props.connectionId,
      schemaRef(source.source.schema, database),
      source.source.table
    )
    structure.value = loaded
    editability.value = isPg
      ? decideEditability(props.columns, source.source, loaded, props.rows, {
          aliasMetadata: false
        })
      : isLite
        ? decideEditability(props.columns, source.source, loaded, props.rows, {
            aliasMetadata: false,
            keyFromColumns: true
          })
        : decideEditability(props.columns, source.source, loaded, props.rows)
  } catch {
    editability.value = decideEditability(props.columns, source.source, null)
  }
}

/* Client-side sort, like the read-only grid: edits follow their rows by uid. */
const sort = ref<{ column: string; direction: 'ASC' | 'DESC' } | null>(null)
const initialOrder = new Map(gridRows.value.map((r, i) => [r.uid, i]))

function toggleSort(column: string, direction?: 'ASC' | 'DESC' | null): void {
  const col = props.columns.findIndex((c) => c.name === column)
  if (col < 0) return
  if (direction !== undefined) sort.value = direction ? { column, direction } : null
  else if (sort.value?.column !== column) sort.value = { column, direction: 'ASC' }
  else if (sort.value.direction === 'ASC') sort.value = { column, direction: 'DESC' }
  else sort.value = null
  gridRows.value = sort.value
    ? sortRows(gridRows.value, col, sort.value.direction)
    : [...gridRows.value].sort(
        (a, b) => (initialOrder.get(a.uid) ?? Infinity) - (initialOrder.get(b.uid) ?? Infinity)
      )
}

async function applyChanges(): Promise<boolean> {
  const state = editability.value
  if (!state?.editable) return false
  const applied = await editor.apply(
    {
      connectionId: props.connectionId,
      schema: state.schema,
      table: state.table,
      ...(database !== undefined ? { database } : {})
    },
    payloadColumns(props.columns),
    state.primaryKey
  )
  if (!applied) return false
  // Generated ids fill the key the user left empty, only when that key is the AUTO_INCREMENT column.
  const generated = applied.changes.flatMap((c, i) =>
    c.kind === 'insert' ? [applied.result.insertIds?.[i] ?? null] : []
  )
  const idColumn = state.generatedKeyColumn
    ? props.columns.findIndex((c) => c.name === state.generatedKeyColumn)
    : -1
  gridRows.value = commitRows(gridRows.value, generated, idColumn >= 0 ? idColumn : null)
  for (const row of gridRows.value)
    if (!initialOrder.has(row.uid)) initialOrder.set(row.uid, Infinity)
  return true
}

const grid = ref<InstanceType<typeof EditableGrid> | null>(null)

/** "Ir a la fila": selects the row (and cell) whose change failed. */
function locateApplyError(): void {
  const failure = applyError.value
  if (!failure?.uid) return
  selected.value = [failure.uid]
  active.value = { uid: failure.uid, col: failure.col ?? 0 }
  grid.value?.revealError()
}

function onKeydown(event: KeyboardEvent): void {
  if (!editable.value || !isApplyShortcut(event)) return
  event.preventDefault()
  event.stopPropagation()
  void applyChanges()
}

/* ---------- copy and export ---------- */

/** The one source table of the result (multi-table results have none). */
const sourceTable = computed<string | null>(() => {
  if (editability.value?.editable) return editability.value.table
  if (source.ok) return source.source.table
  const tables = new Set(props.columns.map((c) => c.table ?? ''))
  return tables.size === 1 && !tables.has('') ? [...tables][0] : null
})
const copyContext = computed<CopyContext>(() => ({
  dialect: dialectId,
  table: sourceTable.value,
  keyColumns: keyColumns.value,
  // The source table's real names when the result renamed columns with AS.
  ...(sourceTable.value ? { sqlNames: payloadColumns(props.columns).map((c) => c.name) } : {})
}))
const statementCheck = computed(() =>
  engine === 'mongodb' ? null : checkExportStatement(getDialect(dialectId), props.sql)
)
const fullSource = computed<ExportQuerySource | null>(() =>
  statementCheck.value?.ok
    ? { kind: 'statement', sql: props.sql, ...(props.context ? { context: props.context } : {}) }
    : null
)
const fullReason = computed(() =>
  statementCheck.value && !statementCheck.value.ok ? statementCheck.value.reason : null
)
const exportOpen = ref(false)
const exportScope = ref<ExportScope>('loaded')
const exportSelection = ref<GridSelectionSnapshot | null>(null)
function openExport(scope?: 'selection' | 'all'): void {
  exportSelection.value = grid.value?.selectionSnapshot() ?? null
  exportScope.value = scope === 'selection' ? 'selection' : 'loaded'
  exportOpen.value = true
}

watch(dirty, (value) => emit('dirty', value))
onMounted(checkEditability)

defineExpose({ applyChanges, discard: editor.discard, dirty, editability })
</script>

<template>
  <div class="editable-result" @keydown="onKeydown">
    <div
      class="editable-result__bar nd-viewbar--rowedit"
      role="toolbar"
      aria-label="Edición del resultado"
      data-test="result-bar"
    >
      <span
        v-if="checking"
        class="nd-status-pill editable-result__chip"
        role="status"
        data-test="editability"
      >
        <v-progress-circular indeterminate size="10" width="1.5" />
        Comprobando si se puede editar…
      </span>
      <span
        v-else-if="editable"
        class="nd-status-pill nd-status-pill--accent editable-result__chip"
        role="status"
        :title="`Los cambios se aplican en ${target} por su clave primaria`"
        data-test="editability"
      >
        <v-icon icon="mdi-pencil-outline" size="13" aria-hidden="true" />
        <span class="editable-result__chip-text">Editable · {{ target }}</span>
      </span>
      <span
        v-else
        class="nd-status-pill editable-result__chip"
        role="status"
        :title="
          target
            ? `No se puede editar ${target}: ${readOnlyReason}`
            : `No se puede editar: ${readOnlyReason}`
        "
        data-test="editability"
      >
        <v-icon icon="mdi-lock-outline" size="13" aria-hidden="true" />
        <span class="editable-result__chip-text">Solo lectura · {{ readOnlyReason }}</span>
      </span>
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <v-btn
        prepend-icon="mdi-text-box-outline"
        size="small"
        :class="{ 'is-active': valuePref.open }"
        class="editable-result__toggle"
        :aria-pressed="valuePref.open"
        title="Mostrar el valor completo de la celda seleccionada"
        data-test="value-toggle"
        @click="valuePref.open = !valuePref.open"
        >Texto</v-btn
      >
      <v-btn
        v-if="exportable"
        prepend-icon="mdi-file-export-outline"
        size="small"
        title="Exportar a CSV, Excel, JSON, SQL, Markdown, HTML o TXT"
        data-test="export"
        @click="openExport()"
        >Exportar</v-btn
      >
      <template v-if="editable">
        <span class="nd-viewbar__sep" aria-hidden="true" />
        <RowEditActions
          :can-add="true"
          :can-delete="selected.length > 0"
          :can-set-null="!!active"
          :pending="pending"
          :applying="applying"
          @add="editor.addRow"
          @delete="editor.deleteSelected"
          @null="editor.setNull"
          @discard="editor.discard"
          @apply="applyChanges"
        />
      </template>
    </div>

    <ApplyErrorBanner
      v-if="applyError"
      :message="applyError.message"
      :can-locate="!!applyError.uid"
      @locate="locateApplyError"
      @close="applyError = null"
    />

    <div
      class="editable-result__grid"
      :style="valuePref.open ? { minHeight: 'min(160px, 70%)' } : undefined"
      data-test="grid-area"
    >
      <EditableGrid
        ref="grid"
        v-model:selected="selected"
        v-model:active="active"
        :columns="columns"
        :rows="gridRows"
        :primary-key="keyColumns"
        :sort="sort"
        :readonly="!editable"
        :error-row="applyError?.uid ?? null"
        :error-col="applyError?.col ?? null"
        :column-info="columnInfo"
        :width-key="widthKey"
        :plain-editors="isLite"
        :copy="copyContext"
        :exportable="exportable"
        @sort="toggleSort"
        @edit="editor.onEdit"
        @export="openExport"
      />
    </div>
    <CellValuePanel
      v-if="valuePref.open"
      :column="activeCell ? (columns[activeCell.col] ?? null) : null"
      :info="activeCell ? columnInfo[activeCell.col] : null"
      :value="activeCell?.value ?? null"
      :editable="editable && !!activeCell && !activeCell.row.deleted"
      :changed="!!activeCell && isCellChanged(activeCell.row, activeCell.col)"
      view="query"
      @edit="editFromPanel"
    />
    <div class="editable-result__footer" data-test="result-footer">
      <span class="nd-mono">{{ loadedCount }}</span> filas
      <span v-if="truncated" class="editable-result__truncated">· resultado truncado</span>
    </div>
    <ExportDialog
      v-if="exportable"
      v-model="exportOpen"
      :connection-id="connectionId"
      :columns="columns"
      :rows="gridRows"
      :selection="exportSelection"
      :copy="copyContext"
      :full-source="fullSource"
      :full-reason="fullReason"
      :base-name="sourceTable ?? 'resultado'"
      :scope="exportScope"
      :partial="
        truncated
          ? 'El resultado está truncado: solo se exportan las filas cargadas. «Resultado completo» las incluye todas.'
          : null
      "
      :pending-edits="dirty"
    />
  </div>
</template>

<style scoped src="../data/viewChrome.css"></style>
<style scoped>
.editable-result {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.editable-result__bar {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 2px;
  min-height: 40px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--nd-hairline);
}
.editable-result__chip {
  /* The bar wraps before this shrinks; it only ellipsizes when alone on a line. */
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}
.editable-result__chip-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.editable-result__toggle.is-active {
  color: var(--nd-accent);
  background: rgba(var(--nd-accent-rgb), 0.1);
}
.editable-result__grid {
  position: relative;
  /* Basis 0: the rows never compete with the value panel for space; min-height (inline) protects the grid. */
  flex: 1 1 0;
  min-height: 0;
}
.editable-result__footer {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  height: 28px;
  padding: 0 12px;
  border-top: 1px solid var(--nd-border);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.editable-result__truncated {
  color: var(--nd-warning);
}
</style>
