import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTabsStore } from '@renderer/stores/tabs'
import { nodeIds, useTreeStore } from '@renderer/stores/tree'
import { installBridge, makeConnection } from '@renderer/__tests__/shellTestUtils'
import { useShortcuts } from './useShortcuts'
import { useWorkspace } from './useWorkspace'

const Host = defineComponent({
  setup() {
    useShortcuts()
    return () =>
      h('div', [
        h('div', { role: 'tree' }, [h('span', { 'data-test': 'tree-row', tabindex: 0 })]),
        h('input', { 'data-test': 'field' }),
        h('div', { class: 'cm-editor' }, [
          h('div', { 'data-test': 'sql', contenteditable: 'true' })
        ]),
        h('div', { 'data-test': 'grid', tabindex: 0 })
      ])
  }
})

function pressD(el: Element, mac = true): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'd',
    bubbles: true,
    cancelable: true,
    ...(mac ? { metaKey: true } : { ctrlKey: true })
  })
  el.dispatchEvent(event)
  return event
}

describe('Cmd/Ctrl+D', () => {
  let wrapper: ReturnType<typeof mount> | null = null
  beforeEach(async () => {
    setActivePinia(createPinia())
    installBridge({ 'connections:list': [makeConnection({ id: 'b', name: 'Beta' })] })
    await useConnectionsStore().load()
    wrapper = mount(Host, { attachTo: document.body })
  })
  afterEach(() => wrapper?.unmount())

  it('opens the structure of the open table from the grid, with Cmd or Ctrl', () => {
    useWorkspace().openTableData('b', 'shop', 'users')
    const tabs = useTabsStore()
    const event = pressD(wrapper!.get('[data-test="grid"]').element, false)
    expect(event.defaultPrevented).toBe(true)
    expect(tabs.active).toMatchObject({ kind: 'tableDesigner', objectName: 'users' })
  })

  it('leaves text fields and the SQL editor alone', () => {
    useWorkspace().openTableData('b', 'shop', 'users')
    const tabs = useTabsStore()
    expect(pressD(wrapper!.get('[data-test="field"]').element).defaultPrevented).toBe(false)
    expect(pressD(wrapper!.get('[data-test="sql"]').element).defaultPrevented).toBe(false)
    expect(tabs.active.kind).toBe('tableData')
  })

  it('in the tree, uses the selected table; with nothing to show the key is not taken', () => {
    const tabs = useTabsStore()
    useTreeStore().select(nodeIds.object('b', 'shop', 'tables', 'orders'))
    pressD(wrapper!.get('[data-test="tree-row"]').element)
    expect(tabs.active).toMatchObject({ kind: 'tableDesigner', objectName: 'orders' })
    useTreeStore().select(null)
    expect(pressD(wrapper!.get('[data-test="tree-row"]').element).defaultPrevented).toBe(false)
  })
})
