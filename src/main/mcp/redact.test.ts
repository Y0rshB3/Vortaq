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
    expect(redact('connect ECONNREFUSED 127.0.0.1:5432')).toBe('connect ECONNREFUSED [ip]')
    expect(redact('connect ECONNREFUSED ::1:5432')).toBe('connect ECONNREFUSED [ip]')
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
