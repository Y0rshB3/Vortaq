/**
 * The .xlsx package: [Content_Types].xml, the relationships, the workbook,
 * the styles (src/shared/export/xlsx.ts) and the worksheet, which the export
 * wrote to a temporary file and is deflated into the ZIP as a stream, so the
 * whole sheet is never in memory.
 */
import { ZIP_ENTRY_TOO_LARGE, ZipWriter } from '../backup/vqb/zip'
import { xlsxStaticParts } from '@shared/export/xlsx'
import { ExportError, removeQuietly } from './sink'

export const XLSX_TOO_LARGE =
  'La hoja de Excel supera 4 GB: exporta en CSV, que no tiene ese límite.'

/** Writes the package to `partPath`; returns its size in bytes. */
export async function packXlsx(partPath: string, sheetPath: string, name: string): Promise<number> {
  await removeQuietly(partPath)
  const zip = await ZipWriter.create(partPath)
  try {
    for (const part of xlsxStaticParts(name))
      await zip.add(part.path, Buffer.from(part.xml, 'utf8'))
    await zip.addFile('xl/worksheets/sheet1.xml', sheetPath)
    return await zip.finish()
  } catch (err) {
    await zip.abort()
    await removeQuietly(partPath)
    if (err instanceof Error && err.message === ZIP_ENTRY_TOO_LARGE)
      throw new ExportError(XLSX_TOO_LARGE)
    throw err
  }
}
