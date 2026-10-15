import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { VSelect } from 'vuetify/components'
import type { AppSettings, ConnectionConfig, ConnectionMcpConfig, McpLaunchInfo } from '@shared/types'
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
      'connections:setMcp': (id, mcp) => ({
        ...useConnectionsStore().get(id as string)!,
        mcp: mcp as ConnectionMcpConfig
      }),
      'settings:update': (patch) => ({
        ...useSettingsStore().settings,
        ...(patch as Partial<AppSettings>)
      })
    })
  })
  afterEach(() => wrapper?.unmount())

  async function mountDialog(
    settings: Partial<AppSettings> = {},
    items: ConnectionConfig[] | null = null
  ) {
    const pinia = freshPinia()
    useSettingsStore().settings = { ...useSettingsStore().settings, ...settings }
    useConnectionsStore().items = items ?? [
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

  const level = (w: ReturnType<typeof mountWith>, id: string) => {
    const found = w
      .findAllComponents(VSelect)
      .find((c) => c.attributes('data-test') === `settings-mcp-level-${id}`)
    if (!found) throw new Error(`no level select for ${id}`)
    return found
  }
  const switchOf = (w: ReturnType<typeof mountWith>, id: string) =>
    w.get(`[data-test="settings-mcp-switch-${id}"] input`).element as HTMLInputElement

  it('lists every saved connection with its own switch and level, and the privacy note', async () => {
    const w = await mountDialog({ mcpEnabled: true })
    const list = w.get('[data-test="settings-mcp-connections"]')
    expect(list.findAll('li')).toHaveLength(4)
    expect(w.get('[data-test="settings-mcp-count"]').text()).toBe('2 de 4 activadas')
    expect(w.get('[data-test="settings-mcp-conn-a"]').text()).toMatch(/Tienda.*SQLite.*Local/)
    expect(switchOf(w, 'a').checked).toBe(true)
    expect(level(w, 'a').props('modelValue')).toBe('read')
    // Off: the switch is off and the level cannot be changed until it is on.
    expect(switchOf(w, 'c').checked).toBe(false)
    expect(level(w, 'c').props('disabled')).toBe(true)
    expect(switchOf(w, 'd').checked).toBe(false)
    expect(level(w, 'd').props('modelValue')).toBe('read')
    // Saved with write, but production: marked, and «Lectura y escritura» cannot be picked.
    expect(w.get('[data-test="settings-mcp-level-b"]').classes()).toContain(
      'mcp-settings__level--blocked'
    )
    const prodItems = level(w, 'b').props('items') as { value: string; disabled: boolean }[]
    expect(prodItems.find((i) => i.value === 'write')?.disabled).toBe(true)
    const localItems = level(w, 'a').props('items') as { value: string; disabled: boolean }[]
    expect(localItems.every((i) => !i.disabled)).toBe(true)
    expect(w.get('[data-test="settings-mcp-write-note"]').text()).toMatch(/solo\s+pueden leer/)
    expect(w.get('[data-test="settings-mcp-privacy"]').text()).toMatch(
      /nunca envía la configuración de la conexión.*CURRENT_USER.*«Solo estructura» no se envía ningún resultado/
    )
  })

  it('stages switch and level changes and saves only the changed connections with «Guardar»', async () => {
    const w = await mountDialog({ mcpEnabled: true })
    await w.get('[data-test="settings-mcp-switch-d"] input').setValue(true)
    level(w, 'd').vm.$emit('update:modelValue', 'structure')
    await w.get('[data-test="settings-mcp-switch-a"] input').setValue(false)
    // Changed and changed back: nothing to save for this one.
    await w.get('[data-test="settings-mcp-switch-c"] input').setValue(true)
    await w.get('[data-test="settings-mcp-switch-c"] input').setValue(false)
    await settle()
    expect(w.get('[data-test="settings-mcp-count"]').text()).toBe('2 de 4 activadas')
    expect(calls(invoke, 'connections:setMcp')).toEqual([])

    await w.get('[data-test="settings-save"]').trigger('click')
    await settle()
    expect(calls(invoke, 'settings:update')).toHaveLength(1)
    expect(calls(invoke, 'connections:setMcp')).toEqual([
      ['d', { enabled: true, access: 'structure' }],
      ['a', { enabled: false, access: 'read' }]
    ])
    expect(useConnectionsStore().get('d')?.mcp).toEqual({ enabled: true, access: 'structure' })
    expect(useUiStore().settingsDialog).toBe(false)
  })

  it('refuses «Lectura y escritura» on an environment marked for typed confirmation in the same save', async () => {
    const w = await mountDialog({ mcpEnabled: true, typedConfirmEnvironments: ['production'] }, [
      makeConnection({ id: 's', name: 'Pruebas', environment: 'staging' })
    ])
    await w.get('[data-test="settings-mcp-switch-s"] input').setValue(true)
    level(w, 's').vm.$emit('update:modelValue', 'write')
    await settle()
    // Seguridad › staging also asks for the typed name now.
    await w.get('[data-test="settings-typed-env-staging"] input').setValue(true)
    await settle()
    const items = level(w, 's').props('items') as { value: string; disabled: boolean }[]
    expect(items.find((i) => i.value === 'write')?.disabled).toBe(true)
    await w.get('[data-test="settings-save"]').trigger('click')
    await settle()
    expect(w.text()).toMatch(/«Pruebas»: «Lectura y escritura» no está disponible/)
    expect(calls(invoke, 'settings:update')).toEqual([])
    expect(calls(invoke, 'connections:setMcp')).toEqual([])
  })

  it('«Cancelar» drops the staged changes', async () => {
    const w = await mountDialog({ mcpEnabled: true })
    await w.get('[data-test="settings-mcp-switch-d"] input').setValue(true)
    useUiStore().settingsDialog = false
    await settle()
    useUiStore().settingsDialog = true
    await settle()
    expect(switchOf(w, 'd').checked).toBe(false)
    expect(calls(invoke, 'connections:setMcp')).toEqual([])
  })

  it('without saved connections says so', async () => {
    const w = await mountDialog({ mcpEnabled: true }, [])
    expect(w.get('[data-test="settings-mcp-none"]').text()).toBe(
      'Todavía no tienes conexiones guardadas.'
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
