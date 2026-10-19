<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { edgeGeometries } from './edges'
import {
  HEADER_H,
  ROW_H,
  contentBounds,
  shortType,
  visibleColumns,
  type Point,
  type Positions,
  type Size
} from './layout'
import type { ModelRelation, ModelTable } from './model'

/**
 * Canvas shared by the relationship diagram and the visual query builder:
 * table boxes (HTML, at the sizes the layout computed) over the relationship
 * lines (SVG, crow's foot at the referencing end). Drag the background or
 * scroll to move around, Cmd/Ctrl + wheel (or pinch) to zoom, drag a header to
 * move a table. In `builder` mode each column has a checkbox and a handle to
 * drag a join onto another table's column, and lines can be clicked.
 */
const props = withDefaults(
  defineProps<{
    tables: ModelTable[]
    relations: ModelRelation[]
    sizes: Record<string, Size>
    keysOnly?: boolean
    mode?: 'diagram' | 'builder'
    /** Builder: checked columns per table. */
    checked?: Record<string, readonly string[]>
    /** Builder: the line whose menu is open. */
    selectedRelation?: string | null
    /** Accessible name of the canvas. */
    label: string
  }>(),
  { keysOnly: false, mode: 'diagram', checked: () => ({}), selectedRelation: null }
)

const positions = defineModel<Positions>('positions', { required: true })

const emit = defineEmits<{
  open: [table: string]
  menu: [table: string, event: MouseEvent]
  /** A table was moved by hand (its new position is in `positions`). */
  moved: [table: string]
  'toggle-column': [table: string, column: string]
  'relation-click': [name: string, event: MouseEvent]
  /** Builder: a join dragged from one column onto another table's column. */
  link: [from: { table: string; column: string }, to: { table: string; column: string }]
}>()

const MIN_SCALE = 0.2
const MAX_SCALE = 2
const viewport = ref<HTMLElement | null>(null)
const scale = ref(1)
const tx = ref(24)
const ty = ref(24)
const hovered = ref<string | null>(null)

const builder = computed(() => props.mode === 'builder')
const edges = computed(() =>
  edgeGeometries(props.relations, props.tables, positions.value, props.sizes, props.keysOnly)
)
const hot = (r: ModelRelation): boolean =>
  !!hovered.value && (r.from === hovered.value || r.to === hovered.value)
const isChecked = (table: string, column: string): boolean =>
  !!props.checked[table]?.includes(column)

/* ---------- view: pan and zoom ---------- */

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

/** Zooms keeping the world point under (cx, cy) (viewport coordinates) in place. */
function zoomAt(next: number, cx: number, cy: number): void {
  const s = clampScale(next)
  const wx = (cx - tx.value) / scale.value
  const wy = (cy - ty.value) / scale.value
  scale.value = s
  tx.value = cx - wx * s
  ty.value = cy - wy * s
}

function viewportCenter(): [number, number] {
  const r = viewport.value?.getBoundingClientRect()
  return r ? [r.width / 2, r.height / 2] : [0, 0]
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  if (event.ctrlKey || event.metaKey) {
    const r = viewport.value!.getBoundingClientRect()
    zoomAt(
      scale.value * Math.exp(-event.deltaY * 0.0015),
      event.clientX - r.left,
      event.clientY - r.top
    )
  } else {
    tx.value -= event.deltaX
    ty.value -= event.deltaY
  }
}

/** Fits every table in the view (never zooming in past 100 %). */
function fit(): void {
  const r = viewport.value?.getBoundingClientRect()
  const b = contentBounds(positions.value, props.sizes)
  if (!r || !b.w || !r.width || !r.height) return
  const pad = 40
  scale.value = clampScale(Math.min(1, (r.width - pad * 2) / b.w, (r.height - pad * 2) / b.h))
  tx.value = (r.width - b.w * scale.value) / 2 - b.x * scale.value
  ty.value = (r.height - b.h * scale.value) / 2 - b.y * scale.value
}

/** Brings one table to the centre of the view. */
function centerOn(table: string): void {
  const p = positions.value[table]
  const s = props.sizes[table]
  const r = viewport.value?.getBoundingClientRect()
  if (!p || !s || !r) return
  tx.value = r.width / 2 - (p.x + s.w / 2) * scale.value
  ty.value = r.height / 2 - (p.y + s.h / 2) * scale.value
  flash.value = table
  setTimeout(() => {
    if (flash.value === table) flash.value = null
  }, 1400)
}
const flash = ref<string | null>(null)

function zoomBy(factor: number): void {
  zoomAt(scale.value * factor, ...viewportCenter())
}

/** World coordinates of a pointer event. */
function worldPoint(event: PointerEvent | MouseEvent): Point {
  const r = viewport.value!.getBoundingClientRect()
  return {
    x: (event.clientX - r.left - tx.value) / scale.value,
    y: (event.clientY - r.top - ty.value) / scale.value
  }
}

/* ---------- dragging: background (pan), header (move), join handle (link) ---------- */

type Drag =
  | { kind: 'pan'; x: number; y: number; tx: number; ty: number }
  | { kind: 'move'; table: string; start: Point; from: Point; moved: boolean }
  | { kind: 'link'; table: string; column: string; start: Point; to: Point }
const drag = ref<Drag | null>(null)

function capture(event: PointerEvent): void {
  try {
    ;(event.currentTarget as Element).setPointerCapture?.(event.pointerId)
  } catch {
    /* synthetic events have no active pointer */
  }
}

function onBackgroundDown(event: PointerEvent): void {
  if (event.button !== 0) return
  capture(event)
  drag.value = { kind: 'pan', x: event.clientX, y: event.clientY, tx: tx.value, ty: ty.value }
}

function onHeaderDown(event: PointerEvent, table: string): void {
  if (event.button !== 0) return
  event.stopPropagation()
  capture(event)
  drag.value = {
    kind: 'move',
    table,
    start: worldPoint(event),
    from: { ...positions.value[table] },
    moved: false
  }
}

function onHandleDown(event: PointerEvent, table: string, column: string): void {
  if (event.button !== 0) return
  event.stopPropagation()
  capture(event)
  const p = worldPoint(event)
  drag.value = { kind: 'link', table, column, start: p, to: p }
}

function onPointerMove(event: PointerEvent): void {
  const d = drag.value
  if (!d) return
  if (d.kind === 'pan') {
    tx.value = d.tx + event.clientX - d.x
    ty.value = d.ty + event.clientY - d.y
  } else if (d.kind === 'move') {
    const p = worldPoint(event)
    const x = Math.round(d.from.x + p.x - d.start.x)
    const y = Math.round(d.from.y + p.y - d.start.y)
    if (!d.moved && Math.abs(p.x - d.start.x) + Math.abs(p.y - d.start.y) < 3) return
    d.moved = true
    positions.value = { ...positions.value, [d.table]: { x, y } }
  } else {
    d.to = worldPoint(event)
  }
}

function onPointerUp(event: PointerEvent): void {
  const d = drag.value
  drag.value = null
  if (!d) return
  if (d.kind === 'move' && d.moved) emit('moved', d.table)
  if (d.kind === 'link') {
    const target = document
      .elementFromPoint?.(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-col-row]')
    const table = target?.dataset.table
    const column = target?.dataset.column
    if (table && column && table !== d.table)
      emit('link', { table: d.table, column: d.column }, { table, column })
  }
}
onBeforeUnmount(() => {
  drag.value = null
})

defineExpose({ fit, centerOn, zoomBy, scale, worldPoint })
</script>

<template>
  <div
    ref="viewport"
    class="dcanvas"
    :class="{ 'is-panning': drag?.kind === 'pan' }"
    role="region"
    :aria-label="label"
    data-test="diagram-canvas"
    @wheel="onWheel"
    @pointerdown="onBackgroundDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="drag = null"
  >
    <div
      class="dcanvas__world"
      :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
    >
      <svg class="dcanvas__edges" width="1" height="1" aria-hidden="true">
        <defs>
          <marker
            id="dc-many"
            viewBox="0 0 12 12"
            refX="12"
            refY="6"
            markerWidth="12"
            markerHeight="12"
            orient="auto-start-reverse"
          >
            <path d="M1 6 L12 1 M1 6 L12 6 M1 6 L12 11" class="dcanvas__marker" />
          </marker>
          <marker
            id="dc-one"
            viewBox="0 0 12 12"
            refX="11"
            refY="6"
            markerWidth="12"
            markerHeight="12"
            orient="auto"
          >
            <path d="M7 1 L7 11 M10 1 L10 11" class="dcanvas__marker" />
          </marker>
        </defs>
        <g
          v-for="e in edges"
          :key="e.relation.name"
          class="dcanvas__edge"
          :class="{
            'is-hot': hot(e.relation),
            'is-dim': !!hovered && !hot(e.relation),
            'is-optional': e.relation.optional,
            'is-selected': selectedRelation === e.relation.name
          }"
          :data-test="`edge-${e.relation.name}`"
        >
          <path
            :d="e.path"
            class="dcanvas__line"
            marker-start="url(#dc-many)"
            marker-end="url(#dc-one)"
          />
          <path
            v-if="builder"
            :d="e.path"
            class="dcanvas__hit"
            @pointerdown.stop
            @click.stop="emit('relation-click', e.relation.name, $event)"
          >
            <title>Cambiar o quitar esta unión</title>
          </path>
          <title v-else>
            {{ e.relation.from }} ({{ e.relation.fromColumns.join(', ') }}) →
            {{ e.relation.to }} ({{ e.relation.toColumns.join(', ') }})
          </title>
        </g>
        <line
          v-if="drag?.kind === 'link'"
          :x1="drag.start.x"
          :y1="drag.start.y"
          :x2="drag.to.x"
          :y2="drag.to.y"
          class="dcanvas__linking"
        />
      </svg>
      <div
        v-for="t in tables"
        :key="t.name"
        class="dbox"
        :class="{
          'is-hovered': hovered === t.name,
          'is-flash': flash === t.name,
          'is-moving': drag?.kind === 'move' && drag.table === t.name
        }"
        :style="{
          left: `${positions[t.name]?.x ?? 0}px`,
          top: `${positions[t.name]?.y ?? 0}px`,
          width: `${sizes[t.name]?.w ?? 170}px`,
          height: `${sizes[t.name]?.h ?? HEADER_H}px`
        }"
        :data-test="`dbox-${t.name}`"
        @mouseenter="hovered = t.name"
        @mouseleave="hovered = null"
        @pointerdown.stop
      >
        <div
          class="dbox__head"
          :style="{ height: `${HEADER_H}px` }"
          tabindex="0"
          :title="builder ? t.name : `${t.name} · doble clic para abrir sus datos`"
          :data-test="`dbox-head-${t.name}`"
          @pointerdown="onHeaderDown($event, t.name)"
          @dblclick="emit('open', t.name)"
          @keydown.enter="emit('open', t.name)"
          @contextmenu.prevent="emit('menu', t.name, $event)"
        >
          <v-icon icon="mdi-table" size="14" aria-hidden="true" />
          <span class="dbox__name nd-ellipsis">{{ t.name }}</span>
        </div>
        <div
          v-for="c in visibleColumns(t, keysOnly)"
          :key="c.name"
          class="dbox__row"
          :class="{ 'is-checked': builder && isChecked(t.name, c.name) }"
          :style="{ height: `${ROW_H}px` }"
          data-col-row
          :data-table="t.name"
          :data-column="c.name"
          :data-test="`dbox-row-${t.name}-${c.name}`"
          @click="builder && emit('toggle-column', t.name, c.name)"
        >
          <input
            v-if="builder"
            type="checkbox"
            class="dbox__check"
            :checked="isChecked(t.name, c.name)"
            :aria-label="`Incluir ${t.name}.${c.name}`"
            @click.stop="emit('toggle-column', t.name, c.name)"
          />
          <span v-else class="dbox__mark">
            <v-icon
              v-if="c.primaryKey"
              icon="mdi-key-variant"
              size="12"
              class="dbox__pk"
              aria-label="Clave primaria"
            />
            <v-icon
              v-else-if="c.foreignKey"
              icon="mdi-link-variant"
              size="12"
              class="dbox__fk"
              aria-label="Clave foránea"
            />
          </span>
          <span class="dbox__col nd-ellipsis" :class="{ 'is-key': c.primaryKey }">{{
            c.name
          }}</span>
          <span class="dbox__type nd-mono">{{ shortType(c.type) }}</span>
          <span
            v-if="builder"
            class="dbox__handle"
            title="Arrastra hasta una columna de otra tabla para unirlas"
            :data-test="`dbox-handle-${t.name}-${c.name}`"
            @pointerdown="onHandleDown($event, t.name, c.name)"
            @click.stop
          >
            <v-icon icon="mdi-circle-small" size="16" aria-hidden="true" />
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dcanvas {
  position: relative;
  overflow: hidden;
  width: 100%;
  height: 100%;
  cursor: grab;
  background-color: var(--nd-bg-sunken);
  background-image: radial-gradient(var(--nd-hairline) 1px, transparent 1px);
  background-size: 22px 22px;
  touch-action: none;
  user-select: none;
}
.dcanvas.is-panning {
  cursor: grabbing;
}
.dcanvas__world {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}
.dcanvas__edges {
  position: absolute;
  top: 0;
  left: 0;
  overflow: visible;
  pointer-events: none;
}
.dcanvas__line {
  fill: none;
  stroke: var(--nd-text-muted);
  stroke-width: 1.4;
  transition: opacity var(--nd-dur-fast) var(--nd-ease);
}
.dcanvas__marker {
  fill: none;
  stroke: var(--nd-text-muted);
  stroke-width: 1.3;
}
.dcanvas__edge.is-optional .dcanvas__line {
  stroke-dasharray: 5 4;
}
.dcanvas__edge.is-hot .dcanvas__line,
.dcanvas__edge.is-selected .dcanvas__line {
  stroke: var(--nd-accent);
  stroke-width: 2;
}
.dcanvas__edge.is-dim .dcanvas__line {
  opacity: 0.25;
}
.dcanvas__hit {
  fill: none;
  stroke: transparent;
  stroke-width: 12;
  pointer-events: stroke;
  cursor: pointer;
}
.dcanvas__linking {
  stroke: var(--nd-accent);
  stroke-width: 2;
  stroke-dasharray: 4 3;
}
.dbox {
  position: absolute;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 8px;
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border-strong);
  box-shadow: var(--nd-shadow-1);
  cursor: default;
}
.dbox.is-hovered,
.dbox.is-flash {
  border-color: var(--nd-accent);
}
.dbox.is-flash {
  box-shadow: 0 0 0 3px rgba(var(--nd-accent-rgb), 0.35);
}
.dbox.is-moving {
  opacity: 0.92;
  z-index: 2;
}
.dbox__head {
  display: flex;
  align-items: center;
  flex: none;
  gap: 6px;
  padding: 0 10px;
  font-weight: 600;
  font-size: 12.5px;
  color: var(--nd-text);
  background: color-mix(in srgb, var(--nd-bg-raised) 100%, var(--nd-accent) 10%);
  border-bottom: 1px solid var(--nd-border);
  cursor: move;
}
.dbox__head .v-icon {
  color: var(--nd-accent);
}
.dbox__head:focus-visible {
  outline: 2px solid var(--nd-accent);
  outline-offset: -2px;
}
.dbox__name {
  min-width: 0;
}
.dbox__row {
  display: flex;
  align-items: center;
  flex: none;
  gap: 6px;
  padding: 0 8px 0 8px;
  font-size: 12px;
  color: var(--nd-text);
}
.dbox__row.is-checked {
  background: rgba(var(--nd-accent-rgb), 0.12);
}
.dbox__mark {
  display: inline-flex;
  justify-content: center;
  flex: none;
  width: 16px;
}
.dbox__pk {
  color: var(--nd-warning);
}
.dbox__fk {
  color: var(--nd-accent);
}
.dbox__check {
  flex: none;
  width: 13px;
  height: 13px;
  margin: 0 1px 0 2px;
  accent-color: var(--nd-accent);
  cursor: pointer;
}
.dbox__col {
  flex: 1 1 auto;
  min-width: 0;
}
.dbox__col.is-key {
  font-weight: 600;
}
.dbox__type {
  flex: none;
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--nd-text-muted);
}
.dbox__handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  color: var(--nd-text-muted);
  cursor: crosshair;
}
.dbox__handle:hover {
  color: var(--nd-accent);
  background: rgba(var(--nd-accent-rgb), 0.18);
}
.dbox__row[data-col-row]:hover {
  background: rgba(var(--nd-accent-rgb), 0.08);
}
</style>
