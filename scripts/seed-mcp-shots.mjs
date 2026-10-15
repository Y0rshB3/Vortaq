/* global process, console */
/**
 * Seeds a scratch profile for the «Agentes (MCP)» screenshots (steps 49* of
 * src/main/screenshots.ts): connections with each agent level (one in
 * production, where «Lectura y escritura» is blocked), one not available to
 * agents, and the global switch on. No server needed: the steps never connect.
 *
 *   node scripts/seed-mcp-shots.mjs
 *   npm run build
 *   VORTAQ_USER_DATA=$TMPDIR/vortaq-mcp-shots/profile VORTAQ_PLAIN_SECRETS=1 \
 *   VORTAQ_SCREENSHOTS=$TMPDIR/vortaq-mcp-shots VORTAQ_SHOTS_ONLY=49 npx electron .
 *
 * Env: VORTAQ_SHOTS_MCP_PROFILE (scratch profile, wiped; must end in /profile).
 * Never touches the real profile. Hosts, names and data are synthetic.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const PROFILE = resolve(
  process.env.VORTAQ_SHOTS_MCP_PROFILE ||
    join(process.env.TMPDIR || '/tmp', 'vortaq-mcp-shots', 'profile')
)
if (basename(PROFILE) !== 'profile') {
  console.error(
    `Refusing to wipe ${PROFILE}: the scratch profile directory must be named "profile".`
  )
  process.exit(1)
}
const FILES = join(dirname(PROFILE), 'files')
rmSync(PROFILE, { recursive: true, force: true })
rmSync(FILES, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })
mkdirSync(FILES, { recursive: true })

const TIENDA = join(FILES, 'tienda.db')
const db = new DatabaseSync(TIENDA)
db.exec(`
  CREATE TABLE clientes (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL);
  INSERT INTO clientes (nombre) VALUES ('Cliente de ejemplo');
`)
db.close()

const iso = new Date().toISOString()
const base = {
  color: null,
  host: '127.0.0.1',
  port: 3306,
  username: 'demo',
  authMode: 'password',
  savePassword: false,
  customDatabases: [],
  initialQueries: '',
  ssh: {
    enabled: false,
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    savePassword: false
  },
  ssl: { enabled: false, verifyServer: true },
  backupDir: '',
  extraBackupDirs: [],
  createdAt: iso,
  updatedAt: iso,
  engine: 'mysql'
}
const connections = [
  {
    ...base,
    id: 'shot-mcp-local',
    name: 'Local MySQL',
    color: '#69f0ae',
    environment: 'local',
    mcp: { enabled: true, access: 'read' }
  },
  {
    ...base,
    id: 'shot-mcp-tienda',
    name: 'Tienda (SQLite)',
    environment: 'local',
    engine: 'sqlite',
    host: '',
    port: 0,
    username: '',
    authMode: 'none',
    sqlite: {
      filePath: TIENDA,
      readOnly: false,
      foreignKeys: true,
      attached: [],
      busyTimeoutMs: 5000
    },
    mcp: { enabled: true, access: 'write' }
  },
  {
    ...base,
    id: 'shot-mcp-staging',
    name: 'Staging PostgreSQL',
    color: '#ffc107',
    environment: 'staging',
    engine: 'postgresql',
    host: 'db.staging.example',
    port: 5432,
    username: 'lectura',
    postgres: {
      initialDatabase: 'ventas',
      searchPath: '',
      showSystemSchemas: false,
      timeZone: '',
      applicationName: 'Vortaq'
    },
    network: { connectTimeoutMs: 10000, keepAliveSec: 60 },
    mcp: { enabled: true, access: 'structure' }
  },
  {
    ...base,
    id: 'shot-mcp-prod',
    name: 'Producción ventas',
    color: '#ff5252',
    environment: 'production',
    host: 'db.ventas.example',
    mcp: { enabled: true, access: 'read' }
  },
  {
    ...base,
    id: 'shot-mcp-analitica',
    name: 'Analítica',
    color: '#bf5af2',
    environment: 'other',
    host: 'analitica.example'
  }
]

const write = (name, data) =>
  writeFileSync(join(PROFILE, name), JSON.stringify(data, null, 2), { mode: 0o600 })
write('connections.json', { version: 1, items: connections })
write('credentials.json', { version: 1, codec: 'plain', items: {} })
write('settings.json', { theme: 'dark', checkUpdatesOnStartup: false, mcpEnabled: true })
console.log(`Seeded ${PROFILE}`)
