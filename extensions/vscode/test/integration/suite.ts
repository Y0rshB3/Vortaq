/**
 * Integration suite of the extension, run inside a real VS Code by
 * scripts/test-integration.mjs (@vscode/test-electron). It drives the
 * extension the way a user does (commands, SQL documents, the tree) and
 * plays the webviews' part through the panels' message handlers, so the
 * bridge allowlist, the scope checks and the production guard are the real
 * ones. Servers come from VORTAQ_TEST_*_URL; a missing one skips its tests.
 *
 * No test framework: a small sequential runner with node:assert.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import type { ConnectionInput, QueryStatementResult } from '@core'
import type { VortaqTestApi } from '../../src/extension'
import type { Prompter } from '../../src/host/guard'
import type { ResultsPanel } from '../../src/host/panels/results'

const EXTENSION_ID = 'y0rshb3.vortaq'
const DB = `vortaq_ext_it_${process.pid}`
const CONFIRM = /necesita confirmación explícita/
const scratch = process.env.VORTAQ_EXT_IT_SCRATCH ?? ''

interface Test {
  name: string
  needs?: string
  fn: () => Promise<void>
}

const tests: Test[] = []
const test = (name: string, fn: () => Promise<void>, needs?: string): void => {
  tests.push({ name, fn, needs })
}

let api: VortaqTestApi
const cleanup: (() => Promise<void>)[] = []

/* ---------- helpers ---------- */

async function waitFor<T>(
  what: string,
  fn: () => T | undefined | null | false,
  ms = 20_000
): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** A prompter that answers every typed-name prompt with `typed` and records the prompts. */
function answering(typed: string | undefined): Prompter & { prompts: string[] } {
  const prompts: string[] = []
  return {
    prompts,
    async typedName({ prompt }) {
      prompts.push(prompt)
      return typed
    },
    async confirm() {
      return true
    }
  }
}

function urlParts(raw: string): {
  host: string
  port: number
  user: string
  password: string
  database: string
} {
  const url = new URL(raw)
  return {
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, '')
  }
}

function input(overrides: Partial<ConnectionInput>): ConnectionInput {
  return {
    name: 'IT',
    color: null,
    environment: 'local',
    host: '',
    port: 0,
    username: '',
    authMode: 'password',
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

async function saveConnection(value: ConnectionInput, password?: string): Promise<string> {
  const saved = await api.core.invoke('connections:save', value)
  if (password) await api.core.invoke('connections:setPassword', saved.id, password)
  cleanup.push(async () => {
    await api.connections.remove(saved.id).catch(() => undefined)
  })
  return saved.id
}

const ok = (results: QueryStatementResult[]): QueryStatementResult[] => {
  const failed = results.find((r) => r.error)
  if (failed) throw new Error(`${failed.sql}: ${failed.error}`)
  return results
}

/** Opens `sql` as a .sql file of the scratch workspace, bound to a connection. */
async function sqlDocument(
  name: string,
  sql: string,
  target: { connectionId: string; database: string | null; schema?: string | null }
): Promise<vscode.TextEditor> {
  const dir = join(scratch, 'workspace')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}-${process.pid}.sql`)
  writeFileSync(file, sql)
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  assert.equal(doc.languageId, 'sql')
  const editor = await vscode.window.showTextDocument(doc)
  await api.targets.set(doc.uri.toString(), target)
  return editor
}

function placeCursor(editor: vscode.TextEditor, needle: string): void {
  const offset = editor.document.getText().indexOf(needle)
  assert.ok(offset >= 0, `${needle} not in the document`)
  const position = editor.document.positionAt(offset)
  editor.selection = new vscode.Selection(position, position)
}

async function runAndWait(
  editor: vscode.TextEditor,
  command = 'vortaq.run'
): Promise<ResultsPanel> {
  const key = `doc:${editor.document.uri.toString()}`
  const before = api.results.get(key)?.state.runId ?? 0
  await vscode.window.showTextDocument(editor.document)
  await vscode.commands.executeCommand(command)
  return waitFor(`results of ${key}`, () => {
    const panel = api.results.get(key)
    return panel && panel.state.runId !== before && !panel.state.running ? panel : null
  })
}

/** Plays the results webview: sends an invoke and resolves the host's answer. */
async function webviewInvoke(
  panel: {
    receive(raw: unknown): Promise<void>
    onDidPost(l: (m: unknown) => void): { dispose(): void }
  },
  channel: string,
  args: unknown[]
): Promise<{ ok: boolean; value?: unknown; message?: string }> {
  const id = Math.floor(Math.random() * 1e9)
  let answer: { ok: boolean; value?: unknown; message?: string } | null = null
  const sub = panel.onDidPost((m) => {
    const message = m as { type: string; id?: number }
    if (message.type === 'result' && message.id === id) answer = message as never
  })
  try {
    await panel.receive({ type: 'invoke', id, channel, args })
    return await waitFor(`answer to ${channel}`, () => answer)
  } finally {
    sub.dispose()
  }
}

/* ---------- activation ---------- */

test('activates and answers the core channels without Electron', async () => {
  const channels = api.core.channels()
  assert.ok(channels.includes('db:execute'))
  assert.ok(!channels.some((c) => c.startsWith('app:') || c.startsWith('jobs:')))
  const loaded = Object.keys(require.cache).some((p) =>
    /[\\/]node_modules[\\/]electron[\\/]/.test(p)
  )
  assert.equal(loaded, false)
  const tree = await api.tree.getChildren()
  assert.ok(Array.isArray(tree))
})

test('imports the desktop connections without passwords', async () => {
  const preview = api.readDesktopImport()
  assert.deepEqual(
    preview.connections.map((c) => c.name),
    ['Analítica (producción)', 'Eventos', 'Notas', 'Tienda local']
  )
  const tienda = preview.connections.find((c) => c.name === 'Tienda local')!
  const count = await api.importConnections([tienda])
  assert.equal(count, 1)
  const imported = (await api.connections.list()).find((c) => c.name === 'Tienda local')!
  cleanup.push(() => api.connections.remove(imported.id))
  assert.equal(await api.core.invoke('connections:hasPassword', imported.id), false)
  assert.equal(imported.backupDir, '')
})

/* ---------- MySQL ---------- */

let mysqlId = ''
let mysqlProdId = ''

test(
  'adds a MySQL connection through the connection form',
  async () => {
    const url = urlParts(process.env.VORTAQ_TEST_MYSQL_URL!)
    const form = api.openConnectionForm(null)
    try {
      const value = input({
        name: `IT MySQL ${process.pid}`,
        engine: 'mysql',
        host: url.host,
        port: url.port,
        username: url.user
      })
      const tested = await webviewInvoke(form, 'connections:test', [value, url.password, null])
      assert.equal((tested.value as { ok: boolean }).ok, true, tested.message)
      const saved = await webviewInvoke(form, 'connections:save', [value])
      assert.ok(saved.ok, saved.message)
      mysqlId = (saved.value as { id: string }).id
      cleanup.push(() => api.connections.remove(mysqlId))
      const pw = await webviewInvoke(form, 'connections:setPassword', [mysqlId, url.password])
      assert.ok(pw.ok, pw.message)
      // The form cannot touch another connection, nor call channels it was not given.
      const other = await webviewInvoke(form, 'connections:setPassword', ['some-other-id', 'x'])
      assert.equal(other.ok, false)
      const denied = await webviewInvoke(form, 'db:execute', [mysqlId, 'SELECT 1'])
      assert.equal(denied.ok, false)
      // The password is stored encrypted with the vault key, never in clear text.
      const raw = api.core.context.credentials.rawItems()
      assert.ok(Object.values(raw).every((v) => v.startsWith('v1:') && !v.includes(url.password)))
    } finally {
      form.dispose()
    }
    const roots = await api.tree.getChildren()
    assert.ok(roots.some((n) => n.kind === 'connection' && n.connectionId === mysqlId))
    ok(
      await api.core.invoke(
        'db:execute',
        mysqlId,
        `DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB};
         CREATE TABLE ${DB}.item (id INT PRIMARY KEY, name VARCHAR(40), note VARCHAR(40) NULL);
         INSERT INTO ${DB}.item VALUES (1, 'uno', NULL), (2, 'dos', 'x');`
      )
    )
    cleanup.push(async () => {
      await api.core
        .invoke('db:execute', mysqlId, `DROP DATABASE IF EXISTS ${DB}`)
        .catch(() => undefined)
    })
  },
  'VORTAQ_TEST_MYSQL_URL'
)

test(
  'the tree lists the database and its tables',
  async () => {
    const connection = api.tree.connectionNode(mysqlId)
    const databases = await api.tree.getChildren(connection)
    const db = databases.find((n) => n.kind === 'database' && n.database === DB)
    assert.ok(db, 'database node')
    const groups = await api.tree.getChildren(db)
    const tables = await api.tree.getChildren(
      groups.find((g) => g.kind === 'group' && g.group === 'tables')
    )
    assert.deepEqual(
      tables.map((t) => ('name' in t ? t.name : '')),
      ['item']
    )
  },
  'VORTAQ_TEST_MYSQL_URL'
)

test(
  'runs the statement under the cursor of a .sql document',
  async () => {
    const editor = await sqlDocument(
      'mysql',
      `SELECT 1 AS uno;\nSELECT id, name, note FROM item ORDER BY id;\n`,
      {
        connectionId: mysqlId,
        database: DB
      }
    )
    placeCursor(editor, 'FROM item')
    const panel = await runAndWait(editor)
    assert.equal(panel.state.notice, null)
    assert.equal(panel.state.results.length, 1)
    assert.deepEqual(panel.state.results[0].resultSet?.rows, [
      [1, 'uno', null],
      [2, 'dos', 'x']
    ])
    // «Ejecutar todo» runs both statements.
    const all = await runAndWait(editor, 'vortaq.runAll')
    assert.equal(all.state.results.length, 2)
  },
  'VORTAQ_TEST_MYSQL_URL'
)

test(
  'edits a cell of an editable result and applies it',
  async () => {
    const editor = await sqlDocument('mysql-edit', `SELECT * FROM item ORDER BY id;`, {
      connectionId: mysqlId,
      database: DB
    })
    const panel = await runAndWait(editor)
    const structure = await webviewInvoke(panel, 'db:tableStructure', [mysqlId, DB, 'item'])
    assert.ok(structure.ok, structure.message)
    const applied = await webviewInvoke(panel, 'db:applyRowChanges', [
      mysqlId,
      DB,
      'item',
      [{ kind: 'update', key: { id: 1 }, values: { name: 'cambiado', note: 'nota' } }],
      { confirmProduction: true }
    ])
    assert.ok(applied.ok, applied.message)
    const [r] = ok(
      await api.core.invoke('db:execute', mysqlId, `SELECT name, note FROM ${DB}.item WHERE id = 1`)
    )
    assert.deepEqual(r.resultSet?.rows, [['cambiado', 'nota']])
    // The panel may only reach its own connection.
    const elsewhere = await webviewInvoke(panel, 'db:tableStructure', ['other', DB, 'item'])
    assert.equal(elsewhere.ok, false)
  },
  'VORTAQ_TEST_MYSQL_URL'
)

test(
  'refuses an unconfirmed write on a production connection',
  async () => {
    const url = urlParts(process.env.VORTAQ_TEST_MYSQL_URL!)
    const name = `IT MySQL prod ${process.pid}`
    mysqlProdId = await saveConnection(
      input({
        name,
        environment: 'production',
        engine: 'mysql',
        host: url.host,
        port: url.port,
        username: url.user
      }),
      url.password
    )
    const current = async (): Promise<unknown> =>
      ok(
        await api.core.invoke('db:execute', mysqlId, `SELECT name FROM ${DB}.item WHERE id = 2`)
      )[0].resultSet?.rows
    // 1. The core refuses an unconfirmed write by itself (main-side guard).
    await assert.rejects(
      api.core.invoke(
        'db:execute',
        mysqlProdId,
        `UPDATE ${DB}.item SET name = 'nunca' WHERE id = 2`
      ),
      CONFIRM
    )
    // 2. From an editor: the user dismisses the typed-name prompt → nothing is sent.
    const cancel = answering(undefined)
    api.setPrompter(cancel)
    const editor = await sqlDocument('prod', `UPDATE item SET name = 'nunca' WHERE id = 2;`, {
      connectionId: mysqlProdId,
      database: DB
    })
    await vscode.commands.executeCommand('vortaq.run')
    await waitFor('typed-name prompt', () => cancel.prompts.length > 0)
    assert.match(cancel.prompts[0], new RegExp(`«${name}» es una conexión de producción`))
    assert.deepEqual(await current(), [['dos']])
    // 3. A webview claiming confirmProduction gets it stripped and the host asks: cancelled → refused.
    const select = await sqlDocument('prod-select', `SELECT * FROM item ORDER BY id;`, {
      connectionId: mysqlProdId,
      database: DB
    })
    const panel = await runAndWait(select)
    const forged = await webviewInvoke(panel, 'db:applyRowChanges', [
      mysqlProdId,
      DB,
      'item',
      [{ kind: 'update', key: { id: 2 }, values: { name: 'nunca' } }],
      { confirmProduction: true }
    ])
    assert.equal(forged.ok, false)
    assert.match(forged.message ?? '', /hay que confirmar escribiendo el nombre/)
    assert.equal(cancel.prompts.length, 2)
    assert.deepEqual(await current(), [['dos']])
    // 4. Typing the name lets the same write through.
    api.setPrompter(answering(name))
    const confirmed = await webviewInvoke(panel, 'db:applyRowChanges', [
      mysqlProdId,
      DB,
      'item',
      [{ kind: 'update', key: { id: 2 }, values: { name: 'confirmado' } }]
    ])
    assert.ok(confirmed.ok, confirmed.message)
    assert.deepEqual(await current(), [['confirmado']])
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    void editor
  },
  'VORTAQ_TEST_MYSQL_URL'
)

/* ---------- PostgreSQL ---------- */

test(
  'runs a PostgreSQL query from a .sql document',
  async () => {
    const url = urlParts(process.env.VORTAQ_TEST_PG_URL!)
    const id = await saveConnection(
      input({
        name: `IT PostgreSQL ${process.pid}`,
        engine: 'postgresql',
        host: url.host,
        port: url.port,
        username: url.user,
        postgres: {
          initialDatabase: url.database,
          showSystemSchemas: false,
          timeZone: '',
          searchPath: ''
        }
      }),
      url.password
    )
    const editor = await sqlDocument(
      'pg',
      `SELECT current_database() AS db, current_schema() AS s, 2 + 2 AS four;`,
      {
        connectionId: id,
        database: url.database,
        schema: 'public'
      }
    )
    const panel = await runAndWait(editor)
    assert.equal(panel.state.notice, null)
    assert.deepEqual(panel.state.results[0].resultSet?.rows, [[url.database, 'public', 4]])
    const schemas = await api.tree.getChildren({
      kind: 'database',
      connectionId: id,
      database: url.database
    })
    assert.ok(schemas.some((n) => n.kind === 'schema' && n.schema === 'public'))
  },
  'VORTAQ_TEST_PG_URL'
)

/* ---------- MongoDB ---------- */

test(
  'lists the documents of a MongoDB collection',
  async () => {
    const raw = new URL(process.env.VORTAQ_TEST_MONGO_URL!)
    const id = await saveConnection(
      input({
        name: `IT MongoDB ${process.pid}`,
        engine: 'mongodb',
        host: raw.hostname,
        port: Number(raw.port),
        username: decodeURIComponent(raw.username),
        mongo: {
          topology: 'standalone',
          srv: false,
          members: [],
          replicaSet: '',
          authMechanism: 'default',
          authSource: raw.searchParams.get('authSource') ?? 'admin',
          defaultDatabase: DB,
          readPreference: 'primary',
          directConnection: true,
          retryWrites: true,
          retryReads: true,
          extraOptions: {}
        }
      }),
      decodeURIComponent(raw.password)
    )
    await api.connections.open(id)
    const inserted = await api.core.invoke(
      'mongo:execute',
      id,
      "db.item.insertMany([{ _id: 1, name: 'uno', big: NumberLong('9007199254740993') }, { _id: 2, name: 'dos' }])",
      { database: DB }
    )
    assert.equal(inserted[0].kind, 'write', inserted[0].error)
    cleanup.push(async () => {
      await api.core
        .invoke('mongo:execute', id, 'db.dropDatabase()', { database: DB, confirmProduction: true })
        .catch(() => undefined)
    })
    const groups = await api.tree.getChildren({ kind: 'database', connectionId: id, database: DB })
    const collections = await api.tree.getChildren(
      groups.find((g) => g.kind === 'group' && g.group === 'collections')
    )
    const node = collections.find((n) => n.kind === 'collection' && n.name === 'item')
    assert.ok(node, 'collection node')
    await vscode.commands.executeCommand('vortaq.viewDocuments', node)
    const panel = await waitFor('documents', () => {
      const p = api.results.get(`docs:${id}:${DB}:item`)
      return p && !p.state.running ? p : null
    })
    assert.equal(panel.state.kind, 'documents')
    assert.equal(panel.state.notice, null)
    assert.deepEqual(panel.state.documents?.docs, [
      '{"_id":{"$numberInt":"1"},"name":"uno","big":{"$numberLong":"9007199254740993"}}',
      '{"_id":{"$numberInt":"2"},"name":"dos"}'
    ])
  },
  'VORTAQ_TEST_MONGO_URL'
)

/* ---------- SQLite ---------- */

test('runs a query on a SQLite file (or says why SQLite is unavailable)', async () => {
  const file = join(scratch, `it-${process.pid}.db`)
  if (api.sqliteProblem) {
    // Old Node in this editor: SQLite is hidden and its connections explain why.
    const id = await saveConnection(
      input({
        name: 'IT SQLite',
        engine: 'sqlite',
        authMode: 'none',
        sqlite: {
          filePath: file,
          readOnly: false,
          foreignKeys: false,
          attached: [],
          busyTimeoutMs: 5000
        }
      })
    )
    await assert.rejects(
      api.connections.open(id),
      (err: Error) => err.message === api.sqliteProblem
    )
    return
  }
  await api.core.invoke('sqlite:createFile', file)
  const id = await saveConnection(
    input({
      name: `IT SQLite ${process.pid}`,
      engine: 'sqlite',
      authMode: 'none',
      sqlite: {
        filePath: file,
        readOnly: false,
        foreignKeys: true,
        attached: [],
        busyTimeoutMs: 5000
      }
    })
  )
  const editor = await sqlDocument(
    'sqlite',
    `CREATE TABLE nota (id INTEGER PRIMARY KEY, texto TEXT);\nINSERT INTO nota (texto) VALUES ('hola');\nSELECT id, texto, typeof(id) AS t FROM nota;\n`,
    { connectionId: id, database: 'main' }
  )
  const panel = await runAndWait(editor, 'vortaq.runAll')
  assert.equal(panel.state.notice, null)
  const last = panel.state.results[panel.state.results.length - 1]
  assert.deepEqual(last.resultSet?.rows, [[1, 'hola', 'integer']])
  await api.runner.closeSession(editor.document.uri.toString())
})

/* ---------- runner ---------- */

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<VortaqTestApi>(EXTENSION_ID)
  assert.ok(extension, `${EXTENSION_ID} is not loaded`)
  api = await extension.activate()
  assert.ok(api, 'the test API is only returned in ExtensionMode.Test')
  const failures: string[] = []
  let passed = 0
  let skipped = 0
  for (const t of tests) {
    if (t.needs && !process.env[t.needs]) {
      skipped++
      console.log(`  - ${t.name} (sin ${t.needs})`)
      continue
    }
    const started = Date.now()
    try {
      await t.fn()
      passed++
      console.log(`  ✓ ${t.name} (${Date.now() - started} ms)`)
    } catch (err) {
      failures.push(`${t.name}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      console.log(`  ✗ ${t.name}`)
    } finally {
      api.setPrompter(null)
    }
  }
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined)
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  console.log(`\n  ${passed} passed, ${failures.length} failed, ${skipped} skipped`)
  if (failures.length)
    throw new Error(`Vortaq extension integration tests failed:\n\n${failures.join('\n\n')}`)
}
