/**
 * Screenshot tour (scripts/screenshots.mjs): runs inside a real VS Code like
 * the integration suite, sets up synthetic data on the test servers and walks
 * through the views. At each step it writes `<step>.ready` in
 * VORTAQ_SHOTS_STEPS and waits for `<step>.done`, which the script writes
 * after capturing the window through the DevTools protocol. Test-only code:
 * never bundled into the VSIX.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import type { ConnectionInput } from '@core'
import type { VortaqTestApi } from '../../src/extension'
import type { TreeNode } from '../../src/host/tree'

const steps = process.env.VORTAQ_SHOTS_STEPS ?? ''
const scratch = process.env.VORTAQ_EXT_IT_SCRATCH ?? ''
const DB = 'vortaq_capturas'
let api: VortaqTestApi

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Waits until the script captured `name`. `webview` is a script the script runs first inside
 * the extension's webviews through the DevTools protocol (to show an edit in progress).
 */
async function step(name: string, webview?: string): Promise<void> {
  await sleep(1800)
  // «Extensions are disabled» and similar start-up toasts are not part of the views.
  for (const command of ['notifications.clearAll', 'notifications.hideToasts'])
    await vscode.commands.executeCommand(command).then(
      () => undefined,
      () => undefined
    )
  await sleep(300)
  writeFileSync(join(steps, `${name}.ready`), JSON.stringify(webview ? { webview } : {}))
  const started = Date.now()
  while (!existsSync(join(steps, `${name}.done`))) {
    if (Date.now() - started > 60_000) throw new Error(`no capture for ${name}`)
    await sleep(100)
  }
}

/** Two pending cell edits in the result grid (amber cells, «Aplicar» enabled). */
const PENDING_EDITS = `(async () => {
  const frame = document.querySelector('iframe')
  const doc = frame && frame.contentDocument
  if (!doc || !doc.querySelector('[data-test="cell-1-5"]')) return 'skip'
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  async function edit(selector, value) {
    const cell = doc.querySelector(selector)
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await sleep(200)
    const input = doc.querySelector('[data-test="cell-input"]')
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await sleep(200)
  }
  await edit('[data-test="cell-1-5"]', 'Factura electrónica')
  await edit('[data-test="cell-3-4"]', '150.00')
  return 'ok'
})()`

/** A rectangle of cells selected, then the grid's menu with «Copiar como» open. */
const COPY_AS_MENU = `(async () => {
  const frame = document.querySelector('iframe')
  const doc = frame && frame.contentDocument
  if (!doc || !doc.querySelector('[data-test="cell-1-1"]')) return 'skip'
  const win = frame.contentWindow
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const cell = (r, c) => doc.querySelector('[data-test="cell-' + r + '-' + c + '"]')
  const mouse = (el, type, init) => {
    const box = el.getBoundingClientRect()
    el.dispatchEvent(new win.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true,
      view: win, button: 0, clientX: box.left + 24, clientY: box.top + box.height / 2 }, init)))
  }
  mouse(cell(1, 1), 'click')
  mouse(cell(4, 3), 'click', { shiftKey: true })
  await sleep(250)
  mouse(cell(2, 2), 'contextmenu', { button: 2 })
  await sleep(500)
  const item = doc.querySelector('[data-test="menu-copy-as"]')
  if (!item) return 'no menu'
  item.click()
  await sleep(600)
  return 'ok'
})()`

/** «Consulta gráfica»: two related tables, three columns ticked, a total and its order. */
const QUERY_BUILDER = `(async () => {
  const frame = document.querySelector('iframe')
  const doc = frame && frame.contentDocument
  if (!doc || !doc.querySelector('[data-test="qb-table-pedidos"]')) return 'skip'
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = async (sel) => { doc.querySelector(sel).click(); await sleep(500) }
  await click('[data-test="qb-table-pedidos"]')
  await click('[data-test="qb-table-clientes"]')
  await click('[data-test="dbox-row-clientes-ciudad"]')
  await click('[data-test="dbox-row-pedidos-total"]')
  await click('[data-test="dbox-row-pedidos-id"]')
  const set = (sel, value) => {
    const el = doc.querySelector(sel)
    el.value = value
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  }
  set('[data-test="qb-agg-p.total"]', 'SUM')
  set('[data-test="qb-as-p.total"]', 'facturado')
  set('[data-test="qb-sort-p.total"]', 'DESC')
  set('[data-test="qb-agg-p.id"]', 'COUNT')
  set('[data-test="qb-as-p.id"]', 'pedidos')
  await sleep(300)
  await click('[data-test="qb-tab-sql"]')
  return 'ok'
})()`

/** From the same menu, «Exportar selección…»: the export dialog over the results. */
const EXPORT_DIALOG = `(async () => {
  const frame = document.querySelector('iframe')
  const doc = frame && frame.contentDocument
  if (!doc || !doc.querySelector('[data-test="cell-1-1"]')) return 'skip'
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const item = doc.querySelector('[data-test="menu-export-selection"]')
  if (!item) return 'no menu'
  item.click()
  await sleep(700)
  return doc.querySelector('[data-test="export-dialog"]') ? 'ok' : 'no dialog'
})()`

function base(overrides: Partial<ConnectionInput>): ConnectionInput {
  return {
    name: '',
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

async function save(value: ConnectionInput, password?: string): Promise<string> {
  const saved = await api.core.invoke('connections:save', value)
  if (password) await api.core.invoke('connections:setPassword', saved.id, password)
  return saved.id
}

const CLIENTES = [
  ['Lucía Fernández', 'Madrid', '2024-02-11', '1520.40', null],
  ['Mateo Ruiz', 'Sevilla', '2024-03-02', '87.00', 'Prefiere factura en papel'],
  ['Valentina Gómez', 'Bogotá', '2024-04-18', '2310.75', null],
  ['Santiago Herrera', 'Medellín', '2024-05-09', '0.00', 'Cuenta nueva'],
  ['Camila Torres', 'Lima', '2024-06-21', '640.10', null],
  ['Diego Navarro', 'Valencia', '2024-07-30', '45.90', null],
  ['Martina Castro', 'Buenos Aires', '2024-08-14', '980.00', 'Cliente mayorista'],
  ['Javier Morales', 'Ciudad de México', '2024-09-01', '310.25', null],
  ['Sofía Ramírez', 'Quito', '2024-10-12', '1205.60', null],
  ['Andrés Silva', 'Santiago', '2024-11-27', '75.30', 'Pago trimestral'],
  ['Elena Ortega', 'Bilbao', '2025-01-08', '410.00', null],
  ['Tomás Vidal', 'Montevideo', '2025-02-19', '2899.99', null]
]

async function setup(): Promise<{ local: string; prod: string; mongo: string | null }> {
  const my = new URL(process.env.VORTAQ_TEST_MYSQL_URL!)
  const mysql = {
    engine: 'mysql' as const,
    host: my.hostname,
    port: Number(my.port),
    username: decodeURIComponent(my.username)
  }
  const local = await save(
    base({ ...mysql, name: 'Tienda (local)', color: '#4bd67a', environment: 'local' }),
    decodeURIComponent(my.password)
  )
  const prod = await save(
    base({ ...mysql, name: 'Tienda (producción)', environment: 'production' }),
    decodeURIComponent(my.password)
  )
  const values = CLIENTES.map(
    ([nombre, ciudad, alta, saldo, notas], i) =>
      `(${i + 1}, '${nombre}', '${ciudad}', '${alta}', ${saldo}, ${notas ? `'${notas}'` : 'NULL'})`
  ).join(',\n')
  await api.core.invoke(
    'db:execute',
    local,
    `DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB};
     CREATE TABLE ${DB}.clientes (id INT PRIMARY KEY, nombre VARCHAR(60) NOT NULL, ciudad VARCHAR(40),
       alta DATE, saldo DECIMAL(10,2), notas VARCHAR(80) NULL);
     CREATE TABLE ${DB}.pedidos (id INT PRIMARY KEY, cliente_id INT, total DECIMAL(10,2),
       FOREIGN KEY (cliente_id) REFERENCES ${DB}.clientes (id));
     CREATE TABLE ${DB}.productos (id INT PRIMARY KEY, nombre VARCHAR(60) NOT NULL, precio DECIMAL(10,2));
     CREATE TABLE ${DB}.lineas (pedido_id INT NOT NULL, producto_id INT NOT NULL, cantidad INT NOT NULL,
       PRIMARY KEY (pedido_id, producto_id),
       FOREIGN KEY (pedido_id) REFERENCES ${DB}.pedidos (id),
       FOREIGN KEY (producto_id) REFERENCES ${DB}.productos (id));
     CREATE VIEW ${DB}.saldos AS SELECT ciudad, SUM(saldo) AS saldo FROM ${DB}.clientes GROUP BY ciudad;
     INSERT INTO ${DB}.clientes VALUES ${values};`
  )
  if (process.env.VORTAQ_TEST_PG_URL) {
    const pg = new URL(process.env.VORTAQ_TEST_PG_URL)
    await save(
      base({
        name: 'Analítica',
        engine: 'postgresql',
        environment: 'staging',
        color: '#38bdf8',
        host: pg.hostname,
        port: Number(pg.port),
        username: decodeURIComponent(pg.username),
        postgres: {
          initialDatabase: pg.pathname.slice(1),
          showSystemSchemas: false,
          timeZone: '',
          searchPath: ''
        }
      }),
      decodeURIComponent(pg.password)
    )
  }
  let mongo: string | null = null
  if (process.env.VORTAQ_TEST_MONGO_URL) {
    const m = new URL(process.env.VORTAQ_TEST_MONGO_URL)
    mongo = await save(
      base({
        name: 'Eventos',
        engine: 'mongodb',
        environment: 'other',
        host: m.hostname,
        port: Number(m.port),
        username: decodeURIComponent(m.username),
        mongo: {
          topology: 'standalone',
          srv: false,
          members: [],
          replicaSet: '',
          authMechanism: 'default',
          authSource: m.searchParams.get('authSource') ?? 'admin',
          defaultDatabase: DB,
          readPreference: 'primary',
          directConnection: true,
          retryWrites: true,
          retryReads: true,
          extraOptions: {}
        }
      }),
      decodeURIComponent(m.password)
    )
    await api.connections.open(mongo)
    await api.core.invoke(
      'mongo:execute',
      mongo,
      `db.visitas.drop(); db.visitas.insertMany([
        { _id: ObjectId('6720f1a2b3c4d5e6f7a8b901'), pagina: '/inicio', usuario: 'lucia', duracion: NumberLong('5400000000'), en: ISODate('2026-10-01T09:15:00Z'), etiquetas: ['móvil', 'es'] },
        { _id: ObjectId('6720f1a2b3c4d5e6f7a8b902'), pagina: '/precios', usuario: 'mateo', duracion: NumberLong('125000'), en: ISODate('2026-10-01T09:20:00Z'), importe: Decimal128('19.90') },
        { _id: ObjectId('6720f1a2b3c4d5e6f7a8b903'), pagina: '/contacto', usuario: null, duracion: NumberLong('8000'), en: ISODate('2026-10-02T17:42:00Z') }
      ])`,
      { database: DB }
    )
  }
  const file = join(scratch, 'notas.db')
  if (!api.sqliteProblem && !existsSync(file)) {
    await api.core.invoke('sqlite:createFile', file)
    await save(
      base({
        name: 'Notas',
        engine: 'sqlite',
        authMode: 'none',
        color: '#a78bfa',
        sqlite: {
          filePath: file,
          readOnly: false,
          foreignKeys: true,
          attached: [],
          busyTimeoutMs: 5000
        }
      })
    )
  }
  return { local, prod, mongo }
}

async function sqlEditor(
  name: string,
  sql: string,
  connectionId: string
): Promise<vscode.TextEditor> {
  const dir = join(scratch, 'workspace')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, sql)
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One)
  await api.targets.set(doc.uri.toString(), { connectionId, database: DB })
  return editor
}

async function tidy(): Promise<void> {
  for (const command of [
    'workbench.action.closeAuxiliaryBar',
    'workbench.action.closePanel',
    'notifications.clearAll'
  ])
    await vscode.commands.executeCommand(command).then(
      () => undefined,
      () => undefined
    )
}

async function tour(
  theme: string,
  suffix: string,
  ids: { local: string; prod: string; mongo: string | null }
): Promise<void> {
  await vscode.workspace
    .getConfiguration('workbench')
    .update('colorTheme', theme, vscode.ConfigurationTarget.Global)
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await vscode.commands.executeCommand('workbench.view.extension.vortaq')
  await tidy()
  // Tree: «Tienda (local)» › vortaq_capturas › Tablas › clientes.
  const table: TreeNode = { kind: 'table', connectionId: ids.local, database: DB, name: 'clientes' }
  await api.view.reveal(table, { select: true, focus: false, expand: true })
  const editor = await sqlEditor(
    'clientes.sql',
    `-- Clientes con saldo pendiente\nSELECT id, nombre, ciudad, alta, saldo, notas\nFROM clientes\nORDER BY id;\n`,
    ids.local
  )
  editor.selection = new vscode.Selection(2, 2, 2, 2)
  await vscode.commands.executeCommand('vortaq.run')
  await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One)
  await tidy()
  await step(`results-${suffix}`, PENDING_EDITS)

  // Selection, «Copiar como» and «Exportar» on a fresh result.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  const exportEditor = await sqlEditor(
    'saldos.sql',
    `-- Saldos por cliente\nSELECT id, nombre, ciudad, saldo\nFROM clientes\nORDER BY saldo DESC;\n`,
    ids.local
  )
  exportEditor.selection = new vscode.Selection(2, 2, 2, 2)
  await vscode.commands.executeCommand('vortaq.run')
  await vscode.window.showTextDocument(exportEditor.document, vscode.ViewColumn.One)
  await tidy()
  await step(`copy-as-${suffix}`, COPY_AS_MENU)
  await step(`export-dialog-${suffix}`, EXPORT_DIALOG)
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')

  // Production confirmation: the typed-name prompt over a production document.
  const prodEditor = await sqlEditor(
    'ajuste-saldos.sql',
    `-- Ajuste de saldos en producción\nUPDATE clientes\nSET saldo = saldo * 1.02\nWHERE ciudad = 'Madrid';\n`,
    ids.prod
  )
  prodEditor.selection = new vscode.Selection(1, 0, 1, 0)
  const pending = vscode.commands.executeCommand('vortaq.run')
  await tidy()
  await step(`production-confirm-${suffix}`)
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
  await pending

  // Connection form: a new connection, then the production one.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  const form = api.openConnectionForm(null)
  await tidy()
  await step(`connection-new-${suffix}`)
  form.dispose()
  const prod = api.connections.get(ids.prod)
  const edit = api.openConnectionForm(prod)
  await step(`connection-production-${suffix}`)
  edit.dispose()

  // Relationship diagram and visual query of the shop database.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  const shop: TreeNode = { kind: 'database', connectionId: ids.local, database: DB }
  await vscode.commands.executeCommand('vortaq.diagram', shop)
  await tidy()
  await step(`diagram-${suffix}`)
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await vscode.commands.executeCommand('vortaq.queryBuilder', shop)
  await tidy()
  await step(`query-builder-${suffix}`, QUERY_BUILDER)
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')

  if (ids.mongo) {
    await vscode.commands.executeCommand('vortaq.viewDocuments', {
      kind: 'collection',
      connectionId: ids.mongo,
      database: DB,
      name: 'visitas',
      view: false
    })
    await api.view.reveal(
      { kind: 'collection', connectionId: ids.mongo, database: DB, name: 'visitas', view: false },
      { select: true, focus: false, expand: true }
    )
    await tidy()
    await step(`documents-${suffix}`)
  }
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<VortaqTestApi>('y0rshb3.vortaq')
  if (!extension) throw new Error('extension not loaded')
  api = await extension.activate()
  const ids = await setup()
  await tour('Default Dark Modern', 'dark', ids)
  await tour('Default Light Modern', 'light', ids)
  await tour('Default High Contrast', 'hc', ids)
  await api.core
    .invoke('db:execute', ids.local, `DROP DATABASE IF EXISTS ${DB}`)
    .catch(() => undefined)
  if (ids.mongo)
    await api.core
      .invoke('mongo:execute', ids.mongo, 'db.dropDatabase()', { database: DB })
      .catch(() => undefined)
}
