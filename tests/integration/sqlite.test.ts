/**
 * SQLite (P3) through the real IPC handler layer (dbSqlite.ts) and the generic
 * ConnectionManager, on real database files in a temp folder (no server).
 * Workers run in-process (same handler as the utility process), except the
 * cancel test, which kills a real child process.
 */
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionInput, QueryStatementResult } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import { defaultSqliteOptions } from '@shared/engines'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager } from '@main/db/manager'
import { createSqliteDbHandlers, type SqliteDbHandlers } from '@main/ipc/dbSqlite'
import { createSqliteDriver, createSqliteFile } from '@main/sqlite/driver'
import { inProcessSpawner, type ProcessSpawner } from '@main/sqlite/spawner'
import { CANCELLED_MESSAGE, OTHER_TAB_TRANSACTION } from '@main/sqlite/errors'
import {
  decideEditability,
  firstEditable,
  resultSource
} from '../../src/renderer/src/components/query/resultEditability'
import { childProcessSpawner } from './sqliteWorkerProcess'

function input(filePath: string, overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: 'SQLite IT',
    color: null,
    environment: 'local',
    host: '',
    port: 0,
    username: '',
    authMode: 'none',
    savePassword: false,
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
    engine: 'sqlite',
    sqlite: { ...defaultSqliteOptions(false), filePath, foreignKeys: true },
    ...overrides
  }
}

const ok = (results: QueryStatementResult[]): QueryStatementResult[] => {
  const failed = results.find((r) => r.error)
  if (failed) throw new Error(`${failed.sql}: ${failed.error}`)
  return results
}

function makeContext(dir: string): AppContext {
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

describe('SQLite driver (integration, real files)', () => {
  let dir: string
  let files: string
  let ctx: AppContext
  let manager: ConnectionManager
  let lite: SqliteDbHandlers
  let spawner: ProcessSpawner
  let id: string
  let mainPath: string
  let auxPath: string

  const exec = (sql: string, tab = 'tab-1', extra = {}) =>
    lite.execute(id, sql, { sessionKey: tab, ...extra })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-sqlite-it-'))
    files = join(dir, 'files')
    rmSync(files, { recursive: true, force: true })
    ctx = makeContext(dir)
    spawner = inProcessSpawner()
    manager = new ConnectionManager(ctx, {
      drivers: async () => createSqliteDriver(() => spawner)
    })
    lite = createSqliteDbHandlers(ctx, manager)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(files)
    mainPath = join(files, 'app.db')
    auxPath = join(files, 'aux.db')
    await createSqliteFile(mainPath, spawner)
    await createSqliteFile(auxPath, spawner)
    id = ctx.connections.save(input(mainPath)).id
    ok(
      await exec(`
        CREATE TABLE author (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
        CREATE TABLE book (
          code TEXT PRIMARY KEY,
          title TEXT,
          author_id INTEGER REFERENCES author(id),
          price REAL CHECK (price >= 0),
          loose
        );
        CREATE TABLE tag (k TEXT, v TEXT, PRIMARY KEY (k, v)) WITHOUT ROWID;
        CREATE INDEX ix_book_title ON book(title);
        CREATE VIEW v_books AS SELECT b.code, b.title, a.name FROM book b JOIN author a ON a.id = b.author_id;
        CREATE TRIGGER trg_author_upper AFTER INSERT ON author BEGIN
          UPDATE author SET name = upper(name) WHERE id = NEW.id AND name <> upper(name);
          SELECT CASE WHEN NEW.name = '' THEN RAISE(ABORT, 'empty') END;
        END;
        INSERT INTO author (name) VALUES ('ana'), ('luis');
        INSERT INTO book VALUES ('b1', 'Uno', 1, 10.5, 1), ('b2', 'Dos', 2, 0, 'x');
      `)
    )
  })

  afterAll(async () => {
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates files only on request and never when opening or testing a missing path', async () => {
    const missing = join(files, 'typo.db')
    const ghostId = ctx.connections.save(input(missing, { name: 'Ghost' })).id
    await expect(manager.open(ghostId)).rejects.toThrow('Archivo no encontrado: typo.db')
    const test = await manager.test(input(missing), null, null)
    expect(test).toMatchObject({ ok: false })
    expect(test.error).toContain('Archivo no encontrado')
    expect(existsSync(missing)).toBe(false)
    await expect(createSqliteFile(mainPath, spawner)).rejects.toThrow('Ya existe')
    const report = await manager.test(input(mainPath), null, null)
    expect(report).toMatchObject({ ok: true })
    expect(report.serverVersion).toMatch(/^SQLite 3\.\d+/)
  })

  it('lists databases, tables, views, indexes and triggers from sqlite_schema and the pragmas', async () => {
    const info = await manager.open(id)
    expect(info).toMatchObject({ engine: 'sqlite', runtime: { flavor: 'sqlite' } })
    expect((await lite.databases(id)).map((d) => d.name)).toEqual(['main'])
    const tables = await lite.tables(id, 'main')
    expect(tables.map((t) => [t.name, t.engine, t.autoIncrement])).toEqual([
      ['author', null, 2],
      ['book', null, null],
      ['tag', 'WITHOUT ROWID', null]
    ])
    expect((await lite.views(id, 'main')).map((v) => v.name)).toEqual(['v_books'])
    expect(await lite.objects(id, 'main', 'index')).toEqual([
      expect.objectContaining({ name: 'ix_book_title', table: 'book', detail: 'title' })
    ])
    const triggers = await lite.triggers(id, 'main')
    expect(triggers).toEqual([
      expect.objectContaining({
        name: 'trg_author_upper',
        table: 'author',
        timing: 'AFTER',
        event: 'INSERT'
      })
    ])
    const ddl = await lite.showCreate(id, 'main', 'table', 'author')
    expect(ddl).toContain('CREATE TABLE author')
    expect(ddl).toContain('CREATE TRIGGER trg_author_upper')
  })

  it('reads columns and structure with neutral metadata (rowid alias, FKs, CHECKs)', async () => {
    const cols = await lite.columns(id, 'main', 'author')
    expect(cols[0]).toMatchObject({
      name: 'id',
      primaryKey: true,
      autoIncrement: true,
      nullable: false,
      typeKind: 'integer',
      extra: 'AUTOINCREMENT'
    })
    const book = await lite.tableStructure(id, 'main', 'book')
    expect(book.kind).toBe('table')
    expect(book.indexes.find((i) => i.primary)?.columns).toEqual(['code'])
    expect(book.indexes.find((i) => i.name === 'ix_book_title')?.definition).toContain(
      'CREATE INDEX'
    )
    expect(book.foreignKeys).toEqual([
      expect.objectContaining({
        columns: ['author_id'],
        referencedTable: 'author',
        referencedColumns: ['id']
      })
    ])
    expect(book.constraints).toEqual([
      expect.objectContaining({
        type: 'check',
        definition: 'CHECK (price >= 0)',
        columns: ['price']
      })
    ])
    expect(book.columns.find((c) => c.name === 'loose')).toMatchObject({
      columnType: '',
      typeKind: 'other'
    })
  })

  it('runs scripts with trigger bodies, keeps storage classes and reports changes', async () => {
    const out = ok(
      await exec(`
        CREATE TEMP TABLE scratch (x);
        CREATE TEMP TRIGGER t_scratch AFTER INSERT ON scratch BEGIN
          UPDATE scratch SET x = x || '!' WHERE rowid = NEW.rowid;
        END;
        INSERT INTO scratch VALUES ('a'), (2), (2.5), (x'01'), (NULL);
        SELECT x, typeof(x) FROM scratch ORDER BY rowid;
      `)
    )
    expect(out).toHaveLength(4)
    expect(out[2].affectedRows).toBe(5)
    const sel = out[3]
    expect(sel.resultSet?.rows.map((r) => r[0])).toEqual(['a!', '2!', '2.5!', '\u0001!', null])
    expect(sel.storage?.map((r) => r[0])).toEqual(['text', 'text', 'text', 'text', 'null'])
    const [typed] = ok(await exec("SELECT 1, 1.0, 't', x'00ff', 9007199254740993"))
    expect(typed.storage).toEqual([['integer', 'real', 'text', 'blob', 'integer']])
    expect(typed.resultSet?.rows).toEqual([[1, 1, 't', '0x00FF', '9007199254740993']])
    expect((await lite.databases(id)).map((d) => d.name)).toEqual(['main', 'temp'])
  })

  it('shares one transaction across tabs: others read it, cannot write, and see the owner state', async () => {
    ok(await exec("BEGIN; INSERT INTO author (name) VALUES ('tx')", 'tab-A'))
    expect(await lite.sessionState(id, 'tab-A')).toMatchObject({ transactionStatus: 'in' })
    expect(await lite.sessionState(id, 'tab-B')).toMatchObject({
      transactionStatus: 'idle',
      transactionElsewhere: true
    })
    const [read] = ok(await exec("SELECT count(*) FROM author WHERE name = 'TX'", 'tab-B'))
    expect(read.resultSet?.rows).toEqual([[1]])
    await expect(exec("INSERT INTO author (name) VALUES ('no')", 'tab-B')).rejects.toThrow(
      OTHER_TAB_TRANSACTION
    )
    await expect(
      lite.applyRowChanges(id, 'main', 'author', [{ kind: 'insert', values: { name: 'grid' } }])
    ).rejects.toThrow('hay una transacción abierta')
    await expect(lite.commit(id, 'tab-B')).rejects.toThrow('otra pestaña')
    expect(await lite.rollback(id, 'tab-A')).toMatchObject({ transactionStatus: 'idle' })
    const [after] = ok(await exec("SELECT count(*) FROM author WHERE name = 'TX'", 'tab-B'))
    expect(after.resultSet?.rows).toEqual([[0]])
  })

  it('makes single-table results editable by rowid (and refuses views and rowid-less results)', async () => {
    const [byPk] = ok(await exec('SELECT * FROM author'))
    const cols = byPk.resultSet!.columns
    expect(cols[0]).toMatchObject({ name: 'id', table: 'author', schema: 'main', primaryKey: true })
    const source = resultSource(cols, byPk.sql, 'sqlite')
    expect(source.ok).toBe(true)
    // A rowid table with a TEXT key: edited by rowid, which must be selected.
    const [noRowid] = ok(await exec('SELECT code, title FROM book'))
    expect(noRowid.resultSet!.columns[0].readOnlyReason).toContain('añade rowid')
    const [withRowid] = ok(await exec('SELECT rowid, code, title FROM book'))
    expect(withRowid.resultSet!.columns[0]).toMatchObject({
      name: 'rowid',
      sourceName: 'rowid',
      primaryKey: true,
      locked: 'rowid'
    })
    const rowidSource = resultSource(withRowid.resultSet!.columns, withRowid.sql, 'sqlite')
    expect(rowidSource.ok).toBe(true)
    const bookStructure = await lite.tableStructure(id, 'main', 'book')
    const editable = rowidSource.ok
      ? decideEditability(
          withRowid.resultSet!.columns,
          rowidSource.source,
          bookStructure,
          withRowid.resultSet!.rows,
          { aliasMetadata: false, keyFromColumns: true }
        )
      : null
    expect(editable).toMatchObject({ editable: true, primaryKey: ['rowid'], table: 'book' })
    // Views report the base table: the FROM target check refuses them.
    const [view] = ok(await exec('SELECT * FROM v_books'))
    const viewSource = resultSource(view.resultSet!.columns, view.sql, 'sqlite')
    const structure = await lite.tableStructure(id, 'main', 'book')
    expect(
      viewSource.ok
        ? decideEditability(
            view.resultSet!.columns,
            viewSource.source,
            structure,
            view.resultSet!.rows,
            { aliasMetadata: false }
          ).editable
        : false
    ).toBe(false)
  })

  it('edits one table of a join, even next to a view that reports the same table', async () => {
    const decide = async (sql: string) => {
      const [r] = ok(await exec(sql))
      const set = r.resultSet!
      const source = resultSource(set.columns, r.sql, 'sqlite')
      if (!source.ok) return { editable: false as const, reason: source.reason }
      // Like EditableResult: the first candidate table the rows can be edited in.
      const chosen = await firstEditable(source.candidates, async (candidate) => ({
        decision: decideEditability(
          set.columns,
          candidate,
          await lite.tableStructure(id, candidate.schema, candidate.table),
          set.rows,
          { aliasMetadata: false, keyFromColumns: true }
        )
      }))
      return chosen!.decision
    }
    expect(
      await decide(
        'SELECT b.rowid, b.*, a.name AS author FROM book b JOIN author a ON a.id = b.author_id'
      )
    ).toMatchObject({
      editable: true,
      table: 'book',
      primaryKey: ['rowid'],
      locked: [null, null, null, null, null, null, 'columna de otra tabla (author)']
    })
    // book needs its rowid, but none of its columns is edited here.
    expect(
      await decide('SELECT a.id, a.name, b.title FROM author a JOIN book b ON b.author_id = a.id')
    ).toMatchObject({
      editable: true,
      table: 'author',
      locked: [null, null, 'columna de otra tabla (book)']
    })
    // SQLite reports v_books.name as author.name: only the select list tells them apart.
    expect(
      await decide('SELECT a.id, v.name AS via FROM author a JOIN v_books v ON v.name = a.name')
    ).toMatchObject({
      editable: true,
      table: 'author',
      locked: [null, 'columna de otra tabla (v)']
    })
  })

  it('saves grid changes by rowid, keeping storage classes, in one transaction', async () => {
    const page = await lite.tableData(id, { schema: 'main', table: 'book', limit: 50, offset: 0 })
    expect(page.primaryKey).toEqual(['rowid'])
    expect(page.columns[0]).toMatchObject({ name: 'rowid', locked: 'rowid' })
    const b2 = page.rows.find((r) => r[1] === 'b2')!
    const result = await lite.applyRowChanges(id, 'main', 'book', [
      {
        kind: 'update',
        key: { rowid: b2[0] },
        values: { loose: '42', title: 'Dos bis' },
        storage: { loose: 'integer', title: 'text' }
      },
      {
        kind: 'insert',
        values: { code: 'b3', title: 'Tres', loose: '0x0A0B' },
        storage: { loose: 'blob' }
      }
    ])
    expect(result.applied).toBe(2)
    const [check] = ok(
      await exec("SELECT typeof(loose), title FROM book WHERE code IN ('b2', 'b3') ORDER BY code")
    )
    expect(check.resultSet?.rows).toEqual([
      ['integer', 'Dos bis'],
      ['blob', 'Tres']
    ])
    // A failing change rolls back the whole batch.
    await expect(
      lite.applyRowChanges(id, 'main', 'book', [
        { kind: 'update', key: { rowid: b2[0] }, values: { title: 'nunca' } },
        { kind: 'insert', values: { code: 'b1' } }
      ])
    ).rejects.toThrow('Falló el cambio 2 de 2')
    const [still] = ok(await exec("SELECT title FROM book WHERE code = 'b2'"))
    expect(still.resultSet?.rows).toEqual([['Dos bis']])
    // WITHOUT ROWID tables use their primary key.
    await lite.applyRowChanges(id, 'main', 'tag', [{ kind: 'insert', values: { k: 'a', v: '1' } }])
    const tags = await lite.tableData(id, { schema: 'main', table: 'tag', limit: 10, offset: 0 })
    expect(tags.primaryKey).toEqual(['k', 'v'])
  })

  it('fills NULL cells with an inferred class, inserts a typed rowid, needs the whole WITHOUT ROWID key', async () => {
    ok(
      await exec(
        "CREATE TABLE loose (a, b BLOB, c TEXT); INSERT INTO loose VALUES (NULL, NULL, 'x')"
      )
    )
    const page = await lite.tableData(id, { schema: 'main', table: 'loose', limit: 10, offset: 0 })
    expect(page.columns[0].name).toBe('rowid')
    const rowid = page.rows[0][0]
    await lite.applyRowChanges(id, 'main', 'loose', [
      {
        kind: 'update',
        key: { rowid },
        values: { a: '5', b: '0xAB' },
        storage: { a: 'null', b: 'null' }
      },
      { kind: 'insert', values: { rowid: '42', c: 'nuevo' } }
    ])
    const [check] = ok(
      await exec('SELECT rowid, typeof(a), typeof(b), c FROM loose ORDER BY rowid')
    )
    expect(check.resultSet?.rows).toEqual([
      [rowid, 'integer', 'blob', 'x'],
      [42, 'null', 'null', 'nuevo']
    ])
    const [partial] = ok(await exec('SELECT k FROM tag'))
    const src = resultSource(partial.resultSet!.columns, partial.sql, 'sqlite')
    const tagStructure = await lite.tableStructure(id, 'main', 'tag')
    expect(
      src.ok
        ? decideEditability(
            partial.resultSet!.columns,
            src.source,
            tagStructure,
            partial.resultSet!.rows,
            {
              aliasMetadata: false,
              keyFromColumns: true
            }
          ).editable
        : true
    ).toBe(false)
  })

  it('copies an attached database (not main) and copies under query_only', async () => {
    const attId = ctx.connections.save(
      input(mainPath, {
        name: 'Copy aux',
        environment: 'production',
        sqlite: {
          ...defaultSqliteOptions(true),
          filePath: mainPath,
          readOnly: false,
          attached: [{ alias: 'aux', filePath: auxPath }]
        }
      })
    ).id
    ok(
      await lite.execute(attId, 'CREATE TABLE IF NOT EXISTS aux.only_aux (x)', {
        sessionKey: 't',
        confirmProduction: true
      })
    )
    const connection = await manager.connection(attId)
    const target = join(files, 'aux-copy.db')
    await (
      connection as unknown as { vacuumInto(p: string, s: string): Promise<unknown> }
    ).vacuumInto(target, 'aux')
    const checkId = ctx.connections.save(input(target, { name: 'Check copy' })).id
    expect((await lite.tables(checkId, 'main')).map((t) => t.name)).toContain('only_aux')
    // Guarded connection (query_only on): the main copy works too.
    const mainCopy = join(files, 'main-copy-guarded.db')
    expect((await lite.copyFile(attId, mainCopy)).sizeBytes).toBeGreaterThan(0)
    await manager.close(attId)
    await manager.close(checkId)
  })

  it('filters with the SQLite WHERE builder and counts', async () => {
    const page = await lite.tableData(id, {
      schema: 'main',
      table: 'author',
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
            column: 'name',
            operator: 'contains',
            values: ['an'],
            connector: 'AND'
          }
        ]
      }
    })
    // LIKE ignores ASCII case: 'ANA' matches 'an'.
    expect(page.rows.map((r) => r[1])).toEqual(['ANA'])
    expect(page.total).toBe(1)
    expect(
      await lite.tableFilterSql(id, 'main', 'author', {
        kind: 'group',
        enabled: true,
        connector: 'AND',
        children: [
          {
            kind: 'condition',
            enabled: true,
            column: 'id',
            operator: 'eq',
            values: ['1'],
            connector: 'AND'
          }
        ]
      })
    ).toBe(`(id = '1')`)
  })

  it('checks foreign keys and integrity, copies the file with VACUUM INTO', async () => {
    expect(await lite.maintenance(id, 'integrityCheck')).toMatchObject({ ok: true, messages: [] })
    ok(
      await exec(
        "PRAGMA foreign_keys = OFF; INSERT INTO book (code, author_id) VALUES ('orphan', 99); PRAGMA foreign_keys = ON"
      )
    )
    const fk = await lite.maintenance(id, 'foreignKeyCheck')
    expect(fk.ok).toBe(false)
    expect(fk.messages).toEqual(['book: 1 fila(s) sin su fila en author'])
    ok(await exec("DELETE FROM book WHERE code = 'orphan'"))
    const copy = join(files, 'copy.db')
    const result = await lite.copyFile(id, copy)
    expect(result.sizeBytes).toBe(statSync(copy).size)
    await expect(lite.copyFile(id, copy)).rejects.toThrow('Ya existe')
  })

  it('attaches configured databases without creating them, and ATTACH from SQL refuses missing files', async () => {
    const attId = ctx.connections.save(
      input(mainPath, {
        name: 'With aux',
        sqlite: {
          ...defaultSqliteOptions(false),
          filePath: mainPath,
          attached: [{ alias: 'aux', filePath: auxPath }]
        }
      })
    ).id
    ok(await lite.execute(attId, 'CREATE TABLE aux.notes (n TEXT)', { sessionKey: 't' }))
    expect((await lite.databases(attId)).map((d) => d.name)).toEqual(['main', 'aux'])
    expect((await lite.tables(attId, 'aux')).map((t) => t.name)).toContain('notes')
    const [denied] = await lite.execute(attId, `ATTACH '${join(files, 'nope.db')}' AS x`, {
      sessionKey: 't'
    })
    expect(denied.error).toContain('ATTACH rechazado')
    expect(existsSync(join(files, 'nope.db'))).toBe(false)
    await manager.close(attId)
  })

  it('read-only connections refuse writes; an unwritable file opens read-only', async () => {
    const roId = ctx.connections.save(
      input(mainPath, {
        name: 'RO',
        sqlite: { ...defaultSqliteOptions(false), filePath: mainPath, readOnly: true }
      })
    ).id
    const [w] = await lite.execute(roId, "INSERT INTO author (name) VALUES ('ro')", {
      sessionKey: 't'
    })
    expect(w.error).toMatch(/readonly|solo lectura/i)
    await manager.close(roId)
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const locked = join(files, 'locked.db')
      await createSqliteFile(locked, spawner)
      chmodSync(locked, 0o444)
      const lockedId = ctx.connections.save(input(locked, { name: 'Locked' })).id
      const info = await manager.open(lockedId)
      expect(info.details?.find((d) => d.label === 'Modo')?.value).toContain('Solo lectura')
      await manager.close(lockedId)
      chmodSync(locked, 0o644)
    }
  })

  it('guarded (production) connections run with query_only until a write is confirmed', async () => {
    const prodId = ctx.connections.save(
      input(mainPath, {
        name: 'Prod',
        environment: 'production',
        sqlite: { ...defaultSqliteOptions(true), filePath: mainPath, readOnly: false }
      })
    ).id
    await expect(
      lite.execute(prodId, "INSERT INTO author (name) VALUES ('p')", { sessionKey: 't' })
    ).rejects.toThrow('necesita confirmación explícita')
    // ANALYZE is not on main's denylist (the renderer asks for it), but it writes
    // sqlite_stat1: query_only stops it anyway.
    const [sneaky] = await lite.execute(prodId, 'ANALYZE', { sessionKey: 't' })
    expect(sneaky.error).toMatch(/readonly|solo lectura/i)
    ok(
      await lite.execute(prodId, "INSERT INTO author (name) VALUES ('p')", {
        sessionKey: 't',
        confirmProduction: true
      })
    )
    const [qo] = ok(await lite.execute(prodId, 'PRAGMA query_only', { sessionKey: 't' }))
    expect(qo.resultSet?.rows).toEqual([[1]])
    ok(
      await lite.execute(prodId, "DELETE FROM author WHERE name = 'P'", {
        sessionKey: 't',
        confirmProduction: true
      })
    )
    await manager.close(prodId)
  })

  it('cancels a runaway CTE in a real worker process in under a second and reopens', async () => {
    const real = await childProcessSpawner()
    const ctx2 = makeContext(mkdtempSync(join(dir, 'ctx2-')))
    const manager2 = new ConnectionManager(ctx2, {
      drivers: async () => createSqliteDriver(() => real)
    })
    const lite2 = createSqliteDbHandlers(ctx2, manager2)
    const cid = ctx2.connections.save(
      input(mainPath, { name: 'Cancel', initialQueries: 'CREATE TEMP TABLE marker (x)' })
    ).id
    try {
      ok(await lite2.execute(cid, 'SELECT 1', { sessionKey: 'q' }))
      const started = performance.now()
      const running = lite2.execute(
        cid,
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
        { sessionKey: 'q', executionId: 'runaway' }
      )
      await new Promise((r) => setTimeout(r, 200))
      expect(await lite2.cancel(cid, 'runaway')).toBe(true)
      const [result] = await running
      const elapsed = performance.now() - started - 200
      expect(result.error).toBe(CANCELLED_MESSAGE)
      expect(elapsed).toBeLessThan(1000)
      expect(real.pids.length).toBe(2)
      const [after] = ok(
        await lite2.execute(cid, "SELECT count(*) FROM temp.sqlite_schema WHERE name = 'marker'", {
          sessionKey: 'q'
        })
      )
      expect(after.resultSet?.rows).toEqual([[1]])
    } finally {
      await manager2.closeAll()
    }
    expect(readdirSync(files)).not.toContain('nope.db')
  })
})
