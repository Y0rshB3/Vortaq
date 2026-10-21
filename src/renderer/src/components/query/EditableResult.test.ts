import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig, QueryColumn } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { mockBridge, mountComponent, setupDom } from '../../views/__tests__/helpers'
import EditableResult from './EditableResult.vue'

const columns: QueryColumn[] = [
  {
    name: 'id',
    type: 'INT',
    table: 'customers',
    schema: 'shop',
    sourceName: 'id',
    primaryKey: true
  },
  { name: 'name', type: 'VARCHAR', table: 'customers', schema: 'shop', sourceName: 'name' },
  { name: 'total', type: 'DECIMAL', table: 'orders', schema: 'shop', sourceName: 'total' }
]
const SQL = 'SELECT c.id, c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id'

type Wrapper = Awaited<ReturnType<typeof mountComponent>>

describe('EditableResult: read-only multi-table results', () => {
  let wrapper: Wrapper | null = null
  let writeText: ReturnType<typeof vi.fn>
  let invoke: ReturnType<typeof mockBridge>

  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
    writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  })
  afterEach(() => wrapper?.unmount())

  async function mount(engine: ConnectionConfig['engine'] = 'mysql', truncated = false) {
    const pinia = setupDom()
    useConnectionsStore().items = [
      { id: 'c1', name: 'Prod', environment: 'production', engine } as ConnectionConfig
    ]
    invoke = mockBridge({
      'app:pickSaveFile': () => '/tmp/out/resultado.csv',
      'export:rows': () => ({
        filePath: '/tmp/out/resultado.csv',
        rows: 2,
        bytes: 10,
        durationMs: 1,
        truncatedCells: 0
      }),
      'export:query': () => ({
        filePath: '/tmp/out/resultado.csv',
        rows: 5000,
        bytes: 10,
        durationMs: 1,
        truncatedCells: 0
      })
    })
    wrapper = await mountComponent(
      EditableResult,
      {
        connectionId: 'c1',
        sql: SQL,
        columns,
        rows: [
          [1, 'ana', '10.00'],
          [2, 'luis', null]
        ],
        truncated,
        context: 'shop',
        exportable: true
      },
      pinia
    )
    return wrapper
  }

  it('renders the selectable grid (not the old plain table) with the read-only chip and footer', async () => {
    const w = await mount('mysql', true)
    // No alias metadata in this fixture: nothing ties the columns to c or o.
    expect(w.get('[data-test="editability"]').text()).toBe(
      'Solo lectura · la consulta usa varias tablas: escribe c.* o c.columna para editar'
    )
    expect(w.find('.editable-grid').exists()).toBe(true)
    expect(w.find('.result-grid').exists()).toBe(false)
    expect(w.get('[data-test="result-footer"]').text()).toContain('2 filas')
    expect(w.get('[data-test="result-footer"]').text()).toContain('resultado truncado')
    expect(w.find('[data-test="value-toggle"]').exists()).toBe(true)
    // Read-only: no edit actions and double click does not open an editor.
    expect(w.find('[data-test="apply"]').exists()).toBe(false)
    await w.get('[data-test="cell-0-1"]').trigger('dblclick')
    expect(w.find('[data-test="cell-input"]').exists()).toBe(false)
  })

  it('a column can be selected and copied; sorting stays on the client', async () => {
    const w = await mount()
    await w.get('[data-test="header-name"]').trigger('click')
    await w.get('.editable-grid').trigger('keydown', { key: 'c', metaKey: true })
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('ana\nluis')
    await w.get('[data-test="sort-name"]').trigger('click')
    await w.get('[data-test="sort-name"]').trigger('click')
    expect(w.get('[data-test="cell-0-1"]').text()).toBe('luis')
    expect(invoke.mock.calls.some((c) => c[0] === 'db:execute')).toBe(false)
  })

  it('exports the loaded rows through main, and offers the full result for one read-only statement', async () => {
    const w = await mount()
    await w.get('[data-test="export"]').trigger('click')
    await flushPromises()
    const full = document.body.querySelector<HTMLInputElement>(
      '[data-test="export-scope-full"] input'
    )!
    expect(full.disabled).toBe(false)
    document.body.querySelector<HTMLElement>('[data-test="export-run"]')!.click()
    await flushPromises()
    const call = invoke.mock.calls.find((c) => c[0] === 'export:rows')!
    const request = call[1] as {
      columns: { name: string }[]
      rows: unknown[][]
      options: { table: string }
    }
    expect(request.columns.map((c) => c.name)).toEqual(['id', 'name', 'total'])
    expect(request.rows).toEqual([
      [1, 'ana', '10.00'],
      [2, 'luis', null]
    ])
    // Multi-table result: no source table, the INSERT name is a placeholder.
    expect(request.options.table).toBe('nombre_tabla')
  })

  it('«Resultado completo» re-runs the statement where it ran', async () => {
    const w = await mount('postgresql')
    await w.setProps({ context: { database: 'app', schema: 'public' } })
    await w.get('[data-test="export"]').trigger('click')
    await flushPromises()
    document.body.querySelector<HTMLInputElement>('[data-test="export-scope-full"] input')!.click()
    await flushPromises()
    document.body.querySelector<HTMLElement>('[data-test="export-run"]')!.click()
    await flushPromises()
    const call = invoke.mock.calls.find((c) => c[0] === 'export:query')!
    expect(call[2]).toMatchObject({
      connectionId: 'c1',
      source: { kind: 'statement', sql: SQL, context: { database: 'app', schema: 'public' } },
      options: { dialect: 'postgresql' }
    })
  })

  it('hosts without file export (the editor extension) get no «Exportar»', async () => {
    const pinia = setupDom()
    useConnectionsStore().items = [
      { id: 'c1', name: 'L', environment: 'local', engine: 'mysql' } as ConnectionConfig
    ]
    mockBridge({})
    wrapper = await mountComponent(
      EditableResult,
      { connectionId: 'c1', sql: SQL, columns, rows: [[1, 'a', null]], truncated: false },
      pinia
    )
    expect(wrapper.find('[data-test="export"]').exists()).toBe(false)
    await wrapper.get('[data-test="cell-0-0"]').trigger('contextmenu')
    await flushPromises()
    expect(document.body.querySelector('[data-test="menu-copy"]')).not.toBeNull()
    expect(document.body.querySelector('[data-test="menu-export-all"]')).toBeNull()
  })

  it('a statement whose script changed the database (USE) cannot be exported in full', async () => {
    const w = await mount()
    await w.setProps({ script: `USE otra; ${SQL}` })
    await w.get('[data-test="export"]').trigger('click')
    await flushPromises()
    const full = document.body.querySelector<HTMLInputElement>(
      '[data-test="export-scope-full"] input'
    )!
    expect(full.disabled).toBe(true)
    expect(document.body.querySelector('[data-test="export-dialog"]')!.textContent).toMatch(
      /sesión nueva/
    )
  })

  it('a script that may write cannot be exported in full', async () => {
    const pinia = setupDom()
    useConnectionsStore().items = [
      { id: 'c1', name: 'L', environment: 'local', engine: 'mysql' } as ConnectionConfig
    ]
    mockBridge({})
    wrapper = await mountComponent(
      EditableResult,
      {
        connectionId: 'c1',
        sql: 'SELECT * FROM t FOR UPDATE',
        columns,
        rows: [],
        truncated: false,
        exportable: true
      },
      pinia
    )
    await wrapper.get('[data-test="export"]').trigger('click')
    await flushPromises()
    const full = document.body.querySelector<HTMLInputElement>(
      '[data-test="export-scope-full"] input'
    )!
    expect(full.disabled).toBe(true)
    expect(document.body.querySelector('[data-test="export-dialog"]')!.textContent).toMatch(
      /solo lectura/
    )
  })
})
