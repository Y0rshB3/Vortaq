import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { quoteIdent } from '@shared/dialects/sqlite'
import { describeObjectCounts } from '@shared/jobLog'
import type { BackupCreateOptions, BackupCreateResult, ConnectionConfig } from '@shared/types'
import { APP_VERSION } from '../../appVersion'
import { APP_NAME } from '../../brand'
import type { SqliteDriverConnection, SqliteSession } from '../../sqlite/connection'
import { describeError } from '../../sqlite/errors'
import { rowIdentity } from '../../sqlite/introspect'
import {
  BACKUP_CANCELLED,
  checkBackupPassword,
  objectWeight,
  partialWork,
  uniqueTarget,
  noBackupFolderMessage
} from '../create'
import type { ProgressReporter } from '../index'
import type { ScryptParams } from './crypto'
import { VQB_EXTENSION, type VqbColumn } from './format'
import { encodeSqliteCell } from './sqliteValues'
import { VqbWriter } from './writer'

/**
 * SQLite backup of one database (main or an attached alias) to .vqb
 * (docs/vqb-format.md, "SQLite"). It runs on the connection's single handle,
 * holding its lock and a read transaction for a consistent snapshot. A query
 * tab's open transaction would leak uncommitted rows into the copy, so the
 * backup is refused while one exists.
 *
 * Archive order (also the restore order): tables with their data, then views.
 * Each table's meta carries its indexes, triggers and sqlite_sequence value;
 * triggers on a view travel with the view. Virtual tables are left out (their
 * content lives in shadow tables that only the module can rebuild).
 */

/** The open SQLite connection of a connection id. */
export interface SqliteConnectionProvider {
  connection(connectionId: string): Promise<SqliteDriverConnection>
}

export interface SqliteBackupDeps {
  connections: { get(id: string): ConnectionConfig | null }
  sqlite: SqliteConnectionProvider
  now?: () => Date
  chunkLimit?: number
  scrypt?: ScryptParams
}

export const SQLITE_ONLY_VQB_MESSAGE =
  'Las copias de SQLite se hacen en formato .vqb (o como copia del archivo con «Copiar archivo»).'
export const SQLITE_WHOLE_DATABASE_MESSAGE =
  'Las copias de SQLite incluyen siempre la base de datos completa: no se pueden elegir objetos sueltos.'
export const SQLITE_TX_OPEN_MESSAGE =
  'Hay una transacción abierta en una pestaña de consulta de esta conexión: confírmala o deshazla antes de hacer la copia (la copia incluiría sus cambios sin confirmar).'

const PAGE_ROWS = 1000
const ROW_PROGRESS_EVERY = 5000

export interface SqliteSchemaObject {
  type: 'table' | 'view' | 'index' | 'trigger'
  name: string
  table: string
  sql: string
}

/** User objects of one database in creation order (sqlite_schema rowid order). */
export async function listSqliteObjects(
  session: Pick<SqliteSession, 'query'>,
  db: string
): Promise<SqliteSchemaObject[]> {
  const rows = await session.query<{ type: string; name: string; tbl: string; sql: string }>(
    `SELECT type, name, tbl_name AS tbl, sql FROM ${quoteIdent(db, true)}.sqlite_schema
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid`
  )
  return rows
    .filter((r) => ['table', 'view', 'index', 'trigger'].includes(r.type))
    .map((r) => ({
      type: r.type as SqliteSchemaObject['type'],
      name: String(r.name),
      table: String(r.tbl),
      sql: String(r.sql)
    }))
}

/** Tables that are virtual (or shadow tables of a virtual table). */
async function virtualTables(
  session: Pick<SqliteSession, 'query'>,
  db: string
): Promise<Set<string>> {
  const rows = await session.query<{ name: string }>(
    "SELECT name FROM pragma_table_list WHERE schema = ? AND type IN ('virtual', 'shadow')",
    [db]
  )
  return new Set(rows.map((r) => String(r.name).toLowerCase()))
}

async function sequenceValues(
  session: Pick<SqliteSession, 'query'>,
  db: string
): Promise<Map<string, string>> {
  const has = await session.query(
    `SELECT 1 FROM ${quoteIdent(db, true)}.sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'`
  )
  if (!has.length) return new Map()
  const rows = await session.query<{ name: string; seq: number | string }>(
    `SELECT name, seq FROM ${quoteIdent(db, true)}.sqlite_sequence`
  )
  return new Map(rows.map((r) => [String(r.name).toLowerCase(), String(r.seq)]))
}

export async function createSqliteBackup(
  deps: SqliteBackupDeps,
  options: BackupCreateOptions,
  progress: ProgressReporter = () => {},
  signal?: AbortSignal
): Promise<BackupCreateResult> {
  if (!options?.connectionId) throw new Error('Selecciona una conexión para el backup.')
  const db = options.schema?.trim() || 'main'
  if (options.format && options.format !== 'vqb') throw new Error(SQLITE_ONLY_VQB_MESSAGE)
  if ((options.objects ?? []).filter(Boolean).length > 0)
    throw new Error(SQLITE_WHOLE_DATABASE_MESSAGE)
  const password = checkBackupPassword(options.password)
  const config = deps.connections.get(options.connectionId)
  if (!config) throw new Error('La conexión de la copia ya no existe.')
  const targetDir =
    options.targetDir?.trim() || (config.backupDir ? join(config.backupDir, db) : '')
  if (!targetDir) throw new Error(noBackupFolderMessage(config.name))
  const started = performance.now()
  const cancelled = (): boolean => signal?.aborted === true
  if (cancelled()) throw new Error(BACKUP_CANCELLED)

  const connection = await deps.sqlite.connection(options.connectionId)
  if (connection.transactionOwner !== null) throw new Error(SQLITE_TX_OPEN_MESSAGE)
  return connection.exclusive(async (session) => {
    if (connection.transactionOwner !== null) throw new Error(SQLITE_TX_OPEN_MESSAGE)
    let writer: VqbWriter | null = null
    await session.exec('BEGIN')
    try {
      const [info] = await session.query<{ v: string; enc: string }>(
        'SELECT sqlite_version() AS v, (SELECT encoding FROM pragma_encoding) AS enc'
      )
      const objects = await listSqliteObjects(session, db)
      const virtual = await virtualTables(session, db)
      const sequences = await sequenceValues(session, db)
      const tables = objects.filter((o) => o.type === 'table' && !virtual.has(o.name.toLowerCase()))
      const views = objects.filter((o) => o.type === 'view')
      const skipped = objects.filter((o) => o.type === 'table' && virtual.has(o.name.toLowerCase()))
      const of = (type: 'index' | 'trigger', table: string): string[] =>
        objects
          .filter((o) => o.type === type && o.table.toLowerCase() === table.toLowerCase())
          .map((o) => o.sql)

      const estimates = new Map<string, number>()
      if (options.includeData)
        for (const t of tables) {
          const [c] = await session.query<{ n: number }>(
            `SELECT count(*) AS n FROM ${quoteIdent(db, true)}.${quoteIdent(t.name, true)}`
          )
          estimates.set(t.name, Number(c?.n ?? 0))
        }

      const date = (deps.now ?? (() => new Date()))()
      const target = await uniqueTarget(targetDir, date, options.label, VQB_EXTENSION)
      writer = await VqbWriter.create(target, {
        manifest: {
          app: { name: APP_NAME, version: APP_VERSION },
          engine: { id: 'sqlite', flavor: 'sqlite', serverVersion: info?.v ?? '' },
          source: {
            ...(options.omitConnectionName ? {} : { connectionName: config.name }),
            database: db,
            encoding: info?.enc ?? null
          },
          comment: options.comment,
          options: {
            includeData: options.includeData,
            structureOnly: !options.includeData,
            partial: false
          }
        },
        password,
        scrypt: deps.scrypt,
        chunkBytes: deps.chunkLimit,
        now: () => date
      })
      if (skipped.length) {
        const w = `La copia no incluye ${skipped.length} ${skipped.length === 1 ? 'tabla virtual' : 'tablas virtuales'} (${skipped.map((s) => s.name).join(', ')}): vuelve a crearlas y llenarlas después de restaurar.`
        writer.warn(w)
        progress({ phase: 'warning', current: 0, total: 0, message: w, done: false })
      }

      const plan = [...tables, ...views]
      const total = plan.length
      const weights = plan.map((o) =>
        objectWeight(
          o.type === 'table' ? (estimates.get(o.name) ?? null) : null,
          options.includeData
        )
      )
      const workTotal = weights.reduce((sum, w) => sum + w, 0)
      let workDone = 0
      progress({
        phase: 'list',
        current: 0,
        total,
        message: describeObjectCounts(plan.map((o) => (o.type === 'table' ? 'Table' : 'View'))),
        done: false,
        detail: { objects: total, objectsDone: 0, workDone: 0, workTotal }
      })
      for (let i = 0; i < plan.length; i++) {
        if (cancelled()) throw new Error(BACKUP_CANCELLED)
        const obj = plan[i]
        const isTable = obj.type === 'table'
        const label = `${isTable ? 'tabla' : 'vista'} ${obj.name}`
        const rowsEstimate =
          isTable && options.includeData ? (estimates.get(obj.name) ?? null) : null
        const objectDetail = {
          objectType: isTable ? 'Table' : 'View',
          objectName: obj.name,
          objectIndex: i + 1,
          objects: total,
          rowsEstimate,
          workTotal
        }
        progress({
          phase: 'object',
          current: i,
          total,
          message: `Respaldando ${label}`,
          done: false,
          detail: { ...objectDetail, objectsDone: i, rows: isTable ? 0 : null, workDone }
        })
        let rows: number | null = null
        try {
          const object = writer.beginObject(isTable ? 'table' : 'view', obj.name)
          if (isTable) {
            const cols = await session.query<{ name: string; type: string; pk: number }>(
              'SELECT name, type, pk FROM pragma_table_xinfo(?, ?) WHERE hidden = 0 ORDER BY cid',
              [obj.name, db]
            )
            const columns: VqbColumn[] = cols.map((c) => ({
              name: String(c.name),
              type: String(c.type ?? '')
            }))
            object.setColumns(
              columns,
              columns.map(() => 'raw')
            )
            if (options.includeData && columns.length)
              await copyRows(
                connection,
                session,
                db,
                obj.name,
                columns,
                async (values) => {
                  await object.addRow(values)
                  if (object.rowCount % ROW_PROGRESS_EVERY === 0)
                    progress({
                      phase: 'rows',
                      current: i,
                      total,
                      message: `Respaldando ${label}: ${object.rowCount} filas`,
                      done: false,
                      detail: {
                        ...objectDetail,
                        objectsDone: i,
                        rows: object.rowCount,
                        workDone: workDone + partialWork(weights[i], object.rowCount, rowsEstimate)
                      }
                    })
                },
                cancelled
              )
            const pk = cols
              .filter((c) => Number(c.pk) > 0)
              .sort((a, b) => Number(a.pk) - Number(b.pk))
              .map((c) => String(c.name))
            const result = await object.finish({
              ddl: obj.sql,
              meta: {
                primaryKey: pk,
                indexes: of('index', obj.name),
                triggers: of('trigger', obj.name),
                autoIncrement: sequences.get(obj.name.toLowerCase()) ?? null
              }
            })
            rows = result.rows
          } else {
            await object.finish({ ddl: obj.sql, meta: { triggers: of('trigger', obj.name) } })
          }
        } catch (err) {
          if (cancelled()) throw new Error(BACKUP_CANCELLED)
          const message = describeError(err)
          progress({
            phase: 'objectError',
            current: i,
            total,
            message: `Error al respaldar ${label}`,
            done: false,
            detail: { ...objectDetail, objectsDone: i, error: message, workDone }
          })
          throw new Error(`Error al respaldar ${label}: ${message}`)
        }
        workDone += weights[i]
        progress({
          phase: 'objectDone',
          current: i + 1,
          total,
          message: `${label} respaldada`,
          done: false,
          detail: {
            ...objectDetail,
            objectsDone: i + 1,
            rows: options.includeData ? rows : null,
            workDone
          }
        })
      }
      if (cancelled()) throw new Error(BACKUP_CANCELLED)
      progress({
        phase: 'finish',
        current: total,
        total,
        message: 'Cerrando el archivo de la copia',
        done: false
      })
      const result = await writer.finish()
      writer = null
      return {
        path: result.path,
        sizeBytes: result.sizeBytes,
        objects: result.objects,
        rows: result.rows,
        durationMs: Math.round(performance.now() - started)
      }
    } catch (err) {
      await writer?.abort()
      if (cancelled()) throw new Error(BACKUP_CANCELLED)
      throw err
    } finally {
      await session.exec('ROLLBACK').catch(() => undefined)
    }
  })
}

/**
 * Streams the rows of one table with their storage classes: by rowid (or
 * the INTEGER PRIMARY KEY) in pages, or with LIMIT/OFFSET for WITHOUT ROWID
 * tables (stable inside the read transaction).
 */
async function copyRows(
  connection: SqliteDriverConnection,
  session: SqliteSession,
  db: string,
  table: string,
  columns: VqbColumn[],
  onRow: (values: unknown[]) => Promise<void>,
  cancelled: () => boolean
): Promise<void> {
  const target = `${quoteIdent(db, true)}.${quoteIdent(table, true)}`
  const list = columns.map((c) => quoteIdent(c.name, true)).join(', ')
  const identity = await rowIdentity(session, db, table)
  const key =
    identity.kind === 'rowid'
      ? identity.column
        ? quoteIdent(identity.column, true)
        : identity.alias
      : null
  let last: string | null = null
  let offset = 0
  for (;;) {
    if (cancelled()) throw new Error(BACKUP_CANCELLED)
    const sql = key
      ? `SELECT ${key}, ${list} FROM ${target}${last === null ? '' : ` WHERE ${key} > ${last}`} ORDER BY ${key} LIMIT ${PAGE_ROWS}`
      : `SELECT ${list} FROM ${target} LIMIT ${PAGE_ROWS} OFFSET ${offset}`
    const page = await connection.runStatement(sql, PAGE_ROWS, '')
    const rows = page.rows ?? []
    const storage = page.storage ?? []
    for (let r = 0; r < rows.length; r++) {
      const from = key ? 1 : 0
      const values: unknown[] = []
      for (let c = from; c < rows[r].length; c++)
        values.push(encodeSqliteCell(rows[r][c], storage[r][c]))
      await onRow(values)
      if (key) last = String(rows[r][0])
    }
    offset += rows.length
    if (rows.length < PAGE_ROWS) return
  }
}
