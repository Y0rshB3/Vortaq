/**
 * The diagram / visual query panel with a fake webview: structure reads only,
 * of its own connection and namespace; the image written after VS Code's save
 * dialog (only a real PNG or SVG); «Abrir datos» and «Abrir en consulta /
 * Ejecutar» handed to the extension.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import type { ConnectionConfig } from '@core'
import type { SchemaViewState } from '../../webviewState'
import { SchemaPanels, schemaScope } from './schemaViews'

type FakePanel = InstanceType<typeof import('../../../test/vscode.mock').FakeWebviewPanel>

const state = (kind: SchemaViewState['kind'] = 'diagram'): SchemaViewState => ({
  kind,
  title: 'Diagrama · app.ventas (Tienda)',
  connection: { id: 'c1', name: 'Tienda', engine: 'postgresql' } as ConnectionConfig,
  ref: { database: 'app', schema: 'ventas' },
  namespace: 'ventas',
  platform: 'darwin',
  settings: {
    typedConfirmEnvironments: ['production'],
    confirmDestructiveEverywhere: true,
    defaultRowLimit: 1000
  }
})

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(kind: SchemaViewState['kind'] = 'diagram') {
  const dir = mkdtempSync(join(tmpdir(), 'vortaq-schema-'))
  dirs.push(dir)
  const core = vi.fn(async (channel: string) =>
    channel === 'db:tables' ? [{ name: 'pedidos' }] : null
  )
  const viewData = vi.fn(async () => undefined)
  const openSql = vi.fn(async () => undefined)
  const pickSavePath = vi.fn(async (name: string) => join(dir, name.replace(/\.(png|svg)$/, '')))
  const panels = new SchemaPanels({
    extensionUri: vscode.Uri.file('/ext'),
    invoke: core,
    prepare: async (_channel, args) => ({ args: [...args] }),
    settings: () => state().settings,
    viewData,
    openSql,
    pickSavePath
  })
  const panel = panels.open(state(kind))
  const fake = panel.panel as unknown as FakePanel
  async function invoke(channel: string, ...args: unknown[]) {
    const id = fake.posted.length + 1000
    await fake.fromWebview({ type: 'invoke', id, channel, args })
    return fake.posted.find(
      (m) =>
        (m as { type: string; id?: number }).type === 'result' && (m as { id: number }).id === id
    ) as { ok: boolean; value?: unknown; message?: string }
  }
  return { panels, panel, fake, core, invoke, viewData, openSql, pickSavePath, dir }
}

describe('diagram / visual query panel', () => {
  it('reads only the structure of its own connection and namespace', async () => {
    const { invoke, core } = setup()
    expect(await invoke('db:tables', 'c1', { database: 'app', schema: 'ventas' })).toMatchObject({
      ok: true,
      value: [{ name: 'pedidos' }]
    })
    expect(await invoke('db:tables', 'c2', { database: 'app', schema: 'ventas' })).toMatchObject({
      ok: false,
      message: 'Esta vista solo trabaja con su propia conexión.'
    })
    expect(
      await invoke('db:tableStructure', 'c1', { database: 'app', schema: 'otro' }, 't')
    ).toMatchObject({
      ok: false,
      message: 'Esta vista solo lee su propia base de datos o esquema.'
    })
    for (const channel of ['db:tableData', 'db:execute', 'db:applyRowChanges', 'connections:list'])
      expect((await invoke(channel, 'c1', { database: 'app', schema: 'ventas' })).ok).toBe(false)
    expect(core.mock.calls.map((c) => c[0])).toEqual(['db:tables'])
    expect(schemaScope({ ...state(), ref: 'tienda' }, ['c1', 'tienda'])).toBeNull()
    expect(
      schemaScope({ ...state(), ref: 'tienda' }, ['c1', { database: 'tienda', schema: 'x' }])
    ).not.toBeNull()
  })

  it("writes the exported image where VS Code's dialog says, only a real PNG or SVG", async () => {
    const { invoke, pickSavePath, dir } = setup()
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    const saved = await invoke('app:saveImage', 'diagrama-ventas', { format: 'svg', data: svg })
    expect(saved).toMatchObject({ ok: true, value: join(dir, 'diagrama-ventas.svg') })
    expect(pickSavePath).toHaveBeenCalledWith('diagrama-ventas.svg', 'svg')
    expect(readFileSync(join(dir, 'diagrama-ventas.svg'), 'utf8')).toBe(svg)
    expect(
      await invoke('app:saveImage', 'x', {
        format: 'png',
        data: Buffer.from('MZ').toString('base64')
      })
    ).toMatchObject({ ok: false, message: 'La imagen PNG no es válida.' })
    expect(pickSavePath).toHaveBeenCalledTimes(1)
  })

  it('hands «Abrir datos» and «Abrir en consulta / Ejecutar» to the extension', async () => {
    const { fake, viewData, openSql } = setup('queryBuilder')
    await fake.fromWebview({ type: 'openData', table: 'pedidos' })
    expect(viewData).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'ventas' }),
      'pedidos'
    )
    await fake.fromWebview({ type: 'openSql', sql: 'SELECT 1;\n', run: true })
    expect(openSql).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'queryBuilder' }),
      'SELECT 1;\n',
      true
    )
    await fake.fromWebview({ type: 'openSql', sql: '', run: true })
    expect(openSql).toHaveBeenCalledTimes(1)
  })

  it('one diagram per namespace; every visual query is a new panel', () => {
    const { panels, panel } = setup()
    expect(panels.open(state())).toBe(panel)
    const a = panels.open(state('queryBuilder'))
    const b = panels.open(state('queryBuilder'))
    expect(a).not.toBe(b)
    expect(panels.forConnection('c1')).toHaveLength(3)
    expect(panels.forConnection('c2')).toHaveLength(0)
  })
})
