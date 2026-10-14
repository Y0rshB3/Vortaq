import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TableDataPage } from '@shared/types'
import { useNotify } from '@renderer/composables/useNotify'
import { useTabsStore } from '@renderer/stores/tabs'
import { useUiStore } from '@renderer/stores/ui'
import TableDataView from '../TableDataView.vue'
import { mockBridge, mountView, openTab, setupDom } from './helpers'

const page: TableDataPage = {
  columns: [
    { name: 'id', type: 'LONG', primaryKey: true },
    { name: 'name', type: 'VAR_STRING' }
  ],
  rows: [
    [1, 'alpha'],
    [2, null]
  ],
  primaryKey: ['id'],
  total: 2,
  durationMs: 12
}

describe('TableDataView', () => {
  let wrapper: Awaited<ReturnType<typeof mountView>> | null = null

  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => wrapper?.unmount())

  it('loads a page and builds the applyRowChanges payload', async () => {
    const pinia = setupDom()
    const invoke = mockBridge({
      'db:tableData': () => structuredClone(page),
      'db:applyRowChanges': (_c, _s, _t, changes) => ({
        applied: (changes as unknown[]).length,
        statements: []
      })
    })
    const tab = openTab({
      kind: 'tableData',
      title: 't',
      connectionId: 'c1',
      schema: 'shop',
      objectName: 'items',
      objectType: 'table'
    })
    wrapper = await mountView(TableDataView, tab, pinia)

    expect(invoke).toHaveBeenCalledWith('db:tableData', 'c1', {
      schema: 'shop',
      table: 'items',
      limit: 1000,
      offset: 0,
      orderBy: null,
      where: null
    })
    expect(wrapper.get('[data-test="cell-0-1"]').text()).toBe('alpha')
    const nullCell = wrapper.get('[data-test="cell-1-1"]')
    expect(nullCell.text()).toBe('(NULL)')
    expect(nullCell.classes()).toContain('cell-null')
    expect(wrapper.get('[data-test="footer"]').text()).toContain('2 en total')

    // Inline edit of the first row
    await wrapper.get('[data-test="cell-0-1"]').trigger('dblclick')
    const input = wrapper.get('[data-test="cell-input"]')
    await input.setValue('beta')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.get('[data-test="cell-0-1"]').classes()).toContain('cell-changed')
    expect(useTabsStore().tabs.find((t) => t.id === tab.id)?.dirty).toBe(true)

    // Delete the second row
    await wrapper.get('[data-test="row-1"] td').trigger('click')
    await wrapper.get('[data-test="delete-rows"]').trigger('click')
    expect(wrapper.get('[data-test="row-1"]').classes()).toContain('row-deleted')

    // Add a row and fill its name
    await wrapper.get('[data-test="add-row"]').trigger('click')
    await wrapper.get('[data-test="cell-2-1"]').trigger('dblclick')
    const newInput = wrapper.get('[data-test="cell-input"]')
    await newInput.setValue('gamma')
    await newInput.trigger('keydown', { key: 'Enter' })

    await wrapper.get('[data-test="apply"]').trigger('click')
    await flushPromises()
    // The batch deletes a row: confirmDestructiveEverywhere (default on) asks first.
    const ui = useUiStore()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.title).toBe('¿Eliminar 1 fila de «items»?')
    expect(ui.confirm.items).toEqual([{ tag: 'DELETE', text: 'id = 2' }])
    ui.answer(true)
    await flushPromises()

    const call = invoke.mock.calls.find((c) => c[0] === 'db:applyRowChanges')
    expect(call).toEqual([
      'db:applyRowChanges',
      'c1',
      'shop',
      'items',
      [
        { kind: 'delete', key: { id: 2 } },
        { kind: 'update', key: { id: 1 }, values: { name: 'beta' } },
        { kind: 'insert', values: { name: 'gamma' } }
      ],
      { confirmProduction: true }
    ])
    // Reloaded after applying: pending changes are gone
    expect(invoke.mock.calls.filter((c) => c[0] === 'db:tableData')).toHaveLength(2)
    expect(useTabsStore().tabs.find((t) => t.id === tab.id)?.dirty).toBe(false)
  })

  it('discards pending edits and sets NULL on the active cell', async () => {
    const pinia = setupDom()
    mockBridge({ 'db:tableData': () => structuredClone(page) })
    const tab = openTab({
      kind: 'tableData',
      title: 't',
      connectionId: 'c1',
      schema: 'shop',
      objectName: 'items',
      objectType: 'table'
    })
    wrapper = await mountView(TableDataView, tab, pinia)

    await wrapper.get('[data-test="cell-0-1"]').trigger('click')
    await wrapper.get('[data-test="set-null"]').trigger('click')
    expect(wrapper.get('[data-test="cell-0-1"]').text()).toBe('(NULL)')
    expect(wrapper.get('[data-test="pending"]').text()).toContain('1')

    await wrapper.get('[data-test="discard"]').trigger('click')
    expect(wrapper.get('[data-test="cell-0-1"]').text()).toBe('alpha')
    expect(wrapper.find('[data-test="pending"]').exists()).toBe(false)
  })

  it('can set an empty string on a NULL cell and applies with Cmd+S while editing', async () => {
    const pinia = setupDom()
    const invoke = mockBridge({
      'db:tableData': () => structuredClone(page),
      'db:applyRowChanges': (_c, _s, _t, changes) => ({
        applied: (changes as unknown[]).length,
        statements: []
      })
    })
    const tab = openTab({
      kind: 'tableData',
      title: 't',
      connectionId: 'c1',
      schema: 'shop',
      objectName: 'items',
      objectType: 'table'
    })
    wrapper = await mountView(TableDataView, tab, pinia)

    // Second row's name is NULL: typing and erasing must store '' rather than keep NULL.
    await wrapper.get('[data-test="cell-1-1"]').trigger('dblclick')
    const input = wrapper.get('[data-test="cell-input"]')
    await input.setValue('x')
    await input.setValue('')
    // Cmd+S from inside the editor commits the cell and applies.
    await input.trigger('keydown', { key: 's', metaKey: true })
    await flushPromises()

    const call = invoke.mock.calls.find((c) => c[0] === 'db:applyRowChanges')
    expect(call?.[4]).toEqual([{ kind: 'update', key: { id: 2 }, values: { name: '' } }])
  })

  it('leaves a NULL cell untouched when it is opened and closed without typing', async () => {
    const pinia = setupDom()
    mockBridge({ 'db:tableData': () => structuredClone(page) })
    const tab = openTab({
      kind: 'tableData',
      title: 't',
      connectionId: 'c1',
      schema: 'shop',
      objectName: 'items',
      objectType: 'table'
    })
    wrapper = await mountView(TableDataView, tab, pinia)
    await wrapper.get('[data-test="cell-1-1"]').trigger('dblclick')
    await wrapper.get('[data-test="cell-input"]').trigger('keydown', { key: 'Enter' })
    expect(wrapper.get('[data-test="cell-1-1"]').text()).toBe('(NULL)')
    expect(wrapper.find('[data-test="pending"]').exists()).toBe(false)
  })

  // Regression: a failed apply showed a raw toast over the grid footer.
  it('shows a failed apply inline, without a toast, and keeps the edits pending', async () => {
    const pinia = setupDom()
    mockBridge({
      'db:tableData': () => structuredClone(page),
      'db:applyRowChanges': () => {
        throw new Error(
          'Falló el cambio 1 de 1 (fila modificada): el valor es demasiado largo para la columna «name». ' +
            'No se aplicó ningún cambio: se deshicieron todos.'
        )
      }
    })
    const tab = openTab({
      kind: 'tableData',
      title: 't',
      connectionId: 'c1',
      schema: 'shop',
      objectName: 'items',
      objectType: 'table'
    })
    wrapper = await mountView(TableDataView, tab, pinia)
    const errorsBefore = useNotify().queue.filter((n) => n.level === 'error').length
    await wrapper.get('[data-test="cell-0-1"]').trigger('dblclick')
    const input = wrapper.get('[data-test="cell-input"]')
    await input.setValue('very long')
    await input.trigger('keydown', { key: 'Enter' })
    await wrapper.get('[data-test="apply"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-test="apply-error"]').text()).toContain(
      'el valor es demasiado largo para la columna «name»'
    )
    expect(wrapper.get('[data-test="cell-0-1"]').classes()).toContain('cell-error')
    expect(wrapper.get('[data-test="pending"]').text()).toContain('1')
    expect(useNotify().queue.filter((n) => n.level === 'error')).toHaveLength(errorsBefore)

    await wrapper.get('[data-test="apply-error-locate"]').trigger('click')
    expect(wrapper.get('[data-test="row-0"]').classes()).toContain('row-selected')
    await wrapper.get('[data-test="discard"]').trigger('click')
    expect(wrapper.find('[data-test="apply-error"]').exists()).toBe(false)
  })

  it('shows an actionable error when the page cannot be loaded', async () => {
    const pinia = setupDom()
    mockBridge({
      'db:tableData': () => {
        throw new Error("Unknown column 'x' in 'where clause' (ER_BAD_FIELD_ERROR 1054)")
      }
    })
    const tab = openTab({
      kind: 'tableData',
      title: 't',
      connectionId: 'c1',
      schema: 'shop',
      objectName: 'items',
      objectType: 'table'
    })
    wrapper = await mountView(TableDataView, tab, pinia)
    expect(wrapper.text()).toContain('No se pudieron cargar los datos')
    expect(wrapper.text()).toContain('ER_BAD_FIELD_ERROR')
  })

  it('«Exportar» runs the table SELECT again with its sort, without paging; columns never feed «Eliminar»', async () => {
    const pinia = setupDom()
    const invoke = mockBridge({
      'db:tableData': () => structuredClone(page),
      'app:pickSaveFile': () => '/tmp/x/items.csv',
      'export:query': () => ({
        filePath: '/tmp/x/items.csv',
        rows: 2,
        bytes: 1,
        durationMs: 1,
        truncatedCells: 0
      })
    })
    const tab = openTab({
      kind: 'tableData',
      title: 't',
      connectionId: 'c1',
      schema: 'shop',
      objectName: 'items',
      objectType: 'table'
    })
    wrapper = await mountView(TableDataView, tab, pinia)
    // Sorting moved to the header arrow (and the header menu).
    await wrapper.get('[data-test="sort-name"]').trigger('click')
    await flushPromises()
    expect(invoke).toHaveBeenLastCalledWith(
      'db:tableData',
      'c1',
      expect.objectContaining({ orderBy: { column: 'name', direction: 'ASC' } })
    )
    // A header click selects the column: «Eliminar» stays disabled.
    await wrapper.get('[data-test="row-0"] td').trigger('click')
    expect(wrapper.get('[data-test="delete-rows"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-test="header-name"]').trigger('click')
    expect(wrapper.get('[data-test="delete-rows"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-test="export"]').trigger('click')
    await flushPromises()
    // The table view offers the whole table by default.
    expect(
      (document.body.querySelector('[data-test="export-scope-full"] input') as HTMLInputElement)
        .checked
    ).toBe(true)
    document.body.querySelector<HTMLElement>('[data-test="export-run"]')!.click()
    await flushPromises()
    const call = invoke.mock.calls.find((c) => c[0] === 'export:query')!
    expect(call[2]).toMatchObject({
      connectionId: 'c1',
      source: {
        kind: 'table',
        request: { schema: 'shop', table: 'items', orderBy: { column: 'name', direction: 'ASC' } }
      },
      options: { format: 'csv', table: 'items' }
    })
    expect((call[2] as { source: { request: object } }).source.request).not.toHaveProperty('limit')
  })
})
