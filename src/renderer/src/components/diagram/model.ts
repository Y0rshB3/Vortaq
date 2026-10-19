import type { TableStructure } from '@shared/types'
import { isPrimaryKeyColumn } from '@renderer/utils/columnMeta'

/**
 * The tables of one namespace (MySQL/MariaDB database, PostgreSQL schema,
 * SQLite database) and the foreign keys between them, as the relationship
 * diagram and the visual query builder draw them. Built only from structure
 * (names, types, keys): never row values.
 */
export interface ModelColumn {
  name: string
  type: string
  primaryKey: boolean
  /** Part of a foreign key of this table. */
  foreignKey: boolean
  nullable: boolean
}

export interface ModelTable {
  name: string
  columns: ModelColumn[]
}

export interface ModelRelation {
  /** Constraint name (unique per relation within the model). */
  name: string
  /** Referencing table and its key columns. */
  from: string
  fromColumns: string[]
  /** Referenced table and the columns the key points at, aligned with `fromColumns`. */
  to: string
  toColumns: string[]
  /** Every referencing column accepts NULL (drawn dashed: the row may have no parent). */
  optional: boolean
}

export interface SchemaModel {
  tables: ModelTable[]
  relations: ModelRelation[]
  /** Foreign keys that point outside the namespace (counted, not drawn). */
  external: number
}

/**
 * Builds the model from the tables' structures. A relation is kept when the
 * referenced table is one of `structures` in the same namespace (compared
 * ignoring case: MySQL on macOS/Windows folds names); the others only count
 * as `external`.
 */
export function buildSchemaModel(
  structures: readonly TableStructure[],
  namespace: string
): SchemaModel {
  const byLower = new Map(structures.map((s) => [s.name.toLowerCase(), s.name]))
  const tables: ModelTable[] = []
  const relations: ModelRelation[] = []
  let external = 0
  const names = new Set<string>()
  for (const s of structures) {
    const fkColumns = new Set(s.foreignKeys.flatMap((f) => f.columns.map((c) => c.toLowerCase())))
    const pkFromIndex = new Set(
      s.indexes
        .filter((i) => i.primary || i.name === 'PRIMARY')
        .flatMap((i) => i.columns.map((c) => c.toLowerCase()))
    )
    tables.push({
      name: s.name,
      columns: s.columns.map((c) => ({
        name: c.name,
        type: c.columnType || c.dataType,
        primaryKey: isPrimaryKeyColumn(c) || pkFromIndex.has(c.name.toLowerCase()),
        foreignKey: fkColumns.has(c.name.toLowerCase()),
        nullable: c.nullable
      }))
    })
    for (const fk of s.foreignKeys) {
      const sameNamespace =
        !fk.referencedSchema || fk.referencedSchema.toLowerCase() === namespace.toLowerCase()
      const to = sameNamespace ? byLower.get(fk.referencedTable.toLowerCase()) : undefined
      if (!to || fk.columns.length !== fk.referencedColumns.length) {
        external++
        continue
      }
      // Unique name: SQLite keys have none, and two tables may reuse one (MySQL allows it per table).
      let name = fk.name || `${s.name}_${fk.columns.join('_')}_fk`
      for (let n = 2; names.has(name); n++) name = `${fk.name || s.name}#${n}`
      names.add(name)
      const columns = new Map(s.columns.map((c) => [c.name.toLowerCase(), c]))
      relations.push({
        name,
        from: s.name,
        fromColumns: [...fk.columns],
        to,
        toColumns: [...fk.referencedColumns],
        optional: fk.columns.every((c) => columns.get(c.toLowerCase())?.nullable ?? false)
      })
    }
  }
  return { tables, relations, external }
}

/** Relations that touch `table` (either end). */
export function relationsOf(model: Pick<SchemaModel, 'relations'>, table: string): ModelRelation[] {
  return model.relations.filter((r) => r.from === table || r.to === table)
}
