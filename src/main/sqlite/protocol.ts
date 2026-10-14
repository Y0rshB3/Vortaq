/**
 * Messages between main and the SQLite worker process (docs/multi-engine-design.md,
 * section 5.6): `{ id, op, args }` → `{ id, ok, result | error }`. Pure types,
 * shared by core.ts (worker side) and client.ts (main side). Values are already
 * normalised in the worker (CellValue + storage class), so no driver type
 * crosses the process boundary.
 */
import type { CellValue, StorageClass } from '@shared/types'

export interface AttachRequest {
  alias: string
  filePath: string
}

export interface OpenRequest {
  /** Absolute path of the main database file. */
  filePath: string
  /** Open read-only (SQLite mode=ro). */
  readOnly: boolean
  /** PRAGMA foreign_keys at open. */
  foreignKeys: boolean
  busyTimeoutMs: number
  /** Configured attachments (each path must exist; never created). */
  attached: AttachRequest[]
  /** Initial statements (already split), run in order after the attachments. */
  initialStatements: string[]
  /** PRAGMA query_only = ON after opening (guarded connection, section 10). */
  queryOnly: boolean
  /**
   * «Nuevo archivo SQLite…» only: create the file. Refused when it already
   * exists. Every other open uses mode=rw/ro, which never creates a file.
   */
  create?: boolean
}

export interface OpenResult {
  sqliteVersion: string
  /** Effective mode: the file may be opened read-only although rw was asked. */
  readOnly: boolean
  /** Why it is read-only when the request asked for read-write (Spanish), else null. */
  readOnlyReason: string | null
}

/** Column metadata of a statement (StatementSync.columns()). */
export interface WorkerColumn {
  name: string
  /** Source column, null for expressions. */
  column: string | null
  table: string | null
  /** Attached database alias of the source table ('main', 'aux'…). */
  database: string | null
  /** Declared type of the source column, null for untyped columns and expressions. */
  type: string | null
}

export interface RunResult {
  columns: WorkerColumn[]
  /** null when the statement returns no rows (DDL, DML without RETURNING). */
  rows: CellValue[][] | null
  storage: StorageClass[][] | null
  truncated: boolean
  /** sqlite3_changes() after the statement (main keeps it only for DML). */
  changes: number
  lastInsertRowid: number | string | null
  /** DatabaseSync.isTransaction after the statement. */
  inTransaction: boolean
}

/** A statement opened for reading in steps (export): its columns and a cursor id. */
export interface CursorOpenResult {
  cursorId: number
  columns: WorkerColumn[]
}

/** The next rows of a cursor; `done` once the statement has no more. */
export interface CursorReadResult {
  rows: CellValue[][]
  storage: StorageClass[][]
  done: boolean
}

export interface QueryResult {
  rows: Record<string, unknown>[]
  changes: number
  lastInsertRowid: number | string | null
  inTransaction: boolean
}

/** One statement of a `batch`; params are bound positionally. */
export interface BatchStatement {
  sql: string
  params?: unknown[]
  /** Return the rows (as objects) of this statement. */
  rows?: boolean
}

export interface BatchResult {
  results: QueryResult[]
  inTransaction: boolean
}

export interface WorkerOps {
  open: { args: [OpenRequest]; result: OpenResult }
  /** One user statement with a row cap. */
  run: { args: [sql: string, maxRows: number]; result: RunResult }
  /** Internal parameterised statement; rows as objects with numbers (introspection, edits). */
  query: { args: [sql: string, params: unknown[]]; result: QueryResult }
  /** Several internal statements in one round trip (stops at the first error). */
  batch: { args: [statements: BatchStatement[]]; result: BatchResult }
  /** VACUUM [schema] INTO a new file (refused when the target exists); schema defaults to main. */
  vacuumInto: { args: [targetPath: string, schema?: string]; result: { sizeBytes: number } }
  /** Opens a statement that returns rows, to be read in steps (refused when it returns none). */
  cursorOpen: { args: [sql: string]; result: CursorOpenResult }
  /** Reads up to `maxRows` rows of an open cursor. */
  cursorRead: { args: [cursorId: number, maxRows: number]; result: CursorReadResult }
  cursorClose: { args: [cursorId: number]; result: null }
  /** Liveness check used by tests and the smoke run. */
  ping: { args: []; result: { pid: number } }
  close: { args: []; result: null }
}

export type WorkerOp = keyof WorkerOps

export interface WorkerRequest<O extends WorkerOp = WorkerOp> {
  id: number
  op: O
  args: WorkerOps[O]['args']
}

/** Serialisable error: node:sqlite `code`/`errcode`/`errstr` plus Vortaq's own codes. */
export interface WorkerError {
  message: string
  /** 'ERR_SQLITE_ERROR' for SQLite errors; 'E_SQLITE_*' for Vortaq's own checks. */
  code: string | null
  /** SQLite extended result code (e.g. 2067 UNIQUE), when the error comes from SQLite. */
  errcode: number | null
  errstr: string | null
  /** The message was written by Vortaq (safe to log); otherwise it is server text. */
  trusted: boolean
}

export type WorkerResponse =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: WorkerError }
