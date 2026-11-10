/**
 * SQL Server grid saves (docs/sqlserver-design.md, «Datos»), on top of the
 * generic all-or-nothing loop (db/rowChanges.ts):
 * - values travel as @p parameters (nvarchar text, varbinary for 0xHEX, bit
 *   for booleans) and are cast to the column's declared type, so decimals,
 *   dates and unique identifiers convert on the server; datetime and
 *   smalldatetime values are rewritten to ISO forms every session language
 *   reads the same;
 * - cells the user never touched are not sent, so defaults fill themselves;
 *   IDENTITY, computed, rowversion and period columns are never written;
 * - an insert hands the generated key back through OUTPUT … INTO a table
 *   variable (allowed even when the table has triggers);
 * - rows are addressed by the primary key only: a table without one is
 *   read-only; the whole save runs in one transaction with XACT_ABORT ON.
 */
import { quoteIdent } from '@shared/dialects/sqlserver'
import type { ApplyRowChangesResult, CellValue, RowChange } from '@shared/types'
import { ServerError } from '../db/errors'
import { applyRowChangesAtomically } from '../db/rowChanges'
import { describeError, errorNumber, MsUserError } from './errors'
import type { MsColumnInfo } from './introspect'
import type { MsSession } from './session'
import { isoLegacyDate } from './tableFilter'

export interface MsStatement {
  sql: string
  params: unknown[]
  /** The statement returns the generated key of an insert as its last result set. */
  returning: boolean
}

export const NO_PRIMARY_KEY =
  'La tabla no tiene clave primaria: sus filas no se pueden editar desde la cuadrícula (solo lectura)'

/** Grid value to a parameter: 0xHEX for binary columns becomes bytes, datetime gets an ISO form. */
export function bindValue(value: CellValue, column: MsColumnInfo | undefined): unknown {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  const text = String(value)
  if (column?.typeKind === 'binary' && /^0x[0-9a-f]*$/i.test(text))
    return Buffer.from(text.slice(2), 'hex')
  const base = column?.dataType.toLowerCase()
  if (base === 'datetime' || base === 'smalldatetime') return isoLegacyDate(text)
  return text
}

function refuseUnwritable(name: string, column: MsColumnInfo | undefined): void {
  if (column?.autoIncrement)
    throw new MsUserError(`La columna ${name} es IDENTITY: el valor lo genera el servidor`)
  if (column?.computed !== null && column?.computed !== undefined)
    throw new MsUserError(`La columna ${name} es calculada: no se puede escribir`)
  if (column?.generated)
    throw new MsUserError(`La columna ${name} la genera el servidor: no se puede escribir`)
}

export function buildMsRowStatement(
  schema: string,
  table: string,
  change: RowChange,
  columns: MsColumnInfo[],
  primaryKey: string[]
): MsStatement {
  const byName = new Map(columns.map((c) => [c.name, c]))
  const target = `${quoteIdent(schema)}.${quoteIdent(table)}`
  const params: unknown[] = []
  const bind = (name: string, value: CellValue): string => {
    const column = byName.get(name)
    if (!column) throw new MsUserError(`La columna ${name} no existe en ${schema}.${table}`)
    params.push(bindValue(value, column))
    const placeholder = `@p${params.length}`
    return value === null || typeof value === 'boolean'
      ? placeholder
      : `CAST(${placeholder} AS ${column.sqlType ?? column.columnType})`
  }
  const keyClause = (key: Record<string, CellValue>): string => {
    if (!primaryKey.length) throw new MsUserError(NO_PRIMARY_KEY)
    for (const k of primaryKey)
      if (!(k in key)) throw new MsUserError(`Falta la clave ${k} para identificar la fila`)
    return primaryKey
      .map((k) =>
        key[k] === null ? `${quoteIdent(k)} IS NULL` : `${quoteIdent(k)} = ${bind(k, key[k])}`
      )
      .join(' AND ')
  }

  if (change.kind === 'insert') {
    // An empty IDENTITY cell means "let the server generate it": leave it out.
    const names = Object.keys(change.values).filter((n) => {
      const c = byName.get(n)
      return !(change.values[n] === null && (c?.autoIncrement || c?.generated))
    })
    names.forEach((n) => refuseUnwritable(n, byName.get(n)))
    const key = primaryKey.length === 1 ? byName.get(primaryKey[0]) : undefined
    const returning = !!key
    const output = key ? `DECLARE @vortaq_key TABLE (k ${key.sqlType ?? key.columnType}); ` : ''
    const outputClause = key ? ` OUTPUT INSERTED.${quoteIdent(key.name)} INTO @vortaq_key` : ''
    const tail = key ? '; SELECT k FROM @vortaq_key' : ''
    const values = names.map((n) => bind(n, change.values[n]))
    const insert = names.length
      ? `INSERT INTO ${target} (${names.map((n) => quoteIdent(n)).join(', ')})${outputClause} VALUES (${values.join(', ')})`
      : `INSERT INTO ${target}${outputClause} DEFAULT VALUES`
    return { sql: `${output}${insert}${tail}`, params, returning }
  }
  if (change.kind === 'update') {
    const names = Object.keys(change.values)
    if (!names.length) throw new MsUserError('No hay cambios que aplicar en la fila')
    names.forEach((n) => refuseUnwritable(n, byName.get(n)))
    const set = names.map((n) => `${quoteIdent(n)} = ${bind(n, change.values[n])}`).join(', ')
    return {
      sql: `UPDATE ${target} SET ${set} WHERE ${keyClause(change.key)}`,
      params,
      returning: false
    }
  }
  return {
    sql: `DELETE FROM ${target} WHERE ${keyClause(change.key)}`,
    params,
    returning: false
  }
}

/** Display text of a statement (literals inlined for the result list only). */
export function displayMsStatement(stmt: MsStatement): string {
  return stmt.sql.replace(/@p(\d+)\b/g, (_m, n: string) => {
    const v = stmt.params[Number(n) - 1]
    if (v === null || v === undefined) return 'NULL'
    if (typeof v === 'boolean') return v ? '1' : '0'
    if (Buffer.isBuffer(v)) return `0x${v.toString('hex').toUpperCase()}`
    return `N'${String(v).replace(/'/g, "''")}'`
  })
}

/** Applies the grid changes in one transaction (main already checked the confirmation). */
export async function applyMsRowChanges(
  session: MsSession,
  schema: string,
  table: string,
  changes: RowChange[],
  columns: MsColumnInfo[],
  primaryKey: string[]
): Promise<ApplyRowChangesResult> {
  if (!columns.length) throw new MsUserError(`La tabla ${schema}.${table} no existe`)
  const statements = changes.map((c) => buildMsRowStatement(schema, table, c, columns, primaryKey))
  return applyRowChangesAtomically(changes, statements, {
    begin: async () => session.exec('SET XACT_ABORT ON; BEGIN TRANSACTION'),
    execute: async (stmt) => {
      const res = await session.queryArrays(stmt.sql, stmt.params)
      const id = stmt.returning && res.rows[0] ? res.rows[0][0] : null
      return {
        // The DML's own count (OUTPUT … INTO and SELECT @key report theirs after it).
        affectedRows: res.counts[0] ?? 0,
        insertId: id === null || id === undefined ? null : typeof id === 'number' ? id : String(id)
      }
    },
    commit: async () => session.exec('COMMIT TRANSACTION; SET XACT_ABORT OFF'),
    rollback: async () =>
      session.exec('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION; SET XACT_ABORT OFF'),
    display: displayMsStatement,
    explainError: describeError,
    // Server text (2627 quotes the duplicate key): shown, logged as its number only.
    toError: (message, cause) => {
      const n = errorNumber(cause)
      return new ServerError(message, n === null ? undefined : String(n))
    }
  })
}
