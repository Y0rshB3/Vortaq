<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import type { QueryStatementResult } from '@shared/types'
import { environmentLabel, environmentPillClass } from '@renderer/components/backups/backupHelpers'
import EditableResult from '@renderer/components/query/EditableResult.vue'
import QueryMessages from '@renderer/components/query/QueryMessages.vue'
import { formatDuration, formatNumber } from '@renderer/utils/format'
import type { ResultsState } from '../../webviewState'
import type { WebviewHost } from '../bridge'
import { FORMAT_LABELS, formatRows, type CopyFormat } from './copyFormats'
import DocumentsView from './DocumentsView.vue'

/**
 * Results of a SQL document run, of «Ver datos» or of «Ver documentos». The
 * SQL results reuse the desktop query view's pieces: the Mensajes list and
 * one EditableResult per result set (editable when its statement reads one
 * table with its key; Aplicar goes through the host's guard).
 */
const props = defineProps<{ host: WebviewHost<ResultsState>; initial: ResultsState }>()

const state = shallowRef<ResultsState>(props.initial)
props.host.onState((next) => (state.value = next))

const connection = computed(() => state.value.connection)
const results = computed<QueryStatementResult[]>(() => state.value.results)
const resultSets = computed(() =>
  results.value
    .map((r, index) => ({ r, index }))
    .filter((x) => x.r.resultSet)
    .map((x, n) => ({
      key: `rs${x.index}`,
      label: `Resultado ${n + 1}`,
      sql: x.r.sql,
      set: x.r.resultSet!,
      storage: x.r.storage
    }))
)
const errorCount = computed(() => results.value.filter((r) => r.error).length)
const tab = ref<string>('messages')
const pendingEdits = ref<Record<string, boolean>>({})

// A new run shows its first result set, or Mensajes when something failed.
watch(
  () => [state.value.runId, state.value.running] as const,
  ([, running]) => {
    if (running) return
    pendingEdits.value = {}
    const first = resultSets.value[0]
    tab.value = errorCount.value || state.value.notice || !first ? 'messages' : first.key
  },
  { immediate: true }
)

// The host asks before a new run replaces results with unapplied edits.
watch(
  () => Object.values(pendingEdits.value).some(Boolean),
  (dirty) => props.host.post({ type: 'dirty', dirty })
)

const activeSet = computed(() => resultSets.value.find((rs) => rs.key === tab.value) ?? null)

function copy(format: CopyFormat): void {
  const rs = activeSet.value
  if (!rs) return
  const text = formatRows(
    format,
    rs.set.columns.map((c) => c.name),
    rs.set.rows
  )
  const rows = rs.set.rows.length
  props.host.post({
    type: 'clipboard',
    text,
    label: `${formatNumber(rows)} fila(s) copiadas como ${format.toUpperCase()}`
  })
}

function stop(): void {
  props.host.post({ type: 'stop' })
}
</script>

<template>
  <v-app class="vq-webview vq-results">
    <div class="vq-results__bar" data-test="results-bar">
      <v-icon
        :icon="
          connection.environment === 'production'
            ? 'mdi-shield-alert-outline'
            : 'mdi-database-outline'
        "
        size="16"
        class="vq-results__icon"
        aria-hidden="true"
      />
      <span class="vq-results__conn">{{ connection.name }}</span>
      <span v-if="state.target" class="vq-results__target nd-mono">{{ state.target }}</span>
      <span
        class="nd-pill"
        :class="environmentPillClass(connection.environment)"
        data-test="results-env"
        >{{ environmentLabel(connection.environment) }}</span
      >
      <span class="vq-results__spacer" />
      <span class="vq-results__status" aria-live="polite" data-test="results-status">
        <template v-if="state.running">
          <v-progress-circular indeterminate size="12" width="1.5" />
          Ejecutando…
        </template>
        <template v-else-if="state.totalMs !== null && state.kind === 'sql'">
          {{ results.length }} sentencia(s) · {{ formatDuration(state.totalMs) }}
        </template>
      </span>
      <v-btn
        v-if="state.running && state.canStop"
        size="small"
        variant="tonal"
        color="error"
        prepend-icon="mdi-stop"
        data-test="results-stop"
        @click="stop"
        >Detener</v-btn
      >
    </div>
    <v-progress-linear v-if="state.running" indeterminate height="2" />

    <DocumentsView
      v-if="state.kind === 'documents'"
      :documents="state.documents"
      :notice="state.notice"
      :running="state.running"
      :host="host"
    />

    <template v-else>
      <div class="vq-results__tabs">
        <v-tabs v-model="tab" density="compact" color="primary" show-arrows>
          <v-tab value="messages" prepend-icon="mdi-message-text-outline" data-test="tab-messages">
            Mensajes
            <span v-if="errorCount" class="vq-results__count vq-results__count--error">{{
              errorCount
            }}</span>
          </v-tab>
          <v-tab
            v-for="rs in resultSets"
            :key="rs.key"
            :value="rs.key"
            prepend-icon="mdi-table"
            :data-test="`tab-${rs.key}`"
          >
            {{ rs.label }}
            <span
              v-if="pendingEdits[rs.key]"
              class="vq-results__pending"
              aria-label="Cambios sin aplicar"
            />
            <span class="vq-results__count">{{ formatNumber(rs.set.rows.length) }}</span>
          </v-tab>
        </v-tabs>
        <span class="vq-results__spacer" />
        <v-menu location="bottom end">
          <template #activator="{ props: menuProps }">
            <v-btn
              v-bind="menuProps"
              size="small"
              variant="text"
              prepend-icon="mdi-content-copy"
              :disabled="!activeSet"
              title="Copia todas las filas del resultado activo"
              data-test="results-copy"
              >Copiar</v-btn
            >
          </template>
          <v-list density="compact">
            <v-list-item
              v-for="(label, format) in FORMAT_LABELS"
              :key="format"
              :title="`Copiar como ${label}`"
              :data-test="`copy-${format}`"
              @click="copy(format)"
            />
          </v-list>
        </v-menu>
      </div>
      <v-window v-model="tab" class="vq-results__window">
        <v-window-item value="messages" class="vq-results__fill">
          <QueryMessages :results="results" :notice="state.notice" />
        </v-window-item>
        <v-window-item
          v-for="rs in resultSets"
          :key="rs.key"
          :value="rs.key"
          class="vq-results__fill"
        >
          <EditableResult
            :key="`${state.runId}-${rs.key}`"
            :connection-id="connection.id"
            :sql="rs.sql"
            :columns="rs.set.columns"
            :rows="rs.set.rows"
            :truncated="rs.set.truncated"
            :storage="rs.storage"
            @dirty="pendingEdits = { ...pendingEdits, [rs.key]: $event }"
          />
        </v-window-item>
      </v-window>
    </template>
  </v-app>
</template>

<style scoped>
.vq-results :deep(.v-application__wrap) {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.vq-results__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  min-height: 36px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--nd-border);
  background: var(--nd-bg-panel);
}
.vq-results__icon {
  color: var(--nd-text-2);
}
.vq-results__conn {
  font-weight: 600;
  white-space: nowrap;
}
.vq-results__target {
  color: var(--nd-text-2);
  font-size: var(--nd-fs-small);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vq-results__spacer {
  flex: 1 1 auto;
}
.vq-results__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--nd-text-2);
  font-size: var(--nd-fs-small);
  white-space: nowrap;
}
.vq-results__tabs {
  display: flex;
  align-items: center;
  flex: none;
  padding-right: 8px;
  border-bottom: 1px solid var(--nd-hairline);
}
.vq-results__tabs :deep(.v-tabs) {
  min-width: 0;
}
.vq-results__count {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: var(--nd-radius-pill);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  background: var(--nd-hover);
}
.vq-results__count--error {
  color: var(--nd-error);
  background: var(--nd-error-soft);
}
.vq-results__pending {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-left: 6px;
  border-radius: 50%;
  background: var(--nd-warning);
}
.vq-results__window {
  flex: 1 1 0;
  min-height: 0;
}
.vq-results__window :deep(.v-window__container) {
  height: 100%;
}
.vq-results__fill {
  height: 100%;
}
</style>
