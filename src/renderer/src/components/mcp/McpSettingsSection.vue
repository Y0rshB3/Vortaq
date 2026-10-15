<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ENGINES } from '@shared/engines'
import {
  DEFAULT_MCP_ACCESS,
  MCP_ACCESS_LABELS,
  MCP_ACCESS_LEVELS,
  MCP_PRIVACY_NOTE,
  mcpClientSnippets,
  mcpWriteBlocked,
  normalizeMcpConfig,
  type McpClientSnippet
} from '@shared/mcp'
import type { ConnectionMcpConfig, Environment, McpAccess, McpLaunchInfo } from '@shared/types'
import { api } from '@renderer/api'
import { useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { environmentLabel, environmentPillClass } from '@renderer/components/backups/backupHelpers'

/**
 * Ajustes › Agentes (MCP): the global switch, every saved connection with its
 * own switch and level (the same setting as Editar conexión › Agentes (MCP)),
 * the privacy note and the configuration each MCP client needs to start
 * `Vortaq --mcp`. Nothing is written here: the switch and the per-connection
 * changes (`drafts`, keyed by connection id, only the ones that differ from
 * what is saved) are saved by Ajustes' «Guardar».
 */
const enabled = defineModel<boolean>('enabled', { required: true })
const drafts = defineModel<Record<string, ConnectionMcpConfig>>('drafts', { required: true })
const props = defineProps<{
  /** Environments that need the typed confirmation, as currently set in Ajustes. */
  typedEnvironments: readonly Environment[]
}>()

const connections = useConnectionsStore()
const notify = useNotify()
const launch = ref<McpLaunchInfo | null>(null)
const client = ref<McpClientSnippet['id']>('claudeCode')

const OFF: ConnectionMcpConfig = { enabled: false, access: DEFAULT_MCP_ACCESS }

function savedConfig(id: string): ConnectionMcpConfig {
  return normalizeMcpConfig(connections.get(id)?.mcp) ?? OFF
}

/*
 * Working copy of `drafts`: the model only reflects a change after the parent
 * re-renders, so two changes in the same tick would otherwise lose the first.
 */
const staged = ref<Record<string, ConnectionMcpConfig>>({ ...drafts.value })
watch(drafts, (value) => {
  staged.value = { ...value }
})

const rows = computed(() =>
  connections.sorted.map((c) => {
    const config = staged.value[c.id] ?? savedConfig(c.id)
    const writeBlocked = mcpWriteBlocked(c.environment, props.typedEnvironments)
    return {
      id: c.id,
      name: c.name,
      engine: ENGINES[c.engine]?.label ?? c.engine,
      environment: c.environment,
      enabled: config.enabled,
      access: config.access,
      writeBlocked,
      /** Saved with «Lectura y escritura» where agents may only read. */
      lowered: config.enabled && config.access === 'write' && writeBlocked
    }
  })
)
const enabledCount = computed(() => rows.value.filter((r) => r.enabled).length)

function levelItems(writeBlocked: boolean): { value: McpAccess; title: string; disabled: boolean }[] {
  return MCP_ACCESS_LEVELS.map((level) => ({
    value: level,
    title: MCP_ACCESS_LABELS[level],
    disabled: level === 'write' && writeBlocked
  }))
}
const levelItemProps = (item: { disabled: boolean }): { disabled: boolean } => ({
  disabled: item.disabled
})

/** Stages a change; a value equal to the saved one drops the draft. */
function change(id: string, patch: Partial<ConnectionMcpConfig>): void {
  const saved = savedConfig(id)
  const next = { ...(staged.value[id] ?? saved), ...patch }
  const copy = { ...staged.value }
  if (next.enabled === saved.enabled && next.access === saved.access) delete copy[id]
  else copy[id] = next
  staged.value = copy
  drafts.value = { ...copy }
}

const snippets = computed(() => (launch.value ? mcpClientSnippets(launch.value) : []))
const snippet = computed(() => snippets.value.find((s) => s.id === client.value) ?? null)

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    notify.success('Copiado al portapapeles')
  } catch {
    notify.error('No se pudo copiar: selecciona el texto y cópialo a mano.')
  }
}

onMounted(async () => {
  launch.value = await api.app.mcpLaunch().catch(() => null)
})
</script>

<template>
  <section class="settings-section" aria-label="Agentes (MCP)" data-test="settings-mcp">
    <div class="settings-section__title">
      <v-icon icon="mdi-robot-outline" size="15" aria-hidden="true" />Agentes (MCP)
    </div>
    <v-switch
      v-model="enabled"
      color="primary"
      label="Permitir que agentes usen Vortaq (MCP)"
      hint="Claude Code, Claude Desktop, Cursor, VS Code y otros clientes MCP pueden usar las conexiones que actives para agentes; Vortaq no les da la configuración de la conexión (contraseña, host, usuario, ruta)."
      persistent-hint
      density="compact"
      data-test="settings-mcp-enabled"
    />
    <p class="mcp-settings__privacy" data-test="settings-mcp-privacy">
      <v-icon icon="mdi-shield-key-outline" size="14" aria-hidden="true" />{{ MCP_PRIVACY_NOTE }}
    </p>

    <div class="mcp-settings__head">
      Conexiones para agentes
      <span v-if="rows.length" class="mcp-settings__count" data-test="settings-mcp-count"
        >{{ enabledCount }} de {{ rows.length }} activadas</span
      >
    </div>
    <p v-if="rows.length" class="settings-section__hint mcp-settings__intro">
      Solo las que actives existen para el agente. También puedes cambiarlo en Editar conexión ›
      Agentes (MCP). Se guarda con «Guardar».
    </p>
    <div v-if="!rows.length" class="mcp-settings__empty" data-test="settings-mcp-none">
      Todavía no tienes conexiones guardadas.
    </div>
    <ul v-else class="mcp-settings__list" data-test="settings-mcp-connections">
      <li
        v-for="c in rows"
        :key="c.id"
        class="mcp-settings__item"
        :class="{ 'mcp-settings__item--off': !c.enabled }"
        :data-test="`settings-mcp-conn-${c.id}`"
      >
        <v-switch
          :model-value="c.enabled"
          color="primary"
          density="compact"
          hide-details
          inset
          class="mcp-settings__switch"
          :aria-label="`Disponible para agentes: ${c.name}`"
          :data-test="`settings-mcp-switch-${c.id}`"
          @update:model-value="change(c.id, { enabled: $event === true })"
        />
        <span class="mcp-settings__name nd-ellipsis" :title="c.name">{{ c.name }}</span>
        <span class="mcp-settings__engine">{{ c.engine }}</span>
        <span class="nd-pill" :class="environmentPillClass(c.environment)">{{
          environmentLabel(c.environment)
        }}</span>
        <v-select
          :model-value="c.access"
          :items="levelItems(c.writeBlocked)"
          :item-props="levelItemProps"
          :disabled="!c.enabled"
          density="compact"
          variant="outlined"
          hide-details
          class="mcp-settings__level"
          :class="{ 'mcp-settings__level--blocked': c.lowered }"
          :aria-label="`Nivel para agentes: ${c.name}`"
          :data-test="`settings-mcp-level-${c.id}`"
          @update:model-value="change(c.id, { access: $event as McpAccess })"
        >
          <template v-if="c.lowered" #append-inner>
            <v-icon icon="mdi-pencil-lock-outline" size="14" aria-hidden="true" />
            <v-tooltip
              activator="parent"
              location="top"
              text="Guardada con «Lectura y escritura», pero su entorno pide escribir el nombre: los agentes solo pueden leer."
            />
          </template>
        </v-select>
      </li>
    </ul>
    <p
      v-if="rows.some((r) => r.writeBlocked)"
      class="settings-section__hint"
      data-test="settings-mcp-write-note"
    >
      En Producción y en los entornos de Seguridad que piden escribir el nombre, los agentes solo
      pueden leer.
    </p>

    <div class="mcp-settings__head">Configurar un cliente</div>
    <div v-if="snippet" class="mcp-settings__client">
      <v-btn-toggle
        v-model="client"
        mandatory
        density="compact"
        variant="outlined"
        color="primary"
        aria-label="Cliente MCP"
        data-test="settings-mcp-client"
        class="mcp-settings__clients"
      >
        <v-btn
          v-for="s in snippets"
          :key="s.id"
          :value="s.id"
          :data-test="`settings-mcp-client-${s.id}`"
          >{{ s.label }}</v-btn
        >
      </v-btn-toggle>
      <div class="mcp-settings__where">{{ snippet.where }}</div>
      <div class="mcp-settings__snippet">
        <pre class="nd-mono" data-test="settings-mcp-snippet">{{ snippet.text }}</pre>
        <v-btn
          icon="mdi-content-copy"
          size="x-small"
          variant="text"
          aria-label="Copiar"
          data-test="settings-mcp-copy"
          @click="copy(snippet.text)"
        />
      </div>
      <p
        v-if="launch && !launch.packaged"
        class="settings-section__hint"
        data-test="settings-mcp-dev"
      >
        Copia de desarrollo: el comando usa Electron y la carpeta del código (necesita
        <span class="nd-mono">npm run build</span>). La app instalada usa su propio ejecutable.
      </p>
      <p v-else-if="launch?.platform === 'linux'" class="settings-section__hint">
        Si al arrancar aparece un error de «SUID sandbox», añade
        <span class="nd-mono">--no-sandbox</span> a los argumentos.
      </p>
    </div>
    <div v-else class="mcp-settings__empty">No se pudo obtener la ruta del ejecutable.</div>
  </section>
</template>

<style scoped>
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
  margin-bottom: 8px;
  font-size: var(--nd-fs-small);
  font-weight: 600;
  color: var(--nd-text-2);
}
.settings-section__title .v-icon {
  color: var(--nd-text-muted);
}
.settings-section__hint {
  margin: 6px 0 0;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.mcp-settings__privacy {
  display: flex;
  gap: 6px;
  margin: 10px 0 0;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.mcp-settings__privacy .v-icon {
  flex: none;
  margin-top: 1px;
  color: var(--nd-text-muted);
}
.mcp-settings__head {
  margin: 14px 0 6px;
  font-size: var(--nd-fs-small);
  font-weight: 600;
  color: var(--nd-text-2);
}
.mcp-settings__empty {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-muted);
}
.mcp-settings__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mcp-settings__count {
  margin-left: 6px;
  font-weight: 400;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.mcp-settings__intro {
  margin: -2px 0 8px;
}
.mcp-settings__item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto 176px;
  align-items: center;
  gap: 10px;
  padding: 2px 8px;
  border-radius: var(--nd-radius-control);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-input);
}
.mcp-settings__item--off .mcp-settings__name {
  color: var(--nd-text-2);
}
.mcp-settings__switch {
  flex: none;
}
.mcp-settings__name {
  color: var(--nd-text);
}
.mcp-settings__engine {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.mcp-settings__level :deep(.v-field__input) {
  min-height: 30px;
  padding-top: 4px;
  padding-bottom: 4px;
  font-size: var(--nd-fs-dense);
}
.mcp-settings__level--blocked :deep(.v-field__append-inner .v-icon) {
  color: var(--nd-warning);
}
.mcp-settings__clients {
  flex-wrap: wrap;
  height: auto !important;
}
.mcp-settings__where {
  margin: 8px 0 4px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.mcp-settings__snippet {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--nd-radius-control);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-input);
}
.mcp-settings__snippet pre {
  flex: 1;
  min-width: 0;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text);
}
</style>
