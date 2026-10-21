/**
 * PostgreSQL 17 (P2a/P2b) through the real IPC handler layer (dbPostgres.ts)
 * and the generic ConnectionManager. Server: docker compose service
 * `postgres17` on 127.0.0.1:55432 (VORTAQ_TEST_PG_URL). The SSH-tunnel test
 * also needs VORTAQ_TEST_SSH_URL (compose service `sshd` on 52222).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionInput, QueryStatementResult, SchemaRef } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { AppContext } from '@main/context'
import { envVar } from '@main/env'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager } from '@main/db/manager'
import { createPgDbHandlers, type PgDbHandlers } from '@main/ipc/dbPostgres'
import { isPgConnection } from '@main/postgres/connection'
import { PgMetadataQueryable, explainPgSelect, readPgSchemaSnapshot } from '@main/ai/pgMetadata'
import { AiService } from '@main/ai/service'
import { pgTablePlanner } from '../../src/renderer/src/components/designer/pg/planner'
import {
  decideEditability,
  firstEditable,
  resultSource
} from '../../src/renderer/src/components/query/resultEditability'
import { POSTGRES_TARGET, describeServer } from './targets'

const SCHEMA = `vortaq_pg_${process.pid}`
const OTHER = `${SCHEMA}_other`

function connectionInput(u: URL, overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: 'PG IT',
    color: null,
    environment: 'local',
    host: u.hostname,
    port: Number(u.port || 5432),
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
    ssl: { enabled: false, verifyServer: false, mode: 'disable' },
    backupDir: '',
    extraBackupDirs: [],
    engine: 'postgresql',
    postgres: {
      initialDatabase: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
      showSystemSchemas: false,
      timeZone: '',
      searchPath: ''
    },
    ...overrides
  }
}

const ok = (results: QueryStatementResult[]): QueryStatementResult[] => {
  const failed = results.find((r) => r.error)
  if (failed) throw new Error(`${failed.sql}: ${failed.error}`)
  return results
}

describeServer(POSTGRES_TARGET, 'PostgreSQL driver (integration)', (url) => {
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let pg: PgDbHandlers
  let id: string
  let prodId: string
  let db: string
  let ref: SchemaRef

  const exec = (sql: string, options: Parameters<PgDbHandlers['execute']>[2] = {}) =>
    pg.execute(id, sql, { schema: ref, ...options })

  beforeAll(async () => {
    const u = new URL(url)
    db = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres'
    ref = { database: db, schema: SCHEMA }
    dir = mkdtempSync(join(tmpdir(), 'vortaq-pg-it-'))
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
    id = ctx.connections.save(connectionInput(u)).id
    ctx.credentials.set('mysql', id, decodeURIComponent(u.password))
    prodId = ctx.connections.save(
      connectionInput(u, { name: 'PG IT prod', environment: 'production' })
    ).id
    ctx.credentials.set('mysql', prodId, decodeURIComponent(u.password))
    manager = new ConnectionManager(ctx)
    pg = createPgDbHandlers(ctx, manager)
    ok(
      await pg.execute(
        id,
        `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; DROP SCHEMA IF EXISTS ${OTHER} CASCADE`,
        {
          schema: { database: db, schema: '' }
        }
      )
    )
    ok(
      await pg.execute(
        id,
        `
        CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA public;
        CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public;
        CREATE SCHEMA ${SCHEMA};
        CREATE SCHEMA ${OTHER};
        CREATE TYPE ${SCHEMA}.mood AS ENUM ('sad', 'ok', 'happy');
        CREATE DOMAIN ${SCHEMA}.posint AS integer CHECK (VALUE > 0);
        CREATE TABLE ${SCHEMA}.items (
          id serial PRIMARY KEY,
          name text NOT NULL,
          price numeric(10,2),
          big bigint,
          tags text[],
          meta jsonb,
          doc json,
          feeling ${SCHEMA}.mood DEFAULT 'ok',
          qty ${SCHEMA}.posint,
          born date,
          created timestamptz DEFAULT now(),
          dur interval,
          data bytea,
          active boolean DEFAULT true,
          note varchar(40) DEFAULT 'x'
        );
        COMMENT ON TABLE ${SCHEMA}.items IS 'Integration items';
        CREATE INDEX items_name_idx ON ${SCHEMA}.items (lower(name));
        CREATE TABLE ${SCHEMA}.ident (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text);
        CREATE TABLE ${SCHEMA}."Mixed Case" ("Id" int PRIMARY KEY, "Label" text);
        CREATE TABLE ${SCHEMA}.nokey (a int, b text);
        CREATE VIEW ${SCHEMA}.v_items AS SELECT id, name FROM ${SCHEMA}.items;
        CREATE MATERIALIZED VIEW ${SCHEMA}.mv_counts AS SELECT feeling, count(*) AS n FROM ${SCHEMA}.items GROUP BY feeling;
        CREATE SEQUENCE ${SCHEMA}.tickets START 100;
        CREATE FUNCTION ${SCHEMA}.add(a int, b int) RETURNS int LANGUAGE sql AS $$ SELECT a + b $$;
        CREATE FUNCTION ${SCHEMA}.add(a text, b text) RETURNS text LANGUAGE sql AS $$ SELECT a || b; $$;
        CREATE FUNCTION ${SCHEMA}.write_nokey() RETURNS int LANGUAGE sql AS $$ INSERT INTO ${SCHEMA}.nokey VALUES (99, 'w') RETURNING a $$;
        CREATE PROCEDURE ${SCHEMA}.bump() LANGUAGE plpgsql AS $$ BEGIN RAISE NOTICE 'bumped'; END $$;
        CREATE FUNCTION ${SCHEMA}.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.name := trim(NEW.name); RETURN NEW; END $$;
        CREATE TRIGGER items_touch BEFORE INSERT ON ${SCHEMA}.items FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.touch();
        INSERT INTO ${SCHEMA}.items (name, price, big, tags, meta, doc, feeling, qty, born, created, dur, data, active)
          VALUES ('  alpha ', 1.50, 9007199254740993, '{a,"b c"}', '{"k": [1, 2]}', '{"z":  1}', 'happy', 3,
                  '1980-01-02', '2026-10-06 01:10:30.326955+00', '1 day 02:03:04', '\\x0102ff', false),
                 ('beta', NULL, NULL, NULL, NULL, NULL, 'sad', NULL, NULL, '2026-10-06 00:00:00+00', NULL, NULL, true);
        INSERT INTO ${SCHEMA}.nokey VALUES (1, 'one');
        CREATE TABLE ${OTHER}.items (id int PRIMARY KEY);
        `,
        { schema: { database: db, schema: '' } }
      )
    )
  }, 120_000)

  afterAll(async () => {
    try {
      await pg.execute(
        id,
        `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; DROP SCHEMA IF EXISTS ${OTHER} CASCADE`,
        { schema: { database: db, schema: '' } }
      )
    } catch {
      /* best effort */
    }
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('tests and opens the connection (version, TLS state, runtime)', async () => {
    const u = new URL(url)
    const test = await manager.test(connectionInput(u), decodeURIComponent(u.password), null)
    expect(test.ok).toBe(true)
    expect(test.serverVersion).toMatch(/^PostgreSQL 17\./)
    expect(test.details).toContain('sin cifrar')
    const bad = await manager.test(connectionInput(u), 'wrong-password', null)
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/28P01/)
    const info = await manager.open(id)
    expect(info.engine).toBe('postgresql')
    expect(info.runtime).toMatchObject({ flavor: 'postgresql', returning: 'all' })
    expect(info.runtime!.versionNumber).toBeGreaterThanOrEqual(170000)
  })

  it('never signs in with PGPASSWORD or another ambient credential', async () => {
    const u = new URL(url)
    const saved = process.env.PGPASSWORD
    process.env.PGPASSWORD = decodeURIComponent(u.password)
    try {
      const noPassword = ctx.connections.save(connectionInput(u, { name: 'PG sin clave' })).id
      await expect(manager.open(noPassword)).rejects.toThrow(
        'No hay contraseña guardada para la conexión PG sin clave'
      )
      expect(manager.isOpen(noPassword)).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.PGPASSWORD
      else process.env.PGPASSWORD = saved
    }
  })

  it('lists databases, schemas and every object group', async () => {
    const dbs = (await pg.databases(id)).map((d) => d.name)
    expect(dbs).toContain(db)
    expect(dbs).not.toContain('template0')
    const schemas = (await pg.schemas(id, db)).map((s) => s.name)
    expect(schemas).toEqual(expect.arrayContaining(['public', SCHEMA, OTHER]))
    expect(schemas).not.toContain('pg_catalog')
    expect((await pg.tables(id, ref)).map((t) => t.name)).toEqual([
      'Mixed Case',
      'ident',
      'items',
      'nokey'
    ])
    expect((await pg.views(id, ref)).map((v) => v.name)).toEqual(['v_items'])
    expect((await pg.objects(id, ref, 'materialized_view')).map((o) => o.name)).toEqual([
      'mv_counts'
    ])
    const routines = await pg.routines(id, ref)
    expect(routines.map((r) => [r.name, r.signature, r.type, r.kind])).toEqual([
      ['add', 'a integer, b integer', 'FUNCTION', 'function'],
      ['add', 'a text, b text', 'FUNCTION', 'function'],
      ['bump', '', 'PROCEDURE', 'procedure'],
      ['touch', '', 'FUNCTION', 'trigger function'],
      ['write_nokey', '', 'FUNCTION', 'function']
    ])
    const sequences = await pg.objects(id, ref, 'sequence')
    expect(sequences.map((s) => s.name)).toEqual(['ident_id_seq', 'items_id_seq', 'tickets'])
    expect(sequences.find((s) => s.name === 'ident_id_seq')?.table).toBe('ident.id')
    expect(sequences.find((s) => s.name === 'items_id_seq')?.table).toBe('items.id')
    const types = await pg.objects(id, ref, 'type')
    expect(types.map((t) => [t.name, t.kind])).toEqual([
      ['mood', 'enum'],
      ['posint', 'domain']
    ])
    expect(types[0].detail).toBe('sad, ok, happy')
    expect((await pg.triggers(id, ref)).map((t) => [t.name, t.table, t.timing])).toEqual([
      ['items_touch', 'items', 'BEFORE']
    ])
    expect((await pg.extensions(id, db)).map((e) => e.name)).toEqual(
      expect.arrayContaining(['uuid-ossp', 'pgcrypto'])
    )
  })

  it('nests partitions under their partitioned table (sub-partitions and other schemas too)', async () => {
    ok(
      await exec(`
        CREATE TABLE ${SCHEMA}.events (id int, at date, region text) PARTITION BY RANGE (at);
        CREATE TABLE ${SCHEMA}.events_2025 PARTITION OF ${SCHEMA}.events
          FOR VALUES FROM ('2025-01-01') TO ('2026-01-01') PARTITION BY LIST (region);
        CREATE TABLE ${SCHEMA}.events_2025_eu PARTITION OF ${SCHEMA}.events_2025 FOR VALUES IN ('eu');
        CREATE TABLE ${OTHER}.events_2026 PARTITION OF ${SCHEMA}.events
          FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
        CREATE TABLE ${SCHEMA}.events_rest PARTITION OF ${SCHEMA}.events DEFAULT;
      `)
    )
    try {
      const tables = await pg.tables(id, ref)
      // Partitions are not tables of the list; the parent carries them.
      expect(tables.map((t) => t.name)).not.toContain('events_2025')
      const events = tables.find((t) => t.name === 'events')!
      expect(events.engine).toBe('particionada')
      expect(events.partitions).toEqual([
        {
          name: 'events_2025',
          schema: SCHEMA,
          bound: "FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')",
          partitions: [{ name: 'events_2025_eu', schema: SCHEMA, bound: "FOR VALUES IN ('eu')" }]
        },
        {
          name: 'events_2026',
          schema: OTHER,
          bound: "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')"
        },
        { name: 'events_rest', schema: SCHEMA, bound: 'DEFAULT' }
      ])
      expect(tables.find((t) => t.name === 'items')?.partitions).toBeUndefined()
    } finally {
      ok(await exec(`DROP TABLE ${SCHEMA}.events CASCADE`))
    }
  })

  it('closes a database pool from the tree, never the initial one or a tab in a transaction', async () => {
    const extra = `vortaq_close_${process.pid}`
    const admin = { schema: { database: db, schema: '' } }
    ok(await pg.execute(id, `DROP DATABASE IF EXISTS ${extra}`, admin))
    ok(await pg.execute(id, `CREATE DATABASE ${extra}`, admin))
    const connection = await manager.connection(id)
    if (!isPgConnection(connection)) throw new Error('not a PostgreSQL connection')
    try {
      await pg.schemas(id, extra)
      expect(connection.openDatabases()).toContain(extra)
      await expect(pg.closeDatabase(id, db)).rejects.toThrow(/base de datos inicial/)
      // An open transaction in a tab of that database keeps it open.
      const tab = 'query:close-db'
      ok(
        await pg.execute(id, 'BEGIN; SELECT 1', {
          schema: { database: extra, schema: 'public' },
          sessionKey: tab
        })
      )
      await expect(pg.closeDatabase(id, extra)).rejects.toThrow(/transacción abierta/)
      await pg.rollback(id, tab)
      await pg.closeDatabase(id, extra)
      expect(connection.openDatabases()).not.toContain(extra)
      expect(connection.openDatabases()).toContain(db)
      // The next use opens it again.
      expect((await pg.schemas(id, extra)).map((s) => s.name)).toContain('public')
      await pg.closeDatabase(id, extra)
    } finally {
      // Fast: no backend is left waiting in authentication (connectOrClose).
      ok(await pg.execute(id, `DROP DATABASE IF EXISTS ${extra}`, admin))
    }
  })

  it('refuses a plain string SchemaRef (wrong-database safety)', async () => {
    await expect(pg.tables(id, SCHEMA)).rejects.toThrow(
      'Falta la base de datos: actualiza la vista'
    )
  })

  it('describes columns with neutral metadata', async () => {
    const cols = await pg.columns(id, ref, 'items')
    const by = Object.fromEntries(cols.map((c) => [c.name, c]))
    expect(by.id).toMatchObject({
      primaryKey: true,
      autoIncrement: true,
      typeKind: 'integer',
      hasDefault: true
    })
    expect(by.id.defaultValue).toMatch(/^nextval\(/)
    expect(by.tags).toMatchObject({ typeKind: 'array', columnType: 'text[]' })
    expect(by.meta).toMatchObject({ typeKind: 'json', dataType: 'jsonb' })
    expect(by.feeling).toMatchObject({ typeKind: 'enum', enumValues: ['sad', 'ok', 'happy'] })
    expect(by.qty.typeKind).toBe('integer') // domain resolved to its base type
    expect(by.price).toMatchObject({ typeKind: 'decimal', columnType: 'numeric(10,2)' })
    expect(by.created.typeKind).toBe('datetime')
    expect(by.data.typeKind).toBe('binary')
    const ident = await pg.columns(id, ref, 'ident')
    expect(ident[0]).toMatchObject({ identity: 'always', autoIncrement: true })
  })

  it('rebuilds table DDL from the catalog and shows every object DDL', async () => {
    const structure = await pg.tableStructure(id, ref, 'items')
    expect(structure).toMatchObject({ kind: 'table', database: db, comment: 'Integration items' })
    expect(structure.createSql).toContain(`CREATE TABLE ${SCHEMA}.items (`)
    expect(structure.createSql).toContain('CONSTRAINT items_pkey PRIMARY KEY (id)')
    expect(structure.createSql).toContain('CREATE INDEX items_name_idx')
    expect(structure.createSql).toContain(
      `COMMENT ON TABLE ${SCHEMA}.items IS 'Integration items';`
    )
    expect(structure.createSql).toContain('CREATE TRIGGER items_touch')
    expect(structure.createSql).toContain(`OWNED BY ${SCHEMA}.items.id`)
    expect(structure.indexes.find((i) => i.primary)?.constraint).toBe('items_pkey')
    expect(await pg.showCreate(id, ref, 'view', 'v_items')).toMatch(/^CREATE OR REPLACE VIEW/)
    expect(await pg.showCreate(id, ref, 'materialized_view', 'mv_counts')).toMatch(
      /^CREATE MATERIALIZED VIEW/
    )
    expect(
      await pg.showCreate(id, ref, 'function', {
        type: 'function',
        name: 'add',
        signature: 'a text, b text'
      })
    ).toContain('a || b')
    await expect(pg.showCreate(id, ref, 'function', 'add')).rejects.toThrow(/sobrecargas/)
    expect(await pg.showCreate(id, ref, 'sequence', 'tickets')).toContain('START WITH 100')
    expect(await pg.showCreate(id, ref, 'type', 'mood')).toBe(
      `CREATE TYPE ${SCHEMA}.mood AS ENUM ('sad', 'ok', 'happy');`
    )
    expect(await pg.showCreate(id, ref, 'type', 'posint')).toContain('CHECK')
  })

  it('keeps every value as the server text (no TZ shift, exact numbers, raw json)', async () => {
    const [r] = ok(
      await exec(
        'SELECT id, name, price, big, tags, meta, doc, feeling, qty, born, created, dur, data, active FROM items ORDER BY id LIMIT 1'
      )
    )
    expect(r.resultSet!.rows[0]).toEqual([
      1,
      'alpha',
      '1.50',
      '9007199254740993',
      '{a,"b c"}',
      '{"k": [1, 2]}',
      '{"z":  1}',
      'happy',
      3,
      '1980-01-02',
      '2026-10-06 01:10:30.326955+00',
      '1 day 02:03:04',
      '0x0102FF',
      false
    ])
  })

  it('runs multi-statement scripts with $$ bodies, notices and error positions', async () => {
    const results = await exec(`
      CREATE FUNCTION tmp_semicolons() RETURNS text LANGUAGE plpgsql AS $$
      BEGIN RAISE NOTICE 'hola; desde %', 'plpgsql'; RETURN 'a;b'; END $$;
      SELECT tmp_semicolons() AS v;
      DROP FUNCTION tmp_semicolons();
      SELECT nosuchcolumn FROM items;
      SELECT 'never';
    `)
    expect(results).toHaveLength(4)
    expect(results[1].resultSet!.rows).toEqual([['a;b']])
    expect(results[1].notices).toEqual(['NOTICE: hola; desde plpgsql'])
    expect(results[3].error).toMatch(/42703/)
    expect(results[3].errorPosition).toBe(7)
  })

  it('keeps BEGIN, SET and temp tables across runs of one tab (tab session)', async () => {
    const tab = 'query:tab-a'
    const r1 = ok(
      await exec(
        "BEGIN; INSERT INTO items (name) VALUES ('in-tx'); CREATE TEMP TABLE scratch (x int); SET statement_timeout = '5s'",
        { sessionKey: tab }
      )
    )
    expect(r1.at(-1)!.transactionStatus).toBe('in')
    expect(await pg.sessionState(id, tab)).toMatchObject({ open: true, transactionStatus: 'in' })
    // Another tab does not see the uncommitted row.
    const other = ok(
      await exec("SELECT count(*)::int FROM items WHERE name = 'in-tx'", {
        sessionKey: 'query:tab-b'
      })
    )
    expect(other[0].resultSet!.rows).toEqual([[0]])
    const r2 = ok(
      await exec(
        "SELECT count(*)::int, current_setting('statement_timeout') FROM scratch, (SELECT 1) s",
        {
          sessionKey: tab
        }
      )
    )
    expect(r2[0].resultSet!.rows).toEqual([[0, '5s']])
    const state = await pg.commit(id, tab)
    expect(state.transactionStatus).toBe('idle')
    const after = ok(
      await exec("SELECT count(*)::int FROM items WHERE name = 'in-tx'", {
        sessionKey: 'query:tab-b'
      })
    )
    expect(after[0].resultSet!.rows).toEqual([[1]])
    await pg.closeSession(id, tab)
    await pg.closeSession(id, 'query:tab-b')
    expect(await pg.sessionState(id, tab)).toMatchObject({ open: false })
  })

  it('reports a failed transaction and rolls it back from the toolbar', async () => {
    const tab = 'query:tab-fail'
    const results = await exec('BEGIN; SELECT 1/0; SELECT 1', {
      sessionKey: tab,
      stopOnError: false
    })
    expect(results[1].error).toMatch(/22012/)
    expect(results[2].error).toMatch(/Transacción abortada: ejecuta ROLLBACK.*25P02/)
    expect(results.at(-1)!.transactionStatus).toBe('failed')
    expect((await pg.rollback(id, tab)).transactionStatus).toBe('idle')
    await pg.closeSession(id, tab)
  })

  it('keeps public extensions visible with the tab on another schema (search_path rule)', async () => {
    const tab = 'query:tab-path'
    const [r] = ok(
      await exec('SELECT uuid_generate_v4() IS NOT NULL, current_schema()', { sessionKey: tab })
    )
    expect(r.resultSet!.rows).toEqual([[true, SCHEMA]])
    expect(r.effectiveSchema).toBe(SCHEMA)
    // SET search_path in SQL is reflected back for the toolbar combo.
    const [s] = ok(await exec(`SET search_path TO ${OTHER}, public`, { sessionKey: tab }))
    expect(s.effectiveSchema).toBe(OTHER)
    await pg.closeSession(id, tab)
  })

  it('re-applies the tab schema after a rollback and refuses a database change mid-transaction', async () => {
    const tab = 'query:tab-rb'
    ok(await exec('BEGIN', { sessionKey: tab, schema: { database: db, schema: OTHER } }))
    await pg.rollback(id, tab)
    // The search_path set inside the rolled-back transaction is gone: the next run re-applies it.
    const [r] = ok(
      await exec('SELECT current_schema()', {
        sessionKey: tab,
        schema: { database: db, schema: OTHER }
      })
    )
    expect(r.resultSet!.rows).toEqual([[OTHER]])
    ok(await exec('BEGIN', { sessionKey: tab }))
    await expect(
      pg.execute(id, 'SELECT 1', { sessionKey: tab, schema: { database: 'postgres', schema: '' } })
    ).rejects.toThrow(/transacción abierta/)
    await pg.rollback(id, tab)
    await pg.closeSession(id, tab)
  })

  it('cancels a running statement without touching the next one', async () => {
    const tab = 'query:tab-cancel'
    const started = Date.now()
    const running = exec('SELECT pg_sleep(20); SELECT 1', {
      sessionKey: tab,
      executionId: 'exec-1'
    })
    await new Promise((r) => setTimeout(r, 400))
    expect(await pg.cancel(id, 'exec-1')).toBe(true)
    const results = await running
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(results).toHaveLength(1)
    expect(results[0].error).toMatch(/57014/)
    // A late cancel finds nothing running and returns false.
    expect(await pg.cancel(id, 'exec-1')).toBe(false)
    const [next] = ok(await exec('SELECT 2', { sessionKey: tab, executionId: 'exec-2' }))
    expect(next.resultSet!.rows).toEqual([[2]])
    await pg.closeSession(id, tab)
  })

  it('makes single-table results editable and keeps views read-only', async () => {
    const decide = async (sql: string) => {
      const [r] = ok(await exec(sql))
      const set = r.resultSet!
      const source = resultSource(set.columns, r.sql, 'postgresql')
      if (!source.ok) return { editable: false, reason: source.reason }
      // Like EditableResult: the first candidate table the rows can be edited in.
      const chosen = await firstEditable(source.candidates, async (candidate) => {
        const structure = await pg
          .tableStructure(id, { database: db, schema: candidate.schema }, candidate.table)
          .catch(() => null)
        return {
          decision: decideEditability(set.columns, candidate, structure, set.rows, {
            aliasMetadata: false
          })
        }
      })
      return chosen!.decision
    }
    expect(
      await decide('SELECT i.id AS ident, i.name FROM items AS i WHERE i.id > 0')
    ).toMatchObject({
      editable: true,
      schema: SCHEMA,
      table: 'items',
      primaryKey: ['id'],
      keyColumns: ['ident']
    })
    expect(await decide('SELECT "Id", "Label" FROM "Mixed Case"')).toMatchObject({
      editable: true,
      table: 'Mixed Case',
      primaryKey: ['Id']
    })
    expect(await decide('SELECT * FROM v_items')).toMatchObject({
      editable: false,
      reason: 'el origen es una vista'
    })
    expect(await decide('SELECT count(*) FROM items')).toMatchObject({ editable: false })
  })

  it('edits one table of a join by the place of its columns in the select list', async () => {
    const decide = async (sql: string) => {
      const [r] = ok(await exec(sql))
      const set = r.resultSet!
      const source = resultSource(set.columns, r.sql, 'postgresql')
      if (!source.ok) return { editable: false as const, reason: source.reason }
      const chosen = await firstEditable(source.candidates, async (candidate) => {
        const structure = await pg
          .tableStructure(id, { database: db, schema: candidate.schema }, candidate.table)
          .catch(() => null)
        return {
          decision: decideEditability(set.columns, candidate, structure, set.rows, {
            aliasMetadata: false
          })
        }
      })
      return chosen!.decision
    }
    // Without alias metadata both sides of a self-join name items: the select list tells them apart.
    expect(
      await decide('SELECT a.id, a.name, b.name AS same FROM items a JOIN items b ON b.id = a.id')
    ).toMatchObject({
      editable: true,
      schema: SCHEMA,
      table: 'items',
      locked: [null, null, 'columna de otra tabla (b)']
    })
    const withView = await decide(
      'SELECT i.*, v.name AS via_view FROM items i JOIN v_items v ON v.id = i.id'
    )
    expect(withView).toMatchObject({ editable: true, table: 'items' })
    if (withView.editable) {
      expect(withView.locked.slice(0, -1).every((l) => l === null)).toBe(true)
      expect(withView.locked.at(-1)).toMatch(/^columna de otra tabla/)
    }
    expect(
      await decide('SELECT n.b, i.id, i.name FROM nokey n, items i WHERE i.id = n.a')
    ).toMatchObject({
      editable: true,
      table: 'items',
      locked: ['columna de otra tabla (nokey)', null, null]
    })
    expect(await decide('SELECT * FROM items a JOIN ident b ON b.id = a.id')).toEqual({
      editable: false,
      reason: 'la consulta usa varias tablas: escribe a.* o a.columna para editar'
    })
    expect(
      await decide('SELECT a.* FROM items a JOIN items b ON b.id <> a.id JOIN items c ON true')
    ).toMatchObject({ editable: false, reason: 'hay filas repetidas con la misma clave' })
  })

  it('pages table data with dialect-aware filters', async () => {
    const page = await pg.tableData(id, {
      schema: ref,
      table: 'items',
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
            column: 'name',
            operator: 'contains',
            values: ['ALP'],
            connector: 'AND'
          },
          {
            kind: 'condition',
            enabled: true,
            column: 'active',
            operator: 'eq',
            values: ['no'],
            connector: 'AND'
          },
          {
            kind: 'condition',
            enabled: true,
            column: 'meta',
            operator: 'eq',
            values: ['{"k":[1,2]}'],
            connector: 'AND'
          },
          {
            kind: 'condition',
            enabled: true,
            column: 'tags',
            operator: 'eq',
            values: ['{a,"b c"}'],
            connector: 'AND'
          },
          {
            kind: 'condition',
            enabled: true,
            column: 'feeling',
            operator: 'in',
            values: ['happy', 'ok'],
            connector: 'AND'
          }
        ]
      }
    })
    expect(page.rows.map((r) => r[1])).toEqual(['alpha'])
    expect(page.primaryKey).toEqual(['id'])
    expect(page.total).toBe(1)
    const where = await pg.tableFilterSql(id, ref, 'items', {
      kind: 'group',
      enabled: true,
      connector: 'AND',
      children: [
        {
          kind: 'condition',
          enabled: true,
          column: 'name',
          operator: 'contains',
          values: ["o'k"],
          connector: 'AND'
        }
      ]
    })
    expect(where).toContain('ILIKE')
    expect(where).toContain("'%o''k%'")
  })

  it('applies row changes: serial omitted, RETURNING id, enum/json/array edits, identity refused', async () => {
    const res = await pg.applyRowChanges(id, ref, 'items', [
      {
        kind: 'insert',
        values: { name: 'gamma', feeling: 'sad', tags: '{x,y}', meta: '{"b": 2, "a": 1}' }
      }
    ])
    expect(res.applied).toBe(1)
    const newId = res.insertIds![0]
    expect(typeof newId).toBe('number')
    await pg.applyRowChanges(id, ref, 'items', [
      {
        kind: 'update',
        key: { id: newId },
        values: { feeling: 'happy', tags: '{"p q",r}', meta: '[1, {"z": true}]', active: false }
      }
    ])
    const [r] = ok(
      await exec(`SELECT feeling, tags, meta, active, note FROM items WHERE id = ${newId}`)
    )
    expect(r.resultSet!.rows[0]).toEqual(['happy', '{"p q",r}', '[1, {"z": true}]', false, 'x'])
    await expect(
      pg.applyRowChanges(id, ref, 'items', [
        { kind: 'update', key: { id: newId }, values: { feeling: 'angry' } }
      ])
    ).rejects.toThrow(/22P02/)
    await pg.applyRowChanges(id, ref, 'items', [{ kind: 'delete', key: { id: newId } }])
    await expect(
      pg.applyRowChanges(id, ref, 'ident', [{ kind: 'insert', values: { id: 5, label: 'x' } }])
    ).rejects.toThrow(/GENERATED ALWAYS AS IDENTITY/)
    const identRes = await pg.applyRowChanges(id, ref, 'ident', [
      { kind: 'insert', values: { label: 'auto' } }
    ])
    expect(identRes.insertIds![0]).toBe(1)
    await expect(
      pg.applyRowChanges(id, ref, 'nokey', [{ kind: 'delete', key: { a: 1, b: 'one' } }])
    ).rejects.toThrow(/no tiene clave primaria/)
  })

  it('alters a table from the designer plan in one transaction, enum value first', async () => {
    const original = await pg.tableStructure(id, ref, 'items')
    const draft = pgTablePlanner.draftFromStructure(original)
    draft.enumAdditions = { [`${SCHEMA}.mood`]: ['ecstatic'] }
    draft.columns = draft.columns.map((c) =>
      c.name === 'feeling'
        ? { ...c, defaultValue: `'ecstatic'::${SCHEMA}.mood` }
        : c.name === 'note'
          ? { ...c, columnType: 'varchar(80)' }
          : c
    )
    const plan = pgTablePlanner.buildAlter(original, draft)
    expect(plan.problems).toEqual([])
    expect(plan.preStatements?.[0]).toMatch(/ALTER TYPE .*mood ADD VALUE IF NOT EXISTS 'ecstatic'/)
    for (const sql of plan.preStatements ?? []) ok(await exec(sql))
    ok(
      await exec(
        ['BEGIN', ...plan.statements.map((s) => s.replace(/;$/, '')), 'COMMIT'].join(';\n')
      )
    )
    const after = await pg.tableStructure(id, ref, 'items')
    expect(after.columns.find((c) => c.name === 'feeling')?.defaultValue).toBe(
      `'ecstatic'::${SCHEMA}.mood`
    )
    expect(after.columns.find((c) => c.name === 'note')?.columnType).toBe('character varying(80)')
    expect(
      pgTablePlanner.buildAlter(after, pgTablePlanner.draftFromStructure(after)).statements
    ).toEqual([])
  })

  it('AI «Toda la conexión» on PostgreSQL: every user schema of the database, no values', async () => {
    const ai = new AiService({
      userDataPath: dir,
      credentials: ctx.credentials,
      settings: ctx.settings,
      environmentOf: () => 'local',
      acquire: () => Promise.reject(new Error('no MySQL sessions')),
      isPostgres: () => true,
      acquirePg: async (connectionId, database) => {
        const connection = await manager.connection(connectionId)
        if (!isPgConnection(connection)) throw new Error('not a PostgreSQL connection')
        return connection.acquire(database ? { database, schema: null } : null)
      },
      emit: () => undefined,
      log: { info: () => undefined, warn: () => undefined }
    })
    const whole = await ai.buildContext({
      connectionId: id,
      schema: SCHEMA,
      database: db,
      scope: 'connection'
    })
    expect(whole.context).toContain(
      `Base de datos ${db} completa (todos sus esquemas; PostgreSQL no consulta las demás bases de datos de la conexión)`
    )
    expect(whole.context).toContain(`Esquema seleccionado: ${SCHEMA}.`)
    expect(whole.context).toContain(`${SCHEMA}.items`)
    expect(whole.context).toContain(`${OTHER}.items`)
    expect(whole.context).not.toMatch(/\bpg_catalog\.|information_schema\./)
    // Structure only: no row value reaches the context.
    for (const value of ['alpha', 'beta', '9007199254740993'])
      expect(whole.context).not.toContain(value)
    const single = await ai.buildContext({ connectionId: id, schema: SCHEMA, database: db })
    expect(single.context).toContain(`Otros esquemas de la base de datos ${db}`)
    expect(single.context).not.toContain(`${OTHER}.items`)
    // Without a database in the request, the initial one is named.
    const initial = await ai.buildContext({ connectionId: id, schema: null })
    expect(initial.context).toContain(`Base de datos ${db} completa`)
  })

  it('gives the AI assistant structure only (pg_catalog reader, plan-only EXPLAIN)', async () => {
    const connection = await manager.connection(id)
    if (!isPgConnection(connection)) throw new Error('not a PostgreSQL connection')
    const session = await connection.acquire({ database: db, schema: null })
    try {
      const q = new PgMetadataQueryable(session)
      const snap = await readPgSchemaSnapshot(q, SCHEMA)
      expect(snap.serverVersion).toMatch(/PostgreSQL 17/)
      const items = snap.tables.find((t) => t.name === 'items')!
      expect(items.columns.find((c) => c.name === 'id')).toMatchObject({
        key: 'PRI',
        type: 'integer'
      })
      expect(items.indexes.map((i) => i.name)).toContain('items_name_idx')
      // json_agg columns arrive as JSON text: index and key columns must still be read.
      expect(items.indexes.find((i) => i.name === 'items_pkey')?.columns).toEqual(['id'])
      expect(items.indexes.find((i) => i.name === 'items_name_idx')?.columns).toEqual([
        'lower(name)'
      ])
      expect(snap.tables.find((t) => t.name === 'v_items')?.kind).toBe('view')
      expect(snap.routines.map((r) => r.name)).toEqual([
        'add',
        'add',
        'bump',
        'touch',
        'write_nokey'
      ])
      // Never a row value: the reader refuses user tables outright.
      await expect(q.query(`SELECT * FROM ${SCHEMA}.items`)).rejects.toThrow(/estructura/)
      const plan = await explainPgSelect(session, `SELECT * FROM ${SCHEMA}.items WHERE id = 1`)
      expect(plan).toMatch(/Scan/)
      expect(await explainPgSelect(session, `SELECT nextval('${SCHEMA}.tickets')`)).toBeNull()
    } finally {
      await session.release()
    }
  })

  describe('production guard', () => {
    const prodExec = (sql: string, options: Parameters<PgDbHandlers['execute']>[2] = {}) =>
      pg.execute(prodId, sql, { schema: ref, ...options })

    it('rejects an unconfirmed obvious write in main', async () => {
      await expect(prodExec("INSERT INTO nokey VALUES (9, 'x')")).rejects.toThrow(
        /confirmación explícita/
      )
    })

    it('runs production sessions read-only: hidden side effects fail, confirmed writes pass', async () => {
      // A write hidden in a user function is not on any list: the read-only session stops it.
      const [r] = await prodExec(`SELECT write_nokey()`)
      expect(r.error).toMatch(/25006/)
      const [w] = ok(await prodExec(`SELECT write_nokey()`, { confirmProduction: true }))
      expect(w.resultSet!.rows).toEqual([[99]])
      // The lift is per script: the next unconfirmed run is read-only again.
      const [again] = await prodExec(`SELECT write_nokey()`)
      expect(again.error).toMatch(/25006/)
      // Known side-effect functions never even reach the server unconfirmed.
      await expect(prodExec(`SELECT nextval('${SCHEMA}.tickets')`)).rejects.toThrow(
        /confirmación explícita/
      )
    })

    it('refuses unconfirmed statements that would lift read-only, also on a tab session', async () => {
      for (const sql of [
        'SET default_transaction_read_only = off',
        'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
        'BEGIN READ WRITE',
        'RESET ALL',
        "SELECT set_config('default_transaction_read_only', 'off', false)"
      ])
        await expect(prodExec(sql, { sessionKey: 'query:prod-lift' })).rejects.toThrow(
          /confirmación explícita/
        )
      const [w] = await prodExec("INSERT INTO nokey VALUES (5, 'x')", {
        sessionKey: 'query:prod-lift',
        confirmProduction: true
      })
      expect(w.error).toBeNull()
      // Back to read-only right after the confirmed script.
      const [r] = await prodExec('SELECT write_nokey()', { sessionKey: 'query:prod-lift' })
      expect(r.error).toMatch(/25006/)
      await pg.closeSession(prodId, 'query:prod-lift')
    })

    it('never commits the user transaction on a guard read, and explains read-only transactions', async () => {
      const tab = 'query:prod-tab'
      ok(await prodExec('BEGIN; SELECT 1', { sessionKey: tab }))
      const [w] = await prodExec("INSERT INTO nokey VALUES (7, 'x')", {
        sessionKey: tab,
        confirmProduction: true
      })
      expect(w.error).toBe(
        'La transacción se abrió en modo solo lectura: ejecuta ROLLBACK y repite el script con la escritura (25006)'
      )
      await pg.rollback(prodId, tab)
      const results = ok(
        await prodExec("BEGIN; INSERT INTO nokey VALUES (8, 'y')", {
          sessionKey: tab,
          confirmProduction: true
        })
      )
      expect(results.at(-1)!.transactionStatus).toBe('in')
      // A read on the same tab keeps the transaction open (nothing committed behind the user's back).
      const [read] = ok(
        await prodExec('SELECT count(*)::int FROM nokey WHERE a = 8', { sessionKey: tab })
      )
      expect(read.transactionStatus).toBe('in')
      const [outside] = ok(await prodExec('SELECT count(*)::int FROM nokey WHERE a = 8'))
      expect(outside.resultSet!.rows).toEqual([[0]])
      await expect(pg.commit(prodId, tab)).rejects.toThrow(/confirmación explícita/)
      expect((await pg.commit(prodId, tab, { confirmProduction: true })).transactionStatus).toBe(
        'idle'
      )
      const [committed] = ok(await prodExec('SELECT count(*)::int FROM nokey WHERE a = 8'))
      expect(committed.resultSet!.rows).toEqual([[1]])
      await pg.closeSession(prodId, tab)
    })

    it('needs confirmation for grid saves and drops', async () => {
      await expect(
        pg.applyRowChanges(prodId, ref, 'ident', [{ kind: 'insert', values: { label: 'p' } }])
      ).rejects.toThrow(/confirmación explícita/)
      const res = await pg.applyRowChanges(
        prodId,
        ref,
        'ident',
        [{ kind: 'insert', values: { label: 'p' } }],
        {
          confirmProduction: true
        }
      )
      expect(res.applied).toBe(1)
      await expect(pg.dropObject(prodId, ref, 'table', 'nokey')).rejects.toThrow(
        /confirmación explícita/
      )
    })
  })

  const sshUrl = envVar('TEST_SSH_URL')?.trim()
  it.skipIf(!sshUrl)(
    'connects through an SSH tunnel to the container network',
    async () => {
      const u = new URL(url)
      const s = new URL(sshUrl!)
      const input = connectionInput(u, {
        name: 'PG IT ssh',
        host: 'postgres17',
        port: 5432,
        ssh: {
          enabled: true,
          host: s.hostname,
          port: Number(s.port || 22),
          username: decodeURIComponent(s.username),
          authType: 'password',
          savePassword: true
        }
      })
      const result = await manager.test(
        input,
        decodeURIComponent(u.password),
        decodeURIComponent(s.password)
      )
      expect(result.ok, result.error).toBe(true)
      expect(result.details).toContain(`Túnel SSH: ${s.hostname}`)
      const sshId = ctx.connections.save(input).id
      ctx.credentials.set('mysql', sshId, decodeURIComponent(u.password))
      ctx.credentials.set('ssh', sshId, decodeURIComponent(s.password))
      const [r] = ok(
        await pg.execute(sshId, 'SELECT current_database()', {
          schema: { database: db, schema: '' }
        })
      )
      expect(r.resultSet!.rows).toEqual([[db]])
      await manager.close(sshId)
    },
    60_000
  )
})
