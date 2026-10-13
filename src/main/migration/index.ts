import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StartupNotice } from '@shared/types'
import { AiProvidersRepo } from '../ai/providers'
import { APP_NAME, LEGACY_APPS, LEGACY_ELECTRONDB, type LegacyApp } from '../brand'
import type { AppContext } from '../context'
import { getLogger } from '../log'
import {
  legacySafeStorageServices,
  readLegacySafeStoragePassword,
  type KeychainExecFn,
  type KeychainReadResult
} from './legacyKeychain'
import {
  findLegacyProfiles,
  legacySourceOf,
  migrateLegacyProfile,
  readMigrationMarker,
  writeMigrationMarker,
  type LegacyProfile,
  type MigrationMarker,
  type ProfileMigrationResult
} from './profile'
import { LEGACY_APP_NOTICE, legacyAppNotice } from './legacyApp'
import { migrateLegacySecrets, reenterPasswordsMessage, type RawSecrets } from './secrets'

/**
 * Entry points of the migration from an earlier product name (ElectronDB, or
 * Navidog before it) to Vortaq, wired from index.ts: the profile copy runs
 * before app 'ready', the secret re-encryption right after the context exists
 * (safeStorage needs a ready app) and before any window or scheduler can read
 * a credential.
 */

export interface ProfileMigrationPlan {
  appData: string
  userData: string
  /** VORTAQ_USER_DATA: a scratch profile never imports the real legacy profile. */
  userDataOverride: string | null
  /** VORTAQ_LEGACY_USER_DATA (tests only): explicit legacy folder, migrated even into a scratch profile. */
  legacyUserDataOverride: string | null
  platform?: NodeJS.Platform
}

/**
 * Copies the newest earlier profile into the Vortaq one. An ElectronDB profile
 * wins over a Navidog one (ElectronDB already carries what it copied from
 * Navidog); an empty one gives way to the next name.
 */
export function runProfileMigration(plan: ProfileMigrationPlan): ProfileMigrationResult {
  const log = getLogger('migration')
  let candidates: LegacyProfile[]
  if (plan.legacyUserDataOverride)
    candidates = [
      { dir: plan.legacyUserDataOverride, source: legacySourceOf(plan.legacyUserDataOverride) }
    ]
  else if (plan.userDataOverride) return { status: 'skipped', reason: 'scratch profile' }
  else candidates = findLegacyProfiles(plan.appData)
  if (!candidates.length) return { status: 'skipped', reason: 'no legacy profile' }
  let result: ProfileMigrationResult = { status: 'skipped', reason: 'no legacy profile' }
  for (const { dir, source } of candidates) {
    try {
      result = migrateLegacyProfile({
        from: dir,
        source,
        to: plan.userData,
        platform: plan.platform,
        log
      })
    } catch (err) {
      log.error('profile migration failed; starting with the current profile as is', err)
      return { status: 'skipped', reason: 'failed' }
    }
    if (result.status === 'migrated') return result
    log.debug(`profile migration from ${source.name} skipped: ${result.reason}`)
    if (result.reason !== 'legacy profile is empty') return result
  }
  return result
}

/** Earlier names whose keys may have encrypted a profile copied from `source`, newest first. */
export function legacyKeySources(sourceName: string | undefined): LegacyApp[] {
  const at = LEGACY_APPS.findIndex((a) => a.name === sourceName)
  return at < 0 ? LEGACY_APPS.slice(-1) : LEGACY_APPS.slice(at)
}

export interface SecretMigrationOptions {
  platform?: NodeJS.Platform
  /** Keychain file holding the legacy items (tests use a throwaway keychain). Default: search list. */
  keychain?: string | null
  exec?: KeychainExecFn
}

/**
 * Automatic passes of the secret migration while the legacy key cannot be read
 * for a reason that may go away (access denied, prompt not answered, locked
 * keychain, `security` error). After the last one the missing passwords are
 * given up and the user types them again.
 */
export const MAX_SECRET_ATTEMPTS = 3

/**
 * Values of the legacy profile's credentials.json that the current store
 * lacks, limited to connections (and AI providers) that still exist. Empty when the legacy
 * folder or file is gone.
 */
export function legacySecretsToRetry(
  legacyProfile: string,
  ctx: Pick<AppContext, 'credentials' | 'connections'>,
  aiProviderExists?: (id: string) => boolean
): RawSecrets {
  try {
    const doc = JSON.parse(readFileSync(join(legacyProfile, 'credentials.json'), 'utf8')) as {
      codec?: unknown
      items?: unknown
    }
    const items = doc.items && typeof doc.items === 'object' ? doc.items : {}
    const present = ctx.credentials.rawItems()
    const wanted: Record<string, string> = {}
    for (const [key, cipher] of Object.entries(items as Record<string, unknown>)) {
      const [kind, ...rest] = key.split(':')
      const id = rest.join(':')
      // AI provider keys do not belong to a connection: recovered while the provider exists.
      const owned = kind === 'ai' ? (aiProviderExists?.(id) ?? true) : !!ctx.connections.get(id)
      if (typeof cipher === 'string' && !(key in present) && owned) wanted[key] = cipher
    }
    // Only desktop profiles (ElectronDB, Navidog) are migrated, so a value is plain or
    // safeStorage; the editor extension's 'vaultKey' credentials never come through here.
    return { codec: doc.codec === 'plain' ? 'plain' : 'safeStorage', items: wanted }
  } catch {
    return { codec: 'safeStorage', items: {} }
  }
}

/**
 * Re-encrypts credentials copied by the profile migration. Never throws.
 *
 * The first pass works on the copied credentials.json. When the legacy key
 * could not be read for a transient reason the marker stays 'pending' and
 * the next interactive start retries (up to MAX_SECRET_ATTEMPTS passes),
 * reading the missing values again from the untouched legacy profile. The
 * same path recovers them later if the user sets "secrets" back to
 * "pending" in the marker (see README).
 */
export async function runSecretMigration(
  ctx: Pick<AppContext, 'userDataPath' | 'credentials' | 'connections'>,
  options: SecretMigrationOptions = {}
): Promise<void> {
  const log = getLogger('migration')
  const marker = readMigrationMarker(ctx.userDataPath)
  if (!marker || marker.secrets !== 'pending') return
  const platform = options.platform ?? process.platform
  const attempt = (marker.secretAttempts ?? 0) + 1
  const aiProviders = new AiProvidersRepo(ctx.userDataPath)
  try {
    const result = await migrateLegacySecrets({
      credentials: ctx.credentials,
      connections: ctx.connections,
      aiProviderName: (id) => aiProviders.get(id)?.name,
      platform,
      retry:
        attempt > 1
          ? legacySecretsToRetry(marker.from, ctx, (id) => aiProviders.get(id) !== null)
          : undefined,
      legacyPasswords: legacyKeySources(marker.source).map(
        (app) => (): Promise<KeychainReadResult> =>
          platform === 'darwin'
            ? readLegacySafeStoragePassword({
                keychain: options.keychain,
                exec: options.exec,
                services: legacySafeStorageServices(app)
              })
            : Promise.resolve({
                ok: false,
                reason: 'not-found',
                detail: 'solo macOS guarda la clave en el llavero'
              })
      ),
      log
    })
    const transient = result.legacyKeyReason === 'denied' || result.legacyKeyReason === 'failed'
    const retryLater = result.dropped.length > 0 && transient && attempt < MAX_SECRET_ATTEMPTS
    writeMigrationMarker(ctx.userDataPath, {
      ...marker,
      secrets: retryLater ? 'pending' : 'done',
      secretAttempts: attempt,
      legacyKeyProblem: result.legacyKeyProblem ?? undefined,
      passwordsToReenter: result.passwordsToReenter,
      noticeShown: result.passwordsToReenter.length === 0
    })
    if (retryLater)
      log.warn(
        `secret migration attempt ${attempt}/${MAX_SECRET_ATTEMPTS} could not read the legacy key; ` +
          `${result.dropped.length} value(s) will be retried on the next start`
      )
    else if (result.passwordsToReenter.length)
      log.warn(reenterPasswordsMessage(result.passwordsToReenter))
  } catch (err) {
    log.error('secret migration failed; it will be retried on the next start', err)
  }
}

export const REENTER_PASSWORDS_NOTICE = 'reenter-passwords'
export const PROFILE_MOVED_NOTICE = 'profile-moved'

function movedNotice(marker: MigrationMarker): StartupNotice {
  const source = marker.source ?? 'Navidog'
  return {
    id: PROFILE_MOVED_NOTICE,
    level: 'info',
    title: `${source} ahora se llama ${APP_NAME}`,
    message:
      `Tus conexiones, tareas, ajustes y contraseñas se copiaron a ${APP_NAME} desde ${marker.from}. ` +
      'Esa carpeta no se ha modificado ni borrado: puedes conservarla como copia de seguridad.' +
      (marker.backupsDir
        ? ` Tus copias de seguridad siguen en ${marker.backupsDir}; no la borres mientras las uses.`
        : '')
  }
}

/**
 * Notices the renderer shows once after start (see app:startupNotices).
 * `legacyApps`: ElectronDB bundles still installed (installedLegacyApps), offered
 * for the Trash once after a migration from ElectronDB.
 */
export function startupNotices(
  userDataPath: string,
  legacyApps: () => string[] = () => []
): StartupNotice[] {
  const marker = readMigrationMarker(userDataPath)
  if (!marker) return []
  const notices: StartupNotice[] = []
  // Only markers written by Vortaq carry movedNoticeShown (false until the
  // user closes the notice); ElectronDB's own Navidog markers never show it.
  if (marker.movedNoticeShown === false) notices.push(movedNotice(marker))
  if (
    marker.movedNoticeShown !== undefined &&
    marker.source === LEGACY_ELECTRONDB.name &&
    !marker.legacyAppNoticeShown
  ) {
    const apps = legacyApps()
    if (apps.length) notices.push(legacyAppNotice(apps))
  }
  const names = marker.passwordsToReenter ?? []
  if (marker.noticeShown || names.length === 0) return notices
  const source = marker.source ?? 'Navidog'
  if (marker.secrets === 'pending') {
    const left = MAX_SECRET_ATTEMPTS - (marker.secretAttempts ?? 0)
    notices.push({
      id: REENTER_PASSWORDS_NOTICE,
      level: 'warning',
      title: `Contraseñas de ${source} pendientes`,
      message:
        `No se pudo leer la clave de ${source} en el llavero` +
        (marker.legacyKeyProblem ? ` (${marker.legacyKeyProblem})` : '') +
        `, así que estas contraseñas no están disponibles: ${names.join(', ')}. ` +
        `${APP_NAME} lo intentará de nuevo en el próximo arranque ` +
        `(${left === 1 ? 'queda 1 intento' : `quedan ${left} intentos`}): cuando macOS pregunte, elige «Permitir». ` +
        'Mientras tanto puedes escribirlas de nuevo editando cada conexión.'
    })
    return notices
  }
  notices.push({
    id: REENTER_PASSWORDS_NOTICE,
    level: 'warning',
    title: 'Contraseñas que hay que volver a escribir',
    message:
      `${reenterPasswordsMessage(names)}. ` +
      `Se copiaron tus datos de ${source} a ${APP_NAME}, pero estas contraseñas no se pudieron descifrar. ` +
      'Edita cada conexión y guarda la contraseña de nuevo.'
  })
  return notices
}

export function dismissStartupNotice(userDataPath: string, id: string): void {
  if (id !== REENTER_PASSWORDS_NOTICE && id !== PROFILE_MOVED_NOTICE && id !== LEGACY_APP_NOTICE)
    return
  const marker = readMigrationMarker(userDataPath)
  if (!marker) return
  if (id === LEGACY_APP_NOTICE && !marker.legacyAppNoticeShown)
    writeMigrationMarker(userDataPath, { ...marker, legacyAppNoticeShown: true })
  if (id === PROFILE_MOVED_NOTICE && marker.movedNoticeShown === false)
    writeMigrationMarker(userDataPath, { ...marker, movedNoticeShown: true })
  if (id === REENTER_PASSWORDS_NOTICE && !marker.noticeShown)
    writeMigrationMarker(userDataPath, { ...marker, noticeShown: true })
}
