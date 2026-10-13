/* global process, console */
/**
 * The Electron-free core (src/core/index.ts) as a Node bundle, and the check that keeps it
 * Electron-free (docs/vscode-extension-design.md, "Boundary").
 *
 *   node scripts/core-bundle.mjs              check only: bundles in memory, exit 1 on a violation
 *   node scripts/core-bundle.mjs --out <dir>  also writes <dir>/core.cjs and <dir>/sqliteWorker.cjs
 *   npm run check:core                        same as the first form
 *
 * A violation is anything reachable from the entry that imports `electron` (statically or with a
 * dynamic import()), an Electron-only package, or one of the desktop-only files listed below.
 * esbuild leaves `import(variable)` / `require(variable)` alone without a warning, so this check
 * cannot see them: ESLint forbids non-literal imports in the core folders instead.
 * npm packages stay external (the bundle is for Node with the repository's node_modules, or for
 * the extension's own esbuild step), except the ESM-only ones electron.vite.config.ts also inlines.
 */
import { builtinModules } from 'node:module'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CORE_ENTRY = 'src/core/index.ts'
export const SQLITE_WORKER_ENTRY = 'src/main/sqlite/nodeWorker.ts'

/** Packages that only work inside Electron. */
export const ELECTRON_PACKAGES = ['electron', 'electron-updater']

/**
 * Desktop-only files: the Electron adapters of the core's ports and the app shell. Most import
 * `electron` anyway; the list also catches the ones that only use Electron's runtime
 * (sqlite/worker.ts reads Electron's parentPort) and keeps the rule readable in one place.
 */
export const DESKTOP_ONLY_FILES = [
  'src/main/index.ts',
  'src/main/bootstrap.ts',
  'src/main/window.ts',
  'src/main/menu.ts',
  'src/main/screenshots.ts',
  'src/main/services.ts',
  'src/main/ipc/typed.ts',
  'src/main/ipc/register.ts',
  'src/main/ipc/app.ts',
  'src/main/ipc/tour.ts',
  'src/main/ipc/updates.ts',
  'src/main/ipc/importers.ts',
  'src/main/sqlite/electronSpawner.ts',
  'src/main/sqlite/worker.ts',
  'src/main/ai/electronFetch.ts',
  'src/main/credentials/electronCodec.ts'
]

/** Folders the core never reaches: the renderer, the preload and the updater. */
export const DESKTOP_ONLY_DIRS = ['src/renderer/', 'src/preload/', 'src/main/updates/']

/** ESM-only packages inlined like electron.vite.config.ts does, so require() of the bundle works. */
const INLINE_PACKAGES = ['plist', '@noble/curves', '@noble/hashes']

const ALIASES = [
  ['@shared/', 'src/shared/'],
  ['@main/', 'src/main/']
]

const BUILTINS = new Set(builtinModules)

function packageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** The .ts file an extensionless source import points at, or null. */
function sourceFile(absolute) {
  for (const candidate of [absolute, `${absolute}.ts`, join(absolute, 'index.ts')])
    if (candidate.endsWith('.ts') && existsSync(candidate)) return candidate
  return null
}

const posix = (path) => path.split(sep).join('/')

function desktopOnlyReason(file) {
  const rel = posix(relative(ROOT, file))
  if (DESKTOP_ONLY_FILES.includes(rel)) return `${rel} is desktop-only`
  const dir = DESKTOP_ONLY_DIRS.find((d) => rel.startsWith(d))
  return dir ? `${rel} is desktop-only (${dir})` : null
}

function boundaryPlugin() {
  return {
    name: 'vortaq-core-boundary',
    setup(b) {
      const check = (file) => {
        const reason = desktopOnlyReason(file)
        return reason
          ? { errors: [{ text: `${reason}: the core must not import it` }] }
          : { path: file }
      }
      b.onResolve({ filter: /^@(shared|main)\// }, (args) => {
        const [prefix, dir] = ALIASES.find(([p]) => args.path.startsWith(p))
        const file = sourceFile(resolve(ROOT, dir, args.path.slice(prefix.length)))
        if (!file) return { errors: [{ text: `cannot resolve ${args.path}` }] }
        return check(file)
      })
      b.onResolve({ filter: /^\.\.?\// }, (args) => {
        const target = resolve(args.resolveDir, args.path)
        const file = sourceFile(target)
        if (file) return check(file)
        // Not an extensionless .ts import (a .js, .json... file): esbuild resolves it, but a
        // desktop-only path is still refused here, where the importing line is known.
        const reason = desktopOnlyReason(target)
        return reason ? { errors: [{ text: `${reason}: the core must not import it` }] } : undefined
      })
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        const name = packageName(args.path)
        if (ELECTRON_PACKAGES.includes(name))
          return {
            errors: [
              {
                text: `"${args.path}" is Electron-only: the core must not import it (${args.kind})`
              }
            ]
          }
        if (args.path.startsWith('node:') || BUILTINS.has(name))
          return { path: args.path, external: true }
        if (INLINE_PACKAGES.includes(name)) return undefined
        return { path: args.path, external: true }
      })
      // Backstop for anything resolved another way: no desktop-only file is ever loaded.
      b.onLoad({ filter: /.*/ }, (args) => {
        const reason = desktopOnlyReason(args.path)
        return reason ? { errors: [{ text: `${reason}: the core must not load it` }] } : undefined
      })
    }
  }
}

function options(entry, outfile) {
  return {
    absWorkingDir: ROOT,
    entryPoints: [resolve(ROOT, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: outfile ?? join(ROOT, 'out', 'core-check', 'bundle.cjs'),
    write: outfile !== undefined,
    metafile: true,
    logLevel: 'silent',
    plugins: [boundaryPlugin()]
  }
}

const describe = (e) =>
  e.location ? `${posix(e.location.file)}:${e.location.line}: ${e.text}` : e.text

function describeFailure(err) {
  if (!Array.isArray(err?.errors)) throw err
  return err.errors.map(describe)
}

/**
 * Bundles `entry` in memory and reports every boundary violation (with the importing file and
 * line). `inputs` lists the source files the bundle reached (repository-relative).
 */
export async function checkCoreBoundary(entry = CORE_ENTRY) {
  try {
    const result = await build(options(entry))
    const inputs = Object.keys(result.metafile.inputs).map((p) => posix(p))
    return { ok: true, errors: [], inputs }
  } catch (err) {
    return { ok: false, errors: describeFailure(err), inputs: [] }
  }
}

async function bundle(entry, outfile) {
  mkdirSync(dirname(outfile), { recursive: true })
  try {
    await build(options(entry, outfile))
  } catch (err) {
    throw new Error(`core boundary violated:\n${describeFailure(err).join('\n')}`)
  }
  return outfile
}

/** Writes the core bundle (CommonJS, npm packages external) to `outfile`. */
export function bundleCore(outfile) {
  return bundle(CORE_ENTRY, outfile)
}

/** Writes the SQLite child-process worker (nodeWorker.ts) for nodeSqliteSpawner to `outfile`. */
export function bundleSqliteWorker(outfile) {
  return bundle(SQLITE_WORKER_ENTRY, outfile)
}

async function main(argv) {
  const at = argv.indexOf('--out')
  if (at >= 0) {
    const dir = resolve(argv[at + 1] ?? '')
    await bundleCore(join(dir, 'core.cjs'))
    await bundleSqliteWorker(join(dir, 'sqliteWorker.cjs'))
    console.log(`core bundle written to ${dir}`)
    return
  }
  const result = await checkCoreBoundary()
  if (!result.ok) {
    console.error(`core boundary violated:\n${result.errors.join('\n')}`)
    process.exit(1)
  }
  console.log(`core boundary ok: ${result.inputs.length} source files, no Electron imports`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
