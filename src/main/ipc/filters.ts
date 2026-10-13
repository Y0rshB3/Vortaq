import type { SchemaRef } from '@shared/types'
import type { AppContext } from '../context'
import { FilterProfilesRepo } from '../storage/filterProfiles'
import type { HandleFn } from './router'

/**
 * Storage key of a namespace: the MySQL database name as before (existing
 * profiles keep matching); PostgreSQL `{ database, schema }` joined with a
 * separator no identifier contains.
 */
export function schemaKey(schema: SchemaRef): string {
  return typeof schema === 'string' ? schema : `${schema.database}\u0001${schema.schema}`
}

/** Filter profiles of the table data filter builder (Navicat "Guardar perfil"). */
export function registerFiltersHandlers(ctx: AppContext, handle: HandleFn): void {
  const repo = new FilterProfilesRepo(ctx.userDataPath)
  handle('filters:list', (connectionId, schema, table) =>
    repo.list(connectionId, schemaKey(schema), table)
  )
  handle('filters:save', (connectionId, schema, table, name, filter) =>
    repo.save(connectionId, schemaKey(schema), table, name, filter)
  )
  handle('filters:delete', (connectionId, schema, table, name) =>
    repo.delete(connectionId, schemaKey(schema), table, name)
  )
}
