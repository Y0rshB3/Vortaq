/**
 * Connection and database of each SQL document. Saved files keep theirs in
 * the workspace state (per workspace, by URI); untitled documents only for
 * the session. No `vscode` import: the state is any Memento-like store.
 */

export interface DocumentTarget {
  connectionId: string
  /** MySQL/MariaDB database, PostgreSQL database, SQLite attached alias; null = none. */
  database: string | null
  /** PostgreSQL schema (search_path first entry); null = the connection's default. */
  schema?: string | null
}

/** The part of vscode.Memento this module uses. */
export interface StateStore {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): Thenable<void> | Promise<void>
}

export const TARGETS_KEY = 'vortaq.documentTargets'
/** Saved entries kept per workspace (the oldest go first). */
export const MAX_SAVED_TARGETS = 300

const isTarget = (v: unknown): v is DocumentTarget =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as DocumentTarget).connectionId === 'string' &&
  ((v as DocumentTarget).database === null || typeof (v as DocumentTarget).database === 'string')

/** Only saved files are remembered across sessions (untitled URIs are reused). */
const persists = (uri: string): boolean => !uri.startsWith('untitled:')

export class DocumentTargets {
  private readonly session = new Map<string, DocumentTarget>()
  private readonly listeners = new Set<(uri: string) => void>()

  constructor(private readonly state: StateStore) {}

  private saved(): Record<string, DocumentTarget> {
    const raw = this.state.get<Record<string, unknown>>(TARGETS_KEY)
    const out: Record<string, DocumentTarget> = {}
    if (raw && typeof raw === 'object')
      for (const [uri, target] of Object.entries(raw)) if (isTarget(target)) out[uri] = target
    return out
  }

  get(uri: string): DocumentTarget | null {
    return this.session.get(uri) ?? (persists(uri) ? (this.saved()[uri] ?? null) : null)
  }

  async set(uri: string, target: DocumentTarget | null): Promise<void> {
    if (target) this.session.set(uri, { ...target })
    else this.session.delete(uri)
    if (persists(uri)) {
      const saved = this.saved()
      delete saved[uri]
      if (target) saved[uri] = { ...target }
      const entries = Object.entries(saved)
      await this.state.update(
        TARGETS_KEY,
        Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_SAVED_TARGETS)))
      )
    }
    this.fire(uri)
  }

  /** A deleted connection: every document that used it goes back to «Elegir conexión». */
  async forgetConnection(connectionId: string): Promise<void> {
    const released = new Set<string>()
    for (const [uri, target] of [...this.session])
      if (target.connectionId === connectionId) {
        this.session.delete(uri)
        released.add(uri)
      }
    const saved = this.saved()
    const kept = Object.fromEntries(
      Object.entries(saved).filter(([, t]) => t.connectionId !== connectionId)
    )
    if (Object.keys(kept).length !== Object.keys(saved).length) {
      await this.state.update(TARGETS_KEY, kept)
      for (const uri of Object.keys(saved)) if (!(uri in kept)) released.add(uri)
    }
    for (const uri of released) this.fire(uri)
  }

  /** A closed untitled document: its URI may be reused for a new one. */
  closed(uri: string): void {
    if (!persists(uri)) this.session.delete(uri)
  }

  onDidChange(listener: (uri: string) => void): { dispose(): void } {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  private fire(uri: string): void {
    for (const listener of this.listeners) listener(uri)
  }
}

/** «tienda», «tienda.public», «main» for the status bar and the results title. */
export function targetLabel(target: DocumentTarget | null): string {
  if (!target?.database) return ''
  return target.schema ? `${target.database}.${target.schema}` : target.database
}
