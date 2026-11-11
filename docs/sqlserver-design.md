# SQL Server engine (`sqlserver`, desktop 2.6.0, extension 0.5.0)

SQL Server 2012+, Azure SQL Database and Azure SQL Managed Instance as a regular engine, in the desktop app
and the editor extension. Requested on 2026-11-09 with «uso diario primero»: connect (also through SSH), tree,
SQL editor with completion, data and editable results, export, designer, diagram, visual query, AI assistant
and MCP. `.vqb` copies and scheduled jobs are a later phase (`supportsBackupsVqb: false`,
`supportsAutomation: false`).

## Driver

- `tedious` 20.3.8, pure JavaScript, pinned exactly (20.3.7 fixed a downgrade to an unencrypted login, and
  `values.ts` depends on its internals). It pulls `@azure/identity`/`@azure/msal-node` (also pinned as direct
  dependencies); no native module.
- `src/main/sqlserver/`: `client.ts` (every tedious option explicit), `connection.ts` (a pool per database,
  4 sessions each, at most 8 databases, 10 min idle; query-tab sessions; executions by id), `session.ts`
  (one request at a time per connection: tedious has no MARS; batches as ordered outputs; streams for
  exports), `query.ts`, `introspect.ts` (only `sys.*` catalog views of the session's database),
  `tableData.ts`, `tableFilter.ts`, `rowChanges.ts`, `values.ts`, `errors.ts`, `entra.ts`,
  `browserOpener.ts`, `driver.ts`. The db:* handlers are `src/main/ipc/dbSqlServer.ts`; `ipc/db.ts` routes by
  engine and refuses `db:extensions`, `db:charsets`, `db:users` and `db:events`.
- Sessions log in to their database (pool key). Azure SQL Database cannot `USE` another database, so a tab
  that changes database gets a new session (refused while its transaction is open), like PostgreSQL.
- Session options are SSMS's (ANSI_NULLS, QUOTED_IDENTIFIER, ARITHABORT… ON), `requestTimeout: 0` (user
  statements run until they end or are cancelled), one connection attempt, `appName` Vortaq.
- A pooled session that ran user SQL is rolled back (`IF @@TRANCOUNT > 0 ROLLBACK`) and reset
  (`sp_reset_connection`) before going back to its pool; if that fails it is closed.
- Cancel: a TDS attention on the session's own connection (`cancel: 'attention'`); no second connection.
- Never call `connection.close()` from a tedious `row` handler: tedious 20.3.8 throws an uncaught error.

## Values (`values.ts`)

tedious turns DECIMAL/NUMERIC/MONEY into JS numbers and every date/time type into a JS `Date`. The exported
`readValue` of `tedious/lib/value-parser` (which the row parsers call through the module object) is wrapped
once per process so these types are read from the TDS bytes as text:

| Type                        | Text                                               |
| --------------------------- | -------------------------------------------------- |
| decimal/numeric             | every digit, exactly `scale` decimals (`12.50`)    |
| money/smallmoney            | 4 decimals (`1.5000`)                              |
| date, time(n), datetime2(n) | `YYYY-MM-DD`, `hh:mm:ss[.fffffff]` with n digits   |
| datetimeoffset(n)           | local wall time plus its own offset (`… -05:00`)   |
| datetime, smalldatetime     | milliseconds as SQL Server rounds 1/300 s; minutes |

The wrapper is reached with a literal `require()` so the desktop build (tedious external), the extension's
esbuild bundle and Vitest all patch the very instance tedious uses; `values.test.ts`, the integration suites
and the extension's VS Code suite check it. bigint stays text, bit is boolean, binary is `0xHEX`.

Grid writes bind `@p` parameters cast to the column's declared type; datetime and smalldatetime values are
rewritten to the ISO forms every session language reads (`yyyymmdd`, `yyyy-mm-ddThh:mm:ss`).

## Scripts (`dialects/sqlserver.ts`, `query.ts`)

- The splitter returns **batches** split at `GO` lines (`GO n` repeats, capped at 1000), never inside strings
  or comments (block comments nest). A batch is sent whole: variables and table variables live for one batch
  and `;` is optional, so cutting at semicolons would change what a script does.
- Every server reply becomes one result in order: result set, row count, error (the batch usually goes on, as
  in SSMS) or PRINT/RAISERROR messages attached as notices. The error position is the start of the line the
  server names.
- A batch that is a single query (`isSingleQuery`) stops at the row cap with an attention, and is described
  with `sp_describe_first_result_set @browse_information_mode = 1` (source database/schema/table/column and
  key per result column). `resultEditability.ts` parses it with `selectSourceMs.ts` (TOP, `[x]`, table
  hints, OPTION; temp tables, table variables, APPLY and three-part names stay read-only) and ties columns by
  their place in the select list (no alias metadata), like PostgreSQL.
- `statementsOfBatch` segments a batch only for analysis (destructive warnings, export checks).

## Production guard

SQL Server has no read-only session mode. Main's denylist and the renderer's allowlist run the same token
scan, so they agree: data changes and DDL, `EXEC` of anything but the read-only system procedures (`sp_help`,
`sp_columns`, `sp_who`…), dynamic SQL, `SELECT … INTO`, `OUTPUT … INTO` a table, `NEXT VALUE FOR`,
`OPENROWSET`/`OPENQUERY`/`OPENDATASOURCE`, `DBCC` (but its report commands), `BACKUP`/`RESTORE`, `KILL`,
`ENABLE/DISABLE TRIGGER` and Service Broker sends are writes. DML on table variables (`@t`) is not. A batch
that starts with a procedure name is an implicit `EXEC`.

«Exportar resultado completo» and MCP `run_query` re-run one statement that passes `checkExportStatement`
(one statement even without `;`, no `@` variables) in a new session inside `BEGIN TRANSACTION` that is always
rolled back.

## Sign-in (`entra.ts`, `shared/sqlserverAuth.ts`)

| Method                    | How                                                                                                                                                                                                                                                        | Secret                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `sql`                     | SQL Server login                                                                                                                                                                                                                                           | password                           |
| `windows`                 | NTLMv2 through tedious (domain + user + password); works from macOS/Linux. No Kerberos/SSPI: tedious has neither, and the native drivers are out                                                                                                           | password                           |
| `entra-interactive`       | `@azure/msal-node` public client, PKCE + loopback redirect; the page opens through the host's opener (Electron `shell.openExternal`, VS Code `env.openExternal`); tokens in memory for the app session; refused where no opener exists (MCP, jobs)         | none                               |
| `entra-azure-cli`         | `az account get-access-token`, run with an argument list (cmd.exe only for `az.cmd`, with validated arguments); `az` searched in PATH and the usual install folders (apps started from the Dock get a short PATH); tokens reused until 2 min before expiry | none                               |
| `entra-service-principal` | `ClientSecretCredential` (tenant, application ID, secret)                                                                                                                                                                                                  | client secret in the password slot |

- tedious asks the `token-credential` for a token on every new session, with the scope the server names.
  The first token is fetched before connecting (`warmUpEntra`), because a browser sign-in takes longer than
  the connection timeout that covers tedious's login.
- Entra user + password (ROPC) is not offered: deprecated by Microsoft and @azure/identity, and it fails with MFA.
- **Open:** `VORTAQ_ENTRA_CLIENT_ID` is empty. Microsoft recommends that a desktop app registers its own
  multitenant public client (platform «Mobile and desktop», redirect `http://localhost`, public client flows
  on, delegated `Azure SQL Database › user_impersonation`). Until Vortaq has one, the browser sign-in needs the
  connection's own «ID de aplicación».

## TLS and network

- `encrypt`: `mandatory` (TLS inside the pre-login, TLS 1.2 max in tedious), `strict` (TDS 8.0, TLS first;
  `trustServerCertificate` does not apply) or `optional`.
- Certificates are checked against Node's roots plus the operating system's (`tls.getCACertificates('system')`)
  and the SSL tab's CA file. «Confiar en el certificado del servidor» is off by default; the error for a
  self-signed certificate says where to turn it on.
- Through an SSH tunnel tedious keeps the real host as `server` (LOGIN7, SNI and the certificate check use it;
  Azure's gateway refuses a login addressed to an IP) and a `connector` opens the socket to the tunnel.
- A named instance is resolved by SQL Server Browser over UDP 1434, which SSH cannot carry: with a tunnel the
  instance's port is required (validation and driver both refuse the combination).
- **Trust and retry (2.7.0).** The two certificate texts live in `shared/sqlserver/certificate.ts`;
  `trustFixesError(message, options)` says whether turning the option on would let the connection in (never
  with `strict` or when it is already on). The form offers «Confiar y reintentar» after a failed test, the
  desktop tree's error notice and the extension's open error «Confiar en el certificado» (saves the option and
  opens again).
- **Refused connections.** tedious wraps a refused connect in «Could not connect (sequence)» with an
  `AggregateError` cause; `socketCode` reads the inner `ECONNREFUSED`, and the text (`CONNECTION_REFUSED`) says
  that SQL Server Express installs with TCP/IP off and where to turn it on.

## Local instances on Windows (2.7.0)

The Microsoft tools reach a local SQL Server Express through shared memory, which needs no network protocol and
exists only in their native drivers; tedious speaks TCP only, and Express installs with TCP/IP off. «Buscar
servidores en este equipo» (`sqlserver:localInstances`, `main/sqlserver/localInstances.ts`, Electron-free and in
the core for the extension) answers what is installed and what is missing, from:

- the Windows service list: `Get-CimInstance Win32_Service` through `powershell.exe` (argument list, no shell,
  15 s), or `sc.exe query state= all` when PowerShell is blocked (labels are translated, so only the shape is
  read). `MSSQLSERVER` / `MSSQL$<instance>`, running or not, and the program folder `MSSQL16.<instance>` gives the
  version and `SQLServerManager16.msc`;
- SQL Server Browser when its service runs: MS-SQLR `CLNT_UCAST_EX` (0x03) to `127.0.0.1:1434`, whose answer lists
  every instance with `tcp;<port>` only when TCP is on;
- a TCP connect to `127.0.0.1:1433`, credited to the default instance or to the only running one.

The registry and SQL Server's WMI configuration are not read (project rule: no other application's data, and WMI
needs administrator rights). TCP is `enabled` (port known), `disabled` (Browser lists the instance without TCP)
or `unknown`. «Usar» fills 127.0.0.1, the port (1433 when TCP still has to be turned on), Windows sign-in with
`USERDOMAIN`/the user name (a local Express installs with Windows authentication only) and
`trustServerCertificate`; `localInstanceSteps` lists the exact steps for that version. Shown only when the host
platform is `win32`; untested on a real Windows in CI (unit tests with recorded PowerShell, `sc.exe` and Browser
answers).

## Renderer and extension

- `engines/sqlserver.ts`: the T-SQL dialect, CodeMirror's MSSQL language, the designer
  (`designer/sqlserver/planner.ts` on the generic Columns/Indexes/ForeignKeys editors: IDENTITY(1,1), named
  DEFAULT constraints dropped by their real name, `sp_rename`, `ALTER COLUMN`, MS_Description; one
  transaction with XACT_ABORT ON; adding or removing IDENTITY is a problem) and `designer/sqlserver/ddl.ts`
  (CREATE OR ALTER in its own batch; a rename drops the old object afterwards).
- Query tabs address `{ database, schema }` like PostgreSQL; completion reuses the PostgreSQL engine with
  bracket labels and the tab's schema then `dbo`.
- The connection dialog has its own SQL Server fields and «Pegar cadena de conexión»
  (`shared/sqlserver/connectionString.ts`: ADO.NET/Azure, ODBC, JDBC, `sqlserver://`; «Copiar cadena de
  conexión» writes ADO.NET without the password).
- The MySQL toolbar snapshot gained exactly «Nueva conexión SQL Server…» (edited by hand, as in 2.0.0).
- Extension: the core exports `setEntraBrowserOpener`; documents use the same batches; tree and runner treat
  SQL Server like PostgreSQL (`usesSchemaRef`, `defaultSchemaOf`, `selectFirstRows` writes `TOP`).

## Import

`.ncx` (`ConnType="SQLSERVER"`: `host\INSTANCE`, `tcp:host,port`, InitialDatabase; Windows sign-in only when
the file says so; attribute names beyond the common ones are unverified) and DBeaver (`sqlserver`/`mssql`
providers, also `azure_sql_server`, with the JDBC URL parsed). The SQL Server section of Navicat's folder is
not read: no real sample was available to verify its layout.

## AI and MCP

- `ai/msMetadata.ts`: `MsMetadataQueryable` accepts one SELECT whose sources are all `sys.*` or
  `INFORMATION_SCHEMA.*` of the session's database (no three-part names, no `OBJECT_DEFINITION`, no
  `OPENJSON`/`OPENROWSET`…, only `@p` parameters). Snapshots carry names, types, keys, indexes, foreign keys,
  routine parameters and row estimates. «Toda la conexión» covers the schemas of the current database.
- Plans: `SET SHOWPLAN_TEXT ON` compiles the SELECT without running it (assistant and MCP `explain_query`).
- MCP treats SQL Server like PostgreSQL (database + schema, `dbo` first in describe_table).

## Tests

- Unit: `dialects/sqlserver.test.ts`, `sqlserver/values.test.ts`, `sqlserver/connectionString.test.ts`,
  `designer/sqlserver/ddl.test.ts`, importer parsers.
- Integration (`VORTAQ_TEST_MSSQL_URL`, compose service `mssql22`, pinned by digest; amd64 only, emulated on
  Apple Silicon): `sqlserverSession.test.ts`, `sqlserver.test.ts` (IPC layer, designer against the server,
  export, AI reader), `mcpSqlServer.test.ts`; the extension's VS Code suite runs a batch with exact values.
- Screenshots: `scripts/seed-sqlserver-shots.mjs`, steps `54*`.

## Later phases

1. `.vqb` copies, restore and REPLACE for SQL Server; jobs.
2. Logins and users view.
3. Vortaq's own Entra application (then the client ID becomes optional).
4. The SQL Server section of Navicat's folder, with a real sample.
