import { describe, expect, it } from 'vitest'
import type { ColumnInfo, ForeignKeyInfo, QueryColumn } from '@shared/types'
import {
  MAX_SEARCH_COLUMNS,
  chosenValues,
  foreignKeyLabel,
  foreignKeySearch,
  gridForeignKeys
} from './foreignKeys'

const info = (name: string): ColumnInfo => ({
  name,
  ordinal: 1,
  columnType: 'int',
  dataType: 'int',
  nullable: true,
  key: '',
  defaultValue: null,
  extra: '',
  characterSet: null,
  collation: null,
  comment: ''
})
const fk = (
  columns: string[],
  referencedColumns: string[],
  table = 'clientes'
): ForeignKeyInfo => ({
  name: `fk_${columns.join('_')}`,
  columns,
  referencedSchema: 'ventas',
  referencedTable: table,
  referencedColumns,
  onUpdate: 'RESTRICT',
  onDelete: 'RESTRICT'
})
const col = (name: string, type: string, typeKind?: QueryColumn['typeKind']): QueryColumn => ({
  name,
  type,
  ...(typeKind ? { typeKind } : {})
})

describe('grid foreign keys', () => {
  it('maps each key to the grid columns that hold it, case-insensitively, by real column name', () => {
    const grid = [info('id'), info('Cliente_ID'), null, info('anio'), info('numero')]
    const keys = gridForeignKeys(
      grid,
      [fk(['cliente_id'], ['id']), fk(['anio', 'numero'], ['anio', 'numero'], 'pedidos')],
      (schema) => ({ database: 'tienda', schema })
    )
    expect(keys[0]).toBeNull()
    expect(keys[1]).toMatchObject({
      cols: [1],
      table: 'clientes',
      schema: { database: 'tienda', schema: 'ventas' },
      refColumns: ['id']
    })
    expect(keys[2]).toBeNull()
    expect(keys[3]).toBe(keys[4])
    expect(keys[3]?.cols).toEqual([3, 4])
    expect(foreignKeyLabel(keys[3]!)).toBe('pedidos (anio, numero)')
  })

  it('skips a composite key with a column missing from the grid; the first key of a column wins', () => {
    const keys = gridForeignKeys(
      [info('anio'), info('cliente_id')],
      [
        fk(['anio', 'numero'], ['anio', 'numero'], 'pedidos'),
        fk(['cliente_id'], ['id']),
        fk(['cliente_id'], ['codigo'], 'otros')
      ],
      (schema) => schema
    )
    expect(keys[0]).toBeNull()
    expect(keys[1]).toMatchObject({ table: 'clientes', schema: 'ventas' })
    expect(gridForeignKeys([info('a')], [fk(['a'], [])], (s) => s)).toEqual([null])
  })

  it('searches the referenced columns plus text-like ones, never binary or JSON', () => {
    const columns = [
      col('id', 'INT', 'integer'),
      col('nombre', 'VARCHAR', 'text'),
      col('foto', 'BLOB', 'binary'),
      col('datos', 'JSON', 'json'),
      col('alta', 'DATETIME', 'datetime'),
      col('codigo', 'VARCHAR(10)')
    ]
    const filter = foreignKeySearch(columns, ['id'], '  ana ')
    expect(filter?.connector).toBe('AND')
    expect(filter?.children).toEqual(
      ['id', 'nombre', 'codigo'].map((column) => ({
        kind: 'condition',
        enabled: true,
        column,
        operator: 'contains',
        values: ['ana'],
        connector: 'OR'
      }))
    )
    expect(foreignKeySearch(columns, ['id'], '   ')).toBeNull()
    const many = Array.from({ length: 20 }, (_, i) => col(`c${i}`, 'TEXT', 'text'))
    expect(foreignKeySearch(many, ['c15'], 'x')?.children).toHaveLength(MAX_SEARCH_COLUMNS)
    expect(foreignKeySearch(many, ['c15'], 'x')?.children[0]).toMatchObject({ column: 'c15' })
  })

  it('writes the referenced values as the text editor would, NULL kept', () => {
    const key = gridForeignKeys(
      [info('anio'), info('numero')],
      [fk(['anio', 'numero'], ['y', 'n'], 'pedidos')],
      (s) => s
    )[0]!
    const columns = [col('n', 'INT'), col('desc', 'TEXT'), col('y', 'INT')]
    expect(chosenValues(key, columns, [7, 'x', 2026])).toEqual(['2026', '7'])
    expect(chosenValues(key, columns, [null, 'x', true])).toEqual(['1', null])
    expect(chosenValues(key, [col('n', 'INT')], [7])).toBeNull()
  })
})
