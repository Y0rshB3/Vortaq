/**
 * The extension's settings (`vortaq.*`) copied into the core's settings.json,
 * where the core's guards read them: the typed-confirmation environments and
 * the row limit. Production always needs the typed name, whatever the list
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

export interface ExtensionSettings {
  maxRows: number
  typedConfirmEnvironments: Environment[]
  confirmDestructive: boolean
  codeLens: boolean
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
    codeLens: config.get<boolean>('codeLens', true) !== false
  }
}

/** The AppSettings fields the core reads, from the extension's settings. */
export function corePatch(settings: ExtensionSettings): Partial<AppSettings> {
  return {
    defaultRowLimit: settings.maxRows,
    typedConfirmEnvironments: settings.typedConfirmEnvironments,
    confirmDestructiveEverywhere: settings.confirmDestructive
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
