/**
 * Shared domain types used by main, preload and renderer.
 * Keep this file free of Node/Electron/browser-only imports.
 */
import type { AiEffort } from './ai'
import type { WhatsNewEntry } from './whatsNew'
import type { BackupFormat } from './importers'

export type Environment = 'local' | 'staging' | 'production' | 'other'

/* ---------- Engines (multi-engine model; only 'mysql' ships today) ---------- */

/** Database engine of a connection. Fixed once the connection is saved. */
export type EngineId = 'mysql' | 'mariadb' | 'postgresql' | 'sqlite' | 'mongodb'

/** libpq names. 'allow' = try without TLS first, retry with TLS if the server refuses. */
export type SslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'

/** Network options shared by PostgreSQL and MongoDB (MySQL ignores them for now). */
export interface NetworkOptions {
  /** Connect / server-selection timeout. Default 10 000 (Mongo's own default is 30 s). */
  connectTimeoutMs: number
  /** TCP keepalive interval; 0 = off. Default 60. Also used for the SSH tunnel. */
  keepAliveSec: number
}

export interface PostgresOptions {
  /** Database opened first (Navicat "Initial Database"; default 'postgres'). */
  initialDatabase: string
  /** Show pg_catalog / information_schema / pg_toast schemas and template / no-connect databases. */
  showSystemSchemas: boolean
  /** Session TimeZone; '' = server default. */
  timeZone: string
  /**
   * search_path of every session ('' = the server's default), e.g. `app, public`. A query
   * tab's schema is put first and this list (or the server default) follows it.
   */
  searchPath: string
}

export interface SqliteAttachedDatabase {
  alias: string
  filePath: string
  pathNeedsReview?: boolean
}

export interface SqliteOptions {
  /** Absolute path of the main database file. Required. Must exist when opening. */
  filePath: string
  /**
   * Set by import when the path came from another OS or is not absolute here
   * (e.g. 'C:\\…' on macOS). The connection cannot open until the user picks a file.
   */
  pathNeedsReview?: boolean
  /** Open read-only. Default true when environment === 'production'. */
  readOnly: boolean
  /** PRAGMA foreign_keys at open. Default false for opened/imported files. */
  foreignKeys: boolean
  /** ATTACH DATABASE ? AS <quoted alias> on open (path bound as a parameter, must exist). */
  attached: SqliteAttachedDatabase[]
  /** Busy timeout for files other apps also have open. */
  busyTimeoutMs: number
}

export type MongoTopology = 'standalone' | 'replicaSet' | 'shardCluster'
export type MongoAuthMechanism =
  | 'default' // SCRAM negotiated
  | 'scram-sha-1'
  | 'scram-sha-256'
  | 'x509'
  | 'plain' // LDAP
  | 'none'
export type MongoReadPreference =
  'primary' | 'primaryPreferred' | 'secondary' | 'secondaryPreferred' | 'nearest'

export interface MongoOptions {
  topology: MongoTopology
  /** mongodb+srv:// using `host` as the SRV name (no port). */
  srv: boolean
  /** Seed list for replicaSet/shardCluster. Standalone uses host/port. */
  members: { host: string; port: number }[]
  replicaSet: string
  authMechanism: MongoAuthMechanism
  /** Authentication database (Navicat "Auth Source"; default 'admin'). */
  authSource: string
  /** Database opened by default in the tree and the query editor. */
  defaultDatabase: string
  readPreference: MongoReadPreference
  /** Forced to true when SSH is enabled (a tunnel forwards a single host). */
  directConnection: boolean
  /** Default true; forced false for DocumentDB and Cosmos DB service providers. */
  retryWrites: boolean
  retryReads: boolean
  /** Other non-secret URI options. Credential keys are rejected on save and import. */
  extraOptions: Record<string, string>
}

export type SshAuthType = 'password' | 'key'

export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  username: string
  authType: SshAuthType
  privateKeyPath?: string
  savePassword: boolean
}

/**
 * How the MySQL user authenticates.
 * - 'password': a password typed or stored in the CredentialStore (default).
 * - 'none': no password at all (local auth proxy such as Cloud SQL Auth Proxy,
 *   a user with an empty password, or client-certificate auth via SSL).
 */
export type MysqlAuthMode = 'password' | 'none'

export interface SslConfig {
  enabled: boolean
  caCertPath?: string
  clientCertPath?: string
  clientKeyPath?: string
  verifyServer: boolean
  /** PostgreSQL / MongoDB only. Absent => derived from `enabled` and `verifyServer`. */
  mode?: SslMode
}

export interface ConnectionConfig {
  id: string
  name: string
  /** Hex colour like #4bd67a, or null for none. */
  color: string | null
  environment: Environment
  host: string
  port: number
  username: string
  /** Missing on records saved before 0.1.8: treated as 'password'. */
  authMode?: MysqlAuthMode
  savePassword: boolean
  /** Restrict object tree to these schemas when non-empty. */
  customDatabases: string[]
  initialQueries: string
  ssh: SshConfig
  ssl: SslConfig
  /** Directory where this connection's backups are written/read. */
  backupDir: string
  /** Extra read-only directories (e.g. Navicat's savepath) scanned for .nb3 files. */
  extraBackupDirs: string[]
  createdAt: string
  updatedAt: string
  /**
   * Records written before multi-engine have no engine: ConnectionsRepo
   * normalises them to 'mysql' on read. Cannot change once saved.
   */
  engine: EngineId
  /** Engine blocks: present (with defaults filled by ConnectionsRepo) only for their engine. */
  network?: NetworkOptions
  postgres?: PostgresOptions
  sqlite?: SqliteOptions
  mongo?: MongoOptions
  source?: {
    /** Manager the connection was imported from (src/main/importers). */
    app: 'navicat' | 'dbeaver' | 'workbench'
    /** Name of the connection in that manager (the import identity with `app`). */
    name: string
    importedAt: string
    /** Navicat section / ConnType ('MySQL', 'PostgreSQL', ...). Missing => 'MySQL'. */
    navicatType?: string
    format?: 'plist' | 'ncx' | 'json' | 'xml'
    /** Navicat ServiceProvider ('Default', 'Redshift', 'MongoDBAtlas', ...). */
    serviceProvider?: string
  }
}

/**
 * What the UI and the importer send to `connections:save`. Without `engine`,
 * an existing record keeps its engine and a new one is 'mysql'.
 */
export type ConnectionInput = Omit<
  ConnectionConfig,
  'id' | 'createdAt' | 'updatedAt' | 'engine'
> & {
  id?: string
  engine?: EngineId
}

export interface ConnectionTestResult {
  ok: boolean
  serverVersion?: string
  /**
   * True when no password was typed or stored in 'password' mode and the
   * server accepted an empty one: the dialog suggests «Sin contraseña».
   */
  connectedWithoutPassword?: boolean
  durationMs: number
  error?: string
  /** Extra facts for the dialog, e.g. "SSL: TLSv1.3" / "sin cifrar", "Túnel SSH: host" (PostgreSQL). */
  details?: string[]
}

export interface ServerInfo {
  version: string
  versionComment: string
  host: string
  port: number
  username: string
  characterSet: string
  uptimeSeconds: number
  threadsConnected: number
  /** Engine of the connection (absent from MySQL drivers that predate it: means 'mysql'). */
  engine?: EngineId
  /** Engine-neutral label/value pairs rendered by the info panel when present. */
  details?: { label: string; value: string }[]
  /** Facts detected at connect time that refine the static engine capabilities. */
  runtime?: ServerRuntime
}

/** Runtime facts of a connected server (section 3 of docs/multi-engine-design.md). */
export interface ServerRuntime {
  /** Detected server flavour, e.g. 'mysql', 'mariadb', 'postgresql'. */
  flavor: string
  /** Numeric server version (e.g. 80407 for MySQL 8.4.7, 170002 for PostgreSQL 17.2). */
  versionNumber: number
  transactions: boolean
  returning: 'none' | 'insert-delete' | 'all'
  topology?: MongoTopology
  /** SQLite: the file is open read-only (configured, or not writable). */
  readOnly?: boolean
  /** MongoDB: role of the member Vortaq is connected to ('primary', 'secondary', 'mongos', …). */
  memberRole?: string
}

export interface DatabaseInfo {
  name: string
  characterSet: string
  collation: string
}

/** PostgreSQL partition of a partitioned table (nested under its parent in the tree). */
export interface TablePartition {
  name: string
  /** Schema of the partition (it may differ from its parent's). */
  schema: string
  /** FOR VALUES … / DEFAULT, as pg_get_expr prints it. */
  bound: string
  /** Sub-partitions when the partition is itself partitioned. */
  partitions?: TablePartition[]
}

export interface TableInfo {
  name: string
  /** PostgreSQL partitioned tables: their partitions (listed only here, not as tables). */
  partitions?: TablePartition[]
  engine: string | null
  rows: number | null
  dataLength: number | null
  indexLength: number | null
  autoIncrement: number | null
  createTime: string | null
  updateTime: string | null
  collation: string | null
  comment: string
}

export interface ViewInfo {
  name: string
  definer: string
  security: string
  updatable: boolean
  createTime?: string | null
}

export type RoutineType = 'FUNCTION' | 'PROCEDURE'

export interface RoutineInfo {
  name: string
  type: RoutineType
  definer: string
  returns: string | null
  created: string | null
  modified: string | null
  comment: string
  /** PostgreSQL: identity arguments (pg_get_function_identity_arguments); overloads share a name. */
  signature?: string
  /** PostgreSQL: 'function' | 'procedure' | 'trigger function'. */
  kind?: string
}

export interface EventInfo {
  name: string
  definer: string
  status: string
  type: string
  executeAt: string | null
  intervalValue: string | null
  intervalField: string | null
  starts: string | null
  ends: string | null
  created: string | null
  modified: string | null
  comment: string
}

export interface TriggerInfo {
  name: string
  table: string
  event: string
  timing: string
  statement: string
  definer: string
}

/**
 * Engine-neutral type family of a column, so the renderer does not have to
 * match engine type names. Absent => the renderer falls back to MySQL names.
 */
export type TypeKind =
  | 'integer'
  | 'decimal'
  | 'float'
  | 'boolean'
  | 'text'
  | 'binary'
  | 'date'
  | 'time'
  | 'datetime'
  | 'json'
  | 'uuid'
  | 'enum'
  | 'array'
  | 'spatial'
  | 'other'

export interface ColumnInfo {
  name: string
  ordinal: number
  columnType: string
  dataType: string
  nullable: boolean
  key: string
  defaultValue: string | null
  extra: string
  characterSet: string | null
  collation: string | null
  comment: string
  /*
   * Engine-neutral metadata. Optional until every driver fills it; when it is
   * absent the renderer keeps reading the MySQL fields above (key, extra, columnType).
   */
  primaryKey?: boolean
  /** AUTO_INCREMENT / identity / serial / INTEGER PRIMARY KEY AUTOINCREMENT. */
  autoIncrement?: boolean
  generated?: 'virtual' | 'stored' | null
  typeKind?: TypeKind
  /** MariaDB INVISIBLE columns. */
  hidden?: boolean
  /** Omit from INSERT when the cell is untouched. */
  hasDefault?: boolean
  /** PostgreSQL identity; 'always' => read-only on insert. */
  identity?: 'always' | 'by-default' | null
  /** PostgreSQL pg_enum (enumsortorder); MySQL parsed from the type. */
  enumValues?: string[]
  /** PostgreSQL format_type(atttypid, atttypmod), for typed binds. */
  sqlType?: string
}

export interface IndexInfo {
  name: string
  unique: boolean
  type: string
  columns: string[]
  comment: string
  /** Engine-neutral primary-key flag; absent => the renderer checks name === 'PRIMARY'. */
  primary?: boolean
  /** PostgreSQL: full CREATE INDEX statement (pg_get_indexdef). */
  definition?: string
  /** PostgreSQL: constraint the index backs (primary key / unique / exclusion), if any. */
  constraint?: string | null
}

/** PostgreSQL table constraint other than foreign keys (p/u/c/x), with its server text. */
export interface ConstraintInfo {
  name: string
  type: 'primary' | 'unique' | 'check' | 'exclusion'
  /** pg_get_constraintdef, e.g. `CHECK ((price > 0))`. */
  definition: string
  columns: string[]
}

export interface ForeignKeyInfo {
  name: string
  columns: string[]
  referencedSchema: string
  referencedTable: string
  referencedColumns: string[]
  onUpdate: string
  onDelete: string
}

/** Engine-neutral kind of a table-like object. */
export type TableKind =
  'table' | 'view' | 'system-versioned' | 'partitioned' | 'materialized-view' | 'foreign'

export interface TableStructure {
  schema: string
  name: string
  /** information_schema TABLE_TYPE ('BASE TABLE', 'VIEW', 'SYSTEM VIEW'); absent from older callers. */
  tableType?: string
  /** Engine-neutral kind; absent => the renderer reads `tableType`. */
  kind?: TableKind
  /** PostgreSQL: database that holds `schema`. */
  database?: string
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  foreignKeys: ForeignKeyInfo[]
  engine: string | null
  collation: string | null
  comment: string
  autoIncrement: number | null
  createSql: string
  /** PostgreSQL: primary key / unique / check / exclusion constraints. */
  constraints?: ConstraintInfo[]
  /**
   * Engine table options. PostgreSQL: unlogged (boolean), owner, tablespace and
   * partitionKey (strings; '' when not set).
   */
  options?: Record<string, string | number | boolean | null>
}

/** PostgreSQL schema of a database (db:schemas). */
export interface SchemaInfo {
  name: string
  owner: string
  comment: string
  /** pg_catalog, information_schema, pg_toast…: hidden unless showSystemSchemas. */
  system: boolean
}

/**
 * One object of a group that has no dedicated info type (db:objects): PostgreSQL
 * materialized views, sequences, types, indexes, triggers and routines.
 */
export interface ObjectSummary {
  name: string
  type: EngineObjectType
  schema: string
  /** Routines: identity arguments (overloads). */
  signature?: string
  /** Indexes and triggers: owning table. */
  table?: string
  /** Free-form sub kind: 'enum' | 'domain' | 'composite' | 'range', 'function' | 'procedure' | 'trigger function'… */
  kind?: string
  /** Estimated rows (reltuples), null when never analysed. */
  rows?: number | null
  sizeBytes?: number | null
  owner?: string
  comment?: string
  /** Short extra column: a routine's result type, a sequence's last value, an enum's labels… */
  detail?: string | null
}

/** PostgreSQL extension (db:extensions, read-only). */
export interface ExtensionInfo {
  name: string
  version: string
  schema: string
}

/** A data type the designer can offer (db:dataTypes, PostgreSQL). */
export interface DataTypeInfo {
  /** Name as written in DDL, schema-qualified when outside pg_catalog/public. */
  name: string
  schema: string
  kind: 'base' | 'enum' | 'domain' | 'composite' | 'range' | 'pseudo' | 'multirange'
  /** Enums: labels in order. */
  enumValues?: string[]
}

/** State of the transaction of a query-tab session (tab sessions, D12). */
export type TransactionStatus = 'idle' | 'in' | 'failed'

/** db:sessionState / db:commit / db:rollback answer for one query tab. */
export interface TabSessionState {
  /** A session is open for the tab (it opens on the first run). */
  open: boolean
  transactionStatus: TransactionStatus
  /** current_schema() after the last statement (PostgreSQL), null when unknown. */
  effectiveSchema: string | null
  /** Database the session is connected to (PostgreSQL). */
  database: string | null
  /**
   * SQLite: all query tabs share one handle, and another tab owns the open
   * transaction (this tab sees its uncommitted changes and cannot write).
   */
  transactionElsewhere?: boolean
}

export interface UserInfo {
  user: string
  host: string
  plugin: string
  accountLocked: boolean
  passwordExpired: boolean
  maxConnections: number
}

export type ObjectType = 'table' | 'view' | 'function' | 'procedure' | 'event' | 'trigger'

/**
 * Object types of every engine. `ObjectType` (what the MySQL channels and
 * views handle today) is the subset the current UI knows; the extra members
 * are for engines that are not available yet.
 */
export type EngineObjectType =
  ObjectType | 'materialized_view' | 'sequence' | 'collection' | 'index' | 'type'

/**
 * Namespace that holds objects. A plain string keeps today's meaning (the
 * MySQL database, the SQLite attached alias, the MongoDB database);
 * PostgreSQL needs the object form, and main rejects a plain string for it.
 */
export type SchemaRef = string | { database: string; schema: string }

/** For objects whose name alone is not unique or not enough to drop them. */
export interface ObjectRef {
  type: EngineObjectType
  name: string
  /** PostgreSQL routines: identity args from pg_get_function_identity_arguments (overloads). */
  signature?: string
  /** PostgreSQL/SQLite triggers and indexes: owning table (DROP TRIGGER t ON tbl). */
  table?: string
}

/** A plain string keeps today's meaning (the object name). */
export type NameRef = string | ObjectRef

/** SQLite storage class of a cell. */
export type StorageClass = 'null' | 'integer' | 'real' | 'text' | 'blob'

export interface QueryColumn {
  /** Name shown in the result (the alias when the query uses `AS`). */
  name: string
  type: string
  /** Real source table (mysql2 orgTable, falling back to table). */
  table?: string
  schema?: string
  /** True when the column is part of the source table primary key. */
  primaryKey?: boolean
  /** Real column name in the source table (mysql2 orgName); absent for expressions. */
  sourceName?: string
  /** Table alias used by the query (mysql2 table); tells self-joins apart. */
  tableAlias?: string
  /** Engine-neutral type family; absent => the renderer matches `type`. */
  typeKind?: TypeKind
  /** PostgreSQL: database of the source table. */
  database?: string
  /** Why the column cannot be edited, when the driver knows. */
  readOnlyReason?: string
  /**
   * SQLite: why this one column cannot be edited (the rowid, a generated column)
   * while the rest of the row can. Unlike readOnlyReason it does not make the
   * whole result read-only.
   */
  locked?: string
}

export type CellValue = string | number | boolean | null

export interface QueryResultSet {
  columns: QueryColumn[]
  rows: CellValue[][]
  truncated: boolean
}

export interface QueryStatementResult {
  sql: string
  durationMs: number
  affectedRows: number | null
  insertId: number | null
  changedRows: number | null
  warnings: number
  resultSet: QueryResultSet | null
  error: string | null
  /** SQLite only: storage class of each cell of `resultSet.rows`. */
  storage?: StorageClass[][]
  /** PostgreSQL RAISE NOTICE / WARNING messages of the statement. */
  notices?: string[]
  /** Tab sessions: transaction state after the statement. */
  transactionStatus?: TransactionStatus
  /** Tab sessions (PostgreSQL): current_schema() after the statement. */
  effectiveSchema?: string | null
  /** 0-based offset into `sql` of the error, when the server reports one. */
  errorPosition?: number | null
}

/**
 * Trailing options of the IPC channels that write to a connection. Main
 * rejects writes to a connection that needs the typed-name confirmation
 * (environment 'production', always, plus AppSettings.typedConfirmEnvironments)
 * unless the UI sets confirmProduction after the user typed the name.
 */
export interface WriteOptions {
  /**
   * The user typed the connection name. Historical name: it now covers every
   * environment in AppSettings.typedConfirmEnvironments, not only production.
   */
  confirmProduction?: boolean
}

export interface QueryExecuteOptions extends WriteOptions {
  /**
   * Default namespace. MySQL: the database (USE). PostgreSQL: `{ database, schema }`
   * (schema '' keeps the search_path as configured).
   */
  schema?: SchemaRef | null
  /** Lets `db:cancel` stop this run (engines with cancel support; ignored on MySQL). */
  executionId?: string
  /**
   * Query tab id: engines with tab sessions run the script on the tab's own session
   * (transactions, SET and temp tables survive between runs). Ignored on MySQL.
   */
  sessionKey?: string
  /** Max rows kept per result set. */
  maxRows?: number
  stopOnError?: boolean
}

export interface TableDataRequest {
  /** MySQL: the database. PostgreSQL: `{ database, schema }`. */
  schema: SchemaRef
  table: string
  limit: number
  offset: number
  orderBy?: { column: string; direction: 'ASC' | 'DESC' } | null
  /** Raw WHERE clause without the keyword, run as-is. */
  where?: string | null
  /**
   * Structured filter (Navicat filter builder). Main turns it into a WHERE with
   * escaped identifiers checked against the table's columns and escaped values.
   * When both `where` and `filter` are given they are combined with AND.
   */
  filter?: TableFilter | null
}

/**
 * Filter builder operators. Labels live in the renderer; main maps each one to SQL:
 * - eq/ne/lt/le/gt/ge: `col = ?`, `col <> ?`... (NULL never matches, like SQL)
 * - contains/beginsWith/endsWith (+ not*): `col [NOT] LIKE ?` with %, _ and \ escaped
 * - isNull/isNotNull: `col IS [NOT] NULL`
 * - isEmpty: `(col = '' OR col IS NULL)`; isNotEmpty: `(col <> '' AND col IS NOT NULL)`
 * - in/notIn: `col [NOT] IN (?, ?...)` with one value per list item
 * - between/notBetween: `col [NOT] BETWEEN ? AND ?`
 * - custom: the row's raw SQL fragment, run as-is (same trust level as the raw WHERE)
 * Siblings are joined with their connectors in order; like SQL, AND binds tighter
 * than OR (`a OR b AND c` = `a OR (b AND c)`): brackets (groups) set any other order.
 * Disabled conditions and empty groups are skipped.
 */
export type TableFilterOperator =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'contains'
  | 'notContains'
  | 'beginsWith'
  | 'notBeginsWith'
  | 'endsWith'
  | 'notEndsWith'
  | 'isNull'
  | 'isNotNull'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'in'
  | 'notIn'
  | 'between'
  | 'notBetween'
  | 'custom'

export type TableFilterJoin = 'AND' | 'OR'

/**
 * One condition line. `connector` joins it with the NEXT sibling (Navicat "y"/"o");
 * the last item's connector is unused.
 */
export interface TableFilterCondition {
  kind: 'condition'
  enabled: boolean
  /** Table column (ignored by `custom`). */
  column: string
  operator: TableFilterOperator
  /** One value; two for between/notBetween; the list items for in/notIn; none otherwise. */
  values: string[]
  connector: TableFilterJoin
  /** Raw SQL fragment of a `custom` row. */
  sql?: string | null
}

/** Bracket: its children are combined in order with their own connectors. Groups nest. */
export interface TableFilterGroup {
  kind: 'group'
  enabled: boolean
  connector: TableFilterJoin
  children: TableFilterNode[]
}

export type TableFilterNode = TableFilterCondition | TableFilterGroup

/** The root group (its own connector and brackets are not rendered). */
export type TableFilter = TableFilterGroup

/** Saved filter of one table (Navicat filter profile). */
export interface TableFilterProfile {
  name: string
  filter: TableFilter
  updatedAt: string
}

export interface TableDataPage {
  columns: QueryColumn[]
  rows: CellValue[][]
  primaryKey: string[]
  total: number | null
  durationMs: number
  /** SQLite only: storage class of each cell of `rows`. */
  storage?: StorageClass[][]
}

export type RowChange =
  | {
      kind: 'insert'
      values: Record<string, CellValue>
      /** SQLite: storage class each value should keep (see `update`). */
      storage?: Record<string, StorageClass>
    }
  | {
      kind: 'update'
      key: Record<string, CellValue>
      values: Record<string, CellValue>
      /**
       * SQLite: storage class of each edited cell as loaded, so an edit keeps it
       * (an INTEGER stays an integer and a BLOB a blob in an untyped column).
       */
      storage?: Record<string, StorageClass>
    }
  | { kind: 'delete'; key: Record<string, CellValue> }

export interface ApplyRowChangesResult {
  applied: number
  statements: string[]
  /**
   * Generated AUTO_INCREMENT id of each change, aligned with the request
   * (null for updates, deletes and inserts without a generated id).
   */
  insertIds?: (number | string | null)[]
}

/* ---------- SQLite (files) ---------- */

/** Maintenance actions of a SQLite connection (menu of the connection / database). */
export type SqliteMaintenanceAction =
  'integrityCheck' | 'quickCheck' | 'foreignKeyCheck' | 'vacuum' | 'optimize'

export interface SqliteMaintenanceResult {
  /** integrity_check/quick_check answered "ok", foreign_key_check found nothing, VACUUM ended. */
  ok: boolean
  /** Problems found (integrity check lines, «tabla: N filas sin padre»…); empty when ok. */
  messages: string[]
  durationMs: number
}

/** «Copiar archivo» (VACUUM INTO). */
export interface SqliteCopyResult {
  path: string
  sizeBytes: number
  durationMs: number
}

/** A trigger or view that the rebuild of a table drops and recreates (its SQL as stored). */
export interface SqliteTableDependent {
  type: 'trigger' | 'view'
  name: string
  sql: string
}

/** What the table designer needs to preview a rebuild (sqlite:tableDependents). */
export interface SqliteTableDependents {
  dependents: SqliteTableDependent[]
  /** sqlite_sequence value of the table (AUTOINCREMENT high-water mark), null when none. */
  sequence: number | null
  /** PRAGMA foreign_keys of the connection. */
  foreignKeys: boolean
}

/**
 * New definition of a table rebuilt by the designer (the 12-step procedure).
 * Main adds the temporary name, the dependents and the sequence itself.
 */
export interface SqliteRebuildDefinition {
  /** Everything after the table name in the new CREATE TABLE: `(\n  …\n) STRICT`. */
  createBody: string
  /** Columns copied from the old table (new and generated columns are left out). */
  columnMap: { target: string; source: string }[]
  /** Copy the rowid too (both tables are rowid tables without INTEGER PRIMARY KEY). */
  keepRowid: boolean
  /** CREATE INDEX statements of the final table. */
  indexes: string[]
  /** The new table uses AUTOINCREMENT: its high-water mark is restored. */
  autoincrement: boolean
}

/** sqlite:alterTable request: create, alter in place, or rebuild a table. */
export interface SqliteAlterRequest {
  /** Current table name; null when the statements create a new table. */
  table: string | null
  /** Final table name. */
  newName: string
  /** In-place statements (or CREATE TABLE/INDEX), run first inside the transaction. */
  statements: string[]
  /** Rebuild after the in-place statements, or null. */
  rebuild: SqliteRebuildDefinition | null
}

export interface SqliteAlterResult {
  /** Statements run, in order. */
  applied: string[]
  /** Foreign key violations that already existed before the change (they do not block it). */
  warnings: string[]
  durationMs: number
}

/* ---------- MongoDB (documents) ---------- */

/*
 * Document values travel as canonical Extended JSON text (EJSON relaxed:false)
 * in both directions, so an Int64, a Decimal128 or an ObjectId never becomes a
 * JS number or string on the way (docs/multi-engine-design.md, D8 and 2.2).
 */

/** Top-level (or dotted) field of sampled documents, with how often each BSON type was seen. */
export interface MongoFieldStat {
  path: string
  /** Documents that have the field. */
  count: number
  /** BSON type name (shared/mongo/shellFormat `bsonTypeOf`) → documents with that type. */
  types: Record<string, number>
}

/** A collection, view or time-series collection of a database (mongo:collections). */
export interface MongoCollectionInfo {
  name: string
  type: 'collection' | 'view' | 'timeseries'
  /** Why documents cannot be edited here (view, capped, time-series, GridFS chunks…), or null. */
  readOnlyReason: string | null
  /** Document count from $collStats (null for views or without privileges). */
  count: number | null
  sizeBytes: number | null
  storageSizeBytes: number | null
  indexCount: number | null
  avgObjSizeBytes: number | null
  capped: boolean
  /** Views: source collection. */
  viewOn?: string
}

export interface MongoIndexInfo {
  name: string
  /** Canonical EJSON of the key document (`{"a":{"$numberInt":"1"}}`). */
  keys: string
  unique: boolean
  sparse: boolean
  hidden: boolean
  /** TTL in seconds, or null. */
  expireAfterSeconds: number | null
  /** Canonical EJSON of partialFilterExpression, or null. */
  partialFilter: string | null
  /** Canonical EJSON of the collation, or null. */
  collation: string | null
  /** Other options (2dsphere version, weights, …) as canonical EJSON, or null. */
  extra: string | null
}

export interface MongoCollectionDetails {
  info: MongoCollectionInfo
  indexes: MongoIndexInfo[]
  /** Canonical EJSON of the validator document, or null. */
  validator: string | null
  validationLevel: string | null
  validationAction: string | null
  /** Canonical EJSON of the listCollections options (capped, size, timeseries, viewOn, pipeline…). */
  options: string
}

/** Collection browser request (mongo:find). Filter, sort and projection use shell syntax. */
export interface MongoDocumentQuery {
  database: string
  collection: string
  filter: string
  sort: string
  projection: string
  skip: number
  limit: number
  executionId?: string
  /** Who owns the open cursor (the view's tab id): each view keeps its own «Cargar más». */
  owner?: string
}

export interface MongoDocumentPage {
  /** Canonical EJSON, one per document. */
  docs: string[]
  /** Per document: fetched whole (no projection, no inclusion $project, not size-truncated). */
  whole: boolean[]
  fields: MongoFieldStat[]
  /** Total documents matching the filter, null when unknown (count timed out). */
  total: number | null
  /** countDocuments (true) or estimatedDocumentCount / no count (false). */
  totalExact: boolean
  /** More documents are available through `resultId` («Cargar más»). */
  truncated: boolean
  /** Open server cursor for mongo:getMore; null when exhausted. */
  resultId: string | null
  durationMs: number
}

export type MongoDocumentChange =
  /** Shell syntax or canonical EJSON; `_id` is generated when absent. */
  | { kind: 'insert'; doc: string }
  | {
      kind: 'update'
      /** Canonical EJSON of `_id`. */
      id: string
      /** Dotted path → canonical EJSON of the new value (typed by the cell editor). */
      set: Record<string, string>
      /** Dotted paths to remove (never an array element: arrays are always $set whole). */
      unset: string[]
      /** Original value of each edited path, canonical EJSON (optimistic check). */
      expected: Record<string, string>
    }
  | {
      kind: 'replace'
      id: string
      /** The whole new document (shell syntax or canonical EJSON). */
      doc: string
      /** Main refuses a replace of a document that was not fetched whole. */
      fetchedWhole: true
      /** Canonical EJSON of the document as loaded: a changed document is not overwritten. */
      original?: string
    }
  | { kind: 'delete'; id: string }

export interface MongoApplyResult {
  /** Changes applied (all of them, or those before the first failure). */
  applied: number
  /** All-or-nothing in a transaction (replica set / sharded cluster). */
  atomic: boolean
  /** Canonical EJSON `_id` of each insert, aligned with the request (null for other kinds). */
  insertedIds: (string | null)[]
  /** Standalone servers: the change that failed (0-based) and why; later changes were not sent. */
  failure: { index: number; message: string } | null
}

/** One statement of a MongoDB query tab and its outcome (mongo:execute). */
export interface MongoCommandResult {
  /** Source text of the statement. */
  statement: string
  durationMs: number
  kind: 'documents' | 'write' | 'value' | 'error'
  /** Database the statement ran in. */
  database: string | null
  collection?: string
  /** kind 'documents'. */
  page?: MongoDocumentPage
  /**
   * kind 'documents': null when the documents can be edited in place (by `_id`),
   * otherwise why not («resultado de aggregate con $group», «vista»…).
   */
  readOnlyReason?: string | null
  /** kind 'write'. */
  write?: {
    acknowledged: boolean
    matched: number | null
    modified: number | null
    inserted: number | null
    deleted: number | null
    upserted: number | null
    /** Canonical EJSON of the inserted/upserted ids (at most 100). */
    ids: string[]
  }
  /** kind 'value': canonical EJSON (or plain text for show/use). */
  value?: string
  error?: string
  /** Tab session state after the statement. */
  transactionStatus?: TransactionStatus
  /** Current database of the tab after the statement (`use`). */
  currentDatabase?: string | null
}

export interface MongoExecuteOptions extends WriteOptions {
  /** Current database of the tab (`use <db>` changes it for later runs). */
  database: string | null
  /** Max documents per result (the rest stay behind «Cargar más»). */
  maxDocs?: number
  executionId?: string
  /** Query tab id: the tab's own session (database, transaction). */
  sessionKey?: string
}

export interface MongoCreateCollectionOptions {
  capped?: boolean
  /** Capped: maximum size in bytes. */
  size?: number
  /** Capped: maximum documents. */
  max?: number
  /** Shell syntax of a validator document, '' for none. */
  validator?: string
}

export interface MongoIndexSpec {
  /** Shell syntax of the key document, e.g. `{ email: 1, createdAt: -1 }`. */
  keys: string
  name?: string
  unique?: boolean
  sparse?: boolean
  hidden?: boolean
  expireAfterSeconds?: number | null
  /** Shell syntax, '' for none. */
  partialFilter?: string
  /** Shell syntax, '' for none. */
  collation?: string
}

export interface MongoValidatorInput {
  /** Shell syntax of the validator document; '' removes it. */
  validator: string
  level: 'off' | 'strict' | 'moderate'
  action: 'error' | 'warn'
}

/* ---------- Backups (.vqb and .nb3) ---------- */

/**
 * Object types of a backup. .nb3: Table, View, Function, Procedure, Event.
 * .vqb adds PostgreSQL's Type, Sequence, MaterializedView and Extension.
 */
export type BackupObjectType =
  | 'Table'
  | 'View'
  | 'Function'
  | 'Procedure'
  | 'Event'
  | 'Trigger'
  | 'Type'
  | 'Sequence'
  | 'MaterializedView'
  | 'Extension'
  | string

export interface BackupObjectSummary {
  /** .nb3: the object's UUID. .vqb: its folder number ("000003"). */
  uuid: string
  type: BackupObjectType
  name: string
  /** PostgreSQL (.vqb): schema of the object. */
  schema?: string
  rows: number | null
}

/** File format of a restorable backup. */
export type BackupFileFormat = 'nb3' | 'vqb'

export interface BackupMeta {
  metaVersion: string
  databaseType: string
  /** MySQL: the schema. PostgreSQL (.vqb): the database. '' while locked. */
  schema: string
  startTime: string | null
  endTime: string | null
  /** 'None' when not encrypted; .vqb: 'AES-256-GCM'. */
  encryption: string
  comment: string
  objects: BackupObjectSummary[]
  /** Absent in metadata cached before .vqb existed: 'nb3'. */
  format?: BackupFileFormat
  /** .vqb protected with a password. */
  encrypted?: boolean
  /**
   * Encrypted and read without its password: only the header is known
   * (no schema, no objects). Pass the password to read the rest.
   */
  locked?: boolean
  /** .vqb: engine of the source ('mysql' | 'postgresql'), its flavour and server version. */
  engine?: EngineId
  engineFlavor?: string
  serverVersion?: string
  /** .vqb: app that wrote it, e.g. «Vortaq 2.0.0». */
  writtenBy?: string
  /** .vqb: source connection name, absent when the user left it out. */
  connectionName?: string | null
  /** .vqb PostgreSQL: schemas included. */
  schemas?: string[]
  /** .vqb: false = structure only. */
  includeData?: boolean
  /** .vqb: only some objects were selected. */
  partial?: boolean
  /** .vqb: what the backup left out (MariaDB system-versioned tables…). */
  warnings?: string[]
}

export interface BackupFile {
  path: string
  fileName: string
  connectionId: string | null
  schema: string | null
  sizeBytes: number
  createdAt: string
  modifiedAt: string
  /**
   * Who wrote the file. 'electrondb' means this app: the value predates the
   * Vortaq name and stays as is because it is a data value, not a label.
   */
  source: 'navicat' | 'electrondb' | 'unknown'
  /** Free-text suffix parsed from Navicat names like 20260317145120-staging.nb3 */
  label: string | null
  /** From the extension (absent in older answers: 'nb3'). */
  format?: BackupFileFormat
  /** .vqb protected with a password (read from its header). */
  encrypted?: boolean
  /**
   * The automation run whose backup step wrote this file (matched by path in
   * the run history; no archive is opened). Absent/null: not written by a job.
   */
  run?: BackupRunRef | null
}

/** Backup step of a job run that produced a file. */
export interface BackupRunRef {
  runId: string
  jobId: string
  jobName: string
  /** When the run started (ISO). */
  startedAt: string
  taskId: string
  /** False when the step copied the structure only. */
  includeData: boolean
}

export interface BackupCreateOptions {
  connectionId: string
  /** MySQL: the schema. PostgreSQL: the database (every non-system schema is included). */
  schema: string
  /** Optional override; defaults to the connection backupDir/<schema>. */
  targetDir?: string
  comment?: string
  label?: string
  /** Table names to include; empty = all objects. */
  objects?: string[]
  includeData: boolean
  /**
   * 'vqb' (Vortaq's open format, the default of the UI and new jobs) or 'nb3'
   * (Navicat-compatible). Absent = 'nb3' for callers written before .vqb.
   * PostgreSQL only writes .vqb.
   */
  format?: BackupFileFormat
  /** .vqb only: encrypt with this password (8 characters or more). Never stored by the backup. */
  password?: string | null
  /** .vqb: do not record the connection name in the manifest. */
  omitConnectionName?: boolean
}

export interface BackupCreateResult {
  path: string
  sizeBytes: number
  objects: number
  rows: number
  durationMs: number
}

export interface RestoreOptions {
  backupPath: string
  connectionId: string
  targetSchema: string
  createSchema: boolean
  dropObjectsFirst: boolean
  includeStructure: boolean
  includeData: boolean
  /** Object names to restore; empty = all. */
  objects?: string[]
  continueOnError: boolean
  /**
   * REPLACE the whole database (DROP + CREATE DATABASE, then every object
   * of the backup): it ends up exactly like the backup. Ignores objects,
   * createSchema, dropObjectsFirst and includeStructure; `includeData: false`
   * creates every object with empty tables («Solo estructura»).
   */
  replaceSchema?: boolean
  /** With replaceSchema: back up the current database first (default true). */
  safetyBackup?: boolean
  /** Required when the target connection needs the typed confirmation (see WriteOptions). */
  confirmProduction?: boolean
  /**
   * Internal (replace «Solo estructura»): create tables without the backup's
   * AUTO_INCREMENT value so counters start fresh. Object restores keep it.
   */
  skipAutoIncrement?: boolean
  /** Password of an encrypted .vqb. */
  password?: string | null
  /**
   * SQLite: restore into a NEW database file at this absolute path (created
   * by the restore, refused when it exists) instead of a connection; then
   * `connectionId` may be ''.
   */
  newFilePath?: string
  /** SQLite with `newFilePath`: also save a connection for the restored file. */
  createConnection?: boolean
}

export interface RestoreResult {
  objectsRestored: number
  rowsInserted: number
  errors: { object: string; message: string }[]
  durationMs: number
  /** replaceSchema: safety copy of the database that was replaced (null = none taken). */
  safetyBackupPath?: string | null
  /** replaceSchema with `includeData: false`: objects created, no rows inserted. */
  structureOnly?: boolean
  /** SQLite `newFilePath`: the file restored into. */
  restoredFilePath?: string | null
  /** SQLite `createConnection`: id of the connection created for the restored file. */
  newConnectionId?: string | null
}

/* ---------- Automation ---------- */

export type JobTaskType = 'backupschema' | 'runquery' | 'restoreschema' | 'restorepackage'

/**
 * Which package a 'restorepackage' step restores (a package = the copies one
 * run of a job made together):
 * - `own`: the copies made in this same run by the backup steps of the job
 *   placed before the step;
 * - `job`: the newest package of another job (its latest finished run with
 *   restorable copies), resolved when the step runs. `jobName` is only a label
 *   for when that job no longer exists.
 */
export type RestorePackageSource =
  { kind: 'own' } | { kind: 'job'; jobId: string; jobName?: string }

/**
 * Where a restore step ('restoreschema') takes its .nb3 from:
 * - `task`: the file produced in the same run by an earlier backup step of the job;
 * - `latest`: the newest backup of `schema` from `connectionId` found on disk;
 * - `file`: one explicit file (used by «Restaurar todo» from the run history, never saved in jobs).
 */
export type RestoreTaskSource =
  | { kind: 'task'; taskId: string }
  | { kind: 'latest'; connectionId: string; schema: string }
  | { kind: 'file'; path: string; schema: string; connectionId: string | null }

export interface JobTask {
  id: string
  type: JobTaskType
  /** Connection the step works on (for restoreschema: the TARGET connection). */
  connectionId: string
  /**
   * Schema the step works on. For restoreschema: the target schema, empty =
   * same name as the source schema.
   */
  schema: string
  referenceName: string
  /** For runquery: SQL to execute. */
  sql?: string
  /**
   * backupschema: copy the rows too. restoreschema: restore the rows too;
   * false = «Solo estructura» (empty tables). Absent = true (older jobs).
   */
  includeData?: boolean
  /** For restoreschema: backup to restore. */
  restoreSource?: RestoreTaskSource
  /** For restoreschema and restorepackage: back up each target database before replacing it (default true). */
  safetyBackup?: boolean
  /** restorepackage: the package restored into `connectionId` (the target; `schema` is unused). */
  packageSource?: RestorePackageSource
  /**
   * restorepackage: databases of the package to restore (the names they were
   * copied from). Absent = all of them, including databases the package gains
   * later.
   */
  packageDatabases?: string[]
  /** restorepackage: target name of a database (by its copied name); absent = name + suffix. */
  packageTargets?: Record<string, string>
  /** restorepackage: added to the name of every database without its own target name. */
  packageSuffix?: string
  /**
   * backupschema: file format. 'vqb' (the default of new steps) and 'nb3' are
   * restorable; 'sql' writes a plain .sql dump other managers can read (a
   * restore step cannot use it). Absent = 'nb3' (jobs saved before .vqb).
   */
  format?: BackupFormat
  /**
   * backupschema with format 'vqb': encrypt the copy with the job's backup
   * password (stored encrypted in the credential store, never in jobs.json).
   */
  encrypt?: boolean
}

export interface JobSchedule {
  enabled: boolean
  /** 5-field cron expression. */
  cron: string
  /** Run even if the app is closed via a launchd agent. */
  launchAgent: boolean
}

export interface Job {
  id: string
  name: string
  continueOnError: boolean
  tasks: JobTask[]
  schedule: JobSchedule
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
  source?: { app: 'navicat'; fileName: string; importedAt: string }
  /**
   * The job has a backup password stored (filled by jobs:list/get from the
   * credential store; never saved in jobs.json, the password never leaves main).
   */
  hasBackupPassword?: boolean
}

export type JobInput = Omit<
  Job,
  'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'hasBackupPassword'
> & {
  id?: string
  /**
   * jobs:save only: a new backup password for the encrypted steps (stored in
   * the credential store), null to delete the stored one, absent to keep it.
   */
  backupPassword?: string | null
}

export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled'

export interface JobTaskRun {
  taskId: string
  referenceName: string
  status: RunStatus
  startedAt: string | null
  finishedAt: string | null
  message: string | null
  /** backupschema: the .nb3 written; restoreschema: the safety backup of the target (if any). */
  outputPath: string | null
  /** Step type, connection and schema when the run started (absent in older runs). */
  type?: JobTaskType
  connectionId?: string
  schema?: string
  /** backupschema: the copy includes rows (false = structure only). */
  includeData?: boolean
  /** backupschema: file format of the copy (absent = 'nb3'). */
  format?: BackupFormat
  /** backupschema: the .vqb was encrypted with the job's password. */
  encrypted?: boolean
  /**
   * restoreschema run task that a 'restorepackage' step became when it ran
   * (one per database of the package): the id of that step.
   */
  packageStepId?: string
}

/** Latest package of a job, for the «Restauración» list of the job editor (jobs:packages). */
export interface JobPackageSummary {
  jobId: string
  jobName: string
  /** Databases the job's backup steps copy (restorable formats), in step order. */
  steps: { schema: string; connectionId: string; includeData: boolean }[]
  /** Newest finished run with restorable copies; null = none yet. */
  latest: {
    runId: string
    startedAt: string
    status: RunStatus
    copies: JobPackageCopy[]
  } | null
}

/** One copy of a job package (a database copied by one backup step of a run). */
export interface JobPackageCopy {
  schema: string
  connectionId: string | null
  /** Backup step of the job that made it. */
  taskId: string
  path: string
  /** Structure only (no rows). */
  structureOnly: boolean
  encrypted: boolean
}

export interface JobRun {
  id: string
  jobId: string
  jobName: string
  status: RunStatus
  trigger: 'manual' | 'schedule' | 'cli'
  startedAt: string
  finishedAt: string | null
  tasks: JobTaskRun[]
  logPath: string
  /** Process executing the run (stale `running` runs are recovered when it no longer exists). */
  pid?: number
  /** 'rollback': restore of the backups of another run («Restaurar todo»). Absent = job run. */
  kind?: 'job' | 'rollback'
  /** For rollback runs: the run whose backups were restored. */
  rollbackOf?: string
}

/* ---------- Rollback of a run («Restaurar todo en Local») ---------- */

export interface RollbackPlanItem {
  /** Backup step of the source run. */
  taskId: string
  referenceName: string
  sourceConnectionId: string | null
  sourceConnectionName: string
  /** Schema stored in the backup (the database that was backed up). */
  schema: string
  /** Database replaced on the target connection (same name as the source). */
  targetSchema: string
  backupPath: string
  sizeBytes: number | null
  /** True: exists on the target and will be REPLACED; null: unknown (target not reachable). */
  targetExists: boolean | null
  /** Why this database cannot be restored (missing file, other schema, encrypted...). */
  problem: string | null
  /** Objects and rows stored in the backup (from its manifest; null = unknown). */
  objects: number | null
  rows: number | null
  /** The backup step copied the structure only: the target tables would end up empty. */
  structureOnly: boolean
  /** Something the user must know before restoring it (no rows...); null = nothing. */
  warning: string | null
  /** An encrypted .vqb. */
  encrypted?: boolean
  /** Encrypted and neither the job's stored password nor the one given opens it. */
  locked?: boolean
}

export interface RollbackPlan {
  /** 'run': the backups of one run; 'files': backup files picked in the backups list. */
  source?: 'run' | 'files'
  /** Source run ('' for a file plan whose files do not all come from one run). */
  runId: string
  /** Job the restore is recorded under (MANUAL_ROLLBACKS_JOB_ID of shared/backupPackages for mixed files). */
  jobId: string
  /** Run: the job name. Files: the title of the selection («staging · 2026-10-05 23:16»). */
  jobName: string
  /** Run start; files: the newest file date. */
  runStartedAt: string
  targetConnectionId: string | null
  items: RollbackPlanItem[]
  /** The target connection could not be inspected; `targetExists` is then null. */
  targetError: string | null
}

export interface RollbackRunRequest {
  source?: 'run'
  runId: string
  targetConnectionId: string
  /** Backup steps of the run to restore (subset of the plan items). */
  taskIds: string[]
  /** Back up each existing target database before replacing it. */
  safetyBackup: boolean
  /** False = «Solo estructura»: every object, empty tables. Absent = true. */
  includeData?: boolean
  /** Password for encrypted .vqb copies the job's stored password does not open. */
  password?: string | null
}

/**
 * Backup files to restore (a package or files picked by hand in the backups
 * list). Each one must live in a backup folder of a known connection.
 */
export interface RollbackFilesSource {
  source: 'files'
  backupPaths: string[]
  /** Connection whose backups list the files were picked from. */
  sourceConnectionId: string
  /** What the user selected, for the dialog and the run name (package title). */
  title?: string
}

export interface RollbackFilesRequest extends RollbackFilesSource {
  targetConnectionId: string
  /** Back up each existing target database before replacing it. */
  safetyBackup: boolean
  /** False = «Solo estructura»: every object, empty tables. Absent = true. */
  includeData?: boolean
  /** One password for the encrypted .vqb copies of the package. */
  password?: string | null
}

export type RollbackRequest = RollbackRunRequest | RollbackFilesRequest

/* ---------- Navicat import ---------- */

export interface NavicatDetection {
  found: boolean
  rootPath: string
  connPlistPath: string | null
  prefPlistPath: string | null
  profilesDir: string | null
  connectionCount: number
  jobCount: number
  backupCount: number
}

/** Where an automatically found Navicat folder lives. */
export type NavicatCandidateSource = 'default' | 'appStore' | 'legacy' | 'copied'

/** A Navicat data folder found automatically (its Common/conn.plist parses). */
export interface NavicatCandidate {
  rootPath: string
  source: NavicatCandidateSource
  connectionCount: number
  jobCount: number
  backupCount: number
  /** Last change of Common/conn.plist (ISO), null when unknown. */
  modifiedAt: string | null
}

export interface NavicatCandidatesResult {
  /**
   * False outside macOS: Navicat for Windows/Linux keeps its connections
   * elsewhere (Registry...), only a copied macOS «Navicat CC» folder can be read.
   */
  supportedPlatform: boolean
  /** Best first: most connections, then most recently changed. */
  candidates: NavicatCandidate[]
}

/** conn.plist sections the Navicat folder import maps. */
export type NavicatSection = 'MySQL' | 'MariaDB' | 'PostgreSQL' | 'SQLite' | 'MongoDB'

export interface NavicatConnectionPreview {
  /** What `navicat:import` takes: the name for MySQL rows, `<section>\u001f<name>` otherwise. */
  key: string
  navicatType: NavicatSection
  /** Engine Vortaq creates; null for an unsupported server (a PostgreSQL fork). */
  engine: EngineId | null
  /** Why the row cannot be imported (unsupported server, encrypted file, Kerberos…). */
  blockedReason: string | null
  /** Fields the import could not map exactly (e.g. «solo se usa el primer host»). */
  warnings: string[]
  name: string
  host: string
  port: number
  username: string
  color: string | null
  environment: Environment
  ssh: SshConfig
  ssl: SslConfig
  savePath: string | null
  customDatabases: string[]
  initialQueries: string
  backupCount: number
  alreadyImported: boolean
  /** SQLite: the database file as written in conn.plist (never opened by the preview). */
  filePath?: string
}

export interface NavicatJobPreview {
  fileName: string
  name: string
  continueOnError: boolean
  tasks: { type: string; server: string; schema: string; referenceName: string }[]
  alreadyImported: boolean
}

export interface NavicatImportRequest {
  connections: string[]
  jobs: string[]
}

export interface NavicatImportResult {
  connections: ConnectionConfig[]
  jobs: Job[]
  warnings: string[]
}

/* ---------- Settings / app ---------- */

/** A message the renderer shows once after start, then dismisses through IPC. */
export interface StartupNotice {
  id: string
  level: 'info' | 'warning'
  title: string
  message: string
  /**
   * Optional button next to «Ahora no». Runs only when the user clicks it;
   * `trashLegacyApp` calls app:trashLegacyApp.
   */
  action?: { kind: 'trashLegacyApp'; label: string }
}

/** Result of app:trashLegacyApp. */
export interface TrashLegacyAppResult {
  /** Bundles moved to the Trash. */
  trashed: string[]
}

/** «Acerca de Vortaq»: licence texts shipped with the app. */
export interface AppLicenses {
  /** The project's LICENSE (MIT); null if the file is missing. */
  license: string | null
  /** THIRD_PARTY_LICENSES.txt; null when it was not generated (development without a build). */
  thirdParty: string | null
  thirdPartyPath: string | null
  /** Public repository of the project. */
  repositoryUrl: string
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  node: string
  platform: string
  userDataPath: string
  logPath: string
}

export interface AppSettings {
  navicatRootPath: string
  backupsRootDir: string
  defaultRowLimit: number
  theme: 'dark' | 'light'
  /**
   * Environments whose connections need the typed-name confirmation before
   * any write (and `confirmProduction: true` on the IPC call). Always contains
   * 'production' (it cannot be removed); defaults to ['production']. Replaces
   * the old boolean `confirmProductionWrites`, which is no longer honoured.
   */
  typedConfirmEnvironments: Environment[]
  /**
   * Ask before DROP / TRUNCATE / DELETE (and deleting rows or objects) on any
   * connection, not only production. Renderer-only convenience: main does not
   * enforce it. Defaults to true, also for profiles saved before it existed.
   */
  confirmDestructiveEverywhere: boolean
  /** Look for a new release on GitHub a few seconds after start (at most every 6 hours). */
  checkUpdatesOnStartup: boolean
  /**
   * «Descargar actualizaciones automáticamente» (off by default): when the startup check finds
   * a new version, start the in-app download without waiting for a click. Installing always
   * needs the user (or happens when the app quits). Only where the app can update itself
   * (Windows installer, Linux AppImage).
   */
  autoDownloadUpdates: boolean
  /** «Activar asistente de IA» (off by default; needs a configured provider). */
  aiEnabled: boolean
  /** Provider profile used by the assistant (null: the first one). */
  aiDefaultProviderId: string | null
  /** Reasoning effort for providers that support it (Claude): Bajo / Medio / Alto. */
  aiEffort: AiEffort
  /** Max output tokens per answer. */
  aiMaxTokens: number
  /**
   * Format «Nueva copia» starts with: 'vqb' (default; absent = 'vqb'), 'nb3'
   * or 'sql'. PostgreSQL connections always use .vqb.
   */
  defaultBackupFormat?: BackupFormat
}

/* ---------- Updates ---------- */

/** How this copy runs: an installer build, or `npm run dev` / `electron .` from a folder. */
export type UpdateRunMode = 'packaged' | 'source'

/**
 * How this copy installs a new version:
 * - 'auto': downloaded and installed from the app (electron-updater; Windows NSIS installer,
 *   Linux AppImage). The download is checked against the sha512 of latest.yml.
 * - 'mac-dmg': the app downloads the .dmg and checks its SHA-256, the user drags the app to
 *   Applications (self-install needs an Apple Developer ID signature, which Vortaq lacks).
 * - 'manual': the browser downloads the file (portable .exe, .deb, test profiles).
 * - 'source': runs from a folder (`npm run dev`): commands to paste in a terminal.
 */
export type UpdateInstallMode = 'auto' | 'mac-dmg' | 'manual' | 'source'

/** In-app download/installation of an update (the dialog's progress and buttons). */
export interface UpdateInstallState {
  mode: UpdateInstallMode
  phase: 'idle' | 'downloading' | 'downloaded' | 'error'
  /** Version being downloaded or ready. */
  version?: string
  /** Bytes received so far and expected (0 when unknown). */
  transferred?: number
  total?: number
  bytesPerSecond?: number
  /** 'mac-dmg': the verified .dmg on disk. */
  filePath?: string
  /** Spanish, actionable message when phase is 'error'. */
  error?: string
  /** «Descargar manualmente»: the asset or release page (allowlisted for app:openExternal). */
  manualUrl?: string
  /** The last download was cancelled by the user (phase is back to 'idle'). */
  cancelled?: boolean
}

export interface UpdateAsset {
  url: string
  fileName: string
  sizeBytes: number
  /** Short Spanish label for buttons ("Instalador", "Portable", ".deb"...). */
  label: string
}

/** How to update a copy that runs from a git checkout. */
export interface SourceUpdateInfo {
  /** Folder holding the checkout (where the commands must run). */
  dir: string
  /** False when no `.git` was found (a copied folder): `git pull` cannot update it. */
  isGit: boolean
  /** Current branch read from .git/HEAD; null when detached or unknown. */
  branch: string | null
  /** Commands to paste into a terminal, one per line. */
  commands: string[]
}

export interface UpdateCheckResult {
  status: 'up-to-date' | 'available' | 'error'
  currentVersion: string
  latestVersion?: string
  releaseName?: string
  releaseUrl?: string
  publishedAt?: string
  /** Release notes (markdown, truncated to ~4000 characters). */
  notes?: string
  /** Best download for this OS/architecture (packaged copies). */
  download?: UpdateAsset
  alternatives?: UpdateAsset[]
  runMode: UpdateRunMode
  /** How this copy can install the new version (see UpdateInstallMode). */
  installMode?: UpdateInstallMode
  /** Present in source mode: the folder and the commands to update it. */
  source?: SourceUpdateInfo
  /** The user chose «Omitir esta versión» for latestVersion. */
  dismissed?: boolean
  /** «Más tarde» was chosen less than 6 hours ago: no automatic popup. */
  snoozed?: boolean
  /** ISO date of the GitHub data used (fresh fetch or the cached one). */
  checkedAt?: string
  /** Spanish, actionable message when status is 'error'. */
  error?: string
}

/** «Novedades» popup shown once after updating (see src/shared/whatsNew.ts). */
export interface WhatsNewInfo {
  currentVersion: string
  /** Version seen before the update; null when unknown (profile from an older build). */
  previousVersion: string | null
  /** Curated entries in the range, newest first. */
  entries: WhatsNewEntry[]
  /** Release page of the current version (allowlisted for app:openExternal). */
  releaseUrl: string
}

/* ---------- Progress events ---------- */

export interface ProgressEvent {
  /** Correlates with the invoke that started the operation. */
  operationId: string
  kind: 'backup' | 'restore' | 'job' | 'import' | 'query' | 'export'
  phase: string
  current: number
  total: number | null
  message: string
  done: boolean
  error?: string
  /** Structured progress (backups and automation runs); renderers fall back to `message`. */
  detail?: ProgressDetail
}

/** Structured progress of a backup or an automation run. Every field is optional. */
export interface ProgressDetail {
  /** Automation runs: job name, 1-based step number, step count and step label (schema). */
  jobName?: string
  step?: number
  steps?: number
  stepLabel?: string
  /** Object being processed: `Statement` for SQL steps, backup object types otherwise. */
  objectType?: BackupObjectType | 'Statement'
  objectName?: string
  /** 1-based index of the current object and object count of the step/operation. */
  objectIndex?: number
  objects?: number
  /** Objects already finished in the step/operation. */
  objectsDone?: number
  /** Rows written so far for the current object (null: structure only). */
  rows?: number | null
  /** Failure message of the current object. */
  error?: string
  /** Estimated row count of the current table (information_schema TABLE_ROWS), null if unknown. */
  rowsEstimate?: number | null
  /** Weighted work units (objects + estimated rows) done / total in the step/operation. */
  workDone?: number
  workTotal?: number
}

/** Live lines of an automation run log (event:jobLog). `seq` is the index of `lines[0]` in the log. */
export interface JobLogEvent {
  runId: string
  seq: number
  lines: string[]
}

export interface LogEvent {
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
  at: string
}
