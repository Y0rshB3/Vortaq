/**
 * The vault key of the extension's credentials.json (keyCodec, AES-256-GCM):
 * one random 32-byte key kept in VS Code's SecretStorage, which the OS
 * keychain backs. The encrypted passwords stay in the extension's own
 * profile; the key never reaches credentials.json, a log, a webview or a
 * message (docs/vscode-extension-design.md, "Activation wiring").
 */
import { keyCodec, newVaultKey, VAULT_KEY_BYTES, type SecretCodec } from '@core'

export const VAULT_KEY_SECRET = 'vortaq.vaultKey'

/** The part of vscode.SecretStorage this module uses. */
export interface SecretVault {
  get(key: string): Thenable<string | undefined>
  store(key: string, value: string): Thenable<void>
}

export interface VaultKey {
  /** The key as stored (base64): kept in memory only, never written elsewhere or logged. */
  key: string
  codec: SecretCodec
  /** True when the key was created now (first run, or SecretStorage lost the old one). */
  created: boolean
}

const validKey = (value: string | undefined): value is string =>
  !!value && Buffer.from(value, 'base64').length === VAULT_KEY_BYTES

/**
 * The stored key, or a new one (stored before it is used). When SecretStorage
 * lost the key (a reset keychain), passwords saved with the old one no longer
 * decrypt: the extension asks for them again when connecting.
 */
export async function loadVaultKey(secrets: SecretVault): Promise<VaultKey> {
  const stored = await secrets.get(VAULT_KEY_SECRET)
  if (validKey(stored)) return { key: stored, codec: keyCodec(stored), created: false }
  await secrets.store(VAULT_KEY_SECRET, newVaultKey())
  // Two editor windows starting together may both create a key: the one SecretStorage kept
  // is the one every window uses (vaultCodec follows later changes).
  const kept = await secrets.get(VAULT_KEY_SECRET)
  if (!validKey(kept))
    throw new Error('No se pudo guardar la clave en el almacén seguro del editor.')
  return { key: kept, codec: keyCodec(kept), created: true }
}

/** The part of vscode.SecretStorage's change event this module uses. */
export interface SecretChanges {
  onDidChange(listener: (event: { key: string }) => unknown): { dispose(): void }
}

/**
 * A codec that follows the key in SecretStorage: when another editor window
 * replaces it (two windows created one at the same time), this window switches
 * to the kept key instead of writing values the others cannot read.
 */
export function followingCodec(
  initial: VaultKey,
  secrets: SecretVault & SecretChanges
): { codec: SecretCodec; dispose(): void } {
  let key = initial.key
  let current = initial.codec
  const subscription = secrets.onDidChange(async (event) => {
    if (event.key !== VAULT_KEY_SECRET) return
    const next = await secrets.get(VAULT_KEY_SECRET)
    if (validKey(next) && next !== key) {
      key = next
      current = keyCodec(next)
    }
  })
  return {
    codec: {
      encrypt: (plain) => current.encrypt(plain),
      decrypt: (cipher) => current.decrypt(cipher)
    },
    dispose: () => subscription.dispose()
  }
}
