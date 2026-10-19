import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TableDataPage, TableDataRequest } from '@shared/types'
import { mockBridge, mountComponent, setupDom } from '../../views/__tests__/helpers'
import ForeignKeyPicker from './ForeignKeyPicker.vue'
import type { GridForeignKey } from './foreignKeys'

type Wrapper = Awaited<ReturnType<typeof mountComponent>>

const fk: GridForeignKey = {
  name: 'fk_cliente',
  cols: [2],
  table: 'clientes',
  schema: 'tienda',
  refColumns: ['id']
}
const page = (
  rows: (string | number | null)[][],
  total: number | null = rows.length
): TableDataPage => ({
  columns: [
    { name: 'nombre', type: 'VARCHAR', typeKind: 'text' },
    { name: 'id', type: 'INT', typeKind: 'integer', primaryKey: true },
    { name: 'foto', type: 'BLOB', typeKind: 'binary' }
  ],
  rows,
  primaryKey: ['id'],
  total,
  durationMs: 1
})

describe('ForeignKeyPicker', () => {
  let wrapper: Wrapper | null = null
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })
  afterEach(() => wrapper?.unmount())

  async function mount(handler: (req: TableDataRequest) => TableDataPage, extra = {}) {
    const pinia = setupDom()
    const invoke = mockBridge({ 'db:tableData': (_c, req) => handler(req as TableDataRequest) })
    wrapper = await mountComponent(
      ForeignKeyPicker,
      { connectionId: 'c1', fk, current: ['2'], nullable: false, ...extra },
      pinia
    )
    return { w: wrapper, invoke }
  }
  const emitted = (w: Wrapper, name: string) => (w.emitted(name) ?? []) as unknown[][]

  it('reads the referenced table ordered by its key, key columns first, the current row marked', async () => {
    const { w, invoke } = await mount(() =>
      page([
        ['Ana', 1, null],
        ['Luis', 2, 'ff']
      ])
    )
    expect(invoke).toHaveBeenCalledWith('db:tableData', 'c1', {
      schema: 'tienda',
      table: 'clientes',
      limit: 50,
      offset: 0,
      orderBy: { column: 'id', direction: 'ASC' }
    })
    expect(w.findAll('th').map((t) => t.text())).toEqual(['', 'id', 'nombre', 'foto'])
    expect(w.get('[data-test="fk-row-1"]').classes()).toContain('is-current')
    expect(w.get('[data-test="fk-row-1"]').classes()).toContain('is-highlighted')
    expect(w.get('[data-test="fk-count"]').text()).toBe('2 de 2')
    expect(w.find('[data-test="fk-null"]').exists()).toBe(false)
  })

  it('a click chooses the row: its key values, as text', async () => {
    const { w } = await mount(() => page([['Ana', 1, null]]))
    await w.get('[data-test="fk-row-0"]').trigger('click')
    expect(emitted(w, 'choose')).toEqual([[['1']]])
  })

  it('searches with a structured filter (escaped by main), never raw SQL', async () => {
    vi.useFakeTimers()
    const requests: TableDataRequest[] = []
    const { w } = await mount((req) => {
      requests.push(req)
      return page(
        req.filter
          ? [['Ana', 1, null]]
          : [
              ['Ana', 1, null],
              ['Luis', 2, null]
            ]
      )
    })
    await w.get('[data-test="fk-search"]').setValue("an'a")
    vi.advanceTimersByTime(300)
    await flushPromises()
    const last = requests.at(-1)!
    expect(last.where).toBeUndefined()
    expect(last.filter?.children.map((c) => (c.kind === 'condition' ? c.column : ''))).toEqual([
      'id',
      'nombre'
    ])
    expect(last.filter?.children[0]).toMatchObject({ operator: 'contains', values: ["an'a"] })
    expect(w.findAll('[data-test^="fk-row-"]')).toHaveLength(1)
  })

  it('keyboard: ↓ then Enter chooses; Enter right after typing searches first; Escape closes', async () => {
    vi.useFakeTimers()
    const { w, invoke } = await mount(() =>
      page([
        ['Ana', 1, null],
        ['Luis', 2, null],
        ['Eva', 3, null]
      ])
    )
    const search = w.get('[data-test="fk-search"]')
    await search.trigger('keydown', { key: 'ArrowDown' })
    await search.trigger('keydown', { key: 'Enter' })
    expect(emitted(w, 'choose')).toEqual([[['3']]])
    const before = invoke.mock.calls.length
    await search.setValue('eva')
    await search.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(invoke.mock.calls.length).toBe(before + 1)
    expect(emitted(w, 'choose')).toHaveLength(1)
    await search.trigger('keydown', { key: 'Escape' })
    expect(emitted(w, 'close')).toHaveLength(1)
  })

  it('«Cargar más» appends the next page; NULL is offered on nullable keys', async () => {
    const all = Array.from(
      { length: 60 },
      (_, i) => [`n${i}`, i, null] as (string | number | null)[]
    )
    const { w } = await mount((req) => page(all.slice(req.offset, req.offset + req.limit), 60), {
      nullable: true
    })
    expect(w.findAll('[data-test^="fk-row-"]')).toHaveLength(50)
    await w.get('[data-test="fk-more"]').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-test^="fk-row-"]')).toHaveLength(60)
    expect(w.find('[data-test="fk-more"]').exists()).toBe(false)
    await w.get('[data-test="fk-null"]').trigger('click')
    expect(emitted(w, 'choose')).toEqual([[[null]]])
  })

  it('shows the read error inline', async () => {
    const { w } = await mount(() => {
      throw new Error('Table clientes does not exist')
    })
    expect(w.get('[data-test="fk-error"]').text()).toMatch(/clientes does not exist/)
  })
})
