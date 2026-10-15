import { describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import { redactGeneric, redactorFor } from './redact'

function config(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'c1',
    name: 'Ventas',
    color: null,
    environment: 'production',
    host: 'db-ventas.interno.example',
    port: 33306,
    username: 'app_rw',
    savePassword: true,
    customDatabases: [],
    initialQueries: '',
    ssh: {
      enabled: true,
      host: 'bastion.example.org',
      port: 2222,
      username: 'deploy',
      authType: 'key',
      privateKeyPath: '/Users/ana/.ssh/id_ventas',
      savePassword: false
    },
    ssl: { enabled: true, verifyServer: true, caCertPath: 'C:\\certs\\ca-ventas.pem' },
    backupDir: '',
    extraBackupDirs: [],
    createdAt: '',
    updatedAt: '',
    engine: 'mysql',
    ...overrides
  }
}

describe('MCP redactor', () => {
  const redact = redactorFor(config(), ['S3cr3t-pass'])

  it('removes host, port, user and the account notation of driver errors', () => {
    expect(redact('connect ECONNREFUSED db-ventas.interno.example:33306')).toBe(
      'connect ECONNREFUSED [host]:[puerto]'
    )
    expect(redact("Access denied for user 'app_rw'@'172.17.0.1' (using password: YES)")).toBe(
      "Access denied for user '[usuario]'@'[host]' (using password: YES)"
    )
    expect(redact('password authentication failed for user "app_rw"')).toBe(
      'password authentication failed for user "[usuario]"'
    )
    expect(
      redact('No se pudo conectar a Ventas: getaddrinfo ENOTFOUND db-ventas.interno.example')
    ).toBe('No se pudo conectar a Ventas: getaddrinfo ENOTFOUND [host]')
    expect(redact('listen on port 33306 failed')).toBe('listen on port [puerto] failed')
  })

  it('removes the SSH host and user, key and certificate paths, and secrets', () => {
    expect(
      redact(
        'Túnel SSH: deploy@bastion.example.org:2222 rechazó la clave /Users/ana/.ssh/id_ventas'
      )
    ).toBe('Túnel SSH: [usuario]@[host]:[puerto] rechazó la clave [ruta]')
    expect(redact('cannot read C:\\certs\\ca-ventas.pem')).toBe('cannot read [ruta]')
    expect(redact('bad password S3cr3t-pass')).toBe('bad password [secreto]')
  })

  it('removes any URI and IP address, but keeps times and plain numbers', () => {
    expect(redact('mongodb://root:x@10.1.2.3:27017/?authSource=admin is down')).toBe(
      '[uri] is down'
    )
    expect(redact('connect ECONNREFUSED 127.0.0.1:5432')).toBe('connect ECONNREFUSED [host]')
    expect(redact('connect ECONNREFUSED ::1:5432')).toBe('connect ECONNREFUSED [ip]')
    expect(redact('timeout talking to 10.2.3.4:27017')).toBe('timeout talking to [ip]')
    expect(redact('timeout after 2026-03-17 14:51:20.123 (code 1045, 12 rows)')).toBe(
      'timeout after 2026-03-17 14:51:20.123 (code 1045, 12 rows)'
    )
    expect(redact("Table 'tienda.pedidos' doesn't exist")).toBe(
      "Table 'tienda.pedidos' doesn't exist"
    )
  })

  it('removes SQLite file paths and names, also of attached databases', () => {
    const lite = redactorFor(
      config({
        engine: 'sqlite',
        host: '',
        port: 0,
        username: '',
        ssh: { ...config().ssh, enabled: false, host: '', username: '', privateKeyPath: '' },
        sqlite: {
          filePath: '/Users/ana/Datos privados/tienda.db',
          readOnly: false,
          foreignKeys: true,
          busyTimeoutMs: 5000,
          attached: [{ alias: 'aux', filePath: '/Volumes/Disco/aux-2026.sqlite' }]
        } as ConnectionConfig['sqlite']
      })
    )
    expect(lite('unable to open database file: /Users/ana/Datos privados/tienda.db')).toBe(
      'unable to open database file: [ruta]'
    )
    expect(lite('Archivo no encontrado: tienda.db. Búscalo de nuevo')).toBe(
      'Archivo no encontrado: [ruta]. Búscalo de nuevo'
    )
    expect(lite('cannot ATTACH /Volumes/Disco/aux-2026.sqlite')).toBe('cannot ATTACH [ruta]')
  })

  it('bare host names of driver messages are removed even when they are not the configured host', () => {
    const r = redactGeneric
    expect(r('getaddrinfo ENOTFOUND mongo-2.internal')).toBe('getaddrinfo ENOTFOUND [host]')
    expect(r('getaddrinfo EAI_AGAIN dbserver')).toBe('getaddrinfo EAI_AGAIN [host]')
    expect(r('connect ECONNREFUSED replica-b:27018')).toBe('connect ECONNREFUSED [host]')
    expect(r('could not translate host name "pg-primary" to address')).toBe(
      'could not translate host name "[host]" to address'
    )
    expect(r('no pg_hba.conf entry for host "10.1.1.1", user "x", database "y"')).toBe(
      'no pg_hba.conf entry for host "[host]", user "x", database "y"'
    )
    expect(r("Host 'gw-01' is not allowed to connect to this MySQL server")).toBe(
      "Host '[host]' is not allowed to connect to this MySQL server"
    )
    expect(r("Server selection timed out: { address: 'mongo-3:27017' }")).toBe(
      "Server selection timed out: { address: '[host]' }"
    )
    expect(r("member 'mongo-4:27019' is down")).toBe("member '[host]' is down")
    // Ordinary words around them stay.
    expect(r("Table 'tienda.pedidos' doesn't exist")).toBe("Table 'tienda.pedidos' doesn't exist")
  })

  it('users of 2+ characters are always removed from errors; one letter only when quoted', () => {
    expect(redactorFor(config({ username: 'sa' }))('login failed: sa has no access')).toBe(
      'login failed: [usuario] has no access'
    )
    expect(redactorFor(config({ username: 'a' }))("user 'a' denied, a table")).toBe(
      "user '[usuario]' denied, a table"
    )
  })

  it('short users are only removed when quoted', () => {
    const short = redactorFor(
      config({ username: 'sa', host: 'h1', ssh: { ...config().ssh, enabled: false } })
    )
    expect(short("Login failed for user 'sa'. a table")).toBe(
      "Login failed for user '[usuario]'. a table"
    )
  })

  it('the generic redactor still removes URIs, IPs and home paths', () => {
    expect(redactGeneric('postgres://u:p@db/x failed at 192.168.1.20 reading /home/ana/x.db')).toBe(
      '[uri] failed at [ip] reading [ruta]'
    )
  })
})

describe('MCP data scrubber (successful answers)', () => {
  it('removes secrets, non-loopback hosts and full paths, and keeps users, URIs and loopback hosts', async () => {
    const { dataScrubberFor } = await import('./redact')
    const scrub = dataScrubberFor(
      {
        ...({} as ConnectionConfig),
        host: 'db-ventas.interno.example',
        username: 'app_rw',
        ssh: { enabled: true, host: 'bastion.example.org' } as ConnectionConfig['ssh'],
        sqlite: { filePath: '/Users/ana/datos/tienda.db', attached: [] } as never
      },
      ['S3cr3t-pass']
    )
    expect(scrub('db-ventas.interno.example')).toBe('[host]')
    expect(scrub('via bastion.example.org')).toBe('via [host]')
    expect(scrub('/Users/ana/datos/tienda.db')).toBe('[ruta]')
    expect(scrub('the password is S3cr3t-pass')).toBe('the password is [secreto]')
    // The account itself (CURRENT_USER, USER()) goes; the name inside other text stays.
    expect(scrub('app_rw')).toBe('[usuario]')
    expect(scrub('app_rw@10.0.0.9')).toBe('[usuario]@[host]')
    expect(scrub('owner app_rw of the report')).toBe('owner app_rw of the report')
    expect(scrub('https://example.com/x')).toBe('https://example.com/x')
    expect(scrub('tienda.db')).toBe('tienda.db')
    const local = dataScrubberFor({
      ...({} as ConnectionConfig),
      host: 'localhost',
      username: 'root'
    })
    expect(local('smtp on localhost for root')).toBe('smtp on localhost for root')
    expect(local('root@localhost')).toBe('[usuario]@[host]')
    expect(local('rooted')).toBe('rooted')
  })
})
