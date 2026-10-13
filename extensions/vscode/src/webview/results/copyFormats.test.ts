import { describe, expect, it } from 'vitest'
import { formatRows, uniqueKeys } from './copyFormats'

const columns = ['id', 'nombre', 'nota']
const rows = [
  ['1', 'Ana', null],
  ['2', 'Luis "el bueno", segundo', 'línea 1\nlínea 2'],
  ['3', 'tab\there', true]
]

describe('copy formats', () => {
  it('TSV: header, tab-separated, NULL empty, quotes only when needed', () => {
    expect(formatRows('tsv', columns, rows)).toBe(
      [
        'id\tnombre\tnota',
        '1\tAna\t',
        '2\t"Luis ""el bueno"", segundo"\t"línea 1\nlínea 2"',
        '3\t"tab\there"\ttrue'
      ].join('\n')
    )
  })

  it('CSV: RFC 4180 quoting', () => {
    expect(formatRows('csv', columns, rows).split('\n')[2]).toBe(
      '2,"Luis ""el bueno"", segundo","línea 1'
    )
  })

  it('JSON: one object per row, NULL as null, exact text kept', () => {
    expect(JSON.parse(formatRows('json', columns, rows))).toEqual([
      { id: '1', nombre: 'Ana', nota: null },
      { id: '2', nombre: 'Luis "el bueno", segundo', nota: 'línea 1\nlínea 2' },
      { id: '3', nombre: 'tab\there', nota: true }
    ])
  })

  it('JSON keys stay distinct for repeated column names', () => {
    expect(uniqueKeys(['id', 'id', 'id_2', 'id'])).toEqual(['id', 'id_2_', 'id_2', 'id_3'])
  })
})
