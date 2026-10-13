# Editor extension: Electron-free core (phase 1) and extension design (phase 2+)

Vortaq gets a database-client extension for VS Code and its forks (Cursor, Windsurf/Devin
Desktop, VSCodium), built in this repository from the desktop app's code. This document records
where the code that extension needs touches Electron, the ports that now separate the two, how
the boundary is enforced, what the editors' runtime means for SQLite, and the design notes for
the extension itself.

Phases:

| Phase | Content                                                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------------------------------- |
| 1     | **This change.** Core usable without Electron, desktop behaviour unchanged.                                                |
| 2     | Extension MVP: connections tree, run SQL from `.sql` files, editable results webview, production guard, SSH, editor theme. |
| 3     | Table designer, `.vqb` backups/restore, MongoDB documents, structure-only schema for the editor's AI.                      |
| 4     | Publish to the Visual Studio Marketplace and Open VSX.                                                                     |

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

It registers the `connections:*`, `db:*`, `sqlite:*`, `mongo:*`, `filters:*`, `backups:*` and
`ai:*` channels (`core.channels()`), none of the desktop-only ones. The SQLite spawner, the AI
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

## 9. Phase 2 design notes (no code yet)

### 9.1 Layout and build

```
extensions/vscode/
  package.json       name "vortaq", displayName "Vortaq", publisher, engines.vscode ^1.123.0,
                     main ./dist/extension.cjs, contributes (views, commands, configuration)
  tsconfig.json      paths @shared/* and @main/* to ../../src/…, @core to ../../src/core
  esbuild.mjs        bundles src/extension.ts (+ the core) and the SQLite worker into dist/
  src/extension.ts   activate/deactivate; tree, SQL documents, webview panels
  webview/           Vite build of the Vue views for webviews (reuses src/renderer components)
  README.md  CHANGELOG.md  LICENSE  icon.png  .vscodeignore
```

- **A separate npm project, not a workspace member** (section 6). Its `package.json` lists only
  build tools (`@types/vscode`, `esbuild`, `@vscode/vsce`, `ovsx`, the extension test runner).
  Its esbuild step resolves the runtime packages (`mysql2`, `pg`, `pg-cursor`, `mongodb`,
  `bson`, `ssh2`, parsers) from the root `node_modules` (`nodePaths`), so the desktop app and the
  extension always ship the same versions and there is one lockfile for runtime code.
- **One bundle per entry:** `dist/extension.cjs` (CommonJS, platform node, `vscode` external)
  and `dist/sqliteWorker.cjs` (`src/main/sqlite/nodeWorker.ts`, as `scripts/core-bundle.mjs`
  builds it). The VSIX ships `dist/` only (`vsce package --no-dependencies`).
- **Native and optional modules stay out**, as in `electron-builder.yml`: `ssh2`'s optional
  `cpu-features` and `sshcrypto.node` (it falls back to pure JS) and the MongoDB driver's
  optional modules (`kerberos`, `snappy`, `@mongodb-js/zstd`, `mongodb-client-encryption`,
  `@aws-sdk/credential-providers`, …) are marked external; the driver requires them lazily
  inside try/catch. `plist` and `@noble/*` are inlined (ESM-only).
- **Licences:** generate the extension's third-party notices from the bundle's inputs with
  `scripts/third-party-licenses.mjs` (or its functions) and ship them in the VSIX.
- **Packaging and publishing (phase 4):** `vsce package` / `vsce publish` (Visual Studio
  Marketplace, Azure DevOps publisher and token) and `ovsx publish` (Open VSX, Eclipse account
  and namespace), which is the registry VSCodium, Cursor and Devin Desktop read. Same
  `--publish never` discipline as the desktop: the release script builds and verifies; uploads
  are a separate, explicit step.

### 9.2 Activation wiring

```ts
export async function activate(context: vscode.ExtensionContext) {
  let key = await context.secrets.get('vortaq.vaultKey')
  if (!key) await context.secrets.store('vortaq.vaultKey', (key = newVaultKey()))
  const output = vscode.window.createOutputChannel('Vortaq', { log: true })
  const core = createCore({
    dataDir: context.globalStorageUri.fsPath,
    secrets: { codec: keyCodec(key), codecName: 'vaultKey' },
    sqliteSpawner: sqliteRuntimeProblem()
      ? undefined
      : nodeSqliteSpawner(context.asAbsolutePath('dist/sqliteWorker.cjs')),
    emit: (channel, payload) => panels.broadcast(channel, payload),
    log: { sink: (e) => output[e.level](`[${e.scope}] ${e.message}`) }
  })
  context.subscriptions.push({ dispose: () => void core.dispose() })
}
```

- `deactivate` (and the disposable above) closes every connection, tunnel and SQLite worker.
- If SecretStorage loses the key (a reset keychain), stored passwords no longer decrypt: the
  extension asks for them again (as the desktop's secret migration does for the passwords it
  cannot decrypt, `passwordsToReenter`) and replaces the key. On Linux, VS Code's SecretStorage
  depends on the system keyring (`password-store`); without one it may fall back to a weaker
  store, which the extension's README must say.
- The vault key never reaches `credentials.json`, a log, a webview or a message.

### 9.3 Webview bridge on the typed IPC map

The renderer only talks to main through `window.vortaq` (`VortaqApi`: `platform`, `invoke`,
`on`), wrapped by `src/renderer/src/api.ts`. A webview can provide the same object, so the Vue
views and components run unchanged:

- **Webview side** (a small script loaded before the Vue bundle): `window.vortaq.invoke(channel,
...args)` posts `{ type: 'invoke', id, channel, args }` through `acquireVsCodeApi()` and resolves
  or rejects when `{ type: 'result', id, ok, value | message }` arrives; `on(event, listener)`
  subscribes to `{ type: 'event', channel, payload }` messages.
- **Extension side:** `webview.onDidReceiveMessage` checks the channel against an allowlist per
  panel (the core channels the view needs, never `app:*` or `settings:*` as such), calls
  `core.invoke`, and posts the result or the error **message only** (runHandler already strips
  the rest). `CoreOptions.emit` forwards `event:*` to the panels that subscribed.
- **Same trust model as the renderer:** the webview is untrusted UI; every guard stays where it is
  (handlers in main). The extension must never add `confirmProduction: true` on its own.
- **Serialisation:** Electron IPC uses structured clone, webview messages are JSON. Before reusing
  a view, check that its channels' results are JSON-safe (no `Date`, `Map`, `Set`, `bigint`,
  `Uint8Array`, or `undefined` holes); binary cells already travel as `0x…` text and MongoDB
  values as canonical EJSON. Add a JSON round-trip assertion to the core integration test when the
  first view is wired.
- Views that need desktop chrome (window controls, Electron-only dialogs) get small adapters
  behind the same `useEngineUi`/composable seams; dialogs map to `vscode.window` pickers.
- Webviews use a strict CSP with a nonce, `localResourceRoots` limited to `dist/webview`, and
  `retainContextWhenHidden` only for the results panel if needed.

### 9.4 Theming

The renderer's design tokens are CSS variables (`--nd-*`, `src/renderer/src/styles/tokens.css`,
dark on `:root` and `.v-theme--vortaqDark`, light on `.v-theme--vortaqLight`). VS Code exposes
the editor theme to webviews as `--vscode-*` variables and a body class (`vscode-dark`,
`vscode-light`, `vscode-high-contrast`, `vscode-high-contrast-light`). A `vscode-theme.css`
loaded after `tokens.css` re-declares the tokens from the editor's:

| Token                                                  | From                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `--nd-bg-app`                                          | `--vscode-editor-background`                                                                      |
| `--nd-bg-panel`                                        | `--vscode-sideBar-background` (fallback `--vscode-editor-background`)                             |
| `--nd-bg-raised`                                       | `--vscode-editorWidget-background`                                                                |
| `--nd-bg-sunken`, `--nd-bg-input`                      | `--vscode-input-background`                                                                       |
| `--nd-text`                                            | `--vscode-foreground`                                                                             |
| `--nd-text-muted`, `--nd-text-2`                       | `--vscode-descriptionForeground`                                                                  |
| `--nd-text-disabled`                                   | `--vscode-disabledForeground`                                                                     |
| `--nd-border`, `--nd-hairline`                         | `--vscode-panel-border` / `--vscode-widget-border`                                                |
| `--nd-border-strong`                                   | `--vscode-contrastBorder` (high contrast), else `--vscode-focusBorder`                            |
| `--nd-accent`, `--nd-on-accent`                        | `--vscode-button-background`, `--vscode-button-foreground`                                        |
| `--nd-hover`                                           | `--vscode-list-hoverBackground`                                                                   |
| `--nd-selected`, `--nd-selected-strong`                | `--vscode-list-inactiveSelectionBackground`, `--vscode-list-activeSelectionBackground`            |
| `--nd-selection`                                       | `--vscode-editor-selectionBackground`                                                             |
| `--nd-error`, `--nd-warning`, `--nd-info`              | `--vscode-errorForeground`, `--vscode-editorWarning-foreground`, `--vscode-editorInfo-foreground` |
| `--nd-success`                                         | `--vscode-testing-iconPassed`                                                                     |
| `--nd-scrollbar`, `--nd-scrollbar-hover`               | `--vscode-scrollbarSlider-background`, `--vscode-scrollbarSlider-hoverBackground`                 |
| `--nd-font-ui`, `--nd-fs-base`                         | `--vscode-font-family`, `--vscode-font-size`                                                      |
| `--nd-font-mono`                                       | `--vscode-editor-font-family`                                                                     |
| `--nd-glass*`, `--nd-glow*`, `--nd-nebula*`, gradients | flat values (no blur or glow inside the editor)                                                   |

Vuetify's theme colours are hex values (`src/renderer/src/plugins/vuetify.ts`): at start-up and
on every body-class change (a `MutationObserver`), read the computed `--vscode-*` values, pick
`vortaqDark` or `vortaqLight`, and update the theme's colours. The `nd-` prefix stays (CLAUDE.md).
"Editor theme" in phase 2 means exactly this: the webviews follow the editor's colours and fonts;
`.sql` documents use the editor itself.

### 9.5 SQL documents, guard UX, SSH, remote

- **`.sql` files:** a status-bar item chooses the connection and database of the active document
  (stored per document URI in `workspaceState`); «Ejecutar» runs the selection, the statement under
  the cursor (the connection's dialect `splitStatements`) or the whole file through `db:execute`,
  with an `executionId` so «Cancelar» can call `db:cancel`; results open in the results webview
  (the query result grid, editable where `resultEditability` allows).
- **Production guard:** before a write the extension asks with the dialect's `analyzeWrites`
  (renderer allowlist, the same decision the desktop UI makes) and shows a typed confirmation
  (`window.showInputBox` that must match the connection name, the `requiresTypedConfirm`
  environments from settings); only then it sends `confirmProduction: true`. Main still enforces
  it with the denylist, so a missed prompt fails closed with the usual message.
- **SSH:** the tunnel is `ssh2` in pure JS and needs nothing from Electron; private-key paths are
  validated by `connectionSaveError` with the host's `process.platform`.
- **Remote development:** declare `extensionKind: ["ui", "workspace"]`: by default it runs next to
  the editor UI (databases reachable from the user's machine, the OS keychain for SecretStorage);
  on a remote host it can run there when the database is only reachable from it. On Cursor's
  remote server (Node 20) SQLite is unavailable and `sqliteRuntimeProblem` says so.

### 9.6 Connection import from the desktop app (without passwords)

«Importar conexiones de Vortaq» reads the desktop profile's `connections.json` only when the
user runs the command (default `<appData>/Vortaq`, or a file the user picks), assigns new ids,
and never reads `credentials.json`: passwords are typed again and stored in the extension's
vault. The desktop app is the same product, but its secrets stay where they are, as the
extension's never reach the desktop. The `.ncx` importer (`src/main/importers/connections/`,
Electron-free) can run in the extension later for a file the user picks.

### 9.7 Naming

- Name **«Vortaq»**, description **«Cliente de bases de datos para VS Code»**. "VS Code" and
  "Visual Studio Code" stay out of the name (Microsoft's trademark guidance for extensions); the
  description only states compatibility.
- Publisher and namespace to register before phase 4 (Marketplace publisher, Open VSX namespace),
  e.g. `y0rshb3.vortaq`. Command and setting ids use the `vortaq.` prefix.
- UI texts in Spanish, code and comments in English, as in the desktop app.

### 9.8 Testing in phase 2

- Keep `scripts/core-bundle.test.ts` and `coreNode.test.ts` as the gates for the core.
- Extension tests with `@vscode/test-electron` (downloads a VS Code build) for activation, the
  tree and the bridge; they are not part of the desktop gate.
- A smoke that packages the VSIX and checks it contains `dist/extension.cjs`,
  `dist/sqliteWorker.cjs` and the notices, and no `.node` binaries.

## 10. Left for phase 2

- The extension package itself (sections 9.1–9.8).
- `settings:get`/`settings:update` live in `ipc/app.ts` with Electron-only handlers; if the
  webviews need them, move those two handlers to an Electron-free module first.
- JSON-safety check of every result type used by the first webview.
- Decide whether the extension contributes the AI context as a Language Model tool (phase 3);
  it must reuse the structure-only readers (`MetadataQueryable`, `PgMetadataQueryable`,
  `SqliteMetadataQueryable`, `MongoStructureSource`) and never send rows.
- The SQLite fallback of section 8, only if users on older or remote hosts ask for it.

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
