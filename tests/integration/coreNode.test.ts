/**
 * The core as an editor extension would load it, with no Electron anywhere:
 * src/core/index.ts bundled by scripts/core-bundle.mjs (CommonJS, npm packages
 * external) and loaded with Node's own require, not Vite's module runner, so
 * nothing is aliased or mocked. Against MySQL 8.4, PostgreSQL 17, MongoDB 8.2
 * and a SQLite file whose worker is a real child process (nodeSqliteSpawner),
 * each engine opens a connection, runs a query, introspects, applies one row
 * edit and sees the production guard refuse an unconfirmed write. Passwords go
 * through the vault-key codec into the core's own credentials.json. The SQL
 * engines also export a full result (export:query) to CSV/XLSX in a read-only
 * session, as the editor extension's «Exportar» does.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type * as CoreModule from '../../src/core'
import type {
  ConnectionInput,
  MongoCommandResult,
  ProgressEvent,
  QueryStatementResult
} from '@shared/types'
import { unzip } from '@main/export/testing/unzip'
import { bundleCore, bundleSqliteWorker, ROOT } from '../../scripts/core-bundle.mjs'
import { describeServer, MONGO_TARGET, POSTGRES_TARGET, type ServerSpec } from './targets'

type Core = typeof CoreModule
type VortaqCore = CoreModule.VortaqCore

const nodeRequire = createRequire(import.meta.url)
const SUFFIX = `${process.pid}`

/** MySQL 8.4 only (the MySQL suites cover 5.7). */
const MYSQL84_TARGET: ServerSpec = {
  label: 'MySQL 8.4',
  envName: 'TEST_MYSQL_URL',
  example: 'mysql://root:navidog@127.0.0.1:33306/navidog_test'
}

/* ---------- the bundle, built once per run inside the repository (node_modules resolve) ---------- */

let built: Promise<{ dir: string; core: Core; workerPath: string }> | null = null
const cleanups: (() => Promise<void> | void)[] = []

function loadBundle(): Promise<{ dir: string; core: Core; workerPath: string }> {
  built ??= (async () => {
    const cache = join(ROOT, 'node_modules', '.cache')
    mkdirSync(cache, { recursive: true })
    const dir = mkdtempSync(join(cache, 'vortaq-core-it-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const corePath = await bundleCore(join(dir, 'core.cjs'))
    const workerPath = await bundleSqliteWorker(join(dir, 'sqliteWorker.cjs'))
    return { dir, core: nodeRequire(corePath) as Core, workerPath }
  })()
  return built
}

afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A core with its own profile folder and vault key, like one extension install. */
async function newCore(options: Partial<CoreModule.CoreOptions> = {}): Promise<{
  core: VortaqCore
  lib: Core
  profile: string
}> {
  const { core: lib } = await loadBundle()
  const profile = mkdtempSync(join(tmpdir(), 'vortaq-core-node-'))
  const core = lib.createCore({
    dataDir: profile,
    home: profile,
    secrets: { codec: lib.keyCodec(lib.newVaultKey()), codecName: 'vaultKey' },
    ...options
  })
  cleanups.push(async () => {
    await core.dispose()
    rmSync(profile, { recursive: true, force: true })
  })
  return { core, lib, profile }
}

function baseInput(overrides: Partial<ConnectionInput>): ConnectionInput {
  return {
    name: 'Core IT',
    color: null,
    environment: 'local',
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

const ok = (results: QueryStatementResult[]): QueryStatementResult[] => {
  const failed = results.find((r) => r.error)
  if (failed) throw new Error(`${failed.sql}: ${failed.error}`)
  return results
}

const okMongo = (results: MongoCommandResult[]): MongoCommandResult[] => {
  const failed = results.find((r) => r.kind === 'error')
  if (failed) throw new Error(`${failed.statement}: ${failed.error}`)
  return results
}

const CONFIRM = /necesita confirmación explícita/

/** A scratch folder for exported files; `parts()` lists the `.part` files left in it. */
function exportFolder(): { dir: string; parts: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'vortaq-core-export-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, parts: () => readdirSync(dir).filter((f) => f.endsWith('.part')) }
}

/**
 * The editor extension's webviews receive results as JSON messages, not through Electron's
 * structured clone (docs/vscode-extension-design.md, 9.3): nothing may change on the way.
 */
function expectJsonSafe(value: unknown): void {
  expect(JSON.parse(JSON.stringify(value))).toEqual(value)
}

describe('core bundle loaded by plain Node', () => {
  it('loads without Electron and keeps its secrets encrypted', async () => {
    const { dir } = await loadBundle()
    expect(process.versions.electron).toBeUndefined()
    const loaded = Object.keys(nodeRequire.cache)
    expect(loaded).toContain(join(dir, 'core.cjs'))
    expect(loaded.filter((p) => /[\\/]node_modules[\\/]electron[\\/]/.test(p))).toEqual([])
    expect(readFileSync(join(dir, 'core.cjs'), 'utf8')).not.toMatch(/require\(["']electron["']\)/)

    const { core, profile } = await newCore()
    const saved = await core.invoke(
      'connections:save',
      baseInput({ engine: 'mysql', host: '127.0.0.1', port: 3306, username: 'u' })
    )
    await core.invoke('connections:setPassword', saved.id, 'core-vault-secret')
    expect(await core.invoke('connections:hasPassword', saved.id)).toBe(true)
    expect(readFileSync(join(profile, 'credentials.json'), 'utf8')).not.toContain(
      'core-vault-secret'
    )
  })
})

describe('core bundle in plain Node [SQLite file, child-process worker]', () => {
  let core: VortaqCore
  let lib: Core
  let id: string
  let prodId: string
  const progress: ProgressEvent[] = []

  beforeAll(async () => {
    const { workerPath, core: loaded } = await loadBundle()
    lib = loaded
    const created = await newCore({
      sqliteSpawner: lib.nodeSqliteSpawner(workerPath),
      emit: (channel, payload) => {
        if (channel === 'event:progress') progress.push(payload as ProgressEvent)
      }
    })
    core = created.core
    expect(lib.sqliteRuntimeProblem()).toBeNull()
    const file = join(created.profile, 'core-it.db')
    await core.invoke('sqlite:createFile', file)
    const sqlite = { ...lib.defaultSqliteOptions(false), filePath: file }
    id = (
      await core.invoke(
        'connections:save',
        baseInput({ engine: 'sqlite', authMode: 'none', sqlite })
      )
    ).id
    prodId = (
      await core.invoke(
        'connections:save',
        baseInput({
          engine: 'sqlite',
          authMode: 'none',
          name: 'Core IT prod',
          environment: 'production',
          sqlite
        })
      )
    ).id
  })

  it('opens the file and runs a query', async () => {
    const info = await core.invoke('connections:open', id)
    expect(info.engine).toBe('sqlite')
    const [r] = ok(await core.invoke('db:execute', id, "SELECT 'ok' AS v, sqlite_version() AS s"))
    expect(r.resultSet?.rows[0][0]).toBe('ok')
  })

  it('returns results that survive JSON (webview messages)', async () => {
    const results = ok(
      await core.invoke(
        'db:execute',
        id,
        "SELECT 1 AS i, 1.5 AS r, 'x' AS t, x'00ff' AS b, NULL AS n, 9223372036854775807 AS big"
      )
    )
    expect(results[0].resultSet?.rows[0]).toEqual([
      1,
      1.5,
      'x',
      '0x00FF',
      null,
      '9223372036854775807'
    ])
    expectJsonSafe(results)
  })

  it('introspects a table and applies one row edit', async () => {
    ok(
      await core.invoke(
        'db:execute',
        id,
        "CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO item (name) VALUES ('uno');"
      )
    )
    expect((await core.invoke('db:tables', id, 'main')).map((t) => t.name)).toEqual(['item'])
    expect((await core.invoke('db:columns', id, 'main', 'item')).map((c) => c.name)).toEqual([
      'id',
      'name'
    ])
    const edit = await core.invoke('db:applyRowChanges', id, 'main', 'item', [
      { kind: 'update', key: { id: 1 }, values: { name: 'dos' } }
    ])
    expect(edit.applied).toBe(1)
    const page = await core.invoke('db:tableData', id, {
      schema: 'main',
      table: 'item',
      limit: 10,
      offset: 0
    })
    expect(page.rows).toEqual([[1, 'dos']])
  })

  it('refuses an unconfirmed write on production', async () => {
    await expect(
      core.invoke('db:execute', prodId, "UPDATE item SET name = 'tres'")
    ).rejects.toThrow(CONFIRM)
    await expect(
      core.invoke('db:applyRowChanges', prodId, 'main', 'item', [
        { kind: 'update', key: { id: 1 }, values: { name: 'tres' } }
      ])
    ).rejects.toThrow(CONFIRM)
    const [r] = ok(await core.invoke('db:execute', prodId, 'SELECT name FROM item'))
    expect(r.resultSet?.rows).toEqual([['dos']])
  })

  it('exports the full result to CSV and XLSX in a read-only reader, on production too', async () => {
    const { dir, parts } = exportFolder()
    ok(
      await core.invoke(
        'db:execute',
        id,
        `CREATE TABLE venta (id INTEGER PRIMARY KEY, cliente TEXT, total REAL, foto BLOB);
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
         INSERT INTO venta SELECT i, 'Cliente ' || i, i * 0.5, CASE WHEN i = 1 THEN x'00ff' END FROM n;`
      )
    )
    const csv = join(dir, 'ventas.csv')
    const result = await core.invoke('export:query', 'node-csv', {
      connectionId: prodId,
      filePath: csv,
      source: { kind: 'statement', sql: 'SELECT id, cliente, total, foto FROM venta ORDER BY id' },
      options: lib.defaultExportOptions({ format: 'csv', nullText: 'NULL' })
    })
    expect(result.rows).toBe(2500)
    const lines = readFileSync(csv, 'utf8').trimEnd().split('\r\n')
    expect(lines).toHaveLength(2501)
    expect(lines.slice(0, 3)).toEqual([
      'id,cliente,total,foto',
      '1,Cliente 1,0.5,0x00FF',
      '2,Cliente 2,1,NULL'
    ])
    expect(progress.filter((e) => e.operationId === 'node-csv').at(-1)).toMatchObject({
      kind: 'export',
      done: true,
      current: 2500
    })

    const xlsx = join(dir, 'venta.xlsx')
    const book = await core.invoke('export:query', 'node-xlsx', {
      connectionId: id,
      filePath: xlsx,
      source: { kind: 'table', request: { schema: 'main', table: 'venta', orderBy: null } },
      options: lib.defaultExportOptions({ format: 'xlsx', sheetName: 'venta' })
    })
    expect(book.rows).toBe(2500)
    const sheet = unzip(xlsx).get('xl/worksheets/sheet1.xml')!.data.toString('utf8')
    expect(sheet).toContain('Cliente 2500')
    expect(parts()).toEqual([])
  })

  it('cancels a runaway full export by killing its reader, leaving no file', async () => {
    const { dir, parts } = exportFolder()
    const file = join(dir, 'infinito.csv')
    const started = core.invoke('export:query', 'node-cancel', {
      connectionId: id,
      filePath: file,
      source: {
        kind: 'statement',
        sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c'
      },
      options: lib.defaultExportOptions({ format: 'csv' })
    })
    const outcome = started.then(
      () => null,
      (err: Error) => err
    )
    // Cancel once rows are being written (the progress events arrive every 250 ms).
    const deadline = Date.now() + 10_000
    while (!progress.some((e) => e.operationId === 'node-cancel' && e.phase === 'rows')) {
      if (Date.now() > deadline) throw new Error('the export never started writing rows')
      await new Promise((r) => setTimeout(r, 20))
    }
    await core.invoke('export:cancel', 'node-cancel')
    const err = await outcome
    expect(err?.message).toBe(lib.CANCELLED_EXPORT)
    expect(existsSync(file)).toBe(false)
    expect(parts()).toEqual([])
    // The connection's own handle still works afterwards.
    const [r] = ok(await core.invoke('db:execute', id, 'SELECT COUNT(*) FROM venta'))
    expect(r.resultSet?.rows).toEqual([[2500]])
  })

  it('refuses a MongoDB connection before connecting', async () => {
    const mongo = await core.invoke(
      'connections:save',
      baseInput({ engine: 'mongodb', host: '127.0.0.1', port: 1 })
    )
    const { dir } = exportFolder()
    await expect(
      core.invoke('export:query', 'node-mongo', {
        connectionId: mongo.id,
        filePath: join(dir, 'x.csv'),
        source: { kind: 'statement', sql: 'SELECT 1' },
        options: lib.defaultExportOptions()
      })
    ).rejects.toThrow(lib.EXPORT_MONGO_REFUSED)
  })
})

describeServer(MYSQL84_TARGET, 'core bundle in plain Node', (url) => {
  const DB = `vortaq_core_${SUFFIX}`
  let core: VortaqCore
  let id: string
  let prodId: string

  beforeAll(async () => {
    core = (await newCore()).core
    const u = new URL(url)
    const input = (overrides: Partial<ConnectionInput> = {}) =>
      baseInput({
        engine: 'mysql',
        host: u.hostname,
        port: Number(u.port || 3306),
        username: decodeURIComponent(u.username),
        ...overrides
      })
    id = (await core.invoke('connections:save', input())).id
    prodId = (
      await core.invoke(
        'connections:save',
        input({ name: 'Core IT prod', environment: 'production' })
      )
    ).id
    for (const c of [id, prodId])
      await core.invoke('connections:setPassword', c, decodeURIComponent(u.password))
  })

  afterAll(async () => {
    await core?.invoke('db:execute', id, `DROP DATABASE IF EXISTS ${DB}`).catch(() => undefined)
  })

  it('opens the connection and runs a query', async () => {
    const info = await core.invoke('connections:open', id)
    expect(info.version).toMatch(/^8\.4/)
    const [r] = ok(await core.invoke('db:execute', id, "SELECT 'ok' AS v"))
    expect(r.resultSet?.rows).toEqual([['ok']])
  })

  it('returns results that survive JSON (webview messages)', async () => {
    const results = ok(
      await core.invoke(
        'db:execute',
        id,
        `SELECT 1 AS i, 1.5 AS d, 2.5e0 AS f, 'x' AS t, x'00ff' AS b, NULL AS n,
                CAST(18446744073709551615 AS UNSIGNED) AS big, NOW() AS ts, DATE('2026-01-02') AS dt,
                CAST('{"a":1}' AS JSON) AS j, CAST(1 AS UNSIGNED) = 1 AS flag`
      )
    )
    expectJsonSafe(results)
    expect(results[0].resultSet?.rows[0][6]).toBe('18446744073709551615')
  })

  it('introspects a table and applies one row edit', async () => {
    ok(
      await core.invoke(
        'db:execute',
        id,
        `DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB};
         CREATE TABLE ${DB}.item (id INT PRIMARY KEY, name VARCHAR(20));
         INSERT INTO ${DB}.item VALUES (1, 'uno');`
      )
    )
    expect((await core.invoke('db:tables', id, DB)).map((t) => t.name)).toEqual(['item'])
    expect((await core.invoke('db:columns', id, DB, 'item')).map((c) => c.name)).toEqual([
      'id',
      'name'
    ])
    const edit = await core.invoke('db:applyRowChanges', id, DB, 'item', [
      { kind: 'update', key: { id: 1 }, values: { name: 'dos' } }
    ])
    expect(edit.applied).toBe(1)
    const page = await core.invoke('db:tableData', id, {
      schema: DB,
      table: 'item',
      limit: 10,
      offset: 0
    })
    expect(page.rows).toEqual([[1, 'dos']])
  })

  it('refuses an unconfirmed write on production, and runs it once confirmed', async () => {
    const update = `UPDATE ${DB}.item SET name = 'tres' WHERE id = 1`
    await expect(core.invoke('db:execute', prodId, update)).rejects.toThrow(CONFIRM)
    await expect(
      core.invoke('db:applyRowChanges', prodId, DB, 'item', [
        { kind: 'update', key: { id: 1 }, values: { name: 'tres' } }
      ])
    ).rejects.toThrow(CONFIRM)
    const read = async () =>
      ok(await core.invoke('db:execute', prodId, `SELECT name FROM ${DB}.item`))[0].resultSet?.rows
    expect(await read()).toEqual([['dos']])
    ok(await core.invoke('db:execute', prodId, update, { confirmProduction: true }))
    expect(await read()).toEqual([['tres']])
  })

  it('exports the full result in a new read-only session, in the run database', async () => {
    const { dir, parts } = exportFolder()
    const lib = (await loadBundle()).core
    const file = join(dir, 'item.csv')
    // Unqualified: the context (the database the result ran in) picks the table.
    const result = await core.invoke('export:query', `mysql-${SUFFIX}`, {
      connectionId: prodId,
      filePath: file,
      source: { kind: 'statement', sql: 'SELECT id, name FROM item ORDER BY id', context: DB },
      options: lib.defaultExportOptions({ format: 'csv' })
    })
    expect(result.rows).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe('id,name\r\n1,tres\r\n')
    expect(parts()).toEqual([])
  })
})

describeServer(POSTGRES_TARGET, 'core bundle in plain Node', (url) => {
  const SCHEMA = `vortaq_core_${SUFFIX}`
  let core: VortaqCore
  let id: string
  let prodId: string
  let database: string

  beforeAll(async () => {
    core = (await newCore()).core
    const u = new URL(url)
    database = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres'
    const input = (overrides: Partial<ConnectionInput> = {}) =>
      baseInput({
        engine: 'postgresql',
        host: u.hostname,
        port: Number(u.port || 5432),
        username: decodeURIComponent(u.username),
        ssl: { enabled: false, verifyServer: false, mode: 'disable' },
        postgres: {
          initialDatabase: database,
          showSystemSchemas: false,
          timeZone: '',
          searchPath: ''
        },
        ...overrides
      })
    id = (await core.invoke('connections:save', input())).id
    prodId = (
      await core.invoke(
        'connections:save',
        input({ name: 'Core IT prod', environment: 'production' })
      )
    ).id
    for (const c of [id, prodId])
      await core.invoke('connections:setPassword', c, decodeURIComponent(u.password))
  })

  afterAll(async () => {
    await core
      ?.invoke('db:execute', id, `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      .catch(() => undefined)
  })

  it('opens the connection and runs a query', async () => {
    const info = await core.invoke('connections:open', id)
    expect(info.engine).toBe('postgresql')
    expect(info.version).toMatch(/17/)
    const [r] = ok(await core.invoke('db:execute', id, "SELECT 'ok' AS v"))
    expect(r.resultSet?.rows).toEqual([['ok']])
  })

  it('returns results that survive JSON (webview messages)', async () => {
    const results = ok(
      await core.invoke(
        'db:execute',
        id,
        `SELECT 1 AS i, 1.5::float8 AS f, 'NaN'::float8 AS nan, 'x' AS t, '\\x00ff'::bytea AS b,
                NULL AS n, 9223372036854775807::bigint AS big, 1.10::numeric AS num, now() AS ts,
                '{"a":1}'::jsonb AS j, interval '1 day' AS iv, true AS flag`
      )
    )
    expectJsonSafe(results)
    const row = results[0].resultSet!.rows[0]
    expect(row[2]).toBe('NaN')
    expect(row[6]).toBe('9223372036854775807')
  })

  it('introspects a table and applies one row edit', async () => {
    const ref = { database, schema: SCHEMA }
    ok(
      await core.invoke(
        'db:execute',
        id,
        `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
         CREATE TABLE ${SCHEMA}.item (id int PRIMARY KEY, name text);
         INSERT INTO ${SCHEMA}.item VALUES (1, 'uno');`
      )
    )
    expect((await core.invoke('db:tables', id, ref)).map((t) => t.name)).toEqual(['item'])
    expect((await core.invoke('db:columns', id, ref, 'item')).map((c) => c.name)).toEqual([
      'id',
      'name'
    ])
    const edit = await core.invoke('db:applyRowChanges', id, ref, 'item', [
      { kind: 'update', key: { id: 1 }, values: { name: 'dos' } }
    ])
    expect(edit.applied).toBe(1)
    const page = await core.invoke('db:tableData', id, {
      schema: ref,
      table: 'item',
      limit: 10,
      offset: 0
    })
    expect(page.rows).toEqual([[1, 'dos']])
  })

  it('refuses an unconfirmed write on production', async () => {
    const ref = { database, schema: SCHEMA }
    await expect(
      core.invoke('db:execute', prodId, `UPDATE ${SCHEMA}.item SET name = 'tres'`, { schema: ref })
    ).rejects.toThrow(CONFIRM)
    await expect(
      core.invoke('db:applyRowChanges', prodId, ref, 'item', [
        { kind: 'update', key: { id: 1 }, values: { name: 'tres' } }
      ])
    ).rejects.toThrow(CONFIRM)
    const [r] = ok(await core.invoke('db:execute', prodId, `SELECT name FROM ${SCHEMA}.item`))
    expect(r.resultSet?.rows).toEqual([['dos']])
  })

  it('exports the full result in a new read-only session, with the run schema', async () => {
    const { dir, parts } = exportFolder()
    const lib = (await loadBundle()).core
    const file = join(dir, 'item.json')
    const result = await core.invoke('export:query', `pg-${SUFFIX}`, {
      connectionId: prodId,
      filePath: file,
      source: {
        kind: 'statement',
        sql: 'SELECT id, name FROM item ORDER BY id',
        context: { database, schema: SCHEMA }
      },
      options: lib.defaultExportOptions({ format: 'json' })
    })
    expect(result.rows).toBe(1)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([{ id: 1, name: 'dos' }])
    expect(parts()).toEqual([])
  })
})

describeServer(MONGO_TARGET, 'core bundle in plain Node', (url) => {
  const DB = `vortaq_core_${SUFFIX}`
  let core: VortaqCore
  let id: string
  let prodId: string

  beforeAll(async () => {
    const created = await newCore()
    core = created.core
    const p = created.lib.parseMongoUri(url)
    const input = (overrides: Partial<ConnectionInput> = {}) =>
      baseInput({
        engine: 'mongodb',
        host: p.host,
        port: p.port,
        username: p.username,
        ssl: { enabled: p.ssl.enabled, verifyServer: p.ssl.verifyServer },
        mongo: { ...p.mongo, defaultDatabase: DB },
        network: { connectTimeoutMs: 5000, keepAliveSec: 60 },
        ...overrides
      })
    id = (await core.invoke('connections:save', input())).id
    prodId = (
      await core.invoke(
        'connections:save',
        input({ name: 'Core IT prod', environment: 'production' })
      )
    ).id
    for (const c of [id, prodId]) await core.invoke('connections:setPassword', c, p.password)
  })

  afterAll(async () => {
    await core?.invoke('db:dropDatabase', id, DB).catch(() => undefined)
  })

  const run = (connectionId: string, script: string, confirmProduction = false) =>
    core.invoke('mongo:execute', connectionId, script, { database: DB, confirmProduction })

  it('opens the connection and runs a query', async () => {
    const info = await core.invoke('connections:open', id)
    expect(info.engine).toBe('mongodb')
    okMongo(await run(id, "db.item.insertOne({ _id: 1, name: 'uno' })"))
    const [found] = okMongo(await run(id, 'db.item.find({ _id: 1 })'))
    expect(found.kind).toBe('documents')
    expect(found.page?.docs).toEqual(['{"_id":{"$numberInt":"1"},"name":"uno"}'])
  })

  it('returns pages that survive JSON (webview messages)', async () => {
    okMongo(
      await run(
        id,
        "db.json_safe.insertOne({ _id: 7, big: NumberLong('9223372036854775807'), d: Decimal128('1.10'), at: ISODate('2026-01-02T03:04:05Z'), bin: BinData(0, 'AP8=') })"
      )
    )
    const page = await core.invoke('mongo:find', id, {
      database: DB,
      collection: 'json_safe',
      filter: '{}',
      sort: '',
      projection: '',
      skip: 0,
      limit: 10
    })
    expectJsonSafe(page)
    expect(page.docs[0]).toContain('"$numberLong":"9223372036854775807"')
    okMongo(await run(id, 'db.json_safe.drop()'))
  })

  it('introspects the collections and applies one document edit', async () => {
    expect((await core.invoke('db:databases', id)).map((d) => d.name)).toContain(DB)
    expect((await core.invoke('mongo:collections', id, DB)).map((c) => c.name)).toEqual(['item'])
    const edit = await core.invoke('mongo:applyChanges', id, DB, 'item', [
      {
        kind: 'update',
        id: '{"$numberInt":"1"}',
        set: { name: '"dos"' },
        unset: [],
        expected: { name: '"uno"' }
      }
    ])
    expect(edit.failure).toBeNull()
    expect(await core.invoke('mongo:document', id, DB, 'item', '{"$numberInt":"1"}')).toBe(
      '{"_id":{"$numberInt":"1"},"name":"dos"}'
    )
  })

  it('refuses an unconfirmed write on production', async () => {
    await expect(run(prodId, "db.item.updateMany({}, { $set: { name: 'tres' } })")).rejects.toThrow(
      CONFIRM
    )
    await expect(
      core.invoke('mongo:applyChanges', prodId, DB, 'item', [
        { kind: 'delete', id: '{"$numberInt":"1"}' }
      ])
    ).rejects.toThrow(/confirmación/)
    const [found] = okMongo(await run(prodId, 'db.item.find({})'))
    expect(found.page?.docs).toEqual(['{"_id":{"$numberInt":"1"},"name":"dos"}'])
  })
})
