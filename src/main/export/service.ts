/**
 * export:* channels (docs: README «Copiar y exportar resultados»). Engine
 * neutral and free of Electron: the save dialog is the renderer's
 * app:pickSaveFile, and this module only writes the path it is given.
 *
 * - export:rows writes rows the renderer already holds (the grid's loaded
 *   rows or its selection).
 * - export:query re-runs one read-only statement in a new read-only session
 *   (sources.ts) and streams every row to the file, reporting progress as
 *   event:progress (kind 'export'); export:cancel stops the server-side work
 *   and deletes the partial file.
 */
import { basename } from 'node:path'
import { formatCount } from '@shared/jobLog'
import {
  DEFAULT_BATCH_SIZE,
  EXPORT_FORMATS,
  MAX_BATCH_SIZE,
  defaultExportOptions,
  type ExportColumn,
  type ExportOptions,
  type ExportQueryRequest,
  type ExportResult,
  type ExportRowsRequest
} from '@shared/export/types'
import type { CellValue, StorageClass, TypeKind } from '@shared/types'
import type { AppContext } from '../context'
import type { ConnectionManager } from '../db/manager'
import { ExportError, checkTarget } from './sink'
import { openRowSource, type RowSource } from './sources'
import { CANCELLED_EXPORT, arrayBatches, writeExport } from './writer'

/** Minimum time between two progress events of one export. */
const PROGRESS_EVERY_MS = 250

const DIALECTS = new Set(['mysql', 'mariadb', 'postgresql', 'sqlite'])
const DELIMITERS = new Set([',', ';', '\t'])
const TYPE_KINDS = new Set<TypeKind>([
  'integer',
  'decimal',
  'float',
  'boolean',
  'text',
  'binary',
  'date',
  'time',
  'datetime',
  'json',
  'uuid',
  'enum',
  'array',
  'spatial',
  'other'
])

/** The options of a request with defaults for anything missing or out of range. */
export function normalizeOptions(raw: unknown): ExportOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<ExportOptions>
  const base = defaultExportOptions()
  if (!EXPORT_FORMATS.some((f) => f.format === o.format))
    throw new ExportError('Formato de exportación desconocido.')
  const batch = Number(o.batchSize)
  return {
    format: o.format!,
    header: o.header !== false,
    delimiter: DELIMITERS.has(o.delimiter as string) ? o.delimiter! : base.delimiter,
    bom: o.bom === true,
    nullText: typeof o.nullText === 'string' ? o.nullText.slice(0, 100) : '',
    jsonShape: o.jsonShape === 'arrays' ? 'arrays' : 'objects',
    table: typeof o.table === 'string' && o.table.trim() ? o.table.trim() : base.table,
    schema: typeof o.schema === 'string' && o.schema.trim() ? o.schema.trim() : null,
    batchSize:
      Number.isInteger(batch) && batch >= 1 ? Math.min(batch, MAX_BATCH_SIZE) : DEFAULT_BATCH_SIZE,
    dialect: DIALECTS.has(o.dialect as string) ? o.dialect! : base.dialect,
    ...(Array.isArray(o.sqlNames) && o.sqlNames.every((n) => typeof n === 'string')
      ? { sqlNames: o.sqlNames }
      : {}),
    ...(typeof o.sheetName === 'string' ? { sheetName: o.sheetName } : {})
  }
}

function normalizeColumns(raw: unknown): ExportColumn[] {
  if (!Array.isArray(raw) || !raw.length)
    throw new ExportError('El resultado no tiene columnas: no hay nada que exportar.')
  return raw.map((c) => {
    const col = (c ?? {}) as Partial<ExportColumn>
    if (typeof col.name !== 'string') throw new ExportError('Columna no válida en la exportación.')
    return {
      name: col.name,
      ...(typeof col.type === 'string' ? { type: col.type } : {}),
      ...(TYPE_KINDS.has(col.typeKind as TypeKind) ? { typeKind: col.typeKind } : {})
    }
  })
}

function normalizeRows(raw: unknown): CellValue[][] {
  if (!Array.isArray(raw) || !raw.every(Array.isArray))
    throw new ExportError('Filas no válidas en la exportación.')
  return raw as CellValue[][]
}

export interface ExportService {
  rows(request: ExportRowsRequest): Promise<ExportResult>
  query(operationId: string, request: ExportQueryRequest): Promise<ExportResult>
  cancel(operationId: string): Promise<void>
  /** Operation ids running now (tests). */
  running(): string[]
}

interface Running {
  controller: AbortController
  source: RowSource | null
}

export function createExportService(
  ctx: Pick<AppContext, 'connections' | 'emit'>,
  manager: ConnectionManager
): ExportService {
  const operations = new Map<string, Running>()

  return {
    async rows(request) {
      if (!request || typeof request !== 'object') throw new ExportError('Petición no válida.')
      const filePath = await checkTarget(request.filePath)
      const options = normalizeOptions(request.options)
      const columns = normalizeColumns(request.columns)
      const rows = normalizeRows(request.rows)
      const storage = Array.isArray(request.storage)
        ? (request.storage as StorageClass[][])
        : undefined
      return writeExport(filePath, columns, arrayBatches(rows, storage), options)
    },

    async query(operationId, request) {
      if (typeof operationId !== 'string' || !operationId)
        throw new ExportError('Falta el identificador de la operación.')
      if (operations.has(operationId))
        throw new ExportError('Ya hay una exportación en curso con ese identificador.')
      if (!request || typeof request !== 'object') throw new ExportError('Petición no válida.')
      const running: Running = { controller: new AbortController(), source: null }
      operations.set(operationId, running)
      const signal = running.controller.signal
      let current = 0
      let lastEmit = 0
      const emit = (phase: string, message: string, done: boolean, error?: string): void =>
        ctx.emit('event:progress', {
          operationId,
          kind: 'export',
          phase,
          current,
          total: null,
          message,
          done,
          ...(error ? { error } : {})
        })
      try {
        const filePath = await checkTarget(request.filePath)
        const options = normalizeOptions(request.options)
        emit('list', 'Ejecutando la consulta en una sesión de solo lectura…', false)
        const source = await openRowSource(
          ctx,
          manager,
          request.connectionId,
          request.source,
          `export-${operationId}`,
          signal
        )
        running.source = source
        try {
          if (signal.aborted) throw new ExportError(CANCELLED_EXPORT)
          const result = await writeExport(filePath, source.columns, source.batches, options, {
            signal,
            progress: (rows) => {
              current = rows
              const now = Date.now()
              if (now - lastEmit < PROGRESS_EVERY_MS) return
              lastEmit = now
              emit(
                'rows',
                `${formatCount(rows)} ${rows === 1 ? 'fila escrita' : 'filas escritas'}`,
                false
              )
            }
          })
          current = result.rows
          emit(
            'done',
            `Exportadas ${formatCount(result.rows)} ${result.rows === 1 ? 'fila' : 'filas'} a ${basename(filePath)}`,
            true
          )
          return result
        } finally {
          await source.close()
        }
      } catch (err) {
        const cancelled = signal.aborted
        const message = cancelled
          ? CANCELLED_EXPORT
          : err instanceof Error
            ? err.message
            : String(err)
        emit(cancelled ? 'cancelled' : 'error', message, true, message)
        throw cancelled ? new ExportError(CANCELLED_EXPORT) : err
      } finally {
        operations.delete(operationId)
      }
    },

    async cancel(operationId) {
      const running = operations.get(operationId)
      if (!running || running.controller.signal.aborted) return
      // The source stops the statement on the server (KILL QUERY, pg_cancel_backend, or
      // ends the SQLite reader); the writer then deletes the partial file.
      running.controller.abort()
    },

    running: () => [...operations.keys()]
  }
}
