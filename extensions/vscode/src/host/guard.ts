/**
 * Production guard in the extension (CLAUDE.md, «typed confirmation»):
 * writes to a connection whose environment needs the typed name (always
 * production, plus `vortaq.typedConfirmEnvironments`) ask the user to type the
 * connection name in a VS Code input box; only then does the call carry
 * `confirmProduction: true`. The core still enforces it with its denylist, so
 * a missed prompt fails closed with the core's message.
 *
 * Webviews never decide this: the bridge strips any `confirmProduction` a
 * webview sends and asks here, at the moment of the write, from the call's own
 * arguments (docs/vscode-extension-design.md, "Production guard").
 */
import * as vscode from 'vscode'
import {
  dialectForEngine,
  environmentPhrase,
  needsTypedConfirm,
  type ConnectionConfig,
  type RowChange,
  type SqlDialect,
  type VortaqCore
} from '@core'
import {
  analyzeDestructiveScript,
  destructiveItems,
  destructiveTitle
} from '@renderer/components/query/destructiveGuard'

/** How the guard talks to the user (VS Code UI; tests replace it). */
export interface Prompter {
  /** Asks for the connection name; resolves what was typed, or undefined when dismissed. */
  typedName(request: { title: string; prompt: string; name: string }): Promise<string | undefined>
  /** Modal confirmation; true only for the confirm button. */
  confirm(request: { title: string; detail: string; confirmText: string }): Promise<boolean>
}

export const vscodePrompter: Prompter = {
  async typedName({ title, prompt, name }) {
    return vscode.window.showInputBox({
      title,
      prompt,
      placeHolder: name,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (value.trim() === name) return null
        if (!value)
          return {
            message: `Escribe «${name}» para confirmar.`,
            severity: vscode.InputBoxValidationSeverity.Info
          }
        return `El nombre no coincide: escribe «${name}».`
      }
    })
  },
  async confirm({ title, detail, confirmText }) {
    const answer = await vscode.window.showWarningMessage(
      title,
      { modal: true, detail },
      confirmText
    )
    return answer === confirmText
  }
}

/** «producción» or «"Pre"» for titles: where the write lands. */
export function typedTarget(connection: Pick<ConnectionConfig, 'name' | 'environment'>): string {
  return connection.environment === 'production' ? 'producción' : `«${connection.name}»`
}

/** The SQL dialect of a connection (MongoDB has none). */
export function sqlDialectOf(connection: Pick<ConnectionConfig, 'engine'>): SqlDialect {
  const dialect = dialectForEngine(connection.engine)
  if (!dialect) throw new Error('Las conexiones MongoDB no ejecutan SQL.')
  return dialect
}

/** Destructive statements of a script (DROP, TRUNCATE, DELETE, UPDATE without WHERE…). */
export function destructiveStatements(
  connection: Pick<ConnectionConfig, 'engine'>,
  sql: string
): { title: string; items: { tag?: string; text: string; warning?: string }[] } | null {
  let items: { tag?: string; text: string; warning?: string }[]
  if (connection.engine === 'mysql' || connection.engine === 'mariadb') {
    // MariaDB's executable comments read like MySQL's for this check (as in the desktop app).
    const script = connection.engine === 'mariadb' ? sql.split('/*M!').join('/*!') : sql
    items = destructiveItems(analyzeDestructiveScript(script))
  } else {
    const found = sqlDialectOf(connection).analyzeDestructive?.(sql) ?? []
    items = found.map((d) => ({
      tag: d.allRows ? d.reason.split(' ')[0] : d.reason,
      text: d.sql.length > 300 ? `${d.sql.slice(0, 300).trimEnd()}…` : d.sql,
      ...(d.allRows ? { warning: 'sin WHERE: afecta a todas las filas' } : {})
    }))
  }
  return items.length ? { title: destructiveTitle(items.length), items } : null
}

const itemLine = (item: { tag?: string; text: string; warning?: string }): string =>
  `${item.tag ? `${item.tag}: ` : ''}${item.text}${item.warning ? ` (${item.warning})` : ''}`

export interface SqlDecision {
  proceed: boolean
  /** The user typed the connection name: the call may carry confirmProduction. */
  confirmProduction: boolean
}

/** One webview channel that writes: where its WriteOptions go and how to describe the call. */
interface WebviewWrite {
  optionsIndex: number
  connectionIndex: number
  describe(args: unknown[]): string
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** «3 cambio(s) en tienda.clientes: 1 inserción, 2 modificaciones». */
function describeRowChanges(args: unknown[]): string {
  const schema = args[1]
  const where =
    typeof schema === 'string'
      ? schema
      : schema && typeof schema === 'object'
        ? String((schema as { schema?: unknown }).schema ?? '')
        : ''
  const table = typeof args[2] === 'string' ? args[2] : ''
  const changes = Array.isArray(args[3]) ? (args[3] as RowChange[]) : []
  const count = (kind: RowChange['kind']): number => changes.filter((c) => c?.kind === kind).length
  const parts = [
    count('insert') ? plural(count('insert'), 'inserción', 'inserciones') : '',
    count('update') ? plural(count('update'), 'modificación', 'modificaciones') : '',
    count('delete') ? plural(count('delete'), 'fila borrada', 'filas borradas') : ''
  ].filter(Boolean)
  return `Se aplicarán ${plural(changes.length, 'cambio', 'cambios')} en ${where ? `${where}.` : ''}${table}${parts.length ? ` (${parts.join(', ')})` : ''}.`
}

/** Channels a webview may call that write to a connection. */
export const WEBVIEW_WRITES: Readonly<Record<string, WebviewWrite>> = {
  'db:applyRowChanges': { optionsIndex: 4, connectionIndex: 0, describe: describeRowChanges }
}

export class WriteGuard {
  constructor(
    private readonly core: VortaqCore,
    private readonly prompter: () => Prompter
  ) {}

  /** True when writes to `connection` need the typed name (core settings, production always). */
  needsTyped(connection: Pick<ConnectionConfig, 'environment'>): boolean {
    return needsTypedConfirm(this.core.context, connection)
  }

  /** Asks for the connection name; true only when it was typed exactly. */
  async confirmTyped(
    connection: Pick<ConnectionConfig, 'name' | 'environment'>,
    summary: string
  ): Promise<boolean> {
    const typed = await this.prompter().typedName({
      title: `Confirmar escritura en ${typedTarget(connection)}`,
      prompt: `${summary} «${connection.name}» es una conexión de ${environmentPhrase(connection.environment)}: escribe su nombre para continuar.`,
      name: connection.name
    })
    return typed?.trim() === connection.name
  }

  /**
   * Before running SQL from an editor. Allowlist (the dialect's analyzeWrites,
   * the same decision the desktop UI makes): on a guarded connection anything
   * not provably read-only asks for the typed name, which replaces the
   * destructive confirmation; elsewhere DROP/TRUNCATE/DELETE… ask when
   * `confirmDestructive` is on.
   */
  async checkSql(
    connection: ConnectionConfig,
    sql: string,
    confirmDestructive: boolean
  ): Promise<SqlDecision> {
    const check = sqlDialectOf(connection).analyzeWrites(sql)
    if (this.needsTyped(connection) && check.writes) {
      const ok = await this.confirmTyped(
        connection,
        `La consulta puede modificar datos, estructura o estado del servidor (${check.reasons.join(', ')}).`
      )
      return { proceed: ok, confirmProduction: ok }
    }
    if (confirmDestructive) {
      const destructive = destructiveStatements(connection, sql)
      if (destructive) {
        const ok = await this.prompter().confirm({
          title: destructive.title,
          detail: `Conexión «${connection.name}». Revisa lo que se va a borrar o eliminar; no se puede deshacer.\n\n${destructive.items.map(itemLine).join('\n')}`,
          confirmText: 'Ejecutar'
        })
        if (!ok) return { proceed: false, confirmProduction: false }
      }
    }
    return { proceed: true, confirmProduction: false }
  }

  /**
   * A webview call, before it reaches the core: every `confirmProduction` the
   * webview put in its arguments is removed; for a write channel on a guarded
   * connection the user types the name here, and only then is it set again.
   * Resolves the arguments to send, or a refusal message.
   */
  async prepareWebviewCall(
    channel: string,
    args: readonly unknown[]
  ): Promise<{ args: unknown[] } | { refused: string }> {
    const clean = args.map(stripConfirm)
    const write = WEBVIEW_WRITES[channel]
    if (!write) return { args: clean }
    const connectionId = clean[write.connectionIndex]
    const connection =
      typeof connectionId === 'string' ? this.core.context.connections.get(connectionId) : null
    if (!connection || !this.needsTyped(connection)) return { args: clean }
    const ok = await this.confirmTyped(connection, write.describe(clean))
    if (!ok)
      return {
        refused: `No se escribió nada: para escribir en «${connection.name}» hay que confirmar escribiendo el nombre de la conexión.`
      }
    while (clean.length <= write.optionsIndex) clean.push(undefined)
    const options = clean[write.optionsIndex]
    clean[write.optionsIndex] = {
      ...(options && typeof options === 'object' ? options : {}),
      confirmProduction: true
    }
    return { args: clean }
  }
}

/** Removes `confirmProduction` from a top-level options object (any other value is kept). */
export function stripConfirm(arg: unknown): unknown {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) return arg
  if (!Object.prototype.hasOwnProperty.call(arg, 'confirmProduction')) return arg
  const { confirmProduction: _dropped, ...rest } = arg as Record<string, unknown>
  return rest
}
