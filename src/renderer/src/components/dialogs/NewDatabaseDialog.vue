<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '@renderer/api'
import { typedTarget, useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTreeStore } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import { descriptorOf } from '@renderer/engines/capabilities'
import DialogHeader from './DialogHeader.vue'

type Charset = { charset: string; defaultCollation: string; collations: string[] }

const ui = useUiStore()
const connections = useConnectionsStore()
const tree = useTreeStore()
const notify = useNotify()
const { confirmDestructive } = useConfirm()

const name = ref('')
const charset = ref('utf8mb4')
const collation = ref('')
const charsets = ref<Charset[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
/* PostgreSQL options (CREATE DATABASE … OWNER … TEMPLATE … ENCODING …); empty = server default. */
const owner = ref('')
const template = ref('')
const encoding = ref('')

const connectionId = computed(() => ui.newDatabaseDialog.connectionId)
/** PostgreSQL asks for owner/template/encoding instead of a charset and collation. */
const isPg = computed(
  () =>
    !!connectionId.value &&
    descriptorOf(connections.get(connectionId.value))?.capabilities.createDatabase === 'pg'
)
/** SQL Server: a name and an optional collation (COLLATE), no charset. */
const isMs = computed(
  () =>
    !!connectionId.value &&
    descriptorOf(connections.get(connectionId.value))?.capabilities.createDatabase === 'sqlserver'
)
/** MongoDB creates a database with its first collection (no charset). */
const isMongo = computed(
  () =>
    !!connectionId.value &&
    descriptorOf(connections.get(connectionId.value))?.capabilities.createDatabase === 'mongo'
)
const firstCollection = ref('')
const open = computed({
  get: () => ui.newDatabaseDialog.open,
  set: (value: boolean) => {
    ui.newDatabaseDialog = { ...ui.newDatabaseDialog, open: value }
  }
})
const charsetItems = computed(() => charsets.value.map((c) => c.charset).sort())
const collationItems = computed(
  () => charsets.value.find((c) => c.charset === charset.value)?.collations ?? []
)
const nameError = computed(() => {
  const n = name.value.trim()
  if (!n) return ''
  if (n.length > 64) return 'Máximo 64 caracteres'
  if (/[/\\.`]/.test(n)) return 'No uses /, \\, . ni `'
  return ''
})
const canSave = computed(
  () =>
    !!connectionId.value &&
    !!name.value.trim() &&
    !nameError.value &&
    (isPg.value || isMongo.value || isMs.value || !!charset.value) &&
    (!isMongo.value || !!firstCollection.value.trim()) &&
    !saving.value
)

function defaultCollationOf(cs: string): string {
  return charsets.value.find((c) => c.charset === cs)?.defaultCollation ?? ''
}

async function loadCharsets(): Promise<void> {
  if (!connectionId.value) return
  loading.value = true
  try {
    charsets.value = await api.db.charsets(connectionId.value)
    if (!charsets.value.some((c) => c.charset === charset.value))
      charset.value = charsets.value[0]?.charset ?? ''
    collation.value = defaultCollationOf(charset.value)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

watch(
  () => ui.newDatabaseDialog.open,
  (value) => {
    if (!value) return
    name.value = ''
    charset.value = 'utf8mb4'
    collation.value = ''
    error.value = ''
    owner.value = ''
    template.value = ''
    encoding.value = ''
    firstCollection.value = ''
    if (!isPg.value && !isMongo.value && !isMs.value) void loadCharsets()
  },
  { immediate: true }
)

function onCharsetChange(value: string): void {
  charset.value = value
  collation.value = defaultCollationOf(value)
}

async function save(): Promise<void> {
  if (!canSave.value || !connectionId.value) return
  saving.value = true
  error.value = ''
  const cid = connectionId.value
  const dbName = name.value.trim()
  try {
    // CREATE DATABASE is a write: guarded connections (production, Ajustes › Seguridad) need the
    // typed name.
    const ok = await confirmDestructive({
      connectionId: cid,
      title: 'Crear base de datos',
      message: `Se creará la base de datos «${dbName}» en «${connections.nameOf(cid)}».`,
      confirmText: `Crear en ${typedTarget(connections.get(cid))}`,
      alwaysAsk: false
    })
    if (!ok) return
    // Silent invoke: the error is shown inline in the dialog, not twice.
    if (isMongo.value) {
      await api.invokeSilent(
        'db:createDatabase',
        cid,
        dbName,
        '',
        '',
        { confirmProduction: true },
        { collection: firstCollection.value.trim() }
      )
    } else if (isMs.value) {
      await api.invokeSilent(
        'db:createDatabase',
        cid,
        dbName,
        '',
        collation.value.trim(),
        { confirmProduction: true }
      )
    } else if (isPg.value) {
      const engineOptions: Record<string, string> = {}
      if (owner.value.trim()) engineOptions.owner = owner.value.trim()
      if (template.value.trim()) engineOptions.template = template.value.trim()
      if (encoding.value.trim()) engineOptions.encoding = encoding.value.trim()
      await api.invokeSilent(
        'db:createDatabase',
        cid,
        dbName,
        '',
        '',
        { confirmProduction: true },
        engineOptions
      )
    } else
      await api.invokeSilent(
        'db:createDatabase',
        cid,
        dbName,
        charset.value,
        collation.value || defaultCollationOf(charset.value),
        { confirmProduction: true }
      )
    notify.success(`Base de datos ${dbName} creada`)
    open.value = false
    await tree.loadDatabases(cid, true).catch(() => undefined)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="480">
    <v-card data-test="new-database-dialog">
      <DialogHeader
        icon="mdi-database-plus"
        title="Nueva base de datos"
        :subtitle="connectionId ? connections.nameOf(connectionId) : undefined"
      />
      <v-card-text class="d-flex flex-column ga-3 newdb-dialog__body">
        <v-text-field
          v-model="name"
          label="Nombre"
          autofocus
          class="newdb-dialog__name"
          :error-messages="nameError ? [nameError] : []"
          data-test="newdb-name"
          @keyup.enter="save"
        />
        <v-text-field
          v-if="isMs"
          v-model="collation"
          label="Intercalación (opcional)"
          placeholder="La del servidor, p. ej. Modern_Spanish_CI_AS"
          persistent-placeholder
          class="nd-mono-input"
          data-test="newdb-ms-collation"
        />
        <template v-if="isPg">
          <v-text-field
            v-model="owner"
            label="Propietario (opcional)"
            placeholder="Usuario de la conexión"
            data-test="newdb-owner"
          />
          <v-text-field
            v-model="template"
            label="Plantilla (opcional)"
            placeholder="template1"
            data-test="newdb-template"
          />
          <v-text-field
            v-model="encoding"
            label="Codificación (opcional)"
            placeholder="UTF8"
            data-test="newdb-encoding"
          />
        </template>
        <v-text-field
          v-if="isMongo"
          v-model="firstCollection"
          label="Primera colección"
          hint="MongoDB crea la base de datos junto con su primera colección."
          persistent-hint
          class="newdb-dialog__name"
          data-test="newdb-collection"
          @keyup.enter="save"
        />
        <v-autocomplete
          v-if="!isPg && !isMongo && !isMs"
          :model-value="charset"
          :items="charsetItems"
          :loading="loading"
          label="Juego de caracteres"
          @update:model-value="onCharsetChange"
        />
        <v-autocomplete
          v-if="!isPg && !isMongo && !isMs"
          v-model="collation"
          :items="collationItems"
          :loading="loading"
          label="Intercalación"
        />
        <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">Cancelar</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :disabled="!canSave"
          :loading="saving"
          data-test="newdb-save"
          @click="save"
          >Crear</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.newdb-dialog__body {
  padding-top: 4px !important;
}
.newdb-dialog__name :deep(input) {
  font-family: var(--nd-font-mono);
}
</style>
