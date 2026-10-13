import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECTIONS_FILE,
  desktopProfileDir,
  parseDesktopConnections,
  readDesktopConnections
} from './desktopImport'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

const FIXTURE = resolve(__dirname, '../../test/fixtures/desktop-profile')

describe('«Importar de Vortaq» (desktop profile)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-desktop-import-'))
    copyFileSync(join(FIXTURE, CONNECTIONS_FILE), join(dir, CONNECTIONS_FILE))
    // Encrypted with the desktop app's key: the importer must never open it.
    writeFileSync(
      join(dir, 'credentials.json'),
      '{"version":1,"codec":"safeStorage","items":{"mysql:x":"djEw"}}'
    )
    vi.mocked(fs.readFileSync).mockClear()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads connections.json only, never credentials.json', () => {
    readDesktopConnections(dir, 'darwin')
    const read = vi.mocked(fs.readFileSync).mock.calls.map((c) => String(c[0]))
    expect(read).toEqual([join(dir, CONNECTIONS_FILE)])
  })

  it('lists the valid connections with new ids, no secrets and no desktop backup folders', () => {
    const preview = readDesktopConnections(dir, 'darwin')
    expect(preview.connections.map((c) => c.name)).toEqual([
      'Analítica (producción)',
      'Eventos',
      'Notas',
      'Tienda local'
    ])
    expect(preview.skipped).toEqual([
      { name: 'Sin host', reason: 'El host de la conexión es obligatorio' }
    ])
    for (const { input } of preview.connections) {
      expect(input).not.toHaveProperty('id')
      expect(input).not.toHaveProperty('createdAt')
      expect(input).not.toHaveProperty('password')
      expect(input.backupDir).toBe('')
      expect(input.extraBackupDirs).toEqual([])
      expect(JSON.stringify(input)).not.toMatch(/must-never-be-copied|not-a-field/)
    }
  })

  it('keeps every engine block, SSH tunnel and SSL setting', () => {
    const byName = Object.fromEntries(
      readDesktopConnections(dir, 'darwin').connections.map((c) => [c.name, c])
    )
    expect(byName['Tienda local']).toMatchObject({
      engine: 'mysql',
      environment: 'local',
      summary: 'MySQL · 127.0.0.1:3306',
      input: {
        host: '127.0.0.1',
        port: 3306,
        username: 'root',
        customDatabases: ['tienda'],
        savePassword: true
      }
    })
    expect(byName['Analítica (producción)']).toMatchObject({
      engine: 'postgresql',
      environment: 'production',
      summary: 'PostgreSQL · db.example.test:5432 (SSH)',
      input: {
        savePassword: false,
        ssh: { enabled: true, authType: 'key', privateKeyPath: '/Users/example/.ssh/id_ed25519' },
        ssl: { enabled: true, verifyServer: true, mode: 'verify-full' },
        postgres: { initialDatabase: 'analitica', timeZone: 'UTC' }
      }
    })
    expect(byName['Notas'].input.sqlite).toMatchObject({
      filePath: '/tmp/vortaq-example/notas.db',
      foreignKeys: true,
      attached: [{ alias: 'archivo', filePath: '/tmp/vortaq-example/archivo.db' }]
    })
    expect(byName['Notas'].input.sqlite!.attached[0]).not.toHaveProperty('extra')
    expect(byName['Eventos']).toMatchObject({
      summary: 'MongoDB · cluster0.example.test',
      input: {
        mongo: {
          srv: true,
          defaultDatabase: 'eventos',
          extraOptions: { appName: 'vortaq-example' }
        }
      }
    })
  })

  it('reports a missing or foreign file with an actionable message', () => {
    expect(() => readDesktopConnections(join(dir, 'nope'))).toThrow(
      /No se encontró connections.json de Vortaq/
    )
    expect(() => parseDesktopConnections('{')).toThrow(/no es JSON válido/)
    expect(() => parseDesktopConnections('{"connections": []}')).toThrow(/falta la lista «items»/)
  })

  it('finds the desktop profile folder of each OS, or the test folder', () => {
    expect(desktopProfileDir('darwin', {}, '/Users/ana')).toBe(
      '/Users/ana/Library/Application Support/Vortaq'
    )
    expect(
      desktopProfileDir('win32', { APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' }, 'C:\\Users\\ana')
    ).toBe(join('C:\\Users\\ana\\AppData\\Roaming', 'Vortaq'))
    expect(desktopProfileDir('linux', {}, '/home/ana')).toBe('/home/ana/.config/Vortaq')
    expect(desktopProfileDir('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/ana')).toBe('/xdg/Vortaq')
    expect(desktopProfileDir('darwin', { VORTAQ_TEST_DESKTOP_PROFILE: dir }, '/Users/ana')).toBe(
      dir
    )
  })
})
