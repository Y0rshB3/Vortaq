/**
 * Engine UI registry (docs/multi-engine-design.md, section 8.1). MySQL,
 * MariaDB, PostgreSQL, SQLite and SQL Server have renderer modules; MongoDB has its own
 * views instead (no SQL dialect). Capability checks read the shared descriptors
 * (`@shared/engines`), so they work for every engine, with or without a UI.
 */
import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import {
  DEFAULT_ENGINE,
  ENGINES,
  type EngineCapabilities,
  type EngineDescriptor
} from '@shared/engines'
import type { EngineId, ServerRuntime } from '@shared/types'
import { useConnectionsStore } from '@renderer/stores/connections'
import { descriptorOf } from './capabilities'
import { mariadbUi } from './mariadb'
import { mysqlUi } from './mysql'
import { postgresqlUi } from './postgresql'
import { sqliteUi } from './sqlite'
import { sqlserverUi } from './sqlserver'
import type { EngineUi } from './types'

export type { DdlSupport, EngineUi, TablePlanner, TypeCatalog, UserSqlBuilder } from './types'
export { mariadbUi } from './mariadb'
export { mysqlUi } from './mysql'
export { postgresqlUi } from './postgresql'
export { sqliteUi } from './sqlite'
export { sqlserverUi } from './sqlserver'
export { can, descriptorOf, groupsFor } from './capabilities'

const UIS: Partial<Record<EngineId, EngineUi>> = {
  mysql: mysqlUi,
  mariadb: mariadbUi,
  postgresql: postgresqlUi,
  sqlite: sqliteUi,
  sqlserver: sqlserverUi
}

/** Renderer module of an engine; throws when this build does not include it. */
export function engineUi(engine: EngineId = DEFAULT_ENGINE): EngineUi {
  const ui = UIS[engine]
  if (!ui) {
    const label = ENGINES[engine]?.label ?? String(engine)
    throw new Error(`${label} todavía no está disponible en esta versión de Vortaq.`)
  }
  return ui
}

export interface EngineContext {
  descriptor: EngineDescriptor | null
  capabilities: EngineCapabilities | null
  /** Null when this build has no renderer module for the engine. */
  ui: EngineUi | null
  /** Facts reported by connections:open (absent until the connection is open). */
  runtime: ServerRuntime | undefined
}

/** Engine of a connection, its static capabilities and the runtime facts of its open session. */
export function useEngine(
  connectionId: MaybeRefOrGetter<string | null | undefined>
): ComputedRef<EngineContext> {
  const connections = useConnectionsStore()
  return computed(() => {
    const id = toValue(connectionId)
    const descriptor = descriptorOf(id ? connections.get(id) : undefined)
    let ui: EngineUi | null = null
    try {
      ui = descriptor ? engineUi(descriptor.id) : null
    } catch {
      ui = null
    }
    return {
      descriptor,
      capabilities: descriptor?.capabilities ?? null,
      ui,
      runtime: id ? connections.serverInfo[id]?.runtime : undefined
    }
  })
}

/**
 * Renderer module of a connection's engine, for views that only open on a
 * connected engine (designer, DDL editor, users). Reading it for an engine
 * without a module throws the same "not available" message main uses.
 */
export function useEngineUi(
  connectionId: MaybeRefOrGetter<string | null | undefined>
): ComputedRef<EngineUi> {
  const engine = useEngine(connectionId)
  return computed(() => {
    const { descriptor, ui } = engine.value
    if (ui) return ui
    throw new Error(
      `${descriptor?.label ?? 'Este motor'} todavía no está disponible en esta versión de Vortaq.`
    )
  })
}
