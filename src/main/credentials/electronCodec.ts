/**
 * Electron adapter of the secret codec port (SecretCodec in ./store.ts):
 * Electron safeStorage, Keychain-backed on macOS. Desktop-only; bootstrap.ts
 * builds the profile's CredentialStore with it.
 */
import { safeStorage } from 'electron'
import type { SecretCodec } from './store'

/** Uses Electron safeStorage (Keychain-backed on macOS). */
export function electronCodec(): SecretCodec {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption is not available on this system')
  }
  return {
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  }
}
