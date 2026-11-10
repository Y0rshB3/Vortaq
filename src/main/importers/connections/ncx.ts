import { existsSync } from 'node:fs'
import type { SshConfig, SslConfig } from '@shared/types'
import { decryptNcxAes, decryptNcxBlowfish } from '../navicat/ncxCipher'
import { inferEnvironment } from '../../navicat/connPlist'
import {
  NO_SSH,
  NO_SSL,
  SQLITE_ENCRYPTED_REASON,
  type ConnectionSecrets,
  type FileExists,
  type ParsedConnection,
  type ParsedConnectionFile
} from './types'
import {
  DEFAULT_PORTS,
  applySslMode,
  checkForeignPaths,
  firstHost,
  mysqlFamily,
  normalizeColor,
  positiveInt,
  postgresFamily,
  MONGO_CHOICE,
  MONGO_RETRY_WRITES_WARNING,
  SQLITE_CHOICE,
  mongoMechanismOf,
  mongoProviderNeedsNoRetry,
  mongoReadPreferenceOf,
  mongoTopologyOf,
  sqliteBlock,
  SQLSERVER_CHOICE,
  sqlServerHost,
  uniqueKey,
  unsupported,
  type EngineChoice
} from './util'
import type { Element } from '@xmldom/xmldom'
import { attributeMap, childElements, parseXml } from './xml'

/**
 * Navicat connection export files (.ncx, «Export Connections»). Only the
 * file the user exported and picked is read. Format notes:
 * docs/navicat-storage.md («Archivo .ncx»).
 *
 * <Connections Ver="1.5"><Connection ConnectionName=… ConnType="MYSQL" Host=… …/></Connections>
 * Ver 1.1/1.4 write every attribute; 1.5 omits default/off ones, so every
 * attribute is optional here.
 */

export const NCX_INVALID_MESSAGE =
  'El archivo no es un .ncx válido. Expórtalo de nuevo desde Navicat con «Export Connections» y elige ese archivo.'
export const NCX_PASSWORDS_NOTE =
  'Este archivo contiene contraseñas recuperables: bórralo después de importar.'
export const NCX_NO_PASSWORDS_NOTE =
  'El archivo no incluye contraseñas (se exportó sin «Export Password»): escríbelas al editar cada conexión.'
export const HTTP_TUNNEL_WARNING = 'Túnel HTTP no soportado'

/** ConnType -> the type name Navicat's plist uses (the import identity with the name). */
const TYPE_LABELS: Record<string, string> = {
  MYSQL: 'MySQL',
  MARIADB: 'MariaDB',
  POSTGRESQL: 'PostgreSQL',
  SQLITE: 'SQLite',
  MONGODB: 'MongoDB',
  SQLSERVER: 'SQL Server',
  ORACLE: 'Oracle',
  REDIS: 'Redis',
  SNOWFLAKE: 'Snowflake'
}

export function navicatTypeLabel(connType: string): string {
  const key = connType.trim().toUpperCase()
  return TYPE_LABELS[key] ?? (connType.trim() || 'Desconocido')
}

/** Version number of `Ver="1.4"`; NaN when missing or unreadable. */
function versionOf(raw: string | undefined): number {
  const m = /^\s*(\d+)(?:\.(\d+))?/.exec(raw ?? '')
  return m ? Number(m[1]) + Number(m[2] ?? 0) / 100 : NaN
}

/**
 * Decodes one password attribute. Files older than Ver 1.4 use the Blowfish
 * scheme, newer ones AES; the other scheme is tried as a fallback.
 */
export function decodeNcxSecret(raw: string | undefined, ver: string | undefined): string | null {
  const value = (raw ?? '').trim()
  if (!value) return null
  const v = versionOf(ver)
  const old = Number.isFinite(v) && v < 1.04
  return old
    ? (decryptNcxBlowfish(value) ?? decryptNcxAes(value))
    : (decryptNcxAes(value) ?? decryptNcxBlowfish(value))
}

const bool = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'true'
const path = (v: string | undefined): string | undefined => {
  const s = (v ?? '').trim()
  return s ? s : undefined
}

function engineFor(connType: string, serviceProvider: string): EngineChoice {
  const key = connType.trim().toUpperCase()
  if (key === 'MYSQL') return mysqlFamily(false)
  if (key === 'MARIADB') return mysqlFamily(true)
  if (key === 'POSTGRESQL') return postgresFamily(serviceProvider)
  if (key === 'SQLITE') return SQLITE_CHOICE
  if (key === 'MONGODB') return MONGO_CHOICE
  if (key === 'SQLSERVER') return SQLSERVER_CHOICE
  return unsupported(navicatTypeLabel(connType))
}

/** Parses .ncx text. Throws NCX_INVALID_MESSAGE when it is not an .ncx file. */
export function parseNcx(
  xml: string,
  platform: NodeJS.Platform = process.platform,
  fileExists: FileExists = existsSync
): ParsedConnectionFile {
  const doc = parseXml(xml, NCX_INVALID_MESSAGE)
  const root = doc.documentElement!
  if (root.nodeName !== 'Connections') throw new Error(NCX_INVALID_MESSAGE)
  const ver = attributeMap(root).get('ver')
  const used = new Set<string>()
  const connections: ParsedConnection[] = []

  for (const el of childElements(root, 'Connection')) {
    const a = attributeMap(el)
    const get = (name: string): string | undefined => a.get(name.toLowerCase())
    const name = (get('ConnectionName') ?? '').trim()
    if (!name) continue
    const connType = get('ConnType') ?? 'MYSQL'
    const navicatType = navicatTypeLabel(connType)
    const postgres = connType.trim().toUpperCase() === 'POSTGRESQL'
    const choice = engineFor(connType, (get('ServiceProvider') ?? '').trim())
    const warnings: string[] = []
    if (choice.warning) warnings.push(choice.warning)

    if (choice.engine === 'sqlite') {
      // DatabaseFileName: the file on the source machine. SQLiteEncrypt (Ver 1.4+) or
      // SQLiteEncryption (Ver 1.1) mark Navicat's encrypted files, which cannot be opened.
      // Their passwords (SQLiteEncryptPassword) are never read.
      const filePath = (get('DatabaseFileName') ?? '').trim()
      const encrypted = bool(get('SQLiteEncrypt')) || bool(get('SQLiteEncryption'))
      connections.push({
        key: uniqueKey(`${navicatType}:${name}`, used),
        name,
        engine: choice.engine,
        engineLabel: navicatType,
        unsupportedReason: encrypted ? SQLITE_ENCRYPTED_REASON : null,
        host: '',
        port: 0,
        username: '',
        database: filePath || null,
        color: normalizeColor(get('Color') ?? get('ConnectionColor')),
        environment: inferEnvironment(name, '', false),
        ssh: { ...NO_SSH },
        ssl: { ...NO_SSL },
        secrets: {},
        warnings,
        navicatType,
        sqlite: sqliteBlock(name, filePath, platform, fileExists, warnings)
      })
      continue
    }
    if (choice.engine === 'mongodb') {
      connections.push(parseNcxMongo(el, get, name, navicatType, ver, platform, warnings, used))
      continue
    }
    // PostgreSQL may list several hosts (failover): only the first one is used.
    const hostList = postgres
      ? firstHost(get('Host') ?? '', warnings)
      : { host: (get('Host') ?? '').trim(), port: null }
    const sqlserver = choice.engine === 'sqlserver'
    const defaultPort = hostList.port ?? DEFAULT_PORTS[connType.trim().toLowerCase()] ?? 3306
    // SQL Server: Host may carry `\\INSTANCE` or `,port` (Navicat's own field).
    const msServer = sqlserver
      ? sqlServerHost(hostList.host, positiveInt(get('Port'), defaultPort), warnings)
      : null
    const host = msServer ? msServer.host : hostList.host

    const sshAuthKey = (get('SSH_AuthenMethod') ?? '').trim().toUpperCase() === 'PUBLICKEY'
    const ssh: SshConfig = bool(get('SSH'))
      ? {
          enabled: true,
          host: (get('SSH_Host') ?? '').trim(),
          port: positiveInt(get('SSH_Port'), 22),
          username: (get('SSH_UserName') ?? '').trim(),
          authType: sshAuthKey ? 'key' : 'password',
          savePassword: false
        }
      : { ...NO_SSH }
    const keyPath = path(get('SSH_PrivateKey'))
    if (ssh.enabled && sshAuthKey && keyPath) ssh.privateKeyPath = keyPath

    let ssl: SslConfig = { enabled: bool(get('SSL')), verifyServer: false }
    const ca = path(get('SSL_CACert'))
    const cert = path(get('SSL_ClientCert'))
    const key = path(get('SSL_ClientKey'))
    if (ssl.enabled) {
      if (ca) ssl.caCertPath = ca
      if (cert) ssl.clientCertPath = cert
      if (key) ssl.clientKeyPath = key
      // Unverified attribute names: verification is on only when the file says so.
      ssl.verifyServer = bool(get('SSL_VerifyCA')) || (bool(get('SSL_Authen')) && !!ca)
    }
    // PostgreSQL SSL mode (unverified attribute names; tolerant spellings).
    if (postgres) ssl = applySslMode(ssl, get('SSL_Mode') ?? get('SSLMode') ?? '', warnings)
    checkForeignPaths(
      [
        ssh.enabled ? ssh.privateKeyPath : undefined,
        ssl.caCertPath,
        ssl.clientCertPath,
        ssl.clientKeyPath
      ],
      platform,
      warnings
    )
    if (bool(get('HTTP'))) warnings.push(HTTP_TUNNEL_WARNING)

    const secrets: ConnectionSecrets = {}
    const db = decodeNcxSecret(get('Password'), ver)
    if (db !== null) secrets.mysql = db
    const sshSecret = decodeNcxSecret(sshAuthKey ? get('SSH_Passphrase') : get('SSH_Password'), ver)
    if (ssh.enabled && sshSecret !== null) {
      secrets.ssh = sshSecret
      ssh.savePassword = true
    }
    const sslKey = decodeNcxSecret(get('SSL_PEMClientKeyPassword'), ver)
    if (ssl.enabled && sslKey !== null) secrets.sslKey = sslKey

    connections.push({
      key: uniqueKey(`${navicatType}:${name}`, used),
      name,
      engine: choice.engine,
      engineLabel: navicatType,
      unsupportedReason: choice.unsupportedReason,
      host,
      port: msServer ? msServer.port : positiveInt(get('Port'), defaultPort),
      username: (get('UserName') ?? '').trim(),
      database:
        (postgres || sqlserver ? path(get('InitialDatabase')) : undefined) ??
        path(get('Database')) ??
        null,
      ...(msServer
        ? {
            sqlserver: {
              ...(msServer.instanceName ? { instanceName: msServer.instanceName } : {}),
              // Unverified attribute names: Windows sign-in only when the file says so.
              ...(/WINDOWS/i.test(get('AuthenMethod') ?? get('AuthenticationMethod') ?? '')
                ? { auth: 'windows' as const }
                : {}),
              encrypt: ssl.enabled ? ('mandatory' as const) : ('optional' as const),
              trustServerCertificate: ssl.enabled && !ssl.verifyServer
            }
          }
        : {}),
      color: normalizeColor(get('Color') ?? get('ConnectionColor')),
      environment: inferEnvironment(name, host, ssh.enabled),
      ssh,
      ssl,
      secrets,
      warnings,
      navicatType
    })
  }

  const withPassword = connections.some((c) => Object.keys(c.secrets).length > 0)
  return {
    connections,
    notes: connections.length ? [withPassword ? NCX_PASSWORDS_NOTE : NCX_NO_PASSWORDS_NOTE] : []
  }
}

/**
 * MongoDB in an .ncx (docs/navicat-storage.md; attribute names from public
 * parsers, read case-insensitively and never required). A replica set's seeds
 * come from `<Member Host Port>` children (its `Host="localhost"` is a
 * placeholder) and the database from `<Advance Database>`.
 */
function parseNcxMongo(
  el: Element,
  get: (name: string) => string | undefined,
  name: string,
  navicatType: string,
  ver: string | undefined,
  platform: NodeJS.Platform,
  warnings: string[],
  used: Set<string>
): ParsedConnection {
  const first = (...names: string[]): string | undefined => {
    for (const n of names) {
      const v = get(n)
      if (v !== undefined && v.trim() !== '') return v.trim()
    }
    return undefined
  }
  const members = childElements(el, 'Member')
    .map((m) => {
      const a = attributeMap(m)
      const host = (a.get('host') ?? '').trim()
      return host ? { host, port: positiveInt(a.get('port'), 27017) } : null
    })
    .filter((m): m is { host: string; port: number } => !!m)
  const advance = childElements(el, 'Advance')[0]
  const advanceDb = advance ? (attributeMap(advance).get('database') ?? '').trim() : ''
  const method = mongoTopologyOf(
    first('ConnMethod', 'ConnectionMethod', 'MongoDBConnMethod'),
    warnings
  )
  const srv = bool(first('UseSRVRecord', 'SRV', 'UseSRV')) || method?.srv === true
  const topology = method?.topology ?? (members.length > 1 ? 'replicaSet' : 'standalone')
  const auth = mongoMechanismOf(
    first('AuthMechanism', 'AuthenticationMechanism', 'MongoDBAuthMechanism'),
    warnings
  )
  const readPreference = mongoReadPreferenceOf(first('ReadPreference'), warnings)
  const provider = (first('ServiceProvider') ?? '').trim()
  const noRetry = mongoProviderNeedsNoRetry(provider)
  if (noRetry) warnings.push(MONGO_RETRY_WRITES_WARNING(noRetry))
  const tls = bool(get('SSL')) || srv || /atlas/i.test(provider)
  const seedList = topology !== 'standalone' && !srv && members.length > 0
  const host = seedList ? members[0].host : (first('Host') ?? '').trim()
  const port = srv ? 0 : seedList ? members[0].port : positiveInt(get('Port'), 27017)

  const sshAuthKey = (get('SSH_AuthenMethod') ?? '').trim().toUpperCase() === 'PUBLICKEY'
  const ssh: SshConfig = bool(get('SSH'))
    ? {
        enabled: true,
        host: (get('SSH_Host') ?? '').trim(),
        port: positiveInt(get('SSH_Port'), 22),
        username: (get('SSH_UserName') ?? '').trim(),
        authType: sshAuthKey ? 'key' : 'password',
        savePassword: false
      }
    : { ...NO_SSH }
  const keyPath = path(get('SSH_PrivateKey'))
  if (ssh.enabled && sshAuthKey && keyPath) ssh.privateKeyPath = keyPath
  const ssl: SslConfig = { enabled: tls, verifyServer: tls }
  const ca = path(get('SSL_CACert'))
  const cert = path(get('SSL_ClientCert')) ?? path(get('SSL_PEMClientCert'))
  const key = path(get('SSL_ClientKey'))
  if (tls) {
    if (ca) ssl.caCertPath = ca
    if (cert) ssl.clientCertPath = cert
    if (key) ssl.clientKeyPath = key
    if (bool(get('SSL_AllowInvalidHostnames')) || bool(get('SSL_AllowInvalidCertificates')))
      ssl.verifyServer = false
  }
  checkForeignPaths(
    [
      ssh.enabled ? ssh.privateKeyPath : undefined,
      ssl.caCertPath,
      ssl.clientCertPath,
      ssl.clientKeyPath
    ],
    platform,
    warnings
  )
  if (bool(get('HTTP'))) warnings.push(HTTP_TUNNEL_WARNING)

  const username = (get('UserName') ?? '').trim()
  const secrets: ConnectionSecrets = {}
  const db = decodeNcxSecret(get('Password'), ver)
  if (db !== null) secrets.mysql = db
  const sshSecret = decodeNcxSecret(sshAuthKey ? get('SSH_Passphrase') : get('SSH_Password'), ver)
  if (ssh.enabled && sshSecret !== null) {
    secrets.ssh = sshSecret
    ssh.savePassword = true
  }
  const sslKey = decodeNcxSecret(get('SSL_PEMClientKeyPassword'), ver)
  if (ssl.enabled && sslKey !== null) secrets.sslKey = sslKey

  const mechanism = auth.mechanism ?? (username ? 'default' : 'none')
  const database = advanceDb || first('Database', 'DefaultDatabase') || ''
  const retry = (v: string | undefined, fallback: boolean): boolean =>
    v === undefined || v.trim() === '' ? fallback : bool(v)
  return {
    key: uniqueKey(`${navicatType}:${name}`, used),
    name,
    engine: 'mongodb',
    engineLabel: navicatType,
    unsupportedReason: auth.unsupported,
    host,
    port,
    username,
    database: database || null,
    color: normalizeColor(get('Color') ?? get('ConnectionColor')),
    environment: inferEnvironment(name, host, ssh.enabled),
    ssh,
    ssl,
    secrets,
    warnings,
    navicatType,
    mongo: {
      topology,
      srv,
      members: seedList ? members : [],
      replicaSet: (first('ReplicaSetName', 'ReplicaSet') ?? '').trim(),
      authMechanism: mechanism,
      authSource: first('AuthSource', 'AuthenticationDatabase', 'AuthDatabase') ?? 'admin',
      defaultDatabase: database,
      ...(readPreference ? { readPreference } : {}),
      directConnection: ssh.enabled,
      retryWrites: noRetry ? false : retry(get('RetryWrites'), true),
      retryReads: retry(get('RetryReads'), true)
    }
  }
}
