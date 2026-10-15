/* global process, console, setTimeout, clearTimeout */
/**
 * End-to-end check of `Vortaq --mcp` on the built app (`npm run build` first):
 *
 *   npm run test:mcp-e2e      (node scripts/mcp-e2e.mjs)
 *
 * Never touches the real profile: a scratch folder holds the profile
 * (VORTAQ_USER_DATA, settings.json and connections.json written here,
 * VORTAQ_PLAIN_SECRETS=1) and a SQLite file. Then:
 *  1. the SDK's stdio client starts `electron . --mcp` with the minimal
 *     environment MCP clients use: initialize, tools/list, list_connections
 *     (the disabled connection is hidden), describe_table, run_query, a refused
 *     write; any stdout line that is not JSON-RPC fails the run;
 *  2. a raw spawn checks every stdout byte is JSON-RPC and that the process
 *     exits by itself (code 0) once stdin closes;
 *  3. the profile files are unchanged and logs/mcp.log has one activity line
 *     per call, without SQL text;
 *  4. with --with-app, the desktop app runs on the same profile meanwhile and a
 *     level saved during the session applies on the next call.
 * Exit code 0 when everything passed.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
/** The electron package's main export is the path of its binary when required from Node. */
const ELECTRON = require('electron')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, ...(ok ? {} : { detail }) })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
}

function connection(id, name, file, environment, mcp) {
  const now = new Date().toISOString()
  return {
    id,
    name,
    color: null,
    environment,
    host: '',
    port: 0,
    username: '',
    authMode: 'none',
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
    ssl: { enabled: false, verifyServer: false },
    backupDir: '',
    extraBackupDirs: [],
    createdAt: now,
    updatedAt: now,
    engine: 'sqlite',
    sqlite: {
      filePath: file,
      readOnly: false,
      foreignKeys: true,
      busyTimeoutMs: 5000,
      attached: []
    },
    ...(mcp ? { mcp } : {})
  }
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function seed(dir) {
  const profile = join(dir, 'profile')
  mkdirSync(profile, { recursive: true })
  const file = join(dir, 'e2e-tienda.db')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE clientes (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, alta TEXT);
    CREATE TABLE pedidos (id INTEGER PRIMARY KEY, cliente_id INTEGER REFERENCES clientes(id), total NUMERIC);
    INSERT INTO clientes VALUES (1, 'Ana', '2026-01-02'), (2, 'Luis', '2026-02-03');
    INSERT INTO pedidos VALUES (1, 1, 10.5), (2, 1, 20), (3, 2, 7.25);
  `)
  db.close()
  writeFileSync(
    join(profile, 'connections.json'),
    JSON.stringify(
      {
        version: 1,
        items: [
          connection('e2e-read', 'Tienda E2E', file, 'local', { enabled: true, access: 'read' }),
          connection('e2e-hidden', 'Oculta E2E', file, 'local', { enabled: false, access: 'write' })
        ]
      },
      null,
      2
    )
  )
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ mcpEnabled: true, theme: 'dark' }, null, 2)
  )
  writeFileSync(
    join(profile, 'credentials.json'),
    JSON.stringify({ version: 1, codec: 'plain', items: {} })
  )
  return { profile, file }
}

const serverEnv = (profile) => ({
  VORTAQ_USER_DATA: profile,
  VORTAQ_PLAIN_SECRETS: '1',
  // No stale variables of a surrounding Electron run.
  ELECTRON_RUN_AS_NODE: ''
})

async function sdkSession(profile) {
  const stdoutProblems = []
  const transport = new StdioClientTransport({
    command: ELECTRON,
    args: [ROOT, '--mcp'],
    env: serverEnv(profile),
    stderr: 'pipe',
    cwd: ROOT
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => (stderr += chunk.toString()))
  transport.onerror = (err) => stdoutProblems.push(String(err?.message ?? err))
  const client = new Client({ name: 'vortaq-e2e', version: '1.0.0' })
  const started = Date.now()
  await client.connect(transport)
  check(
    'initialize answered',
    client.getServerVersion()?.name === 'vortaq',
    JSON.stringify(client.getServerVersion())
  )
  check('initialize carries instructions', /list_connections/.test(client.getInstructions() ?? ''))
  console.log(`     (ready in ${Date.now() - started} ms)`)
  const { tools } = await client.listTools()
  check(
    'tools/list has the seven tools',
    tools.length === 7 &&
      tools.some((t) => t.name === 'run_query' && t.annotations?.readOnlyHint === true),
    tools.map((t) => t.name).join(',')
  )
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    const text = r.content?.[0]?.text ?? ''
    return { error: r.isError === true, text, data: r.isError ? null : JSON.parse(text) }
  }
  const list = await call('list_connections')
  const names = list.data?.connections?.map((c) => c.name) ?? []
  check(
    'list_connections hides the disabled connection',
    names.length === 1 && names[0] === 'Tienda E2E',
    list.text
  )
  check(
    'list_connections shows no file path',
    !list.text.includes('.db') && !list.text.includes(profile)
  )
  const described = await call('describe_table', { connection: 'Tienda E2E', table: 'pedidos' })
  check(
    'describe_table gives columns and the foreign key',
    described.data?.columns?.length === 3 &&
      described.data.foreign_keys?.[0]?.references?.table === 'clientes',
    described.text
  )
  const query = await call('run_query', {
    connection: 'Tienda E2E',
    sql: 'SELECT c.nombre, SUM(p.total) AS total FROM pedidos p JOIN clientes c ON c.id = p.cliente_id GROUP BY c.nombre ORDER BY c.nombre'
  })
  check(
    'run_query returns the rows',
    JSON.stringify(query.data?.rows) ===
      JSON.stringify([
        ['Ana', 30.5],
        ['Luis', 7.25]
      ]),
    query.text
  )
  const write = await call('run_query', { connection: 'Tienda E2E', sql: 'DELETE FROM pedidos' })
  check('run_query refuses a write', write.error && /run_query/.test(write.text), write.text)
  const hidden = await call('run_query', { connection: 'Oculta E2E', sql: 'SELECT 1' })
  check(
    'the disabled connection does not exist',
    hidden.error && /No hay ninguna conexión/.test(hidden.text),
    hidden.text
  )
  const exec = await call('execute_sql', { connection: 'Tienda E2E', sql: 'DELETE FROM pedidos' })
  check(
    'execute_sql is refused at the read level',
    exec.error && /Lectura y escritura/.test(exec.text),
    exec.text
  )
  const pid = transport.pid
  await client.close()
  check(
    'stdout carried only JSON-RPC (SDK client)',
    stdoutProblems.length === 0,
    stdoutProblems.join(' | ')
  )
  return { pid, stderr }
}

/** Raw process: every stdout line must be a JSON-RPC 2.0 message; stdin closing ends it. */
function rawSession(profile) {
  return new Promise((resolvePromise) => {
    const child = spawn(ELECTRON, [ROOT, '--mcp'], {
      cwd: ROOT,
      env: { ...process.env, ...serverEnv(profile) },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    let closedAt = 0
    const answered = new Set()
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8')
      for (const line of out.split('\n').slice(0, -1)) {
        try {
          const msg = JSON.parse(line)
          if (msg.id !== undefined) answered.add(msg.id)
        } catch {
          /* checked below */
        }
      }
      if (answered.has(2) && !closedAt) {
        closedAt = Date.now()
        child.stdin.end()
      }
    })
    child.stderr.on('data', (chunk) => (err += chunk.toString('utf8')))
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`)
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1' }
      }
    })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_connections', arguments: {} }
    })
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('exit', (code, signal) => {
      clearTimeout(killer)
      resolvePromise({ code, signal, out, err, exitMs: closedAt ? Date.now() - closedAt : null })
    })
  })
}

/**
 * `--with-app`: the desktop app runs on the same profile (it opens a window)
 * while an agent uses `--mcp`; a level saved meanwhile applies on the next call.
 */
async function withDesktopApp(profile) {
  const desktop = spawn(ELECTRON, [ROOT], {
    cwd: ROOT,
    env: {
      ...process.env,
      VORTAQ_USER_DATA: profile,
      VORTAQ_PLAIN_SECRETS: '1',
      ELECTRON_RUN_AS_NODE: ''
    },
    stdio: 'ignore'
  })
  await new Promise((r) => setTimeout(r, 5000))
  check('the desktop app is running on the profile', desktop.exitCode === null)
  const transport = new StdioClientTransport({
    command: ELECTRON,
    args: [ROOT, '--mcp'],
    env: serverEnv(profile),
    stderr: 'pipe',
    cwd: ROOT
  })
  const client = new Client({ name: 'vortaq-e2e-with-app', version: '1.0.0' })
  try {
    await client.connect(transport)
    const first = await client.callTool({
      name: 'run_query',
      arguments: { connection: 'Tienda E2E', sql: 'SELECT COUNT(*) AS n FROM clientes' }
    })
    check(
      'run_query works while the desktop app is open',
      !first.isError && JSON.parse(first.content[0].text).rows?.[0]?.[0] === 2,
      first.content?.[0]?.text
    )
    // The app saves «Solo estructura» for the connection (atomic replace, like JsonStore).
    const file = join(profile, 'connections.json')
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    doc.items[0].mcp = { enabled: true, access: 'structure' }
    doc.items[0].updatedAt = new Date().toISOString()
    writeFileSync(`${file}.e2e.tmp`, JSON.stringify(doc, null, 2))
    renameSync(`${file}.e2e.tmp`, file)
    const second = await client.callTool({
      name: 'run_query',
      arguments: { connection: 'Tienda E2E', sql: 'SELECT 1' }
    })
    check(
      'a level saved while running applies on the next call',
      second.isError === true && /Solo estructura/.test(second.content?.[0]?.text ?? ''),
      second.content?.[0]?.text
    )
  } finally {
    await client.close().catch(() => undefined)
    check('the desktop app kept running', desktop.exitCode === null)
    desktop.kill('SIGTERM')
    await new Promise((r) => desktop.once('exit', r))
  }
}

async function main() {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) {
    console.error('Run `npm run build` first (out/main/index.js is missing).')
    process.exit(2)
  }
  const dir = mkdtempSync(join(tmpdir(), 'vortaq-mcp-e2e-'))
  try {
    const { profile, file } = seed(dir)
    const before = {
      connections: sha(join(profile, 'connections.json')),
      settings: sha(join(profile, 'settings.json')),
      db: sha(file)
    }
    const sdk = await sdkSession(profile)
    if (results.some((r) => !r.ok)) console.log(`--- stderr ---\n${sdk.stderr.slice(-3000)}`)

    const raw = await rawSession(profile)
    const lines = raw.out.split('\n').filter((l) => l.length > 0)
    const bad = lines.filter((l) => {
      try {
        return JSON.parse(l).jsonrpc !== '2.0'
      } catch {
        return true
      }
    })
    check(
      'raw stdout: only JSON-RPC lines',
      lines.length >= 2 && bad.length === 0,
      `${bad.length} bad of ${lines.length}: ${bad.slice(0, 2).join(' | ')}`
    )
    check(
      'exits by itself when stdin closes (code 0)',
      raw.code === 0 && raw.signal === null && raw.exitMs !== null && raw.exitMs < 10_000,
      `code=${raw.code} signal=${raw.signal} after=${raw.exitMs} ms\n${raw.err.slice(-2000)}`
    )
    if (raw.exitMs !== null) console.log(`     (exited ${raw.exitMs} ms after stdin closed)`)

    check(
      'connections.json unchanged',
      sha(join(profile, 'connections.json')) === before.connections
    )
    check('settings.json unchanged', sha(join(profile, 'settings.json')) === before.settings)
    check('SQLite file unchanged', sha(file) === before.db)
    const logFile = join(profile, 'logs', 'mcp.log')
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    const activity = log.split('\n').filter((l) => / \[mcp\] tool=/.test(l))
    check(
      'logs/mcp.log has one line per tool call',
      activity.length === 7,
      `${activity.length} lines`
    )
    check('the log has no SQL text or values', !/SELECT|DELETE|Ana|Luis/.test(log))
    check('stderr carries no SQL text', !/SELECT|DELETE FROM/.test(sdk.stderr + raw.err))
    check(
      "Chromium's own data stayed out of the profile",
      !existsSync(join(profile, 'Local Storage')) && !existsSync(join(profile, 'Local State'))
    )
    if (process.argv.includes('--with-app')) await withDesktopApp(profile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(
    `[mcp-e2e] ${JSON.stringify({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length })}`
  )
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('[mcp-e2e] aborted:', err)
  process.exit(1)
})
