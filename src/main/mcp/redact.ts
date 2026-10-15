/**
 * Redaction of every message the MCP server returns to an agent (errors,
 * PostgreSQL notices). Driver and network errors quote where they tried to
 * connect ("connect ECONNREFUSED 10.0.0.5:5432", "Access denied for user
 * 'app'@'10.0.0.9'", "unable to open database file /Users/ana/data.db"): the
 * connection's host, port, user, SSH host and user, file paths, any URI and
 * any IP address are replaced by placeholders before the text leaves Vortaq.
 * Secrets are removed too, should a driver ever echo one.
 */
import type { ConnectionConfig } from '@shared/types'

export type Redactor = (text: string) => string

const HOST = '[host]'
const PORT = '[puerto]'
const USER = '[usuario]'
const PATH = '[ruta]'
const URI = '[uri]'
const IP = '[ip]'
const SECRET = '[secreto]'

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface Term {
  value: string
  replacement: string
}

/**
 * A literal value as a pattern: values of 3+ characters anywhere on word
 * boundaries; shorter ones only when quoted ('a', "a", `a`), so a one-letter
 * user does not turn every "a" of a message into a placeholder.
 */
function termPattern(term: Term, minBare = 3): RegExp {
  const v = escapeRegExp(term.value)
  if (term.value.length < minBare) return new RegExp(`(['"\`])${v}\\1`, 'gi')
  const before = /^\w/.test(term.value) ? '(?<![\\w])' : ''
  const after = /\w$/.test(term.value) ? '(?![\\w])' : ''
  return new RegExp(`${before}${v}${after}`, 'gi')
}

/**
 * A path, its folder (it also reveals the user) and its file name (drivers
 * often quote just the name: "Archivo no encontrado: datos.db").
 */
function pathVariants(path: string, withName = true): string[] {
  const out = new Set<string>()
  const clean = path.trim()
  if (!clean) return []
  out.add(clean)
  out.add(clean.replace(/\\/g, '/'))
  const dir = clean.replace(/[\\/][^\\/]*$/, '')
  if (dir && dir !== clean && dir.length > 1) out.add(dir)
  const file = clean.split(/[\\/]/).pop() ?? ''
  if (withName && file && file !== clean && file.length >= 3) out.add(file)
  return [...out]
}

/** Values of a connection that must never reach an agent. */
function termsOf(config: ConnectionConfig | null, secrets: readonly string[]): Term[] {
  const terms: Term[] = []
  const add = (value: string | undefined | null, replacement: string): void => {
    const v = value?.trim()
    if (v) terms.push({ value: v, replacement })
  }
  for (const s of secrets) if (s && s.length >= 3) terms.push({ value: s, replacement: SECRET })
  if (config) {
    add(config.host, HOST)
    add(config.username, USER)
    if (config.ssh) {
      add(config.ssh.host, HOST)
      add(config.ssh.username, USER)
      for (const p of pathVariants(config.ssh.privateKeyPath ?? '')) add(p, PATH)
    }
    for (const key of ['caCertPath', 'clientCertPath', 'clientKeyPath'] as const)
      for (const p of pathVariants(config.ssl?.[key] ?? '')) add(p, PATH)
    for (const m of config.mongo?.members ?? []) add(m.host, HOST)
    for (const p of pathVariants(config.sqlite?.filePath ?? '')) add(p, PATH)
    for (const a of config.sqlite?.attached ?? [])
      for (const p of pathVariants(a.filePath)) add(p, PATH)
  }
  // Longest first: a path is replaced before the folder it contains.
  return terms.sort((a, b) => b.value.length - a.value.length)
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

/**
 * What is removed from successful answers (rows, documents, values): the
 * connection's secrets, its non-loopback hosts (also the SSH host and MongoDB
 * members) and full file paths. Narrower than the error redactor on purpose:
 * user names, URIs, IPs, loopback hosts and file names stay, because they are
 * ordinary data in many tables and replacing them would change query results.
 */
function dataTermsOf(config: ConnectionConfig | null, secrets: readonly string[]): Term[] {
  const terms: Term[] = []
  const add = (value: string | undefined | null, replacement: string): void => {
    const v = value?.trim()
    if (v && v.length >= 3 && !LOOPBACK.has(v.toLowerCase())) terms.push({ value: v, replacement })
  }
  for (const s of secrets) add(s, SECRET)
  if (config) {
    add(config.host, HOST)
    if (config.ssh?.enabled) add(config.ssh.host, HOST)
    for (const m of config.mongo?.members ?? []) add(m.host, HOST)
    const paths = [
      config.sqlite?.filePath,
      ...(config.sqlite?.attached ?? []).map((a) => a.filePath),
      config.ssh?.privateKeyPath,
      config.ssl?.caCertPath,
      config.ssl?.clientCertPath,
      config.ssl?.clientKeyPath
    ]
    for (const p of paths) for (const v of pathVariants(p ?? '', false)) add(v, PATH)
  }
  return terms.sort((a, b) => b.value.length - a.value.length)
}

/** Patterns that reveal network or file locations whatever the connection. */
const GENERIC: [RegExp, string][] = [
  // URIs (mongodb://user:pass@host, postgres://…, file:///…, ssh://…)
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>()]+/gi, URI],
  // Host names after network error codes (DNS, refused, unreachable…), with an optional port
  [
    /\b(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN)(\s+)(?:\[[0-9a-f:.]+\]|[\w.-]+)(?::\d{1,5})?/gi,
    `$1$2${HOST}`
  ],
  // Quoted host names of driver messages: host name "x", could not translate host name "x",
  // no pg_hba.conf entry for host "x", Host 'x' is not allowed…, address: 'x:27017', hostname 'x'
  [
    /\b((?:host(?:\s*name)?|address|hostname|server|member)\s*[:=]?\s*)(["'])[^"'\s]+\2/gi,
    `$1$2${HOST}$2`
  ],
  // A quoted name:port (MongoDB members such as 'mongo-2:27017')
  [/(["'])[A-Za-z][\w.-]*:\d{2,5}\1/g, `$1${HOST}:${PORT}$1`],
  // MySQL account notation 'user'@'host'
  [/'[^'\s]*'@'[^'\s]*'/g, `'${USER}'@'${HOST}'`],
  // user@host
  [/\b[\w.+-]+@(?:[a-z0-9-]+\.)+[a-z0-9-]+\b/gi, `${USER}@${HOST}`],
  // IPv4, with an optional port
  [/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\w.])/g, IP],
  // IPv6 with '::' or 4+ groups (never a time like 14:51:20), optionally bracketed with a port
  [/\[?(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])\]?(?::\d{1,5})?/gi, IP],
  // host:port with a dotted name or localhost
  [/(?<![\w.-])(?:localhost|(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*):\d{2,5}(?!\d)/gi, `${HOST}:${PORT}`],
  // Absolute paths: /Users/…, /home/…, C:\…, \\server\share
  [/(?:[A-Za-z]:\\|\\\\)[^\s'"<>|*?]+/g, PATH],
  [
    /(?<![\w.])\/(?:Users|home|private|var|tmp|opt|mnt|Volumes|root|etc|srv|data)\/[^\s'"<>]*/g,
    PATH
  ]
]

/** IPv6-looking text that is really something else (`::` alone, a lone colon pair). */
function looksLikeIpv6(text: string): boolean {
  const groups = text.replace(/^\[|\](?::\d+)?$/g, '').split(':')
  return text.includes('::') ? groups.some((g) => g !== '') : groups.length >= 4
}

/**
 * The redactor of one connection (null: only the generic patterns). `secrets`
 * are the decrypted passwords of the connection, kept in memory only.
 */
export function redactorFor(
  config: ConnectionConfig | null,
  secrets: readonly string[] = []
): Redactor {
  const terms = termsOf(config, secrets).map((t) => {
    // User names are always removed from errors (from 2 characters on word boundaries);
    // other short values only when quoted, keeping the quotes around the placeholder.
    const minBare = t.replacement === USER ? 2 : 3
    return [
      termPattern(t, minBare),
      t.value.length < minBare ? `$1${t.replacement}$1` : t.replacement
    ] as const
  })
  const port = config?.port && config.port > 0 ? String(config.port) : null
  const ports = [config?.ssh?.enabled ? config.ssh.port : null, port ? Number(port) : null]
    .filter((p): p is number => typeof p === 'number' && p > 0)
    .map((p) => String(p))
  return (input: string): string => {
    let text = String(input ?? '')
    for (const [pattern, replacement] of terms) text = text.replace(pattern, replacement)
    for (const [pattern, replacement] of GENERIC) {
      if (replacement !== IP) {
        text = text.replace(pattern, replacement)
        continue
      }
      text = text.replace(pattern, (match) =>
        match.includes(':') && !/\d+\.\d+/.test(match) && !looksLikeIpv6(match) ? match : IP
      )
    }
    for (const p of [...new Set(ports)]) {
      text = text
        .replace(new RegExp(`(\\[host\\]|\\[ip\\]|localhost):${p}(?!\\d)`, 'gi'), `$1:${PORT}`)
        .replace(new RegExp(`\\b(port|puerto)(\\s*[:=]?\\s*)${p}(?!\\d)`, 'gi'), `$1$2${PORT}`)
    }
    return text
  }
}

/**
 * The scrubber of successful answers of one connection (see dataTermsOf):
 * identity when there is nothing to remove.
 */
export function dataScrubberFor(
  config: ConnectionConfig | null,
  secrets: readonly string[] = []
): Redactor {
  const terms = dataTermsOf(config, secrets).map((t) => [termPattern(t), t.replacement] as const)
  // The connection's user names only where a value IS the account (CURRENT_USER, USER():
  // `app`, `app@10.0.0.9`): anywhere else they may be ordinary words of the data.
  const users = [config?.username, config?.ssh?.enabled ? config.ssh.username : null]
    .map((u) => u?.trim() ?? '')
    .filter((u) => u.length > 0)
  if (!terms.length && !users.length) return (text) => text
  return (input: string): string => {
    for (const user of users) {
      if (input === user) return USER
      if (input.startsWith(`${user}@`)) return `${USER}@${HOST}`
    }
    let text = input
    for (const [pattern, replacement] of terms) text = text.replace(pattern, replacement)
    return text
  }
}

/** Generic redaction (no connection known). */
export const redactGeneric: Redactor = redactorFor(null)
