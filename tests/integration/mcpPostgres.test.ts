/**
 * MCP server (src/main/mcp) against PostgreSQL 17: databases with schemas,
 * tables of one or every schema, describe with constraints, run_query in a
 * BEGIN READ ONLY session (a VOLATILE function that writes is stopped there),
 * a timeout that pg_cancel_backend's the statement, execute_sql by level and
 * environment, explain without ANALYZE, and redaction of real driver errors.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import { defaultPostgresOptions } from '@shared/engines'
import { isPgConnection } from '@main/postgres/connection'
import { POSTGRES_TARGET, describeServer } from './targets'
import { baseInput, closedPort, startMcpHarness, until, type McpHarness } from './mcpHarness'

describeServer(POSTGRES_TARGET, 'MCP server', (url) => {
  const u = new URL(url)
  const DB = u.pathname.replace(/^\//, '') || 'postgres'
  const SCHEMA = `vortaq_mcp_${process.pid}`
  /** A table name no other schema has: describe_table finds its schema alone. */
  const SOLO = `vortaq_mcp_solo_${process.pid}`
  const server = {
    engine: 'postgresql',
    host: u.hostname,
    port: Number(u.port || 5432),
    username: decodeURIComponent(u.username),
    postgres: { ...defaultPostgresOptions(), initialDatabase: DB },
    network: { connectTimeoutMs: 5000, keepAliveSec: 0 }
  } satisfies Partial<ConnectionInput>
  const password = decodeURIComponent(u.password)
  let h: McpHarness

  async function admin<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const connection = await h.runtime.manager.connection(h.byName('Admin').id)
    if (!isPgConnection(connection)) throw new Error('not pg')
    const s = await connection.acquire({ database: DB, schema: null })
    try {
      return await s.query<T>(sql, params)
    } finally {
      await s.release()
    }
  }
  const count = async (table: string) =>
    Number((await admin<{ n: unknown }>(`SELECT COUNT(*) AS n FROM "${SCHEMA}".${table}`))[0].n)

  beforeAll(async () => {
    const refusedPort = await closedPort()
    h = await startMcpHarness([
      { input: baseInput({ ...server, name: 'Admin' }), password },
      {
        input: baseInput({ ...server, name: 'Lectura', mcp: { enabled: true, access: 'read' } }),
        password
      },
      {
        input: baseInput({ ...server, name: 'Escritura', mcp: { enabled: true, access: 'write' } }),
        password
      },
      {
        input: baseInput({
          ...server,
          name: 'Producción',
          environment: 'production',
          mcp: { enabled: true, access: 'write' }
        }),
        password
      },
      {
        input: baseInput({
          ...server,
          name: 'Esquema',
          mcp: { enabled: true, access: 'structure' }
        }),
        password
      },
      {
        input: baseInput({ ...server, name: 'Clave mala', mcp: { enabled: true, access: 'read' } }),
        password: 'not-the-password'
      },
      {
        input: baseInput({
          ...server,
          name: 'Apagado',
          host: '127.0.0.1',
          port: refusedPort,
          mcp: { enabled: true, access: 'read' }
        }),
        password
      }
    ])
    for (const sql of [
      `DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`,
      `CREATE SCHEMA "${SCHEMA}"`,
      `CREATE TABLE "${SCHEMA}".clientes (id int PRIMARY KEY, nombre text NOT NULL, saldo numeric(20,6), big bigint, foto bytea, CONSTRAINT saldo_ok CHECK (saldo >= 0))`,
      `CREATE TABLE "${SCHEMA}".pedidos (id int PRIMARY KEY, cliente_id int NOT NULL REFERENCES "${SCHEMA}".clientes(id), total numeric(10,2))`,
      `CREATE INDEX pedidos_cliente ON "${SCHEMA}".pedidos(cliente_id)`,
      `CREATE TABLE "${SCHEMA}".${SOLO} (id int PRIMARY KEY)`,
      `CREATE VIEW "${SCHEMA}".resumen AS SELECT cliente_id, count(*) AS n FROM "${SCHEMA}".pedidos GROUP BY cliente_id`,
      `CREATE MATERIALIZED VIEW "${SCHEMA}".totales AS SELECT sum(total) AS t FROM "${SCHEMA}".pedidos`,
      `INSERT INTO "${SCHEMA}".clientes VALUES (1, 'Ana', 12345678901234.123456, 9007199254740993, '\\x00ff10'), (2, 'Luis', NULL, NULL, NULL)`,
      `INSERT INTO "${SCHEMA}".pedidos VALUES (1, 1, 10.50), (2, 1, 20.00), (3, 2, 7.25)`,
      `CREATE FUNCTION "${SCHEMA}".f_write() RETURNS int LANGUAGE sql VOLATILE AS $$ INSERT INTO "${SCHEMA}".pedidos VALUES (99, 1, 0) RETURNING 1 $$`
    ])
      await admin(sql)
  }, 120_000)

  afterAll(async () => {
    await admin(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => undefined)
    await h?.close()
  })

  it('lists databases with their schemas, tables of a schema and describes a table', async () => {
    const dbs = await h.ok('list_databases', { connection: 'Esquema' })
    expect(dbs.default_database).toBe(DB)
    const mine = dbs.databases.find((d: { name: string }) => d.name === DB)
    expect(mine.schemas).toEqual(expect.arrayContaining(['public', SCHEMA]))
    expect(mine.schemas).not.toContain('pg_catalog')
    const tables = (await h.ok('list_tables', { connection: 'Esquema', schema: SCHEMA })).tables
    expect(tables.map((t: { name: string; kind: string }) => `${t.name}:${t.kind}`).sort()).toEqual(
      [
        'clientes:table',
        'pedidos:table',
        'resumen:view',
        'totales:materialized_view',
        `${SOLO}:table`
      ].sort()
    )
    // Without a schema: every user schema, each table with its schema.
    const all = (await h.ok('list_tables', { connection: 'Esquema' })).tables
    expect(all).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'pedidos', schema: SCHEMA })])
    )
    expect((await h.ok('describe_table', { connection: 'Esquema', table: SOLO })).schema).toBe(
      SCHEMA
    )
    const clientes = await h.ok('describe_table', {
      connection: 'Esquema',
      schema: SCHEMA,
      table: 'clientes'
    })
    expect(clientes.schema).toBe(SCHEMA)
    expect(clientes.primary_key).toEqual(['id'])
    expect(clientes.constraints).toEqual([
      expect.objectContaining({ name: 'saldo_ok', type: 'check' })
    ])
    const pedidos = await h.ok('describe_table', {
      connection: 'Esquema',
      schema: SCHEMA,
      table: 'pedidos'
    })
    expect(pedidos.foreign_keys[0]).toMatchObject({
      columns: ['cliente_id'],
      references: { schema: SCHEMA, table: 'clientes', columns: ['id'] }
    })
    expect(JSON.stringify([clientes, pedidos])).not.toMatch(/Ana|Luis/)
  })

  it('run_query returns exact values in the schema it is given', async () => {
    const r = await h.ok('run_query', {
      connection: 'Lectura',
      schema: SCHEMA,
      sql: 'SELECT id, nombre, saldo, big, foto FROM clientes ORDER BY id'
    })
    expect(r.rows).toEqual([
      [
        1,
        'Ana',
        '12345678901234.123456',
        '9007199254740993',
        { type: 'binary', bytes: 3, hex: '00FF10' }
      ],
      [2, 'Luis', null, null, null]
    ])
  })

  it('run_query refuses writes, and BEGIN READ ONLY stops a writing function', async () => {
    for (const sql of [
      'DELETE FROM pedidos',
      'SELECT 1; SELECT 2',
      'SELECT * FROM pedidos FOR UPDATE'
    ])
      expect(await h.refused('run_query', { connection: 'Lectura', schema: SCHEMA, sql })).toMatch(
        /run_query/
      )
    expect(
      await h.refused('run_query', {
        connection: 'Lectura',
        schema: SCHEMA,
        sql: 'SELECT f_write()'
      })
    ).toMatch(/read-only transaction|solo lectura/i)
    expect(await count('pedidos')).toBe(3)
  })

  it('a timeout cancels the statement on the server (pg_cancel_backend)', async () => {
    const marker = 'vortaq_mcp_pg_timeout'
    const started = Date.now()
    expect(
      await h.refused('run_query', {
        connection: 'Lectura',
        sql: `SELECT pg_sleep(60) AS ${marker}`,
        timeout_seconds: 1
      })
    ).toMatch(/tiempo límite/)
    expect(Date.now() - started).toBeLessThan(10_000)
    await until(async () => {
      const rows = await admin<{ n: unknown }>(
        `SELECT count(*) AS n FROM pg_stat_activity WHERE state = 'active' AND query LIKE $1 AND pid <> pg_backend_pid()`,
        [`%${marker}%`]
      )
      return Number(rows[0].n) === 0
    })
  })

  it('execute_sql writes at the write level; refused at read level and on production', async () => {
    const r = await h.ok('execute_sql', {
      connection: 'Escritura',
      schema: SCHEMA,
      sql: "INSERT INTO pedidos VALUES (4, 2, 1); DO $$ BEGIN RAISE NOTICE 'hecho'; END $$; SELECT count(*) AS n FROM pedidos"
    })
    expect(r.statements[0].affected_rows).toBe(1)
    expect(r.statements[1].notices?.join(' ')).toMatch(/hecho/)
    expect(r.statements[2].result.rows).toEqual([[4]])
    expect(await count('pedidos')).toBe(4)
    expect(
      await h.refused('execute_sql', {
        connection: 'Lectura',
        schema: SCHEMA,
        sql: 'DELETE FROM pedidos'
      })
    ).toMatch(/execute_sql necesita/)
    expect(
      await h.refused('execute_sql', {
        connection: 'Producción',
        schema: SCHEMA,
        sql: 'DELETE FROM pedidos'
      })
    ).toMatch(/producción/)
    expect(await count('pedidos')).toBe(4)
  })

  it('explain_query returns the plan (no ANALYZE)', async () => {
    const r = await h.ok('explain_query', {
      connection: 'Lectura',
      schema: SCHEMA,
      sql: 'SELECT * FROM pedidos WHERE cliente_id = 1'
    })
    expect(r.plan).toMatch(/Scan/)
    expect(r.plan).not.toMatch(/actual time/)
    expect(
      await h.refused('explain_query', { connection: 'Lectura', sql: 'EXPLAIN ANALYZE SELECT 1' })
    ).toMatch(/SELECT/)
  })

  it('redacts real connection-refused and authentication errors', async () => {
    const refused = await h.refused('list_databases', { connection: 'Apagado' })
    expect(refused).toMatch(/ECONNREFUSED|conectar|rechaz/i)
    expect(refused).not.toContain('127.0.0.1')
    expect(refused).not.toContain(String(h.byName('Apagado').port))
    const auth = await h.refused('list_databases', { connection: 'Clave mala' })
    expect(auth).toMatch(/contraseña|password|autentic/i)
    expect(auth).not.toContain(`"${server.username}"`)
    expect(auth).not.toContain('not-the-password')
  })
})
