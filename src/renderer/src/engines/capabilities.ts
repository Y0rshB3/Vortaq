/**
 * Capability checks for the renderer: pure functions over the shared engine
 * descriptors (no store or view imports), so stores, composables and
 * components can all use them. For MySQL every check passes, which keeps the
 * MySQL menus, toolbar, tree and pickers exactly as they were.
 */
import {
  DEFAULT_ENGINE,
  ENGINES,
  engineOf,
  isEngineId,
  type BooleanCapability,
  type EngineDescriptor
} from '@shared/engines'
import type { SqlDialectId } from '@shared/dialects/types'
import type { EngineId } from '@shared/types'
import { ALL_GROUPS, type GroupKind } from '@renderer/utils/objectTypes'

type EngineHolder = { engine?: EngineId | null } | undefined | null

/**
 * Descriptor of a connection's engine. A connection without `engine` (or one
 * the renderer has not loaded) is MySQL, as before multi-engine; an unknown
 * engine yields null, which grants no capability.
 */
export function descriptorOf(connection: EngineHolder): EngineDescriptor | null {
  if (!connection) return ENGINES[DEFAULT_ENGINE]
  try {
    return engineOf(connection)
  } catch {
    return null
  }
}

/** True when the connection's engine has the capability. */
export function can(connection: EngineHolder, capability: BooleanCapability): boolean {
  return !!descriptorOf(connection)?.capabilities[capability]
}

const RENDERER_GROUPS: ReadonlySet<string> = new Set(ALL_GROUPS)

/**
 * Tree groups under a database, in the engine's order, limited to the groups
 * this renderer can list and to the engine's capabilities. MySQL gets GROUPS.
 */
export function groupsFor(connection: EngineHolder): GroupKind[] {
  const descriptor = descriptorOf(connection)
  if (!descriptor) return []
  const caps = descriptor.capabilities
  return descriptor.groups.filter((g): g is GroupKind => {
    if (!RENDERER_GROUPS.has(g)) return false
    if (g === 'backups') return caps.supportsBackupsNb3 || caps.supportsBackupsVqb
    if (g === 'events') return caps.events
    if (g === 'functions') return caps.routines
    if (g === 'sequences') return caps.sequences
    if (g === 'materializedViews') return caps.materializedViews
    if (g === 'triggers') return caps.triggers
    return true
  })
}

/** SQL dialect id of an engine for copy/export literals and parsing (MySQL when unknown or MongoDB). */
export function sqlDialectIdOf(engine: EngineId | null | undefined): SqlDialectId {
  const id = engine && isEngineId(engine) ? ENGINES[engine].capabilities.sqlDialect : null
  return id ?? 'mysql'
}
