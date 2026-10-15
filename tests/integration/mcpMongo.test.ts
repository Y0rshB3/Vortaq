/**
 * MCP server (src/main/mcp) against MongoDB 8.2: the structure tools follow the
 * AI assistant's rules (no documents, no enum/pattern literals, no view
 * pipelines or partial filters), run_query accepts only provable reads
 * (documents as canonical Extended JSON), a timeout kills the operation on the
 * server, execute_sql writes only at the write level, and real driver errors
 * are redacted.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import { parseMongoUri } from '@shared/mongo/uri'
import { isMongoConnection } from '@main/mongo/connection'
import { MONGO_TARGET, describeServer } from './targets'
import { baseInput, closedPort, startMcpHarness, until, type McpHarness } from './mcpHarness'

describeServer(MONGO_TARGET, 'MCP server', (url) => {
  const DB = `vortaq_mcp_${process.pid}`
  const p = parseMongoUri(url)
  const server = {
    engine: 'mongodb',
    host: p.host,
    port: p.port,
    username: p.username,
    ssl: { enabled: p.ssl.enabled, verifyServer: p.ssl.verifyServer },
    mongo: { ...p.mongo, defaultDatabase: DB },
    network: { connectTimeoutMs: 4000, keepAliveSec: 60 }
  } satisfies Partial<ConnectionInput>
  const password = p.password
  let h: McpHarness

  async function db() {
    const connection = await h.runtime.manager.connection(h.byName('Admin').id)
    if (!isMongoConnection(connection)) throw new Error('not mongo')
    return connection.db(DB)
  }

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
          mongo: { ...server.mongo, topology: 'standalone', directConnection: true },
          network: { connectTimeoutMs: 1500, keepAliveSec: 0 },
          mcp: { enabled: true, access: 'read' }
        }),
        password
      }
    ])
    const d = await db()
    await d.dropDatabase().catch(() => undefined)
    await d.createCollection('people', {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['name'],
          properties: {
            name: { bsonType: 'string', description: 'Nombre completo' },
            status: { enum: ['activo', 'baja_secreta'] },
            code: { bsonType: 'string', pattern: '^SEC-' }
          }
        }
      }
    })
    const { Int32, Long, Decimal128 } = await import('bson')
    await d.collection('people').insertMany([
      {
        _id: 1 as never,
        name: 'Ana Secreta',
        age: new Int32(30),
        big: Long.fromString('9007199254740993'),
        price: Decimal128.fromString('19.90'),
        tags: ['vip']
      },
      { _id: 2 as never, name: 'Luis', age: new Int32(41), status: 'activo' }
    ])
    await d.collection('people').createIndex({ name: 1 }, { unique: true })
    await d
      .collection('people')
      .createIndex(
        { age: -1 },
        { name: 'age_partial', partialFilterExpression: { status: 'vip_oculto' } }
      )
    await d.createCollection('v_people', {
      viewOn: 'people',
      pipeline: [{ $match: { name: 'Pipeline Secreto' } }]
    })
    await d.collection('slow').insertMany(Array.from({ length: 50 }, (_, i) => ({ i })))
  }, 120_000)

  afterAll(async () => {
    await (await db()).dropDatabase().catch(() => undefined)
    await h?.close()
  })

  it('structure tools give names, indexes and field types, never values or literals', async () => {
    const dbs = (await h.ok('list_databases', { connection: 'Esquema' })).databases.map(
      (d: { name: string }) => d.name
    )
    expect(dbs).toContain(DB)
    expect(dbs).not.toContain('admin')
    const list = await h.ok('list_tables', { connection: 'Esquema', database: DB })
    expect(list.collections).toEqual(
      expect.arrayContaining([
        { name: 'people', kind: 'collection' },
        { name: 'v_people', kind: 'view', view_on: 'people' }
      ])
    )
    const people = await h.ok('describe_table', {
      connection: 'Esquema',
      database: DB,
      table: 'people'
    })
    expect(people.sampled_documents).toBe(2)
    const fields = Object.fromEntries(
      people.fields.map((f: { path: string; types: unknown }) => [f.path, f.types])
    )
    expect(fields.name).toEqual({ string: 2 })
    expect(fields.big).toEqual({ long: 1 })
    expect(people.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'name_1',
          unique: true,
          keys: [{ field: 'name', order: 'asc' }]
        }),
        expect.objectContaining({
          name: 'age_partial',
          partial: true,
          keys: [{ field: 'age', order: 'desc' }]
        })
      ])
    )
    expect(people.validator_schema.required).toEqual(['name'])
    const view = await h.ok('describe_table', {
      connection: 'Esquema',
      database: DB,
      table: 'v_people'
    })
    expect(view.view_on).toBe('people')
    const text = JSON.stringify([list, people, view])
    for (const secret of [
      'Ana Secreta',
      'Luis',
      'baja_secreta',
      '^SEC-',
      'vip_oculto',
      'Pipeline Secreto',
      '9007199254740993'
    ])
      expect(text).not.toContain(secret)
    expect(
      await h.refused('run_query', { connection: 'Esquema', database: DB, sql: 'db.people.find()' })
    ).toMatch(/Solo estructura/)
  })

  it('run_query returns documents as canonical Extended JSON and refuses writes', async () => {
    const r = await h.ok('run_query', {
      connection: 'Lectura',
      database: DB,
      sql: 'db.people.find({}, { tags: 0 }).sort({ _id: 1 })'
    })
    const [first] = r.statements
    expect(first.kind).toBe('documents')
    expect(first.documents[0]).toMatchObject({
      _id: { $numberInt: '1' },
      name: 'Ana Secreta',
      big: { $numberLong: '9007199254740993' },
      price: { $numberDecimal: '19.90' }
    })
    const counted = await h.ok('run_query', {
      connection: 'Lectura',
      database: DB,
      sql: "db.people.countDocuments({ status: 'activo' })"
    })
    expect(counted.statements[0].value).toEqual({ $numberInt: '1' })
    const limited = await h.ok('run_query', {
      connection: 'Lectura',
      database: DB,
      sql: 'db.slow.find()',
      max_rows: 10
    })
    expect(limited.statements[0].document_count).toBe(10)
    expect(limited.statements[0].truncated).toBe(true)
    for (const sql of [
      "db.people.insertOne({ name: 'x' })",
      "db.people.aggregate([{ $out: 'copia' }])",
      "db.people.aggregate([{ $match: {} }, { $merge: { into: 'copia' } }])",
      'db.people.drop()'
    ])
      expect(await h.refused('run_query', { connection: 'Lectura', database: DB, sql })).toMatch(
        /run_query/
      )
    expect(await (await db()).listCollections({ name: 'copia' }).toArray()).toEqual([])
    // Commands that describe the deployment (member hosts, clients, other sessions) are refused.
    for (const sql of ['rs.status()', 'db.serverStatus()', 'db.currentOp()'])
      expect(await h.refused('run_query', { connection: 'Lectura', database: DB, sql })).toMatch(
        /no están disponibles para agentes/
      )
    expect(
      await h.refused('execute_sql', {
        connection: 'Escritura',
        database: DB,
        sql: 'db.currentOp()'
      })
    ).toMatch(/no están disponibles para agentes/)
    expect(
      (
        await h.ok('run_query', {
          connection: 'Lectura',
          database: DB,
          sql: 'db.getCollectionNames()'
        })
      ).statements[0].value
    ).toEqual(expect.arrayContaining(['people', 'slow']))
  })

  it('explain and stats answers lose the server host; server stages and system databases are refused', async () => {
    const explained = await h.ok('run_query', {
      connection: 'Lectura',
      database: DB,
      sql: "db.people.find({ name: 'Luis' }).explain()"
    })
    const plan = JSON.stringify(explained.statements[0].value)
    expect(plan).toMatch(/queryPlanner/)
    expect(plan).not.toMatch(/serverInfo|"host"|57017/)
    const stats = await h.ok('run_query', {
      connection: 'Lectura',
      database: DB,
      sql: 'db.people.stats()'
    })
    expect(JSON.stringify(stats.statements[0].value)).not.toMatch(/"host"|57017/)
    for (const sql of [
      'db.people.aggregate([{ $indexStats: {} }])',
      'db.people.aggregate([{ $collStats: { count: {} } }])',
      "db.people.aggregate([{ $lookup: { from: 'x', pipeline: [{ $collStats: {} }], as: 'y' } }])"
    ])
      expect(await h.refused('run_query', { connection: 'Lectura', database: DB, sql })).toMatch(
        /no están disponibles para agentes/
      )
    for (const [database, sql] of [
      ['admin', 'db.system.users.find()'],
      [DB, 'use local\ndb.startup_log.find()'],
      ['config', 'db.getCollectionNames()']
    ])
      expect(await h.refused('run_query', { connection: 'Lectura', database, sql })).toMatch(
        /bases de datos de sistema/
      )
  })

  it('a timeout kills the operation on the server (killOp)', async () => {
    const started = Date.now()
    expect(
      await h.refused('run_query', {
        connection: 'Lectura',
        database: DB,
        sql: "db.slow.find({ $where: 'sleep(200) || true' })",
        timeout_seconds: 1
      })
    ).toMatch(/tiempo límite/)
    expect(Date.now() - started).toBeLessThan(8000)
    const connection = await h.runtime.manager.connection(h.byName('Admin').id)
    if (!isMongoConnection(connection)) throw new Error('not mongo')
    await until(async () => {
      const ops = await connection.client
        .db('admin')
        .aggregate([
          { $currentOp: { allUsers: true } },
          { $match: { 'command.filter.$where': { $exists: true } } }
        ])
        .toArray()
      return ops.length === 0
    })
  })

  it('execute_sql writes at the write level; refused at read level and on production', async () => {
    const r = await h.ok('execute_sql', {
      connection: 'Escritura',
      database: DB,
      sql: "db.people.insertOne({ _id: 3, name: 'Eva' }); db.people.updateOne({ _id: 3 }, { $set: { status: 'activo' } })"
    })
    expect(r.statements[0].write).toMatchObject({ inserted: 1 })
    expect(r.statements[1].write).toMatchObject({ matched: 1, modified: 1 })
    expect(await (await db()).collection('people').countDocuments()).toBe(3)
    expect(
      await h.refused('execute_sql', {
        connection: 'Lectura',
        database: DB,
        sql: 'db.people.deleteMany({})'
      })
    ).toMatch(/execute_sql necesita/)
    expect(
      await h.refused('execute_sql', {
        connection: 'Producción',
        database: DB,
        sql: 'db.people.deleteMany({})'
      })
    ).toMatch(/producción/)
    expect(await (await db()).collection('people').countDocuments()).toBe(3)
    expect(await h.refused('explain_query', { connection: 'Lectura', sql: 'SELECT 1' })).toMatch(
      /explain\(\)/
    )
  })

  it('redacts real connection-refused and authentication errors', async () => {
    const refused = await h.refused('list_databases', { connection: 'Apagado' })
    expect(refused).toMatch(/conectar|ECONNREFUSED|rechaz|alcanz/i)
    expect(refused).not.toContain('127.0.0.1')
    expect(refused).not.toContain(String(h.byName('Apagado').port))
    const auth = await h.refused('list_databases', { connection: 'Clave mala' })
    expect(auth).toMatch(/contraseña|Authentication|autentic/i)
    expect(auth).not.toContain('not-the-password')
    expect(auth).not.toContain(`${server.host}:${server.port}`)
  }, 30_000)
})
