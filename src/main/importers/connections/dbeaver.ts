import { parseSqlServerConnectionString } from '@shared/sqlserver/connectionString'
import { existsSync } from 'node:fs'
import { parseMongoUri } from '@shared/mongo/uri'
import type { Environment, SshConfig, SslConfig } from '@shared/types'
import { inferEnvironment } from '../../navicat/connPlist'
import {
  NO_SSH,
  NO_SSL,
  type FileExists,
  type ParsedConnection,
  type ParsedConnectionFile
} from './types'
import {
  applySslMode,
  checkForeignPaths,
  firstHost,
  isLoopback,
  mysqlFamily,
  normalizeColor,
  positiveInt,
  postgresFamily,
  MONGO_CHOICE,
  MONGO_URL_PASSWORD_WARNING,
  SQLITE_CHOICE,
  sqliteBlock,
  SQLSERVER_CHOICE,
  sqlServerHost,
  stripBom,
  uniqueKey,
  unsupported,
  type EngineChoice
} from './util'

/**
 * DBeaver workspace connections (`.dbeaver/data-sources.json`). Only this
 * plain JSON file is read. Users and passwords that DBeaver keeps in its
 * encrypted credentials file are never read or decrypted: connections are
 * imported without passwords.
 */

export const DBEAVER_INVALID_MESSAGE =
  'El archivo no es un data-sources.json de DBeaver válido. Elige el archivo .dbeaver/data-sources.json de tu espacio de trabajo.'
export const DBEAVER_PASSWORDS_NOTE =
  'Las contraseñas no se importan: DBeaver las guarda cifradas. Escríbelas al editar cada conexión.'
export const DBEAVER_USER_WARNING =
  'El usuario está en el almacén cifrado de DBeaver: escríbelo al editar la conexión'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
const bool = (v: unknown): boolean => v === true || v === 'true'

/** host, port and database of a `jdbc:mysql://host:port/db?…` URL. */
export function parseJdbcUrl(
  url: string
): { host: string; port: number | null; database: string } | null {
  const m =
    /^jdbc:(?:mysql|mariadb)(?::[a-z]+)?:\/\/([^/:?#]*|\[[^\]]+\])(?::(\d+))?(?:\/([^?#;]*))?/i.exec(
      url.trim()
    )
  if (!m) return null
  return {
    host: m[1].replace(/^\[|\]$/g, ''),
    port: m[2] ? Number(m[2]) : null,
    database: m[3] ? decodeURIComponent(m[3]) : ''
  }
}

/**
 * host list, database and sslmode of a `jdbc:postgresql://h[:p][,h2[:p]]/db?sslmode=…` URL.
 * `hosts` keeps the raw list (firstHost picks the first one).
 */
export function parsePostgresJdbcUrl(
  url: string
): { hosts: string; database: string; sslMode: string } | null {
  const m = /^jdbc:postgresql:\/\/([^/?#]*)(?:\/([^?#;]*))?(?:\?([^#]*))?/i.exec(url.trim())
  if (!m) return null
  const params = new URLSearchParams(m[3] ?? '')
  return {
    hosts: m[1],
    database: m[2] ? decodeURIComponent(m[2]) : '',
    sslMode: params.get('sslmode') ?? ''
  }
}

/**
 * Database file of a `jdbc:sqlite:<path>` URL (also `jdbc:sqlite:file:<path>?…`); null for
 * anything else, including in-memory databases.
 */
export function parseSqliteJdbcUrl(url: string): string | null {
  const m = /^jdbc:sqlite:(.*)$/i.exec(url.trim())
  if (!m) return null
  let path = m[1].trim()
  if (/^file:/i.test(path)) {
    path = path.replace(/^file:/i, '').replace(/[?#].*$/, '')
    // file:///C:/x and file:///home/x
    if (/^\/\/\//.test(path)) path = path.slice(2)
    if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1)
    try {
      path = decodeURIComponent(path)
    } catch {
      /* keep the raw text */
    }
  }
  if (!path || path === ':memory:') return null
  return path
}

const LABELS: Record<string, string> = {
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
  mongodb: 'MongoDB',
  sqlserver: 'SQL Server',
  mssql: 'SQL Server',
  oracle: 'Oracle',
  db2: 'Db2',
  clickhouse: 'ClickHouse',
  redis: 'Redis',
  snowflake: 'Snowflake',
  redshift: 'Amazon Redshift'
}

const isPostgres = (p: string, d: string): boolean =>
  p === 'postgresql' || (/postgre/.test(d) && !/redshift/.test(`${p} ${d}`))

function engineFor(provider: string, driver: string): { choice: EngineChoice; label: string } {
  const p = provider.toLowerCase()
  const d = driver.toLowerCase()
  const maria = p === 'mariadb' || d.includes('maria')
  if (p === 'mysql' || p === 'mariadb' || (p === 'generic' && /^(mysql|maria)/.test(d)))
    return { choice: mysqlFamily(maria), label: maria ? 'MariaDB' : 'MySQL' }
  if (isPostgres(p, d)) return { choice: postgresFamily(`${p} ${d}`), label: 'PostgreSQL' }
  if (p === 'sqlite' || d.includes('sqlite')) return { choice: SQLITE_CHOICE, label: 'SQLite' }
  if (p.includes('mongo') || d.includes('mongo')) return { choice: MONGO_CHOICE, label: 'MongoDB' }
  if (/sqlserver|mssql/.test(p) || /sqlserver|mssql|azure_sql/.test(d))
    return { choice: SQLSERVER_CHOICE, label: 'SQL Server' }
  const known = Object.keys(LABELS).find((k) => p.includes(k) || d.includes(k))
  const label = known ? LABELS[known] : driver || provider || 'Desconocido'
  return { choice: unsupported(label), label }
}

function environmentFor(type: string, name: string, host: string, ssh: boolean): Environment {
  const inferred = inferEnvironment(name, host, ssh)
  switch (type.toLowerCase()) {
    case 'prod':
      return 'production'
    case 'test':
      // A name that says production keeps the strictest environment.
      return inferred === 'production' ? 'production' : 'staging'
    case 'dev':
      if (inferred === 'production') return 'production'
      return isLoopback(host) && !ssh ? 'local' : 'other'
    default:
      return inferred
  }
}

function parseSsh(handlers: Json, warnings: string[]): SshConfig {
  const tunnel = Object.entries(handlers).find(
    ([id, h]) => isObj(h) && (id === 'ssh_tunnel' || str(h.type).toUpperCase() === 'TUNNEL')
  )?.[1]
  if (!isObj(tunnel) || !bool(tunnel.enabled)) return { ...NO_SSH }
  const p = isObj(tunnel.properties) ? tunnel.properties : {}
  const auth = str(p.authType).toUpperCase()
  const ssh: SshConfig = {
    enabled: true,
    host: str(p.host),
    port: positiveInt(p.port, 22),
    username: str(p.user ?? p.userName),
    authType: auth === 'PUBLIC_KEY' ? 'key' : 'password',
    savePassword: false
  }
  const keyPath = str(p.keyPath)
  if (ssh.authType === 'key' && keyPath) ssh.privateKeyPath = keyPath
  if (auth === 'AGENT')
    warnings.push('Autenticación SSH por agente: elige una clave al editar la conexión')
  return ssh
}

/** DBeaver's SSL handler (id varies by driver); tolerant of its property names. */
function parseSsl(handlers: Json, postgres: boolean, warnings: string[]): SslConfig {
  const handler = Object.entries(handlers).find(
    ([id, h]) => isObj(h) && /ssl/i.test(id) && bool(h.enabled)
  )?.[1]
  if (!isObj(handler)) return { enabled: false, verifyServer: false }
  const p = isObj(handler.properties) ? handler.properties : {}
  const find = (re: RegExp): string => {
    const entry = Object.entries(p).find(([k]) => re.test(k))
    return entry ? str(entry[1]) : ''
  }
  let ssl: SslConfig = {
    enabled: true,
    verifyServer: ['true', '1'].includes(find(/verify/i).toLowerCase())
  }
  // PostgreSQL drivers name them sslRootCert/sslCert/sslKey (or ssl.ca.cert…).
  const ca = find(/ca[._-]?cert|root[._-]?cert/i)
  const cert = find(/client[._-]?cert|^ssl[._-]?cert$/i)
  const key = find(/client[._-]?key|^ssl[._-]?key$/i)
  if (ca) ssl.caCertPath = ca
  if (cert) ssl.clientCertPath = cert
  if (key) ssl.clientKeyPath = key
  if (postgres) ssl = applySslMode(ssl, find(/ssl[._-]?mode/i), warnings)
  return ssl
}

/** Colour of a connection type (`"r,g,b"`); DBeaver's white default means none. */
function typeColors(root: Json): Map<string, string> {
  const map = new Map<string, string>()
  const types = isObj(root['connection-types']) ? root['connection-types'] : {}
  for (const [id, t] of Object.entries(types)) {
    if (!isObj(t)) continue
    const color = normalizeColor(t.color)
    if (color && color !== '#ffffff') map.set(id, color)
  }
  return map
}

export function parseDbeaverDataSources(
  text: string,
  platform: NodeJS.Platform = process.platform,
  fileExists: FileExists = existsSync
): ParsedConnectionFile {
  let root: unknown
  try {
    root = JSON.parse(stripBom(text))
  } catch {
    throw new Error(DBEAVER_INVALID_MESSAGE)
  }
  if (!isObj(root) || !isObj(root.connections)) throw new Error(DBEAVER_INVALID_MESSAGE)
  const colors = typeColors(root)
  const used = new Set<string>()
  const connections: ParsedConnection[] = []

  for (const [id, raw] of Object.entries(root.connections)) {
    if (!isObj(raw)) continue
    const cfg = isObj(raw.configuration) ? raw.configuration : {}
    const handlers = isObj(cfg.handlers) ? cfg.handlers : {}
    const name = str(raw.name) || id
    const { choice, label } = engineFor(str(raw.provider), str(raw.driver))
    const warnings: string[] = []
    if (choice.warning) warnings.push(choice.warning)

    if (label === 'SQLite') {
      const filePath = str(cfg.database) || parseSqliteJdbcUrl(str(cfg.url)) || ''
      connections.push({
        key: uniqueKey(id, used),
        name,
        engine: choice.engine,
        engineLabel: label,
        unsupportedReason: choice.unsupportedReason,
        host: '',
        port: 0,
        username: '',
        database: filePath || null,
        color: normalizeColor(cfg.color) ?? colors.get(str(cfg.type)) ?? null,
        environment: environmentFor(str(cfg.type), name, '', false),
        ssh: { ...NO_SSH },
        ssl: { ...NO_SSL },
        secrets: {},
        warnings,
        sqlite: sqliteBlock(name, filePath, platform, fileExists, warnings)
      })
      continue
    }

    if (label === 'MongoDB') {
      connections.push(dbeaverMongo(id, name, cfg, handlers, colors, platform, warnings, used))
      continue
    }

    const postgres = label === 'PostgreSQL'
    const sqlserver = label === 'SQL Server'
    let msOptions: ParsedConnection['sqlserver']
    let host: string
    let port: number
    let database: string
    let urlSslMode = ''
    if (postgres) {
      const fromUrl = parsePostgresJdbcUrl(str(cfg.url))
      const first = firstHost(str(cfg.host) || fromUrl?.hosts || '', warnings)
      host = first.host
      port = positiveInt(cfg.port, first.port ?? 5432)
      database = str(cfg.database) || fromUrl?.database || ''
      urlSslMode = fromUrl?.sslMode ?? ''
    } else if (sqlserver) {
      // jdbc:sqlserver://host[\\instance][:port];databaseName=…;encrypt=…
      const fromUrl = parseSqlServerConnectionString(str(cfg.url))
      const server = sqlServerHost(
        str(cfg.host) || fromUrl?.host || '',
        positiveInt(cfg.port, fromUrl?.port ?? 1433),
        warnings
      )
      host = server.host
      port = server.port
      database = str(cfg.database) || fromUrl?.sqlserver.initialDatabase || ''
      msOptions = {
        ...fromUrl?.sqlserver,
        ...(server.instanceName ? { instanceName: server.instanceName } : {})
      }
      delete msOptions.initialDatabase
      if (fromUrl) warnings.push(...fromUrl.warnings)
    } else {
      const fromUrl = parseJdbcUrl(str(cfg.url))
      host = str(cfg.host) || fromUrl?.host || ''
      port = positiveInt(cfg.port, fromUrl?.port ?? 3306)
      database = str(cfg.database) || fromUrl?.database || ''
    }
    const username = str(cfg.user)
    const ssh = parseSsh(handlers, warnings)
    let ssl = parseSsl(handlers, postgres, warnings)
    if (postgres && urlSslMode && !ssl.mode) ssl = applySslMode(ssl, urlSslMode, warnings)
    if (choice.engine && !username) warnings.push(DBEAVER_USER_WARNING)
    checkForeignPaths(
      [ssh.privateKeyPath, ssl.caCertPath, ssl.clientCertPath, ssl.clientKeyPath],
      platform,
      warnings
    )
    const type = str(cfg.type)
    connections.push({
      key: uniqueKey(id, used),
      name,
      engine: choice.engine,
      engineLabel: label,
      unsupportedReason: choice.unsupportedReason,
      host,
      port,
      username,
      database: database || null,
      color: normalizeColor(cfg.color) ?? colors.get(type) ?? null,
      environment: environmentFor(type, name, host, ssh.enabled),
      ssh,
      ssl,
      secrets: {},
      warnings,
      ...(msOptions ? { sqlserver: msOptions } : {})
    })
  }
  return { connections, notes: [DBEAVER_PASSWORDS_NOTE] }
}

/**
 * MongoDB (DBeaver editions that have it): host, port and database, or a
 * mongodb:// / mongodb+srv:// URL whose options are read and whose password,
 * if any, is not imported. Credentials stay in DBeaver's own store (never read).
 */
function dbeaverMongo(
  id: string,
  name: string,
  cfg: Json,
  handlers: Json,
  colors: Map<string, string>,
  platform: NodeJS.Platform,
  warnings: string[],
  used: Set<string>
): ParsedConnection {
  const url = str(cfg.url)
  let host = str(cfg.host)
  let port = positiveInt(cfg.port, 27017)
  let database = str(cfg.database)
  let username = str(cfg.user)
  let mongo: ParsedConnection['mongo'] = { defaultDatabase: database }
  let ssl: SslConfig = parseSsl(handlers, false, warnings)
  if (/^mongodb(\+srv)?:\/\//i.test(url)) {
    try {
      const parsed = parseMongoUri(url)
      host = host || parsed.host
      port = parsed.port || port
      username = username || parsed.username
      database = database || parsed.mongo.defaultDatabase
      mongo = { ...parsed.mongo, defaultDatabase: database }
      if (parsed.ssl.enabled) ssl = { ...ssl, enabled: true, verifyServer: parsed.ssl.verifyServer }
      if (parsed.password !== null) warnings.push(MONGO_URL_PASSWORD_WARNING)
    } catch (err) {
      warnings.push(`URL de MongoDB no válida: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!mongo.authMechanism) mongo.authMechanism = username ? 'default' : 'none'
  const ssh = parseSsh(handlers, warnings)
  if (ssh.enabled) mongo.directConnection = true
  checkForeignPaths(
    [ssh.privateKeyPath, ssl.caCertPath, ssl.clientCertPath, ssl.clientKeyPath],
    platform,
    warnings
  )
  const type = str(cfg.type)
  return {
    key: uniqueKey(id, used),
    name,
    engine: 'mongodb',
    engineLabel: 'MongoDB',
    unsupportedReason: null,
    host,
    port,
    username,
    database: database || null,
    color: normalizeColor(cfg.color) ?? colors.get(type) ?? null,
    environment: environmentFor(type, name, host, ssh.enabled),
    ssh,
    ssl,
    secrets: {},
    warnings,
    mongo
  }
}
