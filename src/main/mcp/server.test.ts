/**
 * The MCP server end to end over the SDK's in-memory transport, against real
 * SQLite files (in-process workers): what each level allows, what list_connections
 * hides, values and limits, changes made in the app picked up on the next call,
 * redaction and the activity log. Server suites per engine: tests/integration/mcp*.test.ts.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultSqliteOptions } from '@shared/engines'
import type { ConnectionInput, McpAccess } from '@shared/types'
import { plainCodec } from '../credentials/store'
import { inProcessSpawner, setSqliteSpawner } from '../sqlite/spawner'
import { setJsonStoreReadOnly, setJsonStoreReload } from '../storage/jsonStore'
import { ConnectionsRepo, SettingsRepo } from '../storage/repos'
import { MCP_DISABLED } from './access'
import { createMcpContext } from './context'
import { McpRuntime } from './runtime'
import { activityLine, createMcpServer, type McpActivity } from './server'

function sqliteInput(
  name: string,
  filePath: string,
  environment: ConnectionInput['environment'],
  mcp: ConnectionInput['mcp']
): ConnectionInput {
  return {
    name,
    color: null,
    environment,
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
    ...(mcp ? { mcp } : {})
  }
}

const LONG = 'x'.repeat(2500)

interface ToolText {
  isError?: boolean
  content: { type: string; text: string }[]
}

describe('MCP server over the in-memory transport (SQLite)', () => {
  let dir: string
  let profile: string
  let shop: string
  let shopCopy: string
  let client: Client
  let runtime: McpRuntime
  const activity: McpActivity[] = []

  /** Writes to the profile like the desktop app does (this process is read-only otherwise). */
  function asApp(fn: () => void): void {
    setJsonStoreReadOnly(false)
    try {
      fn()
    } finally {
      setJsonStoreReadOnly(true)
    }
  }
  const appRepo = (): ConnectionsRepo => new ConnectionsRepo(profile)
  const setAccess = (name: string, mcp: { enabled: boolean; access: McpAccess } | undefined) =>
    asApp(() => {
      const repo = appRepo()
      const c = repo.findByName(name)!
      const { mcp: _old, ...rest } = c
      repo.save({ ...rest, ...(mcp ? { mcp } : {}) })
    })

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolText> {
    return (await client.callTool({ name, arguments: args })) as ToolText
  }
  // The answers are free-form JSON: the assertions below say what they hold.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = await call(name, args)
    if (r.isError) throw new Error(`${name} failed: ${r.content[0]?.text}`)
    return JSON.parse(r.content[0].text)
  }
  async function refused(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const r = await call(name, args)
    expect(r.isError, `${name} should fail`).toBe(true)
    return r.content[0].text
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-mcp-unit-'))
    profile = join(dir, 'profile')
    shop = join(dir, 'tienda.db')
    shopCopy = join(dir, 'tienda-escritura.db')
    const db = new DatabaseSync(shop)
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE clientes (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, email TEXT UNIQUE, saldo REAL DEFAULT 0);
      CREATE TABLE pedidos (
        id INTEGER PRIMARY KEY, cliente_id INTEGER NOT NULL REFERENCES clientes(id),
        total NUMERIC, foto BLOB, nota TEXT, grande INTEGER
      );
      CREATE INDEX pedidos_cliente ON pedidos(cliente_id);
      CREATE VIEW resumen AS SELECT cliente_id, COUNT(*) AS n FROM pedidos GROUP BY cliente_id;
      INSERT INTO clientes (id, nombre, email, saldo) VALUES (1, 'Ana', 'ana@example.test', 10.5), (2, 'Luis', NULL, 0);
    `)
    const insert = db.prepare(
      'INSERT INTO pedidos (id, cliente_id, total, foto, nota, grande) VALUES (?, ?, ?, ?, ?, ?)'
    )
    insert.run(1, 1, 99.95, Buffer.from([0, 255, 16]), LONG, 9007199254740993n)
    for (let i = 2; i <= 150; i++) insert.run(i, 1 + (i % 2), i, null, `n${i}`, i)
    db.close()
    copyFileSync(shop, shopCopy)

    const repo = new ConnectionsRepo(profile)
    repo.save(sqliteInput('Tienda', shop, 'local', { enabled: true, access: 'read' }))
    repo.save(sqliteInput('Solo esquema', shop, 'local', { enabled: true, access: 'structure' }))
    repo.save(sqliteInput('Escritura', shopCopy, 'local', { enabled: true, access: 'write' }))
    repo.save(sqliteInput('Producción', shopCopy, 'production', { enabled: true, access: 'write' }))
    repo.save(sqliteInput('Oculta', shop, 'local', { enabled: false, access: 'write' }))
    repo.save(sqliteInput('Sin ajuste', shop, 'local', undefined))
    repo.save(
      sqliteInput('Perdida', join(dir, 'secreta', 'no-existe.db'), 'local', {
        enabled: true,
        access: 'read'
      })
    )
    new SettingsRepo(profile, dir).update({ mcpEnabled: true })

    setSqliteSpawner(inProcessSpawner())
    setJsonStoreReload(true)
    setJsonStoreReadOnly(true)
    const ctx = createMcpContext({
      profileDir: profile,
      secrets: { codec: plainCodec, codecName: 'plain' },
      home: dir
    })
    runtime = new McpRuntime(ctx)
    const server = createMcpServer(runtime, {
      version: '9.9.9',
      onActivity: (e) => activity.push(e)
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    client = new Client({ name: 'vitest', version: '1.0.0' })
    await client.connect(clientSide)
  })

  afterAll(async () => {
    await client?.close()
    await runtime?.dispose()
    setJsonStoreReadOnly(false)
    setJsonStoreReload(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('initialize gives instructions; tools/list has the seven tools with their hints', async () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'vortaq', version: '9.9.9' })
    expect(client.getInstructions()).toMatch(/list_connections/)
    expect(client.getInstructions()).toMatch(/never see passwords, hosts/)
    const { tools } = await client.listTools()
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(Object.keys(byName).sort()).toEqual([
      'describe_table',
      'execute_sql',
      'explain_query',
      'list_connections',
      'list_databases',
      'list_tables',
      'run_query'
    ])
    for (const name of [
      'list_connections',
      'list_databases',
      'list_tables',
      'describe_table',
      'run_query',
      'explain_query'
    ])
      expect(byName[name].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(byName.execute_sql.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true
    })
    expect(byName.run_query.inputSchema.required).toEqual(
      expect.arrayContaining(['connection', 'sql'])
    )
  })

  it('list_connections shows only enabled connections, without hosts, users or file paths', async () => {
    const text = (await call('list_connections')).content[0].text
    const data = JSON.parse(text)
    const names = data.connections.map((c: { name: string }) => c.name).sort()
    expect(names).toEqual(['Escritura', 'Perdida', 'Producción', 'Solo esquema', 'Tienda'])
    for (const c of data.connections)
      expect(Object.keys(c).sort()).toEqual(
        c.note
          ? ['access', 'engine', 'environment', 'id', 'name', 'note']
          : ['access', 'engine', 'environment', 'id', 'name']
      )
    const prod = data.connections.find((c: { name: string }) => c.name === 'Producción')
    expect(prod).toMatchObject({ environment: 'production', access: 'read' })
    expect(prod.note).toMatch(/solo pueden leer/)
    expect(text).not.toContain(dir)
    expect(text).not.toContain('.db')
  })

  it('a disabled or unknown connection does not exist for the agent', async () => {
    for (const ref of ['Oculta', 'Sin ajuste', 'nada'])
      expect(await refused('list_tables', { connection: ref })).toMatch(/No hay ninguna conexión/)
    const hidden = appRepo().findByName('Oculta')!
    expect(await refused('run_query', { connection: hidden.id, sql: 'SELECT 1' })).toMatch(
      /No hay ninguna conexión/
    )
  })

  it('list_databases, list_tables and describe_table give the structure', async () => {
    expect((await ok('list_databases', { connection: 'Tienda' })).databases).toEqual([
      { name: 'main' }
    ])
    // Optional arguments sent as null (some clients do) mean «not given».
    expect(
      (await ok('list_tables', { connection: 'Tienda', database: null, schema: null })).database
    ).toBe('main')
    const tables = (await ok('list_tables', { connection: 'Solo esquema' })).tables
    expect(tables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'clientes', kind: 'table' }),
        expect.objectContaining({ name: 'pedidos', kind: 'table' }),
        expect.objectContaining({ name: 'resumen', kind: 'view' })
      ])
    )
    const pedidos = await ok('describe_table', { connection: 'Solo esquema', table: 'pedidos' })
    expect(pedidos.primary_key).toEqual(['id'])
    expect(pedidos.columns.map((c: { name: string }) => c.name)).toEqual([
      'id',
      'cliente_id',
      'total',
      'foto',
      'nota',
      'grande'
    ])
    expect(pedidos.columns[1]).toMatchObject({ name: 'cliente_id', nullable: false })
    expect(pedidos.foreign_keys[0]).toMatchObject({
      columns: ['cliente_id'],
      references: { table: 'clientes', columns: ['id'] }
    })
    expect(pedidos.indexes.map((i: { name: string }) => i.name)).toContain('pedidos_cliente')
    // No row values anywhere in a structure answer.
    expect(JSON.stringify(pedidos)).not.toContain('Ana')
  })

  it('run_query returns JSON-safe rows: big integers as text, binary as hex, long text cut', async () => {
    const r = await ok('run_query', {
      connection: 'Tienda',
      sql: 'SELECT id, total, foto, nota, grande FROM pedidos WHERE id = 1'
    })
    expect(r.read_only_session).toBe(true)
    expect(r.columns.map((c: { name: string }) => c.name)).toEqual([
      'id',
      'total',
      'foto',
      'nota',
      'grande'
    ])
    const [id, total, foto, nota, grande] = r.rows[0]
    expect(id).toBe(1)
    expect(total).toBe(99.95)
    expect(foto).toEqual({ type: 'binary', bytes: 3, hex: '00FF10' })
    expect(nota.startsWith('x'.repeat(2000))).toBe(true)
    expect(nota).toMatch(/recortado: 2500 caracteres/)
    expect(grande).toBe('9007199254740993')
    expect(r.truncated).toBe(false)
  })

  it('run_query keeps max_rows (default 100, cap 1000) and says when there are more', async () => {
    const def = await ok('run_query', {
      connection: 'Tienda',
      sql: 'SELECT id FROM pedidos ORDER BY id'
    })
    expect(def.row_count).toBe(100)
    expect(def.truncated).toBe(true)
    expect(def.notes.join(' ')).toMatch(/max_rows/)
    const few = await ok('run_query', {
      connection: 'Tienda',
      sql: 'SELECT id FROM pedidos ORDER BY id',
      max_rows: 5
    })
    expect(few.rows).toEqual([[1], [2], [3], [4], [5]])
    const all = await ok('run_query', {
      connection: 'Tienda',
      sql: 'SELECT id FROM pedidos',
      max_rows: 150
    })
    expect(all.row_count).toBe(150)
    expect(all.truncated).toBe(false)
    const tooMany = await call('run_query', {
      connection: 'Tienda',
      sql: 'SELECT 1',
      max_rows: 5000
    })
    expect(tooMany.isError).toBe(true)
  })

  it('run_query refuses writes and scripts; the structure level refuses queries', async () => {
    for (const sql of [
      'DELETE FROM pedidos',
      'SELECT 1; SELECT 2',
      'UPDATE clientes SET saldo = 0',
      'CREATE TABLE t (a)'
    ]) {
      const message = await refused('run_query', { connection: 'Tienda', sql })
      expect(message).toMatch(/run_query/)
      expect(message).not.toMatch(/export/i)
    }
    expect(
      await refused('run_query', { connection: 'Escritura', sql: 'DELETE FROM pedidos' })
    ).toMatch(/execute_sql/)
    const level = await refused('run_query', { connection: 'Solo esquema', sql: 'SELECT 1' })
    expect(level).toMatch(/«Solo estructura».*run_query necesita «Lectura».*Agentes \(MCP\)/)
    expect(await refused('explain_query', { connection: 'Solo esquema', sql: 'SELECT 1' })).toMatch(
      /Solo estructura/
    )
    const db = new DatabaseSync(shop, { readOnly: true })
    expect(db.prepare('SELECT COUNT(*) AS n FROM pedidos').get()).toEqual({ n: 150 })
    db.close()
  })

  it('explain_query returns the plan of one SELECT', async () => {
    const r = await ok('explain_query', {
      connection: 'Tienda',
      sql: 'SELECT * FROM pedidos WHERE cliente_id = 1'
    })
    expect(r.plan).toMatch(/pedidos_cliente|SEARCH|SCAN/)
    expect(
      await refused('explain_query', { connection: 'Tienda', sql: 'DELETE FROM pedidos' })
    ).toMatch(/una sentencia SELECT/)
  })

  it('execute_sql writes at the write level and is refused at read level and on production', async () => {
    const r = await ok('execute_sql', {
      connection: 'Escritura',
      sql: "INSERT INTO clientes (id, nombre) VALUES (3, 'Eva'); UPDATE clientes SET saldo = 1 WHERE id = 3; SELECT nombre, saldo FROM clientes WHERE id = 3"
    })
    expect(r.autocommit).toBe(true)
    expect(r.statements).toHaveLength(3)
    expect(r.statements[0].affected_rows).toBe(1)
    expect(r.statements[2].result.rows).toEqual([['Eva', 1]])
    expect(
      (
        await ok('run_query', {
          connection: 'Escritura',
          sql: 'SELECT COUNT(*) AS n FROM clientes'
        })
      ).rows
    ).toEqual([[3]])

    expect(
      await refused('execute_sql', { connection: 'Tienda', sql: 'DELETE FROM pedidos' })
    ).toMatch(/«Lectura».*execute_sql necesita «Lectura y escritura»/)
    const prod = await refused('execute_sql', {
      connection: 'Producción',
      sql: 'DELETE FROM clientes'
    })
    expect(prod).toMatch(/producción.*nunca puede escribir/)
    // Producción shares the file with Escritura: nothing was deleted.
    expect(
      (
        await ok('run_query', {
          connection: 'Producción',
          sql: 'SELECT COUNT(*) AS n FROM clientes'
        })
      ).rows
    ).toEqual([[3]])
    const failing = await ok('execute_sql', {
      connection: 'Escritura',
      sql: 'INSERT INTO clientes (id, nombre) VALUES (1, NULL); SELECT 1'
    })
    expect(failing.stopped_at_error).toBe(true)
    expect(failing.statements).toHaveLength(1)
    expect(failing.statements[0].error).toMatch(/NOT NULL|constraint/i)
  })

  it('changes saved in the app apply on the next call (level, availability, global switch)', async () => {
    setAccess('Tienda', { enabled: true, access: 'structure' })
    expect(await refused('run_query', { connection: 'Tienda', sql: 'SELECT 1' })).toMatch(
      /Solo estructura/
    )
    setAccess('Tienda', { enabled: false, access: 'read' })
    expect(await refused('list_tables', { connection: 'Tienda' })).toMatch(
      /No hay ninguna conexión/
    )
    setAccess('Tienda', { enabled: true, access: 'read' })
    expect((await ok('run_query', { connection: 'Tienda', sql: 'SELECT 1 AS uno' })).rows).toEqual([
      [1]
    ])
    // Ajustes › Seguridad adds «local» to the typed-confirmation list: writes stop at once.
    asApp(() =>
      new SettingsRepo(profile, dir).update({ typedConfirmEnvironments: ['production', 'local'] })
    )
    expect(await refused('execute_sql', { connection: 'Escritura', sql: 'SELECT 1' })).toMatch(
      /nunca puede escribir/
    )
    asApp(() => new SettingsRepo(profile, dir).update({ typedConfirmEnvironments: ['production'] }))
    asApp(() => new SettingsRepo(profile, dir).update({ mcpEnabled: false }))
    expect(await refused('list_connections')).toBe(MCP_DISABLED)
    expect(await refused('run_query', { connection: 'Tienda', sql: 'SELECT 1' })).toBe(MCP_DISABLED)
    asApp(() => new SettingsRepo(profile, dir).update({ mcpEnabled: true }))
    expect((await ok('list_connections')).connections.length).toBe(5)
  })

  it('errors never carry file paths', async () => {
    const message = await refused('list_tables', { connection: 'Perdida' })
    expect(message).not.toContain(dir)
    expect(message).not.toContain('no-existe.db')
    expect(message).not.toContain('secreta')
  })

  it('the MCP process never writes the profile files', async () => {
    const before = readFileSync(join(profile, 'connections.json'), 'utf8')
    await ok('list_connections')
    await ok('run_query', { connection: 'Tienda', sql: 'SELECT 1' })
    expect(readFileSync(join(profile, 'connections.json'), 'utf8')).toBe(before)
    expect(() => runtime.ctx.connections.save(sqliteInput('x', shop, 'local', undefined))).toThrow(
      /solo lee/
    )
    expect(() => runtime.ctx.settings.update({ mcpEnabled: false })).toThrow(/solo lee/)
    writeFileSync(join(dir, 'probe'), '')
  })

  it('logs one activity line per call, without SQL text or values', async () => {
    activity.length = 0
    await ok('run_query', {
      connection: 'Tienda',
      sql: "SELECT nombre FROM clientes WHERE nombre = 'Ana'"
    })
    await call('execute_sql', { connection: 'Tienda', sql: 'DELETE FROM pedidos' })
    expect(activity).toHaveLength(2)
    expect(activity[0]).toMatchObject({
      tool: 'run_query',
      connection: 'Tienda',
      access: 'read',
      outcome: 'ok',
      rows: 1
    })
    expect(activity[1]).toMatchObject({ tool: 'execute_sql', outcome: 'refused' })
    for (const e of activity) {
      const line = activityLine(e)
      expect(line).toMatch(/^tool=\w+ connection="Tienda" access=read outcome=\w+ ms=\d+ rows=/)
      expect(line).not.toMatch(/SELECT|DELETE|Ana/)
    }
  })
})
