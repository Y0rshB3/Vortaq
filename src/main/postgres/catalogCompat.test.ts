import { describe, expect, it } from 'vitest'
import {
  attidentitySql,
  ddlForServer,
  encryptionLabel,
  indexKeyCountSql,
  partkeySql,
  pgCatalogFeatures,
  prokindSql,
  relispartitionSql,
  sslInfoSql,
  viewInsertableSql
} from './catalogCompat'

describe('PostgreSQL catalog features by server_version_num', () => {
  it('turns each piece on at the version that added it', () => {
    const on = (num: number) =>
      Object.entries(pgCatalogFeatures(num))
        .filter(([k, v]) => k !== 'versionNum' && v === true)
        .map(([k]) => k)
        .sort()
    expect(on(90223)).toEqual([])
    expect(on(90300)).toEqual(['createSchemaIfNotExists', 'matviews', 'updatableViews'])
    expect(on(90600)).toEqual([
      'createSchemaIfNotExists',
      'createSequenceIfNotExists',
      'matviews',
      'statSsl',
      'updatableViews'
    ])
    expect(on(100023)).toContain('identity')
    expect(on(100023)).not.toContain('prokind')
    expect(on(110000)).toContain('includeColumns')
    expect(on(110000)).toContain('triggerExecuteFunction')
    expect(on(100023)).not.toContain('triggerExecuteFunction')
    expect(on(110000)).not.toContain('generated')
    expect(on(170004)).toHaveLength(12)
  })

  it('reads an unknown version (0, missing) as a current server', () => {
    for (const unknown of [0, undefined, null, Number.NaN]) {
      const f = pgCatalogFeatures(unknown)
      expect(f.versionNum).toBe(0)
      expect(f.generated && f.prokind && f.statSsl).toBe(true)
    }
  })

  it('stands in for the missing catalog columns on old servers', () => {
    const old = pgCatalogFeatures(90200)
    const current = pgCatalogFeatures(170000)
    expect(attidentitySql(old)).toBe(`''::text`)
    expect(attidentitySql(current, 'x')).toBe('x.attidentity::text')
    expect(prokindSql(old)).toBe(
      `(CASE WHEN p.proisagg THEN 'a' WHEN p.proiswindow THEN 'w' ELSE 'f' END)::text`
    )
    expect(prokindSql(current)).toBe('p.prokind::text')
    expect(relispartitionSql(old)).toBe('false')
    expect(partkeySql(old)).toBe('NULL::text')
    expect(partkeySql(current, 'c', 'pg_catalog.')).toContain('pg_catalog.pg_get_partkeydef(c.oid)')
    expect(indexKeyCountSql(old)).toBe('i.indnatts')
    expect(indexKeyCountSql(current)).toBe('i.indnkeyatts')
    expect(viewInsertableSql(old)).toBe('false')
    expect(sslInfoSql(old)).not.toContain('pg_stat_ssl')
    expect(sslInfoSql(current)).toContain('pg_stat_ssl')
  })

  it('«Cifrado»: the server’s view when it has one, else the client socket’s', () => {
    const plain = { encrypted: false, protocol: null }
    const tls = { encrypted: true, protocol: 'TLSv1.3' }
    expect(encryptionLabel(true, 'TLSv1.2', plain)).toBe('SSL: TLSv1.2')
    expect(encryptionLabel(false, null, tls)).toBe('sin cifrar')
    expect(encryptionLabel(null, null, tls)).toBe('SSL: TLSv1.3')
    expect(encryptionLabel(null, null, plain)).toBe('sin cifrar')
  })
})

describe('DDL of a newer server for an older target (restore)', () => {
  const v92 = pgCatalogFeatures(90224)
  const v10 = pgCatalogFeatures(100023)
  const v18 = pgCatalogFeatures(180006)
  // The sequence DDL a backup stores (introspect.ts objectDdl, without the semicolon).
  const seq =
    'CREATE SEQUENCE "app"."folio"\n  AS integer\n  INCREMENT BY 5\n  MINVALUE 1\n  MAXVALUE 2147483647\n  START WITH 100\n  CACHE 1'

  it('drops the AS type of a sequence before 10 and keeps every other option', () => {
    expect(ddlForServer(seq, v92)).toBe(
      'CREATE SEQUENCE "app"."folio"\n  INCREMENT BY 5\n  MINVALUE 1\n  MAXVALUE 2147483647\n  START WITH 100\n  CACHE 1'
    )
    expect(ddlForServer(seq, v10)).toBe(seq)
    expect(ddlForServer(seq, v18)).toBe(seq)
    expect(
      ddlForServer('CREATE SEQUENCE IF NOT EXISTS s.x INCREMENT 2 AS pg_catalog.int2', v92)
    ).toBe('CREATE SEQUENCE IF NOT EXISTS s.x INCREMENT 2')
    // A name that reads like the clause is a name, not the clause.
    expect(ddlForServer('CREATE SEQUENCE "AS integer"."as" INCREMENT 1', v92)).toBe(
      'CREATE SEQUENCE "AS integer"."as" INCREMENT 1'
    )
    expect(ddlForServer('create sequence a.b as bigint', v92)).toBe('create sequence a.b')
  })

  it('writes EXECUTE PROCEDURE for a trigger before 11, only for the trigger’s own clause', () => {
    const trigger =
      "CREATE TRIGGER t BEFORE UPDATE ON app.p FOR EACH ROW WHEN ((old.total IS DISTINCT FROM new.total)) EXECUTE FUNCTION app.f('EXECUTE FUNCTION')"
    expect(ddlForServer(trigger, v10)).toBe(
      "CREATE TRIGGER t BEFORE UPDATE ON app.p FOR EACH ROW WHEN ((old.total IS DISTINCT FROM new.total)) EXECUTE PROCEDURE app.f('EXECUTE FUNCTION')"
    )
    expect(ddlForServer(trigger, v92)).toBe(ddlForServer(trigger, v10))
    expect(ddlForServer(trigger, pgCatalogFeatures(110000))).toBe(trigger)
    expect(
      ddlForServer(
        'CREATE CONSTRAINT TRIGGER c AFTER INSERT ON a.b DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION a.g()',
        v92
      )
    ).toBe(
      'CREATE CONSTRAINT TRIGGER c AFTER INSERT ON a.b DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE PROCEDURE a.g()'
    )
  })

  it('leaves every other statement as the backup wrote it', () => {
    for (const sql of [
      'CREATE TABLE "app"."t" (\n  "id" integer DEFAULT nextval(\'app.t_id_seq\'::regclass) NOT NULL\n)',
      'CREATE OR REPLACE FUNCTION app.f()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$ BEGIN EXECUTE FUNCTION; END $function$',
      'CREATE VIEW app.v AS\n SELECT 1 AS integer',
      'ALTER SEQUENCE "app"."t_id_seq" OWNED BY "app"."t"."id"',
      'CREATE INDEX i ON app.t USING btree (id)',
      "COMMENT ON SEQUENCE app.s IS 'AS integer'"
    ])
      expect(ddlForServer(sql, v92)).toBe(sql)
  })
})
