/**
 * The SSH server's host key, pinned per connection (2.9.3). The first time
 * Vortaq meets a server it does not connect: it shows the key's SHA-256
 * fingerprint («SHA256:…», as `ssh-keygen -lf` prints it) and the user
 * confirms it (connection form, tree, editor extension). From then on only
 * that key is accepted; a different one is always refused, also in jobs and
 * agents (MCP), which never ask. main (db/tunnel.ts) writes these messages and
 * the UIs read them back with `sshHostKeyIssue` to offer «Confiar».
 */

/** OpenSSH's SHA-256 fingerprint: base64 of 32 bytes without padding. */
export const SSH_FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/

export function isSshFingerprint(value: unknown): value is string {
  return typeof value === 'string' && SSH_FINGERPRINT_RE.test(value)
}

const FINGERPRINT = 'SHA256:[A-Za-z0-9+/]{43}'

export function sshUnknownHostMessage(host: string, port: number, fingerprint: string): string {
  return `Vortaq todavía no conoce el servidor SSH ${host}:${port}. Su huella es ${fingerprint}. Compruébala con quien administra el servidor (ssh-keygen -lf) y, si coincide, confía en ella al abrir la conexión en Vortaq.`
}

export function sshChangedHostMessage(
  host: string,
  port: number,
  saved: string,
  seen: string
): string {
  return `La huella del servidor SSH ${host}:${port} ha cambiado (guardada ${saved}, ahora ${seen}): podría ser otro servidor haciéndose pasar por el tuyo, así que Vortaq no se conecta. Si quien lo administra cambió su clave, olvida la huella guardada en Editar conexión › SSH y vuelve a conectar.`
}

export type SshHostKeyIssue =
  { kind: 'unknown'; fingerprint: string } | { kind: 'changed'; saved: string; seen: string }

/** The host key problem a connection error describes, if any. */
export function sshHostKeyIssue(message: string | null | undefined): SshHostKeyIssue | null {
  if (!message) return null
  const unknown = new RegExp(`no conoce el servidor SSH .*? Su huella es (${FINGERPRINT})\\.`).exec(
    message
  )
  if (unknown) return { kind: 'unknown', fingerprint: unknown[1] }
  const changed = new RegExp(
    `La huella del servidor SSH .*? ha cambiado \\(guardada (${FINGERPRINT}), ahora (${FINGERPRINT})\\)`
  ).exec(message)
  if (changed) return { kind: 'changed', saved: changed[1], seen: changed[2] }
  return null
}
