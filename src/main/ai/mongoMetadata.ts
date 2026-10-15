/**
 * Structure-only reader for the AI assistant on MongoDB connections (same
 * rule as metadata.ts, pgMetadata.ts and sqliteMetadata.ts).
 *
 * PRIVACY: MongoDB has no information_schema, so the guard is the shape of
 * this module: `MongoStructureSource` exposes only collection listings,
 * index key names, estimated counts and a field-shape sample whose values are
 * dropped as soon as their BSON type is known (documents.ts `shapeOf`). It
 * has no generic query method. What reaches the provider:
 * - collection and view names (never a view's pipeline: it can hold literals);
 * - index names, key field names and directions, unique/sparse/TTL flags
 *   (never a partial filter or collation: they can hold literals);
 * - the `$jsonSchema` validator reduced to bsonType / required / properties /
 *   items / description (enum, pattern, const, bounds and query-operator
 *   validators are left out);
 * - field paths with their BSON types and how many sampled documents have them,
 *   with keys that are data (e-mails, ids, dates, keys of map-like objects)
 *   collapsed to `<clave>` (documents.ts `shapeOf` with `collapseDataKeys`).
 */
import type { Document } from 'mongodb'
import type { MongoFieldStat } from '@shared/types'
import { isHiddenCollection } from '../mongo/admin'
import type { MongoDriverConnection } from '../mongo/connection'
import { shapeOf } from '../mongo/documents'
import { numberOf } from '../mongo/values'
import type { ColumnMeta, IndexMeta, SchemaSnapshot, TableMeta } from './metadata'

/** Documents sampled per collection for the field shape. */
export const AI_SAMPLE_SIZE = 200
/** Collections described in one snapshot (the rest are listed by name). */
const MAX_COLLECTIONS = 60
const MAX_FIELDS = 80

export interface MongoStructureSource {
  databases(): Promise<string[]>
  collections(database: string): Promise<{ name: string; type: string; options: Document }[]>
  indexes(database: string, collection: string): Promise<Document[]>
  estimatedCount(database: string, collection: string): Promise<number | null>
  /** Field paths and BSON types of a sample (values never leave this call). */
  shape(database: string, collection: string): Promise<MongoFieldStat[]>
  serverVersion(): string
}

/** The only door from the AI service to a MongoDB connection. */
export function mongoStructureSource(conn: MongoDriverConnection): MongoStructureSource {
  return {
    async databases() {
      const r = await conn.client
        .db('admin')
        .admin()
        .listDatabases({ nameOnly: true, authorizedDatabases: true })
      return r.databases.map((d) => d.name).sort()
    },
    async collections(database) {
      const list = await conn
        .db(database)
        .listCollections({}, { authorizedCollections: true })
        .toArray()
      return list
        .filter((c) => !isHiddenCollection(String(c.name)))
        .map((c) => ({
          name: String(c.name),
          type: String(c.type ?? 'collection'),
          options: ((c as { options?: Document }).options ?? {}) as Document
        }))
    },
    async indexes(database, collection) {
      try {
        return await conn.coll(database, collection).listIndexes().toArray()
      } catch {
        return []
      }
    },
    async estimatedCount(database, collection) {
      try {
        return await conn.coll(database, collection).estimatedDocumentCount({ maxTimeMS: 3000 })
      } catch {
        return null
      }
    },
    async shape(database, collection) {
      try {
        const docs = await conn
          .rawColl(database, collection)
          .aggregate([{ $sample: { size: AI_SAMPLE_SIZE } }], { maxTimeMS: 10_000 })
          .toArray()
        // Keys that are data (e-mails, ids, dates, map keys) never leave as field names.
        return shapeOf(docs, { collapseDataKeys: true })
      } catch {
        return []
      }
    },
    serverVersion: () => conn.serverVersion
  }
}

const SCHEMA_KEYS = new Set([
  'bsonType',
  'type',
  'required',
  'properties',
  'items',
  'description',
  'title'
])

/** The structural part of a $jsonSchema (see the module comment). */
export function schemaShape(schema: unknown, depth = 0): unknown {
  if (depth > 12 || schema === null || typeof schema !== 'object') return undefined
  if (Array.isArray(schema))
    return schema.map((s) => schemaShape(s, depth + 1)).filter((s) => s !== undefined)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!SCHEMA_KEYS.has(key)) continue
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          schemaShape(v, depth + 1)
        ])
      )
    } else if (key === 'items') out.items = schemaShape(value, depth + 1)
    else if (key === 'required' && Array.isArray(value))
      out.required = value.filter((v) => typeof v === 'string')
    else if (
      (key === 'bsonType' || key === 'type') &&
      (typeof value === 'string' || Array.isArray(value))
    )
      out[key] = value
    else if ((key === 'description' || key === 'title') && typeof value === 'string')
      out[key] = value.slice(0, 200)
  }
  return out
}

function indexMeta(ix: Document): IndexMeta & { detail: string } {
  const key = (ix.key ?? {}) as Record<string, unknown>
  const columns = Object.keys(key)
  const parts = Object.entries(key).map(
    ([k, v]) => `${k} ${typeof v === 'string' ? v : numberOf(v) < 0 ? 'desc' : 'asc'}`
  )
  const flags = [
    ix.unique ? 'único' : '',
    ix.sparse ? 'disperso' : '',
    ix.expireAfterSeconds !== undefined ? `TTL ${numberOf(ix.expireAfterSeconds)} s` : '',
    ix.partialFilterExpression ? 'parcial' : ''
  ].filter(Boolean)
  return {
    name: String(ix.name),
    unique: ix.unique === true || ix.name === '_id_',
    columns,
    detail: `${parts.join(', ')}${flags.length ? ` (${flags.join(', ')})` : ''}`
  }
}

/**
 * Structure of a MongoDB database as a SchemaSnapshot (collections as tables,
 * sampled field paths as columns), so the shared context builder formats it.
 */
export async function readMongoSnapshot(
  source: MongoStructureSource,
  database: string,
  only?: string[],
  /** Collections sampled at most (a whole-connection context shares a budget). */
  limit = MAX_COLLECTIONS
): Promise<SchemaSnapshot> {
  const all = await source.collections(database)
  const wanted = only ? all.filter((c) => only.includes(c.name)) : all
  const max = Math.max(0, Math.min(limit, MAX_COLLECTIONS))
  const described = wanted.slice(0, max)
  const tables: TableMeta[] = []
  for (const c of described) {
    const isView = c.type === 'view'
    const [indexes, count, fields] = await Promise.all([
      isView ? Promise.resolve([] as Document[]) : source.indexes(database, c.name),
      isView ? Promise.resolve(null) : source.estimatedCount(database, c.name),
      source.shape(database, c.name)
    ])
    const sampled = Math.max(0, ...fields.filter((f) => f.path === '_id').map((f) => f.count))
    const validator = c.options.validator as Document | undefined
    const schema =
      validator && typeof validator === 'object' && '$jsonSchema' in validator
        ? (schemaShape(validator.$jsonSchema) as {
            required?: string[]
            properties?: Record<string, { bsonType?: unknown; description?: string }>
          })
        : null
    const columns: ColumnMeta[] = fields.slice(0, MAX_FIELDS).map((f) => ({
      name: f.path,
      type: Object.keys(f.types).join('|') || '?',
      nullable: sampled > 0 && f.count < sampled,
      key: f.path === '_id' ? 'PRI' : '',
      extra: '',
      comment: schema?.properties?.[f.path]?.description ?? ''
    }))
    // Fields the validator describes that the sample did not see.
    for (const [name, prop] of Object.entries(schema?.properties ?? {}))
      if (!columns.some((col) => col.name === name) && columns.length < MAX_FIELDS)
        columns.push({
          name,
          type: Array.isArray(prop?.bsonType)
            ? prop.bsonType.join('|')
            : String(prop?.bsonType ?? '?'),
          nullable: !schema?.required?.includes(name),
          key: '',
          extra: '',
          comment: prop?.description ?? ''
        })
    const notes: string[] = []
    if (isView && typeof c.options.viewOn === 'string')
      notes.push(`vista sobre ${c.options.viewOn}`)
    if (c.options.capped) notes.push('colección limitada (capped)')
    if (c.type === 'timeseries') notes.push('serie temporal')
    if (schema) notes.push(`validador: obligatorios ${schema.required?.join(', ') || '(ninguno)'}`)
    else if (validator && Object.keys(validator).length)
      notes.push('validador con operadores de consulta (no se incluye)')
    if (fields.length > MAX_FIELDS) notes.push(`${fields.length - MAX_FIELDS} campos más`)
    const metas = indexes.map(indexMeta)
    tables.push({
      name: c.name,
      kind: isView ? 'view' : 'table',
      rows: count,
      comment: notes.join(' · '),
      columns,
      indexes: metas.map(({ name, unique, columns: cols }) => ({ name, unique, columns: cols })),
      foreignKeys: []
    })
  }
  for (const c of wanted.slice(max))
    tables.push({
      name: c.name,
      kind: c.type === 'view' ? 'view' : 'table',
      rows: null,
      comment: '',
      columns: [],
      indexes: [],
      foreignKeys: []
    })
  return {
    schema: database,
    serverVersion: `MongoDB ${source.serverVersion()}`,
    tables,
    routines: []
  }
}

/** Databases a whole-connection context leaves out (server internals, not user data). */
export const MONGO_SYSTEM_DATABASES: ReadonlySet<string> = new Set(['admin', 'local', 'config'])

/** Context line that tells the model which engine and syntax to use. */
export const MONGO_ENGINE_NOTE =
  'Motor: MongoDB. Las «tablas» son colecciones y las «columnas», rutas de campos muestreadas con sus tipos BSON (sin valores). Escribe órdenes del shell de MongoDB (db.colección.find / aggregate / countDocuments / distinct / updateMany…, con ObjectId(), ISODate(), NumberLong()…) en bloques ```javascript, nunca SQL. El editor de Vortaq solo admite llamadas db.colección.método(...), use <bd> y show dbs|collections: no uses variables, funciones ni bucles.'
