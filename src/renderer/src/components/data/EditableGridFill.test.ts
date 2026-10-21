import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ColumnInfo, QueryColumn } from '@shared/types'
import { useNotify } from '@renderer/composables/useNotify'
import { mockBridge, mountComponent, setupDom } from '../../views/__tests__/helpers'
import EditableGrid from './EditableGrid.vue'
import { rowsFromPage, type EditableRow } from './rowEditing'

const columns: QueryColumn[] = [
  { name: 'id', type: 'INT', primaryKey: true },
  { name: 'country', type: 'VARCHAR' },
  { name: 'status', type: 'STRING' },
  { name: 'born', type: 'DATE' },
  { name: 'calc', type: 'VARCHAR', locked: 'columna calculada' }
]

function info(name: string, columnType: string, nullable: boolean): ColumnInfo {
  return {
    name,
    ordinal: 1,
    columnType,
    dataType: columnType.replace(/\(.*/, ''),
    nullable,
    key: '',
    defaultValue: null,
    extra: '',
    characterSet: null,
    collation: null,
    comment: ''
  }
}

const columnInfo = [
  info('id', 'int', false),
  info('country', 'varchar(255)', true),
  info('status', "enum('Active','Archived')", false),
  info('born', 'date', true),
  info('calc', 'varchar(20)', true)
]

type Wrapper = Awaited<ReturnType<typeof mountComponent>>

describe('EditableGrid: one value into several selected cells', () => {
  let wrapper: Wrapper | null = null
  let rows: EditableRow[] = []

  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })
  afterEach(() => wrapper?.unmount())

  async function mount(extra: Record<string, unknown> = {}) {
    wrapper?.unmount()
    const pinia = setupDom()
    rows = rowsFromPage([
      [1, 'US', 'Active', '2026-01-01', 'x'],
      [2, 'CA', 'Active', null, 'y'],
      [3, 'US', 'Archived', '2026-01-03', 'z']
    ])
    wrapper = await mountComponent(
      EditableGrid,
      { columns, rows, primaryKey: ['id'], sort: null, columnInfo, ...extra },
      pinia
    )
    return wrapper
  }

  const edits = (w: Wrapper) => (w.emitted('edit') ?? []) as unknown[][]
  const selectedCells = (w: Wrapper): string[] =>
    w.findAll('td.cell-selected').map((c) => c.attributes('data-test')!)
  const warnings = () =>
    useNotify()
      .queue.filter((n) => n.level === 'warning')
      .map((n) => n.message)
  const key = (w: Wrapper, k: string, extra: Record<string, unknown> = {}) =>
    w.get('.editable-grid').trigger('keydown', { key: k, ...extra })

  /** Click on `from`, Shift+click on `to`: a rectangle of cells. */
  async function range(w: Wrapper, from: string, to: string): Promise<void> {
    await w.get(`[data-test="cell-${from}"]`).trigger('click')
    await w.get(`[data-test="cell-${to}"]`).trigger('click', { shiftKey: true })
  }

  it('typing over a range of one column writes every cell; the selection stays', async () => {
    const w = await mount()
    await range(w, '0-1', '2-1')
    await key(w, 'H')
    const input = w.get('[data-test="cell-0-1"] [data-test="cell-input"]')
    expect((input.element as HTMLInputElement).value).toBe('H')
    expect(w.get('[data-test="cell-fill"]').text()).toBe('Se aplica a 3 celdas')
    expect(input.attributes('aria-label')).toBe('Editar country en 3 celdas')
    await input.setValue('MX')
    await input.trigger('keydown', { key: 'Enter' })
    expect(edits(w)).toEqual([
      [rows[0].uid, 1, 'MX'],
      [rows[1].uid, 1, 'MX'],
      [rows[2].uid, 1, 'MX']
    ])
    expect(w.find('[data-test="cell-input"]').exists()).toBe(false)
    expect(selectedCells(w)).toEqual(['cell-0-1', 'cell-1-1', 'cell-2-1'])
  })

  it('an untouched editor writes nothing to the selection (Enter, or clicking away)', async () => {
    const w = await mount()
    await range(w, '0-1', '2-1')
    await key(w, 'Enter')
    const input = w.get('[data-test="cell-input"]')
    expect((input.element as HTMLInputElement).value).toBe('US')
    await input.trigger('keydown', { key: 'Enter' })
    await key(w, 'F2')
    await w.get('[data-test="cell-input"]').trigger('blur')
    expect(edits(w)).toEqual([])
  })

  it('leaves out locked columns and deleted rows, and says which cells refused the value', async () => {
    const w = await mount()
    rows[1].deleted = true
    await range(w, '0-1', '2-4')
    await key(w, 'A')
    // Rows 1 and 3 × country, status, born (calc is locked, row 2 deleted).
    expect(w.get('[data-test="cell-fill"]').text()).toBe('Se aplica a 6 celdas')
    const input = w.get('[data-test="cell-input"]')
    await input.setValue('archived')
    await input.trigger('keydown', { key: 'Enter' })
    expect(edits(w)).toEqual([
      [rows[0].uid, 1, 'archived'],
      [rows[0].uid, 2, 'Archived'],
      [rows[2].uid, 1, 'archived']
    ])
    expect(warnings()).toContain(
      'Se cambiaron 3 celdas; 2 celdas no: «archived» no es válido en «born».'
    )
  })

  it('SAFETY: a primary key column never gets one value in several rows', async () => {
    const w = await mount()
    await w.get('[data-test="header-id"]').trigger('click')
    await key(w, '9')
    await w.get('[data-test="cell-input"]').trigger('keydown', { key: 'Enter' })
    expect(edits(w)).toEqual([])
    expect(warnings()).toContain(
      'No se cambió ninguna celda: «id» es clave primaria y no puede repetirse.'
    )
  })

  it('a whole column takes the value, also with no active cell yet', async () => {
    const w = await mount()
    await w.get('[data-test="header-country"]').trigger('click')
    await key(w, 'x')
    expect(w.find('[data-test="cell-0-1"] [data-test="cell-input"]').exists()).toBe(true)
    const input = w.get('[data-test="cell-input"]')
    await input.setValue('xx')
    await input.trigger('keydown', { key: 'Enter' })
    expect(edits(w).map((e) => e[2])).toEqual(['xx', 'xx', 'xx'])
  })

  it('gutter rows or «Seleccionar todo»: only the active cell is edited, and only it stays selected', async () => {
    const w = await mount()
    await w.get('[data-test="cell-0-1"]').trigger('click')
    await w.findAll('[data-test="row-2"] td')[0].trigger('click')
    await key(w, 'Q')
    expect(w.find('[data-test="cell-fill"]').exists()).toBe(false)
    expect(selectedCells(w)).toEqual([])
    // «Eliminar» now works on the edited cell's row, not on the gutter rows.
    expect(w.emitted('update:selected')?.at(-1)?.[0]).toEqual([rows[0].uid])
    const input = w.get('[data-test="cell-0-1"] [data-test="cell-input"]')
    await input.trigger('keydown', { key: 'Enter' })
    expect(edits(w)).toEqual([[rows[0].uid, 1, 'Q']])
  })

  it('ENUM: typing filters the list and Enter writes the value in every selected cell', async () => {
    const w = await mount()
    await range(w, '0-2', '2-2')
    await key(w, 'r')
    await flushPromises()
    const field = w.get('[data-test="enum-input"] input')
    expect((field.element as HTMLInputElement).value).toBe('r')
    const listed = [
      ...document.body.querySelectorAll<HTMLElement>('[data-test="enum-list"] [role="option"]')
    ].map((o) => o.textContent?.trim())
    expect(listed).toEqual(['Archived'])
    await field.trigger('keydown', { key: 'Enter' })
    expect(edits(w)).toEqual([
      [rows[0].uid, 2, 'Archived'],
      [rows[1].uid, 2, 'Archived']
    ])
  })

  it('ENUM: picking the value the edited cell already has still writes it in the others', async () => {
    const w = await mount()
    await range(w, '0-2', '2-2')
    await key(w, 'Enter')
    await flushPromises()
    await w.get('[data-test="enum-input"] input').trigger('keydown', { key: 'Enter' })
    expect(edits(w)).toEqual([[rows[2].uid, 2, 'Active']])
  })

  it('dates: the typed text is checked and normalised, then written in every cell', async () => {
    const w = await mount()
    await range(w, '0-3', '2-3')
    await key(w, '2')
    await flushPromises()
    const field = w.get('[data-test="temporal-input"] input')
    expect((field.element as HTMLInputElement).value).toBe('2')
    await field.setValue('2026-5-1')
    await field.trigger('keydown', { key: 'Enter' })
    expect(edits(w).map((e) => e[2])).toEqual(['2026-05-01', '2026-05-01', '2026-05-01'])
  })

  it('dates: leaving an untouched date editor writes nothing', async () => {
    const w = await mount()
    await range(w, '0-3', '2-3')
    await key(w, 'Enter')
    await flushPromises()
    await w.get('[data-test="temporal-input"] input').trigger('blur')
    await flushPromises()
    expect(edits(w)).toEqual([])
  })

  it('NULL (toolbar) fills the selection where the column allows it', async () => {
    const w = await mount()
    const vm = w.vm as unknown as { fillNull: () => boolean }
    await w.get('[data-test="cell-0-1"]').trigger('click')
    expect(vm.fillNull()).toBe(false)
    await range(w, '0-1', '1-3')
    expect(vm.fillNull()).toBe(true)
    expect(edits(w)).toEqual([
      [rows[0].uid, 1, null],
      [rows[0].uid, 3, null],
      [rows[1].uid, 1, null]
    ])
    expect(warnings()).toContain('Se cambiaron 3 celdas; 2 celdas no: «status» no admite NULL.')
  })

  it('typing on one cell edits it with that character; shortcuts and read-only grids do not', async () => {
    const w = await mount()
    await w.get('[data-test="cell-0-1"]').trigger('click')
    await key(w, 'c', { metaKey: true })
    await key(w, 'c', { ctrlKey: true })
    expect(w.find('[data-test="cell-input"]').exists()).toBe(false)
    await key(w, 'Z')
    const input = w.get('[data-test="cell-input"]')
    const el = input.element as HTMLInputElement
    expect([el.value, el.selectionStart, el.selectionEnd]).toEqual(['Z', 1, 1])
    await input.trigger('keydown', { key: 'Enter' })
    expect(edits(w)).toEqual([[rows[0].uid, 1, 'Z']])
    expect(w.get('[data-test="cell-1-1"]').classes()).toContain('cell-active')
    // Focus is back on the grid: the next character edits the cell below.
    expect(document.activeElement).toBe(w.get('.editable-grid').element)

    const ro = await mount({ readonly: true })
    await ro.get('[data-test="cell-0-1"]').trigger('click')
    await key(ro, 'Z')
    expect(ro.find('[data-test="cell-input"]').exists()).toBe(false)
  })
})

describe('EditableGrid: a foreign key picked for several rows', () => {
  let wrapper: Wrapper | null = null
  afterEach(() => wrapper?.unmount())

  it('writes the chosen key in every selected row', async () => {
    document.body.innerHTML = ''
    const pinia = setupDom()
    mockBridge({
      'db:tableData': () => ({
        columns: [
          { name: 'id', type: 'INT', typeKind: 'integer' },
          { name: 'nombre', type: 'VARCHAR', typeKind: 'text' }
        ],
        rows: [
          [7, 'Ana'],
          [9, 'Luis']
        ],
        primaryKey: ['id'],
        total: 2,
        durationMs: 1
      })
    })
    const rows = rowsFromPage([
      [1, 7],
      [2, null]
    ])
    wrapper = await mountComponent(
      EditableGrid,
      {
        columns: [
          { name: 'id', type: 'INT', primaryKey: true },
          { name: 'cliente_id', type: 'INT' }
        ],
        rows,
        primaryKey: ['id'],
        sort: null,
        columnInfo: [info('id', 'int', false), info('cliente_id', 'int', true)],
        foreignKeys: [
          null,
          { name: 'fk', cols: [1], table: 'clientes', schema: 'tienda', refColumns: ['id'] }
        ],
        connectionId: 'c1'
      },
      pinia
    )
    const w = wrapper
    await w.get('[data-test="cell-0-1"]').trigger('click')
    await w.get('[data-test="cell-1-1"]').trigger('click', { shiftKey: true })
    await w.get('[data-test="cell-0-1"] [data-test="fk-open"]').trigger('click')
    await flushPromises()
    expect(w.findAll('td.cell-selected')).toHaveLength(2)
    const picker = [
      ...document.body.querySelectorAll<HTMLElement>('.v-overlay--active [data-test="fk-picker"]')
    ].at(-1)!
    picker.querySelector<HTMLElement>('[data-test="fk-row-1"]')!.click()
    await flushPromises()
    expect(w.emitted('edit')).toEqual([
      [rows[0].uid, 1, '9'],
      [rows[1].uid, 1, '9']
    ])
  })
})
