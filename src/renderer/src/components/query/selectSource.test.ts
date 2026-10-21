import { describe, expect, it } from 'vitest'
import {
  REASON_CTE,
  REASON_DERIVED,
  REASON_GROUPED,
  REASON_NO_TABLE,
  REASON_NOT_SIMPLE,
  REASON_SUBQUERY,
  REASON_UNION,
  REASON_UNPARSED,
  singleTableSelect
} from './selectSource'

const ref = (sql: string) => singleTableSelect(sql)

describe('singleTableSelect', () => {
  it('accepts the Navicat example with schema, alias and WHERE', () => {
    expect(ref("SELECT * FROM accounts.user AS u WHERE u.email LIKE '%x%'")).toEqual({
      ok: true,
      ref: { schema: 'accounts', table: 'user', alias: 'u' }
    })
  })

  it('accepts aliases without AS, backquotes, ORDER BY, LIMIT and locking clauses', () => {
    expect(ref('select id, name from `my db`.`items` i order by id desc limit 10, 5;')).toEqual({
      ok: true,
      ref: { schema: 'my db', table: 'items', alias: 'i' }
    })
    expect(ref('SELECT * FROM items FOR UPDATE')).toMatchObject({
      ok: true,
      ref: { schema: null, table: 'items', alias: null }
    })
    expect(ref('SELECT DISTINCT id FROM items LOCK IN SHARE MODE')).toMatchObject({ ok: true })
  })

  it('accepts index hints and PARTITION, and functions whose syntax contains FROM', () => {
    expect(ref('SELECT * FROM items i USE INDEX (PRIMARY), IGNORE KEY FOR ORDER BY (k)')).toEqual({
      ok: true,
      ref: { schema: null, table: 'items', alias: 'i' }
    })
    expect(ref('SELECT * FROM items PARTITION (p0, p1) AS x')).toMatchObject({
      ok: true,
      ref: { table: 'items', alias: 'x' }
    })
    expect(ref("SELECT id, TRIM(LEADING 'x' FROM name) FROM items")).toMatchObject({ ok: true })
  })

  it('allows subqueries that only filter rows', () => {
    const sql = 'SELECT * FROM items WHERE id IN (SELECT item_id FROM orders GROUP BY item_id)'
    expect(ref(sql)).toMatchObject({ ok: true, ref: { table: 'items' } })
  })

  it('ignores comments and keywords inside literals', () => {
    const sql =
      "-- JOIN decoy\nSELECT /* , decoy */ * FROM items # x JOIN y\nWHERE name = 'a JOIN b'"
    expect(ref(sql)).toMatchObject({ ok: true, ref: { table: 'items', alias: null } })
  })

  /*
   * Regression: MySQL reports the inner table/column names for merged derived
   * tables, CTEs and views, so those must be rejected from the text alone.
   */
  it('rejects derived tables, whatever alias they use inside', () => {
    expect(ref('SELECT * FROM (SELECT items.id, items.name FROM decoy items) d')).toEqual({
      ok: false,
      reason: REASON_DERIVED
    })
    expect(
      ref('SELECT * FROM (SELECT a.id, b.name FROM items a JOIN items b ON b.id = a.id + 1) d')
    ).toMatchObject({ ok: false, reason: REASON_DERIVED })
    expect(ref('SELECT * FROM LATERAL (SELECT 1) x')).toMatchObject({ ok: false })
  })

  it('rejects CTEs', () => {
    expect(ref('WITH c AS (SELECT * FROM v_swap) SELECT * FROM c')).toEqual({
      ok: false,
      reason: REASON_CTE
    })
  })

  it('reads joined plain tables and the select list', () => {
    expect(
      ref(
        'SELECT r.*, d.name AS division, NOW() FROM tournament.registration r JOIN tournament.division d ON r.divisionID = d.id ' +
          "JOIN tournament.tournament t ON d.tournamentID = t.id WHERE t.organizationID = 'x' AND r.waitlist = 1"
      )
    ).toEqual({
      ok: true,
      ref: { schema: 'tournament', table: 'registration', alias: 'r' },
      joined: {
        tables: [
          { schema: 'tournament', table: 'registration', alias: 'r' },
          { schema: 'tournament', table: 'division', alias: 'd' },
          { schema: 'tournament', table: 'tournament', alias: 't' }
        ],
        items: [
          { kind: 'star', qualifier: ['r'] },
          { kind: 'column', qualifier: ['d'], name: 'name' },
          { kind: 'expression' }
        ]
      }
    })
  })

  it('reads every join form, conditions included', () => {
    const tables = (sql: string) => {
      const parsed = ref(sql)
      return parsed.ok ? parsed.joined?.tables.map((t) => t.alias ?? t.table) : parsed.reason
    }
    expect(tables('SELECT items.* FROM items, orders WHERE orders.item_id = items.id')).toEqual([
      'items',
      'orders'
    ])
    expect(tables('SELECT * FROM items STRAIGHT_JOIN orders')).toEqual(['items', 'orders'])
    expect(tables('SELECT * FROM items NATURAL LEFT OUTER JOIN orders')).toEqual([
      'items',
      'orders'
    ])
    expect(
      tables(
        'SELECT i.* FROM items i USE INDEX (PRIMARY) CROSS JOIN `my db`.orders AS o FORCE INDEX (k) ' +
          'INNER JOIN c USING (id) RIGHT JOIN d ON LEFT(d.code, 2) = RIGHT(c.code, 2) AND d.id IN (SELECT id FROM e) LIMIT 5'
      )
    ).toEqual(['i', 'o', 'c', 'd'])
    expect(tables('SELECT DISTINCT SQL_NO_CACHE i.id FROM items i JOIN o ON o.i = i.id')).toEqual([
      'i',
      'o'
    ])
  })

  it('refuses joins of anything but plain tables', () => {
    expect(ref('SELECT i.* FROM items i JOIN (SELECT * FROM orders) o ON o.id = i.id')).toEqual({
      ok: false,
      reason: REASON_DERIVED
    })
    expect(ref('SELECT i.* FROM items i JOIN LATERAL (SELECT 1) x ON TRUE')).toMatchObject({
      reason: REASON_DERIVED
    })
    expect(
      ref("SELECT i.* FROM items i, JSON_TABLE(i.j, '$[*]' COLUMNS (a INT PATH '$')) j")
    ).toMatchObject({
      reason: REASON_DERIVED
    })
    expect(ref('SELECT i.* FROM items i JOIN orders o ON o.i = i.id GROUP BY i.id')).toMatchObject({
      reason: REASON_GROUPED
    })
    expect(ref('SELECT i.* FROM items i JOIN orders o ON (o.i = i.id')).toMatchObject({
      reason: REASON_UNPARSED
    })
  })

  it('refuses aggregates, which fold rows even without GROUP BY', () => {
    expect(ref('SELECT id, COUNT(*) FROM items')).toEqual({ ok: false, reason: REASON_GROUPED })
    expect(ref('SELECT i.*, MAX(o.total) FROM items i JOIN orders o')).toMatchObject({
      reason: REASON_GROUPED
    })
    // A window function keeps every row.
    expect(ref('SELECT id, COUNT(*) OVER (PARTITION BY kind) AS n FROM items')).toMatchObject({
      ok: true
    })
  })

  it('rejects subqueries in the select list', () => {
    const sql = 'SELECT id, (SELECT name FROM items i2 WHERE i2.id = t.id + 1) AS name FROM items t'
    expect(ref(sql)).toEqual({ ok: false, reason: REASON_SUBQUERY })
  })

  it('rejects GROUP BY / HAVING and set operations', () => {
    expect(ref('SELECT id, name FROM items GROUP BY name')).toEqual({
      ok: false,
      reason: REASON_GROUPED
    })
    expect(ref('SELECT id FROM items WHERE id > 1 HAVING id < 9')).toMatchObject({
      reason: REASON_GROUPED
    })
    expect(ref('SELECT id FROM items UNION SELECT id FROM decoy')).toEqual({
      ok: false,
      reason: REASON_UNION
    })
    expect(ref('SELECT 1 UNION SELECT 2')).toMatchObject({ reason: REASON_UNION })
  })

  it('rejects non-SELECT statements, SELECT without a table and parenthesised queries', () => {
    expect(ref('CALL p_items()')).toMatchObject({ reason: REASON_NOT_SIMPLE })
    expect(ref('TABLE items')).toMatchObject({ reason: REASON_NOT_SIMPLE })
    expect(ref('(SELECT * FROM items)')).toMatchObject({ reason: REASON_NOT_SIMPLE })
    expect(ref('SELECT 1')).toMatchObject({ reason: REASON_NO_TABLE })
    expect(ref('SELECT 1 FROM DUAL')).toMatchObject({ reason: REASON_NO_TABLE })
    expect(ref('SELECT id INTO @x FROM items')).toMatchObject({ reason: REASON_NOT_SIMPLE })
    expect(ref('')).toMatchObject({ ok: false })
  })

  it('rejects executable comments and anything it cannot parse', () => {
    expect(ref('SELECT * FROM items /*! JOIN decoy */')).toEqual({
      ok: false,
      reason: REASON_UNPARSED
    })
    expect(ref("SELECT * FROM items WHERE name = 'open")).toMatchObject({ reason: REASON_UNPARSED })
    expect(ref('SELECT * FROM items WHERE (id = 1')).toMatchObject({ reason: REASON_UNPARSED })
    expect(ref('SELECT * FROM items PROCEDURE ANALYSE()')).toMatchObject({ ok: false })
    expect(ref('SELECT * FROM JSON_TABLE(...) t')).toMatchObject({ ok: false })
  })
})
