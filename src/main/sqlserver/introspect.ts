/**
 * SQL Server introspection (docs/sqlserver-design.md, «Estructura»): only the
 * catalog views of the session's database (sys.*), always schema-qualified by
 * parameter, never INFORMATION_SCHEMA (it misses identity, computed columns,
 * filtered and included index columns). Every function runs on a pooled
 * session opened in the database it describes.
 */
import { quoteIdent } from '@shared/dialects/sqlserver'
import type {
  ColumnInfo,
  ConstraintInfo,
  DataTypeInfo,
  DatabaseInfo,
  EngineObjectType,
  ForeignKeyInfo,
  IndexInfo,
  ObjectRef,
  ObjectSummary,
  RoutineInfo,
  SchemaInfo,
  TableInfo,
  TableStructure,
  TriggerInfo,
  ViewInfo
} from '@shared/types'
import { MsUserError } from './errors'
import type { MsSession } from './session'
import { sqlServerTypeKind } from './values'

export type MsQueryable = Pick<MsSession, 'query' | 'exec'>
type Row = Record<string, unknown>

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const textOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** `[schema].[name]`, always bracketed (DDL and OBJECT_ID arguments). */
export const bracketed = (schema: string, name: string): string =>
  `${quoteIdent(schema, true)}.${quoteIdent(name, true)}`

/** System schemas: guest, INFORMATION_SCHEMA, sys and the fixed database-role schemas. */
export const SYSTEM_SCHEMA_SQL = '(s.schema_id IN (2, 3, 4) OR s.schema_id BETWEEN 16384 AND 16399)'

/** MS_Description of an object (minor 0) or a column. */
const DESCRIPTION = (major: string, minor: string): string =>
  `(SELECT CAST(ep.value AS nvarchar(4000)) FROM sys.extended_properties ep
     WHERE ep.class = 1 AND ep.major_id = ${major} AND ep.minor_id = ${minor} AND ep.name = N'MS_Description')`

/* ---------- databases and schemas ---------- */

export async function listDatabases(s: MsQueryable, showSystem: boolean): Promise<DatabaseInfo[]> {
  const rows = await s.query<Row>(
    `SELECT d.name, d.collation_name AS collation
       FROM sys.databases d
      WHERE (@p1 = 1 OR d.database_id > 4) AND d.state = 0 AND HAS_DBACCESS(d.name) = 1
      ORDER BY d.name`,
    [showSystem ? 1 : 0]
  )
  return rows.map((r) => ({ name: text(r.name), characterSet: '', collation: text(r.collation) }))
}

export async function listSchemas(s: MsQueryable, showSystem: boolean): Promise<SchemaInfo[]> {
  const rows = await s.query<Row>(
    `SELECT s.name, USER_NAME(s.principal_id) AS owner,
            CAST(CASE WHEN ${SYSTEM_SCHEMA_SQL} THEN 1 ELSE 0 END AS bit) AS system,
            (SELECT CAST(ep.value AS nvarchar(4000)) FROM sys.extended_properties ep
              WHERE ep.class = 3 AND ep.major_id = s.schema_id AND ep.name = N'MS_Description') AS comment
       FROM sys.schemas s
      WHERE @p1 = 1 OR NOT ${SYSTEM_SCHEMA_SQL}
      ORDER BY CASE WHEN s.name = N'dbo' THEN 0 ELSE 1 END, s.name`,
    [showSystem ? 1 : 0]
  )
  return rows.map((r) => ({
    name: text(r.name),
    owner: text(r.owner),
    comment: text(r.comment),
    system: r.system === true
  }))
}

/* ---------- tables, views, routines, triggers ---------- */

export async function listTables(s: MsQueryable, schema: string): Promise<TableInfo[]> {
  const rows = await s.query<Row>(
    `SELECT t.name, t.create_date, t.modify_date, t.temporal_type, t.is_memory_optimized,
            (SELECT SUM(p.rows) FROM sys.partitions p
              WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)) AS rows,
            (SELECT SUM(a.total_pages) * 8192 FROM sys.partitions p
               JOIN sys.allocation_units a ON a.container_id = p.partition_id
              WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)) AS data_length,
            (SELECT SUM(a.total_pages) * 8192 FROM sys.partitions p
               JOIN sys.allocation_units a ON a.container_id = p.partition_id
              WHERE p.object_id = t.object_id AND p.index_id > 1) AS index_length,
            ${DESCRIPTION('t.object_id', '0')} AS comment
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = @p1 AND t.is_ms_shipped = 0
      ORDER BY t.name`,
    [schema]
  )
  return rows.map((r) => ({
    name: text(r.name),
    engine:
      num(r.temporal_type) === 2
        ? 'con versiones'
        : num(r.temporal_type) === 1
          ? 'historial'
          : r.is_memory_optimized === true
            ? 'en memoria'
            : null,
    rows: num(r.rows),
    dataLength: num(r.data_length),
    indexLength: num(r.index_length),
    autoIncrement: null,
    createTime: textOrNull(r.create_date),
    updateTime: textOrNull(r.modify_date),
    collation: null,
    comment: text(r.comment)
  }))
}

export async function listViews(s: MsQueryable, schema: string): Promise<ViewInfo[]> {
  const rows = await s.query<Row>(
    `SELECT v.name, v.create_date, USER_NAME(OBJECTPROPERTY(v.object_id, 'OwnerId')) AS owner,
            OBJECTPROPERTY(v.object_id, 'IsSchemaBound') AS schemabound
       FROM sys.views v JOIN sys.schemas s ON s.schema_id = v.schema_id
      WHERE s.name = @p1 AND v.is_ms_shipped = 0
      ORDER BY v.name`,
    [schema]
  )
  return rows.map((r) => ({
    name: text(r.name),
    definer: text(r.owner),
    security: num(r.schemabound) === 1 ? 'SCHEMABINDING' : '',
    updatable: false,
    createTime: textOrNull(r.create_date)
  }))
}

const PROCEDURE_TYPES = ['P', 'PC', 'X']
const FUNCTION_TYPES = ['FN', 'IF', 'TF', 'FS', 'FT', 'AF']

export async function listRoutines(s: MsQueryable, schema: string): Promise<RoutineInfo[]> {
  const rows = await s.query<Row>(
    `SELECT o.name, RTRIM(o.type) AS type, o.create_date, o.modify_date,
            USER_NAME(OBJECTPROPERTY(o.object_id, 'OwnerId')) AS owner,
            (SELECT TYPE_NAME(p.user_type_id) FROM sys.parameters p
              WHERE p.object_id = o.object_id AND p.parameter_id = 0) AS returns,
            ${DESCRIPTION('o.object_id', '0')} AS comment
       FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = @p1 AND o.is_ms_shipped = 0
        AND o.type IN (${[...PROCEDURE_TYPES, ...FUNCTION_TYPES].map((t) => `'${t}'`).join(', ')})
      ORDER BY o.name`,
    [schema]
  )
  return rows.map((r) => {
    const type = text(r.type)
    const procedure = PROCEDURE_TYPES.includes(type)
    const table = type === 'IF' || type === 'TF' || type === 'FT'
    return {
      name: text(r.name),
      type: procedure ? 'PROCEDURE' : 'FUNCTION',
      definer: text(r.owner),
      returns: procedure ? null : table ? 'TABLE' : textOrNull(r.returns),
      created: textOrNull(r.create_date),
      modified: textOrNull(r.modify_date),
      comment: text(r.comment),
      signature: '',
      kind: procedure ? 'procedure' : table ? 'table function' : 'function'
    }
  })
}

export async function listTriggers(s: MsQueryable, schema: string): Promise<TriggerInfo[]> {
  const rows = await s.query<Row>(
    `SELECT tr.name, o.name AS [table], tr.is_instead_of_trigger AS instead, tr.is_disabled AS disabled,
            STUFF((SELECT N', ' + te.type_desc FROM sys.trigger_events te
                    WHERE te.object_id = tr.object_id ORDER BY te.type FOR XML PATH('')), 1, 2, N'') AS events
       FROM sys.triggers tr
       JOIN sys.objects o ON o.object_id = tr.parent_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = @p1 AND tr.parent_class = 1 AND tr.is_ms_shipped = 0
      ORDER BY o.name, tr.name`,
    [schema]
  )
  return rows.map((r) => ({
    name: text(r.name),
    table: text(r.table),
    event: text(r.events),
    timing: r.instead === true ? 'INSTEAD OF' : 'AFTER',
    statement: r.disabled === true ? 'deshabilitado' : '',
    definer: ''
  }))
}

/** Objects of a group without a dedicated channel (db:objects): sequences. */
export async function listObjects(
  s: MsQueryable,
  schema: string,
  type: EngineObjectType
): Promise<ObjectSummary[]> {
  if (type !== 'sequence') return []
  const rows = await s.query<Row>(
    `SELECT q.name, TYPE_NAME(q.user_type_id) AS data_type,
            CAST(q.current_value AS nvarchar(64)) AS current_value,
            CAST(q.increment AS nvarchar(64)) AS increment,
            ${DESCRIPTION('q.object_id', '0')} AS comment
       FROM sys.sequences q JOIN sys.schemas s ON s.schema_id = q.schema_id
      WHERE s.name = @p1
      ORDER BY q.name`,
    [schema]
  )
  return rows.map((r) => ({
    name: text(r.name),
    type,
    schema,
    kind: text(r.data_type),
    comment: text(r.comment),
    detail: `actual ${text(r.current_value)}, incremento ${text(r.increment)}`
  }))
}

/* ---------- columns ---------- */

/** The type as written in DDL: nvarchar(50), decimal(10,2), datetime2(3), varbinary(max)… */
export function columnTypeOf(r: {
  type: string
  base: string
  maxLength: number
  precision: number
  scale: number
  userDefined: boolean
}): string {
  if (r.userDefined) return r.type
  const t = r.base.toLowerCase()
  const length = (chars: number): string => (r.maxLength === -1 ? 'max' : String(chars))
  switch (t) {
    case 'varchar':
    case 'char':
    case 'varbinary':
    case 'binary':
      return `${t}(${length(r.maxLength)})`
    case 'nvarchar':
    case 'nchar':
      return `${t}(${length(r.maxLength / 2)})`
    case 'decimal':
    case 'numeric':
      return `${t}(${r.precision},${r.scale})`
    case 'datetime2':
    case 'datetimeoffset':
    case 'time':
      return `${t}(${r.scale})`
    case 'float':
      return r.precision === 53 ? 'float' : `float(${r.precision})`
    default:
      return t
  }
}

/** SQL Server wraps stored defaults in parentheses: ((0)) → 0, (getdate()) → getdate(). */
export function unwrapDefault(definition: string | null): string | null {
  if (definition === null) return null
  let out = definition.trim()
  for (;;) {
    if (!out.startsWith('(') || !out.endsWith(')')) return out
    // Only when the outer pair encloses everything: (a)+(b) stays.
    let depth = 0
    let enclosing = true
    for (let i = 0; i < out.length; i++) {
      const ch = out[i]
      if (ch === "'") {
        const close = out.indexOf("'", i + 1)
        i = close < 0 ? out.length : close
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0 && i < out.length - 1) {
          enclosing = false
          break
        }
      }
    }
    if (!enclosing) return out
    out = out.slice(1, -1).trim()
  }
}

const COLUMNS_SQL = `
  SELECT c.column_id AS ordinal, c.name, TYPE_NAME(c.user_type_id) AS type, TYPE_NAME(c.system_type_id) AS base,
         CAST(CASE WHEN ty.is_user_defined = 1 THEN 1 ELSE 0 END AS bit) AS user_defined,
         SCHEMA_NAME(ty.schema_id) AS type_schema,
         c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed, c.is_rowguidcol,
         c.collation_name, c.is_hidden, c.generated_always_type,
         OBJECT_DEFINITION(c.default_object_id) AS default_def,
         dc.name AS default_name,
         cc.definition AS computed_def, cc.is_persisted,
         CAST(ic.seed_value AS nvarchar(64)) AS seed, CAST(ic.increment_value AS nvarchar(64)) AS incr,
         CAST(CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i
                 JOIN sys.index_columns k ON k.object_id = i.object_id AND k.index_id = i.index_id
                WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND k.column_id = c.column_id)
              THEN 1 ELSE 0 END AS bit) AS pk,
         ${DESCRIPTION('c.object_id', 'c.column_id')} AS comment
    FROM sys.columns c
    JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
    LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
    LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
   WHERE c.object_id = OBJECT_ID(@p1)
   ORDER BY c.column_id`

export interface MsColumnInfo extends ColumnInfo {
  /** Name of the DEFAULT constraint (ALTER needs it to change the default). */
  defaultConstraint: string | null
  /** Computed column expression, as stored. */
  computed: string | null
  identitySeed: string | null
  identityIncrement: string | null
}

export async function listColumns(
  s: MsQueryable,
  schema: string,
  table: string
): Promise<MsColumnInfo[]> {
  const rows = await s.query<Row>(COLUMNS_SQL, [bracketed(schema, table)])
  return rows.map((r) => {
    const userDefined = r.user_defined === true
    const base = text(r.base)
    const columnType = userDefined
      ? `${quoteIdent(text(r.type_schema))}.${quoteIdent(text(r.type))}`
      : columnTypeOf({
          type: text(r.type),
          base,
          maxLength: Number(r.max_length),
          precision: Number(r.precision),
          scale: Number(r.scale),
          userDefined: false
        })
    const identity = r.is_identity === true
    const computed = r.is_computed === true
    const rowversion = base === 'timestamp'
    const periodColumn = num(r.generated_always_type) !== null && num(r.generated_always_type) !== 0
    const defaultValue = unwrapDefault(textOrNull(r.default_def))
    const extra = identity
      ? `IDENTITY(${text(r.seed)},${text(r.incr)})`
      : computed
        ? r.is_persisted === true
          ? 'calculada (PERSISTED)'
          : 'calculada'
        : rowversion
          ? 'rowversion'
          : periodColumn
            ? 'GENERATED ALWAYS'
            : ''
    return {
      name: text(r.name),
      ordinal: Number(r.ordinal),
      columnType,
      dataType: base,
      nullable: r.is_nullable === true,
      key: r.pk === true ? 'PRI' : '',
      defaultValue,
      extra,
      characterSet: null,
      collation: textOrNull(r.collation_name),
      comment: text(r.comment),
      primaryKey: r.pk === true,
      autoIncrement: identity,
      generated:
        computed || rowversion || periodColumn
          ? computed && r.is_persisted !== true
            ? 'virtual'
            : 'stored'
          : null,
      typeKind: sqlServerTypeKind(base),
      hidden: r.is_hidden === true,
      hasDefault: defaultValue !== null || identity || computed || rowversion || periodColumn,
      identity: identity ? 'always' : null,
      sqlType: columnType,
      defaultConstraint: textOrNull(r.default_name),
      computed: textOrNull(r.computed_def),
      identitySeed: identity ? text(r.seed) : null,
      identityIncrement: identity ? text(r.incr) : null
    }
  })
}

export async function primaryKeyColumns(
  s: MsQueryable,
  schema: string,
  table: string
): Promise<string[]> {
  const rows = await s.query<Row>(
    `SELECT c.name FROM sys.indexes i
       JOIN sys.index_columns k ON k.object_id = i.object_id AND k.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = k.object_id AND c.column_id = k.column_id
      WHERE i.object_id = OBJECT_ID(@p1) AND i.is_primary_key = 1
      ORDER BY k.key_ordinal`,
    [bracketed(schema, table)]
  )
  return rows.map((r) => text(r.name))
}

/* ---------- structure ---------- */

interface MsIndex extends IndexInfo {
  clustered: boolean
  descending: boolean[]
  included: string[]
  filter: string | null
  uniqueConstraint: boolean
}

async function listIndexes(s: MsQueryable, objectName: string): Promise<MsIndex[]> {
  const rows = await s.query<Row>(
    `SELECT i.index_id, i.name, i.type_desc, i.is_unique, i.is_primary_key, i.is_unique_constraint,
            i.filter_definition, c.name AS col, k.is_descending_key AS descending, k.is_included_column AS included,
            k.key_ordinal, k.index_column_id
       FROM sys.indexes i
       JOIN sys.index_columns k ON k.object_id = i.object_id AND k.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = k.object_id AND c.column_id = k.column_id
      WHERE i.object_id = OBJECT_ID(@p1) AND i.index_id > 0 AND i.is_hypothetical = 0
      ORDER BY i.is_primary_key DESC, i.name, k.is_included_column, k.key_ordinal, k.index_column_id`,
    [objectName]
  )
  const byId = new Map<number, MsIndex>()
  for (const r of rows) {
    const id = Number(r.index_id)
    let index = byId.get(id)
    if (!index) {
      const typeDesc = text(r.type_desc)
      index = {
        name: text(r.name),
        unique: r.is_unique === true,
        type: typeDesc,
        columns: [],
        comment: '',
        primary: r.is_primary_key === true,
        constraint:
          r.is_primary_key === true || r.is_unique_constraint === true ? text(r.name) : null,
        clustered: typeDesc === 'CLUSTERED' || typeDesc === 'CLUSTERED COLUMNSTORE',
        descending: [],
        included: [],
        filter: textOrNull(r.filter_definition),
        uniqueConstraint: r.is_unique_constraint === true
      }
      byId.set(id, index)
    }
    if (r.included === true) index.included.push(text(r.col))
    else if (index.type.includes('COLUMNSTORE') && Number(r.key_ordinal) === 0)
      index.columns.push(text(r.col))
    else {
      index.columns.push(text(r.col))
      index.descending.push(r.descending === true)
    }
  }
  return [...byId.values()]
}

const ACTION: Record<string, string> = {
  NO_ACTION: 'NO ACTION',
  CASCADE: 'CASCADE',
  SET_NULL: 'SET NULL',
  SET_DEFAULT: 'SET DEFAULT'
}

async function listForeignKeys(s: MsQueryable, objectName: string): Promise<ForeignKeyInfo[]> {
  const rows = await s.query<Row>(
    `SELECT fk.object_id, fk.name, pc.name AS col, rs.name AS ref_schema, rt.name AS ref_table,
            rc.name AS ref_col, fk.update_referential_action_desc AS on_update,
            fk.delete_referential_action_desc AS on_delete
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns k ON k.constraint_object_id = fk.object_id
       JOIN sys.columns pc ON pc.object_id = k.parent_object_id AND pc.column_id = k.parent_column_id
       JOIN sys.tables rt ON rt.object_id = k.referenced_object_id
       JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
       JOIN sys.columns rc ON rc.object_id = k.referenced_object_id AND rc.column_id = k.referenced_column_id
      WHERE fk.parent_object_id = OBJECT_ID(@p1)
      ORDER BY fk.name, k.constraint_column_id`,
    [objectName]
  )
  const byId = new Map<number, ForeignKeyInfo>()
  for (const r of rows) {
    const id = Number(r.object_id)
    let fk = byId.get(id)
    if (!fk) {
      fk = {
        name: text(r.name),
        columns: [],
        referencedSchema: text(r.ref_schema),
        referencedTable: text(r.ref_table),
        referencedColumns: [],
        onUpdate: ACTION[text(r.on_update)] ?? 'NO ACTION',
        onDelete: ACTION[text(r.on_delete)] ?? 'NO ACTION'
      }
      byId.set(id, fk)
    }
    fk.columns.push(text(r.col))
    fk.referencedColumns.push(text(r.ref_col))
  }
  return [...byId.values()]
}

async function listChecks(s: MsQueryable, objectName: string): Promise<ConstraintInfo[]> {
  const rows = await s.query<Row>(
    `SELECT cc.name, cc.definition, COL_NAME(cc.parent_object_id, cc.parent_column_id) AS col
       FROM sys.check_constraints cc
      WHERE cc.parent_object_id = OBJECT_ID(@p1)
      ORDER BY cc.name`,
    [objectName]
  )
  return rows.map((r) => ({
    name: text(r.name),
    type: 'check' as const,
    definition: `CHECK ${text(r.definition)}`,
    columns: r.col ? [text(r.col)] : []
  }))
}

export async function tableStructure(
  s: MsQueryable,
  database: string,
  schema: string,
  table: string
): Promise<TableStructure> {
  const objectName = bracketed(schema, table)
  const [info] = await s.query<Row>(
    `SELECT o.type, t.temporal_type, IDENT_CURRENT(@p1) AS ident,
            ${DESCRIPTION('o.object_id', '0')} AS comment,
            hs.name AS history_schema, ht.name AS history_table
       FROM sys.objects o
       LEFT JOIN sys.tables t ON t.object_id = o.object_id
       LEFT JOIN sys.tables ht ON ht.object_id = t.history_table_id
       LEFT JOIN sys.schemas hs ON hs.schema_id = ht.schema_id
      WHERE o.object_id = OBJECT_ID(@p1)`,
    [objectName]
  )
  if (!info) throw new MsUserError(`No se encontró la tabla ${schema}.${table}`, 'E_MS_NOT_FOUND')
  const view = text(info.type).trim() === 'V'
  const columns = await listColumns(s, schema, table)
  const indexes = await listIndexes(s, objectName)
  const foreignKeys = view ? [] : await listForeignKeys(s, objectName)
  const checks = view ? [] : await listChecks(s, objectName)
  const constraints: ConstraintInfo[] = [
    ...indexes
      .filter((i) => i.constraint)
      .map((i) => ({
        name: i.name,
        type: i.primary ? ('primary' as const) : ('unique' as const),
        definition: `${i.primary ? 'PRIMARY KEY' : 'UNIQUE'} ${i.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} (${i.columns.map((c) => quoteIdent(c, true)).join(', ')})`,
        columns: i.columns
      })),
    ...checks
  ]
  const structure: TableStructure = {
    schema,
    name: table,
    database,
    tableType: view ? 'VIEW' : 'BASE TABLE',
    kind: view ? 'view' : num(info.temporal_type) === 2 ? 'system-versioned' : 'table',
    columns,
    indexes: indexes.map(
      ({ clustered: _c, descending: _d, included: _i, filter: _f, uniqueConstraint: _u, ...i }) => i
    ),
    foreignKeys,
    engine: null,
    collation: null,
    comment: text(info.comment),
    autoIncrement: num(info.ident),
    createSql: '',
    constraints,
    options: {
      historyTable: info.history_table
        ? `${text(info.history_schema)}.${text(info.history_table)}`
        : ''
    }
  }
  structure.createSql = view
    ? await moduleDefinition(s, schema, table)
    : buildTableDdl(schema, table, columns, indexes, foreignKeys, checks)
  return structure
}

/* ---------- DDL ---------- */

/** CREATE TABLE plus its keys, indexes and constraints, SSMS-style (bracketed names). */
export function buildTableDdl(
  schema: string,
  table: string,
  columns: MsColumnInfo[],
  indexes: MsIndex[],
  foreignKeys: ForeignKeyInfo[],
  checks: ConstraintInfo[]
): string {
  const q = (name: string): string => quoteIdent(name, true)
  const target = bracketed(schema, table)
  const lines = columns.map((c) => {
    if (c.computed !== null)
      return `  ${q(c.name)} AS ${c.computed}${c.generated === 'stored' ? ' PERSISTED' : ''}`
    let line = `  ${q(c.name)} ${c.columnType}`
    if (c.identitySeed !== null) line += ` IDENTITY(${c.identitySeed},${c.identityIncrement})`
    if (c.collation) line += ` COLLATE ${c.collation}`
    line += c.nullable ? ' NULL' : ' NOT NULL'
    if (c.defaultValue !== null)
      line += `${c.defaultConstraint ? ` CONSTRAINT ${q(c.defaultConstraint)}` : ''} DEFAULT (${c.defaultValue})`
    return line
  })
  const keyList = (i: MsIndex): string =>
    i.columns.map((c, k) => `${q(c)}${i.descending[k] ? ' DESC' : ' ASC'}`).join(', ')
  for (const i of indexes.filter((x) => x.constraint))
    lines.push(
      `  CONSTRAINT ${q(i.name)} ${i.primary ? 'PRIMARY KEY' : 'UNIQUE'} ${i.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} (${keyList(i)})`
    )
  for (const c of checks) lines.push(`  CONSTRAINT ${q(c.name)} ${c.definition}`)
  const out = [`CREATE TABLE ${target} (\n${lines.join(',\n')}\n);`]
  for (const fk of foreignKeys) {
    let stmt = `ALTER TABLE ${target} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${bracketed(fk.referencedSchema, fk.referencedTable)} (${fk.referencedColumns.map(q).join(', ')})`
    if (fk.onDelete !== 'NO ACTION') stmt += ` ON DELETE ${fk.onDelete}`
    if (fk.onUpdate !== 'NO ACTION') stmt += ` ON UPDATE ${fk.onUpdate}`
    out.push(`${stmt};`)
  }
  for (const i of indexes.filter((x) => !x.constraint)) {
    const kind = i.type.includes('COLUMNSTORE')
      ? i.type
      : `${i.unique ? 'UNIQUE ' : ''}${i.clustered ? 'CLUSTERED' : 'NONCLUSTERED'}`
    let stmt = `CREATE ${kind} INDEX ${q(i.name)} ON ${target}`
    if (!i.type.startsWith('CLUSTERED COLUMNSTORE'))
      stmt += ` (${i.type.includes('COLUMNSTORE') ? i.columns.map(q).join(', ') : keyList(i)})`
    if (i.included.length) stmt += ` INCLUDE (${i.included.map(q).join(', ')})`
    if (i.filter) stmt += ` WHERE ${i.filter}`
    out.push(`${stmt};`)
  }
  return out.join('\n')
}

/** CREATE … text of a view, procedure, function or trigger, as stored by the server. */
async function moduleDefinition(s: MsQueryable, schema: string, name: string): Promise<string> {
  const [row] = await s.query<Row>('SELECT OBJECT_DEFINITION(OBJECT_ID(@p1)) AS def', [
    bracketed(schema, name)
  ])
  if (!row) throw new MsUserError(`No se encontró ${schema}.${name}`, 'E_MS_NOT_FOUND')
  if (row.def === null)
    return `-- ${schema}.${name}: el servidor no muestra su definición (WITH ENCRYPTION o sin permiso VIEW DEFINITION).`
  return text(row.def).trim()
}

async function triggerDefinition(s: MsQueryable, schema: string, name: string): Promise<string> {
  const [row] = await s.query<Row>(
    `SELECT OBJECT_DEFINITION(tr.object_id) AS def FROM sys.triggers tr
       JOIN sys.objects o ON o.object_id = tr.parent_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = @p1 AND tr.name = @p2`,
    [schema, name]
  )
  if (!row) throw new MsUserError(`No se encontró el trigger ${schema}.${name}`, 'E_MS_NOT_FOUND')
  return row.def === null
    ? `-- ${schema}.${name}: el servidor no muestra su definición (WITH ENCRYPTION o sin permiso VIEW DEFINITION).`
    : text(row.def).trim()
}

async function sequenceDdl(s: MsQueryable, schema: string, name: string): Promise<string> {
  const [r] = await s.query<Row>(
    `SELECT TYPE_NAME(q.user_type_id) AS type, CAST(q.start_value AS nvarchar(64)) AS start,
            CAST(q.increment AS nvarchar(64)) AS incr, CAST(q.minimum_value AS nvarchar(64)) AS minv,
            CAST(q.maximum_value AS nvarchar(64)) AS maxv, q.is_cycling, q.is_cached, q.cache_size
       FROM sys.sequences q WHERE q.object_id = OBJECT_ID(@p1)`,
    [bracketed(schema, name)]
  )
  if (!r) throw new MsUserError(`No se encontró la secuencia ${schema}.${name}`, 'E_MS_NOT_FOUND')
  return [
    `CREATE SEQUENCE ${bracketed(schema, name)} AS ${text(r.type)}`,
    `  START WITH ${text(r.start)}`,
    `  INCREMENT BY ${text(r.incr)}`,
    `  MINVALUE ${text(r.minv)}`,
    `  MAXVALUE ${text(r.maxv)}`,
    `  ${r.is_cycling === true ? 'CYCLE' : 'NO CYCLE'}`,
    `  ${r.is_cached === true ? (r.cache_size === null ? 'CACHE' : `CACHE ${text(r.cache_size)}`) : 'NO CACHE'};`
  ].join('\n')
}

export async function objectDdl(s: MsQueryable, schema: string, ref: ObjectRef): Promise<string> {
  switch (ref.type) {
    case 'table':
      return (await tableStructure(s, '', schema, ref.name)).createSql
    case 'view':
    case 'procedure':
    case 'function':
      return moduleDefinition(s, schema, ref.name)
    case 'trigger':
      return triggerDefinition(s, schema, ref.name)
    case 'sequence':
      return sequenceDdl(s, schema, ref.name)
    default:
      throw new MsUserError(`SQL Server no tiene objetos de tipo ${ref.type}`, 'E_MS_TYPE')
  }
}

const DROP_KEYWORD: Partial<Record<EngineObjectType, string>> = {
  table: 'TABLE',
  view: 'VIEW',
  procedure: 'PROCEDURE',
  function: 'FUNCTION',
  trigger: 'TRIGGER',
  sequence: 'SEQUENCE'
}

export async function dropObject(s: MsQueryable, schema: string, ref: ObjectRef): Promise<void> {
  const keyword = DROP_KEYWORD[ref.type]
  if (!keyword)
    throw new MsUserError(`No se puede eliminar un objeto de tipo ${ref.type}`, 'E_MS_TYPE')
  await s.exec(`DROP ${keyword} ${bracketed(schema, ref.name)}`)
}

/* ---------- types and databases ---------- */

export async function listDataTypes(s: MsQueryable): Promise<DataTypeInfo[]> {
  const rows = await s.query<Row>(
    `SELECT ty.name, SCHEMA_NAME(ty.schema_id) AS schema_name, ty.is_user_defined, ty.is_table_type
       FROM sys.types ty
      WHERE ty.is_table_type = 0
      ORDER BY ty.is_user_defined, ty.name`
  )
  return rows.map((r) => {
    const userDefined = r.is_user_defined === true
    const schema = text(r.schema_name)
    return {
      name: userDefined ? `${quoteIdent(schema)}.${quoteIdent(text(r.name))}` : text(r.name),
      schema,
      kind: userDefined ? ('domain' as const) : ('base' as const)
    }
  })
}

const COLLATION = /^[A-Za-z0-9_]+$/

export async function createDatabase(
  s: MsQueryable,
  name: string,
  options: Record<string, string>
): Promise<void> {
  if (!name.trim()) throw new MsUserError('Escribe el nombre de la base de datos', 'E_MS_NAME')
  const collation = options.collation?.trim()
  if (collation && !COLLATION.test(collation))
    throw new MsUserError(`La intercalación «${collation}» no es válida`, 'E_MS_COLLATION')
  await s.exec(
    `CREATE DATABASE ${quoteIdent(name, true)}${collation ? ` COLLATE ${collation}` : ''}`
  )
}

export async function dropDatabase(s: MsQueryable, name: string, initial: string): Promise<void> {
  if (name.toLowerCase() === initial.toLowerCase())
    throw new MsUserError(
      `«${name}» es la base de datos inicial de la conexión: cambia la base inicial en la conexión antes de eliminarla.`,
      'E_MS_DROP_INITIAL'
    )
  if (['master', 'model', 'msdb', 'tempdb'].includes(name.toLowerCase()))
    throw new MsUserError(
      `«${name}» es una base de datos del sistema y no se puede eliminar.`,
      'E_MS_DROP_SYSTEM'
    )
  await s.exec(`DROP DATABASE ${quoteIdent(name, true)}`)
}
