/**
 * PostgreSQL driver (docs/multi-engine-design.md, section 5.6): `pg` with
 * explicit credentials, libpq SSL modes (also through an SSH tunnel, with the
 * real host as servername), pinned session settings, a pool per database and
 * query-tab sessions (connection.ts).
 */
import { performance } from 'node:perf_hooks'
import type { ConnectionConfig, ConnectionInput, ConnectionTestResult } from '@shared/types'
import type { Driver, DriverHooks, DriverSecrets, Endpoint } from '../db/driver'
import {
  buildSslPlan,
  connectOrClose,
  createClient,
  networkOf,
  postgresOf,
  shouldRetrySsl,
  type SslPlan
} from './client'
import { PgDriverConnection } from './connection'
import { clientTlsOf, encryptionLabel, pgCatalogFeatures, sslInfoSql } from './catalogCompat'
import {
  PgUserError,
  describeError,
  describeForLog,
  isAuthRejected,
  missingPasswordError
} from './errors'

function requireEndpoint(endpoint: Endpoint | null): Endpoint {
  if (!endpoint) throw new PgUserError('La conexión PostgreSQL necesita un servidor y un puerto')
  return endpoint
}

/** One throw-away client honouring the SSL plan's fallback. */
async function connectOnce(
  config: ConnectionInput,
  secrets: DriverSecrets,
  endpoint: Endpoint,
  plan: SslPlan
) {
  const network = networkOf(config)
  const attempt = async (ssl: SslPlan['first']) => {
    const client = createClient({
      endpoint,
      user: config.username,
      database: postgresOf(config).initialDatabase || 'postgres',
      password: secrets.password,
      ssl,
      connectTimeoutMs: network.connectTimeoutMs,
      keepAliveSec: network.keepAliveSec
    })
    client.on('error', () => undefined)
    await connectOrClose(client)
    return client
  }
  try {
    return await attempt(plan.first)
  } catch (err) {
    if (!shouldRetrySsl(plan, err) || plan.fallback === null) throw err
    return attempt(plan.fallback)
  }
}

export const postgresDriver: Driver = {
  engines: ['postgresql'],

  async test(
    input: ConnectionInput,
    secrets: DriverSecrets,
    endpoint: Endpoint | null,
    startedAt: number
  ): Promise<ConnectionTestResult> {
    const target = requireEndpoint(endpoint)
    const plan = await buildSslPlan(input, target, secrets.sslKeyPassword ?? null)
    const client = await connectOnce(input, secrets, target, plan)
    try {
      const { rows: versionRows } = await client.query<{ num: string }>(
        "SELECT current_setting('server_version_num') AS num"
      )
      const features = pgCatalogFeatures(Number(versionRows[0]?.num ?? 0))
      const { rows } = await client.query<{
        version: string
        ssl: boolean | null
        sslversion: string | null
      }>(
        `SELECT current_setting('server_version') AS version,
                ${sslInfoSql(features)}`
      )
      const row = rows[0]
      const details = [
        encryptionLabel(row?.ssl ?? null, row?.sslversion ?? null, clientTlsOf(client))
      ]
      if (input.ssh.enabled) details.push(`Túnel SSH: ${input.ssh.host}`)
      return {
        ok: true,
        serverVersion: `PostgreSQL ${row?.version ?? ''}`.trim(),
        durationMs: Math.round(performance.now() - startedAt),
        details
      }
    } finally {
      await client.end().catch(() => undefined)
    }
  },

  async open(
    config: ConnectionConfig,
    secrets: DriverSecrets,
    endpoint: Endpoint | null,
    hooks: DriverHooks
  ): Promise<PgDriverConnection> {
    const connection = new PgDriverConnection({
      config,
      endpoint: requireEndpoint(endpoint),
      password: secrets.password,
      sslKeyPassword: secrets.sslKeyPassword ?? null,
      isGuarded: () => hooks.isGuarded?.() ?? false,
      onFatal: hooks.onFatal
    })
    try {
      await connection.probe()
      return connection
    } catch (err) {
      await connection.close().catch(() => undefined)
      throw err
    }
  },

  describeForUser: describeError,
  describeForLog,
  userError: (message) => new PgUserError(message),
  isAuthRejected,
  missingPasswordError
}
