import { describe, expect, it } from 'vitest'
import { mysqlDialect, postgresqlDialect, sqliteDialect } from '@core'
import { runTarget, statementAt, statementRanges, wrapForSingleStatement } from './statement'

const at = (text: string, marker = '|'): { text: string; offset: number } => {
  const offset = text.indexOf(marker)
  return { text: text.slice(0, offset) + text.slice(offset + 1), offset }
}

const cursor = (source: string, dialect = mysqlDialect) => {
  const { text, offset } = at(source)
  return runTarget(text, { start: offset, end: offset }, dialect)
}

describe('statement under the cursor', () => {
  it('runs the statement that contains the cursor', () => {
    expect(cursor('SELECT 1;\nSEL|ECT 2;\nSELECT 3;')).toMatchObject({
      kind: 'statement',
      sql: expect.stringMatching(/^SELECT 2/)
    })
    expect(cursor('|SELECT 1;\nSELECT 2;')?.sql).toMatch(/^SELECT 1/)
  })

  it('right after the semicolon, runs the statement that ends on that line', () => {
    expect(cursor('SELECT 1;|\nSELECT 2;')?.sql).toMatch(/^SELECT 1/)
    expect(cursor('SELECT 1;  |\nSELECT 2;')?.sql).toMatch(/^SELECT 1/)
  })

  it('on a blank or comment line, runs the next statement', () => {
    expect(cursor('SELECT 1;\n|\nSELECT 2;')?.sql).toMatch(/^SELECT 2/)
    expect(cursor('SELECT 1;\n-- next|\nSELECT 2;')?.sql).toMatch(/SELECT 2/)
    // After the last statement there is no next one: the last one runs.
    expect(cursor('SELECT 1;\nSELECT 2;\n\n|')?.sql).toMatch(/^SELECT 2/)
  })

  it('never cuts a statement at a semicolon inside a string or comment', () => {
    const target = cursor("SELECT 'a;b' AS x, 1 /* ; */|;\nSELECT 2;")
    expect(target?.sql).toContain("'a;b'")
    expect(target?.sql).toContain('/* ; */')
  })

  it('keeps PostgreSQL dollar-quoted bodies together', () => {
    const body = 'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;'
    const target = cursor(
      `SELECT 1;\n${body.replace('RETURN 1', 'RETURN |1')}\nSELECT 2;`,
      postgresqlDialect
    )
    expect(target?.sql).toContain('RETURN 1; END;')
    expect(target?.sql).toContain('LANGUAGE plpgsql')
  })

  it('keeps a SQLite trigger body together', () => {
    const trigger =
      'CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES (1); UPDATE c SET x = 1; END;'
    const target = cursor(`${trigger.replace('UPDATE', 'UP|DATE')}\nSELECT 1;`, sqliteDialect)
    expect(target?.sql).toContain('INSERT INTO b VALUES (1); UPDATE c SET x = 1; END')
  })

  it('a MySQL routine from a DELIMITER block is sent back inside one', () => {
    const script = [
      'DELIMITER $$',
      'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$',
      'DELIMITER ;',
      'SELECT 3;'
    ].join('\n')
    const { text, offset } = at(script.replace('SELECT 2', 'SELECT |2'))
    const target = runTarget(text, { start: offset, end: offset }, mysqlDialect)
    expect(target?.kind).toBe('statement')
    // The core splits what it receives again: it must come back as exactly that one statement.
    const again = mysqlDialect.splitStatements(target!.sql)
    expect(again).toHaveLength(1)
    expect(again[0].sql).toContain('SELECT 1; SELECT 2; END')
  })
})

describe('selection and whole document', () => {
  it('a selection runs exactly as selected', () => {
    const text = 'SELECT 1;\nSELECT 2;\nSELECT 3;'
    const start = text.indexOf('SELECT 2')
    const end = text.length
    expect(runTarget(text, { start, end }, mysqlDialect)).toEqual({
      kind: 'selection',
      sql: 'SELECT 2;\nSELECT 3;',
      start,
      end
    })
  })

  it('a blank selection falls back to the statement under the cursor', () => {
    const text = 'SELECT 1;   \nSELECT 2;'
    expect(runTarget(text, { start: 9, end: 12 }, mysqlDialect)?.sql).toMatch(/^SELECT 1/)
  })

  it('a document with only comments is sent whole; an empty one gives nothing', () => {
    expect(runTarget('-- nada\n', { start: 0, end: 0 }, mysqlDialect)).toMatchObject({
      kind: 'document'
    })
    expect(runTarget('   \n', { start: 0, end: 0 }, mysqlDialect)).toBeNull()
  })
})

describe('ranges', () => {
  it('maps every statement to its place in the document', () => {
    const text = 'SELECT 1;\n\n  SELECT 2;\nSELECT 3'
    const ranges = statementRanges(text, mysqlDialect.splitStatements(text))
    for (const r of ranges) expect(text.slice(r.start, r.end)).toBe(r.sql)
    expect(statementAt(text, ranges, text.length)?.sql).toBe('SELECT 3')
    expect(statementAt(text, [], 0)).toBeNull()
  })

  it('wraps only MySQL-family statements that would split again', () => {
    expect(wrapForSingleStatement('SELECT 1', mysqlDialect)).toBe('SELECT 1')
    expect(wrapForSingleStatement('BEGIN; END', postgresqlDialect)).toBe('BEGIN; END')
    const wrapped = wrapForSingleStatement('CREATE PROCEDURE p() BEGIN SELECT 1; END', mysqlDialect)
    expect(wrapped.startsWith('DELIMITER $$\n')).toBe(true)
    expect(wrapped.endsWith('DELIMITER ;\n')).toBe(true)
  })
})
