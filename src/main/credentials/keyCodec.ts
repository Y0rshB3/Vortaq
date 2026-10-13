/**
 * Secret codec for hosts without Electron's safeStorage (the editor
 * extension): AES-256-GCM with one random 32-byte key that the host keeps in
 * its own secret vault (VS Code SecretStorage, which the OS keychain backs),
 * while the encrypted values stay in credentials.json. That is the split
 * safeStorage makes in the desktop app: key in the keychain, ciphertext on
 * disk. The key never reaches credentials.json, logs or a webview.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { SecretCodec } from './store'

/** Bytes of a vault key (AES-256). */
export const VAULT_KEY_BYTES = 32

const PREFIX = 'v1:'
const IV_BYTES = 12
const TAG_BYTES = 16
const NOT_OURS = 'El valor guardado no se puede descifrar con la clave de esta bóveda de secretos.'

/** A new random vault key, base64 (what the host stores in its secret vault). */
export function newVaultKey(): string {
  return randomBytes(VAULT_KEY_BYTES).toString('base64')
}

function keyBytes(key: Buffer | string): Buffer {
  const bytes = typeof key === 'string' ? Buffer.from(key, 'base64') : key
  if (bytes.length !== VAULT_KEY_BYTES)
    throw new Error(`La clave de la bóveda de secretos debe tener ${VAULT_KEY_BYTES} bytes.`)
  return bytes
}

/**
 * Codec over `key` (32 bytes, or their base64). Each value is
 * `v1:` + base64(iv | tag | ciphertext) with a fresh random IV; decrypting a
 * value of another key, a tampered value or a foreign format throws.
 */
export function keyCodec(key: Buffer | string): SecretCodec {
  const k = keyBytes(key)
  return {
    encrypt(plain) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', k, iv)
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
    },
    decrypt(value) {
      if (!value.startsWith(PREFIX)) throw new Error(NOT_OURS)
      const raw = Buffer.from(value.slice(PREFIX.length), 'base64')
      if (raw.length < IV_BYTES + TAG_BYTES) throw new Error(NOT_OURS)
      try {
        const decipher = createDecipheriv('aes-256-gcm', k, raw.subarray(0, IV_BYTES))
        decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
        const body = raw.subarray(IV_BYTES + TAG_BYTES)
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
      } catch {
        throw new Error(NOT_OURS)
      }
    }
  }
}
