import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import {
  installSourceIn,
  readInstallSource,
  allowedUpdateUrl,
  CHECK_INTERVAL_MS,
  digestFor,
  ExtensionUpdater,
  fetchBytes,
  isNewer,
  LAST_CHECK_KEY,
  latestExtensionRelease,
  RELEASES_API,
  SKIPPED_KEY,
  type Fetcher
} from './updates'

const release = (tag: string, extra: Record<string, unknown> = {}) => {
  const version = tag.replace('vscode-v', '')
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [{ name: `vortaq-${version}.vsix` }, { name: 'SHA256SUMS.txt' }],
    ...extra
  }
}

const LISTING = [
  release('v2.6.0', { assets: [{ name: 'Vortaq-2.6.0-arm64.dmg' }] }),
  release('vscode-v0.7.0'),
  release('vscode-v0.8.0', { draft: true }),
  release('vscode-v0.9.0', { prerelease: true }),
  release('vscode-v0.6.1', { assets: [{ name: 'vortaq-0.6.1.vsix' }] }),
  release('vscode-v0.5.0')
]

describe('extension releases on GitHub', () => {
  it('picks the newest published vscode-v release with its .vsix and SHA256SUMS.txt', () => {
    expect(latestExtensionRelease(LISTING)).toEqual({
      version: '0.7.0',
      tag: 'vscode-v0.7.0',
      pageUrl: 'https://github.com/Y0rshB3/Vortaq/releases/tag/vscode-v0.7.0',
      vsixName: 'vortaq-0.7.0.vsix',
      vsixUrl:
        'https://github.com/Y0rshB3/Vortaq/releases/download/vscode-v0.7.0/vortaq-0.7.0.vsix',
      sumsUrl: 'https://github.com/Y0rshB3/Vortaq/releases/download/vscode-v0.7.0/SHA256SUMS.txt'
    })
    expect(latestExtensionRelease({ message: 'rate limited' })).toBeNull()
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('0.6.0', '0.6.0')).toBe(false)
    expect(isNewer('1.0.0-beta', '0.6.0')).toBe(false)
  })

  it('reads the digest of one file from SHA256SUMS.txt', () => {
    const sums = `${'a'.repeat(64)}  vortaq-0.7.0.vsix\n${'B'.repeat(64)} *otro.vsix\n`
    expect(digestFor(sums, 'vortaq-0.7.0.vsix')).toBe('a'.repeat(64))
    expect(digestFor(sums, 'otro.vsix')).toBe('b'.repeat(64))
    expect(digestFor(sums, 'nada.vsix')).toBeNull()
  })

  it('only talks to GitHub over https and follows redirects only inside it', async () => {
    expect(allowedUpdateUrl(RELEASES_API)).toBe(true)
    expect(allowedUpdateUrl('https://release-assets.githubusercontent.com/x')).toBe(true)
    expect(allowedUpdateUrl('http://github.com/x')).toBe(false)
    expect(allowedUpdateUrl('https://github.com.evil.test/x')).toBe(false)
    expect(allowedUpdateUrl('https://user:pw@github.com/x')).toBe(false)

    const out: Fetcher = async (url) =>
      url.startsWith('https://github.com/')
        ? new Response(null, { status: 302, headers: { location: 'https://evil.test/a.vsix' } })
        : new Response('nope')
    await expect(fetchBytes(out, 'https://github.com/a', 10)).rejects.toThrow(/fuera de GitHub/)
    const big: Fetcher = async () => new Response('x'.repeat(20))
    await expect(fetchBytes(big, 'https://github.com/a', 10)).rejects.toThrow(/más grande/)
  })
})

describe('where the editor installed the extension from', () => {
  // The entries the editor wrote (VS Code 1.145) for a .vsix and for a gallery install.
  const vsixEntry = {
    identifier: { id: 'y0rshb3.vortaq' },
    version: '0.8.0',
    relativeLocation: 'y0rshb3.vortaq-0.8.0',
    metadata: { installedTimestamp: 1794412615835, pinned: true, source: 'vsix' }
  }
  const galleryEntry = {
    identifier: { id: 'y0rshb3.vortaq' },
    version: '0.8.1',
    relativeLocation: 'y0rshb3.vortaq-0.8.1',
    metadata: {
      installedTimestamp: 1794412629877,
      source: 'gallery',
      id: '3792588c-3d35-442d-91ea-fe6a755e8155',
      publisherDisplayName: 'Y0rshb3',
      isPreReleaseVersion: false
    }
  }

  it('reads only this extension’s own entry, by its folder', () => {
    const listing = [vsixEntry, galleryEntry]
    expect(installSourceIn(listing, 'y0rshb3.vortaq-0.8.0')).toBe('vsix')
    expect(installSourceIn(listing, 'y0rshb3.vortaq-0.8.1')).toBe('gallery')
    expect(installSourceIn(listing, 'y0rshb3.vortaq-0.9.0')).toBe('unknown')
    expect(installSourceIn({ items: listing }, 'y0rshb3.vortaq-0.8.0')).toBe('unknown')
    expect(
      installSourceIn([{ ...vsixEntry, metadata: { source: 'resource' } }], 'y0rshb3.vortaq-0.8.0')
    ).toBe('unknown')
  })

  it('reads extensions.json next to the extension folder; anything else is unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'vortaq-install-source-'))
    try {
      const extensionPath = join(root, 'y0rshb3.vortaq-0.8.1')
      mkdirSync(extensionPath)
      expect(readInstallSource(extensionPath)).toBe('unknown')
      writeFileSync(join(root, 'extensions.json'), JSON.stringify([vsixEntry, galleryEntry]))
      expect(readInstallSource(extensionPath)).toBe('gallery')
      writeFileSync(join(root, 'extensions.json'), '{ not json')
      expect(readInstallSource(extensionPath)).toBe('unknown')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('ExtensionUpdater', () => {
  let dir: string
  let state: Map<string, unknown>
  const vsix = Buffer.from('PK fake vsix content')
  const digest = createHash('sha256').update(vsix).digest('hex')
  const memento = () =>
    ({
      get: (key: string, fallback?: unknown) => (state.has(key) ? state.get(key) : fallback),
      update: async (key: string, value: unknown) => {
        state.set(key, value)
      }
    }) as unknown as vscode.Memento

  /** GitHub as the updater sees it: the listing, a redirect per download, and the files. */
  function github(sums = `${digest}  vortaq-0.7.0.vsix\n`): Fetcher & { urls: string[] } {
    const urls: string[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      urls.push(url)
      expect(init.redirect).toBe('manual')
      expect((init.headers as Record<string, string>)['User-Agent']).toBe('Vortaq')
      if (url === RELEASES_API) return new Response(JSON.stringify(LISTING))
      if (url.startsWith('https://github.com/'))
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://release-assets.githubusercontent.com/${url.split('/').pop()}`
          }
        })
      if (url.endsWith('SHA256SUMS.txt')) return new Response(sums)
      if (url.endsWith('.vsix')) return new Response(vsix)
      return new Response('missing', { status: 404 })
    }) as Fetcher & { urls: string[] }
    fetcher.urls = urls
    return fetcher
  }

  function updater(fetcher: Fetcher, now = 1_000_000_000_000) {
    return new ExtensionUpdater({
      currentVersion: '0.6.0',
      state: memento(),
      downloadDir: join(dir, 'updates'),
      enabled: () => true,
      log: () => undefined,
      fetcher,
      now: () => now
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'vortaq-updates-'))
    state = new Map()
    vi.mocked(vscode.window.withProgress).mockImplementation(
      async (_options, task) => task({ report: () => undefined }, {} as never) as never
    )
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('offers the new version and installs the checked .vsix with the editor, then offers to reload', async () => {
    const fetcher = github()
    vi.mocked(vscode.window.showInformationMessage)
      .mockResolvedValueOnce('Instalar' as never)
      .mockResolvedValueOnce('Recargar ventana' as never)
    await updater(fetcher).checkNow()
    const install = vi
      .mocked(vscode.commands.executeCommand)
      .mock.calls.find((c) => c[0] === 'workbench.extensions.installExtension')
    expect((install?.[1] as vscode.Uri).fsPath).toBe(join(dir, 'updates', 'vortaq-0.7.0.vsix'))
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow')
    // The downloaded file does not stay behind.
    expect(existsSync(join(dir, 'updates', 'vortaq-0.7.0.vsix'))).toBe(false)
    expect(fetcher.urls).toContain('https://release-assets.githubusercontent.com/vortaq-0.7.0.vsix')
  })

  it('never installs a file whose SHA-256 differs from the published one', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Instalar' as never)
    await updater(github(`${'0'.repeat(64)}  vortaq-0.7.0.vsix\n`)).checkNow()
    expect(
      vi
        .mocked(vscode.commands.executeCommand)
        .mock.calls.some((c) => c[0] === 'workbench.extensions.installExtension')
    ).toBe(false)
    expect(vi.mocked(vscode.window.showErrorMessage).mock.calls[0][0]).toMatch(/SHA-256/)
  })

  it('checks at most once a day in the background and remembers «Omitir esta versión»', async () => {
    const fetcher = github()
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Omitir esta versión' as never
    )
    const now = 1_000_000_000_000
    await updater(fetcher, now).checkInBackground()
    expect(state.get(LAST_CHECK_KEY)).toBe(now)
    expect(state.get(SKIPPED_KEY)).toEqual(['0.7.0'])
    // Same day: no request at all.
    const calls = fetcher.urls.length
    await updater(fetcher, now + 1000).checkInBackground()
    expect(fetcher.urls.length).toBe(calls)
    // Next day: checked again, but the skipped version is not offered.
    vi.mocked(vscode.window.showInformationMessage).mockClear()
    await updater(fetcher, now + CHECK_INTERVAL_MS + 1).checkInBackground()
    expect(fetcher.urls.length).toBeGreaterThan(calls)
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
  })

  it('installed from the gallery: no GitHub request; the command points at the editor’s check', async () => {
    const fetcher = github()
    const gallery = new ExtensionUpdater({
      currentVersion: '0.6.0',
      state: memento(),
      downloadDir: dir,
      enabled: () => true,
      log: () => undefined,
      installSource: () => 'gallery',
      fetcher,
      now: () => 1_000_000_000_000
    })
    await gallery.checkInBackground()
    expect(fetcher.urls).toEqual([])
    expect(state.has(LAST_CHECK_KEY)).toBe(false)
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Buscar actualizaciones de extensiones' as never
    )
    await gallery.checkNow()
    expect(fetcher.urls).toEqual([])
    expect(vi.mocked(vscode.window.showInformationMessage).mock.calls[0][0]).toMatch(
      /galería de extensiones del editor, que la actualiza sola/
    )
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.extensions.action.checkForUpdates'
    )
    expect(
      vi
        .mocked(vscode.commands.executeCommand)
        .mock.calls.some((c) => c[0] === 'workbench.extensions.installExtension')
    ).toBe(false)
  })

  it('says when this is already the newest version', async () => {
    const current = new ExtensionUpdater({
      currentVersion: '0.7.0',
      state: memento(),
      downloadDir: dir,
      enabled: () => true,
      log: () => undefined,
      fetcher: github()
    })
    await current.checkNow()
    expect(vi.mocked(vscode.window.showInformationMessage).mock.calls[0][0]).toBe(
      'Vortaq 0.7.0 es la versión más reciente.'
    )
  })
})
