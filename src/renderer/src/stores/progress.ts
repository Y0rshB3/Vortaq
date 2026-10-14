import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { JobRun, ProgressEvent, RunStatus } from '@shared/types'
import { api } from '@renderer/api'
import { progressStatusText } from './progressText'

export interface ProgressEntry extends ProgressEvent {
  startedAt: number
  updatedAt: number
  /** Finished with partial failures (a job with continueOnError): amber, not red. */
  tone?: 'warning'
}

type FinishedEvent = ProgressEvent & { tone?: 'warning' }

export const PROGRESS_KIND_LABELS: Record<ProgressEvent['kind'], string> = {
  backup: 'Copia de seguridad',
  restore: 'Restauración',
  job: 'Automatización',
  import: 'Importación',
  query: 'Consulta',
  export: 'Exportación'
}

/** Operations whose main-side implementation supports cancellation. */
export function isCancellable(op: Pick<ProgressEvent, 'kind' | 'done'>): boolean {
  return (
    !op.done &&
    (op.kind === 'backup' ||
      op.kind === 'restore' ||
      op.kind === 'job' ||
      op.kind === 'import' ||
      op.kind === 'export')
  )
}

const FINAL_STATUSES: RunStatus[] = ['success', 'failed', 'cancelled']

/** Seconds a finished card stays: errors longer, job results shorter (the log keeps them). */
const LINGER_MS = { ok: 4000, error: 12000, job: 8000 }

const steps = (n: number): string => (n === 1 ? 'paso' : 'pasos')

/**
 * Final card of an automation run, consistent with the log summary: a run
 * where only some steps failed (continueOnError) "finished with errors"
 * in amber; it is only a red failure when no step succeeded.
 */
export function jobOutcome(
  run: JobRun
): Pick<FinishedEvent, 'phase' | 'message' | 'error' | 'tone'> {
  const outcome = baseOutcome(run)
  // Restore steps: say where the way back is (the log summary lists the files).
  const copies = run.tasks.filter((t) => t.type === 'restoreschema' && !!t.outputPath).length
  if (!copies) return outcome
  // Short: the card truncates; «Deshacer» is in the run history and the summary lists the files.
  const note = ` · ${copies === 1 ? 'copia previa' : `${copies} copias previas`}`
  return {
    ...outcome,
    message: `${outcome.message}${note}`,
    ...(outcome.error ? { error: `${outcome.error}${note}` } : {})
  }
}

function baseOutcome(run: JobRun): Pick<FinishedEvent, 'phase' | 'message' | 'error' | 'tone'> {
  const total = run.tasks.length
  const ok = run.tasks.filter((t) => t.status === 'success').length
  const failed = run.tasks.filter((t) => t.status === 'failed').length
  if (run.status === 'success')
    return {
      phase: 'success',
      message: total
        ? `Tarea finalizada · ${ok} de ${total} ${steps(total)} OK`
        : 'Tarea finalizada'
    }
  if (run.status === 'cancelled')
    return {
      phase: 'cancelled',
      message: total
        ? `Tarea cancelada · ${ok} de ${total} ${steps(total)} completados`
        : 'Tarea cancelada'
    }
  const counts = total ? ` · ${failed} de ${total} ${steps(total)} con error` : ''
  if (ok > 0)
    return {
      phase: 'partial',
      message: `${failed} de ${total} ${steps(total)} con error · ${ok} ${ok === 1 ? 'correcto' : 'correctos'}`,
      tone: 'warning'
    }
  const message = `La tarea ha fallado${counts}`
  return { phase: 'failed', message, error: message }
}

/** How many finished operation ids are remembered to ignore late progress events. */
const FINISHED_MEMORY = 200

export const useProgressStore = defineStore('progress', () => {
  const operations = ref<Record<string, ProgressEntry>>({})
  // Plain (non-reactive) bookkeeping: ids that already reported completion.
  const finished = new Set<string>()

  const active = computed(() => Object.values(operations.value).filter((o) => !o.done))
  /** Every tracked operation (finished ones linger a few seconds), newest first. */
  const visible = computed(() =>
    Object.values(operations.value).sort((a, b) => b.startedAt - a.startedAt)
  )
  const latestMessage = computed(() => {
    const last = [...active.value].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return last ? progressStatusText(last) : ''
  })

  function apply(event: FinishedEvent, lingerMs?: number): void {
    // A late "still running" event must not resurrect a finished operation.
    if (!event.done && finished.has(event.operationId)) return
    const now = Date.now()
    const prev = operations.value[event.operationId]
    if (event.done) markFinished(event.operationId)
    operations.value = {
      ...operations.value,
      [event.operationId]: { ...event, startedAt: prev?.startedAt ?? now, updatedAt: now }
    }
    if (event.done)
      setTimeout(
        () => remove(event.operationId),
        lingerMs ?? (event.error ? LINGER_MS.error : LINGER_MS.ok)
      )
  }

  function markFinished(operationId: string): void {
    finished.add(operationId)
    if (finished.size > FINISHED_MEMORY) finished.delete(finished.values().next().value!)
  }

  /**
   * Automation runs never send a `done` progress event: the final state arrives
   * through event:jobRun. Closes the progress entry keyed by the run id.
   */
  function applyJobRun(run: JobRun): void {
    if (!FINAL_STATUSES.includes(run.status)) return
    const prev = operations.value[run.id]
    if (!prev || prev.done) {
      markFinished(run.id)
      return
    }
    const outcome = jobOutcome(run)
    apply(
      {
        ...prev,
        kind: 'job',
        operationId: run.id,
        done: true,
        error: undefined,
        tone: undefined,
        ...outcome,
        // The card title already shows the job name.
        detail: { ...prev.detail, jobName: prev.detail?.jobName ?? run.jobName }
      },
      outcome.error ? LINGER_MS.error : outcome.tone ? LINGER_MS.job : LINGER_MS.ok
    )
  }

  function remove(operationId: string): void {
    const next = { ...operations.value }
    delete next[operationId]
    operations.value = next
  }

  async function cancel(operationId: string): Promise<void> {
    const op = operations.value[operationId]
    if (!op || !isCancellable(op)) return
    // Job progress events use the run id as operationId (see automation/runner.ts).
    if (op.kind === 'job') await api.jobs.cancel(operationId)
    else if (op.kind === 'import') await api.importers.cancel(operationId)
    else if (op.kind === 'export') await api.exports.cancel(operationId)
    else await api.backups.cancel(operationId)
  }

  function listen(): () => void {
    const offProgress = api.on('event:progress', apply)
    const offJobRun = api.on('event:jobRun', applyJobRun)
    return () => {
      offProgress()
      offJobRun()
    }
  }

  return {
    operations,
    active,
    visible,
    latestMessage,
    apply,
    applyJobRun,
    remove,
    cancel,
    listen
  }
})
