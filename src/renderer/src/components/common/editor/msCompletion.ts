/*
 * SQL Server completion for the query editor (docs/sqlserver-design.md):
 * the PostgreSQL engine (pgCompletion.ts: relations after `schema.`, columns
 * after `alias.`, columns of the statement's tables) with T-SQL labels:
 * names are bracketed only when needed ([Order Details], [order]) and an
 * unqualified name resolves in the tab's schema, then dbo, like SQL Server's
 * default schema rule. Names match case-insensitively.
 */
import { MSSQL, SQLDialect } from '@codemirror/lang-sql'
import type { CompletionSource } from '@codemirror/autocomplete'
import { quoteIdent } from '@shared/dialects/sqlserver'
import { cachedPg, pgCompletionSource, type PgSchemaProvider } from './pgCompletion'

/** T-SQL dialect of the editor ([brackets], @variables, N'…' strings, T-SQL keywords). */
export const vortaqMSSQL = SQLDialect.define({ ...MSSQL.spec })

/** Label of a name: double-quoted when the user started with `"`, else bracketed when needed. */
export function msQuoteLabel(name: string, force: boolean): string {
  return force ? '"' + name.replace(/"/g, '""') + '"' : quoteIdent(name)
}

/** The tab's schema first, then dbo (SQL Server resolves unqualified names that way). */
export function msSearchPath(schema: string | null | undefined): string[] {
  const first = schema?.trim()
  return first && first.toLowerCase() !== 'dbo' ? [first, 'dbo'] : ['dbo']
}

export function msCompletionSource(provider: PgSchemaProvider): CompletionSource {
  return pgCompletionSource(provider, msQuoteLabel)
}

export const cachedMs = cachedPg
