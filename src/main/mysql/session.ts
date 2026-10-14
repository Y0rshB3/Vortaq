import { Readable } from 'node:stream'
import type { Connection as CoreConnection, FieldPacket, Query, ResultSetHeader } from 'mysql2'
import type { PoolConnection } from 'mysql2/promise'
import type { CellValue } from '@shared/types'
import type { MysqlSession } from './types'

/** One result set of a statement, rows as raw mysql2 arrays. */
export interface RawResultSet {
  fields: FieldPacket[]
  rows: unknown[][]
  /** Total rows the server returned (rows beyond maxRows are discarded). */
  rowCount: number
  truncated: boolean
}

export interface RawStatementResult {
  resultSets: RawResultSet[]
  /** OK packet of the statement (INSERT/UPDATE/DDL/CALL); null for plain SELECTs. */
  header: ResultSetHeader | null
}

/**
 * Extra capabilities of a real mysql2-backed session that the query editor
 * and table browser need (field metadata, row cap, transactions).
 */
export interface StatementRunner {
  runStatement(sql: string, maxRows: number, params?: unknown[]): Promise<RawStatementResult>
}

export type FullSession = MysqlSession & StatementRunner

/** MySQL collation id of the `binary` character set. */
const BINARY_CHARSET = 63

function isResultSetHeader(value: unknown): value is ResultSetHeader {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'affectedRows' in value
  )
}

/**
 * MysqlSession over a dedicated pooled connection. Every statement runs on the
 * same connection, so USE / session variables / transactions stick until release.
 *
 * Session state must never leak to the next borrower of the pooled connection
 * (an abandoned transaction would keep its locks and be silently committed by
 * the next START TRANSACTION). Any call that can change state marks the
 * session dirty, and a dirty session destroys its connection on release; the
 * pool opens a fresh one (re-running the initial queries) when needed.
 * `query()` is reserved for read-only statements and keeps the session clean.
 *
 * Value fidelity relies on the pool options (see manager.buildOptions):
 * `jsonStrings` keeps JSON as the server's text and a typeCast keeps GEOMETRY
 * as its raw internal-format Buffer, so backups and the grid get exact data.
 */
export class PooledSession implements MysqlSession, StatementRunner {
  private released = false
  private dirty = false

  constructor(
    readonly connectionId: string,
    readonly serverVersion: string,
    private readonly conn: PoolConnection,
    private readonly onRelease?: () => void
  ) {}

  private get core(): CoreConnection {
    return this.conn.connection as unknown as CoreConnection
  }

  private assertOpen(): void {
    if (this.released) throw new Error('La sesión de base de datos ya fue liberada')
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    this.assertOpen()
    const [rows] = params ? await this.conn.query(sql, params) : await this.conn.query(sql)
    if (!Array.isArray(rows)) return []
    // multi-result (CALL): expose the first row set
    if (rows.length > 0 && Array.isArray(rows[0])) return rows[0] as T[]
    return rows as T[]
  }

  /** True once a state-changing call ran; the connection is then not reused. */
  get isDirty(): boolean {
    return this.dirty
  }

  async execute(
    sql: string,
    params?: unknown[]
  ): Promise<{ affectedRows: number; insertId: number | null }> {
    this.assertOpen()
    this.dirty = true
    const [res] = params ? await this.conn.query(sql, params) : await this.conn.query(sql)
    if (isResultSetHeader(res)) {
      return {
        affectedRows: res.affectedRows,
        insertId: res.insertId ? Number(res.insertId) : null
      }
    }
    return { affectedRows: 0, insertId: null }
  }

  async executeRaw(sql: string): Promise<{ affectedRows: number; insertId: number | null }> {
    this.assertOpen()
    this.dirty = true
    // mysql2 encodes a query with the connection's charset. With the binary
    // charset (63) each character of `sql` (0-255) is written as one byte.
    // The packet is built synchronously when the command starts, and this
    // session runs one command at a time, so the change never reaches another
    // query (the config object is shared by the pool's connections).
    const config = (this.core as unknown as { config: { charsetNumber: number } }).config
    const saved = config.charsetNumber
    let pending: Promise<unknown>
    config.charsetNumber = BINARY_CHARSET
    try {
      pending = this.conn.query(sql)
    } finally {
      config.charsetNumber = saved
    }
    const [res] = (await pending) as [unknown]
    if (isResultSetHeader(res)) {
      return {
        affectedRows: res.affectedRows,
        insertId: res.insertId ? Number(res.insertId) : null
      }
    }
    return { affectedRows: 0, insertId: null }
  }

  runStatement(sql: string, maxRows: number, params?: unknown[]): Promise<RawStatementResult> {
    this.assertOpen()
    this.dirty = true
    const core = this.core
    return new Promise((resolve, reject) => {
      const resultSets: RawResultSet[] = []
      let header: ResultSetHeader | null = null
      let current: RawResultSet | null = null
      let settled = false

      const onConnError = (err: Error): void => finish(err)
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        core.removeListener('error', onConnError)
        if (err) reject(err)
        else resolve({ resultSets, header })
      }
      core.on('error', onConnError)

      let q: Query
      try {
        q = core.query({ sql, values: params, rowsAsArray: true })
      } catch (err) {
        finish(err as Error)
        return
      }
      q.on('fields', (fields: FieldPacket[] | undefined) => {
        if (fields) {
          current = { fields, rows: [], rowCount: 0, truncated: false }
          resultSets.push(current)
        } else {
          current = null
        }
      })
      q.on('result', (row: unknown) => {
        if (current) {
          current.rowCount++
          if (current.rows.length < maxRows) current.rows.push(row as unknown[])
          else current.truncated = true
        } else if (isResultSetHeader(row)) {
          header = row
        }
      })
      q.on('error', (err: Error) => finish(err))
      q.on('end', () => finish())
    })
  }

  async streamRows(
    sql: string,
    params?: unknown[]
  ): Promise<{ columns: string[]; rows: Readable }> {
    const { fields, rows } = await this.streamResult(sql, params)
    return { columns: fields.map((f) => f.name), rows }
  }

  /** Server thread of this session's connection (for KILL QUERY from another session). */
  get threadId(): number | null {
    const id = (this.conn.connection as unknown as { threadId?: number | null }).threadId
    return typeof id === 'number' ? id : null
  }

  /**
   * Streams the rows of one statement as plain arrays with backpressure (mysql2
   * pauses the socket while the consumer is behind), plus the result's field
   * metadata ([] for a statement without a result set).
   */
  async streamResult(
    sql: string,
    params?: unknown[]
  ): Promise<{ fields: FieldPacket[]; rows: Readable }> {
    this.assertOpen()
    this.dirty = true
    const core = this.core
    const q = core.query({ sql, values: params, rowsAsArray: true })
    const source = q.stream({ highWaterMark: 256 })
    const onConnError = (err: Error): void => {
      if (!source.destroyed) source.destroy(err)
    }
    core.on('error', onConnError)
    source.once('close', () => core.removeListener('error', onConnError))

    const fields = await new Promise<FieldPacket[]>((resolve, reject) => {
      let settled = false
      q.once('fields', (fields: FieldPacket[] | undefined) => {
        if (settled) return
        settled = true
        resolve(fields ?? [])
      })
      const failed = (err: Error): void => {
        if (settled) return
        settled = true
        reject(err)
      }
      // mysql2 emits the query 'error' before its 'end', so failures win the race.
      q.once('error', failed)
      source.once('error', failed)
      // A statement without a result set never emits 'fields'; the query's own
      // 'end' fires even though nobody is reading the stream yet.
      const noResultSet = (): void => {
        if (settled) return
        settled = true
        resolve([])
      }
      source.once('end', noResultSet)
      q.once('end', noResultSet)
    })

    async function* mapped(): AsyncGenerator<unknown[]> {
      for await (const row of source) {
        // OK packets (statements without a result set) come through as objects
        if (Array.isArray(row)) yield row
      }
    }
    const rows = Readable.from(mapped())
    // Destroying the mapped stream (cancel, a failed write) also stops reading the socket.
    rows.once('close', () => {
      if (!source.destroyed) source.destroy()
    })
    return { fields, rows }
  }

  async useSchema(schema: string | null): Promise<void> {
    if (!schema) return
    this.assertOpen()
    this.dirty = true
    await this.conn.query(`USE ${this.escapeId(schema)}`)
  }

  escape(value: CellValue | Date | Buffer): string {
    return this.conn.escape(value)
  }

  escapeId(identifier: string): string {
    return this.conn.escapeId(identifier)
  }

  async beginTransaction(): Promise<void> {
    this.assertOpen()
    this.dirty = true
    await this.conn.beginTransaction()
  }

  async commit(): Promise<void> {
    this.assertOpen()
    await this.conn.commit()
  }

  async rollback(): Promise<void> {
    this.assertOpen()
    await this.conn.rollback()
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    try {
      if (this.dirty) this.conn.destroy()
      else this.conn.release()
    } finally {
      this.onRelease?.()
    }
  }
}
