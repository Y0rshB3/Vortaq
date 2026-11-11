<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  historySummary,
  historyTitle,
  searchHistory,
  type QueryHistoryEntry
} from '@shared/queryHistory'
import DialogHeader from '@renderer/components/dialogs/DialogHeader.vue'
import { useNotify } from '@renderer/composables/useNotify'
import { useQueryHistoryStore } from '@renderer/stores/queryHistory'

/**
 * «Historial de consultas»: the scripts run from query tabs, newest first.
 * «Abrir» puts one in the tab's editor (the parent decides how); nothing runs
 * from here.
 */
const open = defineModel<boolean>({ required: true })
const props = defineProps<{ connectionId: string | null; connectionName: string }>()
const emit = defineEmits<{ use: [entry: QueryHistoryEntry] }>()

const history = useQueryHistoryStore()
const notify = useNotify()
const query = ref('')
const onlyThis = ref(true)

const items = computed(() =>
  searchHistory(history.entries, query.value, onlyThis.value ? props.connectionId : null).slice(
    0,
    200
  )
)

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })
}

function use(entry: QueryHistoryEntry): void {
  emit('use', entry)
  open.value = false
}

async function copy(entry: QueryHistoryEntry): Promise<void> {
  try {
    await navigator.clipboard.writeText(entry.sql)
    notify.success('SQL copiado al portapapeles')
  } catch {
    notify.error('No se pudo copiar: abre la consulta y cópiala desde el editor.')
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="820" scrollable>
    <v-card data-test="query-history">
      <DialogHeader
        icon="mdi-history"
        title="Historial de consultas"
        subtitle="Lo que ejecutaste en las pestañas de consulta, en este equipo"
      />
      <div class="query-history__bar">
        <v-text-field
          v-model="query"
          density="compact"
          hide-details
          clearable
          autofocus
          prepend-inner-icon="mdi-magnify"
          placeholder="Buscar en el SQL, la conexión o la base de datos"
          data-test="query-history-search"
        />
        <v-switch
          v-model="onlyThis"
          :disabled="!connectionId"
          :label="`Solo ${connectionName || 'esta conexión'}`"
          density="compact"
          hide-details
          color="primary"
          data-test="query-history-only-this"
        />
      </div>
      <v-card-text class="query-history__list">
        <div v-if="!history.enabled" class="query-history__empty">
          El historial está desactivado: no se guarda lo que ejecutas.
        </div>
        <div v-else-if="!items.length" class="query-history__empty" data-test="query-history-empty">
          {{ query ? 'Nada coincide con la búsqueda.' : 'Aún no has ejecutado nada aquí.' }}
        </div>
        <div
          v-for="entry in items"
          :key="entry.id"
          class="query-history__item"
          :data-test="`query-history-item-${entry.id}`"
          @dblclick="use(entry)"
        >
          <div class="query-history__head">
            <v-icon
              :icon="entry.ok ? 'mdi-check-circle-outline' : 'mdi-alert-circle-outline'"
              :color="entry.ok ? 'success' : 'error'"
              size="16"
              :aria-label="entry.ok ? 'Correcta' : 'Con error'"
            />
            <code class="query-history__title nd-ellipsis" :title="entry.sql">{{
              historyTitle(entry)
            }}</code>
            <v-spacer />
            <v-btn
              size="x-small"
              variant="text"
              icon="mdi-content-copy"
              title="Copiar SQL"
              aria-label="Copiar SQL"
              @click="copy(entry)"
            />
            <v-btn
              size="x-small"
              variant="text"
              icon="mdi-delete-outline"
              title="Quitar del historial"
              aria-label="Quitar del historial"
              @click="history.remove(entry.id)"
            />
            <v-btn
              size="small"
              variant="tonal"
              color="primary"
              :data-test="`query-history-use-${entry.id}`"
              @click="use(entry)"
              >Abrir</v-btn
            >
          </div>
          <div class="query-history__meta">
            {{ entry.connectionName
            }}<template v-if="entry.database"> · {{ entry.database }}</template> ·
            {{ when(entry.at) }} · {{ historySummary(entry)
            }}<template v-if="entry.truncated"> · recortado</template>
          </div>
        </div>
      </v-card-text>
      <v-card-actions>
        <v-switch
          :model-value="history.enabled"
          label="Guardar historial"
          density="compact"
          hide-details
          color="primary"
          data-test="query-history-enabled"
          @update:model-value="history.setEnabled($event === true)"
        />
        <v-spacer />
        <v-btn
          :disabled="!history.entries.length"
          prepend-icon="mdi-delete-sweep-outline"
          data-test="query-history-clear"
          @click="history.clear()"
          >Borrar historial</v-btn
        >
        <v-btn @click="open = false">Cerrar</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.query-history__bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 20px 8px;
}
.query-history__list {
  min-height: min(320px, 45vh);
  display: grid;
  align-content: start;
  gap: 6px;
}
.query-history__empty {
  color: var(--nd-text-2);
  font-size: var(--nd-fs-dense);
  padding: 12px 0;
}
.query-history__item {
  padding: 6px 10px;
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-sm);
  background: var(--nd-bg-sunken);
}
.query-history__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.query-history__title {
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  min-width: 0;
}
.query-history__meta {
  margin-top: 2px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
</style>
