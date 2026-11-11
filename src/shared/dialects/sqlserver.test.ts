import { describe, expect, it } from 'vitest'
import { getDialect } from './index'
import {
  analyzeDestructiveSqlServer,
  analyzeWrites,
  goRepeatTooLarge,
  isObviousWrite,
  isSingleQuery,
  quoteIdent,
  quoteString,
  qualified,
  splitStatements,
  statementsOfBatch
} from './sqlserver'
import { tokenizeTsql } from './sqlserverLexer'

describe('tokenizeTsql', () => {
  it('strings, N strings, bracket and double-quoted identifiers', () => {
    const t = tokenizeTsql(`SELECT N'it''s', 'x', [a]]b], "c""d" FROM t`)
    expect(t.map((x) => [x.kind, x.value])).toEqual([
      ['word', 'SELECT'],
      ['string', "N'it''s'"],
      ['punct', ','],
      ['string', "'x'"],
      ['punct', ','],
      ['ident', 'a]b'],
      ['punct', ','],
      ['ident', 'c"d'],
      ['word', 'FROM'],
      ['word', 't']
    ])
  })

  it('nested block comments, variables, temp tables and hex literals', () => {
    const t = tokenizeTsql('/* a /* b */ c */ SELECT @x, @@ROWCOUNT, #tmp, ##g, 0x1F --end')
    expect(t.map((x) => x.kind)).toEqual([
      'comment',
      'word',
      'variable',
      'punct',
      'variable',
      'punct',
      'word',
      'punct',
      'word',
      'punct',
      'number',
      'comment'
    ])
    expect(t[0].value).toBe('/* a /* b */ c */')
  })
})

describe('quoting', () => {
  it('brackets only what needs it', () => {
    expect(quoteIdent('users')).toBe('users')
    expect(quoteIdent('order')).toBe('[order]')
    expect(quoteIdent('a]b c')).toBe('[a]]b c]')
    expect(quoteIdent('users', true)).toBe('[users]')
    expect(qualified('dbo', 'Order Details')).toBe('dbo.[Order Details]')
    expect(quoteString("O'Brien")).toBe("N'O''Brien'")
  })
})

describe('splitStatements (GO batches)', () => {
  it('splits at GO lines only, keeps semicolons inside a batch', () => {
    const script = [
      'DECLARE @x int = 1; SELECT @x;',
      'go',
      "SELECT 'GO' AS word",
      '/* GO',
      '*/',
      '  GO 3 -- three times',
      'SELECT 2'
    ].join('\n')
    expect(splitStatements(script)).toEqual([
      { sql: 'DECLARE @x int = 1; SELECT @x;', startLine: 1 },
      { sql: "SELECT 'GO' AS word\n/* GO\n*/", startLine: 3, repeat: 3 },
      { sql: 'SELECT 2', startLine: 7 }
    ])
  })

  it('GO is not a separator when something else is on its line', () => {
    expect(splitStatements('SELECT 1 GO\nSELECT 2').length).toBe(1)
    expect(splitStatements('GOTO done\nSELECT 1').length).toBe(1)
    expect(splitStatements('-- only a comment\nGO\nSELECT 1')).toEqual([
      { sql: 'SELECT 1', startLine: 3 }
    ])
  })

  it('caps GO n and reports the typo', () => {
    expect(splitStatements('SELECT 1\nGO 5000')[0].repeat).toBe(1000)
    expect(goRepeatTooLarge('SELECT 1\nGO 5000')).toBe(5000)
    expect(goRepeatTooLarge('SELECT 1\nGO 5')).toBeNull()
  })

  it('the registry returns the dialect', () => {
    expect(getDialect('sqlserver').quoteIdent('select')).toBe('[select]')
  })
})

describe('statementsOfBatch', () => {
  const heads = (sql: string): string[] => statementsOfBatch(sql).map((s) => s.kind)

  it('splits without semicolons and keeps continuations together', () => {
    expect(heads('SELECT 1 SELECT 2')).toEqual(['SELECT', 'SELECT'])
    expect(heads('INSERT INTO t SELECT a FROM b UNION ALL SELECT c FROM d SELECT 9')).toEqual([
      'INSERT',
      'SELECT'
    ])
    expect(heads('UPDATE t SET a = 1 WHERE b = 2 SET @x = 1')).toEqual(['UPDATE', 'SET'])
    expect(heads('INSERT INTO t EXEC dbo.p')).toEqual(['INSERT'])
    expect(heads("SELECT CASE WHEN a = 1 THEN 'x' ELSE 'y' END FROM t")).toEqual(['SELECT'])
    expect(heads('IF @x = 1 BEGIN DELETE FROM t WHERE id = 1 END ELSE SELECT 1')).toEqual([
      'IF',
      'BEGIN',
      'DELETE',
      'END',
      'ELSE',
      'SELECT'
    ])
  })

  it('CTEs end in their statement; MERGE runs to its semicolon', () => {
    expect(heads('WITH c AS (SELECT 1 AS a) DELETE FROM t WHERE a IN (SELECT a FROM c)')).toEqual([
      'DELETE'
    ])
    expect(
      heads(
        'MERGE t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id); SELECT 1'
      )
    ).toEqual(['MERGE', 'SELECT'])
  })

  it('ALTER TABLE … DROP / ALTER COLUMN and ON DELETE stay in the ALTER', () => {
    expect(
      heads(
        'ALTER TABLE t DROP COLUMN c ALTER TABLE t ALTER COLUMN d int ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES u (id) ON DELETE CASCADE DROP TABLE x'
      )
    ).toEqual(['ALTER', 'ALTER', 'ALTER', 'DROP'])
  })

  it('a procedure, function, trigger or view takes the rest of the batch', () => {
    const body = 'CREATE OR ALTER PROCEDURE p AS BEGIN DELETE FROM t; SELECT 1; END'
    expect(statementsOfBatch(body)).toHaveLength(1)
    expect(statementsOfBatch('CREATE VIEW v AS SELECT 1 AS a')).toHaveLength(1)
  })

  it('GRANT lists permissions that look like statements', () => {
    expect(heads('GRANT SELECT, INSERT, UPDATE ON t TO u SELECT 1')).toEqual(['GRANT', 'SELECT'])
  })

  it('isSingleQuery: one SELECT (or WITH … SELECT) without INTO', () => {
    expect(isSingleQuery('SELECT * FROM t WHERE a = 1;')).toBe(true)
    expect(isSingleQuery('WITH c AS (SELECT 1 AS a) SELECT * FROM c')).toBe(true)
    expect(isSingleQuery('SELECT * INTO #t FROM t')).toBe(false)
    expect(isSingleQuery('SELECT 1 SELECT 2')).toBe(false)
    expect(isSingleQuery('UPDATE t SET a = 1')).toBe(false)
  })
})

describe('production guard', () => {
  const reads = [
    'SELECT * FROM dbo.t WITH (NOLOCK) WHERE a = 1',
    'DECLARE @t TABLE (a int); INSERT INTO @t VALUES (1); UPDATE @t SET a = 2; DELETE FROM @t; SELECT * FROM @t',
    'SET NOCOUNT ON; SELECT 1',
    'BEGIN TRAN; SELECT 1; COMMIT',
    "EXEC sp_help N'dbo.t'",
    'sp_who2',
    "EXECUTE sys.sp_columns @table_name = N't'",
    'DECLARE c CURSOR FOR SELECT a FROM t FOR UPDATE; OPEN c; FETCH NEXT FROM c INTO @a; CLOSE c; DEALLOCATE c',
    "EXECUTE AS USER = 'u'; SELECT 1; REVERT",
    'USE master; SELECT name FROM sys.databases',
    "DBCC SHOW_STATISTICS ('t', ix)",
    "SELECT 'DROP TABLE x' AS text, [delete] FROM t -- UPDATE t",
    'WITH c AS (SELECT 1 AS a) SELECT * FROM c'
  ]
  it.each(reads)('read: %s', (sql) => {
    expect(analyzeWrites(sql)).toEqual({ writes: false, reasons: [] })
    expect(isObviousWrite(sql)).toBe(false)
  })

  const writes: [string, string][] = [
    ['INSERT INTO t VALUES (1)', 'INSERT'],
    ['UPDATE t SET a = 1', 'UPDATE'],
    ['DELETE t WHERE a = 1', 'DELETE'],
    ['MERGE t USING s ON 1 = 1 WHEN MATCHED THEN DELETE;', 'MERGE'],
    ['CREATE TABLE x (a int)', 'CREATE TABLE'],
    ['CREATE OR ALTER VIEW v AS SELECT 1 AS a', 'CREATE OR ALTER VIEW'],
    ['DROP TABLE IF EXISTS x', 'DROP TABLE'],
    ['TRUNCATE TABLE t', 'TRUNCATE TABLE'],
    ['SELECT * INTO dbo.copy FROM t', 'SELECT … INTO'],
    ['SELECT * INTO #tmp FROM t', 'SELECT … INTO'],
    ['EXEC dbo.do_things 1', 'EXEC do_things'],
    ['dbo.do_things', 'EXEC do_things'],
    ['[dbo].[do_things] 1', 'EXEC do_things'],
    ["EXEC sp_executesql N'SELECT 1'", 'EXEC sp_executesql'],
    ["EXEC ('DELETE FROM t')", 'EXEC de SQL dinámico'],
    ['EXEC @sql', 'EXEC de SQL dinámico'],
    ['SELECT NEXT VALUE FOR dbo.seq', 'NEXT VALUE FOR'],
    ["SELECT * FROM OPENQUERY(srv, 'SELECT 1')", 'OPENQUERY'],
    ['GRANT SELECT ON t TO u', 'GRANT'],
    ["BACKUP DATABASE x TO DISK = N'/tmp/x.bak'", 'BACKUP'],
    ["DBCC CHECKIDENT ('t', RESEED, 0)", 'DBCC CHECKIDENT'],
    ['UPDATE STATISTICS t', 'UPDATE STATISTICS'],
    ['DISABLE TRIGGER tr ON t', 'DISABLE TRIGGER'],
    ['DELETE FROM t OUTPUT deleted.* INTO dbo.audit WHERE a = 1', 'DELETE'],
    ['SELECT 1\nGO\nINSERT INTO t VALUES (1)', 'INSERT']
  ]
  it.each(writes)('write: %s', (sql, reason) => {
    const check = analyzeWrites(sql)
    expect(check.writes).toBe(true)
    expect(check.reasons).toContain(reason)
    // The main denylist agrees with the renderer for every batch that writes.
    expect(splitStatements(sql).some((b) => isObviousWrite(b.sql))).toBe(true)
  })
})

describe('analyzeDestructiveSqlServer', () => {
  it('finds DROP, TRUNCATE, ALTER … DROP and DML without WHERE', () => {
    const found = analyzeDestructiveSqlServer(
      [
        'DELETE FROM t',
        'DELETE FROM t WHERE id = 1',
        'UPDATE t SET a = 1',
        'UPDATE TOP (5) t SET a = 1',
        'DELETE FROM @v',
        'TRUNCATE TABLE t',
        'GO',
        'ALTER TABLE t DROP COLUMN c',
        'DROP VIEW v',
        'WITH c AS (SELECT 1 AS a) DELETE FROM t',
        'CREATE PROCEDURE p AS DELETE FROM t'
      ].join('\n')
    )
    expect(found.map((f) => [f.reason, f.allRows])).toEqual([
      ['DELETE sin WHERE', true],
      ['UPDATE sin WHERE', true],
      ['UPDATE sin WHERE', false],
      ['TRUNCATE TABLE', true],
      ['ALTER TABLE … DROP', false],
      ['DROP VIEW', false],
      ['DELETE sin WHERE', true]
    ])
    expect(found[0].sql).toBe('DELETE FROM t')
  })
})

describe('-- comments end where SQL Server ends them', () => {
  const ms = getDialect('sqlserver')
  it('a lone CR ends the comment (checked on SQL Server 2022: the batch returns two results)', () => {
    const tokens = tokenizeTsql('SELECT 1 AS a --x\rSELECT 2 AS b')
    expect(tokens.find((t) => t.kind === 'comment')?.value).toBe('--x')
    expect(statementsOfBatch('SELECT 1 AS a --x\rSELECT 2 AS b')).toHaveLength(2)
  })
  it('a write after a lone CR is a write for both guards', () => {
    const sql = 'SELECT * FROM t -- old Mac line ending\rDELETE FROM t'
    expect(ms.analyzeWrites(sql).writes).toBe(true)
    expect(ms.isObviousWrite(sql)).toBe(true)
  })
})
