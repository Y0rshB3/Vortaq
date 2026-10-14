/**
 * Pure node:sqlite logic of one SQLite connection (docs/multi-engine-design.md,
 * section 5.6). It runs inside the worker process (worker.ts) and, in tests,
 * in-process; it never imports Electron.
 *
 * - Opening never creates a file (invariant 8): the path must be absolute and
 *   exist, and the file is opened through a `file:` URI with mode=rw (or ro),
 *   which SQLite refuses for a missing file. Only `create: true` («Nuevo
 *   archivo SQLite…») uses mode=rwc, and it refuses an existing file.
 * - ATTACH from SQL is checked by an authorizer: a missing or relative path is
 *   denied instead of becoming a new empty file.
 * - Values are normalised here (section 2.2): `setReadBigInts(true)`, so every
 *   INTEGER arrives as a bigint and every REAL as a number; that gives each
 *   cell's exact storage class. Big integers become strings, BLOBs `0xHEX`.
 */
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync, constants as sqliteConstants, type StatementSync } from 'node:sqlite'
import { leadingKeyword } from '@shared/dialects/sqlite'
import type { CellValue, StorageClass } from '@shared/types'
import type {
  AttachRequest,
  BatchResult,
  BatchStatement,
  CursorOpenResult,
  CursorReadResult,
  OpenRequest,
  OpenResult,
  QueryResult,
  RunResult,
  WorkerColumn,
  WorkerError
} from './protocol'

/**
 * Authorizer API of node:sqlite (Node 24.10+, newer than the bundled typings).
 * The action codes are SQLite's own (sqlite3.h).
 */
type Authorizer = (
  action: number,
  arg1: string | null,
  arg2: string | null,
  dbName: string | null,
  trigger: string | null
) => number
type AuthorizingDatabase = DatabaseSync & { setAuthorizer(callback: Authorizer | null): void }
const AUTH = {
  OK: (sqliteConstants as Record<string, number>).SQLITE_OK ?? 0,
  DENY: (sqliteConstants as Record<string, number>).SQLITE_DENY ?? 1,
  ATTACH: (sqliteConstants as Record<string, number>).SQLITE_ATTACH ?? 24
}

/** Error written by Vortaq: safe to show and to log. */
export class SqliteCoreError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'SqliteCoreError'
  }
}

const fileName = (p: string): string => p.split(/[\\/]/).pop() || p

/** «Archivo no encontrado» and friends, checked before SQLite sees the path. */
export function checkExistingFile(filePath: string, what = 'Archivo'): void {
  if (!filePath || !isAbsolute(filePath)) {
    throw new SqliteCoreError(
      `${what} no válido en este equipo: elige el archivo de nuevo (${fileName(filePath) || 'sin ruta'}).`,
      'E_SQLITE_PATH'
    )
  }
  if (!existsSync(filePath)) {
    throw new SqliteCoreError(
      `${what} no encontrado: ${fileName(filePath)}. Búscalo de nuevo en la conexión.`,
      'E_SQLITE_NOT_FOUND'
    )
  }
  if (!statSync(filePath).isFile()) {
    throw new SqliteCoreError(`${fileName(filePath)} no es un archivo.`, 'E_SQLITE_NOT_FILE')
  }
}

function canWrite(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

/** `file:` URI of an absolute path with SQLite's open mode (ro / rw / rwc). */
export function fileUri(filePath: string, mode: 'ro' | 'rw' | 'rwc'): URL {
  const url = pathToFileURL(filePath)
  url.searchParams.set('mode', mode)
  return url
}

/** CellValue + storage class of one raw node:sqlite value (setReadBigInts on). */
export function normalizeValue(value: unknown): [CellValue, StorageClass] {
  if (value === null || value === undefined) return [null, 'null']
  if (typeof value === 'bigint') {
    const safe =
      value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
    return [safe ? Number(value) : value.toString(), 'integer']
  }
  if (typeof value === 'number') return [value, 'real']
  if (typeof value === 'string') return [value, 'text']
  if (value instanceof Uint8Array)
    return ['0x' + Buffer.from(value).toString('hex').toUpperCase(), 'blob']
  return [String(value), 'text']
}

/** Plain value for internal rows: bigints become numbers when safe, BLOBs `0xHEX`. */
function plainValue(value: unknown): unknown {
  return normalizeValue(value)[0]
}

function rowId(value: unknown): number | string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return plainValue(value) as number | string
  return typeof value === 'number' ? value : null
}

/** Serialisable form of anything thrown while running an op. */
export function toWorkerError(err: unknown): WorkerError {
  if (err instanceof SqliteCoreError)
    return { message: err.message, code: err.code, errcode: null, errstr: null, trusted: true }
  const e = (err ?? {}) as {
    message?: unknown
    code?: unknown
    errcode?: unknown
    errstr?: unknown
  }
  return {
    message: typeof e.message === 'string' ? e.message : String(err),
    code: typeof e.code === 'string' ? e.code : null,
    errcode: typeof e.errcode === 'number' ? e.errcode : null,
    errstr: typeof e.errstr === 'string' ? e.errstr : null,
    trusted: false
  }
}

const ATTACH_MISSING =
  'ATTACH rechazado: el archivo no existe o la ruta no es absoluta. Vortaq nunca crea archivos al adjuntar; crea la base de datos con «Nuevo archivo SQLite…».'

/** One open database file (plus attachments) and the statements run on it. */
export class SqliteCore {
  private db: DatabaseSync | null = null
  /** Our own ATTACH statements bypass the authorizer (their path is checked first). */
  private internalAttach = false
  /** Statements read in steps (export), by cursor id. */
  private readonly cursors = new Map<number, Iterator<unknown[]>>()
  private cursorSeq = 0
  private attachDenied = false

  open(req: OpenRequest): OpenResult {
    if (this.db) throw new SqliteCoreError('La base de datos ya está abierta.', 'E_SQLITE_STATE')
    let readOnly = req.readOnly
    let readOnlyReason: string | null = null
    if (req.create) {
      if (!req.filePath || !isAbsolute(req.filePath))
        throw new SqliteCoreError('Elige dónde guardar el archivo nuevo.', 'E_SQLITE_PATH')
      if (existsSync(req.filePath))
        throw new SqliteCoreError(
          `Ya existe un archivo llamado ${fileName(req.filePath)}: ábrelo con «Abrir archivo» o elige otro nombre.`,
          'E_SQLITE_EXISTS'
        )
      if (!existsSync(dirname(req.filePath)))
        throw new SqliteCoreError('La carpeta elegida no existe.', 'E_SQLITE_PATH')
      readOnly = false
    } else {
      checkExistingFile(req.filePath)
      // WAL needs to write -shm/-wal next to the file: an unwritable folder means read-only too.
      if (!readOnly && (!canWrite(req.filePath) || !canWrite(dirname(req.filePath)))) {
        readOnly = true
        readOnlyReason =
          'El archivo o su carpeta no se pueden escribir: se ha abierto en modo solo lectura.'
      }
    }
    for (const a of req.attached)
      checkExistingFile(a.filePath, `Base de datos adjunta «${a.alias}»`)

    const mode = req.create ? 'rwc' : readOnly ? 'ro' : 'rw'
    const db = new DatabaseSync(fileUri(req.filePath, mode), {
      readOnly,
      enableForeignKeyConstraints: req.foreignKeys,
      timeout: Math.max(0, Math.floor(req.busyTimeoutMs)),
      allowExtension: false
    })
    this.db = db
    try {
      // A new file gets its header now (SQLite writes nothing until the first change).
      if (req.create) db.exec('VACUUM')
      const authorizing = db as AuthorizingDatabase
      authorizing.setAuthorizer((action, arg1) => this.authorize(action, arg1))
      for (const a of req.attached) this.attach(a, readOnly)
      if (req.queryOnly) db.exec('PRAGMA query_only = ON')
      for (const sql of req.initialStatements) {
        try {
          this.runStatement(sql, 1)
        } catch (err) {
          const detail = toWorkerError(err).message
          throw new SqliteCoreError(
            `Una consulta inicial de la conexión ha fallado: ${detail}`,
            'E_SQLITE_INITIAL_QUERY'
          )
        }
      }
      const version = db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
      return { sqliteVersion: version.v, readOnly, readOnlyReason }
    } catch (err) {
      this.close()
      throw err
    }
  }

  private authorize(action: number, arg1: string | null): number {
    if (action !== AUTH.ATTACH || this.internalAttach) return AUTH.OK
    if (arg1 === '' || arg1 === ':memory:') return AUTH.OK
    let path = arg1
    if (path && path.startsWith('file:')) {
      try {
        const url = new URL(path)
        if (url.searchParams.get('mode') === 'memory') return AUTH.OK
        path = decodeURIComponent(url.pathname)
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(path)) path = path.slice(1)
      } catch {
        path = null
      }
    }
    if (path && isAbsolute(path) && existsSync(path)) return AUTH.OK
    this.attachDenied = true
    return AUTH.DENY
  }

  private attach(a: AttachRequest, readOnly: boolean): void {
    const db = this.requireDb()
    this.internalAttach = true
    try {
      db.prepare(`ATTACH DATABASE ? AS "${a.alias.replace(/"/g, '""')}"`).run(
        fileUri(a.filePath, readOnly ? 'ro' : 'rw').href
      )
    } catch (err) {
      throw new SqliteCoreError(
        `No se pudo adjuntar «${a.alias}»: ${toWorkerError(err).message}`,
        'E_SQLITE_ATTACH'
      )
    } finally {
      this.internalAttach = false
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new SqliteCoreError('La base de datos no está abierta.', 'E_SQLITE_STATE')
    return this.db
  }

  private prepare(sql: string): StatementSync {
    const db = this.requireDb()
    this.attachDenied = false
    try {
      return db.prepare(sql)
    } catch (err) {
      if (this.attachDenied) throw new SqliteCoreError(ATTACH_MISSING, 'E_SQLITE_ATTACH_DENIED')
      throw err
    }
  }

  /** One user statement: rows capped at `maxRows` (one extra row tells `truncated`). */
  runStatement(sql: string, maxRows: number): RunResult {
    const db = this.requireDb()
    // `VACUUM INTO 'new.db'` written by the user is an explicit request to create that copy.
    const vacuum = leadingKeyword(sql) === 'VACUUM'
    if (vacuum) this.internalAttach = true
    try {
      return this.runPrepared(db, sql, maxRows)
    } finally {
      if (vacuum) this.internalAttach = false
    }
  }

  private runPrepared(db: DatabaseSync, sql: string, maxRows: number): RunResult {
    const stmt = this.prepare(sql)
    const meta = stmt.columns()
    if (meta.length === 0) {
      const r = stmt.run()
      return {
        columns: [],
        rows: null,
        storage: null,
        truncated: false,
        changes: Number(r.changes),
        lastInsertRowid: rowId(r.lastInsertRowid),
        inTransaction: db.isTransaction
      }
    }
    stmt.setReadBigInts(true)
    stmt.setReturnArrays(true)
    const rows: CellValue[][] = []
    const storage: StorageClass[][] = []
    let truncated = false
    for (const raw of stmt.iterate() as Iterable<unknown[]>) {
      if (rows.length >= maxRows) {
        truncated = true
        break
      }
      const values: CellValue[] = []
      const classes: StorageClass[] = []
      for (const v of raw) {
        const [value, cls] = normalizeValue(v)
        values.push(value)
        classes.push(cls)
      }
      rows.push(values)
      storage.push(classes)
    }
    const changes = db.prepare('SELECT changes() AS c').get() as { c: number }
    return {
      columns: meta.map((c): WorkerColumn => ({
        name: c.name,
        column: c.column ?? null,
        table: c.table ?? null,
        database: c.database ?? null,
        type: c.type ?? null
      })),
      rows,
      storage,
      truncated,
      changes: Number(changes.c),
      lastInsertRowid: null,
      inTransaction: db.isTransaction
    }
  }

  /** Opens a statement that returns rows, read in steps with cursorRead (export). */
  cursorOpen(sql: string): CursorOpenResult {
    const stmt = this.prepare(sql)
    const meta = stmt.columns()
    if (meta.length === 0)
      throw new SqliteCoreError('La consulta no devuelve filas.', 'E_SQLITE_NO_ROWS')
    stmt.setReadBigInts(true)
    stmt.setReturnArrays(true)
    const iterator = (stmt.iterate() as Iterable<unknown[]>)[Symbol.iterator]()
    const cursorId = ++this.cursorSeq
    this.cursors.set(cursorId, iterator)
    return {
      cursorId,
      columns: meta.map((c): WorkerColumn => ({
        name: c.name,
        column: c.column ?? null,
        table: c.table ?? null,
        database: c.database ?? null,
        type: c.type ?? null
      }))
    }
  }

  cursorRead(cursorId: number, maxRows: number): CursorReadResult {
    const iterator = this.cursors.get(cursorId)
    if (!iterator) throw new SqliteCoreError('El cursor ya está cerrado.', 'E_SQLITE_STATE')
    const rows: CellValue[][] = []
    const storage: StorageClass[][] = []
    const limit = Math.max(1, Math.floor(maxRows))
    while (rows.length < limit) {
      const next = iterator.next()
      if (next.done) {
        this.cursors.delete(cursorId)
        return { rows, storage, done: true }
      }
      const values: CellValue[] = []
      const classes: StorageClass[] = []
      for (const v of next.value) {
        const [value, cls] = normalizeValue(v)
        values.push(value)
        classes.push(cls)
      }
      rows.push(values)
      storage.push(classes)
    }
    return { rows, storage, done: false }
  }

  cursorClose(cursorId: number): void {
    const iterator = this.cursors.get(cursorId)
    this.cursors.delete(cursorId)
    try {
      iterator?.return?.()
    } catch {
      /* already finished */
    }
  }

  /** Internal statement with bound parameters; rows as plain objects. */
  query(sql: string, params: unknown[] = []): QueryResult {
    const db = this.requireDb()
    const stmt = this.prepare(sql)
    stmt.setReadBigInts(true)
    const bound = params.map(bindable)
    if (stmt.columns().length === 0) {
      const r = stmt.run(...(bound as never[]))
      return {
        rows: [],
        changes: Number(r.changes),
        lastInsertRowid: rowId(r.lastInsertRowid),
        inTransaction: db.isTransaction
      }
    }
    const rows = (stmt.all(...(bound as never[])) as Record<string, unknown>[]).map((r) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(r)) out[k] = plainValue(v)
      return out
    })
    const changes = db.prepare('SELECT changes() AS c').get() as { c: number }
    return {
      rows,
      changes: Number(changes.c),
      lastInsertRowid: null,
      inTransaction: db.isTransaction
    }
  }

  /** Several internal statements in order; the first error stops the batch. */
  batch(statements: BatchStatement[]): BatchResult {
    const results = statements.map((s) => this.query(s.sql, s.params ?? []))
    return { results, inTransaction: this.requireDb().isTransaction }
  }

  /** VACUUM INTO a new file: a consistent copy, WAL content included. */
  vacuumInto(targetPath: string, schema = 'main'): { sizeBytes: number } {
    if (!targetPath || !isAbsolute(targetPath))
      throw new SqliteCoreError('Elige dónde guardar la copia.', 'E_SQLITE_PATH')
    if (existsSync(targetPath))
      throw new SqliteCoreError(
        `Ya existe ${fileName(targetPath)}: elige otro nombre para la copia.`,
        'E_SQLITE_EXISTS'
      )
    const db = this.requireDb()
    if (db.isTransaction)
      throw new SqliteCoreError(
        'Hay una transacción abierta: confírmala o deshazla antes de copiar el archivo.',
        'E_SQLITE_IN_TRANSACTION'
      )
    // VACUUM INTO attaches its target internally: let it past the ATTACH check. It never
    // changes the source, but SQLite refuses it under query_only: lift that for the copy.
    const [{ q }] = db.prepare('SELECT query_only AS q FROM pragma_query_only').all() as {
      q: number
    }[]
    if (q) db.exec('PRAGMA query_only = OFF')
    this.internalAttach = true
    try {
      db.prepare(`VACUUM "${schema.replace(/"/g, '""')}" INTO ?`).run(targetPath)
    } finally {
      this.internalAttach = false
      if (q) db.exec('PRAGMA query_only = ON')
    }
    return { sizeBytes: statSync(targetPath).size }
  }

  get inTransaction(): boolean {
    return this.db?.isTransaction ?? false
  }

  close(): void {
    for (const id of [...this.cursors.keys()]) this.cursorClose(id)
    const db = this.db
    this.db = null
    if (db?.isOpen) {
      try {
        db.close()
      } catch {
        /* closing a broken handle */
      }
    }
  }
}

/**
 * A parameter as node:sqlite binds it. `{ $blob: '0xHEX' }` binds a BLOB and
 * `{ $int: '123' }` an INTEGER (exact, also beyond 2^53); everything else is
 * bound as is (string → TEXT, number → REAL/INTEGER, null → NULL).
 */
export function bindable(value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const v = value as { $blob?: unknown; $int?: unknown }
    if (typeof v.$blob === 'string') return Buffer.from(v.$blob.replace(/^0x/i, ''), 'hex')
    if (typeof v.$int === 'string' || typeof v.$int === 'number') return BigInt(v.$int)
  }
  return value
}
