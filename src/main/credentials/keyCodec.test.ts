import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { keyCodec, newVaultKey, VAULT_KEY_BYTES } from './keyCodec'
import { CredentialStore, DB_PASSWORD } from './store'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('keyCodec (vault key, AES-256-GCM)', () => {
  it('round-trips text, also non-ASCII and empty, with a fresh IV each time', () => {
    const codec = keyCodec(newVaultKey())
    for (const plain of ['s3cret', 'contraseña ñ ü 🔑', '']) {
      expect(codec.decrypt(codec.encrypt(plain))).toBe(plain)
    }
    const a = codec.encrypt('same')
    const b = codec.encrypt('same')
    expect(a).not.toBe(b)
    expect(a.startsWith('v1:')).toBe(true)
    expect(a).not.toContain('same')
  })

  it('takes the key as bytes or base64 and refuses another length', () => {
    const key = newVaultKey()
    expect(Buffer.from(key, 'base64')).toHaveLength(VAULT_KEY_BYTES)
    const fromText = keyCodec(key)
    const fromBytes = keyCodec(Buffer.from(key, 'base64'))
    expect(fromBytes.decrypt(fromText.encrypt('x'))).toBe('x')
    expect(() => keyCodec(Buffer.alloc(16))).toThrow(/32 bytes/)
    expect(() => keyCodec('')).toThrow(/32 bytes/)
  })

  it('refuses values of another key, tampered values and other formats', () => {
    const codec = keyCodec(newVaultKey())
    const value = codec.encrypt('s3cret')
    expect(() => keyCodec(newVaultKey()).decrypt(value)).toThrow(/no se puede descifrar/)
    const raw = Buffer.from(value.slice(3), 'base64')
    raw[raw.length - 1] ^= 1
    expect(() => codec.decrypt(`v1:${raw.toString('base64')}`)).toThrow(/no se puede descifrar/)
    expect(() => codec.decrypt(Buffer.from('s3cret').toString('base64'))).toThrow(
      /no se puede descifrar/
    )
    expect(() => codec.decrypt('v1:AAAA')).toThrow(/no se puede descifrar/)
  })

  it('backs a CredentialStore: credentials.json holds only ciphertext', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vortaq-keycodec-'))
    dirs.push(dir)
    const key = newVaultKey()
    const store = new CredentialStore(dir, keyCodec(key), 'vaultKey')
    store.set(DB_PASSWORD, 'c1', 'p4ssw0rd-value')
    const file = readFileSync(join(dir, 'credentials.json'), 'utf8')
    expect(file).not.toContain('p4ssw0rd-value')
    expect(file).not.toContain(key)
    expect(JSON.parse(file).codec).toBe('vaultKey')
    expect(new CredentialStore(dir, keyCodec(key), 'vaultKey').get(DB_PASSWORD, 'c1')).toBe(
      'p4ssw0rd-value'
    )
  })
})
