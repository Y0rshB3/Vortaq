import type { IpcArgs, IpcChannel, IpcEventChannel, IpcEventMap, IpcResult } from '@shared/ipc'
import type {
  BackupCreateOptions,
  ConnectionInput,
  JobInput,
  EngineObjectType,
  MongoCreateCollectionOptions,
  MongoDocumentChange,
  MongoDocumentQuery,
  MongoExecuteOptions,
  MongoIndexSpec,
  MongoValidatorInput,
  NameRef,
  NavicatImportRequest,
  QueryExecuteOptions,
  RestoreOptions,
  RollbackFilesSource,
  RollbackRequest,
  RowChange,
  SchemaRef,
  SqliteMaintenanceAction,
  TableDataRequest,
  TableFilter,
  WriteOptions
} from '@shared/types'
import type {
  AiChatRequest,
  AiContextRequest,
  AiConversationInput,
  AiProviderInput
} from '@shared/ai'
import type {
  ImportConnectionsRequest,
  ImportSourceId,
  SqlDumpImportOptions,
  SqlExportOptions,
  SqlFolderImportRequest
} from '@shared/importers'
import type { ExportQueryRequest, ExportRowsRequest } from '@shared/export/types'
import { errorMessage, useNotify } from './composables/useNotify'
import { toPlain } from './utils/toPlain'

export class ApiError extends Error {
  channel: string
  /** True once the error has been shown to the user (see `invoke`). */
  notified = false
  constructor(channel: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.channel = channel
  }
}

function bridge() {
  if (!window.vortaq) throw new Error('El puente IPC no está disponible (window.vortaq)')
  return window.vortaq
}

/** Invoke without reporting errors to the global snackbar. */
export async function invokeSilent<C extends IpcChannel>(
  channel: C,
  ...args: IpcArgs<C>
): Promise<IpcResult<C>> {
  try {
    return await bridge().invoke(channel, ...(args.map((a) => toPlain(a)) as IpcArgs<C>))
  } catch (err) {
    throw new ApiError(channel, errorMessage(err))
  }
}

/** Invoke and surface failures in the global snackbar before rethrowing. */
export async function invoke<C extends IpcChannel>(
  channel: C,
  ...args: IpcArgs<C>
): Promise<IpcResult<C>> {
  try {
    return await invokeSilent(channel, ...args)
  } catch (err) {
    useNotify().error(errorMessage(err))
    if (err instanceof ApiError) err.notified = true
    throw err
  }
}

export function on<E extends IpcEventChannel>(
  channel: E,
  listener: (payload: IpcEventMap[E]) => void
): () => void {
  return bridge().on(channel, listener)
}

export function newOperationId(prefix = 'op'): string {
  const rnd = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : Math.random().toString(36).slice(2)
  return `${prefix}-${rnd}`
}

export const api = {
  invoke,
  invokeSilent,
  on,
  app: {
    info: () => invoke('app:info'),
    openPath: (path: string) => invoke('app:openPath', path),
    showInFolder: (path: string) => invoke('app:showInFolder', path),
    pickDirectory: (title: string) => invoke('app:pickDirectory', title),
    pickFile: (title: string, filters?: { name: string; extensions: string[] }[]) =>
      invoke('app:pickFile', title, filters),
    pickSaveFile: (
      title: string,
      defaultName: string,
      filters?: { name: string; extensions: string[] }[]
    ) => invoke('app:pickSaveFile', title, defaultName, filters),
    startupNotices: () => invokeSilent('app:startupNotices'),
    dismissStartupNotice: (id: string) => invokeSilent('app:dismissStartupNotice', id),
    /** Moves the ElectronDB app left installed to the Trash (only on the user's click). */
    trashLegacyApp: () => invoke('app:trashLegacyApp'),
    /** Only GitHub release pages/downloads of Vortaq (main rejects anything else). */
    openExternal: (url: string) => invoke('app:openExternal', url),
    licenses: () => invoke('app:licenses'),
    openRepository: () => invoke('app:openRepository'),
    /** Ajustes › Agentes (MCP): the command an MCP client runs to start this copy. */
    mcpLaunch: () => invokeSilent('app:mcpLaunch')
  },
  tour: {
    state: () => invokeSilent('tour:state'),
    markWelcomeDone: () => invokeSilent('tour:markWelcomeDone')
  },
  updates: {
    /** Never throws for network problems: they come back as status 'error'. */
    check: (manual: boolean) => invokeSilent('updates:check', manual),
    dismiss: (version: string) => invoke('updates:dismiss', version),
    snooze: () => invokeSilent('updates:snooze'),
    whatsNew: () => invokeSilent('updates:whatsNew'),
    markSeen: (version: string) => invokeSilent('updates:markSeen', version),
    installState: () => invokeSilent('updates:installState'),
    /** Failures are shown inside the updates dialog (with «Descargar manualmente»). */
    download: (version: string) => invokeSilent('updates:download', version),
    cancelDownload: () => invokeSilent('updates:cancelDownload'),
    /** «Reiniciar y actualizar» (Windows/Linux) or «Abrir el instalador» (macOS). */
    install: () => invoke('updates:install')
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch: Parameters<typeof invoke<'settings:update'>>[1]) =>
      invoke('settings:update', patch)
  },
  connections: {
    list: () => invoke('connections:list'),
    get: (id: string) => invoke('connections:get', id),
    save: (input: ConnectionInput) => invoke('connections:save', input),
    delete: (id: string) => invoke('connections:delete', id),
    test: (input: ConnectionInput, password: string | null, sshPassword: string | null) =>
      invoke('connections:test', input, password, sshPassword),
    setPassword: (id: string, password: string | null) =>
      invoke('connections:setPassword', id, password),
    hasPassword: (id: string) => invokeSilent('connections:hasPassword', id),
    setSshPassword: (id: string, password: string | null) =>
      invoke('connections:setSshPassword', id, password),
    hasSshPassword: (id: string) => invokeSilent('connections:hasSshPassword', id),
    setSslKeyPassword: (id: string, password: string | null) =>
      invoke('connections:setSslKeyPassword', id, password),
    hasSslKeyPassword: (id: string) => invokeSilent('connections:hasSslKeyPassword', id),
    open: (id: string) => invoke('connections:open', id),
    close: (id: string) => invoke('connections:close', id),
    isOpen: (id: string) => invokeSilent('connections:isOpen', id)
  },
  /*
   * `s: SchemaRef`: the MySQL database name (string), or `{ database, schema }` on
   * PostgreSQL (build it with utils/schemaRef.ts `schemaRef(schema, database)`).
   */
  db: {
    databases: (c: string) => invokeSilent('db:databases', c),
    tables: (c: string, s: SchemaRef) => invokeSilent('db:tables', c, s),
    views: (c: string, s: SchemaRef) => invokeSilent('db:views', c, s),
    routines: (c: string, s: SchemaRef) => invokeSilent('db:routines', c, s),
    events: (c: string, s: SchemaRef) => invokeSilent('db:events', c, s),
    triggers: (c: string, s: SchemaRef) => invokeSilent('db:triggers', c, s),
    columns: (c: string, s: SchemaRef, t: string) => invoke('db:columns', c, s, t),
    tableStructure: (c: string, s: SchemaRef, t: string) => invoke('db:tableStructure', c, s, t),
    showCreate: (c: string, s: SchemaRef, type: EngineObjectType, name: NameRef) =>
      invoke('db:showCreate', c, s, type, name),
    /** PostgreSQL only. */
    schemas: (c: string, database: string) => invokeSilent('db:schemas', c, database),
    /** PostgreSQL only: materialized views, sequences, types, indexes… */
    objects: (c: string, s: SchemaRef, type: EngineObjectType) =>
      invokeSilent('db:objects', c, s, type),
    extensions: (c: string, database: string) => invokeSilent('db:extensions', c, database),
    closeDatabase: (c: string, database: string) => invokeSilent('db:closeDatabase', c, database),
    dataTypes: (c: string, database: string) => invokeSilent('db:dataTypes', c, database),
    cancel: (c: string, executionId: string) => invokeSilent('db:cancel', c, executionId),
    sessionState: (c: string, key: string) => invokeSilent('db:sessionState', c, key),
    commit: (c: string, key: string, options?: WriteOptions) =>
      invoke('db:commit', c, key, options),
    rollback: (c: string, key: string) => invoke('db:rollback', c, key),
    closeSession: (c: string, key: string) => invokeSilent('db:closeSession', c, key),
    tableData: (c: string, req: TableDataRequest) => invokeSilent('db:tableData', c, req),
    tableFilterSql: (c: string, s: SchemaRef, t: string, filter: TableFilter) =>
      invokeSilent('db:tableFilterSql', c, s, t, filter),
    filterProfiles: (c: string, s: SchemaRef, t: string) => invokeSilent('filters:list', c, s, t),
    saveFilterProfile: (c: string, s: SchemaRef, t: string, name: string, filter: TableFilter) =>
      invoke('filters:save', c, s, t, name, filter),
    deleteFilterProfile: (c: string, s: SchemaRef, t: string, name: string) =>
      invoke('filters:delete', c, s, t, name),
    applyRowChanges: (
      c: string,
      s: SchemaRef,
      t: string,
      changes: RowChange[],
      options?: WriteOptions
    ) => invoke('db:applyRowChanges', c, s, t, changes, options),
    execute: (c: string, sql: string, options?: QueryExecuteOptions) =>
      invoke('db:execute', c, sql, options),
    users: (c: string) => invoke('db:users', c),
    dropObject: (
      c: string,
      s: SchemaRef,
      type: EngineObjectType,
      name: NameRef,
      options?: WriteOptions
    ) => invoke('db:dropObject', c, s, type, name, options),
    createDatabase: (
      c: string,
      name: string,
      charset: string,
      collation: string,
      options?: WriteOptions,
      engineOptions?: Record<string, string>
    ) =>
      engineOptions
        ? invoke('db:createDatabase', c, name, charset, collation, options, engineOptions)
        : invoke('db:createDatabase', c, name, charset, collation, options),
    dropDatabase: (c: string, name: string, options?: WriteOptions) =>
      invoke('db:dropDatabase', c, name, options),
    charsets: (c: string) => invoke('db:charsets', c)
  },
  /** SQLite files (P3): new file, reopen read-write, VACUUM INTO copy, maintenance. */
  sqlite: {
    createFile: (filePath: string) => invoke('sqlite:createFile', filePath),
    reopenWritable: (connectionId: string, options?: WriteOptions) =>
      invoke('sqlite:reopenWritable', connectionId, options),
    copyFile: (connectionId: string, targetPath: string) =>
      invoke('sqlite:copyFile', connectionId, targetPath),
    maintenance: (connectionId: string, action: SqliteMaintenanceAction, options?: WriteOptions) =>
      invoke('sqlite:maintenance', connectionId, action, options)
  },
  /**
   * MongoDB (P4): documents travel as canonical EJSON text; filters and scripts
   * use shell syntax, parsed in main. Writes take WriteOptions (production guard).
   */
  mongo: {
    collections: (c: string, db: string) => invoke('mongo:collections', c, db),
    collectionDetails: (c: string, db: string, coll: string) =>
      invoke('mongo:collectionDetails', c, db, coll),
    /** Silent: the collection view shows parse errors next to the filter. */
    find: (c: string, query: MongoDocumentQuery) => invokeSilent('mongo:find', c, query),
    getMore: (c: string, resultId: string, count: number) =>
      invoke('mongo:getMore', c, resultId, count),
    closeCursor: (c: string, resultId: string) => invokeSilent('mongo:closeCursor', c, resultId),
    document: (c: string, db: string, coll: string, id: string) =>
      invoke('mongo:document', c, db, coll, id),
    applyChanges: (
      c: string,
      db: string,
      coll: string,
      changes: MongoDocumentChange[],
      options?: WriteOptions
    ) => invokeSilent('mongo:applyChanges', c, db, coll, changes, options),
    sampleFields: (c: string, db: string, coll: string, size?: number) =>
      invokeSilent('mongo:sampleFields', c, db, coll, size),
    /** Silent: the query tab shows its own errors. */
    execute: (c: string, script: string, options: MongoExecuteOptions) =>
      invokeSilent('mongo:execute', c, script, options),
    beginTransaction: (c: string, key: string) => invoke('mongo:beginTransaction', c, key),
    createCollection: (
      c: string,
      db: string,
      name: string,
      options: MongoCreateCollectionOptions,
      writeOptions?: WriteOptions
    ) => invoke('mongo:createCollection', c, db, name, options, writeOptions),
    renameCollection: (
      c: string,
      db: string,
      from: string,
      to: string,
      writeOptions?: WriteOptions
    ) => invoke('mongo:renameCollection', c, db, from, to, writeOptions),
    duplicateCollection: (
      c: string,
      db: string,
      source: string,
      target: string,
      includeDocuments: boolean,
      writeOptions?: WriteOptions
    ) => invoke('mongo:duplicateCollection', c, db, source, target, includeDocuments, writeOptions),
    clearCollection: (c: string, db: string, coll: string, writeOptions?: WriteOptions) =>
      invoke('mongo:clearCollection', c, db, coll, writeOptions),
    countDocuments: (c: string, db: string, coll: string) =>
      invoke('mongo:countDocuments', c, db, coll),
    createIndex: (
      c: string,
      db: string,
      coll: string,
      spec: MongoIndexSpec,
      writeOptions?: WriteOptions
    ) => invokeSilent('mongo:createIndex', c, db, coll, spec, writeOptions),
    dropIndex: (c: string, db: string, coll: string, name: string, writeOptions?: WriteOptions) =>
      invoke('mongo:dropIndex', c, db, coll, name, writeOptions),
    setValidator: (
      c: string,
      db: string,
      coll: string,
      input: MongoValidatorInput,
      writeOptions?: WriteOptions
    ) => invokeSilent('mongo:setValidator', c, db, coll, input, writeOptions)
  },
  backups: {
    list: (c: string, schema?: string | null) => invokeSilent('backups:list', c, schema),
    meta: (path: string) => invoke('backups:meta', path),
    /** Meta of an encrypted .vqb with its password (silent: the caller shows a wrong password inline). */
    unlockMeta: (path: string, password: string) => invokeSilent('backups:meta', path, password),
    objectDdl: (path: string, uuid: string, password?: string | null) =>
      password
        ? invoke('backups:objectDdl', path, uuid, password)
        : invoke('backups:objectDdl', path, uuid),
    create: (operationId: string, options: BackupCreateOptions) =>
      invoke('backups:create', operationId, options),
    restore: (operationId: string, options: RestoreOptions) =>
      invoke('backups:restore', operationId, options),
    delete: (path: string) => invoke('backups:delete', path),
    cancel: (operationId: string) => invoke('backups:cancel', operationId),
    exportSql: (operationId: string, options: SqlExportOptions) =>
      invokeSilent('backups:exportSql', operationId, options)
  },
  jobs: {
    list: () => invoke('jobs:list'),
    get: (id: string) => invoke('jobs:get', id),
    save: (input: JobInput, options?: WriteOptions) => invoke('jobs:save', input, options),
    delete: (id: string) => invoke('jobs:delete', id),
    run: (id: string, options?: WriteOptions) => invoke('jobs:run', id, options),
    cancel: (runId: string) => invoke('jobs:cancel', runId),
    runs: (jobId: string | null, limit?: number) => invoke('jobs:runs', jobId, limit),
    runLog: (runId: string) => invoke('jobs:runLog', runId),
    /** Latest backup package of every job (the «Restauración» list of the job editor). */
    packages: () => invokeSilent('jobs:packages'),
    scheduleStatus: (id: string) => invokeSilent('jobs:scheduleStatus', id),
    /** Plan of a run (its id) or of backup files picked in the backups list. */
    rollbackPlan: (
      source: string | RollbackFilesSource,
      targetConnectionId: string | null,
      password?: string | null
    ) =>
      password
        ? invokeSilent('jobs:rollbackPlan', source, targetConnectionId, password)
        : invokeSilent('jobs:rollbackPlan', source, targetConnectionId),
    rollback: (request: RollbackRequest, options?: WriteOptions) =>
      invokeSilent('jobs:rollback', request, options)
  },
  navicat: {
    detect: (rootPath?: string | null) => invoke('navicat:detect', rootPath),
    previewConnections: (rootPath?: string | null) =>
      invoke('navicat:previewConnections', rootPath),
    previewJobs: (rootPath?: string | null) => invoke('navicat:previewJobs', rootPath),
    import: (request: NavicatImportRequest, rootPath?: string | null) =>
      invoke('navicat:import', request, rootPath),
    /** Silent: an automatic search must never pop an error snackbar. */
    findCandidates: () => invokeSilent('navicat:findCandidates')
  },
  /** «Importar…» wizard: connection files, SQL dumps and dump folders. */
  importers: {
    sources: () => invoke('importers:sources'),
    pick: (source: ImportSourceId) => invoke('importers:pick', source),
    previewConnections: (source: ImportSourceId, path: string) =>
      invokeSilent('importers:previewConnections', source, path),
    importConnections: (request: ImportConnectionsRequest) =>
      invokeSilent('importers:importConnections', request),
    inspectSqlDump: (path: string) => invokeSilent('importers:inspectSqlDump', path),
    importSqlDump: (operationId: string, options: SqlDumpImportOptions) =>
      invokeSilent('importers:importSqlDump', operationId, options),
    previewSqlFolder: (dir: string) => invokeSilent('importers:previewSqlFolder', dir),
    importSqlFolder: (operationId: string, request: SqlFolderImportRequest) =>
      invokeSilent('importers:importSqlFolder', operationId, request),
    cancel: (operationId: string) => invoke('importers:cancel', operationId)
  },
  /** Copy/export of results: main writes the file chosen with app.pickSaveFile. */
  exports: {
    /** Silent: the export dialog shows the error next to its button. */
    rows: (request: ExportRowsRequest) => invokeSilent('export:rows', request),
    query: (operationId: string, request: ExportQueryRequest) =>
      invokeSilent('export:query', operationId, request),
    cancel: (operationId: string) => invoke('export:cancel', operationId)
  },
  /** AI assistant. Keys are only ever sent to main (setKey/test/listModels), never read back. */
  ai: {
    providers: () => invoke('ai:providers'),
    saveProvider: (input: AiProviderInput) => invoke('ai:saveProvider', input),
    deleteProvider: (id: string) => invoke('ai:deleteProvider', id),
    testProvider: (input: AiProviderInput, key: string | null) =>
      invokeSilent('ai:testProvider', input, key),
    setKey: (id: string, key: string | null) => invoke('ai:setKey', id, key),
    hasKey: (id: string) => invokeSilent('ai:hasKey', id),
    listModels: (input: AiProviderInput, key: string | null) =>
      invokeSilent('ai:listModels', input, key),
    chat: (request: AiChatRequest) => invokeSilent('ai:chat', request),
    cancel: (requestId: string) => invokeSilent('ai:cancel', requestId),
    conversations: (connectionId: string) => invokeSilent('ai:conversations', connectionId),
    conversation: (connectionId: string, id: string) =>
      invokeSilent('ai:conversation', connectionId, id),
    saveConversation: (input: AiConversationInput) => invoke('ai:saveConversation', input),
    deleteConversation: (connectionId: string, id: string) =>
      invoke('ai:deleteConversation', connectionId, id),
    memory: (connectionId: string, schema: string | null) =>
      invokeSilent('ai:memory', connectionId, schema),
    setMemory: (connectionId: string, schema: string | null, text: string) =>
      invoke('ai:setMemory', connectionId, schema, text),
    contextPreview: (request: AiContextRequest) => invokeSilent('ai:contextPreview', request)
  }
}
