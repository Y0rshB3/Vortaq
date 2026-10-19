/**
 * The diagram / visual query webview in jsdom with a fake host: the desktop
 * components read structure through the bridge, and «Abrir datos», «Abrir en
 * consulta» and «Ejecutar» become messages for the host (never a query here).
 */
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VortaqApi } from '@shared/ipc'
import type { ConnectionConfig } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { SHOP, shopTables } from '@renderer/views/__tests__/diagramFixtures'
import { mountComponent, setupDom } from '@renderer/views/__tests__/helpers'
import type { WebviewMessage } from '../../protocol'
import type { SchemaViewState } from '../../webviewState'
import type { WebviewHost } from '../bridge'
import SchemaApp from './SchemaApp.vue'

const connection = {
  id: 'c1',
  name: 'Tienda',
  environment: 'local',
  engine: 'mysql'
} as ConnectionConfig
const state = (kind: SchemaViewState['kind']): SchemaViewState => ({
  kind,
  title: 'Diagrama · shop (Tienda)',
  connection,
  ref: 'shop',
  namespace: 'shop',
  platform: 'darwin',
  settings: {
    typedConfirmEnvironments: ['production'],
    confirmDestructiveEverywhere: true,
    defaultRowLimit: 1000
  }
})

function fakeHost(initial: SchemaViewState) {
  const posted: WebviewMessage[] = []
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:tables') return shopTables()
    if (channel === 'db:tableStructure') return structuredClone(SHOP[args[2] as string])
    throw new Error(`Esta vista no puede usar esa operación (${channel}).`)
  })
  const api = { platform: 'darwin', invoke, on: () => () => undefined } as unknown as VortaqApi
  const host: WebviewHost<SchemaViewState> = {
    api,
    post: (message) => posted.push(message),
    confirm: async () => true,
    ready: async () => initial,
    onState: () => undefined
  }
  return { host, posted, invoke }
}

describe('extension diagram / visual query webview', () => {
  let wrapper: Awaited<ReturnType<typeof mountComponent>> | null = null
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })
  afterEach(() => wrapper?.unmount())

  async function mount(kind: SchemaViewState['kind']) {
    const pinia = setupDom()
    const initial = state(kind)
    const fake = fakeHost(initial)
    window.vortaq = fake.host.api
    useConnectionsStore().items = [connection]
    wrapper = await mountComponent(SchemaApp, { host: fake.host, initial }, pinia)
    await flushPromises()
    return { w: wrapper, ...fake }
  }

  it('draws the diagram from structure reads; double-click asks the host to open the data', async () => {
    const { w, posted, invoke } = await mount('diagram')
    expect(new Set(invoke.mock.calls.map((c) => c[0]))).toEqual(
      new Set(['db:tables', 'db:tableStructure'])
    )
    expect(w.findAll('[data-test^="dbox-head-"]')).toHaveLength(4)
    await w.get('[data-test="dbox-head-orders"]').trigger('dblclick')
    expect(posted).toContainEqual({ type: 'openData', table: 'orders' })
    // No designer in the editor: the table menu offers only «Abrir datos».
    await w.get('[data-test="dbox-head-orders"]').trigger('contextmenu')
    await flushPromises()
    expect(document.body.querySelector('[data-test="menu-design"]')).toBeNull()
    expect(document.body.querySelector('[data-test="menu-open"]')).not.toBeNull()
  })

  it('the visual query hands its SELECT to the host to open or run', async () => {
    const { w, posted } = await mount('queryBuilder')
    await w.get('[data-test="qb-table-customers"]').trigger('click')
    await flushPromises()
    await w.get('[data-test="qb-open"]').trigger('click')
    await w.get('[data-test="qb-run"]').trigger('click')
    expect(posted).toEqual([
      { type: 'openSql', sql: 'SELECT\n  *\nFROM `customers`;\n', run: false },
      { type: 'openSql', sql: 'SELECT\n  *\nFROM `customers`;\n', run: true }
    ])
  })
})
