/**
 * The extension's settings (`vortaq.*`) copied into the core's settings.json,
 * where the core's guards read them: the typed-confirmation environments, the
 * row limit and the agents' switch (the MCP runtime checks it on every call). Production always needs the typed name, whatever the list
 * says (normalizeTypedConfirmEnvironments adds it back).
 */
import * as vscode from 'vscode'
import {
  normalizeTypedConfirmEnvironments,
  type AppSettings,
  type Environment,
  type VortaqCore
} from '@core'

export const DEFAULT_MAX_ROWS = 1000
const MAX_ROWS_LIMIT = 100_000
/** `vortaq.mcp.port` when unset or invalid (host/mcp.ts tries the next ones when it is taken). */
export const DEFAULT_MCP_PORT = 39291

export interface ExtensionSettings {
  maxRows: number
  typedConfirmEnvironments: Environment[]
  confirmDestructive: boolean
  codeLens: boolean
  /** Agents (MCP): the server inside the editor (host/mcp.ts). User settings only. */
  mcp: { enabled: boolean; port: number }
}

/** Reads `vortaq.*`, clamping invalid values to the defaults. */
export function readSettings(
  config: Pick<vscode.WorkspaceConfiguration, 'get'> = vscode.workspace.getConfiguration('vortaq')
): ExtensionSettings {
  const rows = Number(config.get<number>('maxRows', DEFAULT_MAX_ROWS))
  return {
    maxRows:
      Number.isInteger(rows) && rows >= 1 ? Math.min(rows, MAX_ROWS_LIMIT) : DEFAULT_MAX_ROWS,
    typedConfirmEnvironments: normalizeTypedConfirmEnvironments(
      config.get<unknown>('typedConfirmEnvironments', ['production'])
    ),
    confirmDestructive: config.get<boolean>('confirmDestructive', true) !== false,
    codeLens: config.get<boolean>('codeLens', true) !== false,
    mcp: {
      // Only an explicit true: agents stay off otherwise.
      enabled: config.get<boolean>('mcp.enabled', false) === true,
      port: validPort(config.get<number>('mcp.port', DEFAULT_MCP_PORT))
    }
  }
}

function validPort(value: unknown): number {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_MCP_PORT
}

/** The AppSettings fields the core reads, from the extension's settings. */
export function corePatch(settings: ExtensionSettings): Partial<AppSettings> {
  return {
    defaultRowLimit: settings.maxRows,
    typedConfirmEnvironments: settings.typedConfirmEnvironments,
    confirmDestructiveEverywhere: settings.confirmDestructive,
    mcpEnabled: settings.mcp.enabled
  }
}

/** Copies the settings into the core now and whenever the user changes them. */
export function syncSettings(
  core: VortaqCore,
  onChange: (s: ExtensionSettings) => void
): vscode.Disposable {
  const apply = (): void => {
    const settings = readSettings()
    core.context.settings.update(corePatch(settings))
    onChange(settings)
  }
  apply()
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('vortaq')) apply()
  })
}
