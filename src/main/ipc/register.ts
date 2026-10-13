import type { AppContext } from '../context'
import { registerAiHandlers } from './ai'
import { registerAppHandlers } from './app'
import { registerBackupsHandlers } from './backups'
import { registerConnectionsHandlers } from './connections'
import { registerDbHandlers } from './db'
import { registerFiltersHandlers } from './filters'
import { registerImportersHandlers } from './importers'
import { registerJobsHandlers } from './jobs'
import { registerNavicatHandlers } from './navicat'
import { registerTourHandlers } from './tour'
import { registerUpdatesHandlers } from './updates'
import { handle } from './typed'

/**
 * Each feature module owns src/main/ipc/<area>.ts and exports
 * register<Area>Handlers(ctx). Keep this list in sync with IpcInvokeMap.
 * The modules without Electron imports (connections, db, filters, backups,
 * ai) take the HandleFn too, so src/core can register them outside Electron.
 */
export function registerAllHandlers(ctx: AppContext): void {
  // First: it snapshots whether the profile already held data before this start.
  registerTourHandlers(ctx)
  registerAppHandlers(ctx)
  registerConnectionsHandlers(ctx, handle)
  registerDbHandlers(ctx, handle)
  registerFiltersHandlers(ctx, handle)
  registerBackupsHandlers(ctx, handle)
  registerJobsHandlers(ctx)
  registerNavicatHandlers(ctx)
  registerImportersHandlers(ctx)
  registerUpdatesHandlers(ctx)
  registerAiHandlers(ctx, handle)
}
