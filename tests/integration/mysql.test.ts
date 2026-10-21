import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { AppContext } from '@main/context'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
import { ConnectionManager } from '@main/mysql/manager'
import { executeScript } from '@main/mysql/query'
import { fetchTableData } from '@main/mysql/tableData'
import { applyRowChanges, isBinaryDataType } from '@main/mysql/rowChanges'
import * as introspect from '@main/mysql/introspect'
import { listUsers } from '@main/mysql/users'
import {
  buildRowChanges,
  rowsFromPage,
  setCell
} from '../../src/renderer/src/components/data/rowEditing'
import {
  decideEditability,
  firstEditable,
  payloadColumns,
  resultSource,
  type Editability
} from '../../src/renderer/src/components/query/resultEditability'
import { describeMysql } from './targets'

const SCHEMA = `vortaq_it_${process.pid}`

function connectionInput(u: URL): ConnectionInput {
  return {
    name: 'Integration',
    color: null,
    environment: 'local',
    host: u.hostname,
    port: Number(u.port || 3306),
    username: decodeURIComponent(u.username),
    savePassword: true,
    customDatabases: [],
    initialQueries: "SET @vortaq_init = 'yes'",
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      savePassword: false
    },
    ssl: { enabled: false, verifyServer: false },
    backupDir: '/tmp/vortaq-it',
    extraBackupDirs: []
  }
}

describeMysql('mysql module (integration)', ({ url, version, is57 }) => {
  let dir: string
  let ctx: AppContext
  let manager: ConnectionManager
  let connectionId: string
  let noPasswordId: string
  let badInitId: string
  const events: { channel: IpcEventChannel; payload: unknown }[] = []

  beforeAll(async () => {
    const u = new URL(url)
    dir = mkdtempSync(join(tmpdir(), 'vortaq-it-'))
    ctx = {
      userDataPath: dir,
      logDir: join(dir, 'logs'),
      connections: new ConnectionsRepo(dir),
      jobs: new JobsRepo(dir),
      runs: new RunsRepo(dir),
      settings: new SettingsRepo(dir, dir),
      credentials: new CredentialStore(dir, plainCodec, 'plain'),
      emit: <E extends IpcEventChannel>(channel: E, payload: IpcEventMap[E]) => {
        events.push({ channel, payload })
      },
      headless: true
    }
    const saved = ctx.connections.save(connectionInput(u))
    connectionId = saved.id
    ctx.credentials.set('mysql', connectionId, decodeURIComponent(u.password))
    noPasswordId = ctx.connections.save({ ...connectionInput(u), name: 'Sin clave' }).id
    badInitId = ctx.connections.save({
      ...connectionInput(u),
      name: 'Init roto',
      initialQueries: "SET sql_mode = 'NOT_A_MODE'"
    }).id
    ctx.credentials.set('mysql', badInitId, decodeURIComponent(u.password))
    manager = new ConnectionManager(ctx)
  })

  afterAll(async () => {
    try {
      const s = await manager.acquire(connectionId)
      try {
        await s.execute(`DROP DATABASE IF EXISTS \`${SCHEMA}\``)
      } finally {
        await s.release()
      }
    } catch {
      /* best effort */
    }
    await manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses to open a connection without a stored password', async () => {
    await expect(manager.open(noPasswordId)).rejects.toThrow(
      'No hay contraseña guardada para la conexión Sin clave: escríbela en la conexión o marca «Sin contraseña»'
    )
    expect(manager.isOpen(noPasswordId)).toBe(false)
  })

  it('reports failures from test() without throwing', async () => {
    const u = new URL(url)
    const res = await manager.test({ ...connectionInput(u), port: 1 }, 'x', null)
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
    const ok = await manager.test(connectionInput(u), decodeURIComponent(u.password), null)
    expect(ok.ok).toBe(true)
    expect(ok.serverVersion?.startsWith(version)).toBe(true)
  })

  it('opens the connection and returns server info', async () => {
    const info = await manager.open(connectionId)
    expect(info.version.startsWith(version)).toBe(true)
    expect(info.characterSet).toBeTruthy()
    expect(info.uptimeSeconds).toBeGreaterThan(0)
    expect(info.threadsConnected).toBeGreaterThan(0)
    expect(manager.isOpen(connectionId)).toBe(true)
  })

  it('runs initial queries on every pooled connection', async () => {
    const s = await manager.acquire(connectionId)
    try {
      const [row] = await s.query<{ v: string }>('SELECT @vortaq_init AS v')
      expect(row.v).toBe('yes')
    } finally {
      await s.release()
    }
  })

  it('creates a schema and table through the session', async () => {
    const s = await manager.acquire(connectionId)
    try {
      await s.execute(`CREATE DATABASE \`${SCHEMA}\` CHARACTER SET utf8mb4`)
      await s.useSchema(SCHEMA)
      await s.execute(
        `CREATE TABLE items (
           id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           name VARCHAR(50) NOT NULL,
           price DECIMAL(10,2) NULL,
           big BIGINT NULL,
           payload JSON NULL,
           blob_col VARBINARY(8) NULL,
           created_at DATETIME NULL,
           UNIQUE KEY uq_name (name)
         ) COMMENT='integration items'`
      )
      await s.execute(
        'CREATE TABLE tags (item_id INT UNSIGNED NOT NULL, tag VARCHAR(20) NOT NULL, KEY ix_tag (tag), CONSTRAINT fk_tags_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE)'
      )
      await s.execute('CREATE VIEW v_items AS SELECT id, name FROM items')
      await s.execute('CREATE FUNCTION f_one() RETURNS INT DETERMINISTIC RETURN 1')
      await s.execute('CREATE PROCEDURE p_items() SELECT COUNT(*) FROM items')
      await s.execute(
        'CREATE TRIGGER trg_items BEFORE INSERT ON items FOR EACH ROW SET NEW.name = TRIM(NEW.name)'
      )
      await s.execute('CREATE EVENT ev_noop ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1')
    } finally {
      await s.release()
    }
  })

  it('executes a multi-statement script and stops at the failing statement', async () => {
    const s = await manager.acquire(connectionId, SCHEMA)
    try {
      const script = `
        INSERT INTO items (name, price, big, payload, blob_col, created_at)
          VALUES ('  alpha ', 1.50, 9007199254740993, '{"a": [1, 2]}', X'DEAD', '2026-03-17 10:20:30');
        INSERT INTO items (name) VALUES ('beta'), ('gamma');
        SELECT id, name, price, big, payload, blob_col, created_at FROM items ORDER BY id;
        SELECT * FROM missing_table;
        SELECT 'never';
      `
      const results = await executeScript(s, script, {}, 1000)
      expect(results).toHaveLength(4)
      expect(results[0]).toMatchObject({
        affectedRows: 1,
        insertId: 1,
        error: null,
        resultSet: null
      })
      expect(results[1]).toMatchObject({ affectedRows: 2, error: null })
      const select = results[2]
      expect(select.error).toBeNull()
      expect(select.resultSet?.columns.map((c) => [c.name, c.type, c.primaryKey ?? false])).toEqual(
        [
          ['id', 'INT UNSIGNED', true],
          ['name', 'VARCHAR', false],
          ['price', 'DECIMAL', false],
          ['big', 'BIGINT', false],
          ['payload', 'JSON', false],
          ['blob_col', 'VARBINARY', false],
          ['created_at', 'DATETIME', false]
        ]
      )
      expect(select.resultSet?.columns[0]).toMatchObject({ table: 'items', schema: SCHEMA })
      // JSON is the server's own text (jsonStrings), not a re-serialised object
      expect(select.resultSet?.rows[0]).toEqual([
        1,
        'alpha',
        '1.50',
        '9007199254740993',
        '{"a": [1, 2]}',
        '0xDEAD',
        '2026-03-17 10:20:30'
      ])
      expect(select.resultSet?.rows).toHaveLength(3)
      expect(select.resultSet?.truncated).toBe(false)
      expect(results[3].error).toMatch(/doesn't exist \(ER_NO_SUCH_TABLE 1146\)/)
    } finally {
      await s.release()
    }
  })

  it('applies maxRows and reports truncation', async () => {
    const s = await manager.acquire(connectionId, SCHEMA)
    try {
      const [r] = await executeScript(s, 'SELECT id FROM items ORDER BY id', { maxRows: 2 })
      expect(r.resultSet?.rows).toEqual([[1], [2]])
      expect(r.resultSet?.truncated).toBe(true)
      const [ok] = await executeScript(s, 'SELECT 1 AS one', { stopOnError: false })
      expect(ok.error).toBeNull()
    } finally {
      await s.release()
    }
  })

  /*
   * Regression for in-place editing of query results: MySQL reports the inner
   * table/column names (orgTable/orgName) for merged derived tables, CTEs and
   * views, which used to make these results editable against the wrong table,
   * row or column. Runs the real metadata through the renderer decision.
   */
  describe('query result editability against real metadata', () => {
    // Own schema: the listing tests below expect only the objects created above.
    const ED = `${SCHEMA}_ed`

    async function decide(sql: string): Promise<Editability> {
      const s = await manager.acquire(connectionId, ED)
      try {
        const [r] = await executeScript(s, sql)
        expect(r.error).toBeNull()
        const set = r.resultSet!
        const source = resultSource(set.columns, r.sql)
        if (!source.ok) return { editable: false, reason: source.reason }
        // Like EditableResult: the first candidate table the rows can be edited in.
        const chosen = await firstEditable(source.candidates, async (candidate) => {
          const structure = await introspect
            .tableStructure(s, candidate.schema, candidate.table)
            .catch(() => null)
          return { decision: decideEditability(set.columns, candidate, structure, set.rows) }
        })
        return chosen!.decision
      } finally {
        await s.release()
      }
    }

    beforeAll(async () => {
      const s = await manager.acquire(connectionId)
      try {
        await s.execute(`CREATE DATABASE \`${ED}\``)
        await s.useSchema(ED)
        await s.execute('CREATE TABLE ed_decoy (id INT PRIMARY KEY, name VARCHAR(20))')
        await s.execute("INSERT INTO ed_decoy VALUES (1, 'decoy1'), (2, 'decoy2')")
        await s.execute(
          'CREATE TABLE ed_items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(20))'
        )
        await s.execute("INSERT INTO ed_items VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma')")
        await s.execute('CREATE TABLE ed_pairs (id INT PRIMARY KEY, ref INT, label VARCHAR(10))')
        await s.execute("INSERT INTO ed_pairs VALUES (1, 2, 'one'), (2, 1, 'two')")
        await s.execute(
          'CREATE VIEW ed_v_pairs AS SELECT ref AS id, id AS ref, label FROM ed_pairs'
        )
        await s.execute(
          'CREATE ALGORITHM=TEMPTABLE VIEW ed_v_temp AS SELECT id, name FROM ed_items'
        )
        await s.execute(
          'CREATE VIEW ed_v_totals AS SELECT i.id, i.name, COUNT(*) AS n FROM ed_items i JOIN ed_decoy d ON d.id = i.id GROUP BY i.id, i.name'
        )
        // 5.7 split: expression defaults such as DEFAULT (uuid()) need 8.0.13+. On 5.7 the
        // server fills the key from a trigger instead; the table shape seen by the
        // editability decision (non-AUTO_INCREMENT key + AUTO_INCREMENT unique column) is
        // the same.
        if (is57) {
          await s.execute(
            'CREATE TABLE ed_ai (code VARCHAR(36) PRIMARY KEY, n INT AUTO_INCREMENT UNIQUE, v VARCHAR(20))'
          )
          await s.execute(
            'CREATE TRIGGER ed_ai_code BEFORE INSERT ON ed_ai FOR EACH ROW SET NEW.code = IFNULL(NEW.code, uuid())'
          )
        } else {
          await s.execute(
            'CREATE TABLE ed_ai (code VARCHAR(36) PRIMARY KEY DEFAULT (uuid()), n INT AUTO_INCREMENT UNIQUE, v VARCHAR(20))'
          )
        }
      } finally {
        await s.release()
      }
    })

    afterAll(async () => {
      const s = await manager.acquire(connectionId)
      try {
        await s.execute(`DROP DATABASE IF EXISTS \`${ED}\``)
      } finally {
        await s.release()
      }
    })

    it('edits a plain single-table SELECT by key, through aliases', async () => {
      const sql = "SELECT u.id AS ident, u.name FROM ed_items AS u WHERE u.name LIKE '%a%'"
      const decision = await decide(sql)
      expect(decision).toMatchObject({
        editable: true,
        schema: ED,
        table: 'ed_items',
        primaryKey: ['id'],
        keyColumns: ['ident'],
        generatedKeyColumn: 'ident'
      })
      const s = await manager.acquire(connectionId, ED)
      try {
        const [r] = await executeScript(s, sql)
        const rows = rowsFromPage(r.resultSet!.rows)
        setCell(rows[1], 1, 'beta-edited')
        const columns = payloadColumns(r.resultSet!.columns)
        const changes = buildRowChanges(rows, columns, ['id'])
        expect(changes).toEqual([
          { kind: 'update', key: { id: 2 }, values: { name: 'beta-edited' } }
        ])
        await applyRowChanges(s, ED, 'ed_items', changes)
        const [after] = await s.query<{ name: string }>('SELECT name FROM ed_items WHERE id = 2')
        expect(after.name).toBe('beta-edited')
      } finally {
        await s.release()
      }
    })

    it('keeps derived tables read-only whatever table their metadata names', async () => {
      // MySQL reports orgTable = 'ed_items' (the inner alias) for rows of ed_decoy.
      await expect(
        decide('SELECT * FROM (SELECT ed_items.id, ed_items.name FROM ed_decoy ed_items) d')
      ).resolves.toEqual({ editable: false, reason: 'la consulta lee de una subconsulta' })
      await expect(
        decide(
          'SELECT * FROM (SELECT a.id, b.name FROM ed_items a JOIN ed_items b ON b.id = a.id + 1 LIMIT 5) d'
        )
      ).resolves.toMatchObject({ editable: false })
      await expect(decide('SELECT * FROM (SELECT * FROM ed_v_pairs) d')).resolves.toMatchObject({
        editable: false
      })
      const cte = 'WITH c AS (SELECT * FROM ed_v_pairs) SELECT * FROM c'
      if (is57) {
        // 5.7 split: CTEs arrived in 8.0, so 5.7 rejects the statement and there is no
        // result to edit.
        const s = await manager.acquire(connectionId, ED)
        try {
          const [r] = await executeScript(s, cte)
          expect(r.error).toMatch(/\(ER_PARSE_ERROR 1064\)/)
          expect(r.resultSet).toBeNull()
        } finally {
          await s.release()
        }
      } else {
        await expect(decide(cte)).resolves.toEqual({
          editable: false,
          reason: 'la consulta usa WITH (CTE)'
        })
      }
    })

    it('edits one table of a join and locks the columns of the others', async () => {
      await expect(
        decide('SELECT i.* FROM ed_items i JOIN ed_decoy o ON o.id = i.id')
      ).resolves.toMatchObject({ editable: true, table: 'ed_items', locked: [null, null] })
      await expect(
        decide('SELECT ed_items.* FROM ed_items, ed_decoy WHERE ed_decoy.id = ed_items.id')
      ).resolves.toMatchObject({ editable: true, table: 'ed_items' })

      const sql =
        "SELECT i.id, i.name, o.name AS decoy, CONCAT(i.name, '!') AS shout FROM ed_items i JOIN ed_decoy o ON o.id = i.id ORDER BY i.id"
      const decision = await decide(sql)
      expect(decision).toMatchObject({
        editable: true,
        table: 'ed_items',
        primaryKey: ['id'],
        locked: [null, null, 'columna de otra tabla (o)', 'columna calculada']
      })
      if (!decision.editable) return
      const s = await manager.acquire(connectionId, ED)
      try {
        const [r] = await executeScript(s, sql)
        const rows = rowsFromPage(r.resultSet!.rows)
        setCell(rows[0], 1, 'alpha-joined')
        const changes = buildRowChanges(
          rows,
          payloadColumns(r.resultSet!.columns, decision.locked),
          decision.primaryKey
        )
        expect(changes).toEqual([
          { kind: 'update', key: { id: 1 }, values: { name: 'alpha-joined' } }
        ])
        await applyRowChanges(s, ED, 'ed_items', changes)
        const [after] = await s.query<{ name: string }>('SELECT name FROM ed_items WHERE id = 1')
        expect(after.name).toBe('alpha-joined')
        const [decoy] = await s.query<{ name: string }>('SELECT name FROM ed_decoy WHERE id = 1')
        expect(decoy.name).toBe('decoy1')
      } finally {
        await s.release()
      }
    })

    it('tells the sides of a self-join apart and edits the table of a view join', async () => {
      await expect(
        decide(
          'SELECT a.id, a.label, b.label AS other FROM ed_pairs a JOIN ed_pairs b ON b.id = a.ref'
        )
      ).resolves.toMatchObject({
        editable: true,
        table: 'ed_pairs',
        locked: [null, null, 'columna de otra tabla (b)']
      })
      // The view swaps id and ref: its columns are never taken for the table's.
      await expect(
        decide('SELECT p.*, v.id AS swapped FROM ed_pairs p JOIN ed_v_pairs v ON v.label = p.label')
      ).resolves.toMatchObject({
        editable: true,
        table: 'ed_pairs',
        locked: [null, null, null, 'columna de otra tabla (v)']
      })
      await expect(
        decide('SELECT v.* FROM ed_pairs p JOIN ed_v_pairs v ON v.label = p.label')
      ).resolves.toMatchObject({ editable: false, reason: 'el origen es una vista' })
    })

    it('keeps joins that repeat a row or find none read-only', async () => {
      await expect(
        decide('SELECT i.* FROM ed_items i JOIN ed_decoy o ON o.id <= i.id')
      ).resolves.toMatchObject({
        editable: false,
        reason: 'hay filas repetidas con la misma clave'
      })
      await expect(
        decide(
          'SELECT o.id, o.name, i.name AS item FROM ed_items i LEFT JOIN ed_decoy o ON o.id = i.id'
        )
      ).resolves.toMatchObject({
        editable: false,
        table: 'ed_decoy',
        reason: 'hay filas sin clave (el JOIN no encontró su fila)'
      })
      // Derived tables stay out, joined or not.
      await expect(
        decide('SELECT i.* FROM ed_items i JOIN (SELECT id FROM ed_decoy) d ON d.id = i.id')
      ).resolves.toEqual({ editable: false, reason: 'la consulta lee de una subconsulta' })
    })

    it('says a view is a view, whatever its algorithm or columns', async () => {
      // 5.7 split: for views it materialises (ALGORITHM=TEMPTABLE, GROUP BY) 5.7 sends an
      // empty schema in every result column, so an unqualified SELECT names no schema and the
      // result stays read-only as "columnas calculadas" instead of being identified as a view.
      // Merged views (ed_v_pairs) carry the schema on 5.7 too.
      const materialised = is57 ? ['ed_v_temp', 'ed_v_totals'] : []
      for (const view of ['ed_v_temp', 'ed_v_totals', 'ed_v_pairs'])
        if (materialised.includes(view))
          await expect(decide(`SELECT * FROM ${view}`)).resolves.toEqual({
            editable: false,
            reason: 'columnas calculadas'
          })
        else
          await expect(decide(`SELECT * FROM ${view}`)).resolves.toMatchObject({
            editable: false,
            reason: 'el origen es una vista',
            table: view
          })
    })

    it('only fills generated ids into an AUTO_INCREMENT primary key', async () => {
      await expect(decide('SELECT * FROM ed_ai')).resolves.toMatchObject({
        editable: true,
        primaryKey: ['code'],
        generatedKeyColumn: null
      })
    })
  })

  it('exposes the first result set of a CALL', async () => {
    const s = await manager.acquire(connectionId, SCHEMA)
    try {
      const [r] = await executeScript(s, 'CALL p_items()')
      expect(r.error).toBeNull()
      // COUNT(*) is BIGINT: bigNumberStrings keeps it as a string
      expect(r.resultSet?.rows).toEqual([['3']])
    } finally {
      await s.release()
    }
  })

  it('reports the origin table, real column and key of each result column', async () => {
    const s = await manager.acquire(connectionId, SCHEMA)
    try {
      const [r] = await executeScript(s, 'SELECT id AS ident, name FROM items AS u')
      expect(r.error).toBeNull()
      expect(r.resultSet?.columns).toEqual([
        expect.objectContaining({
          name: 'ident',
          sourceName: 'id',
          table: 'items',
          tableAlias: 'u',
          schema: SCHEMA,
          primaryKey: true
        }),
        expect.objectContaining({
          name: 'name',
          sourceName: 'name',
          table: 'items',
          schema: SCHEMA
        })
      ])
      expect(r.resultSet?.columns[1].primaryKey).toBeUndefined()

      // Expressions carry no origin; a self-join is told apart by the alias.
      const [expr] = await executeScript(s, 'SELECT id, UPPER(name) AS up FROM items')
      expect(expr.resultSet?.columns[1].table).toBeUndefined()
      expect(expr.resultSet?.columns[1].sourceName).toBeUndefined()
      const [self] = await executeScript(
        s,
        'SELECT a.id, b.name FROM items a JOIN items b ON b.id = a.id'
      )
      expect(self.resultSet?.columns.map((c) => c.tableAlias)).toEqual(['a', 'b'])
    } finally {
      await s.release()
    }
  })

  it('fetches table data with primary key and total', async () => {
    const s = await manager.acquire(connectionId)
    try {
      const page = await fetchTableData(s, {
        schema: SCHEMA,
        table: 'items',
        limit: 2,
        offset: 1,
        orderBy: { column: 'id', direction: 'DESC' },
        where: 'id > 0'
      })
      expect(page.primaryKey).toEqual(['id'])
      expect(page.total).toBe(3)
      expect(page.rows.map((r) => r[0])).toEqual([2, 1])
      expect(page.columns[0]).toMatchObject({ name: 'id', primaryKey: true })
      const bad = await fetchTableData(s, {
        schema: SCHEMA,
        table: 'items',
        limit: 10,
        offset: 0,
        where: 'nope = 1'
      }).catch((e: Error) => e)
      expect(bad).toBeInstanceOf(Error)
    } finally {
      await s.release()
    }
  })

  it('applies row changes atomically', async () => {
    const s = await manager.acquire(connectionId)
    try {
      const res = await applyRowChanges(s, SCHEMA, 'items', [
        { kind: 'insert', values: { name: 'delta', price: '2.25' } },
        { kind: 'update', key: { id: 2 }, values: { name: 'beta2', price: null } },
        { kind: 'delete', key: { id: 3 } }
      ])
      expect(res.applied).toBe(3)
      expect(res.insertIds).toEqual([4, null, null])
      expect(res.statements[1]).toBe(
        `UPDATE \`${SCHEMA}\`.\`items\` SET \`name\` = 'beta2', \`price\` = NULL WHERE \`id\` = 2`
      )
      const rows = await s.query<{ id: number; name: string }>(
        `SELECT id, name FROM \`${SCHEMA}\`.items ORDER BY id`
      )
      expect(rows.map((r) => [r.id, r.name])).toEqual([
        [1, 'alpha'],
        [2, 'beta2'],
        [4, 'delta']
      ])

      // duplicate name -> whole batch rolled back
      await expect(
        applyRowChanges(s, SCHEMA, 'items', [
          { kind: 'delete', key: { id: 4 } },
          { kind: 'insert', values: { name: 'alpha' } }
        ])
      ).rejects.toThrow(
        /Falló el cambio 2 de 2 \(fila nueva\): ya existe una fila con el mismo valor en la clave única/
      )
      const after = await s.query<{ n: string }>(`SELECT COUNT(*) AS n FROM \`${SCHEMA}\`.items`)
      expect(Number(after[0].n)).toBe(3)
    } finally {
      await s.release()
    }
  })

  it('lists objects through information_schema', async () => {
    const s = await manager.acquire(connectionId)
    try {
      const dbs = await introspect.listDatabases(s)
      expect(dbs.map((d) => d.name)).toContain(SCHEMA)
      expect(dbs.find((d) => d.name === SCHEMA)?.characterSet).toBe('utf8mb4')

      const tables = await introspect.listTables(s, SCHEMA)
      expect(tables.map((t) => t.name)).toEqual(['items', 'tags'])
      expect(tables[0]).toMatchObject({ engine: 'InnoDB', comment: 'integration items' })
      expect(tables[0].autoIncrement).toBeGreaterThanOrEqual(5)

      const views = await introspect.listViews(s, SCHEMA)
      expect(views.map((v) => v.name)).toEqual(['v_items'])
      expect(views[0].updatable).toBe(true)

      const routines = await introspect.listRoutines(s, SCHEMA)
      expect(routines.map((r) => [r.name, r.type])).toEqual([
        ['f_one', 'FUNCTION'],
        ['p_items', 'PROCEDURE']
      ])
      expect(routines[0].returns).toMatch(/int/i)

      const events = await introspect.listEvents(s, SCHEMA)
      expect(events.map((e) => e.name)).toEqual(['ev_noop'])
      expect(events[0]).toMatchObject({
        status: 'DISABLED',
        type: 'RECURRING',
        intervalValue: '1',
        intervalField: 'DAY'
      })

      const triggers = await introspect.listTriggers(s, SCHEMA)
      expect(triggers).toHaveLength(1)
      expect(triggers[0]).toMatchObject({
        name: 'trg_items',
        table: 'items',
        event: 'INSERT',
        timing: 'BEFORE'
      })

      const columns = await introspect.listColumns(s, SCHEMA, 'items')
      expect(columns.map((c) => c.name)).toEqual([
        'id',
        'name',
        'price',
        'big',
        'payload',
        'blob_col',
        'created_at'
      ])
      expect(columns[0]).toMatchObject({
        ordinal: 1,
        // 5.7 split: integer display widths were deprecated (and dropped from COLUMN_TYPE)
        // in 8.0.19; 5.7 still reports them.
        columnType: is57 ? 'int(10) unsigned' : 'int unsigned',
        nullable: false,
        key: 'PRI',
        extra: 'auto_increment'
      })
      expect(columns[1].characterSet).toBe('utf8mb4')

      const structure = await introspect.tableStructure(s, SCHEMA, 'tags')
      expect(structure.indexes.map((i) => [i.name, i.columns])).toEqual([
        ['fk_tags_item', ['item_id']],
        ['ix_tag', ['tag']]
      ])
      expect(structure.foreignKeys).toEqual([
        {
          name: 'fk_tags_item',
          columns: ['item_id'],
          referencedSchema: SCHEMA,
          referencedTable: 'items',
          referencedColumns: ['id'],
          // 5.7 split: an omitted ON UPDATE is reported as RESTRICT by 5.7 and as NO ACTION
          // by 8.x (REFERENTIAL_CONSTRAINTS.UPDATE_RULE); InnoDB treats both the same.
          onUpdate: is57 ? 'RESTRICT' : 'NO ACTION',
          onDelete: 'CASCADE'
        }
      ])
      expect(structure.createSql).toMatch(/^CREATE TABLE `tags`/)
      const items = await introspect.tableStructure(s, SCHEMA, 'items')
      expect(items.indexes[0]).toMatchObject({ name: 'PRIMARY', unique: true, columns: ['id'] })
      expect(items.indexes[1]).toMatchObject({ name: 'uq_name', unique: true })
      // Views report themselves as a query's origin table: TABLE_TYPE tells them apart.
      expect(items.tableType).toBe('BASE TABLE')
      expect((await introspect.tableStructure(s, SCHEMA, 'v_items')).tableType).toBe('VIEW')
      await expect(introspect.tableStructure(s, SCHEMA, 'nope')).rejects.toThrow('no existe')

      const charsets = await introspect.listCharsets(s)
      const utf8mb4 = charsets.find((c) => c.charset === 'utf8mb4')
      expect(utf8mb4?.collations).toContain('utf8mb4_unicode_ci')
      expect(utf8mb4?.defaultCollation).toBeTruthy()
    } finally {
      await s.release()
    }
  })

  it('returns SHOW CREATE for every object type', async () => {
    const s = await manager.acquire(connectionId)
    try {
      expect(await introspect.showCreate(s, SCHEMA, 'table', 'items')).toMatch(
        /^CREATE TABLE `items`/
      )
      expect(await introspect.showCreate(s, SCHEMA, 'view', 'v_items')).toMatch(
        /VIEW (`[^`]+`\.)?`v_items`/
      )
      expect(await introspect.showCreate(s, SCHEMA, 'function', 'f_one')).toMatch(
        /FUNCTION `f_one`/
      )
      expect(await introspect.showCreate(s, SCHEMA, 'procedure', 'p_items')).toMatch(
        /PROCEDURE `p_items`/
      )
      expect(await introspect.showCreate(s, SCHEMA, 'event', 'ev_noop')).toMatch(/EVENT `ev_noop`/)
      // 5.7 split: SHOW CREATE TRIGGER returns the statement as it was written (unquoted
      // name); 8.x regenerates it with a quoted name.
      expect(await introspect.showCreate(s, SCHEMA, 'trigger', 'trg_items')).toMatch(
        is57 ? /TRIGGER trg_items BEFORE INSERT ON items/ : /TRIGGER `trg_items`/
      )
      await expect(introspect.showCreate(s, SCHEMA, 'table', 'nope')).rejects.toThrow(
        /doesn't exist/
      )
    } finally {
      await s.release()
    }
  })

  it('lists users when privileged', async () => {
    const s = await manager.acquire(connectionId)
    try {
      const users = await listUsers(s)
      expect(users.some((u) => u.user === 'root')).toBe(true)
      expect(typeof users[0].accountLocked).toBe('boolean')
    } finally {
      await s.release()
    }
  })

  it('streams rows as arrays', async () => {
    const s = await manager.acquire(connectionId, SCHEMA)
    try {
      const { columns, rows } = await s.streamRows(
        'SELECT id, name, payload FROM items WHERE id <= ? ORDER BY id',
        [2]
      )
      expect(columns).toEqual(['id', 'name', 'payload'])
      const out: unknown[][] = []
      for await (const row of rows) out.push(row as unknown[])
      expect(out).toEqual([
        // JSON arrives as the server's text, untouched
        [1, 'alpha', '{"a": [1, 2]}'],
        [2, 'beta2', null]
      ])
      // the connection stays usable afterwards
      const [r] = await s.query<{ one: string }>('SELECT 1 AS one') // integer literal is BIGINT -> string
      expect(r.one).toBe('1')
      await expect(s.streamRows('SELECT * FROM missing_table')).rejects.toThrow(/doesn't exist/)
      // a statement without a result set resolves with no columns instead of hanging
      const none = await s.streamRows('DO 1')
      expect(none.columns).toEqual([])
      const rest: unknown[] = []
      for await (const row of none.rows) rest.push(row)
      expect(rest).toEqual([])
    } finally {
      await s.release()
    }
  })

  it('drops objects and databases', async () => {
    const s = await manager.acquire(connectionId)
    try {
      await introspect.dropObject(s, SCHEMA, 'trigger', 'trg_items')
      await introspect.dropObject(s, SCHEMA, 'event', 'ev_noop')
      await introspect.dropObject(s, SCHEMA, 'view', 'v_items')
      expect(await introspect.listViews(s, SCHEMA)).toEqual([])
      await introspect.createDatabase(s, `${SCHEMA}_x`, 'utf8mb4', 'utf8mb4_unicode_ci')
      expect(
        (await introspect.listDatabases(s)).find((d) => d.name === `${SCHEMA}_x`)?.collation
      ).toBe('utf8mb4_unicode_ci')
      await introspect.dropDatabase(s, `${SCHEMA}_x`)
      await expect(introspect.createDatabase(s, 'x', 'utf8mb4; DROP', '')).rejects.toThrow(
        /no válido/
      )
      await expect(introspect.dropDatabase(s, 'MySQL')).rejects.toThrow(/del sistema/)
    } finally {
      await s.release()
    }
  })

  it('surfaces a failing initial query instead of handing out the connection', async () => {
    await expect(manager.open(badInitId)).rejects.toThrow(
      /consulta inicial de la línea 1 falló en Init roto/
    )
    expect(manager.isOpen(badInitId)).toBe(false)
  })

  it('never leaks session state (USE, variables, open transactions) to the next session', async () => {
    const s = await manager.acquire(connectionId)
    let leakedThread: string
    try {
      await s.execute(`CREATE TABLE \`${SCHEMA}\`.trx_probe (id INT PRIMARY KEY)`)
      const results = await executeScript(
        s,
        `USE \`${SCHEMA}\`; SET FOREIGN_KEY_CHECKS = 0; START TRANSACTION; INSERT INTO trx_probe VALUES (1); SELECT nope FROM trx_probe`
      )
      expect(results.at(-1)?.error).toMatch(/Unknown column/)
      const [row] = await s.query<{ id: string }>('SELECT CONNECTION_ID() AS id')
      leakedThread = String(row.id)
    } finally {
      await s.release()
    }
    const next = await manager.acquire(connectionId)
    try {
      const [state] = await next.query<{ db: string | null; fk: string }>(
        `SELECT DATABASE() AS db, @@foreign_key_checks AS fk`
      )
      expect(state.db).toBeNull()
      expect(String(state.fk)).toBe('1')
      // The dirty connection was destroyed: the server rolls its transaction back when it sees
      // the disconnect, asynchronously (under load, 5.7 can take a moment). A transaction leaked
      // into the pool would stay open forever, so it must be gone within a few seconds.
      const openTrx = async (): Promise<string> => {
        const [row] = await next.query<{ trx: string }>(
          `SELECT COUNT(*) AS trx FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id = ${Number(leakedThread)}`
        )
        return String(row.trx)
      }
      let trx = await openTrx()
      for (let i = 0; i < 50 && trx !== '0'; i++) {
        await new Promise((r) => setTimeout(r, 100))
        trx = await openTrx()
      }
      expect(trx).toBe('0')
      const rows = await next.query(`SELECT * FROM \`${SCHEMA}\`.trx_probe`)
      expect(rows).toEqual([])
    } finally {
      await next.release()
    }
  })

  it('keeps GEOMETRY as raw bytes and JSON as exact text', async () => {
    const s = await manager.acquire(connectionId, SCHEMA)
    try {
      await s.execute('CREATE TABLE geo (id INT PRIMARY KEY, g POINT NULL, j JSON NULL)')
      await s.execute(
        `INSERT INTO geo VALUES (1, ST_GeomFromText('POINT(1 2)'), '{"big": 12345678901234567890, "f": 1.10}')`
      )
      const [hex] = await s.query<{ h: string }>('SELECT HEX(g) AS h FROM geo')
      const { rows } = await s.streamRows('SELECT id, g, j FROM geo')
      const out: unknown[][] = []
      for await (const row of rows) out.push(row as unknown[])
      expect(Buffer.isBuffer(out[0][1])).toBe(true)
      expect((out[0][1] as Buffer).toString('hex').toUpperCase()).toBe(hex.h)
      expect(out[0][2]).toBe('{"f": 1.1, "big": 12345678901234567890}')
      const [r] = await executeScript(s, 'SELECT g, j FROM geo')
      expect(r.resultSet?.rows[0]).toEqual([
        '0x' + hex.h,
        '{"f": 1.1, "big": 12345678901234567890}'
      ])
    } finally {
      await s.release()
    }
  })

  it('edits rows keyed by a binary primary key and refuses edits that match nothing', async () => {
    const s = await manager.acquire(connectionId, SCHEMA)
    try {
      await s.execute('CREATE TABLE bin_pk (id BINARY(4) PRIMARY KEY, v VARCHAR(10))')
      await s.execute("INSERT INTO bin_pk VALUES (X'01020304', 'a'), (X'0A0B0C0D', 'b')")
      const page = await fetchTableData(s, {
        schema: SCHEMA,
        table: 'bin_pk',
        limit: 10,
        offset: 0
      })
      expect(page.rows[0]).toEqual(['0x01020304', 'a'])
      const columns = await introspect.listColumns(s, SCHEMA, 'bin_pk')
      const binary = new Set(columns.filter((c) => isBinaryDataType(c.dataType)).map((c) => c.name))
      const res = await applyRowChanges(
        s,
        SCHEMA,
        'bin_pk',
        [{ kind: 'update', key: { id: page.rows[0][0] }, values: { v: 'z' } }],
        binary
      )
      expect(res.applied).toBe(1)
      const [after] = await s.query<{ v: string }>("SELECT v FROM bin_pk WHERE id = X'01020304'")
      expect(after.v).toBe('z')
      // unchanged values still count as matched (CLIENT_FOUND_ROWS)
      await expect(
        applyRowChanges(
          s,
          SCHEMA,
          'bin_pk',
          [{ kind: 'update', key: { id: '0x01020304' }, values: { v: 'z' } }],
          binary
        )
      ).resolves.toMatchObject({ applied: 1 })
      await expect(
        applyRowChanges(
          s,
          SCHEMA,
          'bin_pk',
          [
            { kind: 'delete', key: { id: '0x0A0B0C0D' } },
            { kind: 'delete', key: { id: 'nonexistent' } }
          ],
          binary
        )
      ).rejects.toThrow(/Falló el cambio 2 de 2 .*la fila ya no existe/)
      const [count] = await s.query<{ n: string }>('SELECT COUNT(*) AS n FROM bin_pk')
      expect(Number(count.n)).toBe(2)
    } finally {
      await s.release()
    }
  })

  it('keeps LIMIT when the table filter ends with a comment', async () => {
    const s = await manager.acquire(connectionId)
    try {
      await s.execute(`CREATE TABLE \`${SCHEMA}\`.many (id INT PRIMARY KEY)`)
      await s.execute(`INSERT INTO \`${SCHEMA}\`.many VALUES (1),(2),(3),(4),(5)`)
      const page = await fetchTableData(s, {
        schema: SCHEMA,
        table: 'many',
        limit: 2,
        offset: 0,
        where: 'id > 0 -- note'
      })
      expect(page.rows).toHaveLength(2)
      expect(page.total).toBe(5)
      const [processlistCheck] = await executeScript(
        s,
        `SELECT COUNT(*) FROM (SELECT * FROM \`${SCHEMA}\`.many WHERE (\nid > 0 -- note\n) LIMIT 2) t`
      )
      expect(processlistCheck.resultSet?.rows).toEqual([['2']])
    } finally {
      await s.release()
    }
  })

  it('survives the loss of one pooled connection while another session is busy', async () => {
    const busy = await manager.acquire(connectionId)
    const killer = await manager.acquire(connectionId)
    const victim = await manager.acquire(connectionId)
    const [{ id: victimId }] = await victim.query<{ id: string }>('SELECT CONNECTION_ID() AS id')
    await victim.release() // clean: goes back to the pool idle
    const running = busy.query<{ s: string }>('SELECT SLEEP(1) AS s')
    try {
      await killer.execute(`KILL ${Number(victimId)}`)
    } finally {
      await killer.release()
    }
    const [slept] = await running
    expect(String(slept.s)).toBe('0')
    const [again] = await busy.query<{ one: string }>('SELECT 1 AS one')
    expect(String(again.one)).toBe('1')
    await busy.release()
    expect(manager.isOpen(connectionId)).toBe(true)
    // the pool replaces the dead connection transparently
    for (let i = 0; i < 4; i++) {
      const s = await manager.acquire(connectionId)
      try {
        await s.query('SELECT 1')
      } finally {
        await s.release()
      }
    }
    expect(events.filter((e) => e.channel === 'event:connectionClosed')).toEqual([])
  })

  it('closes the connection and can reopen it', async () => {
    await manager.close(connectionId)
    expect(manager.isOpen(connectionId)).toBe(false)
    await manager.close(connectionId) // idempotent
    const info = await manager.open(connectionId)
    expect(info.version.startsWith(version)).toBe(true)
    expect(events.filter((e) => e.channel === 'event:connectionClosed')).toEqual([])
  })
})
