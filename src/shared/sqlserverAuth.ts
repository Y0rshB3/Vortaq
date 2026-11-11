/**
 * SQL Server sign-in rules shared by main, the connection dialog and the
 * editor extension (docs/sqlserver-design.md, «Autenticación»).
 */
import type { SqlServerAuth, SqlServerOptions } from './types'

/**
 * Vortaq's multitenant public-client application in Microsoft Entra, used by
 * the browser sign-in when the connection has no «ID de aplicación» of its own.
 * Empty until it is registered: then the connection must name one.
 */
export const VORTAQ_ENTRA_CLIENT_ID = ''

export const SQLSERVER_AUTH_METHODS: readonly SqlServerAuth[] = [
  'sql',
  'windows',
  'entra-interactive',
  'entra-azure-cli',
  'entra-service-principal'
]

/** Spanish label of each method (dialog, extension form, info panel). */
export const SQLSERVER_AUTH_LABELS: Readonly<Record<SqlServerAuth, string>> = {
  sql: 'Usuario y contraseña de SQL Server',
  windows: 'Autenticación de Windows (dominio)',
  'entra-interactive': 'Microsoft Entra ID: iniciar sesión en el navegador (MFA)',
  'entra-azure-cli': 'Microsoft Entra ID: sesión de la CLI de Azure (az login)',
  'entra-service-principal': 'Microsoft Entra ID: aplicación (ID y secreto)'
}

export function isSqlServerAuth(value: unknown): value is SqlServerAuth {
  return typeof value === 'string' && (SQLSERVER_AUTH_METHODS as readonly string[]).includes(value)
}

/** The method sends a secret: the login's password, or the application's client secret. */
export function sqlServerUsesSecret(auth: SqlServerAuth | undefined): boolean {
  return (
    auth === undefined || auth === 'sql' || auth === 'windows' || auth === 'entra-service-principal'
  )
}

/** The user field is required (for the browser sign-in it is only a hint). */
export function sqlServerNeedsUser(auth: SqlServerAuth | undefined): boolean {
  return auth === undefined || auth === 'sql' || auth === 'windows'
}

/** A Microsoft Entra ID sign-in method (the server receives an access token). */
export function isEntraAuth(auth: SqlServerAuth | undefined): boolean {
  return (
    auth === 'entra-interactive' || auth === 'entra-azure-cli' || auth === 'entra-service-principal'
  )
}

export const ENTRA_NEEDS_ENCRYPTION =
  'Con Microsoft Entra ID el cifrado tiene que ser «Obligatorio» o «Estricto»: el token de acceso no puede viajar sin cifrar.'
export const ENTRA_NEEDS_VERIFIED_CERTIFICATE =
  'Con Microsoft Entra ID no se puede «Confiar en el certificado del servidor»: el certificado tiene que verificarse, o el token podría acabar en otro servidor. Instala la CA del servidor en el sistema o indícala en la pestaña SSL.'

/**
 * Why this connection must not send a Microsoft Entra token as configured
 * (null when it may): only over TLS whose certificate is verified.
 */
export function entraTransportProblem(
  options:
    Partial<Pick<SqlServerOptions, 'auth' | 'encrypt' | 'trustServerCertificate'>> | undefined
): string | null {
  if (!isEntraAuth(options?.auth)) return null
  if (options?.encrypt === 'optional') return ENTRA_NEEDS_ENCRYPTION
  if (options?.trustServerCertificate === true) return ENTRA_NEEDS_VERIFIED_CERTIFICATE
  return null
}

/** Problems of the SQL Server block, in Spanish (empty when it is fine). */
export function sqlServerOptionErrors(
  options: Partial<SqlServerOptions> | undefined,
  input: { username?: string; ssh?: { enabled?: boolean } }
): string[] {
  const errors: string[] = []
  const auth = options?.auth ?? 'sql'
  if (!isSqlServerAuth(auth)) return ['SQL Server: método de autenticación desconocido.']
  if (auth === 'windows' && !options?.domain?.trim() && !(input.username ?? '').includes('\\'))
    errors.push('SQL Server: la autenticación de Windows necesita el dominio (o DOMINIO\\usuario).')
  if (auth === 'entra-service-principal') {
    if (!options?.tenantId?.trim())
      errors.push('SQL Server: una aplicación de Microsoft Entra necesita el inquilino (tenant).')
    if (!options?.clientId?.trim())
      errors.push('SQL Server: escribe el ID de aplicación (cliente) de Microsoft Entra.')
  }
  if (auth === 'entra-interactive' && !VORTAQ_ENTRA_CLIENT_ID && !options?.clientId?.trim())
    errors.push(
      'SQL Server: el inicio de sesión en el navegador necesita el ID de aplicación de Microsoft Entra.'
    )
  const transport = entraTransportProblem({ ...options, auth })
  if (transport) errors.push(`SQL Server: ${transport}`)
  if (options?.instanceName?.trim() && input.ssh?.enabled)
    errors.push(
      'SQL Server: con túnel SSH escribe el puerto de la instancia y deja vacío «Instancia».'
    )
  if (options?.tenantId?.trim() && !/^[A-Za-z0-9.-]{1,128}$/.test(options.tenantId.trim()))
    errors.push(
      'SQL Server: el inquilino (tenant) solo puede tener letras, números, puntos y guiones.'
    )
  return errors
}
