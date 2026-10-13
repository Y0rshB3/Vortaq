// Types for scripts/third-party-licenses.mjs (used by TypeScript tests).
export interface NoticePackage {
  name: string
  version: string
  license: string
  repository: string
  texts: { file: string; text: string }[]
  note?: string
}
export declare function licenseId(pkg: Record<string, unknown>): string
export declare function describePackage(dir: string, fallbackName?: string): NoticePackage
export declare function renderPackage(p: NoticePackage): string
export declare function collectPackages(root: string): NoticePackage[]
export declare function renderNotices(input: {
  appName: string
  appVersion: string
  packages: NoticePackage[]
  electron: NoticePackage | null
}): string
export declare function generateNotices(root: string): string
