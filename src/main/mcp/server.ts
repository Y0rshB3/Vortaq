/**
 * Vortaq's MCP server (stdio only; no HTTP or SSE transport): the tool
 * definitions an agent sees, the checks every call goes through and the
 * activity log. Electron-free; `Vortaq --mcp` (src/main/mcpMain.ts) connects it
 * to stdin/stdout, the tests to the SDK's in-memory transport.
 *
 * Every call: the profile must be ready and the global switch on; the named
 * connection must be available to agents; its level must allow the tool
 * (write is never effective on guarded environments). Error messages are
 * redacted (host, port, user, SSH, file paths, URIs, IPs, secrets). The
 * activity log gets one line per call and never SQL text, values or secrets.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { MCP_LIMITS } from './values'
import { getLogger } from '../log'
import { McpToolError, requireLevel, type McpOutcome, type McpToolName } from './access'
import { redactGeneric } from './redact'
import type { McpRuntime, ResolvedConnection } from './runtime'
import {
  describeTable,
  executeSql,
  explainQuery,
  listConnections,
  listDatabases,
  listTables,
  runQuery,
  type ToolOutput
} from './tools'

export interface McpActivity {
  tool: McpToolName
  /** Connection name ('-' for list_connections or an unknown connection). */
  connection: string
  /** Effective level of the connection ('-' when none). */
  access: string
  outcome: McpOutcome
  durationMs: number
  rows: number | null
}

export interface McpServerOptions {
  version: string
  /** Activity sink (default: one line in the process log, logs/mcp.log). */
  onActivity?: (entry: McpActivity) => void
}

const activityLog = getLogger('mcp')

/** One activity line: never SQL text, values or secrets. */
export function activityLine(e: McpActivity): string {
  return `tool=${e.tool} connection=${JSON.stringify(e.connection)} access=${e.access} outcome=${e.outcome} ms=${e.durationMs} rows=${e.rows ?? '-'}`
}

export const MCP_INSTRUCTIONS = `Vortaq exposes the database connections its user saved in the Vortaq desktop app and explicitly made available to agents. You never see passwords, hosts, ports, users, SSH settings, connection strings or file paths: refer to a connection by the id or name that list_connections returns.

Each connection has a level chosen by the user:
- structure: list_databases, list_tables and describe_table only (no row values).
- read: also run_query (exactly one read-only statement, run in a new read-only session) and explain_query (plan only, never ANALYZE).
- write: also execute_sql (scripts, writes and DDL, autocommit). Never available on production connections or other environments where Vortaq asks the user to type the connection name: those stay read-only.

Start with list_connections, then list_databases / list_tables / describe_table before writing queries. Limits: max_rows defaults to ${MCP_LIMITS.defaultRows} (at most ${MCP_LIMITS.maxRows}) and "truncated": true means there are more rows; timeout_seconds defaults to ${MCP_LIMITS.defaultTimeoutSec} (at most ${MCP_LIMITS.maxTimeoutSec}) and a query that exceeds it is cancelled on the server; long texts are cut at ${MCP_LIMITS.maxCellChars} characters and a response at about ${Math.round(MCP_LIMITS.maxResponseChars / 1000)} KB. Values are JSON: big integers and decimals as strings, binary data as {"type":"binary","hex":…}, MongoDB documents as canonical Extended JSON. MongoDB connections use mongo shell syntax (db.collection.find({...}), aggregate([...]), countDocuments, distinct…; no variables, functions or loops) in the "sql" argument. Error messages are in Spanish; when a tool refuses, its message says what the user can change in Vortaq.`

const connection = z
  .string()
  .min(1)
  .describe('Connection id or exact name, as returned by list_connections.')
const database = z
  .string()
  .optional()
  .describe(
    'MySQL/MariaDB/MongoDB database, PostgreSQL database (default: the connection\'s initial database) or SQLite attached alias (default "main").'
  )
const schema = z.string().optional().describe('PostgreSQL schema (other engines ignore it).')
const maxRows = z
  .number()
  .int()
  .min(1)
  .max(MCP_LIMITS.maxRows)
  .optional()
  .describe(
    `Rows (or documents) to return, default ${MCP_LIMITS.defaultRows}, at most ${MCP_LIMITS.maxRows}.`
  )
const timeoutSeconds = z
  .number()
  .positive()
  .max(MCP_LIMITS.maxTimeoutSec)
  .optional()
  .describe(
    `Seconds before the statement is cancelled on the server, default ${MCP_LIMITS.defaultTimeoutSec}, at most ${MCP_LIMITS.maxTimeoutSec}.`
  )

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
}

type Args = Record<string, unknown>

export function createMcpServer(rt: McpRuntime, options: McpServerOptions): McpServer {
  const server = new McpServer(
    { name: 'vortaq', title: 'Vortaq', version: options.version },
    { instructions: MCP_INSTRUCTIONS, capabilities: { tools: {} } }
  )
  const record = options.onActivity ?? ((e: McpActivity) => activityLog.info(activityLine(e)))

  /** The common path of every tool: checks, timing, redaction and the activity line. */
  async function call(
    tool: McpToolName,
    args: Args,
    run: (c: ResolvedConnection | null) => Promise<ToolOutput> | ToolOutput
  ): Promise<{ content: { type: 'text'; text: string }[] }> {
    const started = Date.now()
    let resolved: ResolvedConnection | null = null
    let outcome: McpOutcome = 'ok'
    let rows: number | null = null
    let end = (): void => undefined
    try {
      rt.assertAvailable()
      await rt.sweep()
      if (tool !== 'list_connections') {
        resolved = rt.resolve(args.connection)
        requireLevel(resolved.config, resolved.access, resolved.requested, tool)
        end = rt.begin(resolved.config.id)
        await rt.prepare(resolved.config)
      }
      const out = await run(resolved)
      rows = out.rows ?? null
      const data = resolved
        ? { connection: resolved.config.name, engine: resolved.config.engine, ...out.data }
        : out.data
      return { content: [{ type: 'text', text: JSON.stringify(data) }] }
    } catch (err) {
      outcome = err instanceof McpToolError ? err.outcome : 'error'
      const message = err instanceof Error ? err.message : String(err)
      const redact = resolved?.redact ?? redactGeneric
      // Thrown errors become `isError` results with this text (McpServer).
      throw new Error(redact(message))
    } finally {
      end()
      record({
        tool,
        connection: resolved?.config.name ?? '-',
        access: resolved?.access ?? '-',
        outcome,
        durationMs: Date.now() - started,
        rows
      })
    }
  }

  server.registerTool(
    'list_connections',
    {
      title: 'List connections',
      description:
        'Connections the user made available to agents in Vortaq: id, name, engine (mysql, mariadb, postgresql, sqlite, mongodb), environment (local, staging, production, other) and access level (structure, read or write). Connections that are not listed do not exist for you.',
      annotations: READ_ONLY
    },
    () => call('list_connections', {}, () => listConnections(rt))
  )

  server.registerTool(
    'list_databases',
    {
      title: 'List databases',
      description:
        'User databases of a connection (PostgreSQL: databases with their schemas; SQLite: "main" and attached aliases). System databases only with include_system.',
      inputSchema: {
        connection,
        include_system: z.boolean().optional().describe('Also list system databases/schemas.')
      },
      annotations: READ_ONLY
    },
    (args) => call('list_databases', args, (c) => listDatabases(rt, c!, args))
  )

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description:
        'Tables and views of a database (PostgreSQL: of one schema, or of every user schema when schema is omitted; MongoDB: collections and views).',
      inputSchema: { connection, database, schema },
      annotations: READ_ONLY
    },
    (args) => call('list_tables', args, (c) => listTables(rt, c!, args))
  )

  server.registerTool(
    'describe_table',
    {
      title: 'Describe table',
      description:
        'Structure of a table or view: columns (name, type, nullable, default, key), primary key, indexes and foreign keys. MongoDB: indexes, the structural part of the $jsonSchema validator and field paths with BSON types from a random sample (never values).',
      inputSchema: {
        connection,
        database,
        schema,
        table: z.string().min(1).describe('Table, view or collection name.')
      },
      annotations: READ_ONLY
    },
    (args) => call('describe_table', args, (c) => describeTable(rt, c!, args))
  )

  server.registerTool(
    'run_query',
    {
      title: 'Run a read-only query',
      description:
        'Runs exactly one read-only statement (SELECT, WITH, SHOW, EXPLAIN…) in a new read-only session and returns columns and rows. Statements that may write are refused, and the read-only session stops anything that slips through. MongoDB: mongo shell syntax, read commands only (find, aggregate without $out/$merge, countDocuments, distinct, getIndexes…). Needs the "read" level.',
      inputSchema: {
        connection,
        database,
        schema,
        sql: z
          .string()
          .min(1)
          .describe('One SQL statement, or a MongoDB shell script for MongoDB connections.'),
        max_rows: maxRows,
        timeout_seconds: timeoutSeconds
      },
      annotations: READ_ONLY
    },
    (args) => call('run_query', args, (c) => runQuery(rt, c!, args))
  )

  server.registerTool(
    'explain_query',
    {
      title: 'Explain a query',
      description:
        'Execution plan of one read-only SELECT (EXPLAIN without ANALYZE; SQLite: EXPLAIN QUERY PLAN). The statement itself is not run. Needs the "read" level. For MongoDB use run_query with .explain().',
      inputSchema: {
        connection,
        database,
        schema,
        sql: z.string().min(1).describe('One SELECT statement (without the EXPLAIN keyword).'),
        timeout_seconds: timeoutSeconds
      },
      annotations: READ_ONLY
    },
    (args) => call('explain_query', args, (c) => explainQuery(rt, c!, args))
  )

  server.registerTool(
    'execute_sql',
    {
      title: 'Execute SQL (writes)',
      description:
        'Runs a script (several statements allowed: INSERT, UPDATE, DELETE, DDL…) with autocommit, stopping at the first error; returns affected rows, messages and result sets limited like run_query. MongoDB: mongo shell write commands (insertOne, updateMany, createIndex…). Needs the "write" level, which is never available on production connections or environments that require typed confirmation in Vortaq.',
      inputSchema: {
        connection,
        database,
        schema,
        sql: z
          .string()
          .min(1)
          .describe('SQL script, or a MongoDB shell script for MongoDB connections.'),
        max_rows: maxRows,
        timeout_seconds: timeoutSeconds
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    (args) => call('execute_sql', args, (c) => executeSql(rt, c!, args))
  )

  return server
}
