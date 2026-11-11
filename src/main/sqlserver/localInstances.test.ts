import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { localInstanceLabel, localInstanceSteps } from '@shared/sqlserver/local'
import {
  majorFromPath,
  parseBrowserResponse,
  parseScQuery,
  parseServicesJson,
  queryBrowser,
  scanLocalSqlServers,
  tcpOpen,
  type BrowserInstance,
  type LocalScanDeps,
  type WindowsService
} from './localInstances'

const EXPRESS: WindowsService = {
  name: 'MSSQL$SQLEXPRESS',
  running: true,
  path: '"C:\\Program Files\\Microsoft SQL Server\\MSSQL16.SQLEXPRESS\\MSSQL\\Binn\\sqlservr.exe" -sSQLEXPRESS'
}

function deps(over: Partial<LocalScanDeps> = {}): LocalScanDeps {
  return {
    platform: 'win32',
    env: { USERDOMAIN: 'PC-ANA', COMPUTERNAME: 'PC-ANA' },
    userName: () => 'ana',
    services: async () => [EXPRESS],
    browser: async () => null,
    tcpOpen: async () => false,
    ...over
  }
}

/** An SVR_RESP packet as SQL Server Browser sends it. */
function browserPacket(text: string): Buffer {
  const body = Buffer.from(text, 'latin1')
  const head = Buffer.alloc(3)
  head[0] = 0x05
  head.writeUInt16LE(body.length, 1)
  return Buffer.concat([head, body])
}

describe('local SQL Server instances: parsing', () => {
  it('reads PowerShell’s JSON of the services (one object or a list)', () => {
    expect(
      parseServicesJson(
        '\uFEFF{"Name":"MSSQL$SQLEXPRESS","State":"Running","PathName":"C:\\\\x\\\\MSSQL16.SQLEXPRESS\\\\y"}'
      )
    ).toEqual([{ name: 'MSSQL$SQLEXPRESS', running: true, path: 'C:\\x\\MSSQL16.SQLEXPRESS\\y' }])
    expect(
      parseServicesJson(
        '[{"Name":"MSSQLSERVER","State":"Stopped","PathName":null},{"Name":"SQLBrowser","State":"Running"}]'
      )
    ).toEqual([
      { name: 'MSSQLSERVER', running: false, path: '' },
      { name: 'SQLBrowser', running: true, path: '' }
    ])
    expect(parseServicesJson('  ')).toEqual([])
    expect(majorFromPath(EXPRESS.path)).toBe(16)
  })

  it('reads sc.exe in English and in Spanish', () => {
    const english = [
      'SERVICE_NAME: MSSQL$SQLEXPRESS',
      'DISPLAY_NAME: SQL Server (SQLEXPRESS)',
      '        TYPE               : 10  WIN32_OWN_PROCESS',
      '        STATE              : 4  RUNNING',
      '        WIN32_EXIT_CODE    : 0  (0x0)',
      '',
      'SERVICE_NAME: SQLBrowser',
      '        TYPE               : 10  WIN32_OWN_PROCESS',
      '        STATE              : 1  STOPPED',
      'SERVICE_NAME: Spooler',
      '        STATE              : 4  RUNNING'
    ].join('\r\n')
    expect(parseScQuery(english)).toEqual([
      { name: 'MSSQL$SQLEXPRESS', running: true, path: '' },
      { name: 'SQLBrowser', running: false, path: '' }
    ])
    const spanish = [
      'NOMBRE_SERVICIO: MSSQLSERVER',
      'NOMBRE_MOSTRAR: SQL Server (MSSQLSERVER)',
      '        TIPO               : 10  WIN32_OWN_PROCESS',
      '        ESTADO             : 4  RUNNING'
    ].join('\r\n')
    expect(parseScQuery(spanish)).toEqual([{ name: 'MSSQLSERVER', running: true, path: '' }])
  })

  it('reads SQL Server Browser’s answer: instances, TCP port or none, version', () => {
    const packet = browserPacket(
      'ServerName;PC-ANA;InstanceName;SQLEXPRESS;IsClustered;No;Version;16.0.1000.6;np;\\\\PC-ANA\\pipe\\MSSQL$SQLEXPRESS\\sql\\query;;' +
        'ServerName;PC-ANA;InstanceName;MSSQLSERVER;IsClustered;No;Version;15.0.2000.5;tcp;1433;;'
    )
    expect(parseBrowserResponse(packet)).toEqual<BrowserInstance[]>([
      { instance: 'SQLEXPRESS', tcpPort: null, version: '16.0.1000.6' },
      { instance: '', tcpPort: 1433, version: '15.0.2000.5' }
    ])
    expect(parseBrowserResponse(Buffer.from([0x04, 0, 0]))).toEqual([])
  })
})

describe('local SQL Server instances: the scan', () => {
  it('does nothing outside Windows', async () => {
    const scan = await scanLocalSqlServers(deps({ platform: 'darwin' }))
    expect(scan).toMatchObject({ supported: false, instances: [], windowsUser: '' })
  })

  it('an Express instance answering on 1433: TCP on, port, version and the Windows account', async () => {
    const scan = await scanLocalSqlServers(deps({ tcpOpen: async (port) => port === 1433 }))
    expect(scan).toMatchObject({
      supported: true,
      browserRunning: false,
      windowsDomain: 'PC-ANA',
      windowsUser: 'ana',
      problem: null
    })
    expect(scan.instances).toEqual([
      {
        instance: 'SQLEXPRESS',
        running: true,
        version: '2022',
        configManager: 'SQLServerManager16.msc',
        tcp: 'enabled',
        tcpPort: 1433
      }
    ])
    expect(localInstanceSteps(scan.instances[0])).toEqual([])
  })

  it('TCP/IP off as SQL Server Browser reports it, with the steps to turn it on', async () => {
    const scan = await scanLocalSqlServers(
      deps({
        services: async () => [EXPRESS, { name: 'SQLBrowser', running: true, path: '' }],
        browser: async () => [{ instance: 'SQLEXPRESS', tcpPort: null, version: '16.0.1000.6' }]
      })
    )
    expect(scan.browserRunning).toBe(true)
    expect(scan.instances[0]).toMatchObject({ tcp: 'disabled', tcpPort: null })
    const steps = localInstanceSteps(scan.instances[0])
    expect(steps[0]).toContain('SQLServerManager16.msc')
    expect(steps.join(' ')).toMatch(/Protocolos de SQLEXPRESS › TCP\/IP.*IPAll.*1433.*Reiniciar/)
  })

  it('unknown TCP when nothing says (Browser stopped, 1433 closed), and a stopped service', async () => {
    const scan = await scanLocalSqlServers(
      deps({
        services: async () => [
          EXPRESS,
          { name: 'MSSQLSERVER', running: false, path: 'C:\\x\\MSSQL15.MSSQLSERVER\\y' },
          { name: 'MSSQLFDLauncher$SQLEXPRESS', running: true, path: '' }
        ]
      })
    )
    expect(scan.instances.map((i) => [localInstanceLabel(i), i.running, i.tcp, i.version])).toEqual(
      [
        ['Instancia predeterminada (MSSQLSERVER)', false, 'unknown', '2019'],
        ['SQLEXPRESS', true, 'unknown', '2022']
      ]
    )
    expect(localInstanceSteps(scan.instances[0])[0]).toMatch(/está detenido/)
  })

  it('explains when the service list cannot be read', async () => {
    const scan = await scanLocalSqlServers(
      deps({
        services: async () => {
          throw new Error('Access denied')
        }
      })
    )
    expect(scan.problem).toMatch(/servicios de Windows \(Access denied\)/)
  })

  it('probes a TCP port and gives up on a silent SQL Server Browser', async () => {
    const server = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      expect(await tcpOpen(port)).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    expect(await tcpOpen(port)).toBe(false)
    const started = Date.now()
    expect(await queryBrowser(300)).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
