import { describe, expect, it } from 'vitest'
import type { QueryColumn } from '@shared/types'
import { allData, copyText, regionData, type CopyContext } from './gridCopy'
import { rowsFromPage, setCell } from './rowEditing'

const columns: QueryColumn[] = [
  { name: 'id', type: 'INT', primaryKey: true },
  { name: 'name', type: 'VARCHAR' },
  { name: 'total', type: 'DECIMAL' }
]
const rows = rowsFromPage([
  [1, 'ana', '1.50'],
  [2, "o'k\tx", null],
  [3, 'luis', '2.00']
])
const ctx: CopyContext = { dialect: 'mysql', table: 'orders', keyColumns: ['id'] }

describe('grid copy', () => {
  it('takes the region in display order, with pending edits as shown', () => {
    const edited = rowsFromPage([
      [1, 'ana', '1.50'],
      [2, 'b', null]
    ])
    setCell(edited[1], 1, 'nuevo')
    expect(regionData(columns, edited, { rows: [1], cols: [1, 2] }).rows).toEqual([['nuevo', null]])
  })

  it('Copiar: TSV without header, NULL empty, tabs quoted, no trailing line break', () => {
    const out = copyText('tsv', regionData(columns, rows, { rows: [0, 1], cols: [0, 1, 2] }), ctx)
    expect(out.text).toBe('1\tana\t1.50\n2\t"o\'k\tx"\t')
    expect(out.message).toBe('2 filas copiadas')
    expect(copyText('tsv', regionData(columns, rows, { rows: [2], cols: [1] }), ctx)).toMatchObject(
      {
        text: 'luis',
        message: 'Celda copiada'
      }
    )
  })

  it('Copiar con encabezados', () => {
    const out = copyText('tsv', regionData(columns, rows, { rows: [0], cols: [0, 1] }), ctx, {
      header: true
    })
    expect(out.text).toBe('id\tname\n1\tana')
  })

  it('INSERT uses the source table and real column names', () => {
    const out = copyText(
      'insert',
      regionData(columns, rows, { rows: [1], cols: [0, 1] }, ['id', 'nombre', 'total']),
      ctx
    )
    expect(out.text).toBe("INSERT INTO `orders` (`id`, `nombre`) VALUES (2, 'o\\'k\tx');\n")
    expect(out.message).toBe('1 fila copiada como INSERT')
  })

  it('INSERT without a single source table uses a placeholder name', () => {
    const out = copyText('insert', allData(columns, rows), {
      ...ctx,
      table: null,
      dialect: 'postgresql'
    })
    expect(out.text.startsWith('INSERT INTO nombre_tabla (id, name, total) VALUES')).toBe(true)
  })

  it('UPDATE sets the selected columns by the key even when the key is not selected', () => {
    const region = { rows: [0, 2], cols: [2] }
    const out = copyText(
      'update',
      regionData(columns, rows, region),
      ctx,
      {},
      { columns, rows, region }
    )
    expect(out.text).toBe(
      'UPDATE `orders` SET `total` = 1.50 WHERE `id` = 1;\nUPDATE `orders` SET `total` = 2.00 WHERE `id` = 3;\n'
    )
    const noKey = copyText(
      'update',
      regionData(columns, rows, region),
      { ...ctx, keyColumns: [] },
      {},
      {
        columns,
        rows,
        region
      }
    )
    expect(noKey.warning).toMatch(/clave primaria/)
    const onlyKey = { rows: [0], cols: [0] }
    expect(
      copyText(
        'update',
        regionData(columns, rows, onlyKey),
        ctx,
        {},
        { columns, rows, region: onlyKey }
      ).warning
    ).toMatch(/no sea de la clave/)
  })

  it('IN list explains NULL handling', () => {
    const out = copyText('in', regionData(columns, rows, { rows: [0, 1, 2], cols: [2] }), ctx)
    expect(out.text).toBe('(1.50, 2.00)')
    expect(out.message).toMatch(/2 valores.*1 NULL omitido.*IS NULL/)
  })

  it('CSV, JSON and Markdown', () => {
    const data = regionData(columns, rows, { rows: [1], cols: [0, 1, 2] })
    expect(copyText('csv', data, ctx).text).toBe("id,name,total\n2,o'k\tx,\n")
    expect(JSON.parse(copyText('json', data, ctx).text)).toEqual([
      { id: 2, name: "o'k\tx", total: null }
    ])
    expect(copyText('markdown', data, ctx).text).toBe(
      "| id | name | total |\n| ---: | --- | ---: |\n| 2 | o'k\tx | NULL |\n"
    )
  })
})
