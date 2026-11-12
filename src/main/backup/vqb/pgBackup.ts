import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import Cursor from 'pg-cursor'
import { describeObjectCounts } from '@shared/jobLog'
import type { BackupCreateOptions, BackupCreateResult, ConnectionConfig } from '@shared/types'
import { APP_VERSION } from '../../appVersion'
import { APP_NAME } from '../../brand'
import { describeError } from '../../postgres/errors'
import type { PgSession } from '../../postgres/session'
import { pgTypes } from '../../postgres/values'
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
import { VQB_EXTENSION, type VqbObjectType } from './format'
import {
  extensionDdl,
  listExtensions,
  listRoutines,
  listSchemas,
  listSequences,
  listTables,
  listTypes,
  listViews,
  qi,
  qn,
  relationIndexes,
  routineDdl,
  sequenceDdl,
  sequenceState,
  tableDefinition,
  typeDdl,
  viewComment
} from './pgCatalog'
import { VqbWriter } from './writer'

/**
 * PostgreSQL backup of one database to .vqb (docs/vqb-format.md,
 * "PostgreSQL"). Every non-system schema is included. One REPEATABLE READ
 * READ ONLY transaction gives a consistent snapshot of the catalog and the
 * rows; rows are streamed through pg-cursor. Order in the archive, which is
 * also the restore order: extensions, types, sequences, tables (with data),
 * functions and procedures, views and materialized views.
 */

/** A pooled session of a PostgreSQL connection on one database. */
export interface PgSessionProvider {
  acquire(connectionId: string, database: string | null): Promise<PgSession>
}

export interface PgBackupDeps {
  connections: { get(id: string): ConnectionConfig | null }
  pg: PgSessionProvider
  now?: () => Date
  chunkLimit?: number
  scrypt?: ScryptParams
}

export const PG_ONLY_VQB_MESSAGE = 'Las copias de PostgreSQL solo se pueden hacer en formato .vqb.'
export const PG_WHOLE_DATABASE_MESSAGE =
  'Las copias de PostgreSQL incluyen siempre la base de datos completa: no se pueden elegir objetos sueltos.'

const ROW_BATCH = 1000
const ROW_PROGRESS_EVERY = 5000

const KIND_LABEL: Record<string, string> = {
  extension: 'extensión',
  type: 'tipo',
  sequence: 'secuencia',
  table: 'tabla',
  function: 'función',
  procedure: 'procedimiento',
  view: 'vista',
  materialized_view: 'vista materializada'
}

/** Progress type names (same as the .nb3 ones where they exist). */
const PROGRESS_TYPE: Record<string, string> = {
  extension: 'Extension',
  type: 'Type',
  sequence: 'Sequence',
  table: 'Table',
  function: 'Function',
  procedure: 'Procedure',
  view: 'View',
  materialized_view: 'MaterializedView'
}

interface Planned {
  type: VqbObjectType
  schema: string
  name: string
  estimate: number | null
  write: (writer: VqbWriter, onRows: (rows: number) => void) => Promise<number | null>
}

function readBatch(cursor: Cursor<unknown[]>, count: number): Promise<unknown[][]> {
  return new Promise((resolve, reject) =>
    cursor.read(count, (err, rows) => (err ? reject(err) : resolve(rows)))
  )
}

function closeCursor(cursor: Cursor<unknown[]>): Promise<void> {
  return new Promise((resolve) => cursor.close(() => resolve()))
}

export async function createPgBackup(
  deps: PgBackupDeps,
  options: BackupCreateOptions,
  progress: ProgressReporter = () => {},
  signal?: AbortSignal
): Promise<BackupCreateResult> {
  if (!options?.connectionId) throw new Error('Selecciona una conexión para el backup.')
  const database = options.schema?.trim()
  if (!database) throw new Error('Selecciona la base de datos a respaldar.')
  if (options.format && options.format !== 'vqb') throw new Error(PG_ONLY_VQB_MESSAGE)
  if ((options.objects ?? []).filter(Boolean).length > 0) throw new Error(PG_WHOLE_DATABASE_MESSAGE)
  const password = checkBackupPassword(options.password)
  const connection = deps.connections.get(options.connectionId)
  if (!connection) throw new Error('La conexión de la copia ya no existe.')
  const targetDir =
    options.targetDir?.trim() || (connection.backupDir ? join(connection.backupDir, database) : '')
  if (!targetDir) throw new Error(noBackupFolderMessage(connection.name))
  const started = performance.now()
  const cancelled = (): boolean => signal?.aborted === true
  if (cancelled()) throw new Error(BACKUP_CANCELLED)

  const session = await deps.pg.acquire(options.connectionId, database)
  let writer: VqbWriter | null = null
  let inTransaction = false
  try {
    await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    inTransaction = true
    // Every name the server prints comes out schema-qualified (pg_dump does the same).
    await session.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)")
    const [info] = await session.query<{ num: string; version: string; encoding: string }>(
      "SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS version, current_setting('server_encoding') AS encoding"
    )
    const versionNum = Number(info?.num ?? 0)
    const schemas = await listSchemas(session)
    const plan = await planObjects(session, schemas, versionNum, options.includeData, cancelled)

    const date = (deps.now ?? (() => new Date()))()
    const target = await uniqueTarget(targetDir, date, options.label, VQB_EXTENSION)
    writer = await VqbWriter.create(target, {
      manifest: {
        app: { name: APP_NAME, version: APP_VERSION },
        engine: { id: 'postgresql', flavor: 'postgresql', serverVersion: info?.version ?? '' },
        source: {
          ...(options.omitConnectionName ? {} : { connectionName: connection.name }),
          database,
          schemas,
          encoding: info?.encoding ?? null
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
    for (const w of plan.warnings) {
      writer.warn(w)
      progress({
        phase: 'warning',
        current: 0,
        total: plan.objects.length,
        message: w,
        done: false
      })
    }

    const objects = plan.objects
    const total = objects.length
    const weights = objects.map((o) => objectWeight(o.estimate, options.includeData))
    const workTotal = weights.reduce((sum, w) => sum + w, 0)
    let workDone = 0
    progress({
      phase: 'list',
      current: 0,
      total,
      message: describeObjectCounts(objects.map((o) => PROGRESS_TYPE[o.type] ?? o.type)),
      done: false,
      detail: { objects: total, objectsDone: 0, workDone: 0, workTotal }
    })
    for (let i = 0; i < objects.length; i++) {
      if (cancelled()) throw new Error(BACKUP_CANCELLED)
      const obj = objects[i]
      const name = `${obj.schema}.${obj.name}`
      const label = `${KIND_LABEL[obj.type] ?? obj.type} ${name}`
      const isTable = obj.type === 'table'
      const rowsEstimate = isTable && options.includeData ? obj.estimate : null
      const objectDetail = {
        objectType: PROGRESS_TYPE[obj.type] ?? obj.type,
        objectName: name,
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
      let rows: number | null
      try {
        rows = await obj.write(writer, (count) =>
          progress({
            phase: 'rows',
            current: i,
            total,
            message: `Respaldando ${label}: ${count} filas`,
            done: false,
            detail: {
              ...objectDetail,
              objectsDone: i,
              rows: count,
              workDone: workDone + partialWork(weights[i], count, rowsEstimate)
            }
          })
        )
        if (cancelled()) throw new Error(BACKUP_CANCELLED)
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
    if (inTransaction) await session.query('ROLLBACK').catch(() => undefined)
    await session.release().catch(() => undefined)
  }
}

async function planObjects(
  session: PgSession,
  schemas: string[],
  versionNum: number,
  includeData: boolean,
  /** Checked between batches of rows: a large table stops within one batch. */
  cancelled: () => boolean
): Promise<{ objects: Planned[]; warnings: string[] }> {
  const objects: Planned[] = []
  const warnings: string[] = []
  const simple = (
    type: VqbObjectType,
    schema: string,
    name: string,
    ddl: () => Promise<string>,
    meta?: () => Promise<object>
  ): Planned => ({
    type,
    schema,
    name,
    estimate: null,
    write: async (writer) => {
      const object = writer.beginObject(type, name, schema)
      await object.finish({ ddl: await ddl(), meta: meta ? await meta() : undefined })
      return null
    }
  })

  for (const ext of await listExtensions(session))
    objects.push(simple('extension', ext.schema, ext.name, async () => extensionDdl(ext)))
  for (const t of await listTypes(session, schemas))
    objects.push(simple('type', t.schema, t.name, () => typeDdl(session, t)))
  for (const seq of await listSequences(session, schemas))
    objects.push(
      simple(
        'sequence',
        seq.schema,
        seq.name,
        () => sequenceDdl(session, seq),
        async () => ({
          sequences: [
            {
              schema: seq.schema,
              name: seq.name,
              ...(await sequenceState(session, seq.schema, seq.name)),
              ownedBy: seq.ownedBy
                ? { table: seq.ownedBy.table, column: seq.ownedBy.column }
                : null,
              kind: seq.ownedBy ? 'serial' : 'standalone'
            }
          ],
          // OWNED BY needs the table: restored after the data.
          postDdl: seq.ownedBy
            ? [
                `ALTER SEQUENCE ${qn(seq.schema, seq.name)} OWNED BY ${qn(seq.ownedBy.schema, seq.ownedBy.table)}.${qi(seq.ownedBy.column)}`
              ]
            : []
        })
      )
    )
  for (const t of await listTables(session, schemas)) {
    objects.push({
      type: 'table',
      schema: t.schema,
      name: t.name,
      estimate: t.estimate,
      write: async (writer, onRows) => {
        const def = await tableDefinition(session, t, versionNum)
        const object = writer.beginObject('table', t.name, t.schema)
        object.setColumns(def.columns, def.codecs)
        // A partitioned parent holds no rows itself; its partitions are backed up one by one.
        if (includeData && def.columns.length > 0 && t.relkind !== 'p') {
          const cursor = session.client.query(
            new Cursor<unknown[]>(`SELECT ${def.select} FROM ONLY ${qn(t.schema, t.name)}`, [], {
              rowMode: 'array',
              types: pgTypes
            })
          )
          try {
            let next = ROW_PROGRESS_EVERY
            for (;;) {
              if (cancelled()) throw new Error(BACKUP_CANCELLED)
              const batch = await readBatch(cursor, ROW_BATCH)
              if (batch.length === 0) break
              for (const row of batch) await object.addRow(row)
              if (object.rowCount >= next) {
                onRows(object.rowCount)
                next = object.rowCount + ROW_PROGRESS_EVERY
              }
            }
          } finally {
            await closeCursor(cursor)
          }
        }
        const { rows } = await object.finish({
          ddl: def.ddl,
          meta: {
            primaryKey: def.primaryKey,
            comments: def.comments,
            indexes: def.indexes,
            foreignKeys: def.foreignKeys,
            triggers: def.triggers,
            postDdl: def.postDdl,
            sequences: def.identities
          }
        })
        return rows
      }
    })
  }
  const { routines, skipped } = await listRoutines(session, schemas)
  if (skipped > 0)
    warnings.push(
      `La copia no incluye ${skipped} ${skipped === 1 ? 'función agregada o de ventana' : 'funciones agregadas o de ventana'} (CREATE AGGREGATE).`
    )
  for (const r of routines)
    objects.push(
      simple(
        r.kind,
        r.schema,
        r.name,
        () => routineDdl(session, r.oid),
        async () => ({
          signature: r.signature
        })
      )
    )
  for (const v of await listViews(session, schemas))
    objects.push(
      simple(
        v.materialized ? 'materialized_view' : 'view',
        v.schema,
        v.name,
        async () => v.ddl,
        async () => ({
          comments: viewComment(v),
          indexes: v.materialized ? await relationIndexes(session, v.oid, false) : []
        })
      )
    )
  const foreign = await session.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'f' AND n.nspname = ANY($1::text[])`,
    [schemas]
  )
  const foreignCount = Number(foreign[0]?.n ?? 0)
  if (foreignCount > 0)
    warnings.push(
      `La copia no incluye ${foreignCount} ${foreignCount === 1 ? 'tabla externa' : 'tablas externas'} (FOREIGN TABLE).`
    )
  return { objects, warnings }
}
