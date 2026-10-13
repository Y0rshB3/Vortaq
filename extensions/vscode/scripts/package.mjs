/**
 * Builds the extension (without source maps) and packages it as
 * extensions/vscode/vortaq-<version>.vsix with `vsce package --no-dependencies`: the bundles in
 * dist/ already contain every runtime package. Before packaging it checks the file list:
 * the bundles, the notices and the icons must be there; source maps, TypeScript sources,
 * tests, fixtures, node_modules, native binaries and anything that looks like a secret must not.
 *
 *   node extensions/vscode/scripts/package.mjs     (npm run ext:package)
 *
 * Packaging never publishes: uploading to a marketplace is a separate, explicit step (phase 4).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildExtension, EXT } from './build.mjs'

const REQUIRED = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'media/vortaq.svg',
  'dist/extension.cjs',
  'dist/sqliteWorker.cjs',
  'dist/icon.png',
  'dist/THIRD_PARTY_NOTICES.txt',
  'dist/webview/connection.js',
  'dist/webview/connection.css',
  'dist/webview/results.js',
  'dist/webview/results.css',
  'dist/webview/mdi.css',
  'dist/webview/assets/materialdesignicons-webfont.woff2'
]
const FORBIDDEN = [
  /\.map$/,
  /\.tsx?$/,
  /\.vue$/,
  /(^|\/)node_modules\//,
  /(^|\/)test\//,
  /(^|\/)fixtures\//,
  /\.node$/,
  /credentials\.json$/,
  /\.(pem|key|p12|keychain(-db)?)$/,
  /(^|\/)\.env/
]

function vsce(args) {
  const bin = join(EXT, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce')
  if (!existsSync(bin)) throw new Error('Falta @vscode/vsce: ejecuta antes `npm run ext:install`.')
  const result = spawnSync(bin, args, {
    cwd: EXT,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0)
    throw new Error(`vsce ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

async function main() {
  await buildExtension({ dev: false })
  const files = vsce(['ls', '--no-dependencies'])
    .split('\n')
    .map((l) => l.trim().replace(/\\/g, '/'))
    .filter(Boolean)
  const missing = REQUIRED.filter((f) => !files.includes(f))
  const forbidden = files.filter((f) => FORBIDDEN.some((re) => re.test(f)))
  if (missing.length || forbidden.length)
    throw new Error(
      `VSIX contents check failed.${missing.length ? `\nMissing: ${missing.join(', ')}` : ''}${forbidden.length ? `\nMust not ship: ${forbidden.join(', ')}` : ''}`
    )
  const { version } = JSON.parse(readFileSync(join(EXT, 'package.json'), 'utf8'))
  const out = join(EXT, `vortaq-${version}.vsix`)
  vsce(['package', '--no-dependencies', '--out', out])
  const kb = (statSync(out).size / 1024).toFixed(0)
  console.log(`[ext] ${out} (${kb} KB, ${files.length} files)`)
  for (const f of files) console.log(`  ${f}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
