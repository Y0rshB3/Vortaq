/**
 * PostgreSQL introspection over pg_catalog (docs/multi-engine-design.md,
 * section 5.6): information_schema hides materialized views. Every query is
 * schema-qualified or by oid, never relying on search_path. Catalog arrays
 * are returned through array_to_json(array_agg(…)) / array_agg(x::text): pg
 * has no parser for name[] and would hand back the literal text. Columns and
 * syntax newer than 9.2 go through catalogCompat.ts.
 */
import type {
  ColumnInfo,
  ConstraintInfo,
  DataTypeInfo,
  DatabaseInfo,
  EngineObjectType,
  ExtensionInfo,
  ForeignKeyInfo,
  IndexInfo,
  ObjectRef,
  ObjectSummary,
  RoutineInfo,
  SchemaInfo,
  TableInfo,
  TablePartition,
  TableKind,
  TableStructure,
  TriggerInfo,
  ViewInfo
} from '@shared/types'
import { postgresqlDialect } from '@shared/dialects/postgresql'
import {
  attgeneratedSql,
  attidentitySql,
  featuresOf,
  indexKeyCountSql,
  partkeySql,
  prokindSql,
  relispartitionSql,
  relispopulatedSql,
  viewInsertableSql
} from './catalogCompat'
import { PgUserError } from './errors'
import { typeKindOf } from './values'

/** What introspection needs from a session. */
export interface PgQueryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /** server_version_num; absent or 0 = unknown, read as a current server (catalogCompat.ts). */
  readonly serverVersionNum?: number
}

type Row = Record<string, unknown>

const q = (name: string): string => postgresqlDialect.quoteIdent(name)
const qualified = (schema: string, name: string): string => `${q(schema)}.${q(name)}`

const text = (v: unknown, fallback = ''): string =>
  v === null || v === undefined ? fallback : String(v)
const textOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const list = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => String(x))
  if (typeof v === 'string' && v.startsWith('[')) {
    try {
      const parsed = JSON.parse(v) as unknown[]
      return parsed.map((x) => String(x))
    } catch {
      return []
    }
  }
  return []
}

export const SYSTEM_SCHEMA_SQL = `(n.nspname IN ('pg_catalog', 'information_schema') OR n.nspname LIKE 'pg\\_toast%' OR n.nspname LIKE 'pg\\_temp\\_%')`

/* ---------- databases and schemas ---------- */

export async function listDatabases(s: PgQueryable, showSystem: boolean): Promise<DatabaseInfo[]> {
  const rows = await s.query<Row>(
    `SELECT d.datname AS name, pg_encoding_to_char(d.encoding) AS encoding, d.datcollate AS collation
       FROM pg_database d
      WHERE $1::boolean OR (NOT d.datistemplate AND d.datallowconn)
      ORDER BY d.datname`,
    [showSystem]
  )
  return rows.map((r) => ({
    name: text(r.name),
    characterSet: text(r.encoding),
    collation: text(r.collation)
  }))
}

export async function listSchemas(s: PgQueryable, showSystem: boolean): Promise<SchemaInfo[]> {
  const rows = await s.query<Row>(
    `SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
            COALESCE(obj_description(n.oid, 'pg_namespace'), '') AS comment,
            ${SYSTEM_SCHEMA_SQL} AS system
       FROM pg_namespace n
      WHERE $1::boolean OR NOT ${SYSTEM_SCHEMA_SQL}
      ORDER BY (n.nspname = 'public') DESC, n.nspname`,
    [showSystem]
  )
  return rows.map((r) => ({
    name: text(r.name),
    owner: text(r.owner),
    comment: text(r.comment),
    system: r.system === true
  }))
}

/* ---------- relations ---------- */

const RELKIND_LABEL: Record<string, string | null> = {
  r: null,
  p: 'particionada',
  f: 'foránea',
  v: null,
  m: null
}

export async function listTables(s: PgQueryable, schema: string): Promise<TableInfo[]> {
  const f = featuresOf(s)
  const rows = await s.query<Row>(
    `SELECT c.relname AS name, c.relkind::text AS relkind,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::int8 END AS rows,
            CASE WHEN c.relkind = 'f' THEN NULL ELSE pg_table_size(c.oid) END AS data_length,
            CASE WHEN c.relkind = 'f' THEN NULL ELSE pg_indexes_size(c.oid) END AS index_length,
            COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f') AND NOT ${relispartitionSql(f)}
      ORDER BY c.relname`,
    [schema]
  )
  const partitioned = rows.some((r) => text(r.relkind) === 'p')
  const partitions = partitioned ? await listPartitions(s, schema) : new Map()
  return rows.map((r) => ({
    name: text(r.name),
    ...(partitions.has(text(r.name)) ? { partitions: partitions.get(text(r.name)) } : {}),
    engine: RELKIND_LABEL[text(r.relkind)] ?? null,
    rows: num(r.rows),
    dataLength: num(r.data_length),
    indexLength: num(r.index_length),
    autoIncrement: null,
    createTime: null,
    updateTime: null,
    collation: null,
    comment: text(r.comment)
  }))
}

/** Deepest sub-partition level read (PostgreSQL has no limit; trees are shallow in practice). */
const MAX_PARTITION_DEPTH = 8

/**
 * Partitions of the partitioned tables of a schema, nested (sub-partitions under
 * their partition), keyed by the top-level table's name. Partitions may live in
 * other schemas; regular (non-partition) inheritance children are left out.
 */
export async function listPartitions(
  s: PgQueryable,
  schema: string
): Promise<Map<string, TablePartition[]>> {
  const rows = await s.query<Row>(
    `WITH RECURSIVE parts AS (
       SELECT i.inhparent AS parent, i.inhrelid AS child, 1 AS depth
         FROM pg_inherits i
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_namespace pn ON pn.oid = p.relnamespace
        WHERE pn.nspname = $1 AND p.relkind = 'p' AND NOT p.relispartition
       UNION ALL
       SELECT i.inhparent, i.inhrelid, parts.depth + 1
         FROM pg_inherits i JOIN parts ON i.inhparent = parts.child
        WHERE parts.depth < $2
     )
     SELECT parts.parent::int8 AS parent_oid, parts.child::int8 AS child_oid, parts.depth,
            p.relname AS parent_name, c.relname AS name, n.nspname AS schema,
            COALESCE(pg_get_expr(c.relpartbound, c.oid), '') AS bound
       FROM parts
       JOIN pg_class c ON c.oid = parts.child
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class p ON p.oid = parts.parent
      WHERE c.relispartition
      ORDER BY parts.depth, c.relname`,
    [schema, MAX_PARTITION_DEPTH]
  )
  const byOid = new Map<string, TablePartition>()
  const top = new Map<string, TablePartition[]>()
  for (const r of rows) {
    const node: TablePartition = {
      name: text(r.name),
      schema: text(r.schema),
      bound: text(r.bound)
    }
    byOid.set(text(r.child_oid), node)
    if (Number(r.depth) === 1) {
      const list = top.get(text(r.parent_name)) ?? []
      list.push(node)
      top.set(text(r.parent_name), list)
    } else {
      const parent = byOid.get(text(r.parent_oid))
      if (parent) (parent.partitions ??= []).push(node)
    }
  }
  return top
}

export async function listViews(s: PgQueryable, schema: string): Promise<ViewInfo[]> {
  const rows = await s.query<Row>(
    `SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
            ${viewInsertableSql(featuresOf(s))} AS updatable,
            COALESCE(array_to_string(c.reloptions, ', '), '') AS options
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'v'
      ORDER BY c.relname`,
    [schema]
  )
  return rows.map((r) => ({
    name: text(r.name),
    definer: text(r.owner),
    security: /security_invoker=(true|on)/i.test(text(r.options)) ? 'INVOKER' : 'DEFINER',
    updatable: r.updatable === true,
    createTime: null
  }))
}

export async function listRoutines(s: PgQueryable, schema: string): Promise<RoutineInfo[]> {
  const kind = prokindSql(featuresOf(s))
  const rows = await s.query<Row>(
    `SELECT p.proname AS name, ${kind} AS kind,
            pg_get_function_identity_arguments(p.oid) AS signature,
            pg_get_userbyid(p.proowner) AS owner,
            CASE WHEN ${kind} = 'p' THEN NULL ELSE pg_get_function_result(p.oid) END AS returns,
            COALESCE(obj_description(p.oid, 'pg_proc'), '') AS comment,
            p.prorettype = 'trigger'::regtype AS is_trigger
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND ${kind} IN ('f', 'p')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      ORDER BY p.proname, signature`,
    [schema]
  )
  return rows.map((r) => ({
    name: text(r.name),
    type: text(r.kind) === 'p' ? 'PROCEDURE' : 'FUNCTION',
    definer: text(r.owner),
    returns: textOrNull(r.returns),
    created: null,
    modified: null,
    comment: text(r.comment),
    signature: text(r.signature),
    kind:
      text(r.kind) === 'p' ? 'procedure' : r.is_trigger === true ? 'trigger function' : 'function'
  }))
}

export async function listTriggers(s: PgQueryable, schema: string): Promise<TriggerInfo[]> {
  const rows = await s.query<Row>(
    `SELECT t.tgname AS name, c.relname AS table, pg_get_triggerdef(t.oid, true) AS def
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT t.tgisinternal
      ORDER BY c.relname, t.tgname`,
    [schema]
  )
  return rows.map((r) => {
    const def = text(r.def)
    const timing = /\b(BEFORE|AFTER|INSTEAD OF)\b/i.exec(def)?.[1]?.toUpperCase() ?? ''
    const event =
      /\b(?:BEFORE|AFTER|INSTEAD OF)\s+(.+?)\s+ON\b/i.exec(def)?.[1]?.toUpperCase() ?? ''
    return {
      name: text(r.name),
      table: text(r.table),
      event,
      timing,
      statement: def,
      definer: ''
    }
  })
}

/** Objects of a group without a dedicated channel (db:objects). */
export async function listObjects(
  s: PgQueryable,
  schema: string,
  type: EngineObjectType
): Promise<ObjectSummary[]> {
  switch (type) {
    case 'materialized_view': {
      const rows = await s.query<Row>(
        `SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
                CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::int8 END AS rows,
                pg_total_relation_size(c.oid) AS size, ${relispopulatedSql(featuresOf(s))} AS populated,
                COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'm'
          ORDER BY c.relname`,
        [schema]
      )
      return rows.map((r) => ({
        name: text(r.name),
        type,
        schema,
        rows: num(r.rows),
        sizeBytes: num(r.size),
        owner: text(r.owner),
        comment: text(r.comment),
        detail: r.populated === false ? 'sin datos (REFRESH pendiente)' : null
      }))
    }
    case 'sequence': {
      if (!featuresOf(s).sequenceCatalog) return listSequencesBefore10(s, schema)
      const rows = await s.query<Row>(
        `SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
                format_type(sq.seqtypid, NULL) AS data_type,
                ps.last_value::text AS last_value,
                (SELECT dc.relname || '.' || a.attname
                   FROM pg_depend d
                   JOIN pg_class dc ON dc.oid = d.refobjid
                   JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                  WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass
                    AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
                  LIMIT 1) AS owned_by,
                COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_sequence sq ON sq.seqrelid = c.oid
           LEFT JOIN pg_sequences ps ON ps.schemaname = n.nspname AND ps.sequencename = c.relname
          WHERE n.nspname = $1 AND c.relkind = 'S'
          ORDER BY c.relname`,
        [schema]
      )
      return rows.map((r) => ({
        name: text(r.name),
        type,
        schema,
        owner: text(r.owner),
        comment: text(r.comment),
        kind: text(r.data_type),
        table: textOrNull(r.owned_by) ?? undefined,
        detail: r.last_value === null || r.last_value === undefined ? '—' : text(r.last_value)
      }))
    }
    case 'type': {
      const rows = await s.query<Row>(
        `SELECT t.typname AS name, t.typtype::text AS typtype, pg_get_userbyid(t.typowner) AS owner,
                COALESCE(obj_description(t.oid, 'pg_type'), '') AS comment,
                CASE t.typtype
                  WHEN 'e' THEN (SELECT string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)
                  WHEN 'd' THEN format_type(t.typbasetype, t.typtypmod)
                  ELSE NULL END AS detail
           FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = $1 AND t.typtype IN ('e', 'd', 'c', 'r')
            AND (t.typtype <> 'c' OR (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c')
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
          ORDER BY t.typname`,
        [schema]
      )
      const kinds: Record<string, string> = {
        e: 'enum',
        d: 'domain',
        c: 'composite',
        r: 'range'
      }
      return rows.map((r) => ({
        name: text(r.name),
        type,
        schema,
        owner: text(r.owner),
        comment: text(r.comment),
        kind: kinds[text(r.typtype)] ?? 'other',
        detail: textOrNull(r.detail)
      }))
    }
    case 'index': {
      const rows = await s.query<Row>(
        `SELECT ic.relname AS name, tc.relname AS table, pg_get_indexdef(i.indexrelid) AS def,
                pg_relation_size(i.indexrelid) AS size
           FROM pg_index i
           JOIN pg_class ic ON ic.oid = i.indexrelid
           JOIN pg_class tc ON tc.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = ic.relnamespace
          WHERE n.nspname = $1
          ORDER BY tc.relname, ic.relname`,
        [schema]
      )
      return rows.map((r) => ({
        name: text(r.name),
        type,
        schema,
        table: text(r.table),
        sizeBytes: num(r.size),
        detail: text(r.def)
      }))
    }
    case 'trigger':
      return (await listTriggers(s, schema)).map((t) => ({
        name: t.name,
        type,
        schema,
        table: t.table,
        detail: `${t.timing} ${t.event}`.trim()
      }))
    case 'function':
    case 'procedure':
      return (await listRoutines(s, schema))
        .filter((r) => (type === 'procedure' ? r.type === 'PROCEDURE' : true))
        .map((r) => ({
          name: r.name,
          type: r.type === 'PROCEDURE' ? 'procedure' : 'function',
          schema,
          signature: r.signature,
          kind: r.kind,
          owner: r.definer,
          comment: r.comment,
          detail: r.returns
        }))
    case 'table':
      return (await listTables(s, schema)).map((t) => ({
        name: t.name,
        type,
        schema,
        rows: t.rows,
        sizeBytes: t.dataLength,
        comment: t.comment,
        kind: t.engine ?? undefined
      }))
    case 'view':
      return (await listViews(s, schema)).map((v) => ({
        name: v.name,
        type,
        schema,
        owner: v.definer
      }))
    default:
      throw new PgUserError(`Tipo de objeto no soportado en PostgreSQL: ${String(type)}`)
  }
}

/** At most this many sequences get their last value read before PostgreSQL 10. */
const MAX_SEQUENCE_READS = 500

/**
 * Sequences before PostgreSQL 10 (no pg_sequence catalog): every sequence is
 * bigint and its last value lives in the sequence relation itself, read for
 * all of them in one UNION ALL (unknown when a sequence cannot be read).
 */
async function listSequencesBefore10(s: PgQueryable, schema: string): Promise<ObjectSummary[]> {
  const rows = await s.query<Row>(
    `SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
            (SELECT dc.relname || '.' || a.attname
               FROM pg_depend d
               JOIN pg_class dc ON dc.oid = d.refobjid
               JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
              WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass
                AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
              LIMIT 1) AS owned_by,
            COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'S'
      ORDER BY c.relname`,
    [schema]
  )
  const last = new Map<string, string | null>()
  const reads = rows.slice(0, MAX_SEQUENCE_READS).map(
    (r) =>
      `SELECT ${postgresqlDialect.quoteString(text(r.name))}::text AS name,
                CASE WHEN is_called THEN last_value::text END AS last_value
           FROM ${qualified(schema, text(r.name))}`
  )
  if (reads.length) {
    try {
      for (const r of await s.query<Row>(reads.join('\nUNION ALL\n')))
        last.set(text(r.name), textOrNull(r.last_value))
    } catch {
      // A sequence this user cannot read: no last values rather than no list.
    }
  }
  return rows.map((r) => {
    const value = last.get(text(r.name))
    return {
      name: text(r.name),
      type: 'sequence' as const,
      schema,
      owner: text(r.owner),
      comment: text(r.comment),
      kind: 'bigint',
      table: textOrNull(r.owned_by) ?? undefined,
      detail: value === null || value === undefined ? '—' : value
    }
  })
}

/* ---------- columns and structure ---------- */

/** Relation oid of schema.name (tables, views, matviews, foreign tables), or null. */
async function relationOid(s: PgQueryable, schema: string, name: string): Promise<number | null> {
  const [row] = await s.query<Row>(
    `SELECT c.oid::int8 AS oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
    [schema, name]
  )
  return row ? Number(row.oid) : null
}

async function requireRelation(s: PgQueryable, schema: string, name: string): Promise<number> {
  const oid = await relationOid(s, schema, name)
  if (oid === null) throw new PgUserError(`La tabla ${schema}.${name} no existe`)
  return oid
}

const columnsSql = (
  f: ReturnType<typeof featuresOf>
): string => `SELECT a.attname AS name, a.attnum AS ordinal,
       format_type(a.atttypid, a.atttypmod) AS column_type,
       format_type(a.atttypid, NULL) AS data_type,
       NOT a.attnotnull AS nullable,
       pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
       ${attidentitySql(f)} AS identity,
       ${attgeneratedSql(f)} AS generated,
       CASE WHEN a.attcollation <> t.typcollation AND a.attcollation <> 0
            THEN (SELECT co.collname FROM pg_collation co WHERE co.oid = a.attcollation) END AS collation,
       COALESCE(col_description(a.attrelid, a.attnum), '') AS comment,
       EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk,
       COALESCE(bt.typname, t.typname) AS type_name,
       COALESCE(bt.typcategory, t.typcategory)::text AS category,
       COALESCE(bt.typtype, t.typtype)::text AS typtype,
       CASE WHEN COALESCE(bt.typtype, t.typtype) = 'e'
            THEN (SELECT array_to_json(array_agg(e.enumlabel ORDER BY e.enumsortorder)) FROM pg_enum e WHERE e.enumtypid = COALESCE(bt.oid, t.oid)) END AS enum_values,
       pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) IS NOT NULL AS owns_sequence
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_type bt ON t.typtype = 'd' AND bt.oid = t.typbasetype
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
 WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
 ORDER BY a.attnum`

function toColumn(r: Row): ColumnInfo {
  const identity = text(r.identity)
  const generated = text(r.generated)
  const defaultExpr = textOrNull(r.default_expr)
  const serial = !!defaultExpr && /^nextval\(/i.test(defaultExpr) && r.owns_sequence === true
  const pk = r.pk === true
  const kind = typeKindOf({
    name: text(r.type_name),
    category: text(r.category),
    type: text(r.typtype)
  })
  const enumValues = list(r.enum_values)
  return {
    name: text(r.name),
    ordinal: num(r.ordinal) ?? 0,
    columnType: text(r.column_type),
    dataType: text(r.data_type),
    nullable: r.nullable === true,
    key: pk ? 'PRI' : '',
    defaultValue: defaultExpr,
    extra:
      identity === 'a'
        ? 'GENERATED ALWAYS AS IDENTITY'
        : identity === 'd'
          ? 'GENERATED BY DEFAULT AS IDENTITY'
          : generated === 's'
            ? 'GENERATED ALWAYS AS STORED'
            : serial
              ? 'serial'
              : '',
    characterSet: null,
    collation: textOrNull(r.collation),
    comment: text(r.comment),
    primaryKey: pk,
    autoIncrement: identity === 'a' || identity === 'd' || serial,
    identity: identity === 'a' ? 'always' : identity === 'd' ? 'by-default' : null,
    generated: generated === 's' ? 'stored' : null,
    hasDefault: generated === 's' ? false : defaultExpr !== null || identity !== '',
    typeKind: kind,
    ...(enumValues.length ? { enumValues } : {}),
    sqlType: text(r.column_type)
  }
}

export async function listColumns(
  s: PgQueryable,
  schema: string,
  table: string
): Promise<ColumnInfo[]> {
  const oid = await relationOid(s, schema, table)
  if (oid === null) return []
  return (await s.query<Row>(columnsSql(featuresOf(s)), [oid])).map(toColumn)
}

export async function primaryKeyColumns(
  s: PgQueryable,
  schema: string,
  table: string
): Promise<string[]> {
  // indkey is an int2vector (subscripts from 0); one row per key column, in key order.
  const rows = await s.query<Row>(
    `SELECT a.attname AS name
       FROM (SELECT i.indrelid, i.indkey, generate_series(0, i.indnatts - 1) AS pos
               FROM pg_index i
               JOIN pg_class c ON c.oid = i.indrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary) k
       JOIN pg_attribute a ON a.attrelid = k.indrelid AND a.attnum = k.indkey[k.pos]
      ORDER BY k.pos`,
    [schema, table]
  )
  return rows.map((r) => text(r.name))
}

async function listIndexes(s: PgQueryable, oid: number): Promise<IndexInfo[]> {
  const keyCount = indexKeyCountSql(featuresOf(s))
  const rows = await s.query<Row>(
    `SELECT ic.relname AS name, i.indisunique AS unique, i.indisprimary AS primary,
            am.amname AS method, pg_get_indexdef(i.indexrelid) AS def,
            (SELECT con.conname FROM pg_constraint con WHERE con.conindid = i.indexrelid AND con.conrelid = i.indrelid LIMIT 1) AS constraint,
            (SELECT array_to_json(array_agg(pg_get_indexdef(i.indexrelid, k.ord::int, true) ORDER BY k.ord))
               FROM generate_series(1, ${keyCount}) AS k(ord)) AS columns,
            COALESCE(obj_description(i.indexrelid, 'pg_class'), '') AS comment
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_am am ON am.oid = ic.relam
      WHERE i.indrelid = $1
      ORDER BY i.indisprimary DESC, ic.relname`,
    [oid]
  )
  return rows.map((r) => ({
    name: text(r.name),
    unique: r.unique === true,
    type: text(r.method),
    columns: list(r.columns).map((c) =>
      /^"(.*)"$/.test(c) ? c.slice(1, -1).replace(/""/g, '"') : c
    ),
    comment: text(r.comment),
    primary: r.primary === true,
    definition: text(r.def),
    constraint: textOrNull(r.constraint)
  }))
}

const FK_ACTION: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT'
}

async function listConstraints(
  s: PgQueryable,
  oid: number
): Promise<{ foreignKeys: ForeignKeyInfo[]; constraints: ConstraintInfo[] }> {
  const rows = await s.query<Row>(
    `SELECT con.conname AS name, con.contype::text AS type, pg_get_constraintdef(con.oid, true) AS def,
            (SELECT array_to_json(array_agg(a.attname ORDER BY k.ord))
               FROM generate_series(1, array_length(con.conkey, 1)) AS k(ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[k.ord]) AS columns,
            fn.nspname AS ref_schema, fc.relname AS ref_table,
            (SELECT array_to_json(array_agg(a.attname ORDER BY k.ord))
               FROM generate_series(1, array_length(con.confkey, 1)) AS k(ord)
               JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = con.confkey[k.ord]) AS ref_columns,
            con.confupdtype::text AS on_update, con.confdeltype::text AS on_delete
       FROM pg_constraint con
       LEFT JOIN pg_class fc ON fc.oid = con.confrelid
       LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE con.conrelid = $1 AND con.contype IN ('p', 'u', 'c', 'x', 'f')
      ORDER BY con.contype, con.conname`,
    [oid]
  )
  const foreignKeys: ForeignKeyInfo[] = []
  const constraints: ConstraintInfo[] = []
  const types: Record<string, ConstraintInfo['type']> = {
    p: 'primary',
    u: 'unique',
    c: 'check',
    x: 'exclusion'
  }
  for (const r of rows) {
    const type = text(r.type)
    if (type === 'f') {
      foreignKeys.push({
        name: text(r.name),
        columns: list(r.columns),
        referencedSchema: text(r.ref_schema),
        referencedTable: text(r.ref_table),
        referencedColumns: list(r.ref_columns),
        onUpdate: FK_ACTION[text(r.on_update)] ?? 'NO ACTION',
        onDelete: FK_ACTION[text(r.on_delete)] ?? 'NO ACTION'
      })
    } else if (types[type]) {
      constraints.push({
        name: text(r.name),
        type: types[type],
        definition: text(r.def),
        columns: list(r.columns)
      })
    }
  }
  return { foreignKeys, constraints }
}

const RELKIND_KIND: Record<string, TableKind> = {
  r: 'table',
  p: 'partitioned',
  v: 'view',
  m: 'materialized-view',
  f: 'foreign'
}

const RELKIND_TABLE_TYPE: Record<string, string> = {
  r: 'BASE TABLE',
  p: 'BASE TABLE',
  v: 'VIEW',
  m: 'MATERIALIZED VIEW',
  f: 'FOREIGN'
}

export async function tableStructure(
  s: PgQueryable,
  database: string,
  schema: string,
  table: string
): Promise<TableStructure> {
  const oid = await requireRelation(s, schema, table)
  const [meta] = await s.query<Row>(
    `SELECT c.relkind::text AS relkind, c.relpersistence::text AS persistence,
            pg_get_userbyid(c.relowner) AS owner,
            COALESCE((SELECT spcname FROM pg_tablespace WHERE oid = c.reltablespace), '') AS tablespace,
            COALESCE(${partkeySql(featuresOf(s))}, '') AS partition_key,
            COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
       FROM pg_class c WHERE c.oid = $1`,
    [oid]
  )
  const relkind = text(meta?.relkind)
  // One pg client runs one query at a time: sequential, not Promise.all.
  const columns = (await s.query<Row>(columnsSql(featuresOf(s)), [oid])).map(toColumn)
  const indexes = await listIndexes(s, oid)
  const { foreignKeys, constraints } = await listConstraints(s, oid)
  const structure: TableStructure = {
    schema,
    database,
    name: table,
    tableType: RELKIND_TABLE_TYPE[relkind] ?? 'BASE TABLE',
    kind: RELKIND_KIND[relkind] ?? 'table',
    columns,
    indexes,
    foreignKeys,
    constraints,
    engine: null,
    collation: null,
    comment: text(meta?.comment),
    autoIncrement: null,
    createSql: '',
    options: {
      unlogged: text(meta?.persistence) === 'u',
      owner: text(meta?.owner),
      tablespace: text(meta?.tablespace),
      partitionKey: text(meta?.partition_key)
    }
  }
  structure.createSql = await objectDdl(s, schema, {
    type: relkind === 'v' ? 'view' : relkind === 'm' ? 'materialized_view' : 'table',
    name: table
  })
  return structure
}

/* ---------- DDL ---------- */

/**
 * CREATE TABLE rebuilt from the catalog (PG has no SHOW CREATE TABLE):
 * columns, constraints, then indexes not backing a constraint, comments,
 * triggers and sequence ownership.
 */
export async function tableDdl(s: PgQueryable, schema: string, table: string): Promise<string> {
  const oid = await requireRelation(s, schema, table)
  const [meta] = await s.query<Row>(
    `SELECT c.relkind::text AS relkind, c.relpersistence::text AS persistence,
            COALESCE(${partkeySql(featuresOf(s))}, '') AS partition_key,
            COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
       FROM pg_class c WHERE c.oid = $1`,
    [oid]
  )
  const columns = (await s.query<Row>(columnsSql(featuresOf(s)), [oid])).map(toColumn)
  const indexes = await listIndexes(s, oid)
  const { foreignKeys, constraints } = await listConstraints(s, oid)
  const target = qualified(schema, table)
  const lines: string[] = []
  for (const c of columns) {
    let line = `${q(c.name)} ${c.columnType}`
    if (c.collation) line += ` COLLATE ${q(c.collation)}`
    if (c.generated === 'stored' && c.defaultValue)
      line += ` GENERATED ALWAYS AS (${c.defaultValue}) STORED`
    else if (c.identity)
      line += ` GENERATED ${c.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`
    else if (c.defaultValue !== null) line += ` DEFAULT ${c.defaultValue}`
    if (!c.nullable) line += ' NOT NULL'
    lines.push(line)
  }
  for (const con of constraints) lines.push(`CONSTRAINT ${q(con.name)} ${con.definition}`)
  const fkDefs = await s.query<Row>(
    `SELECT con.conname AS name, pg_get_constraintdef(con.oid, true) AS def
       FROM pg_constraint con WHERE con.conrelid = $1 AND con.contype = 'f' ORDER BY con.conname`,
    [oid]
  )
  void foreignKeys
  for (const fk of fkDefs) lines.push(`CONSTRAINT ${q(text(fk.name))} ${text(fk.def)}`)
  const unlogged = text(meta?.persistence) === 'u' ? 'UNLOGGED ' : ''
  const foreign = text(meta?.relkind) === 'f' ? 'FOREIGN ' : ''
  let ddl = `CREATE ${unlogged}${foreign}TABLE ${target} (\n  ${lines.join(',\n  ')}\n)`
  if (text(meta?.partition_key)) ddl += ` PARTITION BY ${text(meta?.partition_key)}`
  ddl += ';'
  const extra: string[] = []
  for (const idx of indexes) if (!idx.constraint && idx.definition) extra.push(`${idx.definition};`)
  if (text(meta?.comment))
    extra.push(
      `COMMENT ON TABLE ${target} IS ${postgresqlDialect.quoteString(text(meta?.comment))};`
    )
  for (const c of columns)
    if (c.comment)
      extra.push(
        `COMMENT ON COLUMN ${target}.${q(c.name)} IS ${postgresqlDialect.quoteString(c.comment)};`
      )
  const triggers = await s.query<Row>(
    `SELECT pg_get_triggerdef(t.oid, true) AS def FROM pg_trigger t
      WHERE t.tgrelid = $1 AND NOT t.tgisinternal ORDER BY t.tgname`,
    [oid]
  )
  for (const t of triggers) extra.push(`${text(t.def)};`)
  const owned = await s.query<Row>(
    `SELECT sn.nspname AS seq_schema, sc.relname AS seq, a.attname AS column
       FROM pg_depend d
       JOIN pg_class sc ON sc.oid = d.objid AND sc.relkind = 'S'
       JOIN pg_namespace sn ON sn.oid = sc.relnamespace
       JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      WHERE d.refobjid = $1 AND d.deptype = 'a' AND d.classid = 'pg_class'::regclass
      ORDER BY sc.relname`,
    [oid]
  )
  const sequences: string[] = []
  const ifNotExists = featuresOf(s).createSequenceIfNotExists ? 'IF NOT EXISTS ' : ''
  for (const o of owned) {
    sequences.push(`CREATE SEQUENCE ${ifNotExists}${qualified(text(o.seq_schema), text(o.seq))};`)
    extra.push(
      `ALTER SEQUENCE ${qualified(text(o.seq_schema), text(o.seq))} OWNED BY ${target}.${q(text(o.column))};`
    )
  }
  return [...sequences, ddl, ...extra].join('\n')
}

async function routineOid(
  s: PgQueryable,
  schema: string,
  ref: ObjectRef
): Promise<{ oid: number; signature: string }> {
  const rows = await s.query<Row>(
    `SELECT p.oid::int8 AS oid, pg_get_function_identity_arguments(p.oid) AS signature
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = $2
      ORDER BY 2`,
    [schema, ref.name]
  )
  const match =
    ref.signature !== undefined ? rows.find((r) => text(r.signature) === ref.signature) : rows[0]
  if (!match) throw new PgUserError(`La función ${schema}.${ref.name} no existe`)
  if (ref.signature === undefined && rows.length > 1)
    throw new PgUserError(
      `Hay varias funciones ${schema}.${ref.name} (sobrecargas): indica cuál con su firma`
    )
  return { oid: Number(match.oid), signature: text(match.signature) }
}

export async function objectDdl(s: PgQueryable, schema: string, ref: ObjectRef): Promise<string> {
  switch (ref.type) {
    case 'table':
      return tableDdl(s, schema, ref.name)
    case 'view':
    case 'materialized_view': {
      const oid = await relationOid(s, schema, ref.name)
      if (oid === null) throw new PgUserError(`La vista ${schema}.${ref.name} no existe`)
      const [row] = await s.query<Row>(
        'SELECT pg_get_viewdef($1::oid, true) AS def, c.relkind::text AS relkind FROM pg_class c WHERE c.oid = $1',
        [oid]
      )
      const def = text(row?.def).trim().replace(/;$/, '')
      if (text(row?.relkind) === 'm')
        return `CREATE MATERIALIZED VIEW ${qualified(schema, ref.name)} AS\n${def}\nWITH DATA;`
      return `CREATE OR REPLACE VIEW ${qualified(schema, ref.name)} AS\n${def};`
    }
    case 'function':
    case 'procedure': {
      const { oid } = await routineOid(s, schema, ref)
      const [row] = await s.query<Row>('SELECT pg_get_functiondef($1::oid) AS def', [oid])
      return `${text(row?.def).trim()};`
    }
    case 'trigger': {
      const rows = await s.query<Row>(
        `SELECT pg_get_triggerdef(t.oid, true) AS def, c.relname AS table
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal
            AND ($3::text IS NULL OR c.relname = $3)`,
        [schema, ref.name, ref.table ?? null]
      )
      if (!rows.length) throw new PgUserError(`El trigger ${ref.name} no existe`)
      return `${text(rows[0].def)};`
    }
    case 'index': {
      const [row] = await s.query<Row>(
        `SELECT pg_get_indexdef(c.oid) AS def FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('i', 'I')`,
        [schema, ref.name]
      )
      if (!row) throw new PgUserError(`El índice ${ref.name} no existe`)
      return `${text(row.def)};`
    }
    case 'sequence': {
      if (!featuresOf(s).sequenceCatalog) return sequenceDdlBefore10(s, schema, ref.name)
      const [row] = await s.query<Row>(
        `SELECT format_type(sq.seqtypid, NULL) AS type, sq.seqstart AS start, sq.seqincrement AS inc,
                sq.seqmin AS min, sq.seqmax AS max, sq.seqcache AS cache, sq.seqcycle AS cycle
           FROM pg_sequence sq JOIN pg_class c ON c.oid = sq.seqrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, ref.name]
      )
      if (!row) throw new PgUserError(`La secuencia ${ref.name} no existe`)
      return (
        `CREATE SEQUENCE ${qualified(schema, ref.name)}\n  AS ${text(row.type)}\n  INCREMENT BY ${text(row.inc)}\n` +
        `  MINVALUE ${text(row.min)}\n  MAXVALUE ${text(row.max)}\n  START WITH ${text(row.start)}\n` +
        `  CACHE ${text(row.cache)}${row.cycle === true ? '\n  CYCLE' : ''};`
      )
    }
    case 'type': {
      const [row] = await s.query<Row>(
        `SELECT t.oid::int8 AS oid, t.typtype::text AS typtype, format_type(t.typbasetype, t.typtypmod) AS base,
                t.typnotnull AS notnull, t.typdefault AS dflt, t.typrelid::int8 AS relid
           FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = $1 AND t.typname = $2`,
        [schema, ref.name]
      )
      if (!row) throw new PgUserError(`El tipo ${ref.name} no existe`)
      const name = qualified(schema, ref.name)
      const kind = text(row.typtype)
      if (kind === 'e') {
        const labels = await s.query<Row>(
          'SELECT enumlabel AS label FROM pg_enum WHERE enumtypid = $1 ORDER BY enumsortorder',
          [row.oid]
        )
        return `CREATE TYPE ${name} AS ENUM (${labels.map((l) => postgresqlDialect.quoteString(text(l.label))).join(', ')});`
      }
      if (kind === 'd') {
        const checks = await s.query<Row>(
          `SELECT conname AS name, pg_get_constraintdef(oid, true) AS def FROM pg_constraint
            WHERE contypid = $1 ORDER BY conname`,
          [row.oid]
        )
        let ddl = `CREATE DOMAIN ${name} AS ${text(row.base)}`
        if (row.dflt !== null && row.dflt !== undefined) ddl += ` DEFAULT ${text(row.dflt)}`
        if (row.notnull === true) ddl += ' NOT NULL'
        for (const c of checks) ddl += `\n  CONSTRAINT ${q(text(c.name))} ${text(c.def)}`
        return `${ddl};`
      }
      if (kind === 'c') {
        const attrs = await s.query<Row>(
          `SELECT attname AS name, format_type(atttypid, atttypmod) AS type FROM pg_attribute
            WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
          [row.relid]
        )
        return `CREATE TYPE ${name} AS (\n  ${attrs.map((a) => `${q(text(a.name))} ${text(a.type)}`).join(',\n  ')}\n);`
      }
      if (kind === 'r') {
        const [range] = await s.query<Row>(
          'SELECT format_type(rngsubtype, NULL) AS subtype FROM pg_range WHERE rngtypid = $1',
          [row.oid]
        )
        return `CREATE TYPE ${name} AS RANGE (SUBTYPE = ${text(range?.subtype)});`
      }
      return `-- ${name}: tipo base (sin DDL)`
    }
    default:
      throw new PgUserError(`No se puede obtener el DDL de un objeto de tipo ${String(ref.type)}`)
  }
}

/**
 * CREATE SEQUENCE before PostgreSQL 10: the settings live in the sequence
 * relation itself, and there is no AS type (every sequence is bigint).
 */
async function sequenceDdlBefore10(s: PgQueryable, schema: string, name: string): Promise<string> {
  const [exists] = await s.query<Row>(
    `SELECT 1 AS found FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'S'`,
    [schema, name]
  )
  if (!exists) throw new PgUserError(`La secuencia ${name} no existe`)
  const target = qualified(schema, name)
  const [row] = await s.query<Row>(
    `SELECT start_value::text AS start, increment_by::text AS inc, min_value::text AS min,
            max_value::text AS max, cache_value::text AS cache, is_cycled AS cycle
       FROM ${target}`
  )
  return (
    `CREATE SEQUENCE ${target}\n  INCREMENT BY ${text(row?.inc)}\n` +
    `  MINVALUE ${text(row?.min)}\n  MAXVALUE ${text(row?.max)}\n  START WITH ${text(row?.start)}\n` +
    `  CACHE ${text(row?.cache)}${row?.cycle === true ? '\n  CYCLE' : ''};`
  )
}

/** DROP of one object; routines need their signature, triggers their table. */
export async function dropObject(s: PgQueryable, schema: string, ref: ObjectRef): Promise<void> {
  const target = qualified(schema, ref.name)
  switch (ref.type) {
    case 'table':
      return void (await s.query(`DROP TABLE ${target}`))
    case 'view':
      return void (await s.query(`DROP VIEW ${target}`))
    case 'materialized_view':
      return void (await s.query(`DROP MATERIALIZED VIEW ${target}`))
    case 'sequence':
      return void (await s.query(`DROP SEQUENCE ${target}`))
    case 'type': {
      const [row] = await s.query<Row>(
        `SELECT t.typtype::text AS typtype FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = $1 AND t.typname = $2`,
        [schema, ref.name]
      )
      return void (await s.query(
        `DROP ${text(row?.typtype) === 'd' ? 'DOMAIN' : 'TYPE'} ${target}`
      ))
    }
    case 'index':
      return void (await s.query(`DROP INDEX ${target}`))
    case 'function':
    case 'procedure': {
      const { signature } = await routineOid(s, schema, ref)
      const keyword = ref.type === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
      return void (await s.query(`DROP ${keyword} ${target}(${signature})`))
    }
    case 'trigger': {
      if (!ref.table) throw new PgUserError('Falta la tabla del disparador')
      return void (await s.query(`DROP TRIGGER ${q(ref.name)} ON ${qualified(schema, ref.table)}`))
    }
    default:
      throw new PgUserError(`No se puede eliminar un objeto de tipo ${String(ref.type)}`)
  }
}

/* ---------- database-level lists ---------- */

export async function listExtensions(s: PgQueryable): Promise<ExtensionInfo[]> {
  const rows = await s.query<Row>(
    `SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema
       FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY e.extname`
  )
  return rows.map((r) => ({ name: text(r.name), version: text(r.version), schema: text(r.schema) }))
}

/**
 * Types the designer can offer: base, enum, domain, composite, range and
 * extension types, without array types, table row types or pseudo-types.
 */
export async function listDataTypes(s: PgQueryable): Promise<DataTypeInfo[]> {
  const rows = await s.query<Row>(
    `SELECT n.nspname AS schema, t.typname AS typname, format_type(t.oid, NULL) AS formatted,
            t.typtype::text AS typtype,
            CASE WHEN t.typtype = 'e' THEN (SELECT array_to_json(array_agg(e.enumlabel ORDER BY e.enumsortorder)) FROM pg_enum e WHERE e.enumtypid = t.oid) END AS enum_values
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype IN ('b', 'e', 'd', 'c', 'r', 'm')
        AND t.typelem = 0 OR (t.typtype = 'b' AND t.typcategory <> 'A' AND t.typelem <> 0 AND t.typname IN ('point', 'line', 'lseg', 'box', 'name'))
      ORDER BY (n.nspname = 'pg_catalog') DESC, n.nspname, formatted`
  )
  const kinds: Record<string, DataTypeInfo['kind']> = {
    b: 'base',
    e: 'enum',
    d: 'domain',
    c: 'composite',
    r: 'range',
    m: 'multirange'
  }
  const out: DataTypeInfo[] = []
  for (const r of rows) {
    const schema = text(r.schema)
    const typtype = text(r.typtype)
    if (schema === 'information_schema' || schema.startsWith('pg_toast')) continue
    if (typtype === 'c') {
      // composite types of tables are row types, not user types: keep only CREATE TYPE … AS (…)
      continue
    }
    const formatted = text(r.formatted)
    const values = list(r.enum_values)
    out.push({
      name: formatted,
      schema,
      kind: kinds[typtype] ?? 'base',
      ...(values.length ? { enumValues: values } : {})
    })
  }
  const composites = await s.query<Row>(
    `SELECT n.nspname AS schema, format_type(t.oid, NULL) AS formatted
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_class c ON c.oid = t.typrelid AND c.relkind = 'c'
      WHERE t.typtype = 'c' ORDER BY 2`
  )
  for (const r of composites)
    out.push({ name: text(r.formatted), schema: text(r.schema), kind: 'composite' })
  return out
}

/* ---------- databases ---------- */

const DB_OPTION_RE = /^[A-Za-z0-9_\-.]+$/

export async function createDatabase(
  s: PgQueryable,
  name: string,
  options: Record<string, string> = {}
): Promise<void> {
  if (!name.trim()) throw new PgUserError('El nombre de la base de datos no puede estar vacío')
  let sql = `CREATE DATABASE ${q(name)}`
  const owner = options.owner?.trim()
  const template = options.template?.trim()
  const encoding = options.encoding?.trim()
  if (owner) sql += ` OWNER ${q(owner)}`
  if (template) sql += ` TEMPLATE ${q(template)}`
  if (encoding) {
    if (!DB_OPTION_RE.test(encoding)) throw new PgUserError(`Codificación no válida: ${encoding}`)
    sql += ` ENCODING ${postgresqlDialect.quoteString(encoding)}`
  }
  await s.query(sql)
}

export async function dropDatabase(s: PgQueryable, name: string, current: string): Promise<void> {
  if (!name.trim()) throw new PgUserError('El nombre de la base de datos no puede estar vacío')
  if (name === current)
    throw new PgUserError(
      `No se puede eliminar ${name} desde una sesión conectada a ella: cambia la base de datos inicial`
    )
  if (['postgres', 'template0', 'template1'].includes(name))
    throw new PgUserError(`La base de datos del sistema ${name} no se puede eliminar`)
  await s.query(`DROP DATABASE ${q(name)}`)
}
