import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encryptNcxAes, encryptNcxBlowfish } from '../navicat/ncxCipher'
import {
  DBEAVER_INVALID_MESSAGE,
  DBEAVER_USER_WARNING,
  parseDbeaverDataSources,
  parseJdbcUrl,
  parsePostgresJdbcUrl,
  parseSqliteJdbcUrl
} from './dbeaver'
import {
  HTTP_TUNNEL_WARNING,
  NCX_INVALID_MESSAGE,
  NCX_NO_PASSWORDS_NOTE,
  NCX_PASSWORDS_NOTE,
  decodeNcxSecret,
  parseNcx
} from './ncx'
import { IMPORT_FIXTURES } from './testing'
import { FOREIGN_PATH_WARNING, SQLITE_ENCRYPTED_REASON, sqliteFileReviewWarning } from './types'
import {
  MONGO_KERBEROS_REASON,
  MONGO_RETRY_WRITES_WARNING,
  MONGO_URL_PASSWORD_WARNING,
  isForeignPath,
  multiHostWarning,
  normalizeColor,
  postgresForkReason,
  unknownSslModeWarning
} from './util'
import {
  WORKBENCH_INVALID_MESSAGE,
  WORKBENCH_PASSWORDS_NOTE,
  WORKBENCH_SOCKET_WARNING,
  parseWorkbenchConnections
} from './workbench'

const fixture = (...parts: string[]): string =>
  readFileSync(join(IMPORT_FIXTURES, ...parts), 'utf8')

describe('parseNcx', () => {
  it('reads a Ver 1.4 file without passwords (union schema)', () => {
    const file = parseNcx(fixture('ncx', 'connections-v1.4-nopass.ncx'), 'darwin')
    expect(file.notes).toEqual([NCX_NO_PASSWORDS_NOTE])
    expect(file.connections.map((c) => c.name)).toEqual([
      'Local Dev',
      'Staging Bastion',
      'Reports PG'
    ])
    const [dev, bastion, pg] = file.connections
    expect(dev).toMatchObject({
      key: 'MySQL:Local Dev',
      engine: 'mysql',
      engineLabel: 'MySQL',
      navicatType: 'MySQL',
      host: '127.0.0.1',
      port: 3306,
      username: 'app_user',
      database: null,
      environment: 'local',
      secrets: {},
      warnings: []
    })
    expect(dev.ssh.enabled).toBe(false)
    expect(bastion.ssh).toEqual({
      enabled: true,
      host: 'bastion.example.test',
      port: 2222,
      username: 'ops',
      authType: 'key',
      savePassword: false,
      privateKeyPath: '/Users/tester/.ssh/id_ed25519'
    })
    expect(bastion.ssl).toEqual({
      enabled: true,
      verifyServer: true,
      caCertPath: '/Users/tester/certs/ca.pem',
      clientCertPath: '/Users/tester/certs/client-cert.pem',
      clientKeyPath: '/Users/tester/certs/client-key.pem'
    })
    expect(bastion.port).toBe(3307)
    expect(bastion.environment).toBe('staging')
    expect(pg).toMatchObject({
      engine: 'postgresql',
      engineLabel: 'PostgreSQL',
      navicatType: 'PostgreSQL',
      unsupportedReason: null,
      port: 5432,
      database: 'reports'
    })
  })

  it('reads a Ver 1.5 file where defaults are omitted', () => {
    const file = parseNcx(fixture('ncx', 'connections-v1.5-mixed.ncx'), 'darwin')
    const byName = new Map(file.connections.map((c) => [c.name, c]))
    expect(byName.get('Production Shop')).toMatchObject({
      engine: 'mysql',
      port: 3306,
      environment: 'production',
      ssl: { enabled: false, verifyServer: false }
    })
    const maria = byName.get('Maria Analytics')!
    expect(maria).toMatchObject({
      engine: 'mariadb',
      engineLabel: 'MariaDB',
      navicatType: 'MariaDB'
    })
    expect(maria.warnings).toEqual([])
    expect(maria.ssh).toMatchObject({
      enabled: true,
      host: 'jump.example.test',
      port: 22,
      authType: 'password'
    })
    const win = byName.get('Windows Laptop')!
    expect(win.warnings).toEqual([FOREIGN_PATH_WARNING, HTTP_TUNNEL_WARNING])
    expect(win.ssl.caCertPath).toBe('C:\\Users\\tester\\certs\\ca.pem')
    expect(byName.get('Cache')).toMatchObject({ engine: null, engineLabel: 'Redis', port: 6379 })
    // SQL Server is a regular engine since 2.6.0.
    expect(byName.get('Legacy MSSQL')).toMatchObject({
      engine: 'sqlserver',
      unsupportedReason: null,
      host: 'mssql.example.test',
      port: 1433,
      sqlserver: { encrypt: 'optional', trustServerCertificate: false }
    })
  })

  it('reads SQL Server instances and ports written in the host (.ncx)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.5">
  <Connection ConnectionName="Express" ConnType="SQLSERVER" Host="srv\\SQLEXPRESS" Port="1433" UserName="sa" InitialDatabase="erp" SSL="true" />
  <Connection ConnectionName="Puerto" ConnType="SQLSERVER" Host="tcp:db.example.test,14330" UserName="ana" />
</Connections>`
    const byName = new Map(parseNcx(xml, 'darwin').connections.map((c) => [c.name, c]))
    expect(byName.get('Express')).toMatchObject({
      engine: 'sqlserver',
      host: 'srv',
      port: 1433,
      database: 'erp',
      sqlserver: { instanceName: 'SQLEXPRESS', encrypt: 'mandatory', trustServerCertificate: true }
    })
    expect(byName.get('Puerto')).toMatchObject({ host: 'db.example.test', port: 14330 })
  })

  it('maps MongoDB connections: seeds, SRV, mechanisms and providers', () => {
    const file = parseNcx(fixture('ncx', 'connections-v1.5-mongo.ncx'), 'darwin')
    const byName = new Map(file.connections.map((c) => [c.name, c]))
    expect(byName.get('Mongo Local')).toMatchObject({
      engine: 'mongodb',
      navicatType: 'MongoDB',
      host: '127.0.0.1',
      port: 27017,
      mongo: { topology: 'standalone', srv: false, authMechanism: 'none' }
    })
    const rs = byName.get('Mongo RS Staging')!
    expect(rs).toMatchObject({ host: 'mongo1.example.test', port: 27017, database: 'shop' })
    expect(rs.mongo).toMatchObject({
      topology: 'replicaSet',
      replicaSet: 'rs0',
      members: [
        { host: 'mongo1.example.test', port: 27017 },
        { host: 'mongo2.example.test', port: 27018 }
      ],
      authMechanism: 'scram-sha-256',
      readPreference: 'secondaryPreferred',
      defaultDatabase: 'shop'
    })
    const atlas = byName.get('Atlas Prod')!
    expect(atlas).toMatchObject({ port: 0, ssl: { enabled: true }, environment: 'production' })
    expect(atlas.mongo).toMatchObject({ srv: true, authMechanism: 'default' })
    const doc = byName.get('DocDB')!
    expect(doc.mongo?.retryWrites).toBe(false)
    expect(doc.warnings).toContain(MONGO_RETRY_WRITES_WARNING('Amazon DocumentDB'))
    expect(byName.get('Kerberos Mongo')).toMatchObject({ unsupportedReason: MONGO_KERBEROS_REASON })
  })

  it('decodes AES passwords (Ver 1.5) into the right slots and says the file holds secrets', () => {
    const xml = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.5">
  <Connection ConnectionName="Prod" ConnType="MYSQL" Host="db.example.test" UserName="u" Password="${encryptNcxAes('s3cret-ñ')}"
    SSH="true" SSH_Host="bastion.example.test" SSH_UserName="ops" SSH_AuthenMethod="PUBLICKEY" SSH_PrivateKey="/k"
    SSH_Password="${encryptNcxAes('not-used')}" SSH_Passphrase="${encryptNcxAes('phrase')}"
    SSL="true" SSL_ClientKey="/key.pem" SSL_PEMClientKeyPassword="${encryptNcxAes('pem-pass')}" />
  <Connection ConnectionName="Pwd ssh" ConnType="MYSQL" Host="h" SSH="true" SSH_AuthenMethod="PASSWORD"
    SSH_Password="${encryptNcxAes('ssh-pass')}" SSH_Passphrase="${encryptNcxAes('ignored')}" />
</Connections>`
    const file = parseNcx(xml, 'darwin')
    expect(file.notes).toEqual([NCX_PASSWORDS_NOTE])
    expect(file.connections[0].secrets).toEqual({
      mysql: 's3cret-ñ',
      ssh: 'phrase',
      sslKey: 'pem-pass'
    })
    expect(file.connections[0].ssh.savePassword).toBe(true)
    expect(file.connections[1].secrets).toEqual({ ssh: 'ssh-pass' })
  })

  it('chooses the Blowfish scheme for files older than Ver 1.4, with AES as fallback', () => {
    const bf = encryptNcxBlowfish('old-pass')
    const aes = encryptNcxAes('new-pass')
    expect(decodeNcxSecret(bf, '1.1')).toBe('old-pass')
    expect(decodeNcxSecret(aes, '1.1')).toBe('new-pass')
    expect(decodeNcxSecret(aes, '1.4')).toBe('new-pass')
    expect(decodeNcxSecret(bf, '1.5')).toBe('old-pass')
    expect(decodeNcxSecret('', '1.5')).toBeNull()
    expect(decodeNcxSecret('ZZ', '1.5')).toBeNull()
    const xml = `<Connections Ver="1.1"><Connection ConnectionName="Old" ConnType="MYSQL" Host="h" Password="${bf}"/></Connections>`
    expect(parseNcx(xml).connections[0].secrets).toEqual({ mysql: 'old-pass' })
  })

  it('reads only direct Connection children and skips nameless ones', () => {
    const xml = `<Connections Ver="1.5"><Group><Connection ConnectionName="Nested" ConnType="MYSQL"/></Group>
      <Connection ConnectionName="" ConnType="MYSQL"/><Connection ConnectionName="A" ConnType="MYSQL"/>
      <Connection ConnectionName="A" ConnType="MYSQL"/></Connections>`
    const file = parseNcx(xml)
    expect(file.connections.map((c) => c.key)).toEqual(['MySQL:A', 'MySQL:A#2'])
  })

  it('refuses anything that is not an .ncx', () => {
    expect(() => parseNcx('not xml <')).toThrow(NCX_INVALID_MESSAGE)
    expect(() => parseNcx('<plist version="1.0"><dict/></plist>')).toThrow(NCX_INVALID_MESSAGE)
    expect(() => parseNcx('')).toThrow(NCX_INVALID_MESSAGE)
  })
})

describe('parseDbeaverDataSources (SQL Server)', () => {
  it('imports sqlserver/azure connections from host fields or the JDBC URL', () => {
    const json = JSON.stringify({
      connections: {
        'sqlserver-1': {
          provider: 'sqlserver',
          driver: 'microsoft',
          name: 'ERP',
          configuration: {
            host: 'srv\\SQLEXPRESS',
            port: '1433',
            database: 'erp',
            user: 'sa',
            url: 'jdbc:sqlserver://srv\\SQLEXPRESS:1433;databaseName=erp;encrypt=true;trustServerCertificate=true'
          }
        },
        'azure-1': {
          provider: 'sqlserver',
          driver: 'azure_sql_server',
          name: 'Azure ventas',
          configuration: {
            url: 'jdbc:sqlserver://ventas.database.windows.net:1433;databaseName=ventas;encrypt=true;authentication=ActiveDirectoryInteractive',
            user: 'ana@contoso.com'
          }
        }
      }
    })
    const byName = new Map(
      parseDbeaverDataSources(json, 'linux').connections.map((c) => [c.name, c])
    )
    expect(byName.get('ERP')).toMatchObject({
      engine: 'sqlserver',
      host: 'srv',
      port: 1433,
      database: 'erp',
      username: 'sa',
      sqlserver: { instanceName: 'SQLEXPRESS', encrypt: 'mandatory', trustServerCertificate: true }
    })
    expect(byName.get('Azure ventas')).toMatchObject({
      engine: 'sqlserver',
      host: 'ventas.database.windows.net',
      database: 'ventas',
      username: 'ana@contoso.com',
      sqlserver: { auth: 'entra-interactive' }
    })
  })
})

describe('parseDbeaverDataSources', () => {
  const file = parseDbeaverDataSources(fixture('dbeaver', 'data-sources.json'), 'linux')
  const byName = new Map(file.connections.map((c) => [c.name, c]))

  it('imports MySQL and MariaDB connections without passwords', () => {
    expect(file.notes).toEqual([
      'Las contraseñas no se importan: DBeaver las guarda cifradas. Escríbelas al editar cada conexión.'
    ])
    expect(file.connections.every((c) => Object.keys(c.secrets).length === 0)).toBe(true)
    expect(byName.get('Local MySQL')).toMatchObject({
      key: 'mysql8-18a2b3c4d5e-1f2e3d4c5b6a7980',
      engine: 'mysql',
      host: 'localhost',
      port: 3306,
      username: 'app_user',
      database: 'app_dev',
      environment: 'local',
      color: null,
      warnings: []
    })
    const prod = byName.get('Shop production')!
    expect(prod).toMatchObject({
      environment: 'production',
      color: '#f79f81',
      username: '',
      database: null
    })
    expect(prod.warnings).toEqual([DBEAVER_USER_WARNING])
    expect(prod.ssh).toEqual({
      enabled: true,
      host: 'bastion.example.test',
      port: 2222,
      username: '',
      authType: 'key',
      savePassword: false,
      privateKeyPath: '/home/tester/.ssh/id_rsa'
    })
    const maria = byName.get('Maria staging')!
    expect(maria).toMatchObject({
      engine: 'mariadb',
      engineLabel: 'MariaDB',
      host: 'maria.example.test',
      port: 3307,
      database: 'stats',
      environment: 'staging'
    })
    expect(maria.warnings).toEqual([])
  })

  it('maps PostgreSQL and lists other engines as not importable', () => {
    expect(byName.get('Warehouse')).toMatchObject({
      engine: 'postgresql',
      engineLabel: 'PostgreSQL',
      unsupportedReason: null,
      host: 'pg.example.test',
      port: 5432,
      database: 'warehouse'
    })
    expect(byName.get('Local notes')).toMatchObject({
      engine: 'sqlite',
      engineLabel: 'SQLite',
      unsupportedReason: null,
      host: '',
      port: 0,
      database: '/home/tester/notes.db',
      // The fixture path does not exist on the test machine.
      sqlite: { filePath: '/home/tester/notes.db', pathNeedsReview: true, attached: [] },
      warnings: [sqliteFileReviewWarning('Local notes')]
    })
    expect(byName.get('Warehouse')!.warnings).toEqual([DBEAVER_USER_WARNING])
  })

  it('parses JDBC URLs and refuses other files', () => {
    expect(parseJdbcUrl('jdbc:mysql://h.example.test:3310/db%201?useSSL=false')).toEqual({
      host: 'h.example.test',
      port: 3310,
      database: 'db 1'
    })
    expect(parseJdbcUrl('jdbc:mysql://h/')).toEqual({ host: 'h', port: null, database: '' })
    expect(parseJdbcUrl('jdbc:postgresql://h/x')).toBeNull()
    expect(() => parseDbeaverDataSources('{')).toThrow(DBEAVER_INVALID_MESSAGE)
    expect(() => parseDbeaverDataSources('{"folders":{}}')).toThrow(DBEAVER_INVALID_MESSAGE)
  })

  it('flags key paths from another OS and agent auth', () => {
    const json = JSON.stringify({
      connections: {
        x: {
          provider: 'mysql',
          driver: 'mysql8',
          name: 'W',
          configuration: {
            host: 'h',
            user: 'u',
            handlers: {
              ssh_tunnel: {
                enabled: true,
                properties: { host: 'b', authType: 'PUBLIC_KEY', keyPath: 'C:\\keys\\id' }
              }
            }
          }
        }
      }
    })
    expect(parseDbeaverDataSources(json, 'darwin').connections[0].warnings).toEqual([
      FOREIGN_PATH_WARNING
    ])
  })
})

describe('parseWorkbenchConnections', () => {
  const file = parseWorkbenchConnections(fixture('workbench', 'connections.xml'), 'darwin')

  it('reads plain, SSH and socket connections and never a password', () => {
    expect(file.notes).toEqual([WORKBENCH_PASSWORDS_NOTE])
    expect(file.connections.map((c) => c.name)).toEqual([
      'Local instance 3306',
      'Production via bastion',
      'Socket local'
    ])
    const [local, prod, socket] = file.connections
    expect(local).toMatchObject({
      key: '2F6A1C3E-0B1D-4E5F-9A7B-1C2D3E4F5A6B',
      engine: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      username: 'app_user',
      database: 'app_dev',
      environment: 'local',
      secrets: {},
      ssl: { enabled: false, verifyServer: false }
    })
    expect(JSON.stringify(file)).not.toContain('must-never-be-read')
    expect(prod.ssh).toEqual({
      enabled: true,
      host: 'bastion.example.test',
      port: 2200,
      username: 'ops',
      authType: 'key',
      savePassword: false,
      privateKeyPath: '/Users/tester/.ssh/id_ed25519'
    })
    expect(prod.ssl).toEqual({
      enabled: true,
      verifyServer: true,
      caCertPath: '/Users/tester/certs/ca.pem'
    })
    expect(prod.environment).toBe('production')
    expect(socket).toMatchObject({ host: 'localhost', port: 3306, username: 'root' })
    expect(socket.warnings).toEqual([WORKBENCH_SOCKET_WARNING])
  })

  it('refuses other files', () => {
    expect(() => parseWorkbenchConnections('<Connections/>')).toThrow(WORKBENCH_INVALID_MESSAGE)
    expect(() => parseWorkbenchConnections('<data')).toThrow(WORKBENCH_INVALID_MESSAGE)
  })
})

describe('helpers', () => {
  it('detects paths of another OS', () => {
    expect(isForeignPath('C:\\x', 'darwin')).toBe(true)
    expect(isForeignPath('\\\\server\\share', 'linux')).toBe(true)
    expect(isForeignPath('/Users/x', 'darwin')).toBe(false)
    expect(isForeignPath('/Users/x', 'win32')).toBe(true)
    expect(isForeignPath('C:\\x', 'win32')).toBe(false)
  })
  it('normalises colours', () => {
    expect(normalizeColor('#ABC')).toBe('#aabbcc')
    expect(normalizeColor('4bd67a')).toBe('#4bd67a')
    expect(normalizeColor('0,128,255')).toBe('#0080ff')
    expect(normalizeColor('red')).toBeNull()
    expect(normalizeColor('300,0,0')).toBeNull()
  })
})

describe('PostgreSQL entries', () => {
  const dbeaver = (connections: Record<string, unknown>): string => JSON.stringify({ connections })

  it('maps a DBeaver PostgreSQL connection with sslmode verify-full and SSH', () => {
    const file = parseDbeaverDataSources(
      dbeaver({
        'postgres-jdbc-1': {
          provider: 'postgresql',
          driver: 'postgres-jdbc',
          name: 'Orders PG',
          configuration: {
            host: 'pg.example.test',
            port: '6432',
            database: 'orders',
            url: 'jdbc:postgresql://pg.example.test:6432/orders',
            user: 'orders_app',
            type: 'dev',
            handlers: {
              ssh_tunnel: {
                type: 'TUNNEL',
                enabled: true,
                properties: {
                  host: 'jump.example.test',
                  port: 22,
                  authType: 'PASSWORD',
                  user: 'ops'
                }
              },
              postgre_ssl: {
                enabled: true,
                properties: {
                  sslMode: 'verify-full',
                  sslRootCert: '/home/tester/pg/root.crt',
                  sslCert: '/home/tester/pg/client.crt',
                  sslKey: '/home/tester/pg/client.key'
                }
              }
            }
          }
        }
      }),
      'linux'
    )
    const pg = file.connections[0]
    expect(pg).toMatchObject({
      engine: 'postgresql',
      engineLabel: 'PostgreSQL',
      unsupportedReason: null,
      host: 'pg.example.test',
      port: 6432,
      username: 'orders_app',
      database: 'orders',
      ssh: { enabled: true, host: 'jump.example.test', username: 'ops', authType: 'password' }
    })
    expect(pg.ssl).toEqual({
      enabled: true,
      verifyServer: true,
      mode: 'verify-full',
      caCertPath: '/home/tester/pg/root.crt',
      clientCertPath: '/home/tester/pg/client.crt',
      clientKeyPath: '/home/tester/pg/client.key'
    })
    expect(pg.warnings).toEqual([])
  })

  it('reads host, database and sslmode from the JDBC URL; keeps only the first host', () => {
    const file = parseDbeaverDataSources(
      dbeaver({
        a: {
          provider: 'postgresql',
          driver: 'postgres-jdbc',
          name: 'Cluster',
          configuration: {
            url: 'jdbc:postgresql://pg1.example.test:5433,pg2.example.test:5434/app?sslmode=require',
            user: 'u'
          }
        },
        b: {
          provider: 'postgresql',
          driver: 'postgres-jdbc',
          name: 'Odd ssl',
          configuration: {
            host: 'h.example.test',
            url: 'jdbc:postgresql://h.example.test/x?sslmode=sometimes',
            user: 'u'
          }
        }
      }),
      'linux'
    )
    const [cluster, odd] = file.connections
    expect(cluster).toMatchObject({
      host: 'pg1.example.test',
      port: 5433,
      database: 'app',
      ssl: { enabled: true, verifyServer: false, mode: 'require' }
    })
    expect(cluster.warnings).toEqual([multiHostWarning('pg1.example.test')])
    expect(odd.ssl).toEqual({ enabled: false, verifyServer: false })
    expect(odd.warnings).toEqual([unknownSslModeWarning('sometimes')])
    expect(parsePostgresJdbcUrl('jdbc:mysql://h/x')).toBeNull()
  })

  it('keeps Redshift and other forks unsupported', () => {
    const file = parseDbeaverDataSources(
      dbeaver({
        r: { provider: 'redshift', driver: 'redshift-jdbc', name: 'RS', configuration: {} }
      })
    )
    expect(file.connections[0]).toMatchObject({ engine: null, engineLabel: 'Amazon Redshift' })
    const ncx = parseNcx(
      `<?xml version="1.0"?><Connections Ver="1.5">
        <Connection ConnectionName="RS" ConnType="POSTGRESQL" ServiceProvider="AmazonRedshift" Host="rs.example.test"/>
        <Connection ConnectionName="Gauss" ConnType="POSTGRESQL" ServiceProvider="GaussDB" Host="g.example.test"/>
      </Connections>`
    )
    expect(ncx.connections.map((c) => [c.engine, c.unsupportedReason])).toEqual([
      [null, postgresForkReason('Amazon Redshift')],
      [null, postgresForkReason('GaussDB')]
    ])
  })

  it('maps an .ncx PostgreSQL connection with its password, initial database and SSL mode', () => {
    const file = parseNcx(
      `<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.5">
  <Connection ConnectionName="Ledger" ConnType="POSTGRESQL" ServiceProvider="Default" Host="ledger.example.test"
    UserName="ledger" Password="${encryptNcxAes('pg-secret')}" InitialDatabase="ledger_db"
    SSL="true" SSL_Mode="verify-ca" SSL_CACert="/certs/ca.pem"
    SSH="true" SSH_Host="jump.example.test" SSH_UserName="ops" SSH_Password="${encryptNcxAes('ssh-pw')}" />
  <Connection ConnectionName="Pair" ConnType="POSTGRESQL" Host="a.example.test:5440,b.example.test:5441" UserName="u" />
</Connections>`,
      'darwin'
    )
    const [ledger, pair] = file.connections
    expect(ledger).toMatchObject({
      key: 'PostgreSQL:Ledger',
      engine: 'postgresql',
      navicatType: 'PostgreSQL',
      host: 'ledger.example.test',
      port: 5432,
      username: 'ledger',
      database: 'ledger_db',
      ssl: { enabled: true, verifyServer: true, mode: 'verify-ca', caCertPath: '/certs/ca.pem' },
      ssh: { enabled: true, host: 'jump.example.test', savePassword: true }
    })
    expect(ledger.secrets).toEqual({ mysql: 'pg-secret', ssh: 'ssh-pw' })
    expect(pair).toMatchObject({ host: 'a.example.test', port: 5440 })
    expect(pair.warnings).toEqual([multiHostWarning('a.example.test')])
  })
})

describe('SQLite entries', () => {
  const dbeaver = (cfg: Record<string, unknown>, driver = 'sqlite_jdbc'): string =>
    JSON.stringify({
      connections: { lite: { provider: 'generic', driver, name: 'Lite', configuration: cfg } }
    })

  it('maps DBeaver SQLite paths: existing, missing and from another OS', () => {
    const exists = (p: string): boolean => p === '/data/app.db'
    const ok = parseDbeaverDataSources(dbeaver({ database: '/data/app.db' }), 'darwin', exists)
    expect(ok.connections[0]).toMatchObject({
      engine: 'sqlite',
      sqlite: { filePath: '/data/app.db', pathNeedsReview: false },
      warnings: [],
      secrets: {}
    })
    const fromUrl = parseDbeaverDataSources(
      dbeaver({ url: 'jdbc:sqlite:/data/app.db' }),
      'darwin',
      exists
    )
    expect(fromUrl.connections[0].sqlite).toMatchObject({
      filePath: '/data/app.db',
      pathNeedsReview: false
    })
    const missing = parseDbeaverDataSources(
      dbeaver({ database: '/data/gone.db' }),
      'darwin',
      exists
    )
    expect(missing.connections[0].sqlite!.pathNeedsReview).toBe(true)
    expect(missing.connections[0].warnings).toEqual([sqliteFileReviewWarning('Lite')])
    // A Windows path on macOS is flagged even if a same-named check said it exists.
    const win = parseDbeaverDataSources(
      dbeaver({ database: 'C:\\data\\app.db' }),
      'darwin',
      () => true
    )
    expect(win.connections[0].sqlite!.pathNeedsReview).toBe(true)
    const empty = parseDbeaverDataSources(dbeaver({}), 'darwin', () => true)
    expect(empty.connections[0].sqlite).toMatchObject({ filePath: '', pathNeedsReview: true })
    // The provider id alone also identifies SQLite.
    const byProvider = parseDbeaverDataSources(
      JSON.stringify({
        connections: { x: { provider: 'sqlite', driver: '', name: 'P', configuration: {} } }
      }),
      'linux',
      () => true
    )
    expect(byProvider.connections[0].engine).toBe('sqlite')
  })

  it('parses jdbc:sqlite URLs without touching the file', () => {
    expect(parseSqliteJdbcUrl('jdbc:sqlite:/a/b.db')).toBe('/a/b.db')
    expect(parseSqliteJdbcUrl('jdbc:sqlite:C:\\a\\b.db')).toBe('C:\\a\\b.db')
    expect(parseSqliteJdbcUrl('jdbc:sqlite:file:///home/x/my%20db.db?mode=ro')).toBe(
      '/home/x/my db.db'
    )
    expect(parseSqliteJdbcUrl('jdbc:sqlite:file:///C:/x/a.db')).toBe('C:/x/a.db')
    expect(parseSqliteJdbcUrl('jdbc:sqlite::memory:')).toBeNull()
    expect(parseSqliteJdbcUrl('jdbc:mysql://h/x')).toBeNull()
  })

  it('maps .ncx SQLite entries; encrypted files are not importable and their password is ignored', () => {
    const xml = `<Connections Ver="1.5">
      <Connection ConnectionName="Plain" ConnType="SQLITE" DatabaseFileName="/data/app.db" />
      <Connection ConnectionName="Win" ConnType="sqlite" DatabaseFileName="C:\\data\\app.db" />
      <Connection ConnectionName="Enc" ConnType="SQLITE" DatabaseFileName="/data/app.db"
        SQLiteEncrypt="true" SQLiteEncryptPassword="${encryptNcxAes('enc-secret')}" />
      <Connection ConnectionName="Old" ConnType="SQLITE" DatabaseFileName="/data/app.db" SQLiteEncryption="true" />
    </Connections>`
    const file = parseNcx(xml, 'darwin', (p) => p === '/data/app.db')
    const byName = new Map(file.connections.map((c) => [c.name, c]))
    expect(byName.get('Plain')).toMatchObject({
      engine: 'sqlite',
      engineLabel: 'SQLite',
      navicatType: 'SQLite',
      unsupportedReason: null,
      host: '',
      port: 0,
      username: '',
      secrets: {},
      sqlite: { filePath: '/data/app.db', pathNeedsReview: false, attached: [] }
    })
    expect(byName.get('Win')!.sqlite!.pathNeedsReview).toBe(true)
    expect(byName.get('Enc')!.unsupportedReason).toBe(SQLITE_ENCRYPTED_REASON)
    expect(byName.get('Old')!.unsupportedReason).toBe(SQLITE_ENCRYPTED_REASON)
    expect(JSON.stringify(file)).not.toContain('enc-secret')
    expect(file.notes).toEqual([NCX_NO_PASSWORDS_NOTE])
  })
})

describe('parseDbeaverDataSources: MongoDB', () => {
  it('reads host, port and database, or the URL options without its password', () => {
    const text = JSON.stringify({
      connections: {
        m1: {
          provider: 'mongodb',
          driver: 'mongodb',
          name: 'Mongo dev',
          configuration: { host: 'localhost', port: '27018', database: 'app', user: 'dev' }
        },
        m2: {
          provider: 'mongodb',
          driver: 'mongo',
          name: 'Mongo URL',
          configuration: {
            url: 'mongodb://ana:p4ss-zz9@a.example.test:27017,b.example.test:27017/shop?replicaSet=rs1&readPreference=nearest'
          }
        }
      }
    })
    const file = parseDbeaverDataSources(text, 'darwin')
    const [dev, url] = file.connections
    expect(dev).toMatchObject({
      engine: 'mongodb',
      host: 'localhost',
      port: 27018,
      username: 'dev',
      mongo: { defaultDatabase: 'app', authMechanism: 'default' }
    })
    expect(url).toMatchObject({ engine: 'mongodb', host: 'a.example.test', username: 'ana' })
    expect(url.mongo).toMatchObject({
      topology: 'replicaSet',
      replicaSet: 'rs1',
      readPreference: 'nearest'
    })
    expect(url.secrets).toEqual({})
    expect(url.warnings).toContain(MONGO_URL_PASSWORD_WARNING)
    expect(JSON.stringify(url)).not.toContain('p4ss-zz9')
  })
})
