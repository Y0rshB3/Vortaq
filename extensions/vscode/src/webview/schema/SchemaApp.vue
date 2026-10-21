<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import RelationshipDiagram from '@renderer/components/diagram/RelationshipDiagram.vue'
import QueryBuilder from '@renderer/components/querybuilder/QueryBuilder.vue'
import type { SchemaViewState } from '../../webviewState'
import type { WebviewHost } from '../bridge'

/**
 * The desktop diagram or visual query on one database/schema. Opening a
 * table's data and opening or running the SELECT are the host's job: «Ver
 * datos» and a new SQL document, run there with the runner's guards.
 */
const props = defineProps<{ host: WebviewHost<SchemaViewState>; initial: SchemaViewState }>()

const state = shallowRef<SchemaViewState>(props.initial)
props.host.onState((next) => (state.value = next))

const where = computed(() =>
  typeof state.value.ref === 'string'
    ? state.value.ref
    : `${state.value.ref.database}:${state.value.ref.schema}`
)
/** Hand-placed tables, remembered by this webview (the editor may clear it). */
const storageKey = computed(() => `vortaq.diagram.${state.value.connection.id}:${where.value}`)
</script>

<template>
  <v-app class="vq-webview vq-schema">
    <RelationshipDiagram
      v-if="state.kind === 'diagram'"
      :connection-id="state.connection.id"
      :schema-ref="state.ref"
      :namespace="state.namespace"
      :storage-key="storageKey"
      @open="(table) => host.post({ type: 'openData', table })"
    />
    <QueryBuilder
      v-else
      :connection-id="state.connection.id"
      :schema-ref="state.ref"
      :namespace="state.namespace"
      @open="(sql, run) => host.post({ type: 'openSql', sql, run })"
    />
  </v-app>
</template>

<style scoped>
.vq-schema :deep(.v-application__wrap) {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.vq-schema :deep(.nd-view) {
  flex: 1 1 auto;
}
</style>
