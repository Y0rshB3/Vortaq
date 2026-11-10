/* global process, console, URL, Buffer */
/**
 * Seeds a scratch profile plus the throwaway SQL Server 2022 test server for
 * the SQL Server screenshots (steps 54* of src/main/screenshots.ts):
 *
 *   node scripts/seed-sqlserver-shots.mjs
 *   npm run build
 *   VORTAQ_USER_DATA=$TMPDIR/vortaq-mssql-shots/profile VORTAQ_PLAIN_SECRETS=1 \
 *   VORTAQ_AI_FIXTURE=1 VORTAQ_SCREENSHOTS=$TMPDIR/vortaq-mssql-shots VORTAQ_SHOTS_ONLY=54 npx electron .
 *
 * Env: VORTAQ_SHOTS_MSSQL_PROFILE (scratch profile, wiped; must end in /profile),
 * VORTAQ_TEST_MSSQL_URL (default: the compose container `mssql22` on 51433).
 * Never touches port 1433 (a real server may live there) and never the real profile.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { Connection, Request } from 'tedious'

const env = (name) => process.env[`VORTAQ_${name}`] ?? process.env[`ELECTRONDB_${name}`]
const PROFILE = resolve(
  env('SHOTS_MSSQL_PROFILE') || join(process.env.TMPDIR || '/tmp', 'vortaq-mssql-shots', 'profile')
)
const URL_ = new URL(
  env('TEST_MSSQL_URL') || 'mssql://sa:Navidog_2026@127.0.0.1:51433/navidog_test'
)
if (Number(URL_.port || 1433) === 1433) {
  console.error('Refusing to seed a server on port 1433: use the throwaway test container.')
  process.exit(1)
}
if (basename(PROFILE) !== 'profile') {
  console.error(
    `Refusing to wipe ${PROFILE}: the scratch profile directory must be named "profile".`
  )
  process.exit(1)
}

const connect = () =>
  new Promise((resolveConnection, reject) => {
    const c = new Connection({
      server: URL_.hostname,
      authentication: {
        type: 'default',
        options: {
          userName: decodeURIComponent(URL_.username),
          password: decodeURIComponent(URL_.password)
        }
      },
      options: { port: Number(URL_.port), encrypt: true, trustServerCertificate: true }
    })
    c.connect((err) => (err ? reject(err) : resolveConnection(c)))
  })
const run = (c, sql) =>
  new Promise((resolveRun, reject) => {
    c.execSqlBatch(new Request(sql, (err) => (err ? reject(err) : resolveRun())))
  })

const conn = await connect()
await run(
  conn,
  "IF DB_ID(N'tienda') IS NOT NULL BEGIN ALTER DATABASE tienda SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE tienda END"
)
await run(conn, 'CREATE DATABASE tienda')
await run(conn, 'USE tienda')
await run(
  conn,
  `CREATE TABLE dbo.clientes (
     id int IDENTITY(1,1) CONSTRAINT PK_clientes PRIMARY KEY,
     nombre nvarchar(80) NOT NULL,
     email varchar(120) NULL CONSTRAINT UQ_clientes_email UNIQUE,
     pais nvarchar(40) NOT NULL CONSTRAINT DF_clientes_pais DEFAULT (N'España'),
     saldo decimal(12,2) NOT NULL CONSTRAINT DF_clientes_saldo DEFAULT (0),
     alta datetime2(3) NOT NULL CONSTRAINT DF_clientes_alta DEFAULT (SYSDATETIME()),
     activo bit NOT NULL CONSTRAINT DF_clientes_activo DEFAULT (1)
   );
   CREATE TABLE dbo.pedidos (
     id int IDENTITY(1,1) CONSTRAINT PK_pedidos PRIMARY KEY,
     cliente_id int NOT NULL CONSTRAINT FK_pedidos_clientes REFERENCES dbo.clientes (id),
     estado varchar(12) NOT NULL CONSTRAINT DF_pedidos_estado DEFAULT ('pendiente'),
     total money NOT NULL,
     creado date NOT NULL CONSTRAINT DF_pedidos_creado DEFAULT (CAST(GETDATE() AS date))
   );
   CREATE INDEX IX_pedidos_cliente ON dbo.pedidos (cliente_id) INCLUDE (total);
   INSERT dbo.clientes (nombre, email, pais, saldo, alta) VALUES
     (N'Ana Torres', 'ana@example.test', N'España', 120.50, '2026-09-01T10:15:00'),
     (N'Bruno Díaz', 'bruno@example.test', N'México', 0, '2026-09-03T08:40:00'),
     (N'Carla Méndez', 'carla@example.test', N'Colombia', 35.10, '2026-09-10T17:05:00'),
     (N'Diego Ruiz', 'diego@example.test', N'España', 980.00, '2026-09-18T12:00:00'),
     (N'Elena Sanz', NULL, N'Argentina', 15.30, '2026-10-02T09:30:00');
   INSERT dbo.pedidos (cliente_id, estado, total, creado) VALUES
     (1, 'pagado', 120.50, '2026-09-02'), (1, 'pendiente', 42.00, '2026-10-01'),
     (2, 'pagado', 19.99, '2026-09-04'), (3, 'cancelado', 75.00, '2026-09-11'),
     (4, 'pagado', 980.00, '2026-09-20'), (5, 'pendiente', 15.30, '2026-10-03');
   EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Clientes de la tienda',
     @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'clientes';
   CREATE SEQUENCE dbo.facturas AS bigint START WITH 1000 INCREMENT BY 1;`
)
await run(
  conn,
  `CREATE VIEW dbo.v_pendientes AS
     SELECT p.id, c.nombre, p.total FROM dbo.pedidos p JOIN dbo.clientes c ON c.id = p.cliente_id
      WHERE p.estado = 'pendiente'`
)
await run(
  conn,
  `CREATE PROCEDURE dbo.total_cliente @cliente int AS
   BEGIN
     SET NOCOUNT ON;
     SELECT COALESCE(SUM(total), 0) AS total FROM dbo.pedidos WHERE cliente_id = @cliente;
   END`
)
await run(conn, 'CREATE SCHEMA ventas')
await run(
  conn,
  "CREATE TABLE ventas.zonas (codigo char(3) PRIMARY KEY, nombre nvarchar(40) NOT NULL); INSERT ventas.zonas VALUES ('NOR', N'Norte'), ('SUR', N'Sur')"
)
conn.close()

/* ---------- profile ---------- */

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })
const iso = new Date().toISOString()
const connections = [
  {
    id: 'shot-ms',
    name: 'SQL Server Local',
    color: '#a78bfa',
    environment: 'local',
    engine: 'sqlserver',
    host: URL_.hostname,
    port: Number(URL_.port),
    username: decodeURIComponent(URL_.username),
    authMode: 'password',
    savePassword: true,
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
    ssl: { enabled: true, verifyServer: false },
    backupDir: join(PROFILE, 'backups'),
    extraBackupDirs: [],
    network: { connectTimeoutMs: 15000, keepAliveSec: 60 },
    sqlserver: {
      initialDatabase: 'tienda',
      auth: 'sql',
      domain: '',
      instanceName: '',
      encrypt: 'mandatory',
      trustServerCertificate: true,
      hostNameInCertificate: '',
      tenantId: '',
      clientId: '',
      showSystemObjects: false,
      readOnlyIntent: false
    },
    createdAt: iso,
    updatedAt: iso
  }
]
const b64 = (value) => Buffer.from(value, 'utf8').toString('base64')
const write = (name, data) =>
  writeFileSync(join(PROFILE, name), JSON.stringify(data, null, 2), { mode: 0o600 })
write('connections.json', { version: 1, items: connections })
write('credentials.json', {
  version: 1,
  codec: 'plain',
  items: {
    'mysql:shot-ms': b64(decodeURIComponent(URL_.password)),
    // Fake key for the AI screens (answered by VORTAQ_AI_FIXTURE, never sent anywhere).
    'ai:shot-ai-claude': b64('sk-ant-fixture-not-a-real-key')
  }
})
write('settings.json', {
  theme: 'dark',
  checkUpdatesOnStartup: false,
  aiEnabled: true,
  aiDefaultProviderId: 'shot-ai-claude'
})
write('ai-providers.json', {
  version: 1,
  items: [
    {
      id: 'shot-ai-claude',
      name: 'Claude',
      type: 'anthropic',
      baseUrl: '',
      model: 'claude-opus-5-5',
      createdAt: iso,
      updatedAt: iso
    }
  ]
})
console.log(`Seeded SQL Server database «tienda» and the profile at ${PROFILE}`)
