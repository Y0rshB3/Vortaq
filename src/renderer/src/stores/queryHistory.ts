import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  addHistoryEntry,
  normalizeHistory,
  type NewHistoryEntry,
  type QueryHistoryEntry
} from '@shared/queryHistory'

/** localStorage keys (the `electrondb.` prefix of every renderer key). */
export const HISTORY_KEY = 'electrondb.queryHistory'
export const HISTORY_ENABLED_KEY = 'electrondb.queryHistory.enabled'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full or blocked: the history simply is not kept */
  }
}

/**
 * «Historial de consultas» of the desktop app: every script run from a query
 * tab, newest first, in this window's localStorage (shared/queryHistory.ts).
 */
export const useQueryHistoryStore = defineStore('queryHistory', () => {
  const entries = ref<QueryHistoryEntry[]>(normalizeHistory(read<unknown>(HISTORY_KEY, [])))
  const enabled = ref<boolean>(read<unknown>(HISTORY_ENABLED_KEY, true) !== false)

  function record(entry: NewHistoryEntry): void {
    if (!enabled.value) return
    entries.value = addHistoryEntry(entries.value, entry)
    write(HISTORY_KEY, entries.value)
  }

  function remove(id: string): void {
    entries.value = entries.value.filter((e) => e.id !== id)
    write(HISTORY_KEY, entries.value)
  }

  function clear(): void {
    entries.value = []
    write(HISTORY_KEY, [])
  }

  /** Turning it off also forgets what was kept. */
  function setEnabled(on: boolean): void {
    enabled.value = on
    write(HISTORY_ENABLED_KEY, on)
    if (!on) clear()
  }

  return { entries, enabled, record, remove, clear, setEnabled }
})
