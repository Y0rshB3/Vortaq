import { afterEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import { UNTRUSTED_CERTIFICATE } from '@shared/sqlserver/certificate'
import type { LocalSqlServerScan } from '@shared/sqlserver/local'
import type { ConnectionInput } from '@shared/types'
import { useUiStore } from '@renderer/stores/ui'
import ConnectionDialog from './ConnectionDialog.vue'
import { freshPinia, makeConnection, mockVortaq, mountWith, settle } from './testing'

const CERT_ERROR = `${UNTRUSTED_CERTIFICATE}. Detalle: self-signed certificate (ETLS)`

const SCAN: LocalSqlServerScan = {
  supported: true,
  browserRunning: false,
  windowsDomain: 'PC-ANA',
  windowsUser: 'ana',
  problem: null,
  instances: [
    {
      instance: 'SQLEXPRESS',
      running: true,
      version: '2022',
      configManager: 'SQLServerManager16.msc',
      tcp: 'disabled',
      tcpPort: null
    }
  ]
}

describe('ConnectionDialog · SQL Server on a local Windows', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null
  afterEach(() => wrapper?.unmount())

  async function openNew(
    handlers: Record<string, (...args: unknown[]) => unknown>,
    platform = 'win32'
  ): Promise<void> {
    invoke = mockVortaq({
      'connections:hasPassword': () => false,
      'connections:hasSshPassword': () => false,
      'connections:hasSslKeyPassword': () => false,
      ...handlers
    })
    ;(window.vortaq as unknown as { platform: string }).platform = platform
    const pinia = freshPinia()
    useUiStore().connectionDialog = { open: true, editing: null, engine: 'sqlserver' }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
  }
  const testCalls = (): ConnectionInput[] =>
    invoke.mock.calls.filter((c) => c[0] === 'connections:test').map((c) => c[1] as ConnectionInput)

  it('offers «Confiar y reintentar» for an untrusted certificate and retries with the option on', async () => {
    let attempt = 0
    await openNew({
      'connections:test': () =>
        ++attempt === 1
          ? { ok: false, durationMs: 5, error: CERT_ERROR }
          : { ok: true, durationMs: 9, serverVersion: 'SQL Server 2022 (16.0.1000.6)' }
    })
    await wrapper!.get('[data-test="conn-test"]').trigger('click')
    await settle()
    expect(wrapper!.find('[data-test="conn-ms-trust-offer"]').exists()).toBe(true)
    await wrapper!.get('[data-test="conn-ms-trust-retry"]').trigger('click')
    await settle()
    expect(testCalls().map((c) => c.sqlserver?.trustServerCertificate)).toEqual([false, true])
    expect(wrapper!.find('[data-test="conn-ms-trust-offer"]').exists()).toBe(false)
    // The engine's own product name, never «MySQL».
    expect(wrapper!.get('[data-test="conn-test-result"]').text()).toContain(
      'Conectado · SQL Server 2022 (16.0.1000.6)'
    )
    expect(wrapper!.get('[data-test="conn-test-result"]').text()).not.toContain('MySQL')
  })

  it('finds the local instances, shows how to turn TCP/IP on and fills the form with «Usar»', async () => {
    await openNew({ 'sqlserver:localInstances': () => SCAN })
    await wrapper!.get('[data-test="conn-ms-local-scan"]').trigger('click')
    await settle()
    const row = wrapper!.get('[data-test="conn-ms-local-SQLEXPRESS"]')
    expect(row.text()).toContain('SQL Server 2022')
    expect(row.text()).toContain('TCP/IP desactivado')
    expect(row.text()).toContain('SQLServerManager16.msc')
    expect(row.text()).toContain('Protocolos de SQLEXPRESS › TCP/IP')
    await wrapper!.get('[data-test="conn-ms-local-use-SQLEXPRESS"]').trigger('click')
    await settle()
    expect(wrapper!.get('[data-test="conn-ms-local-chosen"]').text()).toContain('PC-ANA\\ana')
    await wrapper!.get('[data-test="conn-test"]').trigger('click')
    await settle()
    expect(testCalls()[0]).toMatchObject({
      host: '127.0.0.1',
      port: 1433,
      username: 'ana',
      name: 'SQL Server local (SQLEXPRESS)',
      sqlserver: {
        auth: 'windows',
        domain: 'PC-ANA',
        instanceName: '',
        trustServerCertificate: true
      }
    })
  })

  it('offers the scan after a refused connection on Windows, and nothing outside Windows', async () => {
    await openNew({
      'connections:test': () => ({
        ok: false,
        durationMs: 3,
        error:
          'Nadie acepta conexiones… Detalle: connect ECONNREFUSED 127.0.0.1:1433 (ECONNREFUSED)'
      }),
      'sqlserver:localInstances': () => SCAN
    })
    await wrapper!.get('[data-test="conn-test"]').trigger('click')
    await settle()
    await wrapper!.get('[data-test="conn-ms-refused-scan"]').trigger('click')
    await settle()
    expect(wrapper!.find('[data-test="conn-ms-local-SQLEXPRESS"]').exists()).toBe(true)
    expect(wrapper!.find('[data-test="conn-ms-refused-offer"]').exists()).toBe(false)
    wrapper!.unmount()

    await openNew({}, 'darwin')
    expect(wrapper!.find('[data-test="conn-ms-local-scan"]').exists()).toBe(false)
  })

  it('does not offer trust when it is already on or encryption is strict', async () => {
    const editing = makeConnection({
      id: 'ms1',
      name: 'Ventas',
      engine: 'sqlserver',
      port: 1433,
      sqlserver: {
        initialDatabase: '',
        auth: 'sql',
        domain: '',
        instanceName: '',
        encrypt: 'strict',
        trustServerCertificate: false,
        hostNameInCertificate: '',
        tenantId: '',
        clientId: '',
        showSystemObjects: false,
        readOnlyIntent: false
      }
    })
    invoke = mockVortaq({
      'connections:hasPassword': () => true,
      'connections:hasSshPassword': () => false,
      'connections:hasSslKeyPassword': () => false,
      'connections:test': () => ({ ok: false, durationMs: 5, error: CERT_ERROR })
    })
    const pinia = freshPinia()
    useUiStore().connectionDialog = { open: true, editing }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
    await wrapper.get('[data-test="conn-test"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="conn-ms-trust-offer"]').exists()).toBe(false)
  })
})
