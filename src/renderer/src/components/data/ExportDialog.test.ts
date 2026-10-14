import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QueryColumn } from '@shared/types'
import { mockBridge, mountComponent, setupDom } from '../../views/__tests__/helpers'
import ExportDialog from './ExportDialog.vue'
import { rowsFromPage } from './rowEditing'

const columns: QueryColumn[] = [
  { name: 'id', type: 'INT' },
  { name: 'nombre', type: 'VARCHAR', sourceName: 'name' }
]

type Wrapper = Awaited<ReturnType<typeof mountComponent>>
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)

describe('ExportDialog', () => {
  let wrapper: Wrapper | null = null
  let invoke: ReturnType<typeof mockBridge>
  let saveAs = '/tmp/x/ventas.sql'

  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
    saveAs = '/tmp/x/ventas.sql'
  })
  afterEach(() => wrapper?.unmount())

  async function mount(extra: Record<string, unknown> = {}) {
    const pinia = setupDom()
    invoke = mockBridge({
      'app:pickSaveFile': () => saveAs,
      'export:rows': (request: unknown) => ({
        filePath: (request as { filePath: string }).filePath,
        rows: 1,
        bytes: 1,
        durationMs: 1,
        truncatedCells: 0
      })
    })
    const rows = rowsFromPage([
      [1, 'a'],
      [2, 'b'],
      [3, 'c']
    ])
    wrapper = await mountComponent(
      ExportDialog,
      {
        modelValue: true,
        connectionId: 'c1',
        columns,
        rows,
        selection: { rowUids: [rows[2].uid], cols: [1] },
        copy: {
          dialect: 'postgresql',
          table: 'ventas',
          keyColumns: ['id'],
          sqlNames: ['id', 'name']
        },
        fullSource: null,
        fullReason: 'Solo se puede exportar completo una consulta.',
        baseName: 'ventas',
        scope: 'selection',
        ...extra
      },
      pinia
    )
    await flushPromises()
    return wrapper
  }

  it('exports the selection as SQL with the source table, real names and the batch size', async () => {
    await mount()
    $('[data-test="export-format-sql"]')!.click()
    await flushPromises()
    expect(($('[data-test="export-table"] input') as HTMLInputElement).value).toBe('ventas')
    $('[data-test="export-run"]')!.click()
    await flushPromises()
    const save = invoke.mock.calls.find((c) => c[0] === 'app:pickSaveFile')!
    expect(save[2]).toBe('ventas.sql')
    const request = invoke.mock.calls.find((c) => c[0] === 'export:rows')![1] as {
      rows: unknown[][]
      columns: { name: string }[]
      options: Record<string, unknown>
    }
    expect(request.rows).toEqual([['c']])
    expect(request.columns.map((c) => c.name)).toEqual(['nombre'])
    expect(request.options).toMatchObject({
      format: 'sql',
      table: 'ventas',
      dialect: 'postgresql',
      sqlNames: ['name'],
      batchSize: 100
    })
    // Remembered for next time (without the table).
    expect(JSON.parse(localStorage.getItem('electrondb.exportOptions')!)).toMatchObject({
      format: 'sql'
    })
  })

  it('the full result is disabled with the reason; cancelling the save dialog writes nothing', async () => {
    saveAs = ''
    await mount({ scope: 'full' })
    expect(($('[data-test="export-scope-full"] input') as HTMLInputElement).disabled).toBe(true)
    expect($('[data-test="export-dialog"]')!.textContent).toContain(
      'Solo se puede exportar completo una consulta.'
    )
    $('[data-test="export-run"]')!.click()
    await flushPromises()
    expect(invoke.mock.calls.some((c) => c[0] === 'export:rows')).toBe(false)
  })

  it('format options: CSV separator and BOM, JSON shape, Excel note', async () => {
    await mount()
    expect($('[data-test="export-delimiter"]')).not.toBeNull()
    expect($('[data-test="export-bom"]')).not.toBeNull()
    $('[data-test="export-format-json"]')!.click()
    await flushPromises()
    expect($('[data-test="export-delimiter"]')).toBeNull()
    expect($('[data-test="export-options"]')!.textContent).toContain('Objetos')
    $('[data-test="export-format-xlsx"]')!.click()
    await flushPromises()
    expect($('[data-test="export-options"]')!.textContent).toContain('15 cifras')
  })
})
