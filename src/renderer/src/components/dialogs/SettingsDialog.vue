<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useTheme } from 'vuetify'
import {
  ALL_ENVIRONMENTS,
  MANDATORY_TYPED_ENVIRONMENTS,
  normalizeTypedConfirmEnvironments
} from '@shared/typedConfirm'
import { mcpConfigError } from '@shared/mcp'
import type { AppSettings, ConnectionMcpConfig, Environment } from '@shared/types'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import { useUpdatesStore } from '@renderer/stores/updates'
import { useTourStore } from '@renderer/stores/tour'
import PathPicker from '@renderer/components/common/PathPicker.vue'
import { environmentLabel, environmentPillClass } from '@renderer/components/backups/backupHelpers'
import './pathField.css'
import { vPathTail } from './pathTail'
import DialogHeader from './DialogHeader.vue'
import AiSettingsSection from '@renderer/components/ai/AiSettingsSection.vue'
import McpSettingsSection from '@renderer/components/mcp/McpSettingsSection.vue'

const ui = useUiStore()
const settingsStore = useSettingsStore()
const connections = useConnectionsStore()
const theme = useTheme()
const notify = useNotify()
const updates = useUpdatesStore()
const tour = useTourStore()

const form = ref<AppSettings>({ ...settingsStore.settings })
/** Ajustes › Agentes (MCP): per-connection changes not saved yet, by connection id. */
const mcpDrafts = ref<Record<string, ConnectionMcpConfig>>({})

const saving = ref(false)

/** Closes Ajustes (unsaved changes are dropped, as with Cancelar) and replays the welcome tour. */
function replayTour(): void {
  ui.settingsDialog = false
  void tour.startWelcome()
}
const error = ref('')

const open = computed({
  get: () => ui.settingsDialog,
  set: (value: boolean) => {
    ui.settingsDialog = value
  }
})

watch(
  () => ui.settingsDialog,
  (value) => {
    if (!value) return
    form.value = { ...settingsStore.settings }
    mcpDrafts.value = {}
    error.value = ''
    void updates.loadAppVersion()
  },
  { immediate: true }
)

const PRODUCTION_LOCKED_TOOLTIP = 'Producción siempre pide escribir el nombre'

const isMandatory = (env: Environment): boolean => MANDATORY_TYPED_ENVIRONMENTS.includes(env)
const typedEnvironments = computed(() =>
  normalizeTypedConfirmEnvironments(form.value.typedConfirmEnvironments)
)
const isTyped = (env: Environment): boolean => typedEnvironments.value.includes(env)

function toggleTyped(env: Environment, on: boolean): void {
  if (isMandatory(env)) return
  const current = typedEnvironments.value.filter((e) => e !== env)
  form.value.typedConfirmEnvironments = normalizeTypedConfirmEnvironments(
    on ? [...current, env] : current
  )
}

async function save(): Promise<void> {
  const limit = Math.trunc(Number(form.value.defaultRowLimit))
  if (!Number.isFinite(limit) || limit < 1) {
    error.value = 'El límite de filas debe ser un número mayor que 0.'
    return
  }
  const aiMaxTokens = Math.trunc(Number(form.value.aiMaxTokens))
  if (!Number.isFinite(aiMaxTokens) || aiMaxTokens < 256 || aiMaxTokens > 128000) {
    error.value = 'El máximo de tokens de la IA debe estar entre 256 y 128000.'
    return
  }
  for (const [id, mcp] of Object.entries(mcpDrafts.value)) {
    const connection = connections.get(id)
    const problem = connection
      ? mcpConfigError({ environment: connection.environment, mcp }, typedEnvironments.value)
      : null
    if (problem) {
      error.value = `«${connection?.name}»: ${problem}`
      return
    }
  }
  saving.value = true
  error.value = ''
  try {
    await settingsStore.update({
      ...form.value,
      aiMaxTokens,
      defaultRowLimit: limit,
      typedConfirmEnvironments: typedEnvironments.value
    })
    theme.change(settingsStore.themeName)
    // Saved one by one: a failure keeps Ajustes open with the rest still staged.
    for (const [id, mcp] of Object.entries(mcpDrafts.value)) {
      if (connections.get(id)) await connections.setMcp(id, mcp)
      const rest = { ...mcpDrafts.value }
      delete rest[id]
      mcpDrafts.value = rest
    }
    notify.success('Ajustes guardados')
    open.value = false
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="620" scrollable>
    <v-card data-test="settings-dialog">
      <DialogHeader icon="mdi-cog-outline" title="Ajustes" subtitle="Preferencias de Vortaq" />
      <v-card-text class="settings-dialog__body">
        <section class="settings-section" aria-label="Carpetas">
          <div class="settings-section__title">
            <v-icon icon="mdi-folder-outline" size="15" aria-hidden="true" />Carpetas
          </div>
          <div class="settings-section__fields">
            <PathPicker
              v-model="form.navicatRootPath"
              v-path-tail="form.navicatRootPath"
              :title="form.navicatRootPath || undefined"
              kind="directory"
              label="Carpeta de datos de Navicat"
              hint="Se usa para importar conexiones, tareas y copias"
              class="nd-path-field"
            />
            <PathPicker
              v-model="form.backupsRootDir"
              v-path-tail="form.backupsRootDir"
              :title="form.backupsRootDir || undefined"
              kind="directory"
              label="Carpeta raíz de copias de seguridad"
              hint="Destino por defecto de las copias creadas por Vortaq"
              class="nd-path-field"
            />
          </div>
          <div class="settings-row mt-3">
            <span class="settings-row__label">Formato de las copias nuevas</span>
            <v-btn-toggle
              v-model="form.defaultBackupFormat"
              mandatory
              density="compact"
              variant="outlined"
              color="primary"
              aria-label="Formato de las copias nuevas"
              data-test="settings-backup-format"
            >
              <v-btn value="vqb">.vqb</v-btn>
              <v-btn value="nb3">.nb3</v-btn>
              <v-btn value="sql">.sql</v-btn>
            </v-btn-toggle>
          </div>
          <p class="settings-section__hint">
            .vqb es el formato abierto de Vortaq (con cifrado opcional; también para PostgreSQL),
            .nb3 es compatible con Navicat y .sql sirve para otros gestores.
          </p>
        </section>

        <section class="settings-section" aria-label="Consultas">
          <div class="settings-section__title">
            <v-icon icon="mdi-table-large" size="15" aria-hidden="true" />Consultas
          </div>
          <v-text-field
            v-model.number="form.defaultRowLimit"
            type="number"
            min="1"
            label="Límite de filas por defecto"
            hint="Filas cargadas al abrir una tabla o ejecutar una consulta"
            persistent-hint
            class="settings-dialog__limit"
          />
        </section>

        <section class="settings-section" aria-label="Apariencia">
          <div class="settings-section__title">
            <v-icon icon="mdi-palette-outline" size="15" aria-hidden="true" />Apariencia
          </div>
          <div class="settings-row">
            <span class="settings-row__label">Tema</span>
            <v-btn-toggle
              v-model="form.theme"
              mandatory
              density="compact"
              variant="outlined"
              color="primary"
              aria-label="Tema"
            >
              <v-btn value="dark" prepend-icon="mdi-weather-night">Oscuro</v-btn>
              <v-btn value="light" prepend-icon="mdi-white-balance-sunny">Claro</v-btn>
            </v-btn-toggle>
          </div>
        </section>

        <section class="settings-section" aria-label="Actualizaciones">
          <div class="settings-section__title">
            <v-icon icon="mdi-update" size="15" aria-hidden="true" />Actualizaciones
          </div>
          <div class="settings-row">
            <span class="settings-row__label">
              Versión instalada
              <span class="nd-mono settings-version" data-test="settings-version">{{
                updates.appVersion || '—'
              }}</span>
            </span>
            <v-btn
              size="small"
              variant="tonal"
              prepend-icon="mdi-update"
              data-test="settings-check-updates"
              @click="updates.openDialog()"
              >Buscar ahora</v-btn
            >
          </div>
          <v-switch
            v-model="form.checkUpdatesOnStartup"
            color="primary"
            label="Buscar actualizaciones al iniciar"
            density="compact"
            hide-details
            data-test="settings-check-updates-startup"
            class="settings-dialog__switch"
          />
          <v-switch
            v-model="form.autoDownloadUpdates"
            color="primary"
            label="Descargar actualizaciones automáticamente"
            :messages="[
              'Windows (instalador) y Linux (AppImage): al encontrar una versión nueva la descarga sin esperar a que pulses el botón. Instalarla sigue siendo decisión tuya (o se instala al cerrar la app).'
            ]"
            density="compact"
            data-test="settings-auto-download-updates"
            class="settings-dialog__switch"
          />
          <div class="settings-row">
            <span class="settings-row__label">Recorrido por las funciones principales</span>
            <v-btn
              size="small"
              variant="tonal"
              prepend-icon="mdi-map-marker-path"
              data-test="settings-replay-tour"
              @click="replayTour"
              >Ver tour de bienvenida</v-btn
            >
          </div>
        </section>

        <AiSettingsSection
          v-model:enabled="form.aiEnabled"
          v-model:default-provider-id="form.aiDefaultProviderId"
          v-model:effort="form.aiEffort"
          v-model:max-tokens="form.aiMaxTokens"
        />

        <McpSettingsSection
          v-model:enabled="form.mcpEnabled"
          v-model:drafts="mcpDrafts"
          :typed-environments="typedEnvironments"
        />

        <section class="settings-section settings-section--danger" aria-label="Seguridad">
          <div class="settings-section__title">
            <v-icon icon="mdi-shield-alert-outline" size="15" aria-hidden="true" />Seguridad
          </div>
          <fieldset class="typed-envs" data-test="settings-typed-envs">
            <legend class="typed-envs__legend">
              Pedir confirmación escribiendo el nombre antes de escribir en:
            </legend>
            <div class="typed-envs__chips">
              <label
                v-for="env in ALL_ENVIRONMENTS"
                :key="env"
                class="typed-env"
                :class="{ 'typed-env--on': isTyped(env), 'typed-env--locked': isMandatory(env) }"
                :data-test="`settings-typed-env-${env}`"
              >
                <input
                  type="checkbox"
                  class="typed-env__input"
                  :checked="isTyped(env)"
                  :disabled="isMandatory(env)"
                  :aria-label="
                    isMandatory(env)
                      ? `${environmentLabel(env)} (${PRODUCTION_LOCKED_TOOLTIP.toLowerCase()})`
                      : environmentLabel(env)
                  "
                  @change="toggleTyped(env, ($event.target as HTMLInputElement).checked)"
                />
                <v-icon
                  class="typed-env__check"
                  :icon="
                    isMandatory(env)
                      ? 'mdi-lock'
                      : isTyped(env)
                        ? 'mdi-checkbox-marked'
                        : 'mdi-checkbox-blank-outline'
                  "
                  size="16"
                  aria-hidden="true"
                />
                <span class="nd-pill" :class="environmentPillClass(env)">{{
                  environmentLabel(env)
                }}</span>
                <v-tooltip
                  v-if="isMandatory(env)"
                  activator="parent"
                  location="top"
                  :text="PRODUCTION_LOCKED_TOOLTIP"
                />
              </label>
            </div>
            <p class="typed-envs__hint">
              Producción siempre está incluida. Las tareas automáticas no pueden restaurar sobre
              estas conexiones (nadie escribe el nombre).
            </p>
          </fieldset>
          <v-switch
            v-model="form.confirmDestructiveEverywhere"
            color="error"
            label="Confirmar antes de borrar o eliminar en cualquier conexión"
            hint="DROP, TRUNCATE, DELETE y eliminar filas, tablas, vistas, rutinas, eventos o bases de datos"
            persistent-hint
            density="compact"
            data-test="settings-confirm-destructive"
            class="settings-dialog__switch"
          />
        </section>
        <v-alert v-if="error" type="error">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">Cancelar</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :loading="saving"
          data-test="settings-save"
          @click="save"
          >Guardar</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.settings-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 4px !important;
}
.settings-section {
  padding: 12px 14px 14px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
}
.settings-section__title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  font-size: var(--nd-fs-small);
  font-weight: 600;
  color: var(--nd-text-2);
}
.settings-section__title .v-icon {
  color: var(--nd-text-muted);
}
.settings-section__fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.settings-dialog__limit {
  max-width: 380px;
}
.settings-dialog__limit :deep(input) {
  font-family: var(--nd-font-mono);
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.settings-row__label {
  color: var(--nd-text);
}
.settings-section__hint {
  margin: 6px 0 0;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.settings-dialog__switch {
  margin-top: 8px;
}
/* Help text under a switch: room before the next row. */
.settings-dialog__switch + .settings-row {
  margin-top: 14px;
}
.settings-version {
  margin-left: 6px;
  color: var(--nd-accent);
}
.typed-envs {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.typed-envs__legend {
  padding: 0;
  margin-bottom: 8px;
  color: var(--nd-text);
}
.typed-envs__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.typed-env {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px 0 8px;
  border-radius: var(--nd-radius-control);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-input);
  cursor: pointer;
  user-select: none;
  transition:
    border-color 0.12s,
    background-color 0.12s;
}
.typed-env:hover:not(.typed-env--locked) {
  border-color: var(--nd-border-strong);
}
.typed-env--on {
  border-color: color-mix(in srgb, var(--nd-error) 40%, transparent);
  background: color-mix(in srgb, var(--nd-error) 8%, var(--nd-bg-raised));
}
.typed-env--locked {
  cursor: default;
}
.typed-env__input {
  position: absolute;
  inset: 0;
  opacity: 0;
  margin: 0;
  cursor: inherit;
}
.typed-env:focus-within {
  outline: 2px solid var(--nd-accent);
  outline-offset: 1px;
}
.typed-env__check {
  color: var(--nd-text-muted);
}
.typed-env--on .typed-env__check {
  color: var(--nd-error);
}
.typed-envs__hint {
  margin: 8px 0 0;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-muted);
}
.settings-section--danger {
  border-color: color-mix(in srgb, var(--nd-error) 22%, transparent);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--nd-error) 6%, transparent), transparent 70%),
    var(--nd-bg-raised);
}
.settings-section--danger .settings-section__title,
.settings-section--danger .settings-section__title .v-icon {
  color: var(--nd-error);
}
</style>
