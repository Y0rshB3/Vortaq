<script setup lang="ts">
import { computed } from 'vue'
import RelationshipDiagram from '@renderer/components/diagram/RelationshipDiagram.vue'
import { useWorkspace } from '@renderer/composables/useWorkspace'
import type { WorkspaceTab } from '@renderer/stores/tabs'
import { refOf } from '@renderer/utils/schemaRef'

/** The «Diagrama» tab: the diagram of the tab's database/schema; tables open in their own tabs. */
const props = defineProps<{ tab: WorkspaceTab }>()

const workspace = useWorkspace()
const connectionId = computed(() => props.tab.connectionId ?? '')
const namespace = computed(() => props.tab.schema ?? '')
const storageKey = computed(
  () => `electrondb.diagram.${connectionId.value}:${props.tab.database ?? ''}:${namespace.value}`
)
</script>

<template>
  <RelationshipDiagram
    :connection-id="connectionId"
    :schema-ref="refOf(tab)"
    :namespace="namespace"
    :storage-key="storageKey"
    can-design
    @open="(t) => workspace.openTableData(connectionId, namespace, t, tab.database)"
    @design="(t) => workspace.openTableDesigner(connectionId, namespace, t, tab.database)"
  />
</template>
