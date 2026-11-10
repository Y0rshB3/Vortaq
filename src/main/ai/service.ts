import type { MsSession } from '../sqlserver/session'
import {
  AI_PROVIDER_PRESETS,
  type AiChatRequest,
  type AiChatStart,
  type AiContextPreview,
  type AiContextRequest,
  type AiDoneEvent,
  type AiMode,
  type AiProviderInput,
  type AiProviderProfile,
  type AiProviderView,
  type AiTestResult
} from '@shared/ai'
import type { AppSettings, EngineId, Environment } from '@shared/types'
import { isSystemSchema } from '@shared/restoreTask'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { CredentialStore } from '../credentials/store'
import { newId } from '../storage/ids'
import type { ChatAdapter, FetchFn } from './adapter'
import { AnthropicAdapter } from './anthropic'
import {
  DATABASES_WORDING,
  MAX_CONTEXT_DATABASES,
  buildConnectionContext,
  buildMemoryBlock,
  buildSchemaContext,
  formatTable,
  type ScopeWording
} from './context'
import { explainSelect, isSingleSelect } from './explain'
import {
  PgMetadataQueryable,
  explainPgSelect,
  isSinglePgSelect,
  readPgSchemaNames,
  readPgSchemaSnapshot
} from './pgMetadata'
import {
  MsMetadataQueryable,
  explainMsSelect,
  isSingleMsSelect,
  readMsSchemaNames,
  readMsSchemaSnapshot
} from './msMetadata'
import {
  SqliteMetadataQueryable,
  explainSqliteSelect,
  isSingleSqliteSelect,
  readSqliteDatabaseNames,
  readSqliteSchemaSnapshot
} from './sqliteMetadata'
import {
  MetadataQueryable,
  readSchemaSnapshot,
  type Queryable,
  type SchemaSnapshot
} from './metadata'
import {
  MONGO_ENGINE_NOTE,
  MONGO_SYSTEM_DATABASES,
  readMongoSnapshot,
  type MongoStructureSource
} from './mongoMetadata'
import { OpenAiCompatAdapter } from './openaiCompat'
import { buildUserMessage, SYSTEM_INSTRUCTIONS, trimHistory } from './prompts'
import { AiProvidersRepo, normalizeProviderInput } from './providers'
import { AiConversationsRepo, AiMemoryRepo } from './store'
import type { TableStructureInput, ToolExecutor } from './tools'

/** A database session borrowed for one operation. */
export interface BorrowedSession extends Queryable {
  release(): Promise<void>
}

export interface AiLogger {
  info(message: string): void
  warn(message: string): void
}

export interface AiServiceDeps {
  userDataPath: string
  credentials: CredentialStore
  settings: { get(): AppSettings }
  /** Environment of a connection (shown to the model so it is careful with production). */
  environmentOf(connectionId: string): Environment | null
  acquire(connectionId: string, schema: string | null): Promise<BorrowedSession>
  /** True for PostgreSQL connections (structure comes from pg_catalog, see pgMetadata.ts). */
  isPostgres?(connectionId: string): boolean
  /** A pooled PostgreSQL session of `database` (null = the initial database). */
  acquirePg?(connectionId: string, database: string | null): Promise<BorrowedSession>
  /** True for SQLite connections (structure comes from sqlite_schema, see sqliteMetadata.ts). */
  isSqlite?(connectionId: string): boolean
  /** A session on the SQLite connection's shared handle. */
  acquireSqlite?(connectionId: string): Promise<BorrowedSession>
  /** True for SQL Server connections (structure from sys.* catalog views, see msMetadata.ts). */
  isSqlServer?(connectionId: string): boolean
  /** A pooled SQL Server session of `database` (null = the initial database). */
  acquireMs?(connectionId: string, database: string | null): Promise<MsSession>
  /** True for MongoDB connections (structure from mongoMetadata.ts, never documents). */
  isMongo?(connectionId: string): boolean
  /** The structure-only source of a MongoDB connection. */
  mongoSource?(connectionId: string): Promise<MongoStructureSource>
  /** Engine of a connection (MariaDB gets its own note). */
  engineOf?(connectionId: string): EngineId | null
  emit<E extends IpcEventChannel>(channel: E, payload: IpcEventMap[E]): void
  log: AiLogger
  fetch?: FetchFn
  /** Replaces the real adapters (tests, VORTAQ_AI_FIXTURE). */
  adapterFactory?: (profile: AiProviderProfile, key: string | null) => ChatAdapter
  /** Snapshot cache lifetime (ms). */
  snapshotTtlMs?: number
  /** SDK retries on 429/5xx/connection errors. */
  maxRetries?: number
}

const ENV_LABEL: Record<Environment, string> = {
  local: 'Local',
  staging: 'Staging',
  production: 'Producción',
  other: 'Otro'
}

const MODES: readonly AiMode[] = ['chat', 'generateSql', 'explain', 'explainError']

/** Collections sampled across a whole MongoDB connection (each costs a $sample). */
const MONGO_CONNECTION_SAMPLE_BUDGET = 120

/** Context line for MariaDB connections (the system instructions speak of MySQL). */
export const MARIADB_ENGINE_NOTE =
  'Motor: MariaDB. Escribe SQL de MariaDB: secuencias (NEXT VALUE FOR s, NEXTVAL(s), SETVAL(s, n)), INSERT/DELETE … RETURNING, tablas versionadas (FOR SYSTEM_TIME AS OF / ALL), JSON es un alias de LONGTEXT (funciones JSON_VALUE, JSON_QUERY…), y UUID, INET4 e INET6 son tipos nativos.'

type Reader = 'mysql' | 'pg' | 'sqlite' | 'mongo' | 'ms'
const MAX_INPUT_CHARS = 20_000
const MAX_SQL_CHARS = 100_000

function requireString(value: unknown, what: string, max = 200): string {
  if (typeof value !== 'string' || !value || value.length > max)
    throw new Error(`${what} no válido.`)
  return value
}

function optionalText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return null
  return value.slice(0, max)
}

export class AiService {
  readonly providers: AiProvidersRepo
  readonly conversations: AiConversationsRepo
  readonly memory: AiMemoryRepo
  private readonly active = new Map<string, AbortController>()
  private readonly snapshots = new Map<string, { at: number; snap: SchemaSnapshot }>()

  constructor(private readonly deps: AiServiceDeps) {
    this.providers = new AiProvidersRepo(deps.userDataPath)
    this.conversations = new AiConversationsRepo(deps.userDataPath)
    this.memory = new AiMemoryRepo(deps.userDataPath)
  }

  /* ---------- providers & keys (keys never leave main) ---------- */

  listProviders(): AiProviderView[] {
    return this.providers
      .list()
      .map((p) => ({ ...p, hasKey: this.deps.credentials.has('ai', p.id) }))
  }

  saveProvider(input: AiProviderInput): AiProviderView {
    const saved = this.providers.save(input)
    return { ...saved, hasKey: this.deps.credentials.has('ai', saved.id) }
  }

  deleteProvider(id: string): void {
    requireString(id, 'Proveedor')
    this.providers.delete(id)
    this.deps.credentials.set('ai', id, null)
  }

  setKey(id: string, key: string | null): void {
    requireString(id, 'Proveedor')
    if (!this.providers.get(id)) throw new Error('El proveedor no existe.')
    const value = typeof key === 'string' ? key.trim() : ''
    if (value.length > 1000) throw new Error('La clave es demasiado larga.')
    this.deps.credentials.set('ai', id, value || null)
  }

  hasKey(id: string): boolean {
    return this.deps.credentials.has('ai', id)
  }

  private adapterFor(profile: AiProviderProfile, key: string | null): ChatAdapter {
    if (this.deps.adapterFactory) return this.deps.adapterFactory(profile, key)
    if (profile.type === 'anthropic')
      return new AnthropicAdapter({
        apiKey: key ?? '',
        fetch: this.deps.fetch,
        maxRetries: this.deps.maxRetries
      })
    return new OpenAiCompatAdapter({
      type: profile.type,
      baseUrl: profile.baseUrl,
      apiKey: key,
      fetch: this.deps.fetch,
      maxRetries: this.deps.maxRetries
    })
  }

  /** Profile + key for test / listModels: the unsaved form, with the typed key or the stored one. */
  private draft(
    input: AiProviderInput,
    key: string | null
  ): { profile: AiProviderProfile; key: string | null } {
    const clean = normalizeProviderInput(input)
    const stored = clean.id ? this.deps.credentials.get('ai', clean.id) : null
    const typed = typeof key === 'string' && key.trim() ? key.trim() : null
    const profile: AiProviderProfile = {
      id: clean.id ?? 'draft',
      name: clean.name,
      type: clean.type,
      baseUrl: clean.baseUrl,
      model: clean.model,
      createdAt: '',
      updatedAt: ''
    }
    return { profile, key: typed ?? stored }
  }

  async testProvider(input: AiProviderInput, key: string | null): Promise<AiTestResult> {
    const { profile, key: secret } = this.draft(input, key)
    if (AI_PROVIDER_PRESETS[profile.type].keyRequired && !secret && !this.deps.adapterFactory)
      return { ok: false, message: 'Escribe la clave API antes de probar.' }
    const result = await this.adapterFor(profile, secret).test(profile.model)
    this.deps.log.info(`ai: provider test (${profile.type}) ${result.ok ? 'ok' : 'failed'}`)
    return result
  }

  async listModels(input: AiProviderInput, key: string | null): Promise<string[]> {
    const { profile, key: secret } = this.draft({ ...input, model: input.model || 'list' }, key)
    if (AI_PROVIDER_PRESETS[profile.type].keyRequired && !secret && !this.deps.adapterFactory)
      throw new Error('Escribe la clave API para cargar los modelos.')
    return this.adapterFor(profile, secret).listModels()
  }

  /* ---------- context ---------- */

  private isPg(connectionId: string): boolean {
    return this.deps.isPostgres?.(connectionId) === true && !!this.deps.acquirePg
  }

  private isMs(connectionId: string): boolean {
    return this.deps.isSqlServer?.(connectionId) === true && !!this.deps.acquireMs
  }

  /** SQL Server: the same structure-only rule over sys.* (MsMetadataQueryable). */
  private async withMsMetadata<T>(
    connectionId: string,
    database: string | null,
    fn: (q: MsMetadataQueryable) => Promise<T>
  ): Promise<T> {
    const session = await this.deps.acquireMs!(connectionId, database)
    try {
      return await fn(new MsMetadataQueryable(session))
    } finally {
      await session.release().catch(() => undefined)
    }
  }

  private isMongo(connectionId: string): boolean {
    return this.deps.isMongo?.(connectionId) === true && !!this.deps.mongoSource
  }

  private isLite(connectionId: string): boolean {
    return this.deps.isSqlite?.(connectionId) === true && !!this.deps.acquireSqlite
  }

  /** SQLite: the same structure-only rule over sqlite_schema (SqliteMetadataQueryable). */
  private async withSqliteMetadata<T>(
    connectionId: string,
    fn: (q: SqliteMetadataQueryable) => Promise<T>
  ): Promise<T> {
    const session = await this.deps.acquireSqlite!(connectionId)
    try {
      return await fn(new SqliteMetadataQueryable(session))
    } finally {
      await session.release().catch(() => undefined)
    }
  }

  /** PostgreSQL: the same structure-only rule over pg_catalog (PgMetadataQueryable). */
  private async withPgMetadata<T>(
    connectionId: string,
    database: string | null,
    fn: (q: PgMetadataQueryable) => Promise<T>
  ): Promise<T> {
    const session = await this.deps.acquirePg!(connectionId, database)
    try {
      return await fn(new PgMetadataQueryable(session))
    } finally {
      await session.release().catch(() => undefined)
    }
  }

  private async withMetadata<T>(
    connectionId: string,
    fn: (q: MetadataQueryable) => Promise<T>
  ): Promise<T> {
    const session = await this.deps.acquire(connectionId, null)
    try {
      // Structure only: the wrapper refuses anything but information_schema.
      return await fn(new MetadataQueryable(session))
    } finally {
      await session.release().catch(() => undefined)
    }
  }

  private readerOf(connectionId: string): Reader {
    if (this.isMongo(connectionId)) return 'mongo'
    if (this.isPg(connectionId)) return 'pg'
    if (this.isMs(connectionId)) return 'ms'
    if (this.isLite(connectionId)) return 'sqlite'
    return 'mysql'
  }

  /**
   * User namespaces «Toda la conexión» covers, sorted, system ones left out:
   * the databases of a MySQL/MariaDB/MongoDB server, the schemas of the
   * current PostgreSQL database, SQLite main and its attachments (not temp).
   */
  private async namespaces(connectionId: string, database: string | null): Promise<string[]> {
    switch (this.readerOf(connectionId)) {
      case 'mongo':
        return (await (await this.deps.mongoSource!(connectionId)).databases())
          .filter((n) => !MONGO_SYSTEM_DATABASES.has(n))
          .sort()
      case 'pg':
        return this.withPgMetadata(connectionId, database, (q) => readPgSchemaNames(q))
      case 'ms':
        return this.withMsMetadata(connectionId, database, (q) => readMsSchemaNames(q))
      case 'sqlite':
        return (
          await this.withSqliteMetadata(connectionId, (q) => readSqliteDatabaseNames(q))
        ).filter((n) => n !== 'temp')
      default:
        return (
          await this.withMetadata(connectionId, async (q) =>
            (
              await q.query<{ name: string }>(
                'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME'
              )
            ).map((r) => String(r.name))
          )
        ).filter((n) => !isSystemSchema(n))
    }
  }

  /** PostgreSQL: name of the database a request reads (the initial one when none is given). */
  private async pgDatabaseName(connectionId: string, database: string | null): Promise<string> {
    if (database) return database
    const rows = await this.withPgMetadata(connectionId, null, (q) =>
      q.query<{ name: string }>(
        'SELECT d.datname AS name FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()'
      )
    )
    return String(rows[0]?.name ?? '')
  }

  /** SQL Server: name of the database a request reads (the initial one when none is given). */
  private async msDatabaseName(connectionId: string, database: string | null): Promise<string> {
    if (database) return database
    const rows = await this.withMsMetadata(connectionId, null, (q) =>
      q.query<{ name: string }>('SELECT d.name FROM sys.databases d WHERE d.database_id = DB_ID()')
    )
    return String(rows[0]?.name ?? '')
  }

  /** Words of a whole-connection context for the connection's engine. */
  private async wordingOf(connectionId: string, database: string | null): Promise<ScopeWording> {
    switch (this.readerOf(connectionId)) {
      case 'mongo':
        return { ...DATABASES_WORDING, qualified: 'base.colección' }
      case 'pg': {
        const db = await this.pgDatabaseName(connectionId, database)
        return {
          whole: `Base de datos ${db} completa (todos sus esquemas; PostgreSQL no consulta las demás bases de datos de la conexión)`,
          plural: 'esquemas',
          selected: 'Esquema seleccionado',
          qualified: 'esquema.tabla',
          others: 'Otros esquemas'
        }
      }
      case 'ms': {
        const db = await this.msDatabaseName(connectionId, database)
        return {
          whole: `Base de datos ${db} completa (todos sus esquemas; las demás bases de datos de la conexión no se incluyen)`,
          plural: 'esquemas',
          selected: 'Esquema seleccionado',
          qualified: 'esquema.tabla',
          others: 'Otros esquemas'
        }
      }
      case 'sqlite':
        return {
          whole: 'Archivo completo (main y sus bases de datos adjuntas)',
          plural: 'bases de datos',
          selected: 'Base de datos seleccionada',
          qualified: 'base.tabla',
          others: 'Otras bases de datos'
        }
      default:
        return DATABASES_WORDING
    }
  }

  /** «Otras … (solo el nombre)» line of a single-namespace context. */
  private async othersLine(
    connectionId: string,
    database: string | null,
    others: string[]
  ): Promise<string> {
    const tail = `(solo el nombre; pide su estructura con get_table_structure si la pregunta los necesita): ${others.join(', ')}.`
    switch (this.readerOf(connectionId)) {
      case 'pg':
        return `Otros esquemas de la base de datos ${await this.pgDatabaseName(connectionId, database)} ${tail}`
      case 'ms':
        return `Otros esquemas de la base de datos ${await this.msDatabaseName(connectionId, database)} ${tail}`
      case 'sqlite':
        return `Otras bases de datos del archivo (main y adjuntas) ${tail}`
      default:
        return `Otras bases de datos de esta conexión ${tail}`
    }
  }

  /**
   * Snapshots of several namespaces: cached ones reused, the rest read in one
   * metadata session (MongoDB: through its structure source, sharing a
   * sampling budget when there are several databases).
   */
  private async readSnapshots(
    connectionId: string,
    schemas: string[],
    fresh = false,
    database: string | null = null
  ): Promise<SchemaSnapshot[]> {
    const reader = this.readerOf(connectionId)
    const mongoLimit =
      reader === 'mongo' && schemas.length > 1
        ? Math.max(3, Math.floor(MONGO_CONNECTION_SAMPLE_BUDGET / schemas.length))
        : null
    const keyOf = (schema: string): string =>
      `${connectionId}\u0000${database ?? ''}\u0000${schema}${mongoLimit ? `\u0000${mongoLimit}` : ''}`
    const ttl = this.deps.snapshotTtlMs ?? 5 * 60_000
    const now = Date.now()
    const out = new Map<string, SchemaSnapshot>()
    const missing: string[] = []
    for (const schema of schemas) {
      const hit = this.snapshots.get(keyOf(schema))
      if (!fresh && hit && now - hit.at < ttl) out.set(schema, hit.snap)
      else missing.push(schema)
    }
    const keep = (schema: string, snap: SchemaSnapshot): void => {
      this.snapshots.set(keyOf(schema), { at: Date.now(), snap })
      out.set(schema, snap)
    }
    if (missing.length) {
      if (reader === 'mongo') {
        const source = await this.deps.mongoSource!(connectionId)
        for (const schema of missing)
          keep(schema, await readMongoSnapshot(source, schema, undefined, mongoLimit ?? undefined))
      } else if (reader === 'pg') {
        await this.withPgMetadata(connectionId, database, async (q) => {
          for (const schema of missing) keep(schema, await readPgSchemaSnapshot(q, schema))
        })
      } else if (reader === 'ms') {
        await this.withMsMetadata(connectionId, database, async (q) => {
          for (const schema of missing) keep(schema, await readMsSchemaSnapshot(q, schema))
        })
      } else if (reader === 'sqlite') {
        await this.withSqliteMetadata(connectionId, async (q) => {
          for (const schema of missing) keep(schema, await readSqliteSchemaSnapshot(q, schema))
        })
      } else {
        await this.withMetadata(connectionId, async (q) => {
          for (const schema of missing) keep(schema, await readSchemaSnapshot(q, schema))
        })
      }
    }
    return schemas.map((s) => out.get(s) as SchemaSnapshot)
  }

  /** Instructions + context text of a request. Deterministic for the same structure and notes. */
  async buildContext(
    request: AiContextRequest,
    options: { fresh?: boolean } = {}
  ): Promise<AiContextPreview> {
    const connectionId = requireString(request.connectionId, 'Conexión')
    const schema = typeof request.schema === 'string' && request.schema ? request.schema : null
    const database =
      typeof request.database === 'string' && request.database ? request.database : null
    // Without a selected namespace the assistant always sees the whole connection.
    const wholeConnection = !schema || request.scope === 'connection'
    const env = this.deps.environmentOf(connectionId)
    const parts: string[] = []
    if (env) parts.push(`Entorno de la conexión: ${ENV_LABEL[env]}.`)
    if (this.isMongo(connectionId)) parts.push(MONGO_ENGINE_NOTE)
    else if (this.deps.engineOf?.(connectionId) === 'mariadb') parts.push(MARIADB_ENGINE_NOTE)
    let truncated = false
    let tableCount = 0
    if (wholeConnection) {
      const names = await this.namespaces(connectionId, database)
      // The selected namespace always gets its structure, even past the limit.
      const ordered =
        schema && names.includes(schema) ? [schema, ...names.filter((n) => n !== schema)] : names
      const included = ordered.slice(0, MAX_CONTEXT_DATABASES).sort()
      const others = ordered.slice(MAX_CONTEXT_DATABASES).sort()
      const memory = buildMemoryBlock(
        this.memory.get(connectionId, null),
        included.map((s) => ({ schema: s, notes: this.memory.get(connectionId, s) }))
      )
      if (memory) parts.push(memory)
      const snaps = await this.readSnapshots(connectionId, included, options.fresh, database)
      const built = buildConnectionContext(snaps, schema, {
        hints: [request.input, request.editorSql],
        openTable: request.openTable,
        otherDatabases: others,
        wording: await this.wordingOf(connectionId, database)
      })
      truncated = built.truncated || others.length > 0
      tableCount = built.tableCount
      parts.push(built.text)
    } else {
      const memory = buildMemoryBlock(
        this.memory.get(connectionId, null),
        this.memory.get(connectionId, schema),
        schema
      )
      if (memory) parts.push(memory)
      const [snap] = await this.readSnapshots(connectionId, [schema], options.fresh, database)
      const built = buildSchemaContext(snap, {
        hints: [request.input, request.editorSql],
        openTable: request.openTable
      })
      truncated = built.truncated
      tableCount = built.tableCount
      parts.push(built.text)
      const others = (await this.namespaces(connectionId, database)).filter((n) => n !== schema)
      if (others.length) parts.push(await this.othersLine(connectionId, database, others))
    }
    const context = parts.join('\n\n')
    return {
      instructions: SYSTEM_INSTRUCTIONS,
      context,
      chars: SYSTEM_INSTRUCTIONS.length + context.length,
      truncated,
      tableCount
    }
  }

  /** get_table_structure: structure of the requested tables, read on demand (never rows). */
  private toolFor(connectionId: string, database: string | null = null): ToolExecutor {
    return async (input: TableStructureInput) => {
      const snap = this.isMongo(connectionId)
        ? await readMongoSnapshot(
            await this.deps.mongoSource!(connectionId),
            input.schema,
            input.tables
          )
        : this.isPg(connectionId)
          ? await this.withPgMetadata(connectionId, database, (q) =>
              readPgSchemaSnapshot(q, input.schema, input.tables)
            )
          : this.isMs(connectionId)
            ? await this.withMsMetadata(connectionId, database, (q) =>
                readMsSchemaSnapshot(q, input.schema, input.tables)
              )
            : this.isLite(connectionId)
              ? await this.withSqliteMetadata(connectionId, (q) =>
                  readSqliteSchemaSnapshot(q, input.schema, input.tables)
                )
              : await this.withMetadata(connectionId, (q) =>
                  readSchemaSnapshot(q, input.schema, input.tables)
                )
      const found = new Set(snap.tables.map((t) => t.name))
      const lines = snap.tables.map((t) => formatTable(t, input.schema))
      const missing = input.tables.filter((t) => !found.has(t))
      if (missing.length) lines.push(`No existen en ${input.schema}: ${missing.join(', ')}`)
      return lines.join('\n') || `No se encontraron tablas en ${input.schema}.`
    }
  }

  /* ---------- chat ---------- */

  private resolveProvider(providerId: string | null): AiProviderProfile {
    const settings = this.deps.settings.get()
    if (!settings.aiEnabled)
      throw new Error('El asistente de IA está desactivado. Actívalo en Ajustes › IA.')
    const list = this.providers.list()
    const wanted = providerId ?? settings.aiDefaultProviderId
    const profile = (wanted ? list.find((p) => p.id === wanted) : null) ?? list[0]
    if (!profile) throw new Error('Configura un proveedor de IA en Ajustes › IA.')
    return profile
  }

  private validate(raw: AiChatRequest): AiChatRequest {
    if (!raw || typeof raw !== 'object') throw new Error('Petición de IA no válida.')
    if (!MODES.includes(raw.mode)) throw new Error('Modo de IA no válido.')
    const input = typeof raw.input === 'string' ? raw.input : ''
    if (input.length > MAX_INPUT_CHARS)
      throw new Error(`La pregunta es demasiado larga (máx. ${MAX_INPUT_CHARS} caracteres).`)
    const sql = optionalText(raw.sql, MAX_SQL_CHARS + 1)
    if (sql && sql.length > MAX_SQL_CHARS)
      throw new Error('El SQL es demasiado largo para enviarlo al asistente.')
    if (raw.mode === 'chat' || raw.mode === 'generateSql') {
      if (!input.trim()) throw new Error('Escribe una pregunta.')
    } else if (!sql?.trim()) throw new Error('No hay SQL que explicar.')
    return {
      providerId: typeof raw.providerId === 'string' && raw.providerId ? raw.providerId : null,
      connectionId: requireString(raw.connectionId, 'Conexión'),
      schema: typeof raw.schema === 'string' && raw.schema ? raw.schema : null,
      database: typeof raw.database === 'string' && raw.database ? raw.database : null,
      scope: raw.scope === 'connection' ? 'connection' : 'database',
      mode: raw.mode,
      history: Array.isArray(raw.history) ? raw.history : [],
      input,
      sql,
      error: optionalText(raw.error, 10_000),
      editorSql: optionalText(raw.editorSql, MAX_SQL_CHARS),
      openTable: optionalText(raw.openTable, 64)
    }
  }

  /** Starts a streamed answer. Validation problems throw; later failures arrive as event:aiDone. */
  startChat(raw: AiChatRequest): AiChatStart {
    const request = this.validate(raw)
    const profile = this.resolveProvider(request.providerId)
    const key = this.deps.credentials.get('ai', profile.id)
    if (AI_PROVIDER_PRESETS[profile.type].keyRequired && !key && !this.deps.adapterFactory)
      throw new Error(`Falta la clave API de «${profile.name}». Añádela en Ajustes › IA.`)
    const requestId = newId()
    const controller = new AbortController()
    this.active.set(requestId, controller)
    // Starts after the IPC reply so the renderer knows the id before the first event.
    setTimeout(() => {
      void this.run(requestId, request, profile, key, controller).finally(() =>
        this.active.delete(requestId)
      )
    }, 0)
    return { requestId }
  }

  cancel(requestId: string): void {
    this.active.get(requestId)?.abort()
  }

  /** Aborts every running request (app quit). */
  cancelAll(): void {
    for (const c of this.active.values()) c.abort()
  }

  private done(event: AiDoneEvent): void {
    this.deps.emit('event:aiDone', event)
  }

  private async run(
    requestId: string,
    request: AiChatRequest,
    profile: AiProviderProfile,
    key: string | null,
    controller: AbortController
  ): Promise<void> {
    const { log } = this.deps
    const settings = this.deps.settings.get()
    log.info(`ai: request ${requestId} (${profile.type}, ${profile.model}, ${request.mode})`)
    try {
      this.deps.emit('event:aiStatus', { requestId, status: 'Leyendo la estructura…' })
      const preview = await this.buildContext({
        connectionId: request.connectionId,
        schema: request.schema,
        database: request.database ?? null,
        scope: request.scope,
        input: request.input,
        editorSql: request.mode === 'chat' ? request.editorSql : (request.sql ?? request.editorSql),
        openTable: request.openTable
      })
      let plan: string | null = null
      const mongo = this.isMongo(request.connectionId)
      if (mongo) {
        // MongoDB: no plan is fetched (explain would run the user's pipeline stages).
      } else if (this.isPg(request.connectionId)) {
        if (request.mode === 'explain' && isSinglePgSelect(request.sql)) {
          // EXPLAIN (plan only, never ANALYZE) of one read-only SELECT; nothing else is executed.
          this.deps.emit('event:aiStatus', { requestId, status: 'Obteniendo el plan (EXPLAIN)…' })
          const session = await this.deps.acquirePg!(request.connectionId, request.database ?? null)
          try {
            if (request.schema)
              await session.query('SELECT pg_catalog.set_config($1, $2, false)', [
                'search_path',
                `"${request.schema.replace(/"/g, '""')}", public`
              ])
            plan = await explainPgSelect(session, request.sql ?? '')
          } finally {
            await session.release().catch(() => undefined)
          }
        }
      } else if (this.isMs(request.connectionId)) {
        if (request.mode === 'explain' && isSingleMsSelect(request.sql)) {
          // Estimated plan (SHOWPLAN_TEXT compiles the SELECT, never runs it).
          this.deps.emit('event:aiStatus', { requestId, status: 'Obteniendo el plan estimado…' })
          const session = await this.deps.acquireMs!(request.connectionId, request.database ?? null)
          try {
            plan = await explainMsSelect(session, request.sql ?? '')
          } finally {
            await session.release().catch(() => undefined)
          }
        }
      } else if (this.isLite(request.connectionId)) {
        if (request.mode === 'explain' && isSingleSqliteSelect(request.sql)) {
          // EXPLAIN QUERY PLAN (never plain EXPLAIN) of one read-only SELECT; nothing else runs.
          this.deps.emit('event:aiStatus', {
            requestId,
            status: 'Obteniendo el plan (EXPLAIN QUERY PLAN)…'
          })
          const session = await this.deps.acquireSqlite!(request.connectionId)
          try {
            plan = await explainSqliteSelect(session, request.sql ?? '')
          } finally {
            await session.release().catch(() => undefined)
          }
        }
      } else if (request.mode === 'explain' && isSingleSelect(request.sql)) {
        // EXPLAIN only for one SELECT (explainSelect checks it); nothing else is executed.
        this.deps.emit('event:aiStatus', { requestId, status: 'Obteniendo el plan (EXPLAIN)…' })
        const session = await this.deps.acquire(request.connectionId, request.schema)
        try {
          plan = await explainSelect(session, request.sql ?? '')
        } finally {
          await session.release().catch(() => undefined)
        }
      }
      if (controller.signal.aborted) {
        this.done({ requestId, stopReason: 'cancelled' })
        return
      }
      this.deps.emit('event:aiStatus', { requestId, status: '' })
      const adapter = this.adapterFor(profile, key)
      const result = await adapter.chat(
        {
          model: profile.model,
          instructions: preview.instructions,
          context: preview.context,
          history: trimHistory(request.history),
          userMessage: buildUserMessage(
            request,
            plan,
            mongo
              ? 'mongodb'
              : this.isPg(request.connectionId)
                ? 'postgresql'
                : this.isMs(request.connectionId)
                  ? 'sqlserver'
                  : this.isLite(request.connectionId)
                    ? 'sqlite'
                    : undefined
          ),
          effort: settings.aiEffort,
          maxTokens: settings.aiMaxTokens,
          signal: controller.signal,
          tool: this.toolFor(request.connectionId, request.database ?? null)
        },
        {
          onText: (text) => this.deps.emit('event:aiDelta', { requestId, text }),
          onStatus: (status) => this.deps.emit('event:aiStatus', { requestId, status })
        }
      )
      if (result.stopReason === 'error') log.warn(`ai: request ${requestId} failed`)
      this.done({
        requestId,
        stopReason: result.stopReason,
        usage: result.usage,
        error: result.error,
        model: result.model
      })
    } catch (err) {
      log.warn(`ai: request ${requestId} could not start`)
      this.done({
        requestId,
        stopReason: controller.signal.aborted ? 'cancelled' : 'error',
        error: controller.signal.aborted
          ? undefined
          : `No se pudo preparar la petición: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  }
}
