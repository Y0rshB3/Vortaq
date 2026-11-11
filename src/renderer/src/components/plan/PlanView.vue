<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ExecutionPlan, PlanNode } from '@shared/plan/types'

/**
 * «Plan de ejecución»: the common plan tree (shared/plan) of any engine, root
 * first, each operator indented under the one that consumes it. A bar shows
 * the share of the total cost spent in the operator itself; the most expensive
 * ones are highlighted. Used by the desktop query view and the editor
 * extension's results panel.
 */
const props = defineProps<{ plan: ExecutionPlan }>()
const emit = defineEmits<{ copy: [text: string] }>()

interface Row {
  node: PlanNode
  depth: number
}

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (node: PlanNode, depth: number): void => {
    out.push({ node, depth })
    node.children.forEach((c) => walk(c, depth + 1))
  }
  walk(props.plan.root, 0)
  return out
})

/** The few operators that take most of the cost. */
const hottest = computed(() => {
  const shares = rows.value
    .map((r) => r.node.costPercent ?? 0)
    .filter((p) => p >= 20)
    .sort((a, b) => b - a)
  return new Set(shares.slice(0, 3))
})

const open = ref(new Set<number>())
function toggle(id: number): void {
  const next = new Set(open.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  open.value = next
}

const fmt = (n: number): string =>
  n >= 100
    ? Math.round(n).toLocaleString('es')
    : n.toLocaleString('es', { maximumFractionDigits: 2 })

function icon(node: PlanNode): string {
  const op = node.operation.toLowerCase()
  if (/join|loop|hash match|merge/.test(op)) return 'mdi-call-merge'
  if (/sort|orden/.test(op)) return 'mdi-sort'
  if (/aggregate|group|stream/.test(op)) return 'mdi-sigma'
  if (/seek|lookup|search|búsqueda|index scan|index only|índice/.test(op)) return 'mdi-magnify'
  if (/scan|recorrido|table/.test(op)) return 'mdi-table-arrow-right'
  if (/filter|filtro/.test(op)) return 'mdi-filter-variant'
  return 'mdi-cog-outline'
}

const label = computed(() => (props.plan.actual ? 'Plan real' : 'Plan estimado'))

async function copy(): Promise<void> {
  emit('copy', props.plan.raw)
}
</script>

<template>
  <div class="plan-view" data-test="plan-view">
    <div class="plan-view__head">
      <span class="nd-pill" :class="plan.actual ? 'nd-pill--local' : ''" data-test="plan-kind">{{
        label
      }}</span>
      <span v-if="plan.totalCost !== null" class="plan-view__total"
        >Coste total {{ fmt(plan.totalCost) }}</span
      >
      <span v-if="!plan.actual" class="plan-view__hint"
        >La sentencia no se ejecutó: filas y coste son estimaciones del servidor.</span
      >
      <v-spacer />
      <v-btn
        size="small"
        variant="text"
        prepend-icon="mdi-content-copy"
        :title="`Copiar el plan tal como lo da el servidor (${plan.rawFormat.toUpperCase()})`"
        data-test="plan-copy"
        @click="copy"
        >Copiar plan</v-btn
      >
    </div>
    <div
      v-for="line in plan.summary"
      :key="line"
      class="plan-view__summary"
      data-test="plan-summary"
    >
      <v-icon
        :icon="
          line.startsWith('Índice recomendado')
            ? 'mdi-lightbulb-on-outline'
            : 'mdi-information-outline'
        "
        size="15"
        aria-hidden="true"
      />{{ line }}
    </div>
    <div class="plan-view__tree" role="tree" aria-label="Plan de ejecución">
      <div
        v-for="{ node, depth } in rows"
        :key="node.id"
        class="plan-view__node"
        :class="{ 'plan-view__node--hot': hottest.has(node.costPercent ?? -1) }"
        :style="{ marginLeft: `${depth * 22}px` }"
        role="treeitem"
        :aria-level="depth + 1"
        :data-test="`plan-node-${node.id}`"
      >
        <div class="plan-view__line">
          <v-icon :icon="icon(node)" size="16" class="plan-view__icon" aria-hidden="true" />
          <strong class="plan-view__op">{{ node.operation }}</strong>
          <code v-if="node.object" class="plan-view__object">{{ node.object }}</code>
          <v-icon
            v-if="node.warnings.length"
            icon="mdi-alert-outline"
            size="16"
            color="warning"
            :title="node.warnings.join('\n')"
            :aria-label="node.warnings.join('. ')"
          />
          <v-spacer />
          <span class="plan-view__metrics">
            <template v-if="node.estRows !== null">est. {{ fmt(node.estRows) }} filas</template>
            <template v-if="node.actualRows !== null"> · real {{ fmt(node.actualRows) }}</template>
            <template v-if="node.actualMs !== null"> · {{ fmt(node.actualMs) }} ms</template>
          </span>
          <span
            v-if="node.costPercent !== null"
            class="plan-view__cost"
            :title="`Coste del operador: ${node.costPercent} % del total`"
          >
            <span class="plan-view__bar"
              ><span
                class="plan-view__fill"
                :style="{ width: `${Math.min(100, node.costPercent)}%` }"
            /></span>
            {{ node.costPercent }} %
          </span>
        </div>
        <div v-if="node.details.length || node.warnings.length" class="plan-view__details">
          <template v-for="(d, i) in node.details" :key="i">
            <div v-if="i < 2 || open.has(node.id)" class="plan-view__detail">{{ d }}</div>
          </template>
          <template v-if="open.has(node.id)">
            <div v-for="w in node.warnings" :key="w" class="plan-view__warning">{{ w }}</div>
          </template>
          <button
            v-if="node.details.length > 2 || node.warnings.length"
            type="button"
            class="plan-view__more"
            @click="toggle(node.id)"
          >
            {{ open.has(node.id) ? 'menos' : 'más' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plan-view {
  height: 100%;
  overflow: auto;
  padding: 8px 12px 16px;
  color: var(--nd-text);
}
.plan-view__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.plan-view__total,
.plan-view__hint {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.plan-view__summary {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0;
  padding: 6px 10px;
  border-radius: var(--nd-radius-sm);
  background: var(--nd-bg-sunken);
  font-size: var(--nd-fs-dense);
}
.plan-view__tree {
  display: grid;
  gap: 4px;
  margin-top: 6px;
}
.plan-view__node {
  padding: 5px 8px;
  border: 1px solid var(--nd-border);
  border-left: 3px solid var(--nd-border);
  border-radius: var(--nd-radius-sm);
  background: var(--nd-bg-sunken);
  min-width: 0;
}
.plan-view__node--hot {
  border-left-color: rgb(var(--v-theme-warning));
}
.plan-view__line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.plan-view__icon {
  color: var(--nd-text-2);
}
.plan-view__op {
  font-size: var(--nd-fs-dense);
  white-space: nowrap;
}
.plan-view__object {
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.plan-view__metrics {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
  white-space: nowrap;
}
.plan-view__cost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--nd-fs-dense);
  white-space: nowrap;
  min-width: 96px;
  justify-content: flex-end;
}
.plan-view__bar {
  display: inline-block;
  width: 52px;
  height: 6px;
  border-radius: 3px;
  background: var(--nd-border);
  overflow: hidden;
}
.plan-view__fill {
  display: block;
  height: 100%;
  background: rgb(var(--v-theme-primary));
}
.plan-view__node--hot .plan-view__fill {
  background: rgb(var(--v-theme-warning));
}
.plan-view__details {
  margin: 3px 0 0 24px;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.plan-view__detail,
.plan-view__warning {
  overflow-wrap: anywhere;
}
.plan-view__warning {
  color: rgb(var(--v-theme-warning));
}
.plan-view__more {
  border: 0;
  background: none;
  padding: 0;
  color: rgb(var(--v-theme-primary));
  cursor: pointer;
  font: inherit;
}
</style>
