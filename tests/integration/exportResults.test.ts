/**
 * «Exportar resultado completo» (src/main/export) against real servers:
 * MySQL 8.4 and 5.7, MariaDB 11, PostgreSQL 17, and SQLite files with a real
 * worker process. The statement runs again in a new read-only session and
 * streams to the file; these suites check row counts, that CSV/JSON keep the
 * exact values, that the INSERT script restores the same rows into a copy of
 * the table, that a cancel stops the server-side work and deletes the part
 * file, and that anything that may write is refused (and, past the guard, the
 * read-only session still refuses it).
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  defaultExportOptions,
  type ExportOptions,
  type ExportQuerySource
} from '@shared/export/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { ConnectionInput, ProgressEvent, QueryStatementResult } from '@shared/types'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionManager } from '@main/db/manager'
import { createExportService, type ExportService } from '@main/export/service'
import { unzip } from '@main/export/testing/unzip'
import { CANCELLED_EXPORT } from '@main/export/writer'
import { createPgDbHandlers, type PgDbHandlers } from '@main/ipc/dbPostgres'
import { createSqliteDbHandlers, type SqliteDbHandlers } from '@main/ipc/dbSqlite'
import { mariadbDialect } from '@shared/dialects/mariadb'
import { mysqlDialect } from '@shared/dialects/mysql'
import { postgresqlDialect } from '@shared/dialects/postgresql'
import { sqliteDialect } from '@shared/dialects/sqlite'
import { defaultSqliteOptions } from '@shared/engines'
import { executeScript } from '@main/mysql/query'
import { createSqliteDriver, createSqliteFile } from '@main/sqlite/driver'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { MARIADB_TARGET, POSTGRES_TARGET, describeMysql, describeServer } from './targets'
import { childProcessSpawner } from './sqliteWorkerProcess'

function makeContext(dir: string, events: ProgressEvent[]): AppContext {
  return {
    userDataPath: dir,
    logDir: join(dir, 'logs'),
    connections: new ConnectionsRepo(dir),
    jobs: new JobsRepo(dir),
    runs: new RunsRepo(dir),
    settings: new SettingsRepo(dir, dir),
    credentials: new CredentialStore(dir, plainCodec, 'plain'),
    emit: <E extends IpcEventChannel>(channel: E, payload: IpcEventMap[E]) => {
      if (channel === 'event:progress') events.push(payload as ProgressEvent)
    },
    headless: true
  }
}

function baseInput(overrides: Partial<ConnectionInput>): ConnectionInput {
  return {
    name: 'Export IT',
    color: null,
    environment: 'production',
    host: '',
    port: 0,
    username: '',
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
    ...overrides
  }
}

/** RFC 4180 reader (CRLF records, quotes doubled), BOM skipped. */
function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i += 2
      } else if (ch === '"') {
        quoted = false
        i++
      } else {
        field += ch
        i++
      }
    } else if (ch === '"') {
      quoted = true
      i++
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
      i++
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 2
    } else {
      field += ch
      i++
    }
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const NAME = 'ñandú 😀 \'q\' "d" \\ back'
const NOTE = 'line1\nline2\ttab'

/** Runs `options` over `source` into `<dir>/<file>`; returns the file path and result. */
async function run(
  service: ExportService,
  connectionId: string,
  dir: string,
  file: string,
  source: ExportQuerySource,
  options: Partial<ExportOptions> = {}
) {
  const filePath = join(dir, file)
  const result = await service.query(`op-${file}-${Math.random()}`, {
    connectionId,
    filePath,
    source,
    options: defaultExportOptions(options)
  })
  return { filePath, result, text: () => readFileSync(filePath, 'utf8') }
}

function xlsxRows(path: string): number {
  const sheet = unzip(path).get('xl/worksheets/sheet1.xml')!
  const errors: string[] = []
  const doc = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') errors.push(message)
    }
  }).parseFromString(sheet.data.toString('utf8'), 'text/xml')
  expect(errors).toEqual([])
  return doc.getElementsByTagNameNS(
    'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'row'
  ).length
}

/** Waits for `predicate` (polling), failing after `ms`. */
async function until(predicate: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('condition not met in time')
}

/* ---------- MySQL 8.4 / 5.7 and MariaDB 11 ---------- */

function mysqlFamilySuite(url: string, engine: 'mysql' | 'mariadb'): void {
  const DB = `vortaq_export_${process.pid}`
  const digits =
    '(SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)'
  const SEED = [
    `DROP DATABASE IF EXISTS \`${DB}\``,
    `CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE TABLE \`${DB}\`.items (
       id INT PRIMARY KEY, name VARCHAR(100) NULL, amount DECIMAL(20,6) NULL,
       big BIGINT UNSIGNED NULL, bin VARBINARY(16) NULL, b BIT(3) NULL, j JSON NULL,
       d DATETIME(3) NULL, note TEXT NULL
     ) DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE \`${DB}\`.cats (id INT PRIMARY KEY, label VARCHAR(20))`,
    `INSERT INTO \`${DB}\`.items VALUES
       (1, ${mysqlDialect.quoteString(NAME)}, 12345678901234.123456, 18446744073709551615, 0x00FF00,
        b'101', '{"a": [1, "x"]}', '2026-03-17 14:51:20.123', ${mysqlDialect.quoteString(NOTE)}),
       (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
       (3, '=1+1', -0.000001, 0, '', b'000', '[]', '1970-01-01 00:00:01.000', ';semi,comma')`,
    `INSERT INTO \`${DB}\`.items (id, name, amount, big, note)
       SELECT 100 + a.n + 10 * b.n + 100 * c.n + 1000 * d.n,
              CONCAT('fila ', 100 + a.n + 10 * b.n + 100 * c.n + 1000 * d.n),
              (a.n + b.n) * 1.5, (a.n + 10 * b.n) * 1000000007, NULL
         FROM ${digits} a, ${digits} b, ${digits} c,
              (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2) d`,
    `INSERT INTO \`${DB}\`.cats VALUES (1, 'uno'), (2, 'dos'), (3, 'tres')`,
    `CREATE TABLE \`${DB}\`.items_copy LIKE \`${DB}\`.items`,
    `CREATE FUNCTION \`${DB}\`.f_write() RETURNS INT DETERMINISTIC MODIFIES SQL DATA
       BEGIN INSERT INTO cats VALUES (99, 'escrita'); RETURN 1; END`
  ]
  const ROWS = 3003
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let service: ExportService
  let id: string
  const events: ProgressEvent[] = []

  const query = async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
    const s = await manager.acquire(id)
    try {
      return await s.query<T>(sql)
    } finally {
      await s.release()
    }
  }
  const snapshot = (table: string) =>
    query(
      `SELECT id, name, CAST(amount AS CHAR) AS amount, CAST(big AS CHAR) AS big, HEX(bin) AS bin,
              HEX(b) AS b, CAST(j AS CHAR) AS j, CAST(d AS CHAR) AS d, note
         FROM \`${DB}\`.\`${table}\` ORDER BY id`
    )

  beforeAll(async () => {
    const u = new URL(url)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-export-it-'))
    mkdirSync(join(dir, 'out'))
    ctx = makeContext(dir, events)
    id = ctx.connections.save(
      baseInput({
        engine,
        host: u.hostname,
        port: Number(u.port || 3306),
        username: decodeURIComponent(u.username)
      })
    ).id
    ctx.credentials.set('mysql', id, decodeURIComponent(u.password))
    manager = new ConnectionManager(ctx)
    service = createExportService(ctx, manager)
    const s = await manager.acquire(id)
    try {
      for (const sql of SEED) await s.execute(sql)
    } finally {
      await s.release()
    }
  }, 120_000)

  afterAll(async () => {
    try {
      const s = await manager.acquire(id)
      try {
        await s.execute(`DROP DATABASE IF EXISTS \`${DB}\``)
      } finally {
        await s.release()
      }
    } catch {
      /* best effort */
    }
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  const out = () => join(dir, 'out')

  it('CSV of a multi-table SELECT, run in the tab database, on a production connection', async () => {
    const { text, result } = await run(service, id, out(), 'join.csv', {
      kind: 'statement',
      sql: 'SELECT i.id, i.name, c.label, i.note FROM items i JOIN cats c ON c.id = i.id ORDER BY i.id',
      context: DB
    })
    expect(result.rows).toBe(3)
    const rows = parseCsv(text())
    expect(rows[0]).toEqual(['id', 'name', 'label', 'note'])
    expect(rows[1]).toEqual(['1', NAME, 'uno', NOTE])
    expect(rows[2]).toEqual(['2', '', 'dos', ''])
    expect(rows[3]).toEqual(['3', '=1+1', 'tres', ';semi,comma'])
    expect(events.at(-1)).toMatchObject({ kind: 'export', done: true, phase: 'done' })
  })

  it('JSON keeps exact values: big integers and decimals as text, INT as numbers', async () => {
    const { text, result } = await run(
      service,
      id,
      out(),
      'all.json',
      { kind: 'statement', sql: `SELECT * FROM \`${DB}\`.items ORDER BY id` },
      { format: 'json' }
    )
    expect(result.rows).toBe(ROWS)
    const parsed = JSON.parse(text()) as Record<string, unknown>[]
    expect(parsed).toHaveLength(ROWS)
    expect(parsed[0]).toMatchObject({
      id: 1,
      name: NAME,
      amount: '12345678901234.123456',
      big: '18446744073709551615',
      bin: '0x00FF00',
      b: '0x05',
      d: '2026-03-17 14:51:20.123',
      note: NOTE
    })
    expect(JSON.parse(parsed[0].j as string)).toEqual({ a: [1, 'x'] })
    expect(parsed[1]).toMatchObject({ id: 2, name: null, big: null })
    expect(parsed[2]).toMatchObject({ big: 0, bin: '0x', amount: '-0.000001' })
  })

  it('the INSERT script restores the same rows into a copy of the table', async () => {
    const { text, result } = await run(
      service,
      id,
      out(),
      'items.sql',
      { kind: 'table', request: { schema: DB, table: 'items', orderBy: null } },
      { format: 'sql', table: 'items_copy', batchSize: 250, dialect: engine }
    )
    expect(result.rows).toBe(ROWS)
    const s = await manager.acquire(id)
    try {
      const results: QueryStatementResult[] = await executeScript(
        s,
        text(),
        { schema: DB, stopOnError: true },
        1000,
        engine === 'mariadb' ? mariadbDialect : mysqlDialect
      )
      expect(results.filter((r) => r.error)).toEqual([])
      expect(results).toHaveLength(Math.ceil(ROWS / 250))
    } finally {
      await s.release()
    }
    expect(await snapshot('items_copy')).toEqual(await snapshot('items'))
  })

  it('the table view SELECT keeps its filter and sort without paging; XLSX too', async () => {
    const source: ExportQuerySource = {
      kind: 'table',
      request: {
        schema: DB,
        table: 'items',
        where: 'id >= 100',
        orderBy: { column: 'id', direction: 'DESC' }
      }
    }
    const csv = await run(service, id, out(), 'filtered.csv', source, { delimiter: ';' })
    const rows = parseCsv(csv.text(), ';')
    expect(rows).toHaveLength(3001)
    expect(rows[1][0]).toBe('3099')
    expect(rows[3000][0]).toBe('100')
    const xlsx = await run(service, id, out(), 'filtered.xlsx', source, { format: 'xlsx' })
    expect(xlsxRows(xlsx.filePath)).toBe(3001)
  })

  it('refuses statements that may write, and the read-only session stops what the guard lets through', async () => {
    for (const sql of [
      'DELETE FROM items',
      'SELECT 1; DELETE FROM items',
      'SELECT * FROM items FOR UPDATE'
    ]) {
      await expect(
        run(service, id, out(), 'w.csv', { kind: 'statement', sql, context: DB })
      ).rejects.toThrow(/lectura|única sentencia/)
    }
    // A stored function that writes looks like a plain SELECT to the guard.
    await expect(
      run(service, id, out(), 'f.csv', {
        kind: 'statement',
        sql: 'SELECT f_write() AS x',
        context: DB
      })
    ).rejects.toThrow(/READ ONLY|read-only|1792/i)
    expect(
      Number((await query<{ n: unknown }>(`SELECT COUNT(*) AS n FROM \`${DB}\`.cats`))[0].n)
    ).toBe(3)
    expect(
      Number((await query<{ n: unknown }>(`SELECT COUNT(*) AS n FROM \`${DB}\`.items`))[0].n)
    ).toBe(ROWS)
    expect(readdirSync(out())).not.toContain('w.csv')
    expect(readdirSync(out())).not.toContain('f.csv')
  })

  it('cancel stops the statement on the server (KILL QUERY) and deletes the part file', async () => {
    const marker = `vortaq_export_cancel_${engine}`
    const running = service.query('op-cancel', {
      connectionId: id,
      filePath: join(out(), 'cancel.csv'),
      source: { kind: 'statement', sql: `SELECT SLEEP(60) AS ${marker}`, context: DB },
      options: defaultExportOptions()
    })
    const settled = running.then(
      () => 'resolved',
      (err: Error) => err.message
    )
    const sleeping = async () =>
      (
        await query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE '%${marker}%' AND ID <> CONNECTION_ID()`
        )
      ).some((r) => Number(r.n) > 0)
    await until(sleeping)
    const started = Date.now()
    await service.cancel('op-cancel')
    expect(await settled).toBe(CANCELLED_EXPORT)
    await until(async () => !(await sleeping()))
    expect(Date.now() - started).toBeLessThan(5000)
    expect(readdirSync(out()).filter((f) => f.startsWith('cancel'))).toEqual([])
    expect(service.running()).toEqual([])
  }, 30_000)
}

describeMysql('Full result export (integration)', (target) => mysqlFamilySuite(target.url, 'mysql'))
describeServer(MARIADB_TARGET, 'Full result export (integration)', (url) =>
  mysqlFamilySuite(url, 'mariadb')
)

/* ---------- PostgreSQL 17 ---------- */

describeServer(POSTGRES_TARGET, 'Full result export (integration)', (url) => {
  const SCHEMA = `vortaq_export_${process.pid}`
  const ROWS = 3003
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let pg: PgDbHandlers
  let service: ExportService
  let id: string
  let db: string
  const events: ProgressEvent[] = []

  const exec = async (sql: string) => {
    const results = await pg.execute(id, sql, {
      schema: { database: db, schema: SCHEMA },
      confirmProduction: true
    })
    const failed = results.find((r) => r.error)
    if (failed) throw new Error(`${failed.sql}: ${failed.error}`)
    return results
  }
  const digest = async (table: string): Promise<unknown> =>
    (
      await exec(
        `SELECT count(*)::int AS n, md5(string_agg(t::text, '|' ORDER BY id)) AS d FROM ${table} t`
      )
    )[0].resultSet!.rows[0]

  beforeAll(async () => {
    const u = new URL(url)
    db = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres'
    dir = mkdtempSync(join(tmpdir(), 'vortaq-export-pg-it-'))
    mkdirSync(join(dir, 'out'))
    ctx = makeContext(dir, events)
    id = ctx.connections.save(
      baseInput({
        engine: 'postgresql',
        host: u.hostname,
        port: Number(u.port || 5432),
        username: decodeURIComponent(u.username),
        ssl: { enabled: false, verifyServer: false, mode: 'disable' },
        postgres: { initialDatabase: db, showSystemSchemas: false, timeZone: '', searchPath: '' }
      })
    ).id
    ctx.credentials.set('mysql', id, decodeURIComponent(u.password))
    manager = new ConnectionManager(ctx)
    pg = createPgDbHandlers(ctx, manager)
    service = createExportService(ctx, manager)
    await pg.execute(id, `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`, { confirmProduction: true })
    await pg.execute(id, `CREATE SCHEMA ${SCHEMA}`, { confirmProduction: true })
    await exec(`
      CREATE TABLE items (
        id int PRIMARY KEY, name text, amount numeric(20,6), big bigint, bin bytea, flag boolean,
        j jsonb, arr int[], d timestamp(3), note text
      );
      CREATE TABLE cats (id int PRIMARY KEY, label text);
      INSERT INTO items VALUES
        (1, ${postgresqlDialect.quoteString(NAME)}, 12345678901234.123456, 9223372036854775807, '\\x00ff00', true,
         '{"a": [1, "x"]}', '{1,2,3}', '2026-03-17 14:51:20.123', E'line1\\nline2\\ttab'),
        (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
        (3, '=1+1', -0.000001, 0, '\\x', false, '[]', '{}', '1970-01-01 00:00:01', ';semi,comma');
      INSERT INTO items (id, name, amount, big)
        SELECT g, 'fila ' || g, g * 1.5, g::bigint * 1000000007 FROM generate_series(100, 3099) g;
      INSERT INTO cats VALUES (1, 'uno'), (2, 'dos'), (3, 'tres');
      CREATE TABLE items_copy (LIKE items INCLUDING ALL);
      CREATE FUNCTION f_write() RETURNS int LANGUAGE sql AS $$ INSERT INTO cats VALUES (99, 'escrita') RETURNING 1 $$;
    `)
  }, 120_000)

  afterAll(async () => {
    await pg
      .execute(id, `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`, { confirmProduction: true })
      .catch(() => undefined)
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  const out = () => join(dir, 'out')
  const ref = () => ({ database: db, schema: SCHEMA })

  it('CSV of a multi-table SELECT with the tab search_path', async () => {
    const { text, result } = await run(service, id, out(), 'join.csv', {
      kind: 'statement',
      sql: 'SELECT i.id, i.name, c.label, i.note FROM items i JOIN cats c ON c.id = i.id ORDER BY i.id',
      context: ref()
    })
    expect(result.rows).toBe(3)
    expect(parseCsv(text())).toEqual([
      ['id', 'name', 'label', 'note'],
      ['1', NAME, 'uno', NOTE],
      ['2', '', 'dos', ''],
      ['3', '=1+1', 'tres', ';semi,comma']
    ])
  })

  it('JSON keeps booleans, exact numerics and server text', async () => {
    const { text, result } = await run(
      service,
      id,
      out(),
      'all.json',
      { kind: 'statement', sql: 'SELECT * FROM items ORDER BY id', context: ref() },
      { format: 'json' }
    )
    expect(result.rows).toBe(ROWS)
    const parsed = JSON.parse(text()) as Record<string, unknown>[]
    expect(parsed[0]).toMatchObject({
      id: 1,
      name: NAME,
      amount: '12345678901234.123456',
      big: '9223372036854775807',
      bin: '0x00FF00',
      flag: true,
      arr: '{1,2,3}',
      d: '2026-03-17 14:51:20.123'
    })
    expect(parsed[2]).toMatchObject({ flag: false, big: 0, amount: '-0.000001' })
  })

  it('the INSERT script restores the same rows into a copy of the table', async () => {
    const { text } = await run(
      service,
      id,
      out(),
      'items.sql',
      { kind: 'table', request: { schema: ref(), table: 'items' } },
      { format: 'sql', table: 'items_copy', batchSize: 1, dialect: 'postgresql' }
    )
    await exec(text())
    expect(await digest('items_copy')).toEqual(await digest('items'))
  }, 60_000)

  it('table view filter and sort without paging, and XLSX', async () => {
    const source: ExportQuerySource = {
      kind: 'table',
      request: {
        schema: ref(),
        table: 'items',
        filter: {
          kind: 'group',
          enabled: true,
          connector: 'AND',
          children: [
            {
              kind: 'condition',
              enabled: true,
              column: 'id',
              operator: 'ge',
              values: ['100'],
              connector: 'AND'
            }
          ]
        },
        orderBy: { column: 'id', direction: 'DESC' }
      }
    }
    const csv = await run(service, id, out(), 'filtered.csv', source)
    const rows = parseCsv(csv.text())
    expect(rows).toHaveLength(3001)
    expect(rows[1][0]).toBe('3099')
    const xlsx = await run(service, id, out(), 'all.xlsx', source, { format: 'xlsx' })
    expect(xlsxRows(xlsx.filePath)).toBe(3001)
  })

  it('refuses writes; a writing function is stopped by the read-only transaction', async () => {
    await expect(
      run(service, id, out(), 'w.csv', {
        kind: 'statement',
        sql: 'DELETE FROM items',
        context: ref()
      })
    ).rejects.toThrow(/lectura/)
    await expect(
      run(service, id, out(), 'f.csv', {
        kind: 'statement',
        sql: 'SELECT f_write()',
        context: ref()
      })
    ).rejects.toThrow(/read-only|solo lectura|25006/i)
    expect((await exec('SELECT count(*)::int FROM cats'))[0].resultSet!.rows).toEqual([[3]])
    expect(readdirSync(out()).filter((f) => f === 'w.csv' || f === 'f.csv')).toEqual([])
  })

  it('cancel runs pg_cancel_backend before the first row and deletes the part file', async () => {
    const running = service.query('op-pg-cancel', {
      connectionId: id,
      filePath: join(out(), 'cancel.csv'),
      source: {
        kind: 'statement',
        sql: 'SELECT pg_sleep(60) AS vortaq_export_cancel',
        context: ref()
      },
      options: defaultExportOptions()
    })
    const settled = running.then(
      () => 'resolved',
      (err: Error) => err.message
    )
    const active = async () =>
      (
        await exec(
          "SELECT count(*)::int FROM pg_stat_activity WHERE query LIKE '%AS vortaq_export_cancel%' AND state = 'active' AND pid <> pg_backend_pid()"
        )
      )[0].resultSet!.rows[0][0] === 1
    await until(active)
    await service.cancel('op-pg-cancel')
    expect(await settled).toBe(CANCELLED_EXPORT)
    await until(async () => !(await active()))
    expect(readdirSync(out()).filter((f) => f.startsWith('cancel'))).toEqual([])
  }, 30_000)
})

/* ---------- SQLite (real files, real worker processes) ---------- */

describe('Full result export [SQLite] (integration)', () => {
  const ROWS = 3003
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let lite: SqliteDbHandlers
  let service: ExportService
  let spawner: Awaited<ReturnType<typeof childProcessSpawner>>
  let id: string
  const events: ProgressEvent[] = []

  const exec = async (sql: string, tab = 'tab-1') => {
    const results = await lite.execute(id, sql, { sessionKey: tab, confirmProduction: true })
    const failed = results.find((r) => r.error)
    if (failed) throw new Error(`${failed.sql}: ${failed.error}`)
    return results
  }
  const snapshot = async (table: string) =>
    (
      await exec(
        `SELECT id, typeof(name), quote(name), typeof(amount), quote(amount), typeof(big), quote(big),
                typeof(bin), quote(bin), typeof(loose), quote(loose), quote(note)
           FROM ${table} ORDER BY id`
      )
    )[0].resultSet!.rows

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-export-sqlite-it-'))
    mkdirSync(join(dir, 'out'))
    ctx = makeContext(dir, events)
    spawner = await childProcessSpawner()
    manager = new ConnectionManager(ctx, { drivers: async () => createSqliteDriver(() => spawner) })
    lite = createSqliteDbHandlers(ctx, manager)
    service = createExportService(ctx, manager)
    const file = join(dir, 'export.db')
    await createSqliteFile(file, spawner)
    id = ctx.connections.save(
      baseInput({
        engine: 'sqlite',
        authMode: 'none',
        savePassword: false,
        sqlite: { ...defaultSqliteOptions(false), filePath: file }
      })
    ).id
    await exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, amount REAL, big INTEGER, bin BLOB, loose, note TEXT);
      CREATE TABLE cats (id INTEGER PRIMARY KEY, label TEXT);
      INSERT INTO items VALUES
        (1, ${sqliteDialect.quoteString(NAME)}, 1.5, 9223372036854775807, X'00FF00', 'texto', ${sqliteDialect.quoteString(NOTE)}),
        (2, NULL, NULL, NULL, NULL, NULL, NULL),
        (3, '=1+1', -0.000001, 0, X'', 42, ';semi,comma');
      WITH RECURSIVE g(n) AS (SELECT 100 UNION ALL SELECT n + 1 FROM g WHERE n < 3099)
        INSERT INTO items (id, name, amount, big, loose) SELECT n, 'fila ' || n, n * 1.5, n * 1000000007, n % 3 FROM g;
      INSERT INTO cats VALUES (1, 'uno'), (2, 'dos'), (3, 'tres');
      CREATE TABLE items_copy (id INTEGER PRIMARY KEY, name TEXT, amount REAL, big INTEGER, bin BLOB, loose, note TEXT);
    `)
  }, 60_000)

  afterAll(async () => {
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  const out = () => join(dir, 'out')

  it('CSV of a multi-table SELECT through a separate read-only worker', async () => {
    const before = spawner.pids.length
    const { text, result } = await run(service, id, out(), 'join.csv', {
      kind: 'statement',
      sql: 'SELECT i.id, i.name, c.label, i.note FROM items i JOIN cats c ON c.id = i.id ORDER BY i.id'
    })
    expect(result.rows).toBe(3)
    expect(parseCsv(text())).toEqual([
      ['id', 'name', 'label', 'note'],
      ['1', NAME, 'uno', NOTE],
      ['2', '', 'dos', ''],
      ['3', '=1+1', 'tres', ';semi,comma']
    ])
    expect(spawner.pids.length).toBe(before + 1)
  })

  it('does not see the uncommitted changes of a query tab', async () => {
    await exec("BEGIN; INSERT INTO items (id, name) VALUES (99999, 'sin confirmar')", 'tab-tx')
    try {
      const { result } = await run(
        service,
        id,
        out(),
        'committed.json',
        { kind: 'statement', sql: 'SELECT id FROM items' },
        { format: 'json' }
      )
      expect(result.rows).toBe(ROWS)
    } finally {
      await lite.rollback(id, 'tab-tx')
    }
  })

  it('the INSERT script keeps every storage class (blobs, big integers, untyped values)', async () => {
    const { text, result } = await run(
      service,
      id,
      out(),
      'items.sql',
      { kind: 'table', request: { schema: 'main', table: 'items' } },
      { format: 'sql', table: 'items_copy', batchSize: 500, dialect: 'sqlite' }
    )
    expect(result.rows).toBe(ROWS)
    await exec(text())
    expect(await snapshot('items_copy')).toEqual(await snapshot('items'))
  })

  it('JSON numbers follow the storage class', async () => {
    const { text } = await run(
      service,
      id,
      out(),
      'all.json',
      { kind: 'table', request: { schema: 'main', table: 'items', where: 'id < 100' } },
      { format: 'json' }
    )
    expect(JSON.parse(text())).toEqual([
      {
        id: 1,
        name: NAME,
        amount: 1.5,
        big: '9223372036854775807',
        bin: '0x00FF00',
        loose: 'texto',
        note: NOTE
      },
      { id: 2, name: null, amount: null, big: null, bin: null, loose: null, note: null },
      { id: 3, name: '=1+1', amount: -0.000001, big: 0, bin: '0x', loose: 42, note: ';semi,comma' }
    ])
  })

  it('refuses writes', async () => {
    for (const sql of ['DELETE FROM items', 'PRAGMA journal_mode = WAL', "ATTACH 'x.db' AS x"])
      await expect(run(service, id, out(), 'w.csv', { kind: 'statement', sql })).rejects.toThrow(
        /solo lectura|lectura/
      )
    expect((await exec('SELECT count(*) FROM items'))[0].resultSet!.rows).toEqual([[ROWS]])
  })

  it('cancel ends the reader process only: the tabs keep their handle', async () => {
    const tabPid = spawner.pids[0]
    const started = Date.now()
    const running = service.query('op-lite-cancel', {
      connectionId: id,
      filePath: join(out(), 'cancel.csv'),
      source: {
        kind: 'statement',
        sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c'
      },
      options: defaultExportOptions()
    })
    const settled = running.then(
      () => 'resolved',
      (err: Error) => err.message
    )
    await new Promise((r) => setTimeout(r, 400))
    await service.cancel('op-lite-cancel')
    expect(await settled).toBe(CANCELLED_EXPORT)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(readdirSync(out()).filter((f) => f.startsWith('cancel'))).toEqual([])
    // The query tabs' worker is the same process and still answers.
    expect(spawner.pids[0]).toBe(tabPid)
    expect((await exec('SELECT count(*) FROM cats'))[0].resultSet!.rows).toEqual([[3]])
  })
})
