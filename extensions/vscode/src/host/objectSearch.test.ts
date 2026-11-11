import { describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig, VortaqCore } from '@core'
import { MAX_NAMESPACES, namespacesOf, objectItems, searchDatabase } from './objectSearch'

const ms = {
  id: 'ms',
  engine: 'sqlserver',
  sqlserver: { initialDatabase: 'ventas' }
} as ConnectionConfig
const my = { id: 'my', engine: 'mysql' } as ConnectionConfig

describe('«Buscar tabla o vista…»', () => {
  it('searches the selected database on PostgreSQL and SQL Server, else the initial one', () => {
    expect(searchDatabase(ms)).toBe('ventas')
    expect(
      searchDatabase(ms, { kind: 'schema', connectionId: 'ms', database: 'otra', schema: 'dbo' })
    ).toBe('otra')
    expect(searchDatabase({ ...ms, sqlserver: undefined } as ConnectionConfig)).toBe('master')
    expect(searchDatabase({ id: 'pg', engine: 'postgresql' } as ConnectionConfig)).toBe('postgres')
  })

  it('reads the schemas of one database (two-level engines) or every database, up to a limit', async () => {
    const invoke = vi.fn(async (channel: string) =>
      channel === 'db:schemas'
        ? [{ name: 'dbo' }, { name: 'ventas' }]
        : Array.from({ length: MAX_NAMESPACES + 5 }, (_, i) => ({ name: `db${i}` }))
    )
    const core = { invoke } as unknown as VortaqCore
    expect(await namespacesOf(core, ms)).toEqual([
      { database: 'ventas', schema: 'dbo' },
      { database: 'ventas', schema: 'ventas' }
    ])
    expect(invoke).toHaveBeenCalledWith('db:schemas', 'ms', 'ventas')
    expect(await namespacesOf(core, my)).toHaveLength(MAX_NAMESPACES)
  })

  it('lists tables and views with where they live, as tree nodes', () => {
    const items = objectItems(
      { database: 'ventas', schema: 'dbo' },
      'ms',
      [{ name: 'pedidos' }],
      [{ name: 'resumen' }]
    )
    expect(items.map((i) => [i.label, i.description])).toEqual([
      ['$(table) pedidos', 'tabla · ventas.dbo'],
      ['$(eye) resumen', 'vista · ventas.dbo']
    ])
    expect(items[0].node).toEqual({
      kind: 'table',
      connectionId: 'ms',
      database: 'ventas',
      schema: 'dbo',
      name: 'pedidos'
    })
    expect(objectItems({ database: 'tienda' }, 'my', [{ name: 't' }], [])[0].node).toEqual({
      kind: 'table',
      connectionId: 'my',
      database: 'tienda',
      name: 't'
    })
  })
})
