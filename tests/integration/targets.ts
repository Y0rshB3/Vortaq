import { describe, it } from 'vitest'
import { envVar } from '@main/env'

/**
 * MySQL servers the integration suites run against (docs/multi-engine-design.md, 15.3).
 *
 * Each suite is registered once per server. Without its URL a server's suite is skipped,
 * unless VORTAQ_REQUIRE_INTEGRATION=1 (set by `npm run test:integration:required`):
 * then the missing URL is a failing test, so a green gate always means the suites ran.
 *
 * Start the throwaway servers with `docker compose -f tests/docker-compose.yml up -d --wait`.
 */
export interface MysqlTarget {
  /** Shown in the suite name. */
  label: string
  /** Version prefix the server must report (`VERSION()` starts with it). */
  version: '8.4' | '5.7'
  /** Env var name without the VORTAQ_/NAVIDOG_ prefix. */
  envName: string
  /** Throwaway server URL, e.g. mysql://root:navidog@127.0.0.1:33357/navidog_test. */
  url: string
  /**
   * MySQL 5.7. Use it only where the server genuinely differs from 8.x; every split is
   * listed (with the reason) at the place it is made.
   */
  is57: boolean
}

interface TargetSpec {
  label: string
  version: MysqlTarget['version']
  envName: string
  example: string
}

const TARGETS: TargetSpec[] = [
  {
    label: 'MySQL 8.4',
    version: '8.4',
    envName: 'TEST_MYSQL_URL',
    example: 'mysql://root:navidog@127.0.0.1:33306/navidog_test'
  },
  {
    label: 'MySQL 5.7',
    version: '5.7',
    envName: 'TEST_MYSQL57_URL',
    example: 'mysql://root:navidog@127.0.0.1:33357/navidog_test'
  }
]

export function integrationRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return envVar('REQUIRE_INTEGRATION', env)?.trim() === '1'
}

function urlFor(spec: TargetSpec, env: NodeJS.ProcessEnv): string | undefined {
  const value = envVar(spec.envName, env)?.trim()
  return value ? value : undefined
}

/**
 * Registers `body` as a describe block per MySQL server. Inside, `target.url` is always set.
 */
export function describeMysql(name: string, body: (target: MysqlTarget) => void): void {
  for (const spec of TARGETS) {
    const title = `${name} [${spec.label}]`
    const url = urlFor(spec, process.env)
    if (url) {
      describe(title, () =>
        body({
          label: spec.label,
          version: spec.version,
          envName: spec.envName,
          url,
          is57: spec.version === '5.7'
        })
      )
    } else if (integrationRequired()) {
      describe(title, () => {
        it(`needs VORTAQ_${spec.envName}`, () => {
          throw new Error(
            `VORTAQ_${spec.envName} is not set, and VORTAQ_REQUIRE_INTEGRATION=1 forbids skipping. ` +
              `Start the test servers (docker compose -f tests/docker-compose.yml up -d --wait) and set ` +
              `VORTAQ_${spec.envName}=${spec.example}`
          )
        })
      })
    } else {
      describe.skip(title, () => {
        it(`needs VORTAQ_${spec.envName}`, () => undefined)
      })
    }
  }
}

/* ---------- other engines (one server each) ---------- */

export interface ServerSpec {
  /** Shown in the suite name. */
  label: string
  /** Env var name without the VORTAQ_/ELECTRONDB_/NAVIDOG_ prefix. */
  envName: string
  example: string
}

/** MariaDB 11 reached through a `mysql` connection (P1b fixes). */
export const MARIADB_TARGET: ServerSpec = {
  label: 'MariaDB 11',
  envName: 'TEST_MARIADB_URL',
  example: 'mysql://root:navidog@127.0.0.1:33311/navidog_test'
}

/** PostgreSQL 17 (P2a/P2b). */
export const POSTGRES_TARGET: ServerSpec = {
  label: 'PostgreSQL 17',
  envName: 'TEST_PG_URL',
  example: 'postgres://postgres:navidog@127.0.0.1:55432/navidog_test'
}

/**
 * Registers `body` once for a single server. Same rule as describeMysql: without its URL the
 * suite is skipped, unless VORTAQ_REQUIRE_INTEGRATION=1 makes the missing URL a failure.
 */
export function describeServer(spec: ServerSpec, name: string, body: (url: string) => void): void {
  const title = `${name} [${spec.label}]`
  const url = envVar(spec.envName, process.env)?.trim()
  if (url) describe(title, () => body(url))
  else if (integrationRequired()) {
    describe(title, () => {
      it(`needs VORTAQ_${spec.envName}`, () => {
        throw new Error(
          `VORTAQ_${spec.envName} is not set, and VORTAQ_REQUIRE_INTEGRATION=1 forbids skipping. ` +
            `Start the test servers (docker compose -f tests/docker-compose.yml up -d --wait) and set ` +
            `VORTAQ_${spec.envName}=${spec.example}`
        )
      })
    })
  } else {
    describe.skip(title, () => {
      it(`needs VORTAQ_${spec.envName}`, () => undefined)
    })
  }
}

/** MongoDB 8.2 standalone (P4a/P4b), with authentication. */
export const SQLSERVER_TARGET: ServerSpec = {
  label: 'SQL Server 2022',
  envName: 'TEST_MSSQL_URL',
  example: 'mssql://sa:Navidog_2026@127.0.0.1:51433/navidog_test'
}

export const MONGO_TARGET: ServerSpec = {
  label: 'MongoDB 8.2',
  envName: 'TEST_MONGO_URL',
  example: 'mongodb://root:navidog@127.0.0.1:57017/?authSource=admin'
}

/** MongoDB 8.2 single-node replica set (transactions), without authentication. */
export const MONGO_RS_TARGET: ServerSpec = {
  label: 'MongoDB 8.2 replica set',
  envName: 'TEST_MONGO_RS_URL',
  example: 'mongodb://127.0.0.1:57018/?replicaSet=rs0'
}
