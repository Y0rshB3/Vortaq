import { describe, expect, it } from 'vitest'
import type * as vscode from 'vscode'
import type { NewHistoryEntry } from '@core'
import { ExtensionQueryHistory, HISTORY_STATE_KEY, historyItems } from './queryHistory'

function memento() {
  const values = new Map<string, unknown>()
  return {
    values,
    state: {
      get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback),
      update: async (key: string, value: unknown) => {
        values.set(key, value)
      }
    } as unknown as vscode.Memento
  }
}

const run = (sql: string, over: Partial<NewHistoryEntry> = {}): NewHistoryEntry => ({
  sql,
  connectionId: 'ms',
  connectionName: 'Ventas',
  engine: 'sqlserver',
  database: 'ventas',
  schema: 'dbo',
  at: '2026-11-11T05:00:00.000Z',
  durationMs: 40,
  statements: 1,
  rows: 2,
  ok: true,
  ...over
})

describe('query history (editor extension)', () => {
  it('records runs in the global state, newest first, and removes or clears them', async () => {
    const { state, values } = memento()
    const history = new ExtensionQueryHistory(state, () => true)
    await history.record(run('SELECT 1'))
    await history.record(run('SELECT * FROM dbo.pedidos', { ok: false, rows: null }))
    expect(history.list().map((e) => e.sql)).toEqual(['SELECT * FROM dbo.pedidos', 'SELECT 1'])
    expect((values.get(HISTORY_STATE_KEY) as unknown[]).length).toBe(2)
    const items = historyItems(history.list())
    expect(items[0]).toMatchObject({
      label: '$(error) SELECT * FROM dbo.pedidos',
      detail: 'error · 40 ms'
    })
    expect(items[1].description).toMatch(/^Ventas · ventas · /)
    await history.remove(history.list()[0].id)
    expect(history.list().map((e) => e.sql)).toEqual(['SELECT 1'])
    await history.clear()
    expect(history.list()).toEqual([])
  })

  it('records nothing while vortaq.queryHistory.enabled is off', async () => {
    const { state } = memento()
    const history = new ExtensionQueryHistory(state, () => false)
    await history.record(run('SELECT 1'))
    expect(history.list()).toEqual([])
  })
})
