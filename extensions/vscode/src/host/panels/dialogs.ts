/**
 * VS Code file dialogs behind the webviews' app:pickFile / app:pickSaveFile /
 * app:pickDirectory (the desktop app answers them with Electron's dialogs).
 * Shared by the connection form and the results panels.
 */
import { homedir } from 'node:os'
import * as vscode from 'vscode'

export type FileFilters = { name: string; extensions: string[] }[] | undefined

/** The renderer's `{ name, extensions }[]` filters as VS Code's `{ [name]: extensions }`. */
export const dialogFilters = (filters: FileFilters): Record<string, string[]> | undefined =>
  Array.isArray(filters) && filters.length
    ? Object.fromEntries(
        filters
          .filter((f) => f && typeof f.name === 'string' && Array.isArray(f.extensions))
          .map((f) => [f.name, f.extensions.filter((e) => typeof e === 'string')])
      )
    : undefined

/**
 * Files the core opens are local paths of the machine the extension runs on.
 * In a remote window the dialogs can browse the remote file system: those
 * picks are refused instead of being used as local paths.
 */
export function localPath(uri: vscode.Uri | undefined): string | null {
  if (!uri) return null
  if (uri.scheme !== 'file')
    throw new Error(
      'Elige un archivo de este equipo: Vortaq abre los archivos donde se ejecuta la extensión.'
    )
  return uri.fsPath
}

/** First folder of the workspace when it is local, else the user's home folder. */
export function localHome(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri
  return folder?.scheme === 'file' ? folder : vscode.Uri.file(homedir())
}

/** A file name the save dialog can propose: no folders, no characters Windows refuses. */
export function safeFileName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return clean && clean !== '.' && clean !== '..' ? clean.slice(0, 200) : null
}
