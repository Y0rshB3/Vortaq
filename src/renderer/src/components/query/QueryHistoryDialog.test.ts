import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freshPinia, mountWith, settle } from '@renderer/components/dialogs/testing'
import { HISTORY_KEY, useQueryHistoryStore } from '@renderer/stores/queryHistory'
import type { NewHistoryEntry } from '@shared/queryHistory'
import QueryHistoryDialog from './QueryHistoryDialog.vue'

const run = (sql: string, over: Partial<NewHistoryEntry> = {}): NewHistoryEntry => ({
  sql,
  connectionId: 'c1',
  connectionName: 'Tienda',
  engine: 'mysql',
  database: 'tienda',
  at: '2026-11-11T05:00:00.000Z',
  durationMs: 12,
  statements: 1,
  rows: 3,
  ok: true,
  ...over
})

describe('Historial de consultas (desktop)', () => {
  let wrapper: ReturnType<typeof mountWith> | null = null
  beforeEach(() => localStorage.clear())
  afterEach(() => wrapper?.unmount())

  it('keeps runs in localStorage, lists this connection’s, searches, and «Abrir» hands one over', async () => {
    const pinia = freshPinia()
    const store = useQueryHistoryStore()
    store.record(run('SELECT * FROM clientes'))
    store.record(run('SELECT * FROM pedidos', { ok: false, rows: null }))
    store.record(run('SELECT 1', { connectionId: 'c2', connectionName: 'Otra' }))
    expect(JSON.parse(localStorage.getItem(HISTORY_KEY)!)).toHaveLength(3)

    wrapper = mountWith(QueryHistoryDialog, pinia, {
      props: { modelValue: true, connectionId: 'c1', connectionName: 'Tienda' }
    })
    await settle()
    const text = wrapper.text()
    expect(text).toContain('SELECT * FROM pedidos')
    expect(text).toContain('SELECT * FROM clientes')
    expect(text).not.toContain('SELECT 1')
    expect(text).toContain('Tienda · tienda')
    expect(text).toContain('error')

    await wrapper.get('[data-test="query-history-search"] input').setValue('clientes')
    await settle()
    expect(wrapper.text()).not.toContain('SELECT * FROM pedidos')
    const entry = store.entries.find((e) => e.sql === 'SELECT * FROM clientes')!
    await wrapper.get(`[data-test="query-history-use-${entry.id}"]`).trigger('click')
    expect(wrapper.emitted('use')?.[0]?.[0]).toMatchObject({ sql: 'SELECT * FROM clientes' })
  })

  it('turning it off forgets what was kept and stops recording', () => {
    freshPinia()
    const store = useQueryHistoryStore()
    store.record(run('SELECT 1'))
    store.setEnabled(false)
    expect(store.entries).toEqual([])
    store.record(run('SELECT 2'))
    expect(store.entries).toEqual([])
    expect(JSON.parse(localStorage.getItem(HISTORY_KEY)!)).toEqual([])
  })
})
