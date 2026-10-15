import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  JsonStore,
  READ_ONLY_STORE_MESSAGE,
  setJsonStoreReadOnly,
  setJsonStoreReload
} from './jsonStore'

interface Doc {
  items: string[]
}

describe('JsonStore', () => {
  let dir: string
  let file: string
  const open = (): JsonStore<Doc> => new JsonStore<Doc>(file, () => ({ items: [] }))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-jsonstore-'))
    file = join(dir, 'doc.json')
  })
  afterEach(() => {
    setJsonStoreReload(false)
    setJsonStoreReadOnly(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads once by default (the desktop app: one process per profile)', () => {
    const a = open()
    const b = open()
    a.update((d) => d.items.push('a'))
    expect(b.get().items).toEqual([])
  })

  it('with reload on, a second process sees and keeps the other one’s changes', () => {
    setJsonStoreReload(true)
    const a = open()
    const b = open()
    a.update((d) => d.items.push('from a'))
    expect(b.get().items).toEqual(['from a'])
    // b mutates the fresh copy: a's item is not lost.
    b.update((d) => d.items.push('from b'))
    expect(a.get().items).toEqual(['from a', 'from b'])
    expect(open().get().items).toEqual(['from a', 'from b'])
    // Its own writes do not trigger a needless reload of an object it already holds.
    const held = a.get()
    a.update((d) => d.items.push('again'))
    expect(a.get()).toBe(held)
  })

  it('read-only mode (the --mcp process) never writes, never moves a bad file aside, and still sees changes', () => {
    setJsonStoreReload(true)
    writer().update((d) => d.items.push('saved by the app'))
    setJsonStoreReadOnly(true)
    const reader = open()
    expect(reader.get().items).toEqual(['saved by the app'])
    expect(() => reader.update((d) => d.items.push('x'))).toThrow(READ_ONLY_STORE_MESSAGE)
    expect(() => reader.replace({ items: [] })).toThrow(READ_ONLY_STORE_MESSAGE)
    expect(reader.get().items).toEqual(['saved by the app'])
    // The app rewrites the file while the reader is alive: the next get() sees it.
    setJsonStoreReadOnly(false)
    writer().update((d) => d.items.push('later'))
    setJsonStoreReadOnly(true)
    expect(reader.get().items).toEqual(['saved by the app', 'later'])
    // A corrupt file is left untouched: defaults, no .corrupt-* copy.
    writeFileSync(file, '{ not json')
    expect(open().get().items).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
    expect(readdirSync(dir).filter((n) => n.includes('corrupt'))).toEqual([])
    expect(existsSync(file)).toBe(true)
  })

  const writer = (): JsonStore<Doc> => open()
})
