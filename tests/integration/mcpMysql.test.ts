/**
 * MCP server (src/main/mcp) against MySQL 8.4 and 5.7 and MariaDB 11: structure
 * tools, run_query in a new read-only session (a writing stored function is
 * stopped by the session, not only by the guard), a timeout that kills the
 * statement on the server, execute_sql at the write level and its refusal at
 * the read level and on production, and redaction of real driver errors.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import type { PooledSession } from '@main/mysql/session'
import { MARIADB_TARGET, describeMysql, describeServer } from './targets'
import { baseInput, closedPort, startMcpHarness, until, type McpHarness } from './mcpHarness'

function suite(url: string, engine: 'mysql' | 'mariadb'): void {
  const DB = `vortaq_mcp_${engine}_${process.pid}`
  const u = new URL(url)
  const server = {
    engine,
    host: u.hostname,
    port: Number(u.port || 3306),
    username: decodeURIComponent(u.username)
  } satisfies Partial<ConnectionInput>
  const password = decodeURIComponent(u.password)
  let h: McpHarness

  const session = async <T>(fn: (s: PooledSession) => Promise<T>): Promise<T> => {
    const s = await h.runtime.manager.acquire(h.byName('Admin').id, null)
    try {
      return await fn(s)
    } finally {
      await s.release()
    }
  }
  const count = (table: string) =>
    session(async (s) =>
      Number(
        (await s.query<{ n: unknown }>(`SELECT COUNT(*) AS n FROM \`${DB}\`.\`${table}\``))[0].n
      )
    )

  beforeAll(async () => {
    const refused = await closedPort()
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
        input: baseInput({
          ...server,
          name: 'Clave mala',
          mcp: { enabled: true, access: 'read' }
        }),
        password: 'not-the-password'
      },
      {
        input: baseInput({
          ...server,
          name: 'Apagado',
          host: '127.0.0.1',
          port: refused,
          mcp: { enabled: true, access: 'read' }
        }),
        password
      }
    ])
    await session(async (s) => {
      for (const sql of [
        `DROP DATABASE IF EXISTS \`${DB}\``,
        `CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4`,
        `CREATE TABLE \`${DB}\`.clientes (id INT PRIMARY KEY, nombre VARCHAR(80) NOT NULL, saldo DECIMAL(20,6) NULL, big BIGINT UNSIGNED NULL, foto VARBINARY(8) NULL, UNIQUE KEY uk_nombre (nombre))`,
        `CREATE TABLE \`${DB}\`.pedidos (id INT PRIMARY KEY, cliente_id INT NOT NULL, total DECIMAL(10,2), KEY ix_cliente (cliente_id), CONSTRAINT fk_cliente FOREIGN KEY (cliente_id) REFERENCES \`${DB}\`.clientes(id))`,
        `CREATE VIEW \`${DB}\`.resumen AS SELECT cliente_id, COUNT(*) AS n FROM \`${DB}\`.pedidos GROUP BY cliente_id`,
        `INSERT INTO \`${DB}\`.clientes VALUES (1, 'Ana', 12345678901234.123456, 18446744073709551615, 0x00FF10), (2, 'Luis', NULL, NULL, NULL)`,
        `INSERT INTO \`${DB}\`.pedidos VALUES (1, 1, 10.50), (2, 1, 20.00), (3, 2, 7.25)`,
        `CREATE FUNCTION \`${DB}\`.f_write() RETURNS INT DETERMINISTIC MODIFIES SQL DATA
           BEGIN INSERT INTO pedidos VALUES (99, 1, 0); RETURN 1; END`
      ])
        await s.execute(sql)
    })
  }, 120_000)

  afterAll(async () => {
    await session((s) => s.execute(`DROP DATABASE IF EXISTS \`${DB}\``)).catch(() => undefined)
    await h?.close()
  })

  it('lists databases (no system ones), tables and views, and describes a table', async () => {
    const dbs = (await h.ok('list_databases', { connection: 'Esquema' })).databases.map(
      (d: { name: string }) => d.name
    )
    expect(dbs).toContain(DB)
    expect(dbs).not.toContain('mysql')
    expect(dbs).not.toContain('information_schema')
    const tables = (await h.ok('list_tables', { connection: 'Esquema', database: DB })).tables
    expect(tables.map((t: { name: string; kind: string }) => `${t.name}:${t.kind}`).sort()).toEqual(
      ['clientes:table', 'pedidos:table', 'resumen:view']
    )
    const pedidos = await h.ok('describe_table', {
      connection: 'Esquema',
      database: DB,
      table: 'pedidos'
    })
    expect(pedidos.primary_key).toEqual(['id'])
    expect(pedidos.columns.find((c: { name: string }) => c.name === 'cliente_id')).toMatchObject({
      nullable: false
    })
    expect(pedidos.foreign_keys[0]).toMatchObject({
      name: 'fk_cliente',
      columns: ['cliente_id'],
      references: { table: 'clientes', columns: ['id'] }
    })
    expect(pedidos.indexes.map((i: { name: string }) => i.name)).toEqual(
      expect.arrayContaining(['PRIMARY', 'ix_cliente'])
    )
    expect(JSON.stringify(pedidos)).not.toMatch(/Ana|Luis/)
    expect(await h.refused('run_query', { connection: 'Esquema', sql: 'SELECT 1' })).toMatch(
      /Solo estructura/
    )
  })

  it('run_query returns exact values in a read-only session', async () => {
    const r = await h.ok('run_query', {
      connection: 'Lectura',
      database: DB,
      sql: 'SELECT id, nombre, saldo, big, foto FROM clientes ORDER BY id'
    })
    expect(r.read_only_session).toBe(true)
    expect(r.rows).toEqual([
      [
        1,
        'Ana',
        '12345678901234.123456',
        '18446744073709551615',
        { type: 'binary', bytes: 3, hex: '00FF10' }
      ],
      [2, 'Luis', null, null, null]
    ])
    const few = await h.ok('run_query', {
      connection: 'Lectura',
      sql: `SELECT id FROM \`${DB}\`.pedidos ORDER BY id`,
      max_rows: 2
    })
    expect(few.rows).toEqual([[1], [2]])
    expect(few.truncated).toBe(true)
  })

  it('run_query refuses writes, and the read-only session stops a writing function', async () => {
    for (const sql of [
      'DELETE FROM pedidos',
      'SELECT 1; DELETE FROM pedidos',
      'SELECT * FROM pedidos FOR UPDATE'
    ])
      expect(await h.refused('run_query', { connection: 'Lectura', database: DB, sql })).toMatch(
        /run_query/
      )
    const fn = await h.refused('run_query', {
      connection: 'Lectura',
      database: DB,
      sql: 'SELECT f_write() AS x'
    })
    expect(fn).toMatch(/READ ONLY|read-only|1792/i)
    expect(await count('pedidos')).toBe(3)
  })

  it('a timeout cancels the statement on the server (KILL QUERY)', async () => {
    const marker = `vortaq_mcp_timeout_${engine}`
    const started = Date.now()
    const message = await h.refused('run_query', {
      connection: 'Lectura',
      sql: `SELECT SLEEP(60) AS ${marker}`,
      timeout_seconds: 1
    })
    expect(message).toMatch(/tiempo límite de 1 s.*cancel/)
    expect(Date.now() - started).toBeLessThan(10_000)
    await until(async () =>
      session(async (s) => {
        const rows = await s.query<{ n: unknown }>(
          `SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE '%${marker}%' AND INFO NOT LIKE '%PROCESSLIST%'`
        )
        return Number(rows[0].n) === 0
      })
    )
    expect(h.activity.at(-1)).toMatchObject({ tool: 'run_query', outcome: 'timeout' })
  })

  it('execute_sql writes at the write level; refused at read level and on production', async () => {
    const r = await h.ok('execute_sql', {
      connection: 'Escritura',
      database: DB,
      sql: 'INSERT INTO pedidos VALUES (4, 2, 1.00); UPDATE clientes SET saldo = 5 WHERE id = 2; SELECT COUNT(*) AS n FROM pedidos'
    })
    expect(r.statements[0].affected_rows).toBe(1)
    expect(r.statements[1].affected_rows).toBe(1)
    expect(r.statements[2].result.rows).toEqual([[4]])
    expect(await count('pedidos')).toBe(4)
    expect(
      await h.refused('execute_sql', {
        connection: 'Lectura',
        database: DB,
        sql: 'DELETE FROM pedidos'
      })
    ).toMatch(/«Lectura».*execute_sql/)
    expect(
      await h.refused('execute_sql', {
        connection: 'Producción',
        database: DB,
        sql: 'DELETE FROM pedidos'
      })
    ).toMatch(/producción.*nunca puede escribir/)
    expect(await count('pedidos')).toBe(4)
    // A failing statement stops the script; the error is the server's (redacted).
    const failing = await h.ok('execute_sql', {
      connection: 'Escritura',
      database: DB,
      sql: 'INSERT INTO pedidos VALUES (5, 999, 1); SELECT 1'
    })
    expect(failing.stopped_at_error).toBe(true)
    expect(failing.statements[0].error).toMatch(/foreign key/i)
  })

  it('explain_query returns the plan without running the statement', async () => {
    const r = await h.ok('explain_query', {
      connection: 'Lectura',
      database: DB,
      sql: 'SELECT * FROM pedidos WHERE cliente_id = 1'
    })
    expect(r.plan).toMatch(/pedidos/)
    expect(r.plan).toMatch(/ix_cliente|ref|ALL/)
  })

  it('redacts real connection-refused and authentication errors', async () => {
    const refused = await h.refused('list_databases', { connection: 'Apagado' })
    expect(refused).toMatch(/ECONNREFUSED|conectar|refused/i)
    expect(refused).not.toContain('127.0.0.1')
    expect(refused).not.toContain(String(h.byName('Apagado').port))
    const auth = await h.refused('list_databases', { connection: 'Clave mala' })
    expect(auth).toMatch(/denied|contraseña|Access/i)
    expect(auth).not.toContain(`'${server.username}'@`)
    expect(auth).not.toMatch(/\d+\.\d+\.\d+\.\d+/)
    expect(auth).not.toContain('not-the-password')
  })
}

describeMysql('MCP server', (target) => suite(target.url, 'mysql'))
describeServer(MARIADB_TARGET, 'MCP server (mariadb engine)', (url) => suite(url, 'mariadb'))
