/**
 * SSH host key pinning (2.9.3) against a real SSH server: compose service
 * `sshd` (VORTAQ_TEST_SSH_URL=ssh://vortaq:navidog@127.0.0.1:52222). A server
 * not confirmed yet is refused with its fingerprint, the confirmed one opens,
 * and any other saved fingerprint is refused as a changed key.
 */
import { describe, expect, it } from 'vitest'
import { envVar } from '@main/env'
import { openSshTunnel } from '@main/db/tunnel'
import { sshHostKeyIssue } from '@shared/sshHostKey'
import type { SshConfig } from '@shared/types'

const url = envVar('TEST_SSH_URL')?.trim()

describe.skipIf(!url)('SSH host key pinning (integration, VORTAQ_TEST_SSH_URL)', () => {
  const u = new URL(url ?? 'ssh://x@127.0.0.1:22')
  const ssh = (hostKey?: string): SshConfig => ({
    enabled: true,
    host: u.hostname,
    port: Number(u.port || 22),
    username: decodeURIComponent(u.username),
    authType: 'password',
    savePassword: false,
    ...(hostKey ? { hostKey } : {})
  })
  const open = (hostKey?: string) =>
    openSshTunnel({
      ssh: ssh(hostKey),
      secret: decodeURIComponent(u.password),
      targetHost: '127.0.0.1',
      targetPort: 2222,
      readyTimeout: 20_000
    })

  it('refuses a server not confirmed yet, opens with its fingerprint, refuses another one', async () => {
    const first = await open().then(
      () => null,
      (err: Error) => err.message
    )
    const issue = sshHostKeyIssue(first)
    expect(issue?.kind).toBe('unknown')
    const fingerprint = issue?.kind === 'unknown' ? issue.fingerprint : ''
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(first).toContain(`${u.hostname}:${u.port}`)

    const tunnel = await open(fingerprint)
    expect(tunnel.localPort).toBeGreaterThan(0)
    await tunnel.close()

    const other = `SHA256:${'A'.repeat(43)}`
    const changed = await open(other).then(
      () => null,
      (err: Error) => err.message
    )
    expect(sshHostKeyIssue(changed)).toEqual({ kind: 'changed', saved: other, seen: fingerprint })
  }, 60_000)
})
