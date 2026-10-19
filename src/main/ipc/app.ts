import { app, BrowserWindow, dialog, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LOG_FILE_NAME } from '../brand'
import type { AppContext } from '../context'
import { readLicenses, REPOSITORY_OPEN_URL } from '../licenses'
import { readEnvSwitches } from '../bootstrap'
import { dismissStartupNotice, startupNotices } from '../migration'
import { installedLegacyApps, LEGACY_APP_NOTICE } from '../migration/legacyApp'
import { dismissRaisedNotice, raisedNotices } from '../notices'
import { titleBarOverlayFor, usesTitleBarOverlay } from '../windowOptions'
import { handle } from './typed'
import { mcpLaunchOf } from '@shared/mcp'
import { imageFileBytes, imageFileName, imageSavePath } from '../imageExport'

/** ElectronDB bundles still installed (macOS; a scratch profile checks only VORTAQ_LEGACY_APP_PATHS). */
function legacyApps(): string[] {
  const switches = readEnvSwitches()
  return installedLegacyApps({
    platform: process.platform,
    home: app.getPath('home'),
    candidates: switches.legacyAppPaths,
    scratchProfile: switches.userDataPath !== null,
    execPath: process.execPath
  })
}

export function registerAppHandlers(ctx: AppContext): void {
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? 'n/a',
    node: process.versions.node,
    platform: process.platform,
    userDataPath: ctx.userDataPath,
    logPath: join(ctx.logDir, LOG_FILE_NAME)
  }))
  handle('app:openPath', async (path) => {
    const err = await shell.openPath(path)
    if (err) throw new Error(err)
  })
  handle('app:showInFolder', (path) => shell.showItemInFolder(path))
  handle('app:licenses', () =>
    readLicenses({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    })
  )
  handle('app:openRepository', () => shell.openExternal(REPOSITORY_OPEN_URL))
  handle('app:mcpLaunch', () =>
    mcpLaunchOf({
      execPath: process.execPath,
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      platform: process.platform,
      appImage: process.env.APPIMAGE ?? null
    })
  )
  handle('app:pickDirectory', async (title) => {
    const res = await dialog.showOpenDialog({
      title,
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('app:pickFile', async (title, filters) => {
    const res = await dialog.showOpenDialog({ title, properties: ['openFile'], filters })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('app:pickSaveFile', async (title, defaultName, filters) => {
    const res = await dialog.showSaveDialog({
      title,
      defaultPath: defaultName,
      filters,
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    return res.canceled || !res.filePath ? null : res.filePath
  })
  // The renderer sends the image; the path comes only from this dialog.
  handle('app:saveImage', async (defaultName, image) => {
    const bytes = imageFileBytes(image)
    const format = image.format
    const res = await dialog.showSaveDialog({
      title: 'Exportar diagrama',
      defaultPath: imageFileName(defaultName, format),
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (res.canceled || !res.filePath) return null
    const path = imageSavePath(res.filePath, format)
    await writeFile(path, bytes)
    return path
  })
  handle('app:startupNotices', () => [
    ...startupNotices(ctx.userDataPath, legacyApps),
    ...raisedNotices(ctx.userDataPath)
  ])
  handle('app:dismissStartupNotice', (id) => {
    dismissStartupNotice(ctx.userDataPath, id)
    dismissRaisedNotice(ctx.userDataPath, id)
  })
  // Only on the user's click in the «ElectronDB sigue instalado» notice; the
  // paths are found again here, never taken from the renderer.
  handle('app:trashLegacyApp', async () => {
    const paths = legacyApps()
    if (!paths.length)
      throw new Error('ElectronDB ya no está instalado: no hay nada que mover a la Papelera.')
    const trashed: string[] = []
    for (const path of paths) {
      try {
        await shell.trashItem(path)
        trashed.push(path)
      } catch (err) {
        throw new Error(
          `No se pudo mover ${path} a la Papelera (${err instanceof Error ? err.message : String(err)}). Arrástrala a la Papelera desde Finder.`
        )
      }
    }
    dismissStartupNotice(ctx.userDataPath, LEGACY_APP_NOTICE)
    return { trashed }
  })
  handle('settings:get', () => ctx.settings.get())
  handle('settings:update', (patch) => {
    const settings = ctx.settings.update(patch)
    // Windows/Linux: keep the native window controls in the theme's colours.
    if (patch?.theme && usesTitleBarOverlay(process.platform)) {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.setTitleBarOverlay(titleBarOverlayFor(settings.theme))
        } catch {
          /* window without an overlay: nothing to recolour */
        }
      }
    }
    return settings
  })
}
