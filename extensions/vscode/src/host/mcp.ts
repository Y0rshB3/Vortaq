/**
 * Agents (MCP) in the editor: Vortaq's MCP server runs inside this extension,
 * with the extension's own connections, at http://127.0.0.1:<port>/mcp. No
 * desktop app and no Node to install; it answers while the editor is open.
 * (docs/vscode-extension-design.md, «Agentes (MCP)»)
 *
 * - Off by default (`vortaq.mcp.enabled`, user settings only); every connection
 *   is made available one by one with its level, as in the desktop app, and the
 *   core's runtime re-checks the switch, the connection and the level on every call.
 * - A random key in SecretStorage; every request must carry it as a Bearer header
 *   (src/main/mcp/http.ts also checks Host and Origin). VS Code gets it through
 *   the MCP provider below; other clients through «Copiar configuración».
 * - Every editor window runs its own extension host on the same profile. The
 *   first window listens on `vortaq.mcp.port`; the others prove with the ping
 *   (an HMAC of a nonce, never the key) that it is theirs and take over when
 *   that window closes. Requests are stateless, so a takeover loses nothing.
 *   When another program holds the port, nothing starts (`busy`) until it is
 *   free: moving to another port would leave configured clients sending their
 *   key to that program.
 * - The server has its own connection manager (agents never share the
 *   sessions of the user's documents); the activity log goes to the output
 *   channel, one line per call and never SQL, values or the key.
 */
import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import {
  activityLine,
  EDITOR_MCP_WORDING,
  mcpHttpUrl,
  McpRuntime,
  pingMcpHttp,
  startMcpHttpServer,
  type AppContext,
  type McpHttpEndpoint,
  type VortaqCore
} from '@core'
import { DEFAULT_MCP_PORT } from './settings'

export const MCP_PROVIDER_ID = 'vortaq'
export const MCP_KEY_SECRET = 'vortaq.mcp.key'
/**
 * How often a window that is not serving checks again: another window of its own
 * stopped answering, or the program that held the port let it go.
 */
export const TAKEOVER_INTERVAL_MS = 10_000
/** Second listen after a busy port, for a window that is just closing. */
const RELISTEN_DELAY_MS = 300

export type McpState =
  | { kind: 'off' }
  | { kind: 'starting' }
  /** This window answers on `port`. */
  | { kind: 'serving'; port: number }
  /** Another window of this editor (same profile and key) answers on `port`. */
  | { kind: 'elsewhere'; port: number }
  | { kind: 'failed'; message: string }
  /**
   * Another program (or Vortaq with another key, e.g. in another editor) holds
   * the port. Never moved to another port: clients configured with this one
   * would keep sending their key to that program.
   */
  | { kind: 'busy'; port: number }

export interface McpSettings {
  enabled: boolean
  port: number
}

/** A running listener (the real one is startMcpHttpServer; tests pass fakes). */
export interface McpListener {
  readonly port: number
  close(): Promise<void>
}

export interface McpServerPorts {
  listen(port: number, key: () => string | null): Promise<McpListener>
  ping(port: number, key: string): Promise<boolean>
  /** Closes the agents' connections (the runtime) when the server stops. */
  release(): Promise<void>
}

export interface McpServiceOptions {
  secrets: vscode.SecretStorage
  settings: () => McpSettings
  platform: string
  ports: McpServerPorts
  log: (message: string) => void
}

/** `vortaq.mcp.port`, or the default when it is not a usable port. */
export function mcpPortOf(value: number): number {
  return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : DEFAULT_MCP_PORT
}

const newKey = (): string => randomBytes(32).toString('base64url')

function errorCode(err: unknown): string {
  return (err as { code?: unknown })?.code === undefined
    ? ''
    : String((err as { code: unknown }).code)
}

export class McpService implements vscode.Disposable {
  private state: McpState = { kind: 'off' }
  private key: string | null = null
  private listener: McpListener | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly changed = new vscode.EventEmitter<void>()
  /** Fires when the state, the port or the key changes (provider, manager). */
  readonly onDidChange = this.changed.event
  private readonly subscriptions: vscode.Disposable[] = []

  constructor(private readonly options: McpServiceOptions) {
    this.subscriptions.push(
      // Another window regenerated the key: answer and announce with the new one.
      options.secrets.onDidChange((e) => {
        if (e.key === MCP_KEY_SECRET) void this.enqueue(() => this.reloadKey())
      })
    )
  }

  get current(): McpState {
    return this.state
  }

  /** Where agents connect, while this window or another one serves. */
  endpoint(): McpHttpEndpoint | null {
    if (!this.key) return null
    if (this.state.kind !== 'serving' && this.state.kind !== 'elsewhere') return null
    return { url: mcpHttpUrl(this.state.port), key: this.key, platform: this.options.platform }
  }

  /** Spanish line for the manager and the provider's errors. */
  describe(): string {
    switch (this.state.kind) {
      case 'off':
        return 'Los agentes están desactivados.'
      case 'starting':
        return 'Arrancando el servidor MCP…'
      case 'serving':
        return `Servidor MCP en ${mcpHttpUrl(this.state.port)} (esta ventana).`
      case 'elsewhere':
        return `Servidor MCP en ${mcpHttpUrl(this.state.port)} (otra ventana del editor).`
      case 'failed':
        return this.state.message
      case 'busy':
        return `El puerto ${this.state.port} lo usa otro programa (puede ser Vortaq en otro editor). Elige otro en el ajuste «vortaq.mcp.port» y copia de nuevo la configuración de tus clientes. Si ya tenían configurado ese puerto, regenera la clave: le habrán enviado la clave a ese programa.`
    }
  }

  /** Applies the settings: starts, moves or stops the server. Calls are serialised. */
  refresh(): Promise<void> {
    return this.enqueue(() => this.apply())
  }

  /** A new key: clients configured with the previous one stop getting in. */
  regenerateKey(): Promise<void> {
    return this.enqueue(async () => {
      this.key = newKey()
      await this.options.secrets.store(MCP_KEY_SECRET, this.key)
      this.options.log('[mcp] clave regenerada')
      this.changed.fire()
    })
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private setState(state: McpState): void {
    this.state = state
    this.changed.fire()
  }

  private async loadKey(): Promise<string> {
    if (this.key) return this.key
    const stored = await this.options.secrets.get(MCP_KEY_SECRET)
    if (stored) this.key = stored
    else {
      this.key = newKey()
      await this.options.secrets.store(MCP_KEY_SECRET, this.key)
    }
    return this.key
  }

  private async reloadKey(): Promise<void> {
    const stored = await this.options.secrets.get(MCP_KEY_SECRET)
    if (stored && stored !== this.key) {
      this.key = stored
      this.changed.fire()
    }
  }

  private async apply(): Promise<void> {
    if (this.disposed) return
    const settings = this.options.settings()
    if (!settings.enabled) {
      await this.stop()
      if (this.state.kind !== 'off') this.setState({ kind: 'off' })
      return
    }
    const port = mcpPortOf(settings.port)
    if (this.listener?.port === port) return
    if (this.listener) await this.stop()
    if (this.state.kind === 'off' || this.state.kind === 'failed')
      this.setState({ kind: 'starting' })
    let key: string
    try {
      key = await this.loadKey()
    } catch (err) {
      this.stopRetry()
      this.setState({
        kind: 'failed',
        message: `No se pudo guardar la clave de los agentes en el almacén seguro del editor (${err instanceof Error ? err.message : String(err)}). En Linux, configura un llavero (gnome-keyring, KWallet…) y vuelve a intentarlo.`
      })
      return
    }
    // A window that is closing may still hold the port for a moment: one more try.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.listener = await this.options.ports.listen(port, () => this.key)
        this.stopRetry()
        this.options.log(`[mcp] servidor MCP en ${mcpHttpUrl(this.listener.port)}`)
        this.setState({ kind: 'serving', port: this.listener.port })
        return
      } catch (err) {
        const code = errorCode(err)
        if (code !== 'EADDRINUSE' && code !== 'EACCES') {
          this.stopRetry()
          this.setState({
            kind: 'failed',
            message: `No se pudo arrancar el servidor MCP: ${err instanceof Error ? err.message : String(err)}`
          })
          return
        }
        // The ping proves the key without sending it (src/main/mcp/http.ts).
        if (await this.options.ports.ping(port, key)) {
          if (this.state.kind !== 'elsewhere' || this.state.port !== port)
            this.setState({ kind: 'elsewhere', port })
          this.startRetry(port)
          return
        }
        if (attempt === 0) await new Promise((r) => setTimeout(r, RELISTEN_DELAY_MS))
      }
    }
    if (this.state.kind !== 'busy' || this.state.port !== port) {
      this.options.log(`[mcp] el puerto ${port} lo usa otro programa: el servidor MCP no arranca`)
      this.setState({ kind: 'busy', port })
    }
    this.startRetry(port)
  }

  /**
   * While another window serves, or another program holds the port: when the
   * window stops answering or the port is free again, this one takes it.
   */
  private startRetry(port: number): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const key = this.key
      if (!key || this.disposed) return
      if (this.state.kind === 'busy') {
        void this.refresh()
        return
      }
      void this.options.ports.ping(port, key).then((alive) => {
        if (!alive && this.state.kind === 'elsewhere') void this.refresh()
      })
    }, TAKEOVER_INTERVAL_MS)
  }

  private stopRetry(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async stop(): Promise<void> {
    this.stopRetry()
    const listener = this.listener
    this.listener = null
    if (listener) {
      await listener.close().catch(() => undefined)
      this.options.log('[mcp] servidor MCP detenido')
    }
    await this.options.ports.release().catch(() => undefined)
  }

  dispose(): void {
    this.disposed = true
    void this.stop()
    for (const s of this.subscriptions) s.dispose()
    this.changed.dispose()
  }
}

/**
 * The real ports: the core's runtime over this extension's profile (its own
 * connection manager: a copy of the context is a new key for it) and the
 * loopback HTTP server.
 */
export function coreMcpPorts(
  core: VortaqCore,
  version: string,
  log: (message: string) => void
): McpServerPorts {
  let runtime: McpRuntime | null = null
  const runtimeOf = (): McpRuntime => {
    if (!runtime) {
      const ctx: AppContext = {
        ...core.context,
        emit: () => undefined,
        // A `mysql` connection whose server is MariaDB is never rewritten from here.
        headless: true,
        isolatedProfile: true
      }
      runtime = new McpRuntime(ctx, { wording: EDITOR_MCP_WORDING })
    }
    return runtime
  }
  return {
    listen: (port, key) =>
      startMcpHttpServer(runtimeOf(), {
        port,
        key,
        version,
        onActivity: (e) => log(`[mcp] ${activityLine(e)}`)
      }),
    ping: (port, key) => pingMcpHttp(port, key),
    release: async () => {
      const current = runtime
      runtime = null
      await current?.dispose()
    }
  }
}

/**
 * The definition VS Code lists as «Vortaq», without the key: the editor may
 * cache listed definitions, so the key is only added when it starts the server.
 */
function definitionOf(endpoint: McpHttpEndpoint, version: string): vscode.McpHttpServerDefinition {
  return new vscode.McpHttpServerDefinition('Vortaq', vscode.Uri.parse(endpoint.url), {}, version)
}

const authorization = (endpoint: McpHttpEndpoint): Record<string, string> => ({
  Authorization: `Bearer ${endpoint.key}`
})

/**
 * Registers the server with the editor's MCP support (VS Code's chat in agent
 * mode lists «Vortaq» without editing mcp.json). Null where the editor has no
 * such API (some forks): the manager's «Copiar configuración» still works there.
 */
export function registerMcpProvider(
  service: McpService,
  version: string
): vscode.Disposable | null {
  const lm = (vscode as { lm?: Partial<typeof vscode.lm> }).lm
  if (
    typeof lm?.registerMcpServerDefinitionProvider !== 'function' ||
    typeof vscode.McpHttpServerDefinition !== 'function'
  )
    return null
  return lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
    onDidChangeMcpServerDefinitions: service.onDidChange,
    provideMcpServerDefinitions: () => {
      const endpoint = service.endpoint()
      return endpoint ? [definitionOf(endpoint, version)] : []
    },
    resolveMcpServerDefinition: async () => {
      await service.refresh()
      const endpoint = service.endpoint()
      if (!endpoint)
        throw new Error(
          `Vortaq: ${service.describe()} Actívalos con «Vortaq: Agentes (MCP)…» y elige las conexiones.`
        )
      // A new object with the key, only now (the listed one stays without it); the port
      // may also have changed since the editor listed it.
      return new vscode.McpHttpServerDefinition(
        'Vortaq',
        vscode.Uri.parse(endpoint.url),
        authorization(endpoint),
        version
      )
    }
  })
}
