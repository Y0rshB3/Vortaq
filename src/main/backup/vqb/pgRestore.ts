import { performance } from 'node:perf_hooks'
import type { ConnectionConfig, RestoreOptions, RestoreResult } from '@shared/types'
import { featuresOf } from '../../postgres/catalogCompat'
import { describeError } from '../../postgres/errors'
import type { PgSession } from '../../postgres/session'
import type { ProgressReporter } from '../index'
import { PRODUCTION_GUARD_MESSAGE, RESTORE_CANCELLED } from '../restore'
import { engineMismatchMessage } from './engine'
import type { VqbManifestObject, VqbObjectMeta, VqbObjectType } from './format'
import { listSchemas, qi, qn } from './pgCatalog'
import type { PgSessionProvider } from './pgBackup'
import { VqbReader } from './reader'
import { pgParam, type VqbValue } from './values'

/**
 * Restores a PostgreSQL .vqb into a database of a PostgreSQL connection
 * (same engine only). The whole restore is ONE transaction (PostgreSQL DDL
 * is transactional): when an object fails and «Continuar en caso de error»
 * is off, everything is rolled back and the database is exactly as before.
 * With it on, each object runs under a savepoint and the failures are
 * reported. Order: schemas, extensions, types (retried while they make
 * progress), sequences, tables and their rows, functions and procedures,
 * views (retried), then indexes, foreign keys, triggers and sequence values.
 * Ownership and privileges are not restored: objects belong to the user
 * that restores.
 */

export interface PgRestoreDeps {
  connections: { get(id: string): ConnectionConfig | null }
  pg: PgSessionProvider
  /** Writes to this connection need the typed confirmation (sessions start read-only). */
  guarded?: (connectionId: string) => boolean
}

export interface PgRestoreOptions extends RestoreOptions {
  /** REPLACE: drop every user schema of the target database first (same transaction). */
  replaceAll?: boolean
}

/** A failure that rolled the whole restore back. */
export class PgRestoreRolledBackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PgRestoreRolledBackError'
  }
}

const INSERT_MAX_PARAMS = 30000
const INSERT_MAX_ROWS = 500
const INSERT_MAX_BYTES = 4 * 1024 * 1024
const SYSTEM_DATABASES = new Set(['template0', 'template1'])

interface Item {
  object: VqbManifestObject
  meta: VqbObjectMeta
  ddl: string
  label: string
}

const labelOf = (o: { schema?: string; name: string }): string =>
  o.schema ? `${o.schema}.${o.name}` : o.name

const DROP: Partial<Record<VqbObjectType, string>> = {
  table: 'TABLE',
  view: 'VIEW',
  materialized_view: 'MATERIALIZED VIEW',
  sequence: 'SEQUENCE'
}

function dropStatement(item: Item): string | null {
  const target = qn(item.object.schema ?? 'public', item.object.name)
  const type = item.object.type
  if (type === 'function' || type === 'procedure') {
    const signature = (item.meta as { signature?: string }).signature ?? ''
    return `DROP ${type === 'procedure' ? 'PROCEDURE' : 'FUNCTION'} IF EXISTS ${target}(${signature}) CASCADE`
  }
  if (type === 'type')
    return `DROP ${/^\s*CREATE\s+DOMAIN/i.test(item.ddl) ? 'DOMAIN' : 'TYPE'} IF EXISTS ${target} CASCADE`
  const keyword = DROP[type]
  return keyword ? `DROP ${keyword} IF EXISTS ${target} CASCADE` : null
}

function validate(options: RestoreOptions): void {
  if (!options || typeof options !== 'object')
    throw new Error('Opciones de restauración no válidas.')
  if (!options.backupPath) throw new Error('Selecciona el archivo de la copia a restaurar.')
  if (!options.connectionId) throw new Error('Selecciona la conexión de destino.')
  if (!options.targetSchema?.trim()) throw new Error('Indica la base de datos de destino.')
  if (!options.includeStructure && !options.includeData)
    throw new Error('Elige restaurar la estructura, los datos o ambos.')
  if (SYSTEM_DATABASES.has(options.targetSchema.trim()))
    throw new Error(
      `«${options.targetSchema.trim()}» es una plantilla del servidor y nunca se restaura sobre ella. Elige otra base de datos de destino.`
    )
}

/** CREATE SCHEMA IF NOT EXISTS, which servers before 9.3 do not have. */
async function createSchemaIfMissing(session: PgSession, schema: string): Promise<void> {
  if (featuresOf(session).createSchemaIfNotExists) {
    await session.query(`CREATE SCHEMA IF NOT EXISTS ${qi(schema)}`)
    return
  }
  const found = await session.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1', [
    schema
  ])
  if (!found.length) await session.query(`CREATE SCHEMA ${qi(schema)}`)
}

export async function databaseExists(session: PgSession, name: string): Promise<boolean> {
  const rows = await session.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [
    name
  ])
  return rows.length > 0
}

/** CREATE DATABASE from a session on the connection's initial database. */
export async function createDatabase(
  deps: PgRestoreDeps,
  connectionId: string,
  name: string
): Promise<boolean> {
  const session = await deps.pg.acquire(connectionId, null)
  try {
    if (await databaseExists(session, name)) return false
    if (deps.guarded?.(connectionId)) {
      session.usage.userSql = true
      await session.query('SET SESSION default_transaction_read_only = off')
    }
    await session.query(`CREATE DATABASE ${qi(name)}`)
    return true
  } finally {
    await session.release().catch(() => undefined)
  }
}

export async function restorePgBackup(
  deps: PgRestoreDeps,
  options: PgRestoreOptions,
  progress: ProgressReporter = () => {},
  signal?: AbortSignal
): Promise<RestoreResult> {
  validate(options)
  const connection = deps.connections.get(options.connectionId)
  if (!connection) throw new Error('La conexión de destino ya no existe.')
  if (connection.environment === 'production' && options.confirmProduction !== true)
    throw new Error(PRODUCTION_GUARD_MESSAGE)
  const started = performance.now()
  const cancelled = (): boolean => signal?.aborted === true
  if (cancelled()) throw new Error(RESTORE_CANCELLED)
  const database = options.targetSchema.trim()

  // The password, the engine and every selected object's metadata before touching the server.
  const reader = await VqbReader.open(options.backupPath, options.password)
  try {
    await reader.unlock(options.password)
    const manifest = await reader.manifest()
    if (manifest.engine.id !== 'postgresql')
      throw new Error(engineMismatchMessage(manifest.engine.id, 'postgresql'))
    const wanted = new Set((options.objects ?? []).filter(Boolean))
    const selected = manifest.objects.filter(
      (o) => wanted.size === 0 || wanted.has(labelOf(o)) || wanted.has(o.name)
    )
    if (wanted.size > 0 && selected.length === 0)
      throw new Error('Ninguno de los objetos seleccionados está en la copia.')
    const items: Item[] = []
    for (const object of selected) {
      const meta = await reader.objectMeta(object.id)
      items.push({ object, meta, ddl: await reader.ddl(meta), label: labelOf(object) })
    }

    if (options.createSchema) await createDatabase(deps, options.connectionId, database)
    const session = await deps.pg.acquire(options.connectionId, database)
    // Session settings change below: the pool resets the client (DISCARD ALL) on release.
    session.usage.userSql = true
    try {
      if (deps.guarded?.(options.connectionId))
        await session.query('SET SESSION default_transaction_read_only = off')
      return await runRestore(
        session,
        reader,
        items,
        manifest.source.schemas ?? [],
        options,
        progress,
        signal,
        started
      )
    } finally {
      await session.release().catch(() => undefined)
    }
  } finally {
    await reader.close()
  }
}

async function runRestore(
  session: PgSession,
  reader: VqbReader,
  items: Item[],
  schemas: string[],
  options: PgRestoreOptions,
  progress: ProgressReporter,
  signal: AbortSignal | undefined,
  started: number
): Promise<RestoreResult> {
  const result: RestoreResult = { objectsRestored: 0, rowsInserted: 0, errors: [], durationMs: 0 }
  const cancelled = (): boolean => signal?.aborted === true
  const structure = options.includeStructure
  const total = items.length
  let index = 0
  let done = 0
  /** First failure when «Continuar en caso de error» is off: the transaction is rolled back. */
  let fatal: { label: string; message: string } | null = null

  const detailOf = (item: Item) => ({
    objectType: TYPE_LABEL[item.object.type] ?? item.object.type,
    objectName: item.label,
    objectIndex: Math.min(total, index + 1),
    objects: total
  })

  /** Runs `fn` under a savepoint; returns the error (rolled back to the savepoint) or null. */
  const attempt = async (fn: () => Promise<void>): Promise<unknown> => {
    await session.query('SAVEPOINT vqb_object')
    try {
      await fn()
      await session.query('RELEASE SAVEPOINT vqb_object')
      return null
    } catch (err) {
      await session.query('ROLLBACK TO SAVEPOINT vqb_object')
      return err
    }
  }

  const fail = (item: Item, err: unknown): void => {
    const message = describeError(err)
    result.errors.push({ object: item.label, message })
    progress({
      phase: 'objectError',
      current: index,
      total,
      message: `Error al restaurar ${item.label}`,
      done: false,
      detail: { ...detailOf(item), objectsDone: done, error: message }
    })
    if (!options.continueOnError) fatal ??= { label: item.label, message }
  }

  const announce = (item: Item, rows: number | null): void => {
    const estimate = item.object.type === 'table' && options.includeData ? item.object.rows : null
    progress({
      phase: 'object',
      current: index,
      total,
      message: `Restaurando ${item.label}`,
      done: false,
      detail: { ...detailOf(item), objectsDone: done, rows, rowsEstimate: estimate }
    })
  }

  const finished = (item: Item, rows: number | null): void => {
    result.objectsRestored++
    done++
    progress({
      phase: 'objectDone',
      current: index + 1,
      total,
      message: `${item.label} restaurado`,
      done: false,
      detail: { ...detailOf(item), objectsDone: done, rows }
    })
  }

  const createObject = async (item: Item): Promise<void> => {
    if (options.dropObjectsFirst && !options.replaceAll) {
      const drop = dropStatement(item)
      if (drop) await session.query(drop)
    }
    if (!item.ddl.trim()) throw new Error(`La copia no contiene la definición de ${item.label}`)
    await session.query(item.ddl)
    if (item.object.type !== 'sequence')
      for (const sql of item.meta.postDdl ?? []) await session.query(sql)
    for (const sql of item.meta.comments ?? []) await session.query(sql)
  }

  /** Structure objects of one phase, in order; `passes` retries failures while some succeed. */
  const phase = async (list: Item[], passes: boolean): Promise<void> => {
    let pending = list
    while (pending.length && !fatal) {
      const failed: { item: Item; err: unknown }[] = []
      for (const item of pending) {
        if (cancelled()) throw new Error(RESTORE_CANCELLED)
        announce(item, null)
        const err = await attempt(() => createObject(item))
        if (err) {
          if (passes) failed.push({ item, err })
          else fail(item, err)
          if (fatal) return
          continue
        }
        finished(item, null)
        index++
      }
      if (!passes || failed.length === 0) return
      if (failed.length === pending.length) {
        for (const f of failed) {
          fail(f.item, f.err)
          index++
          if (fatal) return
        }
        return
      }
      pending = failed.map((f) => f.item)
    }
  }

  const tableData = async (item: Item, onRows: (n: number) => void): Promise<number> => {
    const columns = item.meta.columns ?? []
    if (!columns.length || !item.meta.data?.length) return 0
    const target = qn(item.object.schema ?? 'public', item.object.name)
    const width = columns.length
    const maxRows = Math.max(1, Math.min(INSERT_MAX_ROWS, Math.floor(INSERT_MAX_PARAMS / width)))
    // OVERRIDING SYSTEM VALUE (identity GENERATED ALWAYS) is PostgreSQL 10: older servers have no identity.
    const overriding = featuresOf(session).identity ? 'OVERRIDING SYSTEM VALUE ' : ''
    const head = `INSERT INTO ${target} (${columns.map((c) => qi(c.name)).join(', ')}) ${overriding}VALUES `
    let params: (string | null)[] = []
    let tuples: string[] = []
    let bytes = 0
    let inserted = 0
    let reported = 0
    const flush = async (): Promise<void> => {
      if (!tuples.length) return
      await session.query(head + tuples.join(', '), params)
      inserted += tuples.length
      params = []
      tuples = []
      bytes = 0
      if (inserted - reported >= 5000) {
        reported = inserted
        onRows(inserted)
      }
    }
    await reader.rows(
      item.meta,
      async (row: VqbValue[]) => {
        const marks: string[] = []
        for (let i = 0; i < width; i++) {
          const value = pgParam(row[i], columns[i].delimiter ?? ',')
          params.push(value)
          bytes += value === null ? 4 : value.length
          marks.push(`$${params.length}::${columns[i].type}`)
        }
        tuples.push(`(${marks.join(', ')})`)
        if (tuples.length >= maxRows || bytes >= INSERT_MAX_BYTES) await flush()
      },
      signal
    )
    await flush()
    return inserted
  }

  try {
    await session.query('BEGIN')
    await session.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)")
    await session.query("SELECT pg_catalog.set_config('check_function_bodies', 'off', true)")
    await session.query("SELECT pg_catalog.set_config('client_min_messages', 'warning', true)")
    if (options.replaceAll)
      for (const schema of await listSchemas(session))
        await session.query(`DROP SCHEMA ${qi(schema)} CASCADE`)
    if (structure) for (const schema of schemas) await createSchemaIfMissing(session, schema)

    const of = (...types: VqbObjectType[]): Item[] =>
      items.filter((i) => types.includes(i.object.type))
    const tables = of('table')
    if (structure) {
      await phase(of('extension'), false)
      if (!fatal) await phase(of('type'), true)
      if (!fatal) await phase(of('sequence'), false)
    }
    for (const item of tables) {
      if (fatal) break
      if (cancelled()) throw new Error(RESTORE_CANCELLED)
      announce(item, options.includeData ? 0 : null)
      let rows = 0
      const err = await attempt(async () => {
        if (structure) await createObject(item)
        if (options.includeData)
          rows = await tableData(item, (count) =>
            progress({
              phase: 'rows',
              current: index,
              total,
              message: `Restaurando ${item.label}: ${count} filas`,
              done: false,
              detail: {
                ...detailOf(item),
                objectsDone: done,
                rows: count,
                rowsEstimate: item.object.rows
              }
            })
          )
      })
      if (err) {
        if (cancelled()) throw new Error(RESTORE_CANCELLED)
        fail(item, err)
      } else {
        result.rowsInserted += rows
        finished(item, options.includeData ? rows : null)
      }
      index++
    }
    if (structure && !fatal) {
      await phase(of('function', 'procedure'), false)
      if (!fatal) await phase(of('view', 'materialized_view'), true)
      // After every row: secondary indexes, foreign keys, triggers, sequence values.
      const post = async (item: Item, statements: string[]): Promise<void> => {
        if (fatal || !statements.length) return
        const err = await attempt(async () => {
          for (const sql of statements) await session.query(sql)
        })
        if (err) fail(item, err)
      }
      const failedNames = new Set(result.errors.map((e) => e.object))
      const ok = (i: Item): boolean => !failedNames.has(i.label)
      for (const item of [...tables, ...of('materialized_view')].filter(ok))
        await post(item, item.meta.indexes ?? [])
      for (const item of tables.filter(ok)) await post(item, item.meta.foreignKeys ?? [])
      for (const item of tables.filter(ok)) await post(item, item.meta.triggers ?? [])
      for (const item of of('sequence').filter(ok)) await post(item, item.meta.postDdl ?? [])
      if (!options.skipAutoIncrement)
        for (const item of [...of('sequence'), ...tables].filter(ok))
          await post(
            item,
            (item.meta.sequences ?? []).map(
              (s) =>
                `SELECT pg_catalog.setval(${pgLiteral(qn(s.schema, s.name))}::pg_catalog.regclass, ${s.lastValue}, ${s.isCalled ? 'true' : 'false'})`
            )
          )
    }
    if (cancelled()) throw new Error(RESTORE_CANCELLED)
    if (fatal) {
      await session.query('ROLLBACK').catch(() => undefined)
      const f = fatal as { label: string; message: string }
      throw new PgRestoreRolledBackError(
        `No se pudo restaurar ${f.label}: ${f.message}. No se ha restaurado nada: la restauración en PostgreSQL es una sola transacción y se ha deshecho.`
      )
    }
    await session.query('COMMIT')
  } catch (err) {
    if (session.transactionStatus() !== 'idle')
      await session.query('ROLLBACK').catch(() => undefined)
    throw err
  }
  progress({
    phase: 'finish',
    current: total,
    total,
    message: 'Restauración terminada',
    done: false
  })
  result.durationMs = Math.round(performance.now() - started)
  return result
}

const pgLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`

const TYPE_LABEL: Record<string, string> = {
  extension: 'Extension',
  type: 'Type',
  sequence: 'Sequence',
  table: 'Table',
  function: 'Function',
  procedure: 'Procedure',
  view: 'View',
  materialized_view: 'MaterializedView'
}
