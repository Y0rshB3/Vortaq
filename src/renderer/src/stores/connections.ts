import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionMcpConfig,
  ConnectionTestResult,
  ServerInfo
} from '@shared/types'
import { api, invokeSilent } from '@renderer/api'
import { useNotify } from '@renderer/composables/useNotify'
import { useSettingsStore } from '@renderer/stores/settings'

export const useConnectionsStore = defineStore('connections', () => {
  const items = ref<ConnectionConfig[]>([])
  const loaded = ref(false)
  const serverInfo = ref<Record<string, ServerInfo>>({})
  const opening = ref<Record<string, boolean>>({})

  const byId = computed(() => new Map(items.value.map((c) => [c.id, c])))
  const openIds = computed(() => Object.keys(serverInfo.value))
  const sorted = computed(() => [...items.value].sort((a, b) => a.name.localeCompare(b.name, 'es')))

  function get(id: string): ConnectionConfig | undefined {
    return byId.value.get(id)
  }
  function isOpen(id: string): boolean {
    return id in serverInfo.value
  }
  /** Visual cues (red line, pill, tree chip) stay tied to production only. */
  function isProduction(id: string): boolean {
    return get(id)?.environment === 'production'
  }
  /**
   * Writes need the typed connection name: production, plus the environments
   * chosen in Ajustes › Seguridad.
   */
  function needsTypedConfirm(id: string): boolean {
    return useSettingsStore().needsTypedConfirm(get(id)?.environment)
  }
  function nameOf(id: string): string {
    return get(id)?.name ?? id
  }

  async function load(): Promise<void> {
    items.value = await api.connections.list()
    loaded.value = true
    await syncOpenState()
  }

  /**
   * Connections live in the main process and survive a window reload. Ask main
   * which ones are still open so the UI does not show them as closed (and the
   * user does not end up with pools nobody can see or close).
   */
  async function syncOpenState(): Promise<void> {
    await Promise.all(
      items.value.map(async (c) => {
        if (serverInfo.value[c.id]) return
        const open = await api.connections.isOpen(c.id).catch(() => false)
        if (!open) return
        try {
          const info = await invokeSilent('connections:open', c.id)
          serverInfo.value = { ...serverInfo.value, [c.id]: info }
        } catch {
          /* it closed in the meantime: keep it shown as closed */
        }
      })
    )
  }

  async function open(id: string): Promise<ServerInfo> {
    if (serverInfo.value[id]) return serverInfo.value[id]
    opening.value = { ...opening.value, [id]: true }
    try {
      const info = await api.connections.open(id)
      serverInfo.value = { ...serverInfo.value, [id]: info }
      // A MySQL connection whose server is MariaDB is stored as MariaDB when it opens (P5):
      // reload the list so the tree, the guard and the menus use the MariaDB engine.
      const stored = get(id)
      if (stored && info.engine && info.engine !== (stored.engine ?? 'mysql')) {
        items.value = await api.connections.list()
        useNotify().info(`«${stored.name}» es un servidor MariaDB: ahora es una conexión MariaDB.`)
      }
      return info
    } finally {
      const next = { ...opening.value }
      delete next[id]
      opening.value = next
    }
  }

  /** Replaces the facts of an open connection (SQLite «Reabrir en modo escritura»). */
  function setServerInfo(id: string, info: ServerInfo): void {
    serverInfo.value = { ...serverInfo.value, [id]: info }
  }

  function markClosed(id: string): void {
    if (!(id in serverInfo.value)) return
    const next = { ...serverInfo.value }
    delete next[id]
    serverInfo.value = next
  }

  async function close(id: string): Promise<void> {
    await api.connections.close(id)
    markClosed(id)
  }

  async function save(input: ConnectionInput): Promise<ConnectionConfig> {
    const saved = await api.connections.save(input)
    const idx = items.value.findIndex((c) => c.id === saved.id)
    if (idx >= 0) items.value.splice(idx, 1, saved)
    else items.value.push(saved)
    return saved
  }

  /** Ajustes › Agentes (MCP): saves only the connection's agents setting. */
  async function setMcp(id: string, mcp: ConnectionMcpConfig): Promise<ConnectionConfig> {
    const saved = await api.connections.setMcp(id, mcp)
    const idx = items.value.findIndex((c) => c.id === saved.id)
    if (idx >= 0) items.value.splice(idx, 1, saved)
    return saved
  }

  async function remove(id: string): Promise<void> {
    if (isOpen(id)) await api.connections.close(id).catch(() => undefined)
    await api.connections.delete(id)
    markClosed(id)
    items.value = items.value.filter((c) => c.id !== id)
  }

  function test(
    input: ConnectionInput,
    password: string | null,
    sshPassword: string | null
  ): Promise<ConnectionTestResult> {
    return api.connections.test(input, password, sshPassword)
  }

  function listenToClosedEvents(): () => void {
    return api.on('event:connectionClosed', ({ connectionId, reason }) => {
      if (!isOpen(connectionId)) return
      markClosed(connectionId)
      useNotify().warning(`Conexión "${nameOf(connectionId)}" cerrada: ${reason}`)
    })
  }

  return {
    items,
    loaded,
    syncOpenState,
    serverInfo,
    opening,
    byId,
    openIds,
    sorted,
    get,
    isOpen,
    isProduction,
    needsTypedConfirm,
    setServerInfo,
    nameOf,
    load,
    open,
    close,
    markClosed,
    save,
    setMcp,
    remove,
    test,
    listenToClosedEvents
  }
})
