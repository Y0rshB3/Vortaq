/**
 * One open SQL Server connection (docs/sqlserver-design.md, «Sesiones»): a
 * pool per database (sessions log in to that database, which also works on
 * Azure SQL Database, where USE cannot switch), all through the same tunnel
 * endpoint, opened when the user opens that database and closed after 10
 * minutes idle, at most 8 at a time; plus the query tabs' dedicated sessions
 * and the running executions for cancel (a TDS attention on the session's own
 * connection: no second connection is needed).
 */
import type { Connection } from 'tedious'
import type {
  ConnectionConfig,
  ServerInfo,
  TabSessionState,
  TransactionStatus
} from '@shared/types'
import { sqlserverDialect } from '@shared/dialects/sqlserver'
import type { Endpoint, Scope, SqlDriverConnection } from '../db/driver'
import { getLogger } from '../log'
import { buildConfiguration, connectClient, sqlserverOf } from './client'
import { describeError, describeForLog, isConnectionLost, MsUserError } from './errors'
import { MsSession } from './session'

const log = getLogger('sqlserver.connection')

/** Sessions per database pool (introspection, grid and table data run in parallel). */
const POOL_MAX = 4
/** Database pools open at once per connection. */
export const MAX_DATABASE_POOLS = 8
/** Idle database pools (other than the initial one) close after this long. */
const POOL_IDLE_MS = 10 * 60_000
/** Tab sessions idle this long without a transaction are closed (reopened on the next run). */
const TAB_IDLE_MS = 30 * 60_000

export interface MsOpenOptions {
  config: ConnectionConfig
  endpoint: Endpoint
  password: string | null
  onFatal(reason: string): void
}

class DatabasePool {
  private readonly idle: Connection[] = []
  private readonly waiting: ((c: Connection | Error) => void)[] = []
  private total = 0
  lastUsed = Date.now()
  closed = false

  constructor(
    readonly database: string,
    private readonly factory: () => Promise<Connection>
  ) {}

  async acquire(): Promise<Connection> {
    if (this.closed) throw new MsUserError(`La base de datos ${this.database} está cerrada`)
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
    return new Promise<Connection>((resolve, reject) => {
      this.waiting.push((c) => (c instanceof Error ? reject(c) : resolve(c)))
    })
  }

  release(connection: Connection, destroy: boolean): void {
    this.lastUsed = Date.now()
    if (destroy || this.closed) {
      this.total--
      connection.close()
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
    if (next) next(connection)
    else this.idle.push(connection)
  }

  /** Takes over a session connected elsewhere (the probe's), as an idle one. */
  adopt(connection: Connection): void {
    this.total++
    this.release(connection, false)
  }

  get busy(): boolean {
    return this.total > this.idle.length
  }

  async close(): Promise<void> {
    this.closed = true
    for (const w of this.waiting.splice(0)) w(new MsUserError('La conexión se ha cerrado'))
    for (const c of this.idle.splice(0)) c.close()
  }
}

/** A query tab's dedicated session. */
export class TabSession {
  lastUsed = Date.now()
  lost: string | null = null
  /** After the last run: @@TRANCOUNT/XACT_STATE() and DB_NAME()/SCHEMA_NAME(). */
  status: TransactionStatus = 'idle'
  currentDatabase: string
  currentSchema: string | null = null

  constructor(
    readonly key: string,
    readonly session: MsSession
  ) {
    this.currentDatabase = session.database
  }

  /** Database the tab asked for when the session was opened. */
  get database(): string {
    return this.session.database
  }

  state(): TabSessionState {
    return {
      open: true,
      transactionStatus: this.status,
      effectiveSchema: this.currentSchema,
      database: this.currentDatabase
    }
  }

  /** Re-reads the transaction state and the current database/schema of the session. */
  async refresh(): Promise<void> {
    const [row] = await this.session.query<{ tc: number; xs: number; db: string; sch: string }>(
      'SELECT @@TRANCOUNT AS tc, XACT_STATE() AS xs, DB_NAME() AS db, SCHEMA_NAME() AS sch'
    )
    if (!row) return
    this.status = row.tc === 0 ? 'idle' : row.xs === -1 ? 'failed' : 'in'
    this.currentDatabase = row.db ?? this.currentDatabase
    this.currentSchema = row.sch ?? null
  }
}

export class MsDriverConnection implements SqlDriverConnection<MsSession> {
  readonly family = 'sql' as const
  readonly dialect = sqlserverDialect
  private readonly pools = new Map<string, DatabasePool>()
  private readonly tabs = new Map<string, TabSession>()
  private readonly executions = new Map<string, MsSession>()
  private readonly cancelled = new Set<string>()
  private version = ''
  private versionNum = 0
  private engineEdition = 0
  private initial = ''
  private sweeper: NodeJS.Timeout | null = null
  private closing = false

  constructor(private readonly opts: MsOpenOptions) {}

  get config(): ConnectionConfig {
    return this.opts.config
  }

  get serverVersion(): string {
    return this.version
  }

  get serverVersionNum(): number {
    return this.versionNum
  }

  /** 5 = Azure SQL Database, 8 = Azure SQL Managed Instance (SERVERPROPERTY('EngineEdition')). */
  get edition(): number {
    return this.engineEdition
  }

  /** The database sessions open in by default (configured, or the login's default). */
  get initialDatabase(): string {
    return this.initial || sqlserverOf(this.config).initialDatabase.trim() || 'master'
  }

  /** Opens the first session, learns the initial database and reads the server version. */
  async probe(): Promise<void> {
    const configured = sqlserverOf(this.config).initialDatabase.trim()
    const connection = await this.connect(configured || null)
    const session = new MsSession(this.config.id, '', configured, connection, async () => undefined)
    try {
      const [row] = await session.query<{ v: string; db: string; ed: number }>(
        "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS v, DB_NAME() AS db, CAST(SERVERPROPERTY('EngineEdition') AS int) AS ed"
      )
      this.version = row?.v ?? ''
      this.versionNum = versionNumber(this.version)
      this.engineEdition = Number(row?.ed ?? 0) || 0
      this.initial = row?.db ?? configured
    } catch (err) {
      connection.close()
      throw err
    }
    // The first session joins its database's pool.
    this.pool(this.initial).adopt(connection)
    this.sweeper = setInterval(() => void this.sweep(), 60_000)
    this.sweeper.unref?.()
  }

  /* ---------- sessions ---------- */

  private async connect(database: string | null): Promise<Connection> {
    const configuration = buildConfiguration(
      this.config,
      { password: this.opts.password },
      { endpoint: this.opts.endpoint, database }
    )
    const connection = await connectClient(configuration)
    connection.on('error', (err) => {
      // An idle session whose socket died: drop it quietly; the next use reconnects.
      log.info(`a session of ${this.config.name} was dropped: ${describeForLog(err)}`)
    })
    return connection
  }

  private pool(database: string): DatabasePool {
    const existing = this.pools.get(database)
    if (existing && !existing.closed) return existing
    if (this.closing) throw new MsUserError('La conexión se está cerrando')
    if (this.pools.size >= MAX_DATABASE_POOLS) {
      const victim = [...this.pools.values()]
        .filter((p) => !p.busy && p.database !== this.initialDatabase)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (!victim) throw new MsUserError('Demasiadas bases de datos abiertas: cierra alguna')
      this.pools.delete(victim.database)
      void victim.close()
    }
    const pool = new DatabasePool(database, () => this.connect(database))
    this.pools.set(database, pool)
    return pool
  }

  /** Databases with an open pool (for the tree's open/closed state). */
  openDatabases(): string[] {
    return [...this.pools.keys()]
  }

  /** «Cerrar base de datos» in the tree (never the initial one, never with a tab's open transaction). */
  async closeDatabaseFromTree(database: string): Promise<void> {
    if (database === this.initialDatabase)
      throw new MsUserError(
        `«${database}» es la base de datos inicial de la conexión: se cierra al cerrar la conexión.`
      )
    const busy = [...this.tabs.values()].some((t) => t.database === database && t.status !== 'idle')
    if (busy)
      throw new MsUserError(
        `Hay una transacción abierta en una pestaña de «${database}»: confírmala o deshazla antes de cerrar la base de datos.`
      )
    await this.closeDatabase(database)
  }

  async closeDatabase(database: string): Promise<void> {
    const pool = this.pools.get(database)
    for (const tab of [...this.tabs.values()])
      if (tab.database === database) await this.closeTabSession(tab.key)
    if (!pool) return
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
      if (tab.status !== 'idle' || tab.session.isRunning) continue
      if (now - tab.lastUsed >= TAB_IDLE_MS) await this.closeTabSession(tab.key)
    }
  }

  /**
   * Pooled internal session of `scope.database` (default: the initial
   * database). Catalog SQL is always schema-qualified.
   */
  async acquire(scope: Scope | null): Promise<MsSession> {
    const database = scope?.database || this.initialDatabase
    const pool = this.pool(database)
    const connection = await pool.acquire()
    return new MsSession(this.config.id, this.version, database, connection, async (s) => {
      if (!s.usage.userSql) return pool.release(connection, false)
      // User SQL may leave a transaction, temp tables or SET options: roll back and reset.
      try {
        await s.exec('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION')
        await new Promise<void>((resolve, reject) =>
          connection.reset((err) => (err ? reject(err) : resolve()))
        )
        pool.release(connection, false)
      } catch {
        pool.release(connection, true)
      }
    })
  }

  /* ---------- tab sessions ---------- */

  tabSession(key: string): TabSession | null {
    return this.tabs.get(key) ?? null
  }

  /**
   * The tab's session on `database`, opened on first use. A tab that moved to
   * another database gets its old session closed first (never with an open
   * transaction: the renderer asks before).
   */
  async openTabSession(key: string, database: string): Promise<TabSession> {
    const existing = this.tabs.get(key)
    if (existing && existing.database === database && !existing.lost) {
      existing.lastUsed = Date.now()
      return existing
    }
    if (existing && !existing.lost && existing.status !== 'idle')
      throw new MsUserError(
        'Hay una transacción abierta en esta pestaña: confírmala o deshazla antes de cambiar de base de datos',
        'E_MS_TX_OPEN'
      )
    if (existing) await this.closeTabSession(key)
    this.pool(database) // enforces the database cap and the open/closed state
    const connection = await this.connect(database)
    const session = new MsSession(this.config.id, this.version, database, connection, async () => {
      connection.close()
    })
    const tab = new TabSession(key, session)
    connection.on('error', (err) => {
      tab.lost = isConnectionLost(err)
        ? 'Conexión perdida: la transacción abierta se ha deshecho'
        : describeError(err)
    })
    connection.on('end', () => {
      tab.lost ??= 'Conexión perdida: la transacción abierta se ha deshecho'
    })
    this.tabs.set(key, tab)
    return tab
  }

  async closeTabSession(key: string): Promise<void> {
    const tab = this.tabs.get(key)
    if (!tab) return
    this.tabs.delete(key)
    // Closing the connection rolls back any open transaction on the server.
    await tab.session.release().catch(() => undefined)
  }

  /* ---------- executions and cancel ---------- */

  registerExecution(executionId: string | undefined, session: MsSession): void {
    if (!executionId) return
    this.cancelled.delete(executionId)
    this.executions.set(executionId, session)
  }

  unregisterExecution(executionId: string | undefined): void {
    if (!executionId) return
    this.executions.delete(executionId)
    this.cancelled.delete(executionId)
  }

  isCancelled(executionId: string | undefined): boolean {
    return !!executionId && this.cancelled.has(executionId)
  }

  /** Attention on the session running `executionId`; false when it already finished. */
  async cancel(executionId: string): Promise<boolean> {
    const session = this.executions.get(executionId)
    if (!session) return false
    this.cancelled.add(executionId)
    return session.cancel()
  }

  /* ---------- info ---------- */

  async serverInfo(): Promise<ServerInfo> {
    const session = await this.acquire(null)
    try {
      const [row] = await session.query<{
        version: string
        edition: string
        collation: string
        login: string
        engineEdition: number
      }>(
        `SELECT @@VERSION AS version,
                CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition,
                CAST(SERVERPROPERTY('Collation') AS nvarchar(128)) AS collation,
                SUSER_SNAME() AS login,
                CAST(SERVERPROPERTY('EngineEdition') AS int) AS engineEdition`
      )
      // Server-state views need VIEW SERVER STATE: without it these stay unknown.
      let uptime = 0
      let sessions = 0
      let encrypted: boolean | null = null
      try {
        const [state] = await session.query<{ up: number; n: number; enc: string | null }>(
          `SELECT DATEDIFF(SECOND, (SELECT sqlserver_start_time FROM sys.dm_os_sys_info), SYSDATETIME()) AS up,
                  (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1) AS n,
                  (SELECT encrypt_option FROM sys.dm_exec_connections WHERE session_id = @@SPID) AS enc`
        )
        uptime = Number(state?.up ?? 0) || 0
        sessions = Number(state?.n ?? 0) || 0
        encrypted = state?.enc ? state.enc === 'TRUE' : null
      } catch {
        /* no VIEW SERVER STATE */
      }
      const firstLine = (row?.version ?? '').split('\n')[0].trim()
      const details = [
        { label: 'Edición', value: row?.edition ?? '' },
        { label: 'Base de datos inicial', value: this.initialDatabase },
        { label: 'Inicio de sesión', value: row?.login ?? '' },
        {
          label: 'Cifrado',
          value: encrypted === null ? 'desconocido' : encrypted ? 'TLS' : 'sin cifrar'
        },
        ...(this.config.ssh.enabled ? [{ label: 'Túnel SSH', value: this.config.ssh.host }] : [])
      ]
      return {
        version: this.version,
        versionComment: firstLine,
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        characterSet: row?.collation ?? '',
        uptimeSeconds: uptime,
        threadsConnected: sessions,
        engine: 'sqlserver',
        details,
        runtime: {
          flavor: flavorOf(Number(row?.engineEdition)),
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

/** Server flavour from SERVERPROPERTY('EngineEdition'). */
export function flavorOf(engineEdition: number): string {
  if (engineEdition === 5) return 'azure-sql-database'
  if (engineEdition === 8) return 'azure-sql-managed-instance'
  return 'sqlserver'
}

/** '16.0.4305.5' → 16_000_000 + 0 * 10_000 + 4305. */
export function versionNumber(version: string): number {
  const [major, minor, build] = version.split('.').map((p) => Number.parseInt(p, 10) || 0)
  return (major ?? 0) * 1_000_000 + (minor ?? 0) * 10_000 + Math.min(build ?? 0, 9_999)
}

export function isMsConnection(c: unknown): c is MsDriverConnection {
  return c instanceof MsDriverConnection
}
