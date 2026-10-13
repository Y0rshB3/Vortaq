import type { AppContext } from '../context'
import { envVar } from '../env'
import { getLogger } from '../log'
import { getConnectionManager } from '../db/manager'
import type { FetchFn } from './adapter'
import { FixtureAdapter } from './fixture'
import { AiService } from './service'

export { AiService } from './service'

const services = new WeakMap<AppContext, AiService>()

let hostFetch: FetchFn | null = null

/**
 * Registers the network function every provider call goes through (a host
 * port, like setSqliteSpawner): the desktop app registers Electron's net.fetch
 * (system proxy and certificates, electronFetch.ts) at startup; other hosts
 * and tests keep Node's global fetch. Network access stays in main.
 */
export function setAiFetch(fetchFn: FetchFn | null): void {
  hostFetch = fetchFn
}

/** Read at call time, so a service built before setAiFetch still uses the host's fetch. */
const providerFetch: FetchFn = ((input: Parameters<FetchFn>[0], init?: RequestInit) =>
  (hostFetch ?? fetch)(input, init)) as FetchFn

export function getAiService(ctx: AppContext): AiService {
  let service = services.get(ctx)
  if (service) return service
  const log = getLogger('ai')
  // Test-only fake provider, honoured only with a scratch profile.
  const fixture = ctx.isolatedProfile === true && envVar('AI_FIXTURE') === '1'
  if (fixture) log.info('ai: VORTAQ_AI_FIXTURE=1, answers come from the fake provider (test mode)')
  const manager = getConnectionManager(ctx)
  service = new AiService({
    userDataPath: ctx.userDataPath,
    credentials: ctx.credentials,
    settings: ctx.settings,
    environmentOf: (id) => ctx.connections.get(id)?.environment ?? null,
    acquire: (connectionId, schema) => manager.acquire(connectionId, schema),
    isPostgres: (id) => ctx.connections.get(id)?.engine === 'postgresql',
    acquirePg: async (connectionId, database) => {
      const { isPgConnection } = await import('../postgres/connection')
      const connection = await manager.connection(connectionId)
      if (!isPgConnection(connection)) throw new Error('La conexión no es PostgreSQL.')
      const session = await connection.acquire(database ? { database, schema: null } : null)
      // set_config of the explain path is user state: reset the pooled session on release.
      session.usage.userSql = true
      return session
    },
    isMongo: (id) => ctx.connections.get(id)?.engine === 'mongodb',
    engineOf: (id) => ctx.connections.get(id)?.engine ?? null,
    mongoSource: async (connectionId) => {
      const { isMongoConnection } = await import('../mongo/connection')
      const { mongoStructureSource } = await import('./mongoMetadata')
      const connection = await manager.connection(connectionId)
      if (!isMongoConnection(connection)) throw new Error('La conexión no es MongoDB.')
      return mongoStructureSource(connection)
    },
    isSqlite: (id) => ctx.connections.get(id)?.engine === 'sqlite',
    acquireSqlite: async (connectionId) => {
      const { isSqliteConnection } = await import('../sqlite/connection')
      const connection = await manager.connection(connectionId)
      if (!isSqliteConnection(connection)) throw new Error('La conexión no es SQLite.')
      // Each query takes the connection lock on its own (behind any running script).
      return connection.acquire(null)
    },
    emit: (channel, payload) => ctx.emit(channel, payload),
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
    fetch: providerFetch,
    ...(fixture ? { adapterFactory: () => new FixtureAdapter() } : {})
  })
  services.set(ctx, service)
  return service
}
