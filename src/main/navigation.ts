/**
 * Where Vortaq's windows may go. The preload (window.vortaq, every IPC channel)
 * is injected into whatever document a window shows, so a window must never
 * leave the app's own page: not by a link, a redirect, a frame, a <webview> or
 * a window.open (dropped files already never navigate: navigateOnDragDrop is
 * false, windowOptions.ts). The renderer has none of these today: this is
 * defence in depth. Links meant for the browser go through `app:openExternal`
 * (GitHub releases only).
 *
 * Electron-free: window.ts and index.ts wire these rules to webContents events.
 */
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAllowedReleaseUrl } from './updates/release'

/** Where the main window's renderer comes from. */
export interface RendererSource {
  /** The built renderer page (out/renderer/index.html, inside app.asar when packaged). */
  file: string
  /** `npm run dev` only: the Vite dev server (ELECTRON_RENDERER_URL). Never in a packaged app. */
  devServerUrl: string | null
  /** Windows paths compare without case. */
  platform: NodeJS.Platform
}

const pathsOf = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? win32 : posix)

/**
 * ELECTRON_RENDERER_URL counts only for an unpackaged run: whoever can set the
 * environment of an installed Vortaq must not make it load another page with
 * the preload attached.
 */
export function rendererSource(options: {
  packaged: boolean
  env: NodeJS.ProcessEnv
  file: string
  platform?: NodeJS.Platform
}): RendererSource {
  const dev = options.packaged ? '' : (options.env.ELECTRON_RENDERER_URL ?? '').trim()
  let devServerUrl: string | null = null
  if (dev) {
    try {
      const url = new URL(dev)
      if (url.protocol === 'http:' || url.protocol === 'https:') devServerUrl = url.toString()
    } catch {
      devServerUrl = null
    }
  }
  const platform = options.platform ?? process.platform
  return { file: pathsOf(platform).resolve(options.file), devServerUrl, platform }
}

/** True for the app's own page, with any query or hash; every other URL is refused. */
export function isAppDocument(raw: string, source: RendererSource): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (source.devServerUrl) return url.origin === new URL(source.devServerUrl).origin
  if (url.protocol !== 'file:' || (url.host !== '' && url.host !== 'localhost')) return false
  const windows = source.platform === 'win32'
  let path: string
  try {
    path = pathsOf(source.platform).resolve(fileURLToPath(`file://${url.pathname}`, { windows }))
  } catch {
    return false
  }
  return windows ? path.toLowerCase() === source.file.toLowerCase() : path === source.file
}

/**
 * window.open and target links: a new window is never created; only the
 * GitHub release pages and downloads the app itself links to are handed to
 * the system browser (the rule of `app:openExternal`). `file:`, `smb:`,
 * other apps' schemes and every other site are dropped.
 */
export function externalOpenAllowed(raw: string): boolean {
  return isAllowedReleaseUrl(raw)
}
