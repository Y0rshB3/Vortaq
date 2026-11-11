/**
 * One PostgreSQL session over one pg client (docs/multi-engine-design.md,
 * sections 5.2, 5.3 and 5.5). Pooled sessions serve introspection, grid saves
 * and table data; tab sessions (D12) are dedicated clients owned by a query
 * tab. Statements always run one at a time through pg-cursor with an exact
 * row cap (the extended protocol refuses multi-statement text, which is why
 * scripts are split first).
 */
import type pg from 'pg'
import Cursor from 'pg-cursor'
import type { FieldDef } from 'pg'
import type { TransactionStatus } from '@shared/types'
import type { SqlSession } from '../db/driver'
import { PgUserError } from './errors'
import { pgTypes } from './values'

export interface PgRawStatement {
  fields: FieldDef[]
  rows: unknown[][]
  truncated: boolean
  /** Command tag word (SELECT, INSERT, CREATE…), null for an empty statement. */
  command: string | null
  rowCount: number | null
  notices: string[]
}

/** The session ran something that may have changed its state (SET, temp tables…). */
export interface SessionUsage {
  userSql: boolean
}

const COPY_STDIO = /^\s*copy\b[\s\S]*\b(?:from\s+stdin|to\s+stdout)\b/i

/**
 * Statements the extended protocol cannot run or that belong to psql only.
 * Returns the Spanish reason, or null when the statement can be sent.
 */
export function unsupportedStatement(sql: string): string | null {
  if (/^\s*\\/.test(sql))
    return 'Los comandos de psql que empiezan por «\\» (\\d, \\copy…) no son SQL: no se pueden ejecutar aquí.'
  if (COPY_STDIO.test(sql))
    return 'COPY … FROM STDIN / TO STDOUT necesita un cliente de consola; usa SELECT para leer los datos o el editor de la tabla para modificarlos.'
  return null
}

export class PgSession implements SqlSession {
  private released = false
  readonly usage: SessionUsage = { userSql: false }
  private notices: string[] = []

  constructor(
    readonly connectionId: string,
    readonly serverVersion: string,
    readonly database: string,
    readonly client: pg.Client,
    private readonly onRelease: (session: PgSession) => Promise<void>,
    /** server_version_num (0 while unknown): what the catalog queries may use (catalogCompat.ts). */
    readonly serverVersionNum = 0
  ) {
    client.on('notice', (msg: { severity?: string; message?: string }) => {
      const severity = msg.severity ? `${msg.severity}: ` : ''
      this.notices.push(`${severity}${msg.message ?? ''}`)
    })
  }

  /** Server process id (for pg_cancel_backend). */
  get pid(): number | null {
    return (this.client as unknown as { processID: number | null }).processID ?? null
  }

  private assertOpen(): void {
    if (this.released) throw new PgUserError('La sesión de base de datos ya fue liberada')
  }

  /** Internal parameterised query (introspection, row changes). Rows as objects. */
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    this.assertOpen()
    const result = await this.client.query({ text: sql, values: params ?? [], types: pgTypes })
    return result.rows as T[]
  }

  /** Internal statement that returns rows as arrays plus their field metadata. */
  async queryArrays(
    sql: string,
    params?: unknown[]
  ): Promise<{ fields: FieldDef[]; rows: unknown[][]; rowCount: number | null; command: string }> {
    this.assertOpen()
    const result = await this.client.query({
      text: sql,
      values: params ?? [],
      rowMode: 'array',
      types: pgTypes
    })
    return {
      fields: result.fields,
      rows: result.rows as unknown[][],
      rowCount: result.rowCount,
      command: result.command
    }
  }

  /**
   * One user statement, keeping at most `maxRows` rows (one extra is read to
   * know whether the result was truncated). Notices raised meanwhile are
   * returned with it.
   */
  runStatement(sql: string, maxRows: number): Promise<PgRawStatement> {
    this.assertOpen()
    const unsupported = unsupportedStatement(sql)
    if (unsupported) return Promise.reject(new PgUserError(unsupported, 'E_PG_UNSUPPORTED'))
    this.usage.userSql = true
    this.notices = []
    const cursor = new Cursor<unknown[]>(sql, null, { rowMode: 'array', types: pgTypes })
    const submitted = this.client.query(cursor)
    void submitted
    return new Promise<PgRawStatement>((resolve, reject) => {
      cursor.read(maxRows + 1, (err, rows, result) => {
        if (err) {
          cursor.close(() => reject(err))
          return
        }
        const truncated = rows.length > maxRows
        cursor.close((closeErr) => {
          if (closeErr) {
            reject(closeErr)
            return
          }
          resolve({
            fields: result.fields ?? [],
            rows: truncated ? rows.slice(0, maxRows) : rows,
            truncated,
            command: result.command ?? null,
            rowCount: result.rowCount ?? null,
            notices: this.takeNotices()
          })
        })
      })
    })
  }

  /** Notices collected since the last call (RAISE NOTICE, WARNING…). */
  takeNotices(): string[] {
    const out = this.notices
    this.notices = []
    return out
  }

  /** 'idle' | 'in' | 'failed' from the last ReadyForQuery. */
  transactionStatus(): TransactionStatus {
    const status = (
      this.client as unknown as { getTransactionStatus(): string | null }
    ).getTransactionStatus?.()
    return status === 'T' ? 'in' : status === 'E' ? 'failed' : 'idle'
  }

  /** BEGIN … COMMIT around `fn`, rolled back on any error. */
  async transaction<T>(fn: (s: PgSession) => Promise<T>, begin = 'BEGIN'): Promise<T> {
    await this.query(begin)
    try {
      const out = await fn(this)
      await this.query('COMMIT')
      return out
    } catch (err) {
      await this.query('ROLLBACK').catch(() => undefined)
      throw err
    }
  }

  get isReleased(): boolean {
    return this.released
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    this.client.removeAllListeners('notice')
    await this.onRelease(this)
  }
}
