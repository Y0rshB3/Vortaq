import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultExportOptions, type ExportColumn } from '@shared/export/types'
import { XLSX_MAX_CELL_CHARS } from '@shared/export/xlsx'
import type { CellValue } from '@shared/types'
import { unzip } from './testing/unzip'
import { CANCELLED_EXPORT, arrayBatches, writeExport, type RowBatch } from './writer'

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const columns: ExportColumn[] = [
  { name: 'id', type: 'INT' },
  { name: 'name', type: 'VARCHAR' },
  { name: 'total', type: 'DECIMAL' }
]
const rows: CellValue[][] = [
  [1, 'ñandú 😀', '12.50'],
  [2, 'a,b\n"c"', null]
]

describe('writeExport', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-export-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes CSV through a part file and renames it only when complete', async () => {
    const file = join(dir, 'out.csv')
    writeFileSync(file, 'old content')
    const result = await writeExport(
      file,
      columns,
      arrayBatches(rows),
      defaultExportOptions({ format: 'csv', bom: true })
    )
    expect(result.rows).toBe(2)
    const text = readFileSync(file, 'utf8')
    expect(text).toBe('﻿id,name,total\r\n1,ñandú 😀,12.50\r\n2,"a,b\n""c""",\r\n')
    expect(result.bytes).toBe(Buffer.byteLength(text))
    expect(readdirSync(dir)).toEqual(['out.csv'])
  })

  it('a failure keeps the previous file and deletes the part file', async () => {
    const file = join(dir, 'out.json')
    writeFileSync(file, 'previous')
    async function* failing(): AsyncGenerator<RowBatch> {
      yield { rows: [[1, 'a', '1']] }
      throw new Error('server went away')
    }
    await expect(
      writeExport(file, columns, failing(), defaultExportOptions({ format: 'json' }))
    ).rejects.toThrow('server went away')
    expect(readFileSync(file, 'utf8')).toBe('previous')
    expect(readdirSync(dir)).toEqual(['out.json'])
  })

  it('a cancel stops between batches and leaves no file', async () => {
    const file = join(dir, 'out.sql')
    const controller = new AbortController()
    async function* endless(): AsyncGenerator<RowBatch> {
      for (let i = 0; ; i++) {
        if (i === 3) controller.abort()
        yield { rows: [[i, 'x', '1']] }
      }
    }
    await expect(
      writeExport(file, columns, endless(), defaultExportOptions({ format: 'sql', table: 't' }), {
        signal: controller.signal
      })
    ).rejects.toThrow(CANCELLED_EXPORT)
    expect(readdirSync(dir)).toEqual([])
  })

  it('writes every text format', async () => {
    for (const format of ['json', 'sql', 'markdown', 'html', 'txt'] as const) {
      const file = join(dir, `out.${format}`)
      await writeExport(
        file,
        columns,
        arrayBatches(rows),
        defaultExportOptions({ format, table: 't' })
      )
      expect(existsSync(file), format).toBe(true)
    }
    expect(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'))).toEqual([
      { id: 1, name: 'ñandú 😀', total: '12.50' },
      { id: 2, name: 'a,b\n"c"', total: null }
    ])
    expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe(
      'id\tname\ttotal\r\n1\tñandú 😀\t12.50\r\n2\t"a,b\n""c"""\t\r\n'
    )
  })

  it('writes a valid .xlsx package: every part parses, the sheet is deflated', async () => {
    const file = join(dir, 'out.xlsx')
    const many: CellValue[][] = Array.from({ length: 3000 }, (_, i) => [
      i,
      i === 5 ? '=1+1' : i === 6 ? 'x'.repeat(XLSX_MAX_CELL_CHARS + 1) : `fila ${i} \u0001`,
      i % 2 ? '1234567890.12' : null
    ])
    const result = await writeExport(
      file,
      columns,
      arrayBatches(many, undefined, 700),
      defaultExportOptions({ format: 'xlsx', sheetName: 'Ventas' })
    )
    expect(result.rows).toBe(3000)
    expect(result.truncatedCells).toBe(1)
    expect(readdirSync(dir)).toEqual(['out.xlsx'])
    const entries = unzip(file)
    expect([...entries.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml'
    ])
    expect(entries.get('xl/worksheets/sheet1.xml')!.method).toBe(8)
    for (const entry of entries.values()) {
      const errors: string[] = []
      const doc = new DOMParser({
        onError: (level, message) => {
          if (level !== 'warning') errors.push(message)
        }
      }).parseFromString(entry.data.toString('utf8'), 'text/xml')
      expect(errors, entry.name).toEqual([])
      if (entry.name === 'xl/worksheets/sheet1.xml') {
        expect(doc.getElementsByTagNameNS(NS, 'row').length).toBe(3001)
        expect(doc.getElementsByTagNameNS(NS, 'f').length).toBe(0)
      }
      if (entry.name === 'xl/workbook.xml')
        expect(entry.data.toString('utf8')).toContain('name="Ventas"')
    }
  })

  it('refuses Excel exports with too many columns before writing', async () => {
    const wide = Array.from({ length: 16_385 }, (_, i) => ({ name: `c${i}` }))
    await expect(
      writeExport(
        join(dir, 'w.xlsx'),
        wide,
        arrayBatches([]),
        defaultExportOptions({ format: 'xlsx' })
      )
    ).rejects.toThrow(/CSV/)
    expect(readdirSync(dir)).toEqual([])
  })
})
