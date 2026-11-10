/**
 * MCP server (src/main/mcp) against SQL Server 2022: databases with schemas,
 * tables and describe, run_query with exact values in a transaction that is
 * always rolled back, writes refused below the write level and on production,
 * the estimated plan of explain_query (the SELECT never runs), a timeout that
 * cancels on the server, and redaction of real driver errors.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import { defaultSqlServerOptions } from '@shared/engines'
import { isMsConnection } from '@main/sqlserver/connection'
import { SQLSERVER_TARGET, describeServer } from './targets'
import { baseInput, closedPort, startMcpHarness, type McpHarness } from './mcpHarness'

describeServer(SQLSERVER_TARGET, 'MCP server', (url) => {
  const u = new URL(url)
  const DB = `vortaq_mcp_${process.pid}`
  const server = {
    engine: 'sqlserver',
    host: u.hostname,
    port: Number(u.port || 1433),
    username: decodeURIComponent(u.username),
    ssl: { enabled: true, verifyServer: false },
    sqlserver: {
      ...defaultSqlServerOptions(),
      initialDatabase: 'master',
      trustServerCertificate: true
    },
    network: { connectTimeoutMs: 15000, keepAliveSec: 0 }
  } satisfies Partial<ConnectionInput>
  const password = decodeURIComponent(u.password)
  let h: McpHarness

  async function admin<T>(sql: string, database = DB): Promise<T[]> {
    const connection = await h.runtime.manager.connection(h.byName('Admin').id)
    if (!isMsConnection(connection)) throw new Error('not SQL Server')
    const s = await connection.acquire({ database, schema: null })
    try {
      s.usage.userSql = true
      return await s.query<T>(sql)
    } finally {
      await s.release()
    }
  }
  const count = async (table: string): Promise<number> =>
    Number((await admin<{ n: unknown }>(`SELECT COUNT(*) AS n FROM dbo.${table}`))[0].n)

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
    await admin(
      `IF DB_ID(N'${DB}') IS NOT NULL BEGIN ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}] END`,
      'master'
    )
    await admin(`CREATE DATABASE [${DB}]`, 'master')
    await admin(
      `CREATE TABLE dbo.clientes (id int PRIMARY KEY, nombre nvarchar(40) NOT NULL, saldo decimal(20,6), foto varbinary(10));
       CREATE TABLE dbo.pedidos (id int PRIMARY KEY, cliente_id int NOT NULL REFERENCES dbo.clientes (id), total money);
       CREATE INDEX IX_pedidos_cliente ON dbo.pedidos (cliente_id);
       INSERT dbo.clientes VALUES (1, N'Ana', 12345678901234.123456, 0x00FF10), (2, N'Luis', NULL, NULL);
       INSERT dbo.pedidos VALUES (1, 1, 10.50), (2, 1, 20), (3, 2, 7.25);`
    )
  }, 120_000)

  afterAll(async () => {
    await admin(
      `ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}]`,
      'master'
    ).catch(() => undefined)
    await h?.close()
  })

  it('lists databases with their schemas, tables and describes a table', async () => {
    const dbs = await h.ok('list_databases', { connection: 'Esquema' })
    expect(dbs.default_database).toBe('master')
    const mine = dbs.databases.find((d: { name: string }) => d.name === DB)
    expect(mine.schemas).toEqual(['dbo'])
    const tables = (await h.ok('list_tables', { connection: 'Esquema', database: DB })).tables
    expect(tables.map((t: { name: string }) => t.name).sort()).toEqual(['clientes', 'pedidos'])
    const pedidos = await h.ok('describe_table', {
      connection: 'Esquema',
      database: DB,
      table: 'pedidos'
    })
    expect(pedidos.schema).toBe('dbo')
    expect(pedidos.foreign_keys[0]).toMatchObject({
      columns: ['cliente_id'],
      references: { schema: 'dbo', table: 'clientes', columns: ['id'] }
    })
    expect(JSON.stringify(pedidos)).not.toMatch(/Ana|Luis/)
  })

  it('run_query returns exact values and refuses writes', async () => {
    const r = await h.ok('run_query', {
      connection: 'Lectura',
      database: DB,
      schema: 'dbo',
      sql: 'SELECT id, nombre, saldo, foto FROM dbo.clientes ORDER BY id'
    })
    expect(r.rows).toEqual([
      [1, 'Ana', '12345678901234.123456', { type: 'binary', bytes: 3, hex: '00FF10' }],
      [2, 'Luis', null, null]
    ])
    for (const sql of [
      'DELETE FROM dbo.pedidos',
      'SELECT * INTO dbo.copia FROM dbo.pedidos',
      "EXEC sp_executesql N'DELETE FROM dbo.pedidos'",
      'SELECT 1 SELECT 2'
    ])
      expect(await h.refused('run_query', { connection: 'Lectura', database: DB, sql })).toMatch(
        /run_query|una única sentencia/
      )
    expect(await count('pedidos')).toBe(3)
  })

  it('execute_sql writes at the write level; refused at read level and on production', async () => {
    const r = await h.ok('execute_sql', {
      connection: 'Escritura',
      database: DB,
      schema: 'dbo',
      sql: "INSERT dbo.pedidos VALUES (4, 2, 1); PRINT 'hecho'; SELECT COUNT(*) AS n FROM dbo.pedidos"
    })
    expect(JSON.stringify(r)).toMatch(/hecho/)
    expect(await count('pedidos')).toBe(4)
    expect(
      await h.refused('execute_sql', {
        connection: 'Lectura',
        database: DB,
        sql: 'DELETE FROM dbo.pedidos'
      })
    ).toMatch(/execute_sql necesita/)
    expect(
      await h.refused('execute_sql', {
        connection: 'Producción',
        database: DB,
        sql: 'DELETE FROM dbo.pedidos'
      })
    ).toMatch(/producción/)
    expect(await count('pedidos')).toBe(4)
  })

  it('explain_query returns the estimated plan without running the SELECT', async () => {
    const r = await h.ok('explain_query', {
      connection: 'Lectura',
      database: DB,
      sql: 'SELECT * FROM dbo.pedidos WHERE cliente_id = 1'
    })
    expect(r.plan).toMatch(/Index (Seek|Scan)|Clustered/)
    expect(
      await h.refused('explain_query', {
        connection: 'Lectura',
        database: DB,
        sql: 'DELETE FROM dbo.pedidos'
      })
    ).toMatch(/SELECT/)
  })

  it('a timeout cancels the statement on the server', async () => {
    const started = Date.now()
    expect(
      await h.refused('run_query', {
        connection: 'Lectura',
        database: DB,
        // A recursive CTE of 10^9 steps: minutes of work unless the attention stops it.
        sql: 'WITH n AS (SELECT CAST(1 AS bigint) AS i UNION ALL SELECT i + 1 FROM n WHERE i < 1000000000) SELECT MAX(i) AS m FROM n OPTION (MAXRECURSION 0)',
        timeout_seconds: 1
      })
    ).toMatch(/tiempo límite/)
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('redacts real connection-refused and authentication errors', async () => {
    const refused = await h.refused('list_databases', { connection: 'Apagado' })
    expect(refused).not.toContain(String(h.byName('Apagado').port))
    const auth = await h.refused('list_databases', { connection: 'Clave mala' })
    expect(auth).toMatch(/contraseña|password|Login failed|18456/i)
    expect(auth).not.toContain('not-the-password')
  })
})
