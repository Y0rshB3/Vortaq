import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ConnectionTree from './ConnectionTree.vue'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills,
  makeConnection,
  makeServerInfo
} from '@renderer/__tests__/shellTestUtils'

function mountTree() {
  return mount(ConnectionTree, {
    global: { plugins: [createTestVuetify()] },
    attachTo: document.body
  })
}

describe('ConnectionTree', () => {
  beforeEach(() => {
    installDomPolyfills()
    setActivePinia(createPinia())
  })

  it('renders one row per connection with its colour marker and environment chip', async () => {
    installBridge({
      'connections:list': [
        makeConnection({ id: 'p', name: 'Prod', color: '#ff5252', environment: 'production' }),
        makeConnection({ id: 'l', name: 'Local', color: null, environment: 'local' })
      ]
    })
    await useConnectionsStore().load()
    const wrapper = mountTree()
    await flush()

    const rows = wrapper.findAll('[data-test="tree-node-connection"]')
    expect(rows.map((r) => r.find('.tree-node__label').text())).toEqual(['Local', 'Prod'])

    const prod = rows[1]
    expect(prod.get('[data-test="connection-color"]').attributes('style')).toMatch(
      /background: (#ff5252|rgb\(255, 82, 82\))/
    )
    expect(prod.get('[data-test="env-chip"]').text()).toBe('Producción')
    expect(prod.get('.tree-node__row').classes()).toContain('tree-node__row--production')

    const local = rows[0]
    expect(local.get('[data-test="connection-color"]').attributes('style')).toContain('transparent')
    expect(local.get('[data-test="env-chip"]').text()).toBe('Local')
    wrapper.unmount()
  })

  it('marks connections that need the typed name with a lock; the red row stays production-only', async () => {
    installBridge({
      'connections:list': [
        makeConnection({ id: 'p', name: 'Prod', environment: 'production' }),
        makeConnection({ id: 's', name: 'Pre', environment: 'staging' }),
        makeConnection({ id: 'l', name: 'Local', environment: 'local' })
      ]
    })
    await useConnectionsStore().load()
    useSettingsStore().settings.typedConfirmEnvironments = ['production', 'staging']
    const wrapper = mountTree()
    await flush()
    const row = (name: string) =>
      wrapper
        .findAll('[data-test="tree-node-connection"]')
        .find((r) => r.find('.tree-node__label').text() === name)!
    expect(row('Pre').find('[data-test="env-lock"]').exists()).toBe(true)
    expect(row('Pre').get('[data-test="env-chip"]').attributes('title')).toContain(
      'requiere confirmación'
    )
    expect(row('Pre').get('.tree-node__row').classes()).not.toContain('tree-node__row--production')
    expect(row('Prod').find('[data-test="env-lock"]').exists()).toBe(true)
    expect(row('Prod').get('.tree-node__row').classes()).toContain('tree-node__row--production')
    expect(row('Local').find('[data-test="env-lock"]').exists()).toBe(false)
    expect(row('Local').get('[data-test="env-chip"]').attributes('title')).toBeUndefined()
    wrapper.unmount()
  })

  it('marks connections available to agents (MCP) with their effective level', async () => {
    installBridge({
      'connections:list': [
        makeConnection({ id: 'a', name: 'Agentes', mcp: { enabled: true, access: 'write' } }),
        makeConnection({
          id: 'p',
          name: 'Prod',
          environment: 'production',
          mcp: { enabled: true, access: 'write' }
        }),
        makeConnection({ id: 'o', name: 'Off', mcp: { enabled: false, access: 'read' } })
      ]
    })
    await useConnectionsStore().load()
    const wrapper = mountTree()
    await flush()
    const row = (name: string) =>
      wrapper
        .findAll('[data-test="tree-node-connection"]')
        .find((r) => r.find('.tree-node__label').text() === name)!
    expect(row('Agentes').get('[data-test="mcp-badge"]').attributes('title')).toBe(
      'Disponible para agentes (MCP): Lectura y escritura'
    )
    expect(row('Prod').get('[data-test="mcp-badge"]').attributes('title')).toBe(
      'Disponible para agentes (MCP): Lectura'
    )
    expect(row('Off').find('[data-test="mcp-badge"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows closed connections dimmed and open ones with their schemas after expanding', async () => {
    installBridge({
      'connections:list': [makeConnection({ id: 'c1', name: 'Dev' })],
      'connections:open': () => makeServerInfo(),
      'db:databases': () => [
        { name: 'shop', characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }
      ]
    })
    await useConnectionsStore().load()
    const wrapper = mountTree()
    await flush()
    const row = wrapper.get('[data-test="tree-node-connection"] .tree-node__row')
    expect(row.classes()).toContain('tree-node__row--closed')

    await row.trigger('dblclick')
    await flush()
    await flush()
    expect(
      wrapper.get('[data-test="tree-node-connection"] .tree-node__row').classes()
    ).not.toContain('tree-node__row--closed')
    expect(wrapper.find('[data-test="tree-node-schema"]').text()).toContain('shop')
    wrapper.unmount()
  })

  it('offers the import wizard when there are no connections', async () => {
    installBridge({ 'connections:list': [] })
    await useConnectionsStore().load()
    const wrapper = mountTree()
    await flush()
    await wrapper.get('[data-test="import-cta"]').trigger('click')
    expect(useUiStore().importWizard).toBe(true)
    expect(useUiStore().importDialog).toBe(false)
    wrapper.unmount()
  })
})
