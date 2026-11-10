import type { AiChatRequest, AiMessage } from '@shared/ai'

/**
 * Frozen system instructions (identical for every request and mode, so the
 * provider's prompt cache can reuse them). Mode-specific instructions travel
 * in the user message.
 */
export const SYSTEM_INSTRUCTIONS = `You are the database assistant built into Vortaq, a desktop database client (MySQL, MariaDB, PostgreSQL, SQLite, SQL Server and MongoDB). You help one user understand and query their own databases. The context names the engine and version of the connection (for example "(PostgreSQL 17.2)" or "(SQLite 3.53.4)"): everything you write must be valid for that engine.

What you receive:
- The structure of the selected database, or of every database of the connection (on PostgreSQL and SQL Server: every schema of the current database; on SQLite: main and its attached databases): tables, columns, types, keys, indexes, foreign keys, views, routine signatures, rough row-count estimates, and the user's own notes about it. When several are included, tables are written as database.table (schema.table on PostgreSQL, database.collection on MongoDB): use that qualified form in queries that cross them.
- You never receive row values or query results; do not ask for them and do not guess real data. If the answer depends on data, give the SQL the user can run.
- When you need the columns of a table that is listed by name only, call the get_table_structure tool. It returns structure only.

How to answer:
- Answer in the user's language (usually Spanish), concisely and directly.
- Write SQL in the dialect of the connection's engine (MySQL, MariaDB, PostgreSQL, SQLite or SQL Server T-SQL: TOP or OFFSET … FETCH instead of LIMIT, [brackets] for odd names, GO only between batches), in fenced code blocks marked \`\`\`sql; on MongoDB write shell commands (db.<collection>.<method>(...)) in \`\`\`javascript blocks. Use only tables and columns that exist in the structure; if something is missing or ambiguous, say so instead of inventing names.
- Prefer safe, read-only queries. If the user asks for something that modifies data or structure (UPDATE, DELETE, DROP, ALTER…), warn about the effect, include a WHERE clause where it applies, and suggest checking it first with a SELECT. You never run SQL yourself: the user reviews and runs it.
- Use the user's notes (business rules, meaning of status values, conventions) when they are relevant.`

/** SQL dialect named in the «generate SQL» task, per connection engine (default MySQL). */
const SQL_ENGINE_LABEL: Record<string, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
  sqlserver: 'SQL Server (T-SQL)'
}

/** Instruction prepended to the user message for each mode (MongoDB: shell commands, not SQL). */
export function modeInstruction(request: AiChatRequest, engine?: string): string {
  if (engine === 'mongodb') {
    switch (request.mode) {
      case 'generateSql':
        return 'Task: write ONE MongoDB shell command (db.<collection>.<method>(...), or a few of them) that does what the user asks. Reply with it in a single ```javascript code block followed by at most two short sentences. It will be inserted into the editor without running it.'
      case 'explain':
        return 'Task: explain what these MongoDB shell commands do, step by step, and suggest concrete optimisations (indexes that exist or are missing, pipeline order, pitfalls). Show improved commands in ```javascript blocks when you propose changes.'
      case 'explainError':
        return 'Task: the command below failed on the server. Explain the cause in plain words and give a corrected command in a ```javascript block when possible.'
      default:
        return ''
    }
  }
  switch (request.mode) {
    case 'generateSql':
      return `Task: write ONE ${SQL_ENGINE_LABEL[engine ?? ''] ?? 'MySQL'} statement (or a short script if it is really needed) that does what the user asks. Reply with the SQL in a single \`\`\`sql code block followed by at most two short sentences. The SQL will be inserted into the editor without running it.`
    case 'explain':
      return 'Task: explain what this SQL does, step by step, and suggest concrete optimisations (indexes that exist or are missing, rewrites, pitfalls). If an EXPLAIN plan is attached, use it. Show improved SQL in ```sql blocks when you propose changes.'
    case 'explainError':
      return 'Task: the statement below failed on the server. Explain the cause of the error in plain words and give a corrected statement in a ```sql block when possible.'
    default:
      return ''
  }
}

/**
 * Text of the new user turn: mode instruction, the SQL / error / EXPLAIN plan
 * involved and the user's question. This is volatile content (it goes after
 * the cached system blocks).
 */
export function buildUserMessage(
  request: AiChatRequest,
  explainPlan: string | null,
  engine?: string
): string {
  const parts: string[] = []
  const instruction = modeInstruction(request, engine)
  const fence = (sql: string): string =>
    (engine === 'mongodb' ? '```javascript\n' : '```sql\n') + sql.trim() + '\n```'
  if (instruction) parts.push(instruction)
  if (request.mode === 'generateSql' && request.editorSql?.trim())
    parts.push(`SQL that is currently in the editor (for reference):\n${fence(request.editorSql)}`)
  if ((request.mode === 'explain' || request.mode === 'explainError') && request.sql?.trim())
    parts.push(`SQL:\n${fence(request.sql)}`)
  if (request.mode === 'explainError' && request.error?.trim())
    parts.push(`Server error:\n${request.error.trim()}`)
  if (explainPlan) parts.push(`EXPLAIN plan (from the server, metadata only):\n${explainPlan}`)
  const input = request.input.trim()
  if (input) parts.push(parts.length ? `User request:\n${input}` : input)
  return parts.join('\n\n')
}

/** Max earlier messages / characters of history sent with a question. */
export const HISTORY_MAX_MESSAGES = 20
export const HISTORY_MAX_CHARS = 40_000

/**
 * Earlier turns to send: the most recent ones within the limits, starting with
 * a user turn, alternating roles (empty and failed answers dropped).
 */
export function trimHistory(history: AiMessage[]): AiMessage[] {
  const clean = history.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim()
  )
  const picked: AiMessage[] = []
  let chars = 0
  for (let i = clean.length - 1; i >= 0 && picked.length < HISTORY_MAX_MESSAGES; i--) {
    const m = clean[i]
    if (chars + m.text.length > HISTORY_MAX_CHARS) break
    picked.unshift({ role: m.role, text: m.text })
    chars += m.text.length
  }
  // Merge consecutive same-role turns and make the first one a user turn.
  const merged: AiMessage[] = []
  for (const m of picked) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) last.text += `\n\n${m.text}`
    else merged.push({ ...m })
  }
  while (merged.length && merged[0].role !== 'user') merged.shift()
  // The new user turn follows: history must end with an assistant turn.
  while (merged.length && merged[merged.length - 1].role !== 'assistant') merged.pop()
  return merged
}
