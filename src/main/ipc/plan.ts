import type { PlanRequest } from '@shared/plan/types'
import type { AppContext } from '../context'
import { DbUserError } from '../db/errors'
import { getConnectionManager } from '../db/manager'
import { executionPlan } from '../plan/service'
import type { HandleFn } from './router'

/** The request as sent: anything malformed is refused before a session is taken. */
function planRequest(raw: unknown): PlanRequest {
  const r = (raw ?? {}) as Partial<PlanRequest>
  const schema = r.schema
  const validSchema =
    schema === null ||
    schema === undefined ||
    typeof schema === 'string' ||
    (typeof schema === 'object' &&
      typeof (schema as { database?: unknown }).database === 'string' &&
      typeof (schema as { schema?: unknown }).schema === 'string')
  if (typeof r.sql !== 'string' || typeof r.actual !== 'boolean' || !validSchema)
    throw new DbUserError('Petición de plan de ejecución no válida.')
  return { sql: r.sql, actual: r.actual, schema: schema ?? null }
}

/** db:plan; logic in src/main/plan/ (no Electron imports, also in the core). */
export function registerPlanHandlers(ctx: AppContext, handle: HandleFn): void {
  handle('db:plan', (connectionId, request) =>
    executionPlan(getConnectionManager(ctx), connectionId, planRequest(request))
  )
}
