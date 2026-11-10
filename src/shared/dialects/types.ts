/**
 * SQL dialect contract (docs/multi-engine-design.md, section 6). Pure types: a
 * dialect module must not use Node or DOM APIs, because main (splitting, the
 * production guard) and the renderer (guard dialog, designer quoting) import
 * the same module.
 *
 * P1a only declares the members that wrap existing MySQL code. The rest of the
 * section 6 interface (tokenize, placeholder, literal, selectPage, explainError,
 * isPrivilegeError, keywords, formatterLanguage, systemSchemas,
 * identCaseSensitive) is added together with its first consumer, so no member
 * exists that nothing calls.
 */

export type SqlDialectId = 'mysql' | 'mariadb' | 'postgresql' | 'sqlite' | 'sqlserver'

/**
 * Lexical rules of a dialect. Descriptive data for the shared lexer that new
 * dialects use; the MySQL functions keep their own tokenisers and do not read
 * it (design D6).
 */
export interface LexRules {
  /** mysql: ['`'] ('"' only with ANSI_QUOTES, which is ignored); pg: ['"']; sqlite: ['"', '[', '`']; sqlserver: ['[', '"'] */
  identQuotes: ('`' | '"' | '[')[]
  /** mysql: ["'", '"']; pg/sqlite: ["'"] */
  stringQuotes: ("'" | '"')[]
  /** mysql true; pg only inside E'..'; sqlite false */
  backslashEscapes: boolean | 'E-prefix'
  /** mysql true; pg/sqlite false ('#' is an operator in PG) */
  hashComment: boolean
  /** mysql true: '--' starts a comment only when followed by whitespace or the end */
  dashCommentNeedsSpace: boolean
  /** pg true */
  nestedBlockComments: boolean
  /** mysql ['/*!', '/*+'], mariadb adds '/*M!' */
  executableComments: ('/*!' | '/*M!' | '/*+')[]
  /** pg $tag$...$tag$ */
  dollarQuotes: boolean
  /** mysql/mariadb client-side DELIMITER command */
  delimiterCommand: boolean
  /** sqlite keeps CREATE TRIGGER ... BEGIN ...; END as one statement */
  blockBodies: 'none' | 'trigger-begin-end'
}

/** One statement of a script, as split by `SqlDialect.splitStatements`. */
export interface SqlStatement {
  sql: string
  /** 1-based line of the first code character of the statement. */
  startLine: number
  /** SQL Server: `GO n` runs this batch n times (absent = once). */
  repeat?: number
}

/** Result of the renderer-side production guard (`SqlDialect.analyzeWrites`). */
export interface WriteCheck {
  writes: boolean
  /** Short labels such as "DELETE sin WHERE" or "CALL" for the confirmation message. */
  reasons: string[]
}

/** A statement that deletes or drops something (renderer «confirmar antes de borrar»). */
export interface DestructiveStatementInfo {
  /** Statement as written, leading comments removed. */
  sql: string
  /** Short tag such as "DROP TABLE", "TRUNCATE TABLE" or "DELETE sin WHERE". */
  reason: string
  /** DELETE / UPDATE without WHERE: every row is affected. */
  allRows: boolean
}

export interface SqlDialect {
  id: SqlDialectId
  lex: LexRules
  /** Splits a script the way the engine's own CLI does (MySQL: DELIMITER, `/*!`). */
  splitStatements(script: string): SqlStatement[]
  quoteIdent(name: string): string
  quoteString(value: string): string
  /** `schema.name` with both parts quoted; only `name` when there is no schema. */
  qualified(schema: string | null | undefined, name: string): string
  /**
   * Main: small denylist; true only for a statement that surely writes
   * (section 10). For every dialect `isObviousWrite(s)` implies
   * `analyzeWrites(s).writes`.
   */
  isObviousWrite(statement: string): boolean
  /** Renderer: allowlist; anything not provably read-only is a write, with Spanish reasons. */
  analyzeWrites(script: string): WriteCheck
  /**
   * Destructive statements of a script (DROP, TRUNCATE, DELETE, UPDATE without
   * WHERE, ALTER TABLE … DROP). Optional: the MySQL renderer keeps its own
   * destructiveGuard module.
   */
  analyzeDestructive?(script: string): DestructiveStatementInfo[]
  /** Spanish explanation of a server error code (PostgreSQL SQLSTATE), or null. */
  explainError?(code: string): string | null
  /** The error code means "not enough privileges". */
  isPrivilegeError?(code: string): boolean
}
