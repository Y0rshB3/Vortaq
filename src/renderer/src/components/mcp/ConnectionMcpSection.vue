<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  DEFAULT_MCP_ACCESS,
  MCP_ACCESS_HINTS,
  MCP_ACCESS_LABELS,
  MCP_ACCESS_LEVELS,
  MCP_PRIVACY_NOTE,
  MCP_WRITE_BLOCKED,
  mcpWriteBlocked,
  normalizeMcpConfig
} from '@shared/mcp'
import type { ConnectionMcpConfig, Environment, McpAccess } from '@shared/types'

/**
 * Connection dialog › Agentes (MCP): whether agents may use this connection
 * and with which level (default «Lectura»). «Lectura y escritura» is disabled
 * on environments that need the typed confirmation; main refuses it too and
 * the MCP process re-checks it on every call.
 */
const mcp = defineModel<ConnectionMcpConfig | undefined>('mcp', { default: undefined })
const props = defineProps<{
  environment: Environment
  typedEnvironments: readonly Environment[]
  /** Ajustes › Agentes (MCP) is on. */
  globalEnabled: boolean
}>()

const config = computed(() => normalizeMcpConfig(mcp.value))
const enabled = computed({
  get: () => config.value?.enabled === true,
  set: (on: boolean) => {
    mcp.value = { enabled: on, access: config.value?.access ?? DEFAULT_MCP_ACCESS }
  }
})
const writeBlocked = computed(() => mcpWriteBlocked(props.environment, props.typedEnvironments))
const access = computed<McpAccess>({
  get: () => config.value?.access ?? DEFAULT_MCP_ACCESS,
  set: (level) => {
    mcp.value = { enabled: enabled.value, access: level }
  }
})
/** Set when the environment changed and «Lectura y escritura» was lowered to «Lectura». */
const lowered = ref(false)
watch(
  writeBlocked,
  (blocked) => {
    if (blocked && access.value === 'write') {
      mcp.value = { enabled: enabled.value, access: 'read' }
      lowered.value = true
    } else if (!blocked) lowered.value = false
  },
  { immediate: true }
)
</script>

<template>
  <div class="conn-mcp" data-test="conn-mcp">
    <v-switch
      v-model="enabled"
      color="primary"
      label="Disponible para agentes (MCP)"
      :hint="
        enabled
          ? 'Vortaq da a los agentes el nombre, el motor, el entorno y el nivel; nunca la contraseña, el host, el puerto, el usuario, el túnel SSH ni la ruta del archivo de la conexión.'
          : 'Desactivada: esta conexión no existe para los agentes.'
      "
      persistent-hint
      density="compact"
      data-test="conn-mcp-enabled"
    />
    <v-alert
      v-if="enabled && !globalEnabled"
      type="info"
      variant="tonal"
      density="compact"
      class="mt-3"
      data-test="conn-mcp-global-off"
    >
      Además activa «Permitir que agentes usen Vortaq (MCP)» en Ajustes › Agentes (MCP).
    </v-alert>
    <fieldset class="conn-mcp__levels" :disabled="!enabled" data-test="conn-mcp-access">
      <legend class="conn-mcp__legend">Qué puede hacer un agente</legend>
      <label
        v-for="level in MCP_ACCESS_LEVELS"
        :key="level"
        class="conn-mcp__level"
        :class="{
          'conn-mcp__level--on': access === level,
          'conn-mcp__level--disabled': !enabled || (level === 'write' && writeBlocked)
        }"
        :data-test="`conn-mcp-level-${level}`"
      >
        <input
          type="radio"
          name="conn-mcp-access"
          class="conn-mcp__input"
          :value="level"
          :checked="access === level"
          :disabled="!enabled || (level === 'write' && writeBlocked)"
          @change="access = level"
        />
        <v-icon
          :icon="access === level ? 'mdi-radiobox-marked' : 'mdi-radiobox-blank'"
          size="18"
          class="conn-mcp__radio"
          aria-hidden="true"
        />
        <span class="conn-mcp__text">
          <span class="conn-mcp__label"
            >{{ MCP_ACCESS_LABELS[level]
            }}<span v-if="level === 'read'" class="conn-mcp__default">recomendado</span></span
          >
          <span class="conn-mcp__hint">{{ MCP_ACCESS_HINTS[level] }}</span>
        </span>
      </label>
    </fieldset>
    <v-alert
      v-if="writeBlocked"
      type="warning"
      variant="tonal"
      density="compact"
      class="mt-2"
      data-test="conn-mcp-write-blocked"
    >
      {{ MCP_WRITE_BLOCKED }}<template v-if="lowered"> Se ha cambiado a «Lectura».</template>
    </v-alert>
    <p class="conn-mcp__privacy">
      <v-icon icon="mdi-shield-key-outline" size="14" aria-hidden="true" />{{ MCP_PRIVACY_NOTE }}
    </p>
  </div>
</template>

<style scoped>
.conn-mcp__levels {
  border: 0;
  margin: 14px 0 0;
  padding: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.conn-mcp__legend {
  padding: 0;
  margin-bottom: 6px;
  font-size: var(--nd-fs-small);
  font-weight: 600;
  color: var(--nd-text-2);
}
.conn-mcp__level {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--nd-radius-control);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-input);
  cursor: pointer;
}
.conn-mcp__level--on {
  border-color: color-mix(in srgb, var(--nd-accent) 55%, transparent);
  background: color-mix(in srgb, var(--nd-accent) 8%, var(--nd-bg-raised));
}
.conn-mcp__level--disabled {
  cursor: default;
  opacity: 0.55;
}
.conn-mcp__level:focus-within {
  outline: 2px solid var(--nd-accent);
  outline-offset: 1px;
}
.conn-mcp__input {
  position: absolute;
  inset: 0;
  opacity: 0;
  margin: 0;
  cursor: inherit;
}
.conn-mcp__radio {
  flex: none;
  margin-top: 1px;
  color: var(--nd-text-muted);
}
.conn-mcp__level--on .conn-mcp__radio {
  color: var(--nd-accent);
}
.conn-mcp__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.conn-mcp__label {
  color: var(--nd-text);
}
.conn-mcp__default {
  margin-left: 8px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.conn-mcp__hint {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.conn-mcp__privacy {
  display: flex;
  gap: 6px;
  margin: 12px 0 0;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.conn-mcp__privacy .v-icon {
  flex: none;
  margin-top: 1px;
}
</style>
