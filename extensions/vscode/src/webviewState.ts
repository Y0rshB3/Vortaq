/**
 * State the host sends to each webview (`init` / `state` messages). Types
 * only, shared by the extension host and the webview bundles.
 */
import type {
  ConnectionConfig,
  EngineId,
  Environment,
  QueryStatementResult,
  SchemaRef
} from '@shared/types'

/** The settings the reused desktop components read (settings store). */
export interface WebviewSettings {
  typedConfirmEnvironments: Environment[]
  confirmDestructiveEverywhere: boolean
  defaultRowLimit: number
}

export interface ConnectionFormState {
  /** The connection being edited, or null for a new one. */
  editing: ConnectionConfig | null
  /** Engine preselected for a new connection. */
  engine: EngineId | null
  /** Engines this editor cannot run (SQLite on an old Node). */
  hiddenEngines: EngineId[]
  /** Why SQLite is hidden, or null. */
  sqliteProblem: string | null
  platform: string
  settings: WebviewSettings
}

export interface DocumentsResult {
  database: string
  collection: string
  /** Canonical Extended JSON, one per document. */
  docs: string[]
  total: number | null
  totalExact: boolean
  /** More documents match than the ones shown. */
  truncated: boolean
  durationMs: number
}

export interface ResultsState {
  kind: 'sql' | 'documents'
  /** Bumped on every run: result grids mount fresh. */
  runId: number
  title: string
  connection: ConnectionConfig
  /** «tienda», «tienda.public», «main», or the collection. */
  target: string
  platform: string
  settings: WebviewSettings
  running: boolean
  /** SQL statement results (kind 'sql'). */
  results: QueryStatementResult[]
  /**
   * The whole script of the run: «Exportar › Resultado completo» re-runs one
   * statement alone, so it is refused when another one changed the session.
   */
  script: string | null
  /**
   * Where the statements ran (MySQL database, PostgreSQL `{ database, schema }`;
   * null on SQLite), so the full export reads in the same place.
   */
  context: SchemaRef | null
  /** Wall time of the whole run in milliseconds. */
  totalMs: number | null
  /** Message above the results (stopped, failed to run). */
  notice: string | null
  /** MongoDB documents (kind 'documents'). */
  documents: DocumentsResult | null
  /** «Detener» is offered while running. */
  canStop: boolean
}

/** «Diagrama de relaciones» and «Consulta gráfica» of one database or schema. */
export interface SchemaViewState {
  kind: 'diagram' | 'queryBuilder'
  title: string
  connection: ConnectionConfig
  /** Where the tables are read: MySQL database, PostgreSQL `{ database, schema }`, SQLite alias. */
  ref: SchemaRef
  /** Database (MySQL, SQLite) or schema (PostgreSQL) name. */
  namespace: string
  platform: string
  settings: WebviewSettings
}
