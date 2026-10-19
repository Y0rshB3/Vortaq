<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef } from 'vue'
import { invokeSilent, api } from '@renderer/api'
import ContextMenu from '@renderer/components/common/ContextMenu.vue'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import DiagramCanvas from '@renderer/components/diagram/DiagramCanvas.vue'
import {
  autoLayout,
  placeMissing,
  tableSizes,
  type Positions
} from '@renderer/components/diagram/layout'
import { loadSchemaModel, MAX_DIAGRAM_TABLES } from '@renderer/components/diagram/loadModel'
import type { SchemaModel } from '@renderer/components/diagram/model'
import { diagramPng, themePalette } from '@renderer/components/diagram/imageExport'
import { diagramSvg } from '@renderer/components/diagram/svgExport'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useWorkspace } from '@renderer/composables/useWorkspace'
import { useConnectionsStore } from '@renderer/stores/connections'
import type { WorkspaceTab } from '@renderer/stores/tabs'
import { formatNumber } from '@renderer/utils/format'
import { refOf } from '@renderer/utils/schemaRef'

/**
 * «Diagrama de relaciones» of one MySQL/MariaDB database, PostgreSQL schema
 * or SQLite database: every table with its columns and keys, and a line per
 * foreign key. Reads structure only (db:tables + db:tableStructure). Where you
 * leave each table is remembered on this computer.
 */
const props = defineProps<{ tab: WorkspaceTab }>()

const notify = useNotify()
const workspace = useWorkspace()
const connections = useConnectionsStore()

const model = shallowRef<SchemaModel | null>(null)
const positions = ref<Positions>({})
const keysOnly = ref(false)
const loading = ref(false)
const progress = ref<{ done: number; total: number } | null>(null)
const error = ref<string | null>(null)
const truncated = ref(false)
/** Tables whose structure could not be read (left out). */
const failed = ref<string[]>([])
const search = ref('')
const canvas = ref<InstanceType<typeof DiagramCanvas> | null>(null)
const menu = ref<InstanceType<typeof ContextMenu> | null>(null)
const exporting = ref(false)

const connectionId = computed(() => props.tab.connectionId ?? '')
const namespace = computed(() => props.tab.schema ?? '')
const isMongo = computed(() => connections.get(connectionId.value)?.engine === 'mongodb')
const sizes = computed(() => (model.value ? tableSizes(model.value, keysOnly.value) : {}))
const zoom = computed(() => Math.round((canvas.value?.scale ?? 1) * 100))

/* ---------- remembered layout (this computer only) ---------- */

const storageKey = computed(
  () => `electrondb.diagram.${connectionId.value}:${props.tab.database ?? ''}:${namespace.value}`
)
/** True once the user placed tables by hand (the layout is then kept on «Solo claves»). */
const manual = ref(false)

function readSaved(): { positions: Positions; keysOnly: boolean } | null {
  try {
    const raw = localStorage.getItem(storageKey.value)
    const data = raw ? (JSON.parse(raw) as { positions?: Positions; keysOnly?: boolean }) : null
    return data?.positions && typeof data.positions === 'object'
      ? { positions: data.positions, keysOnly: !!data.keysOnly }
      : null
  } catch {
    return null
  }
}
function save(): void {
  try {
    localStorage.setItem(
      storageKey.value,
      JSON.stringify({ positions: manual.value ? positions.value : {}, keysOnly: keysOnly.value })
    )
  } catch {
    /* storage unavailable: the layout lasts as long as the tab */
  }
}

/* ---------- loading ---------- */

async function load(): Promise<void> {
  if (!connectionId.value || isMongo.value) return
  loading.value = true
  error.value = null
  progress.value = { done: 0, total: 0 }
  try {
    const result = await loadSchemaModel(
      {
        tables: (ref) => invokeSilent('db:tables', connectionId.value, ref),
        structure: (ref, table) => invokeSilent('db:tableStructure', connectionId.value, ref, table)
      },
      refOf(props.tab),
      namespace.value,
      (done, total) => (progress.value = { done, total })
    )
    truncated.value = result.truncated
    failed.value = result.failed
    const saved = readSaved()
    if (saved) keysOnly.value = saved.keysOnly
    model.value = result.model
    const known = Object.fromEntries(
      Object.entries(saved?.positions ?? {}).filter(([t]) =>
        result.model.tables.some((m) => m.name === t)
      )
    )
    manual.value = Object.keys(known).length > 0
    positions.value = manual.value
      ? placeMissing(result.model, known, sizes.value)
      : autoLayout(result.model, sizes.value)
    // The canvas mounts once loading ends: fit it then.
    loading.value = false
    await nextTick()
    canvas.value?.fit()
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loading.value = false
    progress.value = null
  }
}

function rearrange(): void {
  if (!model.value) return
  manual.value = false
  positions.value = autoLayout(model.value, sizes.value)
  save()
  void nextTick(() => canvas.value?.fit())
}

function toggleKeys(): void {
  keysOnly.value = !keysOnly.value
  if (!manual.value && model.value) positions.value = autoLayout(model.value, sizes.value)
  save()
  void nextTick(() => canvas.value?.fit())
}

function onMoved(): void {
  manual.value = true
  save()
}

/* ---------- search, open, menu ---------- */

const tableNames = computed(() => model.value?.tables.map((t) => t.name) ?? [])
function findTable(): void {
  const q = search.value.trim().toLowerCase()
  if (!q) return
  const hit =
    tableNames.value.find((n) => n.toLowerCase() === q) ??
    tableNames.value.find((n) => n.toLowerCase().startsWith(q)) ??
    tableNames.value.find((n) => n.toLowerCase().includes(q))
  if (hit) canvas.value?.centerOn(hit)
  else notify.warning(`No hay ninguna tabla que coincida con «${search.value.trim()}»`)
}

function openData(table: string): void {
  workspace.openTableData(connectionId.value, namespace.value, table, props.tab.database)
}

function tableMenu(table: string, event: MouseEvent): void {
  menu.value?.show(event, [
    { key: 'open', label: 'Abrir datos', icon: 'mdi-table', action: () => openData(table) },
    {
      key: 'design',
      label: 'Diseñar tabla',
      icon: 'mdi-table-edit',
      action: () =>
        workspace.openTableDesigner(connectionId.value, namespace.value, table, props.tab.database)
    }
  ])
}

/* ---------- export ---------- */

async function exportImage(format: 'png' | 'svg'): Promise<void> {
  if (!model.value) return
  exporting.value = true
  try {
    const svg = diagramSvg(
      model.value,
      positions.value,
      sizes.value,
      keysOnly.value,
      themePalette()
    )
    const data = format === 'svg' ? svg : await diagramPng(svg)
    const path = await api.app.saveImage(`diagrama-${namespace.value}`, { format, data })
    if (path) notify.success(`Diagrama guardado en ${path}`)
  } catch (err) {
    notify.error(`No se pudo exportar el diagrama: ${errorMessage(err)}`)
  } finally {
    exporting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="nd-view diagram-view">
    <div class="nd-viewbar" role="toolbar" aria-label="Acciones del diagrama">
      <v-btn
        prepend-icon="mdi-refresh"
        size="small"
        :loading="loading"
        data-test="diagram-refresh"
        @click="load"
        >Refrescar</v-btn
      >
      <v-btn
        prepend-icon="mdi-key-chain-variant"
        size="small"
        :class="{ 'is-active': keysOnly }"
        :aria-pressed="keysOnly"
        title="Mostrar solo las columnas de claves primarias y foráneas"
        data-test="diagram-keys"
        @click="toggleKeys"
        >Solo claves</v-btn
      >
      <v-btn
        prepend-icon="mdi-auto-fix"
        size="small"
        :disabled="!model"
        title="Colocar de nuevo todas las tablas automáticamente"
        data-test="diagram-rearrange"
        @click="rearrange"
        >Reorganizar</v-btn
      >
      <v-menu location="bottom start">
        <template #activator="{ props: menuProps }">
          <v-btn
            v-bind="menuProps"
            prepend-icon="mdi-image-outline"
            append-icon="mdi-chevron-down"
            size="small"
            :disabled="!model || !model.tables.length"
            :loading="exporting"
            data-test="diagram-export"
            >Exportar</v-btn
          >
        </template>
        <v-list density="compact">
          <v-list-item
            title="Imagen PNG"
            data-test="diagram-export-png"
            @click="exportImage('png')"
          />
          <v-list-item
            title="Imagen SVG"
            data-test="diagram-export-svg"
            @click="exportImage('svg')"
          />
        </v-list>
      </v-menu>
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <v-btn
        icon="mdi-magnify-minus-outline"
        size="small"
        variant="text"
        aria-label="Alejar"
        @click="canvas?.zoomBy(1 / 1.2)"
      />
      <span class="diagram-view__zoom nd-mono" data-test="diagram-zoom">{{ zoom }} %</span>
      <v-btn
        icon="mdi-magnify-plus-outline"
        size="small"
        variant="text"
        aria-label="Acercar"
        @click="canvas?.zoomBy(1.2)"
      />
      <v-btn
        prepend-icon="mdi-fit-to-screen-outline"
        size="small"
        data-test="diagram-fit"
        @click="canvas?.fit()"
        >Ajustar</v-btn
      >
      <span class="nd-viewbar__spacer" />
      <label class="diagram-view__search">
        <v-icon icon="mdi-magnify" size="15" aria-hidden="true" />
        <input
          v-model="search"
          list="diagram-tables"
          placeholder="Buscar tabla…"
          aria-label="Buscar tabla en el diagrama"
          data-test="diagram-search"
          @keydown.enter="findTable"
          @change="findTable"
        />
        <datalist id="diagram-tables">
          <option v-for="n in tableNames" :key="n" :value="n" />
        </datalist>
      </label>
    </div>

    <div class="nd-viewpanel diagram-view__body">
      <EmptyState
        v-if="isMongo"
        icon="mdi-sitemap-outline"
        title="Sin relaciones"
        description="MongoDB no tiene claves foráneas entre colecciones."
      />
      <EmptyState
        v-else-if="error"
        icon="mdi-alert-circle-outline"
        title="No se pudo leer la estructura"
        :description="error"
      >
        <v-btn variant="tonal" size="small" prepend-icon="mdi-refresh" @click="load"
          >Reintentar</v-btn
        >
      </EmptyState>
      <div
        v-else-if="loading"
        class="diagram-view__loading"
        role="status"
        data-test="diagram-loading"
      >
        <v-progress-circular indeterminate size="22" width="2" color="primary" />
        <span v-if="progress?.total"
          >Leyendo la estructura de {{ formatNumber(progress.done) }} de
          {{ formatNumber(progress.total) }} tablas…</span
        >
        <span v-else>Leyendo las tablas…</span>
      </div>
      <EmptyState
        v-else-if="model && !model.tables.length"
        icon="mdi-table-off"
        title="Sin tablas"
        description="Esta base de datos no tiene tablas."
      />
      <DiagramCanvas
        v-else-if="model"
        ref="canvas"
        v-model:positions="positions"
        :tables="model.tables"
        :relations="model.relations"
        :sizes="sizes"
        :keys-only="keysOnly"
        :label="`Diagrama de relaciones de ${namespace}`"
        @open="openData"
        @menu="tableMenu"
        @moved="onMoved"
      />
    </div>
    <div v-if="model && !loading" class="diagram-view__footer" data-test="diagram-footer">
      {{ formatNumber(model.tables.length) }} tablas · {{ formatNumber(model.relations.length) }}
      relaciones
      <template v-if="model.external">
        · {{ formatNumber(model.external) }} claves hacia otras bases o esquemas (no se
        dibujan)</template
      >
      <template v-if="truncated">
        · solo las primeras {{ formatNumber(MAX_DIAGRAM_TABLES) }} tablas por orden
        alfabético</template
      >
      <span v-if="failed.length" class="diagram-view__failed" :title="failed.join(', ')">
        · {{ formatNumber(failed.length) }} tablas no se pudieron leer</span
      >
      <span class="nd-viewbar__spacer" />
      <span class="diagram-view__hint"
        >Arrastra el fondo para moverte · {{ '⌘/Ctrl' }} + rueda para el zoom · doble clic en una
        tabla para abrirla</span
      >
    </div>
    <ContextMenu ref="menu" />
  </div>
</template>

<style scoped src="../components/data/viewChrome.css"></style>
<style scoped>
.diagram-view__body {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
}
.diagram-view .is-active {
  color: var(--nd-accent);
  background: rgba(var(--nd-accent-rgb), 0.1);
}
.diagram-view__zoom {
  min-width: 44px;
  text-align: center;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.diagram-view__search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-input);
  border: 1px solid var(--nd-border);
  color: var(--nd-text-muted);
}
.diagram-view__search:focus-within {
  border-color: var(--nd-accent);
}
.diagram-view__search input {
  width: 160px;
  background: transparent;
  border: none;
  outline: none;
  color: var(--nd-text);
  font: inherit;
  font-size: var(--nd-fs-dense);
}
.diagram-view__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 100%;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.diagram-view__footer {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  min-height: 30px;
  padding: 0 12px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  border-top: 1px solid var(--nd-border);
  background: var(--nd-bg-raised);
}
.diagram-view__failed {
  color: var(--nd-warning);
}
.diagram-view__hint {
  color: var(--nd-text-muted);
}
.nd-viewbar__spacer {
  flex: 1 1 auto;
}
</style>
