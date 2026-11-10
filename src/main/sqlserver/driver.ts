/**
 * SQL Server driver (docs/sqlserver-design.md): tedious with every option
 * explicit (client.ts), a pool per database and the query tabs' own sessions
 * (connection.ts), batches split at GO (query.ts).
 */
import { performance } from 'node:perf_hooks'
import type { ConnectionConfig, ConnectionInput, ConnectionTestResult } from '@shared/types'
import type { Driver, DriverHooks, DriverSecrets, Endpoint } from '../db/driver'
import { buildConfiguration, connectClient, sqlserverOf } from './client'
import { MsDriverConnection, versionNumber } from './connection'
import {
  MsUserError,
  describeError,
  describeForLog,
  isAuthRejected,
  missingPasswordError
} from './errors'
import { MsSession } from './session'

function requireEndpoint(endpoint: Endpoint | null): Endpoint {
  if (!endpoint) throw new MsUserError('La conexión SQL Server necesita un servidor y un puerto')
  return endpoint
}

const RELEASES: Record<number, string> = {
  17: '2025',
  16: '2022',
  15: '2019',
  14: '2017',
  13: '2016',
  12: '2014',
  11: '2012'
}

/** «SQL Server 2022 (16.0.4305.5)», «Azure SQL Database (12.0.2000.8)». */
export function productLabel(version: string, engineEdition: number): string {
  if (engineEdition === 5) return `Azure SQL Database (${version})`
  if (engineEdition === 8) return `Azure SQL Managed Instance (${version})`
  const year = RELEASES[Math.floor(versionNumber(version) / 1_000_000)]
  return `SQL Server${year ? ` ${year}` : ''} (${version})`
}

export const sqlserverDriver: Driver = {
  engines: ['sqlserver'],

  async test(
    input: ConnectionInput,
    secrets: DriverSecrets,
    endpoint: Endpoint | null,
    startedAt: number
  ): Promise<ConnectionTestResult> {
    const target = requireEndpoint(endpoint)
    const database = sqlserverOf(input).initialDatabase.trim() || null
    const connection = await connectClient(
      buildConfiguration(input, { password: secrets.password }, { endpoint: target, database })
    )
    const session = new MsSession('', '', database ?? '', connection, async () => undefined)
    try {
      const [row] = await session.query<{ v: string; ed: number; db: string }>(
        "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS v, CAST(SERVERPROPERTY('EngineEdition') AS int) AS ed, DB_NAME() AS db"
      )
      let encryption = 'Cifrado: desconocido'
      try {
        const [enc] = await session.query<{ e: string | null }>(
          'SELECT encrypt_option AS e FROM sys.dm_exec_connections WHERE session_id = @@SPID'
        )
        if (enc?.e) encryption = enc.e === 'TRUE' ? 'Cifrado: TLS' : 'sin cifrar'
      } catch {
        /* no VIEW SERVER STATE */
      }
      const details = [encryption, `Base de datos: ${row?.db ?? ''}`]
      if (input.ssh?.enabled) details.push(`Túnel SSH: ${input.ssh.host}`)
      return {
        ok: true,
        serverVersion: productLabel(row?.v ?? '', Number(row?.ed ?? 0)),
        durationMs: Math.round(performance.now() - startedAt),
        details
      }
    } finally {
      // After the request callback (closing inside a row handler crashes tedious 20.3.8).
      connection.close()
    }
  },

  async open(
    config: ConnectionConfig,
    secrets: DriverSecrets,
    endpoint: Endpoint | null,
    hooks: DriverHooks
  ): Promise<MsDriverConnection> {
    const connection = new MsDriverConnection({
      config,
      endpoint: requireEndpoint(endpoint),
      password: secrets.password,
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
  userError: (message) => new MsUserError(message),
  isAuthRejected,
  missingPasswordError
}
