import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { CANCELLED_EXPORT, type ExportResult, type ProgressEvent } from '@core'
import {
  ExportOperations,
  NOT_MINE,
  OPEN,
  OTHER_CONNECTION,
  PanelExports,
  PICK_FIRST,
  REVEAL,
  type ExportTable
} from './exports'

const win = vscode.window as unknown as Record<string, ReturnType<typeof vi.fn>>
const commands = vscode.commands as unknown as { executeCommand: ReturnType<typeof vi.fn> }
const env = vscode.env as unknown as { openExternal: ReturnType<typeof vi.fn> }
const workspace = vscode.workspace as unknown as { workspaceFolders: unknown }

const options = { format: 'csv' } as never
const done = (filePath: string, rows = 3): ExportResult => ({
  filePath,
  rows,
  bytes: 10,
  durationMs: 1,
  truncatedCells: 0
})
const event = (operationId: string, patch: Partial<ProgressEvent> = {}): ProgressEvent => ({
  operationId,
  kind: 'export',
  phase: 'rows',
  current: 500,
  total: null,
  message: '500 filas escritas',
  done: false,
  ...patch
})

/** Lets the pending promise chains (withProgress callbacks, notifications) run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

interface Harness {
  exports: PanelExports
  operations: ExportOperations
  invoke: ReturnType<typeof vi.fn>
  posted: ProgressEvent[]
  table: { value: ExportTable | null }
}

function harness(
  invokeImpl: (channel: string, args: unknown[]) => unknown = () => undefined,
  operations = new ExportOperations()
): Harness {
  const posted: ProgressEvent[] = []
  const table = { value: null as ExportTable | null }
  const invoke = vi.fn(async (channel: string, args: unknown[]) => invokeImpl(channel, args))
  const exports = new PanelExports({
    connectionId: () => 'c1',
    table: () => table.value,
    invoke,
    postProgress: (e) => posted.push(e),
    operations
  })
  return { exports, operations, invoke, posted, table }
}

/** The progress notification's task, with a fake reporter and cancellation token. */
function captureProgress(): {
  report: ReturnType<typeof vi.fn>
  cancel: () => void
  options: () => Record<string, unknown>
} {
  const report = vi.fn()
  let onCancel: () => void = () => undefined
  let opts: Record<string, unknown> = {}
  type Task = (
    progress: { report: (value: { message?: string }) => void },
    token: { onCancellationRequested: (fn: () => void) => { dispose(): void } }
  ) => unknown
  win.withProgress.mockImplementation((o: Record<string, unknown>, task: Task) => {
    opts = o
    return task(
      { report },
      { onCancellationRequested: (fn: () => void) => ((onCancel = fn), { dispose() {} }) }
    )
  })
  return { report, cancel: () => onCancel(), options: () => opts }
}

async function pick(h: Harness, path: string): Promise<void> {
  win.showSaveDialog.mockResolvedValueOnce(vscode.Uri.file(path))
  expect(await h.exports.pickSaveFile('Exportar resultado', 'x.csv', [])).toBe(path)
}

describe('results panel exports: save dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workspace.workspaceFolders = undefined
  })

  it('opens VS Code’s save dialog with the format filter, in the workspace folder', async () => {
    workspace.workspaceFolders = [{ uri: vscode.Uri.file('/proyecto') }]
    win.showSaveDialog.mockResolvedValueOnce(vscode.Uri.file('/proyecto/ventas.xlsx'))
    const h = harness()
    const path = await h.exports.pickSaveFile('Exportar resultado', 'ventas.xlsx', [
      { name: 'Libro de Excel', extensions: ['xlsx'] }
    ])
    expect(path).toBe('/proyecto/ventas.xlsx')
    const [opts] = win.showSaveDialog.mock.calls[0]
    expect(opts.title).toBe('Exportar resultado')
    expect(opts.saveLabel).toBe('Exportar')
    expect(opts.filters).toEqual({ 'Libro de Excel': ['xlsx'] })
    expect(opts.defaultUri.fsPath).toBe('/proyecto/ventas.xlsx')
  })

  it('falls back to the home folder, then remembers the folder of the last export', async () => {
    const h = harness((channel, args) =>
      channel === 'export:rows' ? done((args[0] as { filePath: string }).filePath) : undefined
    )
    win.showSaveDialog.mockResolvedValueOnce(vscode.Uri.file('/datos/out/a.csv'))
    await h.exports.pickSaveFile('t', 'a.csv', [])
    expect(win.showSaveDialog.mock.calls[0][0].defaultUri.fsPath).toBe(join(homedir(), 'a.csv'))
    win.showInformationMessage.mockResolvedValue(undefined)
    await h.exports.invoke('export:rows', [{ filePath: '/datos/out/a.csv', options }])
    win.showSaveDialog.mockResolvedValueOnce(undefined)
    expect(await h.exports.pickSaveFile('t', 'b:/c?.csv', [])).toBeNull()
    // The proposed name loses the characters a file name cannot have.
    expect(win.showSaveDialog.mock.calls[1][0].defaultUri.fsPath).toBe('/datos/out/b__c_.csv')
  })

  it('refuses a file of a remote file system', async () => {
    win.showSaveDialog.mockResolvedValueOnce(
      vscode.Uri.from({ scheme: 'vscode-remote', path: '/x.csv' })
    )
    await expect(harness().exports.pickSaveFile('t', 'x.csv', [])).rejects.toThrow(/este equipo/)
  })
})

describe('results panel exports: scope', () => {
  beforeEach(() => vi.clearAllMocks())

  it('writes only the file just chosen in this panel’s save dialog, once', async () => {
    const h = harness((_c, args) => done((args[0] as { filePath: string }).filePath))
    win.showInformationMessage.mockResolvedValue(undefined)
    const rows = { filePath: '/tmp/out/sel.csv', columns: [], rows: [], options }
    expect(h.exports.check('export:rows', [rows])).toBe(PICK_FIRST)
    await pick(h, '/tmp/out/sel.csv')
    expect(h.exports.check('export:rows', [{ ...rows, filePath: '/etc/passwd' }])).toBe(PICK_FIRST)
    expect(h.exports.check('export:rows', [rows])).toBeNull()
    await h.exports.invoke('export:rows', [rows])
    expect(h.invoke).toHaveBeenCalledWith('export:rows', [rows])
    // Used: a second write needs a new choice, also when both passed the bridge's check.
    expect(h.exports.check('export:rows', [rows])).toBe(PICK_FIRST)
    await expect(h.exports.invoke('export:rows', [rows])).rejects.toThrow(PICK_FIRST)
    expect(h.invoke).toHaveBeenCalledTimes(1)
  })

  it('exports only its own connection and cancels only its own exports', async () => {
    const h = harness()
    await pick(h, '/tmp/out/full.csv')
    const request = (connectionId: string) => ({
      connectionId,
      filePath: '/tmp/out/full.csv',
      source: { kind: 'statement', sql: 'SELECT 1' },
      options
    })
    expect(h.exports.check('export:query', ['op1', request('c2')])).toBe(OTHER_CONNECTION)
    expect(h.exports.check('export:query', ['', request('c1')])).toMatch(/no válida/)
    expect(h.exports.check('export:query', ['op1', request('c1')])).toBeNull()
    expect(h.exports.check('export:cancel', ['op-de-otra-vista'])).toBe(NOT_MINE)
  })
})

describe('results panel exports: progress and outcome', () => {
  let resolveRun: (value: unknown) => void
  let rejectRun: (err: Error) => void

  beforeEach(() => {
    vi.clearAllMocks()
    win.showInformationMessage.mockResolvedValue(undefined)
  })
  afterEach(() => win.withProgress.mockReset())

  function queryHarness(operations = new ExportOperations()): Harness {
    return harness((channel) => {
      if (channel === 'export:query')
        return new Promise((resolve, reject) => {
          resolveRun = resolve
          rejectRun = reject
        })
      return undefined
    }, operations)
  }

  const query = (filePath: string, sql = 'SELECT * FROM venta') => ({
    connectionId: 'c1',
    filePath,
    source: { kind: 'statement' as const, sql },
    options
  })

  it('forwards progress to the webview and the notification; «Cancelar» cancels the export', async () => {
    const progress = captureProgress()
    const h = queryHarness()
    await pick(h, '/tmp/out/ventas.csv')
    const running = h.exports.invoke('export:query', ['op1', query('/tmp/out/ventas.csv')])
    await tick()
    expect(progress.options()).toMatchObject({
      location: vscode.ProgressLocation.Notification,
      cancellable: true,
      title: 'Exportando a ventas.csv'
    })
    // The webview may now cancel it too.
    expect(h.exports.check('export:cancel', ['op1'])).toBeNull()
    expect(h.operations.dispatch(event('op1'))).toBe(true)
    expect(h.operations.dispatch(event('op1', { kind: 'backup' }))).toBe(false)
    expect(h.operations.dispatch(event('otra'))).toBe(false)
    expect(h.posted).toEqual([event('op1')])
    expect(progress.report).toHaveBeenCalledWith({ message: '500 filas escritas' })

    progress.cancel()
    expect(h.invoke).toHaveBeenCalledWith('export:cancel', ['op1'])
    h.operations.dispatch(
      event('op1', {
        phase: 'cancelled',
        done: true,
        error: CANCELLED_EXPORT,
        message: CANCELLED_EXPORT
      })
    )
    rejectRun(new Error(CANCELLED_EXPORT))
    await expect(running).rejects.toThrow(CANCELLED_EXPORT)
    expect(win.setStatusBarMessage).toHaveBeenCalledWith(
      expect.stringContaining(CANCELLED_EXPORT),
      expect.any(Number)
    )
    expect(win.showErrorMessage).not.toHaveBeenCalled()
    expect(h.exports.check('export:cancel', ['op1'])).toBe(NOT_MINE)
    expect(h.operations.has('op1')).toBe(false)
  })

  it('announces the file with «Abrir» and «Mostrar en carpeta»', async () => {
    captureProgress()
    const h = queryHarness()
    await pick(h, '/tmp/out/ventas.csv')
    win.showInformationMessage.mockResolvedValueOnce(REVEAL)
    const running = h.exports.invoke('export:query', ['op2', query('/tmp/out/ventas.csv')])
    await tick()
    resolveRun(done('/tmp/out/ventas.csv', 12345))
    expect(await running).toEqual(done('/tmp/out/ventas.csv', 12345))
    await tick()
    expect(win.showInformationMessage).toHaveBeenCalledWith(
      '12.345 filas exportadas a ventas.csv',
      OPEN,
      REVEAL
    )
    expect(commands.executeCommand).toHaveBeenCalledWith(
      'revealFileInOS',
      vscode.Uri.file('/tmp/out/ventas.csv')
    )
  })

  it('«Abrir» opens text formats in the editor and Excel in the system app', async () => {
    const h = harness((_c, args) => done((args[0] as { filePath: string }).filePath, 1))
    await pick(h, '/tmp/out/uno.json')
    win.showInformationMessage.mockResolvedValueOnce(OPEN)
    await h.exports.invoke('export:rows', [{ filePath: '/tmp/out/uno.json', options }])
    await tick()
    expect(win.showInformationMessage).toHaveBeenCalledWith(
      '1 fila exportada a uno.json',
      OPEN,
      REVEAL
    )
    expect(commands.executeCommand).toHaveBeenCalledWith(
      'vscode.open',
      vscode.Uri.file('/tmp/out/uno.json')
    )
    await pick(h, '/tmp/out/libro.xlsx')
    win.showInformationMessage.mockResolvedValueOnce(OPEN)
    await h.exports.invoke('export:rows', [{ filePath: '/tmp/out/libro.xlsx', options }])
    await tick()
    expect(env.openExternal).toHaveBeenCalledWith(vscode.Uri.file('/tmp/out/libro.xlsx'))
  })

  it('shows the service’s message once: the host after progress, the webview before', async () => {
    captureProgress()
    const h = queryHarness()
    await pick(h, '/tmp/out/a.csv')
    const failing = h.exports.invoke('export:query', ['op3', query('/tmp/out/a.csv')])
    await tick()
    h.operations.dispatch(event('op3', { phase: 'list', current: 0 }))
    const message = 'La consulta podría modificar datos: exporta las filas cargadas.'
    rejectRun(new Error(message))
    await expect(failing).rejects.toThrow(message)
    expect(win.showErrorMessage).toHaveBeenCalledWith(message)

    // Refused before any progress event: the webview's dialog shows it (no second notice).
    win.showErrorMessage.mockClear()
    await pick(h, '/tmp/out/b.csv')
    const early = h.exports.invoke('export:query', ['op4', query('/tmp/out/b.csv')])
    await tick()
    rejectRun(new Error('Ya hay una exportación en curso con ese identificador.'))
    await expect(early).rejects.toThrow(/en curso/)
    expect(win.showErrorMessage).not.toHaveBeenCalled()
  })

  it('«Ver datos»: the full export reads the whole table, not the first rows', async () => {
    captureProgress()
    const h = queryHarness()
    const sql = 'SELECT * FROM `tienda`.`venta` LIMIT 1000'
    h.table.value = { sql, schema: 'tienda', table: 'venta' }
    await pick(h, '/tmp/out/venta.csv')
    const running = h.exports.invoke('export:query', ['op5', query('/tmp/out/venta.csv', sql)])
    await tick()
    expect(h.invoke.mock.calls[0]).toEqual([
      'export:query',
      [
        'op5',
        {
          ...query('/tmp/out/venta.csv'),
          source: { kind: 'table', request: { schema: 'tienda', table: 'venta', orderBy: null } }
        }
      ]
    ])
    resolveRun(done('/tmp/out/venta.csv'))
    await running
    // Another statement of the same panel is exported as written.
    await pick(h, '/tmp/out/otra.csv')
    const other = h.exports.invoke('export:query', [
      'op6',
      query('/tmp/out/otra.csv', 'SELECT id FROM venta')
    ])
    await tick()
    expect((h.invoke.mock.calls.at(-1)![1] as unknown[])[1]).toMatchObject({
      source: { kind: 'statement', sql: 'SELECT id FROM venta' }
    })
    resolveRun(done('/tmp/out/otra.csv'))
    await other
  })

  it('a closed panel’s export goes on; its errors are shown by the host', async () => {
    captureProgress()
    const operations = new ExportOperations()
    const h = queryHarness(operations)
    await pick(h, '/tmp/out/c.csv')
    const running = h.exports.invoke('export:query', ['op7', query('/tmp/out/c.csv')])
    await tick()
    h.exports.dispose()
    expect(operations.dispatch(event('op7'))).toBe(true)
    expect(h.posted).toEqual([])
    rejectRun(new Error('No queda espacio en el disco para el archivo.'))
    await expect(running).rejects.toThrow(/espacio/)
    expect(win.showErrorMessage).toHaveBeenCalledWith(
      'No queda espacio en el disco para el archivo.'
    )
  })
})
