/**
 * Agents (MCP): the rules shared by main (src/main/mcp, the `--mcp` process),
 * the connection dialog and Ajustes › Agentes (MCP). Pure: no Node, Electron
 * or browser imports.
 *
 * A connection exists for an agent only when its `mcp.enabled` is true AND
 * the global switch (AppSettings.mcpEnabled) is on. «Lectura y escritura» is
 * never effective on a connection whose environment needs the typed
 * confirmation: the dialog disables it and the MCP process re-checks it on
 * every call (the environment, or Ajustes › Seguridad, may change later).
 */
import { requiresTypedConfirm } from './typedConfirm'
import type {
  ConnectionConfig,
  ConnectionMcpConfig,
  Environment,
  McpAccess,
  McpLaunchInfo
} from './types'

/** Command-line switch of the MCP mode (`Vortaq --mcp`). */
export const MCP_ARG = '--mcp'

/** Name the snippets give the server in each client's configuration. */
export const MCP_SERVER_NAME = 'vortaq'

export const MCP_ACCESS_LEVELS: readonly McpAccess[] = ['structure', 'read', 'write']

/** Level a connection starts with when it is made available. */
export const DEFAULT_MCP_ACCESS: McpAccess = 'read'

export const MCP_ACCESS_LABELS: Record<McpAccess, string> = {
  structure: 'Solo estructura',
  read: 'Lectura',
  write: 'Lectura y escritura'
}

export const MCP_ACCESS_HINTS: Record<McpAccess, string> = {
  structure:
    'Bases de datos, tablas, columnas, tipos, claves e índices. Nunca se envía el contenido de las filas.',
  read: 'Estructura y consultas de solo lectura, con límite de filas y en una sesión que no puede escribir.',
  write:
    'También modificaciones de datos y DDL. No disponible en conexiones que piden escribir el nombre para confirmar.'
}

export const MCP_WRITE_BLOCKED =
  '«Lectura y escritura» no está disponible en las conexiones que piden escribir el nombre para confirmar (Producción y los entornos elegidos en Ajustes › Seguridad).'

export const MCP_PRIVACY_NOTE =
  'Vortaq nunca envía la configuración de la conexión (contraseña, host, puerto, usuario, túnel SSH, ruta del archivo), tampoco en los errores. Con «Lectura» o «Lectura y escritura», el agente ejecuta consultas cuyos resultados llegan a su proveedor de IA y muestran lo que el usuario de la base de datos puede ver, incluido lo que el servidor dice de sí mismo (p. ej. CURRENT_USER, @@hostname o inet_server_addr()). Con «Solo estructura» no se envía ningún resultado de consultas.'

export function isMcpAccess(value: unknown): value is McpAccess {
  return typeof value === 'string' && (MCP_ACCESS_LEVELS as readonly string[]).includes(value)
}

/**
 * The stored setting as Vortaq reads it. Missing: undefined (off). Anything
 * malformed (not an object, unknown level) is off, never a guess.
 */
export function normalizeMcpConfig(value: unknown): ConnectionMcpConfig | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value))
    return { enabled: false, access: DEFAULT_MCP_ACCESS }
  const raw = value as { enabled?: unknown; access?: unknown }
  if (!isMcpAccess(raw.access)) return { enabled: false, access: DEFAULT_MCP_ACCESS }
  return { enabled: raw.enabled === true, access: raw.access }
}

/** The connection is available to agents (its own switch; the global one is checked apart). */
export function isMcpEnabled(connection: Pick<ConnectionConfig, 'mcp'>): boolean {
  return normalizeMcpConfig(connection.mcp)?.enabled === true
}

/** Writes from agents are never allowed in this environment (typed confirmation). */
export function mcpWriteBlocked(
  environment: Environment | null | undefined,
  typedConfirmEnvironments: readonly Environment[] | null | undefined
): boolean {
  return requiresTypedConfirm(environment, typedConfirmEnvironments)
}

/**
 * What an agent may actually do with `connection` now: null when it is not
 * available, and 'read' instead of 'write' when its environment needs the
 * typed confirmation.
 */
export function effectiveMcpAccess(
  connection: Pick<ConnectionConfig, 'mcp' | 'environment'>,
  typedConfirmEnvironments: readonly Environment[] | null | undefined
): McpAccess | null {
  const config = normalizeMcpConfig(connection.mcp)
  if (!config?.enabled) return null
  if (
    config.access === 'write' &&
    mcpWriteBlocked(connection.environment, typedConfirmEnvironments)
  )
    return 'read'
  return config.access
}

/**
 * Problem of a connection form's MCP section, or null. Saving «Lectura y
 * escritura» for an environment that needs the typed confirmation is refused.
 */
export function mcpConfigError(
  input: Pick<ConnectionConfig, 'mcp' | 'environment'>,
  typedConfirmEnvironments: readonly Environment[] | null | undefined
): string | null {
  const config = normalizeMcpConfig(input.mcp)
  if (!config?.enabled || config.access !== 'write') return null
  return mcpWriteBlocked(input.environment, typedConfirmEnvironments) ? MCP_WRITE_BLOCKED : null
}

/* ---------- how a client starts `Vortaq --mcp` ---------- */

export interface McpLaunchFacts {
  /** process.execPath */
  execPath: string
  /** app.isPackaged */
  packaged: boolean
  /** app.getAppPath(): the source folder when not packaged. */
  appPath: string
  platform: string
  /** $APPIMAGE: the AppImage file (process.execPath is its temporary mount). */
  appImage?: string | null
}

/**
 * The command a client runs: the installed executable (the AppImage file on
 * Linux), or Electron plus the source folder in a development checkout.
 */
export function mcpLaunchOf(facts: McpLaunchFacts): McpLaunchInfo {
  if (!facts.packaged)
    return {
      command: facts.execPath,
      args: [facts.appPath, MCP_ARG],
      platform: facts.platform,
      packaged: false
    }
  const appImage = facts.platform === 'linux' ? facts.appImage?.trim() : ''
  return {
    command: appImage || facts.execPath,
    args: [MCP_ARG],
    platform: facts.platform,
    packaged: true
  }
}

/**
 * Quotes one argument for the shell the snippet is pasted in: PowerShell/cmd
 * on Windows, a POSIX shell elsewhere. `always` quotes plain words too.
 */
export function shellQuote(arg: string, platform: string, always = false): string {
  if (!always && arg !== '' && /^[\w@%+=:,./-]+$/.test(arg)) return arg
  if (platform === 'win32') return `"${arg.replace(/"/g, '\\"')}"`
  return `"${arg.replace(/(["\\$`])/g, '\\$1')}"`
}

/** `claude mcp add vortaq -- "<path>" --mcp` (Claude Code). */
export function claudeCodeCommand(launch: McpLaunchInfo): string {
  // The executable is always quoted: paths with spaces are the rule on macOS and Windows.
  const parts = [launch.command, ...launch.args].map((a, i) =>
    shellQuote(a, launch.platform, i === 0)
  )
  return `claude mcp add ${MCP_SERVER_NAME} -- ${parts.join(' ')}`
}

const json = (value: unknown): string => JSON.stringify(value, null, 2)

/** claude_desktop_config.json (Claude Desktop). */
export function claudeDesktopConfig(launch: McpLaunchInfo): string {
  return json({ mcpServers: { [MCP_SERVER_NAME]: { command: launch.command, args: launch.args } } })
}

/** .cursor/mcp.json or ~/.cursor/mcp.json (Cursor). */
export function cursorConfig(launch: McpLaunchInfo): string {
  return json({
    mcpServers: {
      [MCP_SERVER_NAME]: { type: 'stdio', command: launch.command, args: launch.args }
    }
  })
}

/** .vscode/mcp.json (VS Code): servers in a top-level `servers` object. */
export function vscodeConfig(launch: McpLaunchInfo): string {
  return json({
    servers: { [MCP_SERVER_NAME]: { type: 'stdio', command: launch.command, args: launch.args } }
  })
}

export interface McpClientSnippet {
  id: 'claudeCode' | 'claudeDesktop' | 'cursor' | 'vscode'
  label: string
  /** Where it goes. */
  where: string
  text: string
}

/** Every client snippet for this computer, in the order Ajustes shows them. */
export function mcpClientSnippets(launch: McpLaunchInfo): McpClientSnippet[] {
  const win = launch.platform === 'win32'
  const desktopFile = win
    ? '%APPDATA%\\Claude\\claude_desktop_config.json'
    : launch.platform === 'darwin'
      ? '~/Library/Application Support/Claude/claude_desktop_config.json'
      : 'claude_desktop_config.json (Ajustes › Desarrollador › Editar configuración)'
  return [
    {
      id: 'claudeCode',
      label: 'Claude Code',
      where: 'Terminal (añade --scope user antes de «vortaq» para todos tus proyectos)',
      text: claudeCodeCommand(launch)
    },
    {
      id: 'claudeDesktop',
      label: 'Claude Desktop',
      where: desktopFile,
      text: claudeDesktopConfig(launch)
    },
    {
      id: 'cursor',
      label: 'Cursor',
      where: '.cursor/mcp.json del proyecto o ~/.cursor/mcp.json',
      text: cursorConfig(launch)
    },
    {
      id: 'vscode',
      label: 'VS Code',
      where: '.vscode/mcp.json del proyecto',
      text: vscodeConfig(launch)
    }
  ]
}

/** True when the process was started in MCP mode (`--mcp` anywhere in argv). */
export function isMcpArgv(argv: readonly string[]): boolean {
  return argv.includes(MCP_ARG)
}
