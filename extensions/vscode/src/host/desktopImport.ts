/**
 * «Importar conexiones de Vortaq»: reads the connections.json of the user's
 * own Vortaq desktop profile, only when they run the command, and turns each
 * entry into a ConnectionInput for this extension's own profile
 * (docs/vscode-extension-design.md, "Connection import").
 *
 * Passwords are never read: credentials.json is encrypted with the desktop
 * app's key (the OS keychain item of its safeStorage) and this module never
 * opens it. The user types each password once when connecting; it is then
 * stored in the extension's own vault. No `vscode` import (unit-tested).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  connectionSaveError,
  ENGINES,
  environmentName,
  isEngineId,
  isEnvironment,
  withEngineDefaults,
  type ConnectionInput,
  type EngineId,
  type Environment
} from '@core'

/** The desktop app's profile folder name (src/main/brand.ts APP_NAME). */
const DESKTOP_APP = 'Vortaq'
export const CONNECTIONS_FILE = 'connections.json'

export interface DesktopConnection {
  name: string
  engine: EngineId
  environment: Environment
  /** «MySQL · 127.0.0.1:3306», «SQLite · /ruta/app.db». */
  summary: string
  /** Ready for connections:save: no id, no secrets, no backup folders of the desktop app. */
  input: ConnectionInput
}

export interface DesktopImportPreview {
  connections: DesktopConnection[]
  /** Entries left out, with the reason (shown to the user). */
  skipped: { name: string; reason: string }[]
}

/**
 * The desktop profile folder: Electron's userData for the app name. Tests and
 * screenshots pass `VORTAQ_TEST_DESKTOP_PROFILE` (test-only, like
 * VORTAQ_NAVICAT_CANDIDATES) so the real profile is never read.
 */
export function desktopProfileDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string {
  const override = env.VORTAQ_TEST_DESKTOP_PROFILE?.trim()
  if (override) return override
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', DESKTOP_APP)
  if (platform === 'win32')
    return join(env.APPDATA?.trim() || join(home, 'AppData', 'Roaming'), DESKTOP_APP)
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), DESKTOP_APP)
}

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Copies only `keys` of `source` (a hand-edited file may carry anything else). */
function pick(source: unknown, keys: readonly string[]): Json | undefined {
  if (!isRecord(source)) return undefined
  const out: Json = {}
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out
}

const SSH_KEYS = [
  'enabled',
  'host',
  'port',
  'username',
  'authType',
  'privateKeyPath',
  'savePassword'
]
const SSL_KEYS = [
  'enabled',
  'caCertPath',
  'clientCertPath',
  'clientKeyPath',
  'verifyServer',
  'mode'
]
const NETWORK_KEYS = ['connectTimeoutMs', 'keepAliveSec']
const POSTGRES_KEYS = ['initialDatabase', 'showSystemSchemas', 'timeZone', 'searchPath']
const SQLITE_KEYS = ['filePath', 'pathNeedsReview', 'readOnly', 'foreignKeys', 'busyTimeoutMs']
const MONGO_KEYS = [
  'topology',
  'srv',
  'members',
  'replicaSet',
  'authMechanism',
  'authSource',
  'defaultDatabase',
  'readPreference',
  'directConnection',
  'retryWrites',
  'retryReads',
  'extraOptions'
]

const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []

/** ConnectionInput of one stored record, from known fields only. */
function inputOf(record: Json): ConnectionInput {
  const engine = isEngineId(record.engine) ? record.engine : 'mysql'
  const sqlite = pick(record.sqlite, SQLITE_KEYS)
  if (sqlite && isRecord(record.sqlite) && Array.isArray(record.sqlite.attached))
    sqlite.attached = record.sqlite.attached
      .filter(isRecord)
      .map((a) => pick(a, ['alias', 'filePath', 'pathNeedsReview']))
  const input = {
    name: text(record.name).trim(),
    color: typeof record.color === 'string' ? record.color : null,
    environment: isEnvironment(record.environment) ? record.environment : 'local',
    host: text(record.host),
    port: typeof record.port === 'number' ? record.port : 0,
    username: text(record.username),
    authMode: record.authMode === 'none' ? 'none' : 'password',
    savePassword: record.savePassword !== false,
    customDatabases: strings(record.customDatabases),
    initialQueries: text(record.initialQueries),
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      savePassword: true,
      ...pick(record.ssh, SSH_KEYS)
    },
    ssl: { enabled: false, verifyServer: false, ...pick(record.ssl, SSL_KEYS) },
    // The desktop app's backup folders stay with the desktop app (no backups here yet).
    backupDir: '',
    extraBackupDirs: [],
    engine,
    ...(record.network !== undefined ? { network: pick(record.network, NETWORK_KEYS) } : {}),
    ...(record.postgres !== undefined ? { postgres: pick(record.postgres, POSTGRES_KEYS) } : {}),
    ...(sqlite ? { sqlite } : {}),
    ...(record.mongo !== undefined ? { mongo: pick(record.mongo, MONGO_KEYS) } : {})
  } as ConnectionInput
  return withEngineDefaults(input)
}

function summaryOf(input: ConnectionInput): string {
  const engine = ENGINES[input.engine ?? 'mysql']
  if (input.engine === 'sqlite') return `${engine.label} · ${input.sqlite?.filePath ?? ''}`
  const where =
    input.engine === 'mongodb' && input.mongo?.srv ? input.host : `${input.host}:${input.port}`
  return `${engine.label} · ${where}${input.ssh.enabled ? ' (SSH)' : ''}`
}

/**
 * Connections of a desktop connections.json (`{ items: [...] }`). Invalid
 * entries are skipped with the reason; nothing here throws for one bad entry.
 */
export function parseDesktopConnections(
  json: string,
  platform: NodeJS.Platform = process.platform
): DesktopImportPreview {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    throw new Error('El archivo connections.json de Vortaq no es JSON válido.')
  }
  const items = isRecord(doc) && Array.isArray(doc.items) ? doc.items : null
  if (!items)
    throw new Error('El archivo no es un connections.json de Vortaq (falta la lista «items»).')
  const preview: DesktopImportPreview = { connections: [], skipped: [] }
  for (const item of items) {
    if (!isRecord(item)) continue
    const name = text(item.name).trim() || '(sin nombre)'
    const input = inputOf(item)
    const problem = connectionSaveError(input, { platform })
    if (problem) {
      preview.skipped.push({ name, reason: problem })
      continue
    }
    preview.connections.push({
      name: input.name,
      engine: input.engine ?? 'mysql',
      environment: input.environment,
      summary: summaryOf(input),
      input
    })
  }
  preview.connections.sort((a, b) => a.name.localeCompare(b.name, 'es'))
  return preview
}

/** Reads `<dir>/connections.json` only (never credentials.json or anything else). */
export function readDesktopConnections(
  dir: string,
  platform: NodeJS.Platform = process.platform
): DesktopImportPreview {
  let json: string
  try {
    json = readFileSync(join(dir, CONNECTIONS_FILE), 'utf8')
  } catch {
    throw new Error(
      `No se encontró ${CONNECTIONS_FILE} de Vortaq en ${dir}. Elige el archivo a mano o comprueba que la aplicación de escritorio tiene conexiones.`
    )
  }
  return parseDesktopConnections(json, platform)
}

/** «Producción», «Local»… for the import list. */
export function environmentText(environment: Environment): string {
  return environmentName(environment)
}
