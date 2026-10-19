import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTabsStore } from '@renderer/stores/tabs'
import { nodeIds, useTreeStore } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import {
  installBridge,
  makeConnection,
  makeServerInfo,
  makeTable,
  type MockBridge
} from '@renderer/__tests__/shellTestUtils'
import { useWorkspace } from './useWorkspace'
import { useObjectActions } from './useObjectActions'

describe('useWorkspace context resolution', () => {
  let bridge: MockBridge

  beforeEach(async () => {
    setActivePinia(createPinia())
    bridge = installBridge({
      'connections:list': [
        makeConnection({ id: 'a', name: 'Alpha', environment: 'production' }),
        makeConnection({ id: 'b', name: 'Beta' })
      ],
      'connections:open': () => makeServerInfo(),
      'db:databases': () => [{ name: 'shop', characterSet: 'utf8mb4', collation: 'x' }],
      'db:tables': () => [makeTable('users')]
    })
    await useConnectionsStore().load()
  })

  it('does not pick an arbitrary connection when several exist and nothing is selected', () => {
    const ws = useWorkspace()
    const tabs = useTabsStore()
    expect(ws.currentConnectionId()).toBeNull()
    ws.openQuery()
    expect(tabs.tabs.map((t) => t.kind)).toEqual(['objects'])
  })

  it('focuses the tab of a query saved with "Guardar como" instead of opening another', () => {
    const ws = useWorkspace()
    const tabs = useTabsStore()
    ws.openQuery('a', 'shop')
    const anonymous = tabs.active
    tabs.setPayload(anonymous.id, { savedQueryId: 'q1' })
    tabs.activate('objects')
    ws.openQuery('a', 'shop', { savedQueryId: 'q1' })
    expect(tabs.tabs.filter((t) => t.kind === 'query')).toHaveLength(1)
    expect(tabs.activeId).toBe(anonymous.id)
    // another connection with the same saved id is a different query
    ws.openQuery('b', 'shop', { savedQueryId: 'q1' })
    expect(tabs.tabs.filter((t) => t.kind === 'query')).toHaveLength(2)
  })

  // A query tab switched to another connection keeps its id `query:a:q1`.
  it('opens a new tab when the saved query tab now points at another connection', () => {
    const ws = useWorkspace()
    const tabs = useTabsStore()
    ws.openQuery('a', 'shop', { savedQueryId: 'q1' })
    const moved = tabs.active
    tabs.setTarget(moved.id, 'b', null)
    tabs.activate('objects')
    ws.openQuery('a', 'shop', { savedQueryId: 'q1' })
    expect(tabs.tabs.filter((t) => t.kind === 'query')).toHaveLength(2)
    expect(tabs.active.id).not.toBe(moved.id)
    expect(tabs.active.connectionId).toBe('a')
  })

  it('uses the only connection when there is exactly one', async () => {
    setActivePinia(createPinia())
    installBridge({ 'connections:list': [makeConnection({ id: 'solo' })] })
    await useConnectionsStore().load()
    expect(useWorkspace().currentConnectionId()).toBe('solo')
  })

  it('never mixes the selected connection with another connection tab schema', async () => {
    const ws = useWorkspace()
    const tree = useTreeStore()
    const tabs = useTabsStore()
    tree.select(nodeIds.connection('a'))
    ws.openTableData('b', 'shop', 'users')
    expect(ws.currentConnectionId()).toBe('a')
    expect(ws.currentSchema()).toBeNull()
    expect(await ws.showGroup('tables')).toBe(false)
    expect(bridge.invoke).not.toHaveBeenCalledWith('db:tables', 'a', 'shop')
    expect(tabs.active.connectionId).toBe('b')
  })

  it('falls back to the active tab schema of the same connection', () => {
    const ws = useWorkspace()
    const tree = useTreeStore()
    tree.select(nodeIds.connection('b'))
    ws.openTableData('b', 'shop', 'users')
    expect(ws.currentSchema()).toBe('shop')
  })

  it('deleting a connection warns about its unsaved tabs', async () => {
    const tabs = useTabsStore()
    const ui = useUiStore()
    useWorkspace().openTableData('b', 'shop', 'users')
    tabs.setDirty(tabs.active.id, true)
    const pending = useObjectActions().deleteConnection('b')
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.message).toContain('1 pestaña(s)')
    expect(ui.confirm.message).toContain('cambios sin guardar')
    ui.answer(false)
    await pending
    expect(tabs.tabs.some((t) => t.connectionId === 'b')).toBe(true)
  })
})

describe('Cmd/Ctrl+D: the structure of the table in context', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    installBridge({
      'connections:list': [makeConnection({ id: 'b', name: 'Beta' })],
      'db:views': () => [{ name: 'v_ventas' }]
    })
    await useConnectionsStore().load()
  })

  it('opens the designer of the active data tab, the DDL of a view opened as data', async () => {
    const ws = useWorkspace()
    const tabs = useTabsStore()
    ws.openTableData('b', 'shop', 'users')
    expect(ws.designCurrent(false)).toBe(true)
    expect(tabs.active).toMatchObject({
      kind: 'tableDesigner',
      connectionId: 'b',
      schema: 'shop',
      objectName: 'users'
    })

    await useTreeStore().loadGroup('b', 'shop', 'views')
    ws.openTableData('b', 'shop', 'v_ventas')
    expect(ws.designCurrent(false)).toBe(true)
    expect(tabs.active).toMatchObject({
      kind: 'ddlEditor',
      objectType: 'view',
      objectName: 'v_ventas'
    })
  })

  it('with the tree focused it uses the selected table; elsewhere it does nothing', () => {
    const ws = useWorkspace()
    const tabs = useTabsStore()
    const tree = useTreeStore()
    tree.select(nodeIds.object('b', 'shop', 'tables', 'orders'))
    expect(ws.designCurrent(true)).toBe(true)
    expect(tabs.active).toMatchObject({ kind: 'tableDesigner', objectName: 'orders' })

    tree.select(nodeIds.connection('b'))
    expect(ws.designCurrent(true)).toBe(false)
    ws.openQuery('b', 'shop')
    expect(ws.designCurrent(false)).toBe(false)
    expect(tabs.active.kind).toBe('query')
  })
})
