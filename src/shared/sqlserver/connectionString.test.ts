import { describe, expect, it } from 'vitest'
import {
  parseKeyValues,
  parseSqlServerConnectionString,
  sqlServerConnectionString
} from './connectionString'

describe('parseKeyValues', () => {
  it('honours quotes and braces', () => {
    const map = parseKeyValues(
      `A=1; Password="p;w""x"; Driver={ODBC Driver 18 for SQL Server};b = 'two' `
    )
    expect([...map]).toEqual([
      ['a', '1'],
      ['password', 'p;w"x'],
      ['driver', 'ODBC Driver 18 for SQL Server'],
      ['b', 'two']
    ])
  })
})

describe('parseSqlServerConnectionString', () => {
  it('reads the Azure ADO.NET string', () => {
    const parsed = parseSqlServerConnectionString(
      'Server=tcp:demo.database.windows.net,1433;Initial Catalog=ventas;Persist Security Info=False;User ID=ana;Password=s3cr;to;MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;'
    )
    expect(parsed).toMatchObject({
      host: 'demo.database.windows.net',
      port: 1433,
      username: 'ana',
      password: 's3cr',
      connectTimeoutMs: 30_000,
      sqlserver: { initialDatabase: 'ventas', encrypt: 'mandatory', trustServerCertificate: false }
    })
  })

  it('reads Entra methods, named instances and integrated security', () => {
    expect(
      parseSqlServerConnectionString(
        'Data Source=srv\\SQLEXPRESS;Database=app;Authentication="Active Directory Interactive";User ID=ana@contoso.com'
      )
    ).toMatchObject({
      host: 'srv',
      port: null,
      username: 'ana@contoso.com',
      sqlserver: { instanceName: 'SQLEXPRESS', auth: 'entra-interactive' }
    })
    const windows = parseSqlServerConnectionString(
      'Server=(local);Database=x;Integrated Security=SSPI'
    )
    expect(windows?.host).toBe('localhost')
    expect(windows?.sqlserver.auth).toBe('windows')
    expect(windows?.warnings[0]).toMatch(/NTLM/)
    expect(
      parseSqlServerConnectionString('Server=s;Authentication=ActiveDirectoryPassword;User ID=u')
        ?.warnings[0]
    ).toMatch(/retiró/)
    expect(
      parseSqlServerConnectionString(
        'Server=s;Authentication=Active Directory Service Principal;User ID=app-id'
      )
    ).toMatchObject({
      username: '',
      sqlserver: { auth: 'entra-service-principal', clientId: 'app-id' }
    })
  })

  it('reads ODBC, JDBC and URL forms', () => {
    expect(
      parseSqlServerConnectionString(
        'Driver={ODBC Driver 18 for SQL Server};Server=tcp:db.local,14330;Database=erp;Uid=sa;Pwd={x;y};Encrypt=yes;TrustServerCertificate=yes;'
      )
    ).toMatchObject({
      host: 'db.local',
      port: 14330,
      username: 'sa',
      password: 'x;y',
      sqlserver: { trustServerCertificate: true }
    })
    expect(
      parseSqlServerConnectionString(
        'jdbc:sqlserver://db.local:1444;databaseName=erp;user=ana;password=p;encrypt=strict;hostNameInCertificate=*.contoso.com'
      )
    ).toMatchObject({
      host: 'db.local',
      port: 1444,
      username: 'ana',
      sqlserver: {
        initialDatabase: 'erp',
        encrypt: 'strict',
        hostNameInCertificate: '*.contoso.com'
      }
    })
    expect(
      parseSqlServerConnectionString(
        'sqlserver://sa:Pa%3Bss@127.0.0.1:51433/navidog_test?trustServerCertificate=true'
      )
    ).toMatchObject({
      host: '127.0.0.1',
      port: 51433,
      username: 'sa',
      password: 'Pa;ss',
      sqlserver: { initialDatabase: 'navidog_test', trustServerCertificate: true }
    })
  })

  it('refuses text that is not a connection string', () => {
    expect(parseSqlServerConnectionString('hola')).toBeNull()
    expect(parseSqlServerConnectionString('Database=x')).toBeNull()
  })
})

describe('sqlServerConnectionString', () => {
  it('round-trips without the password', () => {
    const text = sqlServerConnectionString({
      host: 'db.local',
      port: 1433,
      username: 'ana',
      sqlserver: {
        initialDatabase: 'erp;x',
        auth: 'sql',
        encrypt: 'mandatory',
        trustServerCertificate: true
      }
    })
    expect(text).toBe(
      'Server=tcp:db.local,1433;Database="erp;x";User ID=ana;Encrypt=True;TrustServerCertificate=True;'
    )
    expect(parseSqlServerConnectionString(text)).toMatchObject({
      host: 'db.local',
      port: 1433,
      username: 'ana',
      password: null,
      sqlserver: { initialDatabase: 'erp;x', trustServerCertificate: true }
    })
  })
})
