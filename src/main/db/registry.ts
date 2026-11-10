/**
 * Engine → driver registry. Drivers are imported lazily so an engine nobody
 * opens never loads its client library. MySQL and MariaDB (one mysql2 driver), PostgreSQL,
 * SQLite, MongoDB and SQL Server ship drivers.
 */
import { engineAvailabilityError } from '@shared/connectionValidation'
import { engineOf } from '@shared/engines'
import type { EngineId } from '@shared/types'
import type { Driver } from './driver'
import { DbUserError } from './errors'

type DriverLoader = () => Promise<Driver>

const LOADERS: Partial<Record<EngineId, DriverLoader>> = {
  mysql: () => import('../mysql/driver').then((m) => m.mysqlDriver),
  mariadb: () => import('../mysql/driver').then((m) => m.mysqlDriver),
  postgresql: () => import('../postgres/driver').then((m) => m.postgresDriver),
  sqlite: () => import('../sqlite/driver').then((m) => m.sqliteDriver),
  mongodb: () => import('../mongo/driver').then((m) => m.mongoDriver),
  sqlserver: () => import('../sqlserver/driver').then((m) => m.sqlserverDriver)
}

/** True when this build has a driver for the engine. */
export function hasDriver(engine: EngineId): boolean {
  return LOADERS[engine] !== undefined && engineOf({ engine }).available
}

/**
 * The driver of an engine. Throws the same Spanish message as the connection
 * dialog for an engine that this build cannot open.
 */
export async function getDriver(engine: EngineId): Promise<Driver> {
  const problem = engineAvailabilityError({ engine })
  const load = LOADERS[engine]
  if (problem || !load) {
    throw new DbUserError(
      problem ?? `${engineOf({ engine }).label} todavía no está disponible en esta versión.`,
      'E_ENGINE_UNAVAILABLE'
    )
  }
  return load()
}
