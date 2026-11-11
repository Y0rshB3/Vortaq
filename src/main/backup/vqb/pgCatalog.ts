import { postgresqlDialect } from '@shared/dialects/postgresql'
import { objectDdl } from '../../postgres/introspect'
import {
  attgeneratedSql,
  attidentitySql,
  featuresOf,
  partkeySql,
  prokindSql,
  relispartitionSql
} from '../../postgres/catalogCompat'
import type { VqbColumn, VqbSequenceState } from './format'
import type { ValueCodec } from './values'

/**
 * Catalog reads of a PostgreSQL .vqb backup (docs/vqb-format.md,
 * "PostgreSQL"). They run inside the backup's REPEATABLE READ snapshot with
 * `search_path = pg_catalog`, so every name the server prints (format_type,
 * pg_get_*def, defaults) comes out schema-qualified and restores the same
 * way whatever the target's search_path is. Objects that belong to an
 * extension are left out: CREATE EXTENSION brings them back.
 */

export interface PgQuery {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /** server_version_num of the session (catalogCompat.ts); absent = current. */
  readonly serverVersionNum?: number
}

type Row = Record<string, unknown>

export const qi = (name: string): string => postgresqlDialect.quoteIdent(name)
export const qn = (schema: string, name: string): string => `${qi(schema)}.${qi(name)}`
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const optText = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/** `NOT EXISTS` clause: the object (`alias`.oid in `catalog`) is not part of an extension. */
const notExtension = (catalog: string, alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = '${catalog}'::pg_catalog.regclass AND d.objid = ${alias}.oid AND d.deptype = 'e')`

const SYSTEM_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'`

export async function listSchemas(s: PgQuery): Promise<string[]> {
  const rows = await s.query<Row>(
    `SELECT n.nspname AS name FROM pg_catalog.pg_namespace n
      WHERE ${SYSTEM_SCHEMAS} AND ${notExtension('pg_namespace', 'n')}
      ORDER BY 1`
  )
  return rows.map((r) => text(r.name))
}

export interface PgExtension {
  name: string
  schema: string
}

export async function listExtensions(s: PgQuery): Promise<PgExtension[]> {
  const rows = await s.query<Row>(
    `SELECT e.extname AS name, n.nspname AS schema
       FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname <> 'plpgsql' ORDER BY 1`
  )
  return rows.map((r) => ({ name: text(r.name), schema: text(r.schema) }))
}

export const extensionDdl = (e: PgExtension): string =>
  `CREATE EXTENSION IF NOT EXISTS ${qi(e.name)} WITH SCHEMA ${qi(e.schema)}`

export interface PgTypeObject {
  schema: string
  name: string
  /** e enum, r range, d domain, c composite. */
  kind: string
}

export async function listTypes(s: PgQuery, schemas: string[]): Promise<PgTypeObject[]> {
  const rows = await s.query<Row>(
    `SELECT n.nspname AS schema, t.typname AS name, t.typtype::text AS kind
       FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = ANY($1::text[]) AND t.typtype IN ('e', 'r', 'd', 'c')
        AND (t.typtype <> 'c' OR (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid) = 'c')
        AND ${notExtension('pg_type', 't')}
      ORDER BY CASE t.typtype WHEN 'e' THEN 0 WHEN 'r' THEN 1 WHEN 'd' THEN 2 ELSE 3 END, 1, 2`,
    [schemas]
  )
  return rows.map((r) => ({ schema: text(r.schema), name: text(r.name), kind: text(r.kind) }))
}

export async function typeDdl(s: PgQuery, t: PgTypeObject): Promise<string> {
  return stripSemicolon(await objectDdl(s, t.schema, { type: 'type', name: t.name }))
}

export const stripSemicolon = (ddl: string): string => ddl.trim().replace(/;\s*$/, '')

export interface PgSequenceObject {
  schema: string
  name: string
  ownedBy: { schema: string; table: string; column: string } | null
}

/** Sequences other than the ones identity columns create themselves. */
export async function listSequences(s: PgQuery, schemas: string[]): Promise<PgSequenceObject[]> {
  const rows = await s.query<Row>(
    `SELECT n.nspname AS schema, c.relname AS name, d.deptype::text AS dep,
            tn.nspname AS owner_schema, tc.relname AS owner_table, a.attname AS owner_column
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_depend d ON d.classid = 'pg_class'::pg_catalog.regclass AND d.objid = c.oid
            AND d.refclassid = 'pg_class'::pg_catalog.regclass AND d.deptype IN ('a', 'i')
       LEFT JOIN pg_catalog.pg_class tc ON tc.oid = d.refobjid
       LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
       LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      WHERE c.relkind = 'S' AND n.nspname = ANY($1::text[]) AND ${notExtension('pg_class', 'c')}
      ORDER BY 1, 2`,
    [schemas]
  )
  return rows
    .filter((r) => text(r.dep) !== 'i')
    .map((r) => ({
      schema: text(r.schema),
      name: text(r.name),
      ownedBy:
        text(r.dep) === 'a' && r.owner_table
          ? {
              schema: text(r.owner_schema),
              table: text(r.owner_table),
              column: text(r.owner_column)
            }
          : null
    }))
}

export async function sequenceDdl(s: PgQuery, seq: PgSequenceObject): Promise<string> {
  return stripSemicolon(await objectDdl(s, seq.schema, { type: 'sequence', name: seq.name }))
}

/** last_value / is_called of a sequence, as the backup snapshot sees it. */
export async function sequenceState(
  s: PgQuery,
  schema: string,
  name: string
): Promise<{ lastValue: string; isCalled: boolean }> {
  const [row] = await s.query<Row>(
    `SELECT last_value::text AS v, is_called AS c FROM ${qn(schema, name)}`
  )
  return { lastValue: text(row?.v) || '1', isCalled: row?.c === true }
}

export interface PgTableObject {
  oid: number
  schema: string
  name: string
  relkind: string
  unlogged: boolean
  parent: { schema: string; name: string } | null
  bound: string | null
  partitionKey: string | null
  comment: string | null
  estimate: number | null
}

export async function listTables(s: PgQuery, schemas: string[]): Promise<PgTableObject[]> {
  const f = featuresOf(s)
  const isPartition = relispartitionSql(f)
  const rows = await s.query<Row>(
    `SELECT c.oid::int8 AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
            c.relpersistence::text AS persistence,
            pn.nspname AS parent_schema, p.relname AS parent_name,
            ${f.partitions ? `CASE WHEN c.relispartition THEN pg_catalog.pg_get_expr(c.relpartbound, c.oid) END` : 'NULL::text'} AS bound,
            ${partkeySql(f, 'c', 'pg_catalog.')} AS partkey,
            pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
            c.reltuples::float8 AS estimate
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_inherits i ON ${isPartition} AND i.inhrelid = c.oid
       LEFT JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
       LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1::text[]) AND ${notExtension('pg_class', 'c')}
      ORDER BY 2, 3`,
    [schemas]
  )
  const tables = rows.map((r) => ({
    oid: Number(r.oid),
    schema: text(r.schema),
    name: text(r.name),
    relkind: text(r.relkind),
    unlogged: text(r.persistence) === 'u',
    parent: r.parent_name ? { schema: text(r.parent_schema), name: text(r.parent_name) } : null,
    bound: optText(r.bound),
    partitionKey: optText(r.partkey),
    comment: optText(r.comment),
    estimate: typeof r.estimate === 'number' && r.estimate >= 0 ? Math.round(r.estimate) : null
  }))
  // Partitioned parents before their partitions (any depth), otherwise by name.
  const key = (t: PgTableObject): string => `${t.schema}.${t.name}`
  const byKey = new Map(tables.map((t) => [key(t), t]))
  const depth = (t: PgTableObject, seen = 0): number =>
    t.parent && seen < 32
      ? 1 +
        depth(byKey.get(`${t.parent.schema}.${t.parent.name}`) ?? { ...t, parent: null }, seen + 1)
      : 0
  return tables
    .map((t, i) => ({ t, i, d: depth(t) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.t)
}

export interface PgColumnFacts {
  name: string
  type: string
  notNull: boolean
  defaultExpr: string | null
  identity: '' | 'a' | 'd'
  generated: boolean
  collation: string | null
  comment: string | null
  codec: ValueCodec
  delimiter: string
  /** Read through ::numeric (money's text depends on lc_monetary). */
  castNumeric: boolean
}

const INTS = new Set(['int2', 'int4', 'int8', 'oid', 'xid', 'cid'])

export function pgCodecOf(baseName: string, category: string): ValueCodec {
  if (category === 'A') return 'array'
  if (baseName === 'bool') return 'bool'
  if (INTS.has(baseName)) return 'int'
  if (baseName === 'float4' || baseName === 'float8') return 'float'
  if (baseName === 'numeric' || baseName === 'money') return 'decimal'
  if (baseName === 'bytea') return 'binary'
  if (baseName === 'json' || baseName === 'jsonb') return 'json'
  if (['date', 'time', 'timetz', 'timestamp', 'timestamptz'].includes(baseName)) return 'datetime'
  return 'text'
}

export async function tableColumns(s: PgQuery, oid: number): Promise<PgColumnFacts[]> {
  const f = featuresOf(s)
  const rows = await s.query<Row>(
    `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS notnull, pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS dflt,
            ${attidentitySql(f)} AS identity, ${attgeneratedSql(f)} AS generated,
            CASE WHEN a.attcollation <> t.typcollation AND a.attcollation <> 0
                 THEN (SELECT pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname)
                         FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
                        WHERE co.oid = a.attcollation) END AS collation,
            pg_catalog.col_description(a.attrelid, a.attnum) AS comment,
            COALESCE(bt.typname, t.typname)::text AS base_name,
            COALESCE(bt.typcategory, t.typcategory)::text AS category,
            COALESCE(et.typdelim::text, ',') AS delim
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_catalog.pg_type bt ON t.typtype = 'd' AND bt.oid = t.typbasetype
       LEFT JOIN pg_catalog.pg_type et ON et.oid = COALESCE(bt.typelem, t.typelem)
            AND COALESCE(bt.typcategory, t.typcategory) = 'A'
       LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [oid]
  )
  return rows.map((r) => {
    const baseName = text(r.base_name)
    return {
      name: text(r.name),
      type: text(r.type),
      notNull: r.notnull === true,
      defaultExpr: optText(r.dflt),
      identity: (text(r.identity) as PgColumnFacts['identity']) || '',
      generated: text(r.generated) === 's',
      collation: optText(r.collation),
      comment: optText(r.comment),
      codec: pgCodecOf(baseName, text(r.category)),
      delimiter: text(r.delim) || ',',
      castNumeric: baseName === 'money'
    }
  })
}

/** Identity options of a column, as `(START WITH … INCREMENT BY …)`, plus its sequence state. */
export async function identityOf(
  s: PgQuery,
  table: { schema: string; name: string },
  column: string
): Promise<{ options: string; state: VqbSequenceState } | null> {
  const [seq] = await s.query<Row>(`SELECT pg_catalog.pg_get_serial_sequence($1, $2) AS seq`, [
    qn(table.schema, table.name),
    column
  ])
  const name = optText(seq?.seq)
  if (!name) return null
  const [o] = await s.query<Row>(
    `SELECT sq.seqstart::text AS start, sq.seqincrement::text AS inc, sq.seqmin::text AS min,
            sq.seqmax::text AS max, sq.seqcache::text AS cache, sq.seqcycle AS cycle,
            pg_catalog.format_type(sq.seqtypid, NULL) AS type,
            n.nspname AS schema, c.relname AS name
       FROM pg_catalog.pg_sequence sq
       JOIN pg_catalog.pg_class c ON c.oid = sq.seqrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE sq.seqrelid = $1::pg_catalog.regclass`,
    [name]
  )
  if (!o) return null
  const state = await sequenceState(s, text(o.schema), text(o.name))
  return {
    options:
      `(SEQUENCE NAME ${qn(text(o.schema), text(o.name))} START WITH ${text(o.start)} INCREMENT BY ${text(o.inc)}` +
      ` MINVALUE ${text(o.min)} MAXVALUE ${text(o.max)} CACHE ${text(o.cache)}${o.cycle === true ? ' CYCLE' : ''})`,
    state: {
      schema: text(o.schema),
      name: text(o.name),
      ...state,
      ownedBy: { table: table.name, column },
      kind: 'identity'
    }
  }
}

export interface PgTableDefinition {
  ddl: string
  comments: string[]
  indexes: string[]
  foreignKeys: string[]
  triggers: string[]
  /** Constraints of a partition added after CREATE TABLE … PARTITION OF. */
  postDdl: string[]
  /** Data columns (generated ones are not stored). */
  columns: VqbColumn[]
  codecs: ValueCodec[]
  /** SELECT list in the same order. */
  select: string
  primaryKey: string[]
  identities: VqbSequenceState[]
}

/**
 * CREATE TABLE without foreign keys, secondary indexes and triggers (they
 * are restored after every table's data), plus everything restored later.
 */
export async function tableDefinition(
  s: PgQuery,
  t: PgTableObject,
  serverVersionNum: number
): Promise<PgTableDefinition> {
  const target = qn(t.schema, t.name)
  const columns = await tableColumns(s, t.oid)
  const identities: VqbSequenceState[] = []
  const lines: string[] = []
  for (const c of columns) {
    let line = `${qi(c.name)} ${c.type}`
    if (c.collation) line += ` COLLATE ${c.collation}`
    if (c.generated && c.defaultExpr) line += ` GENERATED ALWAYS AS (${c.defaultExpr}) STORED`
    else if (c.identity) {
      const id = await identityOf(s, t, c.name)
      line += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY${id ? ` ${id.options}` : ''}`
      if (id) identities.push(id.state)
    } else if (c.defaultExpr !== null) line += ` DEFAULT ${c.defaultExpr}`
    if (c.notNull) line += ' NOT NULL'
    lines.push(line)
  }
  const parentClause = serverVersionNum >= 110000 ? ' AND con.conparentid = 0' : ''
  const constraints = await s.query<Row>(
    `SELECT con.conname AS name, pg_catalog.pg_get_constraintdef(con.oid) AS def
       FROM pg_catalog.pg_constraint con
      WHERE con.conrelid = $1 AND con.contype IN ('p', 'u', 'c', 'x') AND con.conislocal${parentClause}
      ORDER BY con.contype, con.conname`,
    [t.oid]
  )
  const postDdl: string[] = []
  let ddl: string
  const unlogged = t.unlogged ? 'UNLOGGED ' : ''
  if (t.parent) {
    // A partition takes its columns from the parent; its own constraints follow.
    ddl = `CREATE ${unlogged}TABLE ${target} PARTITION OF ${qn(t.parent.schema, t.parent.name)} ${t.bound ?? 'DEFAULT'}`
    for (const con of constraints)
      postDdl.push(`ALTER TABLE ${target} ADD CONSTRAINT ${qi(text(con.name))} ${text(con.def)}`)
  } else {
    for (const con of constraints) lines.push(`CONSTRAINT ${qi(text(con.name))} ${text(con.def)}`)
    ddl = `CREATE ${unlogged}TABLE ${target} (\n  ${lines.join(',\n  ')}\n)`
  }
  if (t.partitionKey) ddl += ` PARTITION BY ${t.partitionKey}`

  const comments: string[] = []
  if (t.comment)
    comments.push(`COMMENT ON TABLE ${target} IS ${postgresqlDialect.quoteString(t.comment)}`)
  for (const c of columns)
    if (c.comment)
      comments.push(
        `COMMENT ON COLUMN ${target}.${qi(c.name)} IS ${postgresqlDialect.quoteString(c.comment)}`
      )

  const indexes = await relationIndexes(s, t.oid, t.relkind === 'p')
  const fks = await s.query<Row>(
    `SELECT con.conname AS name, pg_catalog.pg_get_constraintdef(con.oid) AS def
       FROM pg_catalog.pg_constraint con
      WHERE con.conrelid = $1 AND con.contype = 'f'${parentClause}
      ORDER BY con.conname`,
    [t.oid]
  )
  const triggers = await relationTriggers(s, t.oid, serverVersionNum)
  // indkey is an int2vector (subscripts from 0): one row per key column, in key order.
  const pk = await s.query<Row>(
    `SELECT a.attname AS name
       FROM (SELECT i.indrelid, i.indkey, pg_catalog.generate_series(0, i.indnatts - 1) AS pos
               FROM pg_catalog.pg_index i WHERE i.indrelid = $1 AND i.indisprimary) k
       JOIN pg_catalog.pg_attribute a ON a.attrelid = k.indrelid AND a.attnum = k.indkey[k.pos]
      ORDER BY k.pos`,
    [t.oid]
  )
  const data = columns.filter((c) => !c.generated)
  return {
    ddl,
    comments,
    indexes,
    foreignKeys: fks.map(
      (f) => `ALTER TABLE ${target} ADD CONSTRAINT ${qi(text(f.name))} ${text(f.def)}`
    ),
    triggers,
    postDdl,
    columns: data.map((c) => ({
      name: c.name,
      type: c.type,
      ...(c.codec === 'array' && c.delimiter !== ',' ? { delimiter: c.delimiter } : {})
    })),
    codecs: data.map((c) => c.codec),
    select: data.map((c) => (c.castNumeric ? `${qi(c.name)}::numeric` : qi(c.name))).join(', '),
    primaryKey: pk.map((r) => text(r.name)),
    identities
  }
}

/** Indexes that no constraint owns; a partitioned parent's index cascades (no ON ONLY). */
export async function relationIndexes(
  s: PgQuery,
  oid: number,
  partitioned: boolean
): Promise<string[]> {
  const rows = await s.query<Row>(
    `SELECT pg_catalog.pg_get_indexdef(i.indexrelid) AS def
       FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = $1
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
                         WHERE con.conindid = i.indexrelid AND con.conrelid = i.indrelid
                           AND con.contype IN ('p', 'u', 'x'))
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits inh WHERE inh.inhrelid = i.indexrelid)
      ORDER BY ic.relname`,
    [oid]
  )
  return rows.map((r) => {
    const def = text(r.def)
    return partitioned ? def.replace(/ ON ONLY /, ' ON ') : def
  })
}

async function relationTriggers(
  s: PgQuery,
  oid: number,
  serverVersionNum: number
): Promise<string[]> {
  const rows = await s.query<Row>(
    `SELECT pg_catalog.pg_get_triggerdef(t.oid) AS def FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = $1 AND NOT t.tgisinternal${serverVersionNum >= 130000 ? ' AND t.tgparentid = 0' : ''}
      ORDER BY t.tgname`,
    [oid]
  )
  return rows.map((r) => text(r.def))
}

export interface PgRoutineObject {
  oid: number
  schema: string
  name: string
  kind: 'function' | 'procedure'
  signature: string
}

export async function listRoutines(
  s: PgQuery,
  schemas: string[]
): Promise<{ routines: PgRoutineObject[]; skipped: number }> {
  const rows = await s.query<Row>(
    `SELECT p.oid::int8 AS oid, n.nspname AS schema, p.proname AS name, ${prokindSql(featuresOf(s))} AS kind,
            pg_catalog.pg_get_function_identity_arguments(p.oid) AS signature
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ANY($1::text[]) AND ${notExtension('pg_proc', 'p')}
      ORDER BY 2, 3, 5`,
    [schemas]
  )
  const routines: PgRoutineObject[] = []
  let skipped = 0
  for (const r of rows) {
    const kind = text(r.kind)
    if (kind !== 'f' && kind !== 'p') {
      skipped++
      continue
    }
    routines.push({
      oid: Number(r.oid),
      schema: text(r.schema),
      name: text(r.name),
      kind: kind === 'p' ? 'procedure' : 'function',
      signature: text(r.signature)
    })
  }
  return { routines, skipped }
}

export async function routineDdl(s: PgQuery, oid: number): Promise<string> {
  const [row] = await s.query<Row>('SELECT pg_catalog.pg_get_functiondef($1::oid) AS def', [oid])
  return text(row?.def).trim()
}

export interface PgViewObject {
  oid: number
  schema: string
  name: string
  materialized: boolean
  ddl: string
  comment: string | null
}

export async function listViews(s: PgQuery, schemas: string[]): Promise<PgViewObject[]> {
  const rows = await s.query<Row>(
    `SELECT c.oid::int8 AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
            pg_catalog.pg_get_viewdef(c.oid) AS def, pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
            pg_catalog.array_to_string(c.reloptions, ', ') AS options
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('v', 'm') AND n.nspname = ANY($1::text[]) AND ${notExtension('pg_class', 'c')}
      ORDER BY 2, 3`,
    [schemas]
  )
  return rows.map((r) => {
    const materialized = text(r.relkind) === 'm'
    const target = qn(text(r.schema), text(r.name))
    const def = text(r.def).trim().replace(/;\s*$/, '')
    const options = text(r.options) ? ` WITH (${text(r.options)})` : ''
    return {
      oid: Number(r.oid),
      schema: text(r.schema),
      name: text(r.name),
      materialized,
      ddl: materialized
        ? `CREATE MATERIALIZED VIEW ${target}${options} AS\n${def}\nWITH DATA`
        : `CREATE VIEW ${target}${options} AS\n${def}`,
      comment: optText(r.comment)
    }
  })
}

export const viewComment = (v: PgViewObject): string[] =>
  v.comment
    ? [
        `COMMENT ON ${v.materialized ? 'MATERIALIZED VIEW' : 'VIEW'} ${qn(v.schema, v.name)} IS ${postgresqlDialect.quoteString(v.comment)}`
      ]
    : []
