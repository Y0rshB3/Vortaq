import type { ColumnInfo, ForeignKeyInfo, TableStructure } from '@shared/types'

/** A tiny shop: customers ← orders ← order_items, plus an unrelated settings table. */
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
const fk = (columns: string[], table: string, referencedColumns = ['id']): ForeignKeyInfo => ({
  name: `fk_${columns.join('_')}`,
  columns,
  referencedSchema: 'shop',
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

export const SHOP: Record<string, TableStructure> = {
  customers: table('customers', [col('id'), col('name', 'varchar(60)'), col('country', 'char(2)')]),
  orders: table(
    'orders',
    [col('id'), col('customer_id'), col('total', 'decimal(10,2)')],
    [fk(['customer_id'], 'customers')]
  ),
  order_items: table(
    'order_items',
    [col('id'), col('order_id'), col('qty')],
    [fk(['order_id'], 'orders')]
  ),
  settings: table('settings', [col('id'), col('value', 'text')])
}

export const shopTables = () =>
  Object.keys(SHOP).map((name) => ({
    name,
    engine: 'InnoDB',
    rows: 0,
    dataLength: 0,
    indexLength: 0,
    autoIncrement: null,
    createTime: null,
    updateTime: null,
    collation: null,
    comment: ''
  }))
