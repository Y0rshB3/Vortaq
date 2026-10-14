/**
 * Office Open XML (SpreadsheetML) pieces of an .xlsx export: one worksheet
 * written row by row (so main can stream it to a temp file), a bold frozen
 * header row, and every value either a number or an inline string. Strings
 * are never formulas: a value that starts with `=` stays text. Main packs the
 * parts into the ZIP container (src/main/export/xlsx.ts). Pure: no Node APIs.
 */
import type { CellValue } from '../types'
import type { RowFormatter, RowStorage } from './formats'
import type { ExportColumn } from './types'
import { cellText, isNumericColumn } from './values'

/** Excel's sheet limits. */
export const XLSX_MAX_ROWS = 1_048_576
export const XLSX_MAX_COLUMNS = 16_384
export const XLSX_MAX_CELL_CHARS = 32_767
/** Excel keeps 15 significant digits: longer numbers are written as text. */
export const XLSX_MAX_DIGITS = 15

export const XLSX_TOO_MANY_ROWS = `Excel admite como máximo ${XLSX_MAX_ROWS.toLocaleString('es-ES')} filas por hoja (encabezado incluido): exporta en CSV, que no tiene límite.`
export const XLSX_TOO_MANY_COLUMNS = `Excel admite como máximo ${XLSX_MAX_COLUMNS.toLocaleString('es-ES')} columnas por hoja: exporta en CSV.`

/**
 * Characters XML 1.0 does not allow (control characters other than tab, LF
 * and CR, lone surrogates, U+FFFE/U+FFFF). Excel refuses a file that has any.
 */
const ILLEGAL_XML = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]' +
    '|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]',
  'g'
)

/** Removes the characters XML 1.0 cannot carry. */
export function stripIllegalXml(text: string): string {
  return text.replace(ILLEGAL_XML, '')
}

/** Escapes text for an XML element or attribute (after stripping illegal characters). */
export function xmlEscape(text: string): string {
  return stripIllegalXml(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Excel reads `_xHHHH_` inside a string as an escaped character; a literal
 * one must have its underscore escaped (`_x005F_`) to come back unchanged.
 */
function protectExcelEscapes(text: string): string {
  return text.replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1')
}

/** Column letters of a 0-based index: 0 → A, 25 → Z, 26 → AA. */
export function columnLetters(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** Significant digits of a plain decimal number text (`-0012.3400` → 4). */
export function significantDigits(text: string): number {
  const mantissa = text.replace(/^[+-]/, '').replace(/[eE].*$/, '')
  const digits = mantissa.replace('.', '').replace(/^0+/, '')
  // Trailing zeros after the point do not add precision; before it they do (1200 → 4).
  const trimmed = mantissa.includes('.') ? digits.replace(/0+$/, '') : digits
  return trimmed.length || 1
}

const PLAIN_NUMBER = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/

/** The number Excel should store for a numeric cell, or null to write it as text. */
export function excelNumber(value: CellValue): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const text = String(value)
    return significantDigits(text) <= XLSX_MAX_DIGITS ? text : null
  }
  if (typeof value !== 'string' || !PLAIN_NUMBER.test(value)) return null
  if (significantDigits(value) > XLSX_MAX_DIGITS) return null
  const n = Number(value)
  return Number.isFinite(n) ? value.replace(/^(-?)\./, '$10.') : null
}

/** Style ids of styles.xml: 0 default, 1 bold header. */
const HEADER_STYLE = 1

export interface XlsxSheetStats {
  /** Cells cut to XLSX_MAX_CELL_CHARS. */
  truncatedCells: number
  /** Data rows written. */
  rows: number
}

/**
 * Worksheet XML (sheet1.xml) row by row. `row()` throws once the sheet would
 * pass Excel's row limit; the caller refuses more than XLSX_MAX_COLUMNS
 * columns before starting.
 */
export function xlsxSheetFormatter(
  columns: readonly ExportColumn[],
  options: { header: boolean; nullText: string }
): RowFormatter & { stats: XlsxSheetStats } {
  if (columns.length > XLSX_MAX_COLUMNS) throw new Error(XLSX_TOO_MANY_COLUMNS)
  const refs = columns.map((_, i) => columnLetters(i))
  const numeric = columns.map((c) => isNumericColumn(c))
  const stats: XlsxSheetStats = { truncatedCells: 0, rows: 0 }
  let rowNumber = 0

  const text = (value: string): string => {
    let t = stripIllegalXml(value)
    if (t.length > XLSX_MAX_CELL_CHARS) {
      t = t.slice(0, XLSX_MAX_CELL_CHARS)
      // Never leave half of a surrogate pair at the cut.
      if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1)
      stats.truncatedCells++
    }
    return xmlEscape(protectExcelEscapes(t))
  }
  const stringCell = (ref: string, value: string, style = 0): string =>
    `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${text(value)}</t></is></c>`

  const lastCol = refs.length ? refs[refs.length - 1] : 'A'
  return {
    stats,
    begin: () => {
      const frozen = options.header
        ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
        : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
      let out =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<dimension ref="A1:${lastCol}1"/>` +
        frozen +
        '<sheetFormatPr defaultRowHeight="15"/><sheetData>'
      if (options.header) {
        rowNumber = 1
        out += `<row r="1">${columns.map((c, i) => stringCell(`${refs[i]}1`, c.name, HEADER_STYLE)).join('')}</row>`
      }
      return out
    },
    row: (values: readonly CellValue[], _storage?: RowStorage) => {
      if (rowNumber >= XLSX_MAX_ROWS) throw new Error(XLSX_TOO_MANY_ROWS)
      rowNumber++
      stats.rows++
      let cells = ''
      for (let i = 0; i < columns.length; i++) {
        const value = values[i] ?? null
        const ref = `${refs[i]}${rowNumber}`
        if (value === null) {
          if (options.nullText) cells += stringCell(ref, options.nullText)
          continue
        }
        const number = numeric[i] ? excelNumber(value) : null
        cells +=
          number !== null ? `<c r="${ref}"><v>${number}</v></c>` : stringCell(ref, cellText(value))
      }
      return `<row r="${rowNumber}">${cells}</row>`
    },
    end: () => '</sheetData></worksheet>'
  }
}

/** Sheet name rules: 1–31 characters, none of `[]:*?/\`, not starting or ending with `'`. */
export function sheetName(name: string | null | undefined): string {
  const clean = stripIllegalXml(name ?? '')
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31)
    .trim()
  return clean || 'Resultado'
}

/** The fixed parts of the package (everything but the worksheet). */
export function xlsxStaticParts(name: string): { path: string; xml: string }[] {
  const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  return [
    {
      path: '[Content_Types].xml',
      xml:
        decl +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>'
    },
    {
      path: '_rels/.rels',
      xml:
        decl +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'
    },
    {
      path: 'xl/workbook.xml',
      xml:
        decl +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${xmlEscape(sheetName(name))}" sheetId="1" r:id="rId1"/></sheets>` +
        '</workbook>'
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      xml:
        decl +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>'
    },
    {
      path: 'xl/styles.xml',
      xml:
        decl +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
        '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>'
    }
  ]
}
