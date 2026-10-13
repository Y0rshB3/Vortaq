<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionTestResult,
  EngineId,
  MongoAuthMechanism,
  MongoOptions,
  MongoReadPreference,
  MongoTopology,
  MysqlAuthMode,
  SqliteAttachedDatabase,
  SqliteOptions,
  SslMode
} from '@shared/types'
import {
  DEFAULT_NETWORK,
  ENGINES,
  defaultMongoOptions,
  defaultPostgresOptions,
  defaultSqliteOptions,
  pickableEngines
} from '@shared/engines'
import { isAbsolutePathFor } from '@shared/connectionValidation'
import { parseMongoUri } from '@shared/mongo/uri'
import { can } from '@renderer/engines/capabilities'
import { api } from '@renderer/api'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useUiStore } from '@renderer/stores/ui'
import { useSettingsStore } from '@renderer/stores/settings'
import PathPicker from '@renderer/components/common/PathPicker.vue'
import './pathField.css'
import { vPathTail } from './pathTail'
import DialogHeader from './DialogHeader.vue'
import { ENVIRONMENTS, environmentLabel } from '@renderer/components/backups/backupHelpers'
import {
  COLOR_PRESETS,
  PG_SSL_MODES,
  SQLITE_FILE_FILTERS,
  emptyConnectionInput,
  inputFromConnection,
  normalizeConnectionInput,
  sqliteNameFromPath,
  validateConnectionInput,
  withSslMode
} from './connectionForm'
import { recentSqliteFiles, rememberSqliteFile } from '@renderer/utils/sqliteRecent'
import { MONGO_READ_PREFERENCE_LABELS } from '@shared/mongo/readPreference'

const props = defineProps<{
  /**
   * Engines this host cannot run, left out of the engine picker (the editor
   * extension hides SQLite when the editor's Node lacks node:sqlite). The
   * desktop app passes nothing.
   */
  hiddenEngines?: EngineId[]
}>()

const ui = useUiStore()
const connections = useConnectionsStore()
const settingsStore = useSettingsStore()
const notify = useNotify()

const tab = ref<'general' | 'ssh' | 'ssl' | 'advanced'>('general')
const form = ref<ConnectionInput>(emptyConnectionInput())
// Secrets live only in memory and go straight to the CredentialStore via IPC.
const password = ref('')
const sshPassword = ref('')
const hasPassword = ref(false)
const hasSshPassword = ref(false)
const clearPassword = ref(false)
const clearSshPassword = ref(false)
const showPassword = ref(false)
const testing = ref(false)
const testResult = ref<ConnectionTestResult | null>(null)
const saving = ref(false)
const errors = ref<string[]>([])
// PostgreSQL client-key passphrase (CredentialStore 'sslKey'), like the other secrets.
const sslKeyPassword = ref('')
const hasSslKeyPassword = ref(false)
const clearSslKeyPassword = ref(false)

const engine = computed<EngineId>(() => form.value.engine ?? 'mysql')
const isPg = computed(() => engine.value === 'postgresql')
const isSqlite = computed(() => engine.value === 'sqlite')
const isMongo = computed(() => engine.value === 'mongodb')
const isMariaDb = computed(() => engine.value === 'mariadb')
const engineLabel = computed(() => ENGINES[engine.value]?.label ?? 'MySQL')
/** Backup folder fields: every engine with backups (.nb3 or .vqb). */
const showBackupDirs = computed(
  () =>
    can({ engine: engine.value }, 'supportsBackupsNb3') ||
    can({ engine: engine.value }, 'supportsBackupsVqb')
)
/** Engines offered for a new connection (every engine; the engine of a saved one is fixed). */
const engineChoices = computed(() =>
  editing.value ? [] : pickableEngines().filter((e) => !props.hiddenEngines?.includes(e.id))
)

function selectEngine(id: EngineId): void {
  if (id === engine.value) return
  const keep = {
    name: form.value.name,
    environment: form.value.environment,
    color: form.value.color
  }
  form.value = { ...emptyConnectionInput(id), ...keep }
  testResult.value = null
  errors.value = []
}

/* ---------- SQLite: a database file (design 8.2) ---------- */

const liteOptions = computed<SqliteOptions>(() => ({
  ...defaultSqliteOptions(form.value.environment === 'production'),
  ...form.value.sqlite
}))
function patchSqlite(patch: Partial<SqliteOptions>): void {
  form.value = { ...form.value, sqlite: { ...liteOptions.value, ...patch } }
}
const hostPlatform = (): string => {
  try {
    return window.vortaq?.platform ?? 'any'
  } catch {
    return 'any'
  }
}
const liteFileName = computed(() => {
  const path = liteOptions.value.filePath
  return path ? (path.split(/[\\/]/).pop() ?? path) : ''
})
/** The stored path came from another computer, or is not a valid path here. */
const litePathNeedsReview = computed(() => {
  const path = liteOptions.value.filePath.trim()
  if (!path) return false
  return liteOptions.value.pathNeedsReview === true || !isAbsolutePathFor(path, hostPlatform())
})
const liteBusy = ref(false)

/** «Recientes»: SQLite files opened or created here before (new connections only). */
const recentLiteFiles = ref<string[]>([])
const recentLiteItems = computed(() =>
  recentLiteFiles.value
    .filter((p) => p !== liteOptions.value.filePath)
    .map((p) => ({
      path: p,
      name: p.split(/[\\/]/).pop() ?? p,
      // The end of a long path says more than its start (/Users/… is the same for all).
      shown: p.length > 56 ? `…${p.slice(-55)}` : p
    }))
)
function refreshRecentLiteFiles(): void {
  recentLiteFiles.value = recentSqliteFiles()
}

function useLiteFile(path: string): void {
  rememberSqliteFile(path)
  patchSqlite({ filePath: path, pathNeedsReview: false })
  if (!form.value.name.trim()) form.value = { ...form.value, name: sqliteNameFromPath(path) }
  testResult.value = null
}

/** «Abrir archivo…»: an existing file (never created). */
async function pickLiteFile(): Promise<void> {
  const path = await api.app.pickFile('Abrir base de datos SQLite', SQLITE_FILE_FILTERS)
  if (path) useLiteFile(path)
}

/**
 * «Crear base de datos nueva…»: the only way the app creates a SQLite file.
 * Files created here apply foreign keys (design section 20).
 */
async function createLiteFile(): Promise<void> {
  const path = await api.app.pickSaveFile(
    'Crear base de datos SQLite',
    'nueva.db',
    SQLITE_FILE_FILTERS.slice(0, 1)
  )
  if (!path) return
  liteBusy.value = true
  try {
    const created = await api.sqlite.createFile(path)
    useLiteFile(created.filePath)
    patchSqlite({ foreignKeys: true })
    notify.success(`Base de datos ${liteFileName.value} creada`)
  } catch {
    /* api.invoke already showed the error; nothing was saved */
  } finally {
    liteBusy.value = false
  }
}

function patchAttached(index: number, patch: Partial<SqliteAttachedDatabase>): void {
  const attached = liteOptions.value.attached.map((a, i) => (i === index ? { ...a, ...patch } : a))
  patchSqlite({ attached })
}
function addAttached(): void {
  patchSqlite({ attached: [...liteOptions.value.attached, { alias: '', filePath: '' }] })
}
function removeAttached(index: number): void {
  patchSqlite({ attached: liteOptions.value.attached.filter((_, i) => i !== index) })
}
async function pickAttachedFile(index: number): Promise<void> {
  const path = await api.app.pickFile('Base de datos adjunta', SQLITE_FILE_FILTERS)
  if (!path) return
  const current = liteOptions.value.attached[index]
  patchAttached(index, {
    filePath: path,
    pathNeedsReview: false,
    alias: current?.alias.trim() ? current.alias : sqliteNameFromPath(path).replace(/\W+/g, '_')
  })
}

// A new SQLite connection opens read-only by default in production (defaultSqliteOptions).
watch(
  () => form.value.environment,
  (env, previous) => {
    if (!isSqlite.value || editing.value || env === previous) return
    patchSqlite({ readOnly: env === 'production' })
  }
)

/* ---------- MongoDB (design 8.2) ---------- */

const mongoOptions = computed<MongoOptions>(() => ({
  ...defaultMongoOptions(),
  ...form.value.mongo
}))
function patchMongo(patch: Partial<MongoOptions>): void {
  const mongo = { ...mongoOptions.value, ...patch }
  // The password plan follows the mechanism: none / X.509 never send a password.
  const authMode: MysqlAuthMode =
    mongo.authMechanism === 'none' || mongo.authMechanism === 'x509' ? 'none' : 'password'
  form.value = { ...form.value, mongo, authMode }
}
const MONGO_TOPOLOGIES: { value: MongoTopology; title: string }[] = [
  { value: 'standalone', title: 'Independiente' },
  { value: 'replicaSet', title: 'Conjunto de réplicas' },
  { value: 'shardCluster', title: 'Clúster fragmentado (mongos)' }
]
const MONGO_MECHANISMS: { value: MongoAuthMechanism; title: string }[] = [
  { value: 'none', title: 'Sin autenticación' },
  { value: 'default', title: 'Usuario y contraseña (SCRAM)' },
  { value: 'scram-sha-256', title: 'SCRAM-SHA-256' },
  { value: 'scram-sha-1', title: 'SCRAM-SHA-1' },
  { value: 'plain', title: 'LDAP (PLAIN)' },
  { value: 'x509', title: 'Certificado X.509' }
]
const MONGO_READ_PREFERENCES: { value: MongoReadPreference; title: string }[] = (
  Object.entries(MONGO_READ_PREFERENCE_LABELS) as [MongoReadPreference, string][]
).map(([value, title]) => ({ value, title }))
/** Seed list (replica set / sharded cluster) instead of host and port. */
const mongoUsesMembers = computed(
  () => isMongo.value && !mongoOptions.value.srv && mongoOptions.value.topology !== 'standalone'
)
const mongoMembers = computed<string[]>({
  get: () => mongoOptions.value.members.map((m) => `${m.host}:${m.port}`),
  set: (items) =>
    patchMongo({
      members: items
        .map((item) => {
          const m = /^\s*\[?([^\]]+?)\]?(?::(\d+))?\s*$/.exec(item)
          return m ? { host: m[1], port: Number(m[2] ?? 27017) } : null
        })
        .filter((m): m is { host: string; port: number } => !!m && !!m.host)
    })
})
/** Extra (non-secret) URI options as `clave=valor` lines. */
const mongoExtraText = computed({
  get: () =>
    Object.entries(mongoOptions.value.extraOptions)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  set: (text: string) => {
    const extraOptions: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=')
      const key = (eq >= 0 ? line.slice(0, eq) : line).trim()
      if (key) extraOptions[key] = eq >= 0 ? line.slice(eq + 1).trim() : ''
    }
    patchMongo({ extraOptions })
  }
})
/** SRV records always use TLS. */
function setMongoSrv(srv: boolean): void {
  patchMongo({ srv })
  if (srv) form.value = { ...form.value, ssl: { ...form.value.ssl, enabled: true } }
}
/** «Pegar URI»: lives only in this field; its password goes to the password field. */
const mongoUri = ref('')
function applyMongoUri(): void {
  try {
    const parsed = parseMongoUri(mongoUri.value)
    form.value = {
      ...form.value,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      ssl: {
        ...form.value.ssl,
        enabled: parsed.ssl.enabled,
        verifyServer: parsed.ssl.verifyServer,
        caCertPath: parsed.ssl.caCertPath ?? form.value.ssl.caCertPath,
        clientCertPath: parsed.ssl.clientCertPath ?? form.value.ssl.clientCertPath
      },
      network: parsed.connectTimeoutMs
        ? { ...network.value, connectTimeoutMs: parsed.connectTimeoutMs }
        : form.value.network
    }
    patchMongo(parsed.mongo)
    if (parsed.password !== null) {
      password.value = parsed.password
      clearPassword.value = false
    }
    mongoUri.value = ''
    errors.value = []
    testResult.value = null
    notify.success('URI aplicada: revisa los campos antes de guardar')
  } catch (err) {
    errors.value = [errorMessage(err)]
  }
}

const pgOptions = computed(() => form.value.postgres ?? defaultPostgresOptions())
function patchPostgres(patch: Partial<NonNullable<ConnectionInput['postgres']>>): void {
  form.value = { ...form.value, postgres: { ...pgOptions.value, ...patch } }
}
const sslMode = computed<SslMode>({
  get: () => form.value.ssl.mode ?? 'disable',
  set: (mode) => {
    form.value = { ...form.value, ssl: withSslMode(form.value.ssl, mode) }
  }
})
const network = computed(() => ({ ...DEFAULT_NETWORK, ...form.value.network }))
const connectTimeoutSec = computed({
  get: () => Math.round(network.value.connectTimeoutMs / 1000),
  set: (v: number) => {
    form.value = {
      ...form.value,
      network: { ...network.value, connectTimeoutMs: Math.max(1, Number(v) || 1) * 1000 }
    }
  }
})
const keepAliveSec = computed({
  get: () => network.value.keepAliveSec,
  set: (v: number) => {
    form.value = {
      ...form.value,
      network: { ...network.value, keepAliveSec: Math.max(0, Number(v) || 0) }
    }
  }
})

const AUTH_MODES: { value: MysqlAuthMode; title: string }[] = [
  { value: 'password', title: 'Contraseña' },
  { value: 'none', title: 'Sin contraseña' }
]

const editing = computed(() => ui.connectionDialog.editing)
const noPassword = computed(() => form.value.authMode === 'none')
const open = computed({
  get: () => ui.connectionDialog.open,
  set: (value: boolean) => {
    ui.connectionDialog = { ...ui.connectionDialog, open: value }
  }
})
const isCustomColor = computed(
  () => !!form.value.color && !COLOR_PRESETS.some((p) => p.value === form.value.color)
)
const environmentHint = computed(() =>
  form.value.environment === 'production'
    ? 'Producción: toda escritura (restauraciones, DDL, cambios de datos) pedirá confirmación explícita.'
    : settingsStore.needsTypedConfirm(form.value.environment)
      ? `${environmentLabel(form.value.environment)}: según Ajustes › Seguridad, toda escritura pedirá escribir el nombre de la conexión.`
      : 'Marca como «Producción» las conexiones donde un error sea grave: se pedirá confirmación antes de escribir.'
)

async function reset(): Promise<void> {
  tab.value = 'general'
  form.value = editing.value
    ? inputFromConnection(editing.value)
    : emptyConnectionInput(ui.connectionDialog.engine ?? 'mysql')
  sslKeyPassword.value = ''
  hasSslKeyPassword.value = false
  clearSslKeyPassword.value = false
  password.value = ''
  mongoUri.value = ''
  sshPassword.value = ''
  clearPassword.value = false
  clearSshPassword.value = false
  showPassword.value = false
  testResult.value = null
  errors.value = []
  hasPassword.value = false
  hasSshPassword.value = false
  if (editing.value && editing.value.engine !== 'sqlite') {
    const id = editing.value.id
    const [pw, sshPw] = await Promise.all([
      api.connections.hasPassword(id).catch(() => false),
      api.connections.hasSshPassword(id).catch(() => false)
    ])
    hasPassword.value = pw
    hasSshPassword.value = sshPw
    if (editing.value.engine === 'postgresql' || editing.value.engine === 'mongodb')
      hasSslKeyPassword.value = await api.connections.hasSslKeyPassword(id).catch(() => false)
  }
}

watch(
  () => ui.connectionDialog.open,
  (value) => {
    if (value) {
      void reset()
      refreshRecentLiteFiles()
    }
  },
  { immediate: true }
)

async function test(): Promise<void> {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await connections.test(
      normalizeConnectionInput(form.value),
      noPassword.value || isSqlite.value ? null : password.value || null,
      isSqlite.value ? null : sshPassword.value || null
    )
  } catch (err) {
    testResult.value = { ok: false, durationMs: 0, error: errorMessage(err) }
  } finally {
    testing.value = false
  }
}

async function save(): Promise<void> {
  const input = normalizeConnectionInput(form.value)
  errors.value = validateConnectionInput(input)
  if (errors.value.length) return
  saving.value = true
  const wasEditing = !!editing.value
  let saved: ConnectionConfig
  try {
    saved = await connections.save(input)
  } catch (err) {
    errors.value = [errorMessage(err)]
    saving.value = false
    return
  }
  // From here on the connection exists: switch the dialog to edit mode so a retry
  // updates it instead of creating a duplicate.
  form.value = { ...form.value, id: saved.id }
  ui.connectionDialog = { ...ui.connectionDialog, editing: saved }
  try {
    // 'none' never uses a password: drop a stored one instead of keeping an unused secret.
    if (input.authMode === 'none') {
      if (hasPassword.value) await api.connections.setPassword(saved.id, null)
    } else if (password.value && input.savePassword)
      await api.connections.setPassword(saved.id, password.value)
    else if (clearPassword.value || (!input.savePassword && hasPassword.value))
      await api.connections.setPassword(saved.id, null)
    if (
      input.ssh.enabled &&
      input.ssh.authType === 'password' &&
      sshPassword.value &&
      input.ssh.savePassword
    ) {
      await api.connections.setSshPassword(saved.id, sshPassword.value)
    } else if (clearSshPassword.value || (!input.ssh.savePassword && hasSshPassword.value)) {
      await api.connections.setSshPassword(saved.id, null)
    }
    if (input.engine === 'postgresql' || input.engine === 'mongodb') {
      if (sslKeyPassword.value && input.ssl.clientKeyPath)
        await api.connections.setSslKeyPassword(saved.id, sslKeyPassword.value)
      else if (clearSslKeyPassword.value || (hasSslKeyPassword.value && !input.ssl.clientKeyPath))
        await api.connections.setSslKeyPassword(saved.id, null)
    }
    password.value = ''
    sshPassword.value = ''
    sslKeyPassword.value = ''
    if (input.engine === 'sqlite' && input.sqlite?.filePath && !input.sqlite.pathNeedsReview)
      rememberSqliteFile(input.sqlite.filePath)
    notify.success(
      wasEditing ? `Conexión «${saved.name}» actualizada` : `Conexión «${saved.name}» creada`
    )
    open.value = false
  } catch (err) {
    errors.value = [
      `La conexión «${saved.name}» se guardó, pero no se pudo guardar la contraseña: ${errorMessage(err)}. Vuelve a pulsar Guardar para reintentarlo.`
    ]
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="720" scrollable>
    <v-card data-test="connection-dialog">
      <DialogHeader
        icon="mdi-lan"
        :title="editing ? `Editar conexión · ${editing.name}` : `Nueva conexión ${engineLabel}`"
        :subtitle="
          editing
            ? editing.engine === 'sqlite'
              ? (editing.sqlite?.filePath ?? '')
              : `${editing.host}:${editing.port}`
            : isPg
              ? 'PostgreSQL, con SSH y SSL opcionales'
              : isSqlite
                ? 'SQLite: un archivo de base de datos'
                : isMongo
                  ? 'MongoDB: independiente, conjunto de réplicas o SRV'
                  : isMariaDb
                    ? 'MariaDB, con SSH y SSL opcionales (también cuentas ed25519 y parsec)'
                    : 'MySQL / MariaDB, con SSH y SSL opcionales'
        "
        :danger="form.environment === 'production'"
      />
      <v-tabs v-model="tab" density="compact" color="primary">
        <v-tab value="general" prepend-icon="mdi-tune-variant">General</v-tab>
        <v-tab v-if="!isSqlite" value="ssh" prepend-icon="mdi-console-network-outline">SSH</v-tab>
        <v-tab v-if="!isSqlite" value="ssl" prepend-icon="mdi-shield-lock-outline">SSL</v-tab>
        <v-tab value="advanced" prepend-icon="mdi-cog-outline">Avanzado</v-tab>
      </v-tabs>
      <v-card-text class="connection-dialog__body">
        <div
          v-if="engineChoices.length > 1"
          class="connection-dialog__engines"
          role="radiogroup"
          aria-label="Motor de base de datos"
          data-test="conn-engine-picker"
        >
          <button
            v-for="e in engineChoices"
            :key="e.id"
            type="button"
            role="radio"
            class="connection-dialog__engine"
            :class="{ 'connection-dialog__engine--active': engine === e.id }"
            :aria-checked="engine === e.id"
            :data-test="`conn-engine-${e.id}`"
            @click="selectEngine(e.id)"
          >
            <v-icon :icon="e.icon" size="18" aria-hidden="true" />
            <span>{{ e.label }}</span>
          </button>
        </div>
        <div v-else-if="editing && (isPg || isSqlite || isMongo || isMariaDb)" class="mb-2">
          <v-chip size="small" :prepend-icon="ENGINES[engine].icon" data-test="conn-engine-chip">{{
            engineLabel
          }}</v-chip>
        </div>
        <v-window v-model="tab">
          <v-window-item value="general">
            <v-row dense>
              <v-col cols="12" sm="8">
                <v-text-field
                  v-model="form.name"
                  label="Nombre de la conexión"
                  autofocus
                  data-test="conn-name"
                />
              </v-col>
              <v-col cols="12" sm="4">
                <v-select
                  v-model="form.environment"
                  :items="ENVIRONMENTS"
                  label="Entorno"
                  data-test="conn-environment"
                />
              </v-col>
              <v-col cols="12">
                <div class="connection-dialog__color-row">
                  <span class="nd-section-title">Color</span>
                  <div class="swatches" role="radiogroup" aria-label="Color de la conexión">
                    <button
                      v-for="preset in COLOR_PRESETS"
                      :key="preset.label"
                      type="button"
                      role="radio"
                      class="color-swatch"
                      :class="{
                        'color-swatch--active': form.color === preset.value,
                        'color-swatch--none': !preset.value
                      }"
                      :style="preset.value ? { '--sw': preset.value } : undefined"
                      :aria-checked="form.color === preset.value"
                      :aria-label="preset.label"
                      :title="preset.label"
                      @click="form.color = preset.value"
                    >
                      <v-icon v-if="!preset.value" icon="mdi-cancel" size="14" />
                    </button>
                    <label
                      class="color-swatch color-swatch--custom"
                      :class="{ 'color-swatch--active': isCustomColor }"
                      :style="isCustomColor && form.color ? { '--sw': form.color } : undefined"
                      title="Color personalizado"
                    >
                      <input
                        type="color"
                        class="color-custom"
                        :value="form.color ?? '#888888'"
                        aria-label="Color personalizado"
                        @input="form.color = ($event.target as HTMLInputElement).value"
                      />
                      <v-icon icon="mdi-eyedropper-variant" size="13" aria-hidden="true" />
                    </label>
                  </div>
                </div>
                <div
                  class="connection-dialog__env-hint"
                  :class="{
                    'connection-dialog__env-hint--prod': form.environment === 'production'
                  }"
                >
                  <v-icon
                    :icon="
                      form.environment === 'production'
                        ? 'mdi-shield-alert-outline'
                        : 'mdi-information-outline'
                    "
                    size="15"
                    aria-hidden="true"
                  />
                  <span>{{ environmentHint }}</span>
                </div>
              </v-col>
              <template v-if="isSqlite">
                <v-col cols="12">
                  <div class="nd-section-title mb-3">Archivo de la base de datos</div>
                  <v-text-field
                    v-path-tail="liteOptions.filePath"
                    :model-value="liteOptions.filePath"
                    :title="liteOptions.filePath || undefined"
                    label="Archivo"
                    placeholder="Elige un archivo existente o crea uno nuevo"
                    persistent-placeholder
                    readonly
                    prepend-inner-icon="mdi-file-outline"
                    class="nd-mono-input nd-path-field"
                    :hint="liteFileName ? `Archivo: ${liteFileName}` : ''"
                    persistent-hint
                    data-test="sqlite-path"
                  />
                  <div class="d-flex flex-wrap ga-2 mt-2">
                    <v-btn
                      size="small"
                      prepend-icon="mdi-folder-open-outline"
                      data-test="sqlite-open-file"
                      @click="pickLiteFile"
                      >Abrir archivo…</v-btn
                    >
                    <v-btn
                      size="small"
                      prepend-icon="mdi-file-plus-outline"
                      :loading="liteBusy"
                      data-test="sqlite-create-file"
                      @click="createLiteFile"
                      >Crear base de datos nueva…</v-btn
                    >
                    <v-menu v-if="!editing && recentLiteItems.length" location="bottom start">
                      <template #activator="{ props: menuProps }">
                        <v-btn
                          v-bind="menuProps"
                          size="small"
                          prepend-icon="mdi-history"
                          append-icon="mdi-menu-down"
                          data-test="sqlite-recent"
                          >Recientes</v-btn
                        >
                      </template>
                      <v-list density="compact" max-width="460">
                        <v-list-item
                          v-for="item in recentLiteItems"
                          :key="item.path"
                          :title="item.name"
                          :subtitle="item.shown"
                          prepend-icon="mdi-database-outline"
                          :data-test="`sqlite-recent-${item.name}`"
                          @click="useLiteFile(item.path)"
                        />
                      </v-list>
                    </v-menu>
                  </div>
                  <v-alert
                    v-if="litePathNeedsReview"
                    type="warning"
                    variant="tonal"
                    density="compact"
                    class="mt-2"
                    data-test="sqlite-path-review"
                  >
                    La ruta viene de otro equipo o no existe aquí: elige el archivo con «Abrir
                    archivo…».
                  </v-alert>
                </v-col>
                <v-col cols="12" sm="6">
                  <v-switch
                    :model-value="liteOptions.readOnly"
                    label="Solo lectura"
                    color="primary"
                    density="compact"
                    :hint="
                      form.environment === 'production'
                        ? 'Las conexiones de producción se abren en solo lectura; usa «Reabrir en modo escritura» en el menú de la conexión para escribir.'
                        : 'Abre el archivo sin poder modificarlo.'
                    "
                    persistent-hint
                    data-test="sqlite-readonly"
                    @update:model-value="patchSqlite({ readOnly: $event === true })"
                  />
                </v-col>
                <v-col cols="12" sm="6">
                  <v-switch
                    :model-value="liteOptions.foreignKeys"
                    label="Aplicar claves foráneas"
                    color="primary"
                    density="compact"
                    hint="PRAGMA foreign_keys. Desactivado por defecto en archivos abiertos o importados."
                    persistent-hint
                    data-test="sqlite-foreign-keys"
                    @update:model-value="patchSqlite({ foreignKeys: $event === true })"
                  />
                </v-col>
                <v-col cols="12">
                  <div class="d-flex align-center mb-1">
                    <span class="nd-section-title">Bases de datos adjuntas</span>
                    <v-spacer />
                    <v-btn
                      size="small"
                      variant="text"
                      prepend-icon="mdi-plus"
                      data-test="sqlite-attach-add"
                      @click="addAttached"
                      >Añadir</v-btn
                    >
                  </div>
                  <div
                    v-if="!liteOptions.attached.length"
                    class="text-caption text-medium-emphasis"
                  >
                    Opcional: otros archivos que se adjuntan con ATTACH al abrir (nunca se crean).
                  </div>
                  <div
                    v-for="(db, i) in liteOptions.attached"
                    :key="i"
                    class="d-flex align-center ga-2 mb-1"
                    :data-test="`sqlite-attach-row-${i}`"
                  >
                    <v-text-field
                      :model-value="db.alias"
                      label="Alias"
                      density="compact"
                      hide-details
                      class="nd-mono-input connection-dialog__alias"
                      :data-test="`sqlite-attach-alias-${i}`"
                      @update:model-value="patchAttached(i, { alias: $event })"
                    />
                    <v-text-field
                      v-path-tail="db.filePath"
                      :model-value="db.filePath"
                      :title="db.filePath || undefined"
                      label="Archivo"
                      density="compact"
                      hide-details
                      readonly
                      class="nd-mono-input nd-path-field"
                      :data-test="`sqlite-attach-path-${i}`"
                    />
                    <v-btn
                      size="small"
                      variant="text"
                      icon="mdi-folder-open-outline"
                      :aria-label="`Elegir archivo de ${db.alias || 'la base adjunta'}`"
                      title="Elegir archivo…"
                      :data-test="`sqlite-attach-pick-${i}`"
                      @click="pickAttachedFile(i)"
                    />
                    <v-btn
                      size="small"
                      variant="text"
                      icon="mdi-close"
                      :aria-label="`Quitar ${db.alias || 'la base adjunta'}`"
                      :data-test="`sqlite-attach-remove-${i}`"
                      @click="removeAttached(i)"
                    />
                  </div>
                </v-col>
              </template>
              <template v-if="isMongo">
                <v-col cols="12">
                  <div class="d-flex align-start ga-2">
                    <v-text-field
                      v-model="mongoUri"
                      label="Pegar URI (opcional)"
                      placeholder="mongodb://usuario@host:27017/bd?replicaSet=rs0"
                      persistent-placeholder
                      prepend-inner-icon="mdi-link-variant"
                      class="nd-mono-input"
                      type="password"
                      autocomplete="off"
                      hint="Rellena los campos; la contraseña va a su campo y la URI no se guarda."
                      persistent-hint
                      data-test="conn-mongo-uri"
                      @keydown.enter.prevent="applyMongoUri"
                    />
                    <v-btn
                      size="small"
                      class="mt-2"
                      :disabled="!mongoUri.trim()"
                      data-test="conn-mongo-uri-apply"
                      @click="applyMongoUri"
                      >Rellenar</v-btn
                    >
                  </div>
                </v-col>
                <v-col cols="12" sm="8">
                  <v-select
                    :model-value="mongoOptions.topology"
                    :items="MONGO_TOPOLOGIES"
                    label="Método de conexión"
                    prepend-inner-icon="mdi-graph-outline"
                    data-test="conn-mongo-topology"
                    @update:model-value="patchMongo({ topology: $event })"
                  />
                </v-col>
                <v-col cols="12" sm="4">
                  <v-switch
                    :model-value="mongoOptions.srv"
                    label="Registro SRV"
                    color="primary"
                    density="compact"
                    hint="mongodb+srv (activa TLS)"
                    persistent-hint
                    data-test="conn-mongo-srv"
                    @update:model-value="setMongoSrv($event === true)"
                  />
                </v-col>
              </template>
              <template v-if="!isSqlite">
                <v-col v-if="mongoUsesMembers" cols="12" sm="8">
                  <v-combobox
                    v-model="mongoMembers"
                    label="Miembros (host:puerto)"
                    hint="Pulsa Enter para añadir cada miembro de la lista de semillas."
                    persistent-hint
                    multiple
                    chips
                    closable-chips
                    class="nd-mono-input"
                    data-test="conn-mongo-members"
                  />
                </v-col>
                <v-col v-if="mongoUsesMembers" cols="12" sm="4">
                  <v-text-field
                    :model-value="mongoOptions.replicaSet"
                    label="Nombre del conjunto"
                    class="nd-mono-input"
                    :disabled="mongoOptions.topology !== 'replicaSet'"
                    data-test="conn-mongo-replicaset"
                    @update:model-value="patchMongo({ replicaSet: $event })"
                  />
                </v-col>
                <v-col
                  v-if="!mongoUsesMembers"
                  cols="12"
                  :sm="isMongo && mongoOptions.srv ? 12 : 8"
                >
                  <v-text-field
                    v-model="form.host"
                    :label="isMongo && mongoOptions.srv ? 'Nombre SRV del clúster' : 'Host'"
                    prepend-inner-icon="mdi-server-network"
                    class="nd-mono-input"
                    data-test="conn-host"
                  />
                </v-col>
                <v-col v-if="!mongoUsesMembers && !(isMongo && mongoOptions.srv)" cols="12" sm="4">
                  <v-text-field
                    v-model.number="form.port"
                    label="Puerto"
                    type="number"
                    min="1"
                    max="65535"
                    class="nd-mono-input"
                    data-test="conn-port"
                  />
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="form.username"
                    label="Usuario"
                    prepend-inner-icon="mdi-account-outline"
                    autocomplete="off"
                    data-test="conn-user"
                  />
                </v-col>
                <v-col v-if="isMongo" cols="12" sm="6">
                  <v-select
                    :model-value="mongoOptions.authMechanism"
                    :items="MONGO_MECHANISMS"
                    label="Autenticación"
                    prepend-inner-icon="mdi-shield-key-outline"
                    data-test="conn-mongo-mechanism"
                    @update:model-value="patchMongo({ authMechanism: $event })"
                  />
                </v-col>
                <v-col v-else cols="12" sm="6">
                  <v-select
                    v-model="form.authMode"
                    :items="AUTH_MODES"
                    label="Autenticación"
                    prepend-inner-icon="mdi-shield-key-outline"
                    data-test="conn-auth-mode"
                  />
                </v-col>
                <v-col v-if="noPassword && !isMongo" cols="12">
                  <v-alert
                    type="info"
                    variant="tonal"
                    density="compact"
                    icon="mdi-certificate-outline"
                    data-test="conn-no-password-hint"
                  >
                    Útil con Cloud SQL Auth Proxy, túneles o certificados de cliente (pestaña SSL).
                    <template v-if="hasPassword">
                      La contraseña guardada de esta conexión se borrará al guardar.</template
                    >
                  </v-alert>
                </v-col>
                <v-col v-if="!noPassword" cols="12" sm="6">
                  <v-text-field
                    v-model="password"
                    label="Contraseña"
                    persistent-placeholder
                    prepend-inner-icon="mdi-lock-outline"
                    :type="showPassword ? 'text' : 'password'"
                    autocomplete="new-password"
                    :placeholder="hasPassword && !clearPassword ? '•••••• (guardada)' : ''"
                    :append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
                    :hint="isMariaDb ? 'También cuentas ed25519 y parsec' : ''"
                    :persistent-hint="isMariaDb"
                    data-test="conn-password"
                    @click:append-inner="showPassword = !showPassword"
                  />
                </v-col>
                <v-col v-if="!noPassword" cols="12" class="d-flex align-center flex-wrap ga-2">
                  <v-checkbox
                    v-model="form.savePassword"
                    label="Guardar contraseña"
                    density="compact"
                    hide-details
                  />
                  <template v-if="hasPassword">
                    <v-chip
                      v-if="!clearPassword"
                      size="small"
                      color="success"
                      prepend-icon="mdi-key"
                      data-test="conn-password-saved"
                      >contraseña guardada</v-chip
                    >
                    <v-chip v-else size="small" color="warning" prepend-icon="mdi-key-remove"
                      >se borrará al guardar</v-chip
                    >
                    <v-btn
                      size="small"
                      variant="text"
                      :prepend-icon="clearPassword ? 'mdi-undo-variant' : 'mdi-key-remove'"
                      class="connection-dialog__clear-password"
                      :class="{ 'connection-dialog__clear-password--danger': !clearPassword }"
                      @click="clearPassword = !clearPassword"
                    >
                      {{ clearPassword ? 'Mantener contraseña' : 'Borrar contraseña guardada' }}
                    </v-btn>
                  </template>
                </v-col>
              </template>
              <template v-if="isMongo">
                <v-col cols="12" sm="4">
                  <v-text-field
                    :model-value="mongoOptions.authSource"
                    label="Base de autenticación"
                    class="nd-mono-input"
                    :disabled="noPassword"
                    hint="authSource (por defecto admin)"
                    persistent-hint
                    data-test="conn-mongo-authsource"
                    @update:model-value="patchMongo({ authSource: $event })"
                  />
                </v-col>
                <v-col cols="12" sm="4">
                  <v-text-field
                    :model-value="mongoOptions.defaultDatabase"
                    label="Base de datos predeterminada"
                    prepend-inner-icon="mdi-database-outline"
                    class="nd-mono-input"
                    hint="La de las consultas nuevas"
                    persistent-hint
                    data-test="conn-mongo-database"
                    @update:model-value="patchMongo({ defaultDatabase: $event })"
                  />
                </v-col>
                <v-col cols="12" sm="4">
                  <v-select
                    :model-value="mongoOptions.readPreference"
                    :items="MONGO_READ_PREFERENCES"
                    label="Preferencia de lectura"
                    data-test="conn-mongo-readpref"
                    @update:model-value="patchMongo({ readPreference: $event })"
                  />
                </v-col>
                <v-col cols="12">
                  <v-checkbox
                    :model-value="mongoOptions.directConnection"
                    label="Conexión directa a este miembro (directConnection)"
                    density="compact"
                    hide-details
                    data-test="conn-mongo-direct"
                    @update:model-value="patchMongo({ directConnection: $event === true })"
                  />
                </v-col>
              </template>
              <template v-if="isPg">
                <v-col cols="12" sm="6">
                  <v-text-field
                    :model-value="pgOptions.initialDatabase"
                    label="Base de datos inicial"
                    prepend-inner-icon="mdi-database-outline"
                    class="nd-mono-input"
                    hint="Se abre al conectar (por defecto postgres)"
                    persistent-hint
                    data-test="conn-pg-database"
                    @update:model-value="patchPostgres({ initialDatabase: $event })"
                  />
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    :model-value="pgOptions.searchPath"
                    label="search_path"
                    class="nd-mono-input"
                    hint="Vacío = el del servidor; p. ej. app, public"
                    persistent-hint
                    data-test="conn-pg-search-path"
                    @update:model-value="patchPostgres({ searchPath: $event })"
                  />
                </v-col>
                <v-col cols="12">
                  <v-combobox
                    v-model="form.customDatabases"
                    label="Mostrar solo estas bases de datos"
                    hint="Si no está vacía, solo se muestran estas bases de datos. Pulsa Enter para añadir."
                    persistent-hint
                    multiple
                    chips
                    closable-chips
                    data-test="conn-pg-custom-databases"
                  />
                </v-col>
                <v-col cols="12">
                  <v-checkbox
                    :model-value="pgOptions.showSystemSchemas"
                    label="Mostrar esquemas y bases de datos del sistema"
                    density="compact"
                    hide-details
                    data-test="conn-pg-system"
                    @update:model-value="patchPostgres({ showSystemSchemas: $event === true })"
                  />
                </v-col>
              </template>
            </v-row>
          </v-window-item>

          <v-window-item value="ssh">
            <v-switch
              v-model="form.ssh.enabled"
              label="Usar túnel SSH"
              color="primary"
              density="compact"
              hide-details
            />
            <v-row dense class="mt-1">
              <v-col cols="12" sm="8"
                ><v-text-field
                  v-model="form.ssh.host"
                  label="Host SSH"
                  class="nd-mono-input"
                  :disabled="!form.ssh.enabled"
              /></v-col>
              <v-col cols="12" sm="4"
                ><v-text-field
                  v-model.number="form.ssh.port"
                  label="Puerto"
                  class="nd-mono-input"
                  type="number"
                  :disabled="!form.ssh.enabled"
              /></v-col>
              <v-col cols="12" sm="6"
                ><v-text-field
                  v-model="form.ssh.username"
                  label="Usuario SSH"
                  :disabled="!form.ssh.enabled"
              /></v-col>
              <v-col cols="12" sm="6">
                <v-select
                  v-model="form.ssh.authType"
                  :items="[
                    { title: 'Contraseña', value: 'password' },
                    { title: 'Clave pública', value: 'key' }
                  ]"
                  label="Autenticación"
                  :disabled="!form.ssh.enabled"
                />
              </v-col>
              <v-col v-if="form.ssh.authType === 'key'" cols="12">
                <PathPicker
                  v-model="form.ssh.privateKeyPath"
                  v-path-tail="form.ssh.privateKeyPath"
                  :title="form.ssh.privateKeyPath || undefined"
                  class="nd-path-field"
                  kind="file"
                  label="Archivo de clave privada"
                  :disabled="!form.ssh.enabled"
                />
              </v-col>
              <v-col v-else cols="12" sm="6">
                <v-text-field
                  v-model="sshPassword"
                  label="Contraseña SSH"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="hasSshPassword && !clearSshPassword ? '•••••• (guardada)' : ''"
                  :disabled="!form.ssh.enabled"
                />
              </v-col>
              <v-col cols="12" class="d-flex align-center flex-wrap ga-2">
                <v-checkbox
                  v-model="form.ssh.savePassword"
                  label="Guardar contraseña SSH"
                  density="compact"
                  hide-details
                  :disabled="!form.ssh.enabled"
                />
                <template v-if="hasSshPassword">
                  <v-chip
                    size="small"
                    :color="clearSshPassword ? 'warning' : 'success'"
                    prepend-icon="mdi-key"
                  >
                    {{ clearSshPassword ? 'se borrará al guardar' : 'contraseña SSH guardada' }}
                  </v-chip>
                  <v-btn size="small" variant="text" @click="clearSshPassword = !clearSshPassword">
                    {{ clearSshPassword ? 'Mantener' : 'Borrar' }}
                  </v-btn>
                </template>
              </v-col>
            </v-row>
          </v-window-item>

          <v-window-item value="ssl">
            <template v-if="isPg">
              <v-select
                v-model="sslMode"
                :items="PG_SSL_MODES"
                label="Modo SSL"
                prepend-inner-icon="mdi-shield-lock-outline"
                hint="Con túnel SSH, verify-full comprueba el nombre del servidor real (no 127.0.0.1)."
                persistent-hint
                data-test="conn-pg-ssl-mode"
              />
              <div class="d-flex flex-column ga-3 mt-3">
                <PathPicker
                  v-model="form.ssl.caCertPath"
                  v-path-tail="form.ssl.caCertPath"
                  :title="form.ssl.caCertPath || undefined"
                  class="nd-path-field"
                  kind="file"
                  label="Certificado CA"
                  :disabled="sslMode === 'disable'"
                />
                <PathPicker
                  v-model="form.ssl.clientCertPath"
                  v-path-tail="form.ssl.clientCertPath"
                  :title="form.ssl.clientCertPath || undefined"
                  class="nd-path-field"
                  kind="file"
                  label="Certificado de cliente"
                  :disabled="sslMode === 'disable'"
                />
                <PathPicker
                  v-model="form.ssl.clientKeyPath"
                  v-path-tail="form.ssl.clientKeyPath"
                  :title="form.ssl.clientKeyPath || undefined"
                  class="nd-path-field"
                  kind="file"
                  label="Clave de cliente"
                  :disabled="sslMode === 'disable'"
                />
                <div class="d-flex align-center flex-wrap ga-2">
                  <v-text-field
                    v-model="sslKeyPassword"
                    label="Contraseña de la clave"
                    type="password"
                    autocomplete="new-password"
                    :placeholder="
                      hasSslKeyPassword && !clearSslKeyPassword ? '•••••• (guardada)' : ''
                    "
                    persistent-placeholder
                    :disabled="sslMode === 'disable' || !form.ssl.clientKeyPath"
                    data-test="conn-pg-ssl-key-password"
                  />
                  <template v-if="hasSslKeyPassword">
                    <v-btn
                      size="small"
                      variant="text"
                      @click="clearSslKeyPassword = !clearSslKeyPassword"
                    >
                      {{ clearSslKeyPassword ? 'Mantener' : 'Borrar' }}
                    </v-btn>
                  </template>
                </div>
              </div>
            </template>
            <template v-else>
              <v-switch
                v-model="form.ssl.enabled"
                label="Usar SSL"
                color="primary"
                density="compact"
                hide-details
              />
              <div class="d-flex flex-column ga-3 mt-2">
                <PathPicker
                  v-model="form.ssl.caCertPath"
                  v-path-tail="form.ssl.caCertPath"
                  :title="form.ssl.caCertPath || undefined"
                  class="nd-path-field"
                  kind="file"
                  label="Certificado CA"
                  :disabled="!form.ssl.enabled"
                />
                <PathPicker
                  v-model="form.ssl.clientCertPath"
                  v-path-tail="form.ssl.clientCertPath"
                  :title="form.ssl.clientCertPath || undefined"
                  class="nd-path-field"
                  kind="file"
                  label="Certificado de cliente"
                  :disabled="!form.ssl.enabled"
                />
                <PathPicker
                  v-model="form.ssl.clientKeyPath"
                  v-path-tail="form.ssl.clientKeyPath"
                  :title="form.ssl.clientKeyPath || undefined"
                  class="nd-path-field"
                  kind="file"
                  label="Clave de cliente"
                  :disabled="!form.ssl.enabled"
                />
                <v-text-field
                  v-if="isMongo"
                  v-model="sslKeyPassword"
                  label="Contraseña de la clave"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="
                    hasSslKeyPassword && !clearSslKeyPassword ? '•••••• (guardada)' : ''
                  "
                  persistent-placeholder
                  :disabled="!form.ssl.enabled || !form.ssl.clientCertPath"
                  data-test="conn-mongo-ssl-key-password"
                />
                <v-checkbox
                  v-model="form.ssl.verifyServer"
                  :label="
                    isMongo
                      ? 'Verificar certificado y nombre del servidor'
                      : 'Verificar certificado del servidor'
                  "
                  density="compact"
                  hide-details
                  :disabled="!form.ssl.enabled"
                />
                <div v-if="isMongo" class="text-caption text-medium-emphasis">
                  Con registro SRV, TLS siempre está activo. Con túnel SSH se verifica el nombre del
                  servidor real, no 127.0.0.1.
                </div>
              </div>
            </template>
          </v-window-item>

          <v-window-item value="advanced">
            <v-combobox
              v-if="!isPg && !isSqlite"
              v-model="form.customDatabases"
              label="Lista de bases de datos personalizada"
              hint="Si no está vacía, solo se muestran estos esquemas. Pulsa Enter para añadir."
              persistent-hint
              multiple
              chips
              closable-chips
              class="mb-3"
            />
            <v-textarea
              v-if="!isMongo"
              v-model="form.initialQueries"
              label="Consultas iniciales de sesión"
              :hint="
                isSqlite
                  ? 'Se ejecutan al abrir el archivo, p. ej. PRAGMA cache_size = -20000;'
                  : 'Se ejecutan al abrir cada sesión, p. ej. SET time_zone = \'+00:00\';'
              "
              persistent-hint
              rows="3"
              variant="outlined"
              density="compact"
              class="mb-3"
            />
            <v-row v-if="isMongo" dense class="mb-1">
              <v-col cols="6" sm="3">
                <v-text-field
                  v-model.number="connectTimeoutSec"
                  label="Tiempo de conexión (s)"
                  type="number"
                  min="1"
                  data-test="conn-mongo-timeout"
                />
              </v-col>
              <v-col cols="6" sm="3">
                <v-text-field
                  v-model.number="keepAliveSec"
                  label="Keepalive SSH (s)"
                  type="number"
                  min="0"
                  hint="0 = desactivado"
                  persistent-hint
                />
              </v-col>
              <v-col cols="6" sm="3">
                <v-switch
                  :model-value="mongoOptions.retryWrites"
                  label="Reintentar escrituras"
                  color="primary"
                  density="compact"
                  hide-details
                  data-test="conn-mongo-retry-writes"
                  @update:model-value="patchMongo({ retryWrites: $event === true })"
                />
              </v-col>
              <v-col cols="6" sm="3">
                <v-switch
                  :model-value="mongoOptions.retryReads"
                  label="Reintentar lecturas"
                  color="primary"
                  density="compact"
                  hide-details
                  @update:model-value="patchMongo({ retryReads: $event === true })"
                />
              </v-col>
              <v-col cols="12">
                <v-textarea
                  v-model="mongoExtraText"
                  label="Opciones extra (una por línea: clave=valor)"
                  hint="Opciones de URI sin credenciales, p. ej. maxIdleTimeMS=60000 o w=majority."
                  persistent-hint
                  rows="2"
                  variant="outlined"
                  density="compact"
                  class="nd-mono-input"
                  data-test="conn-mongo-extra"
                />
              </v-col>
            </v-row>
            <v-row v-if="isSqlite" dense class="mb-1">
              <v-col cols="12" sm="6">
                <v-text-field
                  :model-value="liteOptions.busyTimeoutMs"
                  label="Espera si el archivo está bloqueado (ms)"
                  type="number"
                  min="0"
                  hint="busy_timeout: útil si otra aplicación tiene el archivo abierto"
                  persistent-hint
                  data-test="sqlite-busy-timeout"
                  @update:model-value="patchSqlite({ busyTimeoutMs: Number($event) || 0 })"
                />
              </v-col>
            </v-row>
            <v-row v-if="isPg" dense class="mb-1">
              <v-col cols="12" sm="6">
                <v-text-field
                  :model-value="pgOptions.timeZone"
                  label="Zona horaria de sesión"
                  hint="Vacío = la del servidor; p. ej. UTC o Europe/Madrid"
                  persistent-hint
                  class="nd-mono-input"
                  data-test="conn-pg-timezone"
                  @update:model-value="patchPostgres({ timeZone: $event })"
                />
              </v-col>
              <v-col cols="6" sm="3">
                <v-text-field
                  v-model.number="connectTimeoutSec"
                  label="Tiempo de conexión (s)"
                  type="number"
                  min="1"
                  data-test="conn-pg-timeout"
                />
              </v-col>
              <v-col cols="6" sm="3">
                <v-text-field
                  v-model.number="keepAliveSec"
                  label="Intervalo keepalive (s)"
                  type="number"
                  min="0"
                  hint="0 = desactivado"
                  persistent-hint
                  data-test="conn-pg-keepalive"
                />
              </v-col>
            </v-row>
            <PathPicker
              v-if="showBackupDirs"
              v-model="form.backupDir"
              kind="directory"
              label="Carpeta de copias de seguridad"
              hint="Vacío = carpeta por defecto de Ajustes"
            />
            <div v-if="showBackupDirs && form.extraBackupDirs.length" class="mt-3">
              <div class="text-caption text-medium-emphasis">
                Carpetas adicionales (solo lectura, p. ej. Navicat)
              </div>
              <v-list density="compact" class="py-0">
                <v-list-item
                  v-for="dir in form.extraBackupDirs"
                  :key="dir"
                  prepend-icon="mdi-folder-lock-outline"
                  :title="dir"
                >
                  <template #append>
                    <v-btn
                      icon="mdi-folder-open-outline"
                      size="x-small"
                      :aria-label="`Abrir ${dir}`"
                      @click="api.app.openPath(dir)"
                    />
                  </template>
                </v-list-item>
              </v-list>
            </div>
          </v-window-item>
        </v-window>

        <v-alert
          v-if="testResult?.ok && testResult.connectedWithoutPassword && !noPassword"
          type="info"
          variant="tonal"
          density="compact"
          class="mt-3"
          data-test="conn-suggest-no-password"
        >
          El servidor aceptó la conexión sin contraseña. Si no la necesita, marca «Sin contraseña»
          para no tener que guardarla.
          <template #append>
            <v-btn
              size="small"
              variant="text"
              data-test="conn-use-no-password"
              @click="form.authMode = 'none'"
              >Usar «Sin contraseña»</v-btn
            >
          </template>
        </v-alert>
        <v-alert
          v-if="errors.length"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-3"
          data-test="conn-errors"
        >
          <div v-for="e in errors" :key="e">{{ e }}</div>
        </v-alert>
      </v-card-text>
      <v-card-actions>
        <v-btn prepend-icon="mdi-connection" :loading="testing" data-test="conn-test" @click="test"
          >Probar conexión</v-btn
        >
        <span
          v-if="testResult"
          class="nd-pill connection-dialog__result"
          :class="testResult.ok ? 'nd-pill--local' : 'nd-pill--production'"
          :title="testResult.error ?? ''"
          role="status"
          data-test="conn-test-result"
        >
          <span class="connection-dialog__result-dot" aria-hidden="true" />
          <span class="nd-ellipsis">
            <template v-if="testResult.ok && (isPg || isSqlite || isMongo)"
              >Conectado · {{ testResult.serverVersion }} ({{ testResult.durationMs }} ms)<template
                v-if="testResult.details?.length"
              >
                · {{ testResult.details.join(' · ') }}</template
              ></template
            >
            <template v-else-if="testResult.ok"
              >Conectado · MySQL {{ testResult.serverVersion }} ({{
                testResult.durationMs
              }}
              ms)</template
            >
            <template v-else>{{ testResult.error ?? 'Error de conexión' }}</template>
          </span>
        </span>
        <v-spacer />
        <v-btn @click="open = false">Cancelar</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" data-test="conn-save" @click="save"
          >Guardar</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.connection-dialog__engines {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.connection-dialog__engine {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: var(--nd-radius-sm);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-sunken);
  color: var(--nd-text);
  cursor: pointer;
}
.connection-dialog__engine--active {
  border-color: rgba(var(--nd-accent-rgb), 0.6);
  box-shadow: var(--nd-glow);
}
.connection-dialog__body {
  min-height: 300px;
  padding-top: 8px !important;
}
.connection-dialog__body .nd-mono-input :deep(input) {
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
}
.connection-dialog__color-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.swatches {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.color-swatch {
  position: relative;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--nd-border-strong);
  background: var(--sw, transparent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--sw, transparent) 45%, transparent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--nd-text-muted);
  cursor: pointer;
  transition:
    transform var(--nd-dur-fast) var(--nd-ease),
    box-shadow var(--nd-dur) var(--nd-ease);
}
.color-swatch:hover {
  transform: scale(1.12);
}
.color-swatch--none {
  border-color: var(--nd-border-strong);
  background: var(--nd-bg-input);
  box-shadow: none;
}
.color-swatch--active {
  box-shadow:
    0 0 0 2px var(--nd-bg-raised),
    0 0 0 3.5px var(--sw, var(--nd-accent)),
    0 0 16px color-mix(in srgb, var(--sw, var(--nd-accent)) 65%, transparent);
}
.color-swatch:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px var(--nd-bg-raised),
    var(--nd-glow);
}
.color-swatch--custom {
  overflow: hidden;
  background: var(--sw, conic-gradient(#f87171, #fbbf24, #34d399, #22d3ee, #8b5cf6, #f87171));
  border-color: var(--nd-border-strong);
  color: #fff;
}
.color-swatch--custom:focus-within {
  box-shadow:
    0 0 0 2px var(--nd-bg-raised),
    var(--nd-glow);
}
.color-custom {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}
.connection-dialog__env-hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: var(--nd-radius-control);
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
  background: var(--nd-hover);
  border: 1px solid var(--nd-hairline);
}
.connection-dialog__env-hint .v-icon {
  margin-top: 1px;
  flex: none;
}
.connection-dialog__env-hint--prod {
  color: var(--nd-error);
  background: var(--nd-error-soft);
  border-color: color-mix(in srgb, var(--nd-error) 35%, transparent);
  box-shadow: 0 0 16px color-mix(in srgb, var(--nd-error) 14%, transparent);
}
.connection-dialog__alias {
  flex: 0 0 120px;
}
.connection-dialog__clear-password {
  color: var(--nd-text-2);
}
.connection-dialog__clear-password--danger:hover,
.connection-dialog__clear-password--danger:focus-visible {
  color: var(--nd-error) !important;
  background: var(--nd-error-soft);
}
.connection-dialog__result {
  max-width: 320px;
  height: 22px;
  min-width: 0;
}
.connection-dialog__result-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}
</style>
