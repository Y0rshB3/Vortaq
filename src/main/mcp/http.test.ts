/**
 * The loopback HTTP transport of the MCP server (the editor extension's), end
 * to end with the SDK's Streamable HTTP client against a real SQLite file:
 * the key, Host and Origin checks, stateless requests, the ping another
 * window uses, limits, a busy port, and the editor's wording.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultSqliteOptions } from '@shared/engines'
import type { ConnectionInput } from '@shared/types'
import { plainCodec } from '../credentials/store'
import { inProcessSpawner, setSqliteSpawner } from '../sqlite/spawner'
import { setJsonStoreReload } from '../storage/jsonStore'
import { ConnectionsRepo, SettingsRepo } from '../storage/repos'
import { EDITOR_MCP_WORDING } from './access'
import { createMcpContext } from './context'
import {
  hostAllowed,
  keyMatches,
  MAX_BODY_BYTES,
  MCP_KEY_REFUSED,
  originAllowed,
  pingMcpHttp,
  pingProof,
  startMcpHttpServer,
  type McpHttpServer
} from './http'
import { McpRuntime } from './runtime'
import type { McpActivity } from './server'

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

interface RawAnswer {
  status: number
  body: string
}

/** A request with full control of the headers (fetch would set Host and Origin itself). */
function raw(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string }
): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/mcp',
        headers: options.headers ?? {}
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '1' }
  }
})
const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream'
}

describe('MCP server over loopback HTTP (editor extension)', () => {
  let dir: string
  let profile: string
  let runtime: McpRuntime
  let server: McpHttpServer
  let key = 'clave-de-prueba-1'
  const activity: McpActivity[] = []
  const clients: Client[] = []

  async function connect(withKey: string | null): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: withKey ? { headers: { Authorization: `Bearer ${withKey}` } } : {}
    })
    const client = new Client({ name: 'vitest-http', version: '1.0.0' })
    await client.connect(transport)
    clients.push(client)
    return client
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-mcp-http-'))
    profile = join(dir, 'profile')
    const file = join(dir, 'tienda.db')
    const db = new DatabaseSync(file)
    db.exec(`CREATE TABLE clientes (id INTEGER PRIMARY KEY, nombre TEXT);
      INSERT INTO clientes VALUES (1, 'Ana'), (2, 'Luis');`)
    db.close()
    const repo = new ConnectionsRepo(profile)
    repo.save(sqliteInput('Tienda', file, { enabled: true, access: 'read' }))
    repo.save(sqliteInput('Oculta', file, { enabled: false, access: 'read' }))
    new SettingsRepo(profile, dir).update({ mcpEnabled: true })

    setSqliteSpawner(inProcessSpawner())
    setJsonStoreReload(true)
    const ctx = createMcpContext({
      profileDir: profile,
      secrets: { codec: plainCodec, codecName: 'plain' },
      home: dir
    })
    runtime = new McpRuntime(ctx, { wording: EDITOR_MCP_WORDING })
    server = await startMcpHttpServer(runtime, {
      port: 0,
      key: () => key,
      version: '0.6.0-test',
      onActivity: (e) => activity.push(e)
    })
  })

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined)
    await server?.close()
    await runtime?.dispose()
    setJsonStoreReload(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('listens on 127.0.0.1 and answers the SDK client with the key', async () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/mcp`)
    const client = await connect(key)
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toContain('run_query')
    expect(client.getInstructions()).toContain('the Vortaq editor extension')
    const listed = await client.callTool({ name: 'list_connections', arguments: {} })
    const text = (listed as { content: { text: string }[] }).content[0].text
    expect(text).toContain('Tienda')
    expect(text).not.toContain('Oculta')
    const rows = (await client.callTool({
      name: 'run_query',
      arguments: { connection: 'Tienda', sql: 'SELECT nombre FROM clientes ORDER BY id' }
    })) as { isError?: boolean; content: { text: string }[] }
    expect(rows.isError).toBeFalsy()
    expect(JSON.parse(rows.content[0].text).rows).toEqual([['Ana'], ['Luis']])
    expect(activity.some((a) => a.tool === 'run_query' && a.outcome === 'ok')).toBe(true)
  })

  it('refuses a request without the key, with another key, or with a malformed header', async () => {
    await expect(connect(null)).rejects.toThrow()
    await expect(connect('otra-clave')).rejects.toThrow()
    const noKey = await raw(server.port, {
      headers: { ...MCP_HEADERS, Host: `127.0.0.1:${server.port}` },
      body: INIT
    })
    expect(noKey.status).toBe(401)
    expect(JSON.parse(noKey.body).error.message).toBe(MCP_KEY_REFUSED)
    expect(keyMatches(`Basic ${key}`, key)).toBe(false)
    expect(keyMatches(`Bearer ${key}`, null)).toBe(false)
    expect(keyMatches(`bearer   ${key}`, key)).toBe(true)
    expect(keyMatches(`Bearer ${key}x`, key)).toBe(false)
  })

  it('takes a new key at once and refuses the old one (stateless: no session to lose)', async () => {
    const old = key
    key = 'clave-de-prueba-2'
    try {
      await expect(connect(old)).rejects.toThrow()
      const client = await connect(key)
      expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    } finally {
      key = old
    }
  })

  it('refuses other Host names (DNS rebinding) and web pages (Origin)', async () => {
    const auth = { ...MCP_HEADERS, Authorization: `Bearer ${key}` }
    const rebinding = await raw(server.port, {
      headers: { ...auth, Host: `vortaq.attacker.test:${server.port}` },
      body: INIT
    })
    expect(rebinding.status).toBe(403)
    const page = await raw(server.port, {
      headers: { ...auth, Host: `localhost:${server.port}`, Origin: 'https://example.test' },
      body: INIT
    })
    expect(page.status).toBe(403)
    const ok = await raw(server.port, {
      headers: { ...auth, Host: `localhost:${server.port}` },
      body: INIT
    })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body).result.serverInfo.name).toBe('vortaq')
    expect(hostAllowed(`127.0.0.1:${server.port + 1}`, server.port)).toBe(false)
    expect(originAllowed('null')).toBe(false)
    expect(originAllowed('vscode-webview://abc')).toBe(false)
    expect(originAllowed('vscode-file://vscode-app')).toBe(true)
  })

  it('answers only POST /mcp and the ping, and limits the body size', async () => {
    const auth = { Authorization: `Bearer ${key}`, Host: `127.0.0.1:${server.port}` }
    expect((await raw(server.port, { method: 'GET', headers: auth })).status).toBe(405)
    expect((await raw(server.port, { method: 'DELETE', headers: auth })).status).toBe(405)
    expect((await raw(server.port, { path: '/otra', headers: auth, body: INIT })).status).toBe(404)
    // A client looking for OAuth after a 401 finds nothing to follow.
    expect(
      (await raw(server.port, { method: 'GET', path: '/.well-known/oauth-protected-resource' }))
        .status
    ).toBe(404)
    const big = await raw(server.port, {
      headers: { ...auth, ...MCP_HEADERS },
      body: `{"x":"${'a'.repeat(MAX_BODY_BYTES)}"}`
    })
    expect(big.status).toBe(413)
    const bad = await raw(server.port, { headers: { ...auth, ...MCP_HEADERS }, body: '{nope' })
    expect(bad.status).toBe(400)
    expect(await pingMcpHttp(server.port, key)).toBe(true)
    expect(await pingMcpHttp(server.port, 'otra-clave')).toBe(false)
  })

  it('reports a busy port to the host, and the ping tells another program apart', async () => {
    const other: Server = createServer((_req, res) => res.end('hola'))
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
    const busy = (other.address() as { port: number }).port
    try {
      await expect(
        startMcpHttpServer(runtime, { port: busy, key: () => key, version: 'x' })
      ).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(await pingMcpHttp(busy, key)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()))
    }
    expect(await pingMcpHttp(busy, key)).toBe(false)
  })

  it('proves the key in the ping without sending it, and a fake or slow answer is not Vortaq', async () => {
    // What the ping sends: no Authorization header, only a nonce.
    const seen: { auth?: string; url?: string }[] = []
    const fake: Server = createServer((req, res) => {
      seen.push({ auth: req.headers.authorization, url: req.url })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ vortaq: 'mcp', proof: 'inventada' }))
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    const fakePort = (fake.address() as { port: number }).port
    try {
      expect(await pingMcpHttp(fakePort, key)).toBe(false)
      expect(seen).toHaveLength(1)
      expect(seen[0].auth).toBeUndefined()
      expect(seen[0].url).toMatch(/^\/vortaq\/ping\?nonce=[A-Za-z0-9_-]{24}$/)
      expect(seen[0].url).not.toContain(key)
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }

    // A program that answers one byte at a time cannot hold the caller past the deadline.
    const slow: Server = createServer((_req, res) => {
      res.writeHead(200)
      const timer = setInterval(() => res.write(' '), 50)
      res.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
    const slowPort = (slow.address() as { port: number }).port
    try {
      const started = Date.now()
      expect(await pingMcpHttp(slowPort, key, 400)).toBe(false)
      expect(Date.now() - started).toBeLessThan(1500)
    } finally {
      slow.closeAllConnections()
      await new Promise<void>((resolve) => slow.close(() => resolve()))
    }

    // The real server's proof, and its refusal of a ping without a valid nonce.
    expect(pingProof(key, server.port, 'abcdefghijklmnop')).not.toContain(key)
    const noNonce = await raw(server.port, { method: 'GET', path: '/vortaq/ping' })
    expect(noNonce.status).toBe(400)
    const ok = await raw(server.port, {
      method: 'GET',
      path: '/vortaq/ping?nonce=abcdefghijklmnop'
    })
    expect(JSON.parse(ok.body)).toEqual({
      vortaq: 'mcp',
      proof: pingProof(key, server.port, 'abcdefghijklmnop')
    })
  })

  it('names the editor command when agents are off', async () => {
    new SettingsRepo(profile, dir).update({ mcpEnabled: false })
    try {
      const client = await connect(key)
      const r = (await client.callTool({ name: 'list_connections', arguments: {} })) as {
        isError?: boolean
        content: { text: string }[]
      }
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toBe(EDITOR_MCP_WORDING.disabled)
      expect(r.content[0].text).toContain('«Vortaq: Agentes (MCP)…»')
    } finally {
      new SettingsRepo(profile, dir).update({ mcpEnabled: true })
    }
  })
})
