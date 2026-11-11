/**
 * Who may do what through the MCP server. Every tool call checks, against the
 * files as they are now (the desktop app may have changed them a second ago):
 * the global switch, that the connection is available to agents, and the
 * level the tool needs. «Lectura y escritura» on a connection whose
 * environment needs the typed confirmation is always refused: the agent can
 * never type the connection's name.
 */
import { MCP_ACCESS_LABELS } from '@shared/mcp'
import { environmentPhrase } from '@shared/typedConfirm'
import type { ConnectionConfig, McpAccess } from '@shared/types'

/** How a refusal or failure is recorded in the activity log. */
export type McpOutcome = 'ok' | 'refused' | 'error' | 'timeout'

/** An error whose message is meant for the agent (already actionable, redacted on the way out). */
export class McpToolError extends Error {
  constructor(
    message: string,
    readonly outcome: Exclude<McpOutcome, 'ok'> = 'refused'
  ) {
    super(message)
    this.name = 'McpToolError'
  }
}

export type McpToolName =
  | 'list_connections'
  | 'list_databases'
  | 'list_tables'
  | 'describe_table'
  | 'run_query'
  | 'explain_query'
  | 'execute_sql'

/** Level each connection tool needs. */
export const TOOL_LEVEL: Record<Exclude<McpToolName, 'list_connections'>, McpAccess> = {
  list_databases: 'structure',
  list_tables: 'structure',
  describe_table: 'structure',
  run_query: 'read',
  explain_query: 'read',
  execute_sql: 'write'
}

const RANK: Record<McpAccess, number> = { structure: 0, read: 1, write: 2 }

export const MCP_DISABLED =
  'Vortaq no permite agentes ahora mismo. Activa «Permitir que agentes usen Vortaq (MCP)» en Vortaq › Ajustes › Agentes (MCP) y vuelve a intentarlo.'

export const WHERE_TO_CHANGE = 'Cámbialo en Vortaq › editar la conexión › Agentes (MCP).'

/**
 * Where the user decides what agents may do, as the messages name it: the
 * desktop app (`Vortaq --mcp`) or the editor extension (its MCP server runs
 * inside the editor and is managed with a command).
 */
export interface McpWording {
  /** Who saved the connections, in the instructions an agent reads (English). */
  source: string
  /** The global switch is off. */
  disabled: string
  /** Appended to a refusal for a level that is too low. */
  whereToChange: string
  /** Where connections are made available to agents (inside unknownConnection). */
  enablePlace: string
}

export const DESKTOP_MCP_WORDING: McpWording = {
  source: 'the Vortaq desktop app',
  disabled: MCP_DISABLED,
  whereToChange: WHERE_TO_CHANGE,
  enablePlace: 'Vortaq (editar la conexión › Agentes (MCP))'
}

/** The editor extension's command that manages agents (extensions/vscode). */
export const EDITOR_MCP_COMMAND = '«Vortaq: Agentes (MCP)…»'

export const EDITOR_MCP_WORDING: McpWording = {
  source: 'the Vortaq editor extension',
  disabled: `Vortaq no permite agentes ahora mismo. En el editor, ejecuta ${EDITOR_MCP_COMMAND} y activa «Permitir que agentes usen Vortaq (MCP)»; luego vuelve a intentarlo.`,
  whereToChange: `Cámbialo en el editor con ${EDITOR_MCP_COMMAND}.`,
  enablePlace: `el editor (${EDITOR_MCP_COMMAND})`
}

export function unknownConnection(ref: string, wording: McpWording = DESKTOP_MCP_WORDING): string {
  return `No hay ninguna conexión «${ref}» disponible para agentes. Usa list_connections para ver las conexiones que el usuario ha activado en ${wording.enablePlace}.`
}

/**
 * Throws unless `access` (the connection's effective level) allows `tool`.
 * `requested` is the stored level: when it says 'write' but the environment
 * needs the typed confirmation, the refusal says so.
 */
export function requireLevel(
  connection: Pick<ConnectionConfig, 'name' | 'environment'>,
  access: McpAccess,
  requested: McpAccess,
  tool: Exclude<McpToolName, 'list_connections'>,
  whereToChange: string = WHERE_TO_CHANGE
): void {
  const needed = TOOL_LEVEL[tool]
  if (RANK[access] >= RANK[needed]) return
  if (needed === 'write' && requested === 'write')
    throw new McpToolError(
      `«${connection.name}» es una conexión de ${environmentPhrase(connection.environment)}: Vortaq pide escribir su nombre antes de cualquier cambio, así que un agente nunca puede escribir en ella. Usa run_query (solo lectura) o haz el cambio desde Vortaq.`
    )
  throw new McpToolError(
    `La conexión «${connection.name}» está en «${MCP_ACCESS_LABELS[access]}» para agentes y ${tool} necesita «${MCP_ACCESS_LABELS[needed]}». ${whereToChange}`
  )
}
