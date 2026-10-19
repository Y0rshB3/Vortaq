import { describe, expect, it } from 'vitest'
import { getDialect } from '@shared/dialects'
import { buildQuery, tableAlias, type BuilderColumn, type BuilderSpec } from './sqlBuilder'

const mysql = getDialect('mysql')
const pg = getDialect('postgresql')
const lite = getDialect('sqlite')

const column = (
  table: string,
  name: string,
  extra: Partial<BuilderColumn> = {}
): BuilderColumn => ({
  id: `${table}.${name}`,
  table,
  column: name,
  output: true,
  as: '',
  aggregate: null,
  sort: null,
  operator: null,
  value: '',
  numeric: false,
  ...extra
})
const spec = (extra: Partial<BuilderSpec> = {}): BuilderSpec => ({
  qualifier: null,
  tables: [{ name: 'members', alias: 'm' }],
  joins: [],
  columns: [],
  distinct: false,
  limit: null,
  ...extra
})

describe('visual query SQL', () => {
  it('one table: SELECT * without aliases; nothing without tables', () => {
    expect(buildQuery(spec(), mysql).sql).toBe('SELECT\n  *\nFROM `members`')
    expect(buildQuery(spec({ tables: [] }), mysql)).toEqual({ sql: '', warnings: [] })
  })

  it('joins by every relation with the tables already listed, quoted per dialect', () => {
    const s = spec({
      tables: [
        { name: 'members', alias: 'm' },
        { name: 'persons', alias: 'p' },
        { name: 'teams', alias: 't' }
      ],
      joins: [
        { id: 'j1', type: 'INNER', a: 'm', b: 'p', on: [{ a: 'personID', b: 'personID' }] },
        { id: 'j2', type: 'LEFT', a: 't', b: 'm', on: [{ a: 'id', b: 'team_id' }] }
      ],
      columns: [
        column('m', 'status'),
        column('p', 'name', { as: 'nombre', sort: 'ASC' }),
        column('t', 'title', { output: false, operator: 'isNotNull' })
      ]
    })
    expect(buildQuery(s, mysql).sql).toBe(
      [
        'SELECT',
        '  m.`status`,',
        '  p.`name` AS `nombre`',
        'FROM `members` AS m',
        '  INNER JOIN `persons` AS p ON p.`personID` = m.`personID`',
        '  LEFT JOIN `teams` AS t ON t.`id` = m.`team_id`',
        'WHERE t.`title` IS NOT NULL',
        'ORDER BY p.`name` ASC'
      ].join('\n')
    )
    // PostgreSQL leaves plain lower-case names bare and quotes the rest.
    expect(buildQuery({ ...s, qualifier: 'ventas' }, pg).sql).toContain(
      'FROM ventas.members AS m\n  INNER JOIN ventas.persons AS p ON p."personID" = m."personID"'
    )
  })

  it('writes values as literals: numbers only for numeric columns, quotes escaped by the dialect', () => {
    const s = spec({
      columns: [
        column('m', 'id', { numeric: true, operator: 'ge', value: '10' }),
        column('m', 'code', { numeric: true, operator: 'eq', value: '1; DROP TABLE x' }),
        column('m', 'name', { operator: 'eq', value: "O'Brien \\ ok" }),
        column('m', 'zip', { operator: 'eq', value: '08001' })
      ]
    })
    const sql = buildQuery(s, mysql).sql
    expect(sql).toContain('`id` >= 10')
    expect(sql).toContain("`code` = '1; DROP TABLE x'")
    expect(sql).toContain("`name` = 'O\\'Brien \\\\ ok'")
    expect(sql).toContain("`zip` = '08001'")
    expect(buildQuery(s, pg).sql).toContain(`${pg.quoteIdent('name')} = 'O''Brien \\ ok'`)
  })

  it('LIKE patterns escape their wildcards with an explicit ESCAPE on every engine', () => {
    const s = spec({ columns: [column('m', 'name', { operator: 'contains', value: '50%_off\\' })] })
    expect(buildQuery(s, mysql).sql).toContain(
      "`name` LIKE '%50\\\\%\\\\_off\\\\\\\\%' ESCAPE '\\\\'"
    )
    expect(buildQuery(s, lite).sql).toContain(
      `${lite.quoteIdent('name')} LIKE '%50\\%\\_off\\\\%' ESCAPE '\\'`
    )
    const begins = spec({ columns: [column('m', 'name', { operator: 'beginsWith', value: 'a' })] })
    expect(buildQuery(begins, pg).sql).toContain(`${pg.quoteIdent('name')} LIKE 'a%' ESCAPE '\\'`)
  })

  it('IN lists, NULL checks, DISTINCT and LIMIT', () => {
    const s = spec({
      distinct: true,
      limit: 50,
      columns: [
        column('m', 'status', { operator: 'in', value: 'Active, Archived,, ' }),
        column('m', 'left_at', { operator: 'isNull', output: false })
      ]
    })
    expect(buildQuery(s, mysql).sql).toBe(
      [
        'SELECT DISTINCT',
        '  `status`',
        'FROM `members`',
        "WHERE `status` IN ('Active', 'Archived')",
        '  AND `left_at` IS NULL',
        'LIMIT 50'
      ].join('\n')
    )
    expect(buildQuery(spec({ limit: 0 }), mysql).sql).not.toContain('LIMIT')
  })

  it('aggregates group by the visible plain columns; their filters go to HAVING', () => {
    const s = spec({
      tables: [
        { name: 'orders', alias: 'o' },
        { name: 'customers', alias: 'c' }
      ],
      joins: [{ id: 'j', type: 'INNER', a: 'o', b: 'c', on: [{ a: 'customer_id', b: 'id' }] }],
      columns: [
        column('c', 'country'),
        column('o', 'total', {
          aggregate: 'SUM',
          as: 'facturado',
          operator: 'gt',
          value: '100',
          numeric: true,
          sort: 'DESC'
        }),
        column('o', 'id', { aggregate: 'COUNT', as: 'pedidos' })
      ]
    })
    expect(buildQuery(s, mysql).sql).toBe(
      [
        'SELECT',
        '  c.`country`,',
        '  SUM(o.`total`) AS `facturado`,',
        '  COUNT(o.`id`) AS `pedidos`',
        'FROM `orders` AS o',
        '  INNER JOIN `customers` AS c ON c.`id` = o.`customer_id`',
        'GROUP BY c.`country`',
        'HAVING SUM(o.`total`) > 100',
        'ORDER BY SUM(o.`total`) DESC'
      ].join('\n')
    )
  })

  it('a table without joins is a CROSS JOIN, with a warning', () => {
    const built = buildQuery(
      spec({
        tables: [
          { name: 'members', alias: 'm' },
          { name: 'settings', alias: 's' }
        ]
      }),
      lite
    )
    expect(built.sql).toContain('CROSS JOIN settings AS s')
    expect(built.warnings).toEqual([
      '«settings» no está unida a las demás tablas: se combina cada fila con todas (CROSS JOIN).'
    ])
  })

  it('makes short unique aliases that are never keywords', () => {
    expect(tableAlias('order_items', [])).toBe('oi')
    expect(tableAlias('personDetails', [])).toBe('pd')
    expect(tableAlias('persons', ['p'])).toBe('p2')
    expect(tableAlias('order_numbers', [])).toBe('on_')
    expect(tableAlias('2024_sales', [])).toBe('t2s')
    expect(tableAlias('ñandú_rojo', [])).toBe('nr')
  })
})
