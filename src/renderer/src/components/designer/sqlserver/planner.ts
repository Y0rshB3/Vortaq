/**
 * SQL Server table designer (docs/sqlserver-design.md, «Diseñador»): the
 * generic TableDraft (ColumnsEditor, IndexesEditor, ForeignKeysEditor) turned
 * into T-SQL.
 *
 * - IDENTITY(1,1) for «A.I.»; an existing column cannot gain or lose IDENTITY
 *   (SQL Server has no ALTER for it): that is a problem, never a silent rebuild.
 * - Defaults are named constraints (DF_<tabla>_<columna>); changing one drops
 *   the old constraint by its real name and adds the new one.
 * - Renames go through sp_rename; type, length and NULL changes are ALTER COLUMN.
 * - Comments are MS_Description extended properties.
 * - The view runs the statements in one transaction with XACT_ABORT ON, so
 *   any error undoes the whole change.
 */
import { quoteIdent, quoteString } from '@shared/dialects/sqlserver'
import type { ColumnInfo, ForeignKeyInfo, TableStructure } from '@shared/types'
import type { DesignerAlter, DesignerDrop } from '@renderer/components/designer/alterTable'
import {
  nextId,
  type ColumnDraft,
  type ForeignKeyDraft,
  type IndexDraft,
  type TableDraft
} from '@renderer/utils/tableDesigner'

/** Column types offered by the designer (any other type can be typed). */
export const SQLSERVER_COLUMN_TYPES = [
  'int',
  'bigint',
  'smallint',
  'tinyint',
  'bit',
  'decimal(18,2)',
  'numeric(18,2)',
  'money',
  'float',
  'real',
  'nvarchar(50)',
  'nvarchar(255)',
  'nvarchar(max)',
  'varchar(50)',
  'varchar(255)',
  'varchar(max)',
  'nchar(10)',
  'char(10)',
  'date',
  'datetime2(7)',
  'datetime2(3)',
  'datetimeoffset(7)',
  'datetime',
  'smalldatetime',
  'time(7)',
  'uniqueidentifier',
  'varbinary(max)',
  'varbinary(50)',
  'xml',
  'geography',
  'geometry',
  'hierarchyid',
  'sql_variant'
]

const q = (name: string): string => quoteIdent(name, true)
const target = (schema: string, table: string): string => `${q(schema)}.${q(table)}`
const norm = (v: string | null | undefined): string => (v ?? '').trim()

/** Real DEFAULT constraint name the driver adds to SQL Server columns (introspect.ts). */
const defaultConstraintOf = (c: ColumnInfo | undefined): string | null =>
  (c as (ColumnInfo & { defaultConstraint?: string | null }) | undefined)?.defaultConstraint ?? null

export function msEmptyTable(): TableDraft {
  return {
    name: '',
    engine: '',
    collation: '',
    comment: '',
    autoIncrement: null,
    columns: [
      {
        id: nextId(),
        originalName: null,
        name: 'id',
        columnType: 'int',
        nullable: false,
        defaultValue: null,
        autoIncrement: true,
        primaryKey: true,
        unsigned: false,
        collation: null,
        comment: ''
      }
    ],
    indexes: [],
    foreignKeys: []
  }
}

export function msEmptyColumn(): ColumnDraft {
  return {
    id: nextId(),
    originalName: null,
    name: '',
    columnType: 'nvarchar(255)',
    nullable: true,
    defaultValue: null,
    autoIncrement: false,
    primaryKey: false,
    unsigned: false,
    collation: null,
    comment: ''
  }
}

export function msDraftFromStructure(structure: TableStructure): TableDraft {
  const pk = new Set(structure.indexes.find((i) => i.primary)?.columns ?? [])
  return {
    name: structure.name,
    engine: '',
    collation: '',
    comment: structure.comment,
    autoIncrement: null,
    columns: structure.columns
      .filter((c) => !c.hidden)
      .map((c) => ({
        id: nextId(),
        originalName: c.name,
        name: c.name,
        columnType: c.columnType,
        nullable: c.nullable,
        defaultValue: c.defaultValue,
        autoIncrement: c.autoIncrement === true,
        primaryKey: pk.has(c.name),
        unsigned: false,
        collation: c.collation,
        comment: c.comment
      })),
    indexes: structure.indexes
      .filter((i) => !i.primary)
      .map((i) => ({
        id: nextId(),
        originalName: i.name,
        name: i.name,
        unique: i.unique,
        type: i.type,
        columns: [...i.columns],
        comment: ''
      })),
    foreignKeys: structure.foreignKeys.map((f) => ({
      id: nextId(),
      originalName: f.name,
      ...f,
      columns: [...f.columns],
      referencedColumns: [...f.referencedColumns]
    }))
  }
}

/** A default typed in the designer as SQL: numbers, N'…'/'…', functions, NULL and (…) stay; text is quoted. */
export function defaultExpression(raw: string): string {
  const v = raw.trim()
  if (
    /^-?\d+(\.\d+)?$/.test(v) ||
    /^N?'.*'$/s.test(v) ||
    /^\(.*\)$/s.test(v) ||
    /^0x[0-9a-f]*$/i.test(v) ||
    /^(NULL|CURRENT_TIMESTAMP|CURRENT_USER|SESSION_USER|SYSTEM_USER)$/i.test(v) ||
    /^[A-Za-z_][\w.]*\s*\(.*\)$/s.test(v)
  )
    return v
  return quoteString(raw)
}

const defaultName = (table: string, column: string): string => `DF_${table}_${column}`

function columnDefinition(c: ColumnDraft, table: string, withDefault = true): string {
  let line = `${q(c.name)} ${c.columnType.trim()}`
  if (c.autoIncrement) line += ' IDENTITY(1,1)'
  if (c.collation) line += ` COLLATE ${c.collation}`
  line += c.nullable && !c.primaryKey ? ' NULL' : ' NOT NULL'
  if (withDefault && !c.autoIncrement && c.defaultValue !== null && norm(c.defaultValue) !== '')
    line += ` CONSTRAINT ${q(defaultName(table, c.name))} DEFAULT (${defaultExpression(c.defaultValue)})`
  return line
}

function fkDefinition(f: ForeignKeyDraft | ForeignKeyInfo, schema: string): string {
  let sql = `CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${target(f.referencedSchema || schema, f.referencedTable)} (${f.referencedColumns.map(q).join(', ')})`
  if (f.onDelete && f.onDelete !== 'NO ACTION' && f.onDelete !== 'RESTRICT')
    sql += ` ON DELETE ${f.onDelete}`
  if (f.onUpdate && f.onUpdate !== 'NO ACTION' && f.onUpdate !== 'RESTRICT')
    sql += ` ON UPDATE ${f.onUpdate}`
  return sql
}

function createIndex(i: IndexDraft, schema: string, table: string): string {
  return `CREATE ${i.unique ? 'UNIQUE ' : ''}NONCLUSTERED INDEX ${q(i.name)} ON ${target(schema, table)} (${i.columns.map(q).join(', ')})`
}

/** sp_addextendedproperty / sp_updateextendedproperty / sp_dropextendedproperty for MS_Description. */
function describe(
  action: 'add' | 'update' | 'drop',
  schema: string,
  table: string,
  column: string | null,
  text: string
): string {
  const value = action === 'drop' ? '' : `, @value = ${quoteString(text)}`
  const level2 = column ? `, @level2type = N'COLUMN', @level2name = ${quoteString(column)}` : ''
  return `EXEC sys.sp_${action}extendedproperty @name = N'MS_Description'${value}, @level0type = N'SCHEMA', @level0name = ${quoteString(schema)}, @level1type = N'TABLE', @level1name = ${quoteString(table)}${level2}`
}

function commentChange(
  before: string,
  after: string,
  schema: string,
  table: string,
  column: string | null
): string | null {
  if (norm(before) === norm(after)) return null
  if (!norm(after)) return describe('drop', schema, table, column, '')
  return describe(norm(before) ? 'update' : 'add', schema, table, column, after)
}

function columnProblems(c: ColumnDraft, problems: string[]): void {
  if (!c.name.trim()) problems.push('Hay un campo sin nombre.')
  if (!c.columnType.trim()) problems.push(`Falta el tipo del campo «${c.name}».`)
  if (
    c.autoIncrement &&
    !/^(tinyint|smallint|int|bigint|decimal\(\s*\d+\s*,\s*0\s*\)|numeric\(\s*\d+\s*,\s*0\s*\))$/i.test(
      c.columnType.trim()
    )
  )
    problems.push(`IDENTITY solo vale para enteros (o decimal con escala 0): «${c.name}».`)
}

export function msBuildCreate(schema: string, draft: TableDraft): string {
  return msBuildCreatePlan(schema, draft).statements.join(';\n') + ';'
}

export function msBuildCreatePlan(schema: string, draft: TableDraft): DesignerAlter {
  const problems: string[] = []
  if (!draft.name.trim()) problems.push('Escribe el nombre de la tabla.')
  if (draft.columns.filter((c) => c.autoIncrement).length > 1)
    problems.push('Una tabla de SQL Server solo puede tener una columna IDENTITY.')
  draft.columns.forEach((c) => columnProblems(c, problems))
  const lines = draft.columns.map((c) => `  ${columnDefinition(c, draft.name)}`)
  const pk = draft.columns.filter((c) => c.primaryKey)
  if (pk.length)
    lines.push(
      `  CONSTRAINT ${q(`PK_${draft.name}`)} PRIMARY KEY (${pk.map((c) => q(c.name)).join(', ')})`
    )
  for (const f of draft.foreignKeys) lines.push(`  ${fkDefinition(f, schema)}`)
  const statements = [`CREATE TABLE ${target(schema, draft.name)} (\n${lines.join(',\n')}\n)`]
  for (const i of draft.indexes) statements.push(createIndex(i, schema, draft.name))
  if (norm(draft.comment)) statements.push(describe('add', schema, draft.name, null, draft.comment))
  for (const c of draft.columns)
    if (norm(c.comment)) statements.push(describe('add', schema, draft.name, c.name, c.comment))
  return { statements, risks: [], problems, drops: [], transactional: true }
}

const sameList = (a: string[], b: string[]): boolean => a.join('\u0000') === b.join('\u0000')

export function msBuildAlter(original: TableStructure, draft: TableDraft): DesignerAlter {
  const schema = original.schema
  const statements: string[] = []
  const risks: string[] = []
  const problems: string[] = []
  const drops: DesignerDrop[] = []
  let table = original.name
  const t = (): string => target(schema, table)

  if (!draft.name.trim()) problems.push('Escribe el nombre de la tabla.')
  draft.columns.forEach((c) => columnProblems(c, problems))
  const byOriginal = new Map(original.columns.map((c) => [c.name, c]))
  const kept = draft.columns.filter((c) => c.originalName && byOriginal.has(c.originalName))
  const keptOrder = kept.map((c) => c.originalName!)
  const originalOrder = original.columns
    .filter((c) => keptOrder.includes(c.name))
    .map((c) => c.name)
  if (!sameList(keptOrder, originalOrder))
    problems.push('SQL Server no puede cambiar el orden de los campos de una tabla existente.')

  // Rename the table first: every later statement uses the new name.
  if (draft.name.trim() && draft.name !== original.name) {
    statements.push(
      `EXEC sp_rename ${quoteString(`${q(schema)}.${q(original.name)}`)}, ${quoteString(draft.name)}`
    )
    table = draft.name
  }

  const originalPk = original.indexes.find((i) => i.primary)
  const draftPk = draft.columns.filter((c) => c.primaryKey).map((c) => c.originalName ?? c.name)
  const pkChanged =
    !sameList(originalPk?.columns ?? [], draftPk) ||
    draft.columns.some((c) => c.primaryKey && c.originalName !== null && c.originalName !== c.name)

  // Foreign keys and indexes that change or reference changed columns are dropped first.
  const draftFkByOriginal = new Map(
    draft.foreignKeys.filter((f) => f.originalName).map((f) => [f.originalName!, f])
  )
  const droppedFks: ForeignKeyInfo[] = []
  for (const fk of original.foreignKeys) {
    const d = draftFkByOriginal.get(fk.name)
    const same =
      d &&
      d.name === fk.name &&
      sameList(d.columns, fk.columns) &&
      d.referencedTable === fk.referencedTable &&
      (d.referencedSchema || schema) === fk.referencedSchema &&
      sameList(d.referencedColumns, fk.referencedColumns) &&
      d.onDelete === fk.onDelete &&
      d.onUpdate === fk.onUpdate
    if (!same) {
      statements.push(`ALTER TABLE ${t()} DROP CONSTRAINT ${q(fk.name)}`)
      droppedFks.push(fk)
      if (!d) drops.push({ kind: 'FOREIGN KEY', name: fk.name })
    }
  }
  const draftIndexByOriginal = new Map(
    draft.indexes.filter((i) => i.originalName).map((i) => [i.originalName!, i])
  )
  const droppedIndexes = new Set<string>()
  for (const index of original.indexes.filter((i) => !i.primary)) {
    const d = draftIndexByOriginal.get(index.name)
    if (
      d &&
      d.name === index.name &&
      d.unique === index.unique &&
      sameList(d.columns, index.columns)
    )
      continue
    statements.push(
      index.constraint
        ? `ALTER TABLE ${t()} DROP CONSTRAINT ${q(index.name)}`
        : `DROP INDEX ${q(index.name)} ON ${t()}`
    )
    droppedIndexes.add(index.name)
    if (!d) drops.push({ kind: 'INDEX', name: index.name })
  }
  if (pkChanged && originalPk) {
    statements.push(
      `ALTER TABLE ${t()} DROP CONSTRAINT ${q(originalPk.constraint ?? originalPk.name)}`
    )
    if (!draftPk.length) drops.push({ kind: 'PRIMARY KEY', name: originalPk.name })
    risks.push(
      'Se cambia la clave primaria: las claves foráneas de otras tablas que la usen impiden el cambio.'
    )
  }

  // Dropped columns (their default constraint first).
  const draftOriginals = new Set(
    draft.columns.map((c) => c.originalName).filter(Boolean) as string[]
  )
  for (const c of original.columns.filter((c) => !c.hidden && !draftOriginals.has(c.name))) {
    const df = defaultConstraintOf(c)
    if (df) statements.push(`ALTER TABLE ${t()} DROP CONSTRAINT ${q(df)}`)
    statements.push(`ALTER TABLE ${t()} DROP COLUMN ${q(c.name)}`)
    drops.push({ kind: 'COLUMN', name: c.name })
    risks.push(`Se borra el campo «${c.name}» con sus datos.`)
  }

  // Changed and renamed columns.
  for (const d of kept) {
    const info = byOriginal.get(d.originalName!)!
    if (d.autoIncrement !== (info.autoIncrement === true))
      problems.push(
        `SQL Server no puede añadir ni quitar IDENTITY de un campo existente («${d.name}»): crea un campo nuevo y copia los datos.`
      )
    if (d.name !== info.name)
      statements.push(
        `EXEC sp_rename ${quoteString(`${q(schema)}.${q(table)}.${q(info.name)}`)}, ${quoteString(d.name)}, N'COLUMN'`
      )
    const typeChanged = norm(d.columnType).toLowerCase() !== norm(info.columnType).toLowerCase()
    const nullChanged = (d.nullable && !d.primaryKey) !== info.nullable
    const collationChanged = norm(d.collation) !== norm(info.collation)
    if ((typeChanged || nullChanged || collationChanged) && !info.generated) {
      let alter = `ALTER TABLE ${t()} ALTER COLUMN ${q(d.name)} ${d.columnType.trim()}`
      if (d.collation) alter += ` COLLATE ${d.collation}`
      alter += d.nullable && !d.primaryKey ? ' NULL' : ' NOT NULL'
      statements.push(alter)
      if (typeChanged)
        risks.push(
          `Se cambia el tipo de «${d.name}»: los valores que no quepan harán fallar el cambio.`
        )
      if (nullChanged && !d.nullable)
        risks.push(`«${d.name}» deja de admitir NULL: falla si alguna fila lo tiene vacío.`)
    }
    if (norm(d.defaultValue) !== norm(info.defaultValue)) {
      const df = defaultConstraintOf(info)
      if (df) statements.push(`ALTER TABLE ${t()} DROP CONSTRAINT ${q(df)}`)
      if (d.defaultValue !== null && norm(d.defaultValue))
        statements.push(
          `ALTER TABLE ${t()} ADD CONSTRAINT ${q(defaultName(table, d.name))} DEFAULT (${defaultExpression(d.defaultValue)}) FOR ${q(d.name)}`
        )
    }
    const comment = commentChange(info.comment, d.comment, schema, table, d.name)
    if (comment) statements.push(comment)
  }

  // New columns.
  for (const d of draft.columns.filter((c) => !c.originalName)) {
    statements.push(`ALTER TABLE ${t()} ADD ${columnDefinition(d, table)}`)
    if (!d.nullable && !d.autoIncrement && !norm(d.defaultValue))
      risks.push(
        `El campo nuevo «${d.name}» no admite NULL y no tiene valor por defecto: falla si la tabla ya tiene filas.`
      )
    if (norm(d.comment)) statements.push(describe('add', schema, table, d.name, d.comment))
  }

  // Primary key, indexes and foreign keys (re)created.
  if (pkChanged && draft.columns.some((c) => c.primaryKey))
    statements.push(
      `ALTER TABLE ${t()} ADD CONSTRAINT ${q(originalPk?.constraint ?? originalPk?.name ?? `PK_${table}`)} PRIMARY KEY (${draft.columns
        .filter((c) => c.primaryKey)
        .map((c) => q(c.name))
        .join(', ')})`
    )
  for (const i of draft.indexes)
    if (!i.originalName || droppedIndexes.has(i.originalName))
      statements.push(createIndex(i, schema, table))
  for (const f of draft.foreignKeys)
    if (!f.originalName || droppedFks.some((x) => x.name === f.originalName))
      statements.push(`ALTER TABLE ${t()} ADD ${fkDefinition(f, schema)}`)

  const tableComment = commentChange(original.comment, draft.comment, schema, table, null)
  if (tableComment) statements.push(tableComment)
  return { statements, risks, problems, drops, transactional: true }
}

export const msTablePlanner = {
  emptyTable: msEmptyTable,
  draftFromStructure: msDraftFromStructure,
  buildCreate: msBuildCreate,
  buildAlter: msBuildAlter
}

/** What the designer runs: every statement in one transaction that any error rolls back. */
export function msTransactionScript(statements: string[]): string {
  return [
    'SET XACT_ABORT ON;',
    'BEGIN TRANSACTION;',
    ...statements.map((s) => `${s};`),
    'COMMIT TRANSACTION;'
  ].join('\n')
}
