/**
 * Integration tests of the extension inside a real VS Code (`npm run ext:test`): builds the
 * extension and the suite (test/integration/suite.ts), downloads a VS Code build with
 * @vscode/test-electron into a cache folder outside the repository, and runs the suite in its
 * extension host against the test servers of tests/docker-compose.yml:
 *
 *   VORTAQ_TEST_MYSQL_URL  mysql://root:navidog@127.0.0.1:33306/navidog_test
 *   VORTAQ_TEST_PG_URL     postgres://postgres:navidog@127.0.0.1:55432/navidog_test
 *   VORTAQ_TEST_MONGO_URL  mongodb://root:navidog@127.0.0.1:57017/?authSource=admin
 *
 * A server without its URL is skipped; `--required` makes a missing URL fail the run (like
 * `npm run test:integration:required`). SQLite needs no server (a file in a scratch folder).
 *
 * VS Code runs with a scratch profile and extensions folder, in-memory SecretStorage (no
 * keychain item is created), no other extensions and no workspace trust prompt. On macOS a
 * window opens while the suite runs.
 *
 *   VORTAQ_VSCODE_TEST_CACHE    where VS Code builds are cached
 *                               (default: ~/Library/Caches/vortaq-vscode-test on macOS,
 *                               %LOCALAPPDATA%\vortaq-vscode-test on Windows, ~/.cache/… elsewhere)
 *   VORTAQ_VSCODE_TEST_VERSION  VS Code version to download (default: stable)
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildExtension, DIST_TEST, EXT } from './build.mjs'

const SERVERS = [
  ['VORTAQ_TEST_MYSQL_URL', 'MySQL'],
  ['VORTAQ_TEST_PG_URL', 'PostgreSQL'],
  ['VORTAQ_TEST_MONGO_URL', 'MongoDB']
]

export function cacheFolder() {
  const override = process.env.VORTAQ_VSCODE_TEST_CACHE?.trim()
  if (override) return override
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Caches', 'vortaq-vscode-test')
  if (process.platform === 'win32')
    return join(
      process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
      'vortaq-vscode-test'
    )
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'vortaq-vscode-test')
}

async function main(argv) {
  const required = argv.includes('--required')
  const missing = SERVERS.filter(([env]) => !process.env[env]?.trim())
  if (missing.length && required)
    throw new Error(`Faltan servidores de prueba: ${missing.map(([env]) => env).join(', ')}`)
  for (const [env, label] of missing) console.log(`[ext:test] ${label}: sin ${env}, se omite`)

  let testElectron
  try {
    testElectron = await import('@vscode/test-electron')
  } catch {
    throw new Error('Falta @vscode/test-electron: ejecuta antes `npm run ext:install`.')
  }
  await buildExtension({ dev: true, tests: true })

  const cachePath = cacheFolder()
  mkdirSync(cachePath, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'vortaq-ext-it-'))
  const workspace = join(scratch, 'workspace')
  mkdirSync(workspace, { recursive: true })
  // The desktop profile the import test reads: a copy of the synthetic fixture.
  const desktopProfile = join(scratch, 'desktop-profile')
  cpSync(join(EXT, 'test', 'fixtures', 'desktop-profile'), desktopProfile, { recursive: true })
  try {
    const vscodeExecutablePath = await testElectron.downloadAndUnzipVSCode({
      version: process.env.VORTAQ_VSCODE_TEST_VERSION?.trim() || 'stable',
      cachePath
    })
    console.log(`[ext:test] VS Code: ${vscodeExecutablePath}`)
    await testElectron.runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: EXT,
      extensionTestsPath: join(DIST_TEST, 'suite.cjs'),
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--user-data-dir',
        join(scratch, 'user-data'),
        '--extensions-dir',
        join(scratch, 'extensions'),
        '--use-inmemory-secretstorage',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-telemetry',
        '--disable-updates',
        '--disable-gpu'
      ],
      extensionTestsEnv: {
        VORTAQ_EXT_IT_SCRATCH: scratch,
        VORTAQ_TEST_DESKTOP_PROFILE: desktopProfile,
        ...Object.fromEntries(SERVERS.map(([env]) => [env, process.env[env] ?? '']))
      }
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
