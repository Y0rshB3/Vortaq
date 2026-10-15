import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Hosts where several processes share one profile re-read a file another
 * process rewrote before using it. The editor extension needs it: every editor
 * window runs its own extension host on the same globalStorage folder.
 * createCore turns it on; the desktop app (one process per profile) keeps the
 * read-once behaviour.
 */
let reloadExternalChanges = false

export function setJsonStoreReload(on: boolean): void {
  reloadExternalChanges = on
}

/**
 * Processes that only read another process's profile (the `--mcp` agent
 * server reads the desktop app's connections, settings and secrets) never
 * write it: saving throws, and an unreadable file is left where it is
 * (defaults are used) instead of being moved aside.
 */
let readOnlyStores = false

export const READ_ONLY_STORE_MESSAGE =
  'Este proceso de Vortaq solo lee el perfil: no guarda cambios.'

export function setJsonStoreReadOnly(on: boolean): void {
  readOnlyStores = on
}

/**
 * Tiny durable JSON document store: reads once, keeps the document in memory
 * and writes atomically (temp file + rename) on every save. With
 * setJsonStoreReload(true) it re-reads the file when another process replaced
 * it (each save is a new file, so its inode changes) before reading or
 * mutating the document.
 */
export class JsonStore<T extends object> {
  private data: T
  /** inode, size and mtime of the file as last read or written (reload mode only). */
  private stamp: string | null = null

  constructor(
    readonly filePath: string,
    private readonly defaults: () => T,
    private readonly migrate: (raw: unknown) => T = (raw) => raw as T
  ) {
    this.data = this.load()
  }

  private fileStamp(): string | null {
    try {
      const st = statSync(this.filePath)
      return `${st.ino}:${st.size}:${st.mtimeMs}`
    } catch {
      return null
    }
  }

  /** Reload mode: picks up a version another process wrote since the last read or write. */
  private refresh(): void {
    if (!reloadExternalChanges) return
    if (this.fileStamp() !== this.stamp) this.data = this.load()
  }

  private load(): T {
    if (reloadExternalChanges) this.stamp = this.fileStamp()
    if (!existsSync(this.filePath)) return this.defaults()
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'))
      return { ...this.defaults(), ...this.migrate(raw) }
    } catch (err) {
      if (readOnlyStores) {
        console.error(`vortaq: could not parse ${this.filePath}; using defaults (read-only)`)
        return this.defaults()
      }
      const backup = `${this.filePath}.corrupt-${Date.now()}`
      try {
        renameSync(this.filePath, backup)
      } catch {
        /* ignore */
      }
      console.error(`vortaq: could not parse ${this.filePath}, moved to ${backup}`, err)
      return this.defaults()
    }
  }

  get(): T {
    this.refresh()
    return this.data
  }

  update(mutator: (draft: T) => void): T {
    if (readOnlyStores) throw new Error(READ_ONLY_STORE_MESSAGE)
    this.refresh()
    mutator(this.data)
    this.save()
    return this.data
  }

  replace(next: T): T {
    if (readOnlyStores) throw new Error(READ_ONLY_STORE_MESSAGE)
    this.data = next
    this.save()
    return this.data
  }

  save(): void {
    if (readOnlyStores) throw new Error(READ_ONLY_STORE_MESSAGE)
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(tmp, this.filePath)
    if (reloadExternalChanges) this.stamp = this.fileStamp()
  }
}
