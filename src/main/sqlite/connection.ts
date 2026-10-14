/**
 * One open SQLite connection (docs/multi-engine-design.md, sections 5.3.1 and
 * 5.6): one worker process and one database handle shared by the query tabs,
 * the grid and introspection.
 *
 * - Everything goes through one lock, so a multi-step operation (a grid save,
 *   a table rebuild, a whole script) never interleaves with another one.
 * - Shared transaction (D12 for SQLite): the tab whose statement opened a
 *   transaction owns it. Other tabs may still read (they see the uncommitted
 *   changes, it is the same handle) but their writes, BEGIN/COMMIT/ROLLBACK,
 *   grid saves and designer changes are refused until it ends.
 * - Guarded connections (production, Ajustes › Seguridad) run with
 *   `PRAGMA query_only = ON`; a confirmed write lifts it for that script and it
 *   comes back when the script ends (or when the transaction it opened ends).
 * - Cancel kills the process; the next operation reopens the file with the
 *   configured attachments and initial queries (temp tables, session ATTACHes
 *   and the open transaction are lost, and the message says so).
 */
import { basename } from 'node:path'
import { sqliteDialect } from '@shared/dialects/sqlite'
import { defaultSqliteOptions } from '@shared/engines'
import type { ConnectionConfig, ServerInfo, SqliteOptions, TabSessionState } from '@shared/types'
import type { Scope, SqlDriverConnection, SqlSession } from '../db/driver'
import { getLogger } from '../log'
import { CancelledError, WorkerClient } from './client'
import { OTHER_TAB_TRANSACTION, SqliteUserError, describeForLog } from './errors'
import type {
  BatchResult,
  BatchStatement,
  OpenRequest,
  OpenResult,
  QueryResult,
  RunResult
} from './protocol'
import type { ProcessSpawner } from './spawner'

const log = getLogger('sqlite.connection')

/** Owner key of statements run without a query tab (internal or keyless db:execute). */
export const NO_TAB = ''

export interface SqliteOpenOptions {
  config: ConnectionConfig
  spawner: ProcessSpawner
  /** Writes need the typed confirmation right now (query_only until confirmed). */
  isGuarded(): boolean
  onFatal(reason: string): void
}

/** The SqliteOptions of a config, with defaults for missing keys. */
export function sqliteOf(config: Pick<ConnectionConfig, 'sqlite' | 'environment'>): SqliteOptions {
  return { ...defaultSqliteOptions(config.environment === 'production'), ...config.sqlite }
}

/** Internal session: parameterised queries, rows as objects. */
export interface SqliteSession extends SqlSession {
  batch(statements: BatchStatement[]): Promise<BatchResult>
  /** Raw form of `query` (changes, lastInsertRowid, transaction state). */
  exec(sql: string, params?: unknown[]): Promise<QueryResult>
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
}

export class SqliteDriverConnection implements SqlDriverConnection<SqliteSession> {
  readonly family = 'sql' as const
  readonly dialect = sqliteDialect
  serverVersion = ''
  /** Effective open mode and why it is read-only when rw was configured. */
  readOnly = false
  readOnlyReason: string | null = null

  private readonly client: WorkerClient
  private readonly lock = new Mutex()
  private closed = false
  /** Tab (sessionKey) whose statement opened the current transaction; null = none. */
  private txOwner: string | null = null
  private readonly tabs = new Set<string>()
  /** query_only was switched on by the guard (not by the user's own PRAGMA). */
  private guardQueryOnly = false
  /** A confirmed write lifted query_only inside a transaction: restore it when the transaction ends. */
  private restoreQueryOnly = false
  /** «Reabrir en modo escritura»: rw for this session although the config says read-only. */
  private writableOverride = false
  /** executionId of the statement running now. */
  private runningExecution: string | null = null
  /** Query tab of the running execution. */
  private runningKey: string | null = null
  /** Tabs closed while one of their scripts was still running or queued. */
  private readonly closedTabs = new Set<string>()
  private readonly cancelledExecutions = new Set<string>()
  /** The process was killed (cancel): the next operation reopens the file first. */
  private needsReopen = false

  constructor(private readonly options: SqliteOpenOptions) {
    this.client = new WorkerClient(options.spawner, (reason) => {
      if (this.closed) return
      log.warn(`SQLite worker of ${options.config.name} exited: ${reason}`)
      this.closed = true
      options.onFatal(reason)
    })
  }

  get config(): ConnectionConfig {
    return this.options.config
  }

  get settings(): SqliteOptions {
    return sqliteOf(this.options.config)
  }

  /** Open request of the configured file (re-applied after a cancel). */
  openRequest(): OpenRequest {
    const s = this.settings
    return {
      filePath: s.filePath,
      readOnly: s.readOnly && !this.writableOverride,
      foreignKeys: s.foreignKeys,
      busyTimeoutMs: s.busyTimeoutMs,
      attached: s.attached.map((a) => ({ alias: a.alias, filePath: a.filePath })),
      initialStatements: sqliteDialect
        .splitStatements(this.options.config.initialQueries ?? '')
        .map((st) => st.sql),
      queryOnly: this.options.isGuarded()
    }
  }

  /** Starts the worker and opens the file. Throws (and cleans up) on failure. */
  async probe(): Promise<OpenResult> {
    return this.lock.run(() => this.start())
  }

  private async start(): Promise<OpenResult> {
    this.client.start()
    try {
      const request = this.openRequest()
      const result = await this.client.call('open', request)
      this.serverVersion = result.sqliteVersion
      this.readOnly = result.readOnly
      this.readOnlyReason = result.readOnlyReason
      this.guardQueryOnly = request.queryOnly
      this.restoreQueryOnly = false
      this.txOwner = null
      this.needsReopen = false
      return result
    } catch (err) {
      await this.client.kill(err instanceof Error ? err : undefined).catch(() => undefined)
      throw err
    }
  }

  /** Reopens after a kill (cancel). Inside the lock. */
  private async ensureAlive(): Promise<void> {
    if (this.closed)
      throw new SqliteUserError('La conexión SQLite está cerrada.', 'E_SQLITE_CLOSED')
    if (this.client.alive && !this.needsReopen) return
    await this.start()
  }

  /** Runs `fn` with the lock held and the worker alive. */
  exclusive<T>(fn: (session: SqliteSession) => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      await this.ensureAlive()
      return fn(this.directSession())
    })
  }

  /** Session whose calls go straight to the worker: only inside `exclusive`. */
  private directSession(): SqliteSession {
    return {
      connectionId: this.options.config.id,
      serverVersion: this.serverVersion,
      query: async <T>(sql: string, params: unknown[] = []) =>
        (await this.client.call('query', sql, params)).rows as T[],
      exec: async (sql: string, params: unknown[] = []) => {
        const r = await this.client.call('query', sql, params)
        this.followTransaction(r.inTransaction, NO_TAB)
        return r
      },
      batch: async (statements: BatchStatement[]) => {
        const r = await this.client.call('batch', statements)
        this.followTransaction(r.inTransaction, NO_TAB)
        return r
      },
      release: async () => undefined
    }
  }

  /** Pooled-session equivalent: each call takes the lock on its own. */
  async acquire(_scope: Scope | null): Promise<SqliteSession> {
    return {
      connectionId: this.options.config.id,
      serverVersion: this.serverVersion,
      query: <T>(sql: string, params: unknown[] = []) =>
        this.exclusive((s) => s.query<T>(sql, params)),
      exec: (sql: string, params: unknown[] = []) => this.exclusive((s) => s.exec(sql, params)),
      batch: (statements: BatchStatement[]) => this.exclusive((s) => s.batch(statements)),
      release: async () => undefined
    }
  }

  /* ---------- statements of a query tab ---------- */

  /** Who owns the open transaction (null when none). */
  get transactionOwner(): string | null {
    return this.txOwner
  }

  /** Refuses a write while another tab owns the open transaction. */
  assertCanWrite(key: string, action?: string): void {
    if (this.txOwner === null || this.txOwner === key) return
    throw new SqliteUserError(
      action
        ? `${action}: hay una transacción abierta en una pestaña de consulta de esta conexión. Confírmala o deshazla antes.`
        : OTHER_TAB_TRANSACTION,
      'E_SQLITE_TX_OTHER_TAB'
    )
  }

  /** Records the statement's transaction effect for `key`. */
  followTransaction(inTransaction: boolean, key: string): void {
    if (inTransaction) {
      if (this.txOwner === null) this.txOwner = key
    } else {
      this.txOwner = null
    }
  }

  /** One user statement inside `exclusive` (row cap, cancel registration). */
  async runStatement(
    sql: string,
    maxRows: number,
    key: string,
    executionId?: string
  ): Promise<RunResult> {
    if (executionId) {
      this.runningExecution = executionId
      this.runningKey = key
    }
    try {
      const result = await this.client.call('run', sql, maxRows)
      this.followTransaction(result.inTransaction, key)
      return result
    } catch (err) {
      // A failing statement may still have ended the transaction (ON CONFLICT ROLLBACK,
      // RAISE(ROLLBACK), a full disk): read the real state back.
      if (!(err instanceof CancelledError)) await this.syncTransaction(key)
      throw err
    } finally {
      if (executionId && this.runningExecution === executionId) {
        this.runningExecution = null
        this.runningKey = null
      }
    }
  }

  /** Re-reads DatabaseSync.isTransaction after an error (inside `exclusive`). */
  private async syncTransaction(key: string): Promise<void> {
    try {
      const r = await this.client.call('query', 'SELECT 1', [])
      this.followTransaction(r.inTransaction, key)
    } catch {
      /* the worker is gone: the next operation reopens it */
    }
  }

  isCancelled(executionId: string | undefined): boolean {
    return !!executionId && this.cancelledExecutions.has(executionId)
  }

  forgetExecution(executionId: string | undefined): void {
    if (executionId) this.cancelledExecutions.delete(executionId)
  }

  /**
   * Cancels a running statement by killing the worker (node:sqlite has no
   * interrupt). Only an execution that is running now can be cancelled, so a
   * late cancel never hits another statement. The file is reopened right away.
   */
  async cancel(executionId: string): Promise<boolean> {
    if (!executionId || this.runningExecution !== executionId) return false
    this.cancelledExecutions.add(executionId)
    this.runningExecution = null
    this.needsReopen = true
    this.txOwner = null
    this.restoreQueryOnly = false
    log.info(`statement on ${this.options.config.name} cancelled: worker killed`)
    await this.client.kill(new CancelledError())
    // Reopen now (behind the cancelled script's unwinding) so the next call is quick.
    await this.lock
      .run(() => this.ensureAlive())
      .catch((err) => {
        log.warn(
          `reopen after cancel failed for ${this.options.config.name}: ${describeForLog(err)}`
        )
      })
    return true
  }

  /* ---------- guard (query_only) ---------- */

  /**
   * Before a write the user confirmed on a guarded connection: switch
   * query_only off. Inside `exclusive`. Returns whether it was lifted.
   */
  async liftGuard(confirmed: boolean): Promise<boolean> {
    const guarded = this.options.isGuarded()
    if (!guarded) {
      // The environment stopped needing confirmation while open: undo our own query_only.
      if (this.guardQueryOnly) {
        await this.client.call('query', 'PRAGMA query_only = OFF', [])
        this.guardQueryOnly = false
      }
      return false
    }
    if (!confirmed) {
      // Also while a confirmed transaction is open: every unconfirmed script runs guarded.
      if (!this.guardQueryOnly) {
        await this.client.call('query', 'PRAGMA query_only = ON', [])
        this.guardQueryOnly = true
      }
      return false
    }
    await this.client.call('query', 'PRAGMA query_only = OFF', [])
    this.guardQueryOnly = false
    return true
  }

  /** After a lifted write: query_only back on now, or when the open transaction ends. */
  async restoreGuard(lifted: boolean): Promise<void> {
    if (!lifted && !this.restoreQueryOnly) return
    if (!this.options.isGuarded()) {
      this.restoreQueryOnly = false
      return
    }
    if (this.txOwner !== null) {
      this.restoreQueryOnly = true
      return
    }
    await this.client.call('query', 'PRAGMA query_only = ON', [])
    this.guardQueryOnly = true
    this.restoreQueryOnly = false
  }

  /* ---------- tab sessions ---------- */

  touchTab(key: string): void {
    this.tabs.add(key)
    this.closedTabs.delete(key)
  }

  tabState(key: string): TabSessionState & { transactionElsewhere: boolean } {
    const mine = this.txOwner === key
    return {
      open: this.tabs.has(key),
      transactionStatus: mine ? 'in' : 'idle',
      effectiveSchema: null,
      database: null,
      transactionElsewhere: this.txOwner !== null && !mine
    }
  }

  /** COMMIT / ROLLBACK of the tab's own transaction. */
  async endTransaction(key: string, command: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    await this.exclusive(async () => {
      if (this.txOwner === null) return
      if (this.txOwner !== key)
        throw new SqliteUserError(
          'La transacción abierta pertenece a otra pestaña de consulta: confírmala o deshazla desde allí.',
          'E_SQLITE_TX_OTHER_TAB'
        )
      try {
        const r = await this.client.call('query', command, [])
        this.followTransaction(r.inTransaction, key)
      } catch (err) {
        await this.syncTransaction(key)
        if (this.txOwner !== null) throw err
      }
      await this.restoreGuard(false)
    })
  }

  /**
   * Closing a tab rolls back the transaction it owns. A statement of that tab
   * still running is cancelled; a script still queued sees the tab closed and
   * rolls back whatever it opened (see `rollbackIfClosed`).
   */
  async closeTab(key: string): Promise<void> {
    this.tabs.delete(key)
    if (key === NO_TAB) return
    this.closedTabs.add(key)
    if (this.runningKey === key && this.runningExecution) await this.cancel(this.runningExecution)
    await this.exclusive(async () => this.rollbackIfClosed(key)).catch(() => undefined)
  }

  /** Inside `exclusive`: a closed tab never keeps a transaction. */
  async rollbackIfClosed(key: string): Promise<void> {
    if (!this.closedTabs.has(key) || this.txOwner !== key) return
    const r = await this.client.call('query', 'ROLLBACK', [])
    this.followTransaction(r.inTransaction, key)
    await this.restoreGuard(false)
  }

  /** «Reabrir en modo escritura»: reopens the file read-write for this session. */
  async reopenWritable(): Promise<OpenResult> {
    return this.lock.run(async () => {
      if (this.txOwner !== null)
        throw new SqliteUserError(
          'Hay una transacción abierta: confírmala o deshazla antes de reabrir el archivo.',
          'E_SQLITE_TX_OPEN'
        )
      this.writableOverride = true
      await this.client.kill(new SqliteUserError('Reabriendo el archivo…', 'E_SQLITE_REOPEN'))
      return this.start()
    })
  }

  /* ---------- info ---------- */

  async serverInfo(): Promise<ServerInfo> {
    const s = this.settings
    const facts = await this.exclusive(async (session) => {
      const [row] = await session.query<{
        encoding: string
        journal: string
        fk: number
        pages: number
        pageSize: number
      }>(
        `SELECT (SELECT encoding FROM pragma_encoding) AS encoding,
                (SELECT journal_mode FROM pragma_journal_mode) AS journal,
                (SELECT foreign_keys FROM pragma_foreign_keys) AS fk,
                (SELECT page_count FROM pragma_page_count) AS pages,
                (SELECT page_size FROM pragma_page_size) AS pageSize`
      )
      return row
    })
    const mode = this.readOnly
      ? `Solo lectura${this.readOnlyReason ? ` (${this.readOnlyReason})` : ''}`
      : 'Lectura y escritura'
    const details = [
      { label: 'Archivo', value: s.filePath },
      { label: 'Modo', value: mode },
      { label: 'Claves foráneas', value: facts?.fk ? 'Aplicadas' : 'No aplicadas' },
      { label: 'Diario', value: String(facts?.journal ?? '').toUpperCase() },
      {
        label: 'Tamaño',
        value: facts ? `${Math.round(((facts.pages ?? 0) * (facts.pageSize ?? 0)) / 1024)} KB` : ''
      }
    ]
    if (s.attached.length)
      details.push({
        label: 'Adjuntas',
        value: s.attached.map((a) => `${a.alias} (${basename(a.filePath)})`).join(', ')
      })
    return {
      version: this.serverVersion,
      versionComment: 'SQLite',
      host: '',
      port: 0,
      username: '',
      characterSet: String(facts?.encoding ?? ''),
      uptimeSeconds: 0,
      threadsConnected: 0,
      engine: 'sqlite',
      details,
      runtime: {
        flavor: 'sqlite',
        versionNumber: versionNumber(this.serverVersion),
        transactions: true,
        returning: 'all',
        readOnly: this.readOnly
      }
    }
  }

  /**
   * A separate worker on the same file, opened read-only (`mode=ro` plus
   * `query_only`) with the configured attachments and without the initial
   * queries (they may write). «Exportar resultado completo» reads through it,
   * so it never waits for, blocks or kills the query tabs' shared handle, and
   * it sees only committed data. The caller closes it (kill() to cancel).
   */
  async openReader(): Promise<WorkerClient> {
    if (this.closed)
      throw new SqliteUserError('La conexión SQLite está cerrada.', 'E_SQLITE_CLOSED')
    const client = new WorkerClient(this.options.spawner, () => undefined)
    client.start()
    try {
      await client.call('open', {
        ...this.openRequest(),
        readOnly: true,
        queryOnly: true,
        initialStatements: []
      })
      return client
    } catch (err) {
      await client.kill().catch(() => undefined)
      throw err
    }
  }

  /** Copies one database (main or an attachment) to a new file with VACUUM INTO (WAL content included). */
  async vacuumInto(targetPath: string, schema = 'main'): Promise<{ sizeBytes: number }> {
    return this.exclusive(async () => {
      this.assertCanWrite(NO_TAB, 'Copiar el archivo')
      return this.client.call('vacuumInto', targetPath, schema)
    })
  }

  async close(): Promise<void> {
    this.closed = true
    await this.client.close()
  }
}

/** 3.53.4 → 3053004 (SQLITE_VERSION_NUMBER). */
export function versionNumber(version: string): number {
  const [a = 0, b = 0, c = 0] = version.split('.').map((n) => Number.parseInt(n, 10) || 0)
  return a * 1_000_000 + b * 1000 + c
}

export function isSqliteConnection(c: unknown): c is SqliteDriverConnection {
  return c instanceof SqliteDriverConnection
}
