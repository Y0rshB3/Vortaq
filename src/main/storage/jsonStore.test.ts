import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonStore, setJsonStoreReload } from './jsonStore'

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
})
