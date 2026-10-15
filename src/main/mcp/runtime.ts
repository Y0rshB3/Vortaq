/**
 * State of one MCP server process: the read-only profile context, the
 * connection manager and the same db:* / mongo:* handlers the desktop app
 * registers (same guards, same messages). Electron-free: the `--mcp`
 * bootstrap (src/main/mcpMain.ts) passes the secret codec and the SQLite
 * spawner; the tests pass plain ones.
 *
 * Nothing is cached across calls except open connections: the settings and
 * connections files are read again on every call (JsonStore reload mode), so
 * a switch or level changed in the open app applies to the next call, and a
 * connection whose saved settings changed is closed and opened again.
 */
import { effectiveMcpAccess, isMcpEnabled, normalizeMcpConfig } from '@shared/mcp'
import type { IpcArgs, IpcChannel, IpcResult } from '@shared/ipc'
import type { ConnectionConfig, EngineId, Environment, McpAccess } from '@shared/types'
import type { AppContext } from '../context'
import { DB_PASSWORD, type SecretKind } from '../credentials/store'
import { getConnectionManager, type ConnectionManager } from '../db/manager'
import { registerDbHandlers } from '../ipc/db'
import { typedConfirmEnvironments } from '../ipc/productionGuard'
import { HandlerRegistry } from '../ipc/router'
import { MAX_OPEN_SQLITE } from '../sqlite/driver'
import { MCP_DISABLED, McpToolError, unknownConnection } from './access'
import { dataScrubberFor, redactorFor, type Redactor } from './redact'

/** What list_connections shows of a connection: never host, port, user, path or databases. */
export interface McpConnectionView {
  id: string
  name: string
  engine: EngineId
  environment: Environment
  access: McpAccess
  /** Present when the level the user chose is not the effective one. */
  note?: string
}

export interface ResolvedConnection {
  config: ConnectionConfig
  /** Effective level now (write is lowered to read on guarded environments). */
  access: McpAccess
  /** Level saved in the connection. */
  requested: McpAccess
  redact: Redactor
  /** For successful answers: secrets, non-loopback hosts and file paths only (redact.ts). */
  scrub: Redactor
}

export interface McpRuntimeOptions {
  /** Why the profile cannot be used yet (pending migration), checked on every call. */
  profileProblem?: () => string | null
}

const SECRET_KINDS_TO_REDACT: SecretKind[] = [DB_PASSWORD, 'ssh', 'sslKey']

export class McpRuntime {
  readonly registry = new HandlerRegistry()
  readonly manager: ConnectionManager
  /** Connections this process used, with the `updatedAt` they were opened with. */
  private readonly used = new Map<string, string>()
  /** When each connection was last used, and how many calls are using it now. */
  private readonly lastUse = new Map<string, number>()
  private readonly busy = new Map<string, number>()
  private readonly profileProblem: () => string | null

  constructor(
    readonly ctx: AppContext,
    options: McpRuntimeOptions = {}
  ) {
    this.profileProblem = options.profileProblem ?? (() => null)
    this.manager = getConnectionManager(ctx)
    registerDbHandlers(ctx, this.registry.handle)
  }

  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> {
    return this.registry.invoke(channel, ...args)
  }

  typedEnvironments(): Environment[] {
    return typedConfirmEnvironments(this.ctx)
  }

  /** Throws unless agents may use Vortaq now (profile ready, global switch on). */
  assertAvailable(): void {
    const problem = this.profileProblem()
    if (problem) throw new McpToolError(problem)
    if (this.ctx.settings.get().mcpEnabled !== true) throw new McpToolError(MCP_DISABLED)
  }

  /** Connections available to agents, with their effective level. */
  connections(): McpConnectionView[] {
    const environments = this.typedEnvironments()
    const out: McpConnectionView[] = []
    for (const c of this.ctx.connections.list()) {
      const access = effectiveMcpAccess(c, environments)
      if (!access) continue
      const requested = normalizeMcpConfig(c.mcp)?.access
      out.push({
        id: c.id,
        name: c.name,
        engine: c.engine,
        environment: c.environment,
        access,
        ...(requested === 'write' && access !== 'write'
          ? {
              note: 'Guardada con «Lectura y escritura», pero su entorno pide escribir el nombre para confirmar: los agentes solo pueden leer.'
            }
          : {})
      })
    }
    return out
  }

  /**
   * The connection an agent names (its id, or its exact name; a name that
   * differs only in case is accepted when it is unique). Connections that are
   * not available answer exactly like unknown ones.
   */
  resolve(ref: unknown): ResolvedConnection {
    const wanted = typeof ref === 'string' ? ref.trim() : ''
    if (!wanted)
      throw new McpToolError('Falta «connection»: usa el id o el nombre que da list_connections.')
    const environments = this.typedEnvironments()
    const available = this.ctx.connections
      .list()
      .filter((c) => effectiveMcpAccess(c, environments) !== null)
    const lower = wanted.toLowerCase()
    const byName = available.filter((c) => c.name.toLowerCase() === lower)
    const config =
      available.find((c) => c.id === wanted) ??
      available.find((c) => c.name === wanted) ??
      (byName.length === 1 ? byName[0] : undefined)
    if (!config) throw new McpToolError(unknownConnection(wanted))
    const access = effectiveMcpAccess(config, environments) as McpAccess
    const requested = normalizeMcpConfig(config.mcp)?.access ?? access
    const secrets = this.secretsOf(config)
    return {
      config,
      access,
      requested,
      redact: redactorFor(config, secrets),
      scrub: dataScrubberFor(config, secrets)
    }
  }

  /** Redactor with the connection's settings and secrets (decrypted in memory only). */
  redactorOf(config: ConnectionConfig): Redactor {
    return redactorFor(config, this.secretsOf(config))
  }

  private secretsOf(config: ConnectionConfig): string[] {
    const secrets: string[] = []
    for (const kind of SECRET_KINDS_TO_REDACT) {
      try {
        const value = this.ctx.credentials.get(kind, config.id)
        if (value) secrets.push(value)
      } catch {
        /* a secret that cannot be decrypted here cannot be echoed either */
      }
    }
    return secrets
  }

  /**
   * Before a connection is used: a connection opened with settings that have
   * changed since (host, password, SSH…) is closed so this call opens it again.
   */
  async prepare(config: ConnectionConfig): Promise<void> {
    const openedWith = this.used.get(config.id)
    if (openedWith !== undefined && openedWith !== config.updatedAt) {
      await this.manager.close(config.id).catch(() => undefined)
    }
    this.used.set(config.id, config.updatedAt)
    this.lastUse.set(config.id, Date.now())
    if (config.engine === 'sqlite' && !this.manager.isOpen(config.id))
      await this.makeRoomForSqlite(config.id)
  }

  /**
   * Each SQLite connection is a worker process and at most MAX_OPEN_SQLITE stay
   * open: an agent moving between files closes the least recently used idle ones.
   */
  private async makeRoomForSqlite(id: string): Promise<void> {
    const idle = [...this.used.keys()]
      .filter(
        (other) =>
          other !== id &&
          this.manager.isOpen(other) &&
          !this.busy.get(other) &&
          this.ctx.connections.get(other)?.engine === 'sqlite'
      )
      .sort((a, b) => (this.lastUse.get(a) ?? 0) - (this.lastUse.get(b) ?? 0))
    const open = [...this.used.keys()].filter(
      (other) =>
        other !== id &&
        this.manager.isOpen(other) &&
        this.ctx.connections.get(other)?.engine === 'sqlite'
    ).length
    for (let i = 0; i < open - (MAX_OPEN_SQLITE - 1) && i < idle.length; i++)
      await this.manager.close(idle[i]).catch(() => undefined)
  }

  /** Marks a connection as used by a running call (never closed to make room meanwhile). */
  begin(id: string): () => void {
    this.busy.set(id, (this.busy.get(id) ?? 0) + 1)
    return () => {
      const n = (this.busy.get(id) ?? 1) - 1
      if (n > 0) this.busy.set(id, n)
      else this.busy.delete(id)
    }
  }

  /** Closes connections that are no longer available to agents or whose settings changed. */
  async sweep(): Promise<void> {
    const environments = this.typedEnvironments()
    const allowed = this.ctx.settings.get().mcpEnabled === true
    for (const [id, openedWith] of [...this.used]) {
      const current = this.ctx.connections.get(id)
      const keep =
        allowed &&
        current !== null &&
        isMcpEnabled(current) &&
        effectiveMcpAccess(current, environments) !== null &&
        current.updatedAt === openedWith
      if (keep) continue
      this.used.delete(id)
      await this.manager.close(id).catch(() => undefined)
    }
  }

  /** Closes every connection, SSH tunnel and SQLite worker. */
  async dispose(): Promise<void> {
    this.used.clear()
    await this.manager.closeAll()
  }
}
