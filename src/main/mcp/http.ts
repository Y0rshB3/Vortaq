/**
 * Vortaq's MCP server over Streamable HTTP on the loopback interface, for a
 * host that keeps the server inside its own process: the editor extension
 * (agents connect to http://127.0.0.1:<port>/mcp while the editor is open).
 * The desktop app keeps `Vortaq --mcp` over stdio. Electron-free.
 *
 * Every request, before the SDK sees it:
 * - Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding);
 * - a web page's Origin (http, https, null, a webview) is refused: only clients
 *   that send none, or the editor's own window, get through;
 * - `Authorization: Bearer <key>` must match the current key (constant-time
 *   comparison of digests); the key can change while the server runs;
 * - only POST /mcp, stateless: a new McpServer and transport per request, plain
 *   JSON answers (no sessions to expire, any editor window can take over the port);
 * - bodies up to MAX_BODY_BYTES and at most MAX_CONCURRENT requests at once.
 * GET /vortaq/ping?nonce=… lets another editor window tell «Vortaq with my key
 * already serves this port» from «another program» without sending the key: the
 * answer is an HMAC of the nonce with the key (a squatter on the port learns
 * nothing, and cannot fake the proof).
 * Nothing here logs the key, a body, SQL or values.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { getLogger } from '../log'
import type { McpRuntime } from './runtime'
import { createMcpServer, type McpServerOptions } from './server'

export const MCP_HTTP_HOST = '127.0.0.1'
export const MCP_HTTP_PATH = '/mcp'
export const MCP_PING_PATH = '/vortaq/ping'
/** A script for execute_sql can be long; JSON-RPC requests are otherwise small. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024
export const MAX_CONCURRENT = 8

/** Nonces the ping accepts: what pingMcpHttp sends (24 base64url characters), with room. */
const NONCE = /^[A-Za-z0-9_-]{16,64}$/

/** The ping's proof that the server holds `key`: never the key itself. */
export function pingProof(key: string, port: number, nonce: string): string {
  return createHmac('sha256', key).update(`vortaq-ping:${port}:${nonce}`).digest('base64url')
}

export const MCP_KEY_REFUSED =
  'Falta la clave de Vortaq o ya no es la actual: copia de nuevo la configuración MCP del cliente desde Vortaq.'

const log = getLogger('mcp.http')

export interface McpHttpOptions extends McpServerOptions {
  /** Port to listen on (0 = any free port). */
  port: number
  /** The current key, read on every request; null refuses everything. */
  key: () => string | null
}

export interface McpHttpServer {
  readonly port: number
  readonly url: string
  close(): Promise<void>
}

export function mcpHttpUrl(port: number): string {
  return `http://${MCP_HTTP_HOST}:${port}${MCP_HTTP_PATH}`
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

/** `Authorization: Bearer <key>` carries exactly the current key. */
export function keyMatches(header: string | undefined, key: string | null): boolean {
  if (!key || !header) return false
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header)
  if (!match) return false
  return timingSafeEqual(digest(match[1]), digest(key))
}

/** Only the loopback names of this very port (a rebinding DNS name never matches). */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase()
  return h === `${MCP_HTTP_HOST}:${port}` || h === `localhost:${port}`
}

/** MCP clients send no Origin; the editor's own window is the only page allowed. */
export function originAllowed(origin: string | undefined): boolean {
  return origin === undefined || origin === 'vscode-file://vscode-app'
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra = {}): void {
  if (res.headersSent) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra
  })
  res.end(text)
}

/** A JSON-RPC error with no id: what the SDK answers before a request is understood. */
function refuse(res: ServerResponse, status: number, message: string, code = -32000): void {
  // After a body too large the connection is not reused.
  const extra = status === 413 ? { Connection: 'close' } : {}
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, extra)
}

class BodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tooLarge = (): BodyError => new BodyError(413, -32000, 'La petición es demasiado grande.')
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      // The rest is read and dropped so the answer reaches the client.
      req.resume()
      reject(tooLarge())
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        failed = true
        chunks.length = 0
        reject(tooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (err) => {
      if (!failed) reject(err)
      failed = true
    })
    req.on('end', () => {
      if (failed) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new BodyError(400, -32700, 'La petición no es JSON válido.'))
      }
    })
  })
}

/**
 * Starts the server; rejects with the listen error (EADDRINUSE…) so the host
 * can decide whether another window of its own already serves that port.
 */
export function startMcpHttpServer(
  runtime: McpRuntime,
  options: McpHttpOptions
): Promise<McpHttpServer> {
  let port = options.port
  let active = 0

  async function serveMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (active >= MAX_CONCURRENT) {
      refuse(
        res,
        503,
        'Vortaq está atendiendo demasiadas peticiones a la vez; vuelve a intentarlo.'
      )
      return
    }
    active++
    res.once('close', () => active--)
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (err) {
      if (err instanceof BodyError) refuse(res, err.status, err.message, err.code)
      else req.destroy()
      return
    }
    const server = createMcpServer(runtime, options)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    res.once('close', () => {
      void transport.close().catch(() => undefined)
      void server.close().catch(() => undefined)
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host, port)) {
      refuse(res, 403, 'Vortaq solo atiende peticiones a 127.0.0.1 o localhost.')
      return
    }
    if (!originAllowed(req.headers.origin)) {
      refuse(res, 403, 'Vortaq no atiende peticiones de páginas web.')
      return
    }
    const path = (req.url ?? '').split('?')[0]
    if (path !== MCP_HTTP_PATH && path !== MCP_PING_PATH) {
      refuse(res, 404, 'No encontrado.')
      return
    }
    if (path === MCP_PING_PATH) {
      const nonce = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('nonce') ?? ''
      const key = options.key()
      if (req.method !== 'GET' || !NONCE.test(nonce) || !key) {
        refuse(res, 400, 'Petición de comprobación no válida.')
        return
      }
      sendJson(res, 200, { vortaq: 'mcp', proof: pingProof(key, port, nonce) })
      return
    }
    if (!keyMatches(req.headers.authorization, options.key())) {
      log.debug('MCP request refused: missing or wrong key')
      refuse(res, 401, MCP_KEY_REFUSED)
      return
    }
    if (req.method !== 'POST') {
      refuse(res, 405, 'Método no permitido: este servidor MCP solo acepta POST.', -32000)
      return
    }
    await serveMcp(req, res)
  }

  const http = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.warn(`MCP request failed: ${err instanceof Error ? err.name : 'error'}`)
      refuse(res, 500, 'Error interno de Vortaq.')
    })
  })
  // Queries may run up to 120 s; the default request timeout (300 s) covers them.
  http.headersTimeout = 30_000

  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    http.once('error', onError)
    http.listen(options.port, MCP_HTTP_HOST, () => {
      http.off('error', onError)
      http.on('error', (err) => log.warn(`MCP HTTP server error: ${err.message}`))
      const address = http.address()
      port = typeof address === 'object' && address ? address.port : options.port
      log.info(`MCP HTTP server listening on ${MCP_HTTP_HOST}:${port}`)
      resolve({
        port,
        url: mcpHttpUrl(port),
        close: () =>
          new Promise<void>((done) => {
            http.close(() => done())
            http.closeAllConnections()
            log.info('MCP HTTP server stopped')
          })
      })
    })
  })
}

/**
 * True when a Vortaq MCP server that holds `key` answers on `port` (false:
 * nothing listens, another program, or Vortaq with another key). The key never
 * leaves this process: the server must return the HMAC of a fresh nonce. The
 * whole exchange has one deadline and a small answer size, so a program that
 * dribbles bytes cannot hold the caller.
 */
export function pingMcpHttp(port: number, key: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const nonce = randomBytes(18).toString('base64url')
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      req.destroy()
      resolve(value)
    }
    const req = request(
      {
        host: MCP_HTTP_HOST,
        port,
        path: `${MCP_PING_PATH}?nonce=${nonce}`,
        method: 'GET',
        headers: { Host: `${MCP_HTTP_HOST}:${port}` }
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > 4096) finish(false)
          else chunks.push(c)
        })
        res.on('end', () => {
          if (res.statusCode !== 200) return finish(false)
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              vortaq?: unknown
              proof?: unknown
            }
            const expected = Buffer.from(pingProof(key, port, nonce))
            const proof = Buffer.from(typeof body?.proof === 'string' ? body.proof : '')
            finish(
              body?.vortaq === 'mcp' &&
                proof.length === expected.length &&
                timingSafeEqual(proof, expected)
            )
          } catch {
            finish(false)
          }
        })
        res.on('error', () => finish(false))
      }
    )
    const deadline = setTimeout(() => finish(false), timeoutMs)
    req.on('error', () => finish(false))
    req.end()
  })
}
