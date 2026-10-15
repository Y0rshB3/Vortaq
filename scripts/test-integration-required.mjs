/* global process */
/**
 * `npm run test:integration:required`: the integration suites with skipping turned off.
 *
 * Runs `vitest run --project node` (same as `npm run test:integration`) with
 * VORTAQ_REQUIRE_INTEGRATION=1, so a missing VORTAQ_TEST_MYSQL_URL (MySQL 8.4),
 * VORTAQ_TEST_MYSQL57_URL (MySQL 5.7), VORTAQ_TEST_MARIADB_URL (MariaDB 11),
 * VORTAQ_TEST_PG_URL (PostgreSQL 17), VORTAQ_TEST_MONGO_URL (MongoDB 8.2) or
 * VORTAQ_TEST_MONGO_RS_URL (MongoDB 8.2 replica set) makes the run fail instead of skip
 * (tests/integration/targets.ts); VORTAQ_TEST_SSH_URL (the PostgreSQL SSH-tunnel test)
 * stays optional. The MCP suites (tests/integration/mcp*.test.ts) use the same servers, and
 * their SQLite suite runs real worker processes without one. Extra arguments are passed to vitest.
 * A script instead of `VAR=1 vitest` so it also works from PowerShell and cmd.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vitest = resolve(root, 'node_modules', 'vitest', 'vitest.mjs')

const result = spawnSync(
  process.execPath,
  [vitest, 'run', '--project', 'node', ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VORTAQ_REQUIRE_INTEGRATION: '1' }
  }
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
