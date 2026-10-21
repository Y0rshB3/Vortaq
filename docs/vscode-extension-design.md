# Editor extension: Electron-free core (phase 1) and the extension (phase 2+)

Vortaq gets a database-client extension for VS Code and its forks (Cursor, Windsurf/Devin
Desktop, VSCodium), built in this repository from the desktop app's code. This document records
where the code that extension needs touches Electron, the ports that now separate the two, how
the boundary is enforced, what the editors' runtime means for SQLite, and the extension itself
as built (section 9).

Phases:

| Phase | Content                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------ |
| 1     | Done. Core usable without Electron, desktop behaviour unchanged.                                                         |
| 2     | Done (`extensions/vscode`, 0.1.0): connections tree, `.sql` documents, editable results, production guard, editor theme. |
| 2.1   | Done (0.2.0): selection, «Copiar como» and «Exportar» in the results panel (section 9.9).                                |
| 2.2   | Done (0.3.0): relationship diagram and visual query panels; foreign key picker and ENUM list in results (9.10).          |
| 3     | Table designer, `.vqb` backups/restore, MongoDB documents, structure-only schema for the editor's AI.                    |
| 4     | Publish to the Visual Studio Marketplace and Open VSX.                                                                   |

Scheduled automation (jobs, scheduler, launchd) stays desktop-only. The extension keeps its own
profile and secrets (VS Code SecretStorage); passwords are never shared with the desktop app.

## 1. Decision summary

- **No file moves, no packages yet.** The core is a new entry point, `src/core/index.ts`, that
  re-exports the Electron-free API from where it already lives in `src/main` and `src/shared`.
  The electron-vite inputs, the electron-builder configuration and every desktop import are
  unchanged (section 6 explains why not npm workspaces).
- **Ports where core logic touched Electron**, each with its desktop adapter in a file of its
  own next to the port (section 3.3). The desktop app registers the same adapters it used before;
  only where they are wired changed.
- **`createCore(options)`** builds the same `AppContext`, `ConnectionManager` and IPC handlers the
  desktop app registers, with the host's ports. Its `invoke(channel, ...args)` answers the core
  channels of the typed IPC map exactly like the renderer's `window.vortaq.invoke`: same handlers,
  same production guard, same error messages.
- **The boundary is enforced twice**: an esbuild bundle of the entry for Node that fails on any
  Electron import or desktop-only file (`npm run check:core`, and a test in `npm test`), and an
  ESLint rule in the core folders (section 5).
- **Independence is proven** by a Node-only integration test that bundles the core, loads it with
  Node's own `require` and drives MySQL 8.4, PostgreSQL 17, MongoDB 8.2 and a SQLite file
  (section 7).
- **SQLite in the editors works on current releases** (Node 24.15+ everywhere on the desktop), with
  a runtime probe and a fallback plan for older or remote hosts (section 8).

## 2. Where Electron was used

Every `electron` import under `src/main` and `src/shared` at the start of phase 1 (`a6f9c83`).
`src/shared` had none. Type-only imports are marked _(type)_.

| File                            | Electron API                                             | Purpose                                 | Classification                                |
| ------------------------------- | -------------------------------------------------------- | --------------------------------------- | --------------------------------------------- |
| `index.ts`                      | `app`, `BrowserWindow`, `dialog`, `Menu`                 | app lifecycle, quit guards, menu        | desktop-only                                  |
| `bootstrap.ts`                  | `app`, `BrowserWindow`, `safeStorage`                    | profile path, context, secret codec     | desktop-only; **safeStorage → port**          |
| `window.ts`, `windowOptions.ts` | `app`, `BrowserWindow`, `shell`; _(type)_ window options | main window                             | desktop-only                                  |
| `menu.ts`, `licenses.ts`        | _(type)_ menu and about-panel options                    | menu, «Acerca de»                       | desktop-only                                  |
| `screenshots.ts`                | `app`, `BrowserWindow` _(type)_                          | screenshot harness                      | desktop-only                                  |
| `services.ts`                   | `app` (dynamic import)                                   | stop automation on quit                 | desktop-only                                  |
| `automation/index.ts`           | `app` (dynamic import)                                   | launchd agents, executable path         | desktop-only (automation stays desktop)       |
| `updates/index.ts`              | `app`, `net`, `shell`                                    | update check and installers             | desktop-only                                  |
| `ipc/typed.ts`                  | `ipcMain`                                                | registers every IPC handler             | **port** (HandleFn)                           |
| `ipc/app.ts`                    | `app`, `BrowserWindow`, `dialog`, `shell`                | app info, settings, dialogs, notices    | desktop-only                                  |
| `ipc/importers.ts`              | `dialog`                                                 | file pickers of the import wizard       | desktop-only (pickers); importers are free    |
| `ipc/tour.ts`, `ipc/updates.ts` | `app` / `shell`                                          | welcome tour, release pages             | desktop-only                                  |
| `sqlite/electronSpawner.ts`     | `utilityProcess`                                         | SQLite worker process                   | **port** (already injected); Node adapter new |
| `sqlite/worker.ts`              | `process.parentPort` (Electron runtime, no import)       | worker entry                            | desktop-only; `nodeWorker.ts` is the Node one |
| `ai/index.ts`                   | `net` (dynamic import)                                   | provider calls through the system proxy | **port** (setAiFetch)                         |

Other Electron-only globals: `process.resourcesPath` and `process.versions.electron` are read
by the desktop shell (`index.ts`, `window.ts`, `ipc/app.ts`; `windowOptions.ts` and
`licenses.ts` take them as arguments). The core reads `process.versions.electron` once, in
`nodeSqliteSpawner`, only to know whether a forked worker needs `ELECTRON_RUN_AS_NODE`.

### 2.1 Already Electron-free (before phase 1)

A probe bundle of each module with esbuild found no Electron import reachable from:

- `src/shared/**` (types, IPC map, engines, dialects and both guard classifiers, typed-confirm
  rules, MongoDB shell layer, connection validation).
- `src/main/db/**` (driver interfaces, registry, `ConnectionManager`, errors, SSH tunnel on
  `ssh2`, the generic query/table-data/row-change loops).
- The drivers: `src/main/mysql/**`, `src/main/postgres/**`, `src/main/sqlite/**` except the two
  files above, `src/main/mongo/**`.
- `src/main/backup/**` (`.vqb`/`.nb3` read, write, restore, REPLACE, SQL export).
- `src/main/credentials/store.ts` (the `SecretCodec` was already injected), `src/main/storage/**`
  (JSON repos under a folder the caller passes).
- `src/main/ai/**` except `index.ts` (the `AiService` already took `fetch` as a dependency).
- `src/main/ipc/productionGuard.ts`, `jobValidation.ts`, `errorLog.ts`, and the handler
  factories `dbPostgres.ts`, `dbSqlite.ts`, `mongo.ts`.
- `src/main/importers/**`, `src/main/navicat/**`, `src/main/automation/runner.ts` and
  `scheduler.ts`, `src/main/migration/**` (Electron-free code, but desktop-only by purpose).
- `log.ts` (file + optional sink), `env.ts`, `context.ts` (`AppContext` already carried the
  profile path, log folder, repos, credentials and the `emit` function as data).

So most of the work was already done by earlier phases (the `AppContext`, the injected SQLite
spawner and secret codec, and the rule that node-side tests never import Electron). What blocked
reuse was the IPC registration (`ipc/typed.ts` imported by every handler module) and the AI
module's dynamic `import('electron')`.

### 2.2 Desktop-only (stays)

Window, menu, app lifecycle and quit guards, the screenshot harness, «Acerca de» and
licences, the welcome tour, updates, profile and secret migration (ElectronDB/Navidog), the
Navicat folder import, automation (jobs, in-app scheduler, launchd, headless `--run-job`), file
dialogs and `shell`, and the `app:*`, `updates:*`, `jobs:*`, `navicat:*`, `importers:*`,
`tour:*` and `settings:*` channels. The extension uses VS Code's own APIs for dialogs
(`window.showOpenDialog`), external links (`env.openExternal`) and settings (its contributed
configuration, or `core.context.settings` for the values the guards read).

## 3. Ports

### 3.1 IPC handler registration (`HandleFn`)

`src/main/ipc/router.ts` (new, Electron-free) holds the host-neutral side of the IPC map:

- `HandleFn` — `(channel, fn) => void` with the channel's argument and result types.
- `runHandler(channel, fn, args)` — the error normalisation `typed.ts` always did: log with
  `describeForLog` (never row data or server text), rethrow a plain `Error` with the message.
- `HandlerRegistry` — an in-memory table with `handle`, `invoke`, `has` and `channels`. Unlike
  Electron IPC it does not clone: arguments and results pass by reference, so an in-process
  caller must not mutate a result the core may still hold (the webview bridge serialises them
  anyway).

`typed.ts` keeps the desktop `handle` (ipcMain) and now calls `runHandler`. The handler modules
without Electron imports take the `HandleFn` as a parameter:
`registerConnectionsHandlers`, `registerDbHandlers` (which also registers every `sqlite:*` and
`mongo:*` channel), `registerFiltersHandlers`, `registerBackupsHandlers`, `registerAiHandlers`.
`register.ts` passes the same ipcMain `handle` as before.

### 3.2 Process-wide host ports

Like `setSqliteSpawner` before it, the AI network function is a setter the host calls once:

- `setAiFetch(fetchFn)` (`ai/index.ts`). The desktop app registers `electronFetch`
  (`ai/electronFetch.ts`, Electron's `net.fetch`: system proxy and certificates) right after
  `setSqliteSpawner`, before any handler exists. Other hosts and tests keep Node's global
  `fetch`. The service reads the function at call time.

### 3.3 Port table

| Port                  | Interface (file)                              | Desktop adapter                                                                      | Node / extension adapter                                                                                                   |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Handler registration  | `HandleFn` (`ipc/router.ts`)                  | `handle` (`ipc/typed.ts`, ipcMain)                                                   | `HandlerRegistry` (createCore; webview bridge in phase 2)                                                                  |
| Secret encoding       | `SecretCodec` (`credentials/store.ts`)        | `electronCodec` (`credentials/electronCodec.ts`, moved verbatim from `bootstrap.ts`) | `keyCodec(key)` (`credentials/keyCodec.ts`, new); `plainCodec` for tests                                                   |
| SQLite worker process | `ProcessSpawner` (`sqlite/spawner.ts`)        | `electronSqliteSpawner` (utilityProcess + `worker.ts`)                               | `nodeSqliteSpawner(entry)` (`sqlite/nodeSpawner.ts`, new; forks the bundled `nodeWorker.ts`); `inProcessSpawner` for tests |
| HTTP for AI providers | `FetchFn` + `setAiFetch` (`ai/`)              | `electronFetch` (`ai/electronFetch.ts`, `net.fetch`)                                 | global `fetch` (or the host's)                                                                                             |
| Profile paths         | `AppContext.userDataPath`, `logDir`           | `app.getPath('userData')` (`bootstrap.ts`)                                           | `CoreOptions.dataDir` (the extension's `globalStorageUri`)                                                                 |
| Push events           | `AppContext.emit`                             | `webContents.send` to every window                                                   | `CoreOptions.emit` (forward to webviews / progress UI)                                                                     |
| Logging               | `configureLog({ filePath, sink })` (`log.ts`) | `<profile>/logs/vortaq.log`                                                          | `CoreOptions.log` (a LogOutputChannel through `sink`)                                                                      |
| Driver lookup         | `DriverLookup` (`db/manager.ts`)              | lazy registry                                                                        | same registry                                                                                                              |

`keyCodec` is AES-256-GCM with one random 32-byte key: values are
`v1:` + base64(iv | tag | ciphertext) in `credentials.json` (codec name `'vaultKey'`), and the
key lives in the host's secret vault. That is the split Electron's `safeStorage` makes (key in
the OS keychain, ciphertext on disk), so `CredentialStore` stays synchronous and unchanged.
A wrong key or a tampered value fails to decrypt with a Spanish message.

`nodeSqliteSpawner` forks with the advanced serialization (rows carry `bigint` and `Uint8Array`),
no inherited `execArgv` (a host started with `--inspect` would make every child fight for the
port), and `ELECTRON_RUN_AS_NODE=1` when the host itself runs on Electron (VS Code's extension
host: `process.execPath` is the editor binary). It is a process, not a worker thread:
`node:sqlite` runs inside `sqlite3_step`, and `Worker.terminate()` cannot interrupt native code,
so only killing a process cancels a runaway statement. A child that never starts (a failed fork)
or whose IPC channel closed is reported as exited instead of raising an uncaught `'error'` in
the host, so the client rejects its pending calls. An optional `execPath` runs the worker on
another Node binary (the first SQLite fallback of section 8).

`sqliteRuntimeProblem()` (`sqlite/runtime.ts`, new) tells a host whether its Node can run the
driver (section 8).

## 4. The core entry (`src/core/`)

- `src/core/index.ts` — re-exports, grouped: host setup and ports; secrets; storage repos;
  connections, drivers and SSH tunnel; the query/table-data/row-change loops; introspection per
  engine (as namespaces: `mysqlIntrospect`, `postgresIntrospect`, `sqliteIntrospect`,
  `mongoAdmin`); the handler registration functions and factories; the production guard
  (`assertProductionWriteConfirmed`, `assertScriptAllowed`, `needsTypedConfirm`) and the
  typed-confirm rules; the SQL dialects (splitting, `analyzeWrites` = renderer allowlist,
  `isObviousWrite` = main denylist, quoting) and the MongoDB classifiers; engines, validation,
  MongoDB URI and shell/EJSON formatting; the SQLite runtime; backups (`createBackupService`,
  archive reading/verification); the AI service; the IPC contract and domain types.
- `src/core/host.ts` — `createCore(options)`:

```ts
const core = createCore({
  dataDir, // the host's own profile folder
  secrets: { codec: keyCodec(vaultKey), codecName: 'vaultKey' },
  sqliteSpawner: nodeSqliteSpawner(workerPath), // optional: without it SQLite is refused
  emit: (channel, payload) => {}, // optional push events
  fetch, // optional AI network function
  log: { sink } // optional
})
await core.invoke('connections:open', id) // same channels and guards as the renderer
await core.dispose() // closes connections, tunnels and SQLite workers
```

It registers the `connections:*`, `db:*`, `sqlite:*`, `mongo:*`, `filters:*`, `backups:*`,
`export:*` and `ai:*` channels (`core.channels()`), none of the desktop-only ones. Several processes may share one
`dataDir` (an editor extension host per window): `createCore` makes the JSON stores re-read a file
another process changed (`setJsonStoreReload`). The SQLite spawner, the AI
fetch and the log settings are process-wide: one core per process, like the desktop app's one
context. `headless` is false, so a `mysql` connection whose server reports MariaDB is promoted in
the host's own `connections.json`, as in the desktop app.

To add something to the core: export it from `src/core/index.ts`; if it is not yet in a core
folder, add its folder or file to `CORE_FILES` in `eslint.config.mjs`. If it needs Electron,
define a port next to it and put the Electron adapter in its own file, listed in
`ELECTRON_ADAPTERS` (ESLint) and `DESKTOP_ONLY_FILES` (`scripts/core-bundle.mjs`).

## 5. Boundary enforcement

1. **Bundle check** — `scripts/core-bundle.mjs` bundles `src/core/index.ts` with esbuild for
   platform `node` (CommonJS). Its plugin fails the build, with the importing file and line, on:
   `electron` or `electron-updater` (static `import`, `require` or dynamic `import()`), any file
   in `DESKTOP_ONLY_FILES` (the app shell and the Electron adapters, including
   `sqlite/worker.ts`, which never names Electron but needs its `parentPort`), and anything under
   `src/renderer/`, `src/preload/` or `src/main/updates/`, whatever its extension (an `onLoad`
   backstop refuses loading any of them however it was resolved). npm packages stay external
   except the ESM-only ones `electron.vite.config.ts` also inlines (`plist`, `@noble/*`); their
   insides are not traversed, so the check relies on the two Electron-only package names (no
   runtime dependency of the core needs Electron).
   - `npm run check:core` runs it from the command line.
   - `scripts/core-bundle.test.ts` (part of `npm test`, hence `npm run check`) asserts that the
     real entry passes and reaches the core modules, and that fixture entries with each kind of
     violation fail.
   - `node scripts/core-bundle.mjs --out <dir>` writes `core.cjs` and `sqliteWorker.cjs`.
2. **ESLint** — in the core folders (`src/core`, `src/shared`, the `src/main` folders `db`,
   `mysql`, `postgres`, `sqlite`, `mongo`, `backup`, `credentials`, `storage` and `ai`, the
   Electron-free `src/main/ipc` modules and a few single files), `no-restricted-imports` forbids
   `electron`, `electron-updater` (and their subpaths) and the desktop-only files by name, and
   `no-restricted-syntax` forbids `import('electron')` and `require('electron')`. It also catches
   what the bundle check cannot see: type-only imports (esbuild erases them) and `import()` or
   `require()` with a computed path (esbuild leaves those alone without a warning), which are
   refused outright in the core folders. The four Electron adapters are the only exceptions
   inside those folders.

Neither check replaces the other: ESLint flags the line where a forbidden import is written but
cannot follow the import graph; the bundle check follows the whole graph from the entry, so it
also catches a core file importing a non-core module that imports Electron.

## 6. Why no npm workspaces or packages in this phase

The root `package.json` is the desktop app: electron-builder packs its production dependencies
from `node_modules`, `npm ci` downloads Electron through its postinstall, and electron-vite
reads the `@shared`/`@main` aliases. Turning the repository into workspaces would change the
install layout (hoisting, symlinks) that electron-builder walks to collect dependencies (the
extension's dependencies could end up in the desktop app or the other way round), and moving
`src/main` modules into packages would touch most imports and both build configurations. None
of that is needed to reuse the code: the core is a set of source files reached from one entry,
and esbuild can bundle them for the extension with the same aliases. Section 9.1 keeps the
extension a separate npm project for the same reason.

## 7. Proof of independence

- `src/core/host.test.ts` (unit, in `npm run check`): `createCore` answers the core channels and
  none of the desktop-only ones; passwords go through `keyCodec` into the core's own
  `credentials.json` as ciphertext; on a SQLite file (in-process workers) it runs SQL, edits a row
  and the guard refuses unconfirmed writes on a production connection.
- `tests/integration/coreNode.test.ts` (in `npm run test:integration:required`): bundles the core
  with `scripts/core-bundle.mjs` into `node_modules/.cache` and loads it with Node's own
  `require` (no Vite runner, no aliases, no mocks); asserts that no `electron` module was loaded.
  With a vault-key credential store in a temp profile it opens **MySQL 8.4**, **PostgreSQL 17**,
  **MongoDB 8.2** and a **SQLite** file whose worker is a real child process
  (`nodeSqliteSpawner` + the bundled worker), runs a query, introspects tables or collections,
  applies one row (document) edit, and checks that the production guard refuses an unconfirmed
  write (`db:execute`, `db:applyRowChanges`, `mongo:execute`, `mongo:applyChanges`), leaving the
  data unchanged; on MySQL the confirmed write then succeeds.
- The SQLite cancel-by-kill integration test now uses `nodeSqliteSpawner` too, and
  `src/main/sqlite/nodeSpawner.test.ts` covers its message round trip (bigint and bytes), a
  message to a dead process and a worker that never starts.

## 8. SQLite in the editors

The extension host runs on the editor's own Node (inside its Electron). Vortaq's SQLite driver
uses `node:sqlite` in a forked worker, and its newest requirement is
`DatabaseSync#setAuthorizer` (**Node 24.10**), which denies `ATTACH` of missing or relative
paths; it also needs `StatementSync#columns()` (22.16 / 23.11), `setReturnArrays` (24.0) and URL
paths (22.15 / 23.10). No editor is installed on the development machine, so the figures below
come from the editors' sources and release notes (October 2026).

| Editor (stable, Oct 2026)            | VS Code base        | Electron  | Node (extension host) | `node:sqlite` without flags, with `setAuthorizer`     |
| ------------------------------------ | ------------------- | --------- | --------------------- | ----------------------------------------------------- |
| VS Code 1.141.0 (2026-10-07)         | —                   | 43.7.7    | 24.21.0               | yes, no warning                                       |
| Cursor 3.24.12 (2026-10-09)          | extension API 1.128 | 42.10.0   | 24.18.1               | yes on the desktop; **no on its remote server**       |
| Windsurf, now Devin Desktop, 3.10.48 | VS Code 1.126       | not found | not found             | probably yes (1.126 ships Electron 42.3 / Node 24.15) |
| VSCodium 1.135.06055 (2026-09-09)    | VS Code 1.135       | 42.8.1    | 24.18.1               | yes                                                   |

Node facts behind the table:

- `node:sqlite` loads without `--experimental-sqlite` since Node 22.13 / 23.4. It printed an
  ExperimentalWarning until 24.14; from 24.15 (release candidate, stability 1.2) it does not.
- `setAuthorizer` exists only from Node 24.10 (not backported to 22.x). VS Code moved to Node 24
  in **1.123** (June 2026, Electron 42.3, Node 24.15); 1.101–1.122 ran Node 22.
- Electron builds Node with `node:sqlite`; the one regression (Electron 37.2.0, "No such binding:
  sqlite") was fixed in 37.2.3 / 36.7.3 / 38. The editors' current Electron versions are later.
- Node 26 renames `DatabaseSync`/`StatementSync` to `Database`/`Statement` (the old names stay as
  deprecated aliases, DEP0210/DEP0211) and, from 26.8, throws when the authorizer callback uses
  its own connection; Vortaq's authorizer only checks the path, so neither breaks the driver.
- Cursor's remote server (`cursor-server`, SSH/WSL) shipped Node 20.18 until at least May 2026,
  without `node:sqlite`; not confirmed fixed in October.

Plan:

- `engines.vscode: "^1.123.0"` in the extension's manifest (Node 24.15+ in VS Code; Cursor,
  Devin Desktop and VSCodium are on later bases).
- At activation, `sqliteRuntimeProblem()` checks `node:sqlite` and `setAuthorizer` in the host's
  Node (the worker is forked with the same binary). When it reports a problem, SQLite is hidden
  from the engine picker and its connections show that message; the driver never opens a file
  without the authorizer (fail closed).
- **Fallback (not implemented).** In order of preference:
  1. A setting `vortaq.sqlite.nodePath` pointing at a Node ≥ 24.10 the user installed; the
     spawner forks the same worker with that binary (`nodeSqliteSpawner`'s `execPath` option
     already exists). Cheap, keeps
     every driver behaviour, works on remote hosts with a modern Node.
  2. **sql.js** (SQLite compiled to WebAssembly, MIT) as a read-only fallback: it loads the whole
     file into memory and writes back by exporting the whole database, with no file locking
     against other processes, so it must not write to a file another program may hold. Good for
     browsing and queries on old or remote hosts.
  3. `wa-sqlite` with a Node file-system VFS would give real file I/O and locking in WebAssembly,
     at the cost of more code; consider it only if read-only is not enough.
  - Rejected: `better-sqlite3` and other native modules (a prebuild per editor Electron ABI and
    platform; the same reason the desktop app avoids them).

## 9. Phase 2: the extension as built

Phase 2 is `extensions/vscode/` (extension name «Vortaq», id `y0rshb3.vortaq`, version 0.1.0,
separate from the desktop version; 0.2.0 adds copy and export of results, section 9.9). This section describes it as built; **Deviation** marks where
it differs from the design notes this section replaced, and why.

### 9.1 Layout and build

```
extensions/vscode/
  package.json        manifest (no dependencies; devDependencies esbuild, @vscode/vsce,
                      @vscode/test-electron) + its own package-lock.json
  tsconfig.json       host code and tests (node + vscode types; @core, @shared, @main, @renderer)
  tsconfig.webview.json  webviews (DOM + Vue; @shared, @renderer)
  scripts/build.mjs   esbuild: dist/extension.cjs, dist/sqliteWorker.cjs; Vite: dist/webview/*
  scripts/package.mjs build without source maps, check the file list, vsce package
  scripts/test-integration.mjs, scripts/screenshots.mjs   VS Code runs (section 9.8)
  src/extension.ts    activate/deactivate, commands
  src/protocol.ts     host ⇄ webview messages and their validation
  src/webviewState.ts state types sent to the webviews
  src/host/           core wiring, connections, tree, SQL documents, guard, panels, bridge
  src/webview/        webview bootstrap, bridge, theme, connection form, results
  media/              activity bar and panel icons (SVG)
  test/               vscode mock (unit), integration suite, screenshot tour, fixtures
  README.md (Spanish, Marketplace page)  CHANGELOG.md  LICENSE  .vscodeignore
```

- **A separate npm project, not a workspace member**, as designed: the desktop lockfile and
  electron-builder's dependency walk are untouched (installing `@vscode/vsce` at the root would have
  changed the flags of an existing package in `package-lock.json`). `npm run ext:install` installs
  its tooling.
  - **Deviation:** `@types/vscode` (pinned to 1.120.0, at most `engines.vscode`, no dependencies) is
    a root devDependency, so `npm run check` typechecks the extension without its install. `ovsx`
    waits for phase 4.
  - **Deviation:** no `nodePaths`: every source file is under the repository root, so esbuild
    resolves the runtime packages from the root `node_modules` on its own.
- **Bundles** (`scripts/build.mjs`): `dist/extension.cjs` (CommonJS, Node 22 target, `vscode`
  external, the core and every driver inlined, minified, `legalComments: none`) and
  `dist/sqliteWorker.cjs` (`src/main/sqlite/nodeWorker.ts`). The optional modules
  electron-builder also leaves out stay external (`*.node`, `cpu-features`, `kerberos`,
  `@mongodb-js/zstd`, `snappy`, `mongodb-client-encryption`, `@aws-sdk/credential-providers`,
  `gcp-metadata`, `socks`, `aws4`, `pg-native`, `pg-cloudflare`); each is required lazily inside
  try/catch. A boundary plugin fails the build on `electron`/`electron-updater` and on the files of
  `DESKTOP_ONLY_FILES`/`DESKTOP_ONLY_DIRS` (`scripts/core-bundle.mjs`); the one renderer module the
  host uses is allowed by name (`components/query/destructiveGuard.ts`, pure TypeScript).
- **Webviews:** Vite with the renderer's plugins (`@vitejs/plugin-vue`, `vite-plugin-vuetify`),
  one build per view. **Deviation:** each view is a single IIFE (no code splitting), so the CSP
  allows scripts by nonce only. A Vite plugin refuses `electron` and anything under `src/main`,
  `src/core` or `src/preload`. Icons: `dist/webview/mdi.css` holds only the `mdi-*` classes the
  reused sources and Vuetify's aliases name (about 270) and points at the woff2 font only.
- **Notices:** `dist/THIRD_PARTY_NOTICES.txt` lists the packages whose files the bundles contain
  (esbuild metafile and Rollup module ids) plus `@mdi/font` and `vue`, with `describePackage` and
  `renderPackage` exported from `scripts/third-party-licenses.mjs` (the desktop notices are
  byte-for-byte unchanged).
- **Packaging** (`npm run ext:package`): `vsce package --no-dependencies` after checking that the
  VSIX has the bundles, the notices and the icons, and no source maps, TypeScript/Vue sources,
  tests, fixtures, `node_modules`, `.node` binaries or secret-looking files. The 0.1.0 and 0.2.0 VSIX are about 2 MB
  (17 files). Nothing is published (phase 4). A GitHub release of
  the VSIX (tag `vscode-v<version>`) must not be marked as the latest release: the desktop update
  check reads `/releases/latest` and electron-updater its `latest*.yml`.
- **Desktop untouched:** electron-builder packs only `out/**` and `package.json`; the electron-vite
  inputs did not change. `npm run check` now also lints, typechecks (`typecheck:ext`) and unit-tests
  (vitest project `ext`) the extension.

### 9.2 Activation wiring

`host/core.ts` calls `createCore` with the extension's ports:

| Port        | Extension adapter                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Profile     | `context.globalStorageUri` (never the desktop profile)                                                         |
| Secrets     | `keyCodec(key)`, codec name `vaultKey`; the key in `context.secrets` under `vortaq.vaultKey` (`host/vault.ts`) |
| SQLite      | `nodeSqliteSpawner(dist/sqliteWorker.cjs)` only when `sqliteRuntimeProblem()` is null; else no spawner         |
| Push events | `event:connectionClosed` → the tree, the runner's sessions and a warning                                       |
| Logging     | `configureLog({ filePath: null, sink })` into the «Vortaq» LogOutputChannel                                    |
| AI fetch    | not wired (no AI in phase 2)                                                                                   |

- A stored value the current vault key cannot decrypt (SecretStorage lost the key) is dropped at
  activation and asked again when connecting; the output channel says how many.
- Opening a connection asks (input box, `password: true`) for a password or SSH password the vault
  does not have yet (imported connections). With «Guardar contraseña» off the typed password is
  kept in memory only (`CredentialStore.setTransient`, never written) until the connection closes.
- `deactivate` and a context disposable close every connection, tunnel and SQLite worker.
- **Several editor windows** run one extension host each, so several cores share the
  globalStorage folder. `createCore` turns on `setJsonStoreReload(true)`: each JSON store re-reads
  its file when another process replaced it (inode, size, mtime) before reading or mutating, so no
  window overwrites another's connections, passwords or settings with a stale copy (the desktop
  app keeps reading once). A FileSystemWatcher on `connections.json`/`credentials.json` refreshes
  the tree. After creating a vault key the extension uses the one SecretStorage kept, and its
  codec follows a key another window stores later (`followingCodec`).
- The test API (core, tree, panels, a replaceable prompter) is returned only in
  `ExtensionMode.Test`, so other extensions never get the core.

### 9.3 Webview bridge on the typed IPC map

- **Webview side** (`src/webview/bridge.ts`): `window.vortaq` (`platform`, `invoke`, `on`) over
  `acquireVsCodeApi()`, so the renderer's `api.ts`, stores and components run unchanged. The page
  posts `ready`; the host answers with `init` (and later `state`) messages: state never goes into
  the HTML.
- **Host side** (`host/webview/bridge.ts`): `parseWebviewMessage` checks every field (types,
  lengths, at most 8 arguments) and drops anything else. `invoke` answers only the panel's
  channels, then a per-panel scope check, then the guard, then `core.invoke`; results go through
  `toJsonSafe` (bigint, bytes, dates, NaN… as exact text) and errors as their message only.
  - Connection form: `connections:save/test/set*Password/has*Password` and `sqlite:createFile`,
    only for the connection it edits or the one its first save created (`connections:test` too: it
    falls back to the stored passwords of `input.id`), and `sqlite:createFile` only for the path
    the user just chose in the save dialog. Host adapters answer `app:pickFile`, `app:pickSaveFile`,
    `app:pickDirectory` (VS Code dialogs) and `app:openPath` (only the edited connection's extra
    backup folders).
  - Results: `db:tableStructure` and `db:applyRowChanges`, only on the panel's own connection;
    `export:rows`, `export:query` and `export:cancel` (section 9.9), and a host adapter for
    `app:pickSaveFile` (VS Code's save dialog).
  - Never `db:execute`, `connections:delete`, `settings:*`, `jobs:*` or other `app:*` channels.
- **Deviation:** `settings:get` was not moved out of `ipc/app.ts`: the webviews receive the
  settings they read (typed-confirmation environments, destructive confirmation, row limit) in their
  state, and the reused stores are filled from it.
- **JSON safety:** checked as planned: `tests/integration/coreNode.test.ts` asserts that
  `db:execute` results of every engine and MongoDB pages round-trip through JSON unchanged.
- **CSP:** `default-src 'none'`; `script-src 'nonce-…'`; `style-src` the extension's files and the
  nonce (the editor-theme stylesheet and Vuetify's theme stylesheet, via `theme.cspNonce`);
  `font-src`/`img-src` the extension's files; `base-uri`/`form-action 'none'`; command URIs off;
  `localResourceRoots` = `dist/webview`. `retainContextWhenHidden` only for results (unapplied
  edits survive switching tabs).
- Notifications of the reused components become VS Code notifications and their confirmations VS
  Code modal dialogs.

### 9.4 Theming

**Deviation:** no static `vscode-theme.css`. `src/webview/theme.ts` builds the stylesheet at run
time, because some tokens need numbers (`rgba(var(--nd-accent-rgb), …)`) and Vuetify needs opaque
hex colours; it re-runs when VS Code changes the body class or the variables on `<html>`. The
mapping is the table that stood here, with these changes:

- `--nd-border-strong` comes from `input-border` / `widget-border` (the focus colour would have
  made every strong border blue); `contrastActiveBorder` in high contrast.
- High-contrast themes paint buttons black: the accent (`--nd-accent`, Vuetify `primary`) is
  `focusBorder` there, with black or white text by contrast.
- Radii shrink to the editor's (6/4/3 px); shadows go in high contrast; glass, glow and nebula
  are flat or transparent; `--nd-font-mono` is `editor.fontFamily`, so grids use the editor font.
- `theme.test.ts` checks that every colour and font token of `tokens.css` is re-declared for the
  four kinds of theme.

### 9.5 SQL documents, guard UX, SSH, remote

- **Targets:** connection, database and (PostgreSQL) schema per document (`host/targets.ts`):
  workspace state for files, session only for untitled documents. Status bar item (red background
  for production, warning colour for other guarded environments), a CodeLens on the first line
  («conexión · base de datos», «Ejecutar todo») and editor-title buttons (Ejecutar/Detener, elegir
  conexión).
- **Ejecutar:** selection, else the statement under the cursor, else the whole document
  (`host/statement.ts`). **Deviation:** `SqlStatement` has no offsets, so the document ranges are
  recomputed from each statement's text and first line; a MySQL routine that came out of a
  DELIMITER block is sent back inside one, because the core splits what it receives again.
- **Sessions:** PostgreSQL and SQLite documents run on their own session (`sessionKey` = document
  URI, `executionId` for Detener); it closes when the last tab of the document closes
  (`tabGroups.onDidChangeTabs`; closing a text document also fires on a language change) or when
  its target changes.
  `SET search_path` moves the document's schema. «Ejecutar» opens the connection before it splits the script and
  checks it (opening can turn a `mysql` connection into `mariadb`), and a second «Ejecutar» while
  one is starting is refused. MySQL keeps the desktop behaviour: Detener drops
  late results.
- **Production guard:** before a write the host asks with the dialect's `analyzeWrites`
  (renderer allowlist) and, on a guarded connection, shows an input box that must match the
  connection name; only then `confirmProduction: true` is sent. Elsewhere, destructive statements
  ask a modal question when `vortaq.confirmDestructive` is on. **Deviation (stronger):** webview
  writes never carry the webview's own confirmation: the bridge strips `confirmProduction` from
  every argument and the host asks, from the call's arguments («Se aplicarán 2 cambios en
  tienda.clientes (1 modificación, 1 fila borrada)»), when the write arrives. The webview answers
  a typed-name `ui.ask` with yes because the real question is the host's. Main still enforces it.
  The integration suite checks the three layers (core alone, dismissed prompt, forged webview
  flag).
- **Settings:** `vortaq.maxRows`, `vortaq.typedConfirmEnvironments`, `vortaq.confirmDestructive`
  (both application-scoped: a workspace cannot relax them), `vortaq.codeLens`; the guard ones are
  copied into the core's settings.json, where the core reads them.
- **Re-running** a document whose results hold unapplied edits asks «Descartar y ejecutar».
- **SSH:** as designed (pure-JS `ssh2`). **Remote:** `extensionKind: ["ui", "workspace"]`;
  untrusted and virtual workspaces are supported (nothing runs without a user action).

### 9.6 Connection import from the desktop app (without passwords)

`host/desktopImport.ts` reads `<profile>/connections.json` only (macOS
`~/Library/Application Support/Vortaq`, Windows `%APPDATA%\Vortaq`, Linux
`$XDG_CONFIG_HOME/Vortaq` or `~/.config/Vortaq`; «Elegir connections.json…» when it is not
there), copies known fields only (a hand-edited file may carry anything), drops ids, dates and
the desktop's backup folders, validates each entry with `connectionSaveError` and lists them with
checkboxes (duplicate names unchecked). It never opens `credentials.json`; the unit test checks
the only file read. `VORTAQ_TEST_DESKTOP_PROFILE` (test-only) points at the fixture in
`extensions/vscode/test/fixtures/desktop-profile/`.

### 9.7 Naming

As designed: «Vortaq», «Cliente de bases de datos para VS Code», `vortaq.` ids, Spanish UI.
Publisher `y0rshb3` is a placeholder until the Marketplace publisher and Open VSX namespace exist
(phase 4).

### 9.8 Testing

- **Webview components** (vitest project `ext-web`, jsdom, `*.web.test.ts`, in `npm run check`):
  the results webview with the reused renderer components and a fake host.
- **Unit** (vitest project `ext`, mocked `vscode`, in `npm run check`): statement selection,
  document targets, guard prompting and webview-call preparation, bridge validation/allowlist/
  serialization, CSP, form scope, desktop import (fixture, no passwords, only connections.json
  read), vault key, settings, theme mapping, copy formats.
- **Integration in VS Code** (`npm run ext:test`, not part of the desktop gate): downloads VS Code
  with `@vscode/test-electron` 3.x (2.x cannot start 1.110+ builds on macOS) into
  `~/Library/Caches/vortaq-vscode-test` (Windows `%LOCALAPPDATA%\vortaq-vscode-test`, else
  `~/.cache/vortaq-vscode-test`; `VORTAQ_VSCODE_TEST_CACHE` overrides it) and runs
  `test/integration/suite.ts` with a scratch profile, in-memory SecretStorage
  (`--use-inmemory-secretstorage`, no keychain item) and no other extensions. No mocha: a small
  sequential runner with `node:assert`; the webviews' part is played through the panels' message
  handlers, so the allowlists, scopes and guard are the real ones. `--required` fails on a missing
  server URL.
- **Screenshots** (`node extensions/vscode/scripts/screenshots.mjs <dir>`): the same VS Code with
  `--remote-debugging-port`; `test/integration/shots.ts` walks the views and the script captures
  the window with `Page.captureScreenshot` (no screen-recording permission needed), in the dark,
  light and high-contrast themes.

### 9.9 Copy and export of results (0.2.0)

The results webview passes `exportable`, the run's `script` and its `context` (MySQL database,
PostgreSQL `{ database, schema }`, null on SQLite: `runContext` in `host/runner.ts`) to the reused
`EditableResult`, so the desktop grid selection, «Copiar como» and `ExportDialog` run unchanged. The
core answers `export:*` with the same Electron-free service as the desktop (`src/main/export`):
`<file>.part` renamed when complete, «Resultado completo» re-read in a new read-only session, MongoDB
refused. `host/panels/exports.ts` adds the host's part:

- `app:pickSaveFile` is `window.showSaveDialog` with the format's filter, in the folder of the last
  export, else the local workspace folder or home; a remote file system pick is refused, as in the
  connection form.
- **Scope** (the webview is untrusted): `export:rows`/`export:query` only write a file the user just
  chose in that panel's save dialog (each choice is good for one export), `export:query` only on the
  panel's own connection, `export:cancel` only for an export the panel started.
- «Ver datos» panels run `SELECT * … LIMIT n`; their «Resultado completo» becomes the table source
  (`{ kind: 'table' }`, no paging), as in the desktop table view, so it exports the whole table.
- **Progress:** the core's `event:progress` (kind `'export'`) is routed by operation id to the
  panel that started it (`ResultsPanels.progress`), which forwards it to its webview: the progress
  store and `ExportDialog` work as on the desktop, and a strip of `OperationProgress` cards with
  «Cancelar» replaces the desktop operations card. It is mirrored in `window.withProgress`
  (notification, cancellable → `export:cancel`). A closed panel's export keeps running there.
- **Outcome:** a finished export is a VS Code notification with «Abrir» (`vscode.open`; Excel and
  HTML with `env.openExternal`) and «Mostrar en carpeta» (`revealFileInOS`). The dialog's own
  «filas exportadas» notice, whose «Mostrar en la carpeta» handler lives in the page, is not
  forwarded (`webview/results/exportNotices.ts`). A failure is shown once: the host shows the
  service's message after the webview received a progress event for the operation (its dialog then
  leaves it to the operations UI), the webview shows the ones raised before any; a cancel is a
  status bar message.
- **Deviation:** no theming changes were needed: the dialog, the menus and the progress cards only
  use `--nd-*` tokens and Vuetify colours, which `theme.ts` maps already (checked in the dark, light
  and high-contrast screenshots).

Tests: `exports.test.ts` and `results.test.ts` (scope, save dialog, progress routing,
notifications, «Ver datos», with a fake webview panel), `ResultsApp.web.test.ts` (vitest project
`ext-web`: the results webview in jsdom with «Exportar», the dialog, the progress strip and the
notice filter), `src/core/host.test.ts` and `tests/integration/coreNode.test.ts` (export through
`createCore` and the bundled core in plain Node: SQLite CSV/XLSX and cancel, MySQL 8.4, PostgreSQL
17), and the VS Code suite (MySQL on production without a prompt, «Ver datos», SQLite).

### 9.10 Relationship diagram and visual query (0.3.0)

The desktop views were split into host-neutral components, `RelationshipDiagram.vue` and
`QueryBuilder.vue` (desktop tabs: thin wrappers in `views/DiagramView.vue` and
`views/QueryBuilderView.vue`). The extension mounts them in one webview, `schema`
(`webview/schema/SchemaApp.vue`), opened by `vortaq.diagram` / `vortaq.queryBuilder` on a database
node (MySQL, MariaDB, SQLite; PostgreSQL databases use `public`) or a PostgreSQL schema node, never
MongoDB. `host/panels/schemaViews.ts` allows only `db:tables` and `db:tableStructure`, for the
panel's own connection **and** `SchemaRef` (`schemaScope`); `app:saveImage` is a host adapter: the
image is checked by `src/main/imageExport.ts` (PNG signature, SVG root, 40 MB) and written where
VS Code's save dialog says. The webview posts two new messages (`protocol.ts`): `openData` («Ver
datos» of a table of that namespace) and `openSql` (a new untitled SQL document targeted at the
same connection/database/schema, run with `SqlRunner.run(editor, true)` when `run`, so the runner's
guards apply). One diagram panel per namespace; every visual query is a new panel. The results
panel also gained `db:tableData` (structured search only, `tableDataProblem`) for the foreign key
picker of `EditableResult`.

Tests: `schemaViews.test.ts` (scope, save dialog, messages), `bridge.test.ts` (message parsing),
`SchemaApp.web.test.ts` (both apps in jsdom with a fake host) and the VS Code suite (SQLite: the
diagram's reads, a refused other namespace and `db:tableData`, and «Ejecutar» running the SELECT in
a document). Screenshots: `diagram-*` and `query-builder-*` in the three themes.

## 10. Left for phase 3 (and later)

- Table designer; `.vqb` backups and restore (core channels exist: `backups:*`).
- MongoDB: document editing (`mongo:applyChanges`), shell queries from the editor
  (`mongo:execute` for `.mongodb`/`.js` documents), «Cargar más».
- Pagination of SQL results and «Ver datos» (filters, sort on the server).
- Transaction controls for PostgreSQL/SQLite document sessions (state in the status bar,
  Confirmar/Deshacer) and the desktop's «transacción abierta» prompt when closing a document.
- Schema-aware SQL completion in `.sql` documents.
- Structure-only AI context as a Language Model tool, reusing `MetadataQueryable`,
  `PgMetadataQueryable`, `SqliteMetadataQueryable` and `MongoStructureSource`; never rows.
- `.ncx` import for a file the user picks; the SQLite fallback of section 8
  (`vortaq.sqlite.nodePath` first) if users on old or remote hosts ask for it.
- English UI strings (`package.nls`) if the extension is offered beyond Spanish.
- Phase 4: Marketplace and Open VSX publisher, `vsce publish` / `ovsx publish` as an explicit step.

## 11. Sources

- VS Code 1.141.0 Electron target: `https://raw.githubusercontent.com/microsoft/vscode/1.141.0/.npmrc`;
  release notes `https://code.visualstudio.com/updates`; version history
  `https://github.com/ewanharris/vscode-versions`.
- Electron/Node pairs: `https://releases.electronjs.org/release/v43.7.7`,
  `https://releases.electronjs.org/release/v37.6.0`.
- Cursor 3.24.12 About block (2026-10-13):
  `https://forum.cursor.com/t/service-unavailable-and-error-loading-usage-data/174493`; remote
  server Node 20:
  `https://forum.cursor.com/t/cursor-remote-runtime-locked-to-node-20-breaks-modern-extensions-requiring-node-22-node-sqlite/151196`.
- Windsurf / Devin Desktop changelog: `https://docs.devin.ai/desktop/changelog`.
- VSCodium releases: `https://github.com/VSCodium/vscodium/releases`.
- Node `node:sqlite`: `https://nodejs.org/api/sqlite.html`,
  `https://nodejs.org/docs/latest-v24.x/api/sqlite.html`,
  `https://nodejs.org/docs/latest-v22.x/api/sqlite.html`,
  `https://nodejs.org/en/blog/release/v24.15.0`, `https://nodejs.org/en/blog/release/v24.10.0`,
  `https://github.com/nodejs/node/pull/61262`.
- Electron `node:sqlite` regression: `https://github.com/electron/electron/issues/47671`,
  `https://github.com/electron/electron/pull/47706`.
