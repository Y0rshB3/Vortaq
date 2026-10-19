import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTabsStore } from '@renderer/stores/tabs'
import QueryBuilderView from '../QueryBuilderView.vue'
import { SHOP, shopTables } from './diagramFixtures'
import { mockBridge, mountView, openTab, setupDom } from './helpers'

describe('QueryBuilderView', () => {
  let wrapper: Awaited<ReturnType<typeof mountView>> | null = null
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => wrapper?.unmount())

  async function mount(
    engine: ConnectionConfig['engine'] = 'mysql',
    schema = 'shop',
    database?: string
  ) {
    const pinia = setupDom()
    useConnectionsStore().items = [
      { id: 'c1', name: 'Local', environment: 'local', engine } as ConnectionConfig
    ]
    const invoke = mockBridge({
      'db:tables': () => shopTables(),
      'db:tableStructure': (_c, _s, name) => structuredClone(SHOP[name as string])
    })
    const tab = openTab({ kind: 'queryBuilder', title: 'q', connectionId: 'c1', schema, database })
    wrapper = await mountView(QueryBuilderView, tab, pinia)
    return { w: wrapper, invoke }
  }
  const sql = (w: NonNullable<typeof wrapper>) => w.get('[data-test="qb-sql"]').text()

  async function addTables(w: NonNullable<typeof wrapper>, ...names: string[]) {
    for (const n of names) {
      await w.get(`[data-test="qb-table-${n}"]`).trigger('click')
      await flushPromises()
    }
  }

  it('reads table structures only when a table is added, and joins related tables by their keys', async () => {
    const { w, invoke } = await mount()
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['db:tables'])
    expect(w.find('[data-test="qb-empty"]').exists()).toBe(true)
    await addTables(w, 'orders', 'customers')
    expect(invoke.mock.calls.filter((c) => c[0] === 'db:tableStructure').map((c) => c[3])).toEqual([
      'orders',
      'customers'
    ])
    expect(w.findAll('[data-test^="edge-"]')).toHaveLength(1)
    await w.get('[data-test="qb-tab-sql"]').trigger('click')
    expect(sql(w)).toBe(
      [
        'SELECT',
        '  *',
        'FROM `orders` AS o',
        '  INNER JOIN `customers` AS c ON c.`id` = o.`customer_id`'
      ].join('\n')
    )
  })

  it('builds the SELECT from ticked columns, totals, order and filters', async () => {
    const { w } = await mount()
    await addTables(w, 'orders', 'customers')
    await w.get('[data-test="dbox-row-customers-country"]').trigger('click')
    await w.get('[data-test="dbox-row-orders-total"]').trigger('click')
    expect(w.findAll('[data-test^="qb-col-"]')).toHaveLength(2)
    await w.get('[data-test="qb-agg-o.total"]').setValue('SUM')
    await w.get('[data-test="qb-as-o.total"]').setValue('facturado')
    await w.get('[data-test="qb-sort-o.total"]').setValue('DESC')
    await w.get('[data-test="qb-op-c.country"]').setValue('eq')
    await w.get('[data-test="qb-value-c.country"]').setValue("E'S")
    await w.get('[data-test="qb-limit"]').setValue('10')
    await w.get('[data-test="qb-tab-sql"]').trigger('click')
    expect(sql(w)).toBe(
      [
        'SELECT',
        '  c.`country`,',
        '  SUM(o.`total`) AS `facturado`',
        'FROM `orders` AS o',
        '  INNER JOIN `customers` AS c ON c.`id` = o.`customer_id`',
        "WHERE c.`country` = 'E\\'S'",
        'GROUP BY c.`country`',
        'ORDER BY SUM(o.`total`) DESC',
        'LIMIT 10'
      ].join('\n')
    )
  })

  it('a join can become LEFT or be removed from its line menu; a dragged column adds one', async () => {
    const { w } = await mount()
    await addTables(w, 'orders', 'customers')
    await w.get('[data-test="edge-fk:fk_customer_id"] path.dcanvas__hit').trigger('click')
    await flushPromises()
    const left = document.body.querySelector<HTMLElement>('[data-test="menu-left"]')!
    expect(left.textContent).toContain('Todas las filas de «orders» (LEFT JOIN)')
    left.click()
    await flushPromises()
    await w.get('[data-test="qb-tab-sql"]').trigger('click')
    expect(sql(w)).toContain('LEFT JOIN `customers` AS c ON c.`id` = o.`customer_id`')

    await w.get('[data-test="edge-fk:fk_customer_id"] path.dcanvas__hit').trigger('click')
    await flushPromises()
    document.body.querySelector<HTMLElement>('[data-test="menu-remove"]')!.click()
    await flushPromises()
    expect(sql(w)).toContain('CROSS JOIN `customers` AS c')

    // Drag the handle of orders.customer_id onto customers.id.
    const target = w.get('[data-test="dbox-row-customers-id"]').element
    document.elementFromPoint = vi.fn(() => target)
    const canvas = w.get('[data-test="diagram-canvas"]')
    await w
      .get('[data-test="dbox-handle-orders-customer_id"]')
      .trigger('pointerdown', { button: 0, clientX: 5, clientY: 5, pointerId: 2 })
    await canvas.trigger('pointermove', { clientX: 300, clientY: 40, pointerId: 2 })
    await canvas.trigger('pointerup', { clientX: 300, clientY: 40, pointerId: 2 })
    expect(sql(w)).toContain('INNER JOIN `customers` AS c ON c.`id` = o.`customer_id`')
  })

  it('opens the SELECT in a query tab, and «Ejecutar» asks that tab to run it', async () => {
    const { w } = await mount()
    await addTables(w, 'customers')
    await w.get('[data-test="qb-open"]').trigger('click')
    const tabs = useTabsStore()
    expect(tabs.active).toMatchObject({
      kind: 'query',
      connectionId: 'c1',
      schema: 'shop',
      payload: { sql: 'SELECT\n  *\nFROM `customers`;\n', name: 'Consulta gráfica' }
    })
    expect(tabs.active.payload?.run).toBeUndefined()
    const builder = tabs.tabs.find((t) => t.kind === 'queryBuilder')!
    tabs.activate(builder.id)
    await w.get('[data-test="qb-run"]').trigger('click')
    expect(tabs.active.payload?.run).toBe(true)
  })

  it('PostgreSQL names the schema; removing a table drops its columns and joins', async () => {
    const { w } = await mount('postgresql', 'shop', 'app')
    await addTables(w, 'orders', 'order_items')
    await w.get('[data-test="dbox-row-order_items-qty"]').trigger('click')
    await w.get('[data-test="qb-tab-sql"]').trigger('click')
    expect(sql(w)).toBe(
      [
        'SELECT',
        '  oi.qty',
        'FROM shop.orders AS o',
        '  INNER JOIN shop.order_items AS oi ON oi.order_id = o.id'
      ].join('\n')
    )
    await w.get('[data-test="dbox-head-order_items"]').trigger('contextmenu')
    await flushPromises()
    document.body.querySelector<HTMLElement>('[data-test="menu-remove"]')!.click()
    await flushPromises()
    expect(sql(w)).toBe('SELECT\n  *\nFROM shop.orders')
    expect(w.get('[data-test="qb-tab-columns"]').text()).toContain('0')
  })
})
