<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  EXPORT_FORMATS,
  defaultExportOptions,
  formatInfo,
  type CsvDelimiter,
  type ExportFormat,
  type ExportOptions,
  type ExportQuerySource
} from '@shared/export/types'
import { XLSX_MAX_COLUMNS, XLSX_MAX_ROWS } from '@shared/export/xlsx'
import type { QueryColumn } from '@shared/types'
import { api, newOperationId } from '@renderer/api'
import DialogHeader from '@renderer/components/dialogs/DialogHeader.vue'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { formatNumber } from '@renderer/utils/format'
import { useProgressStore } from '@renderer/stores/progress'
import {
  TABLE_PLACEHOLDER,
  allData,
  regionData,
  type CopyContext,
  type ExportScope
} from './gridCopy'
import { describeRegion, type GridSelectionSnapshot } from './gridSelection'
import type { EditableRow } from './rowEditing'

/**
 * «Exportar»: format, its options and what to export (the selection, the
 * rows already loaded, or the whole result read again in main), then the
 * native save dialog. Main writes the file (export:rows / export:query).
 */
const props = defineProps<{
  connectionId: string | null
  columns: QueryColumn[]
  /** Rows in display order (pending edits as shown). */
  rows: EditableRow[]
  /** Selection when the dialog was opened; null when there is none. */
  selection: GridSelectionSnapshot | null
  copy: CopyContext
  /** What «Resultado completo» runs again; null when it is not available. */
  fullSource: ExportQuerySource | null
  /** Why the whole result cannot be exported (shown under the disabled option). */
  fullReason?: string | null
  /** File name suggested in the save dialog, without extension. */
  baseName: string
  /** Initial scope. */
  scope?: ExportScope
  /** The loaded rows are only part of the result («resultado truncado», «página 2»…). */
  partial?: string | null
  pendingEdits?: boolean
}>()

const open = defineModel<boolean>({ default: false })
const notify = useNotify()
const progress = useProgressStore()

const STORAGE_KEY = 'electrondb.exportOptions'
type Remembered = Pick<
  ExportOptions,
  'format' | 'header' | 'delimiter' | 'bom' | 'nullText' | 'jsonShape' | 'batchSize'
>

function remembered(): Partial<Remembered> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Partial<Remembered>) : {}
  } catch {
    return {}
  }
}

function remember(o: ExportOptions): void {
  try {
    const keep: Remembered = {
      format: o.format,
      header: o.header,
      delimiter: o.delimiter,
      bom: o.bom,
      nullText: o.nullText,
      jsonShape: o.jsonShape,
      batchSize: o.batchSize
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keep))
  } catch {
    /* private profile: nothing remembered */
  }
}

const form = ref<ExportOptions>(defaultExportOptions())
const target = ref<ExportScope>('loaded')
const busy = ref(false)
const error = ref('')

const selectionRegion = computed(() => {
  const s = props.selection
  if (!s) return null
  const index = new Map(props.rows.map((r, i) => [r.uid, i]))
  const rows = s.rowUids.map((u) => index.get(u)).filter((i): i is number => i !== undefined)
  return rows.length && s.cols.length ? { rows, cols: s.cols } : null
})

watch(
  open,
  (value) => {
    if (!value) return
    const saved = remembered()
    form.value = defaultExportOptions({
      ...saved,
      format: EXPORT_FORMATS.some((f) => f.format === saved.format) ? saved.format : 'csv',
      table: props.copy.table || TABLE_PLACEHOLDER,
      dialect: props.copy.dialect
    })
    target.value =
      props.scope === 'selection' && selectionRegion.value
        ? 'selection'
        : props.scope === 'full' && props.fullSource
          ? 'full'
          : 'loaded'
    error.value = ''
  },
  { immediate: true }
)

const loadedCount = computed(() => props.rows.length)
const format = computed(() => form.value.format)
const showHeader = computed(() => ['csv', 'txt', 'xlsx'].includes(format.value))
const showNull = computed(() => ['csv', 'txt', 'xlsx', 'markdown', 'html'].includes(format.value))

const DELIMITERS: { title: string; value: CsvDelimiter }[] = [
  { title: 'Coma ( , )', value: ',' },
  { title: 'Punto y coma ( ; )', value: ';' },
  { title: 'Tabulador', value: '\t' }
]
const BATCHES = [
  { title: 'Una sentencia por fila', value: 1 },
  { title: '100 filas por INSERT', value: 100 },
  { title: '500 filas por INSERT', value: 500 },
  { title: '1.000 filas por INSERT', value: 1000 }
]

const xlsxProblem = computed(() => {
  if (format.value !== 'xlsx') return ''
  if (props.columns.length > XLSX_MAX_COLUMNS)
    return `Excel admite como máximo ${formatNumber(XLSX_MAX_COLUMNS)} columnas: elige CSV.`
  const rows =
    target.value === 'selection'
      ? (selectionRegion.value?.rows.length ?? 0)
      : target.value === 'loaded'
        ? loadedCount.value
        : 0
  if (rows + 1 > XLSX_MAX_ROWS)
    return `Excel admite como máximo ${formatNumber(XLSX_MAX_ROWS)} filas: elige CSV.`
  return ''
})

const canExport = computed(
  () =>
    !busy.value &&
    !xlsxProblem.value &&
    !!props.columns.length &&
    (target.value !== 'selection' || !!selectionRegion.value) &&
    (target.value !== 'full' || !!props.fullSource) &&
    (format.value !== 'sql' || !!form.value.table.trim())
)

/** Real names of the exported columns (aligned), for INSERT. */
function sqlNamesFor(cols: number[]): string[] | undefined {
  const names = props.copy.sqlNames
  return names && names.length === props.columns.length ? cols.map((c) => names[c]) : undefined
}

function showInFolder(path: string): { label: string; handler: () => void } {
  return { label: 'Mostrar en la carpeta', handler: () => void api.app.showInFolder(path) }
}

function done(path: string, rows: number, truncatedCells: number): void {
  const name = path.split(/[\\/]/).pop() ?? path
  notify.success(
    `${formatNumber(rows)} ${rows === 1 ? 'fila exportada' : 'filas exportadas'} a ${name}`,
    showInFolder(path)
  )
  if (truncatedCells)
    notify.warning(
      `${formatNumber(truncatedCells)} ${truncatedCells === 1 ? 'celda superaba' : 'celdas superaban'} los 32.767 caracteres que admite Excel y se ${truncatedCells === 1 ? 'ha recortado' : 'han recortado'}.`
    )
}

async function run(): Promise<void> {
  if (!canExport.value) return
  error.value = ''
  const info = formatInfo(form.value.format)
  const filePath = await api.app.pickSaveFile(
    'Exportar resultado',
    `${props.baseName}.${info.extension}`,
    [{ name: info.filterName, extensions: [info.extension] }]
  )
  if (!filePath) return
  const allCols = props.columns.map((_, i) => i)
  const options: ExportOptions = {
    ...form.value,
    table: form.value.table.trim(),
    dialect: props.copy.dialect,
    sheetName: props.baseName
  }
  remember(options)
  if (target.value === 'full') {
    if (!props.fullSource || !props.connectionId) return
    const operationId = newOperationId('export')
    const names = sqlNamesFor(allCols)
    open.value = false
    // Progress and «Cancelar» are in the operations card; errors are shown there too.
    api.exports
      .query(operationId, {
        connectionId: props.connectionId,
        filePath,
        source: props.fullSource,
        options: { ...options, ...(names ? { sqlNames: names } : {}) }
      })
      .then((result) => done(result.filePath, result.rows, result.truncatedCells))
      .catch((err) => {
        // Refusals and failures reach the operations card; anything that never got there is shown here.
        if (!progress.operations[operationId]) notify.error(errorMessage(err))
      })
    return
  }
  busy.value = true
  try {
    const region =
      target.value === 'selection' && selectionRegion.value
        ? selectionRegion.value
        : { rows: props.rows.map((_, i) => i), cols: allCols }
    const data =
      target.value === 'selection'
        ? regionData(props.columns, props.rows, region, props.copy.sqlNames)
        : allData(props.columns, props.rows, props.copy.sqlNames)
    const names = data.sqlNames ?? sqlNamesFor(region.cols)
    const result = await api.exports.rows({
      filePath,
      columns: data.columns,
      rows: data.rows,
      ...(data.storage ? { storage: data.storage } : {}),
      options: { ...options, ...(names ? { sqlNames: names } : {}) }
    })
    open.value = false
    done(result.filePath, result.rows, result.truncatedCells)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

const formats = EXPORT_FORMATS
function setFormat(value: ExportFormat): void {
  form.value = { ...form.value, format: value }
}
</script>

<template>
  <v-dialog v-model="open" max-width="680" scrollable>
    <v-card data-test="export-dialog">
      <DialogHeader icon="mdi-file-export-outline" title="Exportar" :subtitle="baseName" />
      <v-card-text class="export-dialog__body">
        <section class="export-dialog__section">
          <div class="export-dialog__label">Formato</div>
          <div class="export-dialog__formats" role="radiogroup" aria-label="Formato">
            <button
              v-for="f in formats"
              :key="f.format"
              type="button"
              role="radio"
              class="export-dialog__format"
              :class="{ 'is-active': form.format === f.format }"
              :aria-checked="form.format === f.format"
              :data-test="`export-format-${f.format}`"
              @click="setFormat(f.format)"
            >
              {{ f.label }}
            </button>
          </div>
        </section>

        <section class="export-dialog__section">
          <div class="export-dialog__label">Qué exportar</div>
          <v-radio-group v-model="target" hide-details density="compact" data-test="export-scope">
            <v-radio
              value="selection"
              :disabled="!selectionRegion"
              data-test="export-scope-selection"
            >
              <template #label>
                <span class="export-dialog__option">
                  <span>Selección</span>
                  <span class="export-dialog__hint">{{
                    selectionRegion ? describeRegion(selectionRegion) : 'no hay nada seleccionado'
                  }}</span>
                </span>
              </template>
            </v-radio>
            <v-radio value="loaded" data-test="export-scope-loaded">
              <template #label>
                <span class="export-dialog__option">
                  <span>Filas cargadas ({{ formatNumber(loadedCount) }})</span>
                  <span v-if="partial" class="export-dialog__hint">{{ partial }}</span>
                </span>
              </template>
            </v-radio>
            <v-radio value="full" :disabled="!fullSource" data-test="export-scope-full">
              <template #label>
                <span class="export-dialog__option">
                  <span>Resultado completo</span>
                  <span class="export-dialog__hint">{{
                    fullSource
                      ? 'Vuelve a ejecutar la consulta en una sesión nueva de solo lectura, sin límite de filas: no ve los cambios sin confirmar de esta pestaña.'
                      : fullReason || 'No disponible para este resultado.'
                  }}</span>
                </span>
              </template>
            </v-radio>
          </v-radio-group>
          <p v-if="pendingEdits && target !== 'full'" class="export-dialog__note" role="note">
            <v-icon icon="mdi-pencil-outline" size="14" aria-hidden="true" />
            Hay cambios sin aplicar: se exporta lo que ves en la cuadrícula.
          </p>
        </section>

        <section class="export-dialog__section" data-test="export-options">
          <div class="export-dialog__label">Opciones</div>
          <div class="export-dialog__options">
            <v-switch
              v-if="showHeader"
              v-model="form.header"
              color="primary"
              hide-details
              density="compact"
              label="Fila de encabezados"
              data-test="export-header"
            />
            <v-select
              v-if="format === 'csv'"
              v-model="form.delimiter"
              :items="DELIMITERS"
              label="Separador"
              hide-details
              data-test="export-delimiter"
            />
            <v-checkbox
              v-if="format === 'csv' || format === 'txt'"
              v-model="form.bom"
              hide-details
              density="compact"
              label="BOM UTF-8 (para que Excel lea bien los acentos)"
              data-test="export-bom"
            />
            <v-radio-group
              v-if="format === 'json'"
              v-model="form.jsonShape"
              inline
              hide-details
              density="compact"
              label="Estructura"
            >
              <v-radio value="objects" label="Objetos { columna: valor }" />
              <v-radio value="arrays" label="Arreglos [ valor, … ]" />
            </v-radio-group>
            <v-switch
              v-if="format === 'json' && form.jsonShape === 'arrays'"
              v-model="form.header"
              color="primary"
              hide-details
              density="compact"
              label="Primer arreglo con los nombres de las columnas"
            />
            <template v-if="format === 'sql'">
              <v-text-field
                v-model="form.table"
                label="Tabla de los INSERT"
                :hint="
                  copy.table ? 'La tabla de origen del resultado' : 'Escribe la tabla de destino'
                "
                persistent-hint
                class="export-dialog__mono"
                data-test="export-table"
              />
              <v-select
                v-model="form.batchSize"
                :items="BATCHES"
                label="Filas por sentencia"
                hide-details
                data-test="export-batch"
              />
            </template>
            <v-text-field
              v-if="showNull"
              v-model="form.nullText"
              label="Texto para NULL"
              placeholder="vacío"
              hide-details
              class="export-dialog__mono"
              data-test="export-null"
            />
          </div>
          <p v-if="format === 'xlsx'" class="export-dialog__note">
            Una hoja con encabezado fijo. Los números de más de 15 cifras se guardan como texto para
            no perder precisión; ningún valor se interpreta como fórmula.
          </p>
        </section>

        <v-alert v-if="xlsxProblem" type="warning" variant="tonal" density="compact">{{
          xlsxProblem
        }}</v-alert>
        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          density="compact"
          data-test="export-error"
          >{{ error }}</v-alert
        >
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">Cancelar</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-content-save-outline"
          :disabled="!canExport"
          :loading="busy"
          data-test="export-run"
          @click="run"
          >Exportar…</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.export-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 4px !important;
}
.export-dialog__section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.export-dialog__label {
  font-size: var(--nd-fs-small);
  font-weight: 600;
  color: var(--nd-text-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.export-dialog__formats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.export-dialog__format {
  padding: 5px 12px;
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-pill);
  background: transparent;
  color: var(--nd-text-2);
  font: inherit;
  font-size: var(--nd-fs-dense);
  cursor: pointer;
  transition:
    background var(--nd-dur-fast) var(--nd-ease),
    color var(--nd-dur-fast) var(--nd-ease);
}
.export-dialog__format:hover {
  color: var(--nd-text);
  background: var(--nd-hover);
}
.export-dialog__format.is-active {
  color: var(--nd-accent);
  border-color: var(--nd-accent);
  background: rgba(var(--nd-accent-rgb), 0.12);
}
.export-dialog__format:focus-visible {
  outline: 1px solid var(--nd-accent);
  outline-offset: 1px;
}
.export-dialog__option {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 3px 0;
}
.export-dialog__hint {
  font-size: var(--nd-fs-small);
  color: var(--nd-text-muted);
  line-height: 1.35;
}
.export-dialog__options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 16px;
  align-items: center;
}
.export-dialog__options > * {
  min-width: 0;
}
.export-dialog__note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--nd-fs-small);
  color: var(--nd-text-2);
}
.export-dialog__mono :deep(input) {
  font-family: var(--nd-font-mono);
}
</style>
