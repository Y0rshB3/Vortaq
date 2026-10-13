import { app, BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { APP_NAME, LOG_FILE_NAME } from './brand'
import type { StartupNotice } from '@shared/types'
import type { AppContext } from './context'
import { CredentialStore, plainCodec } from './credentials/store'
import { electronCodec } from './credentials/electronCodec'
import { envVar } from './env'
import { configureLog, getLogger } from './log'
import { raiseNotice } from './notices'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from './storage/repos'

/** Shown once when no system keyring is available (Linux without GNOME Keyring/KWallet). */
export const PLAIN_SECRETS_NOTICE: StartupNotice = {
  id: 'plain-secrets',
  level: 'warning',
  title: 'Contraseñas sin cifrar',
  message:
    'No hay un llavero del sistema disponible (en Linux, GNOME Keyring o KWallet), así que las contraseñas ' +
    'que guardes se almacenan en credentials.json solo en base64, sin cifrar. Instala y desbloquea un ' +
    'llavero y reinicia la app, o no guardes contraseñas de servidores reales.'
}

/**
 * Test/diagnostic switches read from the environment (VORTAQ_*, with the
 * earlier ELECTRONDB_* and NAVIDOG_* spellings as fallbacks). Never set by the app itself;
 * see README "Variables de entorno".
 */
export interface EnvSwitches {
  /** VORTAQ_USER_DATA: alternative profile directory (connections, jobs, secrets, logs). */
  userDataPath: string | null
  /** VORTAQ_PLAIN_SECRETS=1: store secrets base64-only instead of safeStorage (tests). */
  plainSecrets: boolean
  /** VORTAQ_SMOKE=1: quit right after the renderer finished loading (smoke test). */
  smoke: boolean
  /**
   * VORTAQ_LEGACY_USER_DATA (tests only): profile of an earlier product
   * name to migrate from, even into a scratch profile; its folder name
   * (ElectronDB or Navidog) says which. ELECTRONDB_ fallback, no NAVIDOG_ one.
   */
  legacyUserDataPath: string | null
  /**
   * VORTAQ_LEGACY_KEYCHAIN (tests only): keychain file holding the
   * "ElectronDB Safe Storage" / "Navidog Safe Storage" items.
   */
  legacyKeychain: string | null
  /**
   * VORTAQ_LEGACY_APP_PATHS (tests and screenshots only): ElectronDB bundles to
   * check instead of /Applications and ~/Applications (path-delimiter list).
   */
  legacyAppPaths: string[] | null
}

const absolute = (dir: string | undefined): string | null => {
  const value = dir?.trim()
  return value ? (isAbsolute(value) ? value : resolve(value)) : null
}

const listOfPaths = (raw: string | undefined): string[] | null => {
  const paths = (raw ?? '')
    .split(delimiter)
    .map((p) => absolute(p))
    .filter((p): p is string => p !== null)
  return paths.length ? paths : null
}

export function readEnvSwitches(env: NodeJS.ProcessEnv = process.env): EnvSwitches {
  return {
    userDataPath: absolute(envVar('USER_DATA', env)),
    plainSecrets: envVar('PLAIN_SECRETS', env) === '1',
    smoke: envVar('SMOKE', env) === '1',
    legacyUserDataPath: absolute(env.VORTAQ_LEGACY_USER_DATA ?? env.ELECTRONDB_LEGACY_USER_DATA),
    legacyKeychain: absolute(env.VORTAQ_LEGACY_KEYCHAIN ?? env.ELECTRONDB_LEGACY_KEYCHAIN),
    legacyAppPaths: listOfPaths(env.VORTAQ_LEGACY_APP_PATHS)
  }
}

/**
 * Fixes the profile folder: VORTAQ_USER_DATA when set, else
 * <appData>/Vortaq (explicit, so it never depends on how Electron derived
 * the name from package.json). Must run before app 'ready' so Chromium's own
 * storage lands in the same folder. Returns the folder.
 */
export function applyProfilePath(switches: EnvSwitches): string {
  const dir = switches.userDataPath ?? join(app.getPath('appData'), APP_NAME)
  app.setPath('userData', dir)
  return dir
}

/** Points the file log at <profile>/logs/vortaq.log. */
export function configureFileLog(userDataPath: string): void {
  configureLog({
    filePath: join(userDataPath, 'logs', LOG_FILE_NAME),
    minLevel: envVar('DEBUG') ? 'debug' : 'info'
  })
}

/** Builds the shared application context once Electron's app is ready. */
export function createContext(options: { headless: boolean }): AppContext {
  const switches = readEnvSwitches()
  const userDataPath = app.getPath('userData')
  const logDir = join(userDataPath, 'logs')
  configureFileLog(userDataPath)
  const log = getLogger('bootstrap')

  let credentials: CredentialStore
  if (switches.plainSecrets) {
    log.warn('VORTAQ_PLAIN_SECRETS=1: secrets are stored obfuscated only (test mode)')
    credentials = new CredentialStore(userDataPath, plainCodec, 'plain')
  } else {
    try {
      credentials = new CredentialStore(userDataPath, electronCodec(), 'safeStorage')
    } catch (err) {
      log.warn('safeStorage unavailable, secrets will be stored base64-only (not encrypted)', err)
      credentials = new CredentialStore(userDataPath, plainCodec, 'plain')
      if (!options.headless) raiseNotice(PLAIN_SECRETS_NOTICE)
    }
  }

  const ctx: AppContext = {
    userDataPath,
    logDir,
    connections: new ConnectionsRepo(userDataPath),
    jobs: new JobsRepo(userDataPath),
    runs: new RunsRepo(userDataPath),
    settings: new SettingsRepo(userDataPath, homedir()),
    credentials,
    headless: options.headless,
    isolatedProfile: switches.userDataPath !== null,
    emit: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload)
      }
    }
  }
  configureLog({ sink: (e) => ctx.emit('event:log', e) })
  log.info(
    `context ready (userData=${userDataPath}, headless=${options.headless}, isolated=${ctx.isolatedProfile === true})`
  )
  return ctx
}
