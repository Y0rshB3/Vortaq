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
  if (validKey(stored)) return { codec: keyCodec(stored), created: false }
  const key = newVaultKey()
  await secrets.store(VAULT_KEY_SECRET, key)
  return { codec: keyCodec(key), created: true }
}
