import { describe, expect, it } from 'vitest'
import { getDialect } from '../dialects'
import type { SqlDialectId } from '../dialects/types'
import { checkExportStatement, leadingWord } from './statement'

const check = (id: SqlDialectId, sql: string) => checkExportStatement(getDialect(id), sql)

describe('checkExportStatement', () => {
  it('accepts one read-only statement that returns rows', () => {
    expect(check('mysql', 'SELECT * FROM a JOIN b USING (id);')).toEqual({
      ok: true,
      sql: 'SELECT * FROM a JOIN b USING (id)'
    })
    expect(check('mysql', '/* hi */ (SELECT 1)').ok).toBe(true)
    expect(check('mysql', 'SHOW TABLES').ok).toBe(true)
    expect(check('mariadb', 'WITH x AS (SELECT 1) SELECT * FROM x').ok).toBe(true)
    expect(check('postgresql', '-- c\nSELECT now()').ok).toBe(true)
    expect(check('postgresql', 'TABLE public.t').ok).toBe(true)
    expect(check('sqlite', 'SELECT rowid, * FROM t').ok).toBe(true)
    expect(check('sqlite', 'PRAGMA table_info(t)').ok).toBe(true)
  })

  it('refuses scripts with several statements', () => {
    const r = check('mysql', 'SELECT 1; SELECT 2')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/única sentencia/)
  })

  it('refuses writes and statements that do not return rows', () => {
    for (const [id, sql] of [
      ['mysql', 'DELETE FROM t'],
      ['mysql', 'SELECT * FROM t FOR UPDATE'],
      ['mysql', "SELECT * FROM t INTO OUTFILE '/tmp/x'"],
      ['mysql', 'USE other'],
      ['mysql', 'CALL p()'],
      ['mysql', 'SET @a = 1'],
      ['mariadb', 'SELECT NEXTVAL(s)'],
      ['postgresql', 'BEGIN'],
      ['postgresql', 'COMMIT'],
      ['postgresql', "SELECT set_config('default_transaction_read_only', 'off', false)"],
      ['postgresql', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'],
      ['postgresql', 'INSERT INTO t VALUES (1) RETURNING *'],
      ['sqlite', 'PRAGMA journal_mode = WAL'],
      ['sqlite', 'WITH x AS (SELECT 1) DELETE FROM t'],
      ['sqlite', "ATTACH DATABASE '/x.db' AS x"],
      ['sqlite', 'BEGIN']
    ] as [SqlDialectId, string][]) {
      expect(check(id, sql).ok, `${id}: ${sql}`).toBe(false)
    }
  })

  it('refuses an empty script', () => {
    expect(check('sqlite', '  -- nothing\n').ok).toBe(false)
  })

  it('leading words skip comments and parentheses', () => {
    expect(leadingWord('mysql', '/*!40101 SELECT */ 1')).toBe('SELECT')
    expect(leadingWord('mariadb', '/*M! SELECT */ 1')).toBe('SELECT')
    expect(leadingWord('postgresql', '/* a /* nested */ */ ((select 1))')).toBe('SELECT')
    expect(leadingWord('sqlite', '-- x\n  values (1)')).toBe('VALUES')
  })
})
