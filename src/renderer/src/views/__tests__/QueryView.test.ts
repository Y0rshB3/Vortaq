import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { QueryColumn, QueryStatementResult, TableStructure } from '@shared/types'
import { useQueriesStore } from '@renderer/stores/queries'
import { useTabsStore } from '@renderer/stores/tabs'
import { useUiStore } from '@renderer/stores/ui'
import QueryView from '../QueryView.vue'
import { mockBridge, mountView, openTab, setupDom } from './helpers'

const results: QueryStatementResult[] = [
  {
    sql: 'SELECT id FROM items',
    durationMs: 4,
    affectedRows: null,
    insertId: null,
    changedRows: null,
    warnings: 0,
    resultSet: { columns: [{ name: 'id', type: 'LONG' }], rows: [[1], [2]], truncated: false },
    error: null
  },
  {
    sql: 'UPDATE items SET nope = 1 WHERE id = 1',
    durationMs: 2,
    affectedRows: null,
    insertId: null,
    changedRows: null,
    warnings: 0,
    resultSet: null,
    error: "Unknown column 'nope' in 'field list' (ER_BAD_FIELD_ERROR 1054)"
  }
]

describe('QueryView', () => {
  let wrapper: Awaited<ReturnType<typeof mountView>> | null = null
  afterEach(() => {
    wrapper?.unmount()
    localStorage.clear()
  })

  it('runs the editor SQL and renders statement results and errors', async () => {
    const pinia = setupDom()
    const invoke = mockBridge({
      'db:databases': () => [
        { name: 'shop', characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }
      ],
      'db:tables': () => [],
      'db:execute': () => results
    })
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'c1',
      schema: 'shop',
      payload: { sql: 'SELECT id FROM items; UPDATE items SET nope = 1 WHERE id = 1' }
    })
    wrapper = await mountView(QueryView, tab, pinia)

    expect(
      (wrapper.get('[data-test="sql-editor"]').element as HTMLTextAreaElement).value
    ).toContain('SELECT id FROM items')
    await wrapper.get('[data-test="run"]').trigger('click')
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith(
      'db:execute',
      'c1',
      'SELECT id FROM items; UPDATE items SET nope = 1 WHERE id = 1',
      { schema: 'shop' }
    )
    expect(wrapper.get('[data-test="message-0"]').text()).toContain('2 fila(s) devuelta(s)')
    expect(wrapper.get('[data-test="message-1"]').classes()).toContain('is-error')
    expect(wrapper.get('[data-test="message-1"]').text()).toContain('ER_BAD_FIELD_ERROR 1054')
    expect(wrapper.find('[data-test="tab-rs0"]').exists()).toBe(true)
  })

  it('runs the SQL handed over by «Consulta gráfica › Ejecutar» once, on opening', async () => {
    const pinia = setupDom()
    const invoke = mockBridge({
      'db:databases': () => [
        { name: 'shop', characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }
      ],
      'db:tables': () => [],
      'db:execute': () => [results[0]]
    })
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'c1',
      schema: 'shop',
      payload: { sql: 'SELECT id FROM items;\n', name: 'Consulta gráfica', run: true }
    })
    wrapper = await mountView(QueryView, tab, pinia)
    await flushPromises()
    expect(invoke.mock.calls.filter((c) => c[0] === 'db:execute')).toEqual([
      ['db:execute', 'c1', 'SELECT id FROM items;', { schema: 'shop' }]
    ])
    // The request is consumed: reopening or re-rendering the tab never runs it again.
    expect(useTabsStore().tabs.find((t) => t.id === tab.id)?.payload?.run).toBe(false)
  })

  it('ignores late results after Detener', async () => {
    const pinia = setupDom()
    let release: (v: QueryStatementResult[]) => void = () => {}
    mockBridge({
      'db:databases': () => [],
      'db:tables': () => [],
      'db:execute': () => new Promise<QueryStatementResult[]>((r) => (release = r))
    })
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'c1',
      payload: { sql: 'SELECT SLEEP(10)' }
    })
    wrapper = await mountView(QueryView, tab, pinia)
    await wrapper.get('[data-test="run"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="stop"]').trigger('click')
    release(results)
    await flushPromises()
    expect(wrapper.find('[data-test="message-0"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Ejecución detenida')
  })

  it('loads a saved query and saves changes back to the same entry', async () => {
    const pinia = setupDom()
    mockBridge({ 'db:databases': () => [], 'db:tables': () => [] })
    const saved = useQueriesStore().save('c1', { name: 'Informe', sql: 'SELECT 1', schema: null })
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'c1',
      payload: { savedQueryId: saved.id }
    })
    wrapper = await mountView(QueryView, tab, pinia)

    const editor = wrapper.get('[data-test="sql-editor"]')
    expect((editor.element as HTMLTextAreaElement).value).toBe('SELECT 1')
    await editor.setValue('SELECT 2')
    await wrapper.get('[data-test="save"]').trigger('click')
    const list = useQueriesStore().list('c1')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: saved.id, name: 'Informe', sql: 'SELECT 2' })
  })

  it('formats the whole editor with the Formatear SQL button', async () => {
    const pinia = setupDom()
    mockBridge({ 'db:databases': () => [], 'db:tables': () => [] })
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'c1',
      payload: { sql: 'select id, name from accounts.users where id = 1' }
    })
    wrapper = await mountView(QueryView, tab, pinia)
    const button = wrapper.get('[data-test="format"]')
    expect(button.text()).toContain('Formatear SQL')
    await button.trigger('click')
    expect((wrapper.get('[data-test="sql-editor"]').element as HTMLTextAreaElement).value).toBe(
      'SELECT\n\tid,\n\tname\nFROM\n\taccounts.users\nWHERE\n\tid = 1'
    )
  })

  it('runs on Cmd+R / Cmd+Enter even when the editor does not have focus', async () => {
    const pinia = setupDom()
    const invoke = mockBridge({
      'db:databases': () => [],
      'db:tables': () => [],
      'db:execute': () => results
    })
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'c1',
      payload: { sql: 'SELECT 1' }
    })
    wrapper = await mountView(QueryView, tab, pinia)

    const toolbarButton = wrapper.get('[data-test="format"]').element as HTMLElement
    const event = new KeyboardEvent('keydown', {
      key: 'r',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    toolbarButton.dispatchEvent(event)
    await flushPromises()
    // preventDefault keeps Electron's default menu from reloading the window.
    expect(event.defaultPrevented).toBe(true)
    expect(invoke.mock.calls.filter((c) => c[0] === 'db:execute')).toHaveLength(1)

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })
    )
    await flushPromises()
    expect(invoke.mock.calls.filter((c) => c[0] === 'db:execute')).toHaveLength(2)
  })

  it('updates the tab title when the schema changes', async () => {
    const pinia = setupDom()
    mockBridge({
      'db:databases': () => [
        { name: 'shop', characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' },
        { name: 'crm', characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }
      ],
      'db:tables': () => []
    })
    const tab = openTab({ kind: 'query', title: 'q', connectionId: 'c1', schema: 'shop' })
    wrapper = await mountView(QueryView, tab, pinia)
    const title = () => useTabsStore().tabs.find((t) => t.id === tab.id)?.title
    expect(title()).toContain('@shop')
    ;(wrapper.vm as unknown as { schema: string }).schema = 'crm'
    await flushPromises()
    expect(title()).toContain('@crm')
  })

  describe('editable results (one base table with its primary key)', () => {
    const sql = "SELECT id AS ident, email FROM accounts.user AS u WHERE u.email LIKE '%x%'"
    const userColumn = (name: string, sourceName: string, pk = false): QueryColumn => ({
      name,
      type: name === 'ident' ? 'INT' : 'VARCHAR',
      schema: 'accounts',
      table: 'user',
      tableAlias: 'u',
      sourceName,
      ...(pk ? { primaryKey: true } : {})
    })
    const selectResult = (
      columns: QueryColumn[],
      rows: unknown[][],
      statement = sql
    ): QueryStatementResult[] => [
      {
        sql: statement,
        durationMs: 3,
        affectedRows: null,
        insertId: null,
        changedRows: null,
        warnings: 0,
        resultSet: { columns, rows: rows as never, truncated: false },
        error: null
      }
    ]
    const userTable = {
      schema: 'accounts',
      name: 'user',
      tableType: 'BASE TABLE',
      columns: [
        {
          name: 'id',
          ordinal: 1,
          columnType: 'int',
          dataType: 'int',
          nullable: false,
          key: 'PRI',
          defaultValue: null,
          extra: 'auto_increment',
          characterSet: null,
          collation: null,
          comment: ''
        }
      ],
      indexes: [{ name: 'PRIMARY', unique: true, type: 'BTREE', columns: ['id'], comment: '' }],
      foreignKeys: [],
      engine: 'InnoDB',
      collation: null,
      comment: '',
      autoIncrement: null,
      createSql: ''
    } satisfies TableStructure

    async function mountEditable(extra: Record<string, (...a: unknown[]) => unknown> = {}) {
      const pinia = setupDom()
      const invoke = mockBridge({
        'db:databases': () => [],
        'db:tables': () => [],
        'db:execute': () =>
          selectResult(
            [userColumn('ident', 'id', true), userColumn('email', 'email')],
            [
              [1, 'a@x.io'],
              [2, 'b@x.io']
            ]
          ),
        'db:tableStructure': () => structuredClone(userTable),
        'db:applyRowChanges': (_c, _s, _t, changes) => ({
          applied: (changes as unknown[]).length,
          statements: [],
          insertIds: (changes as { kind: string }[]).map((c) => (c.kind === 'insert' ? 7 : null))
        }),
        ...extra
      })
      // Saved query: the SQL itself is clean, so the tab dirty flag only tracks row edits.
      const saved = useQueriesStore().save('c1', { name: 'Usuarios', sql, schema: 'accounts' })
      const tab = openTab({
        kind: 'query',
        title: 'q',
        connectionId: 'c1',
        payload: { savedQueryId: saved.id }
      })
      const w = await mountView(QueryView, tab, pinia)
      await w.get('[data-test="run"]').trigger('click')
      await flushPromises()
      return { wrapper: w, invoke, tab }
    }

    it('edits a cell and applies it by key using the real column names', async () => {
      const mounted = await mountEditable()
      wrapper = mounted.wrapper
      const { invoke, tab } = mounted
      const isDirty = () => useTabsStore().tabs.find((t) => t.id === tab.id)?.dirty

      expect(invoke).toHaveBeenCalledWith('db:tableStructure', 'c1', 'accounts', 'user')
      expect(wrapper.get('[data-test="editability"]').text()).toBe('Editable · accounts.user')
      expect(isDirty()).toBe(false)

      await wrapper.get('[data-test="cell-0-1"]').trigger('dblclick')
      const input = wrapper.get('[data-test="cell-input"]')
      await input.setValue('nuevo@x.io')
      await input.trigger('keydown', { key: 'Enter' })
      expect(wrapper.get('[data-test="cell-0-1"]').classes()).toContain('cell-changed')
      expect(wrapper.get('[data-test="pending"]').text()).toContain('1')
      expect(isDirty()).toBe(true)

      // Add a row with only the email: its generated id comes back from main.
      await wrapper.get('[data-test="add-row"]').trigger('click')
      await wrapper.get('[data-test="cell-2-1"]').trigger('dblclick')
      const added = wrapper.get('[data-test="cell-input"]')
      await added.setValue('c@x.io')
      await added.trigger('keydown', { key: 'Enter' })

      await wrapper.get('[data-test="apply"]').trigger('click')
      await flushPromises()

      const call = invoke.mock.calls.find((c) => c[0] === 'db:applyRowChanges')
      expect(call).toEqual([
        'db:applyRowChanges',
        'c1',
        'accounts',
        'user',
        [
          // `ident` is shown, but the table column is `id`
          { kind: 'update', key: { id: 1 }, values: { email: 'nuevo@x.io' } },
          { kind: 'insert', values: { email: 'c@x.io' } }
        ],
        { confirmProduction: true }
      ])
      // Saved values stay on screen; nothing pending, tab clean, no re-run.
      expect(wrapper.get('[data-test="cell-0-1"]').text()).toBe('nuevo@x.io')
      expect(wrapper.get('[data-test="cell-0-1"]').classes()).not.toContain('cell-changed')
      expect(wrapper.get('[data-test="cell-2-0"]').text()).toBe('7')
      expect(wrapper.find('[data-test="pending"]').exists()).toBe(false)
      expect(isDirty()).toBe(false)
      expect(invoke.mock.calls.filter((c) => c[0] === 'db:execute')).toHaveLength(1)
    })

    it('asks before running again with unapplied edits', async () => {
      const mounted = await mountEditable()
      wrapper = mounted.wrapper
      await wrapper.get('[data-test="cell-1-0"]').trigger('click')
      await wrapper.get('[data-test="set-null"]').trigger('click')
      const executes = () => mounted.invoke.mock.calls.filter((c) => c[0] === 'db:execute').length

      await wrapper.get('[data-test="run"]').trigger('click')
      await flushPromises()
      const ui = useUiStore()
      expect(ui.confirm.open).toBe(true)
      expect(ui.confirm.message).toContain('se descartarán')
      ui.answer(false)
      await flushPromises()
      expect(executes()).toBe(1)
      expect(wrapper.find('[data-test="pending"]').exists()).toBe(true)

      await wrapper.get('[data-test="run"]').trigger('click')
      await flushPromises()
      ui.answer(true)
      await flushPromises()
      expect(executes()).toBe(2)
      expect(wrapper.find('[data-test="pending"]').exists()).toBe(false)
    })

    it('applies with Cmd+S while the focus is in the grid', async () => {
      const mounted = await mountEditable()
      wrapper = mounted.wrapper
      await wrapper.get('[data-test="cell-0-1"]').trigger('dblclick')
      const input = wrapper.get('[data-test="cell-input"]')
      await input.setValue('cmd@x.io')
      await input.trigger('keydown', { key: 's', metaKey: true })
      await flushPromises()
      const call = mounted.invoke.mock.calls.find((c) => c[0] === 'db:applyRowChanges')
      expect(call?.[4]).toEqual([{ kind: 'update', key: { id: 1 }, values: { email: 'cmd@x.io' } }])
    })

    it('edits the columns of one table of a join and locks the others', async () => {
      const mounted = await mountEditable({
        'db:execute': () =>
          selectResult(
            [
              userColumn('ident', 'id', true),
              userColumn('email', 'email'),
              { ...userColumn('total', 'total'), table: 'orders', tableAlias: 'o' },
              { name: 'n', type: 'BIGINT' }
            ],
            [
              [1, 'a@x.io', 10, 1],
              [2, 'b@x.io', 20, 2]
            ],
            'SELECT u.id AS ident, u.email, o.total, ROW_NUMBER() OVER () AS n FROM accounts.user u JOIN orders o ON o.user_id = u.id'
          )
      })
      wrapper = mounted.wrapper
      expect(wrapper.get('[data-test="editability"]').text()).toBe(
        'Editable · accounts.user · 2 columnas de solo lectura'
      )
      const structureCalls = mounted.invoke.mock.calls.filter((c) => c[0] === 'db:tableStructure')
      expect(structureCalls.map((c) => c[3])).toEqual(['user'])

      // Another table's column and a computed one are locked: no editor opens.
      expect(wrapper.get('[data-test="lock-icon-total"]').attributes('title')).toBe(
        'No editable: columna de otra tabla (o)'
      )
      expect(wrapper.find('[data-test="lock-icon-email"]').exists()).toBe(false)
      expect(wrapper.get('[data-test="cell-0-2"]').classes()).toContain('cell-locked')
      expect(wrapper.get('[data-test="cell-0-3"]').classes()).toContain('cell-locked')
      await wrapper.get('[data-test="cell-0-2"]').trigger('dblclick')
      expect(wrapper.find('[data-test="cell-input"]').exists()).toBe(false)
      // NULL on a locked cell changes nothing.
      await wrapper.get('[data-test="cell-0-2"]').trigger('click')
      await wrapper.get('[data-test="set-null"]').trigger('click')
      expect(wrapper.find('[data-test="pending"]').exists()).toBe(false)

      await wrapper.get('[data-test="cell-1-1"]').trigger('dblclick')
      await wrapper.get('[data-test="cell-input"]').setValue('join@x.io')
      await wrapper.get('[data-test="cell-input"]').trigger('keydown', { key: 'Enter' })
      await wrapper.get('[data-test="apply"]').trigger('click')
      await flushPromises()
      const call = mounted.invoke.mock.calls.find((c) => c[0] === 'db:applyRowChanges')
      expect(call?.slice(2, 5)).toEqual([
        'accounts',
        'user',
        [{ kind: 'update', key: { id: 2 }, values: { email: 'join@x.io' } }]
      ])
    })

    // Regression: MySQL reports the inner alias as orgTable for a merged derived table,
    // so `FROM decoy items` inside a subquery looked like the real `items` table.
    it('keeps a derived table read-only even when its metadata names one base table', async () => {
      const mounted = await mountEditable({
        'db:execute': () =>
          selectResult(
            [userColumn('ident', 'id', true), userColumn('email', 'email')],
            [[1, 'decoy@x.io']],
            'SELECT * FROM (SELECT user.id AS ident, user.email FROM decoy user) u'
          )
      })
      wrapper = mounted.wrapper
      expect(wrapper.get('[data-test="editability"]').text()).toBe(
        'Solo lectura · la consulta lee de una subconsulta'
      )
      expect(wrapper.find('[data-test="apply"]').exists()).toBe(false)
      expect(mounted.invoke.mock.calls.some((c) => c[0] === 'db:tableStructure')).toBe(false)
    })

    // Regression: `SELECT i.* FROM items i JOIN orders o` repeated rows and was editable.
    it('keeps a join that repeats rows of the edited table read-only', async () => {
      const mounted = await mountEditable({
        'db:execute': () =>
          selectResult(
            [userColumn('ident', 'id', true), userColumn('email', 'email')],
            [
              [1, 'a@x.io'],
              [1, 'a@x.io']
            ],
            'SELECT u.* FROM accounts.user u, orders o WHERE o.user_id = u.id'
          )
      })
      wrapper = mounted.wrapper
      expect(wrapper.get('[data-test="editability"]').text()).toBe(
        'Solo lectura · hay filas repetidas con la misma clave'
      )
    })

    // Regression: the insert id was written into a key that is not AUTO_INCREMENT.
    it('leaves the key of a new row empty when it is not the AUTO_INCREMENT column', async () => {
      const mounted = await mountEditable({
        'db:tableStructure': () => ({
          ...structuredClone(userTable),
          columns: [{ ...userTable.columns[0], extra: '' }]
        })
      })
      wrapper = mounted.wrapper
      await wrapper.get('[data-test="add-row"]').trigger('click')
      await wrapper.get('[data-test="cell-2-1"]').trigger('dblclick')
      const added = wrapper.get('[data-test="cell-input"]')
      await added.setValue('c@x.io')
      await added.trigger('keydown', { key: 'Enter' })
      await wrapper.get('[data-test="apply"]').trigger('click')
      await flushPromises()
      expect(mounted.invoke.mock.calls.some((c) => c[0] === 'db:applyRowChanges')).toBe(true)
      expect(wrapper.get('[data-test="cell-2-0"]').text()).toBe('(NULL)')
    })

    // Regression: a failed apply only raised a toast with the raw server error.
    it('explains a failed apply inline and points at the row, keeping the edits', async () => {
      const mounted = await mountEditable({
        'db:applyRowChanges': () => {
          throw new Error(
            'Falló el cambio 2 de 2 (fila modificada): la columna «email» no admite NULL. ' +
              'No se aplicó ningún cambio: se deshicieron todos.'
          )
        }
      })
      wrapper = mounted.wrapper
      await wrapper.get('[data-test="cell-0-1"]').trigger('dblclick')
      const input = wrapper.get('[data-test="cell-input"]')
      await input.setValue('ok@x.io')
      await input.trigger('keydown', { key: 'Enter' })
      await wrapper.get('[data-test="cell-1-1"]').trigger('click')
      await wrapper.get('[data-test="set-null"]').trigger('click')

      await wrapper.get('[data-test="apply"]').trigger('click')
      await flushPromises()

      const banner = wrapper.get('[data-test="apply-error"]')
      expect(banner.attributes('role')).toBe('alert')
      expect(banner.text()).toContain('la columna «email» no admite NULL')
      expect(banner.text()).toContain('No se aplicó ningún cambio')
      expect(banner.text()).toContain('Los cambios siguen pendientes')
      // Updates are sent in row order: change 2 is row 2, column email.
      expect(wrapper.get('[data-test="row-1"]').classes()).toContain('row-error')
      expect(wrapper.get('[data-test="cell-1-1"]').classes()).toContain('cell-error')
      expect(wrapper.get('[data-test="row-0"]').classes()).not.toContain('row-error')
      expect(wrapper.get('[data-test="pending"]').text()).toContain('2')

      await wrapper.get('[data-test="apply-error-close"]').trigger('click')
      expect(wrapper.find('[data-test="apply-error"]').exists()).toBe(false)
    })

    it('keeps a view read-only', async () => {
      const mounted = await mountEditable({
        'db:tableStructure': () => ({
          ...structuredClone(userTable),
          tableType: 'VIEW',
          indexes: []
        })
      })
      wrapper = mounted.wrapper
      expect(wrapper.get('[data-test="editability"]').text()).toBe(
        'Solo lectura · el origen es una vista'
      )
      await wrapper.get('[data-test="cell-0-1"]').trigger('dblclick')
      expect(wrapper.find('[data-test="cell-input"]').exists()).toBe(false)
    })
  })
})
