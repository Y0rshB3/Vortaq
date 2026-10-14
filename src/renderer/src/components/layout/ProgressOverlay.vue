<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  isCancellable,
  PROGRESS_KIND_LABELS,
  useProgressStore,
  type ProgressEntry
} from '@renderer/stores/progress'
import { useNotify, errorMessage } from '@renderer/composables/useNotify'
import { useConfirm } from '@renderer/composables/useConfirm'
import { useJobsStore } from '@renderer/stores/jobs'
import { describeProgress } from '@renderer/stores/progressText'
import { cancelRestorePrompt } from '@renderer/components/automation/rollback'

const progress = useProgressStore()
const notify = useNotify()
const jobs = useJobsStore()
const { ask } = useConfirm()
const cancelling = ref<Record<string, boolean>>({})
const cards = computed(() => progress.visible.map((op) => ({ op, view: describeProgress(op) })))

const KIND_ICONS: Record<ProgressEntry['kind'], string> = {
  backup: 'mdi-archive-arrow-down-outline',
  restore: 'mdi-backup-restore',
  job: 'mdi-robot-outline',
  import: 'mdi-import',
  query: 'mdi-database-search-outline',
  export: 'mdi-file-export-outline'
}

/** Job name for automation runs, the operation kind otherwise. */
function title(op: ProgressEntry): string {
  return op.detail?.jobName ?? PROGRESS_KIND_LABELS[op.kind]
}

async function cancel(op: ProgressEntry): Promise<void> {
  // Job progress uses the run id: a run that restores databases asks first.
  const run = op.kind === 'job' ? jobs.runs.find((r) => r.id === op.operationId) : undefined
  const prompt = run ? cancelRestorePrompt(run) : null
  if (prompt && !(await ask(prompt))) return
  cancelling.value = { ...cancelling.value, [op.operationId]: true }
  try {
    await progress.cancel(op.operationId)
  } catch (err) {
    notify.error(`No se pudo cancelar: ${errorMessage(err)}`)
    const next = { ...cancelling.value }
    delete next[op.operationId]
    cancelling.value = next
  }
}
</script>

<template>
  <div
    v-if="progress.visible.length"
    class="progress-overlay"
    role="region"
    aria-label="Operaciones en curso"
    data-test="progress-overlay"
  >
    <v-card
      v-for="{ op, view } in cards"
      :key="op.operationId"
      class="progress-overlay__card"
      :class="{
        'progress-overlay__card--error': op.error,
        'progress-overlay__card--warning': op.tone === 'warning' && !op.error,
        'progress-overlay__card--done': op.done && !op.error && !op.tone
      }"
      variant="flat"
      :data-test="`progress-${op.kind}`"
    >
      <div class="progress-overlay__head">
        <span class="progress-overlay__badge" aria-hidden="true">
          <v-icon
            :icon="
              op.error
                ? 'mdi-alert-circle-outline'
                : op.tone === 'warning'
                  ? 'mdi-alert-outline'
                  : op.done
                    ? 'mdi-check'
                    : KIND_ICONS[op.kind]
            "
            size="15"
          />
        </span>
        <div class="progress-overlay__titles">
          <span class="progress-overlay__kind" :title="title(op)">{{ title(op) }}</span>
          <span class="progress-overlay__phase" data-test="progress-subtitle">{{
            view.subtitle
          }}</span>
        </div>
        <v-btn
          v-if="isCancellable(op)"
          size="x-small"
          variant="text"
          color="error"
          :loading="cancelling[op.operationId]"
          data-test="progress-cancel"
          @click="cancel(op)"
          >Cancelar</v-btn
        >
        <v-btn
          v-else-if="op.done"
          icon="mdi-close"
          size="x-small"
          variant="text"
          aria-label="Descartar"
          @click="progress.remove(op.operationId)"
        />
      </div>
      <div class="progress-overlay__message" :title="view.message" data-test="progress-message">
        {{ view.message }}
      </div>
      <v-progress-linear
        :model-value="view.percent ?? 100"
        :indeterminate="!op.done && view.percent === null"
        :color="op.error ? 'error' : op.tone ? 'warning' : op.done ? 'success' : 'primary'"
        height="3"
        rounded
        class="progress-overlay__bar"
        :aria-label="`Progreso de ${PROGRESS_KIND_LABELS[op.kind]}`"
      />
      <div v-if="view.counter && !op.done" class="progress-overlay__counter">
        <span data-test="progress-counter">{{ view.counter }}</span>
        <span class="progress-overlay__percent">{{ view.percent }}%</span>
      </div>
    </v-card>
  </div>
</template>

<style scoped>
.progress-overlay {
  position: fixed;
  right: 16px;
  bottom: calc(var(--nd-statusbar-h) + 12px);
  z-index: 1500;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 340px;
  max-height: 50vh;
  overflow: auto;
}
.progress-overlay__card.v-card {
  padding: 12px 12px 10px;
  font-size: var(--nd-fs-dense);
  background: var(--nd-glass-strong);
  -webkit-backdrop-filter: var(--nd-glass-blur);
  backdrop-filter: var(--nd-glass-blur);
  border: 1px solid var(--nd-border-strong);
  border-radius: var(--nd-radius-card);
  box-shadow: var(--nd-shadow-2), var(--nd-shadow-inset);
}
.progress-overlay__card--error.v-card {
  border-color: color-mix(in srgb, var(--nd-error) 45%, transparent);
}
.progress-overlay__head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 28px;
}
.progress-overlay__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: var(--nd-accent);
  background: var(--nd-accent-gradient-soft);
  border: 1px solid rgba(var(--nd-accent-rgb), 0.25);
}
.progress-overlay__card--done .progress-overlay__badge {
  color: var(--nd-success);
  background: var(--nd-success-soft);
  border-color: color-mix(in srgb, var(--nd-success) 35%, transparent);
}
.progress-overlay__card--error .progress-overlay__badge {
  color: var(--nd-error);
  background: var(--nd-error-soft);
  border-color: color-mix(in srgb, var(--nd-error) 35%, transparent);
}
.progress-overlay__titles {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  line-height: 1.3;
}
.progress-overlay__kind {
  font-weight: 600;
  color: var(--nd-text);
}
.progress-overlay__phase {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.progress-overlay__message {
  margin: 8px 0;
  color: var(--nd-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.progress-overlay__card--error .progress-overlay__message {
  color: var(--nd-error);
}
.progress-overlay__card--warning.v-card {
  border-color: color-mix(in srgb, var(--nd-warning) 45%, transparent);
}
.progress-overlay__card--warning .progress-overlay__badge {
  color: var(--nd-warning);
  background: var(--nd-warning-soft);
  border-color: color-mix(in srgb, var(--nd-warning) 35%, transparent);
}
.progress-overlay__card--warning .progress-overlay__phase,
.progress-overlay__card--warning .progress-overlay__message {
  color: var(--nd-warning);
}
.progress-overlay__bar {
  background: var(--nd-hairline);
}
.progress-overlay__counter {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-family: var(--nd-font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  color: var(--nd-text-muted);
}
.progress-overlay__percent {
  color: var(--nd-text-2);
}
</style>
