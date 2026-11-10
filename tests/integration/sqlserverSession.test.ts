/**
 * SQL Server 2022 sessions, values and batches straight on the driver
 * connection (src/main/sqlserver). Server: docker compose service `mssql22`
 * on 127.0.0.1:51433 (VORTAQ_TEST_MSSQL_URL); its certificate is self-signed.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import { defaultSqlServerOptions } from '@shared/engines'
import { MsDriverConnection } from '@main/sqlserver/connection'
import { executeMsScript } from '@main/sqlserver/query'
import { describeServer, SQLSERVER_TARGET } from './targets'

export function sqlServerConfig(
  u: URL,
  overrides: Partial<ConnectionConfig> = {}
): ConnectionConfig {
  return {
    id: 'ms-it',
    name: 'MS IT',
    color: null,
    environment: 'local',
    host: u.hostname,
    port: Number(u.port || 1433),
    username: decodeURIComponent(u.username),
    savePassword: true,
    customDatabases: [],
    initialQueries: '',
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      savePassword: false
    },
    ssl: { enabled: true, verifyServer: false },
    backupDir: '',
    extraBackupDirs: [],
    createdAt: '',
    updatedAt: '',
    engine: 'sqlserver',
    sqlserver: { ...defaultSqlServerOptions(), trustServerCertificate: true },
    ...overrides
  }
}

describeServer(SQLSERVER_TARGET, 'SQL Server sessions (integration)', (url) => {
  let connection: MsDriverConnection

  beforeAll(async () => {
    const u = new URL(url)
    connection = new MsDriverConnection({
      config: sqlServerConfig(u),
      endpoint: { host: u.hostname, port: Number(u.port || 1433) },
      password: decodeURIComponent(u.password),
      onFatal: () => undefined
    })
    await connection.probe()
  })

  afterAll(async () => {
    if (connection) {
      await connection.closeDatabase('vortaq_ms_it')
      const s = await connection.acquire(null)
      try {
        await s.exec(
          "IF DB_ID(N'vortaq_ms_it') IS NOT NULL BEGIN ALTER DATABASE vortaq_ms_it SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE vortaq_ms_it END"
        )
      } finally {
        await s.release()
      }
      await connection.close()
    }
  })

  it('reads the version and the initial database', () => {
    expect(connection.serverVersion).toMatch(/^16\./)
    expect(connection.initialDatabase).toBe('master')
  })

  it('keeps exact decimals, money and temporal values', async () => {
    const s = await connection.acquire(null)
    try {
      const [row] = await s.query(
        `SELECT CAST(12.50 AS decimal(10,2)) AS d, CAST(123456789012345678.1234 AS decimal(38,4)) AS big,
                CAST(-1.5 AS money) AS m, CAST(9.99 AS smallmoney) AS sm,
                CAST('2026-01-02 03:04:05.1234567' AS datetime2(7)) AS dt2,
                CAST('2026-01-02 03:04:05.1234567 -05:00' AS datetimeoffset(7)) AS dto,
                CAST('2026-01-02T03:04:05.123' AS datetime) AS dt,
                CAST('2026-01-02 03:04' AS smalldatetime) AS sdt,
                CAST('03:04:05.12' AS time(2)) AS t, CAST('0001-01-01' AS date) AS d0,
                CAST(9223372036854775807 AS bigint) AS bi, CAST(1 AS bit) AS b,
                CAST(0x01AB AS varbinary(10)) AS bin, NEWID() AS g`
      )
      expect(row).toMatchObject({
        d: '12.50',
        big: '123456789012345678.1234',
        m: '-1.5000',
        sm: '9.9900',
        dt2: '2026-01-02 03:04:05.1234567',
        dto: '2026-01-02 03:04:05.1234567 -05:00',
        dt: '2026-01-02 03:04:05.123',
        sdt: '2026-01-02 03:04:00',
        t: '03:04:05.12',
        d0: '0001-01-01',
        bi: '9223372036854775807',
        b: true
      })
      expect(Buffer.isBuffer(row.bin)).toBe(true)
      expect(String(row.g)).toMatch(/^[0-9A-F-]{36}$/)
    } finally {
      await s.release()
    }
  })

  it('runs a batch in order: rows, counts, errors that do not stop it, PRINT', async () => {
    const s = await connection.acquire(null)
    try {
      const results = await executeMsScript(
        s,
        [
          'DECLARE @t TABLE (a int)',
          'INSERT @t VALUES (1), (2)',
          "PRINT 'hola'",
          'SELECT a FROM @t ORDER BY a',
          'SELECT 1 / 0 AS boom',
          'SELECT 2 AS after_error',
          'GO',
          'SELECT 3 AS second_batch'
        ].join('\n'),
        { stopOnError: false }
      )
      expect(results.map((r) => [r.affectedRows, r.resultSet?.rows ?? null, !!r.error])).toEqual([
        [2, null, false],
        [null, [[1], [2]], false],
        [null, [], false],
        [null, null, true],
        [null, [[2]], false],
        [null, [[3]], false]
      ])
      expect(results[1].notices).toEqual(['hola'])
      expect(results[3].error).toMatch(/Divide by zero.*\(8134\)/)
      expect(results[3].errorPosition).toBe(results[3].sql.indexOf('SELECT 1 / 0'))
    } finally {
      await s.release()
    }
  })

  it('a single query is described: source table, column and key', async () => {
    const s = await connection.acquire(null)
    try {
      await s.exec(
        "IF OBJECT_ID('tempdb..#ignored') IS NULL SELECT 1; IF DB_ID('vortaq_ms_it') IS NULL CREATE DATABASE vortaq_ms_it"
      )
    } finally {
      await s.release()
    }
    const t = await connection.acquire({ database: 'vortaq_ms_it', schema: null })
    try {
      await t.exec(
        'DROP TABLE IF EXISTS dbo.people; CREATE TABLE dbo.people (id int IDENTITY PRIMARY KEY, name nvarchar(50) NOT NULL, price decimal(10,2))'
      )
      await t.exec("INSERT dbo.people (name, price) VALUES (N'Ana', 10.5), (N'Luis', NULL)")
      const [result] = await executeMsScript(
        t,
        'SELECT p.id, p.name AS who, price * 2 AS twice FROM dbo.people p',
        {}
      )
      expect(
        result.resultSet?.columns.map((c) => [
          c.name,
          c.type,
          c.table ?? null,
          c.sourceName ?? null,
          c.primaryKey ?? false
        ])
      ).toEqual([
        ['id', 'int', 'people', 'id', true],
        ['who', 'nvarchar(50)', 'people', 'name', false],
        ['twice', 'decimal(12,2)', null, null, false]
      ])
      expect(result.resultSet?.rows).toEqual([
        [1, 'Ana', '21.00'],
        [2, 'Luis', null]
      ])
    } finally {
      await t.release()
    }
  })

  it('caps rows and stops a single query at the cap; cancels a running batch', async () => {
    const s = await connection.acquire(null)
    try {
      const [capped] = await executeMsScript(
        s,
        'SELECT TOP 5000 a.object_id FROM sys.all_objects a CROSS JOIN sys.all_objects b',
        { maxRows: 10 }
      )
      expect(capped.resultSet?.rows).toHaveLength(10)
      expect(capped.resultSet?.truncated).toBe(true)
      expect(capped.error).toBeNull()
      // The session still works after the attention.
      expect(await s.query('SELECT 7 AS x')).toEqual([{ x: 7 }])
      const run = executeMsScript(s, "WAITFOR DELAY '00:00:20'; SELECT 1 AS never", {})
      await new Promise((r) => setTimeout(r, 300))
      expect(s.cancel()).toBe(true)
      const results = await run
      expect(results.at(-1)?.error).toMatch(/cancelada/)
      expect(await s.query('SELECT 8 AS x')).toEqual([{ x: 8 }])
    } finally {
      await s.release()
    }
  })
})
