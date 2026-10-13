/**
 * Connections of the extension's own profile, on top of the core channels.
 * Opening asks for a password the vault does not have yet (imported
 * connections, a reset vault key): it is stored through the core's
 * CredentialStore, encrypted with the vault key, or kept only until the
 * connection closes when the connection does not save passwords.
 */
import * as vscode from 'vscode'
import {
  DB_PASSWORD,
  ENGINES,
  type ConnectionConfig,
  type ConnectionInput,
  type ServerInfo,
  type VortaqCore
} from '@core'

export class ConnectionService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<string | undefined>()
  /** Fires with a connection id (its state changed) or undefined (the list changed). */
  readonly onDidChange = this.changed.event
  /** Passwords typed for connections that do not save them: removed when they close. */
  private readonly ephemeral = new Map<string, Set<'password' | 'ssh'>>()

  constructor(
    readonly core: VortaqCore,
    readonly sqliteProblem: string | null,
    private readonly output: vscode.LogOutputChannel
  ) {}

  list(): Promise<ConnectionConfig[]> {
    return this.core.invoke('connections:list')
  }

  get(id: string): ConnectionConfig | null {
    return this.core.context.connections.get(id)
  }

  isOpen(id: string): boolean {
    return this.core.connections.isOpen(id)
  }

  /** The list changed (saved, imported, deleted). */
  refreshAll(): void {
    this.changed.fire(undefined)
  }

  async save(input: ConnectionInput): Promise<ConnectionConfig> {
    const saved = await this.core.invoke('connections:save', input)
    this.refreshAll()
    return saved
  }

  /**
   * Opens a connection, asking first for a missing password. Resolves null
   * when the user dismissed the password prompt; throws the core's message
   * when the server refuses.
   */
  async open(id: string): Promise<ServerInfo | null> {
    const connection = this.get(id)
    if (!connection) throw new Error('La conexión ya no existe.')
    if (this.isOpen(id)) return this.core.invoke('connections:open', id)
    if (connection.engine === 'sqlite' && this.sqliteProblem) throw new Error(this.sqliteProblem)
    if (!(await this.askMissingSecrets(connection))) return null
    try {
      const info = await this.core.invoke('connections:open', id)
      this.output.info(`Conexión «${connection.name}» abierta`)
      return info
    } catch (err) {
      this.forgetEphemeral(id)
      throw err
    } finally {
      this.changed.fire(id)
    }
  }

  async close(id: string): Promise<void> {
    try {
      await this.core.invoke('connections:close', id)
    } finally {
      this.forgetEphemeral(id)
      this.changed.fire(id)
    }
  }

  async remove(id: string): Promise<void> {
    await this.core.invoke('connections:delete', id)
    this.ephemeral.delete(id)
    this.refreshAll()
  }

  /** «Cambiar contraseña» after a refused sign-in: asks again and stores the new one. */
  async replacePassword(id: string): Promise<boolean> {
    const connection = this.get(id)
    if (!connection) return false
    const typed = await this.promptSecret(connection, 'password')
    if (typed === undefined) return false
    await this.storeSecret(connection, 'password', typed)
    return true
  }

  /** The core reported a lost connection (server gone, tunnel closed). */
  connectionLost(id: string, reason: string): void {
    this.forgetEphemeral(id)
    this.changed.fire(id)
    const name = this.get(id)?.name ?? id
    void vscode.window.showWarningMessage(`Se perdió la conexión con «${name}»: ${reason}`)
  }

  private async askMissingSecrets(connection: ConnectionConfig): Promise<boolean> {
    const engine = ENGINES[connection.engine]
    if (!engine?.capabilities.needsHost) return true
    const passwordless =
      connection.authMode === 'none' ||
      (engine.capabilities.passwordOptional && !connection.username.trim())
    if (!passwordless && !(await this.core.invoke('connections:hasPassword', connection.id))) {
      const typed = await this.promptSecret(connection, 'password')
      if (typed === undefined) return false
      await this.storeSecret(connection, 'password', typed)
    }
    const ssh = connection.ssh
    if (
      engine.capabilities.supportsSsh &&
      ssh.enabled &&
      ssh.authType === 'password' &&
      !(await this.core.invoke('connections:hasSshPassword', connection.id))
    ) {
      const typed = await this.promptSecret(connection, 'ssh')
      if (typed === undefined) return false
      await this.storeSecret(connection, 'ssh', typed)
    }
    return true
  }

  private promptSecret(
    connection: ConnectionConfig,
    kind: 'password' | 'ssh'
  ): Thenable<string | undefined> {
    const saves = kind === 'password' ? connection.savePassword : connection.ssh.savePassword
    const keep = saves
      ? 'Se guardará cifrada en el almacén seguro del editor.'
      : 'No se guardará: se usa solo hasta que cierres la conexión.'
    return vscode.window.showInputBox({
      title:
        kind === 'password'
          ? `Contraseña de «${connection.name}» (usuario ${connection.username || 'sin usuario'})`
          : `Contraseña SSH de «${connection.name}» (${connection.ssh.username}@${connection.ssh.host})`,
      prompt:
        kind === 'password' ? `${keep} Déjala vacía si el usuario no tiene contraseña.` : keep,
      password: true,
      ignoreFocusOut: true
    })
  }

  private async storeSecret(
    connection: ConnectionConfig,
    kind: 'password' | 'ssh',
    value: string
  ): Promise<void> {
    if (!value) return
    if (kind === 'password') await this.core.invoke('connections:setPassword', connection.id, value)
    else await this.core.invoke('connections:setSshPassword', connection.id, value)
    const saves = kind === 'password' ? connection.savePassword : connection.ssh.savePassword
    if (!saves) {
      const kinds = this.ephemeral.get(connection.id) ?? new Set()
      kinds.add(kind)
      this.ephemeral.set(connection.id, kinds)
    }
  }

  /** Removes the passwords typed for a connection that does not save them. */
  private forgetEphemeral(id: string): void {
    const kinds = this.ephemeral.get(id)
    if (!kinds) return
    this.ephemeral.delete(id)
    for (const kind of kinds) {
      try {
        this.core.context.credentials.set(kind === 'password' ? DB_PASSWORD : 'ssh', id, null)
      } catch {
        /* nothing stored */
      }
    }
  }

  dispose(): void {
    for (const id of [...this.ephemeral.keys()]) this.forgetEphemeral(id)
    this.changed.dispose()
  }
}
