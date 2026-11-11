/**
 * MongoDB backup of one database to .vqb (docs/vqb-format.md, "MongoDB").
 *
 * Archive order (also the restore order): collections with their documents,
 * then views. A collection's `ddl.sql` holds the canonical Extended JSON of
 * its `create` command (options: capped, validator, time-series,
 * collation…), its meta.json the canonical Extended JSON of every index but
 * `_id_`, and its data files one column `document` whose values are `$json`
 * holding each document as canonical Extended JSON (`relaxed: false`), so an
 * Int64, a Decimal128 or an Int32/Double distinction comes back unchanged.
 * A view's `ddl.sql` holds `{create, viewOn, pipeline}`.
 *
 * MongoDB has no snapshot across collections outside a transaction: each
 * collection is read as it is when its turn comes (documented limit).
 */
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Document } from 'mongodb'
import { describeObjectCounts } from '@shared/jobLog'
import type { BackupCreateOptions, BackupCreateResult, ConnectionConfig } from '@shared/types'
import { APP_VERSION } from '../../appVersion'
import { APP_NAME } from '../../brand'
import { isHiddenCollection } from '../../mongo/admin'
import type { MongoDriverConnection } from '../../mongo/connection'
import { describeError, toServerError } from '../../mongo/errors'
import { canonical } from '../../mongo/values'
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
import { VQB_EXTENSION } from './format'
import { VqbWriter } from './writer'

export interface MongoConnectionProvider {
  connection(connectionId: string): Promise<MongoDriverConnection>
}

export interface MongoBackupDeps {
  connections: { get(id: string): ConnectionConfig | null }
  mongo: MongoConnectionProvider
  now?: () => Date
  chunkLimit?: number
  scrypt?: ScryptParams
}

export const MONGO_ONLY_VQB_MESSAGE = 'Las copias de MongoDB se hacen en formato .vqb.'
/** The single data column of a collection. */
export const MONGO_DOCUMENT_COLUMN = { name: 'document', type: 'bson' }

const ROW_PROGRESS_EVERY = 5000

export interface ListedMongoCollection {
  name: string
  type: string
  options: Document
}

/** Collections and views of a database, user ones only, collections first. */
export async function listMongoObjects(
  conn: MongoDriverConnection,
  database: string
): Promise<{ collections: ListedMongoCollection[]; views: ListedMongoCollection[] }> {
  const all = (
    await conn.rawDb(database).listCollections({}, { authorizedCollections: true }).toArray()
  )
    .map((c) => ({
      name: String(c.name),
      type: String(c.type ?? 'collection'),
      options: ((c as { options?: Document }).options ?? {}) as Document
    }))
    .filter((c) => !isHiddenCollection(c.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  return {
    collections: all.filter((c) => c.type !== 'view'),
    views: all.filter((c) => c.type === 'view')
  }
}

/** The `create` command that recreates a collection or view (options as listed). */
export function createCommandOf(c: ListedMongoCollection): Document {
  const { uuid: _uuid, ...options } = c.options
  void _uuid
  return { create: c.name, ...options }
}

export async function createMongoBackup(
  deps: MongoBackupDeps,
  options: BackupCreateOptions,
  progress: ProgressReporter = () => {},
  signal?: AbortSignal
): Promise<BackupCreateResult> {
  if (!options?.connectionId) throw new Error('Selecciona una conexión para el backup.')
  const database = options.schema?.trim()
  if (!database) throw new Error('Selecciona la base de datos de la copia.')
  if (options.format && options.format !== 'vqb') throw new Error(MONGO_ONLY_VQB_MESSAGE)
  const password = checkBackupPassword(options.password)
  const config = deps.connections.get(options.connectionId)
  if (!config) throw new Error('La conexión de la copia ya no existe.')
  const targetDir =
    options.targetDir?.trim() || (config.backupDir ? join(config.backupDir, database) : '')
  if (!targetDir) throw new Error(noBackupFolderMessage(config.name))
  const started = performance.now()
  const cancelled = (): boolean => signal?.aborted === true
  if (cancelled()) throw new Error(BACKUP_CANCELLED)

  const conn = await deps.mongo.connection(options.connectionId)
  let writer: VqbWriter | null = null
  try {
    const listed = await listMongoObjects(conn, database)
    const wanted = (options.objects ?? []).filter(Boolean)
    const pick = (c: ListedMongoCollection): boolean => !wanted.length || wanted.includes(c.name)
    const collections = listed.collections.filter(pick)
    const views = listed.views.filter(pick)
    const estimates = new Map<string, number>()
    if (options.includeData)
      for (const c of collections)
        estimates.set(
          c.name,
          await conn
            .coll(database, c.name)
            .estimatedDocumentCount()
            .catch(() => 0)
        )

    const date = (deps.now ?? (() => new Date()))()
    const target = await uniqueTarget(targetDir, date, options.label, VQB_EXTENSION)
    writer = await VqbWriter.create(target, {
      manifest: {
        app: { name: APP_NAME, version: APP_VERSION },
        engine: { id: 'mongodb', flavor: 'mongodb', serverVersion: conn.serverVersion },
        source: {
          ...(options.omitConnectionName ? {} : { connectionName: config.name }),
          database
        },
        comment: options.comment,
        options: {
          includeData: options.includeData,
          structureOnly: !options.includeData,
          partial: wanted.length > 0
        }
      },
      password,
      scrypt: deps.scrypt,
      chunkBytes: deps.chunkLimit,
      now: () => date
    })

    const plan = [...collections, ...views]
    const total = plan.length
    const weights = plan.map((c) =>
      objectWeight(c.type !== 'view' ? (estimates.get(c.name) ?? null) : null, options.includeData)
    )
    const workTotal = weights.reduce((sum, w) => sum + w, 0)
    let workDone = 0
    progress({
      phase: 'list',
      current: 0,
      total,
      message: describeObjectCounts(plan.map((c) => (c.type === 'view' ? 'View' : 'Collection'))),
      done: false,
      detail: { objects: total, objectsDone: 0, workDone: 0, workTotal }
    })
    for (let i = 0; i < plan.length; i++) {
      if (cancelled()) throw new Error(BACKUP_CANCELLED)
      const c = plan[i]
      const isView = c.type === 'view'
      const label = `${isView ? 'vista' : 'colección'} ${c.name}`
      const rowsEstimate = !isView && options.includeData ? (estimates.get(c.name) ?? null) : null
      const objectDetail = {
        objectType: isView ? 'View' : 'Collection',
        objectName: c.name,
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
        detail: { ...objectDetail, objectsDone: i, rows: isView ? null : 0, workDone }
      })
      let rows: number | null = null
      try {
        const object = writer.beginObject(isView ? 'view' : 'collection', c.name)
        const ddl = canonical(createCommandOf(c))
        if (isView) {
          await object.finish({ ddl, meta: {} })
        } else {
          object.setColumns([MONGO_DOCUMENT_COLUMN], ['raw'])
          if (options.includeData) {
            const cursor = conn.rawColl(database, c.name).find({}, { batchSize: 1000 })
            try {
              for await (const doc of cursor) {
                if (cancelled()) throw new Error(BACKUP_CANCELLED)
                await object.addRow([{ $json: canonical(doc) }])
                if (object.rowCount % ROW_PROGRESS_EVERY === 0)
                  progress({
                    phase: 'rows',
                    current: i,
                    total,
                    message: `Respaldando ${label}: ${object.rowCount} documentos`,
                    done: false,
                    detail: {
                      ...objectDetail,
                      objectsDone: i,
                      rows: object.rowCount,
                      workDone: workDone + partialWork(weights[i], object.rowCount, rowsEstimate)
                    }
                  })
              }
            } finally {
              await cursor.close().catch(() => undefined)
            }
          }
          const indexes = await conn
            .rawColl(database, c.name)
            .listIndexes()
            .toArray()
            .catch(() => [] as Document[])
          const result = await object.finish({
            ddl,
            meta: {
              indexes: indexes
                .filter((ix) => ix.name !== '_id_')
                .map((ix) => {
                  const { v: _v, ns: _ns, ...spec } = ix
                  void _v
                  void _ns
                  return canonical(spec)
                })
            }
          })
          rows = result.rows
        }
      } catch (err) {
        if (cancelled()) throw new Error(BACKUP_CANCELLED)
        const message = describeError(toServerError(err))
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
  }
}
