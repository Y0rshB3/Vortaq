<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef } from 'vue'
import { getDialect } from '@shared/dialects'
import type { SqlDialectId } from '@shared/dialects/types'
import type { SchemaRef, TableStructure } from '@shared/types'
import { invokeSilent } from '@renderer/api'
import ContextMenu from '@renderer/components/common/ContextMenu.vue'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import { columnKind } from '@renderer/components/data/columnKind'
import DiagramCanvas from '@renderer/components/diagram/DiagramCanvas.vue'
import {
  autoLayout,
  placeMissing,
  tableSizes,
  type Positions
} from '@renderer/components/diagram/layout'
import { buildSchemaModel, type ModelRelation } from '@renderer/components/diagram/model'
import {
  NO_VALUE,
  OPERATOR_LABELS,
  buildQuery,
  tableAlias,
  type BuilderAggregate,
  type BuilderColumn,
  type BuilderJoin,
  type BuilderOperator,
  type BuilderTable
} from './sqlBuilder'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'

/**
 * «Consulta gráfica»: add tables from the list, tick their columns, join them
 * (by their foreign keys automatically, or by dragging one column onto
 * another) and set aliases, totals, order and filters in the grid below. The
 * SELECT is shown as it is built; «Abrir en consulta» and «Ejecutar» hand it to
 * the host (`open`): a query tab on the desktop, a SQL document in the editor
 * extension, which run it with their usual guards. Only structure is read.
 */
const props = defineProps<{
  connectionId: string
  /** Where the tables are read: MySQL database, PostgreSQL `{ database, schema }`, SQLite alias. */
  schemaRef: SchemaRef
  /** Database or schema name (qualifies PostgreSQL and attached SQLite tables). */
  namespace: string
}>()
const emit = defineEmits<{
  /** The SELECT, to open in a query (and run it there when `run`). */
  open: [sql: string, run: boolean]
}>()

const notify = useNotify()
const connections = useConnectionsStore()

const connectionId = computed(() => props.connectionId)
const namespace = computed(() => props.namespace)
const engine = computed(() => connections.get(connectionId.value)?.engine)
const dialectId = computed<SqlDialectId>(() =>
  engine.value === 'postgresql' || engine.value === 'sqlite' || engine.value === 'mariadb'
    ? engine.value
    : 'mysql'
)
/** PostgreSQL names the schema (search_path may not hold it); SQLite an attached database. */
const qualifier = computed(() =>
  engine.value === 'postgresql' || (engine.value === 'sqlite' && namespace.value !== 'main')
    ? namespace.value
    : null
)

const tableList = ref<string[]>([])
const listError = ref<string | null>(null)
const listLoading = ref(false)
const filter = ref('')
const structures = shallowRef(new Map<string, TableStructure>())
const adding = ref<string | null>(null)

const tables = ref<BuilderTable[]>([])
const joins = ref<BuilderJoin[]>([])
const columns = ref<BuilderColumn[]>([])
const positions = ref<Positions>({})
const distinct = ref(false)
const limit = ref<string>('')
const bottomTab = ref<'columns' | 'sql'>('columns')
const canvas = ref<InstanceType<typeof DiagramCanvas> | null>(null)
/** The user moved a table: new tables are then placed beside the rest instead of rearranging. */
const manual = ref(false)
const menu = ref<InstanceType<typeof ContextMenu> | null>(null)
let joinSeq = 0

/* ---------- model of the tables on the canvas ---------- */

const model = computed(() =>
  buildSchemaModel(
    tables.value.flatMap((t) => structures.value.get(t.name) ?? []),
    namespace.value
  )
)
const sizes = computed(() => tableSizes(model.value, false, 18))
const aliasOf = (table: string): string => tables.value.find((t) => t.name === table)?.alias ?? ''
const tableOf = (alias: string): string => tables.value.find((t) => t.alias === alias)?.name ?? ''
/** Joins drawn as lines (LEFT joins dashed). */
const joinLines = computed<ModelRelation[]>(() =>
  joins.value.map((j) => ({
    name: j.id,
    from: tableOf(j.a),
    fromColumns: j.on.map((p) => p.a),
    to: tableOf(j.b),
    toColumns: j.on.map((p) => p.b),
    optional: j.type === 'LEFT'
  }))
)
const checked = computed(() => {
  const out: Record<string, string[]> = {}
  for (const c of columns.value) (out[tableOf(c.table)] ??= []).push(c.column)
  return out
})

const built = computed(() =>
  buildQuery(
    {
      qualifier: qualifier.value,
      tables: tables.value,
      joins: joins.value,
      columns: columns.value,
      distinct: distinct.value,
      limit: /^\d+$/.test(limit.value.trim()) ? Number(limit.value.trim()) : null
    },
    getDialect(dialectId.value)
  )
)

/* ---------- tables ---------- */

const visibleList = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return q ? tableList.value.filter((n) => n.toLowerCase().includes(q)) : tableList.value
})

async function loadList(): Promise<void> {
  listLoading.value = true
  listError.value = null
  try {
    const list = await invokeSilent('db:tables', connectionId.value, props.schemaRef)
    tableList.value = list.map((t) => t.name).sort((a, b) => a.localeCompare(b))
  } catch (err) {
    listError.value = errorMessage(err)
  } finally {
    listLoading.value = false
  }
}

async function addTable(name: string): Promise<void> {
  if (tables.value.some((t) => t.name === name)) {
    canvas.value?.centerOn(name)
    return
  }
  adding.value = name
  try {
    if (!structures.value.has(name)) {
      const s = await invokeSilent('db:tableStructure', connectionId.value, props.schemaRef, name)
      structures.value = new Map(structures.value).set(name, s)
    }
    const alias = tableAlias(
      name,
      tables.value.map((t) => t.alias)
    )
    tables.value = [...tables.value, { name, alias }]
    // Its foreign keys with the tables already on the canvas become joins (either direction).
    for (const r of model.value.relations) {
      if (r.from === r.to || (r.from !== name && r.to !== name)) continue
      if (joins.value.some((j) => j.id === `fk:${r.name}`)) continue
      joins.value = [
        ...joins.value,
        {
          id: `fk:${r.name}`,
          type: 'INNER',
          a: aliasOf(r.from),
          b: aliasOf(r.to),
          on: r.fromColumns.map((c, i) => ({ a: c, b: r.toColumns[i] }))
        }
      ]
    }
    if (manual.value) positions.value = placeMissing(model.value, positions.value, sizes.value)
    else {
      positions.value = autoLayout(model.value, sizes.value)
      await nextTick()
      canvas.value?.fit()
    }
  } catch (err) {
    notify.error(`No se pudo leer «${name}»: ${errorMessage(err)}`)
  } finally {
    adding.value = null
  }
}

function removeTable(name: string): void {
  const alias = aliasOf(name)
  tables.value = tables.value.filter((t) => t.name !== name)
  joins.value = joins.value.filter((j) => j.a !== alias && j.b !== alias)
  columns.value = columns.value.filter((c) => c.table !== alias)
  const { [name]: _gone, ...rest } = positions.value
  positions.value = rest
}

function clearAll(): void {
  tables.value = []
  joins.value = []
  columns.value = []
  positions.value = {}
  manual.value = false
}

/* ---------- columns ---------- */

function toggleColumn(table: string, column: string): void {
  const alias = aliasOf(table)
  const i = columns.value.findIndex((c) => c.table === alias && c.column === column)
  if (i >= 0) {
    columns.value = columns.value.filter((_, j) => j !== i)
    return
  }
  const type = structures.value.get(table)?.columns.find((c) => c.name === column)
  columns.value = [
    ...columns.value,
    {
      id: `${alias}.${column}`,
      table: alias,
      column,
      output: true,
      as: '',
      aggregate: null,
      sort: null,
      operator: null,
      value: '',
      numeric: columnKind(type?.columnType ?? type?.dataType) === 'number'
    }
  ]
}

function moveColumn(i: number, step: number): void {
  const j = i + step
  if (j < 0 || j >= columns.value.length) return
  const next = [...columns.value]
  ;[next[i], next[j]] = [next[j], next[i]]
  columns.value = next
}

function patchColumn(id: string, patch: Partial<BuilderColumn>): void {
  columns.value = columns.value.map((c) => (c.id === id ? { ...c, ...patch } : c))
}

const AGGREGATES: { value: BuilderAggregate | null; title: string }[] = [
  { value: null, title: '—' },
  { value: 'COUNT', title: 'Contar' },
  { value: 'SUM', title: 'Suma' },
  { value: 'AVG', title: 'Media' },
  { value: 'MIN', title: 'Mínimo' },
  { value: 'MAX', title: 'Máximo' }
]
const SORTS = [
  { value: null, title: '—' },
  { value: 'ASC', title: 'Ascendente' },
  { value: 'DESC', title: 'Descendente' }
]
const OPERATORS: { value: BuilderOperator | null; title: string }[] = [
  { value: null, title: 'Sin filtro' },
  ...(Object.keys(OPERATOR_LABELS) as BuilderOperator[]).map((op) => ({
    value: op,
    title: OPERATOR_LABELS[op]
  }))
]

/* ---------- joins ---------- */

function onLink(
  from: { table: string; column: string },
  to: { table: string; column: string }
): void {
  joins.value = [
    ...joins.value,
    {
      id: `j${++joinSeq}`,
      type: 'INNER',
      a: aliasOf(from.table),
      b: aliasOf(to.table),
      on: [{ a: from.column, b: to.column }]
    }
  ]
}

const selectedJoin = ref<string | null>(null)
function joinMenu(id: string, event: MouseEvent): void {
  const j = joins.value.find((x) => x.id === id)
  if (!j) return
  selectedJoin.value = id
  // LEFT JOIN keeps every row of the table added first (the SQL joins the later one to it).
  const order = (alias: string): number => tables.value.findIndex((t) => t.alias === alias)
  const kept = tableOf(order(j.a) <= order(j.b) ? j.a : j.b)
  const set = (type: BuilderJoin['type']): void => {
    joins.value = joins.value.map((x) => (x.id === id ? { ...x, type } : x))
  }
  menu.value?.show(event, [
    {
      key: 'inner',
      label: 'Solo las filas que coinciden (INNER JOIN)',
      icon: j.type === 'INNER' ? 'mdi-check' : 'mdi-set-center',
      action: () => set('INNER')
    },
    {
      key: 'left',
      label: `Todas las filas de «${kept}» (LEFT JOIN)`,
      icon: j.type === 'LEFT' ? 'mdi-check' : 'mdi-set-left-center',
      action: () => set('LEFT')
    },
    { key: 'd', label: '', divider: true },
    {
      key: 'remove',
      label: 'Quitar esta unión',
      icon: 'mdi-link-variant-off',
      danger: true,
      action: () => {
        joins.value = joins.value.filter((x) => x.id !== id)
      }
    }
  ])
}

function tableMenu(table: string, event: MouseEvent): void {
  menu.value?.show(event, [
    {
      key: 'all',
      label: 'Seleccionar todas las columnas',
      icon: 'mdi-checkbox-multiple-marked-outline',
      action: () => {
        for (const c of structures.value.get(table)?.columns ?? [])
          if (!checked.value[table]?.includes(c.name)) toggleColumn(table, c.name)
      }
    },
    {
      key: 'remove',
      label: 'Quitar de la consulta',
      icon: 'mdi-close',
      danger: true,
      action: () => removeTable(table)
    }
  ])
}

/* ---------- output ---------- */

function openInQuery(run: boolean): void {
  if (!built.value.sql) return
  emit('open', `${built.value.sql};\n`, run)
}

async function copySql(): Promise<void> {
  try {
    await navigator.clipboard.writeText(built.value.sql)
    notify.success('SQL copiado al portapapeles')
  } catch {
    notify.warning('No se pudo copiar al portapapeles')
  }
}

onMounted(loadList)
</script>

<template>
  <div class="nd-view qb-view">
    <div class="nd-viewbar" role="toolbar" aria-label="Acciones de la consulta gráfica">
      <v-btn
        prepend-icon="mdi-play"
        size="small"
        color="primary"
        variant="tonal"
        :disabled="!built.sql"
        title="Abre la consulta en una pestaña y la ejecuta"
        data-test="qb-run"
        @click="openInQuery(true)"
        >Ejecutar</v-btn
      >
      <v-btn
        prepend-icon="mdi-database-search"
        size="small"
        :disabled="!built.sql"
        data-test="qb-open"
        @click="openInQuery(false)"
        >Abrir en consulta</v-btn
      >
      <v-btn
        prepend-icon="mdi-content-copy"
        size="small"
        :disabled="!built.sql"
        data-test="qb-copy"
        @click="copySql"
        >Copiar SQL</v-btn
      >
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <label class="qb-view__opt">
        <input v-model="distinct" type="checkbox" data-test="qb-distinct" />
        Sin repetidos (DISTINCT)
      </label>
      <label class="qb-view__opt">
        Límite
        <input
          v-model="limit"
          class="qb-view__limit nd-mono"
          inputmode="numeric"
          placeholder="—"
          aria-label="Límite de filas"
          data-test="qb-limit"
        />
      </label>
      <span class="nd-viewbar__spacer" />
      <v-btn
        prepend-icon="mdi-broom"
        size="small"
        :disabled="!tables.length"
        data-test="qb-clear"
        @click="clearAll"
        >Vaciar</v-btn
      >
    </div>

    <div class="nd-viewpanel qb-view__main">
      <aside class="qb-view__tables" aria-label="Tablas">
        <label class="qb-view__filter">
          <v-icon icon="mdi-magnify" size="14" aria-hidden="true" />
          <input
            v-model="filter"
            placeholder="Filtrar tablas…"
            aria-label="Filtrar tablas"
            data-test="qb-filter"
          />
        </label>
        <div v-if="listError" class="qb-view__error" role="alert">{{ listError }}</div>
        <div v-else-if="listLoading" class="qb-view__muted">Cargando tablas…</div>
        <ul v-else class="qb-view__list" data-test="qb-tables">
          <li v-for="name in visibleList" :key="name">
            <button
              type="button"
              class="qb-view__table"
              :class="{ 'is-added': tables.some((t) => t.name === name) }"
              :title="
                tables.some((t) => t.name === name)
                  ? 'Ya está en la consulta'
                  : 'Añadir a la consulta'
              "
              :data-test="`qb-table-${name}`"
              @click="addTable(name)"
            >
              <v-progress-circular v-if="adding === name" indeterminate size="12" width="2" />
              <v-icon
                v-else
                :icon="tables.some((t) => t.name === name) ? 'mdi-check' : 'mdi-table'"
                size="14"
                aria-hidden="true"
              />
              <span class="nd-ellipsis">{{ name }}</span>
            </button>
          </li>
          <li v-if="!visibleList.length" class="qb-view__muted">Ninguna tabla.</li>
        </ul>
      </aside>
      <div class="qb-view__canvas">
        <DiagramCanvas
          ref="canvas"
          v-model:positions="positions"
          mode="builder"
          :tables="model.tables"
          :relations="joinLines"
          :sizes="sizes"
          :checked="checked"
          :selected-relation="selectedJoin"
          label="Tablas de la consulta gráfica"
          @toggle-column="toggleColumn"
          @relation-click="joinMenu"
          @link="onLink"
          @menu="tableMenu"
          @moved="manual = true"
        />
        <div v-if="!tables.length" class="qb-view__hint" data-test="qb-empty">
          <v-icon icon="mdi-gesture-tap" size="20" aria-hidden="true" />
          Haz clic en una tabla de la lista para añadirla. Las tablas relacionadas se unen solas por
          sus claves foráneas; para otra unión, arrastra el punto de una columna hasta una columna
          de otra tabla.
        </div>
      </div>
    </div>

    <div class="nd-viewpanel qb-view__bottom">
      <div class="qb-view__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="bottomTab === 'columns'"
          :class="{ 'is-active': bottomTab === 'columns' }"
          data-test="qb-tab-columns"
          @click="bottomTab = 'columns'"
        >
          Columnas <span class="qb-view__count">{{ columns.length }}</span>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="bottomTab === 'sql'"
          :class="{ 'is-active': bottomTab === 'sql' }"
          data-test="qb-tab-sql"
          @click="bottomTab = 'sql'"
        >
          SQL
          <v-icon
            v-if="built.warnings.length"
            icon="mdi-alert-outline"
            size="13"
            class="qb-view__warn-icon"
            aria-label="Hay avisos"
          />
        </button>
      </div>
      <div v-if="bottomTab === 'columns'" class="qb-view__grid-wrap">
        <div v-if="!columns.length" class="qb-view__muted qb-view__pad">
          Marca columnas en las tablas para añadirlas. Sin columnas marcadas, la consulta devuelve
          todas (*).
        </div>
        <table v-else class="qb-view__grid" data-test="qb-columns">
          <thead>
            <tr>
              <th />
              <th>Columna</th>
              <th>Mostrar</th>
              <th>Alias</th>
              <th>Total</th>
              <th>Orden</th>
              <th colspan="2">Filtro</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="(c, i) in columns" :key="c.id" :data-test="`qb-col-${c.id}`">
              <td class="qb-view__move">
                <button
                  type="button"
                  :disabled="i === 0"
                  aria-label="Subir"
                  @click="moveColumn(i, -1)"
                >
                  <v-icon icon="mdi-chevron-up" size="14" />
                </button>
                <button
                  type="button"
                  :disabled="i === columns.length - 1"
                  aria-label="Bajar"
                  @click="moveColumn(i, 1)"
                >
                  <v-icon icon="mdi-chevron-down" size="14" />
                </button>
              </td>
              <td class="nd-mono qb-view__colname">{{ c.table }}.{{ c.column }}</td>
              <td>
                <input
                  type="checkbox"
                  :checked="c.output"
                  :aria-label="`Mostrar ${c.column}`"
                  @change="
                    patchColumn(c.id, { output: ($event.target as HTMLInputElement).checked })
                  "
                />
              </td>
              <td>
                <input
                  class="qb-view__input"
                  :value="c.as"
                  placeholder="—"
                  :aria-label="`Alias de ${c.column}`"
                  :data-test="`qb-as-${c.id}`"
                  @input="patchColumn(c.id, { as: ($event.target as HTMLInputElement).value })"
                />
              </td>
              <td>
                <select
                  class="qb-view__select"
                  :value="c.aggregate ?? ''"
                  :aria-label="`Total de ${c.column}`"
                  :data-test="`qb-agg-${c.id}`"
                  @change="
                    patchColumn(c.id, {
                      aggregate: (($event.target as HTMLSelectElement).value ||
                        null) as BuilderAggregate | null
                    })
                  "
                >
                  <option v-for="a in AGGREGATES" :key="a.title" :value="a.value ?? ''">
                    {{ a.title }}
                  </option>
                </select>
              </td>
              <td>
                <select
                  class="qb-view__select"
                  :value="c.sort ?? ''"
                  :aria-label="`Orden de ${c.column}`"
                  :data-test="`qb-sort-${c.id}`"
                  @change="
                    patchColumn(c.id, {
                      sort: (($event.target as HTMLSelectElement).value || null) as
                        'ASC' | 'DESC' | null
                    })
                  "
                >
                  <option v-for="s in SORTS" :key="s.title" :value="s.value ?? ''">
                    {{ s.title }}
                  </option>
                </select>
              </td>
              <td>
                <select
                  class="qb-view__select"
                  :value="c.operator ?? ''"
                  :aria-label="`Filtro de ${c.column}`"
                  :data-test="`qb-op-${c.id}`"
                  @change="
                    patchColumn(c.id, {
                      operator: (($event.target as HTMLSelectElement).value ||
                        null) as BuilderOperator | null
                    })
                  "
                >
                  <option v-for="o in OPERATORS" :key="o.title" :value="o.value ?? ''">
                    {{ o.title }}
                  </option>
                </select>
              </td>
              <td>
                <input
                  v-if="c.operator && !NO_VALUE.has(c.operator)"
                  class="qb-view__input"
                  :value="c.value"
                  :placeholder="c.operator === 'in' ? 'a, b, c' : c.numeric ? 'Número' : 'Valor'"
                  :aria-label="`Valor del filtro de ${c.column}`"
                  :data-test="`qb-value-${c.id}`"
                  @input="patchColumn(c.id, { value: ($event.target as HTMLInputElement).value })"
                />
              </td>
              <td>
                <button
                  type="button"
                  class="qb-view__remove"
                  :aria-label="`Quitar ${c.column}`"
                  @click="columns = columns.filter((x) => x.id !== c.id)"
                >
                  <v-icon icon="mdi-close" size="14" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="qb-view__sql-wrap">
        <div v-for="w in built.warnings" :key="w" class="qb-view__warning" role="note">
          <v-icon icon="mdi-alert-outline" size="14" aria-hidden="true" />{{ w }}
        </div>
        <pre class="qb-view__sql nd-mono" data-test="qb-sql">{{
          built.sql || '-- Añade una tabla para empezar'
        }}</pre>
      </div>
    </div>
    <ContextMenu ref="menu" />
    <EmptyState
      v-if="engine === 'mongodb'"
      class="qb-view__mongo"
      icon="mdi-vector-link"
      title="No disponible en MongoDB"
      description="La consulta gráfica genera SQL."
    />
  </div>
</template>

<style scoped src="../data/viewChrome.css"></style>
<style scoped>
.qb-view {
  position: relative;
}
.qb-view__main {
  display: flex;
  flex-direction: row;
  flex: 1 1 0;
  min-height: 160px;
}
.qb-view__tables {
  display: flex;
  flex-direction: column;
  flex: 0 0 210px;
  min-height: 0;
  border-right: 1px solid var(--nd-border);
  background: var(--nd-bg-raised);
}
.qb-view__filter {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-input);
  border: 1px solid var(--nd-border);
  color: var(--nd-text-muted);
}
.qb-view__filter:focus-within {
  border-color: var(--nd-accent);
}
.qb-view__filter input {
  flex: 1 1 auto;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--nd-text);
  font: inherit;
  font-size: var(--nd-fs-dense);
}
.qb-view__list {
  flex: 1 1 auto;
  overflow: auto;
  list-style: none;
  margin: 0;
  padding: 0 4px 8px;
}
.qb-view__table {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  border: none;
  border-radius: var(--nd-radius-sm);
  background: transparent;
  color: var(--nd-text);
  font: inherit;
  font-size: var(--nd-fs-dense);
  text-align: left;
  cursor: pointer;
}
.qb-view__table:hover {
  background: var(--nd-hover);
}
.qb-view__table .v-icon {
  color: var(--nd-text-muted);
}
.qb-view__table.is-added .v-icon {
  color: var(--nd-accent);
}
.qb-view__muted {
  padding: 6px 12px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-muted);
}
.qb-view__error {
  padding: 6px 12px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-error);
}
.qb-view__canvas {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}
.qb-view__hint {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  gap: 10px;
  max-width: 440px;
  padding: 12px 16px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
  pointer-events: none;
}
.qb-view__hint .v-icon {
  flex: none;
  color: var(--nd-accent);
}
.qb-view__main {
  margin-bottom: 8px;
}
.qb-view__bottom {
  flex: 0 0 240px;
  min-height: 0;
}
.qb-view__tabs {
  display: flex;
  gap: 2px;
  flex: none;
  padding: 4px 8px 0;
  border-bottom: 1px solid var(--nd-hairline);
}
.qb-view__tabs button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--nd-text-2);
  font: inherit;
  font-size: var(--nd-fs-dense);
  cursor: pointer;
}
.qb-view__tabs button.is-active {
  color: var(--nd-text);
  border-bottom-color: var(--nd-accent);
}
.qb-view__count {
  min-width: 16px;
  padding: 0 4px;
  border-radius: var(--nd-radius-pill);
  font-size: 10px;
  background: var(--nd-bg-sunken);
}
.qb-view__warn-icon {
  color: var(--nd-warning);
}
.qb-view__grid-wrap,
.qb-view__sql-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.qb-view__pad {
  padding: 12px;
}
.qb-view__grid {
  border-collapse: collapse;
  min-width: 100%;
  font-size: var(--nd-fs-dense);
}
.qb-view__grid th {
  position: sticky;
  top: 0;
  padding: 4px 8px;
  text-align: left;
  font-weight: 600;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  background: var(--nd-bg-panel);
  border-bottom: 1px solid var(--nd-border);
}
.qb-view__grid td {
  padding: 2px 8px;
  border-bottom: 1px solid var(--nd-hairline);
  white-space: nowrap;
}
.qb-view__colname {
  color: var(--nd-text);
}
.qb-view__move button,
.qb-view__remove {
  display: inline-flex;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--nd-text-muted);
  cursor: pointer;
}
.qb-view__move button:disabled {
  opacity: 0.3;
  cursor: default;
}
.qb-view__remove:hover {
  color: var(--nd-error);
}
.qb-view__input,
.qb-view__select {
  height: 24px;
  padding: 0 6px;
  border-radius: var(--nd-radius-sm);
  background: var(--nd-bg-input);
  border: 1px solid var(--nd-border);
  color: var(--nd-text);
  font: inherit;
}
.qb-view__input {
  width: 140px;
}
.qb-view__input:focus,
.qb-view__select:focus {
  outline: none;
  border-color: var(--nd-accent);
}
.qb-view__sql {
  margin: 0;
  padding: 10px 14px;
  font-size: var(--nd-fs-dense);
  white-space: pre;
  color: var(--nd-text);
}
.qb-view__warning {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 12px 0;
  font-size: var(--nd-fs-xs);
  color: var(--nd-warning);
}
.qb-view__opt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0 6px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.qb-view__limit {
  width: 64px;
  height: 24px;
  padding: 0 6px;
  border-radius: var(--nd-radius-sm);
  background: var(--nd-bg-input);
  border: 1px solid var(--nd-border);
  color: var(--nd-text);
}
.qb-view__mongo {
  position: absolute;
  inset: 0;
  background: var(--nd-bg-panel);
}
.nd-viewbar__spacer {
  flex: 1 1 auto;
}
</style>
