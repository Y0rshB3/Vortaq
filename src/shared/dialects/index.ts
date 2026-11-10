/**
 * SQL dialect registry (docs/multi-engine-design.md, section 6). MySQL,
 * MariaDB, PostgreSQL, SQLite and SQL Server ship dialects.
 * MongoDB never has one (its classifier lives elsewhere).
 */
import { engineOf } from '../engines'
import type { EngineId } from '../types'
import { mariadbDialect } from './mariadb'
import { mysqlDialect } from './mysql'
import { postgresqlDialect } from './postgresql'
import { sqliteDialect } from './sqlite'
import { sqlserverDialect } from './sqlserver'
import type { SqlDialect, SqlDialectId } from './types'

export type {
  DestructiveStatementInfo,
  LexRules,
  SqlDialect,
  SqlDialectId,
  SqlStatement,
  WriteCheck
} from './types'
export { mariadbDialect } from './mariadb'
export { mysqlDialect } from './mysql'
export { postgresqlDialect } from './postgresql'
export { sqliteDialect } from './sqlite'
export { sqlserverDialect } from './sqlserver'

const DIALECTS: Partial<Record<SqlDialectId, SqlDialect>> = {
  mysql: mysqlDialect,
  mariadb: mariadbDialect,
  postgresql: postgresqlDialect,
  sqlite: sqliteDialect,
  sqlserver: sqlserverDialect
}

/** The dialect with this id; throws when this build does not include it. */
export function getDialect(id: SqlDialectId): SqlDialect {
  const dialect = DIALECTS[id]
  if (!dialect) {
    throw new Error(`El dialecto SQL «${id}» todavía no está disponible en esta versión.`)
  }
  return dialect
}

/**
 * The SQL dialect of an engine, or null for engines without SQL (MongoDB).
 * Throws for a SQL engine whose dialect is not in this build yet.
 */
export function dialectForEngine(engine: EngineId): SqlDialect | null {
  const id = engineOf({ engine }).capabilities.sqlDialect
  return id ? getDialect(id) : null
}

/** `SELECT * FROM <target>` limited to `rows` rows: TOP (n) on SQL Server, LIMIT n elsewhere. */
export function selectFirstRows(dialect: SqlDialect, target: string, rows: number): string {
  return dialect.id === 'sqlserver'
    ? `SELECT TOP (${rows}) * FROM ${target}`
    : `SELECT * FROM ${target} LIMIT ${rows}`
}
