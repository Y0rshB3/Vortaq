/**
 * «Vortaq: Buscar actualizaciones». The extension is installed from a .vsix, so
 * the editor's own Auto Update has nowhere to look. Once a day (and on the
 * command) it reads the GitHub releases of the repository, tags
 * `vscode-v<x.y.z>`, and offers the newest one. «Instalar» downloads the .vsix
 * and the release's SHA256SUMS.txt, refuses a file whose SHA-256 differs,
 * installs it with the editor's own command and offers to reload the window.
 *
 * - Requests go only to GitHub (api.github.com, github.com and its download
 *   hosts); redirects are followed by hand and checked against that list.
 * - Nothing is sent but the requests themselves (no ids, no connection data);
 *   the User-Agent is the product name.
 * - `vortaq.updates.check` (user settings) turns the daily check off; the
 *   command always works.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'

export const UPDATE_REPO = 'Y0rshB3/Vortaq'
export const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=30`
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const LAST_CHECK_KEY = 'vortaq.updates.lastCheck'
export const SKIPPED_KEY = 'vortaq.updates.skipped'
const MAX_VSIX_BYTES = 64 * 1024 * 1024
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5

/** Hosts a request (or a redirect) may reach. */
export function allowedUpdateUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  const host = url.hostname.toLowerCase()
  return (
    host === 'api.github.com' ||
    host === 'github.com' ||
    host === 'objects.githubusercontent.com' ||
    host === 'release-assets.githubusercontent.com'
  )
}

export interface ExtensionRelease {
  version: string
  tag: string
  /** Release page (notes). */
  pageUrl: string
  vsixName: string
  vsixUrl: string
  sumsUrl: string
}

type Version = [number, number, number]

export function parseVersion(value: string): Version | null {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(value.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** `a` is a later version than `b` (both x.y.z; anything else is never newer). */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

/**
 * The newest published extension release in a GitHub releases listing: tag
 * `vscode-v<x.y.z>`, neither draft nor prerelease, with its .vsix and
 * SHA256SUMS.txt. The download URLs are built from the tag, never taken from
 * the answer.
 */
export function latestExtensionRelease(listing: unknown): ExtensionRelease | null {
  if (!Array.isArray(listing)) return null
  let best: ExtensionRelease | null = null
  for (const item of listing) {
    if (!item || typeof item !== 'object') continue
    const r = item as {
      tag_name?: unknown
      draft?: unknown
      prerelease?: unknown
      assets?: unknown
    }
    if (r.draft === true || r.prerelease === true || typeof r.tag_name !== 'string') continue
    const match = /^vscode-v(\d+\.\d+\.\d+)$/.exec(r.tag_name)
    if (!match || !parseVersion(match[1])) continue
    const version = match[1]
    const vsixName = `vortaq-${version}.vsix`
    const names = Array.isArray(r.assets)
      ? r.assets.map((a) => (a && typeof a === 'object' ? (a as { name?: unknown }).name : null))
      : []
    if (!names.includes(vsixName) || !names.includes('SHA256SUMS.txt')) continue
    if (best && !isNewer(version, best.version)) continue
    const base = `https://github.com/${UPDATE_REPO}/releases`
    best = {
      version,
      tag: r.tag_name,
      pageUrl: `${base}/tag/${r.tag_name}`,
      vsixName,
      vsixUrl: `${base}/download/${r.tag_name}/${vsixName}`,
      sumsUrl: `${base}/download/${r.tag_name}/SHA256SUMS.txt`
    }
  }
  return best
}

/** The SHA-256 a `sha256sum` listing gives for `fileName`, lowercase hex. */
export function digestFor(sums: string, fileName: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match && match[2] === fileName) return match[1].toLowerCase()
  }
  return null
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

/**
 * GET with redirects followed by hand (each hop must be an allowed GitHub URL)
 * and a size limit. Throws an actionable Spanish message.
 */
export async function fetchBytes(
  fetcher: Fetcher,
  url: string,
  maxBytes: number,
  accept = 'application/octet-stream'
): Promise<Buffer> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowedUpdateUrl(current))
      throw new Error('La descarga de la actualización apunta fuera de GitHub: se cancela.')
    const res = await fetcher(current, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'Vortaq', Accept: accept }
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) break
      current = new URL(location, current).toString()
      continue
    }
    if (!res.ok) throw new Error(`GitHub respondió ${res.status} al buscar la actualización.`)
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes)
      throw new Error('La actualización es más grande de lo esperado: se cancela.')
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length > maxBytes)
      throw new Error('La actualización es más grande de lo esperado: se cancela.')
    return body
  }
  throw new Error('Demasiadas redirecciones al descargar la actualización.')
}

export interface UpdaterOptions {
  currentVersion: string
  state: vscode.Memento
  /** Folder for the downloaded .vsix (deleted after installing). */
  downloadDir: string
  /** `vortaq.updates.check`. */
  enabled: () => boolean
  log: (message: string) => void
  fetcher?: Fetcher
  now?: () => number
}

export class ExtensionUpdater {
  private busy = false

  constructor(private readonly options: UpdaterOptions) {}

  private get fetcher(): Fetcher {
    return this.options.fetcher ?? ((url, init) => fetch(url, init))
  }

  /** The newest release when it is later than this extension, else null. */
  async newer(): Promise<ExtensionRelease | null> {
    const body = await fetchBytes(
      this.fetcher,
      RELEASES_API,
      MAX_TEXT_BYTES,
      'application/vnd.github+json'
    )
    let listing: unknown
    try {
      listing = JSON.parse(body.toString('utf8'))
    } catch {
      throw new Error('GitHub devolvió una lista de versiones que no se puede leer.')
    }
    const latest = latestExtensionRelease(listing)
    return latest && isNewer(latest.version, this.options.currentVersion) ? latest : null
  }

  /** The daily check on start-up: quiet unless there is something new. */
  async checkInBackground(): Promise<void> {
    if (!this.options.enabled()) return
    const now = (this.options.now ?? Date.now)()
    const last = this.options.state.get<number>(LAST_CHECK_KEY, 0)
    if (now - last < CHECK_INTERVAL_MS) return
    await this.options.state.update(LAST_CHECK_KEY, now)
    try {
      const release = await this.newer()
      const skipped = this.options.state.get<string[]>(SKIPPED_KEY, [])
      if (release && !skipped.includes(release.version)) await this.offer(release, false)
    } catch (err) {
      this.options.log(`[updates] no se pudo comprobar: ${errorText(err)}`)
    }
  }

  /** «Vortaq: Buscar actualizaciones»: always answers. */
  async checkNow(): Promise<void> {
    let release: ExtensionRelease | null
    try {
      release = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Vortaq: buscando actualizaciones…' },
        () => this.newer()
      )
    } catch (err) {
      void vscode.window.showErrorMessage(
        `No se pudo comprobar si hay actualizaciones: ${errorText(err)}`
      )
      return
    }
    if (!release) {
      void vscode.window.showInformationMessage(
        `Vortaq ${this.options.currentVersion} es la versión más reciente.`
      )
      return
    }
    await this.offer(release, true)
  }

  private async offer(release: ExtensionRelease, manual: boolean): Promise<void> {
    const install = 'Instalar'
    const notes = 'Novedades'
    const skip = 'Omitir esta versión'
    const answer = await vscode.window.showInformationMessage(
      `Hay una versión nueva de Vortaq: ${release.version} (tienes ${this.options.currentVersion}).`,
      install,
      notes,
      ...(manual ? [] : [skip])
    )
    if (answer === notes) {
      await vscode.env.openExternal(vscode.Uri.parse(release.pageUrl))
      return
    }
    if (answer === skip) {
      const skipped = this.options.state.get<string[]>(SKIPPED_KEY, [])
      await this.options.state.update(SKIPPED_KEY, [...new Set([...skipped, release.version])])
      return
    }
    if (answer === install) await this.install(release)
  }

  /** Downloads, checks the SHA-256 and installs; then offers to reload. */
  async install(release: ExtensionRelease): Promise<boolean> {
    if (this.busy) return false
    this.busy = true
    const file = join(this.options.downloadDir, release.vsixName)
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Vortaq: instalando la versión ${release.version}…`
        },
        async () => {
          const sums = await fetchBytes(this.fetcher, release.sumsUrl, MAX_TEXT_BYTES, 'text/plain')
          const expected = digestFor(sums.toString('utf8'), release.vsixName)
          if (!expected)
            throw new Error(`SHA256SUMS.txt de ${release.tag} no incluye ${release.vsixName}.`)
          const vsix = await fetchBytes(this.fetcher, release.vsixUrl, MAX_VSIX_BYTES)
          const actual = createHash('sha256').update(vsix).digest('hex')
          if (actual !== expected)
            throw new Error(
              `El archivo descargado no coincide con su SHA-256 publicado (${release.tag}): no se instala.`
            )
          mkdirSync(this.options.downloadDir, { recursive: true })
          writeFileSync(file, vsix)
          await vscode.commands.executeCommand(
            'workbench.extensions.installExtension',
            vscode.Uri.file(file)
          )
        }
      )
    } catch (err) {
      this.options.log(`[updates] no se instaló ${release.version}: ${errorText(err)}`)
      void vscode.window.showErrorMessage(
        `No se pudo instalar Vortaq ${release.version}: ${errorText(err)}`
      )
      return false
    } finally {
      rmSync(file, { force: true })
      this.busy = false
    }
    this.options.log(`[updates] instalada la versión ${release.version}`)
    const reload = 'Recargar ventana'
    const answer = await vscode.window.showInformationMessage(
      `Vortaq ${release.version} está instalado. Recarga la ventana para usarlo.`,
      reload
    )
    if (answer === reload) await vscode.commands.executeCommand('workbench.action.reloadWindow')
    return true
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
