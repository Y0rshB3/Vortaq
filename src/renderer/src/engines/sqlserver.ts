import { ENGINES } from '@shared/engines'
import { sqlserverDialect } from '@shared/dialects/sqlserver'
import { vortaqMSSQL } from '@renderer/components/common/editor/msCompletion'
import { msDdlSupport } from '@renderer/components/designer/sqlserver/ddl'
import {
  SQLSERVER_COLUMN_TYPES,
  msTablePlanner
} from '@renderer/components/designer/sqlserver/planner'
import type { EngineUi, TablePlanner } from './types'

/**
 * SQL Server renderer engine (2.6.0): the shared T-SQL dialect, the
 * CodeMirror MSSQL language, the designer on the generic editors (IDENTITY,
 * named DEFAULT constraints, sp_rename) and the DDL templates. No users view
 * and no table storage engines.
 */
export const sqlserverUi: EngineUi = {
  id: 'sqlserver',
  descriptor: ENGINES.sqlserver,
  dialect: sqlserverDialect,
  editorLanguage: vortaqMSSQL,
  designer: msTablePlanner satisfies TablePlanner,
  typeCatalog: { tableEngines: [], columnTypes: SQLSERVER_COLUMN_TYPES },
  ddl: msDdlSupport,
  userSql: null
}
