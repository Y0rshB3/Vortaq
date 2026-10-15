/**
 * The MCP tools (docs: README «Agentes (MCP)»). Each function receives a
 * connection already resolved and checked by server.ts (global switch,
 * availability, level) and returns plain JSON for the agent.
 *
 * - Structure (every level): db:* handlers on SQL engines; on MongoDB only the
 *   structure source of the AI assistant (ai/mongoMetadata.ts): collection
 *   names, index keys, the structural part of a $jsonSchema and sampled field
 *   paths with their BSON types; never documents, view pipelines, partial
 *   filters or enum/pattern literals.
 * - run_query (read): one statement that checkExportStatement proves
 *   read-only, run again in a NEW read-only session (export/sources.ts); on
 *   MongoDB the query-tab grammar, refused unless every statement provably
 *   reads. Never a query tab's session.
 * - execute_sql (write): the normal execute path (autocommit, no tab session)
 *   with main's production guard; never sent with confirmProduction.
 */
import { randomUUID } from 'node:crypto'
import { dialectForEngine, getDialect } from '@shared/dialects'
import { mariadbDialect } from '@shared/dialects/mariadb'
import { mysqlDialect } from '@shared/dialects/mysql'
import {
  checkExportStatement,
  EXPORT_NOT_A_QUERY,
  EXPORT_ONE_STATEMENT,
  EXPORT_SESSION_VARIABLES,
  leadingWord
} from '@shared/export/statement'
import { analyzeMongoWrites, isObviousMongoWrite } from '@shared/mongo/classify'
import type {
  CellValue,
  ColumnInfo,
  MongoCommandResult,
  QueryStatementResult,
  SchemaRef,
  StorageClass,
  TableStructure
} from '@shared/types'
import { formatPlan, isSingleSelect } from '../ai/explain'
import { MONGO_SYSTEM_DATABASES, mongoStructureSource, schemaShape } from '../ai/mongoMetadata'
import { isSinglePgSelect } from '../ai/pgMetadata'
import { isSingleSqliteSelect } from '../ai/sqliteMetadata'
import { isMysqlFamily } from '../db/driver'
import { openRowSource, type RowSource } from '../export/sources'
import { CANCELLED_EXPORT } from '../export/writer'
import { assertScriptAllowed } from '../ipc/productionGuard'
import { isMongoConnection } from '../mongo/connection'
import { prepareMongoScript, type PreparedStatement } from '../mongo/run'
import { MongoInputError, numberOf } from '../mongo/values'
import { isMariaDbSession } from '../mysql/mariadb'
import { executeScript } from '../db/query'
import { describeError as describeMysqlError } from '../mysql/errors'
import { toStatementResult } from '../mysql/query'
import type { PooledSession } from '../mysql/session'
import { composeSearchPath, formatSearchPath } from '../postgres/client'
import { isPgConnection } from '../postgres/connection'
import { isSqliteConnection } from '../sqlite/connection'
import { McpToolError } from './access'
import type { McpConnectionView, McpRuntime, ResolvedConnection } from './runtime'
import {
  cutStrings,
  cutText,
  withoutKeys,
  MCP_LIMITS,
  MORE_ROWS_NOTE,
  resolveRowLimit,
  resolveTimeoutMs,
  ResponseBudget,
  SIZE_NOTE,
  tableOut,
  type TableOut
} from './values'

/** What a tool returns: the JSON for the agent and the row count for the activity log. */
export interface ToolOutput {
  data: Record<string, unknown>
  rows?: number
}

export interface QueryArgs {
  database?: string | null
  schema?: string | null
  sql: string
  max_rows?: number | null
  timeout_seconds?: number | null
}

const MYSQL_SYSTEM = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

const isMysqlEngine = (c: ResolvedConnection): boolean =>
  c.config.engine === 'mysql' || c.config.engine === 'mariadb'

const timeoutMessage = (ms: number): string =>
  `La consulta superó el tiempo límite de ${Math.round(ms / 1000)} s y se canceló en el servidor. Filtra o limita la consulta, o sube timeout_seconds (máximo ${MCP_LIMITS.maxTimeoutSec}).`

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ---------- list_connections ---------- */

export function listConnections(rt: McpRuntime): ToolOutput {
  const connections: McpConnectionView[] = rt.connections()
  return {
    data: {
      connections,
      ...(connections.length
        ? {}
        : {
            note: 'El usuario no ha activado ninguna conexión para agentes: en Vortaq, editar la conexión › Agentes (MCP).'
          })
    },
    rows: connections.length
  }
}

/* ---------- namespaces ---------- */

function pgDatabase(c: ResolvedConnection, database?: string | null): string {
  return database?.trim() || c.config.postgres?.initialDatabase || 'postgres'
}

function mongoDatabase(c: ResolvedConnection, database?: string | null): string {
  return database?.trim() || c.config.mongo?.defaultDatabase || 'test'
}

function requireMysqlDatabase(database?: string | null): string {
  const db = database?.trim()
  if (!db)
    throw new McpToolError('Falta «database»: usa list_databases para ver las bases de datos.')
  return db
}

async function mongoSource(rt: McpRuntime, id: string) {
  const connection = await rt.manager.connection(id)
  if (!isMongoConnection(connection)) throw new McpToolError('La conexión no es MongoDB.')
  return mongoStructureSource(connection)
}

/* ---------- list_databases ---------- */

export async function listDatabases(
  rt: McpRuntime,
  c: ResolvedConnection,
  args: { include_system?: boolean | null }
): Promise<ToolOutput> {
  const id = c.config.id
  const system = args.include_system === true
  const engine = c.config.engine
  if (engine === 'mongodb') {
    const names = (await (await mongoSource(rt, id)).databases()).filter(
      (n) => system || !MONGO_SYSTEM_DATABASES.has(n)
    )
    return { data: { engine, databases: names.map((name) => ({ name })) }, rows: names.length }
  }
  const all = (await rt.invoke('db:databases', id)).map((d) => d.name)
  if (engine === 'sqlite') {
    return {
      data: {
        engine,
        databases: all.map((name) => ({ name })),
        note: '«main» es el archivo de la conexión; los demás nombres son bases de datos adjuntas (úsalos como prefijo: alias.tabla).'
      },
      rows: all.length
    }
  }
  if (engine === 'postgresql') {
    const databases: Record<string, unknown>[] = []
    for (const [i, name] of all.entries()) {
      if (i >= MCP_LIMITS.maxPgDatabases) {
        databases.push({ name })
        continue
      }
      try {
        const schemas = (await rt.invoke('db:schemas', id, name))
          .filter((s) => system || !s.system)
          .map((s) => s.name)
        databases.push({ name, schemas })
      } catch (err) {
        databases.push({ name, schemas_error: c.redact(messageOf(err)) })
      }
    }
    return {
      data: {
        engine,
        default_database: pgDatabase(c),
        databases,
        ...(all.length > MCP_LIMITS.maxPgDatabases
          ? {
              note: `Solo se leen los esquemas de las primeras ${MCP_LIMITS.maxPgDatabases} bases de datos: usa list_tables con database para las demás.`
            }
          : {})
      },
      rows: databases.length
    }
  }
  // MySQL / MariaDB: the connection's «Lista de bases de datos personalizada» also limits this list.
  const custom = c.config.customDatabases ?? []
  const names = all
    .filter((n) => system || !MYSQL_SYSTEM.has(n.toLowerCase()))
    .filter((n) => !custom.length || custom.includes(n))
  return { data: { engine, databases: names.map((name) => ({ name })) }, rows: names.length }
}

/* ---------- list_tables ---------- */

interface TableRow {
  name: string
  schema?: string
  kind: string
  rows_estimate?: number | null
  comment?: string
}

async function pgSchemas(rt: McpRuntime, id: string, database: string): Promise<string[]> {
  return (await rt.invoke('db:schemas', id, database)).filter((s) => !s.system).map((s) => s.name)
}

async function sqlTables(
  rt: McpRuntime,
  id: string,
  ref: SchemaRef,
  schema?: string
): Promise<TableRow[]> {
  const [tables, views] = await Promise.all([
    rt.invoke('db:tables', id, ref),
    rt.invoke('db:views', id, ref)
  ])
  const rows: TableRow[] = tables.map((t) => ({
    name: t.name,
    ...(schema ? { schema } : {}),
    kind: 'table',
    rows_estimate: t.rows,
    ...(t.comment ? { comment: t.comment } : {})
  }))
  for (const v of views) rows.push({ name: v.name, ...(schema ? { schema } : {}), kind: 'view' })
  return rows
}

export async function listTables(
  rt: McpRuntime,
  c: ResolvedConnection,
  args: { database?: string | null; schema?: string | null }
): Promise<ToolOutput> {
  const id = c.config.id
  const engine = c.config.engine
  if (engine === 'mongodb') {
    const database = mongoDatabase(c, args.database)
    const collections = await (await mongoSource(rt, id)).collections(database)
    const tables = collections.map((col) => ({
      name: col.name,
      kind: col.type,
      ...(col.type === 'view' && typeof col.options.viewOn === 'string'
        ? { view_on: col.options.viewOn }
        : {})
    }))
    return { data: { database, collections: tables }, rows: tables.length }
  }
  if (engine === 'postgresql') {
    const database = pgDatabase(c, args.database)
    const schemas = args.schema?.trim() ? [args.schema.trim()] : await pgSchemas(rt, id, database)
    const tables: TableRow[] = []
    for (const schema of schemas) {
      const ref = { database, schema }
      tables.push(...(await sqlTables(rt, id, ref, schema)))
      try {
        const matviews = await rt.invoke('db:objects', id, ref, 'materialized_view')
        for (const m of matviews) tables.push({ name: m.name, schema, kind: 'materialized_view' })
      } catch {
        /* older servers or no privileges: tables and views are enough */
      }
    }
    return { data: { database, tables }, rows: tables.length }
  }
  if (engine === 'sqlite') {
    const database = args.database?.trim() || 'main'
    const tables = await sqlTables(rt, id, database)
    return { data: { database, tables }, rows: tables.length }
  }
  const database = requireMysqlDatabase(args.database)
  const tables = await sqlTables(rt, id, database)
  return { data: { database, tables }, rows: tables.length }
}

/* ---------- describe_table ---------- */

function columnOut(col: ColumnInfo): Record<string, unknown> {
  return {
    name: col.name,
    type: col.columnType || col.dataType,
    nullable: col.nullable,
    default: col.defaultValue,
    ...(col.key ? { key: col.key } : {}),
    ...(col.primaryKey ? { primary_key: true } : {}),
    ...(col.autoIncrement ? { auto_increment: true } : {}),
    ...(col.generated ? { generated: col.generated } : {}),
    ...(col.extra && !col.autoIncrement ? { extra: col.extra } : {}),
    ...(col.comment ? { comment: col.comment } : {})
  }
}

function structureOut(s: TableStructure): Record<string, unknown> {
  const primary = s.columns.filter((c) => c.primaryKey || c.key === 'PRI').map((c) => c.name)
  return {
    name: s.name,
    ...(s.schema ? { schema: s.schema } : {}),
    kind: s.kind ?? (s.tableType === 'VIEW' ? 'view' : 'table'),
    ...(s.comment ? { comment: s.comment } : {}),
    columns: s.columns.map(columnOut),
    primary_key: primary,
    indexes: s.indexes.map((i) => ({
      name: i.name,
      unique: i.unique,
      ...(i.primary || i.name === 'PRIMARY' ? { primary: true } : {}),
      columns: i.columns,
      ...(i.type ? { type: i.type } : {})
    })),
    foreign_keys: s.foreignKeys.map((f) => ({
      name: f.name,
      columns: f.columns,
      references: {
        ...(f.referencedSchema ? { schema: f.referencedSchema } : {}),
        table: f.referencedTable,
        columns: f.referencedColumns
      },
      on_update: f.onUpdate,
      on_delete: f.onDelete
    })),
    ...(s.constraints?.length
      ? {
          constraints: s.constraints
            .filter((k) => k.type === 'check' || k.type === 'exclusion')
            .map((k) => ({ name: k.name, type: k.type, definition: k.definition }))
        }
      : {})
  }
}

async function describeSql(
  rt: McpRuntime,
  id: string,
  ref: SchemaRef,
  table: string
): Promise<Record<string, unknown>> {
  try {
    return structureOut(await rt.invoke('db:tableStructure', id, ref, table))
  } catch (err) {
    // Views without a full structure on some servers: their columns are enough.
    const columns = await rt.invoke('db:columns', id, ref, table).catch(() => null)
    if (!columns?.length) throw err
    return { name: table, kind: 'view', columns: columns.map(columnOut) }
  }
}

async function describeMongo(
  rt: McpRuntime,
  c: ResolvedConnection,
  database: string,
  name: string
): Promise<Record<string, unknown>> {
  const source = await mongoSource(rt, c.config.id)
  const info = (await source.collections(database)).find((col) => col.name === name)
  if (!info)
    throw new McpToolError(
      `No existe la colección «${name}» en «${database}»: usa list_tables para ver las colecciones.`
    )
  const isView = info.type === 'view'
  const [indexes, count, fields] = await Promise.all([
    isView ? Promise.resolve([]) : source.indexes(database, name),
    isView ? Promise.resolve(null) : source.estimatedCount(database, name),
    source.shape(database, name)
  ])
  const sampled = Math.max(0, ...fields.filter((f) => f.path === '_id').map((f) => f.count))
  const validator = info.options.validator as Record<string, unknown> | undefined
  const schema =
    validator && typeof validator === 'object' && '$jsonSchema' in validator
      ? schemaShape(validator.$jsonSchema)
      : null
  const notes: string[] = []
  if (validator && !schema && Object.keys(validator).length)
    notes.push('Tiene un validador con operadores de consulta (no se incluye).')
  if (info.options.capped) notes.push('Colección limitada (capped).')
  if (fields.length > 200) notes.push(`${fields.length - 200} rutas de campos más en la muestra.`)
  return {
    database,
    name,
    kind: info.type,
    ...(isView && typeof info.options.viewOn === 'string' ? { view_on: info.options.viewOn } : {}),
    estimated_documents: count,
    sampled_documents: sampled,
    fields: fields
      .slice(0, 200)
      .map((f) => ({ path: f.path, types: f.types, present_in: f.count })),
    indexes: indexes.map((ix) => {
      const key = (ix.key ?? {}) as Record<string, unknown>
      return {
        name: String(ix.name),
        keys: Object.entries(key).map(([field, v]) => ({
          field,
          order: typeof v === 'string' ? v : numberOf(v) < 0 ? 'desc' : 'asc'
        })),
        unique: ix.unique === true || ix.name === '_id_',
        ...(ix.sparse ? { sparse: true } : {}),
        ...(ix.hidden ? { hidden: true } : {}),
        ...(ix.expireAfterSeconds !== undefined
          ? { ttl_seconds: numberOf(ix.expireAfterSeconds) }
          : {}),
        // Only that it is partial: the filter can hold literal values.
        ...(ix.partialFilterExpression ? { partial: true } : {})
      }
    }),
    ...(schema ? { validator_schema: schema } : {}),
    ...(notes.length ? { notes } : {}),
    note: 'Campos muestreados (hasta 200 documentos al azar) con sus tipos BSON; nunca valores.'
  }
}

export async function describeTable(
  rt: McpRuntime,
  c: ResolvedConnection,
  args: { database?: string | null; schema?: string | null; table: string }
): Promise<ToolOutput> {
  const id = c.config.id
  const table = args.table?.trim()
  if (!table) throw new McpToolError('Falta «table»: usa list_tables para ver los nombres.')
  const engine = c.config.engine
  if (engine === 'mongodb') {
    const data = await describeMongo(rt, c, mongoDatabase(c, args.database), table)
    return { data, rows: (data.fields as unknown[]).length }
  }
  if (engine === 'postgresql') {
    const database = pgDatabase(c, args.database)
    let schema = args.schema?.trim()
    if (!schema) {
      // The schema that holds the table: public first, then the others.
      const schemas = await pgSchemas(rt, id, database)
      const ordered = [
        ...schemas.filter((s) => s === 'public'),
        ...schemas.filter((s) => s !== 'public')
      ]
      const found: string[] = []
      for (const s of ordered) {
        const names = (await sqlTables(rt, id, { database, schema: s })).map((t) => t.name)
        if (names.includes(table)) found.push(s)
      }
      if (found.length > 1)
        throw new McpToolError(
          `La tabla «${table}» existe en varios esquemas (${found.join(', ')}): indica «schema».`
        )
      schema = found[0] ?? 'public'
    }
    const data: Record<string, unknown> = {
      database,
      ...(await describeSql(rt, id, { database, schema }, table))
    }
    return { data, rows: (data.columns as unknown[]).length }
  }
  const database =
    engine === 'sqlite' ? args.database?.trim() || 'main' : requireMysqlDatabase(args.database)
  const data: Record<string, unknown> = {
    database,
    ...(await describeSql(rt, id, database, table))
  }
  return { data, rows: (data.columns as unknown[]).length }
}

/* ---------- run_query ---------- */

/** The export guard's reasons, worded for an agent. */
function readOnlyRefusal(reason: string, canWrite: boolean): string {
  const write = canWrite ? ' Para modificar datos usa execute_sql.' : ''
  if (reason === EXPORT_ONE_STATEMENT)
    return 'run_query ejecuta exactamente una sentencia: envía las consultas de una en una.'
  if (reason === EXPORT_NOT_A_QUERY)
    return `run_query solo ejecuta consultas de lectura que devuelven filas (SELECT, WITH, SHOW, EXPLAIN…).${write}`
  if (reason === EXPORT_SESSION_VARIABLES)
    return 'La consulta usa variables de sesión (@…): run_query abre una sesión nueva en cada llamada, donde están vacías.'
  if (reason.startsWith('No hay ninguna consulta')) return 'Falta la consulta («sql»).'
  const detail = /\(([^)]*)\)/.exec(reason)?.[1]
  return `run_query solo ejecuta consultas de solo lectura y esta podría modificar datos${detail ? ` (${detail})` : ''}.${write}`
}

const NO_ROWS_EXPORT = 'La consulta no devuelve filas: no hay nada que exportar.'

/** Errors of the row source, worded for an agent. */
function sourceError(err: unknown, c: ResolvedConnection): McpToolError {
  const message = messageOf(err)
  if (message === NO_ROWS_EXPORT)
    return new McpToolError(
      'La consulta no devuelve filas: run_query es para consultas de lectura.'
    )
  return new McpToolError(c.redact(message), 'error')
}

/** Runs `work`, calling `cancel` and failing with the timeout message once `ms` pass. */
async function withTimeout<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
  cancel: () => Promise<unknown>
): Promise<{ value: T; timedOut: boolean }> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
    void cancel().catch(() => undefined)
  }, ms)
  try {
    const value = await work(controller.signal)
    return { value, timedOut }
  } catch (err) {
    if (timedOut) throw new McpToolError(timeoutMessage(ms), 'timeout')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function sqlContext(c: ResolvedConnection, args: QueryArgs): SchemaRef | null {
  const database = args.database?.trim()
  const schema = args.schema?.trim()
  if (c.config.engine === 'postgresql')
    return database || schema ? { database: database ?? '', schema: schema ?? '' } : null
  if (c.config.engine === 'sqlite') return null
  return database || null
}

async function runSqlQuery(
  rt: McpRuntime,
  c: ResolvedConnection,
  args: QueryArgs
): Promise<ToolOutput> {
  const sql = typeof args.sql === 'string' ? args.sql : ''
  const dialect = dialectForEngine(c.config.engine)
  if (!dialect) throw new McpToolError('Este motor no admite SQL.')
  const check = checkExportStatement(dialect, sql)
  if (!check.ok) throw new McpToolError(readOnlyRefusal(check.reason, c.access === 'write'))
  const limit = resolveRowLimit(args.max_rows)
  const timeout = resolveTimeoutMs(args.timeout_seconds)
  let source: RowSource | null = null
  const rows: CellValue[][] = []
  const storage: StorageClass[][] = []
  let more = false
  let anyStorage = false
  try {
    await withTimeout(
      timeout,
      async (signal) => {
        source = await openRowSource(
          rt.ctx,
          rt.manager,
          c.config.id,
          { kind: 'statement', sql: check.sql, context: sqlContext(c, args) },
          randomUUID(),
          signal
        )
        const opened: RowSource = source
        read: for await (const batch of opened.batches) {
          for (let i = 0; i < batch.rows.length; i++) {
            if (rows.length > limit) {
              more = true
              break read
            }
            rows.push(batch.rows[i])
            const cells = batch.storage?.[i]
            if (cells) anyStorage = true
            storage.push(cells ?? [])
          }
        }
        if (rows.length > limit) more = true
        // MySQL keeps computing a statement whose stream was dropped: stop it.
        if (more && isMysqlEngine(c)) await opened.cancel().catch(() => undefined)
      },
      async () => {
        const opened = source as RowSource | null
        if (opened) await opened.cancel()
      }
    )
  } catch (err) {
    if (err instanceof McpToolError) throw err
    if (messageOf(err) === CANCELLED_EXPORT)
      throw new McpToolError(timeoutMessage(timeout), 'timeout')
    throw sourceError(err, c)
  } finally {
    const opened = source as RowSource | null
    await opened?.close().catch(() => undefined)
  }
  const opened = source as RowSource | null
  const table = tableOut(opened?.columns ?? [], rows, limit, {
    ...(anyStorage ? { storage } : {}),
    moreRows: more
  })
  return {
    data: { ...table, max_rows: limit, read_only_session: true },
    rows: table.row_count
  }
}

/**
 * Server commands an agent never runs: they describe the deployment (member
 * hosts and ports, client addresses, other sessions' operations), not the data.
 */
const MONGO_SERVER_COMMANDS = new Set(['serverStatus', 'currentOp'])
export const MONGO_SERVER_REFUSED =
  'rs.status(), db.serverStatus() y db.currentOp() no están disponibles para agentes: describen el servidor (hosts, clientes, operaciones de otras sesiones), no los datos.'

/** Aggregation stages that describe the deployment (hosts, sessions, other clients) instead of data. */
const MONGO_SERVER_STAGES = new Set([
  '$collStats',
  '$indexStats',
  '$planCacheStats',
  '$currentOp',
  '$listSessions',
  '$listLocalSessions',
  '$shardedDataDistribution'
])
export const MONGO_STAGE_REFUSED =
  'Las etapas $collStats, $indexStats, $planCacheStats, $currentOp y $listSessions no están disponibles para agentes: describen el servidor, no los datos. Usa getIndexes() o countDocuments().'
export const MONGO_SYSTEM_REFUSED =
  'Las bases de datos de sistema (admin, local, config) no están disponibles para agentes: guardan usuarios, la configuración del servidor y sus miembros.'

/** Keys of explain/stats answers that name the server (host, port, connection string). */
const SERVER_INFO_KEYS: ReadonlySet<string> = new Set(['serverInfo', 'host', 'connectionString'])

function hasStage(value: unknown, depth = 0): boolean {
  if (depth > 200) return true // fail closed
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return false
  if (Array.isArray(value)) return value.some((v) => hasStage(v, depth + 1))
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (MONGO_SERVER_STAGES.has(key)) return true
    if (hasStage(v, depth + 1)) return true
  }
  return false
}

/** Parses a script (every argument) without running anything; input errors are refusals. */
function prepareForAgent(script: string): PreparedStatement[] {
  try {
    return prepareMongoScript(script)
  } catch (err) {
    if (err instanceof MongoInputError) throw new McpToolError(err.message)
    throw err
  }
}

/**
 * Refuses, before anything runs, what describes the deployment rather than
 * the data: rs.*, serverStatus/currentOp, server stages, and the system
 * databases (users, replica set members, cluster configuration).
 */
function assertAgentScript(prepared: PreparedStatement[], startDatabase: string): void {
  let current = startDatabase
  for (const p of prepared) {
    const s = p.statement
    if (s.type === 'rs' || (s.type === 'db' && MONGO_SERVER_COMMANDS.has(s.method)))
      throw new McpToolError(MONGO_SERVER_REFUSED)
    if (s.type === 'use') current = s.database
    const database = ('database' in s && s.database ? s.database : current) ?? current
    if (s.type !== 'show' && MONGO_SYSTEM_DATABASES.has(database))
      throw new McpToolError(MONGO_SYSTEM_REFUSED)
    if (
      s.type === 'collection' &&
      (p.args.some(hasStage) || p.chain.some((c) => c.args.some(hasStage)))
    )
      throw new McpToolError(MONGO_STAGE_REFUSED)
  }
}

/** Statements whose answer describes the server (explain, stats): server keys are dropped. */
function answersWithServerInfo(prepared: PreparedStatement[]): boolean[] {
  return prepared.map(
    (p) =>
      p.statement.type === 'collection' &&
      (p.statement.method === 'stats' || p.statement.explain !== null || p.explain !== undefined)
  )
}

/** MongoDB: every statement must provably read (parsed, before anything runs). */
function assertMongoReads(script: string, canWrite: boolean): void {
  const write = canWrite ? ' Para modificar datos usa execute_sql.' : ''
  const analysis = analyzeMongoWrites(script)
  if (analysis.error) throw new McpToolError(analysis.error)
  if (analysis.writes || isObviousMongoWrite(script))
    throw new McpToolError(
      `run_query solo ejecuta órdenes de lectura (find, aggregate sin $out/$merge, countDocuments, distinct, getIndexes…): ${analysis.reasons.join('; ') || 'la orden modifica datos'}.${write}`
    )
  const prepared = prepareForAgent(script)
  if (prepared.some((p) => p.writes))
    throw new McpToolError(
      `run_query solo ejecuta órdenes de lectura: el script modifica datos.${write}`
    )
}

function parseEjson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Results of a MongoDB script, documents as canonical Extended JSON objects. */
function mongoResultsOut(
  results: MongoCommandResult[],
  c: ResolvedConnection,
  limit: number,
  /** Per statement (same order): its answer describes the server (explain, stats). */
  serverInfo: boolean[] = []
): { statements: Record<string, unknown>[]; rows: number } {
  const budget = new ResponseBudget()
  let rows = 0
  const statements = results.map((r, i) => {
    const base: Record<string, unknown> = {
      statement: cutText(r.statement, 300),
      ...(r.database ? { database: r.database } : {}),
      ...(r.collection ? { collection: r.collection } : {}),
      kind: r.kind
    }
    if (r.kind === 'error') return { ...base, error: c.redact(r.error ?? 'Error') }
    if (r.kind === 'write') return { ...base, write: r.write }
    if (r.kind === 'value') {
      const parsed = parseEjson(r.value ?? '')
      const value =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'v' in parsed
          ? (parsed as { v: unknown }).v
          : parsed
      const cut = cutStrings(serverInfo[i] ? withoutKeys(value, SERVER_INFO_KEYS) : value)
      return budget.take(cut)
        ? { ...base, value: cut }
        : { ...base, value: null, notes: [SIZE_NOTE] }
    }
    const docs: unknown[] = []
    const page = r.page
    for (const text of (page?.docs ?? []).slice(0, limit)) {
      const doc = cutStrings(parseEjson(text))
      if (!budget.take(doc)) break
      docs.push(doc)
    }
    rows += docs.length
    const truncated =
      budget.exceeded || page?.truncated === true || (page?.docs.length ?? 0) > docs.length
    return {
      ...base,
      documents: docs,
      document_count: docs.length,
      truncated,
      ...(truncated ? { notes: [budget.exceeded ? SIZE_NOTE : MORE_ROWS_NOTE] } : {})
    }
  })
  return { statements, rows }
}

async function closeMongoCursors(
  rt: McpRuntime,
  id: string,
  results: MongoCommandResult[]
): Promise<void> {
  for (const r of results)
    if (r.page?.resultId)
      await rt.invoke('mongo:closeCursor', id, r.page.resultId).catch(() => undefined)
}

async function runMongo(
  rt: McpRuntime,
  c: ResolvedConnection,
  args: QueryArgs,
  writes: boolean
): Promise<ToolOutput> {
  const script = typeof args.sql === 'string' ? args.sql : ''
  if (!script.trim())
    throw new McpToolError('Falta la orden («sql»), con la sintaxis del shell de MongoDB.')
  if (!writes) assertMongoReads(script, c.access === 'write')
  const prepared = prepareForAgent(script)
  assertAgentScript(prepared, mongoDatabase(c, args.database))
  const limit = resolveRowLimit(args.max_rows)
  const timeout = resolveTimeoutMs(args.timeout_seconds)
  const executionId = randomUUID()
  const id = c.config.id
  let results: MongoCommandResult[] = []
  try {
    const run = await withTimeout(
      timeout,
      () =>
        rt.invoke('mongo:execute', id, script, {
          database: mongoDatabase(c, args.database),
          executionId,
          maxDocs: limit
        }),
      () => rt.invoke('db:cancel', id, executionId)
    )
    results = run.value
    if (run.timedOut) throw new McpToolError(timeoutMessage(timeout), 'timeout')
  } catch (err) {
    if (err instanceof McpToolError) throw err
    throw new McpToolError(c.redact(messageOf(err)), 'error')
  } finally {
    await closeMongoCursors(rt, id, results)
  }
  const out = mongoResultsOut(results, c, limit, answersWithServerInfo(prepared))
  return { data: { statements: out.statements, max_rows: limit }, rows: out.rows }
}

export function runQuery(
  rt: McpRuntime,
  c: ResolvedConnection,
  args: QueryArgs
): Promise<ToolOutput> {
  return c.config.engine === 'mongodb' ? runMongo(rt, c, args, false) : runSqlQuery(rt, c, args)
}

/* ---------- explain_query ---------- */

/** KILL QUERY from another session (best effort). */
async function killMysqlQuery(rt: McpRuntime, id: string, threadId: number | null): Promise<void> {
  if (threadId === null) return
  let other: PooledSession | null = null
  try {
    other = await rt.manager.acquire(id, null)
    await other.query(`KILL QUERY ${Math.trunc(threadId)}`)
  } catch {
    /* already finished */
  } finally {
    await other?.release().catch(() => undefined)
  }
}

const EXPLAIN_ONE_SELECT =
  'explain_query necesita exactamente una sentencia SELECT de solo lectura (sin la palabra EXPLAIN).'

export async function explainQuery(
  rt: McpRuntime,
  c: ResolvedConnection,
  args: QueryArgs
): Promise<ToolOutput> {
  const sql = typeof args.sql === 'string' ? args.sql : ''
  const engine = c.config.engine
  const id = c.config.id
  if (engine === 'mongodb')
    throw new McpToolError(
      'explain_query es para SQL. En MongoDB usa run_query con .explain(), p. ej. db.pedidos.find({ estado: "x" }).explain().'
    )
  const dialect = dialectForEngine(engine) ?? getDialect('mysql')
  const check = checkExportStatement(dialect, sql)
  const single =
    engine === 'postgresql'
      ? isSinglePgSelect(sql)
      : engine === 'sqlite'
        ? isSingleSqliteSelect(sql)
        : isSingleSelect(sql)
  if (!check.ok || !single) throw new McpToolError(EXPLAIN_ONE_SELECT)
  const statement = check.sql.replace(/;\s*$/, '')
  const timeout = resolveTimeoutMs(args.timeout_seconds)
  const connection = await rt.manager.connection(id)
  let plan: string
  try {
    if (isPgConnection(connection)) {
      const database = pgDatabase(c, args.database)
      const schema = args.schema?.trim() || null
      const base = schema ? await connection.baseSearchPath(database) : []
      const session = await connection.acquire({ database, schema: null })
      session.usage.userSql = true
      const executionId = randomUUID()
      try {
        await session.query('BEGIN READ ONLY')
        if (schema)
          await session.query('SELECT set_config($1, $2, true)', [
            'search_path',
            formatSearchPath(composeSearchPath(schema, base))
          ])
        connection.registerExecution(executionId, session)
        // EXPLAIN without ANALYZE: the plan only, the statement never runs.
        const { value } = await withTimeout(
          timeout,
          () => session.query<Record<string, unknown>>(`EXPLAIN ${statement}`),
          () => connection.cancel(executionId)
        )
        const lines = value.map((r) => String(r['QUERY PLAN'] ?? ''))
        plan =
          lines.slice(0, 200).join('\n') +
          (lines.length > 200 ? `\n… ${lines.length - 200} líneas más` : '')
      } finally {
        connection.unregisterExecution(executionId)
        await session.query('ROLLBACK').catch(() => undefined)
        await session.release().catch(() => undefined)
      }
    } else if (isSqliteConnection(connection)) {
      // A separate read-only worker; EXPLAIN QUERY PLAN, never plain EXPLAIN.
      const reader = await connection.openReader()
      try {
        const { value } = await withTimeout(
          timeout,
          () => reader.call('query', `EXPLAIN QUERY PLAN ${statement}`, []),
          () => reader.kill()
        )
        const depth = new Map<number, number>()
        const lines = (value.rows as Record<string, unknown>[]).map((r) => {
          const level = (depth.get(Number(r.parent)) ?? -1) + 1
          depth.set(Number(r.id), level)
          return `${'  '.repeat(level)}${String(r.detail ?? '')}`
        })
        plan = lines.join('\n') || '(sin plan)'
      } finally {
        await reader.close().catch(() => undefined)
      }
    } else if (isMysqlFamily(connection)) {
      const session = await rt.manager.acquire(id, args.database?.trim() || null)
      try {
        await session.execute('START TRANSACTION READ ONLY')
        const threadId = session.threadId
        const { value } = await withTimeout(
          timeout,
          () => session.query<Record<string, unknown>>(`EXPLAIN ${statement}`),
          () => killMysqlQuery(rt, id, threadId)
        )
        plan = formatPlan(value)
      } finally {
        await session.query('ROLLBACK').catch(() => undefined)
        await session.release().catch(() => undefined)
      }
    } else throw new McpToolError('Este motor no admite explain_query.')
  } catch (err) {
    if (err instanceof McpToolError) throw err
    throw new McpToolError(c.redact(messageOf(err)), 'error')
  }
  return { data: { plan: cutText(plan, 20_000) } }
}

/* ---------- execute_sql ---------- */

function statementOut(
  r: QueryStatementResult,
  index: number,
  c: ResolvedConnection,
  limit: number,
  budget: ResponseBudget
): Record<string, unknown> {
  let result: TableOut | null = null
  if (r.resultSet)
    result = tableOut(r.resultSet.columns, r.resultSet.rows, limit, {
      ...(r.storage ? { storage: r.storage } : {}),
      moreRows: r.resultSet.truncated,
      budget
    })
  return {
    index,
    sql: cutText(r.sql.trim(), 200),
    duration_ms: r.durationMs,
    ...(r.affectedRows !== null ? { affected_rows: r.affectedRows } : {}),
    ...(r.changedRows !== null ? { changed_rows: r.changedRows } : {}),
    ...(r.insertId ? { insert_id: r.insertId } : {}),
    ...(r.warnings ? { warnings: r.warnings } : {}),
    ...(r.notices?.length ? { notices: r.notices.map((n) => c.redact(cutText(n, 500))) } : {}),
    ...(result ? { result } : {}),
    ...(r.error ? { error: c.redact(r.error) } : {})
  }
}

const SCRIPT_STOPPED = 'No se ejecutó: el script superó el tiempo límite.'

/** SQLite statements an agent never runs, also at the write level: they reach other files. */
const SQLITE_FILE_STATEMENTS = new Set(['ATTACH', 'DETACH', 'VACUUM'])
export const SQLITE_FILE_REFUSED =
  'ATTACH, DETACH y VACUUM no están disponibles para agentes: abren, copian o escriben otros archivos. Las bases de datos adjuntas se configuran en Vortaq (editar la conexión).'

function assertNoSqliteFileStatements(sql: string): void {
  for (const statement of getDialect('sqlite').splitStatements(sql))
    if (SQLITE_FILE_STATEMENTS.has(leadingWord('sqlite', statement.sql)))
      throw new McpToolError(SQLITE_FILE_REFUSED)
}

export async function executeSql(
  rt: McpRuntime,
  c: ResolvedConnection,
  args: QueryArgs
): Promise<ToolOutput> {
  if (c.config.engine === 'mongodb') return runMongo(rt, c, args, true)
  const sql = typeof args.sql === 'string' ? args.sql : ''
  if (!sql.trim()) throw new McpToolError('Falta el SQL («sql»).')
  if (c.config.engine === 'sqlite') assertNoSqliteFileStatements(sql)
  const limit = resolveRowLimit(args.max_rows)
  const timeout = resolveTimeoutMs(args.timeout_seconds)
  const id = c.config.id
  let results: QueryStatementResult[]
  let timedOut = false
  try {
    if (isMysqlEngine(c)) {
      // db:execute's MySQL path (open first: the server flavour picks the splitter), on a
      // session of our own so a timeout can KILL QUERY its thread.
      if (!rt.manager.isOpen(id)) await rt.manager.open(id)
      // Main's production guard, never confirmed from here.
      assertScriptAllowed(rt.ctx, id, sql, undefined)
      const session = await rt.manager.acquire(id, null)
      try {
        const dialect =
          c.config.engine === 'mariadb' || isMariaDbSession(session) ? mariadbDialect : mysqlDialect
        const threadId = session.threadId
        // KILL QUERY stops the statement running at that moment; `stopped` keeps the loop
        // from starting the next one (a kill between two statements would be lost).
        let stopped = false
        const run = await withTimeout(
          timeout,
          () =>
            executeScript(
              {
                useSchema: (schema) => session.useSchema(schema),
                runStatement: (statement, maxRows) => {
                  if (stopped) throw new McpToolError(SCRIPT_STOPPED, 'timeout')
                  return session.runStatement(statement, maxRows)
                },
                toResult: toStatementResult,
                describeError: (err) =>
                  err instanceof McpToolError ? err.message : describeMysqlError(err)
              },
              dialect,
              sql,
              { schema: args.database?.trim() || null, maxRows: limit, stopOnError: true },
              limit
            ),
          () => {
            stopped = true
            return killMysqlQuery(rt, id, threadId)
          }
        )
        results = run.value
        timedOut = run.timedOut
      } finally {
        await session.release().catch(() => undefined)
      }
    } else {
      const executionId = randomUUID()
      const schema =
        c.config.engine === 'postgresql'
          ? { database: pgDatabase(c, args.database), schema: args.schema?.trim() ?? '' }
          : args.database?.trim() || null
      const run = await withTimeout(
        timeout,
        () =>
          rt.invoke('db:execute', id, sql, {
            schema,
            executionId,
            maxRows: limit,
            stopOnError: true
          }),
        () => rt.invoke('db:cancel', id, executionId)
      )
      results = run.value
      timedOut = run.timedOut
    }
  } catch (err) {
    if (err instanceof McpToolError) throw err
    throw new McpToolError(c.redact(messageOf(err)), 'error')
  }
  const budget = new ResponseBudget()
  const statements = results.map((r, i) => statementOut(r, i + 1, c, limit, budget))
  const rows = statements.reduce(
    (n, s) => n + (((s.result as TableOut | undefined)?.row_count as number | undefined) ?? 0),
    0
  )
  const failed = results.some((r) => r.error)
  return {
    data: {
      statements,
      autocommit: true,
      ...(failed ? { stopped_at_error: true } : {}),
      ...(timedOut
        ? {
            timed_out: true,
            note: `El script superó ${Math.round(timeout / 1000)} s: se canceló la sentencia en curso; las anteriores ya se habían confirmado.`
          }
        : {})
    },
    rows
  }
}
