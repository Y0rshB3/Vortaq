/**
 * tedious connection settings for a SQL Server connection
 * (docs/sqlserver-design.md, «Conexión»). Every option Vortaq relies on is set
 * explicitly; nothing is read from the environment.
 *
 * - Through an SSH tunnel tedious keeps the real host as `server` (LOGIN7,
 *   SNI and the certificate check use it; Azure's gateway refuses a login
 *   sent to an IP) and a `connector` opens the socket to the tunnel's local
 *   port instead. «Nombre en el certificado» overrides the checked name.
 * - Certificates are checked against Node's roots plus the operating system's
 *   (company CAs) and the CA file of the SSL tab, when there is one.
 * - A named instance is resolved by SQL Server Browser (UDP 1434), which an
 *   SSH tunnel cannot carry: there the port is required.
 * - requestTimeout is 0: user statements run until they end or are
 *   cancelled; internal reads set their own limit (session.ts).
 * - Session options are SSMS's defaults (ANSI_NULLS, QUOTED_IDENTIFIER,
 *   ARITHABORT… ON), so filtered indexes and indexed views work as they do there.
 */
import { readFileSync } from 'node:fs'
import { connect as netConnect, type Socket } from 'node:net'
import { getCACertificates, rootCertificates } from 'node:tls'
import type { TokenCredential } from '@azure/core-auth'
import { Connection, type ConnectionConfiguration } from 'tedious'
import { DEFAULT_NETWORK, defaultSqlServerOptions } from '@shared/engines'
import { entraTransportProblem } from '@shared/sqlserverAuth'
import type { ConnectionInput, NetworkOptions, SqlServerOptions } from '@shared/types'
import type { DriverSecrets, Endpoint } from '../db/driver'
import { APP_NAME } from '../brand'
import { entraCredential, warmUpEntra } from './entra'
import { MsUserError } from './errors'
import { installExactValues } from './values'

export function sqlserverOf(config: Pick<ConnectionInput, 'sqlserver'>): SqlServerOptions {
  return { ...defaultSqlServerOptions(), ...config.sqlserver }
}

export function networkOf(config: Pick<ConnectionInput, 'network'>): NetworkOptions {
  return { ...DEFAULT_NETWORK, ...config.network }
}

export interface ClientTarget {
  endpoint: Endpoint
  /** Database the session opens in; null = the login's default database. */
  database: string | null
}

type Authentication = NonNullable<ConnectionConfiguration['authentication']>

/** The tedious `authentication` block of the connection's sign-in method. */
export function authenticationOf(
  config: Pick<ConnectionInput, 'username' | 'sqlserver' | 'name' | 'id'>,
  secrets: Pick<DriverSecrets, 'password'>
): Authentication {
  const options = sqlserverOf(config)
  const password = secrets.password ?? ''
  switch (options.auth) {
    case 'sql':
      return { type: 'default', options: { userName: config.username, password } }
    case 'windows': {
      // «DOMINIO\usuario» typed in the user field also works.
      let userName = config.username
      let domain = options.domain.trim()
      const slash = userName.indexOf('\\')
      if (!domain && slash > 0) {
        domain = userName.slice(0, slash)
        userName = userName.slice(slash + 1)
      }
      if (!domain)
        throw new MsUserError(
          'La autenticación de Windows necesita el dominio: escríbelo en «Dominio» o como DOMINIO\\usuario.',
          'E_MS_NO_DOMAIN'
        )
      return { type: 'ntlm', options: { userName, password, domain } }
    }
    case 'entra-interactive':
    case 'entra-azure-cli':
    case 'entra-service-principal': {
      // Also for connections saved before 2.9.3: the token only travels over verified TLS.
      const transport = entraTransportProblem(options)
      if (transport) throw new MsUserError(transport, 'E_MS_ENTRA_TLS')
      return {
        type: 'token-credential',
        options: { credential: entraCredential(config, options, password) }
      }
    }
    default:
      throw new MsUserError('Método de autenticación de SQL Server desconocido', 'E_MS_AUTH')
  }
}

/** tedious `encrypt`: 'strict' (TDS 8.0), true (mandatory) or false (only if the server requires it). */
function encryptOption(options: SqlServerOptions): boolean | 'strict' {
  return options.encrypt === 'strict' ? 'strict' : options.encrypt === 'mandatory'
}

/** Certificate authorities: Node's, the operating system's and the SSL tab's CA file. */
export function certificateAuthorities(caCertPath: string | undefined): string[] {
  const out = [...rootCertificates]
  try {
    out.push(...getCACertificates('system'))
  } catch {
    /* not available on this Node */
  }
  if (caCertPath?.trim()) {
    try {
      out.push(readFileSync(caCertPath.trim(), 'utf8'))
    } catch {
      throw new MsUserError(
        `No se pudo leer el certificado de CA «${caCertPath}» de la pestaña SSL.`,
        'E_MS_CA'
      )
    }
  }
  return out
}

/** A socket to the SSH tunnel's local port, resolved once connected (tedious's connector contract). */
function tunnelConnector(host: string, port: number): () => Promise<Socket> {
  return () =>
    new Promise<Socket>((resolve, reject) => {
      const socket = netConnect({ host, port })
      const onError = (err: Error): void => {
        socket.destroy()
        reject(err)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.removeListener('error', onError)
        resolve(socket)
      })
    })
}

/** Full tedious configuration of one session. */
export function buildConfiguration(
  config: ConnectionInput,
  secrets: Pick<DriverSecrets, 'password'>,
  target: ClientTarget
): ConnectionConfiguration {
  const options = sqlserverOf(config)
  const network = networkOf(config)
  const instance = options.instanceName.trim()
  // The manager names the real host when the endpoint is an SSH tunnel's local port.
  const tunnel = target.endpoint.tlsServername ? target.endpoint : null
  if (instance && (tunnel || config.ssh?.enabled))
    throw new MsUserError(
      'Con túnel SSH no se puede buscar una instancia por nombre (SQL Server Browser usa UDP): deja vacío «Instancia» y escribe el puerto de la instancia.',
      'E_MS_INSTANCE_SSH'
    )
  const server = tunnel?.tlsServername ?? target.endpoint.host
  const certificateName = options.hostNameInCertificate.trim()
  return {
    server,
    authentication: authenticationOf(config, secrets),
    options: {
      ...(instance
        ? { instanceName: instance }
        : { port: tunnel ? config.port : target.endpoint.port }),
      ...(tunnel ? { connector: tunnelConnector(tunnel.host, tunnel.port) } : {}),
      ...(target.database ? { database: target.database } : {}),
      encrypt: encryptOption(options),
      trustServerCertificate: options.trustServerCertificate,
      ...(certificateName ? { serverName: certificateName } : {}),
      cryptoCredentialsDetails: { ca: certificateAuthorities(config.ssl?.caCertPath) },
      readOnlyIntent: options.readOnlyIntent,
      appName: APP_NAME,
      connectTimeout: network.connectTimeoutMs,
      requestTimeout: 0,
      cancelTimeout: 5_000,
      // One attempt: the dialog reports the real error instead of retrying behind the user.
      maxRetriesOnTransientErrors: 0,
      useColumnNames: false,
      rowCollectionOnDone: false,
      rowCollectionOnRequestCompletion: false,
      useUTC: true,
      abortTransactionOnError: false,
      enableAnsiNull: true,
      enableAnsiNullDefault: true,
      enableAnsiPadding: true,
      enableAnsiWarnings: true,
      enableArithAbort: true,
      enableConcatNullYieldsNull: true,
      enableQuotedIdentifier: true,
      enableImplicitTransactions: false,
      enableCursorCloseOnCommit: null,
      enableNumericRoundabort: false,
      textsize: 2147483647
    }
  }
}

/**
 * Opens one tedious connection. The returned connection already has a no-op
 * 'error' listener (an idle socket error must not crash main); callers add
 * their own. On failure nothing stays open.
 */
export async function connectClient(configuration: ConnectionConfiguration): Promise<Connection> {
  installExactValues()
  // A browser sign-in can take minutes: get the token before tedious's connect timeout starts.
  const auth = configuration.authentication
  if (auth?.type === 'token-credential')
    await warmUpEntra((auth.options as { credential: TokenCredential }).credential)
  return new Promise<Connection>((resolve, reject) => {
    let connection: Connection
    try {
      connection = new Connection(configuration)
    } catch (err) {
      reject(err)
      return
    }
    connection.on('error', () => undefined)
    connection.connect((err) => {
      if (err) {
        connection.close()
        reject(err)
        return
      }
      resolve(connection)
    })
  })
}
