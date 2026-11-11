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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import * as vscode from 'vscode'
import type { ConnectionInput, ProgressEvent, QueryStatementResult } from '@core'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { setJsonStoreReload } from '@main/storage/jsonStore'
import { ConnectionsRepo } from '@main/storage/repos'
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

/**
 * «Exportar» as the webview's ExportDialog plays it: app:pickSaveFile (the save dialog
 * answers `file`), then `channel` with the chosen path. Returns the answer and the
 * event:progress messages the panel posted meanwhile.
 */
async function exportFrom(
  panel: ResultsPanel,
  file: string,
  channel: 'export:rows' | 'export:query',
  args: (file: string) => unknown[]
): Promise<{
  answer: { ok: boolean; value?: unknown; message?: string }
  events: ProgressEvent[]
}> {
  const operations = api.results.operations
  const original = operations.showSaveDialog
  const asked: vscode.SaveDialogOptions[] = []
  operations.showSaveDialog = async (options) => {
    asked.push(options)
    return vscode.Uri.file(file)
  }
  const events: ProgressEvent[] = []
  const sub = panel.onDidPost((m) => {
    const message = m as { type: string; channel?: string; payload?: ProgressEvent }
    if (message.type === 'event' && message.channel === 'event:progress')
      events.push(message.payload!)
  })
  try {
    const name = file.split(/[\\/]/).pop()!
    const picked = await webviewInvoke(panel, 'app:pickSaveFile', ['Exportar resultado', name, []])
    assert.ok(picked.ok, picked.message)
    assert.equal(picked.value, file)
    assert.equal(asked[0].defaultUri?.path.split('/').pop(), name)
    return { answer: await webviewInvoke(panel, channel, args(file)), events }
  } finally {
    sub.dispose()
    operations.showSaveDialog = original
  }
}

/** A scratch folder for exported files. */
function exportDir(): string {
  const dir = join(scratch, 'exports')
  mkdirSync(dir, { recursive: true })
  return mkdtempSync(join(dir, 'run-'))
}

const noParts = (dir: string): void =>
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith('.part')),
    []
  )

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
    ['Analítica (producción)', 'Eventos', 'Notas', 'Tienda local', 'Ventas (SQL Server)']
  )
  const tienda = preview.connections.find((c) => c.name === 'Tienda local')!
  const count = await api.importConnections([tienda])
  assert.equal(count, 1)
  const imported = (await api.connections.list()).find((c) => c.name === 'Tienda local')!
  cleanup.push(() => api.connections.remove(imported.id))
  assert.equal(await api.core.invoke('connections:hasPassword', imported.id), false)
  // The desktop app's backup folder stays there; the extension's profile gives the connection its
  // own default one (2.9.1: an empty folder reads as <profile>/backups/<name>).
  assert.equal(imported.backupDir, join(api.core.context.userDataPath, 'backups', 'Tienda local'))
})

test('keeps the connections another editor window saves on the same profile', async () => {
  // Every editor window runs its own extension host and core on the same globalStorage folder.
  // A second store over the same files plays the other window (its own module copy).
  setJsonStoreReload(true)
  const other = new ConnectionsRepo(api.core.context.userDataPath)
  const fromOther = other.save(
    input({
      name: `IT otra ventana ${process.pid}`,
      engine: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      username: 'root'
    })
  )
  cleanup.push(() => api.connections.remove(fromOther.id))
  assert.ok((await api.core.invoke('connections:list')).some((c) => c.id === fromOther.id))
  const roots = await api.tree.getChildren()
  assert.ok(roots.some((n) => n.kind === 'connection' && n.connectionId === fromOther.id))
  // This window saves one, then the other window writes again: neither is lost.
  const here = await api.core.invoke(
    'connections:save',
    input({
      name: `IT esta ventana ${process.pid}`,
      engine: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      username: 'root'
    })
  )
  cleanup.push(() => api.connections.remove(here.id))
  other.save({ ...fromOther, name: `${fromOther.name} (editada)` })
  const names = (await api.core.invoke('connections:list')).map((c) => c.name)
  assert.ok(names.includes(`IT esta ventana ${process.pid}`))
  assert.ok(names.includes(`IT otra ventana ${process.pid} (editada)`))
  // A password saved here survives a credential write of the other window.
  await api.core.invoke('connections:setPassword', here.id, 'secreta')
  new CredentialStore(api.core.context.userDataPath, plainCodec, 'vaultKey').set(
    'ssh',
    fromOther.id,
    null
  )
  assert.equal(await api.core.invoke('connections:hasPassword', here.id), true)
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

test(
  'exports a result from the results panel: rows, then the full result read-only on production',
  async () => {
    // Reading never asks for the connection name: a prompt would fail the test.
    const prompter = answering(undefined)
    api.setPrompter(prompter)
    const editor = await sqlDocument('export', `SELECT id, name FROM item ORDER BY id;`, {
      connectionId: mysqlProdId,
      database: DB
    })
    const panel = await runAndWait(editor)
    const dir = exportDir()
    const csv = join(dir, 'item.csv')
    const rowsRequest = (filePath: string) => ({
      filePath,
      columns: [{ name: 'id' }, { name: 'name' }],
      rows: [[2, 'confirmado']],
      options: { format: 'csv' }
    })
    // Without a file chosen in this panel's save dialog nothing is written.
    const unchosen = await webviewInvoke(panel, 'export:rows', [rowsRequest(csv)])
    assert.equal(unchosen.ok, false)
    assert.equal(existsSync(csv), false)
    const rows = await exportFrom(panel, csv, 'export:rows', (f) => [rowsRequest(f)])
    assert.ok(rows.answer.ok, rows.answer.message)
    assert.equal(readFileSync(csv, 'utf8'), 'id,name\r\n2,confirmado\r\n')

    const xlsx = join(dir, 'item.xlsx')
    const operationId = `export-it-${process.pid}`
    const full = await exportFrom(panel, xlsx, 'export:query', (f) => [
      operationId,
      {
        connectionId: mysqlProdId,
        filePath: f,
        source: { kind: 'statement', sql: 'SELECT id, name FROM item ORDER BY id', context: DB },
        options: { format: 'xlsx', sheetName: 'item' }
      }
    ])
    assert.ok(full.answer.ok, full.answer.message)
    assert.equal((full.answer.value as { rows: number }).rows, 2)
    assert.equal(readFileSync(xlsx).subarray(0, 2).toString(), 'PK')
    assert.ok(full.events.length > 0, 'progress events reach the panel')
    assert.ok(full.events.every((e) => e.operationId === operationId && e.kind === 'export'))
    assert.equal(full.events[full.events.length - 1].done, true)
    assert.deepEqual(prompter.prompts, [])
    noParts(dir)

    // Another connection, and a statement that may write, are refused; no file appears.
    const other = await exportFrom(panel, join(dir, 'otra.csv'), 'export:query', (f) => [
      `${operationId}-b`,
      {
        connectionId: mysqlId,
        filePath: f,
        source: { kind: 'statement', sql: 'SELECT 1' },
        options: { format: 'csv' }
      }
    ])
    assert.equal(other.answer.ok, false)
    const write = await exportFrom(panel, join(dir, 'nunca.csv'), 'export:query', (f) => [
      `${operationId}-c`,
      {
        connectionId: mysqlProdId,
        filePath: f,
        source: { kind: 'statement', sql: `SELECT * FROM item FOR UPDATE` },
        options: { format: 'csv' }
      }
    ])
    assert.equal(write.answer.ok, false)
    assert.match(write.answer.message ?? '', /solo lectura/)
    assert.deepEqual(readdirSync(dir).sort(), ['item.csv', 'item.xlsx'])
  },
  'VORTAQ_TEST_MYSQL_URL'
)

test(
  '«Ver datos»: «Resultado completo» exports the whole table, not the first rows',
  async () => {
    const config = vscode.workspace.getConfiguration('vortaq')
    await config.update('maxRows', 1, vscode.ConfigurationTarget.Global)
    try {
      const node = { kind: 'table' as const, connectionId: mysqlId, database: DB, name: 'item' }
      // The setting reaches the runner through a configuration event.
      let sql = ''
      for (const started = Date.now(); !sql;) {
        const out = await api.runner.viewData(node)
        if (out?.[0]?.resultSet?.rows.length === 1) sql = out[0].sql
        else if (Date.now() - started > 20_000) throw new Error('«Ver datos» never showed one row')
        else await new Promise((r) => setTimeout(r, 200))
      }
      const panel = api.results.get(`data:${mysqlId}:${DB}:item`)!
      const dir = exportDir()
      const csv = join(dir, 'item.csv')
      const full = await exportFrom(panel, csv, 'export:query', (f) => [
        `export-data-${process.pid}`,
        {
          connectionId: mysqlId,
          filePath: f,
          source: { kind: 'statement', sql, context: DB },
          options: { format: 'csv' }
        }
      ])
      assert.ok(full.answer.ok, full.answer.message)
      assert.equal((full.answer.value as { rows: number }).rows, 2)
      assert.equal(readFileSync(csv, 'utf8').trimEnd().split('\r\n').length, 3)
    } finally {
      await config.update('maxRows', undefined, vscode.ConfigurationTarget.Global)
    }
  },
  'VORTAQ_TEST_MYSQL_URL'
)

test(
  'autocompletes the target database’s tables and columns, and formats the document',
  async () => {
    if (!api.connections.isOpen(mysqlId)) await api.connections.open(mysqlId)
    const editor = await sqlDocument('completion', 'select i. from item i', {
      connectionId: mysqlId,
      database: DB
    })
    const uri = editor.document.uri
    // Columns of the alias, read from the server through the core.
    const columns = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      uri,
      new vscode.Position(0, 'select i.'.length)
    )
    const labels = columns.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label))
    for (const column of ['id', 'name', 'note'])
      assert.ok(labels.includes(column), labels.join(','))
    // Tables after FROM.
    await editor.edit((b) =>
      b.replace(
        new vscode.Range(0, 0, 0, editor.document.lineAt(0).text.length),
        'select * from it'
      )
    )
    const tables = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      uri,
      new vscode.Position(0, 'select * from it'.length)
    )
    assert.ok(
      tables.items.some((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'item')
    )
    // «Dar formato al documento»: MySQL grammar, upper-case keywords.
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      'vscode.executeFormatDocumentProvider',
      uri,
      { tabSize: 2, insertSpaces: true }
    )
    assert.ok(edits?.length)
    // VS Code turns the replacement into minimal edits: apply them and read the document.
    const change = new vscode.WorkspaceEdit()
    change.set(uri, edits)
    assert.ok(await vscode.workspace.applyEdit(change))
    assert.equal(editor.document.getText(), 'SELECT\n\t*\nFROM\n\tit')
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
  },
  'VORTAQ_TEST_MYSQL_URL'
)

test(
  'the query history keeps the documents’ runs, without results or error texts',
  async () => {
    const entries = api.history.list().filter((e) => e.connectionId === mysqlId)
    assert.ok(entries.length > 0, 'no MySQL run in the history')
    for (const e of entries) {
      assert.equal(e.connectionName, `IT MySQL ${process.pid}`)
      assert.ok(!('error' in e) && !('results' in e))
    }
  },
  'VORTAQ_TEST_MYSQL_URL'
)

test(
  '«Seleccionar las primeras 1000 filas» runs at once; «Script como CREATE» opens the DDL',
  async () => {
    const node = { kind: 'table' as const, connectionId: mysqlId, database: DB, name: 'item' }
    await vscode.commands.executeCommand('vortaq.scriptCreate', node)
    const ddl = vscode.window.activeTextEditor!.document
    assert.match(ddl.getText(), /^CREATE TABLE `item`/)
    assert.deepEqual(api.targets.get(ddl.uri.toString()), { connectionId: mysqlId, database: DB })
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')

    await vscode.commands.executeCommand('vortaq.selectTop', node)
    const doc = vscode.window.activeTextEditor!.document
    assert.match(doc.getText(), /LIMIT 1000/)
    // selectTop awaits the run: the panel already holds the rows.
    const panel = api.results.get(`doc:${doc.uri.toString()}`)!
    assert.equal(panel.state.running, false)
    assert.equal(panel.state.results[0]?.resultSet?.rows.length, 2)
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
  },
  'VORTAQ_TEST_MYSQL_URL'
)

test(
  '«Plan de ejecución» of the statement under the cursor, in the results panel',
  async () => {
    const editor = await sqlDocument(
      'plan',
      'SELECT 1;\nSELECT i.name FROM item i WHERE i.id = 2;\n',
      { connectionId: mysqlId, database: DB }
    )
    editor.selection = new vscode.Selection(1, 5, 1, 5)
    const estimated = await api.runner.plan(editor, false)
    assert.ok(estimated)
    assert.equal(estimated.actual, false)
    assert.equal(estimated.rawFormat, 'text')
    const panel = api.results.get(`doc:${editor.document.uri.toString()}`)!
    assert.equal(panel.state.plan?.root.operation, estimated.root.operation)
    const actual = await api.runner.plan(editor, true)
    assert.equal(actual?.actual, true)
    assert.equal(panel.state.planId, 2)
    // An UPDATE has an estimated plan only; the actual one is refused.
    await editor.edit((b) =>
      b.replace(new vscode.Range(1, 0, 1, 200), "UPDATE item SET name = 'x' WHERE id = 2;")
    )
    editor.selection = new vscode.Selection(1, 3, 1, 3)
    await assert.rejects(api.runner.plan(editor, true), /solo lectura/)
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
  },
  'VORTAQ_TEST_MYSQL_URL'
)

/* ---------- Agents (MCP): the server inside the editor ---------- */

interface McpAnswer {
  status: number
  json: { result?: { content: { text: string }[]; isError?: boolean } } | null
}

function mcpPost(url: string, key: string, body: unknown): Promise<McpAnswer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
        })
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

const callTool = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: Date.now(),
  method: 'tools/call',
  params: { name, arguments: args }
})

test(
  '«Agentes (MCP)»: the editor serves only the connections made available, until it is turned off',
  async () => {
    const config = vscode.workspace.getConfiguration('vortaq')
    const port = 47000 + (process.pid % 1000)
    await api.core.invoke('connections:setMcp', mysqlId, { enabled: true, access: 'read' })
    // Write is refused where the typed name applies (production).
    await assert.rejects(
      api.core.invoke('connections:setMcp', mysqlProdId, { enabled: true, access: 'write' }),
      /Lectura y escritura/
    )
    await config.update('mcp.port', port, vscode.ConfigurationTarget.Global)
    await config.update('mcp.enabled', true, vscode.ConfigurationTarget.Global)
    try {
      await waitFor('the MCP server', () => api.mcp.current.kind === 'serving')
      const endpoint = api.mcp.endpoint()!
      assert.equal(endpoint.url, `http://127.0.0.1:${port}/mcp`)
      const listed = await mcpPost(endpoint.url, endpoint.key, callTool('list_connections', {}))
      assert.equal(listed.status, 200)
      const names = JSON.parse(listed.json!.result!.content[0].text).connections.map(
        (c: { name: string }) => c.name
      )
      assert.deepEqual(names, [`IT MySQL ${process.pid}`])
      const rows = await mcpPost(
        endpoint.url,
        endpoint.key,
        callTool('run_query', {
          connection: `IT MySQL ${process.pid}`,
          database: DB,
          sql: 'SELECT name FROM item ORDER BY id'
        })
      )
      assert.equal(rows.json!.result!.isError ?? false, false, rows.json!.result!.content[0].text)
      // Earlier tests edited the names: two rows of one text column, whatever they say now.
      const values = JSON.parse(rows.json!.result!.content[0].text).rows as unknown[][]
      assert.equal(values.length, 2)
      assert.ok(values.every((r) => r.length === 1 && typeof r[0] === 'string'))
      // The read level never writes, and the answer says where to change it.
      const write = await mcpPost(
        endpoint.url,
        endpoint.key,
        callTool('execute_sql', {
          connection: `IT MySQL ${process.pid}`,
          database: DB,
          sql: "UPDATE item SET name = 'x'"
        })
      )
      assert.equal(write.json!.result!.isError, true)
      assert.match(write.json!.result!.content[0].text, /Vortaq: Agentes \(MCP\)…/)
      // Without the key nothing answers.
      assert.equal(
        (await mcpPost(endpoint.url, 'otra', callTool('list_connections', {}))).status,
        401
      )
      // The agents' session is not the user's: the tree's connection stays as it was.
      await config.update('mcp.enabled', false, vscode.ConfigurationTarget.Global)
      await waitFor('the MCP server to stop', () => api.mcp.current.kind === 'off')
      await assert.rejects(mcpPost(endpoint.url, endpoint.key, callTool('list_connections', {})))
    } finally {
      await config.update('mcp.enabled', undefined, vscode.ConfigurationTarget.Global)
      await config.update('mcp.port', undefined, vscode.ConfigurationTarget.Global)
      await api.core.invoke('connections:setMcp', mysqlId, { enabled: false, access: 'read' })
    }
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

/* ---------- SQL Server ---------- */

test(
  'runs a SQL Server batch from a .sql document, with exact decimals and dates',
  async () => {
    const url = urlParts(process.env.VORTAQ_TEST_MSSQL_URL!)
    const id = await saveConnection(
      input({
        name: `IT SQL Server ${process.pid}`,
        engine: 'sqlserver',
        host: url.host,
        port: url.port,
        username: url.user,
        ssl: { enabled: true, verifyServer: false },
        network: { connectTimeoutMs: 15000, keepAliveSec: 60 },
        sqlserver: {
          initialDatabase: 'master',
          auth: 'sql',
          domain: '',
          instanceName: '',
          encrypt: 'mandatory',
          trustServerCertificate: true,
          hostNameInCertificate: '',
          tenantId: '',
          clientId: '',
          showSystemObjects: false,
          readOnlyIntent: false
        }
      }),
      url.password
    )
    const editor = await sqlDocument(
      'mssql',
      [
        'DECLARE @n int = 2',
        "SELECT DB_NAME() AS db, CAST(12.50 AS decimal(10,2)) AS d, CAST('2026-01-02 03:04:05.1234567' AS datetime2(7)) AS t, @n + 2 AS four",
        'GO',
        'SELECT 1 AS second_batch'
      ].join('\n'),
      { connectionId: id, database: 'master', schema: 'dbo' }
    )
    const panel = await runAndWait(editor)
    assert.equal(panel.state.notice, null)
    // The cursor is in the first batch: it runs whole (DECLARE's row count comes first).
    const sets = panel.state.results.filter((r) => r.resultSet).map((r) => r.resultSet!.rows)
    assert.deepEqual(sets, [[['master', '12.50', '2026-01-02 03:04:05.1234567', 4]]])
    const schemas = await api.tree.getChildren({
      kind: 'database',
      connectionId: id,
      database: 'master'
    })
    assert.ok(schemas.some((n) => n.kind === 'schema' && n.schema === 'dbo'))
  },
  'VORTAQ_TEST_MSSQL_URL'
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
  // «Exportar › Resultado completo» reads the file again in a read-only reader.
  const dir = exportDir()
  const json = join(dir, 'nota.json')
  const full = await exportFrom(panel, json, 'export:query', (f) => [
    `export-sqlite-${process.pid}`,
    {
      connectionId: id,
      filePath: f,
      source: { kind: 'statement', sql: 'SELECT id, texto FROM nota' },
      options: { format: 'json' }
    }
  ])
  assert.ok(full.answer.ok, full.answer.message)
  assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')), [{ id: 1, texto: 'hola' }])
  noParts(dir)
  await api.runner.closeSession(editor.document.uri.toString())
})

test('«Diagrama» and «Consulta gráfica» read structure; «Ejecutar» runs the SELECT in a document', async () => {
  if (api.sqliteProblem) return
  const file = join(scratch, `it-diagram-${process.pid}.db`)
  await api.core.invoke('sqlite:createFile', file)
  const id = await saveConnection(
    input({
      name: `IT diagrama ${process.pid}`,
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
  const setup = await sqlDocument(
    'diagram',
    `CREATE TABLE cliente (id INTEGER PRIMARY KEY, nombre TEXT);\nCREATE TABLE pedido (id INTEGER PRIMARY KEY, cliente_id INTEGER REFERENCES cliente (id));\nINSERT INTO cliente VALUES (1, 'Ana');\nINSERT INTO pedido VALUES (10, 1);\n`,
    { connectionId: id, database: 'main' }
  )
  assert.equal((await runAndWait(setup, 'vortaq.runAll')).state.notice, null)
  await api.runner.closeSession(setup.document.uri.toString())

  const node = { kind: 'database' as const, connectionId: id, database: 'main' }
  await vscode.commands.executeCommand('vortaq.diagram', node)
  const diagram = await waitFor(
    'diagram panel',
    () => api.schemaViews.forConnection(id).find((p) => p.state.kind === 'diagram') ?? null
  )
  const tables = await webviewInvoke(diagram, 'db:tables', [id, 'main'])
  assert.deepEqual((tables.value as { name: string }[]).map((t) => t.name).sort(), [
    'cliente',
    'pedido'
  ])
  const pedido = await webviewInvoke(diagram, 'db:tableStructure', [id, 'main', 'pedido'])
  assert.equal(
    (pedido.value as { foreignKeys: { referencedTable: string }[] }).foreignKeys[0]
      ?.referencedTable,
    'cliente'
  )
  assert.equal((await webviewInvoke(diagram, 'db:tables', [id, 'temp'])).ok, false)
  assert.equal(
    (
      await webviewInvoke(diagram, 'db:tableData', [
        id,
        { schema: 'main', table: 'pedido', limit: 1, offset: 0 }
      ])
    ).ok,
    false
  )

  await vscode.commands.executeCommand('vortaq.queryBuilder', node)
  const builder = await waitFor(
    'visual query panel',
    () => api.schemaViews.forConnection(id).find((p) => p.state.kind === 'queryBuilder') ?? null
  )
  await builder.receive({
    type: 'openSql',
    sql: 'SELECT p.id, c.nombre\nFROM pedido AS p\n  INNER JOIN cliente AS c ON c.id = p.cliente_id;\n',
    run: true
  })
  const editor = vscode.window.activeTextEditor
  assert.ok(editor && editor.document.getText().startsWith('SELECT p.id, c.nombre'))
  assert.equal(api.targets.get(editor.document.uri.toString())?.database, 'main')
  const results = await waitFor('results of the visual query', () => {
    const p = api.results.get(`doc:${editor.document.uri.toString()}`)
    return p && !p.state.running && p.state.results.length ? p : null
  })
  assert.deepEqual(results.state.results[0].resultSet?.rows, [[10, 'Ana']])
  await api.runner.closeSession(editor.document.uri.toString())
  diagram.dispose()
  builder.dispose()
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
