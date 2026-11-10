import type {
  EngineId,
  Environment,
  MongoOptions,
  SqliteAttachedDatabase,
  SqlServerOptions,
  SshConfig,
  SslConfig
} from '@shared/types'

/**
 * Secrets a connections file carried, already decoded. They go only to
 * CredentialStore: never logged, never sent to the renderer.
 */
export interface ConnectionSecrets {
  mysql?: string
  ssh?: string
  sslKey?: string
}

/** One connection read from a file of another manager, before it touches Vortaq state. */
export interface ParsedConnection {
  /** Stable key inside the file (unique per file). */
  key: string
  name: string
  engine: EngineId | null
  engineLabel: string
  unsupportedReason: string | null
  host: string
  port: number
  username: string
  database: string | null
  color: string | null
  environment: Environment
  ssh: SshConfig
  ssl: SslConfig
  secrets: ConnectionSecrets
  warnings: string[]
  /** Navicat only: the connection type as Navicat's plist names it ('MySQL', 'MariaDB'…). */
  navicatType?: string
  /**
   * SQLite: the database file as the source wrote it. `pathNeedsReview` when it is not an
   * absolute path on this OS or the file does not exist here: the connection is saved but
   * cannot open until the user picks the file. The file is never opened or created.
   */
  sqlite?: { filePath: string; pathNeedsReview: boolean; attached: SqliteAttachedDatabase[] }
  /** MongoDB: the options the source names (merged over the defaults on import). */
  mongo?: Partial<MongoOptions>
  /** SQL Server: the options the source names (instance, sign-in, encryption). */
  sqlserver?: Partial<SqlServerOptions>
}

/** Existence check for SQLite files named by an import (injected in tests). */
export type FileExists = (path: string) => boolean

export interface ParsedConnectionFile {
  connections: ParsedConnection[]
  /** Notes for the whole file (shown above the preview). */
  notes: string[]
}

export const NO_SSH: SshConfig = {
  enabled: false,
  host: '',
  port: 22,
  username: '',
  authType: 'password',
  savePassword: false
}

export const NO_SSL: SslConfig = { enabled: false, verifyServer: false }

export const sqliteFileReviewWarning = (name: string): string =>
  `«${name}»: el archivo SQLite no está en este equipo; elígelo al editar la conexión`
export const SQLITE_ENCRYPTED_REASON =
  'Archivo SQLite cifrado: Vortaq no puede abrir bases de datos SQLite cifradas'

export const FOREIGN_PATH_WARNING = 'Ruta de otro equipo: revísala'
export const unsupportedEngine = (label: string): string =>
  `Motor no soportado en esta versión: ${label}`
