/**
 * Writes rows to a file in one of the export formats. Rows arrive in
 * batches (an in-memory array for «lo cargado», a server cursor for the full
 * result), are formatted one by one with the shared formatters and written
 * in ~64 KB chunks, so memory stays bounded whatever the row count. XLSX
 * goes through a temporary worksheet file that is then deflated into the
 * package (xlsx.ts). The file only takes its name once complete.
 */
import { performance } from 'node:perf_hooks'
import { textFormatter, type RowFormatter, type TextFormat } from '@shared/export/formats'
import type { ExportColumn, ExportOptions, ExportResult } from '@shared/export/types'
import { XLSX_MAX_COLUMNS, XLSX_TOO_MANY_COLUMNS, xlsxSheetFormatter } from '@shared/export/xlsx'
import type { CellValue, StorageClass } from '@shared/types'
import { ExportError, FileSink, PART_SUFFIX, publish, removeQuietly } from './sink'
import { packXlsx } from './xlsx'

export interface RowBatch {
  rows: CellValue[][]
  /** SQLite: storage class of each cell. */
  storage?: StorageClass[][]
}

export interface WriteHooks {
  /** Called after each batch with the data rows written so far. */
  progress?(rows: number): void
  /** Stops the export between rows (cancel). */
  signal?: AbortSignal
}

export const CANCELLED_EXPORT = 'Exportación cancelada: no se ha creado el archivo.'

const CHUNK = 64 * 1024

function textFormatOf(options: ExportOptions): TextFormat {
  switch (options.format) {
    case 'csv':
      return 'csv'
    case 'txt':
      return 'tsv'
    case 'json':
      return 'json'
    case 'sql':
      return 'sql'
    case 'markdown':
      return 'markdown'
    case 'html':
      return 'html'
    default:
      throw new ExportError(`Formato de exportación desconocido: ${String(options.format)}`)
  }
}

function formatterFor(columns: ExportColumn[], options: ExportOptions): RowFormatter {
  return textFormatter(textFormatOf(options), columns, {
    header: options.header,
    delimiter: options.delimiter,
    bom: options.bom,
    nullText: options.nullText,
    jsonShape: options.jsonShape,
    table: options.table,
    schema: options.schema ?? null,
    batchSize: options.batchSize,
    dialect: options.dialect,
    sqlNames: options.sqlNames,
    eol: '\r\n',
    title: options.table || options.sheetName || 'Resultado'
  })
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExportError(CANCELLED_EXPORT)
}

/** Formats every batch into `sink`; returns the data rows written. */
async function pump(
  formatter: RowFormatter,
  batches: AsyncIterable<RowBatch>,
  sink: FileSink,
  hooks: WriteHooks
): Promise<number> {
  let buffer = formatter.begin()
  let rows = 0
  for await (const batch of batches) {
    checkAborted(hooks.signal)
    for (let i = 0; i < batch.rows.length; i++) {
      buffer += formatter.row(batch.rows[i], batch.storage?.[i])
      rows++
      if (buffer.length >= CHUNK) {
        await sink.write(buffer)
        buffer = ''
      }
    }
    hooks.progress?.(rows)
  }
  checkAborted(hooks.signal)
  buffer += formatter.end()
  await sink.write(buffer)
  return rows
}

/**
 * Writes `batches` to `filePath` in `options.format`. On any failure (or a
 * cancel through `hooks.signal`) the part files are deleted and the chosen
 * file is left as it was.
 */
export async function writeExport(
  filePath: string,
  columns: ExportColumn[],
  batches: AsyncIterable<RowBatch>,
  options: ExportOptions,
  hooks: WriteHooks = {}
): Promise<ExportResult> {
  const started = performance.now()
  if (!columns.length)
    throw new ExportError('El resultado no tiene columnas: no hay nada que exportar.')
  const part = filePath + PART_SUFFIX
  if (options.format === 'xlsx') {
    if (columns.length > XLSX_MAX_COLUMNS) throw new ExportError(XLSX_TOO_MANY_COLUMNS)
    const sheetPath = `${filePath}.sheet${PART_SUFFIX}`
    const sheet = xlsxSheetFormatter(columns, {
      header: options.header,
      nullText: options.nullText
    })
    const sink = await FileSink.open(sheetPath)
    try {
      await pump(sheet, batches, sink, hooks)
      await sink.close()
      checkAborted(hooks.signal)
      const bytes = await packXlsx(part, sheetPath, options.sheetName || options.table || '')
      checkAborted(hooks.signal)
      await publish(part, filePath)
      return {
        filePath,
        rows: sheet.stats.rows,
        bytes,
        durationMs: Math.round(performance.now() - started),
        truncatedCells: sheet.stats.truncatedCells
      }
    } catch (err) {
      await removeQuietly(part)
      throw asExportError(err)
    } finally {
      await sink.discard()
    }
  }
  const formatter = formatterFor(columns, options)
  const sink = await FileSink.open(part)
  try {
    const rows = await pump(formatter, batches, sink, hooks)
    await sink.close()
    checkAborted(hooks.signal)
    await publish(part, filePath)
    return {
      filePath,
      rows,
      bytes: sink.bytes,
      durationMs: Math.round(performance.now() - started),
      truncatedCells: 0
    }
  } catch (err) {
    await sink.discard()
    throw asExportError(err)
  }
}

/** Errors thrown while formatting (Excel limits) keep their message. */
function asExportError(err: unknown): Error {
  if (err instanceof Error) return err
  return new ExportError(String(err))
}

/** In-memory rows as one batch. */
export async function* arrayBatches(
  rows: CellValue[][],
  storage?: StorageClass[][],
  size = 1000
): AsyncGenerator<RowBatch> {
  for (let i = 0; i < rows.length; i += size)
    yield {
      rows: rows.slice(i, i + size),
      ...(storage ? { storage: storage.slice(i, i + size) } : {})
    }
}
