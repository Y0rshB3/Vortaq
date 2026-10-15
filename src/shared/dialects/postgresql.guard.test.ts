import { describe, expect, it } from 'vitest'
import {
  UNDECODABLE_IDENT,
  analyzeDestructivePg,
  analyzeWrites,
  explainPgError,
  isObviousWrite,
  isPgPrivilegeError,
  isSideEffectFunction,
  splitStatements
} from './postgresql'

/** [statement, renderer reasons ([] = read), main denylist] */
const CORPUS: [string, string[], boolean][] = [
  // reads
  ['SELECT * FROM t', [], false],
  ['  /* c */ (SELECT 1) UNION (SELECT 2)', [], false],
  ['VALUES (1), (2)', [], false],
  ['TABLE t', [], false],
  ['WITH x AS (SELECT 1) SELECT * FROM x', [], false],
  ['WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT * FROM r', [], false],
  ["SELECT 'nextval(1)', 'DELETE FROM t' /* pg_terminate_backend(1) */ -- setval(1)", [], false],
  ['SELECT "update", "delete" FROM "insert"', [], false],
  ["SELECT * FROM t WHERE d #>> '{a}' = 'x' AND d ?| array['k']", [], false],
  ['SELECT substring(x FROM 1 FOR 2) FROM t', [], false],
  ['SHOW search_path', [], false],
  ['SHOW ALL', [], false],
  ['EXPLAIN DELETE FROM t', [], false],
  ['EXPLAIN SELECT 1', [], false],
  ['EXPLAIN ANALYZE SELECT 1', [], false],
  ['EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t', [], false],
  ['EXPLAIN (ANALYZE false) DELETE FROM t', [], false],
  ['SET search_path TO a, public', [], false],
  ['SET search_path = "Mixed", public', [], false],
  ["SET LOCAL statement_timeout = '5s'", [], false],
  ["SET SESSION TimeZone TO 'UTC'", [], false],
  ["SET TIME ZONE 'Europe/Madrid'", [], false],
  ["SET SCHEMA 'app'", [], false],
  ['SET enable_seqscan = off', [], false],
  ['SET datestyle TO ISO, MDY', [], false],
  ['RESET search_path', [], false],
  ['RESET TIME ZONE', [], false],
  ['BEGIN', [], false],
  ['BEGIN ISOLATION LEVEL SERIALIZABLE', [], false],
  ['START TRANSACTION READ ONLY', [], false],
  ['COMMIT', [], false],
  ['END', [], false],
  ['ROLLBACK', [], false],
  ['ROLLBACK TO SAVEPOINT s', [], false],
  ['ABORT', [], false],
  ['SAVEPOINT s', [], false],
  ['RELEASE SAVEPOINT s', [], false],
  ['SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY', [], false],
  ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', [], false],
  ['COPY t TO STDOUT', [], false],
  ['COPY (SELECT * FROM t) TO STDOUT WITH (FORMAT csv)', [], false],
  ['DEALLOCATE ALL', [], false],
  ['FETCH 10 FROM c', [], false],
  ['DECLARE c CURSOR FOR SELECT * FROM t', [], false],
  // writes the main denylist also blocks
  ['INSERT INTO t VALUES (1)', ['INSERT'], true],
  ['INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET v = 2', ['INSERT'], true],
  ['UPDATE t SET a = 1 WHERE id = 2', ['UPDATE'], true],
  ['UPDATE t SET a = 1', ['UPDATE sin WHERE'], true],
  ['DELETE FROM t', ['DELETE sin WHERE'], true],
  ['DELETE FROM t WHERE id IN (SELECT id FROM u)', ['DELETE'], true],
  ['MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', ['MERGE'], true],
  ['CREATE TABLE t (id int)', ['CREATE TABLE'], true],
  [
    'CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql',
    ['CREATE FUNCTION'],
    true
  ],
  ['CREATE MATERIALIZED VIEW m AS SELECT 1', ['CREATE MATERIALIZED VIEW'], true],
  ['ALTER TABLE t ADD COLUMN c int', ['ALTER TABLE'], true],
  ['DROP TABLE t', ['DROP TABLE'], true],
  ['TRUNCATE t RESTART IDENTITY CASCADE', ['TRUNCATE'], true],
  ['GRANT SELECT ON t TO r', ['GRANT'], true],
  ['REVOKE SELECT ON t FROM r', ['REVOKE'], true],
  ['COPY t FROM STDIN', ['COPY FROM'], true],
  ["COPY t FROM '/tmp/x.csv'", ['COPY FROM'], true],
  ['CALL p(1)', ['CALL'], true],
  ['DO $$ BEGIN PERFORM 1; END $$', ['DO'], true],
  ['REFRESH MATERIALIZED VIEW CONCURRENTLY m', ['REFRESH'], true],
  ['VACUUM ANALYZE t', ['VACUUM'], true],
  ['CLUSTER t USING i', ['CLUSTER'], true],
  ['REINDEX TABLE t', ['REINDEX'], true],
  ["COMMENT ON TABLE t IS 'x'", ['COMMENT ON'], true],
  ["SECURITY LABEL ON TABLE t IS 'x'", ['SECURITY LABEL'], true],
  ['REASSIGN OWNED BY a TO b', ['REASSIGN OWNED'], true],
  ['IMPORT FOREIGN SCHEMA s FROM SERVER x INTO y', ['IMPORT FOREIGN SCHEMA'], true],
  ['WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', ['INSERT'], true],
  ['WITH x AS (SELECT id FROM u) DELETE FROM t WHERE id IN (SELECT id FROM x)', ['DELETE'], true],
  // writes only the renderer catches (allowlist)
  ['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', ['CTE con escritura'], false],
  ['WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT 1', ['CTE con escritura'], false],
  ['SELECT * INTO newt FROM t', ['SELECT … INTO'], false],
  ['SELECT * FROM t FOR UPDATE', ['SELECT … FOR UPDATE'], false],
  ['SELECT * FROM t FOR NO KEY UPDATE SKIP LOCKED', ['SELECT … FOR UPDATE'], false],
  ['SELECT * FROM t FOR SHARE', ['SELECT … FOR UPDATE'], false],
  ['EXPLAIN ANALYZE DELETE FROM t', ['EXPLAIN ANALYZE de una escritura'], false],
  ['EXPLAIN (ANALYZE, COSTS off) UPDATE t SET a = 1', ['EXPLAIN ANALYZE de una escritura'], false],
  ['SELECT pg_terminate_backend(1)', ['Función con efectos: pg_terminate_backend'], true],
  [
    'SELECT pg_cancel_backend(pid) FROM pg_stat_activity',
    ['Función con efectos: pg_cancel_backend'],
    true
  ],
  ["SELECT set_config('a.b', 'c', false)", ['Función con efectos: set_config'], true],
  ["SELECT nextval('s')", ['Función con efectos: nextval'], true],
  ["SELECT pg_catalog.setval('s', 1)", ['Función con efectos: setval'], true],
  ['SELECT pg_advisory_lock(1)', ['Función con efectos: pg_advisory_lock'], true],
  ['SELECT lo_unlink(1)', ['Función con efectos: lo_unlink'], true],
  ["SELECT pg_read_file('/etc/passwd')", ['Función con efectos: pg_read_file'], true],
  ["SELECT * FROM dblink('x', 'DELETE FROM t') AS r(a int)", ['Función con efectos: dblink'], true],
  ['SELECT pg_reload_conf()', ['Función con efectos: pg_reload_conf'], true],
  ['SET ROLE admin', ['SET ROLE'], true],
  ['SET SESSION AUTHORIZATION admin', ['SET SESSION AUTHORIZATION'], true],
  ['SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', ['SET … READ WRITE'], true],
  ['SET TRANSACTION READ WRITE', ['SET … READ WRITE'], true],
  ['SET default_transaction_read_only = off', ['SET default_transaction_read_only'], true],
  ['SET transaction_read_only = off', ['SET transaction_read_only'], true],
  ["SET my.var = 'x'", ['SET my'], false],
  ['BEGIN READ WRITE', ['BEGIN READ WRITE'], true],
  ['RESET ALL', ['RESET ALL'], true],
  ['RESET ROLE', ['RESET ROLE'], true],
  ['DISCARD ALL', ['DISCARD'], true],
  ['CHECKPOINT', ['CHECKPOINT'], false],
  ["LOAD 'auto_explain'", ['LOAD'], false],
  ['ANALYZE t', ['ANALYZE'], false],
  ['LISTEN ch', ['LISTEN'], false],
  ["NOTIFY ch, 'x'", ['NOTIFY'], false],
  ['LOCK TABLE t IN ACCESS EXCLUSIVE MODE', ['LOCK'], false],
  ["COPY t TO '/tmp/out.csv'", ['COPY'], false],
  ['PREPARE p AS DELETE FROM t', ['PREPARE'], false],
  ['EXECUTE p', ['EXECUTE'], false],
  ["COMMIT PREPARED 'x'", ['COMMIT PREPARED'], false],
  ['\\copy t from data.csv', ['Comando de psql: \\copy'], false]
]

describe('PostgreSQL production guard corpus', () => {
  it.each(CORPUS)('%s', (sql, reasons, obvious) => {
    expect(analyzeWrites(sql)).toEqual({ writes: reasons.length > 0, reasons })
    expect(isObviousWrite(sql)).toBe(obvious)
  })

  it('main never flags what the renderer lets through (isObviousWrite ⇒ analyzeWrites)', () => {
    for (const [sql] of CORPUS)
      if (isObviousWrite(sql)) expect(analyzeWrites(sql).writes, sql).toBe(true)
  })

  it('collects the reasons of every statement of a script', () => {
    const script =
      "SET search_path TO app, public; BEGIN; UPDATE t SET a = 1; SELECT nextval('s'); COMMIT"
    expect(analyzeWrites(script)).toEqual({
      writes: true,
      reasons: ['UPDATE sin WHERE', 'Función con efectos: nextval']
    })
    expect(
      splitStatements(script)
        .filter((s) => isObviousWrite(s.sql))
        .map((s) => s.sql)
    ).toEqual(['UPDATE t SET a = 1', "SELECT nextval('s')"])
  })

  it('a dollar-quoted function body never hides or invents a write', () => {
    expect(analyzeWrites("SELECT $$DELETE FROM t; SELECT nextval('s')$$ AS txt").writes).toBe(false)
  })

  it('knows the side-effect function families', () => {
    for (const fn of [
      'pg_advisory_xact_lock',
      'pg_try_advisory_lock',
      'lo_import',
      'pg_ls_dir',
      'pg_stat_reset_shared',
      'dblink_exec',
      'query_to_xml',
      'query_to_xml_and_xmlschema',
      'cursor_to_xml',
      'pg_notify'
    ])
      expect(isSideEffectFunction(fn), fn).toBe(true)
    for (const fn of ['now', 'txid_current', 'pg_backend_pid', 'lower', 'table_to_xml'])
      expect(isSideEffectFunction(fn), fn).toBe(false)
  })
})

describe('analyzeDestructivePg', () => {
  it('finds drops, truncates, deletes and updates without WHERE', () => {
    const script = `-- clean up
DROP TABLE IF EXISTS a;
DROP MATERIALIZED VIEW m;
TRUNCATE b;
DELETE FROM c WHERE id = 1;
DELETE FROM d;
UPDATE e SET x = 1;
UPDATE f SET x = 1 WHERE id = 2;
ALTER TABLE g DROP COLUMN h;
ALTER TABLE g ALTER COLUMN h DROP DEFAULT;
ALTER TABLE g ALTER COLUMN h DROP NOT NULL;
WITH x AS (DELETE FROM k RETURNING *) SELECT * FROM x;
SELECT 'DROP TABLE z';
INSERT INTO t VALUES (1)`
    expect(analyzeDestructivePg(script)).toEqual([
      { sql: 'DROP TABLE IF EXISTS a', reason: 'DROP TABLE', allRows: false },
      { sql: 'DROP MATERIALIZED VIEW m', reason: 'DROP MATERIALIZED VIEW', allRows: false },
      { sql: 'TRUNCATE b', reason: 'TRUNCATE TABLE', allRows: false },
      { sql: 'DELETE FROM c WHERE id = 1', reason: 'DELETE', allRows: false },
      { sql: 'DELETE FROM d', reason: 'DELETE sin WHERE', allRows: true },
      { sql: 'UPDATE e SET x = 1', reason: 'UPDATE sin WHERE', allRows: true },
      { sql: 'ALTER TABLE g DROP COLUMN h', reason: 'ALTER TABLE … DROP', allRows: false },
      {
        sql: 'WITH x AS (DELETE FROM k RETURNING *) SELECT * FROM x',
        reason: 'DELETE sin WHERE',
        allRows: true
      }
    ])
  })
})

describe('PostgreSQL error explanations', () => {
  it('explains the common SQLSTATEs in Spanish', () => {
    expect(explainPgError('25P02')).toBe('Transacción abortada: ejecuta ROLLBACK.')
    expect(explainPgError('22P02')).toContain('{a,b,"c d"}')
    expect(explainPgError('0A000')).toContain('cambia la base de datos de la pestaña')
    for (const code of [
      '23502',
      '23505',
      '23503',
      '22001',
      '22003',
      '42501',
      '40P01',
      '55P03',
      '57014',
      '25006',
      '42P01',
      '42703',
      '42601'
    ])
      expect(explainPgError(code), code).toBeTruthy()
    expect(explainPgError('XX000')).toBeNull()
    expect(isPgPrivilegeError('42501')).toBe(true)
    expect(isPgPrivilegeError('23505')).toBe(false)
  })
})

describe('main denylist: statements that would lift the read-only safety net', () => {
  it.each([
    'SET default_transaction_read_only = off',
    'SET SESSION default_transaction_read_only TO off',
    'SET transaction_read_only = off',
    'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
    'SET TRANSACTION READ WRITE',
    'BEGIN READ WRITE',
    'START TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ WRITE',
    'RESET ALL',
    'RESET default_transaction_read_only',
    'DISCARD ALL',
    'SET ROLE admin',
    'SET SESSION AUTHORIZATION admin',
    "SELECT set_config('default_transaction_read_only', 'off', false)",
    'SELECT pg_terminate_backend(42)',
    "SELECT dblink_exec('db', 'DELETE FROM t')",
    "SELECT nextval('s')"
  ])('%s', (sql) => {
    expect(isObviousWrite(sql)).toBe(true)
    expect(analyzeWrites(sql).writes).toBe(true)
  })

  it.each([
    'BEGIN',
    'BEGIN READ ONLY',
    'START TRANSACTION',
    'SET search_path TO app, public',
    'SET statement_timeout = 5000',
    "SELECT 'set_config(' AS x",
    'RESET search_path'
  ])('still lets %s through', (sql) => {
    expect(isObviousWrite(sql)).toBe(false)
  })
})

describe('side-effect functions under other spellings', () => {
  const spellings = [
    'SELECT U&"pg\\005fterminate\\005fbackend"(pid) FROM pg_stat_activity',
    "SELECT U&\"\\0064blink_exec\"('x', 'DELETE FROM t')",
    'SELECT U&"pg\\005fread\\005ffile"(\'/etc/passwd\')',
    'SELECT U&"pg!005fterminate!005fbackend" UESCAPE \'!\' (1)',
    'SELECT U&"pg!005fterminate!005fbackend" /* x */ UESCAPE /* y */ \'!\'(1)',
    'SELECT pg_catalog.pg_terminate_backend(1)',
    'SELECT "pg_catalog"."pg_terminate_backend"(1)',
    'SELECT "pg_terminate_backend"(1)',
    'SELECT pg_terminate_backend /* c */ (1)',
    'SELECT pg_terminate_backend\n  -- c\n  (1)',
    'SELECT PG_Terminate_Backend(1)',
    'SELECT * FROM ROWS FROM (pg_catalog . pg_terminate_backend (1))'
  ]

  it('analyzeWrites and isObviousWrite flag every spelling', () => {
    for (const sql of spellings) {
      expect(analyzeWrites(sql).writes, sql).toBe(true)
      expect(isObviousWrite(sql), sql).toBe(true)
    }
  })

  it('an identifier that cannot be decoded is a write (fail closed)', () => {
    for (const sql of ['SELECT U&"pg\\zz"(1)', 'SELECT U&"f" UESCAPE \'+\' (1)']) {
      expect(analyzeWrites(sql).reasons, sql).toContain(UNDECODABLE_IDENT)
      expect(isObviousWrite(sql), sql).toBe(true)
    }
  })

  it('harmless U& names and strings stay reads', () => {
    expect(analyzeWrites('SELECT U&"n\\0061me" FROM t').writes).toBe(false)
    expect(analyzeWrites("SELECT U&'pg\\005fterminate\\005fbackend(1)' AS txt").writes).toBe(false)
    expect(analyzeWrites("SELECT 'pg_terminate_backend(1)'").writes).toBe(false)
  })
})
