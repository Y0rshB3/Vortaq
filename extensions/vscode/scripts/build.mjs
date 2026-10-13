/**
 * Builds the Vortaq extension into extensions/vscode/dist
 * (docs/vscode-extension-design.md, "Layout and build"):
 *
 *   dist/extension.cjs           extension host code + Vortaq's core + the drivers (esbuild, CJS)
 *   dist/sqliteWorker.cjs        SQLite child process for nodeSqliteSpawner (esbuild, CJS)
 *   dist/webview/<view>.js|.css  connection form and results webviews (Vite: Vue + Vuetify,
 *                                reusing the desktop renderer's components; one IIFE per view)
 *   dist/webview/mdi.css         the Material Design Icons the views use, woff2 only
 *   dist/icon.png                Marketplace icon (build/icons)
 *   dist/THIRD_PARTY_NOTICES.txt licences of every package the bundles contain
 *
 *   node extensions/vscode/scripts/build.mjs [--dev] [--tests]
 *     --dev    no minification, inline source maps (never packaged: package.mjs builds without)
 *     --tests  also bundles the integration suite into extensions/vscode/dist-test/
 *
 * The runtime packages (mysql2, pg, mongodb, ssh2, vue, vuetify…) come from the repository's
 * root node_modules, so the desktop app and the extension ship the same versions. Nothing
 * Electron-only may reach a bundle: the boundary plugins below fail the build, like
 * scripts/core-bundle.mjs does for the core.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import {
  DESKTOP_ONLY_DIRS,
  DESKTOP_ONLY_FILES,
  ELECTRON_PACKAGES
} from '../../../scripts/core-bundle.mjs'
import { describePackage, renderPackage } from '../../../scripts/third-party-licenses.mjs'

export const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const ROOT = resolve(EXT, '..', '..')
export const DIST = join(EXT, 'dist')
export const DIST_TEST = join(EXT, 'dist-test')
const WEBVIEWS = ['connection', 'results']

const posix = (p) => p.split(sep).join('/')
const rel = (p) => posix(relative(ROOT, p))

const ALIAS = {
  '@core': join(ROOT, 'src/core/index.ts'),
  '@shared': join(ROOT, 'src/shared'),
  '@main': join(ROOT, 'src/main'),
  '@renderer': join(ROOT, 'src/renderer/src')
}

/**
 * Renderer modules the extension host may use: pure TypeScript with no DOM, Vue or store
 * code at run time (the destructive-statement check of «Confirmar antes de borrar»).
 */
const HOST_RENDERER_FILES = ['src/renderer/src/components/query/destructiveGuard.ts']

/**
 * Optional modules of the drivers that are not shipped (as in electron-builder.yml): each one
 * is required lazily inside try/catch, so the driver works without it (ssh2 falls back to pure
 * JS; MongoDB without Kerberos, AWS auth, client-side encryption, snappy or zstd).
 */
const OPTIONAL_EXTERNALS = [
  '*.node',
  'cpu-features',
  'kerberos',
  '@mongodb-js/zstd',
  '@mongodb-js/kerberos',
  'snappy',
  'mongodb-client-encryption',
  '@aws-sdk/credential-providers',
  'gcp-metadata',
  'socks',
  'aws4',
  'pg-native',
  'pg-cloudflare'
]

function hostBoundary() {
  return {
    name: 'vortaq-extension-boundary',
    setup(b) {
      b.onResolve({ filter: /^electron(-updater)?($|\/)/ }, (args) =>
        ELECTRON_PACKAGES.some((p) => args.path === p || args.path.startsWith(`${p}/`))
          ? {
              errors: [
                {
                  text: `"${args.path}" is Electron-only: the extension must not import it (from ${rel(args.importer)})`
                }
              ]
            }
          : undefined
      )
      b.onLoad({ filter: /.*/ }, (args) => {
        const file = rel(args.path)
        if (DESKTOP_ONLY_FILES.includes(file))
          return { errors: [{ text: `${file} is desktop-only: the extension must not load it` }] }
        const dir = DESKTOP_ONLY_DIRS.find((d) => file.startsWith(d))
        if (dir && !HOST_RENDERER_FILES.includes(file))
          return {
            errors: [
              { text: `${file} is desktop-only (${dir}): the extension host must not load it` }
            ]
          }
        return undefined
      })
    }
  }
}

async function bundleHost({ dev, entry, outfile, external = [] }) {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    mainFields: ['module', 'main'],
    conditions: ['node'],
    external: ['vscode', ...OPTIONAL_EXTERNALS, ...external],
    alias: ALIAS,
    minify: !dev,
    keepNames: true,
    sourcemap: dev ? 'inline' : false,
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
    plugins: [hostBoundary()]
  })
  return Object.keys(result.metafile.inputs)
}

/* ---------- webviews (Vite) ---------- */

function webviewBoundary() {
  return {
    name: 'vortaq-webview-boundary',
    enforce: 'pre',
    resolveId(source, importer) {
      if (/^electron(-updater)?($|\/)/.test(source))
        this.error(`"${source}" is Electron-only: a webview must not import it (from ${importer})`)
      return null
    },
    load(id) {
      const file = rel(id.split('?')[0])
      for (const forbidden of ['src/main/', 'src/core/', 'src/preload/'])
        if (file.startsWith(forbidden))
          this.error(`${file}: webviews only use the renderer and shared code`)
      return null
    }
  }
}

async function buildWebview(name, dev, modules) {
  const [{ build: viteBuild }, { default: vue }, { default: vuetify }] = await Promise.all([
    import('vite'),
    import('@vitejs/plugin-vue'),
    import('vite-plugin-vuetify')
  ])
  const output = await viteBuild({
    configFile: false,
    root: EXT,
    logLevel: 'warn',
    mode: dev ? 'development' : 'production',
    plugins: [webviewBoundary(), vue(), vuetify({ autoImport: true })],
    resolve: {
      alias: {
        '@shared': ALIAS['@shared'],
        '@renderer': ALIAS['@renderer'],
        '@ext': join(EXT, 'src')
      }
    },
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
    build: {
      outDir: join(DIST, 'webview'),
      emptyOutDir: false,
      target: 'chrome120',
      minify: !dev,
      sourcemap: dev ? 'inline' : false,
      cssCodeSplit: false,
      assetsInlineLimit: 0,
      reportCompressedSize: false,
      rollupOptions: {
        input: join(EXT, 'src', 'webview', name, 'main.ts'),
        output: {
          format: 'iife',
          inlineDynamicImports: true,
          entryFileNames: `${name}.js`,
          assetFileNames: (info) =>
            (info.names?.[0] ?? info.name ?? '').endsWith('.css')
              ? `${name}.css`
              : 'assets/[name][extname]'
        }
      }
    }
  })
  for (const result of Array.isArray(output) ? output : [output])
    for (const chunk of result.output ?? [])
      if (chunk.type === 'chunk') for (const id of Object.keys(chunk.modules)) modules.add(id)
}

/* ---------- Material Design Icons subset ---------- */

const MDI_NAME = /mdi-[a-z0-9]+(?:-[a-z0-9]+)*/g

function sourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '__tests__') sourceFiles(path, out)
    } else if (/\.(vue|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(path)
  }
  return out
}

/** The icon names the webviews can show: every `mdi-*` in the reused sources and Vuetify's aliases. */
export function usedIconNames() {
  const files = [
    ...sourceFiles(join(ROOT, 'src/renderer/src')),
    ...sourceFiles(join(ROOT, 'src/shared')),
    ...sourceFiles(join(EXT, 'src/webview')),
    join(ROOT, 'node_modules/vuetify/lib/iconsets/mdi.js')
  ]
  const names = new Set()
  for (const file of files)
    for (const m of readFileSync(file, 'utf8').matchAll(MDI_NAME)) names.add(m[0])
  return names
}

function writeMdiSubset(target) {
  const css = readFileSync(join(ROOT, 'node_modules/@mdi/font/css/materialdesignicons.css'), 'utf8')
  const base = /\.mdi:before,\s*\.mdi-set\s*\{[^}]*\}/.exec(css)?.[0]
  if (!base) throw new Error('unexpected @mdi/font CSS layout (base rule not found)')
  const glyphs = new Map()
  for (const m of css.matchAll(
    /\.(mdi-[a-z0-9-]+)::before\s*\{\s*content:\s*"(\\[0-9A-Fa-f]+)";\s*\}/g
  ))
    glyphs.set(m[1], m[2])
  const used = [...usedIconNames()].filter((n) => glyphs.has(n)).sort()
  const rules = used.map((n) => `.${n}::before{content:"${glyphs.get(n)}"}`)
  mkdirSync(join(target, 'assets'), { recursive: true })
  copyFileSync(
    join(ROOT, 'node_modules/@mdi/font/fonts/materialdesignicons-webfont.woff2'),
    join(target, 'assets', 'materialdesignicons-webfont.woff2')
  )
  writeFileSync(
    join(target, 'mdi.css'),
    [
      "/* Material Design Icons (Pictogrammers, Apache License 2.0): the icons Vortaq's views use. */",
      '@font-face{font-family:"Material Design Icons";src:url("assets/materialdesignicons-webfont.woff2") format("woff2");font-weight:normal;font-style:normal;font-display:block}',
      base.replace(/\s+/g, ' '),
      ...rules,
      ''
    ].join('\n')
  )
  return used.length
}

/* ---------- third-party notices ---------- */

/** Package folders (…/node_modules/<name>) of the bundled input files. */
function packageDirs(inputs) {
  const dirs = new Set()
  for (const input of inputs) {
    const path = posix(input.startsWith('/') ? input : join(ROOT, input)).replace(/^\0/, '')
    const at = path.lastIndexOf('/node_modules/')
    if (at < 0) continue
    const rest = path.slice(at + '/node_modules/'.length).split('/')
    const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]
    dirs.add(path.slice(0, at) + '/node_modules/' + name)
  }
  return [...dirs]
}

function writeNotices(inputs, version) {
  const seen = new Map()
  for (const dir of packageDirs(inputs)) {
    if (!existsSync(join(dir, 'package.json'))) continue
    const p = describePackage(dir)
    seen.set(`${p.name}@${p.version}`, p)
  }
  // The icon font is shipped as a file, not imported by a bundle.
  const mdi = describePackage(join(ROOT, 'node_modules/@mdi/font'))
  seen.set(`${mdi.name}@${mdi.version}`, mdi)
  const packages = [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  )
  const head = [
    `Vortaq para VS Code ${version} — Licencias de terceros`,
    '',
    'Vortaq es software libre con licencia MIT (archivo LICENSE). Esta extensión incluye los componentes de código abierto listados a continuación, cada uno con su licencia y su aviso de copyright, tal como los publican sus autores. Los iconos de los motores en el árbol de conexiones son Material Design Icons (Pictogrammers, Apache License 2.0).',
    '',
    `Componentes: ${packages.length}`
  ].join('\n')
  const rule = '='.repeat(78)
  writeFileSync(
    join(DIST, 'THIRD_PARTY_NOTICES.txt'),
    [head, ...packages.map(renderPackage), rule, ''].join('\n\n')
  )
  return packages.length
}

/* ---------- main ---------- */

export async function buildExtension({ dev = false, tests = false } = {}) {
  const started = Date.now()
  rmSync(DIST, { recursive: true, force: true })
  mkdirSync(join(DIST, 'webview'), { recursive: true })
  const version = JSON.parse(readFileSync(join(EXT, 'package.json'), 'utf8')).version

  const hostInputs = await bundleHost({
    dev,
    entry: join(EXT, 'src/extension.ts'),
    outfile: join(DIST, 'extension.cjs')
  })
  const workerInputs = await bundleHost({
    dev,
    entry: join(ROOT, 'src/main/sqlite/nodeWorker.ts'),
    outfile: join(DIST, 'sqliteWorker.cjs')
  })
  const webviewModules = new Set()
  for (const name of WEBVIEWS) await buildWebview(name, dev, webviewModules)
  const icons = writeMdiSubset(join(DIST, 'webview'))
  copyFileSync(join(ROOT, 'build/icons/256x256.png'), join(DIST, 'icon.png'))
  const notices = writeNotices([...hostInputs, ...workerInputs, ...webviewModules], version)

  if (tests) {
    rmSync(DIST_TEST, { recursive: true, force: true })
    await bundleHost({
      dev: true,
      entry: join(EXT, 'test/integration/suite.ts'),
      outfile: join(DIST_TEST, 'suite.cjs')
    })
  }
  const size = (f) => `${(statSync(join(DIST, f)).size / 1024).toFixed(0)} KB`
  console.log(
    `[ext] built in ${((Date.now() - started) / 1000).toFixed(1)} s: extension.cjs ${size('extension.cjs')}, ` +
      `sqliteWorker.cjs ${size('sqliteWorker.cjs')}, ${WEBVIEWS.map((w) => `${w}.js ${size(`webview/${w}.js`)}`).join(', ')}, ` +
      `${icons} icons, ${notices} notices${tests ? ', test suite' : ''}`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  buildExtension({ dev: argv.includes('--dev'), tests: argv.includes('--tests') }).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
