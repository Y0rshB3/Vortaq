import { describe, expect, it } from 'vitest'
import { REASON_DERIVED, REASON_GROUPED, REASON_NOT_SIMPLE, REASON_UNPARSED } from './selectSource'
import { pgSingleTableSelect } from './selectSourcePg'

describe('pgSingleTableSelect', () => {
  it('reads one table, folding unquoted names like the server', () => {
    expect(pgSingleTableSelect('SELECT * FROM ONLY Ventas."Pedidos" p FOR UPDATE')).toEqual({
      ok: true,
      ref: { schema: 'ventas', table: 'Pedidos', alias: 'p' }
    })
  })

  it('reads joined tables and the select list', () => {
    expect(
      pgSingleTableSelect(
        'SELECT p.*, c."Nombre" AS cliente, 1 FROM ventas.pedidos p LEFT JOIN ventas.clientes c ON c.id = p.cliente_id OFFSET 5'
      )
    ).toEqual({
      ok: true,
      ref: { schema: 'ventas', table: 'pedidos', alias: 'p' },
      joined: {
        tables: [
          { schema: 'ventas', table: 'pedidos', alias: 'p' },
          { schema: 'ventas', table: 'clientes', alias: 'c' }
        ],
        items: [
          { kind: 'star', qualifier: ['p'] },
          { kind: 'column', qualifier: ['c'], name: 'Nombre' },
          { kind: 'expression' }
        ]
      }
    })
    expect(
      pgSingleTableSelect('SELECT DISTINCT a.id FROM a FULL OUTER JOIN b USING (id)')
    ).toMatchObject({ ok: true, joined: { items: [{ kind: 'column', name: 'id' }] } })
  })

  it.each([
    ['SELECT a.* FROM a JOIN LATERAL (SELECT 1) x ON true', REASON_DERIVED],
    ['SELECT a.* FROM a CROSS JOIN generate_series(1, 3) g', REASON_NOT_SIMPLE],
    ['SELECT a.* FROM a JOIN b TABLESAMPLE SYSTEM (1) ON true', REASON_NOT_SIMPLE],
    ['SELECT a.* FROM a JOIN b x (c1, c2) ON true', REASON_NOT_SIMPLE],
    ['SELECT (a).* FROM a JOIN b ON true', REASON_UNPARSED],
    ['SELECT DISTINCT ON (a.k) a.* FROM a JOIN b ON true', REASON_UNPARSED],
    ["SELECT string_agg(a.x, ',') FROM a", REASON_GROUPED],
    ['SELECT count(*) FILTER (WHERE a.x) FROM a', REASON_GROUPED]
  ])('refuses %s', (sql, reason) => {
    expect(pgSingleTableSelect(sql)).toEqual({ ok: false, reason })
  })

  it('accepts window functions, FILTER included', () => {
    expect(
      pgSingleTableSelect('SELECT id, count(*) FILTER (WHERE x) OVER (PARTITION BY k) FROM a')
    ).toMatchObject({ ok: true })
  })
})
