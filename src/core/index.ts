/**
 * Vortaq core: the Electron-free API an editor extension (or any Node host)
 * needs, re-exported from where it already lives in src/main and src/shared.
 * Nothing reachable from this file may import Electron: `npm run check:core`
 * and scripts/core-bundle.test.ts bundle it with esbuild and fail on any
 * `electron` import or desktop-only file, and ESLint forbids the imports in
 * the core folders (docs/vscode-extension-design.md, "Boundary").
 *
 * Most hosts only need createCore: its invoke() answers the same IPC channels
 * the desktop renderer uses, behind the same production guard.
 */

/* ---------- host setup and ports ---------- */
export { createCore, type CoreOptions, type VortaqCore } from './host'
export { HandlerRegistry, runHandler, type HandleFn, type IpcHandler } from '@main/ipc/router'
export { describeForLog, IpcError } from '@main/ipc/errorLog'
export { configureLog, getLogger, type Logger } from '@main/log'
export { envVar } from '@main/env'
export type { AppContext } from '@main/context'

/* ---------- secrets ---------- */
export {
  CredentialStore,
  DB_PASSWORD,
  plainCodec,
  SECRET_KINDS,
  type CodecName,
  type ConnectionSecretKind,
  type SecretCodec,
  type SecretKind
} from '@main/credentials/store'
export { keyCodec, newVaultKey, VAULT_KEY_BYTES } from '@main/credentials/keyCodec'

/* ---------- storage (JSON files in the host's profile folder) ---------- */
export { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '@main/storage/repos'
export { FilterProfileError, FilterProfilesRepo } from '@main/storage/filterProfiles'
export { JsonStore } from '@main/storage/jsonStore'

/* ---------- connections, drivers, SSH ---------- */
export {
  ConnectionManager,
  getConnectionManager,
  getSessionFactory,
  planPassword,
  type ConnectionManagerOptions,
  type DriverLookup,
  type PasswordPlan
} from '@main/db/manager'
export { getDriver, hasDriver } from '@main/db/registry'
export {
  isMysqlFamily,
  type DocumentDriverConnection,
  type Driver,
  type DriverConnection,
  type DriverHooks,
  type DriverSecrets,
  type Endpoint,
  type MysqlFamilyConnection,
  type Scope,
  type SqlDriverConnection,
  type SqlSession
} from '@main/db/driver'
export {
  CAPABILITY_MESSAGES,
  DbUserError,
  requireCapability,
  requireConnectionCapability,
  ServerError
} from '@main/db/errors'
export {
  checkPrivateKey,
  openSshTunnel,
  type SshTunnel,
  type SshTunnelOptions
} from '@main/db/tunnel'

/* ---------- query, table data and row-change loops ---------- */
export {
  DEFAULT_ROW_LIMIT,
  executeScript,
  MAX_ROWS_CAP,
  resolveMaxRows,
  type ScriptTarget
} from '@main/db/query'
export { fetchTablePage, type TablePageSource } from '@main/db/tableData'
export { applyRowChangesAtomically, type RowChangeRunner } from '@main/db/rowChanges'

/* ---------- introspection per engine (sessions from ConnectionManager) ---------- */
export * as mysqlIntrospect from '@main/mysql/introspect'
export * as postgresIntrospect from '@main/postgres/introspect'
export * as sqliteIntrospect from '@main/sqlite/introspect'
export * as mongoAdmin from '@main/mongo/admin'

/* ---------- handlers behind the IPC map (what createCore registers) ---------- */
export { registerConnectionsHandlers } from '@main/ipc/connections'
export { registerDbHandlers } from '@main/ipc/db'
export { registerFiltersHandlers, schemaKey } from '@main/ipc/filters'
export { registerBackupsHandlers } from '@main/ipc/backups'
export { registerAiHandlers } from '@main/ipc/ai'
export { createPgDbHandlers, type PgDbHandlers } from '@main/ipc/dbPostgres'
export { createSqliteDbHandlers, type SqliteDbHandlers } from '@main/ipc/dbSqlite'
export { createMongoHandlers } from '@main/ipc/mongo'

/* ---------- production guard and typed confirmation ---------- */
export {
  assertProductionWriteConfirmed,
  assertScriptAllowed,
  needsTypedConfirm,
  typedConfirmEnvironments
} from '@main/ipc/productionGuard'
export {
  ALL_ENVIRONMENTS,
  DEFAULT_TYPED_CONFIRM_ENVIRONMENTS,
  environmentName,
  environmentPhrase,
  isEnvironment,
  MANDATORY_TYPED_ENVIRONMENTS,
  normalizeTypedConfirmEnvironments,
  requiresTypedConfirm
} from '@shared/typedConfirm'
export {
  guardedRiskSignature,
  guardedWriteTargets,
  isObviousWrite,
  leadingKeyword
} from '@shared/productionGuard'
export {
  analyzeMongoWrites,
  isObviousMongoWrite,
  valueHasWriteStage,
  type MongoWriteAnalysis
} from '@shared/mongo/classify'

/* ---------- SQL dialects (splitting, both guard classifiers, quoting) ---------- */
export {
  dialectForEngine,
  getDialect,
  mariadbDialect,
  mysqlDialect,
  postgresqlDialect,
  sqliteDialect,
  type DestructiveStatementInfo,
  type SqlDialect,
  type SqlDialectId,
  type SqlStatement,
  type WriteCheck
} from '@shared/dialects'

/* ---------- engines, validation, values ---------- */
export {
  DEFAULT_ENGINE,
  DEFAULT_NETWORK,
  defaultMongoOptions,
  defaultPostgresOptions,
  defaultSqliteOptions,
  ENGINE_IDS,
  ENGINES,
  engineOf,
  hasBackups,
  isEngineId,
  isMysqlFamilyEngine,
  pickableEngines,
  withEngineDefaults,
  type EngineCapabilities,
  type EngineDescriptor
} from '@shared/engines'
export {
  connectionFormErrors,
  connectionSaveError,
  engineAvailabilityError
} from '@shared/connectionValidation'
export { detectMysqlFlavor, isMariaDbVersion } from '@shared/serverFlavor'
export { MongoUriError, mongoUriOf, parseMongoUri } from '@shared/mongo/uri'
export * as mongoShellFormat from '@shared/mongo/shellFormat'

/* ---------- SQLite runtime ---------- */
export {
  getSqliteSpawner,
  inProcessSpawner,
  setSqliteSpawner,
  type ProcessSpawner,
  type WorkerProcess
} from '@main/sqlite/spawner'
export { nodeSqliteSpawner, type NodeSpawnerOptions } from '@main/sqlite/nodeSpawner'
export { sqliteRuntimeProblem, type SqliteRuntime } from '@main/sqlite/runtime'
export { createSqliteFile, MAX_OPEN_SQLITE } from '@main/sqlite/driver'

/* ---------- backups (.vqb / .nb3) ---------- */
export {
  createBackupService,
  readBackupMeta,
  type BackupService,
  type BackupServiceOptions,
  type ProgressReporter
} from '@main/backup/index'
export {
  archiveObjectDdl,
  metaNeedsPassword,
  readArchiveMeta,
  verifyArchive,
  vqbIsEncrypted,
  type ArchiveVerifyResult
} from '@main/backup/archive'
export { checkBackupPassword, MIN_BACKUP_PASSWORD } from '@main/backup/create'

/* ---------- AI assistant (structure only; provider calls through setAiFetch) ---------- */
export { AiService, getAiService, setAiFetch } from '@main/ai/index'
export type { FetchFn } from '@main/ai/adapter'

/* ---------- IPC contract and domain types ---------- */
export { IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS } from '@shared/ipc'
export type {
  IpcArgs,
  IpcChannel,
  IpcEventChannel,
  IpcEventMap,
  IpcInvokeMap,
  IpcResult
} from '@shared/ipc'
export type * from '@shared/types'
