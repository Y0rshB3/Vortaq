import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Writable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import type { SqlExportOptions, SqlExportResult } from '@shared/importers'
import { CAPABILITY_MESSAGES, requireConnectionCapability } from '../db/errors'
import { describeError } from '../mysql/errors'
import type { MysqlSession } from '../mysql/types'
import { noBackupFolderMessage, objectWeight, partialWork, type CreateDeps } from './create'
import type { ProgressReporter } from './index'
import { literalKindOf, quoteString, renderTuple, type LiteralKind } from './mysqlLiterals'
import { formatSqlDumpFileName } from './naming'
import { isTrxIdVersionedDdl, setSequenceValueSql, systemVersioningColumns } from '../mysql/mariadb'

/**
 * Plain SQL dump of one schema that the mysql command-line client (and other
 * managers) can run: session preamble, optional CREATE DATABASE + USE, then
 * per table DROP/CREATE and extended INSERTs followed by its triggers, then
 * routines, views (dependency order) and events, and a footer that restores
 * the session variables. Values are read through the same pool options as
 * the .nb3 backups (dates and big numbers as text) with the session time zone
 * at UTC, and the dump sets `TIME_ZONE='+00:00'` so TIMESTAMPs round-trip.
 */

export const EXPORT_CANCELLED = 'Exportación cancelada'

/** Extended INSERT limits (rows and bytes per statement). */
export const INSERT_MAX_ROWS = 500
export const INSERT_MAX_BYTES = 1024 * 1024

const ROW_PROGRESS_EVERY = 5000

type ObjectKind = 'Sequence' | 'Table' | 'View' | 'Function' | 'Procedure' | 'Event'

interface SchemaObject {
  type: ObjectKind
  name: string
  /** MariaDB system-versioned table. */
  versioned?: boolean
  rowsEstimate: number | null
  /** sql_mode the routine/event was created with (null when unknown). */
  sqlMode: string | null
  /** Events: their own time zone. */
  timeZone: string | null
}

interface TriggerRef {
  name: string
  sqlMode: string | null
}

const KIND_LABEL: Record<ObjectKind, string> = {
  Sequence: 'secuencia',
  Table: 'tabla',
  View: 'vista',
  Function: 'función',
  Procedure: 'procedimiento',
  Event: 'evento'
}

const KIND_TITLE: Record<ObjectKind, string> = {
  Sequence: 'Secuencia',
  Table: 'Tabla',
  View: 'Vista',
  Function: 'Función',
  Procedure: 'Procedimiento',
  Event: 'Evento'
}

const SHOW_CREATE: Record<Exclude<ObjectKind, 'Table'>, { stmt: string; column: string }> = {
  Sequence: { stmt: 'SHOW CREATE SEQUENCE', column: 'Create Table' },
  View: { stmt: 'SHOW CREATE VIEW', column: 'Create View' },
  Function: { stmt: 'SHOW CREATE FUNCTION', column: 'Create Function' },
  Procedure: { stmt: 'SHOW CREATE PROCEDURE', column: 'Create Procedure' },
  Event: { stmt: 'SHOW CREATE EVENT', column: 'Create Event' }
}

const DROP_KEYWORD: Record<Exclude<ObjectKind, 'Table'>, string> = {
  Sequence: 'SEQUENCE',
  View: 'VIEW',
  Function: 'FUNCTION',
  Procedure: 'PROCEDURE',
  Event: 'EVENT'
}

/**
 * Output order: MariaDB sequences (a table default may call NEXTVAL), tables,
 * routines (views may call functions), views, events.
 */
const TYPE_ORDER: ObjectKind[] = ['Sequence', 'Table', 'Function', 'Procedure', 'View', 'Event']

const GENERATED_RE = /\b(VIRTUAL|STORED) GENERATED\b/i

const text = (value: unknown): string =>
  value === null || value === undefined
    ? ''
    : Buffer.isBuffer(value)
      ? value.toString('utf8')
      : String(value)

const optionalText = (value: unknown): string | null =>
  value === null || value === undefined ? null : text(value)

const estimateOf = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const n = Number(text(value))
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

const id = (name: string): string => '`' + name.replace(/`/g, '``') + '`'

/** Writes text to the target file (optionally gzip), counting uncompressed bytes. */
class DumpWriter {
  bytes = 0
  private error: Error | null = null

  private constructor(
    readonly partialPath: string,
    private readonly out: Writable,
    private readonly file: WriteStream,
    private readonly done: Promise<void>
  ) {
    out.on('error', (err) => (this.error ??= err))
    file.on('error', (err) => (this.error ??= err))
    done.catch((err: Error) => (this.error ??= err))
  }

  static async open(partialPath: string, gzip: boolean): Promise<DumpWriter> {
    await mkdir(dirname(partialPath), { recursive: true })
    const file = createWriteStream(partialPath, { flags: 'wx' })
    await new Promise<void>((resolve, reject) => {
      file.once('open', () => resolve())
      file.once('error', reject)
    })
    if (gzip) {
      const zip = createGzip()
      return new DumpWriter(partialPath, zip, file, pipeline(zip, file))
    }
    return new DumpWriter(partialPath, file, file, finished(file))
  }

  async write(chunk: string): Promise<void> {
    if (this.error) throw this.error
    this.bytes += Buffer.byteLength(chunk, 'utf8')
    if (!this.out.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          this.out.off('drain', onDrain)
          reject(err)
        }
        const onDrain = (): void => {
          this.out.off('error', onError)
          resolve()
        }
        this.out.once('drain', onDrain)
        this.out.once('error', onError)
      })
    }
  }

  async close(): Promise<void> {
    if (this.error) throw this.error
    this.out.end()
    await this.done
    if (this.error) throw this.error
  }

  async abort(): Promise<void> {
    this.out.destroy()
    this.file.destroy()
    await this.done.catch(() => undefined)
    await rm(this.partialPath, { force: true }).catch(() => undefined)
  }
}

async function listTablesFresh<T>(
  session: MysqlSession,
  fresh: boolean,
  fn: () => Promise<T>
): Promise<T> {
  if (!fresh) return fn()
  let changed = false
  try {
    await session.execute('SET SESSION information_schema_stats_expiry = 0')
    changed = true
  } catch {
    /* older servers and MariaDB: cached estimates */
  }
  try {
    return await fn()
  } finally {
    if (changed)
      await session
        .execute('SET SESSION information_schema_stats_expiry = DEFAULT')
        .catch(() => undefined)
  }
}

async function listObjects(
  session: MysqlSession,
  schema: string,
  freshStats: boolean
): Promise<SchemaObject[]> {
  const tables = await listTablesFresh(session, freshStats, () =>
    session.query<{ name: unknown; type: unknown; estRows?: unknown }>(
      'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS estRows FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [schema]
    )
  )
  const routines = await session.query<{ name: unknown; type: unknown; sqlMode?: unknown }>(
    'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, SQL_MODE AS sqlMode FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME',
    [schema]
  )
  const events = await session.query<{ name: unknown; sqlMode?: unknown; timeZone?: unknown }>(
    'SELECT EVENT_NAME AS name, SQL_MODE AS sqlMode, TIME_ZONE AS timeZone FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME',
    [schema]
  )
  const objects: SchemaObject[] = []
  const base = { rowsEstimate: null, sqlMode: null, timeZone: null }
  for (const t of tables) {
    const type = text(t.type).toUpperCase()
    if (type === 'BASE TABLE')
      objects.push({
        ...base,
        type: 'Table',
        name: text(t.name),
        rowsEstimate: estimateOf(t.estRows)
      })
    else if (type === 'VIEW') objects.push({ ...base, type: 'View', name: text(t.name) })
    // MariaDB only (a MySQL server never reports these types).
    else if (type === 'SYSTEM VERSIONED')
      objects.push({
        ...base,
        type: 'Table',
        name: text(t.name),
        rowsEstimate: estimateOf(t.estRows),
        versioned: true
      })
    else if (type === 'SEQUENCE') objects.push({ ...base, type: 'Sequence', name: text(t.name) })
  }
  for (const r of routines) {
    const type = text(r.type).toUpperCase()
    const kind: ObjectKind | null =
      type === 'FUNCTION' ? 'Function' : type === 'PROCEDURE' ? 'Procedure' : null
    if (kind)
      objects.push({ ...base, type: kind, name: text(r.name), sqlMode: optionalText(r.sqlMode) })
  }
  for (const e of events)
    objects.push({
      ...base,
      type: 'Event',
      name: text(e.name),
      sqlMode: optionalText(e.sqlMode),
      timeZone: optionalText(e.timeZone)
    })
  return objects
}

async function listTriggers(
  session: MysqlSession,
  schema: string
): Promise<Map<string, TriggerRef[]>> {
  const rows = await session.query<{ name: unknown; tableName: unknown; sqlMode?: unknown }>(
    'SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tableName, SQL_MODE AS sqlMode FROM information_schema.TRIGGERS ' +
      'WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER',
    [schema]
  )
  const byTable = new Map<string, TriggerRef[]>()
  for (const r of rows) {
    const table = text(r.tableName)
    const list = byTable.get(table) ?? []
    list.push({ name: text(r.name), sqlMode: optionalText(r.sqlMode) })
    byTable.set(table, list)
  }
  return byTable
}

async function showCreate(
  session: MysqlSession,
  stmt: string,
  name: string,
  column: string
): Promise<string> {
  const rows = await session.query<Record<string, unknown>>(`${stmt} ${session.escapeId(name)}`)
  const ddl = text(rows[0]?.[column])
  if (!ddl) {
    throw new Error(
      `No se pudo obtener la definición de ${name}: el usuario no tiene permisos suficientes para verla`
    )
  }
  return ddl
}

async function tableColumns(
  session: MysqlSession,
  schema: string,
  table: string
): Promise<{ name: string; columnType: string; extra: string }[]> {
  const rows = await session.query<{ name: unknown; columnType: unknown; extra: unknown }>(
    'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS columnType, EXTRA AS extra FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [schema, table]
  )
  return rows.map((r) => ({
    name: text(r.name),
    columnType: text(r.columnType),
    extra: text(r.extra)
  }))
}

async function schemaCharset(
  session: MysqlSession,
  schema: string
): Promise<{ charset: string; collation: string } | null> {
  try {
    const rows = await session.query<{ cs: unknown; co: unknown }>(
      'SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [schema]
    )
    const cs = text(rows[0]?.cs)
    return cs ? { charset: cs, collation: text(rows[0]?.co) } : null
  } catch {
    return null
  }
}

/**
 * Views in an order where a view comes after every view whose quoted name it
 * mentions; a cycle (impossible on a real server) falls back to name order.
 */
export function orderViews<T extends { name: string; ddl: string }>(views: T[]): T[] {
  const byName = new Map(views.map((v) => [v.name, v]))
  const deps = new Map<string, string[]>()
  for (const v of views) {
    const body = v.ddl.replace(/^[\s\S]*?\bVIEW\s+`(?:[^`]|``)+`/i, '')
    deps.set(
      v.name,
      views
        .filter((o) => o.name !== v.name && body.includes(id(o.name)))
        .map((o) => o.name)
        .sort()
    )
  }
  const out: T[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (name: string): void => {
    if (state.get(name)) return
    state.set(name, 'visiting')
    for (const dep of deps.get(name) ?? []) visit(dep)
    state.set(name, 'done')
    out.push(byName.get(name)!)
  }
  for (const v of [...views].sort((a, b) => a.name.localeCompare(b.name))) visit(v.name)
  return out
}

/** Picks `<dir>/<stamp>[-label].sql[.gz]`, adding a numeric suffix when taken. */
async function uniqueTarget(
  dir: string,
  date: Date,
  label: string | undefined,
  gzip: boolean
): Promise<string> {
  const exists = (p: string): Promise<boolean> =>
    stat(p).then(
      () => true,
      () => false
    )
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? label : `${label ? `${label}-` : ''}${i}`
    const candidate = join(dir, formatSqlDumpFileName(date, suffix, gzip))
    if (!(await exists(candidate)) && !(await exists(`${candidate}.partial`))) return candidate
  }
  throw new Error(`No se pudo elegir un nombre libre para la exportación en ${dir}`)
}

function validate(options: SqlExportOptions): void {
  if (!options || typeof options !== 'object')
    throw new Error('Opciones de exportación no válidas.')
  if (!options.connectionId) throw new Error('Selecciona una conexión para exportar.')
  if (!options.schema || !options.schema.trim())
    throw new Error('Selecciona la base de datos a exportar.')
  if (!options.includeStructure && !options.includeData)
    throw new Error('Elige exportar la estructura, los datos o ambos.')
}

const two = (n: number): string => String(n).padStart(2, '0')
const stampOf = (d: Date): string =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ')

function preamble(serverVersion: string, schema: string, date: Date, utc: boolean): string {
  return [
    '-- Vortaq SQL dump',
    `-- Servidor: MySQL ${oneLine(serverVersion) || 'desconocido'}`,
    `-- Base de datos: ${oneLine(schema)}`,
    `-- Fecha: ${stampOf(date)}`,
    '-- Se puede importar con el cliente mysql o con cualquier gestor que ejecute archivos .sql.',
    '',
    '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;',
    '/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;',
    '/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;',
    'SET NAMES utf8mb4;',
    ...(utc
      ? ['/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;', "/*!40103 SET TIME_ZONE='+00:00' */;"]
      : []),
    '/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;',
    '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
    "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
    '/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;',
    '',
    ''
  ].join('\n')
}

function footer(utc: boolean): string {
  return [
    ...(utc ? ['/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;'] : []),
    '/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;',
    '/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;',
    '/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;',
    '/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;',
    '/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;',
    '/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;',
    '/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;',
    '',
    '-- Fin de la exportación',
    ''
  ].join('\n')
}

/** `DELIMITER ;;` block with the object's own sql_mode (and time zone for events). */
export function bodyBlock(
  ddl: string,
  sqlMode: string | null,
  timeZone: string | null = null
): string {
  const lines: string[] = []
  if (sqlMode !== null) {
    lines.push('/*!50003 SET @saved_sql_mode = @@sql_mode */ ;')
    lines.push(`/*!50003 SET sql_mode = ${quoteString(sqlMode)} */ ;`)
  }
  if (timeZone !== null) {
    lines.push('/*!50106 SET @saved_time_zone = @@time_zone */ ;')
    lines.push(`/*!50106 SET time_zone = ${quoteString(timeZone)} */ ;`)
  }
  lines.push('DELIMITER ;;', `${ddl.trim()} ;;`, 'DELIMITER ;')
  if (timeZone !== null) lines.push('/*!50106 SET time_zone = @saved_time_zone */ ;')
  if (sqlMode !== null) lines.push('/*!50003 SET sql_mode = @saved_sql_mode */ ;')
  return lines.join('\n') + '\n\n'
}

const heading = (title: string): string => `--\n-- ${oneLine(title)}\n--\n\n`

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Drops `schema.` before the trigger name and its table in a trigger header.
 * MySQL 5.7 returns the statement as it was typed (`CREATE TRIGGER db.t …
 * ON db.tbl`), which would recreate the trigger in the source database.
 * The body (after FOR EACH ROW) is left as written.
 */
export function unqualifyTriggerDdl(ddl: string, schema: string): string {
  const m = /\bFOR\s+EACH\s+ROW\b/i.exec(ddl)
  if (!m) return ddl
  const q = `(?:\`${escapeRe(schema.replace(/`/g, '``'))}\`|${escapeRe(schema)})\\s*\\.\\s*`
  const head = ddl
    .slice(0, m.index)
    .replace(new RegExp(`(\\bTRIGGER\\s+)${q}`, 'i'), '$1')
    .replace(new RegExp(`(\\bON\\s+)${q}`, 'i'), '$1')
  return head + ddl.slice(m.index)
}

export async function exportSchemaToSql(
  deps: CreateDeps,
  options: SqlExportOptions,
  progress: ProgressReporter = () => {},
  signal?: AbortSignal
): Promise<SqlExportResult> {
  validate(options)
  const started = performance.now()
  const connection = deps.connections.get(options.connectionId)
  if (!connection) throw new Error('La conexión de la exportación ya no existe.')
  requireConnectionCapability(connection, 'supportsBackupsNb3', CAPABILITY_MESSAGES.backups)
  const schema = options.schema
  const gzip = options.gzip === true
  const now = (deps.now ?? (() => new Date()))()
  const cancelled = (): boolean => signal?.aborted === true
  if (cancelled()) throw new Error(EXPORT_CANCELLED)

  let target = options.targetPath?.trim() || ''
  if (!target) {
    const dir =
      options.targetDir?.trim() || (connection.backupDir ? join(connection.backupDir, schema) : '')
    if (!dir) throw new Error(noBackupFolderMessage(connection.name))
    target = await uniqueTarget(dir, now, options.label, gzip)
  }

  const session = await deps.sessions.acquire(options.connectionId, schema)
  let writer: DumpWriter | null = null
  let inTransaction = false
  try {
    // TIMESTAMPs are read as text in the session time zone: UTC here and in the dump.
    let utc = false
    try {
      await session.execute("SET SESSION time_zone = '+00:00'")
      utc = true
    } catch {
      utc = false
    }
    // Consistent view of every InnoDB table, like the .nb3 backups.
    try {
      await session.execute('START TRANSACTION WITH CONSISTENT SNAPSHOT')
      inTransaction = true
    } catch {
      inTransaction = false
    }

    const wanted = new Set((options.objects ?? []).filter(Boolean))
    const objects = (await listObjects(session, schema, options.includeData))
      .filter((o) => wanted.size === 0 || wanted.has(o.name))
      // Data only: nothing to write for views, routines and events (a sequence's value is data).
      .filter((o) => options.includeStructure || o.type === 'Table' || o.type === 'Sequence')
      .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type))
    if (wanted.size > 0 && objects.length === 0)
      throw new Error(`Ninguno de los objetos seleccionados existe en ${schema}.`)
    const triggers =
      options.includeStructure && objects.some((o) => o.type === 'Table')
        ? await listTriggers(session, schema)
        : new Map<string, TriggerRef[]>()

    // View definitions are read first so views can be ordered by dependency.
    const viewDdl = new Map<string, string>()
    for (const v of objects.filter((o) => o.type === 'View'))
      viewDdl.set(v.name, await showCreate(session, 'SHOW CREATE VIEW', v.name, 'Create View'))
    const views = orderViews(
      objects.filter((o) => o.type === 'View').map((o) => ({ ...o, ddl: viewDdl.get(o.name)! }))
    )
    const ordered: SchemaObject[] = [
      ...objects.filter((o) => o.type !== 'View' && o.type !== 'Event'),
      ...views,
      ...objects.filter((o) => o.type === 'Event')
    ]

    writer = await DumpWriter.open(`${target}.partial`, gzip)
    await writer.write(preamble(session.serverVersion, schema, now, utc))
    if (options.includeCreateDatabase) {
      const cs = await schemaCharset(session, schema)
      const charset = cs
        ? ` /*!40100 DEFAULT CHARACTER SET ${cs.charset}${cs.collation ? ` COLLATE ${cs.collation}` : ''} */`
        : ''
      await writer.write(
        heading(`Base de datos ${id(schema)}`) +
          `CREATE DATABASE /*!32312 IF NOT EXISTS*/ ${id(schema)}${charset};\n\nUSE ${id(schema)};\n\n`
      )
    }

    const versioned = ordered.filter((o) => o.versioned).map((o) => o.name)
    if (versioned.length && options.includeData)
      progress({
        phase: 'warning',
        current: 0,
        total: ordered.length,
        message: `La copia .sql incluye el historial de ${versioned.join(', ')} (tablas versionadas de MariaDB): para importarlo hace falta MariaDB 10.11 o posterior.`,
        done: false
      })
    const total = ordered.length
    const weights = ordered.map((o) =>
      objectWeight(o.rowsEstimate, options.includeData && o.type === 'Table')
    )
    const workTotal = weights.reduce((sum, w) => sum + w, 0)
    let workDone = 0
    let rowsTotal = 0
    progress({
      phase: 'list',
      current: 0,
      total,
      message: `${total} ${total === 1 ? 'objeto' : 'objetos'} para exportar`,
      done: false,
      detail: { objects: total, objectsDone: 0, workDone: 0, workTotal }
    })

    for (let i = 0; i < ordered.length; i++) {
      if (cancelled()) throw new Error(EXPORT_CANCELLED)
      const obj = ordered[i]
      const label = `${KIND_LABEL[obj.type]} ${obj.name}`
      const rowsEstimate = obj.type === 'Table' && options.includeData ? obj.rowsEstimate : null
      const objectDetail = {
        objectType: obj.type,
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
        message: `Exportando ${label}…`,
        done: false,
        detail: {
          ...objectDetail,
          objectsDone: i,
          rows: obj.type === 'Table' ? 0 : null,
          workDone
        }
      })
      let rows: number | null = null
      try {
        if (obj.type === 'Table') {
          const written = await exportTable(
            session,
            writer,
            schema,
            obj.name,
            triggers.get(obj.name) ?? [],
            options,
            !!obj.versioned,
            {
              cancelled,
              onRows: (count) =>
                progress({
                  phase: 'rows',
                  current: i,
                  total,
                  message: `Exportando ${label}: ${count} filas`,
                  done: false,
                  detail: {
                    ...objectDetail,
                    objectsDone: i,
                    rows: count,
                    workDone: workDone + partialWork(weights[i], count, rowsEstimate)
                  }
                })
            }
          )
          rowsTotal += written
          rows = options.includeData ? written : null
        } else if (obj.type === 'Sequence') {
          await writer.write(await sequenceBlock(session, obj.name, options))
        } else {
          const spec = SHOW_CREATE[obj.type]
          const ddl =
            obj.type === 'View'
              ? viewDdl.get(obj.name)!
              : await showCreate(session, spec.stmt, obj.name, spec.column)
          let block = heading(`${KIND_TITLE[obj.type]} ${id(obj.name)}`)
          block += `DROP ${DROP_KEYWORD[obj.type]} IF EXISTS ${id(obj.name)};\n`
          block +=
            obj.type === 'View'
              ? `${ddl.trim()};\n\n`
              : bodyBlock(ddl, obj.sqlMode, obj.type === 'Event' ? obj.timeZone : null)
          await writer.write(block)
        }
      } catch (err) {
        if (cancelled()) throw new Error(EXPORT_CANCELLED)
        const message = describeError(err)
        progress({
          phase: 'objectError',
          current: i,
          total,
          message: `Error al exportar ${label}`,
          done: false,
          detail: { ...objectDetail, objectsDone: i, error: message, workDone }
        })
        throw new Error(`Error al exportar ${label}: ${message}`)
      }
      workDone += weights[i]
      progress({
        phase: 'objectDone',
        current: i + 1,
        total,
        message: `${label} exportada`,
        done: false,
        detail: { ...objectDetail, objectsDone: i + 1, rows, workDone }
      })
    }
    if (cancelled()) throw new Error(EXPORT_CANCELLED)
    progress({ phase: 'finish', current: total, total, message: 'Cerrando archivo', done: false })
    await writer.write(footer(utc))
    await writer.close()
    await rename(writer.partialPath, target)
    writer = null
    const size = (await stat(target)).size
    return {
      path: target,
      sizeBytes: size,
      objects: total,
      rows: rowsTotal,
      durationMs: Math.round(performance.now() - started)
    }
  } catch (err) {
    await writer?.abort()
    if (cancelled()) throw new Error(EXPORT_CANCELLED)
    throw err
  } finally {
    if (inTransaction) await session.execute('COMMIT').catch(() => undefined)
    await session.release().catch(() => undefined)
  }
}

/**
 * MariaDB sequence: DROP + SHOW CREATE SEQUENCE, then (with data) SETVAL to the
 * value the next NEXTVAL would hand out after a restart (next_not_cached_value).
 */
async function sequenceBlock(
  session: MysqlSession,
  name: string,
  options: SqlExportOptions
): Promise<string> {
  let block = heading(`Secuencia ${id(name)}`)
  if (options.includeStructure) {
    const ddl = await showCreate(session, 'SHOW CREATE SEQUENCE', name, 'Create Table')
    block += `DROP SEQUENCE IF EXISTS ${id(name)};\n${ddl.trim()};\n`
  }
  if (options.includeData) {
    const rows = await session.query<{ v: unknown; c: unknown }>(
      `SELECT next_not_cached_value AS v, cycle_count AS c FROM ${session.escapeId(name)}`
    )
    const value = text(rows[0]?.v)
    if (/^-?\d+$/.test(value))
      block += `${setSequenceValueSql(id(name), { lastValue: value, isCalled: false, round: text(rows[0]?.c) })};\n`
  }
  return `${block}\n`
}

async function exportTable(
  session: MysqlSession,
  writer: DumpWriter,
  schema: string,
  table: string,
  triggers: TriggerRef[],
  options: SqlExportOptions,
  versioned: boolean,
  hooks: { cancelled: () => boolean; onRows: (rows: number) => void }
): Promise<number> {
  // MySQL data-only exports never read the DDL (only versioned MariaDB tables need it).
  const ddl =
    options.includeStructure || versioned
      ? await showCreate(session, 'SHOW CREATE TABLE', table, 'Create Table')
      : ''
  if (options.includeStructure) {
    await writer.write(
      heading(`Estructura de la tabla ${id(table)}`) +
        `DROP TABLE IF EXISTS ${id(table)};\n${ddl.trim()};\n\n`
    )
  }
  let count = 0
  if (options.includeData) {
    const columns = (await tableColumns(session, schema, table)).filter(
      (c) => !GENERATED_RE.test(c.extra)
    )
    // MariaDB system-versioned table: every row version with its period columns,
    // inserted with system_versioning_insert_history (MariaDB 10.11+, like
    // mariadb-dump --dump-history). Older MariaDB skips the `/*!101100` SET but then refuses
    // the INSERTs naming the period columns, so the export warns. Transaction-precise
    // versioning: current rows only.
    const period = versioned && !isTrxIdVersionedDdl(ddl) ? systemVersioningColumns(ddl) : null
    if (period && columns.length > 0)
      columns.push(
        { name: period.start, columnType: 'timestamp(6)', extra: '' },
        { name: period.end, columnType: 'timestamp(6)', extra: '' }
      )
    // Current rows are written without their end column: the importing server gives them its
    // own end value (2106 on MariaDB 11.5+, 2038 before), so they stay current on either.
    let currentEnd: string | null = null
    if (period && columns.length > 0) {
      const rows = await session.query<{ e: unknown }>(
        `SELECT ${session.escapeId(period.end)} AS e FROM ${session.escapeId(table)} LIMIT 1`
      )
      currentEnd = rows.length ? text(rows[0].e) || null : null
    }
    if (columns.length > 0) {
      const kinds: LiteralKind[] = columns.map((c) => literalKindOf(c.columnType))
      const prefix = `INSERT INTO ${id(table)} (${columns.map((c) => id(c.name)).join(', ')}) VALUES\n`
      const currentPrefix = `INSERT INTO ${id(table)} (${columns
        .slice(0, -1)
        .map((c) => id(c.name))
        .join(', ')}) VALUES\n`
      const select = `SELECT ${columns.map((c) => session.escapeId(c.name)).join(', ')} FROM ${session.escapeId(table)}${period ? ' FOR SYSTEM_TIME ALL' : ''}`
      await writer.write(
        heading(`Datos de la tabla ${id(table)}`) +
          (period
            ? '-- Historial de la tabla versionada: importarlo requiere MariaDB 10.11 o posterior.\n' +
              '/*!101100 SET @OLD_INSERT_HISTORY=@@SESSION.system_versioning_insert_history, @@SESSION.system_versioning_insert_history=1 */;\n'
            : '') +
          `/*!40000 ALTER TABLE ${id(table)} DISABLE KEYS */;\n`
      )
      // Two batches: history rows (every column) and current rows (no end column).
      const batches = [
        { prefix, rows: [] as string[], bytes: 0 },
        { prefix: currentPrefix, rows: [] as string[], bytes: 0 }
      ]
      const flush = async (batch: (typeof batches)[number]): Promise<void> => {
        if (!batch.rows.length) return
        const sql = `${batch.prefix}${batch.rows.join(',\n')};\n`
        batch.rows = []
        batch.bytes = 0
        await writer.write(sql)
      }
      const { rows } = await session.streamRows(select)
      try {
        for await (const row of rows as AsyncIterable<unknown[]>) {
          if (hooks.cancelled()) break
          const current = currentEnd !== null && text(row[row.length - 1]) === currentEnd
          const tuple = current
            ? renderTuple(row.slice(0, -1), kinds.slice(0, -1))
            : renderTuple(row, kinds)
          const batch = batches[current ? 1 : 0]
          const size = Buffer.byteLength(tuple, 'utf8') + 2
          if (
            batch.rows.length &&
            (batch.rows.length >= INSERT_MAX_ROWS || batch.bytes + size > INSERT_MAX_BYTES)
          )
            await flush(batch)
          batch.rows.push(tuple)
          batch.bytes += size
          count++
          if (count % ROW_PROGRESS_EVERY === 0) hooks.onRows(count)
        }
      } finally {
        if (!rows.destroyed) rows.destroy()
      }
      if (hooks.cancelled()) throw new Error(EXPORT_CANCELLED)
      for (const batch of batches) await flush(batch)
      await writer.write(
        `/*!40000 ALTER TABLE ${id(table)} ENABLE KEYS */;\n` +
          (period
            ? '/*!101100 SET @@SESSION.system_versioning_insert_history=@OLD_INSERT_HISTORY */;\n'
            : '') +
          '\n'
      )
    }
  }
  if (options.includeStructure) {
    for (const trigger of triggers) {
      const ddl = await showCreate(
        session,
        'SHOW CREATE TRIGGER',
        trigger.name,
        'SQL Original Statement'
      )
      await writer.write(
        heading(`Disparador ${id(trigger.name)}`) +
          bodyBlock(unqualifyTriggerDdl(ddl, schema), trigger.sqlMode)
      )
    }
  }
  return count
}
