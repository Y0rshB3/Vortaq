/**
 * SQL Server 2022 through the real IPC handler layer (dbSqlServer.ts) and the
 * generic ConnectionManager. Server: docker compose service `mssql22` on
 * 127.0.0.1:51433 (VORTAQ_TEST_MSSQL_URL); its certificate is self-signed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type {
  ConnectionInput,
  QueryStatementResult,
  SchemaRef,
  TableFilterGroup
} from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import { defaultSqlServerOptions } from '@shared/engines'
import { trustFixesError, UNTRUSTED_CERTIFICATE } from '@shared/sqlserver/certificate'
import { CONNECTION_REFUSED } from '@main/sqlserver/errors'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager } from '@main/db/manager'
import { createMsDbHandlers, type MsDbHandlers } from '@main/ipc/dbSqlServer'
import {
  decideEditability,
  resultSource
} from '../../src/renderer/src/components/query/resultEditability'
import { MetadataOnlyError } from '@main/ai/metadata'
import {
  MsMetadataQueryable,
  explainMsSelect,
  readMsSchemaNames,
  readMsSchemaSnapshot
} from '@main/ai/msMetadata'
import { openRowSource } from '@main/export/sources'
import { isMsConnection } from '@main/sqlserver/connection'
import {
  msBuildAlter,
  msBuildCreatePlan,
  msDraftFromStructure,
  msEmptyColumn,
  msTransactionScript
} from '../../src/renderer/src/components/designer/sqlserver/planner'
import { describeServer, SQLSERVER_TARGET } from './targets'

const DB = `vortaq_ms_${process.pid}`

export function msInput(u: URL, overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
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
    engine: 'sqlserver',
    sqlserver: { ...defaultSqlServerOptions(), trustServerCertificate: true },
    ...overrides
  }
}

const ok = (results: QueryStatementResult[]): QueryStatementResult[] => {
  const failed = results.find((r) => r.error)
  if (failed) throw new Error(`${failed.sql}: ${failed.error}`)
  return results
}

describeServer(SQLSERVER_TARGET, 'SQL Server driver (integration)', (url) => {
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let ms: MsDbHandlers
  let id: string
  let prodId: string
  const ref: SchemaRef = { database: DB, schema: 'dbo' }

  const exec = (sql: string, options: Parameters<MsDbHandlers['execute']>[2] = {}) =>
    ms.execute(id, sql, { schema: ref, ...options })

  beforeAll(async () => {
    const u = new URL(url)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-ms-it-'))
    ctx = {
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
    id = ctx.connections.save(msInput(u)).id
    ctx.credentials.set('mysql', id, decodeURIComponent(u.password))
    prodId = ctx.connections.save(msInput(u, { name: 'MS IT prod', environment: 'production' })).id
    ctx.credentials.set('mysql', prodId, decodeURIComponent(u.password))
    manager = new ConnectionManager(ctx)
    ms = createMsDbHandlers(ctx, manager)
    ok(
      await ms.execute(
        id,
        `IF DB_ID(N'${DB}') IS NOT NULL BEGIN ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}] END`
      )
    )
    await ms.createDatabase(id, DB, {}, {})
    ok(
      await exec(`
        CREATE TABLE dbo.customers (
          id int IDENTITY(1,1) CONSTRAINT PK_customers PRIMARY KEY,
          name nvarchar(80) NOT NULL,
          code varchar(10) NULL CONSTRAINT UQ_customers_code UNIQUE,
          balance decimal(12,2) NOT NULL CONSTRAINT DF_customers_balance DEFAULT (0),
          born date NULL,
          seen datetime NULL,
          active bit NOT NULL DEFAULT 1,
          tag uniqueidentifier NULL,
          blob varbinary(16) NULL,
          doubled AS (balance * 2),
          CONSTRAINT CK_customers_balance CHECK (balance >= -1000)
        );
        CREATE TABLE dbo.orders (
          id int IDENTITY PRIMARY KEY,
          customer_id int NOT NULL CONSTRAINT FK_orders_customers REFERENCES dbo.customers (id) ON DELETE CASCADE,
          total money NOT NULL
        );
        CREATE INDEX IX_orders_customer ON dbo.orders (customer_id DESC) INCLUDE (total);
        INSERT dbo.customers (name, code, balance, born, seen) VALUES
          (N'Ana', 'A1', 10.50, '2001-02-03', '2026-01-02T03:04:05.123'),
          (N'Luis', 'L1', 0, NULL, NULL),
          (N'Ñandú [x]', NULL, -5.25, '1999-12-31', NULL);
        INSERT dbo.orders (customer_id, total) VALUES (1, 9.99), (1, 20), (2, 1.5);
      `)
    )
    ok(
      await exec(
        'CREATE VIEW dbo.big_spenders AS SELECT id, name FROM dbo.customers WHERE balance > 5'
      )
    )
    ok(
      await exec(
        'CREATE PROCEDURE dbo.touch @n int AS BEGIN SET NOCOUNT ON; SELECT @n * 2 AS twice; END'
      )
    )
    ok(await exec('CREATE SEQUENCE dbo.ticket AS bigint START WITH 100 INCREMENT BY 5'))
  }, 120_000)

  afterAll(async () => {
    try {
      await manager?.closeAll()
      const cleanup = new ConnectionManager(ctx)
      const handlers = createMsDbHandlers(ctx, cleanup)
      await handlers.execute(
        id,
        `ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}]`
      )
      await cleanup.closeAll()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a self-signed certificate is the error «Confiar en el certificado» fixes; a closed port says TCP/IP', async () => {
    const u = new URL(url)
    const password = decodeURIComponent(u.password)
    const strictTrust = msInput(u, {
      sqlserver: { ...defaultSqlServerOptions(), trustServerCertificate: false }
    })
    const untrusted = await manager.test(strictTrust, password, null)
    expect(untrusted.ok).toBe(false)
    expect(untrusted.error).toContain(UNTRUSTED_CERTIFICATE)
    expect(trustFixesError(untrusted.error, strictTrust.sqlserver)).toBe(true)
    const trusted = await manager.test(msInput(u), password, null)
    expect(trusted.ok, trusted.error).toBe(true)
    expect(trusted.serverVersion).toMatch(/^SQL Server 2022 \(/)

    const closed = await manager.test(msInput(u, { host: '127.0.0.1', port: 1 }), password, null)
    expect(closed.ok).toBe(false)
    expect(closed.error).toContain(CONNECTION_REFUSED)
    expect(closed.error).toMatch(/\(ECONNREFUSED\)$/)
    expect(trustFixesError(closed.error, strictTrust.sqlserver)).toBe(false)
  })

  it('lists databases, schemas and every object group', async () => {
    expect((await ms.databases(id)).map((d) => d.name)).toContain(DB)
    expect((await ms.databases(id)).map((d) => d.name)).not.toContain('tempdb')
    const schemas = await ms.schemas(id, DB)
    expect(schemas[0].name).toBe('dbo')
    expect(schemas.map((s) => s.name)).not.toContain('sys')
    const tables = await ms.tables(id, ref)
    expect(tables.map((t) => [t.name, t.rows])).toEqual([
      ['customers', 3],
      ['orders', 3]
    ])
    expect((await ms.views(id, ref)).map((v) => v.name)).toEqual(['big_spenders'])
    expect((await ms.routines(id, ref)).map((r) => [r.name, r.type])).toEqual([
      ['touch', 'PROCEDURE']
    ])
    expect((await ms.objects(id, ref, 'sequence')).map((o) => [o.name, o.kind])).toEqual([
      ['ticket', 'bigint']
    ])
    await expect(ms.tables(id, 'dbo')).rejects.toThrow(/Falta la base de datos/)
  })

  it('reads the structure and rebuilds the DDL', async () => {
    const s = await ms.tableStructure(id, ref, 'customers')
    const byName = Object.fromEntries(s.columns.map((c) => [c.name, c]))
    expect(byName.id).toMatchObject({
      primaryKey: true,
      autoIncrement: true,
      identity: 'always',
      extra: 'IDENTITY(1,1)'
    })
    expect(byName.name).toMatchObject({
      columnType: 'nvarchar(80)',
      nullable: false,
      typeKind: 'text'
    })
    expect(byName.balance).toMatchObject({
      columnType: 'decimal(12,2)',
      defaultValue: '0',
      hasDefault: true
    })
    expect(byName.doubled).toMatchObject({ generated: 'virtual' })
    expect(s.indexes.find((i) => i.primary)?.columns).toEqual(['id'])
    expect(s.constraints?.map((c) => [c.name, c.type])).toEqual([
      ['PK_customers', 'primary'],
      ['UQ_customers_code', 'unique'],
      ['CK_customers_balance', 'check']
    ])
    const orders = await ms.tableStructure(id, ref, 'orders')
    expect(orders.foreignKeys).toEqual([
      {
        name: 'FK_orders_customers',
        columns: ['customer_id'],
        referencedSchema: 'dbo',
        referencedTable: 'customers',
        referencedColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE'
      }
    ])
    expect(orders.createSql).toContain(
      'CREATE NONCLUSTERED INDEX [IX_orders_customer] ON [dbo].[orders] ([customer_id] DESC) INCLUDE ([total]);'
    )
    // The rebuilt DDL creates the same table elsewhere.
    ok(await exec(`CREATE SCHEMA copy`))
    ok(
      await exec(
        s.createSql
          .replaceAll('[dbo]', '[copy]')
          .replace(/CONSTRAINT \[(\w+)\]/g, 'CONSTRAINT [c_$1]')
      )
    )
    const copy = await ms.tableStructure(id, { database: DB, schema: 'copy' }, 'customers')
    expect(copy.columns.map((c) => [c.name, c.columnType, c.nullable])).toEqual(
      s.columns.map((c) => [c.name, c.columnType, c.nullable])
    )
    expect(await ms.showCreate(id, ref, 'view', 'big_spenders')).toMatch(
      /^CREATE VIEW dbo\.big_spenders/
    )
    expect(await ms.showCreate(id, ref, 'sequence', 'ticket')).toContain('START WITH 100')
  })

  it('pages, sorts and filters table data with exact values', async () => {
    const page = await ms.tableData(id, { schema: ref, table: 'customers', limit: 2, offset: 0 })
    expect(page.total).toBe(3)
    expect(page.primaryKey).toEqual(['id'])
    expect(page.rows.map((r) => r.slice(0, 6))).toEqual([
      [1, 'Ana', 'A1', '10.50', '2001-02-03', '2026-01-02 03:04:05.123'],
      [2, 'Luis', 'L1', '0.00', null, null]
    ])
    expect(page.columns.find((c) => c.name === 'id')?.locked).toMatch(/IDENTITY/)
    const sorted = await ms.tableData(id, {
      schema: ref,
      table: 'customers',
      limit: 10,
      offset: 1,
      orderBy: { column: 'balance', direction: 'DESC' }
    })
    expect(sorted.rows.map((r) => r[1])).toEqual(['Luis', 'Ñandú [x]'])
    const filter: TableFilterGroup = {
      kind: 'group',
      enabled: true,
      connector: 'AND',
      children: [
        {
          kind: 'condition',
          enabled: true,
          connector: 'AND',
          column: 'name',
          operator: 'contains',
          values: ['[X]']
        },
        {
          kind: 'condition',
          enabled: true,
          connector: 'AND',
          column: 'born',
          operator: 'lt',
          values: ['2000-01-01']
        }
      ]
    }
    const where = await ms.tableFilterSql(id, ref, 'customers', filter)
    expect(where).toContain("ESCAPE N'\\'")
    const filtered = await ms.tableData(id, {
      schema: ref,
      table: 'customers',
      limit: 10,
      offset: 0,
      filter
    })
    expect(filtered.rows.map((r) => r[1])).toEqual(['Ñandú [x]'])
    const seen = await ms.tableData(id, {
      schema: ref,
      table: 'customers',
      limit: 10,
      offset: 0,
      filter: {
        kind: 'group',
        enabled: true,
        connector: 'AND',
        children: [
          {
            kind: 'condition',
            enabled: true,
            connector: 'AND',
            column: 'seen',
            operator: 'ge',
            values: ['2026-01-02']
          }
        ]
      }
    })
    expect(seen.rows.map((r) => r[1])).toEqual(['Ana'])
  })

  it('saves grid changes in one transaction and returns the identity', async () => {
    const result = await ms.applyRowChanges(id, ref, 'customers', [
      {
        kind: 'insert',
        values: {
          id: null,
          name: 'Nuevo',
          code: 'N1',
          balance: '1.10',
          born: '2020-05-06',
          seen: '2026-03-04 05:06:07',
          active: false,
          blob: '0x0A0B',
          tag: '6F9619FF-8B86-D011-B42D-00C04FC964FF'
        }
      },
      { kind: 'update', key: { id: 2 }, values: { balance: '99.99', name: "O'Brien" } }
    ])
    expect(result.applied).toBe(2)
    expect(typeof result.insertIds?.[0]).toBe('number')
    const [row] = ok(
      await exec(
        `SELECT name, balance, seen, active, blob, tag FROM dbo.customers WHERE id = ${result.insertIds?.[0]}`
      )
    )
    expect(row.resultSet?.rows[0]).toEqual([
      'Nuevo',
      '1.10',
      '2026-03-04 05:06:07.000',
      false,
      '0x0A0B',
      '6F9619FF-8B86-D011-B42D-00C04FC964FF'
    ])
    // A failing change rolls the whole save back.
    await expect(
      ms.applyRowChanges(id, ref, 'customers', [
        { kind: 'update', key: { id: 1 }, values: { name: 'Cambiado' } },
        { kind: 'update', key: { id: 3 }, values: { balance: '-5000' } }
      ])
    ).rejects.toThrow(/CK_customers_balance|547/)
    const [check] = ok(await exec('SELECT name FROM dbo.customers WHERE id = 1'))
    expect(check.resultSet?.rows).toEqual([['Ana']])
    await expect(
      ms.applyRowChanges(id, ref, 'customers', [
        { kind: 'update', key: { id: 1 }, values: { id: 7 } }
      ])
    ).rejects.toThrow(/IDENTITY/)
  })

  it('query tabs keep variables per batch, transactions per tab, and report the state', async () => {
    const key = 'tab-1'
    const results = ok(
      await exec(
        "BEGIN TRAN; UPDATE dbo.customers SET name = N'En curso' WHERE id = 1; SELECT @@TRANCOUNT AS tc",
        {
          sessionKey: key
        }
      )
    )
    expect(results.at(-1)?.transactionStatus).toBe('in')
    expect((await ms.sessionState(id, key)).transactionStatus).toBe('in')
    // Another session does not see the uncommitted change (READ COMMITTED blocks): read it with NOLOCK.
    const [dirty] = ok(await exec('SELECT name FROM dbo.customers WITH (NOLOCK) WHERE id = 1'))
    expect(dirty.resultSet?.rows).toEqual([['En curso']])
    // A USE in one run does not move the next run: the tab's database decides.
    ok(await exec('USE master', { sessionKey: 'tab-use' }))
    const [where] = ok(await exec('SELECT DB_NAME() AS db', { sessionKey: 'tab-use' }))
    expect(where.resultSet?.rows).toEqual([[DB]])
    expect(where.effectiveSchema).toBeUndefined()
    await ms.closeSession(id, 'tab-use')
    const state = await ms.rollback(id, key)
    expect(state.transactionStatus).toBe('idle')
    const [after] = ok(await exec('SELECT name FROM dbo.customers WHERE id = 1'))
    expect(after.resultSet?.rows).toEqual([['Ana']])
    await ms.closeSession(id, key)
  })

  it('single-table and joined results are editable by their source columns', async () => {
    const [single] = ok(
      await exec(
        'SELECT c.id, c.name, c.balance * 2 AS twice FROM dbo.customers AS c WHERE c.id < 3'
      )
    )
    const columns = single.resultSet!.columns
    const source = resultSource(columns, single.sql, 'sqlserver')
    expect(source.ok).toBe(true)
    if (!source.ok) return
    const structure = await ms.tableStructure(id, ref, 'customers')
    const decision = decideEditability(columns, source.source, structure, single.resultSet!.rows, {
      aliasMetadata: false
    })
    expect(decision).toMatchObject({ editable: true, table: 'customers', primaryKey: ['id'] })
    const [joined] = ok(
      await exec(
        'SELECT o.id, o.total, c.name FROM dbo.orders o JOIN dbo.customers c ON c.id = o.customer_id'
      )
    )
    const joinedSource = resultSource(joined.resultSet!.columns, joined.sql, 'sqlserver')
    expect(joinedSource.ok && joinedSource.source.table).toBe('orders')
  })

  it('cancels a running batch through db:cancel', async () => {
    const run = exec("WAITFOR DELAY '00:00:30'; SELECT 1 AS late", {
      executionId: 'x1',
      sessionKey: 'tab-c'
    })
    await new Promise((r) => setTimeout(r, 400))
    expect(await ms.cancel(id, 'x1')).toBe(true)
    const results = await run
    expect(results.at(-1)?.error).toMatch(/cancelada/)
    expect(results.some((r) => r.resultSet)).toBe(false)
    await ms.closeSession(id, 'tab-c')
  })

  it('production connections need the confirmation for writes, not for reads', async () => {
    const prodRef = { database: DB, schema: 'dbo' }
    ok(await ms.execute(prodId, 'SELECT COUNT(*) FROM dbo.customers', { schema: prodRef }))
    await expect(ms.execute(prodId, 'EXEC dbo.touch 1', { schema: prodRef })).rejects.toThrow(
      /confirmación explícita/
    )
    await expect(
      ms.applyRowChanges(prodId, prodRef, 'customers', [{ kind: 'delete', key: { id: 3 } }])
    ).rejects.toThrow(/confirmación explícita/)
    const [twice] = ok(
      await ms.execute(prodId, 'EXEC dbo.touch 21', { schema: prodRef, confirmProduction: true })
    )
    expect(twice.resultSet?.rows).toEqual([[42]])
  })

  it('AI: reads structure only, refuses rows, and gets an estimated plan without running it', async () => {
    const connection = await manager.connection(id)
    if (!isMsConnection(connection)) throw new Error('not SQL Server')
    const session = await connection.acquire({ database: DB, schema: null })
    try {
      const q = new MsMetadataQueryable(session)
      await expect(q.query('SELECT * FROM dbo.customers')).rejects.toBeInstanceOf(MetadataOnlyError)
      await expect(
        q.query('SELECT name FROM sys.objects o JOIN dbo.customers c ON 1 = 1')
      ).rejects.toBeInstanceOf(MetadataOnlyError)
      await expect(
        q.query('SELECT OBJECT_DEFINITION(o.object_id) FROM sys.objects o')
      ).rejects.toBeInstanceOf(MetadataOnlyError)
      expect(await readMsSchemaNames(q)).toEqual(expect.arrayContaining(['copy', 'dbo']))
      const snap = await readMsSchemaSnapshot(q, 'dbo')
      expect(snap.serverVersion).toMatch(/^SQL Server 16\./)
      const customers = snap.tables.find((t) => t.name === 'customers')
      expect(customers?.columns.map((c) => [c.name, c.type, c.key])).toContainEqual([
        'id',
        'int',
        'PRI'
      ])
      expect(snap.tables.find((t) => t.name === 'orders')?.foreignKeys[0]).toMatchObject({
        refTable: 'customers',
        columns: ['customer_id']
      })
      expect(snap.routines.find((r) => r.name === 'touch')).toMatchObject({
        type: 'PROCEDURE',
        params: ['@n int']
      })
    } finally {
      await session.release()
    }
    const plain = await connection.acquire({ database: DB, schema: null })
    try {
      const plan = await explainMsSelect(plain, 'SELECT * FROM dbo.orders WHERE customer_id = 1')
      expect(plan).toMatch(/Index (Seek|Scan)/)
      expect(await explainMsSelect(plain, 'DELETE FROM dbo.orders')).toBeNull()
    } finally {
      await plain.release()
    }
    const [count] = ok(await exec('SELECT COUNT(*) FROM dbo.orders'))
    expect(count.resultSet?.rows).toEqual([[3]])
  })

  it('exports a whole result in a fresh session, batch by batch', async () => {
    const source = await openRowSource(
      ctx,
      manager,
      id,
      {
        kind: 'statement',
        sql: 'SELECT a.object_id, a.name FROM sys.all_objects a',
        context: ref
      },
      'exp-1'
    )
    let rows = 0
    let batches = 0
    try {
      for await (const batch of source.batches) {
        rows += batch.rows.length
        batches++
      }
    } finally {
      await source.close()
    }
    expect(source.columns.map((c) => c.name)).toEqual(['object_id', 'name'])
    expect(rows).toBeGreaterThan(1000)
    expect(batches).toBeGreaterThan(2)
    const table = await openRowSource(
      ctx,
      manager,
      id,
      {
        kind: 'table',
        request: { schema: ref, table: 'customers', orderBy: { column: 'id', direction: 'ASC' } }
      },
      'exp-2'
    )
    try {
      const all: unknown[][] = []
      for await (const batch of table.batches) all.push(...batch.rows)
      expect(all[0].slice(1, 4)).toEqual(['Ana', 'A1', '10.50'])
    } finally {
      await table.close()
    }
    await expect(
      openRowSource(
        ctx,
        manager,
        id,
        { kind: 'statement', sql: 'DELETE FROM dbo.orders', context: ref },
        'exp-3'
      )
    ).rejects.toThrow(/lectura/)
  })

  it('the designer creates and alters a table in one transaction (sp_rename, defaults, keys)', async () => {
    const create = msBuildCreatePlan('dbo', {
      name: 'productos',
      engine: '',
      collation: '',
      comment: 'Catálogo',
      autoIncrement: null,
      columns: [
        {
          ...msEmptyColumn(),
          name: 'id',
          columnType: 'int',
          nullable: false,
          autoIncrement: true,
          primaryKey: true
        },
        {
          ...msEmptyColumn(),
          name: 'nombre',
          columnType: 'nvarchar(50)',
          nullable: false,
          comment: 'Nombre visible'
        },
        { ...msEmptyColumn(), name: 'precio', columnType: 'decimal(10,2)', defaultValue: '0' },
        { ...msEmptyColumn(), name: 'obsoleto', columnType: 'bit', defaultValue: '0' }
      ],
      indexes: [],
      foreignKeys: []
    })
    expect(create.problems).toEqual([])
    ok(await exec(msTransactionScript(create.statements)))
    ok(await exec("INSERT dbo.productos (nombre, precio) VALUES (N'Café', 1.20), (N'Té', 1.10)"))
    const original = await ms.tableStructure(id, ref, 'productos')
    expect(original.comment).toBe('Catálogo')
    const draft = msDraftFromStructure(original)
    const nombre = draft.columns.find((c) => c.name === 'nombre')!
    nombre.name = 'titulo'
    nombre.columnType = 'nvarchar(120)'
    const precio = draft.columns.find((c) => c.name === 'precio')!
    precio.defaultValue = '9.99'
    precio.nullable = false
    draft.columns = draft.columns.filter((c) => c.name !== 'obsoleto')
    draft.columns.push({ ...msEmptyColumn(), name: 'cliente_id', columnType: 'int' })
    draft.indexes.push({
      id: 'i1',
      originalName: null,
      name: 'IX_productos_titulo',
      unique: true,
      type: 'NONCLUSTERED',
      columns: ['titulo'],
      comment: ''
    })
    draft.foreignKeys.push({
      id: 'f1',
      originalName: null,
      name: 'FK_productos_clientes',
      columns: ['cliente_id'],
      referencedSchema: 'dbo',
      referencedTable: 'customers',
      referencedColumns: ['id'],
      onUpdate: 'NO ACTION',
      onDelete: 'SET NULL'
    })
    const plan = msBuildAlter(original, draft)
    expect(plan.problems).toEqual([])
    expect(plan.drops.map((d) => [d.kind, d.name])).toEqual([['COLUMN', 'obsoleto']])
    ok(await exec(msTransactionScript(plan.statements)))
    const after = await ms.tableStructure(id, ref, 'productos')
    expect(after.columns.map((c) => [c.name, c.columnType, c.nullable, c.defaultValue])).toEqual([
      ['id', 'int', false, null],
      ['titulo', 'nvarchar(120)', false, null],
      ['precio', 'decimal(10,2)', false, '9.99'],
      ['cliente_id', 'int', true, null]
    ])
    expect(after.columns.find((c) => c.name === 'titulo')?.comment).toBe('Nombre visible')
    expect(after.indexes.map((i) => i.name)).toContain('IX_productos_titulo')
    expect(after.foreignKeys[0]).toMatchObject({
      name: 'FK_productos_clientes',
      onDelete: 'SET NULL'
    })
    // An identity change is refused, never attempted.
    const again = msDraftFromStructure(after)
    again.columns[0].autoIncrement = false
    expect(msBuildAlter(after, again).problems[0]).toMatch(/IDENTITY/)
    // A failing plan leaves nothing half done (XACT_ABORT + one transaction).
    const broken = msDraftFromStructure(after)
    broken.columns.find((c) => c.name === 'precio')!.columnType = 'decimal(10,2)'
    broken.columns.push({ ...msEmptyColumn(), name: 'nuevo', columnType: 'int' })
    broken.columns.find((c) => c.name === 'titulo')!.columnType = 'nvarchar(2)'
    const failing = msBuildAlter(after, broken)
    const results = await exec(msTransactionScript(failing.statements))
    expect(results.some((r) => r.error)).toBe(true)
    const unchanged = await ms.tableStructure(id, ref, 'productos')
    expect(unchanged.columns.map((c) => c.name)).toEqual(['id', 'titulo', 'precio', 'cliente_id'])
  })

  it('the DDL editor applies CREATE OR ALTER in its own batch and renames by drop', async () => {
    // What msBuildDdlScript produces (designer/sqlserver/ddl.test.ts pins the text).
    ok(await exec('CREATE OR ALTER VIEW dbo.v_saldo AS SELECT id, balance FROM dbo.customers'))
    const renamed =
      'CREATE OR ALTER VIEW dbo.v_saldos AS SELECT id, balance FROM dbo.customers\nGO\nDROP VIEW IF EXISTS [dbo].[v_saldo]'
    ok(await exec(renamed))
    expect((await ms.views(id, ref)).map((v) => v.name)).toContain('v_saldos')
    expect((await ms.views(id, ref)).map((v) => v.name)).not.toContain('v_saldo')
  })

  it('drops objects and refuses dropping the initial or a system database', async () => {
    await ms.dropObject(id, ref, 'view', 'big_spenders')
    expect((await ms.views(id, ref)).map((v) => v.name)).not.toContain('big_spenders')
    await expect(ms.dropDatabase(id, 'master')).rejects.toThrow(/inicial|sistema/)
  })
})
