/**
 * «Plan de ejecución» (db:plan) against real servers: MySQL 8.4 (EXPLAIN
 * FORMAT=TREE / EXPLAIN ANALYZE), MySQL 5.7 (tabular EXPLAIN), MariaDB 11
 * (tabular EXPLAIN / ANALYZE), SQL Server 2022 (SHOWPLAN XML / STATISTICS XML)
 * and SQLite (EXPLAIN QUERY PLAN). An estimated plan of an UPDATE never
 * changes a row; an actual plan is refused for anything but a read-only SELECT.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import { defaultSqliteOptions, defaultSqlServerOptions } from '@shared/engines'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionManager } from '@main/db/manager'
import { executionPlan } from '@main/plan/service'
import { inProcessSpawner, setSqliteSpawner } from '@main/sqlite/spawner'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { describeMysql, describeServer, MARIADB_TARGET, SQLSERVER_TARGET } from './targets'

const DB = `vortaq_plan_${process.pid}`

function context(dir: string): AppContext {
  return {
    userDataPath: dir,
    logDir: join(dir, 'logs'),
    connections: new ConnectionsRepo(dir),
    jobs: new JobsRepo(dir),
    runs: new RunsRepo(dir),
    settings: new SettingsRepo(dir, dir),
    credentials: new CredentialStore(dir, plainCodec, 'plain'),
    emit: <E extends IpcEventChannel>(_c: E, _p: IpcEventMap[E]) => {},
    headless: true
  }
}

function mysqlInput(u: URL, engine: 'mysql' | 'mariadb'): ConnectionInput {
  return {
    name: `Plan ${engine}`,
    color: null,
    environment: 'local',
    host: u.hostname,
    port: Number(u.port),
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
    ssl: { enabled: false, verifyServer: false },
    backupDir: '',
    extraBackupDirs: [],
    engine
  }
}

function msInput(u: URL): ConnectionInput {
  return {
    ...mysqlInput(u, 'mysql'),
    name: 'Plan MS',
    port: Number(u.port || 1433),
    engine: 'sqlserver',
    sqlserver: { ...defaultSqlServerOptions(), trustServerCertificate: true }
  }
}

const SETUP_MYSQL = [
  `DROP DATABASE IF EXISTS ${DB}`,
  `CREATE DATABASE ${DB}`,
  `CREATE TABLE ${DB}.c (id INT PRIMARY KEY, pais VARCHAR(2))`,
  `CREATE TABLE ${DB}.p (id INT PRIMARY KEY, cliente_id INT, total DECIMAL(8,2), KEY fk_cliente (cliente_id))`,
  `INSERT INTO ${DB}.c VALUES (1,'ES'),(2,'MX'),(3,'ES')`,
  `INSERT INTO ${DB}.p VALUES (1,1,10.50),(2,1,20.00),(3,3,7.25)`
]
const JOIN = "SELECT c.pais, p.total FROM c JOIN p ON p.cliente_id = c.id WHERE c.pais = 'ES'"

function mysqlFamily(url: string, engine: 'mysql' | 'mariadb', is57: boolean): void {
  let dir: string
  let manager: ConnectionManager
  let id: string
  const plan = (sql: string, actual: boolean) =>
    executionPlan(manager, id, { sql, schema: DB, actual })

  beforeAll(async () => {
    const u = new URL(url)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-plan-'))
    const ctx = context(dir)
    id = ctx.connections.save(mysqlInput(u, engine)).id
    ctx.credentials.set('mysql', id, decodeURIComponent(u.password))
    manager = new ConnectionManager(ctx)
    const session = await manager.acquire(id)
    try {
      for (const sql of SETUP_MYSQL) await session.query(sql)
    } finally {
      await session.release()
    }
  })
  afterAll(async () => {
    const session = await manager.acquire(id).catch(() => null)
    await session?.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => undefined)
    await session?.release()
    await manager?.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('estimated plan of a join: every table and the index it uses', async () => {
    const result = await plan(JOIN, false)
    expect(result.actual).toBe(false)
    const objects: string[] = []
    const walk = (n: typeof result.root): void => {
      if (n.object) objects.push(n.object)
      n.children.forEach(walk)
    }
    walk(result.root)
    expect(objects.some((o) => o.startsWith('c'))).toBe(true)
    expect(objects.some((o) => o.startsWith('p'))).toBe(true)
    if (engine === 'mysql' && !is57) {
      expect(result.rawFormat).toBe('text')
      expect(result.root.operation.toLowerCase()).toContain('join')
      expect(result.totalCost).toBeGreaterThan(0)
    } else expect(result.root.operation).toBe('Consulta')
  })

  it('actual plan of a SELECT measures rows (MySQL 8 and MariaDB); 5.7 explains why not', async () => {
    if (is57) {
      await expect(plan(JOIN, true)).rejects.toThrow(/MySQL 8\.0\.18/)
      return
    }
    const result = await plan(JOIN, true)
    expect(result.actual).toBe(true)
    const rows: (number | null)[] = []
    const walk = (n: typeof result.root): void => {
      rows.push(n.actualRows)
      n.children.forEach(walk)
    }
    walk(result.root)
    expect(rows.some((r) => r !== null && r > 0)).toBe(true)
  })

  it('an UPDATE gets an estimated plan without changing anything, and no actual plan', async () => {
    await plan(`UPDATE p SET total = 0 WHERE cliente_id = 1`, false)
    await expect(plan(`UPDATE p SET total = 0`, true)).rejects.toThrow(/solo lectura/)
    const session = await manager.acquire(id)
    try {
      const [row] = await session.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${DB}.p WHERE total = 0`
      )
      expect(Number(row.n)).toBe(0)
    } finally {
      await session.release()
    }
    await expect(plan(`CREATE TABLE x (a int)`, false)).rejects.toThrow(/No hay plan/)
  })
}

describeMysql('db:plan', (target) => mysqlFamily(target.url, 'mysql', target.is57))
describeServer(MARIADB_TARGET, 'db:plan', (url) => mysqlFamily(url, 'mariadb', false))

describeServer(SQLSERVER_TARGET, 'db:plan', (url) => {
  let dir: string
  let manager: ConnectionManager
  let id: string
  const MS_DB = `vortaq_plan_${process.pid}`
  const ref = { database: MS_DB, schema: 'dbo' }

  beforeAll(async () => {
    const u = new URL(url)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-plan-ms-'))
    const ctx = context(dir)
    id = ctx.connections.save(msInput(u)).id
    ctx.credentials.set('mysql', id, decodeURIComponent(u.password))
    manager = new ConnectionManager(ctx)
    const { createMsDbHandlers } = await import('@main/ipc/dbSqlServer')
    const ms = createMsDbHandlers(ctx, manager)
    await ms.execute(
      id,
      `IF DB_ID(N'${MS_DB}') IS NOT NULL BEGIN ALTER DATABASE [${MS_DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${MS_DB}] END`
    )
    await ms.createDatabase(id, MS_DB, {}, {})
    const out = await ms.execute(
      id,
      `CREATE TABLE dbo.c (id int PRIMARY KEY, pais nvarchar(2));
       CREATE TABLE dbo.p (id int PRIMARY KEY, cliente_id int, total decimal(8,2));
       INSERT INTO dbo.c VALUES (1,N'ES'),(2,N'MX'),(3,N'ES');
       INSERT INTO dbo.p VALUES (1,1,10.50),(2,1,20.00),(3,3,7.25);`,
      { schema: ref }
    )
    expect(out.find((r) => r.error)?.error ?? null).toBeNull()
  })
  afterAll(async () => {
    const { createMsDbHandlers } = await import('@main/ipc/dbSqlServer')
    const ctx = context(dir)
    await createMsDbHandlers(ctx, manager)
      .execute(
        id,
        `ALTER DATABASE [${MS_DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${MS_DB}]`
      )
      .catch(() => undefined)
    await manager?.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  const JOIN_MS =
    "SELECT c.pais, p.total FROM dbo.c c JOIN dbo.p p ON p.cliente_id = c.id WHERE c.pais = N'ES'"

  it('estimated SHOWPLAN XML: operators, tables, costs adding up to 100 %', async () => {
    const result = await executionPlan(manager, id, { sql: JOIN_MS, schema: ref, actual: false })
    expect(result.rawFormat).toBe('xml')
    expect(result.totalCost).toBeGreaterThan(0)
    const nodes: (typeof result.root)[] = []
    const walk = (n: typeof result.root): void => {
      nodes.push(n)
      n.children.forEach(walk)
    }
    walk(result.root)
    expect(nodes.some((n) => /^dbo\.c\b/.test(n.object ?? ''))).toBe(true)
    expect(nodes.some((n) => /^dbo\.p\b/.test(n.object ?? ''))).toBe(true)
    const share = nodes.reduce((s, n) => s + (n.costPercent ?? 0), 0)
    expect(share).toBeGreaterThan(98)
    expect(share).toBeLessThan(102)
    expect(nodes.every((n) => n.actualRows === null)).toBe(true)
  })

  it('actual plan (STATISTICS XML) measures rows; the data is untouched', async () => {
    const result = await executionPlan(manager, id, { sql: JOIN_MS, schema: ref, actual: true })
    expect(result.actual).toBe(true)
    // Customers 1 and 3 are in ES: two orders of 1 and one of 3.
    expect(result.root.actualRows).toBe(3)
    await executionPlan(manager, id, {
      sql: 'UPDATE dbo.p SET total = 0',
      schema: ref,
      actual: false
    })
    await expect(
      executionPlan(manager, id, { sql: 'UPDATE dbo.p SET total = 0', schema: ref, actual: true })
    ).rejects.toThrow(/solo lectura/)
    const check = await executionPlan(manager, id, {
      sql: 'SELECT id FROM dbo.p WHERE total = 0',
      schema: ref,
      actual: true
    })
    expect(check.root.actualRows ?? 0).toBe(0)
  })
})

it('db:plan on SQLite: EXPLAIN QUERY PLAN, and no actual plan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortaq-plan-lite-'))
  const file = join(dir, 'tienda.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE c (id INTEGER PRIMARY KEY, pais TEXT);
    CREATE TABLE p (id INTEGER PRIMARY KEY, cliente_id INTEGER, total REAL);
    CREATE INDEX idx_p_cliente ON p (cliente_id);`)
  db.close()
  setSqliteSpawner(inProcessSpawner())
  const ctx = context(dir)
  const id = ctx.connections.save({
    ...mysqlInput(new URL('mysql://x@127.0.0.1:1/x'), 'mysql'),
    name: 'Plan SQLite',
    host: '',
    port: 0,
    username: '',
    authMode: 'none',
    engine: 'sqlite',
    sqlite: { ...defaultSqliteOptions(false), filePath: file }
  }).id
  const manager = new ConnectionManager(ctx)
  try {
    const result = await executionPlan(manager, id, {
      sql: 'SELECT c.pais, p.total FROM c JOIN p ON p.cliente_id = c.id',
      schema: 'main',
      actual: false
    })
    const ops = [result.root, ...result.root.children].map((n) => n.operation)
    expect(ops.some((o) => o.startsWith('SEARCH'))).toBe(true)
    await expect(
      executionPlan(manager, id, { sql: 'SELECT 1', schema: 'main', actual: true })
    ).rejects.toThrow(/SQLite no mide/)
  } finally {
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})
