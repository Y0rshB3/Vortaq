/**
 * The core as an editor extension would load it, with no Electron anywhere:
 * src/core/index.ts bundled by scripts/core-bundle.mjs (CommonJS, npm packages
 * external) and loaded with Node's own require, not Vite's module runner, so
 * nothing is aliased or mocked. Against MySQL 8.4, PostgreSQL 17, MongoDB 8.2
 * and a SQLite file whose worker is a real child process (nodeSqliteSpawner),
 * each engine opens a connection, runs a query, introspects, applies one row
 * edit and sees the production guard refuse an unconfirmed write. Passwords go
 * through the vault-key codec into the core's own credentials.json.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type * as CoreModule from '../../src/core'
import type { ConnectionInput, MongoCommandResult, QueryStatementResult } from '@shared/types'
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
  let id: string
  let prodId: string

  beforeAll(async () => {
    const { workerPath, core: lib } = await loadBundle()
    const created = await newCore({ sqliteSpawner: lib.nodeSqliteSpawner(workerPath) })
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
