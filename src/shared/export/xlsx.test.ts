import { DOMParser, type Document } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { formatRows } from './formats'
import type { ExportColumn } from './types'
import {
  XLSX_MAX_CELL_CHARS,
  XLSX_MAX_ROWS,
  columnLetters,
  excelNumber,
  sheetName,
  significantDigits,
  stripIllegalXml,
  xlsxSheetFormatter,
  xlsxStaticParts
} from './xlsx'

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

function parse(xml: string): Document {
  const errors: string[] = []
  const doc = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') errors.push(message)
    }
  }).parseFromString(xml, 'text/xml')
  expect(errors).toEqual([])
  return doc
}

describe('xlsx helpers', () => {
  it('column letters', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702, 16383].map(columnLetters)).toEqual([
      'A',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
      'XFD'
    ])
  })

  it('numbers: up to 15 significant digits, otherwise text', () => {
    expect(significantDigits('123456789012345')).toBe(15)
    expect(significantDigits('0.000123')).toBe(3)
    expect(significantDigits('1200')).toBe(4)
    expect(significantDigits('12.500')).toBe(3)
    expect(excelNumber(42)).toBe('42')
    expect(excelNumber('-12.50')).toBe('-12.50')
    expect(excelNumber('.5')).toBe('0.5')
    expect(excelNumber('1234567890123456')).toBeNull()
    expect(excelNumber('18446744073709551615')).toBeNull()
    expect(excelNumber('12abc')).toBeNull()
    expect(excelNumber(Infinity)).toBeNull()
    expect(excelNumber('0x10')).toBeNull()
  })

  it('strips characters XML 1.0 forbids and lone surrogates', () => {
    expect(stripIllegalXml('a\u0000b\u0007c\td\ne\u000Bf\uFFFEg')).toBe('abc\td\nefg')
    expect(stripIllegalXml('x\uD800y😀z\uDC00')).toBe('xy😀z')
  })

  it('sheet names follow Excel rules', () => {
    expect(sheetName('ventas/2026:[q1]?')).toBe('ventas 2026  q1')
    expect(sheetName('')).toBe('Resultado')
    expect(sheetName("'x'")).toBe('x')
    expect(sheetName('a'.repeat(40))).toHaveLength(31)
  })
})

describe('worksheet XML', () => {
  const cols: ExportColumn[] = [
    { name: 'id', type: 'BIGINT' },
    { name: 'formula', type: 'VARCHAR' },
    { name: 'amount', type: 'DECIMAL' },
    { name: 'note', type: 'TEXT' }
  ]

  it('is well-formed: numbers in numeric columns, inline strings elsewhere, never formulas', () => {
    const sheet = xlsxSheetFormatter(cols, { header: true, nullText: '' })
    const xml = formatRows(sheet, [
      [1, '=HYPERLINK("http://x")', '12.50', 'a\u0001b <&> "q" _x0041_'],
      ['12345678901234567890', '+1', '1234567890.1234567', null]
    ])
    const doc = parse(xml)
    const rows = doc.getElementsByTagNameNS(NS, 'row')
    expect(rows.length).toBe(3)
    expect(doc.getElementsByTagNameNS(NS, 'f').length).toBe(0)
    expect(doc.getElementsByTagNameNS(NS, 'pane')[0].getAttribute('state')).toBe('frozen')
    // Header: bold style 1.
    const header = rows[0].getElementsByTagNameNS(NS, 'c')
    expect(header[0].getAttribute('s')).toBe('1')
    expect(header[0].textContent).toBe('id')
    const first = rows[1].getElementsByTagNameNS(NS, 'c')
    expect(first[0].getAttribute('t')).toBeNull()
    expect(first[0].textContent).toBe('1')
    expect(first[1].getAttribute('t')).toBe('inlineStr')
    expect(first[1].textContent).toBe('=HYPERLINK("http://x")')
    expect(first[2].textContent).toBe('12.50')
    expect(first[3].textContent).toBe('ab <&> "q" _x005F_x0041_')
    const second = rows[2].getElementsByTagNameNS(NS, 'c')
    // Too many digits for Excel: kept exact as text.
    expect(second[0].getAttribute('t')).toBe('inlineStr')
    expect(second[2].getAttribute('t')).toBe('inlineStr')
    // NULL: no cell at all.
    expect(second.length).toBe(3)
    expect(sheet.stats).toEqual({ rows: 2, truncatedCells: 0 })
  })

  it('cuts cells over 32.767 characters and counts them', () => {
    const sheet = xlsxSheetFormatter([cols[3]], { header: false, nullText: 'NULL' })
    const xml = formatRows(sheet, [['x'.repeat(XLSX_MAX_CELL_CHARS + 10)], [null]])
    const doc = parse(xml)
    const cells = doc.getElementsByTagNameNS(NS, 'c')
    expect(cells[0].textContent).toHaveLength(XLSX_MAX_CELL_CHARS)
    expect(cells[1].textContent).toBe('NULL')
    expect(sheet.stats.truncatedCells).toBe(1)
  })

  it('the cut keeps the escaped text within the limit and never splits an escape', () => {
    const sheet = xlsxSheetFormatter([cols[3]], { header: false, nullText: '' })
    // Each `_x0041_` grows by 6 characters once protected (`_x005F_x0041_`).
    const value = '_x0041_'.repeat(Math.ceil(XLSX_MAX_CELL_CHARS / 7))
    const doc = parse(formatRows(sheet, [[value]]))
    const raw = doc.getElementsByTagNameNS(NS, 'c')[0].textContent ?? ''
    expect(raw.length).toBeLessThanOrEqual(XLSX_MAX_CELL_CHARS)
    expect(raw.replace(/_x005F_x0041_/g, '')).toMatch(/^(_x0041?|_x00?|_x0?|_x?|_?)$/)
    expect(sheet.stats.truncatedCells).toBe(1)
  })

  it('SQLite cells without a declared type are numbers by their storage class', () => {
    const sheet = xlsxSheetFormatter(
      [{ name: 'count(*)' }, { name: 'a+b' }, { name: 'code', type: 'INTEGER', typeKind: 'integer' }],
      { header: false, nullText: '' }
    )
    const doc = parse(formatRows(sheet, [[3, 1.5, '00123']], [['integer', 'real', 'text']]))
    const cells = doc.getElementsByTagNameNS(NS, 'c')
    expect(cells[0].getAttribute('t')).toBeNull()
    expect(cells[0].textContent).toBe('3')
    expect(cells[1].getAttribute('t')).toBeNull()
    expect(cells[1].textContent).toBe('1.5')
    // Text stored in an INTEGER column stays text.
    expect(cells[2].getAttribute('t')).toBe('inlineStr')
    expect(cells[2].textContent).toBe('00123')
  })

  it('refuses rows past Excel limit', () => {
    const sheet = xlsxSheetFormatter([cols[0]], { header: true, nullText: '' })
    sheet.begin()
    const tooMany = () => {
      for (let i = 0; i < XLSX_MAX_ROWS; i++) sheet.row([i])
    }
    expect(tooMany).toThrow(/CSV/)
    expect(sheet.stats.rows).toBe(XLSX_MAX_ROWS - 1)
  })

  it('the static parts are well-formed XML', () => {
    for (const part of xlsxStaticParts('Ventas & <co>')) parse(part.xml)
    const workbook = xlsxStaticParts('Ventas & <co>').find((p) => p.path === 'xl/workbook.xml')!
    expect(workbook.xml).toContain('name="Ventas &amp; &lt;co&gt;"')
  })
})
