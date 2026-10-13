import { app, BrowserWindow, dialog, Menu } from 'electron'
import { applyProfilePath, configureFileLog, createContext, readEnvSwitches } from './bootstrap'
import { APP_NAME } from './brand'
import { getLogger } from './log'
import { registerAllHandlers } from './ipc/register'
import { buildAppMenuTemplate } from './menu'
import { createMainWindow, watchSmoke } from './window'
import { aboutPanelOptions } from './licenses'
import { windowIconPath } from './windowOptions'
import { quitVetoed, restoreQuitPrompt, vetoQuit } from './quitGuard'
import { runProfileMigration, runSecretMigration } from './migration'
import { migrateImportedMariaDb } from './migration/mariadbEngine'
import { setSqliteSpawner } from './sqlite/spawner'
import { electronSqliteSpawner } from './sqlite/electronSpawner'
import { setAiFetch } from './ai/index'
import { electronFetch } from './ai/electronFetch'
import {
  SCREENSHOT_QUERY,
  SCREENSHOT_WINDOW,
  screenshotDirFromEnv,
  watchScreenshots
} from './screenshots'

/**
 * CLI: `Vortaq --run-job=<jobId>` executes one job headless and exits.
 * Used by launchd agents created by the scheduler.
 */
function parseRunJobArg(argv: string[]): string | null {
  for (const a of argv) {
    const m = /^--run-job=(.+)$/.exec(a)
    if (m) return m[1]
  }
  return null
}

const runJobId = parseRunJobArg(process.argv)
const switches = readEnvSwitches()
// The screenshot harness drives the UI, so it is only allowed on a scratch profile.
const screenshotDir = screenshotDirFromEnv()
if (screenshotDir && !switches.userDataPath) {
  console.error('VORTAQ_SCREENSHOTS requires VORTAQ_USER_DATA (a scratch profile).')
  process.exit(1)
}

app.setName(APP_NAME)
// Before 'ready': Chromium storage must also follow the alternative profile.
const userDataPath = applyProfilePath(switches)
configureFileLog(userDataPath)
// First start under the Vortaq name: copy the ElectronDB (or older Navidog)
// profile, also before 'ready' so Chromium sees the copied Local Storage.
runProfileMigration({
  appData: app.getPath('appData'),
  userData: userDataPath,
  userDataOverride: switches.userDataPath,
  legacyUserDataOverride: switches.legacyUserDataPath
})

app.whenReady().then(async () => {
  const log = getLogger('main')
  const ctx = createContext({ headless: runJobId !== null })
  // Secrets copied from the old profile are re-encrypted before anything reads
  // them. Headless runs leave it to the next interactive start: macOS may ask
  // for keychain access and nobody would be there to answer.
  if (!runJobId) await runSecretMigration(ctx, { keychain: switches.legacyKeychain })
  // P5: connections imported from MariaDB entries become MariaDB connections (once; idempotent).
  if (!runJobId) {
    const promoted = migrateImportedMariaDb(ctx.connections)
    if (promoted) log.info(`${promoted} imported MariaDB connection(s) now use the MariaDB engine`)
  }
  // Host ports (docs/vscode-extension-design.md): SQLite connections run in utility
  // processes (src/main/sqlite/worker.ts); AI provider calls use Electron's network stack.
  setSqliteSpawner(electronSqliteSpawner)
  setAiFetch(electronFetch)
  registerAllHandlers(ctx)

  if (runJobId) {
    try {
      const { runJobHeadless } = await import('./automation/headless')
      const code = await runJobHeadless(ctx, runJobId)
      app.exit(code)
    } catch (err) {
      log.error('headless run failed', err)
      app.exit(1)
    }
    return
  }

  app.setAboutPanelOptions(
    aboutPanelOptions({
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      iconPath: windowIconPath({
        platform: process.platform,
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath()
      })
    })
  )
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildAppMenuTemplate({
        appName: app.name,
        dev: !app.isPackaged,
        onCheckUpdates: () => ctx.emit('event:checkUpdates', null)
      })
    )
  )

  // Registered before every other 'before-quit' listener: quitting while a
  // restore runs would cancel it after its DROP DATABASE, so ask first.
  const { getAutomationService } = await import('./automation/index')
  let quitDuringRestoreConfirmed = false
  app.on('before-quit', (event) => {
    if (quitDuringRestoreConfirmed) return
    const restores = getAutomationService(ctx).activeRestores?.() ?? []
    if (!restores.length) return
    const prompt = restoreQuitPrompt(restores.map((r) => r.jobName))
    const options = {
      type: 'warning' as const,
      buttons: ['Seguir restaurando', 'Salir de todos modos'],
      defaultId: 0,
      cancelId: 0,
      message: prompt.message,
      detail: prompt.detail
    }
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const choice = parent
      ? dialog.showMessageBoxSync(parent, options)
      : dialog.showMessageBoxSync(options)
    if (choice === 1) {
      quitDuringRestoreConfirmed = true
      return
    }
    vetoQuit(event)
  })

  const { startBackgroundServices } = await import('./services')
  await startBackgroundServices(ctx)

  // Connections stay open until the user disconnects them or quits.
  // On quit, close every pool and SSH tunnel cleanly (bounded so quitting never hangs).
  const { getConnectionManager } = await import('./db/manager')
  const { describeForLog } = await import('./db/errors')
  let closingConnections = false
  app.on('before-quit', (event) => {
    if (quitVetoed(event) || closingConnections) return
    closingConnections = true
    event.preventDefault()
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000))
    Promise.race([getConnectionManager(ctx).closeAll(), timeout])
      // Never the raw error: its stack and message may carry server text.
      .catch((err) => log.warn(`closing connections on quit failed: ${describeForLog(err)}`))
      .finally(() => app.quit())
  })

  const theme = (): 'dark' | 'light' => ctx.settings.get().theme
  const win = screenshotDir
    ? createMainWindow({
        ...SCREENSHOT_WINDOW,
        query: SCREENSHOT_QUERY,
        showInactive: true,
        theme: theme()
      })
    : createMainWindow({ theme: theme() })
  if (screenshotDir) watchScreenshots(win, screenshotDir)
  else if (switches.smoke) watchSmoke(win)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow({ theme: theme() })
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
