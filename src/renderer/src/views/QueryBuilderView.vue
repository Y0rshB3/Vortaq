<script setup lang="ts">
import { computed } from 'vue'
import QueryBuilder from '@renderer/components/querybuilder/QueryBuilder.vue'
import { useWorkspace } from '@renderer/composables/useWorkspace'
import type { WorkspaceTab } from '@renderer/stores/tabs'
import { refOf } from '@renderer/utils/schemaRef'

/** The «Consulta gráfica» tab: its SELECT opens (and runs) in a query tab of the same place. */
const props = defineProps<{ tab: WorkspaceTab }>()

const workspace = useWorkspace()
const connectionId = computed(() => props.tab.connectionId ?? '')
const namespace = computed(() => props.tab.schema ?? '')

function open(sql: string, run: boolean): void {
  workspace.openQuery(
    connectionId.value,
    namespace.value,
    { sql, name: 'Consulta gráfica', ...(run ? { run: true } : {}) },
    props.tab.database
  )
}
</script>

<template>
  <QueryBuilder
    :connection-id="connectionId"
    :schema-ref="refOf(tab)"
    :namespace="namespace"
    @open="open"
  />
</template>
