<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CellValue, QueryColumn } from '@shared/types'
import { api } from '@renderer/api'
import { errorMessage } from '@renderer/composables/useNotify'
import { formatNumber } from '@renderer/utils/format'
import { chosenValues, foreignKeySearch, type GridForeignKey } from './foreignKeys'
import { displayCell } from './rowEditing'

/**
 * «Elegir de <tabla>»: rows of the table a foreign key references, read with
 * db:tableData (a plain read: the structured search filter is escaped and its
 * columns checked by main). Choosing a row emits its referenced values for
 * the key's grid columns; nothing is written until the user applies the grid.
 */
const props = defineProps<{
  connectionId: string
  fk: GridForeignKey
  /** The row's current values of the key columns (the matching row is marked). */
  current: readonly (string | null)[]
  /** Every key column accepts NULL: offer «NULL». */
  nullable: boolean
}>()

const emit = defineEmits<{
  choose: [values: (string | null)[]]
  close: []
}>()

const PAGE = 50
/** Characters of a cell shown in the list (the full value is in its tooltip). */
const CELL_CHARS = 60

const search = ref('')
const columns = ref<QueryColumn[]>([])
const rows = ref<CellValue[][]>([])
const total = ref<number | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const highlight = ref(0)
const input = ref<HTMLInputElement | null>(null)
let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null

/** Referenced columns first, then the rest in table order. */
const order = computed(() => {
  const idx = columns.value.map((_, i) => i)
  const ref = props.fk.refColumns
    .map((r) => columns.value.findIndex((c) => c.name === r))
    .filter((i) => i >= 0)
  return [...ref, ...idx.filter((i) => !ref.includes(i))]
})
const hasMore = computed(() =>
  total.value !== null ? rows.value.length < total.value : rows.value.length % PAGE === 0
)

function isCurrent(row: CellValue[]): boolean {
  const values = chosenValues(props.fk, columns.value, row)
  return !!values && values.every((v, i) => v === props.current[i])
}

function cellText(value: CellValue): string {
  const text = displayCell(value)
  return text.length > CELL_CHARS ? `${text.slice(0, CELL_CHARS)}…` : text
}

async function load(append = false): Promise<void> {
  const mine = ++seq
  loading.value = true
  error.value = null
  try {
    const filter = foreignKeySearch(columns.value, props.fk.refColumns, search.value)
    const page = await api.db.tableData(props.connectionId, {
      schema: props.fk.schema,
      table: props.fk.table,
      limit: PAGE,
      offset: append ? rows.value.length : 0,
      orderBy: { column: props.fk.refColumns[0], direction: 'ASC' },
      ...(filter ? { filter } : {})
    })
    if (mine !== seq) return
    columns.value = page.columns
    rows.value = append ? [...rows.value, ...page.rows] : page.rows
    total.value = page.total
    if (!append) {
      const current = rows.value.findIndex(isCurrent)
      highlight.value = current >= 0 ? current : 0
      void nextTick(scrollToHighlight)
    }
  } catch (err) {
    if (mine === seq) error.value = errorMessage(err)
  } finally {
    if (mine === seq) loading.value = false
  }
}

function onSearch(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void load(), 300)
}
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

function choose(row: CellValue[]): void {
  const values = chosenValues(props.fk, columns.value, row)
  if (values) emit('choose', values)
}

function scrollToHighlight(): void {
  const el = document.querySelector<HTMLElement>(`[data-fk-picker] [data-row="${highlight.value}"]`)
  el?.scrollIntoView?.({ block: 'nearest' })
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const n = rows.value.length
    if (!n) return
    highlight.value = (highlight.value + (event.key === 'ArrowDown' ? 1 : -1) + n) % n
    void nextTick(scrollToHighlight)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (timer) {
      // Enter right after typing: search now instead of choosing a stale row.
      clearTimeout(timer)
      timer = null
      void load()
      return
    }
    const row = rows.value[highlight.value]
    if (row) choose(row)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
  event.stopPropagation()
}

onMounted(async () => {
  await load()
  input.value?.focus()
})
</script>

<template>
  <div
    class="fk-picker"
    data-fk-picker
    data-test="fk-picker"
    role="dialog"
    :aria-label="`Elegir de ${fk.table}`"
  >
    <div class="fk-picker__head">
      <v-icon icon="mdi-link-variant" size="15" aria-hidden="true" />
      <span class="fk-picker__title nd-ellipsis"
        >Elegir de <strong>{{ fk.table }}</strong></span
      >
      <span class="fk-picker__cols nd-mono nd-ellipsis">{{ fk.refColumns.join(', ') }}</span>
      <v-btn
        icon="mdi-close"
        size="x-small"
        variant="text"
        aria-label="Cerrar"
        data-test="fk-close"
        @click="emit('close')"
      />
    </div>
    <div class="fk-picker__search">
      <v-icon icon="mdi-magnify" size="15" aria-hidden="true" />
      <input
        ref="input"
        v-model="search"
        class="fk-picker__input"
        placeholder="Buscar…"
        aria-label="Buscar en la tabla relacionada"
        autocomplete="off"
        spellcheck="false"
        data-test="fk-search"
        @input="onSearch"
        @keydown="onKeydown"
      />
      <v-progress-circular v-if="loading" indeterminate size="14" width="2" />
    </div>
    <div v-if="error" class="fk-picker__error" role="alert" data-test="fk-error">
      {{ error }}
    </div>
    <div v-else class="fk-picker__table" role="listbox" :aria-label="`Filas de ${fk.table}`">
      <table v-if="columns.length">
        <thead>
          <tr>
            <th aria-hidden="true" />
            <th
              v-for="i in order"
              :key="i"
              :class="{ 'is-ref': fk.refColumns.includes(columns[i].name) }"
            >
              {{ columns[i].name }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, r) in rows"
            :key="r"
            role="option"
            :aria-selected="r === highlight"
            :class="{ 'is-highlighted': r === highlight, 'is-current': isCurrent(row) }"
            :data-row="r"
            :data-test="`fk-row-${r}`"
            @mouseenter="highlight = r"
            @mousedown.prevent
            @click="choose(row)"
          >
            <td class="fk-picker__mark">
              <v-icon v-if="isCurrent(row)" icon="mdi-check" size="13" aria-label="Valor actual" />
            </td>
            <td
              v-for="i in order"
              :key="i"
              :class="{
                'is-ref': fk.refColumns.includes(columns[i].name),
                'is-null': row[i] === null
              }"
              :title="displayCell(row[i])"
            >
              {{ cellText(row[i]) }}
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!loading && !rows.length" class="fk-picker__empty" data-test="fk-empty">
        {{ search.trim() ? 'Ninguna fila coincide con la búsqueda.' : 'La tabla no tiene filas.' }}
      </div>
    </div>
    <div class="fk-picker__foot">
      <span class="fk-picker__count nd-mono" data-test="fk-count">
        {{ formatNumber(rows.length)
        }}<template v-if="total !== null"> de {{ formatNumber(total) }}</template>
      </span>
      <v-btn
        v-if="hasMore && rows.length && !error"
        size="x-small"
        variant="text"
        :disabled="loading"
        data-test="fk-more"
        @click="load(true)"
        >Cargar más</v-btn
      >
      <span class="nd-viewbar__spacer" />
      <v-btn
        v-if="nullable"
        size="x-small"
        variant="text"
        data-test="fk-null"
        @click="
          emit(
            'choose',
            fk.cols.map(() => null)
          )
        "
        >NULL</v-btn
      >
      <v-btn size="x-small" variant="text" data-test="fk-cancel" @click="emit('close')"
        >Cancelar</v-btn
      >
    </div>
  </div>
</template>

<style scoped>
.fk-picker {
  display: flex;
  flex-direction: column;
  width: min(640px, 92vw);
  max-height: min(420px, 70vh);
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border-strong);
  box-shadow: var(--nd-shadow-2);
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
}
.fk-picker__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 6px 6px 12px;
  border-bottom: 1px solid var(--nd-hairline);
}
.fk-picker__head .v-icon {
  color: var(--nd-accent);
}
.fk-picker__title {
  min-width: 0;
}
.fk-picker__cols {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.fk-picker__search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 10px;
  padding: 0 10px;
  height: 30px;
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-input);
  border: 1px solid var(--nd-border);
  color: var(--nd-text-muted);
}
.fk-picker__search:focus-within {
  border-color: var(--nd-accent);
}
.fk-picker__input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  background: transparent;
  border: none;
  outline: none;
  color: var(--nd-text);
  font: inherit;
}
.fk-picker__table {
  flex: 1 1 auto;
  min-height: 60px;
  overflow: auto;
  border-top: 1px solid var(--nd-hairline);
  border-bottom: 1px solid var(--nd-hairline);
}
.fk-picker__table table {
  border-collapse: collapse;
  min-width: 100%;
}
.fk-picker__table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 4px 10px;
  text-align: left;
  font-weight: 600;
  font-size: var(--nd-fs-xs);
  white-space: nowrap;
  color: var(--nd-text-2);
  background: var(--nd-bg-raised);
  border-bottom: 1px solid var(--nd-border);
}
.fk-picker__table th.is-ref {
  color: var(--nd-accent);
}
.fk-picker__table td {
  padding: 3px 10px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-bottom: 1px solid var(--nd-hairline);
}
.fk-picker__table td.is-ref {
  font-family: var(--nd-font-mono);
}
.fk-picker__table td.is-null {
  font-style: italic;
  color: var(--nd-text-muted);
}
.fk-picker__table tbody tr {
  cursor: pointer;
}
.fk-picker__table tbody tr.is-highlighted {
  background: rgba(var(--nd-accent-rgb), 0.14);
}
.fk-picker__table tbody tr.is-current td.is-ref {
  color: var(--nd-accent);
}
.fk-picker__mark {
  width: 22px;
  padding-right: 0 !important;
  color: var(--nd-accent);
}
.fk-picker__empty,
.fk-picker__error {
  padding: 14px 12px;
  color: var(--nd-text-muted);
}
.fk-picker__error {
  color: var(--nd-error);
}
.fk-picker__foot {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 12px;
}
.fk-picker__count {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.nd-viewbar__spacer {
  flex: 1 1 auto;
}
</style>
