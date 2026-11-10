/**
 * SQL Server error taxonomy (docs/sqlserver-design.md, «Errores»), on the
 * shapes of tedious's ConnectionError/RequestError.
 *
 * - MsUserError: written by Vortaq, safe to show and to log (DbUserError).
 * - Server errors carry text that may echo values (2627 quotes the duplicate
 *   key). They are shown to the user through describeError, and logged only as
 *   `name + code + number` (describeForLog).
 */
import { explainSqlServerError } from '@shared/dialects/sqlserver'
import { DbUserError, describeNetworkError, withServerMessage } from '../db/errors'

export class MsUserError extends DbUserError {
  constructor(message: string, code = 'E_MS_USER') {
    super(message, code)
    this.name = 'MsUserError'
  }
}

/** Fields of tedious's ConnectionError / RequestError (and of socket errors) that we read. */
export interface MsErrorLike {
  name?: string
  message: string
  /** tedious: ELOGIN, ETIMEOUT, ESOCKET, ECANCEL, EREQUEST, EINSTLOOKUP…; Node: ECONNREFUSED… */
  code?: string
  /** SQL Server error number (RequestError and ERROR tokens). */
  number?: number
  state?: number
  class?: number
  /** Line of the batch where the error happened (1-based). */
  lineNumber?: number
  procName?: string
  cause?: unknown
  errors?: unknown[]
}

export function isMsErrorLike(err: unknown): err is MsErrorLike {
  return typeof err === 'object' && err !== null && 'message' in err
}

/** The SQL Server error number of a server error, or null. */
export function errorNumber(err: unknown): number | null {
  if (!isMsErrorLike(err)) return null
  if (typeof err.number === 'number') return err.number
  // A batch with several errors arrives as an AggregateError: the first server error counts.
  if (Array.isArray(err.errors))
    for (const e of err.errors) {
      const n = errorNumber(e)
      if (n !== null) return n
    }
  return null
}

/** Node socket code of the error or of its cause (ECONNREFUSED, ENOTFOUND…). */
function socketCode(err: MsErrorLike): string | null {
  const cause = err.cause as { code?: unknown } | undefined
  if (cause && typeof cause.code === 'string') return cause.code
  if (err.code && /^E[A-Z]+$/.test(err.code) && !TEDIOUS_CODES.has(err.code)) return err.code
  const m =
    /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)\b/.exec(
      err.message
    )
  return m ? m[1] : null
}

const TEDIOUS_CODES = new Set([
  'ELOGIN',
  'ETIMEOUT',
  'ESOCKET',
  'ECANCEL',
  'EREQUEST',
  'EINSTLOOKUP',
  'ECLOSE',
  'EINVALIDSTATE',
  'ENOTOPEN',
  'ECONNCLOSED',
  'ETLS'
])

/** The socket or the server session is gone (shutdown, KILL, network). */
export function isConnectionLost(err: unknown): boolean {
  if (!isMsErrorLike(err)) return false
  if (err.code === 'ESOCKET' || err.code === 'ECLOSE' || err.code === 'ECONNCLOSED') return true
  const code = socketCode(err)
  if (code === 'ECONNRESET' || code === 'EPIPE') return true
  // 596: session killed; 6005: SHUTDOWN in progress.
  const n = errorNumber(err)
  if (n === 596 || n === 6005) return true
  return /connection (was )?(lost|closed)|socket hang up|Requests can only be made in the LoggedIn state/i.test(
    err.message
  )
}

/** The server rejected the credentials (18456 «Login failed for user»); a database denial is not one. */
export function isAuthRejected(err: unknown): boolean {
  if (!isMsErrorLike(err)) return false
  if (errorNumber(err) === 18456) return true
  return err.code === 'ELOGIN' && /^Login failed for user/i.test(err.message)
}

function certificateProblem(message: string): string | null {
  if (
    /self[- ]signed certificate|unable to (get local issuer|verify)|certificate (chain|has expired)|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(
      message
    )
  )
    return 'El servidor usa un certificado TLS que no es de confianza (por ejemplo, autofirmado). Si confías en este servidor, activa «Confiar en el certificado del servidor» en la pestaña SSL de la conexión; si no, instala su certificado de CA'
  if (/does not match certificate's altnames|Hostname\/IP does not match/i.test(message))
    return 'El nombre del servidor no coincide con su certificado TLS. Escribe el nombre que figura en el certificado en «Nombre en el certificado» (pestaña SSL)'
  if (/strict|TDS 8|ALPN/i.test(message) && /encrypt|TLS|tds/i.test(message))
    return 'El servidor no admite el cifrado estricto (TDS 8.0, SQL Server 2022 o posterior): elige «Obligatorio» en Cifrado'
  return null
}

/**
 * A server reply becomes "<explicación>. Mensaje del servidor: <message> (número)";
 * a connection error an actionable Spanish text. Never contains SQL text.
 */
export function describeError(err: unknown): string {
  if (err instanceof DbUserError) return err.message
  if (!isMsErrorLike(err)) return String(err)
  const message = err.message || 'Error desconocido'
  if (err.code === 'ECANCEL') return 'Consulta cancelada por el usuario (ECANCEL)'
  const number = errorNumber(err)
  if (number !== null) {
    if (number === 18456)
      return `${withServerMessage('El servidor rechazó el usuario o la contraseña (o el método de autenticación elegido)', message)} (18456)`
    return `${withServerMessage(explainSqlServerError(String(number)), message)} (${number})`
  }
  const certificate = certificateProblem(message)
  if (certificate) return `${certificate}. Detalle: ${message} (ETLS)`
  if (err.code === 'EINSTLOOKUP')
    return `No se encontró la instancia con nombre: SQL Server Browser (UDP 1434) no respondió o la instancia no existe. Escribe el puerto de la instancia y deja vacío «Instancia». Detalle: ${message} (EINSTLOOKUP)`
  if (err.code === 'ELOGIN') {
    if (/Login failed for user/i.test(message))
      return `${withServerMessage('El servidor rechazó el usuario o la contraseña (o el método de autenticación elegido)', message)} (ELOGIN)`
    return `${withServerMessage('El servidor rechazó el inicio de sesión', message)} (ELOGIN)`
  }
  const socket = socketCode(err)
  const network = socket ? describeNetworkError(socket, message) : null
  if (network) return `${network} (${socket})`
  if (err.code === 'ETIMEOUT')
    return `El servidor no respondió a tiempo. Comprueba el servidor, el puerto y que el cortafuegos permita la conexión. Detalle: ${message} (ETIMEOUT)`
  return `${message}${err.code ? ` (${err.code})` : ''}`
}

/** Log-safe description: class name, tedious code and server number only. */
export function describeForLog(err: unknown): string {
  if (err instanceof DbUserError) return err.message
  if (!isMsErrorLike(err)) return typeof err
  const parts = [typeof err.name === 'string' && err.name ? err.name : 'Error']
  if (typeof err.code === 'string') parts.push(err.code)
  const number = errorNumber(err)
  if (number !== null) parts.push(`#${number}`)
  return parts.join(' ')
}

/** 1-based line of the batch where the server reported the error, or null. */
export function errorLine(err: unknown): number | null {
  if (!isMsErrorLike(err)) return null
  const n = err.lineNumber
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

export function missingPasswordError(name: string): MsUserError {
  return new MsUserError(
    `No hay contraseña guardada para la conexión ${name}: escríbela en la conexión`,
    'E_MS_NO_PASSWORD'
  )
}
