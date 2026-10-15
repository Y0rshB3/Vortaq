import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import ConnectionDialog from '../dialogs/ConnectionDialog.vue'
import {
  calls,
  freshPinia,
  makeConnection,
  mockVortaq,
  mountWith,
  settle
} from '../dialogs/testing'

describe('ConnectionDialog › Agentes (MCP)', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null

  beforeEach(() => {
    invoke = mockVortaq({
      'connections:save': (input) =>
        makeConnection({
          ...(input as ConnectionInput),
          id: (input as { id?: string }).id ?? 'new-1'
        }),
      'connections:hasPassword': () => false,
      'connections:hasSshPassword': () => false
    })
  })
  afterEach(() => wrapper?.unmount())

  async function open(editing: ReturnType<typeof makeConnection> | null = null, props = {}) {
    const pinia = freshPinia()
    useSettingsStore().settings = { ...useSettingsStore().settings, mcpEnabled: true }
    useUiStore().connectionDialog = { open: true, editing }
    wrapper = mountWith(ConnectionDialog, pinia, { props })
    await settle()
    return wrapper
  }
  async function showTab() {
    await wrapper!.get('[data-test="conn-tab-mcp"]').trigger('click')
    await settle()
  }
  const radio = (level: string) =>
    wrapper!.get(`[data-test="conn-mcp-level-${level}"] input`).element as HTMLInputElement
  const savedInput = () => calls(invoke, 'connections:save').at(-1)?.[0] as ConnectionInput

  it('is off by default; enabling it starts at «Lectura» and saves the level', async () => {
    await open()
    await showTab()
    expect(wrapper!.get('[data-test="conn-mcp"]').text()).toContain('Desactivada')
    expect(radio('read').disabled).toBe(true)
    await wrapper!.get('[data-test="conn-mcp-enabled"] input').setValue(true)
    await settle()
    expect(radio('read').checked).toBe(true)
    expect(radio('write').disabled).toBe(false)
    await wrapper!.get('[data-test="conn-mcp-level-structure"] input').trigger('change')
    await wrapper!.get('[data-test="conn-name"] input').setValue('Local')
    await wrapper!.get('[data-test="conn-save"]').trigger('click')
    await settle()
    expect(savedInput().mcp).toEqual({ enabled: true, access: 'structure' })
  })

  it('a new connection saved without touching the section stays unavailable', async () => {
    await open()
    await wrapper!.get('[data-test="conn-name"] input').setValue('Local')
    await wrapper!.get('[data-test="conn-save"]').trigger('click')
    await settle()
    expect(savedInput().mcp).toBeUndefined()
  })

  it('«Lectura y escritura» is disabled on production, and lowered when the environment becomes production', async () => {
    await open(
      makeConnection({
        id: 'c1',
        name: 'Prod',
        environment: 'production',
        mcp: { enabled: true, access: 'read' }
      })
    )
    await showTab()
    expect(radio('write').disabled).toBe(true)
    expect(wrapper!.get('[data-test="conn-mcp-write-blocked"]').text()).toMatch(
      /no está disponible/
    )
    wrapper!.unmount()

    await open(
      makeConnection({
        id: 'c2',
        name: 'Local',
        environment: 'local',
        mcp: { enabled: true, access: 'write' }
      })
    )
    await showTab()
    expect(radio('write').checked).toBe(true)
    expect(wrapper!.find('[data-test="conn-mcp-write-blocked"]').exists()).toBe(false)
    // The environment changes to production (the General tab's select).
    const state = (wrapper!.vm as unknown as { $: { setupState: { form: ConnectionInput } } }).$
      .setupState
    state.form = { ...state.form, environment: 'production' }
    await settle()
    await showTab()
    expect(radio('read').checked).toBe(true)
    expect(radio('write').disabled).toBe(true)
    expect(wrapper!.get('[data-test="conn-mcp-write-blocked"]').text()).toMatch(
      /cambiado a «Lectura»/
    )
    await wrapper!.get('[data-test="conn-save"]').trigger('click')
    await settle()
    expect(savedInput().mcp).toEqual({ enabled: true, access: 'read' })
  })

  it('warns when Ajustes › Agentes (MCP) is off', async () => {
    await open(makeConnection({ id: 'c3', name: 'Otra', mcp: { enabled: true, access: 'read' } }))
    useSettingsStore().settings = { ...useSettingsStore().settings, mcpEnabled: false }
    await showTab()
    expect(wrapper!.get('[data-test="conn-mcp-global-off"]').text()).toContain(
      'Ajustes › Agentes (MCP)'
    )
  })

  it('the editor extension hides the section', async () => {
    await open(null, { hideMcp: true })
    expect(wrapper!.find('[data-test="conn-tab-mcp"]').exists()).toBe(false)
  })
})
