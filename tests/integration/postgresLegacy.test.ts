/**
 * PostgreSQL before 10 (2.9.2): the catalog stand-ins of postgres/catalogCompat.ts
 * against a real old server. Optional: VORTAQ_TEST_PG_LEGACY_URL, e.g. compose
 * service `postgres92` (postgres:9.2, 127.0.0.1:55492). Everything the desktop
 * app and the editor extension do with a connection runs once: «Probar
 * conexión» and open, the tree, structure and DDL, table data and row edits,
 * result editability, the execution plan, the AI structure reader, a .vqb
 * backup restored into a new database, and the agents (MCP) tools. The
 * fixtures use only syntax every supported server understands.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionInput, QueryStatementResult, SchemaRef } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import { defaultPostgresOptions } from '@shared/engines'
import type { AppContext } from '@main/context'
import { envVar } from '@main/env'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager, getConnectionManager, getSessionFactory } from '@main/db/manager'
import { createPgDbHandlers, type PgDbHandlers } from '@main/ipc/dbPostgres'
import { isPgConnection, type PgDriverConnection } from '@main/postgres/connection'
import type { PgSession } from '@main/postgres/session'
import { PgMetadataQueryable, explainPgSelect, readPgSchemaSnapshot } from '@main/ai/pgMetadata'
import { executionPlan } from '@main/plan/service'
import { createBackupService } from '@main/backup/index'
import { baseInput, startMcpHarness, type McpHarness } from './mcpHarness'

const url = envVar('TEST_PG_LEGACY_URL')?.trim()
/** Optional second server (PostgreSQL 10+): a backup taken there is restored into the old one. */
const newUrl = envVar('TEST_PG_URL')?.trim()
const SRC = `vortaq_old_src_${process.pid}`
const DST = `vortaq_old_dst_${process.pid}`
const CHEAP = { N: 1024, r: 8, p: 1 }

const ok = (results: QueryStatementResult[]): QueryStatementResult[] => {
  const failed = results.find((r) => r.error)
  if (failed) throw new Error(`${failed.sql}: ${failed.error}`)
  return results
}

const SEED = [
  `CREATE SCHEMA app`,
  `CREATE TYPE app.mood AS ENUM ('sad', 'ok', 'happy')`,
  `CREATE DOMAIN app.posint AS integer CHECK (VALUE > 0)`,
  `CREATE TABLE app.clientes (
     id serial PRIMARY KEY,
     nombre varchar(80) NOT NULL,
     email text UNIQUE,
     saldo numeric(10,2) DEFAULT 0,
     creado timestamp DEFAULT now(),
     datos json,
     humor app.mood DEFAULT 'ok',
     tags text[]
   )`,
  `COMMENT ON TABLE app.clientes IS 'Clientes'`,
  `COMMENT ON COLUMN app.clientes.nombre IS 'Nombre visible'`,
  `CREATE TABLE app.pedidos (
     id serial PRIMARY KEY,
     cliente_id integer NOT NULL REFERENCES app.clientes(id) ON DELETE CASCADE,
     total numeric(10,2) NOT NULL CHECK (total >= 0),
     cantidad app.posint
   )`,
  `CREATE INDEX pedidos_cliente_idx ON app.pedidos (cliente_id)`,
  `CREATE TABLE app.lineas (pedido_id integer REFERENCES app.pedidos(id), n integer, nota text,
     PRIMARY KEY (pedido_id, n))`,
  `CREATE VIEW app.resumen AS
     SELECT c.nombre, count(p.id) AS pedidos
       FROM app.clientes c LEFT JOIN app.pedidos p ON p.cliente_id = c.id GROUP BY c.nombre`,
  `CREATE SEQUENCE app.folio START 100 INCREMENT 5`,
  `SELECT nextval('app.folio')`,
  `CREATE FUNCTION app.doble(x integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT x * 2'`,
  `CREATE FUNCTION app.toca() RETURNS trigger LANGUAGE plpgsql
     AS $$ BEGIN NEW.creado := now(); RETURN NEW; END $$`,
  `CREATE TRIGGER clientes_toca BEFORE UPDATE ON app.clientes
     FOR EACH ROW EXECUTE PROCEDURE app.toca()`,
  `INSERT INTO app.clientes (nombre, email, saldo, datos, tags)
     VALUES ('Ana', 'ana@x', 10.5, '{"a": 1}', '{x,y}'), ('Luis', 'luis@x', 0, NULL, NULL)`,
  `INSERT INTO app.pedidos (cliente_id, total, cantidad) VALUES (1, 20, 2), (1, 7.25, 1)`,
  `INSERT INTO app.lineas VALUES (1, 1, 'uno'), (1, 2, 'dos')`
]

describe.skipIf(!url)('PostgreSQL before 10 (integration, VORTAQ_TEST_PG_LEGACY_URL)', () => {
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let pg: PgDbHandlers
  let id: string
  let connection: PgDriverConnection
  let input: ConnectionInput
  let password: string
  const ref: SchemaRef = { database: SRC, schema: 'app' }

  const withDb = async <T>(database: string, fn: (s: PgSession) => Promise<T>): Promise<T> => {
    const s = await connection.acquire({ database, schema: null })
    try {
      return await fn(s)
    } finally {
      await s.release()
    }
  }
  const dropDatabase = async (name: string): Promise<void> => {
    await connection.closeDatabase(name)
    // No DROP DATABASE … WITH (FORCE) before 13: end the other sessions first.
    await withDb(connection.initialDatabase, async (s) => {
      await s.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [name]
      )
      await s.query(`DROP DATABASE IF EXISTS "${name}"`)
    })
  }

  beforeAll(async () => {
    const u = new URL(url!)
    password = decodeURIComponent(u.password)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-pg-old-'))
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
    input = baseInput({
      name: 'PG antiguo',
      engine: 'postgresql',
      host: u.hostname,
      port: Number(u.port || 5432),
      username: decodeURIComponent(u.username),
      ssl: { enabled: false, verifyServer: false, mode: 'disable' },
      backupDir: join(dir, 'backups'),
      postgres: {
        ...defaultPostgresOptions(),
        initialDatabase: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres'
      }
    })
    id = ctx.connections.save(input).id
    ctx.credentials.set('mysql', id, password)
    manager = new ConnectionManager(ctx)
    pg = createPgDbHandlers(ctx, manager)
    const c = await manager.connection(id)
    if (!isPgConnection(c)) throw new Error('not pg')
    connection = c
    for (const db of [SRC, DST]) await dropDatabase(db)
    await withDb(connection.initialDatabase, (s) => s.query(`CREATE DATABASE "${SRC}"`))
    await withDb(SRC, async (s) => {
      for (const sql of SEED) await s.query(sql)
    })
  }, 120_000)

  afterAll(async () => {
    if (ctx) await getConnectionManager(ctx).closeAll()
    if (connection) for (const db of [SRC, DST]) await dropDatabase(db).catch(() => undefined)
    await manager?.closeAll()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  it('tests and opens the connection; the info panel works without pg_stat_ssl', async () => {
    const test = await manager.test(input, password, null)
    expect(test).toMatchObject({ ok: true, details: ['sin cifrar'] })
    expect(test.serverVersion).toMatch(/^PostgreSQL 9\./)
    const info = await manager.open(id)
    expect(info.version).toMatch(/^9\./)
    expect(info.runtime?.versionNumber).toBeLessThan(100000)
    expect(info.details).toContainEqual({ label: 'Cifrado', value: 'sin cifrar' })
  })

  it('lists databases, schemas and every object group', async () => {
    expect((await pg.databases(id)).map((d) => d.name)).toContain(SRC)
    expect((await pg.schemas(id, SRC)).map((s) => s.name)).toEqual(['public', 'app'])
    expect((await pg.tables(id, ref)).map((t) => t.name)).toEqual(['clientes', 'lineas', 'pedidos'])
    expect(await pg.views(id, ref)).toMatchObject([{ name: 'resumen', updatable: false }])
    expect((await pg.routines(id, ref)).map((r) => [r.name, r.kind])).toEqual([
      ['doble', 'function'],
      ['toca', 'trigger function']
    ])
    expect((await pg.triggers(id, ref)).map((t) => [t.name, t.table, t.timing])).toEqual([
      ['clientes_toca', 'clientes', 'BEFORE']
    ])
    // Sequences before 10: bigint, the last value read from the sequence itself.
    const sequences = await pg.objects(id, ref, 'sequence')
    expect(sequences.find((s) => s.name === 'folio')).toMatchObject({
      kind: 'bigint',
      detail: '100'
    })
    expect(sequences.find((s) => s.name === 'clientes_id_seq')).toMatchObject({
      table: 'clientes.id',
      detail: '2'
    })
    expect(await pg.objects(id, ref, 'materialized_view')).toEqual([])
    expect((await pg.objects(id, ref, 'type')).map((t) => [t.name, t.kind])).toEqual([
      ['mood', 'enum'],
      ['posint', 'domain']
    ])
    expect((await pg.dataTypes(id, SRC)).find((t) => t.name === 'app.mood')).toMatchObject({
      enumValues: ['sad', 'ok', 'happy']
    })
  })

  it('reads the structure and rebuilds DDL the old server accepts', async () => {
    const clientes = await pg.tableStructure(id, ref, 'clientes')
    expect(clientes.columns.map((c) => [c.name, c.extra])).toContainEqual(['id', 'serial'])
    expect(clientes.columns.find((c) => c.name === 'humor')?.enumValues).toEqual([
      'sad',
      'ok',
      'happy'
    ])
    expect(clientes.columns.find((c) => c.name === 'nombre')?.comment).toBe('Nombre visible')
    expect(clientes.columns.every((c) => c.identity === null && c.generated === null)).toBe(true)
    expect(clientes.indexes.find((i) => i.primary)).toMatchObject({
      columns: ['id'],
      constraint: 'clientes_pkey'
    })
    // CREATE SEQUENCE IF NOT EXISTS is 9.5: not in the DDL of a 9.x table.
    expect(clientes.createSql).toContain('CREATE SEQUENCE app.clientes_id_seq;')
    const lineas = await pg.tableStructure(id, ref, 'lineas')
    expect(lineas.indexes.find((i) => i.primary)?.columns).toEqual(['pedido_id', 'n'])
    expect(lineas.foreignKeys).toMatchObject([
      { columns: ['pedido_id'], referencedTable: 'pedidos', referencedColumns: ['id'] }
    ])
    const pedidos = await pg.tableStructure(id, ref, 'pedidos')
    expect(pedidos.constraints?.map((c) => c.type).sort()).toEqual(['check', 'primary'])
    // CREATE SEQUENCE … AS type is PostgreSQL 10.
    const folio = await pg.showCreate(id, ref, 'sequence', 'folio')
    expect(folio).toContain('INCREMENT BY 5')
    expect(folio).toContain('START WITH 100')
    expect(folio).not.toMatch(/\n {2}AS /)
    expect(await pg.showCreate(id, ref, 'view', 'resumen')).toMatch(/^CREATE OR REPLACE VIEW/)
    expect(
      await pg.showCreate(id, ref, 'function', {
        type: 'function',
        name: 'doble',
        signature: 'x integer'
      })
    ).toContain('x * 2')
    // The rebuilt DDL runs on the old server itself.
    await withDb(SRC, async (s) => {
      await s.query('CREATE SCHEMA ddl_copy')
      try {
        await s.query(
          clientes.createSql
            .replace(/\bapp\.(clientes|clientes_id_seq)\b/g, 'ddl_copy.$1')
            .replace(/ddl_copy\.clientes_id_seq'::regclass/, "ddl_copy.clientes_id_seq'::regclass")
        )
      } finally {
        await s.query('DROP SCHEMA ddl_copy CASCADE')
      }
    })
  })

  it('pages, filters and edits table data; SELECT results are editable', async () => {
    const page = await pg.tableData(id, {
      schema: ref,
      table: 'clientes',
      limit: 10,
      offset: 0,
      orderBy: { column: 'id', direction: 'ASC' },
      filter: {
        kind: 'group',
        enabled: true,
        connector: 'AND',
        children: [
          {
            kind: 'condition',
            enabled: true,
            column: 'nombre',
            operator: 'contains',
            values: ['an'],
            connector: 'AND'
          }
        ]
      }
    })
    expect(page.primaryKey).toEqual(['id'])
    expect(page.rows.map((r) => r[1])).toEqual(['Ana'])
    expect(page.total).toBe(1)
    const res = await pg.applyRowChanges(id, ref, 'clientes', [
      { kind: 'insert', values: { nombre: 'Eva', humor: 'happy', tags: '{a}', datos: '{"b": 2}' } }
    ])
    expect(res.applied).toBe(1)
    const newId = res.insertIds![0]
    await pg.applyRowChanges(id, ref, 'clientes', [
      { kind: 'update', key: { id: newId }, values: { saldo: '5.25' } }
    ])
    const [select] = ok(
      await pg.execute(id, `SELECT id, nombre, saldo FROM clientes WHERE id = ${newId}`, {
        schema: ref
      })
    )
    expect(select.resultSet?.rows).toEqual([[newId, 'Eva', '5.25']])
    expect(select.resultSet?.columns.map((c) => c.table)).toEqual([
      'clientes',
      'clientes',
      'clientes'
    ])
    await pg.applyRowChanges(id, ref, 'clientes', [{ kind: 'delete', key: { id: newId } }])
    // A query tab's own transaction.
    ok(
      await pg.execute(id, 'BEGIN; UPDATE clientes SET saldo = 1', {
        schema: ref,
        sessionKey: 'query:old'
      })
    )
    expect(await pg.sessionState(id, 'query:old')).toMatchObject({
      open: true,
      transactionStatus: 'in'
    })
    await pg.rollback(id, 'query:old')
    await pg.closeSession(id, 'query:old')
  })

  it('shows the estimated and the actual execution plan', async () => {
    const sql =
      'SELECT c.nombre, p.total FROM app.clientes c JOIN app.pedidos p ON p.cliente_id = c.id'
    const estimated = await executionPlan(manager, id, { sql, schema: ref, actual: false })
    expect(estimated).toMatchObject({ engine: 'postgresql', actual: false })
    const actual = await executionPlan(manager, id, { sql, schema: ref, actual: true })
    expect(actual.actual).toBe(true)
    expect(actual.root.actualRows).toBe(2)
  })

  it('gives the AI assistant the structure through the catalog-only reader', async () => {
    await withDb(SRC, async (session) => {
      const snap = await readPgSchemaSnapshot(new PgMetadataQueryable(session), 'app')
      expect(snap.tables.map((t) => t.name)).toEqual(['clientes', 'lineas', 'pedidos', 'resumen'])
      const lineas = snap.tables.find((t) => t.name === 'lineas')!
      expect(lineas.indexes.find((i) => i.name === 'lineas_pkey')?.columns).toEqual([
        'pedido_id',
        'n'
      ])
      expect(lineas.foreignKeys).toMatchObject([{ columns: ['pedido_id'], refColumns: ['id'] }])
      expect(snap.routines.map((r) => r.name)).toEqual(['doble', 'toca'])
      expect(await explainPgSelect(session, 'SELECT * FROM app.clientes')).toContain('Seq Scan')
    })
  })

  it('backs up to .vqb and restores into a new database: same rows, sequences and functions', async () => {
    const service = createBackupService(ctx, getSessionFactory(ctx), { scrypt: CHEAP })
    const backup = await service.create({
      connectionId: id,
      schema: SRC,
      includeData: true,
      format: 'vqb'
    })
    expect(backup.rows).toBe(6)
    const restored = await service.restore({
      backupPath: backup.path,
      connectionId: id,
      targetSchema: DST,
      createSchema: true,
      dropObjectsFirst: false,
      includeStructure: true,
      includeData: true,
      continueOnError: false
    })
    expect(restored.errors).toEqual([])
    expect(restored.rowsInserted).toBe(6)
    const read = (db: string) =>
      withDb(db, (s) =>
        s.query<Record<string, unknown>>(
          `SELECT (SELECT string_agg(nombre || ':' || saldo || ':' || humor, ',' ORDER BY id) FROM app.clientes) AS clientes,
                  (SELECT last_value FROM app.folio)::text AS folio,
                  (SELECT last_value FROM app.clientes_id_seq)::text AS seq,
                  (SELECT count(*) FROM app.lineas)::int AS lineas,
                  app.doble(21) AS doble`
        )
      )
    expect(await read(DST)).toEqual(await read(SRC))
  }, 120_000)

  describe.skipIf(!newUrl)('a backup of a newer server (VORTAQ_TEST_PG_URL)', () => {
    const NEW_SRC = `vortaq_new_src_${process.pid}`
    const OLD_DST = `vortaq_from_new_${process.pid}`
    let newId: string
    let newer: PgDriverConnection

    const withNew = async <T>(database: string, fn: (s: PgSession) => Promise<T>): Promise<T> => {
      const s = await newer.acquire({ database, schema: null })
      try {
        return await fn(s)
      } finally {
        await s.release()
      }
    }

    beforeAll(async () => {
      const u = new URL(newUrl!)
      newId = ctx.connections.save({
        ...input,
        name: 'PG nuevo',
        host: u.hostname,
        port: Number(u.port || 5432),
        username: decodeURIComponent(u.username),
        postgres: {
          ...input.postgres!,
          initialDatabase: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres'
        }
      }).id
      ctx.credentials.set('mysql', newId, decodeURIComponent(u.password))
      const c = await manager.connection(newId)
      if (!isPgConnection(c)) throw new Error('not pg')
      newer = c
      await dropDatabase(OLD_DST)
      await withNew(newer.initialDatabase, async (s) => {
        await s.query(`DROP DATABASE IF EXISTS "${NEW_SRC}" WITH (FORCE)`)
        await s.query(`CREATE DATABASE "${NEW_SRC}"`)
      })
      // Since PostgreSQL 10 every sequence has a type (serial ones are integer)
      // and since 11 triggers print EXECUTE FUNCTION: neither exists on 9.2.
      await withNew(NEW_SRC, async (s) => {
        for (const sql of SEED) await s.query(sql)
        await s.query('CREATE SEQUENCE app.corto AS smallint INCREMENT 2')
        await s.query("SELECT nextval('app.corto')")
        await s.query('ALTER TABLE app.pedidos ADD COLUMN nota text')
        await s.query(`CREATE FUNCTION app.toca_pedido() RETURNS trigger LANGUAGE plpgsql
          AS $$ BEGIN NEW.nota := TG_ARGV[0]; RETURN NEW; END $$`)
        await s.query(`CREATE TRIGGER pedidos_toca BEFORE UPDATE ON app.pedidos
          FOR EACH ROW WHEN (OLD.total IS DISTINCT FROM NEW.total) EXECUTE FUNCTION app.toca_pedido('EXECUTE FUNCTION')`)
      })
    }, 120_000)

    afterAll(async () => {
      if (newer) {
        await newer.closeDatabase(NEW_SRC)
        await withNew(newer.initialDatabase, (s) =>
          s.query(`DROP DATABASE IF EXISTS "${NEW_SRC}" WITH (FORCE)`)
        ).catch(() => undefined)
      }
      if (connection) await dropDatabase(OLD_DST).catch(() => undefined)
    }, 60_000)

    it('restores into the old server: typed sequences and EXECUTE FUNCTION triggers', async () => {
      const service = createBackupService(ctx, getSessionFactory(ctx), { scrypt: CHEAP })
      const backup = await service.create({
        connectionId: newId,
        schema: NEW_SRC,
        includeData: true,
        format: 'vqb'
      })
      const restored = await service.restore({
        backupPath: backup.path,
        connectionId: id,
        targetSchema: OLD_DST,
        createSchema: true,
        dropObjectsFirst: false,
        includeStructure: true,
        includeData: true,
        continueOnError: false
      })
      expect(restored.errors).toEqual([])
      expect(restored.rowsInserted).toBe(6)
      const read = (s: PgSession) =>
        s.query<Record<string, unknown>>(
          `SELECT (SELECT string_agg(nombre || ':' || saldo || ':' || humor, ',' ORDER BY id) FROM app.clientes) AS clientes,
                  (SELECT last_value FROM app.folio)::text AS folio,
                  (SELECT last_value FROM app.clientes_id_seq)::text AS seq,
                  (SELECT last_value FROM app.corto)::text AS corto,
                  (SELECT count(*) FROM app.lineas)::int AS lineas,
                  app.doble(21) AS doble`
        )
      expect(await withDb(OLD_DST, read)).toEqual(await withNew(NEW_SRC, read))
      // The type's range stays: MINVALUE/MAXVALUE are written out in the backup.
      const after = await withDb(OLD_DST, async (s) => {
        await s.query(`UPDATE app.pedidos SET total = total + 1 WHERE id = 1`)
        return s.query<Record<string, unknown>>(
          `SELECT (SELECT max_value FROM app.corto)::text AS corto_max,
                  (SELECT max_value FROM app.clientes_id_seq)::text AS serial_max,
                  (SELECT nota FROM app.pedidos WHERE id = 1) AS nota,
                  (SELECT pg_catalog.pg_get_serial_sequence('app.clientes', 'id')) AS owned`
        )
      })
      expect(after).toEqual([
        {
          corto_max: '32767',
          serial_max: '2147483647',
          nota: 'EXECUTE FUNCTION',
          owned: 'app.clientes_id_seq'
        }
      ])
    }, 120_000)
  })

  describe('agents (MCP)', () => {
    let h: McpHarness
    beforeAll(async () => {
      h = await startMcpHarness([
        {
          input: {
            ...input,
            name: 'Antiguo',
            postgres: { ...input.postgres!, initialDatabase: SRC },
            mcp: { enabled: true, access: 'read' }
          },
          password
        }
      ])
    }, 60_000)
    afterAll(async () => h?.close())

    it('lists, describes, reads and explains', async () => {
      const tables = (await h.ok('list_tables', { connection: 'Antiguo', schema: 'app' })).tables
      expect(tables.map((t: { name: string }) => t.name)).toEqual([
        'clientes',
        'lineas',
        'pedidos',
        'resumen'
      ])
      const pedidos = await h.ok('describe_table', {
        connection: 'Antiguo',
        schema: 'app',
        table: 'pedidos'
      })
      expect(pedidos.foreign_keys).toMatchObject([{ columns: ['cliente_id'] }])
      const rows = await h.ok('run_query', {
        connection: 'Antiguo',
        sql: 'SELECT nombre FROM app.clientes ORDER BY id'
      })
      expect(rows.rows).toEqual([['Ana'], ['Luis']])
      await h.ok('explain_query', { connection: 'Antiguo', sql: 'SELECT * FROM app.pedidos' })
    })
  })
})
