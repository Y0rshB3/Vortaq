import { describe, expect, it } from 'vitest'
import {
  ENTRA_NEEDS_ENCRYPTION,
  ENTRA_NEEDS_VERIFIED_CERTIFICATE,
  entraTransportProblem,
  sqlServerOptionErrors
} from './sqlserverAuth'
import { trustFixesError, UNTRUSTED_CERTIFICATE } from './sqlserver/certificate'

describe('Microsoft Entra only over verified TLS', () => {
  it('refuses optional encryption and a trusted (unverified) certificate', () => {
    for (const auth of [
      'entra-interactive',
      'entra-azure-cli',
      'entra-service-principal'
    ] as const) {
      expect(entraTransportProblem({ auth, encrypt: 'optional' })).toBe(ENTRA_NEEDS_ENCRYPTION)
      expect(
        entraTransportProblem({ auth, encrypt: 'mandatory', trustServerCertificate: true })
      ).toBe(ENTRA_NEEDS_VERIFIED_CERTIFICATE)
      expect(entraTransportProblem({ auth, encrypt: 'mandatory' })).toBeNull()
      expect(entraTransportProblem({ auth, encrypt: 'strict' })).toBeNull()
    }
    // SQL and Windows logins keep their options.
    expect(
      entraTransportProblem({ auth: 'sql', encrypt: 'optional', trustServerCertificate: true })
    ).toBeNull()
  })

  it('the form says so, and never offers «Confiar en el certificado» for Entra', () => {
    expect(
      sqlServerOptionErrors(
        { auth: 'entra-azure-cli', encrypt: 'mandatory', trustServerCertificate: true },
        { username: '' }
      )
    ).toContain(`SQL Server: ${ENTRA_NEEDS_VERIFIED_CERTIFICATE}`)
    expect(
      trustFixesError(UNTRUSTED_CERTIFICATE, { auth: 'entra-azure-cli', encrypt: 'mandatory' })
    ).toBe(false)
    expect(trustFixesError(UNTRUSTED_CERTIFICATE, { auth: 'sql', encrypt: 'mandatory' })).toBe(true)
  })
})
