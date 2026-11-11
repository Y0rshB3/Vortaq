import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import { parseMongoUri } from '@shared/mongo/uri'
import { envVar } from './env'
import { getLogger } from './log'
import {
  externalOpenAllowed,
  isAppDocument,
  rendererSource,
  type RendererSource
} from './navigation'
import { mainWebPreferences, windowChromeOptions, windowIconPath } from './windowOptions'

export interface MainWindowOptions {
  width?: number
  height?: number
  /** Extra query parameters for the renderer URL (screenshot harness only). */
  query?: Record<string, string>
  /** Show without stealing focus (screenshot harness). */
  showInactive?: boolean
  /** Colours of the Windows/Linux window-controls overlay (follows the app theme). */
  theme?: AppSettings['theme']
}

export function createMainWindow(options: MainWindowOptions = {}): BrowserWindow {
  const icon = windowIconPath({
    platform: process.platform,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath()
  })
  const win = new BrowserWindow({
    width: options.width ?? 1440,
    height: options.height ?? 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Vortaq',
    ...windowChromeOptions({ platform: process.platform, theme: options.theme ?? 'dark' }),
    ...(icon ? { icon } : {}),
    backgroundColor: '#090c13',
    webPreferences: mainWebPreferences(join(__dirname, '../preload/index.js'))
  })

  win.on('ready-to-show', () => (options.showInactive ? win.showInactive() : win.show()))

  const query = options.query ?? {}
  const source = appRendererSource()
  if (source.devServerUrl) {
    const url = new URL(source.devServerUrl)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(source.file, { query })
  }
  return win
}

/** This run's renderer: the built page, or the dev server of an unpackaged run. */
export function appRendererSource(): RendererSource {
  return rendererSource({
    packaged: app.isPackaged,
    env: process.env,
    file: join(__dirname, '../renderer/index.html')
  })
}

/**
 * Every webContents (the main window and any other) stays on the app's page
 * (navigation.ts): navigations, redirects and frame navigations elsewhere are
 * cancelled, <webview> never attaches, and window.open never opens a window;
 * only GitHub release links reach the system browser. Called before the first
 * window.
 */
export function guardWebContents(): void {
  const source = appRendererSource()
  const log = getLogger('window')
  const refuse = (event: { preventDefault(): void }, url: string, what: string): void => {
    if (isAppDocument(url, source)) return
    event.preventDefault()
    // The scheme only: a file path or a query string may be private.
    log.warn(`${what} refused (${schemeOf(url)})`)
  }
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => refuse(event, url, 'navigation'))
    contents.on('will-redirect', (event, url) => refuse(event, url, 'redirect'))
    contents.on('will-frame-navigate', (event) => refuse(event, event.url, 'frame navigation'))
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
      log.warn('webview refused')
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (externalOpenAllowed(url)) void shell.openExternal(url)
      else log.warn(`window.open refused (${schemeOf(url)})`)
      return { action: 'deny' }
    })
  })
}

function schemeOf(url: string): string {
  try {
    return new URL(url).protocol
  } catch {
    return 'invalid URL'
  }
}

/**
 * Renderer-side SQLite check of the smoke run, through the real IPC bridge and
 * the SQLite utility process: create a file in the (scratch) profile, open a
 * connection, run a script, cancel a runaway CTE (must end within a second,
 * killing and reopening the worker) and read again.
 */
const SQLITE_SMOKE = `async () => {
  const out = {}
  try {
    const invoke = window.vortaq.invoke
    const info = await invoke('app:info')
    const sep = info.platform === 'win32' ? '\\\\' : '/'
    const file = info.userDataPath + sep + 'smoke-' + Date.now() + '.db'
    out.version = (await invoke('sqlite:createFile', file)).sqliteVersion
    const conn = await invoke('connections:save', {
      name: 'Smoke SQLite', color: null, environment: 'local', host: '', port: 0, username: '',
      authMode: 'none', savePassword: false, customDatabases: [], initialQueries: '',
      ssh: { enabled: false, host: '', port: 22, username: '', authType: 'password', savePassword: false },
      ssl: { enabled: false, verifyServer: false }, backupDir: '', extraBackupDirs: [],
      engine: 'sqlite',
      sqlite: { filePath: file, readOnly: false, foreignKeys: true, attached: [], busyTimeoutMs: 5000 }
    })
    await invoke('connections:open', conn.id)
    const first = await invoke('db:execute', conn.id, 'CREATE TABLE t (x); INSERT INTO t VALUES (1), (2); SELECT count(*) FROM t', { sessionKey: 'smoke' })
    out.count = first[2] && first[2].resultSet ? first[2].resultSet.rows[0][0] : null
    const running = invoke('db:execute', conn.id, 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c', { sessionKey: 'smoke', executionId: 'smoke-cancel' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const started = performance.now()
    out.cancelled = await invoke('db:cancel', conn.id, 'smoke-cancel')
    const cancelled = await running
    out.cancelMs = Math.round(performance.now() - started)
    out.cancelError = cancelled[0] ? cancelled[0].error : null
    const again = await invoke('db:execute', conn.id, 'SELECT count(*) FROM t', { sessionKey: 'smoke' })
    out.afterCancel = again[0] && again[0].resultSet ? again[0].resultSet.rows[0][0] : null
    await invoke('connections:close', conn.id)
    await invoke('connections:delete', conn.id)
    out.ok = out.count === 2 && out.cancelled === true && out.cancelMs < 1000 && out.afterCancel === 2
  } catch (e) {
    out.error = String(e && e.message)
    out.ok = false
  }
  return out
}`

/**
 * The window stays on the app's page (navigation.ts): a navigation to a local
 * file is cancelled (the page and its bridge are still there afterwards) and
 * window.open opens nothing. Neither URL is one the browser would be given.
 */
const NAVIGATION_SMOKE = `async () => {
  const before = location.href
  try { location.assign('file:///') } catch (e) { /* refused */ }
  await new Promise((resolve) => setTimeout(resolve, 500))
  let opened = null
  try { opened = window.open('https://example.invalid/', '_blank') } catch (e) { /* refused */ }
  return { stayed: location.href === before && typeof window.vortaq?.invoke === 'function', opened: opened !== null }
}`

/**
 * Renderer-side MongoDB check of the smoke run (only with VORTAQ_SMOKE_MONGO_URL,
 * or VORTAQ_TEST_MONGO_URL, pointing at a throwaway server): save and open a
 * connection, run shell commands through the bundled parser (Int64 kept),
 * cancel a runaway $where query with killOp, drop the scratch database.
 */
function mongoSmoke(input: string, password: string | null): string {
  return `async () => {
  const out = {}
  const invoke = window.vortaq.invoke
  let conn = null
  const db = 'vortaq_smoke_' + Date.now()
  try {
    conn = await invoke('connections:save', ${input})
    ${password === null ? '' : `await invoke('connections:setPassword', conn.id, ${JSON.stringify(password)})`}
    out.version = (await invoke('connections:open', conn.id)).version
    const opts = { database: db, sessionKey: 'smoke' }
    const write = await invoke('mongo:execute', conn.id, "db.smoke.insertMany([{ n: NumberLong('9007199254740993') }, { n: 2 }]); " + Array.from({ length: 30 }, (_, i) => 'db.slow.insertOne({ i: ' + i + ' })').join('; '), opts)
    out.inserted = write[0] && write[0].write ? write[0].write.inserted : null
    const read = await invoke('mongo:execute', conn.id, "db.smoke.find({ n: { $gt: NumberLong('9007199254740992') } })", opts)
    out.int64 = !!(read[0] && read[0].page && read[0].page.docs[0] && read[0].page.docs[0].includes('9007199254740993'))
    const running = invoke('mongo:execute', conn.id, "db.slow.find({ $where: 'sleep(200) || true' })", { ...opts, executionId: 'smoke-mongo-cancel' })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const started = performance.now()
    out.cancelled = await invoke('db:cancel', conn.id, 'smoke-mongo-cancel')
    const cancelled = await running
    out.cancelMs = Math.round(performance.now() - started)
    out.cancelError = cancelled[0] ? cancelled[0].error : null
    out.ok = out.inserted === 2 && out.int64 === true && out.cancelled === true && out.cancelMs < 3000 && /cancelada/.test(out.cancelError || '')
  } catch (e) {
    out.error = String(e && e.message)
    out.ok = false
  } finally {
    if (conn) {
      try { await invoke('mongo:execute', conn.id, 'db.dropDatabase()', { database: db }) } catch (e) { /* best effort */ }
      try { await invoke('connections:close', conn.id) } catch (e) { /* best effort */ }
      try { await invoke('connections:delete', conn.id) } catch (e) { /* best effort */ }
    }
  }
  return out
}`
}

/** ConnectionInput JSON and password of the smoke's MongoDB server, or null when none is set. */
function mongoSmokeTarget(): { input: string; password: string | null } | null {
  const url = envVar('SMOKE_MONGO_URL') ?? envVar('TEST_MONGO_URL')
  if (!url) return null
  const p = parseMongoUri(url)
  return {
    password: p.password,
    input: JSON.stringify({
      name: 'Smoke MongoDB',
      color: null,
      environment: 'local',
      host: p.host,
      port: p.port,
      username: p.username,
      authMode: p.password === null ? 'none' : 'password',
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
      ssl: { enabled: p.ssl.enabled, verifyServer: p.ssl.verifyServer },
      backupDir: '',
      extraBackupDirs: [],
      engine: 'mongodb',
      mongo: p.mongo
    })
  }
}

/**
 * VORTAQ_SMOKE=1: records renderer console warnings/errors and load failures,
 * waits for the renderer to finish loading and mount, runs the SQLite check
 * (SQLITE_SMOKE), prints one
 * `[smoke] {json}` line to stdout and exits (0 = clean, 1 = problems).
 */
export function watchSmoke(win: BrowserWindow, settleMs = 4000): void {
  const problems: string[] = []
  const contents = win.webContents
  const short = (text: string): string => (text.length > 300 ? `${text.slice(0, 300)}…` : text)
  const finish = (result: Record<string, unknown>): void => {
    const ipc = (result.ipc ?? {}) as Record<string, string>
    for (const [channel, status] of Object.entries(ipc))
      if (status !== 'ok') problems.push(`ipc ${channel}: ${short(status)}`)
    const sqlite = result.sqlite as { ok?: boolean } | undefined
    if (sqlite && sqlite.ok !== true) problems.push(`sqlite: ${short(JSON.stringify(sqlite))}`)
    const mongo = result.mongo as { ok?: boolean } | null | undefined
    if (mongo && mongo.ok !== true) problems.push(`mongo: ${short(JSON.stringify(mongo))}`)
    const navigation = result.navigation as { stayed?: boolean; opened?: boolean } | undefined
    if (navigation && (navigation.stayed !== true || navigation.opened !== false))
      problems.push(`navigation: ${JSON.stringify(navigation)}`)
    const ok = problems.length === 0 && result.mounted === true && result.bridge === true
    console.log(`[smoke] ${JSON.stringify({ ok, ...result, problems })}`)
    app.exit(ok ? 0 : 1)
  }

  contents.on('console-message', (event) => {
    const { level, message } = event as unknown as { level: string; message: string }
    if (level === 'warning' || level === 'error')
      problems.push(`console.${level}: ${short(message)}`)
  })
  contents.on('preload-error', (_e, path, error) =>
    problems.push(`preload-error ${path}: ${short(error.message)}`)
  )
  contents.on('did-fail-load', (_e, code, description, url) =>
    problems.push(`did-fail-load ${code} ${description} ${url}`)
  )
  contents.on('render-process-gone', (_e, details) =>
    problems.push(`render-process-gone ${details.reason}`)
  )
  const mongo = mongoSmokeTarget()
  contents.once('did-finish-load', () => {
    setTimeout(() => {
      contents
        .executeJavaScript(
          `(async () => {
            const ipc = {}
            for (const channel of ['app:info', 'app:startupNotices', 'settings:get', 'connections:list', 'jobs:list', 'jobs:runs', 'updates:check', 'ai:providers']) {
              try { await window.vortaq.invoke(channel); ipc[channel] = 'ok' } catch (e) { ipc[channel] = String(e && e.message) }
            }
            return { mounted: (document.querySelector('#app')?.children.length ?? 0) > 0, bridge: typeof window.vortaq?.invoke === 'function', title: document.title, ipc, sqlite: await (${SQLITE_SMOKE})(), mongo: ${mongo ? `await (${mongoSmoke(mongo.input, mongo.password)})()` : 'null'}, navigation: await (${NAVIGATION_SMOKE})() }
          })()`
        )
        .then((info: Record<string, unknown>) => finish(info))
        .catch((err: Error) => {
          problems.push(`executeJavaScript: ${short(err.message)}`)
          finish({ mounted: false, bridge: false })
        })
    }, settleMs)
  })
  // Never hang a CI/smoke run.
  setTimeout(() => {
    problems.push('timeout: the renderer did not finish loading')
    finish({ mounted: false, bridge: false })
  }, 60_000).unref()
}
