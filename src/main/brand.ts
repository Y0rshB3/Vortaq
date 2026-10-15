/**
 * Product identity. The app was called "Navidog" and then "ElectronDB" before
 * it became Vortaq; the LEGACY_* values exist only to find and migrate data
 * written under those names (profile folders, keychain items, launchd labels,
 * env switches). Newest first: an ElectronDB profile wins over a Navidog one.
 */
export const APP_NAME = 'Vortaq'
export const LOG_FILE_NAME = 'vortaq.log'
/** Log of the `--mcp` agent server: its own lines plus one line per tool call. */
export const MCP_LOG_FILE_NAME = 'mcp.log'

export interface LegacyApp {
  /** app.getName() of that release: profile folder and "<name> Safe Storage" keychain item. */
  name: string
  /** Label prefix of its launchd agents. */
  launchAgentPrefix: string
}

export const LEGACY_ELECTRONDB: LegacyApp = {
  name: 'ElectronDB',
  launchAgentPrefix: 'dev.y0rshb3.electrondb.job.'
}
export const LEGACY_NAVIDOG: LegacyApp = {
  name: 'Navidog',
  launchAgentPrefix: 'dev.y0rshb3.navidog.job.'
}
/** Earlier product names, newest first. */
export const LEGACY_APPS: readonly LegacyApp[] = [LEGACY_ELECTRONDB, LEGACY_NAVIDOG]

/**
 * GitHub repository whose Releases are checked for new versions
 * (src/main/updates) and that electron-builder's `publish` points at (Vortaq
 * 2.0.0 onwards). Copies of ElectronDB (≤ 0.1.9) read the old repository name;
 * GitHub redirects it once the repository is renamed.
 */
export const UPDATE_REPO = { owner: 'Y0rshB3', name: 'Vortaq' } as const

/**
 * Earlier names of the same repository. Release pages and downloads under
 * them are still accepted (isAllowedReleaseUrl), so links to ElectronDB
 * releases (and GitHub's answers before the rename) keep working.
 */
export const LEGACY_UPDATE_REPOS: readonly { owner: string; name: string }[] = [
  { owner: 'Y0rshB3', name: 'ElectronDB' }
]
