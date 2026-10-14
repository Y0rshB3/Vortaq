import { app, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { envVar } from './env'

/**
 * Screenshot harness (development only).
 *
 * VORTAQ_SCREENSHOTS=<dir> together with VORTAQ_USER_DATA=<scratch profile>
 * opens a 1600x1000 window whose renderer installs a debug hook
 * (`window.__vortaqShots`, see renderer main.ts, enabled by the
 * `nd-screenshots=1` query parameter), drives the UI through the stores and
 * saves one PNG per screen. Each step is isolated: a failure is logged and the
 * run continues. Never enabled in normal runs.
 */

export const SCREENSHOT_WINDOW = { width: 1600, height: 1000 }
export const SCREENSHOT_QUERY = { 'nd-screenshots': '1' }

/** Resolved screenshot directory, or null when the harness is off. */
export function screenshotDirFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = envVar('SCREENSHOTS', env)?.trim()
  if (!dir) return null
  return isAbsolute(dir) ? dir : resolve(dir)
}

interface Step {
  name: string
  /** Body of an async function run in the renderer with `S` (hook) and `H` (helpers) in scope. */
  script: string
  /** Extra settle time before capturing. */
  settleMs?: number
  /** Body run after the capture (closing dialogs...). */
  cleanup?: string
  /** Window content size for this step (narrow layouts); restored afterwards. */
  size?: { width: number; height: number }
}

const LOCAL = 'Local Test'
/** Database of the throwaway test MySQL (its name predates the Vortaq rename). */
const SCHEMA = 'navidog_test'
/** Scratch schema created and dropped by the live job log steps. */
const BIG_SCHEMA = 'vortaq_shots_big'
const LIVE_JOB = 'Backup con errores'
/** Seeded job backing up rb_shop/rb_crm on the 5.7 "staging"; its run is restored into Local Test. */
const ROLLBACK_JOB = 'Backup staging 5.7'
const STAGING_TO_LOCAL_JOB = 'Staging 5.7 -> Local'
/** Seeded MySQL 5.7 "staging" connection id (scripts/seed-screenshots.mjs). */
const STAGING57 = 'shot-staging57'

/** Helpers installed once in the renderer. */
const HELPERS = `
window.__ndShotHelpers = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  async function until(fn, timeout = 10000, every = 100) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try { const v = await fn(); if (v) return v } catch (e) { /* retry */ }
      await sleep(every)
    }
    throw new Error('timeout waiting for condition: ' + fn.toString().slice(0, 120))
  }
  const visible = (el) => !!el && el.getClientRects().length > 0
  const $ = (sel) => [...document.querySelectorAll(sel)].find(visible) || null
  const waitFor = (sel, timeout) => until(() => $(sel), timeout)
  async function click(sel, timeout) { const el = await waitFor(sel, timeout); el.click(); return el }
  function idle(S) {
    return Object.keys(S.tree.loading).length === 0 && Object.keys(S.connections.opening).length === 0
  }
  async function settle(S, ms = 600) {
    await until(() => idle(S), 15000)
    await sleep(ms)
  }
  function local(S) {
    const c = S.connections.items.find((x) => x.name === ${JSON.stringify(LOCAL)})
    if (!c) throw new Error('connection "${LOCAL}" not found (run scripts/seed-screenshots.mjs)')
    return c
  }
  /** Layout check: the visible grid area must keep a usable height (value panel regression). */
  function gridVisible(min = 120) {
    const area = $('[data-test="grid-area"]')
    if (!area) throw new Error('grid area not rendered')
    const h = area.getBoundingClientRect().height
    if (h < min) throw new Error('grid area too small: ' + Math.round(h) + 'px')
    return h
  }
  async function valuePanel(on) {
    const toggle = await waitFor('[data-test="value-toggle"]', 10000)
    if ((toggle.getAttribute('aria-pressed') === 'true') !== on) toggle.click()
    await sleep(200)
  }
  return { sleep, until, $, waitFor, click, idle, settle, local, gridVisible, valuePanel }
})()
true
`

/** Opens `sql` in a new query tab, runs it and waits for the first result's editability chip. */
const RUN_QUERY = (sql: string, name: string, chip: string): string => `
      const c = H.local(S)
      S.workspace.openQuery(c.id, '${SCHEMA}', { sql: ${JSON.stringify(sql)}, name: ${JSON.stringify(name)} })
      await H.sleep(900)
      await H.click('[data-test="run"]', 10000)
      await H.until(() => ${JSON.stringify(chip)} === '' || new RegExp(${JSON.stringify(chip)}).test(H.$('[data-test="editability"]')?.textContent || ''), 15000)`

/** Pending edits on an editable shot_customers result: one cell, one NULL, one deleted row, one new row. */
const EDIT_RESULT = `
      async function typeInto(sel, value) {
        const cell = await H.waitFor(sel, 5000)
        cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        const input = await H.waitFor('[data-test="cell-input"]', 5000)
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await H.sleep(150)
      }
      await typeInto('[data-test="cell-0-1"]', 'Cliente editado')
      await H.click('[data-test="cell-1-4"]', 5000)
      await H.click('[data-test="set-null"]', 5000)
      await H.click('[data-test="row-2"] td', 5000)
      await H.click('[data-test="delete-rows"]', 5000)
      await H.click('[data-test="add-row"]', 5000)
      await H.sleep(200)`

/** Script of the destructive-query confirmation screen (cancelled: never executed). */
const DESTRUCTIVE_SQL = [
  'SELECT COUNT(*) FROM shot_orders;',
  '-- limpieza',
  'DELETE FROM shot_orders;',
  'UPDATE shot_customers SET active = 0 WHERE id = 3;',
  'DROP TABLE IF EXISTS shot_tmp;'
].join('\n')

const STEPS: Step[] = [
  {
    name: '01-home',
    script: `
      S.ui.toggleInfoPanel(true)
      S.workspace.showObjects()
      S.tree.select(null)
      await H.settle(S, 900)`
  },
  {
    name: '02-tree-expanded',
    script: `
      const c = H.local(S)
      await S.tree.expand(S.tree.parse('c:' + c.id))
      if (!S.connections.isOpen(c.id)) throw new Error('could not open ${LOCAL}')
      const schemaId = 's:' + c.id + ':${SCHEMA}'
      S.tree.setExpanded(schemaId, true)
      await S.tree.expand(S.tree.parse('g:' + c.id + ':${SCHEMA}:tables'))
      await S.tree.expand(S.tree.parse('g:' + c.id + ':${SCHEMA}:views'))
      S.tree.select(schemaId)
      S.workspace.showObjects()
      await H.settle(S, 900)`
  },
  {
    name: '03-objects-tables',
    script: `
      S.ui.objectsViewMode = 'list'
      const ok = await S.workspace.showGroup('tables')
      if (!ok) throw new Error('showGroup(tables) failed')
      await H.settle(S, 1200)`
  },
  {
    name: '04-table-data',
    script: `
      const c = H.local(S)
      S.workspace.openTableData(c.id, '${SCHEMA}', 'shot_customers')
      await H.waitFor('.v-window-item--active table tbody tr, table tbody tr', 15000).catch(() => null)
      await H.settle(S, 1800)`
  },
  {
    name: '05-query',
    script: `
      const c = H.local(S)
      const sql = [
        '-- Clientes con más pedidos',
        'SELECT c.id, c.name, c.country, COUNT(o.id) AS pedidos, ROUND(SUM(o.total), 2) AS facturado',
        'FROM shot_customers c',
        'JOIN shot_orders o ON o.customer_id = c.id',
        'GROUP BY c.id, c.name, c.country',
        'ORDER BY facturado DESC',
        'LIMIT 50;'
      ].join('\\n')
      S.workspace.openQuery(c.id, '${SCHEMA}', { sql, name: 'Top clientes' })
      await H.sleep(900)
      await H.click('[data-test="run"]', 10000)
      await H.until(() => !H.$('[data-test="stop"]:not([disabled])'), 15000).catch(() => null)
      await H.settle(S, 1800)`
  },
  {
    name: '05b-query-editable',
    script: `
      // One base table with its primary key: the result is editable (Navicat behaviour).
      const c = H.local(S)
      S.workspace.openQuery(c.id, '${SCHEMA}', {
        sql: 'SELECT * FROM shot_customers AS c WHERE c.id < 5',
        name: 'Clientes editables'
      })
      await H.sleep(900)
      await H.click('[data-test="run"]', 10000)
      await H.until(() => /Editable/.test(H.$('[data-test="editability"]')?.textContent || ''), 15000)
      const cell = await H.waitFor('[data-test="cell-1-1"]', 5000)
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      const input = await H.waitFor('[data-test="cell-input"]', 5000)
      input.value = 'Cliente editado'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await H.click('[data-test="cell-2-4"]', 5000)
      await H.settle(S, 1200)`
  },
  {
    name: '05c-query-join-readonly',
    script: `
      const c = H.local(S)
      const sql = [
        'SELECT c.id, c.name, o.id AS pedido, o.status, o.total',
        'FROM shot_customers c',
        'JOIN shot_orders o ON o.customer_id = c.id',
        'LIMIT 30'
      ].join('\\n')
      S.workspace.openQuery(c.id, '${SCHEMA}', { sql, name: 'Pedidos por cliente' })
      await H.sleep(900)
      await H.click('[data-test="run"]', 10000)
      await H.until(() => /Solo lectura/.test(H.$('[data-test="editability"]')?.textContent || ''), 15000)
      await H.settle(S, 1200)`
  },
  {
    name: '05d-query-edit-1280',
    size: { width: 1280, height: 800 },
    script:
      RUN_QUERY('SELECT * FROM shot_customers AS c WHERE c.id < 6', 'Edición 1280', 'Editable') +
      EDIT_RESULT +
      `
      await H.settle(S, 900)`
  },
  {
    name: '05e-query-edit-1100',
    size: { width: 1100, height: 760 },
    script:
      RUN_QUERY('SELECT * FROM shot_customers AS c WHERE c.id < 6', 'Edición 1100', 'Editable') +
      EDIT_RESULT +
      `
      await H.settle(S, 900)`
  },
  {
    name: '05f-query-apply-error',
    script:
      RUN_QUERY(
        'SELECT * FROM shot_customers AS c WHERE c.id < 6',
        'Error al aplicar',
        'Editable'
      ) +
      EDIT_RESULT +
      `
      // city is NOT NULL: the whole batch fails and is rolled back (nothing is written).
      await H.click('[data-test="apply"]', 5000)
      await H.sleep(400)
      if (S.ui.confirm.open) S.ui.answer(true)
      await H.waitFor('[data-test="apply-error"]', 10000)
      await H.settle(S, 900)`
  },
  {
    name: '05g-query-many-results-1100',
    size: { width: 1100, height: 760 },
    script:
      RUN_QUERY(
        Array.from(
          { length: 8 },
          (_, i) => `SELECT id, name, city FROM shot_customers WHERE id > ${i * 3} LIMIT ${i + 2};`
        ).join('\n'),
        'Varios resultados',
        'Editable'
      ) +
      `
      await H.click('[data-test="tab-rs2"]', 5000)
      await H.settle(S, 900)`
  },
  {
    name: '05h-query-results-menu',
    size: { width: 1100, height: 760 },
    script: `
      await H.click('[data-test="results-menu"]', 5000)
      await H.waitFor('.v-overlay--active .v-list', 5000)
      await H.sleep(400)`,
    cleanup: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  },
  {
    name: '05i-query-view-readonly',
    script:
      RUN_QUERY('SELECT * FROM shot_customer_totals', 'Vista', 'Solo lectura') +
      `
      await H.settle(S, 900)`
  },
  {
    name: '05j-table-data-1100',
    size: { width: 1100, height: 760 },
    script: `
      const c = H.local(S)
      S.workspace.openTableData(c.id, '${SCHEMA}', 'shot_orders')
      await H.waitFor('[data-test="cell-0-1"]', 15000)
      await H.click('[data-test="cell-1-2"]', 5000)
      await H.click('[data-test="set-null"]', 5000)
      await H.settle(S, 900)`
  },
  {
    // Query tab connection picker (Navicat): every connection with its colour and environment.
    name: '05k-query-connection-menu',
    size: { width: 1280, height: 800 },
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      const c = H.local(S)
      S.workspace.openQuery(c.id, '${SCHEMA}', {
        sql: 'SELECT id, name, country, credit_limit FROM shot_customers ORDER BY id LIMIT 20;',
        name: 'Clientes'
      })
      await H.sleep(900)
      const field = await H.waitFor('[data-test="connection"] .v-field', 5000)
      field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await H.waitFor('[data-test="connection-option-shot-prod"]', 5000)
      await H.sleep(400)`
  },
  {
    // Production picked in the same tab: SQL kept, toolbar and picker tinted red.
    name: '05l-query-connection-production',
    size: { width: 1280, height: 800 },
    script: `
      await H.click('[data-test="connection-option-shot-prod"]', 5000)
      await H.until(() => /Production Demo/.test(S.tabs.active.title), 15000)
      await H.until(() => H.$('.query-view__bar.is-production'), 5000)
      await H.click('[data-test="run"]', 10000)
      await H.until(() => H.$('[data-test="tab-rs0"]'), 15000)
      await H.until(() => /Editable/.test(H.$('[data-test="editability"]')?.textContent || ''), 15000)
      // "Texto" on with no cell selected: the panel is only its header, the grid keeps its room.
      await H.valuePanel(true)
      await H.settle(S, 1500)
      H.gridVisible()`
  },
  {
    // Same tab with a cell selected: the value shows below a still visible grid.
    name: '05l2-query-value-panel',
    size: { width: 1280, height: 800 },
    script: `
      await H.click('[data-test="cell-1-1"]', 5000)
      await H.waitFor('[data-test="value-panel-text"]', 5000)
      await H.settle(S, 700)
      H.gridVisible()`
  },
  {
    // Navicat filter builder: sentences with a nested bracket and mixed y/o, applied.
    name: '05m-table-filter',
    size: { width: 1280, height: 800 },
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      const c = H.local(S)
      let n = 0
      const cond = (column, operator, values, connector, extra) => ({
        id: 'shot-c' + ++n, kind: 'condition', enabled: true, column, operator,
        values, connector, sql: '', ...extra
      })
      const group = (children, connector) => ({
        id: 'shot-g' + ++n, kind: 'group', enabled: true, connector, children
      })
      const root = group([
        cond('email', 'contains', ['cliente0'], 'AND'),
        group([
          cond('country', 'in', ['ES', 'MX', 'AR'], 'OR'),
          cond('credit_limit', 'between', ['1000', '6000'], 'AND')
        ], 'AND'),
        cond('active', 'eq', ['1'], 'AND'),
        cond('city', 'beginsWith', ['Val'], 'AND', { enabled: false })
      ], 'AND')
      S.tabs.open({
        kind: 'tableData',
        id: 'tableData:' + c.id + ':${SCHEMA}:shot_customers',
        title: 'shot_customers@${SCHEMA} (' + c.name + ')',
        connectionId: c.id,
        schema: '${SCHEMA}',
        objectName: 'shot_customers',
        objectType: 'table',
        payload: {
          filterOpen: true,
          filter: { mode: 'builder', root, text: '', generatedText: null, selectedId: 'shot-c3', profile: null }
        }
      })
      await H.waitFor('[data-test="filter-line-condition"]', 15000)
      await H.click('[data-test="apply-filter"]', 5000)
      await H.until(() => /filtrado/.test(H.$('[data-test="footer"]')?.textContent || ''), 15000)
      await H.settle(S, 900)
      H.gridVisible()`
  },
  {
    name: '05n-table-filter-operators',
    size: { width: 1280, height: 800 },
    script: `
      const tokens = document.querySelectorAll('[data-test="filter-operator-token"]')
      tokens[2].click()
      await H.waitFor('.v-overlay--active [data-test="filter-operator-option-between"]', 5000)
      await H.sleep(500)`,
    cleanup: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  },
  {
    name: '05p-table-filter-context-menu',
    size: { width: 1280, height: 800 },
    script: `
      await H.sleep(400)
      const line = document.querySelectorAll('[data-test="filter-line-condition"]')[1]
      const r = line.getBoundingClientRect()
      line.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 260, clientY: r.top + 12 }))
      await H.waitFor('.v-overlay--active [data-test="ctx-wrap"]', 5000)
      await H.sleep(500)`,
    cleanup: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  },
  {
    // "Editar como texto (WHERE)": the WHERE main generated, ready to tweak.
    name: '05o-table-filter-text',
    size: { width: 1280, height: 800 },
    script: `
      await H.sleep(300)
      const toggle = await H.waitFor('[data-test="filter-text-mode"] input', 5000)
      toggle.click()
      await H.waitFor('[data-test="where"] textarea', 10000)
      await H.settle(S, 700)`
  },
  {
    // Date/time picker on a DATETIME(3) cell (calendar + time with milliseconds).
    name: '05q-grid-datetime-picker',
    size: { width: 1280, height: 800 },
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      const c = H.local(S)
      S.workspace.openTableData(c.id, '${SCHEMA}', 'shot_events')
      await H.until(() => /Evento 1/.test(H.$('[data-test="cell-0-1"]')?.textContent || ''), 15000)
      await H.settle(S, 600)
      await H.until(() => {
        const cell = H.$('[data-test="cell-0-2"]')
        if (!cell) return false
        if (!cell.querySelector('[data-test="temporal-open"]'))
          cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return cell.querySelector('[data-test="temporal-open"]')
      }, 10000, 300)
      await H.click('[data-test="cell-0-2"] [data-test="temporal-open"]', 5000)
      await H.waitFor('.v-overlay--active [data-test="temporal-picker"]', 5000)
      await H.sleep(500)`,
    cleanup: `
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await H.sleep(200)
      const input = H.$('[data-test="cell-input"]')
      if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  },
  {
    // "Texto" value panel with pretty JSON, and a resized column (title, dragged wider).
    name: '05r-grid-value-panel-json',
    size: { width: 1280, height: 800 },
    script: `
      const toggle = await H.waitFor('[data-test="value-toggle"]', 5000)
      if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click()
      const handle = await H.waitFor('[data-test="resize-title"]', 5000)
      const r = handle.getBoundingClientRect()
      const opts = (x) => ({ bubbles: true, clientX: x, clientY: r.top + 5, pointerId: 1 })
      handle.dispatchEvent(new PointerEvent('pointerdown', opts(r.left)))
      handle.dispatchEvent(new PointerEvent('pointermove', opts(r.left + 90)))
      handle.dispatchEvent(new PointerEvent('pointerup', opts(r.left + 90)))
      await H.sleep(200)
      await H.click('[data-test="cell-1-6"]', 5000)
      await H.waitFor('[data-test="value-panel-json"]', 5000)
      await H.settle(S, 700)
      H.gridVisible()`
  },
  {
    name: '06-designer',
    script: `
      const c = H.local(S)
      S.workspace.openTableDesigner(c.id, '${SCHEMA}', 'shot_orders')
      await H.settle(S, 2000)`
  },
  {
    name: '07-backups',
    script: `
      const c = H.local(S)
      S.workspace.openBackups(c.id, null)
      const row = await H.waitFor('[data-test="backup-row"]', 10000)
      row.click()
      await H.settle(S, 1500)`
  },
  {
    name: '08-automation',
    script: `
      S.workspace.openAutomation()
      const row = await H.waitFor('[data-test="automation-view"] tbody tr', 10000)
      row.click()
      await H.settle(S, 1500)`
  },
  {
    name: '09-job-editor',
    script: `
      await S.jobs.load()
      const job = S.jobs.sorted[0]
      if (!job) throw new Error('no jobs (run scripts/seed-screenshots.mjs)')
      S.workspace.openJobEditor(job.id, job.name)
      await H.settle(S, 1500)`
  },
  {
    name: '10-connection-dialog',
    script: `
      S.ui.openConnectionDialog(H.local(S))
      await H.waitFor('.v-dialog .v-card', 5000)
      await H.settle(S, 900)`,
    cleanup: `S.ui.connectionDialog = { open: false, editing: null }`
  },
  {
    // New connection through a local auth proxy: «Autenticación › Sin contraseña».
    name: '10b-connection-no-password',
    script: `
      S.ui.openConnectionDialog(null)
      const name = await H.waitFor('[data-test="conn-name"] input', 5000)
      name.value = 'Producción (Cloud SQL Proxy)'
      name.dispatchEvent(new Event('input', { bubbles: true }))
      const field = await H.waitFor('[data-test="conn-auth-mode"] .v-field', 5000)
      field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      field.click()
      const option = await H.until(() =>
        [...document.querySelectorAll('.v-list-item')].find((el) =>
          el.textContent.includes('Sin contraseña')
        ), 5000)
      option.click()
      await H.waitFor('[data-test="conn-no-password-hint"]', 5000)
      await H.settle(S, 900)`,
    cleanup: `S.ui.connectionDialog = { open: false, editing: null }`
  },
  {
    name: '11-import-dialog',
    script: `
      S.ui.openImportDialog()
      await H.waitFor('[data-test="import-dialog"]', 5000)
      await H.settle(S, 1500)`,
    cleanup: `S.ui.importDialog = false`
  },
  {
    name: '12-restore-dialog',
    script: `
      const c = H.local(S)
      const backups = await S.api.backups.list(c.id, null)
      if (!backups.length) throw new Error('no backups listed for ${LOCAL}')
      S.ui.openRestoreDialog(backups[0], c.id)
      await H.waitFor('[data-test="restore-dialog"]', 5000)
      await H.settle(S, 1500)`,
    cleanup: `S.ui.restoreDialog = { open: false, backup: null, connectionId: null }`
  },
  {
    // «Reemplazar la base de datos completa» with «Contenido: Solo estructura».
    name: '12b-restore-replace-structure',
    script: `
      const c = H.local(S)
      const backups = await S.api.backups.list(c.id, null)
      if (!backups.length) throw new Error('no backups listed for ${LOCAL}')
      S.ui.openRestoreDialog(backups[0], c.id)
      await H.waitFor('[data-test="restore-dialog"]', 5000)
      await H.click('[data-test="restore-mode-replace"]', 5000)
      await H.click('[data-test="replace-content-structure"]', 5000)
      await H.settle(S, 1200)`,
    cleanup: `S.ui.restoreDialog = { open: false, backup: null, connectionId: null }`
  },
  {
    name: '13-settings-dialog',
    script: `
      S.ui.openSettingsDialog()
      await H.waitFor('.v-dialog .v-card', 5000)
      await H.settle(S, 900)`,
    cleanup: `S.ui.settingsDialog = false`
  },
  {
    name: '14-production-confirm',
    script: `
      const prod = S.connections.items.find((x) => x.environment === 'production')
      void S.ui.ask({
        title: 'Eliminar filas',
        message: 'Se eliminarán 12 filas de shot_orders.\\n\\nEsta conexión está marcada como PRODUCCIÓN. Escribe el nombre de la conexión para continuar.',
        details: 'DELETE FROM shot_orders WHERE status = \\'cancelled\\' AND created_at < \\'2026-01-01\\';',
        confirmText: 'Ejecutar en producción',
        color: 'error',
        requireTyped: prod ? prod.name : 'Production Demo',
        production: true
      })
      await H.waitFor('.v-dialog .v-card', 5000)
      await H.sleep(900)`,
    cleanup: `S.ui.answer(false)`
  },
  {
    // Live automation log (Navicat batch job log): a job backing up the test schema, a
    // larger scratch schema (so the capture lands mid-run) and a missing schema that fails.
    name: '15a-job-live-log',
    script: `
      const c = H.local(S)
      const big = ${JSON.stringify(BIG_SCHEMA)}
      const sql = [
        'DROP DATABASE IF EXISTS ' + big,
        'CREATE DATABASE ' + big,
        'CREATE TABLE ' + big + '.accounts (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL)',
        "INSERT INTO " + big + ".accounts VALUES (1, 'demo'), (2, 'test')",
        'CREATE TABLE ' + big + '.seq (n INT PRIMARY KEY)',
        'INSERT INTO ' + big + '.seq WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM s WHERE n < 999) SELECT n FROM s',
        'CREATE TABLE ' + big + '.events (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, kind VARCHAR(12) NOT NULL, payload VARCHAR(160) NOT NULL, created_at DATETIME NOT NULL)',
        "INSERT INTO " + big + ".events (kind, payload, created_at) SELECT ELT(1 + (b.n % 4), 'login', 'logout', 'view', 'click'), REPEAT(MD5(a.n * 1000 + b.n), 4), NOW() - INTERVAL (a.n * 1000 + b.n) SECOND FROM " + big + ".seq a CROSS JOIN " + big + ".seq b WHERE a.n < 400",
        'CREATE VIEW ' + big + '.v_logins AS SELECT id, created_at FROM ' + big + ".events WHERE kind = 'login'"
      ]
      for (const statement of sql) await S.api.invokeSilent('db:execute', c.id, statement, {})
      const job = await S.jobs.save({
        name: ${JSON.stringify(LIVE_JOB)},
        continueOnError: true,
        tasks: [
          { id: 'l1', type: 'backupschema', connectionId: c.id, schema: '${SCHEMA}', referenceName: 'Backup ${SCHEMA}', includeData: true },
          { id: 'l2', type: 'backupschema', connectionId: c.id, schema: big, referenceName: 'Backup ' + big, includeData: true },
          { id: 'l3', type: 'backupschema', connectionId: c.id, schema: 'vortaq_missing', referenceName: 'Backup vortaq_missing', includeData: true },
          { id: 'l4', type: 'runquery', connectionId: c.id, schema: '${SCHEMA}', referenceName: 'Comprobar pedidos', sql: 'DO 1;' }
        ],
        schedule: { enabled: false, cron: '', launchAgent: false }
      })
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      S.workspace.openAutomation()
      const rows = await H.until(() => {
        const list = [...document.querySelectorAll('[data-test="automation-view"] tbody tr')]
        return list.find((r) => r.textContent.includes(job.name))
      }, 10000)
      rows.click()
      await H.sleep(300)
      await H.click('[data-test="jobs-run"]', 5000)
      // Mid-run: the small tables of the second step are logged, its big table is still running.
      await H.until(() => /Tabla accounts/.test(H.$('[data-test="run-log-panel"]')?.textContent || ''), 60000, 50)
      // The card counts rows against the table's estimate and its bar moves inside the table.
      try {
        await H.until(() => /Tabla events .*de ~/.test(H.$('[data-test="progress-message"]')?.textContent || ''), 30000, 50)
      } catch (e) { /* small server: the table may finish first */ }
      await H.sleep(250)`
  },
  {
    name: '15b-job-log-summary',
    script: `
      await H.until(() => H.$('[data-test="run-log-summary"]'), 180000, 200)
      await H.sleep(900)`
  },
  {
    // A past run reopened later: the log comes from the persisted file (jobs:runLog).
    name: '15c-job-log-reopened',
    script: `
      const run = S.jobs.runs.find((r) => r.jobName === ${JSON.stringify(LIVE_JOB)})
      if (!run) throw new Error('live job run not found')
      await H.click('[data-test="run-log-close"]', 5000)
      delete S.jobLogs.buffers[run.id]
      await H.click('[data-test="run-history"] [data-test="run-open-log"]', 5000)
      await H.until(() => H.$('[data-test="run-log-summary"]'), 10000)
      const body = await H.waitFor('[data-test="run-log-body"]', 5000)
      body.scrollTop = 0
      body.dispatchEvent(new Event('scroll'))
      await H.sleep(600)`,
    cleanup: `
      const c = H.local(S)
      await S.api.invokeSilent('db:execute', c.id, 'DROP DATABASE IF EXISTS ${BIG_SCHEMA}', {})`
  },
  {
    // A 20k-line log (cap of the panel): only blocks near the viewport are in the DOM;
    // scrolled to the middle, the visible area must still be filled with lines.
    name: '15d-job-log-large',
    script: `
      const run = S.jobs.runs.find((r) => r.jobName === ${JSON.stringify(LIVE_JOB)})
      if (!run) throw new Error('live job run not found')
      await H.until(() => S.jobLogs.get(run.id) && !S.jobLogs.get(run.id).loading, 10000)
      const buf = S.jobLogs.get(run.id)
      const lines = []
      for (let i = 0; i < 20000; i++) {
        if (i % 500 === 0) lines.push('[18:30:00] Paso ' + (i / 500 + 1) + '/40 · Base de datos big' + i / 500 + ' (Local Test)')
        else lines.push('[18:30:00]   Tabla t' + i + ' ' + '.'.repeat(Math.max(3, 41 - String(i).length)) + ' ' + (String(i) + ' filas').padStart(16) + '  OK')
      }
      S.jobLogs.append({ runId: run.id, seq: buf.offset + buf.lines.length, lines })
      const body = await H.waitFor('[data-test="run-log-body"]', 5000)
      await H.sleep(400)
      body.scrollTop = Math.round(body.scrollHeight / 2)
      body.dispatchEvent(new Event('scroll'))
      await H.sleep(500)
      const rendered = document.querySelectorAll('[data-test="run-log-line"]').length
      if (rendered > 1500) throw new Error('log not windowed: ' + rendered + ' lines in the DOM')`,
    cleanup: `
      const run = S.jobs.runs.find((r) => r.jobName === ${JSON.stringify(LIVE_JOB)})
      if (run) delete S.jobLogs.buffers[run.id]`
  },
  {
    // «Restaurar todo en Local»: run the staging backup job, then open the dialog from its run.
    name: '16a-rollback-dialog',
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      await S.jobs.load()
      const job = S.jobs.jobs.find((j) => j.name === ${JSON.stringify(ROLLBACK_JOB)})
      if (!job) throw new Error('job ${ROLLBACK_JOB} not seeded (run scripts/seed-screenshots.mjs)')
      S.workspace.openAutomation()
      const row = await H.until(() => [...document.querySelectorAll('[data-test="automation-view"] tbody tr')]
        .find((r) => r.textContent.includes(job.name)), 10000)
      row.click()
      await H.sleep(300)
      await H.click('[data-test="jobs-run"]', 5000)
      await H.until(() => {
        const run = S.jobs.runs.find((r) => r.jobId === job.id && r.kind !== 'rollback')
        return run && run.status === 'success'
      }, 180000, 200)
      await H.sleep(500)
      await H.click('[data-test="run-log-close"]', 5000)
      await H.click('[data-test="run-history"] [data-test="run-rollback"]', 5000)
      await H.waitFor('[data-test="rollback-item-state"]', 20000)
      await H.settle(S, 900)`
  },
  {
    // Same dialog with «Contenido: Solo estructura»; set back to the default for the next steps.
    name: '16a2-rollback-structure',
    script: `
      await H.click('[data-test="replace-content-structure"]', 5000)
      await H.sleep(700)`,
    cleanup: `await H.click('[data-test="replace-content-data"]', 5000)`
  },
  {
    name: '16b-rollback-confirm',
    script: `
      await H.click('[data-test="rollback-submit"]', 5000)
      await H.until(() => S.ui.confirm.open, 5000)
      await H.sleep(700)`
  },
  {
    // Mid-restore: rb_shop was backed up and recreated, its big events table is being restored.
    name: '16c-rollback-live-log',
    script: `
      S.ui.answer(true)
      await H.until(() => /Tabla customers/.test(H.$('[data-test="run-log-panel"]')?.textContent || ''), 120000, 40)
      try {
        await H.until(() => /Tabla events/.test(H.$('[data-test="progress-message"]')?.textContent || ''), 20000, 40)
      } catch (e) { /* fast machine: the table may finish first */ }
      await H.sleep(150)`
  },
  {
    // Cancelling a running restore asks first (the database may stay incomplete); answered «no».
    name: '16c2-rollback-cancel-confirm',
    script: `
      await H.click('[data-test="run-history"] [data-test="run-cancel"]', 10000)
      await H.until(() => S.ui.confirm.open, 5000)
      await H.sleep(500)`,
    cleanup: `S.ui.answer(false)`
  },
  {
    name: '16d-rollback-summary',
    script: `
      await H.until(() => H.$('[data-test="run-log-summary"]'), 240000, 200)
      await H.sleep(900)`
  },
  {
    // The replaced database shows its safety copy with «Deshacer» in the run history.
    name: '16d2-rollback-history-undo',
    script: `
      const card = await H.waitFor('[data-test="run-history"] .timeline__card', 5000)
      card.click()
      await H.waitFor('[data-test="run-undo-restore"]', 5000)
      await H.sleep(600)`
  },
  {
    // «Deshacer» opens the safety copy in «Reemplazar la base de datos completa» mode.
    name: '16d3-undo-restore-dialog',
    script: `
      await H.click('[data-test="run-undo-restore"]', 5000)
      await H.waitFor('[data-test="restore-replace-warning"]', 10000)
      await H.sleep(700)`,
    cleanup: `S.ui.restoreDialog = { ...S.ui.restoreDialog, open: false }`
  },
  {
    // Backups list grouped by package: the run of «Backup staging 5.7» and a «backup-staging»
    // batch made by hand (no run: grouped by label and time); the batch is selected and expanded.
    name: '17a-backups-packages',
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      try { localStorage.removeItem('electrondb.backups.groupByPackage') } catch (e) { /* default on */ }
      for (const schema of ['rb_crm', 'rb_shop'])
        await S.api.backups.create('shots-package-' + schema, {
          connectionId: '${STAGING57}', schema, includeData: true, label: 'backup-staging'
        })
      S.workspace.openBackups('${STAGING57}', null)
      const header = await H.until(() => [...document.querySelectorAll('[data-test="backup-package"]')]
        .find((h) => h.textContent.includes('backup-staging')), 15000)
      header.click()
      await H.sleep(200)
      header.querySelector('[data-test="backup-package-toggle"]').click()
      await H.settle(S, 900)`
  },
  {
    // «Restaurar paquete en Local» opens the rollback dialog with the package's databases checked.
    name: '17b-package-rollback-dialog',
    script: `
      await H.click('[data-test="backups-restore-package"]', 5000)
      await H.waitFor('[data-test="rollback-item-state"]', 20000)
      await H.settle(S, 900)`
  },
  {
    // Only rb_shop (rb_crm holds a routine 8.4 refuses, see 16d): the confirmation lists
    // exactly what is replaced and what is created.
    name: '17c-package-rollback-confirm',
    script: `
      const item = await H.until(() => [...document.querySelectorAll('[data-test="rollback-items"] li')]
        .find((li) => li.textContent.includes('rb_crm')), 5000)
      item.querySelector('[data-test="rollback-item-check"] input').click()
      await H.sleep(300)
      await H.click('[data-test="rollback-submit"]', 5000)
      await H.until(() => S.ui.confirm.open, 5000)
      await H.sleep(700)`
  },
  {
    name: '17d-package-rollback-summary',
    script: `
      S.ui.answer(true)
      await H.until(() => H.$('[data-test="run-log-summary"]'), 180000, 200)
      await H.sleep(900)`,
    cleanup: `await H.click('[data-test="run-log-close"]', 5000).catch(() => null)`
  },
  {
    // The restore is recorded under «Restauraciones manuales» (its files come from no single job).
    name: '17e-manual-rollbacks-history',
    script: `
      S.workspace.openAutomation()
      await H.click('[data-test="jobs-manual-rollbacks"]', 10000)
      const card = await H.waitFor('[data-test="run-history"] .timeline__card', 5000)
      card.click()
      await H.settle(S, 900)`
  },
  {
    name: '16e-job-restore-step',
    script: `
      await S.jobs.load()
      const job = S.jobs.jobs.find((j) => j.name === ${JSON.stringify(STAGING_TO_LOCAL_JOB)})
      if (!job) throw new Error('job ${STAGING_TO_LOCAL_JOB} not seeded')
      // Other editors stay mounted: close them so the row clicked is this job's.
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      S.workspace.openJobEditor(job.id, job.name)
      const row = await H.until(() => [...document.querySelectorAll('[data-test="job-task-1"]')]
        .find((r) => r.getClientRects().length && /Restauración/.test(r.textContent)), 10000)
      row.click()
      await H.waitFor('[data-test="restore-source"]', 10000)
      await H.settle(S, 1200)`,
    cleanup: `
      // Scratch schemas of the rollback screens, on the 8.4 "local" and the 5.7 "staging".
      for (const id of [H.local(S).id, 'shot-staging57'])
        for (const db of ['rb_shop', 'rb_crm'])
          await S.api.invokeSilent('db:execute', id, 'DROP DATABASE IF EXISTS ' + db, {}).catch(() => null)`
  },
  // Update check screens: main answers from VORTAQ_UPDATES_FIXTURE (a fake v0.1.3).
  {
    // Startup popup in source mode (unpackaged run) with «Cómo actualizar» expanded.
    name: '18a-update-popup-source',
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      S.workspace.showObjects()
      await S.updates.runStartupCheck()
      if (S.updates.result?.status !== 'available')
        throw new Error('no update available: run with VORTAQ_UPDATES_FIXTURE (see npm run screenshots)')
      await H.until(() => S.updates.noticeOpen, 8000)
      await H.click('[data-test="update-notice-howto"]', 5000)
      await H.waitFor('[data-test="update-notice-commands"]', 5000)
      await H.settle(S, 700)`,
    cleanup: `S.updates.hideNotice()`
  },
  {
    // Needs VORTAQ_WHATS_NEW_FROM=0.1.2 and VORTAQ_WHATS_NEW_VERSION=0.1.4 (npm run screenshots sets them).
    name: '18f-whats-new',
    script: `
      await S.whatsNew.load()
      if (!S.whatsNew.info) throw new Error('nothing to show: run with VORTAQ_WHATS_NEW_FROM (see npm run screenshots)')
      await H.until(() => S.whatsNew.open, 8000)
      await H.waitFor('[data-test="whats-new"]', 5000)
      await H.settle(S, 700)`,
    cleanup: `S.whatsNew.open = false`
  },
  // Destructive confirmation on a non-production connection (cancelled: nothing is dropped).
  {
    name: '19a-drop-table-confirm',
    script: `
      const c = H.local(S)
      void S.objectActions.dropObject({ id: 'shot-drop', kind: 'object', label: 'shot_customers',
        connectionId: c.id, schema: '${SCHEMA}', group: 'tables', name: 'shot_customers', parentId: null })
      await H.waitFor('.v-dialog [data-test="confirm-items"]', 5000)
      await H.sleep(700)`,
    cleanup: `S.ui.answer(false)`
  },
  {
    name: '19b-query-destructive-confirm',
    script: `
      const c = H.local(S)
      const sql = ${JSON.stringify(DESTRUCTIVE_SQL)}
      S.workspace.openQuery(c.id, '${SCHEMA}', { sql, name: 'Limpieza' })
      await H.sleep(900)
      await H.click('[data-test="run"]', 10000)
      await H.waitFor('.v-dialog [data-test="confirm-items"]', 5000)
      await H.sleep(700)`,
    cleanup: `
      S.ui.answer(false)
      await H.sleep(300)
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)`
  },
  {
    name: '19c-settings-security',
    script: `
      S.ui.openSettingsDialog()
      const el = await H.waitFor('[data-test="settings-confirm-destructive"]', 5000)
      el.scrollIntoView({ block: 'center' })
      await H.settle(S, 900)`,
    cleanup: `S.ui.settingsDialog = false`
  },
  {
    // Ajustes › Seguridad with Producción (locked) + Staging checked. In-memory only: nothing saved.
    name: '19d-settings-typed-envs',
    script: `
      S.settings.settings = { ...S.settings.settings, typedConfirmEnvironments: ['production', 'staging'] }
      S.ui.openSettingsDialog()
      const el = await H.waitFor('[data-test="settings-typed-envs"]', 5000)
      el.scrollIntoView({ block: 'center' })
      await H.settle(S, 600)
      const prod = document.querySelector('[data-test="settings-typed-env-production"]')
      prod.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      await H.sleep(900)`,
    cleanup: `
      S.ui.settingsDialog = false
      S.settings.settings = { ...S.settings.settings, typedConfirmEnvironments: ['production'] }`
  },
  {
    // Typed confirmation on a Staging connection listed in Seguridad (cancelled: nothing is dropped).
    name: '19e-staging-typed-confirm',
    script: `
      S.settings.settings = { ...S.settings.settings, typedConfirmEnvironments: ['production', 'staging'] }
      const c = S.connections.items.find((x) => x.id === 'shot-staging')
      if (!c) throw new Error('seeded staging connection not found')
      void S.objectActions.dropObject({ id: 'shot-drop-stg', kind: 'object', label: 'shot_customers',
        connectionId: c.id, schema: '${SCHEMA}', group: 'tables', name: 'shot_customers', parentId: null })
      await H.waitFor('.v-dialog [data-test="confirm-typed"]', 5000)
      await H.sleep(700)`,
    cleanup: `
      S.ui.answer(false)
      S.settings.settings = { ...S.settings.settings, typedConfirmEnvironments: ['production'] }`
  },
  {
    // Lock next to the environment of connections that need the typed name (Staging listed).
    name: '19f-tree-typed-lock',
    script: `
      S.settings.settings = { ...S.settings.settings, typedConfirmEnvironments: ['production', 'staging'] }
      await H.waitFor('[data-test="env-lock"]', 5000)
      await H.settle(S, 600)`,
    cleanup: `S.settings.settings = { ...S.settings.settings, typedConfirmEnvironments: ['production'] }`
  },
  {
    // Not packaged here, so main reports the source mode; the packaged view uses the same answer.
    name: '18b-update-dialog-packaged',
    script: `
      S.updates.showDetails()
      S.updates.result = { ...S.updates.result, runMode: 'packaged', source: undefined }
      await H.waitFor('[data-test="update-packaged"]', 5000)
      await H.settle(S, 700)`,
    cleanup: `S.updates.dialogOpen = false`
  },
  {
    name: '18c-update-dialog-source',
    script: `
      S.updates.openDialog()
      await H.until(() => !S.updates.checking, 10000)
      if (S.updates.result?.runMode !== 'source') throw new Error('expected source mode (unpackaged run)')
      await H.waitFor('[data-test="update-source"]', 5000)
      await H.settle(S, 700)`,
    cleanup: `S.updates.dialogOpen = false`
  },
  {
    name: '18d-update-dialog-uptodate',
    script: `
      const r = S.updates.result
      S.updates.result = { status: 'up-to-date', currentVersion: r.currentVersion, latestVersion: r.currentVersion,
        releaseUrl: r.releaseUrl.replace(/v[0-9.]+$/, 'v' + r.currentVersion), runMode: r.runMode }
      S.updates.showDetails()
      await H.waitFor('[data-test="update-uptodate"]', 5000)
      await H.settle(S, 700)`,
    cleanup: `S.updates.dialogOpen = false`
  },
  {
    name: '18e-update-dialog-error',
    script: `
      S.updates.result = { status: 'error', currentVersion: S.updates.result.currentVersion, runMode: 'packaged',
        error: 'GitHub ha limitado temporalmente las consultas desde tu red. Vuelve a intentarlo dentro de un rato (el límite se renueva cada hora).' }
      S.updates.showDetails()
      await H.waitFor('[data-test="update-error"]', 5000)
      await H.settle(S, 700)`,
    cleanup: `S.updates.dialogOpen = false`
  },
  {
    // AI assistant with the fake provider (VORTAQ_AI_FIXTURE=1): a conversation with an SQL block.
    name: '20a-ai-panel-chat',
    script: `
      const c = H.local(S)
      S.workspace.openQuery(c.id, '${SCHEMA}', { sql: 'SELECT * FROM shot_orders LIMIT 10;', name: 'Pedidos' })
      await H.sleep(900)
      S.ui.toggleAiPanel(true)
      await S.ai.loadProviders()
      S.ai.newConversation()
      await H.waitFor('[data-test="ai-panel"]', 5000)
      await S.ai.send('chat', '¿Qué clientes han pagado más pedidos en los últimos 30 días?')
      await H.until(() => !S.ai.busy, 20000)
      await H.waitFor('[data-test="ai-code-block"]', 5000)
      await H.settle(S, 700)`
  },
  {
    name: '20b-ai-context-dialog',
    script: `
      await H.click('[data-test="ai-context"]', 5000)
      await H.until(() => /shot_orders/.test(H.$('[data-test="ai-context-text"]')?.textContent || ''), 15000)
      await H.sleep(500)`,
    cleanup: `
      const close = [...document.querySelectorAll('[data-test="ai-context-dialog"] button')].find((b) => /Cerrar/.test(b.textContent))
      close?.click()`
  },
  {
    // «Qué ve el asistente»: only the selected database or the whole connection.
    name: '20b2-ai-scope-menu',
    script: `
      await H.click('[data-test="ai-scope"]', 5000)
      await H.waitFor('[data-test="ai-scope-connection"]', 5000)
      await H.sleep(400)`,
    cleanup: `
      document.querySelector('[data-test="ai-scope-connection"]')?.click()
      await H.sleep(300)`
  },
  {
    name: '20b3-ai-context-whole-connection',
    script: `
      await H.click('[data-test="ai-context"]', 5000)
      await H.until(() => /Conexión completa/.test(H.$('[data-test="ai-context-text"]')?.textContent || ''), 15000)
      await H.sleep(500)`,
    cleanup: `
      const close = [...document.querySelectorAll('[data-test="ai-context-dialog"] button')].find((b) => /Cerrar/.test(b.textContent))
      close?.click()
      S.ai.scope = 'database'`
  },
  {
    name: '20c-ai-generate-sql',
    script: `
      await H.click('[data-test="ai-generate"]', 5000)
      const input = await H.waitFor('[data-test="ai-generate-input"] textarea', 5000)
      input.value = 'Pedidos pendientes más recientes con el nombre del cliente'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await H.sleep(600)`
  },
  {
    // Same dialog after «Generar e insertar»: the SQL is in the editor, not executed.
    name: '20d-ai-generated-inserted',
    script: `
      await H.click('[data-test="ai-generate-run"]', 5000)
      await H.until(() => !H.$('[data-test="ai-generate-dialog"]'), 15000)
      await H.until(() => /shot_customers c ON c.id = o.customer_id/.test(H.$('.cm-content')?.textContent || ''), 5000)
      await H.sleep(700)`
  },
  {
    name: '20e-settings-ai',
    script: `
      // The «SQL insertado» toast of the previous step would cover the dialog.
      document.querySelectorAll('.v-snackbar button').forEach((b) => b.click())
      S.ui.openSettingsDialog()
      const section = await H.waitFor('[data-test="settings-ai"]', 5000)
      section.scrollIntoView({ block: 'start' })
      await H.sleep(700)`,
    cleanup: `
      S.ui.settingsDialog = false
      S.ui.toggleInfoPanel(true)`
  },
  {
    name: '15-light-theme-home',
    script: `
      // Last step: drop the work tabs (no guards needed in a scratch profile) for a clean home.
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      S.workspace.showObjects()
      S.tree.select(null)
      S.settings.settings = { ...S.settings.settings, theme: 'light' }
      await H.settle(S, 1200)`,
    cleanup: `S.settings.settings = { ...S.settings.settings, theme: 'dark' }`
  }
]

/**
 * .vqb copies (VORTAQ_SHOTS_ONLY=50): «Nueva copia» with format and encryption,
 * a locked .vqb in the list (it is created here, encrypted, in Local Test's
 * folder) and the password prompt of «Restaurar».
 */
const VQB_PASSWORD = 'clave de ejemplo'
const VQB_STEPS: Step[] = [
  {
    name: '50a-backup-dialog-vqb-encrypt',
    script: `
      const c = H.local(S)
      S.ui.openBackupDialog(c.id, '${SCHEMA}')
      await H.waitFor('[data-test="backup-dialog"]', 5000)
      await H.click('[data-test="backup-format-vqb"]', 5000)
      await H.click('[data-test="backup-encrypt"] input', 5000)
      const set = async (sel, value) => {
        const input = await H.waitFor(sel, 5000)
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await set('[data-test="backup-password"] input', ${JSON.stringify(VQB_PASSWORD)})
      await set('[data-test="backup-password-again"] input', ${JSON.stringify(VQB_PASSWORD)})
      const label = await H.waitFor('[data-test="backup-dialog"] input[placeholder="p. ej. antes-migracion"]', 5000)
      label.value = 'cifrada'
      label.dispatchEvent(new Event('input', { bubbles: true }))
      await H.waitFor('[data-test="backup-password-warning"]', 5000)
      await H.settle(S, 900)`,
    cleanup: `S.ui.backupDialog = { ...S.ui.backupDialog, open: false }`
  },
  {
    name: '50b-backups-locked-vqb',
    script: `
      const c = H.local(S)
      // An encrypted .vqb of the test schema, made through the real backup channel.
      const made = await S.api.backups.create('shot-vqb-' + Date.now(), {
        connectionId: c.id,
        schema: '${SCHEMA}',
        includeData: true,
        format: 'vqb',
        password: ${JSON.stringify(VQB_PASSWORD)},
        label: 'cifrada'
      })
      window.__ndShotVqb = made.path
      S.workspace.openBackups(c.id, null)
      await H.click('[data-test="backups-refresh"]', 10000)
      const name = made.path.split('/').pop()
      const row = await H.until(() =>
        [...document.querySelectorAll('[data-test="backup-row"]')].find((r) => r.textContent.includes(name)), 10000)
      row.click()
      await H.waitFor('[data-test="backup-password"]', 8000)
      await H.settle(S, 1200)`
  },
  {
    name: '50c-restore-password-prompt',
    script: `
      const c = H.local(S)
      const files = await S.api.backups.list(c.id, null)
      const file = files.find((f) => f.path === window.__ndShotVqb) || files.find((f) => f.encrypted)
      if (!file) throw new Error('no encrypted .vqb listed (run 50b first)')
      S.ui.openRestoreDialog(file, c.id)
      await H.waitFor('[data-test="restore-dialog"] [data-test="backup-password"]', 8000)
      await H.settle(S, 1000)`,
    cleanup: `S.ui.restoreDialog = { open: false, backup: null, connectionId: null }`
  }
]
STEPS.push(...VQB_STEPS)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Welcome tour, Navicat detection and «Mostrarme cómo» (VORTAQ_SHOTS_ONLY=21).
 * Run them on a fresh scratch profile with
 * VORTAQ_NAVICAT_CANDIDATES=tests/fixtures/navicat (the anonymised fixture
 * instead of the real Navicat folder) and, for 21f/21g,
 * VORTAQ_WHATS_NEW_FROM=0.1.5 VORTAQ_WHATS_NEW_VERSION=0.1.7.
 */
const TOUR_STEPS: Step[] = [
  {
    name: '21a-tour-welcome',
    script: `
      await S.tour.startWelcome()
      await H.waitFor('[data-test="tour-welcome"]', 8000)
      await H.sleep(500)`
  },
  {
    name: '21b-tour-connections',
    script: `
      S.tour.next()
      await H.until(() => S.tour.index === 1)
      await H.sleep(700)`
  },
  {
    name: '21c-tour-ai',
    script: `
      S.tour.index = 6
      await H.sleep(700)`
  },
  {
    name: '21d-tour-navicat-detected',
    script: `
      S.tour.index = S.tour.steps.length - 1
      await H.waitFor('[data-test="tour-import-detected"]', 5000)
      await H.sleep(700)`,
    cleanup: `S.tour.skip()`
  },
  {
    name: '21e-import-confirm',
    script: `
      // Only in the renderer: an empty stored path makes the dialog search (fixture folder).
      S.settings.settings.navicatRootPath = ''
      S.ui.openImportDialog()
      await H.waitFor('[data-test="import-proposal"]', 8000)
      await H.sleep(600)`,
    cleanup: `S.ui.importDialog = false`
  },
  {
    name: '21f-whats-new-show-me',
    script: `
      await S.whatsNew.load()
      if (!S.whatsNew.tourSteps.length)
        throw new Error('no «Mostrarme cómo» steps: run with VORTAQ_WHATS_NEW_FROM=0.1.5 VORTAQ_WHATS_NEW_VERSION=0.1.7')
      S.whatsNew.open = true
      await H.waitFor('[data-test="whats-new-show-me"]', 5000)
      await H.sleep(600)`
  },
  {
    name: '21g-whats-new-tour',
    script: `
      await H.click('[data-test="whats-new-show-me"]', 5000)
      await H.until(() => S.tour.active, 8000)
      await H.sleep(800)`,
    cleanup: `S.tour.skip()`
  }
]
STEPS.push(...TOUR_STEPS)

/**
 * «Importar…» wizard (VORTAQ_SHOTS_ONLY=30): needs the files seeded by
 * scripts/seed-screenshots.mjs, VORTAQ_IMPORT_HOME (DBeaver's file at its usual
 * place) and VORTAQ_IMPORT_PICK (the dump the wizard «picks»), both set by
 * `npm run screenshots`.
 */
const IMPORT_STEPS: Step[] = [
  {
    name: '30a-import-sources',
    script: `
      S.ui.openImportWizard()
      await H.waitFor('[data-test="import-source-dbeaver"]', 8000)
      await H.sleep(600)`
  },
  {
    name: '30b-import-dbeaver-preview',
    script: `
      await H.click('[data-test="import-source-dbeaver"]', 5000)
      await H.click('[data-test="import-file-use"]', 8000)
      await H.waitFor('[data-test="import-connection-row"]', 8000)
      await H.sleep(600)`,
    cleanup: `S.ui.importWizard = false`
  },
  {
    name: '30c-import-sql-options',
    script: `
      S.ui.openImportWizard()
      await H.click('[data-test="import-source-sql-dump"]', 8000)
      await H.click('[data-test="import-file-pick"]', 5000)
      await H.waitFor('[data-test="dump-inspection"]', 30000)
      const box = await H.waitFor('[data-test="dump-continue"] input', 5000)
      if (!box.checked) box.click()
      await H.sleep(800)`
  },
  {
    name: '30d-import-sql-progress',
    script: `
      await H.click('[data-test="dump-run"]', 5000)
      await H.until(
        () => H.$('[data-test="dump-progress"]') && (H.$('[data-test="import-log"]')?.children.length ?? 0) >= 3,
        30000,
        50
      )
      await H.sleep(120)`
  },
  {
    name: '30e-import-sql-summary',
    script: `
      await H.waitFor('[data-test="dump-result"]', 180000)
      await H.sleep(600)`,
    cleanup: `S.ui.importWizard = false`
  }
]
STEPS.push(...IMPORT_STEPS)

/**
 * PostgreSQL (preview) and MariaDB screens (VORTAQ_SHOTS_ONLY=40,41): need the
 * profile and server fixtures of scripts/seed-engine-shots.mjs (connections
 * «PostgreSQL Local» and «MariaDB Local», schema `tienda`, database `shots_maria`).
 */
const PG_ID = 'shot-pg'
const PG_DB = 'navidog_test'
const MARIA_ID = 'shot-maria'
const ENGINE_STEPS: Step[] = [
  {
    name: '40a-pg-connection-dialog',
    script: `
      S.ui.openConnectionDialog(S.connections.get('${PG_ID}'))
      await H.waitFor('[data-test="pg-initial-database"], [data-test="connection-dialog"]', 8000)
      await H.sleep(700)`,
    cleanup: `S.ui.connectionDialog = { ...S.ui.connectionDialog, open: false }`
  },
  {
    name: '40b-pg-tree-schemas',
    script: `
      S.ui.toggleInfoPanel(true)
      await S.tree.expand(S.tree.parse('c:${PG_ID}'))
      if (!S.connections.isOpen('${PG_ID}')) throw new Error('could not open PostgreSQL Local')
      await S.tree.expand(S.tree.parse('d:${PG_ID}:${PG_DB}'))
      S.tree.setExpanded('s:${PG_ID}:tienda:${PG_DB}', true)
      await S.tree.expand(S.tree.parse('g:${PG_ID}:tienda:tables:${PG_DB}'))
      await S.tree.expand(S.tree.parse('g:${PG_ID}:tienda:functions:${PG_DB}'))
      await S.tree.expand(S.tree.parse('g:${PG_ID}:tienda:materializedViews:${PG_DB}'))
      S.tree.select('g:${PG_ID}:tienda:tables:${PG_DB}')
      S.workspace.showObjects()
      await H.settle(S, 1200)`
  },
  {
    name: '40c-pg-query-transaction',
    script: `
      const sql = [
        "BEGIN;",
        "UPDATE pedidos SET estado = 'pagado' WHERE id = 2;",
        "SELECT p.id, p.estado, p.total, p.creado FROM pedidos p ORDER BY p.id;"
      ].join('\\n')
      S.workspace.openQuery('${PG_ID}', 'tienda', { sql, name: 'Cobrar pedido' }, '${PG_DB}')
      await H.sleep(1200)
      await H.click('[data-test="run"]', 10000)
      await H.waitFor('[data-test="tx-status"]', 15000)
      await H.sleep(900)`
  },
  {
    name: '40d-pg-table-data',
    script: `
      S.workspace.openTableData('${PG_ID}', 'tienda', 'clientes', '${PG_DB}')
      await H.waitFor('.v-window-item--active table tbody tr, table tbody tr', 15000).catch(() => null)
      await H.settle(S, 1600)`
  },
  {
    name: '40e-pg-designer',
    script: `
      S.workspace.openTableDesigner('${PG_ID}', 'tienda', 'pedidos', '${PG_DB}')
      await H.settle(S, 2000)`
  },
  {
    // Partitioned table with its partitions (and a sub-partitioned one) nested in the tree.
    name: '40f-pg-partitions',
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      await S.tree.expand(S.tree.parse('c:${PG_ID}'))
      await S.tree.expand(S.tree.parse('d:${PG_ID}:${PG_DB}'))
      S.tree.setExpanded('s:${PG_ID}:tienda:${PG_DB}', true)
      S.tree.setExpanded('g:${PG_ID}:tienda:functions:${PG_DB}', false)
      S.tree.setExpanded('g:${PG_ID}:tienda:materializedViews:${PG_DB}', false)
      await S.tree.loadGroup('${PG_ID}', 'tienda', 'tables', true, '${PG_DB}')
      await S.tree.expand(S.tree.parse('g:${PG_ID}:tienda:tables:${PG_DB}'))
      S.tree.setExpanded('o:${PG_ID}:tienda:tables:ventas:${PG_DB}', true)
      S.tree.setExpanded('o:${PG_ID}:tienda:tables:ventas_2026:${PG_DB}', true)
      S.tree.select('o:${PG_ID}:tienda:tables:ventas_2026:${PG_DB}')
      S.workspace.openTableData('${PG_ID}', 'tienda', 'ventas', '${PG_DB}')
      await H.settle(S, 1500)`
  },
  {
    // «Cerrar base de datos» on an open database (not the initial one).
    name: '40g-pg-close-database',
    script: `
      await S.tree.expand(S.tree.parse('d:${PG_ID}:tienda_archivo'))
      await H.settle(S, 600)
      const row = document.querySelector('[data-node-id="d:${PG_ID}:tienda_archivo"] .tree-node__row')
      if (!row) throw new Error('database node not rendered')
      const r = row.getBoundingClientRect()
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 120, clientY: r.top + 14 }))
      await H.until(() => [...document.querySelectorAll('.v-list-item')].some((i) => /Cerrar base de datos/.test(i.textContent)), 5000)
      await H.sleep(500)`,
    cleanup: `
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await H.sleep(200)
      await S.tree.closeDatabase('${PG_ID}', 'tienda_archivo')`
  },
  {
    // AI scope on PostgreSQL: «Toda la conexión» means every schema of the tab's database.
    name: '40h-pg-ai-scope',
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      S.workspace.openQuery('${PG_ID}', 'tienda', { sql: 'SELECT * FROM ventas;', name: 'Ventas' }, '${PG_DB}')
      await H.sleep(900)
      S.ui.toggleAiPanel(true)
      await S.ai.loadProviders()
      S.ai.scope = 'connection'
      await H.waitFor('[data-test="ai-panel"]', 5000)
      await H.click('[data-test="ai-scope"]', 5000)
      await H.waitFor('[data-test="ai-scope-connection"]', 5000)
      await H.sleep(500)`,
    cleanup: `
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await H.sleep(200)`
  },
  {
    name: '40i-pg-ai-context',
    script: `
      await H.click('[data-test="ai-context"]', 5000)
      await H.until(() => /todos sus esquemas/.test(H.$('[data-test="ai-context-text"]')?.textContent || ''), 15000)
      await H.sleep(500)`,
    cleanup: `
      const close = [...document.querySelectorAll('[data-test="ai-context-dialog"] button')].find((b) => /Cerrar/.test(b.textContent))
      close?.click()
      S.ai.scope = 'database'
      S.ui.toggleAiPanel(false)`
  },
  {
    name: '41a-mariadb-versioned-table',
    script: `
      await S.tree.expand(S.tree.parse('c:${MARIA_ID}'))
      if (!S.connections.isOpen('${MARIA_ID}')) throw new Error('could not open MariaDB Local')
      S.tree.setExpanded('s:${MARIA_ID}:shots_maria', true)
      await S.tree.expand(S.tree.parse('g:${MARIA_ID}:shots_maria:tables'))
      S.tree.select('o:${MARIA_ID}:shots_maria:tables:precios')
      S.workspace.openTableData('${MARIA_ID}', 'shots_maria', 'precios')
      await H.waitFor('.v-window-item--active table tbody tr, table tbody tr', 15000).catch(() => null)
      await H.settle(S, 1600)`
  },
  {
    name: '41b-mariadb-connection-dialog',
    script: `
      S.ui.openConnectionDialog(null, 'mariadb')
      await H.waitFor('[data-test="conn-engine-mariadb"]', 8000)
      await H.sleep(700)`,
    cleanup: `S.ui.connectionDialog = { ...S.ui.connectionDialog, open: false }`
  },
  {
    // Sequences group (MariaDB engine) in the tree and the objects list.
    name: '41c-mariadb-tree-sequences',
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      S.ui.toggleInfoPanel(true)
      await S.tree.expand(S.tree.parse('c:${MARIA_ID}'))
      S.tree.setExpanded('s:${MARIA_ID}:shots_maria', true)
      await S.tree.expand(S.tree.parse('g:${MARIA_ID}:shots_maria:tables'))
      await S.tree.expand(S.tree.parse('g:${MARIA_ID}:shots_maria:sequences'))
      S.tree.select('g:${MARIA_ID}:shots_maria:sequences')
      S.workspace.showObjects()
      await H.settle(S, 1200)`
  },
  {
    // Designer: the MariaDB types (uuid, json, inet6, inet4) and the type list filtered to INET.
    name: '41d-mariadb-designer-types',
    script: `
      S.workspace.openTableDesigner('${MARIA_ID}', 'shots_maria', 'catalogo')
      await H.settle(S, 1500)
      const combo = document.querySelectorAll('.designer-combo input')[4]
      if (!combo) throw new Error('type combobox not found')
      combo.closest('.v-field')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      combo.focus()
      combo.click()
      // The list starts at the top: scroll to json, uuid, inet4, inet6.
      const list = await H.waitFor('.v-overlay--active .v-list', 5000)
      for (let i = 0; i < 10 && ![...list.querySelectorAll('.v-list-item')].some((x) => /inet6/.test(x.textContent)); i++) {
        list.scrollTop += 240
        await H.sleep(120)
      }
      await H.until(() => [...document.querySelectorAll('.v-list-item')].some((i) => /inet6/.test(i.textContent)), 5000)
      await H.sleep(500)`,
    cleanup: `
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await H.sleep(200)`
  },
  {
    // Designer «Opciones» of a system-versioned table.
    name: '41e-mariadb-designer-versioning',
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable && t.kind === 'tableDesigner') S.tabs.close(t.id)
      S.workspace.openTableDesigner('${MARIA_ID}', 'shots_maria', 'precios')
      await H.settle(S, 1500)
      const tab = [...document.querySelectorAll('.v-tab')].find((t) => /Opciones/.test(t.textContent))
      if (!tab) throw new Error('Opciones tab not found')
      tab.click()
      await H.waitFor('[data-test="mariadb-system-versioning"]', 5000)
      await H.sleep(600)`
  },
  {
    // .vqb backup of a MariaDB database: its sequences can be picked like tables and views.
    name: '41f-mariadb-backup-sequences',
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      S.ui.openBackupDialog('${MARIA_ID}', 'shots_maria', { format: 'vqb' })
      await H.waitFor('[data-test="backup-objects"]', 8000)
      await H.sleep(1200)
      const field = await H.waitFor('[data-test="backup-objects"] .v-field', 5000)
      field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await H.until(() => [...document.querySelectorAll('.v-list-item')].some((i) => /seq_/.test(i.textContent)), 8000)
      await H.sleep(600)`,
    cleanup: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); S.ui.backupDialog = { ...S.ui.backupDialog, open: false }`
  },
  {
    // The same database as .nb3: the dialog says what that format cannot hold.
    name: '41g-mariadb-backup-nb3-warning',
    script: `
      S.ui.openBackupDialog('${MARIA_ID}', 'shots_maria', { format: 'nb3' })
      await H.waitFor('[data-test="backup-skipped-warning"]', 10000)
      await H.sleep(800)`,
    cleanup: `S.ui.backupDialog = { ...S.ui.backupDialog, open: false }`
  }
]
STEPS.push(...ENGINE_STEPS)

/**
 * 2.0.0 screens that need no particular server (VORTAQ_SHOTS_ONLY=44): the
 * «Conexión» menu with every engine and the engine picker of a new connection.
 */
const V2_STEPS: Step[] = [
  {
    name: '44a-new-connection-menu',
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      await H.click('[data-tour="toolbar-connection"] .app-toolbar__caret', 8000)
      await H.until(() => [...document.querySelectorAll('.v-list-item')].some((i) => /MongoDB/.test(i.textContent)), 5000)
      await H.sleep(500)`,
    cleanup: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  },
  {
    name: '44b-new-connection-engines',
    script: `
      S.ui.openConnectionDialog(null)
      await H.waitFor('[data-test="conn-engine-picker"]', 8000)
      await H.sleep(700)`,
    cleanup: `S.ui.connectionDialog = { ...S.ui.connectionDialog, open: false }`
  }
]
STEPS.push(...V2_STEPS)

/**
 * SQLite (preview) screens (VORTAQ_SHOTS_ONLY=42): need the profile and files of
 * scripts/seed-sqlite-shots.mjs (connection «Tienda (SQLite)» with an attached
 * `archivo`, and «Inventario (importada)» whose path came from another computer).
 */
const LITE_ID = 'shot-lite'
const SQLITE_STEPS: Step[] = [
  {
    name: '42a-sqlite-new-connection',
    script: `
      S.ui.openConnectionDialog(null, 'sqlite')
      await H.waitFor('[data-test="sqlite-open-file"]', 8000)
      await H.sleep(700)`,
    cleanup: `S.ui.connectionDialog = { ...S.ui.connectionDialog, open: false }`
  },
  {
    name: '42b-sqlite-connection-dialog',
    script: `
      S.ui.openConnectionDialog(S.connections.get('${LITE_ID}'))
      await H.waitFor('[data-test="sqlite-path"]', 8000)
      await H.sleep(700)`,
    cleanup: `S.ui.connectionDialog = { ...S.ui.connectionDialog, open: false }`
  },
  {
    name: '42c-sqlite-imported-path',
    script: `
      S.ui.openConnectionDialog(S.connections.get('shot-lite-import'))
      await H.waitFor('[data-test="sqlite-path-review"]', 8000)
      await H.sleep(700)`,
    cleanup: `S.ui.connectionDialog = { ...S.ui.connectionDialog, open: false }`
  },
  {
    name: '42d-sqlite-tree',
    script: `
      S.ui.toggleInfoPanel(true)
      await S.tree.expand(S.tree.parse('c:${LITE_ID}'))
      if (!S.connections.isOpen('${LITE_ID}')) throw new Error('could not open Tienda (SQLite)')
      S.tree.setExpanded('s:${LITE_ID}:main', true)
      S.tree.setExpanded('s:${LITE_ID}:archivo', true)
      for (const g of ['tables', 'views', 'indexes', 'triggers'])
        await S.tree.expand(S.tree.parse('g:${LITE_ID}:main:' + g))
      S.tree.select('g:${LITE_ID}:main:tables')
      S.workspace.showObjects()
      await H.settle(S, 1200)`
  },
  {
    name: '42e-sqlite-query-transaction',
    script: `
      const sql = [
        "BEGIN;",
        "UPDATE pedidos SET estado = 'pagado' WHERE id = 2;",
        "SELECT id, cliente_id, estado, total FROM pedidos ORDER BY id;"
      ].join('\\n')
      S.workspace.openQuery('${LITE_ID}', 'main', { sql, name: 'Cobrar pedido' })
      await H.sleep(1200)
      await H.click('[data-test="run"]', 10000)
      await H.waitFor('[data-test="tx-status"]', 15000)
      await H.sleep(900)`
  },
  {
    name: '42f-sqlite-other-tab',
    script: `
      S.workspace.openQuery('${LITE_ID}', 'main', { sql: 'SELECT * FROM pedidos_pendientes;', name: 'Pendientes' })
      await H.sleep(1200)
      await H.click('[data-test="run"]', 10000)
      await H.waitFor('[data-test="tx-elsewhere"]', 15000)
      await H.sleep(900)`
  },
  {
    name: '42h-sqlite-designer-rebuild',
    script: `
      S.workspace.openTableDesigner('${LITE_ID}', 'main', 'clientes')
      await H.waitFor('[data-test="column-nullable-2"]', 15000)
      await H.settle(S, 800)
      // email: NULL -> NOT NULL needs the rebuild procedure.
      await H.click('[data-test="column-nullable-2"]', 5000)
      await H.waitFor('[data-test="rebuild-note"]', 8000)
      await H.click('[data-test="tab-sql"]', 5000)
      await H.waitFor('[data-test="sql-preview"]', 8000)
      await H.sleep(900)`
  },
  {
    name: '42g-sqlite-table-data',
    script: `
      S.workspace.openTableData('${LITE_ID}', 'main', 'clientes')
      await H.waitFor('.v-window-item--active table tbody tr, table tbody tr', 15000).catch(() => null)
      await H.settle(S, 1600)`
  },
  {
    // A SQLite job: encrypted .vqb backup of main, then a restore into another SQLite file.
    name: '42i-sqlite-job-editor',
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      await S.jobs.load()
      const job = S.jobs.sorted.find((j) => j.id === 'shot-job-lite')
      if (!job) throw new Error('SQLite job not seeded (run scripts/seed-sqlite-shots.mjs)')
      S.workspace.openJobEditor(job.id, job.name)
      await H.waitFor('[data-test="job-task-1"]', 10000)
      await H.settle(S, 1200)`
  },
  {
    // «Recientes» in a new SQLite connection: files opened or created before.
    name: '42j-sqlite-recent-files',
    script: `
      localStorage.setItem('electrondb.sqlite.recentFiles', JSON.stringify([
        S.connections.get('${LITE_ID}').sqlite.filePath,
        S.connections.get('shot-lite-copy').sqlite.filePath
      ]))
      S.ui.openConnectionDialog(null, 'sqlite')
      await H.click('[data-test="sqlite-recent"]', 8000)
      await H.until(() => document.querySelector('.v-menu .v-list-item, .v-overlay .v-list-item'), 5000)
      await H.sleep(600)`,
    cleanup: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); S.ui.connectionDialog = { ...S.ui.connectionDialog, open: false }; localStorage.removeItem('electrondb.sqlite.recentFiles')`
  }
]
STEPS.push(...SQLITE_STEPS)

/**
 * MongoDB (preview) screens (VORTAQ_SHOTS_ONLY=43): need the profile and the
 * `tienda_shots` database of scripts/seed-mongo-shots.mjs (connection
 * «Tienda (MongoDB)» on the throwaway test server).
 */
const MONGO_ID = 'shot-mongo'
const MONGO_DB = 'tienda_shots'
const MONGO_STEPS: Step[] = [
  {
    name: '43a-mongo-connection-dialog',
    script: `
      S.ui.openConnectionDialog(S.connections.get('${MONGO_ID}'))
      await H.waitFor('[data-test="conn-mongo-topology"]', 8000)
      await H.sleep(700)`,
    cleanup: `S.ui.connectionDialog = { ...S.ui.connectionDialog, open: false }`
  },
  {
    name: '43b-mongo-tree',
    script: `
      S.ui.toggleInfoPanel(true)
      await S.tree.expand(S.tree.parse('c:${MONGO_ID}'))
      if (!S.connections.isOpen('${MONGO_ID}')) throw new Error('could not open Tienda (MongoDB)')
      S.tree.setExpanded('s:${MONGO_ID}:${MONGO_DB}', true)
      for (const g of ['collections', 'views', 'indexes'])
        await S.tree.expand(S.tree.parse('g:${MONGO_ID}:${MONGO_DB}:' + g))
      S.tree.select('g:${MONGO_ID}:${MONGO_DB}:collections')
      S.workspace.showObjects()
      await H.settle(S, 1200)`
  },
  {
    // Connection info panel: topology, member and the read preference in Spanish.
    name: '43b2-mongo-info-panel',
    script: `
      S.ui.toggleInfoPanel(true)
      S.tree.select('c:${MONGO_ID}')
      await H.settle(S, 1500)`
  },
  {
    name: '43c-mongo-documents-grid',
    script: `
      S.workspace.openCollection('${MONGO_ID}', '${MONGO_DB}', 'clientes')
      await H.waitFor('[data-test="doc-row-0"]', 15000)
      await H.click('[data-test="doc-row-1"] td', 5000)
      await H.settle(S, 900)`
  },
  {
    name: '43d-mongo-documents-json',
    script: `
      await H.click('[data-test="mode-json"]', 8000)
      await H.waitFor('[data-test="document-json"]', 8000)
      await H.sleep(700)`
  },
  {
    name: '43e-mongo-documents-tree',
    script: `
      await H.click('[data-test="mode-tree"]', 8000)
      await H.waitFor('[data-test="document-tree"]', 8000)
      await H.sleep(700)`,
    cleanup: `H.$('[data-test="mode-table"]')?.click()`
  },
  {
    name: '43f-mongo-document-editor',
    script: `
      await H.waitFor('[data-test="doc-row-0"]', 8000)
      await H.click('[data-test="doc-row-0"] td', 5000)
      await H.click('[data-test="doc-edit"]', 5000)
      await H.waitFor('[data-test="document-editor"] .cm-content', 8000)
      await H.sleep(900)`,
    cleanup: `document.querySelector('[data-test="document-editor"]')?.closest('.v-overlay')?.querySelector('.v-btn')?.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  },
  {
    name: '43g-mongo-typed-editor',
    script: `
      await H.sleep(500)
      const cells = [...document.querySelectorAll('[data-test="doc-row-0"] td')]
      const header = [...document.querySelectorAll('.document-grid th')].map((th) => th.textContent.trim())
      const col = header.findIndex((h) => h.startsWith('puntos'))
      cells[col].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await H.waitFor('[data-test="typed-value-dialog"]', 8000)
      await H.sleep(700)`,
    cleanup: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  },
  {
    name: '43h-mongo-query-aggregate',
    script: `
      const sql = [
        "db.pedidos.aggregate([",
        "  { $match: { estado: { $in: ['pendiente', 'pagado'] } } },",
        "  { $group: { _id: '$estado', pedidos: { $sum: 1 }, total: { $sum: '$total' } } },",
        "  { $sort: { total: -1 } }",
        "])",
        "db.clientes.find({ 'direccion.ciudad': 'Lima' }, { nombre: 1, email: 1 })"
      ].join('\\n')
      S.workspace.openQuery('${MONGO_ID}', '${MONGO_DB}', { sql, name: 'Pedidos por estado' })
      await H.sleep(1200)
      await H.click('[data-test="run"]', 10000)
      await H.waitFor('[data-test="tab-result-0"]', 15000)
      await H.waitFor('[data-test="doc-row-0"]', 15000)
      await H.sleep(900)`
  },
  {
    name: '43i-mongo-index-manager',
    script: `
      S.workspace.openCollectionDesigner('${MONGO_ID}', '${MONGO_DB}', 'clientes', 'indexes')
      await H.waitFor('[data-test="index-row-email_unico"]', 15000)
      await H.click('[data-test="index-new"]', 5000)
      await H.waitFor('[data-test="index-form"]', 5000)
      const field = await H.waitFor('[data-test="index-field-0"] input', 5000)
      field.value = 'creado'
      field.dispatchEvent(new Event('input', { bubbles: true }))
      await H.sleep(800)`
  },
  {
    name: '43j-mongo-validator',
    script: `
      await H.click('[data-test="designer-validator"]', 8000)
      await H.waitFor('.collection-designer__editor .cm-content', 8000)
      await H.sleep(900)`
  },
  {
    name: '43k-mongo-backup-dialog',
    script: `
      S.ui.openBackupDialog('${MONGO_ID}', '${MONGO_DB}')
      await H.waitFor('[data-test="backup-dialog"], .v-overlay--active .v-card', 8000)
      await H.sleep(1200)`,
    cleanup: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  },
  {
    // A MongoDB job: backup of the database, then a restore into a test database.
    name: '43l-mongo-job-editor',
    script: `
      S.ui.backupDialog = { ...S.ui.backupDialog, open: false }
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      await S.jobs.load()
      const job = S.jobs.sorted.find((j) => j.id === 'shot-job-mongo')
      if (!job) throw new Error('MongoDB job not seeded (run scripts/seed-mongo-shots.mjs)')
      S.workspace.openJobEditor(job.id, job.name)
      await H.waitFor('[data-test="job-task-1"]', 10000)
      await H.settle(S, 1200)`
  },
  {
    name: '43m-mongo-duplicate-collection',
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      S.ui.openDuplicateCollection('${MONGO_ID}', '${MONGO_DB}', 'clientes')
      await H.waitFor('[data-test="duplicate-name"]', 8000)
      await H.sleep(700)`,
    cleanup: `S.ui.duplicateCollectionDialog = { ...S.ui.duplicateCollectionDialog, open: false }`
  }
]
STEPS.push(...MONGO_STEPS)

/**
 * Job editor screens (VORTAQ_SHOTS_ONLY=45): need the profile and server
 * fixtures of scripts/seed-automation-shots.mjs (job «Copia nocturna
 * multimotor» across MySQL, PostgreSQL, MongoDB and MariaDB).
 */
const AUTO_JOB = 'shot-auto-multi'
const AUTO_LOCAL = 'shot-auto-local'
/** Opens the seeded job in a clean workspace, on the «Pasos» section. */
const OPEN_AUTO_JOB = `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      await S.jobs.load()
      const job = S.jobs.jobs.find((j) => j.id === '${AUTO_JOB}')
      if (!job) throw new Error('job not seeded (run scripts/seed-automation-shots.mjs)')
      S.workspace.openJobEditor(job.id, job.name)
      await H.waitFor('[data-test="job-task-4"]', 10000)`
const SAVED_QUERIES = JSON.stringify([
  {
    id: 'sq-1',
    name: 'Cerrar pedidos pagados',
    sql: "UPDATE pedidos SET estado = 'cerrado' WHERE estado = 'pagado';",
    schema: 'ventas',
    updatedAt: '2026-10-01T09:00:00.000Z'
  },
  {
    id: 'sq-2',
    name: 'Recalcular totales',
    sql: 'CALL recalcular_totales();',
    schema: 'ventas',
    updatedAt: '2026-10-02T09:00:00.000Z'
  },
  {
    id: 'sq-3',
    name: 'Archivar contactos inactivos',
    sql: 'DELETE FROM contactos WHERE activo = 0;',
    schema: 'crm',
    updatedAt: '2026-10-03T09:00:00.000Z'
  }
])
const AUTO_STEPS: Step[] = [
  {
    name: '45a-job-editor-empty',
    script: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      S.workspace.openJobEditor(null)
      await H.waitFor('[data-test="step-list-empty"]', 10000)
      await H.settle(S, 900)`
  },
  {
    name: '45b-job-editor-steps',
    script: `${OPEN_AUTO_JOB}
      await H.settle(S, 1200)`
  },
  {
    name: '45c-job-step-settings',
    script: `
      await H.click('[data-test="job-task-0"]', 8000)
      await H.waitFor('[data-test="step-settings"]', 8000)
      await H.settle(S, 900)`
  },
  {
    name: '45d-job-step-restore-settings',
    script: `
      await H.click('[data-test="job-task-4"]', 8000)
      await H.waitFor('[data-test="restore-source"]', 8000)
      await H.settle(S, 900)`
  },
  {
    name: '45e-job-add-saved-queries',
    script: `
      localStorage.setItem('electrondb.queries.${AUTO_LOCAL}', ${JSON.stringify(SAVED_QUERIES)})
      ${OPEN_AUTO_JOB}
      await H.click('[data-test="step-kind-savedQuery"]', 8000)
      await H.click('[data-test="browse-connection-${AUTO_LOCAL}"]', 8000)
      await H.click('[data-test="browse-expand-${AUTO_LOCAL}"]', 8000)
      await H.click('[data-test="browse-db-ventas"]', 15000)
      await H.click('[data-test="avail-query:${AUTO_LOCAL}:sq-1"]', 8000)
      H.$('[data-test="avail-query:${AUTO_LOCAL}:sq-1"]').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      H.$('[data-test="avail-query:${AUTO_LOCAL}:sq-2"]').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      await H.settle(S, 900)`
  },
  {
    name: '45f-job-add-backups',
    script: `
      await H.click('[data-test="step-kind-backup"]', 8000)
      await H.click('[data-test="browse-connection-shot-auto-pg"]', 8000)
      await H.until(() => H.$('[data-test^="avail-backup:shot-auto-pg:"]'), 15000)
      await H.settle(S, 900)`
  },
  {
    name: '45g-job-add-restore',
    script: `
      await H.click('[data-test="step-kind-restore"]', 8000)
      await H.click('[data-test="browse-connection-${AUTO_LOCAL}"]', 8000)
      await H.click('[data-test="browse-db-ventas"]', 15000)
      await H.settle(S, 1200)`
  },
  {
    name: '45h-job-schedule',
    script: `
      await H.click('[data-test="job-schedule-pill"]', 8000)
      await H.waitFor('[data-test="schedule-builder"]', 8000)
      await H.settle(S, 900)`
  },
  {
    name: '45i-job-options',
    script: `
      await H.click('[data-test="job-section-options"]', 8000)
      await H.settle(S, 700)`
  },
  {
    name: '45j-job-history',
    script: `
      await H.click('[data-test="job-section-history"]', 8000)
      await H.until(() => document.querySelectorAll('[data-test="job-editor"] .run-history, [data-test="job-editor"] [data-test^="run-"]').length, 8000).catch(() => null)
      await H.settle(S, 1500)`
  },
  {
    name: '45k-job-editor-light',
    script: `
      S.settings.settings = { ...S.settings.settings, theme: 'light' }
      ${OPEN_AUTO_JOB}
      await H.click('[data-test="job-task-0"]', 8000)
      await H.click('[data-test="step-kind-savedQuery"]', 8000)
      await H.click('[data-test="browse-connection-${AUTO_LOCAL}"]', 8000)
      await H.settle(S, 1200)`,
    cleanup: `S.settings.settings = { ...S.settings.settings, theme: 'dark' }`
  },
  {
    name: '45l-job-editor-1100',
    size: { width: 1100, height: 760 },
    script: `${OPEN_AUTO_JOB}
      await H.settle(S, 900)`
  },
  {
    name: '45m-job-step-settings-1100',
    size: { width: 1100, height: 760 },
    script: `${OPEN_AUTO_JOB}
      await H.click('[data-test="job-task-4"]', 8000)
      await H.waitFor('[data-test="step-settings"]', 8000)
      await H.settle(S, 900)`
  },
  {
    name: '45n-job-add-browser-1100',
    size: { width: 1100, height: 760 },
    script: `${OPEN_AUTO_JOB}
      await H.click('[data-test="step-kind-backup"]', 8000)
      await H.click('[data-test="browse-connection-${AUTO_LOCAL}"]', 8000)
      await H.until(() => H.$('[data-test="avail-backup:${AUTO_LOCAL}:crm"]'), 15000)
      await H.settle(S, 900)`,
    cleanup: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      localStorage.removeItem('electrondb.queries.${AUTO_LOCAL}')
      for (const db of ['ventas', 'crm'])
        await S.api.invokeSilent('db:execute', '${AUTO_LOCAL}', 'DROP DATABASE IF EXISTS ' + db, {}).catch(() => null)`
  }
]
STEPS.push(...AUTO_STEPS)

/**
 * «Copiar y restaurar» and «Seleccionar todo» (VORTAQ_SHOTS_ONLY=46): need the
 * profile and the 5.7 «Staging» databases (ventas, crm, auth) of
 * scripts/seed-automation-shots.mjs. The last step drops those databases.
 */
const AUTO_STAGING = 'shot-auto-staging'
const NEW_AUTO_JOB = `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      S.workspace.openJobEditor(null)
      await H.waitFor('[data-test="step-list-empty"]', 10000)`
const SET_INPUT = `
      const setInput = (sel, value) => {
        const el = H.$(sel)
        if (!el) throw new Error('input not found: ' + sel)
        el.value = value
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }`
const RECIPE_STEPS: Step[] = [
  {
    name: '46a-recipe-empty-editor',
    script: `${NEW_AUTO_JOB}
      await H.settle(S, 900)`
  },
  {
    name: '46b-recipe-dialog',
    script: `${NEW_AUTO_JOB}
      await H.click('[data-test="browse-connection-${AUTO_STAGING}"]', 8000)
      await H.until(() => H.$('[data-test="avail-backup-all:${AUTO_STAGING}"]'), 15000)
      await H.click('[data-test="browser-recipe"]', 8000)
      await H.waitFor('[data-test="recipe-db-ventas"]', 15000)
      await H.settle(S, 900)`
  },
  {
    name: '46c-recipe-dialog-custom',
    script: `${SET_INPUT}
      await H.click('[data-test="recipe-db-navidog_test"] input[type="checkbox"]', 8000)
      setInput('[data-test="recipe-target-crm"] input', 'crm_pruebas')
      await H.click('[data-test="recipe-safety-off"]', 8000)
      await H.settle(S, 700)`
  },
  {
    name: '46d-recipe-job-created',
    script: `
      await H.click('[data-test="recipe-safety-on"]', 8000)
      await H.sleep(200)
      await H.click('[data-test="recipe-add"]', 8000)
      await H.waitFor('[data-test="job-task-5"]', 8000)
      await H.settle(S, 900)`
  },
  {
    name: '46e-restore-list',
    script: `
      await H.click('[data-test="step-kind-restore"]', 8000)
      await H.click('[data-test="browse-connection-${AUTO_LOCAL}"]', 8000)
      await H.settle(S, 1200)`
  },
  {
    name: '46f-select-all',
    script: `
      await H.click('[data-test="step-kind-backup"]', 8000)
      await H.click('[data-test="browse-connection-${AUTO_STAGING}"]', 8000)
      await H.until(() => H.$('[data-test="browser-select-all-dbs"] input'), 15000)
      await H.click('[data-test="avail-backup:${AUTO_STAGING}:ventas"] input[type="checkbox"]', 8000)
      await H.settle(S, 400)
      await H.click('[data-test="browser-select-all-dbs"] input', 8000)
      await H.settle(S, 900)`
  },
  {
    name: '46g-restore-suggest',
    script: `${NEW_AUTO_JOB}
      await H.click('[data-test="step-kind-restore"]', 8000)
      await H.waitFor('[data-test="browser-recipe-suggest"]', 8000)
      await H.settle(S, 900)`
  },
  {
    name: '46h-recipe-dialog-light',
    script: `
      S.settings.settings = { ...S.settings.settings, theme: 'light' }
      ${NEW_AUTO_JOB}
      await H.click('[data-test="step-list-recipe-open"]', 8000)
      await H.waitFor('[data-test="copy-restore-dialog"]', 8000)
      await H.settle(S, 900)`,
    cleanup: `S.settings.settings = { ...S.settings.settings, theme: 'dark' }`
  },
  {
    name: '46i-recipe-editor-1100',
    size: { width: 1100, height: 760 },
    script: `${NEW_AUTO_JOB}
      await H.click('[data-test="browse-connection-${AUTO_STAGING}"]', 8000)
      await H.until(() => H.$('[data-test="avail-backup-all:${AUTO_STAGING}"]'), 15000)
      await H.settle(S, 900)`,
    cleanup: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      for (const db of ['ventas', 'crm', 'auth'])
        await S.api.invokeSilent('db:execute', '${AUTO_STAGING}', 'DROP DATABASE IF EXISTS ' + db, {}).catch(() => null)`
  }
]
STEPS.push(...RECIPE_STEPS)

/**
 * «Restaurar paquete» (VORTAQ_SHOTS_ONLY=47): need the profile of
 * scripts/seed-automation-shots.mjs (jobs «Copias de Local» and «Copia nocturna
 * Staging» with its last run). The restore list grouped by automation, a package
 * step row and its settings panel.
 */
const PACKAGE_JOB = 'shot-auto-local-copies'
const OPEN_PACKAGE_JOB = `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      await S.jobs.load()
      const job = S.jobs.jobs.find((j) => j.id === '${PACKAGE_JOB}')
      if (!job) throw new Error('job not seeded (run scripts/seed-automation-shots.mjs)')
      S.workspace.openJobEditor(job.id, job.name)
      await H.waitFor('[data-test="job-task-5"]', 10000)`
const PACKAGE_STEPS: Step[] = [
  {
    name: '47a-restore-list-grouped',
    script: `${OPEN_PACKAGE_JOB}
      await H.click('[data-test="step-kind-restore"]', 8000)
      await H.waitFor('[data-test="avail-pack:own"]', 8000)
      await H.until(() => H.$('[data-test="avail-pack:job:shot-auto-staging-nightly"]'), 8000)
      await H.click('[data-test="browse-connection-${AUTO_LOCAL}"]', 8000)
      await H.until(() => H.$('[data-test^="avail-latest:${AUTO_LOCAL}:"]'), 15000)
      await H.settle(S, 1200)`
  },
  {
    name: '47a2-restore-list-disk-copies',
    script: `
      // This job's copies folded and the list scrolled to the other jobs and the disk copies.
      await H.click('[data-test="pack-fold-steps"]', 8000)
      await H.sleep(200)
      const list = H.$('[data-test="step-browser-items"]')
      list.scrollTop = list.scrollHeight
      await H.settle(S, 900)`
  },
  {
    name: '47b-restore-list-other-job',
    script: `
      await H.click('[data-test="pack-fold-job:shot-auto-staging-nightly"]', 8000)
      await H.waitFor('[data-test="avail-pkg:shot-auto-staging-nightly:auth"]', 8000)
      H.$('[data-test="avail-pkg:shot-auto-staging-nightly:ventas"]').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      H.$('[data-test="avail-pkg:shot-auto-staging-nightly:auth"]').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      H.$('[data-test="avail-pack:job:shot-auto-staging-nightly"]').scrollIntoView({ block: 'start' })
      await H.settle(S, 900)`
  },
  {
    name: '47c-package-step-row',
    script: `${OPEN_PACKAGE_JOB}
      await H.click('[data-test="step-kind-restore"]', 8000)
      await H.click('[data-test="avail-add-pack:own"]', 8000)
      await H.waitFor('[data-test="job-task-6"]', 8000)
      await H.click('[data-test="avail-add-pack:job:shot-auto-staging-nightly"]', 8000)
      await H.waitFor('[data-test="job-task-7"]', 8000)
      await H.click('[data-test="step-browser-fold"]', 8000)
      await H.settle(S, 900)`
  },
  {
    name: '47d-package-step-settings',
    script: `
      await H.click('[data-test="job-task-6"]', 8000)
      await H.waitFor('[data-test="package-databases"]', 8000)
      await H.settle(S, 900)`
  },
  {
    name: '47e-package-step-settings-other-job',
    script: `${SET_INPUT}
      await H.click('[data-test="job-task-7"]', 8000)
      await H.waitFor('[data-test="package-db-auth"]', 8000)
      await H.click('[data-test="package-whole-some"]', 8000)
      await H.sleep(200)
      await H.click('[data-test="package-db-pagos"] input[type="checkbox"]', 8000)
      setInput('[data-test="package-suffix"] input', '_dev')
      await H.click('[data-test="package-safety-off"]', 8000)
      await H.settle(S, 900)`
  },
  {
    name: '47f-restore-list-light',
    script: `
      S.settings.settings = { ...S.settings.settings, theme: 'light' }
      ${OPEN_PACKAGE_JOB}
      await H.click('[data-test="step-kind-restore"]', 8000)
      await H.waitFor('[data-test="avail-pack:own"]', 8000)
      await H.settle(S, 1200)`,
    cleanup: `S.settings.settings = { ...S.settings.settings, theme: 'dark' }`
  },
  {
    name: '47g-restore-list-1100',
    size: { width: 1100, height: 760 },
    script: `${OPEN_PACKAGE_JOB}
      await H.click('[data-test="step-kind-restore"]', 8000)
      await H.waitFor('[data-test="avail-pack:own"]', 8000)
      await H.settle(S, 900)`
  },
  {
    name: '47h-package-settings-1100',
    size: { width: 1100, height: 760 },
    script: `${OPEN_PACKAGE_JOB}
      await H.click('[data-test="step-kind-restore"]', 8000)
      await H.click('[data-test="avail-add-pack:own"]', 8000)
      await H.waitFor('[data-test="job-task-6"]', 8000)
      await H.click('[data-test="job-task-6"]', 8000)
      await H.waitFor('[data-test="package-databases"]', 8000)
      await H.settle(S, 900)`,
    cleanup: `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      for (const db of ['ventas', 'crm'])
        await S.api.invokeSilent('db:execute', '${AUTO_LOCAL}', 'DROP DATABASE IF EXISTS ' + db, {}).catch(() => null)
      for (const db of ['ventas', 'crm', 'auth'])
        await S.api.invokeSilent('db:execute', '${AUTO_STAGING}', 'DROP DATABASE IF EXISTS ' + db, {}).catch(() => null)`
  }
]
STEPS.push(...PACKAGE_STEPS)

/**
 * Copy and export of results (VORTAQ_SHOTS_ONLY=48): a read-only multi-table
 * result of the seeded «Local Test» (shot_customers / shot_orders) with a
 * column selected and «Copiar como» open, the export dialog, and a cell
 * range. Needs scripts/seed-screenshots.mjs (synthetic data only).
 */
const JOIN_RESULT = `
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)
      const c = H.local(S)
      const sql = [
        'SELECT c.id, c.name, c.email, o.id AS pedido, o.status, o.total',
        'FROM shot_customers c',
        'JOIN shot_orders o ON o.customer_id = c.id',
        'ORDER BY o.id',
        'LIMIT 40'
      ].join('\\n')
      S.workspace.openQuery(c.id, '${SCHEMA}', { sql, name: 'Pedidos por cliente' })
      await H.sleep(900)
      await H.click('[data-test="run"]', 10000)
      await H.until(() => /Solo lectura/.test(H.$('[data-test="editability"]')?.textContent || ''), 15000)
      await H.sleep(500)
      const at = (el, type) => {
        const r = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: type === 'contextmenu' ? 2 : 0, clientX: r.left + 24, clientY: r.top + r.height / 2 }))
      }`
const CLOSE_RESULT = `
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await H.sleep(200)
      const cancel = [...document.querySelectorAll('[data-test="export-dialog"] button')].find((b) => /Cancelar/.test(b.textContent || ''))
      if (cancel) cancel.click()
      for (const t of [...S.tabs.tabs]) if (t.closable) S.tabs.close(t.id)`
const EXPORT_STEPS: Step[] = [
  {
    name: '48a-grid-column-copy-as',
    script: `${JOIN_RESULT}
      const header = await H.waitFor('[data-test="header-status"]', 5000)
      at(header, 'click')
      await H.sleep(200)
      at(header, 'contextmenu')
      const copyAs = await H.waitFor('[data-test="menu-copy-as"]', 5000)
      copyAs.click()
      await H.waitFor('[data-test="menu-copy-insert"]', 5000)
      await H.settle(S, 700)`,
    cleanup: CLOSE_RESULT
  },
  {
    name: '48b-export-dialog',
    script: `${JOIN_RESULT}
      at(await H.waitFor('[data-test="header-name"]', 5000), 'click')
      const last = await H.waitFor('[data-test="header-email"]', 5000)
      const r = last.getBoundingClientRect()
      last.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true, clientX: r.left + 24, clientY: r.top + 10 }))
      await H.sleep(200)
      await H.click('[data-test="export"]', 5000)
      await H.waitFor('[data-test="export-dialog"]', 5000)
      await H.click('[data-test="export-format-xlsx"]', 5000)
      const full = await H.waitFor('[data-test="export-scope-full"] input', 5000)
      full.click()
      await H.settle(S, 700)`,
    cleanup: CLOSE_RESULT
  },
  {
    name: '48c-join-readonly-selection',
    script: `${JOIN_RESULT}
      const from = await H.waitFor('[data-test="cell-2-1"]', 5000)
      at(from, 'mousedown')
      const to = await H.waitFor('[data-test="cell-8-4"]', 5000)
      to.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
      window.dispatchEvent(new MouseEvent('mouseup'))
      await H.settle(S, 700)`,
    cleanup: CLOSE_RESULT
  }
]
STEPS.push(...EXPORT_STEPS)

function wrap(body: string): string {
  return `(async () => { const S = window.__vortaqShots; const H = window.__ndShotHelpers; ${body}\n; return true })()`
}

/**
 * Drives the renderer through every screen, writes `<dir>/<step>.png`, prints
 * a `[screenshots] {json}` summary and quits (0 when at least one PNG was saved).
 */
export function watchScreenshots(win: BrowserWindow, dir: string): void {
  const contents = win.webContents
  const say = (msg: string): void => console.log(`[screenshots] ${msg}`)
  contents.on('console-message', (event) => {
    const { level, message } = event as unknown as { level: string; message: string }
    if (level === 'error') say(`renderer error: ${message.slice(0, 300)}`)
  })

  const run = async (): Promise<void> => {
    mkdirSync(dir, { recursive: true })
    const files: string[] = []
    const failed: { step: string; error: string }[] = []
    await contents.executeJavaScript(HELPERS)
    await contents.executeJavaScript(
      wrap(
        `await H.until(() => S && S.connections.loaded && S.settings.loaded, 20000); await H.sleep(800)`
      )
    )
    // VORTAQ_SHOTS_ONLY=05,05b runs just the steps whose name starts with one of the prefixes.
    const only = (envVar('SHOTS_ONLY') ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const steps = only.length ? STEPS.filter((s) => only.some((p) => s.name.startsWith(p))) : STEPS
    for (const step of steps) {
      if (step.size) {
        win.setContentSize(step.size.width, step.size.height)
        await sleep(500)
      }
      try {
        await contents.executeJavaScript(wrap(step.script))
        if (step.settleMs) await sleep(step.settleMs)
        // Let the compositor paint the last frame (transitions are <= 180ms).
        await sleep(350)
        let image = await contents.capturePage()
        const size = image.getSize()
        if (size.width > SCREENSHOT_WINDOW.width)
          image = image.resize({ width: SCREENSHOT_WINDOW.width, quality: 'best' })
        const file = join(dir, `${step.name}.png`)
        writeFileSync(file, image.toPNG())
        files.push(file)
        say(`saved ${file}`)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        failed.push({ step: step.name, error })
        say(`FAILED ${step.name}: ${error}`)
      }
      if (step.cleanup) {
        try {
          await contents.executeJavaScript(wrap(step.cleanup))
          await sleep(450)
        } catch (err) {
          say(`cleanup of ${step.name} failed: ${err instanceof Error ? err.message : err}`)
        }
      }
      if (step.size) {
        win.setContentSize(SCREENSHOT_WINDOW.width, SCREENSHOT_WINDOW.height)
        await sleep(500)
      }
    }
    say(JSON.stringify({ ok: failed.length === 0, files, failed }))
    app.exit(files.length > 0 ? 0 : 1)
  }

  contents.once('did-finish-load', () => {
    run().catch((err) => {
      say(`aborted: ${err instanceof Error ? err.message : err}`)
      app.exit(1)
    })
  })
  // Never hang.
  setTimeout(() => {
    say('timeout: harness did not finish in 5 minutes')
    app.exit(1)
  }, 300_000).unref()
}
