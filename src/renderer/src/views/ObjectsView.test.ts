import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ObjectsView from './ObjectsView.vue'
import { formatNumber } from '@renderer/utils/format'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTabsStore } from '@renderer/stores/tabs'
import { nodeIds, useTreeStore } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills,
  makeConnection,
  makeServerInfo,
  makeTable,
  type MockBridge
} from '@renderer/__tests__/shellTestUtils'

function mountView() {
  const tab = useTabsStore().tabs[0]
  return mount(ObjectsView, {
    props: { tab },
    global: { plugins: [createTestVuetify()] },
    attachTo: document.body
  })
}

describe('ObjectsView', () => {
  let bridge: MockBridge

  beforeEach(() => {
    installDomPolyfills()
    setActivePinia(createPinia())
    bridge = installBridge({
      'connections:list': [makeConnection({ id: 'c1', name: 'Dev' })],
      'connections:open': () => makeServerInfo(),
      'db:databases': () => [
        { name: 'shop', characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' },
        { name: 'crm', characterSet: 'latin1', collation: 'latin1_swedish_ci' }
      ],
      'db:tables': () => [
        makeTable('users', { rows: 1234, engine: 'InnoDB', comment: 'Usuarios' }),
        makeTable('orders', { rows: 5, engine: 'MyISAM' })
      ]
    })
  })

  it('shows the import wizard CTA when there are no connections', async () => {
    installBridge({ 'connections:list': [] })
    await useConnectionsStore().load()
    const wrapper = mountView()
    await flush()
    expect(wrapper.text()).toContain('Importa tus conexiones')
    expect(wrapper.text()).toContain('DBeaver')
    await wrapper.get('[data-test="objects-import-cta"]').trigger('click')
    expect(useUiStore().importWizard).toBe(true)
    wrapper.unmount()
  })

  it('lists the tables of the selected schema with Navicat columns', async () => {
    const connections = useConnectionsStore()
    await connections.load()
    await connections.open('c1')
    const tree = useTreeStore()
    tree.select(nodeIds.group('c1', 'shop', 'tables'))
    const wrapper = mountView()
    await flush()
    await flush()

    expect(bridge.invoke).toHaveBeenCalledWith('db:tables', 'c1', 'shop')
    const headers = wrapper.findAll('th').map((h) => h.text())
    expect(headers).toEqual([
      'Nombre',
      'Filas',
      'Longitud de datos',
      'Motor',
      'Fecha de creación',
      'Fecha de modificación',
      'Intercalación',
      'Comentario'
    ])
    const rows = wrapper.findAll('[data-test="data-list-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('users')
    expect(rows[0].text()).toContain(formatNumber(1234))
    expect(rows[0].text()).toContain('Usuarios')
    expect(rows[1].text()).toContain('MyISAM')
    wrapper.unmount()
  })

  it('selecting a row selects the object node and enables the open action', async () => {
    const connections = useConnectionsStore()
    await connections.load()
    await connections.open('c1')
    const tree = useTreeStore()
    tree.select(nodeIds.schema('c1', 'shop'))
    const wrapper = mountView()
    await flush()
    await flush()

    expect(wrapper.get('[data-test="objects-open"]').attributes('disabled')).toBeDefined()
    await wrapper.findAll('[data-test="data-list-row"]')[1].trigger('click')
    expect(tree.selectedId).toBe(nodeIds.object('c1', 'shop', 'tables', 'orders'))
    expect(wrapper.get('[data-test="objects-open"]').attributes('disabled')).toBeUndefined()

    await wrapper.findAll('[data-test="data-list-row"]')[1].trigger('dblclick')
    const active = useTabsStore().active
    expect(active.kind).toBe('tableData')
    expect(active.title).toBe('orders@shop (Dev)')
    wrapper.unmount()
  })

  it('filters by the search box', async () => {
    const connections = useConnectionsStore()
    await connections.load()
    await connections.open('c1')
    useTreeStore().select(nodeIds.group('c1', 'shop', 'tables'))
    const wrapper = mountView()
    await flush()
    await wrapper.get('[data-test="objects-search"] input').setValue('ord')
    const rows = wrapper.findAll('[data-test="data-list-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('orders')
    wrapper.unmount()
  })

  it('lists databases when a connection node is selected', async () => {
    const connections = useConnectionsStore()
    await connections.load()
    await connections.open('c1')
    useTreeStore().select(nodeIds.connection('c1'))
    const wrapper = mountView()
    await flush()
    await flush()
    expect(wrapper.findAll('th').map((h) => h.text())).toEqual([
      'Nombre',
      'Juego de caracteres',
      'Intercalación'
    ])
    expect(wrapper.findAll('[data-test="data-list-row"]').map((r) => r.find('td').text())).toEqual([
      'shop',
      'crm'
    ])
    wrapper.unmount()
  })

  it('opens the relationship diagram or the visual query of the database in context', async () => {
    const connections = useConnectionsStore()
    await connections.load()
    await connections.open('c1')
    const tree = useTreeStore()
    tree.select(nodeIds.connection('c1'))
    const wrapper = mountView()
    await flush()
    await flush()
    // A database list needs a selected row.
    expect(wrapper.get('[data-test="objects-diagram"]').attributes('disabled')).toBeDefined()
    await wrapper.findAll('[data-test="data-list-row"]')[1].trigger('click')
    await wrapper.get('[data-test="objects-diagram"]').trigger('click')
    const tabs = useTabsStore()
    expect(tabs.active).toMatchObject({ kind: 'diagram', connectionId: 'c1', schema: 'crm' })

    tabs.activate('objects')
    tree.select(nodeIds.group('c1', 'shop', 'tables'))
    await flush()
    await wrapper.get('[data-test="objects-query-builder"]').trigger('click')
    expect(tabs.active).toMatchObject({ kind: 'queryBuilder', connectionId: 'c1', schema: 'shop' })
    wrapper.unmount()
  })

  it('offers to open a closed connection', async () => {
    await useConnectionsStore().load()
    useTreeStore().select(nodeIds.connection('c1'))
    const wrapper = mountView()
    await flush()
    expect(wrapper.text()).toContain('Conexión cerrada')
    await wrapper.get('[data-test="objects-connect"]').trigger('click')
    await flush()
    expect(bridge.invoke).toHaveBeenCalledWith('connections:open', 'c1')
    wrapper.unmount()
  })
})
