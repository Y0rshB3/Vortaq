import type { SchemaRef, TableInfo, TableStructure } from '@shared/types'
import { buildSchemaModel, type SchemaModel } from './model'

/** Tables read for one diagram or query builder (alphabetically; the rest are left out). */
export const MAX_DIAGRAM_TABLES = 300
/** Structures read at the same time. */
const CONCURRENCY = 6

export interface ModelSource {
  tables(ref: SchemaRef): Promise<TableInfo[]>
  structure(ref: SchemaRef, table: string): Promise<TableStructure>
}

export interface LoadedModel {
  model: SchemaModel
  /** More than MAX_DIAGRAM_TABLES tables: only the first ones were read. */
  truncated: boolean
  /** Tables whose structure could not be read (left out of the model). */
  failed: string[]
}

/**
 * Reads the structure of every table of a namespace (a few at a time) and
 * builds the model. A table that fails is left out, never the whole diagram.
 */
export async function loadSchemaModel(
  source: ModelSource,
  ref: SchemaRef,
  namespace: string,
  onProgress?: (done: number, total: number) => void
): Promise<LoadedModel> {
  const names = (await source.tables(ref)).map((t) => t.name).sort((a, b) => a.localeCompare(b))
  const take = names.slice(0, MAX_DIAGRAM_TABLES)
  const structures: (TableStructure | null)[] = new Array(take.length).fill(null)
  const failed: string[] = []
  let next = 0
  let done = 0
  onProgress?.(0, take.length)
  const worker = async (): Promise<void> => {
    while (next < take.length) {
      const i = next++
      try {
        structures[i] = await source.structure(ref, take[i])
      } catch {
        failed.push(take[i])
      }
      onProgress?.(++done, take.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, take.length) }, worker))
  return {
    model: buildSchemaModel(
      structures.filter((s): s is TableStructure => !!s),
      namespace
    ),
    truncated: names.length > take.length,
    failed: failed.sort((a, b) => a.localeCompare(b))
  }
}
