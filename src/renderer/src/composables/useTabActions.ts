import { api } from '@renderer/api'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import { useUiStore } from '@renderer/stores/ui'
import { useTransactionPrompt } from './useTransactionPrompt'

/**
 * Query tab of an engine whose tabs own a session (D12): PostgreSQL and SQL
 * Server (a server session per tab) and SQLite (the tab that opened the shared transaction).
 */
function hasTabSession(
  tab: WorkspaceTab,
  connections: ReturnType<typeof useConnectionsStore>
): boolean {
  if (tab.kind !== 'query' || !tab.connectionId) return false
  const engine = connections.get(tab.connectionId)?.engine
  return (
    engine === 'postgresql' || engine === 'sqlite' || engine === 'mongodb' || engine === 'sqlserver'
  )
}

/** Tab closing with an unsaved-changes guard, shared by the tab strip and keyboard shortcuts. */
export function useTabActions() {
  const tabs = useTabsStore()
  const ui = useUiStore()
  const connections = useConnectionsStore()
  const { settleTransaction } = useTransactionPrompt()

  /** Closes a tab, asking first when it has unsaved changes. Resolves true when closed. */
  async function requestClose(id: string): Promise<boolean> {
    const tab = tabs.tabs.find((t) => t.id === id)
    if (!tab || !tab.closable) return false
    if (tab.dirty) {
      const ok = await ui.ask({
        title: 'Cambios sin guardar',
        message: `"${tab.title}" tiene cambios sin guardar. Si cierras la pestaña se perderán.`,
        confirmText: 'Cerrar sin guardar',
        color: 'warning'
      })
      if (!ok) return false
    }
    if (hasTabSession(tab, connections) && connections.isOpen(tab.connectionId!)) {
      // An open transaction is committed or rolled back explicitly, never dropped silently.
      if (!(await settleTransaction(tab.connectionId!, tab.id, 'Cerrar la pestaña'))) return false
      await api.db.closeSession(tab.connectionId!, tab.id).catch(() => undefined)
    }
    tabs.close(id)
    return true
  }

  function requestCloseActive(): Promise<boolean> {
    return requestClose(tabs.activeId)
  }

  /** Closes every other closable tab; dirty ones are kept (tabs.closeOthers semantics). */
  function closeOthers(id: string): void {
    // Tab sessions of the closed query tabs are released on the server (no open transaction is
    // committed: closing the session rolls it back, like closing the connection).
    for (const tab of tabs.tabs) {
      if (tab.id === id || !tab.closable || tab.dirty || !hasTabSession(tab, connections)) continue
      if (connections.isOpen(tab.connectionId!))
        void api.db.closeSession(tab.connectionId!, tab.id).catch(() => undefined)
    }
    tabs.closeOthers(id)
  }

  return { requestClose, requestCloseActive, closeOthers }
}
