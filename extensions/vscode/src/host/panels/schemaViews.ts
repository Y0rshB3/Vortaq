/**
 * «Diagrama de relaciones» and «Consulta gráfica» panels: the desktop
 * components (RelationshipDiagram, QueryBuilder) on one database or schema.
 * They read structure only (db:tables, db:tableStructure) of their own
 * connection and namespace; the image export is written by the host after
 * VS Code's save dialog; «Abrir datos» and «Abrir en consulta / Ejecutar»
 * become the extension's «Ver datos» and a new SQL document (run there,
 * through the runner and its guards). Nothing here writes to a database.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import * as vscode from 'vscode'
import { imageFileBytes, imageFileName, imageSavePath } from '@main/imageExport'
import type { DiagramImage, SchemaRef } from '@shared/types'
import type { HostMessage } from '../../protocol'
import type { SchemaViewState, WebviewSettings } from '../../webviewState'
import { handleWebviewMessage } from '../webview/bridge'
import { webviewHtml, webviewOptions } from '../webview/html'
import { showNotification } from './results'

/** Core channels a diagram or visual query may call: structure reads only. */
export const SCHEMA_CHANNELS: ReadonlySet<string> = new Set(['db:tables', 'db:tableStructure'])

const sameRef = (a: unknown, b: SchemaRef): boolean =>
  typeof b === 'string'
    ? a === b
    : !!a &&
      typeof a === 'object' &&
      (a as { database?: unknown }).database === b.database &&
      (a as { schema?: unknown }).schema === b.schema

/** Refuses a read of another connection or another database/schema than the panel's. */
export function schemaScope(state: SchemaViewState, args: readonly unknown[]): string | null {
  if (args[0] !== state.connection.id) return 'Esta vista solo trabaja con su propia conexión.'
  if (!sameRef(args[1], state.ref)) return 'Esta vista solo lee su propia base de datos o esquema.'
  return null
}

export interface SchemaDeps {
  extensionUri: vscode.Uri
  invoke: (channel: string, args: unknown[]) => Promise<unknown>
  prepare: (
    channel: string,
    args: readonly unknown[]
  ) => Promise<{ args: unknown[] } | { refused: string }>
  settings: () => WebviewSettings
  /** «Ver datos» of a table of the panel's namespace. */
  viewData: (state: SchemaViewState, table: string) => Promise<unknown>
  /** A new SQL document with `sql`, targeted at the panel's place (and run when `run`). */
  openSql: (state: SchemaViewState, sql: string, run: boolean) => Promise<unknown>
  /** VS Code's save dialog (the integration tests replace it). */
  pickSavePath?: (defaultName: string, format: DiagramImage['format']) => Promise<string | null>
}

async function vscodeSavePath(
  defaultName: string,
  format: DiagramImage['format']
): Promise<string | null> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir()
  const uri = await vscode.window.showSaveDialog({
    title: 'Exportar diagrama',
    defaultUri: vscode.Uri.file(join(folder, defaultName)),
    filters: { [format.toUpperCase()]: [format] }
  })
  return uri?.fsPath ?? null
}

export class SchemaPanel {
  readonly panel: vscode.WebviewPanel
  private ready = false
  private disposed = false

  constructor(
    readonly key: string,
    public state: SchemaViewState,
    private readonly deps: SchemaDeps,
    onDispose: () => void
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'vortaq.schema',
      state.title,
      vscode.ViewColumn.Active,
      // Hand-placed tables and a half-built query survive switching tabs.
      { ...webviewOptions(deps.extensionUri), retainContextWhenHidden: true }
    )
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(deps.extensionUri, 'media', 'vortaq-light.svg'),
      dark: vscode.Uri.joinPath(deps.extensionUri, 'media', 'vortaq-dark.svg')
    }
    this.panel.webview.html = webviewHtml(
      this.panel.webview,
      deps.extensionUri,
      'schema',
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

  reveal(): void {
    this.panel.reveal()
  }

  private readonly postListeners = new Set<(message: HostMessage<SchemaViewState>) => void>()

  /** Messages sent to the webview (the integration tests play the webview's part). */
  onDidPost(listener: (message: HostMessage<SchemaViewState>) => void): { dispose(): void } {
    this.postListeners.add(listener)
    return { dispose: () => this.postListeners.delete(listener) }
  }

  private post(message: HostMessage<SchemaViewState>): void {
    if (this.disposed) return
    for (const listener of this.postListeners) listener(message)
    void this.panel.webview.postMessage(message)
  }

  /** «Exportar»: checks the image, asks where with VS Code's dialog and writes it. */
  async saveImage(defaultName: unknown, image: unknown): Promise<string | null> {
    const bytes = imageFileBytes(image)
    const format = (image as DiagramImage).format
    const pick = this.deps.pickSavePath ?? vscodeSavePath
    const chosen = await pick(imageFileName(String(defaultName ?? ''), format), format)
    if (!chosen) return null
    const path = imageSavePath(chosen, format)
    await writeFile(path, bytes)
    return path
  }

  /** Handles a message from the webview (public for the integration tests). */
  receive(raw: unknown): Promise<void> {
    return handleWebviewMessage(raw, {
      channels: SCHEMA_CHANNELS,
      local: { 'app:saveImage': (name, image) => this.saveImage(name, image) },
      scope: (channel, args) =>
        channel === 'app:saveImage' ? null : schemaScope(this.state, args),
      invoke: this.deps.invoke,
      prepare: this.deps.prepare,
      post: (message) => this.post(message),
      onMessage: async (message) => {
        switch (message.type) {
          case 'ready':
            this.ready = true
            this.state = { ...this.state, settings: this.deps.settings() }
            this.post({ type: 'init', state: this.state })
            return
          case 'notify':
            showNotification(message.level, message.message)
            return
          case 'clipboard':
            await vscode.env.clipboard.writeText(message.text)
            vscode.window.setStatusBarMessage(
              `$(check) ${message.label ?? 'Copiado al portapapeles'}`,
              4000
            )
            return
          case 'openData':
            await this.deps.viewData(this.state, message.table)
            return
          case 'openSql':
            await this.deps.openSql(this.state, message.sql, message.run)
            return
          default:
            return
        }
      }
    })
  }

  get isReady(): boolean {
    return this.ready
  }

  dispose(): void {
    this.panel.dispose()
  }
}

export class SchemaPanels implements vscode.Disposable {
  private readonly panels = new Map<string, SchemaPanel>()
  private seq = 0

  constructor(private readonly deps: SchemaDeps) {}

  /** The diagram of a namespace is one panel; each «Consulta gráfica» is a new one. */
  open(state: SchemaViewState): SchemaPanel {
    const where =
      typeof state.ref === 'string' ? state.ref : `${state.ref.database}.${state.ref.schema}`
    const key =
      state.kind === 'diagram'
        ? `diagram:${state.connection.id}:${where}`
        : `builder:${state.connection.id}:${where}:${++this.seq}`
    const existing = this.panels.get(key)
    if (existing && !existing.isDisposed) {
      existing.reveal()
      return existing
    }
    const panel = new SchemaPanel(key, state, this.deps, () => this.panels.delete(key))
    this.panels.set(key, panel)
    return panel
  }

  /** Panels of a connection (closed when it is deleted). */
  forConnection(connectionId: string): SchemaPanel[] {
    return [...this.panels.values()].filter((p) => p.state.connection.id === connectionId)
  }

  dispose(): void {
    for (const p of this.panels.values()) p.dispose()
    this.panels.clear()
  }
}
