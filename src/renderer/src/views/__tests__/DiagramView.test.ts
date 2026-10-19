import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiagramImage } from '@shared/types'
import { useTabsStore } from '@renderer/stores/tabs'
import DiagramView from '../DiagramView.vue'
import { SHOP, shopTables } from './diagramFixtures'
import { mockBridge, mountView, openTab, setupDom } from './helpers'

describe('DiagramView', () => {
  let wrapper: Awaited<ReturnType<typeof mountView>> | null = null
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })
  afterEach(() => wrapper?.unmount())

  async function mount(extra: Record<string, (...args: unknown[]) => unknown> = {}) {
    const pinia = setupDom()
    const invoke = mockBridge({
      'db:tables': () => shopTables(),
      'db:tableStructure': (_c, _s, name) => {
        if (name === 'settings') throw new Error('sin permiso')
        return structuredClone(SHOP[name as string])
      },
      ...extra
    })
    const tab = openTab({ kind: 'diagram', title: 'd', connectionId: 'c1', schema: 'shop' })
    wrapper = await mountView(DiagramView, tab, pinia)
    await flushPromises()
    return { w: wrapper, invoke }
  }

  it('draws every readable table and a line per foreign key; reads structure only', async () => {
    const { w, invoke } = await mount()
    expect(invoke.mock.calls.map((c) => c[0]).sort()).toEqual([
      'db:tableStructure',
      'db:tableStructure',
      'db:tableStructure',
      'db:tableStructure',
      'db:tables'
    ])
    expect(w.findAll('[data-test^="dbox-head-"]').map((b) => b.text())).toEqual([
      'customers',
      'order_items',
      'orders'
    ])
    expect(w.findAll('[data-test^="edge-"]')).toHaveLength(2)
    expect(w.get('[data-test="diagram-footer"]').text()).toMatch(
      /3 tablas · 2 relaciones.*1 tablas no se pudieron leer/s
    )
  })

  it('«Solo claves» shows only key columns; double-click opens the table data', async () => {
    const { w } = await mount()
    expect(w.findAll('[data-test^="dbox-row-orders-"]')).toHaveLength(3)
    await w.get('[data-test="diagram-keys"]').trigger('click')
    expect(
      w.findAll('[data-test^="dbox-row-orders-"]').map((r) => r.attributes('data-column'))
    ).toEqual(['id', 'customer_id'])
    await w.get('[data-test="dbox-head-orders"]').trigger('dblclick')
    expect(useTabsStore().active).toMatchObject({ kind: 'tableData', objectName: 'orders' })
  })

  it('remembers a table moved by hand on this computer', async () => {
    const { w } = await mount()
    const head = w.get('[data-test="dbox-head-customers"]')
    const before = w.get('[data-test="dbox-customers"]').attributes('style')
    await head.trigger('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
    await w
      .get('[data-test="diagram-canvas"]')
      .trigger('pointermove', { clientX: 110, clientY: 60, pointerId: 1 })
    await w
      .get('[data-test="diagram-canvas"]')
      .trigger('pointerup', { clientX: 110, clientY: 60, pointerId: 1 })
    expect(w.get('[data-test="dbox-customers"]').attributes('style')).not.toBe(before)
    const saved = JSON.parse(localStorage.getItem('electrondb.diagram.c1::shop') ?? '{}')
    expect(Object.keys(saved.positions)).toContain('customers')
    // «Reorganizar» goes back to the automatic layout and forgets the hand-placed one.
    await w.get('[data-test="diagram-rearrange"]').trigger('click')
    expect(
      JSON.parse(localStorage.getItem('electrondb.diagram.c1::shop') ?? '{}').positions
    ).toEqual({})
  })

  it('exports an SVG through main (its own save dialog), with no host names or data', async () => {
    const images: DiagramImage[] = []
    const { w } = await mount({
      'app:saveImage': (_name, image) => {
        images.push(image as DiagramImage)
        return '/tmp/diagrama-shop.svg'
      }
    })
    await w.get('[data-test="diagram-export"]').trigger('click')
    await flushPromises()
    ;(document.body.querySelector('[data-test="diagram-export-svg"]') as HTMLElement).click()
    await flushPromises()
    expect(images).toHaveLength(1)
    expect(images[0].format).toBe('svg')
    expect(images[0].data).toMatch(/^<svg xmlns=/)
    expect(images[0].data).toContain('order_items')
  })

  it('says so when the structure cannot be read at all', async () => {
    const { w } = await mount({
      'db:tables': () => {
        throw new Error('Access denied')
      }
    })
    expect(w.text()).toContain('No se pudo leer la estructura')
    expect(w.text()).toContain('Access denied')
  })
})
