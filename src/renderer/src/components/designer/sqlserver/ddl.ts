/**
 * SQL Server DDL editor support (docs/sqlserver-design.md, «Diseñador»):
 * templates, the script that applies an edited CREATE statement, and name
 * parsing. CREATE VIEW/PROCEDURE/FUNCTION/TRIGGER must be alone in its batch,
 * so the script separates batches with GO (the splitter honours it like
 * sqlcmd and SSMS). Editing uses CREATE OR ALTER (SQL Server 2016 SP1+),
 * which keeps permissions; a renamed object drops the original afterwards.
 */
import { quoteIdent } from '@shared/dialects/sqlserver'
import type { DdlObjectType, DdlScriptOptions } from '@renderer/components/designer/ddl'
import type { DdlSupport } from '@renderer/engines/types'

const KEYWORD: Record<Exclude<DdlObjectType, 'event'>, string> = {
  view: 'VIEW',
  procedure: '(?:PROCEDURE|PROC)',
  function: 'FUNCTION',
  trigger: 'TRIGGER'
}

const DROP: Record<Exclude<DdlObjectType, 'event'>, string> = {
  view: 'VIEW',
  procedure: 'PROCEDURE',
  function: 'FUNCTION',
  trigger: 'TRIGGER'
}

const IDENT =
  '\\[(?:[^\\]]|\\]\\])+\\]|"(?:[^"]|"")+"|[A-Za-z_#@\\u0080-\\uffff][\\w@$#\\u0080-\\uffff]*'

function identName(raw: string): string {
  if (raw.startsWith('[')) return raw.slice(1, -1).replace(/\]\]/g, ']')
  if (raw.startsWith('"')) return raw.slice(1, -1).replace(/""/g, '"')
  return raw
}

function msType(type: DdlObjectType): Exclude<DdlObjectType, 'event'> {
  if (type === 'event')
    throw new Error('SQL Server no tiene eventos programados: usa trabajos del Agente SQL.')
  return type
}

function nameMatch(sql: string, type: Exclude<DdlObjectType, 'event'>): RegExpExecArray | null {
  const re = new RegExp(
    `\\b(?:CREATE(?:\\s+OR\\s+ALTER)?|ALTER)\\s+${KEYWORD[type]}\\s+(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})`,
    'i'
  )
  return re.exec(sql)
}

export function msParseObjectName(sql: string, type: DdlObjectType): string | null {
  if (type === 'event') return null
  const m = nameMatch(sql, type)
  return m ? identName(m[2]) : null
}

export function msIsRename(
  source: string,
  type: DdlObjectType,
  originalName: string | null
): boolean {
  const name = msParseObjectName(source, type)
  return !!originalName && !!name && name.toLowerCase() !== originalName.toLowerCase()
}

/** `CREATE …` / `ALTER …` -> `CREATE OR ALTER …`. */
function createOrAlter(body: string): string {
  if (/^\s*CREATE\s+OR\s+ALTER\b/i.test(body)) return body
  return body.replace(/^\s*(?:CREATE|ALTER)\b/i, 'CREATE OR ALTER')
}

/**
 * Script that applies an edited CREATE statement: CREATE OR ALTER in its own
 * batch; a renamed object then drops the original (the new one already exists,
 * so a failure leaves the original untouched).
 */
export function msBuildDdlScript(source: string, options: DdlScriptOptions): string {
  const type = msType(options.type)
  const body = source
    .trim()
    .replace(/;+\s*$/, '')
    .replace(/\n\s*GO\s*$/i, '')
  const newName = msParseObjectName(body, type)
  const renamed =
    !!options.originalName &&
    !!newName &&
    newName.toLowerCase() !== options.originalName.toLowerCase()
  const parts = [createOrAlter(body)]
  if (renamed)
    parts.push(
      `DROP ${DROP[type]} IF EXISTS ${quoteIdent(options.schema, true)}.${quoteIdent(options.originalName!, true)}`
    )
  return parts.join('\nGO\n')
}

const TEMPLATES: Record<Exclude<DdlObjectType, 'event'>, string> = {
  view: `CREATE VIEW dbo.nueva_vista
AS
SELECT 1 AS columna;`,
  procedure: `CREATE PROCEDURE dbo.nuevo_procedimiento
  @id int
AS
BEGIN
  SET NOCOUNT ON;
  SELECT @id AS id;
END`,
  function: `CREATE FUNCTION dbo.nueva_funcion (@valor int)
RETURNS int
AS
BEGIN
  RETURN @valor * 2;
END`,
  trigger: `CREATE TRIGGER dbo.nuevo_trigger
ON dbo.tabla
AFTER INSERT, UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  -- inserted y deleted contienen las filas afectadas
END`
}

export const msDdlSupport: DdlSupport = {
  template: (type) => TEMPLATES[msType(type)],
  buildScript: msBuildDdlScript,
  parseObjectName: msParseObjectName,
  isRename: msIsRename
}
