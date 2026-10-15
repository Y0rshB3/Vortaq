/**
 * Shared setup of the MCP integration suites (tests/integration/mcp*.test.ts):
 * a scratch profile with the given connections (secrets in plain test codec),
 * the MCP runtime reading it read-only like `Vortaq --mcp`, and an SDK client
 * over the in-memory transport.
 */
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect } from 'vitest'
import type { ConnectionConfig, ConnectionInput } from '@shared/types'
import { CredentialStore, plainCodec } from '@main/credentials/store'
import { createMcpContext } from '@main/mcp/context'
import { McpRuntime } from '@main/mcp/runtime'
import { createMcpServer, type McpActivity } from '@main/mcp/server'
import { setJsonStoreReadOnly, setJsonStoreReload } from '@main/storage/jsonStore'
import { ConnectionsRepo, SettingsRepo } from '@main/storage/repos'

export interface SeedConnection {
  input: ConnectionInput
  password?: string | null
}

export interface ToolText {
  isError?: boolean
  content: { type: string; text: string }[]
}

export interface McpHarness {
  dir: string
  profile: string
  runtime: McpRuntime
  client: Client
  activity: McpActivity[]
  /** Saved connections by name. */
  byName(name: string): ConnectionConfig
  call(name: string, args?: Record<string, unknown>): Promise<ToolText>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ok(name: string, args?: Record<string, unknown>): Promise<any>
  refused(name: string, args?: Record<string, unknown>): Promise<string>
  close(): Promise<void>
}

/** The fields every test connection shares. */
export function baseInput(overrides: Partial<ConnectionInput>): ConnectionInput {
  return {
    name: 'MCP IT',
    color: null,
    environment: 'local',
    host: '',
    port: 0,
    username: '',
    savePassword: true,
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
    ...overrides
  }
}

/** A local TCP port nobody listens on (for real «connection refused» errors). */
export function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export async function startMcpHarness(seed: SeedConnection[]): Promise<McpHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'vortaq-mcp-it-'))
  const profile = join(dir, 'profile')
  setJsonStoreReadOnly(false)
  const repo = new ConnectionsRepo(profile)
  const secrets = new CredentialStore(profile, plainCodec, 'plain')
  for (const s of seed) {
    const saved = repo.save(s.input)
    if (s.password) secrets.set('mysql', saved.id, s.password)
  }
  new SettingsRepo(profile, dir).update({ mcpEnabled: true })
  // From here on this process reads the profile like `Vortaq --mcp`: never writes it.
  setJsonStoreReload(true)
  setJsonStoreReadOnly(true)
  const ctx = createMcpContext({
    profileDir: profile,
    secrets: { codec: plainCodec, codecName: 'plain' },
    home: dir
  })
  const runtime = new McpRuntime(ctx)
  const activity: McpActivity[] = []
  const server = createMcpServer(runtime, { version: 'it', onActivity: (e) => activity.push(e) })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'vortaq-it', version: '1.0.0' })
  await client.connect(clientSide)

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolText> =>
    (await client.callTool({ name, arguments: args })) as ToolText
  return {
    dir,
    profile,
    runtime,
    client,
    activity,
    byName: (name) => {
      const found = ctx.connections.findByName(name)
      if (!found) throw new Error(`no connection ${name}`)
      return found
    },
    call,
    async ok(name, args = {}) {
      const r = await call(name, args)
      if (r.isError) throw new Error(`${name} failed: ${r.content[0]?.text}`)
      return JSON.parse(r.content[0].text)
    },
    async refused(name, args = {}) {
      const r = await call(name, args)
      expect(r.isError, `${name} should fail: ${r.content[0]?.text}`).toBe(true)
      return r.content[0].text
    },
    async close() {
      await client.close().catch(() => undefined)
      await runtime.dispose().catch(() => undefined)
      setJsonStoreReadOnly(false)
      setJsonStoreReload(false)
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Polls `predicate` until it holds (or fails after `ms`). */
export async function until(predicate: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('condition not met in time')
}
