import { describe, expect, it } from 'vitest'
import { externalOpenAllowed, isAppDocument, rendererSource } from './navigation'

const FILE = '/Applications/Vortaq.app/Contents/Resources/app.asar/out/renderer/index.html'

describe('where the windows may go', () => {
  it('a packaged app ignores ELECTRON_RENDERER_URL', () => {
    const env = { ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173/' }
    expect(
      rendererSource({ packaged: true, env, file: FILE, platform: 'darwin' }).devServerUrl
    ).toBe(null)
    expect(
      rendererSource({ packaged: false, env, file: FILE, platform: 'darwin' }).devServerUrl
    ).toBe('http://127.0.0.1:5173/')
    // Only an http(s) dev server.
    expect(
      rendererSource({
        packaged: false,
        env: { ELECTRON_RENDERER_URL: 'file:///tmp/evil.html' },
        file: FILE,
        platform: 'darwin'
      }).devServerUrl
    ).toBe(null)
  })

  it('only the app’s own page is a place to go', () => {
    const source = rendererSource({ packaged: true, env: {}, file: FILE, platform: 'darwin' })
    expect(isAppDocument(`file://${FILE}`, source)).toBe(true)
    expect(isAppDocument(`file://${FILE}?shots=1#/tab`, source)).toBe(true)
    for (const url of [
      'file:///tmp/consulta.sql.html',
      `file://${FILE.replace('index.html', '../renderer/other.html')}`,
      `file://${FILE}/../../evil.html`,
      'file://attacker.example/share/index.html',
      'https://example.com/',
      'http://127.0.0.1:5173/',
      'data:text/html,<script>alert(1)</script>',
      'javascript:alert(1)',
      'not a url'
    ])
      expect(isAppDocument(url, source), url).toBe(false)
  })

  it('in development, the dev server’s origin', () => {
    const source = rendererSource({
      packaged: false,
      env: { ELECTRON_RENDERER_URL: 'http://localhost:5173' },
      file: FILE,
      platform: 'darwin'
    })
    expect(isAppDocument('http://localhost:5173/?x=1', source)).toBe(true)
    expect(isAppDocument('http://localhost:5174/', source)).toBe(false)
    expect(isAppDocument(`file://${FILE}`, source)).toBe(false)
  })

  it('Windows paths compare without case', () => {
    const source = rendererSource({
      packaged: true,
      env: {},
      file: 'C:\\Program Files\\Vortaq\\resources\\app.asar\\out\\renderer\\index.html',
      platform: 'win32'
    })
    expect(
      isAppDocument(
        'file:///c:/program%20files/Vortaq/resources/app.asar/out/renderer/index.html',
        source
      )
    ).toBe(true)
    expect(isAppDocument('file:///C:/Users/me/Downloads/consulta.sql.html', source)).toBe(false)
  })

  it('window.open reaches the browser only for the GitHub release pages', () => {
    expect(externalOpenAllowed('https://github.com/Y0rshB3/Vortaq/releases/tag/v2.9.2')).toBe(true)
    for (const url of [
      'https://example.com/',
      'file:///etc/passwd',
      'smb://attacker/share',
      'ms-msdt:/id PCWDiagnostic',
      'vscode://y0rshb3.vortaq/x',
      'http://github.com/Y0rshB3/Vortaq/releases'
    ])
      expect(externalOpenAllowed(url), url).toBe(false)
  })
})
