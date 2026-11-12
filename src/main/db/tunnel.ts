import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { Client, utils as sshUtils, type ConnectConfig } from 'ssh2'
import { sshChangedHostMessage, sshUnknownHostMessage } from '@shared/sshHostKey'
import type { SshConfig } from '@shared/types'
import { getLogger } from '../log'
// Moved verbatim from src/main/mysql/tunnel.ts (P1a). It keeps throwing
// MysqlUserError (a DbUserError) on purpose: describeError appends its code
// 'E_MYSQL_USER' to "Probar conexión" failures, so another class would change
// what MySQL users read. A per-driver error code replaces it in P2a.
import { MysqlUserError } from '../mysql/errors'

// Log scope kept from v0.1.0 so existing log lines read the same.
const log = getLogger('mysql.tunnel')

export interface SshTunnelOptions {
  ssh: SshConfig
  /** SSH password, or private key passphrase when authType === 'key'. */
  secret: string | null
  targetHost: string
  targetPort: number
  /** Milliseconds to wait for the SSH handshake. */
  readyTimeout?: number
}

export interface SshTunnel {
  readonly localHost: string
  readonly localPort: number
  /** Register a listener for an unexpected tunnel shutdown. */
  onClose(listener: (reason: string) => void): void
  close(): Promise<void>
}

/**
 * Validates a private key (and its passphrase) before handing it to ssh2,
 * whose own parse errors are raw English text thrown synchronously from
 * connect(). Never includes key material or the passphrase in the message.
 */
export function checkPrivateKey(key: Buffer, passphrase: string | null, keyPath: string): void {
  const parsed = sshUtils.parseKey(key, passphrase ?? undefined)
  if (!(parsed instanceof Error)) return
  const reason = parsed.message.toLowerCase()
  if (reason.includes('no passphrase')) {
    throw new MysqlUserError(
      `La clave privada SSH ${keyPath} está cifrada y no hay frase de contraseña guardada. Guárdala en la configuración SSH de la conexión.`
    )
  }
  if (
    reason.includes('passphrase') ||
    reason.includes('integrity check') ||
    reason.includes('bad decrypt')
  ) {
    throw new MysqlUserError(
      `La frase de contraseña de la clave privada SSH ${keyPath} es incorrecta`
    )
  }
  throw new MysqlUserError(
    `La clave privada SSH ${keyPath} no tiene un formato soportado (${parsed.message})`
  )
}

export async function buildConnectConfig(opts: SshTunnelOptions): Promise<ConnectConfig> {
  const { ssh, secret } = opts
  if (!ssh.host) throw new MysqlUserError('El túnel SSH no tiene host configurado')
  if (!ssh.username) throw new MysqlUserError('El túnel SSH no tiene usuario configurado')
  const config: ConnectConfig = {
    host: ssh.host,
    port: ssh.port || 22,
    username: ssh.username,
    readyTimeout: opts.readyTimeout ?? 15000,
    keepaliveInterval: 30000
  }
  if (ssh.authType === 'key') {
    if (!ssh.privateKeyPath)
      throw new MysqlUserError(
        'El túnel SSH usa clave privada pero no se indicó la ruta del archivo'
      )
    try {
      config.privateKey = await readFile(ssh.privateKeyPath)
    } catch {
      throw new MysqlUserError(`No se pudo leer la clave privada SSH en ${ssh.privateKeyPath}`)
    }
    checkPrivateKey(config.privateKey, secret, ssh.privateKeyPath)
    if (secret) config.passphrase = secret
  } else {
    if (secret === null)
      throw new MysqlUserError(`No hay contraseña SSH guardada para ${ssh.username}@${ssh.host}`)
    config.password = secret
  }
  return config
}

/**
 * Opens an SSH connection and a local TCP listener on 127.0.0.1 whose
 * connections are forwarded to targetHost:targetPort through the SSH server.
 */
/** OpenSSH's fingerprint of a host key blob: `SHA256:` + unpadded base64 of its SHA-256. */
export function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

export async function openSshTunnel(opts: SshTunnelOptions): Promise<SshTunnel> {
  const config = await buildConnectConfig(opts)
  // Only the host key the user confirmed (shared/sshHostKey.ts); never any key, never silently.
  let hostKeyRefusal: string | null = null
  config.hostVerifier = (key: Buffer): boolean => {
    const seen = sshFingerprint(key)
    const saved = opts.ssh.hostKey
    if (saved && saved === seen) return true
    const port = opts.ssh.port || 22
    hostKeyRefusal = saved
      ? sshChangedHostMessage(opts.ssh.host, port, saved, seen)
      : sshUnknownHostMessage(opts.ssh.host, port, seen)
    log.warn(`ssh host key ${saved ? 'changed' : 'not confirmed yet'}: connection refused`)
    return false
  }
  const client = new Client()
  const closeListeners: ((reason: string) => void)[] = []
  let server: Server | null = null
  let closed = false
  const sockets = new Set<Socket>()

  const notifyClosed = (reason: string): void => {
    if (closed) return
    closed = true
    for (const s of sockets) s.destroy()
    server?.close()
    for (const l of closeListeners) l(reason)
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      client.removeListener('ready', onReady)
      reject(
        new MysqlUserError(
          hostKeyRefusal ?? `No se pudo conectar por SSH a ${opts.ssh.host}: ${err.message}`
        )
      )
    }
    const onReady = (): void => {
      client.removeListener('error', onError)
      resolve()
    }
    client.once('error', onError)
    client.once('ready', onReady)
    try {
      client.connect(config)
    } catch (err) {
      // ssh2 validates parts of the config synchronously
      client.removeListener('error', onError)
      client.removeListener('ready', onReady)
      reject(
        new MysqlUserError(
          `No se pudo conectar por SSH a ${opts.ssh.host}: ${err instanceof Error ? err.message : String(err)}`
        )
      )
    }
  })

  client.on('error', (err) => {
    log.warn(`ssh tunnel to ${opts.ssh.host} failed: ${err.message}`)
    notifyClosed(`Túnel SSH con error: ${err.message}`)
  })
  client.on('close', () => notifyClosed('Túnel SSH cerrado'))

  server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    client.forwardOut(
      '127.0.0.1',
      socket.remotePort ?? 0,
      opts.targetHost,
      opts.targetPort,
      (err, stream) => {
        if (err) {
          log.warn(`ssh forward to ${opts.targetHost}:${opts.targetPort} refused: ${err.message}`)
          socket.destroy()
          return
        }
        socket.on('error', () => stream.destroy())
        stream.on('error', () => socket.destroy())
        socket.pipe(stream).pipe(socket)
      }
    )
  })

  const localPort = await new Promise<number>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port))
  }).catch((err: Error) => {
    client.end()
    throw new MysqlUserError(`No se pudo abrir el puerto local del túnel SSH: ${err.message}`)
  })

  return {
    localHost: '127.0.0.1',
    localPort,
    onClose: (listener) => closeListeners.push(listener),
    close: async () => {
      if (!closed) {
        closed = true
        for (const s of sockets) s.destroy()
        await new Promise<void>((resolve) => server!.close(() => resolve()))
      }
      client.end()
    }
  }
}
