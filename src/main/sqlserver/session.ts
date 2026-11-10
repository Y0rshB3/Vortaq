/**
 * One SQL Server session over one tedious connection (docs/sqlserver-design.md,
 * «Sesiones»). Pooled sessions serve introspection, grid saves and table
 * data; tab sessions are dedicated connections owned by a query tab.
 *
 * User SQL runs one batch at a time (runBatch): the server answers with a
 * stream of result sets, row counts, errors and messages, which is kept in
 * order as outputs. A batch keeps running after most errors, like in SSMS.
 * Internal queries (query/queryArrays) use @p1…@pn parameters.
 */
import { Request, TYPES, type Connection } from 'tedious'
import type { ColumnMetadata } from 'tedious/lib/token/colmetadata-token-parser'
import type { TransactionStatus } from '@shared/types'
import type { SqlSession } from '../db/driver'
import { MsUserError } from './errors'

/** What one server reply of a batch was, in arrival order. */
export type BatchOutput =
  | {
      kind: 'rows'
      columns: ColumnMetadata[]
      rows: unknown[][]
      truncated: boolean
      messages: string[]
    }
  | { kind: 'count'; rowCount: number; messages: string[] }
  | { kind: 'error'; error: ServerMessage; messages: string[] }
  | { kind: 'messages'; messages: string[] }

/** An ERROR or INFO token of the server. */
export interface ServerMessage {
  number: number
  message: string
  class: number
  state: number
  lineNumber: number
  procName?: string
}

export interface BatchResult {
  outputs: BatchOutput[]
  /** The run was cancelled (by the user, or by Vortaq after the row cap of a single query). */
  cancelled: boolean
}

export interface BatchOptions {
  /** Rows kept per result set (one more is read to know it was truncated). */
  maxRows: number
  /**
   * The batch is a single query: once maxRows + 1 rows arrived the rest is
   * not needed and the request is cancelled (nothing else in it would run).
   */
  stopAtCap?: boolean
}

/** Rows of one query, read batch by batch (see MsSession.stream). */
export interface RowStream {
  /** Columns of the first result set, or null when the statement returned none. */
  columns(): Promise<ColumnMetadata[] | null>
  /** The next batch, or null at the end. */
  next(): Promise<unknown[][] | null>
}

/** The session ran something that may have changed its state (SET, USE, #temp…). */
export interface SessionUsage {
  userSql: boolean
}

type ParamType = (typeof TYPES)[keyof typeof TYPES]

export interface QueryOptions {
  /** The server request is cancelled after this long (ETIMEOUT). */
  timeoutMs?: number
}

export interface QueryArraysResult {
  columns: ColumnMetadata[]
  /** Rows of the last result set. */
  rows: unknown[][]
  /** Sum of every statement's row count. */
  rowCount: number
  /** Row count of each statement that reported one, in order. */
  counts: number[]
}

/** tedious type of an internal query parameter. */
function paramType(value: unknown): ParamType {
  if (typeof value === 'number')
    return Number.isInteger(value) && Math.abs(value) <= 2147483647 ? TYPES.Int : TYPES.Float
  if (typeof value === 'bigint') return TYPES.BigInt
  if (typeof value === 'boolean') return TYPES.Bit
  if (Buffer.isBuffer(value)) return TYPES.VarBinary
  return TYPES.NVarChar
}

export class MsSession implements SqlSession {
  private released = false
  readonly usage: SessionUsage = { userSql: false }
  /** The request on the wire, for cancel. */
  private running: Request | null = null
  private cancelRequested = false
  /** tedious runs one request per connection (no MARS): requests wait for the previous one. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly connectionId: string,
    readonly serverVersion: string,
    /** Database the session was opened in (its pool). */
    readonly database: string,
    readonly connection: Connection,
    private readonly onRelease: (session: MsSession) => Promise<void>
  ) {}

  private assertOpen(): void {
    if (this.released) throw new MsUserError('La sesión de base de datos ya fue liberada')
  }

  /** Internal parameterised query (@p1, @p2…); rows as objects by column name. */
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options: QueryOptions = {}
  ): Promise<T[]> {
    const { columns, rows } = await this.queryArrays(sql, params, options)
    return rows.map((row) => {
      const out: Record<string, unknown> = {}
      columns.forEach((c, i) => (out[c.colName] = row[i]))
      return out as T
    })
  }

  /** Internal query returning the last result set's rows as arrays plus their metadata. */
  queryArrays(
    sql: string,
    params?: unknown[],
    options: QueryOptions = {}
  ): Promise<QueryArraysResult> {
    this.assertOpen()
    return this.serial(() => this.sendQuery(sql, params, options))
  }

  /** Runs `fn` after every request sent before it has finished. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private sendQuery(
    sql: string,
    params: unknown[] | undefined,
    options: QueryOptions
  ): Promise<QueryArraysResult> {
    return new Promise((resolve, reject) => {
      let columns: ColumnMetadata[] = []
      let rows: unknown[][] = []
      const counts: number[] = []
      const request = new Request(sql, (err, rowCount) => {
        this.running = null
        if (err) reject(err)
        else resolve({ columns, rows, rowCount: rowCount ?? 0, counts })
      })
      // tedious cancels a request that passes its timeout (ETIMEOUT).
      if (options.timeoutMs) request.setTimeout(options.timeoutMs)
      const onDone = (rowCount: number | undefined): void => {
        if (rowCount !== undefined && rowCount !== null) counts.push(rowCount)
      }
      request.on('doneInProc', (rowCount) => onDone(rowCount))
      request.on('done', (rowCount) => onDone(rowCount))
      params?.forEach((value, i) =>
        request.addParameter(`p${i + 1}`, paramType(value), value ?? null)
      )
      request.on('columnMetadata', (meta) => {
        columns = Array.isArray(meta) ? meta : Object.values(meta)
        rows = []
      })
      request.on('row', (cells: { value: unknown }[]) => rows.push(cells.map((c) => c.value)))
      this.running = request
      if (params?.length) this.connection.execSql(request)
      else this.connection.execSqlBatch(request)
    })
  }

  /** A statement without results (SET, BEGIN TRAN…), as a plain batch. */
  async exec(sql: string): Promise<void> {
    await this.queryArrays(sql)
  }

  /**
   * One user batch. Outputs keep the server's order; INFO messages (PRINT,
   * RAISERROR < 11) are attached to the output they arrive before.
   */
  runBatch(sql: string, options: BatchOptions): Promise<BatchResult> {
    this.assertOpen()
    return this.serial(() => this.sendBatch(sql, options))
  }

  private sendBatch(sql: string, options: BatchOptions): Promise<BatchResult> {
    this.usage.userSql = true
    this.cancelRequested = false
    const outputs: BatchOutput[] = []
    let pending: string[] = []
    let current: Extract<BatchOutput, { kind: 'rows' }> | null = null
    let cappedByUs = false
    const takeMessages = (): string[] => {
      const out = pending
      pending = []
      return out
    }
    const onInfo = (m: ServerMessage): void => {
      pending.push(m.message)
    }
    const onError = (m: ServerMessage): void => {
      current = null
      outputs.push({ kind: 'error', error: { ...m }, messages: takeMessages() })
    }
    this.connection.on('infoMessage', onInfo)
    this.connection.on('errorMessage', onError)
    const cleanup = (): void => {
      this.connection.removeListener('infoMessage', onInfo)
      this.connection.removeListener('errorMessage', onError)
      this.running = null
    }
    return new Promise<BatchResult>((resolve, reject) => {
      const request = new Request(sql, (err) => {
        cleanup()
        if (pending.length) outputs.push({ kind: 'messages', messages: takeMessages() })
        const cancelled = this.cancelRequested || cappedByUs
        // Server errors are already outputs; a cancel ends the run; anything else is a failure.
        if (err && (err as { code?: string }).code === 'ECANCEL') {
          resolve({ outputs, cancelled: this.cancelRequested })
          return
        }
        if (err && !outputs.some((o) => o.kind === 'error')) {
          reject(err)
          return
        }
        resolve({ outputs, cancelled })
      })
      request.on('columnMetadata', (meta) => {
        const columns = Array.isArray(meta) ? meta : Object.values(meta)
        current = { kind: 'rows', columns, rows: [], truncated: false, messages: takeMessages() }
        outputs.push(current)
      })
      request.on('row', (cells: { value: unknown }[]) => {
        const target = current
        if (!target) return
        if (target.rows.length < options.maxRows) {
          target.rows.push(cells.map((c) => c.value))
          return
        }
        if (!target.truncated) {
          target.truncated = true
          if (options.stopAtCap && !cappedByUs) {
            cappedByUs = true
            this.connection.cancel()
          }
        }
      })
      const onDone = (rowCount: number | undefined): void => {
        if (current) {
          current = null
          return
        }
        if (rowCount !== undefined && rowCount !== null)
          outputs.push({ kind: 'count', rowCount, messages: takeMessages() })
      }
      request.on('doneInProc', (rowCount) => onDone(rowCount))
      request.on('done', (rowCount) => onDone(rowCount))
      request.on('doneProc', () => {
        current = null
      })
      this.running = request
      this.connection.execSqlBatch(request)
    })
  }

  /**
   * Streams the rows of one query in batches of `batchRows`, pausing the
   * server while a batch waits to be consumed (exports). The session runs
   * nothing else until the stream ends; `cancel()` stops it on the server.
   */
  stream(sql: string, batchRows: number): RowStream {
    this.assertOpen()
    this.usage.userSql = true
    let columns: ColumnMetadata[] | null = null
    let buffer: unknown[][] = []
    let finished = false
    let failure: unknown = null
    let wake: (() => void) | null = null
    const signal = (): void => {
      const w = wake
      wake = null
      w?.()
    }
    let firstColumns: (value: ColumnMetadata[] | null) => void = () => undefined
    const columnsReady = new Promise<ColumnMetadata[] | null>((resolve) => (firstColumns = resolve))
    const request = new Request(sql, (err) => {
      this.running = null
      finished = true
      if (err) failure = err
      firstColumns(columns)
      signal()
    })
    request.on('columnMetadata', (meta) => {
      if (columns) return // only the first result set is exported
      columns = Array.isArray(meta) ? meta : Object.values(meta)
      firstColumns(columns)
    })
    request.on('row', (cells: { value: unknown }[]) => {
      buffer.push(cells.map((c) => c.value))
      if (buffer.length >= batchRows) {
        request.pause()
        signal()
      }
    })
    this.running = request
    this.connection.execSqlBatch(request)
    return {
      columns: async () => {
        const out = await columnsReady
        if (failure) throw failure
        return out
      },
      next: async () => {
        while (buffer.length < batchRows && !finished) {
          await new Promise<void>((resolve) => (wake = resolve))
        }
        if (failure) throw failure
        if (!buffer.length) return null
        const batch = buffer
        buffer = []
        if (!finished) request.resume()
        return batch
      }
    }
  }

  /** Sends an attention for the running request; false when nothing runs. */
  cancel(): boolean {
    if (!this.running) return false
    this.cancelRequested = true
    return this.connection.cancel()
  }

  get isRunning(): boolean {
    return this.running !== null
  }

  /** 'idle' | 'in' | 'failed' from @@TRANCOUNT and XACT_STATE(). */
  async transactionStatus(): Promise<TransactionStatus> {
    const [row] = await this.query<{ tc: number; xs: number }>(
      'SELECT @@TRANCOUNT AS tc, XACT_STATE() AS xs'
    )
    if (!row || row.tc === 0) return 'idle'
    return row.xs === -1 ? 'failed' : 'in'
  }

  /** BEGIN TRAN … COMMIT around `fn`, rolled back on any error. */
  async transaction<T>(fn: (s: MsSession) => Promise<T>): Promise<T> {
    await this.exec('SET XACT_ABORT ON; BEGIN TRANSACTION')
    try {
      const out = await fn(this)
      await this.exec('COMMIT TRANSACTION; SET XACT_ABORT OFF')
      return out
    } catch (err) {
      await this.exec('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION; SET XACT_ABORT OFF').catch(
        () => undefined
      )
      throw err
    }
  }

  get isReleased(): boolean {
    return this.released
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    await this.onRelease(this)
  }
}
