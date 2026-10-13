// Types for scripts/download-badges.mjs (used by TypeScript tests).
export const INSTALLER: RegExp
export function installerDownloads(release: {
  assets?: { name: string; download_count?: number }[]
}): number
export const DESKTOP_TAG: RegExp
export function latestDesktopRelease<
  T extends { tag_name?: string; published_at: string; draft?: boolean; prerelease?: boolean }
>(releases: T[]): T | undefined
export function badge(
  label: string,
  count: number,
  color: string
): { schemaVersion: 1; label: string; message: string; color: string; cacheSeconds: number }
