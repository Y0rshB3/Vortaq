import { describe, expect, it } from 'vitest'
import { parseVersion } from './semver'
import {
  WHATS_NEW,
  tourStepsOf,
  whatsNewBetween,
  whatsNewFor,
  type WhatsNewEntry
} from './whatsNew'

const entries: WhatsNewEntry[] = ['0.1.1', '0.1.2', '0.1.3', '0.1.4'].map((version) => ({
  version,
  date: '2026-10-06',
  highlights: [version]
}))
const versions = (list: WhatsNewEntry[]) => list.map((e) => e.version)

describe('whatsNewBetween', () => {
  it('returns the versions after previous up to current, newest first', () => {
    expect(versions(whatsNewBetween('0.1.2', '0.1.4', entries))).toEqual(['0.1.4', '0.1.3'])
    expect(versions(whatsNewBetween('0.1.3', '0.1.4', entries))).toEqual(['0.1.4'])
    expect(versions(whatsNewBetween('0.1.0', '0.1.2', entries))).toEqual(['0.1.2', '0.1.1'])
  })

  it('is empty for a fresh profile, the same version, a downgrade or invalid versions', () => {
    expect(whatsNewBetween(null, '0.1.4', entries)).toEqual([])
    expect(whatsNewBetween(undefined, '0.1.4', entries)).toEqual([])
    expect(whatsNewBetween('0.1.4', '0.1.4', entries)).toEqual([])
    expect(whatsNewBetween('0.1.4', '0.1.2', entries)).toEqual([])
    expect(whatsNewBetween('x', '0.1.4', entries)).toEqual([])
    expect(whatsNewBetween('0.1.2', 'dev', entries)).toEqual([])
  })

  it('skips versions without entries (unknown versions)', () => {
    expect(whatsNewBetween('0.1.4', '2.0.0', entries)).toEqual([])
    expect(versions(whatsNewBetween('0.1.3', '1.0.0', entries))).toEqual(['0.1.4'])
  })

  it('a pre-release shows the notes of the release it leads to', () => {
    expect(versions(whatsNewBetween('0.0.1', '0.1.1-beta.1', entries))).toEqual(['0.1.1'])
    expect(versions(whatsNewBetween('0.1.2', '0.1.4-alpha.1', entries))).toEqual(['0.1.4', '0.1.3'])
    // from the pre-release to the final release, the notes show again (they may have grown)
    expect(versions(whatsNewBetween('0.1.4-alpha.1', '0.1.4', entries))).toEqual(['0.1.4'])
    expect(whatsNewFor('0.1.3-rc.2', entries)?.highlights).toEqual(['0.1.3'])
  })

  it('finds the entry of one version', () => {
    expect(whatsNewFor('0.1.3', entries)?.highlights).toEqual(['0.1.3'])
    expect(whatsNewFor('0.9.9', entries)).toBeNull()
  })
})

describe('WHATS_NEW (curated list)', () => {
  it('has valid, unique versions and short lists', () => {
    const seen = new Set<string>()
    for (const e of WHATS_NEW) {
      expect(parseVersion(e.version), e.version).not.toBeNull()
      expect(seen.has(e.version)).toBe(false)
      seen.add(e.version)
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(e.highlights.length).toBeGreaterThan(0)
      expect(e.highlights.length).toBeLessThanOrEqual(5)
    }
    expect([...seen]).toEqual(expect.arrayContaining(['0.1.1', '0.1.2', '0.1.3', '0.1.4']))
  })

  it('0.1.5 explains the typed-confirmation environments and that production is always on', () => {
    const entry = whatsNewFor('0.1.5')
    expect(entry?.highlights[0]).toMatch(/Ajustes › Seguridad.*Producción por defecto/)
    expect(entry?.important?.join(' ')).toMatch(/Producción ahora siempre pide escribir el nombre/)
  })

  it('0.1.6 announces the AI assistant and that only the structure is sent', () => {
    expect(whatsNewFor('0.1.6')?.highlights.join(' ')).toMatch(
      /Asistente de IA con tu propia clave.*solo se envía la estructura/
    )
  })

  it('0.1.4 points to the new switch in Ajustes › Seguridad', () => {
    expect(whatsNewFor('0.1.4')?.important?.join(' ')).toMatch(/Ajustes › Seguridad/)
  })

  it('0.1.7 announces the tour, the Navicat detection and the field glow fix', () => {
    expect(whatsNewFor('0.1.7')?.highlights).toEqual([
      'Tour de bienvenida y guía de novedades',
      'Detección automática de Navicat',
      'El brillo de los campos ya no cruza la etiqueta ni se ve cuadrado'
    ])
  })

  it('2.0.0 announces the Vortaq name, .vqb copies, imports and .sql export, PostgreSQL, SQLite and MongoDB, MariaDB and the data move', () => {
    const entry = whatsNewFor('2.0.0')
    expect(whatsNewFor('2.0.0-alpha.1')).toBe(entry)
    expect(entry?.highlights).toEqual([
      'ElectronDB ahora se llama Vortaq, con nuevo icono y barra de herramientas reorganizada',
      'Copias .vqb: formato propio, abierto y con cifrado opcional',
      'Importa conexiones y copias desde DBeaver, MySQL Workbench, Navicat y .sql, y exporta copias en .sql',
      'PostgreSQL, SQLite y MongoDB, con copias .vqb y tareas automáticas: Conexión › Nueva conexión',
      'MariaDB como motor propio: secuencias, tablas versionadas y cuentas ed25519/parsec'
    ])
    expect(entry?.important).toEqual(['Tus datos se trasladan automáticamente a Vortaq'])
    expect(entry?.tour?.map((s) => s.target)).toEqual([
      'toolbar-objects',
      'toolbar-more',
      'toolbar-more',
      'toolbar-backup',
      'toolbar-connection',
      'toolbar-connection',
      'toolbar-connection',
      'toolbar-connection',
      'toolbar-automation',
      'toolbar-ai'
    ])
    expect(JSON.stringify(entry)).not.toContain('vista previa')
    // ElectronDB ended at 0.1.9: updating to Vortaq 2.0.0 shows this entry once.
    expect(versions(whatsNewBetween('0.1.9', '2.0.0'))).toEqual(['2.0.0'])
    expect(versions(whatsNewBetween('0.1.9', '2.0.0-alpha.1'))).toEqual(['2.0.0'])
  })

  it('2.0.1 announces the new job editor with one tour step on Automatización', () => {
    const entry = whatsNewFor('2.0.1')
    expect(entry?.highlights.join(' ')).toMatch(/Añadir pasos/)
    expect(entry?.highlights.join(' ')).toMatch(/«Restaurar paquete»: un solo paso/)
    expect(entry?.tour).toHaveLength(1)
    expect(entry?.tour?.[0].target).toBe('toolbar-automation')
  })

  it('2.0.2 announces copy and export of results with one tour step on Nueva consulta', () => {
    const entry = whatsNewFor('2.0.2')
    expect(entry?.highlights.join(' ')).toMatch(/Copiar como/)
    expect(entry?.highlights.join(' ')).toMatch(/Excel/)
    expect(entry?.highlights.join(' ')).toMatch(/solo lectura/)
    expect(entry?.tour?.map((s) => s.target)).toEqual(['toolbar-query'])
    expect(versions(whatsNewBetween('2.0.1', '2.0.2'))).toEqual(['2.0.2'])
  })

  it('2.1.0 announces agents (MCP), its levels and the privacy note, with a tour step on Ajustes', () => {
    const entry = whatsNewFor('2.1.0')
    const text = entry?.highlights.join(' ') ?? ''
    expect(text).toMatch(/Agentes \(MCP\)/)
    expect(text).toMatch(/«Solo estructura», «Lectura» \(por defecto\) o «Lectura y escritura»/)
    expect(text).toMatch(/producción nunca permiten escribir/)
    expect(text).toMatch(/proveedor de IA/)
    expect(entry?.tour?.map((s) => s.target)).toEqual(['toolbar-settings'])
    expect(versions(whatsNewBetween('2.0.2', '2.1.0'))).toEqual(['2.1.0'])
  })

  it('2.1.1 announces the per-connection agents switches in Ajustes', () => {
    const entry = whatsNewFor('2.1.1')
    const text = entry?.highlights.join(' ') ?? ''
    expect(text).toMatch(/Ajustes › Agentes \(MCP\) lista todas tus conexiones/)
    expect(text).toMatch(/Producción «Lectura y escritura» sigue sin poder elegirse/)
    expect(entry?.tour?.map((s) => s.target)).toEqual(['toolbar-settings'])
    expect(versions(whatsNewBetween('2.1.0', '2.1.1'))).toEqual(['2.1.1'])
  })

  it('2.2.0 announces the foreign key picker, the ENUM list and Cmd/Ctrl+D', () => {
    const entry = whatsNewFor('2.2.0')
    const text = entry?.highlights.join(' ') ?? ''
    expect(text).toMatch(/«Elegir de <tabla>»/)
    expect(text).toMatch(/ENUM se editan con su lista/)
    expect(text).toMatch(/Cmd\/Ctrl\+D abre la estructura/)
    expect(entry?.highlights.length).toBeLessThanOrEqual(5)
    expect(versions(whatsNewBetween('2.1.2', '2.2.0'))).toEqual(['2.2.0'])
  })

  it('2.1.2 says agents (MCP) work with any MCP client and names the new snippets', () => {
    const entry = whatsNewFor('2.1.2')
    const text = entry?.highlights.join(' ') ?? ''
    expect(text).toMatch(/Codex, Gemini CLI, Antigravity y OpenCode/)
    expect(text).toMatch(/cualquier cliente MCP/)
    expect(text).toMatch(/«Otro cliente»/)
    expect(entry?.tour?.map((s) => s.target)).toEqual(['toolbar-settings'])
    expect(versions(whatsNewBetween('2.1.1', '2.1.2'))).toEqual(['2.1.2'])
  })

  it('0.1.8 announces connections without a password', () => {
    expect(whatsNewFor('0.1.8')?.highlights).toEqual([
      'Conexiones sin contraseña: para proxies, túneles o certificados (Autenticación › Sin contraseña)'
    ])
  })

  it('«Mostrarme cómo» steps are short and point at data-tour names', () => {
    for (const e of WHATS_NEW) {
      for (const step of e.tour ?? []) {
        expect(step.title.length, step.title).toBeLessThanOrEqual(40)
        expect(step.text.split(/[.?!](\s|$)/).filter((x) => x?.trim()).length).toBeLessThanOrEqual(
          2
        )
        for (const t of [step.target ?? []].flat()) expect(t).toMatch(/^[a-z][a-z-]*$/)
      }
    }
    // The restore option lives in a dialog: explained in text, no highlight.
    const restore = whatsNewFor('0.1.6')?.tour?.find((s) => /Solo estructura/.test(s.title))
    expect(restore?.target).toBeUndefined()
  })
})

describe('tourStepsOf', () => {
  it('joins the steps of the shown versions, oldest first', () => {
    const list = whatsNewBetween('0.1.5', '0.1.7')
    expect(tourStepsOf(list).map((s) => s.title)).toEqual([
      'Asistente de IA',
      'Generar SQL con IA',
      'Restaurar «Solo estructura»',
      'Tour de bienvenida',
      'Detección automática de Navicat'
    ])
  })

  it('is empty when no version has steps', () => {
    expect(tourStepsOf(whatsNewBetween('0.1.2', '0.1.4'))).toEqual([])
  })
})
