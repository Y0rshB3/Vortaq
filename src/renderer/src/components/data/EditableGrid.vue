<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { CopyFormat } from '@shared/export/types'
import type { CellValue, ColumnInfo, QueryColumn, StorageClass } from '@shared/types'
import ContextMenu from '@renderer/components/common/ContextMenu.vue'
import type { MenuAction } from '@renderer/composables/useObjectActions'
import { useNotify } from '@renderer/composables/useNotify'
import { useColumnWidthsStore } from '@renderer/stores/columnWidths'
import { isMac } from '@renderer/utils/platform'
import { columnKindOf, type ColumnKind } from './columnKind'
import {
  COPY_FORMAT_LABELS,
  DEFAULT_COPY_CONTEXT,
  copyText,
  regionData,
  type CopyContext
} from './gridCopy'
import { planFill, regionCells, skippedMessage, type FillColumn } from './gridFill'
import {
  NO_SELECTION,
  clickCell as selectCellAt,
  clickColumn,
  clickRow,
  dragTo,
  extendBy,
  isSingleCell,
  pruneSelection,
  regionOf,
  rowsForDeletion,
  selectAll as selectEverything,
  singleCell,
  type CellRef,
  type GridRegion,
  type GridSelection,
  type GridSelectionSnapshot
} from './gridSelection'
import {
  displayCell,
  isCellChanged,
  isLockedCell,
  type ActiveCell,
  type EditableRow
} from './rowEditing'
import EnumInput from './EnumInput.vue'
import { enumOptions } from './enumValues'
import ForeignKeyPicker from './ForeignKeyPicker.vue'
import { foreignKeyLabel, type GridForeignKey } from './foreignKeys'
import TemporalInput from './TemporalInput.vue'
import { temporalSpec, type TemporalSpec } from './temporal'

const props = defineProps<{
  columns: QueryColumn[]
  rows: EditableRow[]
  primaryKey: string[]
  sort: { column: string; direction: 'ASC' | 'DESC' } | null
  readonly?: boolean
  /** Row number offset for the # column (page offset). */
  offset?: number
  /** Row (and cell) whose change made the last apply fail. */
  errorRow?: string | null
  errorCol?: number | null
  /** Declared column info aligned with `columns` (nullability, datetime(3)...), when known. */
  columnInfo?: (ColumnInfo | null | undefined)[]
  /**
   * Remembers column widths under this key (connection + table) across reloads and
   * reopening; without it widths live as long as the grid.
   */
  widthKey?: string | null
  /**
   * SQLite: values are dynamically typed, so cells use the plain text editor
   * (no date pickers that would reject a stored integer or real).
   */
  plainEditors?: boolean
  /** Engine quoting, source table and key for «Copiar como» INSERT/UPDATE/IN. */
  copy?: CopyContext | null
  /** Offer «Exportar…» in the context menu (the parent opens its dialog). */
  exportable?: boolean
  /**
   * Foreign key of each column (aligned with `columns`), for «Elegir de
   * <tabla>»; it reads the referenced table on `connectionId`.
   */
  foreignKeys?: (GridForeignKey | null)[] | null
  connectionId?: string | null
}>()

const emit = defineEmits<{
  /** No direction: cycle ASC → DESC → none (the header arrow); otherwise set it. */
  sort: [column: string, direction?: 'ASC' | 'DESC' | null]
  edit: [uid: string, col: number, value: CellValue]
  /** «Exportar selección…» / «Exportar…» from the context menu. */
  export: [scope: 'selection' | 'all']
}>()

const selected = defineModel<string[]>('selected', { default: () => [] })
const active = defineModel<ActiveCell | null>('active', { default: null })

/** Presentation only: numbers right aligned in mono, dates in mono. */
const kinds = computed<ColumnKind[]>(() => props.columns.map(columnKindOf))
/** Date/time picker per column (DATE, DATETIME/TIMESTAMP with fsp, TIME, YEAR). */
const specs = computed<(TemporalSpec | null)[]>(() =>
  props.columns.map((c, i) =>
    props.plainEditors ? null : temporalSpec(c.type, props.columnInfo?.[i]?.columnType)
  )
)
/** Allowed values of ENUM columns (MySQL/MariaDB type, PostgreSQL pg_enum): edited with a list. */
const enums = computed<(string[] | null)[]>(() =>
  props.columns.map((_, i) => (props.plainEditors ? null : enumOptions(props.columnInfo?.[i])))
)
const fkOf = (col: number): GridForeignKey | null =>
  (props.connectionId && props.foreignKeys?.[col]) || null

const STORAGE_LABELS: Record<StorageClass, string> = {
  null: 'NULL',
  integer: 'INTEGER',
  real: 'REAL',
  text: 'TEXT',
  blob: 'BLOB'
}

/** See isLockedCell: locked columns are shown dimmed and never edited. */
function isLocked(row: EditableRow, col: number): boolean {
  return isLockedCell(props.columns[col], row)
}

/** Tooltip: the value, plus its SQLite storage class and why it is locked. */
function cellTitle(row: EditableRow, col: number): string {
  const text = displayCell(row.values[col])
  const parts = [text]
  const storage = row.storage?.[col]
  if (storage && !isCellChanged(row, col)) parts.push(`Almacenado como ${STORAGE_LABELS[storage]}`)
  const locked = props.columns[col]?.locked
  if (locked && isLocked(row, col))
    parts.push(
      locked === 'rowid' ? 'rowid: identifica la fila (no editable)' : `No editable: ${locked}`
    )
  return parts.join(' · ')
}
const nullable = (col: number): boolean => props.columnInfo?.[col]?.nullable ?? true
/** What each column accepts when one value goes into several cells (gridFill.ts). */
const fillColumns = computed<FillColumn[]>(() =>
  props.columns.map((c, i) => ({
    name: c.name,
    temporal: specs.value[i],
    options: enums.value[i],
    nullable: nullable(i),
    primaryKey: props.primaryKey.includes(c.name)
  }))
)

/* ---------- column widths (drag the header edge, double-click to fit) ---------- */

const MIN_COL_WIDTH = 48
const MAX_FIT_WIDTH = 600
const widthsStore = useColumnWidthsStore()
const localWidths = ref<Record<string, number>>({})
const widths = computed<Record<string, number>>(() =>
  props.widthKey ? widthsStore.get(props.widthKey) : localWidths.value
)
function setWidth(name: string, width: number): void {
  const w = Math.max(MIN_COL_WIDTH, Math.round(width))
  if (props.widthKey) widthsStore.set(props.widthKey, name, w)
  else localWidths.value = { ...localWidths.value, [name]: w }
}
/** Inline sizing of a resized column (th and td); untouched columns keep content sizing. */
const colStyles = computed(() =>
  props.columns.map((c) => {
    const w = widths.value[c.name]
    return w
      ? { width: `${w}px`, minWidth: `${w}px`, maxWidth: `${w}px`, '--col-w': `${w - 24}px` }
      : undefined
  })
)

function startResize(event: PointerEvent, col: number): void {
  const th = (event.currentTarget as HTMLElement).closest('th')
  if (!th) return
  const handle = event.currentTarget as HTMLElement
  try {
    handle.setPointerCapture?.(event.pointerId)
  } catch {
    /* synthetic or already released pointer: dragging still works while over the handle */
  }
  const startX = event.clientX
  const startW = th.getBoundingClientRect().width
  const name = props.columns[col].name
  resizing.value = true
  const onMove = (e: PointerEvent): void => setWidth(name, startW + e.clientX - startX)
  const onUp = (): void => {
    resizing.value = false
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}

/** Double-click on the edge: fit the header and the rendered values (capped). */
function autoFit(col: number): void {
  const el = root.value
  if (!el) return
  let content = 0
  el.querySelectorAll<HTMLElement>(`td[data-col="${col}"] .cell-value`).forEach((v) => {
    content = Math.max(content, v.scrollWidth)
  })
  const header = el.querySelector<HTMLElement>(`th[data-col="${col}"] .header-cell`)
  content = Math.max(content, (header?.scrollWidth ?? 0) + 8)
  setWidth(props.columns[col].name, Math.min(MAX_FIT_WIDTH, content + 26))
}
const resizing = ref(false)

const editing = ref<ActiveCell | null>(null)
const draft = ref('')
/** True once the user typed in the editor: lets an emptied NULL cell become '' instead of staying NULL. */
const typed = ref(false)
/** Every cell the open editor writes to when several are selected; null: just the edited cell. */
const fill = ref<CellRef[] | null>(null)
const inputRef = ref<HTMLInputElement[] | HTMLInputElement | null>(null)
type TemporalEditor = InstanceType<typeof TemporalInput>
const temporalRef = ref<TemporalEditor[] | TemporalEditor | null>(null)
type EnumEditor = InstanceType<typeof EnumInput>
const enumRef = ref<EnumEditor[] | EnumEditor | null>(null)
/** The open date/time or ENUM editor (both validate before committing). */
function specialEditor(): { tryCommit: () => boolean } | null {
  const pick = <T,>(r: T[] | T | null): T | null => (Array.isArray(r) ? (r[0] ?? null) : r)
  return pick(temporalRef.value) ?? pick(enumRef.value)
}

/* ---------- selection (gridSelection.ts) ---------- */

const notify = useNotify()
const sel = ref<GridSelection>(NO_SELECTION)
const uids = computed(() => props.rows.map((r) => r.uid))
const selRegion = computed(() => regionOf(sel.value, uids.value, props.columns.length))
/** More than the active cell: cells, rows, columns or everything are highlighted. */
const multi = computed(() => selRegion.value !== null && !isSingleCell(sel.value))
const regionRows = computed(() => new Set(multi.value ? selRegion.value!.rows : []))
const regionCols = computed(() => new Set(multi.value ? selRegion.value!.cols : []))
const wholeColumns = computed(() => sel.value.kind === 'columns' || sel.value.kind === 'all')

function inRegion(index: number, col: number): boolean {
  return regionRows.value.has(index) && regionCols.value.has(col)
}
/** The full-row highlight: gutter rows, or the row of a plain active cell (as before). */
function rowHighlighted(uid: string): boolean {
  return selected.value.includes(uid) && (sel.value.kind === 'rows' || !multi.value)
}

/**
 * Applies a selection and derives the rows «Eliminar» works on from it:
 * gutter rows or the active cell's row, never a column or «Seleccionar todo».
 * `cell` is the active cell that goes with it: right after `active.value = …`
 * the model still reads the previous cell until the parent re-renders.
 */
function applySelection(next: GridSelection, cell: CellRef | null = active.value): void {
  sel.value = next
  selected.value = rowsForDeletion(next, cell)
}

/** The cell the grid itself made active last: the active watch leaves its selection alone. */
let ownActive: CellRef | null = null
/** Makes `cell` the active cell, with `next` selected (by default that cell alone). */
function activate(cell: CellRef, next: GridSelection = singleCell(cell)): void {
  ownActive = cell
  active.value = cell
  applySelection(next, cell)
}

/** Ranges and whole columns take one value in all their cells; gutter rows and «Seleccionar todo» do not. */
const fillRegion = computed(() =>
  multi.value && (sel.value.kind === 'cells' || sel.value.kind === 'columns')
    ? selRegion.value
    : null
)
/** The selected cells a value can go into: no locked column, no deleted row. */
function fillableCells(): CellRef[] {
  const region = fillRegion.value
  return region
    ? regionCells(region, props.rows, (row, col) => !row.deleted && !isLocked(row, col))
    : []
}
/** Every fillable selected cell when `cell` is one of several; null otherwise. */
function fillTargets(cell: CellRef): CellRef[] | null {
  const cells = fillableCells()
  const inside = cells.some((c) => c.uid === cell.uid && c.col === cell.col)
  return inside && cells.length > 1 ? cells : null
}
/** The cell Enter, F2 or typing edits: the active cell, or else a fillable selected one. */
function editCell(): CellRef | null {
  const cell = active.value
  if (!fillRegion.value) return cell
  const cells = fillableCells()
  const own = cell ? cells.find((c) => c.uid === cell.uid && c.col === cell.col) : undefined
  return own ?? cells.find((c) => c.uid === cell?.uid) ?? cells[0] ?? cell
}

/** Stages `valueFor(col)` in `targets`, skipping the cells whose column refuses it (gridFill.ts). */
function fillCells(targets: readonly CellRef[], valueFor: (col: number) => string | null): void {
  const plan = planFill(targets, props.rows, fillColumns.value, valueFor)
  for (const e of plan.edits) emit('edit', e.uid, e.col, e.value)
  const warning = skippedMessage(plan)
  if (warning) notify.warning(warning)
}

/** NULL in every selected cell when several are selected; false leaves it to the active cell. */
function fillNull(): boolean {
  if (props.readonly || editing.value) return false
  const cells = fillableCells()
  if (cells.length < 2) return false
  fillCells(cells, () => null)
  return true
}

/** The selected region, or the active cell alone; null when there is nothing. */
function copyRegion(): GridRegion | null {
  if (selRegion.value) return selRegion.value
  const cell = active.value
  if (!cell) return null
  const row = uids.value.indexOf(cell.uid)
  return row >= 0 ? { rows: [row], cols: [cell.col] } : null
}

/** Rows (by uid) and column indexes of the current selection, for «Exportar selección». */
function selectionSnapshot(): GridSelectionSnapshot | null {
  const region = copyRegion()
  if (!region) return null
  return { rowUids: region.rows.map((i) => uids.value[i]), cols: [...region.cols] }
}

// Rows replaced (new page, discard): forget what is gone.
watch(uids, (list) => {
  sel.value = pruneSelection(sel.value, list)
})
// The parent moved the active cell (apply error, new row, reload): select just that cell.
watch(active, (cell) => {
  const own = ownActive
  ownActive = null
  if (cell && own && own.uid === cell.uid && own.col === cell.col) return
  if (!cell) {
    if (sel.value.kind === 'cells') sel.value = NO_SELECTION
    return
  }
  const s = sel.value
  if (s.kind === 'cells' && s.anchor.uid === cell.uid && s.anchor.col === cell.col) return
  applySelection(singleCell(cell), cell)
})

/* ---------- copy ---------- */

const copyContext = computed<CopyContext>(() => props.copy ?? DEFAULT_COPY_CONTEXT)
/** When the last copy was made from the keyboard: the menu's copy event right after it stays quiet. */
let lastKeyCopy = 0

function selectionText(format: CopyFormat, header: boolean) {
  const region = copyRegion()
  if (!region) return null
  const data = regionData(props.columns, props.rows, region, copyContext.value.sqlNames)
  return copyText(
    format,
    data,
    copyContext.value,
    { header },
    {
      columns: props.columns,
      rows: props.rows,
      region
    }
  )
}

async function copySelection(format: CopyFormat, header = false): Promise<void> {
  const out = selectionText(format, header)
  if (!out) return
  if (out.warning) {
    notify.warning(out.warning)
    return
  }
  try {
    await navigator.clipboard.writeText(out.text)
    notify.success(out.message)
  } catch {
    notify.warning('No se pudo copiar al portapapeles')
  }
}

/** Edit › Copiar (or Cmd/Ctrl+C handled by the menu): the selection as tab-separated text. */
function onCopyEvent(event: ClipboardEvent): void {
  const target = event.target as HTMLElement | null
  if (editing.value || (target && /^(INPUT|TEXTAREA)$/.test(target.tagName))) return
  const out = selectionText('tsv', false)
  if (!out || out.warning || !event.clipboardData) return
  event.preventDefault()
  event.clipboardData.setData('text/plain', out.text)
  if (Date.now() - lastKeyCopy > 500) notify.success(out.message)
}

function isEditing(uid: string, col: number): boolean {
  return editing.value?.uid === uid && editing.value.col === col
}

function isActive(uid: string, col: number): boolean {
  return active.value?.uid === uid && active.value.col === col
}

function selectRow(event: MouseEvent, index: number): void {
  const uid = props.rows[index].uid
  let base = sel.value
  // Shift after a cell click extends from that cell's row, as before.
  if (event.shiftKey && base.kind !== 'rows' && active.value)
    base = { kind: 'rows', uids: [active.value.uid], anchor: active.value.uid }
  applySelection(
    clickRow(base, uid, uids.value, {
      shift: event.shiftKey,
      toggle: event.metaKey || event.ctrlKey
    })
  )
}

function clickCell(event: MouseEvent, uid: string, col: number): void {
  // Shift extends from the rectangle's anchor or the active cell; without either it is a plain click.
  if (event.shiftKey && (sel.value.kind === 'cells' || active.value)) {
    applySelection(selectCellAt(sel.value, { uid, col }, { shift: true }, active.value))
    return
  }
  activate({ uid, col })
}

function clickHeader(event: MouseEvent, col: number): void {
  if (resizing.value) return
  applySelection(
    clickColumn(sel.value, col, { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey })
  )
  root.value?.focus()
}

function selectAll(): void {
  applySelection(selectEverything())
  root.value?.focus()
}

/* Drag over cells: a rectangle from the cell where the button went down. */
let dragStart: CellRef | null = null
function startDrag(event: MouseEvent, uid: string, col: number): void {
  if (event.button !== 0 || event.shiftKey || isEditing(uid, col)) return
  dragStart = { uid, col }
  window.addEventListener('mouseup', endDrag, { once: true })
}
function dragOver(uid: string, col: number): void {
  if (!dragStart) return
  activate(dragStart, dragTo(dragStart, { uid, col }))
}
function endDrag(): void {
  dragStart = null
}
onBeforeUnmount(() => window.removeEventListener('mouseup', endDrag))

/**
 * Opens the editor of a cell, with its value or with `text` the user started
 * typing. When the cell is one of several selected (a range or whole
 * columns), the value is written into all of them (gridFill.ts); a selection
 * that cannot take it shrinks to the edited cell.
 */
async function startEdit(uid: string, col: number, text?: string): Promise<void> {
  const row = props.rows.find((r) => r.uid === uid)
  if (props.readonly || !row || row.deleted || isLocked(row, col)) return
  const cell = { uid, col }
  fill.value = fillTargets(cell)
  activate(cell, fill.value ? sel.value : singleCell(cell))
  editing.value = cell
  const value = row.values[col]
  draft.value = text ?? (value === null ? '' : displayCell(value))
  typed.value = text !== undefined
  await nextTick()
  cellElement(uid, col)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  if (specs.value[col] || enums.value[col]) return // TemporalInput and EnumInput focus themselves
  const el = Array.isArray(inputRef.value) ? inputRef.value[0] : inputRef.value
  el?.focus()
  if (text === undefined) el?.select()
  else el?.setSelectionRange(text.length, text.length)
}

const editorLabel = (name: string): string =>
  fill.value ? `Editar ${name} en ${fill.value.length} celdas` : `Editar ${name}`

function cellElement(uid: string, col: number): HTMLElement | null {
  const index = props.rows.findIndex((r) => r.uid === uid)
  return root.value?.querySelector<HTMLElement>(`td[data-test="cell-${index}-${col}"]`) ?? null
}

/**
 * Commits a value decided by the temporal or ENUM editor (validated literal,
 * or null). Into several cells only when the user chose it (`chosen`) or
 * changed the text: leaving an untouched editor writes nothing there.
 */
function commitValue(value: string | null, chosen: boolean): void {
  if (!editing.value) return
  const { uid, col } = editing.value
  const targets = fill.value
  const row = props.rows.find((r) => r.uid === uid)
  editing.value = null
  fill.value = null
  if (targets) {
    if (chosen || typed.value) fillCells(targets, () => value)
    return
  }
  if (!row) return
  const current = row.values[col]
  if (value === null ? current === null : current !== null && displayCell(current) === value) return
  emit('edit', uid, col, value)
}

function onTemporalCommit(value: string | null): void {
  const several = !!fill.value
  const col = editing.value?.col
  // An ENUM value is always picked; a date only counts once edited (or set to NULL).
  commitValue(value, value === null || (col !== undefined && !!enums.value[col]))
  // Several cells: the selection stays, showing what changed.
  if (!several) move(1, 0)
  root.value?.focus()
}

/** Leaving a temporal or ENUM editor commits only valid text; invalid text keeps the editor open. */
function onTemporalLeave(): void {
  const editor = specialEditor()
  if (!editor) return commit()
  editor.tryCommit()
}

function onTemporalKey(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    onTemporalLeave()
    return
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    event.stopPropagation()
    if (specialEditor()?.tryCommit() ?? true) move(0, event.shiftKey ? -1 : 1)
    return
  }
  event.stopPropagation()
}

function cancelTemporal(): void {
  cancel()
  root.value?.focus()
}

function commit(): void {
  if (!editing.value) return
  const { uid, col } = editing.value
  const targets = fill.value
  const row = props.rows.find((r) => r.uid === uid)
  editing.value = null
  fill.value = null
  if (targets) {
    // Into several cells only text the user typed: Enter on an untouched editor writes nothing.
    if (typed.value) fillCells(targets, () => draft.value)
    return
  }
  if (!row) return
  const current = row.values[col]
  if (current !== null && displayCell(current) === draft.value) return
  if (current === null && draft.value === '' && !typed.value) return
  emit('edit', uid, col, draft.value)
}

function cancel(): void {
  editing.value = null
  fill.value = null
}

function move(dRow: number, dCol: number): void {
  if (!active.value || !props.rows.length) return
  const idx = props.rows.findIndex((r) => r.uid === active.value!.uid)
  const rowIdx = Math.min(Math.max(idx + dRow, 0), props.rows.length - 1)
  const col = Math.min(Math.max(active.value.col + dCol, 0), props.columns.length - 1)
  activate({ uid: props.rows[rowIdx].uid, col })
}

function onInputKey(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    // Commit the cell and let Cmd+S bubble so the view applies the changes.
    commit()
    return
  }
  event.stopPropagation()
  if (event.key === 'Enter') {
    event.preventDefault()
    const several = !!fill.value
    commit()
    // Several cells: the selection stays, showing what changed.
    if (!several) move(1, 0)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  } else if (event.key === 'Tab') {
    event.preventDefault()
    commit()
    move(0, event.shiftKey ? -1 : 1)
  } else return
  // The input goes away: the arrows and typing keep working on the grid.
  root.value?.focus()
}

/* ---------- «Elegir de <tabla>» (foreign keys) ---------- */

const picker = ref<{
  uid: string
  col: number
  fk: GridForeignKey
  target: Element
  /** Several selected cells of the column: the rows that take the picked key. */
  rows: string[] | null
} | null>(null)
const pickerCurrent = computed(() => {
  const p = picker.value
  const row = p ? props.rows.find((r) => r.uid === p.uid) : undefined
  if (!p || !row) return []
  return p.fk.cols.map((c) => (row.values[c] === null ? null : displayCell(row.values[c])))
})
const pickerNullable = computed(() => !!picker.value?.fk.cols.every((c) => nullable(c)))

/** The cell can take a value from its referenced table now. */
function canPick(row: EditableRow | undefined, col: number): boolean {
  const fk = fkOf(col)
  return !!fk && !!row && !props.readonly && !row.deleted && fk.cols.every((c) => !isLocked(row, c))
}

function openPicker(uid: string, col: number): void {
  const row = props.rows.find((r) => r.uid === uid)
  const fk = fkOf(col)
  if (!fk || !canPick(row, col)) return
  const target = cellElement(uid, col)
  if (!target) return
  editing.value = null
  const cell = { uid, col }
  // Several cells of this column selected: the key goes to each of their rows.
  const rows = [
    ...new Set(
      (fillTargets(cell) ?? [])
        .filter(
          (c) =>
            c.col === col &&
            canPick(
              props.rows.find((r) => r.uid === c.uid),
              col
            )
        )
        .map((c) => c.uid)
    )
  ]
  if (rows.length > 1) activate(cell, sel.value)
  else activate(cell)
  picker.value = { uid, col, fk, target, rows: rows.length > 1 ? rows : null }
}

function closePicker(): void {
  picker.value = null
  void nextTick(() => root.value?.focus())
}

/**
 * Writes the chosen referenced values into every column of the key (unchanged
 * ones skipped), in each selected row when several are.
 */
function onPicked(values: (string | null)[]): void {
  const p = picker.value
  const row = p ? props.rows.find((r) => r.uid === p.uid) : undefined
  if (p?.rows) {
    const targets = p.rows.flatMap((uid) => p.fk.cols.map((col) => ({ uid, col })))
    fillCells(targets, (col) => values[p.fk.cols.indexOf(col)] ?? null)
  } else if (p && row)
    p.fk.cols.forEach((c, i) => {
      const next = values[i] ?? null
      const cur = row.values[c]
      if (next === null ? cur === null : cur !== null && displayCell(cur) === next) return
      emit('edit', p.uid, c, next)
    })
  closePicker()
}

function onGridKey(event: KeyboardEvent): void {
  if (editing.value) return
  if (event.altKey && event.key === 'ArrowDown' && active.value) {
    // Alt+↓: the referenced rows of a foreign key, or the list of an ENUM.
    const { uid, col } = active.value
    if (fkOf(col)) {
      event.preventDefault()
      openPicker(uid, col)
      return
    }
    if (enums.value[col]) {
      event.preventDefault()
      void startEdit(uid, col)
      return
    }
  }
  const mod = (event.metaKey || event.ctrlKey) && !event.altKey
  const key = event.key.toLowerCase()
  if (mod && key === 'c') {
    // Cmd/Ctrl+C: tab-separated text (pastes into spreadsheets); with Shift, with headers.
    event.preventDefault()
    lastKeyCopy = Date.now()
    void copySelection('tsv', event.shiftKey)
    return
  }
  if (mod && key === 'a') {
    event.preventDefault()
    selectAll()
    return
  }
  if (event.key === 'Escape' && multi.value) {
    event.preventDefault()
    applySelection(active.value ? singleCell(active.value) : NO_SELECTION)
    return
  }
  // Enter, F2 or typing a character edits the cell (every selected cell, see startEdit).
  if (!props.readonly && (event.key === 'Enter' || event.key === 'F2' || isTypedChar(event))) {
    const cell = editCell()
    if (!cell) return
    event.preventDefault()
    void startEdit(cell.uid, cell.col, isTypedChar(event) ? event.key : undefined)
    return
  }
  if (!active.value) return
  const moves: Record<string, [number, number]> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1]
  }
  if (moves[event.key] && event.shiftKey) {
    event.preventDefault()
    applySelection(
      extendBy(sel.value, ...moves[event.key], uids.value, props.columns.length, active.value)
    )
  } else if (moves[event.key]) {
    event.preventDefault()
    move(...moves[event.key])
  }
}

/**
 * A key that types a character (also AltGr and macOS Option characters),
 * not a shortcut or a dead key still composing.
 */
function isTypedChar(event: KeyboardEvent): boolean {
  if ([...event.key].length !== 1 || event.metaKey) return false
  if (!event.ctrlKey && !event.altKey) return true
  return event.ctrlKey ? event.altKey : isMac()
}

function sortIcon(column: string): string | null {
  if (props.sort?.column !== column) return null
  return props.sort.direction === 'ASC' ? 'mdi-arrow-up' : 'mdi-arrow-down'
}

function ariaSort(column: string): 'ascending' | 'descending' | 'none' {
  if (props.sort?.column !== column) return 'none'
  return props.sort.direction === 'ASC' ? 'ascending' : 'descending'
}

const root = ref<HTMLElement | null>(null)
const menu = ref<InstanceType<typeof ContextMenu> | null>(null)

const shortcut = (keys: string): string => (isMac() ? `⌘${keys}` : `Ctrl+${keys}`)

function copyItems(): MenuAction[] {
  const formats: CopyFormat[] = ['csv', 'json', 'insert', 'update', 'in', 'markdown']
  const canUpdate = copyContext.value.keyColumns.length > 0
  return [
    {
      key: 'copy',
      label: 'Copiar',
      icon: 'mdi-content-copy',
      hint: shortcut('C'),
      action: () => copySelection('tsv')
    },
    {
      key: 'copy-header',
      label: 'Copiar con encabezados',
      icon: 'mdi-table-headers-eye',
      hint: isMac() ? '⇧⌘C' : 'Ctrl+Mayús+C',
      action: () => copySelection('tsv', true)
    },
    {
      key: 'copy-as',
      label: 'Copiar como',
      icon: 'mdi-code-braces',
      children: formats
        .filter((f) => f !== 'update' || canUpdate)
        .map((f) => ({
          key: `copy-${f}`,
          label: COPY_FORMAT_LABELS[f],
          action: () => copySelection(f)
        }))
    }
  ]
}

function exportItems(): MenuAction[] {
  if (!props.exportable) return []
  return [
    { key: 'd-export', label: '', divider: true },
    {
      key: 'export-selection',
      label: 'Exportar selección…',
      icon: 'mdi-file-export-outline',
      disabled: !copyRegion(),
      action: () => emit('export', 'selection')
    },
    {
      key: 'export-all',
      label: 'Exportar…',
      icon: 'mdi-file-export-outline',
      action: () => emit('export', 'all')
    }
  ]
}

function openMenu(event: MouseEvent, extra: MenuAction[] = [], lead: MenuAction[] = []): void {
  menu.value?.show(event, [
    ...lead,
    ...copyItems(),
    ...exportItems(),
    { key: 'd-select', label: '', divider: true },
    {
      key: 'select-all',
      label: 'Seleccionar todo',
      icon: 'mdi-select-all',
      hint: shortcut('A'),
      action: selectAll
    },
    ...extra
  ])
}

/** Right-click on a cell: outside the selection it selects that cell first. */
function cellMenu(event: MouseEvent, uid: string, col: number, index: number): void {
  if (editing.value) return
  event.preventDefault()
  if (!selRegion.value || !inRegionOrSingle(index, col)) activate({ uid, col })
  const fk = fkOf(col)
  const row = props.rows.find((r) => r.uid === uid)
  const lead: MenuAction[] =
    fk && !props.readonly
      ? [
          {
            key: 'fk-pick',
            label: `Elegir de «${fk.table}»…`,
            icon: 'mdi-link-variant',
            hint: 'Alt+↓',
            disabled: !canPick(row, col),
            action: () => openPicker(uid, col)
          },
          { key: 'd-fk', label: '', divider: true }
        ]
      : []
  openMenu(event, [], lead)
}
function inRegionOrSingle(index: number, col: number): boolean {
  const region = selRegion.value
  return !!region && region.rows.includes(index) && region.cols.includes(col)
}

function headerMenu(event: MouseEvent, col: number): void {
  event.preventDefault()
  if (!(wholeColumns.value && regionCols.value.has(col)))
    applySelection(clickColumn(NO_SELECTION, col))
  const name = props.columns[col].name
  const sorted = props.sort?.column === name ? props.sort.direction : null
  openMenu(event, [
    { key: 'd-sort', label: '', divider: true },
    {
      key: 'sort-asc',
      label: 'Ordenar ascendente',
      icon: 'mdi-sort-ascending',
      disabled: sorted === 'ASC',
      action: () => emit('sort', name, 'ASC')
    },
    {
      key: 'sort-desc',
      label: 'Ordenar descendente',
      icon: 'mdi-sort-descending',
      disabled: sorted === 'DESC',
      action: () => emit('sort', name, 'DESC')
    },
    {
      key: 'sort-none',
      label: 'Quitar orden',
      icon: 'mdi-sort-variant-remove',
      disabled: !sorted,
      action: () => emit('sort', name, null)
    }
  ])
}

function gutterMenu(event: MouseEvent, index: number): void {
  event.preventDefault()
  const uid = props.rows[index].uid
  if (!(sel.value.kind === 'rows' && sel.value.uids.includes(uid)) && sel.value.kind !== 'all')
    applySelection(clickRow(NO_SELECTION, uid, uids.value))
  openMenu(event)
}

/** Brings the failed row into view when an apply error points at it. */
async function revealError(): Promise<void> {
  if (!props.errorRow) return
  await nextTick()
  const el =
    root.value?.querySelector('tr.row-error td.cell-error') ??
    root.value?.querySelector('tr.row-error')
  el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}
watch(() => [props.errorRow, props.errorCol], revealError)

defineExpose({ startEdit, revealError, autoFit, selectionSnapshot, selectAll, fillNull })
</script>

<template>
  <div
    ref="root"
    class="editable-grid"
    tabindex="0"
    role="grid"
    :aria-rowcount="rows.length"
    :aria-multiselectable="true"
    @keydown="onGridKey"
    @copy="onCopyEvent"
  >
    <table>
      <thead>
        <tr>
          <th
            class="col-index"
            scope="col"
            title="Seleccionar todo"
            :class="{ 'is-all': sel.kind === 'all' }"
            data-test="select-all"
            @click="selectAll"
            @contextmenu.prevent="openMenu($event)"
          >
            #
          </th>
          <th
            v-for="(col, c) in columns"
            :key="c"
            scope="col"
            :class="[
              `kind-${kinds[c]}`,
              {
                'is-sorted': !!sortIcon(col.name),
                'col-selected': wholeColumns && regionCols.has(c),
                'col-in-range': !wholeColumns && regionCols.has(c)
              }
            ]"
            :aria-sort="ariaSort(col.name)"
            :aria-selected="wholeColumns && regionCols.has(c)"
            :title="`${col.name} · ${col.type}`"
            :style="colStyles[c]"
            :data-col="c"
            :data-test="`header-${col.name}`"
            @click="clickHeader($event, c)"
            @contextmenu="headerMenu($event, c)"
          >
            <span class="header-cell">
              <v-icon
                v-if="primaryKey.includes(col.name)"
                icon="mdi-key-variant"
                size="13"
                class="header-cell__key"
                aria-label="Clave primaria"
              />
              <v-icon
                v-if="fkOf(c)"
                icon="mdi-link-variant"
                size="13"
                class="header-cell__fk"
                :aria-label="`Clave foránea: ${foreignKeyLabel(fkOf(c)!)}`"
                :title="`Clave foránea → ${foreignKeyLabel(fkOf(c)!)}`"
                :data-test="`fk-icon-${col.name}`"
              />
              <v-icon
                v-if="!readonly && col.locked && col.locked !== 'rowid'"
                icon="mdi-lock-outline"
                size="12"
                class="header-cell__lock"
                :aria-label="`No editable: ${col.locked}`"
                :title="`No editable: ${col.locked}`"
                :data-test="`lock-icon-${col.name}`"
              />
              <span class="header-cell__name">{{ col.name }}</span>
              <button
                type="button"
                class="header-cell__sort"
                :class="{ 'is-sorted': !!sortIcon(col.name) }"
                :aria-label="
                  sort?.column === col.name
                    ? sort.direction === 'ASC'
                      ? `Ordenado ascendente por ${col.name}: ordenar descendente`
                      : `Ordenado descendente por ${col.name}: quitar orden`
                    : `Ordenar por ${col.name}`
                "
                :title="sortIcon(col.name) ? 'Cambiar el orden' : 'Ordenar'"
                :data-test="`sort-${col.name}`"
                @click.stop="emit('sort', col.name)"
              >
                <v-icon :icon="sortIcon(col.name) ?? 'mdi-swap-vertical'" size="13" />
              </button>
            </span>
            <span
              class="col-resizer"
              role="separator"
              aria-orientation="vertical"
              :aria-label="`Redimensionar ${col.name} (doble clic: ajustar al contenido)`"
              :data-test="`resize-${col.name}`"
              @pointerdown.stop.prevent="startResize($event, c)"
              @click.stop
              @dblclick.stop="autoFit(c)"
            />
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(row, index) in rows"
          :key="row.uid"
          :class="{
            'row-selected': rowHighlighted(row.uid),
            'row-target': selected.includes(row.uid) && !rowHighlighted(row.uid),
            'row-in-range': regionRows.has(index) && sel.kind !== 'rows',
            'row-deleted': row.deleted,
            'row-new': !row.original,
            'row-error': !!errorRow && row.uid === errorRow
          }"
          :data-test="`row-${index}`"
        >
          <td
            class="col-index"
            @click="selectRow($event, index)"
            @contextmenu="gutterMenu($event, index)"
          >
            {{ row.original ? (offset ?? 0) + index + 1 : '*' }}
          </td>
          <td
            v-for="(col, c) in columns"
            :key="c"
            :class="[
              `kind-${kinds[c]}`,
              {
                'cell-changed': isCellChanged(row, c),
                'cell-active': isActive(row.uid, c),
                'cell-selected': inRegion(index, c),
                'cell-null': row.values[c] === null,
                'cell-editing': isEditing(row.uid, c),
                'cell-locked': isLocked(row, c),
                'cell-error': !!errorRow && row.uid === errorRow && errorCol === c
              }
            ]"
            :style="colStyles[c]"
            :data-col="c"
            :data-test="`cell-${index}-${c}`"
            @mousedown="startDrag($event, row.uid, c)"
            @mouseenter="dragOver(row.uid, c)"
            @click="clickCell($event, row.uid, c)"
            @dblclick="startEdit(row.uid, c)"
            @contextmenu="cellMenu($event, row.uid, c, index)"
          >
            <!--
              The value stays in the flow (hidden while editing) so the column keeps
              its width and the row its height; the editor overlays the cell box.
            -->
            <span
              class="cell-value"
              :class="{ 'is-sizer': isEditing(row.uid, c) }"
              :title="isEditing(row.uid, c) ? undefined : cellTitle(row, c)"
              :aria-hidden="isEditing(row.uid, c) || undefined"
              >{{ displayCell(row.values[c]) }}</span
            >
            <span
              v-if="isEditing(row.uid, c)"
              class="cell-editor"
              :class="{ 'is-temporal': !!specs[c] || !!enums[c] }"
              data-test="cell-editor"
            >
              <TemporalInput
                v-if="specs[c]"
                ref="temporalRef"
                v-model="draft"
                :spec="specs[c]!"
                :nullable="nullable(c)"
                :label="editorLabel(col.name)"
                :placeholder="row.values[c] === null ? 'NULL' : undefined"
                :from-typing="typed"
                autofocus
                @update:model-value="typed = true"
                @commit="onTemporalCommit"
                @cancel="cancelTemporal"
                @leave="onTemporalLeave"
                @keydown="onTemporalKey"
              />
              <EnumInput
                v-else-if="enums[c]"
                ref="enumRef"
                v-model="draft"
                :options="enums[c]!"
                :nullable="nullable(c)"
                :label="editorLabel(col.name)"
                :placeholder="row.values[c] === null ? 'NULL' : undefined"
                :from-typing="typed"
                autofocus
                @update:model-value="typed = true"
                @commit="onTemporalCommit"
                @cancel="cancelTemporal"
                @leave="onTemporalLeave"
                @keydown="onTemporalKey"
              />
              <input
                v-else
                ref="inputRef"
                v-model="draft"
                class="cell-input"
                :aria-label="editorLabel(col.name)"
                data-test="cell-input"
                :placeholder="row.values[c] === null ? 'NULL' : undefined"
                @input="typed = true"
                @keydown="onInputKey"
                @blur="commit"
              />
              <span v-if="fill" class="cell-fill" aria-hidden="true" data-test="cell-fill">
                <v-icon icon="mdi-checkbox-multiple-outline" size="12" />
                Se aplica a {{ fill.length }} celdas
              </span>
            </span>
            <button
              v-else-if="isActive(row.uid, c) && canPick(row, c)"
              type="button"
              class="cell-action"
              tabindex="-1"
              :title="`Elegir de «${fkOf(c)!.table}» (Alt+↓)`"
              :aria-label="`Elegir ${col.name} de ${fkOf(c)!.table}`"
              data-test="fk-open"
              @mousedown.stop.prevent
              @click.stop="openPicker(row.uid, c)"
              @dblclick.stop
            >
              <v-icon icon="mdi-link-variant" size="14" />
            </button>
            <button
              v-else-if="
                isActive(row.uid, c) && enums[c] && !readonly && !row.deleted && !isLocked(row, c)
              "
              type="button"
              class="cell-action"
              tabindex="-1"
              title="Elegir un valor (Alt+↓)"
              :aria-label="`Elegir el valor de ${col.name}`"
              data-test="enum-open-cell"
              @mousedown.stop.prevent
              @click.stop="startEdit(row.uid, c)"
              @dblclick.stop
            >
              <v-icon icon="mdi-chevron-down" size="16" />
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <ContextMenu ref="menu" />
    <v-menu
      :model-value="!!picker"
      :target="picker?.target"
      location="bottom start"
      :close-on-content-click="false"
      @update:model-value="(open: boolean) => !open && closePicker()"
    >
      <ForeignKeyPicker
        v-if="picker && connectionId"
        :key="`${picker.uid}:${picker.col}`"
        :connection-id="connectionId"
        :fk="picker.fk"
        :current="pickerCurrent"
        :nullable="pickerNullable"
        @choose="onPicked"
        @close="closePicker"
      />
    </v-menu>
  </div>
</template>

<style scoped>
.editable-grid {
  --grid-row-h: var(--nd-row-h);
  /* Amber glass for pending edits (no dedicated token: derived from --nd-warning). */
  --grid-changed-bg: color-mix(in srgb, var(--nd-warning) 13%, transparent);
  --grid-changed-ring: color-mix(in srgb, var(--nd-warning) 45%, transparent);

  overflow: auto;
  height: 100%;
  outline: none;
  font-family: var(--nd-font-ui);
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
}
.editable-grid:focus-visible {
  box-shadow: none;
}
table {
  border-collapse: separate;
  border-spacing: 0;
  min-width: 100%;
}
th,
td {
  border-right: 1px solid var(--nd-hairline);
  border-bottom: 1px solid var(--nd-hairline);
  padding: 0 12px;
  white-space: nowrap;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  height: var(--grid-row-h);
  text-align: left;
  transition: background-color var(--nd-dur-fast) var(--nd-ease);
}
th:last-child,
td:last-child {
  border-right: none;
}
/*
 * Column sizing (layout only): real columns shrink to their content and a
 * trailing pseudo cell absorbs the spare width, instead of the browser
 * spreading it evenly across every column.
 */
th:not(.col-index),
td:not(.col-index) {
  width: 1%;
  min-width: 56px;
}
tr::after {
  content: '';
  display: table-cell;
  border-bottom: 1px solid var(--nd-hairline);
}
thead tr::after {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--nd-bg-panel);
  border-bottom: none;
  box-shadow: inset 0 -1px 0 var(--nd-border);
}
tbody tr:hover::after {
  background: var(--nd-hover);
}
tbody tr.row-selected::after {
  background: var(--nd-selected);
}
tbody tr.row-new::after {
  background: var(--nd-success-soft);
}
tbody tr.row-deleted::after {
  background: var(--nd-error-soft);
}
.cell-value {
  display: inline-block;
  max-width: var(--col-w, 320px);
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
}

/* ---- Column resize handle ---- */
.col-resizer {
  position: absolute;
  top: 0;
  right: -3px;
  z-index: 2;
  width: 7px;
  height: 100%;
  cursor: col-resize;
  touch-action: none;
}
.col-resizer::after {
  content: '';
  position: absolute;
  top: 25%;
  bottom: 25%;
  left: 3px;
  width: 1px;
  background: transparent;
  transition: background var(--nd-dur) var(--nd-ease);
}
th:hover .col-resizer::after {
  background: var(--nd-border-strong);
}
.col-resizer:hover::after,
.col-resizer:active::after {
  background: var(--nd-accent);
}

/* ---- Header ---- */
th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--nd-bg-panel);
  box-shadow: inset 0 -1px 0 var(--nd-border);
  border-bottom: none;
  color: var(--nd-text-2);
  font-size: var(--nd-fs-small);
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}
th:hover {
  color: var(--nd-text);
  background: color-mix(in srgb, var(--nd-bg-panel) 100%, var(--nd-text) 4%);
}
th.is-sorted {
  color: var(--nd-text);
}
.header-cell {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
}
.header-cell__name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.header-cell__key {
  color: var(--nd-warning);
  opacity: 0.9;
}
.header-cell__fk {
  color: var(--nd-accent);
  opacity: 0.85;
}
.header-cell__lock {
  color: var(--nd-text-muted);
}
/* «Elegir de <tabla>» / ENUM list button of the active cell, over its right edge. */
td.cell-active {
  position: relative;
}
.cell-action {
  position: absolute;
  top: 50%;
  right: 3px;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: var(--nd-radius-sm);
  color: var(--nd-accent);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
  cursor: pointer;
}
.cell-action:hover {
  background: color-mix(in srgb, var(--nd-bg-raised) 100%, var(--nd-accent) 18%);
}
.header-cell__sort {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: 2px;
  padding: 0;
  border: none;
  border-radius: var(--nd-radius-sm);
  background: transparent;
  color: var(--nd-text-muted);
  cursor: pointer;
  /* Visible when the column is sorted; on hover or keyboard focus otherwise. */
  opacity: 0;
  transition: opacity var(--nd-dur-fast) var(--nd-ease);
}
th:hover .header-cell__sort,
.header-cell__sort:focus-visible,
.header-cell__sort.is-sorted {
  opacity: 1;
}
.header-cell__sort.is-sorted {
  color: var(--nd-accent);
}
.header-cell__sort:hover {
  color: var(--nd-text);
  background: var(--nd-hover);
}
.header-cell__sort:focus-visible {
  outline: 1px solid var(--nd-accent);
}

/* ---- Selection (cells, whole columns, gutter rows) ---- */
td {
  /* Dragging selects cells, not text; the editor input keeps its own selection. */
  user-select: none;
}
tbody tr td.cell-selected,
tbody tr:hover td.cell-selected {
  background: rgba(var(--nd-accent-rgb), 0.13);
}
th.col-selected {
  color: var(--nd-accent);
  background: color-mix(in srgb, var(--nd-bg-panel) 100%, var(--nd-accent) 14%);
  box-shadow: inset 0 -2px 0 var(--nd-accent);
}
th.col-in-range {
  color: var(--nd-text);
  background: color-mix(in srgb, var(--nd-bg-panel) 100%, var(--nd-accent) 7%);
}
th.col-index.is-all {
  color: var(--nd-accent);
  background: color-mix(in srgb, var(--nd-bg-panel) 100%, var(--nd-accent) 14%);
}
tbody tr.row-in-range .col-index {
  color: var(--nd-accent);
  background: color-mix(in srgb, var(--nd-bg-panel) 100%, var(--nd-accent) 7%);
}
/* The row «Eliminar» works on when the highlight shows a wider selection. */
tbody tr.row-target .col-index {
  box-shadow: inset 2px 0 0 var(--nd-accent);
}
th.kind-number {
  text-align: right;
}

/* ---- Cells ---- */
td.kind-number {
  font-family: var(--nd-font-mono);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
td.kind-temporal {
  font-family: var(--nd-font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--nd-text-2);
}
td.kind-number,
td.kind-temporal {
  font-size: var(--nd-fs-small);
}
tbody tr:hover td {
  background: var(--nd-hover);
}

/* ---- Row number gutter ---- */
.col-index {
  width: 52px;
  min-width: 52px;
  padding: 0 10px 0 8px;
  text-align: right;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--nd-text-muted);
  cursor: pointer;
  user-select: none;
  position: sticky;
  left: 0;
  background: var(--nd-bg-panel);
  border-right: 1px solid var(--nd-border);
}
th.col-index {
  z-index: 2;
  font-family: var(--nd-font-ui);
  font-size: var(--nd-fs-small);
  color: var(--nd-text-muted);
}
tbody tr:hover .col-index {
  color: var(--nd-text-2);
  background: color-mix(in srgb, var(--nd-bg-panel) 100%, var(--nd-text) 4%);
}

/* ---- Row states ---- */
.row-selected td {
  background: var(--nd-selected);
}
tbody tr.row-selected:hover td {
  background: color-mix(in srgb, var(--nd-selected) 100%, var(--nd-text) 3%);
}
.row-selected .col-index,
tbody tr.row-selected:hover .col-index {
  color: var(--nd-accent);
  background: color-mix(in srgb, var(--nd-bg-panel) 100%, var(--nd-accent) 10%);
  box-shadow: inset 2px 0 0 var(--nd-accent);
}
.row-new td {
  background: var(--nd-success-soft);
}
.row-new .col-index {
  color: var(--nd-success);
  box-shadow: inset 2px 0 0 var(--nd-success);
}
.row-deleted td {
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--nd-error) 70%, transparent);
  color: var(--nd-text-muted);
  background: var(--nd-error-soft);
}
.row-deleted .col-index {
  color: var(--nd-error);
  box-shadow: inset 2px 0 0 var(--nd-error);
}
/* Change that made the last apply fail. */
.row-error .col-index {
  color: var(--nd-error);
  box-shadow: inset 3px 0 0 var(--nd-error);
}
tbody tr.row-error td:not(.cell-changed):not(.col-index) {
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--nd-error) 45%, transparent),
    inset 0 -1px 0 color-mix(in srgb, var(--nd-error) 45%, transparent);
}
tbody tr.row-error td.cell-error {
  background: var(--nd-error-soft) !important;
  box-shadow: inset 0 0 0 2px var(--nd-error);
}

/* ---- Cell states ---- */
td.cell-changed {
  position: relative;
  background: var(--grid-changed-bg) !important;
  box-shadow: inset 0 0 0 1px var(--grid-changed-ring);
}
td.cell-changed::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  border-style: solid;
  border-width: 0 6px 6px 0;
  border-color: transparent var(--nd-warning) transparent transparent;
}
td.cell-active {
  box-shadow:
    inset 0 0 0 1px var(--nd-accent),
    inset 0 0 12px rgba(var(--nd-accent-rgb), 0.18);
}
td.cell-changed.cell-active {
  box-shadow:
    inset 0 0 0 1px var(--nd-accent),
    inset 0 0 0 2px var(--grid-changed-ring);
}
td.cell-null .cell-value {
  font-style: italic;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
td.cell-locked .cell-value {
  color: var(--nd-text-muted);
}
td.cell-editing {
  /* Same padding as any cell: the hidden value keeps the column width unchanged. */
  background: var(--nd-bg-input) !important;
  box-shadow: var(--nd-glow);
  position: relative;
  z-index: 2;
  overflow: visible;
}
.cell-value.is-sizer {
  visibility: hidden;
}
.cell-editor {
  position: absolute;
  inset: 0;
  display: flex;
}
/* Room for the calendar button without squeezing the value: it overhangs the next cell. */
.cell-editor.is-temporal {
  right: auto;
  width: calc(100% + 26px);
  background: var(--nd-bg-raised);
  box-shadow: inset 0 0 0 1px var(--nd-accent);
  border-radius: 0 var(--nd-radius-sm) var(--nd-radius-sm) 0;
}
.cell-input {
  width: 100%;
  height: 100%;
  padding: 0 12px;
  background: transparent;
  color: var(--nd-text);
  font: inherit;
  border: none;
  outline: none;
  box-shadow: inset 0 0 0 1px var(--nd-accent);
}
/* How many selected cells the editor writes to, just above it (lists open below). */
.cell-fill {
  position: absolute;
  bottom: calc(100% + 3px);
  left: -1px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: var(--nd-radius-pill);
  background: var(--nd-accent);
  color: var(--nd-on-accent);
  font-size: var(--nd-fs-xs);
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
}
.cell-input::placeholder {
  color: var(--nd-text-muted);
  font-style: italic;
}
.cell-input:focus-visible {
  box-shadow: inset 0 0 0 1px var(--nd-accent);
}
</style>
