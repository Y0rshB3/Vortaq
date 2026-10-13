import type { AppContext } from '../context'
import { createBackupHandlers } from '../backup/handlers'
import { createBackupService, type BackupService } from '../backup/index'
import type { HandleFn } from './router'

/** Handlers for the backups:* channels; logic lives in src/main/backup/handlers.ts. */
export function registerBackupsHandlers(ctx: AppContext, handle: HandleFn): void {
  let service: Promise<BackupService> | null = null
  const getService = (): Promise<BackupService> => {
    // The connection manager is loaded lazily so registering handlers stays cheap.
    service ??= import('../db/manager').then(({ getSessionFactory }) =>
      createBackupService(ctx, getSessionFactory(ctx))
    )
    service.catch(() => {
      service = null
    })
    return service
  }
  const h = createBackupHandlers(ctx, getService)

  handle('backups:list', h.list)
  handle('backups:meta', h.meta)
  handle('backups:objectDdl', h.objectDdl)
  handle('backups:create', h.create)
  handle('backups:restore', h.restore)
  handle('backups:delete', h.delete)
  handle('backups:cancel', h.cancel)
  handle('backups:exportSql', h.exportSql)
  handle('backups:skippedObjects', async (connectionId, schema, format) => {
    const [{ getSessionFactory }, { skippedObjectsWarning }] = await Promise.all([
      import('../db/manager'),
      import('../backup/create')
    ])
    return skippedObjectsWarning(
      getSessionFactory(ctx),
      connectionId,
      schema,
      format === 'vqb' || format === 'sql' ? format : 'nb3'
    )
  })
}
