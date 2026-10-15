<script setup lang="ts">
import { watch } from 'vue'
import ConnectionDialog from '@renderer/components/dialogs/ConnectionDialog.vue'
import { useUiStore } from '@renderer/stores/ui'
import type { ConnectionFormState } from '../../webviewState'
import type { WebviewHost } from '../bridge'

/**
 * The desktop connection dialog as the content of the tab: it opens at once
 * and closing it (Cancelar, or Guardar when the save succeeded) closes the
 * tab. Engines the editor cannot run (SQLite on an old Node) are left out, and so
 * is «Agentes (MCP)» (the desktop app's MCP mode reads the desktop profile only).
 */
const props = defineProps<{
  host: WebviewHost<ConnectionFormState>
  initial: ConnectionFormState
}>()

const ui = useUiStore()
ui.connectionDialog = {
  open: true,
  editing: props.initial.editing,
  ...(props.initial.engine && !props.initial.hiddenEngines.includes(props.initial.engine)
    ? { engine: props.initial.engine }
    : {})
}

watch(
  () => ui.connectionDialog.open,
  (open) => {
    if (!open) props.host.post({ type: 'close' })
  }
)
</script>

<template>
  <v-app class="vq-webview vq-connection">
    <ConnectionDialog
      content-class="vq-connection-dialog"
      persistent
      :scrim="false"
      :no-click-animation="true"
      :hidden-engines="initial.hiddenEngines"
      hide-mcp
    />
  </v-app>
</template>
