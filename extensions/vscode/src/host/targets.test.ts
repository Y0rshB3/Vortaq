import { describe, expect, it } from 'vitest'
import {
  DocumentTargets,
  MAX_SAVED_TARGETS,
  TARGETS_KEY,
  targetLabel,
  type StateStore
} from './targets'

/** In-memory Memento (vscode.ExtensionContext.workspaceState). */
function memento(): StateStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {}
  return {
    data,
    get: <T>(key: string) => data[key] as T | undefined,
    update: async (key: string, value: unknown) => {
      data[key] = JSON.parse(JSON.stringify(value))
    }
  }
}

describe('connection and database per document', () => {
  it('keeps each document on its own connection and database', async () => {
    const targets = new DocumentTargets(memento())
    await targets.set('file:///a.sql', { connectionId: 'c1', database: 'tienda' })
    await targets.set('file:///b.sql', { connectionId: 'c2', database: 'app', schema: 'public' })
    expect(targets.get('file:///a.sql')).toEqual({ connectionId: 'c1', database: 'tienda' })
    expect(targets.get('file:///b.sql')).toEqual({
      connectionId: 'c2',
      database: 'app',
      schema: 'public'
    })
    expect(targets.get('file:///c.sql')).toBeNull()
  })

  it('remembers saved files in the workspace state, untitled documents only for the session', async () => {
    const state = memento()
    const first = new DocumentTargets(state)
    await first.set('file:///a.sql', { connectionId: 'c1', database: 'tienda' })
    await first.set('untitled:Untitled-1', { connectionId: 'c1', database: null })
    expect(Object.keys(state.data[TARGETS_KEY] as object)).toEqual(['file:///a.sql'])
    const later = new DocumentTargets(state)
    expect(later.get('file:///a.sql')).toEqual({ connectionId: 'c1', database: 'tienda' })
    expect(later.get('untitled:Untitled-1')).toBeNull()
    // A closed untitled document frees its URI for the next one.
    first.closed('untitled:Untitled-1')
    expect(first.get('untitled:Untitled-1')).toBeNull()
  })

  it('a deleted connection releases every document that used it', async () => {
    const state = memento()
    const targets = new DocumentTargets(state)
    const changed: string[] = []
    targets.onDidChange((uri) => changed.push(uri))
    await targets.set('file:///a.sql', { connectionId: 'gone', database: 'x' })
    await targets.set('untitled:Untitled-2', { connectionId: 'gone', database: null })
    await targets.set('file:///b.sql', { connectionId: 'kept', database: 'y' })
    changed.length = 0
    await targets.forgetConnection('gone')
    expect(targets.get('file:///a.sql')).toBeNull()
    expect(targets.get('untitled:Untitled-2')).toBeNull()
    expect(targets.get('file:///b.sql')).toEqual({ connectionId: 'kept', database: 'y' })
    expect(changed.sort()).toEqual(['file:///a.sql', 'untitled:Untitled-2'])
  })

  it('ignores malformed stored entries and keeps at most MAX_SAVED_TARGETS', async () => {
    const state = memento()
    state.data[TARGETS_KEY] = {
      'file:///bad.sql': { database: 3 },
      'file:///ok.sql': { connectionId: 'c', database: null }
    }
    const targets = new DocumentTargets(state)
    expect(targets.get('file:///bad.sql')).toBeNull()
    expect(targets.get('file:///ok.sql')).toEqual({ connectionId: 'c', database: null })
    for (let i = 0; i < MAX_SAVED_TARGETS + 5; i++)
      await targets.set(`file:///q${i}.sql`, { connectionId: 'c', database: null })
    expect(Object.keys(state.data[TARGETS_KEY] as object)).toHaveLength(MAX_SAVED_TARGETS)
  })

  it('labels the target for the status bar', () => {
    expect(targetLabel(null)).toBe('')
    expect(targetLabel({ connectionId: 'c', database: null })).toBe('')
    expect(targetLabel({ connectionId: 'c', database: 'app', schema: 'ventas' })).toBe('app.ventas')
  })
})
