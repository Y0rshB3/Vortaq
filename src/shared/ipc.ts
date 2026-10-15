import type {
  AppInfo,
  AppLicenses,
  AppSettings,
  ApplyRowChangesResult,
  BackupCreateOptions,
  BackupCreateResult,
  BackupFile,
  BackupMeta,
  ColumnInfo,
  ConnectionConfig,
  ConnectionInput,
  ConnectionTestResult,
  DataTypeInfo,
  DatabaseInfo,
  EngineObjectType,
  EventInfo,
  ExtensionInfo,
  Job,
  JobInput,
  McpLaunchInfo,
  JobPackageSummary,
  JobLogEvent,
  JobRun,
  LogEvent,
  NavicatCandidatesResult,
  NavicatConnectionPreview,
  NavicatDetection,
  NavicatImportRequest,
  NavicatImportResult,
  NavicatJobPreview,
  NameRef,
  ObjectSummary,
  ProgressEvent,
  QueryExecuteOptions,
  QueryStatementResult,
  RestoreOptions,
  RestoreResult,
  RollbackFilesSource,
  RollbackPlan,
  RollbackRequest,
  RoutineInfo,
  RowChange,
  SchemaInfo,
  SchemaRef,
  ServerInfo,
  SqliteAlterRequest,
  SqliteAlterResult,
  SqliteCopyResult,
  SqliteMaintenanceAction,
  SqliteMaintenanceResult,
  SqliteTableDependents,
  StartupNotice,
  TrashLegacyAppResult,
  TabSessionState,
  TableDataPage,
  TableDataRequest,
  TableFilter,
  TableFilterProfile,
  TableInfo,
  TableStructure,
  TriggerInfo,
  UpdateCheckResult,
  UpdateInstallState,
  WhatsNewInfo,
  UserInfo,
  ViewInfo,
  WriteOptions,
  MongoApplyResult,
  MongoCollectionDetails,
  MongoCollectionInfo,
  MongoCommandResult,
  MongoCreateCollectionOptions,
  MongoDocumentChange,
  MongoDocumentPage,
  MongoDocumentQuery,
  MongoExecuteOptions,
  MongoFieldStat,
  MongoIndexSpec,
  MongoValidatorInput
} from './types'
import type {
  AiChatRequest,
  AiChatStart,
  AiContextPreview,
  AiContextRequest,
  AiConversation,
  AiConversationInput,
  AiConversationSummary,
  AiDeltaEvent,
  AiDoneEvent,
  AiProviderInput,
  AiProviderView,
  AiStatusEvent,
  AiTestResult
} from './ai'
import type { TourState } from './tour'
import type { ExportQueryRequest, ExportResult, ExportRowsRequest } from './export/types'
import type {
  BackupFormat,
  ImportConnectionsPreview,
  ImportConnectionsRequest,
  ImportConnectionsResult,
  ImportSourceId,
  ImportSourceInfo,
  SqlDumpImportOptions,
  SqlDumpImportResult,
  SqlDumpInspection,
  SqlExportOptions,
  SqlExportResult,
  SqlFolderImportRequest,
  SqlFolderImportResult,
  SqlFolderPreview
} from './importers'

/**
 * Request/response channels (ipcRenderer.invoke / ipcMain.handle).
 * Each key maps to { args, result }. Adding a channel here is enough for
 * preload and renderer typing.
 */
export interface IpcInvokeMap {
  'app:info': { args: []; result: AppInfo }
  'app:openPath': { args: [path: string]; result: void }
  'app:showInFolder': { args: [path: string]; result: void }
  'app:pickDirectory': { args: [title: string]; result: string | null }
  'app:pickFile': {
    args: [title: string, filters?: { name: string; extensions: string[] }[]]
    result: string | null
  }
  /** Save dialog for a new file: the chosen path, or null. It creates nothing. */
  'app:pickSaveFile': {
    args: [title: string, defaultName: string, filters?: { name: string; extensions: string[] }[]]
    result: string | null
  }
  /** One-off messages for the user after start (e.g. passwords to type again after the rename). */
  'app:startupNotices': { args: []; result: StartupNotice[] }
  'app:dismissStartupNotice': { args: [id: string]; result: void }
  /** Moves the ElectronDB app left installed to the Trash (main re-checks the paths). */
  'app:trashLegacyApp': { args: []; result: TrashLegacyAppResult }
  /**
   * Opens a URL in the default browser. Main only accepts this repository's
   * GitHub release pages and downloads (https://github.com/<owner>/<repo>/releases/...).
   */
  'app:openExternal': { args: [url: string]; result: void }
  /** «Acerca de Vortaq»: LICENSE and the third-party notices shipped with the app. */
  'app:licenses': { args: []; result: AppLicenses }
  /** Opens the project's repository page (fixed URL; the renderer passes nothing). */
  'app:openRepository': { args: []; result: void }
  /**
   * Ajustes › Agentes (MCP): how an MCP client starts this copy in MCP mode
   * (executable and arguments built from process.execPath; nothing is written).
   */
  'app:mcpLaunch': { args: []; result: McpLaunchInfo }

  /** Looks for a newer GitHub release. Automatic checks (manual=false) use a 6-hour cache. */
  'updates:check': { args: [manual: boolean]; result: UpdateCheckResult }
  /** «Omitir esta versión»: no automatic notice for that version. */
  'updates:dismiss': { args: [version: string]; result: void }
  /** «Más tarde»: no automatic update popup for the next 6 hours. */
  'updates:snooze': { args: []; result: void }
  /** «Novedades» to show once after an update (null: nothing to show). */
  'updates:whatsNew': { args: []; result: WhatsNewInfo | null }
  /** The «novedades» popup of `version` was closed. */
  'updates:markSeen': { args: [version: string]; result: void }
  /** Current in-app download/installation state (also pushed as event:updateInstall). */
  'updates:installState': { args: []; result: UpdateInstallState }
  /**
   * «Descargar y actualizar»: starts downloading `version` (or the newer one the update feed
   * offers) inside the app. Resolves when the download starts; progress arrives as events.
   */
  'updates:download': { args: [version: string]; result: UpdateInstallState }
  /** Cancels the running download (the partial file is discarded). */
  'updates:cancelDownload': { args: []; result: UpdateInstallState }
  /**
   * «Reiniciar y actualizar»: Windows/Linux quit, install silently and start the new version;
   * macOS opens the downloaded .dmg again.
   */
  'updates:install': { args: []; result: void }

  'settings:get': { args: []; result: AppSettings }
  'settings:update': { args: [patch: Partial<AppSettings>]; result: AppSettings }

  'connections:list': { args: []; result: ConnectionConfig[] }
  'connections:get': { args: [id: string]; result: ConnectionConfig | null }
  'connections:save': { args: [input: ConnectionInput]; result: ConnectionConfig }
  'connections:delete': { args: [id: string]; result: void }
  'connections:test': {
    args: [input: ConnectionInput, password: string | null, sshPassword: string | null]
    result: ConnectionTestResult
  }
  'connections:setPassword': { args: [id: string, password: string | null]; result: void }
  'connections:hasPassword': { args: [id: string]; result: boolean }
  'connections:setSshPassword': { args: [id: string, password: string | null]; result: void }
  'connections:hasSshPassword': { args: [id: string]; result: boolean }
  /** PostgreSQL SSL client-key passphrase (CredentialStore 'sslKey'); null removes it. */
  'connections:setSslKeyPassword': { args: [id: string, password: string | null]; result: void }
  'connections:hasSslKeyPassword': { args: [id: string]; result: boolean }
  'connections:open': { args: [id: string]; result: ServerInfo }
  'connections:close': { args: [id: string]; result: void }
  'connections:isOpen': { args: [id: string]; result: boolean }

  /*
   * `schema: SchemaRef`: a plain string is the MySQL database (unchanged); PostgreSQL needs
   * `{ database, schema }` and main rejects a plain string for it.
   */
  'db:databases': { args: [connectionId: string]; result: DatabaseInfo[] }
  'db:tables': { args: [connectionId: string, schema: SchemaRef]; result: TableInfo[] }
  'db:views': { args: [connectionId: string, schema: SchemaRef]; result: ViewInfo[] }
  'db:routines': { args: [connectionId: string, schema: SchemaRef]; result: RoutineInfo[] }
  'db:events': { args: [connectionId: string, schema: SchemaRef]; result: EventInfo[] }
  'db:triggers': { args: [connectionId: string, schema: SchemaRef]; result: TriggerInfo[] }
  'db:columns': {
    args: [connectionId: string, schema: SchemaRef, table: string]
    result: ColumnInfo[]
  }
  'db:tableStructure': {
    args: [connectionId: string, schema: SchemaRef, table: string]
    result: TableStructure
  }
  /** DDL of an object. PostgreSQL routines pass `{ type, name, signature }` (overloads). */
  'db:showCreate': {
    args: [connectionId: string, schema: SchemaRef, type: EngineObjectType, name: NameRef]
    result: string
  }
  /** PostgreSQL: schemas of one database (hidden system schemas unless showSystemSchemas). */
  'db:schemas': { args: [connectionId: string, database: string]; result: SchemaInfo[] }
  /** Objects of a group without its own channel (materialized views, sequences, types…). */
  'db:objects': {
    args: [connectionId: string, schema: SchemaRef, type: EngineObjectType]
    result: ObjectSummary[]
  }
  /**
   * PostgreSQL: closes the pool of one database (and its idle query-tab sessions); the
   * next use opens it again. Refused for the initial database and while a tab of that
   * database has an open transaction.
   */
  'db:closeDatabase': { args: [connectionId: string, database: string]; result: void }
  /** PostgreSQL: installed extensions of a database (read-only list). */
  'db:extensions': { args: [connectionId: string, database: string]; result: ExtensionInfo[] }
  /** PostgreSQL: data types for the designer's type picker (pg_type at runtime). */
  'db:dataTypes': { args: [connectionId: string, database: string]; result: DataTypeInfo[] }
  /** Stops a running `db:execute` started with this executionId; false when none is running. */
  'db:cancel': { args: [connectionId: string, executionId: string]; result: boolean }
  /** Tab sessions: state of the query tab's session (closed => open: false). */
  'db:sessionState': {
    args: [connectionId: string, sessionKey: string]
    result: TabSessionState
  }
  /** Tab sessions: COMMIT of the tab's open transaction (a write under the production guard). */
  'db:commit': {
    args: [connectionId: string, sessionKey: string, options?: WriteOptions]
    result: TabSessionState
  }
  /** Tab sessions: ROLLBACK of the tab's open (or failed) transaction. */
  'db:rollback': {
    args: [connectionId: string, sessionKey: string]
    result: TabSessionState
  }
  /** Tab sessions: closes the tab's session (an open transaction is rolled back). */
  'db:closeSession': { args: [connectionId: string, sessionKey: string]; result: void }
  'db:tableData': { args: [connectionId: string, request: TableDataRequest]; result: TableDataPage }
  /** Saved filter profiles of one table (userData/filter-profiles.json). */
  'filters:list': {
    args: [connectionId: string, schema: SchemaRef, table: string]
    result: TableFilterProfile[]
  }
  /** Creates or replaces the profile `name`; returns the table's profiles. */
  'filters:save': {
    args: [
      connectionId: string,
      schema: SchemaRef,
      table: string,
      name: string,
      filter: TableFilter
    ]
    result: TableFilterProfile[]
  }
  'filters:delete': {
    args: [connectionId: string, schema: SchemaRef, table: string, name: string]
    result: TableFilterProfile[]
  }
  /** WHERE text (without the keyword) main would run for a structured filter; '' when empty. */
  'db:tableFilterSql': {
    args: [connectionId: string, schema: SchemaRef, table: string, filter: TableFilter]
    result: string
  }
  'db:applyRowChanges': {
    args: [
      connectionId: string,
      schema: SchemaRef,
      table: string,
      changes: RowChange[],
      options?: WriteOptions
    ]
    result: ApplyRowChangesResult
  }
  'db:execute': {
    args: [connectionId: string, sql: string, options?: QueryExecuteOptions]
    result: QueryStatementResult[]
  }
  'db:users': { args: [connectionId: string]; result: UserInfo[] }
  'db:dropObject': {
    args: [
      connectionId: string,
      schema: SchemaRef,
      type: EngineObjectType,
      name: NameRef,
      options?: WriteOptions
    ]
    result: void
  }
  /**
   * MySQL: charset and collation. PostgreSQL ignores them and reads `engineOptions`
   * (owner, template, encoding).
   */
  'db:createDatabase': {
    args: [
      connectionId: string,
      name: string,
      charset: string,
      collation: string,
      options?: WriteOptions,
      engineOptions?: Record<string, string>
    ]
    result: void
  }
  'db:dropDatabase': {
    args: [connectionId: string, name: string, options?: WriteOptions]
    result: void
  }
  'db:charsets': {
    args: [connectionId: string]
    result: { charset: string; defaultCollation: string; collations: string[] }[]
  }

  /*
   * SQLite files (P3). A connection is a database file: opening never creates
   * one; only «Crear base de datos nueva» (sqlite:createFile) does.
   */
  /** Creates an empty SQLite database at `filePath` (refused when the file exists). */
  'sqlite:createFile': {
    args: [filePath: string]
    result: { filePath: string; sqliteVersion: string }
  }
  /** «Reabrir en modo escritura»: reopens a read-only connection read-write for this session. */
  'sqlite:reopenWritable': {
    args: [connectionId: string, options?: WriteOptions]
    result: ServerInfo
  }
  /** «Copiar archivo»: VACUUM INTO a new file (a consistent copy, refused when the target exists). */
  'sqlite:copyFile': {
    args: [connectionId: string, targetPath: string]
    result: SqliteCopyResult
  }
  /** Integrity / quick / foreign key check (reads), VACUUM and optimize (writes under the guard). */
  'sqlite:maintenance': {
    args: [connectionId: string, action: SqliteMaintenanceAction, options?: WriteOptions]
    result: SqliteMaintenanceResult
  }
  /** Table designer: triggers and views a rebuild recreates, the AUTOINCREMENT mark and foreign_keys. */
  'sqlite:tableDependents': {
    args: [connectionId: string, schema: string, table: string]
    result: SqliteTableDependents
  }
  /** Table designer: creates, alters in place or rebuilds a table in one transaction. */
  'sqlite:alterTable': {
    args: [
      connectionId: string,
      schema: string,
      request: SqliteAlterRequest,
      options?: WriteOptions
    ]
    result: SqliteAlterResult
  }

  /*
   * MongoDB (docs/multi-engine-design.md, 7.2). Documents and values travel as
   * canonical EJSON text; filters, sorts, projections and editor scripts use
   * shell syntax and are parsed in main (never eval'd). Every write takes
   * WriteOptions and goes through the production guard.
   */
  /** Collections, views and time-series collections of a database, with $collStats columns. */
  'mongo:collections': {
    args: [connectionId: string, database: string]
    result: MongoCollectionInfo[]
  }
  /** Indexes, validator and options of a collection (read-only). */
  'mongo:collectionDetails': {
    args: [connectionId: string, database: string, collection: string]
    result: MongoCollectionDetails
  }
  /** Collection browser page (filter/sort/projection, skip/limit). */
  'mongo:find': {
    args: [connectionId: string, query: MongoDocumentQuery]
    result: MongoDocumentPage
  }
  /** «Cargar más»: next documents of an open cursor (find, aggregate or query tab result). */
  'mongo:getMore': {
    args: [connectionId: string, resultId: string, count: number]
    result: MongoDocumentPage
  }
  /** Closes an open cursor the view no longer needs. */
  'mongo:closeCursor': { args: [connectionId: string, resultId: string]; result: void }
  /** One whole document by `_id` (canonical EJSON of the id), or null when it is gone. */
  'mongo:document': {
    args: [connectionId: string, database: string, collection: string, id: string]
    result: string | null
  }
  /** Inline and editor changes by `_id` (replace only of documents fetched whole). */
  'mongo:applyChanges': {
    args: [
      connectionId: string,
      database: string,
      collection: string,
      changes: MongoDocumentChange[],
      options?: WriteOptions
    ]
    result: MongoApplyResult
  }
  /** Field paths and BSON types of a $sample of the collection (no values). */
  'mongo:sampleFields': {
    args: [connectionId: string, database: string, collection: string, size?: number]
    result: MongoFieldStat[]
  }
  /** Query tab: runs a shell-syntax script (whitelisted grammar) statement by statement. */
  'mongo:execute': {
    args: [connectionId: string, script: string, options: MongoExecuteOptions]
    result: MongoCommandResult[]
  }
  /** Starts a transaction on the tab's session (replica sets and sharded clusters). */
  'mongo:beginTransaction': {
    args: [connectionId: string, sessionKey: string]
    result: TabSessionState
  }
  'mongo:createCollection': {
    args: [
      connectionId: string,
      database: string,
      name: string,
      options: MongoCreateCollectionOptions,
      writeOptions?: WriteOptions
    ]
    result: void
  }
  'mongo:renameCollection': {
    args: [
      connectionId: string,
      database: string,
      from: string,
      to: string,
      writeOptions?: WriteOptions
    ]
    result: void
  }
  /**
   * «Duplicar colección»: a new collection with the options and indexes of
   * `source` (and its documents with `includeDocuments`); views copy their pipeline.
   */
  'mongo:duplicateCollection': {
    args: [
      connectionId: string,
      database: string,
      source: string,
      target: string,
      includeDocuments: boolean,
      writeOptions?: WriteOptions
    ]
    result: { documents: number; indexes: number; warnings: string[] }
  }
  /** «Vaciar»: deleteMany({}); resolves the number of documents deleted. */
  'mongo:clearCollection': {
    args: [connectionId: string, database: string, collection: string, writeOptions?: WriteOptions]
    result: number
  }
  /** «Contar exacto»: countDocuments({}). */
  'mongo:countDocuments': {
    args: [connectionId: string, database: string, collection: string]
    result: number
  }
  /** Creates an index; resolves its name. */
  'mongo:createIndex': {
    args: [
      connectionId: string,
      database: string,
      collection: string,
      spec: MongoIndexSpec,
      writeOptions?: WriteOptions
    ]
    result: string
  }
  'mongo:dropIndex': {
    args: [
      connectionId: string,
      database: string,
      collection: string,
      name: string,
      writeOptions?: WriteOptions
    ]
    result: void
  }
  /** Validator ($jsonSchema or query operators), level and action (collMod). */
  'mongo:setValidator': {
    args: [
      connectionId: string,
      database: string,
      collection: string,
      input: MongoValidatorInput,
      writeOptions?: WriteOptions
    ]
    result: void
  }

  'backups:list': { args: [connectionId: string, schema?: string | null]; result: BackupFile[] }
  /** An encrypted .vqb without `password` answers its locked header meta; a wrong password throws. */
  'backups:meta': { args: [path: string, password?: string | null]; result: BackupMeta }
  'backups:objectDdl': {
    args: [path: string, uuid: string, password?: string | null]
    result: string
  }
  'backups:create': {
    args: [operationId: string, options: BackupCreateOptions]
    result: BackupCreateResult
  }
  'backups:restore': { args: [operationId: string, options: RestoreOptions]; result: RestoreResult }
  'backups:delete': { args: [path: string]; result: void }
  'backups:cancel': { args: [operationId: string]; result: void }
  /**
   * Pre-backup check: on a MariaDB server, the warning that names the system-versioned
   * tables and sequences a .nb3 of `schema` leaves out; null on MySQL or when there are none.
   */
  'backups:skippedObjects': {
    args: [connectionId: string, schema: string, format?: BackupFormat]
    result: string | null
  }
  /** Plain .sql dump of one schema (mysqldump-compatible); cancelled with backups:cancel. */
  'backups:exportSql': {
    args: [operationId: string, options: SqlExportOptions]
    result: SqlExportResult
  }

  'jobs:list': { args: []; result: Job[] }
  'jobs:get': { args: [id: string]; result: Job | null }
  'jobs:save': { args: [input: JobInput, options?: WriteOptions]; result: Job }
  'jobs:delete': { args: [id: string]; result: void }
  'jobs:run': { args: [id: string, options?: WriteOptions]; result: JobRun }
  'jobs:cancel': { args: [runId: string]; result: void }
  'jobs:runs': { args: [jobId: string | null, limit?: number]; result: JobRun[] }
  'jobs:runLog': { args: [runId: string]; result: string }
  /**
   * Latest backup package of every job that makes restorable copies (names,
   * dates and paths from the run history; no archive is opened): the
   * «Restauración» list of the job editor and its «Restaurar paquete» steps.
   */
  'jobs:packages': { args: []; result: JobPackageSummary[] }
  'jobs:scheduleStatus': {
    args: [id: string]
    result: { inApp: boolean; launchAgent: boolean; nextRun: string | null }
  }
  /**
   * Backups «Restaurar todo» would restore into `targetConnectionId`: those of a
   * finished run (its id) or the given backup files (a package of the backups list).
   */
  'jobs:rollbackPlan': {
    args: [
      source: string | RollbackFilesSource,
      targetConnectionId: string | null,
      /** Opens encrypted .vqb copies the job's stored password does not open. */
      password?: string | null
    ]
    result: RollbackPlan
  }
  /** Starts the restore of a run's backups (REPLACE semantics); resolves with the new run. */
  'jobs:rollback': { args: [request: RollbackRequest, options?: WriteOptions]; result: JobRun }

  'navicat:detect': { args: [rootPath?: string | null]; result: NavicatDetection }
  'navicat:previewConnections': {
    args: [rootPath?: string | null]
    result: NavicatConnectionPreview[]
  }
  'navicat:previewJobs': { args: [rootPath?: string | null]; result: NavicatJobPreview[] }
  'navicat:import': {
    args: [request: NavicatImportRequest, rootPath?: string | null]
    result: NavicatImportResult
  }
  /**
   * Looks for Navicat data folders in the usual places of this OS (read-only,
   * no network, nothing cached). Only folders whose Common/conn.plist parses.
   */
  'navicat:findCandidates': { args: []; result: NavicatCandidatesResult }

  /*
   * «Importar…» wizard (src/main/importers). Files and folders are always ones the user
   * picks; .ncx passwords are decoded only from a file picked with importers:pick.
   */
  /** Sources of the wizard, with the usual file location found on this computer. */
  'importers:sources': { args: []; result: ImportSourceInfo[] }
  /** Native file/folder dialog for a source; main remembers the picked path. */
  'importers:pick': { args: [source: ImportSourceId]; result: string | null }
  'importers:previewConnections': {
    args: [source: ImportSourceId, path: string]
    result: ImportConnectionsPreview
  }
  'importers:importConnections': {
    args: [request: ImportConnectionsRequest]
    result: ImportConnectionsResult
  }
  /** Quick scan of a .sql / .sql.gz file (header, databases, rough counts). */
  'importers:inspectSqlDump': { args: [path: string]; result: SqlDumpInspection }
  /** Runs a dump statement by statement; progress as event:progress (kind 'import'). */
  'importers:importSqlDump': {
    args: [operationId: string, options: SqlDumpImportOptions]
    result: SqlDumpImportResult
  }
  'importers:previewSqlFolder': { args: [dir: string]; result: SqlFolderPreview }
  'importers:importSqlFolder': {
    args: [operationId: string, request: SqlFolderImportRequest]
    result: SqlFolderImportResult
  }
  'importers:cancel': { args: [operationId: string]; result: void }

  /*
   * Copy and export of results (src/main/export). The renderer picks the file with
   * app:pickSaveFile; main writes `<file>.part` and renames it once complete.
   */
  /** «Exportar» of rows the renderer holds (loaded rows or the grid selection). */
  'export:rows': { args: [request: ExportRowsRequest]; result: ExportResult }
  /**
   * «Exportar resultado completo»: re-runs one read-only statement (or the table view's
   * SELECT without paging) in a new read-only session and streams every row to the file.
   * Progress as event:progress (kind 'export'); refused for anything that may write.
   */
  'export:query': {
    args: [operationId: string, request: ExportQueryRequest]
    result: ExportResult
  }
  /** Stops a running export:query (server-side too) and deletes its partial file. */
  'export:cancel': { args: [operationId: string]; result: void }

  /** Onboarding state; decides once per profile whether the welcome tour is due. */
  'tour:state': { args: []; result: TourState }
  /** The welcome tour was finished or skipped (also after a replay). */
  'tour:markWelcomeDone': { args: []; result: TourState }

  /*
   * AI assistant (bring your own key). Keys go renderer -> main only: no channel
   * returns a key. Requests and the model's answers never contain row data.
   */
  'ai:providers': { args: []; result: AiProviderView[] }
  'ai:saveProvider': { args: [input: AiProviderInput]; result: AiProviderView }
  'ai:deleteProvider': { args: [id: string]; result: void }
  /** Minimal request with the stored key, or with `key` when given (not saved). */
  'ai:testProvider': {
    args: [input: AiProviderInput, key: string | null]
    result: AiTestResult
  }
  /** Stores (or with null/'' removes) the provider's API key in CredentialStore. */
  'ai:setKey': { args: [id: string, key: string | null]; result: void }
  'ai:hasKey': { args: [id: string]; result: boolean }
  /** Model IDs reported by the provider (`key` as in test); [] when it cannot list them. */
  'ai:listModels': { args: [input: AiProviderInput, key: string | null]; result: string[] }
  /** Starts a streamed answer; text arrives as event:aiDelta, the end as event:aiDone. */
  'ai:chat': { args: [request: AiChatRequest]; result: AiChatStart }
  'ai:cancel': { args: [requestId: string]; result: void }
  'ai:conversations': { args: [connectionId: string]; result: AiConversationSummary[] }
  'ai:conversation': {
    args: [connectionId: string, id: string]
    result: AiConversation | null
  }
  'ai:saveConversation': { args: [input: AiConversationInput]; result: AiConversation }
  'ai:deleteConversation': { args: [connectionId: string, id: string]; result: void }
  /** «Memoria»: notes of a connection (schema null) or of one of its databases. */
  'ai:memory': { args: [connectionId: string, schema: string | null]; result: string }
  'ai:setMemory': {
    args: [connectionId: string, schema: string | null, text: string]
    result: void
  }
  /** Exact instructions + context that a request would send («Ver contexto enviado»). */
  'ai:contextPreview': { args: [request: AiContextRequest]; result: AiContextPreview }
}

export type IpcChannel = keyof IpcInvokeMap
export type IpcArgs<C extends IpcChannel> = IpcInvokeMap[C]['args']
export type IpcResult<C extends IpcChannel> = IpcInvokeMap[C]['result']

/** Push channels (main -> renderer). */
export interface IpcEventMap {
  'event:progress': ProgressEvent
  'event:jobRun': JobRun
  'event:log': LogEvent
  'event:connectionClosed': { connectionId: string; reason: string }
  'event:jobLog': JobLogEvent
  /** App menu «Buscar actualizaciones…»: the renderer opens its updates dialog. */
  'event:checkUpdates': null
  /** Progress and result of the in-app update download. */
  'event:updateInstall': UpdateInstallState
  /** Streamed text of an AI answer. */
  'event:aiDelta': AiDeltaEvent
  /** Progress note of an AI request (fetching more structure…). */
  'event:aiStatus': AiStatusEvent
  /** End of an AI answer (done, refused, cancelled or failed). */
  'event:aiDone': AiDoneEvent
}

export type IpcEventChannel = keyof IpcEventMap

export const IPC_INVOKE_CHANNELS: readonly IpcChannel[] = [
  'app:info',
  'app:openPath',
  'app:showInFolder',
  'app:pickDirectory',
  'app:pickFile',
  'app:pickSaveFile',
  'app:startupNotices',
  'app:dismissStartupNotice',
  'app:trashLegacyApp',
  'app:openExternal',
  'app:licenses',
  'app:openRepository',
  'app:mcpLaunch',
  'updates:check',
  'updates:dismiss',
  'updates:snooze',
  'updates:whatsNew',
  'updates:markSeen',
  'updates:installState',
  'updates:download',
  'updates:cancelDownload',
  'updates:install',
  'settings:get',
  'settings:update',
  'connections:list',
  'connections:get',
  'connections:save',
  'connections:delete',
  'connections:test',
  'connections:setPassword',
  'connections:hasPassword',
  'connections:setSshPassword',
  'connections:hasSshPassword',
  'connections:setSslKeyPassword',
  'connections:hasSslKeyPassword',
  'connections:open',
  'connections:close',
  'connections:isOpen',
  'db:databases',
  'db:tables',
  'db:views',
  'db:routines',
  'db:events',
  'db:triggers',
  'db:columns',
  'db:tableStructure',
  'db:showCreate',
  'db:schemas',
  'db:objects',
  'db:closeDatabase',
  'db:extensions',
  'db:dataTypes',
  'db:cancel',
  'db:sessionState',
  'db:commit',
  'db:rollback',
  'db:closeSession',
  'db:tableData',
  'db:tableFilterSql',
  'filters:list',
  'filters:save',
  'filters:delete',
  'db:applyRowChanges',
  'db:execute',
  'db:users',
  'db:dropObject',
  'db:createDatabase',
  'db:dropDatabase',
  'db:charsets',
  'sqlite:createFile',
  'sqlite:reopenWritable',
  'sqlite:copyFile',
  'sqlite:maintenance',
  'sqlite:tableDependents',
  'sqlite:alterTable',
  'mongo:collections',
  'mongo:collectionDetails',
  'mongo:find',
  'mongo:getMore',
  'mongo:closeCursor',
  'mongo:document',
  'mongo:applyChanges',
  'mongo:sampleFields',
  'mongo:execute',
  'mongo:beginTransaction',
  'mongo:createCollection',
  'mongo:renameCollection',
  'mongo:duplicateCollection',
  'mongo:clearCollection',
  'mongo:countDocuments',
  'mongo:createIndex',
  'mongo:dropIndex',
  'mongo:setValidator',
  'backups:list',
  'backups:meta',
  'backups:objectDdl',
  'backups:create',
  'backups:restore',
  'backups:delete',
  'backups:cancel',
  'backups:exportSql',
  'backups:skippedObjects',
  'jobs:list',
  'jobs:get',
  'jobs:save',
  'jobs:delete',
  'jobs:run',
  'jobs:cancel',
  'jobs:runs',
  'jobs:runLog',
  'jobs:packages',
  'jobs:scheduleStatus',
  'jobs:rollbackPlan',
  'jobs:rollback',
  'navicat:detect',
  'navicat:previewConnections',
  'navicat:previewJobs',
  'navicat:import',
  'navicat:findCandidates',
  'importers:sources',
  'importers:pick',
  'importers:previewConnections',
  'importers:importConnections',
  'importers:inspectSqlDump',
  'importers:importSqlDump',
  'importers:previewSqlFolder',
  'importers:importSqlFolder',
  'importers:cancel',
  'export:rows',
  'export:query',
  'export:cancel',
  'tour:state',
  'tour:markWelcomeDone',
  'ai:providers',
  'ai:saveProvider',
  'ai:deleteProvider',
  'ai:testProvider',
  'ai:setKey',
  'ai:hasKey',
  'ai:listModels',
  'ai:chat',
  'ai:cancel',
  'ai:conversations',
  'ai:conversation',
  'ai:saveConversation',
  'ai:deleteConversation',
  'ai:memory',
  'ai:setMemory',
  'ai:contextPreview'
] as const

export const IPC_EVENT_CHANNELS: readonly IpcEventChannel[] = [
  'event:progress',
  'event:jobRun',
  'event:log',
  'event:connectionClosed',
  'event:jobLog',
  'event:checkUpdates',
  'event:updateInstall',
  'event:aiDelta',
  'event:aiStatus',
  'event:aiDone'
] as const

/** Typed API surface exposed on window.vortaq by the preload script. */
export interface VortaqApi {
  /** Host OS (process.platform: 'darwin', 'win32', 'linux'…), for OS-specific UI. */
  readonly platform: string
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>>
  on<E extends IpcEventChannel>(channel: E, listener: (payload: IpcEventMap[E]) => void): () => void
}
