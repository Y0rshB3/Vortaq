/**
 * The results webview mounted in jsdom with a fake host: «Exportar» is offered
 * (toolbar and grid menu), the dialog goes through the host's save dialog and
 * export:* channels, a full export shows its progress with «Cancelar», and the
 * dialog's own «filas exportadas» notice is left to the host.
 */
import { effectScope, type EffectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcEventMap, VortaqApi } from '@shared/ipc'
import type { ConnectionConfig, ProgressEvent, QueryStatementResult } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { mountComponent, setupDom } from '@renderer/views/__tests__/helpers'
import type { WebviewMessage } from '../../protocol'
import type { ResultsState } from '../../webviewState'
import type { WebviewHost } from '../bridge'
import { forwardNotifications } from '../notifications'
import { isExportDoneNotice } from './exportNotices'
import ResultsApp from './ResultsApp.vue'

const connection = {
  id: 'c1',
  name: 'Tienda (local)',
  environment: 'local',
  engine: 'mysql'
} as ConnectionConfig

const SQL = 'SELECT id, nombre FROM clientes ORDER BY id'
const result: QueryStatementResult = {
  sql: SQL,
  durationMs: 2,
  affectedRows: null,
  insertId: null,
  changedRows: null,
  warnings: 0,
  error: null,
  resultSet: {
    columns: [
      { name: 'id', type: 'INT', table: 'clientes', schema: 'tienda', sourceName: 'id' },
      { name: 'nombre', type: 'VARCHAR', table: 'clientes', schema: 'tienda', sourceName: 'nombre' }
    ],
    rows: [
      [1, 'Lucía Fernández'],
      [2, 'Mateo Ruiz']
    ],
    truncated: false
  }
}

const state: ResultsState = {
  kind: 'sql',
  runId: 1,
  title: 'Resultados · clientes.sql',
  connection,
  target: 'tienda',
  platform: 'darwin',
  settings: {
    typedConfirmEnvironments: ['production'],
    confirmDestructiveEverywhere: true,
    defaultRowLimit: 1000
  },
  running: false,
  results: [result],
  script: SQL,
  context: 'tienda',
  totalMs: 2,
  notice: null,
  documents: null,
  canStop: false
}

type Listener = (payload: unknown) => void

/** The host side as the webview sees it: invoke answers, posted messages, pushed events. */
function fakeHost(answers: Record<string, (...args: unknown[]) => unknown>) {
  const posted: WebviewMessage[] = []
  const listeners = new Map<string, Set<Listener>>()
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const answer = answers[channel]
    if (!answer) throw new Error(`Esta vista no puede usar esa operación (${channel}).`)
    return answer(...args)
  })
  const api = {
    platform: 'darwin',
    invoke,
    on: (channel: string, listener: Listener) => {
      const set = listeners.get(channel) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(channel, set)
      return () => set.delete(listener)
    }
  } as unknown as VortaqApi
  const host: WebviewHost<ResultsState> = {
    api,
    post: (message) => posted.push(message),
    confirm: async () => true,
    ready: async () => state,
    onState: () => undefined
  }
  const emit = <E extends keyof IpcEventMap>(channel: E, payload: IpcEventMap[E]): void => {
    for (const listener of listeners.get(channel) ?? []) listener(payload)
  }
  return { host, posted, invoke, emit }
}

const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]

describe('extension results webview: «Exportar»', () => {
  let wrapper: Awaited<ReturnType<typeof mountComponent>> | null = null
  // One page = one notification forwarder (the queue is module-wide): stopped after each test.
  let notices: EffectScope | null = null

  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })
  afterEach(() => {
    wrapper?.unmount()
    notices?.stop()
  })

  async function mount(answers: Record<string, (...args: unknown[]) => unknown>) {
    const pinia = setupDom()
    const fake = fakeHost({
      // Editability check: unknown table → read-only, still exportable.
      'db:tableStructure': () => {
        throw new Error('sin estructura')
      },
      ...answers
    })
    window.vortaq = fake.host.api
    useConnectionsStore().items = [connection]
    notices = effectScope()
    notices.run(() => forwardNotifications(fake.host, isExportDoneNotice))
    wrapper = await mountComponent(ResultsApp, { host: fake.host, initial: state }, pinia)
    await flushPromises()
    return fake
  }

  it('offers «Exportar» in the result toolbar and the grid menu', async () => {
    await mount({})
    expect($('[data-test="tab-rs0"]')?.classList.contains('v-tab--selected')).toBe(true)
    expect($('[data-test="export"]')?.textContent).toContain('Exportar')
    $('[data-test="cell-0-1"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    )
    await flushPromises()
    expect($('[data-test="menu-copy-as"]')).not.toBeNull()
    expect($('[data-test="menu-export-selection"]')).not.toBeNull()
    expect($('[data-test="menu-export-all"]')).not.toBeNull()
  })

  it('exports the loaded rows through the host’s save dialog; the host announces the file', async () => {
    const fake = await mount({
      'app:pickSaveFile': () => '/tmp/out/clientes.csv',
      'export:rows': (request) => ({
        filePath: (request as { filePath: string }).filePath,
        rows: 2,
        bytes: 40,
        durationMs: 1,
        truncatedCells: 0
      })
    })
    $('[data-test="export"]')!.click()
    await flushPromises()
    expect($('[data-test="export-dialog"]')).not.toBeNull()
    // The script is one read-only SELECT: «Resultado completo» is available.
    expect(($('[data-test="export-scope-full"] input') as HTMLInputElement).disabled).toBe(false)
    $('[data-test="export-run"]')!.click()
    await flushPromises()
    const save = fake.invoke.mock.calls.find((c) => c[0] === 'app:pickSaveFile')!
    expect(save.slice(2)).toEqual(['clientes.csv', [{ name: 'CSV', extensions: ['csv'] }]])
    const rows = fake.invoke.mock.calls.find((c) => c[0] === 'export:rows')![1] as {
      filePath: string
      rows: unknown[][]
      options: { format: string; dialect: string }
    }
    expect(rows.filePath).toBe('/tmp/out/clientes.csv')
    expect(rows.rows).toEqual([
      [1, 'Lucía Fernández'],
      [2, 'Mateo Ruiz']
    ])
    expect(rows.options).toMatchObject({ format: 'csv', dialect: 'mysql' })
    await flushPromises()
    // The dialog's «2 filas exportadas» (with a button this page would run) is not forwarded.
    expect(fake.posted.filter((m) => m.type === 'notify')).toEqual([])
  })

  it('a full export runs in the run’s database, shows its progress and can be cancelled', async () => {
    const fake = await mount({
      'app:pickSaveFile': () => '/tmp/out/clientes.json',
      'export:query': () => new Promise(() => undefined),
      'export:cancel': () => undefined
    })
    $('[data-test="export"]')!.click()
    await flushPromises()
    $('[data-test="export-format-json"]')!.click()
    ;($('[data-test="export-scope-full"] input') as HTMLInputElement).click()
    await flushPromises()
    $('[data-test="export-run"]')!.click()
    await flushPromises()
    const [, operationId, request] = fake.invoke.mock.calls.find((c) => c[0] === 'export:query')!
    expect(request).toMatchObject({
      connectionId: 'c1',
      filePath: '/tmp/out/clientes.json',
      source: { kind: 'statement', sql: SQL, context: 'tienda' },
      options: { format: 'json' }
    })
    const progress: ProgressEvent = {
      operationId: operationId as string,
      kind: 'export',
      phase: 'rows',
      current: 1500,
      total: null,
      message: '1.500 filas escritas',
      done: false
    }
    fake.emit('event:progress', progress)
    await flushPromises()
    expect($('[data-test="results-exports"]')?.textContent).toContain('1.500 filas escritas')
    $$('[data-test="operation-cancel"]')[0].click()
    await flushPromises()
    expect(fake.invoke).toHaveBeenCalledWith('export:cancel', operationId)
    fake.emit('event:progress', { ...progress, phase: 'cancelled', done: true, error: 'x' })
    await flushPromises()
    expect($('[data-test="results-exports"]')).toBeNull()
  })

  it('forwards the other notices (errors) to the host', async () => {
    const fake = await mount({
      'app:pickSaveFile': () => '/tmp/out/clientes.csv',
      'export:query': () => {
        throw new Error('Ya hay una exportación en curso con ese identificador.')
      }
    })
    $('[data-test="export"]')!.click()
    await flushPromises()
    ;($('[data-test="export-scope-full"] input') as HTMLInputElement).click()
    await flushPromises()
    $('[data-test="export-run"]')!.click()
    await flushPromises()
    expect(fake.posted).toContainEqual({
      type: 'notify',
      level: 'error',
      message: 'Ya hay una exportación en curso con ese identificador.'
    })
  })
})
