import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import type { ConnectionConfig, McpHttpEndpoint, VortaqCore } from '@core'
import type { McpService } from './mcp'
import {
  managerItems,
  pickConnectionLevel,
  showConnectionMcp,
  showMcpManager,
  type McpManagerDeps
} from './mcpManager'

function conn(
  id: string,
  name: string,
  environment: ConnectionConfig['environment'],
  mcp?: ConnectionConfig['mcp']
): ConnectionConfig {
  return { id, name, engine: 'mysql', environment, ...(mcp ? { mcp } : {}) } as ConnectionConfig
}

const tienda = conn('c1', 'Tienda', 'local', { enabled: true, access: 'read' })
const prod = conn('c2', 'Ventas', 'production', { enabled: true, access: 'write' })
const nueva = conn('c3', 'Nueva', 'local')

function deps(options: { enabled: boolean; endpoint: McpHttpEndpoint | null }) {
  const settings = { mcpEnabled: options.enabled, typedConfirmEnvironments: ['production'] }
  const saved = new Map([tienda, prod, nueva].map((c) => [c.id, c]))
  const core = {
    context: {
      settings: { get: () => settings },
      connections: { get: (id: string) => saved.get(id) ?? null }
    },
    invoke: vi.fn(async (channel: string, id: string, mcp: ConnectionConfig['mcp']) => {
      if (channel === 'connections:setMcp') saved.set(id, { ...saved.get(id)!, mcp })
    })
  } as unknown as VortaqCore & { invoke: ReturnType<typeof vi.fn> }
  const service = {
    endpoint: () => options.endpoint,
    describe: () => 'Servidor MCP en http://127.0.0.1:39291/mcp (esta ventana).',
    refresh: vi.fn(async () => undefined),
    regenerateKey: vi.fn(async () => undefined)
  } as unknown as McpService
  const result: McpManagerDeps & { core: typeof core } = {
    core,
    service,
    connections: async () => [...saved.values()],
    setEnabled: vi.fn(async (on: boolean) => {
      settings.mcpEnabled = on
    }),
    changed: vi.fn()
  }
  return result
}

const ENDPOINT = { url: 'http://127.0.0.1:39291/mcp', key: 'k1', platform: 'darwin' }
const pick = vi.mocked(vscode.window.showQuickPick)

describe('«Vortaq: Agentes (MCP)…»', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists the switch, every connection with its effective level and the clients', () => {
    const d = deps({ enabled: false, endpoint: null })
    const items = managerItems(d, [tienda, prod, nueva])
    expect(items[0]).toMatchObject({ description: 'desactivado', action: { kind: 'toggle' } })
    expect(items[1].label).toBe('Conexiones para agentes (2 de 3 activadas)')
    const rows = items.filter((i) => i.action?.kind === 'connection')
    expect(rows.map((r) => [r.label, r.description])).toEqual([
      ['$(pass-filled) Tienda', 'MySQL · Lectura'],
      ['$(pass-filled) Ventas', 'MySQL · Lectura'],
      ['$(circle-large-outline) Nueva', 'MySQL · desactivada']
    ])
    // Saved with write on production: the list says agents only read there.
    expect(rows[1].detail).toMatch(/solo pueden leer/)
    // Nothing to copy while no server answers.
    expect(items.some((i) => i.action?.kind === 'copy')).toBe(false)

    const on = managerItems(deps({ enabled: true, endpoint: ENDPOINT }), [tienda])
    expect(on[0].detail).toContain('http://127.0.0.1:39291/mcp')
    expect(on.some((i) => i.action?.kind === 'copy')).toBe(true)
    expect(on.some((i) => i.action?.kind === 'key')).toBe(true)
  })

  it('saves a level with connections:setMcp and never offers write where the name is typed', async () => {
    const d = deps({ enabled: true, endpoint: ENDPOINT })
    pick.mockImplementationOnce(async (items) => {
      const labels = (items as vscode.QuickPickItem[]).map((i) => i.label)
      expect(labels).toEqual(['Desactivada', 'Solo estructura', 'Lectura'])
      return (items as vscode.QuickPickItem[])[1]
    })
    expect(await pickConnectionLevel(d, prod)).toBe(true)
    expect(d.core.invoke).toHaveBeenCalledWith('connections:setMcp', 'c2', {
      enabled: true,
      access: 'structure'
    })
    expect(d.changed).toHaveBeenCalled()

    pick.mockImplementationOnce(async (items) => {
      const list = items as (vscode.QuickPickItem & { config: unknown })[]
      expect(list.map((i) => i.label)).toContain('Lectura y escritura')
      expect(list.find((i) => i.label === 'Lectura')?.description).toBe('actual')
      return list.find((i) => i.label === 'Lectura')
    })
    // Picking the saved level changes nothing.
    expect(await pickConnectionLevel(d, tienda)).toBe(false)
  })

  it('turns agents on from the list and copies a client configuration with the key', async () => {
    const d = deps({ enabled: false, endpoint: ENDPOINT })
    pick
      .mockImplementationOnce(async (items) => (items as vscode.QuickPickItem[])[0])
      .mockImplementationOnce(async (items) =>
        (items as (vscode.QuickPickItem & { action?: { kind: string } })[]).find(
          (i) => i.action?.kind === 'copy'
        )
      )
      .mockImplementationOnce(async (items) =>
        (items as vscode.QuickPickItem[]).find((i) => i.label === 'Claude Code')
      )
    await showMcpManager(d)
    expect(d.setEnabled).toHaveBeenCalledWith(true)
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
      'claude mcp add --transport http vortaq http://127.0.0.1:39291/mcp --header "Authorization: Bearer k1"'
    )
    expect(vi.mocked(vscode.window.showInformationMessage).mock.calls.at(-1)?.[0]).toMatch(
      /Configuración de Claude Code copiada/
    )
  })

  it('regenerates the key only after the modal confirmation', async () => {
    const d = deps({ enabled: true, endpoint: ENDPOINT })
    const keyItem = async (items: unknown) =>
      (items as (vscode.QuickPickItem & { action?: { kind: string } })[]).find(
        (i) => i.action?.kind === 'key'
      )
    pick.mockImplementationOnce(keyItem).mockImplementationOnce(keyItem)
    vi.mocked(vscode.window.showWarningMessage)
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce('Regenerar' as never)
    await showMcpManager(d)
    expect(d.service.regenerateKey).toHaveBeenCalledTimes(1)
  })

  it('offers to turn agents on after enabling a connection from the tree', async () => {
    const d = deps({ enabled: false, endpoint: null })
    pick.mockImplementationOnce(async (items) =>
      (items as vscode.QuickPickItem[]).find((i) => i.label === 'Lectura')
    )
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      'Activar agentes' as never
    )
    await showConnectionMcp(d, nueva)
    expect(d.core.invoke).toHaveBeenCalledWith('connections:setMcp', 'c3', {
      enabled: true,
      access: 'read'
    })
    expect(d.setEnabled).toHaveBeenCalledWith(true)
  })
})
