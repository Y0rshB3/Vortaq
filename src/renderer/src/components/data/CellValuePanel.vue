<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CellValue, ColumnInfo, QueryColumn } from '@shared/types'
import { useNotify } from '@renderer/composables/useNotify'
import {
  HIGHLIGHT_LIMIT,
  binaryBytes,
  byteLength,
  displayColumnType,
  formatBytes,
  hexDump,
  isBinaryValue,
  isJsonText,
  jsonTokens,
  prettyJson
} from './cellValue'
import {
  MAX_RATIO,
  MIN_PANEL_PX,
  useValuePanelPref,
  type ValuePanelView
} from './useValuePanelPref'

/**
 * Navicat "Texto" value view: the full value of the selected cell with its
 * size, JSON pretty printed and highlighted, binary as hex, NULL as a state.
 * In an editable grid the text can be edited: the change goes into the same
 * pending edits as the grid (Aplicar / Descartar / Cmd+S).
 */
const props = defineProps<{
  /** Selected column, or null when no cell is selected. */
  column: QueryColumn | null
  info?: ColumnInfo | null
  value: CellValue
  editable: boolean
  /** The cell holds an unapplied change. */
  changed?: boolean
  /** Host view: each one remembers its own splitter position. */
  view?: ValuePanelView
}>()

const emit = defineEmits<{ edit: [value: CellValue] }>()

const pref = useValuePanelPref()
const notify = useNotify()

const isNull = computed(() => props.value === null)
const text = computed(() =>
  props.value === null
    ? ''
    : typeof props.value === 'boolean'
      ? props.value
        ? '1'
        : '0'
      : String(props.value)
)
const binary = computed(() =>
  isBinaryValue(props.value, props.info?.columnType ?? props.column?.type)
)
const json = computed(() => !binary.value && isJsonText(props.value))
const nullable = computed(() => props.info?.nullable ?? true)
const canEdit = computed(() => props.editable && !binary.value && !!props.column)

/** Draft of the textarea; committed into the pending edits on blur / Cmd+Enter / Cmd+S. */
const draft = ref('')
const editingText = ref(false)
watch(
  () => [props.column?.name, props.value] as const,
  () => {
    draft.value = text.value
    // JSON opens in the highlighted view; anything else directly as text.
    editingText.value = false
  },
  { immediate: true }
)

const showTextarea = computed(() => !binary.value && (!json.value || editingText.value))
const pretty = computed(() => (json.value ? prettyJson(text.value) : ''))
const tokens = computed(() =>
  pretty.value.length <= HIGHLIGHT_LIMIT ? jsonTokens(pretty.value) : null
)

const size = computed(() => {
  if (props.value === null) return 'NULL'
  if (binary.value) return formatBytes(binaryBytes(text.value))
  const chars = [...text.value].length
  return `${chars} carácter(es) · ${formatBytes(byteLength(text.value))}`
})

function commit(): void {
  if (!canEdit.value) return
  if (isNull.value && draft.value === '') return
  if (draft.value !== text.value || isNull.value) emit('edit', draft.value)
}

function onKeydown(event: KeyboardEvent): void {
  const mod = event.metaKey || event.ctrlKey
  if (mod && event.key === 'Enter') {
    event.preventDefault()
    commit()
  } else if (mod && event.key.toLowerCase() === 's') {
    // Commit, then let Cmd+S bubble so the view applies the pending edits.
    commit()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    draft.value = text.value
    editingText.value = false
  }
}

function formatJson(): void {
  if (!isJsonText(draft.value)) return
  draft.value = prettyJson(draft.value)
  editingText.value = true
  commit()
}

function setNull(): void {
  emit('edit', null)
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(
      binary.value ? text.value : showTextarea.value ? draft.value : text.value
    )
    notify.success('Valor copiado')
  } catch {
    notify.warning('No se pudo copiar al portapapeles')
  }
}

/*
 * Sizing (layout only): the panel takes `ratio` of its host area (default 35 %,
 * at most 60 %) and may shrink down to its header when the area is small, so
 * the grid above (min-height in the host) is never squeezed to nothing. With
 * no cell selected only the header line is shown.
 */
const view = computed<ValuePanelView>(() => props.view ?? 'table')
const collapsed = computed(() => !props.column)
const panelStyle = computed(() =>
  collapsed.value
    ? { flex: '0 0 auto' }
    : {
        flex: `0 1 ${(pref.value.ratio[view.value] * 100).toFixed(2)}%`,
        maxHeight: `${MAX_RATIO * 100}%`
      }
)
const root = ref<HTMLElement | null>(null)

function setRatio(px: number, hostHeight: number): void {
  if (hostHeight <= 0) return
  const min = Math.min(MIN_PANEL_PX / hostHeight, MAX_RATIO)
  pref.value.ratio = {
    ...pref.value.ratio,
    [view.value]: Math.min(MAX_RATIO, Math.max(min, px / hostHeight))
  }
}

/* Splitter: drag the top edge to resize. */
function startResize(event: PointerEvent): void {
  const handle = event.currentTarget as HTMLElement
  try {
    handle.setPointerCapture?.(event.pointerId)
  } catch {
    /* synthetic or already released pointer: dragging still works while over the handle */
  }
  const host = root.value?.parentElement
  const hostHeight = host?.clientHeight ?? 0
  const startY = event.clientY
  const startH = root.value?.getBoundingClientRect().height ?? 0
  const onMove = (e: PointerEvent): void => setRatio(startH + startY - e.clientY, hostHeight)
  const onUp = (): void => {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
}
function onSplitKey(event: KeyboardEvent): void {
  const hostHeight = root.value?.parentElement?.clientHeight ?? 0
  const current = root.value?.getBoundingClientRect().height ?? 0
  const step = event.shiftKey ? 60 : 20
  if (event.key === 'ArrowUp') setRatio(current + step, hostHeight)
  else if (event.key === 'ArrowDown') setRatio(current - step, hostHeight)
  else return
  event.preventDefault()
}
</script>

<template>
  <section
    ref="root"
    class="vpanel"
    :class="{ 'is-changed': changed, 'is-collapsed': collapsed }"
    :style="panelStyle"
    aria-label="Valor de la celda"
    data-test="value-panel"
  >
    <div
      v-if="!collapsed"
      class="vpanel__splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Redimensionar panel de valor"
      tabindex="0"
      @pointerdown.prevent="startResize"
      @keydown="onSplitKey"
    />
    <header class="vpanel__head">
      <v-icon icon="mdi-text-box-outline" size="14" class="vpanel__icon" />
      <template v-if="column">
        <span class="vpanel__col" data-test="value-panel-column">{{ column.name }}</span>
        <span class="vpanel__meta" data-test="value-panel-type"
          >· {{ info?.columnType ? displayColumnType(info.columnType) : column.type }}</span
        >
        <span class="vpanel__meta" data-test="value-panel-size">· {{ size }}</span>
        <span
          v-if="json && !/json/i.test(info?.columnType ?? column.type)"
          class="nd-pill nd-pill--info vpanel__pill"
          >JSON</span
        >
        <span v-if="changed" class="nd-pill vpanel__pill vpanel__pill--changed">Sin aplicar</span>
      </template>
      <span v-else class="vpanel__meta">Selecciona una celda para ver su valor completo</span>
      <span class="nd-viewbar__spacer" />
      <template v-if="column">
        <v-btn
          size="x-small"
          variant="text"
          :icon="pref.wrap ? 'mdi-wrap' : 'mdi-wrap-disabled'"
          aria-label="Ajustar líneas"
          :aria-pressed="pref.wrap"
          title="Ajustar líneas"
          data-test="value-panel-wrap"
          @click="pref.wrap = !pref.wrap"
        />
        <v-btn
          v-if="json && canEdit"
          size="x-small"
          variant="text"
          prepend-icon="mdi-code-json"
          title="Formatea el JSON con sangría y lo deja como cambio pendiente"
          data-test="value-panel-format"
          @click="formatJson"
          >Formatear JSON</v-btn
        >
        <v-btn
          v-if="json && canEdit && !editingText"
          size="x-small"
          variant="text"
          icon="mdi-pencil-outline"
          title="Editar el texto original"
          aria-label="Editar"
          data-test="value-panel-edit"
          @click="editingText = true"
        />
        <v-btn
          v-if="canEdit && nullable && !isNull"
          size="x-small"
          variant="text"
          title="Poner la celda a NULL"
          data-test="value-panel-null"
          @click="setNull"
          >NULL</v-btn
        >
        <v-btn
          size="x-small"
          variant="text"
          icon="mdi-content-copy"
          title="Copiar"
          aria-label="Copiar"
          data-test="value-panel-copy"
          @click="copy"
        />
      </template>
    </header>

    <div v-if="!collapsed" class="vpanel__body">
      <pre
        v-if="binary"
        class="vpanel__pre"
        :class="{ 'is-wrap': pref.wrap }"
        data-test="value-panel-hex"
        >{{ hexDump(text) }}</pre>
      <pre
        v-else-if="!showTextarea"
        class="vpanel__pre vpanel__json"
        :class="{ 'is-wrap': pref.wrap }"
        data-test="value-panel-json"
        @dblclick="canEdit && (editingText = true)"
      ><template v-if="tokens"><span v-for="(t, i) in tokens" :key="i" :class="`j-${t.kind}`">{{ t.text }}</span></template><template v-else>{{ pretty }}</template></pre>
      <textarea
        v-else
        v-model="draft"
        class="vpanel__text"
        :class="{ 'is-wrap': pref.wrap, 'is-null': isNull && draft === '' }"
        :readonly="!canEdit"
        :placeholder="isNull ? '(NULL)' : ''"
        spellcheck="false"
        :aria-label="`Valor de ${column?.name ?? ''}`"
        data-test="value-panel-text"
        @blur="commit"
        @keydown="onKeydown"
      />
    </div>
  </section>
</template>

<style scoped>
.vpanel {
  position: relative;
  display: flex;
  flex-direction: column;
  /* flex / max-height come from panelStyle; it can shrink to its header line. */
  min-height: 31px;
  border-top: 1px solid var(--nd-border);
  background: var(--nd-bg-sunken);
}
.vpanel__splitter {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  z-index: 3;
  height: 8px;
  cursor: row-resize;
  touch-action: none;
}
.vpanel__splitter:hover,
.vpanel__splitter:focus-visible {
  background: linear-gradient(
    to bottom,
    transparent 3px,
    rgba(var(--nd-accent-rgb), 0.6) 3px,
    rgba(var(--nd-accent-rgb), 0.6) 5px,
    transparent 5px
  );
  outline: none;
}
.vpanel__head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  min-height: 30px;
  padding: 2px 8px 2px 10px;
  border-bottom: 1px solid var(--nd-hairline);
  background: var(--nd-bg-raised);
  font-size: var(--nd-fs-xs);
  white-space: nowrap;
  overflow: hidden;
}
.vpanel__icon {
  color: var(--nd-text-muted);
}
.vpanel__col {
  font-weight: 600;
  color: var(--nd-text);
}
.vpanel__meta {
  font-family: var(--nd-font-mono);
  color: var(--nd-text-2);
}
.vpanel__pill {
  height: 16px;
}
.vpanel__pill--changed {
  color: var(--nd-warning);
  border-color: color-mix(in srgb, var(--nd-warning) 40%, transparent);
}
.vpanel__head :deep(.v-btn) {
  text-transform: none;
  letter-spacing: normal;
  font-size: var(--nd-fs-xs);
}
.vpanel__body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  /* A panel squeezed to its header must not paint its text over the footer below. */
  overflow: hidden;
}
.vpanel__pre,
.vpanel__text {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: 8px 12px;
  overflow: auto;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  line-height: 1.5;
  color: var(--nd-text);
  white-space: pre;
  tab-size: 2;
  box-sizing: border-box;
}
.vpanel__pre.is-wrap,
.vpanel__text.is-wrap {
  white-space: pre-wrap;
  word-break: break-word;
}
.vpanel__text {
  width: 100%;
  height: 100%;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
}
.vpanel.is-changed .vpanel__text,
.vpanel.is-changed .vpanel__pre {
  background: color-mix(in srgb, var(--nd-warning) 7%, transparent);
}
.vpanel__text.is-null::placeholder {
  font-style: italic;
  color: var(--nd-text-muted);
}
.vpanel__text[readonly] {
  color: var(--nd-text-2);
}
.j-key {
  color: var(--nd-accent);
}
.j-string {
  color: var(--nd-warning);
}
.j-number {
  color: var(--nd-violet);
}
.j-literal {
  color: var(--nd-success);
}
.j-punct {
  color: var(--nd-text-2);
}
</style>
