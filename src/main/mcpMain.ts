/**
 * `Vortaq --mcp`: the headless MCP server an agent launches over stdio
 * (src/main/mcp holds the Electron-free server). It works while the desktop
 * app is closed and while it is open:
 *
 * - no window, menu, tray, scheduler, launchd, update check, tour, profile or
 *   secret migration, and no Dock icon on macOS;
 * - the desktop profile (VORTAQ_USER_DATA or <appData>/Vortaq) is only read:
 *   connections, settings and secrets are read again on every call and never
 *   written; Chromium's own data goes to a scratch folder (Windows keeps
 *   safeStorage's key in <profile>/Local State, so there userData stays the profile);
 * - stdout carries only JSON-RPC (mcpStdio.ts); logs go to <profile>/logs/mcp.log
 *   and warnings to stderr;
 * - stdin closing, SIGTERM or SIGINT close every connection, SSH tunnel and
 *   SQLite worker, then the process exits.
 */
import { app } from 'electron'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readEnvSwitches } from './bootstrap'
import { APP_NAME, MCP_LOG_FILE_NAME } from './brand'
import { plainCodec, type SecretCodec } from './credentials/store'
import { electronCodec } from './credentials/electronCodec'
import { envVar } from './env'
import { configureLog, getLogger } from './log'
import { createMcpContext } from './mcp/context'
import { mcpProfileProblem } from './mcp/profile'
import { McpRuntime } from './mcp/runtime'
import { createMcpServer } from './mcp/server'
import { mcpStdout } from './mcpStdio'
import { electronSqliteSpawner } from './sqlite/electronSpawner'
import { setSqliteSpawner } from './sqlite/spawner'
import { setJsonStoreReadOnly, setJsonStoreReload } from './storage/jsonStore'

const NO_KEYRING =
  'No se pueden descifrar las contraseñas guardadas: el llavero del sistema no está disponible para este proceso. Abre Vortaq una vez y vuelve a intentarlo.'

/**
 * Codec of credentials.json chosen on first use (safeStorage needs a ready
 * app and, on macOS, may ask for keychain access the first time).
 */
function profileCodec(profileDir: string, plainSecrets: boolean): SecretCodec {
  let chosen: SecretCodec | null = null
  const pick = (): SecretCodec => {
    if (chosen) return chosen
    let stored: unknown = null
    try {
      stored = JSON.parse(readFileSync(join(profileDir, 'credentials.json'), 'utf8'))?.codec
    } catch {
      /* no secrets saved yet */
    }
    if (plainSecrets || stored === 'plain') chosen = plainCodec
    else {
      try {
        chosen = electronCodec()
      } catch {
        throw new Error(NO_KEYRING)
      }
    }
    return chosen
  }
  return {
    encrypt: () => {
      throw new Error('El modo para agentes no guarda contraseñas.')
    },
    decrypt: (cipher) => pick().decrypt(cipher)
  }
}

export async function runMcpMode(): Promise<void> {
  app.setName(APP_NAME)
  const switches = readEnvSwitches()
  const appData = app.getPath('appData')
  const profileDir = switches.userDataPath ?? join(appData, APP_NAME)
  const facts = { profileDir, appData, scratch: switches.userDataPath !== null }
  const scratchDir = mkdtempSync(join(tmpdir(), 'vortaq-mcp-'))
  const ready = existsSync(profileDir) && mcpProfileProblem(facts) === null
  // Before 'ready': Chromium must never write into the profile the desktop app uses.
  app.setPath(
    'userData',
    process.platform === 'win32' && ready ? profileDir : join(scratchDir, 'chromium')
  )
  app.setPath('sessionData', join(scratchDir, 'session'))
  app.setPath('crashDumps', join(scratchDir, 'crashes'))
  app.disableHardwareAcceleration()
  if (process.platform === 'darwin') app.dock?.hide()

  configureLog({
    filePath: existsSync(profileDir) ? join(profileDir, 'logs', MCP_LOG_FILE_NAME) : null,
    minLevel: envVar('DEBUG') ? 'debug' : 'info'
  })
  const log = getLogger('mcp.main')
  // Several processes share the profile: read again what the app rewrote, never write.
  setJsonStoreReload(true)
  setJsonStoreReadOnly(true)

  await app.whenReady()
  if (process.platform === 'darwin') app.setActivationPolicy('accessory')
  setSqliteSpawner(electronSqliteSpawner)

  const ctx = createMcpContext({
    profileDir,
    secrets: { codec: profileCodec(profileDir, switches.plainSecrets), codecName: 'safeStorage' }
  })
  const runtime = new McpRuntime(ctx, { profileProblem: () => mcpProfileProblem(facts) })
  const server = createMcpServer(runtime, { version: app.getVersion() })
  const transport = new StdioServerTransport(process.stdin, mcpStdout())

  let closing = false
  const shutdown = (reason: string): void => {
    if (closing) return
    closing = true
    log.info(`MCP server stopping (${reason})`)
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000))
    void Promise.race([runtime.dispose(), timeout])
      .catch(() => undefined)
      .finally(() => {
        try {
          rmSync(scratchDir, { recursive: true, force: true })
        } catch {
          /* the temp folder is cleaned by the system */
        }
        app.exit(0)
      })
  }
  process.stdin.on('end', () => shutdown('stdin closed'))
  process.stdin.on('close', () => shutdown('stdin closed'))
  process.stdout.on('error', () => shutdown('stdout closed'))
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(signal, () => shutdown(signal))
  transport.onclose = () => shutdown('transport closed')

  await server.connect(transport)
  const problem = mcpProfileProblem(facts)
  if (problem) log.warn(problem)
  log.info(
    `MCP server ready (version ${app.getVersion()}, agents ${ctx.settings.get().mcpEnabled ? 'allowed' : 'not allowed'} in Ajustes)`
  )
}
