/**
 * Microsoft Entra ID sign-in for SQL Server (docs/sqlserver-design.md,
 * «Autenticación»). tedious asks a TokenCredential for a token on every new
 * session (`token-credential`), with the scope the server names
 * (https://database.windows.net/.default on public Azure).
 *
 * - 'entra-interactive': MSAL's public-client flow with PKCE and a loopback
 *   redirect; the sign-in page opens in the system browser through the host's
 *   opener (Electron shell.openExternal, VS Code env.openExternal). Tokens stay
 *   in memory for the app session (MSAL refreshes them silently); nothing is
 *   written to disk. Hosts without an opener (`Vortaq --mcp`, jobs) refuse.
 * - 'entra-azure-cli': `az account get-access-token`, run with an argument
 *   list (no shell on macOS/Linux; validated arguments through cmd.exe for
 *   az.cmd on Windows), with the usual install folders searched as well
 *   because apps started from the Dock or Finder get a short PATH.
 * - 'entra-service-principal': client credentials (application ID + secret).
 *
 * The token itself is never logged or returned to the renderer.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { AccessToken, TokenCredential } from '@azure/core-auth'
import { ClientSecretCredential } from '@azure/identity'
import {
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult
} from '@azure/msal-node'
import { VORTAQ_ENTRA_CLIENT_ID } from '@shared/sqlserverAuth'
import type { ConnectionInput, SqlServerOptions } from '@shared/types'
import { entraBrowserOpener } from './browserOpener'
import { MsUserError } from './errors'

/** Scope of Azure SQL on the public cloud (sovereign clouds send their own). */
export const AZURE_SQL_SCOPE = 'https://database.windows.net/.default'

/** How long the browser sign-in may take before the connection gives up. */
const INTERACTIVE_TIMEOUT_MS = 5 * 60_000

const scopesOf = (scopes: string | string[]): string[] =>
  Array.isArray(scopes) ? scopes : [scopes]

function toAccessToken(result: AuthenticationResult | null): AccessToken {
  if (!result?.accessToken)
    throw new MsUserError('Microsoft Entra no devolvió un token', 'E_MS_ENTRA')
  return {
    token: result.accessToken,
    expiresOnTimestamp: result.expiresOn ? result.expiresOn.getTime() : Date.now() + 5 * 60_000
  }
}

const page = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Vortaq</title><body style="font-family:system-ui;margin:3rem"><h2>${title}</h2><p>${text}</p></body>`

/** One MSAL application per client/tenant/account hint, alive for the app session. */
interface InteractiveEntry {
  app: PublicClientApplication
  account: AccountInfo | null
  /** A sign-in in progress: every session waits for it instead of opening another page. */
  pending: Promise<AccessToken> | null
}
const interactive = new Map<string, InteractiveEntry>()

class InteractiveCredential implements TokenCredential {
  constructor(
    private readonly clientId: string,
    private readonly tenant: string,
    private readonly loginHint: string
  ) {}

  private entry(): InteractiveEntry {
    const key = `${this.clientId}|${this.tenant}|${this.loginHint.toLowerCase()}`
    let found = interactive.get(key)
    if (!found) {
      found = {
        app: new PublicClientApplication({
          auth: {
            clientId: this.clientId,
            authority: `https://login.microsoftonline.com/${this.tenant || 'organizations'}`
          }
        }),
        account: null,
        pending: null
      }
      interactive.set(key, found)
    }
    return found
  }

  async getToken(scopes: string | string[]): Promise<AccessToken | null> {
    const entry = this.entry()
    const list = scopesOf(scopes)
    if (entry.pending) await entry.pending.catch(() => undefined)
    if (entry.account) {
      try {
        return toAccessToken(
          await entry.app.acquireTokenSilent({ account: entry.account, scopes: list })
        )
      } catch {
        /* expired session: sign in again */
      }
    }
    const opener = entraBrowserOpener()
    if (!opener)
      throw new MsUserError(
        'Esta conexión inicia sesión con Microsoft en el navegador, y aquí no se puede abrir (agentes MCP y tareas programadas). Usa la CLI de Azure o una aplicación de Microsoft Entra.',
        'E_MS_ENTRA_BROWSER'
      )
    const signIn = (async (): Promise<AccessToken> => {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new MsUserError(
                'No se completó el inicio de sesión de Microsoft en el navegador a tiempo. Vuelve a conectar e inicia sesión en la página que se abre.',
                'E_MS_ENTRA_TIMEOUT'
              )
            ),
          INTERACTIVE_TIMEOUT_MS
        )
        timer.unref?.()
      })
      try {
        const result = await Promise.race([
          entry.app.acquireTokenInteractive({
            scopes: list,
            openBrowser: opener,
            ...(this.loginHint ? { loginHint: this.loginHint } : {}),
            successTemplate: page(
              'Sesión iniciada',
              'Ya puedes cerrar esta pestaña y volver a Vortaq.'
            ),
            errorTemplate: page('No se pudo iniciar sesión', 'Vuelve a Vortaq para ver el motivo.')
          }),
          timeout
        ])
        entry.account = result.account
        return toAccessToken(result)
      } finally {
        clearTimeout(timer)
      }
    })()
    entry.pending = signIn
    try {
      return await signIn
    } finally {
      entry.pending = null
    }
  }
}

/* ---------- Azure CLI ---------- */

const SCOPE_PATTERN = /^https:\/\/[A-Za-z0-9.-]+\/\.default$/
const TENANT_PATTERN = /^[A-Za-z0-9.-]{1,128}$/

/** Folders the Azure CLI installs into, after PATH (GUI apps on macOS get a short PATH). */
function azCandidates(env: NodeJS.ProcessEnv): string[] {
  const windows = process.platform === 'win32'
  const names = windows ? ['az.cmd', 'az.bat', 'az.exe'] : ['az']
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  if (windows) {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']])
      if (base) dirs.push(join(base, 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin'))
  } else
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin')
  return dirs.flatMap((d) => names.map((n) => join(d, n)))
}

export function findAzureCli(env: NodeJS.ProcessEnv = process.env): string | null {
  return azCandidates(env).find((p) => existsSync(p)) ?? null
}

/** Parses `az account get-access-token --output json`. */
export function parseAzureCliToken(stdout: string): AccessToken {
  const data = JSON.parse(stdout) as {
    accessToken?: string
    expires_on?: number | string
    expiresOn?: string
  }
  if (!data.accessToken) throw new Error('missing accessToken')
  const epoch = Number(data.expires_on)
  const expires =
    Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : Date.parse(data.expiresOn ?? '')
  return {
    token: data.accessToken,
    expiresOnTimestamp: Number.isFinite(expires) ? expires : Date.now() + 5 * 60_000
  }
}

/** Tokens of the Azure CLI by tenant and scope, reused until 2 minutes before they expire. */
const cliTokens = new Map<string, AccessToken>()

class AzureCliCredential implements TokenCredential {
  constructor(private readonly tenant: string) {}

  async getToken(scopes: string | string[]): Promise<AccessToken | null> {
    const scope = scopesOf(scopes)[0] ?? AZURE_SQL_SCOPE
    const key = `${this.tenant}|${scope}`
    const cached = cliTokens.get(key)
    if (cached && cached.expiresOnTimestamp - Date.now() > 120_000) return cached
    const token = await this.fromCli(scope)
    cliTokens.set(key, token)
    return token
  }

  private async fromCli(scope: string): Promise<AccessToken> {
    if (!SCOPE_PATTERN.test(scope))
      throw new MsUserError('Ámbito de Microsoft Entra no válido', 'E_MS_ENTRA')
    if (this.tenant && !TENANT_PATTERN.test(this.tenant))
      throw new MsUserError('El inquilino (tenant) de Microsoft Entra no es válido', 'E_MS_ENTRA')
    const az = findAzureCli()
    if (!az)
      throw new MsUserError(
        'No se encontró la CLI de Azure («az»). Instálala, inicia sesión con «az login» y vuelve a conectar.',
        'E_MS_AZ_MISSING'
      )
    const args = ['account', 'get-access-token', '--output', 'json', '--scope', scope]
    if (this.tenant) args.push('--tenant', this.tenant)
    const stdout = await new Promise<string>((resolve, reject) => {
      const done = (err: Error | null, out: string, errOut: string): void => {
        if (!err) resolve(out)
        else if (/az login|AADSTS|not logged in|Please run/i.test(errOut))
          reject(
            new MsUserError(
              'La CLI de Azure no tiene una sesión válida para este inquilino: ejecuta «az login» (con --tenant si hace falta) y vuelve a conectar.',
              'E_MS_AZ_LOGIN'
            )
          )
        else
          reject(
            new MsUserError(
              `La CLI de Azure no pudo dar un token (${errOut.split('\n')[0]?.slice(0, 200) || err.message}).`,
              'E_MS_AZ'
            )
          )
      }
      const options = { encoding: 'utf8' as const, timeout: 30_000, windowsHide: true }
      // az.cmd needs cmd.exe; every argument was validated above (no quotes or metacharacters).
      if (/\.(cmd|bat)$/i.test(az))
        execFile(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/s', '/c', `"${az}" ${args.join(' ')}`],
          options,
          (e, o, se) => done(e, o, se)
        )
      else execFile(az, args, options, (e, o, se) => done(e, o, se))
    })
    try {
      return parseAzureCliToken(stdout)
    } catch {
      throw new MsUserError('La CLI de Azure devolvió una respuesta que no se entiende.', 'E_MS_AZ')
    }
  }
}

/* ---------- entry point ---------- */

/** The TokenCredential of a connection's Entra sign-in method. */
export function entraCredential(
  config: Pick<ConnectionInput, 'username'>,
  options: SqlServerOptions,
  secret: string
): TokenCredential {
  const tenant = options.tenantId.trim()
  const clientId = options.clientId.trim()
  switch (options.auth) {
    case 'entra-interactive': {
      const id = clientId || VORTAQ_ENTRA_CLIENT_ID
      if (!id)
        throw new MsUserError(
          'El inicio de sesión de Microsoft en el navegador necesita el «ID de aplicación» de una aplicación pública registrada en Microsoft Entra (pídelo al administrador de Azure), o usa la CLI de Azure.',
          'E_MS_ENTRA_CLIENT'
        )
      return new InteractiveCredential(id, tenant, config.username.trim())
    }
    case 'entra-azure-cli':
      return new AzureCliCredential(tenant)
    case 'entra-service-principal':
      if (!tenant || !clientId || !secret)
        throw new MsUserError(
          'Una aplicación de Microsoft Entra necesita el inquilino (tenant), el ID de aplicación y su secreto.',
          'E_MS_ENTRA_SP'
        )
      return new ClientSecretCredential(tenant, clientId, secret)
    default:
      throw new MsUserError('Método de Microsoft Entra desconocido', 'E_MS_ENTRA')
  }
}

/**
 * Gets the first token before tedious connects: the browser sign-in can take
 * minutes, longer than the connection timeout that covers tedious's login.
 */
export async function warmUpEntra(credential: TokenCredential): Promise<void> {
  await credential.getToken(AZURE_SQL_SCOPE)
}
