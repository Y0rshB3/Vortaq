/**
 * Results panels: one webview per SQL document (reused by every run of that
 * document), per table opened with «Ver datos» and per collection opened with
 * «Ver documentos». The webview renders the desktop app's result components
 * (messages, editable result grid); its edits reach the core through the
 * bridge, limited to the panel's own connection, and every write is
 * confirmed by the WriteGuard.
 */
import * as vscode from 'vscode'
import type { HostMessage } from '../../protocol'
import type { ResultsState, WebviewSettings } from '../../webviewState'
import { confirmDetail, handleWebviewMessage } from '../webview/bridge'
import { webviewHtml, webviewOptions } from '../webview/html'
import type { WriteGuard } from '../guard'

/** Core channels a results webview may call (EditableResult: editability check and Aplicar). */
export const RESULTS_CHANNELS: ReadonlySet<string> = new Set([
  'db:tableStructure',
  'db:applyRowChanges'
])

export interface ResultsDeps {
  extensionUri: vscode.Uri
  invoke: (channel: string, args: unknown[]) => Promise<unknown>
  guard: WriteGuard
  settings: () => WebviewSettings
  onStop: (key: string) => void
  /** Called after the webview applied row changes (the tree may show new counts). */
  onApplied?: (key: string) => void
}

export class ResultsPanel {
  readonly panel: vscode.WebviewPanel
  private ready = false
  private disposed = false
  /** The webview holds unapplied row edits. */
  dirty = false

  constructor(
    readonly key: string,
    public state: ResultsState,
    private readonly deps: ResultsDeps,
    onDispose: () => void
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'vortaq.results',
      state.title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // Unapplied edits must survive switching tabs.
      { ...webviewOptions(deps.extensionUri), retainContextWhenHidden: true }
    )
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(deps.extensionUri, 'media', 'vortaq-light.svg'),
      dark: vscode.Uri.joinPath(deps.extensionUri, 'media', 'vortaq-dark.svg')
    }
    this.panel.webview.html = webviewHtml(
      this.panel.webview,
      deps.extensionUri,
      'results',
      state.title
    )
    this.panel.webview.onDidReceiveMessage((raw) => this.receive(raw))
    this.panel.onDidDispose(() => {
      this.disposed = true
      onDispose()
    })
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Replaces part of the state and sends it to the webview (once it is ready). */
  update(patch: Partial<ResultsState>): void {
    this.state = { ...this.state, ...patch, settings: this.deps.settings() }
    if (patch.title) this.panel.title = patch.title
    if (this.ready) this.post({ type: 'state', state: this.state })
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true)
  }

  private readonly postListeners = new Set<(message: HostMessage<ResultsState>) => void>()

  /** Messages sent to the webview (the integration tests play the webview's part). */
  onDidPost(listener: (message: HostMessage<ResultsState>) => void): { dispose(): void } {
    this.postListeners.add(listener)
    return { dispose: () => this.postListeners.delete(listener) }
  }

  private post(message: HostMessage<ResultsState>): void {
    if (this.disposed) return
    for (const listener of this.postListeners) listener(message)
    void this.panel.webview.postMessage(message)
  }

  /** Handles a message from the webview (public for the integration tests). */
  receive(raw: unknown): Promise<void> {
    return handleWebviewMessage(raw, {
      channels: RESULTS_CHANNELS,
      // Only the connection this panel shows.
      scope: (_channel, args) =>
        args[0] === this.state.connection.id
          ? null
          : 'Esta vista solo trabaja con su propia conexión.',
      after: (channel) => {
        if (channel === 'db:applyRowChanges') this.deps.onApplied?.(this.key)
      },
      invoke: this.deps.invoke,
      prepare: (channel, args) => this.deps.guard.prepareWebviewCall(channel, args),
      post: (message) => this.post(message),
      onMessage: async (message) => {
        switch (message.type) {
          case 'ready':
            this.ready = true
            this.state = { ...this.state, settings: this.deps.settings() }
            this.post({ type: 'init', state: this.state })
            return
          case 'dirty':
            this.dirty = message.dirty
            return
          case 'stop':
            this.deps.onStop(this.key)
            return
          case 'clipboard':
            await vscode.env.clipboard.writeText(message.text)
            vscode.window.setStatusBarMessage(
              `$(check) ${message.label ?? 'Copiado al portapapeles'}`,
              4000
            )
            return
          case 'confirm': {
            const request = message.request
            const confirmText = request.notice ? 'Aceptar' : (request.confirmText ?? 'Confirmar')
            const answer = await vscode.window.showWarningMessage(
              request.title,
              { modal: true, detail: confirmDetail(request) },
              confirmText
            )
            this.post({ type: 'confirmResult', id: message.id, ok: answer === confirmText })
            return
          }
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

export function showNotification(
  level: 'success' | 'info' | 'warning' | 'error',
  text: string
): void {
  if (level === 'error') void vscode.window.showErrorMessage(text)
  else if (level === 'warning') void vscode.window.showWarningMessage(text)
  else void vscode.window.showInformationMessage(text)
}

export class ResultsPanels implements vscode.Disposable {
  private readonly panels = new Map<string, ResultsPanel>()

  constructor(private readonly deps: ResultsDeps) {}

  get(key: string): ResultsPanel | undefined {
    return this.panels.get(key)
  }

  /**
   * Before a new run replaces the results of `key`: true when there is nothing to lose or
   * the user chose to discard the unapplied edits.
   */
  async mayReplace(key: string): Promise<boolean> {
    const panel = this.panels.get(key)
    if (!panel || panel.isDisposed || !panel.dirty) return true
    const discard = 'Descartar y ejecutar'
    const answer = await vscode.window.showWarningMessage(
      'Cambios sin aplicar',
      {
        modal: true,
        detail:
          'Hay cambios sin aplicar en los resultados. Si vuelves a ejecutar la consulta se descartarán.'
      },
      discard
    )
    return answer === discard
  }

  /** The panel of `key`, created with `initial` when it does not exist (or was closed). */
  open(key: string, initial: ResultsState): ResultsPanel {
    const existing = this.panels.get(key)
    if (existing && !existing.isDisposed) {
      existing.update(initial)
      existing.reveal()
      return existing
    }
    const panel = new ResultsPanel(key, initial, this.deps, () => this.panels.delete(key))
    this.panels.set(key, panel)
    return panel
  }

  /** Panels of a connection (closed when it is deleted). */
  forConnection(connectionId: string): ResultsPanel[] {
    return [...this.panels.values()].filter((p) => p.state.connection.id === connectionId)
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose()
    this.panels.clear()
  }
}
