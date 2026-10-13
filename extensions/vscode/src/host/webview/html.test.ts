import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy, newNonce } from './html'

describe('webview Content Security Policy', () => {
  it('allows scripts only with the nonce and nothing remote', () => {
    const csp = contentSecurityPolicy('https://file+.vscode-resource.vscode-cdn.net', 'abc123')
    const directives = Object.fromEntries(
      csp.split(';').map((d) => {
        const [name, ...values] = d.trim().split(/\s+/)
        return [name, values]
      })
    )
    expect(directives['default-src']).toEqual(["'none'"])
    expect(directives['script-src']).toEqual(["'nonce-abc123'"])
    expect(directives['style-src']).toEqual([
      'https://file+.vscode-resource.vscode-cdn.net',
      "'nonce-abc123'"
    ])
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:\/\/(?!file\+)/)
  })

  it('makes a fresh random nonce per page', () => {
    const a = newNonce()
    expect(a).toMatch(/^[A-Za-z0-9+/]{24}$/)
    expect(newNonce()).not.toBe(a)
  })
})
