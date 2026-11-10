/**
 * The host's way to open the Microsoft sign-in page in the system browser
 * (Electron shell.openExternal, VS Code env.openExternal). A tiny module on
 * purpose: hosts register it at startup without loading MSAL; entra.ts reads
 * it when a browser sign-in starts. Null = this host cannot show a page
 * (`Vortaq --mcp`, scheduled jobs).
 */
export type BrowserOpener = (url: string) => Promise<void>

let opener: BrowserOpener | null = null

export function setEntraBrowserOpener(fn: BrowserOpener | null): void {
  opener = fn
}

export function entraBrowserOpener(): BrowserOpener | null {
  return opener
}
