/**
 * «Exportar» in the results panels (docs/vscode-extension-design.md, 9.9).
 * The webview runs the desktop app's ExportDialog unchanged: it asks for a
 * file with app:pickSaveFile (VS Code's save dialog here) and then calls
 * export:rows, export:query or export:cancel, which reach the core's export
 * service (src/main/export: written through `<file>.part` and renamed when
 * complete; «Resultado completo» re-reads in a new read-only session; MongoDB
 * refused).
 *
 * The webview is untrusted, so each panel:
 * - writes only a file the user has just chosen in that panel's save dialog
 *   (each choice is good for one export);
 * - exports only its own connection, and cancels only the exports it started;
 * - in a «Ver datos» panel, «Resultado completo» reads the whole table: the
 *   panel's own `SELECT … LIMIT n` becomes the table source, as in the
 *   desktop table view.
 *
 * Progress (event:progress, kind 'export') goes to the panel's webview (the
 * operations strip and the dialog) and to a VS Code progress notification
 * with «Cancelar»; a finished export is a notification with «Abrir» and
 * «Mostrar en carpeta», and a failure shows the service's message.
 */
import { basename, dirname } from 'node:path'
import * as vscode from 'vscode'
import type {
  ExportQueryRequest,
  ExportResult,
  ExportRowsRequest,
  ProgressEvent,
  SchemaRef
} from '@core'
import { CANCELLED_EXPORT } from '@core'
import { dialogFilters, localHome, localPath, safeFileName, type FileFilters } from './dialogs'

export const EXPORT_CHANNELS: ReadonlySet<string> = new Set([
  'export:rows',
  'export:query',
  'export:cancel'
])

export const PICK_FIRST =
  'Elige primero dónde guardar el archivo: pulsa «Exportar…» en el diálogo de exportación.'
export const OTHER_CONNECTION = 'Esta vista solo trabaja con su propia conexión.'
export const NOT_MINE = 'Esa exportación no se inició en esta vista.'

export const OPEN = 'Abrir'
export const REVEAL = 'Mostrar en carpeta'

/** «Ver datos»: the statement the panel ran and the table it reads. */
export interface ExportTable {
  sql: string
  schema: SchemaRef
  table: string
}

interface Operation {
  /** The webview of the panel that started it (gone when the panel closed). */
  post: ((event: ProgressEvent) => void) | null
  report: ((message: string) => void) | null
  /** A progress event reached the panel: its webview leaves the outcome to the host. */
  sawEvent: boolean
  last: ProgressEvent | null
}

/**
 * The running exports of every results panel, so the core's event:progress
 * reaches the panel (and the progress notification) of its operation, plus the
 * folder of the last export as the next save dialog's default.
 */
export class ExportOperations {
  private readonly running = new Map<string, Operation>()
  lastFolder: string | null = null
  /** VS Code's save dialog; the integration suite replaces it (a real dialog would wait). */
  showSaveDialog = (options: vscode.SaveDialogOptions): Thenable<vscode.Uri | undefined> =>
    vscode.window.showSaveDialog(options)

  start(id: string, post: (event: ProgressEvent) => void): Operation {
    const op: Operation = { post, report: null, sawEvent: false, last: null }
    this.running.set(id, op)
    return op
  }

  finish(id: string): void {
    this.running.delete(id)
  }

  has(id: string): boolean {
    return this.running.has(id)
  }

  /** A core event:progress; true when it belonged to a running export. */
  dispatch(event: ProgressEvent): boolean {
    if (event?.kind !== 'export') return false
    const op = this.running.get(event.operationId)
    if (!op) return false
    op.last = event
    if (op.post) {
      op.sawEvent = true
      op.post(event)
    }
    if (!event.done) op.report?.(event.message)
    return true
  }

  /** The panel closed: its exports keep running (the notification still offers «Cancelar»). */
  detach(post: (event: ProgressEvent) => void): void {
    for (const op of this.running.values()) if (op.post === post) op.post = null
  }
}

export interface PanelExportsDeps {
  /** The panel's connection id (the only one it may export). */
  connectionId: () => string
  /** «Ver datos» panels: the table «Resultado completo» reads whole. */
  table: () => ExportTable | null
  /** core.invoke. */
  invoke: (channel: string, args: unknown[]) => Promise<unknown>
  /** Posts an event:progress to the panel's webview. */
  postProgress: (event: ProgressEvent) => void
  operations: ExportOperations
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** The export side of one results panel: save dialog, scope checks, progress and outcome. */
export class PanelExports {
  /** Files chosen in this panel's save dialog and not used yet. */
  private readonly picked = new Set<string>()
  /** Operation ids this panel started and that are still running. */
  private readonly mine = new Set<string>()

  constructor(private readonly deps: PanelExportsDeps) {}

  /** app:pickSaveFile: VS Code's save dialog, in the last export folder or the workspace. */
  async pickSaveFile(
    title: unknown,
    defaultName: unknown,
    filters: unknown
  ): Promise<string | null> {
    const folder = this.deps.operations.lastFolder
      ? vscode.Uri.file(this.deps.operations.lastFolder)
      : localHome()
    const name = safeFileName(defaultName)
    const picked = await this.deps.operations.showSaveDialog({
      title: typeof title === 'string' ? title : 'Exportar resultado',
      saveLabel: 'Exportar',
      defaultUri: name ? vscode.Uri.joinPath(folder, name) : folder,
      filters: dialogFilters(filters as FileFilters)
    })
    const path = localPath(picked)
    if (path) this.picked.add(path)
    return path
  }

  /** Scope of an export:* call from the webview; a message refuses it. */
  check(channel: string, args: readonly unknown[]): string | null {
    if (channel === 'export:rows') {
      const request = args[0]
      return isRecord(request) && this.picked.has(request.filePath as string) ? null : PICK_FIRST
    }
    if (channel === 'export:query') {
      const [operationId, request] = args
      if (typeof operationId !== 'string' || !operationId || !isRecord(request))
        return 'Petición de exportación no válida.'
      if (request.connectionId !== this.deps.connectionId()) return OTHER_CONNECTION
      return this.picked.has(request.filePath as string) ? null : PICK_FIRST
    }
    if (channel === 'export:cancel')
      return typeof args[0] === 'string' && this.mine.has(args[0]) ? null : NOT_MINE
    return null
  }

  /** Runs an export:* call the scope check allowed. */
  async invoke(channel: string, args: unknown[]): Promise<unknown> {
    if (channel === 'export:rows') return this.rows(args[0] as ExportRowsRequest)
    if (channel === 'export:query')
      return this.query(args[0] as string, args[1] as ExportQueryRequest)
    if (channel === 'export:cancel') return this.deps.invoke('export:cancel', [args[0]])
    throw new Error('Esta vista no puede usar esa operación.')
  }

  private use(filePath: string): void {
    this.picked.delete(filePath)
    this.deps.operations.lastFolder = dirname(filePath)
  }

  private async rows(request: ExportRowsRequest): Promise<ExportResult> {
    this.use(request.filePath)
    // A failure stays in the dialog (it shows the message and stays open).
    const result = (await this.deps.invoke('export:rows', [request])) as ExportResult
    void showExported(result)
    return result
  }

  /** «Ver datos»: its own statement becomes the whole table (no LIMIT), like the desktop. */
  private withTableSource(request: ExportQueryRequest): ExportQueryRequest {
    const table = this.deps.table()
    const source = request.source
    if (!table || source?.kind !== 'statement' || source.sql?.trim() !== table.sql.trim())
      return request
    return {
      ...request,
      source: {
        kind: 'table',
        request: { schema: table.schema, table: table.table, orderBy: null }
      }
    }
  }

  private async query(operationId: string, request: ExportQueryRequest): Promise<ExportResult> {
    this.use(request.filePath)
    const { operations } = this.deps
    const op = operations.start(operationId, this.deps.postProgress)
    this.mine.add(operationId)
    const run = this.deps.invoke('export:query', [operationId, this.withTableSource(request)])
    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Exportando a ${basename(request.filePath)}`,
        cancellable: true
      },
      (progress, token) => {
        op.report = (message) => progress.report({ message })
        token.onCancellationRequested(() => {
          if (operations.has(operationId))
            void this.deps.invoke('export:cancel', [operationId]).catch(() => undefined)
        })
        return run.then(
          () => undefined,
          () => undefined
        )
      }
    )
    try {
      const result = (await run) as ExportResult
      void showExported(result)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (op.last?.phase === 'cancelled' || message === CANCELLED_EXPORT)
        vscode.window.setStatusBarMessage(`$(circle-slash) ${CANCELLED_EXPORT}`, 6000)
      // Without any progress event the webview shows the error itself (ExportDialog).
      else if (op.sawEvent || !op.post) void vscode.window.showErrorMessage(message)
      throw err
    } finally {
      operations.finish(operationId)
      this.mine.delete(operationId)
    }
  }

  /** The panel closed: running exports go on, without a webview to report to. */
  dispose(): void {
    this.deps.operations.detach(this.deps.postProgress)
  }
}

/** Opens an exported file: Excel and HTML in the system's app, the rest in the editor. */
export async function openExported(filePath: string): Promise<void> {
  const uri = vscode.Uri.file(filePath)
  if (/\.(xlsx|html?)$/i.test(filePath)) await vscode.env.openExternal(uri)
  else await vscode.commands.executeCommand('vscode.open', uri)
}

/** 12.345 (Spanish thousands separator, as in the desktop messages). */
const count = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

/** «N filas exportadas a x.csv» with «Abrir» and «Mostrar en carpeta». */
export async function showExported(result: ExportResult): Promise<void> {
  const rows = result.rows
  const choice = await vscode.window.showInformationMessage(
    `${count(rows)} ${rows === 1 ? 'fila exportada' : 'filas exportadas'} a ${basename(result.filePath)}`,
    OPEN,
    REVEAL
  )
  if (choice === OPEN) await openExported(result.filePath)
  else if (choice === REVEAL)
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.filePath))
}
