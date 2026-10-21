# Multi-engine architecture (MySQL, MariaDB, PostgreSQL, SQLite, MongoDB)

Status: **design; P1a, P1b, P2a, P2b, P3, P4a/P4b and P5 implemented on branch `v2` (every engine is a regular one since 2026-10-08: the preview flag is gone), shipping as **Vortaq 2.0.0**. Revision 3** (2026-10-07): the product is now
called **Vortaq** (formerly ElectronDB, and Navidog before that); revision 3 renames it, removes
the Navicat Keychain recovery (section 12.3) and limits the sources to the ones in section 19.
Revision 2 (2026-10-05, at `c147306`) answered two reviews: an adversarial review (guard bypasses,
regressions, security) and a daily-use review by a heavy user of desktop database clients. Every
point of both reviews is accepted or rejected, with a one-line reason, in **section 20
(Decisions)**. Line references such as `types.ts:28-50` point to `c147306`.

The facts this design depends on are written inline so the document stands on its own. They come
from the project's own code, from the user's own files and from public documentation (section
19); working notes kept outside the repository are not part of the project.

**Release baseline (P0) is done.** `v0.1.0` (= `c147306`) is pushed, and the GitHub Release
"ElectronDB v0.1.0 — primera versión estable" (published under the earlier name) is marked
Latest. Nothing from this branch is tagged or released as Latest until it is meant to replace the
current release (section 16, P0).

---

## 0. Scope and invariants

**Goal (decided by the user).** Add PostgreSQL, MariaDB, SQLite and MongoDB at "daily use" level:

- connect, including over SSH
- explore objects
- view and edit data
- query editor with autocomplete
- editable results
- table designer (for MongoDB: a collection designer)

Import Navicat connections of every type. **No `.nb3` backups and no automation for the new
engines in this version.**

**Invariants that every phase must keep:**

1. **MySQL behaves identically.** Same SQL text, same IPC results, same production-guard
   decisions and dialog reasons, same backups, jobs and Navicat import. P1a is a refactor with
   zero behaviour change, proven by the existing unit and integration suites passing unchanged
   apart from import paths, **with the integration suites actually running** (section 15.3). The
   only MySQL-visible changes in this whole plan are listed by name in section 20 ("MySQL-visible
   changes"); each one is additive and called out in release notes.
2. **The IPC map in `src/shared/ipc.ts` stays the only renderer↔main API**, and changes to it are
   additive. Existing channels keep their argument order. They are only _widened_: a string
   argument becomes "string or object", and the string keeps today's meaning.
3. **No native modules.** `electron-builder.yml` keeps `npmRebuild: false`, and mac, win and linux
   builds still come from one Mac.
4. **Production guard.** Every write to an `environment === 'production'` connection, on any
   engine, needs `confirmProduction` or the UI dialog. Main enforces it with an engine-aware
   **denylist** (`isObviousWrite`); the renderer asks using an engine-aware **allowlist with
   reasons** (`analyzeWrites`). Main must never flag what the renderer lets through (section 10).
5. **No query data, passwords, document contents or foreign file paths in logs.** PostgreSQL
   `detail`, MongoDB `keyValue`/`errInfo`, and any server message that echoes values are shown to
   the user but logged only as class name and code (section 5.7).
6. **Spanish UI, English code.** Errors thrown from IPC handlers are actionable Spanish messages.
7. **Only credentials the user gave Vortaq.** No driver may fall back to environment
   variables, `~/.pgpass`, OS user names or other ambient credentials (section 5.6, PostgreSQL).
8. **Opening never creates.** Connecting, testing or importing never creates a file. A SQLite
   file is created only from "Nuevo archivo SQLite…" (section 5.6, SQLite).
9. **The stable release stays stable.** `main` must stay releasable. Engines that are not finished
   are hidden behind a preview flag (section 3), and every build made from multi-engine work is
   published as a GitHub **prerelease** until the user decides it replaces v0.1.0 as Latest.

**Non-goals for this version:**

- Backups or automation for engines other than `mysql`.
- User and role management for PostgreSQL and MongoDB (read-only lists at most, later).
- Encrypted SQLite files (SQLCipher / SQLite3MultipleCiphers).
- MongoDB GSSAPI/Kerberos, AWS IAM and OIDC sign-in.
- MongoDB replica sets or SRV over SSH (needs a SOCKS bridge, later).
- Navicat HTTP tunnels.
- Importing from the live Windows registry.
- PostgreSQL-compatible servers with a different catalog: Redshift, GaussDB/openGauss and
  KingbaseES (imported as unsupported, section 12.1). MongoDB on DocumentDB and Cosmos DB is
  supported only with `retryWrites=false` (set automatically).
- PostgreSQL multi-host failover (`hostportlist`): only the first host is used, with a warning.

**Named for later (not v1), so they are not lost:** PostgreSQL visual EXPLAIN and MongoDB
explain view; read-only role lists for PostgreSQL and MongoDB; "Ejecutar función…" with an
argument prompt; a visual MongoDB Find builder; GridFS grouping; data export (CSV/JSON) and "Copiar
como INSERT" per engine; `LISTEN/NOTIFY` output and `\copy`; a second read-only SQLite process for
introspection; MySQL per-tab sessions and `KILL QUERY` cancel (section 5.3.1); read-only DDL for PG
rules and RLS policies; SQLite recent files and drag-and-drop; tree group counts.

---

## 1. Decision summary

| #   | Decision                                                                                                                                                                                                                                                                                                      | Why                                                                                                                                                                                                                                                                             | Source                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| D1  | `ConnectionConfig.engine: 'mysql' \| 'mariadb' \| 'postgresql' \| 'sqlite' \| 'mongodb'`. A missing value is normalised to `'mysql'` on read. The engine cannot change once saved.                                                                                                                            | Every consumer implicitly means MySQL today. Changing the engine would invalidate jobs, backup folders and saved queries.                                                                                                                                                       | coupling §1.1, §2          |
| D2  | Keep the flat base config plus optional per-engine blocks (`postgres?`, `sqlite?`, `mongo?`), not a discriminated union.                                                                                                                                                                                      | The change stays additive. MySQL code and stored JSON stay as they are. The renderer form code stays simple.                                                                                                                                                                    | coupling header            |
| D3  | A static capability descriptor per engine lives in `src/shared/engines.ts` (pure data). Runtime facts (detected MariaDB flavour, Mongo topology, PG version) go in `ServerInfo.runtime`.                                                                                                                      | Main and renderer read the same flags. Main rejects calls the UI should never make.                                                                                                                                                                                             | coupling §0 CAP            |
| D4  | **Feature gates follow the configured engine. Correctness fixes follow the detected server flavour.**                                                                                                                                                                                                         | A `mysql` connection that points to a MariaDB server keeps backups and automation, gets the introspection bug fixes, and is **warned before a backup** that system-versioned tables and sequences are not included (today they are skipped silently).                           | coupling §12               |
| D5  | Driver choices: `mysql2` for MySQL and MariaDB (plus two small auth plugins), `pg` + `pg-cursor`, **`node:sqlite`** in an Electron `utilityProcess`, and the official `mongodb` 7 driver. All are pure JS or built in.                                                                                        | Verified under Electron 44.3 / Node 24.20, **unpackaged on macOS only**. Packaged-app checks on all three platforms are a phase gate (section 15.4). better-sqlite3 has no Electron 44 prebuilds. The `mariadb` connector is LGPL.                                              | drivers §1                 |
| D6  | Pure SQL dialect modules in `src/shared/dialects/` handle lexing, splitting, quoting, write classification and error-code maps. The same module is used by main and renderer. **The MySQL dialect wraps today's functions unchanged** (each keeps its own tokeniser); only new dialects get one shared lexer. | A wrong split breaks the production guard. The existing MySQL tokenisers differ on purpose in edge cases (DELIMITER, `/*!`), and unifying them would change MySQL behaviour.                                                                                                    | coupling §1.5              |
| D7  | Keep `src/main/mysql/` where it is (it becomes the MySQL/MariaDB driver). Add `src/main/db/` (generic layer) and the siblings `src/main/postgres/`, `src/main/sqlite/` and `src/main/mongo/`.                                                                                                                 | Smallest Phase 1 diff. Backup and automation keep importing `mysql/` unchanged.                                                                                                                                                                                                 | —                          |
| D8  | MongoDB gets its own `mongo:*` channels and views, and reuses the grid component through an adapter. The renderer only sees canonical EJSON text.                                                                                                                                                             | No BSON in the renderer, no lossy relaxed EJSON, no unions in SQL grid code.                                                                                                                                                                                                    | drivers §5.3               |
| D9  | The MongoDB query editor uses a whitelisted shell grammar: acorn call chains with arguments parsed by `@mongodb-js/shell-bson-parser` in strict mode. User text is **never** `eval`'d.                                                                                                                        | Safe, and verified in a probe.                                                                                                                                                                                                                                                  | drivers §5.4               |
| D10 | The database password stays in the existing `mysql:<id>` credential slot, used as the generic "database password" for every engine. No migration.                                                                                                                                                             | Avoids migrating secrets. Only the TS symbol is renamed.                                                                                                                                                                                                                        | coupling §4                |
| D11 | Navicat import walks every `conn.plist` type section and adds **`.ncx` import as the password route for all engines**. Each engine's plist/`.ncx` mapping ships **in that engine's phase**; `.ncx` password import is its own early phase (PN). A Windows registry reader is deferred and optional.           | Navicat keeps no connection password in the files a user can read; its official `.ncx` export with Export Password is the documented way to move them. Vortaq never reads another application's keychain items. Without import, every engine phase means re-typing connections. | user files, Navicat manual |
| D12 | **Query tabs on PostgreSQL, SQLite and MongoDB own a dedicated session** for the tab's lifetime, with transaction state, Commit/Rollback, and a prompt when closing a tab with an open transaction. MySQL keeps today's per-run sessions in v1.                                                               | PG users rely on `BEGIN`, `SET search_path`, `SET ROLE` and temp tables surviving between runs (one session per query window). Keeping MySQL as it is honours invariant 1.                                                                                                      | daily-use review §0        |
| D13 | **Two guard functions per dialect**: `isObviousWrite` (main, denylist) and `analyzeWrites` (renderer, allowlist plus Spanish reasons). The MySQL ones are today's functions re-exported.                                                                                                                      | Merging them would drop the dialog reasons and change what main blocks today.                                                                                                                                                                                                   | adversarial review B1      |
| D14 | Unfinished engines are behind a **preview flag**, and multi-engine builds are published only as GitHub **prereleases**. Hotfixes for v0.1.x go on a `release/0.1.x` branch cut from `v0.1.0`.                                                                                                                 | Keeps `main` releasable and v0.1.0 as Latest, as the user asked.                                                                                                                                                                                                                | adversarial review A1, G   |

---

## 2. Engine model (`src/shared/types.ts`)

```ts
export type EngineId = 'mysql' | 'mariadb' | 'postgresql' | 'sqlite' | 'mongodb'

/** libpq names. 'allow' = try without TLS first, retry with TLS if the server refuses. */
export type SslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'

/** Network options shared by PG, MySQL-family and MongoDB (Avanzado tab). */
export interface NetworkOptions {
  /** Connect / server-selection timeout. Default 10 000 (Mongo's own default is 30 s). */
  connectTimeoutMs: number
  /** TCP keepalive interval; 0 = off. Default 60. Also used for the SSH tunnel. */
  keepAliveSec: number
}

export interface SslConfig {
  enabled: boolean
  caCertPath?: string
  clientCertPath?: string
  clientKeyPath?: string
  verifyServer: boolean
  /** PG / Mongo. Absent => derived: !enabled ? 'disable' : verifyServer ? 'verify-full' : 'require'. */
  mode?: SslMode
}

export interface PostgresOptions {
  /** Database opened first (Navicat "Initial Database"; default 'postgres'). */
  initialDatabase: string
  /** Show pg_catalog / information_schema / pg_toast schemas and template / no-connect databases. */
  showSystemSchemas: boolean
  /** Session TimeZone; '' = server default. Shown in the status bar either way. */
  timeZone: string
}

export interface SqliteOptions {
  /** Absolute path of the main database file. Required. Must exist when opening (invariant 8). */
  filePath: string
  /**
   * Set by import when the path came from another OS or is not absolute here
   * (e.g. 'C:\\…' on macOS). The connection cannot open until the user picks a file.
   */
  pathNeedsReview?: boolean
  /** Open with { readOnly: true }. Default true when environment === 'production' or the file is not writable. */
  readOnly: boolean
  /** PRAGMA foreign_keys at open. Default true for files created here, false for opened/imported files. */
  foreignKeys: boolean
  /** ATTACH DATABASE ? AS <quoted alias> on open (path bound as a parameter, must exist). */
  attached: { alias: string; filePath: string; pathNeedsReview?: boolean }[]
  /** Busy timeout for files other apps also have open. */
  busyTimeoutMs: number
}

export type MongoTopology = 'standalone' | 'replicaSet' | 'shardCluster'
export type MongoAuthMechanism =
  | 'default' // SCRAM negotiated
  | 'scram-sha-1'
  | 'scram-sha-256'
  | 'x509'
  | 'plain' // LDAP
  | 'none'

export interface MongoOptions {
  topology: MongoTopology
  /** mongodb+srv:// using `host` as the SRV name (no port). */
  srv: boolean
  /** Seed list for replicaSet/shardCluster. Standalone uses host/port. */
  members: { host: string; port: number }[]
  replicaSet: string
  authMechanism: MongoAuthMechanism
  /** Authentication database (Navicat "Auth Source"; default 'admin'). */
  authSource: string
  /** Database opened by default in the tree and the query editor. */
  defaultDatabase: string
  readPreference: 'primary' | 'primaryPreferred' | 'secondary' | 'secondaryPreferred' | 'nearest'
  /** Forced to true when SSH is enabled (a tunnel forwards a single host). */
  directConnection: boolean
  /** Default true; forced false (with a note) for DocumentDB and Cosmos DB service providers. */
  retryWrites: boolean
  retryReads: boolean
  /**
   * Other non-secret URI options, passed through (e.g. tlsCAFile handled via SslConfig,
   * compressors). Keys on a credential denylist (authMechanismProperties,
   * tlsCertificateKeyFilePassword, proxyPassword, password, …) are rejected on save and import.
   */
  extraOptions: Record<string, string>
}

export interface ConnectionConfig {
  // ...all existing fields unchanged...
  /** Missing in records written before multi-engine: normalised to 'mysql' by ConnectionsRepo. */
  engine: EngineId
  network?: NetworkOptions
  postgres?: PostgresOptions
  sqlite?: SqliteOptions
  mongo?: MongoOptions
  source?: {
    app: 'navicat'
    name: string
    importedAt: string
    /** Navicat section / ConnType ('MySQL', 'PostgreSQL', 'SQL Server', ...). Missing => 'MySQL'. */
    navicatType?: string
    format?: 'plist' | 'ncx'
    /**
     * Navicat ServiceProvider ('Default', 'Redshift', 'MongoDBAtlas', ...). Drives import
     * decisions (unsupported PG forks, Mongo retryWrites/TLS defaults) and is shown in the UI.
     */
    serviceProvider?: string
  }
}
```

Rules:

- **Host fields.** `host`, `port` and `username` stay required in the type, so MySQL code is
  untouched. For SQLite they are `''`, `0` and `''`. For a MongoDB SRV connection, `port` is `0`.
- **Normalisation in `ConnectionsRepo`** (`storage/repos.ts:20-58`). On read and on save it sets
  `engine ??= 'mysql'` and fills the defaults of the engine's block. The JSON file is never
  rewritten just to add the field.
- **Engine immutability lives in `ConnectionsRepo.save`**, not in the IPC handler, because the
  Navicat importer writes through the repo directly (`navicat/importer.ts:176-179`) and rebuilds
  records from scratch (`toConnectionInput`, `importer.ts:55-79`). Saving an existing `id` with a
  different `engine` throws "No se puede cambiar el motor de una conexión existente; crea una
  conexión nueva." An input without `engine` keeps the stored one.
- **`network`.** Used by PG and MongoDB from their first phase. MySQL ignores it in v1, so MySQL
  connect behaviour is unchanged.
- **Endpoint signature** (`ipc/connections.ts:7-9`, which decides whether an open connection must
  reconnect) includes `engine` and the engine block.
- **Validation** moves to a pure `src/shared/connectionValidation.ts` used by both
  `ipc/connections.ts:11-18` and the renderer's `connectionForm.ts:58-71`. For example: SQLite
  requires an absolute `filePath` for the current platform; MongoDB with SRV needs no port and
  implies TLS; MongoDB with SSH must be standalone (or use `directConnection`) and must not use
  SRV; `mongo.extraOptions` must not contain credential keys.
- **Downgrade.** An older build (v0.1.x) would treat a PostgreSQL record as MySQL and fail to
  connect with a confusing error. That is acceptable for a private app, but the release notes for
  the first multi-engine version must say so.

### 2.1 Neutral metadata (replaces string matching in the renderer)

The renderer matches MySQL strings today: `'PRIMARY'`, `'PRI'`, `/auto_increment/`,
`'BASE TABLE'` and `' unsigned'` (coupling §1.4). Every driver must fill these new fields:

```ts
export type TypeKind =
  | 'integer'
  | 'decimal'
  | 'float'
  | 'boolean'
  | 'text'
  | 'binary'
  | 'date'
  | 'time'
  | 'datetime'
  | 'json'
  | 'uuid'
  | 'enum'
  | 'array'
  | 'spatial'
  | 'other'

ColumnInfo  += primaryKey: boolean; autoIncrement: boolean   // AUTO_INCREMENT / identity / serial / INTEGER PK AUTOINCREMENT
               generated: 'virtual' | 'stored' | null; typeKind: TypeKind; hidden?: boolean // MariaDB INVISIBLE
               hasDefault: boolean                           // omit from INSERT when the cell is untouched
               identity: 'always' | 'by-default' | null      // PG; 'always' => read-only on insert
               enumValues?: string[]                         // PG pg_enum (enumsortorder); MySQL parsed from the type
               sqlType?: string                              // PG format_type(atttypid, atttypmod), for typed binds
IndexInfo   += primary: boolean
TableStructure += kind: 'table' | 'view' | 'system-versioned' | 'partitioned' | 'materialized-view' | 'foreign'
                  database?: string                          // PG
QueryColumn += typeKind?: TypeKind; database?: string; readOnlyReason?: string
QueryStatementResult / TableDataResult
            += storage?: ('null' | 'integer' | 'real' | 'text' | 'blob')[][] // SQLite only: per-cell storage class
ServerInfo  += engine?: EngineId; details?: { label: string; value: string }[]
               runtime?: { flavor: string; versionNumber: number; transactions: boolean;
                           returning: 'none' | 'insert-delete' | 'all'; topology?: MongoTopology }
ApplyRowChangesResult.insertIds: (number | string | null)[]   // uuid, ObjectId, RETURNING values
```

`ServerInfo`'s existing MySQL fields stay required. Other engines fill neutral values and
`InfoPanel.vue` renders `details` when it is present.

### 2.2 Value-fidelity contract (one rule for all drivers)

`CellValue = string | number | boolean | null` stays as it is. Every driver normalises:

- **Temporal, decimal, 64-bit and JSON values** arrive as the server's text. Nothing is ever
  turned into a JS `Date`.
- **Binary** values become `0xHEX`.
- **MongoDB** values travel as canonical EJSON text.

Per engine:

| Engine        | How                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MySQL/MariaDB | Today's pool options (`dateStrings`, `bigNumberStrings`, `jsonStrings`), unchanged. The MariaDB `extendedFormat: 'json'` stays raw with `jsonStrings: true` (verified).                                                                                                                                                                                                                                                                       |
| PostgreSQL    | A per-client `types` override parses only bool, int2, int4, oid, float4 and float8. Every other OID returns the raw server text. `bytea` `\x..` becomes `0x..`. Verified in `pg2.mjs`. **The text form depends on session settings, so every PG session pins them** (below). Writes bind as `$n::<sqlType>` so enums, domains and arrays cast explicitly. After a save the row is replaced by its `RETURNING *` result (jsonb reorders keys). |
| SQLite        | `setReadBigInts(true)`. A `bigint` becomes a number when it is safe, otherwise a string. `Uint8Array` becomes `0xHEX`. Each cell keeps its **storage class** (`storage`), and edits keep it: the declared type never rejects or coerces a value (dynamic typing; STRICT tables report their own errors).                                                                                                                                      |
| MongoDB       | `EJSON.stringify(doc, { relaxed: false })`. Relaxed EJSON rounds Int64 (verified: `…993` became `…992`). Inline edits keep the cell's BSON type (section 9.2).                                                                                                                                                                                                                                                                                |

**Pinned PostgreSQL session settings** (set on every new PG connection, pooled or tab):
`DateStyle='ISO, MDY'`, `IntervalStyle='postgres'`, `extra_float_digits=3`, `bytea_output='hex'`,
`client_encoding='UTF8'`, `application_name='Vortaq'`, and `TimeZone` from
`postgres.timeZone` when set. The effective time zone is shown in the status bar.

**Large values (new engines only; MySQL unchanged).** Binary and text cells over 64 KB are sent
truncated and marked read-only, with a "Ver valor completo" action that fetches the full value
by row identity into a new value viewer. There is no blob viewer today.

---

## 3. Engine descriptor and capabilities (`src/shared/engines.ts`)

This module is pure data with no driver imports. Both processes import it.

```ts
export type Hierarchy =
  | 'database' //              conn → database → group → object        (MySQL, MariaDB)
  | 'database>schema' //       conn → database → schema → group → object (PostgreSQL)
  | 'attached' //              conn → main/temp/aux → group → object   (SQLite)
  | 'database>collection' //   conn → database → group → collection    (MongoDB)

export interface EngineCapabilities {
  family: 'sql' | 'document'
  hierarchy: Hierarchy
  hasSchemas: boolean // PG: extra schema level under each database
  hasUsers: boolean // Users view + db:users
  supportsBackupsNb3: boolean // backups:* and backup UI
  supportsAutomation: boolean // jobs:* tasks may target this connection
  supportsSsh: boolean
  supportsSsl: boolean
  needsHost: boolean // false for SQLite (file picker instead)
  /** SQLite always; MongoDB only when username is empty or authMechanism is 'x509'/'none'. */
  passwordOptional: boolean
  /** Query tabs own a dedicated session (D12). false for mysql/mariadb in v1. */
  tabSessions: boolean
  /** Engine is hidden from the "Nueva conexión" picker unless previews are enabled (D14). */
  preview: boolean
  initialQueries: boolean // run SQL on every new session
  createDatabase: 'charset' | 'pg' | 'mongo' | false
  charsets: boolean // db:charsets, charset/collation pickers
  events: boolean
  routines: boolean
  triggers: boolean
  sequences: boolean
  materializedViews: boolean
  definer: boolean // DEFINER handling in DDL editor
  tableEngines: boolean // ENGINE= option
  unsignedTypes: boolean
  columnPositions: boolean // designer can reorder existing columns
  alterColumnInPlace: boolean // false => SQLite rebuild
  transactionalDdl: boolean // designer wraps the plan in BEGIN/COMMIT
  truncate: false | { restartIdentity: boolean; cascade: boolean } // PG: both options offered
  resultAliasMetadata: boolean // driver reports the table alias (mysql2 field.table)
  returning: 'none' | 'insert-delete' | 'all' // static upper bound; runtime may lower it
  cancel: 'kill-query' | 'pg-cancel' | 'kill-process' | 'kill-op'
  sqlDialect: 'mysql' | 'mariadb' | 'postgresql' | 'sqlite' | null
  documentModel: boolean // MongoDB views instead of SQL views
  designer: 'table' | 'collection'
}

export interface EngineDescriptor {
  id: EngineId
  label: string // 'MySQL', 'MariaDB', 'PostgreSQL', 'SQLite', 'MongoDB'
  icon: string // mdi icon for tree / picker
  defaultPort: number // 3306, 3306, 5432, 0, 27017
  defaultUser: string // 'root', 'root', 'postgres', '', ''
  groups: GroupKind[] // tree groups under a database/schema, in order
  capabilities: EngineCapabilities
}

export const ENGINES: Record<EngineId, EngineDescriptor>
export function engineOf(c: Pick<ConnectionConfig, 'engine'>): EngineDescriptor
export function assertCapability(
  c: ConnectionConfig,
  cap: keyof EngineCapabilities,
  message: string
): void
```

### 3.1 Values

| Flag                                   | mysql          | mariadb        | postgresql                | sqlite                    | mongodb                        |
| -------------------------------------- | -------------- | -------------- | ------------------------- | ------------------------- | ------------------------------ |
| family / hierarchy                     | sql / database | sql / database | sql / database>schema     | sql / attached            | document / database>collection |
| hasSchemas                             | –              | –              | **yes**                   | –                         | –                              |
| hasUsers                               | yes            | yes            | no (v1)                   | no                        | no (v1)                        |
| supportsBackupsNb3                     | **yes**        | **yes** (P5)   | no                        | no                        | no                             |
| supportsAutomation                     | **yes**        | **yes** (P5)   | no                        | no                        | no                             |
| supportsSsh / supportsSsl              | yes / yes      | yes / yes      | yes / yes                 | no / no                   | yes / yes                      |
| initialQueries                         | yes            | yes            | yes                       | yes                       | no                             |
| createDatabase                         | charset        | charset        | pg                        | false                     | mongo                          |
| events / routines / triggers           | y / y / y      | y / y / y      | n / y / y                 | n / n / y                 | n / n / n                      |
| sequences / materializedViews          | n / n          | **y** / n      | y / y                     | n / n                     | n / n                          |
| definer / tableEngines / unsignedTypes | y / y / y      | y / y / y      | n / n / n                 | n / n / n                 | –                              |
| columnPositions / alterColumnInPlace   | y / y          | y / y          | **n** / y                 | y (rebuild) / **n**       | –                              |
| transactionalDdl                       | n              | n              | **y**                     | **y**                     | –                              |
| tabSessions                            | n (v1)         | n (v1)         | **y**                     | **y** (shared, see 5.3.1) | **y**                          |
| truncate options                       | plain          | plain          | restart identity, cascade | – (`DELETE FROM`)         | – (`deleteMany({})`)           |
| preview (until its phase is done)      | n              | n (P5)         | y                         | y                         | y                              |
| resultAliasMetadata                    | y              | y              | **n**                     | **n**                     | –                              |
| returning                              | none           | insert-delete  | all                       | all                       | –                              |
| cancel                                 | kill-query     | kill-query     | pg-cancel                 | kill-process              | kill-op                        |
| designer                               | table          | table          | table                     | table                     | collection                     |

**Groups:**

- mysql: `tables, views, functions, events, queries, backups`
- mariadb: `tables, views, functions, events, sequences, queries, backups` (P5: backups added, see P5 as implemented)
- postgresql: `tables, views, materializedViews, functions, sequences, types, queries`, plus an
  `extensions` group at the **database** level (read-only list from `pg_extension`)
- sqlite: `tables, views, indexes, triggers, queries`
- mongodb: `collections, views, queries`

PG `types` lists enums, domains and composite types (`pg_type` with `typtype IN ('e','d','c')`,
excluding table row types). PG tables list excludes partitions (`relispartition`); partitions
are nested, collapsed, under their parent. Foreign tables (`relkind 'f'`) are listed under
`tables` with a badge. MongoDB hides `system.*`; `*.chunks` GridFS collections are read-only.

The groups come from coupling §11, drivers §2.6, §3.2, §4.3 and §5.2, and the daily-use review.

**Preview flag (D14) — removed for 2.0.0 (2026-10-08).** Every engine is offered; the text below
describes the flag as it was during development. An engine with `preview: true` was hidden in the "Nueva conexión" picker
and in Navicat import unless "Motores en vista previa" is switched on in `SettingsDialog.vue`. Existing
connections of a preview engine still open. Each phase flips its engine to `preview: false` in its
"done when". Independently of the flag, every build made from multi-engine work is published as a
GitHub prerelease until the user decides to promote one to Latest (invariant 9).

**Runtime overrides** come from `connections:open`'s `ServerInfo.runtime`:

- MongoDB `transactions` is false on a standalone server (verified).
- MariaDB `returning` depends on the version (RETURNING exists from 10.5 for INSERT and 10.0 for
  DELETE).
- PostgreSQL catalog queries are gated on `server_version_num`.

The renderer combines the static flags with `runtime` in a `useEngine(connectionId)` composable.

---

## 4. Object hierarchy and addressing

Today, every object channel takes `(connectionId, schema, ...)`, and "schema" means "the namespace
that holds objects". That stays. Only PostgreSQL needs a second qualifier.

```ts
/** A plain string keeps today's meaning; PG uses the object form. */
export type SchemaRef = string | { database: string; schema: string }

/** For objects whose name alone is not unique or not enough to drop them. */
export interface ObjectRef {
  type: ObjectType
  name: string
  /** PG routines: identity args from pg_get_function_identity_arguments (overloads). */
  signature?: string
  /** PG/SQLite triggers and indexes: owning table (DROP TRIGGER t ON tbl). */
  table?: string
}
export type NameRef = string | ObjectRef

export type ObjectType =
  | 'table'
  | 'view'
  | 'function'
  | 'procedure'
  | 'event'
  | 'trigger' // today
  | 'materialized_view'
  | 'sequence'
  | 'collection'
  | 'index'
  | 'type' // new
```

| Engine          | String `schema` means                                               | Object form                          |
| --------------- | ------------------------------------------------------------------- | ------------------------------------ |
| mysql / mariadb | database (today)                                                    | not used                             |
| postgresql      | **rejected by main** ("Falta la base de datos: actualiza la vista") | **required**: `{ database, schema }` |
| sqlite          | attached database alias: `main`, `temp` or an ATTACHed alias        | not used                             |
| mongodb         | database (only for shared channels such as `db:databases`)          | not used                             |

For `hierarchy === 'database>schema'`, main rejects a plain string `SchemaRef` on every channel.
A string shorthand that meant "schema in the initial database" would let any renderer path that
still sends `node.schema` drop or truncate in the wrong database (`useObjectActions.ts:68`
dropObject, `:76-86` TRUNCATE, which always sends `confirmProduction: true`).

### 4.1 Tree and tabs (renderer)

- **`stores/tree.ts:18-48`.**
  - Add a `'database'` node kind, used only when `capabilities.hierarchy === 'database>schema'`.
  - Groups under a namespace come from `descriptor.groups` filtered by capabilities, replacing the
    global `GROUPS`.
  - Change node ids from `:`-joined strings to an escaped path encoding:
    `encodeURIComponent` per segment, or a JSON array. A schema or table name that contains `:`
    already mis-parses today (`tree.ts:74-108`).
  - Tree caches (`groupKey` at `tree.ts:50`, `databases`, and schema lists) are keyed by
    `(connectionId, database)` on PG, not by connection only.
  - PG databases with `datallowconn = false` or `datistemplate` are hidden unless
    `showSystemSchemas`. A PG database node is **closed** (grey) until the user expands it, which
    opens its pool; its menu has "Cerrar base de datos". Pools are closed by idle LRU only, and
    reaching the cap of 8 gives "Demasiadas bases de datos abiertas: cierra alguna".
  - The tree filter (`tree.ts:298`, label substring today) also matches `schema.table` and
    `db.collection` on engines with an extra level.
- **`stores/tabs.ts`.** `WorkspaceTab`/`OpenTabInput` gain `database?: string`, plus the widened
  `ObjectType`. Query tab ids such as `query:${cid}:${id}` stay. **Object tab ids include the
  database** on PG: `tableData:${cid}:${db}:${schema}:${table}` and the designer equivalent
  (`useWorkspace.ts:53` today has no database, so `public.users` in two databases would reuse one
  tab via the dedupe at `tabs.ts:78-81`). MySQL ids are unchanged. Tab titles become
  `object@db.schema (conn)` on PG (`tabs.ts:155`); persisted tabs store `database`.
- **Saved queries** (`utils/savedQueries.ts:1-7`, `stores/queries.ts:26-31`) gain
  `database?: string`, also in the tree's "queries" group key. A missing value means the
  connection's initial database. MySQL records are unchanged.
- **Remembered schema.** The last schema used per PG database is kept per viewer and expanded on
  open (the connection has no "initial schema" field).
- **`useObjectActions.ts`.** `objectTypeOf`, `newObjectFor` and `actionsFor` become
  descriptor-driven. For example, MongoDB shows "Nueva colección" and no "Nueva tabla", and
  backup entries appear only when `supportsBackupsNb3`. Minimum daily menus per engine (writes
  go through the production guard):

  | Object           | Actions                                                                                                                           | Phase   |
  | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------- |
  | PG table         | Abrir, Diseñar, Truncar (restart identity / cascade, listing dependent tables), Vaciar, Copiar nombre cualificado, DDL, `ANALYZE` | P2a/P2b |
  | PG matview       | Abrir, DDL, Refrescar, Refrescar (concurrently)                                                                                   | P2b     |
  | PG sequence      | DDL, current value, Fijar valor actual… (`setval`)                                                                                | P2b     |
  | PG type (enum)   | DDL, Añadir valor… (`ALTER TYPE … ADD VALUE`)                                                                                     | P2b     |
  | PG database      | Abrir/Cerrar base de datos, Nueva base de datos, Extensiones (read-only list; create via the query editor)                        | P2a/P2b |
  | SQLite file      | Integrity check, VACUUM, Mostrar en Finder                                                                                        | P3      |
  | Mongo collection | Abrir, Diseñar, Índices (read-only in P4a), Vaciar (`deleteMany({})`), Renombrar, Duplicar, Contar exacto                         | P4a/P4b |

---

## 5. Main process: drivers

### 5.1 Layout

```
src/main/db/                 generic, engine-agnostic
  driver.ts                  Driver / DriverConnection / SqlSession / DocumentConnection interfaces
  registry.ts                getDriver(engine): Driver   (lazy imports so unused drivers never load)
  manager.ts                 ConnectionManager: open dedupe, secrets, tunnel, fatal → event:connectionClosed, closeAll
  errors.ts                  DbUserError (MysqlUserError extends it), describeForUser / describeForLog
  tunnel.ts                  moved from mysql/tunnel.ts (already generic: targetHost/targetPort → local port)
  query.ts                   executeScript(session, dialect, script, opts): split → run → normalise
  tableData.ts               fetchTableData via dialect.selectPage + driver.countRows + primary key
  rowChanges.ts              generic INSERT/UPDATE/DELETE builder over dialect (+ RETURNING)
src/main/mysql/              mysql + mariadb driver (existing code; driver.ts adapter added)
src/main/postgres/           pg driver
src/main/sqlite/             node:sqlite core + utilityProcess worker + RPC client
src/main/mongo/              mongodb driver, shell grammar, EJSON helpers
```

### 5.2 Interfaces

```ts
export interface Endpoint {
  host: string
  port: number
  tlsServername?: string
}

export interface DriverSecrets {
  password: string | null // credential slot 'mysql:<id>' (generic DB password)
  sshPassword: string | null // 'ssh:<id>' (SSH password or key passphrase, see 13)
  sslKeyPassword: string | null // 'sslKey:<id>' (client key passphrase), from P2a
}

export interface Driver {
  readonly engines: EngineId[] // mysql driver serves ['mysql', 'mariadb']
  /** Endpoint is already tunnel-resolved by the generic manager (null for SQLite). */
  test(
    config: ConnectionInput,
    secrets: DriverSecrets,
    endpoint: Endpoint | null
  ): Promise<ConnectionTestResult>
  open(
    config: ConnectionConfig,
    secrets: DriverSecrets,
    endpoint: Endpoint | null,
    hooks: { onFatal(reason: string): void }
  ): Promise<DriverConnection>
}

interface DriverConnectionBase {
  readonly config: ConnectionConfig
  serverInfo(): Promise<ServerInfo>
  cancel(executionId: string): Promise<boolean>
  close(): Promise<void>
}

export interface SqlDriverConnection extends DriverConnectionBase {
  readonly family: 'sql'
  readonly dialect: SqlDialect // from src/shared/dialects
  /**
   * Pooled internal session (introspection, grid saves, table data). PG: pool of scope.database;
   * never relies on search_path (all catalog SQL is schema-qualified or by oid).
   */
  acquire(scope: Scope | null): Promise<SqlSession>
  /** Dedicated session owned by a query tab (D12, section 5.3.1). Only when tabSessions. */
  openTabSession?(tabId: string, scope: Scope | null): Promise<TabSession>
  introspector: SqlIntrospector
}

export interface DocumentDriverConnection extends DriverConnectionBase {
  readonly family: 'document'
  mongo: MongoOperations // section 5.7
}

export type DriverConnection = SqlDriverConnection | DocumentDriverConnection

export interface Scope {
  database: string | null
  schema: string | null
}

export interface SqlSession {
  readonly connectionId: string
  readonly serverVersion: string
  /** Internal parameterised queries (introspection, row changes). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /** One user statement with a row cap; already normalised (no driver types leak). */
  runStatement(sql: string, opts: { maxRows: number; executionId?: string }): Promise<RawStatement>
  transaction<T>(fn: (s: SqlSession) => Promise<T>): Promise<T>
  release(): Promise<void>
}

export interface TabSession extends SqlSession {
  readonly tabId: string
  /** 'idle' | 'in' | 'failed', read after every statement. */
  transactionStatus(): 'idle' | 'in' | 'failed'
  /** PG: re-applies the search_path rule; SQLite: no-op; read back after each run. */
  setScope(scope: Scope): Promise<{ effectiveSchema: string | null }>
  commit(): Promise<void>
  rollback(): Promise<void>
  close(): Promise<void>
}

export interface RawStatement {
  columns: QueryColumn[] // source metadata resolved (section 5.4)
  rows: CellValue[][]
  truncated: boolean
  affectedRows: number | null
  insertId: number | string | null
  changedRows: number | null
  warnings: number
  notices?: string[] // PG RAISE NOTICE
}

export interface SqlIntrospector {
  listDatabases(): Promise<DatabaseInfo[]>
  listSchemas?(database: string): Promise<SchemaInfo[]> // hasSchemas
  listTables(scope: Scope): Promise<TableInfo[]>
  listViews(scope: Scope): Promise<ViewInfo[]>
  listRoutines?(scope: Scope): Promise<RoutineInfo[]>
  listEvents?(scope: Scope): Promise<EventInfo[]>
  listTriggers?(scope: Scope): Promise<TriggerInfo[]>
  listObjects?(scope: Scope, type: ObjectType): Promise<ObjectSummary[]> // sequences, matviews, types
  listColumns(scope: Scope, table: string): Promise<ColumnInfo[]>
  tableStructure(scope: Scope, table: string): Promise<TableStructure>
  primaryKey(scope: Scope, table: string): Promise<RowIdentity>
  objectDdl(scope: Scope, ref: ObjectRef): Promise<string>
  dropObject(scope: Scope, ref: ObjectRef): Promise<void>
  createDatabase?(name: string, options: Record<string, string>): Promise<void>
  dropDatabase?(name: string): Promise<void>
  listCharsets?(): Promise<CharsetInfo[]>
  listUsers?(): Promise<UserInfo[]>
  countRows(
    scope: Scope,
    table: string,
    where: string | null
  ): Promise<{ total: number | null; exact: boolean }>
}

/** How rows of a table are addressed for edits. */
export type RowIdentity =
  | { kind: 'primaryKey'; columns: string[] }
  | { kind: 'rowid'; alias: 'rowid' | '_rowid_' | 'oid' } // every SQLite rowid table, PK or not
  | { kind: 'allColumns' } // MySQL behaviour today
  | { kind: 'none'; reason: string } // PG without PK (v1, see open question)
```

**Backup and automation** keep receiving a `SessionFactory` that returns today's `MysqlSession`
(`mysql/types.ts:9-31`). `getSessionFactory(ctx)` is implemented by the generic manager. It throws
`DbUserError("Las copias de seguridad y la automatización solo están disponibles para conexiones
MySQL.")` when the connection's engine lacks `supportsBackupsNb3`.

### 5.3 Generic `ConnectionManager` (`src/main/db/manager.ts`)

The engine-agnostic parts of `mysql/manager.ts` move here unchanged:

- open dedupe (`:210-218`)
- tunnel resolution (`:260-274`)
- fatal handling (`:324-331`)
- `closeAll` (`:166-168`)

For each `open(id)` the manager:

1. Loads the config, normalising `engine`.
2. Reads secrets through `CredentialStore`. The password is optional when
   `capabilities.passwordOptional` is set.
3. If `ssh.enabled` and `supportsSsh`, opens one SSH tunnel per connection and passes
   `{host: '127.0.0.1', port: local, tlsServername: realHost}`. PG and MongoDB need the real host
   for TLS SNI and verification through a tunnel (drivers §2.1, §5.1).
4. Calls `getDriver(engine).open(...)` and stores the `DriverConnection`.
5. Emits `event:connectionClosed` on fatal errors, as today.

PostgreSQL keeps **one pool per database**, all of them through the same tunnel endpoint. Pools
other than the initial database are created when the user opens that database in the tree and
closed after 10 minutes idle (LRU over idle pools only). At most 8 database pools are open per
connection. Pooled PG sessions run `DISCARD ALL` and re-apply the pinned settings on release, or
are destroyed when dirty (open or failed transaction).

`closeAll` and fatal handlers never pass raw driver errors to `log.x(msg, err)`
(`index.ts:88`, `headless.ts:35` serialise the full `stack`); they log `describeForLog(err)`.

#### 5.3.1 Query-tab sessions (D12)

Today every `db:execute` takes a short-lived pooled session (`ipc/db.ts:62-67`) and a dirty one is
destroyed on release (`mysql/session.ts:40-45`), so `BEGIN` in one run and `COMMIT` in the next
never meet. Users of PostgreSQL expect one connection per query window. For engines with `tabSessions`:

- `QueryExecuteOptions` gains `sessionKey?: string` (the query tab id). With it, main runs the
  script on the tab's `TabSession`, opening it on first use. Without it (or on MySQL), today's
  per-run behaviour applies.
- New channels `db:sessionState`, `db:commit`, `db:rollback` and `db:closeSession` (section 7.2).
  Closing a tab calls `db:closeSession`; when the transaction is `in` or `failed`, the renderer
  first asks "Confirmar / Deshacer / Cancelar".
- Every statement result carries `transactionStatus`. The status bar shows it next to
  Commit/Rollback buttons; `failed` shows "Transacción abortada: ejecuta ROLLBACK".
- Idle timeout: a tab session idle for 30 minutes **without** an open transaction is closed and
  silently reopened on the next run. One with an open transaction is never closed by timeout;
  keepalive (`network.keepAliveSec`) keeps it up, and if the server drops it the tab shows
  "Conexión perdida: la transacción abierta se ha deshecho".
- **PostgreSQL search_path rule.** On open and on every schema change from the tab's combo, read
  the server default once (`current_setting('search_path')` on a fresh session) and set
  `"<schema>", <default list>` without duplicates, so `public` (where `uuid-ossp`, `pgcrypto`,
  `postgis` and `citext` usually live) stays visible. After each run, read `current_schema()` back
  and update the combo, so `SET search_path TO x` in SQL is reflected. Changing the tab's
  **database** closes the tab session (asking first when a transaction is open) and opens one on
  the new database's pool endpoint.
- **SQLite.** One utility process per connection means one handle: all tabs, the grid and
  introspection share one transaction. The tab session is therefore logical: results expose
  `DatabaseSync.isTransaction` and the owning tab. While a tab owns an open transaction, grid
  saves and other tabs' writes are refused with "Hay una transacción abierta en otra pestaña";
  reads still run.
- **MongoDB.** A tab session is a `ClientSession` used for `use <db>` state and, on replica sets,
  explicit transactions started from the editor toolbar. Standalone servers show no transaction
  controls.
- **Cancel** binds to an execution that is still running on a dedicated session: the generic
  layer records `{executionId → session, server pid/thread}` while the statement runs and drops
  it before the session can be reused, so a late cancel can never hit another statement. The
  `KILL QUERY` cancel for MySQL ships only together with MySQL tab sessions (later, see non-goals),
  never as part of a PG phase.

### 5.4 Result-source metadata (editable results)

Every driver fills `QueryColumn.{schema, table, sourceName, primaryKey, tableAlias?, typeKind,
readOnlyReason?}`.

| Engine        | Source                                                                                                                                                                                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MySQL/MariaDB | mysql2 `db/orgTable/orgName/table` + flags (`values.ts:99-110`)                                                                                                                                                                         | Unchanged. MariaDB is identical (verified, flags 16899 on the PK).                                                                                                                                                                                                                                                                                                                                                                                |
| PostgreSQL    | RowDescription `tableID/columnID/dataTypeID`, resolved in **one** catalog query per result (`unnest($1::oid[], $2::int2[])` joined with `pg_class`, `pg_namespace` and `pg_attribute`, plus a PK check), cached per tableID per session | **Views report the view's oid.** When `relkind` is not `r`/`p`, set `readOnlyReason = 'vista'`. There is no alias: in a joined SELECT the select list ties each column to its table reference (2.4.0).                                                                                                                                                                                                                                            |
| SQLite        | `StatementSync.columns()` → `{column, table, database, type}`                                                                                                                                                                           | **Views report the base table.** Editability must also require that the parsed `FROM` target (`selectSource.ts`) equals the reported table. Otherwise a `SELECT * FROM v_books` would silently edit `book`.                                                                                                                                                                                                                                       |
| MongoDB       | `_id`                                                                                                                                                                                                                                   | Editable when every document has `_id` and the command was `find`/`findOne`, or an aggregate whose stages are only `$match`/`$sort`/`$limit`/`$skip`/inclusion `$project`. **Whole-document replace is allowed only for whole documents** (no projection, no inclusion `$project`, not truncated); otherwise edits are `$set`/`$unset` diffs (section 9.2). Capped, time-series, view and GridFS `*.chunks` collections carry a `readOnlyReason`. |

`resultEditability.ts` stops reading `name === 'PRIMARY'` and `tableType === 'BASE TABLE'`. It
uses `IndexInfo.primary` and `TableStructure.kind`, and skips the alias-equality check when
`!resultAliasMetadata`.

**Joined SELECTs (2.4.0).** The three parsers also accept a FROM list of plain tables joined with
JOIN or commas (each joined table goes through the same factor rules, so derived tables, LATERAL and
table functions stay refused) and return the tables and the select list. One table is edited: the
candidates are the tables with columns in the result (MySQL/MariaDB: counted by `tableAlias`;
PostgreSQL/SQLite: `t.*` first, then `t.col` items, then FROM order), and the first whose whole
primary key is in the result wins (`firstEditable`, at most three structures read). A column belongs
to it when its alias, table and schema match (MySQL/MariaDB) or, without alias metadata, when its
place in the select list is that table's item (`t.*` is as wide as the table's structure; columns
between two stars of other tables stay unplaced) and the driver reports the same table and column.
Every other column (another table, another reference to the same table such as a self-join or a
SQLite view over it, an expression) is `locked` and never edited; expression columns of a
single-table SELECT are locked the same way. A NULL key (outer join without a match), a repeated key
(a join that multiplies rows) or an aggregate that is not a window function keeps the result
read-only.

**Inserts on every SQL engine** (`db/rowChanges.ts`): a cell the user never touched in a column
with `hasDefault` or `identity` is **omitted** from the INSERT; a cell explicitly set to NULL sends
NULL; `identity: 'always'` and generated columns are read-only. Where `returning` allows it, the
saved row is replaced by its `RETURNING *` result; otherwise it is re-read by identity. MySQL keeps
today's builder (it already relies on `insertId`), so MySQL SQL text is unchanged.

### 5.5 Query execution and streaming

- The generic `executeScript` keeps today's loop (`mysql/query.ts:48-79`) and takes the splitter
  from the dialect.
- **PostgreSQL.** Each split statement runs through `pg-cursor` with
  `read(maxRows + 1, cb)` and then `close()`. This gives an exact row cap and works for DML, DDL
  and `RETURNING` (verified). Multiple statements are never sent in one call: the extended
  protocol rejects them, and the simple protocol has no row cap.
- **PostgreSQL transaction state.** After an error inside `BEGIN`, PG answers `25P02` to every
  later statement until a rollback. The "dirty ⇒ destroy" rule (`client.release(true)`, as in
  `session.ts`) applies **only to pooled internal sessions**. A tab session keeps its open or
  failed transaction for the user to finish (section 5.3.1). The statement result reports
  `transactionStatus` (`idle` / `in` / `failed`).
- **SQLite.** Each statement uses `prepare()`, then `iterate()`, and stops after `maxRows + 1`
  rows. The script **must** be split first: `prepare("SELECT 1; DELETE FROM b")` silently drops
  the DELETE (verified).
- **MongoDB.** See section 8.4.
- **Cancel (new).** `QueryExecuteOptions.executionId` is added, along with `db:cancel`. Cancel
  targets only an execution still registered as running (section 5.3.1).
  - PostgreSQL: `pg_cancel_backend(pid)` from a pooled session, giving error `57014`.
  - SQLite: kill the utility process and reopen it. The message says what was lost: "Consulta
    cancelada; la conexión se ha reabierto y se han perdido las tablas temporales, los ATTACH de
    sesión y la transacción abierta". On reopen the configured attachments and `initialQueries`
    are re-applied.
  - MongoDB: `killOp` on the operation tagged with `comment: executionId`.
  - MySQL: not in this plan's phases (needs MySQL tab sessions first; see non-goals).

### 5.6 Per-engine driver notes

**MySQL / MariaDB (`src/main/mysql/`)**

- `driver.ts` adapts the existing `ConnectionManager`, `PooledSession`, `introspect` and `values`
  code to the interfaces above. **No SQL text changes for MySQL.**
- Flavour detection: `/mariadb/i` on `VERSION()`, after stripping a `5.5.5-` prefix. The result
  goes to `ServerInfo.runtime.flavor`.
- MariaDB correctness fixes, keyed on the detected flavour (drivers §3.2, all verified on 11.8.9):
  - `listTables` includes `TABLE_TYPE IN ('BASE TABLE','SYSTEM VERSIONED')`. Sequences are listed
    separately.
  - `COLUMN_DEFAULT` is unquoted. The string `'NULL'` means NULL, and string literals come back
    quoted.
  - Users come from `mysql.global_priv` via `JSON_VALUE` (or `SHOW CREATE USER`).
    `mysql.user.account_locked` does not exist on MariaDB.
  - The count timeout uses `SET STATEMENT max_statement_time=3 FOR SELECT ...` instead of the
    ignored `MAX_EXECUTION_TIME` hint.
  - Labels come from `extendedTypeName` (`uuid`, `inet6`, `inet4`, `vector`) and
    `extendedFormat === 'json'`.
  - INVISIBLE columns are selected explicitly in the table data view.
- MariaDB authentication: an `authPlugins` map for `client_ed25519` and `parsec`, about 40 lines
  plus `@noble/curves` (MIT, pure JS). Both were verified, including rejection of a wrong
  password. The parsec iteration factor is capped at 8. **`@noble/curves` and `@noble/hashes` 2.4
  are ESM-only** and were only loaded from a `.mjs` probe; the main bundle is CommonJS
  (`electron.vite.config.ts:9`). Before shipping, load them from the built `out/main` of a
  packaged app; if `require(esm)` fails, bundle them inline as is done for `plist`. Ships with the
  MariaDB engine phase (P5), pending user confirmation (open question 4).
- **Backups on a MariaDB server** (D4). `backup/create.ts:148-153` keeps only `BASE TABLE` and
  `VIEW`, so system-versioned tables and sequences are silently left out of the `.nb3`. P1b adds a
  pre-backup check, only when `runtime.flavor === 'mariadb'`: if the schema has such objects, the
  backup dialog warns "La copia no incluye N tablas versionadas / secuencias: …" (names only) and
  the job log records the same warning. The `.nb3` format and MySQL-server backups are unchanged.

**PostgreSQL (`src/main/postgres/`)**

- `pg` with config objects, never connection strings. Connection strings with `sslmode` trigger
  the pg 9 SECURITY WARNING and treat `require` as `verify-full`.
- **No ambient credentials (invariant 7).** pg's `connection-parameters.js` uses
  `if (config[key])`, so an empty or null `password` falls back to `PGPASSWORD` and then
  `~/.pgpass` (`client.js:296-306`), and `user`/`database` fall back to `PGUSER`/`USER`/
  `PGDATABASE`. The driver therefore always passes `password: async () => secret ?? ''` (the
  function form skips env and pgpass), and always sets `user`, `database`, `host` and `port`
  explicitly. A unit test runs with `PGPASSWORD`, `PGUSER` and a temp `PGPASSFILE` set and asserts
  none of them is used.
- `connectionTimeoutMillis` and `keepAlive`/`keepAliveInitialDelayMillis` come from `network`.
- Every new client runs the pinned session settings (section 2.2) before first use.
- SSL mode mapping (drivers §2.1):
  - `disable` → `false`
  - `allow` → try without SSL; retry with `{rejectUnauthorized:false}` only when the server
    refuses a non-SSL connection (`28000` "no pg_hba.conf entry … no encryption")
  - `require` → `{rejectUnauthorized:false}`
  - `verify-ca` → `{ca, rejectUnauthorized:true, checkServerIdentity: () => undefined}`
  - `verify-full` → `{ca, rejectUnauthorized:true}`
  - `prefer` → try SSL, and retry without it only on "The server does not support SSL
    connections".
  - Through SSH, also set `servername: realHost`.
- Introspection uses **pg_catalog, not information_schema**, because information_schema hides
  materialized views. The queries are saved in the probe file `sql/pg-introspect.sql`, which
  becomes `src/main/postgres/catalog.ts`:
  - `relkind IN ('r','p','v','m','f')`, with partitions nested via `relispartition`
  - identity and generated columns from `attidentity`/`attgenerated`
  - overloads from `pg_get_function_identity_arguments`
  - `pg_get_viewdef`, `pg_get_functiondef` and `pg_get_triggerdef`
  - Use `json_agg` and `array_agg(x::text)` in catalog queries: `name[]` comes back as a literal
    string.
- `objectDdl('table')` builds the DDL: `CREATE TABLE` from columns plus `pg_get_constraintdef`,
  then `CREATE INDEX` (`pg_get_indexdef`, skipping indexes that back constraints), `COMMENT ON`,
  triggers, and `ALTER SEQUENCE … OWNED BY`. PG has no `SHOW CREATE TABLE`.
- The minimum supported server is **PG 12** (`attgenerated`, `prokind`). Older servers get
  best-effort support, with catalog columns gated on `server_version_num`.
- Catalog additions for daily use: enum labels (`pg_enum` by `enumsortorder`) into
  `ColumnInfo.enumValues`; domains resolve `typeKind` through `typbasetype`; sequences list
  `last_value` (`pg_sequences`) and `owned_by`; `ObjectSummary` for tables carries estimated rows
  (`reltuples`, `-1` shown as "—"), `pg_total_relation_size`, owner and comment; trigger functions
  (`prorettype = 'trigger'`) and procedures are marked in the functions list; the designer's type
  picker loads `pg_type` (base, enum, domain, composite, range, plus extension types) at runtime.
- Errors: `code` is the SQLSTATE. `position` (a 1-based offset) maps to an editor marker. `detail`
  is shown to the user but never logged. `0A000` "cross-database references" explains "Cambia la
  base de datos de la pestaña"; `22P02` on an array shows the literal format `{a,b,"c d"}`.

**SQLite (`src/main/sqlite/`)**

- `core.ts` holds pure `node:sqlite` logic with no Electron imports, so the vitest node project can
  test it. It covers open (`new DatabaseSync(path, {readOnly, enableForeignKeyConstraints:
foreignKeys, timeout})`), ATTACH, run with a row cap, introspection, and normalisation.
  - **Open never creates (invariant 8; verified: `new DatabaseSync(path)` creates a missing file,
    and `C:\Users\x\typo.db` became a literal file in the current directory on macOS).** Before
    opening, `core.ts` requires `path.isAbsolute(p)` for the current platform and `existsSync(p)`,
    and fails with "Archivo no encontrado: <nombre>" plus a "Buscar…" action. The same check runs
    for "Probar conexión" and for every configured attachment. A file is created only by "Nuevo
    archivo SQLite…" (`app:pickSaveFile`), which opens with create explicitly.
  - ATTACH binds the path as a parameter (`ATTACH DATABASE ? AS <dialect.quoteIdent(alias)>`).
  - The file opens read-only when `readOnly` is set or the file or its folder is not writable
    (WAL needs to write `-shm`), and the dialog says why. A production connection that is
    read-only has a "Reabrir en modo escritura" action, with confirmation; without it the
    production write confirmation could never succeed.
  - `foreignKeys` is a connection option (Avanzado, "Aplicar claves foráneas"): on for files
    created here, **off for opened or imported files**, so cascades and FK errors don't appear in
    other apps' files unless the user asks.
  - Introspection uses `sqlite_schema`, `PRAGMA table_list`, `pragma_table_xinfo`,
    `pragma_index_list`/`index_xinfo` and `pragma_foreign_key_list`.
  - Normalisation sets `setReadBigInts(true)` and `setReturnArrays(true)`.
- `worker.ts` is the `utilityProcess` entry. It wraps `core.ts` behind a `MessagePort` RPC
  (`{id, op, args}` → `{id, ok, result | error}`).
- `driver.ts` runs in main. It spawns **one utility process per open SQLite connection**, at most
  4 at a time ("Demasiados archivos SQLite abiertos: cierra alguno"), keeps a FIFO queue (single
  writer; introspection behind a long query shows "ocupado"), and implements cancel as `kill()`
  plus reopen (message in section 5.5). SQLite's journal rolls back any open transaction.
  - Why a process and not a worker thread: `worker.terminate()` waited 21.5 s for a running step,
    while `utilityProcess.kill()` returned in 12 ms (verified). node:sqlite has no
    `sqlite3_interrupt`.
- The spawner is injected (`ProcessSpawner`), so node-side tests use an in-process fake and never
  import `electron` (a CLAUDE.md rule).
- Row identity: **every rowid table is edited by rowid**, even when it has a PK (rowid-table PKs
  allow NULLs and type-affinity duplicates). The rowid is selected as a hidden `"__rowid"` column
  through the first unshadowed alias of `rowid`, `_rowid_`, `oid`; if all three are real
  columns, identity is `none`. `WITHOUT ROWID` tables use their PK.
- **Tree from `PRAGMA database_list`**: `main`, `temp` when it has objects, and every attachment.
  Attachments made from the editor are marked "temporal (esta sesión)", and the tree refreshes
  after any statement classified as ATTACH or DETACH.
- Generated columns (`pragma_table_xinfo.hidden` 2/3) are read-only in the grid.
- WAL: the error for a read-only WAL file in a read-only folder is mapped. The rebuild's
  optional "copiar el archivo antes" uses `VACUUM INTO`, which includes WAL content.
- No SSH, SSL, users or create-database. "Nueva base de datos" means "Nuevo archivo SQLite…" in the
  connection dialog.

**MongoDB (`src/main/mongo/`)**

- `client.ts` builds `MongoClientOptions` from `MongoOptions`. The rules:
  - `promoteLongs: false` and `bsonRegExp: true`.
  - **Credentials go in the `auth` option, never in the URI** given to `MongoClient`. A raw URI
    is never persisted, logged, or echoed in previews or warnings.
  - `serverSelectionTimeoutMS` and `connectTimeoutMS` from `network.connectTimeoutMs` (default
    10 s instead of the driver's 30 s); `retryWrites`/`retryReads` from `MongoOptions`;
    `appName: 'Vortaq'`; `extraOptions` passed through after the credential-key denylist.
  - SRV implies TLS.
  - With SSH: refuse SRV and multi-host with an actionable message, and force
    `directConnection: true`.
  - TLS goes through `servername`.
  - GSSAPI, AWS and OIDC are rejected with "Mecanismo de autenticación no soportado en esta
    versión".
  - zstd and snappy compression are never requested (zlib only).
- `introspect.ts` covers:
  - `listDatabases` with `authorizedDatabases: true`, falling back to `defaultDatabase` when the
    user lacks the privilege
  - `listCollections`, hiding `system.views` and `system.buckets.*`
  - `$collStats`, `estimatedDocumentCount` and `indexes()`
  - field inference by `$sample` (size 1000), which walks paths and records BSON type counts
- `documents.ts`, `changes.ts`, `shell/*` and `ejson.ts` are covered in section 8.
- Transactions only when `runtime.topology !== 'standalone'`. On standalone servers, grid saves
  apply one by one and report partial failure per row, as `rowChangeFailure.ts` does today.
- `connections:open` / "Probar conexión" report the member role via `hello`. A direct connection
  that lands on a secondary says "Conectado a un secundario: solo lectura" and sets
  `readPreference: 'secondaryPreferred'` for reads; writes map `NotWritablePrimary` to the same
  message.
- Results keep their cursor open server-side (10-minute idle timeout, at most 5 per tab) so the
  grid can "Cargar más" through `mongo:getMore`.

### 5.7 Errors

- `DbUserError` (in `src/main/db/errors.ts`) is the "safe to show **and** safe to log" class: its
  message is written by Vortaq and never contains server text. `MysqlUserError extends
DbUserError` keeps every existing `instanceof` working. `ipc/errorLog.ts:19` trusts `DbUserError`.
- **`ServerError extends Error`** (new) carries server-derived text that may echo values (Mongo
  `E11000 … dup key: { email: "…" }`, PG `22P02 … "value"`, shell-bson-parser messages that echo
  the filter). The renderer shows its message; `errorLog.ts` logs only `ServerError(<code>)`.
  Drivers never wrap server text in `DbUserError`. A unit test feeds a value-echoing error through
  the IPC error path and asserts the log line has no value.
- Each driver exports two functions:
  - `describeForUser(err)` returns the Spanish message plus the `(CODE)` suffix. The suffix
    contract that `privileges.ts` and `friendlyError` parse stays.
  - `describeForLog(err)` returns only the code and constraint or object name.
- Error explanations are maps keyed by code in the shared dialect (`dialect.explainError`):
  - PG SQLSTATE: 23502, 23505, 23503, 22001, 22003, 22P02, 42501, 40P01, 55P03, 57014, 25P02
  - SQLite `errcode`s: CONSTRAINT_*, READONLY, BUSY
  - MongoDB codes: 11000, 121, 13, 50 (MaxTimeMSExpired)
- `isConnectionLost` per driver:
  - PG: `57P01`/`57P02`/`57P03`/`08006`/`ECONNRESET`
  - MongoDB: `MongoNetworkError`
  - SQLite: worker exit

---

## 6. Shared SQL dialects (`src/shared/dialects/`)

Pure TypeScript with no Node or DOM APIs, imported by main (splitting, guard, row changes, table
data SQL) and by the renderer (editor, guard dialog, editability parse, designer quoting).

```ts
export interface LexRules {
  identQuotes: ('`' | '"' | '[')[] // mysql: ['`'] (+'"' if ANSI_QUOTES, ignored); pg: ['"']; sqlite: ['"','[','`']
  stringQuotes: ("'" | '"')[] // mysql: ["'", '"']; pg/sqlite: ["'"]
  backslashEscapes: boolean | 'E-prefix' // mysql true; pg only inside E'..'; sqlite false
  hashComment: boolean // mysql true; pg/sqlite false ('#' is an operator in PG)
  dashCommentNeedsSpace: boolean // mysql true
  nestedBlockComments: boolean // pg true
  executableComments: ('/*!' | '/*M!' | '/*+')[] // mysql ['/*!','/*+'], mariadb + '/*M!'
  dollarQuotes: boolean // pg $tag$...$tag$
  delimiterCommand: boolean // mysql/mariadb DELIMITER
  blockBodies: 'none' | 'trigger-begin-end' // sqlite CREATE TRIGGER ... BEGIN ...; END
}

export interface SqlDialect {
  id: 'mysql' | 'mariadb' | 'postgresql' | 'sqlite'
  lex: LexRules
  tokenize(sql: string): Token[] // one lexer used by every consumer below
  splitStatements(script: string): string[]
  quoteIdent(name: string): string // pg: quote unless /^[a-z_][a-z0-9_$]*$/ and not reserved
  quoteString(value: string): string // pg/sqlite: '' doubling only
  qualified(schema: string | null, name: string): string
  placeholder(i: number): string // '?' or '$n'
  literal(value: CellValue, kind?: TypeKind): string // bool TRUE/FALSE for pg, 1/0 for mysql
  identCaseSensitive: 'quoted-only' | 'insensitive' | 'server' // pg folds unquoted to lower
  systemSchemas: string[]
  /** Main: small denylist; true only for statements that surely write (section 10). */
  isObviousWrite(statement: string): boolean
  /** Renderer: allowlist; anything not provably read-only is a write, with Spanish reasons. */
  analyzeWrites(script: string): { writes: boolean; reasons: string[] }
  selectPage(req: {
    table: string
    schema: string | null
    where: string | null
    orderBy: { column: string; direction: 'ASC' | 'DESC' } | null
    limit: number
    offset: number
    extraColumns?: string[]
  }): { sql: string; params: unknown[] }
  explainError(code: string): string | null
  isPrivilegeError(code: string): boolean
  keywords: { tableKeywords: string[]; modifiers: string[]; notAlias: string[] } // completion
  formatterLanguage: 'mysql' | 'mariadb' | 'postgresql' | 'sqlite' // sql-formatter 15
}
```

- `mysql.ts` **wraps** today's code with identical outputs. Each function keeps its own
  tokeniser, because they differ on purpose in edge cases (`sqlSplit.ts` handles DELIMITER,
  `writeGuard.normalize` unwraps `/*!`, `leadingKeyword` treats `/*!` as code):
  - `splitStatements` = `main/mysql/sqlSplit.ts` (MySQL CLI rules, DELIMITER)
  - `isObviousWrite` = `shared/productionGuard.ts:39-82`
  - `analyzeWrites` = renderer `query/writeGuard.ts:62-96` (with its reasons)
  - quoting = renderer `utils/sql.ts:1-50`
  - `query/selectSource.ts` and `editor/sqlCompletion.ts` keep their lexers for MySQL

  The functions are moved (not rewritten) and re-exported from their old paths for one phase. The
  old test files move along and must pass byte-for-byte. Only `tokenize` and `lex` are new, and
  MySQL consumers do not use them in v1.

- `mariadb.ts` is `mysql` plus the `/*M!` executable comments, `RETURNING`, and its own write
  keywords and type list.
- New dialects use **one lexer for every consumer** (split, guard, editability, completion).
- `postgresql.ts` lexes `$tag$` bodies, `E''`, nested `/* */`, `--` without a space, `::` casts,
  and `?`/`?|`/`#>>` jsonb operators. Placeholders are `$n`, and paging is
  `LIMIT n OFFSET m` (never `LIMIT m, n`).
- `sqlite.ts` keeps `CREATE TRIGGER … BEGIN …; END;` as one statement, and accepts `[ident]` and
  backtick identifiers.
- MongoDB has no `SqlDialect`. `src/shared/mongo/classify.ts` and `shellFormat.ts` play that role
  (section 8).

---

## 7. IPC contract changes (additive)

### 7.1 Widened (old calls compile and behave the same)

| Channel / type                                                    | Change                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connections:*`                                                   | `ConnectionInput` gains `engine` and the engine blocks. `connections:save` rejects an engine change. `connections:open` returns `ServerInfo` with `engine`, `details` and `runtime`.                                                                                                                                          |
| `db:tables/views/routines/events/triggers/columns/tableStructure` | `schema: string` → `schema: SchemaRef`                                                                                                                                                                                                                                                                                        |
| `db:showCreate`, `db:dropObject`                                  | `schema: SchemaRef`, `name: string` → `name: NameRef` (PG signature, trigger table)                                                                                                                                                                                                                                           |
| `db:tableData`                                                    | `TableDataRequest.schema: SchemaRef`                                                                                                                                                                                                                                                                                          |
| `db:applyRowChanges`                                              | `schema: SchemaRef`. Result `insertIds: (number \| string \| null)[]`                                                                                                                                                                                                                                                         |
| `db:execute`                                                      | `QueryExecuteOptions.schema: SchemaRef \| null`, plus `executionId?: string` and `sessionKey?: string` (tab session, ignored on MySQL). `QueryStatementResult` gains `notices?`, `transactionStatus?`, `effectiveSchema?`, `storage?` and `errorPosition?` (a 0-based offset into `sql`).                                     |
| `db:createDatabase`                                               | `charset, collation` positional args stay for MySQL. A new trailing `engineOptions?: Record<string,string>` carries PG `encoding/template/owner`. Main ignores charset/collation when `createDatabase !== 'charset'`.                                                                                                         |
| `db:events`, `db:charsets`, `db:users`                            | Main rejects with a Spanish message when the capability is false. The renderer never calls them in that case.                                                                                                                                                                                                                 |
| `backups:*`, `jobs:save/run`                                      | Main rejects non-`mysql` connection ids (`supportsBackupsNb3` / `supportsAutomation`). This is also checked at job run time, since job files can be edited.                                                                                                                                                                   |
| `navicat:previewConnections`                                      | `NavicatConnectionPreview` gains `engine: EngineId \| null` (null = unsupported type or service provider), `navicatType`, `unsupportedReason?`, `hasPassword` and `warnings: string[]`. Warnings are returned to the renderer and **not logged** (they contain foreign paths and connection names); the log gets only counts. |
| `navicat:import`                                                  | `NavicatImportRequest` gains `connectionKeys?: {navicatType: string; name: string}[]`. Plain `connections: string[]` still means MySQL-section names.                                                                                                                                                                         |

### 7.2 New channels

| Channel                                                                 | Args → result                                                                                                      | Phase                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `db:schemas`                                                            | `(connectionId, database)` → `SchemaInfo[]`                                                                        | P2a                       |
| `db:objects`                                                            | `(connectionId, schema: SchemaRef, type: ObjectType)` → `ObjectSummary[]` (sequences, matviews, types, indexes)    | P2a                       |
| `db:extensions`                                                         | `(connectionId, database)` → `{ name, version, schema }[]` (read-only)                                             | P2b                       |
| `db:cancel`                                                             | `(connectionId, executionId)` → `boolean`                                                                          | P2a                       |
| `db:sessionState`                                                       | `(connectionId, sessionKey)` → `{ open, transactionStatus, effectiveSchema, database }`                            | P2a                       |
| `db:commit` / `db:rollback`                                             | `(connectionId, sessionKey, confirmProduction?)` → `void` (commit is a write under the guard)                      | P2a                       |
| `db:closeSession`                                                       | `(connectionId, sessionKey)` → `void` (rolls back an open transaction)                                             | P2a                       |
| `db:cellValue`                                                          | `(connectionId, schema: SchemaRef, table, identity, column)` → full value of a truncated cell                      | P2b                       |
| `app:pickSaveFile`                                                      | `(title, defaultName, filters?)` → `string \| null` (new SQLite file)                                              | P3                        |
| `mongo:collections`                                                     | `(connectionId, database)` → `CollectionInfo[]` (with `readOnlyReason`, stats columns)                             | P4a                       |
| `mongo:find`                                                            | `(connectionId, DocumentQuery)` → `DocumentPage`                                                                   | P4a                       |
| `mongo:getMore`                                                         | `(connectionId, resultId, count)` → `DocumentPage` ("Cargar más")                                                  | P4a                       |
| `mongo:applyChanges`                                                    | `(connectionId, database, collection, DocumentChange[], WriteOptions?)` → `ApplyDocumentChangesResult`             | P4a                       |
| `mongo:collectionDetails`                                               | `(connectionId, database, collection)` → indexes, validator, options, stats (read-only)                            | P4a                       |
| `mongo:sampleFields`                                                    | `(connectionId, database, collection, size?)` → `FieldStat[]`                                                      | P4a                       |
| `mongo:execute`                                                         | `(connectionId, script, {database, maxDocs, executionId, sessionKey, confirmProduction})` → `MongoCommandResult[]` | P4a (reads), P4b (writes) |
| `mongo:createCollection` / `createIndex` / `dropIndex` / `setValidator` | with `WriteOptions`                                                                                                | P4b                       |
| `mongo:aggregate`                                                       | `(connectionId, {database, collection, pipeline: string, previewStage?: number, limit})` → `DocumentPage`          | P4b                       |
| `navicat:previewNcx`                                                    | `(filePath)` → `{ version, connections: NavicatConnectionPreview[], skipped }`                                     | PN                        |
| `navicat:importNcx`                                                     | `(filePath, keys, options: {passwordsOnly?: boolean})` → `NavicatImportResult`                                     | PN                        |

MongoDB reuses `db:databases`, `db:createDatabase` (name plus first collection in
`engineOptions`), `db:dropDatabase` and `db:dropObject` (type `collection`/`view`).
`IPC_INVOKE_CHANNELS` and `ipc.test.ts` are updated in the same change as each channel.

```ts
export interface DocumentQuery {
  database: string
  collection: string
  filter: string // shell syntax, parsed in main
  sort: string
  projection: string
  skip: number
  limit: number
  executionId?: string
}
export interface DocumentPage {
  docs: string[] // canonical EJSON, one per document
  whole: boolean[] // per document: no projection, no inclusion $project, not size-truncated
  fields: FieldStat[] // top-level (and dotted) paths with BSON type counts
  total: number | null
  totalExact: boolean // estimatedDocumentCount vs countDocuments({maxTimeMS})
  truncated: boolean
  resultId: string | null // open cursor for mongo:getMore; null when exhausted
}
export type DocumentChange =
  | { kind: 'insert'; doc: string } // shell syntax or canonical EJSON
  | {
      kind: 'update'
      id: string // canonical EJSON of _id
      set: Record<string, string> // path → canonical EJSON (typed by the cell editor)
      unset: string[] // never an array element path: arrays are always $set whole
      expected: Record<string, string> // original value of each edited path (optimistic check)
    }
  | { kind: 'replace'; id: string; doc: string; fetchedWhole: true } // refused unless fetched whole
  | { kind: 'delete'; id: string }
```

---

## 8. Renderer

### 8.1 Engine UI registry (`src/renderer/src/engines/`)

```ts
export interface EngineUi {
  id: EngineId
  descriptor: EngineDescriptor
  dialect: SqlDialect | null // shared module; null for Mongo
  editorExtensions(): Extension[] // CodeMirror language + completion
  completionSource(provider: SchemaProvider): CompletionSource
  format?(text: string): string // sql-formatter language from dialect
  designer: DdlPlanner | null // SQL family; Mongo uses CollectionDesignerView
  typeCatalog: TypeCatalog | null // types, lengths, numeric rules (columnType.ts per engine)
  ddlTemplates: Partial<Record<ObjectType, (n: { schema: string; name: string }) => string>>
  newTableDraft(): TableDraft
  userSql: UserSqlBuilder | null // mysql/mariadb only in v1
  connectionSection: Component // General-tab body of ConnectionDialog
  objectColumns: Partial<Record<GroupKind, ObjectColumn[]>> // objectColumns.ts per engine
}
export function engineUi(engine: EngineId): EngineUi
export function useEngine(
  connectionId: Ref<string>
): ComputedRef<EngineUi & { runtime: ServerInfo['runtime'] }>
```

- `engines/mysql.ts` wraps today's modules unchanged (`utils/tableDesigner.ts`,
  `designer/alterTable.ts`, `designer/columnType.ts`, `designer/ddl.ts`, `data/userSql.ts`).
  P1a adds the indirection only.
- **CodeMirror.** `SqlEditor.vue` takes the language from `engineUi(...)`. The dialects come from
  `@codemirror/lang-sql` 6.10, which already ships `MySQL`, `MariaSQL`, `PostgreSQL` and `SQLite`:
  - mysql: `vortaqMySQL` (today)
  - mariadb: `MariaSQL` with `backslashEscapes`
  - postgresql: `PostgreSQL` (handles `$$` and `E''`)
  - sqlite: `SQLite`

  MongoDB uses `@codemirror/lang-javascript` (new dependency) with its own completion source
  (section 9.3).

- **Completion** (`sqlCompletion.ts`). The tokenizer takes `dialect.lex`. Keyword sets come from
  `dialect.keywords`. `quoteIfNeeded` uses `dialect.quoteIdent`. `cursorPath` treats the first
  qualifier as a _schema_ for PG and as an attached database for SQLite. The `SchemaProvider` in
  `QueryView.vue:49-76` is engine-aware: PG lists schemas of the tab's database. Completion
  inserts `"MyTable"` / `"user"` quoted when needed and matches unquoted input case-insensitively
  against folded names.
- **Query toolbar.** Today it has one "schema" combo filled from `db:databases`
  (`QueryView.vue:43-44, 177-182, 428-438`). PG gets **two combos, database and schema**; changing
  the database switches the tab session, changing the schema applies the search_path rule
  (section 5.3.1), and both follow `effectiveSchema` after each run. Engines with `tabSessions`
  show the transaction state with Commit/Rollback buttons, and the session time zone (PG).
- **Table designer.** One contract per engine:

  ```ts
  export interface DdlPlanner {
    buildCreate(draft: TableDraft): DdlPlan
    buildAlter(original: TableStructure, draft: TableDraft): DdlPlan
  }
  export interface DdlPlan {
    statements: string[]
    risks: DesignerRisk[] // computed from the draft diff, not by regex on SQL
    problems: string[]
    transactional: boolean // PG/SQLite: wrapped in BEGIN/COMMIT when applied
    rebuild?: { reason: string } // SQLite 12-step rebuild
  }
  ```

  - **MySQL/MariaDB:** today's `buildDesignerAlter`. MariaDB hides functional key parts, reads the
    default collation from the server instead of the literal `utf8mb4_0900_ai_ci` (absent before
    MariaDB 11.4), and handles quoted defaults (driver-unquoted).
  - **PostgreSQL:**
    - `ALTER COLUMN … TYPE … USING`, `SET/DROP NOT NULL`, `SET/DROP DEFAULT` and
      `RENAME COLUMN`
    - indexes as separate `CREATE [UNIQUE] INDEX … USING <am>`
    - `COMMENT ON` statements
    - identity (`GENERATED BY DEFAULT AS IDENTITY`) as the "auto increment" toggle for new
      columns. Existing `serial` columns show their `nextval('…'::regclass)` default and are
      recognised as "auto increment (serial)"; the designer never converts serial to identity
      silently.
    - **column reordering disabled for existing columns** (`columnPositions: false`)
    - the type picker comes from the runtime `pg_type` catalog, schema-qualified outside the
      search_path, with an "array" checkbox (`text[]`, `mood[]`)
    - an "Opciones" tab: comment and `UNLOGGED` editable; owner, tablespace and partition key
      read-only
    - the whole plan in one transaction (DDL is transactional, verified), **except
      `ALTER TYPE … ADD VALUE`**, whose new value cannot be used in the same transaction: the
      planner emits it as a pre-transaction step, like SQLite's `PRAGMA foreign_keys=OFF`
  - **SQLite:**
    - In-place for `RENAME TO`/`RENAME COLUMN`/`ADD COLUMN`/`DROP COLUMN`, plus (in 3.53)
      `ADD/DROP CONSTRAINT CHECK` and `SET/DROP NOT NULL`.
    - Everything else uses the documented rebuild, extended for three verified or reported
      failures (a view on the table breaks the rename with `error in view v: no such table:
main.u`, verified on SQLite 3.53.4; AUTOINCREMENT high-water mark is reset; pre-existing FK
      violations abort every rebuild):
      1. Record the baseline: `PRAGMA foreign_key_check` rows, the table's `sqlite_sequence`
         row, and the `sql` of every index, trigger and view that depends on the table.
      2. `PRAGMA foreign_keys=OFF` (outside the transaction)
      3. `BEGIN`
      4. `DROP VIEW` / `DROP TRIGGER` for the dependants recorded in step 1
      5. `CREATE TABLE new_x`
      6. `INSERT … SELECT`
      7. `DROP TABLE x`
      8. `ALTER TABLE new_x RENAME TO x`
      9. recreate indexes, triggers and views from the recorded `sql`
      10. restore the `sqlite_sequence` row (`UPDATE sqlite_sequence SET seq = <old> WHERE
name = 'x'`, inserting it if missing)
      11. `PRAGMA foreign_key_check`: abort only on rows **not in the baseline**; pre-existing
          ones are shown as a warning
      12. `COMMIT`
      13. restore `PRAGMA foreign_keys` to the connection's setting

      The plan states `rebuild.reason`, and the UI shows it as a risk, with the optional "copiar
      el archivo antes" (`VACUUM INTO`).

    - "Auto increment" is only offered on `INTEGER PRIMARY KEY`, and `AUTOINCREMENT` is a separate
      checkbox (without it, SQLite may reuse deleted ids).
  - **TableDraft.** Keeps its shape and gains `options: Record<string, string | number | boolean>`
    for engine table options: MySQL engine, collation, AUTO_INCREMENT and comment; PG comment;
    SQLite `WITHOUT ROWID`/`STRICT`. `ColumnsEditor`, `IndexesEditor` and `ForeignKeysEditor` read
    type, index-method and FK-action lists from `typeCatalog`.

- **DDL editor** (`designer/ddl.ts`, `DdlEditorView.vue`). Templates and `buildDdlScript` come from
  the engine.
  - PG uses `CREATE OR REPLACE FUNCTION/PROCEDURE … $$ … $$` with no DELIMITER, and
    `DROP TRIGGER IF EXISTS n ON t` followed by CREATE.
  - SQLite uses DROP plus CREATE.
  - The "Quitar DEFINER" switch appears only when `capabilities.definer`.
- **Data grid** (`columnKind.ts`, `rowEditing.ts`, `EditableGrid.vue`).
  - `typeKind` from the driver replaces MySQL type-name regexes. The regexes remain only as a
    fallback. This includes `ResultGrid.vue:13` `NUMERIC_TYPE` (MySQL-only names), which loses
    right alignment for PG `int4/numeric/float8` and SQLite `INTEGER/REAL` otherwise.
  - `keyColumns` follows the driver's `RowIdentity`. With `none`, the grid is read-only with the
    reason shown.
  - `enumValues` gives a dropdown on any engine. JSON/JSONB cells get a pop-up editor
    (pretty-print plus validation); `json` (not `jsonb`) columns are never used in a WHERE.
    SQLite cells show their storage class in the tooltip.
  - `components/data/privileges.ts:4-19` (`friendlyError`) matches MySQL errnos in message text.
    It gains an engine- and code-aware variant using `dialect.isPrivilegeError(code)`; the
    MySQL path is unchanged.
- **Table data view** (`TableDataView.vue`). The raw `WHERE` input stays for SQL engines.
  MongoDB opens `CollectionView` instead (section 9).
- **Shell.**
  - `AppToolbar.vue:59` "Nueva conexión MySQL…" becomes "Nueva conexión ▸ MySQL / MariaDB /
    PostgreSQL / SQLite / MongoDB".
  - The tree row shows the engine icon.
  - Toolbar buttons (Users, Events, Backup, Automation) follow the current connection's
    capabilities.
  - `InfoPanel` renders `ServerInfo.details`.
  - `NewDatabaseDialog` is driven by `createDatabase`: charset for MySQL, encoding/template/owner
    for PG, name plus first collection for MongoDB, hidden for SQLite.
  - Backup and job pickers (`BackupDialog.vue:50`, `RestoreDialog.vue:55,86`,
    `BackupsView.vue:56`, `JobTasksEditor.vue:15`) filter by capability.
  - `SettingsDialog.vue` gains the switch "Motores en vista previa" (D14).

### 8.2 Connection dialog per engine

The engine is chosen first (picker cards). It is fixed for existing connections and shown as a
chip. The tabs are General, SSH, SSL and Avanzado, shown per capability.

| Engine     | General tab                                                                                                                                                                                                                                                                                                                                                       | SSL tab                                                                                                                      | Avanzado tab                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| MySQL      | Today's form (host, port 3306, user `root`, password, custom DB list)                                                                                                                                                                                                                                                                                             | Today                                                                                                                        | Today: initial queries, backup folder (MySQL only)                                         |
| MariaDB    | Same, port 3306, plus a hint about ed25519/parsec                                                                                                                                                                                                                                                                                                                 | Same                                                                                                                         | Initial queries                                                                            |
| PostgreSQL | Host, port 5432, user `postgres`, password, **Base de datos inicial**, "Mostrar solo estas bases de datos", "Mostrar esquemas y bases de datos del sistema"                                                                                                                                                                                                       | **Modo SSL** select (`disable`/`allow`/`prefer`/`require`/`verify-ca`/`verify-full`), CA, CRL, client cert/key, key password | Initial queries, **Zona horaria de sesión**, Tiempo de conexión, Intervalo keepalive       |
| SQLite     | **File picker** ("Abrir archivo…" / "Nuevo archivo SQLite…"), read-only switch (with the reason when forced), attached databases list (alias + file), "Archivo no encontrado · Buscar…" state                                                                                                                                                                     | — (no SSH tab either)                                                                                                        | Initial queries (e.g. `PRAGMA`s), busy timeout, **Aplicar claves foráneas**                |
| MongoDB    | **"Pegar URI"** box that fills the fields (the password goes to the credential store, never into the config; credential query parameters are refused), method (Independiente / Conjunto de réplicas / Clúster fragmentado), SRV switch (turns TLS on), host list, replica set name, auth mechanism, auth source, user/password, default database, read preference | TLS on/off, CA, client cert+key (X.509), allow invalid hostnames                                                             | Tiempo de conexión, Intervalo keepalive, Retry writes / reads, opciones extra (non-secret) |

The connection menu gains **"Copiar URI"** for MongoDB and PostgreSQL (built from the config,
never containing the password). "Probar conexión" reports, besides the label and version
("Conectado · PostgreSQL 17.11"), the TLS state ("SSL: TLSv1.3" or "sin cifrar"), the SSH hop when
used, and for MongoDB the detected topology and member role. "Guardar contraseña" off
(`savePassword`, `shared/types.ts:17`) must prompt at connect time on every engine, including the
SSH passphrase and the SSL key password.

`connectionForm.ts` defaults come from `descriptor.defaultPort` and `defaultUser`. Validation is
`src/shared/connectionValidation.ts`.

---

## 9. MongoDB views

### 9.1 Collection browser (`views/CollectionView.vue`, P4a)

- **Toolbar.**
  - Inputs for Filtro `{}`, Orden `{}` and Proyección `{}`. They take shell syntax
    (`{_id: ObjectId('…'), at: {$gt: ISODate('…')}}`) and are parsed in main by
    `@mongodb-js/shell-bson-parser` in strict mode. An empty result counts as a parse error.
    Each input keeps a per-collection history of recent values (per viewer, local only).
  - skip/limit paging (default 100) plus **"Cargar más"** through the open cursor
    (`mongo:getMore`).
  - The count shows `estimatedDocumentCount` when there is no filter, otherwise
    `countDocuments({maxTimeMS: 3000})`, labelled "≈" when not exact.
- **Three modes**, remembered per tab:
  - **Tabla.** Columns are the top-level fields of the sampled page, `_id` first, then by
    frequency. A column whose values have several BSON types shows a "mixto" badge, and each cell
    a type icon. Cells show a shell-syntax preview: `ObjectId('…')`, `ISODate('…')`,
    `NumberLong('…')`, `{…} 3 campos`, `[…] 5`. **Inline editing keeps the cell's BSON type**: the
    editor shows the plain value plus a type dropdown (Int32, Int64, Double, Decimal128, String,
    Boolean, Date, ObjectId, Null, …) that defaults to the current type, and main builds the
    typed value. Typing `5` into an Int32 cell stays Int32 (shell parsing would have made it a
    Double). Nested values open the document editor at that path.
  - **Árbol.** Expandable key, value and type rows (`DocumentTree.vue`) with per-node
    edit/add/remove, using the same typed editor. "Añadir elemento" / "Eliminar elemento" on
    arrays send `$set` of the whole array.
  - **JSON.** One shell-syntax text block per document.
- **Rendering.** The renderer converts canonical EJSON to shell text with
  `src/shared/mongo/shellFormat.ts`, a pure function of about 100 lines that maps `$oid`, `$date`,
  `$numberLong`, `$numberDecimal`, `$numberInt`, `$numberDouble`, `$binary` (subtype 4 and 3 as
  `UUID('…')`), `$timestamp`, `$regularExpression`, `$minKey` and `$maxKey`. The renderer needs no
  `bson` dependency.
- **Dates** show UTC with a `Z` by default, local time in the tooltip, and a per-tab "Hora local"
  toggle. Dates outside years 0–9999 render as `new Date(<ms>)` instead of failing.
- **ObjectId.** "Copiar" gives the hex value; "Copiar como filtro" gives `{_id: ObjectId('…')}`;
  the tooltip shows the creation time embedded in the id.
- **Size limits.** Documents larger than 256 KB are sent truncated (`whole: false`) with a
  "documento grande: abrir completo" action. Nesting deeper than 20 levels is collapsed.
- **Read-only collections.** Capped, time-series and view collections, and GridFS `*.chunks`,
  carry a `readOnlyReason` from `listCollections` options, and the matching server errors are
  mapped.
- **Indexes (read-only).** A collapsible panel lists the collection's indexes from P4a, so users
  can see why a query is slow before the designer arrives (P4b).
- **Collection list columns:** document count, size, storage size, index count and average
  document size (from `$collStats`).

### 9.2 Document editing (P4a)

- `DocumentEditorDialog.vue` edits a document as shell-syntax text. The `_id` line is read-only.
  - **Replace only whole documents.** If the document was fetched whole (`whole[i]`: no
    projection, no inclusion `$project`, not truncated), saving sends
    `{kind: 'replace', fetchedWhole: true}`. Otherwise the editor first **refetches the full
    document by `_id`**; if that is impossible it diffs the edit and sends `$set`/`$unset`. Main
    refuses `replace` without `fetchedWhole`. `replaceOne` on a projected document would delete
    every field that was not shown.
- Inline grid and tree edits send `{kind: 'update', set, unset, expected}` with dotted paths.
  - **Optimistic check.** The filter is `{_id, <path>: <original value>, …}` for every edited
    path. `matchedCount === 0` reports "El documento ha cambiado desde que se cargó; recarga".
  - **Arrays.** Removing or inserting an element sends `$set` of the whole array; `$unset` on
    `tags.2` would leave `null`.
  - **Field names containing `.` or starting with `$`** cannot be addressed by dotted path. In
    v1 those fields are read-only inline with "Edita el documento completo".
- In main, `changes.ts` parses each value with shell-bson-parser (strict) or
  `EJSON.parse(text, {relaxed: false})`. It filters by the **original `_id` value of any BSON
  type**, and applies `updateOne($set/$unset)`, `replaceOne`, `insertOne` or `deleteOne`.
  Verified: ObjectId, Decimal128 and Long survive the round trip.
- Errors map to Spanish messages: `121` "El documento no cumple el validador" plus a summary of
  `errInfo` (not logged), `11000` "Clave duplicada en el índice …" (a `ServerError`, so the key
  value is never logged), and `13` "Sin permisos".
- Batches use a transaction only on replica sets or mongos. Elsewhere they apply one by one and
  report per-row results.
- New documents use "Insertar documento" (shell text), prefilled with the sampled field names and
  typed placeholders (`ObjectId()`, `new Date()`, `NumberInt(0)`); `_id` is generated by the
  driver when absent. "Duplicar documento" copies a document without `_id` into the same editor.

### 9.3 Query editor (`QueryView.vue` with a MongoDB branch)

- **P4a: reads.** `find`, `findOne`, `aggregate` (without `$out`/`$merge`), `countDocuments`,
  `estimatedDocumentCount`, `distinct`, `getIndexes`, `explain`, plus a fixed whitelist of
  read-only commands: `db.stats()`, `db.coll.stats()`, `db.currentOp()`, `db.serverStatus()`,
  `db.version()`, `db.getCollectionNames()`, `rs.status()`, mapped to `dbStats`, `collStats`,
  `currentOp`, `serverStatus`, `buildInfo`, `listCollections` and `replSetGetStatus`. **P4b:
  writes** (`insertOne/Many`, `updateOne/Many`, `replaceOne`, `deleteOne/Many`,
  `findOneAndUpdate/Replace/Delete`, `bulkWrite`, `createIndex`, `dropIndex`, `drop`).
- **Grammar** (a whitelist; acorn parses each top-level statement as one expression):
  - `db.<coll>.<method>(args)` with chained modifiers, plus `db.getCollection('x')` and
    `db['my-coll']`.
  - `use <db>`, `show dbs` and `show collections` are handled before parsing.
  - Modifiers: `sort`, `limit`, `skip`, `project`, `hint`, `collation`, `maxTimeMS`.
  - **Pasted mongosh tolerance.** `.pretty()`, `.toArray()` and `.itcount()` are accepted as
    no-ops; `.count()` maps to `countDocuments`. `var`/`const`/`let` and `.forEach(…)` get a clear
    error with a hint. Before P4a is done, a test confirms that shell-bson-parser strict mode
    accepts `new Date()`, `ISODate()`, no-argument `ObjectId()`, regex literals, `UUID('…')` and
    `Date.now()`; the probe only checked safety, not this coverage.
  - Anything else is rejected with its source position: "Solo se admiten llamadas
    db.colección.método(...)". `runCommand` and any command outside the whitelist are refused.
- **Arguments** are the source slices of each argument node, parsed with shell-bson-parser in
  strict mode. User code is never `eval`'d, `vm`'d or `Function`'d.
- **Results.** `MongoCommandResult` has `kind: 'documents' | 'write' | 'value'`.
  - Documents use the same three-mode viewer, with "Cargar más", and are editable when the rule
    in section 5.4 holds.
  - Writes show matched, modified, inserted, deleted and upserted counts.
  - Values show text.
  - Row caps use `find().batchSize(500).limit(cap+1)`. Aggregates get a `$limit` appended **at
    the end**, never inserted before `$group` or other stages.
- **Completion** suggests:
  - collection names after `db.`
  - methods after `db.x.`
  - `$` operators inside objects
  - sampled field paths from `mongo:sampleFields`, cached per collection

### 9.4 Aggregation pipeline editor (`views/AggregateView.vue`, P4b)

- A list of stages. Each stage has an operator select (`$match`, `$project`, `$group`, `$sort`,
  `$limit`, `$lookup`, `$unwind`, `$addFields`, `$count`, …), a body editor (shell syntax), an
  enable switch and drag reorder.
- "Vista previa en esta etapa" runs the pipeline up to stage _i_ with `$limit 20` appended at the
  end (`mongo:aggregate` with `previewStage`) and shows the stage's document count.
- "Copiar como comando" generates `db.coll.aggregate([...])` for the query editor.
- A pipeline that contains `$out` or `$merge` is a write and goes through the production guard.

### 9.5 Collection designer (`views/CollectionDesignerView.vue`, P4b)

This is MongoDB's "table designer" (`capabilities.designer === 'collection'`).

- **Índices:** list and create. Options:
  - key fields with 1, -1, text, 2dsphere or hashed
  - unique, sparse
  - TTL (`expireAfterSeconds`)
  - partial filter
  - collation
  - hidden

  Dropping an index needs confirmation. `_id_` cannot be dropped.

- **Validador:** a `$jsonSchema` editor (shell syntax), plus `validationLevel` and
  `validationAction`. Saving runs `collMod`.
- **Opciones:** read-only (capped/size, timeseries, view `viewOn` + pipeline).
- A "Generar esquema" helper proposes a `$jsonSchema` from `mongo:sampleFields` (optional).

---

## 10. Production guard per engine

Shared rule (unchanged): main checks the guard for every write channel, and the renderer asks
first and sends `confirmProduction: true`. Two functions per dialect (D13):

- **Renderer, `dialect.analyzeWrites(script)`** is an **allowlist**: a statement is a read only
  if it is provably read-only; anything else is a write, with a Spanish reason for the dialog
  ("DELETE sin WHERE", "Función con efectos: pg_terminate_backend", "PRAGMA de escritura", …).
  `QueryView.vue:224-247` shows these reasons.
- **Main, `dialect.isObviousWrite(statement)`** is a small **denylist**. Main must never flag
  what the renderer lets through without asking, so for every dialect a test asserts
  `isObviousWrite(s) ⇒ analyzeWrites(s).writes` over the whole corpus.

`ipc/productionGuard.ts` `assertScriptAllowed(ctx, id, script)` looks up the connection's engine,
then uses `dialect.splitStatements` and `dialect.isObviousWrite` (or the MongoDB classifier).

| Engine     | Renderer allowlist (`analyzeWrites` read rules)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Main denylist (`isObviousWrite`)                                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MySQL      | Today's `writeGuard.ts` `analyzeWrites`, unchanged (golden tests)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Today's `productionGuard.ts` `WRITE_KEYWORDS`/`leadingKeyword`, unchanged                                                                                                                                                              |
| MariaDB    | MySQL + `/*M!` unwrap + `RETURNING`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | MySQL + `/*M!` unwrap                                                                                                                                                                                                                  |
| PostgreSQL | Reads: `SELECT`/`VALUES`/`TABLE`/`WITH` whose body has **no** DML at any depth (writable CTEs), no `SELECT … INTO`, no `FOR UPDATE/SHARE`; `SHOW`; `EXPLAIN` without `ANALYZE` (or `EXPLAIN ANALYZE` of a read); `SET`/`RESET` of a whitelisted session-local setting (`search_path`, `statement_timeout`, `TimeZone`, `DateStyle`, `application_name`, …). **Plus a function denylist**: any call to `pg_terminate_backend`, `pg_cancel_backend`, `pg_reload_conf`, `set_config`, `dblink_exec`, `dblink`, `pg_advisory_lock*`, `lo_*`, `pg_*file*`, `nextval`, `setval` makes it a write. Everything else is a write, including `SET ROLE`, `SET SESSION AUTHORIZATION`, `SET … READ WRITE`, `default_transaction_read_only`, `DISCARD`, `RESET ALL`, `CHECKPOINT`, `LOAD`, `ANALYZE`, `LISTEN/NOTIFY`, `DO`, `CALL`, `COPY` other than `COPY … TO STDOUT`.                                  | INSERT, UPDATE, DELETE, MERGE, CREATE, ALTER, DROP, TRUNCATE, GRANT, REVOKE, COPY … FROM, CALL, DO, REFRESH, VACUUM, CLUSTER, REINDEX, COMMENT, SECURITY LABEL, REASSIGN, IMPORT FOREIGN SCHEMA                                        |
| SQLite     | Reads: `SELECT`/`VALUES`/`WITH` without `INSERT`/`UPDATE`/`DELETE`/`REPLACE` anywhere (SQLite allows `WITH … DELETE`); `EXPLAIN [QUERY PLAN]` of a read; **`PRAGMA` only from a read whitelist** (`table_info`, `table_xinfo`, `table_list`, `index_list`, `index_info`, `index_xinfo`, `foreign_key_list`, `foreign_key_check`, `database_list`, `integrity_check`, `quick_check`, `compile_options`, `collation_list`, `function_list`, `pragma_list`, `module_list`, `page_count`, `freelist_count`), and for setting-style pragmas (`query_only`, `foreign_keys`, `journal_mode`, `user_version`, `encoding`, `page_size`, …) **only the bare form with no argument** — any `=` or `(…)` argument is a write. Unknown pragmas (`optimize`, `wal_checkpoint`, `incremental_vacuum`, `shrink_memory`, `writable_schema`, …) are writes. `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT` are neutral. | INSERT, UPDATE, DELETE, REPLACE, CREATE, ALTER, DROP, VACUUM, REINDEX, ATTACH, DETACH, `PRAGMA` with `=` or `(`                                                                                                                        |
| MongoDB    | `src/shared/mongo/classify.ts`: reads are exactly the P4a read methods and read-only command whitelist (section 9.3); everything else, including `aggregate` with `$out`/`$merge`, is a write                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `insert*`, `update*`, `replace*`, `delete*`, `findOneAnd*`, `bulkWrite`, `create*`, `drop*`, `rename*`, `collMod`, `$out`/`$merge`. All `mongo:applyChanges`, `createIndex`, `dropIndex`, `setValidator` and `createCollection` calls. |

Repro that motivated the SQLite rules (verified on SQLite 3.53.4):
`PRAGMA query_only(0); WITH t AS (SELECT 1) DELETE FROM users` used to pass as two reads, the
first one switching off the read-only safety net.

**Defence in depth on production connections (new engines only, so MySQL is unchanged):**

- **PostgreSQL.** Production tab sessions and pooled sessions run with
  `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` (verified: writes then fail with
  `25006`), re-applied together with the pinned settings after every `DISCARD ALL`. When a script contains a confirmed write, main runs `SET SESSION
default_transaction_read_only = off` before that script and restores `on` after it, unless a
  transaction is open, in which case it restores it when the transaction ends. A transaction the
  user opened under a read-only script stays read-only; a confirmed write in it fails with
  "La transacción se abrió en modo solo lectura: ejecuta ROLLBACK y repite el script con la
  escritura". **No `BEGIN READ ONLY … COMMIT` wrapper**: its `COMMIT` would commit the user's own
  open transaction halfway through a script. A side effect hidden in a function
  (`SELECT my_func()`) fails with `25006`. Functions that bypass read-only transactions
  (`pg_terminate_backend`, `pg_cancel_backend`, `pg_reload_conf`, `dblink_exec`,
  `pg_advisory_lock`) are caught by the function denylist above.
- **SQLite.** `readOnly` defaults to true for production, with "Reabrir en modo escritura" (with
  confirmation) as the explicit way to write. On a read-write production connection, reads run
  with `PRAGMA query_only=ON`, and `query_only` itself can only be changed by a confirmed write.
- **MongoDB.** `mongo:execute` refuses `runCommand` and any method or command not on the
  whitelist. On production, writes need confirmation like every other engine.

---

## 11. Backups and automation stay MySQL-only

> **Update (2026-10-08, automation for every engine).** `supportsAutomation` is now true for every
> engine. PostgreSQL, SQLite and MongoDB jobs have backup steps (`.vqb`, optionally encrypted with the
> job's password) and restore steps (REPLACE from a `.vqb` of the same engine, with the engine's own
> safety copy); query steps stay MySQL/MariaDB only (the runner's SQL goes through MySQL sessions).
> The rules live in `src/shared/jobEngines.ts` and are checked by the job editor, `jobs:save` and the
> runner; restore steps keep every production/typed-confirmation rule (never from a job, «Restaurar
> todo» only after typing the name). «Restaurar todo» lists the target's databases per engine
> (`automation/targetDatabases.ts`) and flags a copy of another engine or a system database
> (`template0/1`, `admin/local/config`, SQLite `temp`). Navicat batch jobs still resolve only to
> MySQL/MariaDB connections. Tested end to end per engine in `tests/integration/automationEngines.test.ts`
> (scratch profile, launchd agent written to a scratch home with a fake `launchctl`, a headless run).

> **Phase 4b update (.vqb).** Backups are no longer MySQL-only: Vortaq's own format `.vqb`
> (`docs/vqb-format.md`) is the default for new backups and is the only backup format of
> PostgreSQL (capability `supportsBackupsVqb`; `hasBackups()` = `.nb3` or `.vqb`). `.nb3` stays
> MySQL-only (the gates below still apply to it), restores go to the same engine only, and
> automation stays MySQL-only (`supportsAutomation`), so PostgreSQL has no job steps, packages or
> «Restaurar todo» yet.
>
> **P3 update (SQLite).** SQLite also has `.vqb` backups (`supportsBackupsVqb: true`) of one database
> (main or an attachment) with each cell's storage class, restored into a new file or replacing the
> database after a VACUUM INTO safety copy; «Copia del archivo (VACUUM INTO)» is the fast native copy.
> Automation stays off for SQLite.
>
> **P4 update (MongoDB).** MongoDB also has `.vqb` backups (`supportsBackupsVqb: true`) of one database (or
> some of its collections): documents as canonical Extended JSON, collection options, validators, indexes and
> views, restored into another database or replacing it after a safety copy. Automation stays off for MongoDB.

All of these gates are checked in main and mirrored in the UI (coupling §5).

| Where                                                                                                                                                                 | Gate                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `backup/create.ts:247` (after lookup), `backup/restore.ts:155` (next to `assertRestoreAllowed`), `backup/index.ts:60-69` list                                         | `assertCapability(conn, 'supportsBackupsNb3', …)`. `list` returns `[]`.       |
| `ipc/jobs.ts:12-26` `validateJobInput`, `automation/runner.ts:93,362-366`                                                                                             | Reject non-`mysql` connections at save and at run.                            |
| `navicat/importer.ts:80-96` `resolveServer`                                                                                                                           | Resolve a Navicat job's `Server` only among `engine === 'mysql'` connections. |
| Renderer: backup group (`objectTypes.ts:5`), menus (`useObjectActions.ts:220-330`), toolbar (`AppToolbar.vue:147-160`), pickers, `ConnectionDialog.vue:477` backupDir | Shown only when the capability is true.                                       |

A `mysql` connection whose server turns out to be MariaDB keeps backups (D4), with the pre-backup
warning for system-versioned tables and sequences (section 5.6). **No other backup code changes:**
the MariaDB-unknown `SET SESSION information_schema_stats_expiry` is already best effort
(`withFreshStats`, `backup/create.ts:105-126`, wraps it in try/catch), so revision 1's proposed
flavour guard there is dropped.

---

## 12. Navicat import for every engine

Facts from the user's own files (`docs/navicat-storage.md`), from `.ncx` files exported with
Navicat's own export and from the public Navicat manual:

- macOS Navicat writes **one** `Common/conn.plist`, shaped `<user>/<project>/<TypeKey>/<name>`.
  `MySQL` is verified on the user's files; the other type keys (`MariaDB`, `PostgreSQL`,
  `SQLite`, `MongoDB`, and the unsupported `SQL Server`, `Oracle`, `Redis`, `Snowflake`, `ODBC`)
  follow the product names of the manual and are confirmed only with user-provided samples (open
  question 1). Cloud flavours are a `serviceprovider` inside the base type.
- Colours live at `pref.plist` `connpref/<u>/<p>/<TypeKey>/<name>/""/""/serverpref/markercolor`.
- **Passwords are not in any file Navicat leaves in the user's folder.** Vortaq does not read
  Navicat's keychain items or any other application's private data; passwords are typed by the
  user or come from an `.ncx` the user exports.
- An `.ncx` exported with **Export Password** carries the passwords encrypted with the fixed
  scheme of that file format (AES-128-CBC in current versions, Blowfish in older ones).
  `src/main/importers/navicat/ncxCipher.ts` implements and tests both; it is used only for `.ncx`
  files the user exports.

**When each part ships (D11).** The generic plumbing (type sections, `(navicatType, name)`
identity, `savepath`, colours, preview rows for unsupported types) ships in **PN**, together with
`.ncx` password import, MySQL first. Each engine's field mapping then ships **in that engine's
phase**: PostgreSQL in P2a, SQLite in P3, MongoDB in P4a, MariaDB in P5. Until its phase is done,
an engine's rows are previewed but not importable ("Disponible en una próxima versión"), and
preview engines follow the preview flag (D14).

**Confidence.** Several non-MySQL plist encodings are unverified (`ssl_param.mode`,
`connmethod`, `authmechanism`, `readpreference`, the shape of `memberlist` and
`attacheddatabases`). The local install is Navicat for MySQL only, so they cannot be confirmed
here. Anonymised samples from the user or a Navicat Premium trial (open question 1) are needed
**before P2a's import is finished**, not at the end. Parsing is tolerant meanwhile: an unknown
value becomes the default plus a warning.

### 12.1 `conn.plist` (macOS)

- `connPlist.ts:115-126`: `mysqlSections()` becomes `typeSections()`, walking every
  `<user>/<project>/<TypeKey>`. A table maps type keys to parsers:
  - `MySQL` → mysql
  - `MariaDB` → mariadb, using the same keys as MySQL
  - `PostgreSQL` → postgresql: `initialdatabase`, `ssl_param.mode` read case- and
    separator-insensitively (including `allow`), `usecustomdblist` as an **int**,
    `ssl_param.rootcert`/`crlfile`. `hostportlist` imports the first host with the warning
    "Solo se usa el primer host". `serviceprovider` `Redshift`, `HuaweiCloudGaussDB*`,
    `HuaweiOpenGauss` and `KingbaseES` give `engine: null` with "Servidor compatible con
    PostgreSQL no soportado: <proveedor>" (their catalogs lack `prokind`, `attidentity` or
    `pg_get_functiondef`); other providers (`Default`, RDS, Aurora, Google Cloud, Azure,
    `IvorySQL`, `FujitsuEnterprise`) import as `postgresql`.
  - `SQLite` → sqlite: `databasefile`; `sqliteencrypted` produces the unsupported reason
    "cifrada — no soportado"; `attacheddatabases` is listed as a warning until its inner shape is
    confirmed
  - `MongoDB` → mongodb: `connmethod`, `usesrvrecord`, `memberlist`, `replicasetname`,
    `authsource`, `authmechanism` (with `Kerberos` giving an unsupported reason) and
    `readpreference`, `retrywrites`/`retryreads` and timeouts, all case-insensitive, accepting
    both `ReplicaSet` and `Replica Set`. `serviceprovider` `DocumentDB` and `AzureCosmosDB` force
    `retryWrites: false` (with a note); `MongoDBAtlas` and SRV turn TLS on.
  - every other type → preview row with `engine: null` and "Tipo de conexión no soportado:
    SQL Server"
- Identity becomes `(navicatType, name)` instead of name only (`connPlist.ts:147-149`,
  `importer.ts:80-96`). Existing imported connections without `source.navicatType` count as
  `MySQL`.
- `paths.ts:11-31`: use each connection's **`savepath` as stored** instead of rebuilding
  `Settings/0/0/MySQL/<name>`. Backup-directory resolution and `.nb3` counting run for MySQL only.
- `colors.ts:83-100`: read colours for every type key and identity.
- `detect.ts`: report counts per type.

### 12.2 `.ncx` import (all platforms, the password route)

- New `src/main/importers/navicat/ncx.ts` with `parseNcx(xml)`. It uses `@xmldom/xmldom` 0.9.12, already
  installed through `plist`, promoted to a direct dependency. It reads only direct
  `<Connection>` children and their `<Member>`/`<Advance>` children, and tolerates a BOM.
- **Versions.**
  - 1.1 and 1.4 write the union schema (every attribute on every connection).
  - **1.5 omits default/off attributes**, so every attribute is optional with a per-engine
    default.
  - Decryption is chosen by `Ver` (< 1.4 → the Blowfish scheme; otherwise AES, then Blowfish),
    with a strict UTF-8 check (`decodeNcxPassword` in `ncxCipher.ts`).
- **`ConnType`** values are `MYSQL`, `MARIADB`, `POSTGRESQL`, `SQLITE` and `MONGODB`, compared
  case-insensitively. `SQLSERVER`, `ORACLE`, `REDIS`, `SNOWFLAKE` and unknown values are skipped
  with a reason. Note that the values are not `PGSQL`/`MSSQL`.
- **MongoDB replica sets.** `Host="localhost"` is a placeholder. The seeds come from `<Member>`
  and the database from `<Advance Database>`.
- **Secrets.** `Password`, `SSH_Password`, `SSH_Passphrase` and `SSL_PEMClientKeyPassword` go only
  to `CredentialStore`, and only when present and decryptable. They are never logged. The single
  `ssh` slot takes `SSH_Passphrase` when `SSH_AuthenMethod="PUBLICKEY"` and `SSH_Password`
  otherwise. `SSL_PEMClientKeyPassword` goes to the `sslKey` slot. The UI
  reminds the user: "Este archivo contiene contraseñas recuperables: bórralo después de importar."
- **Foreign paths.** A path that is not absolute on the current platform (a `C:\…` path on
  macOS, a POSIX path on Windows, which would resolve against the current drive) is stored with
  `pathNeedsReview: true` and the warning "Ruta de otro equipo: revísala". Such a connection
  cannot open (and never creates a file, invariant 8) until the user picks a file.
  `SettingsSavePath` is ignored off its own machine. `HTTP="true"` gives "Túnel HTTP no
  soportado".
- **Logging.** Preview and import warnings (foreign paths, connection names) go to the renderer
  only; `ipc/navicat.ts` logs counts, never the warning text, for the new channels.
- **Merge.** An `.ncx` connection whose `(ConnType, ConnectionName)` matches an existing imported
  connection updates only its secrets (`passwordsOnly`) unless the user picks "reemplazar". This
  is how a user brings Mac passwords across: import the plist for metadata and colours, then
  import the `.ncx` for passwords.
- **Renderer.** _Done in v2.0.0 as the «Importar…» wizard_ (`components/import/ImportWizard.vue`, sources in
  `src/main/importers/registry.ts`): the `.ncx` is one source next to the Navicat folder (which keeps
  `ImportNavicatDialog.vue`), DBeaver, MySQL Workbench, `.sql` dumps, dump folders and `.nb3`. The original
  plan was: `ImportNavicatDialog.vue` with source tabs "Navicat de este Mac" and "Archivo .ncx".
  Columns: engine icon, name, host or file, environment, "contraseña incluida", status
  (importable / ya importada / no soportada + reason) and warnings. The empty text becomes "No
  hay conexiones en Navicat".

### 12.3 No keychain access; Windows and Linux

- **Removed in v2.0.0.** The earlier "recover passwords from the Keychain" button and its
  `navicat:recoverPasswords` channel are gone. Vortaq never lists or reads another application's
  keychain items; after an import the user types each password, or imports an `.ncx` exported
  with Export Password.
- **Windows.** Navicat for Windows keeps its connections in the registry; reading it is not
  planned. Windows users export `.ncx` (the same route as every other platform).
- **Linux.** Linux users export `.ncx`.

### 12.4 Docs

`docs/navicat-storage.md` gets a per-type section and these corrections:

- `usecustomdblist` is an int.
- The extra MySQL keys are listed.
- The keychain row is removed (done in v2.0.0).
- `.ncx` format notes are added, from files the user exports.
- Unverified keys are marked as such.

CLAUDE.md requires reading this doc before touching import code.

---

## 13. Credentials

- `credentials/store.ts:22` `SecretKind = 'mysql' | 'ssh'` keeps its stored prefix. A TS constant
  `DB_PASSWORD: SecretKind = 'mysql'` carries the comment "generic database password slot; the
  prefix predates multi-engine". All engines use it, so no migration is needed (D10).
- New kinds are added only when needed: `'sslKey'` for the SSL client-key password, from P2a
  (the PG dialog needs it before `.ncx` import).
- `deleteAll` (`store.ts:88-91`) removes every kind, including `sslKey`, so deleting a
  connection leaves no orphaned secret. A test enumerates `SecretKind` to keep it in sync.
- A MongoDB URI pasted in the dialog has its password moved to the credential store and stripped
  from the stored config. **Query parameters that carry secrets** (`authMechanismProperties` such
  as `AWS_SESSION_TOKEN`, `tlsCertificateKeyFilePassword`, `proxyPassword`, `password`) are
  refused with "La URI contiene credenciales en los parámetros: quítalas". The raw URI is never
  stored, logged or echoed.
- **Linux secret storage (to verify).** `safeStorage.isEncryptionAvailable()` is reportedly true
  with the `basic_text` backend (a hardcoded key), so `bootstrap.ts:14-22,103-109` may never show
  PLAIN_SECRETS_NOTICE on keyring-less desktops. Check `safeStorage.getSelectedStorageBackend()`
  in PN, before `.ncx` import brings more production secrets onto Linux machines.

---

## 14. Packaging

| Package                                      | Phase | Kind                                               | Notes                                                                                                                                                                                                                                            |
| -------------------------------------------- | ----- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@xmldom/xmldom` 0.9                         | PN    | MIT                                                | Already present through `plist`; promoted to a direct dependency.                                                                                                                                                                                |
| `pg`, `pg-cursor`                            | P2a   | MIT, pure JS                                       | **Do not install `pg-native`.** `pg-query-stream` later, for export. `pgpass` is a hard dependency of `pg`; the password function form keeps it unused.                                                                                          |
| `node:sqlite`                                | P3    | built into Electron 44 (Node 24.20, SQLite 3.53.4) | No dependency. Import it only in `sqlite/core.ts`.                                                                                                                                                                                               |
| `mongodb` 7.7 (+ `bson` 7)                   | P4a   | Apache-2.0, pure JS                                | Leave the optional `kerberos`, `snappy`, `@mongodb-js/zstd`, `mongodb-client-encryption` and `@aws-sdk/credential-providers` uninstalled.                                                                                                        |
| `@mongodb-js/shell-bson-parser` 1.6, `acorn` | P4a   | Apache-2.0 / MIT                                   | Both direct dependencies from P4a (the filter bar needs the parser). In the repo `acorn` is only transitive through `eslint`, a devDependency, so it is not in the packaged app today. **Not** `ejson-shell-parser` (peer conflict with bson 7). |
| `@codemirror/lang-javascript`                | P4a   | MIT                                                | Mongo query editor (read queries ship in P4a).                                                                                                                                                                                                   |
| `@noble/curves`, `@noble/hashes` 2.4         | P5    | MIT, pure JS, **ESM-only**                         | Only if the MariaDB auth plugins ship. Verify loading from the CommonJS main bundle of a packaged app; otherwise inline them as done for `plist`.                                                                                                |

- `electron.vite.config.ts` adds a second main input `sqliteWorker: src/main/sqlite/worker.ts`.
  `utilityProcess.fork(join(__dirname, 'sqliteWorker.js'))`. Whether `utilityProcess.fork` can
  start a script **inside `app.asar`** is unverified; if the packaged smoke (15.4) fails, the
  worker goes to `asarUnpack`.
- `externalizeDepsPlugin` keeps `pg` and `mongodb` external. The MongoDB driver requires its
  optional modules lazily inside try/catch, so missing modules surface only as the verified "module
  not found" messages.
- `npmRebuild: false`, the asar layout and cross-building from the Mac are unchanged. Licences are
  MIT and Apache-2.0 only. Avoid `mariadb` (LGPL) and `better-sqlite3` (native, no Electron 44
  prebuilds).
- `package.json` `engines.node` becomes `>=24` in P3: `StatementSync.columns()` needs ≥ 23.11 and
  `setReturnArrays` needs ≥ 24.0, for vitest running `core.ts` outside Electron.
- Expected app size growth is about 10 MB (pg ≈ 0.9 MB, mongodb + bson ≈ 6.4 MB, parsers ≈
  0.8 MB). Each open SQLite connection adds one Electron utility process (tens of MB), hence the
  cap of 4.

---

## 15. Testing strategy

### 15.1 Unit tests (vitest `node` project; `*.test.ts` next to the code, no `electron` imports)

- **Dialects** (table-driven, one corpus per engine):
  - splitter cases: MySQL `DELIMITER`, `/*!`/`/*M!`; PG `$tag$` nested, `E'\''`, nested
    comments, `#>>`/`?|`; SQLite trigger `BEGIN…END`, `[ident]`
  - guard corpus per dialect, run through both functions, plus the property
    `isObviousWrite(s) ⇒ analyzeWrites(s).writes`. Must include: PG writable CTE,
    `SELECT … INTO`, `COPY … TO STDOUT` vs `FROM`, `EXPLAIN ANALYZE <write>`,
    `SELECT pg_terminate_backend(1)`, `SELECT set_config(…)`, `SELECT nextval(…)`, `SET ROLE`,
    `SET SESSION CHARACTERISTICS … READ WRITE`, `DISCARD ALL`, `CHECKPOINT`; SQLite
    `PRAGMA table_info(t)` (read), `PRAGMA query_only` (read), `PRAGMA query_only(0)`,
    `PRAGMA query_only = 0`, `PRAGMA optimize`, `PRAGMA wal_checkpoint`,
    `WITH t AS (SELECT 1) DELETE FROM u` (writes)
  - quoting and PG case folding, completion with mixed-case and reserved names
  - `selectPage`
  - **MySQL golden tests:** every existing splitter, guard (both functions, including the dialog
    reasons) and quoting test moves next to `dialects/mysql.ts` unchanged.
- **Drivers without a server:**
  - PG type-parser table, `resultSource` SQL builder, SSL mode → options mapping (including
    `allow`), **ambient-credential test** (`PGPASSWORD`, `PGUSER`, `PGDATABASE` and a temp
    `PGPASSFILE` set; none used), search_path composition (keeps `public` and dedupes)
  - MariaDB default unquoting, flavour detection, backup-warning object list, auth plugins (P5)
  - SQLite `core.ts` against temp files (runs everywhere, Node 24): missing path refused and
    **not created**; a `C:\…` path on POSIX refused; ATTACH path bound as a parameter; rowid
    identity with shadowed `rowid`/`_rowid_`/`oid`; storage classes kept
  - Mongo URI/options builder (SRV implies TLS, replica set, SSH forcing `directConnection`,
    SRV+SSH rejected, credential query parameters refused, DocumentDB forcing
    `retryWrites=false`, credentials never in the URI given to the client)
  - EJSON round trip (Long > 2^53, Decimal128, ObjectId, Date out of 0–9999, Binary, UUID)
  - shell grammar whitelist and safety: `''` → error; `process.exit()`, IIFE and `Math.floor()`
    rejected; pasted-snippet tolerance (`.pretty()`, `.count()`, `new Date()`, `ObjectId()`,
    `/re/i`, `UUID('…')`)
  - `classify.ts`
- **DDL planners:** snapshot tests per engine (create; alter type/null/default/rename/index/FK;
  PG reorder refused; PG `ADD VALUE` emitted before the transaction; SQLite rebuild order with
  dependent views/triggers dropped and recreated, `sqlite_sequence` restored, and the FK
  baseline).
- **Repo and IPC:** `engine` normalisation, engine immutability **through
  `ConnectionsRepo.save`** (and therefore through the importer), capability rejections (backups,
  jobs, `db:events` on a fake PG connection), string `SchemaRef` rejected for PG,
  `IPC_INVOKE_CHANNELS` parity, `deleteAll` covering every `SecretKind`.
- **Logging:** a value-echoing `ServerError` and Navicat warnings with foreign paths pass through
  the IPC error and import paths; the captured log contains neither the value nor the path.
- **Navicat:**
  - a synthetic multi-type `conn.plist` and `pref.plist` (PG with each `ssl_param.mode` spelling,
    Redshift provider, `hostportlist`; Mongo DocumentDB provider)
  - synthetic `.ncx` fixtures built with `encryptNavicat11`/`encryptNavicat12`: Ver 1.1 union,
    1.4, 1.5 sparse, no-password export, Mongo replica set with `<Member>`/`<Advance>`, SQLite
    with a Windows path (flagged `pathNeedsReview`), SSH password vs passphrase, skipped types,
    BOM, XML entities
  - **No real hosts, users or data** (CLAUDE.md).

### 15.2 Web tests (vitest `web` project)

- `ConnectionDialog` per engine: fields, validation, URI paste (credential parameters refused),
  "Copiar URI" without password
- tree with the PG database level, closed databases, node-id escaping, two databases with the same
  `public.users` opening two tabs
- query toolbar: PG database + schema combos, transaction state, close-tab prompt
- menus and toolbar per capability; MySQL menus unchanged (snapshot)
- `ResultGrid` alignment from `typeKind`
- `CollectionView` modes, typed inline editor, "Cargar más"
- `shellFormat` rendering (UTC/local dates, UUID)
- `DocumentTree` editing (array element removal sends whole-array `$set`)

### 15.3 Integration tests and the MySQL gate

Today the gate can pass without testing anything: `tests/integration/mysql.test.ts:57` and
`backup.test.ts:115` use `describe.skipIf(!url)`, `npm run check` never sets the URL, there is no
CI (`.github/` is absent), and the tests pin MySQL 8.4 (`mysql.test.ts:124,129,855`) while the
user's production server is MySQL 5.7. Changes, all in P1a:

- **`npm run test:integration:required`** sets `VORTAQ_REQUIRE_INTEGRATION=1`; with it, a
  missing URL makes the suite **fail** instead of skip. Every phase's "done when" uses this
  command, not `test:integration`.
- **MySQL 5.7 and 8.4.** `tests/docker-compose.yml` (new) declares throwaway containers bound to
  `127.0.0.1` and never on 3306/3307: `mysql:8.4` on **33306** (the existing test container) and
  `mysql:5.7` on **33357** (amd64-only image, runs emulated on Apple Silicon with
  `platform: linux/amd64`). Version-pinned expectations become per-version. The MySQL and backup
  suites run against both.
- The other engines join the same compose file in their phases:

| Engine     | Env var (`VORTAQ_` prefix; `ELECTRONDB_`/`NAVIDOG_` accepted) | Container (never ports 3306/3307)                                                                                                                                                                   | Phase |
| ---------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| MySQL      | `TEST_MYSQL_URL` (existing), `TEST_MYSQL57_URL`               | `mysql:8.4` on 33306, `mysql:5.7` on 33357                                                                                                                                                          | P1a   |
| MariaDB    | `TEST_MARIADB_URL`                                            | `mariadb:11` on **33316**                                                                                                                                                                           | P1b   |
| PostgreSQL | `TEST_PG_URL`                                                 | `postgres:17` on **55432**, with `uuid-ossp` and `pgcrypto` created in `public`                                                                                                                     | P2a   |
| SQLite     | none (always runs)                                            | temp files built from `tests/fixtures/sqlite/*.sql` (WITHOUT ROWID, STRICT, generated columns, views on rebuilt tables, triggers, FKs with a pre-existing violation, AUTOINCREMENT, BLOB, big ints) | P3    |
| MongoDB    | `TEST_MONGO_URL`, `TEST_MONGO_RS_URL`                         | `mongo:8.2` on **57017** (standalone) and **57018** (`--replSet rs0`, single node, for transactions). **Pin 8.2:** `mongo:8` (8.3.x) refuses to start on Docker Desktop kernels ≥ 6.19.             | P4a   |

- **Driver conformance suite** (`tests/integration/driverContract.ts`), run per SQL engine:
  - open/test/close
  - list databases, schemas and objects
  - create a table **from the engine's DdlPlanner output**
  - insert, update and delete through `applyRowChanges`, with insert-id read-back
  - **insert with an omitted default/identity column** (and `GENERATED ALWAYS` read-only)
  - editable-result metadata through join, alias and view (expect refusal)
  - `maxRows` truncation
  - the value-fidelity contract per type, under the pinned session settings
  - error mapping, with server values absent from the log
  - cancel, including a late cancel that must not hit the next statement
  - tab session: `BEGIN` in one run and `COMMIT` in the next; a guard read on production does
    not commit the user's open transaction
  - **search_path keeps the extension schema** (`uuid_generate_v4()` works with the tab on a
    non-`public` schema)
  - **AUTOINCREMENT high-water mark survives a SQLite rebuild**; a rebuild with a dependent
    view succeeds; a pre-existing FK violation does not abort it
  - the production guard rejecting an unconfirmed write

  MongoDB has a parallel document suite, which includes **"Int32 stays Int32 after inline
  edit"**, **"replace refused on a projected document"**, array element removal, the optimistic
  conflict message, and read-only reasons for capped/time-series/view collections.

### 15.4 Packaged-app smoke (all three platforms)

`node:sqlite` and `utilityProcess` were verified only unpackaged on macOS, and v0.1.0 has no
Windows or Linux artifacts, so there is no baseline. `scripts/smoke-packaged.mjs` (new, P3) runs
against the output of `npm run dist`: start the app, fork the SQLite worker from the packaged
layout, open/query/cancel-by-kill/reopen, and load `pg` and `mongodb` (later also the
`@noble/*` ESM modules). It runs on macOS, Windows x64 and Linux x64 (AppImage) before any
prerelease that touches P3 or later code. It is manual until CI exists (open question 9).

---

## 16. Phased implementation plan

> **Release policy (decided by the user, 2026-10-05 — overrides any other text in this document):**
>
> - `main` is the stable MySQL-only line and the only source of "Latest" releases (v0.1.x). MySQL
>   fixes land on `main` and are released as v0.1.1, v0.1.2… only after the user approves each one.
> - All multi-engine work (every phase P1a…P5) stays on `feature/multi-engine` (and phase branches
>   cut from it). It is NOT merged into `main` and never published as "Latest". Test builds, if the
>   user asks for them, are GitHub pre-releases only.
> - The multi-engine line becomes a new version (decided: **Vortaq 2.0.0**; ElectronDB ends at 0.1.9) and is merged/released only when the
>   user explicitly approves it. The "each phase merges into main behind the preview flag" rule
>   below is superseded: phases merge into `feature/multi-engine` instead.

Each phase ends with `npm run check` green, `npm run test:integration:required` green for MySQL
5.7 and 8.4 and for every engine shipped so far, CLAUDE.md "Layout" updated when folders change,
and a demo checklist run by hand. Each phase merges into `main` on its own and leaves `main`
releasable: unfinished engines are behind the preview flag, and builds are prereleases (D14).

Order and parallelism:

```
P0 (done) ─► P1a ─┬─► P1b (MariaDB fixes) ────────────────────────────────┐
                  ├─► PN (Navicat plumbing + .ncx passwords) ─────────────┤
                  └─► P2a (PG read + tab sessions) ─┬─► P2b (PG edit) ─────┼─► P4a ─► P4b ─► P5 (MariaDB engine)
                                                    └─► P3 (SQLite) ───────┘
```

### P0. Baseline release — **done**

The user asked to keep the current stable version as the repo's **first "latest"** before any
multi-engine work goes up. Verified read-only on 2026-10-05:

- `origin/main` = `c147306`, `package.json` 0.1.0.
- Annotated tag `v0.1.0` is pushed and points to `c147306`.
- The GitHub Release "ElectronDB v0.1.0 — primera versión estable" (the earlier product name) is
  published as **Latest** (not draft, not prerelease) with `ElectronDB-0.1.0-arm64.dmg` and
  `ElectronDB-0.1.0-arm64-mac.zip`.

Remaining, each needing the user's go-ahead (open question 2):

- Cut `release/0.1.x` from `v0.1.0` for hotfixes, since `main` will carry the refactor.
- Optionally build x64 macOS, Windows and Linux artifacts from `v0.1.0` and attach them, so those
  platforms also have a stable fallback.
- Policy from now on: nothing from `feature/multi-engine` is tagged or released as Latest; every
  multi-engine build is a **prerelease** until the user promotes one.

### P1a. Engine abstraction with MySQL behind it (no behaviour change)

Split into PRs, each green and releasable on its own:

1. **Test gate** (15.3): `test:integration:required`, compose file with MySQL 5.7 and 8.4,
   per-version expectations. Lands first so every later PR is measured by it.
2. **Model:** `engine`, engine blocks, neutral metadata types, `SchemaRef`/`NameRef`,
   `ServerInfo.runtime`, `src/shared/engines.ts` (only `mysql` used; preview flag),
   `connectionValidation.ts`, normalisation and engine immutability in `ConnectionsRepo`,
   `SettingsDialog` preview switch.
3. **Dialects:** `src/shared/dialects/{types,index,mysql}.ts` wrapping today's functions
   (`splitStatements`, `isObviousWrite`, `analyzeWrites` with reasons, quoting), moved verbatim
   and re-exported from the old paths.
4. **Main split:** `src/main/db/{driver,registry,manager,errors,tunnel,query,tableData,rowChanges}`,
   `mysql/driver.ts` adapter, `DbUserError`/`ServerError`, tunnel move with a re-export shim,
   backup/automation capability gates, `deleteAll` over every kind, `closeAll` logging only
   `describeForLog`.
5. **Renderer:** engine UI registry (`engines/mysql.ts` wraps today's modules), `typeKind`/
   `primary`/`kind` with MySQL regex fallback (including `ResultGrid.vue:13`), capability-driven
   menus/toolbar/pickers, escaped tree ids, `database` fields on tabs and saved queries (unused
   by MySQL).

- **Tests.** Existing suites unchanged apart from import paths; MySQL dialect golden corpus
  (both guard functions); repo normalisation and immutability through the importer; capability
  rejections with a fake `engine: 'postgresql'` config; tree id escaping (a name containing `:`);
  web snapshot of MySQL menus.
- **Done when.**
  - `npm run check` and `npm run test:integration:required` pass against MySQL 5.7 and 8.4 with
    unchanged expectations (apart from per-version splits).
  - The diff of `introspect.ts`/`rowChanges.ts`/`tableData.ts`/`backup/*` shows no MySQL SQL
    literal changed.
  - Manual smoke on a MySQL connection: open an imported connection, browse, edit the grid,
    editable query result, designer alter, DDL editor, users, backup + restore, run a job,
    production confirmation with the same dialog reasons. All identical.
- **Risks.** Large diff (mitigated by the PR series and golden tests); `MysqlUserError`
  `instanceof` sites (subclass); tunnel move (shim); persisted tree expansion keyed by old node
  ids is reset once (acceptable, noted in release notes).

### P1b. MariaDB fixes for `mysql` connections (small)

- **Scope.** Flavour detection (`ServerInfo.runtime.flavor`); system-versioned tables listed and
  editable; `COLUMN_DEFAULT` unquoting; users from `mysql.global_priv`; count timeout with
  `SET STATEMENT max_statement_time`; extended type labels; INVISIBLE columns selected
  explicitly; MariaDB default collation in the designer; **pre-backup warning** for
  system-versioned tables and sequences. All keyed on the detected flavour, so MySQL servers are
  untouched. No separate engine, no new dialect, no auth plugins (moved to P5).
- **Tests.** `mariadb:11` on 33316 running the MySQL integration expectations that apply, plus
  default-unquote table, system-versioned listing, users view, count timeout, designer round
  trip, backup warning listing names.
- **Done when.** A `mysql` connection to MariaDB 11 lists and edits system-versioned tables,
  shows users, designs tables, and warns before a backup that would skip objects; the MySQL 5.7
  and 8.4 suites are unchanged.

### PN. Navicat import plumbing and `.ncx` passwords

- **Scope.** `typeSections()` over every `conn.plist` type key; identity `(navicatType, name)`;
  `savepath` as stored; colours and `detect.ts` per type; preview rows for every type (non-MySQL
  rows "Disponible en una próxima versión" or unsupported with reason); `src/main/navicat/ncx.ts`
  with `navicat:previewNcx`/`navicat:importNcx`, merge (`passwordsOnly` vs "reemplazar"), SSH
  password/passphrase rule, `sslKey` slot; `ImportNavicatDialog.vue` source tabs and delete-file
  reminder; warnings never logged; Linux `safeStorage` backend check; the import result points to
  `.ncx` for passwords; `docs/navicat-storage.md` per-type section and corrections.
- **Done when.**
  - The preview lists every section of a synthetic multi-type `conn.plist` with its type;
    unsupported types and providers are disabled with a reason.
  - Importing a synthetic `.ncx` (Ver 1.1, 1.4, 1.5) brings passwords into matching existing
    MySQL imports without touching their other fields.
  - If the user provides their own `.ncx` (open question 3), it imports passwords for their MySQL
    connections.
  - A log-capture test shows no secrets, foreign paths or connection names in `vortaq.log`.
- **Not testable locally:** the non-MySQL plist sections of a real install (Navicat for MySQL
  only here). Their field mapping is finished in each engine's phase, with samples (open
  question 1).

### P2a. PostgreSQL: connect, explore, read and query

- **Scope.** `pg` driver with explicit credentials (no env/pgpass), SSL modes including `allow`,
  SSH with SNI, timeouts and keepalive, pinned session settings, production read-only session;
  pool per database with closed/open databases, `datallowconn` filtering; database → schema tree
  with groups (`types` read-only), partitions nested, string `SchemaRef`
  rejected; read-only table grid (editing comes in P2b); **generic tab-session infrastructure**
  (`sessionKey`, `db:sessionState/commit/rollback/closeSession`, close-tab prompt) and the PG tab
  session with the search_path rule and `effectiveSchema` read-back; PG query toolbar with
  database + schema combos; PG dialect (split, both guard functions, function denylist);
  completion; notices; error positions; `db:cancel` bound to running executions; DDL viewer for
  every object; "Copiar URI"; "Probar conexión" with TLS/SSH details; **PG plist and `.ncx`
  mapping** in the importer (with unsupported providers).
- **Done when.** The user can import or create a PG connection (direct or over SSH), open
  databases and schemas in the tree, browse tables, views, materialized views, functions (with
  overloads), sequences and types, view table data, run multi-statement scripts with `$$`
  functions in a tab that keeps `BEGIN`/`SET`/temp tables between runs, commit or roll back from
  the toolbar, get schema-aware completion that keeps `public` extensions visible, see notices,
  and cancel a long query. The guard catches a writable CTE and `pg_terminate_backend`, and a
  read on production never commits the user's transaction. PG stays behind the preview flag.

### P2b. PostgreSQL: editing and design

- **Scope.** Grid editing with default/identity omission, `RETURNING *` refresh, typed binds,
  enum dropdown, JSON editor, large-value viewer (`db:cellValue`), PK-less tables read-only
  (open question 6); editable query results; table designer (identity, serial recognition,
  runtime type picker with arrays, `USING`, comments, options tab, `ADD VALUE` pre-step, one
  transaction); DDL editor templates (`$$`, `DROP TRIGGER … ON`); sequences (current value,
  `setval`); matview refresh; truncate with restart identity/cascade; extensions list;
  `NewDatabaseDialog` PG options; object list columns; `InfoPanel` details.
- **Done when.** The user can insert into a table with a serial/identity column leaving it empty,
  edit and delete rows with a PK, edit enum/JSON/array cells without losing their text form,
  create and alter a table in one transaction (including adding an enum value used as a
  default), set a sequence value, refresh a materialized view, and truncate with restart
  identity. PG's preview flag is switched off.

### P3. SQLite (parallel with P2b once P2a's tab-session layer exists)

- **Scope.** `node:sqlite` core, utility-process worker (cap 4), RPC client with fake spawner;
  open-never-creates and path checks; "Nuevo archivo SQLite…" (`app:pickSaveFile`); read-only
  rules (production, unwritable file) and "Reabrir en modo escritura"; `foreignKeys` option;
  tree from `PRAGMA database_list` with `indexes` group; rowid identity for every rowid table;
  storage classes; logical tab sessions with "Hay una transacción abierta en otra pestaña";
  cancel message and re-applied attachments/`initialQueries`; dialect with the PRAGMA whitelist
  and `WITH … DELETE` rule; designer with the extended rebuild; `VACUUM INTO` copy option; menu
  actions (integrity check, VACUUM, Mostrar en Finder); **SQLite plist/`.ncx` mapping**
  (foreign paths flagged); `engines.node >=24`; packaged smoke on three platforms (15.4).
- **Done when.** The user can open an existing `.db` or create a new one (a mistyped path or a
  Windows path from an `.ncx` never creates a file), browse tables, views, indexes and triggers,
  edit rows by rowid, run scripts with trigger bodies, cancel a runaway CTE in under a second
  with a clear message, and alter a table that needs a rebuild with **data intact, the
  AUTOINCREMENT high-water mark kept, dependent views recreated, and pre-existing FK violations
  reported but not blocking**. The packaged smoke passes on macOS, Windows and Linux. SQLite's
  preview flag is switched off.

#### P3 as implemented (2026-10-07)

What shipped, and where it differs from the text above (each point is deliberate):

- **Worker and cancel.** `src/main/sqlite/`: `core.ts` (pure node:sqlite), `worker.ts` (utilityProcess
  entry, electron-vite input `sqliteWorker`), `client.ts` (RPC; `kill()` rejects pending calls with the
  cancel message), `connection.ts` (one worker and one handle per connection behind a lock). Cancel kills
  the process only when the execution is the one running now, and the file is reopened right away with
  the configured attachments, initial queries and query_only. Measured: 12–50 ms from cancel to result
  (in-process tests, a real child process in the integration suite, and the Electron utility process in
  the smoke run).
- **Opening never creates.** Besides the path checks, the file is opened through a `file:` URI with
  `mode=rw`/`ro` (SQLite refuses a missing file), attachments the same way, and **an authorizer denies
  `ATTACH` of a missing or relative path from SQL** (not in the original design). `VACUUM INTO` stays
  allowed: it is an explicit request for that copy. `node:sqlite` defaults `enableForeignKeyConstraints`
  to true, so the option is always passed explicitly.
- **Shared transaction (5.3.1).** As designed: the owning tab gets `transactionStatus: 'in'` and
  Confirmar/Deshacer; other tabs get `TabSessionState.transactionElsewhere` and «Transacción abierta en
  otra pestaña»; their writes, BEGIN/COMMIT/ROLLBACK, grid saves, designer changes, maintenance writes and
  backups are refused while it lasts. A run without a tab never leaves a transaction open.
- **Guard.** Main's denylist blocks a PRAGMA that assigns, or that takes `(…)` and is not on the read list
  (the text above said any `(`, which would have blocked `PRAGMA table_info(t)` that the renderer treats
  as a read and broken the `isObviousWrite ⇒ analyzeWrites` property). `ANALYZE` and unknown bare
  PRAGMAs are writes for the renderer only; on guarded connections `query_only` stops them anyway.
- **Editable results.** `StatementSync.columns()` gives table/column/database. A rowid table is edited by
  rowid, so a result is editable only when it includes the rowid (or the INTEGER PRIMARY KEY that is its
  alias); otherwise the reason says «añade rowid a la consulta». The renderer takes the key from the
  columns the driver marks (`decideEditability(…, { keyFromColumns: true })`) and still requires the FROM
  target to equal the reported table (views report their base table). The rowid column and generated
  columns are `QueryColumn.locked` (key only).
- **Storage classes.** Every result and page carries `storage`; edits send the loaded class back
  (`RowChange.storage`) so an integer stays an integer and a blob a blob; text is bound as text and SQLite
  applies the column affinity. Cells over 64 KB are not truncated (as for PostgreSQL in P2b).
- **Designer.** `components/designer/sqlite/planner.ts` decides in place vs rebuild and builds the new
  CREATE TABLE from the original column definitions (`shared/sqlite/createTable.ts`); the rebuild script
  is `shared/sqlite/rebuild.ts`, run by `sqlite:alterTable` with the dependents, sequence and FK baseline
  read by main. Recreated indexes, triggers and views of an attached database are qualified with its
  alias (stored SQL never names its database).
- **Read-only.** «Reabrir en modo escritura» is `sqlite:reopenWritable` (session only, typed confirmation
  on guarded connections).
- **Packaged smoke (15.4).** The smoke run (`VORTAQ_SMOKE=1`) includes the SQLite check (create a
  file, open it in the utility process, run a script, cancel a runaway CTE, read again). It passed on
  the packaged macOS arm64 app (cancel 62 ms) and on the packaged Linux x64 app under xvfb in a
  Debian 12 container (amd64 emulated, cancel 592 ms): `utilityProcess.fork` starts the worker from
  inside `app.asar`, so no `asarUnpack` is needed. The Windows build was produced and checked
  (worker in app.asar, no native modules) but not run.
- **Not done in P3:** the preview flag stayed on (removed for 2.0.0 on 2026-10-08); the Windows
  packaged smoke; drag-and-drop of files remains named for later (recent files and automation jobs for
  SQLite backups were done on 2026-10-08).
- `package.json` `engines.node` is `>=24` (tests use `columns()` and `setReturnArrays`).

### P4a. MongoDB: connect, browse, edit, read queries

- **Scope.** Driver with credentials in `auth`, timeouts, `retryWrites`, extra options denylist,
  SRV ⇒ TLS, member-role detection; tree with collections/views and stats columns; collection
  browser (filter/sort/projection with history, three modes, typed inline editors, dates
  UTC/local, ObjectId copy, "Cargar más"); document editing with the replace-safety rule,
  optimistic check, whole-array `$set`, dotted/`$` field refusal, insert/duplicate/delete,
  read-only reasons; read-only index panel; **basic query editor for reads** (`find`,
  `aggregate` without `$out`/`$merge`, `countDocuments`, `distinct`, read-only commands,
  pasted-snippet tolerance) with completion and `killOp` cancel; tab sessions (`use <db>`);
  **MongoDB plist/`.ncx` mapping** (DocumentDB/Cosmos `retryWrites=false`).
- **Done when.** The user can import or create a connection (standalone, replica set, SRV; SSH to
  a single host), browse databases and collections, filter, sort and project, page with "Cargar
  más", edit fields inline and whole documents **without changing BSON types or deleting unseen
  fields**, insert, duplicate and delete documents, see indexes, and run read queries and
  `db.stats()`-style commands with completion. Production confirmation applies to every write.

### P4b. MongoDB: write queries, aggregation builder, collection designer

- **Scope.** Write methods and `bulkWrite` in the editor (guarded); `mongo:aggregate` with the
  stage builder and per-stage preview; collection designer (index create/drop, `$jsonSchema`
  validator, options read-only); "Generar esquema"; insert templates from sampled fields;
  "Contar exacto", rename and empty collection actions.
- **Done when.** The user can run `db.orders.updateMany(...)` with confirmation on production,
  build a pipeline stage by stage with previews, manage indexes and the validator. MongoDB's
  preview flag is switched off.

#### P4 (P4a + P4b) as implemented (2026-10-07)

What shipped, and where it differs from the text above (each point is deliberate):

- **Driver** (`src/main/mongo/`, official `mongodb` 7.7 + `bson` 7, Apache-2.0). Credentials only in `auth`,
  timeouts from `network`, SRV ⇒ TLS, SSH forces `directConnection` (SRV and seed lists refused), TLS
  `servername` = the real host, zlib only, GSSAPI/AWS/OIDC refused. `hello` gives topology and member role
  (`ServerInfo.runtime.topology/memberRole/transactions`). **Deviation:** reads that return documents use
  `promoteValues: false` as well as `promoteLongs: false` (`RAW_BSON`, per operation, not on the client):
  with values promoted an integral Double would come back as `$numberInt`; command results (counts,
  matchedCount) stay plain numbers. A direct connection to a secondary is reported («Secundario (solo
  lectura)») but the read preference is not switched automatically.
- **Grammar and guard** (`src/shared/mongo/`). As designed (acorn call chains, arguments parsed in main by
  shell-bson-parser, never eval'd), with `db.getSiblingDB('x')` and dotted collection names added. **Deviations:**
  comments are allowed (`allowComments: true`, still no calls); `Date.now()` is refused (strict mode refuses
  calls); `.itcount()`/`.size()` count instead of being no-ops. The renderer's allowlist also treats an
  aggregate whose arguments are not plain literals as a write (it cannot prove `$out`/`$merge` absent); main's
  denylist reads decoded keys from the AST, and `mongo:execute` additionally decides from the **parsed**
  pipeline at any depth (`valueHasWriteStage`), so `{'\u0024out': …}` is guarded. The implication
  `isObviousWrite ⇒ analyzeWrites.writes` is tested over a corpus and 2,000 generated scripts. The whole script
  is parsed (every argument too) before anything runs.
- **Values.** Canonical EJSON both ways; `shellFormat.ts` round-trips every type through shell text (tested
  with the parser). **Deviations:** a subtype-3 UUID shows as `BinData(3, …)` (only subtype 4 as `UUID('…')`,
  which is what `UUID()` writes back); a regex with `/` comes back escaped (`a\/b`, same match); the deprecated
  `symbol` and `undefined` types show as a string and `undefined`, so a whole-document replace turns them into
  string/null. Documents over 256 KB are sent with their large fields replaced by `{$vortaqLarge}` (not
  whole); editing one refetches it by `_id` (`mongo:document`).
- **Edits.** As designed (typed cell editor, `$set`/`$unset` with the original of each path, whole-array `$set`,
  dotted/`$` keys refused inline, replace only `fetchedWhole`), plus: a replace also compares the stored
  document with the one loaded (`original`) before overwriting. On standalone servers a batch stops at the
  first failure and says which change failed and how many were applied (instead of per-row results).
- **Query tab** (`views/MongoQueryView.vue`, routed from the `query` tab kind). Reads and P4b writes, read-only
  commands, `use`/`show`, completion (collections, methods, `$` operators, sampled field paths), `killOp`
  cancel by `comment: vortaq:<executionId>`, per-tab database and, on replica sets, an explicit transaction
  (`mongo:beginTransaction` — **new channel** — with `db:commit`/`db:rollback`; commit is guarded). Results
  inside a transaction keep no «Cargar más» cursor. Documents of `find`/`findOne` and of aggregates limited to
  `$match/$sort/$limit/$skip/inclusion $project` are editable.
- **Not done in P4 (named for later):** the visual aggregation stage builder (`AggregateView.vue`,
  `mongo:aggregate` with stage previews) — aggregates run in the query tab; «Duplicar colección» (done
  2026-10-08: `mongo:duplicateCollection`, options + indexes + raw documents, views by pipeline); the Navicat
  folder (`conn.plist`) mapping of MongoDB rows (done 2026-10-08); automation (done 2026-10-08); the explain
  view; user/role screens. The preview flag stayed on until 2026-10-08 (removed for 2.0.0).
- **Tree and designer.** Groups `collections`, `views` **and `indexes`** (index nodes `<collection>.<index>`);
  stats columns from `$collStats`; menus Abrir, Diseñar, Nueva consulta, Contar exacto, Renombrar (in the
  designer's Opciones), Vaciar, Eliminar. The designer (`views/CollectionDesignerView.vue`) creates collections
  (capped, validator), manages indexes and the validator (with «Generar esquema» from sampled types) and shows
  the options; the documents view has a read-only index panel.
- **Backups.** `.vqb` (see the update in section 11 and `docs/vqb-format.md`, «MongoDB»): `ddl.sql` holds the
  canonical EJSON `create` command; no transactional DDL, so REPLACE drops the database after a safety copy.
- **AI.** `ai/mongoMetadata.ts`: no query method; structure only (names, index keys, `$jsonSchema` shape,
  sampled field types). No explain for MongoDB (it would run the user's pipeline).
- **Import.** `.ncx` (method, seeds from `<Member>`, `<Advance Database>`, mechanisms, read preference, retry
  options, DocumentDB/Cosmos `retryWrites=false`, Atlas/SRV TLS, passwords) and DBeaver (host/port/database or
  the URL options; a password in the URL is not imported).
- **Tests.** Unit: grammar/guard (corpus + generated), shellFormat round trip, URI, client options, document
  staging. Integration against `mongo:8.2` on 57017 (standalone, auth) and 57018 (single-node replica set
  without auth, `--port 57018` so the member address `127.0.0.1:57018` works from host and container):
  types through edits, optimistic conflicts, replace safety, «Cargar más», read commands, guard (including the
  escaped `$out`), killOp cancel and late cancel, indexes/validator/rename/empty, read-only reasons, sampling,
  log redaction, atomic batches and tab transactions on the replica set, `.vqb` round trip/replace/encryption,
  AI context without values. The smoke run has an optional MongoDB step.

### P5. MariaDB as its own engine

- **Scope.** `mariadb` engine entry in the picker; `dialects/mariadb.ts` (`/*M!`, `RETURNING`);
  sequences group via `db:objects` and `SHOW CREATE SEQUENCE`; `MariaSQL` CodeMirror dialect;
  ed25519/parsec auth plugins (open question 4) with the `@noble/*` ESM check in a packaged app;
  MariaDB plist/`.ncx` mapping (`MariaDB` section → `mariadb`).
- **Done when.** A MariaDB connection created from the picker or imported can be browsed, edited
  and designed, including sequences and an ed25519 user; backup and automation entries are absent
  for it; existing `mysql` connections to MariaDB servers are unchanged. MariaDB's preview flag
  is switched off.

#### P5 as implemented (2026-10-07)

What shipped, and where it differs from the text above (each point is deliberate; the user's brief for
P5 overrides the "backup and automation entries are absent" and "existing `mysql` connections are
unchanged" lines):

- **Engine.** `engines.ts`: `mariadb` is `available` and **not a preview**; its capabilities are MySQL's
  plus `sequences` and `returning: 'insert-delete'`, **including** `supportsBackupsNb3`,
  `supportsBackupsVqb` and `supportsAutomation`. Reason: a connection that was `mysql` before P5 (with
  `.nb3`/`.vqb` backups, jobs, saved queries) must keep everything when it becomes `mariadb`. `.vqb`
  manifests keep `engine.id: 'mysql'` with `flavor: 'mariadb'` (format unchanged), so a MariaDB backup
  restores into a MySQL-family connection as before. The registry serves `mariadb` with the mysql2
  driver; its connections carry `mariadbDialect`, which `db:execute` also uses to split.
- **Dialect** (`shared/dialects/mariadb.ts`). The MySQL functions are reused untouched. The splitter keeps
  a `/*M! … */` statement as code (the MySQL splitter runs over a copy where `/*M!` reads `/*!M`, same
  length, and statements are cut from the original text). Both guards read `/*M!` content, treat
  `NEXTVAL(`/`SETVAL(`/`NEXT VALUE FOR` as writes, and main's denylist also looks inside
  `SET STATEMENT … FOR <stmt>` and leading parentheses. `isObviousWrite ⇒ analyzeWrites` is tested over
  the MySQL golden corpus, MariaDB cases and generated variants. The renderer guard in `QueryView.vue`
  uses it for MariaDB connections.
- **Auth plugins** (`mysql/authPlugins.ts`, open question 4): `client_ed25519` (RFC 8032 signing with
  SHA-512 of the password bytes as the expanded key; unit-tested against `ed25519.sign` with a 32-byte
  password, where both definitions coincide) and `parsec` (empty first answer, salt packet `P` + factor +
  salt, PBKDF2-HMAC-SHA512 with `1024 << factor` rounds, factor capped at 8, then client scramble +
  signature of server‖client scramble). Offered to every MySQL-family pool (a MySQL server never asks for
  them). `@noble/curves`/`@noble/hashes` 2.4 (MIT, ESM-only) are inlined in the CommonJS main bundle
  (`externalizeDepsPlugin` exclude, like `plist`), so no `require(esm)` is involved in the packaged app.
  Verified against MariaDB 11.8 with throwaway users (integration suite creates and drops them; the test
  server gets `INSTALL SONAME 'auth_ed25519'`/`'auth_parsec'` when missing).
- **Keeping existing connections (migration).** `ConnectionsRepo.save` allows exactly one engine change:
  `mysql` → `mariadb` (and a `mariadb` record saved as `mysql`, by an importer or a stale form, stays
  `mariadb`); every other change is still refused. `promoteToMariaDb(id)` changes only `engine` and
  `updatedAt` (idempotent). Two triggers: at startup (`migration/mariadbEngine.ts`,
  interactive runs only) records imported from a MariaDB entry (`source.navicatType` `MariaDB`) are
  promoted; and `ConnectionManager.doOpen` promotes a `mysql` connection whose server reports MariaDB,
  closes the first pool and reopens it with the MariaDB dialect (never in a headless job, which must not
  rewrite `connections.json`). Credentials, backups folder, jobs and saved queries stay keyed by the same
  id. «Probar conexión» says when the chosen engine and the server differ.
- **Sequences.** `db:objects` type `sequence` (from `information_schema.SEQUENCES`, falling back to
  `TABLES` with `TABLE_TYPE='SEQUENCE'` on servers without it; aliases avoid the `MINVALUE`/`MAXVALUE`/
  `INCREMENT`/`CYCLE` keywords), `db:showCreate` (`SHOW CREATE SEQUENCE`) and `db:dropObject`
  (`DROP SEQUENCE`), all gated on the `sequences` capability. The tree's Secuencias group opens the DDL in
  a query tab; menus: Ver estado (a `SELECT` of the sequence), Fijar siguiente valor… (`SETVAL` in a
  query tab, so the guard applies), Nueva secuencia, DDL, Eliminar.
- **Types and designer.** `introspect.listColumns` reports a MariaDB `LONGTEXT` column whose only column
  check is `json_valid(\`col\`)`as`json`(type and data type), so the designer round-trips the alias.`components/designer/mariadb/planner.ts`: the MySQL planner plus `uuid`, `inet4`, `inet6`in the type
list, MariaDB storage engines, an empty initial collation (filled from the database), and`options.systemVersioning`: `CREATE … WITH SYSTEM VERSIONING`, `ADD`/`DROP SYSTEM VERSIONING`(drop is a
risk: history is deleted), and`SET @@SESSION.system_versioning_alter_history = KEEP`before any ALTER of
a versioned table (MariaDB refuses it otherwise).`RETURNING` is a write and needs no designer support.
- **Editor.** `vortaqMariaSQL` (CodeMirror `MariaSQL` + backslash escapes + sequence, versioning and type
  keywords and builtins) for highlighting and keyword completion.
- **Import.** `.ncx` `MARIADB`, DBeaver `mariadb` and the Navicat folder's `MariaDB` section create
  `mariadb` connections (the "MariaDB se importa como conexión MySQL" warning is gone).
- **AI.** MariaDB connections get a MariaDB note in the context, their sequences are named (without
  their internal columns) and the version shows as «MariaDB x.y.z».
- **Not done in P5** (all closed on 2026-10-08, see «MariaDB backups complete» below): sequences and
  system-versioned tables were left out of `.nb3` and `.vqb` backups, a REPLACE with a safety copy was
  refused on MariaDB when the database had such objects, completion did not list sequence names and the
  automation runner's splitter ignored `/*M!`.

#### MariaDB backups complete (2026-10-08)

- **`.vqb`** holds MariaDB sequences (object type `sequence`: `SHOW CREATE SEQUENCE` plus
  `next_not_cached_value`/`cycle_count`, restored first with `SETVAL(seq, v, 0, round)` when the restore
  includes data) and system-versioned tables **with their history**: every row version
  (`FOR SYSTEM_TIME ALL`) with the period columns last and `meta.systemVersioning` (hidden
  `row_start`/`row_end` or the explicit `PERIOD FOR SYSTEM_TIME` columns, and the end value of the
  current rows). The restore inserts history with `system_versioning_insert_history` (MariaDB 10.11+); an
  older server gets the current rows and a warning. Transaction-precise versioning (BIGINT transaction
  ids) cannot be carried to another server: its current rows are stored, with a manifest warning.
  `docs/vqb-format.md` documents both fields (format version unchanged: 2.0.0 is the first release).
- **`.nb3`** keeps versioned tables as tables with their current rows and has no sequences: only tables
  have ever been observed in Navicat's files, so no other object type is written. The backup dialog and
  the job log say so for MariaDB databases (`describeNb3MariaDbLimits`) and point to `.vqb`.
- **`.sql`** writes sequences (`CREATE SEQUENCE` + `SELECT SETVAL(…)`, before the tables, whose defaults
  may call `NEXTVAL`) and versioned history (period columns in the INSERTs between
  `/*!101100 SET … system_versioning_insert_history=1 */` lines, as `mariadb-dump --dump-history` does).
- **REPLACE safety copies** (restore, rollback, `.sql` import): `replaceSafetyPlan` replaces the refusal.
  On a MariaDB database with sequences or versioned tables the safety copy is a `.vqb` even when the
  backup being restored (or Ajustes › Copias) is `.nb3`, so nothing is lost; the replace is refused only
  when a transaction-precise versioned table's history would be dropped. A MySQL server is never queried
  for it.
- A MariaDB `.vqb` that holds sequences or versioned tables is refused (before any safety copy or DROP)
  when the REPLACE target is a MySQL server (`mariaDbOnlyObjects`), since MySQL cannot create them;
  a `.sql` export with history warns that importing it needs MariaDB 10.11+ (older servers refuse
  INSERTs naming the period columns). Unverified: a history `.vqb` from MariaDB 11.5+ (current rows end
  in 2106) restored into 10.11–11.4 (whose maximum is 2038) under the restore's non-strict sql_mode.
- Completion lists sequence names on MariaDB connections; job steps on MariaDB (engine or server) split
  with the MariaDB splitter (`/*M!` as code), MySQL steps keep the line splitting.

#### PostgreSQL follow-ups (2026-10-07)

- **Close a database** (section 4.1): new channel `db:closeDatabase` → `closeDatabaseFromTree`: closes
  the database's pool and its idle query-tab sessions; refused for the initial database (connection-level
  reads use it) and while a tab of that database has an open transaction (it is never rolled back behind
  the user). The tree drops the database's caches and shows it closed again; the menu offers «Abrir base
  de datos» on a closed one.
- **Partitions nested** (section 3.1): `TableInfo.partitions` (recursive `pg_inherits`, partitions of
  other schemas included, `pg_get_expr(relpartbound)` as the bound) on partitioned tables; the tree nests
  them under their parent (sub-partitions too). A partition node is a regular table node of its own schema
  (same id as it would have in a flat list), so it opens, designs and has the table menus.
- **Navicat folder mapping** (section 12.1): `conn.plist` is read per section (`MySQL`, `MariaDB`,
  `PostgreSQL`) with `(section, name)` identity and section keys in the preview; the PostgreSQL mapping is
  the one listed in 12.1 (`initialdatabase`, `ssl_param.mode` any spelling, `rootcert`, integer
  `usecustomdblist`, first host of `hostportlist` with a warning, forks refused). Tested only with a
  synthetic multi-type file: the MariaDB/PostgreSQL keys are still unverified against real Navicat Premium
  files (open question 1). SQLite and MongoDB folder rows are read since 2026-10-08 (below).
- **Safety copies follow the chosen format.** Replacing a database from a `.sql` dump (and dump folders)
  takes its `previo-importacion` copy in Ajustes › Copias' format (`.vqb` by default, `.nb3` when chosen; a
  `.sql` default means `.vqb`, since «Deshacer» cannot restore a `.sql`). Restore/rollback copies keep the
  format of the backup being restored (unchanged), and PostgreSQL/MongoDB only have `.vqb`.
- **Fix:** a failed sign-in (pg refusing an empty password client-side) used to leave the socket open, so
  the server backend waited in authentication until `authentication_timeout` (60 s) and, among other
  things, made `DROP DATABASE` wait. `connectOrClose` ends the client on any connect failure.

#### Navicat folder: SQLite and MongoDB rows (2026-10-08)

`conn.plist` sections `SQLite` and `MongoDB` are mapped as listed in 12.1 (`docs/navicat-storage.md`,
«Other sections (unverified)»), with the same `(section, name)` identity as `.ncx` imports
(`SQLite`, `MongoDB`), so an `.ncx` still merges its secrets into them. SQLite keeps the path as
written and flags it for review when it is not absolute here or the file is missing (the connection
cannot open until the user picks a file; the import never opens or creates it), refuses encrypted
files and does not import attached databases (warning). MongoDB reads method, SRV, members (strings or
dicts), replica set, auth source and mechanism (Kerberos/AWS/OIDC refused), read preference, retry
options and providers. Rows whose engine is known but unusable (encrypted file, Kerberos) are now
refused by `navicatBlockReason` too. Tested with synthetic files only; never a credential store.

#### Version 2.0.0: every engine is regular (2026-10-08)

- `EngineCapabilities.preview` and `AppSettings.previewEngines` are gone; `pickableEngines()` lists every
  engine with a driver. The toolbar's Conexión menu has one «Nueva conexión X…» per engine (MySQL,
  MariaDB, PostgreSQL, SQLite, MongoDB; the two MySQL toolbar snapshots were edited by hand for exactly
  these three entries), the connection dialog always shows the engine picker without «vista previa»
  labels, Ajustes has no «Motores» section, and the importers (wizard, Navicat folder) no longer block
  rows by engine. A stored `previewEngines` is ignored by `SettingsRepo.get()` and removed on the next
  write (also when a stale renderer sends it).
- Tour, «Novedades» of 2.0.0, README and CLAUDE.md say so.
- **Audit of what was behind the flag** (nothing hidden is half-wired; these are named gaps, visible in
  the UI as absent features rather than broken ones): PostgreSQL has no users/roles screen
  (`hasUsers: false`; `db:users` answers that it is not available), no "Ejecutar función…" runner, and
  RLS policies/rules are not shown; SQLite has no drag-and-drop of `.db` files and its Windows packaged
  smoke was never run (recent files: «Recientes» in the connection dialog, localStorage
  `electrondb.sqlite.recentFiles`, paths only); MongoDB has no visual aggregation stage builder (aggregates run in the query
  tab), no explain view and no users/roles screens; job query steps are MySQL/MariaDB only.

#### AI assistant scope and per-engine AI capability (2026-10-07)

- `EngineCapabilities.ai` (new, non-boolean): `reader` (`information_schema` | `pg_catalog` |
  `sqlite_schema` | `mongo_sample`), `explain` (`explain` | `explain-query-plan` | false), `scope`
  (`databases` | `schemas` | `attached`) and `language` (`sql` | `mongo-shell`). The renderer words the
  scope menu from it; main keeps choosing the reader with the engine checks it already had.
- Ported from the stable line: `AiScope = 'database' | 'connection'` on `AiTarget`, the panel's
  «Solo <bd>» / «Toda la conexión» menu (localStorage `electrondb.ai.scope`), whole-connection contexts with
  `namespace.table` names, qualified cross-namespace FKs, per-namespace notes, prioritisation (open table,
  mentioned tables, FK neighbours, selected namespace, rest), at most 40 namespaces with structure and the
  rest by name; «Solo <bd>» lists the others by name for `get_table_structure`. Per engine: MySQL/MariaDB
  and MongoDB databases (system ones excluded: `mysql`, `sys`, `information_schema`, `performance_schema`;
  `admin`, `local`, `config`), PostgreSQL the schemas of the current database (the panel and the context
  header say «todos los esquemas de la base de datos X; PostgreSQL no consulta las demás bases de datos»),
  SQLite main and its attachments (not `temp`). MongoDB shares a 120-collection sampling budget across
  databases. «Ver contexto enviado» now also sends the PostgreSQL database and the scope.

#### Version 2.0.0 and the update feed (2026-10-07)

- `package.json` is **2.0.0** (ElectronDB ended at 0.1.9; no 0.2.0 is released). The update check and
  electron-builder's `publish` use `Y0rshB3/Vortaq` (`UPDATE_REPO`); `isAllowedReleaseUrl` accepts
  release pages and downloads of `Y0rshB3/Vortaq` and of the earlier name `Y0rshB3/ElectronDB`
  (`LEGACY_UPDATE_REPOS`).
- **appId is unchanged** (`dev.y0rshb3.electrondb`, pinned by `scripts/release-lib.test.ts`). electron-builder
  derives the NSIS GUID from it when `nsis.guid` is not set (it is not), so the 2.0.0 installer has the same
  GUID as 0.1.9 and upgrades that installation in place (same uninstall key and install folder); on macOS it
  is the same bundle id.
- **Release risk (not code):** ElectronDB 0.1.9 accepts only `/Y0rshB3/ElectronDB/releases/` URLs. If the
  repository is renamed before 2.0.0 is published, GitHub's API answers the old URL with the new
  `html_url` (`/Y0rshB3/Vortaq/…`) and 0.1.9 would not offer the update. Publishing 2.0.0 while the
  repository still has the ElectronDB name (then renaming it), or a 0.1.x bridge release that accepts the
  new name, avoids that. Until the rename `Y0rshB3/Vortaq` does not exist: 2.0.x asks
  `Y0rshB3/ElectronDB` when the Vortaq API answers 404 (`LATEST_RELEASE_URLS`), and electron-updater
  downloads from the repository name the checked release was found under (`releaseRepo`).

---

## 17. Cross-cutting risks

| Risk                                                                                                     | Impact                   | Mitigation                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MySQL regression during P1a                                                                              | High                     | Verbatim moves, golden tests for both guard functions, required integration suites on 5.7 and 8.4, PR series                                                    |
| A green gate that tested nothing                                                                         | High                     | `test:integration:required` fails on a missing URL; no CI yet (open question 9)                                                                                 |
| Guard bypass from wrong lexing or a too-broad read rule                                                  | High (production writes) | Allowlist in the renderer, denylist in main, implication test between them, PRAGMA and function lists, read-only sessions on production PG/SQLite, corpus tests |
| Ambient credentials or implicit file creation                                                            | High                     | Invariants 7 and 8, with unit tests that set `PGPASSWORD`/`PGPASSFILE` and open missing or foreign paths                                                        |
| Value corruption on edit (dates shifted, Int64 rounded, Int32 → Double, jsonb reordered, fields lost)    | High                     | Value-fidelity contract (2.2), pinned PG settings, typed Mongo editors, replace-safety rule, conformance fidelity matrix                                        |
| Editing the wrong rows or database (SQLite view reports its base table; PG self-joins; string SchemaRef) | High                     | Parsed-target equality, alias-less rule, `RowIdentity.none`, string `SchemaRef` rejected for PG, database in tab ids                                            |
| Lost user transactions                                                                                   | High                     | Tab sessions (D12); dirty-destroy only for pooled sessions; no `BEGIN READ ONLY … COMMIT` wrapper                                                               |
| Scope creep in the MongoDB UI                                                                            | Medium                   | P4a/P4b split; aggregation preview and schema generator in P4b                                                                                                  |
| Unverified Navicat encodings                                                                             | Medium                   | Tolerant parsing, warnings, anonymised samples requested now (open question 1)                                                                                  |
| Packaged-app differences (asar, Windows, Linux, ESM-only deps)                                           | Medium                   | Packaged smoke on three platforms (15.4), `asarUnpack` fallback, inline bundling fallback                                                                       |
| Electron upgrades changing `node:sqlite`                                                                 | Medium                   | P3 tests plus the packaged smoke on every Electron bump                                                                                                         |
| Releasing half-finished engines as Latest                                                                | Medium                   | Preview flag, prerelease-only builds, `release/0.1.x` for hotfixes (D14)                                                                                        |

---

## 18. Open questions for the user

1. **Navicat samples, needed now (before P2a's import is finished).** Can you provide anonymised
   dummy connections of each type (PostgreSQL with verify-full, SQLite with an attachment,
   MongoDB replica set and SRV with each auth mechanism, MariaDB) as `conn.plist` excerpts and
   `.ncx`, or approve installing a Navicat Premium trial to create them? Several PG and MongoDB
   encodings are Low confidence.
2. **v0.1.x maintenance.** OK to create `release/0.1.x` from `v0.1.0`? Should x64 macOS,
   Windows and Linux artifacts be built from `v0.1.0` and attached to the release?
3. Does an `.ncx` exported from your Mac with "Export Password" ticked include the passwords?
   One manual export answers it and lets PN be accepted with real data.
4. **Resolved (P5).** MariaDB `ed25519`/`parsec` users: the mysql2 auth plugins ship with
   `@noble/curves` (inlined in the main bundle).
5. **Resolved (v2.0.0).** The Navicat Keychain recovery was removed; `.ncx` is the password
   route.
6. PostgreSQL tables without a primary key: read-only with a warning (proposed for v1), or
   editing via `ctid` with a refresh after each save?
7. MongoDB over SSH: is single host with `directConnection` acceptable for v1, with the
   SOCKS5-over-SSH bridge for replica sets and Atlas SRV later?
8. Is it acceptable to mark as unsupported: MongoDB Kerberos, AWS IAM and OIDC; encrypted SQLite
   files; and Redshift, GaussDB/openGauss and KingbaseES connections?
9. **CI and test machines.** Add GitHub Actions (`npm run check` plus integration with service
   containers), or keep the local required gate? Is a Windows machine or VM available for the
   packaged smoke?
10. A `mysql` connection on a MariaDB server: keep backups with a pre-backup warning about
    skipped system-versioned tables and sequences (proposed), or refuse such backups?
11. MySQL query tabs: keep today's per-run sessions in v1 (proposed), or plan opt-in MySQL tab
    sessions (with `KILL QUERY` cancel) right after P4b?
12. SQLite foreign keys: off for opened/imported files and on for files created here
    (proposed)?
13. PostgreSQL and MongoDB user/role screens: confirm they are out of v1, or should a read-only
    roles list be included in P2b?
14. App Store (sandboxed) Navicat builds: should the importer also look under
    `~/Library/Containers/<bundle>/Data/...`? Unverified; a folder picker covers it meanwhile.

---

## 19. Sources

- **The project's own code**, read for the coupling map (every MySQL assumption in `src/`, cited
  as "coupling §n") and the driver feasibility checks (Electron 44.3.0 / Node 24.20.0 / SQLite
  3.53.4 against `postgres:17`, `mariadb:11` and `mongo:8.2` containers, cited as "drivers §n").
  The working notes behind both are kept outside the repository; the `pg-introspect.sql` catalog
  queries go into `src/main/postgres/catalog.ts` in P2a.
- **The user's own Navicat files**: `conn.plist`, `pref.plist`, batch jobs and `.nb3` backups the
  user created with their own Navicat for MySQL installation, documented in
  `docs/navicat-storage.md` (key names and layout only; the test fixtures are synthetic).
- **`.ncx` files exported with Navicat's own export** (Export Password), for the `.ncx` attributes,
  versions and `ConnType` values (open question 3).
- **Public documentation**: the Navicat manuals for macOS, Windows and Linux; the node:sqlite docs
  (https://nodejs.org/docs/latest-v24.x/api/sqlite.html); the documentation of each driver
  (`pg`, `mongodb`, `mysql2`).

Reviews answered by revision 2 (session notes, not in the repo; every point is listed in
section 20): an adversarial review of regressions, guard bypasses, security and packaging, with
a SQLite 3.53.4 reproduction of the `PRAGMA query_only(0)` bypass, the view-breaks-rebuild
failure and the create-on-open behaviour; and a daily-use review for PostgreSQL, SQLite and
MongoDB.

Repo files read for this design: `CLAUDE.md`, `docs/navicat-storage.md`, `package.json`,
`electron-builder.yml`, `electron.vite.config.ts`, `vitest.config.ts`, `src/shared/types.ts`,
`src/shared/ipc.ts`, `src/shared/productionGuard.ts`, `src/main/mysql/{types,manager}.ts`,
`src/main/credentials/store.ts`, `src/main/ipc/productionGuard.ts`, `src/main/ipc/errorLog.ts`,
`src/main/ipc/navicat.ts`, `src/main/backup/create.ts`, `src/main/env.ts`,
`src/renderer/src/stores/tree.ts`, `src/renderer/src/components/query/writeGuard.ts`,
`src/renderer/src/components/common/ResultGrid.vue`, `tests/integration/mysql.test.ts`.

---

## 20. Decisions on the review findings

Every finding of both reviews, accepted or rejected, with a one-line reason. "Where" points to
the section of this document that carries the change.

### 20.1 Adversarial review (regressions, guard, security, packaging)

| ID  | Finding                                                                                     | Decision              | Reason                                                                                                 | Where          |
| --- | ------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ | -------------- |
| A1  | P0 is done; v0.1.0 has only arm64 mac assets; add prerelease policy and `release/0.1.x`     | Accept                | Verified read-only (tag and Latest release exist); the rest protects the user's stable baseline.       | 16 P0, D14, Q2 |
| B1  | One `classify()` drops dialog reasons and changes what main blocks                          | Accept                | Two functions per dialect keep today's MySQL behaviour exactly.                                        | D13, 6, 10     |
| B2  | MySQL gate can pass without running; no CI; tests pin 8.4 but production is 5.7             | Accept                | A gate that can skip is no gate; 5.7 is the server that matters most.                                  | 15.3, P1a, Q9  |
| B3  | The stats-expiry "latent failure" is already handled by try/catch                           | Accept                | Confirmed in `withFreshStats`; the backup edit is dropped.                                             | 11             |
| B4  | MariaDB backups silently skip system-versioned tables and sequences                         | Accept (warn)         | A warning fixes the silent loss without changing the `.nb3` format; refusing is open question 10.      | 5.6, P1b       |
| B5  | "One lexer for every consumer" contradicts verbatim MySQL extraction                        | Accept                | MySQL keeps its tokenisers; only new dialects share one lexer.                                         | D6, 6          |
| B6  | `KILL QUERY` / `pg_cancel_backend` can hit the next statement on a reused pooled session    | Accept                | Cancel binds to a registered running execution; MySQL cancel waits for MySQL tab sessions.             | 5.3.1, 5.5     |
| B7  | Engine immutability only in IPC; the importer writes through the repo                       | Accept                | The check moves into `ConnectionsRepo.save`.                                                           | 2              |
| B8  | "Zero behaviour change" conflicts with P1a's content; split P1a; feature flag               | Accept                | Backup edit dropped, guard kept verbatim, P1a split into five PRs, preview flag added.                 | P1a, D14       |
| C1  | Tab ids and tree caches have no database                                                    | Accept                | Same table in two PG databases would open the wrong tab.                                               | 4.1            |
| C2  | Saved queries have no database                                                              | Accept                | PG and Mongo queries would reopen in the wrong database.                                               | 4.1            |
| C3  | `ResultGrid.vue` `NUMERIC_TYPE` is MySQL-only                                               | Accept                | Use `typeKind`; regex stays as fallback.                                                               | 8.1            |
| C4  | `privileges.ts` matches MySQL errnos in text                                                | Accept                | Add a code-aware variant; MySQL path unchanged.                                                        | 8.1            |
| C5  | `deleteAll` misses the new `sslKey`; `.ncx` SSH password vs passphrase unclear              | Accept                | No orphaned secrets; passphrase wins for public-key auth.                                              | 13, 12.2       |
| C6  | Every import warning is logged, and the new ones contain foreign paths                      | Accept                | New preview/import warnings go to the renderer only; the log gets counts.                              | 7.1, 12.2      |
| C7  | String `SchemaRef` = initial database can drop/truncate in the wrong database               | Accept                | Main rejects string refs for PG.                                                                       | 4              |
| D1  | `pg` falls back to `PGPASSWORD`, `~/.pgpass`, `PGUSER`, `PGDATABASE`                        | Accept                | Password function form and explicit fields; invariant 7.                                               | 0, 5.6         |
| D2  | SQLite rebuild fails when a view references the table                                       | Accept                | Reproduced; dependants are dropped and recreated inside the transaction.                               | 8.1            |
| D3  | No `retryWrites`/timeouts/extra options; DocumentDB and Cosmos fail every write             | Accept                | Added to `MongoOptions`, import maps providers to `retryWrites=false`.                                 | 2, 5.6, 12.1   |
| D4  | Redshift and other PG forks imported as working PG; no `hostportlist`; no `allow`           | Accept                | Forks marked unsupported; first host with warning; `allow` supported.                                  | 0, 2, 12.1     |
| D5  | `@noble/*` are ESM-only and untested from the CJS bundle                                    | Accept                | Verify in a packaged app or inline them; moved with auth plugins to P5.                                | 5.6, 14        |
| D6  | `acorn` is only transitive via a devDependency; parser needed in P4a                        | Accept                | Both become direct dependencies in P4a.                                                                | 14             |
| D7  | SQLite cancel silently drops TEMP tables, PRAGMAs and ATTACHes                              | Accept                | The message says so; configured attachments and initial queries are re-applied.                        | 5.5            |
| E1  | `new DatabaseSync(path)` creates missing files, including Windows paths as literal names    | Accept                | Reproduced; invariant 8, absolute + exists checks, create only via "Nuevo archivo".                    | 0, 5.6         |
| E2  | `PRAGMA query_only(0)` passes as a read; no `WITH … DELETE` rule                            | Accept                | Reproduced; PRAGMA read whitelist, any argument is a write, DML-anywhere rule.                         | 10             |
| E3  | `BEGIN READ ONLY … COMMIT` commits the user's open transaction                              | Accept                | Replaced by session-level read-only characteristics lifted only for confirmed writes.                  | 10             |
| E4  | PG rule is a denylist despite "unknown = write"; side-effect functions pass                 | Accept                | Renderer allowlist plus a function denylist; main keeps a denylist by design.                          | 10             |
| E5  | Server text wrapped in the trusted error class would reach the log                          | Accept                | New `ServerError` shown but logged as name and code only.                                              | 5.7            |
| E6  | Mongo URI query parameters carry secrets; credentials in the client URI; `passwordOptional` | Accept                | Credential params refused, `auth` option used, password optional only without a user or for x509/none. | 3, 5.6, 13     |
| E7  | Linux `basic_text` backend may hide the plain-secrets notice                                | Accept (verify first) | Plausible, not confirmed; checked in PN before `.ncx` adds more secrets.                               | 13             |
| E8  | Read-only production SQLite makes confirmed writes impossible                               | Accept                | Explicit "Reabrir en modo escritura" with confirmation.                                                | 5.6, 10        |
| F1  | node:sqlite/utilityProcess verified only unpackaged on macOS                                | Accept                | Packaged smoke on three platforms; `asarUnpack` fallback.                                              | 14, 15.4       |
| F2  | Foreign paths change meaning across platforms                                               | Accept                | Stored with `pathNeedsReview` and never opened until the user picks a file.                            | 2, 12.2        |
| F3  | One utility process per SQLite connection costs tens of MB each                             | Accept (cap)          | Cap of 4 open SQLite connections; a shared worker is not worth the complexity in v1.                   | 5.6            |
| G1  | P5 acceptance cannot run locally (Navicat for MySQL only)                                   | Accept                | Acceptance rewritten on synthetic fixtures; real samples requested now.                                | PN, Q1         |
| G2  | MySQL `KILL QUERY` bundled into the PG phase                                                | Accept                | Removed from the PG phases (B6).                                                                       | 5.5            |
| G3  | "Each phase releasable" needs a flag or prerelease channel                                  | Accept                | Preview flag plus prerelease-only builds.                                                              | D14, 3         |

### 20.2 Daily-use review

| Ref | Finding                                                                         | Decision                            | Reason                                                                                                       | Where                      |
| --- | ------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------- |
| §0  | Query tabs need their own session (PG transactions, `SET`, temp tables)         | Accept (new engines)                | Daily PG work depends on it; MySQL stays per-run in v1 to keep invariant 1 (open question 11).               | D12, 5.3.1                 |
| §0  | SQLite tabs share one handle and transaction                                    | Accept                              | Refuse other tabs' writes while one owns a transaction.                                                      | 5.3.1                      |
| 1.1 | search_path must keep `public`; reset pooled sessions with `DISCARD ALL`        | Accept                              | Extensions live in `public`; introspection never relies on search_path.                                      | 5.2, 5.3, 5.3.1            |
| 1.1 | PG query toolbar needs database and schema combos; read back `current_schema()` | Accept                              | Users expect it, and it keeps the combo honest after `SET search_path`.                                      | 8.1                        |
| 1.1 | Saved queries and tree groups collide across databases                          | Accept                              | Same fix as C2.                                                                                              | 4.1                        |
| 1.1 | Hide `template0` and no-connect databases                                       | Accept                              | Expanding them fails.                                                                                        | 4.1                        |
| 1.1 | Databases closed until opened; pool cap must be actionable                      | Accept                              | Avoids silent pool exhaustion.                                                                               | 4.1, 5.3                   |
| 1.1 | Mixed-case / reserved identifiers in completion                                 | Accept                              | Tests added.                                                                                                 | 8.1, 15.1                  |
| 1.1 | Explain `0A000` cross-database error                                            | Accept                              | Cheap, actionable.                                                                                           | 5.6                        |
| 1.1 | Re-query privileges after `SET ROLE`                                            | Reject                              | `SET ROLE` is classified as a write (confirmed on production); re-querying privileges is not worth it in v1. | 10                         |
| 1.2 | Inserts into serial/identity columns send NULL and fail                         | Accept                              | Untouched default/identity cells are omitted; `RETURNING *` refresh.                                         | 5.4, 2.1                   |
| 1.2 | Sequence current value and `setval`                                             | Accept (P2b)                        | Daily need; a full sequence editor form can wait.                                                            | 4.1, P2b                   |
| 1.2 | Truncate "restart identity" / cascade                                           | Accept                              | `truncate` capability takes options.                                                                         | 3, 4.1                     |
| 1.2 | Recognise `serial`; never convert to identity silently                          | Accept                              | Old schemas use serial everywhere.                                                                           | 8.1                        |
| 1.3 | Enum labels in `ColumnInfo` for a dropdown                                      | Accept                              | `enumValues`, filled for MySQL by parsing too.                                                               | 2.1, 5.6                   |
| 1.3 | Types/Domains group                                                             | Accept                              | `types` group with enums, domains, composites.                                                               | 3.1                        |
| 1.3 | Runtime type picker with arrays                                                 | Accept                              | Static lists cannot know user types.                                                                         | 5.6, 8.1                   |
| 1.3 | `ALTER TYPE … ADD VALUE` cannot be used in the same transaction                 | Accept                              | Planner pre-step outside the transaction.                                                                    | 8.1                        |
| 1.3 | Arrays as text with mapped errors; typed binds                                  | Accept                              | v1 keeps text editing; `$n::type` binds everywhere.                                                          | 2.2, 5.6                   |
| 1.3 | jsonb normalisation; JSON editor                                                | Accept                              | Row replaced by `RETURNING *`; pop-up editor.                                                                | 2.2, 8.1                   |
| 1.3 | Pin DateStyle, IntervalStyle, extra_float_digits, TimeZone; application_name    | Accept                              | Round-trip fidelity depends on them.                                                                         | 2.2                        |
| 1.3 | Large text/bytea lazily loaded                                                  | Accept (new engines)                | No blob viewer exists today; a new value viewer, MySQL unchanged.                                            | 2.2                        |
| 1.3 | Domains resolve to base `typeKind`                                              | Accept                              | Correct editors for domain columns.                                                                          | 5.6                        |
| 1.4 | Extensions list and "Crear extensión…"                                          | Accept (list only)                  | Read-only list in P2a/P2b; creating one is a query-editor statement in v1.                                   | 3.1, 4.1                   |
| 1.4 | Materialized view refresh                                                       | Accept                              | Daily action, already classified as a write.                                                                 | 4.1                        |
| 1.4 | Mark trigger functions and procedures; "Ejecutar función…"                      | Accept / defer runner               | Marking is cheap; the runner is named for later.                                                             | 5.6, 0                     |
| 1.4 | PG object list columns                                                          | Accept                              | Rows estimate, size, owner, comment.                                                                         | 5.6                        |
| 1.4 | Designer "Opciones" tab                                                         | Accept (partly read-only)           | Comment and UNLOGGED editable; owner, tablespace, partition key read-only.                                   | 8.1                        |
| 1.4 | Rules, RLS policies, foreign tables                                             | Accept (foreign tables only)        | Foreign tables listed with a badge; rules and RLS policies are named for later (read-only DDL).              | 3.1                        |
| 1.4 | Visual EXPLAIN; LISTEN/NOTIFY; `\copy`                                          | Defer                               | Named for later.                                                                                             | 0                          |
| 2   | Rebuild resets AUTOINCREMENT                                                    | Accept                              | `sqlite_sequence` row restored; test added.                                                                  | 8.1, 15.3                  |
| 2   | `foreign_key_check` aborts on pre-existing violations                           | Accept                              | Baseline before the rebuild; only new rows abort.                                                            | 8.1                        |
| 2   | Forcing foreign keys on changes other apps' files                               | Accept                              | `foreignKeys` option, off for opened/imported files (open question 12).                                      | 2, 5.6                     |
| 2   | Always edit rowid tables by rowid                                               | Accept                              | Rowid-table PKs allow NULLs and affinity duplicates.                                                         | 5.2, 5.6                   |
| 2   | Keep each cell's storage class                                                  | Accept                              | SQLite is dynamically typed.                                                                                 | 2.1, 2.2                   |
| 2   | Tree from `PRAGMA database_list`                                                | Accept                              | Editor-run ATTACH must be visible.                                                                           | 5.6                        |
| 2   | Cancel drops temp objects and session attachments                               | Accept                              | Same as D7.                                                                                                  | 5.5                        |
| 2   | Second read-only process for introspection                                      | Reject (for v1)                     | It doubles the per-connection process cost that F3 caps; "ocupado" is acceptable for v1, named for later.    | 0, 5.6                     |
| 2   | WAL files: read-only folders and the copy option                                | Accept                              | Mapped error; `VACUUM INTO` for the copy.                                                                    | 5.6, 8.1                   |
| 2   | Indexes group                                                                   | Accept                              | Indexes are browsed daily, and it gives a quick DROP INDEX.                                                  | 3.1                        |
| 2   | Separate AUTOINCREMENT checkbox; generated columns read-only                    | Accept                              | Different semantics from MySQL.                                                                              | 5.6, 8.1                   |
| 2   | Recent files and drag-and-drop                                                  | Defer                               | Convenience; not needed for daily use.                                                                       | —                          |
| 2   | Whitelist read pragmas                                                          | Accept                              | Same as E2.                                                                                                  | 10                         |
| 3.1 | Dates: explicit UTC/local; out-of-range dates                                   | Accept                              | Users compare with logs in both zones.                                                                       | 9.1                        |
| 3.1 | ObjectId copy as hex / as filter                                                | Accept                              | Cheap and used daily.                                                                                        | 9.1                        |
| 3.1 | Inline edits change number types                                                | Accept                              | Typed editor with a type dropdown; conformance test.                                                         | 9.1, 15.3                  |
| 3.1 | Mixed-type badge; UUID rendering                                                | Accept                              | Small additions to `shellFormat` and the grid.                                                               | 9.1                        |
| 3.2 | Replace after projection/truncation deletes fields                              | Accept                              | Replace only whole documents; refetch or diff otherwise.                                                     | 5.4, 9.2                   |
| 3.2 | `$unset` on an array element leaves `null`                                      | Accept                              | Whole-array `$set`.                                                                                          | 9.2                        |
| 3.2 | Field names with `.` or leading `$`                                             | Accept (refuse inline)              | v1 refuses inline edits with "Edita el documento completo"; `$setField` later.                               | 9.2                        |
| 3.2 | Optimistic check on edits                                                       | Accept                              | Matches the SQL grid's semantics.                                                                            | 7.2, 9.2                   |
| 3.2 | Capped, time-series and view collections read-only reasons                      | Accept                              | Avoids confusing server errors.                                                                              | 5.4, 9.1                   |
| 3.2 | Insert templates; duplicate document                                            | Accept                              | Duplicate in P4a, templates in P4b.                                                                          | 9.2, P4b                   |
| 3.3 | Pasted mongosh tolerance; verify parser coverage                                | Accept                              | Snippets come from docs and colleagues.                                                                      | 9.3                        |
| 3.3 | Read-only admin commands                                                        | Accept                              | Fixed whitelist, classified as reads.                                                                        | 9.3, 10                    |
| 3.3 | "Load more" cursor                                                              | Accept                              | `mongo:getMore`; skip-based paging is unstable without a sort.                                               | 5.6, 9.1                   |
| 3.3 | Stage preview: `$limit` at the end; document count                              | Accept                              | Correct previews.                                                                                            | 9.4                        |
| 3.3 | Explain view; visual Find builder                                               | Defer                               | Named for later.                                                                                             | 0                          |
| 3.3 | Filter history                                                                  | Accept                              | Per viewer, local only.                                                                                      | 9.1                        |
| 3.4 | Read-only index list in P4a                                                     | Accept                              | Users need it before the designer.                                                                           | 9.1                        |
| 3.4 | GridFS: chunks read-only, grouping                                              | Accept (read-only) / defer grouping | Read-only prevents corruption; grouping is polish.                                                           | 3.1, 0                     |
| 3.4 | Collection list columns; hide `system.*`                                        | Accept                              | Data already fetched.                                                                                        | 3.1, 9.1                   |
| 4   | Connect timeouts and keepalive                                                  | Accept (new engines)                | MongoDB hangs 30 s otherwise; MySQL ignores `network` in v1.                                                 | 2, 5.6, 8.2                |
| 4   | PG SSL `allow`, `sslrootcert`/CRL, key password at P2                           | Accept                              | `allow` implemented; `sslKey` slot from P2a.                                                                 | 2, 5.6, 13                 |
| 4   | SRV implies TLS; DocumentDB `retryWrites=false`                                 | Accept                              | Same as D3.                                                                                                  | 5.6, 12.1                  |
| 4   | "Copiar URI"                                                                    | Accept                              | Without the password.                                                                                        | 8.2                        |
| 4   | Hidden secondary through a tunnel                                               | Accept                              | Member role reported; error mapped.                                                                          | 5.6                        |
| 4   | PG multi-host                                                                   | Accept (first host + warning)       | pg supports one host; failover is out of scope.                                                              | 0, 12.1                    |
| 4   | "Probar conexión" shows TLS, SSH and topology                                   | Accept                              | Common support question.                                                                                     | 8.2                        |
| 4   | SQLite read-only when the file isn't writable; "Archivo no encontrado"          | Accept                              | Same as E1/F2.                                                                                               | 5.6, 8.2                   |
| 4   | Connect-time password prompt on every engine                                    | Accept                              | `savePassword: false` must keep working.                                                                     | 8.2                        |
| 5   | Tab identity and titles include the database                                    | Accept                              | Same as C1.                                                                                                  | 4.1                        |
| 5   | Tree filter across levels                                                       | Accept                              | Extends today's label filter (`tree.ts:298`).                                                                | 4.1                        |
| 5   | Remember last schema per database                                               | Accept                              | Per viewer; saves a click per connect.                                                                       | 4.1                        |
| 5   | Group counts; partitions excluded from the flat list                            | Accept partitions / defer counts    | Partitions nested; counts are polish.                                                                        | 3.1                        |
| 5   | Per-engine context menus listed                                                 | Accept                              | Table in 4.1.                                                                                                | 4.1                        |
| 5   | "Copy as" INSERT/JSON per engine                                                | Defer                               | No such feature exists for MySQL today; named for later with data export.                                    | 0                          |
| 6.1 | P0 is done                                                                      | Accept                              | Same as A1.                                                                                                  | 16 P0                      |
| 6.2 | Per-tab sessions in P1a or start of P2                                          | Accept (start of P2a)               | Generic layer in P2a, before any engine needs it; MySQL untouched in P1a.                                    | P2a                        |
| 6.3 | Demote MariaDB: fixes in P1b, engine after P3/P4a                               | Accept                              | Daily engines are PG, SQLite and MongoDB; the engine moves to P5.                                            | P1b, P5                    |
| 6.4 | Split P2 into read (P2a) and edit (P2b)                                         | Accept                              | PG becomes useful sooner.                                                                                    | P2a, P2b                   |
| 6.5 | SQLite in parallel with P2b; rebuild fixes in "done when"                       | Accept                              | Cheapest second dialect; data-loss items are acceptance criteria.                                            | P3                         |
| 6.6 | MongoDB: basic query editor and load-more in P4a; designer in P4b               | Accept                              | Users query more than they edit validators.                                                                  | P4a, P4b                   |
| 6.7 | Import per engine phase; `.ncx` early; samples now                              | Accept                              | PN after P1a; mappings ship with each engine; samples are open question 1.                                   | 12, PN, Q1                 |
| 6.8 | Name the later features                                                         | Accept                              | Listed in section 0.                                                                                         | 0                          |
| 7   | Text corrections to 3.1, 5.4, 5.5, 8.2, 10, 15                                  | Accept                              | Applied in those sections.                                                                                   | 3.1, 5.4, 5.5, 8.2, 10, 15 |
| 7   | Keep the production `BEGIN READ ONLY` wrapper (§7, §10 bullet)                  | Reject                              | Its `COMMIT` would commit the user's open transaction (E3); session-level read-only replaces it.             | 10                         |

### 20.3 MySQL-visible changes in this plan

Invariant 1 allows only these, each additive and named in release notes:

- P1a: tree node ids are escaped, so names containing `:` work; persisted tree expansion resets
  once.
- P1a: `deleteAll` also removes `sslKey` secrets (none exist for MySQL yet).
- P1b: on **MariaDB servers only**, system-versioned tables are listed, defaults are unquoted,
  users come from `global_priv`, the count timeout works, and backups warn about skipped
  objects.
- PN: Navicat import gains `.ncx`, per-type preview rows and `(type, name)` identity; existing
  MySQL imports without `navicatType` keep matching as `MySQL`.
- P1a: `SettingsDialog` shows the "Motores en vista previa" switch (off by default, so nothing
  else changes). From the first engine phase, the "Nueva conexión" entry becomes an engine
  picker when previews are on, and always once an engine leaves preview.
- P5: MariaDB leaves preview, so the toolbar's Conexión menu gains «Nueva conexión MariaDB…» and the
  connection dialog always shows the MySQL/MariaDB picker (the two MySQL toolbar snapshots were edited by hand for this entry only). A `mysql` connection whose server is MariaDB becomes a `mariadb` connection when it
  opens; MySQL-family pools offer the ed25519/parsec plugins (a MySQL server never asks for them).
- Safety copies of a `.sql` import that replaces a database follow Ajustes › Copias (`.vqb` by default
  instead of always `.nb3`).
- The AI assistant without a selected database (or with «Toda la conexión») sends the structure of every
  user database instead of only their names; the update feed is `Y0rshB3/Vortaq`.
- 2.0.0: the «Motores en vista previa» switch is removed and every engine is offered, so the toolbar's
  Conexión menu gains «Nueva conexión PostgreSQL/SQLite/MongoDB…» (snapshots edited by hand for these
  entries) and Ajustes loses its «Motores» section. MySQL-family job query steps on MariaDB servers split
  with the MariaDB splitter (MySQL servers keep the line splitting).
