import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountComponent, setupDom } from '../../views/__tests__/helpers'
import DiagramCanvas from './DiagramCanvas.vue'
import { tableSizes } from './layout'
import type { ModelTable } from './model'

const tables: ModelTable[] = [
  {
    name: 'a',
    columns: [{ name: 'id', type: 'int', primaryKey: true, foreignKey: false, nullable: false }]
  }
]

describe('DiagramCanvas', () => {
  let wrapper: Awaited<ReturnType<typeof mountComponent>> | null = null
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => wrapper?.unmount())

  it('zooms with Cmd/Ctrl + wheel (bounded) and pans with the plain wheel', async () => {
    wrapper = await mountComponent(
      DiagramCanvas,
      {
        tables,
        relations: [],
        sizes: tableSizes({ tables }, false),
        positions: { a: { x: 0, y: 0 } },
        label: 'Diagrama'
      },
      setupDom()
    )
    const vm = wrapper.vm as unknown as { scale: number; zoomBy: (f: number) => void }
    const canvas = wrapper.get('[data-test="diagram-canvas"]')
    const wheel = async (init: WheelEventInit) => {
      canvas.element.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
      )
      await wrapper!.vm.$nextTick()
    }
    await wheel({ deltaY: -200, ctrlKey: true })
    expect(vm.scale).toBeGreaterThan(1)
    for (let i = 0; i < 40; i++) vm.zoomBy(1.5)
    expect(vm.scale).toBe(2)
    for (let i = 0; i < 40; i++) vm.zoomBy(0.5)
    expect(vm.scale).toBe(0.2)
    const world = wrapper.get('.dcanvas__world')
    const before = world.attributes('style')
    await wheel({ deltaX: 30, deltaY: 40 })
    expect(world.attributes('style')).not.toBe(before)
    expect(vm.scale).toBe(0.2)
  })

  it('in builder mode a row click ticks its column; diagram rows do not', async () => {
    wrapper = await mountComponent(
      DiagramCanvas,
      {
        tables,
        relations: [],
        sizes: tableSizes({ tables }, false, 18),
        positions: { a: { x: 0, y: 0 } },
        mode: 'builder',
        checked: { a: ['id'] },
        label: 'Consulta'
      },
      setupDom()
    )
    expect(wrapper.get('[data-test="dbox-row-a-id"]').classes()).toContain('is-checked')
    await wrapper.get('[data-test="dbox-row-a-id"]').trigger('click')
    expect(wrapper.emitted('toggle-column')).toEqual([['a', 'id']])
    await wrapper.setProps({ mode: 'diagram' })
    await wrapper.get('[data-test="dbox-row-a-id"]').trigger('click')
    expect(wrapper.emitted('toggle-column')).toHaveLength(1)
  })
})
