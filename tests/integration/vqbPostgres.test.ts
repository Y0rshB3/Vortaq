/**
 * PostgreSQL 17 .vqb backups end to end (docs/vqb-format.md): a seeded
 * database with schemas, an extension, enums/domains/composites, serial,
 * identity and standalone sequences, arrays, json/jsonb, partitions, views,
 * a materialized view, functions, a trigger and foreign keys is backed up,
 * restored into new databases (plain and encrypted) and replaced, and every
 * table's digest, sequence and object must match. Uses its own databases so
 * the whole-database backup never sees other suites' objects.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { getConnectionManager, getSessionFactory } from '@main/db/manager'
import { isPgConnection, type PgDriverConnection } from '@main/postgres/connection'
import type { PgSession } from '@main/postgres/session'
import { createBackupService, type BackupService } from '@main/backup/index'
import { BACKUP_CANCELLED } from '@main/backup/create'
import { VqbReader } from '@main/backup/vqb/reader'
import { POSTGRES_TARGET, describeServer } from './targets'

const SRC = `vqb_src_${process.pid}`
const DST = `vqb_dst_${process.pid}`
const DST_ENC = `vqb_enc_${process.pid}`
const DST_NEVER = `vqb_never_${process.pid}`
const BIG = `vqb_big_${process.pid}`
const ROWS = 3000
const CHEAP = { N: 1024, r: 8, p: 1 }

function connectionInput(u: URL, dir: string): ConnectionInput {
  return {
    name: 'PG VQB IT',
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
    backupDir: join(dir, 'backups'),
    extraBackupDirs: [],
    engine: 'postgresql',
    postgres: {
      initialDatabase: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
      showSystemSchemas: false,
      timeZone: '',
      searchPath: ''
    }
  }
}

const SEED = [
  `CREATE SCHEMA app`,
  `CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`,
  `CREATE TYPE app.mood AS ENUM ('sad', 'ok', 'happy')`,
  `CREATE DOMAIN app.posint AS integer CHECK (VALUE > 0)`,
  `CREATE TYPE app.pair AS (a integer, b text)`,
  `CREATE SEQUENCE app.ticket_seq INCREMENT BY 5 START WITH 100`,
  `SELECT nextval('app.ticket_seq'), nextval('app.ticket_seq')`,
  `CREATE TABLE app.customers (
     id serial PRIMARY KEY,
     name text NOT NULL,
     mood app.mood,
     tags text[],
     grid integer[][],
     prefs jsonb,
     doc json,
     bal numeric(30,6),
     big bigint,
     r real,
     d double precision,
     ts timestamptz,
     t timestamp(3),
     dt date,
     tm time,
     iv interval,
     b bytea,
     u uuid DEFAULT public.uuid_generate_v4(),
     ok boolean,
     cash money,
     pt point,
     rng int4range,
     pr app.pair,
     pos app.posint,
     twice integer GENERATED ALWAYS AS (id * 2) STORED,
     CONSTRAINT customers_name_ck CHECK (length(name) > 0)
   )`,
  `COMMENT ON TABLE app.customers IS 'Clientes ñ'`,
  `COMMENT ON COLUMN app.customers.name IS 'Nombre "visible"'`,
  `CREATE INDEX customers_name_idx ON app.customers (lower(name))`,
  `INSERT INTO app.customers (name, mood, tags, grid, prefs, doc, bal, big, r, d, ts, t, dt, tm, iv, b, ok, cash, pt, rng, pr, pos)
   SELECT 'cliente ' || n || ' ñandú 😀',
          (ARRAY['sad','ok','happy'])[1 + n % 3]::app.mood,
          CASE WHEN n % 5 = 0 THEN NULL ELSE ARRAY['a,b', 'c"d', NULL, 'x\\y ' || n] END,
          ARRAY[[n, n + 1], [n + 2, NULL]],
          jsonb_build_object('n', n, 'big', 12345678901234567890, 'arr', jsonb_build_array(1, 'two', null)),
          ('{"z": 1,  "a": [1.10, 2], "n": ' || n || '}')::json,
          n * 1.000001 + 0.000001,
          9223372036854775807 - n,
          (n / 7.0)::real,
          CASE WHEN n = 1 THEN 'NaN'::float8 WHEN n = 2 THEN 'Infinity'::float8 WHEN n = 3 THEN '-Infinity'::float8 ELSE n / 3.0 END,
          timestamptz '2026-03-29 01:30:00+01' + n * interval '17 minutes',
          timestamp '2026-10-07 10:00:00.123' + n * interval '1 second',
          date '2000-02-29' + n,
          time '23:59:59.999999' - n * interval '1 second',
          n * interval '1 day 2 hours 3.5 seconds',
          CASE WHEN n % 7 = 0 THEN NULL ELSE decode('00ff' || lpad(to_hex(n), 8, '0') || '1a0d0a27', 'hex') END,
          n % 2 = 0,
          (n * 1.25)::numeric::money,
          point(n, -n),
          int4range(n, n + 10),
          ROW(n, 'p' || n)::app.pair,
          n
   FROM generate_series(1, ${ROWS}) AS n`,
  `INSERT INTO app.customers (name) VALUES ('sin datos')`,
  `CREATE TABLE app.orders (
     id bigint GENERATED ALWAYS AS IDENTITY (START WITH 1000 INCREMENT BY 10) PRIMARY KEY,
     customer_id integer NOT NULL REFERENCES app.customers(id) ON DELETE CASCADE,
     total numeric(12,2) NOT NULL,
     note text
   )`,
  `CREATE INDEX orders_customer_idx ON app.orders (customer_id)`,
  `INSERT INTO app.orders (customer_id, total) SELECT 1 + n % 100, n * 2.5 FROM generate_series(1, 500) n`,
  `CREATE TABLE public.events (id integer NOT NULL, at date NOT NULL, payload text) PARTITION BY RANGE (at)`,
  `CREATE TABLE public.events_2025 PARTITION OF public.events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')`,
  `CREATE TABLE public.events_2026 PARTITION OF public.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`,
  `CREATE INDEX events_at_idx ON public.events (at)`,
  `INSERT INTO public.events SELECT n, date '2025-06-01' + n, 'e' || n FROM generate_series(1, 400) n`,
  `CREATE TABLE public.empty_one (k text PRIMARY KEY)`,
  `CREATE FUNCTION app.total_for(cid integer) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT COALESCE(sum(total), 0) FROM app.orders WHERE customer_id = cid $$`,
  `CREATE FUNCTION app.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.note := COALESCE(NEW.note, 'auto'); RETURN NEW; END $$`,
  `CREATE TRIGGER orders_touch BEFORE INSERT ON app.orders FOR EACH ROW EXECUTE FUNCTION app.touch()`,
  `CREATE PROCEDURE app.noop() LANGUAGE plpgsql AS $$ BEGIN END $$`,
  `CREATE VIEW app.v_happy AS SELECT id, name FROM app.customers WHERE mood = 'happy'`,
  `CREATE VIEW app.v_happy_count AS SELECT count(*) AS n FROM app.v_happy`,
  `CREATE MATERIALIZED VIEW app.mv_totals AS SELECT customer_id, sum(total) AS total FROM app.orders GROUP BY customer_id`,
  `CREATE UNIQUE INDEX mv_totals_customer ON app.mv_totals (customer_id)`
]

/** Row count and md5 of every row's text (order-independent). */
async function digest(s: PgSession, table: string): Promise<{ count: number; md5: string }> {
  const [row] = await s.query<{ count: string; md5: string | null }>(
    `SELECT count(*)::text AS count, md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS md5 FROM ONLY ${table} t`
  )
  return { count: Number(row.count), md5: String(row.md5) }
}

const TABLES = [
  'app.customers',
  'app.orders',
  'public.events_2025',
  'public.events_2026',
  'public.empty_one',
  'app.mv_totals'
]

describeServer(POSTGRES_TARGET, '.vqb backups of PostgreSQL (integration)', (url) => {
  let dir: string
  let ctx: AppContext
  let service: BackupService
  let id: string
  let connection: PgDriverConnection
  let plainPath: string
  let encryptedPath: string

  const session = async (database: string): Promise<PgSession> =>
    connection.acquire({ database, schema: null })
  const withDb = async <T>(database: string, fn: (s: PgSession) => Promise<T>): Promise<T> => {
    const s = await session(database)
    try {
      return await fn(s)
    } finally {
      await s.release()
    }
  }
  const dropDatabase = async (name: string): Promise<void> => {
    await connection.closeDatabase(name)
    await withDb(connection.initialDatabase, (s) =>
      s.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    )
  }

  beforeAll(async () => {
    const u = new URL(url)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-vqb-pg-'))
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
    id = ctx.connections.save(connectionInput(u, dir)).id
    ctx.credentials.set('mysql', id, decodeURIComponent(u.password))
    const c = await getConnectionManager(ctx).connection(id)
    if (!isPgConnection(c)) throw new Error('not pg')
    connection = c
    service = createBackupService(ctx, getSessionFactory(ctx), { scrypt: CHEAP })
    for (const db of [SRC, DST, DST_ENC, DST_NEVER, BIG]) await dropDatabase(db)
    await withDb(connection.initialDatabase, (s) => s.query(`CREATE DATABASE "${SRC}"`))
    await withDb(SRC, async (s) => {
      for (const sql of SEED) await s.query(sql)
    })
  }, 120_000)

  afterAll(async () => {
    try {
      for (const db of [SRC, DST, DST_ENC, DST_NEVER, BIG]) await dropDatabase(db)
    } catch {
      /* best effort */
    }
    await getConnectionManager(ctx).closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('backs up the whole database with every object type', async () => {
    const phases: string[] = []
    const result = await service.create(
      { connectionId: id, schema: SRC, includeData: true, format: 'vqb', label: 'it' },
      (e) => phases.push(e.phase)
    )
    plainPath = result.path
    expect(result.path.endsWith('-it.vqb')).toBe(true)
    expect(result.rows).toBe(ROWS + 1 + 500 + 400 + 0)
    expect(phases[0]).toBe('list')
    const reader = await VqbReader.open(result.path)
    try {
      const m = await reader.manifest()
      expect(m.engine.id).toBe('postgresql')
      expect(m.engine.serverVersion).toMatch(/^17/)
      expect(m.source).toMatchObject({
        database: SRC,
        schemas: ['app', 'public'],
        encoding: 'UTF8'
      })
      const types = m.objects.map((o) => `${o.type}:${o.schema}.${o.name}`)
      expect(types).toEqual(
        expect.arrayContaining([
          'extension:public.uuid-ossp',
          'type:app.mood',
          'type:app.posint',
          'type:app.pair',
          'sequence:app.ticket_seq',
          'sequence:app.customers_id_seq',
          'table:app.customers',
          'table:app.orders',
          'table:public.events',
          'table:public.events_2025',
          'function:app.total_for',
          'function:app.touch',
          'procedure:app.noop',
          'view:app.v_happy',
          'view:app.v_happy_count',
          'materialized_view:app.mv_totals'
        ])
      )
      // Extension members (uuid_generate_v4…) come back with CREATE EXTENSION, not one by one.
      expect(types.some((t) => t.includes('uuid_generate'))).toBe(false)
      // Partitioned parent before its partitions.
      expect(types.indexOf('table:public.events')).toBeLessThan(
        types.indexOf('table:public.events_2025')
      )
      const customers = m.objects.find((o) => o.name === 'customers')!
      const meta = await reader.objectMeta(customers.id)
      expect(meta.columns!.map((c) => c.name)).not.toContain('twice')
      expect(meta.indexes!.join()).toContain('customers_name_idx')
      expect(meta.comments!.join()).toContain('Clientes ñ')
      const orders = await reader.objectMeta(m.objects.find((o) => o.name === 'orders')!.id)
      expect(orders.foreignKeys!.join()).toContain('REFERENCES app.customers(id)')
      expect(orders.triggers!.join()).toContain('app.touch()')
      expect(orders.sequences![0]).toMatchObject({ kind: 'identity', isCalled: true })
      // Typed values: NaN/Infinity, big integers, bytes, arrays and json text survive.
      const firstRows: unknown[][] = []
      await reader.rows(meta, (r) => {
        if (firstRows.length < 3) firstRows.push(r)
      })
      const col = (name: string): number => meta.columns!.findIndex((c) => c.name === name)
      expect(firstRows[0][col('d')]).toEqual({ $float: 'NaN' })
      expect(firstRows[1][col('d')]).toEqual({ $float: 'Infinity' })
      expect(firstRows[0][col('big')]).toEqual({ $bigint: '9223372036854775806' })
      expect(firstRows[0][col('tags')]).toEqual({ $arr: ['a,b', 'c"d', null, 'x\\y 1'] })
      expect(firstRows[0][col('grid')]).toEqual({
        $arr: [
          ['1', '2'],
          ['3', null]
        ]
      })
      expect(firstRows[0][col('doc')]).toEqual({ $json: '{"z": 1,  "a": [1.10, 2], "n": 1}' })
      expect(firstRows[0][col('cash')]).toEqual({ $dec: '1.25' })
      expect(firstRows[0][col('ok')]).toBe(false)
    } finally {
      await reader.close()
    }
  }, 120_000)

  const compare = async (target: string): Promise<void> => {
    for (const table of TABLES) {
      const src = await withDb(SRC, (s) => digest(s, table))
      const dst = await withDb(target, (s) => digest(s, table))
      expect(dst, table).toEqual(src)
    }
    // Every sequence continues where the source would (read without advancing them).
    const seqState = (db: string): Promise<string[]> =>
      withDb(db, async (s) => {
        const out: string[] = []
        for (const name of ['app.ticket_seq', 'app.customers_id_seq', 'app.orders_id_seq']) {
          const [r] = await s.query<{ v: string; c: boolean }>(
            `SELECT last_value::text AS v, is_called AS c FROM ${name}`
          )
          out.push(`${name}=${r.v}/${r.c}`)
        }
        return out
      })
    expect(await seqState(target)).toEqual(await seqState(SRC))
    await withDb(target, async (s) => {
      const [fn] = await s.query<{ v: string }>(`SELECT app.total_for(1)::text AS v`)
      expect(Number(fn.v)).toBeGreaterThan(0)
      const [v] = await s.query<{ n: string }>(`SELECT n::text AS n FROM app.v_happy_count`)
      expect(Number(v.n)).toBe(1000)
      const enumLabels = await s.query<{ l: string }>(
        `SELECT enumlabel AS l FROM pg_enum WHERE enumtypid = 'app.mood'::regtype ORDER BY enumsortorder`
      )
      expect(enumLabels.map((e) => e.l)).toEqual(['sad', 'ok', 'happy'])
      const [comment] = await s.query<{ c: string }>(
        `SELECT obj_description('app.customers'::regclass, 'pg_class') AS c`
      )
      expect(comment.c).toBe('Clientes ñ')
      const fks = await s.query(
        `SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid = 'app.orders'::regclass`
      )
      expect(fks).toHaveLength(1)
      const triggers = await s.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'orders_touch'`)
      expect(triggers).toHaveLength(1)
      // The trigger works after the restore (it was created after the data).
      await s.query('BEGIN')
      const [ins] = await s.query<{ note: string }>(
        `INSERT INTO app.orders (customer_id, total) VALUES (1, 1) RETURNING note`
      )
      expect(ins.note).toBe('auto')
      await s.query('ROLLBACK')
      const idx = await s.query(
        `SELECT 1 FROM pg_indexes WHERE indexname IN ('customers_name_idx', 'orders_customer_idx', 'mv_totals_customer', 'events_at_idx')`
      )
      expect(idx).toHaveLength(4)
      const [ownership] = await s.query<{ owned: string | null }>(
        `SELECT pg_get_serial_sequence('app.customers', 'id') AS owned`
      )
      expect(ownership.owned).toBe('app.customers_id_seq')
      const [gen] = await s.query<{ twice: number; id: number }>(
        `SELECT id, twice FROM app.customers ORDER BY id LIMIT 1`
      )
      expect(gen.twice).toBe(gen.id * 2)
    })
  }

  it('restores into a new database with identical data, sequences and objects', async () => {
    const result = await service.restore({
      backupPath: plainPath,
      connectionId: id,
      targetSchema: DST,
      createSchema: true,
      dropObjectsFirst: false,
      includeStructure: true,
      includeData: true,
      continueOnError: false
    })
    expect(result.errors).toEqual([])
    expect(result.rowsInserted).toBe(ROWS + 1 + 500 + 400)
    await compare(DST)
  }, 120_000)

  it('encrypts, refuses a wrong password before creating anything, and restores with the right one', async () => {
    const result = await service.create({
      connectionId: id,
      schema: SRC,
      includeData: true,
      format: 'vqb',
      password: 'pg secreto 123'
    })
    encryptedPath = result.path
    const locked = await service.readMeta(result.path)
    expect(locked).toMatchObject({ locked: true, encrypted: true, objects: [] })
    const restore = (database: string, password?: string) =>
      service.restore({
        backupPath: encryptedPath,
        connectionId: id,
        targetSchema: database,
        createSchema: true,
        dropObjectsFirst: false,
        includeStructure: true,
        includeData: true,
        continueOnError: false,
        password
      })
    await expect(restore(DST_NEVER, 'otra contraseña')).rejects.toThrow('Contraseña incorrecta')
    await expect(restore(DST_NEVER)).rejects.toThrow('La copia está cifrada')
    const exists = await withDb(connection.initialDatabase, (s) =>
      s.query('SELECT 1 FROM pg_database WHERE datname = $1', [DST_NEVER])
    )
    expect(exists).toHaveLength(0)
    const ok = await restore(DST_ENC, 'pg secreto 123')
    expect(ok.errors).toEqual([])
    await compare(DST_ENC)
  }, 120_000)

  it('rolls everything back when an object fails and «continuar» is off', async () => {
    // DST already has every object: a second restore without dropping fails on the first CREATE.
    const before = await withDb(DST, (s) => digest(s, 'app.customers'))
    await expect(
      service.restore({
        backupPath: plainPath,
        connectionId: id,
        targetSchema: DST,
        createSchema: false,
        dropObjectsFirst: false,
        includeStructure: true,
        includeData: true,
        continueOnError: false
      })
    ).rejects.toThrow('No se ha restaurado nada')
    expect(await withDb(DST, (s) => digest(s, 'app.customers'))).toEqual(before)
  }, 120_000)

  it('replaces an existing database (safety copy in .vqb) and leaves it equal to the backup', async () => {
    await withDb(DST_ENC, async (s) => {
      await s.query(`CREATE SCHEMA extra`)
      await s.query(`CREATE TABLE extra.junk (x int)`)
      await s.query(`DELETE FROM app.orders WHERE id % 2 = 0`)
    })
    const result = await service.replace({
      backupPath: encryptedPath,
      expectedSchema: SRC,
      connectionId: id,
      targetSchema: DST_ENC,
      safetyBackup: true,
      continueOnError: false,
      password: 'pg secreto 123'
    })
    expect(result.existed).toBe(true)
    expect(result.safetyBackup?.path.endsWith('-previo-rollback.vqb')).toBe(true)
    expect(existsSync(result.safetyBackup!.path)).toBe(true)
    // The safety copy is encrypted with the same password.
    expect((await service.readMeta(result.safetyBackup!.path)).locked).toBe(true)
    await compare(DST_ENC)
    const extra = await withDb(DST_ENC, (s) =>
      s.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'extra'`)
    )
    expect(extra).toHaveLength(0)
  }, 180_000)

  it('cancels in the middle of a large table, not after it, and leaves no file', async () => {
    await withDb(connection.initialDatabase, (s) => s.query(`CREATE DATABASE "${BIG}"`))
    await withDb(BIG, (s) =>
      s.query(
        `CREATE TABLE public.big AS SELECT g AS id, repeat('x', 200) AS pad FROM generate_series(1, 300000) g`
      )
    )
    const controller = new AbortController()
    const events: { phase: string; rows: number | null }[] = []
    const started = performance.now()
    await expect(
      service.create(
        { connectionId: id, schema: BIG, includeData: true, format: 'vqb' },
        (e) => {
          events.push({ phase: e.phase, rows: e.detail?.rows ?? null })
          // «Cancelar» as soon as the first rows of the table are reported.
          if (e.phase === 'rows') controller.abort()
        },
        controller.signal
      )
    ).rejects.toThrow(BACKUP_CANCELLED)
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(events.some((e) => e.phase === 'objectDone')).toBe(false)
    expect(Math.max(...events.map((e) => e.rows ?? 0))).toBeLessThan(300000)
    const folder = join(dir, 'backups', BIG)
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([])
    // The session went back to the pool: the next copy of the same database works.
    const again = await service.create({
      connectionId: id,
      schema: BIG,
      includeData: false,
      format: 'vqb'
    })
    expect(again.objects).toBe(1)
  }, 120_000)

  it('refuses a .vqb of another engine and .nb3 formats for PostgreSQL', async () => {
    await expect(
      service.create({ connectionId: id, schema: SRC, includeData: true, format: 'nb3' })
    ).rejects.toThrow('solo se pueden hacer en formato .vqb')
  })
})
