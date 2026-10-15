import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConnectionsRepo,
  DEFAULT_SETTINGS,
  ENGINE_CHANGE_MESSAGE,
  defaultNavicatRootPath,
  JobsRepo,
  RunsRepo,
  SettingsRepo
} from './repos'
import { JsonStore } from './jsonStore'
import type { ConnectionInput } from '@shared/types'

const connInput = (name: string): ConnectionInput => ({
  name,
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
    savePassword: false
  },
  ssl: { enabled: false, verifyServer: false },
  backupDir: '/tmp/x',
  extraBackupDirs: []
})

describe('repos', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-repos-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('persists connections atomically and reloads them', () => {
    const repo = new ConnectionsRepo(dir)
    const saved = repo.save(connInput('Local'))
    expect(saved.id).toBeTruthy()
    const again = new ConnectionsRepo(dir)
    expect(again.list().map((c) => c.name)).toEqual(['Local'])
    again.save({ ...saved, name: 'Local 2' })
    expect(again.get(saved.id)?.name).toBe('Local 2')
    expect(again.get(saved.id)?.createdAt).toBe(saved.createdAt)
    again.delete(saved.id)
    expect(again.list()).toHaveLength(0)
  })

  it('normalises the agents (MCP) setting: missing stays off, malformed becomes off', () => {
    const repo = new ConnectionsRepo(dir)
    const plain = repo.save(connInput('Sin MCP'))
    expect('mcp' in plain).toBe(false)
    const on = repo.save({ ...connInput('Con MCP'), mcp: { enabled: true, access: 'structure' } })
    expect(repo.get(on.id)?.mcp).toEqual({ enabled: true, access: 'structure' })
    // A hand-edited file: unknown level or a non-boolean switch never enables it.
    const file = join(dir, 'connections.json')
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    doc.items.find((c: { id: string }) => c.id === on.id).mcp = { enabled: 'true', access: 'root' }
    writeFileSync(file, JSON.stringify(doc))
    expect(new ConnectionsRepo(dir).get(on.id)?.mcp).toEqual({ enabled: false, access: 'read' })
    // Saving without the field (an importer) leaves it off.
    const again = new ConnectionsRepo(dir)
    const { mcp: _m, ...rest } = again.get(on.id)!
    expect('mcp' in again.save(rest)).toBe(false)
  })

  it('setMcp replaces only the agents setting and keeps the stored fields as written', () => {
    const repo = new ConnectionsRepo(dir)
    const saved = repo.save(connInput('Solo MCP'))
    const file = join(dir, 'connections.json')
    // A record written before engines existed: no `engine` field on disk.
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    delete doc.items.find((c: { id: string }) => c.id === saved.id).engine
    writeFileSync(file, JSON.stringify(doc))
    const raw = (id: string) =>
      JSON.parse(readFileSync(file, 'utf8')).items.find((c: { id: string }) => c.id === id)
    const { updatedAt: _b, ...before } = raw(saved.id)

    const fresh = new ConnectionsRepo(dir)
    const on = fresh.setMcp(saved.id, { enabled: true, access: 'write' })
    expect(on?.mcp).toEqual({ enabled: true, access: 'write' })
    expect(on?.engine).toBe('mysql')
    const { updatedAt: _a, mcp, ...after } = raw(saved.id)
    expect(mcp).toEqual({ enabled: true, access: 'write' })
    expect(after).toEqual(before)
    expect('engine' in after).toBe(false)

    // Malformed input is stored as off; an unknown id changes nothing.
    expect(fresh.setMcp(saved.id, { enabled: true, access: 'root' } as never)?.mcp).toEqual({
      enabled: false,
      access: 'read'
    })
    expect(fresh.setMcp('missing', { enabled: true, access: 'read' })).toBeNull()
    expect(fresh.list()).toHaveLength(1)
  })

  it('recovers from a corrupt file by moving it aside', () => {
    const path = join(dir, 'broken.json')
    new JsonStore(path, () => ({ a: 1 })).save()
    writeFileSync(path, '{ not json')
    const store = new JsonStore(path, () => ({ a: 1 }))
    expect(store.get()).toEqual({ a: 1 })
  })

  it('caps job runs at 500 newest', () => {
    const runs = new RunsRepo(dir)
    for (let i = 0; i < 520; i++) {
      runs.upsert({
        id: `r${i}`,
        jobId: 'j',
        jobName: 'J',
        status: 'success',
        trigger: 'manual',
        startedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        finishedAt: null,
        tasks: [],
        logPath: ''
      })
    }
    const all = runs.list('j', 1000)
    expect(all).toHaveLength(500)
    expect(all[0].id).toBe('r519')
  })

  it('stores settings with defaults and jobs with lastRunAt', () => {
    const settings = new SettingsRepo(dir, '/Users/test', 'darwin')
    expect(settings.get().navicatRootPath).toBe(
      join('/Users/test', 'Library', 'Application Support', 'PremiumSoft CyberTech', 'Navicat CC')
    )
    settings.update({ defaultRowLimit: 5 })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).defaultRowLimit).toBe(5)

    const jobs = new JobsRepo(dir)
    const job = jobs.save({
      name: 'Backup Local',
      continueOnError: true,
      tasks: [],
      schedule: { enabled: false, cron: '0 3 * * *', launchAgent: false }
    })
    jobs.touchLastRun(job.id, '2026-09-14T00:00:00.000Z')
    expect(jobs.get(job.id)?.lastRunAt).toBe('2026-09-14T00:00:00.000Z')
  })

  it('agents (MCP) are off by default, for older profiles and for anything but true', () => {
    expect(DEFAULT_SETTINGS('/data', '/home/test', 'linux').mcpEnabled).toBe(false)
    expect(new SettingsRepo(join(dir, 'fresh'), '/home/test').get().mcpEnabled).toBe(false)
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ mcpEnabled: 'yes' }))
    expect(new SettingsRepo(dir, '/home/test').get().mcpEnabled).toBe(false)
    new SettingsRepo(dir, '/home/test').update({ mcpEnabled: true })
    expect(new SettingsRepo(dir, '/home/test').get().mcpEnabled).toBe(true)
  })

  it('confirms destructive operations everywhere by default, also for older profiles', () => {
    expect(DEFAULT_SETTINGS('/data', '/home/test', 'linux').confirmDestructiveEverywhere).toBe(true)
    expect(
      new SettingsRepo(join(dir, 'fresh'), '/home/test').get().confirmDestructiveEverywhere
    ).toBe(true)
    // settings.json written before the option existed: missing means on
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ defaultRowLimit: 50, theme: 'light', confirmProductionWrites: false })
    )
    const old = new SettingsRepo(dir, '/home/test')
    expect(old.get().confirmDestructiveEverywhere).toBe(true)
    // production can no longer be turned off: the old false maps to ['production']
    expect(old.get().typedConfirmEnvironments).toEqual(['production'])
    expect('confirmProductionWrites' in old.get()).toBe(false)
    expect(old.get().defaultRowLimit).toBe(50)
    // an invalid value is not taken as "off"
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ confirmDestructiveEverywhere: 'no' })
    )
    expect(new SettingsRepo(dir, '/home/test').get().confirmDestructiveEverywhere).toBe(true)
    // an explicit false sticks across restarts
    new SettingsRepo(dir, '/home/test').update({ confirmDestructiveEverywhere: false })
    expect(new SettingsRepo(dir, '/home/test').get().confirmDestructiveEverywhere).toBe(false)
  })

  describe('typed-name confirmation environments', () => {
    const write = (value: object) =>
      writeFileSync(join(dir, 'settings.json'), JSON.stringify(value))
    const read = () => new SettingsRepo(dir, '/home/test').get().typedConfirmEnvironments
    const stored = () => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))

    it('defaults to production only (new profile and DEFAULT_SETTINGS)', () => {
      expect(DEFAULT_SETTINGS('/data', '/home/test', 'linux').typedConfirmEnvironments).toEqual([
        'production'
      ])
      expect(
        new SettingsRepo(join(dir, 'fresh'), '/home/test').get().typedConfirmEnvironments
      ).toEqual(['production'])
    })

    it('migrates the old boolean: true, false and missing all give production', () => {
      write({ confirmProductionWrites: true })
      expect(read()).toEqual(['production'])
      write({ confirmProductionWrites: false })
      expect(read()).toEqual(['production'])
      write({ theme: 'light' })
      expect(read()).toEqual(['production'])
    })

    it('keeps a new list, adds production back and drops unknown values', () => {
      write({ typedConfirmEnvironments: ['staging', 'production'] })
      expect(read()).toEqual(['production', 'staging'])
      // hand-edited file without production
      write({ typedConfirmEnvironments: ['other', 'local', 'local', 'bogus', 3] })
      expect(read()).toEqual(['production', 'local', 'other'])
      write({ typedConfirmEnvironments: 'staging' })
      expect(read()).toEqual(['production'])
      // the new key wins over the old one
      write({ confirmProductionWrites: false, typedConfirmEnvironments: ['production', 'staging'] })
      expect(read()).toEqual(['production', 'staging'])
    })

    it('settings:update stores the normalised list, never without production, and drops the old key', () => {
      write({ confirmProductionWrites: false })
      const repo = new SettingsRepo(dir, '/home/test')
      expect(
        repo.update({ typedConfirmEnvironments: ['staging'] as never }).typedConfirmEnvironments
      ).toEqual(['production', 'staging'])
      expect(stored().typedConfirmEnvironments).toEqual(['production', 'staging'])
      expect('confirmProductionWrites' in stored()).toBe(false)
      expect(repo.update({ typedConfirmEnvironments: [] }).typedConfirmEnvironments).toEqual([
        'production'
      ])
      // an old renderer sending the boolean cannot turn production off either
      repo.update({ confirmProductionWrites: false } as never)
      expect(stored().typedConfirmEnvironments).toEqual(['production'])
      expect('confirmProductionWrites' in stored()).toBe(false)
      expect(read()).toEqual(['production'])
    })
  })

  it('defaults the Navicat folder to the macOS path only on macOS', () => {
    expect(defaultNavicatRootPath('/Users/test', 'darwin')).toContain('Navicat CC')
    for (const os of ['win32', 'linux'] as const) {
      expect(defaultNavicatRootPath('/home/test', os)).toBe('')
      expect(DEFAULT_SETTINGS('/data', '/home/test', os).navicatRootPath).toBe('')
      const osDir = join(dir, os)
      expect(new SettingsRepo(osDir, '/home/test', os).get().navicatRootPath).toBe('')
    }
  })

  it('ignores the macOS default saved by older builds on Windows/Linux but keeps real paths', () => {
    const home = '/home/test'
    const stale = join(
      home,
      'Library',
      'Application Support',
      'PremiumSoft CyberTech',
      'Navicat CC'
    )
    const settings = new SettingsRepo(dir, home, 'linux')
    settings.update({ navicatRootPath: stale })
    expect(settings.get().navicatRootPath).toBe('')
    settings.update({ navicatRootPath: '/home/test/navicat-cc' })
    expect(new SettingsRepo(dir, home, 'linux').get().navicatRootPath).toBe('/home/test/navicat-cc')
    // on macOS the same path is the real default
    expect(new SettingsRepo(join(dir, 'mac'), home, 'darwin').get().navicatRootPath).toBe(stale)
  })
})

describe('ConnectionsRepo engine model', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-repos-engine-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const file = (): string => join(dir, 'connections.json')
  const writeLegacy = (): void => {
    const legacy = {
      ...connInput('Legacy'),
      id: 'legacy-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    writeFileSync(file(), JSON.stringify({ version: 1, items: [legacy] }, null, 2))
  }

  it('reads records without engine as MySQL and never rewrites the file for it', () => {
    writeLegacy()
    const before = readFileSync(file(), 'utf8')
    const repo = new ConnectionsRepo(dir)
    expect(repo.list()[0]).toMatchObject({ id: 'legacy-1', engine: 'mysql' })
    expect(repo.get('legacy-1')?.engine).toBe('mysql')
    expect(repo.findByName('Legacy')?.engine).toBe('mysql')
    // only engine is added: no engine blocks for MySQL
    const { engine: _engine, ...rest } = repo.get('legacy-1')!
    expect(rest).toEqual(JSON.parse(before).items[0])
    expect(readFileSync(file(), 'utf8')).toBe(before)

    // saving another record does not stamp the untouched legacy one
    repo.save(connInput('Other'))
    const items = JSON.parse(readFileSync(file(), 'utf8')).items
    expect(items.find((c: { id: string }) => c.id === 'legacy-1')).not.toHaveProperty('engine')
    expect(items.find((c: { name: string }) => c.name === 'Other').engine).toBe('mysql')
  })

  it('saves new records as MySQL unless an engine is given', () => {
    const repo = new ConnectionsRepo(dir)
    expect(repo.save(connInput('A')).engine).toBe('mysql')
    const pg = repo.save({ ...connInput('B'), engine: 'postgresql' })
    expect(pg.engine).toBe('postgresql')
    expect(pg.postgres).toEqual({
      initialDatabase: 'postgres',
      showSystemSchemas: false,
      timeZone: '',
      searchPath: ''
    })
    expect(new ConnectionsRepo(dir).get(pg.id)?.engine).toBe('postgresql')
  })

  it('keeps the stored engine when the input has none and refuses a different one', () => {
    writeLegacy()
    const repo = new ConnectionsRepo(dir)
    const pg = repo.save({ ...connInput('PG'), engine: 'postgresql' })

    const { engine: _e, ...withoutEngine } = repo.get(pg.id)!
    expect(repo.save({ ...withoutEngine, name: 'PG 2' })).toMatchObject({
      engine: 'postgresql',
      name: 'PG 2'
    })
    expect(() => repo.save({ ...connInput('PG'), id: pg.id, engine: 'mysql' })).toThrow(
      ENGINE_CHANGE_MESSAGE
    )
    expect(ENGINE_CHANGE_MESSAGE).toBe(
      'No se puede cambiar el motor de una conexión existente; crea una conexión nueva.'
    )
    expect(repo.get(pg.id)?.name).toBe('PG 2')

    // a legacy record (no stored engine) is MySQL: saving it as MySQL works, as SQLite does not
    expect(repo.save({ ...connInput('Legacy'), id: 'legacy-1', engine: 'mysql' }).engine).toBe(
      'mysql'
    )
    expect(() => repo.save({ ...connInput('Legacy'), id: 'legacy-1', engine: 'sqlite' })).toThrow(
      ENGINE_CHANGE_MESSAGE
    )
  })

  it('lets a mysql record become mariadb, and keeps mariadb when saved as mysql (P5)', () => {
    const repo = new ConnectionsRepo(dir)
    const a = repo.save({ ...connInput('A'), engine: 'mysql' })
    expect(repo.save({ ...connInput('A'), id: a.id, engine: 'mariadb' }).engine).toBe('mariadb')
    // An importer or a stale form sending 'mysql' does not turn it back.
    expect(repo.save({ ...connInput('A'), id: a.id, engine: 'mysql' }).engine).toBe('mariadb')
    expect(() => repo.save({ ...connInput('A'), id: a.id, engine: 'postgresql' })).toThrow(
      ENGINE_CHANGE_MESSAGE
    )
  })

  it('promoteToMariaDb changes only engine and updatedAt, once', () => {
    // A legacy record without engine (pre multi-engine) is MySQL and can be promoted.
    const legacy = { ...connInput('Legacy'), id: 'legacy-1', createdAt: 'c', updatedAt: 'u' }
    writeFileSync(
      join(dir, 'connections.json'),
      JSON.stringify({ version: 1, items: [legacy] }, null, 2)
    )
    const repo = new ConnectionsRepo(dir)
    const pg = repo.save({ ...connInput('PG'), engine: 'postgresql' })
    const promoted = repo.promoteToMariaDb('legacy-1')
    expect(promoted).toMatchObject({ id: 'legacy-1', engine: 'mariadb', createdAt: 'c' })
    expect(promoted?.updatedAt).not.toBe('u')
    const { engine: _e, updatedAt: _u, ...rest } = promoted!
    const { updatedAt: _lu, ...legacyRest } = legacy
    expect(rest).toEqual(legacyRest)
    const stored = JSON.parse(readFileSync(join(dir, 'connections.json'), 'utf8')).items[0]
    expect(stored).toEqual({ ...legacy, engine: 'mariadb', updatedAt: promoted!.updatedAt })
    expect(repo.promoteToMariaDb('legacy-1')).toBeNull()
    expect(repo.promoteToMariaDb(pg.id)).toBeNull()
    expect(repo.promoteToMariaDb('missing')).toBeNull()
    expect(repo.get(pg.id)?.engine).toBe('postgresql')
  })

  it('refuses unknown engines', () => {
    const repo = new ConnectionsRepo(dir)
    expect(() => repo.save({ ...connInput('X'), engine: 'oracle' as never })).toThrow(
      'Motor de base de datos desconocido: "oracle".'
    )
    expect(repo.list()).toEqual([])
  })
})

describe('SettingsRepo: the 2.0 preview switch is gone', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-repos-settings-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('ignores a stored «Motores en vista previa» and drops it on the next write', () => {
    expect('previewEngines' in DEFAULT_SETTINGS('/data', '/home/test', 'darwin')).toBe(false)
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ defaultRowLimit: 50, theme: 'light', previewEngines: true })
    )
    const settings = new SettingsRepo(dir, '/home/test', 'darwin')
    expect('previewEngines' in settings.get()).toBe(false)
    expect(settings.get()).toMatchObject({ defaultRowLimit: 50, theme: 'light' })
    // A stale renderer sending it is ignored too.
    settings.update({ defaultRowLimit: 60, previewEngines: false } as never)
    const stored = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(stored).toMatchObject({ defaultRowLimit: 60, theme: 'light' })
    expect('previewEngines' in stored).toBe(false)
  })
})
