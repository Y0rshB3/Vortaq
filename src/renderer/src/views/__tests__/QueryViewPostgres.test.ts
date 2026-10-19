import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig, Environment, QueryStatementResult } from '@shared/types'
import TransactionPromptHost from '@renderer/components/query/TransactionPromptHost.vue'
import { useTabActions } from '@renderer/composables/useTabActions'
import {
  answerTransactionPrompt,
  transactionPrompt
} from '@renderer/composables/useTransactionPrompt'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useQueriesStore } from '@renderer/stores/queries'
import { useTabsStore } from '@renderer/stores/tabs'
import { useUiStore } from '@renderer/stores/ui'
import QueryView from '../QueryView.vue'
import { mockBridge, mountComponent, mountView, openTab, setupDom } from './helpers'

function seedPg(environment: Environment = 'local'): void {
  const connections = useConnectionsStore()
  connections.items = [
    {
      id: 'pg',
      name: 'Pedidos',
      environment,
      engine: 'postgresql',
      customDatabases: [],
      postgres: {
        initialDatabase: 'app',
        showSystemSchemas: false,
        timeZone: '',
        searchPath: ''
      }
    } as unknown as ConnectionConfig
  ]
  // Open: the tab session channels are only used on open connections.
  connections.serverInfo = { pg: { version: '17.11' } as never }
}

const result = (sql: string, extra: Partial<QueryStatementResult> = {}): QueryStatementResult => ({
  sql,
  durationMs: 1,
  affectedRows: 1,
  insertId: null,
  changedRows: null,
  warnings: 0,
  resultSet: null,
  error: null,
  ...extra
})

const pgHandlers = (extra: Record<string, (...args: unknown[]) => unknown> = {}) => ({
  'db:databases': () => [
    { name: 'app', characterSet: 'UTF8', collation: 'en_US.utf8' },
    { name: 'stats', characterSet: 'UTF8', collation: 'en_US.utf8' }
  ],
  'db:schemas': () => [
    { name: 'public', owner: 'postgres', comment: '', system: false },
    { name: 'sales', owner: 'postgres', comment: '', system: false }
  ],
  'db:tables': () => [],
  'db:views': () => [],
  'db:objects': () => [],
  'db:sessionState': () => ({
    open: false,
    transactionStatus: 'idle',
    effectiveSchema: null,
    database: null
  }),
  'db:closeSession': () => undefined,
  ...extra
})

describe('QueryView on PostgreSQL', () => {
  let wrapper: Awaited<ReturnType<typeof mountView>> | null = null
  let host: Awaited<ReturnType<typeof mountComponent>> | null = null
  afterEach(() => {
    wrapper?.unmount()
    host?.unmount()
    wrapper = null
    host = null
    answerTransactionPrompt('cancel')
    localStorage.clear()
  })

  it('shows database and schema combos and runs on the tab session', async () => {
    const pinia = setupDom()
    seedPg()
    const invoke = mockBridge(
      pgHandlers({
        'db:execute': (_c, sql) => [
          result(String(sql), { transactionStatus: 'in', effectiveSchema: 'sales' })
        ]
      })
    )
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'pg',
      payload: { sql: 'BEGIN; INSERT INTO t VALUES (1)' }
    })
    wrapper = await mountView(QueryView, tab, pinia)

    expect(wrapper.find('[data-test="database"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="schema"]').exists()).toBe(true)
    // The initial database of the connection is the tab's database.
    expect(useTabsStore().tabs.find((t) => t.id === tab.id)?.database).toBe('app')
    expect(invoke).toHaveBeenCalledWith('db:schemas', 'pg', 'app')
    expect(invoke).toHaveBeenCalledWith('db:sessionState', 'pg', tab.id)
    expect(wrapper.find('[data-test="tx-status"]').exists()).toBe(false)

    await wrapper.get('[data-test="run"]').trigger('click')
    await flushPromises()
    const call = invoke.mock.calls.find((c) => c[0] === 'db:execute')!
    expect(call[3]).toMatchObject({
      schema: { database: 'app', schema: '' },
      sessionKey: tab.id
    })
    expect(String((call[3] as { executionId: string }).executionId)).toMatch(/^exec-/)
    // Transaction buttons follow the result; the schema combo follows SET search_path.
    expect(wrapper.get('[data-test="tx-status"]').text()).toBe('Transacción abierta')
    expect(wrapper.find('[data-test="tx-commit"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="tx-rollback"]').exists()).toBe(true)
    expect((wrapper.vm as unknown as { schema: string | null }).schema).toBe('sales')
    expect(useTabsStore().tabs.find((t) => t.id === tab.id)?.title).toBe(
      'Consulta sin título@app.sales (Pedidos)'
    )
  })

  it('Confirmar and Deshacer call db:commit / db:rollback on the tab session', async () => {
    const pinia = setupDom()
    seedPg()
    const invoke = mockBridge(
      pgHandlers({
        'db:sessionState': () => ({
          open: true,
          transactionStatus: 'in',
          effectiveSchema: 'public',
          database: 'app'
        }),
        'db:commit': () => ({
          open: true,
          transactionStatus: 'idle',
          effectiveSchema: 'public',
          database: 'app'
        }),
        'db:rollback': () => ({
          open: true,
          transactionStatus: 'idle',
          effectiveSchema: 'public',
          database: 'app'
        })
      })
    )
    const tab = openTab({ kind: 'query', title: 'q', connectionId: 'pg', database: 'app' })
    wrapper = await mountView(QueryView, tab, pinia)
    await wrapper.get('[data-test="tx-commit"]').trigger('click')
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('db:commit', 'pg', tab.id, undefined)
    expect(wrapper.find('[data-test="tx-status"]').exists()).toBe(false)

    ;(wrapper.vm as unknown as { txStatus: string }).txStatus = 'failed'
    await flushPromises()
    expect(wrapper.get('[data-test="tx-status"]').text()).toBe(
      'Transacción abortada: ejecuta ROLLBACK'
    )
    expect(wrapper.find('[data-test="tx-commit"]').exists()).toBe(false)
    await wrapper.get('[data-test="tx-rollback"]').trigger('click')
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('db:rollback', 'pg', tab.id)
  })

  it('asks for the typed name before COMMIT on a production connection', async () => {
    const pinia = setupDom()
    seedPg('production')
    const invoke = mockBridge(
      pgHandlers({
        'db:sessionState': () => ({
          open: true,
          transactionStatus: 'in',
          effectiveSchema: null,
          database: 'app'
        }),
        'db:commit': () => ({
          open: true,
          transactionStatus: 'idle',
          effectiveSchema: null,
          database: 'app'
        })
      })
    )
    const tab = openTab({ kind: 'query', title: 'q', connectionId: 'pg', database: 'app' })
    wrapper = await mountView(QueryView, tab, pinia)
    await wrapper.get('[data-test="tx-commit"]').trigger('click')
    await flushPromises()
    const ui = useUiStore()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.requireTyped).toBe('Pedidos')
    ui.answer(true)
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('db:commit', 'pg', tab.id, { confirmProduction: true })
  })

  it('uses the PostgreSQL write allowlist (with its reasons) on a guarded connection', async () => {
    const pinia = setupDom()
    seedPg('production')
    const invoke = mockBridge(pgHandlers({ 'db:execute': (_c, sql) => [result(String(sql))] }))
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'pg',
      database: 'app',
      payload: { sql: 'SELECT pg_terminate_backend(42)' }
    })
    wrapper = await mountView(QueryView, tab, pinia)
    await wrapper.get('[data-test="run"]').trigger('click')
    await flushPromises()
    const ui = useUiStore()
    expect(ui.confirm.open).toBe(true)
    expect(ui.confirm.message).toContain('pg_terminate_backend')
    ui.answer(true)
    await flushPromises()
    const call = invoke.mock.calls.find((c) => c[0] === 'db:execute')!
    expect(call[3]).toMatchObject({ confirmProduction: true, sessionKey: tab.id })
  })

  it('Detener cancels the running statement through db:cancel', async () => {
    const pinia = setupDom()
    seedPg()
    let release: (v: QueryStatementResult[]) => void = () => {}
    const invoke = mockBridge(
      pgHandlers({
        'db:execute': () => new Promise<QueryStatementResult[]>((r) => (release = r)),
        'db:cancel': () => true
      })
    )
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'pg',
      database: 'app',
      payload: { sql: 'SELECT pg_sleep(20)' }
    })
    wrapper = await mountView(QueryView, tab, pinia)
    await wrapper.get('[data-test="run"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="stop"]').trigger('click')
    await flushPromises()
    const executionId = (
      invoke.mock.calls.find((c) => c[0] === 'db:execute')![3] as { executionId: string }
    ).executionId
    expect(invoke).toHaveBeenCalledWith('db:cancel', 'pg', executionId)
    release([
      result('SELECT pg_sleep(20)', {
        error: 'Consulta cancelada: cancelada por el usuario (57014)',
        affectedRows: null,
        transactionStatus: 'idle'
      })
    ])
    await flushPromises()
    // The cancelled statement's error is shown (results are not discarded on PostgreSQL).
    expect(wrapper.get('[data-test="message-0"]').text()).toContain('57014')
  })

  it('changing the database settles the open transaction and closes the session', async () => {
    const pinia = setupDom()
    seedPg()
    const invoke = mockBridge(
      pgHandlers({
        'db:sessionState': () => ({
          open: true,
          transactionStatus: 'in',
          effectiveSchema: null,
          database: 'app'
        }),
        'db:rollback': () => ({
          open: true,
          transactionStatus: 'idle',
          effectiveSchema: null,
          database: 'app'
        })
      })
    )
    host = await mountComponent(TransactionPromptHost, {}, pinia)
    const tab = openTab({ kind: 'query', title: 'q', connectionId: 'pg', database: 'app' })
    wrapper = await mountView(QueryView, tab, pinia)
    const change = (
      wrapper.vm as unknown as { changeDatabase(v: string): Promise<void> }
    ).changeDatabase('stats')
    await flushPromises()
    expect(transactionPrompt.open).toBe(true)
    answerTransactionPrompt('rollback')
    await change
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('db:rollback', 'pg', tab.id)
    expect(invoke).toHaveBeenCalledWith('db:closeSession', 'pg', tab.id)
    expect(invoke).toHaveBeenCalledWith('db:schemas', 'pg', 'stats')
    expect(useTabsStore().tabs.find((t) => t.id === tab.id)?.database).toBe('stats')
  })

  it('keeps the database when saving the query', async () => {
    const pinia = setupDom()
    seedPg()
    mockBridge(pgHandlers())
    const tab = openTab({
      kind: 'query',
      title: 'q',
      connectionId: 'pg',
      database: 'stats',
      schema: 'public',
      payload: { sql: 'SELECT 1' }
    })
    wrapper = await mountView(QueryView, tab, pinia)
    await wrapper.get('[data-test="save"]').trigger('click')
    await flushPromises()
    // The save dialog is teleported to <body>.
    const input = document.querySelector('[data-test="save-name"] input') as HTMLInputElement
    input.value = 'Informe'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    ;(document.querySelector('[data-test="save-confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(useQueriesStore().list('pg')[0]).toMatchObject({
      name: 'Informe',
      schema: 'public',
      database: 'stats'
    })
  })
})

describe('closing a PostgreSQL query tab', () => {
  afterEach(() => answerTransactionPrompt('cancel'))

  it('asks Confirmar / Deshacer / Cancelar with an open transaction, then closes the session', async () => {
    setupDom()
    seedPg()
    const invoke = mockBridge(
      pgHandlers({
        'db:sessionState': () => ({
          open: true,
          transactionStatus: 'in',
          effectiveSchema: null,
          database: 'app'
        }),
        'db:rollback': () => ({
          open: true,
          transactionStatus: 'idle',
          effectiveSchema: null,
          database: 'app'
        })
      })
    )
    const tab = openTab({ kind: 'query', title: 'q', connectionId: 'pg', database: 'app' })
    const { requestClose } = useTabActions()

    const cancelled = requestClose(tab.id)
    await flushPromises()
    expect(transactionPrompt.open).toBe(true)
    answerTransactionPrompt('cancel')
    expect(await cancelled).toBe(false)
    expect(useTabsStore().tabs.some((t) => t.id === tab.id)).toBe(true)
    expect(invoke).not.toHaveBeenCalledWith('db:closeSession', 'pg', tab.id)

    const closing = requestClose(tab.id)
    await flushPromises()
    answerTransactionPrompt('rollback')
    expect(await closing).toBe(true)
    expect(invoke).toHaveBeenCalledWith('db:rollback', 'pg', tab.id)
    expect(invoke).toHaveBeenCalledWith('db:closeSession', 'pg', tab.id)
    expect(useTabsStore().tabs.some((t) => t.id === tab.id)).toBe(false)
  })

  it('closes an idle session without asking', async () => {
    setupDom()
    seedPg()
    const invoke = mockBridge(pgHandlers())
    const tab = openTab({ kind: 'query', title: 'q', connectionId: 'pg', database: 'app' })
    expect(await useTabActions().requestClose(tab.id)).toBe(true)
    expect(transactionPrompt.open).toBe(false)
    expect(invoke).toHaveBeenCalledWith('db:closeSession', 'pg', tab.id)
  })
})

describe('EditableResult on PostgreSQL', () => {
  it('reads the source table with { database, schema } and skips the alias check', async () => {
    const pinia = setupDom()
    seedPg()
    const { default: EditableResult } =
      await import('@renderer/components/query/EditableResult.vue')
    const invoke = mockBridge({
      'db:tableStructure': () => ({
        schema: 'sales',
        database: 'app',
        name: 'Items',
        kind: 'table',
        columns: [],
        indexes: [
          {
            name: 'items_pkey',
            unique: true,
            type: 'btree',
            columns: ['id'],
            comment: '',
            primary: true
          }
        ],
        foreignKeys: [],
        engine: null,
        collation: null,
        comment: '',
        autoIncrement: null,
        createSql: ''
      })
    })
    const wrapper = await mountComponent(
      EditableResult,
      {
        connectionId: 'pg',
        sql: 'SELECT i.id, i.label FROM "Items" AS i',
        columns: [
          {
            name: 'id',
            type: 'integer',
            schema: 'sales',
            table: 'Items',
            sourceName: 'id',
            primaryKey: true,
            database: 'app'
          },
          {
            name: 'label',
            type: 'text',
            schema: 'sales',
            table: 'Items',
            sourceName: 'label',
            database: 'app'
          }
        ],
        rows: [[1, 'a']],
        truncated: false
      },
      pinia
    )
    expect(invoke).toHaveBeenCalledWith(
      'db:tableStructure',
      'pg',
      { database: 'app', schema: 'sales' },
      'Items'
    )
    expect(wrapper.get('[data-test="editability"]').text()).toContain('Editable · sales.Items')
    wrapper.unmount()
  })

  it('fills a foreign key from the referenced table in its own schema of the same database', async () => {
    const pinia = setupDom()
    seedPg()
    const { default: EditableResult } =
      await import('@renderer/components/query/EditableResult.vue')
    const column = (name: string, columnType: string) => ({
      name,
      ordinal: 1,
      columnType,
      dataType: columnType,
      nullable: true,
      key: '',
      defaultValue: null,
      extra: '',
      characterSet: null,
      collation: null,
      comment: ''
    })
    const invoke = mockBridge({
      'db:tableStructure': () => ({
        schema: 'sales',
        database: 'app',
        name: 'Items',
        kind: 'table',
        columns: [column('id', 'integer'), column('category_id', 'integer')],
        indexes: [
          {
            name: 'items_pkey',
            unique: true,
            type: 'btree',
            columns: ['id'],
            comment: '',
            primary: true
          }
        ],
        foreignKeys: [
          {
            name: 'items_category_fk',
            columns: ['category_id'],
            referencedSchema: 'catalog',
            referencedTable: 'categories',
            referencedColumns: ['id'],
            onUpdate: 'NO ACTION',
            onDelete: 'NO ACTION'
          }
        ],
        engine: null,
        collation: null,
        comment: '',
        autoIncrement: null,
        createSql: ''
      }),
      'db:tableData': () => ({
        columns: [{ name: 'id', type: 'integer', typeKind: 'integer' }],
        rows: [[3], [4]],
        primaryKey: ['id'],
        total: 2,
        durationMs: 1
      })
    })
    const meta = { schema: 'sales', table: 'Items', database: 'app' }
    const wrapper = await mountComponent(
      EditableResult,
      {
        connectionId: 'pg',
        sql: 'SELECT id, category_id FROM sales."Items"',
        columns: [
          { name: 'id', type: 'integer', sourceName: 'id', primaryKey: true, ...meta },
          { name: 'category_id', type: 'integer', sourceName: 'category_id', ...meta }
        ],
        rows: [[1, 3]],
        truncated: false
      },
      pinia
    )
    expect(wrapper.find('[data-test="fk-icon-category_id"]').exists()).toBe(true)
    await wrapper.get('[data-test="cell-0-1"]').trigger('click')
    await wrapper.get('[data-test="cell-0-1"] [data-test="fk-open"]').trigger('click')
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith(
      'db:tableData',
      'pg',
      expect.objectContaining({
        schema: { database: 'app', schema: 'catalog' },
        table: 'categories'
      })
    )
    wrapper.unmount()
  })
})
