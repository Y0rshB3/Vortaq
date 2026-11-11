/**
 * SQL Server's TLS certificate problems, shared by main (the error text) and
 * the UIs (the «Confiar en el certificado y reintentar» button of the
 * connection form, the desktop tree and the editor extension): the UI offers
 * the button only for errors that the trust option fixes.
 */
import { isEntraAuth } from '../sqlserverAuth'
import type { SqlServerOptions } from '../types'

export const UNTRUSTED_CERTIFICATE =
  'El servidor usa un certificado TLS que no es de confianza (por ejemplo, autofirmado). Si confías en este servidor, activa «Confiar en el certificado del servidor» en la pestaña SSL de la conexión; si no, instala su certificado de CA'

export const CERTIFICATE_NAME_MISMATCH =
  'El nombre del servidor no coincide con su certificado TLS. Escribe el nombre que figura en el certificado en «Nombre en el certificado» (pestaña SSL)'

/**
 * Turning on «Confiar en el certificado del servidor» would let this connection
 * in: the error is an untrusted or mismatched certificate and the option is
 * off and allowed (strict encryption always verifies; Microsoft Entra sign-ins
 * never skip the check, sqlserverAuth.ts entraTransportProblem).
 */
export function trustFixesError(
  message: string | null | undefined,
  options:
    Partial<Pick<SqlServerOptions, 'auth' | 'encrypt' | 'trustServerCertificate'>> | undefined
): boolean {
  if (!message) return false
  if (options?.trustServerCertificate === true || options?.encrypt === 'strict') return false
  if (isEntraAuth(options?.auth)) return false
  return message.includes(UNTRUSTED_CERTIFICATE) || message.includes(CERTIFICATE_NAME_MISMATCH)
}
