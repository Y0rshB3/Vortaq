/**
 * «Vortaq: Agentes (MCP)…»: one list with the global switch, every saved
 * connection with its level (the same setting as the desktop app's
 * Ajustes › Agentes (MCP)), the configuration other MCP clients need, the key
 * and the privacy note. «Agentes (MCP)…» on a connection of the tree opens its
 * level directly. Levels are saved with `connections:setMcp`, which changes
 * only `mcp` and refuses «Lectura y escritura» where the typed confirmation applies.
 */
import * as vscode from 'vscode'
import {
  DEFAULT_MCP_ACCESS,
  effectiveMcpAccess,
  ENGINES,
  MCP_ACCESS_HINTS,
  MCP_ACCESS_LABELS,
  MCP_ACCESS_LEVELS,
  MCP_KEY_NOTE,
  MCP_PRIVACY_NOTE,
  MCP_WRITE_BLOCKED,
  mcpHttpClientSnippets,
  mcpWriteBlocked,
  normalizeMcpConfig,
  type ConnectionConfig,
  type ConnectionMcpConfig,
  type Environment,
  type VortaqCore
} from '@core'
import type { McpService } from './mcp'
import { showError, showInformation, showWarning } from './notice'

export interface McpManagerDeps {
  core: VortaqCore
  service: McpService
  /** Saved connections, sorted as the tree shows them. */
  connections: () => Promise<ConnectionConfig[]>
  /** Turns `vortaq.mcp.enabled` on or off (user settings). */
  setEnabled: (on: boolean) => Thenable<void> | Promise<void>
  /** After a connection's level changed (tree refresh). */
  changed: () => void
}

type Action =
  | { kind: 'toggle' }
  | { kind: 'connection'; connection: ConnectionConfig }
  | { kind: 'vscode' }
  | { kind: 'copy' }
  | { kind: 'key' }
  | { kind: 'privacy' }

type ActionItem = vscode.QuickPickItem & { action?: Action }

const TITLE = 'Vortaq · Agentes (MCP)'
const OFF: ConnectionMcpConfig = { enabled: false, access: DEFAULT_MCP_ACCESS }

function typedEnvironments(core: VortaqCore): Environment[] {
  return core.context.settings.get().typedConfirmEnvironments
}

function separator(label: string): ActionItem {
  return { label, kind: vscode.QuickPickItemKind.Separator }
}

/** «MySQL · Lectura», «PostgreSQL · desactivada», with the lowered level explained. */
function connectionItem(c: ConnectionConfig, environments: Environment[]): ActionItem {
  const saved = normalizeMcpConfig(c.mcp) ?? OFF
  const effective = effectiveMcpAccess(c, environments)
  const engine = ENGINES[c.engine]?.label ?? c.engine
  return {
    label: `${effective ? '$(pass-filled)' : '$(circle-large-outline)'} ${c.name}`,
    description: `${engine} · ${effective ? MCP_ACCESS_LABELS[effective] : 'desactivada'}`,
    detail:
      saved.enabled && saved.access === 'write' && effective !== 'write'
        ? 'Guardada con «Lectura y escritura»: en este entorno los agentes solo pueden leer.'
        : undefined,
    action: { kind: 'connection', connection: c }
  }
}

/** The main list. Separators keep the switch, the connections and the clients apart. */
export function managerItems(
  deps: Pick<McpManagerDeps, 'core' | 'service'>,
  connections: ConnectionConfig[]
): ActionItem[] {
  const enabled = deps.core.context.settings.get().mcpEnabled === true
  const environments = typedEnvironments(deps.core)
  const active = connections.filter((c) => effectiveMcpAccess(c, environments)).length
  const endpoint = deps.service.endpoint()
  const items: ActionItem[] = [
    {
      label: `${enabled ? '$(check)' : '$(circle-slash)'} Permitir que agentes usen Vortaq (MCP)`,
      description: enabled ? 'activado' : 'desactivado',
      detail: enabled
        ? `${deps.service.describe()} Elige para desactivarlo.`
        : 'Elige para activarlo. Solo las conexiones que actives abajo existen para el agente.',
      action: { kind: 'toggle' }
    },
    separator(`Conexiones para agentes (${active} de ${connections.length} activadas)`)
  ]
  if (!connections.length)
    items.push({
      label: 'Aún no hay conexiones guardadas',
      description: 'añade una en la vista Vortaq'
    })
  for (const c of connections) items.push(connectionItem(c, environments))
  items.push(separator('Clientes MCP'))
  items.push({
    label: '$(sparkle) VS Code (Copilot, modo agente)',
    description: 'automático',
    detail: 'Este editor ya lista «Vortaq» como servidor MCP mientras los agentes estén activados.',
    action: { kind: 'vscode' }
  })
  if (endpoint)
    items.push(
      {
        label: '$(copy) Copiar configuración para otro cliente…',
        detail: 'Claude Code, Codex, Gemini CLI, Antigravity, Cursor, OpenCode u otro cliente MCP.',
        action: { kind: 'copy' }
      },
      {
        label: '$(key) Regenerar la clave',
        detail: 'Los clientes con la clave anterior dejan de entrar (VS Code se actualiza solo).',
        action: { kind: 'key' }
      }
    )
  items.push({
    label: '$(shield) Qué se envía al agente',
    action: { kind: 'privacy' }
  })
  return items
}

/** The level of one connection: «Desactivada» or one of the three levels. */
export async function pickConnectionLevel(
  deps: Pick<McpManagerDeps, 'core' | 'changed'>,
  connection: ConnectionConfig
): Promise<boolean> {
  const saved = normalizeMcpConfig(connection.mcp) ?? OFF
  const blocked = mcpWriteBlocked(connection.environment, typedEnvironments(deps.core))
  type LevelItem = vscode.QuickPickItem & { config: ConnectionMcpConfig }
  const current = (config: ConnectionMcpConfig): string | undefined =>
    config.enabled === saved.enabled && (!config.enabled || config.access === saved.access)
      ? 'actual'
      : undefined
  const off: ConnectionMcpConfig = { enabled: false, access: saved.access }
  const items: LevelItem[] = [
    {
      label: 'Desactivada',
      description: current(off),
      detail: 'La conexión no existe para el agente.',
      config: off
    },
    ...MCP_ACCESS_LEVELS.filter((level) => !(level === 'write' && blocked)).map((level) => {
      const config = { enabled: true, access: level }
      return {
        label: MCP_ACCESS_LABELS[level],
        description: current(config),
        detail: MCP_ACCESS_HINTS[level],
        config
      }
    })
  ]
  const picked = await vscode.window.showQuickPick(items, {
    title: `${TITLE} · ${connection.name}`,
    placeHolder: blocked
      ? `Qué puede hacer un agente con «${connection.name}». ${MCP_WRITE_BLOCKED}`
      : `Qué puede hacer un agente con «${connection.name}»`
  })
  if (!picked) return false
  if (picked.config.enabled === saved.enabled && picked.config.access === saved.access) return false
  try {
    await deps.core.invoke('connections:setMcp', connection.id, picked.config)
  } catch (err) {
    void showError(err instanceof Error ? err.message : String(err))
    return false
  }
  deps.changed()
  return true
}

async function copyClientConfig(service: McpService): Promise<void> {
  const endpoint = service.endpoint()
  if (!endpoint) return
  const snippets = mcpHttpClientSnippets(endpoint)
  const picked = await vscode.window.showQuickPick(
    snippets.map((s) => ({ label: s.label, detail: s.where, snippet: s })),
    { title: `${TITLE} · Copiar configuración`, placeHolder: '¿Qué cliente MCP usas?' }
  )
  if (!picked) return
  await vscode.env.clipboard.writeText(picked.snippet.text)
  void showInformation(
    `Configuración de ${picked.snippet.label} copiada. Pégala en: ${picked.snippet.where}. ${MCP_KEY_NOTE}`
  )
}

/** The manager: loops until the user closes it, so several changes take one command. */
export async function showMcpManager(deps: McpManagerDeps): Promise<void> {
  for (;;) {
    await deps.service.refresh()
    const connections = await deps.connections()
    const picked = await vscode.window.showQuickPick(managerItems(deps, connections), {
      title: TITLE,
      placeHolder: 'Elige qué cambiar',
      matchOnDescription: true
    })
    const action = picked?.action
    if (!action) return
    switch (action.kind) {
      case 'toggle': {
        const on = deps.core.context.settings.get().mcpEnabled !== true
        await deps.setEnabled(on)
        await deps.service.refresh()
        break
      }
      case 'connection':
        await pickConnectionLevel(deps, action.connection)
        break
      case 'vscode':
        void showInformation(
          'En VS Code no hace falta configurar nada: con los agentes activados, «Vortaq» aparece en «MCP: List Servers» y en las herramientas del chat en modo agente. Si el chat pide confianza para el servidor, acéptala.'
        )
        return
      case 'copy':
        await copyClientConfig(deps.service)
        return
      case 'key': {
        const yes = 'Regenerar'
        const answer = await showWarning(
          '¿Regenerar la clave de los agentes? Los clientes configurados con la clave actual (Claude Code, Codex, Cursor…) dejarán de entrar hasta que copies de nuevo su configuración.',
          { modal: true },
          yes
        )
        if (answer === yes) await deps.service.regenerateKey()
        break
      }
      case 'privacy':
        await showInformation(MCP_PRIVACY_NOTE, { modal: true })
        break
    }
  }
}

/**
 * «Agentes (MCP)…» on a connection: its level, then an offer to turn agents on
 * when the global switch is still off.
 */
export async function showConnectionMcp(
  deps: McpManagerDeps,
  connection: ConnectionConfig
): Promise<void> {
  const changed = await pickConnectionLevel(deps, connection)
  if (!changed || deps.core.context.settings.get().mcpEnabled === true) return
  const fresh = deps.core.context.connections.get(connection.id)
  if (!fresh || !normalizeMcpConfig(fresh.mcp)?.enabled) return
  const turnOn = 'Activar agentes'
  const answer = await showInformation(
    `«${connection.name}» quedó disponible para agentes, pero los agentes están desactivados en Vortaq.`,
    turnOn
  )
  if (answer === turnOn) {
    await deps.setEnabled(true)
    await deps.service.refresh()
  }
}
