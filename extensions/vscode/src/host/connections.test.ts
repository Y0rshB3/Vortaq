import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import {
  CredentialStore,
  DB_PASSWORD,
  plainCodec,
  type ConnectionConfig,
  type VortaqCore
} from '@core'
import { ConnectionService } from './connections'

function connection(savePassword: boolean): ConnectionConfig {
  return {
    id: 'c1',
    name: 'Tienda',
    engine: 'mysql',
    environment: 'local',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
    authMode: 'password',
    savePassword,
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      savePassword: false
    }
  } as ConnectionConfig
}

describe('ConnectionService passwords', () => {
  let dir: string
  let credentials: CredentialStore
  let open: boolean
  let core: VortaqCore & { invoke: ReturnType<typeof vi.fn> }

  function service(config: ConnectionConfig): ConnectionService {
    core = {
      context: { connections: { get: () => config }, credentials },
      connections: { isOpen: () => open },
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
        if (channel === 'connections:hasPassword')
          return credentials.has(DB_PASSWORD, args[0] as string)
        if (channel === 'connections:setPassword')
          return credentials.set(DB_PASSWORD, args[0] as string, args[1] as string)
        if (channel === 'connections:open') {
          open = true
          return { version: '8.4' }
        }
        if (channel === 'connections:close') open = false
        return undefined
      })
    } as unknown as VortaqCore & { invoke: ReturnType<typeof vi.fn> }
    const output = { info: vi.fn(), warn: vi.fn() } as unknown as vscode.LogOutputChannel
    return new ConnectionService(core, null, output)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-ext-conn-'))
    credentials = new CredentialStore(dir, plainCodec, 'plain')
    open = false
    vi.mocked(vscode.window.showInputBox).mockReset()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('asks once for a missing password and stores it encrypted when the connection saves it', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('s3creta' as never)
    const svc = service(connection(true))
    expect(await svc.open('c1')).toEqual({ version: '8.4' })
    expect(core.invoke).toHaveBeenCalledWith('connections:setPassword', 'c1', 's3creta')
    expect(credentials.get(DB_PASSWORD, 'c1')).toBe('s3creta')
    await svc.close('c1')
    expect(credentials.has(DB_PASSWORD, 'c1')).toBe(true)
  })

  it('keeps the password of a connection that does not save it in memory only, until it closes', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('s3creta' as never)
    const svc = service(connection(false))
    await svc.open('c1')
    expect(core.invoke).not.toHaveBeenCalledWith('connections:setPassword', 'c1', 's3creta')
    expect(credentials.get(DB_PASSWORD, 'c1')).toBe('s3creta')
    // Never on disk: another process (or the next start after a crash) has nothing.
    expect(credentials.rawItems()).toEqual({})
    expect(new CredentialStore(dir, plainCodec, 'plain').has(DB_PASSWORD, 'c1')).toBe(false)
    await svc.close('c1')
    expect(credentials.has(DB_PASSWORD, 'c1')).toBe(false)
  })

  it('a pool closed by a save forgets the in-memory password too', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('s3creta' as never)
    const svc = service(connection(false))
    await svc.open('c1')
    open = false // connections:save with a new endpoint closed it, without an event
    svc.refreshAll()
    expect(credentials.has(DB_PASSWORD, 'c1')).toBe(false)
  })

  it('dismissing the prompt opens nothing', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined as never)
    const svc = service(connection(true))
    expect(await svc.open('c1')).toBeNull()
    expect(core.invoke).not.toHaveBeenCalledWith('connections:open', 'c1')
  })
})
