import { describe, expect, it } from 'vitest'
import { trustFixesError, UNTRUSTED_CERTIFICATE } from '@shared/sqlserver/certificate'
import { CONNECTION_REFUSED, describeError } from './errors'

/** What tedious 20 throws: an Error with a code, sometimes a cause. */
function tediousError(message: string, code: string, cause?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) })
}

describe('SQL Server connection errors', () => {
  it('a refused connect wrapped in «Could not connect (sequence)» explains TCP/IP', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1433'), {
      code: 'ECONNREFUSED'
    })
    const err = tediousError(
      'Failed to connect to 127.0.0.1:1433 - Could not connect (sequence)',
      'ESOCKET',
      new AggregateError([refused], 'Could not connect (sequence)')
    )
    const text = describeError(err)
    expect(text.startsWith(CONNECTION_REFUSED)).toBe(true)
    expect(text).toMatch(/TCP\/IP.*\(ECONNREFUSED\)$/)
  })

  it('a self-signed certificate gets the text «Confiar en el certificado» recognises', () => {
    const err = tediousError(
      'Failed to connect to db:1433 - self-signed certificate',
      'ESOCKET',
      Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    )
    const text = describeError(err)
    expect(text).toContain(UNTRUSTED_CERTIFICATE)
    expect(trustFixesError(text, { encrypt: 'mandatory', trustServerCertificate: false })).toBe(
      true
    )
    expect(trustFixesError(text, { encrypt: 'strict', trustServerCertificate: false })).toBe(false)
    expect(trustFixesError(text, { encrypt: 'mandatory', trustServerCertificate: true })).toBe(
      false
    )
  })
})
