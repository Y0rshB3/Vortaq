// Types for scripts/core-bundle.mjs (used by TypeScript tests).
export declare const ROOT: string
export declare const CORE_ENTRY: string
export declare const SQLITE_WORKER_ENTRY: string
export declare const ELECTRON_PACKAGES: string[]
export declare const DESKTOP_ONLY_FILES: string[]
export declare const DESKTOP_ONLY_DIRS: string[]
export interface BoundaryResult {
  ok: boolean
  /** One line per violation: `file:line: message`. */
  errors: string[]
  /** Source files the bundle reached (repository-relative). */
  inputs: string[]
}
export declare function checkCoreBoundary(entry?: string): Promise<BoundaryResult>
export declare function bundleCore(outfile: string): Promise<string>
export declare function bundleSqliteWorker(outfile: string): Promise<string>
