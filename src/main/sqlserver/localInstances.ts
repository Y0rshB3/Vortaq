/**
 * «Buscar servidores en este equipo» (Windows only): the SQL Server instances
 * installed here, whether each one runs and whether it takes TCP connections,
 * so the form can fill host, port and Windows sign-in, or show what to turn on.
 * Electron-free (the editor extension uses it too).
 *
 * Sources, all read-only and none of them another application's private data:
 * - the Windows service list (Win32_Service through PowerShell, `sc.exe` when
 *   PowerShell is blocked): MSSQLSERVER / MSSQL$<instancia>, their state and
 *   program folder (MSSQL16.… = 2022), and SQLBrowser;
 * - SQL Server Browser's own protocol (MS-SQLR CLNT_UCAST_EX on UDP 1434 of
 *   127.0.0.1), which lists each instance with its TCP port when TCP is on;
 * - a TCP connect to 127.0.0.1:1433.
 * The registry and SQL Server's configuration (WMI) are not read.
 */
import { execFile } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { connect } from 'node:net'
import { userInfo } from 'node:os'
import type { LocalSqlServerInstance, LocalSqlServerScan } from '@shared/sqlserver/local'

const VERSIONS: Record<number, string> = {
  17: '2025',
  16: '2022',
  15: '2019',
  14: '2017',
  13: '2016',
  12: '2014',
  11: '2012'
}

export interface WindowsService {
  name: string
  running: boolean
  /** Executable path with arguments, when known. */
  path: string
}

export interface BrowserInstance {
  instance: string
  /** null when the instance has no TCP listener. */
  tcpPort: number | null
  version: string | null
}

export interface LocalScanDeps {
  platform: string
  env: NodeJS.ProcessEnv
  userName: () => string
  services: () => Promise<WindowsService[]>
  browser: () => Promise<BrowserInstance[] | null>
  tcpOpen: (port: number) => Promise<boolean>
}

/* ---------- parsing (pure) ---------- */

/** PowerShell's ConvertTo-Json of Name/State/PathName: one object or an array. */
export function parseServicesJson(text: string): WindowsService[] {
  const trimmed = text.replace(/^﻿/, '').trim()
  if (!trimmed) return []
  const raw: unknown = JSON.parse(trimmed)
  const items = Array.isArray(raw) ? raw : [raw]
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const r = item as { Name?: unknown; State?: unknown; PathName?: unknown }
    if (typeof r.Name !== 'string') return []
    return [
      {
        name: r.Name,
        running: typeof r.State === 'string' && r.State.toLowerCase() === 'running',
        path: typeof r.PathName === 'string' ? r.PathName : ''
      }
    ]
  })
}

/**
 * `sc.exe query state= all`: «SERVICE_NAME: x» then «STATE : 4 RUNNING». The
 * labels are translated on some Windows languages, so only the shape is read:
 * a «<label>: <name>» line, and the state code (4 = running) of the next
 * «<label> : <digit> <word>» line.
 */
export function parseScQuery(text: string): WindowsService[] {
  const out: WindowsService[] = []
  let current: WindowsService | null = null
  let stateRead = false
  for (const line of text.split(/\r?\n/)) {
    const name = /^\s*[A-Z_ÁÉÍÓÚÑ]+\s*:\s*(MSSQLSERVER|MSSQL\$\S+|SQLBrowser)\s*$/i.exec(line)
    if (name) {
      current = { name: name[1], running: false, path: '' }
      out.push(current)
      stateRead = false
      continue
    }
    // TYPE is «10  WIN32_OWN_PROCESS» (two digits), STATE «4  RUNNING» (one).
    const state = /^\s*[A-Z_ÁÉÍÓÚÑ]+\s*:\s*(\d)\s+[A-Z_]+/i.exec(line)
    if (state && current && !stateRead) {
      current.running = state[1] === '4'
      stateRead = true
    }
  }
  return out
}

/** MSSQL16.SQLEXPRESS → 16 (the program folder of the service). */
export function majorFromPath(path: string): number | null {
  const match = /\\MSSQL(\d{2})\./i.exec(path)
  return match ? Number(match[1]) : null
}

/**
 * MS-SQLR SVR_RESP: 0x05, a 2-byte little-endian size, then
 * «ServerName;X;InstanceName;Y;IsClustered;No;Version;16.0…;tcp;1433;np;…;;»
 * with «;;» between instances.
 */
export function parseBrowserResponse(packet: Buffer): BrowserInstance[] {
  if (packet.length < 3 || packet[0] !== 0x05) return []
  const size = packet.readUInt16LE(1)
  const text = packet.subarray(3, 3 + size).toString('latin1')
  const out: BrowserInstance[] = []
  for (const chunk of text.split(';;')) {
    const parts = chunk.split(';')
    const fields = new Map<string, string>()
    for (let i = 0; i + 1 < parts.length; i += 2) fields.set(parts[i].toLowerCase(), parts[i + 1])
    const instance = fields.get('instancename')
    if (!instance) continue
    const port = Number(fields.get('tcp'))
    out.push({
      instance: instance.toUpperCase() === 'MSSQLSERVER' ? '' : instance,
      tcpPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
      version: fields.get('version') ?? null
    })
  }
  return out
}

/** The service name's instance: MSSQLSERVER → '', MSSQL$SQLEXPRESS → SQLEXPRESS. */
function instanceOf(serviceName: string): string | null {
  if (serviceName.toUpperCase() === 'MSSQLSERVER') return ''
  const match = /^MSSQL\$(.+)$/i.exec(serviceName)
  return match ? match[1] : null
}

/* ---------- the scan ---------- */

export async function scanLocalSqlServers(
  deps: LocalScanDeps = windowsDeps()
): Promise<LocalSqlServerScan> {
  const windowsDomain = deps.env.USERDOMAIN?.trim() || deps.env.COMPUTERNAME?.trim() || ''
  const empty: LocalSqlServerScan = {
    supported: deps.platform === 'win32',
    instances: [],
    browserRunning: false,
    windowsDomain,
    windowsUser: deps.platform === 'win32' ? safe(deps.userName) : '',
    problem: null
  }
  if (deps.platform !== 'win32') return empty
  let services: WindowsService[]
  try {
    services = await deps.services()
  } catch (err) {
    return {
      ...empty,
      problem: `No se pudo consultar los servicios de Windows (${err instanceof Error ? err.message : String(err)}). Comprueba en Servicios que «SQL Server (<instancia>)» existe y está en marcha.`
    }
  }
  const browserRunning = services.some((s) => s.name.toLowerCase() === 'sqlbrowser' && s.running)
  const browser = browserRunning ? await deps.browser().catch(() => null) : null
  const engines = services
    .map((s) => ({ service: s, instance: instanceOf(s.name) }))
    .filter((e): e is { service: WindowsService; instance: string } => e.instance !== null)
  const running = engines.filter((e) => e.service.running)
  const port1433 = running.length ? await deps.tcpOpen(1433).catch(() => false) : false

  const instances = engines.map(({ service, instance }): LocalSqlServerInstance => {
    const major = majorFromPath(service.path)
    const listed = browser?.find((b) => b.instance.toUpperCase() === instance.toUpperCase())
    let tcp: LocalSqlServerInstance['tcp'] = 'unknown'
    let tcpPort: number | null = null
    if (listed) {
      tcp = listed.tcpPort ? 'enabled' : 'disabled'
      tcpPort = listed.tcpPort
    } else if (service.running && port1433 && (instance === '' || running.length === 1)) {
      // The default instance, or the only one running, answers on 1433.
      tcp = 'enabled'
      tcpPort = 1433
    }
    const browserMajor = listed?.version ? Number(listed.version.split('.')[0]) : null
    const versionMajor = major ?? (Number.isInteger(browserMajor) ? browserMajor : null)
    return {
      instance,
      running: service.running,
      version: versionMajor ? (VERSIONS[versionMajor] ?? null) : null,
      configManager: versionMajor ? `SQLServerManager${versionMajor}.msc` : null,
      tcp: service.running ? tcp : tcp === 'enabled' ? 'unknown' : tcp,
      tcpPort: service.running ? tcpPort : null
    }
  })
  instances.sort((a, b) => a.instance.localeCompare(b.instance))
  return { ...empty, instances, browserRunning }
}

function safe(fn: () => string): string {
  try {
    return fn()
  } catch {
    return ''
  }
}

/* ---------- the real Windows calls ---------- */

const POWERSHELL_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "Get-CimInstance -ClassName Win32_Service | Where-Object { $_.Name -eq 'MSSQLSERVER' -or $_.Name -like 'MSSQL$*' -or $_.Name -eq 'SQLBrowser' } | Select-Object Name, State, PathName | ConvertTo-Json -Compress"
].join('; ')

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
  })
}

async function windowsServices(): Promise<WindowsService[]> {
  try {
    const out = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      POWERSHELL_SCRIPT
    ])
    return parseServicesJson(out)
  } catch {
    // PowerShell blocked by policy: the plain service list (no program folders).
    return parseScQuery(await run('sc.exe', ['query', 'state=', 'all']))
  }
}

/** CLNT_UCAST_EX (0x03) to SQL Server Browser on 127.0.0.1:1434; null when it does not answer. */
export function queryBrowser(timeoutMs = 1500): Promise<BrowserInstance[] | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    let done = false
    const finish = (value: BrowserInstance[] | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.close()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.on('error', () => finish(null))
    socket.on('message', (packet, remote) => {
      if (remote.address === '127.0.0.1') finish(parseBrowserResponse(packet))
    })
    socket.send(Buffer.from([0x03]), 1434, '127.0.0.1', (err) => {
      if (err) finish(null)
    })
  })
}

export function tcpOpen(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function windowsDeps(): LocalScanDeps {
  return {
    platform: process.platform,
    env: process.env,
    userName: () => userInfo().username,
    services: windowsServices,
    browser: () => queryBrowser(),
    tcpOpen: (port) => tcpOpen(port)
  }
}
