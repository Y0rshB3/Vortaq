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

/** A TOML basic string: backslashes, quotes and control characters escaped. */
function tomlString(value: string): string {
  let out = ''
  for (const c of value) {
    const code = c.charCodeAt(0)
    if (c === '\\' || c === '"') out += `\\${c}`
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += c
  }
  return `"${out}"`
}

/**
 * ~/.codex/config.toml (Codex). Codex stops a tool call after 60 s by
 * default; Vortaq lets a query run up to 120 s (`maxTimeoutSec`).
 */
export function codexConfig(launch: McpLaunchInfo): string {
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(launch.command)}`,
    `args = [${launch.args.map(tomlString).join(', ')}]`,
    'tool_timeout_sec = 130'
  ].join('\n')
}

/**
 * Gemini CLI's settings.json and Antigravity's mcp_config.json: the same
 * `mcpServers` shape as Claude Desktop.
 */
export const geminiConfig = claudeDesktopConfig

/** opencode.json (OpenCode): a local server takes the command and its arguments in one array. */
export function opencodeConfig(launch: McpLaunchInfo): string {
  return json({
    mcp: { [MCP_SERVER_NAME]: { type: 'local', command: [launch.command, ...launch.args] } }
  })
}

/** The bare launch facts, for clients without a snippet of their own. */
export function genericClientInfo(launch: McpLaunchInfo): string {
  return [
    'Tipo: stdio (servidor local)',
    `Comando: ${launch.command}`,
    `Argumentos: ${launch.args.map((a) => shellQuote(a, launch.platform)).join(' ')}`
  ].join('\n')
}

export type McpClientId =
  | 'claudeCode'
  | 'claudeDesktop'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'cursor'
  | 'vscode'
  | 'opencode'
  | 'other'

export interface McpClientSnippet {
  id: McpClientId
  label: string
  /** Where it goes. */
  where: string
  text: string
}

/** A file under the home folder, written the way each system's users read it. */
function homeFile(platform: string, path: string): string {
  return platform === 'win32' ? `%USERPROFILE%\\${path.replace(/\//g, '\\')}` : `~/${path}`
}

/** Every client snippet for this computer, in the order Ajustes shows them. */
export function mcpClientSnippets(launch: McpLaunchInfo): McpClientSnippet[] {
  const { platform } = launch
  const win = platform === 'win32'
  const desktopFile = win
    ? '%APPDATA%\\Claude\\claude_desktop_config.json'
    : platform === 'darwin'
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
      id: 'codex',
      label: 'Codex',
      where: `${homeFile(platform, '.codex/config.toml')} o .codex/config.toml de un proyecto de confianza`,
      text: codexConfig(launch)
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      where: `${homeFile(platform, '.gemini/settings.json')} o .gemini/settings.json del proyecto`,
      text: geminiConfig(launch)
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      where: `${homeFile(platform, '.gemini/config/mcp_config.json')} (Antigravity CLI y el editor) o .agents/mcp_config.json del proyecto`,
      text: geminiConfig(launch)
    },
    {
      id: 'cursor',
      label: 'Cursor',
      where: `.cursor/mcp.json del proyecto o ${homeFile(platform, '.cursor/mcp.json')}`,
      text: cursorConfig(launch)
    },
    {
      id: 'vscode',
      label: 'VS Code',
      where: '.vscode/mcp.json del proyecto',
      text: vscodeConfig(launch)
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      where: `opencode.json del proyecto o ${homeFile(platform, '.config/opencode/opencode.json')}`,
      text: opencodeConfig(launch)
    },
    {
      id: 'other',
      label: 'Otro cliente',
      where:
        'Añade un servidor MCP local (stdio) con estos datos; muchos clientes también aceptan el JSON de Claude Desktop',
      text: genericClientInfo(launch)
    }
  ]
}

/** True when the process was started in MCP mode (`--mcp` anywhere in argv). */
export function isMcpArgv(argv: readonly string[]): boolean {
  return argv.includes(MCP_ARG)
}
