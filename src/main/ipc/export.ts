import type { AppContext } from '../context'
import { getConnectionManager } from '../db/manager'
import { createExportService, type ExportService } from '../export/service'
import type { HandleFn } from './router'

/** Handlers for the export:* channels; logic lives in src/main/export/ (no Electron imports). */
export function registerExportHandlers(ctx: AppContext, handle: HandleFn): void {
  let service: ExportService | null = null
  const get = (): ExportService => (service ??= createExportService(ctx, getConnectionManager(ctx)))
  handle('export:rows', (request) => get().rows(request))
  handle('export:query', (operationId, request) => get().query(operationId, request))
  handle('export:cancel', (operationId) => get().cancel(operationId))
}
