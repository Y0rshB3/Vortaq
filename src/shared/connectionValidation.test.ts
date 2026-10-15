import { describe, expect, it } from 'vitest'
import {
  connectionFormErrors,
  connectionSaveError,
  engineAvailabilityError,
  engineBlockErrors,
  isAbsolutePathFor,
  isMongoCredentialOption
} from './connectionValidation'
import { defaultMongoOptions, defaultSqliteOptions } from './engines'
import type { ConnectionInput, EngineId } from './types'

const input = (overrides: Partial<ConnectionInput> = {}): ConnectionInput => ({
  name: 'Local',
  color: null,
  environment: 'local',
  host: '127.0.0.1',
  port: 3306,
  username: 'root',
  savePassword: true,
  customDatabases: [],
  initialQueries: '',
  ssh: {
    enabled: false,
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    privateKeyPath: '',
    savePassword: true
  },
  ssl: { enabled: false, verifyServer: true },
  backupDir: '',
  extraBackupDirs: [],
  ...overrides
})

describe('MySQL validation (unchanged messages)', () => {
  it('main reports the first problem with the messages it always used', () => {
    expect(connectionSaveError(input())).toBeNull()
    expect(connectionSaveError(input({ engine: 'mysql' }))).toBeNull()
    expect(connectionSaveError(input({ name: ' ' }))).toBe(
      'El nombre de la conexión es obligatorio'
    )
    expect(connectionSaveError(input({ host: '' }))).toBe('El host de la conexión es obligatorio')
    for (const port of [0, 65536, 3.5, Number.NaN]) {
      expect(connectionSaveError(input({ port }))).toBe(
        'El puerto debe ser un número entre 1 y 65535'
      )
    }
    expect(connectionSaveError(input({ username: '  ' }))).toBe(
      'El usuario de la conexión es obligatorio'
    )
    // order: name before host before port before user
    expect(connectionSaveError(input({ name: '', host: '', port: 0, username: '' }))).toBe(
      'El nombre de la conexión es obligatorio'
    )
    // SSH fields were never checked by main
    expect(
      connectionSaveError(input({ ssh: { ...input().ssh, enabled: true, host: '' } }))
    ).toBeNull()
  })

  it('the dialog lists every problem with the messages it always showed', () => {
    expect(connectionFormErrors(input())).toEqual([])
    expect(
      connectionFormErrors(
        input({
          name: '',
          host: ' ',
          port: 70000,
          username: '',
          ssh: { ...input().ssh, enabled: true, authType: 'key', privateKeyPath: '' }
        })
      )
    ).toEqual([
      'El nombre de la conexión es obligatorio.',
      'El host es obligatorio.',
      'El puerto debe estar entre 1 y 65535.',
      'SSH: el host es obligatorio.',
      'SSH: el usuario es obligatorio.',
      'SSH: selecciona el archivo de clave privada.'
    ])
  })
})

describe('engine availability', () => {
  it('accepts MySQL (explicit or missing) and refuses unknown or unavailable engines', () => {
    expect(engineAvailabilityError({})).toBeNull()
    expect(engineAvailabilityError({ engine: 'mysql' })).toBeNull()
    expect(engineAvailabilityError({ engine: 'oracle' as EngineId })).toBe(
      'Motor de base de datos desconocido: "oracle".'
    )
    // PostgreSQL ships a driver (preview) since 2.0.0.
    expect(engineAvailabilityError({ engine: 'postgresql' })).toBeNull()
    // MariaDB ships the mysql2 driver since 2.0.0 (P5).
    expect(engineAvailabilityError({ engine: 'mariadb' })).toBeNull()
    // SQLite ships a driver (preview) since 2.0.0: a file is required instead.
    expect(connectionSaveError(input({ engine: 'sqlite' }))).toBe(
      'SQLite: selecciona el archivo de la base de datos.'
    )
    // MongoDB ships a driver (preview) since 2.0.0: its own block rules apply.
    expect(engineAvailabilityError({ engine: 'mongodb' })).toBeNull()
  })
})

describe('engine block rules', () => {
  it('has no extra rules for MySQL', () => {
    expect(engineBlockErrors(input({ engine: 'mysql' }))).toEqual([])
  })

  it('checks absolute paths per platform', () => {
    expect(isAbsolutePathFor('/Users/a/db.sqlite', 'darwin')).toBe(true)
    expect(isAbsolutePathFor('C:\\data\\db.sqlite', 'darwin')).toBe(false)
    expect(isAbsolutePathFor('C:\\data\\db.sqlite', 'win32')).toBe(true)
    expect(isAbsolutePathFor('\\\\server\\share\\db.sqlite', 'win32')).toBe(true)
    expect(isAbsolutePathFor('/Users/a/db.sqlite', 'win32')).toBe(false)
    expect(isAbsolutePathFor('db.sqlite', 'linux')).toBe(false)
    expect(isAbsolutePathFor('C:/data/db.sqlite')).toBe(true)
    expect(isAbsolutePathFor('relative/db.sqlite')).toBe(false)
  })

  it('SQLite needs an absolute file for this platform and valid attached aliases', () => {
    const sqlite = (over: Partial<ReturnType<typeof defaultSqliteOptions>>) =>
      input({
        engine: 'sqlite',
        host: '',
        port: 0,
        username: '',
        sqlite: { ...defaultSqliteOptions(false), ...over }
      })
    expect(engineBlockErrors(sqlite({}))).toEqual([
      'SQLite: selecciona el archivo de la base de datos.'
    ])
    expect(engineBlockErrors(sqlite({ filePath: '/data/app.db' }), { platform: 'darwin' })).toEqual(
      []
    )
    expect(
      engineBlockErrors(sqlite({ filePath: 'C:\\data\\app.db' }), { platform: 'darwin' })
    ).toEqual(['SQLite: la ruta del archivo no es válida en este equipo; selecciónalo de nuevo.'])
    expect(
      engineBlockErrors(sqlite({ filePath: '/data/app.db', pathNeedsReview: true }))
    ).toHaveLength(1)
    expect(
      engineBlockErrors(
        sqlite({
          filePath: '/data/app.db',
          attached: [
            { alias: 'aux', filePath: '/data/aux.db' },
            { alias: 'AUX', filePath: '/data/aux2.db' },
            { alias: 'main', filePath: '/data/m.db' },
            { alias: '', filePath: 'rel.db' }
          ]
        }),
        { platform: 'linux' }
      )
    ).toEqual([
      'SQLite: el alias "AUX" está repetido.',
      'SQLite: el alias "main" está reservado.',
      'SQLite: cada base de datos adjunta necesita un alias.',
      'SQLite: la ruta de la base de datos adjunta "?" no es válida; selecciónala de nuevo.'
    ])
  })

  it('MongoDB refuses SRV or clusters over SSH, empty seed lists and credential options', () => {
    const mongo = (over: Partial<ReturnType<typeof defaultMongoOptions>>, ssh = false) =>
      input({
        engine: 'mongodb',
        port: 27017,
        username: '',
        ssh: { ...input().ssh, enabled: ssh, host: 'bastion', username: 'me' },
        mongo: { ...defaultMongoOptions(), ...over }
      })
    expect(engineBlockErrors(mongo({}))).toEqual([])
    expect(engineBlockErrors(mongo({}, true))).toEqual([])
    expect(engineBlockErrors(mongo({ srv: true }, true))).toEqual([
      'MongoDB: una conexión SRV (mongodb+srv) no puede usar un túnel SSH.'
    ])
    expect(
      engineBlockErrors(mongo({ topology: 'replicaSet', members: [{ host: 'a', port: 1 }] }, true))
    ).toEqual(['MongoDB: con un túnel SSH la conexión debe ser independiente o directa.'])
    expect(
      engineBlockErrors(
        mongo(
          { topology: 'replicaSet', members: [{ host: 'a', port: 1 }], directConnection: true },
          true
        )
      )
    ).toEqual([])
    expect(engineBlockErrors(mongo({ topology: 'shardCluster' }))).toEqual([
      'MongoDB: añade al menos un miembro del conjunto de réplicas o del clúster.'
    ])
    expect(
      engineBlockErrors(mongo({ extraOptions: { compressors: 'zstd', ProxyPassword: 'x' } }))
    ).toEqual([
      'MongoDB: la opción "ProxyPassword" lleva credenciales y no se puede guardar en las opciones extra.'
    ])
    expect(isMongoCredentialOption(' authMechanismProperties ')).toBe(true)
    expect(isMongoCredentialOption('tlsCAFile')).toBe(false)
  })

  it('PostgreSQL needs an initial database when the block is present', () => {
    expect(
      engineBlockErrors(
        input({
          engine: 'postgresql',
          postgres: { initialDatabase: ' ', showSystemSchemas: false, timeZone: '', searchPath: '' }
        })
      )
    ).toEqual(['PostgreSQL: la base de datos inicial es obligatoria.'])
  })
})

describe('agents (MCP) section', () => {
  const write = { enabled: true, access: 'write' as const }
  it('refuses «Lectura y escritura» on guarded environments when the list is known', () => {
    const prod = input({ environment: 'production', mcp: write })
    expect(connectionSaveError(prod, { typedConfirmEnvironments: ['production'] })).toMatch(
      /«Lectura y escritura» no está disponible/
    )
    expect(connectionFormErrors(prod, { typedConfirmEnvironments: [] })).toEqual([
      expect.stringMatching(/Lectura y escritura/)
    ])
    const staging = input({ environment: 'staging', mcp: write })
    expect(connectionSaveError(staging, { typedConfirmEnvironments: ['production'] })).toBeNull()
    expect(
      connectionSaveError(staging, { typedConfirmEnvironments: ['production', 'staging'] })
    ).toMatch(/Lectura y escritura/)
    // Off, read or structure are always fine; without the list nothing is checked.
    expect(
      connectionSaveError(
        input({ environment: 'production', mcp: { enabled: false, access: 'write' } }),
        {
          typedConfirmEnvironments: ['production']
        }
      )
    ).toBeNull()
    expect(
      connectionSaveError(
        input({ environment: 'production', mcp: { enabled: true, access: 'read' } }),
        {
          typedConfirmEnvironments: ['production']
        }
      )
    ).toBeNull()
    expect(connectionSaveError(prod)).toBeNull()
  })
})
