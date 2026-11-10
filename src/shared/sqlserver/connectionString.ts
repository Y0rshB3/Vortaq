/**
 * «Pegar cadena de conexión» for SQL Server (docs/sqlserver-design.md,
 * «Importar»): the forms people copy from Azure, appsettings.json, ODBC data
 * sources and Java configs, turned into the connection form's fields.
 *
 * - ADO.NET / ODBC: `Server=tcp:host,1433;Database=db;User ID=u;Password=p;Encrypt=True;…`
 *   (keys case-insensitive, values quoted with "…", '…' or {…});
 * - JDBC: `jdbc:sqlserver://host[\instance][:port];databaseName=db;user=u;…`;
 * - URL: `sqlserver://user:pass@host:port/db?encrypt=true` (also `mssql://`).
 *
 * Pure: no Node or browser APIs. The password, when present, is returned
 * apart so the dialog puts it in the password field (stored only if the user
 * keeps «Guardar contraseña»). «Copiar cadena de conexión» never includes it.
 */
import type { SqlServerAuth, SqlServerEncrypt, SqlServerOptions } from '../types'

export interface ParsedSqlServerConnection {
  host: string
  port: number | null
  username: string
  password: string | null
  /** Only the options the string names. */
  sqlserver: Partial<SqlServerOptions>
  connectTimeoutMs: number | null
  /** Spanish notes about parts Vortaq cannot use (named pipes, managed identity…). */
  warnings: string[]
}

/** Splits `key=value;…` honouring "…", '…' and {…} quoting (`;;` inside braces stays). */
export function parseKeyValues(text: string): Map<string, string> {
  const out = new Map<string, string>()
  let i = 0
  const n = text.length
  while (i < n) {
    while (i < n && (text[i] === ';' || /\s/.test(text[i]))) i++
    const eq = text.indexOf('=', i)
    if (eq < 0) break
    const key = text.slice(i, eq).trim().toLowerCase().replace(/\s+/g, ' ')
    i = eq + 1
    while (i < n && text[i] === ' ') i++
    let value = ''
    const open = text[i]
    if (open === '"' || open === "'" || open === '{') {
      const close = open === '{' ? '}' : open
      i++
      for (; i < n; i++) {
        if (text[i] === close) {
          if (text[i + 1] === close) {
            value += close
            i++
            continue
          }
          i++
          break
        }
        value += text[i]
      }
      while (i < n && text[i] !== ';') i++
    } else {
      const end = text.indexOf(';', i)
      value = text.slice(i, end < 0 ? n : end).trim()
      i = end < 0 ? n : end
    }
    if (key) out.set(key, value)
  }
  return out
}

const pick = (map: Map<string, string>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = map.get(k)
    if (v !== undefined) return v
  }
  return undefined
}

const truthy = (v: string | undefined): boolean | null => {
  if (v === undefined) return null
  const s = v.trim().toLowerCase()
  if (['true', 'yes', '1', 'sspi', 'mandatory', 'strict'].includes(s)) return true
  if (['false', 'no', '0', 'optional'].includes(s)) return false
  return null
}

function encryptOf(v: string | undefined): SqlServerEncrypt | null {
  if (v === undefined) return null
  const s = v.trim().toLowerCase()
  if (s === 'strict') return 'strict'
  if (['true', 'yes', 'mandatory', '1'].includes(s)) return 'mandatory'
  if (['false', 'no', 'optional', '0'].includes(s)) return 'optional'
  return null
}

/** `Authentication=` / `authentication=` of ADO.NET, ODBC and JDBC. */
function authOf(v: string | undefined, warnings: string[]): SqlServerAuth | null {
  if (v === undefined) return null
  const s = v.replace(/[\s_-]/g, '').toLowerCase()
  switch (s) {
    case 'sqlpassword':
    case 'sqlauthentication':
      return 'sql'
    case 'activedirectoryinteractive':
    case 'activedirectoryuniversalwithmfa':
      return 'entra-interactive'
    case 'activedirectoryserviceprincipal':
      return 'entra-service-principal'
    case 'activedirectorydefault':
      warnings.push(
        'La cadena usa «Active Directory Default»: Vortaq usa la sesión de la CLI de Azure (az login).'
      )
      return 'entra-azure-cli'
    case 'activedirectorypassword':
      warnings.push(
        'La cadena usa «Active Directory Password», que Microsoft retiró y no funciona con MFA: se eligió el inicio de sesión en el navegador.'
      )
      return 'entra-interactive'
    case 'activedirectoryintegrated':
      warnings.push(
        '«Active Directory Integrated» necesita el inicio de sesión de Windows del equipo; elige el navegador o la CLI de Azure.'
      )
      return 'entra-interactive'
    case 'activedirectorymsi':
    case 'activedirectorymanagedidentity':
      warnings.push(
        'La identidad administrada solo existe dentro de Azure: elige otro método en Vortaq.'
      )
      return null
    default:
      warnings.push(`Método de autenticación desconocido en la cadena: «${v}».`)
      return null
  }
}

/** `tcp:host,1433`, `host\instance`, `(local)`, `.`… → host, port, instance. */
export function serverOf(
  raw: string,
  warnings: string[]
): { host: string; port: number | null; instance: string } {
  let v = raw.trim()
  if (/^np:/i.test(v) || /^lpc:/i.test(v)) {
    warnings.push(
      'Vortaq se conecta por TCP: canalizaciones con nombre y memoria compartida no están disponibles.'
    )
    v = v.replace(/^(np|lpc):/i, '')
  }
  v = v.replace(/^tcp:/i, '')
  if (/^\(localdb\)/i.test(v))
    warnings.push(
      'LocalDB solo acepta conexiones locales sin TCP: actívale un puerto TCP para usarlo desde Vortaq.'
    )
  let port: number | null = null
  const comma = v.lastIndexOf(',')
  if (comma > 0) {
    const p = Number(v.slice(comma + 1).trim())
    if (Number.isInteger(p) && p > 0 && p < 65536) port = p
    v = v.slice(0, comma).trim()
  }
  let instance = ''
  const slash = v.indexOf('\\')
  if (slash > 0) {
    instance = v.slice(slash + 1).trim()
    v = v.slice(0, slash).trim()
  }
  if (v === '.' || /^\(local\)$/i.test(v)) v = 'localhost'
  return { host: v, port, instance }
}

function timeoutMs(v: string | undefined): number | null {
  if (v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null
}

function fromKeyValues(map: Map<string, string>, warnings: string[]): ParsedSqlServerConnection {
  const server = pick(map, 'server', 'data source', 'address', 'addr', 'network address') ?? ''
  const { host, port, instance } = serverOf(server, warnings)
  const options: Partial<SqlServerOptions> = {}
  const database = pick(map, 'database', 'initial catalog', 'databasename', 'database name')
  if (database !== undefined) options.initialDatabase = database
  if (instance) options.instanceName = instance
  const encrypt = encryptOf(pick(map, 'encrypt'))
  if (encrypt) options.encrypt = encrypt
  const trust = truthy(pick(map, 'trustservercertificate', 'trust server certificate'))
  if (trust !== null) options.trustServerCertificate = trust
  const certName = pick(map, 'hostnameincertificate', 'host name in certificate')
  if (certName) options.hostNameInCertificate = certName
  const intent = pick(map, 'applicationintent', 'application intent')
  if (intent !== undefined) options.readOnlyIntent = /^readonly$/i.test(intent.trim())
  let username = pick(map, 'user id', 'userid', 'uid', 'user', 'username') ?? ''
  const password = pick(map, 'password', 'pwd') ?? null
  let auth = authOf(pick(map, 'authentication'), warnings)
  const integrated = truthy(
    pick(map, 'integrated security', 'trusted_connection', 'integratedsecurity')
  )
  if (!auth && integrated) {
    auth = 'windows'
    warnings.push(
      'La cadena usa la autenticación integrada de Windows: Vortaq necesita el dominio, el usuario y la contraseña de la cuenta (NTLM).'
    )
  }
  if (auth === 'windows' && username.includes('\\')) {
    const [domain, user] = [
      username.slice(0, username.indexOf('\\')),
      username.slice(username.indexOf('\\') + 1)
    ]
    options.domain = domain
    username = user
  }
  if (auth === 'entra-service-principal') {
    options.clientId = username
    username = ''
  }
  if (auth) options.auth = auth
  return {
    host,
    port,
    username,
    password,
    sqlserver: options,
    connectTimeoutMs: timeoutMs(
      pick(map, 'connection timeout', 'connect timeout', 'timeout', 'logintimeout')
    ),
    warnings
  }
}

/** Parses any supported form; null when the text is none of them. */
export function parseSqlServerConnectionString(text: string): ParsedSqlServerConnection | null {
  const value = text.trim()
  if (!value) return null
  const warnings: string[] = []
  const jdbc = /^jdbc:sqlserver:\/\/([^;]*)(;.*)?$/i.exec(value)
  if (jdbc) {
    const map = parseKeyValues(jdbc[2] ?? '')
    let hostPart = jdbc[1]
    let port: number | null = null
    const colon = hostPart.lastIndexOf(':')
    if (colon > 0 && !hostPart.includes(']')) {
      const p = Number(hostPart.slice(colon + 1))
      if (Number.isInteger(p) && p > 0) port = p
      hostPart = hostPart.slice(0, colon)
    }
    if (!map.has('server')) map.set('server', hostPart)
    if (map.has('portnumber')) map.set('server', `${map.get('server')},${map.get('portnumber')}`)
    else if (port) map.set('server', `${map.get('server')},${port}`)
    if (map.has('instancename') && !hostPart.includes('\\'))
      map.set('server', `${hostPart}\\${map.get('instancename')}${port ? `,${port}` : ''}`)
    return fromKeyValues(map, warnings)
  }
  const url = /^(sqlserver|mssql):\/\//i.exec(value)
  if (url) {
    let parsed: URL
    try {
      parsed = new URL(value.replace(/^(sqlserver|mssql):/i, 'http:'))
    } catch {
      return null
    }
    const map = new Map<string, string>()
    for (const [k, v] of parsed.searchParams) map.set(k.toLowerCase(), v)
    map.set('server', parsed.port ? `${parsed.hostname},${parsed.port}` : parsed.hostname)
    const db = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    if (db) map.set('database', db)
    if (parsed.username) map.set('user id', decodeURIComponent(parsed.username))
    if (parsed.password) map.set('password', decodeURIComponent(parsed.password))
    return fromKeyValues(map, warnings)
  }
  if (!/[=;]/.test(value)) return null
  const map = parseKeyValues(value)
  if (!pick(map, 'server', 'data source', 'address', 'addr', 'network address')) return null
  if (map.has('provider') && !/sqloledb|msoledbsql|sqlncli/i.test(map.get('provider') ?? ''))
    warnings.push(`Proveedor «${map.get('provider')}» ignorado.`)
  return fromKeyValues(map, warnings)
}

/** ADO.NET string of a connection, for «Copiar cadena de conexión» (never the password). */
export function sqlServerConnectionString(c: {
  host: string
  port: number
  username: string
  sqlserver?: Partial<SqlServerOptions>
}): string {
  const o = c.sqlserver ?? {}
  const parts: string[] = []
  const quote = (v: string): string =>
    /[;'"={}]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  parts.push(
    `Server=${quote(o.instanceName ? `${c.host}\\${o.instanceName}` : `tcp:${c.host},${c.port}`)}`
  )
  if (o.initialDatabase) parts.push(`Database=${quote(o.initialDatabase)}`)
  const auth = o.auth ?? 'sql'
  if (auth === 'sql') parts.push(`User ID=${quote(c.username)}`)
  else if (auth === 'windows')
    parts.push(
      `User ID=${quote(o.domain ? `${o.domain}\\${c.username}` : c.username)}`,
      'Integrated Security=False'
    )
  else if (auth === 'entra-interactive') {
    parts.push('Authentication="Active Directory Interactive"')
    if (c.username) parts.push(`User ID=${quote(c.username)}`)
  } else if (auth === 'entra-azure-cli') parts.push('Authentication="Active Directory Default"')
  else if (auth === 'entra-service-principal')
    parts.push(
      'Authentication="Active Directory Service Principal"',
      `User ID=${quote(o.clientId ?? '')}`
    )
  parts.push(
    `Encrypt=${o.encrypt === 'strict' ? 'Strict' : o.encrypt === 'optional' ? 'Optional' : 'True'}`
  )
  parts.push(`TrustServerCertificate=${o.trustServerCertificate ? 'True' : 'False'}`)
  if (o.hostNameInCertificate) parts.push(`HostNameInCertificate=${quote(o.hostNameInCertificate)}`)
  if (o.readOnlyIntent) parts.push('ApplicationIntent=ReadOnly')
  return parts.join(';') + ';'
}
