import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectionsStore } from './connections'
import { useNotify } from '@renderer/composables/useNotify'
import { UNTRUSTED_CERTIFICATE } from '@shared/sqlserver/certificate'
import {
  installBridge,
  makeConnection,
  makeServerInfo,
  type MockBridge
} from '@renderer/__tests__/shellTestUtils'

describe('connections store', () => {
  let bridge: MockBridge

  beforeEach(() => {
    setActivePinia(createPinia())
    bridge = installBridge({
      'connections:list': [
        makeConnection({ id: 'b', name: 'Beta' }),
        makeConnection({ id: 'a', name: 'alfa', environment: 'production' })
      ],
      'connections:open': () => makeServerInfo(),
      'connections:save': (input: unknown) => ({
        ...(input as object),
        id: (input as { id?: string }).id ?? 'new-id'
      }),
      'connections:close': undefined,
      'connections:delete': undefined
    })
  })

  it('loads and sorts connections by name (Spanish collation, case-insensitive)', async () => {
    const store = useConnectionsStore()
    await store.load()
    expect(store.loaded).toBe(true)
    expect(store.sorted.map((c) => c.name)).toEqual(['alfa', 'Beta'])
    expect(store.isProduction('a')).toBe(true)
    expect(store.nameOf('missing')).toBe('missing')
  })

  it('after a window reload, shows as open the connections main still holds open', async () => {
    bridge = installBridge({
      'connections:list': [
        makeConnection({ id: 'b', name: 'Beta' }),
        makeConnection({ id: 'a', name: 'alfa' })
      ],
      'connections:isOpen': (id: unknown) => id === 'a',
      'connections:open': () => makeServerInfo()
    })
    const store = useConnectionsStore()
    await store.load()
    expect(store.isOpen('a')).toBe(true)
    expect(store.isOpen('b')).toBe(false)
  })

  it('opens a connection once and caches the server info', async () => {
    const store = useConnectionsStore()
    await store.load()
    await store.open('a')
    await store.open('a')
    expect(bridge.invoke.mock.calls.filter(([ch]) => ch === 'connections:open')).toHaveLength(1)
    expect(store.isOpen('a')).toBe(true)
    expect(store.openIds).toEqual(['a'])
  })

  it('reloads a connection stored as MariaDB when it opened (MySQL connection to MariaDB)', async () => {
    let promoted = false
    installBridge({
      'connections:list': () => [
        makeConnection({ id: 'm', name: 'Maria', engine: promoted ? 'mariadb' : 'mysql' })
      ],
      'connections:open': () => {
        promoted = true
        return makeServerInfo({ engine: 'mariadb' })
      }
    })
    const store = useConnectionsStore()
    await store.load()
    expect(store.get('m')?.engine).toBe('mysql')
    await store.open('m')
    expect(store.get('m')?.engine).toBe('mariadb')
    expect(useNotify().queue.at(-1)?.message).toContain('ahora es una conexión MariaDB')
  })

  it('clears the opening flag when opening fails', async () => {
    bridge = installBridge({
      'connections:open': () => {
        throw new Error('Access denied')
      }
    })
    const store = useConnectionsStore()
    await expect(store.open('a')).rejects.toThrow('Access denied')
    expect(store.opening.a).toBeUndefined()
    expect(store.isOpen('a')).toBe(false)
  })

  it('a SQL Server certificate error offers «Confiar en el certificado», which saves it and opens', async () => {
    const ms = makeConnection({
      id: 'ms',
      name: 'Express',
      engine: 'sqlserver',
      sqlserver: {
        initialDatabase: '',
        auth: 'windows',
        domain: 'PC',
        instanceName: '',
        encrypt: 'mandatory',
        trustServerCertificate: false,
        hostNameInCertificate: '',
        tenantId: '',
        clientId: '',
        showSystemObjects: false,
        readOnlyIntent: false
      }
    })
    let saved: { sqlserver?: { trustServerCertificate?: boolean } } | null = null
    bridge = installBridge({
      'connections:list': [ms],
      'connections:open': () => {
        if (!saved)
          throw new Error(`${UNTRUSTED_CERTIFICATE}. Detalle: self-signed certificate (ETLS)`)
        return makeServerInfo()
      },
      'connections:save': (input: unknown) => {
        saved = input as typeof saved
        return input
      }
    })
    const store = useConnectionsStore()
    await store.load()
    const notify = useNotify()
    const before = notify.queue.length
    await expect(store.open('ms')).rejects.toThrow(UNTRUSTED_CERTIFICATE)
    const notice = notify.queue[notify.queue.length - 1]
    expect(notify.queue.length).toBe(before + 1)
    expect(notice.action?.label).toBe('Confiar en el certificado')
    notice.action!.handler()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(saved!.sqlserver?.trustServerCertificate).toBe(true)
    expect(store.isOpen('ms')).toBe(true)
  })

  it('upserts saved connections and removes deleted ones', async () => {
    const store = useConnectionsStore()
    await store.load()
    const existing = store.get('a')!
    await store.save({ ...existing, name: 'renamed' })
    expect(store.get('a')!.name).toBe('renamed')
    expect(store.items).toHaveLength(2)

    await store.open('a')
    await store.remove('a')
    expect(store.get('a')).toBeUndefined()
    expect(store.isOpen('a')).toBe(false)
    expect(bridge.invoke).toHaveBeenCalledWith('connections:close', 'a')
    expect(bridge.invoke).toHaveBeenCalledWith('connections:delete', 'a')
  })

  it('marks connections closed and warns on event:connectionClosed', async () => {
    const store = useConnectionsStore()
    await store.load()
    await store.open('b')
    const dispose = store.listenToClosedEvents()
    bridge.emit('event:connectionClosed', { connectionId: 'b', reason: 'timeout' })
    expect(store.isOpen('b')).toBe(false)
    const last = useNotify().queue.at(-1)
    expect(last?.level).toBe('warning')
    expect(last?.message).toContain('Beta')
    dispose()
    expect(bridge.listenerCount('event:connectionClosed')).toBe(0)
  })
})
