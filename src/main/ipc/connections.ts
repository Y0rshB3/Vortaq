import { connectionSaveError, engineAvailabilityError } from '@shared/connectionValidation'
import type { ConnectionConfig, ConnectionInput } from '@shared/types'
import type { AppContext } from '../context'
import { DB_PASSWORD } from '../credentials/store'
import { getConnectionManager } from '../db/manager'
import { getAiService } from '../ai'
import type { HandleFn } from './router'

/** Fields whose change invalidates an open pool. */
function endpointSignature(c: ConnectionInput | ConnectionConfig): string {
  const base = [
    c.host,
    c.port,
    c.username,
    c.authMode ?? 'password',
    c.ssh,
    c.ssl,
    c.initialQueries
  ]
  // MySQL keeps exactly the fields it always compared; other engines add theirs.
  if ((c.engine ?? 'mysql') === 'mysql') return JSON.stringify(base)
  return JSON.stringify([...base, c.engine, c.network, c.postgres, c.sqlite, c.mongo])
}

function validateInput(input: ConnectionInput): void {
  const problem = connectionSaveError(input, { platform: process.platform })
  if (problem) throw new Error(problem)
}

/** Refuses engines without a driver in this build (e.g. a hand-edited record). */
function assertEngineAvailable(input: Pick<ConnectionInput, 'engine'> | null): void {
  const problem = input ? engineAvailabilityError(input) : null
  if (problem) throw new Error(problem)
}

export function registerConnectionsHandlers(ctx: AppContext, handle: HandleFn): void {
  const manager = getConnectionManager(ctx)

  handle('connections:list', () => ctx.connections.list())
  handle('connections:get', (id) => ctx.connections.get(id))

  handle('connections:save', async (input) => {
    validateInput(input)
    const previous = input.id ? ctx.connections.get(input.id) : null
    const saved = ctx.connections.save(input)
    // A live pool built with the old endpoint would silently keep using it.
    if (
      previous &&
      manager.isOpen(saved.id) &&
      endpointSignature(previous) !== endpointSignature(saved)
    ) {
      await manager.close(saved.id)
    }
    return saved
  })

  handle('connections:delete', async (id) => {
    await manager.close(id)
    ctx.credentials.deleteAll(id)
    ctx.connections.delete(id)
    // The assistant's notes and conversations of that connection go with it.
    const ai = getAiService(ctx)
    ai.conversations.deleteConnection(id)
    ai.memory.deleteConnection(id)
  })

  handle('connections:test', (input, password, sshPassword) => {
    assertEngineAvailable(input)
    return manager.test(input, password, sshPassword)
  })

  handle('connections:setPassword', (id, password) =>
    ctx.credentials.set(DB_PASSWORD, id, password)
  )
  handle('connections:hasPassword', (id) => ctx.credentials.has(DB_PASSWORD, id))
  handle('connections:setSshPassword', (id, password) => ctx.credentials.set('ssh', id, password))
  handle('connections:hasSshPassword', (id) => ctx.credentials.has('ssh', id))
  handle('connections:setSslKeyPassword', (id, password) =>
    ctx.credentials.set('sslKey', id, password)
  )
  handle('connections:hasSslKeyPassword', (id) => ctx.credentials.has('sslKey', id))

  handle('connections:open', (id) => {
    assertEngineAvailable(ctx.connections.get(id))
    return manager.open(id)
  })
  handle('connections:close', (id) => manager.close(id))
  handle('connections:isOpen', (id) => manager.isOpen(id))
}
