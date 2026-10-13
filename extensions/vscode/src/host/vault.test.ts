import { describe, expect, it } from 'vitest'
import { keyCodec, newVaultKey } from '@core'
import { followingCodec, loadVaultKey, VAULT_KEY_SECRET, type SecretVault } from './vault'

function vault(initial?: string): SecretVault & { stored: Map<string, string> } {
  const stored = new Map<string, string>()
  if (initial !== undefined) stored.set(VAULT_KEY_SECRET, initial)
  return {
    stored,
    get: async (key) => stored.get(key),
    store: async (key, value) => void stored.set(key, value)
  }
}

describe('vault key in SecretStorage', () => {
  it('creates and stores a key on first use', async () => {
    const secrets = vault()
    const { codec, created } = await loadVaultKey(secrets)
    expect(created).toBe(true)
    const key = secrets.stored.get(VAULT_KEY_SECRET)!
    expect(Buffer.from(key, 'base64')).toHaveLength(32)
    // The stored key decrypts what the codec encrypted: same key, not a copy of the secret.
    expect(keyCodec(key).decrypt(codec.encrypt('s3creta'))).toBe('s3creta')
  })

  it('reuses a valid key and replaces an invalid one', async () => {
    const key = newVaultKey()
    const kept = await loadVaultKey(vault(key))
    expect(kept.created).toBe(false)
    expect(keyCodec(key).decrypt(kept.codec.encrypt('x'))).toBe('x')
    const broken = vault('corto')
    expect((await loadVaultKey(broken)).created).toBe(true)
    expect(broken.stored.get(VAULT_KEY_SECRET)).not.toBe('corto')
  })

  it('uses the key SecretStorage kept when two windows create one at once', async () => {
    const other = newVaultKey()
    const secrets = vault()
    const racing: SecretVault = {
      get: secrets.get,
      // Another window stores its own key right after this one.
      store: async (key, value) => {
        await secrets.store(key, value)
        await secrets.store(key, other)
      }
    }
    const loaded = await loadVaultKey(racing)
    expect(loaded.key).toBe(other)
    expect(keyCodec(other).decrypt(loaded.codec.encrypt('x'))).toBe('x')
  })

  it('follows a key another window stores later', async () => {
    const first = newVaultKey()
    const secrets = vault(first)
    const listeners: ((e: { key: string }) => unknown)[] = []
    const following = followingCodec(await loadVaultKey(secrets), {
      ...secrets,
      onDidChange: (listener) => {
        listeners.push(listener)
        return { dispose: () => undefined }
      }
    })
    const second = newVaultKey()
    secrets.stored.set(VAULT_KEY_SECRET, second)
    for (const l of listeners) await l({ key: VAULT_KEY_SECRET })
    expect(keyCodec(second).decrypt(following.codec.encrypt('y'))).toBe('y')
    following.dispose()
  })
})
