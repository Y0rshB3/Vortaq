<script setup lang="ts">
import { computed } from 'vue'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { effectiveMcpAccess, MCP_ACCESS_LABELS } from '@shared/mcp'
import { useTreeStore, type TreeNode } from '@renderer/stores/tree'
import { ENVIRONMENT_LABELS, GROUP_ICONS, GROUP_LABELS } from '@renderer/utils/objectTypes'

const props = defineProps<{ node: TreeNode; depth: number }>()
const emit = defineEmits<{
  toggle: [node: TreeNode]
  select: [node: TreeNode]
  open: [node: TreeNode]
  contextmenu: [event: MouseEvent, node: TreeNode]
}>()

const tree = useTreeStore()
const connections = useConnectionsStore()
const settings = useSettingsStore()

const connection = computed(() => connections.get(props.node.connectionId))
const isOpen = computed(() => connections.isOpen(props.node.connectionId))
/** Writes need the typed name (production, and the environments of Ajustes › Seguridad). */
const typedConfirm = computed(
  () => props.node.kind === 'connection' && connections.needsTypedConfirm(props.node.connectionId)
)
const expanded = computed(() => tree.isExpanded(props.node.id))
const loading = computed(
  () =>
    !!tree.loading[props.node.id] ||
    (props.node.kind === 'connection' && !!connections.opening[props.node.connectionId])
)
const error = computed(() => tree.errors[props.node.id])
const selected = computed(() => tree.selectedId === props.node.id)

/** Folders, plus PostgreSQL partitioned tables (their partitions are nested). */
const expandable = computed(() => props.node.kind !== 'object' || !!props.node.partitions?.length)
/** Double click / Enter: folders toggle, objects (a partitioned table too) open. */
const toggles = computed(() => props.node.kind !== 'object')

const children = computed(() =>
  expanded.value
    ? tree.childrenOf(props.node).filter((c) => c.kind !== 'object' || tree.matchesFilter(c))
    : []
)

const label = computed(() =>
  props.node.kind === 'group' ? GROUP_LABELS[props.node.group!] : props.node.label
)

const icon = computed(() => {
  const n = props.node
  if (n.kind === 'connection') return isOpen.value ? 'mdi-database' : 'mdi-database-outline'
  // PostgreSQL database: closed (outline) until its schemas are loaded.
  if (n.kind === 'database') return dbLoaded.value ? 'mdi-database' : 'mdi-database-outline'
  if (n.kind === 'schema')
    return n.database !== undefined
      ? 'mdi-file-tree-outline'
      : expanded.value
        ? 'mdi-folder-open-outline'
        : 'mdi-folder-outline'
  if (n.kind === 'group') return GROUP_ICONS[n.group!]
  if (n.group === 'functions')
    return n.subtype === 'PROCEDURE' ? 'mdi-script-text-outline' : 'mdi-function-variant'
  // PostgreSQL: partitioned tables and partitions.
  if (n.partitions?.length) return 'mdi-table-split-cell'
  if (n.subtype === 'partition') return 'mdi-table-column'
  return GROUP_ICONS[n.group!]
})

/** PostgreSQL database node: its pool is open once its schemas were listed. */
const dbLoaded = computed(
  () =>
    props.node.kind === 'database' &&
    !!tree.schemas[
      `${encodeURIComponent(props.node.connectionId)}:${encodeURIComponent(props.node.database!)}`
    ]
)

const countBadge = computed(() => {
  const n = props.node
  if (n.kind !== 'group' || !n.schema) return null
  if (!tree.hasItems(n.connectionId, n.schema, n.group!, n.database)) return null
  return tree.itemsOf(n.connectionId, n.schema, n.group!, n.database).length
})

const envLabel = computed(() =>
  connection.value ? ENVIRONMENT_LABELS[connection.value.environment] : ''
)
const ENV_PILL: Record<string, string> = {
  production: 'nd-pill--production',
  staging: 'nd-pill--staging',
  local: 'nd-pill--local'
}
/** «Disponible para agentes (MCP)»: the level agents get, shown as a small badge. */
const mcpLevel = computed(() => {
  if (props.node.kind !== 'connection' || !connection.value) return null
  const access = effectiveMcpAccess(connection.value, settings.typedEnvironments)
  return access ? MCP_ACCESS_LABELS[access] : null
})
const envPill = computed(() =>
  connection.value ? (ENV_PILL[connection.value.environment] ?? '') : ''
)
</script>

<template>
  <div class="tree-node" :data-test="`tree-node-${node.kind}`" :data-node-id="node.id">
    <div
      class="tree-node__row"
      :class="{
        'tree-node__row--selected': selected,
        'tree-node__row--closed':
          (node.kind === 'connection' && !isOpen) || (node.kind === 'database' && !dbLoaded),
        'tree-node__row--connection': node.kind === 'connection',
        'tree-node__row--production':
          node.kind === 'connection' && connection?.environment === 'production',
        'tree-node__row--typed': typedConfirm
      }"
      :style="{ paddingLeft: `${6 + depth * 14}px` }"
      role="treeitem"
      :aria-expanded="expandable ? expanded : undefined"
      :aria-selected="selected"
      tabindex="0"
      @click="emit('select', node)"
      @dblclick.stop="toggles ? emit('toggle', node) : emit('open', node)"
      @contextmenu.prevent="emit('contextmenu', $event, node)"
      @keydown.enter.prevent="toggles ? emit('toggle', node) : emit('open', node)"
    >
      <button
        class="tree-node__chevron"
        :class="{
          'tree-node__chevron--hidden': !expandable,
          'tree-node__chevron--open': expanded && !loading
        }"
        type="button"
        tabindex="-1"
        :aria-label="expanded ? 'Contraer' : 'Expandir'"
        @click.stop="expandable && emit('toggle', node)"
      >
        <v-progress-circular v-if="loading" indeterminate size="11" width="1.5" color="primary" />
        <v-icon v-else icon="mdi-chevron-right" size="15" />
      </button>
      <span
        v-if="node.kind === 'connection'"
        class="tree-node__marker"
        :class="{ 'tree-node__marker--none': !connection?.color }"
        :style="{
          background: connection?.color ?? 'transparent',
          '--nd-dot': connection?.color ?? 'transparent'
        }"
        data-test="connection-color"
        aria-hidden="true"
      />
      <v-icon :icon="icon" size="15" class="tree-node__icon" />
      <span
        class="tree-node__label"
        :title="error ?? (node.detail ? `${label} · ${node.detail}` : label)"
        >{{ label }}</span
      >
      <v-icon
        v-if="mcpLevel"
        icon="mdi-robot-outline"
        size="12"
        class="tree-node__mcp"
        :title="`Disponible para agentes (MCP): ${mcpLevel}`"
        :aria-label="`Disponible para agentes (MCP): ${mcpLevel}`"
        data-test="mcp-badge"
      />
      <span
        v-if="node.kind === 'connection' && connection"
        class="nd-pill tree-node__env"
        :class="envPill"
        :title="
          typedConfirm
            ? `${envLabel}: requiere confirmación (escribir el nombre) antes de escribir`
            : undefined
        "
        data-test="env-chip"
        ><v-icon
          v-if="typedConfirm"
          icon="mdi-lock-outline"
          size="10"
          aria-hidden="true"
          data-test="env-lock"
        />{{ envLabel }}</span
      >
      <span v-else-if="countBadge !== null" class="tree-node__count">{{ countBadge }}</span>
      <v-icon
        v-if="error"
        icon="mdi-alert-circle-outline"
        size="14"
        class="tree-node__error-icon"
        :title="error"
      />
    </div>
    <div
      v-if="expanded && error"
      class="tree-node__error"
      :style="{ paddingLeft: `${30 + depth * 14}px` }"
    >
      {{ error }}
    </div>
    <template v-if="expanded">
      <TreeNodeRow
        v-for="child in children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        @toggle="(n) => emit('toggle', n)"
        @select="(n) => emit('select', n)"
        @open="(n) => emit('open', n)"
        @contextmenu="(e, n) => emit('contextmenu', e, n)"
      />
    </template>
  </div>
</template>

<style scoped>
.tree-node__row {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 28px;
  margin: 1px 6px;
  padding-right: 8px;
  border-radius: var(--nd-radius-sm);
  cursor: default;
  white-space: nowrap;
  position: relative;
  color: var(--nd-text);
  outline: none;
  transition: background-color var(--nd-dur-fast) var(--nd-ease);
}
.tree-node__row:hover {
  background: var(--nd-hover);
}
.tree-node__row:focus-visible {
  box-shadow: inset 0 0 0 1px rgba(var(--nd-accent-rgb), 0.55);
}
.tree-node__row--selected,
.tree-node__row--selected:hover {
  background: var(--nd-selected);
}
/* Gradient left indicator on the selected row. */
.tree-node__row--selected::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 3px;
  background: var(--nd-accent-gradient-v);
  box-shadow: 0 0 8px rgba(var(--nd-accent-rgb), 0.55);
}
.tree-node__row--connection {
  font-weight: 500;
}
.tree-node__row--closed .tree-node__label {
  color: var(--nd-text-2);
}
.tree-node__chevron {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 0;
  border-radius: 4px;
  color: var(--nd-text-muted);
  padding: 0;
  flex: none;
}
.tree-node__chevron:hover {
  color: var(--nd-text);
}
.tree-node__chevron .v-icon {
  transition: transform var(--nd-dur) var(--nd-ease);
}
.tree-node__chevron--open .v-icon {
  transform: rotate(90deg);
}
.tree-node__chevron--hidden {
  visibility: hidden;
}
/* Connection colour: glowing 8px dot (hollow ring when the connection has no colour). */
.tree-node__marker {
  flex: none;
  width: 8px;
  height: 8px;
  margin: 0 4px 0 3px;
  border-radius: 50%;
  box-shadow: 0 0 8px var(--nd-dot);
}
.tree-node__row--closed .tree-node__marker {
  box-shadow: none;
  opacity: 0.75;
}
.tree-node__marker--none,
.tree-node__row--closed .tree-node__marker--none {
  opacity: 1;
  box-shadow: inset 0 0 0 1.5px var(--nd-text-muted);
}
.tree-node__icon {
  margin: 0 7px 0 2px;
  flex: none;
  color: var(--nd-text-muted);
  transition: color var(--nd-dur-fast) var(--nd-ease);
}
.tree-node__row--connection .tree-node__icon {
  display: none;
}
.tree-node__row--selected .tree-node__icon {
  color: var(--nd-accent);
}
.tree-node__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--nd-fs-base);
}
.tree-node__mcp {
  flex: none;
  margin-left: 6px;
  color: var(--nd-text-muted);
}
.tree-node__env {
  flex: none;
  margin-left: 6px;
  height: 17px;
  font-size: 10.5px;
  opacity: 0;
  transition: opacity var(--nd-dur) var(--nd-ease);
}
.tree-node__row:hover .tree-node__env,
.tree-node__row--selected .tree-node__env,
.tree-node__row--production .tree-node__env {
  opacity: 1;
}
/* Environments that need the typed name keep their pill (with the lock) visible, dimmed. */
.tree-node__row--typed:not(:hover):not(.tree-node__row--selected):not(.tree-node__row--production)
  .tree-node__env {
  opacity: 0.8;
}
.tree-node__row--production .tree-node__env {
  box-shadow: 0 0 10px color-mix(in srgb, var(--nd-error) 25%, transparent);
}
.tree-node__count {
  flex: none;
  min-width: 18px;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: var(--nd-radius-pill);
  font-family: var(--nd-font-mono);
  font-size: 10.5px;
  line-height: 16px;
  text-align: center;
  color: var(--nd-text-muted);
  background: var(--nd-hover);
}
.tree-node__error-icon {
  margin-left: 4px;
  color: var(--nd-error);
}
.tree-node__error {
  margin: 2px 10px 4px 0;
  font-size: var(--nd-fs-xs);
  line-height: 1.4;
  color: var(--nd-error);
  white-space: normal;
}
</style>
