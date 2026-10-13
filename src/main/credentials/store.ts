import { join } from 'node:path'
import { JsonStore } from '../storage/jsonStore'

export interface SecretCodec {
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

export const plainCodec: SecretCodec = {
  encrypt: (p) => Buffer.from(p, 'utf8').toString('base64'),
  decrypt: (c) => Buffer.from(c, 'base64').toString('utf8')
}

/**
 * How the values of credentials.json are encoded: 'safeStorage' (desktop,
 * credentials/electronCodec.ts), 'plain' (base64 only: no keyring, tests) or
 * 'vaultKey' (AES-256-GCM with a key the host keeps in its own secret vault,
 * credentials/keyCodec.ts; the editor extension).
 */
export type CodecName = 'safeStorage' | 'plain' | 'vaultKey'

interface SecretsDoc {
  version: number
  codec: CodecName
  items: Record<string, string>
}

/**
 * Every secret slot a connection can own, stored as `<kind>:<connectionId>`.
 * - 'mysql': the generic database password of every engine (see DB_PASSWORD).
 * - 'ssh': SSH password or private key passphrase.
 * - 'sslKey': SSL client key passphrase (written from P2a; none exist yet).
 * deleteAll removes them all, so a new kind only needs to be listed here.
 */
export const SECRET_KINDS = ['mysql', 'ssh', 'sslKey'] as const

/** A secret owned by a connection (removed with it by deleteAll). */
export type ConnectionSecretKind = (typeof SECRET_KINDS)[number]

/**
 * Every slot kind. 'ai' holds AI provider keys, stored as `ai:<providerId>`:
 * they do not belong to a connection, so deleteAll never touches them.
 * 'backupKey' holds the password of a job's encrypted .vqb backups, stored as
 * `backupKey:<jobId>` and removed with the job.
 */
export type SecretKind = ConnectionSecretKind | 'ai' | 'backupKey'

/** Generic database password slot; the 'mysql' prefix predates multi-engine (D10). */
export const DB_PASSWORD: ConnectionSecretKind = 'mysql'

export class CredentialStore {
  private store: JsonStore<SecretsDoc>

  constructor(
    dir: string,
    private readonly codec: SecretCodec,
    readonly codecName: CodecName = 'safeStorage'
  ) {
    this.store = new JsonStore(join(dir, 'credentials.json'), () => ({
      version: 1,
      codec: codecName,
      items: {}
    }))
  }

  private key(kind: SecretKind, id: string): string {
    return `${kind}:${id}`
  }

  has(kind: SecretKind, id: string): boolean {
    return this.key(kind, id) in this.store.get().items
  }

  get(kind: SecretKind, id: string): string | null {
    const cipher = this.store.get().items[this.key(kind, id)]
    if (cipher === undefined) return null
    return this.codec.decrypt(cipher)
  }

  set(kind: SecretKind, id: string, secret: string | null): void {
    const k = this.key(kind, id)
    this.store.update((d) => {
      if (secret === null || secret === '') delete d.items[k]
      else d.items[k] = this.codec.encrypt(secret)
    })
  }

  /** Codec recorded in credentials.json (may differ from ours for a copied file). */
  storedCodec(): CodecName {
    return this.store.get().codec
  }

  /** Encoded values as stored, keyed `<kind>:<id>` (profile migration only). */
  rawItems(): Record<string, string> {
    return { ...this.store.get().items }
  }

  /** Replaces every encoded value at once and records our codec (profile migration only). */
  replaceRaw(items: Record<string, string>): void {
    this.store.update((d) => {
      d.items = { ...items }
      d.codec = this.codecName
    })
  }

  /** Encodes a value with this store's codec without saving it. */
  encode(secret: string): string {
    return this.codec.encrypt(secret)
  }

  /** Decodes a value with this store's codec; throws when it does not belong to it. */
  decode(cipher: string): string {
    return this.codec.decrypt(cipher)
  }

  /** Removes every secret of a connection, of every kind, in one write. */
  deleteAll(id: string): void {
    this.store.update((d) => {
      for (const kind of SECRET_KINDS) delete d.items[this.key(kind, id)]
    })
  }
}
