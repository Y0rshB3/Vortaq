/**
 * What the server's catalog has, by `server_version_num`, and the SQL that
 * stands in for a missing piece on an older server. Vortaq is designed for
 * PostgreSQL 12+ and works with 9.2+ (2.9.2): every catalog query reads the
 * features here instead of comparing version numbers itself.
 *
 * Syntax that would need two versions of a query is avoided altogether: no
 * LATERAL (9.3), WITH ORDINALITY (9.4), json_agg (9.3) or multi-argument
 * unnest (9.4) in catalog SQL; `array_to_json(array_agg(x ORDER BY …))`,
 * `generate_series` and array subscripts work on every supported server.
 */

/** A server whose version is not known yet (a session opened before it was read). */
export const UNKNOWN_SERVER_VERSION = 0

/** Oldest server Vortaq connects to: earlier ones lack pieces even these fallbacks need. */
export const MIN_SERVER_VERSION_NUM = 90200

export interface PgCatalogFeatures {
  /** `server_version_num` the features were read from (0 = unknown: read as current). */
  versionNum: number
  /** 9.3: materialized views (relkind 'm', relispopulated). */
  matviews: boolean
  /** 9.3: pg_relation_is_updatable (automatically updatable views). */
  updatableViews: boolean
  /** 9.3: CREATE SCHEMA IF NOT EXISTS. */
  createSchemaIfNotExists: boolean
  /** 9.5: pg_stat_ssl. */
  statSsl: boolean
  /** 9.5: CREATE SEQUENCE IF NOT EXISTS. */
  createSequenceIfNotExists: boolean
  /** 10: declarative partitioning (relkind 'p', relispartition, relpartbound, pg_get_partkeydef). */
  partitions: boolean
  /** 10: identity columns (attidentity). */
  identity: boolean
  /** 10: the pg_sequence catalog, the pg_sequences view and CREATE SEQUENCE … AS type. */
  sequenceCatalog: boolean
  /** 11: pg_proc.prokind and procedures (proisagg / proiswindow before). */
  prokind: boolean
  /** 11: INCLUDE columns of an index (indnkeyatts). */
  includeColumns: boolean
  /** 12: generated columns (attgenerated). */
  generated: boolean
}

export function pgCatalogFeatures(versionNum: number | null | undefined): PgCatalogFeatures {
  const known = typeof versionNum === 'number' && Number.isFinite(versionNum) && versionNum > 0
  const v = known ? versionNum : Number.MAX_SAFE_INTEGER
  return {
    versionNum: known ? versionNum : UNKNOWN_SERVER_VERSION,
    matviews: v >= 90300,
    updatableViews: v >= 90300,
    createSchemaIfNotExists: v >= 90300,
    statSsl: v >= 90500,
    createSequenceIfNotExists: v >= 90500,
    partitions: v >= 100000,
    identity: v >= 100000,
    sequenceCatalog: v >= 100000,
    prokind: v >= 110000,
    includeColumns: v >= 110000,
    generated: v >= 120000
  }
}

/** Features of a session or queryable that knows its server's version (else: current). */
export function featuresOf(s: { readonly serverVersionNum?: number }): PgCatalogFeatures {
  return pgCatalogFeatures(s.serverVersionNum)
}

/* ---------- SQL stand-ins (each takes the table alias it reads) ---------- */

/**
 * `ssl` (boolean) and `sslversion` (text) of this session: NULL before 9.5,
 * where the server does not say (the info panel then shows «sin cifrar» only
 * when it knows).
 */
export const sslInfoSql = (f: PgCatalogFeatures): string =>
  f.statSsl
    ? `(SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl,
                (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS sslversion`
    : `NULL::boolean AS ssl, NULL::text AS sslversion`

/** The client's own view of its socket: whether it is TLS, and the protocol. */
export function clientTlsOf(client: unknown): { encrypted: boolean; protocol: string | null } {
  const stream = (
    client as {
      connection?: { stream?: { encrypted?: boolean; getProtocol?: () => string | null } }
    }
  ).connection?.stream
  const encrypted = stream?.encrypted === true
  return { encrypted, protocol: encrypted ? (stream?.getProtocol?.() ?? null) : null }
}

/**
 * «Cifrado» of the info panel and the connection test: what pg_stat_ssl says
 * (9.5+), else what the client's socket says.
 */
export function encryptionLabel(
  ssl: boolean | null,
  sslVersion: string | null,
  client: { encrypted: boolean; protocol: string | null }
): string {
  if (ssl === true) return `SSL: ${sslVersion ?? 'TLS'}`
  if (ssl === false) return 'sin cifrar'
  return client.encrypted ? `SSL: ${client.protocol ?? 'TLS'}` : 'sin cifrar'
}

/** pg_attribute.attidentity as text: '' before 10. */
export const attidentitySql = (f: PgCatalogFeatures, a = 'a'): string =>
  f.identity ? `${a}.attidentity::text` : `''::text`

/** pg_attribute.attgenerated as text: '' before 12. */
export const attgeneratedSql = (f: PgCatalogFeatures, a = 'a'): string =>
  f.generated ? `${a}.attgenerated::text` : `''::text`

/** pg_proc.prokind as text ('f', 'p', 'a', 'w'); from proisagg / proiswindow before 11. */
export const prokindSql = (f: PgCatalogFeatures, p = 'p'): string =>
  f.prokind
    ? `${p}.prokind::text`
    : `(CASE WHEN ${p}.proisagg THEN 'a' WHEN ${p}.proiswindow THEN 'w' ELSE 'f' END)::text`

/** pg_class.relispartition: false before 10. */
export const relispartitionSql = (f: PgCatalogFeatures, c = 'c'): string =>
  f.partitions ? `${c}.relispartition` : 'false'

/** Partition key of a partitioned table ('' otherwise); NULL before 10. */
export const partkeySql = (f: PgCatalogFeatures, c = 'c', schema = ''): string =>
  f.partitions
    ? `CASE WHEN ${c}.relkind = 'p' THEN ${schema}pg_get_partkeydef(${c}.oid) END`
    : 'NULL::text'

/** Number of key columns of an index (without INCLUDE columns). */
export const indexKeyCountSql = (f: PgCatalogFeatures, i = 'i'): string =>
  f.includeColumns ? `${i}.indnkeyatts` : `${i}.indnatts`

/** pg_class.relispopulated: true before 9.3 (no materialized views to be unpopulated). */
export const relispopulatedSql = (f: PgCatalogFeatures, c = 'c'): string =>
  f.matviews ? `${c}.relispopulated` : 'true'

/** A view accepts INSERT: automatically updatable views exist since 9.3. */
export const viewInsertableSql = (f: PgCatalogFeatures, c = 'c'): string =>
  f.updatableViews ? `(pg_relation_is_updatable(${c}.oid, false) & 4) = 4` : 'false'
