<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CellValue, QueryColumn } from '@shared/types'
import ResultGrid from '@renderer/components/common/ResultGrid.vue'
import {
  bsonTypeOf,
  cellPreview,
  parseEjson,
  shellText,
  type EjsonObject,
  type EjsonValue
} from '@shared/mongo/shellFormat'
import { formatDuration, formatNumber } from '@renderer/utils/format'
import type { DocumentsResult, ResultsState } from '../../webviewState'
import type { WebviewHost } from '../bridge'
import { formatRows } from './copyFormats'

/**
 * «Ver documentos» (read-only in this version): the first documents of a
 * collection as a table of top-level fields or as shell-syntax JSON. Values
 * arrive as canonical Extended JSON, so an Int64 or a Decimal128 is shown
 * exactly (NumberLong('…'), Decimal128('…')).
 */
const props = defineProps<{
  documents: DocumentsResult | null
  notice: string | null
  running: boolean
  host: WebviewHost<ResultsState>
}>()

const view = ref<'table' | 'json'>('table')

const parsed = computed<EjsonObject[]>(() =>
  (props.documents?.docs ?? []).map((text) => {
    try {
      const value = parseEjson(text)
      return value && typeof value === 'object' && !Array.isArray(value) ? value : { valor: value }
    } catch {
      return { error: text }
    }
  })
)

/** Top-level fields in order of first appearance, `_id` first. */
const fields = computed(() => {
  const names: string[] = []
  for (const doc of parsed.value)
    for (const key of Object.keys(doc)) if (!names.includes(key)) names.push(key)
  return names.includes('_id') ? ['_id', ...names.filter((n) => n !== '_id')] : names
})

const columns = computed<QueryColumn[]>(() =>
  fields.value.map((name) => {
    const sample = parsed.value.find((d) => d[name] !== undefined)?.[name]
    return { name, type: sample === undefined ? '' : bsonTypeOf(sample as EjsonValue) }
  })
)

const rows = computed<CellValue[][]>(() =>
  parsed.value.map((doc) =>
    fields.value.map((name) =>
      doc[name] === undefined ? null : cellPreview(doc[name] as EjsonValue)
    )
  )
)

const summary = computed(() => {
  const d = props.documents
  if (!d) return ''
  const shown = `${formatNumber(d.docs.length)} documento(s)`
  const total =
    d.total !== null && (d.truncated || d.total !== d.docs.length)
      ? ` de ${d.totalExact ? '' : '~'}${formatNumber(d.total)}`
      : ''
  return `${shown}${total} · ${formatDuration(d.durationMs)}`
})

function copy(format: 'tsv' | 'csv' | 'ejson'): void {
  const d = props.documents
  if (!d) return
  const text =
    format === 'ejson'
      ? `[\n${d.docs.join(',\n')}\n]`
      : formatRows(format, fields.value, rows.value)
  props.host.post({
    type: 'clipboard',
    text,
    label: `${formatNumber(d.docs.length)} documento(s) copiados como ${format === 'ejson' ? 'Extended JSON' : format.toUpperCase()}`
  })
}
</script>

<template>
  <div class="vq-docs">
    <div class="vq-docs__bar">
      <v-btn-toggle v-model="view" density="compact" mandatory variant="text" divided>
        <v-btn value="table" size="small" prepend-icon="mdi-table" data-test="docs-table"
          >Tabla</v-btn
        >
        <v-btn value="json" size="small" prepend-icon="mdi-code-json" data-test="docs-json"
          >JSON</v-btn
        >
      </v-btn-toggle>
      <span
        class="nd-status-pill vq-docs__ro"
        title="La edición de documentos llegará en una versión posterior"
      >
        <v-icon icon="mdi-lock-outline" size="13" aria-hidden="true" />
        Solo lectura
      </span>
      <span class="vq-docs__spacer" />
      <span class="vq-docs__summary" data-test="docs-summary">{{ summary }}</span>
      <v-menu location="bottom end">
        <template #activator="{ props: menuProps }">
          <v-btn
            v-bind="menuProps"
            size="small"
            variant="text"
            prepend-icon="mdi-content-copy"
            :disabled="!documents?.docs.length"
            >Copiar</v-btn
          >
        </template>
        <v-list density="compact">
          <v-list-item title="Copiar como Extended JSON" @click="copy('ejson')" />
          <v-list-item title="Copiar la tabla como TSV" @click="copy('tsv')" />
          <v-list-item title="Copiar la tabla como CSV" @click="copy('csv')" />
        </v-list>
      </v-menu>
    </div>
    <div v-if="notice" class="vq-docs__notice">
      <v-icon icon="mdi-alert-outline" size="16" />
      <span>{{ notice }}</span>
    </div>
    <div v-else-if="!running && documents && !documents.docs.length" class="vq-docs__empty">
      La colección no tiene documentos.
    </div>
    <div v-else-if="view === 'table'" class="vq-docs__grid">
      <ResultGrid :columns="columns" :rows="rows" :truncated="documents?.truncated ?? false" />
    </div>
    <div v-else class="vq-docs__json" data-test="docs-json-list">
      <article v-for="(doc, i) in parsed" :key="i" class="vq-docs__doc">
        <header class="vq-docs__doc-head">#{{ i + 1 }}</header>
        <pre class="nd-mono">{{ shellText(doc, { indent: 2 }) }}</pre>
      </article>
    </div>
  </div>
</template>

<style scoped>
.vq-docs {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
}
.vq-docs__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 4px 8px;
  border-bottom: 1px solid var(--nd-hairline);
}
.vq-docs__ro {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.vq-docs__spacer {
  flex: 1 1 auto;
}
.vq-docs__summary {
  color: var(--nd-text-2);
  font-size: var(--nd-fs-small);
  white-space: nowrap;
}
.vq-docs__notice,
.vq-docs__empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  color: var(--nd-text-2);
}
.vq-docs__notice {
  color: var(--nd-error);
}
.vq-docs__grid {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
}
.vq-docs__json {
  flex: 1 1 0;
  min-height: 0;
  overflow: auto;
  padding: 8px 12px;
}
.vq-docs__doc {
  margin-bottom: 8px;
  border: 1px solid var(--nd-hairline);
  border-radius: var(--nd-radius-control);
  content-visibility: auto;
  contain-intrinsic-size: auto 120px;
}
.vq-docs__doc-head {
  padding: 2px 8px;
  color: var(--nd-text-2);
  font-size: var(--nd-fs-xs);
  border-bottom: 1px solid var(--nd-hairline);
}
.vq-docs__doc pre {
  margin: 0;
  padding: 6px 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--nd-fs-dense);
}
</style>
