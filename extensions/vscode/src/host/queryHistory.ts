/**
 * «Vortaq: Historial de consultas»: the scripts run from SQL documents, newest
 * first, in the editor's global state (every window shares it; never synced
 * or sent anywhere). The list, search and limits are shared/queryHistory.ts;
 * here are the storage and the picker: search, open in a new document with
 * the same connection and database, copy, remove, clear.
 */
import * as vscode from 'vscode'
import {
  addHistoryEntry,
  historySummary,
  historyTitle,
  normalizeHistory,
  type NewHistoryEntry,
  type QueryHistoryEntry
} from '@core'

export const HISTORY_STATE_KEY = 'vortaq.queryHistory'

export class ExtensionQueryHistory {
  constructor(
    private readonly state: vscode.Memento,
    /** `vortaq.queryHistory.enabled`. */
    private readonly enabled: () => boolean
  ) {}

  list(): QueryHistoryEntry[] {
    return normalizeHistory(this.state.get<unknown>(HISTORY_STATE_KEY, []))
  }

  async record(entry: NewHistoryEntry): Promise<void> {
    if (!this.enabled()) return
    await this.state.update(HISTORY_STATE_KEY, addHistoryEntry(this.list(), entry))
  }

  async remove(id: string): Promise<void> {
    await this.state.update(
      HISTORY_STATE_KEY,
      this.list().filter((e) => e.id !== id)
    )
  }

  async clear(): Promise<void> {
    await this.state.update(HISTORY_STATE_KEY, [])
  }
}

type HistoryItem = vscode.QuickPickItem & { entry: QueryHistoryEntry }

const COPY: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('copy'),
  tooltip: 'Copiar SQL'
}
const REMOVE: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('trash'),
  tooltip: 'Quitar del historial'
}
const CLEAR: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('clear-all'),
  tooltip: 'Borrar todo el historial'
}

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })
}

export function historyItems(entries: readonly QueryHistoryEntry[]): HistoryItem[] {
  return entries.map((entry) => ({
    label: `${entry.ok ? '$(pass)' : '$(error)'} ${historyTitle(entry)}`,
    description: `${entry.connectionName}${entry.database ? ` · ${entry.database}` : ''} · ${when(entry.at)}`,
    detail: `${historySummary(entry)}${entry.truncated ? ' · recortado' : ''}`,
    buttons: [COPY, REMOVE],
    entry
  }))
}

/** The picker. `open` puts an entry in a new SQL document (with its connection when it still exists). */
export function showQueryHistory(
  history: ExtensionQueryHistory,
  open: (entry: QueryHistoryEntry) => Promise<void>,
  enabled: boolean
): Promise<void> {
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<HistoryItem>()
    pick.title = 'Vortaq · Historial de consultas'
    pick.placeholder = enabled
      ? 'Busca en el SQL, la conexión o la base de datos; Intro lo abre en un documento nuevo'
      : 'El historial está desactivado (ajuste vortaq.queryHistory.enabled)'
    pick.matchOnDescription = true
    pick.matchOnDetail = true
    pick.buttons = [CLEAR]
    const refresh = (): void => {
      pick.items = historyItems(history.list())
    }
    refresh()
    pick.onDidTriggerItemButton(async ({ button, item }) => {
      if (button === COPY) {
        await vscode.env.clipboard.writeText(item.entry.sql)
        vscode.window.setStatusBarMessage('$(check) SQL copiado', 3000)
      } else if (button === REMOVE) {
        await history.remove(item.entry.id)
        refresh()
      }
    })
    pick.onDidTriggerButton(async (button) => {
      if (button !== CLEAR) return
      const yes = 'Borrar'
      const answer = await vscode.window.showWarningMessage(
        '¿Borrar todo el historial de consultas de este editor?',
        { modal: true },
        yes
      )
      if (answer === yes) {
        await history.clear()
        refresh()
      }
    })
    pick.onDidAccept(async () => {
      const item = pick.selectedItems[0]
      pick.hide()
      if (item) await open(item.entry)
    })
    pick.onDidHide(() => {
      pick.dispose()
      resolve()
    })
    pick.show()
  })
}
