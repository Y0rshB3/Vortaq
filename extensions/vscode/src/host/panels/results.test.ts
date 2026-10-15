/**
 * The results panel's «Exportar» wiring with a fake webview: app:pickSaveFile
 * answered by VS Code's save dialog, export:* reaching the core only for the
 * chosen file and the panel's own connection, and the core's event:progress
 * forwarded to the webview that started the export.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import type { ConnectionConfig, ProgressEvent } from '@core'
import type { ResultsState } from '../../webviewState'
import type { WriteGuard } from '../guard'
import { PICK_FIRST } from './exports'
import { ResultsPanels } from './results'

type FakePanel = InstanceType<typeof import('../../../test/vscode.mock').FakeWebviewPanel>

const win = vscode.window as unknown as Record<string, ReturnType<typeof vi.fn>>

const state = (connectionId = 'c1'): ResultsState => ({
  kind: 'sql',
  runId: 1,
  title: 'Resultados · ventas.sql',
  connection: { id: connectionId, name: 'Tienda', engine: 'sqlite' } as ConnectionConfig,
  target: 'main',
  platform: 'darwin',
  settings: {
    typedConfirmEnvironments: ['production'],
    confirmDestructiveEverywhere: true,
    defaultRowLimit: 1000
  },
  running: false,
  results: [],
  script: 'SELECT * FROM venta',
  context: null,
  totalMs: 3,
  notice: null,
  documents: null,
  canStop: false
})

function setup() {
  const core = vi.fn(async (channel: string, args: unknown[]) => {
    if (channel === 'export:rows')
      return {
        filePath: (args[0] as { filePath: string }).filePath,
        rows: 2,
        bytes: 9,
        durationMs: 1,
        truncatedCells: 0
      }
    if (channel === 'export:query') return new Promise(() => undefined)
    return null
  })
  const guard = {
    prepareWebviewCall: async (_channel: string, args: readonly unknown[]) => ({ args: [...args] })
  } as unknown as WriteGuard
  const panels = new ResultsPanels({
    extensionUri: vscode.Uri.file('/ext'),
    invoke: core,
    guard,
    settings: () => state().settings,
    onStop: () => undefined
  })
  const panel = panels.open('doc:ventas', state())
  const fake = panel.panel as unknown as FakePanel
  /** Plays the webview: an invoke, resolved with the host's `result` message. */
  async function invoke(channel: string, ...args: unknown[]) {
    const id = fake.posted.length + 1000
    await fake.fromWebview({ type: 'invoke', id, channel, args })
    return fake.posted.find(
      (m) =>
        (m as { type: string; id?: number }).type === 'result' && (m as { id: number }).id === id
    ) as { ok: boolean; value?: unknown; message?: string }
  }
  return { panels, panel, fake, core, invoke }
}

describe('results panel: «Exportar» wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    win.showInformationMessage.mockResolvedValue(undefined)
    win.withProgress.mockImplementation(() => Promise.resolve())
  })

  it('answers app:pickSaveFile with the save dialog, then writes only that file', async () => {
    const { invoke, core } = setup()
    win.showSaveDialog.mockResolvedValueOnce(vscode.Uri.file('/tmp/out/venta.csv'))
    const picked = await invoke('app:pickSaveFile', 'Exportar resultado', 'venta.csv', [
      { name: 'CSV', extensions: ['csv'] }
    ])
    expect(picked).toMatchObject({ ok: true, value: '/tmp/out/venta.csv' })
    expect(win.showSaveDialog.mock.calls[0][0].filters).toEqual({ CSV: ['csv'] })

    const request = {
      filePath: '/tmp/out/venta.csv',
      columns: [{ name: 'id' }],
      rows: [[1]],
      options: { format: 'csv' }
    }
    const refused = await invoke('export:rows', { ...request, filePath: '/tmp/out/otro.csv' })
    expect(refused).toMatchObject({ ok: false, message: PICK_FIRST })
    const written = await invoke('export:rows', request)
    expect(written).toMatchObject({ ok: true, value: { filePath: '/tmp/out/venta.csv', rows: 2 } })
    expect(core).toHaveBeenCalledWith('export:rows', [request])
    expect(core).toHaveBeenCalledTimes(1)
  })

  it('refuses another connection and never lets other app:* channels through', async () => {
    const { invoke, core } = setup()
    win.showSaveDialog.mockResolvedValueOnce(vscode.Uri.file('/tmp/out/x.csv'))
    await invoke('app:pickSaveFile', 't', 'x.csv')
    const other = await invoke('export:query', 'op1', {
      connectionId: 'c2',
      filePath: '/tmp/out/x.csv',
      source: { kind: 'statement', sql: 'SELECT 1' },
      options: { format: 'csv' }
    })
    expect(other).toMatchObject({
      ok: false,
      message: 'Esta vista solo trabaja con su propia conexión.'
    })
    expect(await invoke('app:showInFolder', '/tmp/out/x.csv')).toMatchObject({ ok: false })
    expect(await invoke('db:execute', 'c1', 'DELETE FROM venta')).toMatchObject({ ok: false })
    expect(core).not.toHaveBeenCalled()
  })

  it('forwards the export’s event:progress to its webview only', async () => {
    const { panels, fake, invoke } = setup()
    const other = panels.open('doc:otro', state())
    win.showSaveDialog.mockResolvedValueOnce(vscode.Uri.file('/tmp/out/full.csv'))
    await invoke('app:pickSaveFile', 't', 'full.csv')
    void fake.fromWebview({
      type: 'invoke',
      id: 1,
      channel: 'export:query',
      args: [
        'export-1',
        {
          connectionId: 'c1',
          filePath: '/tmp/out/full.csv',
          source: { kind: 'statement', sql: 'SELECT * FROM venta' },
          options: { format: 'csv' }
        }
      ]
    })
    await new Promise((r) => setTimeout(r, 0))
    const progress: ProgressEvent = {
      operationId: 'export-1',
      kind: 'export',
      phase: 'rows',
      current: 500,
      total: null,
      message: '500 filas escritas',
      done: false
    }
    expect(panels.progress(progress)).toBe(true)
    expect(panels.progress({ ...progress, operationId: 'backup-9', kind: 'backup' })).toBe(false)
    expect(fake.posted).toContainEqual({
      type: 'event',
      channel: 'event:progress',
      payload: progress
    })
    expect((other.panel as unknown as FakePanel).posted).toEqual([])
    expect(win.withProgress).toHaveBeenCalledTimes(1)
  })

  it('«Ver datos» panels keep their table for «Resultado completo»; a document run clears it', () => {
    const { panels } = setup()
    const data = panels.open('data:c1:main:venta', state(), {
      sql: 'SELECT * FROM "main"."venta" LIMIT 1000',
      schema: 'main',
      table: 'venta'
    })
    expect(data.exportTable?.table).toBe('venta')
    expect(panels.open('data:c1:main:venta', state()).exportTable).toBeNull()
  })
})
