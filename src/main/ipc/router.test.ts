import { describe, expect, it } from 'vitest'
import { DbUserError, ServerError } from '../db/errors'
import { configureLog } from '../log'
import { HandlerRegistry } from './router'

describe('HandlerRegistry', () => {
  it('invokes the registered handler with its arguments', async () => {
    const registry = new HandlerRegistry()
    registry.handle('connections:isOpen', (id) => id === 'a')
    registry.handle('connections:get', async () => null)
    expect(await registry.invoke('connections:isOpen', 'a')).toBe(true)
    expect(await registry.invoke('connections:get', 'x')).toBeNull()
    expect(registry.channels()).toEqual(['connections:isOpen', 'connections:get'])
    expect(registry.has('connections:isOpen')).toBe(true)
    expect(registry.has('db:execute')).toBe(false)
  })

  it('replaces an earlier registration of the same channel', async () => {
    const registry = new HandlerRegistry()
    registry.handle('connections:isOpen', () => false)
    registry.handle('connections:isOpen', () => true)
    expect(await registry.invoke('connections:isOpen', 'a')).toBe(true)
    expect(registry.channels()).toEqual(['connections:isOpen'])
  })

  it('refuses a channel nobody registered', async () => {
    await expect(new HandlerRegistry().invoke('db:execute', 'a', 'SELECT 1')).rejects.toThrow(
      'Canal no disponible: db:execute'
    )
  })

  it('rethrows only the message and never logs server text', async () => {
    const events: string[] = []
    configureLog({ sink: (e) => events.push(e.message) })
    try {
      const registry = new HandlerRegistry()
      registry.handle('connections:open', () => {
        throw new DbUserError('La conexión x no existe')
      })
      registry.handle('db:execute', () => {
        throw new ServerError("Duplicate entry 'secret-row' for key 'PRIMARY'", 'ER_DUP_ENTRY')
      })
      const user = await registry.invoke('connections:open', 'x').catch((e: unknown) => e)
      expect(user).toBeInstanceOf(Error)
      expect(user).not.toBeInstanceOf(DbUserError)
      expect((user as Error).message).toBe('La conexión x no existe')
      const server = await registry.invoke('db:execute', 'x', 'INSERT').catch((e: unknown) => e)
      expect((server as Error).message).toContain('Duplicate entry')
      expect(events.some((m) => m.includes('connections:open failed'))).toBe(true)
      expect(events.join('\n')).not.toContain('secret-row')
    } finally {
      configureLog({ sink: null })
    }
  })
})
