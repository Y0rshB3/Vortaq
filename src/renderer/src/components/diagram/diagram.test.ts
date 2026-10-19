import { describe, expect, it } from 'vitest'
import type { ColumnInfo, ForeignKeyInfo, TableStructure } from '@shared/types'
import { edgeGeometries, rowY } from './edges'
import {
  HEADER_H,
  ROW_H,
  autoLayout,
  contentBounds,
  placeMissing,
  shortType,
  tableSize,
  tableSizes,
  visibleColumns
} from './layout'
import { buildSchemaModel, relationsOf } from './model'
import { diagramSvg } from './svgExport'

const col = (name: string, columnType = 'int', extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  ordinal: 1,
  columnType,
  dataType: columnType.replace(/\(.*$/, ''),
  nullable: false,
  key: '',
  defaultValue: null,
  extra: '',
  characterSet: null,
  collation: null,
  comment: '',
  ...extra
})
const fk = (
  columns: string[],
  table: string,
  referencedColumns = ['id'],
  referencedSchema = 'shop',
  name = `fk_${columns.join('_')}`
): ForeignKeyInfo => ({
  name,
  columns,
  referencedSchema,
  referencedTable: table,
  referencedColumns,
  onUpdate: 'RESTRICT',
  onDelete: 'RESTRICT'
})
const table = (
  name: string,
  columns: ColumnInfo[],
  foreignKeys: ForeignKeyInfo[] = []
): TableStructure => ({
  schema: 'shop',
  name,
  columns,
  indexes: [{ name: 'PRIMARY', unique: true, type: 'BTREE', columns: ['id'], comment: '' }],
  foreignKeys,
  engine: 'InnoDB',
  collation: null,
  comment: '',
  autoIncrement: null,
  createSql: ''
})

const shop = [
  table('customers', [col('id'), col('name', 'varchar(60)')]),
  table(
    'orders',
    [col('id'), col('customer_id'), col('coupon_id', 'int', { nullable: true })],
    [
      fk(['customer_id'], 'Customers'),
      fk(['coupon_id'], 'coupons'),
      fk(['x'], 'accounts', ['id'], 'billing')
    ]
  ),
  table('coupons', [col('id'), col('code', "enum('WELCOME','SPRING','SUMMER','AUTUMN')")]),
  table(
    'order_items',
    [col('id'), col('order_id'), col('parent_id', 'int', { nullable: true })],
    [fk(['order_id'], 'orders'), fk(['parent_id'], 'order_items')]
  ),
  table('settings', [col('id'), col('value', 'text')])
]

describe('schema model', () => {
  it('keeps relations inside the namespace (names folded), counts the rest', () => {
    const model = buildSchemaModel(shop, 'SHOP')
    expect(
      model.relations.map((r) => `${r.from}.${r.fromColumns} -> ${r.to}.${r.toColumns}`)
    ).toEqual([
      'orders.customer_id -> customers.id',
      'orders.coupon_id -> coupons.id',
      'order_items.order_id -> orders.id',
      'order_items.parent_id -> order_items.id'
    ])
    expect(model.external).toBe(1)
    expect(model.relations.find((r) => r.fromColumns[0] === 'coupon_id')?.optional).toBe(true)
    expect(model.relations.find((r) => r.fromColumns[0] === 'customer_id')?.optional).toBe(false)
    const orders = model.tables.find((t) => t.name === 'orders')!
    expect(orders.columns.map((c) => [c.name, c.primaryKey, c.foreignKey])).toEqual([
      ['id', true, false],
      ['customer_id', false, true],
      ['coupon_id', false, true]
    ])
    expect(relationsOf(model, 'coupons').map((r) => r.from)).toEqual(['orders'])
  })

  it('gives unnamed or repeated constraints unique names', () => {
    const model = buildSchemaModel(
      [
        table('a', [col('id')]),
        table(
          'b',
          [col('id'), col('a_id'), col('a2_id')],
          [fk(['a_id'], 'a', ['id'], '', ''), fk(['a2_id'], 'a', ['id'], '', '')]
        ),
        table(
          'c',
          [col('id'), col('a_id')],
          [fk(['a_id'], 'a', ['id'], 'shop', 'same'), fk(['a_id'], 'a', ['id'], 'shop', 'same')]
        )
      ],
      'shop'
    )
    expect(new Set(model.relations.map((r) => r.name)).size).toBe(4)
  })
})

describe('layout', () => {
  const model = buildSchemaModel(shop, 'shop')
  const sizes = tableSizes(model, false)

  it('sizes boxes from names and types, «Solo claves» shows key columns only', () => {
    const coupons = model.tables.find((t) => t.name === 'coupons')!
    expect(shortType("enum('WELCOME','SPRING','SUMMER','AUTUMN')")).toHaveLength(18)
    expect(tableSize(coupons, false).h).toBe(HEADER_H + 2 * ROW_H + 6)
    expect(visibleColumns(coupons, true).map((c) => c.name)).toEqual(['id'])
    expect(tableSize(coupons, true).h).toBe(HEADER_H + ROW_H + 6)
    expect(tableSize(coupons, false).w).toBeGreaterThanOrEqual(170)
    expect(tableSize(coupons, false).w).toBeLessThanOrEqual(340)
  })

  it('puts referenced tables left of the tables pointing at them, unrelated ones apart; never overlapping', () => {
    const at = autoLayout(model, sizes)
    expect(Object.keys(at).sort()).toEqual(model.tables.map((t) => t.name).sort())
    expect(at.customers.x).toBeLessThan(at.orders.x)
    expect(at.coupons.x).toBeLessThan(at.orders.x)
    expect(at.orders.x).toBeLessThan(at.order_items.x)
    const names = Object.keys(at)
    for (const a of names)
      for (const b of names) {
        if (a >= b) continue
        const overlap =
          at[a].x < at[b].x + sizes[b].w &&
          at[b].x < at[a].x + sizes[a].w &&
          at[a].y < at[b].y + sizes[b].h &&
          at[b].y < at[a].y + sizes[a].h
        expect(overlap, `${a} overlaps ${b}`).toBe(false)
      }
    expect(autoLayout(model, sizes)).toEqual(at)
  })

  it('survives cycles and places new tables right of the existing ones', () => {
    const cyclic = buildSchemaModel(
      [
        table('a', [col('id'), col('b_id')], [fk(['b_id'], 'b')]),
        table('b', [col('id'), col('a_id')], [fk(['a_id'], 'a')])
      ],
      'shop'
    )
    const at = autoLayout(cyclic, tableSizes(cyclic, false))
    expect(at.a).toBeDefined()
    expect(at.b).toBeDefined()

    const partial = { customers: { x: 0, y: 0 } }
    const placed = placeMissing(model, partial, sizes)
    expect(placed.customers).toEqual({ x: 0, y: 0 })
    expect(placed.settings.x).toBeGreaterThan(sizes.customers.w)
    expect(contentBounds({}, sizes)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})

describe('relationship lines', () => {
  const model = buildSchemaModel(shop, 'shop')
  const sizes = tableSizes(model, false)

  it('anchors at the column rows, the header when the row is hidden', () => {
    const orders = model.tables.find((t) => t.name === 'orders')!
    expect(rowY(orders, 'coupon_id', false, 100)).toBe(100 + HEADER_H + 2 * ROW_H + ROW_H / 2)
    expect(rowY(orders, 'nope', false, 100)).toBe(100 + HEADER_H / 2)
  })

  it('leaves by the side facing the other table; self references loop on the right', () => {
    const at = {
      customers: { x: 0, y: 0 },
      orders: { x: 400, y: 0 },
      coupons: { x: 400, y: 300 },
      order_items: { x: 800, y: 0 },
      settings: { x: 0, y: 600 }
    }
    const edges = edgeGeometries(model.relations, model.tables, at, sizes, false)
    const path = (from: string, column: string) =>
      edges.find((e) => e.relation.from === from && e.relation.fromColumns[0] === column)!.path
    // orders (x 400) -> customers (x 0): orders' left side to customers' right side.
    expect(path('orders', 'customer_id')).toMatch(
      new RegExp(`^M 400 [\\d.]+ C .* ${sizes.customers.w} [\\d.]+$`)
    )
    // orders -> coupons stacked in the same column: both ends on the right.
    expect(path('orders', 'coupon_id')).toMatch(
      new RegExp(`^M ${400 + sizes.orders.w} .* ${400 + sizes.coupons.w} [\\d.]+$`)
    )
    const self = path('order_items', 'parent_id')
    expect(self.startsWith(`M ${800 + sizes.order_items.w} `)).toBe(true)
    expect(edges).toHaveLength(4)
  })
})

describe('SVG export', () => {
  it('is a standalone document with escaped names, key markers and dashed optional relations', () => {
    const model = buildSchemaModel(
      [
        table('a<b>&"c"', [col('id')]),
        table('d', [col('id'), col('a_id', 'int', { nullable: true })], [fk(['a_id'], 'a<b>&"c"')])
      ],
      'shop'
    )
    const sizes = tableSizes(model, false)
    const svg = diagramSvg(model, autoLayout(model, sizes), sizes, false, {
      background: '#fff',
      box: '#fafafa',
      border: '#ccc',
      header: '#eee',
      text: '#111',
      muted: '#666',
      key: '#c90',
      link: '#08c',
      line: '#888'
    })
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('a&#60;b&#62;&#38;&#34;c&#34;')
    expect(svg).not.toContain('a<b>')
    expect(svg).toContain('>PK<')
    expect(svg).toContain('>FK<')
    expect(svg).toContain('stroke-dasharray="5 4"')
    expect(svg).toContain('marker-start="url(#many)"')
    expect(svg.endsWith('</svg>')).toBe(true)
  })
})
