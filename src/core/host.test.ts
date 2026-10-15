/**
 * createCore without Electron: the channels it answers, the vault-key secrets,
 * the production guard and the export:* channels, on a SQLite file with
 * in-process workers (no server). The Node-only integration test
 * (tests/integration/coreNode.test.ts) does the same against the bundled core
 * and real servers.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultSqliteOptions } from '@shared/engines'
import type { ConnectionInput, ProgressEvent, QueryStatementResult } from '@shared/types'
import { unzip } from '@main/export/testing/unzip'
import { inProcessSpawner } from '@main/sqlite/spawner'
import {
  createCore,
  defaultExportOptions,
  EXPORT_MONGO_REFUSED,
  keyCodec,
  newVaultKey,
  type VortaqCore
} from './index'

function sqliteInput(filePath: string, overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: 'Core SQLite',
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
    sqlite: { ...defaultSqliteOptions(false), filePath },
    ...overrides
  }
}

const ok = (results: QueryStatementResult[]): QueryStatementResult[] => {
  const failed = results.find((r) => r.error)
  if (failed) throw new Error(`${failed.sql}: ${failed.error}`)
  return results
}

describe('createCore (Node host, no Electron)', () => {
  let dir: string
  let core: VortaqCore
  const vaultKey = newVaultKey()
  const progress: ProgressEvent[] = []

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-core-host-'))
    core = createCore({
      dataDir: join(dir, 'profile'),
      home: dir,
      secrets: { codec: keyCodec(vaultKey), codecName: 'vaultKey' },
      sqliteSpawner: inProcessSpawner(),
      emit: (channel, payload) => {
        if (channel === 'event:progress') progress.push(payload as ProgressEvent)
      }
    })
  })

  afterAll(async () => {
    await core?.dispose()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('answers the core channels and none of the desktop-only ones', () => {
    const channels = core.channels()
    for (const c of [
      'connections:save',
      'connections:open',
      'db:execute',
      'db:tables',
      'db:applyRowChanges',
      'mongo:find',
      'mongo:applyChanges',
      'sqlite:createFile',
      'filters:list',
      'backups:create',
      'export:rows',
      'export:query',
      'export:cancel',
      'ai:chat'
    ] as const)
      expect(channels).toContain(c)
    expect(
      channels.filter((c) => /^(app|updates|jobs|navicat|importers|tour|settings):/.test(c))
    ).toEqual([])
  })

  it('keeps passwords encrypted with the vault key in its own profile', async () => {
    const saved = await core.invoke('connections:save', sqliteInput(join(dir, 'unused.db')))
    await core.invoke('connections:setSshPassword', saved.id, 'tunnel-secret-value')
    expect(await core.invoke('connections:hasSshPassword', saved.id)).toBe(true)
    const file = readFileSync(join(dir, 'profile', 'credentials.json'), 'utf8')
    expect(file).not.toContain('tunnel-secret-value')
    expect(file).not.toContain(vaultKey)
    expect(core.context.credentials.get('ssh', saved.id)).toBe('tunnel-secret-value')
    await core.invoke('connections:delete', saved.id)
    expect(core.context.credentials.get('ssh', saved.id)).toBeNull()
  })

  it('connections:setMcp changes only the agents setting', async () => {
    const stored = (id: string) =>
      JSON.parse(readFileSync(join(dir, 'profile', 'connections.json'), 'utf8')).items.find(
        (c: { id: string }) => c.id === id
      )
    const saved = await core.invoke(
      'connections:save',
      sqliteInput(join(dir, 'mcp.db'), { name: 'Core MCP' })
    )
    await core.invoke('connections:setSshPassword', saved.id, 'kept-secret-value')
    const { updatedAt: _before, ...before } = stored(saved.id)
    const on = await core.invoke('connections:setMcp', saved.id, {
      enabled: true,
      access: 'structure'
    })
    expect(on.mcp).toEqual({ enabled: true, access: 'structure' })
    const { updatedAt: _after, mcp, ...after } = stored(saved.id)
    expect(mcp).toEqual({ enabled: true, access: 'structure' })
    expect(after).toEqual(before)
    expect(core.context.credentials.get('ssh', saved.id)).toBe('kept-secret-value')

    // Production never gets «Lectura y escritura»; nothing is written.
    const prod = await core.invoke(
      'connections:save',
      sqliteInput(join(dir, 'mcp.db'), { name: 'Core MCP prod', environment: 'production' })
    )
    await expect(
      core.invoke('connections:setMcp', prod.id, { enabled: true, access: 'write' })
    ).rejects.toThrow(/«Core MCP prod».*Lectura y escritura/)
    expect(stored(prod.id).mcp).toBeUndefined()
    await core.invoke('connections:setMcp', prod.id, { enabled: true, access: 'read' })
    expect(stored(prod.id).mcp).toEqual({ enabled: true, access: 'read' })

    await expect(
      core.invoke('connections:setMcp', saved.id, { enabled: 'yes', access: 'read' } as never)
    ).rejects.toThrow(/no válido/)
    await expect(
      core.invoke('connections:setMcp', saved.id, { enabled: true, access: 'root' } as never)
    ).rejects.toThrow(/no válido/)
    await expect(
      core.invoke('connections:setMcp', 'missing-id', { enabled: true, access: 'read' })
    ).rejects.toThrow(/ya no existe/)
    expect(stored(saved.id).mcp).toEqual({ enabled: true, access: 'structure' })
    await core.invoke('connections:delete', saved.id)
    await core.invoke('connections:delete', prod.id)
  })

  it('runs SQL, edits a row and refuses an unconfirmed write on production', async () => {
    const file = join(dir, 'core.db')
    await core.invoke('sqlite:createFile', file)
    const local = await core.invoke('connections:save', sqliteInput(file))
    const prod = await core.invoke(
      'connections:save',
      sqliteInput(file, {
        name: 'Core SQLite prod',
        environment: 'production',
        sqlite: { ...defaultSqliteOptions(false), filePath: file }
      })
    )
    ok(
      await core.invoke(
        'db:execute',
        local.id,
        "CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO item (name) VALUES ('uno');",
        { schema: 'main' }
      )
    )
    expect((await core.invoke('db:tables', local.id, 'main')).map((t) => t.name)).toEqual(['item'])
    const edit = await core.invoke('db:applyRowChanges', local.id, 'main', 'item', [
      { kind: 'update', key: { id: 1 }, values: { name: 'dos' } }
    ])
    expect(edit.applied).toBe(1)
    const [read] = ok(await core.invoke('db:execute', local.id, 'SELECT name FROM item'))
    expect(read.resultSet?.rows).toEqual([['dos']])

    await expect(
      core.invoke('db:execute', prod.id, "UPDATE item SET name = 'tres'", { schema: 'main' })
    ).rejects.toThrow(/necesita confirmación explícita/)
    await expect(
      core.invoke('db:applyRowChanges', prod.id, 'main', 'item', [
        { kind: 'update', key: { id: 1 }, values: { name: 'tres' } }
      ])
    ).rejects.toThrow(/necesita confirmación explícita/)
    const [after] = ok(await core.invoke('db:execute', prod.id, 'SELECT name FROM item'))
    expect(after.resultSet?.rows).toEqual([['dos']])
  })

  describe('export:* (copy/export of results)', () => {
    let id: string
    let out: string

    beforeAll(async () => {
      const file = join(dir, 'export.db')
      await core.invoke('sqlite:createFile', file)
      id = (
        await core.invoke(
          'connections:save',
          sqliteInput(file, { name: 'Core export', environment: 'production' })
        )
      ).id
      ok(
        await core.invoke(
          'db:execute',
          id,
          `CREATE TABLE venta (id INTEGER PRIMARY KEY, cliente TEXT, total REAL);
           WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
           INSERT INTO venta SELECT i, 'Cliente ' || i, i * 1.5 FROM n;`,
          { schema: 'main', confirmProduction: true }
        )
      )
      out = mkdtempSync(join(dir, 'out-'))
    })

    const partFiles = (): string[] => readdirSync(out).filter((f) => f.endsWith('.part'))

    it('export:rows writes the rows the host sends, through a .part file', async () => {
      const filePath = join(out, 'seleccion.csv')
      const result = await core.invoke('export:rows', {
        filePath,
        columns: [{ name: 'id' }, { name: 'cliente' }],
        rows: [
          [1, 'Lucía; "Madrid"'],
          [2, null]
        ],
        options: defaultExportOptions({ format: 'csv', delimiter: ';', nullText: 'NULL' })
      })
      expect(result).toMatchObject({ filePath, rows: 2 })
      expect(readFileSync(filePath, 'utf8')).toBe(
        'id;cliente\r\n1;"Lucía; ""Madrid"""\r\n2;NULL\r\n'
      )
      expect(partFiles()).toEqual([])
    })

    it('export:query re-reads the whole result on a production connection, without confirmation', async () => {
      progress.length = 0
      const filePath = join(out, 'ventas.csv')
      const result = await core.invoke('export:query', 'export-csv', {
        connectionId: id,
        filePath,
        source: { kind: 'statement', sql: 'SELECT id, cliente, total FROM venta ORDER BY id' },
        options: defaultExportOptions({ format: 'csv' })
      })
      expect(result.rows).toBe(1200)
      const lines = readFileSync(filePath, 'utf8').trimEnd().split('\r\n')
      expect(lines).toHaveLength(1201)
      expect(lines.slice(0, 3)).toEqual(['id,cliente,total', '1,Cliente 1,1.5', '2,Cliente 2,3'])
      expect(partFiles()).toEqual([])
      const mine = progress.filter((e) => e.operationId === 'export-csv')
      expect(mine.length).toBeGreaterThan(0)
      expect(mine.every((e) => e.kind === 'export')).toBe(true)
      expect(mine.at(-1)).toMatchObject({ done: true, phase: 'done', current: 1200 })
    })

    it('export:query writes XLSX from the table view source (no paging)', async () => {
      const filePath = join(out, 'venta.xlsx')
      const result = await core.invoke('export:query', 'export-xlsx', {
        connectionId: id,
        filePath,
        source: { kind: 'table', request: { schema: 'main', table: 'venta', orderBy: null } },
        options: defaultExportOptions({ format: 'xlsx', sheetName: 'venta' })
      })
      expect(result.rows).toBe(1200)
      const entries = unzip(filePath)
      expect([...entries.keys()]).toContain('xl/worksheets/sheet1.xml')
      expect(entries.get('xl/worksheets/sheet1.xml')!.data.toString('utf8')).toContain(
        'Cliente 1200'
      )
      expect(partFiles()).toEqual([])
    })

    it('refuses writes, MongoDB connections and relative paths, and creates no file', async () => {
      const refused = join(out, 'nunca.csv')
      await expect(
        core.invoke('export:query', 'export-write', {
          connectionId: id,
          filePath: refused,
          source: {
            kind: 'statement',
            sql: "WITH c AS (SELECT 1) UPDATE venta SET cliente = 'x' RETURNING id"
          },
          options: defaultExportOptions()
        })
      ).rejects.toThrow(/solo se vuelven a ejecutar consultas de solo lectura/)
      const mongo = await core.invoke('connections:save', {
        ...sqliteInput(''),
        name: 'Core Mongo',
        engine: 'mongodb',
        host: '127.0.0.1',
        port: 1,
        sqlite: undefined
      })
      await expect(
        core.invoke('export:query', 'export-mongo', {
          connectionId: mongo.id,
          filePath: refused,
          source: { kind: 'statement', sql: 'SELECT 1' },
          options: defaultExportOptions()
        })
      ).rejects.toThrow(EXPORT_MONGO_REFUSED)
      await expect(
        core.invoke('export:rows', {
          filePath: 'relativo.csv',
          columns: [{ name: 'a' }],
          rows: [],
          options: defaultExportOptions()
        })
      ).rejects.toThrow(/absoluta/)
      expect(existsSync(refused)).toBe(false)
      expect(partFiles()).toEqual([])
      // Nothing was written: the full export never writes.
      const [count] = ok(
        await core.invoke('db:execute', id, "SELECT COUNT(*) FROM venta WHERE cliente = 'x'")
      )
      expect(count.resultSet?.rows).toEqual([[0]])
    })

    it('export:cancel of an operation that is not running does nothing', async () => {
      await expect(core.invoke('export:cancel', 'no-such-export')).resolves.toBeUndefined()
    })
  })
})
