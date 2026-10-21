import { describe, expect, it } from 'vitest'
import type { ColumnInfo, IndexInfo, QueryColumn } from '@shared/types'
import {
  LOCK_COMPUTED,
  REASON_COMPUTED,
  REASON_DUPLICATE_KEYS,
  REASON_MISMATCH,
  REASON_NULL_KEY,
  decideEditability,
  duplicateKeyRow,
  payloadColumns,
  primaryKeyOf,
  resultSource,
  type ResultSource
} from './resultEditability'

/** Column as main reports it for `<alias>.<source>` of accounts.user. */
function col(
  name: string,
  sourceName: string | undefined = name,
  extra: Partial<QueryColumn> = {}
): QueryColumn {
  return {
    name,
    type: 'VARCHAR',
    schema: 'accounts',
    table: 'user',
    tableAlias: 'u',
    ...(sourceName ? { sourceName } : {}),
    ...extra
  }
}

const pk = (...columns: string[]): IndexInfo => ({
  name: 'PRIMARY',
  unique: true,
  type: 'BTREE',
  columns,
  comment: ''
})
const column = (name: string, extra = ''): ColumnInfo => ({
  name,
  ordinal: 1,
  columnType: 'int',
  dataType: 'int',
  nullable: false,
  key: '',
  defaultValue: null,
  extra,
  characterSet: null,
  collation: null,
  comment: ''
})
const table = (indexes: IndexInfo[] = [pk('id')], columns: ColumnInfo[] = []) => ({
  tableType: 'BASE TABLE',
  indexes,
  columns
})
/** `FROM accounts.user AS u` */
const SRC: ResultSource = { schema: 'accounts', table: 'user', alias: 'u' }

describe('decideEditability', () => {
  it('accepts SELECT * from one table with an alias (Navicat behaviour)', () => {
    // SELECT * FROM accounts.user AS u WHERE u.email LIKE '%x%'
    const columns = [col('id'), col('email'), col('name')]
    expect(decideEditability(columns, SRC, table())).toEqual({
      editable: true,
      schema: 'accounts',
      table: 'user',
      primaryKey: ['id'],
      keyColumns: ['id'],
      generatedKeyColumn: null,
      locked: [null, null, null]
    })
  })

  it('maps aliased columns (AS) back to their real names', () => {
    // SELECT id AS ident, email AS correo FROM accounts.user u
    const columns = [col('ident', 'id'), col('correo', 'email')]
    const decision = decideEditability(columns, SRC, table())
    expect(decision).toMatchObject({ editable: true, primaryKey: ['id'], keyColumns: ['ident'] })
    expect(payloadColumns(columns).map((c) => c.name)).toEqual(['id', 'email'])
  })

  it('matches key columns case-insensitively, keeping the result spelling', () => {
    const decision = decideEditability([col('ID', 'ID'), col('email')], SRC, table())
    expect(decision).toMatchObject({ editable: true, primaryKey: ['ID'] })
  })

  it('is read-only when a column comes from another table than the statement names', () => {
    const columns = [col('id'), col('total', 'total', { table: 'orders', tableAlias: 'o' })]
    expect(decideEditability(columns, SRC, table())).toMatchObject({
      editable: false,
      reason: REASON_MISMATCH
    })
  })

  it('is read-only when a column reports another alias (self-join)', () => {
    const columns = [col('id'), col('email', 'email', { tableAlias: 'v' })]
    expect(decideEditability(columns, SRC, table())).toMatchObject({
      editable: false,
      reason: REASON_MISMATCH
    })
  })

  it('is read-only when the metadata names another table than FROM (merged derived table)', () => {
    // SELECT * FROM items: but MySQL reports orgTable 'decoy' (cannot be trusted).
    const source: ResultSource = { schema: 'accounts', table: 'items', alias: 'items' }
    const columns = [col('id', 'id', { table: 'decoy', tableAlias: 'items' })]
    expect(decideEditability(columns, source, table())).toMatchObject({
      editable: false,
      reason: REASON_MISMATCH
    })
  })

  it('locks expression columns and edits the rest', () => {
    // SELECT id, UPPER(email) AS e FROM accounts.user
    const columns = [col('id'), { name: 'e', type: 'VARCHAR' }]
    expect(decideEditability(columns, SRC, table())).toMatchObject({
      editable: true,
      primaryKey: ['id'],
      locked: [null, LOCK_COMPUTED]
    })
    expect(payloadColumns(columns, [null, LOCK_COMPUTED]).map((c) => c.name)).toEqual([
      'id',
      '\u00001'
    ])
    // Only expressions: nothing to edit.
    expect(decideEditability([{ name: 'e', type: 'VARCHAR' }], SRC, table())).toEqual({
      editable: false,
      reason: REASON_COMPUTED,
      schema: 'accounts',
      table: 'user'
    })
  })

  it('is read-only when the same column appears twice', () => {
    expect(decideEditability([col('id'), col('id2', 'id')], SRC, table())).toMatchObject({
      editable: false,
      reason: 'la misma columna aparece varias veces'
    })
  })

  it('is read-only for a view, before looking at its columns', () => {
    // A TEMPTABLE view or a view with aggregates reports base-table / computed columns.
    const columns = [col('id', 'id', { primaryKey: true }), { name: 'n', type: 'BIGINT' }]
    expect(decideEditability(columns, SRC, { tableType: 'VIEW', indexes: [] })).toEqual({
      editable: false,
      reason: 'el origen es una vista',
      schema: 'accounts',
      table: 'user'
    })
  })

  it('is read-only when a composite primary key is only partially selected', () => {
    const columns = [col('tenant_id'), col('email')]
    expect(decideEditability(columns, SRC, table([pk('tenant_id', 'id')]))).toMatchObject({
      editable: false,
      reason: 'falta la clave primaria completa en el resultado'
    })
    const full = decideEditability(
      [col('id'), col('tenant_id')],
      SRC,
      table([pk('tenant_id', 'id')])
    )
    expect(full).toMatchObject({ editable: true, primaryKey: ['tenant_id', 'id'] })
  })

  it('is read-only when the table has no primary key', () => {
    const unique: IndexInfo = { ...pk('email'), name: 'uq_email' }
    expect(decideEditability([col('id'), col('email')], SRC, table([unique]))).toMatchObject({
      editable: false,
      reason: 'la tabla no tiene clave primaria'
    })
  })

  it('is read-only when the table structure could not be read', () => {
    expect(decideEditability([col('id')], SRC, null)).toMatchObject({
      editable: false,
      reason: 'no se pudo comprobar la tabla'
    })
  })

  // Regression: two copies of one row got conflicting edits and the grid kept both.
  it('is read-only when the loaded rows repeat a key', () => {
    const rows = [
      [1, 'a'],
      [1, 'a'],
      [2, 'b']
    ]
    expect(decideEditability([col('id'), col('email')], SRC, table(), rows)).toMatchObject({
      editable: false,
      reason: REASON_DUPLICATE_KEYS
    })
    expect(duplicateKeyRow(rows, [0])).toBe(1)
    expect(duplicateKeyRow([[1], [2]], [0])).toBe(-1)
  })

  // Regression: an insert id was written into a PK that is not the AUTO_INCREMENT column.
  it('fills generated ids only into an AUTO_INCREMENT single-column key', () => {
    const columns = [col('code'), col('n'), col('v')]
    const uuidKey = table([pk('code')], [column('code'), column('n', 'auto_increment')])
    expect(decideEditability(columns, SRC, uuidKey)).toMatchObject({
      editable: true,
      generatedKeyColumn: null
    })
    const aiKey = table([pk('code')], [column('CODE', 'auto_increment')])
    expect(decideEditability(columns, SRC, aiKey)).toMatchObject({
      generatedKeyColumn: 'code'
    })
    const composite = table([pk('code', 'n')], [column('code', 'auto_increment')])
    expect(decideEditability(columns, SRC, composite)).toMatchObject({
      generatedKeyColumn: null
    })
  })
})

describe('resultSource / primaryKeyOf', () => {
  it('names the table the statement reads without touching the server', () => {
    const columns = [col('id'), col('email')]
    expect(
      resultSource(columns, "SELECT * FROM accounts.user AS u WHERE u.email LIKE '%x%'")
    ).toEqual({
      ok: true,
      source: SRC,
      candidates: [SRC]
    })
    // Unqualified: the schema comes from the result; no alias: the table name.
    const bare = { schema: 'accounts', table: 'user', alias: 'user' }
    expect(resultSource(columns, 'SELECT * FROM user')).toEqual({
      ok: true,
      source: bare,
      candidates: [bare]
    })
    expect(resultSource([], 'SELECT * FROM user')).toMatchObject({ ok: false })
  })

  it('stays read-only for statements that are not a plain single-table SELECT', () => {
    const columns = [col('id'), col('email')]
    expect(resultSource(columns, 'SELECT * FROM (SELECT * FROM user) u')).toMatchObject({
      ok: false,
      reason: 'la consulta lee de una subconsulta'
    })
    expect(resultSource([{ name: 'n', type: 'BIGINT' }], 'SELECT COUNT(*) FROM user')).toEqual({
      ok: false,
      reason: 'la consulta agrupa filas'
    })
    expect(resultSource([{ name: 'n', type: 'BIGINT' }], 'SELECT 1 FROM user')).toEqual({
      ok: false,
      reason: REASON_COMPUTED
    })
  })

  it('parses SQLite statements with the SQLite lexer', () => {
    const columns: QueryColumn[] = [
      { name: 'id', type: 'INTEGER', schema: 'main', table: 'user', sourceName: 'id' }
    ]
    expect(resultSource(columns, 'SELECT * FROM [user] AS u', 'sqlite')).toMatchObject({
      ok: true,
      source: { schema: 'main', table: 'user', alias: 'u' }
    })
    expect(resultSource(columns, 'SELECT * FROM aux.`user`', 'sqlite')).toMatchObject({
      ok: true,
      source: { schema: 'aux', table: 'user', alias: 'user' }
    })
    expect(resultSource(columns, 'SELECT DISTINCT id FROM user', 'sqlite')).toMatchObject({
      ok: false
    })
  })

  it('returns the PRIMARY index columns in order', () => {
    expect(primaryKeyOf({ indexes: [{ ...pk('x'), name: 'idx' }, pk('b', 'a')] })).toEqual([
      'b',
      'a'
    ])
    expect(primaryKeyOf({ indexes: [] })).toEqual([])
  })
})

/** Column of accounts.orders `o`. */
const orderCol = (name: string, extra: Partial<QueryColumn> = {}): QueryColumn =>
  col(name, name, { table: 'orders', tableAlias: 'o', ...extra })
/** Without alias metadata (PostgreSQL, SQLite): only the table is known. */
const bare = (c: QueryColumn): QueryColumn => {
  const { tableAlias: _alias, ...rest } = c
  return rest
}
const JOIN = 'FROM accounts.user u JOIN accounts.orders o ON o.user_id = u.id'
const userTable = table([pk('id')], [column('id'), column('email')])

function joined(columns: QueryColumn[], sql: string, dialect?: 'postgresql' | 'sqlite') {
  const source = resultSource(columns, sql, dialect)
  if (!source.ok) throw new Error(source.reason)
  return source
}

describe('joined SELECT', () => {
  it('edits the columns of one table and locks the others (MySQL alias metadata)', () => {
    const columns = [col('id'), col('email'), orderCol('total'), { name: 'n', type: 'BIGINT' }]
    const source = joined(columns, `SELECT u.*, o.total, ROW_NUMBER() OVER () AS n ${JOIN}`)
    expect(source.candidates.map((c) => c.alias)).toEqual(['u', 'o'])
    expect(decideEditability(columns, source.source, userTable, [[1, 'a', 9, 1]])).toMatchObject({
      editable: true,
      schema: 'accounts',
      table: 'user',
      primaryKey: ['id'],
      locked: [null, null, 'columna de otra tabla (o)', LOCK_COMPUTED]
    })
  })

  it('edits a SELECT of one table that only joins others to filter', () => {
    const columns = [col('id'), col('email')]
    const source = joined(columns, `SELECT u.* ${JOIN} WHERE o.total > 1 ORDER BY u.id`)
    expect(source.source).toMatchObject({ schema: 'accounts', table: 'user', alias: 'u' })
    expect(decideEditability(columns, source.source, userTable)).toMatchObject({
      editable: true,
      locked: [null, null]
    })
  })

  it('tells the two sides of a self-join apart by alias', () => {
    const columns = [
      col('id', 'id', { tableAlias: 'a' }),
      col('email', 'email', { tableAlias: 'a' }),
      col('boss', 'email', { tableAlias: 'b' })
    ]
    const source = joined(
      columns,
      'SELECT a.id, a.email, b.email AS boss FROM accounts.user a JOIN accounts.user b ON b.id = a.boss_id'
    )
    expect(decideEditability(columns, source.source, userTable)).toMatchObject({
      editable: true,
      locked: [null, null, 'columna de otra tabla (b)']
    })
  })

  it('orders the candidates by how many result columns each table has', () => {
    const columns = [orderCol('total'), col('id'), col('email')]
    expect(
      joined(columns, `SELECT o.total, u.id, u.email ${JOIN}`).candidates.map((c) => c.alias)
    ).toEqual(['u', 'o'])
  })

  it('is read-only when the join repeats a row or finds no row (outer join)', () => {
    const columns = [col('id'), col('email'), orderCol('total')]
    const source = joined(columns, `SELECT u.*, o.total ${JOIN}`).source
    const repeated = [
      [1, 'a', 5],
      [1, 'a', 6]
    ]
    expect(decideEditability(columns, source, userTable, repeated)).toMatchObject({
      editable: false,
      reason: REASON_DUPLICATE_KEYS
    })
    const orders = joined(
      [orderCol('id'), orderCol('total'), col('email')],
      'SELECT o.id, o.total, u.email FROM accounts.user u LEFT JOIN accounts.orders o ON o.user_id = u.id'
    ).source
    expect(orders.alias).toBe('o')
    expect(
      decideEditability(
        [orderCol('id'), orderCol('total'), col('email')],
        orders,
        table([pk('id')], [column('id'), column('total')]),
        [
          [7, 5, 'a'],
          [null, null, 'b']
        ]
      )
    ).toMatchObject({ editable: false, reason: REASON_NULL_KEY })
  })

  describe('without alias metadata (PostgreSQL, SQLite): by place in the select list', () => {
    const pgCols = (...cs: QueryColumn[]) => cs.map(bare)

    it('ties t.* to the table structure and locks the other items', () => {
      const columns = pgCols(col('id'), col('email'), orderCol('total'))
      const source = joined(columns, `SELECT u.*, o.total ${JOIN}`, 'postgresql').source
      expect(
        decideEditability(columns, source, userTable, [], { aliasMetadata: false })
      ).toMatchObject({ editable: true, locked: [null, null, 'columna de otra tabla (orders)'] })
    })

    it('locks the other side of a self-join, which names the same table', () => {
      const columns = pgCols(col('id'), col('email'), col('boss', 'email'))
      const source = joined(
        columns,
        'SELECT a.*, b.email AS boss FROM accounts.user a JOIN accounts.user b ON b.id = a.boss_id',
        'postgresql'
      ).source
      expect(
        decideEditability(columns, source, userTable, [], { aliasMetadata: false })
      ).toMatchObject({ editable: true, locked: [null, null, 'columna de otra tabla (b)'] })
    })

    it('counts from the end past a star of another table', () => {
      const columns = pgCols(orderCol('id'), orderCol('total'), col('id'), col('email'))
      // Both are stars: the first table in FROM is the first candidate.
      const source = joined(columns, `SELECT o.*, u.* ${JOIN}`, 'postgresql')
      expect(source.candidates.map((c) => c.alias)).toEqual(['u', 'o'])
      expect(
        decideEditability(columns, source.source, userTable, [], { aliasMetadata: false })
      ).toMatchObject({
        editable: true,
        locked: ['columna de otra tabla (orders)', 'columna de otra tabla (orders)', null, null]
      })
    })

    it('locks an unqualified column it cannot tie to one reference', () => {
      const columns = pgCols(col('id'), col('email'))
      const source = joined(columns, `SELECT u.id, email ${JOIN}`, 'postgresql').source
      expect(
        decideEditability(columns, source, userTable, [], { aliasMetadata: false })
      ).toMatchObject({ editable: true, locked: [null, 'escribe u.email para editarla'] })
    })

    it('is read-only when the result does not match the statement', () => {
      // u.* is three columns wide in the structure, but the result has two.
      const columns = pgCols(col('id'), col('email'))
      const source = joined(columns, `SELECT u.* ${JOIN}`, 'postgresql').source
      const wider = table([pk('id')], [column('id'), column('email'), column('name')])
      expect(decideEditability(columns, source, wider, [], { aliasMetadata: false })).toMatchObject(
        { editable: false, reason: REASON_MISMATCH }
      )
      // The driver must agree on each column of the table.
      const swapped = pgCols(col('id'), col('email', 'name'))
      expect(
        decideEditability(swapped, source, userTable, [], { aliasMetadata: false })
      ).toMatchObject({ editable: false, reason: REASON_MISMATCH })
    })

    it('asks for qualified columns when nothing ties them to a table', () => {
      const columns = pgCols(col('id'), col('email'), orderCol('total'))
      expect(resultSource(columns, `SELECT * ${JOIN}`, 'postgresql')).toEqual({
        ok: false,
        reason: 'la consulta usa varias tablas: escribe u.* o u.columna para editar'
      })
      expect(
        resultSource([{ name: 'n', type: 'int' }], `SELECT 1 + 1 AS n ${JOIN}`, 'postgresql')
      ).toEqual({ ok: false, reason: REASON_COMPUTED })
    })
  })
})
