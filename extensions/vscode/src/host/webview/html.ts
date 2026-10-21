/**
 * HTML of a Vortaq webview: the built bundle of one view (dist/webview/<name>.js
 * and .css, plus the icon font) under a strict Content Security Policy:
 * nothing by default, scripts only with this page's nonce, styles and fonts
 * only from the extension's own files (the editor-theme stylesheet and
 * Vuetify's theme carry the nonce), no remote resources and no inline
 * handlers. State arrives by message after `ready`, never inside the HTML.
 */
import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'

export type WebviewName = 'connection' | 'results' | 'schema'

export const newNonce = (): string => randomBytes(18).toString('base64')

/** The CSP of a webview page (exported for the unit test). */
export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

/** Webview options: scripts on, resources limited to dist/webview. */
export function webviewOptions(
  extensionUri: vscode.Uri
): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  return {
    enableScripts: true,
    enableCommandUris: false,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')]
  }
}

export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  name: WebviewName,
  title: string
): string {
  const nonce = newNonce()
  const base = vscode.Uri.joinPath(extensionUri, 'dist', 'webview')
  const asset = (file: string): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(base, file)).toString()
  const esc = (s: string): string =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(webview.cspSource, nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${asset('mdi.css')}">
<link rel="stylesheet" href="${asset(`${name}.css`)}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${asset(`${name}.js`)}"></script>
</body>
</html>`
}
