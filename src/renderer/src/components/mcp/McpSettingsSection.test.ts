import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { AppSettings, McpLaunchInfo } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import SettingsDialog from '../dialogs/SettingsDialog.vue'
import {
  calls,
  freshPinia,
  makeConnection,
  mockVortaq,
  mountWith,
  settle
} from '../dialogs/testing'

const LAUNCH: McpLaunchInfo = {
  command: '/Applications/Vortaq.app/Contents/MacOS/Vortaq',
  args: ['--mcp'],
  platform: 'darwin',
  packaged: true
}

describe('Ajustes › Agentes (MCP)', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null
  let launch: McpLaunchInfo

  beforeEach(() => {
    launch = LAUNCH
    invoke = mockVortaq({
      'app:info': () => ({ version: '2.1.0' }),
      'app:mcpLaunch': () => launch,
      'ai:providers': () => [],
      'settings:update': (patch) => ({
        ...useSettingsStore().settings,
        ...(patch as Partial<AppSettings>)
      })
    })
  })
  afterEach(() => wrapper?.unmount())

  async function mountDialog(settings: Partial<AppSettings> = {}) {
    const pinia = freshPinia()
    useSettingsStore().settings = { ...useSettingsStore().settings, ...settings }
    useConnectionsStore().items = [
      makeConnection({
        id: 'a',
        name: 'Tienda',
        engine: 'sqlite',
        mcp: { enabled: true, access: 'read' }
      }),
      makeConnection({
        id: 'b',
        name: 'Ventas',
        environment: 'production',
        mcp: { enabled: true, access: 'write' }
      }),
      makeConnection({ id: 'c', name: 'Privada', mcp: { enabled: false, access: 'write' } }),
      makeConnection({ id: 'd', name: 'Sin ajuste' })
    ]
    useUiStore().settingsDialog = true
    wrapper = mountWith(SettingsDialog, pinia)
    await settle()
    return wrapper
  }

  it('the master switch is off by default and is saved with «Guardar»', async () => {
    const w = await mountDialog({ mcpEnabled: false })
    const toggle = w.get('[data-test="settings-mcp-enabled"] input').element as HTMLInputElement
    expect(toggle.checked).toBe(false)
    await w.get('[data-test="settings-mcp-enabled"] input').setValue(true)
    await w.get('[data-test="settings-save"]').trigger('click')
    await settle()
    expect((calls(invoke, 'settings:update')[0][0] as AppSettings).mcpEnabled).toBe(true)
  })

  it('lists only the connections available to agents, with the effective level and the privacy note', async () => {
    const w = await mountDialog({ mcpEnabled: true })
    const list = w.get('[data-test="settings-mcp-connections"]')
    expect(list.findAll('li')).toHaveLength(2)
    expect(w.get('[data-test="settings-mcp-conn-a"]').text()).toMatch(/Tienda.*SQLite.*Lectura/)
    // Saved with write, but production: agents only read.
    const ventas = w.get('[data-test="settings-mcp-conn-b"]').text()
    expect(ventas).toMatch(/Ventas.*Producción.*Lectura/)
    expect(ventas).not.toMatch(/escritura/)
    expect(list.text()).not.toMatch(/Privada|Sin ajuste/)
    expect(w.get('[data-test="settings-mcp-privacy"]').text()).toMatch(
      /nunca envía la configuración de la conexión.*CURRENT_USER.*«Solo estructura» no se envía ningún resultado/
    )
  })

  it('builds each client snippet from the real executable and copies it', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const w = await mountDialog({ mcpEnabled: true })
    const snippet = () => w.get('[data-test="settings-mcp-snippet"]').text()
    expect(snippet()).toBe(
      'claude mcp add vortaq -- "/Applications/Vortaq.app/Contents/MacOS/Vortaq" --mcp'
    )
    await w.get('[data-test="settings-mcp-client-claudeDesktop"]').trigger('click')
    expect(JSON.parse(snippet())).toEqual({
      mcpServers: { vortaq: { command: LAUNCH.command, args: ['--mcp'] } }
    })
    expect(w.text()).toContain('~/Library/Application Support/Claude/claude_desktop_config.json')
    await w.get('[data-test="settings-mcp-client-cursor"]').trigger('click')
    expect(JSON.parse(snippet()).mcpServers.vortaq).toMatchObject({
      type: 'stdio',
      command: LAUNCH.command
    })
    await w.get('[data-test="settings-mcp-client-vscode"]').trigger('click')
    expect(JSON.parse(snippet())).toEqual({
      servers: { vortaq: { type: 'stdio', command: LAUNCH.command, args: ['--mcp'] } }
    })
    await w.get('[data-test="settings-mcp-copy"]').trigger('click')
    await settle()
    expect(writeText).toHaveBeenCalledWith(snippet())
  })

  it('a development copy shows Electron plus the source folder', async () => {
    launch = {
      command: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      args: ['/repo', '--mcp'],
      platform: 'darwin',
      packaged: false
    }
    const w = await mountDialog({ mcpEnabled: true })
    expect(w.get('[data-test="settings-mcp-snippet"]').text()).toBe(
      'claude mcp add vortaq -- "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" /repo --mcp'
    )
    expect(w.get('[data-test="settings-mcp-dev"]').text()).toMatch(/Copia de desarrollo/)
  })
})
