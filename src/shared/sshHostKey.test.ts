import { describe, expect, it } from 'vitest'
import {
  isSshFingerprint,
  sshChangedHostMessage,
  sshHostKeyIssue,
  sshUnknownHostMessage
} from './sshHostKey'

const FP = 'SHA256:I3agu1Hn5jip3mSooabPbauC1z2hLi6VNbXNqrmlRX8'
const OTHER = `SHA256:${'A'.repeat(43)}`

describe('SSH host key fingerprints', () => {
  it('accepts only OpenSSH SHA-256 fingerprints', () => {
    expect(isSshFingerprint(FP)).toBe(true)
    for (const bad of ['', 'SHA256:', FP.slice(0, -1), `${FP}=`, `MD5:${FP.slice(7)}`, 42, null])
      expect(isSshFingerprint(bad), String(bad)).toBe(false)
  })

  it('the UIs read back what main writes', () => {
    expect(sshHostKeyIssue(sshUnknownHostMessage('bastion.example', 22, FP))).toEqual({
      kind: 'unknown',
      fingerprint: FP
    })
    expect(sshHostKeyIssue(sshChangedHostMessage('bastion.example', 2222, FP, OTHER))).toEqual({
      kind: 'changed',
      saved: FP,
      seen: OTHER
    })
    expect(sshHostKeyIssue('No se pudo conectar por SSH a x: timeout')).toBeNull()
    expect(sshHostKeyIssue(undefined)).toBeNull()
  })
})
