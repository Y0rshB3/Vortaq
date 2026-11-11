import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import {
  createCore,
  defaultSqliteOptions,
  inProcessSpawner,
  plainCodec,
  type ConnectionInput,
  type VortaqCore
} from '@core'
import {
  coreMcpPorts,
  MCP_KEY_SECRET,
  McpService,
  registerMcpProvider,
  TAKEOVER_INTERVAL_MS,
  type McpServerPorts,
  type McpSettings
} from './mcp'
import { DEFAULT_MCP_PORT } from './settings'

function fakeSecrets() {
  const values = new Map<string, string>()
  const changed = new vscode.EventEmitter<{ key: string }>()
  const secrets = {
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => {
      values.set(key, value)
      changed.fire({ key })
    },
    delete: async (key: string) => {
      values.delete(key)
      changed.fire({ key })
    },
    onDidChange: changed.event
  } as unknown as vscode.SecretStorage
  return { values, secrets, changed }
}

/** Ports that are free, taken by another program, or served by another window (ping true). */
function fakePorts(taken = new Map<number, 'other' | 'vortaq'>()) {
  const listening = new Set<number>()
  const ports = {
    listening,
    taken,
    listen: vi.fn(async (port: number) => {
      if (taken.has(port) || listening.has(port))
        throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
      listening.add(port)
      return {
        port,
        close: vi.fn(async () => {
          listening.delete(port)
        })
      }
    }),
    ping: vi.fn(async (port: number) => taken.get(port) === 'vortaq'),
    release: vi.fn(async () => undefined)
  }
  return ports satisfies McpServerPorts
}

function serviceWith(settings: McpSettings, ports: McpServerPorts = fakePorts()) {
  const { secrets, values, changed } = fakeSecrets()
  let current = settings
  const service = new McpService({
    secrets,
    settings: () => current,
    platform: 'darwin',
    ports,
    log: () => undefined
  })
  return {
    service,
    values,
    secrets,
    changed,
    set: (next: McpSettings) => {
      current = next
    }
  }
}

describe('McpService (agents in the editor)', () => {
  const disposables: { dispose(): void }[] = []
  afterEach(() => {
    for (const d of disposables.splice(0)) d.dispose()
    vi.useRealTimers()
  })

  it('stays off without vortaq.mcp.enabled: no port, no key, no endpoint', async () => {
    const ports = fakePorts()
    const { service, values } = serviceWith({ enabled: false, port: DEFAULT_MCP_PORT }, ports)
    disposables.push(service)
    await service.refresh()
    expect(service.current).toEqual({ kind: 'off' })
    expect(service.endpoint()).toBeNull()
    expect(ports.listen).not.toHaveBeenCalled()
    expect(values.size).toBe(0)
  })

  it('serves on the configured port with a random key kept in SecretStorage', async () => {
    const { service, values } = serviceWith({ enabled: true, port: 40000 })
    disposables.push(service)
    await service.refresh()
    expect(service.current).toEqual({ kind: 'serving', port: 40000 })
    const key = values.get(MCP_KEY_SECRET)!
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(service.endpoint()).toEqual({
      url: 'http://127.0.0.1:40000/mcp',
      key,
      platform: 'darwin'
    })
    // Applying the same settings again keeps the server as it is.
    await service.refresh()
    expect(service.current).toEqual({ kind: 'serving', port: 40000 })
  })

  it('never moves to another port: a port another program holds keeps agents off until it is free', async () => {
    vi.useFakeTimers()
    const taken = new Map<number, 'other' | 'vortaq'>([[40000, 'other']])
    const ports = fakePorts(taken)
    const { service } = serviceWith({ enabled: true, port: 40000 }, ports)
    disposables.push(service)
    const done = service.refresh()
    await vi.advanceTimersByTimeAsync(400)
    await done
    expect(service.current).toEqual({ kind: 'busy', port: 40000 })
    expect(service.endpoint()).toBeNull()
    expect(service.describe()).toMatch(
      /40000 lo usa otro programa.*vortaq\.mcp\.port.*regenera la clave/
    )
    expect(ports.listen.mock.calls.map((c) => c[0])).toEqual([40000, 40000])

    taken.delete(40000)
    await vi.advanceTimersByTimeAsync(TAKEOVER_INTERVAL_MS + 10)
    expect(service.current).toEqual({ kind: 'serving', port: 40000 })
  })

  it('says what to do when the editor cannot store the key', async () => {
    const ports = fakePorts()
    const { service, secrets } = serviceWith({ enabled: true, port: 40000 }, ports)
    disposables.push(service)
    secrets.store = async () => {
      throw new Error('no keyring')
    }
    await service.refresh()
    expect(service.current.kind).toBe('failed')
    expect(service.describe()).toMatch(/almacén seguro del editor .*llavero/)
    expect(ports.listen).not.toHaveBeenCalled()
  })

  it('uses another window that already serves, and takes the port over when it closes', async () => {
    vi.useFakeTimers()
    const taken = new Map<number, 'other' | 'vortaq'>([[40000, 'vortaq']])
    const ports = fakePorts(taken)
    const { service } = serviceWith({ enabled: true, port: 40000 }, ports)
    disposables.push(service)
    await service.refresh()
    expect(service.current).toEqual({ kind: 'elsewhere', port: 40000 })
    expect(service.endpoint()?.url).toBe('http://127.0.0.1:40000/mcp')
    expect(service.describe()).toContain('otra ventana')

    taken.delete(40000)
    await vi.advanceTimersByTimeAsync(TAKEOVER_INTERVAL_MS + 10)
    expect(service.current).toEqual({ kind: 'serving', port: 40000 })
    expect(ports.listening.has(40000)).toBe(true)
  })

  it('stops, closes the agents’ connections and moves with the settings', async () => {
    const ports = fakePorts()
    const { service, set } = serviceWith({ enabled: true, port: 40000 }, ports)
    disposables.push(service)
    await service.refresh()
    set({ enabled: true, port: 45000 })
    await service.refresh()
    expect(service.current).toEqual({ kind: 'serving', port: 45000 })
    expect(ports.listening.has(40000)).toBe(false)
    set({ enabled: false, port: 45000 })
    await service.refresh()
    expect(service.current).toEqual({ kind: 'off' })
    expect(ports.listening.size).toBe(0)
    expect(ports.release).toHaveBeenCalled()
  })

  it('regenerates the key, and follows a key another window regenerated', async () => {
    const { service, values, secrets } = serviceWith({ enabled: true, port: 40000 })
    disposables.push(service)
    await service.refresh()
    const first = service.endpoint()!.key
    const fired = vi.fn()
    disposables.push(service.onDidChange(fired))
    await service.regenerateKey()
    const second = service.endpoint()!.key
    expect(second).not.toBe(first)
    expect(values.get(MCP_KEY_SECRET)).toBe(second)
    expect(fired).toHaveBeenCalled()

    // Another window stores a new key: this one answers with it.
    await secrets.store(MCP_KEY_SECRET, 'clave-de-otra-ventana')
    await service.refresh()
    expect(service.endpoint()!.key).toBe('clave-de-otra-ventana')
  })

  it('registers «Vortaq» with the editor: nothing while off, the URL and key header while on', async () => {
    const { service, set } = serviceWith({ enabled: false, port: 40000 })
    disposables.push(service)
    const registration = registerMcpProvider(service, '0.6.0')
    expect(registration).not.toBeNull()
    const register = vi.mocked(vscode.lm.registerMcpServerDefinitionProvider)
    const [id, provider] = register.mock.calls.at(-1) as unknown as [
      string,
      vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition>
    ]
    expect(id).toBe('vortaq')
    await service.refresh()
    expect(provider.provideMcpServerDefinitions(undefined as never)).toEqual([])
    await expect(
      Promise.resolve(
        provider.resolveMcpServerDefinition!(
          new vscode.McpHttpServerDefinition('Vortaq', vscode.Uri.parse('http://x')),
          undefined as never
        )
      )
    ).rejects.toThrow(/Vortaq: Agentes \(MCP\)…/)

    set({ enabled: true, port: 40000 })
    await service.refresh()
    const [definition] = provider.provideMcpServerDefinitions(
      undefined as never
    ) as vscode.McpHttpServerDefinition[]
    expect(definition.label).toBe('Vortaq')
    expect(definition.uri.toString()).toBe('http://127.0.0.1:40000/mcp')
    expect(definition.version).toBe('0.6.0')
    // The listed definition never carries the key (the editor may cache it)…
    expect(definition.headers).toEqual({})
    // …a new one with the key is returned when the editor starts the server.
    const resolved = (await provider.resolveMcpServerDefinition!(
      definition,
      undefined as never
    )) as vscode.McpHttpServerDefinition
    expect(resolved).not.toBe(definition)
    expect(definition.headers).toEqual({})
    expect(resolved.headers).toEqual({ Authorization: `Bearer ${service.endpoint()!.key}` })
    expect(resolved.uri.toString()).toBe('http://127.0.0.1:40000/mcp')
  })

  it('leaves the editor alone when it has no MCP provider API', () => {
    const { service } = serviceWith({ enabled: true, port: 40000 })
    disposables.push(service)
    const lm = (vscode as unknown as { lm: { registerMcpServerDefinitionProvider?: unknown } }).lm
    const original = lm.registerMcpServerDefinitionProvider
    lm.registerMcpServerDefinitionProvider = undefined
    try {
      expect(registerMcpProvider(service, '0.6.0')).toBeNull()
    } finally {
      lm.registerMcpServerDefinitionProvider = original
    }
  })
})

function sqliteInput(
  name: string,
  filePath: string,
  mcp?: ConnectionInput['mcp']
): ConnectionInput {
  return {
    name,
    color: null,
    environment: 'local',
    host: '',
    port: 0,
    username: '',
    authMode: 'none',
    savePassword: false,
    customDatabases: [],
    initialQueries: '',
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      savePassword: false
    },
    ssl: { enabled: false, verifyServer: false },
    backupDir: '',
    extraBackupDirs: [],
    engine: 'sqlite',
    sqlite: { ...defaultSqliteOptions(false), filePath },
    ...(mcp ? { mcp } : {})
  }
}

/** A JSON-RPC answer of the server: free-form, the assertions say what it holds. */
interface RpcAnswer {
  status: number
  json: { result: { content: { text: string }[] } } | null
}

function post(port: number, key: string, body: unknown): Promise<RpcAnswer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null })
        })
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

describe('coreMcpPorts (the extension core behind the HTTP server)', () => {
  let dir: string
  let core: VortaqCore

  afterEach(async () => {
    await core?.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('answers with the extension’s own connections, and only the ones made available', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-ext-mcp-'))
    const file = join(dir, 'tienda.db')
    const db = new DatabaseSync(file)
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'uno');")
    db.close()
    core = createCore({
      dataDir: join(dir, 'profile'),
      secrets: { codec: plainCodec, codecName: 'plain' },
      sqliteSpawner: inProcessSpawner(),
      log: { filePath: null, minLevel: 'error' }
    })
    await core.invoke(
      'connections:save',
      sqliteInput('Tienda', file, { enabled: true, access: 'read' })
    )
    await core.invoke('connections:save', sqliteInput('Privada', file))
    core.context.settings.update({ mcpEnabled: true })

    const lines: string[] = []
    const ports = coreMcpPorts(core, '0.6.0', (line) => lines.push(line))
    const listener = await ports.listen(0, () => 'k')
    try {
      expect(await ports.ping(listener.port, 'k')).toBe(true)
      const listed = await post(listener.port, 'k', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_connections', arguments: {} }
      })
      expect(listed.status).toBe(200)
      const text = listed.json!.result.content[0].text
      expect(text).toContain('Tienda')
      expect(text).not.toContain('Privada')
      const rows = await post(listener.port, 'k', {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'run_query', arguments: { connection: 'Tienda', sql: 'SELECT v FROM t' } }
      })
      expect(JSON.parse(rows.json!.result.content[0].text).rows).toEqual([['uno']])
      // The agents' connection is its own: the user's core has nothing open.
      const id = core.context.connections.findByName('Tienda')!.id
      expect(core.connections.isOpen(id)).toBe(false)
      expect(lines.some((l) => /tool=run_query .*outcome=ok/.test(l))).toBe(true)
      expect(lines.join('\n')).not.toContain('SELECT')
      expect(
        (await post(listener.port, 'otra', { jsonrpc: '2.0', id: 3, method: 'tools/list' })).status
      ).toBe(401)
    } finally {
      await listener.close()
      await ports.release()
    }
  })
})
