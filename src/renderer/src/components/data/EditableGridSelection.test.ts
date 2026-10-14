import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryColumn } from '@shared/types'
import { mountComponent, setupDom } from '../../views/__tests__/helpers'
import EditableGrid from './EditableGrid.vue'
import type { CopyContext } from './gridCopy'
import { rowsFromPage } from './rowEditing'

const columns: QueryColumn[] = [
  { name: 'id', type: 'INT', primaryKey: true },
  { name: 'name', type: 'VARCHAR' },
  { name: 'total', type: 'DECIMAL' }
]
const copy: CopyContext = { dialect: 'mysql', table: 'orders', keyColumns: ['id'] }

type Wrapper = Awaited<ReturnType<typeof mountComponent>>

/** Element in the open overlay (menus are teleported to the body). */
function overlay(selector: string): HTMLElement | null {
  const items = [...document.body.querySelectorAll<HTMLElement>(selector)]
  return items.at(-1) ?? null
}

describe('EditableGrid selection, copy and menus', () => {
  let wrapper: Wrapper | null = null
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
    writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  })
  afterEach(() => wrapper?.unmount())

  async function mount(extra: Record<string, unknown> = {}) {
    const pinia = setupDom()
    wrapper = await mountComponent(
      EditableGrid,
      {
        columns,
        rows: rowsFromPage([
          [1, 'ana', '1.50'],
          [2, "o'k", null],
          [3, 'luis', '2.00']
        ]),
        primaryKey: ['id'],
        sort: null,
        copy,
        exportable: true,
        ...extra
      },
      pinia
    )
    return wrapper
  }

  const lastSelected = (w: Wrapper): string[] =>
    ((w.emitted('update:selected') ?? []).at(-1)?.[0] as string[] | undefined) ?? []
  const selectedCells = (w: Wrapper): string[] =>
    w.findAll('td.cell-selected').map((c) => c.attributes('data-test')!)

  it('a header click selects the whole column; it no longer sorts', async () => {
    const w = await mount()
    await w.get('[data-test="header-name"]').trigger('click')
    expect(selectedCells(w)).toEqual(['cell-0-1', 'cell-1-1', 'cell-2-1'])
    expect(w.get('[data-test="header-name"]').classes()).toContain('col-selected')
    expect(w.emitted('sort')).toBeUndefined()
    // Shift extends, Cmd/Ctrl adds.
    await w.get('[data-test="header-total"]').trigger('click', { shiftKey: true })
    expect(selectedCells(w)).toHaveLength(6)
    await w.get('[data-test="header-id"]').trigger('click', { metaKey: true })
    expect(selectedCells(w)).toHaveLength(9)
  })

  it('the arrow button inside the header sorts', async () => {
    const w = await mount({ sort: { column: 'name', direction: 'ASC' } })
    expect(w.get('[data-test="sort-name"]').classes()).toContain('is-sorted')
    expect(w.get('[data-test="sort-id"]').classes()).not.toContain('is-sorted')
    await w.get('[data-test="sort-id"]').trigger('click')
    expect(w.emitted('sort')).toEqual([['id']])
    // The arrow click does not select the column.
    expect(selectedCells(w)).toEqual([])
  })

  it('Cmd/Ctrl+C copies the selection as tab-separated text', async () => {
    const w = await mount()
    await w.get('[data-test="cell-0-1"]').trigger('click')
    await w.get('[data-test="cell-1-2"]').trigger('click', { shiftKey: true })
    await w.get('.editable-grid').trigger('keydown', { key: 'c', metaKey: true })
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith("ana\t1.50\no'k\t")
    // With Shift: with the header line.
    await w.get('.editable-grid').trigger('keydown', { key: 'C', ctrlKey: true, shiftKey: true })
    await flushPromises()
    expect(writeText).toHaveBeenLastCalledWith("name\ttotal\nana\t1.50\no'k\t")
  })

  it('typing in the cell editor keeps its own copy', async () => {
    const w = await mount()
    await w.get('[data-test="cell-0-1"]').trigger('dblclick')
    await w.get('[data-test="cell-input"]').trigger('keydown', { key: 'c', metaKey: true })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('SAFETY: a column selection or select-all never marks rows for deletion', async () => {
    const w = await mount()
    // Gutter rows are the rows «Eliminar» works on.
    await w.get('[data-test="row-0"] td.col-index').trigger('click')
    await w.get('[data-test="row-2"] td.col-index').trigger('click', { shiftKey: true })
    expect(lastSelected(w)).toHaveLength(3)
    // A column selection clears them.
    await w.get('[data-test="header-name"]').trigger('click')
    expect(lastSelected(w)).toEqual([])
    // Select all (Cmd+A and the # corner) clears them too.
    await w.get('[data-test="row-1"] td.col-index').trigger('click')
    expect(lastSelected(w)).toHaveLength(1)
    await w.get('.editable-grid').trigger('keydown', { key: 'a', metaKey: true })
    expect(lastSelected(w)).toEqual([])
    expect(selectedCells(w)).toHaveLength(9)
    await w.get('[data-test="row-1"] td.col-index').trigger('click')
    await w.get('[data-test="select-all"]').trigger('click')
    expect(lastSelected(w)).toEqual([])
    // A cell range only targets the active cell's row, as a plain click did.
    await w.get('[data-test="cell-0-0"]').trigger('click')
    await w.get('[data-test="cell-2-2"]').trigger('click', { shiftKey: true })
    expect(lastSelected(w)).toHaveLength(1)
    // Escape goes back to the active cell.
    await w.get('.editable-grid').trigger('keydown', { key: 'Escape' })
    expect(selectedCells(w)).toEqual([])
  })

  it('drag selects a rectangle', async () => {
    const w = await mount()
    await w.get('[data-test="cell-0-0"]').trigger('mousedown', { button: 0 })
    await w.get('[data-test="cell-1-1"]').trigger('mouseenter')
    window.dispatchEvent(new MouseEvent('mouseup'))
    expect(selectedCells(w)).toEqual(['cell-0-0', 'cell-0-1', 'cell-1-0', 'cell-1-1'])
    await w.get('[data-test="cell-2-2"]').trigger('mouseenter')
    expect(selectedCells(w)).toHaveLength(4)
  })

  it('header menu: copy formats, export and sort items', async () => {
    const w = await mount({ sort: { column: 'name', direction: 'ASC' } })
    await w.get('[data-test="header-name"]').trigger('contextmenu')
    await flushPromises()
    expect(overlay('[data-test="menu-copy"]')).not.toBeNull()
    expect(overlay('[data-test="menu-copy-as"]')).not.toBeNull()
    expect(overlay('[data-test="menu-export-selection"]')).not.toBeNull()
    expect(overlay('[data-test="menu-sort-asc"]')?.classList).toContain('v-list-item--disabled')
    overlay('[data-test="menu-sort-desc"]')!.click()
    await flushPromises()
    expect(w.emitted('sort')).toEqual([['name', 'DESC']])
  })

  it('«Copiar como» INSERT uses the source table', async () => {
    const w = await mount()
    await w.get('[data-test="cell-1-0"]').trigger('contextmenu')
    await flushPromises()
    // The submenu opens on hover and on click (keyboard and touch).
    overlay('[data-test="menu-copy-as"]')!.click()
    await flushPromises()
    const insert = overlay('[data-test="menu-copy-insert"]')
    expect(insert).not.toBeNull()
    insert!.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('INSERT INTO `orders` (`id`) VALUES (2);\n')
  })

  it('export items ask the parent to open its dialog', async () => {
    const w = await mount()
    await w.get('[data-test="cell-0-0"]').trigger('contextmenu')
    await flushPromises()
    overlay('[data-test="menu-export-all"]')!.click()
    await flushPromises()
    expect(w.emitted('export')).toEqual([['all']])
    const snapshot = (
      w.vm as unknown as { selectionSnapshot(): { rowUids: string[]; cols: number[] } }
    ).selectionSnapshot()
    expect(snapshot.cols).toEqual([0])
    expect(snapshot.rowUids).toHaveLength(1)
  })
})
