/**
 * createCore without Electron: the channels it answers, the vault-key secrets
 * and the production guard, on a SQLite file with in-process workers (no
 * server). The Node-only integration test (tests/integration/coreNode.test.ts)
 * does the same against the bundled core and real servers.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultSqliteOptions } from '@shared/engines'
import type { ConnectionInput, QueryStatementResult } from '@shared/types'
import { inProcessSpawner } from '@main/sqlite/spawner'
import { createCore, keyCodec, newVaultKey, type VortaqCore } from './index'

function sqliteInput(filePath: string, overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: 'Core SQLite',
    color: null,
    environment: 'local',
    host: '',
    port: 0,
    username: '',
    authMode: 'none',
    savePassword: false,
    customDatabases: [],
    initialQueries: '',
    ssh: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      savePassword: false
    },
    ssl: { enabled: false, verifyServer: false },
    backupDir: '',
    extraBackupDirs: [],
    engine: 'sqlite',
    sqlite: { ...defaultSqliteOptions(false), filePath },
    ...overrides
  }
}

const ok = (results: QueryStatementResult[]): QueryStatementResult[] => {
  const failed = results.find((r) => r.error)
  if (failed) throw new Error(`${failed.sql}: ${failed.error}`)
  return results
}

describe('createCore (Node host, no Electron)', () => {
  let dir: string
  let core: VortaqCore
  const vaultKey = newVaultKey()

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-core-host-'))
    core = createCore({
      dataDir: join(dir, 'profile'),
      home: dir,
      secrets: { codec: keyCodec(vaultKey), codecName: 'vaultKey' },
      sqliteSpawner: inProcessSpawner()
    })
  })

  afterAll(async () => {
    await core?.dispose()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('answers the core channels and none of the desktop-only ones', () => {
    const channels = core.channels()
    for (const c of [
      'connections:save',
      'connections:open',
      'db:execute',
      'db:tables',
      'db:applyRowChanges',
      'mongo:find',
      'mongo:applyChanges',
      'sqlite:createFile',
      'filters:list',
      'backups:create',
      'ai:chat'
    ] as const)
      expect(channels).toContain(c)
    expect(
      channels.filter((c) => /^(app|updates|jobs|navicat|importers|tour|settings):/.test(c))
    ).toEqual([])
  })

  it('keeps passwords encrypted with the vault key in its own profile', async () => {
    const saved = await core.invoke('connections:save', sqliteInput(join(dir, 'unused.db')))
    await core.invoke('connections:setSshPassword', saved.id, 'tunnel-secret-value')
    expect(await core.invoke('connections:hasSshPassword', saved.id)).toBe(true)
    const file = readFileSync(join(dir, 'profile', 'credentials.json'), 'utf8')
    expect(file).not.toContain('tunnel-secret-value')
    expect(file).not.toContain(vaultKey)
    expect(core.context.credentials.get('ssh', saved.id)).toBe('tunnel-secret-value')
    await core.invoke('connections:delete', saved.id)
    expect(core.context.credentials.get('ssh', saved.id)).toBeNull()
  })

  it('runs SQL, edits a row and refuses an unconfirmed write on production', async () => {
    const file = join(dir, 'core.db')
    await core.invoke('sqlite:createFile', file)
    const local = await core.invoke('connections:save', sqliteInput(file))
    const prod = await core.invoke(
      'connections:save',
      sqliteInput(file, {
        name: 'Core SQLite prod',
        environment: 'production',
        sqlite: { ...defaultSqliteOptions(false), filePath: file }
      })
    )
    ok(
      await core.invoke(
        'db:execute',
        local.id,
        "CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO item (name) VALUES ('uno');",
        { schema: 'main' }
      )
    )
    expect((await core.invoke('db:tables', local.id, 'main')).map((t) => t.name)).toEqual(['item'])
    const edit = await core.invoke('db:applyRowChanges', local.id, 'main', 'item', [
      { kind: 'update', key: { id: 1 }, values: { name: 'dos' } }
    ])
    expect(edit.applied).toBe(1)
    const [read] = ok(await core.invoke('db:execute', local.id, 'SELECT name FROM item'))
    expect(read.resultSet?.rows).toEqual([['dos']])

    await expect(
      core.invoke('db:execute', prod.id, "UPDATE item SET name = 'tres'", { schema: 'main' })
    ).rejects.toThrow(/necesita confirmación explícita/)
    await expect(
      core.invoke('db:applyRowChanges', prod.id, 'main', 'item', [
        { kind: 'update', key: { id: 1 }, values: { name: 'tres' } }
      ])
    ).rejects.toThrow(/necesita confirmación explícita/)
    const [after] = ok(await core.invoke('db:execute', prod.id, 'SELECT name FROM item'))
    expect(after.resultSet?.rows).toEqual([['dos']])
  })
})
