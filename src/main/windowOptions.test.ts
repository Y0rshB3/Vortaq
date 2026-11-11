import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  mainWebPreferences,
  TOOLBAR_HEIGHT,
  titleBarOverlayFor,
  usesTitleBarOverlay,
  windowChromeOptions,
  windowIconPath
} from './windowOptions'

describe('windowChromeOptions', () => {
  it('keeps the inset title bar and traffic lights on macOS', () => {
    const opts = windowChromeOptions({ platform: 'darwin', theme: 'dark' })
    expect(opts.titleBarStyle).toBe('hiddenInset')
    expect(opts.trafficLightPosition).toEqual({ x: 14, y: 14 })
    expect(opts.titleBarOverlay).toBeUndefined()
    expect(usesTitleBarOverlay('darwin')).toBe(false)
  })

  for (const platform of ['win32', 'linux'] as const) {
    it(`uses a hidden title bar with native window controls on ${platform}`, () => {
      const opts = windowChromeOptions({ platform, theme: 'dark' })
      expect(opts.titleBarStyle).toBe('hidden')
      expect(opts.trafficLightPosition).toBeUndefined()
      expect(opts.titleBarOverlay).toEqual({
        color: '#090c13',
        symbolColor: '#94a3b8',
        height: TOOLBAR_HEIGHT
      })
      expect(usesTitleBarOverlay(platform)).toBe(true)
    })
  }

  it('follows the light theme and matches the toolbar height', () => {
    expect(windowChromeOptions({ platform: 'win32', theme: 'light' }).titleBarOverlay).toEqual(
      titleBarOverlayFor('light')
    )
    expect(titleBarOverlayFor('light')).toMatchObject({ color: '#f3f5fa', height: 70 })
  })

  it('matches the renderer toolbar height token', () => {
    const tokens = readFileSync(resolve('src/renderer/src/styles/tokens.css'), 'utf8')
    expect(tokens).toContain(`--nd-toolbar-h: ${TOOLBAR_HEIGHT}px;`)
  })
})

describe('windowIconPath', () => {
  const base = { resourcesPath: '/r', appPath: resolve('.') }
  it('leaves the Dock icon to the bundle on macOS', () => {
    expect(windowIconPath({ ...base, platform: 'darwin', packaged: true })).toBeUndefined()
  })
  it('uses the shipped PNG when packaged', () => {
    expect(windowIconPath({ ...base, platform: 'win32', packaged: true })).toBe(
      join('/r', 'icon.png')
    )
  })
  it('points at an existing PNG in development', () => {
    const path = windowIconPath({ ...base, platform: 'linux', packaged: false })
    expect(path && existsSync(path)).toBe(true)
  })
})

describe('main window webPreferences', () => {
  it('keeps the renderer contained, with every value written out', () => {
    expect(mainWebPreferences('/app/out/preload/index.js')).toEqual({
      preload: '/app/out/preload/index.js',
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false
    })
  })
})
