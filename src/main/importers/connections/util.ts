import { serverOf } from '@shared/sqlserver/connectionString'
import { isAbsolutePathFor } from '@shared/connectionValidation'
import type {
  EngineId,
  MongoAuthMechanism,
  MongoReadPreference,
  MongoTopology,
  SslConfig,
  SslMode
} from '@shared/types'
import {
  FOREIGN_PATH_WARNING,
  sqliteFileReviewWarning,
  unsupportedEngine,
  type FileExists,
  type ParsedConnection
} from './types'

/** A path written on another OS: a drive/UNC path on macOS/Linux, a POSIX path on Windows. */
export function isForeignPath(path: string, platform: NodeJS.Platform): boolean {
  const p = path.trim()
  if (!p) return false
  if (platform === 'win32') return p.startsWith('/')
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

/** Adds the foreign-path warning once when any of `paths` comes from another OS. */
export function checkForeignPaths(
  paths: (string | undefined)[],
  platform: NodeJS.Platform,
  warnings: string[]
): void {
  if (
    paths.some((p) => p && isForeignPath(p, platform)) &&
    !warnings.includes(FOREIGN_PATH_WARNING)
  )
    warnings.push(FOREIGN_PATH_WARNING)
}

export const DEFAULT_PORTS: Record<string, number> = {
  mysql: 3306,
  mariadb: 3306,
  postgresql: 5432,
  sqlite: 0,
  mongodb: 27017,
  sqlserver: 1433,
  oracle: 1521,
  redis: 6379,
  snowflake: 443
}

export interface EngineChoice {
  engine: EngineId | null
  unsupportedReason: string | null
  warning: string | null
}

/** Engine Vortaq creates for a MySQL-family connection (MariaDB is its own engine since P5). */
export function mysqlFamily(isMariaDb: boolean): EngineChoice {
  return { engine: isMariaDb ? 'mariadb' : 'mysql', unsupportedReason: null, warning: null }
}

export function unsupported(label: string): EngineChoice {
  return { engine: null, unsupportedReason: unsupportedEngine(label), warning: null }
}

export function positiveInt(value: unknown, fallback: number): number {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback
}

export const isLoopback = (host: string): boolean => {
  const h = host.trim().toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}

/** `#rrggbb` from `#rgb`, `#rrggbb` or `r,g,b`; null for anything else. */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  let m = /^#?([0-9a-f]{6})$/i.exec(v)
  if (m) return `#${m[1].toLowerCase()}`
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v)
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase()
  const rgb = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(v)
  if (rgb) {
    const parts = rgb.slice(1, 4).map(Number)
    if (parts.some((n) => n > 255)) return null
    return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`
  }
  return null
}

/** Strips a UTF-8 byte order mark. */
export const stripBom = (text: string): string => text.replace(/^\uFEFF/, '')

/** Makes keys unique within a file (`name`, `name#2`…). */
export function uniqueKey(base: string, used: Set<string>): string {
  let key = base
  for (let i = 2; used.has(key); i++) key = `${base}#${i}`
  used.add(key)
  return key
}

/* ---------- PostgreSQL ---------- */

/** PostgreSQL-compatible servers whose catalog differs: listed but not importable. */
const POSTGRES_FORKS: [RegExp, string][] = [
  [/redshift/i, 'Amazon Redshift'],
  [/opengauss/i, 'openGauss'],
  [/gauss/i, 'GaussDB'],
  [/kingbase/i, 'KingbaseES']
]

export const postgresForkReason = (label: string): string =>
  `${label} no es compatible: su catálogo es distinto del de PostgreSQL`

/** Engine for a PostgreSQL connection; a known fork (by service provider or driver) is unsupported. */
export function postgresFamily(provider = ''): EngineChoice {
  const fork = POSTGRES_FORKS.find(([re]) => re.test(provider))
  if (fork) return { engine: null, unsupportedReason: postgresForkReason(fork[1]), warning: null }
  return { engine: 'postgresql', unsupportedReason: null, warning: null }
}

const SSL_MODES: readonly SslMode[] = [
  'disable',
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full'
]

export const unknownSslModeWarning = (raw: string): string =>
  `Modo SSL desconocido «${raw}»: se usa el predeterminado`

/**
 * Applies a libpq sslmode spelling (`verify-full`, `VERIFY_FULL`, `verifyFull`…) to `ssl`.
 * Empty leaves `ssl` as it is; an unknown value adds a warning and keeps the default.
 */
export function applySslMode(ssl: SslConfig, raw: string, warnings: string[]): SslConfig {
  const value = raw.trim()
  if (!value) return ssl
  const norm = value
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
  const mode = SSL_MODES.find((m) => m === norm)
  if (!mode) {
    warnings.push(unknownSslModeWarning(value))
    return ssl
  }
  return {
    ...ssl,
    mode,
    enabled: mode !== 'disable',
    verifyServer: mode === 'verify-ca' || mode === 'verify-full'
  }
}

export const multiHostWarning = (host: string): string =>
  `Varios servidores: solo se usa el primero (${host})`

/**
 * First host of a `h1,h2` / `h1:5432,h2:5433` list (failover is not supported) plus its port,
 * with a warning; a single host is returned unchanged.
 */
export function firstHost(raw: string, warnings: string[]): { host: string; port: number | null } {
  const value = raw.trim()
  if (!value.includes(',')) return { host: value, port: null }
  const first = value.split(',')[0].trim()
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(first)
  const host = (m?.[1] ?? first).replace(/^\[|\]$/g, '')
  warnings.push(multiHostWarning(host))
  return { host, port: m?.[2] ? Number(m[2]) : null }
}

/* ---------- SQL Server ---------- */

export const SQLSERVER_CHOICE: EngineChoice = {
  engine: 'sqlserver',
  unsupportedReason: null,
  warning: null
}

/**
 * Host field of a SQL Server connection as managers store it: `host`,
 * `host,port`, `host\\INSTANCE`, `tcp:host`, `(local)`… Named pipes and LocalDB add
 * a warning (Vortaq connects over TCP).
 */
export function sqlServerHost(
  raw: string,
  port: number,
  warnings: string[]
): { host: string; port: number; instanceName: string } {
  const server = serverOf(raw, warnings)
  return { host: server.host, port: server.port ?? port, instanceName: server.instance }
}

/* ---------- SQLite ---------- */

export const SQLITE_CHOICE: EngineChoice = {
  engine: 'sqlite',
  unsupportedReason: null,
  warning: null
}

/**
 * SQLite block of an imported connection. Only the path text is looked at
 * (absolute on this OS, and an existence check): the file is never opened or
 * created. A path that needs review adds a warning naming the connection.
 */
export function sqliteBlock(
  name: string,
  filePath: string,
  platform: NodeJS.Platform,
  exists: FileExists,
  warnings: string[]
): NonNullable<ParsedConnection['sqlite']> {
  const path = filePath.trim()
  const pathNeedsReview = !path || !isAbsolutePathFor(path, platform) || !exists(path)
  if (pathNeedsReview) warnings.push(sqliteFileReviewWarning(name))
  return { filePath: path, pathNeedsReview, attached: [] }
}

/* ---------- MongoDB ---------- */

export const MONGO_CHOICE: EngineChoice = {
  engine: 'mongodb',
  unsupportedReason: null,
  warning: null
}

export const MONGO_RETRY_WRITES_WARNING = (provider: string): string =>
  `${provider}: se desactivan las escrituras reintentables (retryWrites=false), que no admite`
export const MONGO_KERBEROS_REASON =
  'Autenticación Kerberos/GSSAPI, AWS u OIDC: no soportada en esta versión'
export const MONGO_URL_PASSWORD_WARNING =
  'La URL incluía una contraseña: no se importa; escríbela al editar la conexión'
export const unknownMongoValueWarning = (what: string, raw: string): string =>
  `${what} desconocido «${raw}»: se usa el predeterminado`

const norm = (v: string | undefined): string =>
  (v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')

/** Topology from Navicat/DBeaver spellings («Replica Set», `REPLICASET`, `shardcluster`…). */
export function mongoTopologyOf(
  raw: string | undefined,
  warnings: string[]
): { topology: MongoTopology; srv: boolean } | null {
  const v = norm(raw)
  if (!v) return null
  if (v === 'standalone' || v === 'direct' || v === 'single')
    return { topology: 'standalone', srv: false }
  if (v === 'replicaset' || v === 'replset') return { topology: 'replicaSet', srv: false }
  if (v === 'shardcluster' || v === 'sharded' || v === 'shardedcluster' || v === 'mongos')
    return { topology: 'shardCluster', srv: false }
  if (v === 'srv' || v === 'srvrecord' || v === 'dnsseedlist')
    return { topology: 'replicaSet', srv: true }
  warnings.push(unknownMongoValueWarning('Método de conexión', raw ?? ''))
  return null
}

/** Mechanism from `SCRAM-SHA-256`, `X509`, `LDAP`… ; GSSAPI/AWS/OIDC give the unsupported reason. */
export function mongoMechanismOf(
  raw: string | undefined,
  warnings: string[]
): { mechanism: MongoAuthMechanism | null; unsupported: string | null } {
  const v = norm(raw)
  if (!v) return { mechanism: null, unsupported: null }
  if (v === 'scramsha256') return { mechanism: 'scram-sha-256', unsupported: null }
  if (v === 'scramsha1') return { mechanism: 'scram-sha-1', unsupported: null }
  if (v === 'scram' || v === 'default' || v === 'password')
    return { mechanism: 'default', unsupported: null }
  if (v === 'x509' || v === 'mongodbx509') return { mechanism: 'x509', unsupported: null }
  if (v === 'plain' || v === 'ldap') return { mechanism: 'plain', unsupported: null }
  if (v === 'none' || v === 'noauth') return { mechanism: 'none', unsupported: null }
  if (/gssapi|kerberos|aws|oidc/.test(v))
    return { mechanism: null, unsupported: MONGO_KERBEROS_REASON }
  warnings.push(unknownMongoValueWarning('Mecanismo de autenticación', raw ?? ''))
  return { mechanism: null, unsupported: null }
}

const READ_PREFS: MongoReadPreference[] = [
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest'
]

export function mongoReadPreferenceOf(
  raw: string | undefined,
  warnings: string[]
): MongoReadPreference | null {
  const v = norm(raw)
  if (!v) return null
  const hit = READ_PREFS.find((p) => p.toLowerCase() === v)
  if (hit) return hit
  warnings.push(unknownMongoValueWarning('Preferencia de lectura', raw ?? ''))
  return null
}

/** Service providers that cannot use retryable writes. */
export function mongoProviderNeedsNoRetry(provider: string): string | null {
  const v = norm(provider)
  if (v.includes('documentdb')) return 'Amazon DocumentDB'
  if (v.includes('cosmos')) return 'Azure Cosmos DB'
  return null
}
