<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ENGINES } from '@shared/engines'
import {
  effectiveMcpAccess,
  isMcpEnabled,
  MCP_ACCESS_LABELS,
  MCP_PRIVACY_NOTE,
  mcpClientSnippets,
  normalizeMcpConfig,
  type McpClientSnippet
} from '@shared/mcp'
import type { Environment, McpLaunchInfo } from '@shared/types'
import { api } from '@renderer/api'
import { useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { environmentLabel, environmentPillClass } from '@renderer/components/backups/backupHelpers'

/**
 * Ajustes › Agentes (MCP): the global switch (saved with «Guardar»), the
 * connections available to agents with their effective level, the privacy
 * note and the configuration each MCP client needs to start `Vortaq --mcp`.
 */
const enabled = defineModel<boolean>('enabled', { required: true })
const props = defineProps<{
  /** Environments that need the typed confirmation, as currently set in Ajustes. */
  typedEnvironments: readonly Environment[]
}>()

const connections = useConnectionsStore()
const notify = useNotify()
const launch = ref<McpLaunchInfo | null>(null)
const client = ref<McpClientSnippet['id']>('claudeCode')

const exposed = computed(() =>
  connections.items
    .filter((c) => isMcpEnabled(c))
    .map((c) => {
      const access = effectiveMcpAccess(c, props.typedEnvironments) ?? 'read'
      const requested = normalizeMcpConfig(c.mcp)?.access ?? access
      return {
        id: c.id,
        name: c.name,
        engine: ENGINES[c.engine]?.label ?? c.engine,
        environment: c.environment,
        level: MCP_ACCESS_LABELS[access],
        blocked: requested === 'write' && access !== 'write'
      }
    })
)

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
      hint="Claude Code, Claude Desktop, Cursor, VS Code y otros clientes MCP pueden usar las conexiones que actives para agentes, sin ver contraseñas, hosts, usuarios ni rutas."
      persistent-hint
      density="compact"
      data-test="settings-mcp-enabled"
    />
    <p class="mcp-settings__privacy" data-test="settings-mcp-privacy">
      <v-icon icon="mdi-shield-key-outline" size="14" aria-hidden="true" />{{ MCP_PRIVACY_NOTE }}
    </p>

    <div class="mcp-settings__head">Conexiones disponibles para agentes</div>
    <div v-if="!exposed.length" class="mcp-settings__empty" data-test="settings-mcp-none">
      Ninguna. Actívalas una a una en editar conexión › Agentes (MCP).
    </div>
    <ul v-else class="mcp-settings__list" data-test="settings-mcp-connections">
      <li
        v-for="c in exposed"
        :key="c.id"
        class="mcp-settings__item"
        :data-test="`settings-mcp-conn-${c.id}`"
      >
        <span class="mcp-settings__name nd-ellipsis">{{ c.name }}</span>
        <span class="mcp-settings__engine">{{ c.engine }}</span>
        <span class="nd-pill" :class="environmentPillClass(c.environment)">{{
          environmentLabel(c.environment)
        }}</span>
        <span class="mcp-settings__level" :class="{ 'mcp-settings__level--blocked': c.blocked }">
          <v-icon
            :icon="c.blocked ? 'mdi-pencil-lock-outline' : 'mdi-account-key-outline'"
            size="14"
            aria-hidden="true"
          />{{ c.level }}
          <v-tooltip
            v-if="c.blocked"
            activator="parent"
            location="top"
            text="Guardada con «Lectura y escritura», pero su entorno pide escribir el nombre: los agentes solo pueden leer."
          />
        </span>
      </li>
    </ul>

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
.mcp-settings__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--nd-radius-control);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-input);
}
.mcp-settings__name {
  color: var(--nd-text);
}
.mcp-settings__engine {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.mcp-settings__level {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-accent);
}
.mcp-settings__level--blocked {
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
  overflow-x: auto;
  white-space: pre;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text);
}
</style>
