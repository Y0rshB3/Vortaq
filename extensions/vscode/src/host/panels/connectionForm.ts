/**
 * «Añadir conexión» / «Editar conexión»: a webview that renders the desktop
 * app's connection dialog (every engine, SSH, SSL/TLS, environment, «Sin
 * contraseña», «Probar conexión»). Passwords typed there go straight to the
 * core's credential store (encrypted with the vault key); the webview can
 * only touch the connection it edits (or the one it created), and only
 * create the SQLite file the user just chose in the save dialog.
 */
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as vscode from 'vscode'
import type { ConnectionConfig, EngineId } from '@core'
import type { HostMessage } from '../../protocol'
import type { ConnectionFormState, WebviewSettings } from '../../webviewState'
import { handleWebviewMessage } from '../webview/bridge'
import { webviewHtml, webviewOptions } from '../webview/html'
import { showNotification } from './results'

/** Core channels the connection form may call. */
export const CONNECTION_FORM_CHANNELS: ReadonlySet<string> = new Set([
  'connections:save',
  'connections:test',
  'connections:setPassword',
  'connections:hasPassword',
  'connections:setSshPassword',
  'connections:hasSshPassword',
  'connections:setSslKeyPassword',
  'connections:hasSslKeyPassword',
  'sqlite:createFile'
])

/** Channels whose first argument is the id of the connection being edited. */
const ID_CHANNELS = new Set([
  'connections:setPassword',
  'connections:hasPassword',
  'connections:setSshPassword',
  'connections:hasSshPassword',
  'connections:setSslKeyPassword',
  'connections:hasSslKeyPassword'
])

const OTHER_CONNECTION = 'Este formulario solo puede modificar su propia conexión.'

type FileFilters = { name: string; extensions: string[] }[] | undefined

const dialogFilters = (filters: FileFilters): Record<string, string[]> | undefined =>
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
function localPath(uri: vscode.Uri | undefined): string | null {
  if (!uri) return null
  if (uri.scheme !== 'file')
    throw new Error(
      'Elige un archivo de este equipo: Vortaq abre los archivos donde se ejecuta la extensión.'
    )
  return uri.fsPath
}

/** First folder of the workspace when it is local, else the user's home folder. */
function localHome(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri
  return folder?.scheme === 'file' ? folder : vscode.Uri.file(homedir())
}

/**
 * The scope rules of one form, apart from VS Code so they can be tested:
 * which connection ids it may write and which file it may create.
 */
export class FormScope {
  private readonly ids = new Set<string>()
  private pickedSavePath: string | null = null

  constructor(readonly editing: ConnectionConfig | null) {
    if (editing) this.ids.add(editing.id)
  }

  check(channel: string, args: readonly unknown[]): string | null {
    // «Probar conexión» falls back to the stored passwords of input.id: only its own.
    if (channel === 'connections:save' || channel === 'connections:test') {
      const input = args[0] as { id?: unknown } | null
      if (!input || typeof input !== 'object') return 'Datos de conexión no válidos.'
      if (input.id !== undefined && input.id !== null && !this.ids.has(String(input.id)))
        return OTHER_CONNECTION
      return null
    }
    if (ID_CHANNELS.has(channel)) return this.ids.has(String(args[0])) ? null : OTHER_CONNECTION
    if (channel === 'sqlite:createFile')
      return this.pickedSavePath !== null && args[0] === this.pickedSavePath
        ? null
        : 'Elige primero dónde crear el archivo con «Crear base de datos nueva…».'
    return null
  }

  /** A save created (or updated) a connection: the form may keep working on it. */
  saved(result: unknown): void {
    const id = (result as { id?: unknown } | null)?.id
    if (typeof id === 'string') this.ids.add(id)
  }

  savePathChosen(path: string | null): void {
    this.pickedSavePath = path
  }

  /** Folders «Abrir» may reveal: the extra backup folders of the edited connection. */
  mayReveal(path: unknown): path is string {
    return typeof path === 'string' && !!this.editing?.extraBackupDirs.includes(path)
  }
}

export interface ConnectionFormDeps {
  extensionUri: vscode.Uri
  invoke: (channel: string, args: unknown[]) => Promise<unknown>
  prepare: (
    channel: string,
    args: readonly unknown[]
  ) => Promise<{ args: unknown[] } | { refused: string }>
  settings: () => WebviewSettings
  sqliteProblem: string | null
  /** The form closed; `changed` when it saved something. */
  onClosed: (changed: boolean) => void
}

export class ConnectionFormPanel {
  readonly panel: vscode.WebviewPanel
  private readonly scope: FormScope
  private changed = false
  private disposed = false

  constructor(
    readonly key: string,
    private readonly editing: ConnectionConfig | null,
    private readonly engine: EngineId | null,
    private readonly deps: ConnectionFormDeps,
    onDispose: () => void
  ) {
    this.scope = new FormScope(editing)
    const title = editing ? `Editar · ${editing.name}` : 'Nueva conexión'
    this.panel = vscode.window.createWebviewPanel(
      'vortaq.connection',
      title,
      vscode.ViewColumn.Active,
      webviewOptions(deps.extensionUri)
    )
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(deps.extensionUri, 'media', 'vortaq-light.svg'),
      dark: vscode.Uri.joinPath(deps.extensionUri, 'media', 'vortaq-dark.svg')
    }
    this.panel.webview.html = webviewHtml(
      this.panel.webview,
      deps.extensionUri,
      'connection',
      title
    )
    this.panel.webview.onDidReceiveMessage((raw) => this.receive(raw))
    this.panel.onDidDispose(() => {
      this.disposed = true
      onDispose()
      deps.onClosed(this.changed)
    })
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  reveal(): void {
    this.panel.reveal()
  }

  private state(): ConnectionFormState {
    const problem = this.deps.sqliteProblem
    return {
      editing: this.editing,
      engine: this.engine,
      hiddenEngines: problem ? ['sqlite'] : [],
      sqliteProblem: problem,
      platform: process.platform,
      settings: this.deps.settings()
    }
  }

  private readonly postListeners = new Set<(message: HostMessage<ConnectionFormState>) => void>()

  /** Messages sent to the webview (the integration tests play the webview's part). */
  onDidPost(listener: (message: HostMessage<ConnectionFormState>) => void): { dispose(): void } {
    this.postListeners.add(listener)
    return { dispose: () => this.postListeners.delete(listener) }
  }

  private post(message: HostMessage<ConnectionFormState>): void {
    if (this.disposed) return
    for (const listener of this.postListeners) listener(message)
    void this.panel.webview.postMessage(message)
  }

  /** Message handler (public for the integration tests, which play the webview's part). */
  receive(raw: unknown): Promise<void> {
    return handleWebviewMessage(raw, {
      channels: CONNECTION_FORM_CHANNELS,
      local: {
        'app:pickFile': async (title, filters) => {
          const picked = await vscode.window.showOpenDialog({
            defaultUri: localHome(),
            title: typeof title === 'string' ? title : undefined,
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: dialogFilters(filters as FileFilters)
          })
          return localPath(picked?.[0])
        },
        'app:pickSaveFile': async (title, defaultName, filters) => {
          const home = localHome()
          const picked = await vscode.window.showSaveDialog({
            title: typeof title === 'string' ? title : undefined,
            defaultUri:
              typeof defaultName === 'string' && /^[^\\/]+$/.test(defaultName)
                ? vscode.Uri.joinPath(home, defaultName)
                : home,
            filters: dialogFilters(filters as FileFilters)
          })
          const path = localPath(picked)
          this.scope.savePathChosen(path)
          return path
        },
        'app:pickDirectory': async (title) => {
          const picked = await vscode.window.showOpenDialog({
            defaultUri: localHome(),
            title: typeof title === 'string' ? title : undefined,
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false
          })
          return localPath(picked?.[0])
        },
        'app:openPath': async (path) => {
          if (!this.scope.mayReveal(path))
            throw new Error('Esa carpeta no pertenece a esta conexión.')
          if (!(await stat(path).catch(() => null))?.isDirectory())
            throw new Error(`La carpeta ${path} no existe.`)
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path))
          return null
        }
      },
      scope: (channel, args) => this.scope.check(channel, args),
      after: (channel, _args, result) => {
        if (channel === 'connections:save') {
          this.scope.saved(result)
          this.changed = true
        }
        if (channel.startsWith('connections:set')) this.changed = true
      },
      invoke: this.deps.invoke,
      prepare: this.deps.prepare,
      post: (message) => this.post(message),
      onMessage: (message) => {
        switch (message.type) {
          case 'ready':
            this.post({ type: 'init', state: this.state() })
            return
          case 'close':
            this.panel.dispose()
            return
          case 'notify':
            showNotification(message.level, message.message)
            return
          default:
            return
        }
      }
    })
  }

  dispose(): void {
    this.panel.dispose()
  }
}
