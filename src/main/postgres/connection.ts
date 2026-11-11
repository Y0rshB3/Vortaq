/**
 * One open PostgreSQL connection (docs/multi-engine-design.md, sections 5.3
 * and 5.3.1): a pool per database (one connection = one database in PG), all
 * through the same tunnel endpoint, opened when the user opens that database
 * and closed after 10 minutes idle, at most 8 at a time; plus the query tabs'
 * dedicated sessions and the registry of running executions for cancel.
 */
import type pg from 'pg'
import type { ConnectionConfig, ServerInfo, TabSessionState } from '@shared/types'
import { postgresqlDialect } from '@shared/dialects/postgresql'
import type { Endpoint, Scope, SqlDriverConnection } from '../db/driver'
import { getLogger } from '../log'
import { describeError, describeForLog, isConnectionLost, PgUserError } from './errors'
import {
  buildSslPlan,
  connectOrClose,
  composeSearchPath,
  createClient,
  formatSearchPath,
  networkOf,
  parseSearchPath,
  postgresOf,
  shouldRetrySsl,
  type SslPlan
} from './client'
import { PgSession } from './session'
import { clientTlsOf, encryptionLabel, pgCatalogFeatures, sslInfoSql } from './catalogCompat'

const log = getLogger('postgres.connection')

/** Clients per database pool (introspection, grid, table data run in parallel). */
const POOL_MAX = 4
/** Database pools open at once per connection (section 4.1). */
export const MAX_DATABASE_POOLS = 8
/** Idle database pools (other than the initial one) close after this long. */
const POOL_IDLE_MS = 10 * 60_000
/** Tab sessions idle this long without a transaction are closed (reopened on the next run). */
const TAB_IDLE_MS = 30 * 60_000

export interface PgOpenOptions {
  config: ConnectionConfig
  endpoint: Endpoint
  password: string | null
  sslKeyPassword: string | null
  /** Writes need the typed confirmation: sessions start read-only (section 10). */
  isGuarded(): boolean
  onFatal(reason: string): void
}

/** A client connected and set up, with its own error handler (an idle socket error must not crash main). */
interface LiveClient {
  client: pg.Client
  /** Whether the session was configured read-only (guard on at setup time). */
  readOnly: boolean
}

class DatabasePool {
  private readonly idle: LiveClient[] = []
  private readonly waiting: ((c: LiveClient | Error) => void)[] = []
  private total = 0
  lastUsed = Date.now()
  /** search_path a fresh session has (config option or server default), parsed. */
  baseSearchPath: string[] | null = null
  closed = false

  constructor(
    readonly database: string,
    private readonly factory: () => Promise<LiveClient>
  ) {}

  async acquire(): Promise<LiveClient> {
    if (this.closed) throw new PgUserError(`La base de datos ${this.database} está cerrada`)
    this.lastUsed = Date.now()
    const ready = this.idle.pop()
    if (ready) return ready
    if (this.total < POOL_MAX) {
      this.total++
      try {
        return await this.factory()
      } catch (err) {
        this.total--
        throw err
      }
    }
    return new Promise<LiveClient>((resolve, reject) => {
      this.waiting.push((c) => (c instanceof Error ? reject(c) : resolve(c)))
    })
  }

  release(live: LiveClient, destroy: boolean): void {
    this.lastUsed = Date.now()
    if (destroy || this.closed) {
      this.total--
      void live.client.end().catch(() => undefined)
      const next = this.waiting.shift()
      if (next && !this.closed) {
        this.total++
        this.factory().then(next, (err: Error) => {
          this.total--
          next(err)
        })
      }
      return
    }
    const next = this.waiting.shift()
    if (next) next(live)
    else this.idle.push(live)
  }

  get busy(): boolean {
    return this.total > this.idle.length
  }

  async close(): Promise<void> {
    this.closed = true
    for (const w of this.waiting.splice(0)) w(new PgUserError('La conexión se ha cerrado'))
    await Promise.all(this.idle.splice(0).map((l) => l.client.end().catch(() => undefined)))
  }
}

/** A query tab's dedicated session (D12). */
export class TabSession {
  /** Schema chosen in the tab's combo and applied to search_path, null = configured default. */
  appliedSchema: string | null = null
  effectiveSchema: string | null = null
  lastUsed = Date.now()
  /** A confirmed write lifted read-only inside a transaction: restore it when the transaction ends. */
  restoreReadOnly = false
  lost: string | null = null

  constructor(
    readonly key: string,
    readonly session: PgSession,
    readonly live: LiveClient
  ) {}

  get database(): string {
    return this.session.database
  }

  state(): TabSessionState {
    return {
      open: true,
      transactionStatus: this.session.transactionStatus(),
      effectiveSchema: this.effectiveSchema,
      database: this.database
    }
  }
}

/** Running statements, by executionId, so cancel can only hit the execution it names. */
interface RunningExecution {
  database: string
  pid: number
  cancelled: boolean
}

export class PgDriverConnection implements SqlDriverConnection<PgSession> {
  readonly family = 'sql' as const
  readonly dialect = postgresqlDialect
  private readonly pools = new Map<string, DatabasePool>()
  private readonly tabs = new Map<string, TabSession>()
  private readonly executions = new Map<string, RunningExecution>()
  private sslPlan: SslPlan | null = null
  /** The plan's fallback worked for the first client: later clients start with it. */
  private useFallback = false
  private version = ''
  private versionNum = 0
  private sweeper: NodeJS.Timeout | null = null
  private closing = false

  constructor(private readonly opts: PgOpenOptions) {}

  get config(): ConnectionConfig {
    return this.opts.config
  }

  get serverVersion(): string {
    return this.version
  }

  get serverVersionNum(): number {
    return this.versionNum
  }

  get initialDatabase(): string {
    return postgresOf(this.config).initialDatabase || 'postgres'
  }

  private newSession(
    database: string,
    client: pg.Client,
    onRelease: (session: PgSession) => Promise<void>
  ): PgSession {
    return new PgSession(this.config.id, this.version, database, client, onRelease, this.versionNum)
  }

  /** Opens the initial database's pool and reads the server version. */
  async probe(): Promise<void> {
    this.sslPlan = await buildSslPlan(this.config, this.opts.endpoint, this.opts.sslKeyPassword)
    const session = await this.acquire({ database: this.initialDatabase, schema: null })
    try {
      const [row] = await session.query<{ version: string; num: string }>(
        "SELECT current_setting('server_version') AS version, current_setting('server_version_num') AS num"
      )
      this.version = row?.version ?? ''
      this.versionNum = Number(row?.num ?? 0) || 0
    } finally {
      await session.release()
    }
    this.sweeper = setInterval(() => void this.sweep(), 60_000)
    this.sweeper.unref?.()
  }

  /* ---------- clients ---------- */

  private async connectClient(database: string): Promise<LiveClient> {
    const plan = this.sslPlan ?? (await buildSslPlan(this.config, this.opts.endpoint))
    const network = networkOf(this.config)
    const attempt = async (ssl: SslPlan['first']): Promise<pg.Client> => {
      const client = createClient({
        endpoint: this.opts.endpoint,
        user: this.config.username,
        database,
        password: this.opts.password,
        ssl,
        connectTimeoutMs: network.connectTimeoutMs,
        keepAliveSec: network.keepAliveSec
      })
      client.on('error', (err) => {
        // An idle client whose socket died: drop it quietly; the next use reconnects.
        log.info(`a session of ${this.config.name} was dropped: ${describeForLog(err)}`)
      })
      await connectOrClose(client)
      return client
    }
    let client: pg.Client
    if (this.useFallback && plan.fallback !== null) client = await attempt(plan.fallback)
    else {
      try {
        client = await attempt(plan.first)
      } catch (err) {
        if (!shouldRetrySsl(plan, err) || plan.fallback === null) throw err
        client = await attempt(plan.fallback)
        this.useFallback = true
      }
    }
    const readOnly = this.opts.isGuarded()
    try {
      await this.setupClient(client, readOnly)
    } catch (err) {
      await client.end().catch(() => undefined)
      throw err
    }
    return { client, readOnly }
  }

  /**
   * Session setup on top of the startup options: TimeZone and search_path
   * from the connection, and read-only transactions on a guarded connection
   * (section 10). Re-run after DISCARD ALL.
   */
  private async setupClient(client: pg.Client, readOnly: boolean): Promise<void> {
    const pgOptions = postgresOf(this.config)
    if (pgOptions.timeZone.trim())
      await client.query('SELECT set_config($1, $2, false)', [
        'TimeZone',
        pgOptions.timeZone.trim()
      ])
    const configured = parseSearchPath(pgOptions.searchPath)
    if (configured.length)
      await client.query('SELECT set_config($1, $2, false)', [
        'search_path',
        formatSearchPath(configured)
      ])
    if (readOnly) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  }

  private pool(database: string): DatabasePool {
    const existing = this.pools.get(database)
    if (existing && !existing.closed) return existing
    if (this.closing) throw new PgUserError('La conexión se está cerrando')
    if (this.pools.size >= MAX_DATABASE_POOLS) {
      // Close the least recently used idle pool (never the initial database's).
      const victim = [...this.pools.values()]
        .filter((p) => !p.busy && p.database !== this.initialDatabase)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (!victim) throw new PgUserError('Demasiadas bases de datos abiertas: cierra alguna')
      this.pools.delete(victim.database)
      void victim.close()
    }
    const pool = new DatabasePool(database, () => this.connectClient(database))
    this.pools.set(database, pool)
    return pool
  }

  /** Databases with an open pool (for the tree's open/closed state). */
  openDatabases(): string[] {
    return [...this.pools.keys()]
  }

  /**
   * «Cerrar base de datos» in the tree: like closeDatabase, but the initial
   * database stays open (connection-level reads use it) and an open
   * transaction in one of its query tabs is never rolled back behind the user.
   */
  async closeDatabaseFromTree(database: string): Promise<void> {
    if (database === this.initialDatabase)
      throw new PgUserError(
        `«${database}» es la base de datos inicial de la conexión: se cierra al cerrar la conexión.`
      )
    const busy = [...this.tabs.values()].some(
      (t) => t.database === database && t.session.transactionStatus() !== 'idle'
    )
    if (busy)
      throw new PgUserError(
        `Hay una transacción abierta en una pestaña de «${database}»: confírmala o deshazla antes de cerrar la base de datos.`
      )
    await this.closeDatabase(database)
  }

  async closeDatabase(database: string): Promise<void> {
    const pool = this.pools.get(database)
    if (!pool) return
    for (const tab of [...this.tabs.values()])
      if (tab.database === database) await this.closeTabSession(tab.key)
    this.pools.delete(database)
    await pool.close()
  }

  private async sweep(): Promise<void> {
    const now = Date.now()
    for (const pool of [...this.pools.values()]) {
      if (pool.database === this.initialDatabase || pool.busy) continue
      if (now - pool.lastUsed < POOL_IDLE_MS) continue
      if ([...this.tabs.values()].some((t) => t.database === pool.database)) continue
      this.pools.delete(pool.database)
      await pool.close()
    }
    for (const tab of [...this.tabs.values()]) {
      if (tab.session.transactionStatus() !== 'idle') continue
      if (now - tab.lastUsed >= TAB_IDLE_MS) await this.closeTabSession(tab.key)
    }
  }

  /** Default search_path of a fresh session in `database` (read once per pool). */
  async baseSearchPath(database: string): Promise<string[]> {
    const pool = this.pool(database)
    if (pool.baseSearchPath) return pool.baseSearchPath
    const session = await this.acquire({ database, schema: null })
    try {
      const [row] = await session.query<{ path: string }>(
        "SELECT current_setting('search_path') AS path"
      )
      pool.baseSearchPath = parseSearchPath(row?.path ?? '')
      return pool.baseSearchPath
    } finally {
      await session.release()
    }
  }

  /**
   * Pooled internal session of `scope.database` (default: the initial
   * database). Never relies on search_path: catalog SQL is schema-qualified.
   */
  async acquire(scope: Scope | null): Promise<PgSession> {
    const database = scope?.database || this.initialDatabase
    const pool = this.pool(database)
    const live = await pool.acquire()
    // Guard switched on since this client was set up: make it read-only now.
    if (!live.readOnly && this.opts.isGuarded()) {
      await live.client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
      live.readOnly = true
    }
    return this.newSession(database, live.client, async (s) => {
      // Dirty (open or failed transaction): destroy. Used for user SQL: reset the state.
      if (s.transactionStatus() !== 'idle') return pool.release(live, true)
      if (s.usage.userSql || live.readOnly !== this.opts.isGuarded()) {
        try {
          await live.client.query('DISCARD ALL')
          const readOnly = this.opts.isGuarded()
          await this.setupClient(live.client, readOnly)
          live.readOnly = readOnly
        } catch {
          return pool.release(live, true)
        }
      }
      pool.release(live, false)
    })
  }

  /* ---------- tab sessions (D12) ---------- */

  tabSession(key: string): TabSession | null {
    return this.tabs.get(key) ?? null
  }

  /**
   * The tab's session on `database`, opened on first use. A tab that moved to
   * another database gets its old session closed first (the renderer asks
   * before doing that with an open transaction).
   */
  async openTabSession(key: string, database: string): Promise<TabSession> {
    const existing = this.tabs.get(key)
    if (existing && existing.database === database && !existing.lost) {
      existing.lastUsed = Date.now()
      return existing
    }
    if (existing && !existing.lost && existing.session.transactionStatus() !== 'idle')
      throw new PgUserError(
        'Hay una transacción abierta en esta pestaña: confírmala o deshazla antes de cambiar de base de datos',
        'E_PG_TX_OPEN'
      )
    if (existing) await this.closeTabSession(key)
    this.pool(database) // enforces the database cap and the open/closed state
    const live = await this.connectClient(database)
    const session = this.newSession(database, live.client, async () => {
      await live.client.end().catch(() => undefined)
    })
    const tab = new TabSession(key, session, live)
    live.client.on('error', (err) => {
      tab.lost = isConnectionLost(err)
        ? 'Conexión perdida: la transacción abierta se ha deshecho'
        : describeError(err)
    })
    live.client.on('end', () => {
      tab.lost ??= 'Conexión perdida: la transacción abierta se ha deshecho'
    })
    this.tabs.set(key, tab)
    return tab
  }

  /** Points the tab's search_path at `schema` first, keeping the base list (public stays visible). */
  async setTabSchema(tab: TabSession, schema: string | null): Promise<void> {
    if (tab.appliedSchema === schema) return
    if (tab.session.transactionStatus() === 'failed') return
    const base = await this.baseSearchPath(tab.database)
    const path = composeSearchPath(schema, base)
    await tab.session.query('SELECT set_config($1, $2, false)', [
      'search_path',
      formatSearchPath(path)
    ])
    tab.appliedSchema = schema
  }

  async closeTabSession(key: string): Promise<void> {
    const tab = this.tabs.get(key)
    if (!tab) return
    this.tabs.delete(key)
    // Ending the client rolls back any open transaction on the server.
    await tab.session.release().catch(() => undefined)
  }

  /* ---------- executions and cancel ---------- */

  registerExecution(executionId: string, session: PgSession): RunningExecution | null {
    const pid = session.pid
    if (!executionId || pid === null) return null
    const entry: RunningExecution = { database: session.database, pid, cancelled: false }
    this.executions.set(executionId, entry)
    return entry
  }

  unregisterExecution(executionId: string | undefined): void {
    if (executionId) this.executions.delete(executionId)
  }

  isCancelled(executionId: string | undefined): boolean {
    return !!executionId && this.executions.get(executionId)?.cancelled === true
  }

  /** pg_cancel_backend of a statement still registered as running; false otherwise. */
  async cancel(executionId: string): Promise<boolean> {
    const running = this.executions.get(executionId)
    if (!running) return false
    running.cancelled = true
    // A dedicated short-lived client: the pool may be full of busy sessions.
    const live = await this.connectClient(running.database)
    try {
      // Still the same execution? (it may have finished while we connected)
      if (this.executions.get(executionId) !== running) return false
      const { rows } = await live.client.query<{ ok: boolean }>(
        'SELECT pg_cancel_backend($1) AS ok',
        [running.pid]
      )
      return rows[0]?.ok === true
    } finally {
      await live.client.end().catch(() => undefined)
    }
  }

  /* ---------- info ---------- */

  async serverInfo(): Promise<ServerInfo> {
    const session = await this.acquire(null)
    try {
      const [row] = await session.query<{
        version: string
        encoding: string
        uptime: number | null
        connections: number | null
        timezone: string
        ssl: boolean | null
        sslversion: string | null
        user: string
      }>(
        `SELECT version() AS version,
                current_setting('server_encoding') AS encoding,
                EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::int AS uptime,
                (SELECT count(*)::int FROM pg_stat_activity WHERE datname IS NOT NULL) AS connections,
                current_setting('TimeZone') AS timezone,
                ${sslInfoSql(pgCatalogFeatures(this.versionNum))},
                current_user AS user`
      )
      // Version, host and encoding already have their own rows in the info panel.
      const details = [
        { label: 'Base de datos inicial', value: this.initialDatabase },
        { label: 'Zona horaria de sesión', value: row?.timezone ?? '' },
        {
          label: 'Cifrado',
          value: encryptionLabel(
            row?.ssl ?? null,
            row?.sslversion ?? null,
            clientTlsOf(session.client)
          )
        },
        ...(this.config.ssh.enabled ? [{ label: 'Túnel SSH', value: this.config.ssh.host }] : [])
      ]
      return {
        version: this.version,
        versionComment: row?.version ?? '',
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        characterSet: row?.encoding ?? '',
        uptimeSeconds: Number(row?.uptime ?? 0) || 0,
        threadsConnected: Number(row?.connections ?? 0) || 0,
        engine: 'postgresql',
        details,
        runtime: {
          flavor: 'postgresql',
          versionNumber: this.versionNum,
          transactions: true,
          returning: 'all'
        }
      }
    } finally {
      await session.release()
    }
  }

  async close(): Promise<void> {
    this.closing = true
    if (this.sweeper) clearInterval(this.sweeper)
    for (const key of [...this.tabs.keys()]) await this.closeTabSession(key)
    await Promise.all([...this.pools.values()].map((p) => p.close()))
    this.pools.clear()
  }
}

export function isPgConnection(c: unknown): c is PgDriverConnection {
  return c instanceof PgDriverConnection
}
